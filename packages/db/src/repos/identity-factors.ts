import { randomUUID } from 'node:crypto'
import { assertId, fail } from '@xpanel/core'
import type { Id } from '@xpanel/core'
import type { Db } from '../client.ts'
import { withSqliteErrors } from '../sqlite-errors.ts'

/** cPanel asks a handful of questions; five bound the sign-in cost (one Argon2id verification per answer). */
export const MAX_SECURITY_QUESTIONS = 5
export const MAX_VERIFIED_IPS = 64
export const MAX_EXTERNAL_IDENTITIES = 16

export interface SecurityQuestionRecord { position: number; question: string; answerHash: string; createdAt: string }
export interface VerifiedIpRecord { address: string; source: 'answered' | 'added'; createdAt: string }
export interface ExternalIdentityRecord {
  id: Id
  principalId: Id
  providerId: string
  issuer: string
  subject: string
  label: string | null
  createdAt: string
  lastUsedAt: string | null
}

const ARGON2ID = /^\$argon2id\$v=19\$/
const PROVIDER_ID = /^[a-z0-9-]{1,32}$/
// Exact IPv4, IPv4 with a trailing '*' octet, or a compressed lowercase IPv6 address.
export const VERIFIED_IP = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9]|\*)$|^[0-9a-f:]{3,45}$/

const line = (value: unknown, min: number, max: number, what: string): string =>
  typeof value === 'string' && value.length >= min && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : fail('VALIDATION', `${what} is invalid`)

export const listSecurityQuestions = (db: Db, principalId: Id): Promise<SecurityQuestionRecord[]> => withSqliteErrors(async () =>
  (await db.query<{ position: number; question: string; answer_hash: string; created_at: string }>(
    'SELECT position, question, answer_hash, created_at FROM security_questions WHERE principal_id = $1 ORDER BY position', [assertId(principalId, 'principalId')],
  )).map(row => ({ position: row.position, question: row.question, answerHash: row.answer_hash, createdAt: row.created_at })))

/** Replaces the whole set in one transaction; an empty set turns the questions off for this principal. */
export const replaceSecurityQuestions = (db: Db, principalId: Id, items: readonly { question: string; answerHash: string }[], now: Date = new Date()): Promise<void> => withSqliteErrors(async () => {
  const id = assertId(principalId, 'principalId')
  if (items.length > MAX_SECURITY_QUESTIONS) fail('VALIDATION', `at most ${MAX_SECURITY_QUESTIONS} security questions are allowed`)
  const rows = items.map((item, index) => {
    const answerHash = line(item.answerHash, 30, 512, 'answer hash')
    if (!ARGON2ID.test(answerHash)) fail('VALIDATION', 'answer hash must be Argon2id')
    return [id, index + 1, line(item.question, 8, 200, 'security question'), answerHash, now.toISOString()] as const
  })
  await db.transaction(async tx => {
    await tx.query('DELETE FROM security_questions WHERE principal_id = $1', [id])
    for (const row of rows) await tx.query('INSERT INTO security_questions (principal_id, position, question, answer_hash, created_at) VALUES ($1, $2, $3, $4, $5)', row)
  })
})

export const listVerifiedIps = (db: Db, principalId: Id): Promise<VerifiedIpRecord[]> => withSqliteErrors(async () =>
  (await db.query<{ address: string; source: 'answered' | 'added'; created_at: string }>(
    'SELECT address, source, created_at FROM security_verified_ips WHERE principal_id = $1 ORDER BY created_at, address', [assertId(principalId, 'principalId')],
  )).map(row => ({ address: row.address, source: row.source, createdAt: row.created_at })))

/** Idempotent; refuses a new address beyond the per-principal limit. */
export const addVerifiedIp = (db: Db, principalId: Id, address: string, source: 'answered' | 'added', now: Date = new Date()): Promise<boolean> => withSqliteErrors(async () => {
  const id = assertId(principalId, 'principalId')
  if (typeof address !== 'string' || !VERIFIED_IP.test(address)) fail('VALIDATION', 'verified address is invalid')
  return db.transaction(async tx => {
    const [existing] = await tx.query('SELECT 1 AS present FROM security_verified_ips WHERE principal_id = $1 AND address = $2', [id, address])
    if (existing) return false
    const [count] = await tx.query<{ n: number }>('SELECT count(*) AS n FROM security_verified_ips WHERE principal_id = $1', [id])
    if ((count?.n ?? 0) >= MAX_VERIFIED_IPS) fail('LIMIT_EXCEEDED', `at most ${MAX_VERIFIED_IPS} verified addresses are kept`, { stateChanged: false })
    await tx.query('INSERT INTO security_verified_ips (principal_id, address, source, created_at) VALUES ($1, $2, $3, $4)', [id, address, source, now.toISOString()])
    return true
  })
})

