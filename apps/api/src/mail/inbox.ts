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
import { ImapProtocolClient, type ImapFetchedMessage } from './imap.ts'
import { SmtpSubmissionClient } from './smtp.ts'

export interface InboxSummary {
  uid: number
  from: string
  to: string
  subject: string
  receivedAt: string
  /** First text line already fetched with the message. Empty when the message has no text part. */
  preview?: string
  unread: boolean
  sizeBytes: number
}

export interface InboxMessage extends InboxSummary {
  body: string
}

export interface MailboxSendInput {
  to: string
  subject: string
  text: string
  idempotencyKey: string
}

export interface MailboxTransport {
  verify(mailbox: string, password: string): Promise<void>
  list(mailbox: string, password: string): Promise<InboxSummary[]>
  read(mailbox: string, password: string, uid: number): Promise<InboxMessage>
  remove(mailbox: string, password: string, uid: number): Promise<void>
  send(mailbox: string, password: string, input: MailboxSendInput): Promise<{ messageId: string }>
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

const mailFailure = (err: unknown): never => {
  if (isXpanelError(err)) throw err
  const message = err instanceof Error ? err.message : 'mail server unavailable'
  return fail('PRECONDITION_FAILED', `the mail server could not be reached (${message})`)
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

const summaryOf = (message: { uid: number; flags: string[]; internalDate: string | null; sizeBytes: number; parsed: { from: string; to: string[]; subject: string; date: string | null; textBody?: string } }): InboxSummary => ({
  uid: message.uid,
  from: message.parsed.from,
  to: message.parsed.to.join(', '),
  subject: message.parsed.subject,
  receivedAt: mailReceivedAtUtc(message.parsed.date ?? message.internalDate ?? ''),
  preview: previewOf(message.parsed.textBody ?? ''),
  unread: !message.flags.some(flag => flag.toLowerCase() === '\\seen'),
  sizeBytes: message.sizeBytes,
})

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
    async list(mailbox, password) {
      return withImap(imapHost, imapPort, mailbox, password, async client => {
        const uids = await client.searchAllUids('INBOX')
        if (uids.length === 0) return []
        const messages: ImapFetchedMessage[] = []
        for (let index = 0; index < uids.length; index += 50) {
          const fetched = await client.fetchMessagesByUid('INBOX', uids.slice(index, index + 50).join(','))
          messages.push(...fetched.messages)
        }
        return messages.map(summaryOf).sort((left, right) => right.uid - left.uid)
      }, imapTimeout)
    },
    async read(mailbox, password, uid) {
      return withImap(imapHost, imapPort, mailbox, password, async client => {
        const fetched = await client.fetchMessagesByUid('INBOX', uid)
        const message = fetched.messages.find(item => item.uid === uid)
        if (!message) return fail('NOT_FOUND', 'message not found')
        await client.storeFlagsByUid('INBOX', uid, 'add', ['\\Seen'])
        return { ...summaryOf(message), unread: false, body: message.parsed.textBody }
      }, imapTimeout)
    },
    async remove(mailbox, password, uid) {
      await withImap(imapHost, imapPort, mailbox, password, client => client.deleteByUid('INBOX', uid), imapTimeout)
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
          subject: input.subject,
          textBody: input.text,
        })
        return { messageId: result.messageId }
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

export const parseMailboxSend = (body: { to?: unknown; subject?: unknown; text?: unknown }): MailboxSendInput => {
  const to = typeof body.to === 'string' ? body.to.trim().toLowerCase() : ''
  const subject = typeof body.subject === 'string' ? body.subject.trim() : ''
  const text = typeof body.text === 'string' ? body.text : ''
  if (!RECIPIENT_RE.test(to)) fail('VALIDATION', 'a recipient address is required')
  if (!subject || subject.length > 200) fail('VALIDATION', 'subject is required')
  if (!text.trim() || text.length > 100_000) fail('VALIDATION', 'message text is required')
  if (/[\u0000]/.test(subject) || /[\u0000]/.test(text)) fail('VALIDATION', 'message text is invalid')
  return { to, subject, text, idempotencyKey: randomUUID() }
}
