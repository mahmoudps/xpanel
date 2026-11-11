import '../../../web/src/i18n.ts'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { fail, isUuid, isXpanelError, msgid } from '@xpanel/core'
import type { Account, MfaRuntimeMode, Principal, ServiceUser } from '@xpanel/core'
import {
  createAuthenticatedSession,
  createUserPrincipal,
  findPrincipalByUsername,
  getMailboxSession,
  saveHandoffMailboxSession,
  saveMailboxSession,
  acquireJobLease,
  completeJobWithLease,
  enqueueDurableJob,
  getDurableJob,
  revokeAllSessionsForPrincipal,
  revokeAllApiTokensForPrincipal,
  saveJobCheckpoint,
} from '@xpanel/db'
import type { Db, DurableJobRecord, MailboxSessionRecord, PrincipalRecord, SessionRecord } from '@xpanel/db'
import type { StateStore } from '@xpanel/state'
import { hashPasswordArgon2id, verifyPasswordArgon2id } from '../auth.ts'
import type { AuthenticatedCaller } from '../auth.ts'
import { assertAccountFeatures } from '../authorization.ts'
import { sessionTokenHash } from '../entry-points.ts'
import type { EntryPoint } from '../entry-points.ts'
import { attachmentsFromBodyStructure, ImapProtocolClient, type ImapFetchedMessage } from './imap.ts'
import { imapDialPlan } from './idle.ts'
import { smtpHumanCopy, SmtpSubmissionClient } from './smtp.ts'
import { sanitizeEmailHtml } from './mime.ts'
import { verifyMailboxSecondFactor } from './mailbox-security.ts'
import type { MimeAttachmentInput } from './mime.ts'

export interface MailAttachmentSummary {
  name: string
  sizeBytes: number
}

