import { describe, expect, it } from 'vitest'
import { createNativeLifecycleCanary, type NativeLifecycleCanaryOptions } from './native-canary.ts'

describe('pre-admission canary selection is observation only', () => {
  it('never enters the readSnapshot orphan-recovery path before native authority', async () => {
    let recoveryReads = 0, observations = 0, assertions = 0
    const store = {
      readSnapshot: async () => { recoveryReads++; throw new Error('mutating orphan recovery must not run before admission') },
      withReadonlyObservation: async (work: (view: unknown) => Promise<unknown>) => {
        observations++
        return work({ snapshot: { accounts: [], domains: [] }, assertCurrent: async () => { assertions++ } })
      },
    }
    const options = { store } as unknown as NativeLifecycleCanaryOptions
    const selection = await createNativeLifecycleCanary(options).select()
    expect(selection.username).toBeNull()
    expect(recoveryReads).toBe(0)
    expect(observations).toBe(1)
    expect(assertions).toBe(2)
  })
  it('does not fall back to a repairing reader when coherent readonly observation refuses', async () => {
    let recoveryReads = 0
    const options = { store: {
      readSnapshot: async () => { recoveryReads++; return { accounts: [], domains: [] } },
      withReadonlyObservation: async () => { throw new Error('STATE_READONLY_ORPHAN_REVIEW_REQUIRED') },
    } } as unknown as NativeLifecycleCanaryOptions
    await expect(createNativeLifecycleCanary(options).select()).rejects.toThrow('STATE_READONLY_ORPHAN_REVIEW_REQUIRED')
    expect(recoveryReads).toBe(0)
  })
})
