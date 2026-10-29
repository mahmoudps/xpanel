import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import type { BandwidthAccountRow, BandwidthReport, BandwidthSourceState, BandwidthTotals } from '../../agent/src/metering.ts'
import type { DiskLatency } from '../../agent/src/host-metrics.ts'
import type { IoHostFields } from '../../agent/src/analytics.ts'

export interface MeteringWorkspaceHelpers {
  requireCaller(request: Request): Promise<AuthenticatedCaller>
  assertRoot(caller: AuthenticatedCaller, action: string): Promise<void>
  readHost(caller: AuthenticatedCaller, path: string): Promise<unknown>
}
type Limit = number | 'unlimited'
export interface IoAccountView { username: string; uid: number; readBytesPerSec: number; writeBytesPerSec: number; readIops: number; writeIops: number; cpuPercent: number; memoryCurrentBytes: number; memoryLimitMb: Limit; pidsCurrent: number; pidsLimit: Limit; statusLevel: 'ok' | 'warn' | 'critical' }
/** API view of the agent IoAccountsView: no internal account ids cross this boundary. */
export interface IoWorkspaceView { state: 'read' | 'partial' | 'unavailable'; reason: string | null; observedAt: string | null; host: IoHostFields | null; disk: DiskLatency; accounts: IoAccountView[]; unmeasuredAccounts: number }

const PATHS: Readonly<Record<string, { host: string; action: string }>> = {
  '/api/server/monitoring/io': { host: '/host/monitoring/io', action: 'server.io.read' },
  '/api/server/monitoring/bandwidth': { host: '/host/monitoring/bandwidth', action: 'server.bandwidth.read' },
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const int = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max
const num = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max
const instant = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v))
const username = (v: unknown): v is string => typeof v === 'string' && /^[a-z][a-z0-9]{0,15}$/.test(v)
const limit = (v: unknown): v is Limit => v === 'unlimited' || int(v)
const bad = (): never => fail('SERVICE_UNAVAILABLE', 'the metering observation could not be verified', { stateChanged: false })
const BANDWIDTH_SOURCES = ['web', 'mail', 'ftp'] as const
const IO_REASONS = ['not-sampled', 'paused', 'stale', 'configuration-changed', 'invalid', 'incomplete']
const HOST_KEYS = ['cpuPercent', 'memoryUsedBytes', 'memoryTotalBytes', 'loadAvg1m', 'psiSomeAvg10', 'psiFullAvg10', 'awaitMs'] as const

const DEVICE = /^(?:sd[a-z]{1,3}|vd[a-z]{1,3}|xvd[a-z]{1,3}|hd[a-z]{1,3}|nvme\d{1,3}n\d{1,3}|mmcblk\d{1,3})$/
function projectDisk(raw: unknown): DiskLatency {
  if (!object(raw) || !['read', 'idle', 'unavailable'].includes(String(raw.state)) || !Array.isArray(raw.devices) || raw.devices.length > 64) return bad()
  const state = raw.state as DiskLatency['state']
  if (state === 'unavailable' ? raw.observedAt !== null || raw.intervalSeconds !== null || raw.awaitMs !== null || raw.devices.length > 0
    : !instant(raw.observedAt) || !num(raw.intervalSeconds) || (state === 'read' ? !num(raw.awaitMs) : raw.awaitMs !== null) || !raw.devices.length) return bad()
  const devices = raw.devices.map(v => object(v) && typeof v.name === 'string' && DEVICE.test(v.name) && (v.readAwaitMs === null || num(v.readAwaitMs)) && (v.writeAwaitMs === null || num(v.writeAwaitMs)) && num(v.utilPercent, 100)
    ? { name: v.name, readAwaitMs: v.readAwaitMs as number | null, writeAwaitMs: v.writeAwaitMs as number | null, utilPercent: v.utilPercent } : bad())
  return { state, observedAt: raw.observedAt as string | null, intervalSeconds: raw.intervalSeconds as number | null, awaitMs: raw.awaitMs as number | null, devices }
}

export function projectIoView(raw: unknown): IoWorkspaceView {
  if (!object(raw) || !['read', 'partial', 'unavailable'].includes(String(raw.state)) || !Array.isArray(raw.accounts) || raw.accounts.length > 4096 || !int(raw.unmeasuredAccounts, 4096) || raw.observedAt !== null && !instant(raw.observedAt)) return bad()
  const state = raw.state as IoWorkspaceView['state']
  if (state === 'unavailable' ? !IO_REASONS.includes(String(raw.reason)) || raw.host !== null || raw.accounts.length > 0 : raw.reason !== null || !instant(raw.observedAt) || !object(raw.host)) return bad()
  let host: IoHostFields | null = null
  if (object(raw.host)) {
    const fields = raw.host
    if (HOST_KEYS.some(key => fields[key] !== null && !num(fields[key]))) return bad()
    host = Object.fromEntries(HOST_KEYS.map(key => [key, fields[key]])) as unknown as IoHostFields
  }
  const accounts = raw.accounts.map((v): IoAccountView => {
    if (!object(v) || !username(v.username) || !int(v.uid, 4_294_967_295) || !['readBytesPerSec', 'writeBytesPerSec', 'readIops', 'writeIops', 'memoryCurrentBytes', 'pidsCurrent'].every(key => num(v[key])) || !num(v.cpuPercent, 1_000_000) || !limit(v.memoryLimitMb) || !limit(v.pidsLimit) || !['ok', 'warn', 'critical'].includes(String(v.statusLevel))) return bad()
    return { username: v.username, uid: v.uid, readBytesPerSec: v.readBytesPerSec as number, writeBytesPerSec: v.writeBytesPerSec as number, readIops: v.readIops as number, writeIops: v.writeIops as number, cpuPercent: v.cpuPercent, memoryCurrentBytes: v.memoryCurrentBytes as number, memoryLimitMb: v.memoryLimitMb, pidsCurrent: v.pidsCurrent as number, pidsLimit: v.pidsLimit, statusLevel: v.statusLevel as IoAccountView['statusLevel'] }
  })
  if (new Set(accounts.map(v => v.username)).size !== accounts.length) return bad()
  return { state, reason: state === 'unavailable' ? String(raw.reason) : null, observedAt: raw.observedAt as string | null, host, disk: projectDisk(raw.disk), accounts, unmeasuredAccounts: raw.unmeasuredAccounts }
}

