import { describe, expect, it } from 'vitest'
import { defaultPlan, type Account } from '@xpanel/core'
import { FakeHostExecutor, type AccountSliceMetrics } from './executor.ts'
import { compareAccountLimits, observeHostLimits, parseRepquota, type ObservedAccountLimits } from './limit-gaps.ts'

const plan = defaultPlan({ id: 'plan', name: 'Standard', featureListId: 'features' })
const resources = { ...plan.resources, memoryMb: 1024, maxProcesses: 64, cpuPercent: 150, diskMb: 2048, ioReadBps: 1000, ioWriteBps: 2000, ioReadIops: 30, ioWriteIops: 40 }
const caps = (): ObservedAccountLimits => ({ memoryMax: '1073741824', pidsMax: '64', cpuMax: '150000 100000', ioMax: '8:2 rbps=1000 wbps=2000 riops=30 wiops=40', diskQuotaHardKb: 2097152, ioDevices: ['/dev/block/8:2'] })
const account = { id: 'account', username: 'alice', uid: 20001, home: '/home/alice', planId: plan.id, status: 'active' } as Account
const quota = (hard: string) => `*** Report for user quotas on device /dev/sda2\nBlock limits\nUser used soft hard grace\nalice -- 100 0 ${hard} 0 0 0\n`

describe('assigned plan versus observed host caps', () => {
  it('accepts only matching quantities, units, CPU ratios and all four IO dimensions', () => {
    expect(compareAccountLimits(resources, caps())).toEqual({ gaps: [], unavailable: false })
    expect(compareAccountLimits(resources, { ...caps(), cpuMax: '300000 200000' })).toEqual({ gaps: [], unavailable: false })
    expect(compareAccountLimits(resources, { ...caps(), memoryMax: '1024', pidsMax: '128', cpuMax: '100000 100000', diskQuotaHardKb: 2048, ioMax: '8:2 rbps=1000 wbps=2 riops=30 wiops=40' })).toEqual({ gaps: ['memory', 'pids', 'io', 'cpu', 'disk'], unavailable: false })
  })

  it.each(['8:9 rbps=1000 wbps=2000 riops=30 wiops=40', '8:2 rbps=1000 wbps=2000 riops=30', '8:2 rbps=1000 wbps=max riops=30 wiops=40', '8:2 rbps=1000 wbps=2000 riops=30 wiops=41', '8:2 rbps=1000 wbps=2000 wbps=2000 riops=30 wiops=40'])('rejects wrong devices, partial, unlimited or mismatched IO caps: %s', ioMax => {
    expect(compareAccountLimits(resources, { ...caps(), ioMax }).gaps).toContain('io')
  })

  it('keeps missing/unread evidence unavailable and ignores explicitly unlimited assignments', () => {
    expect(compareAccountLimits(resources, null).unavailable).toBe(true)
    expect(compareAccountLimits(resources, { ...caps(), memoryMax: null }).unavailable).toBe(true)
    expect(compareAccountLimits(resources, { ...caps(), diskQuotaHardKb: null }).unavailable).toBe(true)
    expect(compareAccountLimits(resources, { ...caps(), ioDevices: null }).unavailable).toBe(true)
    for (const cpuMax of ['150000 0', '150000 invalid', '0 100000', 'max 100000']) expect(compareAccountLimits(resources, { ...caps(), cpuMax }).gaps).toContain('cpu')
    expect(compareAccountLimits({ ...resources, memoryMb: 'unlimited', ioWriteBps: 'unlimited' }, { ...caps(), memoryMax: 'max', ioMax: '8:2 rbps=1000 wbps=max riops=30 wiops=40' })).toEqual({ gaps: [], unavailable: false })
  })

  it('retains quota quantities and rejects unread or human-scaled quota reports', () => {
    expect(parseRepquota(quota('2097152'))?.get('alice')).toBe(2097152)
    expect(parseRepquota(quota('0'))?.get('alice')).toBe(0)
    expect(parseRepquota(quota('2G'))).toBeNull()
    expect(parseRepquota(quota('2097152').replace('Block limits', 'Block limits (MB)'))).toBeNull()
    expect(parseRepquota('permission denied')).toBeNull()
  })

  it('reports partial accounts, unread plans/slices and zero accounts without positive fallback', async () => {
    class Reader extends FakeHostExecutor {
      override async readSliceMetrics(): Promise<AccountSliceMetrics | null> { return { uid: 20001, cpuUsageUsec: 0, memoryCurrentBytes: 0, ioReadBytes: 0, ioWriteBytes: 0, pidsCurrent: 0, ...caps() } }
      override async runCommand() { return { ok: true, code: 0, stdout: quota('2097152'), stderr: '' } }
    }
    const reader = new Reader()
    for (const [path, content] of [['/proc/self/mountinfo', '1 0 8:2 / /home rw - ext4 /dev/sda2 rw\n'], ['/sys/fs/cgroup/cgroup.subtree_control', 'cpu memory io pids']]) reader.files.set(path!, { path: path!, content: content!, mode: 0o444, owner: 'root', group: 'root' })
    expect(await observeHostLimits(reader, [account], [{ ...plan, resources }], '/home')).toEqual({ status: 'verified', checkedAccounts: 1, unavailableAccounts: 0, gaps: [] })
    expect((await observeHostLimits(reader, [account], [], '/home')).status).toBe('unavailable')
    expect((await observeHostLimits(reader, [account, { ...account, id: 'missing', planId: 'missing' }], [{ ...plan, resources }], '/home'))).toMatchObject({ status: 'unavailable', checkedAccounts: 1, unavailableAccounts: 1 })
    expect((await observeHostLimits(reader, [], [plan], '/home')).status).toBe('unavailable')
    reader.readSliceMetrics = async () => { throw new Error('unread') }
    expect((await observeHostLimits(reader, [account], [{ ...plan, resources }], '/home')).status).toBe('unavailable')
  })
})
