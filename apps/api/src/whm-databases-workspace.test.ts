import { describe, expect, it, vi } from 'vitest'
import type { AuthenticatedCaller } from './auth.ts'
import { handleWhmDatabasesWorkspaceRoute, projectAccountsObservation, projectOverviewObservation, projectWhmDatabaseOverview, projectWhmDatabaseUsers } from './whm-databases-workspace.ts'
import type { WhmDatabasesSaved, WhmDatabasesWorkspaceHelpers } from './whm-databases-workspace.ts'

const caller = { principal: { kind: 'root', id: 'root-principal', username: 'root' }, sessionId: 's1', apiTokenId: null } as unknown as AuthenticatedCaller
const at = '2026-10-27T10:00:00.000Z'
const status = { Uptime: 3600, Threads_connected: 3, Threads_running: 1, Connections: 120, Max_used_connections: 9, Aborted_connects: 0, Questions: 5000, Slow_queries: 2 }
const saved = (): WhmDatabasesSaved => ({
  accounts: [{ id: 'acc-b', username: 'beta', ownerId: null, status: 'active' }, { id: 'acc-a', username: 'alpha', ownerId: 'res-1', status: 'suspended' }],
  resellers: [{ id: 'res-1', username: 'agency' }],
  databases: [{ id: 'db-1', accountId: 'acc-a', engine: 'mariadb', name: 'alpha_wp', trashedAt: null }, { id: 'db-2', accountId: 'acc-a', engine: 'mariadb', name: 'alpha_old', trashedAt: '2026-10-20T00:00:00.000Z' }, { id: 'db-3', accountId: 'acc-b', engine: 'mariadb', name: 'beta_shop', trashedAt: null }],
  databaseUsers: [{ id: 'u-1', accountId: 'acc-a', name: 'alpha_app', grants: [{ databaseId: 'db-1', privileges: ['SELECT', 'INSERT'] }, { databaseId: 'db-2', privileges: ['SELECT'] }], authString: '*SECRETHASH' } as never, { id: 'u-2', accountId: 'acc-b', name: 'beta_ro', grants: [] }],
})
const overview = (schemas: unknown = [{ name: 'alpha_wp', sizeBytes: 4096, tables: 3 }, { name: 'alpha_old', sizeBytes: 100, tables: 1 }, { name: 'beta_shop', sizeBytes: 50, tables: 1 }, { name: 'stray_db', sizeBytes: 7, tables: 0 }, { name: 'information_schema', sizeBytes: 0, tables: 80 }]) => ({ state: 'read', observedAt: at, version: '10.11.6-MariaDB', status, schemas })
const accounts = { state: 'read', observedAt: at, accounts: [{ user: 'alpha_app', host: 'localhost', role: false }, { user: 'alpha_app', host: '%', role: false }, { user: 'root', host: 'localhost', role: false }, { user: 'reporting', host: '', role: true }, { user: '', host: 'localhost', role: false }] }
const processes = { state: 'read', observedAt: at, queryText: 'not-read', processes: [{ id: 5, user: 'alpha_app', host: 'localhost', db: 'alpha_wp', command: 'Query', timeSeconds: 12, threadState: 'Sending data', protected: false, protectedReason: null }, { id: 7, user: 'root', host: 'localhost', db: null, command: 'Sleep', timeSeconds: 1, threadState: '', protected: true, protectedReason: 'system-account' }] }
const servers = { observedAt: at, engine: 'mariadb', service: { state: 'active', unit: 'mariadb.service' }, configuration: { source: 'agent-client-configuration', protocol: 'socket', socket: '/run/mysqld/mysqld.sock' }, state: 'read', version: '10.11.6-MariaDB', variables: { port: 3306, socket: '/run/mysqld/mysqld.sock', bind_address: '127.0.0.1', skip_networking: 'OFF', max_connections: 151 } }
const host: Record<string, unknown> = { '/host/databases/overview': overview(), '/host/databases/users': accounts, '/host/databases/processes': processes, '/host/databases/servers': servers }

