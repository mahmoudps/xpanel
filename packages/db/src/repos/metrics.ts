import { createHash } from 'node:crypto'
import { assertId, assertIdOrNull, assertInt, assertIsoDate, fail, oneOf } from '@xpanel/core'
import type { Id } from '@xpanel/core'
import type { Db } from '../client.ts'
import { withSqliteErrors } from '../sqlite-errors.ts'
import { clampLimit, nowIso } from './util.ts'

export interface MetricsSample {
  id: number
  at: string
  scope: 'host' | 'account'
  accountId: Id | null
  cpuPercent: number
  memoryMb: number
  diskMb: number
  bandwidthBytes: number
  ioReadBps: number
  ioWriteBps: number
  processes: number
  load1: number
  /** Present only for observed host samples. Absent on legacy rows and account counters. */
  hostObservation?: HostMetricsObservation
}

export interface HostMetricsObservation {
  load1: number | null
  load5: number | null
  load15: number | null
  memoryTotalBytes: number | null
  memoryAvailableBytes: number | null
  swapTotalBytes: number | null
  swapFreeBytes: number | null
  diskTotalBytes: number | null
  diskUsedBytes: number | null
  diskAvailableBytes: number | null
  /** Whole-host busy share of all CPUs since the previous sample (/proc/stat), 0 to 100. */
  cpuPercent: number | null
  /** Process count (numeric /proc entries). */
  processes: number | null
}

const hostFields = ['load1', 'load5', 'load15', 'memoryTotalBytes', 'memoryAvailableBytes', 'swapTotalBytes', 'swapFreeBytes', 'diskTotalBytes', 'diskUsedBytes', 'diskAvailableBytes', 'cpuPercent', 'processes'] as const
const validateHostObservation = (input: HostMetricsObservation): HostMetricsObservation => {
  // Rows recorded before cpuPercent/processes existed read those fields as unavailable.
  const value = Object.fromEntries(hostFields.map(key => [key, input[key] ?? null])) as unknown as HostMetricsObservation
  for (const key of hostFields) {
    const number = value[key]
    if (number !== null && (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > Number.MAX_SAFE_INTEGER || (key.endsWith('Bytes') || key === 'processes') && !Number.isSafeInteger(number) || key === 'cpuPercent' && number > 100)) fail('VALIDATION', `invalid host ${key}`)
  }
  for (const [total, parts] of [
    [value.memoryTotalBytes, [value.memoryAvailableBytes]],
    [value.swapTotalBytes, [value.swapFreeBytes]],
    [value.diskTotalBytes, [value.diskUsedBytes, value.diskAvailableBytes]],
  ] as const) {
    if (parts.some(part => part !== null && (total === null || part > total))) fail('VALIDATION', 'invalid host measurement bounds')
  }
  return value
}

export interface MetricsCursor {
  at: string
  id: number
}

export interface MetricsHistoryPage {
  items: MetricsSample[]
  nextCursor: MetricsCursor | null
  hasMore: boolean
}

interface MetricsRow {
  id: number
  at: string
  scope: 'host' | 'account'
  account_id: string | null
  cpu_percent: number
  memory_mb: number
  disk_mb: number
  bandwidth_bytes: number
  io_read_bps: number
  io_write_bps: number
  processes: number
  load1: number
  host_observation_json?: string | null
  [k: string]: unknown
}

const fromRow = (r: MetricsRow): MetricsSample => ({
  id: r.id,
  at: r.at,
  scope: r.scope,
  accountId: r.account_id,
  cpuPercent: r.cpu_percent,
  memoryMb: r.memory_mb,
  diskMb: r.disk_mb,
  bandwidthBytes: r.bandwidth_bytes,
  ioReadBps: r.io_read_bps,
  ioWriteBps: r.io_write_bps,
  processes: r.processes,
  load1: r.load1,
  ...(r.host_observation_json ? { hostObservation: validateHostObservation(JSON.parse(r.host_observation_json) as HostMetricsObservation) } : {}),
})

/** Observed host values are separate from legacy account counters. No row for a wholly failed read. */
export const recordHostMetricsSample = (db: Db, input: { at?: string; observation: HostMetricsObservation }): Promise<MetricsSample | null> => withSqliteErrors(async () => {
  const observation = validateHostObservation(input.observation)
  if (hostFields.every(key => observation[key] === null)) return null
  const at = input.at === undefined ? nowIso() : assertIsoDate(input.at, 'at').toISOString()
  const rows = await db.query<MetricsRow>(
    `INSERT INTO metrics_history (at, scope, host_observation_json) VALUES ($1, 'host', $2) RETURNING *`,
    [at, JSON.stringify(observation)],
  )
  return fromRow(rows[0]!)
})

