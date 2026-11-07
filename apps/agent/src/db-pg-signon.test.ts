import { describe, expect, it, vi } from 'vitest'
import { isDatabaseEngineCommand, PG_SSO_ROLES_SQL, pgSsoRoleProofSql, postgresqlQueryArgv } from '../../../packages/os/src/db-engines-command.ts'
import { handlePgSignonRoute, issuePgSignon, parsePgSignonConfig, PG_SIGNON_CONFIG_PATH, pgClientConfigScoped, pgSignonProven, pgSignonStatements, readPgSignonStatus, reapPgSignon, renderPhpPgAdminSignonBridge } from './db-pg-signon.ts'
import type { PgSignonRouteDeps } from './db-pg-signon.ts'
import type { DbSignonFs } from './db-signon.ts'

const configJson = { signonUrl: 'https://db.example.test/phppgadmin/xpanel-signon.php', ticketDirectory: '/var/lib/xpanel/pg-signon', ticketGroup: 'www-data', bridgePath: '/usr/share/phppgadmin/xpanel-signon.php', clientConfigPath: '/etc/phppgadmin/config.inc.php' }
const config = parsePgSignonConfig(JSON.stringify(configJson))
const NOW = new Date('2026-11-07T10:00:00.000Z')
const accountId = '22222222-2222-4222-8222-222222222222'
const files = (over: Record<string, string | null> = {}): Record<string, string | null> => ({ [PG_SIGNON_CONFIG_PATH]: JSON.stringify(configJson), [config.bridgePath]: renderPhpPgAdminSignonBridge(config), [config.clientConfigPath]: "<?php\n\t$conf['owned_only'] = true;\n", '/etc/group': 'www-data:x:33:\n', ...over })
const memoryFs = (content = files(), dirMode = 0o40730): DbSignonFs & { tickets: Map<string, string> } => {
  const tickets = new Map<string, string>()
  return { tickets,
    readFile: async path => path.startsWith(config.ticketDirectory + '/') ? tickets.get(path.slice(config.ticketDirectory.length + 1)) ?? null : content[path] ?? null,
    lstat: async () => ({ isDirectory: true, isSymbolicLink: false, uid: 0, gid: 33, mode: dirMode }),
    writeTicket: async (_directory, name, text) => { tickets.set(name, text) },
    listTickets: async () => [...tickets.keys()].map(name => ({ name, mtimeMs: NOW.getTime() })),
    removeTicket: async (_directory, name) => { tickets.delete(name) } }
}
const status = (over: Partial<Parameters<typeof readPgSignonStatus>[0]> = {}) => readPgSignonStatus({ installed: true, family: 'debian', postgresql: true, fs: memoryFs(), ...over })
const databases = [{ name: 'alice_shop', owner: 'alice_app', sizeBytes: 1 }, { name: 'alice_blog', owner: 'alice_two', sizeBytes: 1 }, { name: 'alice_logs', owner: 'alice_app', sizeBytes: 1 }]

