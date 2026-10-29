import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { fail, isXpanelError } from '@xpanel/core'
import type { Db } from '@xpanel/db'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from '../auth.ts'
import { ImapProtocolClient } from './imap.ts'
import type { ImapConnectionConfig, ImapFetchedMessage, ImapSelectedMailboxState } from './imap.ts'
import { imapDialPlan } from './idle.ts'
import { mailReceivedAtUtc, openAuthorizedMailboxSession } from './inbox.ts'
import type { InboxMessage, InboxSummary } from './inbox.ts'
import { mailboxFolderUid, selectedMailboxFolder } from './folder-workspace.ts'

const SEARCH_MAX_MATCHES = 50000
const SEARCH_LITERAL_BYTES = 8 * 1024 * 1024
const SEARCH_PAGE_BYTES = 16 * 1024 * 1024
const SEARCH_BODY_BYTES = 256 * 1024
const CURSOR_TTL_MS = 15 * 60 * 1000

export type MailSearchClient = Pick<ImapProtocolClient, 'connect' | 'login' | 'logout' | 'selectFolder' | 'searchByUtf8Query' | 'fetchMessagesByUid'>
export interface MailSearchSession {
  record: { sessionId: string; mailbox: string; accountId: string; serviceUserId: string }
  password: string
}
export interface MailSearchDependencies {
  db: Db
  store: StateStore
  serverSecret: string
  env?: NodeJS.ProcessEnv
  /** Trusted composition ports; never populated from request input. */
  clientFactory?: (config: ImapConnectionConfig) => MailSearchClient
  openSession?: (caller: AuthenticatedCaller) => Promise<MailSearchSession>
  now?: () => number
}
export interface MailSearchContext { mailbox: string; folder: string; uidValidity: number; query: string }
export interface MailSearchResult {
  context: MailSearchContext
  messages: InboxSummary[]
  page: { limit: number; totalMatches: number; nextCursor: string | null }
}
export interface MailSearchRead {
  context: Omit<MailSearchContext, 'query'>
  message: InboxMessage
  bodyTruncated: boolean
}
interface Cursor { v: 1; session: string; mailbox: string; account: string; serviceUser: string; folder: string; query: string; validity: number; before: number; expires: number }
const queryDigest = (value: string): string => createHash('sha256').update(value).digest('hex')
const sameSession = (left: MailSearchSession, right: MailSearchSession): boolean =>
  ['sessionId', 'mailbox', 'accountId', 'serviceUserId'].every(key => left.record[key as keyof MailSearchSession['record']] === right.record[key as keyof MailSearchSession['record']]) && left.password === right.password
const validIdentity = (value: number): boolean => Number.isSafeInteger(value) && value > 0 && value <= 4294967295

function previewBody(value: string): { body: string; bodyTruncated: boolean } {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= SEARCH_BODY_BYTES) return { body: value, bodyTruncated: false }
  let end = SEARCH_BODY_BYTES
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
  return { body: bytes.subarray(0, end).toString('utf8'), bodyTruncated: true }
}

function onlyParameters(params: URLSearchParams, allowed: readonly string[]): void {
  const seen = new Set<string>()
  for (const [key] of params) {
    if (!allowed.includes(key) || seen.has(key)) fail('VALIDATION', 'unsupported or repeated mail search parameter', { stateChanged: false })
    seen.add(key)
  }
}
export function parseMailSearch(params: URLSearchParams): { query: string; folder: string; limit: number; cursor: string | null } {
  onlyParameters(params, ['q', 'folder', 'limit', 'cursor'])
  const query = (params.get('q') ?? '').normalize('NFC').trim()
  if (!query || !query.isWellFormed() || [...query].length > 256 || Buffer.byteLength(query, 'utf8') > 1024 || /[\u0000-\u001f\u007f-\u009f]/.test(query)) {
    return fail('VALIDATION', 'search text must contain from 1 through 256 characters without control characters', { stateChanged: false })
  }
  const raw = params.get('limit') ?? '20'
  const limit = /^[1-9][0-9]?$/.test(raw) ? Number(raw) : 0
  if (limit < 1 || limit > 50) return fail('VALIDATION', 'search page size must be from 1 through 50', { stateChanged: false })
  const cursor = params.get('cursor')
  if (cursor !== null && (!cursor || cursor.length > 4096)) return fail('VALIDATION', 'mail search cursor is invalid', { stateChanged: false })
  return { query, folder: selectedMailboxFolder(params.get('folder')), limit, cursor }
}

