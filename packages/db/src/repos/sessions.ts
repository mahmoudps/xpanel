import { randomUUID } from 'node:crypto'
import {
  assertArgon2Hash,
  assertBool,
  assertId,
  assertIp,
  assertIsoDate,
  assertLine,
  assertSha256Hex,
  fail,
  isUuid,
} from '@xpanel/core'
import type { Id } from '@xpanel/core'
import type { Db } from '../client.ts'
import { withSqliteErrors } from '../sqlite-errors.ts'
import { first, mustExist, nowIso } from './util.ts'

export interface SessionRecord {
  id: Id
  principalId: Id
  tokenHash: string
  ip: string | null
  userAgent: string | null
  mfaVerified: boolean
  createdAt: string
  lastSeenAt: string
  expiresAt: string
  revokedAt: string | null
}

interface SessionRow {
  id: string
  principal_id: string
  token_hash: string
  ip: string | null
  user_agent: string | null
  mfa_verified: number
  created_at: string
  last_seen_at: string
  expires_at: string
  revoked_at: string | null
  [k: string]: unknown
}

const fromRow = (r: SessionRow): SessionRecord => ({
  id: r.id,
  principalId: r.principal_id,
  tokenHash: r.token_hash,
  ip: r.ip,
  userAgent: r.user_agent,
  mfaVerified: Boolean(r.mfa_verified),
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
  expiresAt: r.expires_at,
  revokedAt: r.revoked_at,
})

export interface NewSession {
  principalId: Id
  tokenHash: string
  expiresAt: string
  ip?: string | null
  userAgent?: string | null
  mfaVerified?: boolean
}

const prepareSession = (input: NewSession): SessionRecord => {
  const principalId = assertId(input.principalId, 'principalId')
  const tokenHash = assertSha256Hex(input.tokenHash, 'tokenHash')
  const expiresAt = assertIsoDate(input.expiresAt, 'expiresAt').toISOString()
  const now = nowIso()
  if (Date.parse(expiresAt) <= Date.parse(now)) fail('VALIDATION', 'session expiresAt must be in the future')
  const ip = input.ip == null ? null : assertIp(typeof input.ip === 'string' ? input.ip.trim() : input.ip, 'ip')
  const userAgent = input.userAgent == null
    ? null : assertLine(input.userAgent.slice(0, 512), 512, 'userAgent', { allowEmpty: true })
  const mfaVerified = assertBool(input.mfaVerified ?? false, 'mfaVerified')
  return { id: randomUUID(), principalId, tokenHash, ip, userAgent, mfaVerified,
    createdAt: now, lastSeenAt: now, expiresAt, revokedAt: null }
}

const sessionInsertValues = (session: SessionRecord): unknown[] => [
  session.id, session.principalId, session.tokenHash, session.ip, session.userAgent,
  session.mfaVerified ? 1 : 0, session.createdAt, session.lastSeenAt, session.expiresAt,
]

const SESSION_INSERT = `INSERT INTO sessions (
  id, principal_id, token_hash, ip, user_agent, mfa_verified, created_at, last_seen_at, expires_at
)`

