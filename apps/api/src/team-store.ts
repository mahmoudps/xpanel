import { randomUUID } from 'node:crypto'
import { assertArgon2Hash, assertId, assertIp, assertLine, assertSha256Hex, fail } from '@xpanel/core'
import type { Db } from '@xpanel/db'

/** Migration 0005 rows. Members themselves live in the account team file; these rows only authenticate. */
export interface TeamCredential {
  memberId: string; accountId: string; passwordHash: string | null; passwordSetAt: string | null
  linkExpiresAt: string | null; lastLoginAt: string | null
}
export interface TeamSessionRecord {
  id: string; memberId: string; accountId: string; ownerPrincipalId: string; login: string
  createdAt: string; lastSeenAt: string; expiresAt: string
}
type Row = Record<string, unknown>
const text = (value: unknown): string => value as string
const nullable = (value: unknown): string | null => value === null ? null : value as string
const credentialOf = (row: Row): TeamCredential => ({ memberId: text(row.member_id), accountId: text(row.account_id), passwordHash: nullable(row.password_hash),
  passwordSetAt: nullable(row.password_set_at), linkExpiresAt: nullable(row.link_expires_at), lastLoginAt: nullable(row.last_login_at) })
const sessionOf = (row: Row): TeamSessionRecord => ({ id: text(row.id), memberId: text(row.member_id), accountId: text(row.account_id), ownerPrincipalId: text(row.owner_principal_id),
  login: text(row.login), createdAt: text(row.created_at), lastSeenAt: text(row.last_seen_at), expiresAt: text(row.expires_at) })
const stamp = (value: Date): string => value.toISOString()

export const getTeamCredential = async (db: Db, memberId: string): Promise<TeamCredential | null> => {
  const rows = await db.query<Row>('SELECT * FROM team_credentials WHERE member_id = $1', [assertId(memberId, 'memberId')])
  return rows[0] ? credentialOf(rows[0]) : null
}
export const listTeamCredentials = async (db: Db, accountId: string): Promise<TeamCredential[]> =>
  (await db.query<Row>('SELECT * FROM team_credentials WHERE account_id = $1 ORDER BY member_id', [assertId(accountId, 'accountId')])).map(credentialOf)

/** Replaces any pending link; the current password, if any, keeps working until the link is used. */
export const saveTeamPasswordLink = async (db: Db, input: { memberId: string; accountId: string; linkHash: string; expiresAt: Date; now: Date }): Promise<void> => {
  const memberId = assertId(input.memberId, 'memberId'), accountId = assertId(input.accountId, 'accountId'), linkHash = assertSha256Hex(input.linkHash, 'linkHash')
  if (input.expiresAt.getTime() <= input.now.getTime()) fail('VALIDATION', 'the password link must expire in the future')
  const rows = await db.query<{ member_id: string }>(
    `INSERT INTO team_credentials (member_id, account_id, link_hash, link_expires_at, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (member_id) DO UPDATE SET link_hash = excluded.link_hash, link_expires_at = excluded.link_expires_at, updated_at = excluded.updated_at
     WHERE team_credentials.account_id = excluded.account_id RETURNING member_id`,
    [memberId, accountId, linkHash, stamp(input.expiresAt), stamp(input.now)])
  if (rows.length !== 1) fail('CONFLICT', 'the team credential belongs to another account', { stateChanged: false })
}
export const findTeamPasswordLink = async (db: Db, linkHash: string, now: Date): Promise<{ memberId: string; accountId: string } | null> => {
  const rows = await db.query<Row>('SELECT member_id, account_id FROM team_credentials WHERE link_hash = $1 AND link_expires_at > $2', [assertSha256Hex(linkHash, 'linkHash'), stamp(now)])
  return rows[0] ? { memberId: text(rows[0].member_id), accountId: text(rows[0].account_id) } : null
}
/** Single use: the link is cleared in the same statement that stores the password, and every session of the member ends. */
export const consumeTeamPasswordLink = (db: Db, input: { memberId: string; linkHash: string; passwordHash: string; now: Date }): Promise<boolean> =>
  db.transaction(async tx => {
    const now = stamp(input.now)
    const rows = await tx.query<{ member_id: string }>(
      `UPDATE team_credentials SET password_hash = $1, password_set_at = $2, link_hash = NULL, link_expires_at = NULL, updated_at = $2
       WHERE member_id = $3 AND link_hash = $4 AND link_expires_at > $2 RETURNING member_id`,
      [assertArgon2Hash(input.passwordHash), now, assertId(input.memberId, 'memberId'), assertSha256Hex(input.linkHash, 'linkHash')])
    if (rows.length !== 1) return false
    await tx.query('UPDATE team_sessions SET revoked_at = $1 WHERE member_id = $2 AND revoked_at IS NULL', [now, input.memberId])
    return true
  })

