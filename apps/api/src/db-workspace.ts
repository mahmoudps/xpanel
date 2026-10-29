import { assertDbNameOwned, fail, isXpanelError, parseOwnerDatabaseStateRequest } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import type { DatabaseMutationOptions } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { authorizeAccountOwner, workspaceJson } from './account-ssh-workspace.ts'
import type { AccountSshPorts } from './account-ssh-workspace.ts'
import { assertPostgresqlPassword, assertPostgresqlRoleName, postgresqlScramVerifier } from '../../../packages/state/src/pg-state.ts'

/**
 * Database engine, web-client sign-on and MariaDB upgrade workspaces. Every agent reply is rebuilt from
 * validated fields only, so nothing the agent did not explicitly expose can reach the browser.
 */
/** The API's database mutation pipeline: fresh authority inside the state lock, configuration apply and audit. */
export type MutateDatabase = <T extends { name: string }>(req: Request, caller: AuthenticatedCaller, account: Account, action: string, targetKind: 'database' | 'database-user',
  operation: (options: DatabaseMutationOptions) => Promise<T>, toolId?: string) => Promise<{ value: T; application: { status: 'not_requested' | 'global_configuration_applied'; targetVerified: false } }>
export interface DbWorkspacePorts extends AccountSshPorts { assertRoot(caller: AuthenticatedCaller, action: string): Promise<void>; mutateDatabase?: MutateDatabase }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const exact = (v: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key))
const bad = (): never => { throw new Error('invalid_database_reply') }
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/u
const text = (v: unknown, max: number, min = 1): string => typeof v === 'string' && v.length >= min && v.length <= max && v.isWellFormed() && !UNSAFE.test(v) ? v : bad()
const nullable = <T>(v: unknown, read: (raw: unknown) => T): T | null => v === null ? null : read(v)
const count = (v: unknown, max = Number.MAX_SAFE_INTEGER): number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max ? v : bad()
const flag = (v: unknown): boolean => typeof v === 'boolean' ? v : bad()
const oneOf = <T extends string>(v: unknown, values: readonly T[]): T => (values as readonly unknown[]).includes(v) ? v as T : bad()
const stamp = (v: unknown): string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) ? v : bad()
const token = (v: unknown): string => typeof v === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(v) ? v : bad()
const list = <T>(v: unknown, max: number, item: (raw: unknown) => T): T[] => Array.isArray(v) && v.length <= max ? v.map(item) : bad()
const PRODUCTS = ['mariadb', 'postgresql', 'redis', 'mongodb', 'phpmyadmin', 'phppgadmin'] as const

const unit = (v: unknown) => object(v) && exact(v, ['unit', 'active', 'sub', 'enabled']) && /^[A-Za-z0-9@._-]{1,128}\.service$/.test(String(v.unit)) ? { unit: v.unit as string, active: token(v.active), sub: token(v.sub), enabled: token(v.enabled) } : bad()
const product = (v: unknown) => {
  if (!object(v) || !exact(v, ['installed', 'package', 'service'])) return bad()
  const installed = nullable(v.installed, flag), pkg = nullable(v.package, raw => object(raw) && exact(raw, ['name', 'version']) ? { name: text(raw.name, 128), version: text(raw.version, 256, 0) } : bad())
  const service = v.service === 'unavailable' ? 'unavailable' as const : nullable(v.service, unit)
  return installed === true && pkg || installed !== true && !pkg && (installed === false ? service === null : service === 'unavailable') ? { installed, package: pkg, service } : bad()
}
const configRead = <T>(v: unknown, facts: (raw: unknown) => T) => nullable(v, raw => {
  if (!object(raw) || !exact(raw, ['path', 'state', 'facts'])) return bad()
  const state = oneOf(raw.state, ['read', 'missing', 'unreadable', 'unsupported'] as const)
  return { path: nullable(raw.path, p => text(p, 255)), state, facts: state === 'read' ? facts(raw.facts) : raw.facts === null ? null : bad() }
})
const yesNo = (v: unknown) => nullable(v, raw => oneOf(raw, ['yes', 'no'] as const))
const redisFacts = (v: unknown) => object(v) && exact(v, ['port', 'bind', 'protectedMode', 'unixSocket', 'maxmemory', 'maxmemoryPolicy', 'requirePass', 'aclFile', 'appendOnly', 'includes'])
  ? { port: nullable(v.port, p => count(p, 65535)), bind: nullable(v.bind, b => list(b, 16, item => text(item, 45))), protectedMode: yesNo(v.protectedMode), unixSocket: nullable(v.unixSocket, s => text(s, 256)), maxmemory: nullable(v.maxmemory, m => text(m, 32)), maxmemoryPolicy: nullable(v.maxmemoryPolicy, m => text(m, 32)), requirePass: flag(v.requirePass), aclFile: flag(v.aclFile), appendOnly: yesNo(v.appendOnly), includes: count(v.includes, 10000) } : bad()
