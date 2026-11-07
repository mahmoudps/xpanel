import { posix } from 'node:path'
import { fail, isXpanelError } from '@xpanel/core'
import type { Account, FeatureList, HostAction, Plan } from '@xpanel/core'
import { FTP_WHO_ARGV } from '../../../packages/os/src/ftp-log-command.ts'
import { monitoringKillArgv } from '../../../packages/os/src/monitoring-command.ts'
import type { JailedFileManager } from './file-manager.ts'
import type { FtpLogEvent, FtpLogObservation } from './ftp-log.ts'
import type { AgentCallerIdentity } from './server.ts'

/**
 * Owner FTP tools: FTP Connections (pure-ftpwho sessions of this account's logins and disconnect), the Anonymous FTP
 * welcome file and the Webalizer FTP style monthly report. Sessions and report rows are matched by exact saved login.
 */
export interface FtpCommandResult { ok: boolean; code?: number; stdout: string; stderr: string }
export interface FtpSession { pid: number; login: string; seconds: number; state: 'idle' | 'download' | 'upload' | 'active'; file: string | null; client: string }
export interface FtpSessionsView { context: { accountId: string; username: string }; state: 'read' | 'unavailable'; observedAt: string; sessions: FtpSession[] }
const SESSION_LIMIT = 500
const FIELD = /^[\x20-\x7e]{0,1024}$/
const CLIENT = /^[0-9A-Za-z.:%_-]{1,253}$/
const STATES: Readonly<Record<string, FtpSession['state']>> = { IDLE: 'idle', DL: 'download', UL: 'upload' }

/** pure-ftpwho -s: pid|login|seconds|state|file|peer|local|port|current|total|percent|bandwidth; sessions before login show "?". */
export function parseFtpWho(stdout: string): FtpSession[] | null {
  const sessions: FtpSession[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('|')
    if (parts.length !== 12 || !/^[1-9][0-9]{0,9}$/.test(parts[0]!) || !/^[0-9]{1,12}$/.test(parts[2]!) || !FIELD.test(parts[1]!) || !FIELD.test(parts[4]!) || !CLIENT.test(parts[5]!)) return null
    if (parts[1] === '?' || sessions.length >= SESSION_LIMIT) continue
    sessions.push({ pid: Number(parts[0]), login: parts[1]!, seconds: Number(parts[2]), state: STATES[parts[3]!] ?? 'active', file: parts[4] || null, client: parts[5]! })
  }
  return sessions
}

const loginsOf = (account: Pick<Account, 'username'>, ownLogins: readonly string[], domains: readonly string[]): Set<string> =>
  new Set([account.username, ...ownLogins, ...domains.map(domain => 'anonymous@' + domain.toLowerCase())].map(login => login.toLowerCase()))

export async function readFtpSessions(run: ((argv: string[]) => Promise<FtpCommandResult>) | null, account: Pick<Account, 'id' | 'username'>, ownLogins: readonly string[], domains: readonly string[], now: Date): Promise<FtpSessionsView> {
  const base = { context: { accountId: account.id, username: account.username }, observedAt: now.toISOString() }
  let result: FtpCommandResult | null = null
  try { result = run ? await run([...FTP_WHO_ARGV]) : null } catch { result = null }
  const parsed = result?.ok ? parseFtpWho(result.stdout) : null
  if (!parsed) return { ...base, state: 'unavailable', sessions: [] }
  const logins = loginsOf(account, ownLogins, domains)
  return { ...base, state: 'read', sessions: parsed.filter(session => logins.has(session.login.toLowerCase())) }
}

/** The pid comes from a fresh listing for this account, so a stale or foreign pid never reaches kill(1). */
export async function disconnectFtpSessions(run: (argv: string[]) => Promise<FtpCommandResult>, view: FtpSessionsView, target: number | 'all'): Promise<{ disconnected: number[] }> {
  if (view.state !== 'read') return fail('SERVICE_UNAVAILABLE', 'FTP sessions could not be read; nothing was disconnected', { stateChanged: false })
  const pids = view.sessions.filter(session => target === 'all' || session.pid === target).map(session => session.pid)
  if (target !== 'all' && pids.length === 0) return fail('NOT_FOUND', 'this FTP session is no longer open', { stateChanged: false })
  const disconnected: number[] = []
  for (const pid of pids) if ((await run(monitoringKillArgv(pid, 'TERM'))).ok) disconnected.push(pid)
  if (disconnected.length !== pids.length) return fail('SERVICE_UNAVAILABLE', 'a session could not be disconnected', { stateChanged: disconnected.length > 0, verificationRequired: true, disconnected: disconnected.length })
  return { disconnected }
}

