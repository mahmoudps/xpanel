import { execFileSync } from 'node:child_process'
import { DEFAULT_SERVER_FTP_SETTINGS, validateServerFtpSettings } from '@xpanel/core'
import type { HostAction, OsProfile } from '@xpanel/core'
import { describe, expect, it } from 'vitest'
import { anonymousFtpLogins, compileFtpServer, FTP_ANONYMOUS_MAP, ftpRestartActions, parseAnonymousFtpState, parsePureFtpdConfFile, renderPureFtpdConfFile } from './ftp-server.ts'
import { createProductionHostTargetMatcher } from './executor.ts'

const debian = { family: 'debian', paths: { systemdDir: '/etc/systemd/system' }, services: { ftp: 'pure-ftpd' } } as unknown as OsProfile
const rhel = { ...debian, family: 'rhel' } as OsProfile
const id = '11111111-1111-4111-8111-111111111111'
const account = { id, username: 'alice', home: '/home/alice', status: 'active' }
const snapshot = (ftp = DEFAULT_SERVER_FTP_SETTINGS, accounts: unknown[] = [account]) => ({
  accounts, domains: [{ accountId: id, name: 'Example.test' }, { accountId: id, name: 'shop.example.test' }, { accountId: 'other', name: 'other.test' }], server: { settings: { hostname: 'host.example.test', ftp } },
}) as unknown as Parameters<typeof compileFtpServer>[0]
const open = { ...DEFAULT_SERVER_FTP_SETTINGS, anonymous: true, anonymousUploads: true }
const argvs = (actions: HostAction[]) => actions.flatMap(action => action.kind === 'exec' ? [action.argv.join(' ')] : [])