/** Issues a session only while the verified password is still the stored one. */
export const createTeamSession = async (db: Db, input: {
  memberId: string; accountId: string; ownerPrincipalId: string; login: string; tokenHash: string; expectedPasswordHash: string
  ip: string | null; userAgent: string | null; now: Date; expiresAt: Date
}): Promise<TeamSessionRecord | null> => {
  const ip = input.ip === null ? null : assertIp(input.ip, 'ip'), userAgent = input.userAgent === null ? null : assertLine(input.userAgent.slice(0, 512), 512, 'userAgent')
  const rows = await db.query<Row>(
    `INSERT INTO team_sessions (id, member_id, account_id, owner_principal_id, login, token_hash, ip, user_agent, created_at, last_seen_at, expires_at)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10 FROM team_credentials WHERE member_id = $2 AND account_id = $3 AND password_hash = $11
     RETURNING *`,
    [randomUUID(), assertId(input.memberId, 'memberId'), assertId(input.accountId, 'accountId'), assertId(input.ownerPrincipalId, 'ownerPrincipalId'),
      assertLine(input.login, 128, 'login', { allowEmpty: false }), assertSha256Hex(input.tokenHash, 'tokenHash'), ip, userAgent, stamp(input.now), stamp(input.expiresAt), assertArgon2Hash(input.expectedPasswordHash)])
  if (!rows[0]) return null
  await db.query('UPDATE team_credentials SET last_login_at = $1 WHERE member_id = $2', [stamp(input.now), input.memberId])
  return sessionOf(rows[0])
}
export const findActiveTeamSession = async (db: Db, tokenHash: string, now: Date): Promise<TeamSessionRecord | null> => {
  if (!/^[0-9a-f]{64}$/.test(tokenHash)) return null
  const rows = await db.query<Row>('SELECT * FROM team_sessions WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2', [tokenHash, stamp(now)])
  return rows[0] ? sessionOf(rows[0]) : null
}
export const touchTeamSession = async (db: Db, id: string, now: Date): Promise<void> => {
  await db.query('UPDATE team_sessions SET last_seen_at = $1 WHERE id = $2 AND revoked_at IS NULL', [stamp(now), assertId(id, 'id')])
}
export const revokeTeamSession = async (db: Db, id: string, now: Date): Promise<void> => {
  await db.query('UPDATE team_sessions SET revoked_at = coalesce(revoked_at, $1) WHERE id = $2', [stamp(now), assertId(id, 'id')])
}
export const revokeTeamMemberSessions = async (db: Db, memberId: string, now: Date): Promise<number> =>
  (await db.query<{ id: string }>('UPDATE team_sessions SET revoked_at = $1 WHERE member_id = $2 AND revoked_at IS NULL RETURNING id', [stamp(now), assertId(memberId, 'memberId')])).length
/** Suspension also ends a pending link: a suspended member cannot have the password changed. */
export const clearTeamPasswordLink = async (db: Db, memberId: string, now: Date): Promise<void> => {
  await db.query('UPDATE team_credentials SET link_hash = NULL, link_expires_at = NULL, updated_at = $1 WHERE member_id = $2 AND link_hash IS NOT NULL', [stamp(now), assertId(memberId, 'memberId')])
}
/** Deleting the credential deletes every session of the member (ON DELETE CASCADE). */
export const deleteTeamCredential = async (db: Db, memberId: string): Promise<void> => {
  await db.query('DELETE FROM team_credentials WHERE member_id = $1', [assertId(memberId, 'memberId')])
}
