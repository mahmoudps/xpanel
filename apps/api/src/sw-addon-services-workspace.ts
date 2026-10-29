import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { readSwAddonServicesView, swAddonService } from '../../../packages/os/src/sw-addon-command.ts'

export interface SwAddonServicesWorkspaceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  callHost: (caller: AuthenticatedCaller, path: string, input?: unknown, mutation?: boolean) => Promise<unknown>
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

/** Root-only add-on services. Units are fixed by the reviewed list; installation stays in the software center. */
export async function handleSwAddonServicesWorkspaceRoute(request: Request, url: URL, method: string, helpers: SwAddonServicesWorkspaceHelpers): Promise<Response | null> {
  const operation = url.pathname === '/api/server/software/addon-services' ? 'read' : url.pathname === '/api/server/software/addon-services/action' ? 'action' : null
  if (!operation) return null
  const label = 'server.addon_services.' + operation, caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, label)
  const expected = operation === 'read' ? 'GET' : 'POST'
  if (method !== expected) return new Response(null, { status: 405, headers: { allow: expected } })
  if (url.search) return fail('VALIDATION', 'add-on service requests do not accept selectors', { stateChanged: false })
  const fresh = async (mutation: boolean): Promise<AuthenticatedCaller> => {
    const current = await helpers.requireCaller(request)
    await helpers.assertRoot(current, label)
    if (current.principal.id !== caller.principal.id) return fail('FORBIDDEN', 'add-on service authority changed', mutation ? { stateChanged: true, verificationRequired: true } : { stateChanged: false })
    return current
  }
  if (operation === 'read') {
    const raw = await helpers.callHost(caller, '/host/software/addon-services')
    let view: unknown
    try { view = readSwAddonServicesView(raw) } catch { return fail('PRECONDITION_FAILED', 'the protected host response could not be verified', { stateChanged: false }) }
    await fresh(false)
    return json(200, view)
  }
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', { stateChanged: false })
  const text = await request.text()
  let body: unknown
  try { body = text.length <= 512 ? JSON.parse(text) : null } catch { body = null }
  const service = object(body) ? swAddonService(body.serviceId) : null
  if (!object(body) || !service || Object.keys(body).sort().join() !== 'action,expectedRevision,serviceId' || !['start', 'stop', 'restart'].includes(String(body.action)) || typeof body.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedRevision)) return fail('VALIDATION', 'a listed add-on service, start/stop/restart and the observed revision are required', { stateChanged: false })
  await helpers.emitAudit({ actor: caller.principal.username, action: 'server.addon_service.change_requested', target: service.unit, detail: { action: body.action }, outcome: 'ok', principalId: caller.principal.id })
  const submitter = await fresh(false)
  const result = await helpers.callHost(submitter, '/host/software/addon-services/action', body, true)
  if (!object(result) || !object(result.job) || typeof result.job.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(result.job.id) || result.job.kind !== 'software.addon.' + body.action) return fail('SERVICE_UNAVAILABLE', 'the protected host response could not be verified', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  const after = await fresh(true)
  try { await helpers.emitAudit({ actor: after.principal.username, action: 'server.addon_service.job_submitted', target: service.unit, detail: { action: body.action, jobId: result.job.id }, outcome: 'ok', principalId: after.principal.id }) }
  catch { return fail('SERVICE_UNAVAILABLE', 'service job submission requires audit review', { stateChanged: true, unknownOutcome: true, verificationRequired: true }) }
  return json(202, { job: result.job })
}
