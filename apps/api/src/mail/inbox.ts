import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { fail, isXpanelError } from '@xpanel/core'
import type { Principal } from '@xpanel/core'
import {
  createAuthenticatedSession,
  createUserPrincipal,
  findPrincipalByUsername,
  getMailboxSession,
  saveMailboxSession,
} from '@xpanel/db'
import type { Db, MailboxSessionRecord, PrincipalRecord, SessionRecord } from '@xpanel/db'
import type { StateStore } from '@xpanel/state'
import { hashPasswordArgon2id } from '../auth.ts'
import { sessionTokenHash } from '../entry-points.ts'
import type { EntryPoint } from '../entry-points.ts'
import { attachmentsFromBodyStructure, ImapProtocolClient, type ImapFetchedMessage } from './imap.ts'
import { smtpHumanCopy, SmtpSubmissionClient } from './smtp.ts'

export interface MailAttachmentSummary {
  name: string
  sizeBytes: number
}

export interface InboxSummary {
  uid: number
  from: string
  /** Display name from the From header. Empty when the header has only an address. */
  fromName?: string
  to: string
  cc?: string
  subject: string
  receivedAt: string
  /** First text line already fetched with the message. Empty when the message has no text part. */
  preview?: string
  unread: boolean
  sizeBytes: number
  attachments?: MailAttachmentSummary[]
}

export interface MailFolderCount {
  folder: string
  total: number
  unread: number
}

export const MAIL_FOLDERS = ['INBOX', 'Sent', 'Drafts', 'Junk', 'Trash', 'Archive'] as const

const FOLDER_RE = /^(?:INBOX|Sent|Drafts|Junk|Trash|Archive|[A-Za-z][A-Za-z0-9._-]{0,40})$/

export interface InboxMessage extends InboxSummary {
  body: string
}

export interface MailboxSendInput {
  to: string
  cc?: string[]
  subject: string
  text: string
  idempotencyKey: string
}

export interface MailboxTransport {
  verify(mailbox: string, password: string): Promise<void>
  list(mailbox: string, password: string, folder?: string): Promise<InboxSummary[]>
  read(mailbox: string, password: string, uid: number, folder?: string): Promise<InboxMessage>
  remove(mailbox: string, password: string, uid: number, folder?: string): Promise<void>
  move?(mailbox: string, password: string, uid: number, fromFolder: string, toFolder: string): Promise<{ uid?: number } | void>
  counts?(mailbox: string, password: string): Promise<MailFolderCount[]>
  quota?(mailbox: string, password: string): Promise<{ usedMb: number; limitMb?: number; usedBytes?: number } | null>
  send(mailbox: string, password: string, input: MailboxSendInput): Promise<{ messageId: string; savedToSent?: boolean }>
}

const MAILBOX_RE = /^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/
const RECIPIENT_RE = MAILBOX_RE

export const normalizeMailbox = (value: string): string => {
  const mailbox = value.trim().toLowerCase()
  if (!MAILBOX_RE.test(mailbox) || mailbox.length > 254) fail('VALIDATION', 'mailbox address is invalid')
  return mailbox
}

export const mailboxPrincipalUsername = (mailbox: string): string =>
  `mbx${createHash('sha256').update(`xpanel-mailbox:${mailbox}`).digest('hex').slice(0, 28)}`

const sealMailboxPassword = (password: string, serverSecret: string): Uint8Array => {
  const key = createHash('sha256').update(`mailbox-seal:${serverSecret}`).digest()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()])
  return new Uint8Array(Buffer.concat([iv, cipher.getAuthTag(), encrypted]))
}

const unsealMailboxPassword = (sealed: Uint8Array, serverSecret: string): string => {
  const buf = Buffer.from(sealed)
  if (buf.byteLength < 29) fail('PRECONDITION_FAILED', 'the mailbox session secret could not be read')
  const key = createHash('sha256').update(`mailbox-seal:${serverSecret}`).digest()
  const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12))
  decipher.setAuthTag(buf.subarray(12, 28))
  try {
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8')
  } catch {
    return fail('PRECONDITION_FAILED', 'the mailbox session secret could not be read')
  }
}

