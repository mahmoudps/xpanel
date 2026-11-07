import { describe, expect, it, vi } from 'vitest'
import { countSshLogins, handleSshHostRoute, listeningPorts, otherAdministrators, parseSshLogins, rootPasswordUsable, type SshHostContext } from './ssh-host.ts'
import { sshdObservedRunning, sshdPolicyOf, sshdReloadActions } from './ssh-reconcile.ts'

const cursor = (n: number): string => 's=' + 'a'.repeat(32) + ';i=' + n.toString(16) + ';b=' + 'b'.repeat(32) + ';m=2a;t=61b;x=9c'
const entry = (message: string, n = 1, extra: Record<string, unknown> = {}) => JSON.stringify({ __CURSOR: cursor(n), __REALTIME_TIMESTAMP: '1793000000000000', MESSAGE: message, _UID: '0', _SYSTEMD_UNIT: 'ssh.service', _COMM: 'sshd', _EXE: '/usr/sbin/sshd', ...extra })
const os = { id: 'ubuntu', versionId: '22.04', services: { sshd: 'ssh' } } as Awaited<ReturnType<SshHostContext['os']>>
const ok = (stdout = '') => ({ ok: true, stdout, stderr: '' })
const call = async (path: string, ctx: Partial<SshHostContext>, body?: unknown) => {
  const url = new URL('http://agent.local' + path)
  const request = new Request(url, { method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) })
  try {
    const response = await handleSshHostRoute(request, url, request.method, { assertRoot: async () => ({ actor: 'root' }), run: async () => ok(), os: async () => os, rootKeys: async () => 1, selinux: async () => false, readText: async () => null, probe: async () => 'banner', ...ctx })
    return { status: response!.status, body: await response!.json() as Record<string, any> }
  } catch (error) { return { status: (error as { status: number }).status, body: { code: (error as { code: string }).code, detail: (error as { detail: Record<string, unknown> }).detail } as Record<string, any> } }
}

describe('SSH journal readers', { tags: ['unit'] }, () => {
  it('reports each accepted login with its address, and keeps the cursor past other lines', () => {
    const read = parseSshLogins([entry('Accepted publickey for root from 203.0.113.7 port 50022 ssh2: ED25519 SHA256:x', 1), entry('Failed password for root from 203.0.113.9 port 1 ssh2', 2)].join('\n'), 'ssh.service')
    expect(read.items).toEqual([{ id: cursor(1), at: new Date(1793000000000).toISOString(), address: '203.0.113.7', port: 50022, username: 'root', method: 'publickey' }])
    expect(read).toMatchObject({ cursor: cursor(2), complete: true })
  })

  it('trusts only the root sshd of this unit, including the EL 10 session binary', () => {
    const line = 'Accepted password for root from 203.0.113.7 port 2 ssh2'
    expect(parseSshLogins(entry(line, 1, { _UID: '1000' }), 'ssh.service').items).toEqual([])
    expect(parseSshLogins(entry(line, 1, { _SYSTEMD_UNIT: 'evil.service' }), 'ssh.service').items).toEqual([])
    expect(parseSshLogins(entry(line, 1, { _COMM: 'sshd-session', _EXE: '/usr/libexec/openssh/sshd-session' }), 'ssh.service').items).toHaveLength(1)
    expect(parseSshLogins(entry('Accepted password for root from not-an-ip port 2 ssh2'), 'ssh.service').items).toEqual([])
  })

  it('counts accepted and failed attempts and says when the read was cut short', () => {
    expect(countSshLogins('Accepted publickey for root\nFailed password for x\nFailed password for y\nConnection closed\n')).toEqual({ accepted: 1, failed: 2, complete: true })
    expect(countSshLogins('Failed x\n'.repeat(30000)).complete).toBe(false)
  })
})

describe('SSH access facts', { tags: ['unit'] }, () => {
  it('counts sudo and wheel members with an ordinary shell, and never root or a jailed account', () => {
    const passwd = 'root:x:0:0::/root:/bin/bash\nops:x:1000:1000::/home/ops:/bin/bash\nalice:x:20001:20001::/home/alice:/opt/xpanel/bin/jailshell\nsvc:x:999:999::/:/usr/sbin/nologin\n'
    expect(otherAdministrators('sudo:x:27:ops,root,alice,svc\nadm:x:4:bob\n', passwd)).toBe(1)
    expect(otherAdministrators('wheel:x:10:root\n', passwd)).toBe(0)
  })
  it('sees a usable hash, never a locked one', () => {
    expect(rootPasswordUsable('root:$6$abc:19000:0:::::\n')).toBe(true)
    expect(rootPasswordUsable('root:!$6$abc:19000:0:::::\n')).toBe(false)
    expect(rootPasswordUsable('root:*:19000:0:::::\n')).toBe(false)
  })
  it('reads listening ports from the kernel tables', () => {
    const header = '  sl  local_address rem_address   st\n'
    expect([...listeningPorts([header + '   0: 00000000:0016 00000000:0000 0A 0\n   1: 0100007F:1F90 00000000:0000 01 0\n', header + '   0: 00000000000000000000000000000000:0050 00000000000000000000000000000000:0000 0A 0\n'])].sort()).toEqual([22, 80])
  })
})

