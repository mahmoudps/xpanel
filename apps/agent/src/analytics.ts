import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { assertResourceConfigurationBinding, effectivePlan, fail, isUnlimited, parseResourceObservationSnapshot, RESOURCE_SAMPLE_INTERVAL_MS } from '@xpanel/core'
import type {
  Account,
  CanonicalIoAnalyticsUnavailable,
  AccountIoRank,
  Domain,
  Id,
  IoAnalyticsPoint,
  IoAnalyticsSnapshot,
  LiveEvent,
  Plan,
  WebsiteAnalyticsSnapshot,
  WebsiteTopEntry,
  WebsiteTrafficBucket,
} from '@xpanel/core'
import type { AccountSliceMetrics, AgentExecutor } from './executor.ts'
import type { StateSnapshot, StateStore } from '@xpanel/state'
import { readLifecyclePublicStatus } from '../../../scripts/lifecycle-admission.mjs'
import { LinuxResourceObservationSampler, type ResourceSamplerReading } from './resource-observations.ts'
import { BANDWIDTH_INTERVAL_MS } from './metering.ts'

export type CanonicalIoAnalyticsRead = CanonicalIoAnalyticsUnavailable | { readonly available: true; readonly snapshot: IoAnalyticsSnapshot }

export const unavailableIoAnalytics = (
  reason: CanonicalIoAnalyticsUnavailable['reason'], fieldReasons: Readonly<Record<string, string>> = {}, observedAt: string | null = null,
): CanonicalIoAnalyticsUnavailable => Object.freeze({ available: false, snapshot: null, reason, fieldReasons: Object.freeze({ ...fieldReasons }), observedAt })

export type SliceRuntimeMetrics = AccountSliceMetrics

/** Host fields of the cached resource observation; null when the field was not measured. */
export interface IoHostFields { cpuPercent: number | null; memoryUsedBytes: number | null; memoryTotalBytes: number | null; loadAvg1m: number | null; psiSomeAvg10: number | null; psiFullAvg10: number | null; awaitMs: number | null }
/** Per-account IO, memory and process snapshot for /whm/monitoring/io. Accounts with any unmeasured field are counted, never shown as zero. */
export interface IoAccountsView {
  state: 'read' | 'partial' | 'unavailable'
  reason: CanonicalIoAnalyticsUnavailable['reason'] | null
  observedAt: string | null
  host: IoHostFields | null
  accounts: AccountIoRank[]
  unmeasuredAccounts: number
}

/** The fields of `log_format xpanel_metrics` (packages/render/src/edge/nginx.ts); times are seconds as nginx logs them. */
export interface NginxMetricLogLine {
  time: string
  host: string
  ip: string
  method: string
  uri: string
  status: number
  body_bytes: number
  bytes: number
  request_bytes: number
  request_time: number
  upstream_time: string
  cache: string
  referer: string
  agent: string
}

export interface CgroupIoStatCounters {
  rbytes: number
  wbytes: number
  rios: number
  wios: number
  dbytes: number
  dios: number
  devices: number
}

export interface CgroupCpuStatCounters {
  usageUsec: number
  userUsec: number
  systemUsec: number
  nrPeriods: number
  nrThrottled: number
  throttledUsec: number
}

export interface ExtendedSliceRuntimeMetrics extends SliceRuntimeMetrics {
  ioReadOps?: number
  ioWriteOps?: number
  rios?: number
  wios?: number
  ioStatRaw?: string
  cpuStatRaw?: string
}

export interface AccountSampleRateMeta {
  rateAvailable: boolean
  firstSample: boolean
  counterReset: boolean
  elapsedSec: number
}

/**
 * Parses cgroup v2 `io.stat` content (`<maj>:<min> rbytes=... wbytes=... rios=... wios=...`).
 * Aggregates counters across block devices and returns zeros when empty or missing.
 */
export const parseCgroupIoStat = (raw: string): CgroupIoStatCounters => {
  const totals: CgroupIoStatCounters = {
    rbytes: 0,
    wbytes: 0,
    rios: 0,
    wios: 0,
    dbytes: 0,
    dios: 0,
    devices: 0,
  }
  if (typeof raw !== 'string' || raw.trim().length === 0) return totals

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || !/^\d+:\d+\s+/.test(line)) continue
    let matchedAny = false
    for (const token of line.split(/\s+/).slice(1)) {
      const eq = token.indexOf('=')
      if (eq <= 0) continue
      const key = token.slice(0, eq)
      const val = Number.parseInt(token.slice(eq + 1), 10)
      if (!Number.isFinite(val) || val < 0) continue
      if (key === 'rbytes') {
        totals.rbytes += val
        matchedAny = true
      } else if (key === 'wbytes') {
        totals.wbytes += val
        matchedAny = true
      } else if (key === 'rios') {
        totals.rios += val
        matchedAny = true
      } else if (key === 'wios') {
        totals.wios += val
        matchedAny = true
      } else if (key === 'dbytes') {
        totals.dbytes += val
        matchedAny = true
      } else if (key === 'dios') {
        totals.dios += val
        matchedAny = true
      }
    }
    if (matchedAny) totals.devices++
  }
  return totals
}

/**
 * Parses cgroup v2 `cpu.stat` content (`usage_usec`, `user_usec`, `system_usec`, etc.).
 */
export const parseCgroupCpuStat = (raw: string): CgroupCpuStatCounters => {
  const out: CgroupCpuStatCounters = {
    usageUsec: 0,
    userUsec: 0,
    systemUsec: 0,
    nrPeriods: 0,
    nrThrottled: 0,
    throttledUsec: 0,
  }
  if (typeof raw !== 'string' || raw.trim().length === 0) return out
  for (const rawLine of raw.split(/\r?\n/)) {
    const parts = rawLine.trim().split(/\s+/)
    if (parts.length < 2) continue
    const key = parts[0]
    const val = Number.parseInt(parts[1]!, 10)
    if (!Number.isFinite(val) || val < 0) continue
    if (key === 'usage_usec') out.usageUsec = val
    else if (key === 'user_usec') out.userUsec = val
    else if (key === 'system_usec') out.systemUsec = val
    else if (key === 'nr_periods') out.nrPeriods = val
    else if (key === 'nr_throttled') out.nrThrottled = val
    else if (key === 'throttled_usec') out.throttledUsec = val
  }
  return out
}

interface PreviousSample {
  monoMs: number
  cpuUsageUsec: number
  ioReadBytes: number
  ioWriteBytes: number
  ioReadOps: number | null
  ioWriteOps: number | null
}

const MAX_IO_HISTORY_POINTS = 60
const DEFAULT_HOST_MEMORY_TOTAL_BYTES = 16 * 1024 * 1024 * 1024

const computeRate = (curr: number, prev: number, elapsedSec: number): number => {
  if (elapsedSec <= 0 || curr < prev) return 0
  return Math.round((curr - prev) / elapsedSec)
}

const usageSeverity = (pct: number): 'ok' | 'warn' | 'critical' =>
  pct >= 95 ? 'critical' : pct >= 80 ? 'warn' : 'ok'

