import { fail, isXpanelError } from '@xpanel/core'
import type { Account, Database, FeatureList, Plan } from '@xpanel/core'
import { SOFTWARE_CENTER_DPKG_LIST_ARGV, softwareCenterArgv } from '../../../packages/os/src/software-center-command.ts'
import { serviceManagerShow } from '../../../packages/os/src/service-manager-command.ts'
import { DB_PG_MAX_ROWS, PG_VERSION_SQL, pgAccountDatabasesSql, pgAccountRolesSql, postgresqlQueryArgv } from '../../../packages/os/src/db-engines-command.ts'
import type { DatabaseRemoteAccessSnapshot } from '../../../packages/core/src/database-remote-access.ts'
import { parseDpkgPackages, parseRpmPackages } from './software-center.ts'
import type { AgentCallerIdentity } from './server.ts'
import { pgDropDatabaseStatements, pgDropRoleStatements } from './pg-sql.ts'
import type { PostgresqlUser } from '../../../packages/state/src/pg-state.ts'

export type DbFamily = 'debian' | 'rhel'
export type DbRun = (argv: readonly string[]) => Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string }>
/** Returns null for a missing file; throws for any other read failure. */
export type DbReadFile = (path: string) => Promise<string | null>
export type DbProductId = 'mariadb' | 'postgresql' | 'redis' | 'mongodb' | 'phpmyadmin' | 'phppgadmin'
export interface DbUnitFact { unit: string; active: string; sub: string; enabled: string }
export interface DbProductFact { installed: boolean | null; package: { name: string; version: string } | null; service: DbUnitFact | null | 'unavailable' }
export interface DbPackagesObservation { state: 'read' | 'unavailable'; products: Record<DbProductId, DbProductFact> }

const SPECS: Readonly<Record<DbProductId, { debian: RegExp; rhel: readonly string[]; units: (name: string, family: DbFamily) => readonly string[] }>> = {
  mariadb: { debian: /^mariadb-server$/, rhel: ['mariadb-server'], units: () => ['mariadb.service', 'mysql.service'] },
  // Debian runs each cluster as postgresql@<major>-main; postgresql.service there is only an umbrella oneshot.
  postgresql: { debian: /^postgresql-[0-9]{2}$/, rhel: ['postgresql-server'], units: (name, family) => family === 'debian' ? [`postgresql@${name.slice(11)}-main.service`] : ['postgresql.service'] },
  redis: { debian: /^(?:redis-server|valkey-server)$/, rhel: ['redis', 'valkey'], units: name => name.startsWith('valkey') ? ['valkey-server.service', 'valkey.service'] : ['redis-server.service', 'redis.service'] },
  mongodb: { debian: /^mongodb-org-server$/, rhel: ['mongodb-org-server'], units: () => ['mongod.service'] },
  phpmyadmin: { debian: /^phpmyadmin$/, rhel: ['phpMyAdmin'], units: () => [] },
  phppgadmin: { debian: /^phppgadmin$/, rhel: ['phpPgAdmin'], units: () => [] },
}
export const DB_PRODUCTS = Object.keys(SPECS) as DbProductId[]
const RHEL_NAMES = [...new Set(Object.values(SPECS).flatMap(spec => spec.rhel))].sort()
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/u
const MAX_TEXT = 1024 * 1024
const invalid = (): never => { throw new Error('invalid_database_engine_observation') }
const textLines = (text: string): string[] => typeof text !== 'string' || Buffer.byteLength(text) > MAX_TEXT || UNSAFE.test(text) || text.includes('\r') ? invalid() : text.split('\n')
const attempt = async (run: DbRun, argv: readonly string[]) => { try { return await run(argv) } catch { return { ok: false, code: null, stdout: '', stderr: '' } } }

