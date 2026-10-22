import { describe, expect, it } from 'vitest'
import { apacheQuote, iniValue, nginxQuote, nginxRegexQuote, olsValue, shQuote } from './quote.ts'
import { certCovers, certForName, groupSites, siteMode, siteUpstream } from './sites.ts'
import { cgiWrapperPath, fpmSocketPath, lsphpBinary, phpCgiBinary } from './paths.ts'
import {
  assertDocRoot,
  assertDomainName,
  assertHome,
  assertRedirectUrl,
  assertUsername,
  classifyIp,
  isSafeAbsPath,
  parseCidr,
  parseUpstream,
} from './validate.ts'
import { account, cert, codeOf, debianOs, domain, rhelOs, settings } from './testkit.ts'

describe('names and paths', () => {
  it('accepts plain lowercase FQDNs and punycode', () => {
    for (const n of ['example.com', 'a.b.c.example.co.uk', 'xn--mgbh0fb.xn--ngbrx', 'a-b.example', '1.example.com']) expect(assertDomainName(n)).toBe(n)
  })

  it('rejects everything else', () => {
    for (const n of ['', 'com', 'Example.com', 'example.com.', '*.example.com', 'ex_ample.com', 'ab--cd.example', '1.2.3.4', 'a'.repeat(64) + '.com', `${'a.'.repeat(127)}com`]) {
      expect(codeOf(() => assertDomainName(n))).toBe('VALIDATION')
    }
  })

  it('validates usernames by the core rule, privileged groups included', () => {
    expect(assertUsername('alice2')).toBe('alice2')
    for (const u of ['root', 'nginx', 'Alice', '1alice', 'al_ice', 'a'.repeat(17), 'alice\n', '', 'sudo', 'wheel', 'docker', 'testsite', 'xpanelx']) {
      expect(codeOf(() => assertUsername(u))).toBe('VALIDATION')
    }
  })

  it('requires the canonical form of internationalized names', () => {
    expect(assertDomainName('xn--mnchen-3ya.de')).toBe('xn--mnchen-3ya.de')
    expect(codeOf(() => assertDomainName('münchen.de'))).toBe('VALIDATION')
    expect(codeOf(() => assertDomainName('xn--zz.de'))).toBe('VALIDATION')
  })

  it('requires homes to end with the username and stay out of system dirs', () => {
    expect(assertHome('/home/alice', 'alice')).toBe('/home/alice')
    expect(assertHome('/home2/alice', 'alice')).toBe('/home2/alice')
    for (const h of ['/alice', '/home/bob', '/etc/alice', '/var/lib/alice', '/home/alice/', '/home//alice', '/home/../alice', 'home/alice']) {
      expect(codeOf(() => assertHome(h, 'alice'))).toBe('VALIDATION')
    }
  })

  it('keeps document roots inside the home and out of private dirs', () => {
    expect(assertDocRoot('/home/alice/public_html', '/home/alice')).toBe('/home/alice/public_html')
    expect(assertDocRoot('/home/alice/sites/shop.example', '/home/alice')).toBe('/home/alice/sites/shop.example')
    for (const d of ['/home/alice', '/home/alicex/public_html', '/home/alice/.git', '/home/alice/tmp', '/home/alice/mail/x', '/home/alice/etc', '/home/alice/a/../../bob']) {
      expect(codeOf(() => assertDocRoot(d, '/home/alice'))).toBe('VALIDATION')
    }
  })

  it('accepts only conservative absolute paths', () => {
    expect(isSafeAbsPath('/var/www')).toBe(true)
    for (const p of ['/', 'var', '/a b', '/a;b', '/a/./b', '/a/../b', '/a/', '/a$b', '/a\nb', '/a"b', '/\u00e9']) expect(isSafeAbsPath(p)).toBe(false)
  })
})

