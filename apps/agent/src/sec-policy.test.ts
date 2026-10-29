import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultFirewallRules } from '@xpanel/core'
import { edge, system } from '@xpanel/render'
import { effectiveSecPolicy, parseSecDnsClusterConfig, parseSecFloodPolicy, parseSecPanelAccessPolicy, parseSecWafPolicy, parseSecWafSites, readSecRecord, SEC_DEFAULTS, SEC_FLOOD_STATE, SEC_WAF_SITES_STATE, SEC_WAF_STATE, secPanelAccessAdmits, secRevision } from './sec-policy.ts'
import { readSecEdgeConfiguration } from './sec-waf.ts'
import { isSecHostCommand, SEC_NFT_LIST_ARGV } from '../../../packages/os/src/sec-host-command.ts'

const waf = { ...SEC_DEFAULTS.waf, requestsPerSecond: 20, burst: 40, denyIps: ['198.51.100.0/24', '192.0.2.44'], denyPaths: ['^/\\.(git|env)(/|$)'], denyUserAgents: ['(?i)(sqlmap|nikto)'] }
const flood = { enabled: true, connectionsPerAddress: 100, newConnectionsPerSecond: 50, newConnectionsBurst: 100, pingPerSecond: 10, webConnectionsPerAddress: 40 }
const record = (policy: unknown) => ({ version: 1, policy, updatedAt: '2026-10-28T10:00:00.000Z' })
const ACCOUNT = '11111111-1111-4111-8111-111111111111'
let dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))); dirs = [] })

describe('sec policy grammar', () => {
  it('accepts canonical WAF policies and refuses unknown keys, loose limits and unsafe patterns', () => {
    expect(parseSecWafPolicy(waf)).toEqual(waf)
    expect(() => parseSecWafPolicy({ ...waf, extra: 1 })).toThrow()
    expect(() => parseSecWafPolicy({ ...waf, requestsPerSecond: null })).toThrow(/burst requires/)
    expect(() => parseSecWafPolicy({ ...waf, deniedResponse: 404 })).toThrow()
    expect(() => parseSecWafPolicy({ ...waf, denyIps: ['198.51.100.1/24'] })).toThrow(/canonical/)
    expect(() => parseSecWafPolicy({ ...waf, denyIps: ['010.0.0.1'] })).toThrow()
    expect(() => parseSecWafPolicy({ ...waf, denyPaths: ['a"; return 200;'] })).toThrow()
    expect(() => parseSecWafPolicy({ ...waf, denyUserAgents: ['x', 'x'] })).toThrow(/distinct/)
  })
  it('validates flood limits, panel allowlists, cluster peers and site switches', () => {
    expect(parseSecFloodPolicy(flood)).toEqual(flood)
    expect(() => parseSecFloodPolicy({ ...flood, newConnectionsBurst: 0 })).toThrow()
    expect(() => parseSecFloodPolicy({ ...flood, newConnectionsPerSecond: null })).toThrow(/burst/)
    const access = { listeners: { xpanel: [], xwhm: [{ cidr: '203.0.113.7', note: 'root office' }, { cidr: '2001:db8:12::/48', note: '' }], xmail: [] } }
    expect(parseSecPanelAccessPolicy(access)).toEqual(access)
    expect(() => parseSecPanelAccessPolicy({ listeners: { xpanel: [], xwhm: [{ cidr: '0.0.0.0/0', note: '' }], xmail: [] } })).toThrow(/at least/)
    expect(() => parseSecPanelAccessPolicy({ listeners: { xpanel: [], xwhm: [] } })).toThrow()
    expect(secPanelAccessAdmits(access, 'xwhm', '203.0.113.7')).toBe(true)
    expect(secPanelAccessAdmits(access, 'xwhm', '2001:db8:12::5')).toBe(true)
    expect(secPanelAccessAdmits(access, 'xwhm', '203.0.113.8')).toBe(false)
    expect(secPanelAccessAdmits(access, 'xwhm', null)).toBe(false)
    expect(secPanelAccessAdmits(access, 'xpanel', null)).toBe(true)
    expect(parseSecDnsClusterConfig({ peers: [{ name: 'ns2.example.net', address: '198.51.100.53' }] }).peers).toHaveLength(1)
    for (const peer of [{ name: 'NS2.example.net', address: '198.51.100.53' }, { name: 'ns2', address: '198.51.100.53' }, { name: 'ns2.example.net', address: '127.0.0.1' }, { name: 'ns2.example.net', address: '2001:DB8::1' }]) expect(() => parseSecDnsClusterConfig({ peers: [peer] })).toThrow()
    expect(() => parseSecDnsClusterConfig({ peers: [{ name: 'a.example.net', address: '198.51.100.1' }, { name: 'b.example.net', address: '198.51.100.1' }] })).toThrow(/distinct/)
    expect(parseSecWafSites({ sites: { 'example.com': { accountId: ACCOUNT, modsecurity: false } } }).sites['example.com']!.modsecurity).toBe(false)
    expect(() => parseSecWafSites({ sites: { 'Example.com': { accountId: ACCOUNT, modsecurity: false } } })).toThrow()
  })
  it('accepts only canonical saved records and refuses invalid saved state instead of defaulting', () => {
    expect(readSecRecord('waf', record(waf))?.policy).toEqual(waf)
    expect(readSecRecord('waf', { ...record(waf), updatedAt: '2026-10-28T10:00:00Z' })).toBeNull()
    expect(readSecRecord('flood', record({ ...flood, enabled: 'yes' }))).toBeNull()
    expect(effectiveSecPolicy('flood', null)).toEqual(SEC_DEFAULTS.flood)
    expect(() => effectiveSecPolicy('flood', { bad: true })).toThrow(/invalid/)
    expect(secRevision('waf', null)).toMatch(/^[0-9a-f]{64}$/)
    expect(secRevision('waf', null)).not.toBe(secRevision('flood', null))
  })
  it('admits only the single reviewed nft listing', () => {
    expect(isSecHostCommand([...SEC_NFT_LIST_ARGV])).toBe(true)
    expect(isSecHostCommand(['/usr/sbin/nft', '--json', 'list', 'ruleset'])).toBe(false)
    expect(isSecHostCommand(['/usr/sbin/nft', '-f', '/tmp/x'])).toBe(false)
  })
})

