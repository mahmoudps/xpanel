import { randomBytes } from 'node:crypto'
import { fail, isXpanelError } from '@xpanel/core'
import type { MfaRuntimeMode, ServiceUser } from '@xpanel/core'
import { completeTotpEnrollment, consumeRecoveryHash, consumeTotpStep, disableTotpForSession, getPendingTotpEnrollment, revokeAllSessionsForPrincipal, startTotpEnrollment } from '@xpanel/db'
import type { Db, MailboxSessionRecord, PrincipalRecord } from '@xpanel/db'
import type { StateStore } from '@xpanel/state'
import { generateTotpSecret, sealTotpSecret, sha256Hex, unsealTotpSecret, verifyTotpStep } from '../auth.ts'
import type { AuthenticatedCaller } from '../auth.ts'
import { renderTotpQrSvg } from '../totp-qr.ts'
import type { MailboxTransport } from './inbox.ts'

/** Owner decision D5 (cPanel): the mailbox's second factor guards xMail sign-in only; IMAP, POP3 and SMTP keep the password; no app passwords. */
export const MAILBOX_SECOND_FACTOR_SCOPE = Object.freeze({ protects: 'xmail-sign-in', mailProtocols: 'password', appPasswords: false } as const)
const ROUTES = { '/api/webmail/security': 'view', '/api/webmail/security/password': 'password', '/api/webmail/security/2fa/setup': 'setup', '/api/webmail/security/2fa/enable': 'enable', '/api/webmail/security/2fa/disable': 'disable' } as const
const unchanged = { stateChanged: false }

/**
 * The mailbox's TOTP or one recovery code, checked after the mail server accepted its password.
 * Returns whether the session counts as second-factor verified; refuses when the factor is enrolled and missing.
 */
export async function verifyMailboxSecondFactor(input: { db: Db; serverSecret: string; mfaMode: MfaRuntimeMode; principal: PrincipalRecord | null; totpCode?: unknown; recoveryCode?: unknown }): Promise<boolean> {
  const principal = input.principal
  if (input.mfaMode === 'disabled' || !principal?.totpEnabled) return false
  const sealed = principal.totpSecretEnc ?? fail('PRECONDITION_FAILED', 'two-factor key recovery is required')
  const code = typeof input.totpCode === 'string' ? input.totpCode.trim() : '', recovery = typeof input.recoveryCode === 'string' ? input.recoveryCode.trim() : ''
  if (code) {
    const step = verifyTotpStep(unsealTotpSecret(sealed, input.serverSecret), code)
    if (step === null || !await consumeTotpStep(input.db, principal.id, step, sealed)) return fail('UNAUTHENTICATED', 'invalid two-factor authentication code', { reason: 'invalid_totp' })
    return true
  }
  if (recovery) {
    if (!await consumeRecoveryHash(input.db, principal.id, sha256Hex(recovery), { expectedSealedSecret: sealed })) return fail('UNAUTHENTICATED', 'invalid recovery code', { reason: 'invalid_recovery_code' })
    return true
  }
  return fail('UNAUTHENTICATED', 'two-factor authentication code required', { mfaRequired: true })
}

export interface MailboxSecurityPorts {
  db: Db
  serverSecret: string
  mfaMode: MfaRuntimeMode
  transport: MailboxTransport
  store: Pick<StateStore, 'getServiceUser' | 'updateServiceUser'>
  /** The authenticated caller, read before the sealed mailbox is opened (server: requireCaller). */
  requireCaller(request: Request): Promise<AuthenticatedCaller>
  /** Fresh sealed-mailbox admission with these feature ids (server: authorizeNativeMailboxRequest). */
  open(request: Request, toolIds: readonly string[]): Promise<{ caller: AuthenticatedCaller; opened: { record: MailboxSessionRecord } }>
  /** The service-password rule for every service this login signs in to (password-policy.ts). */
  hashPassword(password: string, services: ServiceUser['services']): Promise<string>
  /** Applies the saved hash to Dovecot; null when no host agent is connected. */
  reconcile(caller: AuthenticatedCaller): Promise<{ ok: boolean; body: Record<string, unknown> } | null>
  audit(caller: AuthenticatedCaller, action: string, mailbox: string, detail?: Record<string, unknown>): Promise<void>
  /** The sign-in lockout: a wrong current password counts like a failed sign-in. */
  lockedUntil(mailbox: string, request: Request): Promise<string | null>
  recordFailure(mailbox: string, request: Request, reason: string, principalId: string): Promise<void>
  clearCookie(request: Request): string
}

