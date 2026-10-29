import { isIP } from 'node:net'
import { fail, validateDomainName } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { assertExpectedRevision, exactKeys, panelConfigFile, panelConfigRevision, panelJson, readPanelConfigBody } from './panel-config-file.ts'
import type { PanelConfigFile } from './panel-config-file.ts'

/** Server-wide settings of the panels themselves; every field has an effect in the running API. */
export interface PanelSettingsFields {
  /** Only root can sign in and work while the panels are offline; everyone else sees the maintenance page. */
  offlineMode: boolean
  offlineMessage: string
  /** API responses carry a Server-Timing header. */
  developerMode: boolean
  /** Pages open the live updates (WebSocket) channel. */
  liveUpdates: boolean
  /** Remote hosts account owners may use as a reverse-proxy upstream; empty keeps proxies on this server. */
  reverseProxyAllowedHosts: string[]
}
export interface PanelSettingsRecord extends PanelSettingsFields { version: 1; updatedAt: string }
export interface PanelSettingsView { state: 'default' | 'saved' | 'invalid'; settings: PanelSettingsFields | null; updatedAt: string | null; revision: string }

const ROUTE = '/api/server/panel/settings'
const NAMESPACE = 'panel-settings:v1'
const FIELDS = ['offlineMode', 'offlineMessage', 'developerMode', 'liveUpdates', 'reverseProxyAllowedHosts'] as const
export const PANEL_SETTINGS_LIMITS = { offlineMessage: 280, allowedHosts: 32 } as const
const unchanged = { stateChanged: false }
const invalid = (field: string, message: string): never => fail('VALIDATION', message, { ...unchanged, fields: [{ field, code: 'invalid' }] })
export const DEFAULT_PANEL_SETTINGS = (): PanelSettingsFields => ({ offlineMode: false, offlineMessage: '', developerMode: false, liveUpdates: true, reverseProxyAllowedHosts: [] })

const allowedHost = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 253) return invalid('reverseProxyAllowedHosts', 'each allowed host is an IP address or a host name')
  const host = value.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1')
  if (isIP(host)) return host
  try { return validateDomainName(host) } catch { return invalid('reverseProxyAllowedHosts', 'each allowed host is an IP address or a host name') }
}

export function parsePanelSettingsFields(value: Record<string, unknown>): PanelSettingsFields {
  for (const key of ['offlineMode', 'developerMode', 'liveUpdates'] as const) if (typeof value[key] !== 'boolean') invalid(key, `${key} must be true or false`)
  const message = value.offlineMessage
  if (typeof message !== 'string' || message.length > PANEL_SETTINGS_LIMITS.offlineMessage || !message.isWellFormed() || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(message) || message.trim() !== message) {
    return invalid('offlineMessage', `the offline message is plain text of at most ${PANEL_SETTINGS_LIMITS.offlineMessage} characters`)
  }
  const hosts = value.reverseProxyAllowedHosts
  if (!Array.isArray(hosts) || hosts.length > PANEL_SETTINGS_LIMITS.allowedHosts) return invalid('reverseProxyAllowedHosts', `at most ${PANEL_SETTINGS_LIMITS.allowedHosts} allowed hosts`)
  const normalized = hosts.map(allowedHost)
  if (new Set(normalized).size !== normalized.length) return invalid('reverseProxyAllowedHosts', 'each allowed host is listed once')
  return { offlineMode: value.offlineMode as boolean, offlineMessage: message, developerMode: value.developerMode as boolean, liveUpdates: value.liveUpdates as boolean, reverseProxyAllowedHosts: normalized }
}

const parseRecord = (raw: unknown): PanelSettingsFields | null => {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const record = raw as Record<string, unknown>
    if (!exactKeys(record, [...FIELDS, 'version', 'updatedAt']) || record.version !== 1 || typeof record.updatedAt !== 'string'
      || !Number.isFinite(Date.parse(record.updatedAt)) || new Date(record.updatedAt).toISOString() !== record.updatedAt) return null
    return parsePanelSettingsFields(record)
  } catch { return null }
}

export const panelSettingsFile = (store: Pick<StateStore, 'rootDir' | 'getWriterLock'>): PanelConfigFile<PanelSettingsFields> =>
  panelConfigFile(store, 'settings.json', NAMESPACE, parseRecord, DEFAULT_PANEL_SETTINGS)

const viewOf = (raw: unknown, value: PanelSettingsFields | null): PanelSettingsView => ({
  state: raw === null ? 'default' : value ? 'saved' : 'invalid',
  settings: value,
  updatedAt: value && raw !== null ? (raw as { updatedAt: string }).updatedAt : null,
  revision: panelConfigRevision(NAMESPACE, raw),
})

export interface PanelSettingsHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  store: Pick<StateStore, 'rootDir' | 'getWriterLock'>
  now?: () => Date
}

/** Root reads and changes the panel settings; the change is revision-bound and read back before it is acknowledged. */
export async function handlePanelSettingsRoute(request: Request, url: URL, method: string, helpers: PanelSettingsHelpers): Promise<Response | null> {
  if (url.pathname !== ROUTE) return null
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, 'panel.settings')
  if (method !== 'GET' && method !== 'PUT') return new Response(null, { status: 405, headers: { allow: 'GET, PUT' } })
  if (url.search) return fail('VALIDATION', 'panel settings accept no query selectors', unchanged)
  const file = panelSettingsFile(helpers.store)
  if (method === 'GET') { const { raw, value } = await file.read(); return panelJson(viewOf(raw, value)) }
  const body = await readPanelConfigBody(request)
  if (!exactKeys(body, [...FIELDS, 'expectedRevision'])) return fail('VALIDATION', `exactly ${FIELDS.join(', ')} and expectedRevision are required`, unchanged)
  const expected = assertExpectedRevision(body.expectedRevision)
  const fields = parsePanelSettingsFields(body)
  const next: PanelSettingsRecord = { version: 1, ...fields, updatedAt: (helpers.now ?? (() => new Date()))().toISOString() }
  const saved = await file.write(next, expected, async () => { await helpers.assertRoot(await helpers.requireCaller(request), 'panel.settings') })
  try {
    await helpers.emitAudit({ actor: caller.principal.username, action: 'panel.settings.updated', target: 'panel-settings', outcome: 'ok', principalId: caller.principal.id,
      detail: { offlineMode: fields.offlineMode, developerMode: fields.developerMode, liveUpdates: fields.liveUpdates, reverseProxyAllowedHosts: fields.reverseProxyAllowedHosts.length } })
  } catch { return fail('SERVICE_UNAVAILABLE', 'settings were saved but their audit record requires review; reload before retrying', { stateChanged: true, verificationRequired: true }) }
  return panelJson(viewOf(saved.raw, saved.value))
}

/** API paths a non-root session keeps while the panels are offline: who am I, sign out, and sign-in itself. */
export const panelOfflineAdmits = (pathname: string, principalKind: string): boolean =>
  principalKind === 'root' || pathname === '/api/auth/me' || pathname === '/api/auth/logout'