/**
 * Real-time Server & Account IO Monitor engine.
 * Samples per-account cgroup v2 slices (`xpanel-<uid>.slice`), computes per-second read/write
 * throughput, IOPS (strictly from kernel `rios`/`wios` operation counters, never estimated from byte rates),
 * CPU %, and memory pressure using monotonic clock deltas, ranks accounts against plan caps (`80%` warn,
 * `95%` critical), and emits `io.analytics` live events.
 */
export class IoAnalyticsEngine {
  private readonly prevByAccount = new Map<Id, PreviousSample>()
  private readonly metaByAccount = new Map<Id, AccountSampleRateMeta>()
  private readonly history: IoAnalyticsPoint[] = []
  private readonly memoryTotalBytes: number
  private readonly cpuCores: number
  private readonly clockMs: () => number

  /** Cached, configuration-bound production projection. Parsing does not qualify kernel origin. */
  readResourceObservation(reading: ResourceSamplerReading, state: StateSnapshot): CanonicalIoAnalyticsRead {
    const projected = this.projectResourceObservation(reading, state)
    if ('unavailable' in projected) return projected.unavailable
    const { observedAt, reasons, host, ranks } = projected
    const { cpuPercent, memoryUsedBytes, memoryTotalBytes, loadAvg1m, psiSomeAvg10, psiFullAvg10, awaitMs } = host
    if (Object.keys(reasons).length > 0 || cpuPercent === null || memoryUsedBytes === null || memoryTotalBytes === null || loadAvg1m === null || psiSomeAvg10 === null || psiFullAvg10 === null || awaitMs === null) {
      return unavailableIoAnalytics('incomplete', reasons, observedAt)
    }
    const sum = (key: 'readBytesPerSec' | 'writeBytesPerSec' | 'readIops' | 'writeIops'): number => ranks.reduce((total, account) => total + account[key], 0)
    const current: IoAnalyticsPoint = { at: observedAt, readBytesPerSec: sum('readBytesPerSec'), writeBytesPerSec: sum('writeBytesPerSec'),
      readIops: sum('readIops'), writeIops: sum('writeIops'), cpuPercent, memoryUsedBytes, memoryTotalBytes, loadAvg1m, psiSomeAvg10, psiFullAvg10, awaitMs }
    if (memoryTotalBytes <= 0 || Object.entries(current).some(([key, number]) => key !== 'at' && (typeof number !== 'number' || !Number.isFinite(number) || number < 0))) {
      return unavailableIoAnalytics('invalid', { aggregate: 'invalid' }, observedAt)
    }
    return { available: true, snapshot: { at: observedAt, current, history: [current], accounts: ranks } }
  }

  /** The same cached projection, keeping every fully measured account and host field when others are missing. */
  readResourceAccounts(reading: ResourceSamplerReading, state: StateSnapshot): IoAccountsView {
    const projected = this.projectResourceObservation(reading, state)
    if ('unavailable' in projected) return { state: 'unavailable', reason: projected.unavailable.reason, observedAt: projected.unavailable.observedAt, host: null, accounts: [], unmeasuredAccounts: 0 }
    const unmeasured = new Set(Object.keys(projected.reasons).filter(key => key.startsWith('accounts.')).map(key => key.split('.')[1]))
    const partial = unmeasured.size > 0 || Object.values(projected.host).some(value => value === null)
    return { state: partial ? 'partial' : 'read', reason: null, observedAt: projected.observedAt, host: projected.host, accounts: projected.ranks, unmeasuredAccounts: unmeasured.size }
  }

  private projectResourceObservation(reading: ResourceSamplerReading, state: StateSnapshot): { unavailable: CanonicalIoAnalyticsUnavailable } | { observedAt: string; reasons: Record<string, string>; host: IoHostFields; ranks: AccountIoRank[] } {
    if (reading.observation === null) return { unavailable: unavailableIoAnalytics(reading.state === 'blocked' || reading.state === 'failed' ? 'invalid' : 'not-sampled') }
    let observed
    const active = state.accounts.filter(account => account.status === 'active')
    try {
      observed = parseResourceObservationSnapshot(reading.observation.snapshot)
    } catch { return { unavailable: unavailableIoAnalytics('invalid') } }
    try { assertResourceConfigurationBinding(observed, { revision: state.checksum, accountIds: active.map(account => account.id) }) }
    catch { return { unavailable: unavailableIoAnalytics('configuration-changed') } }
    if (reading.state !== 'ready' || reading.observation.freshness !== 'fresh') {
      return { unavailable: unavailableIoAnalytics(reading.observation.freshness === 'stale' ? 'stale' : 'invalid', {}, observed.observedAt) }
    }
    const reasons: Record<string, string> = Object.create(null)
    const value = (name: string, field: { value: number | null; availability: string }): number | null => {
      if (field.availability !== 'known' || typeof field.value !== 'number' || !Number.isFinite(field.value) || field.value < 0) {
        reasons[name] = field.availability === 'known' ? 'invalid' : field.availability
        return null
      }
      return field.value
    }
    const hostFields = observed.host.fields
    const host: IoHostFields = {
      cpuPercent: value('cpuPercent', hostFields.cpuBusyPercent),
      memoryUsedBytes: value('memoryUsedBytes', hostFields.memoryUsedBytes),
      memoryTotalBytes: value('memoryTotalBytes', hostFields.memoryTotalBytes),
      loadAvg1m: value('loadAvg1m', hostFields.loadAvg1m),
      psiSomeAvg10: value('psiSomeAvg10', hostFields.ioPressureSomeAvg10),
      psiFullAvg10: value('psiFullAvg10', hostFields.ioPressureFullAvg10),
      awaitMs: value('awaitMs', observed.deferred.aggregateAwaitMs),
    }
    const byId = new Map(observed.accounts.map(account => [account.accountId, account]))
    const plans = new Map(state.plans.map(plan => [plan.id, plan]))
    const ranks: AccountIoRank[] = []
    for (const account of active) {
      const sample = byId.get(account.id), stored = plans.get(account.planId), plan = stored && effectivePlan(stored, account)
      const prefix = 'accounts.' + account.username + '.'
      if (!sample || !plan) { reasons[prefix + 'identity'] = sample ? 'missing-plan' : 'missing'; continue }
      const fields = sample.fields
      const readBytesPerSec = value(prefix + 'readBytesPerSec', fields.readBytesPerSec)
      const writeBytesPerSec = value(prefix + 'writeBytesPerSec', fields.writeBytesPerSec)
      const readIops = value(prefix + 'readIops', fields.readIops)
      const writeIops = value(prefix + 'writeIops', fields.writeIops)
      const accountCpu = value(prefix + 'cpuPercent', fields.cpuPercent)
      const memoryCurrentBytes = value(prefix + 'memoryCurrentBytes', fields.memoryCurrentBytes)
      const pidsCurrent = value(prefix + 'pidsCurrent', fields.pidsCurrent)
      if (readBytesPerSec === null || writeBytesPerSec === null || readIops === null || writeIops === null || accountCpu === null || memoryCurrentBytes === null || pidsCurrent === null) continue
      let statusLevel: AccountIoRank['statusLevel'] = 'ok'
      for (const [usage, cap] of [[readBytesPerSec, plan.resources.ioReadBps], [writeBytesPerSec, plan.resources.ioWriteBps], [readIops, plan.resources.ioReadIops], [writeIops, plan.resources.ioWriteIops]] as const) {
        if (cap === 'unlimited' || cap <= 0) continue
        const severity = usageSeverity(usage / cap * 100)
        if (severity === 'critical' || severity === 'warn' && statusLevel === 'ok') statusLevel = severity
      }
      ranks.push({ accountId: account.id, username: account.username, uid: account.uid, readBytesPerSec, writeBytesPerSec,
        readIops, writeIops, cpuPercent: accountCpu, memoryCurrentBytes, memoryLimitMb: plan.resources.memoryMb,
        pidsCurrent, pidsLimit: plan.resources.maxProcesses, statusLevel })
    }
    ranks.sort((a, b) => b.readBytesPerSec + b.writeBytesPerSec - a.readBytesPerSec - a.writeBytesPerSec)
    return { observedAt: observed.observedAt, reasons, host, ranks }
  }