const RAW_MAIL_ERROR = /SMTP |IMAP |ECONN|ENOTFOUND|ETIMEDOUT|timed out|ServerName|TLS |socket closed|STARTTLS|EHLO|AUTH PLAIN|MAIL FROM|RCPT |recipients rejected/

/** IMAP move and copy failures. A send sentence is the wrong explanation for a folder. */
export const imapHumanCopy = (raw: string): { en: string; ar: string } => {
  const text = raw.toLowerCase()
  if (/timed out|econnrefused|econnreset|enotfound|ehostunreach|enetunreach|socket closed|\beconn/.test(text)) {
    return { en: 'the mail server could not be reached.', ar: 'تعذر الوصول إلى خادم البريد.' }
  }
  if (/trycreate|does not exist|no such mailbox|unknown mailbox|mailbox doesn't exist/.test(text)) {
    return { en: 'That folder is not on this mailbox yet.', ar: 'هذا المجلد غير موجود في صندوق البريد بعد.' }
  }
  return { en: 'The message could not be moved.', ar: 'تعذر نقل الرسالة.' }
}

const mailFailure = (err: unknown): never => {
  if (isXpanelError(err) && !RAW_MAIL_ERROR.test(err.message)) throw err
  const raw = err instanceof Error ? err.message : 'mail server unavailable'
  const copy = /\bIMAP\b/.test(raw) && !/\bSMTP\b/.test(raw) ? imapHumanCopy(raw) : smtpHumanCopy(raw)
  const code = isXpanelError(err) ? err.code : 'PRECONDITION_FAILED'
  return fail(code, copy.en, { ...(isXpanelError(err) ? err.detail : {}), messageAr: copy.ar })
}

export const mailFolderName = (value: string | null | undefined): string => {
  const folder = (value ?? 'INBOX').trim()
  if (!FOLDER_RE.test(folder)) fail('VALIDATION', 'that mail folder is not available')
  return folder
}

const DATE_LIKE = /(?:\d{4}|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b)/i

/** ISO-8601 UTC when the mail date can be parsed. Otherwise the original text, with no timezone invented. */
export const mailReceivedAtUtc = (value: string | null | undefined): string => {
  const raw = (value ?? '').trim()
  if (!raw || !DATE_LIKE.test(raw)) return raw
  const parsed = Date.parse(raw)
  if (Number.isNaN(parsed)) return raw
  return new Date(parsed).toISOString()
}

const previewOf = (text: string): string =>
  text.split(/\r?\n/).map(line => line.trim()).find(line => line.length > 0)?.slice(0, 180) ?? ''

const summaryOf = (message: ImapFetchedMessage): InboxSummary => {
  const parsed = message.parsed
  const fromMime = parsed.attachments
    .filter(item => item.disposition !== 'inline' && item.filename.length > 0)
    .map(item => ({ name: item.filename, sizeBytes: item.sizeBytes }))
  const fromStructure = attachmentsFromBodyStructure(message.bodyStructure ?? '')
  const attachments = fromMime.length > 0 ? fromMime : fromStructure
  return {
    uid: message.uid,
    from: parsed.from,
    ...(parsed.fromName ? { fromName: parsed.fromName } : {}),
    to: parsed.to.join(', '),
    ...(parsed.cc.length > 0 ? { cc: parsed.cc.join(', ') } : {}),
    subject: parsed.subject,
    receivedAt: mailReceivedAtUtc(parsed.date ?? message.internalDate ?? ''),
    preview: previewOf(parsed.textBody ?? ''),
    unread: !message.flags.some(flag => flag.toLowerCase() === '\\seen'),
    sizeBytes: message.sizeBytes,
    ...(attachments.length > 0 ? { attachments } : {}),
  }
}