describe('phpPgAdmin sign-on configuration and status', () => {
  it('accepts only the exact root configuration', () => {
    expect(config.ticketGroup).toBe('www-data')
    for (const bad of [{ ...configJson, signonUrl: 'http://x.test/a.php' }, { ...configJson, ticketDirectory: '/tmp/x' }, { ...configJson, ticketGroup: 'root' }, { ...configJson, bridgePath: '/a/../b.php' }, { ...configJson, extra: 1 }]) expect(() => parsePgSignonConfig(JSON.stringify(bad))).toThrow()
    const { clientConfigPath: _omitted, ...short } = configJson
    expect(() => parsePgSignonConfig(JSON.stringify(short))).toThrow()
  })
  it('reviews the bridge: one claim, the shared-credentials session, no password in a URL', () => {
    const bridge = renderPhpPgAdminSignonBridge(config)
    expect(bridge).toContain("'/var/lib/xpanel/pg-signon'")
    expect(bridge).toContain('rename($path, $claimed)')
    expect(bridge).toContain("session_name('PPA_ID');")
    expect(bridge).toContain("'sharedUsername' => $data['user']")
    expect(bridge).toContain("'secure' => true")
    expect(bridge).not.toMatch(/Location:.*(password|ticket)/)
  })
  it('requires the last owned_only assignment to be true', () => {
    expect(pgClientConfigScoped("\t$conf['owned_only'] = true;\n")).toBe(true)
    expect(pgClientConfigScoped("$conf['owned_only'] = true;\n$conf['owned_only'] = false;\n")).toBe(false)
    expect(pgClientConfigScoped("// $conf['owned_only'] = true;\n")).toBe(false)
    expect(pgClientConfigScoped('')).toBe(false)
  })
  it('reports the first missing requirement with a stable reason', async () => {
    expect(await status({ installed: null })).toMatchObject({ state: 'unavailable', reason: 'packages-unread' })
    expect(await status({ installed: false })).toMatchObject({ state: 'not-installed', reason: 'package-missing' })
    expect(await status({ installed: false, family: 'rhel' })).toMatchObject({ state: 'no-package', reason: 'no-distribution-package' })
    expect(await status({ fs: memoryFs(files({ [PG_SIGNON_CONFIG_PATH]: null })) })).toMatchObject({ reason: 'config-missing' })
    expect(await status({ fs: memoryFs(files({ [PG_SIGNON_CONFIG_PATH]: '{' })) })).toMatchObject({ reason: 'config-invalid' })
    expect(await status({ fs: memoryFs(files({ [config.bridgePath]: null })) })).toMatchObject({ reason: 'bridge-missing' })
    expect(await status({ fs: memoryFs(files({ [config.bridgePath]: '<?php evil();' })) })).toMatchObject({ reason: 'bridge-modified' })
    expect(await status({ fs: memoryFs(files({ [config.clientConfigPath]: null })) })).toMatchObject({ reason: 'client-config-missing' })
    expect(await status({ fs: memoryFs(files({ [config.clientConfigPath]: "$conf['owned_only'] = false;" })) })).toMatchObject({ reason: 'client-config-unscoped' })
    expect(await status({ fs: memoryFs(files(), 0o40777) })).toMatchObject({ reason: 'ticket-directory-unsafe' })
    expect(await status({ postgresql: false })).toMatchObject({ state: 'unavailable', reason: 'postgresql-unavailable' })
    expect(await status()).toMatchObject({ state: 'ready', reason: null })
    expect(await status({ family: 'rhel' })).toMatchObject({ state: 'ready' })
  })
})

