import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  defaultServerRoles, effectiveServerRoles, fail, msgid, SERVER_OPERATIONS_STATE, SERVER_ROLES, validateDomainForwards, validatePanelTlsPolicy, validateServerResolvers, validateServerRoles, validateSystemMailForwards,
} from '@xpanel/core'
import type { Certificate, DomainForward, HostAction, OsProfile, PanelTlsPolicy, RenderedFile, ServerRole, ServerRoleChange, ServerRoleState, SystemMailForwards } from '@xpanel/core'
import { edge, system } from '@xpanel/render'
import { isServerRoleCommand, SERVER_ROLE_UNITS, serverRoleLoadArgv, serverRoleStateArgv, serverRoleSwitchArgv } from '../../../packages/os/src/server-role-command.ts'
import type { HostJobCommandStep, HostJobPlan, HostJobView } from './host-job-contract.ts'
import type { HostToolsInput } from './host-tools.ts'
import { DEFAULT_DNS_ZONE_DIR, DEFAULT_NAMED_ZONES_CONF } from './services/dns.ts'
import { localAuthoritativeResolver, type DnsToolsResolver } from './dns-tools.ts'

const unchanged = { stateChanged: false }
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

export async function readSaved<T>(rootDir: string, relative: string, validate: (raw: unknown) => T): Promise<T | null> {
  let text: string
  try { text = await readFile(join(rootDir, relative), 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return fail('PRECONDITION_FAILED', 'a saved server setting could not be read', { ...unchanged, reason: 'server_setting_unreadable', file: relative })
  }
  try { return validate(JSON.parse(text)) } catch { return fail('PRECONDITION_FAILED', 'a saved server setting is invalid', { ...unchanged, reason: 'server_setting_invalid', file: relative }) }
}

export const readServerRoles = async (rootDir: string): Promise<ServerRoleState> => await readSaved(rootDir, SERVER_OPERATIONS_STATE.roles, validateServerRoles) ?? defaultServerRoles()

export interface ServerOperationsInput {
  hostTools?: HostToolsInput
  roles: ServerRoleState
  forwards: readonly DomainForward[]
  /** null keeps the host's own aliases and the default management TLS policy untouched. */
  systemMail: SystemMailForwards | null
  panelTls: PanelTlsPolicy | null
  /** Live /etc/aliases, read after preflight; unrelated lines are kept. */
  etcAliases?: string | null
}

export async function readServerOperations(rootDir: string): Promise<ServerOperationsInput> {
  return {
    roles: await readServerRoles(rootDir),
    forwards: await readSaved(rootDir, SERVER_OPERATIONS_STATE.domainForwards, validateDomainForwards) ?? [],
    systemMail: await readSaved(rootDir, SERVER_OPERATIONS_STATE.systemMail, validateSystemMailForwards),
    panelTls: await readSaved(rootDir, SERVER_OPERATIONS_STATE.panelTls, validatePanelTlsPolicy),
  }
}

const unitId = (unit: string): string => unit.endsWith('.service') ? unit : `${unit}.service`
export const disabledRoleUnits = (roles: ServerRoleState): Set<string> => {
  const active = effectiveServerRoles(roles)
  return new Set(SERVER_ROLES.flatMap(role => active.has(role) ? [] : SERVER_ROLE_UNITS[role]))
}

/** One compiler step: a disabled role's daemons are neither started nor reloaded, and each saved operation adds its file. */
export function applyServerOperations(files: RenderedFile[], postActions: HostAction[], input: ServerOperationsInput, os: OsProfile, selinux = false, certificates: readonly Pick<Certificate, 'id' | 'accountId' | 'names'>[] = []): void {
  const off = disabledRoleUnits(input.roles), dns = effectiveServerRoles(input.roles).has('dns')
  const kept = postActions.filter(action => !(action.kind === 'systemd' && off.has(unitId(action.unit))) && !(!dns && action.kind === 'exec' && action.argv[0] === '/usr/bin/pdns_control'))
  postActions.splice(0, postActions.length, ...kept)
  if (input.forwards.length > 0) files.push(edge.domainForwardsFile(input.forwards, os, certificates))
  if (input.panelTls) files.push(edge.panelTlsPolicyFile(input.panelTls))
  if (input.systemMail) {
    const aliases = system.renderSystemAliases(input.systemMail, input.etcAliases ?? null)
    files.push(aliases.file)
    // EL labels /etc/aliases etc_aliases_t; an atomic rename into /etc leaves etc_t.
    if (selinux) postActions.push({ kind: 'exec', argv: ['/usr/sbin/restorecon', aliases.file.path] })
    postActions.push(aliases.action)
  }
}

export const SERVER_ROLE_JOB_KIND = 'server.roles.apply'
const STEP_TIMEOUT_MS = 120_000
export type RoleCommandRun = (argv: string[]) => Promise<{ ok: boolean; stdout: string }>

/** The installed units behind the role changes, in change order; a role with no installed unit is left out, not faked. */
export async function roleUnitChanges(run: RoleCommandRun, changes: readonly ServerRoleChange[]): Promise<{ role: ServerRole; change: ServerRoleChange['change']; unit: string }[]> {
  const found: { role: ServerRole; change: ServerRoleChange['change']; unit: string }[] = []
  for (const { role, change } of changes) {
    for (const unit of SERVER_ROLE_UNITS[role]) {
      const shown = await run(serverRoleLoadArgv(unit))
      if (shown.ok && shown.stdout.trim() === 'loaded') found.push({ role, change, unit })
    }
  }
  return found
}

/** cPanel Server Profile activation: one reviewed systemctl step per unit, then a reconcile with the new roles, verified on the host. */
export function buildRoleApplyPlan(units: readonly { role: ServerRole; change: ServerRoleChange['change']; unit: string }[], reconcile: () => Promise<{ ok: boolean; status: string }>): HostJobPlan {
  const allowed = new Set(units.map(item => item.unit))
  const steps = units.map(({ change, unit }, index): HostJobCommandStep => ({ id: `unit-${index + 1}`, title: change === 'enable' ? msgid('Start and enable {unit}') : msgid('Stop and disable {unit}'), titleValues: { unit },
    argv: serverRoleSwitchArgv(change, unit), timeoutMs: STEP_TIMEOUT_MS, mutates: true }))
  return {
    kind: SERVER_ROLE_JOB_KIND, summary: `Apply server role changes to ${units.length} services`, accountId: null, fingerprint: { units }, detail: { units }, steps,
    policy: argv => isServerRoleCommand(argv) && allowed.has(argv.at(-1)!),
    verify: async hostRun => {
      const states: Record<string, string> = {}
      for (const { change, unit } of units) {
        const shown = await hostRun(serverRoleStateArgv(unit), { timeoutMs: 10_000 })
        const active = shown.stdout.trim()
        states[unit] = active
        if (!shown.ok || (change === 'enable') !== (active === 'active')) return { ok: false, detail: { states, failed: unit } }
      }
      const reconciled = await reconcile()
      return { ok: reconciled.ok, detail: { states, reconcile: reconciled.status } }
    },
  }
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const readBody = async (req: Request): Promise<Record<string, unknown>> => {
  const raw = await req.text()
  if (raw.length > 16_384) return fail('VALIDATION', 'request body is too large', unchanged)
  try { const body: unknown = raw.trim() ? JSON.parse(raw) : {}; return object(body) ? body : fail('VALIDATION', 'request body must be an object', unchanged) }
  catch { return fail('VALIDATION', 'request body must be valid JSON', unchanged) }
}

export interface DnsCleanupRead { observedAt: string; catalog: 'read' | 'absent'; stanzas: number; duplicates: string[]; orphanStanzas: string[]; orphanFiles: string[]; truncated: boolean }
/** The catalog text the reconciler publishes, so a cleanup leaves no drift against the active generation. */
export const renderZoneCatalog = (zones: readonly string[], zoneDir: string): string =>
  ['// Managed by xPanel: PowerDNS BIND zone catalog', ...zones.map(zone => `zone "${zone}" {\n  type master;\n  file "${zoneDir}/${zone}.zone";\n};`), ''].join('\n')

const ZONE_STANZA = /zone\s+"([^"\n]{1,253})"\s*\{/g