const assertNonNegNum = (v: unknown, what: string): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fail('VALIDATION', `${what} must be >= 0`)

export const recordMetricsSample = (
  db: Db,
  input: {
    at?: string
    scope: 'host' | 'account'
    accountId?: Id | null
    cpuPercent?: number
    memoryMb?: number
    diskMb?: number
    bandwidthBytes?: number
    ioReadBps?: number
    ioWriteBps?: number
    processes?: number
    load1?: number
  },
): Promise<MetricsSample> =>
  withSqliteErrors(async () => {
    const scope = oneOf(input.scope, ['host', 'account'] as const, 'scope')
    const accountId = assertIdOrNull(input.accountId ?? null, 'accountId')
    if (scope === 'host' && accountId !== null) fail('VALIDATION', 'host metrics sample must not have accountId')
    if (scope === 'account' && accountId === null) fail('VALIDATION', 'account metrics sample requires accountId')
    const at = input.at !== undefined ? assertIsoDate(input.at, 'at').toISOString() : nowIso()
    const cpuPercent = assertNonNegNum(input.cpuPercent ?? 0, 'cpuPercent')
    const memoryMb = assertNonNegNum(input.memoryMb ?? 0, 'memoryMb')
    const diskMb = assertNonNegNum(input.diskMb ?? 0, 'diskMb')
    const bandwidthBytes = assertInt(input.bandwidthBytes ?? 0, 0, Number.MAX_SAFE_INTEGER, 'bandwidthBytes')
    const ioReadBps = assertInt(input.ioReadBps ?? 0, 0, Number.MAX_SAFE_INTEGER, 'ioReadBps')
    const ioWriteBps = assertInt(input.ioWriteBps ?? 0, 0, Number.MAX_SAFE_INTEGER, 'ioWriteBps')
    const processes = assertInt(input.processes ?? 0, 0, 1_000_000, 'processes')
    const load1 = assertNonNegNum(input.load1 ?? 0, 'load1')

    const rows = await db.query<MetricsRow>(
      `INSERT INTO metrics_history (
        at, scope, account_id, cpu_percent, memory_mb, disk_mb,
        bandwidth_bytes, io_read_bps, io_write_bps, processes, load1
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *`,
      [at, scope, accountId, cpuPercent, memoryMb, diskMb, bandwidthBytes, ioReadBps, ioWriteBps, processes, load1],
    )
    return fromRow(rows[0]!)
  })

export const listMetricsHistory = async (
  db: Db,
  opts: {
    scope: 'host' | 'account'
    accountId?: Id
    since?: string
    limit?: number
    cursor?: MetricsCursor
  },
): Promise<MetricsSample[]> => {
  const scope = oneOf(opts.scope, ['host', 'account'] as const, 'scope')
  const limit = clampLimit(opts.limit, 120, 2000)
  const clauses: string[] = ['scope = $1']
  const params: unknown[] = [scope]
  if (scope === 'account') {
    clauses.push(`account_id = $${params.length + 1}`)
    params.push(assertId(opts.accountId, 'accountId'))
  }
  if (opts.since !== undefined) {
    clauses.push(`at >= $${params.length + 1}`)
    params.push(assertIsoDate(opts.since, 'since').toISOString())
  }
  if (opts.cursor !== undefined) {
    const cursorAt = assertIsoDate(opts.cursor.at, 'cursor.at').toISOString()
    const cursorId = assertInt(opts.cursor.id, 1, Number.MAX_SAFE_INTEGER, 'cursor.id')
    const atIdx = params.length + 1
    const idIdx = params.length + 2
    clauses.push(`(at < $${atIdx} OR (at = $${atIdx} AND id < $${idIdx}))`)
    params.push(cursorAt, cursorId)
  }
  params.push(limit)
  const rows = await db.query<MetricsRow>(
    `SELECT * FROM metrics_history WHERE ${clauses.join(' AND ')} ORDER BY at DESC, id DESC LIMIT $${params.length}`,
    params,
  )
  return rows.map(fromRow)
}

export const listMetricsHistoryPage = async (
  db: Db,
  opts: {
    scope: 'host' | 'account'
    accountId?: Id
    since?: string
    limit?: number
    cursor?: MetricsCursor
  },
): Promise<MetricsHistoryPage> => {
  const pageSize = clampLimit(opts.limit, 50, 500)
  const fetched = await listMetricsHistory(db, {
    ...opts,
    limit: pageSize + 1,
  })
  const hasMore = fetched.length > pageSize
  const items = hasMore ? fetched.slice(0, pageSize) : fetched
  const last = items[items.length - 1]
  return {
    items,
    nextCursor: hasMore && last ? { at: last.at, id: last.id } : null,
    hasMore,
  }
}

