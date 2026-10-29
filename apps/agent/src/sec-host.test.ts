import { describe, expect, it, vi } from 'vitest'
import { renderTrustedProxyRealIp } from '../../../packages/core/src/trusted-proxies.ts'
import { applyTrustedProxyPolicy, observeTrustedProxies } from './trusted-proxies.ts'
import { applySecDnsCluster, observeSecDnsCluster, parseSecPdnsSettings, renderSecDnsClusterDropIn, verifySecDnsPeer } from './sec-dns-cluster.ts'
import type { SecSoaAnswer } from './sec-dns-cluster.ts'
import { observeSecFlood, parseSecNftFlood } from './sec-flood.ts'
import { createSecIngressProvider, SEC_INGRESS_ACTIVE, SEC_INGRESS_EVIDENCE, secIngressRenderAuthority } from './sec-ingress-provider.ts'
import type { SecIngressPorts } from './sec-ingress-provider.ts'
import { observeSecWaf, parseCrsVersion, parseRuleEngine } from './sec-waf.ts'

const now = () => new Date('2026-10-28T12:00:00.000Z')
const ok = (stdout: string) => ({ ok: true, code: 0, stdout, stderr: '' })

describe('sec WAF observation', () => {
  it('reports the connector, engine mode, CRS release and live activation separately', async () => {
    const files: Record<string, string> = { '/etc/modsecurity/modsecurity.conf': 'SecRuleEngine DetectionOnly\n# SecRuleEngine Off\nSecRuleEngine On\n', '/usr/share/modsecurity-crs/rules/REQUEST-901-INITIALIZATION.conf': '# ------\n# OWASP CRS ver.4.7.0\n' }
    const view = await observeSecWaf({ family: 'debian', now, readNginxMain: async () => 'http {\n# xPanel WAF: server-wide lists\nmodsecurity on;\n}', present: async path => path in files || path === '/usr/lib/nginx/modules/ngx_http_modsecurity_module.so' || path === '/usr/share/modsecurity-crs', readText: async path => files[path] ?? null })
    expect(view).toEqual({ observedAt: now().toISOString(), family: 'debian', connector: { nginx: true, apache: false }, engineConf: { path: '/etc/modsecurity/modsecurity.conf', ruleEngine: 'On' }, crs: { dir: '/usr/share/modsecurity-crs', version: '4.7.0' }, active: { lists: true, modsecurity: true } })
    const missing = await observeSecWaf({ family: 'rhel', now, readNginxMain: async () => { throw new Error('denied') }, present: async () => false, readText: async () => null })
    expect(missing.active).toEqual({ lists: null, modsecurity: null })
    expect(missing.crs).toEqual({ dir: null, version: null })
    expect((await observeSecWaf({ family: 'arch', readNginxMain: async () => '', present: async () => true })).connector).toEqual({ nginx: null, apache: null })
    expect(parseRuleEngine('SecRuleEngine Maybe')).toBeNull()
    expect(parseCrsVersion('# OWASP ModSecurity Core Rule Set ver.3.3.4\n')).toBe('3.3.4')
  })
})

describe('sec flood observation', () => {
  const doc = { nftables: [{ metainfo: { json_schema_version: 1 } }, { table: { family: 'inet', name: 'xpanel', handle: 1 } }, { set: { family: 'inet', name: 'xpanel_flood_conn4', table: 'xpanel', type: 'ipv4_addr', handle: 3, flags: ['dynamic'], elem: ['192.0.2.1', '192.0.2.2'] } },
    { set: { family: 'inet', name: 'xpanel_banned', table: 'xpanel', type: 'ipv4_addr', handle: 2 } }, { rule: { family: 'inet', table: 'xpanel', chain: 'input', handle: 9, comment: 'xpanel-flood: connections', expr: [] } }, { rule: { family: 'inet', table: 'xpanel', chain: 'input', handle: 10, comment: 'xpanel-flood: ping', expr: [] } }] }
  it('counts our commented rules and tracked sources from the libnftables JSON listing', () => {
    expect(parseSecNftFlood(JSON.stringify(doc))).toEqual({ rules: { connections: 1, rate: 0, ping: 1 }, tracked: [{ set: 'xpanel_flood_conn4', elements: 2 }] })
    expect(parseSecNftFlood('{"nftables":[{"rule":{"table":"xpanel","comment":"xpanel-flood: other"}}]}')).toBeNull()
    expect(parseSecNftFlood('not json')).toBeNull()
  })
  it('distinguishes not installed, not applied, failed and malformed listings', async () => {
    expect((await observeSecFlood({ run: async () => ok(JSON.stringify(doc)), present: async () => true, now })).state).toBe('read')
    expect((await observeSecFlood({ run: vi.fn(), present: async () => false, now })).state).toBe('not_installed')
    expect((await observeSecFlood({ run: async () => ({ ok: false, code: 1, stdout: '', stderr: 'Error: No such file or directory; did you mean table ...' }), present: async () => true, now })).state).toBe('not_applied')
    expect(await observeSecFlood({ run: async () => ({ ok: false, code: 1, stdout: '', stderr: 'Operation not permitted' }), present: async () => true, now })).toMatchObject({ state: 'unavailable', reason: 'command_failed' })
    expect(await observeSecFlood({ run: async () => ok('{"x":1}'), present: async () => true, now })).toMatchObject({ state: 'unavailable', reason: 'malformed_output' })
  })
})