const mongoFacts = (v: unknown) => object(v) && exact(v, ['port', 'bindIp', 'authorization', 'dbPath'])
  ? { port: nullable(v.port, p => count(p, 65535)), bindIp: nullable(v.bindIp, b => text(b, 255)), authorization: nullable(v.authorization, a => oneOf(a, ['enabled', 'disabled'] as const)), dbPath: nullable(v.dbPath, d => text(d, 256)) } : bad()

export function validateDbEngines(raw: unknown) {
  if (!object(raw) || !exact(raw, ['observedAt', 'family', 'packages', 'products', 'redisConfig', 'mongodbConfig', 'postgresqlVersion']) || !object(raw.products) || !exact(raw.products, PRODUCTS)) return bad()
  const products = Object.fromEntries(PRODUCTS.map(id => [id, product((raw.products as Record<string, unknown>)[id])])) as Record<typeof PRODUCTS[number], ReturnType<typeof product>>
  const packages = oneOf(raw.packages, ['read', 'unavailable'] as const)
  if (packages === 'unavailable' && PRODUCTS.some(id => products[id].installed !== null)) return bad()
  return { observedAt: stamp(raw.observedAt), family: nullable(raw.family, f => oneOf(f, ['debian', 'rhel'] as const)), packages, products, redisConfig: configRead(raw.redisConfig, redisFacts), mongodbConfig: configRead(raw.mongodbConfig, mongoFacts), postgresqlVersion: nullable(raw.postgresqlVersion, v => text(v, 160)) }
}
const context = (raw: Record<string, unknown>, account: Account | null) => {
  if (!account) return raw.context === undefined ? {} : bad()
  return object(raw.context) && exact(raw.context, ['accountId', 'username']) && raw.context.accountId === account.id && raw.context.username === account.username ? { context: { accountId: account.id, username: account.username } } : bad()
}
const REASONS = ['packages-unread', 'package-missing', 'config-missing', 'config-invalid', 'bridge-missing', 'bridge-modified', 'phpmyadmin-config-missing', 'phpmyadmin-config-modified', 'ticket-directory-unsafe', 'database-admin-unavailable'] as const
export function validateDbWebClient(raw: unknown, account: Account | null, client: 'phpmyadmin' | 'phppgadmin') {
  const keys = client === 'phppgadmin' ? ['client', 'installed', 'signon', 'postgresql'] : ['client', 'installed', 'signon', 'databases', 'ticketSeconds', 'sessionSeconds', ...(account ? [] : ['phppgadmin'])]
  if (!object(raw) || !exact(raw, account ? [...keys, 'context'] : keys) || raw.client !== client || !object(raw.signon) || !exact(raw.signon, ['state', 'reason'])) return bad()
  const base = { ...context(raw, account), client, installed: nullable(raw.installed, flag) }
  if (client === 'phppgadmin') return raw.signon.state === 'unsupported' && raw.signon.reason === 'no-documented-signon' ? { ...base, signon: { state: 'unsupported' as const, reason: 'no-documented-signon' as const }, postgresql: nullable(raw.postgresql, flag) } : bad()
  const state = oneOf(raw.signon.state, ['ready', 'not-installed', 'not-configured', 'unavailable'] as const), reason = state === 'ready' ? (raw.signon.reason === null ? null : bad()) : oneOf(raw.signon.reason, REASONS)
  if (raw.ticketSeconds !== 60 || raw.sessionSeconds !== 1800) return bad()
  const databases = account ? count(raw.databases, 10000) : raw.databases === null ? null : bad()
  return { ...base, signon: { state, reason }, databases, ticketSeconds: 60, sessionSeconds: 1800, ...(account ? {} : { phppgadmin: nullable(raw.phppgadmin, flag) }) }
}
export function validateDbSignon(raw: unknown) {
  if (!object(raw) || !exact(raw, ['client', 'action', 'ticket', 'expiresAt', 'sessionExpiresAt']) || raw.client !== 'phpmyadmin' || typeof raw.ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(raw.ticket)) return bad()
  const action = new URL(text(raw.action, 512))
  if (action.protocol !== 'https:' || action.username || action.password || action.search || action.hash || action.href !== raw.action) return bad()
  const expiresAt = stamp(raw.expiresAt), sessionExpiresAt = stamp(raw.sessionExpiresAt)
  return Date.parse(sessionExpiresAt) > Date.parse(expiresAt) ? { client: 'phpmyadmin' as const, action: action.href, ticket: raw.ticket, expiresAt, sessionExpiresAt } : bad()
}
export function validateDbAccountPostgresql(raw: unknown, account: Account) {
  if (!object(raw) || !exact(raw, ['context', 'observedAt', 'version', 'databases', 'roles', 'provisioning', 'state'])) return bad()
  const state = oneOf(raw.state, ['read', 'not-installed', 'stopped', 'unavailable'] as const), owned = (name: string) => name === account.username || name.startsWith(account.username + '_') ? name : bad()
  const databases = list(raw.databases, 1000, row => object(row) && exact(row, ['name', 'owner', 'sizeBytes']) ? { name: owned(text(row.name, 63)), owner: text(row.owner, 63), sizeBytes: count(row.sizeBytes) } : bad())
  const roles = list(raw.roles, 1000, row => object(row) && exact(row, ['name', 'login']) ? { name: owned(text(row.name, 63)), login: flag(row.login) } : bad())
  if (state !== 'read' && (databases.length || roles.length) || raw.provisioning !== (state === 'read' ? 'available' : 'unavailable')) return bad()
  return { ...context(raw, account), observedAt: stamp(raw.observedAt), state, version: nullable(raw.version, v => text(v, 160)), databases, roles, provisioning: state === 'read' ? 'available' as const : 'unavailable' as const }
}
const pkg = (v: unknown) => object(v) && exact(v, ['name', 'current', 'candidate', 'origin', 'security', 'kernel', 'held', 'newInstall'])
  ? { name: text(v.name, 160), current: nullable(v.current, c => text(c, 256)), candidate: text(v.candidate, 256), origin: text(v.origin, 1024, 0), security: flag(v.security), kernel: flag(v.kernel), held: flag(v.held), newInstall: flag(v.newInstall) } : bad()
