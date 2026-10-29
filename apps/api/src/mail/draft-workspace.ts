import { createHash, randomUUID } from 'node:crypto'
import { fail, isXpanelError } from '@xpanel/core'
import { MimeCodecAndSanitizer } from './mime.ts'
import type { MimeAttachmentInput } from './mime.ts'

export const DRAFT_MIME_MAX_BYTES = 2 * 1024 * 1024
const UID_MAX = 4294967295
const addressPattern = /^[^\s@<>(),;:"\\[\]/]+@[^\s@<>(),;:"\\[\]/]+$/
const unsafeBody = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/

export interface DraftIdentity { uid: number; uidValidity: number; revision: string }
export interface SavedDraftIdentity extends DraftIdentity { messageId: string }
export interface DraftObservation {
  mailbox: string
  folder: string
  uidValidity: number
  uidValidityObserved: boolean
  message: {
    mailbox: string
    folder: string
    uid: number
    uidValidity: number
    sizeBytes: number
    rfc822SizeObserved: boolean
    bodyComplete: boolean
    rawMimeBytes: Uint8Array
  } | null
}
export interface DraftTransport {
  appendDraft: (rawMime: Uint8Array, flags: readonly string[]) => Promise<{ appendedUid: number | null; appendedUidValidity: number | null }>
  observeDraft: (uid: number) => Promise<DraftObservation>
  /** Moves only this exact previous draft to Trash; no permanent deletion. */
  retireDraft?: (identity: DraftIdentity) => Promise<unknown>
}
export interface DraftWorkspaceDependencies {
  mailbox: string
  authorize: () => Promise<void>
  transport: DraftTransport
  now?: () => Date
  newMessageId?: () => string
}
export interface DraftContent {
  to: readonly string[]
  cc?: readonly string[]
  bcc?: readonly string[]
  subject: string
  textBody?: string
  htmlBody?: string
  fromName?: string
  replyTo?: string
  attachments?: readonly MimeAttachmentInput[]
}
export interface DraftSaveResult {
  mailbox: string
  folder: 'Drafts'
  status: 'saved' | 'partial'
  draft: SavedDraftIdentity
  previousDraft: 'none' | 'retired' | 'review_required'
  reviewRequired: boolean
}

const positiveUid = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= UID_MAX
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

export function parseExpectedDraft(value: unknown): DraftIdentity | null {
  if (value === undefined || value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('VALIDATION', 'expectedDraft must identify a saved draft', { stateChanged: false })
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some(key => !['uid', 'uidValidity', 'revision'].includes(key)) || !positiveUid(raw.uid) || !positiveUid(raw.uidValidity)
    || typeof raw.revision !== 'string' || !/^[0-9a-f]{64}$/.test(raw.revision)) return fail('VALIDATION', 'expectedDraft must contain a saved UID, validity and revision', { stateChanged: false })
  return { uid: raw.uid, uidValidity: raw.uidValidity, revision: raw.revision }
}

const conflict = (): never => fail('CONFLICT', 'saved draft changed; inspect Drafts before saving again', { stateChanged: false, draftConflict: true })
const unknownDraft = (): never => fail('PRECONDITION_FAILED', 'draft save requires review; inspect Drafts before retrying', { stateChanged: true, unknownOutcome: true, verificationRequired: true, draftReviewRequired: true })

function observedMessage(observed: DraftObservation, mailbox: string, uid: number, uidValidity: number): Uint8Array | null {
  if (!observed || observed.mailbox?.trim().toLowerCase() !== mailbox || observed.folder !== 'Drafts'
    || observed.uidValidityObserved !== true || !positiveUid(observed.uidValidity)) return fail('PRECONDITION_FAILED', 'draft mailbox identity could not be verified', { stateChanged: false, draftVerificationRequired: true })
  if (observed.uidValidity !== uidValidity) return conflict()
  if (observed.message === null) return null
  const message = observed.message
  if (message.mailbox?.trim().toLowerCase() !== mailbox || message.folder !== 'Drafts' || message.uid !== uid || message.uidValidity !== uidValidity) return conflict()
  if (message.rfc822SizeObserved !== true || message.bodyComplete !== true || !Number.isSafeInteger(message.sizeBytes) || message.sizeBytes < 1
    || message.sizeBytes > DRAFT_MIME_MAX_BYTES || !(message.rawMimeBytes instanceof Uint8Array) || message.rawMimeBytes.byteLength !== message.sizeBytes) return fail('PRECONDITION_FAILED', 'complete draft source could not be verified', { stateChanged: false, draftVerificationRequired: true })
  return message.rawMimeBytes
}

function recipients(values: readonly string[] | undefined): string[] {
  if (values === undefined) return []
  if (!Array.isArray(values) || values.length > 200) return fail('VALIDATION', 'draft recipients must be a bounded address list', { stateChanged: false })
  return values.map(value => {
    if (typeof value !== 'string' || !value.isWellFormed() || Buffer.byteLength(value, 'utf8') > 254 || !addressPattern.test(value)) return fail('VALIDATION', 'draft recipient is invalid', { stateChanged: false })
    return value.trim().toLowerCase()
  })
}

