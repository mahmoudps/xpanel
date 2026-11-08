import { describe, expect, it, vi } from 'vitest'
import type { RenderedFile } from '@xpanel/core'
import { assertLocalDatabaseServer, createDbProfiles, DB_PROFILE_INDEX, dbProfileOptionFile, handleDbProfilesRoute, parseDbProfileIndex, parseDbProfileInput, readDbClientHost, renderDbProfileOptions, dbProfilePasswordLine, validateDbProfile } from './db-profiles.ts'
import type { DbProfilesDeps } from './db-profiles.ts'
import { createProductionHostTargetMatcher } from './executor.ts'
import { DEFAULT_MARIADB_ADMIN_CNF, MariaDbServiceAdapter } from './services/mariadb.ts'
import type { MariaDbCommandInput, MariaDbCommandResult, MariaDbCommandRunner } from './services/mariadb.ts'

const SECRET = 'Sup3r"Sec\\ret'
const NOW = () => new Date('2026-11-07T12:00:00.000Z')
// A public test certificate, for db.example.test.
const CA = '-----BEGIN CERTIFICATE-----\nMIIBGDCBy6ADAgECAhRKTjFyFLt4k8g89TSRiT/y/YsPxTAFBgMrZXAwGjEYMBYG\nA1UEAwwPZGIuZXhhbXBsZS50ZXN0MCAXDTI2MTEwNzE0MjU1MVoYDzIxMjYxMDE0\nMTQyNTUxWjAaMRgwFgYDVQQDDA9kYi5leGFtcGxlLnRlc3QwKjAFBgMrZXADIQB4\nt9Bi9F5HFj/RsSTVA2fDi0xBMxxQ7YUnoKFMCjm696MhMB8wHQYDVR0OBBYEFEmM\nR8R4+nFkgnjksG+98ZpcFgTDMAUGAytlcANBAIx8e+jttMtfmWL05gPWfNRwRg4s\nAYD7xEXQYM/xyQIAjaEAKIkXlFH3vpRoYDj2itit0HwwbtTs47QyZ/JeyQk=\n-----END CERTIFICATE-----\n'
const input = (over: Record<string, unknown> = {}) => parseDbProfileInput({ name: 'remote1', host: '192.0.2.50', port: 3306, user: 'xpanel_admin', password: SECRET, description: 'Primary', ca: CA, ...over })
const result = (stdout: string, ok = true, stderr = ''): MariaDbCommandResult => ({ ok, exitCode: ok ? 0 : 1, stdout, stderr } as MariaDbCommandResult)
const GOOD = "10.11.6-MariaDB-log\nxpanel_admin@198.51.100.7\nSsl_cipher\tTLS_AES_256_GCM_SHA384\nGRANT ALL PRIVILEGES ON *.* TO `xpanel_admin`@`%` IDENTIFIED BY PASSWORD '*ABCDEF' WITH GRANT OPTION\n"
const memoryHost = () => {
  const files = new Map<string, RenderedFile>()
  return { files, host: { readFile: async (path: string) => files.get(path)?.content ?? null, writeFile: async (file: RenderedFile) => { files.set(file.path, file) }, removePath: async (path: string) => { files.delete(path) } } }
}
function service(over: Partial<DbProfilesDeps> & { stdout?: MariaDbCommandResult } = {}) {
  const memory = memoryHost(), calls: MariaDbCommandInput[] = []
  memory.files.set(DEFAULT_MARIADB_ADMIN_CNF, { path: DEFAULT_MARIADB_ADMIN_CNF, content: '[client]\nuser=root\n', mode: 0o600 })
  const run: MariaDbCommandRunner = async command => { calls.push(command); return over.stdout ?? result(GOOD) }
  const profiles = createDbProfiles({ host: memory.host, savedDatabases: async () => 0, probeActive: async () => undefined, run, now: NOW, ...over })
  return { profiles, memory, calls }
}

