import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { isMailLogWindow, parseMailLogFilters } from '../../../packages/os/src/mail-log-command.ts'

export interface MailLogWorkspaceHelpers {
  requireCaller: (request: Request) => Promise<AuthenticatedCaller>
  assertRoot: (caller: AuthenticatedCaller, action: string) => Promise<void>
  /** Protected agent GET /host/mail/log with this already validated query; no command, unit or path is selectable. */
  readServerLog: (caller: AuthenticatedCaller, query: string) => Promise<unknown>
  now?: () => Date
}
export interface MailTrackDeliveryHelpers {
  /** The sealed mailbox session (feature webmail-track-delivery); the address never comes from the request. */
  openMailbox: (request: Request) => Promise<{ caller: AuthenticatedCaller; mailbox: string }>
  /** Protected agent GET /host/mail/log/mailbox with this already validated query. */
  readMailboxLog: (caller: AuthenticatedCaller, query: string) => Promise<unknown>
  now?: () => Date
}

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' } })
const selectors = (url: URL, allowed: readonly string[]): void => {
  for (const key of new Set(url.searchParams.keys())) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) fail('VALIDATION', 'unsupported or repeated mail log selector', { stateChanged: false })
}
/** Both bounds, or neither for the latest 24 hours; at most 7 days, whole UTC seconds. */
const window = (url: URL, now: () => Date): { since: string; until: string } => {
  const since = url.searchParams.get('since'), until = url.searchParams.get('until')
  if (since === null && until === null) {
    const end = Math.floor(now().getTime() / 1000) * 1000, iso = (ms: number): string => new Date(ms).toISOString().slice(0, 19) + 'Z'
    return { since: iso(end - DEFAULT_WINDOW_MS), until: iso(end) }
  }
  return isMailLogWindow(since, until) ? { since: since!, until: until! } : fail('VALIDATION', 'since and until must be whole-second UTC instants at most 7 days apart', { stateChanged: false })
}
const observed = (body: unknown, scope: 'server' | 'mailbox'): Record<string, unknown> =>
  object(body) && body.scope === scope && (body.state === 'read' || body.state === 'unavailable') && Array.isArray(body.messages)
    ? body : fail('SERVICE_UNAVAILABLE', 'the mail log observation could not be verified', { stateChanged: false })

/** Root delivery report and monitor over the same parsed Postfix journal window. */
export async function handleMailLogWorkspaceRoute(request: Request, url: URL, method: string, helpers: MailLogWorkspaceHelpers): Promise<Response | null> {
  if (url.pathname !== '/api/server/mail-log/delivery' && url.pathname !== '/api/server/mail-log/monitor') return null
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, 'server.mail-log.read')
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  const delivery = url.pathname.endsWith('/delivery')
  selectors(url, delivery ? ['since', 'until', 'sender', 'recipient', 'domain', 'status', 'dsn'] : ['since', 'until'])
  const range = window(url, helpers.now ?? (() => new Date()))
  let filters: Record<string, string> = {}
  try { if (delivery) filters = { ...parseMailLogFilters(key => url.searchParams.get(key)) } } catch { return fail('VALIDATION', 'unsupported mail log filter', { stateChanged: false }) }
  const { summary, messages, matched, omittedMessages, filters: applied, ...view } = observed(await helpers.readServerLog(caller, new URLSearchParams({ ...range, ...filters }).toString()), 'server')
  return json(delivery ? { ...view, filters: applied, matched, messages, omittedMessages } : { ...view, summary })
}

/** xMail track delivery: the agent filters to the sealed mailbox before anything leaves the host. */
export async function handleMailTrackDeliveryRoute(request: Request, url: URL, method: string, helpers: MailTrackDeliveryHelpers): Promise<Response | null> {
  if (url.pathname !== '/api/webmail/track-delivery') return null
  const opened = await helpers.openMailbox(request), mailbox = opened.mailbox.toLowerCase()
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  selectors(url, ['since', 'until'])
  const range = window(url, helpers.now ?? (() => new Date()))
  const body = observed(await helpers.readMailboxLog(opened.caller, new URLSearchParams({ address: mailbox, ...range }).toString()), 'mailbox')
  if (body.mailbox !== mailbox) return fail('SERVICE_UNAVAILABLE', 'the delivery observation scope could not be verified', { stateChanged: false })
  const fresh = await helpers.openMailbox(request)
  if (fresh.mailbox.toLowerCase() !== mailbox || fresh.caller.principal.id !== opened.caller.principal.id) return fail('FORBIDDEN', 'mailbox session changed; sign in again', { stateChanged: false })
  return json(body)
}
