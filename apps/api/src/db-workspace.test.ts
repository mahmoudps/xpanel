import { describe, expect, it, vi } from 'vitest'
import type { Account } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { handleDbWorkspaceRoute, validateDbAccountPostgresql, validateDbEngines, validateDbSignon, validateDbUpgrade, validateDbWebClient } from './db-workspace.ts'
import type { DbWorkspacePorts } from './db-workspace.ts'

const id = '11111111-1111-4111-8111-111111111111', pid = '22222222-2222-4222-8222-222222222222', at = '2026-10-28T10:00:00.000Z'
const account = { id, username: 'alice', createdAt: at, status: 'active', planId: pid } as Account
const absent = { installed: false, package: null, service: null }
const engines = () => ({ observedAt: at, family: 'debian', packages: 'read', products: { mariadb: { installed: true, package: { name: 'mariadb-server', version: '1:10.11.6' }, service: { unit: 'mariadb.service', active: 'active', sub: 'running', enabled: 'enabled' } }, postgresql: absent, redis: absent, mongodb: absent, phpmyadmin: absent, phppgadmin: absent }, redisConfig: null, mongodbConfig: null, postgresqlVersion: null })
const signon = { client: 'phpmyadmin', action: 'https://panel.test:2083/phpmyadmin/xpanel-signon.php', ticket: 'A'.repeat(43), expiresAt: at, sessionExpiresAt: '2026-10-28T10:30:00.000Z' }
const webClient = { context: { accountId: id, username: 'alice' }, client: 'phpmyadmin', installed: true, signon: { state: 'ready', reason: null }, databases: 2, ticketSeconds: 60, sessionSeconds: 1800 }
const upgrade = { state: 'read', reason: null, observedAt: at, revision: 'a'.repeat(64), family: 'debian', installed: { name: 'mariadb-server', version: '1:10.11.6' }, running: '10.11.6-MariaDB', unit: { unit: 'mariadb.service', active: 'active' }, packages: [{ name: 'mariadb-server', current: '1:10.11.6', candidate: '1:10.11.11', origin: 'Debian', security: true, kernel: false, held: false, newInstall: false }], blocked: [], backupDirectory: '/var/backups/xpanel/mariadb-upgrade', canApply: true }

function setup(kind: 'root' | 'user' = 'user') {
  const user = { principal: { kind: 'user', accountId: id, id: pid, username: 'alice' }, sessionId: 's', apiTokenId: null, scopes: [] } as unknown as AuthenticatedCaller
  const root = { principal: { kind: 'root', id: pid, username: 'root' }, sessionId: 's', apiTokenId: null, scopes: [] } as unknown as AuthenticatedCaller
  const store = { getAccount: vi.fn(async () => account), getPlan: vi.fn(async () => ({ featureListId: pid })), getFeatureList: vi.fn(async () => ({ disabled: [] as string[] })) }
  const requireCaller = vi.fn(async () => kind === 'root' ? root : user), readAgent = vi.fn(async (): Promise<unknown> => engines())
  const assertRoot = vi.fn(async (caller: AuthenticatedCaller) => { if (caller.principal.kind !== 'root') throw Object.assign(new Error('root'), { code: 'FORBIDDEN' }) })
  const ports = { store: store as unknown as StateStore, requireCaller, readAgent, assertRoot } as DbWorkspacePorts
  const send = (path: string, method = 'GET', body?: unknown) => { const url = new URL('https://panel.test' + path); return handleDbWorkspaceRoute(new Request(url, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }), url, method, ports) }
  return { store, requireCaller, readAgent, assertRoot, send, root, user }
}