const json = (value: unknown, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } })
async function body(request: Request, keys: readonly string[]): Promise<Record<string, unknown>> {
  if (new URL(request.url).search) return fail('VALIDATION', 'mailbox security accepts no query selectors', unchanged)
  const text = await request.text()
  if (text.length > 8 * 1024) return fail('LIMIT_EXCEEDED', 'the request is too large', unchanged)
  let value: unknown
  try { value = JSON.parse(text || '{}') } catch { return fail('VALIDATION', 'request body must be valid JSON', unchanged) }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) return fail('VALIDATION', 'only ' + keys.join(', ') + ' may be supplied', unchanged)
  return value as Record<string, unknown>
}

/** /api/webmail/security: the signed-in mailbox's own password and authenticator. */
export async function handleMailboxSecurityRoute(request: Request, url: URL, method: string, ports: MailboxSecurityPorts): Promise<Response | null> {
  const route = (ROUTES as Record<string, (typeof ROUTES)[keyof typeof ROUTES] | undefined>)[url.pathname]
  if (!route) return null
  if (method !== (route === 'view' ? 'GET' : 'POST')) return new Response(null, { status: 405, headers: { allow: route === 'view' ? 'GET' : 'POST' } })
  const tools = route === 'view' ? [] : route === 'password' ? ['webmail-password'] : ['webmail-two-factor']
  // The account owner's handoff opens mail without the mailbox password; it never manages the mailbox's own credentials.
  if ((await ports.requireCaller(request)).impersonator) return fail('FORBIDDEN', 'a handed-off session cannot manage mailbox credentials', { ...unchanged, reason: 'handoff_session' })
  const { caller, opened } = await ports.open(request, tools)
  const mailbox = opened.record.mailbox
  if (route === 'view') {
    if (url.search) return fail('VALIDATION', 'mailbox security accepts no query selectors', unchanged)
    return json({ mailbox, mfaMode: ports.mfaMode, totpEnabled: ports.mfaMode !== 'disabled' && caller.principalRecord.totpEnabled, enrolled: caller.principalRecord.totpEnabled,
      secondFactor: MAILBOX_SECOND_FACTOR_SCOPE })
  }
  if (!caller.sessionId || caller.apiTokenId !== null) return fail('FORBIDDEN', 'mailbox security changes require an interactive mailbox session', unchanged)
  const confirm = async (password: unknown, reason: string): Promise<void> => {
    const until = await ports.lockedUntil(mailbox, request)
    if (until) return fail('FORBIDDEN', 'too many failed authentication attempts', { ...unchanged, lockedOut: true, lockedUntil: until })
    if (typeof password !== 'string' || !password) return fail('VALIDATION', 'the current mailbox password is required', unchanged)
    try { await ports.transport.verify(mailbox, password) }
    catch (error) {
      if (!isXpanelError(error) || error.code !== 'UNAUTHENTICATED') throw error
      await ports.recordFailure(mailbox, request, reason, caller.principal.id)
      return fail('UNAUTHENTICATED', 'the current mailbox password is incorrect', unchanged)
    }
  }

  if (route === 'password') {
    const input = await body(request, ['currentPassword', 'newPassword'])
    if (typeof input.newPassword !== 'string' || input.newPassword === input.currentPassword) return fail('VALIDATION', 'a new password different from the current one is required', unchanged)
    await confirm(input.currentPassword, 'invalid_password_change_reauthentication')
    const service = await ports.store.getServiceUser(opened.record.serviceUserId)
    if (!service || service.accountId !== opened.record.accountId || service.login.toLowerCase() !== mailbox || !service.services.email) return fail('FORBIDDEN', 'mailbox identity changed; sign in again', unchanged)
    const passwordHash = await ports.hashPassword(input.newPassword, service.services)
    let saved = false
    try {
      await ports.store.updateServiceUser(service.id, { passwordHash })
      saved = true
      const reconcile = await ports.reconcile(caller)
      // The mail server must use the new password before every mailbox session ends.
      if (!reconcile?.ok || !['applied', 'noop'].includes(String(reconcile.body.status))) throw new Error('mail_password_apply')
      await ports.audit(caller, 'webmail.password_changed', mailbox, { services: Object.entries(service.services).filter(([, on]) => on).map(([name]) => name).sort() })
      await revokeAllSessionsForPrincipal(ports.db, caller.principal.id)
    } catch (error) {
      if (!saved && isXpanelError(error)) return fail(error.code, error.message, { ...error.detail, ...unchanged })
      return fail('SERVICE_UNAVAILABLE', saved ? 'the new password was saved; its use by the mail server or its record is unverified, so sign in with either password and check again' : 'the password change requires inspection',
        { stateChanged: true, verificationRequired: true, unknownOutcome: true })
    }
    return json({ ok: true, reauthenticationRequired: true, scope: MAILBOX_SECOND_FACTOR_SCOPE }, { 'set-cookie': ports.clearCookie(request) })
  }

  if (ports.mfaMode === 'disabled') return fail('FORBIDDEN', 'two-factor changes are disabled in development', unchanged)
  const principal = caller.principalRecord
  if (route === 'setup') {
    if (principal.totpEnabled) return fail('CONFLICT', 'two-factor authentication is already enabled', unchanged)
    await confirm((await body(request, ['password'])).password, 'invalid_two_factor_reauthentication')
    const secret = generateTotpSecret(), recoveryCodes = Array.from({ length: 8 }, () => randomBytes(16).toString('hex'))
    const enrollment = await startTotpEnrollment(ports.db, { principalId: principal.id, sessionId: caller.sessionId, expectedPasswordHash: principal.passwordHash, sealedSecret: sealTotpSecret(secret, ports.serverSecret), recoveryHashes: recoveryCodes.map(sha256Hex) })
    const otpauthUrl = 'otpauth://totp/xMail:' + encodeURIComponent(mailbox) + '?secret=' + secret + '&issuer=xMail'
    let qrCodeSvg: string | undefined
    try { qrCodeSvg = renderTotpQrSvg(otpauthUrl) } catch { qrCodeSvg = undefined }
    return json({ secret, otpauthUrl, ...(qrCodeSvg ? { qrCodeSvg } : {}), recoveryCodes, expiresAt: enrollment.expiresAt })
  }
  if (route === 'enable') {
    const input = await body(request, ['code'])
    const pending = await getPendingTotpEnrollment(ports.db, principal.id, caller.sessionId)
    if (!pending) return fail('PRECONDITION_FAILED', '2FA setup must be initiated before enabling', unchanged)
    const step = verifyTotpStep(unsealTotpSecret(pending.sealedSecret, ports.serverSecret), typeof input.code === 'string' ? input.code.trim() : '')
    if (step === null) return fail('VALIDATION', 'invalid TOTP verification code', unchanged)
    if (!await completeTotpEnrollment(ports.db, { principalId: principal.id, sessionId: caller.sessionId, enrollmentId: pending.enrollmentId, step })) return fail('PRECONDITION_FAILED', 'two-factor enrollment expired or changed', unchanged)
    await ports.audit(caller, 'auth.2fa_enabled', mailbox)
    return json({ ok: true, totpEnabled: true, scope: MAILBOX_SECOND_FACTOR_SCOPE })
  }
  const input = await body(request, ['password', 'code', 'recoveryCode'])
  const sealed = principal.totpEnabled ? principal.totpSecretEnc : null
  if (!sealed) return fail('PRECONDITION_FAILED', 'two-factor authentication is not enabled', unchanged)
  await confirm(input.password, 'invalid_two_factor_reauthentication')
  const step = typeof input.code === 'string' ? verifyTotpStep(unsealTotpSecret(sealed, ports.serverSecret), input.code) : null
  const verified = step !== null ? await consumeTotpStep(ports.db, principal.id, step, sealed)
    : typeof input.recoveryCode === 'string' && await consumeRecoveryHash(ports.db, principal.id, sha256Hex(input.recoveryCode.trim()))
  if (!verified) return fail('UNAUTHENTICATED', 'a fresh two-factor code is required', unchanged)
  if (!await disableTotpForSession(ports.db, { principalId: principal.id, sessionId: caller.sessionId, expectedPasswordHash: principal.passwordHash, expectedSealedSecret: sealed })) return fail('PRECONDITION_FAILED', 'two-factor state changed; authenticate again', unchanged)
  await ports.audit(caller, 'auth.2fa_disabled', mailbox)
  return json({ ok: true, totpEnabled: false, scope: MAILBOX_SECOND_FACTOR_SCOPE })
}