export function validateDbUpgrade(raw: unknown) {
  if (!object(raw) || !exact(raw, ['state', 'reason', 'observedAt', 'revision', 'family', 'installed', 'running', 'unit', 'packages', 'blocked', 'backupDirectory', 'canApply']) || raw.backupDirectory !== '/var/backups/xpanel/mariadb-upgrade') return bad()
  const state = oneOf(raw.state, ['read', 'unavailable'] as const), revision = nullable(raw.revision, r => typeof r === 'string' && /^[0-9a-f]{64}$/.test(r) ? r : bad())
  const view = {
    state, reason: nullable(raw.reason, r => oneOf(r, ['unsupported-host', 'not-installed', 'package-manager-unavailable', 'package-manager-busy', 'invalid-package-manager-output', 'admin-credentials-unsupported'] as const)), observedAt: stamp(raw.observedAt), revision,
    family: nullable(raw.family, f => oneOf(f, ['debian', 'rhel'] as const)), installed: nullable(raw.installed, i => object(i) && exact(i, ['name', 'version']) ? { name: text(i.name, 128), version: text(i.version, 256, 0) } : bad()),
    running: nullable(raw.running, r => text(r, 160)), unit: nullable(raw.unit, u => object(u) && exact(u, ['unit', 'active']) ? { unit: oneOf(u.unit, ['mariadb.service', 'mysql.service'] as const), active: token(u.active) } : bad()),
    packages: list(raw.packages, 500, pkg), blocked: list(raw.blocked, 500, b => text(b, 160)), backupDirectory: '/var/backups/xpanel/mariadb-upgrade' as const, canApply: flag(raw.canApply),
  }
  return (state === 'read') === (revision !== null) && (!view.canApply || state === 'read' && view.reason === null && view.packages.length > 0 && view.blocked.length === 0) ? view : bad()
}
const validateJob = (raw: unknown) => object(raw) && exact(raw, ['job']) && object(raw.job) && typeof raw.job.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(raw.job.id) && raw.job.kind === 'database.mariadb.upgrade'
  ? { job: { id: raw.job.id, kind: 'database.mariadb.upgrade' as const, referenceCode: nullable(raw.job.referenceCode ?? null, r => text(r, 64)), status: nullable(raw.job.status ?? null, s => oneOf(s, ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const)) } } : bad()

