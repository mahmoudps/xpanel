import { describe, expect, it } from 'vitest'
import { isXpanelError } from './errors.ts'
import {
  assertAbsPath,
  assertArgon2Hash,
  assertCidr,
  assertDbPrivileges,
  assertEmail,
  assertId,
  assertIdOrNull,
  assertIp,
  assertIpv4,
  assertIsoDate,
  assertLimit,
  assertLine,
  assertPhpSettings,
  assertPrincipalUsername,
  assertRedirectTarget,
  assertRelPath,
  assertResellerAcl,
  assertSemver,
  assertServiceHash,
  assertUpstream,
  isUuid,
  validateServerSettings,
} from './schemas.ts'
import type { PhpSettings, ServerSettings } from './types.ts'

const ARGON2 =
  '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'

const php = (over: Partial<PhpSettings> = {}): PhpSettings => ({
  version: '8.3',
  handler: 'fpm',
  fpm: {
    mode: 'ondemand',
    maxChildren: 8,
    startServers: 2,
    minSpareServers: 1,
    maxSpareServers: 4,
    maxRequests: 500,
    processIdleTimeoutSec: 10,
  },
  ini: {},
  ...over,
})

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

describe('identities, UUIDs and secrets', () => {
  it('validates UUIDs and nullable UUIDs', () => {
    const id = '11111111-2222-4333-8444-555555555555'
    expect(isUuid(id)).toBe(true)
    expect(assertId(id.toUpperCase())).toBe(id)
    expect(assertIdOrNull(null)).toBeNull()
    expect(rejects(() => assertId('not-a-uuid'))).toBe(true)
  })

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
      ARGON2.replace('m=65536', 'm=4096'),
      ARGON2.replace('m=65536', 'm=32768'),
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

  it('service hashes cannot break passwd-file lines and reject argon2i or weak argon2id', () => {
    expect(assertServiceHash('{SHA512-CRYPT}$6$salt$hash')).toBeTruthy()
    for (const bad of [
      '',
      'a:b',
      'a b',
      'a\nb',
      'x'.repeat(513),
      `{ARGON2I}${ARGON2.replace('argon2id', 'argon2i')}`,
      `{ARGON2ID}${ARGON2.replace('m=65536', 'm=4096')}`,
    ]) {
      expect(rejects(() => assertServiceHash(bad))).toBe(true)
    }
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

describe('free text, dates, semver, limits and urls', () => {
  it('lines refuse controls, line separators and bidi overrides', () => {
    expect(assertLine('ok text', 10)).toBe('ok text')
    for (const bad of ['a\nb', 'a\rb', 'a\0b', 'a\tb', '\x1b[31m', '\x85', `a${LS}b`, `${RLO}gpj.exe`]) {
      expect(rejects(() => assertLine(bad, 100)), JSON.stringify(bad)).toBe(true)
    }
    expect(rejects(() => assertLine('x'.repeat(11), 10))).toBe(true)
    expect(rejects(() => assertLine('', 10, 'x', { allowEmpty: false }))).toBe(true)
  })

  it('ISO dates and semver', () => {
    expect(assertIsoDate('2027-06-01T00:00:00.000Z', 'd').toISOString()).toBe('2027-06-01T00:00:00.000Z')
    expect(assertIsoDate('2027-06-01', 'd').toISOString()).toBe('2027-06-01T00:00:00.000Z')
    for (const bad of ['tomorrow', '2027-13-01', '2027-06-01 00:00', 1_700_000_000, null]) expect(rejects(() => assertIsoDate(bad, 'd')), String(bad)).toBe(true)
    expect(assertSemver('1.2.0-rc.1', 'v')).toBe('1.2.0-rc.1')
    expect(rejects(() => assertSemver('v1.2.0', 'v'))).toBe(true)
  })

  it('limits, reseller ACLs and database privileges', () => {
    expect(assertLimit('unlimited')).toBe('unlimited')
    expect(assertLimit(100, 'disk', { min: 1 })).toBe(100)
    expect(rejects(() => assertLimit(-1))).toBe(true)
    expect(rejects(() => assertLimit(0, 'disk', { min: 1 }))).toBe(true)
    expect(assertResellerAcl(['list-accounts', 'create-account', 'list-accounts'])).toEqual(['create-account', 'list-accounts'])
    expect(rejects(() => assertResellerAcl(['unknown']))).toBe(true)
    expect(assertDbPrivileges(['SELECT', 'ALL PRIVILEGES'])).toEqual(['ALL PRIVILEGES'])
    expect(rejects(() => assertDbPrivileges(['SUPER']))).toBe(true)
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

describe('php and server settings', () => {
  const caps = { phpWorkers: 8, memoryMb: 1024 } as const

  it('copies a valid PHP object through core rules', () => {
    expect(assertPhpSettings(php(), caps)).toEqual(php())
  })

  it('refuses more workers than the plan allows with LIMIT_EXCEEDED, and allows them when unlimited', () => {
    const big = php({ fpm: { ...php().fpm, maxChildren: 9 } })
    expect(codeOf(() => assertPhpSettings(big, caps))).toBe('LIMIT_EXCEEDED')
    expect(assertPhpSettings(big, { phpWorkers: 'unlimited', memoryMb: 'unlimited' }).fpm.maxChildren).toBe(9)
  })

  it('validates ServerSettings and rejects port collisions', () => {
    const base: ServerSettings = {
      hostname: 'Server.Example.NET',
      nameservers: ['ns1.example.net'],
      adminEmail: 'root@example.net',
      engine: 'apache',
      apacheMpm: 'itk',
      panelPort: 2087,
      sshPort: 22,
      nginx: { workerProcesses: 'auto', workerConnections: 1024, workerRlimitNofile: 65535, multiAccept: false, keepaliveTimeoutSec: 65 },
      apache: { startServers: 2, minSpareServers: 2, maxSpareServers: 6, maxRequestWorkers: 100, maxConnectionsPerChild: 1000, serverLimit: 100 },
      backendPort: 8080,
      backendTlsPort: 8443,
    }
    expect(validateServerSettings(base).hostname).toBe('server.example.net')
    expect(rejects(() => validateServerSettings({ ...base, panelPort: 443 }))).toBe(true)
  })
})
