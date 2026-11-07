import { open, type FileHandle } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { suggestServerSettings, validateServerIpEntry } from '@xpanel/core'
import type { HostAction, ServerIpEntry } from '@xpanel/core'
import { createTestDb, type TestDbHandle } from '@xpanel/db'
import { profileFor } from '@xpanel/os'
import { createTestStateStore, type TestStateStoreHandle } from '@xpanel/state'
import { FakeHostExecutor } from './executor.ts'
import { IP_ALIASES_UNIT, IP_ALIASES_UNIT_PATH, isIpAliasCommand, parseManagedAliases, planIpAliases, releasableHolds } from './ip-aliases.ts'
import { compileDesiredGeneration, HostReconciler } from './reconciler.ts'
import type { ServerInterface } from './server-observation.ts'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const entry = (n: number, address: string, over: Partial<ServerIpEntry> = {}): ServerIpEntry => validateServerIpEntry({ id: id(n), address, prefixLength: 24, interfaceName: 'eth0', role: 'dedicated', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: false, notes: '', ...over })
const link = (name: string, addresses: [string, number][], loopback = false): ServerInterface => ({ name, operstate: 'UP', mtu: 1500, loopback,
  addresses: addresses.map(([address, prefixLength]) => ({ family: address.includes(':') ? 6 : 4, address, prefixLength, scope: 'global', dynamic: false })) })
const primary = entry(1, '203.0.113.10', { role: 'shared', isPrimary: true })
const execs = (actions: readonly HostAction[]): string[] => actions.flatMap(action => action.kind === 'exec' ? [action.argv.join(' ')] : [])

describe('IP alias grammar and plan', { tags: ['unit'] }, () => {
  it('admits only replace or del of one canonical address on a plain interface name', () => {
    expect(isIpAliasCommand(['/usr/sbin/ip', 'addr', 'replace', '203.0.113.20/24', 'dev', 'eth0'])).toBe(true)
    expect(isIpAliasCommand(['/usr/sbin/ip', 'addr', 'del', '2001:db8::5/128', 'dev', 'ens3'])).toBe(true)
    for (const argv of [['/usr/sbin/ip', 'addr', 'flush', '203.0.113.20/24', 'dev', 'eth0'], ['/usr/sbin/ip', 'addr', 'replace', '203.0.113.020/24', 'dev', 'eth0'],
      ['/usr/sbin/ip', 'addr', 'replace', '2001:DB8::5/128', 'dev', 'eth0'], ['/usr/sbin/ip', 'addr', 'replace', '203.0.113.20/33', 'dev', 'eth0'], ['/usr/sbin/ip', 'addr', 'replace', '203.0.113.20', 'dev', 'eth0'],
      ['/usr/sbin/ip', 'addr', 'replace', '203.0.113.20/24', 'dev', 'eth0;reboot'], ['/usr/sbin/ip', 'addr', 'replace', '203.0.113.20/24', 'dev', 'eth0', 'label', 'x'], ['/bin/ip', 'addr', 'replace', '203.0.113.20/24', 'dev', 'eth0']]) {
      expect(isIpAliasCommand(argv), argv.join(' ')).toBe(false)
    }
  })

  it('binds pool addresses the host lacks, never the default address, a host address or an unreported interface', () => {
    const pool = [primary, entry(2, '203.0.113.20'), entry(3, '203.0.113.30'), entry(4, '198.51.100.7', { interfaceName: 'eth9' }), entry(5, '2001:db8::5', { prefixLength: 64 })]
    const plan = planIpAliases(pool, [link('lo', [['127.0.0.1', 8]], true), link('eth0', [['203.0.113.10', 24], ['203.0.113.30', 24]])], [])
    expect(execs(plan.actions)).toEqual(['/usr/sbin/ip addr replace 203.0.113.20/24 dev eth0', '/usr/sbin/ip addr replace 2001:db8::5/64 dev eth0'])
    expect(plan.actions).toContainEqual({ kind: 'systemd', verb: 'enable', unit: IP_ALIASES_UNIT })
    expect(plan.skipped).toEqual([{ address: '203.0.113.30', reason: 'host_configured' }, { address: '198.51.100.7', reason: 'interface_unreported' }])
    expect(plan.file?.path).toBe(IP_ALIASES_UNIT_PATH)
    expect(parseManagedAliases(plan.file!.content)).toEqual([{ address: '2001:db8::5', prefixLength: 64, interfaceName: 'eth0' }, { address: '203.0.113.20', prefixLength: 24, interfaceName: 'eth0' }])
  })

  it('unbinds only an alias it added that left the pool, and changes nothing while the host is unobserved', () => {
    const managed = [{ address: '203.0.113.20', prefixLength: 24, interfaceName: 'eth0' }, { address: '203.0.113.10', prefixLength: 24, interfaceName: 'eth0' }]
    const host = [link('eth0', [['203.0.113.10', 24], ['203.0.113.20', 24], ['203.0.113.30', 24]])]
    const removed = planIpAliases([primary], host, managed)
    expect(execs(removed.actions)).toEqual(['/usr/sbin/ip addr del 203.0.113.20/24 dev eth0'])
    // A default address the unit once added stays bound by it.
    expect(parseManagedAliases(removed.file?.content ?? null)).toEqual([{ address: '203.0.113.10', prefixLength: 24, interfaceName: 'eth0' }])
    const dropped = planIpAliases([primary], host, managed.slice(0, 1))
    expect(execs(dropped.actions)).toEqual(['/usr/sbin/ip addr del 203.0.113.20/24 dev eth0'])
    expect(dropped.file).toBeNull()
    expect(planIpAliases([primary], [link('eth0', [['203.0.113.10', 24]])], managed.slice(0, 1)).actions).toEqual([])
    const blind = planIpAliases([primary, entry(2, '203.0.113.20')], null, managed.slice(0, 1))
    expect(execs(blind.actions)).toEqual([])
    expect(parseManagedAliases(blind.file!.content)).toEqual(managed.slice(0, 1))
  })

  it('clears a hold once the verified generation no longer serves the address and the new one is bound', () => {
    const held = entry(2, '203.0.113.20', { releasing: { accountId: id(40), since: '2026-11-06T10:00:00.000Z' } })
    const on = (ipv4: string, status = 'active') => ({ accounts: [{ id: id(40), ipv4, ipv6: null, status }] }) as never
    expect(releasableHolds([held], on('203.0.113.10'), new Set(['203.0.113.10']))).toEqual([{ id: held.id, since: held.releasing!.since }])
    expect(releasableHolds([held], on('203.0.113.30'), new Set(['203.0.113.10']))).toEqual([])
    expect(releasableHolds([held], on('203.0.113.20'), new Set(['203.0.113.20']))).toEqual([])
    expect(releasableHolds([held], on('203.0.113.20', 'terminating'), new Set())).toHaveLength(1)
    expect(releasableHolds([held], { accounts: [] } as never, new Set())).toHaveLength(1)
  })
})