describe('sec render integration', () => {
  const os = { paths: { nftablesConf: '/etc/nftables.conf' } }
  const ports = { panelPort: 7443, sshPort: 22, backendPort: 8080, backendTlsPort: 8444 }
  const rules = system.nftSettingsFromServer(ports, { banTimeoutSec: 3600 }), defaults = defaultFirewallRules(ports)
  it('renders the denied response and per-site limits into nginx WAF output', () => {
    const site = edge.renderWafSite('example.com', { rateLimit: { requests: 20, per: 'second', burst: 40, nodelay: true }, connLimit: 40, denyPaths: [] }, { defaultBodyMb: 128, modsecurityPresent: false, denyStatus: 444 })
    expect(site.server).toContain('if ($xpanel_waf_deny_ip) { return 444; }')
    expect(site.server.some(line => line.startsWith('limit_req zone=xpw_r_') && line.endsWith('burst=40 nodelay;'))).toBe(true)
    expect(site.server.some(line => line.startsWith('limit_conn xpw_c_') && line.endsWith(' 40;'))).toBe(true)
    expect(() => edge.renderWafSite('example.com', {}, { defaultBodyMb: 128, modsecurityPresent: false, denyStatus: 404 as never })).toThrow()
  })
  it('turns saved state into reconciler edge input; ModSecurity needs the Nginx connector and an engine file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sec-edge-')); dirs.push(root)
    await mkdir(join(root, 'extended', 'server'), { recursive: true })
    await writeFile(join(root, SEC_WAF_STATE), JSON.stringify(record({ ...waf, deniedResponse: 444, maxBodyMb: null })))
    await writeFile(join(root, SEC_FLOOD_STATE), JSON.stringify(record(flood)))
    await writeFile(join(root, SEC_WAF_SITES_STATE), JSON.stringify(record({ sites: { 'example.com': { accountId: ACCOUNT, modsecurity: false }, 'moved.example': { accountId: ACCOUNT, modsecurity: false } } })))
    const domains = [{ name: 'example.com', accountId: ACCOUNT }, { name: 'moved.example', accountId: '22222222-2222-4222-8222-222222222222' }]
    const without = await readSecEdgeConfiguration(root, { family: 'debian', domains, present: async () => false })
    expect(without.edge.modsecurity).toBeNull()
    expect(without.edge.clientMaxBodyMb).toBe('unlimited')
    expect(without.edge.waf.denyStatus).toBe(444)
    expect(without.sites['example.com']).toEqual({ rateLimit: { requests: 20, per: 'second', burst: 40, nodelay: true }, connLimit: 40, modsecurity: false })
    expect(without.sites['moved.example']!.modsecurity).toBeUndefined()
    expect(without.flood).toEqual({ connectionsPerAddress: 100, newPerSecond: 50, newBurst: 100, pingPerSecond: 10 })
    const withModule = await readSecEdgeConfiguration(root, { family: 'debian', domains, present: async path => path.endsWith('.so') || path === '/etc/modsecurity/modsecurity.conf' || path === '/usr/share/modsecurity-crs' })
    expect(withModule.edge.modsecurity).toEqual({ engineConf: '/etc/modsecurity/modsecurity.conf', crsDir: '/usr/share/modsecurity-crs' })
    const nft = system.renderNftables(defaults, { ...rules, flood: without.flood }, os as never).content
    expect(nft).toContain(`set ${system.FLOOD_SETS.conn4} {`)
    expect(nft).toContain('ct state new tcp dport { 80, 443 } add @xpanel_flood_conn4 { ip saddr ct count over 100 } drop comment "xpanel-flood: connections"')
    expect(nft).toContain('update @xpanel_flood_rate6 { ip6 saddr limit rate over 50/second burst 100 packets } drop')
    expect(nft).toContain('icmp type echo-request limit rate over 10/second burst 20 packets drop comment "xpanel-flood: ping"')
    expect(nft.indexOf('ct state established,related accept')).toBeLessThan(nft.indexOf('xpanel-flood: connections'))
    const off = system.renderNftables(defaults, { ...rules, flood: null }, os as never).content
    expect(off).not.toContain('xpanel-flood')
    await writeFile(join(root, SEC_FLOOD_STATE), '{"version":1')
    await expect(readSecEdgeConfiguration(root, { family: 'debian', domains, present: async () => false })).rejects.toThrow(/invalid/)
  })
})
