import { describe, expect, it } from 'vitest'
import { FakeHostExecutor } from './executor.ts'
import { readAccountUsage } from './account-usage.ts'

describe('account usage sample', () => {
  it('reads the active PHP unit, du, and the account slice, and leaves bandwidth unmeasured', async () => {
    const executor = new FakeHostExecutor()
    executor.failCommand('xpanel-php-fpm-demohost-8.3.service', 0, '', 'active\n')
    executor.failCommand('/usr/bin/du', 0, '', '1500000000\t/home/demohost\n')
    executor.sliceMetrics.set(20000, {
      uid: 20000,
      cpuUsageUsec: 0,
      memoryCurrentBytes: 120_000_000,
      ioReadBytes: 0,
      ioWriteBytes: 0,
      pidsCurrent: 4,
    })
    const sample = await readAccountUsage(executor, { username: 'demohost', uid: 20000, home: '/home/demohost' })
    expect(sample).toEqual({
      phpVersion: '8.3',
      diskBytes: 1_500_000_000,
      memoryBytes: 120_000_000,
      processCount: 4,
      bandwidth: 'unmeasured',
    })
    const wrongHome = await readAccountUsage(executor, { username: 'demohost', uid: 20000, home: '/tmp/demohost' })
    expect(wrongHome.diskBytes).toBeNull()
    expect(wrongHome.phpVersion).toBeNull()
    expect(wrongHome.bandwidth).toBe('unmeasured')
  })
})
