import { isIP } from 'node:net'
import {
  SERVER_ADDRESSES_ARGV, SERVER_CRON_ENTRY_NAME, SERVER_HOSTNAME, SERVER_HOSTNAME_PATH, SERVER_IFNAME, SERVER_RESOLV_CONF_PATH, SERVER_ROUTES4_ARGV, SERVER_ROUTES6_ARGV,
  SERVER_TIMERS_ARGV, SERVER_UNIT_NAME, SERVER_WORD, serverTimerOwner,
} from '../../../packages/os/src/server-observation-command.ts'
import type { ServerTimerOwner } from '../../../packages/os/src/server-observation-command.ts'
import { readHostServices } from './host-services.ts'
import type { HostServiceStatus } from './host-services.ts'

export interface ServerObservationCommandResult { ok: boolean; code?: number; stdout: string; stderr: string }
export type ServerObservationRun = (argv: string[]) => Promise<ServerObservationCommandResult>
export type ServerObservationReadFile = (path: string) => Promise<string | null>
/** node:fs Dirent shape; only the name and regular-file bit are used, never contents. */
export interface ServerCronDirent { name: string; isFile(): boolean }
export type ServerCronDirectoryRead = () => Promise<readonly ServerCronDirent[]>

export type ServerObservationReason = 'host_unavailable' | 'command_failed' | 'output_limit' | 'malformed_output' | 'unreadable'
export interface ObservedSection<T> { state: 'read' | 'unavailable'; reason: ServerObservationReason | null; truncated: boolean; items: T[] }
export type { ServerTimerOwner } from '../../../packages/os/src/server-observation-command.ts'
export interface ServerTimer { unit: string; activates: string[]; next: string | null; last: string | null; owner: ServerTimerOwner }
export interface ServerCronEntry { name: string; kind: 'file' | 'other' }
export interface ServerCronDirectory { state: 'read' | 'absent' | 'unavailable'; reason: ServerObservationReason | null; truncated: boolean; unlisted: number; items: ServerCronEntry[] }
export interface ServerTimersRead { observedAt: string; timers: ObservedSection<ServerTimer>; cronDirectory: ServerCronDirectory }
export interface ServerAddress { family: 4 | 6; address: string; prefixLength: number; scope: string; dynamic: boolean }
export interface ServerInterface { name: string; operstate: string; mtu: number | null; loopback: boolean; addresses: ServerAddress[] }
export interface ServerRoute { family: 4 | 6; destination: string; gateway: string | null; device: string | null; protocol: string | null; scope: string | null; source: string | null; metric: number | null; type: string | null; nexthops: { gateway: string | null; device: string | null }[] }
export interface ServerFileFact<T> { state: 'read' | 'absent' | 'unavailable'; reason: ServerObservationReason | null; value: T }
export interface ServerNetworkRead {
  observedAt: string
  hostname: ServerFileFact<string | null>
  resolvers: ServerFileFact<string[]> & { truncated: boolean }
  interfaces: ObservedSection<ServerInterface>
  routes4: ObservedSection<ServerRoute>
  routes6: ObservedSection<ServerRoute>
}
export interface ServerRoleRead { observedAt: string; services: ObservedSection<HostServiceStatus> }

export const SERVER_TIMER_LIMIT = 2000
export const SERVER_CRON_ENTRY_LIMIT = 512
export const SERVER_INTERFACE_LIMIT = 256
export const SERVER_ADDRESS_LIMIT = 256
export const SERVER_ROUTE_LIMIT = 2048
export const SERVER_RESOLVER_LIMIT = 16
const MAX_COMMAND_BYTES = 2 * 1024 * 1024
const MAX_FILE_BYTES = 64 * 1024
// 9999-12-31T23:59:59Z in microseconds; systemd prints CLOCK_REALTIME usec.
const MAX_USEC = 253402300799 * 1_000_000

