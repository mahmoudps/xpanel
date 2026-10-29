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
  /** Set only for a session opened through a one-time panel handoff: the issuing principal and its display login. */
  impersonatorPrincipalId: Id | null
  impersonatorLogin: string | null
  /** A team member issuer: `impersonatorPrincipalId` is then the owning account's principal. */
  impersonatorTeamMemberId: Id | null
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
  impersonator_principal_id: string | null
  impersonator_login: string | null
  impersonator_team_member_id: string | null
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
  impersonatorPrincipalId: r.impersonator_principal_id ?? null,
  impersonatorLogin: r.impersonator_login ?? null,
  impersonatorTeamMemberId: r.impersonator_team_member_id ?? null,
})

export interface NewSession {
  principalId: Id
  tokenHash: string
  expiresAt: string
  ip?: string | null
  userAgent?: string | null
  mfaVerified?: boolean
  impersonator?: { principalId: Id; login: string; teamMemberId?: Id }
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
  const impersonatorPrincipalId = input.impersonator ? assertId(input.impersonator.principalId, 'impersonatorPrincipalId') : null
  const impersonatorLogin = input.impersonator ? assertLine(input.impersonator.login, 254, 'impersonatorLogin', { allowEmpty: false }) : null
  const impersonatorTeamMemberId = input.impersonator?.teamMemberId === undefined ? null : assertId(input.impersonator.teamMemberId, 'impersonatorTeamMemberId')
  if (impersonatorPrincipalId === principalId) fail('VALIDATION', 'a session cannot impersonate its own principal')
  return { id: randomUUID(), principalId, tokenHash, ip, userAgent, mfaVerified,
    createdAt: now, lastSeenAt: now, expiresAt, revokedAt: null, impersonatorPrincipalId, impersonatorLogin, impersonatorTeamMemberId }
}

const sessionInsertValues = (session: SessionRecord): unknown[] => [
  session.id, session.principalId, session.tokenHash, session.ip, session.userAgent,
  session.mfaVerified ? 1 : 0, session.createdAt, session.lastSeenAt, session.expiresAt,
  session.impersonatorPrincipalId, session.impersonatorLogin, session.impersonatorTeamMemberId,
]

const SESSION_INSERT = `INSERT INTO sessions (
  id, principal_id, token_hash, ip, user_agent, mfa_verified, created_at, last_seen_at, expires_at,
  impersonator_principal_id, impersonator_login, impersonator_team_member_id
)`

export const createSession = (db: Db, input: NewSession): Promise<SessionRecord> =>
  withSqliteErrors(async () => {
    const session = prepareSession(input)
    const rows = await db.query<SessionRow>(
      `${SESSION_INSERT} VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
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
      `${SESSION_INSERT} SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12 FROM principals
       WHERE id = $2 AND password_hash = $13 AND disabled = 0
         AND (totp_enabled_at IS NOT NULL) = $14 AND totp_secret_enc IS $15
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
