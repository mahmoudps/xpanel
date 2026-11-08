import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import { createTestStateStore, type TestStateStoreHandle } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { handleIpNetworkRoute, type IpNetworkHelpers } from './ip-network-workspace.ts'

const ARGON2 = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const root = { principal: { kind: 'root', id: '11111111-1111-4111-8111-111111111111', username: 'root' } } as unknown as AuthenticatedCaller
const reseller = { principal: { kind: 'reseller', id: '22222222-2222-4222-8222-222222222222', username: 'res1' } } as unknown as AuthenticatedCaller
const php = { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 100, processIdleTimeoutSec: 10 }, ini: {} } as const
const network = (addresses: [string, number][]) => ({ observedAt: '2026-11-06T10:00:00.000Z', hostname: { state: 'read', reason: null, value: 'srv1.example.test' }, resolvers: { state: 'read', reason: null, value: [], truncated: false },
  interfaces: { state: 'read', reason: null, truncated: false, items: [{ name: 'lo', operstate: 'UNKNOWN', mtu: 65536, loopback: true, addresses: [{ family: 4, address: '127.0.0.1', prefixLength: 8, scope: 'host', dynamic: false }] },
    { name: 'test0', operstate: 'UP', mtu: 1500, loopback: false, addresses: addresses.map(([address, prefixLength]) => ({ family: address.includes(':') ? 6 : 4, address, prefixLength, scope: 'global', dynamic: false })) }] },
  routes4: { state: 'read', reason: null, truncated: false, items: [] }, routes6: { state: 'read', reason: null, truncated: false, items: [] } })

const handles: TestStateStoreHandle[] = []
afterEach(async () => { for (const handle of handles.splice(0)) await handle.close() })
const fixture = async (caller = root, observed: [string, number][] | null = [['192.0.2.10', 24], ['192.0.2.11', 24]]) => {
  const h = await createTestStateStore(); handles.push(h)
  const feature = await h.store.createFeatureList({ name: 'IP', ownerId: null, disabled: [] })
  const plan = await h.store.createPlan({ name: 'IP', ownerId: null, featureListId: feature.id, resources: { diskMb: 1024, bandwidthMbMonth: 10240, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 10, ioWriteIops: 10, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 2, aliasDomains: 2, subdomains: 2, mailboxes: 2, forwarders: 2, mailingLists: 2, ftpAccounts: 2, databases: 2, phpWorkers: 2 }, dedicatedIp: true, shell: 'none', defaultMailboxQuotaMb: 128 })
  const shared = await h.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const dedicated = await h.store.saveServerIp({ address: '192.0.2.11', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'dedicated', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: false, notes: '' })
  const account = await h.store.createAccount({ username: 'siteone', primaryDomain: 'siteone.example.test', contactEmail: 'admin@siteone.example.test', planId: plan.id, ownerId: null, passwordHash: ARGON2, shell: 'none', php, ipv4: dedicated.address } as never)
  const audits: Record<string, unknown>[] = [], reconciles: unknown[] = []
  const helpers: IpNetworkHelpers = {
    requireCaller: vi.fn(async () => caller),
    assertRoot: vi.fn(async (c: AuthenticatedCaller) => { if (c.principal.kind !== 'root') fail('FORBIDDEN', 'root role is required for this operation') }),
    emitAudit: vi.fn(async (entry: Record<string, unknown>) => { audits.push(entry) }),
    resolveAccountParam: vi.fn(async (value: string) => (await h.store.getAccount(value)) ?? fail('NOT_FOUND', 'account not found')),
    store: h.store,
    reconcile: vi.fn(async () => { reconciles.push(1); return { body: { status: 'applied' } } }),
    ...(observed && { readNetwork: vi.fn(async () => network(observed)) }),
  }
  const call = async (method: string, path: string, body?: unknown) => {
    const url = new URL('http://localhost' + path)
    const response = await handleIpNetworkRoute(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), url, method, helpers)
    return { status: response?.status ?? null, body: response ? await response.json().catch(() => null) as Record<string, unknown> : null }
  }
  return { ...h, plan, shared, dedicated, account, audits, reconciles, call }
}
const statusOf = async (promise: Promise<unknown>): Promise<string> => { try { await promise; return 'ok' } catch (error) { return (error as { code?: string }).code ?? 'unknown' } }

