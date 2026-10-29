import { describe, expect, it, vi } from 'vitest'
import { parseFail2banJail, parseFail2banStatus, readIntrusion, unbanAddress } from './security-tools-intrusion.ts'

const status = (jails: string[]) => `Status\n|- Number of jail:\t${jails.length}\n\`- Jail list:\t${jails.join(', ')}\n`
const jail = (name: string, banned: string[], extra = '') => `Status for the jail: ${name}\n|- Filter\n|  |- Currently failed:\t3\n|  |- Total failed:\t120\n|  \`- File list:\t/var/log/auth.log\n\`- Actions\n   |- Currently banned:\t${banned.length}\n   |- Total banned:\t15\n   \`- Banned IP list:\t${banned.join(' ')}${extra}\n`
const ok = (stdout: string) => ({ ok: true, code: 0, stdout, stderr: '' })
const now = () => new Date('2026-10-27T10:00:00Z')

describe('fail2ban status parsing', () => {
  it('reads the documented status tree, including journal matches and empty lists', () => {
    expect(parseFail2banStatus(status(['sshd', 'postfix-sasl']))).toEqual({ jails: ['sshd', 'postfix-sasl'] })
    expect(parseFail2banStatus(status([]))).toEqual({ jails: [] })
    expect(parseFail2banJail(jail('sshd', ['192.0.2.1', '2001:db8::7']), 'sshd')).toEqual({ name: 'sshd', state: 'read', currentlyFailed: 3, totalFailed: 120, currentlyBanned: 2, totalBanned: 15, banned: ['192.0.2.1', '2001:db8::7'], truncated: false })
    const journal = jail('sshd', []).replace('File list:\t/var/log/auth.log', 'Journal matches:\t_SYSTEMD_UNIT=sshd.service + _COMM=sshd')
    expect(parseFail2banJail(journal, 'sshd')).toMatchObject({ banned: [], currentlyBanned: 0 })
    expect(parseFail2banJail(jail('sshd', ['198.51.100.0/24']), 'sshd')!.banned).toEqual(['198.51.100.0/24'])
  })
  it('bounds the banned list and refuses malformed or mismatched output', () => {
    const many = Array.from({ length: 12 }, (_, index) => '192.0.2.' + (index + 1))
    expect(parseFail2banJail(jail('sshd', many), 'sshd', 5)).toMatchObject({ banned: many.slice(0, 5), truncated: true, currentlyBanned: 12 })
    for (const bad of ['', 'Status\n', status(['sshd']).replace('1', '2'), 'ERROR  Failed to access socket path: /var/run/fail2ban/fail2ban.sock. Is fail2ban running?\n', status(['sshd']) + '`- Jail list:\tx\n', status(['ss\u202ehd'])]) expect(parseFail2banStatus(bad)).toBeNull()
    expect(parseFail2banJail(jail('sshd', ['192.0.2.1']), 'postfix')).toBeNull()
    expect(parseFail2banJail(jail('sshd', ['192.0.2.1;id']), 'sshd')).toBeNull()
    expect(parseFail2banJail(jail('sshd', ['example.test']), 'sshd')).toBeNull()
    expect(parseFail2banJail(jail('sshd', ['192.0.2.0/33']), 'sshd')).toBeNull()
    expect(parseFail2banJail(jail('sshd', []).replace(/.*Total banned.*\n/, ''), 'sshd')).toBeNull()
  })
})

