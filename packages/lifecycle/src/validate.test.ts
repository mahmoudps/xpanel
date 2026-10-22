import { describe, expect, it } from 'vitest'
import { XpanelError } from '@xpanel/core'
import { assertExecSteps, stepPaths } from './steps.ts'
import { RESELLER, ROOT } from './testing/fakes.ts'
import { lifecycleTools } from './tools.ts'
import {
  assertAccountHome,
  assertAddress,
  assertDomain,
  assertHostedAddress,
  assertRoot,
  assertSafeAbsPath,
  assertSourceDbName,
  assertUsername,
  compactStamp,
  exactKeys,
  hasControlChars,
  isCompactStamp,
  isIpv4,
  isIsoDate,
  isUnder,
  isUsernameSyntax,
} from './validate.ts'

const ctl = (code: number): string => String.fromCharCode(code)

describe('naming validators delegate to the core rules and refuse non-canonical input', () => {
  it('usernames: the core reservation list applies to local names only', () => {
    expect(assertUsername('alice')).toBe('alice')
    for (const bad of ['root', 'admin', 'test1', 'Alice', 'a_b', 'a'.repeat(17), '', 7]) expect(() => assertUsername(bad), String(bad)).toThrow(XpanelError)
    expect(isUsernameSyntax('admin')).toBe(true)
    expect(isUsernameSyntax('Admin')).toBe(false)
    expect(isUsernameSyntax('a'.repeat(17))).toBe(false)
  })

  it('domains and addresses must already be canonical', () => {
    expect(assertDomain('example.com')).toBe('example.com')
    for (const bad of ['Example.com', 'example.com.', 'bücher.example', 'localhost', '1.2.3.4', 'a..b.example']) expect(() => assertDomain(bad), bad).toThrow(XpanelError)
    expect(assertHostedAddress('info@example.com')).toBe('info@example.com')
    expect(() => assertHostedAddress('Info@example.com')).toThrow(/canonical/)
    expect(() => assertHostedAddress('a+b@example.com')).toThrow(XpanelError)
    expect(assertAddress('ops+alerts@gmail.com')).toBe('ops+alerts@gmail.com')
    expect(() => assertAddress('|/bin/sh@example.com')).toThrow(XpanelError)
    expect(isIpv4('192.0.2.1')).toBe(true)
    for (const bad of ['192.0.2.01', '1.2.3', '::1', 'x']) expect(isIpv4(bad), bad).toBe(false)
  })

  it('source database names are checked for syntax and length only', () => {
    expect(assertSourceDbName('admin_wp', 'admin', 64)).toBe('admin_wp')
    for (const bad of ['admin_', 'other_wp', 'admin_WP', 'admin_w-p', `admin_${'x'.repeat(60)}`]) expect(() => assertSourceDbName(bad, 'admin', 64), bad).toThrow(XpanelError)
  })

  it('homes come from the core rule and must end with the account name', () => {
    expect(assertAccountHome('/home/alice', 'alice')).toBe('/home/alice')
    for (const bad of ['/home/bob', '/etc/alice', '/home/../alice', 'home/alice', '/alice']) expect(() => assertAccountHome(bad, 'alice'), bad).toThrow(XpanelError)
  })
})

describe('path and value helpers', () => {
  it('accepts only normalized absolute paths of conservative characters', () => {
    expect(assertSafeAbsPath('/var/lib/xpanel/x.dump')).toBe('/var/lib/xpanel/x.dump')
    for (const bad of ['/', 'rel', '/a/../b', '/a//b', '/a/', '/a b', '/a;b', `/a${ctl(0)}`, '/a/./b']) expect(() => assertSafeAbsPath(bad), JSON.stringify(bad)).toThrow(XpanelError)
    expect(isUnder('/home/a/x', '/home/a')).toBe(true)
    expect(isUnder('/home/ab', '/home/a')).toBe(false)
  })

  it('detects control, separator and bidi characters', () => {
    for (const c of [0, 10, 27, 127, 133, 0x2028, 0x202e, 0x2067, 0xfeff]) expect(hasControlChars(`a${ctl(c)}b`), c.toString(16)).toBe(true)
    expect(hasControlChars('plain text')).toBe(false)
  })

  it('keeps control characters out of error messages', () => {
    try {
      assertSafeAbsPath(`/x${ctl(10)}forged log line`)
    } catch (e) {
      expect((e as Error).message).not.toContain(ctl(10))
    }
    expect(() => exactKeys({ a: 1, [`b${ctl(10)}`]: 2 }, ['a'], 'thing')).toThrow(/unknown fields: b\?/)
  })

  it('formats and recognizes compact stamps and ISO dates', () => {
    expect(compactStamp(new Date('2026-10-22T01:35:00.123Z'))).toBe('20261022T013500Z')
    expect(isCompactStamp('20261022T013500Z')).toBe(true)
    expect(isCompactStamp('2026-10-22')).toBe(false)
    expect(isIsoDate('2026-10-22T01:35:00Z')).toBe(true)
    expect(isIsoDate('2026-13-40T01:35:00Z')).toBe(false)
  })

  it('only root may run panel-level flows', () => {
    expect(assertRoot(ROOT, 'upgrade')).toBe(ROOT)
    expect(() => assertRoot(RESELLER, 'upgrade')).toThrow(/only root may upgrade/)
    expect(() => assertRoot({ kind: 'god', id: 'x', username: 'x' }, 'upgrade')).toThrow(XpanelError)
    expect(() => assertRoot(null, 'upgrade')).toThrow(XpanelError)
  })
})

describe('lifecycle tools and step guards', () => {
  it('resolves absolute binaries for both OS families', () => {
    for (const family of ['debian', 'rhel'] as const) {
      const t = lifecycleTools({ family })
      expect(Object.values(t).every((p) => p.startsWith('/usr/bin/'))).toBe(true)
    }
    expect(() => lifecycleTools({ family: 'arch' as never })).toThrow(/unknown os family/)
  })

  it('refuses relative binaries and argv elements with NUL or line breaks', () => {
    expect(() => assertExecSteps([{ kind: 'exec', argv: ['tar', '-x'] }])).toThrow(/non-absolute/)
    expect(() => assertExecSteps([{ kind: 'exec-io', argv: ['/usr/bin/tar', `a${ctl(10)}b`] }])).toThrow(/line break/)
    expect(() => assertExecSteps([{ kind: 'exec', argv: [] }])).toThrow(XpanelError)
    expect(() => assertExecSteps([{ kind: 'remove-path' }, { kind: 'exec', argv: ['/usr/bin/tar', '--create'] }])).not.toThrow()
  })

  it('lists every path a step mentions', () => {
    expect(stepPaths({ kind: 'exec', argv: ['/usr/bin/tar', '--file=/a/b.tar', '--directory=/c', 'rel'] })).toEqual(['/usr/bin/tar', '/a/b.tar', '/c'])
    expect(stepPaths({ kind: 'exec-io', argv: ['/usr/bin/dd', 'of=/home/a/x'], stdinFrom: '/w/x', stdoutTo: { path: '/w/y', mode: 0o600 } })).toEqual(['/usr/bin/dd', '/home/a/x', '/w/x', '/w/y'])
    expect(stepPaths({ kind: 'desired-state', op: 'ensure-database', username: 'a', database: 'a_b' })).toEqual([])
  })
})
