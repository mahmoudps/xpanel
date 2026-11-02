import { describe, expect, it } from 'vitest'
import { defaultPlan, type Account } from '@xpanel/core'
import { allocated } from './reseller-allocation.ts'
const plan = defaultPlan({ id: 'stored-plan' })
const account: Account = { id: 'stored-account', username: 'alice', uid: 1001, gid: 1001, home: '/home/alice', primaryDomain: 'alice.example.test', planId: plan.id, ownerId: null, status: 'active', suspendReason: null, contactEmail: 'alice@example.test', ipv4: '192.0.2.1', shell: 'none', createdAt: '2026-01-01T00:00:00Z' }
describe('stored reseller allocation projection', () => {
  it('keeps unread or missing referenced plans unknown', () => {
    expect(allocated(undefined, [plan], 'diskMb')).toBeUndefined()
    expect(allocated([account], undefined, 'diskMb')).toBeUndefined()
    expect(allocated([account], [], 'diskMb')).toBeUndefined()
  })
  it('retains known empty assignment as zero and sums only assigned plan limits', () => {
    expect(allocated([], [plan], 'diskMb')).toBe(0)
    expect(allocated([account, { ...account, id: 'second' }], [plan], 'diskMb')).toBe(10240)
  })
  it('preserves an unlimited allocation rather than interpreting it as a numeric zero', () => {
    expect(allocated([account], [{ ...plan, resources: { ...plan.resources, diskMb: 'unlimited' } }], 'diskMb')).toBe('unlimited')
  })
  it('rejects overflow rather than presenting an inaccurate total', () => {
    expect(allocated([account, { ...account, id: 'second' }], [{ ...plan, resources: { ...plan.resources, diskMb: Number.MAX_SAFE_INTEGER } }], 'diskMb')).toBeUndefined()
  })
})
