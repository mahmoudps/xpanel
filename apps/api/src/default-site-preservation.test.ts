import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApiToken, createRootPrincipal, createTestDb } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import type { DefaultSitePolicy, ServerSettings } from '@xpanel/core'
import { createApiApp } from './server.ts'
import { TEST_SERVER_SECRET } from './testing.ts'

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const policy: DefaultSitePolicy = { response: 'redirect', redirectTo: 'https://landing.example.test/', refuseHttps: true }
const settings = (): ServerSettings => ({ hostname: 'server.example.test', nameservers: ['ns1.example.test'], adminEmail: 'root@example.test', engine: 'apache', apacheMpm: 'itk', panelPort: 2087, sshPort: 22,
  nginx: { workerProcesses: 'auto', workerConnections: 1024, workerRlimitNofile: 65535, multiAccept: false, keepaliveTimeoutSec: 65 },
  apache: { startServers: 2, minSpareServers: 2, maxSpareServers: 6, maxRequestWorkers: 100, maxConnectionsPerChild: 1000, serverLimit: 100 }, backendPort: 8080, backendTlsPort: 8443 })
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { vi.restoreAllMocks(); const failures: unknown[] = []; for (const close of cleanup.splice(0).reverse()) { try { await close() } catch (error) { failures.push(error) } } if (failures.length) throw new AggregateError(failures, 'Synthetic policy HTTP fixture cleanup failed') })
const fixture = async (existingPolicy = true) => {
  const database = await createTestDb(); cleanup.push(() => database.close())
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  await state.store.saveServerSettings({ ...settings(), ...(existingPolicy ? { defaultSite: policy } : {}) })
  const root = await createRootPrincipal(database.db, { username: 'root', passwordHash: HASH, forcePasswordChange: false }), token = randomUUID()
  await createApiToken(database.db, { principalId: root.id, name: 'Synthetic legacy policy preservation', tokenHash: createHash('sha256').update(token).digest('hex'), scopes: ['*'], expiresAt: new Date(Date.now() + 600000).toISOString() })
  const app = createApiApp({ db: database.db, store: state.store, serverSecret: TEST_SERVER_SECRET })
  const request = (path: string, method: string, body: unknown) => app.fetch(new Request('http://localhost' + path, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  return { state, request }
}

describe('real HTTP legacy writers preserve dedicated default-site policy', () => {
  it('refuses a changed policy through the legacy full-settings endpoint with no state change', async () => {
    const f = await fixture(), before = await f.state.store.getServerSettings(), revision = await f.state.store.getRevision()
    const response = await f.request('/api/server/settings', 'PUT', { ...settings(), defaultSite: { response: 'reject', redirectTo: null, refuseHttps: false }, markSetupComplete: false })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ details: { stateChanged: false } })
    expect(await f.state.store.getServerSettings()).toEqual(before); expect(await f.state.store.getRevision()).toBe(revision)
  })
  it('cannot introduce a new policy through the legacy endpoint on an unqualified existing host', async () => {
    const f = await fixture(false), revision = await f.state.store.getRevision()
    expect((await f.request('/api/server/settings', 'PUT', { ...settings(), defaultSite: policy, markSetupComplete: false })).status).toBe(422)
    expect(await f.state.store.getServerSettings()).not.toHaveProperty('defaultSite'); expect(await f.state.store.getRevision()).toBe(revision)
  })
  it.each(['omitted', 'same'] as const)('preserves current policy for an %s legacy settings save', async mode => {
    const f = await fixture()
    const response = await f.request('/api/server/settings', 'PUT', { ...settings(), adminEmail: 'updated@example.test', ...(mode === 'same' ? { defaultSite: policy } : {}), markSetupComplete: false })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toMatchObject({ settings: { adminEmail: 'updated@example.test', defaultSite: policy } })
    expect(await f.state.store.getServerSettings()).toEqual({ ...settings(), adminEmail: 'updated@example.test', defaultSite: policy })
  })
  it('preserves policy through the actual setup wizard writer that omits the field', async () => {
    const f = await fixture()
    const response = await f.request('/api/setup/wizard', 'POST', { hostname: 'wizard.example.test', primaryIpv4: '192.0.2.88', initQuotas: false })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toMatchObject({ settings: { hostname: 'wizard.example.test', defaultSite: policy }, quotaInitialized: false })
    expect((await f.state.store.getServerSettings())!.defaultSite).toEqual(policy)
  })
  it('preserves policy through the actual hostname writer that omits the field', async () => {
    const f = await fixture()
    const response = await f.request('/api/server/hostname', 'POST', { hostname: 'renamed.example.test' })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, hostname: 'renamed.example.test' })
    expect(await f.state.store.getServerSettings()).toEqual({ ...settings(), hostname: 'renamed.example.test', defaultSite: policy })
  })
  it('refuses a legacy save after policy changes before its writer lease without overwriting the newer policy', async () => {
    const f = await fixture(), save = f.state.store.saveServerSettings.bind(f.state.store), nextPolicy = { response: 'redirect' as const, redirectTo: 'https://newer.example.test/', refuseHttps: false }
    vi.spyOn(f.state.store, 'saveServerSettings').mockImplementationOnce(async (...args: Parameters<typeof save>) => {
      await save({ ...settings(), defaultSite: nextPolicy }, { settingsGuard: async () => {} })
      return save(...args)
    })
    const response = await f.request('/api/server/settings', 'PUT', { ...settings(), adminEmail: 'stale@example.test', markSetupComplete: false })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ details: { stateChanged: false } })
    expect(await f.state.store.getServerSettings()).toEqual({ ...settings(), defaultSite: nextPolicy })
  })
})
