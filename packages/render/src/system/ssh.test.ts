import { describe, expect, it } from 'vitest'
import { XpanelError } from '@xpanel/core'
import {
  banDecisions,
  parseAuthFailures,
  renderSshdDropin,
  sshdApplyActions,
  sshdConfigTest,
  verifySshdEffective,
  type AuthFailure,
  type SshdSettings,
} from './ssh.ts'
import { debianOs, rhelOs } from './testkit.ts'

const codeOf = (f: () => unknown): string => {
  try {
    f()
  } catch (e) {
    if (e instanceof XpanelError) return e.code
    throw e
  }
  throw new Error('did not throw')
}

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0) / 1000

describe('renderSshdDropin', () => {
  it('writes the policy into a drop-in read before distro drop-ins', () => {
    const f = renderSshdDropin({ port: 2222, passwordAuth: false, rootLogin: 'prohibit-password' }, debianOs)
    expect(f.path).toBe('/etc/ssh/sshd_config.d/00-xpanel.conf')
    expect(f.mode).toBe(0o600)
    const lines = f.content.split('\n').filter((l) => l && !l.startsWith('#'))
    expect(lines).toEqual([
      'Port 2222',
      'PubkeyAuthentication yes',
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
      'PermitRootLogin prohibit-password',
    ])
  })

  it('renders each root policy and password setting', () => {
    for (const rootLogin of ['yes', 'prohibit-password', 'no'] as const) {
      expect(renderSshdDropin({ port: 22, passwordAuth: true, rootLogin }, rhelOs).content).toContain(`PermitRootLogin ${rootLogin}\n`)
    }
    expect(renderSshdDropin({ port: 22, passwordAuth: true, rootLogin: 'yes' }, rhelOs).content).toContain('PasswordAuthentication yes\n')
  })

  it('renders AllowUsers and refuses lists that would lock root out', () => {
    const f = renderSshdDropin({ port: 22, passwordAuth: false, rootLogin: 'prohibit-password', allowUsers: ['root', 'alice@192.0.2.0/24', 'root'] }, debianOs)
    expect(f.content).toContain('AllowUsers root alice@192.0.2.0/24\n')
    const canonical = renderSshdDropin({ port: 22, passwordAuth: false, rootLogin: 'no', allowUsers: ['bob@2001:DB8:0::/32', 'carol@::ffff:198.51.100.7'] }, debianOs)
    expect(canonical.content).toContain('AllowUsers bob@2001:db8::/32 carol@198.51.100.7\n')
    expect(verifySshdEffective('port 22\npasswordauthentication no\npermitrootlogin no\nallowusers bob@2001:db8::/32\nallowusers carol@198.51.100.7\n', {
      port: 22, passwordAuth: false, rootLogin: 'no', allowUsers: ['bob@2001:DB8:0::/32', 'carol@::ffff:198.51.100.7'],
    })).toEqual([])
    expect(codeOf(() => renderSshdDropin({ port: 22, passwordAuth: false, rootLogin: 'yes', allowUsers: ['alice'] }, debianOs))).toBe('SELF_LOCKOUT')
    expect(() => renderSshdDropin({ port: 22, passwordAuth: false, rootLogin: 'no', allowUsers: ['alice'] }, debianOs)).not.toThrow()
  })

  it.each([
    ['port 0', { port: 0 }],
    ['port overflow', { port: 65536 }],
    ['port string', { port: '22\nPermitRootLogin yes' }],
    ['root policy', { rootLogin: 'without-password' }],
    ['root injection', { rootLogin: 'yes\nPasswordAuthentication yes' }],
    ['password string', { passwordAuth: 'no' }],
    ['empty allowUsers', { allowUsers: [] }],
    ['allowUsers space', { allowUsers: ['root alice'] }],
    ['allowUsers newline', { allowUsers: ['root\nPermitRootLogin yes'] }],
    ['allowUsers glob', { allowUsers: ['root', '*'] }],
    ['allowUsers host', { allowUsers: ['root', 'alice@evil host'] }],
    ['allowUsers bad cidr', { allowUsers: ['root', 'alice@10.0.0.1/8'] }],
  ])('rejects %s', (_, patch) => {
    const base: SshdSettings = { port: 22, passwordAuth: false, rootLogin: 'prohibit-password' }
    expect(() => renderSshdDropin({ ...base, ...patch } as SshdSettings, debianOs)).toThrowError(XpanelError)
  })

  it('tests the main config and applies per distro', () => {
    expect(sshdConfigTest(debianOs)).toEqual({ name: 'sshd', argv: ['/usr/sbin/sshd', '-t', '-f', '/etc/ssh/sshd_config'] })
    expect(sshdApplyActions(debianOs)).toEqual([
      { kind: 'systemd-daemon-reload' },
      { kind: 'systemd', verb: 'restart', unit: 'ssh.socket' },
      { kind: 'systemd', verb: 'restart', unit: 'ssh' },
    ])
    expect(sshdApplyActions({ ...debianOs, versionId: '22.04' })).toEqual([
      { kind: 'systemd-daemon-reload' },
      { kind: 'systemd', verb: 'restart', unit: 'ssh' },
    ])
    expect(sshdApplyActions(rhelOs).map((a) => (a.kind === 'systemd' ? a.unit : a.kind))).toEqual(['systemd-daemon-reload', 'sshd'])
  })
})

