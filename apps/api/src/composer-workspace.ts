import { fail } from '@xpanel/core'
import { readComposerJobReview, readComposerWorkspaceView } from '../../../packages/os/src/composer-command-view.ts'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

export interface ComposerWorkspaceHelpers {
  requireCaller(request: Request): Promise<AuthenticatedCaller>
  assertRoot(caller: AuthenticatedCaller, action: string): Promise<void>
  /** Authenticated agent transport; a body makes it a POST. Refusals arrive as XpanelError with their outcome detail. */
  callHost(caller: AuthenticatedCaller, path: string, input?: unknown, mutation?: boolean): Promise<unknown>
  emitAudit?: ExtendedRouteHelpers['emitAudit']
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const HASH = /^[0-9a-f]{64}$/
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

async function handleComposerJobs(request: Request, url: URL, method: string, helpers: ComposerWorkspaceHelpers): Promise<Response> {
  const apply = url.pathname.endsWith('/apply'), label = 'server.composer.' + (apply ? 'apply' : 'preview')
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, label)
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  if (url.search) return fail('VALIDATION', 'Composer jobs do not accept query selectors', { stateChanged: false })
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'Composer jobs require JSON', { stateChanged: false })
  const text = await request.text()
  let body: unknown
  try { body = text.length <= 2048 ? JSON.parse(text) : null } catch { body = null }
  const fields = apply ? 'action,domainId,expectedRevision,reviewFingerprint' : 'action,domainId'
  if (!object(body) || Object.keys(body).sort().join() !== fields || !['install', 'update'].includes(String(body.action)) || typeof body.domainId !== 'string' || !UUID.test(body.domainId)
    || apply && (typeof body.expectedRevision !== 'string' || !HASH.test(body.expectedRevision) || typeof body.reviewFingerprint !== 'string' || !HASH.test(body.reviewFingerprint))) return fail('VALIDATION', 'choose install or update and a saved site with the exact current review; paths, URLs, environments and extra fields are refused', { stateChanged: false })
  const fresh = async (mutation: boolean): Promise<AuthenticatedCaller> => {
    const current = await helpers.requireCaller(request)
    await helpers.assertRoot(current, label)
    if (current.principal.id !== caller.principal.id) return fail('FORBIDDEN', 'Composer authority changed', mutation ? { stateChanged: true, verificationRequired: true } : { stateChanged: false })
    return current
  }
  if (!apply) {
    const result = await helpers.callHost(caller, '/host/composer/jobs/preview', body, false)
    let review
    try { review = readComposerJobReview(result); if (review.action !== body.action || review.domainId !== body.domainId) throw new Error('wrong_review') } catch { return fail('PRECONDITION_FAILED', 'the Composer review could not be verified', { stateChanged: false }) }
    await fresh(false)
    return Response.json({ review }, { headers: { 'cache-control': 'no-store' } })
  }
  if (!helpers.emitAudit) return fail('PRECONDITION_FAILED', 'Composer jobs require durable audit', { stateChanged: false })
  const target = 'composer:' + body.domainId
  await helpers.emitAudit({ actor: caller.principal.username, action: 'server.composer.job_requested', target, detail: { action: body.action, reviewFingerprint: body.reviewFingerprint }, outcome: 'ok', principalId: caller.principal.id })
  const submitter = await fresh(false)
  const result = await helpers.callHost(submitter, '/host/composer/jobs/apply', body, true)
  if (!object(result) || !object(result.job) || typeof result.job.id !== 'string' || !UUID.test(result.job.id) || result.job.kind !== 'composer.dependencies.' + body.action) return fail('SERVICE_UNAVAILABLE', 'the submitted Composer job could not be verified', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  const after = await fresh(true)
  try { await helpers.emitAudit({ actor: after.principal.username, action: 'server.composer.job_submitted', target, detail: { action: body.action, jobId: result.job.id }, outcome: 'ok', principalId: after.principal.id }) }
  catch { return fail('SERVICE_UNAVAILABLE', 'Composer job submission requires audit review', { stateChanged: true, unknownOutcome: true, verificationRequired: true }) }
  return Response.json({ job: result.job }, { status: 202, headers: { 'cache-control': 'no-store' } })
}

export async function handleComposerWorkspaceRoute(request: Request, url: URL, method: string, helpers: ComposerWorkspaceHelpers): Promise<Response | null> {
  if (url.pathname === '/api/server/composer/jobs/preview' || url.pathname === '/api/server/composer/jobs/apply') return handleComposerJobs(request, url, method, helpers)
  if (url.pathname !== '/api/server/composer') return null
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, 'server.composer.read')
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  const keys = [...url.searchParams.keys()], selector = url.searchParams.get('domainId')
  if (keys.length > 1 || keys.length === 1 && keys[0] !== 'domainId' || selector !== null && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(selector)) return fail('VALIDATION', 'select one saved site without paths, commands or URL selectors', { stateChanged: false })
  const result = await helpers.callHost(caller, '/host/composer' + (selector === null ? '' : '?domainId=' + encodeURIComponent(selector)))
  let view
  try {
    view = readComposerWorkspaceView(result)
    if ((view.selected?.selector ?? null) !== selector) throw new Error('wrong_project')
  } catch { return fail('PRECONDITION_FAILED', 'the Composer response could not be verified', { stateChanged: false }) }
  const current = await helpers.requireCaller(request)
  await helpers.assertRoot(current, 'server.composer.read')
  if (current.principal.id !== caller.principal.id) return fail('FORBIDDEN', 'Composer authority changed', { stateChanged: false })
  return Response.json(view, { headers: { 'cache-control': 'no-store' } })
}