/** systemctl(1) show --property=… prints Key=Value lines; a missing unit is LoadState=not-found with an empty UnitFileState. */
export function parseDbUnit(text: string, unit: string): DbUnitFact & { load: string } {
  const data: Record<string, string> = {}
  for (const line of textLines(text).filter(Boolean)) {
    const match = /^(Id|Names|LoadState|ActiveState|SubState|UnitFileState)=([A-Za-z0-9@._: -]{0,512})$/.exec(line)
    if (!match || Object.hasOwn(data, match[1]!)) return invalid()
    data[match[1]!] = match[2]!
  }
  const token = /^[a-z][a-z0-9-]{0,63}$/
  if (Object.keys(data).length !== 6 || data.Id !== unit || ![data.LoadState, data.ActiveState, data.SubState].every(value => token.test(value!)) || data.UnitFileState !== '' && !token.test(data.UnitFileState!)) return invalid()
  return { unit, load: data.LoadState!, active: data.ActiveState!, sub: data.SubState!, enabled: data.UnitFileState || 'unknown' }
}

async function readUnit(run: DbRun, units: readonly string[]): Promise<DbUnitFact | null | 'unavailable'> {
  let found: DbUnitFact | null = null
  for (const unit of units) {
    const result = await attempt(run, serviceManagerShow(unit))
    if (!result.ok) return 'unavailable'
    let fact: ReturnType<typeof parseDbUnit>
    try { fact = parseDbUnit(result.stdout, unit) } catch { return 'unavailable' }
    if (fact.load !== 'loaded') continue
    const { load: _load, ...row } = fact
    if (row.active === 'active') return row
    found ??= row
  }
  return found
}

/** Installed package database facts and the unit of every database product; nothing is started or changed. */
export async function readDbPackages(input: { family: DbFamily | null; run: DbRun | null }): Promise<DbPackagesObservation> {
  const empty = (): Record<DbProductId, DbProductFact> => Object.fromEntries(DB_PRODUCTS.map(id => [id, { installed: null, package: null, service: 'unavailable' }])) as Record<DbProductId, DbProductFact>
  if (!input.family || !input.run) return { state: 'unavailable', products: empty() }
  const { family, run } = input
  let installed: Map<string, { installed: boolean; consistent: boolean; versions: string[] }>
  try {
    const result = await attempt(run, family === 'debian' ? SOFTWARE_CENTER_DPKG_LIST_ARGV : softwareCenterArgv('rpm-query', RHEL_NAMES))
    // rpm(8) -q exits non-zero when any queried name is missing; only a complete parse is accepted.
    if (family === 'debian' ? !result.ok : result.code === null) return { state: 'unavailable', products: empty() }
    installed = family === 'debian' ? parseDpkgPackages(result.stdout) : parseRpmPackages(result.stdout, RHEL_NAMES)
  } catch { return { state: 'unavailable', products: empty() } }
  const products = {} as Record<DbProductId, DbProductFact>
  for (const id of DB_PRODUCTS) {
    const spec = SPECS[id]
    const names = [...installed.keys()].filter(name => family === 'debian' ? spec.debian.test(name) : spec.rhel.includes(name)).filter(name => installed.get(name)!.installed && installed.get(name)!.consistent).sort()
    const name = names.at(-1)
    if (!name) { products[id] = { installed: false, package: null, service: null }; continue }
    const version = installed.get(name)!.versions.at(-1) ?? ''
    const units = spec.units(name, family)
    products[id] = { installed: true, package: { name, version }, service: units.length ? await readUnit(run, units) : null }
  }
  return { state: 'read', products }
}

