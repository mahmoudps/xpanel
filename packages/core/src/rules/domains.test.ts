import { describe, expect, it } from 'vitest'
import { XpanelError } from '../errors.ts'
import type { Domain } from '../types.ts'
import {
  aliasTargets,
  assertAliasTarget,
  assertDomainUnique,
  canRenamePrimary,
  defaultDocRoot,
  normalizeHost,
  resolveServingDomain,
  serverNames,
  validateDocRoot,
  validateHome,
} from './domains.ts'

const code = (fn: () => unknown): string | null => {
  try {
    fn()
    return null
  } catch (e) {
    if (e instanceof XpanelError) return e.code
    throw e
  }
}

const account = { id: 'a1', username: 'bob', home: '/home/bob', primaryDomain: 'example.com', status: 'active' as const }

describe('defaultDocRoot', () => {
  it('maps kinds to the documented layout', () => {
    expect(defaultDocRoot(account, 'primary', 'example.com')).toBe('/home/bob/public_html')
    expect(defaultDocRoot(account, 'addon', 'Shop.example.net')).toBe('/home/bob/shop.example.net')
    expect(defaultDocRoot(account, 'subdomain', 'blog.example.com')).toBe('/home/bob/blog.example.com')
    expect(defaultDocRoot(account, 'alias', 'example.org')).toBe('/home/bob/public_html')
  })

  it('honours a configurable addon parent and alias target', () => {
    expect(defaultDocRoot(account, 'addon', 'shop.net', { addonParent: 'public_html' })).toBe('/home/bob/public_html/shop.net')
    expect(defaultDocRoot(account, 'alias', 'shop.org', { aliasOf: '/home/bob/shop.net' })).toBe('/home/bob/shop.net')
    expect(code(() => defaultDocRoot(account, 'addon', 'shop.net', { addonParent: '../alice' }))).toBe('VALIDATION')
    expect(code(() => defaultDocRoot(account, 'addon', 'shop.net', { addonParent: '/etc' }))).toBe('VALIDATION')
    expect(code(() => defaultDocRoot(account, 'alias', 'shop.org', { aliasOf: '/home/alice/public_html' }))).toBe('VALIDATION')
  })

  it('rejects hostile names and homes', () => {
    expect(code(() => defaultDocRoot(account, 'addon', '../../etc'))).toBe('VALIDATION')
    expect(code(() => defaultDocRoot(account, 'addon', 'a/b.com'))).toBe('VALIDATION')
    expect(code(() => defaultDocRoot({ username: 'bob', home: 'home/bob' }, 'primary', 'example.com'))).toBe('VALIDATION')
    expect(code(() => defaultDocRoot({ username: 'bob', home: '/home/../root' }, 'primary', 'example.com'))).toBe('VALIDATION')
    expect(code(() => defaultDocRoot({ username: 'bob', home: '/home/bob/' }, 'primary', 'example.com'))).toBe('VALIDATION')
    expect(code(() => defaultDocRoot({ username: 'bob', home: '/' }, 'primary', 'example.com'))).toBe('VALIDATION')
    expect(code(() => defaultDocRoot(account, 'weird' as 'addon', 'a.com'))).toBe('VALIDATION')
  })

  it('refuses a home that does not belong to the account', () => {
    expect(code(() => defaultDocRoot({ username: 'bob', home: '/home/alice' }, 'primary', 'example.com'))).toBe('VALIDATION')
    expect(code(() => defaultDocRoot({ username: 'bob', home: '/home/bob/alice' }, 'addon', 'shop.net'))).toBe('VALIDATION')
    expect(code(() => defaultDocRoot({ username: 'root', home: '/home/root' }, 'primary', 'example.com'))).toBe('VALIDATION')
    expect(defaultDocRoot({ username: 'bob', home: '/home2/bob' }, 'primary', 'example.com')).toBe('/home2/bob/public_html')
    expect(validateHome('/home/bob', 'bob')).toBe('/home/bob')
    expect(code(() => validateHome('/home/bobby', 'bob'))).toBe('VALIDATION')
  })
})

