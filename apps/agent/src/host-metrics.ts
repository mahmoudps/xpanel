import type { HostMetricsObservation } from '../../../packages/db/src/repos/metrics.ts'
import { parseDf, parseLoadavg, parseMeminfo } from './host-info.ts'

export const HOST_METRICS_INTERVAL_MS = 60_000
export const HOST_METRICS_READ_TIMEOUT_MS = 2_000
export interface HostMetricsReader {
  readFile(path: string): Promise<string | null>
  runCommand(argv: string[]): Promise<{ ok: boolean; stdout: string }>
}
const empty = (): HostMetricsObservation => ({ load1: null, load5: null, load15: null, memoryTotalBytes: null, memoryAvailableBytes: null, swapTotalBytes: null, swapFreeBytes: null, diskTotalBytes: null, diskUsedBytes: null, diskAvailableBytes: null })
const bytes = (text: string, key: string): number | null => {
  const match = new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, 'm').exec(text)
  const value = match ? Number(match[1]) * 1024 : NaN
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}
/** Reuses the host-info parsers. A failed source affects only its own measurements. */
export async function observeHostMetrics(reader: HostMetricsReader): Promise<HostMetricsObservation> {
  const attempt = async <T>(read: () => Promise<T>): Promise<T | null> => { try { return await read() } catch { return null } }
  const [load, memory, disk] = await Promise.all([
    attempt(() => reader.readFile('/proc/loadavg')), attempt(() => reader.readFile('/proc/meminfo')),
    attempt(() => reader.runCommand(['/usr/bin/df', '-B1', '-P', '/'])),
  ])
  const result = empty()
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
  return result
}

/** One collection at a time, at most 3 outstanding reads, no retry queue or backfill.
 * write must use the lifecycle writer admission boundary. stop drains any write before DB closure.
 */
export function createHostMetricsCollector(options: {
  reader: HostMetricsReader
  write: (observation: HostMetricsObservation, at: string) => Promise<unknown>
  now?: () => Date
  intervalMs?: number
  readTimeoutMs?: number
  onError?: (error: unknown) => void
}) {
  const intervalMs = options.intervalMs ?? HOST_METRICS_INTERVAL_MS, timeoutMs = options.readTimeoutMs ?? HOST_METRICS_READ_TIMEOUT_MS
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 3_600_000 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error('invalid host metrics interval')
  const pendingReads = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined, active: Promise<void> | undefined, stopped = false, started = false
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
  }
  const collectNow = (): Promise<void> => {
    if (stopped) return Promise.resolve()
    if (active) return active
    active = (async () => {
      const observation = await observeHostMetrics(reader)
      if (!stopped && Object.values(observation).some(value => value !== null)) await options.write(observation, (options.now ?? (() => new Date()))().toISOString())
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
    start(): void { if (started || stopped) return; started = true; void tick() },
    async stop(): Promise<void> { stopped = true; clearTimeout(timer); await active },
  }
}
