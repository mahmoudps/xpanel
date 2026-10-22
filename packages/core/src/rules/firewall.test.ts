import { describe, expect, it } from 'vitest'
import { XpanelError } from '../errors.ts'
import type { FirewallRule } from '../types.ts'
import {
  assertNoSelfLockout,
  cidrContains,
  defaultFirewallRules,
  evaluateFirewall,
  formatCidr,
  parseCidr,
  parseForwardTarget,
  parseIp,
  parsePortSpec,
  validateFirewallRule,
  validateFirewallRuleSet,
  validateFirewallRules,
  validatePrefixList,
} from './firewall.ts'

const code = (fn: () => unknown): string | null => {
  try {
    fn()
    return null
  } catch (e) {
    if (e instanceof XpanelError) return e.code
    throw e
  }
}

const settings = { panelPort: 2087, sshPort: 22, backendPort: 8080, backendTlsPort: 8443 }

const r = (id: string, over: Partial<FirewallRule> = {}): FirewallRule => ({
  id,
  kind: 'port',
  action: 'accept',
  protocol: 'tcp',
  port: null,
  source: null,
  forwardTo: null,
  list: null,
  comment: '',
  enabled: true,
  ...over,
})

const ctx = (sessionIp: string, extra: Partial<Parameters<typeof assertNoSelfLockout>[1]> = {}) => ({
  sessionIp,
  panelPort: 2087,
  sshPort: 22,
  ...extra,
})

