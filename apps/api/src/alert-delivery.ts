import '../../web/src/i18n.ts'
import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import type { LookupAddress } from 'node:dns'
import net from 'node:net'
import { isWebhookUrl, MAX_WEBHOOK_ATTEMPTS, WEBHOOK_BACKOFF_SEC, WEBHOOK_SIGNATURE_HEADER, webhookSignature } from '../../agent/src/ops-webhooks.ts'
import type { WebhookSender } from '../../agent/src/ops-webhooks.ts'
import type { ServerHealthCheckId } from '../../agent/src/server-health.ts'
import { canonicalIp, isPublicAddress } from '../../../packages/os/src/network-tools-command.ts'
import { MONITORING_ALERT_ROWS } from '../../web/src/board-port/whm-monitoring-alerts-workspace.ts'
import { MimeCodecAndSanitizer } from './mail/mime.ts'
import type { AlertEvaluation } from './monitoring-alerts.ts'

/**
 * Alert delivery: turns recorded evaluations into firing/resolved notices (one per alert episode), sends them through the
 * local MTA and a signed HTTPS webhook, retries failures on the webhook backoff schedule and keeps a bounded delivery log.
 * Transports are injected so tests never reach a real network.
 */
export type DeliveryChannel = 'email' | 'webhook'
export type NoticeKind = 'firing' | 'resolved' | 'test'
export type DeliveryResult = 'sent' | 'failed' | 'gave_up' | 'no_channel'
export const DELIVERY_ERRORS = ['unreachable', 'timed_out', 'refused', 'rejected_status', 'address_not_public', 'no_signing_key'] as const
export type DeliveryError = typeof DELIVERY_ERRORS[number]
export const DELIVERY_CHANNELS: readonly DeliveryChannel[] = ['email', 'webhook']
/** The notification event key that selects alert delivery on the notifications page. */
export const ALERT_NOTIFICATION_EVENT = 'monitoring.alert'
export const ALERT_SCHEDULE_MINUTES = 5
export const DELIVERY_LOG_LIMIT = 200
const OUTBOX_LIMIT = 50, SENDS_PER_CYCLE = 20

export interface AlertNotice {
  id: string; kind: NoticeKind; ruleId: ServerHealthCheckId | null; severity: 'critical' | 'warning' | null; firstFiredAt: string | null; evaluatedAt: string
  value: number | null; threshold: number | null; matches: string[]; evidence: string
}
export interface OutboxEntry { notice: AlertNotice; channel: DeliveryChannel; attempts: number; nextAt: string }
export interface DeliveryLogEntry { at: string; noticeId: string; kind: NoticeKind; ruleId: ServerHealthCheckId | null; channel: DeliveryChannel | null; result: DeliveryResult; attempt: number; error: DeliveryError | null; status: number | null }
export type ScheduledRunResult = 'evaluated' | 'host_unavailable' | 'rules_invalid'
/** told: the firing episode (firstFiredAt) recipients were last told about, per rule. */
export interface DeliveryState { told: Partial<Record<ServerHealthCheckId, string>>; outbox: OutboxEntry[]; log: DeliveryLogEntry[]; lastRun: { at: string; result: ScheduledRunResult } | null }
export const EMPTY_DELIVERY_STATE: DeliveryState = { told: {}, outbox: [], log: [], lastRun: null }
/** Channels as saved on the notifications page. alerts: the alert event is selected. A webhook without a signing key fails every attempt. */
export interface DeliveryChannels { alerts: boolean; recipients: string[]; webhook: { url: string; key: string | null } | null }
export type EmailSender = (input: { to: string[]; subject: string; text: string }) => Promise<void>
export interface DeliveryTransports { email: EmailSender; webhook: WebhookSender; serverName: string }

export class DeliveryFailure extends Error {
  readonly code: DeliveryError
  readonly status: number | null
  constructor(code: DeliveryError, status: number | null = null) { super(code); this.code = code; this.status = status }
}

