import { fail } from '@xpanel/core'
import type { Account, HostAction } from '@xpanel/core'
import type { NewAuditEntry } from '@xpanel/db'
import { services } from '@xpanel/render'
import { assertPostgresqlPassword, postgresqlScramVerifier } from '../../../packages/state/src/pg-state.ts'
import { applyDatabaseRemoteAccessRequest, databaseRemoteAccessRevision, parseDatabaseRemoteEntries } from './database-remote-access.ts'
import type { DatabaseRemoteAccessNative, DatabaseRemoteAccessStore } from './database-remote-access.ts'
import { parseMariadbBatch } from './mariadb-admin.ts'
import type { MariadbAdminClient } from './mariadb-admin.ts'
import type { RootPasswordHost } from './db-maintenance.ts'
import { parseShowGrantLine } from './services/mariadb.ts'
import type { AgentCallerIdentity } from './server.ts'

/**
 * Root database tools beside db-maintenance.ts: the account map's reading of server-only users (Database Map Tool),
 * the push of Additional MySQL Access Hosts to every account, and the PostgreSQL superuser password.
 */
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))

export interface AdoptedDatabaseUser { name: string; authPlugin: 'mysql_native_password' | 'ed25519'; authString: string; grants: { pattern: string; privileges: string[] }[] }
export const mariadbUserAuthSql = (name: string): string => `SELECT plugin, authentication_string FROM mysql.user WHERE User = ${services.quoteString(name)} AND Host = 'localhost'`
/** The stored hash goes to the saved user, as cPanel's map keeps it; it reaches no browser, log or audit record. */
export async function readAdoptableUser(client: MariadbAdminClient, username: string, name: string): Promise<AdoptedDatabaseUser> {
  const user = services.assertDbUser(name, username)
  const rows = parseMariadbBatch(await client.query([mariadbUserAuthSql(user)]), 2)
  if (rows.length !== 1) return fail('NOT_FOUND', 'this database user is not on the server', { stateChanged: false, reason: 'database_user_not_observed' })
  const [plugin, authString] = rows[0] as [string, string]
  if (plugin !== 'mysql_native_password' && plugin !== 'ed25519' || !authString) return fail('PRECONDITION_FAILED', 'this database user signs in with an authentication method xPanel does not save', { stateChanged: false, reason: 'database_user_auth_unsupported' })
  const grants = parseMariadbBatch(await client.query([`SHOW GRANTS FOR ${services.quoteString(user)}@'localhost'`]), 1).flatMap(([line]) => {
    const grant = parseShowGrantLine(line!)
    if (!grant) return []
    // The saved model holds database grants only; reconciling a user with more would revoke what it has today.
    if (grant.kind !== 'database' || grant.databasePattern === null) return fail('PRECONDITION_FAILED', 'this database user has grants xPanel does not save', { stateChanged: false, reason: 'database_user_grants_unsupported' })
    return [{ pattern: grant.databasePattern, privileges: [...grant.privileges] }]
  })
  return { name: user, authPlugin: plugin, authString, grants }
}

export const PG_PASS_FILE = '/root/.pgpass'
const PG_PASS_MARKER = '# managed by xPanel: PostgreSQL superuser password'
// libpq-pgpass: backslash escapes ":" and "\" in a field.
export const renderPgPass = (password: string): string => `${PG_PASS_MARKER}\n*:*:*:postgres:${password.replace(/\\/g, '\\\\').replace(/:/g, '\\:')}\n`
const literal = (text: string): string => `'${text.replaceAll("'", "''")}'`
export const pgSuperuserPasswordSql = (verifier: string): string[] => [`ALTER ROLE "postgres" WITH PASSWORD ${literal(verifier)};`]
/** ON_ERROR_STOP turns a mismatch into a failed script: the division fails on zero matching rows and no value is printed. */
export const pgSuperuserVerifySql = (verifier: string): string[] => [`SELECT 1 / COUNT(*)::int FROM pg_catalog.pg_authid WHERE rolname = 'postgres' AND rolpassword = ${literal(verifier)};`]
export interface PgSuperuserOutcome { observedAt: string; serverPassword: 'verified'; clientFile: { path: string; state: 'written' | 'failed' }; verificationRequired: boolean }

