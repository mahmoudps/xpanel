import { createHash } from 'node:crypto'
import { fail, isXpanelError } from '@xpanel/core'
import { DRAFT_MIME_MAX_BYTES, parseExpectedDraft } from './draft-workspace.ts'
import type { DraftObservation, DraftTransport } from './draft-workspace.ts'
import { ImapProtocolClient } from './imap.ts'
import type { ImapConnectionConfig, ImapSelectedMailboxState } from './imap.ts'
import { imapDialPlan } from './idle.ts'

export type DraftNativeClient = Pick<ImapProtocolClient, 'connect' | 'login' | 'logout' | 'selectFolder' | 'fetchMessagesByUid' | 'appendMessage' | 'moveByUidWithIdentity'>
export interface DraftNativeSession {
  record: { sessionId: string; mailbox: string; accountId: string; serviceUserId: string }
  password: string
}
export interface DraftNativeDependencies {
  /** Trusted server closure reopening the current authorized sealed mailbox; never request input. */
  openSession: () => Promise<DraftNativeSession>
  env?: NodeJS.ProcessEnv
  /** Declared composition/test port. Production defaults to the canonical IMAP client. */
  clientFactory?: (config: ImapConnectionConfig) => DraftNativeClient
}

const positiveUid = (value: number): boolean => Number.isSafeInteger(value) && value > 0 && value <= 4294967295
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const sameSession = (left: DraftNativeSession, right: DraftNativeSession): boolean =>
  (['sessionId', 'mailbox', 'accountId', 'serviceUserId'] as const).every(key => left.record[key] === right.record[key]) && left.password === right.password

function observedValidity(state: ImapSelectedMailboxState, folder: string): number {
  if (state.folder !== folder || state.uidValidityObserved !== true || !positiveUid(state.uidValidity)) return fail('PRECONDITION_FAILED', 'the draft mailbox identity was not observed')
  return state.uidValidity
}

