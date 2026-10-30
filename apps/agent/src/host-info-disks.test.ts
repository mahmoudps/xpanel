import { describe, expect, it } from 'vitest'
import { HOST_DISK_DF_ARGV, MAX_HOST_DISK_INPUT_BYTES, readHostDiskInventory, visibleMountpoints } from './host-info-disks.ts'

const inventory = [
  '1 0 8:1 / / rw - ext4 /dev/sda1 rw',
  '2 1 0:5 / /proc rw - proc proc rw',
  '3 1 8:2 / /home rw - ext4 /dev/sda2 rw',
  '4 1 8:3 / /data\\040with\\040spaces rw - ext4 /dev/sda3 rw',
  '5 1 8:1 /etc/hosts /etc/hosts rw - ext4 /dev/sda1 rw',
].join('\n') + '\n'
const df = [
  'Filesystem 1B-blocks Used Available Use% Mounted on',
  '/dev/sda1 100000 20000 70000 23% /',
  'proc 0 0 0 - /proc',
  '/dev/sda2 200000 40000 150000 22% /home',
  '/dev/sda3 300000 60000 240000 20% /data with spaces',
  '/dev/sda1 100000 20000 70000 23% /etc/hosts',
].join('\n') + '\n'
const fixture = (stdout = df, ok = true, after = inventory) => {
  const commands: string[][] = []
  let reads = 0
  return {
    commands,
    reader: {
      readFile: async () => ++reads === 1 ? inventory : after,
      runCommand: async (argv: string[]) => { commands.push(argv); return { ok, stdout, stderr: '' } },
    },
  }
}

describe('complete per-mount host disk observations', () => {
  it('uses one literal command and covers root, home, pseudo and file-bind mounts without exclusions', async () => {
    const host = fixture()
    const result = await readHostDiskInventory(host.reader)
    expect(host.commands).toEqual([[...HOST_DISK_DF_ARGV]])
    expect(result.diskCoverage).toMatchObject({ status: 'complete', mounts: ['/', '/data with spaces', '/etc/hosts', '/home', '/proc'], unavailableMounts: [], unexpectedMounts: [] })
    expect(result.diskCoverage.mountInfoSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(result.disks.find(disk => disk.mount === '/proc')).toEqual({ filesystem: 'proc', mount: '/proc', totalBytes: 0, usedBytes: 0, availableBytes: 0 })
    expect(result.disks.find(disk => disk.mount === '/home')?.usedBytes).toBe(40000)
  })
  it('marks every missing mount explicitly even if df reports success', async () => {
    const host = fixture(df.split('\n').filter(line => !line.endsWith(' /home')).join('\n'))
    const result = await readHostDiskInventory(host.reader)
    expect(result.diskCoverage).toMatchObject({ status: 'incomplete', unavailableMounts: ['/home'] })
    expect(result.disks).toHaveLength(4)
  })
  it('cannot qualify partial output from a failed df command', async () => {
    const host = fixture(df, false)
    expect((await readHostDiskInventory(host.reader)).diskCoverage).toMatchObject({ status: 'incomplete', reason: 'df_incomplete' })
  })
  it('does not hide unexpected mount rows or claim a changed namespace complete', async () => {
    const host = fixture(df + '/dev/new 1000 100 900 10% /new\n')
    expect((await readHostDiskInventory(host.reader)).diskCoverage).toMatchObject({ status: 'incomplete', unexpectedMounts: ['/new'] })
    const changing = fixture(df, true, inventory.replace('8:2', '8:9'))
    expect((await readHostDiskInventory(changing.reader)).diskCoverage).toMatchObject({ status: 'incomplete', reason: 'mount_inventory_changed' })
  })
  it('retains unavailable measurements instead of filtering pseudo filesystems with unsupported output', async () => {
    const host = fixture(df.replace('proc 0 0 0 - /proc', 'proc - - - - /proc'))
    const result = await readHostDiskInventory(host.reader)
    expect(result.diskCoverage.mounts).toContain('/proc')
    expect(result.diskCoverage).toMatchObject({ status: 'incomplete', unavailableMounts: ['/proc'] })
  })
  it('detects conflicting duplicate rows instead of choosing a visible filesystem by guess', async () => {
    const host = fixture(df + '/dev/wrong 500000 100000 400000 20% /home\n')
    const result = await readHostDiskInventory(host.reader)
    expect(result.diskCoverage).toMatchObject({ status: 'incomplete', unavailableMounts: ['/home'], reason: 'df_ambiguous' })
    expect(result.disks.some(disk => disk.mount === '/home')).toBe(false)
  })
  it('preserves escaped kernel paths and does not conflate a literal backslash with a space', () => {
    const mounts = visibleMountpoints(inventory + '6 1 8:4 / /literal\\134040name rw - ext4 /dev/sda4 rw\n')
    expect(mounts).toContain('/data with spaces')
    expect(mounts).toContain('/literal\\040name')
  })
  it('deduplicates namespace paths without silently excluding bind mounts', () => {
    expect(visibleMountpoints(inventory + '6 1 8:2 / /home rw - ext4 /dev/sda2 rw\n')).toEqual(['/', '/data with spaces', '/etc/hosts', '/home', '/proc'])
  })
  it('rejects malformed mount inventory before any measurement command', async () => {
    let commands = 0
    const result = await readHostDiskInventory({ readFile: async () => 'bad inventory\n', runCommand: async () => { commands++; return { ok: true, stdout: df, stderr: '' } } })
    expect(result.diskCoverage).toMatchObject({ status: 'unavailable', reason: 'mount_inventory_invalid' })
    expect(commands).toBe(0)
  })
  it('rejects oversized command output rather than truncating it into complete coverage', async () => {
    const host = fixture(df + 'x'.repeat(MAX_HOST_DISK_INPUT_BYTES))
    const result = await readHostDiskInventory(host.reader)
    expect(result.diskCoverage).toMatchObject({ status: 'unavailable', reason: 'df_capacity' })
    expect(result.diskCoverage.unavailableMounts).toHaveLength(5)
  })
  it('does not claim coverage if the second mount inventory cannot be read', async () => {
    const host = fixture()
    let calls = 0
    host.reader.readFile = async () => { if (++calls > 1) throw new Error('read failed'); return inventory }
    const result = await readHostDiskInventory(host.reader)
    expect(result.diskCoverage).toMatchObject({ status: 'incomplete', reason: 'mount_inventory_changed' })
  })
})
