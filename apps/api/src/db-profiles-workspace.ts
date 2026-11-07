import { fail, isXpanelError } from '@xpanel/core'
import { DB_LOCAL_PROFILE, DB_PROFILE_NAME, parseDbProfileInput } from '../../agent/src/db-profiles.ts'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

export const DB_PROFILES_ROUTE = '/api/server/db-profiles'
export interface DbProfilesWorkspaceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot'> {
  /** Protected agent transport; a body sends a POST. Absent when no host agent is connected. */
  callHost?: (caller: AuthenticatedCaller, path: string, body?: unknown) => Promise<unknown>
}
const unchanged = { stateChanged: false }
const invalid = (message: string): never => fail('VALIDATION', message, unchanged)
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const iso = (value: unknown): boolean => typeof value === 'string' && value.length <= 40
const same = (left: AuthenticatedCaller, right: AuthenticatedCaller): boolean => left.principal.id === right.principal.id && left.sessionId === right.sessionId && left.apiTokenId === right.apiTokenId

/** A listing is projected field by field, so nothing the agent adds later can reach a browser by accident. */
export function projectDbProfiles(raw: unknown) {
  const bad = (): never => fail('SERVICE_UNAVAILABLE', 'the database profiles could not be verified', { stateChanged: false, verificationRequired: true })
  if (!object(raw) || typeof raw.active !== 'string' || !Array.isArray(raw.profiles) || raw.profiles.length > 16) return bad()
  return { active: raw.active, localProfile: DB_LOCAL_PROFILE, profiles: raw.profiles.map(item => {
    if (!object(item) || typeof item.name !== 'string' || !DB_PROFILE_NAME.test(item.name) || typeof item.host !== 'string' || typeof item.port !== 'number' || typeof item.user !== 'string' || typeof item.description !== 'string' || !iso(item.createdAt) || !iso(item.updatedAt)) return bad()
    const check = item.validation
    if (check !== null && !(object(check) && ['passed', 'failed'].includes(String(check.state)) && iso(check.at))) return bad()
    return { name: item.name, host: item.host, port: item.port, user: item.user, description: item.description, createdAt: item.createdAt, updatedAt: item.updatedAt,
      validation: check ? { state: check.state, reason: check.reason ?? null, version: check.version ?? null, clientHost: check.clientHost ?? null, at: check.at } : null }
  }) }
}

/** Root-only WHM Manage MySQL Profiles. The API holds no credential: a password passes through once, to the agent's option file. */
export async function handleDbProfilesWorkspaceRoute(request: Request, url: URL, method: string, helpers: DbProfilesWorkspaceHelpers): Promise<Response | null> {
  if (url.pathname !== DB_PROFILES_ROUTE && !url.pathname.startsWith(DB_PROFILES_ROUTE + '/')) return null
  const action = 'server.db-profiles.' + (method === 'GET' ? 'read' : 'update')
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  if (url.search) return invalid('database profiles accept no selectors')
  const callHost = helpers.callHost
  if (!callHost) return fail('PRECONDITION_FAILED', 'database profiles need the host agent', { ...unchanged, reason: 'host_agent_unavailable' })
  const fresh = async (): Promise<AuthenticatedCaller> => { const current = await helpers.requireCaller(request); await helpers.assertRoot(current, action); return same(caller, current) ? current : fail('FORBIDDEN', 'root authorization changed', unchanged) }
  const run = async (path: string, body: unknown): Promise<Response> => {
    try { return json(projectDbProfiles(await callHost(await fresh(), path, body))) }
    // The stable reason (IN_USE, PROFILE_INVALID, PROFILE_HAS_DATABASES) travels on; the agent's words stay with the agent.
    catch (error) { if (isXpanelError(error) && error.detail.reason) return fail(error.code, error.message, error.detail); throw error }
  }
  const tail = url.pathname.slice(DB_PROFILES_ROUTE.length).replace(/^\//, ''), match = /^([^/]+)(?:\/(validate|activate))?$/.exec(tail)
  const bodyOf = async (): Promise<unknown> => {
    if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return invalid('application/json is required')
    const raw = await request.text()
    try { return raw.length <= 16 * 1024 ? JSON.parse(raw) : invalid('the request is too large') } catch { return invalid('the request is not JSON') }
  }
  if (tail === '') {
    if (method === 'GET') return json(projectDbProfiles(await callHost(caller, '/host/db-profiles')))
    if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } })
    return run('/host/db-profiles/save', parseDbProfileInput(await bodyOf()))
  }
  if (!match) return fail('NOT_FOUND', 'route not found', unchanged)
  const name = decodeURIComponent(match[1]!)
  if (!DB_PROFILE_NAME.test(name)) return invalid('the profile name is not valid')
  if (match[2]) {
    if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
    return run('/host/db-profiles/' + match[2], { name })
  }
  if (method === 'DELETE') return run('/host/db-profiles/delete', { name })
  if (method !== 'PUT') return new Response(null, { status: 405, headers: { allow: 'PUT, DELETE' } })
  const input = parseDbProfileInput(await bodyOf())
  if (input.name !== name) return invalid('a profile name cannot change')
  return run('/host/db-profiles/save', input)
}
