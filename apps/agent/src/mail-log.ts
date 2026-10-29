import { createHash } from 'node:crypto'
import { fail } from '@xpanel/core'
import type { PrincipalRecord } from '@xpanel/db'
import type { StateStore } from '@xpanel/state'
import { MAIL_LOG_IDENTIFIERS, MAIL_LOG_MAX_LINES, isMailLogInstant, isMailLogMailbox, isMailLogWindow, mailLogArgv, parseMailLogFilters } from '../../../packages/os/src/mail-log-command.ts'
import type { MailLogFilters, MailLogStatus } from '../../../packages/os/src/mail-log-command.ts'
import { isMailQueueId } from '../../../packages/os/src/mail-queue-command.ts'
import type { AgentCallerIdentity } from './server.ts'
export { MAIL_LOG_MAX_LINES, mailLogArgv } from '../../../packages/os/src/mail-log-command.ts'
export type { MailLogFilters, MailLogStatus } from '../../../packages/os/src/mail-log-command.ts'

export interface MailLogCommandResult { ok: boolean; code?: number; stdout: string; stderr: string }
export type MailLogRun = (argv: string[]) => Promise<MailLogCommandResult>
type DeliveryStatus = Exclude<MailLogStatus, 'queued'>
export type MailLogKind = 'client' | 'message-id' | 'queued' | 'delivery' | 'rejected' | 'expired' | 'notification' | 'removed'
export interface MailLogEvent { at: string; source: string; kind: MailLogKind; text: string }
export interface MailLogRecipient { address: string; originalAddress: string | null; status: DeliveryStatus; dsn: string | null; relay: string | null; response: string | null; at: string; attempts: number }
export interface MailLogMessage {
  queueId: string | null; firstSeen: string; lastSeen: string; sender: string | null; size: number | null; recipientCount: number | null
  messageId: string | null; client: string | null; saslUsername: string | null; status: MailLogStatus; dsn: string | null
  recipients: MailLogRecipient[]; recipientsOmitted: number; events: MailLogEvent[]; eventsOmitted: number
}
export interface MailLogCounts { records: number; events: number; skipped: number; unparsed: number; untrusted: number }
export interface MailLogSummary {
  messages: number; statuses: Record<MailLogStatus, number>; deliveries: Record<'sent' | 'deferred' | 'bounced' | 'expired', number>
  topSenders: { address: string; messages: number }[]; topRecipientDomains: { domain: string; recipients: number }[]; deferralReasons: { dsn: string | null; reason: string; count: number }[]
}
type Unavailable = 'journal_unavailable' | 'output_limit'
interface Base { state: 'read' | 'unavailable'; reason?: Unavailable; observedAt: string; window: { since: string; until: string } }
export interface MailLogServerView extends Base { scope: 'server'; limit: number; lineLimitReached: boolean; counts: MailLogCounts; summary: MailLogSummary; filters: MailLogFilters; matched: number; messages: MailLogMessage[]; omittedMessages: number }
export interface MailboxDeliveryEvent { at: string; kind: 'received' | 'queued' | 'delivery' | 'rejected' | 'expired' | 'notification' | 'removed'; status?: DeliveryStatus; dsn?: string | null }
export interface MailboxDeliveryMessage {
  queueId: string | null; role: 'sender' | 'recipient' | 'both'; firstSeen: string; lastSeen: string; sender: string | null; size: number | null
  status: MailLogStatus; dsn: string | null; recipients: Omit<MailLogRecipient, 'originalAddress'>[]; otherRecipients: number; events: MailboxDeliveryEvent[]; eventsOmitted: number
}
export interface MailLogMailboxView extends Base { scope: 'mailbox'; mailbox: string; complete: boolean; messages: MailboxDeliveryMessage[]; omittedMessages: number }

interface Line {
  at: string; source: string; queueId: string | null; kind: MailLogKind; text: string
  recipient?: string; originalRecipient?: string | null; status?: DeliveryStatus; dsn?: string | null; relay?: string | null; response?: string | null
  sender?: string; size?: number; recipientCount?: number; messageId?: string; client?: string; saslUsername?: string | null
}
interface Built { queueId: string | null; firstSeen: string; lastSeen: string; sender: string | null; size: number | null; recipientCount: number | null; messageId: string | null; client: string | null; saslUsername: string | null; expired: boolean; recipients: Map<string, MailLogRecipient>; lines: Line[] }
export interface MailLogObservation extends Base { limit: number; lineLimitReached: boolean; counts: MailLogCounts; messages: Built[] }

