import { randomBytes } from 'node:crypto'
import { assertDbNameOwned, dbGrantPattern, fail, isXpanelError, TWEAKS } from '@xpanel/core'
import type { Account, TweakValue } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import { parseDatabaseRemoteEntries } from '../../../packages/core/src/database-remote-access.ts'
import type { DatabaseRemoteAccessEntry } from '../../../packages/core/src/database-remote-access.ts'
import { assertPostgresqlPassword, postgresqlScramVerifier } from '../../../packages/state/src/pg-state.ts'
import { PG_PASS_FILE } from '../../agent/src/db-admin-tools.ts'
import type { AccessHostPushReport, AdoptedDatabaseUser, PgSuperuserOutcome } from '../../agent/src/db-admin-tools.ts'
import type { AuthenticatedCaller } from './auth.ts'
import { validateDbEngines } from './db-workspace.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { panelConfigFile, panelConfigRevision, readPanelConfigBody } from './panel-config-file.ts'
import { assertPasswordAllowed } from './password-policy.ts'
import { TWEAK_SETTINGS_NAMESPACE, tweakSettingsFile } from './tweak-settings-workspace.ts'
import { projectOverviewObservation } from './whm-databases-workspace.ts'

/** Root database tools: Database Map Tool, Additional MySQL Access Hosts, Tweak Settings: SQL and Configure PostgreSQL. */
export interface WhmDbToolsHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  store: StateStore
  callHost(caller: AuthenticatedCaller, path: string, body: unknown): Promise<unknown>
  readHost(caller: AuthenticatedCaller, path: string): Promise<unknown>
  triggerReconcile(caller: AuthenticatedCaller): Promise<{ ok: boolean; status: number; body: Record<string, unknown> } | null>
}
const unchanged = { stateChanged: false }
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const applied = (reconcile: { ok: boolean } | null): { status: 'applied' | 'not_requested' | 'failed' } => ({ status: reconcile === null ? 'not_requested' : reconcile.ok ? 'applied' : 'failed' })
const iso = (value: unknown): boolean => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
const nameList = (value: unknown, what: string): string[] => {
  if (!Array.isArray(value) || value.length > 100 || value.some(item => typeof item !== 'string' || item.length < 1 || item.length > 80) || new Set(value).size !== value.length) return fail('VALIDATION', `${what} must be a list of at most 100 distinct names`, unchanged)
  return value as string[]
}

export function validateAdoptedUsers(raw: unknown, names: readonly string[]): AdoptedDatabaseUser[] {
  const bad = (): never => fail('SERVICE_UNAVAILABLE', 'the database users could not be read', unchanged)
  if (!object(raw) || !exact(raw, ['users']) || !Array.isArray(raw.users) || raw.users.length !== names.length) return bad()
  raw.users.forEach((row, index) => {
    if (!object(row) || !exact(row, ['name', 'authPlugin', 'authString', 'grants']) || row.name !== names[index] || typeof row.authString !== 'string' || !['mysql_native_password', 'ed25519'].includes(String(row.authPlugin)) || !Array.isArray(row.grants)) bad()
    for (const grant of row.grants as unknown[]) if (!object(grant) || !exact(grant, ['pattern', 'privileges']) || typeof grant.pattern !== 'string' || !Array.isArray(grant.privileges)) bad()
  })
  return raw.users as AdoptedDatabaseUser[]
}