describe('database profile input', () => {
  it('refuses anything that could break out of one option line', () => {
    for (const over of [{ host: 'a\nssl-key=/etc/shadow' }, { user: 'a\nb' }, { user: 'a b' }, { password: 'a\nb' }, { password: 'a b' }, { name: 'Bad Name' }, { name: 'localhost' }, { host: 'localhost' }, { port: 0 }, { port: 70000 }, { description: 'a\nb' }, { tls: 'yes' }]) expect(() => input(over), JSON.stringify(over)).toThrow()
    expect(() => parseDbProfileInput({ name: 'a', extra: 1 })).toThrow()
  })
  it('writes one option file, with the password quoted', () => {
    const text = renderDbProfileOptions(input(), dbProfilePasswordLine(SECRET))
    expect(text).toContain('host=192.0.2.50\nport=3306\nuser=xpanel_admin\npassword="Sup3r\\"Sec\\\\ret"\nssl\nssl-ca=/etc/xpanel/db-profile-remote1.pem\nssl-verify-server-cert\n')
  })
  it('requires a server identity: no plain profile, and only a real PEM certificate', () => {
    expect(() => input({ tls: false })).toThrow()
    for (const ca of ['', 'not a certificate', CA.replace('MIIB', 'XXXX'), CA + CA, '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n', CA.padEnd(9000)]) expect(() => input({ ca }), String(ca).slice(0, 20)).toThrow()
    expect(input().ca).toBe(CA)
    expect(input({ ca: null }).ca).toBeNull()
  })
  it('refuses a damaged index', () => {
    expect(parseDbProfileIndex(null)).toMatchObject({ active: 'localhost', profiles: [] })
    expect(parseDbProfileIndex('not json')).toBeNull()
    expect(parseDbProfileIndex(JSON.stringify({ version: 1, active: 'gone', profiles: [] }))).toBeNull()
  })
})

describe('validating a profile', () => {
  const check = (stdout: MariaDbCommandResult) => validateDbProfile({ name: 'remote1' }, async () => stdout, NOW)
  it('passes on the server\'s own answers and keeps only safe facts', async () => {
    const validation = await check(result(GOOD))
    expect(validation).toEqual({ state: 'passed', reason: null, version: '10.11.6-MariaDB-log', clientHost: '198.51.100.7', at: NOW().toISOString() })
    expect(JSON.stringify(validation)).not.toContain('ABCDEF')
  })
  it('passes the password through the option file only', async () => {
    const { profiles, calls } = service()
    await profiles.save(input()); await profiles.validate('remote1')
    expect(calls[0]!.argv).toContain('--defaults-extra-file=' + dbProfileOptionFile('remote1'))
    expect(calls[0]!.argv.join(' ')).not.toContain('Sec')
    expect(calls[0]!.stdinSql).not.toContain('Sec')
  })
  it.each([
    ['access_denied', result('', false, "ERROR 1045 (28000): Access denied for user 'x'@'y' (using password: YES)")],
    ['unreachable', result('', false, "ERROR 2002 (HY000): Can't connect to server on '192.0.2.50' (115)")],
    ['unreachable', result('', false, "ERROR 2005 (HY000): Unknown server host 'x' (-2)".replace('server', 'MySQL server'))],
    ['tls_failed', result('', false, 'ERROR 2026 (HY000): TLS/SSL error: SSL is required, but the server does not support it')],
    ['failed', result('', false, 'something else')],
    ['not_mariadb', result('8.0.36\nu@h\nSsl_cipher\tX\n')],
    ['tls_not_negotiated', result('10.11.6-MariaDB\nu@h\nSsl_cipher\t\nGRANT ALL PRIVILEGES ON *.* TO `u`@`%` WITH GRANT OPTION\n')],
    ['insufficient_privileges', result('10.11.6-MariaDB\nu@h\nSsl_cipher\tX\nGRANT SELECT ON *.* TO `u`@`%`\n')],
  ])('reports %s and never the raw error', async (reason, outcome) => {
    const validation = await check(outcome)
    expect(validation).toMatchObject({ state: 'failed', reason, clientHost: null })
    expect(JSON.stringify(validation)).not.toContain("'x'")
  })
})