export interface InboxSummary {
  uid: number
  /** Present only when the actual fetched selection advertised this matching identity. */
  uidValidity?: number
  uidValidityObserved?: boolean
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
  flagged?: boolean
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

export interface MailRemoteImage {
  src: string
  alt: string
}

export interface InboxMessage extends InboxSummary {
  body: string
  hasRemoteImages?: boolean
  remoteImages?: MailRemoteImage[]
}

export interface MailboxSendInput {
  to: string
  cc?: string[]
  bcc?: string[]
  subject: string
  text: string
  /** Sanitized rich text; text remains the required plain-text alternative. */
  html?: string
  /** Trusted values resolved from the saved identity and validated actual file bytes. */
  fromName?: string
  replyTo?: string
  attachments?: readonly MimeAttachmentInput[]
  idempotencyKey: string
}

export interface MailboxTransport {
  verify(mailbox: string, password: string): Promise<void>
  list(mailbox: string, password: string, folder?: string): Promise<InboxSummary[]>
  read(mailbox: string, password: string, uid: number, folder?: string, options?: { authorize?: () => void | Promise<void>; allowRemoteImages?: boolean }): Promise<InboxMessage>
  remove(mailbox: string, password: string, uid: number, folder?: string, options?: { uidValidity: number }): Promise<void>
  move?(mailbox: string, password: string, uid: number, fromFolder: string, toFolder: string, options?: { uidValidity: number }): Promise<{
    uid?: number; uidValidity?: number; uidValidityObserved?: boolean; sourceUidValidity?: number; sourceUidValidityObserved?: boolean
    unknownOutcome?: boolean; verificationRequired?: boolean
  } | void>
  flag?(mailbox: string, password: string, uid: number, folder: string, flagged: boolean, options?: { uidValidity: number }): Promise<{
    uid: number; uidValidity: number; flagged: boolean
  }>
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

/** IMAP move and copy failures as an English source sentence. A send sentence is the wrong explanation for a folder. */
export const imapHumanCopy = (raw: string): string => {
  const text = raw.toLowerCase()
  if (/timed out|econnrefused|econnreset|enotfound|ehostunreach|enetunreach|socket closed|\beconn/.test(text)) {
    return msgid('the mail server could not be reached.')
  }
  if (/trycreate|does not exist|no such mailbox|unknown mailbox|mailbox doesn't exist/.test(text)) {
    return msgid('That folder is not on this mailbox yet.')
  }
  return msgid('The message could not be moved.')
}

const mailFailure = (err: unknown): never => {
  if (isXpanelError(err) && !RAW_MAIL_ERROR.test(err.message)) throw err
  const raw = err instanceof Error ? err.message : 'mail server unavailable'
  const copy = /\bIMAP\b/.test(raw) && !/\bSMTP\b/.test(raw) ? imapHumanCopy(raw) : smtpHumanCopy(raw)
  const code = isXpanelError(err) ? err.code : 'PRECONDITION_FAILED'
  return fail(code, copy, { ...(isXpanelError(err) ? err.detail : {}) })
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

const requiredMailboxUidValidity = (options?: { uidValidity: number }): number => {
  const value = options?.uidValidity
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 0xffffffff) return fail('PRECONDITION_FAILED', 'an observed mailbox identity is required before changing messages', { stateChanged: false })
  return value
}

const decodeHtmlAttr = (value: string): string =>
  value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')

export const extractSanitizedRemoteImages = (sanitizedHtml: string): MailRemoteImage[] => {
  const images: MailRemoteImage[] = []
  const seen = new Set<string>()
  const tagRe = /<img\b([^>]*)>/gi
  let match: RegExpExecArray | null
  while ((match = tagRe.exec(sanitizedHtml)) !== null && images.length < 24) {
    const attrs = match[1] ?? ''
    const srcMatch = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/i.exec(attrs)
    const rawSrc = decodeHtmlAttr((srcMatch?.[1] ?? srcMatch?.[2] ?? srcMatch?.[3] ?? '').trim())
    const normalizedSrc = rawSrc.startsWith('//') ? `https:${rawSrc}` : rawSrc
    if (!/^https?:\/\/[^\s"'<>]+$/i.test(normalizedSrc) || seen.has(normalizedSrc)) continue
    seen.add(normalizedSrc)
    const altMatch = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/i.exec(attrs)
    const alt = decodeHtmlAttr((altMatch?.[1] ?? altMatch?.[2] ?? altMatch?.[3] ?? '').trim()).slice(0, 160)
    images.push({ src: normalizedSrc, alt })
  }
  return images
}

const summaryOf = (message: ImapFetchedMessage, observedValidity = false): InboxSummary => {
  const parsed = message.parsed
  const fromMime = parsed.attachments
    .filter(item => item.disposition !== 'inline' && item.filename.length > 0)
    .map(item => ({ name: item.filename, sizeBytes: item.sizeBytes }))
  const fromStructure = attachmentsFromBodyStructure(message.bodyStructure ?? '')
  const attachments = fromMime.length > 0 ? fromMime : fromStructure
  const verifiedIdentity = observedValidity && Number.isSafeInteger(message.uidValidity) && message.uidValidity > 0 && message.uidValidity <= 0xffffffff
  const flagged = message.flags.some(flag => flag.toLowerCase() === '\\flagged')
  return {
    uid: message.uid,
    uidValidityObserved: verifiedIdentity,
    ...(verifiedIdentity ? { uidValidity: message.uidValidity } : {}),
    from: parsed.from,
    ...(parsed.fromName ? { fromName: parsed.fromName } : {}),
    to: parsed.to.join(', '),
    ...(parsed.cc.length > 0 ? { cc: parsed.cc.join(', ') } : {}),
    subject: parsed.subject,
    receivedAt: mailReceivedAtUtc(parsed.date ?? message.internalDate ?? ''),
    preview: previewOf(parsed.textBody ?? ''),
    unread: !message.flags.some(flag => flag.toLowerCase() === '\\seen'),
    flagged,
    sizeBytes: message.sizeBytes,
    ...(attachments.length > 0 ? { attachments } : {}),
  }
}

/** Trusted message-detail bounds, aligned with the attachment and draft readers. */
const INBOX_READ_LIMITS = { maxLiteralBytes: 25 * 1024 * 1024, maxResponseLineBytes: 1024 * 1024 }

const withImap = async <T>(host: string, port: number, tls: boolean, mailbox: string, password: string, fn: (client: ImapProtocolClient) => Promise<T>, timeoutMs = 15_000, limits: { maxLiteralBytes?: number; maxResponseLineBytes?: number } = {}): Promise<T> => {
  const client = new ImapProtocolClient({ host, port, tls, timeoutMs, ...limits })
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
  const imap = async <T>(mailbox: string, password: string, fn: (client: ImapProtocolClient) => Promise<T>, limits?: typeof INBOX_READ_LIMITS): Promise<T> => {
    if (!imapPlan) return fail('PRECONDITION_FAILED', 'cleartext mail is limited to loopback; use port 993 or XPANEL_IMAP_TLS=1')
    return withImap(imapHost, imapPort, imapPlan.tls, mailbox, password, fn, imapTimeout, limits)
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
        const messages: InboxSummary[] = []
        for (let index = 0; index < uids.length; index += 50) {
          const fetched = await client.fetchMessagesByUid(name, uids.slice(index, index + 50).join(','))
          messages.push(...fetched.messages.map(message => summaryOf(message, fetched.state.uidValidityObserved === true && fetched.state.folder === name && fetched.state.uidValidity === message.uidValidity)))
        }
        return messages.sort((left, right) => right.uid - left.uid)
      })
    },
    async read(mailbox, password, uid, folder = 'INBOX', options) {
      const name = mailFolderName(folder)
      return imap(mailbox, password, async client => {
        const fetched = await client.fetchMessagesByUid(name, uid)
        const message = fetched.messages.find(item => item.uid === uid)
        if (!message) return fail('NOT_FOUND', 'message not found')
        // A header-only or partial fetch must never look like a complete empty body or change \Seen.
        if (message.rfc822SizeObserved !== true || message.bodyComplete !== true || !(message.rawMimeBytes instanceof Uint8Array)
          || message.rawMimeBytes.byteLength !== message.sizeBytes) return fail('PRECONDITION_FAILED', 'the complete message body has not been observed', { stateChanged: false })
        const observed = fetched.state.uidValidityObserved === true && fetched.state.folder === name && fetched.state.uidValidity === message.uidValidity
          && Number.isSafeInteger(message.uidValidity) && message.uidValidity > 0 && message.uidValidity <= 0xffffffff
        if (observed) {
          await options?.authorize?.()
          await client.storeFlagsByUid(name, uid, 'add', ['\\Seen'], mailbox, message.uidValidity)
        }
        const blockedRemote = (message.parsed.sanitizeReport?.blockedRemoteImages ?? [])
          .filter(url => /^https?:\/\//i.test(url) || url.startsWith('//'))
        const hasRemoteImages = blockedRemote.length > 0
        const remoteImages = hasRemoteImages && options?.allowRemoteImages === true && message.parsed.rawHtmlBody
          ? extractSanitizedRemoteImages(sanitizeEmailHtml(message.parsed.rawHtmlBody, {
            cidMap: message.parsed.inlineCidMap,
            allowRemoteImages: true,
          }).sanitizedHtml)
          : undefined
        return {
          ...summaryOf(message, observed),
          ...(observed ? { unread: false } : {}),
          body: message.parsed.textBody,
          ...(hasRemoteImages ? { hasRemoteImages: true } : {}),
          ...(remoteImages !== undefined ? { remoteImages } : {}),
        }
      }, INBOX_READ_LIMITS)
    },
    async flag(mailbox, password, uid, folder = 'INBOX', flagged, options) {
      const name = mailFolderName(folder)
      const validity = requiredMailboxUidValidity(options)
      await imap(mailbox, password, client => client.storeFlagsByUid(name, uid, flagged ? 'add' : 'remove', ['\\Flagged'], mailbox, validity))
      return { uid, uidValidity: validity, flagged }
    },
    async remove(mailbox, password, uid, folder = 'INBOX', options) {
      const name = mailFolderName(folder)
      const validity = requiredMailboxUidValidity(options)
      await imap(mailbox, password, client => client.deleteByUid(name, uid, mailbox, validity))
    },
    async move(mailbox, password, uid, fromFolder, toFolder, options) {
      const from = mailFolderName(fromFolder)
      const to = mailFolderName(toFolder)
      const validity = requiredMailboxUidValidity(options)
      const result = await imap(mailbox, password, client => client.moveOrCopyByUidWithIdentity(from, uid, to, 'move', validity, mailbox))
      return { sourceUidValidity: result.sourceUidValidity, sourceUidValidityObserved: result.sourceUidValidityObserved,
        ...(result.destinationUid === null ? {} : { uid: result.destinationUid }),
        ...(result.destinationUidValidity === null ? {} : { uidValidity: result.destinationUidValidity }),
        uidValidityObserved: result.destinationUidValidityObserved,
        ...(result.unknownOutcome ? { unknownOutcome: true } : {}), ...(result.verificationRequired ? { verificationRequired: true } : {}),
      }
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
          const uids = await client.searchAllUids(folder, mailbox)
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
          ...(input.fromName ? { fromName: input.fromName } : {}),
          ...(input.replyTo ? { replyTo: input.replyTo } : {}),
          to: input.to.split(',').map(address => address.trim()).filter(Boolean),
          ...(input.cc && input.cc.length > 0 ? { cc: input.cc } : {}),
          ...(input.bcc && input.bcc.length > 0 ? { bcc: input.bcc } : {}),
          subject: input.subject,
          textBody: input.text,
          ...(input.html ? { htmlBody: input.html } : {}),
          ...(input.attachments?.length ? { attachments: input.attachments } : {}),
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

const mailboxRetirementKey = (serviceUserId: string): string => `mailbox.retire:v1:${serviceUserId}`

/** An unverified retirement blocks its original ID and address, including replacement IDs. */
const assertMailboxIdentityAvailable = async (db: Db, serviceUserId: string, mailbox: string): Promise<void> => {
  if (!isUuid(serviceUserId)) return fail('UNAUTHENTICATED', 'mailbox identity is unavailable')
  const rows = await db.query<{ id: string }>(
    `SELECT j.id FROM jobs j JOIN job_runtime_leases l ON l.job_id = j.id
     WHERE l.idempotency_key = $1 OR (j.kind = 'mailbox.retire' AND json_extract(j.detail, '$.mailboxRetirement.service.login') = $2) LIMIT 1`,
    [mailboxRetirementKey(serviceUserId), mailbox],
  )
  if (rows.length !== 0) return fail('UNAUTHENTICATED', 'mailbox identity is unavailable')
}

/** Expensive password derivation must happen outside the admitted database transaction. */
const prepareMailboxPrincipalCreation = async (db: Db, mailbox: string): Promise<string | null> =>
  await findPrincipalByUsername(db, mailboxPrincipalUsername(mailbox)) ? null : hashPasswordArgon2id(randomBytes(32).toString('hex'))

/** Called on the admitted transaction; principal creation and session issuance share the retirement gate. */
const ensureMailboxPrincipal = async (db: Db, mailbox: string, accountId: string, serviceUserId: string, creationHash: string | null): Promise<PrincipalRecord> => {
  await assertMailboxIdentityAvailable(db, serviceUserId, mailbox)
  const username = mailboxPrincipalUsername(mailbox)
  const existing = await findPrincipalByUsername(db, username)
  if (existing && (existing.kind !== 'user' || existing.accountId !== accountId)) {
    return fail('CONFLICT', 'mailbox identity does not match this account')
  }
  if (existing?.disabled) return fail('UNAUTHENTICATED', 'mailbox identity is unavailable')
  if (existing) return existing
  if (creationHash === null) return fail('UNAUTHENTICATED', 'mailbox identity changed; sign in again')
  return createUserPrincipal(db, {
    username,
    accountId,
    passwordHash: creationHash,
    forcePasswordChange: false,
  })
}

/**
 * Opens a mailbox session from a consumed one-time handoff. The session records its issuer and carries no
 * mailbox password, so IMAP-backed reads stay unavailable instead of borrowing another credential.
 */
export const establishHandoffMailboxSession = async (input: {
  db: Db
  entryPoint: EntryPoint
  mailbox: string
  serviceUserId: string
  accountId: string
  impersonator: { principalId: string; login: string; teamMemberId?: string }
  ttlMs: number
  ip: string
  userAgent: string
}): Promise<EstablishedMailboxSession> => {
  const mailbox = normalizeMailbox(input.mailbox)
  await assertMailboxIdentityAvailable(input.db, input.serviceUserId, mailbox)
  const creationHash = await prepareMailboxPrincipalCreation(input.db, mailbox)
  const rawToken = randomBytes(32).toString('hex')
  const issued = await input.db.transaction(async tx => {
    const principalRecord = await ensureMailboxPrincipal(tx, mailbox, input.accountId, input.serviceUserId, creationHash)
    const created = await createAuthenticatedSession(tx, {
      principalId: principalRecord.id,
      tokenHash: sessionTokenHash(rawToken, input.entryPoint),
      expiresAt: new Date(Date.now() + input.ttlMs).toISOString(),
      ip: input.ip,
      userAgent: input.userAgent,
      // Like the xPanel owner handoff, the issuer's authenticated session stands for the second factor (D5: it guards sign-in).
      mfaVerified: true,
      impersonator: input.impersonator,
      expectedPasswordHash: principalRecord.passwordHash,
      expectedTotpEnabled: principalRecord.totpEnabled,
      expectedSealedSecret: principalRecord.totpSecretEnc,
    })
    if (!created) return fail('UNAUTHENTICATED', 'mailbox identity changed; open the mailbox again')
    await saveHandoffMailboxSession(tx, { sessionId: created.id, mailbox, serviceUserId: input.serviceUserId, accountId: input.accountId })
    return { principalRecord, session: created }
  })
  const { principalRecord, session } = issued
  const principal: Principal = { kind: 'user', id: principalRecord.id, username: principalRecord.username, accountId: input.accountId }
  return { principal, principalRecord, session, rawToken, mailbox }
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
  totpCode?: unknown
  recoveryCode?: unknown
  /** The runtime MFA policy; an enrolled factor is required unless MFA is disabled. */
  mfaMode?: MfaRuntimeMode
  ip: string
  userAgent: string
}): Promise<EstablishedMailboxSession> => {
  const mailbox = normalizeMailbox(input.mailbox)
  if (!input.password) fail('VALIDATION', 'username and password are required')
  const serviceUser = await input.store.getServiceUserByLogin(mailbox)
  const account = serviceUser ? await input.store.getAccount(serviceUser.accountId) : null
  if (!serviceUser || !serviceUser.services.email || !account) return fail('UNAUTHENTICATED', 'invalid username or password')
  if (account.status !== 'active') {
    // IMAP is closed on a suspended account, so the stored hash decides; only the right password learns the account state.
    const stored = await input.store.getServiceUserHash(serviceUser.id)
    if (stored?.startsWith('{ARGON2ID}') && await verifyPasswordArgon2id(input.password, stored.slice('{ARGON2ID}'.length))) return fail('FORBIDDEN', 'this mailbox account is suspended', { reason: 'account_suspended' })
    return fail('UNAUTHENTICATED', 'invalid username or password')
  }
  await assertMailboxIdentityAvailable(input.db, serviceUser.id, mailbox)
  try {
    await input.transport.verify(mailbox, input.password)
  } catch (err) {
    if (isXpanelError(err) && err.code === 'UNAUTHENTICATED') return fail('UNAUTHENTICATED', 'invalid username or password')
    throw err
  }
  const currentService = await input.store.getServiceUser(serviceUser.id)
  const currentAccount = await input.store.getAccount(account.id)
  if (!currentService || currentService.accountId !== account.id || currentService.login.toLowerCase() !== mailbox
    || !currentService.services.email || !currentAccount || currentAccount.status !== 'active') {
    return fail('UNAUTHENTICATED', 'mailbox identity changed; sign in again')
  }
  // The password was accepted; an enrolled mailbox now needs its authenticator or one recovery code.
  const mfaVerified = await verifyMailboxSecondFactor({ db: input.db, serverSecret: input.serverSecret, mfaMode: input.mfaMode ?? 'optional',
    principal: await findPrincipalByUsername(input.db, mailboxPrincipalUsername(mailbox)), totpCode: input.totpCode, recoveryCode: input.recoveryCode })
  const creationHash = await prepareMailboxPrincipalCreation(input.db, mailbox)
  const rawToken = randomBytes(32).toString('hex')
  const issued = await input.db.transaction(async tx => {
    const principalRecord = await ensureMailboxPrincipal(tx, mailbox, account.id, serviceUser.id, creationHash)
    if (input.mfaMode !== 'disabled' && principalRecord.totpEnabled && !mfaVerified) return fail('UNAUTHENTICATED', 'credentials changed; authenticate again')
    const session = await createAuthenticatedSession(tx, {
      principalId: principalRecord.id,
      tokenHash: sessionTokenHash(rawToken, input.entryPoint),
      expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
      ip: input.ip,
      userAgent: input.userAgent,
      mfaVerified,
      expectedPasswordHash: principalRecord.passwordHash,
      expectedTotpEnabled: principalRecord.totpEnabled,
      expectedSealedSecret: principalRecord.totpSecretEnc,
    })
    if (!session) return fail('UNAUTHENTICATED', 'credentials changed; authenticate again')
    await saveMailboxSession(tx, {
      sessionId: session.id,
      mailbox,
      serviceUserId: serviceUser.id,
      accountId: account.id,
      sealedPassword: sealMailboxPassword(input.password, input.serverSecret),
    })
    return { principalRecord, session }
  })
  const { principalRecord, session } = issued
  const principal: Principal = { kind: 'user', id: principalRecord.id, username: principalRecord.username, accountId: account.id }
  return { principal, principalRecord, session, rawToken, mailbox }
}

const retirementDigest = (value: unknown): string => {
  const sorted = (item: unknown): unknown => Array.isArray(item) ? item.map(sorted)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, sorted(child)])) : item
  return createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex')
}

interface RetirementIntent {
  version: 1
  account: Pick<Account, 'id' | 'username' | 'ownerId'>
  service: ServiceUser
  serviceDigest: string
  initiator: Principal
  principalIds: string[]
  identity: string
}
const publicRetirementService = (value: ServiceUser): ServiceUser => Object.freeze({ id: value.id, accountId: value.accountId, login: value.login,
  services: Object.freeze({ email: value.services.email, ftp: value.services.ftp, webdisk: value.services.webdisk }), mailboxQuotaMb: value.mailboxQuotaMb, ftpDir: value.ftpDir })
export interface MailboxRetirementSource {
  readonly account: Account
  readonly service: ServiceUser
}
export interface MailboxRetirementClockGuard {
  /** Synchronous: use the already verified credential's finite validity deadline after the last await. */
  assertCurrentTime(): void
}
export interface MailboxRetirementAttempt {
  db: Db
  store: StateStore
  serviceUserId: string
  actor: Principal
  /** Trusted callback: use the admitted runner and the attempt's original HTTP credential. No state locks/RPC. */
  authorize(tx: Db, source: MailboxRetirementSource): Promise<MailboxRetirementClockGuard>
  audit(input: { action: 'mailbox.retirement_requested' | 'mailbox.retirement_resumed'; job: DurableJobRecord; source: MailboxRetirementSource }): Promise<void>
  reconcile(source: MailboxRetirementSource): Promise<unknown>
}

const readRetirementLeaf = async (path: string): Promise<{ digest: string; record: Record<string, unknown> } | null> => {
  let handle: Awaited<ReturnType<typeof open>>
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size > 131_072) return fail('PRECONDITION_FAILED', 'mailbox retirement source is unavailable', { stateChanged: false })
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== bytes.length || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return fail('CONFLICT', 'mailbox retirement source changed', { stateChanged: false })
    const record: unknown = JSON.parse(bytes.toString('utf8'))
    if (!record || typeof record !== 'object' || Array.isArray(record)) return fail('PRECONDITION_FAILED', 'mailbox retirement source is unavailable', { stateChanged: false })
    return { digest: createHash('sha256').update(bytes).digest('hex'), record: Object.fromEntries(Object.entries(record)) }
  } finally { await handle.close() }
}