function buildDraft(mailbox: string, content: DraftContent, messageId: string, date: Date): Buffer {
  const to = recipients(content.to), cc = recipients(content.cc), bcc = recipients(content.bcc)
  if (to.length + cc.length + bcc.length > 200) return fail('VALIDATION', 'draft has too many recipients', { stateChanged: false })
  if (typeof content.subject !== 'string' || !content.subject.isWellFormed() || /[\r\n\u0000]/.test(content.subject) || Buffer.byteLength(content.subject, 'utf8') > 998) return fail('VALIDATION', 'draft subject must be a bounded single line', { stateChanged: false })
  for (const body of [content.textBody, content.htmlBody]) if (body !== undefined && (typeof body !== 'string' || !body.isWellFormed() || unsafeBody.test(body))) return fail('VALIDATION', 'draft body must be valid text', { stateChanged: false })
  if (!/^<[^<>\s@]+@[^<>\s@]+>$/.test(messageId) || !(date instanceof Date) || !Number.isFinite(date.getTime())) return fail('VALIDATION', 'server draft identity is invalid', { stateChanged: false })
  if (!to.length && !cc.length && !bcc.length && !content.subject.trim() && !content.textBody?.trim() && !content.htmlBody?.trim() && !content.attachments?.length) return fail('VALIDATION', 'draft is empty', { stateChanged: false })
  let raw = new MimeCodecAndSanitizer().buildMimeMessage({
    from: mailbox, fromName: content.fromName, replyTo: content.replyTo, to, cc, subject: content.subject,
    textBody: content.textBody, htmlBody: content.htmlBody, attachments: content.attachments, messageId, date,
  }, { allowEmptyTo: true }).rawMime
  // Bcc belongs in the sender's private draft, never in a sent-message MIME build.
  if (bcc.length) raw = 'Bcc: ' + bcc.join(',\r\n ') + '\r\n' + raw
  const bytes = Buffer.from(raw, 'utf8')
  if (bytes.byteLength > DRAFT_MIME_MAX_BYTES) return fail('VALIDATION', 'draft MIME exceeds the supported size', { stateChanged: false })
  return bytes
}

/** Real IMAP APPEND/readback boundary. Ports must use the authenticated sealed mailbox. */
export async function saveMailboxDraft(deps: DraftWorkspaceDependencies, content: DraftContent, expectedValue?: unknown): Promise<DraftSaveResult> {
  const mailbox = deps.mailbox.trim().toLowerCase()
  let expected: DraftIdentity | null, bytes: Buffer, messageId: string
  try {
    if (!addressPattern.test(mailbox)) return fail('VALIDATION', 'authenticated draft mailbox is invalid', { stateChanged: false })
    expected = parseExpectedDraft(expectedValue)
    await deps.authorize()
    if (expected) {
      if (!deps.transport.retireDraft) return fail('PRECONDITION_FAILED', 'replacing saved drafts is unavailable', { stateChanged: false })
      const previous = observedMessage(await deps.transport.observeDraft(expected.uid), mailbox, expected.uid, expected.uidValidity)
      if (!previous || digest(previous) !== expected.revision) return conflict()
    }
    messageId = deps.newMessageId?.() ?? '<' + randomUUID() + '@' + mailbox.split('@')[1]! + '>'
    bytes = buildDraft(mailbox, content, messageId, deps.now?.() ?? new Date())
    await deps.authorize()
  } catch (error) {
    if (isXpanelError(error)) return fail(error.code, error.message, { ...error.detail, stateChanged: false })
    return fail('PRECONDITION_FAILED', 'draft could not be prepared; nothing was appended', { stateChanged: false })
  }
  let appended: { appendedUid: number | null; appendedUidValidity: number | null }
  try { appended = await deps.transport.appendDraft(bytes, ['\\Draft']) }
  catch (error) {
    if (isXpanelError(error) && error.detail?.stateChanged === false && error.detail.unknownOutcome !== true && error.detail.verificationRequired !== true) throw error
    return unknownDraft()
  }
  let draft: SavedDraftIdentity
  try {
    if (!positiveUid(appended.appendedUid) || !positiveUid(appended.appendedUidValidity)) return unknownDraft()
    if (expected && appended.appendedUidValidity === expected.uidValidity && appended.appendedUid <= expected.uid) return unknownDraft()
    const observed = observedMessage(await deps.transport.observeDraft(appended.appendedUid), mailbox, appended.appendedUid, appended.appendedUidValidity)
    const revision = digest(bytes)
    if (!observed || digest(observed) !== revision) return unknownDraft()
    draft = { uid: appended.appendedUid, uidValidity: appended.appendedUidValidity, revision, messageId }
  } catch { return unknownDraft() }
  if (!expected) return { mailbox, folder: 'Drafts', status: 'saved', draft, previousDraft: 'none', reviewRequired: false }
  try {
    if (draft.uidValidity !== expected.uidValidity) throw new Error('draft_validity_changed')
    await deps.authorize()
    await deps.transport.retireDraft!(expected)
    if (observedMessage(await deps.transport.observeDraft(expected.uid), mailbox, expected.uid, expected.uidValidity) !== null) throw new Error('previous_draft_retained')
    return { mailbox, folder: 'Drafts', status: 'saved', draft, previousDraft: 'retired', reviewRequired: false }
  } catch {
    return { mailbox, folder: 'Drafts', status: 'partial', draft, previousDraft: 'review_required', reviewRequired: true }
  }
}