export const pruneMetricsHistory = (db: Db, olderThanIso: string, scope?: 'host' | 'account'): Promise<number> =>
  withSqliteErrors(async () => {
    const cutoff = assertIsoDate(olderThanIso, 'olderThanIso').toISOString()
    const rows = await db.query<{ id: number }>(
      `DELETE FROM metrics_history WHERE at < $1${scope ? ' AND scope = $2' : ''} RETURNING id`,
      scope ? [cutoff, oneOf(scope, ['host', 'account'] as const, 'scope')] : [cutoff],
    )
    return rows.length
  })

export interface EntityCursor {
  createdAt: string
  id: Id
}

export interface IndexedAccountSummary {
  id: Id
  username: string
  uid: number
  ownerId: Id | null
  planId: Id
  primaryDomain: string
  status: string
  contactEmail: string
  ipv4: string
  createdAt: string
}

export interface IndexedDomainSummary {
  id: Id
  accountId: Id
  name: string
  kind: string
  parentDomainId: Id | null
  phpVersion: string
  siteType: string
  createdAt: string
}

export const listIndexedAccountsPage = async (
  db: Db,
  opts: {
    ownerId?: Id | null
    status?: string
    limit?: number
    cursor?: EntityCursor
  } = {},
): Promise<{ items: IndexedAccountSummary[]; nextCursor: EntityCursor | null; hasMore: boolean }> => {
  const pageSize = clampLimit(opts.limit, 50, 500)
  const clauses: string[] = []
  const params: unknown[] = []
  if (opts.ownerId !== undefined && opts.ownerId !== null) {
    params.push(assertId(opts.ownerId, 'ownerId'))
    clauses.push(`owner_id = $${params.length}`)
  }
  if (opts.status !== undefined) {
    params.push(opts.status)
    clauses.push(`status = $${params.length}`)
  }
  if (opts.cursor !== undefined) {
    const cAt = assertIsoDate(opts.cursor.createdAt, 'cursor.createdAt').toISOString()
    const cId = assertId(opts.cursor.id, 'cursor.id')
    const atIdx = params.length + 1
    const idIdx = params.length + 2
    clauses.push(`(created_at < $${atIdx} OR (created_at = $${atIdx} AND id < $${idIdx}))`)
    params.push(cAt, cId)
  }
  params.push(pageSize + 1)
  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = await db.query<{
    id: string
    username: string
    uid: number
    owner_id: string | null
    plan_id: string
    primary_domain: string
    status: string
    contact_email: string
    ipv4: string
    created_at: string
  }>(
    `SELECT id, username, uid, owner_id, plan_id, primary_domain, status, contact_email, ipv4, created_at
       FROM idx_accounts
       ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}`,
    params,
  )
  const hasMore = rows.length > pageSize
  const slice = hasMore ? rows.slice(0, pageSize) : rows
  const items: IndexedAccountSummary[] = slice.map((r) => ({
    id: r.id,
    username: r.username,
    uid: r.uid,
    ownerId: r.owner_id,
    planId: r.plan_id,
    primaryDomain: r.primary_domain,
    status: r.status,
    contactEmail: r.contact_email,
    ipv4: r.ipv4,
    createdAt: r.created_at,
  }))
  const last = items[items.length - 1]
  return {
    items,
    nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
    hasMore,
  }
}

export const listIndexedDomainsPage = async (
  db: Db,
  opts: {
    accountId?: Id
    limit?: number
    cursor?: EntityCursor
  } = {},
): Promise<{ items: IndexedDomainSummary[]; nextCursor: EntityCursor | null; hasMore: boolean }> => {
  const pageSize = clampLimit(opts.limit, 50, 500)
  const clauses: string[] = []
  const params: unknown[] = []
  if (opts.accountId !== undefined) {
    params.push(assertId(opts.accountId, 'accountId'))
    clauses.push(`account_id = $${params.length}`)
  }
  if (opts.cursor !== undefined) {
    const cAt = assertIsoDate(opts.cursor.createdAt, 'cursor.createdAt').toISOString()
    const cId = assertId(opts.cursor.id, 'cursor.id')
    const atIdx = params.length + 1
    const idIdx = params.length + 2
    clauses.push(`(created_at < $${atIdx} OR (created_at = $${atIdx} AND id < $${idIdx}))`)
    params.push(cAt, cId)
  }
  params.push(pageSize + 1)
  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = await db.query<{
    id: string
    account_id: string
    name: string
    kind: string
    parent_id: string | null
    php_version: string
    site_type: string
    created_at: string
  }>(
    `SELECT id, account_id, name, kind, parent_id, php_version, site_type, created_at
       FROM idx_domains
       ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}`,
    params,
  )
  const hasMore = rows.length > pageSize
  const slice = hasMore ? rows.slice(0, pageSize) : rows
  const items: IndexedDomainSummary[] = slice.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    name: r.name,
    kind: r.kind,
    parentDomainId: r.parent_id,
    phpVersion: r.php_version,
    siteType: r.site_type,
    createdAt: r.created_at,
  }))
  const last = items[items.length - 1]
  return {
    items,
    nextCursor: hasMore && last ? { createdAt: last.createdAt, id: last.id } : null,
    hasMore,
  }
}

