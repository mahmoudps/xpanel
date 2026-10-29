import { fail, isXpanelError } from '@xpanel/core'
import type { MetricsCursor, MetricsSample } from '@xpanel/db'
import { MONITORING_PID_MAX, monitoringLogSearch, parseMonitoringLogQuery, parseMonitoringSignalRequest } from '../../../packages/os/src/monitoring-command.ts'
import type { MonitoringLogQuery, MonitoringSignalRequest } from '../../../packages/os/src/monitoring-command.ts'
import type { AccountDiskView, DiskObservation, FilesystemView, LogObservation, ProcessObservation, ProcessView, SignalOutcome } from '../../agent/src/host-monitoring.ts'
import type { AuthenticatedCaller } from './auth.ts'

export interface MonitoringWorkspaceHelpers {
  requireCaller: (request: Request) => Promise<AuthenticatedCaller>
  assertRoot: (caller: AuthenticatedCaller, action: string) => Promise<void>
  emitAudit: (entry: { actor: string; action: string; target: string; detail?: Record<string, unknown>; outcome: 'ok' | 'denied' | 'failed'; principalId?: string | null }) => Promise<unknown>
  /** Authenticated agent RPC with bounded response reading; a body marks a mutation. */
  readHost: (caller: AuthenticatedCaller, path: string, body?: unknown) => Promise<unknown>
  /** listMetricsHistory(db, { scope: 'host', ...options }): newest first. */
  listHostMetrics: (options: { since: string; limit: number; cursor?: MetricsCursor }) => Promise<MetricsSample[]>
  now?: () => Date
}

export type PerformanceWindow = '1h' | '24h' | '7d'
export const PERFORMANCE_WINDOWS: Readonly<Record<PerformanceWindow, { ms: number; buckets: number }>> = { '1h': { ms: 3_600_000, buckets: 60 }, '24h': { ms: 86_400_000, buckets: 96 }, '7d': { ms: 604_800_000, buckets: 168 } }
export const PERFORMANCE_METRICS = ['cpuPercent', 'memoryMb', 'load1', 'processes', 'diskMb'] as const
type PerformanceMetric = typeof PERFORMANCE_METRICS[number]
export interface PerformancePoint { at: string; samples: number; values: Record<PerformanceMetric, { avg: number; max: number } | null> }
export interface PerformanceHistory {
  state: 'read' | 'unavailable'; scope: 'host'; source: 'metrics-history'; window: PerformanceWindow
  from: string; to: string; bucketSeconds: number; samples: number; truncated: boolean; points: PerformancePoint[]
  reason?: 'history-unavailable' | 'invalid-history'
}

const PAGE = 2000
const MAX_HISTORY_SAMPLES = 20_160
const PATHS = new Set(['/api/server/monitoring/processes', '/api/server/monitoring/disk', '/api/server/monitoring/logs', '/api/server/monitoring/performance', '/api/server/monitoring/processes/signal'])
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max: number, min = 1): value is string => typeof value === 'string' && value.length >= min && value.length <= max && value.isWellFormed() && !/[\u0000-\u001f\u007f]/.test(value)
const iso = (value: unknown): value is string => typeof value === 'string' && value.length <= 32 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value))
const count = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max
const finite = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max
const nullable = <T>(value: unknown, check: (value: unknown) => value is T): value is T | null => value === null || check(value)
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): value is T => allowed.includes(value as T)
const invalid = (): never => fail('PRECONDITION_FAILED', 'the host monitoring observation could not be verified', { stateChanged: false, verificationRequired: true })
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const unchanged = async <T>(check: () => Promise<T>): Promise<T> => {
  try { return await check() } catch (error) { if (isXpanelError(error)) return fail(error.code, error.message, { ...error.detail, stateChanged: false }); throw error }
}