describe('profile lifecycle', () => {
  it('keeps the password in a 0600 root file and out of the index and the listing', async () => {
    const { profiles, memory } = service()
    const listed = await profiles.save(input())
    expect(listed).toMatchObject({ active: 'localhost', profiles: [{ name: 'remote1', host: '192.0.2.50', port: 3306, user: 'xpanel_admin', description: 'Primary', validation: null }] })
    const option = memory.files.get(dbProfileOptionFile('remote1'))!
    expect(option).toMatchObject({ mode: 0o600, owner: 'root', group: 'root' })
    expect(option.content).toContain('password=')
    for (const text of [JSON.stringify(listed), memory.files.get(DB_PROFILE_INDEX)!.content]) expect(text).not.toContain('Sup3r')
    expect(memory.files.get(DB_PROFILE_INDEX)!.mode).toBe(0o600)
  })
  it('keeps the saved password when an edit leaves it empty, and refuses a new profile without one', async () => {
    const { profiles, memory } = service()
    await expect(profiles.save(input({ password: null }))).rejects.toMatchObject({ code: 'VALIDATION' })
    await profiles.save(input())
    await profiles.save(input({ password: null, host: '192.0.2.51' }))
    const content = memory.files.get(dbProfileOptionFile('remote1'))!.content
    expect(content).toContain('host=192.0.2.51'); expect(content).toContain('Sup3r')
  })
  it('activates a valid profile, keeps the local credentials, and goes back', async () => {
    const { profiles, memory } = service()
    await profiles.save(input())
    expect(await profiles.activate('remote1')).toMatchObject({ active: 'remote1', profiles: [{ validation: { state: 'passed', clientHost: '198.51.100.7' } }] })
    expect(memory.files.get(DEFAULT_MARIADB_ADMIN_CNF)).toMatchObject({ mode: 0o600, owner: 'root', group: 'root' })
    expect(memory.files.get(DEFAULT_MARIADB_ADMIN_CNF)!.content).toContain('host=192.0.2.50')
    // The live client file carries the server's identity check, against the saved CA, not only TLS.
    expect(memory.files.get(DEFAULT_MARIADB_ADMIN_CNF)!.content).toContain('\nssl-ca=/etc/xpanel/db-profile-remote1.pem\nssl-verify-server-cert\n')
    expect(memory.files.get('/etc/xpanel/db-profile-remote1.pem')).toMatchObject({ content: CA, mode: 0o600, owner: 'root' })
    expect(memory.files.get(dbProfileOptionFile('localhost'))!.content).toBe('[client]\nuser=root\n')
    expect(await profiles.activate('localhost')).toMatchObject({ active: 'localhost' })
    expect(memory.files.get(DEFAULT_MARIADB_ADMIN_CNF)!.content).toBe('[client]\nuser=root\n')
  })
  it('activating a profile that fails validation returns PROFILE_INVALID while the previous one stays active', async () => {
    const { profiles, memory } = service({ stdout: result('', false, 'ERROR 1045: Access denied') })
    await profiles.save(input())
    await expect(profiles.activate('remote1')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'PROFILE_INVALID', failure: 'access_denied', stateChanged: false } })
    expect(await profiles.read()).toMatchObject({ active: 'localhost', profiles: [{ validation: { state: 'failed', reason: 'access_denied' } }] })
    expect(memory.files.get(DEFAULT_MARIADB_ADMIN_CNF)!.content).toBe('[client]\nuser=root\n')
  })
  it('refuses while databases are saved, because nothing is migrated', async () => {
    const { profiles, memory } = service({ savedDatabases: async () => 3 })
    await profiles.save(input())
    await expect(profiles.activate('remote1')).rejects.toMatchObject({ code: 'CONFLICT', detail: { reason: 'PROFILE_HAS_DATABASES', saved: 3 } })
    expect(memory.files.get(DEFAULT_MARIADB_ADMIN_CNF)!.content).toBe('[client]\nuser=root\n')
  })
  it('restores the previous credentials when the new server does not answer the live client', async () => {
    const { profiles, memory } = service({ probeActive: async () => { throw new Error('no') } })
    await profiles.save(input())
    await expect(profiles.activate('remote1')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { rolledBack: true, stateChanged: false } })
    expect(memory.files.get(DEFAULT_MARIADB_ADMIN_CNF)!.content).toBe('[client]\nuser=root\n')
    expect((await profiles.read()).active).toBe('localhost')
  })
  it('deleting the active profile returns IN_USE, as does changing it; another deletes with its credentials', async () => {
    const { profiles, memory } = service()
    await profiles.save(input()); await profiles.save(input({ name: 'remote2' })); await profiles.activate('remote1')
    await expect(profiles.remove('remote1')).rejects.toMatchObject({ code: 'CONFLICT', detail: { reason: 'IN_USE' } })
    await expect(profiles.save(input({ host: '192.0.2.52' }))).rejects.toMatchObject({ detail: { reason: 'IN_USE' } })
    await expect(profiles.remove('localhost')).rejects.toMatchObject({ detail: { reason: 'IN_USE' } })
    await expect(profiles.remove('absent')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await profiles.remove('remote2')
    expect(memory.files.has(dbProfileOptionFile('remote2'))).toBe(false)
  })
  it('runs one change at a time', async () => {
    let inside = 0, most = 0
    const { profiles } = service({ savedDatabases: async () => { inside += 1; most = Math.max(most, inside); await new Promise(resolve => setTimeout(resolve, 5)); inside -= 1; return 0 } })
    await profiles.save(input()); await profiles.save(input({ name: 'remote2' }))
    await Promise.all([profiles.activate('remote1'), profiles.activate('remote2')])
    expect(most).toBe(1)
    expect((await profiles.read()).active).toBe('remote2')
  })
})