const withImap = async <T>(host: string, port: number, mailbox: string, password: string, fn: (client: ImapProtocolClient) => Promise<T>, timeoutMs = 15_000): Promise<T> => {
  const client = new ImapProtocolClient({ host, port, tls: false, timeoutMs })
  try {
    await client.connect()
    await client.login(mailbox, password)
    return await fn(client)
  } catch (err) {
    return mailFailure(err)
  } finally {
    await client.logout().catch(() => undefined)
  }
}

export const createLocalMailboxTransport = (
  env: NodeJS.ProcessEnv = process.env,
): MailboxTransport => {
  const imapHost = env.XPANEL_IMAP_HOST || '127.0.0.1'
  const imapPort = Number(env.XPANEL_IMAP_PORT || '143')
  const imapTimeout = Number(env.XPANEL_IMAP_TIMEOUT_MS || '15000')
  const smtpHost = env.XPANEL_SMTP_HOST || '127.0.0.1'
  const smtpPort = Number(env.XPANEL_SMTP_PORT || '587')
  const smtpTimeout = Number(env.XPANEL_SMTP_TIMEOUT_MS || '20000')
  return {
    async verify(mailbox, password) {
      await withImap(imapHost, imapPort, mailbox, password, async () => undefined, imapTimeout)
    },
    async list(mailbox, password, folder = 'INBOX') {
      const name = mailFolderName(folder)
      return withImap(imapHost, imapPort, mailbox, password, async client => {
        const uids = await client.searchAllUids(name)
        if (uids.length === 0) return []
        const messages: ImapFetchedMessage[] = []
        for (let index = 0; index < uids.length; index += 50) {
          const fetched = await client.fetchMessagesByUid(name, uids.slice(index, index + 50).join(','))
          messages.push(...fetched.messages)
        }
        return messages.map(summaryOf).sort((left, right) => right.uid - left.uid)
      }, imapTimeout)
    },
    async read(mailbox, password, uid, folder = 'INBOX') {
      const name = mailFolderName(folder)
      return withImap(imapHost, imapPort, mailbox, password, async client => {
        const fetched = await client.fetchMessagesByUid(name, uid)
        const message = fetched.messages.find(item => item.uid === uid)
        if (!message) return fail('NOT_FOUND', 'message not found')
        await client.storeFlagsByUid(name, uid, 'add', ['\\Seen'])
        return { ...summaryOf(message), unread: false, body: message.parsed.textBody }
      }, imapTimeout)
    },
    async remove(mailbox, password, uid, folder = 'INBOX') {
      const name = mailFolderName(folder)
      await withImap(imapHost, imapPort, mailbox, password, client => client.deleteByUid(name, uid), imapTimeout)
    },
    async move(mailbox, password, uid, fromFolder, toFolder) {
      const from = mailFolderName(fromFolder)
      const to = mailFolderName(toFolder)
      if (from === to) return
      const destination = await withImap(imapHost, imapPort, mailbox, password, client => client.moveOrCopyByUid(from, uid, to, 'move'), imapTimeout)
      return typeof destination === 'number' ? { uid: destination } : undefined
    },
    async counts(mailbox, password) {
      return withImap(imapHost, imapPort, mailbox, password, async client => {
        const rows: MailFolderCount[] = []
        for (const folder of MAIL_FOLDERS) {
          const status = await client.folderStatus(folder)
          if (!status) continue
          rows.push({ folder, total: status.messages, unread: status.unseen })
        }
        return rows
      }, imapTimeout)
    },
    async quota(mailbox, password) {
      return withImap(imapHost, imapPort, mailbox, password, async client => {
        const measured = await client.quotaRoot()
        if (measured) {
          const usedBytes = measured.usedKb * 1024
          const usedMb = Math.round((measured.usedKb / 1024) * 10) / 10
          const limitMb = measured.limitKb > 0 ? Math.round((measured.limitKb / 1024) * 10) / 10 : undefined
          return { usedMb, usedBytes, ...(limitMb !== undefined ? { limitMb } : {}) }
        }
        let bytes = 0
        for (const folder of MAIL_FOLDERS) {
          const uids = await client.searchAllUids(folder).catch(() => [] as number[])
          if (uids.length === 0) continue
          const fetched = await client.fetchMessagesByUid(folder, uids.join(','))
          bytes += fetched.messages.reduce((sum, item) => sum + item.sizeBytes, 0)
        }
        return { usedMb: Math.round((bytes / (1024 * 1024)) * 10) / 10, usedBytes: bytes }
      }, imapTimeout)
    },
    async send(mailbox, password, input) {
      const loopback = smtpHost === '127.0.0.1' || smtpHost === '::1' || smtpHost === 'localhost'
      const smtp = new SmtpSubmissionClient({
        host: smtpHost,
        port: smtpPort,
        tls: false,
        starttls: true,
        // Loopback submission presents the public certificate name. The peer is local Postfix.
        rejectUnauthorized: loopback ? false : true,
        timeoutMs: smtpTimeout,
      })
      try {
        const result = await smtp.submitMessage({ username: mailbox, password }, {
          idempotencyKey: input.idempotencyKey,
          authenticatedMailbox: mailbox,
          from: mailbox,
          to: [input.to],
          ...(input.cc && input.cc.length > 0 ? { cc: input.cc } : {}),
          subject: input.subject,
          textBody: input.text,
        })
        let savedToSent = false
        try {
          await withImap(imapHost, imapPort, mailbox, password, client => client.appendMessage('Sent', result.rawMime, ['\\Seen']), imapTimeout)
          savedToSent = true
        } catch {
          savedToSent = false
        }
        return { messageId: result.messageId, savedToSent }
      } catch (err) {
        return mailFailure(err)
      }
    },
  }
}

