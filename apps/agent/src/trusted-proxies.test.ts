import { describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import { applyTrustedProxyPolicy, observeTrustedProxies, trustedProxyPolicyRevision } from './trusted-proxies.ts'
import type { TrustedProxyNativeProvider, TrustedProxyPolicy } from './trusted-proxies.ts'
const empty: TrustedProxyPolicy = { cidrs: [], header: 'X-Forwarded-For' }
const policy: TrustedProxyPolicy = { cidrs: ['173.245.48.0/20'], header: 'X-Forwarded-For' }
function harness(options: { failTest?: boolean; failPostManagement?: boolean; failRecovery?: boolean; deniedProof?: boolean } = {}) {
  let config = empty, active = empty, probes = 0, tests = 0
  const provider: TrustedProxyNativeProvider = {
    observe: vi.fn<TrustedProxyNativeProvider['observe']>(async () => ({ state: 'read', policy: active, revision: trustedProxyPolicyRevision(active) })),
    protectedIngress: vi.fn(async () => ({ kind: 'protected-dedicated-ingress-v1' as const, localAddresses: ['127.0.0.1', '192.0.2.1'], managementClient: '198.51.100.50', dedicatedCidrs: options.deniedProof ? [] : policy.cidrs })),
    captureRecovery: vi.fn(async () => ({ revision: 'c'.repeat(64), verify: async () => true, restore: vi.fn(async () => { if (options.failRecovery) throw new Error('recovery_failed'); config = empty }) })),
    install: vi.fn(async (next, revision, beforeCommit) => { if (revision !== 'c'.repeat(64)) throw new Error('stale_native_config'); await beforeCommit(); config = next }),
    testConfiguration: vi.fn(async () => !(options.failTest && tests++ === 0)),
    reload: vi.fn(async () => { active = config }),
    probeManagement: vi.fn(async () => !(options.failPostManagement && probes++ === 1)),
  }
  return { provider, active: () => active }
}
describe('guarded native proxy activation provider', () => {
  it('stays explicitly unavailable without a protected provider', async () => {
    expect(await observeTrustedProxies(null)).toMatchObject({ state: 'unavailable', active: null, activation: 'unavailable' })
    await expect(applyTrustedProxyPolicy(policy, trustedProxyPolicyRevision(empty), null, async () => undefined)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
  })
  it('checks admission, management recovery, current config and authorization before each boundary', async () => {
    const h = harness(), authorize = vi.fn(async () => undefined)
    const result = await applyTrustedProxyPolicy(policy, trustedProxyPolicyRevision(empty), h.provider, authorize)
    expect(result).toEqual({ state: 'read', policy, revision: trustedProxyPolicyRevision(policy) })
    expect(authorize).toHaveBeenCalledTimes(4)
    expect(h.provider.probeManagement).toHaveBeenCalledTimes(2)
    expect(h.provider.captureRecovery).toHaveBeenCalledOnce()
    expect(h.active()).toEqual(policy)
  })
  it('refuses stale active state and unadmitted providers before an install', async () => {
    const h = harness()
    await expect(applyTrustedProxyPolicy(policy, 'a'.repeat(64), h.provider, async () => undefined)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(h.provider.install).not.toHaveBeenCalled()
    const denied = harness({ deniedProof: true })
    await expect(applyTrustedProxyPolicy(policy, trustedProxyPolicyRevision(empty), denied.provider, async () => undefined)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(denied.provider.install).not.toHaveBeenCalled()
  })
  it('restores and verifies the previous config if the candidate fails its config test', async () => {
    const h = harness({ failTest: true })
    await expect(applyTrustedProxyPolicy(policy, trustedProxyPolicyRevision(empty), h.provider, async () => undefined)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { attempted: true, rolledBack: true, stateChanged: false, unknownOutcome: false } })
    expect(h.active()).toEqual(empty)
  })
  it('restores when independent management access fails after reload', async () => {
    const h = harness({ failPostManagement: true })
    await expect(applyTrustedProxyPolicy(policy, trustedProxyPolicyRevision(empty), h.provider, async () => undefined)).rejects.toMatchObject({ detail: { rolledBack: true, verificationRequired: false } })
    expect(h.active()).toEqual(empty)
  })
  it('reports failed recovery as unknown and requiring protected review', async () => {
    const h = harness({ failPostManagement: true, failRecovery: true })
    await expect(applyTrustedProxyPolicy(policy, trustedProxyPolicyRevision(empty), h.provider, async () => undefined)).rejects.toMatchObject({ detail: { rolledBack: false, stateChanged: true, unknownOutcome: true, verificationRequired: true } })
  })
  it('rechecks root authority inside the native beforeCommit callback', async () => {
    const h = harness(); let calls = 0
    await expect(applyTrustedProxyPolicy(policy, trustedProxyPolicyRevision(empty), h.provider, async () => { if (++calls === 3) fail('FORBIDDEN', 'revoked') })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(h.active()).toEqual(empty)
  })
})
