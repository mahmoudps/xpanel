import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DB_SIGNON_CONFIG_PATH, groupGid, handleDbSignonRoute, issueDbSignon, parseDbSignonConfig, readDbSignonStatus, reapDbSignon, renderPhpMyAdminSignonBridge, renderPhpMyAdminSignonConfig } from './db-signon.ts'
import type { DbSignonFs, DbSignonRouteDeps, DbSignonSql } from './db-signon.ts'

const configJson = { phpmyadmin: { signonUrl: 'https://panel.example.test:2083/phpmyadmin/xpanel-signon.php', returnUrl: 'https://panel.example.test:2083/databases/phpmyadmin', ticketDirectory: '/var/lib/xpanel/db-signon', ticketGroup: 'www-data', bridgePath: '/usr/share/phpmyadmin/xpanel-signon.php', configPath: '/etc/phpmyadmin/conf.d/xpanel-signon.php' } }
const config = parseDbSignonConfig(JSON.stringify(configJson))
function memoryFs(over: Record<string, string | null> = {}, mode = 0o730): DbSignonFs & { files: Map<string, string>; tickets: Map<string, { content: string; gid: number; mtimeMs: number }> } {
  const files = new Map<string, string>(Object.entries({ [DB_SIGNON_CONFIG_PATH]: JSON.stringify(configJson), [config.bridgePath]: renderPhpMyAdminSignonBridge(config), [config.configPath]: renderPhpMyAdminSignonConfig(config), '/etc/group': 'root:x:0:\nwww-data:x:33:\n', ...over }).filter((entry): entry is [string, string] => entry[1] !== null))
  const tickets = new Map<string, { content: string; gid: number; mtimeMs: number }>()
  return { files, tickets,
    readFile: async path => path.startsWith(config.ticketDirectory + '/') ? tickets.get(path.slice(config.ticketDirectory.length + 1))?.content ?? null : files.get(path) ?? null,
    lstat: async path => path === config.ticketDirectory ? { isDirectory: true, isSymbolicLink: false, uid: 0, gid: 33, mode: 0o40000 | mode } : null,
    writeTicket: async (_dir, name, content, gid) => { tickets.set(name, { content, gid, mtimeMs: Date.parse('2026-10-28T10:00:00Z') }) },
    listTickets: async () => [...tickets].map(([name, row]) => ({ name, mtimeMs: row.mtimeMs })),
    removeTicket: async (_dir, name) => { tickets.delete(name) },
  }
}
const escape = (text: string) => text.replace(/\\/g, '\\\\')
function fakeSql(grants: (user: string) => string[] = () => [], users: string[] = []): DbSignonSql & { statements: string[] } {
  const statements: string[] = []
  return { statements, query: async batch => {
    statements.push(...batch)
    const show = /^SHOW GRANTS FOR '([^']+)'@'localhost'$/.exec(batch[0]!)
    if (show) return grants(show[1]!).map(line => escape(line) + '\n').join('')
    if (batch[0]!.startsWith('SELECT User FROM mysql.user')) return users.map(user => user + '\n').join('')
    return ''
  } }
}
const accountGrant = (user: string, db: string) => `GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, REFERENCES, INDEX, ALTER, CREATE TEMPORARY TABLES, LOCK TABLES, EXECUTE, CREATE VIEW, SHOW VIEW, CREATE ROUTINE, ALTER ROUTINE, EVENT, TRIGGER, DELETE HISTORY ON \`${db.replace(/_/g, '\\_')}\`.* TO \`${user}\`@\`localhost\``
const now = () => new Date('2026-10-28T10:00:00Z')
const bytes = (fill: number) => { let next = fill; return (size: number) => Buffer.alloc(size, next++) }

