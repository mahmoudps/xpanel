import type { HostMetricsObservation } from '../../../packages/db/src/repos/metrics.ts'
import { parseDf, parseLoadavg, parseMeminfo } from './host-info.ts'

export const HOST_METRICS_INTERVAL_MS = 60_000
export const HOST_METRICS_READ_TIMEOUT_MS = 2_000
/** Host samples older than this are pruned; the longest performance window is 7 days. */
export const HOST_METRICS_RETENTION_MS = 8 * 86_400_000
const PRUNE_EVERY_MS = 3_600_000
export interface HostMetricsReader {
  readFile(path: string): Promise<string | null>
  runCommand(argv: string[]): Promise<{ ok: boolean; stdout: string }>
  /** Directory entry names; used only to count /proc processes. */
  listDirectory?(path: string): Promise<string[] | null>
}
/** Aggregate /proc/stat jiffies: busy excludes idle and iowait. */
export interface CpuTicks { busy: number; total: number }
const empty = (): HostMetricsObservation => ({ load1: null, load5: null, load15: null, memoryTotalBytes: null, memoryAvailableBytes: null, swapTotalBytes: null, swapFreeBytes: null, diskTotalBytes: null, diskUsedBytes: null, diskAvailableBytes: null, cpuPercent: null, processes: null })
const bytes = (text: string, key: string): number | null => {
  const match = new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, 'm').exec(text)
  const value = match ? Number(match[1]) * 1024 : NaN
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}
// proc(5): "cpu user nice system idle iowait irq softirq steal guest guest_nice"; guest time is already in user.
export function parseCpuTicks(text: string): CpuTicks | null {
  const fields = /^cpu\s+(.+)$/m.exec(text)?.[1]?.trim().split(/\s+/).slice(0, 8)
  if (!fields || fields.length < 5 || fields.some(field => !/^\d{1,20}$/.test(field))) return null
  const values = fields.map(Number), total = values.reduce((sum, value) => sum + value, 0)
  if (!values.every(Number.isSafeInteger) || !Number.isSafeInteger(total)) return null
  return { busy: total - values[3]! - values[4]!, total }
}
/** /proc/diskstats counters of one whole disk (Documentation/admin-guide/iostats.rst fields 1, 4, 5, 8 and 10). */
export interface DiskCounters { reads: number; readMs: number; writes: number; writeMs: number; busyMs: number }
export interface DiskDeviceLatency { name: string; readAwaitMs: number | null; writeAwaitMs: number | null; utilPercent: number }
/** Average wait per completed disk operation over the last collection interval. idle: no operation completed, so no wait exists. */
export interface DiskLatency { state: 'read' | 'idle' | 'unavailable'; observedAt: string | null; intervalSeconds: number | null; awaitMs: number | null; devices: DiskDeviceLatency[] }
export const UNAVAILABLE_DISK_LATENCY: DiskLatency = Object.freeze({ state: 'unavailable', observedAt: null, intervalSeconds: null, awaitMs: null, devices: [] })
// Whole disks only: partitions, loop, ram, zram and device-mapper volumes would count the same IO twice or none at all.
const WHOLE_DISK = /^(?:sd[a-z]{1,3}|vd[a-z]{1,3}|xvd[a-z]{1,3}|hd[a-z]{1,3}|nvme\d{1,3}n\d{1,3}|mmcblk\d{1,3})$/
export function parseDiskstats(text: string): Map<string, DiskCounters> | null {
  if (text.length > 256 * 1024) return null
  const disks = new Map<string, DiskCounters>()
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 14 || !WHOLE_DISK.test(fields[2]!) || fields.slice(3, 14).some(field => !/^\d{1,20}$/.test(field))) continue
    const value = (index: number): number => Number(fields[3 + index])
    const counters = { reads: value(0), readMs: value(3), writes: value(4), writeMs: value(7), busyMs: value(9) }
    if (Object.values(counters).every(Number.isSafeInteger)) disks.set(fields[2]!, counters)
  }
  return disks.size ? disks : null
}
/** Wait per operation between two readings. A device whose counters went backwards (reset or wrap) is left out. */
export function diskLatencyBetween(previous: { atMs: number; disks: Map<string, DiskCounters> } | null, current: { atMs: number; disks: Map<string, DiskCounters> } | null, observedAt: string): DiskLatency {
  const elapsedMs = current && previous ? current.atMs - previous.atMs : 0
  if (!previous || !current || elapsedMs <= 0) return UNAVAILABLE_DISK_LATENCY
  const round = (value: number): number => Math.round(value * 100) / 100
  const devices: DiskDeviceLatency[] = []
  let operations = 0, waitMs = 0
  for (const [name, now] of current.disks) {
    const before = previous.disks.get(name)
    if (!before) continue
    const reads = now.reads - before.reads, writes = now.writes - before.writes, readMs = now.readMs - before.readMs, writeMs = now.writeMs - before.writeMs, busyMs = now.busyMs - before.busyMs
    if ([reads, writes, readMs, writeMs, busyMs].some(delta => delta < 0)) continue
    operations += reads + writes; waitMs += readMs + writeMs
    devices.push({ name, readAwaitMs: reads ? round(readMs / reads) : null, writeAwaitMs: writes ? round(writeMs / writes) : null, utilPercent: round(Math.min(100, busyMs / elapsedMs * 100)) })
  }
  if (!devices.length) return UNAVAILABLE_DISK_LATENCY
  return { state: operations ? 'read' : 'idle', observedAt, intervalSeconds: round(elapsedMs / 1000), awaitMs: operations ? round(waitMs / operations) : null, devices: devices.sort((a, b) => a.name.localeCompare(b.name)) }
}
/** Busy share between two readings; null for the first reading, a counter reset or no elapsed ticks. */
export function cpuPercentBetween(previous: CpuTicks | null, current: CpuTicks | null): number | null {
  if (!previous || !current) return null
  const total = current.total - previous.total, busy = current.busy - previous.busy
  if (total <= 0 || busy < 0 || busy > total) return null
  return Math.round(busy / total * 10_000) / 100
}

