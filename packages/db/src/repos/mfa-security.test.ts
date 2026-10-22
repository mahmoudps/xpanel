import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SESSION_ABSOLUTE_TIMEOUT_MS, SESSION_IDLE_TIMEOUT_MS } from '@xpanel/core'
import { createDb, createTestDb, type DbHandle } from '../client.ts'
import { migrate } from '../migrate.ts'
import { ARGON2, sha } from '../testing.ts'
import {
  completeTotpEnrollment,
  consumeRecoveryHash,
  consumeTotpStep,
  createAuthenticatedSession,
  createRootPrincipal,
  createSession,
  disableTotpForSession,
  getPendingTotpEnrollment,
  getPrincipal,
  findActiveSessionByTokenHash,
  revokeOtherSessionsForPrincipal,
  revokeSession,
  setTotpSecret,
  setPasswordHash,
  startTotpEnrollment,
} from './index.ts'

const handles: DbHandle[] = []
const directories: string[] = []
const sealed = (value = 5): Uint8Array => new Uint8Array(48).fill(value)
const CHANGED_PASSWORD_HASH = ARGON2.replace('t=3', 't=4')

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()))
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const setup = async (options: { sealedSecret?: Uint8Array; recoveryHashes?: readonly string[] } = {}) => {
  const handle = await createTestDb()
  handles.push(handle)
  const principal = await createRootPrincipal(handle.db, { username: 'root', passwordHash: ARGON2 })
  if (options.sealedSecret) await setTotpSecret(handle.db, principal.id, options.sealedSecret, options.recoveryHashes)
  const session = await createSession(handle.db, {
    principalId: principal.id,
    tokenHash: sha('a'),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  })
  return { handle, principal, session }
}

describe('persisted TOTP replay protection', () => {
  it('allows exactly one concurrent claim and rejects the same or an older time step', async () => {
    const { handle, principal } = await setup()
    await setTotpSecret(handle.db, principal.id, sealed())
    const claims = await Promise.all(Array.from({ length: 12 }, () => consumeTotpStep(handle.db, principal.id, 100, sealed())))
    expect(claims.filter(Boolean)).toHaveLength(1)
    expect(await consumeTotpStep(handle.db, principal.id, 99, sealed())).toBe(false)
    expect(await consumeTotpStep(handle.db, principal.id, 100, sealed())).toBe(false)
    expect(await consumeTotpStep(handle.db, principal.id, 101, sealed())).toBe(true)
  })

  it('retains the replay barrier on a same-secret save, resets it on rotation, and clears it on disable', async () => {
    const { handle, principal } = await setup()
    await setTotpSecret(handle.db, principal.id, sealed())
    expect(await consumeTotpStep(handle.db, principal.id, 100, sealed())).toBe(true)
    await setTotpSecret(handle.db, principal.id, sealed())
    expect(await consumeTotpStep(handle.db, principal.id, 100, sealed())).toBe(false)
    await setTotpSecret(handle.db, principal.id, sealed(6))
    expect(await consumeTotpStep(handle.db, principal.id, 101, sealed())).toBe(false)
    expect(await consumeTotpStep(handle.db, principal.id, 100, sealed(6))).toBe(true)
    await setTotpSecret(handle.db, principal.id, null)
    expect(await consumeTotpStep(handle.db, principal.id, 101, sealed(6))).toBe(false)
    expect((await getPrincipal(handle.db, principal.id))?.totpLastStep).toBeNull()
  })

  it('persists consumed time steps across database close/reopen and independent connections', async () => {
    const path = await mkdtemp(join(tmpdir(), 'xpanel-mfa-'))
    directories.push(path)
    const filename = join(path, 'identity.db')
    const first = createDb(filename)
    handles.push(first)
    await migrate(first.db)
    const principal = await createRootPrincipal(first.db, { username: 'root', passwordHash: ARGON2 })
    await setTotpSecret(first.db, principal.id, sealed())
    expect(await consumeTotpStep(first.db, principal.id, 100, sealed())).toBe(true)
    await first.close()
    const second = createDb(filename)
    const third = createDb(filename)
    handles.push(second, third)
    expect(await consumeTotpStep(second.db, principal.id, 100, sealed())).toBe(false)
    const next = await Promise.all([consumeTotpStep(second.db, principal.id, 101, sealed()), consumeTotpStep(third.db, principal.id, 101, sealed())])
    expect(next.filter(Boolean)).toHaveLength(1)
  })

  it('rejects invalid steps and does not accept a disabled or missing principal', async () => {
    const { handle, principal } = await setup()
    for (const step of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(consumeTotpStep(handle.db, principal.id, step, sealed())).rejects.toMatchObject({ code: 'VALIDATION' })
    }
    expect(await consumeTotpStep(handle.db, randomUUID(), 100, sealed())).toBe(false)
    await setTotpSecret(handle.db, principal.id, sealed())
    await handle.db.query('UPDATE principals SET disabled = 1 WHERE id = $1', [principal.id])
    expect(await consumeTotpStep(handle.db, principal.id, 100, sealed())).toBe(false)
  })
})