/** ip(8) stand-in: `ip -j addr show` reports the modeled links and `ip addr replace|del` edits them. */
class AddressedExecutor extends FakeHostExecutor {
  links = new Map<string, [string, number][]>([['lo', [['127.0.0.1', 8]]], ['eth0', [['203.0.113.10', 24]]]])
  override async runCommand(argv: string[]) {
    if (argv.join(' ') === '/usr/sbin/ip -j addr show') {
      const json = [...this.links].map(([ifname, addrs]) => ({ ifname, operstate: ifname === 'lo' ? 'UNKNOWN' : 'UP', ...(ifname === 'lo' && { flags: ['LOOPBACK'] }),
        addr_info: addrs.map(([local, prefixlen]) => ({ family: local.includes(':') ? 'inet6' : 'inet', local, prefixlen, scope: ifname === 'lo' ? 'host' : 'global' })) }))
      return { ok: true, code: 0, stdout: JSON.stringify(json), stderr: '' }
    }
    return super.runCommand(argv)
  }
  override async runAction(action: HostAction): Promise<void> {
    await super.runAction(action)
    if (action.kind !== 'exec' || action.argv[0] !== '/usr/sbin/ip') return
    const [address, prefix] = action.argv[3]!.split('/'), dev = action.argv[5]!, current = this.links.get(dev) ?? []
    this.links.set(dev, action.argv[2] === 'replace' ? [...current.filter(([a]) => a !== address), [address!, Number(prefix)]] : current.filter(([a]) => a !== address))
  }
}

