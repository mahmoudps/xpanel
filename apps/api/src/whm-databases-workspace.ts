import { fail } from '@xpanel/core'
import type { Account, Database, DatabaseUser, Reseller } from '@xpanel/core'
import { MARIADB_ADMIN_STATUS_NAMES, MARIADB_SYSTEM_SCHEMAS, MARIADB_SYSTEM_USERS, isMariadbThreadId } from '../../../packages/os/src/mariadb-admin-command.ts'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

export type WhmDatabasesHostPath = '/host/databases/overview' | '/host/databases/users' | '/host/databases/processes' | '/host/databases/servers'
export interface WhmDatabasesSaved {
  accounts: readonly Pick<Account, 'id' | 'username' | 'ownerId' | 'status'>[]
  resellers: readonly Pick<Reseller, 'id' | 'username'>[]
  databases: readonly Database[]
  /** Only id, account, name and grants are read; authentication strings never enter a projection. */
  databaseUsers: readonly Pick<DatabaseUser, 'id' | 'accountId' | 'name' | 'grants'>[]
}
export interface WhmDatabasesWorkspaceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  readSaved: () => Promise<WhmDatabasesSaved>
  /** The authenticated agent runs only its reviewed statements; no SQL, path or credential crosses this port. */
  readHost: (caller: AuthenticatedCaller, path: WhmDatabasesHostPath) => Promise<unknown>
  killOnHost: (caller: AuthenticatedCaller, body: WhmDatabaseKillRequest) => Promise<unknown>
}
export interface WhmDatabaseKillRequest { id: number; mode: 'query' | 'connection'; user: string; db: string | null }
export type WhmDrift = 'in-sync' | 'saved-only' | 'server-only' | 'system' | 'unverified'

type Observed<T> = { state: 'read' | 'partial' | 'unavailable'; observedAt: string | null } & T
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/u
const safe = (value: unknown, max: number, min = 0): value is string => typeof value === 'string' && value.length >= min && value.length <= max && value.isWellFormed() && !UNSAFE.test(value)
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const timestamp = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value))
const VERSION = /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,4}[0-9A-Za-z.+_~-]{0,96}$/
const STATES = ['read', 'partial', 'unavailable']
const SYSTEM_SCHEMAS = new Set<string>(MARIADB_SYSTEM_SCHEMAS), SYSTEM_USERS = new Set<string>(MARIADB_SYSTEM_USERS)
const invalid = (): never => { throw new Error('invalid_host_observation') }
const list = <T>(value: unknown, item: (raw: unknown) => T): T[] => Array.isArray(value) && value.length <= 5000 ? value.map(item) : invalid()
const nullable = <T>(value: unknown, read: (raw: unknown) => T): T | null => value === null ? null : read(value)
const header = (value: unknown, sections: readonly string[]): Observed<{}> => {
  if (!object(value) || !STATES.includes(String(value.state)) || !timestamp(value.observedAt)) return invalid()
  const present = sections.filter(key => value[key] !== null).length
  if (value.state !== (present === sections.length ? 'read' : present === 0 ? 'unavailable' : 'partial')) return invalid()
  return { state: value.state as 'read', observedAt: value.observedAt }
}
const observe = async <R extends Observed<Record<string, unknown>>>(read: () => Promise<unknown>, project: (value: unknown) => R, empty: NoInfer<Omit<R, 'state' | 'observedAt'>>): Promise<R> => {
  try { return project(await read()) } catch { return { state: 'unavailable', observedAt: null, ...empty } as R }
}