/** Only objects no account owns, seen on the server, inside the account's name prefix. Everything is checked before the first change. */
async function mapDatabases(request: Request, caller: AuthenticatedCaller, helpers: WhmDbToolsHelpers): Promise<Response> {
  const body = await readPanelConfigBody(request)
  if (!exact(body, ['account', 'databases', 'users'])) return fail('VALIDATION', 'exactly account, databases and users are required', unchanged)
  const databases = nameList(body.databases, 'databases'), users = nameList(body.users, 'users')
  if (databases.length + users.length === 0) return fail('VALIDATION', 'name at least one database or user', unchanged)
  const snapshot = await helpers.store.readSnapshot(), account = snapshot.accounts.find(row => row.username === body.account) ?? fail('NOT_FOUND', 'account not found', unchanged)
  if (account.status === 'terminating') return fail('PRECONDITION_FAILED', 'this account is being removed', unchanged)
  for (const name of databases) {
    if (snapshot.databases.some(row => row.name === name)) return fail('CONFLICT', 'this database already belongs to an account', { ...unchanged, reason: 'already_owned', name })
    assertDbNameOwned(account.username, name)
  }
  for (const name of users) {
    if (snapshot.databaseUsers.some(row => row.name === name)) return fail('CONFLICT', 'this database user already belongs to an account', { ...unchanged, reason: 'already_owned', name })
    assertDbNameOwned(account.username, name)
  }
  const observed = projectOverviewObservation(await helpers.readHost(caller, '/host/databases/overview'))
  if (!observed.schemas) return fail('PRECONDITION_FAILED', 'the databases on the server could not be read', unchanged)
  for (const name of databases) if (!observed.schemas.some(row => row.name === name)) return fail('NOT_FOUND', 'this database is not on the server', { ...unchanged, reason: 'database_not_observed', name })
  const adopted = users.length ? validateAdoptedUsers(await helpers.callHost(caller, '/host/databases/user-adoption', { username: account.username, users }), users) : []
  const owned = [...snapshot.databases.filter(row => row.accountId === account.id).map(row => row.name), ...databases], patterns = new Set(owned.map(name => dbGrantPattern(name)))
  // Reconciling a saved user removes grants it does not list, so a grant the map cannot keep refuses the whole request.
  for (const user of adopted) for (const grant of user.grants) if (!patterns.has(grant.pattern)) return fail('PRECONDITION_FAILED', 'this database user has grants outside the account', { ...unchanged, reason: 'database_user_grants_outside_account', name: user.name })
  const options = { authorize: async () => { await helpers.assertRoot(await helpers.requireCaller(request), 'server.databases.ownership') } }
  let changed = false
  try {
    const ids = new Map<string, string>()
    for (const row of snapshot.databases) if (row.accountId === account.id) ids.set(row.name, row.id)
    for (const name of databases) { ids.set(name, (await helpers.store.createDatabase({ accountId: account.id, name }, options)).id); changed = true }
    for (const user of adopted) {
      const saved = await helpers.store.createDatabaseUser({ accountId: account.id, name: user.name, authPlugin: user.authPlugin, authString: user.authString }, options)
      changed = true
      for (const grant of user.grants) await helpers.store.setGrant({ databaseUserId: saved.id, databaseId: ids.get(owned.find(name => dbGrantPattern(name) === grant.pattern)!)!, privileges: grant.privileges }, options)
    }
  } catch (error) {
    if (!changed) throw error
    return fail('SERVICE_UNAVAILABLE', 'part of the map was saved; review the account before retrying', { stateChanged: true, verificationRequired: true, reason: isXpanelError(error) ? error.code : 'map_incomplete' })
  }
  const reconcile = await helpers.triggerReconcile(caller)
  await Promise.resolve(helpers.emitAudit({ actor: caller.principal.username, action: 'server.databases.mapped', target: 'account:' + account.username, detail: { databases, users }, outcome: reconcile && !reconcile.ok ? 'failed' : 'ok', principalId: caller.principal.id })).catch(() => undefined)
  return json({ account: account.username, databases, users, application: applied(reconcile) })
}

