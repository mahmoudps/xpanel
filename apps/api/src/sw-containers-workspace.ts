import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { readCtrOpRequest, readCtrView } from '../../../packages/os/src/ctr-view.ts'
import type { CtrOpRequest, CtrViewKind } from '../../../packages/os/src/ctr-view.ts'
import { readSwContainerEngineView, readSwContainersView } from '../../../packages/os/src/sw-container-command.ts'

export interface SwContainersWorkspaceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  /** Authenticated agent transport; refusals arrive as XpanelError with their outcome detail. */
  callHost: (caller: AuthenticatedCaller, path: string, input?: unknown, mutation?: boolean) => Promise<unknown>
  /** The agent's own response, unread, for a stream that stays open. */
  streamHost: (caller: AuthenticatedCaller, path: string) => Promise<Response>
}
const ROUTES: Readonly<Record<string, 'read' | 'engine' | 'action'>> = { '/api/server/software/containers': 'read', '/api/server/software/containers/engine': 'engine', '/api/server/software/containers/action': 'action' }
const CTR_READS: Readonly<Record<string, { kind: CtrViewKind; selectors: readonly string[] }>> = {
  '/api/server/software/containers/accounts': { kind: 'accounts', selectors: [] }, '/api/server/software/containers/scope': { kind: 'scope', selectors: ['account'] },
  '/api/server/software/containers/detail': { kind: 'detail', selectors: ['account', 'engine', 'id'] }, '/api/server/software/containers/stack-logs': { kind: 'logs', selectors: ['account', 'stack'] },
  '/api/server/software/containers/search': { kind: 'search', selectors: ['account', 'registry', 'term'] },
}
const CTR_POLICY = '/api/server/software/containers/policy', CTR_OP = '/api/server/software/containers/op', CTR_CATALOG = '/api/server/software/containers/catalog', CTR_STREAM = '/api/server/software/containers/log-stream'
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const unknownOutcome = { stateChanged: true, unknownOutcome: true, verificationRequired: true }

/** Root-only rootless workspace: accounts, stores, stacks, the trust policy and the operations the agent reviews. */
async function handleCtrWorkspaceRoute(request: Request, url: URL, method: string, helpers: SwContainersWorkspaceHelpers): Promise<Response | null> {
  const read = CTR_READS[url.pathname], policy = url.pathname === CTR_POLICY, operation = url.pathname === CTR_OP, catalog = url.pathname === CTR_CATALOG, stream = url.pathname === CTR_STREAM
  if (!read && !policy && !operation && !catalog && !stream) return null
  const action = 'server.containers.' + (read?.kind ?? (policy ? 'policy' : catalog ? 'catalog' : stream ? 'stream' : 'op')), caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  const expected = operation || catalog ? ['POST'] : policy ? ['GET', 'POST'] : ['GET']
  if (!expected.includes(method)) return new Response(null, { status: 405, headers: { allow: expected.join(', ') } })
  const fresh = async (mutation: boolean): Promise<AuthenticatedCaller> => {
    const current = await helpers.requireCaller(request)
    await helpers.assertRoot(current, action)
    if (current.principal.id !== caller.principal.id) return fail('FORBIDDEN', 'container authority changed', mutation ? { stateChanged: true, verificationRequired: true } : { stateChanged: false })
    return current
  }
  const verified = (kind: CtrViewKind, raw: unknown): unknown => { try { return readCtrView(kind, raw) } catch { return fail('PRECONDITION_FAILED', 'the protected host response could not be verified', { stateChanged: false }) } }
  if (stream) {
    for (const key of url.searchParams.keys()) if (!['account', 'engine', 'id', 'stack'].includes(key)) return fail('VALIDATION', 'this selector is not accepted', { stateChanged: false })
    const response = await helpers.streamHost(caller, '/host' + url.pathname.slice('/api/server'.length) + url.search)
    if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('application/x-ndjson')) { await response.body?.cancel().catch(() => undefined); return fail('PRECONDITION_FAILED', 'the live log could not be opened', { stateChanged: false }) }
    await fresh(false)
    return new Response(response.body, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } })
  }
  if (method === 'GET') {
    const kind = read?.kind ?? 'policy', selectors = read?.selectors ?? []
    for (const key of url.searchParams.keys()) if (!selectors.includes(key)) return fail('VALIDATION', 'this selector is not accepted', { stateChanged: false })
    const view = verified(kind, await helpers.callHost(caller, '/host' + url.pathname.slice('/api/server'.length) + url.search))
    await fresh(false)
    return json(200, view)
  }
  if (url.search) return fail('VALIDATION', 'container requests do not accept selectors', { stateChanged: false })
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', { stateChanged: false })
  const text = await request.text()
  if (text.length > (policy || catalog ? 4 * 1024 * 1024 : 100_000)) return fail('VALIDATION', 'the request is too large', { stateChanged: false })
  let body: unknown
  try { body = JSON.parse(text) } catch { return fail('VALIDATION', 'request body must be valid JSON', { stateChanged: false }) }
  if (catalog) {
    if (!object(body) || Object.keys(body).sort().join() !== 'envelope,url') return fail('VALIDATION', 'one signed envelope or one feed URL is required', { stateChanged: false })
    const submitter = await fresh(false)
    const view = verified('policy', await helpers.callHost(submitter, '/host/software/containers/catalog', body, true))
    const after = await fresh(true)
    await helpers.emitAudit({ actor: after.principal.username, action: 'server.container.catalog_imported', target: 'containers', detail: {}, outcome: 'ok', principalId: after.principal.id })
    return json(200, view)
  }
  if (policy) {
    if (!object(body) || Object.keys(body).sort().join() !== 'expectedRevision,policy') return fail('VALIDATION', 'the observed revision and a policy are required', { stateChanged: false })
    const submitter = await fresh(false)
    const view = verified('policy', await helpers.callHost(submitter, '/host/software/containers/policy', body, true))
    const after = await fresh(true)
    await helpers.emitAudit({ actor: after.principal.username, action: 'server.container.policy_saved', target: 'containers', detail: {}, outcome: 'ok', principalId: after.principal.id })
    return json(200, view)
  }
  let input: CtrOpRequest
  try { input = readCtrOpRequest(body) } catch { return fail('VALIDATION', 'the container operation is invalid', { stateChanged: false }) }
  const op = input.action.op, target = 'account:' + input.account
  await helpers.emitAudit({ actor: caller.principal.username, action: 'server.container.' + op, target, detail: {}, outcome: 'ok', principalId: caller.principal.id })
  const submitter = await fresh(false)
  const result = await helpers.callHost(submitter, '/host/software/containers/op', body, true)
  if (!object(result) || object(result.job) && (typeof result.job.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(result.job.id) || typeof result.job.kind !== 'string' || !result.job.kind.startsWith('software.container.'))) return fail('SERVICE_UNAVAILABLE', 'the protected host response could not be verified', unknownOutcome)
  await fresh(true)
  return json(object(result.job) ? 202 : 200, result)
}

/** Root-only container engine workspace. Commands, images and paths are never caller inputs. */
export async function handleSwContainersWorkspaceRoute(request: Request, url: URL, method: string, helpers: SwContainersWorkspaceHelpers): Promise<Response | null> {
  const workspace = await handleCtrWorkspaceRoute(request, url, method, helpers)
  if (workspace) return workspace
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