function invalidRetirementIntent(): never { return fail('PRECONDITION_FAILED', 'mailbox retirement intent requires review', { stateChanged: false }) }
const retirementRecord = (value: unknown, keys: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys) return invalidRetirementIntent()
  return Object.fromEntries(Object.entries(value))
}
const retirementIntent = (job: DurableJobRecord): RetirementIntent => {
  const raw = retirementRecord(job.detail.mailboxRetirement, 'account,identity,initiator,principalIds,service,serviceDigest,version')
  const account = retirementRecord(raw.account, 'id,ownerId,username')
  const service = retirementRecord(raw.service, 'accountId,ftpDir,id,login,mailboxQuotaMb,services')
  const services = retirementRecord(service.services, 'email,ftp,webdisk')
  const actorValue = raw.initiator
  if (!actorValue || typeof actorValue !== 'object' || Array.isArray(actorValue)) return invalidRetirementIntent()
  const actor = Object.fromEntries(Object.entries(actorValue))
  if (raw.version !== 1 || !isUuid(account.id) || typeof account.username !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(account.username)
    || !(account.ownerId === null || isUuid(account.ownerId)) || !isUuid(service.id) || service.accountId !== account.id
    || typeof service.login !== 'string' || normalizeMailbox(service.login) !== service.login || typeof services.email !== 'boolean'
    || typeof services.ftp !== 'boolean' || typeof services.webdisk !== 'boolean' || typeof service.ftpDir !== 'string'
    || !(service.mailboxQuotaMb === 'unlimited' || typeof service.mailboxQuotaMb === 'number' && Number.isSafeInteger(service.mailboxQuotaMb) && service.mailboxQuotaMb >= 0)
    || !isUuid(actor.id) || typeof actor.username !== 'string' || actor.username.length < 1 || actor.username.length > 255
    || !['root','reseller','user'].includes(String(actor.kind)) || typeof raw.serviceDigest !== 'string' || !/^[0-9a-f]{64}$/.test(raw.serviceDigest)
    || typeof raw.identity !== 'string' || !/^[0-9a-f]{64}$/.test(raw.identity)
    || !Array.isArray(raw.principalIds) || raw.principalIds.length > 2 || !raw.principalIds.every(isUuid)
    || new Set(raw.principalIds).size !== raw.principalIds.length) return invalidRetirementIntent()
  let initiator: Principal
  if (actor.kind === 'user') {
    if (Object.keys(actor).sort().join(',') !== 'accountId,id,kind,username' || actor.accountId !== account.id) return invalidRetirementIntent()
    initiator = { kind: 'user', id: actor.id, username: actor.username, accountId: account.id }
  } else {
    if (Object.keys(actor).sort().join(',') !== 'id,kind,username' || actor.kind !== 'root' && actor.kind !== 'reseller') return invalidRetirementIntent()
    initiator = { kind: actor.kind, id: actor.id, username: actor.username }
  }
  const bound: Omit<RetirementIntent, 'identity'> = { version: 1 as const, account: { id: account.id, username: account.username, ownerId: account.ownerId },
    service: { id: service.id, accountId: account.id, login: service.login, services: { email: services.email, ftp: services.ftp, webdisk: services.webdisk }, mailboxQuotaMb: service.mailboxQuotaMb, ftpDir: service.ftpDir },
    serviceDigest: raw.serviceDigest, initiator, principalIds: [...raw.principalIds].sort() }
  if (raw.identity !== retirementDigest(bound) || job.kind !== 'mailbox.retire' || job.accountId !== account.id
    || job.actor !== initiator.kind + ':' + initiator.username || job.idempotencyKey !== mailboxRetirementKey(service.id)) return invalidRetirementIntent()
  return { ...bound, identity: raw.identity }
}