class Malformed extends Error {}
const malformed = (): never => { throw new Malformed() }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const integer = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max
const optional = <T>(value: unknown, read: (raw: unknown) => T): T | null => value === undefined || value === null ? null : read(value)
const word = (value: unknown): string => typeof value === 'string' && SERVER_WORD.test(value) ? value : malformed()
const ifname = (value: unknown): string => typeof value === 'string' && SERVER_IFNAME.test(value) ? value : malformed()
const address = (value: unknown, family?: 4 | 6): string => typeof value === 'string' && value.length <= 64 && isIP(value) !== 0 && (!family || isIP(value) === family) ? value : malformed()
const unavailable = <T>(reason: ServerObservationReason): ObservedSection<T> => ({ state: 'unavailable', reason, truncated: false, items: [] })

/** Runs one reviewed argv and parses its JSON array; any failure is a truthful unavailable section. */
async function readJsonArray<T>(run: ServerObservationRun | undefined, argv: readonly string[], limit: number, parse: (raw: unknown) => T): Promise<ObservedSection<T>> {
  if (!run) return unavailable('host_unavailable')
  let result: ServerObservationCommandResult
  try { result = await run([...argv]) } catch { return unavailable('command_failed') }
  if (!result || !result.ok || result.code !== undefined && result.code !== 0 || typeof result.stdout !== 'string') return unavailable('command_failed')
  if (Buffer.byteLength(result.stdout) > MAX_COMMAND_BYTES) return unavailable('output_limit')
  let raw: unknown
  try { raw = JSON.parse(result.stdout) } catch { return unavailable('malformed_output') }
  if (!Array.isArray(raw)) return unavailable('malformed_output')
  try { return { state: 'read', reason: null, truncated: raw.length > limit, items: raw.slice(0, limit).map(parse) } }
  catch (error) { if (error instanceof Malformed) return unavailable('malformed_output'); throw error }
}

async function readBoundedFile(readFile: ServerObservationReadFile | undefined, path: string): Promise<{ state: 'read'; text: string } | { state: 'absent' | 'unavailable'; reason: ServerObservationReason | null }> {
  if (!readFile) return { state: 'unavailable', reason: 'host_unavailable' }
  let text: string | null
  try { text = await readFile(path) } catch { return { state: 'unavailable', reason: 'unreadable' } }
  if (text === null) return { state: 'absent', reason: null }
  if (typeof text !== 'string') return { state: 'unavailable', reason: 'unreadable' }
  return Buffer.byteLength(text) > MAX_FILE_BYTES ? { state: 'unavailable', reason: 'output_limit' } : { state: 'read', text }
}

// systemctl(1) --output=json table: timestamps are CLOCK_REALTIME microseconds, null (or 0 for never) when unset.
const usec = (value: unknown): string | null => {
  if (value === undefined || value === null) return null
  if (!integer(value, MAX_USEC)) return malformed()
  return value === 0 ? null : new Date(Math.floor(value / 1000)).toISOString()
}
const unit = (value: unknown): string => typeof value === 'string' && SERVER_UNIT_NAME.test(value) ? value : malformed()
function parseTimer(raw: unknown): ServerTimer {
  if (!object(raw) || typeof raw.unit !== 'string' || !raw.unit.endsWith('.timer')) return malformed()
  const name = unit(raw.unit)
  // Older systemd prints "activates" as a string list (TABLE_STRV); newer as one string.
  const activates = raw.activates === undefined || raw.activates === null ? [] : typeof raw.activates === 'string' ? [unit(raw.activates)]
    : Array.isArray(raw.activates) && raw.activates.length <= 16 ? raw.activates.map(unit) : malformed()
  usec(raw.left); usec(raw.passed)
  return { unit: name, activates, next: usec(raw.next), last: usec(raw.last), owner: serverTimerOwner(name) }
}