const HOSTS_NAMESPACE = 'db-access-hosts:v1'
const accessHostsFile = (store: Pick<StateStore, 'rootDir' | 'getWriterLock'>) => panelConfigFile<{ hosts: DatabaseRemoteAccessEntry[] }>(store, 'db-access-hosts.json', HOSTS_NAMESPACE, raw => { try { return object(raw) && exact(raw, ['hosts']) ? { hosts: parseDatabaseRemoteEntries(raw.hosts) } : null } catch { return null } }, () => ({ hosts: [] }))
async function accessHosts(request: Request, method: string, caller: AuthenticatedCaller, helpers: WhmDbToolsHelpers): Promise<Response> {
  const file = accessHostsFile(helpers.store), view = async (extra: Record<string, unknown> = {}) => { const { raw, value } = await file.read(); return json({ revision: panelConfigRevision(HOSTS_NAMESPACE, raw), hosts: value?.hosts ?? [], ...extra }) }
  if (method === 'GET') return view()
  const body = await readPanelConfigBody(request)
  if (!exact(body, ['hosts', 'expectedRevision']) || typeof body.expectedRevision !== 'string' || !Array.isArray(body.hosts) || !body.hosts.every(row => object(row) && exact(row, ['host', 'comment']))) return fail('VALIDATION', 'exactly hosts and expectedRevision are required', unchanged)
  const known = new Map((await file.current()).hosts.map(row => [row.host, row.createdAt])), now = new Date().toISOString()
  const hosts = parseDatabaseRemoteEntries((body.hosts as { host: string; comment: string }[]).map(row => ({ ...row, createdAt: known.get(row.host) ?? now }))).sort((a, b) => a.host.localeCompare(b.host))
  await file.write({ hosts }, body.expectedRevision, async () => { await helpers.assertRoot(await helpers.requireCaller(request), 'server.databases.access_hosts') })
  await Promise.resolve(helpers.emitAudit({ actor: caller.principal.username, action: 'server.databases.access_hosts_updated', target: 'database:access-hosts', detail: { hosts: hosts.length }, outcome: 'ok', principalId: caller.principal.id })).catch(() => undefined)
  return view()
}
export function validatePushReport(raw: unknown): AccessHostPushReport {
  const bad = (): never => fail('SERVICE_UNAVAILABLE', 'the push result could not be verified', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  if (!object(raw) || !exact(raw, ['observedAt', 'accounts', 'pending']) || !iso(raw.observedAt) || !Array.isArray(raw.accounts) || !Array.isArray(raw.pending) || !raw.pending.every(row => typeof row === 'string')) return bad()
  for (const row of raw.accounts) if (!object(row) || !exact(row, ['account', 'state', 'added']) || typeof row.account !== 'string' || !['applied', 'unchanged', 'failed'].includes(String(row.state)) || !Array.isArray(row.added)) return bad()
  return raw as unknown as AccessHostPushReport
}
async function pushAccessHosts(caller: AuthenticatedCaller, helpers: WhmDbToolsHelpers): Promise<Response> {
  const hosts = (await accessHostsFile(helpers.store).current()).hosts
  if (hosts.length === 0) return fail('PRECONDITION_FAILED', 'save at least one access host before pushing', unchanged)
  const report = validatePushReport(await helpers.callHost(caller, '/host/databases/access-hosts/push', { hosts }))
  const failed = report.accounts.filter(row => row.state === 'failed').length
  await Promise.resolve(helpers.emitAudit({ actor: caller.principal.username, action: 'server.databases.access_hosts_pushed', target: 'database:access-hosts', detail: { accounts: report.accounts.length, failed, pending: report.pending.length }, outcome: failed || report.pending.length ? 'failed' : 'ok', principalId: caller.principal.id })).catch(() => undefined)
  return json(report)
}

const SQL_KEYS = ['sql.autotuneLimits', 'sql.innodbBufferPoolByRam'] as const
/** Keys outside this section are kept as saved. */
async function databaseSettings(request: Request, method: string, caller: AuthenticatedCaller, helpers: WhmDbToolsHelpers): Promise<Response> {
  const file = tweakSettingsFile(helpers.store)
  const view = (raw: unknown, values: Record<string, TweakValue> | null) => ({ revision: panelConfigRevision(TWEAK_SETTINGS_NAMESPACE, raw), state: values ? 'read' : 'invalid', autotuneLimits: values?.['sql.autotuneLimits'] ?? null, innodbBufferPoolByRam: values?.['sql.innodbBufferPoolByRam'] ?? null })
  if (method === 'GET') { const { raw, value } = await file.read(); return json(view(raw, value)) }
  const body = await readPanelConfigBody(request)
  if (!exact(body, ['autotuneLimits', 'innodbBufferPoolByRam', 'expectedRevision']) || typeof body.autotuneLimits !== 'boolean' || typeof body.innodbBufferPoolByRam !== 'boolean' || typeof body.expectedRevision !== 'string') return fail('VALIDATION', 'exactly autotuneLimits, innodbBufferPoolByRam and expectedRevision are required', unchanged)
  const { value: values } = await file.read()
  if (!values) return fail('PRECONDITION_FAILED', 'the saved Tweak Settings file requires review before it can be changed', unchanged)
  const next: Record<string, TweakValue> = { ...values, [SQL_KEYS[0]]: body.autotuneLimits, [SQL_KEYS[1]]: body.innodbBufferPoolByRam }
  const saved = await file.write(Object.fromEntries(TWEAKS.filter(row => next[row.key] !== row.default).map(row => [row.key, next[row.key]!])), body.expectedRevision,
    async () => { await helpers.assertRoot(await helpers.requireCaller(request), 'server.databases.settings') })
  const reconcile = await helpers.triggerReconcile(caller)
  await Promise.resolve(helpers.emitAudit({ actor: caller.principal.username, action: 'server.databases.settings_updated', target: 'mariadb:settings', detail: { autotuneLimits: body.autotuneLimits, innodbBufferPoolByRam: body.innodbBufferPoolByRam }, outcome: reconcile && !reconcile.ok ? 'failed' : 'ok', principalId: caller.principal.id })).catch(() => undefined)
  return json({ ...view(saved.raw, saved.value), application: applied(reconcile) })
}

/** xPanel names every role <username>_<suffix>, so the role cPanel names after the account is <username>_owner here. */
export const accountRoleName = (username: string): string => `${username}_owner`
const roleCandidates = async (store: StateStore, accounts: readonly Account[]): Promise<Account[]> => {
  const missing: Account[] = []
  for (const account of accounts) if (account.status !== 'terminating' && (await store.readAccountPostgresql(account.id)).users.length === 0) missing.push(account)
  return missing
}
async function postgresqlState(caller: AuthenticatedCaller, helpers: WhmDbToolsHelpers): Promise<Response> {
  const engines = validateDbEngines(await helpers.readHost(caller, '/host/databases/engines')), product = engines.products.postgresql
  const accounts = (await helpers.store.readSnapshot()).accounts, service = product.service !== 'unavailable' ? product.service : null
  return json({ installed: product.installed, running: service?.active === 'active', version: engines.postgresqlVersion, accounts: accounts.filter(row => row.status !== 'terminating').length, accountsWithoutRole: (await roleCandidates(helpers.store, accounts)).map(row => row.username), clientFile: PG_PASS_FILE })
}
async function createRoles(request: Request, caller: AuthenticatedCaller, helpers: WhmDbToolsHelpers): Promise<Response> {
  const engines = validateDbEngines(await helpers.readHost(caller, '/host/databases/engines')), product = engines.products.postgresql
  if (product.installed !== true || product.service === 'unavailable' || product.service?.active !== 'active') return fail('PRECONDITION_FAILED', 'PostgreSQL is not running on this server; nothing was changed', unchanged)
  const options = { authorize: async () => { await helpers.assertRoot(await helpers.requireCaller(request), 'server.databases.postgresql') } }
  const created: string[] = [], failed: string[] = []
  for (const account of await roleCandidates(helpers.store, (await helpers.store.readSnapshot()).accounts)) {
    // The password stays unknown until the owner sets one on the PostgreSQL page.
    const authString = postgresqlScramVerifier(randomBytes(24).toString('base64url'))
    try { await helpers.store.createPostgresqlUser({ accountId: account.id, name: accountRoleName(account.username), authString }, options); created.push(account.username) } catch { failed.push(account.username) }
  }
  const reconcile = created.length ? await helpers.triggerReconcile(caller) : null
  await Promise.resolve(helpers.emitAudit({ actor: caller.principal.username, action: 'server.databases.postgresql_roles_created', target: 'postgresql:roles', detail: { created: created.length, failed: failed.length }, outcome: failed.length || reconcile && !reconcile.ok ? 'failed' : 'ok', principalId: caller.principal.id })).catch(() => undefined)
  return json({ created, failed, application: applied(reconcile) })
}
export function validatePgOutcome(raw: unknown): PgSuperuserOutcome {
  const bad = (): never => fail('SERVICE_UNAVAILABLE', 'the superuser password outcome could not be verified', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  if (!object(raw) || !exact(raw, ['observedAt', 'serverPassword', 'clientFile', 'verificationRequired']) || !iso(raw.observedAt) || raw.serverPassword !== 'verified' || !object(raw.clientFile) || !exact(raw.clientFile, ['path', 'state']) || raw.clientFile.path !== PG_PASS_FILE
    || !['written', 'failed'].includes(String(raw.clientFile.state)) || raw.verificationRequired !== (raw.clientFile.state !== 'written')) return bad()
  return raw as unknown as PgSuperuserOutcome
}
async function superuserPassword(request: Request, caller: AuthenticatedCaller, helpers: WhmDbToolsHelpers): Promise<Response> {
  const body = await readPanelConfigBody(request, 1024)
  if (!exact(body, ['password'])) return fail('VALIDATION', 'exactly password is required', unchanged)
  const password = assertPasswordAllowed(assertPostgresqlPassword(body.password), 'database')
  await helpers.assertRoot(await helpers.requireCaller(request), 'server.databases.postgresql')
  return json(validatePgOutcome(await helpers.callHost(caller, '/host/databases/postgresql/superuser-password', { password })))
}

const ROUTES: Readonly<Record<string, { methods: readonly string[]; target: string }>> = {
  '/api/server/databases/ownership': { methods: ['POST'], target: 'server.databases.ownership' },
  '/api/server/databases/access-hosts': { methods: ['GET', 'PUT'], target: 'server.databases.access_hosts' },
  '/api/server/databases/access-hosts/push': { methods: ['POST'], target: 'server.databases.access_hosts' },
  '/api/server/databases/settings': { methods: ['GET', 'PUT'], target: 'server.databases.settings' },
  '/api/server/databases/postgresql': { methods: ['GET'], target: 'server.databases.postgresql' },
  '/api/server/databases/postgresql/roles': { methods: ['POST'], target: 'server.databases.postgresql' },
  '/api/server/databases/postgresql/superuser-password': { methods: ['POST'], target: 'server.databases.postgresql' },
}
export async function handleWhmDbToolsRoute(request: Request, url: URL, method: string, helpers: WhmDbToolsHelpers): Promise<Response | null> {
  const route = ROUTES[url.pathname]
  if (!route) return null
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, route.target)
  if (!route.methods.includes(method)) return new Response(null, { status: 405, headers: { allow: route.methods.join(', ') } })
  if (url.search) return fail('VALIDATION', 'database administration does not accept selectors', unchanged)
  switch (url.pathname) {
    case '/api/server/databases/ownership': return mapDatabases(request, caller, helpers)
    case '/api/server/databases/access-hosts': return accessHosts(request, method, caller, helpers)
    case '/api/server/databases/access-hosts/push': return pushAccessHosts(caller, helpers)
    case '/api/server/databases/settings': return databaseSettings(request, method, caller, helpers)
    case '/api/server/databases/postgresql': return postgresqlState(caller, helpers)
    case '/api/server/databases/postgresql/roles': return createRoles(request, caller, helpers)
    default: return superuserPassword(request, caller, helpers)
  }
}