const dbId = '33333333-3333-4333-8333-333333333333', userId = '44444444-4444-4444-8444-444444444444'
const host = () => ({ context: { accountId: id, username: 'alice' }, observedAt: at, state: 'read', version: '16.4', databases: [{ name: 'alice_shop', owner: 'alice_app', sizeBytes: 8192 }], roles: [{ name: 'alice_app', login: true }], provisioning: 'available' })
function pgSetup(reply: unknown = host()) {
  const ctx = setup('user')
  const saved = { databases: [{ id: dbId, accountId: id, engine: 'postgresql', name: 'alice_shop', owner: 'alice_app', trashedAt: null }], users: [{ id: userId, accountId: id, name: 'alice_app' }] }
  const value = (name: string) => vi.fn(async (input: { name?: string; authString?: string }, _options?: unknown) => ({ name: input.name ?? name }))
  const store = Object.assign(ctx.store, {
    getPlan: vi.fn(async () => ({ featureListId: pid, caps: { databases: 5 } })), readAccountPostgresql: vi.fn(async () => saved), listDatabases: vi.fn(async () => [{}, {}]),
    createPostgresqlUser: value('alice_new'), setPostgresqlUserPassword: value('alice_app'), deletePostgresqlUser: value('alice_app'), createPostgresqlDatabase: value('alice_blog'), setPostgresqlDatabaseTrash: value('alice_shop'), purgePostgresqlDatabase: value('alice_shop'),
  })
  let started = 0
  const mutateDatabase = vi.fn(async (_req: Request, _caller: unknown, _account: unknown, _action: string, _kind: string, operation: (options: Record<string, unknown>) => Promise<{ name: string }>, _tool?: string) =>
    ({ value: await operation({ onMutationStarted: () => { started++ } }), application: { status: 'global_configuration_applied' as const, targetVerified: false as const } }))
  ctx.readAgent.mockResolvedValue(reply)
  const ports = { store: store as unknown as StateStore, requireCaller: ctx.requireCaller, readAgent: ctx.readAgent, assertRoot: ctx.assertRoot, mutateDatabase } as unknown as DbWorkspacePorts
  const send = (path: string, method = 'GET', body?: unknown) => { const url = new URL('https://panel.test' + path); return handleDbWorkspaceRoute(new Request(url, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }), url, method, ports) }
  return { ...ctx, store, mutateDatabase, send, get started() { return started } }
}

describe('database workspace reply validation', () => {
  it('rebuilds engine, web-client, sign-on, PostgreSQL and upgrade replies and rejects leaks', () => {
    expect(validateDbEngines(engines()).products.mariadb.service).toEqual({ unit: 'mariadb.service', active: 'active', sub: 'running', enabled: 'enabled' })
    for (const raw of [{ ...engines(), secret: 'x' }, { ...engines(), packages: 'unavailable' }, { ...engines(), products: { ...engines().products, redis: { installed: false, package: { name: 'redis', version: '1' }, service: null } } }]) expect(() => validateDbEngines(raw)).toThrow()
    expect(validateDbWebClient(webClient, account, 'phpmyadmin')).toMatchObject({ databases: 2, signon: { state: 'ready', reason: null } })
    expect(() => validateDbWebClient({ ...webClient, context: { accountId: 'other', username: 'bob' } }, account, 'phpmyadmin')).toThrow()
    expect(() => validateDbWebClient({ ...webClient, signon: { state: 'ready', reason: 'bridge-missing' } }, account, 'phpmyadmin')).toThrow()
    expect(validateDbSignon(signon)).toEqual(signon)
    for (const raw of [{ ...signon, password: 'x' }, { ...signon, action: 'http://panel.test/x.php' }, { ...signon, action: 'https://panel.test/x.php?ticket=1' }, { ...signon, ticket: 'short' }]) expect(() => validateDbSignon(raw)).toThrow()
    const pg = { context: { accountId: id, username: 'alice' }, observedAt: at, state: 'read', version: '16.4', databases: [{ name: 'alice_app', owner: 'alice', sizeBytes: 1 }], roles: [{ name: 'alice', login: true }], provisioning: 'available' }
    expect(validateDbAccountPostgresql(pg, account).databases).toHaveLength(1)
    expect(() => validateDbAccountPostgresql({ ...pg, provisioning: 'unavailable' }, account)).toThrow()
    expect(validateDbAccountPostgresql({ ...pg, state: 'stopped', databases: [], roles: [], provisioning: 'unavailable' }, account).provisioning).toBe('unavailable')
    expect(() => validateDbAccountPostgresql({ ...pg, databases: [{ name: 'bob_app', owner: 'bob', sizeBytes: 1 }] }, account)).toThrow()
    expect(() => validateDbAccountPostgresql({ ...pg, state: 'not-installed' }, account)).toThrow()
    expect(validateDbUpgrade(upgrade).canApply).toBe(true)
    expect(() => validateDbUpgrade({ ...upgrade, blocked: ['mariadb-server'] })).toThrow(); expect(() => validateDbUpgrade({ ...upgrade, backupDirectory: '/tmp' })).toThrow()
  })
})

