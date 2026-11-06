import { describe, expect, it } from 'vitest'
import { defaultPlan, type ResourceLimits } from '@xpanel/core'
import { system } from '@xpanel/render'
import { FakeHostExecutor } from './executor.ts'
import { ioDevicesByAccount, ioDiskForDevice, ioDiskForMount, resolveAccountIoDevices } from './io-device.ts'
import { compareAccountLimits } from './limit-gaps.ts'

const root = '1 0 8:1 / / rw - ext4 /dev/sda1 rw\n'
const mount = (device: string, point: string, fs = 'ext4'): string => `2 1 ${device} / ${point} rw - ${fs} source rw\n`
const uevent = (device: string, name: string, partition?: number): Record<string, string> => ({
  [`/sys/dev/block/${device}/uevent`]: `MAJOR=${device.split(':')[0]}\nMINOR=${device.split(':')[1]}\nDEVNAME=${name}\nDEVTYPE=${partition ? 'partition' : 'disk'}\n${partition ? `PARTN=${partition}\n` : ''}`,
})
const disk = (device: string, name: string): Record<string, string> => ({ ...uevent(device, name), [`/sys/block/${name}/dev`]: `${device}\n` })
const part = (device: string, name: string, parent: string, partition: number): Record<string, string> => ({ ...uevent(device, name, partition), [`/sys/block/${parent}/${name}/dev`]: `${device}\n` })
const partitions = (...names: string[]): Record<string, string> => ({ '/proc/partitions': `major minor  #blocks  name\n\n${names.map(name => `   8        0   1000 ${name}`).join('\n')}\n` })
const reader = (files: Record<string, string>) => ({ readFile: async (path: string) => files[path] ?? null })
const sda = { ...disk('8:0', 'sda'), ...part('8:1', 'sda1', 'sda', 1), ...part('8:2', 'sda2', 'sda', 2) }
const sdb = { ...disk('8:16', 'sdb'), ...part('8:17', 'sdb1', 'sdb', 1) }

describe('account IO mount identity', () => {
  it('uses the longest covering mount with path-component boundaries and escaped spaces', async () => {
    const host = reader({ ...sda, ...sdb })
    expect(await ioDiskForMount(host, root + mount('8:17', '/home'), '/home/alice')).toBe('/dev/block/8:16')
    expect(await ioDiskForMount(host, root + mount('8:17', '/home'), '/home2/alice')).toBe('/dev/block/8:0')
    expect(await ioDiskForMount(host, root + mount('8:17', '/home\\040data'), '/home data/alice')).toBe('/dev/block/8:16')
    expect(await ioDiskForMount(host, root, '/home/../root')).toBeNull()
  })

  it.each([['0:12', 'tmpfs'], ['0:40', 'nfs4'], ['0:9', 'overlay'], ['bad', 'ext4'], ['8:9', 'nfs']])('never falls back to root beneath an unsupported %s %s mount', async (device, fs) => {
    expect(await ioDiskForMount(reader(sda), root + mount(device, '/home', fs), '/home/alice')).toBeNull()
  })

  it('maps each account independently and excludes terminating accounts', async () => {
    const devices = await ioDevicesByAccount(reader(sda), root + mount('0:7', '/home/alice', 'tmpfs'), [
      { id: 'a', username: 'alice', home: '/home/alice' },
      { id: 'b', username: 'bob', home: '/home/bob' },
      { id: 'c', username: 'carol', status: 'terminating' },
    ], '/home')
    expect([...devices]).toEqual([['a', []], ['b', ['/dev/block/8:0']]])
  })

  it('requires readable mount data and IO delegation without performing writes', async () => {
    const executor = new FakeHostExecutor()
    for (const [path, content] of Object.entries({ '/proc/self/mountinfo': root, ...sda })) executor.files.set(path, { path, content, mode: 0o444, owner: 'root', group: 'root' })
    expect(await resolveAccountIoDevices(executor, [{ id: 'a', username: 'alice' }], '/home')).toBeNull()
    executor.files.set('/sys/fs/cgroup/cgroup.subtree_control', { path: '/sys/fs/cgroup/cgroup.subtree_control', content: 'cpu memory io pids', mode: 0o444, owner: 'root', group: 'root' })
    expect((await resolveAccountIoDevices(executor, [{ id: 'a', username: 'alice' }], '/home'))?.get('a')).toEqual(['/dev/block/8:0'])
    expect(executor.executedActions).toEqual([])
  })
})

