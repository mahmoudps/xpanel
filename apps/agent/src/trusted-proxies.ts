import { fail } from '@xpanel/core'
import { assertTrustedProxyAdmission as admission, parseTrustedProxyPolicy, readTrustedProxyActive as checkedActive, trustedProxyPolicyRevision } from '../../../packages/core/src/trusted-proxies.ts'
import type { ProtectedProxyIngress, TrustedProxyActive, TrustedProxyObservation, TrustedProxyPolicy } from '../../../packages/core/src/trusted-proxies.ts'
export * from '../../../packages/core/src/trusted-proxies.ts'

export interface TrustedProxyNativeProvider {
  /** True native service observation; reading a saved file alone cannot prove the active policy. */
  observe(): Promise<TrustedProxyActive>
  protectedIngress(): Promise<ProtectedProxyIngress>
  /** Capture exact native preimages and recovery access. restore must refuse unrelated external drift instead of overwriting it. */
  captureRecovery(): Promise<{ revision: string; restore(): Promise<void>; verify(): Promise<boolean> }>
  /** CAS the exact captured native revision, then call beforeCommit immediately before replacing only the canonical block. */
  install(policy: TrustedProxyPolicy, expectedNativeRevision: string, beforeCommit: () => Promise<void>): Promise<void>
  testConfiguration(): Promise<boolean>
  reload(): Promise<void>
  /** Independently authenticated management probe; no forwarded/request header can satisfy it. */
  probeManagement(): Promise<boolean>
}
const unchanged = { stateChanged: false }
const blocked = (message: string): never => fail('PRECONDITION_FAILED', message, unchanged)
export async function observeTrustedProxies(provider: TrustedProxyNativeProvider | null): Promise<TrustedProxyObservation> {
  if (!provider) return { state: 'unavailable', active: null, activation: 'unavailable', reason: 'protected_native_provider_unavailable' }
  try { const active = checkedActive(await provider.observe()); admission(active.policy, await provider.protectedIngress()); return { state: 'read', active, activation: 'available', reason: null } }
  catch { return { state: 'unavailable', active: null, activation: 'unavailable', reason: 'protected_native_provider_unverified' } }
}
export async function applyTrustedProxyPolicy(policy: TrustedProxyPolicy, expectedActiveRevision: string, provider: TrustedProxyNativeProvider | null, authorize: () => Promise<void>): Promise<TrustedProxyActive> {
  if (!provider) return blocked('protected native ingress activation is unavailable; saved policy has not changed active trust')
  const checked = parseTrustedProxyPolicy(policy)
  await authorize(); admission(checked, await provider.protectedIngress())
  const before = checkedActive(await provider.observe())
  if (before.revision !== expectedActiveRevision) return fail('CONFLICT', 'active proxy configuration changed; reload before applying', unchanged)
  if (!await provider.probeManagement()) return blocked('management access could not be verified before activation')
  const recovery = await provider.captureRecovery()
  if (!recovery || typeof recovery.revision !== 'string' || !/^[0-9a-f]{64}$/.test(recovery.revision) || typeof recovery.restore !== 'function' || typeof recovery.verify !== 'function' || !await recovery.verify()) return blocked('a verified recovery snapshot is required')
  let attempted = false
  try {
    await authorize(); admission(checked, await provider.protectedIngress())
    if (checkedActive(await provider.observe()).revision !== before.revision) return fail('CONFLICT', 'active proxy configuration changed; reload before applying', unchanged)
    await provider.install(checked, recovery.revision, async () => { await authorize(); admission(checked, await provider.protectedIngress()); attempted = true })
    if (!await provider.testConfiguration()) throw new Error('configuration_rejected')
    await authorize(); admission(checked, await provider.protectedIngress()); await provider.reload()
    const after = checkedActive(await provider.observe())
    if (after.revision !== trustedProxyPolicyRevision(checked) || !await provider.probeManagement()) throw new Error('activation_unverified')
    return after
  } catch (error) {
    if (!attempted) throw error
    let restored = false
    try { await recovery.restore(); if (!await provider.testConfiguration()) throw new Error('recovery_configuration_rejected'); await provider.reload(); restored = checkedActive(await provider.observe()).revision === before.revision && await provider.probeManagement() && await recovery.verify() }
    catch { restored = false }
    return fail('SERVICE_UNAVAILABLE', restored ? 'activation failed and the previous ingress configuration was restored' : 'activation outcome is unknown; protected management recovery requires review', { stateChanged: !restored, attempted: true, rolledBack: restored, verificationRequired: !restored, unknownOutcome: !restored })
  }
}