function observedIdentity(state: ImapSelectedMailboxState, folder: string): number {
  if (state.folder !== folder || state.uidValidityObserved !== true || !validIdentity(state.uidValidity)) {
    return fail('PRECONDITION_FAILED', 'mailbox identity was not observed; search cannot safely identify messages', { reason: 'mail_search_identity_unobserved' })
  }
  return state.uidValidity
}
function project(message: ImapFetchedMessage, mailbox: string, folder: string, validity: number): InboxSummary {
  if (message.mailbox !== mailbox || message.folder !== folder || message.uidValidity !== validity || !validIdentity(message.uid)
    || !Number.isSafeInteger(message.sizeBytes) || message.sizeBytes < 0) return fail('PRECONDITION_FAILED', 'mail search result identity could not be verified')
  if (message.rfc822SizeObserved !== true || message.bodyComplete !== true || !(message.rawMimeBytes instanceof Uint8Array)
    || message.rawMimeBytes.byteLength !== message.sizeBytes) return fail('PRECONDITION_FAILED', 'the complete mail source could not be verified', { reason: 'mail_search_source_unverified' })
  const parsed = message.parsed
  if (!parsed || typeof parsed.subject !== 'string' || typeof parsed.from !== 'string' || !Array.isArray(parsed.to)
    || !Array.isArray(parsed.cc) || typeof parsed.textBody !== 'string' || !Array.isArray(message.flags)) return fail('PRECONDITION_FAILED', 'mail search result could not be read')
  return { uid: message.uid, from: parsed.from.slice(0, 4096), fromName: parsed.fromName?.slice(0, 4096) ?? '', to: parsed.to.join(', ').slice(0, 8192),
    ...(parsed.cc.length ? { cc: parsed.cc.join(', ').slice(0, 8192) } : {}), subject: parsed.subject.slice(0, 4096),
    receivedAt: mailReceivedAtUtc(parsed.date ?? message.internalDate ?? '').slice(0, 256),
    preview: parsed.textBody.split(/\r?\n/).find(line => line.trim())?.trim().slice(0, 180) ?? '',
    unread: !message.flags.some(flag => flag.toLowerCase() === '\\seen'), sizeBytes: message.sizeBytes }
}

