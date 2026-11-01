import { fail, type Principal } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { entryPointAdmitsPrincipal, type EntryPoint } from './entry-points.ts'

export type AuthPersonalOwner = AuthenticatedCaller & {
  principal: Extract<Principal, { kind: 'user' }>
  sessionId: string
  sessionToken: string
}

/**
 * Pure policy for an already authenticated original account-owner session.
 * mfaVerified is the existing middleware's effective persisted/runtime-policy result,
 * not a request flag or a requirement to enroll. No credential freshness is asserted
 * here: effect callers must authenticate again inside their admitted transaction and
 * enforce the existing Origin/CSRF and source-lease checks around the effect.
 */
export function assertAuthPersonalOwner(caller: AuthenticatedCaller, entryPoint?: EntryPoint): asserts caller is AuthPersonalOwner {
  const principal = caller.principal, record = caller.principalRecord
  if ((entryPoint !== undefined && entryPoint !== 'xpanel')
    || principal.kind !== 'user' || record.kind !== 'user'
    || !entryPointAdmitsPrincipal('xpanel', record)
    || record.id !== principal.id || record.username !== principal.username || record.accountId !== principal.accountId
    || record.disabled || record.forcePasswordChange
    || !caller.sessionId || !caller.sessionToken || caller.apiTokenId !== null
    || caller.team !== undefined || caller.impersonator !== undefined || caller.mfaVerified !== true) {
    fail('FORBIDDEN', 'an original authenticated account-owner session is required')
  }
}
