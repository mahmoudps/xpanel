import { randomUUID } from 'node:crypto'
import {
  assertArgon2Hash,
  assertBool,
  assertId,
  assertIdOrNull,
  assertIsoDate,
  assertPrincipalUsername,
  assertSha256Hex,
  fail,
  isUuid,
  SESSION_ABSOLUTE_TIMEOUT_MS,
  SESSION_IDLE_TIMEOUT_MS,
} from '@xpanel/core'
import type { Id } from '@xpanel/core'
import type { Db } from '../client.ts'
import { withSqliteErrors } from '../sqlite-errors.ts'
import { first, mustExist, nowIso } from './util.ts'
import { appendAudit, type NewAuditEntry } from './audit.ts'
import { revokeAllSessionsForPrincipal, revokeOtherSessionsForPrincipal } from './sessions.ts'
import { revokeAllApiTokensForPrincipal } from './api-tokens.ts'

export type PrincipalKind = 'root' | 'reseller' | 'user'

/** Panel login as the auth layer sees it. The TOTP secret stays sealed. */
export interface PrincipalRecord {
  id: Id
  kind: PrincipalKind
  username: string
  passwordHash: string
  forcePasswordChange: boolean
  totpSecretEnc: Uint8Array | null
  totpEnabled: boolean
  totpRecoveryHashes: string[]
  totpLastStep: number | null
  accountId: Id | null
  disabled: boolean
  lastLoginAt: string | null
  createdAt: string
  updatedAt: string
}

interface PrincipalRow {
  id: string
  kind: PrincipalKind
  username: string
  password_hash: string
  force_password_change: number
  password_changed_at: string
  totp_secret_enc: Uint8Array | null
  totp_enabled_at: string | null
  totp_recovery_hashes: string
  totp_last_step: number | null
  account_id: string | null
  disabled: number
  last_login_at: string | null
  created_at: string
  updated_at: string
  [k: string]: unknown
}

