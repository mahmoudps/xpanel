import { fail } from '@xpanel/core'
import type { Account, Certificate, Plan } from '@xpanel/core'
import type { CanonicalIoAnalyticsRead } from './analytics.ts'
import type { BandwidthReport } from './metering.ts'
import { parseCpuinfo, parseLoadavg, parseMeminfo } from './host-info.ts'
import { readDisk } from './host-monitoring.ts'
import type { FilesystemView } from './host-monitoring.ts'
import { readHostServices } from './host-services.ts'
import { REBOOT_REQUIRED_PATH } from './package-manager.ts'
import type { RepairDriftObservation } from './repair-center.ts'
import { MAX_LIMITS_BATCH, readServerLimits } from './server-health-limits.ts'
import type { ServerLimitsExecutor } from './server-health-limits.ts'

type Levels = Readonly<{ warning: number; problem: number }>
export interface ServerHealthThresholds { loadPerCore: Levels; memoryAvailablePercent: Levels; swapUsedPercent: Levels; diskUsedPercent: Levels; inodeUsedPercent: Levels; certificateExpiryDays: number; bandwidthUsedPercent: Levels }
/** Fixed, documented thresholds. Each check is graded on its own; there is no combined score. */
export const SERVER_HEALTH_THRESHOLDS: Readonly<ServerHealthThresholds> = Object.freeze({
  /** 5-minute load average divided by the online processors in /proc/cpuinfo. */
  loadPerCore: Object.freeze({ warning: 1, problem: 2 }),
  /** MemAvailable as a percentage of MemTotal; below the value is worse. */
  memoryAvailablePercent: Object.freeze({ warning: 15, problem: 5 }),
  /** (SwapTotal - SwapFree) as a percentage of SwapTotal. */
  swapUsedPercent: Object.freeze({ warning: 50, problem: 80 }),
  /** used / (used + available), the way df(1) computes Use%. */
  diskUsedPercent: Object.freeze({ warning: 85, problem: 95 }),
  inodeUsedPercent: Object.freeze({ warning: 85, problem: 95 }),
  /** A saved certificate whose notAfter is closer than this is expiring. */
  certificateExpiryDays: 14,
  /** This UTC month's measured traffic as a percentage of the plan's monthly bandwidth. */
  bandwidthUsedPercent: Object.freeze({ warning: 80, problem: 100 }),
})
const MAX_ITEMS = 25
/** Pseudo and read-only image filesystems are full by design or hold no persistent data; they are counted in evidence, not graded. */
const UNGRADED_FILESYSTEMS: ReadonlySet<string> = new Set(['tmpfs', 'devtmpfs', 'ramfs', 'squashfs', 'overlay', 'efivarfs', 'iso9660'])

export type ServerHealthState = 'ok' | 'warning' | 'problem' | 'unavailable'
export type ServerHealthCheckId = 'load' | 'memory' | 'swap' | 'disk-space' | 'disk-inodes' | 'services' | 'drift' | 'certificates' | 'reboot' | 'bandwidth'
export interface ServerHealthItem { name: string; state: ServerHealthState; reason: string; evidence: string }
export interface ServerHealthCheck { id: ServerHealthCheckId; state: ServerHealthState; reason: string; evidence: string; items?: ServerHealthItem[]; omitted?: number }
export interface ServerHealthReport {
  observedAt: string; host: 'read' | 'unavailable'; thresholds: Readonly<ServerHealthThresholds>
  counts: Record<ServerHealthState, number>; checks: ServerHealthCheck[]
}
/** Only these saved fields are read; StateSnapshot satisfies it. */
export interface ServerHealthSaved {
  certificates: readonly Pick<Certificate, 'names' | 'notAfter' | 'autoRenew' | 'source'>[]
  accounts: readonly Account[]
  plans: readonly Plan[]
}
export interface ServerHealthRouteContext {
  /** Re-authenticates the current caller and requires root on every call. */
  assertRoot: (action: string) => Promise<{ actor: string }>
  /** The native Linux executor; null keeps every host observation unavailable. */
  executor: ServerLimitsExecutor | null
  family: 'debian' | 'rhel' | null
  /** The reconciler drift reader; null when the host is not observed natively. */
  readDrift: (() => Promise<RepairDriftObservation>) | null
  readSaved: () => Promise<ServerHealthSaved>
  /** The daemon-owned cached resource sample (CPU and IO rates). */
  readResources: (() => Promise<CanonicalIoAnalyticsRead>) | null
  /** The bandwidth meter's monthly report; null when no meter runs on this host. */
  readBandwidth?: (() => Promise<BandwidthReport>) | null
  now?: () => Date
}

