import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fail, isXpanelError } from '@xpanel/core'
import { isApplicationId } from '../../../packages/os/src/application-artifact.ts'
import type { VerifiedApplicationCatalog } from './application-catalog.ts'
import type { SwApplicationCatalogSource } from './sw-application-catalog-store.ts'
import type { StoredApplicationArtifacts } from './application-provider.ts'

/**
 * WHM Site Software catalog. The signed catalog is the set of applications the release publisher vouches for;
 * root then decides which of them this server offers (extended/panel/site-software.json, nothing until chosen).
 * Users see and install only offered applications; removing and rolling back stay possible after an application
 * leaves the offer.
 */
export const SITE_SOFTWARE_STATE_PATH = 'extended/panel/site-software.json'
export const SITE_SOFTWARE_MAX_OFFERED = 64
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const unchanged = { stateChanged: false }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

export const parseOfferedIds = (value: unknown): string[] | null => Array.isArray(value) && value.length <= SITE_SOFTWARE_MAX_OFFERED && value.every(isApplicationId)
  && new Set(value).size === value.length ? [...value as string[]].sort() : null
/** The saved record {version,offered,updatedAt}; null when it fails its grammar. */
export function parseSiteSoftwareOffer(raw: unknown): string[] | null {
  if (!object(raw) || Object.keys(raw).sort().join() !== 'offered,updatedAt,version' || raw.version !== 1 || typeof raw.updatedAt !== 'string' || !STAMP.test(raw.updatedAt)) return null
  const offered = parseOfferedIds(raw.offered)
  return offered && offered.join() === (raw.offered as string[]).join() ? offered : null
}
/** Missing means nothing is offered yet; null means the saved offer cannot be verified, which also offers nothing. */
export async function readSiteSoftwareOffer(rootDir: string): Promise<string[] | null> {
  let text: string
  try { text = await readFile(join(rootDir, SITE_SOFTWARE_STATE_PATH), 'utf8') } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null }
  try { return parseSiteSoftwareOffer(JSON.parse(text)) } catch { return null }
}

export interface SiteSoftwareCatalogView {
  trust: { state: 'configured' | 'missing' | 'invalid'; keyIds: string[]; reason: string | null }
  catalog: { state: 'read' | 'unavailable'; reason: string | null; keyId: string | null; sequence: number | null; issuedAt: string | null; expiresAt: string | null; revision: string | null; applications: { id: string; name: string; versions: string[]; stored: string[] }[] }
}
const summary = async (catalog: VerifiedApplicationCatalog, artifacts: StoredApplicationArtifacts | null): Promise<SiteSoftwareCatalogView['catalog']> => ({ state: 'read', reason: null, keyId: catalog.keyId, sequence: catalog.sequence, issuedAt: catalog.issuedAt, expiresAt: catalog.expiresAt,
  revision: catalog.revision, applications: await Promise.all(catalog.applications.map(async app => ({ id: app.id, name: app.name, versions: app.releases.map(release => release.version),
    stored: (await Promise.all(app.releases.map(async release => await artifacts?.has(release.artifact.sha256) ? release.version : null))).filter((version): version is string => version !== null) }))) })
const unread = (reason: string): SiteSoftwareCatalogView['catalog'] => ({ state: 'unavailable', reason, keyId: null, sequence: null, issuedAt: null, expiresAt: null, revision: null, applications: [] })
const reasonOf = (error: unknown): string => !isXpanelError(error) ? 'application_catalog_unverified' : typeof error.detail.reason === 'string' ? error.detail.reason
  : error.code === 'FORBIDDEN' ? 'catalog_signer_untrusted' : error.code === 'VALIDATION' ? 'catalog_invalid' : 'application_catalog_unverified'

export async function readSiteSoftwareCatalog(source: SwApplicationCatalogSource | null, artifacts: StoredApplicationArtifacts | null = null): Promise<SiteSoftwareCatalogView> {
  if (!source) return { trust: { state: 'missing', keyIds: [], reason: 'installed_release_unavailable' }, catalog: unread('installed_release_unavailable') }
  const trust = await source.trust()
  const view: SiteSoftwareCatalogView = { trust: { state: trust.state, keyIds: trust.keys.map(key => key.keyId), reason: trust.reason }, catalog: unread('application_catalog_unavailable') }
  try { view.catalog = await summary(await source.catalog(), artifacts) } catch (error) { view.catalog = unread(reasonOf(error)) }
  return view
}

export interface SiteSoftwareRouteContext {
  /** Fresh caller identity on every call; root only. */
  authenticate(): Promise<{ actor: string; role: string }>
  source: SwApplicationCatalogSource | null
  artifacts?: StoredApplicationArtifacts | null
  audit(entry: { action: string; target: string; outcome: 'ok' | 'failed'; detail: Record<string, unknown> }): Promise<unknown>
}
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

/** GET /host/site-software reads trust and the verified catalog; POST /host/site-software/import stores a verified envelope. */
export async function handleSiteSoftwareHostRoute(req: Request, url: URL, method: string, ctx: SiteSoftwareRouteContext): Promise<Response | null> {
  if (url.pathname !== '/host/site-software' && url.pathname !== '/host/site-software/import') return null
  const expected = url.pathname === '/host/site-software' ? 'GET' : 'POST'
  if (method !== expected) return new Response(null, { status: 405, headers: { allow: expected } })
  if (url.search) return fail('VALIDATION', 'site software routes accept no query selectors', unchanged)
  if ((await ctx.authenticate()).role !== 'root') return fail('FORBIDDEN', 'root role is required for the site software catalog', unchanged)
  if (expected === 'GET') return json(await readSiteSoftwareCatalog(ctx.source, ctx.artifacts ?? null))
  const text = await req.text()
  let body: unknown
  try { body = text.length <= 2 * 1024 * 1024 ? JSON.parse(text) : null } catch { body = null }
  if (!object(body) || Object.keys(body).join() !== 'envelope' || typeof body.envelope !== 'string') return fail('VALIDATION', 'exactly one signed catalog envelope is required', unchanged)
  if (!ctx.source) return fail('PRECONDITION_FAILED', 'the signed catalog needs an installed release', { ...unchanged, reason: 'installed_release_unavailable' })
  let imported: VerifiedApplicationCatalog
  // A refused catalog is a verification result with its reason, not a transport failure.
  try { imported = await ctx.source.import(body.envelope) }
  catch (error) {
    if (!isXpanelError(error) || error.detail.stateChanged !== false) throw error
    const reason = reasonOf(error)
    await ctx.audit({ action: 'server.site_software.catalog_imported', target: 'site-software:catalog', outcome: 'failed', detail: { reason } }).catch(() => undefined)
    return json({ outcome: 'refused', reason, ...await readSiteSoftwareCatalog(ctx.source, ctx.artifacts ?? null) })
  }
  await ctx.audit({ action: 'server.site_software.catalog_imported', target: 'site-software:catalog', outcome: 'ok', detail: { keyId: imported.keyId, sequence: imported.sequence, revision: imported.revision, applications: imported.applications.length } })
  return json({ outcome: 'imported', reason: null, ...await readSiteSoftwareCatalog(ctx.source, ctx.artifacts ?? null) })
}
