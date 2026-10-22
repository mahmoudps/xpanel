import { fail } from '@xpanel/core'
import { normalizeEntryName } from '../archive/paths.ts'
import { assertDatabaseName, assertDomain, assertUsername, exactKeys, isIsoDate, isNonNegInt, isObj, isSha256 } from '../validate.ts'

export const BACKUP_FORMAT = 'xpanel-backup'
export const BACKUP_VERSION = 1

export type BackupPart = 'home' | 'databases' | 'mail-config'
export type BackupScope = BackupPart | 'full'
export const ALL_PARTS: readonly BackupPart[] = ['home', 'databases', 'mail-config']

export const HOME_ARCHIVE = 'home.tar.gz'
export const MAIL_CONFIG_FILE = 'mail-config.json'
export const MANIFEST_FILE = 'manifest.json'
export const SQL_DIR = 'mysql'
export const sqlPath = (db: string): string => `${SQL_DIR}/${db}.sql`

export interface ManifestFile {
  /** home/<rel> for home content, mysql/<db>.sql, mail-config.json */
  path: string
  part: BackupPart
  type: 'file' | 'symlink'
  size: number
  /** content digest; for symlinks the digest of the link target string */
  sha256: string
}

export interface ManifestHeader {
  format: typeof BACKUP_FORMAT
  version: typeof BACKUP_VERSION
  account: { username: string; primaryDomain: string }
  parts: BackupPart[]
  created: string
  databases: string[]
}

export interface BackupManifest extends ManifestHeader {
  files: ManifestFile[]
}

const MAX_MANIFEST_FILES = 5_000_000

export const expandParts = (scopes: readonly BackupScope[]): BackupPart[] => {
  if (!Array.isArray(scopes) || scopes.length === 0) fail('VALIDATION', 'at least one backup part is required')
  const out = new Set<BackupPart>()
  for (const s of scopes) {
    if (s === 'full') ALL_PARTS.forEach((p) => out.add(p))
    else if ((ALL_PARTS as readonly string[]).includes(s)) out.add(s)
    else fail('VALIDATION', `unknown backup part: ${String(s).slice(0, 40)}`)
  }
  return ALL_PARTS.filter((p) => out.has(p))
}

const safeArchivePath = (p: unknown): string => {
  const n = normalizeEntryName(p)
  if (!n.ok || n.path !== p || n.control || n.path === '') fail('VALIDATION', `manifest file path is unsafe: ${String(p).slice(0, 200)}`)
  return p as string
}

const partFor = (path: string, databases: ReadonlySet<string>): BackupPart | null => {
  if (path.startsWith('home/')) return 'home'
  if (path === MAIL_CONFIG_FILE) return 'mail-config'
  const m = /^mysql\/([a-z0-9_]+)\.sql$/.exec(path)
  return m && databases.has(m[1] as string) ? 'databases' : null
}

const parseFile = (f: unknown, dbs: ReadonlySet<string>, parts: readonly BackupPart[]): ManifestFile => {
  if (!isObj(f)) return fail('VALIDATION', 'manifest file entry must be an object')
  exactKeys(f, ['path', 'part', 'type', 'size', 'sha256'], 'manifest file')
  const path = safeArchivePath(f.path)
  const part = partFor(path, dbs)
  if (!part || f.part !== part || !parts.includes(part)) fail('VALIDATION', `manifest path ${path} does not match part ${String(f.part)}`)
  if (f.type !== 'file' && f.type !== 'symlink') fail('VALIDATION', `manifest type for ${path} is invalid`)
  if (f.type === 'symlink' && part !== 'home') fail('VALIDATION', `only home content may be a symlink (${path})`)
  if (!isNonNegInt(f.size)) fail('VALIDATION', `manifest size for ${path} is invalid`)
  if (!isSha256(f.sha256)) fail('VALIDATION', `manifest sha256 for ${path} is invalid`)
  return { path, part: part as BackupPart, type: f.type as ManifestFile['type'], size: f.size as number, sha256: f.sha256 as string }
}

/** Strict parse of an untrusted manifest (it may come from a user-uploaded archive). */
export const parseManifest = (raw: unknown): BackupManifest => {
  if (!isObj(raw)) return fail('VALIDATION', 'manifest must be an object')
  exactKeys(raw, ['format', 'version', 'account', 'parts', 'created', 'databases', 'files'], 'manifest')
  if (raw.format !== BACKUP_FORMAT) fail('VALIDATION', 'not an xPanel backup manifest')
  if (raw.version !== BACKUP_VERSION) {
    fail('VALIDATION', typeof raw.version === 'number' && raw.version > BACKUP_VERSION ? 'backup was made by a newer xPanel' : 'unsupported manifest version')
  }
  if (!isObj(raw.account)) return fail('VALIDATION', 'manifest account missing')
  exactKeys(raw.account, ['username', 'primaryDomain'], 'manifest account')
  const username = assertUsername(raw.account.username)
  const primaryDomain = assertDomain(raw.account.primaryDomain, 'primary domain')
  if (!Array.isArray(raw.parts)) return fail('VALIDATION', 'manifest parts missing')
  const parts = expandParts(raw.parts as BackupScope[])
  if (parts.length !== raw.parts.length || raw.parts.includes('full')) fail('VALIDATION', 'manifest parts must be concrete and unique')
  if (!isIsoDate(raw.created)) fail('VALIDATION', 'manifest created must be an ISO timestamp')
  if (!Array.isArray(raw.databases)) return fail('VALIDATION', 'manifest databases missing')
  const databases = raw.databases.map((d) => assertDatabaseName(d, username))
  if (new Set(databases).size !== databases.length) fail('VALIDATION', 'duplicate database in manifest')
  if (databases.length && !parts.includes('databases')) fail('VALIDATION', 'manifest lists databases without the databases part')
  if (!Array.isArray(raw.files) || raw.files.length > MAX_MANIFEST_FILES) return fail('VALIDATION', 'manifest files missing or too many')
  const dbSet = new Set(databases)
  const seen = new Set<string>()
  const files = raw.files.map((f) => {
    const file = parseFile(f, dbSet, parts)
    if (seen.has(file.path)) fail('VALIDATION', `duplicate manifest path ${file.path}`)
    seen.add(file.path)
    return file
  })
  for (const db of databases) if (!seen.has(sqlPath(db))) fail('VALIDATION', `manifest has no dump for ${db}`)
  if (parts.includes('mail-config') && !seen.has(MAIL_CONFIG_FILE)) fail('VALIDATION', 'manifest has no mail-config.json')
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, account: { username, primaryDomain }, parts, created: raw.created as string, databases, files }
}

/** Assembles and validates a manifest; files are sorted for stable output. */
export const buildManifest = (header: ManifestHeader, files: ManifestFile[]): BackupManifest =>
  parseManifest({ ...header, files: [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) })