const findRetirement = async (db: Db, id: string): Promise<DurableJobRecord | null> => {
  const rows = await db.query<{ job_id: string }>('SELECT job_id FROM job_runtime_leases WHERE idempotency_key = $1', [mailboxRetirementKey(id)])
  return rows[0] ? getDurableJob(db, rows[0].job_id) : null
}

/**
 * Forward-only control-plane retirement. Native mailbox absence has no trusted producer yet,
 * so this never marks the full mailbox-delete job successful or removes the held MFA identity.
 * Null means an existing non-mail service user should continue through its ordinary route.
 */
export const retireMailboxServiceUser = async (input: MailboxRetirementAttempt): Promise<null> => {
  if (!isUuid(input.serviceUserId)) return fail('VALIDATION', 'invalid service user identity', { stateChanged: false })
  const previous = await findRetirement(input.db, input.serviceUserId)
  const saved = previous ? retirementIntent(previous) : null
  const snapshot = await input.store.readSnapshot()
  const revision = snapshot.revision
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision)) return fail('PRECONDITION_FAILED', 'mailbox source revision is unavailable', { stateChanged: false })
  const storedService = snapshot.serviceUsers.find(user => user.id === input.serviceUserId)
  const currentService = storedService ? publicRetirementService(storedService) : undefined
  if (!saved && !currentService) return null
  if (!saved && currentService && !currentService.services.email) {
    const identities = await input.db.query<{ id: string }>('SELECT id FROM principals WHERE username = $1 OR username = $2', [mailboxPrincipalUsername(currentService.login), currentService.login])
    if (identities.length === 0) return null
  }
  const selectedService = saved?.service ?? currentService
  if (!selectedService) return fail('NOT_FOUND', 'mailbox service was not found', { stateChanged: false })
  const service = publicRetirementService(selectedService)
  const storedAccount = snapshot.accounts.find(value => value.id === service.accountId)
  const account = storedAccount ? await input.store.getAccount(storedAccount.id, { username: storedAccount.username }) : null
  if (!account || !/^[a-z][a-z0-9]{0,15}$/.test(account.username)) return fail('FORBIDDEN', 'mailbox account is unavailable', { stateChanged: false })
  const scope = { id: account.id, username: account.username, ownerId: account.ownerId }
  if (saved && retirementDigest(saved.account) !== retirementDigest(scope)) return fail('CONFLICT', 'mailbox retirement account changed', { stateChanged: false })
  if (snapshot.serviceUsers.some(user => user.login.toLowerCase() === service.login.toLowerCase() && user.id !== service.id)) {
    return fail('CONFLICT', 'a replacement mailbox requires separate review', { stateChanged: false })
  }
  if (currentService && retirementDigest(currentService) !== retirementDigest(service)) return fail('CONFLICT', 'mailbox retirement service changed', { stateChanged: false })
  const accountPath = join(input.store.rootDir, 'accounts', account.username, 'account.json')
  const servicePath = join(input.store.rootDir, 'accounts', account.username, 'users', service.id + '.json')
  const [accountLeaf, serviceLeaf, epoch] = await Promise.all([readRetirementLeaf(accountPath), readRetirementLeaf(servicePath), input.store.getWriterLock().readAuthority()])
  if (!accountLeaf || epoch.revision !== revision || Boolean(serviceLeaf) !== Boolean(currentService)) return fail('CONFLICT', 'mailbox retirement source changed', { stateChanged: false })
  if (accountLeaf.record.id !== account.id || accountLeaf.record.username !== account.username || accountLeaf.record.ownerId !== account.ownerId) return fail('CONFLICT', 'mailbox retirement account changed', { stateChanged: false })
  if (serviceLeaf && (serviceLeaf.record.id !== service.id || serviceLeaf.record.accountId !== account.id || serviceLeaf.record.login !== service.login
    || saved && serviceLeaf.digest !== saved.serviceDigest)) return fail('CONFLICT', 'mailbox retirement source changed', { stateChanged: false })
  if (!saved && !serviceLeaf) return fail('CONFLICT', 'mailbox retirement source changed', { stateChanged: false })
  const observedPrincipals = saved ? [] : await input.db.query<{ id: string }>('SELECT id FROM principals WHERE username = $1 OR username = $2 ORDER BY id', [mailboxPrincipalUsername(service.login), service.login])
  const intent = saved ?? (() => {
    const bound = { version: 1 as const, account: scope, service, serviceDigest: serviceLeaf?.digest ?? '', initiator: input.actor,
      principalIds: observedPrincipals.map(value => value.id).sort() }
    return { ...bound, identity: retirementDigest(bound) }
  })()
  const source: MailboxRetirementSource = Object.freeze({ account: Object.freeze(account), service })
  const assertOriginalSource = async (fencingToken?: number): Promise<void> => {
    const [now, freshAccount, freshService] = await Promise.all([input.store.getWriterLock().readAuthority(), readRetirementLeaf(accountPath), readRetirementLeaf(servicePath)])
    if (now.revision !== revision || fencingToken !== undefined && now.fencingToken !== fencingToken || freshAccount?.digest !== accountLeaf.digest || freshService?.digest !== serviceLeaf?.digest) {
      return fail('CONFLICT', 'mailbox retirement source changed during admission', { stateChanged: false })
    }
  }
  const assertSource = (): Promise<void> => assertOriginalSource(epoch.fencingToken)
  const created = await enqueueDurableJob(input.db, {
    kind: 'mailbox.retire', accountId: account.id, actor: previous?.actor ?? input.actor.kind + ':' + input.actor.username,
    summary: 'Mailbox retirement requires native verification', detail: previous?.detail ?? { mailboxRetirement: intent },
    idempotencyKey: mailboxRetirementKey(service.id), ...(previous ? { requestFingerprint: previous.requestFingerprint } : {}),
  }, async (tx, job) => {
    await assertSource()
    const admittedAuthorization = await input.authorize(tx, source)
    admittedAuthorization.assertCurrentTime()
    const bound = retirementIntent(job)
    if (bound.identity !== intent.identity || job.cancelRequested) return fail('CONFLICT', 'mailbox retirement intent changed', { stateChanged: false })
    if (job.status === 'succeeded' || job.status === 'cancelled') return fail('PRECONDITION_FAILED', 'mailbox retirement intent requires review', { stateChanged: false })
    const rows = await tx.query<{ id: string; kind: string; account_id: string | null }>('SELECT id,kind,account_id FROM principals WHERE username = $1 OR username = $2', [mailboxPrincipalUsername(service.login), service.login])
    if (rows.some(row => row.kind !== 'user' || row.account_id !== account.id)) return fail('CONFLICT', 'mailbox identity belongs to another principal', { stateChanged: false })
    if (retirementDigest(rows.map(row => row.id).sort()) !== retirementDigest(bound.principalIds)) return fail('CONFLICT', 'mailbox principal identity changed during retirement', { stateChanged: false })
    for (const row of rows) {
      await tx.query('UPDATE principals SET disabled = 1, updated_at = $1 WHERE id = $2 AND kind = $3 AND account_id = $4', [new Date().toISOString(), row.id, 'user', account.id])
      await revokeAllSessionsForPrincipal(tx, row.id)
      await revokeAllApiTokensForPrincipal(tx, row.id)
    }
    await tx.query('DELETE FROM mailbox_sessions WHERE account_id = $1 AND (service_user_id = $2 OR mailbox = $3)', [account.id, service.id, service.login])
    await tx.query('DELETE FROM handoff_mailbox_sessions WHERE account_id = $1 AND (service_user_id = $2 OR mailbox = $3)', [account.id, service.id, service.login])
    await assertSource()
    const finalAuthorization = await input.authorize(tx, source)
    await assertSource()
    finalAuthorization.assertCurrentTime()
  })
  const pending = (job: DurableJobRecord, reason: string): never => fail('PRECONDITION_FAILED', 'Mailbox retirement requires review; reload current state before continuing.', {
    stateChanged: true, verificationRequired: true, unknownOutcome: true, reason,
    job: { id: job.id, referenceCode: job.referenceCode, status: job.status }, nativeDeletionVerified: false,
  })
  try {
    await input.audit({ action: previous ? 'mailbox.retirement_resumed' : 'mailbox.retirement_requested', job: created, source })
    if (created.needsAttention || created.status === 'failed') return pending(created, created.completedSteps.includes('configuration_removed') ? 'mailbox_retirement_native_unverified' : 'mailbox_retirement_state_unconfirmed')
    const workerId = 'mailbox-retire-' + randomUUID()
    const leased = await acquireJobLease(input.db, { jobId: created.id, workerId, leaseDurationMs: 30_000 })
    if (!leased) return pending(created, 'mailbox_retirement_lease_unavailable')
    const assertAttempt = async (sourceGuard: () => Promise<void>): Promise<MailboxRetirementClockGuard> => {
      const admitted = await input.db.transaction(async tx => {
        const assertLease = async (): Promise<() => void> => {
          const job = await getDurableJob(tx, leased.id)
          if (!job || job.status !== 'running' || job.cancelRequested || job.needsAttention || job.leaseOwner !== workerId || job.fencingToken !== leased.fencingToken
            || !job.leaseExpiresAt) return fail('CONFLICT', 'mailbox retirement lease changed', { stateChanged: true, verificationRequired: true })
          const deadline = Date.parse(job.leaseExpiresAt)
          const assertCurrentTime = (): void => {
            if (!Number.isFinite(deadline) || Date.now() >= deadline) return fail('CONFLICT', 'mailbox retirement lease expired', { stateChanged: true, verificationRequired: true })
          }
          assertCurrentTime()
          return assertCurrentTime
        }
        await sourceGuard()
        const initialAuthorization = await input.authorize(tx, source)
        await assertLease()
        initialAuthorization.assertCurrentTime()
        await sourceGuard()
        const finalAuthorization = await input.authorize(tx, source)
        const assertLeaseTime = await assertLease()
        const checked = { assertCurrentTime: (): void => { finalAuthorization.assertCurrentTime(); assertLeaseTime() } }
        await sourceGuard()
        checked.assertCurrentTime()
        return checked
      })
      // A queued COMMIT is also an await. No stale validity window crosses it.
      admitted.assertCurrentTime()
      return admitted
    }
    const checkpoint = async (step: string, extra: Record<string, unknown> = {}): Promise<DurableJobRecord> => saveJobCheckpoint(input.db, {
      jobId: leased.id, workerId, fencingToken: leased.fencingToken, step,
      data: { retirementIdentity: intent.identity, serviceUserId: service.id, accountId: account.id, recoveryActor: input.actor, ...extra },
    })
    try {
      await checkpoint('identity_held')
      await assertAttempt(() => assertOriginalSource())
      if (currentService && leased.completedSteps.includes('configuration_removed')) return fail('CONFLICT', 'retired mailbox source reappeared and requires review')
      if (currentService) await input.store.deleteServiceUser(service.id, {
        expectedRevision: revision,
        authorize: async (currentAccount, current) => {
          if (retirementDigest(currentAccount) !== retirementDigest(source.account) || retirementDigest(current) !== retirementDigest(source.service)) {
            return fail('CONFLICT', 'mailbox retirement identity changed during writer admission', { stateChanged: true, verificationRequired: true })
          }
          // This is the writer that will remove the source. Its fence is issued
          // AFTER queue admission; the earlier observed writer fence is stale.
          const admitted = await input.store.getWriterLock().readAuthority()
          const checked = await assertAttempt(() => assertOriginalSource(admitted.fencingToken))
          checked.assertCurrentTime()
        },
      })
      const remaining = await input.store.getServiceUser(service.id)
      if (remaining) return fail('CONFLICT', 'mailbox source removal is not confirmed')
      await checkpoint('configuration_removed')
    } catch (error) {
      const remaining = await input.store.getServiceUser(service.id).catch(() => null)
      const leaf = await readRetirementLeaf(servicePath).catch(() => null)
      const knownUnchanged = !leased.completedSteps.includes('configuration_removed') && remaining !== null && retirementDigest(remaining) === retirementDigest(service) && leaf?.digest === intent.serviceDigest
      const failed = await completeJobWithLease(input.db, { jobId: leased.id, workerId, fencingToken: leased.fencingToken,
        status: 'failed', error: 'mailbox source removal requires recovery', failureClass: knownUnchanged ? 'retryable' : 'unknown_outcome',
        needsAttention: !knownUnchanged, requeueOnRetryable: knownUnchanged })
      if (isXpanelError(error) && (error.code === 'UNAUTHENTICATED' || error.code === 'FORBIDDEN')) {
        return fail(error.code, 'Mailbox retirement remains held; request authorization changed.', {
          stateChanged: true, verificationRequired: true, unknownOutcome: true, reason: 'mailbox_retirement_authorization_changed',
          job: { id: failed.id, referenceCode: failed.referenceCode, status: failed.status }, nativeDeletionVerified: false,
        })
      }
      return pending(failed, 'mailbox_retirement_state_unconfirmed')
    }
    if (!leased.completedSteps.includes('reconcile_requested')) {
      const after = await input.store.getWriterLock().readAuthority()
      const guardRemoved = async (): Promise<void> => {
        const [now, accountNow, serviceNow] = await Promise.all([input.store.getWriterLock().readAuthority(), readRetirementLeaf(accountPath), readRetirementLeaf(servicePath)])
        if (now.revision !== after.revision || now.fencingToken !== after.fencingToken || accountNow?.digest !== accountLeaf.digest || serviceNow !== null) return fail('CONFLICT', 'retired mailbox source changed', { stateChanged: true, verificationRequired: true })
      }
      await assertAttempt(guardRemoved)
      await checkpoint('reconcile_requested')
      const checked = await assertAttempt(guardRemoved)
      checked.assertCurrentTime()
      try { await input.reconcile(source); await checkpoint('reconcile_acknowledged') }
      catch { /* A lost reply is not native absence; never repeat this phase automatically. */ }
    }
    const held = await completeJobWithLease(input.db, { jobId: leased.id, workerId, fencingToken: leased.fencingToken,
      status: 'failed', error: 'native mailbox removal has not been independently verified', failureClass: 'unknown_outcome', needsAttention: true })
    return pending(held, 'mailbox_retirement_native_unverified')
  } catch (error) {
    if (isXpanelError(error) && error.detail.stateChanged === true) throw error
    return fail(isXpanelError(error) ? error.code : 'PRECONDITION_FAILED', 'Mailbox retirement is held; this attempt was not acknowledged.', {
      stateChanged: true, verificationRequired: true, unknownOutcome: true, reason: 'mailbox_retirement_attempt_unacknowledged',
      job: { id: created.id, referenceCode: created.referenceCode }, nativeDeletionVerified: false,
    })
  }
}