describe('addresses and URLs', () => {
  it('parses IPs and CIDRs strictly', () => {
    expect(parseCidr('10.0.0.0/8')).toEqual({ family: 4, address: '10.0.0.0', prefix: 8 })
    expect(parseCidr('2001:DB8::/32')).toEqual({ family: 6, address: '2001:db8::', prefix: 32 })
    expect(parseCidr('192.0.2.1').prefix).toBe(32)
    for (const s of ['10.0.0.0/33', '10.0.0.0/-1', '10.0.0.0/8/8', '01.2.3.4', 'fe80::1%eth0', '::1/129', '10.0.0.0/ 8', 'localhost']) {
      expect(codeOf(() => parseCidr(s))).toBe('VALIDATION')
    }
  })

  it('classifies addresses for SSRF decisions', () => {
    expect(classifyIp('127.0.0.1')).toBe('loopback')
    expect(classifyIp('127.255.0.9')).toBe('loopback')
    expect(classifyIp('::1')).toBe('loopback')
    for (const ip of ['169.254.169.254', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::', '::ffff:127.0.0.1', '::ffff:a9fe:a9fe', 'fe80::1', 'ff02::1', '64:ff9b::a9fe:a9fe', '::127.0.0.1']) {
      expect(classifyIp(ip)).toBe('forbidden')
    }
    for (const ip of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', 'fd00::1', 'fc00::1']) expect(classifyIp(ip)).toBe('private')
    for (const ip of ['8.8.8.8', '172.32.0.1', '203.0.113.5', '2001:db8::1', '2606:4700::1111']) expect(classifyIp(ip)).toBe('public')
  })

  it('parses upstream URLs without credentials, queries or whitespace', () => {
    expect(parseUpstream('http://127.0.0.1:3000')).toMatchObject({ url: 'http://127.0.0.1:3000', port: 3000, addressClass: 'loopback' })
    expect(parseUpstream('https://origin.example.org')).toMatchObject({ port: 443, hostKind: 'name', addressClass: 'name' })
    expect(parseUpstream('http://localhost:5000')).toMatchObject({ hostKind: 'ip', addressClass: 'loopback' })
    for (const u of ['ftp://x.example', 'http://a@b.example', 'http://x.example/?q', 'http://x.example/#f', 'http://x.example /', 'http://::1:80', 'http://[1.2.3.4]:80', 'http://x.example:0', 'http://x.example:99999', 'http://x.example/../a', 'http://x_y.example']) {
      expect(codeOf(() => parseUpstream(u))).toBe('VALIDATION')
    }
  })

  it('accepts redirect URLs and refuses breakouts', () => {
    expect(assertRedirectUrl('https://new.example/a/b?x=1&y=%20#top')).toBeTruthy()
    expect(assertRedirectUrl('http://[2001:db8::1]:8080/')).toBeTruthy()
    for (const u of ['https://new.example/"', 'https://new.example/\\x', 'https://new.example/$1', 'https://new.example/ x', 'data:text/html,x', 'https://', 'https://-bad-.example/']) {
      expect(codeOf(() => assertRedirectUrl(u))).toBe('VALIDATION')
    }
  })
})

describe('quoting', () => {
  it('escapes for nginx and refuses variables', () => {
    expect(nginxQuote('a"b\\c')).toBe('"a\\"b\\\\c"')
    expect(codeOf(() => nginxQuote('$host'))).toBe('VALIDATION')
    expect(codeOf(() => nginxQuote('a\nb'))).toBe('VALIDATION')
    expect(nginxRegexQuote('\\.php$')).toBe('"\\\\.php$"')
  })

  it('refuses Apache breakouts and parse-time expansion', () => {
    expect(apacheQuote('/var/www')).toBe('"/var/www"')
    for (const s of ['a"b', 'a\\b', '${X}', 'a\nb']) expect(codeOf(() => apacheQuote(s))).toBe('VALIDATION')
  })

  it('single-quotes shell words', () => {
    expect(shQuote("it's")).toBe(`'it'\\''s'`)
    expect(codeOf(() => shQuote('a\nb'))).toBe('VALIDATION')
  })

  it('renders INI values bare, as expressions or quoted', () => {
    expect(iniValue('256M')).toBe('256M')
    expect(iniValue('/home/a:/home/a/tmp')).toBe('/home/a:/home/a/tmp')
    expect(iniValue('E_ALL & ~E_DEPRECATED')).toBe('E_ALL & ~E_DEPRECATED')
    expect(iniValue('Europe/Berlin')).toBe('Europe/Berlin')
    expect(iniValue('hello world')).toBe('"hello world"')
    expect(iniValue('')).toBe('""')
    for (const v of ['a"b', 'a\\b', '${PATH}', 'a\nb', '\u00e9']) expect(codeOf(() => iniValue(v))).toBe('VALIDATION')
  })

  it('refuses braces in OLS values', () => {
    expect(codeOf(() => olsValue('a}'))).toBe('VALIDATION')
  })
})

describe('sites', () => {
  const a = account()

  it('groups aliases with the primary when they have no parent id', () => {
    const g = groupSites(a, [domain(), domain({ id: 'd2', name: 'park.example', kind: 'alias' })])
    expect(g).toHaveLength(1)
    expect(g[0]?.names).toEqual(['example.com', 'www.example.com', 'park.example', 'www.park.example'])
  })

  it('gives redirecting or suspended aliases their own site', () => {
    const g = groupSites(a, [
      domain(),
      domain({ id: 'd2', name: 'r.example', kind: 'alias', parentId: 'd1', redirect: { to: 'https://example.com/', code: 301 } }),
      domain({ id: 'd3', name: 's.example', kind: 'alias', parentId: 'd1', suspended: true }),
    ])
    expect(g.map((x) => x.main.name)).toEqual(['example.com', 'r.example', 's.example'])
  })

  it('refuses alias chains and duplicate wildcards', () => {
    expect(
      codeOf(() =>
        groupSites(a, [domain(), domain({ id: 'd2', name: 'p.example', kind: 'alias', parentId: 'd1' }), domain({ id: 'd3', name: 'q.example', kind: 'alias', parentId: 'd2' })]),
      ),
    ).toBe('VALIDATION')
    expect(codeOf(() => groupSites(a, [domain({ wildcard: true }), domain({ id: 'd2', name: 'example.com', kind: 'alias', parentId: 'd1' })]))).toBe('VALIDATION')
  })

  it('derives the mode', () => {
    expect(siteMode(a, domain())).toBe('backend')
    expect(siteMode(a, domain({ siteType: 'static' }))).toBe('backend')
    expect(siteMode(a, domain({ siteType: 'python', upstream: 'http://127.0.0.1:8000' }))).toBe('upstream')
    expect(siteMode(a, domain({ redirect: { to: 'https://x.example/', code: 301 } }))).toBe('redirect')
    expect(siteMode(account({ status: 'suspended' }), domain({ redirect: { to: 'https://x.example/', code: 301 } }))).toBe('suspended')
    // an unparsable expiry fails closed, and expiry is evaluated even without an explicit time
    expect(siteMode(a, domain({ expiresAt: 'soon' }), '2026-10-22T00:00:00Z')).toBe('suspended')
    expect(siteMode(a, domain({ expiresAt: '2020-01-01T00:00:00Z' }))).toBe('suspended')
    expect(siteMode(a, domain({ expiresAt: '2026-10-22T00:00:00Z' }), new Date('2026-10-21T23:59:59Z'))).toBe('backend')
    expect(codeOf(() => siteMode(a, domain(), 'yesterday'))).toBe('VALIDATION')
  })

  it('matches certificates one label deep only', () => {
    const c = cert()
    expect(certCovers(c, 'example.com')).toBe(true)
    expect(certCovers(c, 'blog.example.com')).toBe(true)
    expect(certCovers(c, 'a.blog.example.com')).toBe(false)
    expect(certCovers(c, 'badexample.com')).toBe(false)
    const other = domain({ name: 'other.example' })
    expect(certForName('other.example', other, other, [c])).toBeNull()
  })

  it('accepts a loopback app upstream on an unprivileged, unreserved port', () => {
    expect(siteUpstream(domain({ siteType: 'node', upstream: 'http://127.0.0.1:3000' }), settings()).port).toBe(3000)
    expect(codeOf(() => siteUpstream(domain({ siteType: 'node', upstream: 'http://127.0.0.1:8443' }), settings()))).toBe('VALIDATION')
  })
})

describe('xPanel paths', () => {
  it('builds per-instance socket and wrapper paths from validated names', () => {
    expect(fpmSocketPath('alice', '8.3')).toBe('/run/xpanel/fpm/alice-8.3/php-fpm.sock')
    expect(cgiWrapperPath('alice', '8.3', 'cgi', debianOs)).toBe('/var/www/xpanel-cgi/alice/php8.3.cgi')
    expect(codeOf(() => fpmSocketPath('../root', '8.3'))).toBe('VALIDATION')
    expect(codeOf(() => cgiWrapperPath('alice', '8.3', 'cgi', { ...debianOs, paths: { ...debianOs.paths, suexecDocroot: '/var/www/../..' } }))).toBe('VALIDATION')
  })

  it('derives php-cgi and lsphp binaries for both families', () => {
    expect(phpCgiBinary(debianOs, '8.3')).toBe('/usr/bin/php-cgi8.3')
    expect(phpCgiBinary(rhelOs, '8.1')).toBe('/opt/remi/php81/root/usr/bin/php-cgi')
    expect(lsphpBinary(debianOs, '8.3')).toBe('/usr/local/lsws/lsphp83/bin/lsphp')
    expect(codeOf(() => phpCgiBinary({ ...debianOs, phpBinary: () => '/usr/bin/perl' }, '8.3'))).toBe('VALIDATION')
  })
})
