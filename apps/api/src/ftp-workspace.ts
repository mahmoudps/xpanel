import { effectiveServerFtpSettings, fail, validateServerFtpSettings } from '@xpanel/core'
import type { ServerFtpSettings } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import { assertFtpWelcome } from '../../agent/src/ftp-account.ts'
import type { FtpMonthlyReport, FtpSessionsView } from '../../agent/src/ftp-account.ts'
import { parseAnonymousFtpState } from '../../agent/src/ftp-server.ts'
import type { AnonymousFtpState } from '../../agent/src/ftp-server.ts'
import { authorizeAccountOwner, workspaceJson } from './account-ssh-workspace.ts'
import type { AccountSshPorts } from './account-ssh-workspace.ts'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { panelConfigFile, panelConfigRevision, readPanelConfigBody } from './panel-config-file.ts'

/** FTP Server Configuration (root) and the owner FTP tools. The agent replies are rebuilt from validated fields before the browser sees them. */
const unchanged = { stateChanged: false }
const NAMESPACE = 'ftp-anonymous:v1'
const anonymousFile = (store: Pick<StateStore, 'rootDir' | 'getWriterLock'>) => panelConfigFile<AnonymousFtpState>(store, 'ftp-anonymous.json', NAMESPACE, raw => { try { return parseAnonymousFtpState(raw) } catch { return null } }, () => ({}))
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const iso = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/u
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length >= 1 && value.length <= max && !UNSAFE.test(value)
const context = (raw: unknown, accountId: string): boolean => object(raw) && exact(raw, ['accountId', 'username']) && raw.accountId === accountId

export function validateFtpSessions(raw: unknown, accountId: string): FtpSessionsView {
  const bad = (): never => fail('SERVICE_UNAVAILABLE', 'FTP sessions could not be verified', unchanged)
  if (!object(raw) || !exact(raw, ['context', 'state', 'observedAt', 'sessions']) || !context(raw.context, accountId) || !['read', 'unavailable'].includes(String(raw.state)) || !iso(raw.observedAt) || !Array.isArray(raw.sessions) || raw.sessions.length > 500) return bad()
  for (const row of raw.sessions) {
    if (!object(row) || !exact(row, ['pid', 'login', 'seconds', 'state', 'file', 'client']) || !count(row.pid) || !text(row.login, 320) || !count(row.seconds) || !['idle', 'download', 'upload', 'active'].includes(String(row.state)) || row.file !== null && !text(row.file, 1024) || !text(row.client, 253)) return bad()
  }
  return raw as unknown as FtpSessionsView
}
export function validateFtpReport(raw: unknown, accountId: string, month: string): FtpMonthlyReport {
  const bad = (): never => fail('SERVICE_UNAVAILABLE', 'the FTP report could not be verified', unchanged)
  if (!object(raw) || !exact(raw, ['context', 'state', 'month', 'observedAt', 'window', 'totals', 'days', 'hours', 'users']) || !context(raw.context, accountId) || !['read', 'partial', 'unavailable'].includes(String(raw.state)) || raw.month !== month || !iso(raw.observedAt)
    || !object(raw.totals) || !exact(raw.totals, ['transfers', 'downloads', 'uploads', 'bytes']) || !Object.values(raw.totals).every(count) || !Array.isArray(raw.days) || raw.days.length > 31 || !Array.isArray(raw.hours) || raw.hours.length > 24 || !Array.isArray(raw.users) || raw.users.length > 5000) return bad()
  for (const row of raw.days) if (!object(row) || !exact(row, ['day', 'transfers', 'bytes']) || typeof row.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.day) || !count(row.transfers) || !count(row.bytes)) return bad()
  for (const row of raw.hours) if (!object(row) || !exact(row, ['hour', 'transfers', 'bytes']) || !count(row.hour) || row.hour > 23 || !count(row.transfers) || !count(row.bytes)) return bad()
  for (const row of raw.users) if (!object(row) || !exact(row, ['user', 'transfers', 'downloads', 'uploads', 'bytes']) || !text(row.user, 320) || ![row.transfers, row.downloads, row.uploads, row.bytes].every(count)) return bad()
  return raw as unknown as FtpMonthlyReport
}

