import { describe, expect, it } from 'vitest'
import { FakeHostExecutor } from './executor.ts'
import { ioDeviceForMount, ioDevicesByAccount, resolveAccountIoDevices } from './io-device.ts'

const root = '1 0 8:1 / / rw - ext4 /dev/sda1 rw\n'
const mount = (device: string, point: string, fs = 'ext4'): string => `2 1 ${device} / ${point} rw - ${fs} source rw\n`

describe('account IO mount identity', () => {
  it('uses the longest covering mount with path-component boundaries and escaped spaces', () => {
    expect(ioDeviceForMount(root + mount('8:2', '/home'), '/home/alice')).toBe('/dev/block/8:2')
    expect(ioDeviceForMount(root + mount('8:2', '/home'), '/home2/alice')).toBe('/dev/block/8:1')
    expect(ioDeviceForMount(root + mount('8:3', '/home\\040data'), '/home data/alice')).toBe('/dev/block/8:3')
    expect(ioDeviceForMount(root, '/home/../root')).toBeNull()
  })

  it.each([['0:12', 'tmpfs'], ['0:40', 'nfs4'], ['0:9', 'overlay'], ['bad', 'ext4'], ['8:9', 'nfs']])('never falls back to root beneath an unsupported %s %s mount', (device, fs) => {
    expect(ioDeviceForMount(root + mount(device, '/home', fs), '/home/alice')).toBeNull()
  })

  it('maps each account independently and excludes terminating accounts', () => {
    const devices = ioDevicesByAccount(root + mount('0:7', '/home/alice', 'tmpfs'), [
      { id: 'a', username: 'alice', home: '/home/alice' },
      { id: 'b', username: 'bob', home: '/home/bob' },
      { id: 'c', username: 'carol', status: 'terminating' },
    ], '/home')
    expect([...devices]).toEqual([['a', []], ['b', ['/dev/block/8:1']]])
  })

  it('requires readable mount data and IO delegation without performing writes', async () => {
    const executor = new FakeHostExecutor()
    executor.files.set('/proc/self/mountinfo', { path: '/proc/self/mountinfo', content: root, mode: 0o444, owner: 'root', group: 'root' })
    expect(await resolveAccountIoDevices(executor, [{ id: 'a', username: 'alice' }], '/home')).toBeNull()
    executor.files.set('/sys/fs/cgroup/cgroup.subtree_control', { path: '/sys/fs/cgroup/cgroup.subtree_control', content: 'cpu memory io pids', mode: 0o444, owner: 'root', group: 'root' })
    expect((await resolveAccountIoDevices(executor, [{ id: 'a', username: 'alice' }], '/home'))?.get('a')).toEqual(['/dev/block/8:1'])
    expect(executor.executedActions).toEqual([])
  })
})