  constructor(opts: { memoryTotalBytes?: number; cpuCores?: number; clockMs?: () => number } = {}) {
    this.memoryTotalBytes = opts.memoryTotalBytes ?? DEFAULT_HOST_MEMORY_TOTAL_BYTES
    this.cpuCores = opts.cpuCores !== undefined && opts.cpuCores > 0 ? opts.cpuCores : 1
    this.clockMs = opts.clockMs ?? (() => performance.now())
  }

  getAccountSampleMeta(accountId: Id): AccountSampleRateMeta | undefined {
    return this.metaByAccount.get(accountId)
  }

  resetAccount(accountId?: Id): void {
    if (accountId !== undefined) {
      this.prevByAccount.delete(accountId)
      this.metaByAccount.delete(accountId)
    } else {
      this.prevByAccount.clear()
      this.metaByAccount.clear()
    }
  }

  /** Portable executor diagnostic; production reads use the daemon-owned cached resource pipeline. */
  async sample(
    accounts: readonly Account[],
    plansById: ReadonlyMap<Id, Plan>,
    executor: AgentExecutor,
    opts: {
      now?: Date
      monotonicNowMs?: number
      cpuCores?: number
      psiSomeAvg10?: number
      psiFullAvg10?: number
      awaitMs?: number
      loadAvg1m?: number
      onEvent?: (event: LiveEvent) => void
    } = {},
  ): Promise<IoAnalyticsSnapshot> {
    const now = opts.now ?? new Date()
    const monoMs =
      opts.monotonicNowMs !== undefined
        ? opts.monotonicNowMs
        : opts.now !== undefined
          ? opts.now.getTime()
          : this.clockMs()
    const at = now.toISOString()
    const effectiveCores = opts.cpuCores !== undefined && opts.cpuCores > 0 ? opts.cpuCores : this.cpuCores

    let totalReadBps = 0
    let totalWriteBps = 0
    let totalReadIops = 0
    let totalWriteIops = 0
    let totalCpuPercent = 0
    let totalMemoryBytes = 0

    const ranks: AccountIoRank[] = []

    for (const acc of accounts) {
      if (acc.status !== 'active') continue
      const rawMetrics = (await executor.readSliceMetrics(acc.uid)) as ExtendedSliceRuntimeMetrics | null
      if (!rawMetrics) continue

      const parsedIo =
        typeof rawMetrics.ioStatRaw === 'string' ? parseCgroupIoStat(rawMetrics.ioStatRaw) : null
      const parsedCpu =
        typeof rawMetrics.cpuStatRaw === 'string' ? parseCgroupCpuStat(rawMetrics.cpuStatRaw) : null

      const currReadBytes = Math.max(0, parsedIo ? parsedIo.rbytes : rawMetrics.ioReadBytes)
      const currWriteBytes = Math.max(0, parsedIo ? parsedIo.wbytes : rawMetrics.ioWriteBytes)
      const currCpuUsec = Math.max(0, parsedCpu ? parsedCpu.usageUsec : rawMetrics.cpuUsageUsec)

      const rawReadOps =
        parsedIo !== null
          ? parsedIo.rios
          : rawMetrics.ioReadOps !== undefined
            ? rawMetrics.ioReadOps
            : rawMetrics.rios !== undefined
              ? rawMetrics.rios
              : null
      const rawWriteOps =
        parsedIo !== null
          ? parsedIo.wios
          : rawMetrics.ioWriteOps !== undefined
            ? rawMetrics.ioWriteOps
            : rawMetrics.wios !== undefined
              ? rawMetrics.wios
              : null

      const currReadOps = rawReadOps !== null && Number.isFinite(rawReadOps) ? Math.max(0, rawReadOps) : null
      const currWriteOps = rawWriteOps !== null && Number.isFinite(rawWriteOps) ? Math.max(0, rawWriteOps) : null

      const prev = this.prevByAccount.get(acc.id)

      let readBytesPerSec = 0
      let writeBytesPerSec = 0
      let readIops = 0
      let writeIops = 0
      let cpuPercent = 0
      let rateAvailable = false
      let firstSample = false
      let counterReset = false
      let elapsedSec = 0

      if (!prev) {
        firstSample = true
      } else {
        const elapsedMs = monoMs - prev.monoMs
        const hasReset =
          currCpuUsec < prev.cpuUsageUsec ||
          currReadBytes < prev.ioReadBytes ||
          currWriteBytes < prev.ioWriteBytes ||
          (currReadOps !== null && prev.ioReadOps !== null && currReadOps < prev.ioReadOps) ||
          (currWriteOps !== null && prev.ioWriteOps !== null && currWriteOps < prev.ioWriteOps)

        if (hasReset) {
          counterReset = true
        } else if (elapsedMs > 0) {
          elapsedSec = elapsedMs / 1000
          rateAvailable = true
          readBytesPerSec = computeRate(currReadBytes, prev.ioReadBytes, elapsedSec)
          writeBytesPerSec = computeRate(currWriteBytes, prev.ioWriteBytes, elapsedSec)
          readIops =
            currReadOps !== null && prev.ioReadOps !== null
              ? computeRate(currReadOps, prev.ioReadOps, elapsedSec)
              : 0
          writeIops =
            currWriteOps !== null && prev.ioWriteOps !== null
              ? computeRate(currWriteOps, prev.ioWriteOps, elapsedSec)
              : 0

          const cpuDeltaUsec = currCpuUsec - prev.cpuUsageUsec
          const rawCpuPct = (cpuDeltaUsec / (elapsedSec * 1_000_000 * effectiveCores)) * (effectiveCores * 100)
          cpuPercent = Number(Math.min(800, Math.max(0, rawCpuPct)).toFixed(1))
        }
      }

      this.prevByAccount.set(acc.id, {
        monoMs,
        cpuUsageUsec: currCpuUsec,
        ioReadBytes: currReadBytes,
        ioWriteBytes: currWriteBytes,
        ioReadOps: currReadOps,
        ioWriteOps: currWriteOps,
      })

      this.metaByAccount.set(acc.id, {
        rateAvailable,
        firstSample,
        counterReset,
        elapsedSec,
      })

      totalReadBps += readBytesPerSec
      totalWriteBps += writeBytesPerSec
      totalReadIops += readIops
      totalWriteIops += writeIops
      totalCpuPercent = Number((totalCpuPercent + cpuPercent).toFixed(1))
      totalMemoryBytes += rawMetrics.memoryCurrentBytes

      const stored = plansById.get(acc.planId), plan = stored && effectivePlan(stored, acc)
      const readCap = plan ? plan.resources.ioReadBps : ('unlimited' as const)
      const writeCap = plan ? plan.resources.ioWriteBps : ('unlimited' as const)
      const readIopsCap = plan ? plan.resources.ioReadIops : ('unlimited' as const)
      const writeIopsCap = plan ? plan.resources.ioWriteIops : ('unlimited' as const)
      const memoryLimitMb = plan ? plan.resources.memoryMb : ('unlimited' as const)
      const pidsLimit = plan ? plan.resources.maxProcesses : ('unlimited' as const)

      let statusLevel: 'ok' | 'warn' | 'critical' = 'ok'
      const bumpSeverity = (s: 'ok' | 'warn' | 'critical') => {
        if (s === 'critical') statusLevel = 'critical'
        else if (s === 'warn' && statusLevel === 'ok') statusLevel = 'warn'
      }

      if (!isUnlimited(readCap) && readCap > 0) {
        const effectiveReadForStatus =
          !rateAvailable && firstSample && opts.monotonicNowMs === undefined && opts.now === undefined && parsedIo === null
            ? currReadBytes / 60
            : readBytesPerSec
        bumpSeverity(usageSeverity((effectiveReadForStatus / readCap) * 100))
      }
      if (!isUnlimited(writeCap) && writeCap > 0) {
        bumpSeverity(usageSeverity((writeBytesPerSec / writeCap) * 100))
      }
      if (!isUnlimited(readIopsCap) && readIopsCap > 0) {
        bumpSeverity(usageSeverity((readIops / readIopsCap) * 100))
      }
      if (!isUnlimited(writeIopsCap) && writeIopsCap > 0) {
        bumpSeverity(usageSeverity((writeIops / writeIopsCap) * 100))
      }

      ranks.push({
        accountId: acc.id,
        username: acc.username,
        uid: acc.uid,
        readBytesPerSec,
        writeBytesPerSec,
        readIops,
        writeIops,
        memoryCurrentBytes: rawMetrics.memoryCurrentBytes,
        memoryLimitMb,
        pidsCurrent: rawMetrics.pidsCurrent,
        pidsLimit,
        cpuPercent,
        statusLevel,
      })
    }

    ranks.sort((a, b) => b.readBytesPerSec + b.writeBytesPerSec - (a.readBytesPerSec + a.writeBytesPerSec))

    const currentPoint: IoAnalyticsPoint = {
      at,
      readBytesPerSec: totalReadBps,
      writeBytesPerSec: totalWriteBps,
      readIops: totalReadIops,
      writeIops: totalWriteIops,
      awaitMs: opts.awaitMs ?? 0,
      psiSomeAvg10: opts.psiSomeAvg10 ?? 0,
      psiFullAvg10: opts.psiFullAvg10 ?? 0,
      cpuPercent: totalCpuPercent,
      memoryUsedBytes: totalMemoryBytes,
      memoryTotalBytes: this.memoryTotalBytes,
      loadAvg1m: opts.loadAvg1m ?? 0,
    }

    this.history.push(currentPoint)
    if (this.history.length > MAX_IO_HISTORY_POINTS) {
      this.history.shift()
    }

    const snapshot: IoAnalyticsSnapshot = {
      at,
      current: currentPoint,
      history: [...this.history],
      accounts: ranks,
    }

    if (opts.onEvent) {
      opts.onEvent({
        id: randomUUID(),
        at,
        kind: 'io.analytics',
        scope: { accountId: null, resellerId: null },
        data: snapshot,
      })
    }

    return snapshot
  }

