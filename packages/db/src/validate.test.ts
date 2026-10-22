import { describe, expect, it } from 'vitest'
import { isXpanelError } from '@xpanel/core'
import {
  assertAbsPath,
  assertArgon2Hash,
  assertCidr,
  assertEmail,
  assertIp,
  assertIpv4,
  assertIsoDate,
  assertLine,
  assertPhpSettings,
  assertPrincipalUsername,
  assertRedirectTarget,
  assertRelPath,
  assertServiceHash,
  assertUpstream,
} from './validate.ts'
import { ARGON2, php } from './testing.ts'

const codeOf = (fn: () => unknown): string => {
  try {
    fn()
    return 'ok'
  } catch (e) {
    return isXpanelError(e) ? e.code : 'raw'
  }
}

const rejects = (fn: () => unknown): boolean => codeOf(fn) === 'VALIDATION'

const LS = String.fromCharCode(0x2028)
const RLO = String.fromCharCode(0x202e)

describe('paths', () => {
  it('accepts clean absolute and relative paths', () => {
    expect(assertAbsPath('/home/alice/public_html')).toBe('/home/alice/public_html')
    expect(assertRelPath('')).toBe('')
    expect(assertRelPath('public_html/a.b@c+d-e')).toBe('public_html/a.b@c+d-e')
  })

  it.each(['/', 'home/a', '/home//a', '/home/a/', '/home/../etc', '/home/./a', '/home/a b', '/home/a;b', '/home/$(id)', '/home/a\0', "/home/a'b", '/home/a\\b', '/home/.ssh'])(
    'rejects absolute %j',
    (v) => {
      expect(rejects(() => assertAbsPath(v))).toBe(true)
    },
  )

  it.each(['/abs', '..', 'a/../b', './a', 'a//b', 'a/', 'a b', '..\\x', '.ssh', 'public_html/.git', '.'])('rejects relative %j', (v) => {
    expect(rejects(() => assertRelPath(v))).toBe(true)
  })
})

describe('identities and secrets', () => {
  it('root logins: lowercase, bounded', () => {
    expect(assertPrincipalUsername('root')).toBe('root')
    for (const bad of ['Root', '1root', 'r'.repeat(33), 'a b', '', 7]) expect(rejects(() => assertPrincipalUsername(bad))).toBe(true)
  })

  it('takes only argon2id PHC hashes, without echoing the value', () => {
    expect(assertArgon2Hash(ARGON2)).toBe(ARGON2)
    for (const bad of [
      'hunter2',
      '$2b$12$abcdefghijklmnopqrstuv',
      `${ARGON2}\n`,
      ARGON2.replace('argon2id', 'argon2i'),
      ARGON2.replace('v=19', 'v=16'),
      ARGON2.replace('m=65536', 'm=0'),
      '$argon2id$v=19$m=1,t=1,p=1$a$b c',
    ]) {
      try {
        assertArgon2Hash(bad)
        expect.unreachable()
      } catch (e) {
        expect(isXpanelError(e) && e.detail.value).toBe('<redacted>')
        expect((e as Error).message).not.toContain(bad)
      }
    }
  })

  it('service hashes cannot break passwd-file lines', () => {
    expect(assertServiceHash('{SHA512-CRYPT}$6$salt$hash')).toBeTruthy()
    for (const bad of ['', 'a:b', 'a b', 'a\nb', 'x'.repeat(513)]) expect(rejects(() => assertServiceHash(bad))).toBe(true)
  })

  it('emails: the domain part is canonicalised by core', () => {
    expect(assertEmail('First.Last+tag@Example.org')).toBe('First.Last+tag@example.org')
    for (const bad of ['a', '@x.com', 'a@b', 'a@@b.com', '.a@b.com', 'a..b@b.com', 'a b@c.com', 'a@b.com\r\nBcc: x@y.z', '"q"@b.com', 'a@localhost']) {
      expect(rejects(() => assertEmail(bad)), bad).toBe(true)
    }
  })
})

describe('addresses', () => {
  it.each(['192.0.2.1', '0.0.0.0', '255.255.255.255'])('ipv4 %s', (v) => {
    expect(assertIpv4(v)).toBe(v)
  })

  it.each(['256.1.1.1', '01.2.3.4', '1.2.3', '1.2.3.4.5', ' 1.2.3.4', '1.2.3.4/32', '::1', '::ffff:1.2.3.4'])('rejects ipv4 %j', (v) => {
    expect(rejects(() => assertIpv4(v))).toBe(true)
  })

  it('single addresses come back canonical', () => {
    expect(assertIp('2001:DB8:0:0:0:0:0:1')).toBe('2001:db8::1')
    expect(assertIp('192.0.2.1')).toBe('192.0.2.1')
    for (const bad of ['10.0.0.0/8', 'example.com', 'fe80::1%eth0', '1.2.3.4;']) expect(rejects(() => assertIp(bad)), bad).toBe(true)
  })

  it('networks need zero host bits', () => {
    for (const [inp, out] of [['10.0.0.0/8', '10.0.0.0/8'], ['2001:db8::/32', '2001:db8::/32'], ['192.0.2.1/32', '192.0.2.1'], ['0.0.0.0/0', '0.0.0.0/0']]) {
      expect(assertCidr(inp)).toBe(out)
    }
    for (const bad of ['10.0.0.1/8', '10.0.0.0/33', '::/129', '10.0.0.0/08', '10.0.0.0/', '1.2.3.4/8/8']) expect(rejects(() => assertCidr(bad)), bad).toBe(true)
  })
})

