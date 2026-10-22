import { describe, expect, it } from 'vitest'
import { RESOURCE_RULES, XpanelError } from '@xpanel/core'
import {
  parseCgroupControllers,
  SLICE_BOUNDS,
  sliceControlDirs,
  renderAccountSlice,
  sliceEnforcement,
  sliceProperties,
  sliceUpdateActions,
} from './slice.ts'
import { limited, makeAccount, unitValues, unlimited } from './testkit.ts'

const account = makeAccount()
const noIo = { cpu: true, memory: true, pids: true, io: false }

describe('renderAccountSlice', () => {
  it('writes xpanel-<uid>.slice with every limit of a limited plan', () => {
    const f = renderAccountSlice(account, limited, ['/dev/sda'])
    expect(f.path).toBe('/etc/systemd/system/xpanel-1001.slice')
    expect(f.mode).toBe(0o644)
    expect(f.content).toContain('[Slice]\n')
    expect(unitValues(f.content, 'MemoryMax')).toEqual(['1024M'])
    expect(unitValues(f.content, 'MemoryHigh')).toEqual(['921M'])
    // swap would let the account hold its plan memory twice over
    expect(unitValues(f.content, 'MemorySwapMax')).toEqual(['0'])
    expect(unitValues(f.content, 'TasksMax')).toEqual(['100'])
    expect(unitValues(f.content, 'CPUQuota')).toEqual(['150%'])
    expect(unitValues(f.content, 'IOAccounting')).toEqual(['yes'])
    expect(unitValues(f.content, 'IOReadBandwidthMax')).toEqual(['/dev/sda 10485760'])
    expect(unitValues(f.content, 'IOWriteBandwidthMax')).toEqual(['/dev/sda 5242880'])
    expect(unitValues(f.content, 'IOReadIOPSMax')).toEqual(['/dev/sda 1000'])
    expect(unitValues(f.content, 'IOWriteIOPSMax')).toEqual(['/dev/sda 500'])
  })

  it('writes one IO line per device and maps major:minor to /dev/block', () => {
    const f = renderAccountSlice(account, limited, ['/dev/sda', '259:0', '/dev/mapper/vg-home', '/dev/sda'])
    expect(unitValues(f.content, 'IOReadBandwidthMax')).toEqual([
      '/dev/sda 10485760',
      '/dev/block/259:0 10485760',
      '/dev/mapper/vg-home 10485760',
    ])
    expect(unitValues(f.content, 'IOWriteIOPSMax')).toHaveLength(3)
  })

  it('makes unlimited explicit: infinity for memory and tasks, no CPU or IO line', () => {
    const f = renderAccountSlice(account, unlimited, ['/dev/sda'])
    expect(unitValues(f.content, 'MemoryMax')).toEqual(['infinity'])
    expect(unitValues(f.content, 'MemoryHigh')).toEqual(['infinity'])
    expect(unitValues(f.content, 'MemorySwapMax')).toEqual(['infinity'])
    expect(unitValues(f.content, 'TasksMax')).toEqual(['infinity'])
    expect(unitValues(f.content, 'CPUQuota')).toEqual([])
    expect(f.content).not.toMatch(/^IO(Read|Write)/m)
    expect(unitValues(f.content, 'IOAccounting')).toEqual(['yes'])
  })

  it('mixes limited and unlimited fields independently', () => {
    const f = renderAccountSlice(account, { ...limited, ioWriteBps: 'unlimited', cpuPercent: 'unlimited' }, ['/dev/vda'])
    expect(unitValues(f.content, 'IOReadBandwidthMax')).toEqual(['/dev/vda 10485760'])
    expect(unitValues(f.content, 'IOWriteBandwidthMax')).toEqual([])
    expect(unitValues(f.content, 'CPUQuota')).toEqual([])
  })

  it('omits all IO settings when the io controller is missing', () => {
    const f = renderAccountSlice(account, limited, ['/dev/sda'], { controllers: noIo })
    expect(f.content).not.toContain('IO')
    expect(unitValues(f.content, 'MemoryMax')).toEqual(['1024M'])
  })

  it('takes the unit directory from the OS profile path when given', () => {
    expect(renderAccountSlice(account, limited, [], { systemdDir: '/usr/local/lib/systemd/system' }).path).toBe('/usr/local/lib/systemd/system/xpanel-1001.slice')
    expect(() => renderAccountSlice(account, limited, [], { systemdDir: '../etc' })).toThrowError(XpanelError)
  })

  it('accepts boundary values and rejects values just past them', () => {
    const edge = { ...limited, memoryMb: 64, maxProcesses: 10, cpuPercent: 1, ioReadBps: 1024 * 1024, ioReadIops: 10 }
    expect(unitValues(renderAccountSlice(account, edge, ['/dev/sda']).content, 'MemoryHigh')).toEqual(['57M'])
    for (const bad of [
      { memoryMb: 63 }, { memoryMb: 0 }, { maxProcesses: 9 }, { cpuPercent: 0 }, { ioReadBps: 1024 * 1024 - 1 }, { ioWriteIops: 9 },
      { memoryMb: 1.5 }, { memoryMb: -1 }, { memoryMb: '512' }, { memoryMb: Number.POSITIVE_INFINITY }, { cpuPercent: 409601 },
      { memoryMb: 2 ** 44 }, { maxProcesses: 4194305 },
    ]) {
      expect(() => renderAccountSlice(account, { ...limited, ...bad } as typeof limited, ['/dev/sda']), JSON.stringify(bad)).toThrowError(XpanelError)
    }
  })

  it('renders every value core plan validation accepts (same bounds as RESOURCE_RULES)', () => {
    for (const f of ['maxProcesses', 'cpuPercent', 'ioReadBps', 'ioWriteBps', 'ioReadIops', 'ioWriteIops'] as const) {
      expect(SLICE_BOUNDS[f].min, f).toBe(RESOURCE_RULES[f].min)
      expect(SLICE_BOUNDS[f].max, f).toBe(RESOURCE_RULES[f].max)
    }
    expect(SLICE_BOUNDS.memoryMb.min).toBe(RESOURCE_RULES.memoryMb.min)
    const top = {
      ...limited,
      cpuPercent: RESOURCE_RULES.cpuPercent.max,
      maxProcesses: RESOURCE_RULES.maxProcesses.max,
      ioReadBps: Number.MAX_SAFE_INTEGER,
      memoryMb: 2 ** 44 - 1,
    }
    const f = renderAccountSlice(account, top, ['/dev/sda'])
    expect(unitValues(f.content, 'CPUQuota')).toEqual(['409600%'])
    expect(unitValues(f.content, 'TasksMax')).toEqual(['4194304'])
    expect(unitValues(f.content, 'IOReadBandwidthMax')).toEqual([`/dev/sda ${Number.MAX_SAFE_INTEGER}`])
    expect(unitValues(f.content, 'MemoryMax')).toEqual([`${2 ** 44 - 1}M`])
  })

  it('rejects device strings that could inject unit lines or spaces', () => {
    for (const dev of ['/dev/sda\nMemoryMax=infinity', '/dev/sda 1', 'sda', '/dev/../etc/passwd', '/dev/', '/etc/fstab', '8:0:1', '', '/dev/sd%a']) {
      expect(() => renderAccountSlice(account, limited, [dev]), JSON.stringify(dev)).toThrowError(XpanelError)
    }
    expect(() => renderAccountSlice(account, limited, Array.from({ length: 17 }, (_, i) => `/dev/sd${String.fromCharCode(97 + i)}`))).toThrowError(XpanelError)
  })

  it('validates the account identity it names the slice after', () => {
    expect(() => renderAccountSlice(makeAccount({ uid: 999 }), limited, [])).toThrowError(XpanelError)
    expect(() => renderAccountSlice(makeAccount({ username: 'a\nb' }), limited, [])).toThrowError(XpanelError)
  })
})

