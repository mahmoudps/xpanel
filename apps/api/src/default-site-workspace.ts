import { createHmac } from 'node:crypto'
import { isIP } from 'node:net'
import { fail, isXpanelError, validateDefaultSitePolicy, validateServerSettings } from '@xpanel/core'
import type { DefaultSitePolicy, ServerSettings } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import type { DefaultSiteObservation } from '../../agent/src/default-site-observation.ts'

type AuditInput = Parameters<ExtendedRouteHelpers['emitAudit']>[0]
export interface DefaultSiteWorkspaceHelpers {
  store: Pick<StateStore, 'getServerSettings' | 'getRevision' | 'saveServerSettings'>
  serverSecret: string
  requireCaller: (req: Request, options?: { deferDeniedAudit?: (input: AuditInput) => void }) => Promise<AuthenticatedCaller>
  assertRoot: ExtendedRouteHelpers['assertRoot']
  emitAudit: ExtendedRouteHelpers['emitAudit']
  /** Must preserve actual catalog/native admission; a saved policy never grants qualification. */
  assertMutationQualified: (caller: AuthenticatedCaller) => Promise<void>
  /** Trusted root agent request to its fixed log reader, never a caller-selected path. */
  observeRequests?: (caller: AuthenticatedCaller) => Promise<unknown>
  /** Validates the real global apply acknowledgement, bound to this authority revision. */
  applyConfiguration?: (caller: AuthenticatedCaller, expectedRevision: number) => Promise<{ status: 'global_configuration_applied'; targetVerified: false }>
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const hexRevision = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const noControls = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && value.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/.test(value)
const json = (value: unknown) => Response.json(value, { headers: { 'cache-control': 'no-store' } })
const unknownOutcome = (): never => fail('SERVICE_UNAVAILABLE', 'default-site configuration requires verification', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
const readBoundedBody = async (req: Request): Promise<string> => {
  if (!req.body) return fail('VALIDATION', 'default-site JSON body is required', { stateChanged: false })
  const reader = req.body.getReader(), parts: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      total += result.value.byteLength
      if (total > 8192) { await reader.cancel(); return fail('VALIDATION', 'default-site request exceeds its bound', { stateChanged: false }) }
      parts.push(result.value)
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)) }
    catch { return fail('VALIDATION', 'default-site request must be valid UTF-8 JSON', { stateChanged: false }) }
  } finally { reader.releaseLock() }
}

export function projectDefaultSiteObservation(raw: unknown): DefaultSiteObservation {
  if (!object(raw) || !['read', 'partial', 'unavailable'].includes(String(raw.state)) || raw.source !== 'nginx-default-access-log' || raw.limit !== 100
    || typeof raw.observedAt !== 'string' || raw.observedAt.length > 40 || !Number.isFinite(Date.parse(raw.observedAt)) || typeof raw.truncated !== 'boolean'
    || !Number.isSafeInteger(raw.malformedRecords) || Number(raw.malformedRecords) < 0 || Number(raw.malformedRecords) > 262144 || !Array.isArray(raw.items) || raw.items.length > 100) return fail('PRECONDITION_FAILED', 'default-site host observation could not be verified', { stateChanged: false, verificationRequired: true })
  if (raw.state === 'unavailable' && (raw.items.length || raw.malformedRecords !== 0 || raw.reason !== 'default_log_unavailable')) return fail('PRECONDITION_FAILED', 'invalid unavailable default-site observation')
  if (raw.state === 'read' && raw.malformedRecords !== 0 || raw.state === 'partial' && raw.malformedRecords === 0) return fail('PRECONDITION_FAILED', 'inconsistent default-site observation state')
  const items = raw.items.map(entry => {
    if (!object(entry) || typeof entry.at !== 'string' || entry.at.length > 40 || !Number.isFinite(Date.parse(entry.at)) || !noControls(entry.host, 1024) || !entry.host
      || !noControls(entry.address, 64) || !isIP(entry.address) || !Number.isInteger(entry.status) || Number(entry.status) < 100 || Number(entry.status) > 599) return fail('PRECONDITION_FAILED', 'invalid default-site request observation')
    return { at: new Date(entry.at).toISOString(), host: entry.host, address: entry.address, status: Number(entry.status) }
  })
  return { state: raw.state as DefaultSiteObservation['state'], source: 'nginx-default-access-log', observedAt: new Date(raw.observedAt).toISOString(), items, limit: 100, truncated: raw.truncated, malformedRecords: Number(raw.malformedRecords), ...(raw.state === 'unavailable' ? { reason: 'default_log_unavailable' as const } : {}) }
}