describe('validateDocRoot / validateHome', () => {
  it('accepts paths strictly inside home', () => {
    expect(validateDocRoot('/home/bob', 'public_html/shop')).toBe('/home/bob/public_html/shop')
    expect(validateDocRoot('/home/bob', '/home/bob/sites/a.com')).toBe('/home/bob/sites/a.com')
  })

  it.each([
    ['/home/bob', 'home itself'],
    ['/home/bob/', 'home with slash'],
    ['/home/bobby/public_html', 'sibling prefix'],
    ['/home/alice/public_html', 'other home'],
    ['public_html/../../alice', 'traversal'],
    ['public_html/./x', 'dot segment'],
    ['public_html//x', 'double slash'],
    ['.ssh', 'hidden dir'],
    ['public_html/.git', 'nested hidden dir'],
    ['mail/new', 'mail dir'],
    ['etc', 'etc dir'],
    ['tmp/x', 'tmp dir'],
    ['public_html/x y', 'space'],
    ['public_html/x;rm', 'metachar'],
    ['public_html/\nx', 'newline'],
    ['', 'empty'],
  ])('rejects %j (%s)', (docRoot) => {
    expect(code(() => validateDocRoot('/home/bob', docRoot))).toBe('VALIDATION')
  })

  it('validates homes', () => {
    expect(validateHome('/home/bob')).toBe('/home/bob')
    expect(validateHome('/srv/xpanel/home/bob')).toBe('/srv/xpanel/home/bob')
    for (const h of ['', '/', '/home', 'home/bob', '/home//bob', '/home/bob/..', '/home/b ob', 42]) {
      expect(code(() => validateHome(h))).toBe('VALIDATION')
    }
  })

  it('refuses homes inside system trees, so no docroot can reach OS files', () => {
    for (const h of ['/etc/bob', '/root/bob', '/proc/self', '/sys/kernel', '/usr/local', '/opt/xpanel', '/tmp/bob', '/boot/x', '/run/user', '/var/lib/mysql', '/var/log/nginx', '/var/spool/cron']) {
      expect(code(() => validateHome(h))).toBe('VALIDATION')
    }
    expect(code(() => defaultDocRoot({ username: 'bob', home: '/etc/bob' }, 'primary', 'example.com'))).toBe('VALIDATION')
    expect(code(() => validateDocRoot('/var/lib/mysql', 'wp'))).toBe('VALIDATION')
    for (const h of ['/var/www/bob', '/home2/bob', '/www/wwwroot/bob', '/data/home/bob']) expect(validateHome(h)).toBe(h)
  })
})

type D = Pick<Domain, 'name' | 'wildcard'> & { id: string }
const d = (id: string, name: string, wildcard = false): D => ({ id, name, wildcard })

describe('resolveServingDomain', () => {
  const domains = [d('1', 'example.com', true), d('2', 'blog.example.com'), d('3', 'shop.example.com', true), d('4', 'other.net')]

  it('prefers exact names over wildcards', () => {
    expect(resolveServingDomain('blog.example.com', domains)?.id).toBe('2')
    expect(resolveServingDomain('example.com', domains)?.id).toBe('1')
  })

  it('uses the longest wildcard parent', () => {
    expect(resolveServingDomain('x.shop.example.com', domains)?.id).toBe('3')
    expect(resolveServingDomain('anything.example.com', domains)?.id).toBe('1')
    expect(resolveServingDomain('a.b.example.com', domains)?.id).toBe('1')
    // blog is not a wildcard, so deeper names fall back to the example.com wildcard
    expect(resolveServingDomain('x.blog.example.com', domains)?.id).toBe('1')
  })

  it('serves implicit www before wildcards and can turn it off', () => {
    expect(resolveServingDomain('www.blog.example.com', domains)?.id).toBe('2')
    expect(resolveServingDomain('www.other.net', domains)?.id).toBe('4')
    expect(resolveServingDomain('www.blog.example.com', domains, { www: false })?.id).toBe('1')
    expect(resolveServingDomain('www.other.net', domains, { www: false })).toBeNull()
  })

  it('normalizes hostile Host headers', () => {
    expect(resolveServingDomain('BLOG.Example.COM.:8443', domains)?.id).toBe('2')
    expect(resolveServingDomain('notexample.com', domains)).toBeNull()
    expect(resolveServingDomain('example.com.evil.net', domains)).toBeNull()
    expect(resolveServingDomain('127.0.0.1', domains)).toBeNull()
    expect(resolveServingDomain('[::1]:80', domains)).toBeNull()
    expect(resolveServingDomain('', domains)).toBeNull()
    expect(resolveServingDomain('a..example.com', domains)).toBeNull()
    expect(resolveServingDomain(undefined, domains)).toBeNull()
    expect(normalizeHost('Example.com:80')).toBe('example.com')
    expect(normalizeHost('example.com:')).toBeNull()
  })

  it('returns null with no domains', () => {
    expect(resolveServingDomain('example.com', [])).toBeNull()
  })
})