const status = (raw: unknown): Record<string, number> => {
  if (!object(raw) || Object.keys(raw).length !== MARIADB_ADMIN_STATUS_NAMES.length || MARIADB_ADMIN_STATUS_NAMES.some(name => !count(raw[name]))) return invalid()
  return Object.fromEntries(MARIADB_ADMIN_STATUS_NAMES.map(name => [name, raw[name] as number]))
}
const version = (raw: unknown): string => typeof raw === 'string' && VERSION.test(raw) ? raw : invalid()
export function projectOverviewObservation(value: unknown) {
  const head = header(value, ['version', 'status', 'schemas']), body = value as Record<string, unknown>
  const schemas = nullable(body.schemas, raw => list(raw, item => object(item) && safe(item.name, 64, 1) && count(item.sizeBytes) && count(item.tables) ? { name: item.name, sizeBytes: item.sizeBytes, tables: item.tables } : invalid()))
  if (schemas && new Set(schemas.map(item => item.name)).size !== schemas.length) return invalid()
  return { ...head, version: nullable(body.version, version), status: nullable(body.status, status), schemas }
}
export function projectAccountsObservation(value: unknown) {
  const head = header(value, ['accounts']), body = value as Record<string, unknown>
  const accounts = nullable(body.accounts, raw => list(raw, item => object(item) && safe(item.user, 128) && safe(item.host, 255) && typeof item.role === 'boolean' ? { user: item.user, host: item.host, role: item.role } : invalid()))
  if (accounts && new Set(accounts.map(item => item.user + '\u0000' + item.host)).size !== accounts.length) return invalid()
  return { ...head, accounts }
}
const REASONS = ['agent-session', 'agent-account', 'system-account', 'replication-or-daemon']
export function projectProcessesObservation(value: unknown) {
  const head = header(value, ['processes']), body = value as Record<string, unknown>
  if (body.queryText !== 'not-read') return invalid()
  const processes = nullable(body.processes, raw => list(raw, item => {
    if (!object(item) || !isMariadbThreadId(item.id) || !safe(item.user, 128) || !safe(item.host, 255) || item.db !== null && !safe(item.db, 64, 1) || !safe(item.command, 32, 1) || !count(item.timeSeconds) || !safe(item.threadState, 128)
      || typeof item.protected !== 'boolean' || (item.protected ? !REASONS.includes(String(item.protectedReason)) : item.protectedReason !== null)) return invalid()
    return { id: item.id, user: item.user, host: item.host, db: item.db as string | null, command: item.command, timeSeconds: item.timeSeconds, threadState: item.threadState, protected: item.protected, protectedReason: item.protectedReason as string | null }
  }))
  if (processes && new Set(processes.map(item => item.id)).size !== processes.length) return invalid()
  return { ...head, processes }
}
const SERVICE_STATES = ['active', 'inactive', 'failed', 'not-installed', 'unchecked']
export function projectServerObservation(value: unknown) {
  const head = header(value, ['version', 'variables']), body = value as Record<string, unknown>
  if (body.engine !== 'mariadb') return invalid()
  const service = nullable(body.service, raw => object(raw) && SERVICE_STATES.includes(String(raw.state)) && (raw.unit === null || safe(raw.unit, 128, 1) && /^[a-zA-Z0-9_.@-]+\.service$/.test(raw.unit)) ? { state: raw.state as string, unit: raw.unit as string | null } : invalid())
  const configuration = nullable(body.configuration, raw => object(raw) && raw.source === 'agent-client-configuration' && (raw.protocol === 'socket' ? safe(raw.socket, 1024, 2) && raw.socket.startsWith('/') : raw.protocol === 'default' && raw.socket === null) ? { source: raw.source, protocol: raw.protocol as string, socket: raw.socket as string | null } : invalid())
  const variables = nullable(body.variables, raw => object(raw) && count(raw.port) && raw.port <= 65535 && safe(raw.socket, 1024) && safe(raw.bind_address, 255) && ['ON', 'OFF'].includes(String(raw.skip_networking)) && count(raw.max_connections)
    ? { port: raw.port, socket: raw.socket, bind_address: raw.bind_address, skip_networking: raw.skip_networking as string, max_connections: raw.max_connections } : invalid())
  return { ...head, service, configuration, version: nullable(body.version, version), variables }
}