/** Real sealed-mailbox IMAP search, never the administrative JSON message archive. */
export function createMailSearchWorkspace(deps: MailSearchDependencies) {
  const open = deps.openSession ?? (caller => openAuthorizedMailboxSession(deps.db, deps.store, deps.serverSecret, caller))
  const now = deps.now ?? Date.now
  const key = createHmac('sha256', deps.serverSecret).update('mail-search-cursor:v1').digest()
  const sign = (payload: Cursor): string => {
    const value = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    return value + '.' + createHmac('sha256', key).update(value).digest('base64url')
  }
  const cursor = (token: string, session: MailSearchSession, folder: string, query: string, validity: number): Cursor => {
    try {
      const parts = token.split('.')
      if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) throw new Error('invalid')
      const actual = Buffer.from(parts[1]!, 'base64url'), expected = createHmac('sha256', key).update(parts[0]!).digest()
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('invalid')
      const value = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as Cursor
      if (!value || value.v !== 1 || value.session !== session.record.sessionId || value.mailbox !== session.record.mailbox
        || value.account !== session.record.accountId || value.serviceUser !== session.record.serviceUserId
        || value.folder !== folder || value.query !== queryDigest(query) || !validIdentity(value.before)
        || !validIdentity(value.validity) || !Number.isSafeInteger(value.expires)) throw new Error('invalid')
      if (value.expires < now()) return fail('PRECONDITION_FAILED', 'mail search cursor expired; search again', { reason: 'mail_search_cursor_expired' })
      if (value.validity !== validity) return fail('CONFLICT', 'mailbox identity changed; search again', { reason: 'mail_search_identity_changed' })
      return value
    } catch (error) {
      if (isXpanelError(error)) throw error
      return fail('VALIDATION', 'mail search cursor does not match this mailbox search', { stateChanged: false })
    }
  }
  const imap = async <T>(caller: AuthenticatedCaller, run: (client: MailSearchClient, session: MailSearchSession) => Promise<T>): Promise<T> => {
    const session = await open(caller)
    const env = deps.env ?? process.env
    const host = env.XPANEL_IMAP_HOST || '127.0.0.1', port = Number(env.XPANEL_IMAP_PORT || '143')
    const timeoutMs = Number(env.XPANEL_IMAP_TIMEOUT_MS || '15000'), plan = imapDialPlan(host, port, env.XPANEL_IMAP_TLS)
    if (!plan || !Number.isSafeInteger(port) || port < 1 || port > 65535 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) {
      return fail('PRECONDITION_FAILED', 'mail search connection configuration is unavailable')
    }
    const client = (deps.clientFactory ?? (config => new ImapProtocolClient(config)))({ host, port, tls: plan.tls, rejectUnauthorized: true, timeoutMs,
      maxLiteralBytes: SEARCH_LITERAL_BYTES, maxResponseLineBytes: 1024 * 1024, maxSearchResults: SEARCH_MAX_MATCHES })
    try {
      await client.connect(); await client.login(session.record.mailbox, session.password)
      if (!sameSession(session, await open(caller))) return fail('FORBIDDEN', 'mailbox authorization changed')
      const result = await run(client, session)
      if (!sameSession(session, await open(caller))) return fail('FORBIDDEN', 'mailbox authorization changed')
      return result
    } catch (error) {
      if (isXpanelError(error) && !/\bIMAP\b/i.test(error.message)) throw error
      return fail(isXpanelError(error) ? error.code : 'PRECONDITION_FAILED', 'mail search could not read the mail server', { reason: 'mail_search_unavailable' })
    } finally { await client.logout().catch(() => undefined) }
  }
  return {
    async search(caller: AuthenticatedCaller, params: URLSearchParams): Promise<MailSearchResult> {
      const input = parseMailSearch(params)
      return imap(caller, async (client, session) => {
        const mailbox = session.record.mailbox, validity = observedIdentity(await client.selectFolder(input.folder, mailbox), input.folder)
        const previous = input.cursor ? cursor(input.cursor, session, input.folder, input.query, validity) : null
        const raw = await client.searchByUtf8Query(input.folder, input.query, mailbox)
        if (!Array.isArray(raw) || raw.length > SEARCH_MAX_MATCHES || raw.some(uid => !validIdentity(uid))) return fail('PRECONDITION_FAILED', 'mail search result exceeds its supported bounds; narrow the search', { reason: 'mail_search_capacity' })
        const uids = [...new Set(raw)].sort((left, right) => right - left), remaining = uids.filter(uid => !previous || uid < previous.before)
        const selected = remaining.slice(0, input.limit), messages: InboxSummary[] = []
        let bytes = 0
        for (const uid of selected) {
          const fetched = await client.fetchMessagesByUid(input.folder, uid, { requestedMailbox: mailbox, mimeLimits: { maxTotalBytes: SEARCH_LITERAL_BYTES } })
          if (observedIdentity(fetched.state, input.folder) !== validity) return fail('CONFLICT', 'mailbox identity changed; search again', { reason: 'mail_search_identity_changed' })
          if (!Array.isArray(fetched.messages) || fetched.messages.length > 1 || fetched.messages.some(message => message.uid !== uid)) return fail('PRECONDITION_FAILED', 'mail search returned an unexpected message')
          for (const message of fetched.messages) {
            const rawBytes = message.rawMimeBytes instanceof Uint8Array ? message.rawMimeBytes.byteLength : Buffer.byteLength(message.rawMime, 'utf8')
            bytes += Math.max(message.sizeBytes, rawBytes)
            if (bytes > SEARCH_PAGE_BYTES) return fail('PRECONDITION_FAILED', 'the search page exceeds its bounded message read size', { reason: 'mail_search_capacity' })
            messages.push(project(message, mailbox, input.folder, validity))
          }
        }
        if (observedIdentity(await client.selectFolder(input.folder, mailbox), input.folder) !== validity) {
          return fail('CONFLICT', 'mailbox identity changed; search again', { reason: 'mail_search_identity_changed' })
        }
        const nextCursor = remaining.length > selected.length && selected.length ? sign({ v: 1, session: session.record.sessionId, mailbox,
          account: session.record.accountId, serviceUser: session.record.serviceUserId, folder: input.folder, query: queryDigest(input.query),
          validity, before: selected.at(-1)!, expires: now() + CURSOR_TTL_MS }) : null
        return { context: { mailbox, folder: input.folder, uidValidity: validity, query: input.query }, messages,
          page: { limit: input.limit, totalMatches: uids.length, nextCursor } }
      })
    },
    async read(caller: AuthenticatedCaller, params: URLSearchParams): Promise<MailSearchRead> {
      onlyParameters(params, ['uid', 'folder', 'uidValidity'])
      const uid = mailboxFolderUid(params.get('uid')), folder = selectedMailboxFolder(params.get('folder'))
      const validity = mailboxFolderUid(params.get('uidValidity'))
      if (!validIdentity(uid) || !validIdentity(validity)) return fail('VALIDATION', 'mail message identity is invalid', { stateChanged: false })
      return imap(caller, async (client, session) => {
        const mailbox = session.record.mailbox, fetched = await client.fetchMessagesByUid(folder, uid, { requestedMailbox: mailbox, mimeLimits: { maxTotalBytes: SEARCH_LITERAL_BYTES } })
        if (observedIdentity(fetched.state, folder) !== validity) return fail('CONFLICT', 'mailbox identity changed; search again', { reason: 'mail_search_identity_changed' })
        if (!Array.isArray(fetched.messages) || fetched.messages.some(message => message.uid !== uid) || fetched.messages.length > 1) return fail('PRECONDITION_FAILED', 'mail message identity could not be verified')
        const message = fetched.messages[0]
        if (!message) return fail('NOT_FOUND', 'message no longer exists in this folder')
        const summary = project(message, mailbox, folder, validity), body = message.parsed.textBody
        if (observedIdentity(await client.selectFolder(folder, mailbox), folder) !== validity) return fail('CONFLICT', 'mailbox identity changed; search again', { reason: 'mail_search_identity_changed' })
        const preview = previewBody(body)
        return { context: { mailbox, folder, uidValidity: validity }, message: { ...summary, body: preview.body }, bodyTruncated: preview.bodyTruncated }
      })
    },
  }
}
