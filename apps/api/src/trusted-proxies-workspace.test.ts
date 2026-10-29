import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import { TRUSTED_PROXY_STATE_PATH, trustedProxyPolicyRevision, trustedProxyRevision } from '../../../packages/core/src/trusted-proxies.ts'
import { handleTrustedProxiesWorkspaceRoute } from './trusted-proxies-workspace.ts'
import type { TrustedProxiesWorkspaceHelpers, TrustedProxiesView } from './trusted-proxies-workspace.ts'
import type { AuthenticatedCaller } from './auth.ts'
const ROOT = { principal: { kind: 'root', id: '11111111-1111-4111-8111-111111111111', username: 'root' }, sessionId: 'one', apiTokenId: null } as AuthenticatedCaller
const policy = { cidrs: ['173.245.48.0/20'], header: 'X-Forwarded-For' as const }
const stamp = '2026-10-27T12:00:00.000Z', record = () => ({ version: 1, policy, updatedAt: stamp })
let root = ''
const path = () => join(root, TRUSTED_PROXY_STATE_PATH)
const write = async (value: unknown) => { await mkdir(join(root, 'extended', 'server'), { recursive: true }); await writeFile(path(), JSON.stringify(value)) }
function harness(overrides: Partial<TrustedProxiesWorkspaceHelpers> = {}) {
  const lease = { assertFencingToken: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }
  const helpers = { requireCaller: vi.fn(async () => ROOT), assertRoot: vi.fn(async (caller: AuthenticatedCaller) => { if (caller.principal.kind !== 'root') fail('FORBIDDEN', 'root required', { stateChanged: false }) }), emitAudit: vi.fn(async () => undefined), now: () => new Date(stamp),
    store: { rootDir: root, getWriterLock: () => ({ acquire: async () => lease }) }, readSafety: async () => ({ localAddresses: ['127.0.0.1', '192.0.2.1'], managementClient: '198.51.100.50' }), ...overrides } as unknown as TrustedProxiesWorkspaceHelpers
  const send = (method = 'GET', body?: unknown, suffix = '', extraHeaders: Record<string, string> = {}) => handleTrustedProxiesWorkspaceRoute(new Request('http://api.test/api/server/trusted-proxies' + suffix, { method, headers: { 'content-type': 'application/json', ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), new URL('http://api.test/api/server/trusted-proxies' + suffix), method, helpers)
  const read = async () => await (await send())!.json() as TrustedProxiesView
  const save = (expectedRevision = trustedProxyRevision(null), selected = policy) => send('PUT', { policy: selected, expectedRevision })
  const apply = () => send('POST', { expectedRevision: trustedProxyRevision(record()), expectedActiveRevision: trustedProxyPolicyRevision({ cidrs: [], header: 'X-Forwarded-For' }) }, '/apply')
  return { helpers, send, read, save, apply, lease }
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'xp-trusted-proxies-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
describe('saved-only trusted proxy workspace', () => {
  it('returns default deny and explicitly unavailable activation without a native provider', async () => {
    const h = harness(), response = (await h.send())!, view = await response.json() as TrustedProxiesView
    expect(view).toMatchObject({ state: 'default', policy: { cidrs: [], header: 'X-Forwarded-For' }, application: 'saved_only', observation: { state: 'unavailable', active: null, activation: 'unavailable' } })
    expect(response.headers.get('cache-control')).toBe('no-store')
  })
  it('saves only the canonical source under CAS, re-reads and audits without invoking an apply transport', async () => {
    const readHost = vi.fn<NonNullable<TrustedProxiesWorkspaceHelpers['readHost']>>(async () => ({ state: 'unavailable', active: null, activation: 'unavailable', reason: 'protected_native_provider_unavailable' }))
    const h = harness({ readHost }), view = await (await h.save())!.json() as TrustedProxiesView
    expect(view).toMatchObject({ state: 'saved', policy, application: 'saved_only', observation: { activation: 'unavailable' } })
    expect(JSON.parse(await readFile(path(), 'utf8'))).toEqual(record())
    expect(readHost.mock.calls.every(([, route]) => route === '/host/trusted-proxies')).toBe(true)
    expect(h.helpers.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.trusted_proxies.saved', detail: { cidrs: 1, application: 'saved_only' } }))
    expect(h.lease.release).toHaveBeenCalledOnce()
  })
  it('rejects resellers, unknown body/query fields, stale values and record corruption', async () => {
    const reseller = { ...ROOT, principal: { ...ROOT.principal, kind: 'reseller' } } as AuthenticatedCaller
    await expect(harness({ requireCaller: async () => reseller }).read()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const h = harness()
    await expect(h.send('GET', undefined, '?proxy=173.245.48.1')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(h.send('PUT', { policy, expectedRevision: trustedProxyRevision(null), activate: true })).rejects.toMatchObject({ code: 'VALIDATION' })
    await write(record())
    await expect(h.save()).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    await write({ policy })
    expect(await h.read()).toMatchObject({ state: 'invalid', policy: null })
    await expect(h.save(trustedProxyRevision({ policy }))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('rejects local interface and actual management-client ranges regardless of forged forwarding headers', async () => {
    await expect(harness({ readSafety: async () => ({ localAddresses: ['173.245.48.2'], managementClient: '198.51.100.50' }) }).save()).rejects.toMatchObject({ code: 'VALIDATION' })
    const h = harness({ readSafety: async () => ({ localAddresses: ['127.0.0.1'], managementClient: '173.245.48.3' }) })
    await expect(h.send('PUT', { policy, expectedRevision: trustedProxyRevision(null) }, '', { 'x-forwarded-for': '198.51.100.50', 'x-real-ip': '198.51.100.50', 'x-xpanel-ingress-secret': 'forged' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(harness({ readSafety: async () => ({ localAddresses: [], managementClient: null }) }).save()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(readFile(path())).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('rechecks authorization inside the atomic commit guard and does not publish a revoked save', async () => {
    let calls = 0
    const h = harness({ requireCaller: async () => { if (++calls >= 4) fail('FORBIDDEN', 'revoked'); return ROOT } })
    await expect(h.save()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, verificationRequired: true } })
    await expect(readFile(path())).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('does not activate saved metadata without a protected agent provider', async () => {
    await write(record())
    await expect(harness().apply()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
  })
  it('locks malformed active acknowledgements and post-effect root revocation as unknown outcomes', async () => {
    await write(record())
    const bad = harness({ readHost: async () => ({ savedRevision: trustedProxyRevision(record()), stateChanged: true, verificationRequired: false, active: null }) })
    await expect(bad.apply()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, verificationRequired: true, unknownOutcome: true } })
    let revoked = false
    const h = harness({ requireCaller: async () => { if (revoked) fail('FORBIDDEN', 'revoked'); return ROOT }, readHost: async () => { revoked = true; return { savedRevision: trustedProxyRevision(record()), stateChanged: true, verificationRequired: false, active: { state: 'read', policy, revision: trustedProxyPolicyRevision(policy) } } } })
    await expect(h.apply()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, verificationRequired: true, unknownOutcome: true } })
  })
  it('reports post-save revocation as a saved effect requiring review', async () => {
    let revoked = false
    const h = harness({ requireCaller: async () => { if (revoked) fail('FORBIDDEN', 'revoked'); return ROOT }, readHost: async () => { revoked = true; return {} } })
    await expect(h.save()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, verificationRequired: true } })
    expect(JSON.parse(await readFile(path(), 'utf8'))).toEqual(record())
  })
})