const byAccount = <T extends { accountId: string }>(rows: readonly T[]): Map<string, T[]> => {
  const groups = new Map<string, T[]>()
  for (const row of rows) { const group = groups.get(row.accountId) ?? []; group.push(row); groups.set(row.accountId, group) }
  return groups
}
const bounded = (saved: WhmDatabasesSaved): void => {
  if (saved.accounts.length > 10000 || saved.databases.length > 50000 || saved.databaseUsers.length > 50000) fail('PRECONDITION_FAILED', 'saved database inventory exceeds the bounded workspace capacity', { stateChanged: false })
}

/** Saved desired state and observed server facts stay separately labelled; drift is computed only from an actual read. */
export function projectWhmDatabaseOverview(saved: WhmDatabasesSaved, observed: ReturnType<typeof projectOverviewObservation>) {
  bounded(saved)
  const names = new Map(saved.accounts.map(account => [account.id, account.username])), resellers = new Map(saved.resellers.map(reseller => [reseller.id, reseller.username]))
  const sizes = observed.schemas ? new Map(observed.schemas.map(schema => [schema.name, schema])) : null
  const databasesBy = byAccount(saved.databases), usersBy = byAccount(saved.databaseUsers)
  const accounts = saved.accounts.map(account => {
    const databases = databasesBy.get(account.id) ?? [], users = usersBy.get(account.id) ?? []
    return {
      account: account.username, owner: account.ownerId === null ? null : resellers.get(account.ownerId) ?? null, status: account.status,
      databases: databases.filter(database => database.trashedAt === null).length, trashedDatabases: databases.filter(database => database.trashedAt !== null).length,
      users: users.length, grants: users.reduce((total, user) => total + user.grants.length, 0),
      observedSizeBytes: sizes ? databases.reduce((total, database) => total + (sizes.get(database.name)?.sizeBytes ?? 0), 0) : null,
    }
  }).sort((left, right) => left.account.localeCompare(right.account))
  const savedNames = new Set(saved.databases.map(database => database.name))
  const databases: { name: string; account: string | null; trashed: boolean | null; sizeBytes: number | null; tables: number | null; drift: WhmDrift }[] = saved.databases.map(database => {
    const schema = sizes?.get(database.name)
    return { name: database.name, account: names.get(database.accountId) ?? null, trashed: database.trashedAt !== null, sizeBytes: schema?.sizeBytes ?? null, tables: schema?.tables ?? null, drift: !sizes ? 'unverified' : schema ? 'in-sync' : 'saved-only' }
  })
  for (const schema of observed.schemas ?? []) if (!savedNames.has(schema.name)) databases.push({ name: schema.name, account: null, trashed: null, sizeBytes: schema.sizeBytes, tables: schema.tables, drift: SYSTEM_SCHEMAS.has(schema.name) ? 'system' : 'server-only' })
  databases.sort((left, right) => left.name.localeCompare(right.name))
  const sum = (key: 'databases' | 'trashedDatabases' | 'users' | 'grants'): number => accounts.reduce((total, row) => total + row[key], 0)
  return {
    scope: { saved: 'saved-configuration', observed: 'host-observation' },
    saved: { accounts, totals: { accounts: accounts.length, databases: sum('databases'), trashedDatabases: sum('trashedDatabases'), users: sum('users'), grants: sum('grants') } },
    observed: { state: observed.state, observedAt: observed.observedAt, version: observed.version, status: observed.status, schemaCount: observed.schemas?.length ?? null, totalSizeBytes: observed.schemas ? observed.schemas.reduce((total, schema) => total + schema.sizeBytes, 0) : null },
    databases,
    drift: sizes ? { savedOnly: databases.filter(row => row.drift === 'saved-only').length, serverOnly: databases.filter(row => row.drift === 'server-only').length } : null,
  }
}

