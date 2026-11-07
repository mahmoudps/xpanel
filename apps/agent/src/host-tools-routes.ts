import { createHash } from 'node:crypto'
import { open, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defaultFrp, defaultHostDaemons, defaultHostScheduler, fail, HOST_TOOLS_STATE, isHostToolId, isTimezoneName, msgid, validateFrp, validateHostDaemons, validateHostScheduler } from '@xpanel/core'
import type { Account, RenderedFile } from '@xpanel/core'
import { system } from '@xpanel/render'
import { readJsonIfExists } from '@xpanel/state'
import {
  FRP_ARCHIVE_PATH, FRP_DIGESTS, FRP_VERSION, frpArchive, frpExtractArgv, hostsLookupArgv, hostTaskStartArgv, hostUnitLogArgv, hostUnitShowArgv, hostUnitVerbArgv, isHostToolsCommand,
  ramDiskArgv, ramDiskPath, swapAllocateArgv, SWAP_ARGV, SWAP_FILE, SWAP_UNIT_PATH, TIMEZONE_READ_ARGV, timezoneSetArgv,
} from '../../../packages/os/src/host-tools-command.ts'
import { applyLogCleanup, LOG_CATEGORY_IDS, scanLogCleanup, type LogCleanupCategory } from './host-log-cleanup.ts'
import type { HostJobCommandStep, HostJobPlan, HostJobView } from './host-job-contract.ts'
import { HOST_WATCH_PATH, parseHostWatchState } from './host-watch.ts'
import { chpasswdUser } from './root-identity.ts'
import { readSaved } from './server-operations.ts'

const unchanged = { stateChanged: false }
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const LOG_READ_BYTES = 256 * 1024
const SWAP_STEP_MS = 120_000
const FRP_ARCHIVE_MAX = 64 * 1024 * 1024
const REGULAR_UID_MIN = 1000, NOBODY_UID = 65534

export interface HostToolsHost {
  writeFile(file: RenderedFile): Promise<void>
  runCommand(argv: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }>
}
export interface HostToolsRouteContext {
  assertRoot: (action: string) => Promise<{ actor: string }>
  /** Null unless this agent runs the native Linux executor; a route then refuses instead of simulating the host. */
  host: HostToolsHost | null
  rootDir: string
  accounts: () => Promise<readonly Pick<Account, 'username'>[]>
  submitJob: ((plan: HostJobPlan, actor: string) => Promise<HostJobView>) | null
  logDir?: string
  readProc?: (path: string) => Promise<string | null>
  fetcher?: typeof fetch
  arch?: string
  now?: () => Date
}

const readBody = async (req: Request): Promise<Record<string, unknown>> => {
  const raw = await req.text()
  if (raw.length > 16_384) return fail('VALIDATION', 'request body is too large', unchanged)
  try { const body: unknown = raw.trim() ? JSON.parse(raw) : {}; return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : fail('VALIDATION', 'request body must be an object', unchanged) }
  catch { return fail('VALIDATION', 'request body must be valid JSON', unchanged) }
}

const tail = async (path: string, bytes: number): Promise<string> => {
  let handle
  try { handle = await open(path, 'r') } catch { return '' }
  try {
    const { size } = await handle.stat(), length = Math.min(size, bytes), buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    return buffer.toString('utf8')
  } finally { await handle.close() }
}
const records = (text: string): unknown[] => text.split('\n').flatMap(line => { try { return line ? [JSON.parse(line)] : [] } catch { return [] } })

/** Last run of every task, script, trigger and hook, from the bounded record files. */
async function lastRuns(dir: string): Promise<Record<string, unknown>> {
  const names = await readdir(dir).catch(() => [] as string[]), out: Record<string, unknown> = {}
  for (const name of names) if (/^[a-z0-9]{12}\.runs$/.test(name)) out[name.slice(0, 12)] = records(await tail(join(dir, name), 4096)).at(-1) ?? null
  return out
}