describe('whole-disk IO identity', () => {
  it.each([
    ['SCSI/SATA', sda, '8:1', '8:0'],
    ['virtio', { ...disk('252:0', 'vda'), ...part('252:3', 'vda3', 'vda', 3) }, '252:3', '252:0'],
    ['NVMe', { ...disk('259:0', 'nvme0n1'), ...part('259:2', 'nvme0n1p2', 'nvme0n1', 2) }, '259:2', '259:0'],
    ['MMC', { ...disk('179:0', 'mmcblk0'), ...part('179:1', 'mmcblk0p1', 'mmcblk0', 1) }, '179:1', '179:0'],
    ['Xen disk ending in p', { ...disk('202:240', 'xvdp'), ...part('202:241', 'xvdp1', 'xvdp', 1) }, '202:241', '202:240'],
  ])('maps a %s partition to the whole disk the kernel accepts in io.max', async (_family, files, device, whole) => {
    expect(await ioDiskForDevice(reader(files), device)).toBe(whole)
  })

  it('follows device-mapper stacks to one origin disk like systemd, and keeps a multi-disk device itself', async () => {
    const table = partitions('sda', 'sda1', 'sda2', 'sdb', 'sdb1', 'dm-0', 'dm-1', 'dm-2')
    const stack = { ...sda, ...sdb, ...table, ...disk('253:0', 'dm-0'), ...disk('253:1', 'dm-1'), ...disk('253:2', 'dm-2'),
      '/sys/dev/block/253:0/slaves/sda2/dev': '8:2\n', '/sys/dev/block/253:1/slaves/dm-0/dev': '253:0\n',
      '/sys/dev/block/253:2/slaves/sda2/dev': '8:2\n', '/sys/dev/block/253:2/slaves/sdb1/dev': '8:17\n' }
    expect(await ioDiskForDevice(reader(stack), '253:0')).toBe('8:0')
    expect(await ioDiskForDevice(reader(stack), '253:1')).toBe('8:0')
    expect(await ioDiskForDevice(reader(stack), '253:2')).toBe('253:2')
    expect(await ioDiskForDevice(reader(stack), '8:16')).toBe('8:16')
    const verity: Record<string, string> = { ...stack, '/sys/dev/block/253:2/slaves/sda1/dev': '8:1\n' }
    delete verity['/sys/dev/block/253:2/slaves/sdb1/dev']
    expect(await ioDiskForDevice(reader(verity), '253:2')).toBe('8:0')
  })

  it('refuses a device sysfs cannot prove instead of guessing', async () => {
    expect(await ioDiskForDevice(reader({}), '8:1')).toBeNull()
    expect(await ioDiskForDevice(reader({ ...sda, ...uevent('8:1', 'sda2', 2) }), '8:1')).toBeNull()
    expect(await ioDiskForDevice(reader({ ...uevent('8:1', 'sda1', 1), ...disk('8:0', 'sda') }), '8:1')).toBeNull()
    expect(await ioDiskForDevice(reader({ ...sda, ...disk('253:0', 'dm-0') }), '253:0')).toBeNull()
    expect(await ioDiskForDevice({ readFile: async () => { throw new Error('denied') } }, '8:1')).toBeNull()
  })

  it('renders IO*Max= for the same whole disk the io.max comparison reads', async () => {
    const executor = new FakeHostExecutor()
    for (const [path, content] of Object.entries({ '/proc/self/mountinfo': root, '/sys/fs/cgroup/cgroup.subtree_control': 'cpu memory io pids', ...sda })) executor.files.set(path, { path, content, mode: 0o444, owner: 'root', group: 'root' })
    const devices = (await resolveAccountIoDevices(executor, [{ id: 'a', username: 'alice' }], '/home'))!.get('a')!
    const resources: ResourceLimits = { ...defaultPlan({ id: 'plan', name: 'Standard', featureListId: 'features' }).resources, memoryMb: 'unlimited', maxProcesses: 'unlimited', cpuPercent: 'unlimited', diskMb: 'unlimited',
      ioReadBps: 50000000, ioWriteBps: 50000000, ioReadIops: 2000, ioWriteIops: 2000 }
    // systemd writes one io.max row per device an IO*Max= line names.
    const keys = { IOReadBandwidthMax: 'rbps', IOWriteBandwidthMax: 'wbps', IOReadIOPSMax: 'riops', IOWriteIOPSMax: 'wiops' } as Record<string, string>
    const rows = new Map<string, string[]>()
    for (const line of system.sliceBodyLines(resources, devices)) {
      const io = /^(IO\w+Max)=\/dev\/block\/(\d+:\d+) (\d+)$/.exec(line)
      if (io) rows.set(io[2]!, [...rows.get(io[2]!) ?? [], `${keys[io[1]!]}=${io[3]}`])
    }
    expect([...rows.keys()]).toEqual(['8:0'])
    const ioMax = [...rows].map(([device, values]) => `${device} ${values.join(' ')}`).join('\n')
    expect(compareAccountLimits(resources, { memoryMax: null, pidsMax: null, cpuMax: null, diskQuotaHardKb: null, ioMax, ioDevices: devices })).toEqual({ gaps: [], unavailable: false })
    expect(compareAccountLimits(resources, { memoryMax: null, pidsMax: null, cpuMax: null, diskQuotaHardKb: null, ioMax: ioMax.replace('8:0', '8:1'), ioDevices: devices }).gaps).toEqual(['io'])
  })
})