describe('address parsing', () => {
  it('parses IPv4 strictly', () => {
    expect(parseIp('192.168.1.10')).toEqual({ version: 4, value: 0xc0a8010an })
    for (const bad of ['256.1.1.1', '1.2.3', '1.2.3.4.5', '01.2.3.4', '1.2.3.04', ' 1.2.3.4', '1.2.3.4 ', '0x7f.0.0.1', '', 'a.b.c.d']) {
      expect(parseIp(bad)).toBeNull()
    }
  })

  it('parses IPv6 including compression and embedded IPv4', () => {
    expect(parseIp('::1')).toEqual({ version: 6, value: 1n })
    expect(parseIp('::')).toEqual({ version: 6, value: 0n })
    expect(parseIp('2001:db8::1')?.value).toBe(0x20010db8000000000000000000000001n)
    expect(parseIp('2001:DB8:0:0:0:0:0:1')?.value).toBe(0x20010db8000000000000000000000001n)
    expect(parseIp('64:ff9b::192.0.2.33')?.value).toBe(0x0064ff9b0000000000000000c0000221n)
    for (const bad of ['1::2::3', ':::', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7', 'fe80::1%eth0', '12345::', '::1.2.3', 'g::1', '1:2:3:4:5:6:7:8::', ':1::2']) {
      expect(parseIp(bad)).toBeNull()
    }
  })

  it('folds IPv4-mapped IPv6 to IPv4', () => {
    expect(parseIp('::ffff:203.0.113.5')).toEqual(parseIp('203.0.113.5'))
    expect(parseIp('::ffff:cb00:7105')).toEqual(parseIp('203.0.113.5'))
  })

  it('parses CIDRs and refuses host bits', () => {
    expect(formatCidr(parseCidr('10.0.0.0/8')!)).toBe('10.0.0.0/8')
    expect(formatCidr(parseCidr('2001:0db8:0000::/32')!)).toBe('2001:db8::/32')
    expect(formatCidr(parseCidr('203.0.113.5')!)).toBe('203.0.113.5')
    expect(formatCidr(parseCidr('0.0.0.0/0')!)).toBe('0.0.0.0/0')
    expect(formatCidr(parseCidr('::/0')!)).toBe('::/0')
    expect(formatCidr(parseCidr('2001:db8:0:1:0:0:0:1')!)).toBe('2001:db8:0:1::1')
    for (const bad of ['10.0.0.1/8', '10.0.0.0/33', '10.0.0.0/-1', '10.0.0.0/08', '::1/129', '10.0.0.0/', '/8', '::ffff:10.0.0.0/104']) {
      expect(parseCidr(bad)).toBeNull()
    }
  })

  it('matches containment per family', () => {
    const net = parseCidr('198.51.100.0/24')!
    expect(cidrContains(net, parseIp('198.51.100.77')!)).toBe(true)
    expect(cidrContains(net, parseIp('198.51.101.1')!)).toBe(false)
    expect(cidrContains(parseCidr('0.0.0.0/0')!, parseIp('8.8.8.8')!)).toBe(true)
    expect(cidrContains(parseCidr('::/0')!, parseIp('8.8.8.8')!)).toBe(false)
    expect(cidrContains(parseCidr('2001:db8::/32')!, parseIp('2001:db8:ffff::1')!)).toBe(true)
  })

  it('parses ports and ranges', () => {
    expect(parsePortSpec('80')).toEqual({ from: 80, to: 80 })
    expect(parsePortSpec('8000-8100')).toEqual({ from: 8000, to: 8100 })
    expect(parsePortSpec('65535')).toEqual({ from: 65535, to: 65535 })
    for (const bad of ['0', '65536', '080', '100-90', '80-80', '1-2-3', '80,443', ' 80', '-80', '80-', 'http']) expect(parsePortSpec(bad)).toBeNull()
    expect(parsePortSpec('79-80')).toEqual({ from: 79, to: 80 })
  })

  it('refuses link-local (cloud metadata), "this network" and reserved forward targets', () => {
    for (const bad of ['169.254.169.254:80', '169.254.0.1:22', '[fe80::1]:80', '[febf::1]:80', '0.1.2.3:80', '240.0.0.1:80', '[::ffff:10.0.0.5]:80']) {
      expect(parseForwardTarget(bad)).toBeNull()
    }
    expect(parseForwardTarget('169.253.255.255:80')).not.toBeNull()
    expect(parseForwardTarget('[fec0::1]:80')).not.toBeNull()
  })

  it('parses forward targets and refuses loopback/unspecified/multicast', () => {
    expect(parseForwardTarget('10.0.0.5:8080')?.port).toBe(8080)
    expect(parseForwardTarget('[2001:db8::5]:443')?.ip.version).toBe(6)
    for (const bad of ['127.0.0.1:8080', '[::1]:80', '0.0.0.0:80', '224.0.0.1:80', '255.255.255.255:80', '[ff02::1]:80', '10.0.0.5', '10.0.0.5:0', '10.0.0.5:70000', 'example.com:80', '2001:db8::5:443', '[10.0.0.5]:80']) {
      expect(parseForwardTarget(bad)).toBeNull()
    }
  })
})

describe('validateFirewallRule', () => {
  it('accepts each kind and canonicalizes the source', () => {
    expect(validateFirewallRule(r('a', { port: '25', action: 'drop' })).port).toBe('25')
    expect(validateFirewallRule(r('b', { kind: 'ip', protocol: null, source: '2001:DB8::/32', action: 'drop' })).source).toBe('2001:db8::/32')
    expect(() => validateFirewallRule(r('c', { kind: 'forward', port: '2222', forwardTo: '10.0.0.5:22' }))).not.toThrow()
    expect(() => validateFirewallRule(r('d', { kind: 'icmp', protocol: null, action: 'drop' }))).not.toThrow()
    expect(() => validateFirewallRule(r('e', { kind: 'prefix-list', protocol: null, list: 'blocklist', action: 'drop' }))).not.toThrow()
    expect(() => validateFirewallRule(r('f', { kind: 'ip', protocol: 'udp', port: '53', source: '10.0.0.0/8' }))).not.toThrow()
  })

  it.each<[string, Partial<FirewallRule>]>([
    ['port rule without port', {}],
    ['bad port', { port: '70000' }],
    ['port without protocol', { port: '80', protocol: null }],
    ['bad protocol', { port: '80', protocol: 'sctp' as 'tcp' }],
    ['bad action', { port: '80', action: 'allow' as 'accept' }],
    ['bad kind', { kind: 'nat' as 'port', port: '80' }],
    ['host bits', { port: '80', source: '10.0.0.1/8' }],
    ['ip rule without source', { kind: 'ip', protocol: null }],
    ['forward without target', { kind: 'forward', port: '80' }],
    ['forward to loopback backend', { kind: 'forward', port: '8081', forwardTo: '127.0.0.1:8080' }],
    ['forward that drops', { kind: 'forward', port: '80', forwardTo: '10.0.0.5:80', action: 'drop' }],
    ['icmp with port', { kind: 'icmp', protocol: null, port: '80' }],
    ['icmp with protocol', { kind: 'icmp' }],
    ['prefix-list without name', { kind: 'prefix-list', protocol: null }],
    ['prefix-list bad name', { kind: 'prefix-list', protocol: null, list: 'bad name;flush ruleset' }],
    ['prefix-list with source', { kind: 'prefix-list', protocol: null, list: 'x', source: '1.2.3.4' }],
    ['list on port rule', { port: '80', list: 'x' }],
    ['comment with quote', { port: '80', comment: 'x" ; flush ruleset ; "' }],
    ['comment with newline', { port: '80', comment: 'x\nflush ruleset' }],
    ['comment too long', { port: '80', comment: 'x'.repeat(129) }],
    ['enabled not boolean', { port: '80', enabled: 'true' as unknown as boolean }],
    ['bad id', { id: '../x', port: '80' }],
    ['id with a dot', { id: 'a.b', port: '80' }],
    ['port number not string', { port: 80 as unknown as string }],
    ['forward over a port range', { kind: 'forward', port: '8000-8010', forwardTo: '10.0.0.5:80' }],
    ['forward to cloud metadata', { kind: 'forward', port: '8081', forwardTo: '169.254.169.254:80' }],
    ['forward with a v6 source to a v4 target', { kind: 'forward', port: '2222', source: '2001:db8::/32', forwardTo: '10.0.0.5:22' }],
    ['comment with a brace', { port: '80', comment: 'x } flush ruleset' }],
    ['comment with a dollar', { port: '80', comment: '$evil' }],
    ['comment with a backtick', { port: '80', comment: 'a`b' }],
    ['comment with a bidi override', { port: '80', comment: 'ssh\u202e lla tpecca' }],
    ['comment with a lone surrogate', { port: '80', comment: 'x\ud800' }],
    ['comment of 130 UTF-8 bytes', { port: '80', comment: 'ب'.repeat(65) }],
    ['list name with a hyphen', { kind: 'prefix-list', protocol: null, list: 'block-list' }],
    ['list name of 25 characters', { kind: 'prefix-list', protocol: null, list: 'a'.repeat(25) }],
  ])('rejects %s', (_, over) => {
    expect(code(() => validateFirewallRule(r('x', over)))).toBe('VALIDATION')
  })

  it('accepts comments in any script up to 128 bytes', () => {
    expect(validateFirewallRule(r('ar', { port: '80', comment: 'ب'.repeat(64) })).comment).toHaveLength(64)
    expect(() => validateFirewallRule(r('p', { port: '80', comment: "Office (HQ): ssh/admin #2, 50% @ night!?*'[x]-=+&" }))).not.toThrow()
    expect(() => validateFirewallRule(r('f', { kind: 'forward', port: '2222', source: '203.0.113.0/24', forwardTo: '10.0.0.5:22' }))).not.toThrow()
  })

  it('rejects unknown fields and non-objects', () => {
    expect(code(() => validateFirewallRule({ ...r('x', { port: '80' }), raw: 'flush ruleset' }))).toBe('VALIDATION')
    expect(code(() => validateFirewallRule('accept all'))).toBe('VALIDATION')
  })

  it('validates lists with unique ids', () => {
    expect(validateFirewallRules([r('a', { port: '80' }), r('b', { port: '443' })])).toHaveLength(2)
    expect(code(() => validateFirewallRules([r('a', { port: '80' }), r('a', { port: '443' })]))).toBe('VALIDATION')
    expect(code(() => validateFirewallRules([r('a', { port: '80' }), r('b')]))).toBe('VALIDATION')
    expect(code(() => validateFirewallRules({}))).toBe('VALIDATION')
  })

  it('validates prefix lists', () => {
    expect(validatePrefixList('office', ['203.0.113.0/24', '2001:DB8::/32'])).toEqual({ name: 'office', entries: ['203.0.113.0/24', '2001:db8::/32'] })
    expect(code(() => validatePrefixList('office', ['203.0.113.1/24']))).toBe('VALIDATION')
    expect(code(() => validatePrefixList('Office', []))).toBe('VALIDATION')
    expect(code(() => validatePrefixList('office', 'x'))).toBe('VALIDATION')
  })
})

describe('defaultFirewallRules', () => {
  const rules = defaultFirewallRules(settings)

  it('is valid and opens exactly panel, 80, 443 and SSH to the world', () => {
    expect(validateFirewallRules(rules)).toEqual(rules)
    const world = parseIp('198.51.100.7')!
    for (const port of [22, 80, 443, 2087]) expect(evaluateFirewall(rules, { ip: world, protocol: 'tcp', port }).action).toBe('accept')
    for (const port of [21, 25, 3306, 5432, 6379, 8080, 8443, 2083]) {
      expect(evaluateFirewall(rules, { ip: world, protocol: 'tcp', port }).action).toBe('drop')
    }
    expect(evaluateFirewall(rules, { ip: world, protocol: 'udp', port: 53 }).action).toBe('drop')
  })

  it('opens the backend ports only from loopback', () => {
    for (const ip of ['127.0.0.1', '::1']) {
      expect(evaluateFirewall(rules, { ip: parseIp(ip)!, protocol: 'tcp', port: 8080 }).action).toBe('accept')
      expect(evaluateFirewall(rules, { ip: parseIp(ip)!, protocol: 'tcp', port: 8443 }).action).toBe('accept')
    }
    expect(evaluateFirewall(rules, { ip: parseIp('10.0.0.2')!, protocol: 'tcp', port: 8080 })).toEqual({ action: 'drop', ruleId: 'default-backend-drop' })
  })

  it('does not lock out any address', () => {
    for (const ip of ['198.51.100.7', '2001:db8::7', '::ffff:198.51.100.7']) expect(() => assertNoSelfLockout(rules, ctx(ip))).not.toThrow()
  })

  it.each([
    { ...settings, panelPort: 443 },
    { ...settings, sshPort: 2087 },
    { ...settings, backendPort: 80 },
    { ...settings, backendPort: 2087 },
    { ...settings, backendTlsPort: 8080 },
    { ...settings, panelPort: 0 },
    { ...settings, sshPort: 70000 },
  ])('rejects conflicting ports %o', (s) => {
    expect(code(() => defaultFirewallRules(s))).toBe('VALIDATION')
  })
})

describe('validateFirewallRuleSet', () => {
  const setCtx = { ...settings, prefixLists: { office: ['203.0.113.0/24'] } }
  const base = defaultFirewallRules(settings)
  const errorsOf = (rules: unknown): string[] => {
    try {
      validateFirewallRuleSet(rules, setCtx)
      return []
    } catch (e) {
      return ((e as XpanelError).detail.errors as string[] | undefined) ?? [(e as XpanelError).message]
    }
  }

  it('accepts the defaults and ordinary admin rules', () => {
    const rules = [
      ...base,
      r('office', { kind: 'prefix-list', protocol: 'tcp', port: '3306', list: 'office' }),
      r('fwd', { kind: 'forward', port: '2222', forwardTo: '10.0.0.5:22' }),
      r('mon', { kind: 'ip', protocol: 'tcp', port: '8080', source: '127.0.0.53' }),
    ]
    expect(validateFirewallRuleSet(rules, setCtx)).toHaveLength(rules.length)
  })

  it.each<[string, FirewallRule]>([
    ['the backend port to the world', r('open', { port: '8080' })],
    ['a range covering the TLS backend', r('open', { port: '8000-9000', source: '198.51.100.0/24' })],
    ['the backend through a prefix list', r('open', { kind: 'prefix-list', protocol: 'tcp', port: '8443', list: 'office' })],
    ['the backend from a range wider than loopback', r('open', { port: '8080', source: '0.0.0.0/0' })],
    ['the backend from an IPv6 range around ::1', r('open', { port: '8080', source: '::/127' })],
    ['a disabled rule that would open the backend once enabled', r('open', { port: '8080', enabled: false })],
  ])('refuses an accept that opens %s', (_, rule) => {
    expect(errorsOf([rule]).some((e) => e.includes('loopback only'))).toBe(true)
  })

  it.each([['2087'], ['22'], ['80'], ['443'], ['8080'], ['8443']])('refuses a forward that takes port %s', (port) => {
    expect(errorsOf([r('fwd', { kind: 'forward', port, forwardTo: '10.0.0.5:80' })]).some((e) => e.includes('forwards may not take'))).toBe(true)
  })

  it('allows drops on backend ports and loopback accepts', () => {
    expect(errorsOf([r('d', { port: '8080', action: 'drop' }), r('l', { port: '8080', source: '127.0.0.0/8' }), r('l6', { port: '8443', source: '::1' })])).toEqual([])
  })

  it('refuses a prefix-list rule naming a list that does not exist', () => {
    expect(errorsOf([r('p', { kind: 'prefix-list', protocol: null, list: 'blocklist', action: 'drop' })])).toEqual(['rule p: prefix list "blocklist" does not exist'])
  })

  it('collects every problem and still validates each rule and the ports', () => {
    expect(errorsOf([r('a', { port: '8080' }), r('b', { kind: 'forward', port: '443', forwardTo: '10.0.0.5:443' })])).toHaveLength(2)
    expect(code(() => validateFirewallRuleSet([r('bad', { port: '99999' })], setCtx))).toBe('VALIDATION')
    expect(code(() => validateFirewallRuleSet(base, { ...setCtx, backendPort: 443 }))).toBe('VALIDATION')
    expect(code(() => validateFirewallRuleSet(base, { ...setCtx, prefixLists: null as unknown as Record<string, string[]> }))).toBe('VALIDATION')
  })
})

describe('assertNoSelfLockout', () => {
  const base = defaultFirewallRules(settings)
  const me = '203.0.113.9'

  it('blocks a drop rule matching the session address placed first', () => {
    const rules = [r('deny-me', { kind: 'ip', protocol: null, source: '203.0.113.0/24', action: 'drop' }), ...base]
    try {
      assertNoSelfLockout(rules, ctx(me))
      expect.unreachable()
    } catch (e) {
      expect((e as XpanelError).code).toBe('SELF_LOCKOUT')
      expect((e as XpanelError).detail).toMatchObject({ ruleId: 'deny-me', service: 'panel', port: 2087 })
    }
  })

  it('allows the same drop placed after the accept (first match wins)', () => {
    const rules = [...base, r('deny-net', { kind: 'ip', protocol: null, source: '203.0.113.0/24', action: 'drop' })]
    expect(() => assertNoSelfLockout(rules, ctx(me))).not.toThrow()
  })

  it('allows drops that do not match the session address or port', () => {
    const rules = [
      r('deny-other', { kind: 'ip', protocol: null, source: '198.51.100.0/24', action: 'drop' }),
      r('deny-udp', { kind: 'ip', protocol: 'udp', source: '203.0.113.0/24', action: 'drop' }),
      r('deny-mysql', { port: '3306', source: '203.0.113.9', action: 'reject' }),
      r('deny-v6', { kind: 'ip', protocol: null, source: '::/0', action: 'drop' }),
      ...base,
    ]
    expect(() => assertNoSelfLockout(rules, ctx(me))).not.toThrow()
  })

  it('treats a disabled accept as absent', () => {
    const rules = base.map((x) => (x.id === 'default-panel' ? { ...x, enabled: false } : x))
    expect(code(() => assertNoSelfLockout(rules, ctx(me)))).toBe('SELF_LOCKOUT')
  })

  it('ignores a disabled drop', () => {
    const rules = [r('deny-me', { kind: 'ip', protocol: null, source: me, action: 'drop', enabled: false }), ...base]
    expect(() => assertNoSelfLockout(rules, ctx(me))).not.toThrow()
  })

  it('locks out when nothing accepts (policy drop)', () => {
    expect(code(() => assertNoSelfLockout([], ctx(me)))).toBe('SELF_LOCKOUT')
  })

  it('accepts a narrow allowlist that contains the session address', () => {
    const rules = [r('panel-office', { port: '2087', source: '203.0.113.0/28' }), r('ssh', { port: '22' })]
    expect(() => assertNoSelfLockout(rules, ctx(me))).not.toThrow()
    expect(code(() => assertNoSelfLockout(rules, ctx('203.0.113.20')))).toBe('SELF_LOCKOUT')
  })

  it('accepts port ranges and protocol both', () => {
    const rules = [r('range', { port: '2000-2100', protocol: 'both' }), r('ssh', { port: '22' })]
    expect(() => assertNoSelfLockout(rules, ctx(me))).not.toThrow()
  })

  it('treats a forward on the panel port as a lockout', () => {
    const rules = [r('fwd', { kind: 'forward', port: '2087', forwardTo: '10.0.0.5:2087' }), ...base]
    expect(code(() => assertNoSelfLockout(rules, ctx(me)))).toBe('SELF_LOCKOUT')
  })

  it('a forward diverts traffic in prerouting even when listed after the accept', () => {
    const fwd = r('fwd', { kind: 'forward', port: '2087', forwardTo: '10.0.0.5:2087' })
    const rules = [...base, fwd]
    expect(evaluateFirewall(rules, { ip: parseIp(me)!, protocol: 'tcp', port: 2087 })).toEqual({ action: 'forward', ruleId: 'fwd' })
    expect(evaluateFirewall(rules, { ip: parseIp(me)!, protocol: 'tcp', port: 443 }).action).toBe('accept')
    try {
      assertNoSelfLockout(rules, ctx(me))
      expect.unreachable()
    } catch (e) {
      expect((e as XpanelError).code).toBe('SELF_LOCKOUT')
      expect((e as XpanelError).detail).toMatchObject({ ruleId: 'fwd', verdict: 'forward', service: 'panel' })
    }
  })

  it('ignores disabled forwards and forwards scoped to other sources', () => {
    const off = r('fwd', { kind: 'forward', port: '22', forwardTo: '10.0.0.5:22', enabled: false })
    const elsewhere = r('fwd2', { kind: 'forward', port: '22', source: '198.51.100.0/24', forwardTo: '10.0.0.5:22' })
    expect(() => assertNoSelfLockout([...base, off, elsewhere], ctx(me))).not.toThrow()
    expect(code(() => assertNoSelfLockout([...base, elsewhere], ctx('198.51.100.4')))).toBe('SELF_LOCKOUT')
  })

  it('evaluates prefix lists: known contents decide, unknown lists are assumed to match a drop', () => {
    const drop = r('bad-list', { kind: 'prefix-list', protocol: null, list: 'blocklist', action: 'drop' })
    const rules = [drop, ...base]
    expect(code(() => assertNoSelfLockout(rules, ctx(me)))).toBe('SELF_LOCKOUT')
    expect(code(() => assertNoSelfLockout(rules, ctx(me, { prefixLists: { blocklist: ['203.0.113.0/24'] } })))).toBe('SELF_LOCKOUT')
    expect(() => assertNoSelfLockout(rules, ctx(me, { prefixLists: { blocklist: ['198.51.100.0/24'] } }))).not.toThrow()
    expect(code(() => assertNoSelfLockout(rules, ctx(me, { prefixLists: { blocklist: ['garbage'] } })))).toBe('SELF_LOCKOUT')
  })

  it('does not trust an accept prefix list it cannot read', () => {
    const allow = r('admins', { kind: 'prefix-list', protocol: 'tcp', port: '2087', list: 'admins' })
    const rules = [allow, r('ssh', { port: '22' })]
    expect(code(() => assertNoSelfLockout(rules, ctx(me)))).toBe('SELF_LOCKOUT')
    expect(() => assertNoSelfLockout(rules, ctx(me, { prefixLists: { admins: ['203.0.113.9'] } }))).not.toThrow()
  })

  it('guards SSH unless sshPort is null', () => {
    const rules = base.filter((x) => x.id !== 'default-ssh')
    try {
      assertNoSelfLockout(rules, ctx(me))
      expect.unreachable()
    } catch (e) {
      expect((e as XpanelError).detail).toMatchObject({ service: 'ssh', port: 22 })
    }
    expect(() => assertNoSelfLockout(rules, ctx(me, { sshPort: null }))).not.toThrow()
  })

  it('matches IPv4-mapped session addresses against IPv4 rules', () => {
    const rules = [r('deny-me', { kind: 'ip', protocol: null, source: '203.0.113.9', action: 'drop' }), ...base]
    expect(code(() => assertNoSelfLockout(rules, ctx('::ffff:203.0.113.9')))).toBe('SELF_LOCKOUT')
  })

  it('handles IPv6 sessions', () => {
    const rules = [r('deny-v6', { kind: 'ip', protocol: null, source: '2001:db8::/32', action: 'reject' }), ...base]
    expect(code(() => assertNoSelfLockout(rules, ctx('2001:db8::42')))).toBe('SELF_LOCKOUT')
    expect(() => assertNoSelfLockout(rules, ctx('2001:db9::42'))).not.toThrow()
  })

  it('validates its inputs', () => {
    expect(code(() => assertNoSelfLockout(base, ctx('not-an-ip')))).toBe('VALIDATION')
    expect(code(() => assertNoSelfLockout(base, ctx(me, { panelPort: 0 })))).toBe('VALIDATION')
    expect(code(() => assertNoSelfLockout([...base, r('bad', { port: '99999' })], ctx(me)))).toBe('VALIDATION')
    expect(code(() => assertNoSelfLockout(base, null as unknown as Parameters<typeof assertNoSelfLockout>[1]))).toBe('VALIDATION')
  })
})
