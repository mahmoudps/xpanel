import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { exactKeys, panelJson, readLimitedBody } from './panel-config-file.ts'

/** Root's list of installed applications, its update and uninstall jobs, and the upload of signed releases; the agent decides each write. */
export interface SiteSoftwareInstanceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot'> {
  callHost?: (caller: AuthenticatedCaller, path: string, body?: unknown) => Promise<unknown>
}
const unchanged = { stateChanged: false }
const CHUNK_BODY_BYTES = 1024 * 1024
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ROUTES: Record<string, { method: string; agent: string; action: string }> = {
  '/api/server/site-software/instances': { method: 'GET', agent: '/host/site-software/instances', action: 'server.site_software.read' },
  '/api/server/site-software/instances/jobs': { method: 'POST', agent: '/host/site-software/instances/jobs', action: 'server.site_software.update' },
  '/api/server/site-software/artifacts': { method: 'POST', agent: '/host/site-software/artifacts', action: 'server.site_software.update' },
}

const readRow = (value: unknown): Record<string, unknown> | null => {
  if (!object(value) || typeof value.username !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(value.username) || typeof value.accountId !== 'string' || !UUID.test(value.accountId) || typeof value.domainId !== 'string' || !UUID.test(value.domainId)
    || typeof value.domain !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,252}$/.test(value.domain) || typeof value.path !== 'string' || value.path.length > 240 || typeof value.appId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value.appId)
    || typeof value.version !== 'string' || !/^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$/.test(value.version) || !(value.previousVersion === null || typeof value.previousVersion === 'string' && /^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$/.test(value.previousVersion))
    || !(value.database === null || typeof value.database === 'string' && /^[a-z0-9_]{1,64}$/.test(value.database)) || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt)) || typeof value.revision !== 'string' || !/^[0-9a-f]{64}$/.test(value.revision) || typeof value.accountStatus !== 'string') return null
  const { username, accountId, domainId, domain, path, appId, version, previousVersion, database, updatedAt, revision, accountStatus } = value
  return { username, accountId, domainId, domain, path, appId, version, previousVersion, database, updatedAt, revision, accountStatus }
}

export async function handleSiteSoftwareInstancesApiRoute(request: Request, url: URL, method: string, helpers: SiteSoftwareInstanceHelpers): Promise<Response | null> {
  if (!Object.hasOwn(ROUTES, url.pathname)) return null
  const route = ROUTES[url.pathname]!
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, route.action)
  if (method !== route.method) return new Response(null, { status: 405, headers: { allow: route.method } })
  if (url.search) return fail('VALIDATION', 'site software accepts no query selectors', unchanged)
  if (!helpers.callHost) return fail('PRECONDITION_FAILED', 'site software needs the host agent', { ...unchanged, reason: 'host_agent_unavailable' })
  if (method === 'GET') {
    const reply = await helpers.callHost(caller, route.agent)
    const rows = object(reply) && Array.isArray(reply.instances) ? reply.instances.map(readRow) : null
    if (!rows || rows.some(row => row === null)) return fail('PRECONDITION_FAILED', 'the installed applications could not be verified', unchanged)
    return panelJson({ instances: rows })
  }
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', unchanged)
  let body: unknown
  try { body = JSON.parse(Buffer.from(await readLimitedBody(request, CHUNK_BODY_BYTES)).toString('utf8')) } catch (error) { if (error instanceof Error && 'code' in error) throw error; return fail('VALIDATION', 'request body is not valid JSON', unchanged) }
  if (!object(body)) return fail('VALIDATION', 'request body must be a JSON object', unchanged)
  if (url.pathname.endsWith('/artifacts')) {
    if (!exactKeys(body, ['appId', 'version', 'offset', 'contentBase64'])) return fail('VALIDATION', 'exactly appId, version, offset and contentBase64 are required', unchanged)
    const reply = await helpers.callHost(caller, route.agent, body)
    if (!object(reply) || !Number.isSafeInteger(reply.received) || typeof reply.complete !== 'boolean' || !Number.isSafeInteger(reply.bytes)) return fail('SERVICE_UNAVAILABLE', 'the upload could not be verified; read the catalog before retrying', { stateChanged: true, verificationRequired: true })
    return panelJson({ received: reply.received, complete: reply.complete, bytes: reply.bytes })
  }
  if (!exactKeys(body, ['username', 'domainId', 'path', 'action', 'expectedRecord', ...(body.action === 'update' ? ['version'] : [])])) return fail('VALIDATION', 'choose one listed installation and an update or removal', unchanged)
  const reply = await helpers.callHost(caller, route.agent, body)
  const job = object(reply) && object(reply.job) ? reply.job : null
  if (!job || typeof job.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(job.id) || job.kind !== 'application.' + body.action) return fail('SERVICE_UNAVAILABLE', 'the application job could not be verified', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  return new Response(JSON.stringify({ job }), { status: 202, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}
