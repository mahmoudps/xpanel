import { describe, expect, it, vi } from 'vitest'
import { handleDbAdminToolsRoute, PG_PASS_FILE, pgSuperuserVerifySql, pushDatabaseAccessHosts, readAdoptableUser, renderPgPass, setPostgresqlSuperuserPassword } from './db-admin-tools.ts'
import { compileMariadbServerConfig, innodbBufferPoolMb, mariadbDropInPath, mariadbRestartActions, observeMariadbHost, renderMariadbDropIn } from './db-server-config.ts'
import { createProductionHostTargetMatcher } from './executor.ts'
import { handleAccountDbMaintenanceRoute } from './db-maintenance.ts'
import { parseTweakValues } from '@xpanel/core'
import type { HostAction, OsProfile } from '@xpanel/core'

const client = (answers: readonly string[]) => { let index = 0; return { socketPath: null, query: vi.fn(async () => answers[index++] ?? '') } }
const now = () => new Date('2026-11-07T10:00:00.000Z')

describe('Database Map Tool: reading a server-only user', () => {
  it('returns the stored hash and database grants, never touching other users', async () => {
    const sql = client(['mysql_native_password\t*0123456789ABCDEF0123456789ABCDEF01234567\n', 'GRANT USAGE ON *.* TO `alice_app`@`localhost`\nGRANT SELECT, INSERT ON `alice\\\\_shop`.* TO `alice_app`@`localhost`\n'])
    const user = await readAdoptableUser(sql, 'alice', 'alice_app')
    expect(user).toMatchObject({ name: 'alice_app', authPlugin: 'mysql_native_password', grants: [{ pattern: 'alice\\_shop', privileges: ['SELECT', 'INSERT'] }] })
    expect((sql.query.mock.calls as unknown[][])[0]![0]).toEqual(["SELECT plugin, authentication_string FROM mysql.user WHERE User = 'alice_app' AND Host = 'localhost'"])
  })
  it('refuses a missing user, an unsaved sign-in method and a grant the model cannot keep', async () => {
    await expect(readAdoptableUser(client(['']), 'alice', 'alice_app')).rejects.toThrow(/not on the server/)
    await expect(readAdoptableUser(client(['unix_socket\t\n']), 'alice', 'alice_app')).rejects.toThrow(/authentication method/)
    await expect(readAdoptableUser(client(['mysql_native_password\t*0123456789ABCDEF0123456789ABCDEF01234567\n', 'GRANT SELECT ON *.* TO `alice_app`@`localhost`\n']), 'alice', 'alice_app')).rejects.toThrow(/grants xPanel does not save/)
    await expect(readAdoptableUser(client([]), 'alice', 'bob_app')).rejects.toThrow()
  })
})