/** Reuses the host-info parsers. A failed source affects only its own measurements.
 * previousCpu is the /proc/stat reading of the previous sample; CPU % needs two readings. */
export async function observeHostMetrics(reader: HostMetricsReader, previousCpu: CpuTicks | null = null): Promise<HostMetricsObservation & { cpuTicks: CpuTicks | null; disks: Map<string, DiskCounters> | null }> {
  const attempt = async <T>(read: () => Promise<T>): Promise<T | null> => { try { return await read() } catch { return null } }
  const [load, memory, disk, stat, proc, diskstats] = await Promise.all([
    attempt(() => reader.readFile('/proc/loadavg')), attempt(() => reader.readFile('/proc/meminfo')),
    attempt(() => reader.runCommand(['/usr/bin/df', '-B1', '-P', '/'])),
    attempt(() => reader.readFile('/proc/stat')), attempt(async () => reader.listDirectory ? await reader.listDirectory('/proc') : null),
    attempt(() => reader.readFile('/proc/diskstats')),
  ])
  const result = empty(), cpuTicks = stat ? parseCpuTicks(stat) : null
  result.cpuPercent = cpuPercentBetween(previousCpu, cpuTicks)
  if (proc) { const count = proc.filter(name => /^[1-9]\d{0,9}$/.test(name)).length; if (count > 0) result.processes = count }
  try { if (load) Object.assign(result, parseLoadavg(load)) } catch { /* Keep unavailable. */ }
  if (memory) {
    try {
      const parsed = parseMeminfo(memory)
      if (Number.isSafeInteger(parsed.totalBytes) && parsed.totalBytes > 0 && Number.isSafeInteger(parsed.availableBytes) && parsed.availableBytes <= parsed.totalBytes) {
        result.memoryTotalBytes = parsed.totalBytes; result.memoryAvailableBytes = parsed.availableBytes
      }
    } catch { /* Swap can still be read independently. */ }
    const total = bytes(memory, 'SwapTotal'), free = bytes(memory, 'SwapFree')
    if (total !== null && free !== null && free <= total) { result.swapTotalBytes = total; result.swapFreeBytes = free }
  }
  try {
    if (disk?.ok) {
      const parsed = parseDf(disk.stdout)
      if (parsed.mount === '/' && parsed.totalBytes > 0 && [parsed.totalBytes, parsed.usedBytes, parsed.availableBytes].every(Number.isSafeInteger) && parsed.usedBytes <= parsed.totalBytes && parsed.availableBytes <= parsed.totalBytes) {
        result.diskTotalBytes = parsed.totalBytes; result.diskUsedBytes = parsed.usedBytes; result.diskAvailableBytes = parsed.availableBytes
      }
    }
  } catch { /* Keep unavailable. */ }
  return { ...result, cpuTicks, disks: diskstats ? parseDiskstats(diskstats) : null }
}