export const createSession = (db: Db, input: NewSession): Promise<SessionRecord> =>
  withSqliteErrors(async () => {
    const session = prepareSession(input)
    const rows = await db.query<SessionRow>(
      `${SESSION_INSERT} VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      sessionInsertValues(session),
    )
    return fromRow(mustExist(rows[0], 'session', session.id))
  })

/** Issues a login session only if the identity verified outside this statement is still current. */
export const createAuthenticatedSession = (
  db: Db,
  input: NewSession & { expectedPasswordHash: string; expectedTotpEnabled: boolean; expectedSealedSecret: Uint8Array | null },
): Promise<SessionRecord | null> =>
  withSqliteErrors(async () => {
    const session = prepareSession(input)
    const passwordHash = assertArgon2Hash(input.expectedPasswordHash)
    const enabled = assertBool(input.expectedTotpEnabled, 'expectedTotpEnabled')
    const secret = input.expectedSealedSecret
    if (enabled ? !(secret instanceof Uint8Array) || secret.byteLength < 16 || secret.byteLength > 1024 : secret !== null) {
      fail('VALIDATION', 'expected MFA state and sealed key must agree')
    }
    const rows = await db.query<SessionRow>(
      `${SESSION_INSERT} SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9 FROM principals
       WHERE id = $2 AND password_hash = $10 AND disabled = 0
         AND (totp_enabled_at IS NOT NULL) = $11 AND totp_secret_enc IS $12
       RETURNING *`,
      [...sessionInsertValues(session), passwordHash, enabled ? 1 : 0, secret],
    )
    return rows[0] ? fromRow(rows[0]) : null
  })

export const findActiveSessionByTokenHash = async (
  db: Db,
  tokenHash: string,
  now: string = nowIso(),
): Promise<SessionRecord | null> => {
  if (typeof tokenHash !== 'string' || !/^[0-9a-f]{64}$/i.test(tokenHash)) return null
  const rows = await db.query<SessionRow>(
    `SELECT * FROM sessions WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2`,
    [tokenHash.toLowerCase(), now],
  )
  const row = first(rows)
  return row ? fromRow(row) : null
}

export const touchSession = (db: Db, id: Id, now: string = nowIso()): Promise<void> =>
  withSqliteErrors(async () => {
    const sid = assertId(id, 'id')
    await db.query(`UPDATE sessions SET last_seen_at = $1 WHERE id = $2`, [assertIsoDate(now, 'now').toISOString(), sid])
  })

export const markSessionMfaVerified = (db: Db, id: Id): Promise<SessionRecord> =>
  withSqliteErrors(async () => {
    const sid = assertId(id, 'id')
    const rows = await db.query<SessionRow>(
      `UPDATE sessions SET mfa_verified = 1, last_seen_at = $1 WHERE id = $2 AND revoked_at IS NULL RETURNING *`,
      [nowIso(), sid],
    )
    return fromRow(mustExist(rows[0], 'session', id))
  })

export const revokeSession = (db: Db, id: Id): Promise<void> =>
  withSqliteErrors(async () => {
    const sid = assertId(id, 'id')
    const rows = await db.query<{ id: string }>(
      `UPDATE sessions SET revoked_at = coalesce(revoked_at, $1) WHERE id = $2 RETURNING id`,
      [nowIso(), sid],
    )
    mustExist(rows[0], 'session', id)
  })

export const revokeAllSessionsForPrincipal = (db: Db, principalId: Id): Promise<number> =>
  withSqliteErrors(async () => {
    const pid = assertId(principalId, 'principalId')
    const rows = await db.query<{ id: string }>(
      `UPDATE sessions SET revoked_at = $1 WHERE principal_id = $2 AND revoked_at IS NULL RETURNING id`,
      [nowIso(), pid],
    )
    return rows.length
  })

/** Revokes sibling sessions after an identity change, preserving the initiating session. */
export const revokeOtherSessionsForPrincipal = (db: Db, principalId: Id, exceptSessionId: Id): Promise<number> =>
  withSqliteErrors(async () => {
    const pid = assertId(principalId, 'principalId')
    const sid = assertId(exceptSessionId, 'exceptSessionId')
    const rows = await db.query<{ id: string }>(
      `UPDATE sessions SET revoked_at = $1
       WHERE principal_id = $2 AND id <> $3 AND revoked_at IS NULL RETURNING id`,
      [nowIso(), pid, sid],
    )
    return rows.length
  })

export const listSessionsForPrincipal = async (db: Db, principalId: Id): Promise<SessionRecord[]> => {
  if (!isUuid(principalId)) return []
  const rows = await db.query<SessionRow>(
    `SELECT * FROM sessions WHERE principal_id = $1 ORDER BY last_seen_at DESC`,
    [principalId.toLowerCase()],
  )
  return rows.map(fromRow)
}
