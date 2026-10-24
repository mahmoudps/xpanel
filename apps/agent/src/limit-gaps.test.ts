import { describe, expect, it } from 'vitest'
import type { ResourceLimits } from '@xpanel/core'
import { gapsForAccount, parseRepquota, unionLimitGaps } from './limit-gaps.ts'

const plan: ResourceLimits = {
  diskMb: 10_240,
  bandwidthMbMonth: 102_400,
  ioReadBps: 50_000_000,
  ioWriteBps: 50_000_000,
  ioReadIops: 2000,
  ioWriteIops: 2000,
  memoryMb: 1024,
  maxProcesses: 64,
  cpuPercent: 200,
}

describe('per-account plan limits', () => {
  it('lists every finite limit the slice is not applying', () => {
    expect(gapsForAccount(plan, null)).toEqual(['memory', 'pids', 'io', 'cpu', 'disk'])
    expect(gapsForAccount(plan, {
      memoryMax: '1073741824',
      pidsMax: '64',
      cpuMax: '200000 100000',
      ioMax: '8:2 rbps=max wbps=50000000 riops=max wiops=max',
      diskQuota: true,
    })).toEqual([])
    expect(gapsForAccount(plan, {
      memoryMax: 'max',
      pidsMax: '64',
      cpuMax: 'max 100000',
      ioMax: null,
      diskQuota: false,
    })).toEqual(['memory', 'io', 'cpu', 'disk'])
  })

  it('unions account gaps in a stable order and reads repquota hard limits', () => {
    expect(unionLimitGaps([['disk', 'io'], ['memory']])).toEqual(['memory', 'io', 'disk'])
    const report = [
      '*** Report for user quotas on device /dev/sda2',
      'Block grace time: 7days',
      'User            used    soft    hard',
      'alice     --    1024       0   10485760',
      'bob       --     100       0          0',
    ].join('\n')
    expect([...(parseRepquota(report) ?? [])]).toEqual(['alice'])
    expect(parseRepquota('[jailshell] /usr/sbin/repquota -n -u /home')).toBeNull()
  })
})