const fromRow = (r: PrincipalRow): PrincipalRecord => ({
  id: r.id,
  kind: r.kind,
  username: r.username,
  passwordHash: r.password_hash,
  forcePasswordChange: Boolean(r.force_password_change),
  totpSecretEnc: r.totp_secret_enc ? new Uint8Array(r.totp_secret_enc) : null,
  totpEnabled: r.totp_enabled_at !== null,
  totpRecoveryHashes: JSON.parse(r.totp_recovery_hashes) as string[],
  totpLastStep: r.totp_last_step,
  accountId: r.account_id,
  disabled: Boolean(r.disabled),
  lastLoginAt: r.last_login_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

const createPrincipalInternal = (
  db: Db,
  input: {
    id?: Id
    kind: PrincipalKind
    username: string
    passwordHash: string
    forcePasswordChange?: boolean
    accountId?: Id | null
    disabled?: boolean
  },
): Promise<PrincipalRecord> =>
  withSqliteErrors(async () => {
    const id = input.id !== undefined ? assertId(input.id, 'id') : randomUUID()
    const username = assertPrincipalUsername(input.username)
    const passwordHash = assertArgon2Hash(input.passwordHash)
    const forcePasswordChange = input.forcePasswordChange ?? (input.kind === 'root')
    const accountId = assertIdOrNull(input.accountId ?? null, 'accountId')
    if (input.kind === 'user' && accountId === null) {
      fail('VALIDATION', 'user principal requires accountId')
    }
    if (input.kind !== 'user' && accountId !== null) {
      fail('VALIDATION', `${input.kind} principal must not have accountId`)
    }
    const disabled = assertBool(input.disabled ?? false, 'disabled')
    const now = nowIso()
    const rows = await db.query<PrincipalRow>(
      `INSERT INTO principals (
        id, kind, username, password_hash, force_password_change,
        password_changed_at, account_id, disabled, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
      [id, input.kind, username, passwordHash, forcePasswordChange ? 1 : 0, now, accountId, disabled ? 1 : 0, now, now],
    )
    return fromRow(mustExist(rows[0], 'principal', username))
  })

/** Root login principal. */
export const createRootPrincipal = (
  db: Db,
  input: { id?: Id; username: string; passwordHash: string; forcePasswordChange?: boolean },
): Promise<PrincipalRecord> =>
  createPrincipalInternal(db, {
    ...input,
    kind: 'root',
    forcePasswordChange: input.forcePasswordChange ?? true,
  })

/** Reseller login principal (id matches the reseller's desired-state id). */
export const createResellerPrincipal = (
  db: Db,
  input: { id?: Id; username: string; passwordHash: string; forcePasswordChange?: boolean; disabled?: boolean },
): Promise<PrincipalRecord> =>
  createPrincipalInternal(db, {
    ...input,
    kind: 'reseller',
    forcePasswordChange: input.forcePasswordChange ?? false,
  })

/** Account owner login principal (linked to `accountId`). */
export const createUserPrincipal = (
  db: Db,
  input: {
    id?: Id
    username: string
    passwordHash: string
    accountId: Id
    forcePasswordChange?: boolean
    disabled?: boolean
  },
): Promise<PrincipalRecord> =>
  createPrincipalInternal(db, {
    ...input,
    kind: 'user',
    forcePasswordChange: input.forcePasswordChange ?? false,
  })

export const getPrincipal = async (db: Db, id: Id): Promise<PrincipalRecord | null> => {
  if (!isUuid(id)) return null
  const rows = await db.query<PrincipalRow>(`SELECT * FROM principals WHERE id = $1`, [id.toLowerCase()])
  const row = first(rows)
  return row ? fromRow(row) : null
}

/** Case-insensitive lookup by username. */
export const findPrincipalByUsername = async (db: Db, username: string): Promise<PrincipalRecord | null> => {
  if (typeof username !== 'string' || username.length === 0 || username.length > 64) return null
  const rows = await db.query<PrincipalRow>(`SELECT * FROM principals WHERE lower(username) = $1`, [username.toLowerCase()])
  const row = first(rows)
  return row ? fromRow(row) : null
}

export const findPrincipalByAccountId = async (db: Db, accountId: Id): Promise<PrincipalRecord | null> => {
  if (!isUuid(accountId)) return null
  const rows = await db.query<PrincipalRow>(`SELECT * FROM principals WHERE account_id = $1`, [accountId.toLowerCase()])
  const row = first(rows)
  return row ? fromRow(row) : null
}

export interface AccountAccessRevocationResult {
  /** Internal identity references for the caller; never public document numbers. */
  principalIds: Id[]
  /** Newly revoked rows, including expired rows that had not previously been revoked. */
  revokedSessions: number
  revokedApiTokens: number
  removedTotpEnrollments: number
}

/**
 * Revokes every linked identity's sessions, API tokens and pending MFA enrollment together.
 * The caller must first persist its authorized account suspension/access hold. This helper
 * does not change identity, password, active MFA or manual-disabled state, and cannot block
 * a new login by itself. Retrying preserves previous revocation timestamps.
 */
export const revokeAccountSessionsAndTokens = (
  db: Db, accountId: Id,
): Promise<AccountAccessRevocationResult> =>
  withSqliteErrors(async () => {
    const aid = assertId(accountId, 'accountId')
    return db.transaction(async (tx) => {
      const principals = await tx.query<{ id: string }>(
        'SELECT id FROM principals WHERE account_id = $1 ORDER BY id', [aid],
      )
      const principalIds = principals.map(principal => principal.id)
      if (principalIds.length === 0) {
        return { principalIds, revokedSessions: 0, revokedApiTokens: 0, removedTotpEnrollments: 0 }
      }
      const now = nowIso()
      const enrollments = await tx.query<{ principal_id: string }>(
        'DELETE FROM totp_enrollments ' +
        'WHERE principal_id IN (SELECT id FROM principals WHERE account_id = $1) RETURNING principal_id',
        [aid],
      )
      const sessions = await tx.query<{ id: string }>(
        'UPDATE sessions SET revoked_at = $1 WHERE revoked_at IS NULL ' +
        'AND principal_id IN (SELECT id FROM principals WHERE account_id = $2) RETURNING id',
        [now, aid],
      )
      const tokens = await tx.query<{ id: string }>(
        'UPDATE api_tokens SET revoked_at = $1 WHERE revoked_at IS NULL ' +
        'AND principal_id IN (SELECT id FROM principals WHERE account_id = $2) RETURNING id',
        [now, aid],
      )
      return {
        principalIds,
        revokedSessions: sessions.length,
        revokedApiTokens: tokens.length,
        removedTotpEnrollments: enrollments.length,
      }
    })
  })

/** Commits the new password, invalidates enrollment, and revokes every previous session and API token together. */
export const setPasswordHash = (
  db: Db,
  id: Id,
  passwordHash: string,
  opts: { forceChange?: boolean; clearLockout?: boolean; audit?: NewAuditEntry } = {},
): Promise<void> =>
  withSqliteErrors(() => db.transaction(async (tx) => {
    const pid = assertId(id, 'id')
    const hash = assertArgon2Hash(passwordHash)
    const force = assertBool(opts.forceChange ?? false, 'forceChange')
    const now = nowIso()
    const rows = await tx.query<{ id: string; username: string }>(
      `UPDATE principals
       SET password_hash = $1, force_password_change = $2, password_changed_at = $3, updated_at = $4
       WHERE id = $5
       RETURNING id, username`,
      [hash, force ? 1 : 0, now, now, pid],
    )
    const updated = mustExist(rows[0], 'principal', id)
    await tx.query('DELETE FROM totp_enrollments WHERE principal_id = $1', [pid])
    await revokeAllSessionsForPrincipal(tx, pid)
    await revokeAllApiTokensForPrincipal(tx, pid)
    if (opts.clearLockout) {
      const uname = updated.username.toLowerCase()
      await tx.query(`DELETE FROM login_failure_counters WHERE subject_kind = 'username' AND subject_value = $1`, [uname])
      await tx.query(`DELETE FROM lockouts WHERE lower(username) = $1`, [uname])
    }
    if (opts.audit) {
      await appendAudit(tx, opts.audit)
    }
  }))

export interface PasswordChangeForSessionInput {
  principalId: Id
  sessionId: Id
  expectedPasswordHash: string
  newPasswordHash: string
  expectedTotpEnabled: boolean
  expectedSealedSecret: Uint8Array | null
  expectedForcePasswordChange: boolean
}

/** Rechecks the verified identity and session in the update that commits a fresh-login-only password change. */
export const changePasswordForSession = (db: Db, input: PasswordChangeForSessionInput): Promise<boolean> =>
  withSqliteErrors(() => db.transaction(async (tx) => {
    const pid = assertId(input.principalId, 'principalId')
    const sid = assertId(input.sessionId, 'sessionId')
    const expectedHash = assertArgon2Hash(input.expectedPasswordHash)
    const replacement = assertArgon2Hash(input.newPasswordHash)
    const enabled = assertBool(input.expectedTotpEnabled, 'expectedTotpEnabled')
    const forced = assertBool(input.expectedForcePasswordChange, 'expectedForcePasswordChange')
    const secret = input.expectedSealedSecret
    if (enabled) {
      if (secret === null) return fail('VALIDATION', 'expected MFA state and sealed key must agree')
      assertSealedTotpSecret(secret)
    } else if (secret !== null) fail('VALIDATION', 'expected MFA state and sealed key must agree')
    const now = nowIso()
    const [, idleAfter, createdAfter] = enrollmentSessionBounds(now)
    const rows = await tx.query<{ id: string }>(
      `UPDATE principals SET password_hash = $1, force_password_change = 0,
         password_changed_at = $2, updated_at = $2
       WHERE id = $3 AND disabled = 0 AND password_hash = $4 AND force_password_change = $5
         AND (totp_enabled_at IS NOT NULL) = $6 AND totp_secret_enc IS $7
         AND EXISTS (SELECT 1 FROM sessions s WHERE s.id = $8 AND s.principal_id = principals.id
           AND s.revoked_at IS NULL AND s.expires_at > $2 AND s.last_seen_at > $9 AND s.created_at > $10
           AND (principals.totp_enabled_at IS NULL OR s.mfa_verified = 1))
       RETURNING id`,
      [replacement, now, pid, expectedHash, forced ? 1 : 0, enabled ? 1 : 0, secret, sid, idleAfter, createdAfter],
    )
    if (rows.length !== 1) return false
    await tx.query('DELETE FROM totp_enrollments WHERE principal_id = $1', [pid])
    await revokeAllSessionsForPrincipal(tx, pid)
    await revokeAllApiTokensForPrincipal(tx, pid)
    return true
  }))

/** Trusted administrator factor reset; the key, pending enrollment and all prior credentials change in one commit. */
export const setTotpSecret = (
  db: Db,
  id: Id,
  sealed: Uint8Array | null,
  recoveryHashes: readonly string[] = [],
  opts: { clearLockout?: boolean; audit?: NewAuditEntry } = {},
): Promise<void> =>
  withSqliteErrors(() => db.transaction(async (tx) => {
    const pid = assertId(id, 'id')
    if (sealed !== null) assertSealedTotpSecret(sealed)
    if (recoveryHashes.length > 32) fail('VALIDATION', 'at most 32 recovery hashes are supported')
    const hashes = sealed ? [...new Set(recoveryHashes.map((h) => assertSha256Hex(h, 'recoveryHash')))] : []
    const now = nowIso()
    const rows = await tx.query<{ id: string; username: string }>(
      `UPDATE principals
       SET totp_last_step = CASE WHEN $1 IS NOT NULL AND totp_secret_enc = $1 THEN totp_last_step ELSE NULL END,
           totp_secret_enc = $1, totp_enabled_at = $2, totp_recovery_hashes = $3, updated_at = $4
       WHERE id = $5
       RETURNING id, username`,
      [sealed, sealed ? now : null, JSON.stringify(hashes), now, pid],
    )
    const updated = mustExist(rows[0], 'principal', id)
    await tx.query('DELETE FROM totp_enrollments WHERE principal_id = $1', [pid])
    await revokeAllSessionsForPrincipal(tx, pid)
    await revokeAllApiTokensForPrincipal(tx, pid)
    if (opts.clearLockout) {
      const uname = updated.username.toLowerCase()
      await tx.query(`DELETE FROM login_failure_counters WHERE subject_kind = 'username' AND subject_value = $1`, [uname])
      await tx.query(`DELETE FROM lockouts WHERE lower(username) = $1`, [uname])
    }
    if (opts.audit) {
      await appendAudit(tx, opts.audit)
    }
  }))

const assertSealedTotpSecret = (sealed: Uint8Array): void => {
  if (!(sealed instanceof Uint8Array) || sealed.byteLength < 16 || sealed.byteLength > 1024) {
    fail('VALIDATION', 'sealed TOTP secret must be 16..1024 bytes')
  }
}

const assertTotpStep = (step: number): number => {
  if (!Number.isSafeInteger(step) || step < 0) fail('VALIDATION', 'TOTP step must be a non-negative safe integer')
  return step
}

/** Claims a verified TOTP time step once, including across independent processes. */
export const consumeTotpStep = (
  db: Db, principalId: Id, step: number, expectedSealedSecret: Uint8Array,
): Promise<boolean> =>
  withSqliteErrors(async () => {
    const pid = assertId(principalId, 'principalId')
    const value = assertTotpStep(step)
    assertSealedTotpSecret(expectedSealedSecret)
    const rows = await db.query<{ id: string }>(
      `UPDATE principals SET totp_last_step = $1, updated_at = $2
       WHERE id = $3 AND disabled = 0 AND totp_enabled_at IS NOT NULL AND totp_secret_enc = $4
         AND (totp_last_step IS NULL OR totp_last_step < $1)
       RETURNING id`,
      [value, nowIso(), pid, expectedSealedSecret],
    )
    return rows.length === 1
  })

export const TOTP_ENROLLMENT_TTL_MS = 5 * 60_000

export interface PendingTotpEnrollment {
  enrollmentId: Id
  sealedSecret: Uint8Array
  recoveryHashes: string[]
  expiresAt: string
}

interface TotpEnrollmentRow {
  enrollment_id: string
  sealed_secret: Uint8Array
  recovery_hashes: string
  expires_at: string
  [key: string]: unknown
}

const enrollmentFromRow = (row: TotpEnrollmentRow): PendingTotpEnrollment => ({
  enrollmentId: row.enrollment_id,
  sealedSecret: new Uint8Array(row.sealed_secret),
  recoveryHashes: JSON.parse(row.recovery_hashes) as string[],
  expiresAt: row.expires_at,
})

const activeEnrollmentSession = async (
  db: Db, principalId: Id, sessionId: Id, now: string, expectedPasswordHash: string,
): Promise<boolean> => {
  const rows = await db.query<{ id: string }>(
    `SELECT s.id FROM sessions s JOIN principals p ON p.id = s.principal_id
     WHERE s.id = $1 AND s.principal_id = $2 AND s.revoked_at IS NULL
       AND s.expires_at > $3 AND p.disabled = 0 AND s.last_seen_at > $4 AND s.created_at > $5
       AND p.password_hash = $6`,
    [sessionId, principalId, ...enrollmentSessionBounds(now), expectedPasswordHash],
  )
  return rows.length === 1
}

const enrollmentSessionBounds = (now: string): [string, string, string] => [
  now,
  new Date(Date.parse(now) - SESSION_IDLE_TIMEOUT_MS).toISOString(),
  new Date(Date.parse(now) - SESSION_ABSOLUTE_TIMEOUT_MS).toISOString(),
]

/** Replaces a pending enrollment without activating its sealed key. */
export const startTotpEnrollment = (
  db: Db,
  input: {
    principalId: Id; sessionId: Id; sealedSecret: Uint8Array; recoveryHashes: readonly string[];
    expectedPasswordHash: string; now?: string
  },
): Promise<PendingTotpEnrollment> =>
  withSqliteErrors(() => db.transaction(async (tx) => {
    const pid = assertId(input.principalId, 'principalId')
    const sid = assertId(input.sessionId, 'sessionId')
    const expectedPasswordHash = assertArgon2Hash(input.expectedPasswordHash)
    assertSealedTotpSecret(input.sealedSecret)
    if (input.recoveryHashes.length > 32) fail('VALIDATION', 'at most 32 recovery hashes are supported')
    const hashes = [...new Set(input.recoveryHashes.map((hash) => assertSha256Hex(hash, 'recoveryHash')))]
    const now = assertIsoDate(input.now ?? nowIso(), 'now').toISOString()
    if (!(await activeEnrollmentSession(tx, pid, sid, now, expectedPasswordHash))) {
      fail('PRECONDITION_FAILED', 'TOTP enrollment requires an active session belonging to the principal')
    }
    const enrollmentId = randomUUID()
    const expiresAt = new Date(Date.parse(now) + TOTP_ENROLLMENT_TTL_MS).toISOString()
    const rows = await tx.query<TotpEnrollmentRow>(
      `INSERT INTO totp_enrollments (principal_id, enrollment_id, session_id, sealed_secret, recovery_hashes, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (principal_id) DO UPDATE SET enrollment_id = excluded.enrollment_id,
         session_id = excluded.session_id, sealed_secret = excluded.sealed_secret,
         recovery_hashes = excluded.recovery_hashes, created_at = excluded.created_at, expires_at = excluded.expires_at
       RETURNING *`,
      [pid, enrollmentId, sid, input.sealedSecret, JSON.stringify(hashes), now, expiresAt],
    )
    return enrollmentFromRow(mustExist(rows[0], 'TOTP enrollment', pid))
  }))

/** Reads only the unexpired enrollment initiated by this still-active session. */
export const getPendingTotpEnrollment = async (
  db: Db, principalId: Id, sessionId: Id, now: string = nowIso(),
): Promise<PendingTotpEnrollment | null> => {
  const pid = assertId(principalId, 'principalId')
  const sid = assertId(sessionId, 'sessionId')
  const at = assertIsoDate(now, 'now').toISOString()
  const rows = await db.query<TotpEnrollmentRow>(
    `SELECT e.* FROM totp_enrollments e
     JOIN sessions s ON s.id = e.session_id AND s.principal_id = e.principal_id
     JOIN principals p ON p.id = e.principal_id
     WHERE e.principal_id = $1 AND e.session_id = $2 AND e.expires_at > $3
       AND s.revoked_at IS NULL AND s.expires_at > $3 AND p.disabled = 0
       AND s.last_seen_at > $4 AND s.created_at > $5`,
    [pid, sid, ...enrollmentSessionBounds(at)],
  )
  return rows[0] ? enrollmentFromRow(rows[0]) : null
}

/** The enrollment identity binds completion to the exact key the caller verified. */
export const completeTotpEnrollment = (
  db: Db, input: { principalId: Id; sessionId: Id; enrollmentId: Id; step: number; now?: string },
): Promise<boolean> =>
  withSqliteErrors(() => db.transaction(async (tx) => {
    const pid = assertId(input.principalId, 'principalId')
    const sid = assertId(input.sessionId, 'sessionId')
    const eid = assertId(input.enrollmentId, 'enrollmentId')
    const step = assertTotpStep(input.step)
    const now = assertIsoDate(input.now ?? nowIso(), 'now').toISOString()
    const pending = await getPendingTotpEnrollment(tx, pid, sid, now)
    if (!pending || pending.enrollmentId !== eid) return false
    const rows = await tx.query<{ id: string }>(
      `UPDATE principals SET totp_secret_enc = $1, totp_enabled_at = $2,
         totp_recovery_hashes = $3, totp_last_step = $4, updated_at = $2
       WHERE id = $5 AND disabled = 0 RETURNING id`,
      [pending.sealedSecret, now, JSON.stringify(pending.recoveryHashes), step, pid],
    )
    if (rows.length !== 1) return false
    await tx.query('DELETE FROM totp_enrollments WHERE principal_id = $1 AND enrollment_id = $2', [pid, eid])
    await revokeOtherSessionsForPrincipal(tx, pid, sid)
    await revokeAllApiTokensForPrincipal(tx, pid)
    await tx.query('UPDATE sessions SET mfa_verified = 1, last_seen_at = $1 WHERE id = $2', [now, sid])
    return true
  }))

/** Keeps the reauthenticated session while changing the MFA key and sibling access in one commit. */
export const disableTotpForSession = (
  db: Db, input: { principalId: Id; sessionId: Id; expectedSealedSecret: Uint8Array; expectedPasswordHash: string },
): Promise<boolean> =>
  withSqliteErrors(() => db.transaction(async (tx) => {
    const pid = assertId(input.principalId, 'principalId')
    const sid = assertId(input.sessionId, 'sessionId')
    const expectedPasswordHash = assertArgon2Hash(input.expectedPasswordHash)
    assertSealedTotpSecret(input.expectedSealedSecret)
    const now = nowIso()
    if (!(await activeEnrollmentSession(tx, pid, sid, now, expectedPasswordHash))) return false
    const rows = await tx.query<{ id: string }>(
      `UPDATE principals SET totp_secret_enc = NULL, totp_enabled_at = NULL,
         totp_recovery_hashes = '[]', totp_last_step = NULL, updated_at = $1
       WHERE id = $2 AND totp_secret_enc = $3 AND disabled = 0 RETURNING id`,
      [now, pid, input.expectedSealedSecret],
    )
    if (rows.length !== 1) return false
    await tx.query('DELETE FROM totp_enrollments WHERE principal_id = $1', [pid])
    await revokeOtherSessionsForPrincipal(tx, pid, sid)
    await revokeAllApiTokensForPrincipal(tx, pid)
    return true
  }))

/** Atomically consumes one recovery code hash if present; returns true when matched. */
export const consumeRecoveryHash = (
  db: Db,
  id: Id,
  hash: string,
  opts: { expectedSealedSecret?: Uint8Array } = {},
): Promise<boolean> =>
  withSqliteErrors(() =>
    db.transaction(async (tx) => {
      const pid = assertId(id, 'id')
      const target = assertSha256Hex(hash, 'recoveryHash')
      if (opts.expectedSealedSecret !== undefined) assertSealedTotpSecret(opts.expectedSealedSecret)
      const current = await getPrincipal(tx, pid)
      if (!current || current.disabled || !current.totpEnabled || !current.totpSecretEnc) return false
      if (
        opts.expectedSealedSecret !== undefined &&
        Buffer.compare(Buffer.from(current.totpSecretEnc), Buffer.from(opts.expectedSealedSecret)) !== 0
      ) {
        return false
      }
      if (!current.totpRecoveryHashes.includes(target)) return false
      const remaining = current.totpRecoveryHashes.filter((h) => h !== target)
      const rows = await tx.query<{ id: string }>(
        `UPDATE principals
         SET totp_recovery_hashes = $1, updated_at = $2
         WHERE id = $3 AND disabled = 0 AND totp_enabled_at IS NOT NULL AND totp_recovery_hashes = $4
         RETURNING id`,
        [JSON.stringify(remaining), nowIso(), pid, JSON.stringify(current.totpRecoveryHashes)],
      )
      return rows.length === 1
    }),
  )

export const recordLogin = (db: Db, id: Id): Promise<void> =>
  withSqliteErrors(async () => {
    const pid = assertId(id, 'id')
    const now = nowIso()
    await db.query(`UPDATE principals SET last_login_at = $1, updated_at = $2 WHERE id = $3`, [now, now, pid])
  })

export const setPrincipalDisabled = (db: Db, id: Id, disabled: boolean): Promise<void> =>
  withSqliteErrors(() =>
    db.transaction(async (tx) => {
      const pid = assertId(id, 'id')
      const flag = assertBool(disabled, 'disabled')
      const rows = await tx.query<{ id: string }>(
        `UPDATE principals SET disabled = $1, updated_at = $2 WHERE id = $3 RETURNING id`,
        [flag ? 1 : 0, nowIso(), pid],
      )
      mustExist(rows[0], 'principal', id)
      if (flag) {
        await tx.query('DELETE FROM totp_enrollments WHERE principal_id = $1', [pid])
        await revokeAllSessionsForPrincipal(tx, pid)
        await revokeAllApiTokensForPrincipal(tx, pid)
      }
    }),
  )

export const deletePrincipal = (db: Db, id: Id): Promise<void> =>
  withSqliteErrors(async () => {
    const pid = assertId(id, 'id')
    const rows = await db.query<{ id: string }>(`DELETE FROM principals WHERE id = $1 RETURNING id`, [pid])
    mustExist(rows[0], 'principal', id)
  })

export * from '../identity-recovery.ts'
