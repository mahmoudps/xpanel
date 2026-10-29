import { isIP } from 'node:net'
import { fail } from '@xpanel/core'
import type { Database, Domain, ServerIpEntry, ServerSettings, ServiceUser } from '@xpanel/core'
import { SERVER_CRON_ENTRY_NAME, SERVER_HOSTNAME, SERVER_IFNAME, SERVER_UNIT_NAME, SERVER_WORD, serverTimerOwner } from '../../../packages/os/src/server-observation-command.ts'
import type {
  ObservedSection, ServerAddress, ServerCronDirectory, ServerFileFact, ServerInterface, ServerNetworkRead, ServerObservationReason, ServerRoleRead, ServerRoute, ServerTimer, ServerTimersRead,
} from '../../agent/src/server-observation.ts'
import type { HostServiceStatus } from '../../agent/src/host-services.ts'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

export type ServerObservationHostPath = '/host/server/timers' | '/host/server/network' | '/host/server/role'
/** Only these saved fields are read; StateSnapshot satisfies it. */
export interface ServerObservationSaved {
  server: { settings: Pick<ServerSettings, 'hostname' | 'engine' | 'apacheMpm'>; setupCompletedAt: string | null } | null
  ipPool?: readonly Pick<ServerIpEntry, 'address' | 'version' | 'prefixLength' | 'interfaceName' | 'role' | 'isPrimary'>[]
  accounts: readonly unknown[]
  domains: readonly (Pick<Domain, 'siteType'> & { php: { version: string } })[]
  serviceUsers: readonly { services: Pick<ServiceUser['services'], 'email'> }[]
  databases: readonly Pick<Database, 'trashedAt'>[]
  zones: readonly unknown[]
}
export interface ServerObservationWorkspaceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot'> {
  readSaved: () => Promise<ServerObservationSaved>
  /** Absent when no protected host agent is connected; observed sections are then reported unavailable. */
  readHost?: (caller: AuthenticatedCaller, path: ServerObservationHostPath) => Promise<unknown>
  now?: () => Date
}
export type PoolStatus = 'configured' | 'other-interface' | 'missing' | 'unverified'
export interface ServerPoolComparison { address: string; version: 4 | 6; prefixLength: number; interfaceName: string; role: string; isPrimary: boolean; status: PoolStatus; observedInterface: string | null; observedPrefixLength: number | null }
export type ServerRoleComponentId = 'web-edge' | 'web-backend' | 'php' | 'mail' | 'dns' | 'database'

const ACTION = 'server.server-observation.read'
const PATHS: Readonly<Record<string, ServerObservationHostPath>> = {
  '/api/server/server-observation/timers': '/host/server/timers', '/api/server/server-observation/network': '/host/server/network', '/api/server/server-observation/role': '/host/server/role',
}
const REASONS: readonly string[] = ['host_unavailable', 'command_failed', 'output_limit', 'malformed_output', 'unreadable']
const SERVICE_STATES: readonly string[] = ['active', 'inactive', 'failed', 'not-installed', 'unchecked']
const invalid = (): never => fail('PRECONDITION_FAILED', 'the server observation could not be verified', { stateChanged: false })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const count = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max
const iso = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value))
const matching = (value: unknown, grammar: RegExp): string => typeof value === 'string' && grammar.test(value) ? value : invalid()
const ip = (value: unknown, family?: 4 | 6): string => typeof value === 'string' && value.length <= 64 && isIP(value) !== 0 && (!family || isIP(value) === family) ? value : invalid()
const nullable = <T>(value: unknown, read: (raw: unknown) => T): T | null => value === null ? null : read(value)
const list = <T>(value: unknown, limit: number, item: (raw: unknown) => T): T[] => Array.isArray(value) && value.length <= limit ? value.map(item) : invalid()
const unique = <T>(items: T[], key: (item: T) => string): T[] => new Set(items.map(key)).size === items.length ? items : invalid()
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

