import { createHash } from 'node:crypto'
import type { HostDisk } from './host-info.ts'

export const HOST_DISK_DF_ARGV = Object.freeze(['/usr/bin/env', 'LC_ALL=C', '/usr/bin/df', '--all', '-B1', '-P'])
export const MAX_HOST_DISK_INPUT_BYTES = 1024 * 1024
export const MAX_HOST_DISK_MOUNTS = 4096

export interface HostDiskCoverage {
  status: 'complete' | 'incomplete' | 'unavailable'
  source: 'df'
  inventorySource: 'proc-self-mountinfo'
  mounts: string[]
  unavailableMounts: string[]
  unexpectedMounts: string[]
  mountInfoSha256: string | null
  sampledAt: string
  reason?: string
}
export interface HostDiskInventory {
  disks: HostDisk[]
  diskCoverage: HostDiskCoverage
}
export interface HostDiskReader {
  readFile(path: string): Promise<string | null>
  runCommand(argv: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }>
}

const bounded = (text: string): boolean => Buffer.byteLength(text, 'utf8') <= MAX_HOST_DISK_INPUT_BYTES
const decodeMount = (text: string): string => text.replace(/\\(040|011|012|134)/g, (_escape, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)))

/** Mounts are kernel namespace inventory, including pseudo filesystems and bind/file mounts. */
export const visibleMountpoints = (text: string): string[] => {
  if (!bounded(text) || text.includes('\u0000')) throw new Error('mount_inventory_capacity')
  const mounts = new Set<string>(), ids = new Set<string>()
  for (const line of text.split('\n').filter(line => line !== '')) {
    const fields = line.split(' '), separator = fields.indexOf('-')
    if (separator < 6 || fields.length < separator + 4 || !/^\d+$/.test(fields[0] ?? '') || ids.has(fields[0]!) ||
        !/^\d+$/.test(fields[1] ?? '') || !/^\d+:\d+$/.test(fields[2] ?? '') || !fields[4]?.startsWith('/')) {
      throw new Error('mount_inventory_invalid')
    }
    ids.add(fields[0]!)
    if (/\\(?!040|011|012|134)/.test(fields[4])) throw new Error('mount_inventory_invalid')
    const path = decodeMount(fields[4])
    if (path.includes('\uFFFD')) throw new Error('mount_inventory_invalid')
    mounts.add(path)
    if (mounts.size > MAX_HOST_DISK_MOUNTS) throw new Error('mount_inventory_capacity')
  }
  if (!mounts.has('/')) throw new Error('mount_inventory_invalid')
  return [...mounts].sort()
}

const amount = (value: string): number | null => {
  if (!/^-?\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

const readDfRows = (text: string, expected: ReadonlySet<string>) => {
  const rows = text.split(/\r?\n/).filter(line => line.trim() !== '')
  const disks = new Map<string, HostDisk>(), ambiguous = new Set<string>()
  let invalid = false
  if (!bounded(text) || rows.length > MAX_HOST_DISK_MOUNTS + 1) throw new Error('df_capacity')
  if (!/^Filesystem\s/.test(rows[0] ?? '')) throw new Error('df_invalid')
  for (const line of rows.slice(1)) {
    // Numeric columns are fixed. Filesystem and mount names may contain spaces.
    const match = /^(.+?)\s+(-?\d+|-)\s+(-?\d+|-)\s+(-?\d+|-)\s+(?:\d+%|-)\s+(\/.*)$/.exec(line)
    if (!match) { invalid = true; continue }
    const rawMount = match[5]!, mount = expected.has(rawMount) ? rawMount : decodeMount(rawMount)
    const totalBytes = amount(match[2]!), usedBytes = amount(match[3]!), availableBytes = amount(match[4]!)
    if (totalBytes === null || usedBytes === null || availableBytes === null || totalBytes < 0 || usedBytes < 0 || usedBytes > totalBytes) {
      invalid = true
      continue
    }
    const disk: HostDisk = { filesystem: match[1]!.trim(), mount, totalBytes, usedBytes, availableBytes }
    const previous = disks.get(mount)
    if (previous && JSON.stringify(previous) !== JSON.stringify(disk)) ambiguous.add(mount)
    else disks.set(mount, disk)
  }
  return { disks, ambiguous, invalid }
}

/** One bounded df command; incomplete namespace/data never becomes complete coverage. */
export const readHostDiskInventory = async (reader: HostDiskReader, now: () => Date = () => new Date()): Promise<HostDiskInventory> => {
  const base: HostDiskCoverage = {
    status: 'unavailable', source: 'df', inventorySource: 'proc-self-mountinfo', mounts: [], unavailableMounts: [],
    unexpectedMounts: [], mountInfoSha256: null, sampledAt: now().toISOString(),
  }
  let before: string | null
  try { before = await reader.readFile('/proc/self/mountinfo') } catch { before = null }
  if (before === null) return { disks: [], diskCoverage: { ...base, reason: 'mount_inventory_unavailable' } }
  let mounts: string[]
  try { mounts = visibleMountpoints(before) } catch (error) {
    return { disks: [], diskCoverage: { ...base, reason: error instanceof Error ? error.message : 'mount_inventory_invalid' } }
  }
  const coverage = { ...base, mounts, unavailableMounts: [...mounts], mountInfoSha256: createHash('sha256').update(before).digest('hex') }
  let result: Awaited<ReturnType<HostDiskReader['runCommand']>>
  try { result = await reader.runCommand([...HOST_DISK_DF_ARGV]) } catch {
    return { disks: [], diskCoverage: { ...coverage, sampledAt: now().toISOString(), reason: 'df_unavailable' } }
  }
  let after: string | null
  try { after = await reader.readFile('/proc/self/mountinfo') } catch { after = null }
  const sampledAt = now().toISOString()
  if (after !== null && !bounded(after)) return { disks: [], diskCoverage: { ...coverage, sampledAt, reason: 'mount_inventory_capacity' } }
  let parsed: ReturnType<typeof readDfRows>
  try { parsed = readDfRows(result.stdout, new Set(mounts)) } catch (error) {
    return { disks: [], diskCoverage: { ...coverage, sampledAt, reason: error instanceof Error ? error.message : 'df_invalid' } }
  }
  const unavailableMounts = mounts.filter(mount => !parsed.disks.has(mount) || parsed.ambiguous.has(mount))
  const unexpectedMounts = [...parsed.disks.keys()].filter(mount => !mounts.includes(mount)).sort()
  const stable = before === after
  const complete = result.ok && stable && !parsed.invalid && parsed.ambiguous.size === 0 && unavailableMounts.length === 0 && unexpectedMounts.length === 0
  const disks = [...parsed.disks.values()].filter(disk => !parsed.ambiguous.has(disk.mount)).sort((a, b) => a.mount.localeCompare(b.mount))
  return {
    disks,
    diskCoverage: {
      ...coverage, status: complete ? 'complete' : disks.length > 0 ? 'incomplete' : 'unavailable', unavailableMounts, unexpectedMounts, sampledAt,
      ...(complete ? {} : { reason: !stable ? 'mount_inventory_changed' : !result.ok ? 'df_incomplete' : parsed.ambiguous.size > 0 ? 'df_ambiguous' : 'df_incomplete' }),
    },
  }
}
