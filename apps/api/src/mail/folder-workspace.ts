import { fail, isXpanelError } from '@xpanel/core'
import { mailFolderName } from './inbox.ts'
import type { InboxMessage, InboxSummary, MailAttachmentSummary, MailRemoteImage, MailboxTransport } from './inbox.ts'

/** The caller supplies an already opened, authorized sealed mailbox session. */
export interface FolderWorkspaceDependencies {
  transport: MailboxTransport
  opened: { readonly record: { readonly mailbox: string }; readonly password: string }
  /** Trusted server callback, rechecked immediately before using the transport. */
  authorize?: (context: Readonly<FolderWorkspaceAuthorization>) => void | Promise<void>
}

export type FolderWorkspaceAuthorization =
  | { operation: 'list'; mailbox: string; folder: string }
  | { operation: 'read'; mailbox: string; folder: string; uid: number }
  | { operation: 'move'; mailbox: string; from: string; folder: string; sourceUid: number; sourceUidValidity: number }
  | { operation: 'flag'; mailbox: string; folder: string; uid: number; uidValidity: number; flagged: boolean }

export interface MailboxFolderList {
  mailbox: string
  folder: string
  complete: true
  capabilities: { move: boolean; flag?: boolean }
  messages: InboxSummary[]
  total?: number
  offset?: number
  hasMore?: boolean
  nextOffset?: number | null
}
export interface MailboxFolderRead {
  mailbox: string
  folder: string
  message: InboxMessage
}
export interface MailboxFolderFlag {
  ok: true
  mailbox: string
  folder: string
  uid: number
  uidValidity: number
  flagged: boolean
  stateChanged: boolean
}
export interface MailboxFolderMove {
  ok: true
  mailbox: string
  from: string
  sourceUid: number
  folder: string
  /** Null means the command returned without a destination UID mapping. */
  uid: number | null
  destinationUidKnown: boolean
  stateChanged: boolean
  sourceUidValidity: number
  uidValidityObserved: boolean
  uidValidity?: number
  unknownOutcome?: true
  verificationRequired?: true
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const positiveUid = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const size = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

/** Keep the existing IMAP positive-safe-integer UID grammar, without coercing junk. */
export function mailboxFolderUid(value: unknown): number {
  const uid = typeof value === 'string' && value.length > 0 && value[0] !== '0' && !/[^0-9]/u.test(value)
    ? Number(value) : value
  if (!positiveUid(uid)) return fail('VALIDATION', 'message uid is invalid', { stateChanged: false })
  return uid
}

/** Reuse the established folder/default/custom-folder grammar; do not fork it. */
export function selectedMailboxFolder(value?: unknown): string {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    return fail('VALIDATION', 'that mail folder is not available', { stateChanged: false })
  }
  try { return mailFolderName(value as string | null | undefined) } catch {
    return fail('VALIDATION', 'that mail folder is not available', { stateChanged: false })
  }
}

export function mailboxUidValidity(value: unknown): number {
  if (!positiveUid(value) || value > 0xffffffff) return fail('VALIDATION', 'the observed uidValidity is required', { stateChanged: false })
  return value
}

export function parseMailboxFolderMove(uidInput: unknown, input: unknown): { uid: number; from: string; to: string; uidValidity: number } {
  const uid = mailboxFolderUid(uidInput)
  if (!object(input) || Object.keys(input).some(key => !['from','folder','uidValidity'].includes(key))
    || (input.from !== undefined && typeof input.from !== 'string') || typeof input.folder !== 'string') {
    return fail('VALIDATION', 'a source and destination folder are required', { stateChanged: false })
  }
  return { uid, from: selectedMailboxFolder(input.from), to: selectedMailboxFolder(input.folder), uidValidity: mailboxUidValidity(input.uidValidity) }
}

export function parseMailboxFolderFlag(uidInput: unknown, input: unknown): { uid: number; folder: string; uidValidity: number; flagged: boolean } {
  const uid = mailboxFolderUid(uidInput)
  if (!object(input) || Object.keys(input).some(key => !['folder', 'uidValidity', 'flagged'].includes(key))
    || (input.folder !== undefined && typeof input.folder !== 'string') || typeof input.flagged !== 'boolean') {
    return fail('VALIDATION', 'a folder, observed uidValidity and boolean flagged state are required', { stateChanged: false })
  }
  return { uid, folder: selectedMailboxFolder(input.folder), uidValidity: mailboxUidValidity(input.uidValidity), flagged: input.flagged }
}