describe('database workspace routes', () => {
  it('requires root before and after root reads and forwards no selector or body', async () => {
    const ctx = setup('root')
    expect((await ctx.send('/api/server/databases/engines'))!.status).toBe(200)
    expect(ctx.readAgent).toHaveBeenCalledWith(ctx.root, '/host/databases/engines', undefined, false, 'GET'); expect(ctx.assertRoot).toHaveBeenCalledTimes(2)
    const user = setup('user')
    await expect(user.send('/api/server/databases/engines')).rejects.toThrow('root'); expect(user.readAgent).not.toHaveBeenCalled()
    await expect(ctx.send('/api/server/databases/engines?x=1')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await ctx.send('/api/server/databases/engines', 'POST'))!.status).toBe(405)
  })
  it('submits the reviewed upgrade revision only and maps an unverifiable job reply to review', async () => {
    const ctx = setup('root'); ctx.readAgent.mockResolvedValue({ job: { id: 'job-1', kind: 'database.mariadb.upgrade', status: 'queued' } })
    const response = await ctx.send('/api/server/databases/upgrade/apply', 'POST', { expectedRevision: 'a'.repeat(64) })
    expect(response!.status).toBe(202); expect(ctx.readAgent).toHaveBeenCalledWith(ctx.root, '/host/databases/upgrade/apply', { expectedRevision: 'a'.repeat(64) }, true, 'POST')
    await expect(ctx.send('/api/server/databases/upgrade/apply', 'POST', { expectedRevision: 'a'.repeat(64), force: true })).rejects.toMatchObject({ code: 'VALIDATION' })
    ctx.readAgent.mockResolvedValue({ job: { id: 'job-1', kind: 'system.packages.upgrade' } })
    await expect(ctx.send('/api/server/databases/upgrade/apply', 'POST', { expectedRevision: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: expect.objectContaining({ unknownOutcome: true }) })
  })
  it('scopes account reads and sign-on to the session owner and its plan feature', async () => {
    const ctx = setup('user'); ctx.readAgent.mockResolvedValue(signon)
    expect(await (await ctx.send('/api/account/database-engines/phpmyadmin/sign-on', 'POST', {}))!.json()).toEqual(signon)
    expect(ctx.readAgent).toHaveBeenCalledWith(expect.anything(), '/accounts/alice/database-engines/phpmyadmin/sign-on', {}, true, 'POST')
    await expect(ctx.send('/api/account/database-engines/phpmyadmin/sign-on', 'POST', { accountId: id })).rejects.toMatchObject({ code: 'VALIDATION' })
    ctx.store.getFeatureList.mockResolvedValue({ disabled: ['phpmyadmin'] })
    await expect(ctx.send('/api/account/database-engines/phpmyadmin')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await ctx.send('/api/account/database-engines/phppgadmin/sign-on', 'POST', {})).toBeNull()
    const rootCaller = setup('root')
    await expect(rootCaller.send('/api/account/database-engines/postgresql')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('serves the saved PostgreSQL objects with the server reading and the shared database limit', async () => {
    const ctx = pgSetup()
    const view = await (await ctx.send('/api/account/database-engines/postgresql'))!.json()
    expect(view).toMatchObject({ state: 'read', provisioning: 'available', saved: { databases: [{ id: dbId, name: 'alice_shop', owner: 'alice_app', trashedAt: null }], users: [{ id: userId, name: 'alice_app' }], limit: { used: 3, max: 5 } } })
    expect(JSON.stringify(view)).not.toContain('SCRAM')
    expect(ctx.readAgent).toHaveBeenCalledWith(ctx.user, '/accounts/alice/database-engines/postgresql', undefined, false, 'GET')
  })
  it('saves only a SCRAM verifier and applies changes through the database pipeline with the PostgreSQL feature', async () => {
    const ctx = pgSetup()
    const response = await ctx.send('/api/account/database-engines/postgresql/users', 'POST', { name: 'alice_new', password: 'long enough secret' })
    expect(response!.status).toBe(201); expect(await response!.json()).toMatchObject({ stateChanged: true, kind: 'user', name: 'alice_new' })
    const [input] = ctx.store.createPostgresqlUser.mock.calls[0]!
    expect(input).toMatchObject({ accountId: id, name: 'alice_new' }); expect(input.authString).toMatch(/^SCRAM-SHA-256\$4096:/)
    expect(JSON.stringify(ctx.mutateDatabase.mock.calls)).not.toContain('long enough secret')
    expect(ctx.mutateDatabase.mock.calls[0]!.slice(3, 5)).toEqual(['database_user.postgresql.created', 'database-user']); expect(ctx.mutateDatabase.mock.calls[0]![6]).toBe('postgresql-databases')
    await ctx.send('/api/account/database-engines/postgresql/databases', 'POST', { name: 'alice_blog', owner: 'alice_app' })
    expect(ctx.store.createPostgresqlDatabase).toHaveBeenCalledWith({ accountId: id, name: 'alice_blog', owner: 'alice_app' }, expect.anything())
    await ctx.send(`/api/account/database-engines/postgresql/databases/${dbId}/trash`, 'POST', { expectedTrashedAt: null, confirmation: 'alice_shop' })
    expect(ctx.store.setPostgresqlDatabaseTrash).toHaveBeenCalledWith({ accountId: id, id: dbId, action: 'trash' }, expect.objectContaining({ stateGuard: { expectedTrashedAt: null, confirmation: 'alice_shop' } }))
    await ctx.send(`/api/account/database-engines/postgresql/users/${userId}/password`, 'POST', { password: 'another long secret' })
    expect(ctx.store.setPostgresqlUserPassword.mock.calls[0]![0].authString).toMatch(/^SCRAM-SHA-256\$/)
  })
  it('drops on the server before removing state, and refuses unverified drops, a stopped server and loose grammar', async () => {
    const ctx = pgSetup()
    ctx.readAgent.mockImplementation((async (_caller: unknown, path: string) => path.endsWith('/drop') ? { context: { accountId: id, username: 'alice' }, kind: 'user', name: 'alice_app', dropped: true } : host()) as never)
    await ctx.send(`/api/account/database-engines/postgresql/users/${userId}`, 'DELETE', { confirmation: 'alice_app' })
    expect(ctx.readAgent).toHaveBeenCalledWith(ctx.user, `/accounts/alice/database-engines/postgresql/users/${userId}/drop`, {}, true, 'POST')
    expect(ctx.store.deletePostgresqlUser).toHaveBeenCalledWith({ accountId: id, id: userId }, expect.anything()); expect(ctx.started).toBe(1)
    ctx.readAgent.mockImplementation((async (_caller: unknown, path: string) => path.endsWith('/drop') ? { dropped: true } : host()) as never)
    await expect(ctx.send(`/api/account/database-engines/postgresql/databases/${dbId}`, 'DELETE', { confirmation: 'alice_shop' })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: expect.objectContaining({ verificationRequired: true }) })
    expect(ctx.store.purgePostgresqlDatabase).not.toHaveBeenCalled()
    await expect(ctx.send(`/api/account/database-engines/postgresql/databases/${dbId}`, 'DELETE', { confirmation: 'alice_other' })).rejects.toMatchObject({ code: 'VALIDATION' })
    for (const [path, method, body] of [['/api/account/database-engines/postgresql/users', 'POST', { name: 'alice_x', password: 'long enough secret', databaseId: dbId }], ['/api/account/database-engines/postgresql/users', 'POST', { name: 'bob_x', password: 'long enough secret' }], ['/api/account/database-engines/postgresql/users', 'POST', { name: 'alice_x', password: 'short' }], ['/api/account/database-engines/postgresql/databases?accountId=1', 'POST', { name: 'alice_b', owner: 'alice_app' }]] as const) {
      await expect(ctx.send(path, method, body)).rejects.toMatchObject({ code: 'VALIDATION' })
    }
    expect((await ctx.send('/api/account/database-engines/postgresql/users', 'GET'))!.status).toBe(405)
    expect(await ctx.send(`/api/account/database-engines/postgresql/users/${userId}/trash`, 'POST', {})).toBeNull()
    const stopped = pgSetup({ ...host(), state: 'stopped', version: null, databases: [], roles: [], provisioning: 'unavailable' })
    await expect(stopped.send('/api/account/database-engines/postgresql/users', 'POST', { name: 'alice_new', password: 'long enough secret' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    expect(stopped.mutateDatabase).not.toHaveBeenCalled()
    stopped.store.getFeatureList.mockResolvedValue({ disabled: ['postgresql-databases'] })
    await expect(stopped.send('/api/account/database-engines/postgresql')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('withholds a sign-on when the owner binding changes after issue', async () => {
    const ctx = setup('user'); ctx.readAgent.mockResolvedValue(signon)
    let reads = 0; ctx.store.getAccount.mockImplementation(async () => (++reads > 2 ? { ...account, status: 'suspended' } : account) as Account)
    await expect(ctx.send('/api/account/database-engines/phpmyadmin/sign-on', 'POST', {})).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