describe('IP aliases through the reconcile', { tags: ['feature'] }, () => {
  const os = profileFor('ID=ubuntu\nVERSION_ID="24.04"\n')
  const ARGON2 = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
  let state: TestStateStoreHandle
  let db: TestDbHandle
  let restoreFileSync = (): void => {}
  beforeAll(async () => {
    const probe = await open(fileURLToPath(import.meta.url), 'r')
    try {
      const sync = vi.spyOn(Object.getPrototypeOf(probe) as FileHandle, 'sync').mockResolvedValue(undefined)
      restoreFileSync = () => sync.mockRestore()
    } finally { await probe.close() }
  })
  afterAll(() => restoreFileSync())
  beforeEach(async () => {
    state = await createTestStateStore()
    db = await createTestDb()
    const suggested = suggestServerSettings({ cores: 2, memoryMb: 2048 })
    await state.store.saveServerSettings({ hostname: 'srv1.example.com', nameservers: ['ns1.example.com', 'ns2.example.com'], adminEmail: 'ops@example.com', engine: 'apache', apacheMpm: 'itk', panelPort: 2087, sshPort: 22, nginx: suggested.nginx, apache: suggested.apache, backendPort: 8080, backendTlsPort: 8443 })
    await state.store.saveServerIp({ address: '203.0.113.10', version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  })
  afterEach(async () => { await state.close(); await db.close() })

  it('publishes the NAT public address in DNS while the site listens on the local one', async () => {
    await state.store.saveServerIp({ address: '10.0.0.20', version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: false, notes: '' })
    const local = (await state.store.listServerIps()).find(ip => ip.address === '10.0.0.20')!
    await state.store.updateServerIp(local.id, { publicAddress: '198.51.100.20' })
    await state.store.saveDnsZone({ id: id(70), accountId: null, name: 'nat.example.test', serial: 2026110701, records: [{ id: id(71), zone: 'nat.example.test', name: '@', type: 'A', ttl: 300, content: '10.0.0.20', priority: null }] })
    const compiled = compileDesiredGeneration(await state.store.readSnapshot(), { os })
    const zone = compiled.files.find(file => file.path.endsWith('/nat.example.test.zone'))!
    expect(zone.content).toContain('198.51.100.20')
    expect(zone.content).not.toContain('10.0.0.20')
    expect((await state.store.listServerIps()).find(ip => ip.id === local.id)?.publicAddress).toBe('198.51.100.20')
  })

  it("binds a dedicated address, serves the site on it, and frees it after Change a Site's IP is verified", async () => {
    const dedicated = await state.store.saveServerIp({ address: '203.0.113.20', version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'dedicated', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: false, notes: '' })
    const feature = await state.store.createFeatureList({ name: 'IP', ownerId: null, disabled: [] })
    const plan = await state.store.createPlan({ name: 'IP', ownerId: null, featureListId: feature.id, resources: { diskMb: 1024, bandwidthMbMonth: 10240, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 10, ioWriteIops: 10, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
      caps: { addonDomains: 2, aliasDomains: 2, subdomains: 2, mailboxes: 2, forwarders: 2, mailingLists: 2, ftpAccounts: 2, databases: 2, phpWorkers: 2 }, dedicatedIp: true, shell: 'none', defaultMailboxQuotaMb: 128 })
    const php = { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 100, processIdleTimeoutSec: 10 }, ini: {} } as const
    const account = await state.store.createAccount({ username: 'dedi', primaryDomain: 'dedi.example.test', contactEmail: 'admin@dedi.example.test', planId: plan.id, ownerId: null, passwordHash: ARGON2, shell: 'none', php, ipv4: dedicated.address } as never)
    const executor = new AddressedExecutor()
    const reconciler = new HostReconciler({ store: state.store, db: db.db, executor, os })
    expect(await reconciler.reconcile({ actor: 'root', mailAuth: null })).toMatchObject({ status: 'applied' })
    expect(executor.links.get('eth0')).toEqual([['203.0.113.10', 24], ['203.0.113.20', 24]])
    expect(parseManagedAliases(executor.files.get(IP_ALIASES_UNIT_PATH)?.content ?? null)).toEqual([{ address: '203.0.113.20', prefixLength: 24, interfaceName: 'eth0' }])
    expect([...executor.files.values()].find(file => file.path.endsWith(`/xpanel-${account.username}.conf`) && file.path.includes('nginx'))?.content).toContain('listen 203.0.113.20:80 default_server;')
    expect(execs(executor.executedActions).filter(argv => argv.includes('203.0.113.10'))).toEqual([])

    await state.store.changeAccountIp(account.id, { ipv4: '203.0.113.10' })
    expect((await state.store.listServerIps()).find(ip => ip.id === dedicated.id)?.releasing?.accountId).toBe(account.id)
    expect(await reconciler.reconcile({ actor: 'root', mailAuth: null })).toMatchObject({ status: 'applied' })
    expect([...executor.files.values()].find(file => file.path.endsWith(`/xpanel-${account.username}.conf`) && file.path.includes('nginx'))?.content).toContain('listen 80;')
    expect((await state.store.listServerIps()).find(ip => ip.id === dedicated.id)?.releasing).toBeUndefined()
    // The alias stays bound while the address is in the pool; removing it unbinds only what the unit added.
    expect(await state.store.deleteServerIp(dedicated.id)).toBe(true)
    expect(await reconciler.reconcile({ actor: 'root', mailAuth: null })).toMatchObject({ status: 'applied' })
    expect(executor.links.get('eth0')).toEqual([['203.0.113.10', 24]])
    expect(executor.files.has(IP_ALIASES_UNIT_PATH)).toBe(false)
  })
})
