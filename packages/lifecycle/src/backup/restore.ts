import { posix } from 'node:path'
import { fail, isXpanelError } from '@xpanel/core'
import type { OsProfile } from '@xpanel/core'
import { normalizeEntryName } from '../archive/paths.ts'
import { hashing, readBody, walkTar } from '../archive/reader.ts'
import type { Body, ByteSource } from '../archive/reader.ts'
import { assertExecSteps } from '../steps.ts'
import type { LifecycleStep } from '../steps.ts'
import { lifecycleTools } from '../tools.ts'
import type { LifecycleTools } from '../tools.ts'
import { assertSafeAbsPath, isCompactStamp, isNonNegInt, isSha256, isUnderHomes } from '../validate.ts'
import { homeTarFiles } from './home-files.ts'
import { HOME_ARCHIVE, MAIL_CONFIG_FILE, MANIFEST_FILE, SQL_DIR, parseManifest, sqlPath } from './manifest.ts'
import type { BackupManifest, BackupPart, ManifestFile } from './manifest.ts'
import { DEFAULT_BACKUP_ROOTS, validateBackupAccount } from './plan.ts'
import type { BackupAccount } from './plan.ts'

export interface ListingEntry {
  /** relative to the account home */
  path: string
  type: 'file' | 'symlink'
  size: number
  sha256: string
}

