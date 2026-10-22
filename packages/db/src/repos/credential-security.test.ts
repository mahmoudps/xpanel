import { afterEach, describe, expect, it } from 'vitest'
import { SESSION_ABSOLUTE_TIMEOUT_MS, SESSION_IDLE_TIMEOUT_MS } from '@xpanel/core'
import { createTestDb, type TestDbHandle } from '../client.ts'
import { ARGON2, sha } from '../testing.ts'
import {
  changePasswordForSession, completeTotpEnrollment, consumeTotpStep, createApiToken,
  createRootPrincipal, createSession, disableTotpForSession, findActiveApiTokenByHash,
  findActiveSessionByTokenHash, getPendingTotpEnrollment, getPrincipal, setPasswordHash,
  setPrincipalDisabled, setTotpSecret, startTotpEnrollment,
} from './index.ts'

const handles: TestDbHandle[] = []
const replacementHash = ARGON2.replace('t=3', 't=4')
const rotatedHash = ARGON2.replace('t=3', 't=5')
const key = (value = 5): Uint8Array => new Uint8Array(48).fill(value)
const future = (): string => new Date(Date.now() + 3_600_000).toISOString()
type Transition = 'password-reset' | 'password-change' | 'admin-rotate' | 'admin-disable' | 'enroll' | 'session-disable'
const transitions: Transition[] = ['password-reset', 'password-change', 'admin-rotate', 'admin-disable', 'enroll', 'session-disable']

afterEach(async () => { await Promise.all(handles.splice(0).map(handle => handle.close())) })

const fixture = async (enrolled = true, force = false) => {
  const handle = await createTestDb()
  handles.push(handle)
  const created = await createRootPrincipal(handle.db, { username: 'root', passwordHash: ARGON2, forcePasswordChange: force })
  if (enrolled) {
    await setTotpSecret(handle.db, created.id, key(), [sha('e')])
    await consumeTotpStep(handle.db, created.id, 100, key())
  }
  const session = await createSession(handle.db, {
    principalId: created.id, tokenHash: sha('a'), expiresAt: future(), mfaVerified: enrolled,
  })
  await createSession(handle.db, { principalId: created.id, tokenHash: sha('b'), expiresAt: future(), mfaVerified: enrolled })
  await createApiToken(handle.db, { principalId: created.id, name: 'old', tokenHash: sha('c'), scopes: ['*'], expiresAt: future() })
  const other = await createRootPrincipal(handle.db, { username: 'admin', passwordHash: ARGON2, forcePasswordChange: false })
  const otherSession = await createSession(handle.db, { principalId: other.id, tokenHash: sha('d'), expiresAt: future(), mfaVerified: true })
  await createApiToken(handle.db, { principalId: other.id, name: 'unrelated', tokenHash: sha('d'), scopes: ['*'], expiresAt: future() })
  const pending = await startTotpEnrollment(handle.db, {
    principalId: created.id, sessionId: session.id, sealedSecret: key(6), recoveryHashes: [sha('f')], expectedPasswordHash: ARGON2,
  })
  const principal = (await getPrincipal(handle.db, created.id))!
  return { handle, principal, session, other, otherSession, pending }
}

type Fixture = Awaited<ReturnType<typeof fixture>>
const passwordInput = (f: Fixture) => ({
  principalId: f.principal.id, sessionId: f.session.id, expectedPasswordHash: f.principal.passwordHash,
  newPasswordHash: replacementHash, expectedTotpEnabled: f.principal.totpEnabled,
  expectedSealedSecret: f.principal.totpSecretEnc, expectedForcePasswordChange: f.principal.forcePasswordChange,
})

const perform = async (f: Fixture, transition: Transition): Promise<boolean | void> => {
  if (transition === 'password-reset') return setPasswordHash(f.handle.db, f.principal.id, replacementHash, { forceChange: true })
  if (transition === 'password-change') return changePasswordForSession(f.handle.db, passwordInput(f))
  if (transition === 'admin-rotate') return setTotpSecret(f.handle.db, f.principal.id, key(7), [sha('f')])
  if (transition === 'admin-disable') return setTotpSecret(f.handle.db, f.principal.id, null)
  if (transition === 'enroll') return completeTotpEnrollment(f.handle.db, {
    principalId: f.principal.id, sessionId: f.session.id, enrollmentId: f.pending.enrollmentId, step: 200,
  })
  return disableTotpForSession(f.handle.db, {
    principalId: f.principal.id, sessionId: f.session.id, expectedPasswordHash: ARGON2, expectedSealedSecret: key(),
  })
}

