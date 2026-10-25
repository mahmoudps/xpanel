import { createHash, randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiToken, createRootPrincipal, createTestDb } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import { createApiApp, listenApiServer } from './server.ts'
import { ExtendedFeaturesStore } from './extended-routes.ts'

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const SECRET = 'synthetic-setup-ip-http-secret-for-tests-only'
const body = { hostname: 'panel.example.test', nameservers: ['ns1.example.test', 'ns2.example.test'], adminEmail: 'admin@example.test', initQuotas: false }

describe('setup primary IP HTTP contract', () => {
  let database: Awaited<ReturnType<typeof createTestDb>>
  let state: Awaited<ReturnType<typeof createTestStateStore>>
  let listener: Awaited<ReturnType<typeof listenApiServer>>
  let token: string

  beforeEach(async () => {
    database = await createTestDb()
    state = await createTestStateStore()
    const root = await createRootPrincipal(database.db, { username: 'root', passwordHash: HASH, forcePasswordChange: false })
    token = randomUUID()
    await createApiToken(database.db, { principalId: root.id, name: 'Setup IP HTTP fixture', tokenHash: createHash('sha256').update(token).digest('hex'), scopes: ['*'], expiresAt: new Date(Date.now() + 600_000).toISOString() })
    const app = createApiApp({ db: database.db, store: state.store, serverSecret: SECRET })
    listener = await listenApiServer(app, { host: '127.0.0.1', port: 0 })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    listener.server.closeAllConnections()
    await listener.close()
    await state.close()
    await database.close()
  })

  const post = (input: unknown, authenticated = true) => fetch(`http://127.0.0.1:${listener.port}/api/setup/wizard`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(input),
  })
  const existing4 = () => state.store.saveServerIp({ address: '192.0.2.42', version: 4, prefixLength: 32, interfaceName: 'enp3s0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: 'original.example.test', isPrimary: true, notes: 'Owner-maintained IPv4 inventory' })
  const existing6 = () => state.store.saveServerIp({ address: '2001:db8:42::7', version: 6, prefixLength: 56, interfaceName: 'bond0.42', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: 'ipv6-original.example.test', isPrimary: true, notes: 'Owner-maintained IPv6 inventory' })
  const writeSpies = () => ({ settings: vi.spyOn(state.store, 'saveServerSettings'), ips: vi.spyOn(state.store, 'saveServerIp'), setup: vi.spyOn(state.store, 'markSetupComplete'), extended: vi.spyOn(ExtendedFeaturesStore.prototype, 'write') })
  const noWrites = (spies: ReturnType<typeof writeSpies>) => {
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled()
  }

  it('reuses the current primary IPv4 and leaves omitted IPv6 inventory exactly intact', async () => {
    const ipv4 = await existing4(), ipv6 = await existing6()
    const ips = vi.spyOn(state.store, 'saveServerIp')
    const response = await post(body)
    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, primaryIp: ipv4, quotaInitialized: false })
    expect(await state.store.listServerIps()).toEqual([ipv4, ipv6])
    expect(ips).not.toHaveBeenCalled()
    expect(await state.store.isSetupComplete()).toBe(true)
  })

  it('rejects an omitted IPv4 without a current primary before any configuration write', async () => {
    await state.store.saveServerIp({ address: '192.0.2.43', version: 4, prefixLength: 29, interfaceName: 'enp5s0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: false, notes: 'Not a default address' })
    const beforeIps = await state.store.listServerIps()
    const spies = writeSpies()
    const response = await post(body)
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ detail: 'a valid primary IPv4 address is required' })
    noWrites(spies)
    expect(await state.store.getServerSettings()).toBeNull()
    expect(await state.store.listServerIps()).toEqual(beforeIps)
    expect(await state.store.isSetupComplete()).toBe(false)
  })

  it.each(['', 'bad-ip', '2001:db8::7', null, 7])('rejects invalid explicit IPv4 %j before all setup writes', async primaryIpv4 => {
    await existing4()
    const spies = writeSpies()
    const response = await post({ ...body, primaryIpv4 })
    expect(response.status).toBe(422)
    noWrites(spies)
    expect(await state.store.isSetupComplete()).toBe(false)
  })

  it.each(['bad-ip', '192.0.2.44', 7])('validates optional IPv6 %j before writing valid IPv4 or settings', async primaryIpv6 => {
    await existing4()
    const spies = writeSpies()
    expect((await post({ ...body, primaryIpv6 })).status).toBe(422)
    noWrites(spies)
    expect(await state.store.getServerSettings()).toBeNull()
  })

  it('supports explicit IPv4 and IPv6 on an unconfigured inventory without inventing an address', async () => {
    const response = await post({ ...body, primaryIpv4: '192.0.2.77', primaryIpv6: '2001:db8:77::9' })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toMatchObject({ primaryIp: { address: '192.0.2.77', version: 4, isPrimary: true } })
    expect((await state.store.listServerIps()).map(ip => ip.address).sort()).toEqual(['192.0.2.77', '2001:db8:77::9'])
  })

  it('preserves metadata when the explicitly requested registered addresses are already primary', async () => {
    const ipv4 = await existing4(), ipv6 = await existing6()
    const response = await post({ ...body, primaryIpv4: ipv4.address, primaryIpv6: '2001:0db8:0042:0000:0000:0000:0000:0007' })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(await state.store.listServerIps()).toEqual([ipv4, ipv6])
  })

  it('rejects a second primary address before saving settings or altering the existing default', async () => {
    const ipv4 = await existing4()
    const spies = writeSpies()
    expect((await post({ ...body, primaryIpv4: '192.0.2.99' })).status).toBe(422)
    noWrites(spies)
    expect(await state.store.listServerIps()).toEqual([ipv4])
  })

  it('authenticates the request before reading IP inventory', async () => {
    const read = vi.spyOn(state.store, 'listServerIps')
    expect((await post(body, false)).status).toBe(401)
    expect(read).not.toHaveBeenCalled()
  })
})