export const removeVerifiedIp = (db: Db, principalId: Id, address: string): Promise<boolean> => withSqliteErrors(async () =>
  (await db.query('DELETE FROM security_verified_ips WHERE principal_id = $1 AND address = $2 RETURNING address', [assertId(principalId, 'principalId'), address])).length > 0)

interface ExternalIdentityRow {
  id: string; principal_id: string; provider_id: string; issuer: string; subject: string; label: string | null; created_at: string; last_used_at: string | null
  [key: string]: unknown
}
const identityFromRow = (row: ExternalIdentityRow): ExternalIdentityRecord => ({ id: row.id, principalId: row.principal_id, providerId: row.provider_id, issuer: row.issuer,
  subject: row.subject, label: row.label, createdAt: row.created_at, lastUsedAt: row.last_used_at })

export const findExternalIdentity = (db: Db, issuer: string, subject: string): Promise<ExternalIdentityRecord | null> => withSqliteErrors(async () => {
  const [row] = await db.query<ExternalIdentityRow>('SELECT * FROM external_identities WHERE issuer = $1 AND subject = $2', [issuer, subject])
  return row ? identityFromRow(row) : null
})

export const listExternalIdentities = (db: Db, filter: { principalId: Id } | { providerId: string } | Record<string, never> = {}): Promise<ExternalIdentityRecord[]> => withSqliteErrors(async () => {
  const rows = 'principalId' in filter
    ? await db.query<ExternalIdentityRow>('SELECT * FROM external_identities WHERE principal_id = $1 ORDER BY created_at, id', [assertId(filter.principalId, 'principalId')])
    : 'providerId' in filter
      ? await db.query<ExternalIdentityRow>('SELECT * FROM external_identities WHERE provider_id = $1 ORDER BY created_at, id', [filter.providerId])
      : await db.query<ExternalIdentityRow>('SELECT * FROM external_identities ORDER BY created_at, id LIMIT 5000')
  return rows.map(identityFromRow)
})

/** One identity belongs to one principal; linking it again anywhere is a conflict, never a silent move. */
export const linkExternalIdentity = (db: Db, input: { principalId: Id; providerId: string; issuer: string; subject: string; label: string | null }, now: Date = new Date()): Promise<ExternalIdentityRecord> => withSqliteErrors(async () => {
  const principalId = assertId(input.principalId, 'principalId')
  if (!PROVIDER_ID.test(input.providerId)) fail('VALIDATION', 'provider id is invalid')
  const issuer = line(input.issuer, 9, 256, 'issuer'), subject = line(input.subject, 1, 255, 'subject')
  const label = input.label === null ? null : line(input.label, 1, 254, 'identity label')
  return db.transaction(async tx => {
    const [taken] = await tx.query<{ principal_id: string }>('SELECT principal_id FROM external_identities WHERE issuer = $1 AND subject = $2', [issuer, subject])
    if (taken) fail('CONFLICT', 'this external identity is already linked', { stateChanged: false, reason: taken.principal_id === principalId ? 'identity_already_linked_here' : 'identity_already_linked' })
    const [count] = await tx.query<{ n: number }>('SELECT count(*) AS n FROM external_identities WHERE principal_id = $1', [principalId])
    if ((count?.n ?? 0) >= MAX_EXTERNAL_IDENTITIES) fail('LIMIT_EXCEEDED', `at most ${MAX_EXTERNAL_IDENTITIES} external identities can be linked`, { stateChanged: false })
    const [row] = await tx.query<ExternalIdentityRow>(
      'INSERT INTO external_identities (id, principal_id, provider_id, issuer, subject, label, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [randomUUID(), principalId, input.providerId, issuer, subject, label, now.toISOString()])
    return identityFromRow(row!)
  })
})

/** Removes one link; with a principal it only removes that principal's own link. */
export const unlinkExternalIdentity = (db: Db, id: Id, principalId?: Id): Promise<ExternalIdentityRecord | null> => withSqliteErrors(async () => {
  const rows = principalId === undefined
    ? await db.query<ExternalIdentityRow>('DELETE FROM external_identities WHERE id = $1 RETURNING *', [assertId(id, 'id')])
    : await db.query<ExternalIdentityRow>('DELETE FROM external_identities WHERE id = $1 AND principal_id = $2 RETURNING *', [assertId(id, 'id'), assertId(principalId, 'principalId')])
  return rows[0] ? identityFromRow(rows[0]) : null
})

/** Removing a provider revokes every identity linked through it. */
export const revokeProviderIdentities = (db: Db, providerId: string): Promise<number> => withSqliteErrors(async () =>
  (await db.query('DELETE FROM external_identities WHERE provider_id = $1 RETURNING id', [providerId])).length)

export const touchExternalIdentity = (db: Db, id: Id, now: Date = new Date()): Promise<void> => withSqliteErrors(async () => {
  await db.query('UPDATE external_identities SET last_used_at = $1 WHERE id = $2', [now.toISOString(), assertId(id, 'id')])
})