describe('FTP server settings', () => {
  it('refuses cleartext-only FTP, an inverted port range and uploads without anonymous logins', () => {
    expect(validateServerFtpSettings(DEFAULT_SERVER_FTP_SETTINGS)).toEqual(DEFAULT_SERVER_FTP_SETTINGS)
    expect(() => validateServerFtpSettings({ ...DEFAULT_SERVER_FTP_SETTINGS, tls: 'disabled' })).toThrow(/plaintext-only/)
    expect(() => validateServerFtpSettings({ ...DEFAULT_SERVER_FTP_SETTINGS, passivePorts: { min: 40000, max: 30000 } })).toThrow(/below/)
    expect(() => validateServerFtpSettings({ ...DEFAULT_SERVER_FTP_SETTINGS, anonymousUploads: true })).toThrow(/anonymous uploads/)
    expect(() => validateServerFtpSettings({ ...DEFAULT_SERVER_FTP_SETTINGS, tlsCipherSuite: 'HIGH\nExtAuth /tmp/x' })).toThrow(/cipher/)
  })
  it('writes the wrapper files and auth links on Debian, the single conf file on EL', () => {
    const deb = compileFtpServer(snapshot({ ...DEFAULT_SERVER_FTP_SETTINGS, maxConnectionsPerIp: 2, tls: 'optional' }), { os: debian, certPresent: true, anonymous: {} })
    expect(deb.files.find(file => file.path === '/etc/pure-ftpd/conf/MaxClientsPerIP')?.content).toBe('2\n')
    expect(deb.files.find(file => file.path === '/etc/pure-ftpd/conf/TLS')?.content).toBe('1\n')
    expect(argvs(deb.postActions)).toContain('/usr/bin/ln -sfn ../conf/PureDB /etc/pure-ftpd/auth/50pure')
    expect(deb.postActions).toContainEqual({ kind: 'remove-path', path: '/etc/pure-ftpd/auth/60extauth' })
    expect(argvs(deb.postActions)).toContain('/usr/sbin/pure-ftpd-wrapper --show-options')
    const el = compileFtpServer(snapshot(), { os: rhel, certPresent: true, anonymous: {} })
    expect(el.files.map(file => file.path)).toEqual(['/etc/pure-ftpd/pure-ftpd.conf'])
    const parsed = parsePureFtpdConfFile(el.files[0]!.content)
    expect([parsed.get('Daemonize'), parsed.get('TLS'), parsed.get('CertFile')]).toEqual(['yes', '2', '/etc/pki/pure-ftpd/pure-ftpd.pem'])
    expect(el.postActions.some(action => action.kind === 'exec' && action.argv[0] === '/usr/bin/ln')).toBe(false)
  })
  it('makes the self-signed certificate only when it is missing, before the service starts', () => {
    const missing = compileFtpServer(snapshot(), { os: debian, certPresent: false, anonymous: {} }).postActions
    const cert = missing.findIndex(action => action.kind === 'exec' && action.argv[0] === '/usr/bin/openssl'), start = missing.findIndex(action => action.kind === 'systemd' && action.verb === 'start' && action.unit === 'pure-ftpd')
    expect(cert).toBeGreaterThanOrEqual(0); expect(cert).toBeLessThan(start)
    expect(argvs(compileFtpServer(snapshot(), { os: debian, certPresent: true, anonymous: {} }).postActions).join()).not.toContain('openssl')
  })
  it('keeps the daemon off while FTP Server Selection disables it, even with the setting on', () => {
    const on = compileFtpServer(snapshot(), { os: debian, certPresent: true, anonymous: {} }).postActions
    const off = compileFtpServer(snapshot(), { os: debian, certPresent: true, anonymous: {}, roleEnabled: false }).postActions
    expect(on).toContainEqual({ kind: 'systemd', verb: 'start', unit: debian.services.ftp })
    expect(off).not.toContainEqual({ kind: 'systemd', verb: 'start', unit: debian.services.ftp })
    expect(off).toContainEqual({ kind: 'systemd', verb: 'stop', unit: debian.services.ftp })
  })

  it('stops and disables the only daemon when FTP is turned off', () => {
    const { postActions } = compileFtpServer(snapshot({ ...DEFAULT_SERVER_FTP_SETTINGS, enabled: false }), { os: debian, certPresent: true, anonymous: { [id]: { enabled: true, uploads: true } } })
    expect(postActions).toContainEqual({ kind: 'systemd', verb: 'stop', unit: 'pure-ftpd' })
    expect(postActions).toContainEqual({ kind: 'systemd', verb: 'disable', unit: 'pure-ftpd' })
    expect(postActions).not.toContainEqual({ kind: 'systemd', verb: 'start', unit: 'pure-ftpd' })
  })
  it('restarts pure-ftpd only when a daemon file changed, never for a password change', () => {
    const files = compileFtpServer(snapshot(), { os: debian, certPresent: true, anonymous: {} }).files, hash = (text: string) => 'h' + text.length
    const same = files.map(file => ({ path: file.path, sha256: hash(file.content) }))
    expect(ftpRestartActions(debian, files, same, hash, true)).toEqual([])
    expect(ftpRestartActions(debian, [...files, { path: '/etc/pure-ftpd/pureftpd.passwd', content: 'x', mode: 0o600, owner: 'root', group: 'root' }, { path: FTP_ANONYMOUS_MAP, content: 'x', mode: 0o644, owner: 'root', group: 'root' }], same, hash, true)).toEqual([])
    expect(ftpRestartActions(debian, files, same.slice(1), hash, true)).toEqual([{ kind: 'systemd', verb: 'restart', unit: 'pure-ftpd' }])
    expect(ftpRestartActions(debian, files, undefined, hash, false)).toEqual([])
  })
})

