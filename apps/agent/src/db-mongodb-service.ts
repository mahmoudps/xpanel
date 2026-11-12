import { randomBytes } from 'node:crypto'
import { fail, msgid, parseIp } from '@xpanel/core'
import { DB_SERVICE_ACTIONS, MONGODUMP, MONGO_ADMIN_FILE, MONGO_ADMIN_USER, MONGO_BACKUP_DIR, MONGO_DATABASE, MONGO_TOOLS_CONFIG, MONGORESTORE, dbBackupDirArgv, dbBackupRemoveArgv, isDatabaseServiceCommand, isMongoBackupName, isMongoLogPath, mongodumpArgv, mongorestoreArgv } from '../../../packages/os/src/db-services-command.ts'
import type { HostJobPlan } from './host-job-contract.ts'
import { parseMongodConfig } from './db-engines.ts'
import type { MongodConfigFacts } from './db-engines.ts'
import { assertServicePort, hideSecrets, restoreSecrets, submitServiceJob, controlUnit, engineFacts, exactBody, LOG_TAIL_BYTES, logLines, requireOk, requireUnit, revisionOf, setMongodValue, withFileRollback } from './db-service-files.ts'
import type { DbServiceContext } from './db-service-files.ts'
import { MongoCommandError } from './mongo-client.ts'
import type { BsonDoc, MongoClient, MongoCredential } from './mongo-client.ts'