/** Whitelists the agent boundary: no field beyond the reviewed process contract escapes. */
export function projectProcesses(value: unknown): ProcessObservation {
  if (!object(value) || !oneOf(value.state, ['read', 'unavailable'] as const) || !iso(value.observedAt) || !count(value.total, 65_536) || typeof value.truncated !== 'boolean' || !Array.isArray(value.items) || value.items.length > 4000 || !Array.isArray(value.accounts) || value.accounts.length > 10_000) return invalid()
  if (value.state === 'unavailable' && (value.items.length || value.accounts.length || value.total || !oneOf(value.reason, ['process-list-unavailable', 'invalid-process-list'] as const))) return invalid()
  if (value.items.length > value.total || value.truncated !== value.total > value.items.length) return invalid()
  const seen = new Set<number>()
  const items = value.items.map((raw): ProcessView => {
    if (!object(raw) || !count(raw.pid, MONITORING_PID_MAX) || seen.has(raw.pid) || !count(raw.ppid, MONITORING_PID_MAX) || !count(raw.uid, 4_294_967_295) || !text(raw.user, 64) || /\s/.test(raw.user)
      || !finite(raw.cpuPercent, 1_000_000) || !finite(raw.memoryPercent, 100) || !count(raw.rssBytes) || !count(raw.elapsedSeconds) || !iso(raw.startedAt) || typeof raw.stat !== 'string' || !/^[DIRSTtWXZ<NLsl+]{1,8}$/.test(raw.stat)
      || !text(raw.comm, 64) || !nullable(raw.account, (item): item is string => typeof item === 'string' && /^[a-z][a-z0-9]{0,15}$/.test(item))
      || !nullable(raw.protection, (item): item is string => oneOf(item, ['init', 'kernel', 'agent', 'root', 'panel', 'protected-command'] as const))) return invalid()
    seen.add(raw.pid)
    return { pid: raw.pid, ppid: raw.ppid, uid: raw.uid, user: raw.user, cpuPercent: raw.cpuPercent, memoryPercent: raw.memoryPercent, rssBytes: raw.rssBytes, elapsedSeconds: raw.elapsedSeconds, startedAt: raw.startedAt, stat: raw.stat, comm: raw.comm, account: raw.account as string | null, protection: raw.protection as ProcessView['protection'] }
  })
  const accounts = value.accounts.map(raw => {
    if (!object(raw) || typeof raw.username !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(raw.username) || !count(raw.processes, 65_536) || !finite(raw.cpuPercent, 1_000_000_000) || !count(raw.rssBytes)) return invalid()
    return { username: raw.username, processes: raw.processes, cpuPercent: raw.cpuPercent, rssBytes: raw.rssBytes }
  })
  return { state: value.state, observedAt: value.observedAt, total: value.total, truncated: value.truncated, items, accounts, ...(value.state === 'unavailable' ? { reason: value.reason as ProcessObservation['reason'] } : {}) }
}

