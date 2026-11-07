import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fail } from '@xpanel/core'
import { atomicRemove, atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { exactKeys, panelJson, readLimitedBody } from './panel-config-file.ts'
import { THEME_PACKAGE_LIMITS, builtInUiTheme, cloneThemePackage, installThemePackage, parseThemePackage, registeredUiThemeIds, removeUiThemePackage } from '../../web/src/index.ts'
import type { UiThemePackage } from '../../web/src/index.ts'

/**
 * WHM Theme Manager: root installs, clones, downloads and deletes uploaded theme packages. Each package is one file,
 * extended/panel/themes/<id>.json, holding the validated package; it is installed in the running panel at once and
 * again at every panel start. Built-in themes cannot be replaced, downloaded or deleted.
 */
export interface ThemePackagesHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  store: Pick<StateStore, 'rootDir' | 'getWriterLock'>
  now?: () => Date
}
interface ThemeRecord { version: 1; package: UiThemePackage; sha256: string; installedAt: string; installedBy: string }
export interface ThemeRow { id: string; name: string | null; version: string | null; base: string | null; builtIn: boolean; state: 'installed' | 'invalid'; sha256: string | null; installedAt: string | null; installedBy: string | null }

const DIRECTORY = 'extended/panel/themes'
const ROUTE = /^\/api\/server\/themes(?:\/([a-z][a-z0-9-]{1,31})(?:\/(clone|package))?)?$/
const FILE = /^([a-z][a-z0-9-]{1,31})\.json$/
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const unchanged = { stateChanged: false }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const digest = (pkg: UiThemePackage): string => createHash('sha256').update(JSON.stringify(pkg)).digest('hex')
const pathOf = (rootDir: string, id: string): string => join(rootDir, DIRECTORY, id + '.json')

function readRecord(id: string, raw: unknown): ThemeRecord | null {
  if (!object(raw) || !exactKeys(raw, ['version', 'package', 'sha256', 'installedAt', 'installedBy']) || raw.version !== 1 || typeof raw.installedAt !== 'string' || !STAMP.test(raw.installedAt)
    || typeof raw.installedBy !== 'string' || !/^[A-Za-z0-9_.@-]{1,64}$/.test(raw.installedBy)) return null
  try {
    const pkg = parseThemePackage(raw.package)
    return pkg.id === id && raw.sha256 === digest(pkg) ? { version: 1, package: pkg, sha256: raw.sha256, installedAt: raw.installedAt, installedBy: raw.installedBy } : null
  } catch { return null }
}
async function readRecords(rootDir: string): Promise<{ id: string; record: ThemeRecord | null }[]> {
  let names: string[]
  try { names = (await readdir(join(rootDir, DIRECTORY))).sort() } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; return fail('PRECONDITION_FAILED', 'the installed theme packages cannot be read', unchanged) }
  const rows: { id: string; record: ThemeRecord | null }[] = []
  for (const name of names.slice(0, THEME_PACKAGE_LIMITS.packages * 2)) {
    const id = FILE.exec(name)?.[1]
    if (!id) continue
    let raw: unknown = null
    try { raw = await readJsonIfExists<unknown>(pathOf(rootDir, id)) } catch { raw = null }
    rows.push({ id, record: readRecord(id, raw) })
  }
  return rows
}

/** Root sees one document in an installed theme; a preview saves nothing, and any other caller or id keeps its own theme. */
export const withThemePreview = <T extends { visibility?: { principal?: { kind?: string } | undefined } | undefined }>(url: URL, state: T): T | T & { themePreview: string } => {
  const id = url.searchParams.get('previewTheme')
  return id !== null && state.visibility?.principal?.kind === 'root' && registeredUiThemeIds().includes(id) ? { ...state, themePreview: id } : state
}

/** Panel start: installs every saved valid package; an invalid file is reported and left out. */
export async function installSavedThemePackages(rootDir: string): Promise<{ installed: string[]; rejected: string[] }> {
  const installed: string[] = [], rejected: string[] = []
  for (const { id, record } of await readRecords(rootDir).catch(() => [])) {
    if (!record || builtInUiTheme(id)) { rejected.push(id); continue }
    try { removeUiThemePackage(id); installThemePackage(record.package); installed.push(id) } catch { rejected.push(id) }
  }
  return { installed, rejected }
}

async function view(rootDir: string): Promise<{ themes: ThemeRow[]; limits: typeof THEME_PACKAGE_LIMITS }> {
  const running = new Set(registeredUiThemeIds())
  const builtIns: ThemeRow[] = [...running].filter(id => builtInUiTheme(id)).map(id => ({ id, name: null, version: null, base: null, builtIn: true, state: 'installed', sha256: null, installedAt: null, installedBy: null }))
  const packages: ThemeRow[] = (await readRecords(rootDir)).map(({ id, record }) => record && running.has(id)
    ? { id, name: record.package.name, version: record.package.version, base: record.package.base, builtIn: false, state: 'installed', sha256: record.sha256, installedAt: record.installedAt, installedBy: record.installedBy }
    : { id, name: null, version: null, base: null, builtIn: false, state: 'invalid', sha256: null, installedAt: null, installedBy: null })
  return { themes: [...builtIns, ...packages], limits: THEME_PACKAGE_LIMITS }
}

