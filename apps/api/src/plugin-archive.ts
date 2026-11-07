import { gunzipSync } from 'node:zlib'
import { fail } from '@xpanel/core'
import { tarEntries } from '../../agent/src/tar-entries.ts'

/** Compressed and unpacked bounds of one cPanel plugin archive; a generator archive holds install.json and small icons. */
export const PLUGIN_ARCHIVE_LIMITS = Object.freeze({ bytes: 1024 * 1024, unpacked: 4 * 1024 * 1024, files: 256 })
const unchanged = { stateChanged: false }
const refuse = (reason: string, message: string): never => fail('VALIDATION', message, { ...unchanged, reason })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const REGULAR = new Set(['0', '\0'])
// pax and GNU long-name records describe the next entry; this walk writes no path, so they are skipped with directories.
const SKIPPED = new Set(['5', 'x', 'g', 'L', 'K'])

const groupTitle = (id: string): string => id.charAt(0).toUpperCase() + id.slice(1).replace(/[_-]+/g, ' ')
const iconOf = (name: unknown, files: ReadonlyMap<string, Buffer>, prefix: string): unknown => {
  const bytes = typeof name === 'string' ? files.get(prefix + name) : undefined
  if (!bytes) return refuse('plugin_icon_format', 'an item icon is missing from the archive')
  return { type: /\.svg$/i.test(name as string) ? 'image/svg+xml' : 'image/png', data: bytes.toString('base64') }
}

/**
 * Reads a cPanel plugin archive (a gzip tar with install.json and its icons, at its root or in one directory) into the
 * fields of an xPanel plugin package, which parsePluginPackage then validates. Nothing is unpacked to disk and no file
 * runs: other files stay unread, and a link into the archive is refused because xPanel runs no plugin code.
 */
export function pluginPackageFromArchive(archive: Buffer, name: unknown): unknown {
  let tar: Buffer
  try { tar = gunzipSync(archive, { maxOutputLength: PLUGIN_ARCHIVE_LIMITS.unpacked }) } catch { return refuse('plugin_archive_format', `the file is not a gzip tar archive of up to ${PLUGIN_ARCHIVE_LIMITS.unpacked} unpacked bytes`) }
  const files = new Map<string, Buffer>()
  for (const entry of tarEntries(tar, () => refuse('plugin_archive_format', 'the archive is damaged or a path leaves it'))) {
    if (SKIPPED.has(entry.type)) continue
    if (!REGULAR.has(entry.type)) return refuse('plugin_archive_entry', 'a plugin archive holds only files and directories')
    if (files.size >= PLUGIN_ARCHIVE_LIMITS.files) return refuse('plugin_archive_format', `a plugin archive holds at most ${PLUGIN_ARCHIVE_LIMITS.files} files`)
    files.set(entry.path.replace(/^(?:\.\/)+/, ''), entry.data)
  }
  const manifests = [...files.keys()].filter(path => /^(?:[^/]+\/)?install\.json$/.test(path))
  if (manifests.length !== 1) return refuse('plugin_archive_format', 'the archive needs one install.json')
  const prefix = manifests[0]!.slice(0, -'install.json'.length)
  let rows: unknown
  try { rows = JSON.parse(files.get(manifests[0]!)!.toString('utf8')) } catch { return refuse('plugin_archive_format', 'install.json is not valid JSON') }
  if (!Array.isArray(rows)) return refuse('plugin_archive_format', 'install.json is a list of groups and links')
  if (!rows.every(row => object(row) && (row.type === 'group' || row.type === 'link'))) return refuse('plugin_archive_item', 'install.json holds groups and links only')
  const listed = rows as Record<string, unknown>[], groups = new Map(listed.filter(row => row.type === 'group').map(row => [row.id, row.name]))
  const order = (row: Record<string, unknown>): number => typeof row.order === 'number' ? row.order : Number.MAX_SAFE_INTEGER
  const items = listed.filter(row => row.type === 'link').sort((a, b) => order(a) - order(b)).map((row, index) => {
    if (typeof row.uri !== 'string' || !/^(?:https:\/\/|\/)/.test(row.uri)) return refuse('plugin_archive_code', 'a link points into the plugin, and this panel runs no plugin code')
    return { id: typeof row.id === 'string' ? row.id.toLowerCase() : row.id, name: row.name, group: groups.get(row.group_id) ?? (typeof row.group_id === 'string' ? groupTitle(row.group_id) : row.group_id), priority: index + 1, uri: row.uri,
      // cPanel: a link joins the Feature Manager under feature, or its id, unless featuremanager is 0.
      feature: Number(row.featuremanager ?? 1) === 0 ? null : `plugin:${String(row.feature ?? row.id)}`, icon: iconOf(row.icon, files, prefix) }
  })
  return { format: 'xpanel-plugin-package-v1', name, items }
}
