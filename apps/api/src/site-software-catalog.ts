import { fail } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { assertExpectedRevision, exactKeys, panelConfigFile, panelConfigRevision, panelJson, readLimitedBody, readPanelConfigBody } from './panel-config-file.ts'
import type { PanelConfigFile } from './panel-config-file.ts'
import { SITE_SOFTWARE_MAX_OFFERED, parseOfferedIds, parseSiteSoftwareOffer } from '../../agent/src/site-software.ts'
import type { SiteSoftwareCatalogView } from '../../agent/src/site-software.ts'

/** Root's offer over the signed catalog plus the import of a new signed envelope (verified by the agent first). */
export interface SiteSoftwareHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  store: Pick<StateStore, 'rootDir' | 'getWriterLock'>
  callHost?: (caller: AuthenticatedCaller, path: string, body?: unknown) => Promise<unknown>
  now?: () => Date
}
export interface SiteSoftwareView {
  host: SiteSoftwareCatalogView | null
  offer: { state: 'default' | 'saved' | 'invalid'; offered: string[] | null; updatedAt: string | null; revision: string }
  import?: { outcome: 'imported' | 'refused'; reason: string | null }
}
const NAMESPACE = 'site-software:v1'
const ROUTES = ['/api/server/site-software', '/api/server/site-software/catalog']
const unchanged = { stateChanged: false }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export const siteSoftwareFile = (store: Pick<StateStore, 'rootDir' | 'getWriterLock'>): PanelConfigFile<string[]> => panelConfigFile(store, 'site-software.json', NAMESPACE, parseSiteSoftwareOffer, () => [])

const text = (value: unknown, max: number): value is string | null => value === null || typeof value === 'string' && value.length <= max && /^[A-Za-z0-9 ._:+-]*$/.test(value)
/** The agent reply is re-checked field by field; anything else reads as unavailable. */
export function readSiteSoftwareHost(value: unknown): SiteSoftwareCatalogView | null {
  if (!object(value) || !object(value.trust) || !object(value.catalog)) return null
  const trust = value.trust, catalog = value.catalog
  if (!['configured', 'missing', 'invalid'].includes(String(trust.state)) || !Array.isArray(trust.keyIds) || trust.keyIds.length > 8 || !trust.keyIds.every(id => typeof id === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(id)) || !text(trust.reason, 64)) return null
  if (!['read', 'unavailable'].includes(String(catalog.state)) || !text(catalog.reason, 64) || !text(catalog.keyId, 64) || !(catalog.sequence === null || Number.isSafeInteger(catalog.sequence))
    || !text(catalog.issuedAt, 32) || !text(catalog.expiresAt, 32) || !(catalog.revision === null || typeof catalog.revision === 'string' && /^[0-9a-f]{64}$/.test(catalog.revision))
    || !Array.isArray(catalog.applications) || catalog.applications.length > 64) return null
  const applications = catalog.applications.map(app => object(app) && typeof app.id === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(app.id) && typeof app.name === 'string' && app.name.length <= 120
    && Array.isArray(app.versions) && app.versions.length <= 8 && app.versions.every(version => typeof version === 'string' && /^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$/.test(version)) && Array.isArray(app.stored) && app.stored.every(version => (app.versions as unknown[]).includes(version)) ? { id: app.id, name: app.name, versions: [...app.versions as string[]], stored: [...app.stored as string[]] } : null)
  if (applications.some(app => app === null)) return null
  return { trust: { state: trust.state as SiteSoftwareCatalogView['trust']['state'], keyIds: [...trust.keyIds as string[]], reason: trust.reason as string | null },
    catalog: { state: catalog.state as 'read' | 'unavailable', reason: catalog.reason as string | null, keyId: catalog.keyId as string | null, sequence: catalog.sequence as number | null, issuedAt: catalog.issuedAt as string | null,
      expiresAt: catalog.expiresAt as string | null, revision: catalog.revision as string | null, applications: applications as SiteSoftwareCatalogView['catalog']['applications'] } }
}

