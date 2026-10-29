import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import type { TrafficReport, TrafficRow, TrafficAccount, TrafficInterface } from '../../agent/src/traffic-monitor.ts'

export interface TrafficWorkspaceHelpers {
  requireCaller(request: Request): Promise<AuthenticatedCaller>
  assertRoot(caller: AuthenticatedCaller, action: string): Promise<void>
  readHost(caller: AuthenticatedCaller): Promise<unknown>
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const int = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const instant = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && v.length <= 40 && Number.isFinite(Date.parse(v))
const bad = (): never => fail('SERVICE_UNAVAILABLE', 'traffic observation could not be verified', { stateChanged: false })
const state = (v: unknown): v is 'read' | 'partial' | 'unavailable' => v === 'read' || v === 'partial' || v === 'unavailable'
const account = (v: unknown): v is string => typeof v === 'string' && /^[a-z][a-z0-9]{0,15}$/.test(v)
const counts = (v: Record<string, unknown>): boolean => ['requests', 'receivedBytes', 'sentBytes', 'errors'].every(key => int(v[key])) && Number(v.errors) <= Number(v.requests)

/** Whitelist the observation; no host paths, internal account ids, addresses or raw log lines cross this API. */
export function projectTrafficReport(raw: unknown): TrafficReport {
  if (!object(raw) || raw.scope !== 'server' || !instant(raw.observedAt) || !object(raw.interfaces) || !object(raw.http) || !object(raw.history) || raw.history.state !== 'unavailable' || raw.history.reason !== 'network_counters_not_recorded') return bad()
  const net = raw.interfaces, http = raw.http
  if (!state(net.state) || !int(net.intervalMs) || net.intervalMs > 10000 || !int(net.skipped) || !Array.isArray(net.items) || net.items.length > 256) return bad()
  const interfaces = net.items.map((v): TrafficInterface => {
    if (!object(v) || typeof v.name !== 'string' || !/^[a-zA-Z0-9_.-]{1,64}$/.test(v.name) || !['read', 'counter_reset'].includes(String(v.state))) return bad()
    if (v.state === 'read' ? !int(v.receivedBps) || !int(v.sentBps) : v.receivedBps !== null || v.sentBps !== null) return bad()
    return { name: v.name, state: v.state as TrafficInterface['state'], receivedBps: v.receivedBps as number | null, sentBps: v.sentBps as number | null }
  })
  if (net.state === 'unavailable' ? net.intervalMs !== 0 || net.skipped !== 0 || interfaces.length > 0 : net.intervalMs < 500 || interfaces.length === 0) return bad()
  if (net.state === 'read' && (net.skipped !== 0 || interfaces.some(v => v.state !== 'read'))) return bad()
  if (net.state === 'unavailable' && interfaces.length || !state(http.state) || !Array.isArray(http.rows) || http.rows.length > 100 || !Array.isArray(http.accounts) || http.accounts.length > 32 || !['readSites', 'omittedRows', 'omittedSites', 'unavailableSites', 'skippedLines'].every(key => int(http[key])) || typeof http.truncated !== 'boolean' || http.from !== null && !instant(http.from) || http.to !== null && !instant(http.to)) return bad()
  const rows = http.rows.map((v): TrafficRow => {
    if (!object(v) || !account(v.account) || !counts(v) || typeof v.domain !== 'string' || v.domain.length > 253 || !/^[a-z0-9.-]+$/.test(v.domain)) return bad()
    return { domain: v.domain, account: v.account, requests: v.requests as number, receivedBytes: v.receivedBytes as number, sentBytes: v.sentBytes as number, errors: v.errors as number }
  })
  const accounts = http.accounts.map((v): TrafficAccount => {
    if (!object(v) || !account(v.account) || !counts(v)) return bad()
    return { account: v.account, requests: v.requests as number, receivedBytes: v.receivedBytes as number, sentBytes: v.sentBytes as number, errors: v.errors as number }
  })
  if ((http.from === null) !== (http.to === null) || http.from !== null && Date.parse(String(http.from)) > Date.parse(String(http.to))) return bad()
  if (http.state === 'unavailable' && (rows.length || accounts.length) || new Set(interfaces.map(v => v.name)).size !== interfaces.length || new Set(rows.map(v => v.domain)).size !== rows.length || new Set(accounts.map(v => v.account)).size !== accounts.length) return bad()
  return { scope: 'server', observedAt: raw.observedAt, interfaces: { state: net.state, intervalMs: net.intervalMs, skipped: net.skipped, items: interfaces }, http: { state: http.state, rows, accounts, readSites: Number(http.readSites), omittedRows: Number(http.omittedRows), omittedSites: Number(http.omittedSites), unavailableSites: Number(http.unavailableSites), skippedLines: Number(http.skippedLines), truncated: http.truncated, from: http.from as string | null, to: http.to as string | null }, history: { state: 'unavailable', reason: 'network_counters_not_recorded' } }
}
export async function handleTrafficWorkspaceRoute(request: Request, url: URL, method: string, helpers: TrafficWorkspaceHelpers): Promise<Response | null> {
  if (url.pathname !== '/api/server/monitoring/traffic') return null
  const caller = await helpers.requireCaller(request); await helpers.assertRoot(caller, 'server.traffic.read')
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  if (url.search || request.body !== null) return fail('VALIDATION', 'traffic observation accepts no selectors or body', { stateChanged: false })
  const report = projectTrafficReport(await helpers.readHost(caller))
  const fresh = await helpers.requireCaller(request); await helpers.assertRoot(fresh, 'server.traffic.read')
  if (fresh.principal.id !== caller.principal.id) return fail('FORBIDDEN', 'traffic read authority changed', { stateChanged: false })
  return Response.json(report, { headers: { 'cache-control': 'private, no-store' } })
}
