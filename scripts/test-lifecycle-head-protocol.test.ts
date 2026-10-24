import { describe, expect, it } from 'vitest'
import { parseLifecycleBarrier, assertLifecycleExclusivePhysicalHeld } from './lifecycle-admission.mjs'

const pending = { schemaVersion: 1, operationId: '12345678-1234-4234-8234-123456789abc', reference: 'XP-JOB-2026-000001', kind: 'upgrade', phase: 'pending', requestFingerprint: 'a'.repeat(64), sequence: 1, createdAt: '2026-10-24T12:00:00.000Z' }
describe('permanent lifecycle barriers', () => {
  it.each(['pending', 'retirement_pending', 'attention'])('retains %s as a blocking state', phase => {
    expect(parseLifecycleBarrier({ ...pending, phase }).phase).toBe(phase)
  })
  it('does not turn old, partial, unissued or structurally signed records into retirement authority', async () => {
    expect(parseLifecycleBarrier({ ...pending, reference: null }).reference).toBeNull()
    for (const value of [{ ...pending, phase: 'committed' }, { ...pending, phase: 'idle' }, { ...pending, sequence: 0 }, { ...pending, createdAt: 'bad' }, { ...pending, signature: 'a'.repeat(64) }, { ...pending, reference: pending.operationId }]) expect(() => parseLifecycleBarrier(value)).toThrow()
    await expect(assertLifecycleExclusivePhysicalHeld({ fd: 3, exclusive: true, receipt: pending })).rejects.toThrow('LIFECYCLE_EXCLUSIVE_CAPABILITY_REQUIRED')
  })
})
