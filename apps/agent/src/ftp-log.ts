import { posix } from 'node:path'
import { fail } from '@xpanel/core'
import { FTP_LOG_IDENTIFIER, FTP_LOG_MAX_LINES, ftpLogArgv, parseFtpLogFilters } from '../../../packages/os/src/ftp-log-command.ts'
import type { FtpLogFilters, FtpLogKind } from '../../../packages/os/src/ftp-log-command.ts'
import { isMailLogInstant, isMailLogWindow } from '../../../packages/os/src/mail-log-command.ts'
import { clipMailLogText } from './mail-log.ts'
import type { AgentCallerIdentity } from './server.ts'
export type { FtpLogFilters, FtpLogKind } from '../../../packages/os/src/ftp-log-command.ts'

export interface FtpLogCommandResult { ok: boolean; code?: number; stdout: string; stderr: string }
export type FtpLogRun = (argv: string[]) => Promise<FtpLogCommandResult>
/** path is relative to the mapped account home when pathBase is 'home', otherwise the normalized host path as logged. */
export interface FtpLogEvent { at: string; kind: FtpLogKind; client: string; user: string | null; account: string | null; path: string | null; pathBase: 'home' | 'host' | null; bytes: number | null }
export interface FtpLogCounts { records: number; events: number; skipped: number; unparsed: number; untrusted: number }
export interface FtpLogSummary {
  events: number; connections: number; logins: { succeeded: number; failed: number }
  transfers: { uploads: number; uploadBytes: number; downloads: number; downloadBytes: number; deletes: number }
  topUsers: { user: string; account: string | null; events: number; logins: number; failures: number; uploads: number; downloads: number; bytes: number }[]
  topClients: { client: string; events: number; connections: number; logins: number; failures: number }[]
  failureBursts: { client: string; failures: number; users: number; firstAt: string; lastAt: string }[]
}
type Unavailable = 'journal_unavailable' | 'output_limit'
interface Base { state: 'read' | 'unavailable'; reason?: Unavailable; observedAt: string; window: { since: string; until: string }; limit: number; lineLimitReached: boolean; counts: FtpLogCounts; accountMapping: 'read' | 'unavailable' | 'not-read' }
export interface FtpLogObservation extends Base { events: FtpLogEvent[] }
export interface FtpLogView extends Base { scope: 'server'; summary: FtpLogSummary; filters: FtpLogFilters; matched: number; matchedSummary: FtpLogSummary | null; events: FtpLogEvent[]; omittedEvents: number }
/** Saved-state slice that maps FTP logins (service users with FTP) to their account home. */
export interface FtpLogState {
  accounts: readonly { id: string; username: string; home: string }[]
  serviceUsers: readonly { login: string; accountId: string; services: { ftp: boolean } }[]
}

export const FTP_LOG_MAX_OUTPUT_BYTES = 16 * 1024 * 1024
export const FTP_LOG_BURST_MIN_FAILURES = 5
export const FTP_LOG_BURST_GAP_SECONDS = 600
const EVENT_BUDGET = 900 * 1024
const DAEMON = '/usr/sbin/pure-ftpd', UNIT = 'pure-ftpd.service'
// ftpd.c logfile(): syslog "(%s@%s) %s%s" with the logged-in account or "?", the client host or "?", then "[LEVEL] " for INFO/NOTICE/WARNING/ERROR/DEBUG.
// The account is set only after authentication, so it never holds client text; it cannot contain spaces or parentheses.
const ENVELOPE = /^\(([^\s()]{1,254})@([0-9A-Za-z.:%_-]{1,253}|\?)\) (?:\[(INFO|NOTICE|WARNING|ERROR|DEBUG)\] )?(.*)$/
// Message texts from pure-ftpd's default English catalog (src/messages_en.h); another compiled-in language is counted as skipped.
const CONNECT = /^New connection from [0-9A-Za-z.:%_-]{1,253}$/
const LOGIN = /^([^\s()[\]]{1,254}) is now logged in$/
const FAILED = /^Authentication failed for user \[(.{0,256})\]$/
// displayrate(): root_directory + wd + "/" + name, then " uploaded"/" downloaded" and " (%llu bytes, %.2fKB/sec)".
const TRANSFER = /^(\/.*) (uploaded|downloaded)  \(([0-9]{1,15}) bytes, [0-9]{1,15}\.[0-9]{2}KB\/sec\)$/
// dodele(): MSG_DELE_SUCCESS "Deleted %s%s%s%s" with the same path parts.
const DELETED = /^Deleted (\/.*)$/
// die() logs MSG_LOGOUT, MSG_TIMEOUT, MSG_TIMEOUT_PARSER, MSG_TIMEOUT_NOOP and MSG_TIMEOUT_DATA at LOG_INFO.
const TIMEOUT = /^Timeout(?: - try typing a little faster next time| \(no (?:operation|new data) for [0-9]{1,10} seconds\))?$/
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
interface Raw { at: string; text: string }