describe('assertDomainUnique', () => {
  const all = [
    { name: 'example.com', accountId: 'a1' },
    { name: 'blog.example.com', accountId: 'a1' },
    { name: 'www.legacy.org', accountId: 'a2' },
  ]

  it('returns the canonical name when free', () => {
    expect(assertDomainUnique('New.example.net', all, 'a1')).toBe('new.example.net')
    expect(assertDomainUnique('shop.example.com', all, 'a1')).toBe('shop.example.com')
  })

  it('rejects exact and case/trailing-dot duplicates', () => {
    expect(code(() => assertDomainUnique('example.com', all))).toBe('CONFLICT')
    expect(code(() => assertDomainUnique('EXAMPLE.com.', all))).toBe('CONFLICT')
  })

  it('rejects implicit www collisions both ways', () => {
    expect(code(() => assertDomainUnique('www.example.com', all, 'a1'))).toBe('CONFLICT')
    expect(code(() => assertDomainUnique('legacy.org', all, 'a2'))).toBe('CONFLICT')
  })

  it('blocks names above or below another account’s domain', () => {
    expect(code(() => assertDomainUnique('evil.example.com', all, 'a2'))).toBe('CONFLICT')
    expect(code(() => assertDomainUnique('x.y.example.com', all, 'a2'))).toBe('CONFLICT')
    expect(code(() => assertDomainUnique('legacy.org', all, 'a3'))).toBe('CONFLICT')
    // without an account every overlap is treated as foreign: forgetting the id must not open takeovers
    expect(code(() => assertDomainUnique('evil.example.com', all))).toBe('CONFLICT')
    expect(code(() => assertDomainUnique('example.com', [{ name: 'blog.example.com', accountId: 'a2' }]))).toBe('CONFLICT')
    expect(assertDomainUnique('example.net', all)).toBe('example.net')
  })

  it('validates the name first', () => {
    expect(code(() => assertDomainUnique('bad..name', all))).toBe('VALIDATION')
  })
})

describe('aliases and server names', () => {
  const domains = [
    { id: 'p', accountId: 'a1', kind: 'primary' as const, suspended: false, name: 'example.com', parentId: null, wildcard: true },
    { id: 'ad', accountId: 'a1', kind: 'addon' as const, suspended: false, name: 'shop.net', parentId: null, wildcard: false },
    { id: 'sus', accountId: 'a1', kind: 'addon' as const, suspended: true, name: 'old.net', parentId: null, wildcard: false },
    { id: 's', accountId: 'a1', kind: 'subdomain' as const, suspended: false, name: 'blog.example.com', parentId: 'p', wildcard: false },
    { id: 'al', accountId: 'a1', kind: 'alias' as const, suspended: false, name: 'example.org', parentId: 'p', wildcard: false },
    { id: 'x', accountId: 'a2', kind: 'primary' as const, suspended: false, name: 'other.com', parentId: null, wildcard: false },
  ]

  it('aliasTargets lists the account’s active primary and addon domains', () => {
    expect(aliasTargets('a1', domains).map((x) => x.id)).toEqual(['p', 'ad'])
    expect(aliasTargets('a3', domains)).toEqual([])
  })

  it('assertAliasTarget refuses foreign, chained and suspended targets', () => {
    expect(() => assertAliasTarget('a1', domains[0]!)).not.toThrow()
    expect(code(() => assertAliasTarget('a1', domains[5]!))).toBe('FORBIDDEN')
    expect(code(() => assertAliasTarget('a1', domains[4]!))).toBe('VALIDATION')
    expect(code(() => assertAliasTarget('a1', domains[3]!))).toBe('VALIDATION')
    expect(code(() => assertAliasTarget('a1', domains[2]!))).toBe('PRECONDITION_FAILED')
  })

  const records = domains.map((x) => ({ ...x, expiresAt: null as string | null }))
  const now = new Date('2026-10-22T00:00:00Z')
  const alias = (over: Partial<(typeof records)[number]>) => ({ ...records[4]!, ...over })

  it('serverNames covers www, aliases and the wildcard', () => {
    expect(serverNames(records[0]!, records, now)).toEqual(['example.com', 'www.example.com', 'example.org', 'www.example.org', '*.example.com'])
    expect(serverNames(records[1]!, records, now)).toEqual(['shop.net', 'www.shop.net'])
  })

  it('serverNames ignores an alias of another account that claims this parent', () => {
    const foreign = alias({ id: 'f', accountId: 'a2', name: 'attacker.org' })
    expect(serverNames(records[0]!, [...records, foreign], now)).not.toContain('attacker.org')
  })

  it('serverNames leaves suspended and expired aliases to their own page', () => {
    const stopped = alias({ id: 'st', name: 'stopped.org', suspended: true })
    const expired = alias({ id: 'ex', name: 'expired.org', expiresAt: '2026-10-21T00:00:00Z' })
    const later = alias({ id: 'la', name: 'later.org', expiresAt: '2027-10-21T00:00:00Z' })
    const names = serverNames(records[0]!, [...records, stopped, expired, later], now)
    expect(names).not.toContain('stopped.org')
    expect(names).not.toContain('expired.org')
    expect(names).toContain('later.org')
  })

  it('serverNames adds the wildcard of an alias that has the flag', () => {
    const wild = alias({ id: 'w', name: 'wild.org', wildcard: true })
    expect(serverNames(records[1]!, [{ ...wild, parentId: 'ad' }], now)).toEqual(['shop.net', 'www.shop.net', 'wild.org', 'www.wild.org', '*.wild.org'])
  })

  it('serverNames refuses stored names that would inject into server_name/ServerAlias', () => {
    const evil = { id: 'e', accountId: 'a1', name: 'evil.com;\n  include /etc/shadow', wildcard: false }
    expect(code(() => serverNames(evil, [], now))).toBe('VALIDATION')
    expect(code(() => serverNames(records[0]!, [alias({ name: 'x.org root /' })], now))).toBe('VALIDATION')
  })

  it('serverNames drops an implicit www that would pass the 253 character limit', () => {
    const name = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(60)].join('.')
    expect(name.length).toBe(252)
    expect(serverNames({ id: 'l', accountId: 'a1', name, wildcard: false }, [], now)).toEqual([name])
  })
})