const section = <T>(value: unknown, limit: number, item: (raw: unknown) => T): ObservedSection<T> => {
  if (!object(value) || !['read', 'unavailable'].includes(String(value.state)) || typeof value.truncated !== 'boolean') return invalid()
  if (value.state === 'read' ? value.reason !== null : !REASONS.includes(String(value.reason)) || value.truncated || !Array.isArray(value.items) || value.items.length) return invalid()
  return { state: value.state as 'read', reason: value.reason as ServerObservationReason | null, truncated: value.truncated, items: list(value.items, limit, item) }
}
const fileFact = <T>(value: unknown, empty: T, read: (raw: unknown) => T): ServerFileFact<T> => {
  if (!object(value) || !['read', 'absent', 'unavailable'].includes(String(value.state)) || (value.state === 'unavailable' ? !REASONS.includes(String(value.reason)) : value.reason !== null)) return invalid()
  const fact = value.state === 'read' ? read(value.value) : JSON.stringify(value.value) === JSON.stringify(empty) ? empty : invalid()
  return { state: value.state as 'read', reason: value.reason as ServerObservationReason | null, value: fact }
}

const timer = (raw: unknown): ServerTimer => {
  if (!object(raw) || typeof raw.unit !== 'string' || !raw.unit.endsWith('.timer') || raw.next !== null && !iso(raw.next) || raw.last !== null && !iso(raw.last)) return invalid()
  const unit = matching(raw.unit, SERVER_UNIT_NAME), owner = serverTimerOwner(unit)
  // The owner is derived from the unit name only; a host claim that disagrees is refused.
  if (JSON.stringify(owner) !== JSON.stringify(raw.owner)) return invalid()
  return { unit, activates: list(raw.activates, 16, item => matching(item, SERVER_UNIT_NAME)), next: raw.next as string | null, last: raw.last as string | null, owner }
}
const cronDirectory = (value: unknown): ServerCronDirectory => {
  if (!object(value) || !['read', 'absent', 'unavailable'].includes(String(value.state)) || typeof value.truncated !== 'boolean' || !count(value.unlisted)
    || (value.state === 'unavailable' ? !REASONS.includes(String(value.reason)) : value.reason !== null) || value.state !== 'read' && (value.truncated || value.unlisted || !Array.isArray(value.items) || value.items.length)) return invalid()
  const items = unique(list(value.items, 512, raw => object(raw) && (raw.kind === 'file' || raw.kind === 'other') ? { name: matching(raw.name, SERVER_CRON_ENTRY_NAME), kind: raw.kind as 'file' | 'other' } : invalid()), item => item.name)
  return { state: value.state as 'read', reason: value.reason as ServerObservationReason | null, truncated: value.truncated, unlisted: value.unlisted, items }
}
export function projectServerTimers(value: unknown): ServerTimersRead {
  if (!object(value) || !iso(value.observedAt)) return invalid()
  const timers = section(value.timers, 2000, timer)
  unique(timers.items, item => item.unit)
  return { observedAt: value.observedAt, timers, cronDirectory: cronDirectory(value.cronDirectory) }
}