// redis.conf: one directive per line, "keyword arg …"; later lines override earlier ones; # starts a comment line.
const redisTokens = (line: string): string[] => {
  const tokens: string[] = []
  for (const match of line.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)) tokens.push(match[1] ?? match[2] ?? match[3]!)
  return tokens
}
export interface RedisConfigFacts { port: number | null; bind: string[] | null; protectedMode: 'yes' | 'no' | null; unixSocket: string | null; maxmemory: string | null; maxmemoryPolicy: string | null; requirePass: boolean; aclFile: boolean; appendOnly: 'yes' | 'no' | null; includes: number }
export function parseRedisConfig(text: string): RedisConfigFacts {
  const facts: RedisConfigFacts = { port: null, bind: null, protectedMode: null, unixSocket: null, maxmemory: null, maxmemoryPolicy: null, requirePass: false, aclFile: false, appendOnly: null, includes: 0 }
  const yesNo = (value: string | undefined): 'yes' | 'no' => value === 'yes' || value === 'no' ? value : invalid()
  for (const raw of textLines(text)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const [keyword, ...args] = redisTokens(line), key = keyword!.toLowerCase()
    if (key === 'port') facts.port = args.length === 1 && /^(?:0|[1-9][0-9]{0,4})$/.test(args[0]!) && Number(args[0]) <= 65535 ? Number(args[0]) : invalid()
    else if (key === 'bind') facts.bind = args.length >= 1 && args.length <= 16 && args.every(arg => /^-?[0-9A-Fa-f:.*]{1,45}$/.test(arg)) ? args : invalid()
    else if (key === 'protected-mode') facts.protectedMode = yesNo(args[0])
    else if (key === 'appendonly') facts.appendOnly = yesNo(args[0])
    else if (key === 'unixsocket') facts.unixSocket = args.length === 1 && /^\/[A-Za-z0-9._/-]{1,255}$/.test(args[0]!) ? args[0]! : invalid()
    else if (key === 'maxmemory') facts.maxmemory = args.length === 1 && /^[0-9]{1,15}(?:[kKmMgG][bB]?)?$/.test(args[0]!) ? args[0]!.toLowerCase() : invalid()
    else if (key === 'maxmemory-policy') facts.maxmemoryPolicy = args.length === 1 && /^[a-z-]{1,32}$/.test(args[0]!) ? args[0]! : invalid()
    // The password itself is never kept, only whether one is configured.
    else if (key === 'requirepass') facts.requirePass = args.length === 1 && args[0] !== ''
    else if (key === 'aclfile') facts.aclFile = true
    else if (key === 'include') facts.includes++
  }
  return facts
}