export const MAIL_LOG_MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const MESSAGE_BUDGET = 900 * 1024
const MAX_OUT = 200
const SERVICES = new Map<string, string>(MAIL_LOG_IDENTIFIERS.map(id => [id, id.slice('postfix/'.length)]))
const DELIVERY_SOURCES = new Set(['smtp', 'lmtp', 'local', 'virtual', 'pipe', 'error'])
const EXE = /^\/usr\/(?:lib|libexec)\/postfix\/(?:sbin\/|bin\/)?([a-z]{3,8})$/
// Postfix log_adhoc(3) grammar: QUEUEID: to=<a>[, orig_to=<a>], relay=R[, conn_use=N], delay=D, delays=a/b/c/d, dsn=X.Y.Z, status=S (text)
const DELIVERY = /^to=<([^<>]{0,254})>(?:, orig_to=<([^<>]{0,254})>)?, relay=([^\s,]{1,300})(?:, conn_use=[0-9]{1,9})?, delay=[0-9]{1,9}(?:\.[0-9]{1,6})?, delays=(?:[0-9]{1,9}(?:\.[0-9]{1,6})?\/){3}[0-9]{1,9}(?:\.[0-9]{1,6})?, dsn=([245]\.[0-9]{1,3}\.[0-9]{1,3}), status=(sent|deferred|bounced|expired)(?: \((.*)\))?$/
const QUEUED = /^from=<([^<>]{0,254})>, size=([0-9]{1,15}), nrcpt=([0-9]{1,9}) \(queue active\)$/
const EXPIRED = /^from=<([^<>]{0,254})>, status=expired, returned to sender$/
const CLIENT = /^client=([^\s,]{1,300})((?:, [a-z_]{1,32}=[^,]{0,300})*)$/
const NOTICE = /^sender (?:non-delivery|delivery status|delay) notification: ([0-9A-Za-z]{6,26})$/
const REJECT = /^(?:milter-)?reject: /
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g
const ADDRESS_TOKEN = /[^\s<>()[\];,"'=]+@[^\s<>()[\];,"']+/g
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const order: readonly DeliveryStatus[] = ['expired', 'bounced', 'deferred', 'rejected', 'sent']

/** Remote-controlled text: neutralize controls/bidi overrides and bound to max UTF-8 bytes. */
export const clipMailLogText = (value: string, max = 1024): string => {
  const clean = value.replace(CONTROL, ' ').toWellFormed()
  return Buffer.byteLength(clean) <= max ? clean : Buffer.from(clean).subarray(0, max).toString('utf8').replace(/�+$/, '')
}
const lower = (value: string | null | undefined): string => (value ?? '').toLowerCase()
const domainOf = (address: string | null): string => { const at = lower(address).lastIndexOf('@'); return at < 0 ? '' : lower(address).slice(at + 1) }

function journalRecord(line: string): { at: string; source: string; text: string } | 'untrusted' | null {
  let value: unknown
  try { value = JSON.parse(line) } catch { return null }
  // JOURNAL_EXPORT_FORMATS: binary fields are byte arrays and fields over 4096 bytes are null; neither is a readable Postfix line.
  if (!object(value) || typeof value.MESSAGE !== 'string' || typeof value.SYSLOG_IDENTIFIER !== 'string' || typeof value.__REALTIME_TIMESTAMP !== 'string' || !/^[0-9]{1,17}$/.test(value.__REALTIME_TIMESTAMP)) return null
  const source = SERVICES.get(value.SYSLOG_IDENTIFIER)
  if (!source) return null
  const exe = typeof value._EXE === 'string' ? EXE.exec(value._EXE)?.[1] : undefined
  // lmtp is installed as a link to smtp; /proc/<pid>/exe can resolve to either name.
  if (exe !== source && !(source === 'lmtp' && exe === 'smtp')) return 'untrusted'
  const ms = Math.floor(Number(value.__REALTIME_TIMESTAMP) / 1000)
  if (!Number.isSafeInteger(ms) || ms > 253402300799999) return null
  return { at: new Date(ms).toISOString(), source, text: value.MESSAGE }
}

function rejectLine(at: string, source: string, queueId: string | null, body: string): Line | null {
  if (source !== 'smtpd' && source !== 'cleanup') return null
  // smtpd(8): "reject: RCPT from host[ip]: 554 5.7.1 text; from=<a> to=<b> ..."; cleanup(8) puts ": X.Y.Z text" after the envelope.
  const dsn = (/(?:^|[\s:])[245][0-9]{2} ([245]\.[0-9]{1,3}\.[0-9]{1,3})(?=\s|$)/.exec(body) ?? /: ([245]\.[0-9]{1,3}\.[0-9]{1,3}) /.exec(body))?.[1]
  if (!dsn) return null
  const sender = /; ?from=<([^<>]{0,254})>/.exec(body)?.[1], recipient = / to=<([^<>]{0,254})>/.exec(body)?.[1]
  const reason = /^(?:milter-)?reject: [A-Z-]+ from [^\s:]+: (.*?)(?:; from=<.*)?$/.exec(body)?.[1] ?? body
  return { at, source, queueId, kind: 'rejected', text: clipMailLogText(body), status: 'rejected', dsn, ...(sender === undefined ? {} : { sender }), ...(recipient === undefined ? {} : { recipient, originalRecipient: null, relay: null, response: clipMailLogText(reason) }) }
}

/** One Postfix MESSAGE: a delivery event, 'skip' for well-formed non-delivery lines, null when unparsed. */
function postfixLine(record: { at: string; source: string; text: string }): Line | 'skip' | null {
  const { at, source, text } = record
  if (text.startsWith('NOQUEUE: ')) return REJECT.test(text.slice(9)) ? rejectLine(at, source, null, text.slice(9)) : 'skip'
  const prefix = /^([0-9A-Za-z]{6,26}): (.*)$/.exec(text)
  if (!prefix || !isMailQueueId(prefix[1])) return 'skip'
  const queueId = prefix[1]!, body = prefix[2]!
  const line = (kind: MailLogKind, extra: Partial<Line> = {}): Line => ({ at, source, queueId, kind, text: clipMailLogText(body), ...extra })
  if (body.startsWith('to=<')) {
    const match = DELIVERY_SOURCES.has(source) ? DELIVERY.exec(body) : null
    return match ? line('delivery', { recipient: match[1]!, originalRecipient: match[2] ?? null, relay: match[3]!, dsn: match[4]!, status: match[5] as DeliveryStatus, response: match[6] === undefined ? null : clipMailLogText(match[6]) }) : null
  }
  if (body.startsWith('from=<')) {
    if (source !== 'qmgr') return null
    const queued = QUEUED.exec(body), expired = EXPIRED.exec(body)
    return queued ? line('queued', { sender: queued[1]!, size: Number(queued[2]), recipientCount: Number(queued[3]) }) : expired ? line('expired', { sender: expired[1]! }) : null
  }
  if (body === 'removed') return source === 'qmgr' ? line('removed') : null
  if (body.startsWith('client=')) {
    const match = source === 'smtpd' ? CLIENT.exec(body) : null
    return match ? line('client', { client: match[1]!, saslUsername: /, sasl_username=([^\s,]{1,254})/.exec(match[2]!)?.[1] ?? null }) : null
  }
  if (body.startsWith('message-id=')) return source === 'cleanup' ? line('message-id', { messageId: clipMailLogText(body.slice(11), 998) }) : null
  if (REJECT.test(body)) return rejectLine(at, source, queueId, body)
  const notice = source === 'bounce' ? NOTICE.exec(body) : null
  return notice && isMailQueueId(notice[1]) ? line('notification') : 'skip'
}

function apply(message: Built, line: Line): void {
  message.lastSeen = line.at; message.lines.push(line)
  if (line.kind === 'client') { message.client = line.client!; message.saslUsername = line.saslUsername ?? null }
  if (line.kind === 'message-id') message.messageId = line.messageId!
  if (line.kind === 'queued') { message.sender = line.sender!; message.size = line.size!; message.recipientCount = line.recipientCount! }
  if (line.kind === 'expired') message.expired = true
  if (line.sender !== undefined) message.sender ??= line.sender
  if (line.recipient === undefined) return
  const key = lower(line.recipient) + '\n' + lower(line.originalRecipient), current = message.recipients.get(key)
  message.recipients.set(key, { address: clipMailLogText(line.recipient, 254), originalAddress: line.originalRecipient == null ? null : clipMailLogText(line.originalRecipient, 254), status: line.status!, dsn: line.dsn ?? null, relay: line.relay ?? null, response: line.response ?? null, at: line.at, attempts: (current?.attempts ?? 0) + 1 })
}

const statusOf = (recipients: readonly MailLogRecipient[], expired: boolean): [MailLogStatus, string | null] => {
  for (const status of order) {
    const match = recipients.find(item => status === 'expired' ? item.status === 'expired' || expired && item.status === 'deferred' : item.status === status)
    if (match || status === 'expired' && expired) return [status, match?.dsn ?? null]
  }
  return ['queued', null]
}

/** Reads the bounded journal window once; correlation is by queue id, split when qmgr logs "removed". */
export async function observeMailLog(input: { run: MailLogRun | null; since: string; until: string; limit?: number; now?: () => Date }): Promise<MailLogObservation> {
  const limit = input.limit ?? MAIL_LOG_MAX_LINES, argv = mailLogArgv(input.since, input.until, limit)
  const counts: MailLogCounts = { records: 0, events: 0, skipped: 0, unparsed: 0, untrusted: 0 }
  const base = { observedAt: (input.now?.() ?? new Date()).toISOString(), window: { since: input.since, until: input.until }, limit }
  const unavailable = (reason: Unavailable): MailLogObservation => ({ state: 'unavailable', reason, ...base, lineLimitReached: false, counts, messages: [] })
  if (!input.run) return unavailable('journal_unavailable')
  let result: MailLogCommandResult
  try { result = await input.run(argv) } catch { return unavailable('journal_unavailable') }
  if (!result || !result.ok || (result.code ?? 0) !== 0 || typeof result.stdout !== 'string') return unavailable('journal_unavailable')
  if (Buffer.byteLength(result.stdout) > MAIL_LOG_MAX_OUTPUT_BYTES) return unavailable('output_limit')
  // journalctl(1) prints "-- No entries --" for an empty match unless --quiet is given.
  const lines = result.stdout.split('\n').filter(line => line.trim() !== '' && line.trim() !== '-- No entries --').slice(0, limit)
  const open = new Map<string, Built>(), done: Built[] = []
  for (const raw of lines) {
    counts.records++
    const record = journalRecord(raw)
    if (record === 'untrusted') { counts.untrusted++; continue }
    const line = record ? postfixLine(record) : null
    if (line === null) { counts.unparsed++; continue }
    if (line === 'skip') { counts.skipped++; continue }
    counts.events++
    const message = (line.queueId === null ? undefined : open.get(line.queueId)) ?? { queueId: line.queueId, firstSeen: line.at, lastSeen: line.at, sender: null, size: null, recipientCount: null, messageId: null, client: null, saslUsername: null, expired: false, recipients: new Map(), lines: [] }
    apply(message, line)
    if (line.queueId === null || line.kind === 'removed') { done.push(message); if (line.queueId !== null) open.delete(line.queueId) }
    else open.set(line.queueId, message)
  }
  done.push(...open.values())
  return { state: 'read', ...base, lineLimitReached: lines.length >= limit, counts, messages: done }
}

const fit = <T>(items: readonly T[]): { kept: T[]; omitted: number } => {
  const kept: T[] = []; let bytes = 0
  for (const item of items) { const size = Buffer.byteLength(JSON.stringify(item)) + 1; if (bytes + size > MESSAGE_BUDGET) break; bytes += size; kept.push(item) }
  return { kept, omitted: items.length - kept.length }
}
const newest = (left: Built, right: Built): number => right.lastSeen.localeCompare(left.lastSeen) || lower(left.queueId).localeCompare(lower(right.queueId))
const top = (counts: Map<string, number>): [string, number][] => [...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 10)
const bump = (counts: Map<string, number>, key: string): void => { counts.set(key, (counts.get(key) ?? 0) + 1) }

export function summarizeMailLog(messages: readonly Built[]): MailLogSummary {
  const statuses: Record<MailLogStatus, number> = { sent: 0, deferred: 0, bounced: 0, expired: 0, rejected: 0, queued: 0 }
  const deliveries = { sent: 0, deferred: 0, bounced: 0, expired: 0 }
  const senders = new Map<string, number>(), domains = new Map<string, number>(), reasons = new Map<string, number>()
  for (const message of messages) {
    statuses[statusOf([...message.recipients.values()], message.expired)[0]]++
    if (message.sender) bump(senders, lower(message.sender))
    for (const domain of new Set([...message.recipients.values()].map(item => domainOf(item.address)).filter(Boolean))) bump(domains, domain)
    for (const line of message.lines) {
      if (line.kind !== 'delivery' || line.status === 'rejected' || !line.status) continue
      deliveries[line.status]++
      // Group by the final ": " clause, the remote or local reason; bracketed hosts and addresses are elided.
      if (line.status === 'deferred') bump(reasons, (line.dsn ?? '') + '\n' + clipMailLogText((line.response ?? '').split(': ').pop()!.replace(/<[^<>]*>/g, '<>').replace(/\[[^\]]*\]/g, '[]').trim(), 256))
    }
  }
  return {
    messages: messages.length, statuses, deliveries,
    topSenders: top(senders).map(([address, count]) => ({ address: clipMailLogText(address, 254), messages: count })),
    topRecipientDomains: top(domains).map(([domain, count]) => ({ domain: clipMailLogText(domain, 254), recipients: count })),
    deferralReasons: top(reasons).map(([key, count]) => { const [dsn, reason] = key.split('\n') as [string, string]; return { dsn: dsn || null, reason, count } }),
  }
}