export interface CgroupMonotonicCounters {
  monotonicMs: number
  cpuUsageUsec: number
  ioReadBytes: number
  ioWriteBytes: number
  ioReadOps?: number
  ioWriteOps?: number
  bandwidthBytes?: number
}

export interface MonotonicDeltaResult {
  rateAvailable: boolean
  firstSample: boolean
  counterReset: boolean
  elapsedSec: number
  cpuPercent: number
  ioReadBps: number
  ioWriteBps: number
  readIops: number
  writeIops: number
  bandwidthDeltaBytes: number
}

export class MonotonicMetricsTracker {
  private readonly baselines = new Map<string, CgroupMonotonicCounters>()

  computeDelta(
    key: string,
    curr: CgroupMonotonicCounters,
    opts: { cpuCores?: number; maxCpuPercent?: number } = {},
  ): MonotonicDeltaResult {
    const prev = this.baselines.get(key)
    const normalized: CgroupMonotonicCounters = {
      monotonicMs: curr.monotonicMs,
      cpuUsageUsec: Math.max(0, curr.cpuUsageUsec),
      ioReadBytes: Math.max(0, curr.ioReadBytes),
      ioWriteBytes: Math.max(0, curr.ioWriteBytes),
      ...(curr.ioReadOps !== undefined && { ioReadOps: Math.max(0, curr.ioReadOps) }),
      ...(curr.ioWriteOps !== undefined && { ioWriteOps: Math.max(0, curr.ioWriteOps) }),
      ...(curr.bandwidthBytes !== undefined && { bandwidthBytes: Math.max(0, curr.bandwidthBytes) }),
    }

    if (!prev) {
      this.baselines.set(key, normalized)
      return {
        rateAvailable: false,
        firstSample: true,
        counterReset: false,
        elapsedSec: 0,
        cpuPercent: 0,
        ioReadBps: 0,
        ioWriteBps: 0,
        readIops: 0,
        writeIops: 0,
        bandwidthDeltaBytes: 0,
      }
    }

    const elapsedMs = normalized.monotonicMs - prev.monotonicMs
    const counterReset =
      normalized.cpuUsageUsec < prev.cpuUsageUsec ||
      normalized.ioReadBytes < prev.ioReadBytes ||
      normalized.ioWriteBytes < prev.ioWriteBytes ||
      (normalized.ioReadOps !== undefined && prev.ioReadOps !== undefined && normalized.ioReadOps < prev.ioReadOps) ||
      (normalized.ioWriteOps !== undefined && prev.ioWriteOps !== undefined && normalized.ioWriteOps < prev.ioWriteOps) ||
      (normalized.bandwidthBytes !== undefined &&
        prev.bandwidthBytes !== undefined &&
        normalized.bandwidthBytes < prev.bandwidthBytes)

    this.baselines.set(key, normalized)

    if (elapsedMs <= 0 || counterReset) {
      return {
        rateAvailable: false,
        firstSample: false,
        counterReset,
        elapsedSec: 0,
        cpuPercent: 0,
        ioReadBps: 0,
        ioWriteBps: 0,
        readIops: 0,
        writeIops: 0,
        bandwidthDeltaBytes: 0,
      }
    }

    const elapsedSec = elapsedMs / 1000
    const cpuDeltaUsec = normalized.cpuUsageUsec - prev.cpuUsageUsec
    const cpuCores = opts.cpuCores !== undefined && opts.cpuCores > 0 ? opts.cpuCores : 1
    const maxCpuPercent = opts.maxCpuPercent ?? cpuCores * 100
    const rawCpuPct = (cpuDeltaUsec / (elapsedSec * 1_000_000 * cpuCores)) * (cpuCores * 100)
    const cpuPercent = Number(Math.min(maxCpuPercent, Math.max(0, rawCpuPct)).toFixed(1))

    const ioReadBps = Math.round((normalized.ioReadBytes - prev.ioReadBytes) / elapsedSec)
    const ioWriteBps = Math.round((normalized.ioWriteBytes - prev.ioWriteBytes) / elapsedSec)
    const readIops =
      normalized.ioReadOps !== undefined && prev.ioReadOps !== undefined
        ? Math.round((normalized.ioReadOps - prev.ioReadOps) / elapsedSec)
        : 0
    const writeIops =
      normalized.ioWriteOps !== undefined && prev.ioWriteOps !== undefined
        ? Math.round((normalized.ioWriteOps - prev.ioWriteOps) / elapsedSec)
        : 0
    const bandwidthDeltaBytes =
      normalized.bandwidthBytes !== undefined && prev.bandwidthBytes !== undefined
        ? Math.max(0, Math.round(normalized.bandwidthBytes - prev.bandwidthBytes))
        : 0

    return {
      rateAvailable: true,
      firstSample: false,
      counterReset: false,
      elapsedSec,
      cpuPercent,
      ioReadBps,
      ioWriteBps,
      readIops,
      writeIops,
      bandwidthDeltaBytes,
    }
  }

