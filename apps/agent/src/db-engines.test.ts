import { describe, expect, it } from 'vitest'
import { handleDbEnginesRoute, parseDbUnit, parseMongodConfig, parsePgAccountDatabases, parseRedisConfig, readAccountPostgresql, readDbEngines, readDbPackages } from './db-engines.ts'
import type { DbEnginesRouteDeps, DbRun } from './db-engines.ts'

const show = (unit: string, load = 'loaded', active = 'active') => `Id=${unit}\nNames=${unit}\nLoadState=${load}\nActiveState=${active}\nSubState=${active === 'active' ? 'running' : 'dead'}\nUnitFileState=${load === 'loaded' ? 'enabled' : ''}\n`
const dpkg = (rows: string[]) => rows.map(row => row + '\tinstall ok installed\n').join('')
function host(packages: string[], units: Record<string, string> = {}, sql: Record<string, string> = {}): { run: DbRun; calls: string[][] } {
  const calls: string[][] = []
  return { calls, run: async argv => {
    calls.push([...argv])
    if (argv[0] === '/usr/bin/dpkg-query') return { ok: true, code: 0, stdout: dpkg(packages), stderr: '' }
    if (argv[0] === '/usr/bin/systemctl') { const unit = argv.at(-1)!; return { ok: true, code: 0, stdout: units[unit] ?? show(unit, 'not-found', 'inactive'), stderr: '' } }
    if (argv[0] === '/usr/sbin/runuser') { const key = Object.keys(sql).find(text => argv.at(-1)!.includes(text)); return key ? { ok: true, code: 0, stdout: sql[key]!, stderr: '' } : { ok: false, code: 2, stdout: '', stderr: 'connection refused' } }
    return { ok: false, code: 1, stdout: '', stderr: '' }
  } }
}

describe('database engine parsers', () => {
  it('reads redis.conf facts without keeping the password and refuses malformed values', () => {
    const facts = parseRedisConfig('# comment\nport 6380\nbind 127.0.0.1 -::1\nprotected-mode yes\nmaxmemory 256MB\nmaxmemory-policy allkeys-lru\nrequirepass "s3cret value"\ninclude /etc/redis/extra.conf\nappendonly no\nport 6379\n')
    expect(facts).toEqual({ port: 6379, bind: ['127.0.0.1', '-::1'], protectedMode: 'yes', unixSocket: null, maxmemory: '256mb', maxmemoryPolicy: 'allkeys-lru', requirePass: true, aclFile: false, appendOnly: 'no', includes: 1 })
    expect(JSON.stringify(facts)).not.toContain('s3cret')
    for (const text of ['port 70000\n', 'bind 127.0.0.1;rm\n', 'protected-mode maybe\n', 'port 6379\u0000\n']) expect(() => parseRedisConfig(text)).toThrow()
  })
  it('reads the documented mongod.conf block options and refuses unsupported YAML', () => {
    expect(parseMongodConfig('storage:\n  dbPath: /var/lib/mongo\nnet:\n  port: 27018\n  bindIp: 127.0.0.1,::1  # local only\nsecurity:\n  authorization: "enabled"\n')).toEqual({ port: 27018, bindIp: '127.0.0.1,::1', authorization: 'enabled', dbPath: '/var/lib/mongo' })
    expect(parseMongodConfig('# empty\n')).toEqual({ port: null, bindIp: null, authorization: null, dbPath: null })
    for (const text of ['net: {port: 1}\n', 'net:\n\tport: 1\n', 'security:\n  authorization: maybe\n']) expect(() => parseMongodConfig(text)).toThrow()
  })
  it('parses systemctl show for loaded and missing units', () => {
    expect(parseDbUnit(show('mongod.service'), 'mongod.service')).toMatchObject({ load: 'loaded', active: 'active', enabled: 'enabled' })
    expect(parseDbUnit(show('mongod.service', 'not-found', 'inactive'), 'mongod.service')).toMatchObject({ load: 'not-found', enabled: 'unknown' })
    expect(() => parseDbUnit(show('other.service'), 'mongod.service')).toThrow()
  })
  it('accepts only account-prefixed PostgreSQL databases', () => {
    expect(parsePgAccountDatabases('alice_app\talice\t8192\n', 'alice')).toEqual([{ name: 'alice_app', owner: 'alice', sizeBytes: 8192 }])
    for (const text of ['bob_app\tbob\t1\n', 'alice_app\talice\n', 'alice_app\talice\t-1\n']) expect(() => parsePgAccountDatabases(text, 'alice')).toThrow()
  })
})

