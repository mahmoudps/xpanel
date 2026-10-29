import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { fail } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import type { StateStore, DnsZoneState } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { createDynamicDnsRegistry, createDynamicDnsRoutes, dynamicDnsHostname, parseDynamicDnsRegistry } from './dynamic-dns.ts'
import type { DynamicDnsEntry, DynamicDnsPorts } from './dynamic-dns.ts'

const ACCOUNT = '11111111-1111-4111-8111-111111111111', PRINCIPAL = '22222222-2222-4222-8222-222222222222', ZONE = '33333333-3333-4333-8333-333333333333'
const CREATED = '2026-10-27T00:00:00.000Z'
const emptyRevision = createHash('sha256').update('[]').digest('hex')
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
function setup() {
  let account = { id: ACCOUNT, username: 'alice', createdAt: CREATED, status: 'active', ownerId: null, planId: ZONE } as Account
  let caller = { principal: { kind: 'user', accountId: ACCOUNT, id: PRINCIPAL, username: 'alice' }, sessionId: 'interactive-session', apiTokenId: null, scopes: [] } as unknown as AuthenticatedCaller
  let rows: DynamicDnsEntry[] = [], clock = Date.parse(CREATED), revision = 0, disabled: string[] = []
  let zone: DnsZoneState | null = { id: ZONE, accountId: ACCOUNT, name: 'example.com', serial: 1, records: [] }
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
  let release = Promise.resolve(), activeLease = false
  const lease = async <T>(callback: () => Promise<T>): Promise<T> => {
    const before = release; let unlock!: () => void; release = new Promise(resolve => { unlock = resolve }); await before
    if (activeLease) throw new Error('nested_lease'); activeLease = true
    try { return await callback() } finally { activeLease = false; unlock() }
  }
  const store = {
    getAccount: vi.fn(async () => clone(account)), getPlan: vi.fn(async () => ({ featureListId: ZONE })), getFeatureList: vi.fn(async () => ({ disabled })),
    getDnsZone: vi.fn(async (name: string) => zone?.name === name ? clone(zone) : null), listDnsZones: vi.fn(async (id: string) => zone?.accountId === id ? [clone(zone)] : []),
    getRevision: vi.fn(async () => revision),
    withAccountLifecycleLease: vi.fn(async (_id: string, callback: (value: Account) => Promise<unknown>) => lease(async () => { if (account.status !== 'active') fail('FORBIDDEN', 'inactive'); return callback(clone(account)) })),
    saveDnsZone: vi.fn(async (value: DnsZoneState, options: { dnsGuard: (value: DnsZoneState | null) => Promise<void> }) => lease(async () => { await options.dnsGuard(clone(zone)); zone = clone(value); revision++; return clone(zone) })),
  }
  const audit = vi.fn(async () => undefined), registry = { read: vi.fn(async () => clone(rows)), write: vi.fn(async (value: DynamicDnsEntry[]) => { rows = clone(value) }) }
  const ports: DynamicDnsPorts = { store: store as unknown as StateStore, requireCaller: vi.fn(async () => caller), emitAudit: audit,
    readPrincipal: vi.fn(async () => ({ id: PRINCIPAL, kind: 'user', accountId: ACCOUNT, username: 'alice', disabled: false })),
    assertUpdateAvailable: vi.fn(async () => undefined), reconcile: vi.fn(async () => true), registry, now: () => clock }
  const routes = createDynamicDnsRoutes(ports)
  const manage = (method: string, body?: unknown, path = '/api/account/dynamic-dns') => {
    const url = new URL('https://panel.example.com' + path)
    return routes.manage(new Request(url, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }), url, method)
  }
  const create = async (more = {}) => { const response = await manage('POST', { hostname: 'home.example.com', zone: 'example.com', type: 'A', description: 'Router', expectedRevision: emptyRevision, ...more }); expect(response?.status).toBe(201); return await response!.json() as { issued: { id: string; secret: string }; revision: string; entries: { id: string }[] } }
  const update = (issued: { id: string; secret: string }, query = '?hostname=home.example.com&myip=203.0.113.7', peer: string | null = '198.51.100.1', extra: Record<string, string> = {}) => {
    const url = new URL('https://panel.example.com/nic/update' + query)
    return routes.update(new Request(url, { headers: { authorization: 'Basic ' + Buffer.from(issued.id + ':' + issued.secret).toString('base64'), ...extra } }), url, peer)
  }
  return { ports, routes, store, registry, audit, manage, create, update, rows: () => rows, zone: () => zone, setZone: (value: DnsZoneState | null) => { zone = value }, setAccount: (value: Partial<Account>) => { account = { ...account, ...value } }, setCaller: (value: AuthenticatedCaller) => { caller = value }, caller: () => caller, tick: (ms: number) => { clock += ms }, disable: () => { disabled = ['dynamic-dns'] } }
}