/** Saved users are always provisioned as name@localhost (see the reconciler); any other observed host is drift. */
export function projectWhmDatabaseUsers(saved: WhmDatabasesSaved, observed: ReturnType<typeof projectAccountsObservation>) {
  bounded(saved)
  const names = new Map(saved.accounts.map(account => [account.id, account.username])), databases = new Map(saved.databases.map(database => [database.id, database.name]))
  const seen = observed.accounts ? new Map(observed.accounts.map(account => [account.user + '\u0000' + account.host, account])) : null
  const savedKeys = new Set(saved.databaseUsers.map(user => user.name + '\u0000localhost'))
  const users: { user: string; host: string; account: string | null; role: boolean | null; grants: { database: string; privileges: string[] }[] | null; drift: WhmDrift }[] = saved.databaseUsers.map(user => {
    const server = seen?.get(user.name + '\u0000localhost')
    return { user: user.name, host: 'localhost', account: names.get(user.accountId) ?? null, role: server ? server.role : null,
      grants: user.grants.flatMap(grant => { const database = databases.get(grant.databaseId); return database ? [{ database, privileges: [...grant.privileges] }] : [] }),
      drift: !seen ? 'unverified' : server ? 'in-sync' : 'saved-only' }
  })
  for (const account of observed.accounts ?? []) if (!savedKeys.has(account.user + '\u0000' + account.host)) users.push({ user: account.user, host: account.host, account: null, role: account.role, grants: null, drift: SYSTEM_USERS.has(account.user) && !account.role ? 'system' : 'server-only' })
  users.sort((left, right) => left.user.localeCompare(right.user) || left.host.localeCompare(right.host))
  return {
    scope: { saved: 'saved-configuration', observed: 'host-observation' }, ownerPage: '/databases/mariadb',
    observed: { state: observed.state, observedAt: observed.observedAt }, users,
    drift: seen ? { savedOnly: users.filter(row => row.drift === 'saved-only').length, serverOnly: users.filter(row => row.drift === 'server-only').length } : null,
  }
}

const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const ROUTES: Readonly<Record<string, WhmDatabasesHostPath>> = {
  '/api/server/databases/overview': '/host/databases/overview', '/api/server/databases/users': '/host/databases/users',
  '/api/server/databases/processes': '/host/databases/processes', '/api/server/databases/servers': '/host/databases/servers',
}
const KILL = '/api/server/databases/processes/kill'

export function parseWhmDatabaseKillRequest(value: unknown): WhmDatabaseKillRequest {
  if (!object(value) || Object.keys(value).length !== 4 || ['id', 'mode', 'user', 'db'].some(key => !(key in value)) || !isMariadbThreadId(value.id) || !['query', 'connection'].includes(String(value.mode)) || !safe(value.user, 128) || value.db !== null && !safe(value.db, 64, 1)) {
    return fail('VALIDATION', 'a kill request needs exactly id, mode, user and db', { stateChanged: false })
  }
  return { id: value.id, mode: value.mode as 'query' | 'connection', user: value.user, db: value.db as string | null }
}