const publicMessage = (message: Built): MailLogMessage => {
  const recipients = [...message.recipients.values()], [status, dsn] = statusOf(recipients, message.expired)
  return {
    queueId: message.queueId, firstSeen: message.firstSeen, lastSeen: message.lastSeen, sender: message.sender === null ? null : clipMailLogText(message.sender, 254),
    size: message.size, recipientCount: message.recipientCount, messageId: message.messageId, client: message.client === null ? null : clipMailLogText(message.client, 300),
    saslUsername: message.saslUsername === null ? null : clipMailLogText(message.saslUsername, 254), status, dsn,
    recipients: recipients.slice(0, MAX_OUT), recipientsOmitted: Math.max(0, recipients.length - MAX_OUT),
    events: message.lines.slice(-MAX_OUT).map(line => ({ at: line.at, source: line.source, kind: line.kind, text: line.text })), eventsOmitted: Math.max(0, message.lines.length - MAX_OUT),
  }
}

export function matchesMailLogFilters(message: MailLogMessage, filters: MailLogFilters): boolean {
  const recipients = message.recipients
  return (!filters.sender || lower(message.sender).includes(filters.sender))
    && (!filters.recipient || recipients.some(item => lower(item.address).includes(filters.recipient!) || lower(item.originalAddress).includes(filters.recipient!)))
    && (!filters.domain || domainOf(message.sender) === filters.domain || recipients.some(item => domainOf(item.address) === filters.domain))
    && (!filters.status || message.status === filters.status)
    && (!filters.dsn || recipients.some(item => item.dsn !== null && (item.dsn === filters.dsn || item.dsn.startsWith(filters.dsn + '.'))))
}

