import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { fail } from '@xpanel/core'
import { services } from '@xpanel/render'
import { createTestStateStore } from '@xpanel/state'
import type { TestStateStoreHandle } from '@xpanel/state'
import { DNS_CLUSTER_RUNTIME, DNS_CLUSTER_STATE, dnsClusterTokenHash } from '../../agent/src/dns-cluster-model.ts'
import { handleDnsClusterHostRoute } from '../../agent/src/dns-cluster-routes.ts'
import { createDnsClusterSync, readDnsClusterRuntime } from '../../agent/src/dns-cluster-sync.ts'
import type { DnsClusterSync, DnsClusterSyncDeps } from '../../agent/src/dns-cluster-sync.ts'
import { DnsClusterTransportError } from '../../agent/src/dns-cluster-transport.ts'
import type { DnsClusterCall } from '../../agent/src/dns-cluster-transport.ts'
import type { AuthenticatedCaller } from './auth.ts'
import { handleDnsClusterPeerRoute } from './dns-cluster-peer.ts'

const ROOT_ID = '11111111-1111-4111-8111-111111111111'
const ROOT = { principal: { kind: 'root', id: ROOT_ID, username: 'root' }, sessionId: null, apiTokenId: null, scopes: [], principalRecord: {} } as unknown as AuthenticatedCaller
const NOW = '2026-11-07T12:00:00.000Z'
const TOKEN_A = 'xpdc_' + 'a'.repeat(43), TOKEN_B = 'xpdc_' + 'b'.repeat(43)
const A_NAME = 'ns1.alpha.test', B_NAME = 'ns2.beta.test', A_IP = '192.0.2.1', B_IP = '192.0.2.2'
const member = (name: string, address: string, token: string, role: string) => ({ name, address, port: 2087, pin: 'a'.repeat(64), token, role, createdAt: NOW })
const inbound = (name: string, address: string, token: string) => ({ name, address, tokenHash: dnsClusterTokenHash(token), hint: token.slice(-4), issuedBy: ROOT_ID, createdAt: NOW })
const rendered = (zone: string, serial: number, address: string): string => services.renderBindZone([
  { zone, name: '@', type: 'SOA', ttl: 3600, content: `ns1.alpha.test. hostmaster.${zone}. ${serial} 3600 1800 1209600 3600`, priority: null },
  { zone, name: '@', type: 'A', ttl: 300, content: address, priority: null },
])
const saveConfig = async (server: { handle: TestStateStoreHandle }, value: unknown): Promise<void> => { await mkdir(join(server.handle.rootDir, 'extended/dns'), { recursive: true }); await writeFile(join(server.handle.rootDir, DNS_CLUSTER_STATE), JSON.stringify(value)) }
const config = (over: Record<string, unknown> = {}) => ({ version: 1, enabled: true, failureThreshold: 10, members: [], inbound: [], updatedAt: null, ...over })