export function parseMailboxFolderPagination(pagination?: { offset?: unknown; limit?: unknown }): { offset: number; limit: number } {
  const parseNonNeg = (raw: unknown, fallback: number, max: number, label: string): number => {
    if (raw === undefined || raw === null || raw === '') return fallback
    const num = typeof raw === 'string' && /^(?:0|[1-9]\d*)$/.test(raw) ? Number(raw) : raw
    if (typeof num !== 'number' || !Number.isSafeInteger(num) || num < 0 || num > max) {
      return fail('VALIDATION', `mail folder ${label} is invalid`, { stateChanged: false })
    }
    return num
  }
  const offset = parseNonNeg(pagination?.offset, 0, 100_000, 'offset')
  const limit = parseNonNeg(pagination?.limit, 50, 200, 'limit')
  if (limit < 1) return fail('VALIDATION', 'mail folder limit must be at least 1', { stateChanged: false })
  return { offset, limit }
}

function access(deps: FolderWorkspaceDependencies): { mailbox: string; password: string } {
  const mailbox = deps.opened?.record?.mailbox
  const password = deps.opened?.password
  if (typeof mailbox !== 'string' || mailbox.length === 0 || typeof password !== 'string') {
    return fail('PRECONDITION_FAILED', 'mailbox access is unavailable', { stateChanged: false })
  }
  // Capture identity and session material before an asynchronous authorization.
  return { mailbox, password }
}

async function authorize(deps: FolderWorkspaceDependencies, context: FolderWorkspaceAuthorization): Promise<void> {
  try {
    await deps.authorize?.(Object.freeze(context))
  } catch (error) {
    return fail(isXpanelError(error) ? error.code : 'PRECONDITION_FAILED', 'mailbox access is unavailable', {
      stateChanged: false, reason: 'mailbox_authorization_refused',
    })
  }
}

function invalidResult(): never {
  return fail('PRECONDITION_FAILED', 'the selected mail result could not be verified', { reason: 'invalid_mail_result' })
}

function attachments(value: unknown): MailAttachmentSummary[] {
  if (!Array.isArray(value)) return invalidResult()
  return value.map(item => {
    if (!object(item) || typeof item.name !== 'string' || !size(item.sizeBytes)) return invalidResult()
    return { name: item.name, sizeBytes: item.sizeBytes }
  })
}

