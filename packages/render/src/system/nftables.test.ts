import { describe, expect, it } from 'vitest'
import type { FirewallRule } from '@xpanel/core'
import { defaultFirewallRules, evaluateFirewall, parseIp, XpanelError, MANAGEMENT_PUBLIC_PORTS, MANAGEMENT_BACKEND_PORTS } from '@xpanel/core'
import {
  banSetActions,
  exportRules,
  FIREWALL_EXPORT_FORMAT,
  importRules,
  nftApplyActions,
  nftConfigTest,
  nftSettingsFromServer,
  renderForwardingSysctl,
  renderNftables,
  sysctlApplyActions,
  unbanSetActions,
  type NftSettings,
} from './nftables.ts'
import { debianOs, rhelOs, rule } from './testkit.ts'

const lists: Record<string, string[]> = {
  office: ['192.0.2.0/24', '198.51.100.7', '2001:db8:1::/48', '192.0.2.0/24'],
  blocked: ['203.0.113.0/24'],
}

const settings: NftSettings = {
  panelPort: 2087,
  sshPort: 22,
  backendPorts: [8080, 8443],
  banTimeoutSec: 3600,
  prefixLists: lists,
}

const defaults = defaultFirewallRules({ panelPort: 2087, sshPort: 22, backendPort: 8080, backendTlsPort: 8443 })

const codeOf = (f: () => unknown): string => {
  try {
    f()
  } catch (e) {
    if (e instanceof XpanelError) return e.code
    throw e
  }
  throw new Error('did not throw')
}

const inputChain = (content: string): string[] => {
  const start = content.indexOf('  chain input {')
  const end = content.indexOf('  }', start)
  return content.slice(start, end).split('\n').slice(1).map((l) => l.trim()).filter(Boolean)
}

const openPanel = rule({ id: 'open-panel', kind: 'port', protocol: 'tcp', port: '2087' })

/** Renders `rs` plus one rule that opens the panel, so tests of other rules pass the lockout guard. */
const render = (rs: FirewallRule[], s: NftSettings = settings) => renderNftables([...rs, openPanel], s, debianOs)

const admin: FirewallRule[] = [
  rule({ id: 'r1', kind: 'ip', action: 'drop', source: '203.0.113.66', comment: 'abuser' }),
  rule({ id: 'r2', kind: 'port', protocol: 'tcp', port: '3306', source: '192.0.2.0/24', comment: 'db from office' }),
  rule({ id: 'r3', kind: 'port', protocol: 'both', port: '10000-10100', comment: 'passive ftp' }),
  rule({ id: 'r4', kind: 'prefix-list', action: 'accept', list: 'office', protocol: 'tcp', port: '9000' }),
  rule({ id: 'r5', kind: 'icmp', comment: 'ping from anywhere' }),
  rule({ id: 'r6', kind: 'port', protocol: 'tcp', port: '7777', enabled: false, comment: 'DISABLED-MARKER' }),
  rule({ id: 'r7', kind: 'prefix-list', action: 'drop', list: 'blocked', enabled: false }),
]
const rules: FirewallRule[] = [...admin, ...defaults]