export interface EstablishedMailboxSession {
  principal: Principal
  principalRecord: PrincipalRecord
  session: SessionRecord
  rawToken: string
  mailbox: string
}

export const establishMailboxSession = async (input: {
  db: Db
  store: StateStore
  serverSecret: string
  transport: MailboxTransport
  entryPoint?: EntryPoint
  mailbox: string
  password: string
  ip: string
  userAgent: string
}): Promise<EstablishedMailboxSession> => {
  const mailbox = normalizeMailbox(input.mailbox)
  if (!input.password) fail('VALIDATION', 'username and password are required')
  const serviceUser = await input.store.getServiceUserByLogin(mailbox)
  const account = serviceUser ? await input.store.getAccount(serviceUser.accountId) : null
  if (!serviceUser || !serviceUser.services.email || !account || account.status !== 'active') {
    return fail('UNAUTHENTICATED', 'invalid username or password')
  }
  try {
    await input.transport.verify(mailbox, input.password)
  } catch (err) {
    if (isXpanelError(err) && err.code === 'UNAUTHENTICATED') return fail('UNAUTHENTICATED', 'invalid username or password')
    throw err
  }
  const username = mailboxPrincipalUsername(mailbox)
  let principalRecord = await findPrincipalByUsername(input.db, username)
  if (principalRecord && (principalRecord.kind !== 'user' || principalRecord.accountId !== account.id)) {
    return fail('CONFLICT', 'mailbox identity does not match this account')
  }
  if (!principalRecord) {
    principalRecord = await createUserPrincipal(input.db, {
      username,
      accountId: account.id,
      passwordHash: await hashPasswordArgon2id(randomBytes(32).toString('hex')),
      forcePasswordChange: false,
    })
  }
  const rawToken = randomBytes(32).toString('hex')
  const session = await createAuthenticatedSession(input.db, {
    principalId: principalRecord.id,
    tokenHash: sessionTokenHash(rawToken, input.entryPoint),
    expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
    ip: input.ip,
    userAgent: input.userAgent,
    mfaVerified: false,
    expectedPasswordHash: principalRecord.passwordHash,
    expectedTotpEnabled: principalRecord.totpEnabled,
    expectedSealedSecret: principalRecord.totpSecretEnc,
  })
  if (!session) return fail('UNAUTHENTICATED', 'credentials changed; authenticate again')
  await saveMailboxSession(input.db, {
    sessionId: session.id,
    mailbox,
    serviceUserId: serviceUser.id,
    accountId: account.id,
    sealedPassword: sealMailboxPassword(input.password, input.serverSecret),
  })
  const principal: Principal = { kind: 'user', id: principalRecord.id, username: principalRecord.username, accountId: account.id }
  return { principal, principalRecord, session, rawToken, mailbox }
}