export function projectServerMailLog(observation: MailLogObservation, filters: MailLogFilters): MailLogServerView {
  const { messages: built, ...rest } = observation
  const matched = [...built].sort(newest).map(publicMessage).filter(message => matchesMailLogFilters(message, filters))
  const { kept, omitted } = fit(matched)
  return { scope: 'server', ...rest, summary: summarizeMailLog(built), filters, matched: matched.length, messages: kept, omittedMessages: omitted }
}

/** Only the sealed mailbox's own rows leave the agent; every other address is removed or redacted to a count. */
export function projectMailboxMailLog(observation: MailLogObservation, mailbox: string): MailLogMailboxView {
  const own = (address: string | null | undefined, original?: string | null): boolean => lower(address) === mailbox || lower(original) === mailbox
  const redact = (text: string | null): string | null => text === null ? null : text.replace(ADDRESS_TOKEN, token => token.toLowerCase() === mailbox ? token : '[address]')
  const messages: MailboxDeliveryMessage[] = []
  for (const message of [...observation.messages].sort(newest)) {
    const all = [...message.recipients.values()], mine = all.filter(item => own(item.address, item.originalAddress)), sent = lower(message.sender) === mailbox
    if (!sent && mine.length === 0) continue
    const [status, dsn] = statusOf(mine.length ? mine : all, message.expired)
    const events: MailboxDeliveryEvent[] = []
    for (const line of message.lines) {
      if (line.kind === 'client') events.push({ at: line.at, kind: 'received' })
      else if (line.kind === 'delivery' || line.kind === 'rejected') { if (own(line.recipient, line.originalRecipient)) events.push({ at: line.at, kind: line.kind, status: line.status!, dsn: line.dsn ?? null }) }
      else if (line.kind !== 'message-id') events.push({ at: line.at, kind: line.kind })
    }
    messages.push({
      queueId: message.queueId, role: sent && mine.length ? 'both' : sent ? 'sender' : 'recipient', firstSeen: message.firstSeen, lastSeen: message.lastSeen,
      // The envelope sender is part of what the mailbox received; other recipients never are.
      sender: message.sender ? clipMailLogText(message.sender, 254) : null,
      size: message.size, status, dsn,
      recipients: mine.slice(0, MAX_OUT).map(item => ({ address: mailbox, status: item.status, dsn: item.dsn, relay: item.relay, response: redact(item.response), at: item.at, attempts: item.attempts })),
      otherRecipients: all.length - mine.length, events: events.slice(-MAX_OUT), eventsOmitted: Math.max(0, events.length - MAX_OUT),
    })
  }
  const { kept, omitted } = fit(messages)
  const complete = observation.state === 'read' && observation.counts.unparsed === 0 && observation.counts.untrusted === 0 && !observation.lineLimitReached
  return { scope: 'mailbox', mailbox, state: observation.state, ...(observation.reason ? { reason: observation.reason } : {}), observedAt: observation.observedAt, window: observation.window, complete, messages: kept, omittedMessages: omitted }
}

