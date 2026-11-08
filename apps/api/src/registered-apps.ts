import { lstat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tools } from '@xpanel/catalog'
import { RESELLER_ACLS, fail } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { exactKeys, panelJson } from './panel-config-file.ts'

/**
 * WHM Apps Managed by AppConfig: applications registered with the panel. A registration is one JSON file in
 * extended/panel/apps/ placed there by root; removing the file removes the registration. The list is
 * read on request and never executes or fetches anything. Built-in surfaces are listed with origin "internal".
 */
export type AppSurface = 'xwhm' | 'xpanel' | 'xmail'
export interface RegisteredApp {
  origin: string; state: 'registered' | 'invalid'; name: string; displayName: string | null; surface: AppSurface | null
  entryUrl: string | null; acls: string[]; features: string[]; description: string; reason: string | null
}
export interface RegisteredAppsView { directory: string; truncated: boolean; apps: RegisteredApp[] }
export interface RegisteredAppsHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot'> { store: Pick<StateStore, 'rootDir'> }

export const REGISTERED_APPS_DIRECTORY = 'extended/panel/apps'
export const REGISTERED_APPS_LIMITS = Object.freeze({ files: 128, bytes: 16 * 1024 })
const FILE = /^([a-z0-9][a-z0-9_-]{0,63})\.json$/
const SURFACES: readonly AppSurface[] = ['xwhm', 'xpanel', 'xmail']
const ACLS = new Set<string>(['all', ...RESELLER_ACLS])
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const plain = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && value.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
const INTERNAL: RegisteredApp[] = [['xwhm', 'xWHM', '/whm'], ['xpanel', 'xPanel', '/panel'], ['xmail', 'xMail', '/mail']].map(([surface, displayName, entryUrl]) => ({
  origin: 'internal', state: 'registered', name: surface!, displayName: displayName!, surface: surface as AppSurface, entryUrl: entryUrl!, acls: [], features: [], description: '', reason: null,
}))

export const httpsUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 2048) return false
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && url.href === value } catch { return false }
}

/** Strict registration grammar; an invalid file stays listed with its reason instead of disappearing. */
export function parseRegisteredApp(name: string, raw: unknown): RegisteredApp {
  const invalid = (reason: string): RegisteredApp => ({ origin: name + '.json', state: 'invalid', name, displayName: null, surface: null, entryUrl: null, acls: [], features: [], description: '', reason })
  if (!object(raw) || !exactKeys(raw, ['name', 'displayName', 'surface', 'url', 'acls', 'features', 'description'])) return invalid('registration_keys')
  if (raw.name !== name) return invalid('registration_name')
  if (!plain(raw.displayName, 80) || !raw.displayName.trim() || !plain(raw.description, 280)) return invalid('registration_text')
  if (!SURFACES.includes(raw.surface as AppSurface)) return invalid('registration_surface')
  if (!httpsUrl(raw.url)) return invalid('registration_url')
  const surface = raw.surface as AppSurface, acls = raw.acls, features = raw.features
  if (!Array.isArray(acls) || !Array.isArray(features) || new Set(acls).size !== acls.length || new Set(features).size !== features.length) return invalid('registration_privileges')
  // Administrator applications require reseller privileges (or all, meaning root); user and webmail applications require plan features.
  if (surface === 'xwhm' ? !acls.length || !acls.every(acl => typeof acl === 'string' && ACLS.has(acl)) || features.length > 0
    : acls.length > 0 || !features.every(id => typeof id === 'string' && tools.some(tool => tool.id === id && tool.surface === surface))) return invalid('registration_privileges')
  return { origin: name + '.json', state: 'registered', name, displayName: raw.displayName, surface, entryUrl: raw.url, acls: [...acls as string[]].sort(), features: [...features as string[]].sort(), description: raw.description, reason: null }
}

export async function readRegisteredApps(rootDir: string): Promise<RegisteredAppsView> {
  const directory = join(rootDir, REGISTERED_APPS_DIRECTORY)
  let names: string[]
  try { names = (await readdir(directory)).sort() }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') names = []; else return fail('PRECONDITION_FAILED', 'the application registry cannot be read', { stateChanged: false }) }
  const files = names.filter(entry => entry.endsWith('.json'))
  const apps: RegisteredApp[] = [...INTERNAL]
  for (const entry of files.slice(0, REGISTERED_APPS_LIMITS.files)) {
    const match = FILE.exec(entry)
    if (!match) { apps.push({ ...parseRegisteredApp(entry.slice(0, 64), null), origin: entry.slice(0, 80), reason: 'registration_file_name' }); continue }
    const name = match[1]!, path = join(directory, entry)
    let raw: unknown = null, reason: string | null = null
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.nlink !== 1 || info.size > REGISTERED_APPS_LIMITS.bytes) reason = 'registration_file'
      else raw = JSON.parse(await readFile(path, 'utf8'))
    } catch { reason = 'registration_unreadable' }
    const app = reason ? { ...parseRegisteredApp(name, null), reason } : parseRegisteredApp(name, raw)
    if (app.state === 'registered' && apps.some(other => other.state === 'registered' && other.name === app.name)) apps.push({ ...parseRegisteredApp(name, null), reason: 'registration_duplicate' })
    else apps.push(app)
  }
  return { directory: REGISTERED_APPS_DIRECTORY, truncated: files.length > REGISTERED_APPS_LIMITS.files, apps }
}

/** Read-only, root only: GET /api/server/registered-apps. */
export async function handleRegisteredAppsRoute(request: Request, url: URL, method: string, helpers: RegisteredAppsHelpers): Promise<Response | null> {
  if (url.pathname !== '/api/server/registered-apps') return null
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, 'server.registered_apps.read')
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  if (url.search) return fail('VALIDATION', 'the application registry accepts no query selectors', { stateChanged: false })
  return panelJson(await readRegisteredApps(helpers.store.rootDir))
}