/** Removes the mailbox login, its sessions, and the sealed mailbox secret in one transaction. */
export const revokeMailboxIdentity = async (db: Db, mailbox: string, serviceUserId: string): Promise<void> => {
  const address = normalizeMailbox(mailbox)
  const names = [mailboxPrincipalUsername(address), address]
  await db.transaction(async (tx) => {
    const principals = await tx.query<{ id: string }>(
      `SELECT id FROM principals WHERE username = $1 OR username = $2`,
      names,
    )
    const ids = principals.map(row => row.id)
    if (ids.length > 0) {
      const slots = ids.map((_, index) => `$${index + 1}`).join(', ')
      await tx.query(`DELETE FROM mailbox_sessions WHERE session_id IN (SELECT id FROM sessions WHERE principal_id IN (${slots}))`, ids)
      await tx.query(`DELETE FROM sessions WHERE principal_id IN (${slots})`, ids)
      await tx.query(`DELETE FROM totp_enrollments WHERE principal_id IN (${slots})`, ids)
      await tx.query(`DELETE FROM api_tokens WHERE principal_id IN (${slots})`, ids)
      await tx.query(`DELETE FROM principals WHERE id IN (${slots})`, ids)
    }
    await tx.query(`DELETE FROM mailbox_sessions WHERE mailbox = $1 OR service_user_id = $2`, [address, serviceUserId])
  })
}

export const openMailboxSession = async (
  db: Db,
  serverSecret: string,
  sessionId: string | null,
): Promise<{ record: MailboxSessionRecord; password: string }> => {
  if (!sessionId) return fail('UNAUTHENTICATED', 'mailbox sign-in is required')
  const record = await getMailboxSession(db, sessionId)
  if (!record) return fail('UNAUTHENTICATED', 'mailbox sign-in is required')
  return { record, password: unsealMailboxPassword(record.sealedPassword, serverSecret) }
}

export const parseMailboxSend = (body: { to?: unknown; cc?: unknown; subject?: unknown; text?: unknown }): MailboxSendInput => {
  const to = typeof body.to === 'string' ? body.to.trim().toLowerCase() : ''
  const subject = typeof body.subject === 'string' ? body.subject.trim() : ''
  const text = typeof body.text === 'string' ? body.text : ''
  const cc = typeof body.cc === 'string'
    ? body.cc.split(/[,;]/).map(part => part.trim().toLowerCase()).filter(part => RECIPIENT_RE.test(part))
    : []
  if (!RECIPIENT_RE.test(to)) fail('VALIDATION', 'a recipient address is required')
  if (!subject || subject.length > 200) fail('VALIDATION', 'subject is required')
  if (!text.trim() || text.length > 100_000) fail('VALIDATION', 'message text is required')
  if (/[\u0000]/.test(subject) || /[\u0000]/.test(text)) fail('VALIDATION', 'message text is invalid')
  return { to, subject, text, idempotencyKey: randomUUID(), ...(cc.length > 0 ? { cc } : {}) }
}
