import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RESOURCE_OBSERVATION_FIELDS, isXpanelError, parseResourceObservationSnapshot, projectResourceObservationForLive, type Domain } from '@xpanel/core'
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

import { CanonicalIoResourcePipeline, IoAnalyticsEngine, parseMetricsLogLine, readWebsiteAnalyticsStore, WEBSITE_ANALYTICS_MAX_BYTES, WEBSITE_ANALYTICS_STALE_MS, WebsiteAnalyticsEngine, type SiteLogChunk } from './analytics.ts'

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
  it('keeps measured host fields in the per-account view and marks the unmeasured latency as partial', async () => {
    const engine = new IoAnalyticsEngine()
    expect(engine.readResourceAccounts(reading(), state())).toEqual({ state: 'partial', reason: null, observedAt: '2026-10-23T05:30:00.123Z',
      host: { cpuPercent: 12, memoryUsedBytes: 4_096, memoryTotalBytes: 8_192, loadAvg1m: 1, psiSomeAvg10: 0, psiFullAvg10: 0, awaitMs: null }, accounts: [], unmeasuredAccounts: 0 })
    expect(engine.readResourceAccounts({ state: 'sampling', failure: null, observation: null }, state())).toMatchObject({ state: 'unavailable', reason: 'not-sampled', host: null, accounts: [] })
    expect(engine.readResourceAccounts(reading(), { ...state(), checksum: 'b'.repeat(64) })).toMatchObject({ state: 'unavailable', reason: 'configuration-changed' })
    const pipeline = new CanonicalIoResourcePipeline({ store: { readSnapshot: async () => state() } as unknown as StateStore, engine })
    expect(await pipeline.readAccounts(state())).toMatchObject({ state: 'unavailable', reason: 'not-sampled' })
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

describe('website analytics from site access logs', () => {
  const ALICE = '11111111-1111-4111-8111-111111111111', BOB = '33333333-3333-4333-8333-333333333333'
  const T = '2026-11-06T10:00:00.000Z'
  const later = (minutes: number): string => new Date(Date.parse(T) + minutes * 60_000).toISOString()
  const site = { id: 'd-alice', accountId: ALICE, name: 'alice.test' } as Domain
  const parked = { id: 'd-parked', accountId: ALICE, name: 'parked.test' } as Domain
  const owners = new Map([['alice.test', site], ['www.alice.test', site], ['*.alice.test', site], ['parked.test', parked]])
  // A line as nginx writes it with `log_format xpanel_metrics escape=json`.
  const SAMPLE = '{"time":"2026-11-06T09:30:12+00:00","host":"alice.test","ip":"192.0.2.10","method":"GET","uri":"/shop/item?id=7","status":200,"body_bytes":5120,"bytes":5432,'
    + '"request_bytes":412,"request_time":0.031,"upstream_time":"0.020, 0.008 : 0.002","cache":"MISS","referer":"https://search.example/q?x=1","agent":"Mozilla/5.0"}'
  const metric = (fields: Record<string, unknown> = {}): string => JSON.stringify({ ...JSON.parse(SAMPLE), uri: '/', bytes: 100, request_time: 0.001, upstream_time: '', cache: '', referer: '', ...fields }) + '\n'
  const chunk = (text: string, patch: Partial<SiteLogChunk> = {}): SiteLogChunk => ({ path: '/var/log/xpanel/nginx/alice.test.access.log', accountId: ALICE, owners, identity: '1:1', start: 0,
    sizeBytes: Buffer.byteLength(text), bytes: Buffer.from(text), readAt: T, since: '2026-10-01T00:00:00.000Z', caughtUp: true, ...patch })
  const query = (engine: WebsiteAnalyticsEngine, window: '1h' | '24h' | '7d' | '30d' = '24h', domain: Domain = site, now = new Date(T)) => engine.queryDomainSnapshot(domain, { window, now })
  const refusal = (read: () => unknown): unknown => { try { read() } catch (error) { return isXpanelError(error) ? { code: error.code, ...error.detail } : error } return null }
  const memoryStore = (data: unknown = null) => { const store = { data, writes: 0, read: async () => store.data, write: async (value: unknown) => { store.writes++; store.data = structuredClone(value) } }; return store }

  it('parses the rendered xpanel_metrics format and rejects malformed lines', () => {
    expect(parseMetricsLogLine(SAMPLE)).toMatchObject({ time: '2026-11-06T09:30:12+00:00', host: 'alice.test', status: 200, bytes: 5432, request_bytes: 412, request_time: 0.031, cache: 'MISS' })
    const sample = JSON.parse(SAMPLE) as Record<string, unknown>
    const bad = ['', 'not json', '[]', '{"time":"2026-11-06T09:30:12+00:00"', JSON.stringify({ ...sample, status: '200' }), JSON.stringify({ ...sample, status: 99 }), JSON.stringify({ ...sample, bytes: -1 }),
      JSON.stringify({ ...sample, time: 'yesterday' }), JSON.stringify({ ...sample, host: '' }), JSON.stringify({ ...sample, request_time: undefined }), JSON.stringify({ ...sample, agent: 'x'.repeat(17_000) }),
      // the pre-render field names are not the edge format
      JSON.stringify({ ts: sample.time, host: 'alice.test', ip: '192.0.2.10', method: 'GET', uri: '/', status: 200, bytes: 1, rt: 0.1, urt: 0.1, ref: '-' })]
    for (const line of bad) expect(parseMetricsLogLine(line), line.slice(0, 80)).toBeNull()
  })

  it('aggregates each line for the domain that serves its host name over complete hours', () => {
    const engine = new WebsiteAnalyticsEngine()
    const text = SAMPLE + '\n'
      + metric({ host: 'www.alice.test', ip: '192.0.2.11', uri: '/missing', status: 404, bytes: 300, request_time: 0.002 })
      + metric({ host: 'IMG.alice.test', uri: '/shop/item', status: 503, bytes: 200, request_time: 0.5, upstream_time: '0.499', cache: 'BYPASS' })
      + metric({ host: 'parked.test', status: 301, bytes: 150 })
      + metric({ host: 'foreign.test' }) + 'not json\n'
      + metric({ time: '2026-11-06T08:15:00+00:00', ip: '192.0.2.12', bytes: 1000, request_time: 0.004, cache: 'HIT' })
      // the hour still running is not part of any window yet
      + metric({ time: '2026-11-06T10:00:00+00:00', bytes: 7 })
    expect(engine.ingestSiteLog(chunk(text))).toBe(6)
    const snapshot = query(engine)
    expect(snapshot).toMatchObject({ domain: 'alice.test', accountId: ALICE, at: T, totals: { requests: 4, bytes: 6932, uniqueVisitors: 3, cacheHitRatioPercent: 25, errorRatePercent: 25,
      avgRequestTimeMs: 134.25, p95RequestTimeMs: 500, avgUpstreamTimeMs: 132.25, status2xx: 2, status3xx: 0, status4xx: 1, status5xx: 1 } })
    expect(snapshot.series).toMatchObject([{ at: '2026-11-06T08:00:00.000Z', requests: 1, bytes: 1000, cacheHit: 1 }, { at: '2026-11-06T09:00:00.000Z', requests: 3, bytes: 5932, status5xx: 1, cacheMiss: 2, cacheBypass: 1 }])
    expect(snapshot.topPaths).toEqual([{ key: '/shop/item', requests: 2, bytes: 5632, errors5xx: 1 }, { key: '/', requests: 1, bytes: 1000 }, { key: '/missing', requests: 1, bytes: 300 }])
    expect(snapshot.topReferrers).toEqual([{ key: 'Direct', requests: 3, bytes: 1500, errors5xx: 1 }, { key: 'search.example', requests: 1, bytes: 5432 }])
    expect(query(engine, '1h').totals).toMatchObject({ requests: 3, bytes: 5932 })
    expect(query(engine, '24h', parked).totals).toMatchObject({ requests: 1, bytes: 150, status3xx: 1 })
  })

  it('counts a re-read once and a rotated or truncated log from its start', () => {
    const engine = new WebsiteAnalyticsEngine()
    const [a, b, c, d, e, f] = ['192.0.2.1', '192.0.2.2', '192.0.2.3', '192.0.2.4', '192.0.2.5', '192.0.2.6'].map(ip => metric({ ip }))
    expect(engine.ingestSiteLog(chunk(a! + b!))).toBe(2)
    // a failed ledger write re-reads the same bytes; a reset cursor re-reads from the start
    expect(engine.ingestSiteLog(chunk(a! + b!))).toBe(0)
    expect(engine.ingestSiteLog(chunk(a! + b! + c!))).toBe(1)
    // copytruncate: the same file is now smaller than what was read
    expect(engine.ingestSiteLog(chunk(d!))).toBe(1)
    // rotation: a new file identity
    expect(engine.ingestSiteLog(chunk(e!, { identity: '1:2' }))).toBe(1)
    expect(engine.ingestSiteLog(chunk(f!, { identity: '1:2', start: Buffer.byteLength(e!), sizeBytes: Buffer.byteLength(e! + f!) }))).toBe(1)
    expect(query(engine).totals.requests).toBe(6)
  })

  it('serves a window only when every hour of it was read, recently, for the current owner', () => {
    const engine = new WebsiteAnalyticsEngine()
    expect(refusal(() => query(engine))).toEqual({ code: 'SERVICE_UNAVAILABLE', reason: 'not-read', stateChanged: false })
    engine.ingestSiteLog(chunk('', { since: '2026-11-06T08:00:00.000Z', caughtUp: false }))
    expect(refusal(() => query(engine, '1h'))).toMatchObject({ reason: 'not-read' })
    engine.ingestSiteLog(chunk('', { since: T }))
    // a fully read idle hour is a measured zero
    expect(query(engine, '1h').totals.requests).toBe(0)
    expect(refusal(() => query(engine, '24h'))).toMatchObject({ reason: 'window-not-covered' })
    expect(refusal(() => query(engine, '1h', site, new Date(Date.parse(T) + WEBSITE_ANALYTICS_STALE_MS + 1)))).toMatchObject({ reason: 'stale' })
    expect(refusal(() => query(engine, '1h', { ...site, accountId: BOB }))).toMatchObject({ reason: 'not-read' })
    // the domain moved to another account: its history starts again
    engine.ingestSiteLog(chunk('', { accountId: BOB, since: T }))
    expect(refusal(() => query(engine, '1h', { ...site, accountId: BOB }))).toMatchObject({ reason: 'window-not-covered' })
    // reading began mid-hour: that hour stays partial, the next complete hour is served
    const partial = new WebsiteAnalyticsEngine()
    partial.ingestSiteLog(chunk(metric({ time: '2026-11-06T09:40:00+00:00' }), { since: '2026-11-06T09:30:00.000Z' }))
    expect(refusal(() => query(partial, '1h'))).toMatchObject({ reason: 'window-not-covered' })
    partial.ingestSiteLog(chunk(metric({ time: '2026-11-06T10:40:00+00:00' }), { start: Buffer.byteLength(metric({ time: '2026-11-06T09:40:00+00:00' })), sizeBytes: 2 * Buffer.byteLength(metric()), readAt: later(65) }))
    expect(query(partial, '1h', site, new Date(later(65)))).toMatchObject({ at: '2026-11-06T11:00:00.000Z', totals: { requests: 1 } })
    // bytes that were never counted (a save lost before a restart), or a rotation after a stale read, restart the history
    const gap = new WebsiteAnalyticsEngine()
    gap.ingestSiteLog(chunk(''))
    gap.ingestSiteLog(chunk('', { start: 50, sizeBytes: 50, since: T }))
    expect(refusal(() => query(gap, '1h'))).toMatchObject({ reason: 'window-not-covered' })
    const stale = new WebsiteAnalyticsEngine()
    stale.ingestSiteLog(chunk(''))
    stale.ingestSiteLog(chunk('', { identity: '1:2', readAt: later(20) }))
    expect(refusal(() => query(stale, '1h', site, new Date(later(20))))).toMatchObject({ reason: 'window-not-covered' })
  })

  it('keeps every read window across a restart and continues the same history', async () => {
    const store = memoryStore()
    const first = new WebsiteAnalyticsEngine({ store })
    await first.load()
    const text = SAMPLE + '\n' + metric({ ip: '192.0.2.11', uri: '/b', time: '2026-11-05T12:00:00+00:00' })
    first.ingestSiteLog(chunk(text, { since: '2026-11-04T00:00:00.000Z' }))
    await first.save(new Date(T))
    const second = new WebsiteAnalyticsEngine({ store })
    expect(refusal(() => query(second))).toMatchObject({ reason: 'not-read' })
    await second.load()
    expect(query(second)).toEqual(query(first))
    expect(query(second).totals).toMatchObject({ requests: 2, uniqueVisitors: 2 })
    // complete days only: the history began on 2026-11-04, so the last seven days are partial
    expect(refusal(() => query(second, '7d'))).toMatchObject({ reason: 'window-not-covered' })
    // the next read continues at the saved offset, so the history is unbroken
    second.ingestSiteLog(chunk(metric({ time: '2026-11-06T10:30:00+00:00' }), { start: Buffer.byteLength(text), sizeBytes: Buffer.byteLength(text) + Buffer.byteLength(metric()), readAt: later(65), since: T }))
    expect(query(second, '24h', site, new Date(later(65))).totals.requests).toBe(3)
  })

  it('discards a corrupt or unreadable store, refuses until read again and never throws', async () => {
    const valid = memoryStore()
    const source = new WebsiteAnalyticsEngine({ store: valid })
    source.ingestSiteLog(chunk(SAMPLE + '\n'))
    await source.save(new Date(T))
    const saved = valid.data as { domains: Record<string, { hours: string[] }> }
    const broken = [
      'garbage', { marks: {}, domains: [] },
      { ...saved, domains: { [site.id]: { ...saved.domains[site.id], since: -1 } } },
      { ...saved, domains: { [site.id]: { ...saved.domains[site.id], hours: ['not json'] } } },
      { ...saved, domains: { [site.id]: { ...saved.domains[site.id], hours: [saved.domains[site.id]!.hours[0]!.replace(/^\[\d+/, '[1')] } } },
    ]
    for (const raw of broken) {
      const store = memoryStore(raw), engine = new WebsiteAnalyticsEngine({ store })
      await engine.load()
      expect(refusal(() => query(engine))).toMatchObject({ reason: 'not-read' })
      engine.ingestSiteLog(chunk(SAMPLE + '\n', { since: T }))
      await engine.save(new Date(T))
      const reloaded = new WebsiteAnalyticsEngine({ store })
      await reloaded.load()
      expect(refusal(() => query(reloaded, '1h'))).toMatchObject({ reason: 'window-not-covered' })
    }
    const failing = new WebsiteAnalyticsEngine({ store: { read: async () => { throw new Error('unreadable') }, write: async () => { throw new Error('disk full') } } })
    await failing.load()
    failing.ingestSiteLog(chunk(SAMPLE + '\n'))
    await expect(failing.save(new Date(T))).resolves.toBeUndefined()
    expect(query(failing).totals.requests).toBe(1)
    const dir = await mkdtemp(join(tmpdir(), 'xp-web-analytics-'))
    try {
      expect(await readWebsiteAnalyticsStore(join(dir, 'missing.json'))).toBeNull()
      await writeFile(join(dir, 'big.json'), '')
      await truncate(join(dir, 'big.json'), WEBSITE_ANALYTICS_MAX_BYTES + 1)
      await expect(readWebsiteAnalyticsStore(join(dir, 'big.json'))).rejects.toThrow()
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('keeps 31 days and the size bound, dropping the oldest buckets first', async () => {
    const days = Array.from({ length: 40 }, (_, day) => metric({ time: new Date(Date.parse(T) - day * 86_400_000 - 3_600_000).toISOString(), ip: '192.0.2.' + day, uri: '/page-' + day }))
    const kept = new WebsiteAnalyticsEngine()
    expect(kept.ingestSiteLog(chunk(days.join(''), { since: '2026-09-01T00:00:00.000Z' }))).toBe(31)
    expect(query(kept, '30d').totals.requests).toBe(30)
    const store = memoryStore(), bounded = new WebsiteAnalyticsEngine({ store, maxBytes: 6000 })
    bounded.ingestSiteLog(chunk(days.join(''), { since: '2026-09-01T00:00:00.000Z' }))
    await bounded.save(new Date(T))
    const written = store.data as { domains: Record<string, { days: string[]; hours: string[] }> }
    expect(JSON.stringify(written, null, 2).length).toBeLessThanOrEqual(6000)
    expect(written.domains[site.id]!.days.length).toBeLessThan(31)
    expect(written.domains[site.id]!.hours.length).toBe(2)
    // the dropped days end the complete history; the recent hours are still served
    expect(refusal(() => query(bounded, '30d'))).toMatchObject({ reason: 'window-not-covered' })
    expect(query(bounded, '1h').totals.requests).toBe(1)
    // two days later the hour buckets have aged out and the oldest day buckets follow
    const aging = memoryStore(), aged = new WebsiteAnalyticsEngine({ store: aging })
    aged.ingestSiteLog(chunk(days.join(''), { since: '2026-09-01T00:00:00.000Z' }))
    await aged.save(new Date(Date.parse(T) + 2 * 86_400_000))
    expect((aging.data as typeof written).domains[site.id]).toMatchObject({ hours: [], days: expect.any(Array) })
    expect((aging.data as typeof written).domains[site.id]!.days).toHaveLength(29)
    const retained = memoryStore()
    await new WebsiteAnalyticsEngine({ store: retained }).save(new Date(T))
    expect(retained.data).toEqual({ marks: {}, domains: {} })
  })
})