const address = (raw: unknown): ServerAddress => {
  if (!object(raw) || raw.family !== 4 && raw.family !== 6 || !count(raw.prefixLength, raw.family === 4 ? 32 : 128) || typeof raw.dynamic !== 'boolean') return invalid()
  return { family: raw.family, address: ip(raw.address, raw.family), prefixLength: raw.prefixLength, scope: matching(raw.scope, SERVER_WORD), dynamic: raw.dynamic }
}
const networkInterface = (raw: unknown): ServerInterface => {
  if (!object(raw) || typeof raw.loopback !== 'boolean' || raw.mtu !== null && !count(raw.mtu, 1 << 24)) return invalid()
  return { name: matching(raw.name, SERVER_IFNAME), operstate: matching(raw.operstate, /^[A-Z_]{1,24}$/), mtu: raw.mtu as number | null, loopback: raw.loopback, addresses: list(raw.addresses, 256, address) }
}
const route = (family: 4 | 6) => (raw: unknown): ServerRoute => {
  if (!object(raw) || raw.family !== family || typeof raw.destination !== 'string' || raw.metric !== null && !count(raw.metric, 4294967295)) return invalid()
  if (raw.destination !== 'default') {
    const [prefix, length, ...rest] = raw.destination.split('/')
    ip(prefix, family)
    if (rest.length || length !== undefined && (!/^\d{1,3}$/.test(length) || Number(length) > (family === 4 ? 32 : 128))) return invalid()
  }
  const word = (value: unknown) => nullable(value, item => matching(item, SERVER_WORD)), device = (value: unknown) => nullable(value, item => matching(item, SERVER_IFNAME))
  return { family, destination: raw.destination, gateway: nullable(raw.gateway, item => ip(item)), device: device(raw.device), protocol: word(raw.protocol), scope: word(raw.scope), source: nullable(raw.source, item => ip(item)),
    metric: raw.metric as number | null, type: word(raw.type), nexthops: list(raw.nexthops, 16, hop => object(hop) ? { gateway: nullable(hop.gateway, item => ip(item)), device: device(hop.device) } : invalid()) }
}
export function projectServerNetwork(value: unknown): ServerNetworkRead {
  if (!object(value) || !iso(value.observedAt) || !object(value.resolvers) || typeof value.resolvers.truncated !== 'boolean') return invalid()
  const resolvers = fileFact(value.resolvers, [] as string[], raw => list(raw, 16, item => ip(item)))
  if (value.resolvers.truncated && resolvers.state !== 'read') return invalid()
  const interfaces = section(value.interfaces, 256, networkInterface)
  unique(interfaces.items, item => item.name)
  return { observedAt: value.observedAt, hostname: fileFact(value.hostname, null, raw => nullable(raw, item => matching(item, SERVER_HOSTNAME))), resolvers: { ...resolvers, truncated: value.resolvers.truncated },
    interfaces, routes4: section(value.routes4, 2048, route(4)), routes6: section(value.routes6, 2048, route(6)) }
}
export function projectServerRole(value: unknown): ServerRoleRead {
  if (!object(value) || !iso(value.observedAt)) return invalid()
  const services = section(value.services, 64, (raw): HostServiceStatus => object(raw) && SERVICE_STATES.includes(String(raw.state)) && typeof raw.label === 'string' && /^[A-Za-z0-9 ._-]{1,64}$/.test(raw.label)
    ? { id: matching(raw.id, /^[a-z0-9-]{1,32}$/), label: raw.label, unit: nullable(raw.unit, item => matching(item, SERVER_UNIT_NAME)), state: raw.state as HostServiceStatus['state'] } : invalid())
  unique(services.items, item => item.id)
  return { observedAt: value.observedAt, services }
}

// WHATWG URL serializes IPv6 in one compressed lowercase form, so differently written saved and observed addresses compare equal.
const canonical = (value: string): string => { try { return value.includes(':') ? new URL('http://[' + value + ']').hostname.slice(1, -1) : value } catch { return value } }
const host = (value: string): string => value.toLowerCase().replace(/\.$/, '')

/** Drift between the saved IP pool/hostname and the observed host. Pool addresses absent from every interface are drift; unpooled global addresses are informational. */
export function compareServerNetwork(observed: ServerNetworkRead, saved: ServerObservationSaved) {
  const savedHostname = saved.server?.settings.hostname ?? null, staticHostname = observed.hostname.state === 'read' ? observed.hostname.value : null
  const hostnameComparison = !savedHostname || !staticHostname ? 'unverified' as const : host(staticHostname) === host(savedHostname) ? 'match' as const
    : host(savedHostname).startsWith(host(staticHostname) + '.') ? 'short-name' as const : 'differs' as const
  const addresses = observed.interfaces.state === 'read' ? observed.interfaces.items.flatMap(item => item.addresses.map(entry => ({ ...entry, interface: item.name, key: canonical(entry.address) }))) : null
  const entries = saved.ipPool ?? [], pooled = new Set(entries.map(entry => canonical(entry.address)))
  const pool = entries.map((entry): ServerPoolComparison => {
    const hits = addresses?.filter(item => item.key === canonical(entry.address)) ?? [], same = hits.find(item => item.interface === entry.interfaceName), hit = same ?? hits[0]
    return { address: entry.address, version: entry.version, prefixLength: entry.prefixLength, interfaceName: entry.interfaceName, role: entry.role, isPrimary: entry.isPrimary,
      status: !addresses ? 'unverified' : !hit ? 'missing' : same ? 'configured' : 'other-interface', observedInterface: hit?.interface ?? null, observedPrefixLength: hit?.prefixLength ?? null }
  })
  const unpooled = addresses?.filter(item => item.scope === 'global' && !pooled.has(item.key)).map(item => ({ address: item.address, family: item.family, prefixLength: item.prefixLength, interface: item.interface })) ?? null
  return { saved: { state: saved.server ? 'read' as const : 'not-set-up' as const, hostname: savedHostname }, hostnameComparison, pool, unpooled }
}

