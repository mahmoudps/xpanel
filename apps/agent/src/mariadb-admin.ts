import { fail } from '@xpanel/core'
import type { NewAuditEntry } from '@xpanel/db'
import {
  MARIADB_ADMIN_ACCOUNTS_SQL, MARIADB_ADMIN_MAX_ROWS, MARIADB_ADMIN_PROCESSLIST_SQL, MARIADB_ADMIN_SCHEMAS_SQL, MARIADB_ADMIN_STATUS_NAMES, MARIADB_ADMIN_STATUS_SQL,
  MARIADB_ADMIN_VARIABLE_NAMES, MARIADB_ADMIN_VARIABLES_SQL, MARIADB_ADMIN_VERSION_SQL, MARIADB_SYSTEM_USERS, isMariadbAdminStatement, isMariadbThreadId, mariadbKillStatement,
} from '../../../packages/os/src/mariadb-admin-command.ts'
import type { MariadbKillMode } from '../../../packages/os/src/mariadb-admin-command.ts'
import type { HostServiceStatus } from './host-services.ts'
import type { AgentCallerIdentity } from './server.ts'

/** The existing protected admin client (MariaDbServiceAdapter); its credential file never leaves the agent. */
export interface MariadbAdminClient { query(statements: readonly string[]): Promise<string>; socketPath: string | null }
export type MariadbAdminSql = (statement: string) => Promise<string>
export type MariadbStatusName = typeof MARIADB_ADMIN_STATUS_NAMES[number]
export interface MariadbSchemaObservation { name: string; sizeBytes: number; tables: number }
export interface MariadbAccountObservation { user: string; host: string; role: boolean }
export type MariadbProtectedReason = 'agent-session' | 'agent-account' | 'system-account' | 'replication-or-daemon'
export interface MariadbProcessObservation { id: number; user: string; host: string; db: string | null; command: string; timeSeconds: number; threadState: string; protected: boolean; protectedReason: MariadbProtectedReason | null }
export interface MariadbVariablesObservation { port: number; socket: string; bind_address: string; skip_networking: 'ON' | 'OFF'; max_connections: number }
type ReadState = 'read' | 'partial' | 'unavailable'

const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/u
const MAX_OUTPUT = 4 * 1024 * 1024
const invalid = (): never => { throw new Error('invalid_mariadb_observation') }

/** mariadb(1) --batch --skip-column-names: one row per line, tab-separated; newline, tab, NUL and backslash are written as \n, \t, \0, \\ (see --raw). */
export function parseMariadbBatch(stdout: string, columns: number): string[][] {
  if (typeof stdout !== 'string' || stdout.length > MAX_OUTPUT || stdout.includes('\r')) return invalid()
  if (stdout === '') return []
  if (!stdout.endsWith('\n')) return invalid()
  const lines = stdout.slice(0, -1).split('\n')
  if (lines.length > MARIADB_ADMIN_MAX_ROWS) throw new Error('mariadb_result_capacity')
  return lines.map(line => {
    const cells = line.split('\t')
    if (cells.length !== columns) return invalid()
    // Only an escaped backslash decodes to an admitted character; \n, \t and \0 would decode to refused controls.
    return cells.map(raw => raw.length > 1024 || UNSAFE.test(raw) || raw.replace(/\\\\/g, '').includes('\\') || !raw.isWellFormed() ? invalid() : raw.replace(/\\\\/g, '\\'))
  })
}

const integer = (raw: string): number => /^(?:0|[1-9][0-9]{0,15})$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : invalid()
const text = (raw: string, max: number, min = 0): string => raw.length >= min && raw.length <= max ? raw : invalid()
const flag = (raw: string, yes: string, no: string): boolean => raw === yes ? true : raw === no ? false : invalid()
const unique = <T>(rows: T[], key: (row: T) => string): T[] => new Set(rows.map(key)).size === rows.length ? rows : invalid()

export const parseMariadbVersion = (stdout: string): string => {
  const rows = parseMariadbBatch(stdout, 1)
  return rows.length === 1 && /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,4}[0-9A-Za-z.+_~-]{0,96}$/.test(rows[0]![0]!) ? rows[0]![0]! : invalid()
}