export function projectDisk(value: unknown): DiskObservation {
  if (!object(value) || !iso(value.observedAt) || !object(value.filesystems) || !object(value.accounts)) return invalid()
  const fs = value.filesystems, quota = value.accounts
  if (!oneOf(fs.state, ['read', 'unavailable'] as const) || !oneOf(fs.inodes, ['read', 'unavailable'] as const) || !Array.isArray(fs.items) || fs.items.length > 4096 || fs.state === 'unavailable' && (fs.items.length || fs.inodes !== 'unavailable' || !oneOf(fs.reason, ['filesystems-unavailable', 'invalid-filesystems'] as const))) return invalid()
  const items = fs.items.map((raw): FilesystemView => {
    if (!object(raw) || !text(raw.filesystem, 1024) || !text(raw.type, 64) || !text(raw.mount, 4096) || !raw.mount.startsWith('/') || !count(raw.totalBytes) || !count(raw.usedBytes) || !count(raw.availableBytes)) return invalid()
    const inodes = raw.inodes
    if (inodes !== null && (!object(inodes) || !count(inodes.total) || !count(inodes.used, Number(inodes.total)) || !count(inodes.free) || fs.inodes !== 'read')) return invalid()
    return { filesystem: raw.filesystem, type: raw.type, mount: raw.mount, totalBytes: raw.totalBytes, usedBytes: raw.usedBytes, availableBytes: raw.availableBytes, inodes: inodes === null ? null : { total: Number(inodes.total), used: Number(inodes.used), free: Number(inodes.free) } }
  })
  if (!oneOf(quota.state, ['read', 'unavailable'] as const) || quota.source !== 'repquota' || !nullable(quota.mount, (item): item is string => text(item, 4096) && item.startsWith('/')) || !Array.isArray(quota.items) || quota.items.length > 10_000
    || quota.state === 'read' && quota.mount === null || quota.state === 'unavailable' && (quota.items.length || !oneOf(quota.reason, ['quota-mount-unavailable', 'quota-report-unavailable', 'invalid-quota-report'] as const))) return invalid()
  const usage = quota.items.map((raw): AccountDiskView => {
    if (!object(raw) || typeof raw.username !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(raw.username) || !nullable(raw.usedBytes, count) || !nullable(raw.limitBytes, count)) return invalid()
    return { username: raw.username, usedBytes: raw.usedBytes as number | null, limitBytes: raw.limitBytes as number | null }
  })
  return {
    observedAt: value.observedAt,
    filesystems: { state: fs.state, inodes: fs.inodes, items, ...(fs.state === 'unavailable' ? { reason: fs.reason as DiskObservation['filesystems']['reason'] } : {}) },
    accounts: { state: quota.state, source: 'repquota', mount: quota.mount as string | null, items: usage, ...(quota.state === 'unavailable' ? { reason: quota.reason as DiskObservation['accounts']['reason'] } : {}) },
  }
}

/** The response must echo exactly the requested selector; entries stay within its line bound. */
export function projectLogs(value: unknown, query: MonitoringLogQuery): LogObservation {
  if (!object(value) || !oneOf(value.state, ['read', 'unavailable'] as const) || value.unit !== query.unit || value.lines !== query.lines || value.since !== query.since || value.priority !== query.priority
    || !iso(value.observedAt) || value.order !== 'newest-first' || typeof value.truncated !== 'boolean' || !Array.isArray(value.items) || value.items.length > query.lines) return invalid()
  if (value.state === 'unavailable' && (value.items.length || value.truncated || !oneOf(value.reason, ['journal-unavailable', 'invalid-journal'] as const))) return invalid()
  const items = value.items.map(raw => {
    if (!object(raw) || !iso(raw.at) || !nullable(raw.priority, (item): item is number => count(item, 7)) || !nullable(raw.unit, (item): item is string => text(item, 256)) || !nullable(raw.pid, (item): item is number => count(item, 4_294_967_295))
      || !nullable(raw.message, (item): item is string => typeof item === 'string' && item.length <= 4096 && item.isWellFormed() && Buffer.byteLength(item) <= 4096) || typeof raw.messageTruncated !== 'boolean') return invalid()
    return { at: raw.at, priority: raw.priority as number | null, unit: raw.unit as string | null, pid: raw.pid as number | null, message: raw.message as string | null, messageTruncated: raw.messageTruncated }
  })
  return { state: value.state, unit: query.unit, lines: query.lines, since: query.since, priority: query.priority, observedAt: value.observedAt, order: 'newest-first', truncated: value.truncated, items, ...(value.state === 'unavailable' ? { reason: value.reason as LogObservation['reason'] } : {}) }
}

