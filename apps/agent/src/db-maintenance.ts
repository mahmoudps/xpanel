import { fail } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import type { NewAuditEntry } from '@xpanel/db'
import { services } from '@xpanel/render'
import { MARIADB_SYSTEM_SCHEMAS } from '../../../packages/os/src/mariadb-admin-command.ts'
import { assertLocalDatabaseServer } from './db-profiles.ts'
import { parseMariadbBatch } from './mariadb-admin.ts'
import type { MariadbAdminClient } from './mariadb-admin.ts'
import type { AgentCallerIdentity } from './server.ts'

/**
 * Root MariaDB maintenance (WHM Repair a MySQL Database, MySQL Root Password). Statements are built here from
 * validated names only and run through the protected admin client; caller text never becomes SQL.
 */
export type DbMaintenanceAction = 'check' | 'repair'
export type DbTableResult = 'ok' | 'repaired' | 'corrupt' | 'not-supported' | 'failed'
export interface DbTableReport { name: string; engine: string | null; result: DbTableResult; message: string | null }
export interface DbMaintenanceReport { database: string; action: DbMaintenanceAction; observedAt: string; tables: DbTableReport[] }
export const DB_MAINTENANCE_MAX_TABLES = 1000
/** REPAIR of a large MyISAM table can run for minutes; the agent and API route timeouts leave room for it. */
export const DB_MAINTENANCE_TIMEOUT_MS = 150_000
export const ROOT_CLIENT_FILE = '/root/.my.cnf'
const ROOT_CLIENT_MARKER = '# managed by xPanel: MariaDB root client password'
const SCHEMA = /^[A-Za-z0-9_$]{1,64}$/
const SYSTEM = new Set<string>(MARIADB_SYSTEM_SCHEMAS)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))

export const isMaintainableSchema = (name: unknown): name is string => typeof name === 'string' && SCHEMA.test(name) && !SYSTEM.has(name.toLowerCase())
export function parseDbMaintenanceRequest(value: unknown): { database: string; action: DbMaintenanceAction } {
  if (!object(value) || !exact(value, ['database', 'action']) || !isMaintainableSchema(value.database) || value.action !== 'check' && value.action !== 'repair') {
    return fail('VALIDATION', 'a maintenance request needs exactly a non-system database name and the action check or repair', { stateChanged: false })
  }
  return { database: value.database, action: value.action }
}

export const mariadbTablesSql = (database: string): string => {
  if (!isMaintainableSchema(database)) throw new Error('invalid_maintenance_schema')
  return `SELECT TABLE_NAME, COALESCE(ENGINE, '') FROM information_schema.TABLES WHERE TABLE_SCHEMA = ${services.quoteString(database)} AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME LIMIT ${DB_MAINTENANCE_MAX_TABLES + 1}`
}
export const mariadbMaintenanceSql = (action: DbMaintenanceAction, database: string, tables: readonly string[]): string =>
  `${action === 'repair' ? 'REPAIR' : 'CHECK'} TABLE ${tables.map(table => services.quoteIdent(database) + '.' + services.quoteIdent(table)).join(', ')}`