/** Native Drafts APPEND/readback/retirement for one pinned authorized sealed session. */
export function createNativeDraftTransport(deps: DraftNativeDependencies): DraftTransport {
  const env = deps.env ?? process.env
  const host = env.XPANEL_IMAP_HOST || '127.0.0.1', port = Number(env.XPANEL_IMAP_PORT || '143')
  const timeoutMs = Number(env.XPANEL_IMAP_TIMEOUT_MS || '15000'), plan = imapDialPlan(host, port, env.XPANEL_IMAP_TLS)
  if (!plan || !host.trim() || /[\u0000-\u0020\u007f]/.test(host) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) return fail('PRECONDITION_FAILED', 'draft mail connection configuration is unavailable', { stateChanged: false })
  const config: ImapConnectionConfig = { host, port, tls: plan.tls, rejectUnauthorized: true, timeoutMs,
    maxLiteralBytes: DRAFT_MIME_MAX_BYTES, maxResponseLineBytes: 1024 * 1024, maxSearchResults: 50000 }
  let pinned: DraftNativeSession | undefined
  const authorize = async (): Promise<DraftNativeSession> => {
    const current = await deps.openSession()
    if (!current || !current.record || (['sessionId', 'mailbox', 'accountId', 'serviceUserId'] as const).some(key => typeof current.record[key] !== 'string' || !current.record[key])
      || typeof current.password !== 'string' || !current.password) return fail('FORBIDDEN', 'the authorized draft mailbox is unavailable')
    const snapshot = { record: { sessionId: current.record.sessionId, mailbox: current.record.mailbox, accountId: current.record.accountId, serviceUserId: current.record.serviceUserId }, password: current.password }
    if (pinned && !sameSession(pinned, snapshot)) return fail('FORBIDDEN', 'the authorized draft mailbox changed')
    pinned ??= snapshot
    return snapshot
  }
  const imap = async <T>(run: (client: DraftNativeClient, session: DraftNativeSession, mutation: () => void) => Promise<T>): Promise<T> => {
    let client: DraftNativeClient | undefined, attempted = false
    try {
      const session = await authorize()
      client = (deps.clientFactory ?? (options => new ImapProtocolClient(options)))({ ...config })
      await client.connect(); await client.login(session.record.mailbox, session.password)
      await authorize()
      const result = await run(client, session, () => { attempted = true })
      await authorize()
      return result
    } catch (error) {
      return fail(isXpanelError(error) ? error.code : 'PRECONDITION_FAILED', 'draft mail server operation could not be verified', {
        reason: 'draft_native_unverified', stateChanged: attempted, unknownOutcome: attempted, verificationRequired: attempted,
      })
    } finally { if (client) await client.logout().catch(() => undefined) }
  }
  const observe = async (client: DraftNativeClient, session: DraftNativeSession, folder: string, uid: number): Promise<DraftObservation> => {
    const mailbox = session.record.mailbox
    const fetched = await client.fetchMessagesByUid(folder, uid, { requestedMailbox: mailbox, mimeLimits: { maxTotalBytes: DRAFT_MIME_MAX_BYTES } })
    const validity = observedValidity(fetched.state, folder)
    if (!Array.isArray(fetched.messages) || fetched.messages.length > 1 || fetched.messages.some(message => message.uid !== uid)) return fail('PRECONDITION_FAILED', 'the draft read returned an unexpected identity')
    const source = fetched.messages[0]
    let message: DraftObservation['message'] = null
    if (source) {
      if (source.mailbox !== mailbox || source.folder !== folder || source.uidValidity !== validity || source.rfc822SizeObserved !== true || source.bodyComplete !== true
        || !Number.isSafeInteger(source.sizeBytes) || source.sizeBytes < 1 || source.sizeBytes > DRAFT_MIME_MAX_BYTES
        || !(source.rawMimeBytes instanceof Uint8Array) || source.rawMimeBytes.byteLength !== source.sizeBytes) return fail('PRECONDITION_FAILED', 'the complete draft source could not be verified')
      message = { mailbox: source.mailbox, folder: source.folder, uid: source.uid, uidValidity: source.uidValidity, sizeBytes: source.sizeBytes,
        rfc822SizeObserved: source.rfc822SizeObserved, bodyComplete: source.bodyComplete, rawMimeBytes: Buffer.from(source.rawMimeBytes) }
    }
    if (observedValidity(await client.selectFolder(folder, mailbox), folder) !== validity) return fail('CONFLICT', 'the draft mailbox identity changed while reading')
    return { mailbox, folder, uidValidity: validity, uidValidityObserved: fetched.state.uidValidityObserved === true, message }
  }
  return {
    async appendDraft(rawMime, flags) {
      if (!(rawMime instanceof Uint8Array) || rawMime.byteLength < 1 || rawMime.byteLength > DRAFT_MIME_MAX_BYTES
        || !Array.isArray(flags) || flags.length !== 1 || flags[0] !== '\\Draft') return fail('VALIDATION', 'the draft append is outside the supported bounds', { stateChanged: false })
      const bytes = Buffer.from(rawMime)
      return imap(async (client, session, mutation) => {
        const validity = observedValidity(await client.selectFolder('Drafts', session.record.mailbox), 'Drafts')
        await authorize(); mutation()
        const result = await client.appendMessage('Drafts', bytes, ['\\Draft'], session.record.mailbox)
        if (result.appendedUid === null && result.appendedUidValidity === null) return { appendedUid: null, appendedUidValidity: null }
        if (!positiveUid(result.appendedUid!) || !positiveUid(result.appendedUidValidity!) || result.appendedUidValidity !== validity) return fail('PRECONDITION_FAILED', 'the appended draft identity could not be verified')
        return { appendedUid: result.appendedUid, appendedUidValidity: result.appendedUidValidity }
      })
    },
    async observeDraft(uid) {
      if (!positiveUid(uid)) return fail('VALIDATION', 'the draft UID is invalid', { stateChanged: false })
      return imap((client, session) => observe(client, session, 'Drafts', uid))
    },
    async retireDraft(value) {
      const expected = parseExpectedDraft(value)
      if (!expected) return fail('VALIDATION', 'the previous draft identity is required', { stateChanged: false })
      return imap(async (client, session, mutation) => {
        const previous = await observe(client, session, 'Drafts', expected.uid)
        if (previous.uidValidity !== expected.uidValidity || !previous.message || digest(previous.message.rawMimeBytes) !== expected.revision) return fail('CONFLICT', 'the previous draft changed before retirement')
        const trashValidity = observedValidity(await client.selectFolder('Trash', session.record.mailbox), 'Trash')
        await authorize(); mutation()
        const moved = await client.moveByUidWithIdentity('Drafts', expected.uid, 'Trash', expected.uidValidity, session.record.mailbox)
        if (moved.sourceUid !== expected.uid || !positiveUid(moved.destinationUid) || !positiveUid(moved.destinationUidValidity) || moved.destinationUidValidity !== trashValidity) return fail('PRECONDITION_FAILED', 'the retired draft destination could not be verified')
        const destination = await observe(client, session, 'Trash', moved.destinationUid)
        if (destination.uidValidity !== moved.destinationUidValidity || !destination.message || digest(destination.message.rawMimeBytes) !== expected.revision) return fail('PRECONDITION_FAILED', 'the complete retired draft was not observed in Trash')
        const remaining = await observe(client, session, 'Drafts', expected.uid)
        if (remaining.uidValidity !== expected.uidValidity || remaining.message !== null) return fail('PRECONDITION_FAILED', 'the previous draft was not confirmed absent')
        return { destinationUid: moved.destinationUid, destinationUidValidity: moved.destinationUidValidity }
      })
    },
  }
}