const namedValues = <N extends string>(stdout: string, allowed: readonly N[]): Map<N, string> => {
  const rows = parseMariadbBatch(stdout, 2), values = new Map<N, string>()
  for (const [name, value] of rows) {
    if (!(allowed as readonly string[]).includes(name!) || values.has(name as N)) return invalid()
    values.set(name as N, value!)
  }
  return values.size === allowed.length ? values : invalid()
}

export const parseMariadbStatus = (stdout: string): Record<MariadbStatusName, number> =>
  Object.fromEntries([...namedValues(stdout, MARIADB_ADMIN_STATUS_NAMES)].map(([name, value]) => [name, integer(value)])) as Record<MariadbStatusName, number>

export const parseMariadbVariables = (stdout: string): MariadbVariablesObservation => {
  const values = namedValues(stdout, MARIADB_ADMIN_VARIABLE_NAMES)
  const port = integer(values.get('port')!), skip = values.get('skip_networking')!
  if (port > 65535 || skip !== 'ON' && skip !== 'OFF') return invalid()
  return { port, socket: text(values.get('socket')!, 1024), bind_address: text(values.get('bind_address')!, 255), skip_networking: skip, max_connections: integer(values.get('max_connections')!) }
}

export const parseMariadbSchemas = (stdout: string): MariadbSchemaObservation[] =>
  unique(parseMariadbBatch(stdout, 3).map(([name, size, tables]) => ({ name: text(name!, 64, 1), sizeBytes: integer(size!), tables: integer(tables!) })), row => row.name)

export const parseMariadbAccounts = (stdout: string): MariadbAccountObservation[] =>
  unique(parseMariadbBatch(stdout, 3).map(([user, host, role]) => ({ user: text(user!, 128), host: text(host!, 255), role: flag(role!, 'Y', 'N') })), row => row.user + '\u0000' + row.host)

const SYSTEM_ACCOUNTS = new Set<string>([...MARIADB_SYSTEM_USERS, 'system user', 'event_scheduler', 'unauthenticated user', ''])
// MariaDB "Thread Command Values": replica, binlog and daemon threads are never killable from this page.
const REPLICATION_COMMANDS = new Set(['Binlog Dump', 'Binlog Dump GTID', 'Connect', 'Connect Out', 'Daemon', 'Register Slave', 'Slave_IO', 'Slave_SQL', 'Slave_worker', 'Table Dump'])

export const parseMariadbProcesslist = (stdout: string): MariadbProcessObservation[] =>
  unique(parseMariadbBatch(stdout, 9).map(([id, user, host, db, command, time, state, self, admin]) => {
    const row = { id: integer(id!), user: text(user!, 128), host: text(host!, 255), db: text(db!, 64) || null, command: text(command!, 32, 1), timeSeconds: integer(time!), threadState: text(state!, 128) }
    const isSelf = flag(self!, '1', '0'), isAdmin = flag(admin!, '1', '0')
    if (row.id < 1) return invalid()
    const reason: MariadbProtectedReason | null = isSelf ? 'agent-session' : isAdmin ? 'agent-account'
      : SYSTEM_ACCOUNTS.has(row.user) ? 'system-account' : REPLICATION_COMMANDS.has(row.command) ? 'replication-or-daemon' : null
    return { ...row, protected: reason !== null, protectedReason: reason }
  }), row => String(row.id))

const admitted = (client: MariadbAdminClient): MariadbAdminSql => async statement => {
  if (!isMariadbAdminStatement(statement)) return fail('VALIDATION', 'unreviewed MariaDB administration statement', { stateChanged: false })
  return client.query([statement])
}
// Any execution, credential or parse failure is the same truthful 'not observed'; server stderr is never returned.
const attempt = async <T>(run: MariadbAdminSql | null, sql: string, parse: (stdout: string) => T): Promise<T | null> => {
  if (!run) return null
  try { return parse(await run(sql)) } catch { return null }
}
const stateOf = (parts: readonly unknown[]): ReadState => parts.every(part => part !== null) ? 'read' : parts.every(part => part === null) ? 'unavailable' : 'partial'

