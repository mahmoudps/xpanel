import { describe, expect, it, vi } from 'vitest'
import { handleDbMaintenanceRoute, isManagedRootClientFile, mariadbMaintenanceSql, mariadbTablesSql, parseDbMaintenanceRequest, parseRootPasswordRequest, renderRootClientFile, rootPasswordMatchesSql, rootPasswordSql, setMariadbRootPassword, summarizeMaintenance } from './db-maintenance.ts'
import type { DbMaintenanceRouteContext, RootPasswordHost } from './db-maintenance.ts'
import type { AgentCallerIdentity } from './server.ts'

const lines = (...rows: string[][]): string => rows.map(row => row.join('\t') + '\n').join('')
const root: AgentCallerIdentity = { principalId: '00000000-0000-4000-8000-000000000001', actor: 'root', role: 'root', accountId: null, resellerId: null }
const user: AgentCallerIdentity = { principalId: '00000000-0000-4000-8000-000000000002', actor: 'alice', role: 'user', accountId: 'a1', resellerId: null }

const fakeMariadb = (answers: (sql: string) => string | Error) => {
  const query = vi.fn(async (statements: readonly string[], _opts?: { timeoutMs?: number }) => { expect(statements).toHaveLength(1); const answer = answers(statements[0]!); if (answer instanceof Error) throw answer; return answer })
  return { query, socketPath: '/run/mysqld/mysqld.sock' as string | null }
}
const fakeHost = (content: string | null = null): RootPasswordHost & { written: { path: string; content: string; mode: number }[] } => {
  const written: { path: string; content: string; mode: number }[] = []
  return { written, readFile: vi.fn(async () => content), writeFile: vi.fn(async (file: { path: string; content: string; mode: number }) => { written.push(file) }) }
}
const context = (overrides: Partial<DbMaintenanceRouteContext> = {}): DbMaintenanceRouteContext => ({
  caller: root, reauthenticate: vi.fn(async () => root), audit: vi.fn(async () => undefined), now: () => new Date('2026-11-07T10:00:00.000Z'),
  assertRoot: vi.fn(async (caller: AgentCallerIdentity) => { if (caller.role !== 'root') throw Object.assign(new Error('denied'), { code: 'FORBIDDEN' }) }), ...overrides,
})
const post = (path: string, ctx: DbMaintenanceRouteContext, body: unknown, method = 'POST') => {
  const url = new URL('http://agent.local' + path)
  return handleDbMaintenanceRoute(new Request(url, method === 'GET' ? {} : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), url, method, ctx)
}

describe('database maintenance statements', () => {
  it('accepts only exact non-system requests and quotes every identifier', () => {
    expect(parseDbMaintenanceRequest({ database: 'alice_shop', action: 'repair' })).toEqual({ database: 'alice_shop', action: 'repair' })
    for (const bad of [{ database: 'mysql', action: 'check' }, { database: 'Information_Schema', action: 'check' }, { database: 'a b', action: 'check' }, { database: 'x`y', action: 'check' }, { database: 'alice_shop', action: 'optimize' }, { database: 'alice_shop', action: 'check', extra: 1 }]) {
      expect(() => parseDbMaintenanceRequest(bad)).toThrow()
    }
    expect(mariadbTablesSql('alice_shop')).toBe("SELECT TABLE_NAME, COALESCE(ENGINE, '') FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'alice_shop' AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME LIMIT 1001")
    expect(mariadbMaintenanceSql('repair', 'alice_shop', ['t1', 'we`ird'])).toBe('REPAIR TABLE `alice_shop`.`t1`, `alice_shop`.`we``ird`')
  })
  it('reports a repaired crashed MyISAM table, unsupported InnoDB, a corrupt check and a missing row', () => {
    const tables = [{ name: 'posts', engine: 'MyISAM' }, { name: 'users', engine: 'InnoDB' }, { name: 'clean', engine: 'MyISAM' }, { name: 'gone', engine: 'MyISAM' }]
    const repair = summarizeMaintenance('repair', 'alice_shop', tables, [
      ['alice_shop.posts', 'repair', 'warning', 'Number of rows changed from 2 to 3'], ['alice_shop.posts', 'repair', 'status', 'OK'],
      ['alice_shop.users', 'repair', 'note', "The storage engine for the table doesn't support repair"], ['alice_shop.clean', 'repair', 'status', 'OK'],
    ])
    expect(repair.map(table => table.result)).toEqual(['repaired', 'not-supported', 'ok', 'failed'])
    expect(summarizeMaintenance('check', 'alice_shop', [tables[0]!], [['alice_shop.posts', 'check', 'warning', 'Table is marked as crashed'], ['alice_shop.posts', 'check', 'error', 'Corrupt']])[0]).toMatchObject({ result: 'corrupt', message: 'Corrupt' })
  })
})