/** Duplicate and unsaved stanzas of the PowerDNS catalog, and zone files no saved zone renders. */
export function scanDnsCatalog(catalog: string | null, saved: readonly string[], zoneFiles: readonly string[], now: Date, truncated = false): DnsCleanupRead {
  const names = [...(catalog ?? '').matchAll(ZONE_STANZA)].map(match => match[1]!), known = new Set(saved), seen = new Set<string>(), duplicates = new Set<string>()
  for (const name of names) { if (seen.has(name)) duplicates.add(name); seen.add(name) }
  return { observedAt: now.toISOString(), catalog: catalog === null ? 'absent' : 'read', stanzas: names.length, duplicates: [...duplicates].sort(), orphanStanzas: [...seen].filter(name => !known.has(name)).sort(),
    orphanFiles: zoneFiles.filter(name => name.endsWith('.zone') && !known.has(name.slice(0, -'.zone'.length))).sort(), truncated }
}

export interface ServerOperationsHost {
  readFile(path: string): Promise<string | null>
  writeFile(file: RenderedFile): Promise<void>
  removePath(path: string): Promise<void>
  runAction(action: HostAction): Promise<void>
  runCommand(argv: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }>
}
export interface ServerOperationsRouteContext {
  assertRoot: (action: string) => Promise<{ actor: string }>
  /** Null unless this agent runs the native Linux executor; every route then refuses instead of simulating the host. */
  host: ServerOperationsHost | null
  family: OsProfile['family'] | null
  rootDir: string
  savedZones: () => Promise<string[]>
  listZoneFiles: (dir: string, max: number) => Promise<{ state: string; entries: { name: string }[]; truncated: boolean }>
  submitJob: ((plan: HostJobPlan, actor: string) => Promise<HostJobView>) | null
  reconcile: (actor: string) => Promise<{ ok: boolean; status: string }>
  resolver?: Pick<DnsToolsResolver, 'v4'>
  now?: () => Date
}