const IDS = MONITORING_ALERT_ROWS.map(row => row.id)
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>): string => Object.keys(value).sort().join()
const iso = (value: unknown): value is string => typeof value === 'string' && ISO.test(value) && Number.isFinite(Date.parse(value))
const rule = (value: unknown): boolean => value === null || IDS.includes(value as string)
const count = (value: unknown, max: number): boolean => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max
const noticeOk = (raw: unknown): boolean => object(raw) && keys(raw) === 'evaluatedAt,evidence,firstFiredAt,id,kind,matches,ruleId,severity,threshold,value'
  && typeof raw.id === 'string' && /^aln_[0-9a-f]{24}$/.test(raw.id) && ['firing', 'resolved', 'test'].includes(raw.kind as string) && rule(raw.ruleId) && (raw.kind === 'test') === (raw.ruleId === null)
  && [null, 'critical', 'warning'].includes(raw.severity as string) && (raw.firstFiredAt === null || iso(raw.firstFiredAt)) && iso(raw.evaluatedAt)
  && [raw.value, raw.threshold].every(item => item === null || typeof item === 'number' && Number.isFinite(item))
  && Array.isArray(raw.matches) && raw.matches.length <= 25 && raw.matches.every(item => typeof item === 'string' && item.length <= 512) && typeof raw.evidence === 'string' && raw.evidence.length <= 1024
const logOk = (raw: unknown): boolean => object(raw) && keys(raw) === 'at,attempt,channel,error,kind,noticeId,result,ruleId,status' && iso(raw.at) && typeof raw.noticeId === 'string' && /^aln_[0-9a-f]{24}$/.test(raw.noticeId)
  && ['firing', 'resolved', 'test'].includes(raw.kind as string) && rule(raw.ruleId) && (raw.channel === null || DELIVERY_CHANNELS.includes(raw.channel as DeliveryChannel))
  && ['sent', 'failed', 'gave_up', 'no_channel'].includes(raw.result as string) && count(raw.attempt, MAX_WEBHOOK_ATTEMPTS)
  && (raw.error === null || DELIVERY_ERRORS.includes(raw.error as DeliveryError)) && (raw.status === null || count(raw.status, 999))

/** Strict reader for the saved delivery record; null when it cannot be verified (delivery then restarts from an empty record). */
export function readSavedDeliveryState(raw: unknown): DeliveryState | null {
  if (!object(raw) || keys(raw) !== 'lastRun,log,outbox,told' || !object(raw.told) || !Object.entries(raw.told).every(([id, at]) => IDS.includes(id) && iso(at))
    || !Array.isArray(raw.outbox) || raw.outbox.length > OUTBOX_LIMIT || !raw.outbox.every(item => object(item) && keys(item) === 'attempts,channel,nextAt,notice' && noticeOk(item.notice)
      && DELIVERY_CHANNELS.includes(item.channel as DeliveryChannel) && count(item.attempts, MAX_WEBHOOK_ATTEMPTS - 1) && iso(item.nextAt))
    || !Array.isArray(raw.log) || raw.log.length > DELIVERY_LOG_LIMIT || !raw.log.every(logOk)
    || raw.lastRun !== null && !(object(raw.lastRun) && keys(raw.lastRun) === 'at,result' && iso(raw.lastRun.at) && ['evaluated', 'host_unavailable', 'rules_invalid'].includes(raw.lastRun.result as string))) return null
  return raw as unknown as DeliveryState
}

const noticeId = (...parts: (string | null)[]): string => 'aln_' + createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24)
export const testNotice = (now: Date): AlertNotice => ({ id: noticeId('test', now.toISOString()), kind: 'test', ruleId: null, severity: null, firstFiredAt: null, evaluatedAt: now.toISOString(), value: null, threshold: null, matches: [], evidence: '' })

/**
 * De-duplication: one firing notice per episode (a new firstFiredAt) and one resolved notice when a told episode clears.
 * Inside the quiet window nothing is planned, so a change is reported once the window ends if it still holds; an alert that
 * fires and clears inside the window sends nothing. An unverified result keeps the episode open; disabling a rule closes it silently.
 */
export function planAlertNotices(evaluation: AlertEvaluation, told: DeliveryState['told']): { notices: AlertNotice[]; told: DeliveryState['told'] } {
  if (evaluation.quiet) return { notices: [], told }
  const next = { ...told }, notices: AlertNotice[] = []
  for (const result of evaluation.results) {
    const since = told[result.id] ?? null
    const notice = (kind: 'firing' | 'resolved', firstFiredAt: string): AlertNotice => ({ id: noticeId(kind, result.id, firstFiredAt), kind, ruleId: result.id, severity: kind === 'firing' ? result.severity : null, firstFiredAt,
      evaluatedAt: evaluation.evaluatedAt, value: result.value, threshold: result.threshold, matches: result.matches.slice(0, 25), evidence: result.evidence.slice(0, 1024) })
    if (result.state === 'firing' && result.firstFiredAt && since !== result.firstFiredAt) { notices.push(notice('firing', result.firstFiredAt)); next[result.id] = result.firstFiredAt }
    else if ((result.state === 'ok' || result.state === 'disabled') && since !== null) { if (result.state === 'ok') notices.push(notice('resolved', since)); delete next[result.id] }
  }
  return { notices, told: next }
}

