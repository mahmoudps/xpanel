import { describe, expect, it } from 'vitest'
import { FakeHostExecutor } from './executor.ts'
import { parseRepquotaUsage, readQuotaUsage } from './quota-usage.ts'

const REPORT = `*** Report for user quotas on device /dev/sda1
Block grace time: 7days; Inode grace time: 7days
                        Block limits                File limits
User            used    soft    hard  grace    used  soft  hard  grace
----------------------------------------------------------------------
root      --  1024       0       0              5     0     0
alice     +-  2048    1000    2000  6days      10     0     0
bob       --     0  512000  512000              1     0     0
`

describe('user quota usage report', { tags: ['unit'] }, () => {
  it('reads used KiB per user as bytes and refuses other units or duplicates', () => {
    expect(parseRepquotaUsage(REPORT)).toEqual([{ username: 'root', usedBytes: 1048576 }, { username: 'alice', usedBytes: 2097152 }, { username: 'bob', usedBytes: 0 }])
    expect(parseRepquotaUsage(REPORT.replace('Block limits', 'Block limits (MiB)'))).toBeNull()
    expect(parseRepquotaUsage(REPORT + 'alice -- 1 0 0 0 0 0\n')).toBeNull()
    expect(parseRepquotaUsage('quota: no report')).toBeNull()
  })
  it('is unavailable without a mount for the home filesystem', async () => {
    const read = await readQuotaUsage(new FakeHostExecutor(), '/home', new Date('2026-11-07T10:00:00.000Z'))
    expect(read).toEqual({ state: 'unavailable', reason: 'quota_unavailable', observedAt: '2026-11-07T10:00:00.000Z', users: [] })
  })
})