export interface FtpWorkspaceHelpers extends AccountSshPorts, Pick<ExtendedRouteHelpers, 'assertRoot' | 'emitAudit'> {
  triggerReconcile(caller: AuthenticatedCaller): Promise<{ ok: boolean; status: number; body: Record<string, unknown> } | null>
}
const parseAnonymousRequest = (raw: Record<string, unknown>): { enabled: boolean; uploads: boolean; welcome: string } => {
  if (!exact(raw, ['enabled', 'uploads', 'welcome', 'expectedRevision']) || typeof raw.enabled !== 'boolean' || typeof raw.uploads !== 'boolean' || raw.uploads && !raw.enabled) return fail('VALIDATION', 'exactly enabled, uploads, welcome and expectedRevision are required', unchanged)
  return { enabled: raw.enabled, uploads: raw.uploads, welcome: assertFtpWelcome(raw.welcome) }
}
const applied = (reconcile: { ok: boolean } | null): { status: 'applied' | 'not_requested' | 'failed' } => ({ status: reconcile === null ? 'not_requested' : reconcile.ok ? 'applied' : 'failed' })

async function handleServerSettings(req: Request, method: string, helpers: FtpWorkspaceHelpers): Promise<Response> {
  const caller = await helpers.requireCaller(req)
  await helpers.assertRoot(caller, 'server.ftp.settings')
  if (method !== 'GET' && method !== 'PUT') return new Response(null, { status: 405, headers: { allow: 'GET, PUT' } })
  const current = await helpers.store.getServerSettings()
  if (method === 'GET') return workspaceJson({ settings: effectiveServerFtpSettings(current), saved: current?.ftp !== undefined })
  const body = await readPanelConfigBody(req)
  if (!exact(body, ['settings'])) return fail('VALIDATION', 'exactly settings is required', unchanged)
  const settings: ServerFtpSettings = validateServerFtpSettings(body.settings)
  if (!current) return fail('PRECONDITION_FAILED', 'server setup is not complete', unchanged)
  const saved = await helpers.store.saveServerSettings({ ...current, ftp: settings }, { settingsGuard: async () => { await helpers.assertRoot(await helpers.requireCaller(req), 'server.ftp.settings') } })
  const reconcile = await helpers.triggerReconcile(caller)
  await Promise.resolve(helpers.emitAudit({ actor: caller.principal.username, action: 'server.ftp.settings_updated', target: 'ftp:settings', detail: { enabled: settings.enabled, tls: settings.tls, anonymous: settings.anonymous }, outcome: reconcile && !reconcile.ok ? 'failed' : 'ok', principalId: caller.principal.id })).catch(() => undefined)
  return workspaceJson({ settings: effectiveServerFtpSettings(saved), saved: true, application: applied(reconcile) })
}

async function handleAnonymous(req: Request, method: string, helpers: FtpWorkspaceHelpers): Promise<Response> {
  if (method !== 'GET' && method !== 'PUT') return new Response(null, { status: 405, headers: { allow: 'GET, PUT' } })
  const label = 'Anonymous FTP', file = anonymousFile(helpers.store), first = await authorizeAccountOwner(helpers, req, ['anonymous-ftp'], label), { account, caller } = first
  const server = effectiveServerFtpSettings(await helpers.store.getServerSettings()), welcomePath = `/accounts/${account.username}/ftp/anonymous-welcome`
  const domains = (await helpers.store.listDomains({ accountId: account.id })).map(domain => 'anonymous@' + domain.name)
  const view = async (welcome: string | null) => {
    const { raw, value } = await file.read(), saved = value?.[account.id]
    return { context: { accountId: account.id, username: account.username }, revision: panelConfigRevision(NAMESPACE, raw), server: { enabled: server.enabled, anonymous: server.anonymous, anonymousUploads: server.anonymousUploads },
      enabled: saved?.enabled ?? false, uploads: saved?.uploads ?? false, welcome, logins: domains, directory: 'public_ftp' }
  }
  if (method === 'GET') {
    const raw = await helpers.readAgent<Record<string, unknown>>(caller, welcomePath, undefined, false, 'GET')
    return workspaceJson(await view(typeof raw?.welcome === 'string' ? raw.welcome : null))
  }
  const body = await readPanelConfigBody(req), request = parseAnonymousRequest(body)
  if (typeof body.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedRevision)) return fail('VALIDATION', 'expectedRevision is required', unchanged)
  if (request.enabled && (!server.enabled || !server.anonymous)) return fail('PRECONDITION_FAILED', 'the server does not allow anonymous FTP', { ...unchanged, reason: 'anonymous_ftp_disabled_by_server' })
  if (request.uploads && !server.anonymousUploads) return fail('PRECONDITION_FAILED', 'the server does not allow anonymous uploads', { ...unchanged, reason: 'anonymous_uploads_disabled_by_server' })
  const authority = async (): Promise<void> => {
    const fresh = await authorizeAccountOwner(helpers, req, ['anonymous-ftp'], label)
    if (fresh.caller.principal.id !== caller.principal.id || fresh.account.id !== account.id) return fail('FORBIDDEN', 'the current account binding changed', unchanged)
  }
  const { [account.id]: _previous, ...others } = await file.current()
  // public_ftp is ready, as the account, before a login can reach it; saving and reconciling come after.
  let welcome: string | null = null
  if (request.enabled) {
    const raw = await helpers.readAgent<Record<string, unknown>>(caller, welcomePath, { welcome: request.welcome, uploads: request.uploads }, true, 'PUT')
    welcome = typeof raw?.welcome === 'string' ? raw.welcome : null
  }
  await file.write(request.enabled ? { ...others, [account.id]: { enabled: true, uploads: request.uploads } } : others, body.expectedRevision, authority)
  const reconcile = await helpers.triggerReconcile(caller)
  await Promise.resolve(helpers.emitAudit({ actor: caller.principal.username, action: 'ftp.anonymous.updated', target: 'account:' + account.username, detail: { enabled: request.enabled, uploads: request.uploads }, outcome: reconcile && !reconcile.ok ? 'failed' : 'ok', principalId: caller.principal.id }, { accountId: account.id, resellerId: account.ownerId })).catch(() => undefined)
  return workspaceJson({ ...await view(welcome), application: applied(reconcile) })
}