export async function readMariadbOverview(run: MariadbAdminSql | null, now: () => Date = () => new Date()) {
  const observedAt = now().toISOString()
  // Sequential on purpose: each statement is one client process on a 1 vCPU host.
  const version = await attempt(run, MARIADB_ADMIN_VERSION_SQL, parseMariadbVersion)
  const status = await attempt(run, MARIADB_ADMIN_STATUS_SQL, parseMariadbStatus)
  const schemas = await attempt(run, MARIADB_ADMIN_SCHEMAS_SQL, parseMariadbSchemas)
  return { state: stateOf([version, status, schemas]), observedAt, version, status, schemas }
}

export async function readMariadbAccounts(run: MariadbAdminSql | null, now: () => Date = () => new Date()) {
  const observedAt = now().toISOString(), accounts = await attempt(run, MARIADB_ADMIN_ACCOUNTS_SQL, parseMariadbAccounts)
  return { state: accounts ? 'read' as const : 'unavailable' as const, observedAt, accounts }
}

export async function readMariadbProcesses(run: MariadbAdminSql | null, now: () => Date = () => new Date()) {
  const observedAt = now().toISOString(), processes = await attempt(run, MARIADB_ADMIN_PROCESSLIST_SQL, parseMariadbProcesslist)
  return { state: processes ? 'read' as const : 'unavailable' as const, observedAt, queryText: 'not-read' as const, processes }
}

export async function readMariadbServer(run: MariadbAdminSql | null, client: MariadbAdminClient | undefined, readServices: (() => Promise<HostServiceStatus[]>) | undefined, now: () => Date = () => new Date()) {
  const observedAt = now().toISOString()
  let service: { state: HostServiceStatus['state']; unit: string | null } | null = null
  try {
    const row = readServices ? (await readServices()).find(item => item.id === 'mariadb') : undefined
    if (row) service = { state: row.state, unit: row.unit }
  } catch { service = null }
  const version = await attempt(run, MARIADB_ADMIN_VERSION_SQL, parseMariadbVersion)
  const variables = await attempt(run, MARIADB_ADMIN_VARIABLES_SQL, parseMariadbVariables)
  return {
    observedAt, engine: 'mariadb' as const, service,
    configuration: client ? { source: 'agent-client-configuration' as const, protocol: client.socketPath ? 'socket' as const : 'default' as const, socket: client.socketPath } : null,
    state: stateOf([version, variables]), version, variables,
  }
}

export type MariadbKillOutcome = {
  id: number; mode: MariadbKillMode; user: string; db: string | null
  outcome: 'confirmed' | 'attempted'; statementAccepted: boolean; after: 'absent' | 'idle' | 'active' | 'unread'; verificationRequired: boolean
}

const SAFE_TEXT = (value: unknown, max: number, min = 0): value is string => typeof value === 'string' && value.length >= min && value.length <= max && value.isWellFormed() && !UNSAFE.test(value)
export function parseMariadbKillRequest(value: unknown): { id: number; mode: MariadbKillMode; user: string; db: string | null } {
  const object = !!value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  if (!object || Object.keys(object).length !== 4 || ['id', 'mode', 'user', 'db'].some(key => !(key in object)) || !isMariadbThreadId(object.id)
    || object.mode !== 'query' && object.mode !== 'connection' || !SAFE_TEXT(object.user, 128) || object.db !== null && !SAFE_TEXT(object.db, 64, 1)) {
    return fail('VALIDATION', 'a kill request needs exactly id, mode, user and db', { stateChanged: false })
  }
  return { id: object.id, mode: object.mode, user: object.user, db: object.db as string | null }
}

/** Re-reads the exact thread identity, refuses protected threads, and reports only a re-read-proven effect as confirmed. */
export async function killMariadbProcess(run: MariadbAdminSql, request: { id: number; mode: MariadbKillMode; user: string; db: string | null }, beforeKill: () => Promise<void>): Promise<MariadbKillOutcome> {
  const before = await attempt(run, MARIADB_ADMIN_PROCESSLIST_SQL, parseMariadbProcesslist)
  if (!before) return fail('PRECONDITION_FAILED', 'the database process list could not be read; nothing was killed', { stateChanged: false })
  const target = before.find(row => row.id === request.id)
  if (!target || target.user !== request.user || target.db !== request.db) return fail('CONFLICT', 'the database process changed before the kill; read the list again', { stateChanged: false })
  if (target.protected) return fail('FORBIDDEN', 'this database process is protected', { stateChanged: false, reason: target.protectedReason })
  if (request.mode === 'query' && target.command === 'Sleep') return fail('CONFLICT', 'the connection has no running statement', { stateChanged: false })
  await beforeKill()
  let statementAccepted = true
  try { await run(mariadbKillStatement(request.mode, request.id)) } catch { statementAccepted = false }
  const afterRows = await attempt(run, MARIADB_ADMIN_PROCESSLIST_SQL, parseMariadbProcesslist)
  const row = afterRows?.find(item => item.id === request.id)
  const after = !afterRows ? 'unread' : !row ? 'absent' : row.command === 'Sleep' ? 'idle' : 'active'
  const proven = statementAccepted && (after === 'absent' || request.mode === 'query' && after === 'idle')
  return { ...request, outcome: proven ? 'confirmed' : 'attempted', statementAccepted, after, verificationRequired: !proven }
}

