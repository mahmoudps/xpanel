import { describe, expect, it } from 'vitest'
import { createNativeUpgradeSafety, assertLifecycleRootSafetyHeld, getLifecycleRootSafetyInfo, parseCoordinatorCgroup, parseLifecycleHead } from './lifecycle-root-safety.mjs'

describe('native lifecycle authority boundary', () => {
  it('parses only a finite actual coordinator location, without granting authority', () => {
    expect(parseCoordinatorCgroup('0::/system.slice/xpanel-lifecycle.service\n')).toBe('xpanel-lifecycle.service')
    expect(parseCoordinatorCgroup('0::/system.slice/xpanel-upgrade.service\n')).toBe('xpanel-upgrade.service')
    for (const text of ['0::/user.slice/xpanel-lifecycle.service', '0::/system.slice/other.service', '0::/system.slice/xpanel-lifecycle.service\n1:name=systemd:/scope', '0::/system.slice/xpanel-api.service']) expect(() => parseCoordinatorCgroup(text)).toThrow()
    expect(() => getLifecycleRootSafetyInfo({ coordinatorUnit: 'xpanel-lifecycle.service' })).toThrow('LIFECYCLE_NATIVE_SCOPE_REQUIRED')
  })
  it('refuses structural receipts, booleans and callbacks before effect or FD work', async () => {
    for (const capability of [null, true, { durable: true, root: true }, { withExclusive: async (callback: () => unknown) => callback() }]) {
      await expect(assertLifecycleRootSafetyHeld(capability, { effect: 'filesystem.write' })).rejects.toThrow('LIFECYCLE_NATIVE_SCOPE_REQUIRED')
    }
    await expect(assertLifecycleRootSafetyHeld({}, { effect: 'unreviewed' } as never)).rejects.toThrow('LIFECYCLE_EFFECT_INVALID')
  })
  it.runIf(process.platform !== 'linux')('uses actual platform and UID rather than an environment or forged database', async () => {
    let reads = 0
    const db = { transaction: () => { reads++; throw new Error('not reached') } }
    await expect(createNativeUpgradeSafety({ db, actorId: 'root', operation: 'upgrade' } as never)).rejects.toThrow('LINUX_ROOT_REQUIRED')
    expect(reads).toBe(0)
  })
  it('validates durable head syntax and keeps unissued references explicit', () => {
    const head = { schemaVersion: 1, issuerId: '12345678-1234-4234-8234-123456789abc', sequence: 1, phase: 'pending', operationId: '12345678-1234-4234-8234-123456789abc', reference: null, kind: 'upgrade', requestFingerprint: 'a'.repeat(64), updatedAt: '2026-10-24T12:00:00.000Z' }
    expect(parseLifecycleHead(head).reference).toBeNull()
    for (const wrong of [{ ...head, phase: 'done' }, { ...head, sequence: -1 }, { ...head, requestFingerprint: 'bad' }, { ...head, reference: head.operationId }, { ...head, extra: true }]) expect(() => parseLifecycleHead(wrong)).toThrow()
  })
})