const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g
const clean = (text: string, max: number): string => { const value = text.replace(UNSAFE, '?').toWellFormed(); return value.length > max ? value.slice(0, max - 3).toWellFormed() + '...' : value }
const check = (id: ServerHealthCheckId, state: ServerHealthState, reason: string, evidence: string): ServerHealthCheck => ({ id, state, reason, evidence: clean(evidence, 1024) })
const item = (name: string, state: ServerHealthState, reason: string, evidence: string): ServerHealthItem => ({ name: clean(name, 512), state, reason, evidence: clean(evidence, 256) })
const RANK: Readonly<Record<ServerHealthState, number>> = { problem: 0, warning: 1, unavailable: 2, ok: 3 }
const round = (value: number): number => Math.round(value * 100) / 100
const above = (value: number, limits: { warning: number; problem: number }): 'ok' | 'warning' | 'problem' => value >= limits.problem ? 'problem' : value >= limits.warning ? 'warning' : 'ok'
const below = (value: number, limits: { warning: number; problem: number }): 'ok' | 'warning' | 'problem' => value < limits.problem ? 'problem' : value < limits.warning ? 'warning' : 'ok'

/** The worst item decides; reasons are <prefix>_<state>. */
function aggregate(id: ServerHealthCheckId, prefix: string, items: ServerHealthItem[], evidence: string): ServerHealthCheck {
  const sorted = [...items].sort((left, right) => RANK[left.state] - RANK[right.state] || left.name.localeCompare(right.name))
  const state = sorted[0]?.state ?? 'ok'
  return { ...check(id, state, prefix + '_' + (state === 'unavailable' ? 'unread' : state), evidence), items: sorted.slice(0, MAX_ITEMS), omitted: Math.max(0, sorted.length - MAX_ITEMS) }
}
const readText = async (executor: ServerLimitsExecutor, path: string): Promise<string | null> => { try { return await executor.readFile(path) } catch { return null } }

async function loadCheck(executor: ServerLimitsExecutor): Promise<ServerHealthCheck> {
  const [loadText, cpuText] = await Promise.all([readText(executor, '/proc/loadavg'), readText(executor, '/proc/cpuinfo')])
  let load: ReturnType<typeof parseLoadavg> | null = null
  try { load = loadText ? parseLoadavg(loadText) : null } catch { load = null }
  const cpu = cpuText ? parseCpuinfo(cpuText) : null
  if (!load || !cpu) return check('load', 'unavailable', 'load_unread', !load ? '/proc/loadavg could not be read' : '/proc/cpuinfo listed no processors')
  const perCore = round(load.load5 / cpu.cores), state = above(perCore, SERVER_HEALTH_THRESHOLDS.loadPerCore)
  return check('load', state, state === 'ok' ? 'load_ok' : state === 'warning' ? 'load_high' : 'load_overloaded', `load average 1m=${load.load1} 5m=${load.load5} 15m=${load.load15}; processors=${cpu.cores}; 5m per processor=${perCore}`)
}