export interface FtpReportDay { day: string; transfers: number; bytes: number }
export interface FtpReportHour { hour: number; transfers: number; bytes: number }
export interface FtpReportUser { user: string; transfers: number; downloads: number; uploads: number; bytes: number }
export interface FtpMonthlyReport {
  context: { accountId: string; username: string }; state: 'read' | 'partial' | 'unavailable'; month: string; observedAt: string; window: { since: string; until: string } | null
  totals: { transfers: number; downloads: number; uploads: number; bytes: number }; days: FtpReportDay[]; hours: FtpReportHour[]; users: FtpReportUser[]
}
/** Journal reads are bounded at 7 days each, so a month is read in at most five chunks. */
export const ftpReportWindows = (month: string, now: Date): { since: string; until: string }[] => {
  const start = Date.parse(month + '-01T00:00:00.000Z'), first = new Date(start), next = Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1), end = Math.min(next, now.getTime())
  const windows: { since: string; until: string }[] = [], second = (value: number): string => new Date(value - value % 1000).toISOString().replace('.000Z', 'Z')
  for (let from = start; from < end; from += 7 * 86400_000) windows.push({ since: second(from), until: second(Math.min(from + 7 * 86400_000, end)) })
  return windows
}
export function summarizeFtpMonth(events: readonly FtpLogEvent[], logins: ReadonlySet<string>): Pick<FtpMonthlyReport, 'totals' | 'days' | 'hours' | 'users'> {
  const totals = { transfers: 0, downloads: 0, uploads: 0, bytes: 0 }, days = new Map<string, FtpReportDay>(), hours = new Map<number, FtpReportHour>(), users = new Map<string, FtpReportUser>()
  for (const event of events) {
    if (event.kind !== 'upload' && event.kind !== 'download' || event.user === null || !logins.has(event.user.toLowerCase())) continue
    const bytes = event.bytes ?? 0, day = event.at.slice(0, 10), hour = Number(event.at.slice(11, 13))
    const dayRow = days.get(day) ?? { day, transfers: 0, bytes: 0 }, hourRow = hours.get(hour) ?? { hour, transfers: 0, bytes: 0 }, userRow = users.get(event.user) ?? { user: event.user, transfers: 0, downloads: 0, uploads: 0, bytes: 0 }
    for (const row of [totals, dayRow, hourRow, userRow]) { row.transfers++; row.bytes += bytes }
    const key = event.kind === 'upload' ? 'uploads' : 'downloads'
    totals[key]++; userRow[key]++
    days.set(day, dayRow); hours.set(hour, hourRow); users.set(event.user, userRow)
  }
  return { totals, days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)), hours: [...hours.values()].sort((a, b) => a.hour - b.hour), users: [...users.values()].sort((a, b) => b.bytes - a.bytes || a.user.localeCompare(b.user)) }
}
export type FtpLogWindowReader = (since: string, until: string) => Promise<FtpLogObservation>
export async function readFtpMonthlyReport(read: FtpLogWindowReader | null, account: Pick<Account, 'id' | 'username'>, ownLogins: readonly string[], domains: readonly string[], month: string, now: Date): Promise<FtpMonthlyReport> {
  const windows = ftpReportWindows(month, now), events: FtpLogEvent[] = []
  let read_ = 0, limited = false
  for (const window of windows) {
    if (!read) break
    let observation: FtpLogObservation | null = null
    try { observation = await read(window.since, window.until) } catch { observation = null }
    if (observation?.state !== 'read') continue
    read_++; limited ||= observation.lineLimitReached; events.push(...observation.events)
  }
  const state = !read || windows.length === 0 || read_ === 0 ? 'unavailable' : read_ < windows.length || limited ? 'partial' : 'read'
  return { context: { accountId: account.id, username: account.username }, state, month, observedAt: now.toISOString(), window: windows.length ? { since: windows[0]!.since, until: windows.at(-1)!.until } : null, ...summarizeFtpMonth(events, loginsOf(account, ownLogins, domains)) }
}

