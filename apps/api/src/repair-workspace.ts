import { fail, isXpanelError } from '@xpanel/core'
import type { ErrorCode } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

export type RepairAgentPath = '/host/repair/diagnostics' | '/host/repair/preview' | '/host/repair/run'
export interface RepairWorkspaceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  /** The protected agent RPC. Only the normalized reviewed intent is forwarded. */
  forward: (caller: AuthenticatedCaller, path: RepairAgentPath, body?: Record<string, unknown>) => Promise<Response>
}

const ROUTES: Readonly<Record<string, { method: 'GET' | 'POST'; action: string; agent: RepairAgentPath }>> = {
  '/api/server/repair/diagnostics': { method: 'GET', action: 'server.repair.read', agent: '/host/repair/diagnostics' },
  '/api/server/repair/preview': { method: 'POST', action: 'server.repair.preview', agent: '/host/repair/preview' },
  '/api/server/repair/run': { method: 'POST', action: 'server.repair.run', agent: '/host/repair/run' },
}
const REPAIRS = ['dpkg-configure', 'apt-fix-broken', 'dnf-cache-refresh', 'rpmdb-rebuild']
const MAX_REQUEST_CHARS = 4096
const MAX_RESPONSE_BYTES = 1024 * 1024
const unchanged = { stateChanged: false }
const hash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const safeText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(value)

async function readIntent(request: Request, run: boolean): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', unchanged)
  const text = await request.text()
  if (text.length > MAX_REQUEST_CHARS) return fail('VALIDATION', 'repair request is too large', unchanged)
  let body: unknown
  try { body = JSON.parse(text) } catch { return fail('VALIDATION', 'repair request is not valid JSON', unchanged) }
  const fields = run ? ['repairId', 'expectedRevision', 'acceptRemovals', 'expectedRemovals'] : ['repairId', 'expectedRevision']
  if (!object(body) || Object.keys(body).some(key => !fields.includes(key)) || !REPAIRS.includes(body.repairId as string) || !hash(body.expectedRevision)
    || body.acceptRemovals !== undefined && typeof body.acceptRemovals !== 'boolean' || body.expectedRemovals !== undefined && !hash(body.expectedRemovals)
    || (body.acceptRemovals === true) !== (body.expectedRemovals !== undefined)
    || body.repairId !== 'apt-fix-broken' && body.acceptRemovals !== undefined) return fail('VALIDATION', 'a reviewed repair, observed revision and exact removal acceptance are required', unchanged)
  return { repairId: body.repairId, expectedRevision: body.expectedRevision, ...(body.acceptRemovals === undefined ? {} : { acceptRemovals: body.acceptRemovals }), ...(body.expectedRemovals === undefined ? {} : { expectedRemovals: body.expectedRemovals }) }
}

async function readBounded(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('missing_body')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('response_limit') }
      chunks.push(next.value)
    }
  } finally { reader.releaseLock() }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
}

const CODE_BY_STATUS: Readonly<Record<number, ErrorCode>> = { 400: 'VALIDATION', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 412: 'PRECONDITION_FAILED', 422: 'VALIDATION', 503: 'SERVICE_UNAVAILABLE' }

