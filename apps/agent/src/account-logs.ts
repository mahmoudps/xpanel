import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { posix } from 'node:path'
import { fail, isUuid, isXpanelError } from '@xpanel/core'
import type { Account, Domain, FeatureList, Plan } from '@xpanel/core'
import { edge } from '@xpanel/render'
import type { AgentCallerIdentity } from './server.ts'

export const LOG_TAIL_MAX_BYTES = 256 * 1024
export const LOG_TAIL_MAX_LINES = 2000
export const LOG_LINE_MAX_CHARS = 8192
export type AccountLogKind = 'access' | 'error'
/** Plan feature per log kind: tool id and its catalog featureKey. */
export const ACCOUNT_LOG_FEATURES: Readonly<Record<AccountLogKind, readonly [string, string]>> = { access: ['raw-access', 'Raw Access Logs'], error: ['errors', 'Error Log'] }
export interface LogTail { exists: boolean; sizeBytes: number; mtime: string | null; text: string; truncated: boolean }
export type LogTailReader = (path: string, maxBytes: number) => Promise<LogTail>
export interface AccountLogView {
  context: { accountId: string; domainId: string; domainName: string; site: string; kind: AccountLogKind }
  file: { exists: boolean; sizeBytes: number; mtime: string | null; truncated: boolean }
  lines: string[]
  limits: { maxBytes: number; maxLines: number; linesDropped: number }
  observedAt: string
}

/** The log the rendered edge writes for the domain's site: an alias shares its serving site's log (edge.groupSites). */
export function resolveAccountLogPath(account: Account, domains: readonly Domain[], domainId: string, kind: AccountLogKind): { path: string; site: string; domain: Domain } {
  const domain = domains.find(item => item.id === domainId && item.accountId === account.id)
  if (!domain) return fail('NOT_FOUND', 'domain not found', { stateChanged: false })
  let groups: ReturnType<typeof edge.groupSites>
  try { groups = edge.groupSites(account, [...domains]) } catch { return fail('PRECONDITION_FAILED', 'the saved site configuration requires review', { stateChanged: false }) }
  const group = groups.find(item => item.main.id === domain.id || item.aliases.some(alias => alias.id === domain.id))
  if (!group) return fail('NOT_FOUND', 'domain is not served by a site', { stateChanged: false })
  return { path: kind === 'access' ? edge.nginxAccessLog(group.main.name) : edge.nginxErrorLog(group.main.name), site: group.main.name, domain }
}

/** Last lines of a bounded tail: a cut first line is dropped, controls are replaced, long lines are shortened. */
export function tailLines(tail: Pick<LogTail, 'text' | 'truncated'>, maxLines = LOG_TAIL_MAX_LINES): { lines: string[]; dropped: number } {
  const parts = tail.text.split('\n')
  if (tail.truncated) parts.shift()
  if (parts.at(-1) === '') parts.pop()
  const clean = parts.map(line => { const value = line.replace(/\r$/, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '\ufffd'); return value.length > LOG_LINE_MAX_CHARS ? value.slice(0, LOG_LINE_MAX_CHARS) + '…' : value })
  return { lines: clean.slice(-maxLines), dropped: Math.max(0, clean.length - maxLines) }
}

/**
 * Root read of an edge log under the fixed xPanel log directory only. Ancestors must be root-owned
 * real directories (the two xPanel-owned ones without group/other write; distro /var/log may be
 * group-writable), the file is opened without following links, and every identity is re-checked
 * after the open so a swapped component is refused.
 */
export const readProtectedLogTail: LogTailReader = async (path, maxBytes) => {
  const directory = edge.XP_PATHS.nginxLogDir, owned = [directory, posix.dirname(directory)]
  if (posix.normalize(path) !== path || posix.dirname(path) !== directory || !/^[a-z0-9.-]+\.(?:access|error)\.log$/.test(posix.basename(path)) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > LOG_TAIL_MAX_BYTES) return fail('PRECONDITION_FAILED', 'the log path is not an xPanel edge log', { stateChanged: false })
  const ancestors = async (): Promise<string> => {
    const identity: string[] = []
    for (let current: string = directory; current !== '/'; current = posix.dirname(current)) {
      const metadata = await lstat(current)
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== 0 || owned.includes(current) && (metadata.mode & 0o022) !== 0) return fail('PRECONDITION_FAILED', 'the log directory is not protected', { stateChanged: false })
      identity.push(metadata.dev + ':' + metadata.ino)
    }
    return identity.join('/')
  }
  const before = await ancestors()
  let handle
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return { exists: false, sizeBytes: 0, mtime: null, text: '', truncated: false }; return fail('PRECONDITION_FAILED', 'the log file could not be opened safely', { stateChanged: false }) }
  try {
    const metadata = await handle.stat(), named = await lstat(path)
    if (!metadata.isFile() || named.dev !== metadata.dev || named.ino !== metadata.ino || await ancestors() !== before) return fail('PRECONDITION_FAILED', 'the log is not a stable regular file', { stateChanged: false })
    const start = Math.max(0, metadata.size - maxBytes), buffer = Buffer.alloc(metadata.size - start)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
    return { exists: true, sizeBytes: metadata.size, mtime: metadata.mtime.toISOString(), text: new TextDecoder('utf-8').decode(buffer.subarray(0, bytesRead)), truncated: start > 0 }
  } finally { await handle.close() }
}

