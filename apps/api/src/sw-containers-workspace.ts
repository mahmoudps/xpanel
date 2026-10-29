import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { readSwContainerEngineView, readSwContainersView } from '../../../packages/os/src/sw-container-command.ts'

export interface SwContainersWorkspaceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  /** Authenticated agent transport; refusals arrive as XpanelError with their outcome detail. */
  callHost: (caller: AuthenticatedCaller, path: string, input?: unknown, mutation?: boolean) => Promise<unknown>
}
const ROUTES: Readonly<Record<string, 'read' | 'engine' | 'action'>> = { '/api/server/software/containers': 'read', '/api/server/software/containers/engine': 'engine', '/api/server/software/containers/action': 'action' }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

/** Root-only container engine workspace. Commands, images and paths are never caller inputs. */
export async function handleSwContainersWorkspaceRoute(request: Request, url: URL, method: string, helpers: SwContainersWorkspaceHelpers): Promise<Response | null> {
  const operation = ROUTES[url.pathname]
  if (!operation) return null
  const action = 'server.containers.' + operation, caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  const expected = operation === 'action' ? 'POST' : 'GET'
  if (method !== expected) return new Response(null, { status: 405, headers: { allow: expected } })
  if (url.search) return fail('VALIDATION', 'container requests do not accept selectors', { stateChanged: false })
  const fresh = async (mutation: boolean): Promise<AuthenticatedCaller> => {
    const current = await helpers.requireCaller(request)
    await helpers.assertRoot(current, action)
    if (current.principal.id !== caller.principal.id) return fail('FORBIDDEN', 'container authority changed', mutation ? { stateChanged: true, verificationRequired: true } : { stateChanged: false })
    return current
  }
  if (operation !== 'action') {
    const raw = await helpers.callHost(caller, operation === 'read' ? '/host/software/containers' : '/host/software/containers/engine')
    let view: unknown
    try { view = operation === 'read' ? readSwContainersView(raw) : readSwContainerEngineView(raw) } catch { return fail('PRECONDITION_FAILED', 'the protected host response could not be verified', { stateChanged: false }) }
    await fresh(false)
    return json(200, view)
  }
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', { stateChanged: false })
  const text = await request.text()
  let body: unknown
  try { body = text.length <= 1024 ? JSON.parse(text) : null } catch { body = null }
  if (!object(body) || Object.keys(body).sort().join() !== 'action,containerId,engine,expectedRevision' || !['podman', 'docker'].includes(String(body.engine)) || typeof body.containerId !== 'string' || !/^[0-9a-f]{64}$/.test(body.containerId)
    || !['start', 'stop', 'restart'].includes(String(body.action)) || typeof body.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedRevision)) return fail('VALIDATION', 'an engine, one observed full container id, start/stop/restart and the observed revision are required', { stateChanged: false })
  const target = 'container:' + body.engine + ':' + body.containerId.slice(0, 12)
  await helpers.emitAudit({ actor: caller.principal.username, action: 'server.container.change_requested', target, detail: { action: body.action }, outcome: 'ok', principalId: caller.principal.id })
  const submitter = await fresh(false)
  const result = await helpers.callHost(submitter, '/host/software/containers/action', body, true)
  if (!object(result) || !object(result.job) || typeof result.job.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(result.job.id) || result.job.kind !== 'software.container.' + body.action) return fail('SERVICE_UNAVAILABLE', 'the protected host response could not be verified', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  const after = await fresh(true)
  try { await helpers.emitAudit({ actor: after.principal.username, action: 'server.container.job_submitted', target, detail: { action: body.action, jobId: result.job.id }, outcome: 'ok', principalId: after.principal.id }) }
  catch { return fail('SERVICE_UNAVAILABLE', 'container job submission requires audit review', { stateChanged: true, unknownOutcome: true, verificationRequired: true }) }
  return json(202, { job: result.job })
}
