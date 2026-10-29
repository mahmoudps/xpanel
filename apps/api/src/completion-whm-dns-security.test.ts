import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiToken, createResellerPrincipal, createRootPrincipal, createSession, createTestDb, createUserPrincipal } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import type { DnsZoneState } from '@xpanel/state'
import { deriveCsrfToken, sha256Hex } from './auth.ts'
import { createApiApp, listenApiServer } from './server.ts'

// Actual loopback HTTP, disposable state/database and synthetic credentials. No DNS service,
// resolver, privileged executor or capability qualification is exercised.
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const SECRET = 'dns-workspace-synthetic-test-secret'
const cleanup: Array<() => Promise<unknown>> = []
const fixture = async () => {
  const database = await createTestDb(); cleanup.push(() => database.close())
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  const root = await createRootPrincipal(database.db, { username: 'root', passwordHash: HASH, forcePasswordChange: false })
  const features = await state.store.createFeatureList({ name: 'DNS fixture', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'DNS fixture', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 4, forwarders: 4, mailingLists: 5, ftpAccounts: 5, databases: 5, phpWorkers: 5 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  await state.store.saveServerIp({ address: '192.0.2.55', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const makeAccount = (username: string) => state.store.createAccount({ username, passwordHash: HASH, primaryDomain: `${username}.example.test`, planId: plan.id, ownerId: null, contactEmail: `owner@${username}.example.test`, ipv4: '192.0.2.55', shell: 'none',
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } })
  const alice = await makeAccount('dnsa'), bob = await makeAccount('dnsb')
  const alicePrincipal = await createUserPrincipal(database.db, { username: alice.username, accountId: alice.id, passwordHash: HASH })
  const reseller = await state.store.createReseller({ username: 'reselldns', passwordHash: HASH, acl: ['list-accounts', 'manage-dns'], maxAccounts: 5, totalDiskMb: 10000, totalBandwidthMb: 100000, oversell: false, nameservers: [], delegatedIps: [] })
  await createResellerPrincipal(database.db, { id: reseller.id, username: reseller.username, passwordHash: HASH })
  await state.store.changeOwner(alice.id, reseller.id)
  const token = async (principalId: string, scopes = ['*']) => {
    const raw = 'xp_' + randomUUID()
    await createApiToken(database.db, { principalId, name: 'Synthetic DNS', tokenHash: sha256Hex(raw), scopes, expiresAt: new Date(Date.now() + 60000).toISOString() })
    return raw
  }
  const rootToken = await token(root.id), ownerToken = await token(alicePrincipal.id), resellerToken = await token(reseller.id)
  const app = createApiApp({ db: database.db, store: state.store, serverSecret: SECRET })
  const server = await listenApiServer(app); cleanup.push(() => server.close())
  const request = (path: string, method = 'GET', body?: unknown, bearer: string | null = rootToken, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${server.port}` + path, { method, headers: { ...(bearer ? { authorization: 'Bearer ' + bearer } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const zone: DnsZoneState = { id: randomUUID(), accountId: alice.id, name: alice.primaryDomain, serial: 2026102601,
    records: [{ id: randomUUID(), zone: alice.primaryDomain, name: '@', type: 'A', ttl: 0, content: '192.0.2.1', priority: null }] }
  await state.store.saveDnsZone(zone)
  const listing = async (bearer = rootToken) => {
    const response = await request('/api/dns/zones', 'GET', undefined, bearer)
    expect(response.status).toBe(200)
    return (await response.json() as { zones: Array<DnsZoneState & { revision: string }> }).zones
  }
  const selected = async () => (await listing()).find(item => item.name === zone.name)!
  const bytes = () => readFile(join(state.rootDir, 'zones', zone.name + '.json'), 'utf8')
  return { database, state, root, alice, bob, reseller, rootToken, ownerToken, resellerToken, token, zone, request, listing, selected, bytes }
}

describe('xWHM DNS revision-bound loopback HTTP acceptance', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeEach(async () => { f = await fixture() })
  afterEach(async () => {
    vi.restoreAllMocks()
    const outcomes = await Promise.allSettled(cleanup.splice(0).reverse().map(close => close()))
    const errors = outcomes.filter(result => result.status === 'rejected').map(result => result.reason)
    if (errors.length) throw new AggregateError(errors, 'DNS fixture cleanup failed')
  })
  const path = () => '/api/dns/zones/' + f.zone.name
  const payload = async () => ({ expectedZoneRevision: (await f.selected()).revision, records: [{ ...f.zone.records[0], content: '192.0.2.99' }] })

  it('reads canonical revisions without allocating serials or changing source bytes', async () => {
    const before = await f.bytes(), observed = await f.selected()
    expect(observed.revision).toMatch(/^[0-9a-f]{64}$/)
    expect(observed.serial).toBe(f.zone.serial)
    expect(await f.bytes()).toBe(before)
    expect(await f.selected()).toEqual(observed)
  })
  it('saves exact records with a server serial, persisted readback and audit', async () => {
    const response = await f.request(path(), 'PUT', await payload())
    expect(response.status).toBe(200)
    const body = await response.json() as { zone: DnsZoneState; revision: string }
    expect(body.zone.serial).toBe(f.zone.serial + 1)
    expect(body.zone.id).toBe(f.zone.id)
    expect(body.zone.records[0]).toMatchObject({ ttl: 0, content: '192.0.2.99' })
    expect(await f.selected()).toEqual({ ...body.zone, revision: body.revision })
    expect(JSON.parse(await f.bytes())).toEqual(body.zone)
    expect((await f.database.db.query('SELECT action FROM audit_log WHERE action = $1', ['dns.zone.saved'])).length).toBe(1)
  })
  it('creates an unassigned root zone only when the expected state is absent', async () => {
    const target = '/api/dns/zones/new.example.test', input = { records: [], accountId: null, expectedZoneRevision: null }
    expect((await f.request(target, 'PUT', input)).status).toBe(200)
    const before = await f.state.store.getDnsZone('new.example.test')
    expect((await f.request(target, 'PUT', input)).status).toBe(409)
    expect(await f.state.store.getDnsZone('new.example.test')).toEqual(before)
  })
  it.each(['serial', 'id', 'unknown'])('refuses client-supplied %s in the guarded contract without writing', async key => {
    const before = await f.bytes()
    const response = await f.request(path(), 'PUT', { ...await payload(), [key]: key === 'serial' ? 1 : randomUUID() })
    expect(response.status).toBe(422); expect(await f.bytes()).toBe(before)
  })
  it.each([null, [], 'invalid'])('refuses non-object body %s without writing', async body => {
    const before = await f.bytes(); expect((await f.request(path(), 'PUT', body)).status).toBe(422); expect(await f.bytes()).toBe(before)
  })
  it('refuses stale saves and deletes without a source change', async () => {
    const input = await payload()
    expect((await f.request(path(), 'PUT', input)).status).toBe(200)
    const before = await f.bytes()
    for (const [method, body] of [['PUT', input], ['DELETE', { expectedZoneRevision: input.expectedZoneRevision }]] as const) {
      const response = await f.request(path(), method, body)
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ details: { stateChanged: false } })
      expect(await f.bytes()).toBe(before)
    }
  })
  it('serializes concurrent writes so only one request can consume a revision', async () => {
    const input = await payload()
    const responses = await Promise.all([f.request(path(), 'PUT', input), f.request(path(), 'PUT', input)])
    expect(responses.map(response => response.status).sort()).toEqual([200, 409])
    expect((await f.selected()).serial).toBe(f.zone.serial + 1)
  })
  it('checks the revision again after waiting for the StateStore writer lease', async () => {
    const input = await payload(), original = f.state.store.saveDnsZone.bind(f.state.store)
    vi.spyOn(f.state.store, 'saveDnsZone').mockImplementationOnce(async (zone, options) => {
      await original({ ...f.zone, serial: f.zone.serial + 1, records: [] })
      return original(zone, options)
    })
    expect((await f.request(path(), 'PUT', input)).status).toBe(409)
    expect((await f.state.store.getDnsZone(f.zone.name))?.records).toEqual([])
  })
  it('rechecks reseller authorization under the lease', async () => {
    const input = await payload(), original = f.state.store.saveDnsZone.bind(f.state.store), before = await f.bytes()
    vi.spyOn(f.state.store, 'saveDnsZone').mockImplementationOnce(async (zone, options) => {
      await f.state.store.updateReseller(f.reseller.id, { acl: ['list-accounts'] })
      return original(zone, options)
    })
    expect((await f.request(path(), 'PUT', input, f.resellerToken)).status).toBe(403)
    expect(await f.bytes()).toBe(before)
  })
  it('filters reseller/owner reads and refuses foreign mutation and unassigned ownership', async () => {
    await f.state.store.saveDnsZone({ ...f.zone, id: randomUUID(), accountId: f.bob.id, name: f.bob.primaryDomain })
    await f.state.store.saveDnsZone({ ...f.zone, id: randomUUID(), accountId: null, name: 'server.example.test' })
    for (const bearer of [f.ownerToken, f.resellerToken]) {
      expect((await f.listing(bearer)).map(zone => zone.name)).toEqual([f.zone.name])
      const foreign = await f.request('/api/dns/zones/' + f.bob.primaryDomain, 'PUT', { records: [], accountId: f.alice.id, expectedZoneRevision: null }, bearer)
      expect(foreign.status).toBe(404)
      expect((await f.request('/api/dns/zones/server.example.test', 'DELETE', { expectedZoneRevision: '0'.repeat(64) }, bearer)).status).toBe(403)
    }
  })
  it('deletes only the exact reviewed zone and leaves other zones intact', async () => {
    await f.state.store.saveDnsZone({ ...f.zone, id: randomUUID(), accountId: f.bob.id, name: f.bob.primaryDomain })
    const response = await f.request(path(), 'DELETE', { expectedZoneRevision: (await f.selected()).revision })
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ ok: true })
    expect(await f.state.store.getDnsZone(f.zone.name)).toBeNull()
    expect(await f.state.store.getDnsZone(f.bob.primaryDomain)).not.toBeNull()
    expect((await f.database.db.query('SELECT action FROM audit_log WHERE action = $1', ['dns.zone.deleted'])).length).toBe(1)
  })
  it('keeps authentication, bearer scopes and session CSRF mandatory', async () => {
    const input = await payload(), before = await f.bytes()
    expect((await f.request('/api/dns/zones', 'GET', undefined, null)).status).toBe(401)
    expect((await f.request(path(), 'PUT', input, await f.token(f.root.id, ['dns:read']))).status).toBe(403)
    const raw = randomUUID() + randomUUID()
    await createSession(f.database.db, { principalId: f.root.id, tokenHash: sha256Hex(raw), expiresAt: new Date(Date.now() + 60000).toISOString() })
    const cookie = { cookie: 'xpanel_session=' + raw }
    expect((await f.request(path(), 'PUT', input, null, cookie)).status).toBe(403)
    expect((await f.request(path(), 'DELETE', { expectedZoneRevision: input.expectedZoneRevision }, null, { ...cookie, 'x-csrf-token': 'wrong' })).status).toBe(403)
    expect(await f.bytes()).toBe(before)
    expect((await f.request(path(), 'PUT', input, null, { ...cookie, 'x-csrf-token': deriveCsrfToken(raw, SECRET) })).status).toBe(200)
  })
})