/** One collection at a time, at most 3 outstanding reads, no retry queue or backfill.
 * write must use the lifecycle writer admission boundary. stop drains any write before DB closure.
 */
export function createHostMetricsCollector(options: {
  reader: HostMetricsReader
  write: (observation: HostMetricsObservation, at: string) => Promise<unknown>
  /** Deletes host samples older than the cutoff; called at most hourly after a write. */
  prune?: (olderThanIso: string) => Promise<unknown>
  now?: () => Date
  intervalMs?: number
  readTimeoutMs?: number
  onError?: (error: unknown) => void
}) {
  const intervalMs = options.intervalMs ?? HOST_METRICS_INTERVAL_MS, timeoutMs = options.readTimeoutMs ?? HOST_METRICS_READ_TIMEOUT_MS
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 3_600_000 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error('invalid host metrics interval')
  const pendingReads = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined, active: Promise<void> | undefined, stopped = false, started = false
  let previousCpu: CpuTicks | null = null, prunedAt = -Infinity
  let previousDisks: { atMs: number; disks: Map<string, DiskCounters> } | null = null, disk: DiskLatency = UNAVAILABLE_DISK_LATENCY
  const bounded = <T>(key: string, read: () => Promise<T>): Promise<T | null> => {
    if (stopped || pendingReads.has(key)) return Promise.resolve(null)
    pendingReads.add(key)
    return new Promise(resolve => {
      const deadline = setTimeout(() => resolve(null), timeoutMs)
      Promise.resolve().then(read).then(value => resolve(value), () => resolve(null)).finally(() => { clearTimeout(deadline); pendingReads.delete(key) })
    })
  }
  const reader: HostMetricsReader = {
    readFile: path => bounded(path, () => options.reader.readFile(path)),
    runCommand: async argv => await bounded('disk', () => options.reader.runCommand(argv)) ?? { ok: false, stdout: '' },
    ...(options.reader.listDirectory ? { listDirectory: (path: string) => bounded('list:' + path, () => options.reader.listDirectory!(path)) } : {}),
  }
  const collectNow = (): Promise<void> => {
    if (stopped) return Promise.resolve()
    if (active) return active
    active = (async () => {
      const { cpuTicks, disks, ...observation } = await observeHostMetrics(reader, previousCpu)
      const now = (options.now ?? (() => new Date()))(), sample = disks ? { atMs: now.getTime(), disks } : null
      previousCpu = cpuTicks
      disk = diskLatencyBetween(previousDisks, sample, now.toISOString()); previousDisks = sample
      if (!stopped && Object.values(observation).some(value => value !== null)) await options.write(observation, now.toISOString())
      if (!stopped && options.prune && now.getTime() - prunedAt >= PRUNE_EVERY_MS) { prunedAt = now.getTime(); await options.prune(new Date(now.getTime() - HOST_METRICS_RETENTION_MS).toISOString()) }
    })().finally(() => { active = undefined })
    return active
  }
  const report = (error: unknown): void => { try { options.onError?.(error) } catch { /* Diagnostics cannot stop collection. */ } }
  const tick = async (): Promise<void> => {
    try { await collectNow() } catch (error) { report(error) }
    if (!stopped) { timer = setTimeout(() => { void tick() }, intervalMs); timer.unref?.() }
  }
  return {
    collectNow,
    /** The latest interval's disk latency; unavailable once it is older than three collection intervals. */
    latestDiskLatency(): DiskLatency {
      const now = (options.now ?? (() => new Date()))().getTime()
      return disk.observedAt !== null && now - Date.parse(disk.observedAt) <= 3 * intervalMs ? disk : UNAVAILABLE_DISK_LATENCY
    },
    start(): void { if (started || stopped) return; started = true; void tick() },
    async stop(): Promise<void> { stopped = true; clearTimeout(timer); await active },
  }
}