function journalRecord(line: string): Raw | 'untrusted' | null {
  let value: unknown
  try { value = JSON.parse(line) } catch { return null }
  // JOURNAL_EXPORT_FORMATS: binary fields are byte arrays and fields over 4096 bytes are null; neither is a readable pure-ftpd line.
  if (!object(value) || typeof value.MESSAGE !== 'string' || value.SYSLOG_IDENTIFIER !== FTP_LOG_IDENTIFIER || typeof value.__REALTIME_TIMESTAMP !== 'string' || !/^[0-9]{1,17}$/.test(value.__REALTIME_TIMESTAMP)) return null
  // A local user can run logger(1) -t pure-ftpd or start their own copy of the binary; only the service's daemon is trusted.
  if (value._EXE !== DAEMON || value._SYSTEMD_UNIT !== UNIT) return 'untrusted'
  const ms = Math.floor(Number(value.__REALTIME_TIMESTAMP) / 1000)
  if (!Number.isSafeInteger(ms) || ms > 253402300799999) return null
  return { at: new Date(ms).toISOString(), text: value.MESSAGE }
}

/** One pure-ftpd MESSAGE: an activity event, 'skip' for well-formed other lines, null when unparsed. */
function ftpLine(raw: Raw, homes: ReadonlyMap<string, { account: string; home: string }>): FtpLogEvent | 'skip' | null {
  const envelope = ENVELOPE.exec(raw.text)
  if (!envelope) return null
  const [, account, client, level, body] = envelope as unknown as [string, string, string, string | undefined, string]
  if (client === '?') return 'skip'
  const event = (kind: FtpLogKind, user: string | null, extra: Partial<FtpLogEvent> = {}): FtpLogEvent => {
    const clean = user === null ? null : clipMailLogText(user, 254)
    return { at: raw.at, kind, client: client.toLowerCase(), user: clean, account: clean === null ? null : homes.get(clean.toLowerCase())?.account ?? null, path: null, pathBase: null, bytes: null, ...extra }
  }
  const self = account === '?' ? null : account
  const located = (logged: string): Pick<FtpLogEvent, 'path' | 'pathBase'> => {
    const path = posix.normalize(logged), mapped = self === null ? undefined : homes.get(self.toLowerCase())
    if (mapped && (path === mapped.home || path.startsWith(mapped.home + '/'))) return { path: clipMailLogText(path.slice(mapped.home.length + 1), 4096), pathBase: 'home' }
    return { path: clipMailLogText(path, 4096), pathBase: 'host' }
  }
  if (level === 'INFO') {
    if (CONNECT.test(body)) return event('connect', null)
    const login = LOGIN.exec(body)
    if (login) return event('login', login[1]!)
    if (body === 'Logout.') return event('logout', self)
    if (TIMEOUT.test(body)) return event('timeout', self)
  }
  if (level === 'WARNING') { const failed = FAILED.exec(body); if (failed) return event('login-failed', failed[1]!) }
  if (level === 'NOTICE') {
    const transfer = TRANSFER.exec(body)
    if (transfer) return event(transfer[2] === 'uploaded' ? 'upload' : 'download', self, { ...located(transfer[1]!), bytes: Number(transfer[3]) })
    const deleted = DELETED.exec(body)
    if (deleted) return event('delete', self, located(deleted[1]!))
  }
  return 'skip'
}

export function ftpLogAccountHomes(state: FtpLogState): Map<string, { account: string; home: string }> {
  const accounts = new Map(state.accounts.map(account => [account.id.toLowerCase(), account]))
  const homes = new Map<string, { account: string; home: string }>()
  for (const user of state.serviceUsers) {
    const account = user.services.ftp ? accounts.get(user.accountId.toLowerCase()) : undefined
    if (account && account.home.startsWith('/')) homes.set(user.login.toLowerCase(), { account: account.username, home: posix.normalize(account.home).replace(/\/+$/, '') })
  }
  return homes
}