describe('phpPgAdmin session roles', () => {
  it('joins each owner once and sets the role per database', () => {
    const statements = pgSignonStatements('xpsso-1790000000-aaaaaaaaaaaa', 'SCRAM-SHA-256$x', '2026-11-07T10:30:00.000Z', databases)
    expect(statements[0]).toBe(`CREATE ROLE "xpsso-1790000000-aaaaaaaaaaaa" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT CONNECTION LIMIT 10 VALID UNTIL '2026-11-07T10:30:00.000Z' PASSWORD 'SCRAM-SHA-256$x';`)
    expect(statements.filter(line => line.startsWith('GRANT'))).toEqual(['GRANT "alice_app" TO "xpsso-1790000000-aaaaaaaaaaaa";', 'GRANT "alice_two" TO "xpsso-1790000000-aaaaaaaaaaaa";'])
    expect(statements).toContain(`ALTER ROLE "xpsso-1790000000-aaaaaaaaaaaa" IN DATABASE "alice_blog" SET role = 'alice_two';`)
    expect(() => pgSignonStatements('postgres', 'x', 'x', databases)).toThrow()
    expect(() => pgSignonStatements('xpsso-1790000000-aaaaaaaaaaaa', 'x', 'x', [])).toThrow()
  })
  it('proves the live role has no privilege flag and exactly the owner roles', () => {
    expect(pgSignonProven('f\tf\tf\tf\tf\t10\talice_app alice_two\n', ['alice_two', 'alice_app', 'alice_app'])).toBe(true)
    expect(pgSignonProven('t\tf\tf\tf\tf\t10\talice_app alice_two\n', ['alice_app', 'alice_two'])).toBe(false)
    expect(pgSignonProven('f\tf\tf\tf\tf\t10\talice_app bob_app\n', ['alice_app'])).toBe(false)
    expect(pgSignonProven('f\tf\tf\tf\tf\t-1\talice_app\n', ['alice_app'])).toBe(false)
    expect(pgSignonProven('', ['alice_app'])).toBe(false)
  })
  it('admits only the fixed session role statements to the root command grammar', () => {
    expect(isDatabaseEngineCommand(postgresqlQueryArgv(PG_SSO_ROLES_SQL))).toBe(true)
    expect(isDatabaseEngineCommand(postgresqlQueryArgv(pgSsoRoleProofSql('xpsso-1790000000-aaaaaaaaaaaa')))).toBe(true)
    expect(isDatabaseEngineCommand(postgresqlQueryArgv("DROP ROLE r WHERE r.rolname = 'xpsso-1790000000-aaaaaaaaaaaa'"))).toBe(false)
    expect(() => pgSsoRoleProofSql("x' OR '1'='1")).toThrow()
  })

  const ready = async (fs: DbSignonFs) => { const state = await readPgSignonStatus({ installed: true, family: 'debian', postgresql: true, fs }); if (state.state !== 'ready') throw new Error('not ready'); return state }
  it('issues a ticket only after the proof and drops the role when it fails', async () => {
    const fs = memoryFs(), script = vi.fn(async () => undefined), run = vi.fn(async () => ({ ok: true, code: 0, stdout: 'f\tf\tf\tf\tf\t10\talice_app alice_two\n', stderr: '' }))
    const issued = await issuePgSignon({ databases, status: await ready(fs), run, script, fs, now: () => NOW, random: bytes => Buffer.alloc(bytes, 7), beforeEffect: async () => undefined })
    expect(issued).toMatchObject({ client: 'phppgadmin', action: config.signonUrl, expiresAt: '2026-11-07T10:01:00.000Z', sessionExpiresAt: '2026-11-07T10:30:00.000Z' })
    const [text] = [...fs.tickets.values()]
    expect(JSON.parse(text!)).toMatchObject({ user: expect.stringMatching(/^xpsso-[0-9]{10}-[0-9a-f]{12}$/), expiresAt: Date.parse('2026-11-07T10:01:00.000Z') / 1000 })
    const stored = JSON.stringify(script.mock.calls)
    expect(stored).toContain('SCRAM-SHA-256$')
    expect(stored).not.toContain(JSON.parse(text!).password)
    const bad = memoryFs(), failed = vi.fn(async () => ({ ok: true, code: 0, stdout: 't\tf\tf\tf\tf\t10\talice_app alice_two\n', stderr: '' })), scripted = vi.fn(async () => undefined)
    await expect(issuePgSignon({ databases, status: await ready(bad), run: failed, script: scripted, fs: bad, now: () => NOW, beforeEffect: async () => undefined })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: false } })
    expect(bad.tickets.size).toBe(0)
    expect(JSON.stringify(scripted.mock.calls.at(-1))).toContain('DROP ROLE IF EXISTS')
  })
  it('reaps only expired roles and keeps going past one that cannot be dropped', async () => {
    const past = 'xpsso-1000000000-aaaaaaaaaaaa', stuck = 'xpsso-1000000001-bbbbbbbbbbbb', future = 'xpsso-2000000000-cccccccccccc'
    const script = vi.fn(async (statements: string[]) => { if (statements.join().includes(stuck)) throw new Error('dependent objects') })
    const run = vi.fn(async () => ({ ok: true, code: 0, stdout: [past, stuck, future, 'xpsso-odd'].join('\n') + '\n', stderr: '' }))
    expect(await reapPgSignon({ run, script, fs: memoryFs(), config, now: () => NOW })).toEqual({ roles: 1, tickets: 0 })
    expect(JSON.stringify(script.mock.calls)).toContain(past)
    expect(JSON.stringify(script.mock.calls)).not.toContain(future)
  })
})