describe('credential changes permanently revoke previous API tokens', () => {
  it.each(transitions)('%s atomically revokes tokens without changing another principal access', async transition => {
    const f = await fixture(transition !== 'enroll', transition === 'password-change')
    const result = await perform(f, transition)
    if (result !== undefined) expect(result).toBe(true)
    expect(await findActiveApiTokenByHash(f.handle.db, sha('c'))).toBeNull()
    expect((await findActiveApiTokenByHash(f.handle.db, sha('d')))?.principalId).toBe(f.other.id)
    expect(await findActiveSessionByTokenHash(f.handle.db, sha('b'))).toBeNull()
    const retainsInitiator = transition === 'enroll' || transition === 'session-disable'
    expect(Boolean(await findActiveSessionByTokenHash(f.handle.db, sha('a')))).toBe(retainsInitiator)
    await f.handle.db.query('UPDATE principals SET force_password_change = 0 WHERE id = $1', [f.principal.id])
    expect(await findActiveApiTokenByHash(f.handle.db, sha('c'))).toBeNull()
  })

  it.each(transitions)('%s rolls back credentials, pending enrollment and sessions if token revocation fails', async transition => {
    const f = await fixture(transition !== 'enroll', transition === 'password-change')
    const before = await getPrincipal(f.handle.db, f.principal.id)
    await f.handle.db.exec(`CREATE TRIGGER reject_credential_token_revoke BEFORE UPDATE OF revoked_at ON api_tokens
      WHEN NEW.revoked_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'Token revocation failure'); END`)
    await expect(perform(f, transition)).rejects.toBeDefined()
    expect(await getPrincipal(f.handle.db, f.principal.id)).toEqual(before)
    expect(await getPendingTotpEnrollment(f.handle.db, f.principal.id, f.session.id)).toEqual(f.pending)
    expect((await findActiveApiTokenByHash(f.handle.db, sha('c')))?.principalId).toBe(f.principal.id)
    expect((await findActiveSessionByTokenHash(f.handle.db, sha('a')))?.id).toBe(f.session.id)
    expect(await findActiveSessionByTokenHash(f.handle.db, sha('b'))).not.toBeNull()
  })
})