describe('renderNftables', () => {
  const file = renderNftables(rules, settings, debianOs)
  const chain = inputChain(file.content)

  it('replaces only our table, atomically', () => {
    expect(file.path).toBe('/etc/nftables.conf')
    expect(file.mode).toBe(0o600)
    expect(file.content.startsWith('#!/usr/sbin/nft -f\n')).toBe(true)
    expect(file.content).toContain('table inet xpanel\ndelete table inet xpanel\n\ntable inet xpanel {')
    expect(file.content).not.toContain('flush ruleset')
  })

  it('writes to the OS-specific path', () => {
    expect(renderNftables(rules, settings, rhelOs).path).toBe('/etc/sysconfig/nftables.conf')
  })

  it('drops by default and puts loopback, invalid, bans and established first', () => {
    expect(chain.slice(0, 6)).toEqual([
      'type filter hook input priority filter; policy drop;',
      'iif "lo" accept',
      'ct state invalid drop',
      'ip saddr @xpanel_banned tcp dport { 22, 2087 } drop',
      'ip6 saddr @xpanel_banned6 tcp dport { 22, 2087 } drop',
      'ct state established,related accept',
    ])
  })

  it('opens panel, 80, 443 and SSH through core default rules, not hidden extras', () => {
    expect(chain).toContain('tcp dport 22 accept comment "SSH"')
    expect(chain).toContain('tcp dport 80 accept comment "HTTP"')
    expect(chain).toContain('tcp dport 443 accept comment "HTTPS"')
    expect(chain).toContain('tcp dport 2087 accept comment "xPanel"')
    expect(chain.some((l) => l.includes('xpanel: web') || l.includes('xpanel: panel') || l.includes('xpanel: ssh'))).toBe(false)
  })

  it('accepts no remote port other than the enabled rules open', () => {
    const accepted = chain
      .filter((l) => l.includes(' accept') && /dport/.test(l) && !/saddr (127\.|::1 )/.test(l))
      .flatMap((l) => [...(/dport (\{[^}]*\}|\S+)/.exec(l)?.[1] ?? '').matchAll(/\d+(?:-\d+)?/g)].map((m) => m[0]))
    expect(new Set(accepted)).toEqual(new Set(['546', '3306', '10000-10100', '9000', '22', '80', '443', '2083', '2087', '2096']))
    expect(chain).toContain('ip6 daddr fe80::/64 udp dport 546 accept comment "xpanel: dhcpv6 client"')
  })

  it('really closes SSH when the admin disables default-ssh', () => {
    const closed = renderNftables(rules.map((r) => (r.id === 'default-ssh' ? { ...r, enabled: false } : r)), settings, debianOs)
    const c = inputChain(closed.content)
    expect(c.filter((l) => /\bdport 22\b/.test(l) && l.includes('accept'))).toEqual([])
    expect(c).toContain('tcp dport 2087 accept comment "xPanel"')
  })

  it('keeps the backend ports loopback-only, guarded before any rule', () => {
    const lo = chain.indexOf('iif "lo" accept')
    const guard = chain.indexOf('tcp dport { 8080, 8443, 12083, 12087, 12096 } drop comment "xpanel: backend is loopback-only"')
    expect(lo).toBe(1)
    expect(guard).toBeGreaterThan(lo)
    expect(guard).toBeLessThan(chain.findIndex((l) => l.includes('203.0.113.66')))
    const backendAccepts = chain.filter((l) => /\b(8080|8443)\b/.test(l) && l.includes(' accept'))
    expect(backendAccepts.length).toBeGreaterThan(0)
    for (const l of backendAccepts) {
      expect(l, l).toMatch(/^(ip saddr 127\.0\.0\.0\/8|ip6 saddr ::1) /)
      expect(chain.indexOf(l)).toBeGreaterThan(guard)
    }
  })

  it('always allows essential ICMPv6 neighbour discovery and PMTU errors', () => {
    expect(chain).toContain('icmpv6 type { nd-router-solicit, nd-router-advert, nd-neighbor-solicit, nd-neighbor-advert } ip6 hoplimit 255 accept')
    expect(chain).toContain('icmpv6 type { destination-unreachable, packet-too-big, time-exceeded, parameter-problem } accept')
    expect(chain).toContain('icmp type { destination-unreachable, time-exceeded, parameter-problem } accept')
  })

  it('renders the list in order after the base chain, first match wins as in core', () => {
    const start = chain.findIndex((l) => l.includes('203.0.113.66'))
    expect(chain.slice(start, start + 8)).toEqual([
      'ip saddr 203.0.113.66 drop comment "abuser"',
      'ip saddr 192.0.2.0/24 tcp dport 3306 accept comment "db from office"',
      'tcp dport 10000-10100 accept comment "passive ftp"',
      'udp dport 10000-10100 accept comment "passive ftp"',
      'ip saddr @pl_office_v4 tcp dport 9000 accept',
      'ip6 saddr @pl_office_v6 tcp dport 9000 accept',
      'icmp type echo-request accept comment "ping from anywhere"',
      'icmpv6 type echo-request accept comment "ping from anywhere"',
    ])
    // the abuser's drop precedes the panel accept, so core and kernel both drop it
    expect(start).toBeLessThan(chain.indexOf('tcp dport 2087 accept comment "xPanel"'))
    const abuser = evaluateFirewall(rules, { ip: parseIp('203.0.113.66') as NonNullable<ReturnType<typeof parseIp>>, protocol: 'tcp', port: 2087 })
    expect(abuser).toEqual({ action: 'drop', ruleId: 'r1' })
  })

  it('never emits disabled rules or sets only they reference', () => {
    expect(file.content).not.toContain('DISABLED-MARKER')
    expect(file.content).not.toContain('7777')
    expect(file.content).not.toContain('pl_blocked')
    expect(file.content).not.toContain('203.0.113.0/24')
  })

  it('declares prefix lists as deduplicated interval sets per family', () => {
    expect(file.content).toContain(
      '  set pl_office_v4 {\n    type ipv4_addr\n    flags interval\n    auto-merge\n    elements = {\n      192.0.2.0/24, 198.51.100.7\n    }\n  }',
    )
    expect(file.content).toContain('  set pl_office_v6 {\n    type ipv6_addr\n    flags interval\n    auto-merge\n    elements = {\n      2001:db8:1::/48\n    }\n  }')
  })

  it('declares timeout ban sets and drops banned addresses on ssh and panel only', () => {
    expect(file.content).toContain('  set xpanel_banned {\n    type ipv4_addr\n    flags timeout\n    timeout 3600s\n    size 65536\n  }')
    expect(file.content).toContain('  set xpanel_banned6 {\n    type ipv6_addr\n    flags timeout')
  })

  it('re-adds persisted bans with their remaining lifetime and drops expired ones', () => {
    const f = render([], {
      ...settings,
      now: 1_000_000,
      bans: [
        { ip: '198.51.100.9', expiresAt: 1_001_800 },
        { ip: '::ffff:198.51.100.10', expiresAt: 1_000_060 },
        { ip: '2001:db8::66', expiresAt: 1_000_100 },
        { ip: '198.51.100.11', expiresAt: 999_999 },
      ],
    })
    expect(f.content).toContain('elements = {\n      198.51.100.9 timeout 1800s, 198.51.100.10 timeout 60s\n    }')
    expect(f.content).toContain('2001:db8::66 timeout 100s')
    expect(f.content).not.toContain('198.51.100.11')
    expect(codeOf(() => render([], { ...settings, bans: [{ ip: '1.2.3.4', expiresAt: 5 }] }))).toBe('VALIDATION')
    expect(codeOf(() => render([], { ...settings, now: 1, bans: [{ ip: '1.2.3.4; flush ruleset', expiresAt: 5 }] }))).toBe('VALIDATION')
  })

  it('chunks large prefix lists across lines', () => {
    const big = Array.from({ length: 20 }, (_, i) => `10.0.${i}.0/24`)
    const f = render([rule({ id: 'b', kind: 'prefix-list', action: 'drop', list: 'big' })], { ...settings, prefixLists: { big } })
    expect(f.content).toMatch(/10\.0\.7\.0\/24,\n {6}10\.0\.8\.0\/24/)
    expect(inputChain(f.content)).toContain('ip saddr @pl_big_v4 drop')
  })

  it('renders port forwarding as DNAT, forward accept and masquerade', () => {
    const fwd = [
      rule({ id: 'f1', kind: 'forward', protocol: 'tcp', port: '2222', forwardTo: '10.0.0.5:22', comment: 'vm ssh' }),
      rule({ id: 'f2', kind: 'forward', protocol: 'both', port: '5353', forwardTo: '[fd00::5]:53', source: '2001:db8::/32' }),
    ]
    const f = render(fwd).content
    expect(f).toContain('    type nat hook prerouting priority dstnat; policy accept;\n    meta nfproto ipv4 tcp dport 2222 dnat ip to 10.0.0.5:22 comment "vm ssh"')
    expect(f).toContain('ip6 saddr 2001:db8::/32 udp dport 5353 dnat ip6 to [fd00::5]:53')
    expect(f).toContain('ip daddr 10.0.0.5 tcp dport 22 ct status dnat accept')
    expect(f).toContain('ip6 daddr fd00::5 udp dport 53 ct status dnat accept')
    expect(f).toContain('ip daddr 10.0.0.5 tcp dport 22 ct status dnat masquerade')
    expect(f).toContain('type filter hook forward priority filter; policy drop;')
    expect(inputChain(f).join('\n')).not.toContain('2222')
  })

  it('omits nat chains without forwards and keeps the forward chain closed', () => {
    expect(file.content).not.toContain('hook prerouting')
    expect(file.content).toContain('type filter hook forward priority filter; policy drop;')
    expect(render([], { ...settings, forwardPolicy: 'accept' }).content).toContain('policy accept;')
  })

  it('rejects rules that open a backend port to the network, even through a range', () => {
    for (const r of [
      rule({ id: 'x', kind: 'port', protocol: 'tcp', port: '8080' }),
      rule({ id: 'x', kind: 'port', protocol: 'tcp', port: '8000-8100' }),
      rule({ id: 'x', kind: 'ip', source: '192.0.2.1', protocol: 'tcp', port: '8443' }),
      rule({ id: 'x', kind: 'ip', source: '126.0.0.0/7', protocol: 'tcp', port: '8080' }),
      rule({ id: 'x', kind: 'ip', source: '::/127', protocol: 'tcp', port: '8080' }),
      rule({ id: 'x', kind: 'prefix-list', list: 'office', protocol: 'tcp', port: '8443' }),
    ]) {
      expect(codeOf(() => render([r])), JSON.stringify(r)).toBe('VALIDATION')
    }
    expect(() => render([rule({ id: 'x', kind: 'port', protocol: 'tcp', port: '8080', action: 'drop' })])).not.toThrow()
    expect(() => render([rule({ id: 'x', kind: 'port', protocol: 'tcp', port: '8080', enabled: false })])).not.toThrow()
  })

  it('rejects forwards that hijack base ports or target special addresses', () => {
    for (const r of [
      rule({ id: 'x', kind: 'forward', protocol: 'tcp', port: '443', forwardTo: '10.0.0.5:443' }),
      rule({ id: 'x', kind: 'forward', protocol: 'tcp', port: '2087', forwardTo: '10.0.0.5:80' }),
      rule({ id: 'x', kind: 'forward', protocol: 'tcp', port: '22', forwardTo: '10.0.0.5:22' }),
      rule({ id: 'x', kind: 'forward', protocol: 'tcp', port: '8080', forwardTo: '10.0.0.5:80' }),
      rule({ id: 'x', kind: 'forward', protocol: 'tcp', port: '9999', forwardTo: '127.0.0.1:8080' }),
      rule({ id: 'x', kind: 'forward', protocol: 'tcp', port: '9999', forwardTo: '169.254.169.254:80' }),
      rule({ id: 'x', kind: 'forward', protocol: 'tcp', port: '9999', forwardTo: '[::1]:80' }),
      rule({ id: 'x', kind: 'forward', protocol: 'tcp', port: '9999', forwardTo: '[fe80::1]:80' }),
      rule({ id: 'x', kind: 'forward', protocol: 'tcp', port: '9999', forwardTo: '[::ffff:10.0.0.5]:80' }),
      rule({ id: 'x', kind: 'forward', protocol: 'tcp', port: '9999', forwardTo: '224.0.0.1:80' }),
      rule({ id: 'x', kind: 'forward', protocol: 'tcp', port: '9000-9001', forwardTo: '10.0.0.5:80' }),
      rule({ id: 'x', kind: 'forward', protocol: 'tcp', port: '9999', forwardTo: '10.0.0.5:80', action: 'drop' }),
      rule({ id: 'x', kind: 'forward', protocol: 'tcp', port: '9999', forwardTo: '10.0.0.5:80', source: '2001:db8::/32' }),
      rule({ id: 'x', kind: 'forward', protocol: 'tcp', port: '9999', forwardTo: 'fd00::5:80' }),
    ]) {
      expect(codeOf(() => render([r])), r.forwardTo ?? '').toBe('VALIDATION')
    }
  })

  it('rejects port clashes and bad settings', () => {
    for (const s of [
      { ...settings, sshPort: 2087 },
      { ...settings, backendPorts: [443] },
      { ...settings, backendPorts: [] },
      { ...settings, panelPort: 0 },
      { ...settings, panelPort: 65536 },
      { ...settings, banTimeoutSec: 10 },
      { ...settings, forwardPolicy: 'reject' as 'drop' },
      { ...settings, prefixLists: { 'Bad Name': [] } },
      { ...settings, prefixLists: { '1list': [] } },
      { ...settings, prefixLists: { 'geo-block': ['203.0.113.0/24'] } },
      { ...settings, prefixLists: { __proto__: ['1.2.3.4'] } as unknown as Record<string, string[]> },
      { ...settings, prefixLists: { ok: ['10.0.0.1/8'] } },
      { ...settings, prefixLists: { ok: ['10.0.0.0/8; flush ruleset'] } },
      { ...settings, prefixLists: { ok: '10.0.0.0/8' as unknown as string[] } },
    ]) {
      expect(codeOf(() => render([], s)), JSON.stringify(s)).toBe('VALIDATION')
    }
  })

  it('rejects duplicate ids and enabled references to missing lists', () => {
    expect(codeOf(() => render([rule({ id: 'a', kind: 'icmp' }), rule({ id: 'a', kind: 'icmp' })]))).toBe('VALIDATION')
    expect(codeOf(() => render([rule({ id: 'a', kind: 'prefix-list', list: 'nope' })]))).toBe('VALIDATION')
    expect(() => render([rule({ id: 'a', kind: 'prefix-list', list: 'nope', enabled: false })])).not.toThrow()
  })
})