/** Reads the bounded journal window once, then maps logins to account homes from one saved-state snapshot. */
export async function observeFtpLog(input: { run: FtpLogRun | null; readState: () => Promise<FtpLogState>; since: string; until: string; limit?: number; now?: () => Date }): Promise<FtpLogObservation> {
  const limit = input.limit ?? FTP_LOG_MAX_LINES, argv = ftpLogArgv(input.since, input.until, limit)
  const counts: FtpLogCounts = { records: 0, events: 0, skipped: 0, unparsed: 0, untrusted: 0 }
  const base = { observedAt: (input.now?.() ?? new Date()).toISOString(), window: { since: input.since, until: input.until }, limit, counts }
  const unavailable = (reason: Unavailable): FtpLogObservation => ({ state: 'unavailable', reason, ...base, lineLimitReached: false, accountMapping: 'not-read', events: [] })
  if (!input.run) return unavailable('journal_unavailable')
  let result: FtpLogCommandResult
  try { result = await input.run(argv) } catch { return unavailable('journal_unavailable') }
  if (!result || !result.ok || (result.code ?? 0) !== 0 || typeof result.stdout !== 'string') return unavailable('journal_unavailable')
  if (Buffer.byteLength(result.stdout) > FTP_LOG_MAX_OUTPUT_BYTES) return unavailable('output_limit')
  let homes = new Map<string, { account: string; home: string }>(), accountMapping: 'read' | 'unavailable' = 'read'
  try { homes = ftpLogAccountHomes(await input.readState()) } catch { accountMapping = 'unavailable' }
  // journalctl(1) prints "-- No entries --" for an empty match unless --quiet is given.
  const lines = result.stdout.split('\n').filter(line => line.trim() !== '' && line.trim() !== '-- No entries --').slice(0, limit)
  const events: FtpLogEvent[] = []
  for (const line of lines) {
    counts.records++
    const record = journalRecord(line)
    if (record === 'untrusted') { counts.untrusted++; continue }
    const event = record ? ftpLine(record, homes) : null
    if (event === null) counts.unparsed++
    else if (event === 'skip') counts.skipped++
    else { counts.events++; events.push(event) }
  }
  return { state: 'read', ...base, lineLimitReached: lines.length >= limit, accountMapping, events }
}

const top = <T extends { events: number }>(rows: Map<string, T>, key: (row: T) => string): T[] => [...rows.values()].sort((left, right) => right.events - left.events || key(left).localeCompare(key(right))).slice(0, 10)

/** Aggregates chronological events; a burst is FTP_LOG_BURST_MIN_FAILURES or more failures from one client with gaps of at most FTP_LOG_BURST_GAP_SECONDS. */
export function summarizeFtpLog(events: readonly FtpLogEvent[]): FtpLogSummary {
  const summary: FtpLogSummary = { events: events.length, connections: 0, logins: { succeeded: 0, failed: 0 }, transfers: { uploads: 0, uploadBytes: 0, downloads: 0, downloadBytes: 0, deletes: 0 }, topUsers: [], topClients: [], failureBursts: [] }
  const users = new Map<string, FtpLogSummary['topUsers'][number]>(), clients = new Map<string, FtpLogSummary['topClients'][number]>(), failures = new Map<string, FtpLogEvent[]>()
  for (const event of events) {
    const client = clients.get(event.client) ?? { client: event.client, events: 0, connections: 0, logins: 0, failures: 0 }
    client.events++; clients.set(event.client, client)
    const user = event.user === null ? undefined : users.get(event.user) ?? { user: event.user, account: event.account, events: 0, logins: 0, failures: 0, uploads: 0, downloads: 0, bytes: 0 }
    if (user) { user.events++; user.account ??= event.account; users.set(user.user, user) }
    if (event.kind === 'connect') { summary.connections++; client.connections++ }
    if (event.kind === 'login') { summary.logins.succeeded++; client.logins++; if (user) user.logins++ }
    if (event.kind === 'login-failed') { summary.logins.failed++; client.failures++; if (user) user.failures++; const list = failures.get(event.client) ?? []; list.push(event); failures.set(event.client, list) }
    if (event.kind === 'upload') { summary.transfers.uploads++; summary.transfers.uploadBytes += event.bytes!; if (user) { user.uploads++; user.bytes += event.bytes! } }
    if (event.kind === 'download') { summary.transfers.downloads++; summary.transfers.downloadBytes += event.bytes!; if (user) { user.downloads++; user.bytes += event.bytes! } }
    if (event.kind === 'delete') summary.transfers.deletes++
  }
  for (const [client, list] of failures) {
    let run: FtpLogEvent[] = []
    const flush = (): void => { if (run.length >= FTP_LOG_BURST_MIN_FAILURES) summary.failureBursts.push({ client, failures: run.length, users: new Set(run.map(item => item.user)).size, firstAt: run[0]!.at, lastAt: run.at(-1)!.at }); run = [] }
    for (const event of list) { if (run.length && Date.parse(event.at) - Date.parse(run.at(-1)!.at) > FTP_LOG_BURST_GAP_SECONDS * 1000) flush(); run.push(event) }
    flush()
  }
  summary.failureBursts = summary.failureBursts.sort((left, right) => right.failures - left.failures || left.firstAt.localeCompare(right.firstAt) || left.client.localeCompare(right.client)).slice(0, 20)
  summary.topUsers = top(users, row => row.user); summary.topClients = top(clients, row => row.client)
  return summary
}

