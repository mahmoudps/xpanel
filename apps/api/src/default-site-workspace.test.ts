import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { DefaultSitePolicy, ServerSettings } from '@xpanel/core'
import { createTestStateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { createDefaultSiteWorkspaceRoutes, projectDefaultSiteObservation, type DefaultSiteWorkspaceHelpers } from './default-site-workspace.ts'
import { TEST_SERVER_SECRET } from './testing.ts'

const settings = (): ServerSettings => ({ hostname: 'server.example.test', nameservers: ['ns1.example.test'], adminEmail: 'root@example.test', engine: 'apache', apacheMpm: 'itk', panelPort: 2087, sshPort: 22,
  nginx: { workerProcesses: 'auto', workerConnections: 1024, workerRlimitNofile: 65535, multiAccept: false, keepaliveTimeoutSec: 65 },
  apache: { startServers: 2, minSpareServers: 2, maxSpareServers: 6, maxRequestWorkers: 100, maxConnectionsPerChild: 1000, serverLimit: 100 }, backendPort: 8080, backendTlsPort: 8443 })
const policy: DefaultSitePolicy = { response: 'redirect', redirectTo: 'https://landing.example.test/', refuseHttps: true }
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
const fixture = async () => {
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  await state.store.saveServerSettings(settings())
  const caller = { principal: { kind: 'root', id: randomUUID(), username: 'root' } } as AuthenticatedCaller
  const helpers: DefaultSiteWorkspaceHelpers = { store: state.store, serverSecret: TEST_SERVER_SECRET,
    requireCaller: vi.fn(async () => caller), assertRoot: vi.fn(async () => {}), emitAudit: vi.fn(async () => {}), assertMutationQualified: vi.fn(async () => {}) }
  const route = createDefaultSiteWorkspaceRoutes(helpers)
  const request = (method = 'GET', body?: unknown, path = '/api/server/default-site') => {
    const url = new URL('http://localhost' + path)
    return route(new Request(url, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }) }), url, method)
  }
  const view = async () => await (await request())!.json() as { configuration: { revision: string; policy: DefaultSitePolicy; explicitPolicy: boolean }; application: { status: string; targetVerified: boolean } }
  return { state, caller, helpers, request, view }
}