export function createDefaultSiteWorkspaceRoutes(helpers: DefaultSiteWorkspaceHelpers): (req: Request, url: URL, method: string) => Promise<Response | null> {
  const revision = (settings: ServerSettings) => createHmac('sha256', helpers.serverSecret).update('xpanel-default-site-view:v1\0').update(JSON.stringify(validateServerSettings(settings))).digest('hex')
  const capture = async () => {
    const before = await helpers.store.getRevision(), settings = await helpers.store.getServerSettings(), after = await helpers.store.getRevision()
    if (before !== after) return fail('CONFLICT', 'server configuration changed during read; explicitly reload', { stateChanged: false })
    if (!settings) return fail('PRECONDITION_FAILED', 'saved server settings have not been read', { stateChanged: false })
    return { settings, authorityRevision: after, revision: revision(settings) }
  }
  const configuration = (saved: Awaited<ReturnType<typeof capture>>) => ({ state: 'read' as const, source: 'saved-server-settings' as const,
    policy: saved.settings.defaultSite ?? { response: 'reject' as const, redirectTo: null, refuseHttps: false }, explicitPolicy: saved.settings.defaultSite !== undefined, revision: saved.revision })
  const root = async (req: Request, action: string, original?: AuthenticatedCaller, deferred?: AuditInput[]) => {
    const caller = await helpers.requireCaller(req, deferred ? { deferDeniedAudit: input => { deferred.push(input) } } : undefined)
    if (caller.principal.kind !== 'root' || original && (caller.principal.id !== original.principal.id || caller.principal.kind !== original.principal.kind)) return fail('FORBIDDEN', 'the current root administrator is required', { stateChanged: false })
    await helpers.assertRoot(caller, action)
    return caller
  }
  return async (req, url, method) => {
    if (!['/api/server/default-site', '/api/server/default-site/requests'].includes(url.pathname)) return null
    const requests = url.pathname.endsWith('/requests')
    const caller = await root(req, method === 'PUT' ? 'server.default_site.update' : 'server.default_site.read')
    if (url.searchParams.size) return fail('VALIDATION', 'default-site operations accept no account, path, command or paging selectors', { stateChanged: false })
    if (requests) {
      if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
      if (!helpers.observeRequests) return json({ observation: { state: 'unavailable', observedAt: new Date().toISOString(), source: 'nginx-default-access-log', items: [], limit: 100, truncated: false, malformedRecords: 0, reason: 'default_log_unavailable' } })
      const observation = projectDefaultSiteObservation(await helpers.observeRequests(caller))
      await root(req, 'server.default_site.read', caller)
      return json({ observation })
    }
    if (method === 'GET') {
      const saved = await capture()
      let qualified = false
      try { await helpers.assertMutationQualified(caller); qualified = true } catch { /* A readable configuration is not native mutation qualification. */ }
      return json({ configuration: configuration(saved), actions: { save: qualified }, application: { status: 'unverified', targetVerified: false } })
    }
    if (method !== 'PUT') return new Response(null, { status: 405, headers: { allow: 'GET, PUT' } })
    if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', { stateChanged: false })
    const bytes = await readBoundedBody(req)
    let raw: unknown
    try { raw = JSON.parse(bytes) } catch { return fail('VALIDATION', 'default-site request is not valid JSON', { stateChanged: false }) }
    if (!object(raw) || Object.keys(raw).some(key => !['policy', 'expectedRevision'].includes(key)) || !hexRevision(raw.expectedRevision)) return fail('VALIDATION', 'default-site policy and saved revision are required', { stateChanged: false })
    const policy: DefaultSitePolicy = validateDefaultSitePolicy(raw.policy), expectedRevision = raw.expectedRevision
    const current = await capture()
    if (current.revision !== expectedRevision) return fail('CONFLICT', 'default-site configuration changed; explicitly reload before retrying', { stateChanged: false })
    await helpers.assertMutationQualified(caller)
    const deferred: AuditInput[] = []
    let writeAuthorized = false, committed = false, freshCaller = caller
    try {
      try {
        await helpers.store.saveServerSettings({ ...current.settings, defaultSite: policy }, { expectedRevision: current.authorityRevision, settingsGuard: async source => {
          freshCaller = await root(req, 'server.default_site.update', caller, deferred)
          await helpers.assertMutationQualified(freshCaller)
          if (!source || revision(source) !== expectedRevision) return fail('CONFLICT', 'default-site configuration changed under the writer lease', { stateChanged: false })
          writeAuthorized = true
        } })
        committed = true
      } finally { for (const audit of deferred) await helpers.emitAudit(audit) }
      const saved = await capture()
      if (JSON.stringify(saved.settings.defaultSite) !== JSON.stringify(policy)) return unknownOutcome()
      freshCaller = await root(req, 'server.default_site.update', caller)
      let application: { status: 'not_requested' | 'global_configuration_applied'; targetVerified: false } = { status: 'not_requested', targetVerified: false }
      if (helpers.applyConfiguration) {
        await helpers.assertMutationQualified(freshCaller)
        const applied = await helpers.applyConfiguration(freshCaller, saved.authorityRevision)
        if (!object(applied) || applied.status !== 'global_configuration_applied' || applied.targetVerified !== false) return unknownOutcome()
        application = { status: 'global_configuration_applied', targetVerified: false }
      }
      await helpers.emitAudit({ actor: freshCaller.principal.username, action: 'server.default_site.updated', target: 'server:default-site', detail: { response: policy.response, refuseHttps: policy.refuseHttps }, outcome: 'ok', principalId: freshCaller.principal.id })
      return json({ configuration: configuration(saved), stateChanged: true, application })
    } catch (error) {
      if (!writeAuthorized || !committed && isXpanelError(error) && error.detail?.stateChanged === false) throw error
      return unknownOutcome()
    }
  }
}