describe('session-bound conditional password change', () => {
  it.each([false, true])('clears force=%s, preserves MFA and requires a fresh login', async force => {
    const f = await fixture(true, force)
    expect(await changePasswordForSession(f.handle.db, passwordInput(f))).toBe(true)
    const updated = await getPrincipal(f.handle.db, f.principal.id)
    expect(updated?.passwordHash).toBe(replacementHash)
    expect(updated?.forcePasswordChange).toBe(false)
    expect(updated?.totpSecretEnc).toEqual(key())
    expect(updated?.totpRecoveryHashes).toEqual([sha('e')])
    expect(updated?.totpLastStep).toBe(100)
    expect(await getPendingTotpEnrollment(f.handle.db, f.principal.id, f.session.id)).toBeNull()
    expect(await findActiveSessionByTokenHash(f.handle.db, sha('a'))).toBeNull()
    expect(await findActiveApiTokenByHash(f.handle.db, sha('c'))).toBeNull()
  })

  it('permits the unenrolled temporary session to change its password without granting a full session', async () => {
    const f = await fixture(false, true)
    expect(await changePasswordForSession(f.handle.db, passwordInput(f))).toBe(true)
    expect((await getPrincipal(f.handle.db, f.principal.id))?.totpEnabled).toBe(false)
    expect(await findActiveSessionByTokenHash(f.handle.db, sha('a'))).toBeNull()
  })

  it.each(['password', 'factor-enable', 'factor-rotation', 'factor-disable', 'force-flag', 'revoked', 'expired', 'idle', 'absolute', 'foreign', 'disabled', 'unverified'] as const)(
    'rejects changed %s authority without writing credentials or revocations', async change => {
      const f = await fixture(change !== 'factor-enable')
      const input = passwordInput(f)
      const now = Date.now()
      if (change === 'password') await f.handle.db.query('UPDATE principals SET password_hash = $1 WHERE id = $2', [rotatedHash, f.principal.id])
      if (change === 'factor-enable' || change === 'factor-rotation') {
        await f.handle.db.query('UPDATE principals SET totp_secret_enc = $1, totp_enabled_at = $2 WHERE id = $3', [key(7), new Date(now).toISOString(), f.principal.id])
      }
      if (change === 'factor-disable') await f.handle.db.query('UPDATE principals SET totp_secret_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL WHERE id = $1', [f.principal.id])
      if (change === 'force-flag') await f.handle.db.query('UPDATE principals SET force_password_change = 1 WHERE id = $1', [f.principal.id])
      if (change === 'revoked') await f.handle.db.query('UPDATE sessions SET revoked_at = $1 WHERE id = $2', [new Date(now).toISOString(), f.session.id])
      if (change === 'expired') await f.handle.db.query('UPDATE sessions SET created_at = $1, expires_at = $2 WHERE id = $3', [new Date(now - 60_000).toISOString(), new Date(now).toISOString(), f.session.id])
      if (change === 'idle') await f.handle.db.query('UPDATE sessions SET last_seen_at = $1 WHERE id = $2', [new Date(now - SESSION_IDLE_TIMEOUT_MS).toISOString(), f.session.id])
      if (change === 'absolute') await f.handle.db.query('UPDATE sessions SET created_at = $1 WHERE id = $2', [new Date(now - SESSION_ABSOLUTE_TIMEOUT_MS).toISOString(), f.session.id])
      if (change === 'foreign') input.sessionId = f.otherSession.id
      if (change === 'disabled') await f.handle.db.query('UPDATE principals SET disabled = 1 WHERE id = $1', [f.principal.id])
      if (change === 'unverified') await f.handle.db.query('UPDATE sessions SET mfa_verified = 0 WHERE id = $1', [f.session.id])
      const before = await getPrincipal(f.handle.db, f.principal.id)
      expect(await changePasswordForSession(f.handle.db, input)).toBe(false)
      expect(await getPrincipal(f.handle.db, f.principal.id)).toEqual(before)
      expect(await findActiveApiTokenByHash(f.handle.db, sha('c'))).not.toBeNull()
      expect(await findActiveSessionByTokenHash(f.handle.db, sha('b'))).not.toBeNull()
    },
  )

  it.each(['', '$scrypt$invalid', ARGON2.replace('m=65536', 'm=1024')])('rejects an invalid replacement hash without changes', async newPasswordHash => {
    const f = await fixture()
    await expect(changePasswordForSession(f.handle.db, { ...passwordInput(f), newPasswordHash })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await getPrincipal(f.handle.db, f.principal.id))?.passwordHash).toBe(ARGON2)
    expect(await findActiveApiTokenByHash(f.handle.db, sha('c'))).not.toBeNull()
  })

  it('revokes sessions, API tokens, and pending enrollments atomically when disabling a principal', async () => {
    const f = await fixture()
    await setPrincipalDisabled(f.handle.db, f.principal.id, true)
    expect((await getPrincipal(f.handle.db, f.principal.id))?.disabled).toBe(true)
    expect(await getPendingTotpEnrollment(f.handle.db, f.principal.id, f.session.id)).toBeNull()
    expect(await findActiveSessionByTokenHash(f.handle.db, sha('a'))).toBeNull()
    expect(await findActiveSessionByTokenHash(f.handle.db, sha('b'))).toBeNull()
    expect(await findActiveApiTokenByHash(f.handle.db, sha('c'))).toBeNull()
    // Re-enabling the principal must not resurrect sessions or API tokens revoked upon disable
    await setPrincipalDisabled(f.handle.db, f.principal.id, false)
    expect((await getPrincipal(f.handle.db, f.principal.id))?.disabled).toBe(false)
    expect(await findActiveSessionByTokenHash(f.handle.db, sha('a'))).toBeNull()
    expect(await findActiveApiTokenByHash(f.handle.db, sha('c'))).toBeNull()
  })
})