export async function handleFtpWorkspaceRoute(req: Request, url: URL, method: string, helpers: FtpWorkspaceHelpers): Promise<Response | null> {
  if (url.pathname === '/api/server/ftp/settings') {
    if (url.search) return fail('VALIDATION', 'FTP settings take no selectors', unchanged)
    return handleServerSettings(req, method, helpers)
  }
  if (url.pathname === '/api/account/ftp/anonymous') {
    if (url.search) return fail('VALIDATION', 'Anonymous FTP takes no selectors', unchanged)
    return handleAnonymous(req, method, helpers)
  }
  if (url.pathname === '/api/account/ftp/monthly-report') {
    if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
    const month = [...url.searchParams.keys()].length === 1 ? url.searchParams.get('month') : null
    if (month === null || !/^[0-9]{4}-(?:0[1-9]|1[0-2])$/.test(month)) return fail('VALIDATION', 'month must be YYYY-MM', unchanged)
    const { account, caller } = await authorizeAccountOwner(helpers, req, ['web-stats-ftp'], 'FTP statistics')
    return workspaceJson(validateFtpReport(await helpers.readAgent(caller, `/accounts/${account.username}/ftp/monthly-report?month=${month}`, undefined, false, 'GET'), account.id, month))
  }
  if (url.pathname === '/api/account/ftp/sessions') {
    if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
    if (url.search) return fail('VALIDATION', 'FTP sessions take no selectors', unchanged)
    const { account, caller } = await authorizeAccountOwner(helpers, req, ['ftp-connections'], 'FTP connections')
    return workspaceJson(validateFtpSessions(await helpers.readAgent(caller, `/accounts/${account.username}/ftp/sessions`, undefined, false, 'GET'), account.id))
  }
  if (url.pathname === '/api/account/ftp/sessions/disconnect') {
    if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
    const { account, caller } = await authorizeAccountOwner(helpers, req, ['ftp-connections'], 'FTP connections')
    const body = await readPanelConfigBody(req, 256)
    if (!exact(body, ['target']) || body.target !== 'all' && !(typeof body.target === 'number' && Number.isSafeInteger(body.target) && body.target > 1)) return fail('VALIDATION', 'target must be a session pid or all', unchanged)
    const raw = await helpers.readAgent(caller, `/accounts/${account.username}/ftp/sessions/disconnect`, { target: body.target }, true, 'POST')
    if (!object(raw) || !context(raw.context, account.id) || !Array.isArray(raw.disconnected) || !raw.disconnected.every(count)) return fail('SERVICE_UNAVAILABLE', 'the disconnect result could not be verified', { stateChanged: true, verificationRequired: true })
    return workspaceJson({ disconnected: raw.disconnected.length })
  }
  return null
}