// proc(5): /proc/meminfo reports SwapTotal and SwapFree in kB.
const meminfoBytes = (text: string, key: string): number | null => { const match = new RegExp(`^${key}:\\s+(\\d{1,15})\\s+kB$`, 'm').exec(text); return match ? Number(match[1]) * 1024 : null }
async function memoryChecks(executor: ServerLimitsExecutor): Promise<ServerHealthCheck[]> {
  const text = await readText(executor, '/proc/meminfo')
  let memory: ReturnType<typeof parseMeminfo> | null = null
  try { memory = text ? parseMeminfo(text) : null } catch { memory = null }
  const checks: ServerHealthCheck[] = []
  if (!memory || memory.totalBytes <= 0 || memory.availableBytes > memory.totalBytes) checks.push(check('memory', 'unavailable', 'memory_unread', '/proc/meminfo MemTotal or MemAvailable could not be read'))
  else {
    const percent = round(memory.availableBytes / memory.totalBytes * 100), state = below(percent, SERVER_HEALTH_THRESHOLDS.memoryAvailablePercent)
    checks.push(check('memory', state, state === 'ok' ? 'memory_ok' : state === 'warning' ? 'memory_low' : 'memory_exhausted', `MemAvailable=${memory.availableBytes} B of MemTotal=${memory.totalBytes} B (${percent}% available)`))
  }
  const total = text ? meminfoBytes(text, 'SwapTotal') : null, free = text ? meminfoBytes(text, 'SwapFree') : null
  if (total === null || free === null || free > total) checks.push(check('swap', 'unavailable', 'swap_unread', '/proc/meminfo SwapTotal or SwapFree could not be read'))
  else if (total === 0) checks.push(check('swap', 'ok', 'swap_none', 'SwapTotal=0 B; no swap is configured'))
  else {
    const percent = round((total - free) / total * 100), state = above(percent, SERVER_HEALTH_THRESHOLDS.swapUsedPercent)
    checks.push(check('swap', state, state === 'ok' ? 'swap_ok' : state === 'warning' ? 'swap_high' : 'swap_exhausted', `swap used=${total - free} B of SwapTotal=${total} B (${percent}% used)`))
  }
  return checks
}

async function diskChecks(executor: ServerLimitsExecutor): Promise<ServerHealthCheck[]> {
  // Accounts are not passed, so readDisk runs no quota report here.
  const { filesystems } = await readDisk(argv => executor.runCommand(argv), undefined, [])
  if (filesystems.state !== 'read') return [check('disk-space', 'unavailable', 'filesystems_unread', 'df -B1 -P -T: ' + (filesystems.reason ?? 'unavailable')), check('disk-inodes', 'unavailable', 'filesystems_unread', 'df -B1 -P -T: ' + (filesystems.reason ?? 'unavailable'))]
  const graded = filesystems.items.filter(fs => !UNGRADED_FILESYSTEMS.has(fs.type) && fs.usedBytes + fs.availableBytes > 0)
  const skipped = filesystems.items.length - graded.length
  const space = graded.map(fs => {
    const percent = round(fs.usedBytes / (fs.usedBytes + fs.availableBytes) * 100), state = above(percent, SERVER_HEALTH_THRESHOLDS.diskUsedPercent)
    return item(fs.mount, state, state === 'ok' ? 'space_ok' : state === 'warning' ? 'space_high' : 'space_full', `${fs.filesystem} ${fs.type}: used=${fs.usedBytes} B available=${fs.availableBytes} B (${percent}% used)`)
  })
  const checks = [space.length ? aggregate('disk-space', 'filesystems', space, `${graded.length} filesystems graded; ${skipped} pseudo or image filesystems not graded`)
    : check('disk-space', 'unavailable', 'filesystems_unread', 'df listed no gradable filesystem')]
  if (filesystems.inodes !== 'read') checks.push(check('disk-inodes', 'unavailable', 'filesystems_unread', 'df -i -P: inode counts could not be read'))
  else {
    const tables = graded.filter((fs): fs is FilesystemView & { inodes: NonNullable<FilesystemView['inodes']> } => fs.inodes !== null)
    const inodes = tables.map(fs => {
      const percent = round(fs.inodes.used / fs.inodes.total * 100), state = above(percent, SERVER_HEALTH_THRESHOLDS.inodeUsedPercent)
      return item(fs.mount, state, state === 'ok' ? 'inodes_ok' : state === 'warning' ? 'inodes_high' : 'inodes_full', `${fs.filesystem}: inodes used=${fs.inodes.used} of ${fs.inodes.total} (${percent}% used)`)
    })
    checks.push(inodes.length ? aggregate('disk-inodes', 'filesystems', inodes, `${tables.length} inode tables graded; ${graded.length - tables.length} filesystems allocate inodes dynamically`)
      : check('disk-inodes', 'ok', 'no_inode_tables', 'no graded filesystem reports a fixed inode table'))
  }
  return checks
}

