import { createHash } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tools } from '@xpanel/catalog'
import { fail } from '@xpanel/core'
import { atomicRemove, atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import { authorizeAccountOwner } from './account-ssh-workspace.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { exactKeys, panelJson, readPanelConfigBody } from './panel-config-file.ts'
import { PLUGIN_ARCHIVE_LIMITS, pluginPackageFromArchive } from './plugin-archive.ts'
import { httpsUrl } from './registered-apps.ts'

/**
 * WHM User Panel Plugin Generator: cPanel-style plugin packages. A package is one JSON document of link items (id,
 * name, group, priority, address, plan feature, 48x48 icon); nothing is unpacked, executed or fetched. Root generates
 * a package to download, installs a package or reads a cPanel plugin archive into extended/panel/plugins/<name>.json,
 * and account owners see its items as icons on their home page in either theme. A feature is an xPanel tool id or a
 * plugin:<key> the package adds to the Feature Manager.
 */
export const PLUGIN_PACKAGE_FORMAT = 'xpanel-plugin-package-v1'
export const PLUGIN_LIMITS = Object.freeze({ packages: 16, items: 16, bytes: 384 * 1024, iconBytes: 16 * 1024, iconPixels: 48, itemName: 80, group: 40, uri: 512 })
/** The prefix keeps a key a package adds apart from every catalog id and feature key. */
export const PLUGIN_FEATURE = /^plugin:[A-Za-z0-9_-]{1,57}$/
export interface PluginIcon { type: 'image/png' | 'image/svg+xml'; data: string }
export interface PluginItem { id: string; name: string; group: string; priority: number; uri: string; feature: string | null; icon: PluginIcon }
export interface PluginPackage { format: typeof PLUGIN_PACKAGE_FORMAT; name: string; items: PluginItem[] }
interface PluginRecord { version: 1; package: PluginPackage; sha256: string; installedAt: string; installedBy: string }
export type PluginItemRow = Omit<PluginItem, 'icon'>
export interface PluginRow { name: string; state: 'installed' | 'invalid'; items: PluginItemRow[]; sha256: string | null; installedAt: string | null; installedBy: string | null }
export interface PluginPackagesHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  store: StateStore
  now?: () => Date
}

const DIRECTORY = 'extended/panel/plugins'
const NAME = /^[a-z0-9_-]{1,64}$/
const FILE = /^([a-z0-9_-]{1,64})\.json$/
const ROOT_ROUTE = /^\/api\/server\/plugins(?:\/([a-z0-9_-]{1,64})(?:\/(package))?)?$/
const GENERATOR_ROUTE = '/api/server/plugin-generator'
const ACCOUNT_ROUTE = /^\/api\/account\/plugins(?:\/([a-z0-9_-]{1,64})\/([a-z0-9_-]{1,64})\/icon)?$/
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const unchanged = { stateChanged: false }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const refuse = (reason: string, message: string): never => fail('VALIDATION', message, { ...unchanged, reason })
const plain = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !!value.trim() && value.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f<>&"]/u.test(value)
const digest = (pkg: PluginPackage): string => createHash('sha256').update(JSON.stringify(pkg)).digest('hex')
const pathOf = (rootDir: string, name: string): string => join(rootDir, DIRECTORY, name + '.json')

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const pngSize = (bytes: Buffer): [number, number] | null => bytes.length > 24 && bytes.subarray(0, 8).equals(PNG) && bytes.readUInt32BE(8) === 13 && bytes.toString('latin1', 12, 16) === 'IHDR' ? [bytes.readUInt32BE(16), bytes.readUInt32BE(20)] : null