export function projectBandwidthReport(raw: unknown): BandwidthReport {
  const totals = (v: unknown): BandwidthTotals => object(v) && int(v.count) && int(v.receivedBytes) && int(v.sentBytes) ? { count: v.count, receivedBytes: v.receivedBytes, sentBytes: v.sentBytes } : bad()
  if (!object(raw) || !['read', 'partial', 'unavailable'].includes(String(raw.state)) || typeof raw.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(raw.month) || !object(raw.sources) || !Array.isArray(raw.accounts) || raw.accounts.length > 4096 || !['pendingBytes', 'unavailableSites', 'skippedLines'].every(key => int(raw[key]))) return bad()
  if (raw.state === 'unavailable' ? raw.since !== null || raw.updatedAt !== null : !instant(raw.since) || !instant(raw.updatedAt)) return bad()
  const rawSources = raw.sources
  const sources = Object.fromEntries(BANDWIDTH_SOURCES.map(source => {
    const v = rawSources[source]
    if (!object(v) || !['read', 'partial', 'unavailable'].includes(String(v.state)) || v.since !== null && !instant(v.since)) return bad()
    return [source, { state: v.state as BandwidthSourceState['state'], since: v.since as string | null }]
  })) as BandwidthReport['sources']
  const accounts = raw.accounts.map((v): BandwidthAccountRow => {
    if (!object(v) || !username(v.username) || typeof v.domain !== 'string' || v.domain.length > 253 || !/^[a-z0-9.-]+$/.test(v.domain) || !['active', 'suspended', 'terminating'].includes(String(v.status)) || !object(v.month)) return bad()
    const rawMonth = v.month
    const month = Object.fromEntries(BANDWIDTH_SOURCES.map(source => [source, rawMonth[source] === null ? null : totals(rawMonth[source])])) as BandwidthAccountRow['month']
    const measured = BANDWIDTH_SOURCES.filter(source => month[source] !== null)
    const total = measured.reduce((sum, source) => sum + month[source]!.receivedBytes + month[source]!.sentBytes, 0)
    if ((measured.length ? v.totalBytes !== total : v.totalBytes !== null) || v.limitBytes !== null && !int(v.limitBytes) || v.usedPercent !== null && !num(v.usedPercent) || (v.usedPercent === null) !== (v.limitBytes === null || v.totalBytes === null) || !['within', 'near', 'over', 'unlimited', 'unmeasured'].includes(String(v.limitState)) || typeof v.enforced !== 'boolean' || typeof v.limited !== 'boolean') return bad()
    if (BANDWIDTH_SOURCES.some(source => month[source] !== null && sources[source].state === 'unavailable')) return bad()
    return { username: v.username, domain: v.domain, status: v.status as BandwidthAccountRow['status'], month, totalBytes: v.totalBytes as number | null, limitBytes: v.limitBytes as number | null, usedPercent: v.usedPercent as number | null, limitState: v.limitState as BandwidthAccountRow['limitState'], enforced: v.enforced, limited: v.limited }
  })
  if (new Set(accounts.map(v => v.username)).size !== accounts.length || raw.state === 'unavailable' && accounts.some(v => v.totalBytes !== null)) return bad()
  return { state: raw.state as BandwidthReport['state'], month: raw.month, since: raw.since as string | null, updatedAt: raw.updatedAt as string | null, sources, pendingBytes: raw.pendingBytes as number, unavailableSites: raw.unavailableSites as number, skippedLines: raw.skippedLines as number, accounts }
}

/** Root-only cached host metering reads: the per-account IO snapshot and monthly web bandwidth. */
export async function handleMeteringWorkspaceRoute(request: Request, url: URL, method: string, helpers: MeteringWorkspaceHelpers): Promise<Response | null> {
  const route = PATHS[url.pathname]
  if (!route) return null
  const caller = await helpers.requireCaller(request); await helpers.assertRoot(caller, route.action)
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  if (url.search || request.body !== null) return fail('VALIDATION', 'metering reads accept no selectors or body', { stateChanged: false })
  const raw = await helpers.readHost(caller, route.host)
  const body = route.host === '/host/monitoring/io' ? projectIoView(raw) : projectBandwidthReport(raw)
  const fresh = await helpers.requireCaller(request); await helpers.assertRoot(fresh, route.action)
  if (fresh.principal.id !== caller.principal.id) return fail('FORBIDDEN', 'metering read authority changed', { stateChanged: false })
  return Response.json(body, { headers: { 'cache-control': 'private, no-store' } })
}