describe('sec DNS cluster', () => {
  const peers = [{ name: 'ns2.example.net', address: '198.51.100.53' }]
  const conf = (extra = '') => ({ '/etc/powerdns/pdns.conf': 'launch=bind\nbind-config=/etc/powerdns/named.conf\ninclude-dir=/etc/powerdns/pdns.d\n' + extra })
  it('reads effective PowerDNS settings with include-dir order and documented defaults', async () => {
    expect(parseSecPdnsSettings(['a=1\n# a=2\n', 'a = 3 # note']).get('a')).toBe('3')
    const files: Record<string, string> = { ...conf(), '/etc/powerdns/pdns.d/xpanel-cluster.conf': renderSecDnsClusterDropIn(peers) }
    const view = await observeSecDnsCluster({ family: 'debian', peers, now, readText: async path => files[path] ?? null, listDir: async () => ['xpanel-cluster.conf', 'notes.txt'] })
    expect(view).toMatchObject({ state: 'read', application: 'applied', peers: [{ name: 'ns2.example.net', transferAllowed: true, notified: true }] })
    expect(view.settings).toMatchObject({ launch: 'bind', primary: true, allowAxfrIps: ['127.0.0.0/8', '::1', '198.51.100.53'] })
    const drift = await observeSecDnsCluster({ family: 'debian', peers, readText: async path => conf()[path as keyof ReturnType<typeof conf>] ?? null, listDir: async () => [] })
    expect(drift.application).toBe('drift')
    expect(drift.settings!.allowAxfrIps).toEqual(['127.0.0.0/8', '::1'])
    expect((await observeSecDnsCluster({ family: 'debian', peers: [], readText: async path => conf()[path as keyof ReturnType<typeof conf>] ?? null, listDir: async () => [] })).application).toBe('single_node')
    expect((await observeSecDnsCluster({ family: 'debian', peers, readText: async () => null })).state).toBe('not_installed')
  })
  it('compares published and peer serials with RFC 1982 arithmetic and reports unreachable peers', async () => {
    const answers: Record<string, SecSoaAnswer> = { '127.0.0.1 a.test': { serial: 2026102801 }, '198.51.100.53 a.test': { serial: 2026102801 }, '127.0.0.1 b.test': { serial: 5 }, '198.51.100.53 b.test': { serial: 4294967295 },
      '127.0.0.1 c.test': { serial: 9 }, '198.51.100.53 c.test': { error: 'refused' }, '127.0.0.1 d.test': { error: 'failed' }, '198.51.100.53 d.test': { serial: 1 } }
    const result = await verifySecDnsPeer({ peer: peers[0]!, zones: ['d.test', 'a.test', 'b.test', 'c.test', 'a.test'], now, query: async (server, zone) => answers[server + ' ' + zone] ?? { error: 'unreachable' } })
    expect(result.zones.map(row => row.state)).toEqual(['in_sync', 'behind', 'refused', 'local_unavailable'])
    expect(result.counts).toMatchObject({ in_sync: 1, behind: 1, refused: 1, local_unavailable: 1 })
    expect(result.truncated).toBe(false)
  })
  it('applies only the drop-in in the include-dir, proves the effect and restores on failure', async () => {
    const files: Record<string, string> = { ...conf() }
    const actions: unknown[] = []
    const ports = (probe: boolean | (() => Promise<boolean>)) => ({ family: 'debian', powerdnsUnit: 'pdns', readText: async (path: string) => files[path] ?? null, listDir: async () => Object.keys(files).filter(path => path.startsWith('/etc/powerdns/pdns.d/')).map(path => path.split('/').pop()!),
      writeFile: async (file: { path: string; content: string }) => { files[file.path] = file.content }, removePath: async (path: string) => { delete files[path] }, runAction: async (action: unknown) => { actions.push(action) }, probe: typeof probe === 'function' ? probe : async () => probe, authorize: async () => {} })
    const applied = await applySecDnsCluster(peers, ports(true))
    expect(applied.outcome).toBe('applied')
    expect(files['/etc/powerdns/pdns.d/xpanel-cluster.conf']).toContain('also-notify=198.51.100.53')
    expect(actions).toEqual([{ kind: 'systemd', verb: 'restart', unit: 'pdns' }])
    expect((await applySecDnsCluster(peers, ports(true))).outcome).toBe('unchanged')
    await expect(applySecDnsCluster([...peers, { name: 'ns3.example.net', address: '198.51.100.54' }], ports(vi.fn(async () => true).mockResolvedValueOnce(false)))).rejects.toMatchObject({ detail: { rolledBack: true, stateChanged: false } })
    expect(files['/etc/powerdns/pdns.d/xpanel-cluster.conf']).toBe(renderSecDnsClusterDropIn(peers))
    const noInclude = { ...ports(true), readText: async (path: string) => path === '/etc/powerdns/pdns.conf' ? 'launch=bind\n' : null }
    await expect(applySecDnsCluster(peers, noInclude)).rejects.toMatchObject({ detail: { reason: 'include_dir_missing', stateChanged: false } })
  })
})