/** MongoDB from the vendor packages: stays absent until an operator installs it, and is managed over its own wire protocol. */
const CONFIG_PATH = '/etc/mongod.conf'
const DEFAULT_LOG = '/var/log/mongodb/mongod.log'
const unchanged = { stateChanged: false }
const RESERVED = ['admin', 'local', 'config']
const USER = /^[a-z][a-z0-9_]{0,31}$/
const PASSWORD = /^[A-Za-z0-9!#$%&()*+,./:;<=>?@[\]^_{}~-]{12,128}$/
const UNAUTHORIZED = 13, USER_EXISTS = 51003

interface MongoFile { text: string; facts: MongodConfigFacts; unit: string | null }
async function mongoFile(ctx: DbServiceContext): Promise<MongoFile> {
  const view = await engineFacts(ctx), product = view.products.mongodb
  if (!product.installed) return fail('PRECONDITION_FAILED', 'MongoDB is not installed on this server', { ...unchanged, reason: 'mongodb_not_installed' })
  const text = await ctx.host.readFile(CONFIG_PATH).catch(() => null)
  if (text === null) return fail('PRECONDITION_FAILED', 'the MongoDB configuration file could not be read', { ...unchanged, reason: 'mongodb_config_unread' })
  try { return { text, facts: parseMongodConfig(text), unit: typeof product.service === 'object' ? product.service?.unit ?? null : null } }
  catch { return fail('PRECONDITION_FAILED', 'the MongoDB configuration uses syntax this page does not read', { ...unchanged, reason: 'mongodb_config_unsupported' }) }
}
const logPathOf = (text: string): string => /^\s+path:\s*["']?([^\s"'#]+)/m.exec(/^systemLog:\n((?:[ \t].*\n?)*)/m.exec(text)?.[1] ?? '')?.[1] ?? DEFAULT_LOG
async function adminCredential(ctx: DbServiceContext): Promise<MongoCredential | null> {
  let text: string | null
  try { text = await ctx.host.readFile(MONGO_ADMIN_FILE) } catch { return null }
  if (text === null) return null
  try { const raw = JSON.parse(text) as MongoCredential; return raw.user === MONGO_ADMIN_USER && typeof raw.password === 'string' ? raw : null } catch { return null }
}
const portOf = (file: Pick<MongoFile, 'facts'>): number => file.facts.port ?? 27017
const open = async (ctx: DbServiceContext, port: number, credential: MongoCredential | null): Promise<MongoClient> => ctx.connectMongo({ host: '127.0.0.1', port, credential })
async function withMongo<T>(ctx: DbServiceContext, file: MongoFile, work: (mongo: MongoClient) => Promise<T>): Promise<T> {
  let mongo: MongoClient
  const credential = await adminCredential(ctx)
  try { mongo = await open(ctx, portOf(file), credential) } catch (error) {
    if (error instanceof MongoCommandError) return fail('PRECONDITION_FAILED', 'MongoDB refused the saved administrator', { ...unchanged, reason: 'mongodb_admin_refused' })
    return fail('PRECONDITION_FAILED', 'MongoDB must be running for this', { ...unchanged, reason: 'mongodb_not_running' })
  }
  try { return await work(mongo) }
  catch (error) {
    if (error instanceof MongoCommandError) return fail('PRECONDITION_FAILED', error.code === UNAUTHORIZED ? 'MongoDB access control is on and xPanel holds no administrator' : 'MongoDB refused the command', { ...unchanged, reason: error.code === UNAUTHORIZED ? 'mongodb_admin_missing' : 'mongodb_command_refused' })
    throw error
  } finally { mongo.close() }
}

export async function readMongodbView(ctx: DbServiceContext) {
  const view = await engineFacts(ctx), product = view.products.mongodb, config = view.mongodbConfig, facts = config?.facts ?? null
  let runtime: Record<string, unknown> = { state: 'not-read', databases: [] }
  const admin = await adminCredential(ctx)
  if (product.installed && typeof product.service === 'object' && product.service?.active === 'active') {
    try {
      const mongo = await open(ctx, facts?.port ?? 27017, admin)
      try {
        const version = String((await mongo.command('admin', { buildInfo: 1 })).version ?? '')
        try {
          const list = await mongo.command('admin', { listDatabases: 1 }), users = await mongo.command('admin', { usersInfo: { forAllDBs: true } }).catch(() => ({ users: [] })) as BsonDoc
          const owners = new Map<string, string[]>()
          for (const row of users.users as BsonDoc[]) owners.set(String(row.db), [...owners.get(String(row.db)) ?? [], String(row.user)])
          runtime = { state: 'read', version, databases: (list.databases as BsonDoc[]).map(row => ({ name: String(row.name), sizeBytes: Number(row.sizeOnDisk ?? 0), users: owners.get(String(row.name)) ?? [] })) }
        } catch (error) { if (error instanceof MongoCommandError && error.code === UNAUTHORIZED) runtime = { state: 'locked', version, databases: [] }; else throw error }
      } finally { mongo.close() }
    } catch { runtime = { state: 'unreachable', databases: [] } }
  }
  const backups = (await ctx.fs.list(MONGO_BACKUP_DIR)).filter(row => isMongoBackupName(row.name))
  const tools = { dump: await ctx.fs.stat(MONGODUMP) !== null, restore: await ctx.fs.stat(MONGORESTORE) !== null }
  return { engine: 'mongodb', observedAt: view.observedAt, installed: product.installed, package: product.package, service: product.service, config, runtime, admin: admin ? 'present' : 'absent', tools, backups }
}
export async function readMongodbConfig(ctx: DbServiceContext) {
  const text = hideSecrets('mongodb', (await mongoFile(ctx)).text)
  return { path: CONFIG_PATH, text, revision: revisionOf(text) }
}
export async function readMongodbLog(ctx: DbServiceContext) {
  const { text } = await mongoFile(ctx), path = logPathOf(text)
  if (!isMongoLogPath(path)) return fail('PRECONDITION_FAILED', 'the MongoDB log path is outside the reviewed paths', { ...unchanged, reason: 'mongodb_log_path_unsupported' })
  return { path, lines: logLines(await ctx.fs.tail(path, LOG_TAIL_BYTES).catch(() => null)) }
}

const waitOpen = async (ctx: DbServiceContext, port: number, credential: MongoCredential | null): Promise<MongoClient | null> => {
  for (let attempt = 0; attempt < 40; attempt++) {
    try { return await open(ctx, port, credential) } catch (error) { if (error instanceof MongoCommandError) return null; await ctx.sleep(500) }
  }
  return null
}
const answers = async (ctx: DbServiceContext, port: number, credential: MongoCredential | null, check: (mongo: MongoClient) => Promise<boolean> = async () => true): Promise<boolean> => {
  const mongo = await waitOpen(ctx, port, credential)
  if (!mongo) return false
  try { await mongo.command('admin', { ping: 1 }); return await check(mongo) } finally { mongo.close() }
}
async function saveMongodFile(ctx: DbServiceContext, file: MongoFile, candidate: string, reason: string, check?: (credential: MongoCredential | null) => Promise<boolean>): Promise<void> {
  const unit = requireUnit(file.unit, 'mongodb'), info = await ctx.fs.stat(CONFIG_PATH)
  if (!info) return fail('PRECONDITION_FAILED', 'the MongoDB configuration file could not be read', { ...unchanged, reason: 'mongodb_config_unread' })
  const next = parseMongodConfig(candidate), credential = await adminCredential(ctx)
  await ctx.assertFresh()
  await withFileRollback({ host: ctx.host, fs: ctx.fs, path: CONFIG_PATH, reason,
    change: async () => { await ctx.host.writeFile({ path: CONFIG_PATH, content: candidate, mode: info.mode, owner: String(info.uid), group: String(info.gid) }) },
    activate: async () => requireOk(ctx, 'restart', unit),
    verify: async () => await answers(ctx, next.port ?? 27017, next.authorization === 'enabled' ? credential : null) && (!check || await check(credential)),
    verifyRestored: () => answers(ctx, portOf(file), file.facts.authorization === 'enabled' ? credential : null) })
}
export async function saveMongodbConfig(ctx: DbServiceContext, body: unknown) {
  const input = exactBody(body, ['text', 'expectedRevision']), text = input.text
  if (typeof text !== 'string' || text.length === 0 || text.length > 256 * 1024 || text.includes('\0')) return fail('VALIDATION', 'the configuration text is not accepted', unchanged)
  const file = await mongoFile(ctx)
  if (input.expectedRevision !== revisionOf(hideSecrets('mongodb', file.text))) return fail('CONFLICT', 'the configuration changed since it was read', { ...unchanged, reason: 'config_changed' })
  const candidate = restoreSecrets('mongodb', text, file.text)
  try { parseMongodConfig(candidate) } catch { return fail('VALIDATION', 'the configuration is not a block mapping this page can read', { ...unchanged, reason: 'mongodb_config_unsupported' }) }
  await saveMongodFile(ctx, file, candidate, 'mongodb_config')
  return { saved: true }
}
export function assertBindAddresses(value: unknown): string {
  const list = typeof value === 'string' && value.length <= 255 ? value.split(',').map(item => item.trim()) : []
  if (list.length === 0 || list.length > 8 || !list.every(item => parseIp(item))) return fail('VALIDATION', 'use IP addresses separated by commas', { ...unchanged, reason: 'mongodb_bind_rejected' })
  if (!list.includes('127.0.0.1')) return fail('VALIDATION', 'keep 127.0.0.1 in the list: xPanel reaches the server there', { ...unchanged, reason: 'mongodb_loopback_required' })
  return list.join(',')
}
export async function saveMongodbSettings(ctx: DbServiceContext, body: unknown) {
  const input = exactBody(body, ['port', 'bindIp']), port = assertServicePort(input.port, 'port'), bindIp = assertBindAddresses(input.bindIp), file = await mongoFile(ctx)
  if (bindIp !== '127.0.0.1' && file.facts.authorization !== 'enabled') return fail('PRECONDITION_FAILED', 'turn on access control before opening MongoDB to remote clients', { ...unchanged, reason: 'mongodb_remote_requires_auth' })
  const candidate = setMongodValue(setMongodValue(file.text, 'net', 'port', String(port)), 'net', 'bindIp', bindIp)
  await saveMongodFile(ctx, file, candidate, 'mongodb_settings', async credential => {
    const mongo = await waitOpen(ctx, port, credential)
    if (!mongo) return false
    try { const options = await mongo.command('admin', { getCmdLineOpts: 1 }), net = (options.parsed as BsonDoc).net as BsonDoc; return String(net.bindIp) === bindIp && Number(net.port) === port } finally { mongo.close() }
  })
  return { saved: true }
}

const toolsYaml = (password: string): string => `# Managed by xPanel. Read by mongodump and mongorestore through --config.\npassword: "${password}"\n`
/** The administrator is created through the localhost exception, or while access control is off; its password stays root-only. */
async function ensureAdmin(ctx: DbServiceContext, mongo: MongoClient): Promise<void> {
  if (await adminCredential(ctx)) return
  const password = randomBytes(32).toString('base64url')
  const roles = [{ role: 'root', db: 'admin' }]
  try {
    try { await mongo.command('admin', { createUser: MONGO_ADMIN_USER, pwd: password, roles }) }
    catch (error) { if (error instanceof MongoCommandError && error.code === USER_EXISTS) await mongo.command('admin', { updateUser: MONGO_ADMIN_USER, pwd: password, roles }); else throw error }
  } catch (error) {
    if (error instanceof MongoCommandError) return fail('PRECONDITION_FAILED', 'MongoDB access control is already on; xPanel cannot create its administrator', { ...unchanged, reason: 'mongodb_admin_missing' })
    throw error
  }
  await ctx.host.writeFile({ path: MONGO_ADMIN_FILE, content: JSON.stringify({ user: MONGO_ADMIN_USER, password }) + '\n', mode: 0o600, owner: 'root', group: 'root' })
  await ctx.host.writeFile({ path: MONGO_TOOLS_CONFIG, content: toolsYaml(password), mode: 0o600, owner: 'root', group: 'root' })
}
export async function setMongodbAuth(ctx: DbServiceContext, body: unknown) {
  const { enabled } = exactBody(body, ['enabled'])
  if (typeof enabled !== 'boolean') return fail('VALIDATION', 'enabled must be true or false', unchanged)
  const file = await mongoFile(ctx), port = portOf(file)
  if (!enabled && file.facts.bindIp !== null && file.facts.bindIp !== '127.0.0.1') return fail('PRECONDITION_FAILED', 'limit MongoDB to 127.0.0.1 before turning access control off', { ...unchanged, reason: 'mongodb_remote_requires_auth' })
  await ctx.assertFresh()
  if (enabled) await withMongo(ctx, file, mongo => ensureAdmin(ctx, mongo))
  await saveMongodFile(ctx, file, setMongodValue(file.text, 'security', 'authorization', enabled ? 'enabled' : 'disabled'), 'mongodb_auth', async credential => {
    if (!enabled) return true
    // The acceptance of the tool: an unauthenticated client can no longer list databases.
    const anonymous = await waitOpen(ctx, port, null)
    if (!anonymous || !credential) return false
    try { await anonymous.command('admin', { listDatabases: 1 }); return false } catch (error) { return error instanceof MongoCommandError && error.code === UNAUTHORIZED } finally { anonymous.close() }
  })
  return { saved: true, enabled }
}

const name = (value: unknown): string => typeof value === 'string' && MONGO_DATABASE.test(value) && !RESERVED.includes(value) ? value : fail('VALIDATION', 'use a lowercase name; admin, local and config are reserved', { ...unchanged, reason: 'mongodb_name_rejected' })
const password = (value: unknown): string => typeof value === 'string' && PASSWORD.test(value) ? value : fail('VALIDATION', 'use 12 to 128 letters, digits or symbols, without spaces, quotes or backslashes', { ...unchanged, reason: 'mongodb_password_rejected' })
export async function createMongodbDatabase(ctx: DbServiceContext, body: unknown) {
  const input = exactBody(body, ['name', 'user', 'password', 'server']), database = name(input.name), user = input.user
  if (input.server !== 'local') return fail('PRECONDITION_FAILED', 'remote MongoDB servers need a registered server profile', { ...unchanged, reason: 'database_server_profiles_deferred' })
  if (typeof user !== 'string' || !USER.test(user) || user === MONGO_ADMIN_USER) return fail('VALIDATION', 'the user name is not accepted', { ...unchanged, reason: 'mongodb_name_rejected' })
  const secret = password(input.password), file = await mongoFile(ctx)
  return withMongo(ctx, file, async mongo => {
    const known = await mongo.command('admin', { listDatabases: 1 })
    if ((known.databases as BsonDoc[]).some(row => row.name === database)) return fail('CONFLICT', 'this database already exists', { ...unchanged, reason: 'mongodb_database_exists' })
    await ctx.assertFresh()
    await mongo.command(database, { createUser: user, pwd: secret, roles: [{ role: 'dbOwner', db: database }] })
    // A database exists for MongoDB once it holds a collection.
    await mongo.command(database, { create: 'xpanel_init' })
    return { name: database, user }
  })
}
export async function deleteMongodbDatabases(ctx: DbServiceContext, body: unknown) {
  const input = exactBody(body, ['names', 'confirmation']), names = input.names
  if (!Array.isArray(names) || names.length === 0 || names.length > 50 || new Set(names).size !== names.length) return fail('VALIDATION', 'between 1 and 50 databases are required', unchanged)
  const list = names.map(name)
  if (input.confirmation !== list.join(',')) return fail('VALIDATION', 'the confirmation does not match', { ...unchanged, reason: 'confirmation_required' })
  return withMongo(ctx, await mongoFile(ctx), async mongo => {
    await ctx.assertFresh()
    for (const database of list) { await mongo.command(database, { dropAllUsersFromDatabase: 1 }); await mongo.command(database, { dropDatabase: 1 }) }
    return { removed: list }
  })
}
export async function setMongodbUserPassword(ctx: DbServiceContext, body: unknown) {
  const input = exactBody(body, ['database', 'user', 'password']), database = name(input.database), user = input.user, secret = password(input.password)
  if (typeof user !== 'string' || !USER.test(user)) return fail('VALIDATION', 'the user name is not accepted', unchanged)
  return withMongo(ctx, await mongoFile(ctx), async mongo => { await ctx.assertFresh(); await mongo.command(database, { updateUser: user, pwd: secret }); return { database, user, saved: true } })
}

const stampOf = (date: Date): string => date.toISOString().replace(/[-:]/g, '').replace(/\.[0-9]{3}Z$/, 'Z')
/** A dump can outlast a request, so it runs as a verified host job; the restore also replaces every collection it holds. */
function jobPlan(kind: string, summary: string, port: number, steps: HostJobPlan['steps'], detail: Record<string, unknown>, ctx: DbServiceContext, verify: HostJobPlan['verify']): HostJobPlan {
  return { kind, summary, accountId: null, fingerprint: { port, ...detail }, detail, steps, policy: argv => isDatabaseServiceCommand(argv), beforeStep: async () => { await ctx.assertFresh() }, ...(verify ? { verify } : {}) }
}
const assertTools = async (ctx: DbServiceContext, binary: string): Promise<void> => {
  if (await ctx.fs.stat(binary) === null) return fail('PRECONDITION_FAILED', 'install mongodb-database-tools from the MongoDB repository first', { ...unchanged, reason: 'mongodb_tools_missing' })
}
export async function backupMongodb(ctx: DbServiceContext, body: unknown) {
  const { database } = exactBody(body, ['database']), target = database === null ? null : name(database), file = await mongoFile(ctx), port = portOf(file)
  await assertTools(ctx, MONGODUMP)
  await withMongo(ctx, file, mongo => ensureAdmin(ctx, mongo))
  const archive = `mongodb-${stampOf(ctx.now())}${target ? '-' + target : ''}.archive.gz`
  return submitServiceJob(ctx, jobPlan('database.mongodb.backup', `Back up MongoDB ${target ?? 'all databases'}`, port, [
    { id: 'prepare-backup', title: msgid('Prepare the protected backup directory'), argv: dbBackupDirArgv(MONGO_BACKUP_DIR), timeoutMs: 30_000, mutates: true },
    { id: 'backup', title: msgid('Back up MongoDB'), argv: mongodumpArgv(port, archive, target), timeoutMs: 3_600_000, mutates: true },
  ], { archive, database: target }, ctx, async () => {
    const row = (await ctx.fs.list(MONGO_BACKUP_DIR)).find(entry => entry.name === archive)
    return { ok: !!row && row.sizeBytes > 0, detail: { archive, sizeBytes: row?.sizeBytes ?? null } }
  }))
}
export async function restoreMongodb(ctx: DbServiceContext, body: unknown) {
  const { name: archive } = exactBody(body, ['name']), file = await mongoFile(ctx), port = portOf(file)
  if (!isMongoBackupName(archive)) return fail('VALIDATION', 'the backup name is not accepted', unchanged)
  await assertTools(ctx, MONGORESTORE)
  if (!(await ctx.fs.list(MONGO_BACKUP_DIR)).some(row => row.name === archive)) return fail('NOT_FOUND', 'this backup is not on the server', { ...unchanged, reason: 'database_backup_missing' })
  await withMongo(ctx, file, mongo => ensureAdmin(ctx, mongo))
  return submitServiceJob(ctx, jobPlan('database.mongodb.restore', `Restore MongoDB from ${archive}`, port, [
    { id: 'restore', title: msgid('Restore MongoDB'), argv: mongorestoreArgv(port, archive), timeoutMs: 3_600_000, mutates: true },
  ], { archive }, ctx, undefined))
}
// mongodump --archive starts with this magic number, little endian (archive/prelude.go in the database tools).
const ARCHIVE_MAGIC = Buffer.from([0x6d, 0xe2, 0x99, 0x81])
export const MONGO_UPLOAD_DIR = 'extended/transfers/mongodb'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** Takes one finished upload from the API's state folder into the root-only backup directory, after proving what it is. */
export async function importMongodbArchive(ctx: DbServiceContext, body: unknown) {
  const { id, filename } = exactBody(body, ['id', 'filename'])
  if (typeof id !== 'string' || !UUID.test(id) || typeof filename !== 'string') return fail('VALIDATION', 'the upload is not accepted', unchanged)
  await mongoFile(ctx)
  const source = `${ctx.stateRoot}/${MONGO_UPLOAD_DIR}/${id}.archive.gz`, head = await ctx.fs.gunzipHead(source, ARCHIVE_MAGIC.length)
  if (!head || !head.equals(ARCHIVE_MAGIC)) { await ctx.fs.remove(source).catch(() => undefined); return fail('VALIDATION', 'this file is not a gzipped mongodump archive', { ...unchanged, reason: 'mongodb_archive_rejected' }) }
  const safe = filename.replace(/\.archive\.gz$/, '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'archive', name = `upload-${stampOf(ctx.now())}-${safe}.archive.gz`
  await ctx.assertFresh()
  if (!(await ctx.run(dbBackupDirArgv(MONGO_BACKUP_DIR))).ok) return fail('CONFIG_TEST_FAILED', 'the backup directory could not be prepared', { ...unchanged, reason: 'database_backup_step_failed' })
  await ctx.fs.adopt(source, `${MONGO_BACKUP_DIR}/${name}`)
  return (await ctx.fs.list(MONGO_BACKUP_DIR)).find(row => row.name === name) ?? fail('SERVICE_UNAVAILABLE', 'the upload could not be confirmed', { stateChanged: true, verificationRequired: true, reason: 'mongodb_import_unverified' })
}
export async function deleteMongodbBackup(ctx: DbServiceContext, body: unknown) {
  const { name: archive } = exactBody(body, ['name'])
  if (!isMongoBackupName(archive)) return fail('VALIDATION', 'the backup name is not accepted', unchanged)
  await ctx.assertFresh()
  if (!(await ctx.run(dbBackupRemoveArgv('mongodb', archive))).ok) return fail('CONFIG_TEST_FAILED', 'the backup could not be removed', { ...unchanged, reason: 'database_backup_step_failed' })
  return { removed: archive }
}
export const controlMongodb = async (ctx: DbServiceContext, body: unknown) => {
  const { action } = exactBody(body, ['action'])
  if (!(DB_SERVICE_ACTIONS as readonly unknown[]).includes(action)) return fail('VALIDATION', 'unsupported service action', unchanged)
  return controlUnit(ctx, (await mongoFile(ctx)).unit, 'mongodb', body)
}