export async function handleSiteSoftwareRoute(request: Request, url: URL, method: string, helpers: SiteSoftwareHelpers): Promise<Response | null> {
  if (!ROUTES.includes(url.pathname)) return null
  const importing = url.pathname.endsWith('/catalog')
  const action = method === 'GET' ? 'server.site_software.read' : 'server.site_software.update'
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  const allow = importing ? 'POST' : 'GET, PUT'
  if (!allow.split(', ').includes(method)) return new Response(null, { status: 405, headers: { allow } })
  if (url.search) return fail('VALIDATION', 'site software accepts no query selectors', unchanged)
  const file = siteSoftwareFile(helpers.store)
  const host = async (): Promise<SiteSoftwareCatalogView | null> => { if (!helpers.callHost) return null; try { return readSiteSoftwareHost(await helpers.callHost(caller, '/host/site-software')) } catch { return null } }
  const view = async (raw: unknown, value: string[] | null, hostView: SiteSoftwareCatalogView | null): Promise<SiteSoftwareView> => ({ host: hostView,
    offer: { state: raw === null ? 'default' : value ? 'saved' : 'invalid', offered: value, updatedAt: value && raw !== null ? (raw as { updatedAt: string }).updatedAt : null, revision: panelConfigRevision(NAMESPACE, raw) } })
  if (method === 'GET') { const { raw, value } = await file.read(); return panelJson(await view(raw, value, await host())) }
  if (importing) {
    if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', unchanged)
    let body: unknown
    try { body = JSON.parse(Buffer.from(await readLimitedBody(request, 1024 * 1024 + 4096)).toString('utf8')) } catch (error) { if (error instanceof Error && 'code' in error) throw error; return fail('VALIDATION', 'request body is not valid JSON', unchanged) }
    if (!object(body) || !exactKeys(body, ['envelope']) || typeof body.envelope !== 'string') return fail('VALIDATION', 'exactly one signed catalog envelope is required', unchanged)
    if (!helpers.callHost) return fail('PRECONDITION_FAILED', 'importing a signed catalog needs the host agent', { ...unchanged, reason: 'host_agent_unavailable' })
    const reply = await helpers.callHost(caller, '/host/site-software/import', { envelope: body.envelope })
    const hostView = readSiteSoftwareHost(reply), outcome = object(reply) ? reply.outcome : null
    if (!hostView || (outcome !== 'imported' && outcome !== 'refused') || !text((reply as Record<string, unknown>).reason, 64)) return fail('SERVICE_UNAVAILABLE', 'the catalog import could not be verified; reload before retrying', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
    const { raw, value } = await file.read()
    return panelJson({ ...await view(raw, value, hostView), import: { outcome, reason: (reply as Record<string, unknown>).reason as string | null } })
  }
  const body = await readPanelConfigBody(request)
  if (!exactKeys(body, ['offered', 'expectedRevision'])) return fail('VALIDATION', 'exactly offered and expectedRevision are required', unchanged)
  const expected = assertExpectedRevision(body.expectedRevision), offered = parseOfferedIds(body.offered)
  if (!offered) return fail('VALIDATION', `offered lists at most ${SITE_SOFTWARE_MAX_OFFERED} distinct application ids`, unchanged)
  const current = await host()
  // Only applications of the verified signed catalog can be offered; withdrawing never needs the catalog.
  const before = (await file.read()).value ?? []
  const added = offered.filter(id => !before.includes(id))
  if (added.length && (current?.catalog.state !== 'read' || added.some(id => !current.catalog.applications.some(app => app.id === id)))) return fail('PRECONDITION_FAILED', 'only applications of the verified signed catalog can be offered', { ...unchanged, reason: 'application_not_in_catalog' })
  const saved = await file.write({ version: 1, offered, updatedAt: (helpers.now ?? (() => new Date()))().toISOString() } as unknown as string[], expected, async () => { const fresh = await helpers.requireCaller(request); await helpers.assertRoot(fresh, action) })
  try {
    await helpers.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action: 'server.site_software.updated', target: 'site-software', outcome: 'ok',
      detail: { added, removed: before.filter(id => !offered.includes(id)), offered: offered.length } })
  } catch { return fail('SERVICE_UNAVAILABLE', 'the offer was saved but its audit record requires review; reload before retrying', { stateChanged: true, verificationRequired: true }) }
  return panelJson(await view(saved.raw, saved.value, current))
}