async function servicesCheck(executor: ServerLimitsExecutor): Promise<ServerHealthCheck> {
  let rows: Awaited<ReturnType<typeof readHostServices>>
  try { rows = await readHostServices(argv => executor.runCommand(argv)) } catch { return check('services', 'unavailable', 'services_unread', 'systemctl show could not run') }
  const failed = rows.filter(row => row.state === 'failed'), unchecked = rows.filter(row => row.state === 'unchecked')
  const evidence = `${rows.length} services: ${rows.filter(row => row.state === 'active').length} active, ${failed.length} failed, ${rows.filter(row => row.state === 'inactive').length} inactive, ${rows.filter(row => row.state === 'not-installed').length} not installed, ${unchecked.length} not checked`
  if (unchecked.length === rows.length) return check('services', 'unavailable', 'services_unread', evidence)
  const items = [...failed.map(row => item(row.label, 'problem', 'service_failed', 'unit=' + (row.unit ?? '-') + ' ActiveState=failed')), ...unchecked.map(row => item(row.label, 'unavailable', 'service_unchecked', 'systemctl show did not answer'))]
  return items.length ? { ...aggregate('services', 'services', items, evidence), reason: failed.length ? 'services_failed' : 'services_partial' } : { ...check('services', 'ok', 'services_ok', evidence), items: [], omitted: 0 }
}

async function driftCheck(readDrift: () => Promise<RepairDriftObservation>): Promise<ServerHealthCheck> {
  let report: RepairDriftObservation | null = null
  try { report = await readDrift() } catch { report = null }
  if (!report || typeof report.hasDrift !== 'boolean' || !Array.isArray(report.items)) return check('drift', 'unavailable', 'drift_unread', 'configuration drift could not be read')
  if (report.manifestMissing) return check('drift', 'problem', 'manifest_missing', `generation ${report.generationId}: the file manifest is missing`)
  if (report.generationId === null) return check('drift', 'unavailable', 'no_generation', 'no configuration generation is active')
  const evidence = `generation ${report.generationId}: ${report.items.length} managed files differ`
  if (!report.items.length) return { ...check('drift', 'ok', 'drift_none', evidence), items: [], omitted: 0 }
  const reasons: Readonly<Record<string, string>> = { missing: 'file_missing', content_mismatch: 'file_changed', metadata_mismatch: 'file_metadata' }
  return { ...aggregate('drift', 'drift', report.items.map(entry => item(entry.path, 'problem', reasons[entry.reason] ?? 'file_changed', String(entry.reason))), evidence), reason: 'drift_found' }
}

