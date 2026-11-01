import { describe, expect, it, vi } from 'vitest'
import { createAccountProvisioningRuntime, type AccountProvisioningRuntimeOptions } from './account-provisioning-runtime.ts'
import type { AgentAccountProvisioningRuntime } from './account-provisioning-handler.ts'

describe('native provisioning runtime admission', () => {
  it('refuses a missing independent workload observer before touching credentials, jobs or host state', async () => {
    const read = vi.fn(async () => { throw new Error('must not read private material') })
    const reconcile = vi.fn(async () => { throw new Error('must not mutate host state') })
    const principal = vi.fn(async () => { throw new Error('must not mint authority') })
    const runtime = createAccountProvisioningRuntime({ preparations: { read }, reconciler: { reconcile }, authorization: { principal } } as unknown as AccountProvisioningRuntimeOptions)
    await expect(runtime.execute({} as Parameters<AgentAccountProvisioningRuntime['execute']>[0], {
      signal: new AbortController().signal, async assertAuthority() { throw new Error('not an availability substitute') },
    })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: false, reason: 'account_provisioning_native_observer_unavailable' } })
    expect(read).not.toHaveBeenCalled()
    expect(reconcile).not.toHaveBeenCalled()
    expect(principal).not.toHaveBeenCalled()
  })
})