describe('database engine observation', () => {
  it('reports installed products, the active unit and config facts; absent products stay absent', async () => {
    const { run } = host(['mariadb-server\t1:10.11.6-0+deb12u1', 'valkey-server\t8.0.2', 'postgresql-16\t16.4-1'], { 'mariadb.service': show('mariadb.service'), 'valkey-server.service': show('valkey-server.service'), 'postgresql@16-main.service': show('postgresql@16-main.service') }, { 'SHOW server_version': '16.4 (Debian 16.4-1)\n' })
    const files: Record<string, string> = { '/etc/valkey/valkey.conf': 'port 6379\nrequirepass x\n' }
    const observed = await readDbEngines({ family: 'debian', run, readFile: async path => files[path] ?? null, now: () => new Date('2026-10-28T00:00:00Z') })
    expect(observed.products.mariadb).toEqual({ installed: true, package: { name: 'mariadb-server', version: '1:10.11.6-0+deb12u1' }, service: { unit: 'mariadb.service', active: 'active', sub: 'running', enabled: 'enabled' } })
    expect(observed.products.mongodb).toEqual({ installed: false, package: null, service: null })
    expect(observed.redisConfig).toMatchObject({ path: '/etc/valkey/valkey.conf', state: 'read', facts: { port: 6379, requirePass: true } })
    expect(observed.postgresqlVersion).toBe('16.4 (Debian 16.4-1)')
    expect(observed.mongodbConfig).toBeNull()
  })
  it('is unavailable, never empty-success, when the package database cannot be read', async () => {
    const observed = await readDbPackages({ family: 'debian', run: async () => ({ ok: false, code: 2, stdout: '', stderr: '' }) })
    expect(observed.state).toBe('unavailable'); expect(observed.products.redis.installed).toBeNull()
    expect((await readDbPackages({ family: null, run: null })).state).toBe('unavailable')
  })
  it('reads account PostgreSQL objects only when the server is installed and running', async () => {
    expect((await readAccountPostgresql({ family: 'debian', run: host([]).run, username: 'alice' })).state).toBe('not-installed')
    expect((await readAccountPostgresql({ family: 'debian', run: host(['postgresql-16\t16.4-1'], { 'postgresql@16-main.service': show('postgresql@16-main.service', 'loaded', 'inactive') }).run, username: 'alice' })).state).toBe('stopped')
    const running = host(['postgresql-16\t16.4-1'], { 'postgresql@16-main.service': show('postgresql@16-main.service') }, { 'SHOW server_version': '16.4\n', 'pg_database_size': 'alice_app\talice\t9000\n', 'rolcanlogin': 'alice\tt\nalice_ro\tf\n' })
    const read = await readAccountPostgresql({ family: 'debian', run: running.run, username: 'alice' })
    expect(read).toMatchObject({ state: 'read', version: '16.4', provisioning: 'available', databases: [{ name: 'alice_app', sizeBytes: 9000 }], roles: [{ name: 'alice', login: true }, { name: 'alice_ro', login: false }] })
    expect(running.calls.filter(argv => argv[0] === '/usr/sbin/runuser').every(argv => argv.at(-1) === 'SHOW server_version' || argv.at(-1)!.includes("'alice"))).toBe(true)
    const foreign = host(['postgresql-16\t16.4-1'], { 'postgresql@16-main.service': show('postgresql@16-main.service') }, { 'SHOW server_version': '16.4\n', 'pg_database_size': 'bob_app\tbob\t1\n', 'rolcanlogin': '' })
    expect((await readAccountPostgresql({ family: 'debian', run: foreign.run, username: 'alice' })).state).toBe('unavailable')
  })
})