describe('phpPgAdmin account route', () => {
  const account = { id: accountId, username: 'alice', status: 'active', planId: 'p', createdAt: '2026-01-01T00:00:00.000Z' }
  const dpkg = 'phppgadmin\t7.13.0+dfsg-2\tinstall ok installed\npostgresql-14\t14.20\tinstall ok installed\n'
  const unit = 'Id=postgresql@14-main.service\nNames=postgresql@14-main.service\nLoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\n'
  const server = (rows: string) => async (argv: readonly string[]) => {
    const sql = String(argv.at(-1))
    return { ok: true, code: 0, stderr: '', stdout: argv.includes('show') ? unit : argv[0]?.includes('dpkg') ? dpkg : sql === 'SHOW server_version' ? '14.20\n' : sql.startsWith('SELECT d.datname') ? rows : sql.startsWith('SELECT r.rolname, r.rolcanlogin') ? 'alice_app\tt\n' : sql.startsWith('SELECT r.rolsuper') ? 'f\tf\tf\tf\tf\t10\talice_app\n' : '' }
  }
  const deps = (over: Partial<PgSignonRouteDeps> = {}): PgSignonRouteDeps => ({
    caller: { role: 'user', actor: 'alice', principalId: 'p1', accountId } as PgSignonRouteDeps['caller'],
    store: { getAccountByUsername: async () => account, getPlan: async () => ({ featureListId: 'f' }), getFeatureList: async () => ({ disabled: [] }) } as unknown as PgSignonRouteDeps['store'],
    currentPrincipal: async () => ({ kind: 'user', id: 'p1', username: 'alice', accountId, disabled: false }),
    family: 'debian', run: server('alice_shop\talice_app\t100\n'), fs: memoryFs(), script: vi.fn(async () => undefined), audit: vi.fn(async () => undefined), now: () => NOW, ...over })
  const call = (path: string, d: PgSignonRouteDeps, method = 'GET', body?: string) => handlePgSignonRoute(new Request('http://agent.test' + path, { method, ...(body === undefined ? {} : { body, headers: { 'content-type': 'application/json' } }) }), new URL('http://agent.test' + path), method, d)
  const read = '/accounts/alice/database-engines/phppgadmin', issue = read + '/sign-on'

  it('shows status and issues a scoped sign-on after an intent audit', async () => {
    const d = deps()
    expect(await (await call(read, d))!.json()).toEqual({ context: { accountId, username: 'alice' }, client: 'phppgadmin', installed: true, postgresql: true, signon: { state: 'ready', reason: null }, databases: 1, ticketSeconds: 60, sessionSeconds: 1800 })
    const issued = await (await call(issue, d, 'POST', '{}'))!.json()
    expect(issued).toMatchObject({ client: 'phppgadmin', action: config.signonUrl })
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'database.phppgadmin.sign_on', target: 'account:alice', detail: { databases: 1 } }))
    expect(JSON.stringify((d.script as ReturnType<typeof vi.fn>).mock.calls)).toContain('GRANT \\"alice_app\\" TO')
  })
  it('leaves out a database owned outside the account', async () => {
    const d = deps({ run: server('alice_shop\tbob_app\t100\n') })
    expect(((await (await call(read, d))!.json()) as { databases: number }).databases).toBe(0)
    await expect(call(issue, d, 'POST', '{}')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'no-databases', stateChanged: false } })
    expect(d.script).not.toHaveBeenCalled()
  })
  it('refuses with the stable reason on a profile without the package and creates nothing', async () => {
    const d = deps({ family: 'rhel', run: async argv => ({ ok: true, code: 1, stderr: '', stdout: argv[0]?.includes('rpm') ? '' : '' }) })
    expect(((await (await call(read, d))!.json()) as { signon: { state: string } }).signon.state).toMatch(/no-package|unavailable/)
    await expect(call(issue, d, 'POST', '{}')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    expect(d.script).not.toHaveBeenCalled()
  })
  it('never issues without a durable audit, a current owner or an exact body', async () => {
    const unaudited = deps({ audit: vi.fn(async () => { throw new Error('down') }) })
    await expect(call(issue, unaudited, 'POST', '{}')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(unaudited.script).not.toHaveBeenCalled()
    await expect(call(issue, deps(), 'POST', '{"account":"bob"}')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call(read, deps({ caller: { role: 'user', actor: 'bob', principalId: 'p2', accountId: '33333333-3333-4333-8333-333333333333' } as PgSignonRouteDeps['caller'] }))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await call(read, deps(), 'POST', '{}'))!.status).toBe(405)
    expect(await call('/accounts/alice/database-engines/phpmyadmin', deps())).toBeNull()
  })
})
