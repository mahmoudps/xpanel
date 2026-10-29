import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHostMetricsCollector, observeHostMetrics } from './host-metrics.ts'
import type { HostMetricsReader } from './host-metrics.ts'
const reader = (): HostMetricsReader => ({
  readFile: async path => path.endsWith('loadavg') ? '1.5 2 3 1/100 77' : 'MemTotal: 8192 kB\nMemAvailable: 2048 kB\nSwapTotal: 1024 kB\nSwapFree: 512 kB\n',
  runCommand: async () => ({ ok: true, stdout: 'Filesystem 1-blocks Used Available Capacity Mounted on\n/dev/vda1 8192 4096 4096 50% /\n' }),
})
afterEach(() => vi.useRealTimers())
describe('observed host history collection', () => {
  it('reads real load, memory, swap and root disk in their original units', async () => {
    const observed = await observeHostMetrics(reader())
    expect(observed).toEqual({ load1: 1.5, load5: 2, load15: 3, memoryTotalBytes: 8388608, memoryAvailableBytes: 2097152, swapTotalBytes: 1048576, swapFreeBytes: 524288, diskTotalBytes: 8192, diskUsedBytes: 4096, diskAvailableBytes: 4096 })
    expect(observed).not.toHaveProperty('cpuPercent')
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
    expect(write).not.toHaveBeenCalled(); await collector.collectNow(); expect(read).toHaveBeenCalledTimes(2)
    release('1 1 1'); await Promise.resolve(); expect(write).not.toHaveBeenCalled()
  })
  it('bounds unavailable reads without queuing another underlying request', async () => {
    vi.useFakeTimers()
    const read = vi.fn(() => new Promise<null>(() => {})), write = vi.fn(async () => undefined)
    const collector = createHostMetricsCollector({ reader: { readFile: read, runCommand: async () => ({ ok: false, stdout: '' }) }, write, readTimeoutMs: 10 })
    const first = collector.collectNow(); await vi.advanceTimersByTimeAsync(11); await first
    await collector.collectNow(); expect(read).toHaveBeenCalledTimes(2); expect(write).not.toHaveBeenCalled(); await collector.stop()
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
