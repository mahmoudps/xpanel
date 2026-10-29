import { afterEach, describe, expect, it, vi } from 'vitest'
import { HOST_METRICS_RETENTION_MS, cpuPercentBetween, createHostMetricsCollector, diskLatencyBetween, observeHostMetrics, parseCpuTicks, parseDiskstats } from './host-metrics.ts'
import type { HostMetricsReader } from './host-metrics.ts'
const reader = (): HostMetricsReader => ({
  readFile: async path => path.endsWith('loadavg') ? '1.5 2 3 1/100 77' : 'MemTotal: 8192 kB\nMemAvailable: 2048 kB\nSwapTotal: 1024 kB\nSwapFree: 512 kB\n',
  runCommand: async () => ({ ok: true, stdout: 'Filesystem 1-blocks Used Available Capacity Mounted on\n/dev/vda1 8192 4096 4096 50% /\n' }),
})
afterEach(() => vi.useRealTimers())
describe('observed host history collection', () => {
  it('reads real load, memory, swap and root disk in their original units', async () => {
    const observed = await observeHostMetrics(reader())
    expect(observed).toEqual({ load1: 1.5, load5: 2, load15: 3, memoryTotalBytes: 8388608, memoryAvailableBytes: 2097152, swapTotalBytes: 1048576, swapFreeBytes: 524288, diskTotalBytes: 8192, diskUsedBytes: 4096, diskAvailableBytes: 4096, cpuPercent: null, processes: null, cpuTicks: null, disks: null })
  })
  it('derives whole-host CPU % from two /proc/stat readings and counts /proc processes', async () => {
    expect(parseCpuTicks('cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 1 1 1 1\n')).toEqual({ busy: 150, total: 1000 })
    expect(parseCpuTicks('cpu bad')).toBeNull()
    expect(cpuPercentBetween({ busy: 150, total: 1000 }, { busy: 400, total: 2000 })).toBe(25)
    expect(cpuPercentBetween(null, { busy: 1, total: 2 })).toBeNull()
    expect(cpuPercentBetween({ busy: 400, total: 2000 }, { busy: 150, total: 1000 })).toBeNull()
    let stat = 'cpu  100 0 50 800 50 0 0 0 0 0\n'
    const source: HostMetricsReader = { ...reader(), readFile: async path => path === '/proc/stat' ? stat : reader().readFile(path), listDirectory: async () => ['1', '42', 'self', 'sys', '0x'] }
    const first = await observeHostMetrics(source)
    expect(first).toMatchObject({ cpuPercent: null, processes: 2, cpuTicks: { busy: 150, total: 1000 } })
    stat = 'cpu  300 0 100 1500 100 0 0 0 0 0\n'
    expect((await observeHostMetrics(source, first.cpuTicks)).cpuPercent).toBe(25)
  })
  it('derives per-device and whole-host disk wait from two /proc/diskstats readings', () => {
    const stats = (reads: number, readMs: number, writes: number, writeMs: number, busyMs: number): string =>
      `   7       0 loop0 9 0 9 9 0 0 0 0 0 9 9 0 0 0 0\n 252       0 vda ${reads} 0 0 ${readMs} ${writes} 0 0 ${writeMs} 0 ${busyMs} 0 0 0 0 0\n 252       1 vda1 5 0 0 5 5 0 0 5 0 5 0\n`
    const first = parseDiskstats(stats(100, 200, 50, 500, 1000))!
    expect([...first.keys()]).toEqual(['vda'])
    const at = '2026-10-28T12:01:00.000Z'
    expect(diskLatencyBetween({ atMs: 0, disks: first }, { atMs: 60_000, disks: parseDiskstats(stats(110, 230, 60, 600, 7000))! }, at))
      .toEqual({ state: 'read', observedAt: at, intervalSeconds: 60, awaitMs: 6.5, devices: [{ name: 'vda', readAwaitMs: 3, writeAwaitMs: 10, utilPercent: 10 }] })
    expect(diskLatencyBetween({ atMs: 0, disks: first }, { atMs: 60_000, disks: first }, at)).toMatchObject({ state: 'idle', awaitMs: null })
    expect(diskLatencyBetween({ atMs: 0, disks: first }, { atMs: 60_000, disks: parseDiskstats(stats(1, 1, 1, 1, 1))! }, at).state).toBe('unavailable')
    expect(diskLatencyBetween(null, { atMs: 60_000, disks: first }, at).state).toBe('unavailable')
    expect(parseDiskstats('garbage')).toBeNull()
  })
  it('carries the CPU baseline between collections and prunes old samples at most hourly', async () => {
    let stat = 'cpu  100 0 0 900 0\n', now = Date.parse('2026-10-27T10:00:00.000Z')
    const write = vi.fn(async (_observation: { cpuPercent: number | null }, _at: string) => undefined), prune = vi.fn(async (_olderThan: string) => undefined)
    const collector = createHostMetricsCollector({ reader: { ...reader(), readFile: async path => path === '/proc/stat' ? stat : reader().readFile(path) }, write, prune, now: () => new Date(now) })
    await collector.collectNow(); stat = 'cpu  150 0 0 950 0\n'; now += 60_000; await collector.collectNow()
    expect(write.mock.calls.map(call => call[0].cpuPercent)).toEqual([null, 50])
    expect(write.mock.calls[0]?.[0]).not.toHaveProperty('cpuTicks')
    expect(prune).toHaveBeenCalledTimes(1); expect(prune).toHaveBeenCalledWith(new Date(Date.parse('2026-10-27T10:00:00.000Z') - HOST_METRICS_RETENTION_MS).toISOString())
    now += 3_600_000; await collector.collectNow(); expect(prune).toHaveBeenCalledTimes(2)
    // No /proc/diskstats in this reader, and an old reading is never served as current.
    expect(collector.latestDiskLatency().state).toBe('unavailable')
  })
  it('isolates malformed memory and load while preserving observed zero swap', async () => {
    const observed = await observeHostMetrics({ readFile: async path => path.endsWith('loadavg') ? 'bad' : 'MemTotal: 5 kB\nMemAvailable: 8 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n', runCommand: async () => { throw Error('offline') } })
    expect(observed.load1).toBeNull(); expect(observed.memoryTotalBytes).toBeNull(); expect(observed.diskUsedBytes).toBeNull()
    expect(observed.swapTotalBytes).toBe(0); expect(observed.swapFreeBytes).toBe(0)
  })
  it('does not insert failed intervals, overlap calls or write after stop', async () => {
    let release!: (value: string | null) => void
    const read = vi.fn(() => new Promise<string | null>(resolve => { release = resolve }))
    const write = vi.fn(async () => undefined)
    const collector = createHostMetricsCollector({ reader: { readFile: read, runCommand: async () => ({ ok: false, stdout: '' }) }, write, readTimeoutMs: 10 })
    const first = collector.collectNow(); expect(collector.collectNow()).toBe(first)
    await collector.stop(); await first
    expect(write).not.toHaveBeenCalled(); await collector.collectNow(); expect(read).toHaveBeenCalledTimes(4)
    release('1 1 1'); await Promise.resolve(); expect(write).not.toHaveBeenCalled()
  })
  it('bounds unavailable reads without queuing another underlying request', async () => {
    vi.useFakeTimers()
    const read = vi.fn(() => new Promise<null>(() => {})), write = vi.fn(async () => undefined)
    const collector = createHostMetricsCollector({ reader: { readFile: read, runCommand: async () => ({ ok: false, stdout: '' }) }, write, readTimeoutMs: 10 })
    const first = collector.collectNow(); await vi.advanceTimersByTimeAsync(11); await first
    await collector.collectNow(); expect(read).toHaveBeenCalledTimes(4); expect(write).not.toHaveBeenCalled(); await collector.stop()
  })
  it('periodically records and drains a pending write before shutdown', async () => {
    vi.useFakeTimers()
    let finish!: () => void
    const write = vi.fn((_observation: unknown, _at: string) => new Promise<void>(resolve => { finish = resolve }))
    const collector = createHostMetricsCollector({ reader: reader(), write, now: () => new Date('2026-10-27T10:00:00.000Z'), intervalMs: 1000 })
    collector.start(); collector.start(); await vi.advanceTimersByTimeAsync(0)
    expect(write).toHaveBeenCalledTimes(1); expect(write.mock.calls[0]?.[1]).toBe('2026-10-27T10:00:00.000Z')
    let drained = false; const stopped = collector.stop().then(() => { drained = true }); await Promise.resolve(); expect(drained).toBe(false)
    finish(); await stopped; await vi.advanceTimersByTimeAsync(5000); expect(write).toHaveBeenCalledTimes(1)
  })
})