  reset(key?: string): void {
    if (key !== undefined) this.baselines.delete(key)
    else this.baselines.clear()
  }
}

export const recordMonotonicMetricsSample = async (
  db: Db,
  tracker: MonotonicMetricsTracker,
  input: {
    at?: string
    scope: 'host' | 'account'
    accountId?: Id | null
    monotonicMs: number
    cpuUsageUsec: number
    ioReadBytes: number
    ioWriteBytes: number
    ioReadOps?: number
    ioWriteOps?: number
    memoryMb?: number
    diskMb?: number
    bandwidthBytes?: number
    processes?: number
    load1?: number
    cpuCores?: number
  },
): Promise<{ sample: MetricsSample; delta: MonotonicDeltaResult }> => {
  const key = input.scope === 'host' ? 'host' : `account:${input.accountId ?? ''}`
  const delta = tracker.computeDelta(
    key,
    {
      monotonicMs: input.monotonicMs,
      cpuUsageUsec: input.cpuUsageUsec,
      ioReadBytes: input.ioReadBytes,
      ioWriteBytes: input.ioWriteBytes,
      ...(input.ioReadOps !== undefined && { ioReadOps: input.ioReadOps }),
      ...(input.ioWriteOps !== undefined && { ioWriteOps: input.ioWriteOps }),
      ...(input.bandwidthBytes !== undefined && { bandwidthBytes: input.bandwidthBytes }),
    },
    { ...(input.cpuCores !== undefined && { cpuCores: input.cpuCores }) },
  )
  const sample = await recordMetricsSample(db, {
    ...(input.at !== undefined && { at: input.at }),
    scope: input.scope,
    accountId: input.accountId ?? null,
    cpuPercent: delta.cpuPercent,
    memoryMb: input.memoryMb ?? 0,
    diskMb: input.diskMb ?? 0,
    bandwidthBytes: input.bandwidthBytes ?? 0,
    ioReadBps: delta.ioReadBps,
    ioWriteBps: delta.ioWriteBps,
    processes: input.processes ?? 0,
    load1: input.load1 ?? 0,
  })
  return { sample, delta }
}

export interface BoundedQueueOptions {
  maxConcurrency?: number
  maxQueueSize?: number
  maxPerAccountQueued?: number
  defaultTimeoutMs?: number
}

export interface BoundedQueueEnqueueOptions {
  accountId?: string | null
  signal?: AbortSignal
  timeoutMs?: number
  label?: string
}

export interface BoundedQueueStats {
  active: number
  queued: number
  completed: number
  rejectedBackpressure: number
  cancelled: number
  timedOut: number
  perAccountQueued: Record<string, number>
}

interface QueuedTaskEntry<T> {
  id: number
  bucketKey: string
  fn: (signal: AbortSignal) => Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
  timeoutMs: number
  externalSignal?: AbortSignal
  onExternalAbort?: () => void
  settled: boolean
}

const makeQueueError = (code: string, message: string): Error & { code: string } => {
  const err = new Error(message) as Error & { code: string }
  err.code = code
  return err
}

