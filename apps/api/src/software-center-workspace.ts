import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

export interface SoftwareCenterWorkspaceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  /** Authenticated agent transport; agent refusals arrive as XpanelError with their outcome detail. */
  callHost: (caller: AuthenticatedCaller, path: string, input?: unknown, mutation?: boolean) => Promise<unknown>
}

const ROUTES = ['/api/server/software-center', '/api/server/software-center/preview', '/api/server/software-center/apply']
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const hash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const componentIds = (value: unknown): value is string[] => Array.isArray(value) && value.length >= 1 && value.length <= 16 && new Set(value).size === value.length && value.every(id => typeof id === 'string' && /^[a-z][a-z0-9-]{1,48}$/.test(id))
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const unverified = (mutation: boolean): never => fail(mutation ? 'SERVICE_UNAVAILABLE' : 'PRECONDITION_FAILED', 'the protected host response could not be verified', mutation ? { stateChanged: true, unknownOutcome: true, verificationRequired: true } : { stateChanged: false })

async function readBody(request: Request, apply: boolean): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', { stateChanged: false })
  let body: unknown
  try { body = await request.json() } catch { return fail('VALIDATION', 'request body is not valid JSON', { stateChanged: false }) }
  const fields = apply ? ['action', 'componentIds', 'expectedRevision', 'acceptExtraRemovals'] : ['action', 'componentIds', 'expectedRevision']
  if (!object(body) || Object.keys(body).some(key => !fields.includes(key)) || body.action !== 'install' && body.action !== 'remove' || !componentIds(body.componentIds) || !hash(body.expectedRevision) || body.acceptExtraRemovals !== undefined && !hash(body.acceptExtraRemovals))
    return fail('VALIDATION', 'an action, 1 to 16 catalog component ids and the observed revision are required', { stateChanged: false })
  return { action: body.action, componentIds: body.componentIds, expectedRevision: body.expectedRevision, ...(body.acceptExtraRemovals === undefined ? {} : { acceptExtraRemovals: body.acceptExtraRemovals }) }
}

/** Root-only software center. Package names, commands and sources are never caller inputs. */
export async function handleSoftwareCenterWorkspaceRoute(request: Request, url: URL, method: string, helpers: SoftwareCenterWorkspaceHelpers): Promise<Response | null> {
  if (!ROUTES.includes(url.pathname)) return null
  const operation = url.pathname.endsWith('/apply') ? 'apply' : url.pathname.endsWith('/preview') ? 'preview' : 'read'
  const action = 'server.software.' + operation
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  const expected = operation === 'read' ? 'GET' : 'POST'
  if (method !== expected) return new Response(null, { status: 405, headers: { allow: expected } })
  const fresh = async (mutation: boolean): Promise<AuthenticatedCaller> => {
    const current = await helpers.requireCaller(request)
    await helpers.assertRoot(current, action)
    if (current.principal.id !== caller.principal.id) return fail('FORBIDDEN', 'software center authority changed', mutation ? { stateChanged: true, verificationRequired: true } : { stateChanged: false })
    return current
  }
  if (operation === 'read') {
    const keys = [...url.searchParams.keys()], page = url.searchParams.get('page')
    if (keys.length !== 1 || keys[0] !== 'page' || !['catalog', 'module', 'runtime'].includes(page ?? '')) return fail('VALIDATION', 'page must be catalog, module or runtime', { stateChanged: false })
    const view = await helpers.callHost(caller, '/host/software-center?page=' + page)
    if (!object(view) || !['read', 'unavailable'].includes(String(view.state)) || view.page !== page || !Array.isArray(view.components) || view.components.length > 512 || view.revision !== null && !hash(view.revision)) return unverified(false)
    await fresh(false)
    return json(200, view)
  }
  if (url.search) return fail('VALIDATION', 'software center changes do not accept selectors', { stateChanged: false })
  const body = await readBody(request, operation === 'apply')
  if (operation === 'preview') {
    const result = await helpers.callHost(caller, '/host/software-center/preview', body)
    if (!object(result) || !object(result.preview) || !['ready', 'refused', 'unavailable'].includes(String(result.preview.state)) || result.preview.revision !== body.expectedRevision) return unverified(false)
    await fresh(false)
    return json(200, result)
  }
  const target = 'software:' + (body.componentIds as string[]).join(',')
  await helpers.emitAudit({ actor: caller.principal.username, action: 'software.component.change_requested', target, detail: { action: body.action, componentIds: body.componentIds, extraRemovalsAccepted: body.acceptExtraRemovals !== undefined }, outcome: 'ok', principalId: caller.principal.id })
  const submitter = await fresh(false)
  const result = await helpers.callHost(submitter, '/host/software-center/apply', body, true)
  if (!object(result) || !object(result.job) || typeof result.job.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(result.job.id) || result.job.kind !== 'software.component.' + body.action) return unverified(true)
  const after = await fresh(true)
  try { await helpers.emitAudit({ actor: after.principal.username, action: 'software.component.job_submitted', target, detail: { action: body.action, jobId: result.job.id }, outcome: 'ok', principalId: after.principal.id }) }
  catch { return fail('SERVICE_UNAVAILABLE', 'package job submission requires audit review', { stateChanged: true, unknownOutcome: true, verificationRequired: true }) }
  return json(202, { job: result.job })
}