export const FTP_WELCOME_MAX = 2048
const WELCOME_FILE = 'public_ftp/.banner'
export interface AnonymousFtpFiles { read(path: string): Promise<string | null>; write(path: string, content: string): Promise<void>; prepare(home: string, uploads: boolean): Promise<void>; publish(path: string): Promise<void> }
export const assertFtpWelcome = (value: unknown): string => typeof value === 'string' && value.length <= FTP_WELCOME_MAX && value.isWellFormed() && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value) ? value
  : fail('VALIDATION', `the welcome message must be plain text of at most ${FTP_WELCOME_MAX} characters`, { stateChanged: false })

/** Written through the confined file manager; modes above its ceilings are set as the account, so a planted symlink reaches only what the account owns. */
export const anonymousFtpFiles = (manager: Pick<JailedFileManager, 'readText' | 'writeText'>, runAction: (action: HostAction) => Promise<void>, username: string): AnonymousFtpFiles => ({
  read: async path => (await manager.readText(path)).content,
  write: async (path, content) => { await manager.writeText(path, content, { overwrite: true }) },
  publish: path => runAction({ kind: 'exec', argv: ['/usr/bin/chmod', '0644', path], runAsUser: username }),
  prepare: async (home, uploads) => {
    const run = (...argv: string[]): Promise<void> => runAction({ kind: 'exec', argv, runAsUser: username }), root = posix.join(home, 'public_ftp')
    await run('/usr/bin/mkdir', '-p', root + '/incoming')
    await run('/usr/bin/chmod', '0755', root)
    await run('/usr/bin/chmod', uploads ? '0733' : '0700', root + '/incoming')
  },
})

export interface FtpAccountRouteDeps {
  caller: AgentCallerIdentity
  store: { getAccountByUsername(username: string): Promise<Account | null>; getPlan(id: string): Promise<Plan | null>; getFeatureList(id: string): Promise<FeatureList | null>; listDomains(filter: { accountId: string }): Promise<readonly { name: string }[]>; listServiceUsers(accountId: string): Promise<readonly { login: string; services: { ftp: boolean } }[]> }
  currentPrincipal(): Promise<{ kind: string; id: string; username: string; accountId: string | null; disabled: boolean } | null>
  run: ((argv: string[]) => Promise<FtpCommandResult>) | null
  readLog: FtpLogWindowReader | null
  files: ((account: Account, plan: Plan) => AnonymousFtpFiles) | null
  audit(account: Account, action: string, detail: Record<string, unknown>): Promise<void>
  now?: () => Date
}
const json = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const ROUTE = /^\/accounts\/([a-z][a-z0-9]{0,15})\/ftp\/(sessions|sessions\/disconnect|anonymous-welcome|monthly-report)$/
const TOOLS = { sessions: 'ftp-connections', 'sessions/disconnect': 'ftp-connections', 'anonymous-welcome': 'anonymous-ftp', 'monthly-report': 'web-stats-ftp' } as const
const MONTH = /^[0-9]{4}-(?:0[1-9]|1[0-2])$/

async function readBody(req: Request, keys: readonly string[]): Promise<Record<string, unknown>> {
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', { stateChanged: false })
  const text = await req.text()
  let body: unknown
  try { body = text.length <= 8192 ? JSON.parse(text) : null } catch { body = null }
  return !!body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === keys.length && keys.every(key => Object.hasOwn(body as object, key)) ? body as Record<string, unknown> : fail('VALIDATION', 'the request fields are not accepted', { stateChanged: false })
}