  latestSnapshot(): IoAnalyticsSnapshot | null {
    const current = this.history[this.history.length - 1]
    if (!current) return null
    return {
      at: current.at,
      current,
      history: [...this.history],
      accounts: [],
    }
  }
}

/** One daemon-owned kernel sampler. Requests read its cache and cannot choose UIDs or paths. */
export class CanonicalIoResourcePipeline {
  private sampler: LinuxResourceObservationSampler | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private refreshing: Promise<void> | undefined
  private stopping: Promise<void> | undefined
  private running = false
  private manuallyPaused = false
  private state: 'stopped' | 'active' | 'paused' | 'invalid' = 'stopped'
  private lastPublished: string | undefined
  private readonly options: { store: StateStore; engine: IoAnalyticsEngine; onEvent?: (event: LiveEvent) => void }

  constructor(options: { store: StateStore; engine: IoAnalyticsEngine; onEvent?: (event: LiveEvent) => void }) { this.options = options }

  async start(): Promise<void> {
    if (this.running || this.stopping) fail('PRECONDITION_FAILED', 'the canonical resource pipeline is already active or stopping')
    this.running = true
    await this.refresh()
    this.timer = setInterval(() => { void this.refresh() }, RESOURCE_SAMPLE_INTERVAL_MS)
    this.timer.unref?.()
  }

  private configuration(snapshot: StateSnapshot) {
    return { revision: snapshot.checksum, accounts: snapshot.accounts.filter(account => account.status === 'active')
      .map(account => ({ accountId: account.id, uid: account.uid })) }
  }

  private refresh(): Promise<void> {
    if (!this.running || this.manuallyPaused) return Promise.resolve()
    return this.refreshing ??= this.refreshOnce().catch(async () => {
      this.state = 'invalid'
      await this.sampler?.stop().catch(() => undefined)
    }).finally(() => { this.refreshing = undefined })
  }

  private async refreshOnce(): Promise<void> {
    const barrier = await readLifecyclePublicStatus()
    if (!this.running) return
    if (barrier.active) {
      this.state = 'paused'
      await this.sampler?.stop()
      return
    }
    const snapshot = await this.options.store.readSnapshot()
    if (!this.running || this.manuallyPaused) return
    if (!this.sampler) this.sampler = new LinuxResourceObservationSampler(this.configuration(snapshot))
    else this.sampler.setConfiguration(this.configuration(snapshot))
    if (this.state !== 'active') this.sampler.start()
    this.state = 'active'
    const reading = this.sampler.readLatest()
    const result = this.options.engine.readResourceObservation(reading, snapshot)
    if (result.available && reading.observation) {
      const identity = reading.observation.snapshot.producer.epoch + ':' + reading.observation.snapshot.producer.sequence
      if (identity !== this.lastPublished) {
        this.lastPublished = identity
        this.options.onEvent?.({ id: randomUUID(), at: result.snapshot.at, kind: 'io.analytics',
          scope: { accountId: null, resellerId: null }, data: result.snapshot })
      }
    }
  }

  async read(snapshot: StateSnapshot): Promise<CanonicalIoAnalyticsRead> {
    const latest = await this.latest()
    return 'unavailable' in latest ? latest.unavailable : this.options.engine.readResourceObservation(latest.reading, snapshot)
  }