describe('root IP tools', { tags: ['feature'] }, () => {
  it("changes a site's IP, reconciles and reports the held address", async () => {
    const f = await fixture()
    const moved = await f.call('POST', `/api/accounts/${f.account.id}/ip`, { ipv4: f.shared.address })
    expect(moved).toMatchObject({ status: 200, body: { account: { ipv4: f.shared.address }, held: [f.dedicated.address], reconcile: { status: 'applied' } } })
    expect(f.audits.at(-1)).toMatchObject({ action: 'account.ip.changed', target: 'account:siteone', detail: { held: [f.dedicated.address] } })
    const usage = await f.call('GET', '/api/ips/usage')
    expect(usage.body).toMatchObject({ observed: true })
    const rows = usage.body!.ips as { address: string; binding: string; releasing: unknown; accounts: unknown[] }[]
    expect(rows.find(row => row.address === f.dedicated.address)).toMatchObject({ binding: 'configured', releasing: { accountId: f.account.id }, accounts: [] })
    expect(rows.find(row => row.address === f.shared.address)?.accounts).toEqual([{ id: f.account.id, username: 'siteone', field: 'ipv4' }])
  })

  it('edits reservation and reverse DNS, and refuses unknown fields and non-root callers', async () => {
    const f = await fixture()
    expect(await f.call('PATCH', `/api/ips/${f.dedicated.id}`, { reserved: true, ptrHostname: 'host.example.test' })).toMatchObject({ status: 200, body: { ip: { reserved: true, ptrHostname: 'host.example.test' } } })
    expect(await statusOf(f.call('PATCH', `/api/ips/${f.dedicated.id}`, { role: 'shared' }))).toBe('VALIDATION')
    const other = await fixture(reseller)
    expect(await statusOf(other.call('PATCH', `/api/ips/${other.dedicated.id}`, { reserved: true }))).toBe('FORBIDDEN')
    expect(await statusOf(other.call('POST', `/api/accounts/${other.account.id}/ip`, { ipv4: other.shared.address }))).toBe('FORBIDDEN')
    expect((await other.store.getAccount(other.account.id))?.ipv4).toBe(other.dedicated.address)
  })

  it('migrates addresses and rebuilds the pool from the host report only', async () => {
    const f = await fixture(root, [['192.0.2.10', 24], ['192.0.2.11', 24], ['192.0.2.40', 24], ['fe80::1', 64]])
    const rebuilt = await f.call('POST', '/api/ips/rebuild', {})
    expect((rebuilt.body!.added as { address: string }[]).map(ip => ip.address)).toEqual(['192.0.2.40'])
    const migrated = await f.call('POST', '/api/ips/migrate', { mappings: [{ from: f.dedicated.address, to: '192.0.2.40' }] })
    expect(migrated).toMatchObject({ status: 200, body: { moved: [{ from: f.dedicated.address, to: '192.0.2.40' }], held: [f.dedicated.address] } })
    expect((await f.store.getAccount(f.account.id))?.ipv4).toBe('192.0.2.40')
    const blind = await fixture(root, null)
    expect(await statusOf(blind.call('POST', '/api/ips/rebuild', {}))).toBe('PRECONDITION_FAILED')
    expect((await blind.call('GET', '/api/ips/usage')).body).toMatchObject({ observed: false, ips: expect.arrayContaining([expect.objectContaining({ binding: 'unverified' })]) })
  })

  it('moves several sites in one request and names the account a refusal stopped at', async () => {
    const f = await fixture()
    const moved = await f.call('POST', '/api/ips/change-many', { changes: [{ accountId: f.account.id, ipv4: f.shared.address }] })
    expect(moved).toMatchObject({ status: 200, body: { results: [{ accountId: f.account.id, held: [f.dedicated.address] }], reconcile: { status: 'applied' } } })
    expect(f.audits.at(-1)).toMatchObject({ action: 'ip.sites_changed' })
    expect(await statusOf(f.call('POST', '/api/ips/change-many', { changes: [] }))).toBe('VALIDATION')
  })
  it('saves IPv6 ranges and assigns the next address to an account', async () => {
    const f = await fixture()
    const range = { id: randomUUID(), cidr: '2001:db8:0:5::/64', ownerKind: 'root', ownerId: null, notes: '' }
    expect(await f.call('PUT', '/api/ips/ranges', { ranges: [range] })).toMatchObject({ status: 200, body: { ranges: [range] } })
    expect(await f.call('POST', `/api/accounts/${f.account.id}/ipv6`, { rangeId: range.id })).toMatchObject({ status: 200, body: { ip: { address: '2001:db8:0:5::1' }, account: { ipv6: '2001:db8:0:5::1' } } })
    expect(await statusOf(f.call('POST', `/api/accounts/${f.account.id}/ipv6`, { rangeId: 'nope' }))).toBe('VALIDATION')
    expect(await f.call('GET', '/api/ips/ranges')).toMatchObject({ body: { ranges: [range] } })
  })
})