// Same derivation as apps/api/src/mail/inbox.ts mailboxPrincipalUsername; the agent cannot import the API.
const mailboxPrincipalUsername = (mailbox: string): string => `mbx${createHash('sha256').update(`xpanel-mailbox:${mailbox}`).digest('hex').slice(0, 28)}`
/** Kept equivalent to catalog tools webmail-track-delivery and email-accounts. */
export const AGENT_TRACK_DELIVERY_FEATURE_POLICY = Object.freeze(['webmail-track-delivery', 'emailtrace', 'email-accounts', 'popaccts (Email Accounts)'] as const)
export interface MailLogAuthorityPorts {
  principal: (id: string) => Promise<Pick<PrincipalRecord, 'id' | 'kind' | 'username' | 'accountId' | 'disabled'> | null>
  store: Pick<StateStore, 'getAccount' | 'getServiceUserByLogin' | 'getPlan' | 'getFeatureList'>
}

/** Mirrors the API sealed-session binding (openAuthorizedMailboxSession): only the mailbox's own principal may read its events. */
export async function assertMailLogMailboxCaller(ports: MailLogAuthorityPorts, caller: AgentCallerIdentity, address: string): Promise<void> {
  const denied = (): never => fail('FORBIDDEN', 'a current sealed mailbox identity is required for delivery tracking', { stateChanged: false })
  if (caller.role !== 'user' || !caller.accountId || !isMailLogMailbox(address)) return denied()
  const principal = await ports.principal(caller.principalId)
  if (!principal || principal.disabled || principal.kind !== 'user' || principal.id !== caller.principalId || principal.username !== caller.actor
    || principal.accountId !== caller.accountId || ![mailboxPrincipalUsername(address), address].includes(principal.username.toLowerCase())) return denied()
  const [mailbox, account] = await Promise.all([ports.store.getServiceUserByLogin(address), ports.store.getAccount(caller.accountId)])
  if (!mailbox || !mailbox.services.email || mailbox.accountId !== caller.accountId || mailbox.login.toLowerCase() !== address || !account || account.status !== 'active') return denied()
  const plan = await ports.store.getPlan(account.planId), features = plan ? await ports.store.getFeatureList(plan.featureListId) : null
  if (!features || AGENT_TRACK_DELIVERY_FEATURE_POLICY.some(key => features.disabled.includes(key))) fail('FORBIDDEN', 'delivery tracking is unavailable in the current account feature policy', { stateChanged: false })
}