  /** Per-account view of the same cached reading; it never triggers kernel reads. */
  async readAccounts(snapshot: StateSnapshot): Promise<IoAccountsView> {
    const latest = await this.latest()
    if ('unavailable' in latest) return { state: 'unavailable', reason: latest.unavailable.reason, observedAt: null, host: null, accounts: [], unmeasuredAccounts: 0 }
    return this.options.engine.readResourceAccounts(latest.reading, snapshot)
  }

  private async latest(): Promise<{ unavailable: CanonicalIoAnalyticsUnavailable } | { reading: ResourceSamplerReading }> {
    try {
      if ((await readLifecyclePublicStatus()).active) {
        this.state = 'paused'
        void this.sampler?.stop().catch(() => { this.state = 'invalid' })
        return { unavailable: unavailableIoAnalytics('paused') }
      }
    } catch {
      this.state = 'invalid'
      void this.sampler?.stop().catch(() => undefined)
      return { unavailable: unavailableIoAnalytics('invalid') }
    }
    if (!this.running || this.manuallyPaused || this.state === 'paused') return { unavailable: unavailableIoAnalytics(this.manuallyPaused || this.state === 'paused' ? 'paused' : 'not-sampled') }
    if (this.state !== 'active' || !this.sampler) return { unavailable: unavailableIoAnalytics('invalid') }
    return { reading: this.sampler.readLatest() }
  }

  async pause(): Promise<void> {
    this.manuallyPaused = true
    this.state = 'paused'
    await this.refreshing
    await this.sampler?.stop()
  }

  async resume(): Promise<void> {
    if (!this.running || this.stopping) fail('PRECONDITION_FAILED', 'the canonical resource pipeline is stopped')
    this.manuallyPaused = false
    await this.refresh()
  }

  stop(): Promise<void> {
    this.running = false
    this.state = 'stopped'
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    return this.stopping ??= (async () => {
      await this.refreshing
      await this.sampler?.stop()
    })()
  }
}

/** One site's newly consumed complete access-log lines, as the bandwidth meter read them. */
export interface SiteLogChunk {
  path: string
  accountId: Id
  /** Each served name, exact or `*.name`, to the domain it belongs to (edge.groupSites owners). */
  owners: ReadonlyMap<string, Pick<Domain, 'id'>>
  identity: string
  start: number
  sizeBytes: number
  bytes: Buffer
  /** The collection instant. */
  readAt: string
  /** From this instant every line of the site reaches the reader, except the meter's rotation shortcut. */
  since: string
  /** The read reached the end of the file; at most a line still being written remains. */
  caughtUp: boolean
}

/** What the bandwidth meter drives: loaded before its first read, fed each site read, saved before each ledger write. */
export interface WebsiteAnalyticsFeed {
  load(): Promise<void>
  ingestSiteLog(chunk: SiteLogChunk): number
  save(at: Date): Promise<void>
}

/** The private aggregate store; read returns null when there is none. */
export interface WebsiteAnalyticsStore {
  read(): Promise<unknown>
  write(data: unknown): Promise<void>
}

export const WEBSITE_ANALYTICS_PATH = '/var/lib/xpanel/website-analytics.json'
/** Hard bound of the store file; the oldest buckets are dropped first. */
export const WEBSITE_ANALYTICS_MAX_BYTES = 8 * 1024 * 1024
/** A domain whose site log was last read longer ago than three bandwidth collections is stale. */
export const WEBSITE_ANALYTICS_STALE_MS = 3 * BANDWIDTH_INTERVAL_MS

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000
/** Hour buckets serve the 1h and 24h windows, day buckets the 7d and 30d windows. */
const HOURS_KEPT = 26
const DAYS_KEPT = 31
const WINDOW_MS = { '1h': HOUR_MS, '24h': 24 * HOUR_MS, '7d': 7 * DAY_MS, '30d': 30 * DAY_MS } as const
/** Top rows a finished bucket keeps, and the distinct keys a bucket still being filled tracks. */
const TOP_KEPT = 10
const TOP_LIVE = 100
/** Request-time histogram: bin i holds (1.25^(i-1), 1.25^i] ms, the last bin everything above. */
const RT_GROWTH = 1.25
const RT_BINS = 54
/** requests, bytes, 1xx unused, then 2xx..5xx at their class index, cache hit/miss/bypass, request ms sum, upstream ms sum, request ms max. */
const N_REQUESTS = 0, N_BYTES = 1, N_HIT = 6, N_MISS = 7, N_BYPASS = 8, N_RT_SUM = 9, N_URT_SUM = 10, N_RT_MAX = 11, N_RT_BIN = 12
const SLOTS = N_RT_BIN + RT_BINS
/** HyperLogLog registers for unique visitors: about 6.5% standard error, small counts near exact; no address is stored. */
const VISITOR_REGISTERS = 256
const LOG_LINE_MAX_CHARS = 16 * 1024

type TopRow = [requests: number, bytes: number, errors5xx: number]
interface Bucket { start: number; n: Float64Array; visitors: Uint8Array; top: [paths: Map<string, TopRow>, referrers: Map<string, TopRow>, clients: Map<string, TopRow>] }
/** Per domain: since when every line is held, the last read that reached the end of its site log, and its buckets. */
interface DomainState { accountId: Id; sinceMs: number; throughMs: number | null; hours: Map<number, Bucket>; days: Map<number, Bucket> }
/** Per log path: the file identity and end offset already counted, and whether that read reached the end of the file. */
interface FedMark { identity: string; end: number; complete: boolean; at: number }