export async function handleFtpAccountRoute(req: Request, url: URL, method: string, deps: FtpAccountRouteDeps): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  const route = match[2] as keyof typeof TOOLS, write = route === 'sessions/disconnect' || route === 'anonymous-welcome' && method === 'PUT'
  const allowed = route === 'sessions/disconnect' ? ['POST'] : route === 'anonymous-welcome' ? ['GET', 'PUT'] : ['GET']
  if (!allowed.includes(method)) return new Response(null, { status: 405, headers: { allow: allowed.join(', ') } })
  const account = await deps.store.getAccountByUsername(match[1]!)
  if (!account) return fail('NOT_FOUND', 'account not found', { stateChanged: false })
  const authorize = async (): Promise<Plan> => {
    const caller = deps.caller, principal = await deps.currentPrincipal()
    if (caller.role !== 'user' || account.id !== caller.accountId || account.status !== 'active' || !principal || principal.disabled || principal.kind !== 'user' || principal.id !== caller.principalId || principal.accountId !== account.id) return fail('FORBIDDEN', 'FTP tools require the signed-in account owner', { stateChanged: false })
    const plan = await deps.store.getPlan(account.planId), features = plan ? await deps.store.getFeatureList(plan.featureListId) : null
    if (!plan || !features || features.disabled.includes(TOOLS[route])) return fail('FORBIDDEN', 'this FTP tool is disabled by the account plan', { stateChanged: false })
    return plan
  }
  const plan = await authorize(), now = (deps.now?.() ?? new Date())
  if (route === 'anonymous-welcome') {
    const files = deps.files?.(account, plan) ?? fail('PRECONDITION_FAILED', 'account files are not available here', { stateChanged: false })
    if (url.search) return fail('VALIDATION', 'this request takes no selectors', { stateChanged: false })
    if (method === 'GET') return json({ context: { accountId: account.id, username: account.username }, welcome: await files.read(WELCOME_FILE).catch(() => null) })
    const body = await readBody(req, ['welcome', 'uploads']), welcome = assertFtpWelcome(body.welcome)
    if (typeof body.uploads !== 'boolean') return fail('VALIDATION', 'uploads must be a boolean', { stateChanged: false })
    await authorize()
    // Before the login exists, so a host error refuses this one account and never fails a generation.
    try { await files.prepare(account.home, body.uploads); await files.write(WELCOME_FILE, welcome); await files.publish(posix.join(account.home, WELCOME_FILE)) }
    catch (error) { return isXpanelError(error) && error.detail.stateChanged === false ? Promise.reject(error) : fail('SERVICE_UNAVAILABLE', 'the welcome message could not be saved', { stateChanged: true, verificationRequired: true }) }
    return json({ context: { accountId: account.id, username: account.username }, welcome })
  }
  const logins = async (): Promise<[string[], string[]]> => {
    const [users, domains] = await Promise.all([deps.store.listServiceUsers(account.id), deps.store.listDomains({ accountId: account.id })])
    return [users.filter(user => user.services.ftp).map(user => user.login), domains.map(domain => domain.name)]
  }
  if (route === 'monthly-report') {
    const month = [...url.searchParams.keys()].length === 1 ? url.searchParams.get('month') : null
    if (month === null || !MONTH.test(month) || month > now.toISOString().slice(0, 7)) return fail('VALIDATION', 'month must be a current or past YYYY-MM', { stateChanged: false })
    const [own, domains] = await logins()
    const report = await readFtpMonthlyReport(deps.readLog, account, own, domains, month, now)
    await authorize()
    return json(report)
  }
  if (url.search) return fail('VALIDATION', 'FTP sessions take no selectors', { stateChanged: false })
  if (!write) { const [own, domains] = await logins(); return json(await readFtpSessions(deps.run, account, own, domains, now)) }
  const body = await readBody(req, ['target'])
  if (body.target !== 'all' && !(typeof body.target === 'number' && Number.isSafeInteger(body.target) && body.target > 1)) return fail('VALIDATION', 'target must be a session pid or all', { stateChanged: false })
  if (!deps.run) return fail('PRECONDITION_FAILED', 'FTP sessions cannot be read on this host', { stateChanged: false })
  await authorize()
  const [own, domains] = await logins()
  const result = await disconnectFtpSessions(deps.run, await readFtpSessions(deps.run, account, own, domains, now), body.target)
  await deps.audit(account, 'ftp.session.disconnected', { target: body.target, sessions: result.disconnected.length }).catch(() => undefined)
  return json({ context: { accountId: account.id, username: account.username }, ...result })
}