const knownRunnable = async (rootDir: string, id: string): Promise<boolean> => {
  const state = await readSaved(rootDir, HOST_TOOLS_STATE.scheduler, validateHostScheduler) ?? defaultHostScheduler()
  return [...state.tasks, ...state.scripts, ...state.hooks].some(item => item.id === id)
}

const parseShow = (text: string): Record<string, string> => Object.fromEntries(text.split('\n').flatMap(line => { const at = line.indexOf('='); return at > 0 ? [[line.slice(0, at), line.slice(at + 1)]] : [] }))
const swapTotalMb = (text: string | null): number => Math.round((text ?? '').split('\n').slice(1).reduce((sum, line) => sum + (Number(line.trim().split(/\s+/)[2]) || 0), 0) / 1024)
const swapFileMb = (text: string | null): number => Math.round(Number((text ?? '').split('\n').slice(1).find(line => line.startsWith(`${SWAP_FILE} `))?.trim().split(/\s+/)[2] ?? 0) / 1024)

/** The whole resize as reviewed steps; a shrink of swap in use fails at swapoff and keeps the previous file. */
export function buildSwapPlan(sizeMb: number, active: boolean, read: () => Promise<string | null>): HostJobPlan {
  const step = (id: string, title: string, argv: readonly string[], titleValues?: Record<string, string>): HostJobCommandStep => ({ id, title, argv, timeoutMs: SWAP_STEP_MS, mutates: true, ...(titleValues ? { titleValues } : {}) })
  const steps = [
    ...active ? [step('swap-off', msgid('Turn off the swap file'), SWAP_ARGV.off)] : [], step('remove', msgid('Remove the previous swap file'), SWAP_ARGV.remove),
    ...sizeMb > 0
      ? [step('allocate', msgid('Create a swap file of {size} MB'), swapAllocateArgv(sizeMb), { size: String(sizeMb) }), step('protect', msgid('Protect the swap file'), SWAP_ARGV.chmod), step('format', msgid('Format the swap file'), SWAP_ARGV.format), step('swap-on', msgid('Turn on the swap file'), SWAP_ARGV.on), step('reload', msgid('Reload systemd'), SWAP_ARGV.reload), step('enable', msgid('Keep the swap file across reboots'), SWAP_ARGV.enable)]
      : [step('disable', msgid('Stop using the swap file at boot'), SWAP_ARGV.disable), step('remove-unit', msgid('Remove the swap unit'), SWAP_ARGV.removeUnit), step('reload', msgid('Reload systemd'), SWAP_ARGV.reload)],
  ]
  return { kind: 'system.swap.apply', summary: `Set the swap file to ${sizeMb} MB`, accountId: null, fingerprint: { sizeMb }, detail: { sizeMb }, steps, policy: isHostToolsCommand,
    verify: async () => { const observed = swapFileMb(await read()); return { ok: Math.abs(observed - sizeMb) <= 1, detail: { observedMb: observed } } } }
}

const ALLOW: Readonly<Record<string, string>> = { runs: 'GET', run: 'POST', log: 'GET', 'log-clear': 'POST', daemons: 'GET', watch: 'GET', 'log-cleanup': 'GET, POST', linux: 'GET', timezone: 'POST', swap: 'POST', 'ram-disk': 'POST', 'hosts-lookup': 'GET', password: 'POST', frp: 'GET', 'frp-unit': 'GET', 'frp-install': 'POST' }
const ROUTE = /^\/host\/host-tools\/(runs|run|log|log-clear|daemons|daemon|watch|log-cleanup|linux|timezone|swap|ram-disk|hosts-lookup|password|frp|frp-install|frp-unit)(?:\/([a-z0-9-]{1,40}))?(?:\/([a-z]{3,8}))?$/