export function projectSignalOutcome(value: unknown, request: MonitoringSignalRequest): SignalOutcome {
  if (!object(value) || !oneOf(value.state, ['confirmed', 'attempted', 'unknown'] as const) || value.signal !== request.signal || value.pid !== request.pid || typeof value.commandOk !== 'boolean' || !iso(value.observedAt) || value.verificationRequired !== (value.state !== 'confirmed'))
    return fail('PRECONDITION_FAILED', 'the process signal outcome requires review', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  return { state: value.state, signal: request.signal, pid: request.pid, commandOk: value.commandOk, observedAt: value.observedAt, verificationRequired: value.verificationRequired as boolean }
}

/** Fixed buckets per window; an empty bucket is a gap (null), never zero. Values are averaged as recorded. */
export function downsampleHostMetrics(samples: readonly MetricsSample[], window: PerformanceWindow, toMs: number, truncated: boolean): PerformanceHistory {
  const { ms, buckets } = PERFORMANCE_WINDOWS[window], fromMs = toMs - ms, bucketMs = ms / buckets
  const sums = Array.from({ length: buckets }, () => ({ samples: 0, totals: new Map<PerformanceMetric, number>(), maxima: new Map<PerformanceMetric, number>(), counts: new Map<PerformanceMetric, number>() }))
  let used = 0
  for (const sample of samples) {
    const at = Date.parse(sample.at)
    if (sample.scope !== 'host' || !Number.isFinite(at)) throw new Error('invalid_history_sample')
    if (at < fromMs || at > toMs) continue
    const bucket = sums[Math.min(buckets - 1, Math.floor((at - fromMs) / bucketMs))]!
    for (const metric of PERFORMANCE_METRICS) {
      const observed = sample.hostObservation
      const raw = observed === undefined ? sample[metric]
        : metric === 'load1' ? observed.load1
        : metric === 'memoryMb' ? observed.memoryTotalBytes !== null && observed.memoryAvailableBytes !== null ? (observed.memoryTotalBytes - observed.memoryAvailableBytes) / (1024 * 1024) : null
        : metric === 'diskMb' ? observed.diskUsedBytes !== null ? observed.diskUsedBytes / (1024 * 1024) : null
        : null
      if (raw === null) continue
      if (!finite(raw, Number.MAX_SAFE_INTEGER)) throw new Error('invalid_history_sample')
      bucket.counts.set(metric, (bucket.counts.get(metric) ?? 0) + 1)
      bucket.totals.set(metric, (bucket.totals.get(metric) ?? 0) + raw)
      bucket.maxima.set(metric, Math.max(bucket.maxima.get(metric) ?? 0, raw))
    }
    bucket.samples++; used++
  }
  const round = (value: number): number => Math.round(value * 100) / 100
  return {
    state: 'read', scope: 'host', source: 'metrics-history', window, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), bucketSeconds: bucketMs / 1000, samples: used, truncated,
    points: sums.map((bucket, index) => ({
      at: new Date(fromMs + index * bucketMs).toISOString(), samples: bucket.samples,
      values: Object.fromEntries(PERFORMANCE_METRICS.map(metric => [metric, bucket.counts.has(metric) ? { avg: round(bucket.totals.get(metric)! / bucket.counts.get(metric)!), max: round(bucket.maxima.get(metric)!) } : null])) as PerformancePoint['values'],
    })),
  }
}

export async function readHostPerformance(list: MonitoringWorkspaceHelpers['listHostMetrics'], window: PerformanceWindow, now: Date): Promise<PerformanceHistory> {
  const toMs = now.getTime(), since = new Date(toMs - PERFORMANCE_WINDOWS[window].ms).toISOString()
  const empty = (reason: PerformanceHistory['reason']): PerformanceHistory => ({ ...downsampleHostMetrics([], window, toMs, false), state: 'unavailable', points: [], reason })
  const samples: MetricsSample[] = []
  let cursor: MetricsCursor | undefined, truncated = false
  try {
    for (;;) {
      const page = await list({ since, limit: PAGE, ...(cursor ? { cursor } : {}) })
      if (!Array.isArray(page) || page.length > PAGE) return empty('invalid-history')
      samples.push(...page)
      if (page.length < PAGE) break
      if (samples.length > MAX_HISTORY_SAMPLES) { truncated = true; samples.length = MAX_HISTORY_SAMPLES; break }
      const last = page[page.length - 1]!
      cursor = { at: last.at, id: last.id }
    }
  } catch { return empty('history-unavailable') }
  try { return downsampleHostMetrics(samples, window, toMs, truncated) } catch { return empty('invalid-history') }
}

