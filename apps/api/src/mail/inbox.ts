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
import type { AuthenticatedCaller } from '../auth.ts'
import { assertAccountFeatures } from '../authorization.ts'
import { sessionTokenHash } from '../entry-points.ts'
import type { EntryPoint } from '../entry-points.ts'
import { attachmentsFromBodyStructure, ImapProtocolClient, type ImapFetchedMessage } from './imap.ts'
import { imapDialPlan } from './idle.ts'
import { smtpHumanCopy, SmtpSubmissionClient } from './smtp.ts'
import { sanitizeEmailHtml } from './mime.ts'

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
  bcc?: string[]
  subject: string
  text: string
  /** Sanitized rich text; text remains the required plain-text alternative. */
  html?: string
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

const MAILBOX_ID = /mbx[0-9a-f]{8,}/gi
const EMBEDDED_MAILBOX = /[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi

/** Hash to address for mailboxes that still exist as service users. */
export const mailboxAddressIndex = (logins: readonly string[]): ReadonlyMap<string, string> => {
  const map = new Map<string, string>()
  for (const login of logins) {
    const address = login.trim().toLowerCase()
    if (!MAILBOX_RE.test(address) || address.length > 254) continue
    map.set(mailboxPrincipalUsername(address), address)
  }
  return map
}

/** Replaces a mailbox principal id with the address when the mailbox is known. */
export const rewriteMailboxIds = (value: string, addresses: ReadonlyMap<string, string>): string =>
  value.replace(MAILBOX_ID, (token) => addresses.get(token.toLowerCase()) ?? 'Unavailable mailbox')

/** The stored actor is the mailbox hash. An address filter looks up that hash. */
export const auditActorQuery = (typed: string): string => {
  const value = typed.trim()
  if (!value.includes('@')) return value
  const address = value.toLowerCase()
  if (!MAILBOX_RE.test(address) || address.length > 254) return value
  return mailboxPrincipalUsername(address)
}

/** A displayed address stands in for the hash stored on older rows. */
export const auditTargetQuery = (typed: string): string =>
  typed.replace(EMBEDDED_MAILBOX, (address) => {
    const normalized = address.toLowerCase()
    return MAILBOX_RE.test(normalized) && normalized.length <= 254
      ? mailboxPrincipalUsername(normalized)
      : address
  })

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

const withImap = async <T>(host: string, port: number, tls: boolean, mailbox: string, password: string, fn: (client: ImapProtocolClient) => Promise<T>, timeoutMs = 15_000): Promise<T> => {
  const client = new ImapProtocolClient({ host, port, tls, timeoutMs })
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

/** The Sent copy is the signed submission. An unsigned pre-image is not stored. */
export const mimeForSent = (_submitted: string, signed: string | null | undefined): string | null =>
  typeof signed === 'string' && /DKIM-Signature:/i.test(signed) ? signed : null

export interface MailboxTransportOptions {
  /** Returns the submitted MIME plus DKIM-Signature. Null skips the Sent APPEND. */
  signSent?: (mailbox: string, rawMime: string) => Promise<string | null>
}

export const createLocalMailboxTransport = (
  env: NodeJS.ProcessEnv = process.env,
  options: MailboxTransportOptions = {},
): MailboxTransport => {
  const imapHost = env.XPANEL_IMAP_HOST || '127.0.0.1'
  const imapPort = Number(env.XPANEL_IMAP_PORT || '143')
  const imapTimeout = Number(env.XPANEL_IMAP_TIMEOUT_MS || '15000')
  const smtpHost = env.XPANEL_SMTP_HOST || '127.0.0.1'
  const smtpPort = Number(env.XPANEL_SMTP_PORT || '587')
  const smtpTimeout = Number(env.XPANEL_SMTP_TIMEOUT_MS || '20000')
  // Port 143 is cleartext and loopback-only. A non-loopback host needs 993 or XPANEL_IMAP_TLS=1.
  const imapPlan = imapDialPlan(imapHost, imapPort, env.XPANEL_IMAP_TLS)
  const imap = async <T>(mailbox: string, password: string, fn: (client: ImapProtocolClient) => Promise<T>): Promise<T> => {
    if (!imapPlan) return fail('PRECONDITION_FAILED', 'cleartext mail is limited to loopback; use port 993 or XPANEL_IMAP_TLS=1')
    return withImap(imapHost, imapPort, imapPlan.tls, mailbox, password, fn, imapTimeout)
  }
  return {
    async verify(mailbox, password) {
      await imap(mailbox, password, async () => undefined)
    },
    async list(mailbox, password, folder = 'INBOX') {
      const name = mailFolderName(folder)
      return imap(mailbox, password, async client => {
        const uids = await client.searchAllUids(name)
        if (uids.length === 0) return []
        const messages: ImapFetchedMessage[] = []
        for (let index = 0; index < uids.length; index += 50) {
          const fetched = await client.fetchMessagesByUid(name, uids.slice(index, index + 50).join(','))
          messages.push(...fetched.messages)
        }
        return messages.map(summaryOf).sort((left, right) => right.uid - left.uid)
      })
    },
    async read(mailbox, password, uid, folder = 'INBOX') {
      const name = mailFolderName(folder)
      return imap(mailbox, password, async client => {
        const fetched = await client.fetchMessagesByUid(name, uid)
        const message = fetched.messages.find(item => item.uid === uid)
        if (!message) return fail('NOT_FOUND', 'message not found')
        await client.storeFlagsByUid(name, uid, 'add', ['\\Seen'])
        return { ...summaryOf(message), unread: false, body: message.parsed.textBody }
      })
    },
    async remove(mailbox, password, uid, folder = 'INBOX') {
      const name = mailFolderName(folder)
      await imap(mailbox, password, client => client.deleteByUid(name, uid))
    },
    async move(mailbox, password, uid, fromFolder, toFolder) {
      const from = mailFolderName(fromFolder)
      const to = mailFolderName(toFolder)
      if (from === to) return
      const destination = await imap(mailbox, password, client => client.moveOrCopyByUid(from, uid, to, 'move'))
      return typeof destination === 'number' ? { uid: destination } : undefined
    },
    async counts(mailbox, password) {
      return imap(mailbox, password, async client => {
        const rows: MailFolderCount[] = []
        for (const folder of MAIL_FOLDERS) {
          const status = await client.folderStatus(folder)
          if (!status) continue
          rows.push({ folder, total: status.messages, unread: status.unseen })
        }
        return rows
      })
    },
    async quota(mailbox, password) {
      return imap(mailbox, password, async client => {
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
      })
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
          to: input.to.split(',').map(address => address.trim()),
          ...(input.cc && input.cc.length > 0 ? { cc: input.cc } : {}),
          ...(input.bcc && input.bcc.length > 0 ? { bcc: input.bcc } : {}),
          subject: input.subject,
          textBody: input.text,
          ...(input.html ? { htmlBody: input.html } : {}),
        })
        let savedToSent = false
        const submitted = result.rawMime
        const copy = options.signSent
          ? mimeForSent(submitted, await options.signSent(mailbox, submitted).catch(() => null))
          : submitted
        if (copy) {
          try {
            await imap(mailbox, password, client => client.appendMessage('Sent', copy, ['\\Seen']))
            savedToSent = true
          } catch {
            savedToSent = false
          }
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

/** Revalidate the current mailbox capability before starting or retaining a watch. */
export const openAuthorizedMailboxSession = async (
  db: Db,
  store: StateStore,
  serverSecret: string,
  caller: AuthenticatedCaller,
): Promise<{ record: MailboxSessionRecord; password: string }> => {
  const opened = await openMailboxSession(db, serverSecret, caller.sessionId)
  const { record } = opened
  if (caller.principal.kind !== 'user' || caller.principal.accountId !== record.accountId
    || ![mailboxPrincipalUsername(record.mailbox), record.mailbox].includes(caller.principal.username.toLowerCase())) {
    return fail('FORBIDDEN', 'mailbox session binding is unavailable')
  }
  const serviceUser = await store.getServiceUser(record.serviceUserId)
  const account = await store.getAccount(record.accountId)
  if (!serviceUser || !serviceUser.services.email || serviceUser.accountId !== record.accountId
    || serviceUser.login.toLowerCase() !== record.mailbox.toLowerCase() || !account || account.status !== 'active') {
    return fail('FORBIDDEN', 'mailbox service is unavailable')
  }
  await assertAccountFeatures(store, caller, account, ['email-accounts', 'webmail-message-list'])
  return opened
}

const MAX_MAILBOX_RECIPIENTS = 100
const MAX_MAILBOX_BODY_BYTES = 100_000

const mailboxRecipients = (value: unknown, field: 'to' | 'cc' | 'bcc'): string[] => {
  if (value === undefined) return []
  const raw = typeof value === 'string' ? value : fail('VALIDATION', `${field} recipient addresses are invalid`)
  if (/[\r\n\u0000]/.test(raw)) fail('VALIDATION', `${field} recipient addresses are invalid`)
  const parts = raw.split(/[,;]/).map(part => part.trim().toLowerCase()).filter(Boolean)
  if (parts.length > MAX_MAILBOX_RECIPIENTS) fail('VALIDATION', 'too many recipient addresses')
  if (parts.some(part => part.length > 254 || !RECIPIENT_RE.test(part))) fail('VALIDATION', `${field} recipient address is invalid`)
  return [...new Set(parts)]
}

export const parseMailboxSend = (body: { to?: unknown; cc?: unknown; bcc?: unknown; subject?: unknown; text?: unknown; html?: unknown }): MailboxSendInput => {
  const to = mailboxRecipients(body.to, 'to')
  const cc = mailboxRecipients(body.cc, 'cc')
  const bcc = mailboxRecipients(body.bcc, 'bcc')
  const subject = typeof body.subject === 'string' ? body.subject.trim() : ''
  const text = typeof body.text === 'string' ? body.text : ''
  if (to.length === 0) fail('VALIDATION', 'a recipient address is required')
  if (to.length + cc.length + bcc.length > MAX_MAILBOX_RECIPIENTS) fail('VALIDATION', 'too many recipient addresses')
  if (!subject || subject.length > 200 || /[\r\n\u0000]/.test(subject)) fail('VALIDATION', 'subject is required and must be a single line')
  if (!text.trim() || text.length > MAX_MAILBOX_BODY_BYTES || /[\u0000]/.test(text)) fail('VALIDATION', 'message text is required')
  if (body.html !== undefined && (typeof body.html !== 'string' || /[\u0000]/.test(body.html))) fail('VALIDATION', 'message HTML is invalid')
  const rawHtml = typeof body.html === 'string' ? body.html : ''
  if (Buffer.byteLength(text, 'utf8') + Buffer.byteLength(rawHtml, 'utf8') > MAX_MAILBOX_BODY_BYTES) fail('VALIDATION', 'message body exceeds the byte limit')
  const html = rawHtml ? sanitizeEmailHtml(rawHtml).sanitizedHtml : ''
  return {
    to: to.join(', '), subject, text, idempotencyKey: randomUUID(),
    ...(cc.length > 0 ? { cc } : {}),
    ...(bcc.length > 0 ? { bcc } : {}),
    ...(html ? { html } : {}),
  }
}
