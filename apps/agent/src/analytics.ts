import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { assertJailedShellAllowed, fail, isUnlimited } from '@xpanel/core'
import type {
  Account,
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
import { system } from '@xpanel/render'
import type { AccountSliceMetrics, AgentExecutor } from './executor.ts'

export type SliceRuntimeMetrics = AccountSliceMetrics

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

  latestSnapshot(): IoAnalyticsSnapshot {
    const at = new Date().toISOString()
    const fallback: IoAnalyticsPoint = {
      at,
      readBytesPerSec: 0,
      writeBytesPerSec: 0,
      readIops: 0,
      writeIops: 0,
      awaitMs: 0,
      psiSomeAvg10: 0,
      psiFullAvg10: 0,
      cpuPercent: 0,
      memoryUsedBytes: 0,
      memoryTotalBytes: this.memoryTotalBytes,
      loadAvg1m: 0,
    }
    return {
      at,
      current: this.history[this.history.length - 1] ?? fallback,
      history: [...this.history],
      accounts: [],
    }
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

/**
 * Executes a single command inside the account's isolated jailed shell (`xpanel-<uid>.slice`
 * + mount/proc/tmpfs sandboxing), verifying account & plan shell permissions first.
 */
export const runJailedShellCommand = async (
  account: Account,
  plan: Plan,
  command: string,
  executor: AgentExecutor,
  opts: { sessionId?: string; cwdRel?: string; env?: Record<string, string>; onEvent?: (event: LiveEvent) => void } = {},
): Promise<{ sessionId: string; code: number; stdout: string; stderr: string; argv: string[] }> => {
  assertJailedShellAllowed(account, plan)
  const sessionId = opts.sessionId ?? randomUUID()
  const argv = system.buildJailedShellArgv(account, plan, command, {
    ...(opts.cwdRel && { cwdRel: opts.cwdRel }),
    ...(opts.env && { env: opts.env }),
  })
  const res = await executor.runCommand(argv)
  const stdout = res.code === 0 ? res.stdout || `[jailshell:${account.username}@xpanel ~]$ ${command}\n` : res.stdout
  const stderr = res.stderr
  const stream = res.code !== 0 && stderr ? 'stderr' : 'stdout'
  const chunk = res.code !== 0 && stderr ? stderr : stdout
  if (opts.onEvent) {
    opts.onEvent({
      id: randomUUID(),
      at: new Date().toISOString(),
      kind: 'terminal.output',
      scope: { accountId: account.id, resellerId: account.ownerId },
      data: {
        sessionId,
        username: account.username,
        stream,
        chunk,
        exitCode: res.code,
      },
    })
  }
  return { sessionId, code: res.code, stdout, stderr, argv }
}