/** Root-only monitoring workspace. Host reads go through the agent; performance reads the local metrics history. */
export async function handleMonitoringWorkspaceRoute(request: Request, url: URL, method: string, helpers: MonitoringWorkspaceHelpers): Promise<Response | null> {
  const path = url.pathname
  if (!PATHS.has(path)) return null
  const signal = path === '/api/server/monitoring/processes/signal', action = signal ? 'server.monitoring.processes.signal' : 'server.monitoring.read'
  const caller = await unchanged(() => helpers.requireCaller(request))
  await unchanged(() => helpers.assertRoot(caller, action))
  if (method !== (signal ? 'POST' : 'GET')) return new Response(null, { status: 405, headers: { allow: signal ? 'POST' : 'GET' } })
  if (path === '/api/server/monitoring/logs') {
    const query = parseMonitoringLogQuery(url.searchParams)
    return json(projectLogs(await helpers.readHost(caller, '/host/monitoring/logs?' + monitoringLogSearch(query)), query))
  }
  if (path === '/api/server/monitoring/performance') {
    const keys = [...url.searchParams.keys()], window = url.searchParams.get('window') ?? '1h'
    if (keys.some(key => key !== 'window') || keys.length > 1 || !Object.hasOwn(PERFORMANCE_WINDOWS, window)) return fail('VALIDATION', 'performance window must be 1h, 24h or 7d', { stateChanged: false })
    return json(await readHostPerformance(helpers.listHostMetrics, window as PerformanceWindow, (helpers.now ?? (() => new Date()))()))
  }
  if (url.search) return fail('VALIDATION', 'host monitoring does not accept selectors here', { stateChanged: false })
  if (path === '/api/server/monitoring/processes') return json(projectProcesses(await helpers.readHost(caller, '/host/monitoring/processes')))
  if (path === '/api/server/monitoring/disk') return json(projectDisk(await helpers.readHost(caller, '/host/monitoring/disk')))
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', { stateChanged: false })
  let body: unknown
  try { body = await request.json() } catch { return fail('VALIDATION', 'request body is not valid JSON', { stateChanged: false }) }
  const reviewed = parseMonitoringSignalRequest(body)
  const fresh = await unchanged(() => helpers.requireCaller(request))
  if (fresh.principal.id !== caller.principal.id || fresh.sessionId !== caller.sessionId || fresh.apiTokenId !== caller.apiTokenId) return fail('FORBIDDEN', 'process signal authorization changed', { stateChanged: false })
  await unchanged(() => helpers.assertRoot(fresh, action))
  const target = 'process:' + String(reviewed.pid), detail = { pid: reviewed.pid, uid: reviewed.uid, comm: reviewed.comm, signal: reviewed.signal }
  try { await helpers.emitAudit({ actor: fresh.principal.username, action: 'server.process.signal_requested', target, detail, outcome: 'ok', principalId: fresh.principal.id }) }
  catch { return fail('PRECONDITION_FAILED', 'the process signal could not be audited before dispatch', { stateChanged: false }) }
  const outcome = projectSignalOutcome(await helpers.readHost(fresh, '/host/monitoring/processes/signal', { ...reviewed, ...(reviewed.signal === 'KILL' ? { killConfirmed: true } : {}) }), reviewed)
  try { await helpers.emitAudit({ actor: fresh.principal.username, action: 'server.process.signal', target, detail: { ...detail, state: outcome.state, commandOk: outcome.commandOk }, outcome: outcome.state === 'confirmed' ? 'ok' : 'failed', principalId: fresh.principal.id }) }
  catch { return fail('SERVICE_UNAVAILABLE', 'the process signal outcome requires audit review', { stateChanged: true, unknownOutcome: true, verificationRequired: true }) }
  return json(outcome)
}
