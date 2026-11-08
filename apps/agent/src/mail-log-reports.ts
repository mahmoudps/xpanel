import { fail } from '@xpanel/core'
import { MAIL_LOG_STATUSES, isMailLogInstant, isMailLogWindow } from '../../../packages/os/src/mail-log-command.ts'
import type { MailLogStatus } from '../../../packages/os/src/mail-log-command.ts'
import { ADDRESS_TOKEN, MAX_OUT, clipMailLogText, domainOf, fit, lower, newest, observeMailLog, statusOf } from './mail-log.ts'
import type { MailLogObservation, MailLogRecipient, MailLogRun, MailboxDeliveryEvent } from './mail-log.ts'
import type { AgentCallerIdentity } from './server.ts'

export interface MailReportSnapshot {
  accounts: readonly { id: string; username: string }[]
  domains: readonly { name: string; accountId: string }[]
}
export interface MailRelayerRow { user: string; domain: string; account: string | null; messages: number; recipients: number; sent: number; deferred: number; failed: number; bytes: number }
export interface MailSentDomainRow { domain: string; account: string; messages: number; sent: number; deferred: number; failed: number; bytes: number }
export interface MailReportView {
  state: 'read' | 'unavailable'; reason: string | null; observedAt: string; window: { since: string; until: string }; complete: boolean
  relayers: MailRelayerRow[]; relayersOmitted: number; domains: MailSentDomainRow[]; domainsOmitted: number
}
export interface AccountDeliveryMessage {
  queueId: string | null; direction: 'sent' | 'received' | 'both'; firstSeen: string; lastSeen: string; sender: string | null; senderUser: string | null; client: string | null
  messageId: string | null; size: number | null; status: MailLogStatus; dsn: string | null; recipients: Omit<MailLogRecipient, 'originalAddress'>[]; otherRecipients: number
  events: MailboxDeliveryEvent[]; eventsOmitted: number
}
export interface AccountDeliveryFilters { recipient?: string; statuses?: readonly MailLogStatus[] }
export interface MailLogAccountView {
  scope: 'account'; account: string; state: 'read' | 'unavailable'; reason?: string; observedAt: string; window: { since: string; until: string }; complete: boolean
  matched: number; messages: AccountDeliveryMessage[]; omittedMessages: number
}

const REPORT_ROWS_MAX = 500
export const ACCOUNT_DELIVERY_MAX = 250
const complete = (observation: MailLogObservation): boolean => observation.state === 'read' && observation.counts.unparsed === 0 && observation.counts.untrusted === 0 && !observation.lineLimitReached
const rank = <T extends { messages: number }>(rows: T[], name: (row: T) => string): T[] => rows.sort((left, right) => right.messages - left.messages || name(left).localeCompare(name(right)))
const FAILED: readonly string[] = ['bounced', 'expired', 'rejected']

/** Remote deliveries by authenticated user (or envelope sender), and every message sent from a hosted domain. */
export function buildMailReport(observation: MailLogObservation, snapshot: MailReportSnapshot): MailReportView {
  const owners = new Map(snapshot.accounts.map(account => [account.id, account.username]))
  const hosted = new Map(snapshot.domains.flatMap(domain => { const owner = owners.get(domain.accountId); return owner ? [[domain.name.toLowerCase(), owner] as const] : [] }))
  const relayers = new Map<string, MailRelayerRow>(), domains = new Map<string, MailSentDomainRow>()
  const count = (row: { sent: number; deferred: number; failed: number }, status: string): void => { if (status === 'sent') row.sent++; else if (status === 'deferred') row.deferred++; else if (FAILED.includes(status)) row.failed++ }
  for (const message of observation.messages) {
    const recipients = [...message.recipients.values()], senderDomain = domainOf(message.sender)
    const remote = new Set(message.lines.filter(line => line.kind === 'delivery' && line.source === 'smtp').map(line => lower(line.recipient)))
    if (remote.size) {
      const user = lower(message.saslUsername || message.sender) || 'unknown', domain = user.includes('@') ? domainOf(user) : senderDomain
      const row = relayers.get(user) ?? { user: clipMailLogText(user, 254), domain: clipMailLogText(domain, 254), account: hosted.get(domain) ?? null, messages: 0, recipients: 0, sent: 0, deferred: 0, failed: 0, bytes: 0 }
      row.messages++; row.bytes += message.size ?? 0
      for (const item of recipients) if (remote.has(lower(item.address))) { row.recipients++; count(row, item.status) }
      relayers.set(user, row)
    }
    const owner = hosted.get(senderDomain)
    if (owner) {
      const row = domains.get(senderDomain) ?? { domain: senderDomain, account: owner, messages: 0, sent: 0, deferred: 0, failed: 0, bytes: 0 }
      row.messages++; row.bytes += message.size ?? 0
      for (const item of recipients) count(row, item.status)
      domains.set(senderDomain, row)
    }
  }
  const relayerRows = rank([...relayers.values()], row => row.user), domainRows = rank([...domains.values()], row => row.domain)
  return { state: observation.state, reason: observation.reason ?? null, observedAt: observation.observedAt, window: observation.window, complete: complete(observation),
    relayers: relayerRows.slice(0, REPORT_ROWS_MAX), relayersOmitted: Math.max(0, relayerRows.length - REPORT_ROWS_MAX), domains: domainRows.slice(0, REPORT_ROWS_MAX), domainsOmitted: Math.max(0, domainRows.length - REPORT_ROWS_MAX) }
}

