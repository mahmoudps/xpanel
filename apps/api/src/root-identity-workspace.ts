import { fail, isXpanelError } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { assertOwnSession, bodyOf, invalid, json, object, reauthenticate, unchanged } from './identity-http.ts'
import type { ReauthenticationPorts } from './identity-http.ts'
import { assertPasswordAllowed } from './password-policy.ts'

/**
 * WHM Change Root Password (the system superuser's password, as SSH and su use it) and Manage Wheel/Sudo Group
 * Users. Both are root only and audited before and after; the agent performs and reads back each host change.
 */
export interface RootIdentityHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'>, Omit<ReauthenticationPorts, 'requireCaller' | 'emitAudit'> {
  /** Protected agent transport; a body sends a POST mutation. Absent when no host agent is connected. */
  callHost?: (caller: AuthenticatedCaller, path: string, body?: Record<string, unknown>) => Promise<unknown>
}

const ROOT_PASSWORD = '/api/server/root-password', ADMIN_GROUP = '/api/server/sec/admin-group'
const USER = /^[a-z][a-z0-9]{0,15}$/
const unverified = (): never => fail('SERVICE_UNAVAILABLE', 'the host answer could not be verified', { stateChanged: false, verificationRequired: true })

export function projectAdminGroupObservation(value: unknown): unknown {
  if (!object(value) || typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt)) || typeof value.family !== 'string' || value.family.length > 32
    || !(value.group === null || value.group === 'wheel' || value.group === 'sudo') || !['read', 'group_missing', 'unsupported'].includes(value.state as string)
    || !Array.isArray(value.members) || value.members.length > 5000 || !Array.isArray(value.accounts) || value.accounts.length > 10000) return unverified()
  // Non-account members can carry any system user name; they are shown, never changed.
  const members = value.members.map(item => object(item) && typeof item.username === 'string' && /^[A-Za-z0-9._-][A-Za-z0-9._$-]{0,63}$/.test(item.username) && typeof item.account === 'boolean' ? { username: item.username, account: item.account } : unverified())
  const accounts = value.accounts.map(item => object(item) && typeof item.username === 'string' && USER.test(item.username) && typeof item.member === 'boolean' ? { username: item.username, member: item.member } : unverified())
  return { observedAt: value.observedAt, family: value.family, group: value.group, state: value.state, members, accounts }
}

export async function handleRootIdentityWorkspaceRoute(request: Request, url: URL, method: string, helpers: RootIdentityHelpers): Promise<Response | null> {
  if (url.pathname !== ROOT_PASSWORD && url.pathname !== ADMIN_GROUP) return null
  const allowed = ['GET', 'POST']
  if (!allowed.includes(method)) return new Response(null, { status: 405, headers: { allow: allowed.join(', ') } })
  const password = url.pathname === ROOT_PASSWORD
  const action = password ? (method === 'GET' ? 'server.root_password.read' : 'server.root_password.change') : method === 'GET' ? 'server.sec.admin_group.read' : 'server.sec.admin_group.update'
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  if (url.search) return invalid('this workspace accepts no selectors')
  if (password) return rootPassword(request, method, caller, helpers)

  if (method === 'GET') {
    if (!helpers.callHost) return json({ observation: null, reason: 'host_agent_unavailable' })
    try { return json({ observation: projectAdminGroupObservation(await helpers.callHost(caller, '/host/identity/admin-group')), reason: null }) }
    catch (error) { return json({ observation: null, reason: isXpanelError(error) && error.code === 'PRECONDITION_FAILED' ? 'host_unavailable' : 'observation_unverified' }) }
  }
  const body = await bodyOf(request, 512, ['action', 'username'], ['action', 'username'])
  if (body.action !== 'add' && body.action !== 'remove') return invalid('action must be add or remove')
  if (typeof body.username !== 'string' || !USER.test(body.username)) return invalid('a hosting account username is required')
  if (!helpers.callHost) return fail('PRECONDITION_FAILED', 'group changes need the host agent', { ...unchanged, reason: 'host_agent_unavailable' })
  const target = 'system-group:admin', detail = { action: body.action, username: body.username }
  await helpers.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action: 'server.sec.admin_group.change_requested', target, outcome: 'ok', detail })
  let result: unknown
  try { result = await helpers.callHost(caller, '/host/identity/admin-group', { action: body.action, username: body.username }) }
  catch (error) {
    await helpers.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action: 'server.sec.admin_group.changed', target, outcome: 'failed', detail }).catch(() => undefined)
    throw error
  }
  const outcome = object(result) && (result.outcome === 'applied' || result.outcome === 'unchanged') ? result.outcome : null
  if (!outcome) return fail('SERVICE_UNAVAILABLE', 'the group change requires review', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
  const observation = projectAdminGroupObservation((result as Record<string, unknown>).observation)
  await helpers.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action: 'server.sec.admin_group.changed', target, outcome: 'ok', detail: { ...detail, outcome } })
  return json({ outcome, observation })
}

async function rootPassword(request: Request, method: string, caller: AuthenticatedCaller, helpers: RootIdentityHelpers): Promise<Response> {
  assertOwnSession(caller)
  if (method === 'GET') return json({
    capability: { reauthentication: 'required', secondFactor: helpers.secondFactorEnrolled?.(caller) ? 'required' : 'not_enrolled', audit: 'enabled' },
    host: helpers.callHost ? 'connected' : 'unavailable',
  })
  if (!request.headers.get('origin')) return fail('FORBIDDEN', 'the root password must be changed from the panel page', unchanged)
  const body = await bodyOf(request, 4096, ['confirmation', 'currentPassword', 'password', 'totpCode'], ['confirmation', 'currentPassword', 'password'])
  if (typeof body.password !== 'string' || Buffer.byteLength(body.password, 'utf8') > 1024 || /[\u0000-\u001f\u007f]/.test(body.password)) return invalid('the new password must be one line of at most 1024 bytes')
  if (body.confirmation !== body.password) return fail('VALIDATION', 'the confirmation does not match the new password', { ...unchanged, reason: 'confirmation_mismatch' })
  assertPasswordAllowed(body.password, 'panel')
  if (!helpers.callHost) return fail('PRECONDITION_FAILED', 'changing the root password needs the host agent', { ...unchanged, reason: 'host_agent_unavailable' })
  const fresh = await reauthenticate(request, caller, helpers, { password: body.currentPassword, totpCode: body.totpCode, action: 'root_password', secondFactor: true })
  const target = 'system-user:root'
  await helpers.emitAudit({ actor: fresh.principal.username, principalId: fresh.principal.id, action: 'server.root_password.change_requested', target, outcome: 'ok' })
  let result: unknown
  try { result = await helpers.callHost(fresh, '/host/identity/root-password', { password: body.password }) }
  catch (error) {
    await helpers.emitAudit({ actor: fresh.principal.username, principalId: fresh.principal.id, action: 'server.root_password.changed', target, outcome: 'failed' }).catch(() => undefined)
    throw error
  }
  if (!object(result) || result.outcome !== 'applied' || typeof result.scheme !== 'string' || !/^[0-9a-z]{1,8}$/.test(result.scheme)) return fail('SERVICE_UNAVAILABLE', 'the root password change requires review', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
  await helpers.emitAudit({ actor: fresh.principal.username, principalId: fresh.principal.id, action: 'server.root_password.changed', target, outcome: 'ok', detail: { scheme: result.scheme } })
  return json({ outcome: 'applied', scheme: result.scheme })
}