const SVG_ELEMENTS = new Set(['svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon'])
const SVG_ATTRIBUTES = new Set(['xmlns', 'width', 'height', 'viewBox', 'fill', 'fill-opacity', 'fill-rule', 'clip-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
  'opacity', 'transform', 'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'points'])
const SVG_TAG = /\s*<(\/?)([a-zA-Z]+)((?:\s+[A-Za-z-]+="[^"]*")*)\s*(\/?)>\s*/y
/** Allow-list scan: scripts, styles, links, entities, comments and text are refused, never sanitised. */
function svgSize(text: string): [number, number] | null {
  let at = 0, depth = 0, seen = false, size: [number, number] | null = null
  while (at < text.length) {
    if (seen && depth === 0) return null
    SVG_TAG.lastIndex = at
    const match = SVG_TAG.exec(text)
    if (!match || !SVG_ELEMENTS.has(match[2]!) || (match[2] === 'svg') !== !seen && !match[1]) return null
    at = SVG_TAG.lastIndex
    if (match[1]) { if (match[3] || match[4] || --depth < 0) return null; continue }
    const attributes = new Map([...match[3]!.matchAll(/([A-Za-z-]+)="([^"]*)"/g)].map(([, name, value]) => [name!, value!]))
    for (const [name, value] of attributes) {
      if (!SVG_ATTRIBUTES.has(name)) return null
      if (name === 'xmlns' ? value !== 'http://www.w3.org/2000/svg' : !/^[A-Za-z0-9 #.,%()+-]*$/.test(value) || /url/i.test(value)) return null
    }
    if (!seen) {
      if (attributes.get('xmlns') === undefined) return null
      size = [parseFloat(attributes.get('width') ?? ''), parseFloat(attributes.get('height') ?? '')]
      seen = true
    }
    if (!match[4]) depth++
  }
  return depth === 0 ? size : null
}

function parseIcon(raw: unknown): PluginIcon {
  if (!object(raw) || !exactKeys(raw, ['type', 'data']) || (raw.type !== 'image/png' && raw.type !== 'image/svg+xml') || typeof raw.data !== 'string') return refuse('plugin_icon_format', 'an icon is a base64 PNG or plain SVG image')
  const bytes = Buffer.from(raw.data, 'base64')
  if (!bytes.length || bytes.length > PLUGIN_LIMITS.iconBytes || bytes.toString('base64') !== raw.data) return refuse('plugin_icon_format', `an icon is a base64 PNG or plain SVG image of up to ${PLUGIN_LIMITS.iconBytes} bytes`)
  const size = raw.type === 'image/png' ? pngSize(bytes) : svgSize(bytes.toString('utf8'))
  if (!size) return refuse('plugin_icon_format', 'an icon is a PNG or a plain SVG with only drawing elements')
  if (size[0] !== PLUGIN_LIMITS.iconPixels || size[1] !== PLUGIN_LIMITS.iconPixels) return refuse('plugin_icon_size', 'an icon is exactly 48 by 48 pixels')
  return { type: raw.type, data: raw.data }
}

/** A panel page of this server or an https address; never a script, data or protocol-relative link. */
const isPluginUri = (value: unknown): value is string => typeof value === 'string' && value.length <= PLUGIN_LIMITS.uri
  && (httpsUrl(value) || /^(?:\/[A-Za-z0-9][A-Za-z0-9._~-]*)+\/?$/.test(value) && !/\/\.\.?(?:\/|$)/.test(value))

function parseItem(raw: unknown): PluginItem {
  if (!object(raw) || !exactKeys(raw, ['id', 'name', 'group', 'priority', 'uri', 'feature', 'icon'])) return refuse('plugin_item_format', 'an item has exactly id, name, group, priority, uri, feature and icon')
  if (typeof raw.id !== 'string' || !NAME.test(raw.id)) return refuse('plugin_item_id', 'an item id is 1 to 64 lowercase letters, digits, hyphens and underscores')
  if (!plain(raw.name, PLUGIN_LIMITS.itemName)) return refuse('plugin_item_name', `an item name is plain text of up to ${PLUGIN_LIMITS.itemName} characters`)
  if (!plain(raw.group, PLUGIN_LIMITS.group)) return refuse('plugin_item_group', `a group is plain text of up to ${PLUGIN_LIMITS.group} characters`)
  if (!Number.isSafeInteger(raw.priority) || (raw.priority as number) < 1 || (raw.priority as number) > 99) return refuse('plugin_item_priority', 'a priority is 1 to 99')
  if (!isPluginUri(raw.uri)) return refuse('plugin_item_uri', 'an address is a panel path or an https URL')
  if (raw.feature !== null && !(typeof raw.feature === 'string' && PLUGIN_FEATURE.test(raw.feature)) && !tools.some(tool => tool.id === raw.feature && tool.surface === 'xpanel')) return refuse('plugin_item_feature', 'a feature is null, an xPanel tool id or plugin: and a new key')
  return { id: raw.id, name: raw.name, group: raw.group, priority: raw.priority as number, uri: raw.uri, feature: raw.feature as string | null, icon: parseIcon(raw.icon) }
}

const parseFields = (name: unknown, items: unknown): PluginPackage => {
  if (typeof name !== 'string' || !NAME.test(name)) return refuse('plugin_name', 'a plugin name is 1 to 64 lowercase letters, digits, hyphens and underscores')
  if (!Array.isArray(items) || !items.length || items.length > PLUGIN_LIMITS.items) return refuse('plugin_items', `a plugin has 1 to ${PLUGIN_LIMITS.items} items`)
  const parsed = items.map(parseItem)
  if (new Set(parsed.map(item => item.id)).size !== parsed.length) return refuse('plugin_item_duplicate', 'item ids must be unique in a plugin')
  return { format: PLUGIN_PACKAGE_FORMAT, name, items: parsed }
}
/** Strict package grammar with a stable reason for every refusal. */
export function parsePluginPackage(raw: unknown): PluginPackage {
  if (!object(raw) || !exactKeys(raw, ['format', 'name', 'items']) || raw.format !== PLUGIN_PACKAGE_FORMAT) return refuse('plugin_package_format', `the package is not an ${PLUGIN_PACKAGE_FORMAT} document`)
  return parseFields(raw.name, raw.items)
}

function readRecord(name: string, raw: unknown): PluginRecord | null {
  if (!object(raw) || !exactKeys(raw, ['version', 'package', 'sha256', 'installedAt', 'installedBy']) || raw.version !== 1 || typeof raw.installedAt !== 'string' || !STAMP.test(raw.installedAt)
    || typeof raw.installedBy !== 'string' || !/^[A-Za-z0-9_.@-]{1,64}$/.test(raw.installedBy)) return null
  try {
    const pkg = parsePluginPackage(raw.package)
    return pkg.name === name && raw.sha256 === digest(pkg) ? { version: 1, package: pkg, sha256: raw.sha256, installedAt: raw.installedAt, installedBy: raw.installedBy } : null
  } catch { return null }
}
// Every home page reads every plugin; uncached, the largest set cost 64 ms a read and 113 MiB of RSS growth over 20 reads.
const parsed = new Map<string, { key: string; record: PluginRecord | null }>()
async function readRecords(rootDir: string): Promise<{ name: string; record: PluginRecord | null }[]> {
  let names: string[]
  try { names = (await readdir(join(rootDir, DIRECTORY))).sort() } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; return fail('PRECONDITION_FAILED', 'the installed plugins cannot be read', unchanged) }
  const rows: { name: string; record: PluginRecord | null }[] = []
  for (const file of names.slice(0, PLUGIN_LIMITS.packages * 2)) {
    const name = FILE.exec(file)?.[1]
    if (!name) continue
    const path = pathOf(rootDir, name)
    let record: PluginRecord | null = null
    try {
      const info = await stat(path), key = `${info.mtimeMs}:${info.size}:${info.ino}`, cached = parsed.get(path)
      record = cached?.key === key ? cached.record : readRecord(name, await readJsonIfExists<unknown>(path))
      parsed.set(path, { key, record })
    } catch { record = null }
    rows.push({ name, record })
  }
  return rows
}

/** A plugin of the same name needs explicit overwrite; an item id another plugin holds never moves silently. */
function assertInstallable(rows: { name: string; record: PluginRecord | null }[], pkg: PluginPackage, overwrite: boolean): void {
  if (rows.some(row => row.name === pkg.name) && !overwrite) fail('CONFLICT', 'a plugin with this name is installed; overwrite it explicitly', { ...unchanged, reason: 'plugin_exists' })
  const taken = rows.find(row => row.name !== pkg.name && row.record?.package.items.some(item => pkg.items.some(next => next.id === item.id)))
  if (taken) fail('CONFLICT', 'another plugin uses one of these item ids', { ...unchanged, reason: 'plugin_item_exists', plugin: taken.name })
  if (!rows.some(row => row.name === pkg.name) && rows.length >= PLUGIN_LIMITS.packages) fail('CONFLICT', `at most ${PLUGIN_LIMITS.packages} plugins can be installed`, { ...unchanged, reason: 'plugin_limit' })
}

const rowOf = ({ name, record }: { name: string; record: PluginRecord | null }): PluginRow => record
  ? { name, state: 'installed', items: record.package.items.map(({ icon: _icon, ...item }) => item), sha256: record.sha256, installedAt: record.installedAt, installedBy: record.installedBy }
  : { name, state: 'invalid', items: [], sha256: null, installedAt: null, installedBy: null }
const view = async (rootDir: string): Promise<{ plugins: PluginRow[]; limits: typeof PLUGIN_LIMITS }> => ({ plugins: (await readRecords(rootDir)).map(rowOf), limits: PLUGIN_LIMITS })
const attachment = (pkg: PluginPackage): Response => new Response(JSON.stringify(pkg, null, 2) + '\n', { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
  'content-disposition': `attachment; filename="${pkg.name}.xpanel-plugin.json"`, 'x-content-type-options': 'nosniff' } })
/** Feature Manager rows for the keys installed packages add; the first item that names a key labels it. */
export async function pluginFeatures(rootDir: string): Promise<{ key: string; label: string }[]> {
  const labels = new Map<string, string>()
  for (const { record } of await readRecords(rootDir)) for (const item of record?.package.items ?? []) if (item.feature && PLUGIN_FEATURE.test(item.feature) && !labels.has(item.feature)) labels.set(item.feature, item.name)
  return [...labels].map(([key, label]) => ({ key, label })).sort((a, b) => a.key.localeCompare(b.key, 'en'))
}
const archiveBytes = (value: unknown): Buffer => {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'base64') : Buffer.alloc(0)
  return bytes.length && bytes.length <= PLUGIN_ARCHIVE_LIMITS.bytes && bytes.toString('base64') === value ? bytes : refuse('plugin_archive_format', `an archive is base64 of up to ${PLUGIN_ARCHIVE_LIMITS.bytes} bytes`)
}
const overwriteOf = (value: unknown): boolean => value === undefined || typeof value === 'boolean' ? value === true : refuse('plugin_overwrite', 'overwrite is true or false')

/** Items the plan of this account shows, in home page order: group, then priority, then name. */
async function accountItems(helpers: PluginPackagesHelpers, account: { planId: string }): Promise<{ plugin: string; item: PluginItem }[]> {
  const plan = await helpers.store.getPlan(account.planId), list = plan ? await helpers.store.getFeatureList(plan.featureListId) : null
  if (!list) return fail('FORBIDDEN', 'account feature policy is unavailable', unchanged)
  const shown = (item: PluginItem): boolean => {
    const tool = tools.find(entry => entry.id === item.feature)
    return !item.feature || !list.disabled.includes(item.feature) && !(tool?.featureKey && list.disabled.includes(tool.featureKey))
  }
  return (await readRecords(helpers.store.rootDir)).flatMap(({ name, record }) => (record?.package.items ?? []).filter(shown).map(item => ({ plugin: name, item })))
    .sort((a, b) => a.item.group.localeCompare(b.item.group, 'en') || a.item.priority - b.item.priority || a.item.name.localeCompare(b.item.name, 'en'))
}

export async function handlePluginPackagesRoute(request: Request, url: URL, method: string, helpers: PluginPackagesHelpers): Promise<Response | null> {
  const account = ACCOUNT_ROUTE.exec(url.pathname)
  if (account) {
    const owner = await authorizeAccountOwner(helpers, request, [], 'Plugins')
    if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
    if (url.search) return fail('VALIDATION', 'plugin routes accept no query selectors', unchanged)
    const items = await accountItems(helpers, owner.account)
    if (!account[1]) return panelJson({ items: items.map(({ plugin, item: { icon: _icon, feature: _feature, ...item } }) => ({ plugin, ...item, icon: `/api/account/plugins/${plugin}/${item.id}/icon` })) })
    const icon = items.find(entry => entry.plugin === account[1] && entry.item.id === account[2])?.item.icon
    if (!icon) return fail('NOT_FOUND', 'plugin icon not found', unchanged)
    return new Response(new Uint8Array(Buffer.from(icon.data, 'base64')), { headers: { 'content-type': icon.type, 'cache-control': 'private, max-age=300', 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox", 'cross-origin-resource-policy': 'same-origin' } })
  }
  const match = ROOT_ROUTE.exec(url.pathname), generator = url.pathname === GENERATOR_ROUTE
  if (!match && !generator) return null
  const name = match?.[1], sub = match?.[2]
  const action = method === 'GET' ? 'server.plugins.read' : 'server.plugins.update'
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  const allow = generator ? 'POST' : sub ? 'GET' : name ? 'DELETE' : 'GET, POST'
  if (!allow.split(', ').includes(method)) return new Response(null, { status: 405, headers: { allow } })
  if (url.search) return fail('VALIDATION', 'plugin routes accept no query selectors', unchanged)
  const rootDir = helpers.store.rootDir
  if (method === 'GET' && !name) return panelJson(await view(rootDir))
  if (sub) {
    const pkg = (await readRecords(rootDir)).find(row => row.name === name)?.record?.package
    return pkg ? attachment(pkg) : fail('NOT_FOUND', 'plugin not found', unchanged)
  }
  if (generator) {
    const body = await readPanelConfigBody(request, PLUGIN_LIMITS.bytes)
    if (!exactKeys(body, ['name', 'items', 'overwrite'])) return fail('VALIDATION', 'exactly name, items and overwrite are required', unchanged)
    const pkg = parseFields(body.name, body.items)
    assertInstallable(await readRecords(rootDir), pkg, overwriteOf(body.overwrite))
    return attachment(pkg)
  }
  const authority = async (): Promise<void> => { const fresh = await helpers.requireCaller(request); await helpers.assertRoot(fresh, action); if (fresh.principal.id !== caller.principal.id) fail('FORBIDDEN', 'root authority changed', unchanged) }
  const body = method === 'POST' ? await readPanelConfigBody(request, Math.ceil(PLUGIN_ARCHIVE_LIMITS.bytes * 4 / 3) + 1024) : null
  if (body && !exactKeys(body, ['package', 'overwrite']) && !exactKeys(body, ['archive', 'name', 'overwrite'])) return fail('VALIDATION', 'exactly package and overwrite, or archive, name and overwrite, are required', unchanged)
  const source = body && 'archive' in body ? 'cpanel-archive' : 'package'
  const pkg = body ? parsePluginPackage(source === 'package' ? body.package : pluginPackageFromArchive(archiveBytes(body.archive), body.name)) : null, overwrite = overwriteOf(body?.overwrite)
  const lease = await helpers.store.getWriterLock().acquire()
  let audit: { action: string; target: string; detail: Record<string, unknown> }, attempted = false
  try {
    await authority()
    const rows = await readRecords(rootDir)
    if (pkg) {
      assertInstallable(rows, pkg, overwrite)
      const record: PluginRecord = { version: 1, package: pkg, sha256: digest(pkg), installedAt: (helpers.now ?? (() => new Date()))().toISOString(), installedBy: caller.principal.username }
      await lease.assertFencingToken(); attempted = true
      await atomicWriteJson(pathOf(rootDir, pkg.name), record, 0o640, async () => { await authority(); await lease.assertFencingToken() })
      audit = { action: 'server.plugin.installed', target: 'plugin:' + pkg.name, detail: { items: pkg.items.length, sha256: record.sha256, overwrite, source } }
    } else {
      if (!rows.some(row => row.name === name)) return fail('NOT_FOUND', 'plugin not found', unchanged)
      await lease.assertFencingToken(); attempted = true
      await atomicRemove(pathOf(rootDir, name!))
      parsed.delete(pathOf(rootDir, name!))
      audit = { action: 'server.plugin.deleted', target: 'plugin:' + name, detail: {} }
    }
  } catch (error) {
    if (attempted) return fail('SERVICE_UNAVAILABLE', 'the plugin change could not be verified; reload before retrying', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
    throw error
  } finally { await lease.release() }
  try { await helpers.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, outcome: 'ok', ...audit }) }
  catch { return fail('SERVICE_UNAVAILABLE', 'the plugin change was applied but its audit record requires review; reload before retrying', { stateChanged: true, verificationRequired: true }) }
  return panelJson(await view(rootDir))
}