describe('verifySshdEffective', () => {
  const desired: SshdSettings = { port: 22, passwordAuth: false, rootLogin: 'prohibit-password', allowUsers: ['root', 'alice'] }
  it('accepts matching sshd -T output, including the without-password alias', () => {
    const out = 'port 22\npasswordauthentication no\npermitrootlogin without-password\nallowusers root\nallowusers alice\n'
    expect(verifySshdEffective(out, desired)).toEqual([])
  })
  it('reports stray ports and overridden values', () => {
    const out = 'port 22\nport 2222\npasswordauthentication yes\npermitrootlogin yes\nallowusers root\n'
    expect(verifySshdEffective(out, desired)).toHaveLength(4)
  })
})

describe('parseAuthFailures', () => {
  const opts = { now: NOW }

  it('reads auth.log BSD lines, RFC 3339 lines, journal short-iso and short-unix', () => {
    const lines = [
      'Oct 22 11:59:01 web1 sshd[1201]: Failed password for root from 203.0.113.5 port 52314 ssh2',
      'Oct  2 08:00:00 web1 sshd[1202]: Failed password for invalid user admin from 203.0.113.6 port 40000 ssh2',
      '2026-10-22T11:58:00.123456+00:00 web1 sshd[1203]: Invalid user oracle from 2001:db8::7 port 51000',
      '2026-10-22T13:58:00+0200 web1 sshd-session[1204]: Failed password for alice from ::ffff:198.51.100.8 port 1022 ssh2',
      `${NOW - 30}.123456 web1 sshd[1205]: Failed password for bob from 198.51.100.9 port 2000 ssh2`,
      'Oct 22 11:59:02 web1 sshd[1206]: Accepted publickey for root from 192.0.2.1 port 50000 ssh2',
      'Oct 22 11:59:03 web1 sshd[1207]: Connection closed by authenticating user root 192.0.2.2 port 50001 [preauth]',
      'Oct 22 11:59:04 web1 CRON[99]: Failed password for root from 192.0.2.3 port 1 ssh2',
      'garbage',
    ]
    const ev = parseAuthFailures(lines, opts)
    expect(ev.map((e) => [e.ip, e.kind, e.user, e.at])).toEqual([
      ['203.0.113.5', 'failed-password', 'root', NOW - 59],
      ['203.0.113.6', 'failed-password', 'admin', Date.UTC(2026, 9, 2, 8, 0, 0) / 1000],
      ['2001:db8::7', 'invalid-user', 'oracle', NOW - 120],
      ['198.51.100.8', 'failed-password', 'alice', NOW - 120],
      ['198.51.100.9', 'failed-password', 'bob', NOW - 30],
    ])
    expect(ev[3]?.family).toBe(4)
    expect(ev[2]?.family).toBe(6)
  })

  it('expands rsyslog repeat lines', () => {
    const ev = parseAuthFailures(['Oct 22 11:00:00 h sshd[1]: message repeated 3 times: [ Failed password for root from 203.0.113.5 port 22 ssh2]'], opts)
    expect(ev).toHaveLength(3)
  })

  it('does not double count an invalid user that also failed a password on the same connection', () => {
    const ev = parseAuthFailures([
      'Oct 22 11:00:00 h sshd[1]: Invalid user test from 203.0.113.5 port 5000',
      'Oct 22 11:00:01 h sshd[1]: Failed password for invalid user test from 203.0.113.5 port 5000 ssh2',
      'Oct 22 11:00:02 h sshd[1]: Failed password for invalid user test from 203.0.113.5 port 5000 ssh2',
      'Oct 22 11:00:03 h sshd[2]: Invalid user guest from 203.0.113.5 port 5001',
    ], opts)
    expect(ev.map((e) => e.kind)).toEqual(['failed-password', 'failed-password', 'invalid-user'])
  })

  it('takes the last "from <ip>" so a crafted username cannot frame another address', () => {
    const ev = parseAuthFailures([
      'Oct 22 11:00:00 h sshd[1]: Invalid user x from 10.0.0.1 port 22 from 203.0.113.50 port 5555',
      'Oct 22 11:00:01 h sshd[1]: Failed password for invalid user y from 192.0.2.1 port 1 ssh2 from 203.0.113.51 port 5556 ssh2',
    ], opts)
    expect(ev.map((e) => e.ip)).toEqual(['203.0.113.50', '203.0.113.51'])
    expect(ev[0]?.user).toBe('x from 10.0.0.1 port 22')
  })

  it('places December stamps read in January in the previous year', () => {
    const jan = Date.UTC(2027, 0, 1, 0, 10, 0) / 1000
    const [ev] = parseAuthFailures(['Dec 31 23:59:00 h sshd[1]: Failed password for root from 203.0.113.5 port 1 ssh2'], { now: jan })
    expect(ev?.at).toBe(Date.UTC(2026, 11, 31, 23, 59, 0) / 1000)
  })

  it('applies the host UTC offset to BSD stamps', () => {
    const [ev] = parseAuthFailures(['Oct 22 14:00:00 h sshd[1]: Failed password for root from 203.0.113.5 port 1 ssh2'], { now: NOW, utcOffsetMinutes: 180 })
    expect(ev?.at).toBe(NOW - 3600)
  })

  it('skips lines with invalid addresses, overlong lines and non-strings', () => {
    const ev = parseAuthFailures([
      'Oct 22 11:00:00 h sshd[1]: Failed password for root from 999.1.1.1 port 1 ssh2',
      'Oct 22 11:00:00 h sshd[1]: Failed password for root from fe80::1%eth0 port 1 ssh2',
      `Oct 22 11:00:00 h sshd[1]: Failed password for ${'a'.repeat(5000)} from 203.0.113.5 port 1 ssh2`,
      5 as unknown as string,
    ], opts)
    expect(ev).toEqual([])
  })

  it('accepts a single string with CRLF line ends', () => {
    expect(parseAuthFailures('Oct 22 11:00:00 h sshd[1]: Failed password for root from 203.0.113.5 port 1 ssh2\r\n', opts)).toHaveLength(1)
  })
})