interface Server { handle: TestStateStoreHandle; files: Map<string, string>; reconcile: Mock<() => void>; audit: Mock<(entry: unknown) => Promise<unknown>>; address: string; down: boolean; calls: string[]; signed: Map<string, boolean | null>; stamp: number; sync: DnsClusterSync; soa: Map<string, number> }
let a: Server, b: Server
const peerRoute = (server: Server, request: Request) => handleDnsClusterPeerRoute(request, new URL(request.url), request.method, {
  store: server.handle.store, clientAddress: req => req.headers.get('x-test-client'), issuer: async id => id === ROOT_ID ? ROOT : fail('FORBIDDEN', 'inactive'),
  callHost: async (_caller, path) => {
    const response = await handleDnsClusterHostRoute(new Request('http://agent.test' + path), new URL('http://agent.test' + path), 'GET', { assertRoot: async () => ({ actor: 'root' }), rootDir: server.handle.rootDir, sync: server.sync, store: server.handle.store, zoneDir: join(server.handle.rootDir, 'zone-files'), signedZone: async zone => server.signed.get(zone) ?? false })
    return response!.json()
  },
  reconcile: async () => { server.reconcile(); for (const zone of await server.handle.store.listDnsZones()) server.soa.set(zone.name, zone.serial); return { ok: true } },
  audit: async entry => server.audit(entry), now: () => new Date(NOW),
})
/** A loopback member: the real peer handler, reached without sockets; `down` fails like a dead host. */
const loopback = (from: Server): DnsClusterCall => async (endpoint, request) => {
  const target = endpoint.name === B_NAME ? b : a
  target.calls.push(`${request.method} ${request.path}`)
  if (target.down) throw new DnsClusterTransportError('unreachable')
  const response = await peerRoute(target, new Request('https://peer.test' + request.path, { method: request.method, headers: { authorization: 'Bearer ' + endpoint.token, 'x-test-client': from.address }, ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) }))
  return { status: response.status, body: await response.json() }
}
async function server(address: string): Promise<Server> {
  const handle = await createTestStateStore()
  await mkdir(join(handle.rootDir, 'zone-files'), { recursive: true })
  const value: Server = { handle, files: new Map(), reconcile: vi.fn<() => void>(), audit: vi.fn<(entry: unknown) => Promise<unknown>>(async () => undefined), address, down: false, calls: [], signed: new Map(), stamp: 1, soa: new Map(), sync: null as unknown as DnsClusterSync }
  const deps: DnsClusterSyncDeps = { rootDir: handle.rootDir, store: handle.store, readZoneFile: async zone => value.files.get(zone) ?? null, zoneStamp: async () => value.stamp, signedZone: async zone => value.signed.has(zone) ? value.signed.get(zone)! : false,
    reconcile: async () => { value.reconcile(); return true }, audit: entry => value.audit(entry), call: (endpoint, request) => loopback(value)(endpoint, request), querySoa: async (_server, zone) => { const serial = (address === A_IP ? b : a).soa.get(zone); return serial ? { serial } : { error: 'not_served' } }, now: () => clock }
  value.sync = createDnsClusterSync(deps)
  return value
}
let clock = new Date(NOW)
const publish = async (server: Server, zone: string, serial: number, address: string): Promise<void> => {
  const existing = await server.handle.store.getDnsZone(zone)
  await server.handle.store.saveDnsZone({ id: existing?.id ?? crypto.randomUUID(), accountId: null, name: zone, serial, records: [{ id: crypto.randomUUID(), zone, name: '@', type: 'A', ttl: 300, content: address, priority: null }] })
  server.files.set(zone, rendered(zone, serial, address)); server.stamp += 1
  await writeFile(join(server.handle.rootDir, 'zone-files', zone + '.zone'), rendered(zone, serial, address))
}
const runtimeOf = async (server: Server, name: string) => (await readDnsClusterRuntime(server.handle.rootDir)).members[name]!
const pushAll = { mode: 'push' as const, zone: null, member: null, includeMissing: false, force: false }

beforeEach(async () => {
  clock = new Date(NOW)
  a = await server(A_IP); b = await server(B_IP)
  await saveConfig(a, config({ members: [member(B_NAME, B_IP, TOKEN_B, 'synchronize')], inbound: [inbound(B_NAME, B_IP, TOKEN_A)] }))
  await saveConfig(b, config({ members: [member(A_NAME, A_IP, TOKEN_A, 'synchronize')], inbound: [inbound(A_NAME, A_IP, TOKEN_B)] }))
})
afterEach(async () => { await a.handle.close(); await b.handle.close() })