export async function handleWhmDatabasesWorkspaceRoute(request: Request, url: URL, method: string, helpers: WhmDatabasesWorkspaceHelpers): Promise<Response | null> {
  const hostPath = ROUTES[url.pathname], kill = url.pathname === KILL
  if (!hostPath && !kill) return null
  let caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, kill ? 'server.databases.kill' : 'server.databases.read')
  if (method !== (kill ? 'POST' : 'GET')) return new Response(null, { status: 405, headers: { allow: kill ? 'POST' : 'GET' } })
  if (url.search) return fail('VALIDATION', 'database administration does not accept caller-selected accounts, statements or paths', { stateChanged: false })
  if (hostPath) {
    const read = () => helpers.readHost(caller, hostPath)
    if (hostPath === '/host/databases/overview') {
      const [saved, observed] = await Promise.all([helpers.readSaved(), observe(read, projectOverviewObservation, { version: null, status: null, schemas: null })])
      return json(projectWhmDatabaseOverview(saved, observed))
    }
    if (hostPath === '/host/databases/users') {
      const [saved, observed] = await Promise.all([helpers.readSaved(), observe(read, projectAccountsObservation, { accounts: null })])
      return json(projectWhmDatabaseUsers(saved, observed))
    }
    const [saved, observed] = await Promise.all([helpers.readSaved(), hostPath === '/host/databases/processes'
      ? observe(read, projectProcessesObservation, { processes: null })
      : observe(read, projectServerObservation, { service: null, configuration: null, version: null, variables: null })])
    bounded(saved)
    if ('processes' in observed) {
      const owners = new Map(saved.accounts.map(account => [account.id, account.username])), byUser = new Map(saved.databaseUsers.map(user => [user.name, owners.get(user.accountId) ?? null]))
      return json({ scope: { observed: 'host-observation' }, observed: { state: observed.state, observedAt: observed.observedAt }, queryText: 'not-read', processes: observed.processes?.map(row => ({ ...row, account: byUser.get(row.user) ?? null })) ?? null })
    }
    return json({ engines: [{ engine: 'mariadb', label: 'MariaDB', savedDatabases: saved.databases.length, service: observed.service, configuration: observed.configuration, observed: { state: observed.state, observedAt: observed.observedAt, version: observed.version, variables: observed.variables } }] })
  }
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', { stateChanged: false })
  const raw = await request.text()
  let parsed: unknown
  try { if (raw.length > 2048) throw new Error('too_large'); parsed = JSON.parse(raw) } catch { return fail('VALIDATION', 'the kill request is not bounded JSON', { stateChanged: false }) }
  const body = parseWhmDatabaseKillRequest(parsed)
  const fresh = await helpers.requireCaller(request)
  await helpers.assertRoot(fresh, 'server.databases.kill')
  if (fresh.principal.id !== caller.principal.id || fresh.sessionId !== caller.sessionId || fresh.apiTokenId !== caller.apiTokenId) return fail('FORBIDDEN', 'database administration authority changed', { stateChanged: false })
  caller = fresh
  const target = 'mariadb-thread:' + body.id, actor = { actor: caller.principal.username, principalId: caller.principal.id }
  try { await helpers.emitAudit({ ...actor, action: 'server.databases.kill_requested', target, detail: { mode: body.mode, user: body.user, db: body.db }, outcome: 'ok' }) }
  catch { return fail('PRECONDITION_FAILED', 'the kill could not be audited before dispatch', { stateChanged: false }) }
  let result: unknown
  try { result = await helpers.killOnHost(caller, body) }
  catch (error) {
    await Promise.resolve(helpers.emitAudit({ ...actor, action: 'server.databases.kill', target, detail: { mode: body.mode, outcome: 'refused' }, outcome: 'failed' })).catch(() => undefined)
    throw error
  }
  const verified = object(result) && result.id === body.id && result.mode === body.mode && result.user === body.user && result.db === body.db && ['confirmed', 'attempted'].includes(String(result.outcome))
    && typeof result.statementAccepted === 'boolean' && ['absent', 'idle', 'active', 'unread'].includes(String(result.after)) && result.verificationRequired === (result.outcome !== 'confirmed')
    && (result.outcome !== 'confirmed' || result.statementAccepted === true)
  if (!verified) return fail('SERVICE_UNAVAILABLE', 'the kill outcome could not be verified', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  const reply = result as Record<string, unknown>, outcome = { ...body, outcome: reply.outcome as 'confirmed' | 'attempted', statementAccepted: reply.statementAccepted as boolean, after: reply.after as string, verificationRequired: reply.verificationRequired as boolean }
  try { await helpers.emitAudit({ ...actor, action: 'server.databases.kill', target, detail: { mode: body.mode, outcome: outcome.outcome, after: outcome.after }, outcome: outcome.outcome === 'confirmed' ? 'ok' : 'failed' }) }
  catch { return fail('SERVICE_UNAVAILABLE', 'the kill outcome requires audit review', { stateChanged: true, unknownOutcome: true, verificationRequired: true }) }
  return json(outcome)
}