const titleOf = (id: string | null): string => MONITORING_ALERT_ROWS.find(row => row.id === id)?.title ?? 'Alert'
const stamp = (at: string): string => at.slice(0, 16).replace('T', ' ') + ' UTC'
const eventOf = (notice: AlertNotice): string => ALERT_NOTIFICATION_EVENT + '.' + notice.kind

/** Plain-text English system mail; the subject names the state, rule and server. */
export function alertMessage(notice: AlertNotice, server: string): { subject: string; text: string } {
  if (notice.kind === 'test') return { subject: `[xPanel] Test notification from ${server}`, text: `This is a test message from xPanel on ${server}, sent ${stamp(notice.evaluatedAt)}.\nAlert notifications for this server are delivered to this address.\n` }
  const title = titleOf(notice.ruleId), label = notice.kind === 'resolved' ? 'Resolved' : notice.severity === 'critical' ? 'Critical' : 'Warning'
  const lines = [`Alert: ${title}`, `State: ${notice.kind === 'resolved' ? 'resolved' : 'firing (' + (notice.severity ?? 'warning') + ')'}`, `Server: ${server}`,
    `${notice.kind === 'resolved' ? 'Fired at' : 'Firing since'}: ${stamp(notice.firstFiredAt!)}`, `Evaluated: ${stamp(notice.evaluatedAt)}`,
    ...(notice.value !== null ? [`Measured: ${notice.value}${notice.threshold !== null ? ` (threshold ${notice.threshold})` : ''}`] : []),
    ...(notice.matches.length ? [`Affected: ${notice.matches.join(', ')}`] : []), ...(notice.evidence ? [`Evidence: ${notice.evidence}`] : [])]
  return { subject: `[xPanel] ${label}: ${title} on ${server}`, text: lines.join('\n') + '\n' }
}
export const alertPayload = (notice: AlertNotice, server: string) => ({
  id: notice.id, event: eventOf(notice), server,
  alert: notice.kind === 'test' ? null : { rule: notice.ruleId, title: titleOf(notice.ruleId), severity: notice.severity, firstFiredAt: notice.firstFiredAt, evaluatedAt: notice.evaluatedAt, value: notice.value, threshold: notice.threshold, matches: notice.matches, evidence: notice.evidence },
})

const configured = (channels: DeliveryChannels | null, channel: DeliveryChannel, test: boolean): boolean =>
  !!channels && (test || channels.alerts) && (channel === 'email' ? channels.recipients.length > 0 : channels.webhook !== null)
export const configuredChannels = (channels: DeliveryChannels | null, test = false): DeliveryChannel[] => DELIVERY_CHANNELS.filter(channel => configured(channels, channel, test))

/** One attempt on one channel. Never throws: the outcome is a stable error code and an SMTP/HTTP status when one was received. */
export async function sendNotice(notice: AlertNotice, channel: DeliveryChannel, channels: DeliveryChannels, transports: DeliveryTransports, now: Date): Promise<{ error: DeliveryError | null; status: number | null }> {
  try {
    if (channel === 'email') { await transports.email({ to: channels.recipients, ...alertMessage(notice, transports.serverName) }); return { error: null, status: null } }
    const webhook = channels.webhook!
    if (!webhook.key) throw new DeliveryFailure('no_signing_key')
    const body = JSON.stringify(alertPayload(notice, transports.serverName)), timestamp = Math.floor(now.getTime() / 1000)
    const { status } = await transports.webhook({ url: webhook.url, body, headers: { 'content-type': 'application/json', [WEBHOOK_SIGNATURE_HEADER]: webhookSignature(webhook.key, timestamp, body), 'x-xpanel-event': eventOf(notice), 'x-xpanel-delivery': notice.id } })
    if (!Number.isInteger(status) || status < 200 || status > 299) throw new DeliveryFailure('rejected_status', Number.isInteger(status) && status >= 0 && status <= 999 ? status : null)
    return { error: null, status }
  } catch (error) { return error instanceof DeliveryFailure ? { error: error.code, status: error.status } : { error: 'unreachable', status: null } }
}

const entry = (at: string, notice: AlertNotice, channel: DeliveryChannel | null, result: DeliveryResult, attempt: number, sent?: { error: DeliveryError | null; status: number | null }): DeliveryLogEntry =>
  ({ at, noticeId: notice.id, kind: notice.kind, ruleId: notice.ruleId, channel, result, attempt, error: sent?.error ?? null, status: sent?.status ?? null })