/** CHECK/REPAIR TABLE rows are Table, Op, Msg_type, Msg_text; a table's last row carries its final status. */
export function summarizeMaintenance(action: DbMaintenanceAction, database: string, tables: readonly { name: string; engine: string | null }[], rows: readonly string[][]): DbTableReport[] {
  return tables.map(table => {
    const own = rows.filter(row => row[0] === database + '.' + table.name), last = own.at(-1)
    const message = last ? last[3]!.slice(0, 256) : null
    let result: DbTableResult
    if (!last) result = 'failed'
    else if (own.some(row => row[2] === 'note' && /doesn't support/i.test(row[3]!))) result = 'not-supported'
    else if (last[2] === 'status' && (last[3] === 'OK' || /^Table is already up to date$/i.test(last[3]!))) result = action === 'repair' && own.length > 1 ? 'repaired' : 'ok'
    else result = action === 'check' ? 'corrupt' : 'failed'
    return { ...table, result, message }
  })
}

let running = false
export async function maintainMariadbDatabase(client: MariadbAdminClient, request: { database: string; action: DbMaintenanceAction }, now: () => Date = () => new Date()): Promise<DbMaintenanceReport> {
  if (running) return fail('CONFLICT', 'another database maintenance is running', { stateChanged: false, reason: 'database_maintenance_running' })
  running = true
  try {
    let tables: { name: string; engine: string | null }[]
    try { tables = parseMariadbBatch(await client.query([mariadbTablesSql(request.database)]), 2).map(([name, engine]) => ({ name: name!, engine: engine || null })) }
    catch { return fail('PRECONDITION_FAILED', 'the database tables could not be read; nothing was run', { stateChanged: false, reason: 'database_tables_unread' }) }
    if (tables.length > DB_MAINTENANCE_MAX_TABLES || tables.some(table => table.name.length > 64)) return fail('PRECONDITION_FAILED', 'the database has more tables than one maintenance run covers', { stateChanged: false, reason: 'database_table_capacity' })
    const observedAt = now().toISOString()
    if (tables.length === 0) return { database: request.database, action: request.action, observedAt, tables: [] }
    let rows: string[][]
    // A failed statement after some tables ran leaves an unknown result; never report it as repaired.
    try { rows = parseMariadbBatch(await client.query([mariadbMaintenanceSql(request.action, request.database, tables.map(table => table.name))], { timeoutMs: DB_MAINTENANCE_TIMEOUT_MS }), 4) }
    catch { return fail('SERVICE_UNAVAILABLE', 'the maintenance result could not be read', { stateChanged: request.action === 'repair', verificationRequired: true, ...(request.action === 'repair' ? { unknownOutcome: true } : {}) }) }
    return { database: request.database, action: request.action, observedAt, tables: summarizeMaintenance(request.action, request.database, tables, rows) }
  } finally { running = false }
}

const PASSWORD = /^[\x21-\x7e]{8,128}$/
export function parseRootPasswordRequest(value: unknown): { password: string } {
  if (!object(value) || !exact(value, ['password']) || typeof value.password !== 'string' || !PASSWORD.test(value.password)) {
    return fail('VALIDATION', 'the root password must be 8 to 128 printable ASCII characters without spaces', { stateChanged: false })
  }
  return { password: value.password }
}
/** A hex literal keeps the password out of quoting rules; unix_socket stays first so the agent keeps signing in as the OS root. */
const hex = (password: string): string => `X'${Buffer.from(password, 'utf8').toString('hex')}'`
export const rootPasswordSql = (password: string): string => `ALTER USER 'root'@'localhost' IDENTIFIED VIA unix_socket OR mysql_native_password USING PASSWORD(${hex(password)})`
/** The stored hash is compared inside the server; neither hash nor password is returned. */
export const rootPasswordMatchesSql = (password: string): string => `SELECT COUNT(*) FROM mysql.global_priv WHERE User = 'root' AND Host = 'localhost' AND INSTR(Priv, PASSWORD(${hex(password)})) > 0`
const optionValue = (password: string): string => '"' + password.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
export const renderRootClientFile = (password: string): string => `${ROOT_CLIENT_MARKER}\n[client]\nuser=root\npassword=${optionValue(password)}\n`
export const isManagedRootClientFile = (content: string | null): boolean => content === null || content.startsWith(ROOT_CLIENT_MARKER + '\n')

export interface RootPasswordHost {
  readFile(path: string): Promise<string | null>
  writeFile(file: { path: string; content: string; mode: number; owner: string; group: string }): Promise<unknown>
}
export interface RootPasswordOutcome { observedAt: string; serverPassword: 'verified'; clientFile: { path: string; state: 'written' | 'failed' }; socketAccess: 'verified' | 'unverified'; verificationRequired: boolean }
const one = (stdout: string): boolean | null => { try { const rows = parseMariadbBatch(stdout, 1); return rows.length === 1 && /^(?:0|1)$/.test(rows[0]![0]!) ? rows[0]![0] === '1' : null } catch { return null } }

export async function setMariadbRootPassword(client: MariadbAdminClient, host: RootPasswordHost, password: string, now: () => Date = () => new Date()): Promise<RootPasswordOutcome> {
  let existing: string | null
  try { existing = await host.readFile(ROOT_CLIENT_FILE) } catch { return fail('PRECONDITION_FAILED', 'the root client file could not be read; nothing was changed', { stateChanged: false, reason: 'root_client_file_unread' }) }
  if (!isManagedRootClientFile(existing)) return fail('PRECONDITION_FAILED', 'the root client file was not written by xPanel; nothing was changed', { stateChanged: false, reason: 'root_client_file_unmanaged' })
  // Errors are dropped on purpose: MariaDB quotes statement text, which holds the password, in syntax errors.
  try { await client.query([rootPasswordSql(password)]) } catch { return fail('SERVICE_UNAVAILABLE', 'the root password change was not confirmed', { stateChanged: true, unknownOutcome: true, verificationRequired: true }) }
  let matches: boolean | null = null
  try { matches = one(await client.query([rootPasswordMatchesSql(password)])) } catch { matches = null }
  if (matches !== true) return fail('SERVICE_UNAVAILABLE', 'the new root password could not be verified on the server', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  let clientFile: 'written' | 'failed' = 'written'
  try { await host.writeFile({ path: ROOT_CLIENT_FILE, content: renderRootClientFile(password), mode: 0o600, owner: 'root', group: 'root' }) } catch { clientFile = 'failed' }
  let socketAccess: 'verified' | 'unverified' = 'unverified'
  try { if (one(await client.query(['SELECT 1'])) === true) socketAccess = 'verified' } catch { socketAccess = 'unverified' }
  return { observedAt: now().toISOString(), serverPassword: 'verified', clientFile: { path: ROOT_CLIENT_FILE, state: clientFile }, socketAccess, verificationRequired: clientFile !== 'written' || socketAccess !== 'verified' }
}

export interface DbMaintenanceRouteContext {
  caller: AgentCallerIdentity
  reauthenticate: () => Promise<AgentCallerIdentity>
  assertRoot: (caller: AgentCallerIdentity, target: string) => Promise<void>
  audit: (entry: NewAuditEntry) => Promise<unknown>
  mariadb?: MariadbAdminClient
  host?: RootPasswordHost
  now?: () => Date
}
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const ROUTES: Readonly<Record<string, string>> = { '/host/databases/maintenance': 'host.databases.maintenance', '/host/databases/root-password': 'host.databases.root_password' }

export type RootClientFileState = 'absent' | 'managed' | 'unmanaged' | 'unreadable'
export async function readRootClientFileState(host: RootPasswordHost | undefined): Promise<RootClientFileState> {
  if (!host) return 'unreadable'
  try { const content = await host.readFile(ROOT_CLIENT_FILE); return content === null ? 'absent' : isManagedRootClientFile(content) ? 'managed' : 'unmanaged' } catch { return 'unreadable' }
}

const ACCOUNT_ROUTE = /^\/accounts\/([a-z][a-z0-9]{0,15})\/databases\/maintenance$/
export interface AccountDbMaintenanceContext {
  caller: AgentCallerIdentity
  store: { getAccountByUsername(username: string): Promise<Account | null>; listDatabases(accountId: string): Promise<readonly { name: string }[]> }
  assertAccount(caller: AgentCallerIdentity, account: Account, op: string): Promise<void>
  audit: (entry: NewAuditEntry) => Promise<unknown>
  mariadb?: MariadbAdminClient
  now?: () => Date
}
/** Owner, reseller or root: only databases saved on this account, through the same statements as WHM. */
export async function handleAccountDbMaintenanceRoute(req: Request, url: URL, method: string, ctx: AccountDbMaintenanceContext): Promise<Response | null> {
  const match = ACCOUNT_ROUTE.exec(url.pathname)
  if (!match) return null
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  const account = await ctx.store.getAccountByUsername(match[1]!) ?? fail('NOT_FOUND', 'account not found', { stateChanged: false })
  await ctx.assertAccount(ctx.caller, account, 'database.maintenance')
  const raw = await req.text()
  let body: unknown
  try { if (raw.length > 1024) throw new Error('too_large'); body = JSON.parse(raw) } catch { return fail('VALIDATION', 'the request is not bounded JSON', { stateChanged: false }) }
  const request = parseDbMaintenanceRequest(body)
  if (!(await ctx.store.listDatabases(account.id)).some(row => row.name === request.database)) return fail('NOT_FOUND', 'this database does not belong to the account', { stateChanged: false })
  if (!ctx.mariadb) return fail('PRECONDITION_FAILED', 'MariaDB administration is not connected on this host', { stateChanged: false })
  const actor = { actor: ctx.caller.actor, principalId: ctx.caller.principalId }, action = 'database.maintenance.' + request.action, target = 'database:' + request.database
  const report = await maintainMariadbDatabase(ctx.mariadb, request, ctx.now)
  const failed = report.tables.filter(table => table.result === 'failed' || table.result === 'corrupt').length
  await Promise.resolve(ctx.audit({ ...actor, action, target, detail: { tables: report.tables.length, failed }, outcome: failed ? 'failed' : 'ok' })).catch(() => undefined)
  return json(report)
}

export async function handleDbMaintenanceRoute(req: Request, url: URL, method: string, ctx: DbMaintenanceRouteContext): Promise<Response | null> {
  const target = ROUTES[url.pathname]
  if (!target) return null
  const read = method === 'GET' && url.pathname === '/host/databases/root-password'
  if (method !== 'POST' && !read) return new Response(null, { status: 405, headers: { allow: url.pathname === '/host/databases/root-password' ? 'GET, POST' : 'POST' } })
  await ctx.assertRoot(ctx.caller, target)
  if (url.search) return fail('VALIDATION', 'database maintenance does not accept request selectors', { stateChanged: false })
  // Never the file content: only whether the password change may write it.
  if (read) return json({ clientFile: { path: ROOT_CLIENT_FILE, state: await readRootClientFileState(ctx.host) }, mariadb: ctx.mariadb ? 'connected' : 'unavailable' })
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', { stateChanged: false })
  const raw = await req.text()
  let body: unknown
  try { if (raw.length > 1024) throw new Error('too_large'); body = JSON.parse(raw) } catch { return fail('VALIDATION', 'the request is not bounded JSON', { stateChanged: false }) }
  const root = url.pathname === '/host/databases/root-password'
  const request = root ? parseRootPasswordRequest(body) : parseDbMaintenanceRequest(body)
  if (!ctx.mariadb || root && !ctx.host) return fail('PRECONDITION_FAILED', 'MariaDB administration is not connected on this host', { stateChanged: false })
  if (root) await assertLocalDatabaseServer(ctx.mariadb)
  const fresh = await ctx.reauthenticate()
  await ctx.assertRoot(fresh, target)
  if (fresh.principalId !== ctx.caller.principalId) return fail('FORBIDDEN', 'database administration authority changed', { stateChanged: false })
  const actor = { actor: ctx.caller.actor, principalId: ctx.caller.principalId }
  const maintenance = request as { database: string; action: DbMaintenanceAction }
  const action = root ? 'host.databases.root_password' : 'host.databases.' + maintenance.action, auditTarget = root ? 'mariadb:root@localhost' : 'mariadb-database:' + maintenance.database
  try { await ctx.audit({ ...actor, action: action + '_requested', target: auditTarget, detail: {}, outcome: 'ok' }) }
  catch { return fail('PRECONDITION_FAILED', 'the request could not be audited before dispatch', { stateChanged: false }) }
  if (root) {
    const outcome = await setMariadbRootPassword(ctx.mariadb, ctx.host!, (request as { password: string }).password, ctx.now)
    await Promise.resolve(ctx.audit({ ...actor, action, target: auditTarget, detail: { clientFile: outcome.clientFile.state, socketAccess: outcome.socketAccess }, outcome: outcome.verificationRequired ? 'failed' : 'ok' })).catch(() => undefined)
    return json(outcome)
  }
  const report = await maintainMariadbDatabase(ctx.mariadb, maintenance, ctx.now)
  const failed = report.tables.filter(table => table.result === 'failed' || table.result === 'corrupt').length
  await Promise.resolve(ctx.audit({ ...actor, action, target: auditTarget, detail: { tables: report.tables.length, failed }, outcome: failed ? 'failed' : 'ok' })).catch(() => undefined)
  return json(report)
}