describe('sliceProperties / sliceUpdateActions', () => {
  it('returns scalar limits first, then one map per device', () => {
    const [scalar, sda, sdb, ...rest] = sliceProperties(limited, ['/dev/sda', '/dev/sdb'])
    expect(scalar).toEqual({ MemoryHigh: '921M', MemoryMax: '1024M', MemorySwapMax: '0', TasksMax: '100', CPUQuota: '150%' })
    expect(sda).toEqual({
      IOReadBandwidthMax: '/dev/sda 10485760',
      IOWriteBandwidthMax: '/dev/sda 5242880',
      IOReadIOPSMax: '/dev/sda 1000',
      IOWriteIOPSMax: '/dev/sda 500',
    })
    expect(sdb?.IOReadBandwidthMax).toBe('/dev/sdb 10485760')
    expect(rest).toEqual([])
  })

  it('resets unlimited values at runtime instead of leaving the old limit', () => {
    const [scalar, dev] = sliceProperties(unlimited, ['/dev/sda'])
    expect(scalar).toEqual({ MemoryHigh: 'infinity', MemoryMax: 'infinity', MemorySwapMax: 'infinity', TasksMax: 'infinity', CPUQuota: '' })
    expect(dev).toEqual({
      IOReadBandwidthMax: '/dev/sda infinity',
      IOWriteBandwidthMax: '/dev/sda infinity',
      IOReadIOPSMax: '/dev/sda infinity',
      IOWriteIOPSMax: '/dev/sda infinity',
    })
  })

  it('wraps the maps as systemd-set-property actions on the account slice', () => {
    const actions = sliceUpdateActions(account, limited, ['/dev/sda'])
    expect(actions).toHaveLength(2)
    expect(actions.every((a) => a.kind === 'systemd-set-property' && a.unit === 'xpanel-1001.slice')).toBe(true)
    expect(sliceUpdateActions(account, limited, ['/dev/sda'], { controllers: { cpu: false, memory: false, pids: false, io: false } })).toEqual([])
  })
})