async function readCronDirectory(read: ServerCronDirectoryRead | undefined): Promise<ServerCronDirectory> {
  const empty = { truncated: false, unlisted: 0, items: [] }
  if (!read) return { state: 'unavailable', reason: 'host_unavailable', ...empty }
  let entries: readonly ServerCronDirent[]
  try { entries = await read() } catch (error) { return (error as { code?: unknown })?.code === 'ENOENT' ? { state: 'absent', reason: null, ...empty } : { state: 'unavailable', reason: 'unreadable', ...empty } }
  if (!Array.isArray(entries)) return { state: 'unavailable', reason: 'unreadable', ...empty }
  const named = entries.filter(entry => typeof entry?.name === 'string' && SERVER_CRON_ENTRY_NAME.test(entry.name)).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  const items = named.slice(0, SERVER_CRON_ENTRY_LIMIT).map(entry => ({ name: entry.name, kind: entry.isFile() ? 'file' as const : 'other' as const }))
  return { state: 'read', reason: null, truncated: named.length > SERVER_CRON_ENTRY_LIMIT, unlisted: entries.length - named.length, items }
}

/** System timers from systemd plus /etc/cron.d entry names. Read-only; no timer is started from here. */
export async function readServerTimers(input: { run?: ServerObservationRun; readCronDirectory?: ServerCronDirectoryRead; now?: () => Date }): Promise<ServerTimersRead> {
  const observedAt = (input.now?.() ?? new Date()).toISOString()
  const [timers, cronDirectory] = await Promise.all([readJsonArray(input.run, SERVER_TIMERS_ARGV, SERVER_TIMER_LIMIT, parseTimer), readCronDirectory(input.readCronDirectory)])
  if (timers.state === 'read' && new Set(timers.items.map(item => item.unit)).size !== timers.items.length) return { observedAt, timers: unavailable('malformed_output'), cronDirectory }
  return { observedAt, timers, cronDirectory }
}

// ip(8) -j addr: one object per link with an addr_info array (family inet|inet6, local, prefixlen, scope).
function parseInterface(raw: unknown): ServerInterface {
  if (!object(raw) || typeof raw.operstate !== 'string' || !/^[A-Z_]{1,24}$/.test(raw.operstate) || raw.flags !== undefined && (!Array.isArray(raw.flags) || raw.flags.some(flag => typeof flag !== 'string'))
    || raw.addr_info !== undefined && (!Array.isArray(raw.addr_info) || raw.addr_info.length > SERVER_ADDRESS_LIMIT)) return malformed()
  const addresses = ((raw.addr_info ?? []) as unknown[]).map((info): ServerAddress => {
    if (!object(info) || info.family !== 'inet' && info.family !== 'inet6' || info.dynamic !== undefined && typeof info.dynamic !== 'boolean') return malformed()
    const family = info.family === 'inet' ? 4 : 6
    if (!integer(info.prefixlen, family === 4 ? 32 : 128)) return malformed()
    return { family, address: address(info.local, family), prefixLength: info.prefixlen, scope: word(info.scope), dynamic: info.dynamic === true }
  })
  return { name: ifname(raw.ifname), operstate: raw.operstate, mtu: optional(raw.mtu, value => integer(value, 1 << 24) ? value : malformed()),
    loopback: (raw.flags as string[] | undefined)?.includes('LOOPBACK') === true || raw.link_type === 'loopback', addresses }
}

// ip(8) -j route: dst is "default" or a prefix; multipath routes carry nexthops instead of gateway/dev.
const routeParser = (family: 4 | 6) => (raw: unknown): ServerRoute => {
  if (!object(raw) || typeof raw.dst !== 'string' || raw.nexthops !== undefined && (!Array.isArray(raw.nexthops) || raw.nexthops.length > 16)) return malformed()
  if (raw.dst !== 'default') {
    const [prefix, length, ...rest] = raw.dst.split('/')
    address(prefix, family)
    if (rest.length || length !== undefined && (!/^\d{1,3}$/.test(length) || Number(length) > (family === 4 ? 32 : 128))) return malformed()
  }
  const nexthops = ((raw.nexthops ?? []) as unknown[]).map(hop => object(hop) ? { gateway: optional(hop.gateway, value => address(value)), device: optional(hop.dev, ifname) } : malformed())
  return { family, destination: raw.dst, gateway: optional(raw.gateway, value => address(value)), device: optional(raw.dev, ifname), protocol: optional(raw.protocol, word), scope: optional(raw.scope, word),
    source: optional(raw.prefsrc, value => address(value)), metric: optional(raw.metric, value => integer(value, 4294967295) ? value : malformed()), type: optional(raw.type, word), nexthops }
}

