import type { AgentExecutor } from './executor.ts'

type BlockReader = Pick<AgentExecutor, 'readFile'>
const DEVICE = /^[1-9]\d{0,3}:(?:0|[1-9]\d{0,6})$/
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/

const unescapeMount = (value: string): string => value.replace(/\\([0-7]{3})/g,
  (_match, oct: string) => String.fromCharCode(Number.parseInt(oct, 8)))

/** Select the covering mount before validating it: a nested non-block mount must never inherit its parent's device. */
export const ioMountForTarget = (mountinfo: string, target: string): { device: string; mountPoint: string } | null => {
  if (!target.startsWith('/') || target.split('/').some(part => part === '.' || part === '..')) return null
  const wanted = target.replace(/\/+$/, '') || '/'
  let best: { length: number; device: string; filesystem: string; mountPoint: string } | undefined
  for (const line of mountinfo.split('\n')) {
    const parts = line.trim().split(/\s+/)
    const separator = parts.indexOf('-')
    if (separator < 6 || !parts[4]) continue
    const point = unescapeMount(parts[4]).replace(/\/+$/, '') || '/'
    if (!(point === '/' || wanted === point || wanted.startsWith(`${point}/`))) continue
    if (best && point.length < best.length) continue
    best = { length: point.length, device: parts[2] ?? '', filesystem: parts[separator + 1] ?? '', mountPoint: point }
  }
  if (!best || !DEVICE.test(best.device) || /^(?:tmpfs|nfs\d*|overlay|fuse.*|cifs|proc|sysfs)$/.test(best.filesystem)) return null
  return { device: best.device, mountPoint: best.mountPoint }
}

/** The node must describe itself: a stale or foreign sysfs link is not this device. */
const blockFacts = async (reader: BlockReader, device: string): Promise<Map<string, string> | null> => {
  const facts = new Map<string, string>()
  for (const line of (await reader.readFile(`/sys/dev/block/${device}/uevent`))?.split('\n') ?? []) {
    const pair = /^([A-Z_]+)=(.*)$/.exec(line)
    if (pair) facts.set(pair[1]!, pair[2]!)
  }
  return `${facts.get('MAJOR')}:${facts.get('MINOR')}` === device && NAME.test(facts.get('DEVNAME') ?? '') ? facts : null
}

/** The kernel names a partition disk + number, with `p` when the disk name ends in a digit (sda1, nvme0n1p2, mmcblk0p1). */
const partitionDisk = async (reader: BlockReader, device: string, facts: Map<string, string>): Promise<string | null> => {
  const name = facts.get('DEVNAME')!, number = facts.get('PARTN') ?? ''
  if (!/^[1-9]\d*$/.test(number) || !name.endsWith(number)) return null
  const base = name.slice(0, -number.length)
  for (const disk of /\dp$/.test(base) ? [base.slice(0, -1), base] : [base]) {
    if (!NAME.test(disk) || (await reader.readFile(`/sys/block/${disk}/${name}/dev`))?.trim() !== device) continue
    const whole = (await reader.readFile(`/sys/block/${disk}/dev`))?.trim() ?? ''
    return DEVICE.test(whole) ? whole : null
  }
  return null
}

/** undefined: unreadable; null: no single origin, so the device itself is the throttled disk. */
const originOf = async (reader: BlockReader, device: string, name: string): Promise<string | null | undefined> => {
  const table = await reader.readFile('/proc/partitions')
  if (table === null) return undefined
  const slaves: string[] = []
  for (const line of table.split('\n')) {
    const candidate = /^\s*\d+\s+\d+\s+\d+\s+(\S+)\s*$/.exec(line)?.[1]
    if (!candidate || candidate === name || !NAME.test(candidate)) continue
    const slave = (await reader.readFile(`/sys/dev/block/${device}/slaves/${candidate}/dev`))?.trim()
    if (slave && DEVICE.test(slave)) slaves.push(slave)
  }
  if (slaves.length < 2) return slaves[0] ?? null
  // Several backing devices are one origin only on one whole disk (dm-verity data and hash partitions).
  const disks = await Promise.all(slaves.map(async slave => {
    const facts = await blockFacts(reader, slave)
    return facts?.get('DEVTYPE') === 'partition' ? partitionDisk(reader, slave, facts) : null
  }))
  const first = disks[0] ?? null
  return first && disks.every(disk => disk === first) ? first : null
}

/**
 * The whole-disk MAJ:MIN the kernel accepts in io.max, resolved like systemd's lookup_block_device:
 * follow a single-origin stack (dm-crypt, LVM on one disk) to its origin, then a partition to its disk.
 * Null when sysfs cannot prove it, so the limit stays unavailable instead of verified.
 */
export const ioDiskForDevice = async (reader: BlockReader, device: string): Promise<string | null> => {
  try {
    let current = device
    for (let depth = 0; depth < 8 && DEVICE.test(current); depth++) {
      const facts = await blockFacts(reader, current)
      if (!facts) return null
      if (facts.get('DEVTYPE') === 'partition') return await partitionDisk(reader, current, facts)
      if (facts.get('DEVTYPE') !== 'disk') return null
      const origin = await originOf(reader, current, facts.get('DEVNAME')!)
      if (origin === undefined) return null
      if (origin === null) return current
      current = origin
    }
    return null
  } catch { return null }
}

/** systemd IO*Max= device of the whole disk under target, the same identity io.max rows are keyed by. */
export const ioDiskForMount = async (reader: BlockReader, mountinfo: string, target: string): Promise<string | null> => {
  const device = ioMountForTarget(mountinfo, target)?.device
  const disk = device ? await ioDiskForDevice(reader, device) : null
  return disk ? `/dev/block/${disk}` : null
}

export interface AccountIoTarget { id: string; username: string; home?: string | null; status?: string }

export const accountIoTarget = (account: AccountIoTarget, quotaFilesystem: string): string =>
  account.home?.startsWith('/') ? account.home : `${quotaFilesystem.replace(/\/+$/, '') || '/home'}/${account.username}`

export const ioDevicesByAccount = async (reader: BlockReader, mountinfo: string, accounts: readonly AccountIoTarget[], quotaFilesystem: string): Promise<Map<string, string[]>> => {
  const disks = new Map<string, Promise<string | null>>()
  const result = new Map<string, string[]>()
  for (const account of accounts.filter(account => account.status !== 'terminating')) {
    const device = ioMountForTarget(mountinfo, accountIoTarget(account, quotaFilesystem))?.device
    if (device && !disks.has(device)) disks.set(device, ioDiskForDevice(reader, device).then(disk => disk && `/dev/block/${disk}`))
    const disk = device ? await disks.get(device) : null
    result.set(account.id, disk ? [disk] : [])
  }
  return result
}

/** One identity for rendering IO*Max= lines and for comparing io.max, so the two never disagree. */
export const resolveAccountIoDevices = async (executor: AgentExecutor, accounts: readonly AccountIoTarget[], quotaFilesystem: string): Promise<Map<string, string[]> | null> => {
  try {
    const mountinfo = await executor.readFile('/proc/self/mountinfo')
    const nested = await executor.readFile('/sys/fs/cgroup/xpanel.slice/cgroup.subtree_control')
    const subtree = nested ?? await executor.readFile('/sys/fs/cgroup/cgroup.subtree_control')
    if (!mountinfo || !subtree?.split(/\s+/).includes('io')) return null
    return await ioDevicesByAccount(executor, mountinfo, accounts, quotaFilesystem)
  } catch { return null }
}