export async function setPostgresqlSuperuserPassword(run: (action: HostAction) => Promise<void>, host: RootPasswordHost, password: string, now: () => Date): Promise<PgSuperuserOutcome> {
  let existing: string | null
  try { existing = await host.readFile(PG_PASS_FILE) } catch { return fail('PRECONDITION_FAILED', 'the root password file could not be read; nothing was changed', { stateChanged: false, reason: 'pgpass_file_unread' }) }
  if (existing !== null && !existing.startsWith(PG_PASS_MARKER + '\n')) return fail('PRECONDITION_FAILED', 'the root password file was not written by xPanel; nothing was changed', { stateChanged: false, reason: 'pgpass_file_unmanaged' })
  const verifier = postgresqlScramVerifier(password)
  try { await run({ kind: 'sql', engine: 'postgresql', statements: pgSuperuserPasswordSql(verifier) }) } catch { return fail('SERVICE_UNAVAILABLE', 'the superuser password change was not confirmed', { stateChanged: true, unknownOutcome: true, verificationRequired: true }) }
  try { await run({ kind: 'sql', engine: 'postgresql', statements: pgSuperuserVerifySql(verifier) }) } catch { return fail('SERVICE_UNAVAILABLE', 'the new superuser password could not be verified on the server', { stateChanged: true, unknownOutcome: true, verificationRequired: true }) }
  let state: 'written' | 'failed' = 'written'
  try { await host.writeFile({ path: PG_PASS_FILE, content: renderPgPass(password), mode: 0o600, owner: 'root', group: 'root' }) } catch { state = 'failed' }
  return { observedAt: now().toISOString(), serverPassword: 'verified', clientFile: { path: PG_PASS_FILE, state }, verificationRequired: state !== 'written' }
}

export interface AccessHostPushRow { account: string; state: 'applied' | 'unchanged' | 'failed'; added: string[] }
export interface AccessHostPushReport { observedAt: string; accounts: AccessHostPushRow[]; pending: string[] }
export interface AccessHostPushDeps {
  store: DatabaseRemoteAccessStore & { listAccounts(): Promise<readonly Account[]> }
  native: DatabaseRemoteAccessNative
  authorize: () => Promise<void>
  audit: (account: Account, action: string, host: string) => Promise<void>
  now?: () => Date
}
const PUSH_BUDGET_MS = 240_000
/** Account by account, through the owner path's lease, recovery and verification. Accounts past the budget stay pending, truthfully. */
export async function pushDatabaseAccessHosts(deps: AccessHostPushDeps, hosts: readonly { host: string; comment: string }[]): Promise<AccessHostPushReport> {
  const started = Date.now(), now = deps.now ?? (() => new Date()), accounts: AccessHostPushRow[] = [], pending: string[] = []
  for (const account of await deps.store.listAccounts()) {
    if (account.status !== 'active') continue
    if (Date.now() - started > PUSH_BUDGET_MS) { pending.push(account.username); continue }
    const added: string[] = []
    let state: AccessHostPushRow['state'] = 'unchanged'
    for (const { host, comment } of hosts) {
      try {
        const snapshot = await deps.store.readDatabaseRemoteAccess(account.id)
        if (parseDatabaseRemoteEntries(snapshot.account.databaseRemoteAccess ?? []).some(row => row.host === host)) continue
        await deps.authorize()
        await applyDatabaseRemoteAccessRequest({ store: deps.store, native: deps.native, authorize: deps.authorize, audit: deps.audit, ...(deps.now ? { now: deps.now } : {}) }, account, { action: 'add', expectedRevision: databaseRemoteAccessRevision(snapshot), host, comment })
        added.push(host); state = 'applied'
      } catch { state = 'failed'; break }
    }
    accounts.push({ account: account.username, state, added })
  }
  return { observedAt: now().toISOString(), accounts, pending }
}

const ROUTES = ['/host/databases/user-adoption', '/host/databases/access-hosts/push', '/host/databases/postgresql/superuser-password']
export interface DbAdminToolsContext {
  caller: AgentCallerIdentity
  reauthenticate: () => Promise<AgentCallerIdentity>
  assertRoot: (caller: AgentCallerIdentity, target: string) => Promise<void>
  audit: (entry: NewAuditEntry) => Promise<unknown>
  mariadb?: MariadbAdminClient
  host?: RootPasswordHost
  runAction?: (action: HostAction) => Promise<void>
  store: AccessHostPushDeps['store']
  native?: DatabaseRemoteAccessNative
  now?: () => Date
}
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

