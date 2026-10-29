import { assertId, assertIsoDate, fail } from '@xpanel/core'
import type { Id } from '@xpanel/core'
import type { Db } from '../client.ts'
import { withSqliteErrors } from '../sqlite-errors.ts'
import { mustExist, nowIso } from './util.ts'

export interface MailboxSessionRecord {
  sessionId: Id
  mailbox: string
  serviceUserId: Id
  accountId: Id
  /** Null for a session opened through a one-time handoff: it carries no mailbox credential. */
  sealedPassword: Uint8Array | null
  createdAt: string
}

interface MailboxSessionRow {
  session_id: string
  mailbox: string
  service_user_id: string
  account_id: string
  sealed_password: Uint8Array | Buffer | null
  created_at: string
  [key: string]: unknown
}

const bytesOf = (value: Uint8Array | Buffer): Uint8Array =>
  value instanceof Uint8Array ? value : new Uint8Array(value)

const fromRow = (row: MailboxSessionRow): MailboxSessionRecord => ({
  sessionId: row.session_id,
  mailbox: row.mailbox,
  serviceUserId: row.service_user_id,
  accountId: row.account_id,
  sealedPassword: row.sealed_password === null ? null : bytesOf(row.sealed_password),
  createdAt: row.created_at,
})

export const saveMailboxSession = (
  db: Db,
  input: { sessionId: Id; mailbox: string; serviceUserId: Id; accountId: Id; sealedPassword: Uint8Array },
): Promise<MailboxSessionRecord> => withSqliteErrors(async () => {
  const sessionId = assertId(input.sessionId, 'sessionId')
  const serviceUserId = assertId(input.serviceUserId, 'serviceUserId')
  const accountId = assertId(input.accountId, 'accountId')
  const mailbox = input.mailbox.trim().toLowerCase()
  if (!mailbox.includes('@') || mailbox.length < 3 || mailbox.length > 254) fail('VALIDATION', 'mailbox address is invalid')
  if (input.sealedPassword.byteLength < 29 || input.sealedPassword.byteLength > 1024) fail('VALIDATION', 'sealed mailbox secret is invalid')
  const createdAt = assertIsoDate(nowIso(), 'createdAt').toISOString()
  const rows = await db.query<MailboxSessionRow>(
    `INSERT INTO mailbox_sessions (session_id, mailbox, service_user_id, account_id, sealed_password, created_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [sessionId, mailbox, serviceUserId, accountId, input.sealedPassword, createdAt],
  )
  return fromRow(mustExist(rows[0], 'mailbox session', sessionId))
})

/** Binds a handed-off session to its mailbox without any mailbox credential. */
export const saveHandoffMailboxSession = (
  db: Db,
  input: { sessionId: Id; mailbox: string; serviceUserId: Id; accountId: Id },
): Promise<MailboxSessionRecord> => withSqliteErrors(async () => {
  const sessionId = assertId(input.sessionId, 'sessionId')
  const serviceUserId = assertId(input.serviceUserId, 'serviceUserId')
  const accountId = assertId(input.accountId, 'accountId')
  const mailbox = input.mailbox.trim().toLowerCase()
  if (!mailbox.includes('@') || mailbox.length < 3 || mailbox.length > 254) fail('VALIDATION', 'mailbox address is invalid')
  const createdAt = assertIsoDate(nowIso(), 'createdAt').toISOString()
  const rows = await db.query<MailboxSessionRow>(
    `INSERT INTO handoff_mailbox_sessions (session_id, mailbox, service_user_id, account_id, created_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING *, NULL AS sealed_password`,
    [sessionId, mailbox, serviceUserId, accountId, createdAt],
  )
  return fromRow(mustExist(rows[0], 'mailbox session', sessionId))
})

export const getMailboxSession = async (db: Db, sessionId: Id): Promise<MailboxSessionRecord | null> => {
  if (typeof sessionId !== 'string') return null
  const rows = await db.query<MailboxSessionRow>(
    `SELECT session_id, mailbox, service_user_id, account_id, sealed_password, created_at FROM mailbox_sessions WHERE session_id = $1
     UNION ALL SELECT session_id, mailbox, service_user_id, account_id, NULL, created_at FROM handoff_mailbox_sessions WHERE session_id = $1`,
    [sessionId],
  )
  return rows.length === 1 ? fromRow(rows[0]!) : null
}

export const deleteMailboxSession = (db: Db, sessionId: Id): Promise<void> => withSqliteErrors(async () => {
  if (typeof sessionId !== 'string') return
  await db.query('DELETE FROM mailbox_sessions WHERE session_id = $1', [sessionId])
  await db.query('DELETE FROM handoff_mailbox_sessions WHERE session_id = $1', [sessionId])
})