describe('dynamic DNS credential management', () => {
  it('issues 32 random bytes once, persists a hash, lists only the owner and leaves DNS untouched', async () => {
    const ctx = setup(), created = await ctx.create(), listed = await (await ctx.manage('GET'))!.json()
    expect(Buffer.from(created.issued.secret, 'base64url')).toHaveLength(32)
    expect(ctx.rows()[0]?.secretHash).toBe(createHash('sha256').update(created.issued.secret).digest('hex'))
    expect(JSON.stringify(ctx.rows())).not.toContain(created.issued.secret)
    expect(JSON.stringify(listed)).not.toContain('secret')
    expect(ctx.store.saveDnsZone).not.toHaveBeenCalled()
    expect(JSON.stringify(ctx.audit.mock.calls)).not.toContain(created.issued.secret)
    expect(listed.entries).toHaveLength(1)
    expect(listed.zones).toEqual([{ name: 'example.com' }])
  })
  it('requires an interactive owner, refuses root, mailbox and bearer credentials', async () => {
    const ctx = setup(), original = ctx.caller()
    for (const changed of [{ principal: { kind: 'root', id: PRINCIPAL, username: 'root' } }, { principalKind: 'mailbox' }, { apiTokenId: 'token', sessionId: null }]) {
      ctx.setCaller({ ...original, ...changed } as AuthenticatedCaller)
      await expect(ctx.manage('GET')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    }
  })
  it('rejects every unsupported selector, mixed-case name, extra key and wrong zone', async () => {
    const ctx = setup()
    expect((await ctx.manage('GET', undefined, '/api/account/dynamic-dns?accountId=' + ACCOUNT))?.status).toBe(422)
    expect((await ctx.manage('GET', undefined, '/api/account/dynamic-dns/%2e%2e%2f'))?.status).toBe(422)
    for (const extra of [{ hostname: '*.example.com' }, { hostname: 'Home.example.com' }, { hostname: 'home.example.com.' }, { hostname: 'home.example.com,evil.test' }, { type: 'TXT' }, { accountId: ACCOUNT }, { description: '<script>' }]) {
      const response = await ctx.manage('POST', { hostname: 'home.example.com', zone: 'example.com', type: 'A', description: '', expectedRevision: emptyRevision, ...extra })
      expect(response?.status).toBe(422)
    }
    await expect(ctx.manage('POST', { hostname: 'home.evil.test', zone: 'example.com', type: 'A', description: '', expectedRevision: emptyRevision })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(ctx.rows()).toEqual([])
  })
  it('rotates immediately and removal revokes without deleting the DNS record', async () => {
    const ctx = setup(), first = await ctx.create(), rotated = await (await ctx.manage('POST', { expectedRevision: first.revision }, '/api/account/dynamic-dns/' + first.issued.id + '/rotate'))!.json()
    expect(rotated.issued.secret).not.toBe(first.issued.secret)
    expect(await (await ctx.update(first.issued))!.text()).toBe('badauth\n')
    expect(await (await ctx.update(rotated.issued))!.text()).toBe('good 203.0.113.7\n')
    const view = await (await ctx.manage('GET'))!.json(), before = ctx.zone()
    expect((await ctx.manage('DELETE', { expectedRevision: view.revision }, '/api/account/dynamic-dns/' + first.issued.id))?.status).toBe(200)
    expect(ctx.zone()).toEqual(before)
    expect(await (await ctx.update(rotated.issued))!.text()).toBe('badauth\n')
  })
  it('checks the revision inside the lifecycle lease and fails closed on an audit error', async () => {
    const ctx = setup(), first = await ctx.create()
    await expect(ctx.manage('DELETE', { expectedRevision: emptyRevision }, '/api/account/dynamic-dns/' + first.issued.id)).rejects.toMatchObject({ code: 'CONFLICT' })
    ctx.audit.mockRejectedValueOnce(new Error('unavailable'))
    await expect(ctx.manage('POST', { expectedRevision: first.revision }, '/api/account/dynamic-dns/' + first.issued.id + '/rotate')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(await (await ctx.update(first.issued))!.text()).toBe('good 203.0.113.7\n')
  })
  it('refuses CNAME and multivalue collisions and retains an existing record identity/TTL', async () => {
    const ctx = setup(), base = ctx.zone()!, record = { id: PRINCIPAL, zone: base.name, name: 'home', type: 'A' as const, content: '203.0.113.3', ttl: 14400, priority: null }
    ctx.setZone({ ...base, records: [{ ...record, type: 'CNAME' }] })
    await expect(ctx.create()).rejects.toMatchObject({ code: 'CONFLICT' })
    ctx.setZone({ ...base, records: [record, { ...record, id: ACCOUNT }] })
    await expect(ctx.create()).rejects.toMatchObject({ code: 'CONFLICT' })
    ctx.setZone({ ...base, records: [record] })
    const first = await ctx.create()
    expect(await (await ctx.update(first.issued))!.text()).toBe('good 203.0.113.7\n')
    expect(ctx.zone()?.records[0]).toMatchObject({ id: PRINCIPAL, ttl: 14400, content: '203.0.113.7' })
  })
})

describe('dyndns2 update authorization and publication', () => {
  it('writes under a revision guard, verifies publication, preserves other records and throttles changed writes only', async () => {
    const ctx = setup(), created = await ctx.create()
    expect(await (await ctx.update(created.issued))!.text()).toBe('good 203.0.113.7\n')
    expect(await (await ctx.update(created.issued))!.text()).toBe('nochg 203.0.113.7\n')
    expect(ctx.store.saveDnsZone).toHaveBeenCalledTimes(1)
    expect(await (await ctx.update(created.issued, '?hostname=home.example.com&myip=203.0.113.8'))!.text()).toBe('abuse\n')
    ctx.tick(60000)
    expect(await (await ctx.update(created.issued, '?hostname=home.example.com&myip=203.0.113.8'))!.text()).toBe('good 203.0.113.8\n')
  })
  it('uses the socket address only, ignores forwarded headers, and validates address family', async () => {
    const ctx = setup(), created = await ctx.create()
    expect(await (await ctx.update(created.issued, '?hostname=home.example.com', '198.51.100.1', { 'x-forwarded-for': '203.0.113.44' }))!.text()).toBe('good 198.51.100.1\n')
    expect(await (await ctx.update(created.issued, '?hostname=home.example.com', null, { 'x-forwarded-for': '203.0.113.44' }))!.text()).toBe('notfqdn\n')
    expect(await (await ctx.update(created.issued, '?hostname=home.example.com&myip=2001:db8::1'))!.text()).toBe('notfqdn\n')
  })
  it('accepts IPv6 and apex records, and refuses query pollution', async () => {
    const ctx = setup(), created = await ctx.create({ hostname: 'example.com', type: 'AAAA' })
    expect(await (await ctx.update(created.issued, '?hostname=example.com&myip=2001:db8::7'))!.text()).toBe('good 2001:db8::7\n')
    expect(ctx.zone()?.records[0]?.name).toBe('@')
    for (const query of ['?hostname=example.com&hostname=example.com', '?hostname=example.com&myip=2001:db8::7&x=1', '?hostname=example.com,other.test', '?hostname=Example.com']) expect(await (await ctx.update(created.issued, query))!.text()).toBe('notfqdn\n')
    expect(await (await ctx.update(created.issued, '?hostname=other.example.com&myip=2001:db8::7'))!.text()).toBe('nohost\n')
  })
  it('rechecks suspension, lifetime, principal and plan, and never writes on a foreign zone', async () => {
    for (const change of ['suspended', 'lifetime', 'principal', 'principal-id', 'plan', 'zone'] as const) {
      const ctx = setup(), created = await ctx.create()
      if (change === 'suspended') ctx.setAccount({ status: 'suspended' })
      if (change === 'lifetime') ctx.setAccount({ createdAt: '2026-10-28T00:00:00.000Z' })
      if (change === 'principal') vi.mocked(ctx.ports.readPrincipal).mockResolvedValue(null)
      if (change === 'principal-id') vi.mocked(ctx.ports.readPrincipal).mockResolvedValue({ id: ACCOUNT, kind: 'user', accountId: ACCOUNT, username: 'alice', disabled: false })
      if (change === 'plan') ctx.disable()
      if (change === 'zone') ctx.setZone({ ...ctx.zone()!, accountId: PRINCIPAL })
      expect(await (await ctx.update(created.issued))!.text()).toBe('nohost\n')
      expect(ctx.store.saveDnsZone).not.toHaveBeenCalled()
    }
  })
  it('keeps failed publication pending, retries without rewriting, then returns good only after acknowledgement', async () => {
    const ctx = setup(), created = await ctx.create()
    vi.mocked(ctx.ports.reconcile).mockResolvedValueOnce(false)
    expect(await (await ctx.update(created.issued))!.text()).toBe('911\n')
    expect(ctx.rows()[0]?.pendingIp).toBe('203.0.113.7')
    expect(await (await ctx.update(created.issued, '?hostname=home.example.com&myip=203.0.113.8'))!.text()).toBe('911\n')
    expect(await (await ctx.update(created.issued))!.text()).toBe('good 203.0.113.7\n')
    expect(ctx.store.saveDnsZone).toHaveBeenCalledTimes(1)
    expect(ctx.rows()[0]?.pendingIp).toBeNull()
  })
  it('fails closed on write readback mismatch and prevents racing credential rotation', async () => {
    const ctx = setup(), created = await ctx.create()
    ctx.store.saveDnsZone.mockImplementationOnce(async (value, options) => { await options.dnsGuard(ctx.zone()); return value })
    expect(await (await ctx.update(created.issued))!.text()).toBe('911\n')
    expect(ctx.ports.reconcile).not.toHaveBeenCalled()
  })
  it('requires a current publication acknowledgement even for an unchanged address', async () => {
    const ctx = setup(), created = await ctx.create()
    expect(await (await ctx.update(created.issued))!.text()).toBe('good 203.0.113.7\n')
    vi.mocked(ctx.ports.reconcile).mockResolvedValueOnce(false)
    expect(await (await ctx.update(created.issued))!.text()).toBe('911\n')
    expect(ctx.store.saveDnsZone).toHaveBeenCalledTimes(1)
    expect(ctx.ports.reconcile).toHaveBeenCalledTimes(2)
  })
  it('refuses nochg when the state revision changes while waiting for the final lifecycle lease', async () => {
    const ctx = setup(), created = await ctx.create()
    expect(await (await ctx.update(created.issued))!.text()).toBe('good 203.0.113.7\n')
    const lifecycle = ctx.store.withAccountLifecycleLease.getMockImplementation()!
    ctx.store.withAccountLifecycleLease.mockImplementationOnce(async (id, callback) => {
      await ctx.store.saveDnsZone(ctx.zone()!, { dnsGuard: async () => undefined })
      return lifecycle(id, callback)
    })
    expect(await (await ctx.update(created.issued))!.text()).toBe('911\n')
  })
  it('requires the exact credential snapshot after publication and fails closed on rotation', async () => {
    for (const change of ['metadata', 'rotation'] as const) {
      const ctx = setup(), created = await ctx.create()
      vi.mocked(ctx.ports.reconcile).mockImplementationOnce(async () => {
        await ctx.registry.write(ctx.rows().map(row => change === 'metadata' ? { ...row, description: 'Changed during publication' } : { ...row, secretHash: 'f'.repeat(64) }))
        return true
      })
      expect(await (await ctx.update(created.issued))!.text()).toBe('911\n')
      expect(ctx.rows()[0]?.pendingIp).toBe('203.0.113.7')
    }
  })
  it('recovers the same pending intent when the guarded DNS write fails before saving the record', async () => {
    const ctx = setup(), created = await ctx.create()
    ctx.store.saveDnsZone.mockImplementationOnce(async (_value, options) => { await options.dnsGuard(ctx.zone()); throw new Error('synthetic disk failure') })
    expect(await (await ctx.update(created.issued))!.text()).toBe('911\n')
    expect(ctx.zone()?.records).toEqual([])
    expect(ctx.rows()[0]?.pendingIp).toBe('203.0.113.7')
    expect(await (await ctx.update(created.issued))!.text()).toBe('good 203.0.113.7\n')
    expect(ctx.rows()[0]?.pendingIp).toBeNull()
    expect(ctx.store.saveDnsZone).toHaveBeenCalledTimes(2)
  })
  it('does not publish or write when the trusted host capability is absent', async () => {
    const ctx = setup(), created = await ctx.create()
    vi.mocked(ctx.ports.assertUpdateAvailable).mockRejectedValue(new Error('host unavailable'))
    expect(await (await ctx.update(created.issued))!.text()).toBe('911\n')
    expect(ctx.store.saveDnsZone).not.toHaveBeenCalled()
  })
  it('throttles failed authentication by source with a bounded expiry', async () => {
    const ctx = setup(), created = await ctx.create(), bad = { ...created.issued, secret: 'z'.repeat(43) }
    for (let i = 0; i < 10; i++) expect(await (await ctx.update(bad))!.text()).toBe('badauth\n')
    expect(await (await ctx.update(created.issued))!.text()).toBe('abuse\n')
    expect(await (await ctx.update(created.issued, '?hostname=home.example.com&myip=203.0.113.7', '198.51.100.2'))!.text()).toBe('good 203.0.113.7\n')
    ctx.tick(300000)
    expect(await (await ctx.update(created.issued))!.text()).toBe('nochg 203.0.113.7\n')
  })
})

describe('dynamic DNS registry', () => {
  it('writes hash-only state through the atomic store and rejects corrupted state', async () => {
    const ctx = setup(); await ctx.create()
    const path = await mkdtemp(join(tmpdir(), 'xpanel-ddns-')); directories.push(path)
    const registry = createDynamicDnsRegistry(path)
    expect(await registry.read()).toEqual([])
    await registry.write(ctx.rows())
    expect(await registry.read()).toEqual(ctx.rows())
    expect(await readFile(join(path, 'extended', 'dynamic-dns.json'), 'utf8')).not.toContain('"secret":')
    expect(() => parseDynamicDnsRegistry([{ ...ctx.rows()[0], secret: 'injected' }])).toThrow()
    expect(() => parseDynamicDnsRegistry([...ctx.rows(), ...ctx.rows()])).toThrow()
    for (const host of ['a..com', '.example.com', 'a.example.com.', '-a.example.com', 'a/b.example.com', 'a\n.example.com']) expect(dynamicDnsHostname(host)).toBe(false)
  })
})