const ROUTES: Readonly<Record<string, string>> = { '/host/server/resolvers/apply': 'POST', '/host/server/roles/apply': 'POST', '/host/dns-ops/cleanup': 'GET, POST', '/host/dns-ops/lookup': 'GET' }
const MAX_ZONE_ENTRIES = 5000

async function scanCleanup(ctx: ServerOperationsRouteContext, host: ServerOperationsHost): Promise<DnsCleanupRead> {
  const [catalog, saved, listing] = await Promise.all([host.readFile(DEFAULT_NAMED_ZONES_CONF), ctx.savedZones(), ctx.listZoneFiles(DEFAULT_DNS_ZONE_DIR, MAX_ZONE_ENTRIES)])
  return scanDnsCatalog(catalog, saved, listing.entries.map(entry => entry.name), ctx.now?.() ?? new Date(), listing.truncated)
}

/** Root-only server operations that act on the host outside a generation. Returns null for other paths. */
export async function handleServerOperationsRoute(req: Request, url: URL, method: string, ctx: ServerOperationsRouteContext): Promise<Response | null> {
  const allow = ROUTES[url.pathname]
  if (!allow) return null
  const { actor } = await ctx.assertRoot(`host${url.pathname.replaceAll('/', '.').slice('.host'.length)}`)
  if (!allow.split(', ').includes(method)) return new Response(null, { status: 405, headers: { allow } })
  const host = ctx.host
  if (!host || !ctx.family) return fail('PRECONDITION_FAILED', 'this operation requires the native Linux host executor', { ...unchanged, reason: 'host_executor_unavailable' })

  if (url.pathname === '/host/server/resolvers/apply') {
    const resolvers = await readSaved(ctx.rootDir, SERVER_OPERATIONS_STATE.resolvers, raw => validateServerResolvers((raw as { resolvers?: unknown })?.resolvers))
    if (!resolvers) return fail('PRECONDITION_FAILED', 'no resolvers are saved', { ...unchanged, reason: 'resolvers_not_saved' })
    // A symlink to the systemd-resolved stub is unreadable through the no-follow reader; there are then no lines to keep.
    const previous = await host.readFile(system.RESOLV_CONF_PATH).catch(() => null)
    if (ctx.family === 'rhel') {
      // A host without NetworkManager has no conf.d and nothing that rewrites resolv.conf.
      await host.writeFile(system.renderNetworkManagerDnsNone()).then(() => host.runCommand(['/usr/bin/systemctl', 'reload', 'NetworkManager.service'])).catch(() => undefined)
    }
    const file = system.renderResolvConf(resolvers, previous)
    await host.writeFile(file)
    if (ctx.family === 'rhel') await host.runCommand(['/usr/sbin/restorecon', system.RESOLV_CONF_PATH])
    const written = await host.readFile(system.RESOLV_CONF_PATH)
    return json({ applied: written === file.content, resolvers })
  }

  if (url.pathname === '/host/server/roles/apply') {
    const body = await readBody(req)
    const changes = Array.isArray(body.changes) ? body.changes as ServerRoleChange[] : []
    const roles = effectiveServerRoles(await readServerRoles(ctx.rootDir))
    if (changes.length > SERVER_ROLES.length || changes.some(item => !object(item) || !SERVER_ROLES.includes(item.role) || (item.change === 'enable') !== roles.has(item.role) || !['enable', 'disable'].includes(item.change))) return fail('VALIDATION', 'the role changes do not match the saved roles', unchanged)
    const units = await roleUnitChanges(argv => host.runCommand(argv), changes)
    if (units.length === 0) return json({ job: null, units: [] })
    if (!ctx.submitJob) return fail('PRECONDITION_FAILED', 'the host job runner is unavailable', { ...unchanged, reason: 'host_job_runner_unavailable' })
    const job = await ctx.submitJob(buildRoleApplyPlan(units, () => ctx.reconcile(actor)), actor)
    return json({ job: { id: job.id, status: job.status }, units }, 202)
  }

  if (url.pathname === '/host/dns-ops/lookup') {
    const name = url.searchParams.get('name') ?? ''
    if (!/^[a-z0-9.-]{1,253}$/.test(name)) return fail('VALIDATION', 'a host name is required', unchanged)
    const resolver = ctx.resolver ?? localAuthoritativeResolver()
    return json({ name, addresses: await resolver.v4(name).catch(() => []) })
  }

  if (method === 'GET') return json(await scanCleanup(ctx, host))
  if (!effectiveServerRoles(await readServerRoles(ctx.rootDir)).has('dns')) return fail('PRECONDITION_FAILED', 'the DNS server is disabled on this server', { ...unchanged, reason: 'dns_role_disabled' })
  const before = await scanCleanup(ctx, host)
  const removed = before.orphanFiles
  const saved = await ctx.savedZones()
  await host.writeFile({ path: DEFAULT_NAMED_ZONES_CONF, content: renderZoneCatalog(saved, DEFAULT_DNS_ZONE_DIR), mode: 0o644, owner: 'root', group: 'root' })
  for (const name of removed) await host.removePath(`${DEFAULT_DNS_ZONE_DIR}/${name}`)
  await host.runAction({ kind: 'exec', argv: ['/usr/bin/pdns_control', 'rediscover'] })
  await host.runAction({ kind: 'exec', argv: ['/usr/bin/pdns_control', 'reload'] })
  const after = await scanCleanup(ctx, host)
  return json({ cleaned: before.duplicates.length + before.orphanStanzas.length + removed.length, before, after })
}