export class BoundedTaskQueue {
  private readonly maxConcurrency: number
  private readonly maxQueueSize: number
  private readonly maxPerAccountQueued: number
  private readonly defaultTimeoutMs: number
  private readonly buckets = new Map<string, QueuedTaskEntry<unknown>[]>()
  private readonly bucketOrder: string[] = []
  private rrCursor = 0
  private activeCount = 0
  private totalQueued = 0
  private completedCount = 0
  private rejectedCount = 0
  private cancelledCount = 0
  private timedOutCount = 0
  private nextTaskId = 1

  constructor(opts: BoundedQueueOptions = {}) {
    this.maxConcurrency = Math.max(1, opts.maxConcurrency ?? 4)
    this.maxQueueSize = Math.max(1, opts.maxQueueSize ?? 128)
    this.maxPerAccountQueued = Math.max(1, opts.maxPerAccountQueued ?? 16)
    this.defaultTimeoutMs = Math.max(10, opts.defaultTimeoutMs ?? 30_000)
  }

  stats(): BoundedQueueStats {
    const perAccountQueued: Record<string, number> = {}
    for (const [k, q] of this.buckets.entries()) {
      if (q.length > 0) perAccountQueued[k] = q.length
    }
    return {
      active: this.activeCount,
      queued: this.totalQueued,
      completed: this.completedCount,
      rejectedBackpressure: this.rejectedCount,
      cancelled: this.cancelledCount,
      timedOut: this.timedOutCount,
      perAccountQueued,
    }
  }

  enqueue<T>(fn: (signal: AbortSignal) => Promise<T>, opts: BoundedQueueEnqueueOptions = {}): Promise<T> {
    if (opts.signal?.aborted) {
      this.cancelledCount++
      return Promise.reject(makeQueueError('ERR_TASK_ABORTED', 'Task aborted before enqueue'))
    }

    const bucketKey = opts.accountId && opts.accountId.trim().length > 0 ? opts.accountId.trim() : '__host__'
    const existingBucket = this.buckets.get(bucketKey)
    const bucketLen = existingBucket ? existingBucket.length : 0

    if (this.totalQueued >= this.maxQueueSize) {
      this.rejectedCount++
      return Promise.reject(
        makeQueueError(
          'BACKPRESSURE_QUEUE_FULL',
          `Task queue full (${this.totalQueued}/${this.maxQueueSize})`,
        ),
      )
    }

    if (bucketLen >= this.maxPerAccountQueued) {
      this.rejectedCount++
      return Promise.reject(
        makeQueueError(
          'BACKPRESSURE_ACCOUNT_LIMIT',
          `Account ${bucketKey} exceeded queued task limit (${bucketLen}/${this.maxPerAccountQueued})`,
        ),
      )
    }

    return new Promise<T>((resolve, reject) => {
      const entry: QueuedTaskEntry<unknown> = {
        id: this.nextTaskId++,
        bucketKey,
        fn: fn as (signal: AbortSignal) => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
        timeoutMs: Math.max(5, opts.timeoutMs ?? this.defaultTimeoutMs),
        ...(opts.signal !== undefined && { externalSignal: opts.signal }),
        settled: false,
      }

      if (opts.signal) {
        const onAbort = () => {
          if (entry.settled) return
          entry.settled = true
          this.removeQueuedEntry(entry)
          this.cancelledCount++
          entry.reject(makeQueueError('ERR_TASK_ABORTED', 'Queued task cancelled via AbortSignal'))
        }
        entry.onExternalAbort = onAbort
        opts.signal.addEventListener('abort', onAbort, { once: true })
      }

      let bucket = this.buckets.get(bucketKey)
      if (!bucket) {
        bucket = []
        this.buckets.set(bucketKey, bucket)
        this.bucketOrder.push(bucketKey)
      }
      bucket.push(entry)
      this.totalQueued++
      this.pump()
    })
  }

  private removeQueuedEntry(entry: QueuedTaskEntry<unknown>): void {
    const bucket = this.buckets.get(entry.bucketKey)
    if (!bucket) return
    const idx = bucket.indexOf(entry)
    if (idx !== -1) {
      bucket.splice(idx, 1)
      this.totalQueued = Math.max(0, this.totalQueued - 1)
    }
    if (bucket.length === 0) {
      this.buckets.delete(entry.bucketKey)
      const orderIdx = this.bucketOrder.indexOf(entry.bucketKey)
      if (orderIdx !== -1) {
        this.bucketOrder.splice(orderIdx, 1)
        if (this.rrCursor >= this.bucketOrder.length) this.rrCursor = 0
      }
    }
  }