describe('PostgreSQL superuser password', () => {
  const host = (existing: string | null, writable = true) => ({ readFile: vi.fn(async () => existing), writeFile: vi.fn(async () => { if (!writable) throw new Error('disk') }) })
  it('verifies inside the server, then saves /root/.pgpass with escaped fields and mode 0600', async () => {
    const run = vi.fn(async (_action: HostAction) => undefined), files = host(null)
    const outcome = await setPostgresqlSuperuserPassword(run, files, 'pa:ss\\word1', now)
    expect(outcome).toEqual({ observedAt: '2026-11-07T10:00:00.000Z', serverPassword: 'verified', clientFile: { path: PG_PASS_FILE, state: 'written' }, verificationRequired: false })
    const statements = run.mock.calls.flatMap(([action]) => action.kind === 'sql' ? action.statements : [])
    expect(statements[0]).toMatch(/^ALTER ROLE "postgres" WITH PASSWORD 'SCRAM-SHA-256\$4096:/)
    expect(statements.join()).not.toContain('pa:ss')
    expect(files.writeFile.mock.calls[0]).toEqual([{ path: PG_PASS_FILE, content: renderPgPass('pa:ss\\word1'), mode: 0o600, owner: 'root', group: 'root' }])
    expect(renderPgPass('a:b\\c').split('\n')[1]).toBe('*:*:*:postgres:a\\:b\\\\c')
  })
  it('refuses an edited file before any change and reports an unverified change as unknown', async () => {
    const run = vi.fn(async () => undefined)
    await expect(setPostgresqlSuperuserPassword(run, host('localhost:5432:*:postgres:x\n'), 'password1', now)).rejects.toThrow(/not written by xPanel/)
    expect(run).not.toHaveBeenCalled()
    const failing = vi.fn(async (action: HostAction) => { if (action.kind === 'sql' && action.statements[0]!.startsWith('SELECT')) throw new Error('mismatch') })
    await expect(setPostgresqlSuperuserPassword(failing, host(null), 'password1', now)).rejects.toMatchObject({ detail: { unknownOutcome: true } })
  })
  it('reports a saved server password whose client file failed', async () => {
    expect((await setPostgresqlSuperuserPassword(vi.fn(async () => undefined), host(null, false), 'password1', now))).toMatchObject({ clientFile: { state: 'failed' }, verificationRequired: true })
    expect(pgSuperuserVerifySql('x')[0]).toContain('1 / COUNT(*)')
  })
})

describe('access host push', () => {
  const account = (username: string, status = 'active', entries: unknown[] = []) => ({ id: username, username, status, databaseRemoteAccess: entries })
  const store = (accounts: ReturnType<typeof account>[]) => ({ listAccounts: async () => accounts, readDatabaseRemoteAccess: vi.fn(async (id: string) => { throw new Error('unreadable ' + id) }), withDatabaseRemoteAccessLease: vi.fn() })
  it('skips inactive accounts, reports a failed account and keeps going', async () => {
    const backing = store([account('alice'), account('bob', 'suspended')])
    const report = await pushDatabaseAccessHosts({ store: backing as never, native: { qualified: true } as never, authorize: async () => undefined, audit: async () => undefined, now }, [{ host: '203.0.113.10', comment: '' }])
    expect(report).toEqual({ observedAt: '2026-11-07T10:00:00.000Z', accounts: [{ account: 'alice', state: 'failed', added: [] }], pending: [] })
  })
  it('refuses a push without the qualified provider and any host name', async () => {
    const ctx = { caller: { principalId: 'r', actor: 'root', role: 'root', accountId: null, resellerId: null }, reauthenticate: async () => ({ principalId: 'r', actor: 'root', role: 'root', accountId: null, resellerId: null }), assertRoot: async () => undefined, audit: async () => undefined, store: store([]) } as unknown as Parameters<typeof handleDbAdminToolsRoute>[3]
    const post = (body: unknown) => handleDbAdminToolsRoute(new Request('http://agent/host/databases/access-hosts/push', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), new URL('http://agent/host/databases/access-hosts/push'), 'POST', ctx)
    await expect(post({ hosts: [{ host: '203.0.113.10', comment: '', createdAt: '2026-11-07T10:00:00.000Z' }] })).rejects.toThrow(/recovery is unavailable/)
    await expect(post({ hosts: [{ host: 'DB.Example.com', comment: '', createdAt: '2026-11-07T10:00:00.000Z' }] })).rejects.toThrow(/DNS names are refused/)
  })
})

describe('Tweak Settings: SQL', () => {
  const debian = { family: 'debian', services: { mariadb: 'mariadb' } } as unknown as OsProfile
  const on = parseTweakValues({ 'sql.innodbBufferPoolByRam': true })
  it('renders only the switched-on values and keeps the pool in whole chunks', () => {
    expect(renderMariadbDropIn({ tweaks: parseTweakValues(null), memoryMb: 2048 }, { family: 'debian' })).toContain('max_allowed_packet = 256M')
    expect(renderMariadbDropIn({ tweaks: parseTweakValues(null), memoryMb: 2048 }, { family: 'debian' })).not.toContain('innodb_buffer_pool_size')
    expect(renderMariadbDropIn({ tweaks: on, memoryMb: 8000 }, { family: 'debian' })).toContain('innodb_buffer_pool_size = 1920M')
    expect(renderMariadbDropIn({ tweaks: on, memoryMb: null }, { family: 'debian' })).not.toContain('innodb_buffer_pool_size')
    expect(renderMariadbDropIn({ tweaks: parseTweakValues({ 'sql.autotuneLimits': false }), memoryMb: 1024 }, { family: 'debian' })).not.toContain('open_files_limit')
    expect(renderMariadbDropIn({ tweaks: parseTweakValues(null), memoryMb: 1024 }, { family: 'rhel' })).not.toContain('slow_query_log')
    expect(renderMariadbDropIn({ tweaks: parseTweakValues({ 'sql.slowQueryLog': true, 'sql.longQueryTime': 5 }), memoryMb: 1024 }, { family: 'rhel' })).toContain('slow_query_log = 1\nlong_query_time = 5\nslow_query_log_file = /var/log/mariadb/mariadb-slow.log\n')
    expect(innodbBufferPoolMb(1024)).toBe(256)
    expect(innodbBufferPoolMb(400)).toBe(128)
  })
  it('checks the configuration, restarts only on a change and stays inside the host targets', () => {
    const { files, postActions } = compileMariadbServerConfig(debian, { tweaks: on, memoryMb: 1024 }), hash = (text: string) => 'h' + text.length
    expect(postActions).toEqual([{ kind: 'exec', argv: ['/usr/sbin/mariadbd', '--verbose', '--help'] }])
    expect(mariadbRestartActions(debian, files, [{ path: mariadbDropInPath(debian), sha256: hash(files[0]!.content) }], hash)).toEqual([])
    expect(mariadbRestartActions(debian, files, undefined, hash)).toEqual([{ kind: 'systemd', verb: 'restart', unit: 'mariadb' }])
    expect(createProductionHostTargetMatcher()(files[0]!.path, 'write')).toBe(true)
    expect(createProductionHostTargetMatcher()(mariadbDropInPath({ family: 'rhel' }), 'write')).toBe(true)
  })
  it('stays out of a host without MariaDB and reads memory from the kernel', async () => {
    const executor = (ok: boolean) => ({ runCommand: vi.fn(async () => ({ ok, code: ok ? 0 : 1, stdout: '', stderr: '' })), readFile: vi.fn(async () => 'MemTotal:        2097152 kB\nMemFree: 1 kB\n') })
    expect(await observeMariadbHost(executor(false), '/nonexistent')).toBeUndefined()
    expect((await observeMariadbHost(executor(true), '/nonexistent'))?.memoryMb).toBe(2048)
  })
})

describe('account database maintenance route', () => {
  const account = { id: 'a1', username: 'alice', status: 'active' }
  const call = (body: unknown, over: Record<string, unknown> = {}) => handleAccountDbMaintenanceRoute(new Request('http://agent/accounts/alice/databases/maintenance', { method: 'POST', body: JSON.stringify(body) }), new URL('http://agent/accounts/alice/databases/maintenance'), 'POST', {
    caller: { principalId: 'p', actor: 'alice', role: 'user', accountId: 'a1', resellerId: null }, store: { getAccountByUsername: async () => account as never, listDatabases: async () => [{ name: 'alice_shop' }] }, assertAccount: async () => undefined, audit: async () => undefined, ...over,
  } as Parameters<typeof handleAccountDbMaintenanceRoute>[3])
  it('reaches only a database saved on the account', async () => {
    await expect(call({ database: 'alice_other', action: 'repair' }, { mariadb: client([]) })).rejects.toThrow(/does not belong/)
    await expect(call({ database: 'alice_shop', action: 'check' })).rejects.toThrow(/not connected/)
    const report = await (await call({ database: 'alice_shop', action: 'check' }, { mariadb: client(['t1\tInnoDB\n', 'alice_shop.t1\tcheck\tstatus\tOK\n']) }))!.json() as { tables: { result: string }[] }
    expect(report.tables[0]?.result).toBe('ok')
  })
})
