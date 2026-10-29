import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { assertResourceConfigurationBinding, fail, isUnlimited, parseResourceObservationSnapshot, RESOURCE_SAMPLE_INTERVAL_MS } from '@xpanel/core'
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

export interface NginxMetricLogLine {
  ts: string
  host: string
  ip: string
  method: string
  uri: string
  status: number
  bytes: number
  rt: number
  uct?: string | number
  uht?: string | number
  urt?: string | number
  cache?: string
  ref?: string
  ua?: string
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
      const sample = byId.get(account.id), plan = plans.get(account.planId)
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

      const plan = plansById.get(acc.planId)
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

interface StoredAccessRecord {
  tsMs: number
  tsHourIso: string
  host: string
  ip: string
  uri: string
  status: number
  bytes: number
  rtMs: number
  urtMs: number
  cacheKind: 'hit' | 'miss' | 'bypass'
  referrer: string
}

const parseSecToMs = (v: unknown): number => {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, v * 1000)
  if (typeof v === 'string') {
    const n = Number.parseFloat(v)
    if (Number.isFinite(n)) return Math.max(0, n * 1000)
  }
  return 0
}

const normalizeReferrer = (ref: string | undefined): string => {
  if (!ref || ref === '-' || ref.trim() === '') return 'Direct'
  try {
    const u = new URL(ref)
    return u.hostname.toLowerCase() || 'Direct'
  } catch {
    return ref.slice(0, 64)
  }
}

const percentile95 = (sortedAsc: readonly number[]): number => {
  if (sortedAsc.length === 0) return 0
  const idx = Math.min(sortedAsc.length - 1, Math.floor(sortedAsc.length * 0.95))
  return Number((sortedAsc[idx] ?? 0).toFixed(2))
}

const rankTop = (counts: Map<string, { requests: number; bytes: number; errors5xx: number }>, limit = 10): WebsiteTopEntry[] =>
  [...counts.entries()]
    .sort((a, b) => b[1].requests - a[1].requests || b[1].bytes - a[1].bytes)
    .slice(0, limit)
    .map(([key, v]) => ({
      key,
      requests: v.requests,
      bytes: v.bytes,
      ...(v.errors5xx > 0 && { errors5xx: v.errors5xx }),
    }))

/**
 * Incremental Nginx `xpanel_metrics` JSON access-log analytics engine.
 * Parses structured access log lines and builds real-time traffic, latency, cache hit ratio,
 * status breakdown, and top paths/referrers/IPs snapshots per domain or account.
 */
export class WebsiteAnalyticsEngine {
  private readonly records: StoredAccessRecord[] = []
  private readonly maxRecords: number

  constructor(opts: { maxRecords?: number } = {}) {
    this.maxRecords = opts.maxRecords ?? 50_000
  }

