import { assertId, assertIsoDate, assertLine, assertSha256Hex, fail } from '@xpanel/core'
import type { Id } from '@xpanel/core'
import type { Db } from '../client.ts'
import { withSqliteErrors } from '../sqlite-errors.ts'
import { mustExist } from './util.ts'

/** A handoff link is single-use and short: the browser posts it to the target listener immediately. */
export const PANEL_HANDOFF_TTL_MS = 60_000

export type PanelHandoffAudience = 'xpanel' | 'xmail'
export type PanelHandoffLanding = 'home' | 'calendar' | 'contacts'

export type PanelHandoffTarget =
  | { kind: 'account-owner'; accountId: Id; principalId: Id }
  | { kind: 'mailbox'; accountId: Id; serviceUserId: Id; mailbox: string }

export interface PanelHandoffIssuer {
  principalId: Id
  entryPoint: 'xwhm' | 'xpanel'
  login: string
  teamMemberId?: Id
}

export interface PanelHandoffRecord {
  tokenHash: string
  audience: PanelHandoffAudience
  target: PanelHandoffTarget
  landing: PanelHandoffLanding
  issuer: PanelHandoffIssuer
  createdAt: string
  expiresAt: string
  consumedAt: string | null
}

export type PanelHandoffRefusal = 'unknown' | 'expired' | 'consumed' | 'audience'

interface PanelHandoffRow {
  token_hash: string
  audience: PanelHandoffAudience
  target_kind: 'account-owner' | 'mailbox'
  target_account_id: string
  target_principal_id: string | null
  target_service_user_id: string | null
  target_mailbox: string | null
  landing: PanelHandoffLanding
  issuer_principal_id: string
  issuer_entry_point: 'xwhm' | 'xpanel'
  issuer_team_member_id: string | null
  issuer_login: string
  created_at: string
  expires_at: string
  consumed_at: string | null
  [key: string]: unknown
}

const fromRow = (row: PanelHandoffRow): PanelHandoffRecord => ({
  tokenHash: row.token_hash,
  audience: row.audience,
  target: row.target_kind === 'account-owner'
    ? { kind: 'account-owner', accountId: row.target_account_id, principalId: row.target_principal_id! }
    : { kind: 'mailbox', accountId: row.target_account_id, serviceUserId: row.target_service_user_id!, mailbox: row.target_mailbox! },
  landing: row.landing,
  issuer: {
    principalId: row.issuer_principal_id,
    entryPoint: row.issuer_entry_point,
    login: row.issuer_login,
    ...(row.issuer_team_member_id ? { teamMemberId: row.issuer_team_member_id } : {}),
  },
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  consumedAt: row.consumed_at,
})

const purgeExpired = (db: Db, now: string): Promise<unknown> =>
  db.query('DELETE FROM panel_handoffs WHERE expires_at <= $1', [now])

/** Stores only the hash of a fresh link secret. The pairing of audience, target and issuer is fixed by the schema. */
export const issuePanelHandoff = (
  db: Db,
  input: { tokenHash: string; audience: PanelHandoffAudience; target: PanelHandoffTarget; landing: PanelHandoffLanding; issuer: PanelHandoffIssuer },
  now: Date = new Date(),
): Promise<PanelHandoffRecord> => withSqliteErrors(async () => {
  const tokenHash = assertSha256Hex(input.tokenHash, 'tokenHash')
  if (input.audience !== 'xpanel' && input.audience !== 'xmail') fail('VALIDATION', 'handoff audience is invalid')
  if (!['home', 'calendar', 'contacts'].includes(input.landing)) fail('VALIDATION', 'handoff landing is invalid')
  const target = input.target
  const accountId = assertId(target.accountId, 'targetAccountId')
  const principalId = target.kind === 'account-owner' ? assertId(target.principalId, 'targetPrincipalId') : null
  const serviceUserId = target.kind === 'mailbox' ? assertId(target.serviceUserId, 'targetServiceUserId') : null
  const mailbox = target.kind === 'mailbox' ? assertLine(target.mailbox, 254, 'targetMailbox', { allowEmpty: false }) : null
  const issuerId = assertId(input.issuer.principalId, 'issuerPrincipalId')
  const teamMemberId = input.issuer.teamMemberId === undefined ? null : assertId(input.issuer.teamMemberId, 'issuerTeamMemberId')
  const login = assertLine(input.issuer.login, 254, 'issuerLogin', { allowEmpty: false })
  const createdAt = assertIsoDate(now.toISOString(), 'createdAt').toISOString()
  const expiresAt = new Date(now.getTime() + PANEL_HANDOFF_TTL_MS).toISOString()
  await purgeExpired(db, createdAt)
  const rows = await db.query<PanelHandoffRow>(
    `INSERT INTO panel_handoffs (token_hash, audience, target_kind, target_account_id, target_principal_id, target_service_user_id, target_mailbox,
       landing, issuer_principal_id, issuer_entry_point, issuer_team_member_id, issuer_login, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
    [tokenHash, input.audience, target.kind, accountId, principalId, serviceUserId, mailbox,
      input.landing, issuerId, input.issuer.entryPoint, teamMemberId, login, createdAt, expiresAt],
  )
  return fromRow(mustExist(rows[0], 'panel handoff', tokenHash))
})

/**
 * Consumes a link for exactly this audience in one statement: a second attempt, an expired link or another
 * listener's link never matches. The refusal reason is for the audit trail only, never for the browser.
 */
export const consumePanelHandoff = (
  db: Db,
  tokenHash: string,
  audience: PanelHandoffAudience,
  now: Date = new Date(),
): Promise<{ record: PanelHandoffRecord } | { refused: PanelHandoffRefusal }> => withSqliteErrors(async () => {
  if (typeof tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(tokenHash)) return { refused: 'unknown' as const }
  const at = now.toISOString()
  const rows = await db.query<PanelHandoffRow>(
    `UPDATE panel_handoffs SET consumed_at = $1
     WHERE token_hash = $2 AND audience = $3 AND consumed_at IS NULL AND expires_at > $1 RETURNING *`,
    [at, tokenHash, audience],
  )
  if (rows[0]) {
    await purgeExpired(db, at)
    return { record: fromRow(rows[0]) }
  }
  const [existing] = await db.query<PanelHandoffRow>('SELECT * FROM panel_handoffs WHERE token_hash = $1', [tokenHash])
  await purgeExpired(db, at)
  if (!existing) return { refused: 'unknown' as const }
  if (existing.audience !== audience) return { refused: 'audience' as const }
  return { refused: existing.consumed_at !== null ? 'consumed' as const : 'expired' as const }
})
