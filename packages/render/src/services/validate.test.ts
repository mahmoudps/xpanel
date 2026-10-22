import { describe, expect, it } from 'vitest'
import { MAX_ACCOUNT_UID, isXpanelError } from '@xpanel/core'
import {
  assertAbsPath,
  assertAccountId,
  assertDate,
  assertHome,
  assertUsername,
  canonicalIpv4,
  canonicalIpv6,
  normalizeDnsName,
  normalizeEmail,
  normalizeHostedEmail,
  normalizeHostname,
} from './validate.ts'

const rejects = (fn: () => unknown, pattern?: RegExp): void => {
  let err: unknown
  try {
    fn()
  } catch (e) {
    err = e
  }
  expect(isXpanelError(err) && err.code === 'VALIDATION', `expected VALIDATION, got ${String(err)}`).toBe(true)
  if (pattern && isXpanelError(err)) expect(err.message).toMatch(pattern)
}

describe('hostnames', () => {
  it('lowercases and strips one trailing dot', () => {
    expect(normalizeHostname('WWW.Example.COM.')).toBe('www.example.com')
    expect(normalizeHostname('xn--mnchen-3ya.de')).toBe('xn--mnchen-3ya.de')
  })
  it('stores IDN names in their canonical punycode form (core rule)', () => {
    expect(normalizeHostname('münchen.de')).toBe('xn--mnchen-3ya.de')
    // the Kelvin sign is folded by IDNA mapping, so the output is plain ASCII and canonical
    expect(normalizeHostname('Key.com')).toBe('key.com')
  })
  it('rejects everything that is not a hosted FQDN and labels the error with the field', () => {
    for (const bad of ['example', '.example.com', 'example..com', 'example.com..', '-a.com', 'a-.com', 'a_b.com', 'a.123', 'ab--cd.com', 'a b.com', 'a.com/x', 'a.com\n', `${'a'.repeat(64)}.com`, `${'a.'.repeat(127)}com`, '*.example.com', '192.0.2.1']) {
      rejects(() => normalizeHostname(bad))
    }
    rejects(() => normalizeHostname(42))
    rejects(() => normalizeHostname('exa mple.com', 'mail domain'), /^invalid mail domain: /)
  })
  it('allows underscore labels only in DNS names, and only in front of a valid domain', () => {
    expect(normalizeDnsName('_dmarc.Example.com.')).toBe('_dmarc.example.com')
    expect(normalizeDnsName('sel._domainkey.example.com')).toBe('sel._domainkey.example.com')
    expect(normalizeDnsName('host_name.example.com')).toBe('host_name.example.com')
    expect(normalizeDnsName('www.example.com')).toBe('www.example.com')
    rejects(() => normalizeHostname('_dmarc.example.com'))
    for (const bad of ['_dmarc.com', 'a.b_c', '_x..example.com', '-_x.example.com', '_x.example.com/evil', '_x.exa mple.com', '_é.example.com', `_${'a'.repeat(63)}.example.com`]) {
      rejects(() => normalizeDnsName(bad))
    }
  })
})

describe('email', () => {
  it('normalizes hosted and remote addresses', () => {
    expect(normalizeHostedEmail('Info@Example.com').address).toBe('info@example.com')
    expect(normalizeEmail('First.Last+tag@Example.net').address).toBe('first.last+tag@example.net')
  })
  it('keeps hosted local parts strict (core rule)', () => {
    for (const bad of ['a+b@example.com', '.a@example.com', 'a.@example.com', 'a..b@example.com', 'a b@example.com', '"a"@example.com', 'a:b@example.com', '@example.com', 'a@', 'a@b', 'a@b@example.com', `${'a'.repeat(65)}@example.com`, 'Key@example.com']) {
      rejects(() => normalizeHostedEmail(bad))
    }
  })
  it('refuses quoting, pipes and separators in remote addresses', () => {
    for (const bad of ['"x y"@example.com', 'a|b@example.com', "a'b@example.com", 'a`b@example.com', 'a$b@example.com', 'a,b@example.com', 'a\n@example.com', 'a..b@example.com', 'a@exa_mple.com']) {
      rejects(() => normalizeEmail(bad))
    }
  })
})

describe('IP addresses (core parser)', () => {
  it('prints canonical IPv4 and RFC 5952 IPv6', () => {
    expect(canonicalIpv4('192.0.2.1')).toBe('192.0.2.1')
    expect(canonicalIpv6('2001:db8:0:0:1:0:0:1')).toBe('2001:db8::1:0:0:1')
    expect(canonicalIpv6('2001:DB8::')).toBe('2001:db8::')
    expect(canonicalIpv6('::1')).toBe('::1')
    expect(canonicalIpv6('2001:db8:0:1:1:1:1:1')).toBe('2001:db8:0:1:1:1:1:1')
    expect(canonicalIpv6('64:ff9b::192.0.2.33')).toBe('64:ff9b::c000:221')
  })
  it('rejects malformed input, octal-looking octets and mapped addresses', () => {
    for (const bad of ['192.0.2', '192.0.2.1.5', '192.0.2.256', '01.2.3.4', ' 192.0.2.1', '::ffff:192.0.2.1', '1.2.3.4/32']) rejects(() => canonicalIpv4(bad))
    for (const bad of [':', ':::', ':1', '1:', '1:2:3:4:5:6:7', '1::2:3:4:5:6:7:8', '::1.2.3', '1.2.3.4', '::%1', '::1/64', '::ffff:192.0.2.1']) rejects(() => canonicalIpv6(bad))
  })
})

describe('accounts, paths and dates', () => {
  it('validates usernames with core rules, including reserved names', () => {
    expect(assertUsername('alice2')).toBe('alice2')
    for (const bad of ['Alice', '2alice', 'al_ice', 'al-ice', '', 'a'.repeat(17), 'root', 'admin', 'test1', 'xpanelbot']) rejects(() => assertUsername(bad), /username/)
  })
  it('keeps uids and gids inside core account range', () => {
    expect(assertAccountId('uid', 1000)).toBe(1000)
    expect(assertAccountId('gid', MAX_ACCOUNT_UID)).toBe(MAX_ACCOUNT_UID)
    for (const bad of [0, 999, MAX_ACCOUNT_UID + 1, 65534, 4294967295, 1.5, '1001']) rejects(() => assertAccountId('uid', bad))
  })
  it('validates homes with core rules: normalized and outside system trees', () => {
    expect(assertHome('/home/alice')).toBe('/home/alice')
    for (const bad of ['/', '/home', 'home/alice', '/home/alice/', '/home/../etc', '/home/./alice', '/home//alice', '/home/al ice', '/home/al:ice', '/etc/alice', '/var/lib/mysql', '/root/x']) {
      rejects(() => assertHome(bad), /home directory/)
    }
  })
  it('validates absolute config paths', () => {
    expect(assertAbsPath('p', '/etc/postfix')).toBe('/etc/postfix')
    for (const bad of ['/', 'etc', '/etc/', '/etc/../shadow', '/etc/\npostfix', '/etc/post fix']) rejects(() => assertAbsPath('p', bad))
  })
  it('accepts only real dates', () => {
    const d = new Date('2026-10-22T00:00:00Z')
    expect(assertDate('now', d)).toBe(d)
    for (const bad of [new Date('nope'), '2026-10-22', 1761091200000, null]) rejects(() => assertDate('now', bad), /now/)
  })
})