describe('the MariaDB client under a profile', () => {
  const meta = (content: string) => async () => ({ exists: true, isFile: true, isSymlink: false, uid: 0, gid: 0, mode: 0o600, size: content.length, content })
  const client = (content: string, seen: string[][]) => new MariaDbServiceAdapter({ adminDefaultsFile: '/etc/xpanel/mariadb-admin.cnf', socketPath: '/run/mysqld/mysqld.sock', adminConfigInspector: meta(content), commandRunner: async command => { seen.push(command.argv); return result('1\n') } })
  it('follows the option file: a host means TCP, none means the socket', async () => {
    const seen: string[][] = []
    const remote = client('[client]\nhost=192.0.2.50\nuser=x\n', seen), local = client('[client]\nuser=root\n', seen)
    await remote.query(['SELECT 1']); await local.query(['SELECT 1'])
    expect(seen[0]).toContain('--protocol=TCP'); expect(seen[0]!.join(' ')).not.toContain('--socket')
    expect(seen[1]).toContain('--protocol=SOCKET')
    expect(await remote.isRemote()).toBe(true); expect(await local.isRemote()).toBe(false)
  })
  it('stops host-local tools while a remote profile is active', async () => {
    await expect(assertLocalDatabaseServer({ isRemote: async () => true })).rejects.toMatchObject({ detail: { reason: 'remote_profile_active', stateChanged: false } })
    await expect(assertLocalDatabaseServer({ isRemote: async () => false })).resolves.toBeUndefined()
    await expect(assertLocalDatabaseServer(null)).resolves.toBeUndefined()
  })
  it('names the address the remote server saw, and nothing on the local server', async () => {
    const { profiles, memory } = service()
    const read = async (path: string) => memory.files.get(path)?.content ?? null
    expect(await readDbClientHost(read)).toBeNull()
    await profiles.save(input()); await profiles.activate('remote1')
    expect(await readDbClientHost(read)).toBe('198.51.100.7')
    await profiles.activate('localhost')
    expect(await readDbClientHost(read)).toBeNull()
  })
})

describe('host route', () => {
  it('reaches exactly these files through the production path matcher', () => {
    const permits = createProductionHostTargetMatcher()
    expect(permits(DB_PROFILE_INDEX, 'write')).toBe(true)
    expect(permits(DEFAULT_MARIADB_ADMIN_CNF, 'write')).toBe(true)
    expect(permits(DEFAULT_MARIADB_ADMIN_CNF, 'remove')).toBe(false)
    expect(permits(dbProfileOptionFile('remote1'), 'remove')).toBe(true)
    expect(permits('/etc/xpanel/db-profile-../shadow.cnf', 'write')).toBe(false)
  })
  const route = (path: string, method: string, body: unknown, service: ReturnType<typeof createDbProfiles> | null, audit = vi.fn(async () => undefined)) => handleDbProfilesRoute(new Request('http://agent.test' + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), new URL('http://agent.test' + path), method, { assertRoot: async () => ({ actor: 'root' }), service, audit })
  it('never carries the password into an audit row or a reply', async () => {
    const { profiles } = service(), audit = vi.fn(async () => undefined)
    const reply = await route('/host/db-profiles/save', 'POST', { name: 'remote1', host: '192.0.2.50', port: 3306, user: 'u', password: SECRET, description: '', ca: CA }, profiles, audit)
    expect(await reply!.text()).not.toContain('Sup3r')
    expect(JSON.stringify(audit.mock.calls)).not.toContain('Sup3r')
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'host.db_profiles.saved', detail: { host: '192.0.2.50', port: 3306, passwordChanged: true, certificateChanged: true } }))
  })
  it('audits a refused activation and refuses without a Linux host', async () => {
    const { profiles } = service({ stdout: result('', false, 'Access denied') }), audit = vi.fn(async () => undefined)
    await profiles.save(input())
    await expect(route('/host/db-profiles/activate', 'POST', { name: 'remote1' }, profiles, audit)).rejects.toMatchObject({ detail: { reason: 'PROFILE_INVALID' } })
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'host.db_profiles.activated', outcome: 'failed', detail: { reason: 'PROFILE_INVALID' } }))
    await expect(route('/host/db-profiles', 'GET', undefined, null)).rejects.toMatchObject({ detail: { reason: 'host_agent_unavailable' } })
    expect((await route('/host/db-profiles/save', 'GET', undefined, profiles))!.status).toBe(405)
    expect(await route('/host/db-profiles/other', 'POST', {}, profiles)).toBeNull()
  })
})