/**
 * Track Delivery for one hosting account: only messages sent from or received by its domains leave the agent. A message
 * the account sent shows every recipient; a message it received shows its own recipients and only a count of the others.
 */
export function projectAccountMailLog(observation: MailLogObservation, account: string, domains: readonly string[], filters: AccountDeliveryFilters = {}): MailLogAccountView {
  const own = new Set(domains.map(domain => domain.toLowerCase())), mine = (address: string | null | undefined): boolean => own.has(domainOf(address ?? null))
  const redact = (text: string | null): string | null => text === null ? null : text.replace(ADDRESS_TOKEN, token => mine(token) ? token : '[address]')
  const kept: AccountDeliveryMessage[] = []
  for (const message of [...observation.messages].sort(newest)) {
    const all = [...message.recipients.values()], sent = mine(message.sender), received = all.filter(item => mine(item.address) || mine(item.originalAddress))
    if (!sent && !received.length) continue
    const visible = sent ? all : received, [status, dsn] = statusOf(visible, message.expired)
    if (filters.statuses && !filters.statuses.includes(status)) continue
    if (filters.recipient && !visible.some(item => lower(item.address).includes(filters.recipient!))) continue
    const shown = new Set(visible.map(item => lower(item.address)))
    const events: MailboxDeliveryEvent[] = []
    for (const line of message.lines) {
      if (line.kind === 'client') events.push({ at: line.at, kind: 'received' })
      else if (line.kind === 'delivery' || line.kind === 'rejected') { if (shown.has(lower(line.recipient))) events.push({ at: line.at, kind: line.kind, status: line.status!, dsn: line.dsn ?? null }) }
      else if (line.kind !== 'message-id') events.push({ at: line.at, kind: line.kind })
    }
    kept.push({ queueId: message.queueId, direction: sent && received.length ? 'both' : sent ? 'sent' : 'received', firstSeen: message.firstSeen, lastSeen: message.lastSeen,
      sender: message.sender ? clipMailLogText(message.sender, 254) : null, senderUser: sent && message.saslUsername ? clipMailLogText(message.saslUsername, 254) : null, client: message.client ? clipMailLogText(message.client, 300) : null,
      messageId: message.messageId, size: message.size, status, dsn, recipients: visible.slice(0, MAX_OUT).map(({ originalAddress: _hidden, ...item }) => sent ? item : { ...item, response: redact(item.response) }),
      otherRecipients: all.length - visible.length, events: events.slice(-MAX_OUT), eventsOmitted: Math.max(0, events.length - MAX_OUT) })
  }
  const { kept: fitted } = fit(kept.slice(0, ACCOUNT_DELIVERY_MAX))
  return { scope: 'account', account, state: observation.state, ...(observation.reason ? { reason: observation.reason } : {}), observedAt: observation.observedAt, window: observation.window, complete: complete(observation),
    matched: kept.length, messages: fitted, omittedMessages: kept.length - fitted.length }
}

