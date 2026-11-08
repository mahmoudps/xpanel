import { fail } from '@xpanel/core'
import type { Account, Id } from '@xpanel/core'
import type { DatabaseMutationOptions, StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import type { MutateDatabase } from './db-workspace.ts'

const ROUTE = /^\/api\/databases\/([0-9a-f-]{36})\/(dump|import|rename)$/i
const PASSWORD_ROUTE = /^\/api\/databases\/users\/([0-9a-f-]{36})\/password$/i
const unchanged = { stateChanged: false }
const review = { stateChanged: true, verificationRequired: true, unknownOutcome: true }

export interface DatabaseTransferPorts {
  store: Pick<StateStore, 'getDatabase' | 'getDatabaseUser' | 'getAccount' | 'renameDatabase' | 'setDatabaseUserAuth'>
  requireCaller(request: Request): Promise<AuthenticatedCaller>
  assertCanAccessAccount(caller: AuthenticatedCaller, account: Account, action: string): Promise<void>
  callAgent(path: string, options: { caller: AuthenticatedCaller; method?: string; body?: unknown }): Promise<Response>
  mutateDatabase: MutateDatabase
  emitAudit(entry: Record<string, unknown>, scope: { accountId: Id; resellerId: Id | null }): Promise<unknown>
  reconcile(caller: AuthenticatedCaller, account: Account): Promise<unknown>
  ownedName(username: string, raw: unknown): string
  /** The index is rebuildable, and a rename changes the name it holds. */
  reindex(): Promise<void>
  passwordHash(password: string): string
  assertPassword(password: unknown): asserts password is string
}
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const bodyOf = async (request: Request, keys: readonly string[]): Promise<Record<string, unknown>> => {
  const value = await request.json().catch(() => null) as Record<string, unknown> | null
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) return fail('VALIDATION', `exactly ${keys.join(', ')} are required`, unchanged)
  return value
}

/** Export, import and rename of one MariaDB database, and a new password for one of its users. */
export async function handleDatabaseTransferRoute(request: Request, url: URL, method: string, ports: DatabaseTransferPorts): Promise<Response | null> {
  const passwordMatch = PASSWORD_ROUTE.exec(url.pathname)
  if (passwordMatch) {
    if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
    const caller = await ports.requireCaller(request)
    const user = await ports.store.getDatabaseUser(passwordMatch[1]!.toLowerCase())
    const account = user ? await ports.store.getAccount(user.accountId) : null
    if (!user || !account) return fail('NOT_FOUND', 'database user not found', unchanged)
    await ports.assertCanAccessAccount(caller, account, 'database_user.password')
    const { password } = await bodyOf(request, ['password'])
    ports.assertPassword(password)
    await ports.store.setDatabaseUserAuth(user.id, ports.passwordHash(password), 'mysql_native_password')
    const reconcile = await ports.reconcile(caller, account)
    await ports.emitAudit({ actor: caller.principal.username, action: 'database_user.password_changed', target: `database-user:${user.name}`, outcome: 'ok', principalId: caller.principal.id }, { accountId: account.id, resellerId: account.ownerId })
    return json({ changed: true, stateChanged: true, reconcile })
  }
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  const action = match[2] as 'dump' | 'import' | 'rename'
  if (method !== (action === 'dump' ? 'GET' : 'POST')) return new Response(null, { status: 405, headers: { allow: action === 'dump' ? 'GET' : 'POST' } })
  const caller = await ports.requireCaller(request)
  const database = await ports.store.getDatabase(match[1]!.toLowerCase())
  const account = database ? await ports.store.getAccount(database.accountId) : null
  if (!database || !account) return fail('NOT_FOUND', 'database not found', unchanged)
  await ports.assertCanAccessAccount(caller, account, 'database.' + action)
  if (database.engine !== 'mariadb' || database.trashedAt !== null) return fail('PRECONDITION_FAILED', 'only an active MariaDB database can do this', unchanged)
  const host = `/accounts/${account.username}/databases/${database.name}/`, scope = { accountId: account.id, resellerId: account.ownerId }
  const audit = (entry: { action: string; detail?: Record<string, unknown> }) => ports.emitAudit({ actor: caller.principal.username, target: `database:${database.name}`, outcome: 'ok', principalId: caller.principal.id, ...entry }, scope)

  if (action === 'dump') {
    const response = await ports.callAgent(host + 'dump', { caller })
    if (response.ok) await audit({ action: 'database.exported' })
    return response
  }
  if (action === 'import') {
    const { path } = await bodyOf(request, ['path'])
    const response = await ports.callAgent(host + 'import', { caller, method: 'POST', body: { path } })
    if (response.ok) await audit({ action: 'database.imported', detail: { path } })
    return response
  }
  const { name } = await bodyOf(request, ['name'])
  const to = ports.ownedName(account.username, name)
  // The copy comes first: a failed copy leaves the old database and its record as they were.
  const copied = await ports.callAgent(host + 'copy', { caller, method: 'POST', body: { to } })
  if (!copied.ok) return copied
  let renamed
  try { renamed = await ports.mutateDatabase(request, caller, account, 'database.renamed', 'database', (options: DatabaseMutationOptions) => ports.store.renameDatabase(database.id, to, options)) }
  catch (error) {
    await ports.callAgent(`/accounts/${account.username}/databases/${to}/drop`, { caller, method: 'POST', body: { name: to } }).catch(() => null)
    throw error
  }
  await ports.reindex()
  const dropped = await ports.callAgent(host + 'drop', { caller, method: 'POST', body: { name: database.name } })
  if (!dropped.ok) return fail('SERVICE_UNAVAILABLE', 'the database was renamed, but its old copy could not be removed', review)
  return json({ database: renamed.value, application: renamed.application, stateChanged: true })
}