describe('phpMyAdmin sign-on configuration and status', () => {
  it('accepts only the strict installer configuration', () => {
    expect(config.ticketDirectory).toBe('/var/lib/xpanel/db-signon')
    for (const bad of [{ ...configJson.phpmyadmin, signonUrl: 'http://x.test/a.php' }, { ...configJson.phpmyadmin, signonUrl: 'https://u:p@x.test/a.php' }, { ...configJson.phpmyadmin, ticketDirectory: '/tmp/x' }, { ...configJson.phpmyadmin, ticketGroup: 'root' }, { ...configJson.phpmyadmin, bridgePath: '/usr/share/../x.php' }, { ...configJson.phpmyadmin, extra: 1 }]) expect(() => parseDbSignonConfig(JSON.stringify({ phpmyadmin: bad }))).toThrow()
    expect(renderPhpMyAdminSignonBridge(config)).toContain("'/var/lib/xpanel/db-signon'"); expect(renderPhpMyAdminSignonBridge(config)).toContain('rename($path, $claimed)')
    expect(groupGid('root:x:0:\nwww-data:x:33:alice\n', 'www-data')).toBe(33)
  })
  it('is ready only with the package, exact bridge and config, a safe ticket directory and admin SQL', async () => {
    const sql = fakeSql()
    expect((await readDbSignonStatus({ installed: null, fs: memoryFs(), sql })).reason).toBe('packages-unread')
    expect((await readDbSignonStatus({ installed: false, fs: memoryFs(), sql })).state).toBe('not-installed')
    expect((await readDbSignonStatus({ installed: true, fs: memoryFs({ [DB_SIGNON_CONFIG_PATH]: null }), sql })).reason).toBe('config-missing')
    expect((await readDbSignonStatus({ installed: true, fs: memoryFs({ [config.bridgePath]: renderPhpMyAdminSignonBridge(config) + '// edited\n' }), sql })).reason).toBe('bridge-modified')
    expect((await readDbSignonStatus({ installed: true, fs: memoryFs({ [config.configPath]: null }), sql })).reason).toBe('phpmyadmin-config-missing')
    expect((await readDbSignonStatus({ installed: true, fs: memoryFs({}, 0o1730), sql })).reason).toBe('ticket-directory-unsafe')
    expect((await readDbSignonStatus({ installed: true, fs: memoryFs(), sql: null })).reason).toBe('database-admin-unavailable')
    expect(await readDbSignonStatus({ installed: true, fs: memoryFs(), sql })).toMatchObject({ state: 'ready', gid: 33 })
  })
})

