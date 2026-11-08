import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { accountRoleName, handleWhmDbToolsRoute, validateAdoptedUsers, validatePgOutcome, validatePushReport } from './whm-db-tools-workspace.ts'
import { handleAccountDbMaintenanceRoute } from './account-db-maintenance-workspace.ts'

const root = { principal: { kind: 'root', id: 'r', username: 'root' } }
const alice = { id: '11111111-1111-4111-8111-111111111111', username: 'alice', status: 'active' }
const bob = { id: '22222222-2222-4222-8222-222222222222', username: 'bob', status: 'active' }
const lock = { acquire: async () => ({ assertFencingToken: async () => undefined, release: async () => undefined }) }
const overview = { state: 'read', observedAt: '2026-11-07T10:00:00.000Z', version: '10.6.23-MariaDB', status: Object.fromEntries((await import('../../../packages/os/src/mariadb-admin-command.ts')).MARIADB_ADMIN_STATUS_NAMES.map(name => [name, 0])), schemas: [{ name: 'alice_shop', sizeBytes: 1, tables: 1 }, { name: 'legacy', sizeBytes: 1, tables: 1 }] }
const helpers = (rootDir: string, over: Record<string, unknown> = {}) => {
  const store = { rootDir, getWriterLock: () => lock, readSnapshot: async () => ({ accounts: [alice, bob], databases: [{ id: 'd1', accountId: bob.id, name: 'bob_x' }], databaseUsers: [{ id: 'u1', accountId: bob.id, name: 'bob_u', grants: [] }] }),
    createDatabase: vi.fn(async (input: { name: string }) => ({ id: 'new-' + input.name, name: input.name })), createDatabaseUser: vi.fn(async (input: { name: string }) => ({ id: 'user-' + input.name, name: input.name })), setGrant: vi.fn(async () => undefined),
    readAccountPostgresql: vi.fn(async (id: string) => ({ users: id === alice.id ? [] : [{ id: 'x' }], databases: [] })), createPostgresqlUser: vi.fn(async () => ({ name: 'x' })) }
  return { store, requireCaller: async () => root, assertRoot: vi.fn(async () => undefined), emitAudit: vi.fn(async () => undefined), triggerReconcile: vi.fn(async () => ({ ok: true, status: 200, body: {} })), readHost: vi.fn(async () => overview), callHost: vi.fn(async () => ({ users: [] })), ...over } as never as Parameters<typeof handleWhmDbToolsRoute>[3] & { store: typeof store; callHost: ReturnType<typeof vi.fn>; triggerReconcile: ReturnType<typeof vi.fn> }
}
const call = (path: string, method: string, input: Parameters<typeof handleWhmDbToolsRoute>[3], body?: unknown) => handleWhmDbToolsRoute(new Request('http://api' + path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }), new URL('http://api' + path), method, input)
const dir = () => mkdtemp(join(tmpdir(), 'db-tools-'))