const helpers = (overrides: Partial<WhmDatabasesWorkspaceHelpers> = {}, events: string[] = []): WhmDatabasesWorkspaceHelpers => ({
  requireCaller: vi.fn(async () => { events.push('auth'); return caller }), assertRoot: vi.fn(async () => { events.push('root') }),
  emitAudit: vi.fn(async (input: { action: string }) => { events.push('audit:' + input.action) }), readSaved: vi.fn(async () => saved()),
  readHost: vi.fn(async (_caller, path) => { events.push('host:' + path); return host[path] }),
  killOnHost: vi.fn(async (_caller, body) => { events.push('kill'); return { ...body, outcome: 'confirmed', statementAccepted: true, after: 'absent', verificationRequired: false } }), ...overrides,
})
const get = async (path: string, h: WhmDatabasesWorkspaceHelpers) => { const url = new URL('http://localhost' + path); return handleWhmDatabasesWorkspaceRoute(new Request(url), url, 'GET', h) }
const post = (body: unknown, h: WhmDatabasesWorkspaceHelpers, type = 'application/json') => { const url = new URL('http://localhost/api/server/databases/processes/kill'); return handleWhmDatabasesWorkspaceRoute(new Request(url, { method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) }), url, 'POST', h) }

describe('WHM database drift projections', () => {
  it('labels saved counts separately and computes schema drift only from an actual read', () => {
    const result = projectWhmDatabaseOverview(saved(), projectOverviewObservation(overview()))
    expect(result.saved.accounts).toEqual([
      { account: 'alpha', owner: 'agency', status: 'suspended', databases: 1, trashedDatabases: 1, users: 1, grants: 2, observedSizeBytes: 4196 },
      { account: 'beta', owner: null, status: 'active', databases: 1, trashedDatabases: 0, users: 1, grants: 0, observedSizeBytes: 50 },
    ])
    expect(result.saved.totals).toEqual({ accounts: 2, databases: 2, trashedDatabases: 1, users: 2, grants: 2 })
    expect(result.databases.map(row => [row.name, row.account, row.drift])).toEqual([['alpha_old', 'alpha', 'in-sync'], ['alpha_wp', 'alpha', 'in-sync'], ['beta_shop', 'beta', 'in-sync'], ['information_schema', null, 'system'], ['stray_db', null, 'server-only']])
    expect(result.drift).toEqual({ savedOnly: 0, serverOnly: 1 })
    const missing = projectWhmDatabaseOverview(saved(), projectOverviewObservation(overview([{ name: 'alpha_wp', sizeBytes: 1, tables: 1 }])))
    expect(missing.databases.filter(row => row.drift === 'saved-only').map(row => row.name)).toEqual(['alpha_old', 'beta_shop'])
    const unread = projectWhmDatabaseOverview(saved(), { state: 'unavailable', observedAt: null, version: null, status: null, schemas: null })
    expect(unread.drift).toBeNull(); expect(new Set(unread.databases.map(row => row.drift))).toEqual(new Set(['unverified'])); expect(unread.saved.accounts[0]!.observedSizeBytes).toBeNull()
  })
  it('joins saved name@localhost users with observed accounts and never projects authentication strings', () => {
    const result = projectWhmDatabaseUsers(saved(), projectAccountsObservation(accounts))
    expect(result.users.map(row => [row.user, row.host, row.account, row.drift])).toEqual([['', 'localhost', null, 'server-only'], ['alpha_app', '%', null, 'server-only'], ['alpha_app', 'localhost', 'alpha', 'in-sync'], ['beta_ro', 'localhost', 'beta', 'saved-only'], ['reporting', '', null, 'server-only'], ['root', 'localhost', null, 'system']])
    expect(result.users.find(row => row.user === 'alpha_app' && row.host === 'localhost')!.grants).toEqual([{ database: 'alpha_wp', privileges: ['SELECT', 'INSERT'] }, { database: 'alpha_old', privileges: ['SELECT'] }])
    expect(result.drift).toEqual({ savedOnly: 1, serverOnly: 3 }); expect(result.ownerPage).toBe('/databases/mariadb')
    expect(JSON.stringify(result)).not.toMatch(/SECRETHASH|authString|acc-a|u-1/)
  })
})