export interface MailReportRouteContext {
  authenticateCaller: (req: Request) => Promise<AgentCallerIdentity>
  assertRootCaller: (caller: AgentCallerIdentity, target: string) => Promise<void>
  /** Fresh authority of the active account's owner (or root), by username; returns the account's own domain names. */
  assertAccount: (caller: AgentCallerIdentity, username: string) => Promise<{ domains: string[] }>
  readSnapshot: () => Promise<MailReportSnapshot>
  run: MailLogRun | null
  now?: () => Date
}
const ACCOUNT_ROUTE = /^\/host\/mail\/log\/account\/([a-z][a-z0-9]{0,15})$/
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const FRAGMENT = /^[^\s\u0000-\u001f\u007f<>"]{1,254}$/

export interface MailOutcomes { state: 'read' | 'unavailable'; complete: boolean; usage: { user: string; domain: string; recipients: number }[]; marketing: { messageId: string; recipient: string; status: string; at: string }[] }
/** Message-ID prefix of campaign mail: its results are read back here, and it does not count against sending limits. */
export const MARKETING_MESSAGE_PREFIX = '<xpm-'
/** Remote deliveries finished at or after `from`, per authenticated user or sender; the log window reaches further back so a message keeps its sender. */
export function buildMailOutcomes(observation: MailLogObservation, from: string): MailOutcomes {
  const usage = new Map<string, { user: string; domain: string; recipients: number }>(), marketing: MailOutcomes['marketing'] = [], cutoff = Date.parse(from)
  for (const message of observation.messages) {
    const campaign = message.messageId?.startsWith(MARKETING_MESSAGE_PREFIX) === true
    for (const line of message.lines) {
      if (line.kind !== 'delivery' || Date.parse(line.at) < cutoff || !line.recipient) continue
      if (campaign) { if (marketing.length < 20000) marketing.push({ messageId: message.messageId!, recipient: lower(line.recipient), status: line.status ?? 'unknown', at: line.at }); continue }
      if (line.source !== 'smtp' || line.status === 'deferred') continue
      const user = lower(message.saslUsername || message.sender)
      if (!user) continue
      const row = usage.get(user) ?? { user: clipMailLogText(user, 254), domain: domainOf(user.includes('@') ? user : message.sender ?? ''), recipients: 0 }
      row.recipients++; usage.set(user, row)
    }
  }
  return { state: observation.state, complete: complete(observation), usage: [...usage.values()], marketing }
}

/** GET /host/mail/log/report (root), GET /host/mail/log/outcomes (root) and GET /host/mail/log/account/<username> (that account's owner or root). */
export async function handleMailReportRoute(req: Request, url: URL, method: string, ctx: MailReportRouteContext): Promise<Response | null> {
  const username = ACCOUNT_ROUTE.exec(url.pathname)?.[1]
  const outcomes = url.pathname === '/host/mail/log/outcomes'
  if (url.pathname !== '/host/mail/log/report' && !outcomes && !username) return null
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  const allowed = username ? ['since', 'until', 'recipient', 'statuses'] : outcomes ? ['since', 'until', 'from'] : ['since', 'until']
  const caller = await ctx.authenticateCaller(req)
  const authorize = async (current: AgentCallerIdentity): Promise<string[]> => { if (username) return (await ctx.assertAccount(current, username)).domains; await ctx.assertRootCaller(current, 'host.mail.report'); return [] }
  await authorize(caller)
  const keys = [...url.searchParams.keys()]
  if (req.body !== null || keys.some(key => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1)) return fail('VALIDATION', 'mail reports accept only one value for each supported selector', { stateChanged: false })
  const since = url.searchParams.get('since'), until = url.searchParams.get('until'), recipient = url.searchParams.get('recipient'), statuses = url.searchParams.get('statuses')
  if (!isMailLogInstant(since) || !isMailLogInstant(until) || !isMailLogWindow(since, until)) return fail('VALIDATION', 'a whole-second UTC window of at most 7 days is required', { stateChanged: false })
  if (recipient !== null && !FRAGMENT.test(recipient)) return fail('VALIDATION', 'unsupported recipient filter', { stateChanged: false })
  const list = statuses === null ? undefined : statuses.split(',') as MailLogStatus[], from = url.searchParams.get('from')
  if (outcomes && !isMailLogInstant(from)) return fail('VALIDATION', 'a whole-second UTC start of the counted deliveries is required', { stateChanged: false })
  if (list && (!list.length || list.some(item => !MAIL_LOG_STATUSES.includes(item)))) return fail('VALIDATION', 'unsupported status filter', { stateChanged: false })
  const observation = await observeMailLog({ run: ctx.run, since, until, ...(ctx.now ? { now: ctx.now } : {}) })
  const fresh = await ctx.authenticateCaller(req)
  if (fresh.principalId !== caller.principalId || fresh.actor !== caller.actor) return fail('FORBIDDEN', 'mail report authority changed', { stateChanged: false })
  const domains = await authorize(fresh)
  if (outcomes) return json(buildMailOutcomes(observation, from!))
  return json(username ? projectAccountMailLog(observation, username, domains, { ...(recipient === null ? {} : { recipient: recipient.toLowerCase() }), ...(list ? { statuses: list } : {}) }) : buildMailReport(observation, await ctx.readSnapshot()))
}