describe('Database Map Tool', () => {
  const path = '/api/server/databases/ownership'
  it('assigns a server-only database and reconciles once', async () => {
    const state = await dir(), input = helpers(state)
    const reply = await (await call(path, 'POST', input, { account: 'alice', databases: ['alice_shop'], users: [] }))!.json() as Record<string, unknown>
    expect(reply).toMatchObject({ account: 'alice', databases: ['alice_shop'], application: { status: 'applied' } })
    expect(input.store.createDatabase).toHaveBeenCalledTimes(1); expect(input.triggerReconcile).toHaveBeenCalledTimes(1)
    await rm(state, { recursive: true, force: true })
  })
  it('returns already owned, never moving an object between accounts', async () => {
    const state = await dir(), input = helpers(state)
    await expect(call(path, 'POST', input, { account: 'alice', databases: ['bob_x'], users: [] })).rejects.toMatchObject({ detail: { reason: 'already_owned' } })
    await expect(call(path, 'POST', input, { account: 'alice', databases: [], users: ['bob_u'] })).rejects.toMatchObject({ detail: { reason: 'already_owned' } })
    expect(input.store.createDatabase).not.toHaveBeenCalled()
    await rm(state, { recursive: true, force: true })
  })
  it('refuses a name outside the prefix or not on the server, before any change', async () => {
    const state = await dir(), input = helpers(state)
    await expect(call(path, 'POST', input, { account: 'alice', databases: ['legacy'], users: [] })).rejects.toThrow(/must start with/)
    await expect(call(path, 'POST', input, { account: 'alice', databases: ['alice_gone'], users: [] })).rejects.toMatchObject({ detail: { reason: 'database_not_observed' } })
    expect(input.store.createDatabase).not.toHaveBeenCalled()
    await rm(state, { recursive: true, force: true })
  })
  it('keeps a mapped user grant on a mapped database and refuses a grant outside the account', async () => {
    const state = await dir(), user = { name: 'alice_app', authPlugin: 'mysql_native_password', authString: '*0123456789ABCDEF0123456789ABCDEF01234567', grants: [{ pattern: 'alice\\_shop', privileges: ['SELECT'] }] }
    const input = helpers(state, { callHost: vi.fn(async () => ({ users: [user] })) })
    await call(path, 'POST', input, { account: 'alice', databases: ['alice_shop'], users: ['alice_app'] })
    expect(input.store.setGrant).toHaveBeenCalledWith({ databaseUserId: 'user-alice_app', databaseId: 'new-alice_shop', privileges: ['SELECT'] }, expect.anything())
    const outside = helpers(state, { callHost: vi.fn(async () => ({ users: [{ ...user, grants: [{ pattern: 'other', privileges: ['SELECT'] }] }] })) })
    await expect(call(path, 'POST', outside, { account: 'alice', databases: ['alice_shop'], users: ['alice_app'] })).rejects.toMatchObject({ detail: { reason: 'database_user_grants_outside_account' } })
    expect(outside.store.createDatabase).not.toHaveBeenCalled()
    await rm(state, { recursive: true, force: true })
  })
  it('verifies the adoption reply', () => {
    expect(() => validateAdoptedUsers({ users: [{ name: 'other', authPlugin: 'ed25519', authString: 'x', grants: [] }] }, ['alice_app'])).toThrow()
  })
})

describe('Additional access hosts', () => {
  const path = '/api/server/databases/access-hosts'
  it('refuses a name, saves addresses and pushes only the saved list', async () => {
    const state = await dir(), input = helpers(state, { callHost: vi.fn(async () => ({ observedAt: '2026-11-07T10:00:00.000Z', accounts: [{ account: 'alice', state: 'applied', added: ['203.0.113.10'] }], pending: [] })) })
    const view = await (await call(path, 'GET', input))!.json() as { revision: string }
    await expect(call(path, 'PUT', input, { hosts: [{ host: 'DB.Example.com', comment: '' }], expectedRevision: view.revision })).rejects.toThrow(/DNS names are refused/)
    await expect(call(path + '/push', 'POST', input)).rejects.toThrow(/save at least one/)
    const saved = await (await call(path, 'PUT', input, { hosts: [{ host: '203.0.113.10', comment: 'office' }], expectedRevision: view.revision }))!.json() as { hosts: { host: string }[] }
    expect(saved.hosts.map(row => row.host)).toEqual(['203.0.113.10'])
    expect((await (await call(path + '/push', 'POST', input))!.json() as { accounts: unknown[] }).accounts).toHaveLength(1)
    expect((input.callHost.mock.calls[0]![2] as { hosts: { host: string }[] }).hosts[0]!.host).toBe('203.0.113.10')
    await rm(state, { recursive: true, force: true })
  })
  it('rejects an unverifiable push report as unknown', () => {
    expect(() => validatePushReport({ observedAt: 'x', accounts: [], pending: [] })).toThrow()
  })
})

describe('Tweak Settings: SQL route', () => {
  it('saves its keys, keeps other saved tweaks out of its way and refuses a stale revision', async () => {
    const state = await dir(), input = helpers(state), path = '/api/server/databases/settings', file = join(state, 'extended/server/tweak-settings.json')
    await mkdir(join(state, 'extended/server'), { recursive: true })
    await writeFile(file, '{}')
    const view = await (await call(path, 'GET', input))!.json() as { revision: string; autotuneLimits: boolean; innodbBufferPoolByRam: boolean }
    expect([view.autotuneLimits, view.innodbBufferPoolByRam]).toEqual([true, false])
    const saved = await (await call(path, 'PUT', input, { autotuneLimits: true, innodbBufferPoolByRam: true, expectedRevision: view.revision }))!.json() as { innodbBufferPoolByRam: boolean; application: { status: string } }
    expect(saved).toMatchObject({ innodbBufferPoolByRam: true, application: { status: 'applied' } })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ 'sql.innodbBufferPoolByRam': true })
    await expect(call(path, 'PUT', input, { autotuneLimits: false, innodbBufferPoolByRam: false, expectedRevision: view.revision })).rejects.toThrow(/reload/)
    await rm(state, { recursive: true, force: true })
  })
})