/** mongod.conf is YAML; only the two-level block mappings MongoDB documents for these options are read. */
export interface MongodConfigFacts { port: number | null; bindIp: string | null; authorization: 'enabled' | 'disabled' | null; dbPath: string | null }
export function parseMongodConfig(text: string): MongodConfigFacts {
  const facts: MongodConfigFacts = { port: null, bindIp: null, authorization: null, dbPath: null }
  let section: string | null = null
  for (const raw of textLines(text)) {
    if (raw.includes('\t')) return invalid()
    const line = raw.replace(/\s+#.*$/, '').replace(/\s+$/, '')
    if (!line || /^\s*#/.test(line) || line === '---') continue
    const top = /^([A-Za-z][A-Za-z0-9]*):$/.exec(line)
    if (top) { section = top[1]!; continue }
    const nested = /^ {2,4}([A-Za-z][A-Za-z0-9]*): *(.*)$/.exec(line)
    if (!nested || section === null) { if (/^\S/.test(line)) return invalid(); continue }
    const value = nested[2]!.replace(/^(["'])(.*)\1$/, '$2'), key = section + '.' + nested[1]!
    if (key === 'net.port') facts.port = /^[1-9][0-9]{0,4}$/.test(value) && Number(value) <= 65535 ? Number(value) : invalid()
    else if (key === 'net.bindIp') facts.bindIp = /^[0-9A-Za-z:.,_/ -]{1,255}$/.test(value) ? value : invalid()
    else if (key === 'security.authorization') facts.authorization = value === 'enabled' || value === 'disabled' ? value : invalid()
    else if (key === 'storage.dbPath') facts.dbPath = /^\/[A-Za-z0-9._/-]{1,255}$/.test(value) ? value : invalid()
  }
  return facts
}

type ConfigRead<T> = { path: string | null; state: 'read' | 'missing' | 'unreadable' | 'unsupported'; facts: T | null }
async function readConfig<T>(readFile: DbReadFile | null, paths: readonly string[], parse: (text: string) => T): Promise<ConfigRead<T>> {
  if (!readFile) return { path: null, state: 'unreadable', facts: null }
  for (const path of paths) {
    let text: string | null
    try { text = await readFile(path) } catch { return { path, state: 'unreadable', facts: null } }
    if (text === null) continue
    try { return { path, state: 'read', facts: parse(text) } } catch { return { path, state: 'unsupported', facts: null } }
  }
  return { path: null, state: 'missing', facts: null }
}
export const redisConfigPaths = (family: DbFamily, packageName: string): string[] => packageName.startsWith('valkey') ? ['/etc/valkey/valkey.conf'] : family === 'debian' ? ['/etc/redis/redis.conf'] : ['/etc/redis/redis.conf', '/etc/redis.conf']

/** Root observation of every database product on the host. */
export async function readDbEngines(input: { family: DbFamily | null; run: DbRun | null; readFile: DbReadFile | null; now?: () => Date }) {
  const observedAt = (input.now ?? (() => new Date()))().toISOString()
  const packages = await readDbPackages(input)
  const { redis, mongodb, postgresql } = packages.products
  return {
    observedAt, family: input.family, packages: packages.state, products: packages.products,
    redisConfig: redis.installed && input.family ? await readConfig(input.readFile, redisConfigPaths(input.family, redis.package!.name), parseRedisConfig) : null,
    mongodbConfig: mongodb.installed ? await readConfig(input.readFile, ['/etc/mongod.conf'], parseMongodConfig) : null,
    postgresqlVersion: postgresql.installed && input.run && typeof postgresql.service === 'object' && postgresql.service?.active === 'active' ? await readPgVersion(input.run) : null,
  }
}

const psqlRows = (stdout: string, columns: number): string[][] => {
  if (stdout === '') return []
  if (!stdout.endsWith('\n')) return invalid()
  const rows = textLines(stdout.slice(0, -1)).map(line => line.split('\t'))
  if (rows.length > DB_PG_MAX_ROWS) throw new Error('postgresql_result_capacity')
  return rows.every(row => row.length === columns) ? rows : invalid()
}
async function readPgVersion(run: DbRun): Promise<string | null> {
  const result = await attempt(run, postgresqlQueryArgv(PG_VERSION_SQL))
  try { const rows = result.ok ? psqlRows(result.stdout, 1) : []; return rows.length === 1 && /^[0-9]{1,3}(?:\.[0-9]{1,3})?(?: [ -~]{0,120})?$/.test(rows[0]![0]!) ? rows[0]![0]! : null } catch { return null }
}

export interface PgAccountDatabase { name: string; owner: string; sizeBytes: number }
export interface PgAccountRole { name: string; login: boolean }
const pgName = (value: string): string => value.length >= 1 && value.length <= 63 && value.isWellFormed() ? value : invalid()
export function parsePgAccountDatabases(stdout: string, username: string): PgAccountDatabase[] {
  const rows = psqlRows(stdout, 3).map(([name, owner, size]) => ({ name: pgName(name!), owner: pgName(owner!), sizeBytes: /^(?:0|[1-9][0-9]{0,15})$/.test(size!) && Number.isSafeInteger(Number(size)) ? Number(size) : invalid() }))
  return rows.every(row => row.name.startsWith(username + '_')) && new Set(rows.map(row => row.name)).size === rows.length ? rows : invalid()
}
export function parsePgAccountRoles(stdout: string, username: string): PgAccountRole[] {
  const rows = psqlRows(stdout, 2).map(([name, login]) => ({ name: pgName(name!), login: login === 't' ? true : login === 'f' ? false : invalid() }))
  return rows.every(row => row.name === username || row.name.startsWith(username + '_')) && new Set(rows.map(row => row.name)).size === rows.length ? rows : invalid()
}

/** Account-prefixed PostgreSQL objects observed on the server; provisioning is available only while it can be read. */
export async function readAccountPostgresql(input: { family: DbFamily | null; run: DbRun | null; username: string; now?: () => Date }) {
  const observedAt = (input.now ?? (() => new Date()))().toISOString()
  const base = { observedAt, version: null as string | null, databases: [] as PgAccountDatabase[], roles: [] as PgAccountRole[], provisioning: 'unavailable' as 'available' | 'unavailable' }
  const packages = await readDbPackages(input), pg = packages.products.postgresql
  if (packages.state !== 'read' || !input.run) return { ...base, state: 'unavailable' as const }
  if (!pg.installed) return { ...base, state: 'not-installed' as const }
  if (pg.service === 'unavailable') return { ...base, state: 'unavailable' as const }
  if (pg.service?.active !== 'active') return { ...base, state: 'stopped' as const }
  const version = await readPgVersion(input.run)
  const databases = await attempt(input.run, postgresqlQueryArgv(pgAccountDatabasesSql(input.username)))
  const roles = await attempt(input.run, postgresqlQueryArgv(pgAccountRolesSql(input.username)))
  try {
    if (!databases.ok || !roles.ok) throw new Error('postgresql_unread')
    return { ...base, state: 'read' as const, version, databases: parsePgAccountDatabases(databases.stdout, input.username), roles: parsePgAccountRoles(roles.stdout, input.username), provisioning: 'available' as const }
  } catch { return { ...base, state: 'unavailable' as const, version } }
}

export interface DbAccountDeps {
  caller: AgentCallerIdentity
  store: { getAccountByUsername(username: string): Promise<Account | null>; getPlan(id: string): Promise<Plan | null>; getFeatureList(id: string): Promise<FeatureList | null>; readDatabaseRemoteAccess(accountId: string): Promise<DatabaseRemoteAccessSnapshot> }
  currentPrincipal(): Promise<{ kind: string; id: string; username: string; accountId: string | null; disabled: boolean } | null>
}
/** Current active account owner whose plan keeps the tool enabled; repeated before every native effect. */
export async function authorizeDbAccount(deps: DbAccountDeps, username: string, toolId: string): Promise<Account> {
  const account = await deps.store.getAccountByUsername(username)
  if (!account) return fail('NOT_FOUND', 'account not found', { stateChanged: false })
  const caller = deps.caller, principal = await deps.currentPrincipal()
  if (caller.role !== 'user' || caller.accountId !== account.id || account.username !== username || account.status !== 'active' || !principal || principal.disabled || principal.kind !== 'user' || principal.id !== caller.principalId || principal.accountId !== account.id || principal.username !== account.username) return fail('FORBIDDEN', 'the current account owner is required', { stateChanged: false })
  const plan = await deps.store.getPlan(account.planId), features = plan ? await deps.store.getFeatureList(plan.featureListId) : null
  if (!features || features.disabled.includes(toolId)) return fail('FORBIDDEN', 'this database tool is disabled by the account plan', { stateChanged: false })
  return account
}

export const dbJson = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const ACCOUNT_ROUTE = /^\/accounts\/([a-z][a-z0-9]{0,15})\/database-engines\/postgresql$/
const DROP_ROUTE = /^\/accounts\/([a-z][a-z0-9]{0,15})\/database-engines\/postgresql\/(databases|users)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/drop$/

export interface DbEnginesRouteDeps extends DbAccountDeps {
  store: DbAccountDeps['store'] & { readAccountPostgresql(accountId: string): Promise<{ databases: Database[]; users: PostgresqlUser[] }> }
  assertRoot(action: string): Promise<{ actor: string }>
  family: DbFamily | null
  run: DbRun | null
  readFile: DbReadFile | null
  /** The executor's 'postgresql' SQL action; null without a native host. */
  runPostgresql: ((statements: string[]) => Promise<void>) | null
  now?: () => Date
}

/**
 * Drops one saved PostgreSQL object on the server before the API removes it from desired state: a database already in
 * the trash, or a user that owns no saved database. Success means a fresh read no longer lists it.
 */
async function dropPostgresqlObject(req: Request, match: RegExpExecArray, deps: DbEnginesRouteDeps): Promise<Response> {
  let body: unknown
  try { body = JSON.parse(await req.text()) } catch { body = null }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) return fail('VALIDATION', 'the request fields are not accepted', { stateChanged: false })
  const kind = match[2] as 'databases' | 'users', id = match[3]!
  const owner = await authorizeDbAccount(deps, match[1]!, 'postgresql-databases')
  const saved = await deps.store.readAccountPostgresql(owner.id)
  const target = kind === 'databases' ? saved.databases.find(row => row.id === id) : saved.users.find(row => row.id === id)
  if (!target) return fail('NOT_FOUND', kind === 'databases' ? 'PostgreSQL database not found' : 'PostgreSQL user not found', { stateChanged: false })
  if ('trashedAt' in target ? target.trashedAt === null : saved.databases.some(row => row.owner === target.name)) return fail('PRECONDITION_FAILED', kind === 'databases' ? 'move the database to the trash first' : 'delete the PostgreSQL databases this user owns first', { stateChanged: false })
  const observe = () => readAccountPostgresql({ family: deps.family, run: deps.run, username: owner.username, ...(deps.now ? { now: deps.now } : {}) })
  if (!deps.runPostgresql || (await observe()).state !== 'read') return fail('PRECONDITION_FAILED', 'PostgreSQL must be running to delete it', { stateChanged: false })
  const fresh = await authorizeDbAccount(deps, match[1]!, 'postgresql-databases')
  if (fresh.id !== owner.id || fresh.createdAt !== owner.createdAt) return fail('CONFLICT', 'the account changed before the deletion', { stateChanged: false })
  let failure: unknown = null
  try { await deps.runPostgresql(kind === 'databases' ? pgDropDatabaseStatements(owner.username, target.name) : pgDropRoleStatements(owner.username, target.name)) } catch (error) { failure = error }
  const after = await observe()
  const present = after.state !== 'read' ? null : kind === 'databases' ? after.databases.some(row => row.name === target.name) : after.roles.some(row => row.name === target.name)
  if (present === null) return fail('SERVICE_UNAVAILABLE', 'the PostgreSQL deletion could not be verified', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  if (present) return fail(isXpanelError(failure) ? failure.code : 'CONFIG_TEST_FAILED', 'PostgreSQL did not delete it', { stateChanged: false, verificationRequired: true })
  return dbJson({ context: { accountId: owner.id, username: owner.username }, kind: kind === 'databases' ? 'database' : 'user', name: target.name, dropped: true })
}

export async function handleDbEnginesRoute(req: Request, url: URL, method: string, deps: DbEnginesRouteDeps): Promise<Response | null> {
  const drop = DROP_ROUTE.exec(url.pathname)
  if (drop) {
    if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
    if (url.search) return fail('VALIDATION', 'database engine changes do not accept selectors', { stateChanged: false })
    return dropPostgresqlObject(req, drop, deps)
  }
  const account = ACCOUNT_ROUTE.exec(url.pathname)
  if (url.pathname !== '/host/databases/engines' && !account) return null
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  if (url.search) return fail('VALIDATION', 'database engine reads do not accept selectors', { stateChanged: false })
  if (!account) {
    const first = await deps.assertRoot('host.databases.engines')
    const observed = await readDbEngines(deps)
    if ((await deps.assertRoot('host.databases.engines')).actor !== first.actor) return fail('FORBIDDEN', 'database engine authority changed', { stateChanged: false })
    return dbJson(observed)
  }
  const owner = await authorizeDbAccount(deps, account[1]!, 'postgresql-databases')
  const observed = await readAccountPostgresql({ family: deps.family, run: deps.run, username: owner.username, ...(deps.now ? { now: deps.now } : {}) })
  const fresh = await authorizeDbAccount(deps, account[1]!, 'postgresql-databases')
  if (fresh.id !== owner.id || fresh.createdAt !== owner.createdAt) return fail('CONFLICT', 'the account changed while reading', { stateChanged: false })
  return dbJson({ context: { accountId: owner.id, username: owner.username }, ...observed })
}
