import { describe, expect, it, vi } from 'vitest'
import { handleDbServicesRoute } from './db-services.ts'
import type { DbServiceRouteDeps } from './db-services.ts'
import { parseResp, encodeResp, RedisReplyError } from './redis-client.ts'
import type { RedisClient, RespValue } from './redis-client.ts'
import { MongoCommandError } from './mongo-client.ts'
import type { BsonDoc, MongoClient } from './mongo-client.ts'

const unit = (name: string, active = 'active'): string => `Id=${name}\nNames=${name}\nLoadState=loaded\nActiveState=${active}\nSubState=running\nUnitFileState=enabled\n`
interface Fake { files: Map<string, string>; argv: string[][]; active: Record<string, string>; packages: string }
function fakeHost(overrides: Partial<Fake> = {}): Fake & { run: NonNullable<DbServiceRouteDeps['run']>; host: NonNullable<DbServiceRouteDeps['host']> } {
  const state: Fake = { files: new Map(), argv: [], active: {}, packages: 'redis-server\t5:7.0.15-1\tinstall ok installed\n', ...overrides }
  const ok = (stdout = '') => ({ ok: true, code: 0, stdout, stderr: '' })
  return { ...state,
    run: async argv => {
      state.argv.push([...argv])
      if (argv[0] === '/usr/bin/dpkg-query') return ok(state.packages)
      if (argv[1] === 'show') return ok(unit(String(argv.at(-1)), state.active[String(argv.at(-1))] ?? 'active'))
      if (argv[0] === '/usr/bin/systemctl') { const name = String(argv.at(-1)); if (argv[1] === 'stop') state.active[name] = 'inactive'; if (argv[1] === 'start' || argv[1] === 'restart') state.active[name] = 'active'; return ok() }
      return ok()
    },
    host: { readFile: async path => state.files.get(path) ?? null, writeFile: async file => { state.files.set(file.path, file.content) } } }
}
const req = (body?: unknown): Request => new Request('http://agent/x', body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const fs = (list: { name: string; sizeBytes: number; modifiedAt: string }[] = []): NonNullable<DbServiceRouteDeps['fs']> => ({ stat: async () => ({ uid: 0, gid: 0, mode: 0o640 }), list: async () => list, tail: async () => 'line\n', freeKb: async () => 1_000_000, gunzipHead: async () => null, adopt: async () => undefined, remove: async () => undefined })
const deps = (fake: ReturnType<typeof fakeHost>, extra: Partial<DbServiceRouteDeps> = {}): DbServiceRouteDeps => ({ assertRoot: async () => ({ actor: 'root' }), family: 'debian', run: fake.run, readFile: fake.host.readFile, host: fake.host, runPostgresql: null, submitJob: null, stateRoot: '/tmp/none', fs: fs(), sleep: async () => undefined, now: () => new Date('2026-11-07T10:10:10.000Z'), ...extra })
const call = async (path: string, body: unknown, options: DbServiceRouteDeps): Promise<Response> => (await handleDbServicesRoute(req(body), new URL('http://agent' + path), body === undefined ? 'GET' : 'POST', options))!
const refused = async (promise: Promise<Response>) => { try { await promise; return null } catch (error) { return error as { code: string; detail: Record<string, unknown> } } }

/** A Redis that enforces AUTH and speaks through the real RESP helpers' value shapes. */
function fakeRedis(store: Map<string, string> = new Map(), requirepass: () => string | null = () => null) {
  const log: string[][] = []
  const connect: NonNullable<DbServiceRouteDeps['connectRedis']> = async (_target, password) => {
    if (password !== null && requirepass() !== null && password !== requirepass()) throw new RedisReplyError('WRONGPASS invalid password')
    const authed = password !== null || requirepass() === null
    const client: RedisClient = {
      close: () => undefined,
      command: async (...args): Promise<RespValue> => {
        log.push(args)
        const [name, a, b] = args
        if (!authed) throw new RedisReplyError('NOAUTH Authentication required.')
        switch (name) {
          case 'PING': return 'PONG'
          case 'INFO': return 'redis_version:7.0.15\r\nused_memory:1048576\r\nconnected_clients:2\r\ndb0:keys=2,expires=1,avg_ttl=0\r\n'
          case 'CONFIG': return [a === 'GET' ? b! : '', b === 'databases' ? '16' : b === 'dir' ? '/var/lib/redis' : 'dump.rdb']
          case 'SELECT': case 'SET': case 'FLUSHDB': case 'FLUSHALL': return 'OK'
          case 'SCAN': return ['0', [...store.keys()]]
          case 'TYPE': return 'string'
          case 'TTL': return a === 'session' ? 60 : -1
          case 'STRLEN': return store.get(a!)?.length ?? 0
          case 'GET': return store.get(a!) ?? null
          case 'DEL': return store.delete(a!) ? 1 : 0
          default: return 'OK'
        }
      },
    }
    return client
  }
  return { connect, log }
}

describe('RESP', () => {
  it('encodes commands and parses every reply kind', () => {
    expect(encodeResp(['GET', 'é']).toString()).toBe('*2\r\n$3\r\nGET\r\n$2\r\né\r\n')
    expect(parseResp(Buffer.from('+OK\r\n'))?.value).toBe('OK')
    expect(parseResp(Buffer.from(':42\r\n'))?.value).toBe(42)
    expect(parseResp(Buffer.from('$-1\r\n'))?.value).toBeNull()
    expect(parseResp(Buffer.from('*2\r\n$1\r\na\r\n:1\r\n'))?.value).toEqual(['a', 1])
    expect(parseResp(Buffer.from('-ERR x\r\n'))?.value).toBeInstanceOf(RedisReplyError)
    expect(parseResp(Buffer.from('$5\r\nab'))).toBeNull()
    expect(parseResp(Buffer.concat([Buffer.from('$2\r\n'), Buffer.from([0xff, 0xfe]), Buffer.from('\r\n')]))?.value).toBeNull()
  })
})

describe('Redis tools', () => {
  const conf = (extra = ''): Map<string, string> => new Map([['/etc/redis/redis.conf', `port 6379\nbind 127.0.0.1 ::1\n${extra}`]])
  it('refuses with a stable code when Redis is not installed', async () => {
    const fake = fakeHost({ packages: '' })
    expect((await refused(call('/host/databases/services/redis/backup', {}, deps(fake))))?.detail.reason).toBe('redis_not_installed')
  })
  it('sets a password, restarts, and proves an unauthenticated command is refused', async () => {
    const fake = fakeHost({ files: conf() }), password = () => /requirepass (\S+)/.exec(fake.files.get('/etc/redis/redis.conf') ?? '')?.[1] ?? null, redis = fakeRedis(new Map(), password)
    const reply = await call('/host/databases/services/redis/password', { password: 'Correct-Horse-9' }, deps(fake, { connectRedis: redis.connect }))
    expect(await reply.json()).toEqual({ saved: true, passwordConfigured: true })
    expect(fake.files.get('/etc/redis/redis.conf')).toContain('requirepass Correct-Horse-9')
    expect(fake.argv).toContainEqual(['/usr/bin/systemctl', 'restart', '--', 'redis-server.service'])
    expect(JSON.stringify(fake.argv)).not.toContain('Correct-Horse-9')
    const view = await (await call('/host/databases/services/redis', undefined, deps(fake, { connectRedis: redis.connect }))).text()
    expect(view).not.toContain('Correct-Horse-9')
    expect(JSON.parse(view)).toMatchObject({ passwordConfigured: true, runtime: { state: 'read', version: '7.0.15', keyspace: [{ db: 0, keys: 2, expires: 1 }] } })
    const config = await (await call('/host/databases/services/redis/config', undefined, deps(fake, { connectRedis: redis.connect }))).text()
    expect(config).not.toContain('Correct-Horse-9')
  })
  it('takes every password the page can generate and refuses quotes', async () => {
    const fake = fakeHost({ files: conf() }), redis = fakeRedis(new Map(), () => /requirepass (\S+)/.exec(fake.files.get('/etc/redis/redis.conf') ?? '')?.[1] ?? null)
    expect(await (await call('/host/databases/services/redis/password', { password: 'aB3!@#$%^&*()-_=+[]{}:,.?' }, deps(fake, { connectRedis: redis.connect }))).json()).toMatchObject({ saved: true })
    expect((await refused(call('/host/databases/services/redis/password', { password: 'has"quote-and-more' }, deps(fake, { connectRedis: redis.connect }))))?.detail.reason).toBe('redis_password_rejected')
  })
  it('refuses remote access without a password', async () => {
    const fake = fakeHost({ files: conf() })
    const body = { port: 6379, maxmemoryMb: 0, maxclients: 100, maxmemoryPolicy: 'noeviction', persistence: 'rdb', remoteAccess: true }
    expect((await refused(call('/host/databases/services/redis/settings', body, deps(fake))))?.detail.reason).toBe('redis_remote_requires_password')
  })
  it('restores redis.conf when Redis does not answer after a restart', async () => {
    const fake = fakeHost({ files: conf() }), before = fake.files.get('/etc/redis/redis.conf')
    const connectRedis = vi.fn(async (): Promise<RedisClient> => { throw new Error('refused') })
    const body = { port: 7000, maxmemoryMb: 64, maxclients: 100, maxmemoryPolicy: 'allkeys-lru', persistence: 'none', remoteAccess: false }
    const error = await refused(call('/host/databases/services/redis/settings', body, deps(fake, { connectRedis })))
    expect(error?.code).toBe('CONFIG_TEST_FAILED')
    expect(fake.files.get('/etc/redis/redis.conf')).toBe(before)
  })
  it('lists keys with their expiry, sets a time to live and deletes', async () => {
    const fake = fakeHost({ files: conf() }), store = new Map([['session', 'abc'], ['plain', 'x'.repeat(300)]]), redis = fakeRedis(store), options = deps(fake, { connectRedis: redis.connect })
    const page = await (await call('/host/databases/services/redis/keys', { db: 3, cursor: '0', match: '' }, options)).json() as { keys: Record<string, unknown>[] }
    expect(redis.log).toContainEqual(['SELECT', '3'])
    expect(page.keys[0]).toEqual({ key: 'session', type: 'string', length: 3, ttlSeconds: 60, value: 'abc', truncated: false })
    expect(page.keys[1]).toMatchObject({ ttlSeconds: null, truncated: true })
    await call('/host/databases/services/redis/key', { db: 0, key: 'k', value: 'v', ttlSeconds: 60 }, options)
    expect(redis.log).toContainEqual(['SET', 'k', 'v', 'EX', '60'])
    expect(await (await call('/host/databases/services/redis/key-delete', { db: 0, key: 'session' }, options)).json()).toMatchObject({ removed: 1 })
    expect((await refused(call('/host/databases/services/redis/flush', { db: 2, confirmation: '3' }, options)))?.detail.reason).toBe('confirmation_required')
    await call('/host/databases/services/redis/flush', { db: null, confirmation: 'all' }, options)
    expect(redis.log).toContainEqual(['FLUSHALL'])
  })
  it('turns a refused Redis command into a stable refusal', async () => {
    const fake = fakeHost({ files: conf() }), redis = fakeRedis()
    const connectRedis: DbServiceRouteDeps['connectRedis'] = async (target, password) => { const client = await redis.connect(target, password); return { ...client, command: async (...args) => { if (args[0] === 'FLUSHALL') throw new RedisReplyError('ERR unknown command'); return client.command(...args) } } }
    expect((await refused(call('/host/databases/services/redis/flush', { db: null, confirmation: 'all' }, deps(fake, { connectRedis }))))?.detail.reason).toBe('redis_command_refused')
  })
  it('refuses a restore while the append-only file is on', async () => {
    const fake = fakeHost({ files: conf('appendonly yes\n') }), name = 'redis-20261107T101010Z.rdb'
    expect((await refused(call('/host/databases/services/redis/restore', { name }, deps(fake, { fs: fs([{ name, sizeBytes: 1, modifiedAt: '' }]) }))))?.detail.reason).toBe('redis_restore_requires_rdb')
  })
  it('re-checks authority before a host effect', async () => {
    const fake = fakeHost({ files: conf() })
    let calls = 0
    const assertRoot = async () => ({ actor: ++calls === 1 ? 'root' : 'other' })
    expect((await refused(call('/host/databases/services/redis/control', { action: 'restart' }, deps(fake, { assertRoot }))))?.code).toBe('FORBIDDEN')
    expect(fake.argv.some(argv => argv[1] === 'restart')).toBe(false)
  })
  it('rejects unknown routes, verbs and selectors', async () => {
    const fake = fakeHost({ files: conf() }), options = deps(fake)
    expect((await call('/host/databases/services/redis/auth', {}, options)).status).toBe(404)
    expect((await handleDbServicesRoute(req(), new URL('http://agent/host/databases/services/redis/keys'), 'GET', options))!.status).toBe(405)
    await expect(handleDbServicesRoute(req(), new URL('http://agent/host/databases/services/redis?x=1'), 'GET', options)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(await handleDbServicesRoute(req(), new URL('http://agent/host/other'), 'GET', options)).toBeNull()
  })
})

describe('MongoDB tools', () => {
  const PACKAGE = 'mongodb-org-server\t7.0.14\tinstall ok installed\n'
  const conf = (auth = 'disabled') => new Map([['/etc/mongod.conf', `storage:\n  dbPath: /var/lib/mongodb\nnet:\n  port: 27017\n  bindIp: 127.0.0.1\nsecurity:\n  authorization: ${auth}\n`]])
  function fakeMongo(fake: ReturnType<typeof fakeHost>) {
    const commands: BsonDoc[] = [], users = new Map<string, string>()
    const enforced = (): boolean => /authorization: enabled/.test(fake.files.get('/etc/mongod.conf') ?? '')
    const connect: NonNullable<DbServiceRouteDeps['connectMongo']> = async input => {
      if (input.credential && enforced() && users.get(input.credential.user) !== input.credential.password) throw new MongoCommandError('Authentication failed.', 18, 'AuthenticationFailed')
      const client: MongoClient = {
        close: () => undefined,
        command: async (_database, doc): Promise<BsonDoc> => {
          commands.push(doc)
          if (doc.createUser) users.set(String(doc.createUser), String(doc.pwd))
          if (doc.listDatabases && enforced() && !input.credential) throw new MongoCommandError('requires authentication', 13, 'Unauthorized')
          if (doc.listDatabases) return { ok: 1, databases: [{ name: 'admin', sizeOnDisk: 1 }, { name: 'shop', sizeOnDisk: 8192 }] }
          if (doc.usersInfo) return { ok: 1, users: [{ user: 'shopper', db: 'shop' }] }
          if (doc.buildInfo) return { ok: 1, version: '7.0.14' }
          if (doc.getCmdLineOpts) { const text = fake.files.get('/etc/mongod.conf')!; return { ok: 1, parsed: { net: { bindIp: /bindIp: (\S+)/.exec(text)![1]!, port: Number(/port: (\d+)/.exec(text)![1]) } } } }
          return { ok: 1 }
        },
      }
      return client
    }
    return { connect, commands, users }
  }
  it('refuses when MongoDB is not installed and never starts a daemon', async () => {
    const fake = fakeHost()
    const view = await (await call('/host/databases/services/mongodb', undefined, deps(fake))).json() as { installed: boolean; runtime: { state: string } }
    expect(view).toMatchObject({ installed: false, runtime: { state: 'not-read' } })
    expect((await refused(call('/host/databases/services/mongodb/control', { action: 'start' }, deps(fake))))?.detail.reason).toBe('mongodb_not_installed')
    expect(fake.argv.some(argv => argv[1] === 'start')).toBe(false)
  })
  it('turns on access control and proves an unauthenticated client cannot list databases', async () => {
    const fake = fakeHost({ packages: PACKAGE, files: conf() }), mongo = fakeMongo(fake)
    const reply = await call('/host/databases/services/mongodb/auth', { enabled: true }, deps(fake, { connectMongo: mongo.connect }))
    expect(await reply.json()).toEqual({ saved: true, enabled: true })
    expect(fake.files.get('/etc/mongod.conf')).toContain('authorization: enabled')
    const admin = JSON.parse(fake.files.get('/etc/xpanel/mongodb-admin.json')!) as { user: string; password: string }
    expect(admin.user).toBe('xpanel-admin')
    expect(fake.files.get('/etc/xpanel/mongodb-tools.yaml')).toContain(admin.password)
    const view = await (await call('/host/databases/services/mongodb', undefined, deps(fake, { connectMongo: mongo.connect }))).text()
    expect(view).not.toContain(admin.password)
    expect(JSON.stringify(fake.argv)).not.toContain(admin.password)
  })
  it('puts the configuration back when the server stays open', async () => {
    const fake = fakeHost({ packages: PACKAGE, files: conf() }), mongo = fakeMongo(fake), before = fake.files.get('/etc/mongod.conf')
    const stays: NonNullable<DbServiceRouteDeps['connectMongo']> = async input => { const client = await mongo.connect(input); return { ...client, command: async (database, doc) => doc.listDatabases ? { ok: 1, databases: [] } : client.command(database, doc) } }
    const error = await refused(call('/host/databases/services/mongodb/auth', { enabled: true }, deps(fake, { connectMongo: stays })))
    expect(error?.code).toBe('CONFIG_TEST_FAILED')
    expect(fake.files.get('/etc/mongod.conf')).toBe(before)
  })
  it('checks a new bind address on the running server', async () => {
    const fake = fakeHost({ packages: PACKAGE, files: conf('enabled') }), mongo = fakeMongo(fake)
    fake.files.set('/etc/xpanel/mongodb-admin.json', JSON.stringify({ user: 'xpanel-admin', password: 'p' })); mongo.users.set('xpanel-admin', 'p')
    expect(await (await call('/host/databases/services/mongodb/settings', { port: 27017, bindIp: '127.0.0.1,10.0.0.5' }, deps(fake, { connectMongo: mongo.connect }))).json()).toEqual({ saved: true })
    expect(fake.files.get('/etc/mongod.conf')).toContain('bindIp: 127.0.0.1,10.0.0.5')
    expect(mongo.commands.some(doc => doc.getCmdLineOpts)).toBe(true)
  })
  it('refuses remote exposure without access control and a remote server without profiles', async () => {
    const fake = fakeHost({ packages: PACKAGE, files: conf() }), mongo = fakeMongo(fake), options = deps(fake, { connectMongo: mongo.connect })
    expect((await refused(call('/host/databases/services/mongodb/settings', { port: 27017, bindIp: '127.0.0.1,10.0.0.5' }, options)))?.detail.reason).toBe('mongodb_remote_requires_auth')
    expect((await refused(call('/host/databases/services/mongodb/database', { name: 'shop', user: 'shopper', password: 'Correct-Horse-9', server: '203.0.113.5' }, options)))?.detail.reason).toBe('database_server_profiles_deferred')
    expect((await refused(call('/host/databases/services/mongodb/database', { name: 'admin', user: 'shopper', password: 'Correct-Horse-9', server: 'local' }, options)))?.detail.reason).toBe('mongodb_name_rejected')
  })
  it('creates a database with its user and deletes in bulk', async () => {
    const fake = fakeHost({ packages: PACKAGE, files: conf() }), mongo = fakeMongo(fake), options = deps(fake, { connectMongo: mongo.connect })
    expect(await (await call('/host/databases/services/mongodb/database', { name: 'blog', user: 'blogger', password: 'Correct-Horse-9', server: 'local' }, options)).json()).toEqual({ name: 'blog', user: 'blogger' })
    expect(mongo.commands).toContainEqual({ createUser: 'blogger', pwd: 'Correct-Horse-9', roles: [{ role: 'dbOwner', db: 'blog' }] })
    expect((await refused(call('/host/databases/services/mongodb/database', { name: 'shop', user: 'blogger', password: 'Correct-Horse-9', server: 'local' }, options)))?.detail.reason).toBe('mongodb_database_exists')
    expect((await refused(call('/host/databases/services/mongodb/database-delete', { names: ['blog', 'shop'], confirmation: 'blog' }, options)))?.detail.reason).toBe('confirmation_required')
    expect(await (await call('/host/databases/services/mongodb/database-delete', { names: ['blog', 'shop'], confirmation: 'blog,shop' }, options)).json()).toEqual({ removed: ['blog', 'shop'] })
  })
  it('submits a backup as a verified job, or refuses without the tools', async () => {
    const fake = fakeHost({ packages: PACKAGE, files: conf() }), mongo = fakeMongo(fake)
    const none = { ...fs(), stat: async (path: string) => path === '/usr/bin/mongodump' ? null : { uid: 0, gid: 0, mode: 0o644 } }
    expect((await refused(call('/host/databases/services/mongodb/backup', { database: null }, deps(fake, { connectMongo: mongo.connect, fs: none }))))?.detail.reason).toBe('mongodb_tools_missing')
    const submitJob = vi.fn(async (plan: { kind: string }) => ({ id: 'job', kind: plan.kind }) as never)
    const reply = await call('/host/databases/services/mongodb/backup', { database: 'shop' }, deps(fake, { connectMongo: mongo.connect, submitJob }))
    expect(reply.status).toBe(202)
    const plan = submitJob.mock.calls[0]![0] as unknown as { steps: { argv: string[] }[]; policy(argv: readonly string[]): boolean }
    expect(plan.steps.at(-1)!.argv).toContain('--db=shop')
    expect(plan.steps.every(step => plan.policy(step.argv))).toBe(true)
  })
})

describe('PostgreSQL tools', () => {
  const PACKAGE = 'postgresql-14\t14.13-1\tinstall ok installed\n'
  const files = '/etc/postgresql/14/main/postgresql.conf\t/etc/postgresql/14/main/pg_hba.conf\t/var/lib/postgresql/14/main\t140013\t\n'
  function pgHost(overrides: { hbaErrors?: string } = {}) {
    const fake = fakeHost({ packages: PACKAGE, files: new Map([['/etc/postgresql/14/main/pg_hba.conf', 'local all postgres peer\n'], ['/var/lib/postgresql/14/main/postgresql.auto.conf', '# auto\n']]) })
    const run: typeof fake.run = async argv => {
      const sql = String(argv.at(-1))
      if (sql.includes('config_file')) return { ok: true, code: 0, stdout: files, stderr: '' }
      if (sql.includes('pg_hba_file_rules')) return { ok: true, code: 0, stdout: overrides.hbaErrors ?? '', stderr: '' }
      if (sql.includes('pg_settings')) return { ok: true, code: 0, stdout: 'max_connections\t100\t\tf\nport\t5432\t\tf\n', stderr: '' }
      if (sql === 'SHOW server_version') return { ok: true, code: 0, stdout: '14.13\n', stderr: '' }
      return fake.run(argv)
    }
    return { ...fake, run }
  }
  it('reads the running paths and settings', async () => {
    const fake = pgHost()
    expect(await (await call('/host/databases/services/postgresql', undefined, deps(fake))).json()).toMatchObject({ version: '14.13', files: { data: '/var/lib/postgresql/14/main' }, settings: { port: { value: '5432' } }, pendingRestart: [] })
  })
  it('saves a client rule and reloads the server', async () => {
    const fake = pgHost(), path = '/etc/postgresql/14/main/pg_hba.conf'
    const read = await (await call('/host/databases/services/postgresql/hba', undefined, deps(fake))).json() as { revision: string; text: string }
    const text = 'host all all 203.0.113.9/32 reject\n' + read.text
    expect(await (await call('/host/databases/services/postgresql/hba', { text, expectedRevision: read.revision }, deps(fake))).json()).toEqual({ saved: true })
    expect(fake.files.get(path)).toBe(text)
    expect(fake.argv).toContainEqual(['/usr/bin/systemctl', 'reload', '--', 'postgresql@14-main.service'])
    expect((await refused(call('/host/databases/services/postgresql/hba', { text, expectedRevision: read.revision }, deps(fake))))?.detail.reason).toBe('config_changed')
  })
  it('restores postgresql.conf when postgres refuses it, and keeps a valid file', async () => {
    const fake = pgHost(), path = '/etc/postgresql/14/main/postgresql.conf'
    fake.files.set(path, 'port = 5432\n')
    const accept = deps(fake), refuse = deps({ ...fake, run: async argv => argv.includes('-C') ? { ok: false, code: 1, stdout: '', stderr: 'FATAL: invalid value for parameter "max_connections"\n' } : fake.run(argv) })
    const read = await (await call('/host/databases/services/postgresql/config', undefined, accept)).json() as { revision: string }
    const error = await refused(call('/host/databases/services/postgresql/config', { text: 'max_connections = nonsense\n', expectedRevision: read.revision }, refuse))
    expect(error?.code).toBe('CONFIG_TEST_FAILED')
    expect(fake.files.get(path)).toBe('port = 5432\n')
    expect(await (await call('/host/databases/services/postgresql/config', { text: 'max_connections = 50\n', expectedRevision: read.revision }, accept)).json()).toEqual({ saved: true })
    expect(fake.files.get(path)).toBe('max_connections = 50\n')
  })
  it('refuses to remove the rule the agent signs in with', async () => {
    const fake = pgHost()
    expect((await refused(call('/host/databases/services/postgresql/hba', { text: 'host all all all reject\n', expectedRevision: 'x' }, deps(fake))))?.detail.reason).toBe('postgresql_admin_rule_required')
  })
  it('restores the file when the server reports a line error', async () => {
    const fake = pgHost({ hbaErrors: '2\tinvalid auth method "nope"\n' }), path = '/etc/postgresql/14/main/pg_hba.conf', before = fake.files.get(path)
    const read = await (await call('/host/databases/services/postgresql/hba', undefined, deps(fake))).json() as { revision: string }
    const error = await refused(call('/host/databases/services/postgresql/hba', { text: 'local all postgres peer\nhost all all nope\n', expectedRevision: read.revision }, deps(fake)))
    expect(error?.code).toBe('CONFIG_TEST_FAILED')
    expect(fake.files.get(path)).toBe(before)
  })
})
