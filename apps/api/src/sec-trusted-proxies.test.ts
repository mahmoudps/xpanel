import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import { TRUSTED_PROXY_STATE_PATH, trustedProxyPolicyRevision, trustedProxyRevision } from '../../../packages/core/src/trusted-proxies.ts'
import type { AuthenticatedCaller } from './auth.ts'
import { handleTrustedProxiesWorkspaceRoute } from './trusted-proxies-workspace.ts'
import type { TrustedProxiesWorkspaceHelpers } from './trusted-proxies-workspace.ts'

const ROOT = { principal: { kind: 'root', id: '11111111-1111-4111-8111-111111111111', username: 'root' }, sessionId: 'one', apiTokenId: null } as AuthenticatedCaller
const policy = { cidrs: ['173.245.48.0/20'], header: 'X-Forwarded-For' as const }, record = { version: 1, policy, updatedAt: '2026-10-27T12:00:00.000Z' }
const active = (cidrs: string[]) => ({ state: 'read', policy: { cidrs, header: 'X-Forwarded-For' }, revision: trustedProxyPolicyRevision({ cidrs, header: 'X-Forwarded-For' }) })
let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'xp-sec-proxies-')); await mkdir(join(root, 'extended', 'server'), { recursive: true }); await writeFile(join(root, TRUSTED_PROXY_STATE_PATH), JSON.stringify(record)) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const harness = (client: string | null, readHost: TrustedProxiesWorkspaceHelpers['readHost']) => {
  const lease = { assertFencingToken: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }
  const helpers = { requireCaller: vi.fn(async () => ROOT), assertRoot: vi.fn(async (caller: AuthenticatedCaller) => { if (caller.principal.kind !== 'root') fail('FORBIDDEN', 'root required', { stateChanged: false }) }), emitAudit: vi.fn(async () => undefined),
    store: { rootDir: root, getWriterLock: () => ({ acquire: async () => lease }) }, readSafety: async () => ({ localAddresses: ['192.0.2.1'], managementClient: client }), readHost } as unknown as TrustedProxiesWorkspaceHelpers
  const apply = () => handleTrustedProxiesWorkspaceRoute(new Request('http://api.test/api/server/trusted-proxies/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: trustedProxyRevision(record), expectedActiveRevision: active([]).revision }) }), new URL('http://api.test/api/server/trusted-proxies/apply'), 'POST', helpers)
  return { apply, helpers }
}

describe('management client carried to the protected ingress provider', () => {
  it('passes the socket-derived management client on observation and activation', async () => {
    const readHost = vi.fn<NonNullable<TrustedProxiesWorkspaceHelpers['readHost']>>(async (_caller, path) => path.endsWith('/apply') ? { active: active(policy.cidrs), savedRevision: trustedProxyRevision(record), stateChanged: true, verificationRequired: false } : { state: 'read', active: active([]), activation: 'available', reason: null })
    const h = harness('198.51.100.7', readHost)
    expect((await (await h.apply())!.json()).active.policy).toEqual(policy)
    expect(readHost).toHaveBeenCalledWith(ROOT, '/host/trusted-proxies/apply', expect.any(Object), '198.51.100.7')
  })
  it('refuses activation when the management client is unknown or inside a saved proxy range', async () => {
    const readHost = vi.fn<NonNullable<TrustedProxiesWorkspaceHelpers['readHost']>>()
    await expect(harness(null, readHost).apply()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(harness('173.245.48.9', readHost).apply()).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(readHost).not.toHaveBeenCalled()
  })
})