describe('phpMyAdmin session issue and cleanup', () => {
  it('creates an account-scoped session user, proves its grants and writes a single-use hashed ticket', async () => {
    const fs = memoryFs(), sql = fakeSql(user => [`GRANT USAGE ON *.* TO \`${user}\`@\`localhost\``, accountGrant(user, 'alice_app'), accountGrant(user, 'alice_wp')])
    const status = await readDbSignonStatus({ installed: true, fs, sql }) as Extract<Awaited<ReturnType<typeof readDbSignonStatus>>, { state: 'ready' }>
    let checks = 0
    const issued = await issueDbSignon({ scope: { kind: 'account', username: 'alice', databases: ['alice_wp', 'alice_app'] }, status, sql, fs, now, random: bytes(7), beforeEffect: async () => { checks++ } })
    expect(issued).toEqual({ client: 'phpmyadmin', action: config.signonUrl, ticket: Buffer.alloc(32, 9).toString('base64url'), expiresAt: '2026-10-28T10:01:00.000Z', sessionExpiresAt: '2026-10-28T10:30:00.000Z' })
    expect(checks).toBe(2)
    const password = Buffer.alloc(24, 8).toString('base64url'), user = 'xpsso-' + Math.floor(Date.parse(issued.sessionExpiresAt) / 1000) + '-070707070707'
    expect(sql.statements[0]).toMatch(new RegExp(`^CREATE USER '${user}'@'localhost' IDENTIFIED BY PASSWORD '\\*[0-9A-F]{40}' WITH MAX_USER_CONNECTIONS 10$`))
    expect(sql.statements.join('\n')).not.toContain(password)
    expect(sql.statements.filter(s => s.startsWith('GRANT'))).toEqual(['alice_app', 'alice_wp'].map(db => expect.stringContaining('ON `' + db.replace('_', '\\_') + '`.* TO')))
    const ticket = fs.tickets.get(createHash('sha256').update(issued.ticket).digest('hex'))!
    expect(ticket.gid).toBe(33); expect(JSON.parse(ticket.content)).toEqual({ user, password, expiresAt: Date.parse(issued.expiresAt) / 1000 })
    expect(JSON.stringify(issued)).not.toContain(password)
  })
  it('drops the user and writes no ticket when the live grants differ; root receives global privileges without grant option', async () => {
    const fs = memoryFs(), wrong = fakeSql(user => [`GRANT ALL PRIVILEGES ON *.* TO \`${user}\`@\`localhost\``])
    const status = await readDbSignonStatus({ installed: true, fs, sql: wrong }) as never
    await expect(issueDbSignon({ scope: { kind: 'account', username: 'alice', databases: ['alice_app'] }, status, sql: wrong, fs, now, beforeEffect: async () => undefined })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(wrong.statements.at(-1)).toMatch(/^DROP USER IF EXISTS 'xpsso-/); expect(fs.tickets.size).toBe(0)
    const root = fakeSql(user => [`GRANT ALL PRIVILEGES ON *.* TO \`${user}\`@\`localhost\` IDENTIFIED BY PASSWORD '*00' WITH MAX_USER_CONNECTIONS 10`])
    await issueDbSignon({ scope: { kind: 'root' }, status, sql: root, fs, now, beforeEffect: async () => undefined })
    expect(root.statements[1]).toMatch(/^GRANT ALL PRIVILEGES ON \*\.\* TO 'xpsso-[0-9]{10}-[0-9a-f]{12}'@'localhost'$/); expect(fs.tickets.size).toBe(1)
    await expect(issueDbSignon({ scope: { kind: 'account', username: 'alice', databases: ['bob_app'] }, status, sql: root, fs, now, beforeEffect: async () => undefined })).rejects.toThrow()
  })
  it('reaps only expired session users and stale tickets', async () => {
    const fs = memoryFs(), sql = fakeSql(() => [], ['xpsso-1761645000-aaaaaaaaaaaa', 'xpsso-1861645000-bbbbbbbbbbbb', 'alice_app'])
    fs.tickets.set('a'.repeat(64), { content: JSON.stringify({ expiresAt: 1 }), gid: 33, mtimeMs: 0 }); fs.tickets.set('b'.repeat(64), { content: JSON.stringify({ expiresAt: 4102444800 }), gid: 33, mtimeMs: 0 })
    expect(await reapDbSignon({ sql, fs, config, now })).toEqual({ users: 1, tickets: 1 })
    expect(sql.statements.filter(s => s.startsWith('DROP'))).toEqual(["DROP USER IF EXISTS 'xpsso-1761645000-aaaaaaaaaaaa'@'localhost'"]); expect([...fs.tickets.keys()]).toEqual(['b'.repeat(64)])
  })
})

describe('database web client routes', () => {
  const accountId = '11111111-1111-4111-8111-111111111111'
  const dpkg = 'phpmyadmin\t4:5.2.1\tinstall ok installed\nmariadb-server\t1:10.11.6\tinstall ok installed\n'
  const deps = (over: Partial<DbSignonRouteDeps> = {}): DbSignonRouteDeps & { audits: unknown[] } => {
    const audits: unknown[] = []
    return { audits, caller: { principalId: 'p1', actor: 'alice', role: 'user', accountId, resellerId: null },
      store: { getAccountByUsername: async name => name === 'alice' ? { id: accountId, username: 'alice', status: 'active', planId: 'plan', createdAt: '2026-01-01T00:00:00.000Z' } as never : null, getPlan: async () => ({ featureListId: 'f' }) as never, getFeatureList: async () => ({ id: 'f', name: 'f', ownerId: null, disabled: [] }), readDatabaseRemoteAccess: async () => ({ databases: [{ id: 'd1', accountId, name: 'alice_app', trashedAt: null }, { id: 'd2', accountId, name: 'alice_old', trashedAt: '2026-10-01T00:00:00.000Z' }], users: [] }) as never },
      currentPrincipal: async () => ({ kind: 'user', id: 'p1', username: 'alice', accountId, disabled: false }), assertRoot: async () => ({ actor: 'root' }),
      family: 'debian', run: async () => ({ ok: true, code: 0, stdout: dpkg, stderr: '' }), fs: memoryFs(), sql: fakeSql(user => [accountGrant(user, 'alice_app')]), now, random: bytes(9),
      audit: async entry => { audits.push(entry) }, ...over }
  }
  const call = (path: string, d: DbSignonRouteDeps, method = 'GET', body?: string) => handleDbSignonRoute(new Request('http://agent' + path, { method, ...(body === undefined ? {} : { body, headers: { 'content-type': 'application/json' } }) }), new URL('http://agent' + path), method, d)
  it('shows owner status and issues a sign-on only for non-trashed owned databases after an intent audit', async () => {
    const d = deps()
    expect(await (await call('/accounts/alice/database-engines/phpmyadmin', d))!.json()).toMatchObject({ context: { accountId, username: 'alice' }, installed: true, signon: { state: 'ready', reason: null }, databases: 1, ticketSeconds: 60 })
    const issued = await (await call('/accounts/alice/database-engines/phpmyadmin/sign-on', d, 'POST', '{}'))!.json() as { ticket: string }
    expect(issued.ticket).toHaveLength(43); expect(d.audits).toEqual([expect.objectContaining({ action: 'database.phpmyadmin.sign_on', target: 'account:alice', outcome: 'ok' })])
    expect((d.sql as ReturnType<typeof fakeSql>).statements.some(s => s.includes('alice\\_old'))).toBe(false)
  })
  it('refuses bodies, unconfigured hosts, audit failures and phpPgAdmin sign-on', async () => {
    await expect(call('/accounts/alice/database-engines/phpmyadmin/sign-on', deps(), 'POST', '{"user":"root"}')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call('/accounts/alice/database-engines/phpmyadmin/sign-on', deps({ fs: memoryFs({ [DB_SIGNON_CONFIG_PATH]: null }) }), 'POST', '{}')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    const failing = deps({ audit: async () => { throw new Error('disk full') } })
    await expect(call('/accounts/alice/database-engines/phpmyadmin/sign-on', failing, 'POST', '{}')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect((failing.sql as ReturnType<typeof fakeSql>).statements.some(s => s.startsWith('CREATE USER'))).toBe(false)
    expect(await call('/accounts/alice/database-engines/phppgadmin/sign-on', deps(), 'POST', '{}')).toBeNull()
    expect(await (await call('/accounts/alice/database-engines/phppgadmin', deps()))!.json()).toMatchObject({ client: 'phppgadmin', installed: false, signon: { state: 'unsupported' } })
    await expect(call('/accounts/alice/database-engines/phpmyadmin', deps({ caller: { principalId: 'p2', actor: 'bob', role: 'user', accountId: 'other', resellerId: null } }))).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('requires fresh root for the server sign-on', async () => {
    let calls = 0
    const d = deps({ assertRoot: async () => ({ actor: ++calls > 2 ? 'other' : 'root' }), sql: fakeSql(user => [`GRANT ALL PRIVILEGES ON *.* TO \`${user}\`@\`localhost\``]) })
    await expect(call('/host/databases/web-clients/phpmyadmin/sign-on', d, 'POST', '{}')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((d.fs as ReturnType<typeof memoryFs>).tickets.size).toBe(0)
  })
})
