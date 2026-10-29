import { fail, isXpanelError } from '@xpanel/core'
import type { ErrorCode } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

export interface JobsWorkspaceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  /** The protected agent transport. The path is built here from validated values only. */
  callAgent: (caller: AuthenticatedCaller, path: string, method: 'GET' | 'POST') => Promise<Response>
}

const ROUTE = /^\/api\/jobs(?:\/([^/]+)(?:\/(log|cancel))?)?$/
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled']
const MAX_AGENT_BODY_BYTES = 2 * 1024 * 1024
const invalid = (message: string): never => fail('VALIDATION', message, { stateChanged: false })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const reference = (value: unknown): value is string | null => value === null || typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9 ._:/-]*$/.test(value) && !ID_RE.test(value.toLowerCase()) && value !== 'XP-JOB-000000'

const query = (url: URL, allowed: readonly string[]): URLSearchParams => {
  const out = new URLSearchParams()
  for (const [name, value] of url.searchParams) {
    if (!allowed.includes(name) || out.has(name)) return invalid('unsupported job selector')
    out.set(name, value)
  }
  const number = (name: string, min: number, max: number): void => {
    const raw = out.get(name)
    if (raw !== null && (!/^(?:0|[1-9][0-9]{0,8})$/.test(raw) || Number(raw) < min || Number(raw) > max)) invalid(`${name} must be an integer in ${min}..${max}`)
  }
  if (out.has('status') && !STATUSES.includes(out.get('status')!)) invalid('job status filter is invalid')
  if (out.has('kindPrefix') && !/^[a-z][a-z0-9_.:-]{0,127}$/.test(out.get('kindPrefix')!)) invalid('job kind filter is invalid')
  if (allowed.includes('offset')) { number('offset', 0, 4 * 1024 * 1024); number('limit', 1, 262_144) } else number('limit', 1, 100)
  return out
}

/** Bounded JSON read of the agent answer; agent problem text is not echoed to the browser. */
const forward = async (helpers: JobsWorkspaceHelpers, caller: AuthenticatedCaller, path: string, method: 'GET' | 'POST'): Promise<Response> => {
  const mutation = method === 'POST'
  let response: Response
  try { response = await helpers.callAgent(caller, path, method) }
  catch (error) {
    // A refusal raised before transport (no connected agent or credential) never reached the host.
    if (isXpanelError(error)) return fail('SERVICE_UNAVAILABLE', 'the host job runner is unavailable', { stateChanged: false, reason: 'host_agent_unavailable' })
    return fail('SERVICE_UNAVAILABLE', 'the host job transport could not be verified', { stateChanged: mutation, ...(mutation ? { unknownOutcome: true, verificationRequired: true } : {}) })
  }
  let body: unknown
  try {
    const reader = response.body?.getReader(), chunks: Uint8Array[] = []
    let bytes = 0
    if (reader) try {
      for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > MAX_AGENT_BODY_BYTES) { await reader.cancel(); throw new Error('limit') } chunks.push(next.value) }
    } finally { reader.releaseLock() }
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  } catch { return fail('SERVICE_UNAVAILABLE', 'the host job response could not be verified', { stateChanged: mutation, ...(mutation ? { unknownOutcome: true, verificationRequired: true } : {}) }) }
  if (!object(body)) return fail('SERVICE_UNAVAILABLE', 'the host job response could not be verified', { stateChanged: mutation, ...(mutation ? { unknownOutcome: true, verificationRequired: true } : {}) })
  if (!response.ok) {
    const detail = object(body.details) ? body.details : {}
    const unchanged = !mutation || detail.stateChanged === false
    const code: ErrorCode = response.status === 404 ? 'NOT_FOUND' : response.status === 403 ? 'FORBIDDEN' : response.status === 409 ? 'CONFLICT' : response.status === 412 ? 'PRECONDITION_FAILED' : [400, 422].includes(response.status) ? 'VALIDATION' : 'SERVICE_UNAVAILABLE'
    const message = code === 'NOT_FOUND' ? 'host job not found' : code === 'PRECONDITION_FAILED' ? 'the host job is not in a state that allows this request' : code === 'SERVICE_UNAVAILABLE' ? 'the host job runner is unavailable' : 'the host job request was refused'
    return fail(code, message, { stateChanged: !unchanged, ...(unchanged ? {} : { unknownOutcome: true, verificationRequired: true }), ...(response.status === 503 ? { reason: 'host_job_runner_unavailable' } : {}) })
  }
  const jobs = Array.isArray(body.jobs) ? body.jobs : object(body.job) ? [body.job] : []
  if (jobs.some(job => !object(job) || !reference(job.referenceCode))) return fail('SERVICE_UNAVAILABLE', 'the host job reference could not be verified', { stateChanged: mutation, ...(mutation ? { unknownOutcome: true, verificationRequired: true } : {}) })
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}

/** Root-only host job history, detail, bounded log pages and between-step cancellation. */
export async function handleJobsWorkspaceRoute(request: Request, url: URL, method: string, helpers: JobsWorkspaceHelpers): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  const [, id, action] = match
  const writing = action === 'cancel'
  let caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, writing ? 'jobs.cancel' : 'jobs.read')
  const allow = writing ? 'POST' : 'GET'
  if (method !== allow) return new Response(null, { status: 405, headers: { allow } })
  if (id !== undefined && !ID_RE.test(id)) return invalid('a lowercase job id is required')
  const selectors = query(url, id === undefined ? ['status', 'kindPrefix', 'limit'] : action === 'log' ? ['offset', 'limit'] : [])
  const search = selectors.toString() ? `?${selectors.toString()}` : ''
  if (!writing) return forward(helpers, caller, id === undefined ? `/host/jobs${search}` : `/host/jobs/${id}${action === 'log' ? '/log' : ''}${search}`, 'GET')
  if ((await request.text()).length > 0) return invalid('job cancellation does not accept a body')
  const initial = caller
  await helpers.emitAudit({ actor: caller.principal.username, action: 'host.job.cancel_requested', target: `job:${id}`, detail: {}, outcome: 'ok', principalId: caller.principal.id })
  caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, 'jobs.cancel')
  if (caller.principal.id !== initial.principal.id) return fail('FORBIDDEN', 'job cancellation authority changed', { stateChanged: false })
  const response = await forward(helpers, caller, `/host/jobs/${id}/cancel`, 'POST')
  // The cancellation is recorded by now; a changed authority is reported, never treated as unchanged.
  try {
    const after = await helpers.requireCaller(request)
    await helpers.assertRoot(after, 'jobs.cancel')
    if (after.principal.id !== initial.principal.id) throw new Error('principal_changed')
  } catch { return fail('FORBIDDEN', 'root authorization changed while the cancellation was recorded', { stateChanged: true, verificationRequired: true }) }
  try { await helpers.emitAudit({ actor: caller.principal.username, action: 'host.job.cancel_recorded', target: `job:${id}`, detail: {}, outcome: 'ok', principalId: caller.principal.id }) }
  catch { return fail('SERVICE_UNAVAILABLE', 'the job cancellation audit requires verification', { stateChanged: true, verificationRequired: true }) }
  return response
}
