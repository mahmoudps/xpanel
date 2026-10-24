import { describe, expect, it } from 'vitest'
import { FakeHostExecutor } from './executor.ts'
import { readAccountUsage } from './account-usage.ts'
import { defaultPlan } from '@xpanel/core'

describe('account usage sample', () => {
  it('requires the assigned IO quantities and home device instead of any numeric wbps', async () => {
    const executor = new FakeHostExecutor()
    executor.files.set('/proc/self/mountinfo', { path: '/proc/self/mountinfo', content: '1 0 8:2 / /home rw - ext4 /dev/sda2 rw\n', mode: 0o444, owner: 'root', group: 'root' })
    const resources = { ...defaultPlan({ id: 'plan', name: 'Standard', featureListId: 'features' }).resources, ioReadBps: 1000, ioWriteBps: 2000, ioReadIops: 30, ioWriteIops: 40 }
    const input = { username: 'demohost', uid: 20000, home: '/home/demohost', resources }
    const setIo = (ioMax: string | null) => executor.sliceMetrics.set(20000, { uid: 20000, cpuUsageUsec: 0, memoryCurrentBytes: 1234, ioReadBytes: 0, ioWriteBytes: 0, pidsCurrent: 4, ioMax })
    setIo('8:2 rbps=1000 wbps=1 riops=30 wiops=40')
    expect((await readAccountUsage(executor, input)).ioEnforced).toBe(false)
    setIo('8:9 rbps=1000 wbps=2000 riops=30 wiops=40')
    expect((await readAccountUsage(executor, input)).ioEnforced).toBe(false)
    setIo('8:2 rbps=1000 wbps=2000 riops=30 wiops=40')
    expect((await readAccountUsage(executor, { username: input.username, uid: input.uid, home: input.home })).ioEnforced).toBeNull()
    expect((await readAccountUsage(executor, input)).ioEnforced).toBe(true)
    setIo(null)
    expect((await readAccountUsage(executor, input)).ioEnforced).toBeNull()
    setIo('8:2 rbps=1000 wbps=2000 riops=30 wiops=40')
    executor.files.delete('/proc/self/mountinfo')
    expect((await readAccountUsage(executor, input)).ioEnforced).toBeNull()
  })

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
      ioEnforced: null,
    })
    const wrongHome = await readAccountUsage(executor, { username: 'demohost', uid: 20000, home: '/tmp/demohost' })
    expect(wrongHome.diskBytes).toBeNull()
    expect(wrongHome.phpVersion).toBeNull()
    expect(wrongHome.bandwidth).toBe('unmeasured')
    executor.sliceMetrics.set(20000, {
      uid: 20000,
      cpuUsageUsec: 0,
      memoryCurrentBytes: 120_000_000,
      ioReadBytes: 0,
      ioWriteBytes: 0,
      pidsCurrent: 4,
      ioMax: '8:0 rbps=max wbps=50000000\n',
    })
    expect((await readAccountUsage(executor, { username: 'demohost', uid: 20000, home: '/home/demohost' })).ioEnforced).toBeNull()
    executor.sliceMetrics.set(20000, {
      uid: 20000,
      cpuUsageUsec: 0,
      memoryCurrentBytes: 120_000_000,
      ioReadBytes: 0,
      ioWriteBytes: 0,
      pidsCurrent: 4,
      ioMax: '8:0 wbps=max\n',
    })
    expect((await readAccountUsage(executor, { username: 'demohost', uid: 20000, home: '/home/demohost' })).ioEnforced).toBeNull()
  })
})
