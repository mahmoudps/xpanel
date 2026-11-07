import { describe, expect, it } from 'vitest'
import { readQuotaUsageReply, resellerUsage } from './reseller-usage.ts'

const report = (accounts: { username: string; totalBytes: number | null }[], state: 'read' | 'unavailable' = 'read') => ({ state, month: '2026-11', since: null, updatedAt: '2026-11-07T09:00:00.000Z', sources: {} as never, pendingBytes: 0, unavailableSites: 0, skippedLines: 0,
  accounts: accounts.map(a => ({ username: a.username, domain: 'x.test', status: 'active' as const, month: {} as never, totalBytes: a.totalBytes, limitBytes: null, usedPercent: null, limitState: 'unmeasured' as const, enforced: false, limited: false, customLimit: false, reliefThrough: null })) })

describe('measured reseller usage', { tags: ['unit'] }, () => {
  const resellers = [{ id: 'r1' }, { id: 'r2' }]
  const accounts = [{ ownerId: 'r1', username: 'alice' }, { ownerId: 'r1', username: 'bob' }, { ownerId: null, username: 'rootacct' }]
  it('totals owned accounts and counts the ones a source does not list', () => {
    const quota = readQuotaUsageReply({ state: 'read', observedAt: '2026-11-07T10:00:00.000Z', users: [{ username: 'alice', usedBytes: 100 }, { username: 'rootacct', usedBytes: 5 }] })
    const usage = resellerUsage(resellers, accounts, quota, report([{ username: 'alice', totalBytes: 10 }, { username: 'bob', totalBytes: null }]))
    expect(usage.r1).toEqual({ accounts: 2, disk: { state: 'read', bytes: 100, observedAt: '2026-11-07T10:00:00.000Z', unmeasured: 1 }, traffic: { state: 'read', bytes: 10, observedAt: '2026-11-07T09:00:00.000Z', unmeasured: 1, month: '2026-11' } })
    expect(usage.r2).toMatchObject({ accounts: 0, disk: { bytes: 0, unmeasured: 0 } })
  })
  it('is unavailable, never zero, when a source is missing or unverifiable', () => {
    expect(readQuotaUsageReply({ state: 'unavailable', observedAt: '2026-11-07T10:00:00.000Z', users: [] })).toBeNull()
    expect(readQuotaUsageReply({ state: 'read', observedAt: 'yesterday', users: [] })).toBeNull()
    const usage = resellerUsage(resellers, accounts, null, report([], 'unavailable'))
    expect(usage.r1).toEqual({ accounts: 2, disk: { state: 'unavailable', bytes: null, observedAt: null, unmeasured: 2 }, traffic: { state: 'unavailable', bytes: null, observedAt: null, unmeasured: 2, month: '2026-11' } })
  })
})