describe('intrusion observation', () => {
  it('reports not installed truthfully without running anything', async () => {
    const run = vi.fn()
    expect(await readIntrusion({ run, present: async () => false, now })).toEqual({ state: 'not_installed', observedAt: '2026-10-27T10:00:00.000Z', jails: [], unsupportedJails: 0, jailsTruncated: false })
    expect(run).not.toHaveBeenCalled()
  })
  it('reads each reviewed jail, counts unsupported names and shares one banned budget', async () => {
    const run = vi.fn(async (argv: string[]) => argv.length === 2 ? ok(status(['sshd', 'Bad.Jail', 'postfix'])) : argv[2] === 'sshd' ? ok(jail('sshd', ['192.0.2.1'])) : { ok: false, code: 255, stdout: '', stderr: 'error' })
    const read = await readIntrusion({ run, present: async () => true, now })
    expect(read).toMatchObject({ state: 'read', unsupportedJails: 1, jailsTruncated: false, jails: [{ name: 'sshd', state: 'read', banned: ['192.0.2.1'] }, { name: 'postfix', state: 'unavailable', banned: [] }] })
    expect(run.mock.calls.map(call => call[0].join(' '))).toEqual(['/usr/bin/fail2ban-client status', '/usr/bin/fail2ban-client status sshd', '/usr/bin/fail2ban-client status postfix'])
  })
  it('keeps a stopped service or garbage output unavailable, never empty-and-ok', async () => {
    expect(await readIntrusion({ run: async () => ({ ok: false, code: 255, stdout: '', stderr: 'Is fail2ban running?' }), present: async () => true, now })).toMatchObject({ state: 'unavailable', reason: 'command_failed', jails: [] })
    expect(await readIntrusion({ run: async () => ok('garbage'), present: async () => null, now })).toMatchObject({ state: 'unavailable', reason: 'malformed_output' })
    expect(await readIntrusion({ run: async () => { throw new Error('spawn') }, present: async () => { throw new Error('stat') }, now })).toMatchObject({ state: 'unavailable', reason: 'command_failed' })
  })
})

describe('single-address unban', () => {
  const host = (sequence: string[][], unbanOk = true) => {
    const events: string[] = []
    const run = vi.fn(async (argv: string[]) => {
      events.push(argv.slice(1).join(' '))
      if (argv[1] === 'set') return unbanOk ? ok('1\n') : { ok: false, code: 255, stdout: '', stderr: 'refused' }
      return ok(jail('sshd', sequence.shift() ?? []))
    })
    return { run, events }
  }
  it('re-reads, re-authorizes, unbans exactly one address and confirms by re-read', async () => {
    const { run, events } = host([['192.0.2.1', '192.0.2.9'], ['192.0.2.9']])
    const authorize = vi.fn(async () => { events.push('authorize') })
    expect(await unbanAddress({ run, jail: 'sshd', address: '192.0.2.1', authorize, now })).toEqual({ jail: 'sshd', address: '192.0.2.1', outcome: 'confirmed', verificationRequired: false, after: { banned: false }, observedAt: '2026-10-27T10:00:00.000Z' })
    expect(events).toEqual(['status sshd', 'authorize', 'set sshd unbanip 192.0.2.1', 'status sshd'])
  })
  it('returns 409 conflict without any change when the address is not banned in that jail', async () => {
    const { run, events } = host([['192.0.2.9']])
    await expect(unbanAddress({ run, jail: 'sshd', address: '192.0.2.1', now })).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    expect(events).toEqual(['status sshd'])
  })
  it('refuses injection before any command and reports unproven outcomes as unknown', async () => {
    const { run } = host([])
    for (const [jailName, address] of [['-h', '192.0.2.1'], ['sshd', '192.0.2.0/24'], ['sshd', '--all'], ['sshd;id', '192.0.2.1'], ['sshd', ['192.0.2.1']]]) await expect(unbanAddress({ run, jail: jailName, address, now })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(run).not.toHaveBeenCalled()
    await expect(unbanAddress({ ...host([['192.0.2.1'], ['192.0.2.1']], false), jail: 'sshd', address: '192.0.2.1', now })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    expect(await unbanAddress({ ...host([['192.0.2.1'], ['192.0.2.1']]), jail: 'sshd', address: '192.0.2.1', now })).toMatchObject({ outcome: 'unknown', verificationRequired: true, after: { banned: true } })
    expect(await unbanAddress({ ...host([['192.0.2.1'], []], false), jail: 'sshd', address: '192.0.2.1', now })).toMatchObject({ outcome: 'unknown', after: { banned: false } })
    await expect(unbanAddress({ run: async () => ok('garbage'), jail: 'sshd', address: '192.0.2.1', now })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
})
