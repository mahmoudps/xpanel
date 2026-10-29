import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import type { BenchmarkResult } from '../../agent/src/benchmark.ts'

export interface BenchmarkWorkspaceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  callHost(caller: AuthenticatedCaller, path: string, body?: Record<string, unknown>): Promise<unknown>
}
export interface BenchmarkView { history: { state: 'read' | 'unavailable'; results: BenchmarkResult[] }; jobsAvailable: boolean; limits: { cpuSeconds: 5; diskBytes: 67108864; maxRuntimeSeconds: 60 }; network: 'not_measured' }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const instant = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v))
const rate = (v: unknown): v is number | null => v === null || typeof v === 'number' && Number.isSafeInteger(v) && v > 0
const bad = (): never => fail('SERVICE_UNAVAILABLE', 'benchmark history could not be verified', { stateChanged: false })
export function projectBenchmarkView(raw: unknown): BenchmarkView {
  if (!object(raw) || !object(raw.history) || !['read', 'unavailable'].includes(String(raw.history.state)) || !Array.isArray(raw.history.results) || raw.history.results.length > 20 || typeof raw.jobsAvailable !== 'boolean' || !object(raw.limits) || raw.limits.cpuSeconds !== 5 || raw.limits.diskBytes !== 67108864 || raw.limits.maxRuntimeSeconds !== 60 || raw.network !== 'not_measured') return bad()
  const results = raw.history.results.map((v): BenchmarkResult => {
    if (!object(v) || !instant(v.startedAt) || !instant(v.finishedAt) || Date.parse(v.finishedAt) < Date.parse(v.startedAt) || !['measured', 'partial', 'unavailable'].includes(String(v.state)) || !rate(v.cpuBytesPerSecond) || !rate(v.diskWriteBytesPerSecond) || !rate(v.diskReadBytesPerSecond) || !['verified', 'unknown'].includes(String(v.cleanup)) || v.network !== 'not_measured' || v.state === 'measured' && (v.cleanup !== 'verified' || v.cpuBytesPerSecond === null || v.diskWriteBytesPerSecond === null || v.diskReadBytesPerSecond === null)) return bad()
    return { startedAt: v.startedAt, finishedAt: v.finishedAt, state: v.state as BenchmarkResult['state'], cpuBytesPerSecond: v.cpuBytesPerSecond as number | null, diskWriteBytesPerSecond: v.diskWriteBytesPerSecond as number | null, diskReadBytesPerSecond: v.diskReadBytesPerSecond as number | null, cleanup: v.cleanup as BenchmarkResult['cleanup'], network: 'not_measured' }
  })
  if (raw.history.state === 'unavailable' && results.length) return bad()
  return { history: { state: raw.history.state as BenchmarkView['history']['state'], results }, jobsAvailable: raw.jobsAvailable, limits: { cpuSeconds: 5, diskBytes: 67108864, maxRuntimeSeconds: 60 }, network: 'not_measured' }
}
export async function handleBenchmarkWorkspaceRoute(request: Request, url: URL, method: string, h: BenchmarkWorkspaceHelpers): Promise<Response | null> {
  if (url.pathname !== '/api/server/monitoring/benchmark' && url.pathname !== '/api/server/monitoring/benchmark/jobs') return null
  const reading = url.pathname.endsWith('/benchmark'), action = reading ? 'server.benchmark.read' : 'server.benchmark.run'
  const caller = await h.requireCaller(request); await h.assertRoot(caller, action)
  if (method !== (reading ? 'GET' : 'POST')) return new Response(null, { status: 405, headers: { allow: reading ? 'GET' : 'POST' } })
  if (url.search || reading && request.body !== null) return fail('VALIDATION', 'benchmark accepts no selectors', { stateChanged: false })
  const fresh = async (): Promise<AuthenticatedCaller> => { const next = await h.requireCaller(request); await h.assertRoot(next, action); if (next.principal.id !== caller.principal.id) return fail('FORBIDDEN', 'benchmark authority changed', { stateChanged: false }); return next }
  if (reading) { const data = projectBenchmarkView(await h.callHost(caller, '/host/monitoring/benchmark')); await fresh(); return Response.json(data, { headers: { 'cache-control': 'private, no-store' } }) }
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'application/json is required', { stateChanged: false })
  const text = await request.text(); let body: unknown
  try { body = text.length <= 256 ? JSON.parse(text) : null } catch { body = null }
  if (!object(body) || Object.keys(body).length !== 1 || body.confirm !== 'RUN') return fail('VALIDATION', 'confirm RUN is required', { stateChanged: false })
  const actor = await fresh()
  let raw: unknown
  try { raw = await h.callHost(actor, '/host/monitoring/benchmark/jobs', { confirm: 'RUN' }) } catch (error) {
    const detail = (error as { detail?: Record<string, unknown> })?.detail
    await h.emitAudit({ actor: actor.principal.username, principalId: actor.principal.id, action, target: 'server', outcome: 'failed', detail: { outcome: detail?.stateChanged === false ? 'refused' : 'unknown' } }).catch(() => undefined)
    throw error
  }
  const job = object(raw) && object(raw.job) ? raw.job : null
  if (!job || typeof job.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(job.id) || job.kind !== 'system.monitoring.benchmark' || !['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(String(job.status))) return fail('PRECONDITION_FAILED', 'benchmark submission requires review', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
  try { await fresh(); await h.emitAudit({ actor: actor.principal.username, principalId: actor.principal.id, action, target: 'server', outcome: 'ok', detail: { jobId: job.id, outcome: 'submitted' } }) } catch { return fail('PRECONDITION_FAILED', 'benchmark was submitted and requires review', { stateChanged: true, verificationRequired: true, unknownOutcome: true }) }
  return Response.json({ job: { id: job.id, kind: job.kind, status: job.status } }, { status: 202, headers: { 'cache-control': 'no-store' } })
}