function certificatesCheck(saved: ServerHealthSaved, now: number): ServerHealthCheck {
  const window = SERVER_HEALTH_THRESHOLDS.certificateExpiryDays * 86_400_000
  const items = saved.certificates.flatMap(certificate => {
    const notAfter = Date.parse(certificate.notAfter), name = certificate.names[0] ?? '-'
    const evidence = `notAfter=${certificate.notAfter} source=${certificate.source} autoRenew=${certificate.autoRenew} names=${certificate.names.join(',')}`
    return !Number.isFinite(notAfter) ? [item(name, 'unavailable', 'cert_unread', evidence)] : notAfter <= now ? [item(name, 'problem', 'cert_expired', evidence)]
      : notAfter - now < window ? [item(name, 'warning', 'cert_expiring', evidence)] : []
  })
  const evidence = `${saved.certificates.length} saved certificates; ${items.filter(entry => entry.state === 'warning').length} expire within ${SERVER_HEALTH_THRESHOLDS.certificateExpiryDays} days; ${items.filter(entry => entry.state === 'problem').length} expired`
  if (!saved.certificates.length) return { ...check('certificates', 'ok', 'certificates_none', evidence), items: [], omitted: 0 }
  return items.length ? aggregate('certificates', 'certificates', items, evidence) : { ...check('certificates', 'ok', 'certificates_ok', evidence), items: [], omitted: 0 }
}

async function rebootCheck(executor: ServerLimitsExecutor, family: ServerHealthRouteContext['family']): Promise<ServerHealthCheck> {
  // Debian and Ubuntu create /run/reboot-required when an installed update needs a restart; RHEL has no such file.
  if (family !== 'debian') return check('reboot', 'unavailable', 'reboot_unsupported', 'this host family does not record a reboot flag file')
  let text: string | null
  try { text = await executor.readFile(REBOOT_REQUIRED_PATH) } catch { return check('reboot', 'unavailable', 'reboot_unread', REBOOT_REQUIRED_PATH + ' could not be read') }
  return text === null ? check('reboot', 'ok', 'reboot_not_required', REBOOT_REQUIRED_PATH + ' is absent') : check('reboot', 'warning', 'reboot_required', REBOOT_REQUIRED_PATH + ' is present')
}

/** Accounts graded against their plan's monthly bandwidth. An unmeasured account with a limit is listed unavailable, never ok. Nothing is enforced. */
export async function bandwidthCheck(read: (() => Promise<BandwidthReport>) | null | undefined): Promise<ServerHealthCheck> {
  let report: BandwidthReport | null = null
  try { report = read ? await read() : null } catch { report = null }
  if (!report || report.state === 'unavailable') return check('bandwidth', 'unavailable', 'bandwidth_unread', 'bandwidth has not been measured on this host')
  const items: ServerHealthItem[] = []
  for (const row of report.accounts) {
    if (row.limitBytes === null) continue
    if (row.usedPercent === null) { items.push(item(row.username, 'unavailable', 'bandwidth_unread', `limit ${row.limitBytes} bytes; traffic not measured`)); continue }
    const state = above(row.usedPercent, SERVER_HEALTH_THRESHOLDS.bandwidthUsedPercent)
    if (state !== 'ok') items.push(item(row.username, state, 'bandwidth_' + state, `${row.totalBytes} of ${row.limitBytes} bytes in ${report.month}; ${row.limited ? 'limit page served' : row.enforced ? 'enforced' : 'not enforced'} (${row.usedPercent}% used)`))
  }
  const limited = report.accounts.filter(row => row.limitBytes !== null).length
  const evidence = `${limited} accounts with a monthly limit in ${report.month}; ${report.accounts.length - limited} unlimited; counted ${report.state}; ${report.accounts.filter(row => row.limited).length} serving the limit page`
  return items.length ? aggregate('bandwidth', 'bandwidth', items, evidence) : { ...check('bandwidth', 'ok', 'bandwidth_ok', evidence), items: [], omitted: 0 }
}