describe('dns cluster with a loopback member', () => {
  it('copies a zone with its serial, reloads once and stays idle until the next change', async () => {
    await publish(a, 'one.test', 2026110701, '192.0.2.10'); await publish(a, 'two.test', 2026110702, '192.0.2.11')
    await a.sync.tick()
    const copy = await b.handle.store.getDnsZone('one.test')
    expect(copy).toMatchObject({ accountId: null, serial: 2026110701, records: [{ name: '@', type: 'A', content: '192.0.2.10' }], replica: { peer: A_NAME } })
    expect(b.reconcile).toHaveBeenCalledTimes(1)
    expect(await runtimeOf(a, B_NAME)).toMatchObject({ state: 'online', failures: 0, zones: { 'one.test': { state: 'synced', serial: 2026110701 } } })
    b.calls.length = 0
    await a.sync.tick()
    expect(b.calls).toEqual([])
    await publish(a, 'one.test', 2026110703, '192.0.2.20')
    await a.sync.tick()
    expect(b.calls).toEqual(['PUT /api/cluster/dns/zones/one.test', 'POST /api/cluster/dns/commit'])
    expect(await b.handle.store.getDnsZone('one.test')).toMatchObject({ serial: 2026110703, records: [{ content: '192.0.2.20' }] })
  })

  it('makes one zone answer the same serial on every member when pushed to all servers', async () => {
    await publish(a, 'one.test', 2026110705, '192.0.2.10')
    const result = await a.sync.run({ ...pushAll, zone: 'one.test' })
    expect(result.members).toMatchObject([{ member: B_NAME, written: 1, verified: { zone: 'one.test', serial: 2026110705, inSync: true } }])
  })

  it('catches a new member up without waiting for a zone change, and forgets a removed one', async () => {
    await publish(a, 'one.test', 5, '192.0.2.10')
    await saveConfig(a, config({ inbound: [] }))
    await a.sync.tick()
    expect(b.calls).toEqual([])
    await saveConfig(a, config({ members: [member(B_NAME, B_IP, TOKEN_B, 'synchronize')] }))
    await a.sync.tick()
    expect(await b.handle.store.getDnsZone('one.test')).toMatchObject({ serial: 5 })
    await saveConfig(a, config({ members: [member('ns3.gamma.test', '192.0.2.3', TOKEN_B, 'standalone'), member('ns4.delta.test', '192.0.2.4', TOKEN_B, 'standalone')] }))
    await a.sync.run(pushAll)
    expect((await readDnsClusterRuntime(a.handle.rootDir)).members[B_NAME]).toBeUndefined()
  })

  it('never sends a copy on, so a zone cannot loop between members', async () => {
    await publish(a, 'one.test', 5, '192.0.2.10')
    await a.sync.tick()
    b.stamp += 1; a.calls.length = 0
    await b.sync.tick()
    expect(a.calls.filter(call => call.startsWith('PUT'))).toEqual([])
  })

  it('removes the copy when the source zone goes, and only then', async () => {
    await publish(a, 'one.test', 5, '192.0.2.10')
    await a.sync.tick()
    a.files.delete('one.test'); a.stamp += 1
    await a.sync.tick()
    expect(await b.handle.store.getDnsZone('one.test')).not.toBeNull()
    await a.handle.store.deleteDnsZone('one.test'); a.stamp += 1
    await a.sync.tick()
    expect(await b.handle.store.getDnsZone('one.test')).toBeNull()
    expect((await runtimeOf(a, B_NAME)).zones).toEqual({})
  })

  it('refuses an account zone on the member, even when forced', async () => {
    await b.handle.store.saveDnsZone({ id: crypto.randomUUID(), accountId: null, name: 'one.test', serial: 3, records: [] })
    await publish(a, 'one.test', 5, '192.0.2.10')
    const result = await a.sync.run(pushAll)
    expect(result.members[0]).toMatchObject({ written: 0, conflicts: [{ zone: 'one.test', reason: 'owned_locally' }] })
    expect((await a.sync.run({ ...pushAll, zone: 'one.test', member: B_NAME, force: true })).members[0]).toMatchObject({ written: 0, conflicts: [{ reason: 'owned_locally' }] })
    expect(await b.handle.store.getDnsZone('one.test')).toMatchObject({ serial: 3, records: [] })
    expect(b.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'dns.cluster.copy_refused', actor: 'cluster:' + A_NAME }))
  })

  it('reports a copy edited on the member, stops retrying it, and overwrites it on request', async () => {
    await publish(a, 'one.test', 5, '192.0.2.10')
    await a.sync.tick()
    const copy = (await b.handle.store.getDnsZone('one.test'))!
    await b.handle.store.saveDnsZone({ ...copy, records: [{ ...copy.records[0]!, content: '192.0.2.99' }] })
    await publish(a, 'one.test', 6, '192.0.2.20')
    await a.sync.tick()
    expect((await runtimeOf(a, B_NAME)).zones['one.test']).toMatchObject({ state: 'conflict', reason: 'modified_here' })
    a.stamp += 1; b.calls.length = 0
    await a.sync.tick()
    expect(b.calls).toEqual([])
    expect((await a.sync.run({ ...pushAll, zone: 'one.test', member: B_NAME, force: true })).members[0]).toMatchObject({ written: 1, conflicts: [] })
    expect(await b.handle.store.getDnsZone('one.test')).toMatchObject({ serial: 6, records: [{ content: '192.0.2.20' }] })
    expect((await runtimeOf(a, B_NAME)).zones['one.test']).toMatchObject({ state: 'synced' })
  })

  it('reports a copy that a third server holds', async () => {
    await publish(a, 'one.test', 5, '192.0.2.10')
    await b.handle.store.saveDnsZone({ id: crypto.randomUUID(), accountId: null, name: 'one.test', serial: 9, records: [], replica: { peer: 'ns9.gamma.test', digest: 'e'.repeat(64), at: NOW } })
    expect((await a.sync.run(pushAll)).members[0]).toMatchObject({ conflicts: [{ zone: 'one.test', reason: 'other_origin' }] })
  })

  it('counts an outage, backs off, disables at the threshold with a failed audit row, and catches up after re-enable', async () => {
    await saveConfig(a, config({ failureThreshold: 3, members: [member(B_NAME, B_IP, TOKEN_B, 'synchronize')] }))
    await publish(a, 'one.test', 5, '192.0.2.10')
    b.down = true
    await a.sync.tick()
    expect(await runtimeOf(a, B_NAME)).toMatchObject({ state: 'outage', failures: 1, failureCode: 'unreachable', outageSince: NOW, pending: true, nextAttemptAt: '2026-11-07T12:01:00.000Z' })
    b.calls.length = 0
    await a.sync.tick()
    expect(b.calls).toEqual([])
    clock = new Date('2026-11-07T12:01:00.000Z')
    await a.sync.tick()
    expect(await runtimeOf(a, B_NAME)).toMatchObject({ failures: 2, nextAttemptAt: '2026-11-07T12:03:00.000Z' })
    expect(a.audit).not.toHaveBeenCalled()
    clock = new Date('2026-11-07T12:03:00.000Z')
    await a.sync.tick()
    expect(await runtimeOf(a, B_NAME)).toMatchObject({ state: 'auto_disabled', failures: 3, nextAttemptAt: null })
    expect(a.audit).toHaveBeenCalledTimes(1)
    expect(a.audit).toHaveBeenCalledWith({ action: 'dns.cluster.member_disabled', target: 'dns-member:' + B_NAME, outcome: 'failed', detail: { failures: 3, failure: 'unreachable' } })
    b.calls.length = 0; clock = new Date('2026-11-08T12:00:00.000Z')
    await a.sync.tick()
    expect(b.calls).toEqual([])
    expect((await a.sync.run(pushAll)).members[0]).toMatchObject({ skipped: 'auto_disabled' })
    b.down = false
    expect(await a.sync.reset(B_NAME)).toBe(true)
    await a.sync.tick()
    expect(await runtimeOf(a, B_NAME)).toMatchObject({ state: 'online', failures: 0, outageSince: null })
    expect(await b.handle.store.getDnsZone('one.test')).toMatchObject({ serial: 5 })
  })

  it('sees an outage on a quiet server through the five minute heartbeat', async () => {
    await a.sync.tick()
    b.down = true
    clock = new Date('2026-11-07T12:02:00.000Z')
    await a.sync.tick()
    expect((await runtimeOf(a, B_NAME)).state).toBe('online')
    clock = new Date('2026-11-07T12:06:00.000Z')
    await a.sync.tick()
    expect(await runtimeOf(a, B_NAME)).toMatchObject({ state: 'outage', failureCode: 'unreachable' })
  })

  it('names a key that no longer matches the pin apart from an outage', async () => {
    const pinned = await server(A_IP)
    await saveConfig(pinned, config({ members: [member(B_NAME, B_IP, TOKEN_B, 'write-only')] }))
    await publish(pinned, 'one.test', 5, '192.0.2.10')
    const sync = createDnsClusterSync({ rootDir: pinned.handle.rootDir, store: pinned.handle.store, readZoneFile: async zone => pinned.files.get(zone) ?? null, zoneStamp: async () => 1, signedZone: async () => false, reconcile: async () => true, audit: async () => undefined, call: async () => { throw new DnsClusterTransportError('pin_mismatch') }, now: () => clock })
    await sync.tick()
    expect(await runtimeOf(pinned, B_NAME)).toMatchObject({ state: 'pin_mismatch', failureCode: 'pin_mismatch' })
    await pinned.handle.close()
  })

  it('reads from a synchronize member and never from a write-only or standalone one', async () => {
    await publish(b, 'beta.test', 7, '192.0.2.30')
    expect((await a.sync.run({ ...pushAll, mode: 'pull' })).members[0]).toMatchObject({ written: 0, unchanged: 0 })
    expect(await a.handle.store.getDnsZone('beta.test')).toBeNull()
    const pulled = await a.sync.run({ ...pushAll, mode: 'pull', includeMissing: true })
    expect(pulled.members[0]).toMatchObject({ written: 1 })
    expect(await a.handle.store.getDnsZone('beta.test')).toMatchObject({ serial: 7, replica: { peer: B_NAME } })
    expect(a.reconcile).toHaveBeenCalledTimes(1)
    await saveConfig(a, config({ members: [member(B_NAME, B_IP, TOKEN_B, 'write-only')] }))
    b.calls.length = 0
    expect((await a.sync.run({ ...pushAll, mode: 'pull', includeMissing: true })).members[0]).toMatchObject({ skipped: 'write_only' })
    expect(b.calls).toEqual([])
    await saveConfig(a, config({ members: [member(B_NAME, B_IP, TOKEN_B, 'standalone')] }))
    await publish(a, 'one.test', 5, '192.0.2.10')
    await a.sync.tick()
    expect(b.calls).toEqual([])
    expect((await a.sync.run(pushAll)).members[0]).toMatchObject({ skipped: 'standalone' })
    expect(b.calls).toEqual([])
  })

  it('withholds a signed zone, and any zone whose key store was not read', async () => {
    await publish(a, 'signed.test', 5, '192.0.2.10'); await publish(a, 'unknown.test', 5, '192.0.2.11')
    a.signed.set('signed.test', true); a.signed.set('unknown.test', null)
    const outcome = (await a.sync.run(pushAll)).members[0]!
    expect(outcome).toMatchObject({ written: 0, withheld: ['signed.test', 'unknown.test'] })
    expect(await b.handle.store.getDnsZone('signed.test')).toBeNull()
    const runtime = await runtimeOf(a, B_NAME)
    expect(runtime.zones['signed.test']).toMatchObject({ state: 'dnssec_signed' })
    expect(runtime.pending).toBe(true)
    a.signed.clear()
    await a.sync.tick()
    expect(await b.handle.store.getDnsZone('unknown.test')).not.toBeNull()
    expect(await b.handle.store.getDnsZone('signed.test')).not.toBeNull()
  })

  it('refuses a synchronisation while clustering is off, and an idle tick then reads nothing', async () => {
    await saveConfig(a, config({ enabled: false, members: [member(B_NAME, B_IP, TOKEN_B, 'synchronize')] }))
    await expect(a.sync.run(pushAll)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'cluster_disabled' } })
    await a.sync.tick()
    expect(b.calls).toEqual([])
    await expect(readFile(join(a.handle.rootDir, DNS_CLUSTER_RUNTIME))).rejects.toThrow()
  })

  it('keeps tokens out of the runtime file', async () => {
    await publish(a, 'one.test', 5, '192.0.2.10')
    await a.sync.tick()
    expect(await readFile(join(a.handle.rootDir, DNS_CLUSTER_RUNTIME), 'utf8')).not.toContain('xpdc_')
  })
})