  ingestJsonLogLines(lines: readonly string[] | string): number {
    const rawLines = typeof lines === 'string' ? lines.split(/\r?\n/) : lines
    let ingested = 0
    for (const line of rawLines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('{')) continue
      try {
        const parsed = JSON.parse(trimmed) as Partial<NginxMetricLogLine>
        if (typeof parsed.host !== 'string' || typeof parsed.status !== 'number') continue
        const d = parsed.ts ? new Date(parsed.ts) : new Date()
        const tsMs = Number.isNaN(d.getTime()) ? Date.now() : d.getTime()
        const hourDate = new Date(tsMs)
        hourDate.setUTCMinutes(0, 0, 0)
        const rawUri = typeof parsed.uri === 'string' ? parsed.uri : '/'
        const cleanPath = (rawUri.split('?')[0] || '/').slice(0, 256)
        const cacheStr = typeof parsed.cache === 'string' ? parsed.cache.toUpperCase() : ''
        const cacheKind: 'hit' | 'miss' | 'bypass' =
          cacheStr === 'HIT' || cacheStr === 'STALE' || cacheStr === 'REVALIDATED'
            ? 'hit'
            : cacheStr === 'BYPASS'
              ? 'bypass'
              : 'miss'

        this.records.push({
          tsMs,
          tsHourIso: hourDate.toISOString(),
          host: parsed.host.toLowerCase(),
          ip: typeof parsed.ip === 'string' ? parsed.ip : '0.0.0.0',
          uri: cleanPath,
          status: parsed.status,
          bytes: typeof parsed.bytes === 'number' && parsed.bytes > 0 ? parsed.bytes : 0,
          rtMs: parseSecToMs(parsed.rt),
          urtMs: parseSecToMs(parsed.urt),
          cacheKind,
          referrer: normalizeReferrer(parsed.ref),
        })
        ingested++
      } catch {
        // Ignore malformed log lines
      }
    }
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords)
    }
    return ingested
  }

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
    const nowMs = now.getTime()
    const windowMs =
      window === '1h'
        ? 3_600_000
        : window === '24h'
          ? 86_400_000
          : window === '7d'
            ? 7 * 86_400_000
            : 30 * 86_400_000
    const cutoffMs = nowMs - windowMs
    const hostLower = domain.name.toLowerCase()

    const matching = this.records.filter(
      (r) => r.tsMs >= cutoffMs && (r.host === hostLower || r.host === `www.${hostLower}`),
    )

    const bucketMap = new Map<
      string,
      {
        requests: number
        bytes: number
        s2xx: number
        s3xx: number
        s4xx: number
        s5xx: number
        cacheHit: number
        cacheMiss: number
        cacheBypass: number
        rtSumMs: number
        urtSumMs: number
        rts: number[]
      }
    >()

    const allIps = new Set<string>()
    const rts: number[] = []
    let totalBytes = 0
    let totalRtMs = 0
    let totalUrtMs = 0
    let cacheHits = 0
    let status2xx = 0
    let status3xx = 0
    let status4xx = 0
    let status5xx = 0

    const pathCounts = new Map<string, { requests: number; bytes: number; errors5xx: number }>()
    const refCounts = new Map<string, { requests: number; bytes: number; errors5xx: number }>()
    const ipCounts = new Map<string, { requests: number; bytes: number; errors5xx: number }>()

    for (const r of matching) {
      allIps.add(r.ip)
      totalBytes += r.bytes
      totalRtMs += r.rtMs
      totalUrtMs += r.urtMs
      rts.push(r.rtMs)
      if (r.cacheKind === 'hit') cacheHits++

      const is5xx = r.status >= 500
      if (r.status >= 200 && r.status < 300) status2xx++
      else if (r.status >= 300 && r.status < 400) status3xx++
      else if (r.status >= 400 && r.status < 500) status4xx++
      else if (is5xx) status5xx++

      let b = bucketMap.get(r.tsHourIso)
      if (!b) {
        b = {
          requests: 0,
          bytes: 0,
          s2xx: 0,
          s3xx: 0,
          s4xx: 0,
          s5xx: 0,
          cacheHit: 0,
          cacheMiss: 0,
          cacheBypass: 0,
          rtSumMs: 0,
          urtSumMs: 0,
          rts: [],
        }
        bucketMap.set(r.tsHourIso, b)
      }
      b.requests++
      b.bytes += r.bytes
      b.rtSumMs += r.rtMs
      b.urtSumMs += r.urtMs
      b.rts.push(r.rtMs)
      if (r.cacheKind === 'hit') b.cacheHit++
      else if (r.cacheKind === 'bypass') b.cacheBypass++
      else b.cacheMiss++

      if (r.status >= 200 && r.status < 300) b.s2xx++
      else if (r.status >= 300 && r.status < 400) b.s3xx++
      else if (r.status >= 400 && r.status < 500) b.s4xx++
      else if (is5xx) b.s5xx++

      const p = pathCounts.get(r.uri) ?? { requests: 0, bytes: 0, errors5xx: 0 }
      p.requests++
      p.bytes += r.bytes
      if (is5xx) p.errors5xx++
      pathCounts.set(r.uri, p)

      const rf = refCounts.get(r.referrer) ?? { requests: 0, bytes: 0, errors5xx: 0 }
      rf.requests++
      rf.bytes += r.bytes
      if (is5xx) rf.errors5xx++
      refCounts.set(r.referrer, rf)

      const ic = ipCounts.get(r.ip) ?? { requests: 0, bytes: 0, errors5xx: 0 }
      ic.requests++
      ic.bytes += r.bytes
      if (is5xx) ic.errors5xx++
      ipCounts.set(r.ip, ic)
    }

    rts.sort((a, b) => a - b)
    const totalRequests = matching.length

    const series: WebsiteTrafficBucket[] = [...bucketMap.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([at, b]) => {
        b.rts.sort((x, y) => x - y)
        return {
          at,
          requests: b.requests,
          bytes: b.bytes,
          status2xx: b.s2xx,
          status3xx: b.s3xx,
          status4xx: b.s4xx,
          status5xx: b.s5xx,
          cacheHit: b.cacheHit,
          cacheMiss: b.cacheMiss,
          cacheBypass: b.cacheBypass,
          avgRequestTimeMs: b.requests > 0 ? Number((b.rtSumMs / b.requests).toFixed(2)) : 0,
          p95RequestTimeMs: percentile95(b.rts),
          avgUpstreamTimeMs: b.requests > 0 ? Number((b.urtSumMs / b.requests).toFixed(2)) : 0,
        }
      })

    const atIso = now.toISOString()
    const snapshot: WebsiteAnalyticsSnapshot = {
      domain: domain.name,
      accountId: domain.accountId,
      at: atIso,
      totals: {
        requests: totalRequests,
        bytes: totalBytes,
        uniqueVisitors: allIps.size,
        cacheHitRatioPercent: totalRequests > 0 ? Number(((cacheHits / totalRequests) * 100).toFixed(1)) : 0,
        errorRatePercent: totalRequests > 0 ? Number(((status5xx / totalRequests) * 100).toFixed(2)) : 0,
        avgRequestTimeMs: totalRequests > 0 ? Number((totalRtMs / totalRequests).toFixed(2)) : 0,
        p95RequestTimeMs: percentile95(rts),
        avgUpstreamTimeMs: totalRequests > 0 ? Number((totalUrtMs / totalRequests).toFixed(2)) : 0,
        status2xx,
        status3xx,
        status4xx,
        status5xx,
      },
      series,
      topPaths: rankTop(pathCounts),
      topReferrers: rankTop(refCounts),
      topClientIps: rankTop(ipCounts),
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