describe('Configure PostgreSQL', () => {
  const absent = { installed: false, package: null, service: null }
  const engines = { observedAt: '2026-11-07T10:00:00.000Z', family: 'debian', packages: 'read', redisConfig: null, mongodbConfig: null, postgresqlVersion: '14.24',
    products: { mariadb: absent, redis: absent, mongodb: absent, phpmyadmin: absent, phppgadmin: absent, postgresql: { installed: true, package: { name: 'postgresql', version: '14' }, service: { unit: 'postgresql.service', active: 'active', sub: 'running', enabled: 'enabled' } } } }
  it('creates the missing role once, without a known password, and reconciles once', async () => {
    const state = await dir(), input = helpers(state, { readHost: vi.fn(async () => engines) })
    const reply = await (await call('/api/server/databases/postgresql/roles', 'POST', input))!.json() as { created: string[] }
    expect(reply.created).toEqual(['alice'])
    const created = input.store.createPostgresqlUser.mock.calls[0] as unknown as [{ name: string; authString: string }]
    expect(created[0].name).toBe(accountRoleName('alice')); expect(created[0].authString).toMatch(/^SCRAM-SHA-256\$/)
    expect(input.triggerReconcile).toHaveBeenCalledTimes(1)
    await rm(state, { recursive: true, force: true })
  })
  it('refuses while PostgreSQL is not running', async () => {
    const state = await dir(), stopped = { ...engines, products: { ...engines.products, postgresql: { installed: false, package: null, service: null } } }
    await expect(call('/api/server/databases/postgresql/roles', 'POST', helpers(state, { readHost: vi.fn(async () => stopped) }))).rejects.toThrow(/not running/)
    await rm(state, { recursive: true, force: true })
  })
  it('verifies the password outcome and keeps the password out of every reply', async () => {
    const state = await dir(), outcome = { observedAt: '2026-11-07T10:00:00.000Z', serverPassword: 'verified', clientFile: { path: '/root/.pgpass', state: 'written' }, verificationRequired: false }
    const input = helpers(state, { callHost: vi.fn(async () => outcome) })
    const text = await (await call('/api/server/databases/postgresql/superuser-password', 'POST', input, { password: 'Str0ng-Password-1' }))!.text()
    expect(text).not.toContain('Str0ng'); expect(JSON.parse(text)).toEqual(outcome)
    expect(() => validatePgOutcome({ ...outcome, verificationRequired: true })).toThrow()
    await rm(state, { recursive: true, force: true })
  })
})

describe('account database maintenance', () => {
  const base = { requireCaller: async () => root as never, assertCanAccessAccount: vi.fn(async () => undefined), resolveAccountParam: async () => alice as never }
  const post = (body: unknown, helpers: Parameters<typeof handleAccountDbMaintenanceRoute>[3]) => handleAccountDbMaintenanceRoute(new Request('http://api/api/databases/alice/maintenance', { method: 'POST', body: JSON.stringify(body) }), new URL('http://api/api/databases/alice/maintenance'), 'POST', helpers)
  it('keeps its stable refusal without an agent and its namespace check', async () => {
    await expect(post({ database: 'alice_shop' }, base)).rejects.toMatchObject({ detail: { reason: 'database_maintenance_unavailable' } })
    await expect(post({ database: 'bob_shop' }, base)).rejects.toThrow(/outside account/)
  })
  it('refuses OPTIMIZE and PostgreSQL instead of running a check in their place', async () => {
    const maintainDatabase = vi.fn(async () => ({}))
    await expect(post({ database: 'alice_shop', operation: 'optimize' }, { ...base, maintainDatabase })).rejects.toMatchObject({ detail: { reason: 'database_maintenance_unavailable', stateChanged: false } })
    await expect(post({ database: 'alice_shop', engine: 'postgresql', operation: 'check' }, { ...base, maintainDatabase })).rejects.toMatchObject({ detail: { reason: 'database_maintenance_unavailable' } })
    expect(maintainDatabase).not.toHaveBeenCalled()
  })
  it('passes the verified agent report through', async () => {
    const report = { database: 'alice_shop', action: 'check', observedAt: '2026-11-07T10:00:00.000Z', tables: [{ name: 't1', engine: 'InnoDB', result: 'ok', message: 'OK' }] }
    const maintainDatabase = vi.fn(async () => report)
    expect(await (await post({ database: 'alice_shop' }, { ...base, maintainDatabase }))!.json()).toEqual(report)
    expect(maintainDatabase.mock.calls[0]).toEqual([root, alice, { database: 'alice_shop', action: 'check' }])
  })
})