const readBody = async (req: Request, keys: readonly string[], max = 512): Promise<Record<string, unknown>> => {
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', { stateChanged: false })
  const raw = await req.text()
  let body: unknown
  try { body = raw.length <= max ? JSON.parse(raw) : null } catch { body = null }
  return object(body) && exact(body, keys) ? body : fail('VALIDATION', 'the request fields are not accepted', { stateChanged: false })
}
const ROOT: Readonly<Record<string, { agent: string; method: 'GET' | 'POST'; validate: (raw: unknown) => unknown; body?: readonly string[] }>> = {
  '/api/server/databases/engines': { agent: '/host/databases/engines', method: 'GET', validate: validateDbEngines },
  '/api/server/databases/web-clients': { agent: '/host/databases/web-clients', method: 'GET', validate: raw => validateDbWebClient(raw, null, 'phpmyadmin') },
  '/api/server/databases/web-clients/phpmyadmin/sign-on': { agent: '/host/databases/web-clients/phpmyadmin/sign-on', method: 'POST', validate: validateDbSignon, body: [] },
  '/api/server/databases/upgrade': { agent: '/host/databases/upgrade', method: 'GET', validate: validateDbUpgrade },
  '/api/server/databases/upgrade/apply': { agent: '/host/databases/upgrade/apply', method: 'POST', validate: validateJob, body: ['expectedRevision'] },
}
const ACCOUNT = /^\/api\/account\/database-engines\/(phpmyadmin|phppgadmin)(\/sign-on)?$/
const TOOLS = { phpmyadmin: 'phpmyadmin', phppgadmin: 'phppgadmin' } as const

/**
 * PostgreSQL databases and users of the signed-in owner. Saved state drives the reconciler (roles, databases owned by
 * their saved role, trash, suspension); deleting a user or a trashed database drops it on the server first and only
 * then removes it from state. Every change needs a running server, so an absent or stopped PostgreSQL changes nothing.
 */
const PG_ROUTE = /^\/api\/account\/database-engines\/postgresql(?:\/(users|databases)(?:\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/(password|trash|restore))?)?)?$/
const PG_TOOL = 'postgresql-databases', PG_LABEL = 'PostgreSQL databases'
type PgOwner = Awaited<ReturnType<typeof authorizeAccountOwner>>
const samePgOwner = (a: PgOwner, b: PgOwner): boolean => a.caller.principal.id === b.caller.principal.id && a.account.id === b.account.id && a.account.createdAt === b.account.createdAt

async function readPostgresqlHost(ports: DbWorkspacePorts, owner: PgOwner) {
  const raw = await ports.readAgent(owner.caller, `/accounts/${owner.account.username}/database-engines/postgresql`, undefined, false, 'GET')
  try { return validateDbAccountPostgresql(raw, owner.account) } catch { return fail('SERVICE_UNAVAILABLE', 'the protected database reply could not be verified', { stateChanged: false }) }
}

/** Server observation plus saved databases and users; the plan's database limit counts MariaDB and PostgreSQL together. */
async function readPostgresqlView(ports: DbWorkspacePorts, owner: PgOwner) {
  const host = await readPostgresqlHost(ports, owner)
  const saved = await ports.store.readAccountPostgresql(owner.account.id), mariadb = await ports.store.listDatabases(owner.account.id), plan = await ports.store.getPlan(owner.account.planId)
  if (!plan) return fail('NOT_FOUND', 'plan not found', { stateChanged: false })
  return { ...host, saved: {
    databases: saved.databases.map(row => ({ id: row.id, name: row.name, owner: row.owner ?? bad(), trashedAt: row.trashedAt })),
    users: saved.users.map(row => ({ id: row.id, name: row.name })),
    limit: { used: mariadb.length + saved.databases.filter(row => row.trashedAt === null).length, max: plan.caps.databases === 'unlimited' ? null : plan.caps.databases },
  } }
}