/** Root-only host side of the scheduler and host tools. Saved files name everything a command touches. */
export async function handleHostToolsRoute(req: Request, url: URL, method: string, ctx: HostToolsRouteContext): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  const [, tool, target, verb] = match as unknown as [string, string, string | undefined, string | undefined]
  const { actor } = await ctx.assertRoot(`host.tools.${tool}`)
  const host = ctx.host
  if (!host) return fail('PRECONDITION_FAILED', 'this operation requires the native Linux host executor', { ...unchanged, reason: 'host_executor_unavailable' })
  const allow = tool === 'daemon' ? (verb === 'log' ? 'GET' : 'POST') : tool === 'frp-unit' && verb === 'restart' ? 'POST' : ALLOW[tool]!
  if (!allow.split(', ').includes(method)) return new Response(null, { status: 405, headers: { allow } })
  const logs = ctx.logDir ?? system.HOST_TASK_LOG_DIR, proc = ctx.readProc ?? ((path: string) => readFile(path, 'utf8').catch(() => null))
  const refuseId = (): never => fail('NOT_FOUND', 'no saved item has that id', { ...unchanged, reason: 'host_tool_unknown' })

  switch (tool) {
    case 'runs': return json({ runs: await lastRuns(logs) })
    case 'run': {
      if (!isHostToolId(target) || !await knownRunnable(ctx.rootDir, target)) return refuseId()
      const started = await host.runCommand(hostTaskStartArgv(system.hostTaskUnit(target)))
      return (started.ok ? json({ started: true }, 202) : fail('SERVICE_UNAVAILABLE', 'the task did not start', { ...unchanged, reason: 'task_not_started' }))
    }
    case 'log': return (isHostToolId(target) ? json({ log: await tail(join(logs, `${target}.log`), LOG_READ_BYTES), runs: records(await tail(join(logs, `${target}.runs`), LOG_READ_BYTES)).reverse() }) : refuseId())
    case 'log-clear': {
      if (!isHostToolId(target)) return refuseId()
      await Promise.all([`${target}.log`, `${target}.runs`].map(name => unlink(join(logs, name)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })))
      return json({ cleared: true })
    }
    case 'daemons': {
      const state = await readSaved(ctx.rootDir, HOST_TOOLS_STATE.daemons, validateHostDaemons) ?? defaultHostDaemons()
      const rows: Record<string, Record<string, string>> = {}
      for (const daemon of state.daemons) rows[daemon.id] = parseShow((await host.runCommand(hostUnitShowArgv(system.hostDaemonUnit(daemon.name))).catch(() => ({ stdout: '' }))).stdout)
      return json({ units: rows })
    }
    case 'daemon': {
      const state = await readSaved(ctx.rootDir, HOST_TOOLS_STATE.daemons, validateHostDaemons) ?? defaultHostDaemons(), daemon = state.daemons.find(item => item.id === target)
      if (!daemon) return refuseId()
      const unit = system.hostDaemonUnit(daemon.name)
      if (verb === 'log') return json({ log: (await host.runCommand(hostUnitLogArgv(unit))).stdout.slice(-LOG_READ_BYTES), runs: [] })
      if (verb !== 'start' && verb !== 'stop' && verb !== 'restart') return refuseId()
      const done = await host.runCommand(hostUnitVerbArgv(verb, unit))
      return done.ok ? json({ done: true, unit: parseShow((await host.runCommand(hostUnitShowArgv(unit))).stdout) }) : fail('SERVICE_UNAVAILABLE', 'systemd refused the daemon action', { ...unchanged, reason: 'daemon_action_failed' })
    }
    case 'watch': return json({ events: parseHostWatchState(await readJsonIfExists<unknown>(HOST_WATCH_PATH)).events.slice(-100).reverse() })
    case 'log-cleanup': {
      const run = (argv: string[]) => host.runCommand(argv)
      if (method === 'GET') return json({ observedAt: (ctx.now?.() ?? new Date()).toISOString(), rows: await scanLogCleanup(run) })
      const { categories } = await readBody(req)
      if (!Array.isArray(categories) || categories.some(id => !LOG_CATEGORY_IDS.includes(id as LogCleanupCategory))) return fail('VALIDATION', 'choose at least one log category', { ...unchanged, reason: 'log_category_invalid' })
      return json(await applyLogCleanup(run, categories as LogCleanupCategory[]))
    }
    case 'linux': {
      const [zone, swaps, mounts] = await Promise.all([host.runCommand([...TIMEZONE_READ_ARGV]).catch(() => null), proc('/proc/swaps'), proc('/proc/mounts')])
      return json({ timezone: zone?.ok ? zone.stdout.trim() : null, swapTotalMb: swapTotalMb(swaps), swapFileMb: swapFileMb(swaps), ramDisks: (mounts ?? '').split('\n').flatMap(line => { const path = line.split(' ')[1] ?? ''; return path.startsWith('/mnt/ram-') ? [path.slice('/mnt/ram-'.length)] : [] }) })
    }
    case 'timezone': {
      const { zone } = await readBody(req)
      if (!isTimezoneName(zone)) return fail('VALIDATION', 'a time zone name is required', { ...unchanged, reason: 'timezone_invalid' })
      if (!(await host.runCommand(timezoneSetArgv(zone))).ok) return fail('VALIDATION', 'this server does not know that time zone', { ...unchanged, reason: 'timezone_invalid' })
      const observed = await host.runCommand([...TIMEZONE_READ_ARGV])
      return json({ applied: observed.stdout.trim() === zone })
    }
    case 'swap': {
      const { sizeMb } = await readBody(req)
      if (typeof sizeMb !== 'number' || !Number.isSafeInteger(sizeMb) || sizeMb < 0 || sizeMb > 65536) return fail('VALIDATION', 'the swap size is out of range', { ...unchanged, reason: 'swap_size_invalid' })
      if (!ctx.submitJob) return fail('PRECONDITION_FAILED', 'the host job runner is unavailable', { ...unchanged, reason: 'host_job_runner_unavailable' })
      if (sizeMb > 0) await host.writeFile({ path: SWAP_UNIT_PATH, content: `# Generated by xPanel (swap file). Manual edits are overwritten.\n[Swap]\nWhat=${SWAP_FILE}\n\n[Install]\nWantedBy=swap.target\n`, mode: 0o644, owner: 'root', group: 'root' })
      const active = swapFileMb(await proc('/proc/swaps')) > 0
      if (sizeMb === 0 && !active) return json({ job: null })
      const job = await ctx.submitJob(buildSwapPlan(sizeMb, active, () => proc('/proc/swaps')), actor)
      return json({ job: { id: job.id, status: job.status } }, 202)
    }
    case 'ram-disk': {
      const { name, sizeMb, mounted } = await readBody(req)
      if (typeof name !== 'string' || !/^[a-z][a-z0-9]{0,30}$/.test(name) || typeof mounted !== 'boolean' || mounted && (typeof sizeMb !== 'number' || !Number.isSafeInteger(sizeMb) || sizeMb < 1 || sizeMb > 65536)) return fail('VALIDATION', 'a RAM disk name and size are required', { ...unchanged, reason: 'ram_disk_invalid' })
      const path = ramDiskPath(name)
      for (const argv of mounted ? [ramDiskArgv.dir(path), ramDiskArgv.mount(path, sizeMb as number)] : [ramDiskArgv.unmount(path)]) {
        const done = await host.runCommand(argv)
        if (!done.ok) return fail('SERVICE_UNAVAILABLE', 'the RAM disk change did not complete', { ...unchanged, reason: 'ram_disk_failed' })
      }
      return json({ path, applied: ((await proc('/proc/mounts')) ?? '').includes(` ${path} tmpfs `) === mounted })
    }
    case 'hosts-lookup': {
      const name = url.searchParams.get('name') ?? ''
      if (!/^[a-z0-9.-]{1,253}$/.test(name)) return fail('VALIDATION', 'a host name is required', unchanged)
      return json({ name, resolved: (await host.runCommand(hostsLookupArgv(name)).catch(() => null))?.ok === true })
    }
    case 'password': {
      const { user, password } = await readBody(req)
      if (typeof user !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(user) || typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password, 'utf8') > 1024 || /[\u0000-\u001f\u007f]/.test(password)) return fail('VALIDATION', 'a system user and a one-line password are required', { ...unchanged, reason: 'system_user_invalid' })
      const entry = (await host.runCommand(['/usr/bin/getent', 'passwd', user]).catch(() => null))?.stdout.trim().split(':')
      const uid = Number(entry?.[2])
      if (!entry || entry[0] !== user || !Number.isSafeInteger(uid) || uid < REGULAR_UID_MIN || uid === NOBODY_UID || (await ctx.accounts()).some(account => account.username === user)) return fail('PRECONDITION_FAILED', 'only a regular system user outside the hosting accounts can be changed here', { ...unchanged, reason: 'system_user_refused' })
      const done = await chpasswdUser(user, password)
      return done.ok ? json({ outcome: 'applied' }) : fail('SERVICE_UNAVAILABLE', 'the password change did not complete', { stateChanged: false, verificationRequired: true, reason: 'password_not_changed' })
    }
    case 'frp': {
      const present = async (name: string): Promise<boolean> => (await open(`/usr/local/bin/${name}`, 'r').then(handle => handle.close().then(() => true), () => false))
      const show = async (unit: string) => parseShow((await host.runCommand(hostUnitShowArgv(unit)).catch(() => ({ stdout: '' }))).stdout)
      return json({ version: FRP_VERSION, installed: await present('frps') && await present('frpc'), server: await show(system.FRP_UNITS.server), client: await show(system.FRP_UNITS.client) })
    }
    case 'frp-unit': {
      const unit = target === 'server' ? system.FRP_UNITS.server : target === 'client' ? system.FRP_UNITS.client : null
      if (!unit) return refuseId()
      if (verb === 'restart') return (await host.runCommand(hostUnitVerbArgv('restart', unit))).ok ? json({ done: true }) : fail('SERVICE_UNAVAILABLE', 'systemd refused the restart', { ...unchanged, reason: 'daemon_action_failed' })
      return json({ log: (await host.runCommand(hostUnitLogArgv(unit))).stdout.slice(-LOG_READ_BYTES), runs: [] })
    }
    default: {
      const arch = ctx.arch ?? process.arch, digest = FRP_DIGESTS[arch]
      if (!digest || (arch !== 'x64' && arch !== 'arm64')) return fail('PRECONDITION_FAILED', 'no reviewed frp build exists for this processor', { ...unchanged, reason: 'frp_arch_unsupported' })
      const archive = frpArchive(arch)
      let bytes: Buffer
      try {
        const response = await (ctx.fetcher ?? fetch)(archive.url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) })
        if (!response.ok) return fail('SERVICE_UNAVAILABLE', 'the frp release could not be downloaded', { ...unchanged, reason: 'frp_download_failed' })
        bytes = Buffer.from(await response.arrayBuffer())
      } catch (error) { if ((error as { code?: string }).code === 'SERVICE_UNAVAILABLE') throw error; return fail('SERVICE_UNAVAILABLE', 'the frp release could not be downloaded', { ...unchanged, reason: 'frp_download_failed' }) }
      if (bytes.length > FRP_ARCHIVE_MAX || createHash('sha256').update(bytes).digest('hex') !== digest) return fail('PRECONDITION_FAILED', 'the frp release does not match its reviewed digest', { ...unchanged, reason: 'frp_digest_mismatch' })
      await writeFile(FRP_ARCHIVE_PATH, bytes, { mode: 0o600 })
      const done = await host.runCommand(frpExtractArgv(archive.name))
      await unlink(FRP_ARCHIVE_PATH).catch(() => undefined)
      return done.ok ? json({ installed: true, version: FRP_VERSION }) : fail('SERVICE_UNAVAILABLE', 'the frp release could not be unpacked', { ...unchanged, reason: 'frp_unpack_failed' })
    }
  }
}

export const readFrpState = async (rootDir: string) => await readSaved(rootDir, HOST_TOOLS_STATE.frp, validateFrp) ?? defaultFrp()