describe('renderNftables lockout guard', () => {
  it('refuses a list in which no enabled rule opens the panel port', () => {
    for (const rs of [
      [],
      defaults.map((r) => (r.id === 'default-panel' ? { ...r, enabled: false } : r)),
      [rule({ id: 'lo', kind: 'port', protocol: 'tcp', port: '2087', source: '127.0.0.0/8' })],
      [rule({ id: 'u', kind: 'port', protocol: 'udp', port: '2087' })],
      [rule({ id: 'p', kind: 'port', protocol: 'tcp', port: '2088' })],
      [rule({ id: 'd', kind: 'port', action: 'drop', protocol: 'tcp', port: '2087' })],
      [rule({ id: 'i', kind: 'icmp' })],
      [rule({ id: 'e', kind: 'prefix-list', list: 'empty', protocol: 'tcp', port: '2087' })],
    ]) {
      expect(codeOf(() => renderNftables(rs, { ...settings, prefixLists: { ...lists, empty: [] } }, debianOs)), JSON.stringify(rs)).toBe('SELF_LOCKOUT')
    }
  })

  it('accepts any rule kind that lets some remote address reach the panel', () => {
    for (const r of [
      rule({ id: 'a', kind: 'ip', source: '198.51.100.0/24' }),
      rule({ id: 'b', kind: 'port', protocol: 'both', port: '2000-3000' }),
      rule({ id: 'c', kind: 'prefix-list', list: 'office' }),
      rule({ id: 'd', kind: 'ip', source: '2001:db8::/32', protocol: 'tcp', port: '2087' }),
    ]) {
      expect(() => renderNftables([r], settings, debianOs), r.id).not.toThrow()
    }
  })
})