describe('banDecisions', () => {
  const f = (ip: string, ago: number): AuthFailure => ({ at: NOW - ago, ip, family: ip.includes(':') ? 6 : 4, user: 'root', kind: 'failed-password', port: 1 })

  it('bans at the threshold inside the window and not below it', () => {
    const failures = [f('203.0.113.5', 10), f('203.0.113.5', 20), f('203.0.113.5', 30), f('203.0.113.6', 10), f('203.0.113.6', 20)]
    expect(banDecisions(failures, { threshold: 3, windowSec: 600, now: NOW })).toEqual([
      { ip: '203.0.113.5', family: 4, failures: 3, firstAt: NOW - 30, lastAt: NOW - 10 },
    ])
  })

  it('uses a half-open window (now - window, now]', () => {
    const failures = [f('203.0.113.5', 600), f('203.0.113.5', 599), f('203.0.113.5', 0), f('203.0.113.5', -5)]
    const [d] = banDecisions(failures, { threshold: 2, windowSec: 600, now: NOW })
    expect(d?.failures).toBe(2)
    expect(banDecisions(failures, { threshold: 3, windowSec: 600, now: NOW })).toEqual([])
  })

  it('never bans loopback, allowlisted or already banned addresses', () => {
    const many = (ip: string) => Array.from({ length: 10 }, (_, i) => f(ip, i))
    const failures = [...many('127.0.0.1'), ...many('::1'), ...many('192.0.2.10'), ...many('2001:db8::5'), ...many('203.0.113.9'), ...many('198.51.100.1')]
    const d = banDecisions(failures, { threshold: 5, windowSec: 60, now: NOW, allowlist: ['192.0.2.0/24', '2001:db8::/32'], alreadyBanned: ['198.51.100.1'] })
    expect(d.map((x) => x.ip)).toEqual(['203.0.113.9'])
  })

  it('groups equivalent spellings of one address and skips junk entries', () => {
    const failures = [f('::ffff:203.0.113.4', 1), f('203.0.113.4', 2), f('2001:DB8::9', 1), f('2001:db8:0::9', 2), f('not-an-ip', 1)]
    expect(banDecisions(failures, { threshold: 2, windowSec: 60, now: NOW }).map((x) => [x.ip, x.failures])).toEqual([
      ['2001:db8::9', 2],
      ['203.0.113.4', 2],
    ])
  })

  it('sorts by failures then address', () => {
    const failures = [f('203.0.113.2', 1), f('203.0.113.1', 1), f('203.0.113.3', 1), f('203.0.113.3', 2)]
    expect(banDecisions(failures, { threshold: 1, windowSec: 60, now: NOW }).map((x) => x.ip)).toEqual(['203.0.113.3', '203.0.113.1', '203.0.113.2'])
  })

  it('validates the policy', () => {
    for (const p of [{ threshold: 0 }, { windowSec: 0 }, { now: -1 }, { allowlist: ['nope'] }, { alreadyBanned: ['10.0.0.0/8'] }]) {
      expect(() => banDecisions([], { threshold: 3, windowSec: 60, now: NOW, ...p }), JSON.stringify(p)).toThrowError(XpanelError)
    }
  })

  it('works end to end from log lines', () => {
    const lines = Array.from({ length: 5 }, (_, i) => `Oct 22 11:59:${String(10 + i).padStart(2, '0')} h sshd[${i}]: Failed password for root from 203.0.113.77 port ${4000 + i} ssh2`)
    expect(banDecisions(parseAuthFailures(lines, { now: NOW }), { threshold: 5, windowSec: 300, now: NOW }).map((d) => d.ip)).toEqual(['203.0.113.77'])
  })
})