describe('root default-site leaf with real settings authority and synthetic auth/apply ports', () => {
  it('reads implicit legacy rejection without writing or allocating any policy', async () => {
    const f = await fixture(), revision = await f.state.store.getRevision(), view = await f.view()
    expect(view.configuration).toMatchObject({ policy: { response: 'reject', redirectTo: null, refuseHttps: false }, explicitPolicy: false })
    expect(view.configuration.revision).toMatch(/^[0-9a-f]{64}$/)
    expect(await f.state.store.getServerSettings()).not.toHaveProperty('defaultSite')
    expect(await f.state.store.getRevision()).toBe(revision)
  })
  it('saves only policy over the existing full settings, verifies persisted readback and makes no serving claim', async () => {
    const f = await fixture(), current = await f.view()
    const response = await f.request('PUT', { policy, expectedRevision: current.configuration.revision })
    expect(await response!.json()).toMatchObject({ stateChanged: true, configuration: { policy, explicitPolicy: true }, application: { status: 'not_requested', targetVerified: false } })
    expect(await f.state.store.getServerSettings()).toEqual({ ...settings(), defaultSite: policy })
    expect(vi.mocked(f.helpers.requireCaller).mock.calls.length).toBeGreaterThanOrEqual(4)
  })
  it.each(['reseller', 'user'] as const)('refuses %s root-policy access before reading or writing settings', async kind => {
    const f = await fixture()
    vi.mocked(f.helpers.requireCaller).mockResolvedValue({ ...f.caller, principal: { ...f.caller.principal, kind } } as AuthenticatedCaller)
    await expect(f.request()).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { stateChanged: false } })
    expect(await f.state.store.getServerSettings()).toEqual(settings())
  })
  it('rejects stale revisions and caller-selected paths before any state change', async () => {
    const f = await fixture(), current = await f.view()
    await f.state.store.saveServerSettings({ ...settings(), adminEmail: 'updated@example.test' })
    const revision = await f.state.store.getRevision()
    await expect(f.request('PUT', { policy, expectedRevision: current.configuration.revision })).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    await expect(f.request('GET', undefined, '/api/server/default-site/requests?path=/etc/shadow')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(await f.state.store.getRevision()).toBe(revision)
  })
  it('enforces the actual qualification port without creating a saved success', async () => {
    const f = await fixture(), current = await f.view()
    vi.mocked(f.helpers.assertMutationQualified).mockImplementation(async () => fail('PRECONDITION_FAILED', 'Synthetic unqualified host', { stateChanged: false }))
    await expect(f.request('PUT', { policy, expectedRevision: current.configuration.revision })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    expect(await f.state.store.getServerSettings()).toEqual(settings())
  })
  it('rechecks credentials under the settings writer lease and refuses a revoked or replaced root', async () => {
    const f = await fixture(), current = await f.view(), revision = await f.state.store.getRevision()
    vi.mocked(f.helpers.requireCaller).mockReset().mockResolvedValueOnce(f.caller).mockResolvedValue({ principal: { ...f.caller.principal, id: randomUUID() } } as AuthenticatedCaller)
    await expect(f.request('PUT', { policy, expectedRevision: current.configuration.revision })).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { stateChanged: false } })
    expect(await f.state.store.getServerSettings()).toEqual(settings()); expect(await f.state.store.getRevision()).toBe(revision)
  })
  it('reports changed uncertainty when credentials are revoked after commit', async () => {
    const f = await fixture(), current = await f.view()
    vi.mocked(f.helpers.requireCaller).mockReset().mockResolvedValueOnce(f.caller).mockResolvedValueOnce(f.caller).mockRejectedValue(new Error('Synthetic post-commit revocation'))
    await expect(f.request('PUT', { policy, expectedRevision: current.configuration.revision })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, unknownOutcome: true, verificationRequired: true } })
    expect((await f.state.store.getServerSettings())!.defaultSite).toEqual(policy)
  })
  it.each(['apply', 'audit'] as const)('keeps a committed policy honestly uncertain after %s failure', async stage => {
    const f = await fixture(), current = await f.view()
    if (stage === 'apply') f.helpers.applyConfiguration = vi.fn(async () => { throw new Error('Synthetic native interruption') })
    else vi.mocked(f.helpers.emitAudit).mockRejectedValue(new Error('Synthetic audit interruption'))
    await expect(f.request('PUT', { policy, expectedRevision: current.configuration.revision })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, unknownOutcome: true } })
    expect((await f.state.store.getServerSettings())!.defaultSite).toEqual(policy)
  })
  it('does not turn absent native logs into an observed empty collection', async () => {
    const f = await fixture(), response = await f.request('GET', undefined, '/api/server/default-site/requests')
    expect(await response!.json()).toMatchObject({ observation: { state: 'unavailable', items: [], reason: 'default_log_unavailable' } })
  })
  it('strictly projects root-agent logs and rejects forged addresses', () => {
    const source = { state: 'read', observedAt: '2026-10-26T21:30:00Z', source: 'nginx-default-access-log', limit: 100, truncated: false, malformedRecords: 0,
      items: [{ at: '2026-10-26T21:29:00Z', host: 'unknown.example.test', address: '192.0.2.1', status: 404, uri: '/?secret=private' }] }
    expect(JSON.stringify(projectDefaultSiteObservation(source))).not.toContain('private')
    expect(() => projectDefaultSiteObservation({ ...source, items: [{ ...source.items[0], address: '::::' }] })).toThrow()
  })
  it('rejects oversized streamed JSON before qualification or writes', async () => {
    const f = await fixture(), revision = await f.state.store.getRevision()
    await expect(f.request('PUT', ' '.repeat(8193))).rejects.toMatchObject({ code: 'VALIDATION', detail: { stateChanged: false } })
    expect(f.helpers.assertMutationQualified).not.toHaveBeenCalled(); expect(await f.state.store.getRevision()).toBe(revision)
  })
})