export interface ArchiveDiff {
  /** in the archive, not on disk: restore creates them */
  added: string[]
  /** on both sides with different content: restore overwrites them */
  changed: string[]
  unchanged: string[]
  /** on disk only: restore never deletes them */
  missingInArchive: string[]
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

const checkListing = (l: ListingEntry[]): Map<string, ListingEntry> => {
  if (!Array.isArray(l)) fail('VALIDATION', 'current listing must be an array')
  const m = new Map<string, ListingEntry>()
  for (const e of l) {
    const n = normalizeEntryName(e?.path)
    if (!n.ok || n.path !== e.path || n.path === '' || n.control) fail('VALIDATION', `unsafe listing path: ${String(e?.path).slice(0, 200)}`)
    if ((e.type !== 'file' && e.type !== 'symlink') || !isNonNegInt(e.size) || !isSha256(e.sha256)) fail('VALIDATION', `invalid listing entry ${e.path}`)
    if (m.has(e.path)) fail('VALIDATION', `duplicate listing path ${e.path}`)
    m.set(e.path, e)
  }
  return m
}

/** Compares the home part of a backup with what is on disk now (paths relative to home). */
export const diffArchive = (manifest: BackupManifest, current: ListingEntry[]): ArchiveDiff => {
  const now = checkListing(current)
  const archived = new Map<string, ManifestFile>()
  for (const f of manifest.files) if (f.part === 'home') archived.set(f.path.slice('home/'.length), f)
  const d: ArchiveDiff = { added: [], changed: [], unchanged: [], missingInArchive: [] }
  for (const [p, f] of archived) {
    const c = now.get(p)
    if (!c) d.added.push(p)
    else if (c.type !== f.type || c.sha256 !== f.sha256 || c.size !== f.size) d.changed.push(p)
    else d.unchanged.push(p)
  }
  for (const p of now.keys()) if (!archived.has(p)) d.missingInArchive.push(p)
  for (const k of ['added', 'changed', 'unchanged', 'missingInArchive'] as const) d[k].sort(cmp)
  return d
}

export interface RestoreRequest {
  os: Pick<OsProfile, 'family'>
  account: BackupAccount
  /** verified manifest of the archive (inspectBackupArchive) */
  manifest: BackupManifest
  /** root-owned local copy of the archive, never inside a home */
  archivePath: string
  parts: BackupPart[]
  /** when given, only its added + changed home files are extracted */
  diff?: ArchiveDiff
  /** subset of the manifest's databases; default all */
  databases?: string[]
  /** compact UTC stamp naming the work directory */
  stamp: string
  workRoot?: string
}

export interface RestorePlan {
  parts: BackupPart[]
  homePaths: string[] | 'all'
  databases: string[]
  steps: LifecycleStep[]
}

/** Above this many paths the whole home archive is extracted (still never deleting). */
export const MAX_ARGV_PATHS = 2000
const MAX_ARGV_BYTES = 96 * 1024

/**
 * As the account's own MariaDB user, so its grants bound what the SQL can touch.
 * --sandbox makes the client refuse `system`, `source` and other client commands a hostile
 * dump could carry (MariaDB 10.5.25 / 10.6.18 / 10.11.8 and later, shipped by every supported OS).
 */
const sqlImportArgv = (t: LifecycleTools, user: string, db: string): string[] => [
  t.mariadb, '--no-defaults', `--user=${user}`, '--batch', '--sandbox', '--one-database', '--default-character-set=utf8mb4', db,
]

/** GNU tar never removes files that are absent from an archive; no unlink or delete flags are used. */
const homeExtractArgv = (t: LifecycleTools, home: string, members: string[] | 'all'): string[] => [
  t.tar, '--extract', '--gzip', '--file=-', `--directory=${home}`, '--no-same-owner', '--no-overwrite-dir', '--no-wildcards',
  ...(members === 'all' ? [] : ['--', ...members.map((m) => `./${m}`)]),
]

const selectHomePaths = (m: BackupManifest, diff: ArchiveDiff | undefined): string[] | 'all' => {
  if (!diff) return 'all'
  const inArchive = new Set(m.files.filter((f) => f.part === 'home').map((f) => f.path.slice('home/'.length)))
  const wanted = [...new Set([...diff.added, ...diff.changed])]
  for (const p of wanted) if (typeof p !== 'string' || !inArchive.has(p)) fail('VALIDATION', `diff path ${String(p).slice(0, 200)} is not in the backup`)
  const bytes = wanted.reduce((n, p) => n + Buffer.byteLength(p) + 3, 0)
  return wanted.length <= MAX_ARGV_PATHS && bytes <= MAX_ARGV_BYTES ? wanted.sort(cmp) : 'all'
}

/**
 * Restore never deletes: files missing from the archive stay, a database restore never
 * touches the home, and mail config is merged into desired state.
 */
export const restorePlan = (req: RestoreRequest): RestorePlan => {
  const tools = lifecycleTools(req.os)
  const account = validateBackupAccount(req.account)
  const { username, home } = account
  const m = parseManifest(req.manifest)
  if (m.account.username !== username) fail('VALIDATION', `backup belongs to ${m.account.username}, not ${username}; use an import instead`)
  const archive = assertSafeAbsPath(req.archivePath, 'archive path')
  // root reads it: a path an account controls could be a symlink to any root-only file
  if (isUnderHomes(archive)) fail('VALIDATION', 'the archive must be a root-owned copy outside the homes')
  if (!isCompactStamp(req.stamp)) fail('VALIDATION', 'invalid restore stamp')
  const workRoot = assertSafeAbsPath(req.workRoot ?? DEFAULT_BACKUP_ROOTS.work, 'work root')
  if (!Array.isArray(req.parts)) fail('VALIDATION', 'parts must be a list')
  const parts = [...new Set(req.parts)]
  if (parts.length === 0) fail('VALIDATION', 'select at least one part to restore')
  for (const p of parts) if (!m.parts.includes(p)) fail('VALIDATION', `backup does not contain ${String(p).slice(0, 40)}`)

  const databases = parts.includes('databases') ? [...new Set(req.databases ?? m.databases)] : []
  for (const db of databases) if (!m.databases.includes(db)) fail('VALIDATION', `backup has no database ${String(db).slice(0, 80)}`)

  const homePaths = parts.includes('home') ? selectHomePaths(m, req.diff) : []
  const restoreHome = homePaths === 'all' || homePaths.length > 0
  const work = posix.join(workRoot, `restore-${username}-${req.stamp}`)
  const members = [
    ...(restoreHome ? [HOME_ARCHIVE] : []),
    ...databases.map(sqlPath),
    ...(parts.includes('mail-config') ? [MAIL_CONFIG_FILE] : []),
  ]
  const steps: LifecycleStep[] = [
    { kind: 'verify-archive', path: archive, username },
    { kind: 'ensure-dir', path: work, mode: 0o700, owner: 'root', group: 'root' },
  ]
  if (members.length) {
    steps.push({ kind: 'exec', argv: [tools.tar, '--extract', '--gzip', `--file=${archive}`, `--directory=${work}`, '--no-same-owner', '--no-same-permissions', '--no-wildcards', '--', ...members] })
  }
  for (const db of databases) steps.push({ kind: 'desired-state', op: 'ensure-database', username, database: db })
  if (parts.includes('mail-config')) steps.push({ kind: 'desired-state', op: 'merge-mail-config', username, from: posix.join(work, MAIL_CONFIG_FILE) })
  if (databases.length || parts.includes('mail-config')) steps.push({ kind: 'reconcile', reason: `restore ${username}`, sharedUnits: 'reload-only' })
  for (const db of databases) {
    steps.push({ kind: 'exec-io', argv: sqlImportArgv(tools, username, db), runAsUser: username, stdinFrom: posix.join(work, sqlPath(db)) })
  }
  if (restoreHome) {
    steps.push({ kind: 'exec-io', argv: homeExtractArgv(tools, home, homePaths), runAsUser: username, stdinFrom: posix.join(work, HOME_ARCHIVE) })
  }
  steps.push({ kind: 'remove-path', path: work })
  assertExecSteps(steps)
  return { parts, homePaths, databases, steps }
}

export interface InspectResult {
  manifest: BackupManifest | null
  ok: boolean
  problems: string[]
}

const MANIFEST_CAP = 512 * 1024 * 1024
const OUTER = /^(manifest\.json|home\.tar\.gz|mail-config\.json|mysql\/[a-z0-9_]+\.sql)$/
const MAX_OUTER_ENTRIES = 100_000

/** Compares the files inside home.tar.gz with the manifest's home entries. */
const homeProblems = async (body: Body, expected: ReadonlyMap<string, ManifestFile>): Promise<string[]> => {
  const problems: string[] = []
  const found = await homeTarFiles(body)
  for (const [key, d] of found) {
    const want = expected.get(key)
    if (!want) problems.push(`home member ${key.slice(5)} not in manifest`)
    else if (d.type !== want.type || d.sha256 !== want.sha256 || d.size !== want.size) problems.push(`digest mismatch for home member ${key.slice(5)}`)
  }
  for (const k of expected.keys()) if (k.startsWith('home/') && !found.has(k)) problems.push(`home member ${k.slice(5)} missing`)
  return problems
}

/**
 * Verifies an untrusted backup archive: manifest first, only known members, no links,
 * every digest matching, including each file inside home.tar.gz.
 */
export const inspectBackupArchive = async (source: ByteSource, expectUser?: string): Promise<InspectResult> => {
  const problems: string[] = []
  let manifest: BackupManifest | null = null
  const expected = new Map<string, ManifestFile>()
  const seen = new Set<string>()
  const onMember = async (e: { path: string; type: string }, body: Body): Promise<void> => {
    if (e.type === 'directory' && (e.path === '' || e.path === SQL_DIR)) return
    if (e.type !== 'file' || !OUTER.test(e.path)) { problems.push(`unexpected member ${e.path}`); return }
    if (manifest === null) {
      if (e.path !== MANIFEST_FILE) fail('VALIDATION', 'manifest.json must be the first member')
      const raw = await readBody(body, MANIFEST_CAP)
      if (!raw) fail('VALIDATION', 'manifest.json is too large')
      let json: unknown
      try { json = JSON.parse((raw as Buffer).toString('utf8')) } catch { fail('VALIDATION', 'manifest.json is not JSON') }
      const m = parseManifest(json)
      if (expectUser !== undefined && m.account.username !== expectUser) fail('VALIDATION', `backup belongs to ${m.account.username}`)
      for (const f of m.files) expected.set(f.path, f)
      manifest = m
      return
    }
    if (seen.has(e.path)) { problems.push(`duplicate member ${e.path}`); return }
    seen.add(e.path)
    if (e.path === HOME_ARCHIVE) {
      if (!(manifest as BackupManifest).parts.includes('home')) { problems.push('home.tar.gz present but the home part is not declared'); return }
      problems.push(...(await homeProblems(body, expected)))
      return
    }
    const want = expected.get(e.path)
    const d = await hashing(body).finish()
    if (!want) problems.push(`member ${e.path} not in manifest`)
    else if (want.sha256 !== d.sha256 || want.size !== d.size) problems.push(`digest mismatch for ${e.path}`)
  }
  try {
    const summary = await walkTar(source, onMember, { linkScope: () => null, maxEntries: MAX_OUTER_ENTRIES })
    if (summary.skippedTotal) problems.push(`${summary.skippedTotal} link or special entries in the outer archive`)
  } catch (e) {
    if (!isXpanelError(e)) throw e
    return { manifest, ok: false, problems: [...problems, e.message] }
  }
  if (manifest === null) return { manifest: null, ok: false, problems: [...problems, 'manifest.json missing'] }
  const m: BackupManifest = manifest
  for (const f of m.files) if (f.part !== 'home' && !seen.has(f.path)) problems.push(`member ${f.path} missing`)
  if (m.parts.includes('home') && !seen.has(HOME_ARCHIVE)) problems.push('home.tar.gz missing')
  return { manifest: m, ok: problems.length === 0, problems }
}