describe('Anonymous FTP host effect', () => {
  const state = { [id]: { enabled: true, uploads: false } }
  it('maps one anonymous login per domain, only for active accounts on a server that allows it', () => {
    expect(anonymousFtpLogins(snapshot(open), open, state).map(row => row.login)).toEqual(['anonymous@example.test', 'anonymous@shop.example.test'])
    expect(anonymousFtpLogins(snapshot(), DEFAULT_SERVER_FTP_SETTINGS, state)).toEqual([])
    expect(anonymousFtpLogins(snapshot(open, [{ ...account, status: 'suspended' }]), open, state)).toEqual([])
    expect(anonymousFtpLogins(snapshot(open, [{ ...account, home: '/srv/alice' }]), open, state)).toEqual([])
  })
  it('serves through a nosymfollow view, read-only unless uploads are on at both levels', () => {
    const readOnly = compileFtpServer(snapshot(open), { os: debian, certPresent: true, anonymous: state })
    const unit = readOnly.files.find(file => file.path.endsWith('run-xpanelftp-ro-home.mount'))!
    expect(unit.content).toContain('Options=bind,ro,nosymfollow,nosuid,nodev,noexec')
    expect(unit.content).toContain('What=/home')
    expect(readOnly.files.find(file => file.path === FTP_ANONYMOUS_MAP)?.content).toBe('anonymous@example.test\t/run/xpanelftp/ro/home/alice/public_ftp/./\nanonymous@shop.example.test\t/run/xpanelftp/ro/home/alice/public_ftp/./\n')
    const writable = compileFtpServer(snapshot(open), { os: debian, certPresent: true, anonymous: { [id]: { enabled: true, uploads: true } } })
    expect(writable.files.some(file => file.path.endsWith('run-xpanelftp-rw-home.mount'))).toBe(true)
    expect(writable.postActions).toContainEqual({ kind: 'systemd', verb: 'stop', unit: 'run-xpanelftp-ro-home.mount' })
    const closed = compileFtpServer(snapshot({ ...open, anonymousUploads: false }), { os: debian, certPresent: true, anonymous: { [id]: { enabled: true, uploads: true } } })
    expect(closed.files.some(file => file.path.endsWith('run-xpanelftp-rw-home.mount'))).toBe(false)
  })
  it('touches no account home in a generation, starts sign-in before the wrapper check and tries PureDB before ExtAuth', () => {
    const { postActions, files } = compileFtpServer(snapshot(open), { os: debian, certPresent: true, anonymous: state })
    expect(postActions.some(action => action.kind === 'exec' && action.argv.some(arg => arg.startsWith('/home/')))).toBe(false)
    const auth = postActions.findIndex(action => action.kind === 'systemd' && action.verb === 'start' && action.unit === 'xpanel-ftp-anonymous-auth.service'), wrapper = postActions.findIndex(action => action.kind === 'exec' && action.argv[0] === '/usr/sbin/pure-ftpd-wrapper')
    expect(auth).toBeGreaterThanOrEqual(0); expect(auth).toBeLessThan(wrapper)
    expect(files.find(file => file.path.endsWith('xpanel-ftp-anonymous-auth.service'))?.content).toContain("ExecStartPost=/usr/bin/timeout 5 /bin/sh -c 'until [ -S /run/xpanel-ftp-auth/auth.sock ]; do sleep 0.1; done'")
    expect(files.find(file => file.path === '/etc/pure-ftpd/conf/ExtAuth')).toBeDefined()
    expect(argvs(postActions)).toContain('/usr/bin/ln -sfn ../conf/ExtAuth /etc/pure-ftpd/auth/60extauth')
    const conf = renderPureFtpdConfFile(open, '/run/x.sock', '/c.pem')
    expect(conf.indexOf('PureDB ')).toBeLessThan(conf.indexOf('ExtAuth '))
  })
  it('answers pure-authd only for mapped logins, treating the login as data', () => {
    const script = compileFtpServer(snapshot(open), { os: debian, certPresent: true, anonymous: state }).files.find(file => file.path.endsWith('xpanel-anonymous-auth'))!
    const map = process.env.TMPDIR + '/ftp-anon-map-' + process.pid
    execFileSync('/bin/sh', ['-c', 'printf "anonymous@example.test\\t/run/xpanelftp/ro/home/alice/public_ftp/./\\n" > "$0"', map])
    const run = (login: string) => execFileSync('/bin/sh', ['-c', script.content.replaceAll(FTP_ANONYMOUS_MAP, map)], { env: { ...process.env, AUTHD_ACCOUNT: login } }).toString()
    expect(run('anonymous@example.test')).toBe('auth_ok:1\nuid:65534\ngid:65534\ndir:/run/xpanelftp/ro/home/alice/public_ftp/./\nend\n')
    expect(run('anonymous@none.test')).toBe('auth_ok:0\nend\n')
    expect(run('x" == "x" { system("id") } "')).toBe('auth_ok:0\nend\n')
    execFileSync('/bin/rm', ['-f', map])
  })
  it('refuses a malformed saved state and an upload flag without access', () => {
    expect(parseAnonymousFtpState(null)).toEqual({})
    expect(() => parseAnonymousFtpState({ [id]: { enabled: false, uploads: true } })).toThrow()
    expect(() => parseAnonymousFtpState([])).toThrow()
  })
  it('stays inside the production host targets', () => {
    const allowed = createProductionHostTargetMatcher(), { files } = compileFtpServer(snapshot(open), { os: debian, certPresent: true, anonymous: state })
    for (const file of files) expect(allowed(file.path, 'write'), file.path).toBe(true)
  })
})
