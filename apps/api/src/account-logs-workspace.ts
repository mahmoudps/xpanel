import { fail, isXpanelError, validateAccountLogSettings } from '@xpanel/core'
import type { Account, AccountLogSettings, Domain } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import type { AccountLogArchivesView } from '../../agent/src/account-logs.ts'
import { readLogTweaks } from '../../agent/src/log-rotation.ts'
import { authorizeAccountOwner, workspaceJson } from './account-ssh-workspace.ts'
import type { AccountSshPorts } from './account-ssh-workspace.ts'
import { ACCOUNT_LOG_FEATURES, LOG_LINE_MAX_CHARS, LOG_TAIL_MAX_BYTES, LOG_TAIL_MAX_LINES, parseAccessLogLine, parseErrorLogLine } from '../../agent/src/account-logs.ts'
import type { AccessLogEntry, AccountLogKind, AccountLogView, ErrorLogEntry } from '../../agent/src/account-logs.ts'

export const ACCOUNT_LOGS_ROUTE = /^\/api\/account\/logs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(access|error)$/
const ARCHIVES_ROUTE = /^\/api\/account\/logs\/archives(?:\/([a-z0-9.-]{1,280}\.gz))?$/
export const ACCOUNT_LOG_SETTINGS_PATH = '/api/account/logs/settings'
const CURRENT_LOG_ROUTE = /^\/api\/account\/logs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/access\/download$/
const RAW_SERVER_LOGS_ROUTE = /^\/api\/server\/logs\/raw\/(nginx|apache)(?:\/((?:access|error)\.log(?:\.[1-9][0-9]?)?(?:\.gz)?))?$/
export const SERVER_LOG_RETENTION_PATH = '/api/server/logs/retention'
export interface AccountLogsPorts extends AccountSshPorts {
  assertRoot(caller: AuthenticatedCaller, action: string): Promise<void>
  emitAudit(entry: { actor: string; action: string; target: string; detail: Record<string, unknown>; outcome: 'ok'; principalId: string }, scope: { accountId: string | null; resellerId: string | null }): Promise<unknown>
  /** Raw agent response for the streamed archive download (agent-client.ts admits only the archive grammar). */
  callAgent(caller: AuthenticatedCaller, path: string): Promise<Response>
}
export interface AccountLogSettingsView { context: { accountId: string }; settings: AccountLogSettings; source: 'account' | 'server'; serverDefaults: AccountLogSettings }
export interface AccountLogsProjection {
  context: AccountLogView['context']; file: AccountLogView['file']; limits: AccountLogView['limits']; observedAt: string
  entries: AccessLogEntry[] | ErrorLogEntry[]; unparsedLines: number
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const int = (value: unknown, min = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min

/** Pins the agent tail to the owned domain and its bounds, then parses each line for the browser. */
export function projectAccountLogs(raw: unknown, account: Account, domain: Domain, kind: AccountLogKind): AccountLogsProjection {
  const bad = (): never => fail('CONFIG_TEST_FAILED', 'protected log reply is invalid')
  if (!object(raw) || !object(raw.context) || !object(raw.file) || !object(raw.limits) || !Array.isArray(raw.lines)) return bad()
  const { context, file, limits } = raw
  if (context.accountId !== account.id || context.domainId !== domain.id || context.domainName !== domain.name || context.kind !== kind || typeof context.site !== 'string' || !/^[a-z0-9.-]{1,253}$/.test(context.site)
    || typeof file.exists !== 'boolean' || !int(file.sizeBytes) || typeof file.truncated !== 'boolean' || !(file.mtime === null || typeof file.mtime === 'string' && Number.isFinite(Date.parse(file.mtime))) || !file.exists && (file.sizeBytes !== 0 || raw.lines.length !== 0)
    || limits.maxBytes !== LOG_TAIL_MAX_BYTES || limits.maxLines !== LOG_TAIL_MAX_LINES || !int(limits.linesDropped) || raw.lines.length > LOG_TAIL_MAX_LINES || raw.lines.some(line => typeof line !== 'string' || line.length > LOG_LINE_MAX_CHARS + 1 || /[\r\n]/.test(line))
    || typeof raw.observedAt !== 'string' || !Number.isFinite(Date.parse(raw.observedAt))) return bad()
  const lines = raw.lines as string[]
  const entries = kind === 'access' ? lines.map(parseAccessLogLine).filter((entry): entry is AccessLogEntry => entry !== null) : lines.map(parseErrorLogLine)
  return { context: { accountId: account.id, domainId: domain.id, domainName: domain.name, site: context.site, kind },
    file: { exists: file.exists, sizeBytes: file.sizeBytes, mtime: file.mtime as string | null, truncated: file.truncated }, limits: { maxBytes: LOG_TAIL_MAX_BYTES, maxLines: LOG_TAIL_MAX_LINES, linesDropped: limits.linesDropped },
    observedAt: raw.observedAt, entries, unparsedLines: kind === 'access' ? lines.length - entries.length : entries.filter(entry => (entry as ErrorLogEntry).time === null).length }
}

const ARCHIVE_NAME = /^[a-z0-9][a-z0-9.-]{0,252}-\d{4}-\d{2}-\d{2}(?:-[2-9])?\.gz$/
/** Pins the agent archive listing to the signed-in account and its bounds. */
export function projectLogArchives(raw: unknown, account: Account): AccountLogArchivesView {
  const bad = (): never => fail('CONFIG_TEST_FAILED', 'protected log archive reply is invalid')
  if (!object(raw) || !object(raw.context) || raw.context.accountId !== account.id || raw.context.username !== account.username || typeof raw.available !== 'boolean' || !Array.isArray(raw.archives) || raw.archives.length > 2000
    || typeof raw.observedAt !== 'string' || !Number.isFinite(Date.parse(raw.observedAt)) || !raw.available && raw.archives.length > 0) return bad()
  const pending = raw.pending === null || raw.pending === undefined ? null : projectPending(raw.pending, account.username)
  const archives = raw.archives.map(v => object(v) && typeof v.name === 'string' && ARCHIVE_NAME.test(v.name) && typeof v.site === 'string' && typeof v.day === 'string' && v.name.startsWith(v.site + '-' + v.day) && int(v.sizeBytes) && typeof v.mtime === 'string' && Number.isFinite(Date.parse(v.mtime))
    ? { name: v.name, site: v.site, day: v.day, sizeBytes: v.sizeBytes, mtime: v.mtime } : bad())
  return { context: { accountId: account.id, username: account.username }, available: raw.available, archives, pending, observedAt: raw.observedAt }
}

/** Undelivered archives: the stable code archive_pending, how many, how large, since when and the last copy failure. */
function projectPending(v: unknown, username?: string): AccountLogArchivesView['pending'] & object {
  if (!object(v) || v.code !== 'archive_pending' || typeof v.username !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(v.username) || username !== undefined && v.username !== username
    || !int(v.count, 1) || !int(v.bytes) || typeof v.oldest !== 'string' || !Number.isFinite(Date.parse(v.oldest)) || typeof v.reason !== 'string' || !/^[a-z_]{1,40}$/.test(v.reason)) return fail('CONFIG_TEST_FAILED', 'protected log archive reply is invalid')
  return { username: v.username, code: 'archive_pending', count: v.count, bytes: v.bytes, oldest: v.oldest, reason: v.reason }
}

export interface RawServerLogsProjection { server: 'nginx' | 'apache'; state: 'read' | 'unavailable'; files: { name: string; sizeBytes: number; mtime: string; compressed: boolean; downloadable: boolean }[]; maxBytes: number; observedAt: string }
/** Pins the agent listing of one web server's own logs to the fixed name grammar and its bounds. */
export function projectRawServerLogs(raw: unknown, server: 'nginx' | 'apache'): RawServerLogsProjection {
  const bad = (): never => fail('CONFIG_TEST_FAILED', 'raw server log reply is invalid')
  if (!object(raw) || raw.server !== server || !['read', 'unavailable'].includes(String(raw.state)) || !Array.isArray(raw.files) || raw.files.length > 200 || !int(raw.maxBytes, 1) || typeof raw.observedAt !== 'string' || !Number.isFinite(Date.parse(raw.observedAt)) || raw.state === 'unavailable' && raw.files.length) return bad()
  const files = raw.files.map(v => object(v) && typeof v.name === 'string' && /^(?:access|error)\.log(?:\.[1-9][0-9]?)?(?:\.gz)?$/.test(v.name) && int(v.sizeBytes) && typeof v.mtime === 'string' && Number.isFinite(Date.parse(v.mtime)) && typeof v.compressed === 'boolean' && typeof v.downloadable === 'boolean'
    ? { name: v.name, sizeBytes: v.sizeBytes, mtime: v.mtime, compressed: v.compressed, downloadable: v.downloadable } : bad())
  return { server, state: raw.state as 'read' | 'unavailable', files, maxBytes: raw.maxBytes, observedAt: raw.observedAt }
}

const settingsView = (account: Account, serverDefaults: AccountLogSettings): AccountLogSettingsView =>
  ({ context: { accountId: account.id }, settings: account.logs ?? serverDefaults, source: account.logs ? 'account' : 'server', serverDefaults })

const RUN_COUNTS = ['rotated', 'archived', 'deleted', 'removedArchives', 'failures', 'held', 'lost'] as const
const projectRotationStatus = (raw: unknown): { lastRun: unknown; failures: unknown; pending: unknown; hold: unknown } => {
  const bad = (): never => fail('SERVICE_UNAVAILABLE', 'the log rotation status could not be verified', { stateChanged: false })
  if (!object(raw) || !Array.isArray(raw.failures) || raw.failures.length > 50 || !Array.isArray(raw.pending) || raw.pending.length > 4096 || !object(raw.hold) || !int(raw.hold.days, 1) || !int(raw.hold.maxBytes, 1)) return bad()
  const run = raw.lastRun
  if (run !== null && (!object(run) || typeof run.at !== 'string' || !RUN_COUNTS.every(key => int(run[key])))) return bad()
  let pending: unknown[]
  try { pending = raw.pending.map(item => projectPending(item)) } catch { return bad() }
  const failures = raw.failures.map(v => object(v) && typeof v.username === 'string' && /^[a-z][a-z0-9]{0,15}$/.test(v.username) && typeof v.site === 'string' && v.site.length <= 253 && typeof v.reason === 'string' && /^[a-z_]{1,40}$/.test(v.reason) && typeof v.at === 'string'
    ? { username: v.username, site: v.site, reason: v.reason, at: v.at } : bad())
  return { lastRun: run === null || !object(run) ? null : { at: run.at, ...Object.fromEntries(RUN_COUNTS.map(key => [key, run[key]])) }, failures, pending, hold: { days: raw.hold.days, maxBytes: raw.hold.maxBytes } }
}

/** cPanel Raw Access settings and archives for the signed-in owner, and the WHM Web Log Retention overview for root. */
async function handleLogArchiveRoutes(req: Request, url: URL, method: string, ports: AccountLogsPorts): Promise<Response | null> {
  const archives = ARCHIVES_ROUTE.exec(url.pathname), current = CURRENT_LOG_ROUTE.exec(url.pathname), raw = /^\/api\/server\/logs\/raw\//.test(url.pathname) ? RAW_SERVER_LOGS_ROUTE.exec(url.pathname) : null
  if (/^\/api\/server\/logs\/raw\//.test(url.pathname) && !raw) return fail('NOT_FOUND', 'log file not found', { stateChanged: false })
  if (!archives && !current && !raw && url.pathname !== ACCOUNT_LOG_SETTINGS_PATH && url.pathname !== SERVER_LOG_RETENTION_PATH) return null
  if (url.search) return fail('VALIDATION', 'log routes accept no query selectors', { stateChanged: false })
  if (raw) {
    const caller = await ports.requireCaller(req)
    await ports.assertRoot(caller, 'server.logs.raw.read')
    if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
    const path = '/host/logs/raw/' + raw[1] + (raw[2] ? '/' + raw[2] : '')
    if (!raw[2]) {
      try { return workspaceJson(projectRawServerLogs(await ports.readAgent(caller, path), raw[1] as 'nginx' | 'apache')) }
      catch (error) { if (isXpanelError(error) && error.code !== 'CONFIG_TEST_FAILED') throw error; return fail('SERVICE_UNAVAILABLE', 'the server log list could not be verified', { stateChanged: false }) }
    }
    const response = await ports.callAgent(caller, path)
    if (!response.ok || !response.body) { await response.body?.cancel().catch(() => undefined); return fail(response.status === 404 ? 'NOT_FOUND' : response.status === 413 || response.status === 422 ? 'LIMIT_EXCEEDED' : 'SERVICE_UNAVAILABLE', 'the server log could not be read', { stateChanged: false }) }
    await ports.emitAudit({ actor: caller.principal.username, action: 'server.logs.raw.downloaded', target: 'server:' + raw[1], detail: { file: raw[2] }, outcome: 'ok', principalId: caller.principal.id }, { accountId: null, resellerId: null })
    return new Response(response.body, { headers: { 'content-type': response.headers.get('content-type') ?? 'application/octet-stream', 'content-length': response.headers.get('content-length') ?? '', 'content-disposition': 'attachment; filename="' + raw[1] + '-' + raw[2] + '"', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
  }
  if (current) {
    if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
    const { caller, account } = await authorizeAccountOwner(ports, req, ['raw-access'], 'Raw access logs')
    const domain = await ports.store.getDomain(current[1]!)
    if (!domain || domain.accountId !== account.id) return fail('NOT_FOUND', 'domain not found', { stateChanged: false })
    const response = await ports.callAgent(caller, '/accounts/' + account.username + '/logs/' + domain.id + '/access/download')
    if (!response.ok || !response.body) { await response.body?.cancel().catch(() => undefined); return fail(response.status === 404 ? 'NOT_FOUND' : 'SERVICE_UNAVAILABLE', 'the current access log could not be read', { stateChanged: false }) }
    return new Response(response.body, { headers: { 'content-type': 'application/gzip', 'content-disposition': response.headers.get('content-disposition') ?? 'attachment', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
  }
  if (url.pathname === SERVER_LOG_RETENTION_PATH) {
    const caller = await ports.requireCaller(req)
    await ports.assertRoot(caller, 'server.logs.retention.read')
    if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
    const [{ defaults, panelRotateDays }, snapshot] = await Promise.all([readLogTweaks(ports.store.rootDir), ports.store.readSnapshot()])
    let rotation: { state: 'read'; lastRun: unknown; failures: unknown; pending: unknown; hold: unknown } | { state: 'unavailable' }
    try { rotation = { state: 'read', ...projectRotationStatus(await ports.readAgent(caller, '/host/monitoring/log-rotation')) } }
    catch (error) { if (isXpanelError(error) && ['FORBIDDEN', 'UNAUTHENTICATED'].includes(error.code)) throw error; rotation = { state: 'unavailable' } }
    return workspaceJson({ serverDefaults: defaults, panelRotateDays, rotation,
      accounts: snapshot.accounts.filter(account => account.status !== 'terminating').map(account => ({ accountId: account.id, username: account.username, domain: account.primaryDomain, ownerId: account.ownerId, settings: account.logs ?? defaults, source: account.logs ? 'account' : 'server' })) })
  }
  const { caller, account } = await authorizeAccountOwner(ports, req, ['raw-access'], 'Raw access logs')
  if (url.pathname === ACCOUNT_LOG_SETTINGS_PATH) {
    if (method !== 'GET' && method !== 'PUT') return new Response(null, { status: 405, headers: { allow: 'GET, PUT' } })
    const { defaults } = await readLogTweaks(ports.store.rootDir)
    if (method === 'GET') return workspaceJson(settingsView(account, defaults))
    let body: unknown
    try { body = await req.json() } catch { return fail('VALIDATION', 'log settings must be valid JSON', { stateChanged: false }) }
    if (!object(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'settings')) return fail('VALIDATION', 'send { settings }, or { settings: null } for the server defaults', { stateChanged: false })
    const settings = body.settings === null ? null : validateAccountLogSettings(body.settings)
    const fresh = await authorizeAccountOwner(ports, req, ['raw-access'], 'Raw access logs')
    if (fresh.caller.principal.id !== caller.principal.id || fresh.account.id !== account.id) return fail('CONFLICT', 'the account binding changed before saving', { stateChanged: false })
    const updated = await ports.store.setAccountLogSettings(account.id, settings)
    await ports.emitAudit({ actor: caller.principal.username, action: 'account.logs.settings.updated', target: 'account:' + updated.username, detail: { settings: updated.logs ?? null }, outcome: 'ok', principalId: caller.principal.id }, { accountId: updated.id, resellerId: updated.ownerId })
    return workspaceJson(settingsView(updated, defaults))
  }
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  const name = archives![1], path = '/accounts/' + account.username + '/logs/archives' + (name ? '/' + name : '')
  if (!name) {
    try { return workspaceJson(projectLogArchives(await ports.readAgent(caller, path), account)) }
    catch (error) { if (isXpanelError(error) && error.code !== 'CONFIG_TEST_FAILED') throw error; return fail('SERVICE_UNAVAILABLE', 'the log archive list could not be verified', { stateChanged: false }) }
  }
  const response = await ports.callAgent(caller, path)
  if (!response.ok || !response.body) { await response.body?.cancel().catch(() => undefined); return fail(response.status === 404 ? 'NOT_FOUND' : 'SERVICE_UNAVAILABLE', 'the log archive could not be read', { stateChanged: false }) }
  return new Response(response.body, { headers: { 'content-type': 'application/gzip', 'content-length': response.headers.get('content-length') ?? '', 'content-disposition': 'attachment; filename="' + name + '"', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
}

/** GET only. The domain must belong to the signed-in owner; its log path is resolved by the agent. */
export async function handleAccountLogsRoute(req: Request, url: URL, method: string, ports: AccountLogsPorts): Promise<Response | null> {
  const archiveResponse = await handleLogArchiveRoutes(req, url, method, ports)
  if (archiveResponse) return archiveResponse
  const match = ACCOUNT_LOGS_ROUTE.exec(url.pathname)
  if (!match) return null
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  if (url.search) return fail('VALIDATION', 'log reads do not accept selectors; filter in the page', { stateChanged: false })
  const domainId = match[1]!, kind = match[2] as AccountLogKind
  const { caller, account } = await authorizeAccountOwner(ports, req, [ACCOUNT_LOG_FEATURES[kind][0]], 'Site logs')
  const domain = await ports.store.getDomain(domainId)
  if (!domain || domain.accountId !== account.id) return fail('NOT_FOUND', 'domain not found', { stateChanged: false })
  const raw = await ports.readAgent(caller, '/accounts/' + account.username + '/logs/' + domain.id + '/' + kind)
  try { return workspaceJson(projectAccountLogs(raw, account, domain, kind)) }
  catch (error) { if (isXpanelError(error) && error.code !== 'CONFIG_TEST_FAILED') throw error; return fail('SERVICE_UNAVAILABLE', 'the protected log read could not be verified', { stateChanged: false }) }
}