const prepend = (log: DeliveryLogEntry[], added: DeliveryLogEntry[]): DeliveryLogEntry[] => [...added.reverse(), ...log].slice(0, DELIVERY_LOG_LIMIT)

/**
 * Queues new notices on every configured channel, then attempts each due queue entry once. A failure is retried on the webhook
 * backoff schedule (ops-webhooks.ts) until MAX_WEBHOOK_ATTEMPTS, then given up. Inside the quiet window nothing is sent.
 * A notice with no configured channel is logged as no_channel, so the log never implies a message that was not attempted.
 */
export async function dispatchAlertNotices(input: { state: DeliveryState; notices: AlertNotice[]; channels: DeliveryChannels | null; transports: DeliveryTransports; now: Date; quiet: boolean }): Promise<DeliveryState> {
  const at = input.now.toISOString(), added: DeliveryLogEntry[] = [], queue = [...input.state.outbox]
  for (const notice of input.notices) {
    const targets = configuredChannels(input.channels)
    if (!targets.length) added.push(entry(at, notice, null, 'no_channel', 0))
    for (const channel of targets) queue.push({ notice, channel, attempts: 0, nextAt: at })
  }
  while (queue.length > OUTBOX_LIMIT) { const dropped = queue.shift()!; added.push(entry(at, dropped.notice, dropped.channel, 'gave_up', dropped.attempts)) }
  const kept: OutboxEntry[] = []
  let budget = SENDS_PER_CYCLE
  for (const item of queue) {
    if (input.quiet || Date.parse(item.nextAt) > input.now.getTime() || budget <= 0) { kept.push(item); continue }
    if (!configured(input.channels, item.channel, false)) { added.push(entry(at, item.notice, item.channel, 'no_channel', item.attempts)); continue }
    budget--
    const sent = await sendNotice(item.notice, item.channel, input.channels!, input.transports, input.now), attempt = item.attempts + 1
    if (!sent.error) added.push(entry(at, item.notice, item.channel, 'sent', attempt, sent))
    else if (attempt >= MAX_WEBHOOK_ATTEMPTS) added.push(entry(at, item.notice, item.channel, 'gave_up', attempt, sent))
    else { added.push(entry(at, item.notice, item.channel, 'failed', attempt, sent)); kept.push({ ...item, attempts: attempt, nextAt: new Date(input.now.getTime() + WEBHOOK_BACKOFF_SEC[attempt]! * 1000).toISOString() }) }
  }
  return { ...input.state, outbox: kept, log: prepend(input.state.log, added) }
}

/** Send test: one immediate attempt on every configured channel, whether or not the alert event is selected; logged, never retried. */
export async function sendTestNotice(state: DeliveryState, channels: DeliveryChannels, transports: DeliveryTransports, now: Date): Promise<{ state: DeliveryState; results: { channel: DeliveryChannel; error: DeliveryError | null; status: number | null }[] }> {
  const notice = testNotice(now), at = now.toISOString(), results = []
  for (const channel of configuredChannels(channels, true)) results.push({ channel, ...await sendNotice(notice, channel, channels, transports, now) })
  return { state: { ...state, log: prepend(state.log, results.map(result => entry(at, notice, result.channel, result.error ? 'failed' : 'sent', 1, result))) }, results }
}

// shortcut: in-process serialization only; one API process owns the delivery record and runs the scheduler.
let queue: Promise<unknown> = Promise.resolve()
export const serialDelivery = <T>(task: () => Promise<T>): Promise<T> => { const run = queue.then(task, task); queue = run.catch(() => undefined); return run }