const logText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max
const logCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const logSeconds = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/** One line of the edge's `log_format xpanel_metrics escape=json` (packages/render/src/edge/nginx.ts); null when malformed. */
export function parseMetricsLogLine(line: string): NginxMetricLogLine | null {
  let value: unknown
  try { value = line.length <= LOG_LINE_MAX_CHARS ? JSON.parse(line) : null } catch { return null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (!logText(v.time, 64) || !/^\d{4}-\d{2}-\d{2}T/.test(v.time) || !Number.isFinite(Date.parse(v.time)) || !logText(v.host, 255) || !v.host || !logText(v.ip, 64) || !logText(v.method, 32)
    || !logText(v.uri, LOG_LINE_MAX_CHARS) || !logCount(v.status) || v.status < 100 || v.status > 599 || !logCount(v.body_bytes) || !logCount(v.bytes) || !logCount(v.request_bytes) || !logSeconds(v.request_time)
    || !logText(v.upstream_time, 256) || !logText(v.cache, 32) || !logText(v.referer, LOG_LINE_MAX_CHARS) || !logText(v.agent, LOG_LINE_MAX_CHARS)) return null
  return { time: v.time, host: v.host.toLowerCase(), ip: v.ip, method: v.method, uri: v.uri, status: v.status, body_bytes: v.body_bytes, bytes: v.bytes, request_bytes: v.request_bytes,
    request_time: v.request_time, upstream_time: v.upstream_time, cache: v.cache, referer: v.referer, agent: v.agent }
}

/** `$upstream_response_time` lists one value per upstream tried ("0.010, 0.020 : 0.003"); `-` adds nothing. */
const upstreamMs = (value: string): number => value.split(/[,:]/).reduce((total, part) => { const n = Number(part.trim()); return Number.isFinite(n) && n >= 0 ? total + n * 1000 : total }, 0)

/** nginx picks the exact name first, then the longest `*.suffix` wildcard. */
const ownerOf = (owners: SiteLogChunk['owners'], host: string): Pick<Domain, 'id'> | undefined => {
  let owner = owners.get(host)
  for (let dot = host.indexOf('.'); !owner && dot >= 0; dot = host.indexOf('.', dot + 1)) owner = owners.get('*' + host.slice(dot))
  return owner
}

const normalizeReferrer = (ref: string): string => {
  if (!ref || ref === '-' || ref.trim() === '') return 'Direct'
  try {
    const u = new URL(ref)
    return u.hostname.toLowerCase() || 'Direct'
  } catch {
    return ref.slice(0, 64)
  }
}

/** FNV-1a with the murmur3 finalizer: an even 32-bit spread for the visitor registers. */
const hash32 = (text: string): number => {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

const visitorEstimate = (registers: Uint8Array): number => {
  let sum = 0, zeros = 0
  for (const rank of registers) { sum += 2 ** -rank; if (rank === 0) zeros++ }
  const m = registers.length, raw = 0.7213 / (1 + 1.079 / m) * m * m / sum
  return Math.round(raw <= 2.5 * m && zeros > 0 ? m * Math.log(m / zeros) : raw)
}

const round2 = (value: number): number => Number(value.toFixed(2))

/** Interpolated within the histogram bin, never above the slowest request. */
const percentile95 = (n: Float64Array): number => {
  const total = n[N_REQUESTS]!
  if (total === 0) return 0
  const rank = Math.floor(total * 0.95)
  let seen = 0
  for (let bin = 0; bin < RT_BINS; bin++) {
    const inBin = n[N_RT_BIN + bin]!
    if (seen + inBin > rank) {
      const low = bin === 0 ? 0 : RT_GROWTH ** (bin - 1), high = RT_GROWTH ** bin
      return round2(Math.min(n[N_RT_MAX]!, low + (high - low) * (rank - seen + 1) / inBin))
    }
    seen += inBin
  }
  return round2(n[N_RT_MAX]!)
}

const rankTop = (counts: Map<string, TopRow>, limit = TOP_KEPT): WebsiteTopEntry[] =>
  [...counts.entries()]
    .sort((a, b) => b[1][0] - a[1][0] || b[1][1] - a[1][1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([key, [requests, bytes, errors5xx]]) => ({ key, requests, bytes, ...(errors5xx > 0 && { errors5xx }) }))

const newBucket = (start: number): Bucket => ({ start, n: new Float64Array(SLOTS), visitors: new Uint8Array(VISITOR_REGISTERS), top: [new Map(), new Map(), new Map()] })

const bucketAt = (buckets: Map<number, Bucket>, start: number): Bucket => {
  let bucket = buckets.get(start)
  if (!bucket) buckets.set(start, bucket = newBucket(start))
  return bucket
}

/** Merges counts into target; a finished bucket's top rows are lower bounds for keys outside its kept rows. */
const mergeInto = (target: Bucket, source: Bucket): void => {
  for (let slot = 0; slot < SLOTS; slot++) target.n[slot] = slot === N_RT_MAX ? Math.max(target.n[slot]!, source.n[slot]!) : target.n[slot]! + source.n[slot]!
  for (let register = 0; register < VISITOR_REGISTERS; register++) target.visitors[register] = Math.max(target.visitors[register]!, source.visitors[register]!)
  source.top.forEach((rows, list) => {
    const into = target.top[list as 0 | 1 | 2]
    for (const [key, [requests, bytes, errors]] of rows) {
      const row = into.get(key)
      if (row) { row[0] += requests; row[1] += bytes; row[2] += errors } else into.set(key, [requests, bytes, errors])
    }
  })
}

const countLine = (bucket: Bucket, slots: readonly number[], bytes: number, rtMs: number, urtMs: number, register: number, rank: number, keys: readonly string[], error: number): void => {
  const n = bucket.n
  for (const slot of slots) n[slot] = n[slot]! + 1
  n[N_BYTES] = n[N_BYTES]! + bytes
  n[N_RT_SUM] = n[N_RT_SUM]! + rtMs
  n[N_URT_SUM] = n[N_URT_SUM]! + urtMs
  n[N_RT_MAX] = Math.max(n[N_RT_MAX]!, rtMs)
  bucket.visitors[register] = Math.max(bucket.visitors[register]!, rank)
  keys.forEach((key, list) => {
    const rows = bucket.top[list as 0 | 1 | 2], row = rows.get(key)
    if (row) { row[0]++; row[1] += bytes; row[2] += error } else if (rows.size < TOP_LIVE) rows.set(key, [1, bytes, error])
  })
}

const trimTop = (bucket: Bucket): void => {
  for (const rows of bucket.top) {
    if (rows.size <= TOP_KEPT) continue
    const kept = new Set(rankTop(rows).map(entry => entry.key))
    for (const key of rows.keys()) if (!kept.has(key)) rows.delete(key)
  }
}

const encodeBucket = (bucket: Bucket): string => {
  const slots: number[] = []
  bucket.n.forEach((value, slot) => { if (value !== 0) slots.push(slot, value) })
  const set = bucket.visitors.reduce((total, rank) => total + (rank > 0 ? 1 : 0), 0)
  const sparse: number[] = []
  if (set < VISITOR_REGISTERS / 2) bucket.visitors.forEach((rank, register) => { if (rank > 0) sparse.push(register, rank) })
  const visitors = Buffer.from(set < VISITOR_REGISTERS / 2 ? Uint8Array.from(sparse) : bucket.visitors).toString('base64')
  return JSON.stringify([bucket.start, slots, visitors, ...bucket.top.map(rows => rankTop(rows).map(entry => [entry.key, entry.requests, entry.bytes, entry.errors5xx ?? 0]))])
}

const decodeBucket = (text: unknown, unit: number): Bucket | null => {
  if (typeof text !== 'string' || text.length > 64 * 1024) return null
  let value: unknown
  try { value = JSON.parse(text) } catch { return null }
  if (!Array.isArray(value) || value.length !== 6) return null
  const [start, slots, visitors, ...lists] = value as unknown[]
  if (!Number.isSafeInteger(start) || (start as number) % unit !== 0 || !Array.isArray(slots) || slots.length % 2 !== 0 || slots.length > 2 * SLOTS || typeof visitors !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(visitors)) return null
  const bucket = newBucket(start as number)
  for (let i = 0; i < slots.length; i += 2) {
    const slot = slots[i], count = slots[i + 1]
    if (!Number.isInteger(slot) || slot < 0 || slot >= SLOTS || typeof count !== 'number' || !Number.isFinite(count) || count < 0) return null
    bucket.n[slot] = count
  }
  const registers = Buffer.from(visitors, 'base64')
  if (registers.length === VISITOR_REGISTERS) bucket.visitors.set(registers)
  else if (registers.length % 2 === 0 && registers.length < VISITOR_REGISTERS) for (let i = 0; i < registers.length; i += 2) bucket.visitors[registers[i]!] = registers[i + 1]!
  else return null
  if (bucket.visitors.some(rank => rank > 25)) return null
  for (const [list, rows] of lists.entries()) {
    if (!Array.isArray(rows) || rows.length > TOP_KEPT) return null
    for (const row of rows as unknown[]) {
      if (!Array.isArray(row) || row.length !== 4 || typeof row[0] !== 'string' || !row[0] || row[0].length > 256 || !logCount(row[1]) || !logCount(row[2]) || !logCount(row[3])) return null
      bucket.top[list]!.set(row[0], [row[1], row[2], row[3]])
    }
  }
  return bucket
}

/** Accepts only a well-formed store; anything else is discarded and the windows are read again. */
const parseStore = (raw: unknown): { marks: Map<string, FedMark>; domains: Map<Id, DomainState> } | null => {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  const instant = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0
  if (!object(raw) || !object(raw.marks) || !object(raw.domains)) return null
  const marks = new Map<string, FedMark>(), domains = new Map<Id, DomainState>()
  for (const [path, mark] of Object.entries(raw.marks)) {
    if (path.length > 512 || !object(mark) || !logText(mark.identity, 64) || !logCount(mark.end) || typeof mark.complete !== 'boolean' || !instant(mark.at)) return null
    marks.set(path, { identity: mark.identity, end: mark.end, complete: mark.complete, at: mark.at })
  }
  for (const [id, state] of Object.entries(raw.domains)) {
    if (id.length > 64 || !object(state) || !logText(state.accountId, 64) || !instant(state.since) || state.through !== null && !instant(state.through) || !Array.isArray(state.hours) || !Array.isArray(state.days)) return null
    const hours = state.hours.map(text => decodeBucket(text, HOUR_MS)), days = state.days.map(text => decodeBucket(text, DAY_MS))
    if (hours.includes(null) || days.includes(null) || hours.length > HOURS_KEPT || days.length > DAYS_KEPT) return null
    domains.set(id, { accountId: state.accountId, sinceMs: state.since, throughMs: state.through as number | null,
      hours: new Map(hours.map(bucket => [bucket!.start, bucket!])), days: new Map(days.map(bucket => [bucket!.start, bucket!])) })
  }
  return { marks, domains }
}

/** Reads the store file; a missing file is null, an oversized one is refused so the engine discards it. */
export const readWebsiteAnalyticsStore = async (path = WEBSITE_ANALYTICS_PATH): Promise<unknown> => {
  let info
  try { info = await stat(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  if (!info.isFile() || info.size > WEBSITE_ANALYTICS_MAX_BYTES) return fail('PRECONDITION_FAILED', 'the website analytics store is not a bounded regular file', { stateChanged: false })
  return JSON.parse(await readFile(path, 'utf8'))
}

const unavailableWebsite = (reason: 'not-read' | 'stale' | 'window-not-covered'): never =>
  fail('SERVICE_UNAVAILABLE', 'website analytics are unavailable for this window', { reason, stateChanged: false })

/**
 * Per-domain website analytics from the edge's `xpanel_metrics` site access logs, fed by the bandwidth meter's incremental reads.
 * Lines are counted into hour and day buckets (traffic, status, cache, latency histogram, visitor registers, top rows), persisted
 * once per collection, so an agent restart keeps every window it had read. A window is served only when all of it was read.
 */
export class WebsiteAnalyticsEngine implements WebsiteAnalyticsFeed {
  private marks = new Map<string, FedMark>()
  private domains = new Map<Id, DomainState>()
  private readonly store: WebsiteAnalyticsStore | undefined
  private readonly maxBytes: number
  private readonly loaded: Promise<void>

  constructor(opts: { store?: WebsiteAnalyticsStore; maxBytes?: number } = {}) {
    this.store = opts.store
    this.maxBytes = opts.maxBytes ?? WEBSITE_ANALYTICS_MAX_BYTES
    // An unreadable or malformed store is discarded: windows refuse until they are read again, and the next save replaces it.
    this.loaded = (async () => {
      const parsed = parseStore(await this.store?.read().catch(() => null) ?? null)
      if (parsed) { this.marks = parsed.marks; this.domains = parsed.domains }
    })().catch(() => undefined)
  }

  load(): Promise<void> {
    return this.loaded
  }

  /** Adds one site's newly read lines; a line counts for the domain that serves its host name. Returns the lines added. */
  ingestSiteLog(chunk: SiteLogChunk): number {
    const readAtMs = Date.parse(chunk.readAt), mark = this.marks.get(chunk.path), readEnd = chunk.start + chunk.bytes.length
    const sameFile = mark !== undefined && mark.identity === chunk.identity && chunk.sizeBytes >= mark.end
    // Lines between the counted end and this read were lost (a save that failed before a restart); a new or truncated file
    // continues the history only after a recent complete read of the old one, as the meter's rotation shortcut assumes.
    const continuous = mark !== undefined && (sameFile ? chunk.start <= mark.end : mark.complete && readAtMs - mark.at <= WEBSITE_ANALYTICS_STALE_MS)
    const skip = sameFile ? Math.min(chunk.bytes.length, Math.max(0, mark.end - chunk.start)) : 0
    this.marks.set(chunk.path, { identity: chunk.identity, end: sameFile ? Math.max(mark.end, readEnd) : readEnd, complete: chunk.caughtUp, at: readAtMs })
    const restartAt = mark !== undefined && !sameFile ? readAtMs : Date.parse(chunk.since)
    for (const { id } of new Set(chunk.owners.values())) {
      const known = this.domains.get(id), owned = known !== undefined && known.accountId === chunk.accountId ? known : undefined
      // A new owner starts empty; the same owner keeps its counted buckets even when its complete history restarts.
      const state: DomainState = owned && continuous ? owned
        : { accountId: chunk.accountId, sinceMs: restartAt, throughMs: null, hours: owned?.hours ?? new Map(), days: owned?.days ?? new Map() }
      if (chunk.caughtUp) state.throughMs = readAtMs
      this.domains.set(id, state)
    }
    const hourCutoff = readAtMs - readAtMs % HOUR_MS - (HOURS_KEPT - 1) * HOUR_MS, dayCutoff = readAtMs - readAtMs % DAY_MS - (DAYS_KEPT - 1) * DAY_MS
    let added = 0
    for (const line of chunk.bytes.subarray(skip).toString('utf8').split('\n')) {
      const entry = line ? parseMetricsLogLine(line) : null
      const owner = entry ? ownerOf(chunk.owners, entry.host) : undefined
      const state = owner ? this.domains.get(owner.id) : undefined
      const at = entry ? Date.parse(entry.time) : NaN
      if (!entry || !state || at < dayCutoff) continue
      const rtMs = entry.request_time * 1000, cache = entry.cache.toUpperCase(), error = entry.status >= 500 ? 1 : 0
      const slot = cache === 'HIT' || cache === 'STALE' || cache === 'REVALIDATED' ? N_HIT : cache === 'BYPASS' ? N_BYPASS : N_MISS
      const bin = rtMs <= 1 ? 0 : Math.min(RT_BINS - 1, Math.ceil(Math.log(rtMs) / Math.log(RT_GROWTH)))
      const hash = hash32(entry.ip), register = hash >>> 24, rank = Math.min(25, Math.clz32(hash << 8) + 1)
      const keys = [(entry.uri.split('?')[0] || '/').slice(0, 256), normalizeReferrer(entry.referer), entry.ip.slice(0, 64)]
      const statusClass = Math.floor(entry.status / 100), slots = statusClass >= 2 ? [N_REQUESTS, slot, N_RT_BIN + bin, statusClass] : [N_REQUESTS, slot, N_RT_BIN + bin]
      const buckets = at >= hourCutoff ? [bucketAt(state.hours, at - at % HOUR_MS), bucketAt(state.days, at - at % DAY_MS)] : [bucketAt(state.days, at - at % DAY_MS)]
      for (const bucket of buckets) countLine(bucket, slots, entry.bytes, rtMs, upstreamMs(entry.upstream_time), register, rank, keys, error)
      added++
    }
    return added
  }

  /** Prunes by retention and the size bound, then writes the store; a failed write is retried by the next collection. */
  async save(at: Date): Promise<void> {
    await this.loaded
    const atMs = at.getTime(), hourCutoff = atMs - atMs % HOUR_MS - (HOURS_KEPT - 1) * HOUR_MS, dayCutoff = atMs - atMs % DAY_MS - (DAYS_KEPT - 1) * DAY_MS
    const encoded: { state: DomainState; buckets: Map<number, Bucket>; start: number; end: number; text: string; bytes: number }[] = []
    let total = 1024
    for (const [path, mark] of this.marks) if (mark.at < dayCutoff) this.marks.delete(path); else total += 256 + Buffer.byteLength(path)
    for (const [id, state] of this.domains) {
      for (const [buckets, cutoff, unit] of [[state.hours, hourCutoff, HOUR_MS], [state.days, dayCutoff, DAY_MS]] as const) {
        for (const bucket of buckets.values()) {
          if (bucket.start < cutoff) { buckets.delete(bucket.start); continue }
          if (bucket.start + unit <= atMs - atMs % unit) trimTop(bucket)
          const text = encodeBucket(bucket), bytes = Buffer.byteLength(JSON.stringify(text)) + 24
          encoded.push({ state, buckets, start: bucket.start, end: bucket.start + unit, text, bytes })
          total += bytes
        }
      }
      if (!state.hours.size && !state.days.size && (state.throughMs ?? 0) < dayCutoff) this.domains.delete(id); else total += 256
    }
    // Over the bound, the oldest buckets go first and the domain's complete history then starts after them.
    encoded.sort((a, b) => a.end - b.end)
    for (const dropped of encoded) {
      if (total <= this.maxBytes) break
      dropped.buckets.delete(dropped.start)
      dropped.state.sinceMs = Math.max(dropped.state.sinceMs, dropped.end)
      dropped.text = ''
      total -= dropped.bytes
    }
    if (!this.store) return
    const texts = new Map<Bucket, string>()
    for (const item of encoded) if (item.text) texts.set(item.buckets.get(item.start)!, item.text)
    const domains = Object.fromEntries([...this.domains].map(([id, state]) => [id, { accountId: state.accountId, since: state.sinceMs, through: state.throughMs,
      hours: [...state.hours.values()].map(bucket => texts.get(bucket)!), days: [...state.days.values()].map(bucket => texts.get(bucket)!) }]))
    try { await this.store.write({ marks: Object.fromEntries(this.marks), domains }) } catch { /* A restart before the next save shows the unsaved lines as a gap. */ }
  }

  /** Complete hours (1h, 24h) or complete UTC days (7d, 30d) before the domain's last complete read; refuses when any of it was not read. */
  queryDomainSnapshot(
    domain: Domain,
    opts: {
      window?: '1h' | '24h' | '7d' | '30d'
      now?: Date
      onEvent?: (event: LiveEvent) => void
      resellerId?: Id | null
    } = {},
  ): WebsiteAnalyticsSnapshot {
    const window = opts.window ?? '24h'
    const now = opts.now ?? new Date()
    const state = this.domains.get(domain.id)
    if (!state || state.accountId !== domain.accountId || state.throughMs === null) return unavailableWebsite('not-read')
    if (now.getTime() - state.throughMs > WEBSITE_ANALYTICS_STALE_MS) return unavailableWebsite('stale')
    const daily = window === '7d' || window === '30d', unit = daily ? DAY_MS : HOUR_MS
    const endMs = state.throughMs - state.throughMs % unit, startMs = endMs - WINDOW_MS[window]
    if (state.sinceMs > startMs) return unavailableWebsite('window-not-covered')
    const buckets = [...(daily ? state.days : state.hours).values()].filter(bucket => bucket.start >= startMs && bucket.start < endMs).sort((a, b) => a.start - b.start)
    const total = newBucket(startMs)
    for (const bucket of buckets) mergeInto(total, bucket)
    const n = total.n, requests = n[N_REQUESTS]!
    const series: WebsiteTrafficBucket[] = buckets.map(bucket => {
      const b = bucket.n, count = b[N_REQUESTS]!
      return { at: new Date(bucket.start).toISOString(), requests: count, bytes: b[N_BYTES]!, status2xx: b[2]!, status3xx: b[3]!, status4xx: b[4]!, status5xx: b[5]!,
        cacheHit: b[N_HIT]!, cacheMiss: b[N_MISS]!, cacheBypass: b[N_BYPASS]!, avgRequestTimeMs: count > 0 ? round2(b[N_RT_SUM]! / count) : 0,
        p95RequestTimeMs: percentile95(b), avgUpstreamTimeMs: count > 0 ? round2(b[N_URT_SUM]! / count) : 0 }
    })
    const atIso = new Date(endMs).toISOString()
    const snapshot: WebsiteAnalyticsSnapshot = {
      domain: domain.name,
      accountId: domain.accountId,
      at: atIso,
      totals: {
        requests,
        bytes: n[N_BYTES]!,
        uniqueVisitors: visitorEstimate(total.visitors),
        cacheHitRatioPercent: requests > 0 ? Number((n[N_HIT]! / requests * 100).toFixed(1)) : 0,
        errorRatePercent: requests > 0 ? Number((n[5]! / requests * 100).toFixed(2)) : 0,
        avgRequestTimeMs: requests > 0 ? round2(n[N_RT_SUM]! / requests) : 0,
        p95RequestTimeMs: percentile95(n),
        avgUpstreamTimeMs: requests > 0 ? round2(n[N_URT_SUM]! / requests) : 0,
        status2xx: n[2]!,
        status3xx: n[3]!,
        status4xx: n[4]!,
        status5xx: n[5]!,
      },
      series,
      topPaths: rankTop(total.top[0]),
      topReferrers: rankTop(total.top[1]),
      topClientIps: rankTop(total.top[2]),
    }

    if (opts.onEvent) {
      opts.onEvent({
        id: randomUUID(),
        at: atIso,
        kind: 'website.analytics',
        scope: { accountId: domain.accountId, resellerId: opts.resellerId ?? null },
        data: snapshot,
      })
    }

    return snapshot
  }
}