export async function handleThemePackagesRoute(request: Request, url: URL, method: string, helpers: ThemePackagesHelpers): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  const id = match[1], sub = match[2]
  const action = method === 'GET' ? 'server.themes.read' : 'server.themes.update'
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  const allow = sub === 'clone' ? 'POST' : sub === 'package' ? 'GET' : id ? 'DELETE' : 'GET, POST'
  if (!allow.split(', ').includes(method)) return new Response(null, { status: 405, headers: { allow } })
  if (url.search) return fail('VALIDATION', 'theme routes accept no query selectors', unchanged)
  const rootDir = helpers.store.rootDir
  if (method === 'GET' && !id) return panelJson(await view(rootDir))
  const current = id ? (await readRecords(rootDir)).find(row => row.id === id) : undefined
  if (sub === 'package') {
    if (builtInUiTheme(id!)) return fail('NOT_FOUND', 'built-in themes are part of the release and are not downloadable packages', { ...unchanged, reason: 'built_in_theme' })
    if (!current?.record) return fail('NOT_FOUND', 'theme package not found', unchanged)
    return new Response(JSON.stringify(current.record.package, null, 2) + '\n', { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
      'content-disposition': `attachment; filename="${id}.xpanel-theme.json"`, 'x-content-type-options': 'nosniff' } })
  }
  const authority = async (): Promise<void> => { const fresh = await helpers.requireCaller(request); await helpers.assertRoot(fresh, action); if (fresh.principal.id !== caller.principal.id) fail('FORBIDDEN', 'root authority changed', unchanged) }
  const lease = await helpers.store.getWriterLock().acquire()
  let audit: { action: string; target: string; detail: Record<string, unknown> }, attempted = false
  try {
    await authority()
    if (method === 'DELETE') {
      if (builtInUiTheme(id!)) return fail('FORBIDDEN', 'built-in themes cannot be deleted', { ...unchanged, reason: 'built_in_theme' })
      if (!current) return fail('NOT_FOUND', 'theme package not found', unchanged)
      await lease.assertFencingToken(); attempted = true
      await atomicRemove(pathOf(rootDir, id!))
      removeUiThemePackage(id!)
      audit = { action: 'server.theme.deleted', target: 'theme:' + id, detail: { name: current.record?.package.name ?? null } }
    } else {
      let pkg: UiThemePackage
      if (sub === 'clone') {
        let body: unknown
        try { body = JSON.parse(Buffer.from(await readLimitedBody(request, 1024)).toString('utf8')) } catch (error) { if (error instanceof Error && 'code' in error) throw error; return fail('VALIDATION', 'request body is not valid JSON', unchanged) }
        if (!object(body) || !exactKeys(body, ['id', 'name'])) return fail('VALIDATION', 'exactly id and name are required', unchanged)
        if (!builtInUiTheme(id!) && !current?.record) return fail('NOT_FOUND', 'theme not found', unchanged)
        pkg = cloneThemePackage(builtInUiTheme(id!) ? id! : current!.record!.package, body.id as string, body.name as string)
      } else {
        if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'a theme package is a JSON document', unchanged)
        let raw: unknown
        try { raw = JSON.parse(Buffer.from(await readLimitedBody(request, THEME_PACKAGE_LIMITS.bytes)).toString('utf8')) } catch (error) { if (error instanceof Error && 'code' in error) throw error; return fail('VALIDATION', 'the theme package is not valid JSON', { ...unchanged, reason: 'package_format' }) }
        pkg = parseThemePackage(raw)
      }
      const existing = await readRecords(rootDir)
      if (existing.some(row => row.id === pkg.id)) return fail('CONFLICT', 'a theme package with this id is installed; delete it first', { ...unchanged, reason: 'theme_exists' })
      if (existing.length >= THEME_PACKAGE_LIMITS.packages) return fail('CONFLICT', `at most ${THEME_PACKAGE_LIMITS.packages} theme packages can be installed`, { ...unchanged, reason: 'theme_limit' })
      const record: ThemeRecord = { version: 1, package: pkg, sha256: digest(pkg), installedAt: (helpers.now ?? (() => new Date()))().toISOString(), installedBy: caller.principal.username }
      await lease.assertFencingToken(); attempted = true
      await atomicWriteJson(pathOf(rootDir, pkg.id), record, 0o640, async () => { await authority(); await lease.assertFencingToken() })
      installThemePackage(pkg)
      audit = sub === 'clone' ? { action: 'server.theme.cloned', target: 'theme:' + pkg.id, detail: { source: id, base: pkg.base, sha256: record.sha256 } }
        : { action: 'server.theme.installed', target: 'theme:' + pkg.id, detail: { base: pkg.base, version: pkg.version, sha256: record.sha256 } }
    }
  } catch (error) {
    if (attempted) return fail('SERVICE_UNAVAILABLE', 'the theme change could not be verified; reload before retrying', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
    throw error
  } finally { await lease.release() }
  try { await helpers.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, outcome: 'ok', ...audit }) }
  catch { return fail('SERVICE_UNAVAILABLE', 'the theme change was applied but its audit record requires review; reload before retrying', { stateChanged: true, verificationRequired: true }) }
  return panelJson(await view(rootDir))
}