async function handlePostgresqlRoute(req: Request, url: URL, method: string, match: RegExpExecArray, ports: DbWorkspacePorts): Promise<Response | null> {
  const kind = match[1] as 'users' | 'databases' | undefined, id = match[2], verb = match[3] as 'password' | 'trash' | 'restore' | undefined
  const expected = !kind ? 'GET' : !id ? 'POST' : !verb ? 'DELETE' : (verb === 'password') === (kind === 'users') ? 'POST' : null
  if (!expected) return null
  if (method !== expected) return new Response(null, { status: 405, headers: { allow: expected } })
  if (url.search) return fail('VALIDATION', 'database workspaces do not accept selectors', { stateChanged: false })
  const first = await authorizeAccountOwner(ports, req, [PG_TOOL], PG_LABEL), { caller, account } = first, accountId = account.id
  if (!kind) {
    const view = await readPostgresqlView(ports, first)
    if (!samePgOwner(first, await authorizeAccountOwner(ports, req, [PG_TOOL], PG_LABEL))) return fail('FORBIDDEN', 'the current account binding changed', { stateChanged: false })
    return workspaceJson(view)
  }
  const body = await readBody(req, !id ? (kind === 'users' ? ['name', 'password'] : ['name', 'owner']) : verb === 'password' ? ['password'] : verb ? ['expectedTrashedAt', 'confirmation'] : ['confirmation'], 2048)
  const name = !id ? (kind === 'users' ? assertPostgresqlRoleName(account.username, body.name) : assertDbNameOwned(account.username, body.name)) : null
  const owner = !id && kind === 'databases' ? assertPostgresqlRoleName(account.username, body.owner) : null
  // The password stops here: only its SCRAM-SHA-256 verifier is saved and sent to the server.
  const authString = kind === 'users' && (!id || verb === 'password') ? postgresqlScramVerifier(assertPostgresqlPassword(body.password)) : null
  const stateGuard = verb === 'trash' || verb === 'restore' ? parseOwnerDatabaseStateRequest(body, verb) : undefined
  const mutate = ports.mutateDatabase ?? fail('SERVICE_UNAVAILABLE', 'PostgreSQL changes are unavailable here', { stateChanged: false })
  if ((await readPostgresqlHost(ports, first)).provisioning !== 'available') return fail('PRECONDITION_FAILED', 'PostgreSQL is not running on this server; nothing was changed', { stateChanged: false })
  const saved = await ports.store.readAccountPostgresql(accountId)
  const existing = id ? (kind === 'users' ? saved.users : saved.databases).find(row => row.id === id) ?? fail('NOT_FOUND', kind === 'users' ? 'PostgreSQL user not found' : 'PostgreSQL database not found', { stateChanged: false }) : null
  if (existing && !verb && body.confirmation !== existing.name) return fail('VALIDATION', 'confirm the exact name', { stateChanged: false })
  // Once the server may have changed, onMutationStarted makes any later failure a change that needs verification.
  const drop = async (options: DatabaseMutationOptions): Promise<void> => {
    let raw: unknown
    try { raw = await ports.readAgent(caller, `/accounts/${account.username}/database-engines/postgresql/${kind}/${id}/drop`, {}, true, 'POST') }
    catch (error) { if (!isXpanelError(error) || error.detail.stateChanged !== false) options.onMutationStarted?.(); throw error }
    options.onMutationStarted?.()
    if (!object(raw) || !exact(raw, ['context', 'kind', 'name', 'dropped']) || !object(raw.context) || raw.context.accountId !== accountId || raw.kind !== (kind === 'users' ? 'user' : 'database') || raw.name !== existing!.name || raw.dropped !== true) {
      return fail('SERVICE_UNAVAILABLE', 'the PostgreSQL deletion could not be verified', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
    }
  }
  const run = <T extends { name: string }>(action: string, target: 'database' | 'database-user', operation: (options: DatabaseMutationOptions) => Promise<T>) => mutate(req, caller, account, action, target, operation, PG_TOOL)
  const result = kind === 'users'
    ? !id ? await run('database_user.postgresql.created', 'database-user', options => ports.store.createPostgresqlUser({ accountId, name: name!, authString: authString! }, options))
      : verb ? await run('database_user.postgresql.password_changed', 'database-user', options => ports.store.setPostgresqlUserPassword({ accountId, id, authString: authString! }, options))
        : await run('database_user.postgresql.deleted', 'database-user', async options => { await drop(options); return ports.store.deletePostgresqlUser({ accountId, id }, options) })
    : !id ? await run('database.postgresql.created', 'database', options => ports.store.createPostgresqlDatabase({ accountId, name: name!, owner: owner! }, options))
      : verb ? await run(verb === 'trash' ? 'database.postgresql.trashed' : 'database.postgresql.restored', 'database', options => ports.store.setPostgresqlDatabaseTrash({ accountId, id, action: verb as 'trash' | 'restore' }, { ...options, stateGuard: stateGuard! }))
        : await run('database.postgresql.purged', 'database', async options => { await drop(options); return ports.store.purgePostgresqlDatabase({ accountId, id }, options) })
  return workspaceJson({ stateChanged: true, kind: kind === 'users' ? 'user' : 'database', name: result.value.name, application: result.application }, id ? 200 : 201)
}

export async function handleDbWorkspaceRoute(req: Request, url: URL, method: string, ports: DbWorkspacePorts): Promise<Response | null> {
  const postgresql = PG_ROUTE.exec(url.pathname)
  if (postgresql) return handlePostgresqlRoute(req, url, method, postgresql, ports)
  const root = ROOT[url.pathname], account = ACCOUNT.exec(url.pathname)
  if (!root && (!account || account[2] && account[1] !== 'phpmyadmin')) return null
  const expected = root?.method ?? (account![2] ? 'POST' : 'GET'), mutation = expected === 'POST'
  if (method !== expected) return new Response(null, { status: 405, headers: { allow: expected } })
  if (url.search) return fail('VALIDATION', 'database workspaces do not accept selectors', { stateChanged: false })
  if (root) {
    const caller = await ports.requireCaller(req)
    await ports.assertRoot(caller, 'database.workspace')
    const body = root.body ? await readBody(req, root.body) : undefined
    if (body && 'expectedRevision' in body && (typeof body.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedRevision))) return fail('VALIDATION', 'expectedRevision must be the observed revision', { stateChanged: false })
    const raw = await ports.readAgent(caller, root.agent, body, mutation, root.method)
    try { await ports.assertRoot(await ports.requireCaller(req), 'database.workspace') }
    catch (error) { if (mutation) return fail('SERVICE_UNAVAILABLE', 'the database change requires administrator review', { stateChanged: true, unknownOutcome: true, verificationRequired: true }); throw error }
    try { return workspaceJson(root.validate(raw), url.pathname.endsWith('/upgrade/apply') ? 202 : 200) }
    catch { return fail('SERVICE_UNAVAILABLE', 'the protected database reply could not be verified', { stateChanged: mutation, verificationRequired: true, ...(mutation ? { unknownOutcome: true } : {}) }) }
  }
  const client = account![1] as keyof typeof TOOLS, label = client === 'phpmyadmin' ? 'phpMyAdmin' : 'phpPgAdmin'
  const first = await authorizeAccountOwner(ports, req, [TOOLS[client]], label)
  const body = mutation ? await readBody(req, []) : undefined
  const fresh = await authorizeAccountOwner(ports, req, [TOOLS[client]], label)
  if (fresh.caller.principal.id !== first.caller.principal.id || fresh.account.id !== first.account.id || fresh.account.createdAt !== first.account.createdAt) return fail('CONFLICT', 'the account binding changed; reload before retrying', { stateChanged: false })
  const raw = await ports.readAgent(fresh.caller, `/accounts/${fresh.account.username}/database-engines/${client}${mutation ? '/sign-on' : ''}`, body, mutation, expected)
  try {
    const after = await authorizeAccountOwner(ports, req, [TOOLS[client]], label)
    if (after.caller.principal.id !== fresh.caller.principal.id || after.account.id !== fresh.account.id) return fail('FORBIDDEN', 'the current account binding changed', { stateChanged: false })
  } catch (error) {
    // The issued ticket is withheld from a caller who lost authority; its session user expires on its own.
    if (mutation) return fail('FORBIDDEN', 'the account binding changed; the sign-on was withheld', { stateChanged: false })
    throw error
  }
  try { return workspaceJson(mutation ? validateDbSignon(raw) : validateDbWebClient(raw, fresh.account, client)) }
  catch { return fail('SERVICE_UNAVAILABLE', 'the protected database reply could not be verified', { stateChanged: false, verificationRequired: mutation }) }
}
