import { describe, expect, it, vi } from 'vitest'
import { MARIADB_ADMIN_ACCOUNTS_SQL, MARIADB_ADMIN_PROCESSLIST_SQL, MARIADB_ADMIN_SCHEMAS_SQL, MARIADB_ADMIN_STATUS_SQL, MARIADB_ADMIN_VARIABLES_SQL, MARIADB_ADMIN_VERSION_SQL, isMariadbAdminStatement } from '../../../packages/os/src/mariadb-admin-command.ts'
import { handleMariadbAdminRoute, parseMariadbAccounts, parseMariadbBatch, parseMariadbProcesslist, parseMariadbSchemas, parseMariadbStatus, parseMariadbVariables, parseMariadbVersion, readMariadbOverview } from './mariadb-admin.ts'
import type { MariadbAdminRouteContext } from './mariadb-admin.ts'
import type { AgentCallerIdentity } from './server.ts'

const lines = (...rows: string[][]): string => rows.map(row => row.join('\t') + '\n').join('')
const status = lines(['Uptime', '3600'], ['Threads_connected', '3'], ['Threads_running', '1'], ['Connections', '120'], ['Max_used_connections', '9'], ['Aborted_connects', '0'], ['Questions', '5000'], ['Slow_queries', '2'])
const variables = lines(['port', '3306'], ['socket', '/run/mysqld/mysqld.sock'], ['bind_address', '127.0.0.1'], ['skip_networking', 'OFF'], ['max_connections', '151'])
const proc = (id: number, user: string, db: string, command = 'Query', self = '0', admin = '0') => [String(id), user, 'localhost', db, command, '12', 'Sending data', self, admin]
const root: AgentCallerIdentity = { principalId: '00000000-0000-4000-8000-000000000001', actor: 'root', role: 'root', accountId: null, resellerId: null }