describe('protected ingress provider', () => {
  const policy = { cidrs: ['173.245.48.0/20'], header: 'X-Forwarded-For' as const }
  const build = (overrides: Partial<SecIngressPorts> = {}) => {
    const files = new Map<string, { text: string; uid: number; mode: number }>([[SEC_INGRESS_EVIDENCE, { text: JSON.stringify({ kind: 'protected-dedicated-ingress-v1', dedicatedCidrs: ['173.245.48.0/20'] }), uid: 0, mode: 0o100600 }]])
    const state = { main: 'http {\n' + renderTrustedProxyRealIp({ cidrs: [], header: 'X-Forwarded-For' }) + '}\n', reloads: 0 }
    const ports: SecIngressPorts = {
      readProtected: async path => files.get(path) ?? null, writeProtected: async (path, text) => { files.set(path, { text, uid: 0, mode: 0o100600 }) }, removeProtected: async path => { files.delete(path) },
      readNginxMain: async () => state.main, writeNginxMain: async content => { state.main = content },
      renderNginxMain: async authority => 'http {\n' + (authority ? renderTrustedProxyRealIp(policy) : renderTrustedProxyRealIp({ cidrs: [], header: 'X-Forwarded-For' })) + '}\n',
      testNginx: async () => true, reloadNginx: async () => { state.reloads++ }, probeManagement: async () => true, localAddresses: () => ['203.0.113.10', '127.0.0.1'], managementClient: () => '198.51.100.7', ...overrides,
    }
    return { files, state, ports, provider: createSecIngressProvider(ports, now) }
  }
  it('observes only what the live nginx.conf carries and activates through the core apply contract', async () => {
    const { files, state, ports, provider } = build()
    const before = await observeTrustedProxies(provider)
    expect(before).toMatchObject({ state: 'read', activation: 'available', active: { policy: { cidrs: [] } } })
    const after = await applyTrustedProxyPolicy(policy, before.active!.revision, provider, async () => {})
    expect(after.policy).toEqual(policy)
    expect(state.main).toContain('set_real_ip_from 173.245.48.0/20;')
    expect(JSON.parse(files.get(SEC_INGRESS_ACTIVE)!.text)).toMatchObject({ managementClient: '198.51.100.7', active: { policy } })
    expect(state.reloads).toBe(1)
    expect(await secIngressRenderAuthority(ports)).toBeDefined()
    state.main = 'http {}\n'
    expect((await observeTrustedProxies(provider)).state).toBe('unavailable')
  })
  it('refuses unprotected evidence, undeclared networks and the current management client', async () => {
    const loose = build(); loose.files.set(SEC_INGRESS_EVIDENCE, { ...loose.files.get(SEC_INGRESS_EVIDENCE)!, mode: 0o100666 })
    expect((await observeTrustedProxies(loose.provider)).reason).toBe('protected_native_provider_unverified')
    const { provider } = build({ managementClient: () => '173.245.48.9' })
    await expect(applyTrustedProxyPolicy(policy, (await build().provider.observe()).revision, provider, async () => {})).rejects.toThrow(/management client/)
    const other = build()
    await expect(applyTrustedProxyPolicy({ cidrs: ['104.16.0.0/16'], header: 'X-Forwarded-For' }, (await other.provider.observe()).revision, other.provider, async () => {})).rejects.toThrow(/not admitted/)
  })
  it('restores the captured configuration when the reloaded listener cannot be verified', async () => {
    const { files, state, provider } = build({ probeManagement: vi.fn(async () => true).mockResolvedValueOnce(true).mockResolvedValue(false) as () => Promise<boolean> })
    const before = await provider.observe(), original = state.main
    await expect(applyTrustedProxyPolicy(policy, before.revision, provider, async () => {})).rejects.toMatchObject({ detail: { attempted: true } })
    expect(state.main).toBe(original)
    expect(files.has(SEC_INGRESS_ACTIVE)).toBe(false)
  })
})