/** Local MTA submission over loopback SMTP (Postfix permits relaying from mynetworks); no credentials are used. */
export function createLocalMtaEmailSender(options: { from: string; helo: string; host?: string; port?: number; timeoutMs?: number }): EmailSender {
  const host = options.host ?? '127.0.0.1', port = options.port ?? 25, timeoutMs = options.timeoutMs ?? 15_000, { from: address, helo } = options
  return async ({ to, subject, text }) => {
    const { rawMime } = new MimeCodecAndSanitizer().buildMimeMessage({ from: address, fromName: 'xPanel', to, subject, textBody: text, extraHeaders: { 'Auto-Submitted': 'auto-generated' } })
    const socket = net.connect({ host, port })
    const lines: string[] = []
    let buffer = '', failure: DeliveryFailure | null = null, wake: (() => void) | null = null
    const stop = (reason: DeliveryFailure): void => { failure ??= reason; socket.destroy(); wake?.() }
    socket.setTimeout(timeoutMs, () => stop(new DeliveryFailure('timed_out')))
    socket.on('error', () => stop(new DeliveryFailure('unreachable')))
    socket.on('close', () => stop(new DeliveryFailure('unreachable')))
    socket.on('data', chunk => {
      buffer += chunk.toString('latin1')
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) { lines.push(buffer.slice(0, index).replace(/\r$/, '')); buffer = buffer.slice(index + 1) }
      if (buffer.length > 4096) stop(new DeliveryFailure('refused'))
      wake?.()
    })
    // One complete (possibly multi-line) reply; its code is the final line's.
    const reply = async (): Promise<number> => {
      for (;;) {
        const end = lines.findIndex(line => !/^\d{3}-/.test(line))
        if (end >= 0) { const last = lines.splice(0, end + 1).at(-1)!, match = /^(\d{3})(?: |$)/.exec(last); if (!match) throw new DeliveryFailure('refused'); return Number(match[1]) }
        if (failure) throw failure
        await new Promise<void>(resolve => { wake = resolve })
        wake = null
      }
    }
    const step = async (command: string | null, accept: (code: number) => boolean): Promise<number> => {
      if (command !== null) socket.write(command + '\r\n')
      const code = await reply()
      if (!accept(code)) throw new DeliveryFailure('refused', code)
      return code
    }
    try {
      await step(null, code => code === 220)
      await step('EHLO ' + helo, code => code === 250)
      await step('MAIL FROM:<' + address + '>', code => code === 250)
      let accepted = 0, rejected: number | null = null
      for (const recipient of to) { socket.write('RCPT TO:<' + recipient + '>\r\n'); const code = await reply(); if (code === 250 || code === 251) accepted++; else rejected = code }
      if (!accepted) throw new DeliveryFailure('refused', rejected)
      await step('DATA', code => code === 354)
      const stuffed = rawMime.replace(/\r?\n/g, '\r\n').replace(/(^|\r\n)\./g, '$1..')
      await step(stuffed + (stuffed.endsWith('\r\n') ? '' : '\r\n') + '.', code => code === 250)
      socket.write('QUIT\r\n')
    } finally { socket.removeAllListeners('close'); socket.end(); socket.destroy() }
  }
}

/**
 * Reviewed webhook egress: https only, every resolved address must be public, and the request is pinned to the checked
 * address (no rebinding) while TLS still verifies the URL's host name. No redirect is followed and no body is read.
 */
export function createHttpsWebhookSender(options: { timeoutMs?: number; resolve?: (host: string) => Promise<string[]> } = {}): WebhookSender {
  const timeoutMs = options.timeoutMs ?? 10_000
  const resolve = options.resolve ?? (async (host: string) => (await lookup(host, { all: true, verbatim: true })).map(item => item.address))
  return async ({ url, body, headers }) => {
    if (!isWebhookUrl(url)) throw new DeliveryFailure('address_not_public')
    const target = new URL(url), name = target.hostname.replace(/^\[|\]$/g, ''), literal = canonicalIp(name)
    let found: string[]
    try { found = literal ? [literal.address] : await resolve(name) } catch { throw new DeliveryFailure('unreachable') }
    if (!found.length) throw new DeliveryFailure('unreachable')
    if (!found.every(isPublicAddress)) throw new DeliveryFailure('address_not_public')
    const address = found[0]!, family = address.includes(':') ? 6 : 4
    const pinned = (_host: string, opts: { all?: boolean }, callback: (error: Error | null, address: string | LookupAddress[], family?: number) => void): void =>
      opts?.all ? callback(null, [{ address, family }]) : callback(null, address, family)
    return new Promise((done, reject) => {
      const request = httpsRequest({ hostname: name, port: target.port || 443, path: target.pathname + target.search, method: 'POST', agent: false, lookup: pinned as never, timeout: timeoutMs,
        headers: { ...headers, 'content-length': String(Buffer.byteLength(body)), 'user-agent': 'xPanel-Alerts' } })
      const deadline = setTimeout(() => request.destroy(new DeliveryFailure('timed_out')), timeoutMs)
      request.on('timeout', () => request.destroy(new DeliveryFailure('timed_out')))
      request.on('response', response => { clearTimeout(deadline); response.destroy(); done({ status: response.statusCode ?? 0 }) })
      request.on('error', error => { clearTimeout(deadline); reject(error instanceof DeliveryFailure ? error : new DeliveryFailure('unreachable')) })
      request.end(body)
    })
  }
}
