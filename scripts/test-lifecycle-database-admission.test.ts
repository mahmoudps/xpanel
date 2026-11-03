import { describe, expect, it } from 'vitest'
import { assertNativeClosedDatabaseRecoveryScopeHeld, assertLifecycleBootstrapHeld, getNativeClosedDatabaseObservationInfo } from './lifecycle-root-safety.mjs'
import { assertLifecycleBootstrapExclusivePhysicalHeld, getLifecycleClosedDatabaseObservationInfo } from './lifecycle-admission.mjs'

describe('native DB admission rejects unissued observations before invoking supplied methods', () => {
  it('refuses request objects, copied info and caller callbacks as capabilities', async () => {
    let invoked = false
    const fake = { purpose: 'closed-database-observation', database: { file: '/var/lib/xpanel/control.db', device: '1', inode: '2', issuerId: '11111111-1111-4111-8111-111111111111' },
      assertCurrent() { invoked = true }, withReadonlyDatabase() { invoked = true } }
    await expect(assertNativeClosedDatabaseRecoveryScopeHeld(fake)).rejects.toThrow('LIFECYCLE_CLOSED_RECOVERY_VIEW_REQUIRED')
    await expect(assertLifecycleBootstrapHeld(fake)).rejects.toThrow('LIFECYCLE_BOOTSTRAP_SCOPE_REQUIRED')
    await expect(assertLifecycleBootstrapExclusivePhysicalHeld(fake)).rejects.toThrow('LIFECYCLE_BOOTSTRAP_EXCLUSIVE_REQUIRED')
    expect(() => getNativeClosedDatabaseObservationInfo(fake)).toThrow()
    expect(() => getLifecycleClosedDatabaseObservationInfo(fake)).toThrow()
    expect(invoked).toBe(false)
  })
})
