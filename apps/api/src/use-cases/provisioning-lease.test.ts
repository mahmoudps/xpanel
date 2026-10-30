import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DurableJobRecord } from '@xpanel/db'
import { ProvisioningLease } from './provisioning-lease.ts'

const lease = (patch: Partial<DurableJobRecord> = {}) => ({ id: 'operation', leaseOwner: 'worker', fencingToken: 3,
  status: 'running', cancelRequested: false, needsAttention: false, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), ...patch }) as DurableJobRecord
afterEach(() => vi.useRealTimers())
describe('provisioning lease renewal authority', { tags: ['unit'] }, () => {
  it('rejects a changed fence before the caller can acknowledge any work', async () => {
    const guard = new ProvisioningLease(lease(), async () => lease({ fencingToken: 4 }))
    await expect(guard.assert()).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(guard.abort.signal.aborted).toBe(true)
    await expect(guard.stop()).rejects.toMatchObject({ code: 'CONFLICT' })
  })
  it('renews a running operation and settles its heartbeat before completion', async () => {
    vi.useFakeTimers()
    let finish!: (value: DurableJobRecord) => void
    const renew = vi.fn(() => new Promise<DurableJobRecord>(resolve => { finish = resolve }))
    const guard = new ProvisioningLease(lease(), renew)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(renew).toHaveBeenCalledTimes(1)
    let stopped = false
    const stopping = guard.stop().then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    finish(lease())
    await stopping
    await vi.advanceTimersByTimeAsync(120_000)
    expect(renew).toHaveBeenCalledTimes(1)
  })
  it('poisons later assertions after a failed database renewal', async () => {
    const renew = vi.fn(async () => { throw new Error('database lease lost') })
    const guard = new ProvisioningLease(lease(), renew)
    await expect(guard.assert()).rejects.toThrow('database lease lost')
    await expect(guard.assert()).rejects.toThrow('database lease lost')
    expect(renew).toHaveBeenCalledTimes(1)
    expect(guard.abort.signal.aborted).toBe(true)
    await expect(guard.stop()).rejects.toThrow('database lease lost')
  })
  it.each([{ cancelRequested: true }, { needsAttention: true }, { leaseOwner: 'another-worker' },
    { leaseExpiresAt: new Date(0).toISOString() }])('rejects invalid active authority %j', async patch => {
    const guard = new ProvisioningLease(lease(), async () => lease(patch))
    await expect(guard.assert()).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(guard.stop()).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})