  private dequeueNextFair(): QueuedTaskEntry<unknown> | undefined {
    while (this.bucketOrder.length > 0 && this.totalQueued > 0) {
      if (this.rrCursor >= this.bucketOrder.length) {
        this.rrCursor = 0
      }
      const key = this.bucketOrder[this.rrCursor]!
      const bucket = this.buckets.get(key)
      if (!bucket || bucket.length === 0) {
        this.buckets.delete(key)
        this.bucketOrder.splice(this.rrCursor, 1)
        continue
      }
      const entry = bucket.shift()!
      this.totalQueued = Math.max(0, this.totalQueued - 1)
      if (bucket.length === 0) {
        this.buckets.delete(key)
        this.bucketOrder.splice(this.rrCursor, 1)
      } else {
        this.rrCursor = (this.rrCursor + 1) % this.bucketOrder.length
      }
      if (!entry.settled) return entry
    }
    return undefined
  }

  private pump(): void {
    while (this.activeCount < this.maxConcurrency && this.totalQueued > 0) {
      const entry = this.dequeueNextFair()
      if (!entry) break
      if (entry.externalSignal && entry.onExternalAbort) {
        entry.externalSignal.removeEventListener('abort', entry.onExternalAbort)
      }
      this.runEntry(entry)
    }
  }

  private runEntry(entry: QueuedTaskEntry<unknown>): void {
    if (entry.externalSignal?.aborted) {
      entry.settled = true
      this.cancelledCount++
      entry.reject(makeQueueError('ERR_TASK_ABORTED', 'Task aborted before execution'))
      this.pump()
      return
    }

    this.activeCount++
    const taskController = new AbortController()
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    let slotReleased = false

    const releaseSlotOnce = () => {
      if (slotReleased) return
      slotReleased = true
      this.activeCount = Math.max(0, this.activeCount - 1)
      this.pump()
    }

    const onAbortWhileRunning = () => {
      if (entry.settled) return
      entry.settled = true
      this.cancelledCount++
      taskController.abort()
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
      releaseSlotOnce()
      entry.reject(makeQueueError('ERR_TASK_ABORTED', 'Running task cancelled via AbortSignal'))
    }

    if (entry.externalSignal) {
      entry.externalSignal.addEventListener('abort', onAbortWhileRunning, { once: true })
    }

    timeoutHandle = setTimeout(() => {
      if (entry.settled) return
      entry.settled = true
      this.timedOutCount++
      taskController.abort()
      if (entry.externalSignal) {
        entry.externalSignal.removeEventListener('abort', onAbortWhileRunning)
      }
      releaseSlotOnce()
      entry.reject(makeQueueError('ERR_TASK_TIMEOUT', `Task exceeded timeout of ${entry.timeoutMs}ms`))
    }, entry.timeoutMs)

    Promise.resolve()
      .then(() => entry.fn(taskController.signal))
      .then(
        (result) => {
          if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
          if (entry.externalSignal) {
            entry.externalSignal.removeEventListener('abort', onAbortWhileRunning)
          }
          if (!entry.settled) {
            entry.settled = true
            this.completedCount++
            entry.resolve(result)
          }
          releaseSlotOnce()
        },
        (err) => {
          if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
          if (entry.externalSignal) {
            entry.externalSignal.removeEventListener('abort', onAbortWhileRunning)
          }
          if (!entry.settled) {
            entry.settled = true
            entry.reject(err)
          }
          releaseSlotOnce()
        },
      )
  }
}

export const createBoundedTaskQueue = (opts: BoundedQueueOptions = {}): BoundedTaskQueue =>
  new BoundedTaskQueue(opts)

export interface OperationalRetentionOptions {
  now?: Date
  metricsRetentionDays?: number
  sessionsRetentionDays?: number
  loginAttemptsRetentionDays?: number
  jobsRetentionDays?: number
}

export interface OperationalRetentionResult {
  ranAt: string
  prunedMetrics: number
  prunedSessions: number
  prunedLoginAttempts: number
  prunedLockouts: number
  prunedTerminalJobs: number
  auditLogPreservedCount: number
  auditChainDigest: string
}