describe('rule validation is core validation', () => {
  const base = { id: 'r', kind: 'port', action: 'accept', protocol: 'tcp', port: '25', source: null, forwardTo: null, list: null, comment: '', enabled: true }

  it.each([
    ['comment quote', { comment: 'x" accept; flush ruleset; "' }],
    ['comment newline', { comment: 'a\nchain input { }' }],
    ['comment backslash', { comment: 'a\\' }],
    ['comment braces and dollar', { comment: '{ $x; drop }' }],
    ['comment C1 control', { comment: `a${String.fromCharCode(0x85)}b` }],
    ['comment line separator', { comment: `a${String.fromCharCode(0x2028)}b` }],
    ['comment bidi override', { comment: `abc${String.fromCharCode(0x202e)}fed` }],
    ['comment too long', { comment: 'x'.repeat(129) }],
    ['comment too long in bytes', { comment: 'م'.repeat(65) }],
    ['source injection', { kind: 'ip', source: '1.2.3.4 accept' }],
    ['source set reference', { kind: 'ip', source: '@xpanel_banned' }],
    ['source host bits', { kind: 'ip', source: '10.0.0.1/8' }],
    ['port injection', { port: '22 accept' }],
    ['port set', { port: '{ 22, 80 }' }],
    ['port zero', { port: '0' }],
    ['port leading zero', { port: '022' }],
    ['port overflow', { port: '65536' }],
    ['reversed range', { port: '100-50' }],
    ['zero-size range', { port: '80-80' }],
    ['port without protocol', { protocol: null }],
    ['unknown protocol', { protocol: 'sctp' }],
    ['unknown action', { action: 'jump input' }],
    ['unknown kind', { kind: 'nat' }],
    ['id injection', { id: 'a b' }],
    ['dotted id', { id: 'web.v2' }],
    ['extra field', { extra: 1 }],
    ['enabled string', { enabled: 'yes' }],
    ['ip without source', { kind: 'ip' }],
    ['icmp with port', { kind: 'icmp' }],
    ['list on port rule', { list: 'office' }],
    ['forwardTo on port rule', { forwardTo: '10.0.0.5:80' }],
  ])('rejects %s', (_, patch) => {
    expect(codeOf(() => render([{ ...base, ...patch } as FirewallRule]))).toBe('VALIDATION')
  })

  it('renders Arabic comments up to 128 bytes and allowed punctuation literally', () => {
    const f = render([
      rule({ id: 'ar', kind: 'icmp', comment: 'خادم المكتب (الرئيسي) - 2026' }),
      rule({ id: 'max', kind: 'icmp', comment: 'م'.repeat(64) }),
      rule({ id: 'punct', kind: 'icmp', comment: "a; b # c [d] 'e' 50% & f=g" }),
    ])
    const chain = inputChain(f.content)
    expect(chain).toContain('icmp type echo-request accept comment "خادم المكتب (الرئيسي) - 2026"')
    expect(chain).toContain(`icmp type echo-request accept comment "${'م'.repeat(64)}"`)
    expect(chain).toContain('icmp type echo-request accept comment "a; b # c [d] \'e\' 50% & f=g"')
  })

  it('canonicalizes sources the way core stores them', () => {
    const chain = inputChain(render([rule({ id: 's', kind: 'ip', action: 'drop', source: '2001:DB8:0::/32' }), rule({ id: 'm', kind: 'ip', action: 'drop', source: '::ffff:192.0.2.9' })]).content)
    expect(chain).toContain('ip6 saddr 2001:db8::/32 drop')
    expect(chain).toContain('ip saddr 192.0.2.9 drop')
  })
})