describe('session-bound persisted TOTP enrollment', () => {
  it('stores sealed enrollment only, completes it once, and consumes the enabling time step', async () => {
    const { handle, principal, session } = await setup()
    await createSession(handle.db, {
      principalId: principal.id, tokenHash: sha('e'), mfaVerified: true,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })
    const pending = await startTotpEnrollment(handle.db, {
      expectedPasswordHash: ARGON2,
      principalId: principal.id, sessionId: session.id, sealedSecret: sealed(), recoveryHashes: [sha('b')],
    })
    const stored = await getPendingTotpEnrollment(handle.db, principal.id, session.id)
    expect(stored).toEqual(pending)
    expect(stored?.sealedSecret).toEqual(sealed())
    expect((await getPrincipal(handle.db, principal.id))?.totpEnabled).toBe(false)
    const input = { principalId: principal.id, sessionId: session.id, enrollmentId: pending.enrollmentId, step: 200 }
    expect(await completeTotpEnrollment(handle.db, input)).toBe(true)
    expect(await completeTotpEnrollment(handle.db, input)).toBe(false)
    expect(await getPendingTotpEnrollment(handle.db, principal.id, session.id)).toBeNull()
    const active = await getPrincipal(handle.db, principal.id)
    expect(active?.totpEnabled).toBe(true)
    expect(active?.totpSecretEnc).toEqual(sealed())
    expect(active?.totpRecoveryHashes).toEqual([sha('b')])
    expect(await consumeTotpStep(handle.db, principal.id, 200, sealed())).toBe(false)
    expect(await findActiveSessionByTokenHash(handle.db, sha('e'))).toBeNull()
    expect((await findActiveSessionByTokenHash(handle.db, sha('a')))?.mfaVerified).toBe(true)
  })

  it('rejects another session and replacement after verification without changing the active key', async () => {
    const { handle, principal, session } = await setup()
    const other = await createSession(handle.db, {
      principalId: principal.id, tokenHash: sha('b'), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })
    const first = await startTotpEnrollment(handle.db, {
      expectedPasswordHash: ARGON2,
      principalId: principal.id, sessionId: session.id, sealedSecret: sealed(), recoveryHashes: [sha('c')],
    })
    expect(await getPendingTotpEnrollment(handle.db, principal.id, other.id)).toBeNull()
    expect(await completeTotpEnrollment(handle.db, {
      principalId: principal.id, sessionId: other.id, enrollmentId: first.enrollmentId, step: 100,
    })).toBe(false)
    const replacement = await startTotpEnrollment(handle.db, {
      expectedPasswordHash: ARGON2,
      principalId: principal.id, sessionId: session.id, sealedSecret: sealed(6), recoveryHashes: [sha('d')],
    })
    expect(await completeTotpEnrollment(handle.db, {
      principalId: principal.id, sessionId: session.id, enrollmentId: first.enrollmentId, step: 100,
    })).toBe(false)
    expect((await getPrincipal(handle.db, principal.id))?.totpEnabled).toBe(false)
    expect((await getPendingTotpEnrollment(handle.db, principal.id, session.id))?.enrollmentId).toBe(replacement.enrollmentId)
  })

  it('expires enrollment at exactly 5 minutes, and revoked sessions cannot read or complete it', async () => {
    const { handle, principal, session } = await setup()
    const now = new Date().toISOString()
    const pending = await startTotpEnrollment(handle.db, {
      expectedPasswordHash: ARGON2,
      principalId: principal.id, sessionId: session.id, sealedSecret: sealed(), recoveryHashes: [sha('c')], now,
    })
    const expiresAt = new Date(Date.parse(now) + 300_000).toISOString()
    expect(pending.expiresAt).toBe(expiresAt)
    expect(await getPendingTotpEnrollment(handle.db, principal.id, session.id, expiresAt)).toBeNull()
    expect(await completeTotpEnrollment(handle.db, {
      principalId: principal.id, sessionId: session.id, enrollmentId: pending.enrollmentId, step: 100, now: expiresAt,
    })).toBe(false)
    await revokeSession(handle.db, session.id)
    expect(await getPendingTotpEnrollment(handle.db, principal.id, session.id, now)).toBeNull()
    expect(await completeTotpEnrollment(handle.db, {
      principalId: principal.id, sessionId: session.id, enrollmentId: pending.enrollmentId, step: 100, now,
    })).toBe(false)
    await expect(startTotpEnrollment(handle.db, {
      expectedPasswordHash: ARGON2,
      principalId: principal.id, sessionId: session.id, sealedSecret: sealed(), recoveryHashes: [],
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })

  it('does not enroll a principal using another principal session, and disable clears pending enrollment', async () => {
    const { handle, principal, session } = await setup()
    const other = await createRootPrincipal(handle.db, { username: 'admin', passwordHash: ARGON2 })
    await expect(startTotpEnrollment(handle.db, {
      expectedPasswordHash: ARGON2,
      principalId: other.id, sessionId: session.id, sealedSecret: sealed(), recoveryHashes: [],
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await startTotpEnrollment(handle.db, {
      expectedPasswordHash: ARGON2,
      principalId: principal.id, sessionId: session.id, sealedSecret: sealed(), recoveryHashes: [],
    })
    await setTotpSecret(handle.db, principal.id, null)
    expect(await getPendingTotpEnrollment(handle.db, principal.id, session.id)).toBeNull()
  })

  it('invalidates pending enrollment on password reset and refuses setup using the old password proof', async () => {
    const { handle, principal, session } = await setup()
    const pending = await startTotpEnrollment(handle.db, {
      principalId: principal.id, sessionId: session.id, sealedSecret: sealed(),
      recoveryHashes: [], expectedPasswordHash: ARGON2,
    })
    await setPasswordHash(handle.db, principal.id, CHANGED_PASSWORD_HASH)
    expect(await getPendingTotpEnrollment(handle.db, principal.id, session.id)).toBeNull()
    expect(await completeTotpEnrollment(handle.db, {
      principalId: principal.id, sessionId: session.id, enrollmentId: pending.enrollmentId, step: 100,
    })).toBe(false)
    await expect(startTotpEnrollment(handle.db, {
      principalId: principal.id, sessionId: session.id, sealedSecret: sealed(),
      recoveryHashes: [], expectedPasswordHash: ARGON2,
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })

  it.each(['idle', 'absolute', 'expires'] as const)('refuses enrollment when its session reaches the %s deadline', async (deadline) => {
    const { handle, principal, session } = await setup()
    const now = new Date().toISOString()
    const pending = await startTotpEnrollment(handle.db, {
      expectedPasswordHash: ARGON2,
      principalId: principal.id, sessionId: session.id, sealedSecret: sealed(), recoveryHashes: [], now,
    })
    if (deadline === 'idle') {
      await handle.db.query('UPDATE sessions SET last_seen_at = $1 WHERE id = $2', [
        new Date(Date.parse(now) - SESSION_IDLE_TIMEOUT_MS).toISOString(), session.id,
      ])
    } else if (deadline === 'absolute') {
      await handle.db.query('UPDATE sessions SET created_at = $1 WHERE id = $2', [
        new Date(Date.parse(now) - SESSION_ABSOLUTE_TIMEOUT_MS).toISOString(), session.id,
      ])
    } else {
      await handle.db.query('UPDATE sessions SET created_at = $1, expires_at = $2 WHERE id = $3', [
        new Date(Date.parse(now) - 60_000).toISOString(), now, session.id,
      ])
    }
    expect(await getPendingTotpEnrollment(handle.db, principal.id, session.id, now)).toBeNull()
    expect(await completeTotpEnrollment(handle.db, {
      principalId: principal.id, sessionId: session.id, enrollmentId: pending.enrollmentId, step: 100, now,
    })).toBe(false)
    await expect(startTotpEnrollment(handle.db, {
      expectedPasswordHash: ARGON2,
      principalId: principal.id, sessionId: session.id, sealedSecret: sealed(), recoveryHashes: [], now,
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })

  it('completes only one simultaneous request for the same verified enrollment', async () => {
    const { handle, principal, session } = await setup()
    const pending = await startTotpEnrollment(handle.db, {
      expectedPasswordHash: ARGON2,
      principalId: principal.id, sessionId: session.id, sealedSecret: sealed(), recoveryHashes: [sha('c')],
    })
    const input = { principalId: principal.id, sessionId: session.id, enrollmentId: pending.enrollmentId, step: 100 }
    const results = await Promise.all([completeTotpEnrollment(handle.db, input), completeTotpEnrollment(handle.db, input)])
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it('rolls back enrollment activation if sibling revocation fails before commit', async () => {
    const { handle, principal, session } = await setup()
    await createSession(handle.db, {
      principalId: principal.id, tokenHash: sha('e'), mfaVerified: true,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })
    const pending = await startTotpEnrollment(handle.db, {
      expectedPasswordHash: ARGON2,
      principalId: principal.id, sessionId: session.id, sealedSecret: sealed(), recoveryHashes: [sha('c')],
    })
    await handle.db.exec(`CREATE TRIGGER reject_mfa_revoke BEFORE UPDATE OF revoked_at ON sessions
      WHEN NEW.revoked_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'MFA revoke failure'); END`)
    await expect(completeTotpEnrollment(handle.db, {
      principalId: principal.id, sessionId: session.id, enrollmentId: pending.enrollmentId, step: 100,
    })).rejects.toBeDefined()
    expect((await getPrincipal(handle.db, principal.id))?.totpEnabled).toBe(false)
    expect(await getPendingTotpEnrollment(handle.db, principal.id, session.id)).toEqual(pending)
    expect(await findActiveSessionByTokenHash(handle.db, sha('e'))).not.toBeNull()
    expect((await findActiveSessionByTokenHash(handle.db, sha('a')))?.mfaVerified).toBe(false)
  })

  it('survives process database reopen without enabling the key before verification', async () => {
    const path = await mkdtemp(join(tmpdir(), 'xpanel-enrollment-'))
    directories.push(path)
    const filename = join(path, 'identity.db')
    const first = createDb(filename)
    handles.push(first)
    await migrate(first.db)
    const principal = await createRootPrincipal(first.db, { username: 'root', passwordHash: ARGON2 })
    const session = await createSession(first.db, {
      principalId: principal.id, tokenHash: sha('a'), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })
    const pending = await startTotpEnrollment(first.db, {
      expectedPasswordHash: ARGON2,
      principalId: principal.id, sessionId: session.id, sealedSecret: sealed(), recoveryHashes: [sha('c')],
    })
    await first.close()
    const second = createDb(filename)
    handles.push(second)
    expect(await getPendingTotpEnrollment(second.db, principal.id, session.id)).toEqual(pending)
    expect((await getPrincipal(second.db, principal.id))?.totpEnabled).toBe(false)
    expect(await completeTotpEnrollment(second.db, {
      principalId: principal.id, sessionId: session.id, enrollmentId: pending.enrollmentId, step: 100,
    })).toBe(true)
  })

  it('revokes only sibling sessions belonging to the changed principal', async () => {
    const { handle, principal, session } = await setup()
    const other = await createRootPrincipal(handle.db, { username: 'admin', passwordHash: ARGON2 })
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString()
    await createSession(handle.db, { principalId: principal.id, tokenHash: sha('b'), expiresAt })
    await createSession(handle.db, { principalId: other.id, tokenHash: sha('c'), expiresAt })
    expect(await revokeOtherSessionsForPrincipal(handle.db, principal.id, session.id)).toBe(1)
    expect((await findActiveSessionByTokenHash(handle.db, sha('a')))?.id).toBe(session.id)
    expect(await findActiveSessionByTokenHash(handle.db, sha('b'))).toBeNull()
    expect((await findActiveSessionByTokenHash(handle.db, sha('c')))?.principalId).toBe(other.id)
  })
})

describe('atomic session-bound MFA disable', () => {
  it('does not disable an unchanged MFA key using a password proof invalidated by reset', async () => {
    const { handle, principal, session } = await setup({ sealedSecret: sealed() })
    await setPasswordHash(handle.db, principal.id, CHANGED_PASSWORD_HASH)
    expect(await disableTotpForSession(handle.db, {
      principalId: principal.id, sessionId: session.id,
      expectedPasswordHash: ARGON2, expectedSealedSecret: sealed(),
    })).toBe(false)
    expect((await getPrincipal(handle.db, principal.id))?.totpEnabled).toBe(true)
  })

  it('requires the unchanged verified key and clears MFA, pending enrollment and sibling access together', async () => {
    const { handle, principal, session } = await setup({ sealedSecret: sealed(), recoveryHashes: [sha('c')] })
    await consumeTotpStep(handle.db, principal.id, 100, sealed())
    await createSession(handle.db, {
      principalId: principal.id, tokenHash: sha('e'), mfaVerified: true,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })
    await startTotpEnrollment(handle.db, {
      expectedPasswordHash: ARGON2,
      principalId: principal.id, sessionId: session.id, sealedSecret: sealed(6), recoveryHashes: [],
    })
    expect(await disableTotpForSession(handle.db, {
      expectedPasswordHash: ARGON2,
      principalId: principal.id, sessionId: session.id, expectedSealedSecret: sealed(6),
    })).toBe(false)
    expect((await getPrincipal(handle.db, principal.id))?.totpEnabled).toBe(true)
    expect(await findActiveSessionByTokenHash(handle.db, sha('e'))).not.toBeNull()
    expect(await disableTotpForSession(handle.db, {
      expectedPasswordHash: ARGON2,
      principalId: principal.id, sessionId: session.id, expectedSealedSecret: sealed(),
    })).toBe(true)
    const disabled = await getPrincipal(handle.db, principal.id)
    expect(disabled?.totpEnabled).toBe(false)
    expect(disabled?.totpSecretEnc).toBeNull()
    expect(disabled?.totpRecoveryHashes).toEqual([])
    expect(disabled?.totpLastStep).toBeNull()
    expect(await getPendingTotpEnrollment(handle.db, principal.id, session.id)).toBeNull()
    expect(await findActiveSessionByTokenHash(handle.db, sha('e'))).toBeNull()
    expect((await findActiveSessionByTokenHash(handle.db, sha('a')))?.id).toBe(session.id)
  })

  it('rejects a revoked or foreign session without clearing the current MFA key', async () => {
    const { handle, principal, session } = await setup({ sealedSecret: sealed() })
    const other = await createRootPrincipal(handle.db, { username: 'admin', passwordHash: ARGON2 })
    expect(await disableTotpForSession(handle.db, {
      expectedPasswordHash: ARGON2,
      principalId: other.id, sessionId: session.id, expectedSealedSecret: sealed(),
    })).toBe(false)
    await revokeSession(handle.db, session.id)
    expect(await disableTotpForSession(handle.db, {
      expectedPasswordHash: ARGON2,
      principalId: principal.id, sessionId: session.id, expectedSealedSecret: sealed(),
    })).toBe(false)
    expect((await getPrincipal(handle.db, principal.id))?.totpEnabled).toBe(true)
  })

  it('rolls back key removal if sibling revocation cannot commit', async () => {
    const { handle, principal, session } = await setup({ sealedSecret: sealed(), recoveryHashes: [sha('c')] })
    await consumeTotpStep(handle.db, principal.id, 100, sealed())
    await createSession(handle.db, {
      principalId: principal.id, tokenHash: sha('e'), mfaVerified: true,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })
    const pending = await startTotpEnrollment(handle.db, {
      expectedPasswordHash: ARGON2,
      principalId: principal.id, sessionId: session.id, sealedSecret: sealed(6), recoveryHashes: [],
    })
    await handle.db.exec(`CREATE TRIGGER reject_mfa_revoke BEFORE UPDATE OF revoked_at ON sessions
      WHEN NEW.revoked_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'MFA revoke failure'); END`)
    await expect(disableTotpForSession(handle.db, {
      expectedPasswordHash: ARGON2,
      principalId: principal.id, sessionId: session.id, expectedSealedSecret: sealed(),
    })).rejects.toBeDefined()
    const active = await getPrincipal(handle.db, principal.id)
    expect(active?.totpSecretEnc).toEqual(sealed())
    expect(active?.totpRecoveryHashes).toEqual([sha('c')])
    expect(active?.totpLastStep).toBe(100)
    expect(await getPendingTotpEnrollment(handle.db, principal.id, session.id)).toEqual(pending)
    expect(await findActiveSessionByTokenHash(handle.db, sha('e'))).not.toBeNull()
  })
})

describe('login session issuance bound to current verified identity', () => {
  it.each([false, true])('issues a session when the verified password and MFA state remain current (MFA=%s)', async (enabled) => {
    const { handle, principal } = await setup()
    if (enabled) await setTotpSecret(handle.db, principal.id, sealed())
    const session = await createAuthenticatedSession(handle.db, {
      principalId: principal.id, tokenHash: sha('b'), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      expectedPasswordHash: ARGON2, expectedTotpEnabled: enabled,
      expectedSealedSecret: enabled ? sealed() : null, mfaVerified: enabled,
    })
    expect(session?.principalId).toBe(principal.id)
    expect(session?.mfaVerified).toBe(enabled)
    expect((await findActiveSessionByTokenHash(handle.db, sha('b')))?.id).toBe(session?.id)
  })

  it.each(['password reset', 'MFA enable', 'MFA rotation', 'MFA disable', 'principal disable'] as const)(
    'does not issue a login session after %s invalidates its captured identity proof', async (change) => {
      const { handle, principal } = await setup()
      if (change === 'MFA rotation' || change === 'MFA disable') await setTotpSecret(handle.db, principal.id, sealed())
      const captured = (await getPrincipal(handle.db, principal.id))!
      if (change === 'password reset') await setPasswordHash(handle.db, principal.id, CHANGED_PASSWORD_HASH)
      if (change === 'MFA enable' || change === 'MFA rotation') await setTotpSecret(handle.db, principal.id, sealed(6))
      if (change === 'MFA disable') await setTotpSecret(handle.db, principal.id, null)
      if (change === 'principal disable') await handle.db.query('UPDATE principals SET disabled = 1 WHERE id = $1', [principal.id])
      const issued = await createAuthenticatedSession(handle.db, {
        principalId: principal.id, tokenHash: sha('b'), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        expectedPasswordHash: captured.passwordHash, expectedTotpEnabled: captured.totpEnabled,
        expectedSealedSecret: captured.totpSecretEnc, mfaVerified: captured.totpEnabled,
      })
      expect(issued).toBeNull()
      expect(await findActiveSessionByTokenHash(handle.db, sha('b'))).toBeNull()
      const rows = await handle.db.query<{ count: number }>('SELECT count(*) AS count FROM sessions WHERE principal_id = $1', [principal.id])
      expect(rows[0]?.count).toBe(1)
    },
  )
})

describe('atomic password reset', () => {
  it('revokes all previous sessions and clears pending enrollment while preserving the active MFA key and replay barrier', async () => {
    const { handle, principal, session } = await setup({ sealedSecret: sealed(), recoveryHashes: [sha('c')] })
    await consumeTotpStep(handle.db, principal.id, 100, sealed())
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString()
    await createSession(handle.db, { principalId: principal.id, tokenHash: sha('b'), expiresAt, mfaVerified: true })
    const other = await createRootPrincipal(handle.db, { username: 'admin', passwordHash: ARGON2 })
    await createSession(handle.db, { principalId: other.id, tokenHash: sha('c'), expiresAt })
    await startTotpEnrollment(handle.db, {
      principalId: principal.id, sessionId: session.id, sealedSecret: sealed(6),
      recoveryHashes: [], expectedPasswordHash: ARGON2,
    })
    await setPasswordHash(handle.db, principal.id, CHANGED_PASSWORD_HASH)
    const updated = await getPrincipal(handle.db, principal.id)
    expect(updated?.passwordHash).toBe(CHANGED_PASSWORD_HASH)
    expect(updated?.totpSecretEnc).toEqual(sealed())
    expect(updated?.totpRecoveryHashes).toEqual([sha('c')])
    expect(updated?.totpLastStep).toBe(100)
    expect(await findActiveSessionByTokenHash(handle.db, sha('a'))).toBeNull()
    expect(await findActiveSessionByTokenHash(handle.db, sha('b'))).toBeNull()
    expect((await findActiveSessionByTokenHash(handle.db, sha('c')))?.principalId).toBe(other.id)
    const pending = await handle.db.query('SELECT principal_id FROM totp_enrollments WHERE principal_id = $1', [principal.id])
    expect(pending).toEqual([])
  })

  it('retains the old password, enrollment and access if session revocation fails before commit', async () => {
    const { handle, principal, session } = await setup()
    const pending = await startTotpEnrollment(handle.db, {
      principalId: principal.id, sessionId: session.id, sealedSecret: sealed(),
      recoveryHashes: [], expectedPasswordHash: ARGON2,
    })
    await handle.db.exec(`CREATE TRIGGER reject_reset_revoke BEFORE UPDATE OF revoked_at ON sessions
      WHEN NEW.revoked_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'Password reset revoke failure'); END`)
    await expect(setPasswordHash(handle.db, principal.id, CHANGED_PASSWORD_HASH)).rejects.toBeDefined()
    expect((await getPrincipal(handle.db, principal.id))?.passwordHash).toBe(ARGON2)
    expect(await getPendingTotpEnrollment(handle.db, principal.id, session.id)).toEqual(pending)
    expect((await findActiveSessionByTokenHash(handle.db, sha('a')))?.id).toBe(session.id)
  })
})

describe('trusted administrator factor changes', () => {
  it.each(['rotation', 'disable'] as const)('revokes every old session atomically on factor %s', async (change) => {
    const { handle, principal, session } = await setup({ sealedSecret: sealed(), recoveryHashes: [sha('c')] })
    await consumeTotpStep(handle.db, principal.id, 100, sealed())
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString()
    await createSession(handle.db, { principalId: principal.id, tokenHash: sha('b'), expiresAt, mfaVerified: true })
    const other = await createRootPrincipal(handle.db, { username: 'admin', passwordHash: ARGON2 })
    await createSession(handle.db, { principalId: other.id, tokenHash: sha('c'), expiresAt })
    await startTotpEnrollment(handle.db, {
      principalId: principal.id, sessionId: session.id, sealedSecret: sealed(7),
      expectedPasswordHash: ARGON2, recoveryHashes: [],
    })
    await setTotpSecret(handle.db, principal.id, change === 'rotation' ? sealed(6) : null, [sha('d')])
    const changed = await getPrincipal(handle.db, principal.id)
    expect(changed?.totpSecretEnc).toEqual(change === 'rotation' ? sealed(6) : null)
    expect(changed?.totpRecoveryHashes).toEqual(change === 'rotation' ? [sha('d')] : [])
    expect(changed?.totpLastStep).toBeNull()
    expect(await findActiveSessionByTokenHash(handle.db, sha('a'))).toBeNull()
    expect(await findActiveSessionByTokenHash(handle.db, sha('b'))).toBeNull()
    expect((await findActiveSessionByTokenHash(handle.db, sha('c')))?.principalId).toBe(other.id)
    expect(await handle.db.query('SELECT principal_id FROM totp_enrollments WHERE principal_id = $1', [principal.id])).toEqual([])
  })

  it.each(['rotation', 'disable'] as const)('rolls back factor %s and pending cleanup if revoking sessions fails', async (change) => {
    const { handle, principal, session } = await setup({ sealedSecret: sealed(), recoveryHashes: [sha('c')] })
    await consumeTotpStep(handle.db, principal.id, 100, sealed())
    await createSession(handle.db, {
      principalId: principal.id, tokenHash: sha('b'), mfaVerified: true,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })
    const pending = await startTotpEnrollment(handle.db, {
      principalId: principal.id, sessionId: session.id, sealedSecret: sealed(7),
      expectedPasswordHash: ARGON2, recoveryHashes: [],
    })
    await handle.db.exec(`CREATE TRIGGER reject_admin_factor_revoke BEFORE UPDATE OF revoked_at ON sessions
      WHEN NEW.revoked_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'Factor change revoke failure'); END`)
    await expect(setTotpSecret(handle.db, principal.id, change === 'rotation' ? sealed(6) : null)).rejects.toBeDefined()
    const unchanged = await getPrincipal(handle.db, principal.id)
    expect(unchanged?.totpSecretEnc).toEqual(sealed())
    expect(unchanged?.totpRecoveryHashes).toEqual([sha('c')])
    expect(unchanged?.totpLastStep).toBe(100)
    expect(await getPendingTotpEnrollment(handle.db, principal.id, session.id)).toEqual(pending)
    expect((await findActiveSessionByTokenHash(handle.db, sha('a')))?.id).toBe(session.id)
    expect(await findActiveSessionByTokenHash(handle.db, sha('b'))).not.toBeNull()
  })

  it('allows exactly one concurrent recovery code claim and rejects disabled, unenrolled, or rotated principals', async () => {
    const rec1 = sha('1')
    const rec2 = sha('2')
    const { handle, principal } = await setup({ sealedSecret: sealed(), recoveryHashes: [rec1, rec2] })

    const claims = await Promise.all(
      Array.from({ length: 10 }, () =>
        consumeRecoveryHash(handle.db, principal.id, rec1, { expectedSealedSecret: sealed() }),
      ),
    )
    expect(claims.filter(Boolean)).toHaveLength(1)
    expect(await consumeRecoveryHash(handle.db, principal.id, rec1)).toBe(false)
    expect((await getPrincipal(handle.db, principal.id))?.totpRecoveryHashes).toEqual([rec2])

    // Rejects mismatched expectedSealedSecret
    expect(await consumeRecoveryHash(handle.db, principal.id, rec2, { expectedSealedSecret: sealed(9) })).toBe(false)
    expect((await getPrincipal(handle.db, principal.id))?.totpRecoveryHashes).toEqual([rec2])

    // Rejects disabled principal without consuming recovery code
    await handle.db.query('UPDATE principals SET disabled = 1 WHERE id = $1', [principal.id])
    expect(await consumeRecoveryHash(handle.db, principal.id, rec2)).toBe(false)
    await handle.db.query('UPDATE principals SET disabled = 0 WHERE id = $1', [principal.id])
    expect(await consumeRecoveryHash(handle.db, principal.id, rec2)).toBe(true)
    expect(await consumeRecoveryHash(handle.db, principal.id, rec2)).toBe(false)
  })
})