export interface MariadbAdminRouteContext {
  caller: AgentCallerIdentity
  /** Fresh principal read for the same request; used immediately before KILL. */
  reauthenticate: () => Promise<AgentCallerIdentity>
  assertRoot: (caller: AgentCallerIdentity, target: string) => Promise<void>
  audit: (entry: NewAuditEntry) => Promise<unknown>
  mariadb?: MariadbAdminClient
  readServices?: () => Promise<HostServiceStatus[]>
  now?: () => Date
}

const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const READS = new Set(['/host/databases/overview', '/host/databases/users', '/host/databases/processes', '/host/databases/servers'])

export async function handleMariadbAdminRoute(req: Request, url: URL, method: string, ctx: MariadbAdminRouteContext): Promise<Response | null> {
  const path = url.pathname, kill = path === '/host/databases/processes/kill'
  if (!READS.has(path) && !kill) return null
  if (method !== (kill ? 'POST' : 'GET')) return new Response(null, { status: 405, headers: { allow: kill ? 'POST' : 'GET' } })
  await ctx.assertRoot(ctx.caller, kill ? 'host.databases.kill' : 'host.databases.read')
  if (url.search) return fail('VALIDATION', 'database administration does not accept request selectors', { stateChanged: false })
  const run = ctx.mariadb ? admitted(ctx.mariadb) : null, now = ctx.now ?? (() => new Date())
  if (!kill) {
    if (path === '/host/databases/overview') return json(await readMariadbOverview(run, now))
    if (path === '/host/databases/users') return json(await readMariadbAccounts(run, now))
    if (path === '/host/databases/processes') return json(await readMariadbProcesses(run, now))
    return json(await readMariadbServer(run, ctx.mariadb, ctx.readServices, now))
  }
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', { stateChanged: false })
  const raw = await req.text()
  let body: unknown
  try { if (raw.length > 2048) throw new Error('too_large'); body = JSON.parse(raw) } catch { return fail('VALIDATION', 'the kill request is not bounded JSON', { stateChanged: false }) }
  const request = parseMariadbKillRequest(body)
  if (!run) return fail('PRECONDITION_FAILED', 'MariaDB administration is not connected on this host', { stateChanged: false })
  const actor = ctx.caller, target = 'mariadb-thread:' + request.id
  const result = await killMariadbProcess(run, request, async () => {
    const fresh = await ctx.reauthenticate()
    await ctx.assertRoot(fresh, 'host.databases.kill')
    if (fresh.principalId !== actor.principalId) return fail('FORBIDDEN', 'database administration authority changed', { stateChanged: false })
    try { await ctx.audit({ actor: actor.actor, principalId: actor.principalId, action: 'host.databases.kill_requested', target, detail: { mode: request.mode, user: request.user, db: request.db }, outcome: 'ok' }) }
    catch { return fail('PRECONDITION_FAILED', 'the kill could not be audited before dispatch', { stateChanged: false }) }
  })
  try { await ctx.audit({ actor: actor.actor, principalId: actor.principalId, action: 'host.databases.kill', target, detail: { mode: request.mode, outcome: result.outcome, after: result.after, statementAccepted: result.statementAccepted }, outcome: result.outcome === 'confirmed' ? 'ok' : 'failed' }) }
  catch { return fail('SERVICE_UNAVAILABLE', 'the kill outcome requires audit review', { stateChanged: true, unknownOutcome: true, verificationRequired: true }) }
  return json(result)
}