function remoteImages(value: unknown): MailRemoteImage[] {
  if (!Array.isArray(value)) return invalidResult()
  return value.map(item => {
    if (!object(item) || typeof item.src !== 'string' || !/^https?:\/\/[^\s"'<>]+$/i.test(item.src) || typeof item.alt !== 'string') return invalidResult()
    return { src: item.src, alt: item.alt }
  })
}

/** Copy only the established public message fields, never arbitrary transport data. */
function summary(value: unknown, folder: string): InboxSummary {
  if (!object(value) || !positiveUid(value.uid) || typeof value.from !== 'string' || typeof value.to !== 'string'
    || typeof value.subject !== 'string' || typeof value.receivedAt !== 'string'
    || typeof value.unread !== 'boolean' || !size(value.sizeBytes)
    || (value.flagged !== undefined && typeof value.flagged !== 'boolean')
    || (value.folder !== undefined && value.folder !== folder)) return invalidResult()
  for (const field of ['fromName', 'cc', 'preview'] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'string') return invalidResult()
  }
  return {
    uid: value.uid, from: value.from, to: value.to, subject: value.subject,
    uidValidityObserved: value.uidValidityObserved === true && positiveUid(value.uidValidity) && value.uidValidity <= 0xffffffff,
    ...(value.uidValidityObserved === true && positiveUid(value.uidValidity) && value.uidValidity <= 0xffffffff ? { uidValidity: value.uidValidity } : {}),
    receivedAt: value.receivedAt, unread: value.unread, sizeBytes: value.sizeBytes,
    ...(value.flagged === undefined ? {} : { flagged: value.flagged as boolean }),
    ...(value.fromName === undefined ? {} : { fromName: value.fromName as string }),
    ...(value.cc === undefined ? {} : { cc: value.cc as string }),
    ...(value.preview === undefined ? {} : { preview: value.preview as string }),
    ...(value.attachments === undefined ? {} : { attachments: attachments(value.attachments) }),
  }
}

function readFailure(error: unknown): never {
  return fail(isXpanelError(error) ? error.code : 'PRECONDITION_FAILED', 'the selected mail could not be read', {
    reason: 'mail_read_failed',
  })
}

export async function listMailboxFolder(
  deps: FolderWorkspaceDependencies,
  folderInput?: unknown,
  pagination?: { offset?: unknown; limit?: unknown },
): Promise<MailboxFolderList> {
  const folder = selectedMailboxFolder(folderInput), { mailbox, password } = access(deps)
  const page = pagination !== undefined ? parseMailboxFolderPagination(pagination) : null
  await authorize(deps, { operation: 'list', mailbox, folder })
  let raw: unknown
  try { raw = await deps.transport.list(mailbox, password, folder) } catch (error) { return readFailure(error) }
  if (!Array.isArray(raw)) return invalidResult()
  const messages = raw.map(value => summary(value, folder)), seen = new Set<number>()
  for (const message of messages) {
    if (seen.has(message.uid)) return invalidResult()
    seen.add(message.uid)
  }
  const capabilities = {
    move: typeof deps.transport.move === 'function',
    ...(typeof deps.transport.flag === 'function' ? { flag: true } : {}),
  }
  if (!page) return { mailbox, folder, complete: true, capabilities, messages }
  const sliced = messages.slice(page.offset, page.offset + page.limit)
  const total = messages.length
  const hasMore = page.offset + sliced.length < total
  const nextOffset = hasMore ? page.offset + sliced.length : null
  return { mailbox, folder, complete: true, capabilities, messages: sliced, total, offset: page.offset, hasMore, nextOffset }
}

export async function readMailboxFolder(
  deps: FolderWorkspaceDependencies,
  uidInput: unknown,
  folderInput?: unknown,
  options?: { allowRemoteImages?: boolean },
): Promise<MailboxFolderRead> {
  const uid = mailboxFolderUid(uidInput), folder = selectedMailboxFolder(folderInput), { mailbox, password } = access(deps)
  await authorize(deps, { operation: 'read', mailbox, folder, uid })
  let raw: unknown
  try {
    raw = await deps.transport.read(mailbox, password, uid, folder, {
      authorize: () => authorize(deps, { operation: 'read', mailbox, folder, uid }),
      ...(options?.allowRemoteImages === true ? { allowRemoteImages: true } : {}),
    })
  } catch (error) { return readFailure(error) }
  await authorize(deps, { operation: 'read', mailbox, folder, uid })
  const message = summary(raw, folder)
  if (!object(raw) || message.uid !== uid || typeof raw.body !== 'string'
    || (raw.hasRemoteImages !== undefined && typeof raw.hasRemoteImages !== 'boolean')) return invalidResult()
  return {
    mailbox,
    folder,
    message: {
      ...message,
      body: raw.body,
      ...(raw.hasRemoteImages === undefined ? {} : { hasRemoteImages: raw.hasRemoteImages as boolean }),
      ...(raw.remoteImages === undefined ? {} : { remoteImages: remoteImages(raw.remoteImages) }),
    },
  }
}

export async function flagMailboxFolder(
  deps: FolderWorkspaceDependencies, uidInput: unknown, input: unknown,
): Promise<MailboxFolderFlag> {
  const { uid, folder, uidValidity, flagged: targetFlag } = parseMailboxFolderFlag(uidInput, input), { mailbox, password } = access(deps)
  await authorize(deps, { operation: 'flag', mailbox, folder, uid, uidValidity, flagged: targetFlag })
  const flagFn = deps.transport.flag
  if (typeof flagFn !== 'function') {
    return fail('PRECONDITION_FAILED', 'this mail server cannot update message flags', {
      stateChanged: false, unsupported: true, reason: 'mail_flag_unsupported',
    })
  }
  let raw: unknown
  try { raw = await flagFn.call(deps.transport, mailbox, password, uid, folder, targetFlag, { uidValidity }) } catch (error) {
    const detail = isXpanelError(error) ? error.detail : object(error) && object(error.details) ? error.details : {}
    if (detail.stateChanged === false && !flagged(detail)) {
      return fail(isXpanelError(error) ? error.code : 'PRECONDITION_FAILED', 'the message flag could not be updated', {
        stateChanged: false, reason: 'mail_flag_refused',
      })
    }
    return fail('PRECONDITION_FAILED', 'the message flag outcome could not be verified', {
      stateChanged: true, unknownOutcome: true, verificationRequired: true, reason: 'mail_flag_unknown',
    })
  }
  if (!object(raw) || raw.uid !== uid || raw.uidValidity !== uidValidity || raw.flagged !== targetFlag) {
    return fail('PRECONDITION_FAILED', 'the message flag outcome could not be verified', {
      stateChanged: true, unknownOutcome: true, verificationRequired: true, reason: 'invalid_mail_flag_result',
    })
  }
  return { ok: true, mailbox, folder, uid, uidValidity, flagged: targetFlag, stateChanged: true }
}

const flagged = (value: Record<string, unknown>): boolean =>
  ['stateChanged', 'unknownOutcome', 'verificationRequired', 'needsAttention'].some(key => value[key] === true)

function moveFailure(error: unknown): never {
  const detail = isXpanelError(error) ? error.detail : object(error) && object(error.details) ? error.details : {}
  const safe = detail.stateChanged === false && !flagged(detail) && !(object(error) && flagged(error))
  if (safe) return fail(isXpanelError(error) ? error.code : 'PRECONDITION_FAILED', 'the message could not be moved', {
    stateChanged: false, reason: 'mail_move_refused',
  })
  return fail('PRECONDITION_FAILED', 'the message move outcome could not be verified', {
    stateChanged: true, unknownOutcome: true, verificationRequired: true, reason: 'mail_move_unknown',
  })
}

function invalidMoveResult(): never {
  return fail('PRECONDITION_FAILED', 'the message move outcome could not be verified', {
    stateChanged: true, unknownOutcome: true, verificationRequired: true, reason: 'invalid_mail_move_result',
  })
}

export async function moveMailboxFolder(
  deps: FolderWorkspaceDependencies, uidInput: unknown, input: unknown,
): Promise<MailboxFolderMove> {
  const { uid, from, to, uidValidity } = parseMailboxFolderMove(uidInput, input), { mailbox, password } = access(deps)
  await authorize(deps, { operation: 'move', mailbox, from, folder: to, sourceUid: uid, sourceUidValidity: uidValidity })
  const context = { ok: true as const, mailbox, from, sourceUid: uid, sourceUidValidity: uidValidity, folder: to }
  if (from === to) return { ...context, uid, destinationUidKnown: false, uidValidityObserved: false, stateChanged: false }
  const move = deps.transport.move
  if (typeof move !== 'function') {
    return fail('PRECONDITION_FAILED', 'this mail server cannot move messages', {
      stateChanged: false, unsupported: true, reason: 'mail_move_unsupported',
    })
  }
  let raw: unknown
  try { raw = await move.call(deps.transport, mailbox, password, uid, from, to, { uidValidity }) } catch (error) { return moveFailure(error) }
  if (raw !== undefined && (!object(raw)
    || (raw.uid !== undefined && !positiveUid(raw.uid))
    || (raw.mailbox !== undefined && raw.mailbox !== mailbox)
    || (raw.from !== undefined && raw.from !== from)
    || (raw.folder !== undefined && raw.folder !== to)
    || (raw.sourceUid !== undefined && raw.sourceUid !== uid)
    || (raw.ok !== undefined && raw.ok !== true)
    || (raw.stateChanged !== undefined && raw.stateChanged !== true)
    || (raw.sourceUidValidity !== undefined && raw.sourceUidValidity !== uidValidity)
    || (flagged({ ...raw, stateChanged: false }) && !(raw.uid === undefined && raw.uidValidity === undefined && raw.sourceUidValidityObserved === true
      && raw.sourceUidValidity === uidValidity && raw.unknownOutcome === true && raw.verificationRequired === true)))) return invalidMoveResult()
  const known = object(raw) && raw.sourceUidValidityObserved === true && raw.sourceUidValidity === uidValidity
    && raw.uidValidityObserved === true && positiveUid(raw.uidValidity) && raw.uidValidity <= 0xffffffff && positiveUid(raw.uid) && raw.uid <= 0xffffffff
    && !flagged({ ...raw, stateChanged: false })
  if (!known) return { ...context, uid: null, destinationUidKnown: false, uidValidityObserved: false, stateChanged: true, unknownOutcome: true, verificationRequired: true }
  const observed = raw as Record<string, unknown>
  return { ...context, uid: observed.uid as number, uidValidity: observed.uidValidity as number, uidValidityObserved: true, destinationUidKnown: true, stateChanged: true }
}