describe('ban set actions', () => {
  it('adds canonical addresses to the right family set with argv only', () => {
    expect(banSetActions(['203.0.113.5', '::ffff:203.0.113.6', '2001:DB8::1'], 3600)).toEqual([
      { kind: 'exec', argv: ['/usr/sbin/nft', 'add', 'element', 'inet', 'xpanel', 'xpanel_banned', '{', '203.0.113.5', 'timeout', '3600s', '}'] },
      { kind: 'exec', argv: ['/usr/sbin/nft', 'add', 'element', 'inet', 'xpanel', 'xpanel_banned', '{', '203.0.113.6', 'timeout', '3600s', '}'] },
      { kind: 'exec', argv: ['/usr/sbin/nft', 'add', 'element', 'inet', 'xpanel', 'xpanel_banned6', '{', '2001:db8::1', 'timeout', '3600s', '}'] },
    ])
    expect(unbanSetActions(['203.0.113.5'])[0]).toEqual({ kind: 'exec', argv: ['/usr/sbin/nft', 'delete', 'element', 'inet', 'xpanel', 'xpanel_banned', '{', '203.0.113.5', '}'] })
  })

  it('rejects loopback, junk and injection', () => {
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '1.2.3.4 }', '1.2.3.4; flush ruleset', '10.0.0.0/8', '']) {
      expect(() => banSetActions([ip], 3600), ip).toThrowError(XpanelError)
    }
    expect(() => banSetActions(['1.2.3.4'], 5)).toThrowError(XpanelError)
  })
})