const fakeClient = (overrides: Partial<Record<string, string | Error>> = {}) => {
  let processes = [proc(5, 'alpha_app', 'alpha_wp'), proc(6, 'alpha_app', '', 'Sleep'), proc(7, 'root', ''), proc(8, 'xpadmin', '', 'Query', '1', '1'), proc(9, 'beta', 'beta_db', 'Binlog Dump')]
  const answers: Record<string, string | Error | undefined> = {
    [MARIADB_ADMIN_VERSION_SQL]: '10.11.6-MariaDB-0ubuntu0.24.04.1\n', [MARIADB_ADMIN_STATUS_SQL]: status, [MARIADB_ADMIN_VARIABLES_SQL]: variables,
    [MARIADB_ADMIN_SCHEMAS_SQL]: lines(['alpha_wp', '16384', '2'], ['information_schema', '0', '80'], ['stray_db', '0', '0']),
    [MARIADB_ADMIN_ACCOUNTS_SQL]: lines(['alpha_app', 'localhost', 'N'], ['root', 'localhost', 'N'], ['reporting', '', 'Y']), ...overrides,
  }
  const query = vi.fn(async (statements: readonly string[]) => {
    const sql = statements[0]!
    expect(statements).toHaveLength(1); expect(isMariadbAdminStatement(sql)).toBe(true)
    if (sql === MARIADB_ADMIN_PROCESSLIST_SQL) return lines(...processes)
    if (sql.startsWith('KILL ')) { const answer = answers.kill; if (answer instanceof Error) throw answer; const id = sql.split(' ')[2]; processes = processes.filter(row => answer === 'keep' || row[0] !== id); return '' }
    const answer = answers[sql]
    if (answer instanceof Error) throw answer
    return answer ?? ''
  })
  return { query, socketPath: '/run/mysqld/mysqld.sock' as string | null, setProcesses: (rows: string[][]) => { processes = rows } }
}
const context = (overrides: Partial<MariadbAdminRouteContext> = {}): MariadbAdminRouteContext => ({
  caller: root, reauthenticate: vi.fn(async () => root), assertRoot: vi.fn(async (caller: AgentCallerIdentity) => { if (caller.role !== 'root') throw Object.assign(new Error('denied'), { code: 'FORBIDDEN' }) }),
  audit: vi.fn(async () => undefined), mariadb: fakeClient(), readServices: async () => [{ id: 'mariadb', label: 'MariaDB', unit: 'mariadb.service', state: 'active' }],
  now: () => new Date('2026-10-27T10:00:00Z'), ...overrides,
})
const call = (path: string, ctx: MariadbAdminRouteContext, init: RequestInit = {}) => {
  const url = new URL('http://agent.local' + path)
  return handleMariadbAdminRoute(new Request(url, init), url, (init.method ?? 'GET').toUpperCase(), ctx)
}
const kill = (body: unknown, ctx: MariadbAdminRouteContext) => call('/host/databases/processes/kill', ctx, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('MariaDB batch output parsing', () => {
  it('decodes the documented backslash escape and refuses controls, ragged rows and truncated output', () => {
    expect(parseMariadbBatch('a\\\\b\tc\n', 2)).toEqual([['a\\b', 'c']])
    expect(parseMariadbBatch('', 2)).toEqual([])
    for (const bad of ['a\\nb\tc\n', 'a\\tb\tc\n', 'a\\0\tc\n', 'a\tb\tc\n', 'a\tb', 'a\tb\r\n', 'a\u202eb\tc\n', 'a\\\tc\n']) expect(() => parseMariadbBatch(bad, 2)).toThrow()
    expect(() => parseMariadbBatch('x\n'.repeat(5001), 1)).toThrow('mariadb_result_capacity')
    expect(parseMariadbBatch('x\n'.repeat(5000), 1)).toHaveLength(5000)
  })
  it('parses each fixed result shape and rejects malformed values', () => {
    expect(parseMariadbVersion('10.11.6-MariaDB-log\n')).toBe('10.11.6-MariaDB-log')
    for (const bad of ['', 'NULL\n', '10.11.6 MariaDB\n', '10.11.6\n10.11.7\n']) expect(() => parseMariadbVersion(bad)).toThrow()
    expect(parseMariadbStatus(status)).toMatchObject({ Uptime: 3600, Threads_connected: 3, Slow_queries: 2 })
    expect(() => parseMariadbStatus(status.replace('Uptime\t3600', 'Uptime\t-1'))).toThrow()
    expect(() => parseMariadbStatus(status + 'Uptime\t1\n')).toThrow()
    expect(() => parseMariadbStatus(lines(['Uptime', '1']))).toThrow()
    expect(() => parseMariadbStatus(status.replace('Slow_queries', 'Com_select'))).toThrow()
    expect(parseMariadbVariables(variables)).toEqual({ port: 3306, socket: '/run/mysqld/mysqld.sock', bind_address: '127.0.0.1', skip_networking: 'OFF', max_connections: 151 })
    expect(() => parseMariadbVariables(variables.replace('3306', '70000'))).toThrow()
    expect(() => parseMariadbVariables(variables.replace('OFF', 'maybe'))).toThrow()
    expect(parseMariadbSchemas(lines(['a_db', '10', '1']))).toEqual([{ name: 'a_db', sizeBytes: 10, tables: 1 }])
    for (const bad of [lines(['a_db', '10', '1'], ['a_db', '1', '1']), lines(['', '0', '0']), lines(['a_db', '1e3', '1']), lines(['a_db', '99999999999999999', '1'])]) expect(() => parseMariadbSchemas(bad)).toThrow()
    expect(parseMariadbAccounts(lines(['r', '', 'Y'], ['', 'localhost', 'N']))).toEqual([{ user: 'r', host: '', role: true }, { user: '', host: 'localhost', role: false }])
    expect(() => parseMariadbAccounts(lines(['r', '%', 'yes']))).toThrow()
    expect(() => parseMariadbProcesslist(lines(proc(0, 'a', '')))).toThrow()
    expect(() => parseMariadbProcesslist(lines(proc(1, 'a', ''), proc(1, 'b', '')))).toThrow()
    expect(() => parseMariadbProcesslist(lines([...proc(1, 'a', '').slice(0, 7), '1', 'x']))).toThrow()
  })
  it('classifies protected threads and keeps an empty database as none', () => {
    const rows = parseMariadbProcesslist(lines(proc(5, 'alpha_app', 'alpha_wp'), proc(6, 'alpha_app', ''), proc(7, 'root', ''), proc(8, 'xpadmin', '', 'Query', '1', '1'), proc(10, 'xpadmin', '', 'Query', '0', '1'), proc(9, 'beta', '', 'Binlog Dump'), proc(11, 'system user', '', 'Daemon')))
    expect(rows.map(row => [row.id, row.db, row.protectedReason])).toEqual([[5, 'alpha_wp', null], [6, null, null], [7, null, 'system-account'], [8, null, 'agent-session'], [10, null, 'agent-account'], [9, null, 'replication-or-daemon'], [11, null, 'system-account']])
  })
})

describe('MariaDB observation routes', () => {
  it('reports read, partial and unavailable observations truthfully', async () => {
    expect((await readMariadbOverview(null)).state).toBe('unavailable')
    const ctx = context({ mariadb: fakeClient({ [MARIADB_ADMIN_STATUS_SQL]: new Error('Access denied for user') }) })
    const body = await (await call('/host/databases/overview', ctx))!.json()
    expect(body).toMatchObject({ state: 'partial', version: '10.11.6-MariaDB-0ubuntu0.24.04.1', status: null, observedAt: '2026-10-27T10:00:00.000Z' })
    expect(JSON.stringify(body)).not.toContain('Access denied')
    const full = await (await call('/host/databases/overview', context()))!.json() as { state: string; schemas: unknown[] }
    expect(full.state).toBe('read'); expect(full.schemas).toContainEqual({ name: 'stray_db', sizeBytes: 0, tables: 0 })
    const malformed = await (await call('/host/databases/users', context({ mariadb: fakeClient({ [MARIADB_ADMIN_ACCOUNTS_SQL]: 'alpha\tlocalhost\n' }) })))!.json()
    expect(malformed).toEqual({ state: 'unavailable', observedAt: '2026-10-27T10:00:00.000Z', accounts: null })
  })
  it('returns processes without query text and the server configuration labelled as client configuration', async () => {
    const processes = await (await call('/host/databases/processes', context()))!.json() as { queryText: string; processes: unknown[] }
    expect(processes.queryText).toBe('not-read'); expect(processes.processes).toHaveLength(5)
    expect(JSON.stringify(processes)).not.toMatch(/INFO|SELECT/)
    const servers = await (await call('/host/databases/servers', context()))!.json()
    expect(servers).toMatchObject({ engine: 'mariadb', state: 'read', service: { state: 'active', unit: 'mariadb.service' }, configuration: { source: 'agent-client-configuration', protocol: 'socket', socket: '/run/mysqld/mysqld.sock' }, variables: { port: 3306 } })
    const bare = await (await call('/host/databases/servers', context({ mariadb: undefined, readServices: undefined })))!.json()
    expect(bare).toMatchObject({ state: 'unavailable', service: null, configuration: null, version: null, variables: null })
  })
  it('refuses non-root callers, selectors and wrong methods before any SQL', async () => {
    const ctx = context({ caller: { ...root, role: 'user' } })
    await expect(call('/host/databases/overview', ctx)).rejects.toThrow('denied')
    expect((ctx.mariadb!.query as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
    const selectors = context()
    await expect(call('/host/databases/processes?user=root', selectors)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await call('/host/databases/overview', selectors, { method: 'POST' }))!.status).toBe(405)
    expect(await call('/host/other', selectors)).toBeNull()
    expect((selectors.mariadb!.query as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })
})

describe('MariaDB process kill', () => {
  it('kills one re-read identity after fresh authority and confirms by re-read', async () => {
    const ctx = context()
    const body = await (await kill({ id: 5, mode: 'connection', user: 'alpha_app', db: 'alpha_wp' }, ctx))!.json()
    expect(body).toEqual({ id: 5, mode: 'connection', user: 'alpha_app', db: 'alpha_wp', outcome: 'confirmed', statementAccepted: true, after: 'absent', verificationRequired: false })
    const statements = (ctx.mariadb!.query as ReturnType<typeof vi.fn>).mock.calls.map(([sql]) => sql[0])
    expect(statements).toEqual([MARIADB_ADMIN_PROCESSLIST_SQL, 'KILL CONNECTION 5', MARIADB_ADMIN_PROCESSLIST_SQL])
    expect(ctx.reauthenticate).toHaveBeenCalledTimes(1)
    expect((ctx.audit as ReturnType<typeof vi.fn>).mock.calls.map(([entry]) => [entry.action, entry.outcome])).toEqual([['host.databases.kill_requested', 'ok'], ['host.databases.kill', 'ok']])
  })
  it('returns 409 for a changed identity and refuses protected or idle targets without KILL', async () => {
    for (const [request, code] of [[{ id: 5, mode: 'query', user: 'alpha_app', db: null }, 'CONFLICT'], [{ id: 5, mode: 'query', user: 'beta', db: 'alpha_wp' }, 'CONFLICT'], [{ id: 404, mode: 'query', user: 'x', db: null }, 'CONFLICT'],
      [{ id: 7, mode: 'query', user: 'root', db: null }, 'FORBIDDEN'], [{ id: 8, mode: 'connection', user: 'xpadmin', db: null }, 'FORBIDDEN'], [{ id: 9, mode: 'connection', user: 'beta', db: 'beta_db' }, 'FORBIDDEN'], [{ id: 6, mode: 'query', user: 'alpha_app', db: null }, 'CONFLICT']] as const) {
      const ctx = context()
      await expect(kill(request, ctx)).rejects.toMatchObject({ code, detail: { stateChanged: false } })
      expect((ctx.mariadb!.query as ReturnType<typeof vi.fn>).mock.calls.some(([sql]) => sql[0].startsWith('KILL'))).toBe(false)
      expect(ctx.audit).not.toHaveBeenCalled()
    }
  })
  it('reports attempted when the effect is not proven or the statement errored', async () => {
    const kept = await (await kill({ id: 5, mode: 'connection', user: 'alpha_app', db: 'alpha_wp' }, context({ mariadb: fakeClient({ kill: 'keep' }) })))!.json()
    expect(kept).toMatchObject({ outcome: 'attempted', after: 'active', statementAccepted: true, verificationRequired: true })
    const errored = await (await kill({ id: 5, mode: 'query', user: 'alpha_app', db: 'alpha_wp' }, context({ mariadb: fakeClient({ kill: new Error('timeout') }) })))!.json()
    expect(errored).toMatchObject({ outcome: 'attempted', statementAccepted: false, after: 'active', verificationRequired: true })
    const client = fakeClient()
    const ctx = context({ mariadb: client })
    const queryKill = vi.spyOn(client, 'query')
    queryKill.mockImplementationOnce(async () => lines(proc(5, 'alpha_app', 'alpha_wp'))).mockImplementationOnce(async () => '').mockImplementationOnce(async () => lines(proc(5, 'alpha_app', 'alpha_wp', 'Sleep')))
    expect(await (await kill({ id: 5, mode: 'query', user: 'alpha_app', db: 'alpha_wp' }, ctx))!.json()).toMatchObject({ outcome: 'confirmed', after: 'idle' })
  })
  it('refuses changed authority, unaudited dispatch and malformed bodies', async () => {
    const changed = context({ reauthenticate: async () => ({ ...root, principalId: '00000000-0000-4000-8000-000000000002' }) })
    await expect(kill({ id: 5, mode: 'connection', user: 'alpha_app', db: 'alpha_wp' }, changed)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const unaudited = context({ audit: vi.fn(async () => { throw new Error('disk') }) })
    await expect(kill({ id: 5, mode: 'connection', user: 'alpha_app', db: 'alpha_wp' }, unaudited)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    for (const ctx of [changed, unaudited]) expect((ctx.mariadb!.query as ReturnType<typeof vi.fn>).mock.calls.some(([sql]) => sql[0].startsWith('KILL'))).toBe(false)
    for (const body of [{ id: '5', mode: 'query', user: 'a', db: null }, { id: 5, mode: 'all', user: 'a', db: null }, { id: 5, mode: 'query', user: 'a' }, { id: 5, mode: 'query', user: 'a', db: null, sql: 'DROP' }, { id: 5.5, mode: 'query', user: 'a', db: null }, { id: 5, mode: 'query', user: 'a\nb', db: null }, { id: 5, mode: 'query', user: 'a', db: '' }]) {
      await expect(kill(body, context())).rejects.toMatchObject({ code: 'VALIDATION' })
    }
    await expect(kill({ id: 5, mode: 'query', user: 'a', db: null }, context({ mariadb: undefined }))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
})
