import { randomUUID } from 'node:crypto'
import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

export interface TerminalWorkspaceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  /** Fresh re-authentication of the current root with the supplied password; true only on an exact Argon2id match. */
  verifyPassword: (caller: AuthenticatedCaller, password: string) => Promise<boolean>
  /** Lockout gate shared with sign-in; returns a lockedUntil ISO timestamp when the principal/ip is locked. */
  checkLockout?: (caller: AuthenticatedCaller) => Promise<string | null>
  /** Records a failed re-authentication against the shared lockout counter. */
  recordFailure?: (caller: AuthenticatedCaller) => Promise<void>
  now?: () => Date
}

const ROUTE = '/api/server/terminal'
const unchanged = { stateChanged: false }
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

/** No qualified root PTY execution contract exists; command execution is truthfully unavailable, never faked. */
const EXECUTION = { state: 'unavailable', reason: 'no_qualified_root_terminal_execution_path' } as const

/**
 * Server (root) terminal. Opening a session requires a fresh root re-authentication and is audited; command
 * execution is reported unavailable because no reviewed root execution path exists. Nothing is ever run from here.
 */
export async function handleTerminalWorkspaceRoute(request: Request, url: URL, method: string, helpers: TerminalWorkspaceHelpers): Promise<Response | null> {
  if (url.pathname !== ROUTE) return null
  const action = method === 'POST' ? 'server.terminal.open' : 'server.terminal.read'
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  if (url.search) return fail('VALIDATION', 'the server terminal accepts no selectors', unchanged)
  // A bearer token or a non-interactive session can never open a root terminal.
  if (caller.sessionId === null || caller.apiTokenId !== null) return fail('FORBIDDEN', 'the server terminal requires the signed-in interactive session', unchanged)

  if (method === 'GET') {
    if (request.body) return fail('VALIDATION', 'the capability read accepts no body', unchanged)
    await helpers.assertRoot(await helpers.requireCaller(request), action)
    return json(200, { capability: { reauthentication: 'required', audit: 'enabled' }, execution: EXECUTION })
  }
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } })
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', unchanged)
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > 4096) return fail('VALIDATION', 'the request body is too large', unchanged)
  let body: unknown
  try { body = JSON.parse(text) } catch { return fail('VALIDATION', 'request body is not valid JSON', unchanged) }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join() !== 'password' || typeof (body as Record<string, unknown>).password !== 'string' || !(body as Record<string, unknown>).password) return fail('VALIDATION', 'the current password is required to open a server terminal', unchanged)
  const password = (body as { password: string }).password

  if (helpers.checkLockout) { const until = await helpers.checkLockout(caller); if (until) return fail('FORBIDDEN', 'too many failed authentication attempts', { ...unchanged, lockedOut: true, lockedUntil: until }) }
  // Re-check the principal immediately before and after the password check so a revoked session cannot open a terminal.
  const fresh = await helpers.requireCaller(request)
  await helpers.assertRoot(fresh, action)
  if (fresh.principal.id !== caller.principal.id || fresh.sessionId !== caller.sessionId) return fail('FORBIDDEN', 'the terminal session authority changed', unchanged)
  if (!await helpers.verifyPassword(fresh, password)) {
    if (helpers.recordFailure) await helpers.recordFailure(fresh)
    await helpers.emitAudit({ actor: fresh.principal.username, principalId: fresh.principal.id, action: 'server.terminal.reauthentication_failed', target: 'server:terminal', detail: {}, outcome: 'denied' }).catch(() => undefined)
    return fail('UNAUTHENTICATED', 'the current password is incorrect', unchanged)
  }
  const after = await helpers.requireCaller(request)
  await helpers.assertRoot(after, action)
  if (after.principal.id !== fresh.principal.id || after.sessionId !== fresh.sessionId) return fail('FORBIDDEN', 'the terminal session authority changed', unchanged)
  const sessionId = randomUUID(), openedAt = (helpers.now ?? (() => new Date()))().toISOString()
  try { await helpers.emitAudit({ actor: after.principal.username, principalId: after.principal.id, action: 'server.terminal.session_opened', target: 'server:terminal', detail: { sessionId }, outcome: 'ok' }) }
  catch { return fail('SERVICE_UNAVAILABLE', 'the terminal session could not be audited, so it was not opened', { stateChanged: true, verificationRequired: true }) }
  return json(201, { session: { id: sessionId, openedAt }, execution: EXECUTION })
}