/** Desired role from saved settings and inventory, kept apart from observed service states. */
export function summarizeServerRole(saved: ServerObservationSaved) {
  const settings = saved.server?.settings ?? null, php = saved.domains.filter(domain => domain.siteType === 'php')
  const phpVersions = [...new Set(php.map(domain => domain.php.version))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  const counts = { accounts: saved.accounts.length, domains: saved.domains.length, phpDomains: php.length, mailboxes: saved.serviceUsers.filter(user => user.services.email).length,
    databases: saved.databases.filter(database => database.trashedAt === null).length, zones: saved.zones.length }
  const components: { id: ServerRoleComponentId; value: string | null; count: number | null; services: string[] }[] = [
    { id: 'web-edge', value: settings ? 'nginx' : null, count: null, services: ['nginx'] },
    // OpenLiteSpeed has no reviewed service probe, so its observed state is not claimed.
    { id: 'web-backend', value: settings ? settings.engine === 'apache' ? 'apache mpm-' + settings.apacheMpm : settings.engine : null, count: null, services: settings?.engine === 'apache' ? ['apache'] : [] },
    { id: 'php', value: phpVersions.length ? phpVersions.join(', ') : null, count: counts.phpDomains, services: ['php-fpm'] },
    { id: 'mail', value: null, count: counts.mailboxes, services: ['postfix', 'dovecot', 'opendkim'] },
    { id: 'dns', value: null, count: counts.zones, services: ['pdns'] },
    { id: 'database', value: 'mariadb', count: counts.databases, services: ['mariadb'] },
  ]
  return { saved: { state: settings ? 'read' as const : 'not-set-up' as const, hostname: settings?.hostname ?? null, engine: settings?.engine ?? null, apacheMpm: settings?.engine === 'apache' ? settings.apacheMpm : null,
    setupCompletedAt: saved.server?.setupCompletedAt ?? null, phpVersions, counts }, components }
}

const offline = (path: ServerObservationHostPath, observedAt: string): unknown => {
  const off = { state: 'unavailable', reason: 'host_unavailable', truncated: false, items: [] }
  return path === '/host/server/timers' ? { observedAt, timers: off, cronDirectory: { ...off, unlisted: 0 } }
    : path === '/host/server/network' ? { observedAt, hostname: { state: 'unavailable', reason: 'host_unavailable', value: null }, resolvers: { state: 'unavailable', reason: 'host_unavailable', value: [], truncated: false }, interfaces: off, routes4: off, routes6: off }
    : { observedAt, services: off }
}

/** Root-only read-only observations for /whm/server/{cron,networking,role}. Nothing here changes the host or saved state. */
export async function handleServerObservationWorkspaceRoute(request: Request, url: URL, method: string, helpers: ServerObservationWorkspaceHelpers): Promise<Response | null> {
  const path = PATHS[url.pathname]
  if (!path) return null
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, ACTION)
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  if (url.search) return fail('VALIDATION', 'server observations do not accept selectors', { stateChanged: false })
  const raw = helpers.readHost ? await helpers.readHost(caller, path) : offline(path, (helpers.now?.() ?? new Date()).toISOString())
  const saved = path === '/host/server/timers' ? null : await helpers.readSaved()
  const fresh = await helpers.requireCaller(request)
  await helpers.assertRoot(fresh, ACTION)
  if (fresh.principal.id !== caller.principal.id) return fail('FORBIDDEN', 'server observation authority changed', { stateChanged: false })
  if (path === '/host/server/timers') return json(projectServerTimers(raw))
  if (path === '/host/server/network') { const observed = projectServerNetwork(raw); return json({ ...observed, ...compareServerNetwork(observed, saved!) }) }
  return json({ ...projectServerRole(raw), ...summarizeServerRole(saved!) })
}