describe('WHM database workspace routes', () => {
  it('serves saved state with an unavailable observation when the host read fails or is malformed', async () => {
    for (const bad of [new Error('agent down'), { ...overview(), state: 'read', status: null }, { ...overview(), version: '10.11 <b>' }, overview([{ name: 'a\u202eb', sizeBytes: 1, tables: 1 }]), overview([{ name: 'x', sizeBytes: 1, tables: 1 }, { name: 'x', sizeBytes: 1, tables: 1 }])]) {
      const response = await get('/api/server/databases/overview', helpers({ readHost: vi.fn(async () => { if (bad instanceof Error) throw bad; return bad }) }))
      const body = await response!.json()
      expect(body.observed).toMatchObject({ state: 'unavailable', observedAt: null, version: null, schemaCount: null }); expect(body.saved.totals.databases).toBe(2); expect(body.drift).toBeNull()
    }
    const partial = await (await get('/api/server/databases/overview', helpers({ readHost: vi.fn(async () => ({ ...overview(), state: 'partial', status: null })) })))!.json()
    expect(partial.observed).toMatchObject({ state: 'partial', status: null, version: '10.11.6-MariaDB', schemaCount: 5 })
  })
  it('projects processes with account owners and the configured engine with service state', async () => {
    const list = await (await get('/api/server/databases/processes', helpers()))!.json()
    expect(list.queryText).toBe('not-read'); expect(list.processes.map((row: { id: number; account: string | null }) => [row.id, row.account])).toEqual([[5, 'alpha'], [7, null]])
    const engines = await (await get('/api/server/databases/servers', helpers()))!.json()
    expect(engines.engines).toEqual([{ engine: 'mariadb', label: 'MariaDB', savedDatabases: 3, service: { state: 'active', unit: 'mariadb.service' }, configuration: { source: 'agent-client-configuration', protocol: 'socket', socket: '/run/mysqld/mysqld.sock' }, observed: { state: 'read', observedAt: at, version: '10.11.6-MariaDB', variables: servers.variables } }])
    const unsafe = await (await get('/api/server/databases/processes', helpers({ readHost: vi.fn(async () => ({ ...processes, queryText: 'SELECT secret' })) })))!.json()
    expect(unsafe).toMatchObject({ observed: { state: 'unavailable' }, processes: null })
  })
  it('returns 403 before saved or host reads and 422 for selectors', async () => {
    const denied = helpers({ assertRoot: vi.fn(async () => { throw Object.assign(new Error('root role is required'), { code: 'FORBIDDEN' }) }) })
    await expect(get('/api/server/databases/users', denied)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(post({ id: 5, mode: 'query', user: 'alpha_app', db: 'alpha_wp' }, denied)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(denied.readSaved).not.toHaveBeenCalled(); expect(denied.readHost).not.toHaveBeenCalled(); expect(denied.killOnHost).not.toHaveBeenCalled()
    for (const query of ['?account=alpha', '?sql=SELECT', '?path=/etc']) {
      const h = helpers()
      await expect(get('/api/server/databases/overview' + query, h)).rejects.toMatchObject({ code: 'VALIDATION' })
      expect(h.readHost).not.toHaveBeenCalled()
    }
    const h = helpers(), url = new URL('http://localhost/api/server/databases/overview')
    expect((await handleWhmDatabasesWorkspaceRoute(new Request(url, { method: 'DELETE' }), url, 'DELETE', h))!.status).toBe(405)
    expect(await get('/api/server/other', h)).toBeNull()
  })
  it('re-checks fresh root authority and audits around one host kill', async () => {
    const events: string[] = [], h = helpers({}, events)
    const body = await (await post({ id: 5, mode: 'connection', user: 'alpha_app', db: 'alpha_wp' }, h))!.json()
    expect(body).toEqual({ id: 5, mode: 'connection', user: 'alpha_app', db: 'alpha_wp', outcome: 'confirmed', statementAccepted: true, after: 'absent', verificationRequired: false })
    expect(events).toEqual(['auth', 'root', 'auth', 'root', 'audit:server.databases.kill_requested', 'kill', 'audit:server.databases.kill'])
  })
  it('refuses malformed kill bodies with 422 and changed authority before dispatch', async () => {
    for (const body of [{ id: '5', mode: 'query', user: 'a', db: null }, { id: 0, mode: 'query', user: 'a', db: null }, { id: 5, mode: 'kill', user: 'a', db: null }, { id: 5, mode: 'query', user: 'a' }, { id: 5, mode: 'query', user: 'a', db: null, statement: 'KILL 1' }, { id: 5, mode: 'query', user: 'a\u0000', db: null }, '{bad', 'x'.repeat(3000)]) {
      const h = helpers()
      await expect(post(body, h)).rejects.toMatchObject({ code: 'VALIDATION', detail: { stateChanged: false } })
      expect(h.killOnHost).not.toHaveBeenCalled()
    }
    await expect(post({ id: 5, mode: 'query', user: 'a', db: null }, helpers(), 'text/plain')).rejects.toMatchObject({ code: 'VALIDATION' })
    let calls = 0
    const changed = helpers({ requireCaller: vi.fn(async () => (++calls === 1 ? caller : { ...caller, sessionId: 's2' }) as AuthenticatedCaller) })
    await expect(post({ id: 5, mode: 'query', user: 'a', db: null }, changed)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const unaudited = helpers({ emitAudit: vi.fn(async () => { throw new Error('audit down') }) })
    await expect(post({ id: 5, mode: 'query', user: 'a', db: null }, unaudited)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    for (const h of [changed, unaudited]) expect(h.killOnHost).not.toHaveBeenCalled()
  })
  it('passes attempted outcomes through and treats an unverifiable host reply as unknown', async () => {
    const attempted = await (await post({ id: 5, mode: 'query', user: 'alpha_app', db: 'alpha_wp' }, helpers({ killOnHost: vi.fn(async (_caller, body) => ({ ...body, outcome: 'attempted', statementAccepted: false, after: 'active', verificationRequired: true })) })))!.json()
    expect(attempted).toMatchObject({ outcome: 'attempted', verificationRequired: true })
    const events: string[] = [], refused = helpers({ killOnHost: vi.fn(async () => { throw Object.assign(new Error('changed'), { code: 'CONFLICT' }) }) }, events)
    await expect(post({ id: 5, mode: 'query', user: 'alpha_app', db: 'alpha_wp' }, refused)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(events.slice(-2)).toEqual(['audit:server.databases.kill_requested', 'audit:server.databases.kill'])
    for (const reply of [{ id: 6, mode: 'query', user: 'alpha_app', db: 'alpha_wp', outcome: 'confirmed', statementAccepted: true, after: 'absent', verificationRequired: false }, { id: 5, mode: 'query', user: 'alpha_app', db: 'alpha_wp', outcome: 'confirmed', statementAccepted: false, after: 'absent', verificationRequired: false }, { id: 5, mode: 'query', user: 'alpha_app', db: 'alpha_wp', outcome: 'attempted', statementAccepted: true, after: 'active', verificationRequired: false }, null]) {
      await expect(post({ id: 5, mode: 'query', user: 'alpha_app', db: 'alpha_wp' }, helpers({ killOnHost: vi.fn(async () => reply) }))).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true, verificationRequired: true } })
    }
  })
})