/** Only reviewed refusal details cross the boundary: state flags, reason, revision and removal list. */
function refusalDetail(problem: unknown, run: boolean): Record<string, unknown> {
  const details = object(problem) && object(problem.details) ? problem.details : {}
  const detail: Record<string, unknown> = {}
  for (const flag of ['stateChanged', 'unknownOutcome', 'verificationRequired'] as const) if (typeof details[flag] === 'boolean') detail[flag] = details[flag]
  if (detail.stateChanged !== false && run) Object.assign(detail, { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  if (detail.stateChanged === undefined) detail.stateChanged = false
  if (typeof details.reason === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(details.reason)) detail.reason = details.reason
  if (hash(details.revision)) detail.revision = details.revision
  if (hash(details.removalFingerprint)) detail.removalFingerprint = details.removalFingerprint
  if (Array.isArray(details.removals) && details.removals.length <= 2000 && details.removals.every(name => typeof name === 'string' && /^[a-z0-9][a-z0-9+.:-]{0,160}$/.test(name))) detail.removals = details.removals
  return detail
}

/** Root-only repair workspace. GET diagnostics; POST preview and run, re-checked before and after the host call. */
export async function handleRepairWorkspaceRoute(request: Request, url: URL, method: string, helpers: RepairWorkspaceHelpers): Promise<Response | null> {
  const route = Object.hasOwn(ROUTES, url.pathname) ? ROUTES[url.pathname] : undefined
  if (!route) return null
  const initial = await helpers.requireCaller(request)
  await helpers.assertRoot(initial, route.action)
  if (method !== route.method) return new Response(null, { status: 405, headers: { allow: route.method } })
  if (url.search) return fail('VALIDATION', 'repair workspace routes do not accept selectors', unchanged)
  const run = route.agent === '/host/repair/run'
  const confirm = async (stateChanged: boolean): Promise<AuthenticatedCaller> => {
    const fresh = await helpers.requireCaller(request)
    await helpers.assertRoot(fresh, route.action)
    if (fresh.principal.id !== initial.principal.id || fresh.sessionId !== initial.sessionId || fresh.apiTokenId !== initial.apiTokenId)
      return fail('FORBIDDEN', 'repair authority changed', stateChanged ? { stateChanged: true, unknownOutcome: true, verificationRequired: true } : unchanged)
    return fresh
  }
  let caller = initial, body: Record<string, unknown> | undefined
  if (route.method === 'POST') {
    body = await readIntent(request, run)
    caller = await confirm(false)
    if (run) {
      try { await helpers.emitAudit({ actor: caller.principal.username, action: 'server.repair.run_requested', target: 'repair:' + String(body.repairId), detail: { acceptRemovals: body.acceptRemovals === true }, outcome: 'ok', principalId: caller.principal.id }) }
      catch { return fail('PRECONDITION_FAILED', 'the repair request could not be audited, so it was not sent', unchanged) }
    }
  }
  let response: Response
  try { response = await helpers.forward(caller, route.agent, body) }
  catch (error) {
    // A refusal raised before dispatch (for example, no connected agent) is known not to change state.
    if (isXpanelError(error) && error.detail.stateChanged === false) throw error
    return fail('SERVICE_UNAVAILABLE', 'protected host transport could not be verified', run ? { stateChanged: true, unknownOutcome: true, verificationRequired: true } : unchanged)
  }
  const submitted = run && response.status === 202
  let payload: unknown
  try { payload = await readBounded(response) }
  catch { return fail('SERVICE_UNAVAILABLE', 'protected host response could not be verified', submitted || run && !response.ok && response.status >= 500 ? { stateChanged: true, unknownOutcome: true, verificationRequired: true } : unchanged) }
  if (route.method === 'POST') await confirm(submitted)
  if (!response.ok) {
    const message = object(payload) && safeText(payload.detail, 300) ? payload.detail : 'the protected host refused the repair request'
    return fail(CODE_BY_STATUS[response.status] ?? 'PRECONDITION_FAILED', message, refusalDetail(payload, run && response.status >= 500))
  }
  if (submitted) {
    const reference = object(payload) && object(payload.job) ? payload.job.referenceCode : undefined
    if (!(reference === null || typeof reference === 'string' && reference.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9 ._:/-]*$/.test(reference) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reference) && reference !== 'XP-JOB-000000')) return fail('SERVICE_UNAVAILABLE', 'the submitted repair job reference could not be verified', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
    const jobId = object(payload) && object(payload.job) && typeof payload.job.id === 'string' ? payload.job.id.slice(0, 128) : null
    try { await helpers.emitAudit({ actor: caller.principal.username, action: 'server.repair.job_submitted', target: 'repair:' + String(body?.repairId), detail: { jobId }, outcome: 'ok', principalId: caller.principal.id }) }
    catch { return fail('PRECONDITION_FAILED', 'the repair job was submitted but its audit record requires review', { stateChanged: true, verificationRequired: true, ...(jobId ? { jobId } : {}) }) }
  }
  return new Response(JSON.stringify(payload), { status: response.status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}