describe('free text, dates and urls', () => {
  it('lines refuse controls, line separators and bidi overrides', () => {
    expect(assertLine('ok text', 10)).toBe('ok text')
    for (const bad of ['a\nb', 'a\rb', 'a\0b', 'a\tb', '\x1b[31m', '\x85', `a${LS}b`, `${RLO}gpj.exe`]) {
      expect(rejects(() => assertLine(bad, 100)), JSON.stringify(bad)).toBe(true)
    }
    expect(rejects(() => assertLine('x'.repeat(11), 10))).toBe(true)
    expect(rejects(() => assertLine('', 10, 'x', { allowEmpty: false }))).toBe(true)
  })

  it('ISO dates', () => {
    expect(assertIsoDate('2027-06-01T00:00:00.000Z', 'd').toISOString()).toBe('2027-06-01T00:00:00.000Z')
    expect(assertIsoDate('2027-06-01', 'd').toISOString()).toBe('2027-06-01T00:00:00.000Z')
    for (const bad of ['tomorrow', '2027-13-01', '2027-06-01 00:00', 1_700_000_000, null]) expect(rejects(() => assertIsoDate(bad, 'd')), String(bad)).toBe(true)
  })

  it('upstreams: http(s) URLs without config syntax', () => {
    expect(assertUpstream('http://127.0.0.1:3000')).toEqual({ url: 'http://127.0.0.1:3000', loopbackPort: 3000 })
    expect(assertUpstream('https://[::1]:8443/app')).toEqual({ url: 'https://[::1]:8443/app', loopbackPort: 8443 })
    expect(assertUpstream('http://localhost/x')).toEqual({ url: 'http://localhost/x', loopbackPort: 80 })
    expect(assertUpstream('http://backend.example.net/path_x')).toEqual({ url: 'http://backend.example.net/path_x', loopbackPort: null })
    for (const bad of ['ftp://x', 'http://x:0', 'http://x:65536', 'http://x y', 'http://x;', 'http://x/$host', 'http://x/{a}', 'unix:/run/a.sock', 'http://u:p@x/']) {
      expect(rejects(() => assertUpstream(bad)), bad).toBe(true)
    }
  })

  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://[fd00:ec2::254]/',
    'http://[fe80::1]:80/',
    'http://0.0.0.0:3000',
    'http://224.0.0.1/',
    'http://999.1.1.1/',
  ])('refuses the metadata/link-local/unspecified upstream %s', (v) => {
    expect(rejects(() => assertUpstream(v))).toBe(true)
  })

  it('redirect targets', () => {
    expect(assertRedirectTarget('https://example.com/a?b=1&c=%20')).toBeTruthy()
    for (const bad of ['/relative', 'javascript:alert(1)', 'https://', 'https://x/"', "https://x/'", 'https://x/a b', 'https://x/;', 'https://x/\\', 'https://x/{}']) {
      expect(rejects(() => assertRedirectTarget(bad)), bad).toBe(true)
    }
  })
})

describe('php settings', () => {
  const caps = { phpWorkers: 8, memoryMb: 1024 } as const

  it('copies a valid object through core rules', () => {
    expect(assertPhpSettings(php(), caps)).toEqual(php())
  })

  it.each([
    ['unknown field', { ...php(), extra: 'x' }],
    ['version', php({ version: '8' })],
    ['version path', php({ version: '../8.3' })],
    ['handler', php({ handler: 'mod_php' as never })],
    ['mode', php({ fpm: { ...php().fpm, mode: 'adaptive' as never } })],
    ['maxChildren 0', php({ fpm: { ...php().fpm, maxChildren: 0 } })],
    ['maxChildren float', php({ fpm: { ...php().fpm, maxChildren: 1.5 } })],
    ['ondemand without idle timeout', php({ fpm: { ...php().fpm, processIdleTimeoutSec: 0 } })],
    ['dynamic spare order', php({ fpm: { ...php().fpm, mode: 'dynamic', minSpareServers: 4, maxSpareServers: 2, startServers: 3 } })],
    ['dynamic start outside spares', php({ fpm: { ...php().fpm, mode: 'dynamic', minSpareServers: 1, maxSpareServers: 2, startServers: 5 } })],
    ['ini key', php({ ini: { 'Memory-Limit': '1' } })],
    ['ini newline', php({ ini: { memory_limit: '1\nauto_prepend_file=/etc/passwd' } })],
    ['ini quote', php({ ini: { memory_limit: '1"' } })],
    ['ini not object', php({ ini: [] as never })],
    ['ini server-owned extension', php({ ini: { extension: 'evil.so' } })],
    ['ini server-owned open_basedir', php({ ini: { open_basedir: '/' } })],
    ['ini server-owned disable_functions', php({ ini: { disable_functions: '' } })],
    ['ini unknown directive', php({ ini: { 'opcache.enable': '1' } })],
    ['memory above the plan', php({ ini: { memory_limit: '2G' } })],
  ])('rejects %s', (_w, v) => {
    expect(rejects(() => assertPhpSettings(v, caps))).toBe(true)
  })

  it('refuses more workers than the plan allows with LIMIT_EXCEEDED, and allows them when unlimited', () => {
    const big = php({ fpm: { ...php().fpm, maxChildren: 9 } })
    expect(codeOf(() => assertPhpSettings(big, caps))).toBe('LIMIT_EXCEEDED')
    expect(assertPhpSettings(big, { phpWorkers: 'unlimited', memoryMb: 'unlimited' }).fpm.maxChildren).toBe(9)
  })

  it('accepts a consistent dynamic pool', () => {
    const dyn = php({ fpm: { ...php().fpm, mode: 'dynamic', maxChildren: 8, minSpareServers: 2, maxSpareServers: 4, startServers: 3 } })
    expect(assertPhpSettings(dyn, caps).fpm.mode).toBe('dynamic')
  })
})