describe('dns cluster peer route', () => {
  const call = (path: string, init: { method?: string; token?: string | null; client?: string; body?: unknown } = {}) => peerRoute(b, new Request('https://peer.test/api/cluster/dns/' + path, { method: init.method ?? 'GET', headers: { ...(init.token === null ? {} : { authorization: 'Bearer ' + (init.token ?? TOKEN_B) }), 'x-test-client': init.client ?? A_IP }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) }))
  const code = async (response: Response): Promise<unknown> => [response.status, (await response.json() as { code?: string }).code]

  it('admits the exact token from the exact address only', async () => {
    expect(await (await call('hello')).json()).toEqual({ protocol: 1, member: A_NAME })
    expect(await code(await call('hello', { token: null }))).toEqual([401, 'token_invalid'])
    expect(await code(await call('hello', { token: TOKEN_A }))).toEqual([401, 'token_invalid'])
    expect(await code(await call('hello', { token: 'xpdc_short' }))).toEqual([401, 'token_invalid'])
    expect(await code(await call('hello', { client: '203.0.113.9' }))).toEqual([403, 'address_not_allowed'])
  })
  it('stops every call when clustering is off or the issuer is gone', async () => {
    await saveConfig(b, config({ enabled: false, inbound: [inbound(A_NAME, A_IP, TOKEN_B)] }))
    expect(await code(await call('hello'))).toEqual([403, 'cluster_disabled'])
    await saveConfig(b, config({ inbound: [{ ...inbound(A_NAME, A_IP, TOKEN_B), issuedBy: '22222222-2222-4222-8222-222222222222' }] }))
    expect(await code(await call('hello'))).toEqual([403, 'token_issuer_inactive'])
    await writeFile(join(b.handle.rootDir, DNS_CLUSTER_STATE), '{"broken":true}')
    expect(await code(await call('hello'))).toEqual([503, 'cluster_config_invalid'])
  })
  it('refuses a body that is not one valid zone', async () => {
    const put = (body: unknown) => call('zones/one.test', { method: 'PUT', body })
    expect(await code(await put({ serial: 1, text: 'junk', extra: 1, force: false }))).toEqual([422, 'body_invalid'])
    expect((await put({ serial: 1, text: '$INCLUDE /etc/passwd', force: false })).status).toBe(422)
    expect(await code(await put({ serial: 9, text: rendered('one.test', 5, '192.0.2.10'), force: false }))).toEqual([422, 'serial_mismatch'])
    expect((await put({ serial: 5, text: rendered('other.test', 5, '192.0.2.10'), force: false })).status).toBe(422)
    expect(await code(await call('zones/one.test', { method: 'PUT', body: { serial: 1, text: 'x'.repeat(1024 * 1024 + 5000), force: false } }))).toEqual([413, 'zone_too_large'])
    expect(await code(await call('zones/..%2Fpasswd', { method: 'PUT', body: {} }))).toEqual([422, 'zone_invalid'])
    expect(await code(await call('nothing'))).toEqual([404, 'route_unknown'])
    expect(await b.handle.store.getDnsZone('one.test')).toBeNull()
  })
  it('serves source zones to a reader and refuses a signed one', async () => {
    await publish(b, 'beta.test', 7, '192.0.2.30'); await publish(b, 'signed.test', 8, '192.0.2.31')
    expect(await (await call('zones')).json()).toEqual({ zones: [{ zone: 'beta.test', serial: 7, origin: 'local' }, { zone: 'signed.test', serial: 8, origin: 'local' }] })
    expect(await (await call('zones/beta.test')).json()).toMatchObject({ zone: 'beta.test', serial: 7 })
    b.signed.set('signed.test', true)
    expect(await code(await call('zones/signed.test'))).toEqual([409, 'dnssec_signed'])
    expect(await code(await call('zones/absent.test'))).toEqual([404, 'zone_not_held'])
  })
})