export function matchesFtpLogFilters(event: FtpLogEvent, filters: FtpLogFilters): boolean {
  const text = filters.text
  return (filters.user === undefined || event.user === filters.user) && (filters.client === undefined || event.client === filters.client) && (filters.kind === undefined || event.kind === filters.kind)
    && (text === undefined || [event.user, event.account, event.client, event.path].some(value => value !== null && value.toLowerCase().includes(text)))
}

/** Whole-window summary, the summary of the matched events when filtered (the per-user drill-down), and matched events newest first within the response budget. */
export function projectFtpLog(observation: FtpLogObservation, filters: FtpLogFilters): FtpLogView {
  const { events, ...rest } = observation, filtered = Object.keys(filters).length > 0
  const matched = filtered ? events.filter(event => matchesFtpLogFilters(event, filters)) : events
  const kept: FtpLogEvent[] = []; let bytes = 0
  for (let index = matched.length - 1; index >= 0; index--) { const size = Buffer.byteLength(JSON.stringify(matched[index])) + 1; if (bytes + size > EVENT_BUDGET) break; bytes += size; kept.push(matched[index]!) }
  return { scope: 'server', ...rest, summary: summarizeFtpLog(events), filters, matched: matched.length, matchedSummary: filtered ? summarizeFtpLog(matched) : null, events: kept, omittedEvents: matched.length - kept.length }
}

export interface FtpLogRouteContext {
  authenticateCaller: (req: Request) => Promise<AgentCallerIdentity>
  assertRootCaller: (caller: AgentCallerIdentity, target: string) => Promise<void>
  readState: () => Promise<FtpLogState>
  /** Null without a native Linux executor; the read is then truthfully unavailable. Needs a >= 16 MiB output buffer. */
  run: FtpLogRun | null
  now?: () => Date
}

/** GET /host/ftp/log (root only). */
export async function handleFtpLogRoute(req: Request, url: URL, method: string, ctx: FtpLogRouteContext): Promise<Response | null> {
  if (url.pathname !== '/host/ftp/log') return null
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  const caller = await ctx.authenticateCaller(req)
  await ctx.assertRootCaller(caller, 'host.ftp.log')
  const allowed = ['since', 'until', 'limit', 'user', 'client', 'kind', 'text']
  if (req.body !== null || [...url.searchParams.keys()].some(key => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1)) return fail('VALIDATION', 'FTP log reads accept only one value for each supported selector and no body', { stateChanged: false })
  const since = url.searchParams.get('since'), until = url.searchParams.get('until'), rawLimit = url.searchParams.get('limit')
  if (!isMailLogInstant(since) || !isMailLogInstant(until) || !isMailLogWindow(since, until)) return fail('VALIDATION', 'a whole-second UTC window of at most 7 days is required', { stateChanged: false })
  if (rawLimit !== null && (!/^[1-9][0-9]{0,4}$/.test(rawLimit) || Number(rawLimit) > FTP_LOG_MAX_LINES)) return fail('VALIDATION', 'limit must be 1 through 20000', { stateChanged: false })
  let filters: FtpLogFilters
  try { filters = parseFtpLogFilters(key => url.searchParams.get(key)) } catch { return fail('VALIDATION', 'unsupported FTP log filter', { stateChanged: false }) }
  const observation = await observeFtpLog({ run: ctx.run, readState: ctx.readState, since, until, ...(rawLimit === null ? {} : { limit: Number(rawLimit) }), ...(ctx.now ? { now: ctx.now } : {}) })
  const fresh = await ctx.authenticateCaller(req)
  if (fresh.principalId !== caller.principalId || fresh.actor !== caller.actor) return fail('FORBIDDEN', 'FTP log authority changed', { stateChanged: false })
  await ctx.assertRootCaller(fresh, 'host.ftp.log')
  return new Response(JSON.stringify(projectFtpLog(observation, filters)), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}
