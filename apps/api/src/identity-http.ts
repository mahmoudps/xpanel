import { createHash } from 'node:crypto'
import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { isMailboxPrincipalUsername } from './entry-points.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

/** Shared request plumbing of the identity workspaces (security questions, external sign-in, root password). */

export const unchanged = { stateChanged: false } as const
export const invalid = (message: string): never => fail('VALIDATION', message, unchanged)
export const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export const json = (value: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } })
export const revisionOf = (value: unknown): string => createHash('sha256').update(JSON.stringify(value ?? null), 'utf8').digest('hex')
export const expectedRevision = (value: unknown): string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : invalid('the observed revision is required')

/** A bounded JSON object body with exactly the allowed keys (all optional unless required lists them). */
export async function bodyOf(request: Request, limit: number, allowed: readonly string[], required: readonly string[] = []): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return invalid('application/json is required')
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > limit) return invalid('the request body is too large')
  let value: unknown
  try { value = JSON.parse(text) } catch { return invalid('request body is not valid JSON') }
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !(key in value))) return invalid(`only ${allowed.join(', ')} are accepted`)
  return value
}

/** A first-hand interactive panel session: no API token, team member, handoff or mailbox identity changes sign-in factors. */
export function assertOwnSession(caller: AuthenticatedCaller): void {
  if (caller.sessionId === null || caller.apiTokenId !== null || caller.team || caller.impersonator || isMailboxPrincipalUsername(caller.principal.username))
    fail('FORBIDDEN', 'sign-in factors are managed only from your own signed-in panel session', unchanged)
}

export interface ReauthenticationPorts extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'emitAudit'> {
  /** Exact Argon2id match of the current principal's password. */
  verifyPassword: (caller: AuthenticatedCaller, password: string) => Promise<boolean>
  /** Shared sign-in lockout; a lockedUntil ISO timestamp while locked. */
  checkLockout: (caller: AuthenticatedCaller, request: Request) => Promise<string | null>
  /** Counts a failed re-authentication against the shared lockout. */
  recordFailure: (caller: AuthenticatedCaller, reason: string, request: Request) => Promise<void>
  /** Only when the principal enrolled a second factor and MFA is not disabled. */
  secondFactorEnrolled?: (caller: AuthenticatedCaller) => boolean
  verifySecondFactor?: (caller: AuthenticatedCaller, code: string) => Promise<boolean>
}

/**
 * Proves the person at the keyboard still knows the password (and the enrolled second factor when asked) before a
 * sign-in factor changes. The session is re-read before and after, so a revoked session cannot finish the change.
 */
export async function reauthenticate(request: Request, caller: AuthenticatedCaller, ports: ReauthenticationPorts, input: { password: unknown; totpCode?: unknown; action: string; secondFactor?: boolean }): Promise<AuthenticatedCaller> {
  if (typeof input.password !== 'string' || !input.password || input.password.length > 1024) return fail('VALIDATION', 'the current password is required', unchanged)
  const until = await ports.checkLockout(caller, request)
  if (until) return fail('FORBIDDEN', 'too many failed authentication attempts', { ...unchanged, lockedOut: true, lockedUntil: until })
  const fresh = await ports.requireCaller(request)
  if (fresh.principal.id !== caller.principal.id || fresh.sessionId !== caller.sessionId) return fail('FORBIDDEN', 'the session authority changed', unchanged)
  const denied = async (factor: 'password' | 'totp'): Promise<never> => {
    await ports.recordFailure(fresh, `invalid_${input.action.replace(/[^a-z_]/g, '_')}_reauthentication`, request)
    await ports.emitAudit({ actor: fresh.principal.username, principalId: fresh.principal.id, action: 'auth.reauthentication_failed', target: input.action, detail: { factor }, outcome: 'denied' }).catch(() => undefined)
    return fail('UNAUTHENTICATED', factor === 'password' ? 'the current password is incorrect' : 'the two-factor code is incorrect', { ...unchanged, ...(factor === 'totp' ? { secondFactor: 'invalid' } : {}) })
  }
  if (!await ports.verifyPassword(fresh, input.password)) return denied('password')
  if (input.secondFactor && ports.secondFactorEnrolled?.(fresh)) {
    if (typeof input.totpCode !== 'string' || !/^[0-9]{6}$/.test(input.totpCode)) return fail('UNAUTHENTICATED', 'the two-factor code is required', { ...unchanged, secondFactor: 'required' })
    if (!await ports.verifySecondFactor!(fresh, input.totpCode)) return denied('totp')
  }
  const after = await ports.requireCaller(request)
  if (after.principal.id !== fresh.principal.id || after.sessionId !== fresh.sessionId) return fail('FORBIDDEN', 'the session authority changed', unchanged)
  return after
}