export interface MailLogRouteContext {
  authenticateCaller: (req: Request) => Promise<AgentCallerIdentity>
  assertRootCaller: (caller: AgentCallerIdentity, target: string) => Promise<void>
  assertMailboxCaller: (caller: AgentCallerIdentity, address: string) => Promise<void>
  /** Null without a native Linux executor; the read is then truthfully unavailable. Needs a >= 16 MiB output buffer. */
  run: MailLogRun | null
  now?: () => Date
}

const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

/** GET /host/mail/log (root) and GET /host/mail/log/mailbox (the API's sealed mailbox principal only). */
export async function handleMailLogRoute(req: Request, url: URL, method: string, ctx: MailLogRouteContext): Promise<Response | null> {
  if (url.pathname !== '/host/mail/log' && url.pathname !== '/host/mail/log/mailbox') return null
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  const mailboxScope = url.pathname === '/host/mail/log/mailbox'
  const allowed = mailboxScope ? ['address', 'since', 'until'] : ['since', 'until', 'limit', 'sender', 'recipient', 'domain', 'status', 'dsn']
  const caller = await ctx.authenticateCaller(req)
  if (!mailboxScope) await ctx.assertRootCaller(caller, 'host.mail.log')
  const keys = [...url.searchParams.keys()]
  if (req.body !== null || keys.some(key => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1)) return fail('VALIDATION', 'mail log reads accept only one value for each supported selector and no body', { stateChanged: false })
  const since = url.searchParams.get('since'), until = url.searchParams.get('until'), address = url.searchParams.get('address') ?? ''
  if (!isMailLogInstant(since) || !isMailLogInstant(until) || !isMailLogWindow(since, until)) return fail('VALIDATION', 'a whole-second UTC window of at most 7 days is required', { stateChanged: false })
  const rawLimit = url.searchParams.get('limit')
  if (rawLimit !== null && (!/^[1-9][0-9]{0,4}$/.test(rawLimit) || Number(rawLimit) > MAIL_LOG_MAX_LINES)) return fail('VALIDATION', 'limit must be 1 through 20000', { stateChanged: false })
  let filters: MailLogFilters = {}
  try { if (!mailboxScope) filters = parseMailLogFilters(key => url.searchParams.get(key)) } catch { return fail('VALIDATION', 'unsupported mail log filter', { stateChanged: false }) }
  if (mailboxScope) {
    if (!isMailLogMailbox(address)) return fail('VALIDATION', 'a canonical mailbox address is required', { stateChanged: false })
    await ctx.assertMailboxCaller(caller, address)
  }
  const observation = await observeMailLog({ run: ctx.run, since, until, ...(rawLimit === null ? {} : { limit: Number(rawLimit) }), ...(ctx.now ? { now: ctx.now } : {}) })
  const fresh = await ctx.authenticateCaller(req)
  if (fresh.principalId !== caller.principalId || fresh.actor !== caller.actor) return fail('FORBIDDEN', 'mail log authority changed', { stateChanged: false })
  if (mailboxScope) await ctx.assertMailboxCaller(fresh, address)
  else await ctx.assertRootCaller(fresh, 'host.mail.log')
  return json(mailboxScope ? projectMailboxMailLog(observation, address) : projectServerMailLog(observation, filters))
}