/** Legacy entry point retained until the coordinated DELETE hook is installed. */
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
    await tx.query(`DELETE FROM handoff_mailbox_sessions WHERE mailbox = $1 OR service_user_id = $2`, [address, serviceUserId])
  })
}

export const requireMailboxSessionRecord = async (db: Db, sessionId: string | null): Promise<MailboxSessionRecord> => {
  if (!sessionId) return fail('UNAUTHENTICATED', 'mailbox sign-in is required')
  const record = await getMailboxSession(db, sessionId)
  if (!record) return fail('UNAUTHENTICATED', 'mailbox sign-in is required')
  return record
}

/** Null for a handed-off session, which never holds the mailbox password. */
export const mailboxSessionPassword = (record: MailboxSessionRecord, serverSecret: string): string | null =>
  record.sealedPassword === null ? null : unsealMailboxPassword(record.sealedPassword, serverSecret)

const requireMailboxPassword = (record: MailboxSessionRecord, serverSecret: string): string =>
  mailboxSessionPassword(record, serverSecret)
    ?? fail('SERVICE_UNAVAILABLE', 'this mailbox was opened from the hosting account without its password; sign in with the mailbox address to read mail', { stateChanged: false, mailboxCredential: 'unavailable' })

/** The current mailbox binding and capability, without opening the mailbox credential. */
export const authorizeMailboxSessionBinding = async (
  db: Db,
  store: StateStore,
  caller: AuthenticatedCaller,
): Promise<MailboxSessionRecord> => {
  const record = await requireMailboxSessionRecord(db, caller.sessionId)
  await assertMailboxIdentityAvailable(db, record.serviceUserId, record.mailbox)
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
  return record
}

/** Revalidate the current mailbox capability before starting or retaining a watch. */
export const openAuthorizedMailboxSession = async (
  db: Db,
  store: StateStore,
  serverSecret: string,
  caller: AuthenticatedCaller,
): Promise<{ record: MailboxSessionRecord; password: string }> => {
  const record = await authorizeMailboxSessionBinding(db, store, caller)
  return { record, password: requireMailboxPassword(record, serverSecret) }
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
  if (to.length + cc.length + bcc.length === 0) fail('VALIDATION', 'a recipient address is required')
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