/** One read-only summary of fixed checks. Every host read is independent; a failed read is unavailable, never ok. */
export async function evaluateServerHealth(input: { executor: ServerLimitsExecutor | null; family: ServerHealthRouteContext['family']; readDrift: ServerHealthRouteContext['readDrift']; saved: ServerHealthSaved; readBandwidth?: ServerHealthRouteContext['readBandwidth']; now?: () => Date }): Promise<ServerHealthReport> {
  const observed = (input.now ?? (() => new Date()))()
  const { executor } = input
  const none = (id: ServerHealthCheckId): ServerHealthCheck => check(id, 'unavailable', 'host_unavailable', 'native host observation is unavailable')
  type Checks = [ServerHealthCheck, ServerHealthCheck[], ServerHealthCheck[], ServerHealthCheck, ServerHealthCheck, ServerHealthCheck]
  const [load, memory, disk, services, drift, reboot]: Checks = executor ? await Promise.all([loadCheck(executor), memoryChecks(executor), diskChecks(executor), servicesCheck(executor),
    input.readDrift ? driftCheck(input.readDrift) : Promise.resolve(none('drift')), rebootCheck(executor, input.family)])
    : [none('load'), [none('memory'), none('swap')], [none('disk-space'), none('disk-inodes')], none('services'), none('drift'), none('reboot')]
  const checks = [load, ...memory, ...disk, services, drift, certificatesCheck(input.saved, observed.getTime()), reboot, await bandwidthCheck(input.readBandwidth)]
  const counts: Record<ServerHealthState, number> = { ok: 0, warning: 0, problem: 0, unavailable: 0 }
  for (const entry of checks) counts[entry.state]++
  return { observedAt: observed.toISOString(), host: executor ? 'read' : 'unavailable', thresholds: SERVER_HEALTH_THRESHOLDS, counts, checks }
}

const ROUTES: Readonly<Record<string, string>> = { '/host/server-health': 'server.health.read', '/host/server-limits': 'server.limits.read' }
const USERNAME = /^[a-z][a-z0-9]{0,15}$/
const unchanged = { stateChanged: false }
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

export function readLimitUsernames(url: URL): string[] {
  if (url.search.length > 2048 || [...url.searchParams.keys()].some(key => key !== 'username')) return fail('VALIDATION', 'resource limits accept only username selectors', unchanged)
  const usernames = url.searchParams.getAll('username')
  if (!usernames.length || usernames.length > MAX_LIMITS_BATCH || new Set(usernames).size !== usernames.length || usernames.some(name => !USERNAME.test(name)))
    return fail('VALIDATION', `between 1 and ${MAX_LIMITS_BATCH} distinct account usernames are required`, unchanged)
  return usernames
}

/** GET /host/server-health and GET /host/server-limits?username=... (1..50). Root only, read-only. Returns null for other paths. */
export async function handleServerHealthRoute(req: Request, url: URL, method: string, ctx: ServerHealthRouteContext): Promise<Response | null> {
  const action = ROUTES[url.pathname]
  if (!action) return null
  await ctx.assertRoot(action)
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  if (req.body !== null) return fail('VALIDATION', 'server health reads do not accept a body', unchanged)
  let body: unknown
  if (url.pathname === '/host/server-health') {
    if (url.search) return fail('VALIDATION', 'server health does not accept selectors', unchanged)
    body = await evaluateServerHealth({ executor: ctx.executor, family: ctx.family, readDrift: ctx.readDrift, saved: await ctx.readSaved(), readBandwidth: ctx.readBandwidth ?? null, ...(ctx.now ? { now: ctx.now } : {}) })
  } else {
    const usernames = readLimitUsernames(url), saved = await ctx.readSaved()
    const accounts = usernames.map(name => saved.accounts.find(account => account.username === name) ?? fail('NOT_FOUND', 'account not found', unchanged))
    body = await readServerLimits({ accounts, plans: saved.plans, executor: ctx.executor, readResources: ctx.readResources, ...(ctx.now ? { now: ctx.now } : {}) })
  }
  // A caller whose root authority ended during the read never receives host facts.
  await ctx.assertRoot(action)
  return json(body)
}