describe('sliceEnforcement', () => {
  it('marks every field applied with its systemd value', () => {
    const e = sliceEnforcement(limited, ['/dev/sda'])
    expect(e.memoryMb).toEqual({ applied: true, unlimited: false, value: '1024M' })
    expect(e.cpuPercent).toEqual({ applied: true, unlimited: false, value: '150%' })
    expect(e.ioWriteIops).toEqual({ applied: true, unlimited: false, value: '500' })
  })

  it('reports io fields as not enforced when the controller is unavailable', () => {
    const e = sliceEnforcement(limited, ['/dev/sda'], { controllers: noIo })
    for (const f of ['ioReadBps', 'ioWriteBps', 'ioReadIops', 'ioWriteIops'] as const) {
      expect(e[f]).toEqual({ applied: false, reason: 'controller-unavailable' })
    }
    expect(e.memoryMb.applied).toBe(true)
  })

  it('reports finite io limits without a device as not enforced, unlimited as applied', () => {
    const e = sliceEnforcement({ ...limited, ioReadBps: 'unlimited' }, [])
    expect(e.ioWriteBps).toEqual({ applied: false, reason: 'no-io-device' })
    expect(e.ioReadBps).toEqual({ applied: true, unlimited: true, value: 'infinity' })
  })
})

describe('sliceControlDirs', () => {
  it('names the persistent and runtime set-property drop-in directories of the slice', () => {
    expect(sliceControlDirs(1001)).toEqual(['/etc/systemd/system.control/xpanel-1001.slice.d', '/run/systemd/system.control/xpanel-1001.slice.d'])
  })
})

describe('parseCgroupControllers', () => {
  it('reads cgroup.controllers', () => {
    expect(parseCgroupControllers('cpuset cpu io memory hugetlb pids rdma misc\n')).toEqual({ cpu: true, memory: true, pids: true, io: true })
    expect(parseCgroupControllers('cpuset cpu memory pids')).toEqual({ cpu: true, memory: true, pids: true, io: false })
    expect(parseCgroupControllers('')).toEqual({ cpu: false, memory: false, pids: false, io: false })
  })
})