describe('SSH host routes', { tags: ['unit'] }, () => {
  it('starts an alarm at the present and reads only from a reviewed cursor', async () => {
    const run = vi.fn(async () => ok(entry('Accepted password for root from 203.0.113.7 port 2 ssh2', 9)))
    expect((await call('/host/security/ssh/logins', { run })).body).toEqual({ cursor: cursor(9), items: [], complete: true })
    expect((await call('/host/security/ssh/logins?after=' + encodeURIComponent(cursor(8)), { run })).body.items).toHaveLength(1)
    expect((await call('/host/security/ssh/logins?after=--since', { run })).status).toBe(400)
  })

  it('stays unavailable without a native host', async () => {
    expect((await call('/host/security/ssh/counters', { run: null })).status).toBe(412)
  })

  it('reports the ways in without any secret and finds a busy port', async () => {
    const files: Record<string, string> = { '/etc/group': 'sudo:x:27:ops\n', '/etc/passwd': 'ops:x:1000:1000::/home/ops:/bin/bash\n', '/etc/shadow': 'root:$6$secret:1:0:::::\n', '/proc/net/tcp': 'h\n 0: 00000000:55C6 00000000:0000 0A 0\n' }
    const { body } = await call('/host/security/ssh/prepare', { readText: async path => files[path] ?? null }, { port: 21958 })
    expect(body).toEqual({ access: { rootKeys: 1, rootPassword: true, otherAdministrators: 1 }, portInUse: true, portLabel: 'not_needed' })
    expect(JSON.stringify(body)).not.toContain('secret')
  })

  it('labels a new port for SELinux, adding or modifying, and refuses when policy refuses', async () => {
    const calls: string[][] = []
    const run = vi.fn(async (argv: string[]) => { calls.push(argv); return argv.includes('-l') ? ok('ssh_port_t tcp 22\nhttp_port_t tcp 80, 8080\n') : ok() })
    await call('/host/security/ssh/prepare', { run, selinux: async () => true }, { port: 22022 })
    expect(calls.at(-1)).toEqual(['/usr/sbin/semanage', 'port', '-a', '-t', 'ssh_port_t', '-p', 'tcp', '22022'])
    await call('/host/security/ssh/prepare', { run, selinux: async () => true }, { port: 8080 })
    expect(calls.at(-1)).toEqual(['/usr/sbin/semanage', 'port', '-m', '-t', 'ssh_port_t', '-p', 'tcp', '8080'])
    calls.length = 0
    await call('/host/security/ssh/prepare', { run, selinux: async () => true }, { port: 22 })
    expect(calls).toHaveLength(1)
    const refused = await call('/host/security/ssh/prepare', { run: async argv => argv.includes('-l') ? ok('') : { ok: false, stdout: '', stderr: '' }, selinux: async () => true }, { port: 22022 })
    expect(refused).toMatchObject({ status: 412, body: { detail: { reason: 'selinux_port_refused' } } })
  })

  it('stops the socket and the service, then proves the port refuses', async () => {
    const calls: string[][] = []
    const run = async (argv: string[]) => { calls.push(argv); return argv[1] === 'show' ? ok('ActiveState=inactive\n') : argv[1] === '-T' ? ok('port 2222\n') : ok() }
    const probe = vi.fn(async () => 'refused' as const)
    const { body } = await call('/host/security/ssh/service', { run, probe, os: async () => ({ ...os, versionId: '24.04' }) }, { action: 'stop' })
    expect(calls.slice(0, 2)).toEqual([['/usr/bin/systemctl', 'stop', '--', 'ssh.socket'], ['/usr/bin/systemctl', 'stop', '--', 'ssh.service']])
    expect(probe).toHaveBeenCalledWith(2222)
    expect(body).toEqual({ action: 'stop', active: 'inactive', answer: 'refused', verified: true })
  })

  it('reports a start that does not answer as unverified', async () => {
    const { body } = await call('/host/security/ssh/service', { run: async argv => argv[1] === 'show' ? ok('ActiveState=active\n') : ok(''), probe: async () => 'silent' }, { action: 'start' })
    expect(body).toMatchObject({ verified: false, answer: 'silent' })
  })

  it('refuses any other verb', async () => {
    expect((await call('/host/security/ssh/service', {}, { action: 'mask' })).status).toBe(400)
  })
})

describe('SSH in a generation', { tags: ['unit'] }, () => {
  const profile = { id: 'ubuntu', versionId: '22.04', paths: { sshdConfig: '/etc/ssh/sshd_config' }, services: { sshd: 'ssh' } } as never
  const file = { path: '/etc/ssh/sshd_config.d/00-xpanel.conf', content: 'new', mode: 0o600, owner: 'root', group: 'root' }
  const hash = (text: string): string => text
  it('reloads only for a changed drop-in, and never starts a stopped daemon', () => {
    expect(sshdReloadActions(profile, [file], [{ path: file.path, sha256: 'old' }], hash, true)).toEqual([{ kind: 'systemd', verb: 'reload', unit: 'ssh' }])
    expect(sshdReloadActions(profile, [file], [{ path: file.path, sha256: 'new' }], hash, true)).toEqual([])
    expect(sshdReloadActions(profile, [file], [{ path: file.path, sha256: 'old' }], hash, false)).toEqual([])
    expect(sshdReloadActions(profile, [file], undefined, hash, true)).toEqual([])
    expect(sshdObservedRunning('ActiveState=inactive\n')).toBe(false)
    expect(sshdObservedRunning('')).toBe(true)
  })
  it('keeps both ports only during a change', () => {
    const settings = { sshPort: 22022, ssh: { passwordAuth: true, pubkeyAuth: true, rootLogin: 'no', loginAlarm: false, previousPort: 22, jail: { privateTmp: false, hiddenHomes: false, systemView: false, exceptions: [] } } } as never
    expect(sshdPolicyOf(settings)).toEqual({ port: 22022, previousPort: 22, passwordAuth: true, pubkeyAuth: true, rootLogin: 'no' })
    expect(sshdPolicyOf({ sshPort: 22 } as never)).toEqual({ port: 22, passwordAuth: false, pubkeyAuth: true, rootLogin: 'prohibit-password' })
  })
})