export async function handleDbAdminToolsRoute(req: Request, url: URL, method: string, ctx: DbAdminToolsContext): Promise<Response | null> {
  if (!ROUTES.includes(url.pathname)) return null
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  const target = 'host.databases.' + url.pathname.slice('/host/databases/'.length).replaceAll('/', '.')
  await ctx.assertRoot(ctx.caller, target)
  if (url.search) return fail('VALIDATION', 'database administration does not accept request selectors', { stateChanged: false })
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', { stateChanged: false })
  const raw = await req.text()
  let body: unknown
  try { if (raw.length > 32768) throw new Error('too_large'); body = JSON.parse(raw) } catch { return fail('VALIDATION', 'the request is not bounded JSON', { stateChanged: false }) }
  const authorize = async (): Promise<void> => {
    const fresh = await ctx.reauthenticate()
    await ctx.assertRoot(fresh, target)
    if (fresh.principalId !== ctx.caller.principalId) return fail('FORBIDDEN', 'database administration authority changed', { stateChanged: false })
  }
  await authorize()
  const now = ctx.now ?? (() => new Date()), actor = { actor: ctx.caller.actor, principalId: ctx.caller.principalId }
  if (url.pathname === '/host/databases/user-adoption') {
    if (!object(body) || !exact(body, ['username', 'users']) || typeof body.username !== 'string' || !Array.isArray(body.users) || body.users.length > 100) return fail('VALIDATION', 'exactly username and users are required', { stateChanged: false })
    if (!ctx.mariadb) return fail('PRECONDITION_FAILED', 'MariaDB administration is not connected on this host', { stateChanged: false })
    const users: AdoptedDatabaseUser[] = []
    for (const name of body.users) users.push(await readAdoptableUser(ctx.mariadb, body.username, name))
    return json({ users })
  }
  if (url.pathname === '/host/databases/access-hosts/push') {
    if (!object(body) || !exact(body, ['hosts']) || !Array.isArray(body.hosts) || body.hosts.length === 0 || body.hosts.length > 100) return fail('VALIDATION', 'between 1 and 100 hosts are required', { stateChanged: false })
    const hosts = parseDatabaseRemoteEntries(body.hosts).map(({ host, comment }) => ({ host, comment }))
    if (!ctx.native) return fail('PRECONDITION_FAILED', 'qualified SQL and firewall recovery is unavailable; no remote host was changed', { stateChanged: false })
    const report = await pushDatabaseAccessHosts({ store: ctx.store, native: ctx.native, authorize, audit: async (account, action, host) => { await ctx.audit({ ...actor, action: 'database.remote_access.' + action, target: 'account:' + account.username, detail: { host, source: 'access-hosts-push' }, outcome: 'ok' }) }, ...(ctx.now ? { now: ctx.now } : {}) }, hosts)
    return json(report)
  }
  if (!object(body) || !exact(body, ['password'])) return fail('VALIDATION', 'exactly password is required', { stateChanged: false })
  const password = assertPostgresqlPassword(body.password)
  if (!ctx.runAction || !ctx.host) return fail('PRECONDITION_FAILED', 'PostgreSQL administration is not connected on this host', { stateChanged: false })
  try { await ctx.audit({ ...actor, action: 'host.databases.postgresql_password_requested', target: 'postgresql:postgres', detail: {}, outcome: 'ok' }) }
  catch { return fail('PRECONDITION_FAILED', 'the request could not be audited before dispatch', { stateChanged: false }) }
  const outcome = await setPostgresqlSuperuserPassword(ctx.runAction, ctx.host, password, now)
  await Promise.resolve(ctx.audit({ ...actor, action: 'host.databases.postgresql_password', target: 'postgresql:postgres', detail: { clientFile: outcome.clientFile.state }, outcome: outcome.verificationRequired ? 'failed' : 'ok' })).catch(() => undefined)
  return json(outcome)
}