describe('canRenamePrimary', () => {
  const all = [
    { id: 'p', name: 'example.com', accountId: 'a1', kind: 'primary' as const },
    { id: 's1', name: 'blog.example.com', accountId: 'a1', kind: 'subdomain' as const },
    { id: 's2', name: 'a.b.example.com', accountId: 'a1', kind: 'subdomain' as const },
    { id: 'ad', name: 'shop.net', accountId: 'a1', kind: 'addon' as const },
    { id: 'x', name: 'taken.org', accountId: 'a2', kind: 'primary' as const },
    { id: 'y', name: 'blog.fresh.io', accountId: 'a2', kind: 'primary' as const },
  ]

  it('allows a free name and moves subdomains with it', () => {
    const r = canRenamePrimary(account, 'New-Name.io', all)
    expect(r.ok).toBe(true)
    expect(r.name).toBe('new-name.io')
    expect(r.subdomainRenames).toEqual([
      { id: 's1', from: 'blog.example.com', to: 'blog.new-name.io' },
      { id: 's2', from: 'a.b.example.com', to: 'a.b.new-name.io' },
    ])
  })

  it('refuses taken, identical, invalid and foreign-overlapping names', () => {
    expect(canRenamePrimary(account, 'taken.org', all).ok).toBe(false)
    expect(canRenamePrimary(account, 'shop.net', all).ok).toBe(false)
    expect(canRenamePrimary(account, 'example.com', all).reasons).toContain('new name equals the current primary domain')
    expect(canRenamePrimary(account, 'bad..name', all).ok).toBe(false)
    expect(canRenamePrimary(account, 'x.taken.org', all).ok).toBe(false)
    expect(canRenamePrimary(account, 'fresh.io', all).ok).toBe(false)
  })

  it('reports subdomains that would collide after the move', () => {
    const r = canRenamePrimary(account, 'fresh.io', all)
    expect(r.reasons.some((x) => x.startsWith('subdomain blog.example.com'))).toBe(true)
    expect(r.subdomainRenames).toEqual([])
  })

  it('refuses suspended accounts', () => {
    const r = canRenamePrimary({ ...account, status: 'suspended' }, 'new.io', all)
    expect(r.ok).toBe(false)
    expect(r.reasons).toContain('account is suspended')
  })

  it('refuses when the stored primary domain is corrupt instead of crashing', () => {
    const r = canRenamePrimary({ ...account, primaryDomain: 'bad..name' }, 'new.io', all)
    expect(r.ok).toBe(false)
    expect(r.reasons.some((x) => x.startsWith('current primary domain'))).toBe(true)
  })

  it('may rename to the www of the old name since the old name goes away', () => {
    expect(canRenamePrimary(account, 'www.example.com', all).ok).toBe(true)
  })
})