// hostname(5): a single newline-terminated name; lines starting with "#" are comments.
const parseHostname = (text: string): string | null => {
  const line = text.split('\n').map(item => item.trim()).find(item => item !== '' && !item.startsWith('#'))
  return line === undefined ? null : SERVER_HOSTNAME.test(line) ? line : malformed()
}
// resolv.conf(5): "nameserver <address>" lines; "#" or ";" in the first column start a comment.
const parseNameservers = (text: string): string[] => text.split('\n').map(line => line.trim()).filter(line => line !== '' && !/^[#;]/.test(line))
  .map(line => line.split(/\s+/)).filter(tokens => tokens[0] === 'nameserver').map(tokens => tokens.length === 2 ? address(tokens[1]) : malformed())

/** Interfaces, routes, static hostname and resolver lines. Read-only; nothing is changed. */
export async function readServerNetwork(input: { run?: ServerObservationRun; readFile?: ServerObservationReadFile; now?: () => Date }): Promise<ServerNetworkRead> {
  const observedAt = (input.now?.() ?? new Date()).toISOString()
  const [interfaces, routes4, routes6, hostFile, resolvFile] = await Promise.all([
    readJsonArray(input.run, SERVER_ADDRESSES_ARGV, SERVER_INTERFACE_LIMIT, parseInterface),
    readJsonArray(input.run, SERVER_ROUTES4_ARGV, SERVER_ROUTE_LIMIT, routeParser(4)),
    readJsonArray(input.run, SERVER_ROUTES6_ARGV, SERVER_ROUTE_LIMIT, routeParser(6)),
    readBoundedFile(input.readFile, SERVER_HOSTNAME_PATH), readBoundedFile(input.readFile, SERVER_RESOLV_CONF_PATH),
  ])
  const fact = <T>(file: typeof hostFile, empty: T, parse: (text: string) => T): ServerFileFact<T> => {
    if (file.state !== 'read') return { state: file.state, reason: file.reason, value: empty }
    try { return { state: 'read', reason: null, value: parse(file.text) } } catch (error) { if (error instanceof Malformed) return { state: 'unavailable', reason: 'malformed_output', value: empty }; throw error }
  }
  const nameservers = fact(resolvFile, [] as string[], parseNameservers)
  const resolvers = { ...nameservers, value: nameservers.value.slice(0, SERVER_RESOLVER_LIMIT), truncated: nameservers.value.length > SERVER_RESOLVER_LIMIT }
  const unique = interfaces.state === 'read' && new Set(interfaces.items.map(item => item.name)).size === interfaces.items.length
  return { observedAt, hostname: fact(hostFile, null, parseHostname), resolvers, interfaces: interfaces.state === 'read' && !unique ? unavailable('malformed_output') : interfaces, routes4, routes6 }
}

/** Observed service states for the role summary, from the existing reviewed services reader. */
export async function readServerRole(input: { run?: ServerObservationRun; now?: () => Date }): Promise<ServerRoleRead> {
  const observedAt = (input.now?.() ?? new Date()).toISOString()
  if (!input.run) return { observedAt, services: unavailable('host_unavailable') }
  const run = input.run
  try { return { observedAt, services: { state: 'read', reason: null, truncated: false, items: await readHostServices(argv => run(argv)) } } }
  catch { return { observedAt, services: unavailable('command_failed') } }
}
