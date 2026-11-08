import { fail, isXpanelError } from '@xpanel/core'
import type { AuthenticatedCaller } from '../auth.ts'
import { mailboxJson, methodNotAllowed } from './folder-admin.ts'

/** Reads and rebuilds the sealed mailbox's search index, and reports one message as spam or not spam. */
export interface MailboxEngineSession { caller: AuthenticatedCaller; mailbox: string }
export interface MailboxEnginePorts {
  open: (request: Request, tool: 'webmail-search-index' | 'webmail-spam-marking') => Promise<MailboxEngineSession>
  callHost: (caller: AuthenticatedCaller, path: string, body?: Record<string, unknown>) => Promise<unknown>
  /** The move itself: the same checks and result as POST /api/webmail/inbox/:uid/move. */
  move: (caller: AuthenticatedCaller, uid: string, body: unknown) => Promise<Record<string, unknown>>
  readBody: (request: Request) => Promise<unknown>
  audit: (session: MailboxEngineSession, action: string, detail: Record<string, unknown>) => Promise<void>
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const unchanged = { stateChanged: false }
const REPORT = /^\/api\/webmail\/inbox\/([1-9]\d*)\/report$/

export async function handleMailboxEngineRoute(request: Request, url: URL, method: string, ports: MailboxEnginePorts): Promise<Response | null> {
  if (url.pathname === '/api/webmail/search-index') {
    if (method !== 'GET' && method !== 'POST') return methodNotAllowed(['GET', 'POST'])
    if (url.search) return fail('VALIDATION', 'the search index accepts no selectors', unchanged)
    const session = await ports.open(request, 'webmail-search-index')
    if (method === 'GET') return mailboxJson(await ports.callHost(session.caller, '/host/mail/search-index?address=' + encodeURIComponent(session.mailbox)))
    let reply: unknown
    try { reply = await ports.callHost(session.caller, '/host/mail/search-index', { address: session.mailbox }) } catch (error) {
      if (isXpanelError(error) && error.code === 'CONFLICT') return fail('CONFLICT', 'a search index rebuild is already running for this mailbox', { ...unchanged, reason: 'REINDEX_IN_PROGRESS' })
      throw error
    }
    await ports.audit(session, 'webmail.search_index.rebuild_requested', {})
    return mailboxJson(reply, 202)
  }
  const report = REPORT.exec(url.pathname)
  if (!report) return null
  if (method !== 'POST') return methodNotAllowed(['POST'])
  if (url.search) return fail('VALIDATION', 'a spam report accepts no selectors', unchanged)
  const session = await ports.open(request, 'webmail-spam-marking'), body = await ports.readBody(request)
  if (!object(body)) return fail('VALIDATION', 'a spam report needs the move fields', unchanged)
  const spam = body.folder === 'Junk', ham = body.folder === 'INBOX' && body.from === 'Junk'
  if (!spam && !ham || body.from === body.folder) return fail('VALIDATION', 'a message moves to Junk as spam or from Junk to Inbox as not spam', unchanged)
  const moved = await ports.move(session.caller, report[1]!, body), direction = spam ? 'spam' : 'ham'
  // The move stands whether or not training works, so a training failure is reported beside it.
  let training = 'unavailable'
  if (moved.destinationUidKnown === true && typeof moved.uid === 'number') {
    try {
      const reply = await ports.callHost(session.caller, '/host/mail/learn-message', { address: session.mailbox, folder: body.folder, uid: moved.uid, direction })
      training = object(reply) && reply.learned === true ? 'recorded' : object(reply) && typeof reply.reason === 'string' ? reply.reason : 'unavailable'
    } catch { training = 'unavailable' }
  }
  await ports.audit(session, 'webmail.spam_report', { direction, training })
  return mailboxJson({ ...moved, training })
}