describe('database engine route authorization', () => {
  const accountId = '11111111-1111-4111-8111-111111111111'
  const deps = (over: Partial<DbEnginesRouteDeps> = {}, disabled: string[] = []): DbEnginesRouteDeps => ({
    caller: { principalId: 'p1', actor: 'alice', role: 'user', accountId, resellerId: null },
    store: { getAccountByUsername: async name => name === 'alice' ? { id: accountId, username: 'alice', status: 'active', planId: 'plan', createdAt: '2026-01-01T00:00:00.000Z' } as never : null, getPlan: async () => ({ featureListId: 'f' }) as never, getFeatureList: async () => ({ id: 'f', name: 'f', ownerId: null, disabled }), readDatabaseRemoteAccess: async () => ({ databases: [], users: [] }) as never, readAccountPostgresql: async () => saved },
    currentPrincipal: async () => ({ kind: 'user', id: 'p1', username: 'alice', accountId, disabled: false }),
    assertRoot: async () => { throw Object.assign(new Error('root required'), { code: 'FORBIDDEN' }) }, family: 'debian', run: host([]).run, readFile: async () => null, runPostgresql: null, ...over,
  })
  const dbId = '22222222-2222-4222-8222-222222222222', userId = '33333333-3333-4333-8333-333333333333'
  let saved: Awaited<ReturnType<DbEnginesRouteDeps['store']['readAccountPostgresql']>> = { databases: [], users: [] }
  const call = (path: string, d: DbEnginesRouteDeps, method = 'GET', body?: string) => handleDbEnginesRoute(new Request('http://agent' + path, { method, ...(body === undefined ? {} : { body }) }), new URL('http://agent' + path), method, d)
  const running = (databases: string, roles: string) => host(['postgresql-16\t16.4-1'], { 'postgresql@16-main.service': show('postgresql@16-main.service') }, { 'SHOW server_version': '16.4\n', 'pg_database_size': databases, 'rolcanlogin': roles }).run
  it('drops a trashed saved database and an owner-free saved user, verified by a fresh read', async () => {
    saved = { databases: [{ id: dbId, accountId, engine: 'postgresql', name: 'alice_shop', owner: 'alice_app', trashedAt: '2026-10-28T10:00:00.000Z' }], users: [{ id: userId, accountId, name: 'alice_app' }] }
    const sql: string[][] = []
    let dropped = false
    const d = deps({ run: argv => (dropped ? running('', 'alice_app\tt\n') : running('alice_shop\talice_app\t8192\n', 'alice_app\tt\n'))(argv), runPostgresql: async statements => { sql.push(statements); dropped = true } })
    const response = await call(`/accounts/alice/database-engines/postgresql/databases/${dbId}/drop`, d, 'POST', '{}')
    expect(await response!.json()).toEqual({ context: { accountId, username: 'alice' }, kind: 'database', name: 'alice_shop', dropped: true })
    expect(sql).toEqual([['DROP DATABASE IF EXISTS "alice_shop" WITH (FORCE);']])
    await expect(call(`/accounts/alice/database-engines/postgresql/users/${userId}/drop`, d, 'POST', '{}')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    saved = { databases: [], users: saved.users }
    const roleGone = deps({ run: running('', ''), runPostgresql: async statements => { sql.push(statements) } })
    expect(await (await call(`/accounts/alice/database-engines/postgresql/users/${userId}/drop`, roleGone, 'POST', '{}'))!.json()).toMatchObject({ kind: 'user', name: 'alice_app', dropped: true })
    expect(sql.at(-1)).toEqual([`SELECT 'DROP OWNED BY "alice_app"' FROM pg_catalog.pg_roles WHERE rolname = 'alice_app'\\gexec`, 'DROP ROLE IF EXISTS "alice_app";'])
  })
  it('refuses live databases, unknown ids, extra fields, a stopped server and an unverified drop', async () => {
    saved = { databases: [{ id: dbId, accountId, engine: 'postgresql', name: 'alice_shop', owner: 'alice_app', trashedAt: null }], users: [{ id: userId, accountId, name: 'alice_app' }] }
    const path = `/accounts/alice/database-engines/postgresql/databases/${dbId}/drop`, runPostgresql = async () => undefined
    await expect(call(path, deps({ run: running('', ''), runPostgresql }), 'POST', '{}')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(call(path.replace(dbId, userId), deps({ run: running('', ''), runPostgresql }), 'POST', '{}')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(call(path, deps({ run: running('', ''), runPostgresql }), 'POST', '{"force":true}')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await call(path, deps(), 'GET'))!.status).toBe(405)
    saved = { ...saved, databases: [{ ...saved.databases[0]!, trashedAt: '2026-10-28T10:00:00.000Z' }] }
    await expect(call(path, deps({ runPostgresql }), 'POST', '{}')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    const stays = running('alice_shop\talice_app\t1\n', '')
    await expect(call(path, deps({ run: stays, runPostgresql: async () => { throw Object.assign(new Error('x'), { code: 'CONFIG_TEST_FAILED' }) } }), 'POST', '{}')).rejects.toMatchObject({ detail: { stateChanged: false, verificationRequired: true } })
    await expect(call(path, deps({ run: stays, runPostgresql }), 'POST', '{}')).rejects.toMatchObject({ detail: { verificationRequired: true } })
    await expect(call(path, deps({ run: stays, runPostgresql }, ['postgresql-databases']), 'POST', '{}')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('serves the owner and refuses other accounts, disabled features, selectors and non-root host reads', async () => {
    const response = await call('/accounts/alice/database-engines/postgresql', deps())
    expect(await response!.json()).toMatchObject({ context: { accountId, username: 'alice' }, state: 'not-installed', provisioning: 'unavailable' })
    await expect(call('/accounts/bob/database-engines/postgresql', deps())).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(call('/accounts/alice/database-engines/postgresql', deps({}, ['postgresql-databases']))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(call('/accounts/alice/database-engines/postgresql', deps({ currentPrincipal: async () => ({ kind: 'user', id: 'p1', username: 'alice', accountId, disabled: true }) }))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(call('/accounts/alice/database-engines/postgresql?all=1', deps())).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('/host/databases/engines', deps())).rejects.toThrow('root required')
    expect((await call('/host/databases/engines', deps(), 'POST'))!.status).toBe(405)
    expect(await call('/host/other', deps())).toBeNull()
  })
})