export const runOperationalRetentionPrune = (
  db: Db,
  opts: OperationalRetentionOptions = {},
): Promise<OperationalRetentionResult> =>
  withSqliteErrors(async () => {
    const now = opts.now ?? new Date()
    const nowMs = now.getTime()
    const nowIsoStr = now.toISOString()

    const metricsCutoff = new Date(nowMs - (opts.metricsRetentionDays ?? 30) * 86_400_000).toISOString()
    const sessionsCutoff = new Date(nowMs - (opts.sessionsRetentionDays ?? 7) * 86_400_000).toISOString()
    const loginAttemptsCutoff = new Date(nowMs - (opts.loginAttemptsRetentionDays ?? 14) * 86_400_000).toISOString()
    const jobsCutoff = new Date(nowMs - (opts.jobsRetentionDays ?? 30) * 86_400_000).toISOString()

    const prunedMetrics = await pruneMetricsHistory(db, metricsCutoff)

    const sessionRows = await db.query<{ id: string }>(
      `DELETE FROM sessions
        WHERE expires_at <= $1
           OR (revoked_at IS NOT NULL AND revoked_at < $2)
        RETURNING id`,
      [nowIsoStr, sessionsCutoff],
    )

    const loginRows = await db.query<{ id: number }>(
      `DELETE FROM login_attempts WHERE at < $1 RETURNING id`,
      [loginAttemptsCutoff],
    )

    const lockoutRows = await db.query<{ id: string }>(
      `DELETE FROM lockouts WHERE locked_until <= $1 RETURNING id`,
      [nowIsoStr],
    )

    const jobRows = await db.query<{ id: string }>(
      `DELETE FROM jobs
        WHERE status IN ('succeeded', 'failed', 'cancelled')
          AND COALESCE(finished_at, created_at) < $1
          AND id NOT IN (SELECT job_id FROM job_runtime_leases WHERE needs_attention = 1)
          AND NOT EXISTS (SELECT 1 FROM reconcile_operations o WHERE o.job_id = jobs.id)
          AND NOT EXISTS (SELECT 1 FROM legacy_reference_repairs r WHERE r.job_id = jobs.id AND r.state = 'awaiting_intent')
        RETURNING id`,
      [jobsCutoff],
    )

    const auditRows = await db.query<{
      id: number
      at: string
      actor: string
      principal_id: string | null
      ip: string | null
      action: string
      target: string
      detail: string
      outcome: string
    }>(
      `SELECT id, at, actor, principal_id, ip, action, target, detail, outcome
         FROM audit_log
        ORDER BY id ASC`,
    )

    let chain = 'GENESIS'
    for (const r of auditRows) {
      const payload = `${chain}|${r.id}|${r.at}|${r.actor}|${r.principal_id ?? ''}|${r.ip ?? ''}|${r.action}|${r.target}|${r.outcome}|${r.detail}`
      chain = createHash('sha256').update(payload).digest('hex')
    }

    return {
      ranAt: nowIsoStr,
      prunedMetrics,
      prunedSessions: sessionRows.length,
      prunedLoginAttempts: loginRows.length,
      prunedLockouts: lockoutRows.length,
      prunedTerminalJobs: jobRows.length,
      auditLogPreservedCount: auditRows.length,
      auditChainDigest: chain,
    }
  })

export interface RetentionScheduler {
  readonly ready: Promise<OperationalRetentionResult>
  runNow: (nowOverride?: Date) => Promise<OperationalRetentionResult>
  stop: () => void
  lastResult: () => OperationalRetentionResult | null
  runsCount: () => number
}

export const createRetentionScheduler = (
  db: Db,
  opts: OperationalRetentionOptions & {
    intervalMs?: number
    runOnStart?: boolean
    nowFn?: () => Date
  } = {},
): RetentionScheduler => {
  let latest: OperationalRetentionResult | null = null
  let runs = 0
  let timer: ReturnType<typeof setInterval> | undefined

  const execute = async (overrideNow?: Date): Promise<OperationalRetentionResult> => {
    const now = overrideNow ?? (opts.nowFn ? opts.nowFn() : opts.now ?? new Date())
    const res = await runOperationalRetentionPrune(db, {
      ...opts,
      now,
    })
    latest = res
    runs++
    return res
  }

  const ready =
    opts.runOnStart !== false
      ? execute()
      : Promise.resolve({
          ranAt: new Date(0).toISOString(),
          prunedMetrics: 0,
          prunedSessions: 0,
          prunedLoginAttempts: 0,
          prunedLockouts: 0,
          prunedTerminalJobs: 0,
          auditLogPreservedCount: 0,
          auditChainDigest: 'GENESIS',
        })

  if (opts.intervalMs !== undefined && opts.intervalMs > 0) {
    timer = setInterval(() => {
      void execute().catch(() => {})
    }, opts.intervalMs)
    if (typeof timer === 'object' && 'unref' in timer && typeof timer.unref === 'function') {
      timer.unref()
    }
  }

  return {
    ready,
    runNow: execute,
    stop: () => {
      if (timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
    },
    lastResult: () => latest,
    runsCount: () => runs,
  }
}