describe('database maintenance route', () => {
  it('refuses non-root callers before reading the body and lists then repairs every table', async () => {
    await expect(post('/host/databases/maintenance', context({ caller: user }), { database: 'alice_shop', action: 'repair' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const mariadb = fakeMariadb(sql => sql.startsWith('SELECT') ? lines(['posts', 'MyISAM'], ['users', 'InnoDB']) : lines(['alice_shop.posts', 'repair', 'status', 'OK'], ['alice_shop.users', 'repair', 'note', "The storage engine for the table doesn't support repair"]))
    const ctx = context({ mariadb })
    const reply = await (await post('/host/databases/maintenance', ctx, { database: 'alice_shop', action: 'repair' }))!.json()
    expect(reply).toEqual({ database: 'alice_shop', action: 'repair', observedAt: '2026-11-07T10:00:00.000Z', tables: [{ name: 'posts', engine: 'MyISAM', result: 'ok', message: 'OK' }, { name: 'users', engine: 'InnoDB', result: 'not-supported', message: "The storage engine for the table doesn't support repair" }] })
    expect(mariadb.query.mock.calls[1]![0]).toEqual(['REPAIR TABLE `alice_shop`.`posts`, `alice_shop`.`users`'])
    expect(mariadb.query.mock.calls[1]![1]).toEqual({ timeoutMs: 150_000 })
    expect(vi.mocked(ctx.audit).mock.calls.map(call => call[0].action)).toEqual(['host.databases.repair_requested', 'host.databases.repair'])
  })
  it('runs nothing when the tables cannot be read and reports an unread repair result as unknown', async () => {
    const unread = context({ mariadb: fakeMariadb(() => new Error('socket')) })
    await expect(post('/host/databases/maintenance', unread, { database: 'alice_shop', action: 'repair' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    const failed = context({ mariadb: fakeMariadb(sql => sql.startsWith('SELECT') ? lines(['posts', 'MyISAM']) : new Error('lost')) })
    await expect(post('/host/databases/maintenance', failed, { database: 'alice_shop', action: 'repair' })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, unknownOutcome: true } })
    await expect(post('/host/databases/maintenance', context(), { database: 'alice_shop', action: 'check' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
})

describe('MariaDB root password', () => {
  const password = 'N3w"Pass\\word!'
  it('keeps the password out of quoting and verifies the stored hash inside the server', () => {
    expect(rootPasswordSql('abc12345')).toBe("ALTER USER 'root'@'localhost' IDENTIFIED VIA unix_socket OR mysql_native_password USING PASSWORD(X'6162633132333435')")
    expect(rootPasswordMatchesSql('abc12345')).toContain("INSTR(Priv, PASSWORD(X'6162633132333435')) > 0")
    expect(renderRootClientFile(password)).toBe('# managed by xPanel: MariaDB root client password\n[client]\nuser=root\npassword="N3w\\"Pass\\\\word!"\n')
    expect(isManagedRootClientFile(null)).toBe(true); expect(isManagedRootClientFile('[client]\npassword=x\n')).toBe(false)
    for (const bad of [{ password: 'short' }, { password: 'has space here' }, { password: 'ümlaut-pass' }, { password: 'ok-password', extra: 1 }]) expect(() => parseRootPasswordRequest(bad)).toThrow()
  })
  it('changes the password, verifies it and writes the managed root client file 0600', async () => {
    const mariadb = fakeMariadb(sql => sql.startsWith('ALTER') ? '' : '1\n'), host = fakeHost()
    const outcome = await setMariadbRootPassword(mariadb, host, password, () => new Date('2026-11-07T10:00:00.000Z'))
    expect(outcome).toEqual({ observedAt: '2026-11-07T10:00:00.000Z', serverPassword: 'verified', clientFile: { path: '/root/.my.cnf', state: 'written' }, socketAccess: 'verified', verificationRequired: false })
    expect(host.written).toEqual([expect.objectContaining({ path: '/root/.my.cnf', mode: 0o600, owner: 'root', group: 'root' })])
  })
  it('refuses an unmanaged client file before any statement and never echoes server errors', async () => {
    const mariadb = fakeMariadb(() => ''), host = fakeHost('[client]\npassword=old\n')
    await expect(setMariadbRootPassword(mariadb, host, password)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'root_client_file_unmanaged', stateChanged: false } })
    expect(mariadb.query).not.toHaveBeenCalled()
    const leaking = fakeMariadb(() => new Error("near 'X'4e33'' at line 1"))
    const error = await setMariadbRootPassword(leaking, fakeHost(), password).catch(caught => caught as Error)
    expect(error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true } })
    expect(JSON.stringify(error) + String((error as Error).message)).not.toMatch(/4e33|N3w/)
    await expect(setMariadbRootPassword(fakeMariadb(sql => sql.startsWith('ALTER') ? '' : '0\n'), fakeHost(), password)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  })
  it('reports a client file that could not be written as needing verification', async () => {
    const host = { ...fakeHost(), writeFile: vi.fn(async () => { throw new Error('ro') }) }
    expect(await setMariadbRootPassword(fakeMariadb(sql => sql.startsWith('ALTER') ? '' : '1\n'), host, password)).toMatchObject({ clientFile: { state: 'failed' }, verificationRequired: true })
  })
  it('reads the client file state without its content and audits the change without the password', async () => {
    const ctx = context({ mariadb: fakeMariadb(sql => sql.startsWith('ALTER') ? '' : '1\n'), host: fakeHost('[client]\npassword=secret\n') })
    expect(await (await post('/host/databases/root-password', ctx, undefined, 'GET'))!.json()).toEqual({ clientFile: { path: '/root/.my.cnf', state: 'unmanaged' }, mariadb: 'connected' })
    const writable = context({ mariadb: fakeMariadb(sql => sql.startsWith('ALTER') ? '' : '1\n'), host: fakeHost() })
    expect((await post('/host/databases/root-password', writable, { password }))!.status).toBe(200)
    expect(JSON.stringify(vi.mocked(writable.audit).mock.calls)).not.toContain('N3w')
  })
})
