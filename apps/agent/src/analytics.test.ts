import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RESOURCE_OBSERVATION_FIELDS, parseResourceObservationSnapshot, projectResourceObservationForLive } from '@xpanel/core'
import type { StateSnapshot, StateStore } from '@xpanel/state'
import type { ResourceSamplerReading } from './resource-observations.ts'

const harness = vi.hoisted(() => ({ active: false, unsafe: false, starts: 0, stops: 0, instances: 0, configurations: [] as unknown[],
  reading: { state: 'not-sampled', failure: null, observation: null } as ResourceSamplerReading }))
// Modeled producer and barrier boundaries only; these fixtures confer no native/root authority.
vi.mock('./resource-observations.ts', () => ({ LinuxResourceObservationSampler: class {
  constructor(configuration: unknown) { harness.instances++; harness.configurations.push(configuration) }
  start() { harness.starts++ }
  async stop() { harness.stops++ }
  setConfiguration(configuration: unknown) { harness.configurations.push(configuration) }
  readLatest() { return harness.reading }
} }))
vi.mock('../../../scripts/lifecycle-admission.mjs', () => ({ readLifecyclePublicStatus: async () => {
  if (harness.unsafe) throw new Error('unreadable barrier')
  return { active: harness.active, reference: null, phase: harness.active ? 'attention' : 'normal' }
} }))

import { CanonicalIoResourcePipeline, IoAnalyticsEngine } from './analytics.ts'

const EPOCH = '11111111-1111-4111-8111-111111111111'
const BOOT = '22222222-2222-4222-8222-222222222222'
const state = (): StateSnapshot => ({ checksum: 'a'.repeat(64), accounts: [], plans: [] } as unknown as StateSnapshot)
const capture = () => {
  const identity = { bootId: BOOT, onlineCpuIds: [0, 1], cgroup: null, ioDevices: null }
  const known = (value: number, definition: { unit: string; basis: string }) => ({ unit: definition.unit, basis: definition.basis, value, availability: 'known' })
  const fields = RESOURCE_OBSERVATION_FIELDS.host
  return parseResourceObservationSnapshot({ version: 1, observedAt: '2026-10-23T05:30:00.123Z',
    producer: { epoch: EPOCH, sequence: 2, intervalMs: 5_000, staleAfterMs: 15_000 },
    readSpan: { startedMonotonicUs: 10_000_000, finishedMonotonicUs: 10_100_000 },
    configuration: { revision: 'a'.repeat(64), accountIds: [] },
    host: { readSpan: { startedMonotonicUs: 10_000_000, finishedMonotonicUs: 10_010_000 }, identity,
      previous: { producerEpoch: EPOCH, monotonicUs: 4_000_000, identity },
      fields: { cpuBusyPercent: known(12, fields.cpuBusyPercent), memoryUsedBytes: known(4_096, fields.memoryUsedBytes),
        memoryTotalBytes: known(8_192, fields.memoryTotalBytes), loadAvg1m: known(1, fields.loadAvg1m),
        ioPressureSomeAvg10: known(0, fields.ioPressureSomeAvg10), ioPressureFullAvg10: known(0, fields.ioPressureFullAvg10) } },
    accounts: [], deferred: Object.fromEntries(Object.entries(RESOURCE_OBSERVATION_FIELDS.deferred)
      .map(([key, definition]) => [key, { unit: definition.unit, basis: definition.basis, value: null, availability: 'unsupported' }])) })
}
const reading = (): ResourceSamplerReading => ({ state: 'ready', failure: null,
  observation: projectResourceObservationForLive(capture(), { producerEpoch: EPOCH, monotonicUs: 11_000_000 }) })

beforeEach(() => {
  harness.active = false; harness.unsafe = false; harness.starts = 0; harness.stops = 0; harness.instances = 0; harness.configurations = []
  harness.reading = { state: 'not-sampled', failure: null, observation: null }
})
afterEach(() => { vi.useRealTimers() })

