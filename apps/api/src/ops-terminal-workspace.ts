import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import type { TerminalRegistry, TerminalTickets } from './terminal-sessions.ts'

/** Host terminal capability, read from the agent: available only with a verified PTY helper. */
export type TerminalExecution =
  | { state: 'available'; idleTimeoutSeconds: number; absoluteTimeoutSeconds: number; maxInputBytes: number }
  | { state: 'unavailable'; reason: string }

export interface TerminalWorkspaceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  /** Fresh re-authentication of the current root with the supplied password; true only on an exact Argon2id match. */
  verifyPassword: (caller: AuthenticatedCaller, password: string) => Promise<boolean>
  /** True only when the admin has enrolled a second factor and MFA is not disabled; enrollment is never forced. */
  secondFactorEnrolled: (caller: AuthenticatedCaller) => boolean
  /** Verifies and consumes one TOTP step of an enrolled admin. */
  verifySecondFactor: (caller: AuthenticatedCaller, code: string) => Promise<boolean>
  /** Lockout gate shared with sign-in; returns a lockedUntil ISO timestamp when the principal/ip is locked. */
  checkLockout?: (caller: AuthenticatedCaller) => Promise<string | null>
  /** Records a failed re-authentication against the shared lockout counter. */
  recordFailure?: (caller: AuthenticatedCaller) => Promise<void>
  readExecution: (caller: AuthenticatedCaller) => Promise<TerminalExecution>
  tickets: TerminalTickets
  registry: TerminalRegistry
}

const ROUTE = '/api/server/terminal'
const unchanged = { stateChanged: false }
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

/**
 * Server (root) terminal. A session needs a fresh password re-authentication (plus the second factor when the
 * admin enrolled one); the reply is a short single-use ticket bound to this panel session and page origin, spent
 * by the terminal socket. Start and stop of the shell are audited by the socket bridge.
 */
export async function handleTerminalWorkspaceRoute(request: Request, url: URL, method: string, helpers: TerminalWorkspaceHelpers): Promise<Response | null> {
  if (url.pathname !== ROUTE) return null
  const action = method === 'GET' ? 'server.terminal.read' : method === 'DELETE' ? 'server.terminal.close' : 'server.terminal.open'
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  if (url.search) return fail('VALIDATION', 'the server terminal accepts no selectors', unchanged)
  // A bearer token, a team member or a handed-off session can never open a root terminal.
  if (caller.sessionId === null || caller.apiTokenId !== null || caller.team || caller.impersonator) return fail('FORBIDDEN', 'the server terminal requires the signed-in interactive session', unchanged)

  if (method === 'GET') {
    if (request.body) return fail('VALIDATION', 'the capability read accepts no body', unchanged)
    return json(200, {
      capability: { reauthentication: 'required', secondFactor: helpers.secondFactorEnrolled(caller) ? 'required' : 'not_enrolled', audit: 'enabled' },
      execution: await helpers.readExecution(caller),
      session: { open: helpers.registry.has(caller.principal.id) },
    })
  }
  if (method === 'DELETE') return json(200, { closed: helpers.registry.close(caller.principal.id) })
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST, DELETE' } })
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', unchanged)
  const origin = request.headers.get('origin')
  if (!origin) return fail('FORBIDDEN', 'the terminal request must come from the panel page', unchanged)
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > 4096) return fail('VALIDATION', 'the request body is too large', unchanged)
  let body: unknown
  try { body = JSON.parse(text) } catch { return fail('VALIDATION', 'request body is not valid JSON', unchanged) }
  const fields = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
  if (!fields || Object.keys(fields).some(key => key !== 'password' && key !== 'totpCode') || typeof fields.password !== 'string' || !fields.password
    || (fields.totpCode !== undefined && (typeof fields.totpCode !== 'string' || !/^[0-9]{6}$/.test(fields.totpCode)))) return fail('VALIDATION', 'the current password is required to open a server terminal', unchanged)
  const password = fields.password, totpCode = fields.totpCode as string | undefined

  const execution = await helpers.readExecution(caller)
  if (execution.state !== 'available') return fail('PRECONDITION_FAILED', 'terminal sessions are unavailable on this server', { ...unchanged, reason: execution.reason })
  if (helpers.registry.has(caller.principal.id)) return fail('CONFLICT', 'a terminal session is already open; close it first', unchanged)
  if (helpers.checkLockout) { const until = await helpers.checkLockout(caller); if (until) return fail('FORBIDDEN', 'too many failed authentication attempts', { ...unchanged, lockedOut: true, lockedUntil: until }) }
  // Re-check the principal immediately before and after the password check so a revoked session cannot open a terminal.
  const fresh = await helpers.requireCaller(request)
  await helpers.assertRoot(fresh, action)
  if (fresh.principal.id !== caller.principal.id || fresh.sessionId !== caller.sessionId) return fail('FORBIDDEN', 'the terminal session authority changed', unchanged)
  const denied = async (message: string, secondFactor: boolean): Promise<never> => {
    if (helpers.recordFailure) await helpers.recordFailure(fresh)
    await helpers.emitAudit({ actor: fresh.principal.username, principalId: fresh.principal.id, action: 'server.terminal.reauthentication_failed', target: 'server:terminal', detail: { factor: secondFactor ? 'totp' : 'password' }, outcome: 'denied' }).catch(() => undefined)
    return fail('UNAUTHENTICATED', message, { ...unchanged, ...(secondFactor ? { secondFactor: 'invalid' } : {}) })
  }
  if (!await helpers.verifyPassword(fresh, password)) return denied('the current password is incorrect', false)
  if (helpers.secondFactorEnrolled(fresh)) {
    if (!totpCode) return fail('UNAUTHENTICATED', 'the two-factor code is required', { ...unchanged, secondFactor: 'required' })
    if (!await helpers.verifySecondFactor(fresh, totpCode)) return denied('the two-factor code is incorrect', true)
  }
  const after = await helpers.requireCaller(request)
  await helpers.assertRoot(after, action)
  if (after.principal.id !== fresh.principal.id || after.sessionId !== fresh.sessionId) return fail('FORBIDDEN', 'the terminal session authority changed', unchanged)
  const ticket = helpers.tickets.issue({ kind: 'root', principalId: after.principal.id, actor: after.principal.username, panelSessionId: after.sessionId!, origin, accountId: null, accountUsername: null })
  return json(201, { ticket, execution })
}