export interface AccountLogsRouteDeps {
  caller: AgentCallerIdentity
  store: { getAccountByUsername(username: string): Promise<Account | null>; listDomains(filter: { accountId: string }): Promise<Domain[]>; getPlan(id: string): Promise<Plan | null>; getFeatureList(id: string): Promise<FeatureList | null> }
  currentPrincipal(): Promise<{ kind: string; id: string; username: string; accountId: string | null; disabled: boolean } | null>
  /** Absent off a native Linux host: logs are reported unavailable, never synthesized. */
  readTail: LogTailReader | null
  now?: () => Date
}
const LOG_ROUTE = /^\/accounts\/([a-z][a-z0-9]{0,15})\/logs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(access|error)$/

/** Account owner reads the edge log of one owned domain; the path comes from saved state only. */
export async function handleAccountLogsRoute(req: Request, url: URL, method: string, deps: AccountLogsRouteDeps): Promise<Response | null> {
  const match = LOG_ROUTE.exec(url.pathname)
  if (!match) return null
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  if (url.search) return fail('VALIDATION', 'log reads do not accept query selectors', { stateChanged: false })
  const username = match[1]!, domainId = match[2]!, kind = match[3] as AccountLogKind, caller = deps.caller
  if (caller.role !== 'user' || !caller.accountId || !isUuid(domainId)) return fail('FORBIDDEN', 'site logs are read by the signed-in account owner', { stateChanged: false })
  const authorize = async (): Promise<Account> => {
    const account = await deps.store.getAccountByUsername(username), principal = await deps.currentPrincipal()
    if (!account || account.id !== caller.accountId || account.status !== 'active' || !principal || principal.disabled || principal.kind !== 'user' || principal.id !== caller.principalId || principal.accountId !== account.id || principal.username !== account.username) return fail('FORBIDDEN', 'the current account owner is not authorized', { stateChanged: false })
    const plan = await deps.store.getPlan(account.planId), features = plan ? await deps.store.getFeatureList(plan.featureListId) : null
    if (!features || ACCOUNT_LOG_FEATURES[kind].some(key => features.disabled.includes(key))) return fail('FORBIDDEN', 'this log is disabled by the account plan', { stateChanged: false })
    return account
  }
  const account = await authorize()
  const target = resolveAccountLogPath(account, await deps.store.listDomains({ accountId: account.id }), domainId, kind)
  if (!deps.readTail) return fail('PRECONDITION_FAILED', 'site logs are unavailable on this host', { stateChanged: false })
  let tail: LogTail
  try { tail = await deps.readTail(target.path, LOG_TAIL_MAX_BYTES) }
  catch (error) { if (isXpanelError(error)) throw error; return fail('PRECONDITION_FAILED', 'the site log could not be read', { stateChanged: false }) }
  // Fresh authority after the read: a revoked owner or moved domain never receives the content.
  const fresh = await authorize(), again = resolveAccountLogPath(fresh, await deps.store.listDomains({ accountId: fresh.id }), domainId, kind)
  if (again.path !== target.path || fresh.id !== account.id) return fail('CONFLICT', 'the domain site changed while reading its log', { stateChanged: false })
  const { lines, dropped } = tailLines(tail)
  const view: AccountLogView = { context: { accountId: account.id, domainId, domainName: target.domain.name, site: target.site, kind },
    file: { exists: tail.exists, sizeBytes: tail.sizeBytes, mtime: tail.mtime, truncated: tail.truncated || dropped > 0 }, lines,
    limits: { maxBytes: LOG_TAIL_MAX_BYTES, maxLines: LOG_TAIL_MAX_LINES, linesDropped: dropped }, observedAt: (deps.now?.() ?? new Date()).toISOString() }
  return new Response(JSON.stringify(view), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}

export interface AccessLogEntry { time: string; host: string; ip: string; method: string; uri: string; status: number; bytes: number; referer: string; agent: string }
export interface ErrorLogEntry { time: string | null; level: string | null; message: string }
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max
/** One line of the edge's own `log_format xpanel_metrics escape=json` (packages/render/src/edge/nginx.ts). */
export function parseAccessLogLine(line: string): AccessLogEntry | null {
  let value: unknown
  try { value = JSON.parse(line) } catch { return null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (!text(v.time, 64) || !text(v.host, 255) || !text(v.ip, 64) || !text(v.method, 32) || !text(v.uri, LOG_LINE_MAX_CHARS) || !text(v.referer, LOG_LINE_MAX_CHARS) || !text(v.agent, LOG_LINE_MAX_CHARS)
    || typeof v.status !== 'number' || !Number.isInteger(v.status) || v.status < 100 || v.status > 599 || typeof v.body_bytes !== 'number' || !Number.isSafeInteger(v.body_bytes) || v.body_bytes < 0) return null
  return { time: v.time, host: v.host, ip: v.ip, method: v.method, uri: v.uri, status: v.status, bytes: v.body_bytes, referer: v.referer, agent: v.agent }
}
/** nginx error_log line: `YYYY/MM/DD HH:MM:SS [level] PID#TID: message`; other lines are continuations. */
export function parseErrorLogLine(line: string): ErrorLogEntry {
  const match = /^(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}) \[(debug|info|notice|warn|error|crit|alert|emerg)\] \d+#\d+: (.*)$/.exec(line)
  return match ? { time: match[1]!, level: match[2]!, message: match[3]! } : { time: null, level: null, message: line }
}