describe('canonical cached numeric IO projection', () => {
  it('does not synthesize a latest diagnostic snapshot before any sample', () => {
    expect(new IoAnalyticsEngine().latestSnapshot()).toBeNull()
  })
  it('does not turn missing latency into a zero-valued ready numeric snapshot', () => {
    const result = new IoAnalyticsEngine().readResourceObservation(reading(), state())
    expect(result).toEqual({ available: false, snapshot: null, reason: 'incomplete', fieldReasons: { awaitMs: 'unsupported' }, observedAt: '2026-10-23T05:30:00.123Z' })
    expect(JSON.stringify(result)).not.toMatch(/bootId|onlineCpuIds|inode|accountId|producer/)
  })
  it('refuses warm-up, missing, blocked and stale samples instead of falling back to diagnostic zeros', () => {
    const engine = new IoAnalyticsEngine()
    expect(engine.readResourceObservation({ state: 'sampling', failure: null, observation: null }, state())).toMatchObject({ available: false, snapshot: null, reason: 'not-sampled' })
    expect(engine.readResourceObservation({ state: 'blocked', failure: 'invalid', observation: null }, state())).toMatchObject({ available: false, snapshot: null, reason: 'invalid' })
    const old = { ...reading(), observation: projectResourceObservationForLive(capture(), { producerEpoch: EPOCH, monotonicUs: 30_000_000 }) }
    expect(engine.readResourceObservation(old, state())).toMatchObject({ available: false, snapshot: null, reason: 'stale' })
  })
  it('rejects a changed actual configuration and cannot accept a caller-supplied latency claim', () => {
    const engine = new IoAnalyticsEngine()
    expect(engine.readResourceObservation(reading(), { ...state(), checksum: 'b'.repeat(64) })).toMatchObject({ reason: 'configuration-changed', snapshot: null })
    const forged = structuredClone(reading()) as unknown as { observation: { snapshot: { deferred: { aggregateAwaitMs: { value: unknown; availability: unknown } } } } }
    forged.observation.snapshot.deferred.aggregateAwaitMs.value = 0
    forged.observation.snapshot.deferred.aggregateAwaitMs.availability = 'known'
    expect(engine.readResourceObservation(forged as unknown as ResourceSamplerReading, state())).toMatchObject({ reason: 'invalid', snapshot: null })
  })
})

describe('single daemon resource pipeline lifetime diagnostics', () => {
  it.each(['active', 'unsafe'] as const)('does not create a collector on %s lifecycle startup', async mode => {
    harness.active = mode === 'active'; harness.unsafe = mode === 'unsafe'
    const readSnapshot = vi.fn(async () => state())
    const pipeline = new CanonicalIoResourcePipeline({ store: { readSnapshot } as unknown as StateStore, engine: new IoAnalyticsEngine() })
    await pipeline.start()
    try {
      expect(harness.instances).toBe(0); expect(harness.starts).toBe(0); expect(readSnapshot).not.toHaveBeenCalled()
      expect(await pipeline.read(state())).toMatchObject({ available: false, reason: mode === 'active' ? 'paused' : 'invalid' })
    } finally { await pipeline.stop() }
  })
  it('creates one sampler and serves repeated cached reads without creating collectors', async () => {
    const readSnapshot = vi.fn(async () => state())
    const pipeline = new CanonicalIoResourcePipeline({ store: { readSnapshot } as unknown as StateStore, engine: new IoAnalyticsEngine() })
    await pipeline.start()
    try {
      harness.reading = reading()
      for (let n = 0; n < 5; n++) expect(await pipeline.read(state())).toMatchObject({ available: false, fieldReasons: { awaitMs: 'unsupported' } })
      expect(harness.instances).toBe(1); expect(harness.starts).toBe(1); expect(readSnapshot).toHaveBeenCalledTimes(1)
    } finally { await pipeline.stop() }
    expect(harness.stops).toBe(1)
  })
  it('refuses cached reads under a real barrier-state result or an unreadable barrier', async () => {
    const pipeline = new CanonicalIoResourcePipeline({ store: { readSnapshot: async () => state() } as unknown as StateStore, engine: new IoAnalyticsEngine() })
    await pipeline.start()
    try {
      harness.active = true
      expect(await pipeline.read(state())).toMatchObject({ reason: 'paused', snapshot: null })
      harness.active = false; harness.unsafe = true
      expect(await pipeline.read(state())).toMatchObject({ reason: 'invalid', snapshot: null })
      expect(harness.stops).toBeGreaterThanOrEqual(2)
    } finally { await pipeline.stop() }
  })
  it('awaits explicit pause and stop, rejects restart after terminal stop and never samples after shutdown', async () => {
    vi.useFakeTimers()
    const pipeline = new CanonicalIoResourcePipeline({ store: { readSnapshot: async () => state() } as unknown as StateStore, engine: new IoAnalyticsEngine() })
    await pipeline.start(); await pipeline.pause()
    expect(await pipeline.read(state())).toMatchObject({ reason: 'paused' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(harness.starts).toBe(1)
    await pipeline.resume(); expect(harness.starts).toBe(2)
    await pipeline.stop(); await vi.advanceTimersByTimeAsync(10_000)
    await expect(pipeline.start()).rejects.toThrow(/stopping/)
    expect(harness.starts).toBe(2)
  })
  it('updates the existing sampler only from a new actual desired-state snapshot', async () => {
    vi.useFakeTimers()
    const current = state()
    const readSnapshot = vi.fn(async () => current)
    const pipeline = new CanonicalIoResourcePipeline({ store: { readSnapshot } as unknown as StateStore, engine: new IoAnalyticsEngine() })
    await pipeline.start()
    try {
      current.checksum = 'b'.repeat(64)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(harness.instances).toBe(1); expect(harness.starts).toBe(1)
      expect(harness.configurations).toEqual([{ revision: 'a'.repeat(64), accounts: [] }, { revision: 'b'.repeat(64), accounts: [] }])
    } finally { await pipeline.stop() }
  })
})