describe('export / import', () => {
  const TS = '2026-10-22T00:00:00Z'
  const exported = exportRules(rules, lists, TS)
  const doc = (o: Record<string, unknown>): string => JSON.stringify({ format: FIREWALL_EXPORT_FORMAT, version: 1, exportedAt: TS, rules: [], ...o })

  it('round-trips rules and lists through our versioned schema', () => {
    const parsed = JSON.parse(exported) as Record<string, unknown>
    expect(parsed.format).toBe(FIREWALL_EXPORT_FORMAT)
    expect(parsed.version).toBe(1)
    expect(parsed.exportedAt).toBe(TS)
    const back = importRules(exported)
    expect(back.rules).toEqual(rules)
    expect(back.prefixLists).toEqual({ office: ['192.0.2.0/24', '198.51.100.7', '2001:db8:1::/48'], blocked: ['203.0.113.0/24'] })
    expect(renderNftables(back.rules, { ...settings, prefixLists: back.prefixLists }, debianOs).content).toBe(renderNftables(rules, settings, debianOs).content)
  })

  it('refuses to export invalid rules or a non-RFC 3339 timestamp', () => {
    expect(codeOf(() => exportRules([rule({ id: 'x', kind: 'ip', source: 'nope' })], {}, TS))).toBe('VALIDATION')
    for (const at of ['now', '2026-10-22', '2026-13-01T00:00:00Z', '2026-10-22T00:00:00', '2026-10-22 00:00:00Z']) {
      expect(codeOf(() => exportRules([], {}, at)), at).toBe('VALIDATION')
    }
    expect(() => exportRules([], {}, '2026-10-22T03:00:00.123+03:00')).not.toThrow()
  })

  it.each([
    ['not json', '{'],
    ['array', '[]'],
    ['wrong format', doc({ format: 'iptables' })],
    ['future version', doc({ version: 2 })],
    ['string version', doc({ version: '1' })],
    ['unknown top-level field', doc({ run: 'x' })],
    ['rules not array', doc({ rules: {} })],
    ['proto pollution list', `{"format":"${FIREWALL_EXPORT_FORMAT}","version":1,"exportedAt":"${TS}","rules":[],"prefixLists":{"__proto__":["1.2.3.4"]}}`],
    ['bad rule inside', doc({ rules: [{ ...rule({ id: 'a', kind: 'port', protocol: 'tcp', port: '22;' }) }] })],
    ['duplicate ids', doc({ rules: [rule({ id: 'a', kind: 'icmp' }), rule({ id: 'a', kind: 'icmp' })] })],
    ['list missing', doc({ rules: [rule({ id: 'a', kind: 'prefix-list', list: 'x' })] })],
    ['list missing for a disabled rule', doc({ rules: [rule({ id: 'a', kind: 'prefix-list', list: 'x', enabled: false })] })],
    ['exportedAt missing', JSON.stringify({ format: FIREWALL_EXPORT_FORMAT, version: 1, rules: [] })],
    ['exportedAt control char', doc({ exportedAt: 'a\nb' })],
    ['exportedAt not a timestamp', doc({ exportedAt: 'yesterday' })],
  ])('rejects %s', (_, text) => {
    expect(codeOf(() => importRules(text))).toBe('VALIDATION')
  })

  it('rejects oversized input and non-strings', () => {
    expect(codeOf(() => importRules(5))).toBe('VALIDATION')
    expect(codeOf(() => importRules(' '.repeat(16 * 1024 * 1024 + 1)))).toBe('VALIDATION')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('helpers', () => {
  it('wires all entry points into the production server adapter and refuses closing any one', () => {
    const configured = nftSettingsFromServer({ panelPort: 2087, sshPort: 22, backendPort: 8080, backendTlsPort: 8443 }, { banTimeoutSec: 600 })
    const file = renderNftables(defaults, configured, debianOs)
    expect(file.content).toContain('tcp dport { 22, 2087, 2083, 2096 } drop')
    for (const port of MANAGEMENT_PUBLIC_PORTS) {
      expect(codeOf(() => renderNftables(defaults.filter((r) => r.port !== String(port)), configured, debianOs))).toBe('SELF_LOCKOUT')
    }
    expect(file.content).not.toContain('tcp dport 12083 accept')
  })
  it.each([...MANAGEMENT_PUBLIC_PORTS, ...MANAGEMENT_BACKEND_PORTS])('rejects forwarding takeover and backend reuse of management port %s', (port) => {
    expect(codeOf(() => render([rule({ id: 'takeover', kind: 'forward', port: String(port), protocol: 'tcp', forwardTo: '10.0.0.5:9000' })]))).toBe('VALIDATION')
    expect(codeOf(() => render([], { ...settings, backendPorts: [port] }))).toBe('VALIDATION')
  })
  it.each(MANAGEMENT_BACKEND_PORTS)('rejects exposing private listener %s through a public accept', (port) => {
    expect(codeOf(() => render([rule({ id: 'expose', kind: 'port', port: String(port), protocol: 'tcp' })]))).toBe('VALIDATION')
  })
  it('rejects duplicate management ports and protects a custom legacy panel without opening unrelated ports', () => {
    expect(codeOf(() => renderNftables(defaults, { ...settings, managementPorts: [2083, 2083] }, debianOs))).toBe('VALIDATION')
    const custom = { panelPort: 9443, sshPort: 22, backendPort: 8080, backendTlsPort: 8443 }
    const content = renderNftables(defaultFirewallRules(custom), nftSettingsFromServer(custom, { banTimeoutSec: 600 }), debianOs).content
    expect(content).toContain('tcp dport 9443 accept')
    expect(content).not.toContain('tcp dport 9444 accept')
    expect(codeOf(() => renderNftables([rule({ id: 'takeover', kind: 'forward', port: '9443', protocol: 'tcp', forwardTo: '10.0.0.5:9000' }), ...defaultFirewallRules(custom)], nftSettingsFromServer(custom, { banTimeoutSec: 600 }), debianOs))).toBe('VALIDATION')
  })
  it('builds settings from ServerSettings and a config test', () => {
    const s = nftSettingsFromServer({ panelPort: 2087, sshPort: 22, backendPort: 8080, backendTlsPort: 8443 }, { banTimeoutSec: 600 })
    expect(s).toEqual({ banTimeoutSec: 600, panelPort: 2087, managementPorts: MANAGEMENT_PUBLIC_PORTS, sshPort: 22, backendPorts: [8080, 8443] })
    expect(nftConfigTest('/etc/nftables.conf')).toEqual({ name: 'nftables', argv: ['/usr/sbin/nft', '-c', '-f', '/etc/nftables.conf'] })
    expect(() => nftConfigTest('nftables.conf')).toThrowError(XpanelError)
  })

  it('applies with nft -f on the distro path and enables the unit, never a service reload', () => {
    expect(nftApplyActions(debianOs)).toEqual([
      { kind: 'exec', argv: ['/usr/sbin/nft', '-f', '/etc/nftables.conf'] },
      { kind: 'systemd', verb: 'enable', unit: 'nftables' },
    ])
    expect(nftApplyActions(rhelOs)[0]).toEqual({ kind: 'exec', argv: ['/usr/sbin/nft', '-f', '/etc/sysconfig/nftables.conf'] })
    expect(nftApplyActions(rhelOs).some((a) => a.kind === 'systemd' && a.verb === 'reload')).toBe(false)
  })

  it('enables forwarding for exactly the families enabled forwards need', () => {
    expect(renderForwardingSysctl(rules)).toBeNull()
    const v4 = rule({ id: 'f', kind: 'forward', protocol: 'tcp', port: '2222', forwardTo: '10.0.0.5:22' })
    const v6 = rule({ id: 'g', kind: 'forward', protocol: 'tcp', port: '2223', forwardTo: '[2001:db8::5]:22' })
    expect(renderForwardingSysctl([v4])?.content).toBe('# Generated by xPanel: port forwarding rules need routing.\nnet.ipv4.ip_forward = 1\n')
    expect(renderForwardingSysctl([v6])?.content).toBe('# Generated by xPanel: port forwarding rules need routing.\nnet.ipv6.conf.all.forwarding = 1\n')
    expect(renderForwardingSysctl([v4, v6])?.content).toContain('net.ipv4.ip_forward = 1\nnet.ipv6.conf.all.forwarding = 1\n')
    expect(renderForwardingSysctl([{ ...v4, enabled: false }])).toBeNull()
    expect(codeOf(() => renderForwardingSysctl([{ ...v4, forwardTo: '127.0.0.1:22' }]))).toBe('VALIDATION')
    expect(sysctlApplyActions({ path: '/etc/sysctl.d/90-xpanel-forward.conf' })).toEqual([
      { kind: 'exec', argv: ['/usr/sbin/sysctl', '-p', '/etc/sysctl.d/90-xpanel-forward.conf'] },
    ])
  })
})
