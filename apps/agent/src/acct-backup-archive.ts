import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, rm, writeFile } from 'node:fs/promises'
import { dirname, posix } from 'node:path'
import { fail } from '@xpanel/core'
import { assertBackupAccountTarget, backupFileName, DEFAULT_BACKUP_DIR, MAX_BACKUP_BYTES } from './account-backup.ts'
import type { BackupAccountTarget } from './account-backup.ts'
import { BACKUP_CONTROL, isBackupZoneName } from './acct-backup-plan.ts'
import { withPinnedHostTargetParent } from './host-target-parent.ts'
import type { BackupCommandRunner } from './backup-low-priority.ts'

/**
 * Server backup archive: the account home as tar members `./...`, plus root-written parts under `.xpanel-backup-data/`:
 * MariaDB dumps `databases/<db>.sql`, DNS zones as saved desired state `dns/<zone>.json`, and `manifest.json` with each
 * part's size and SHA-256. One gzip stream, one file. The home tar excludes `./.xpanel-backup-*`, so a home path can never
 * pose as a part.
 */
export const BACKUP_DATA_DIR = '.xpanel-backup-data'
export const BACKUP_DATA_MANIFEST = BACKUP_DATA_DIR + '/manifest.json'
/** Uncompressed tar bound before gzip; the published archive stays within MAX_BACKUP_BYTES. */
export const MAX_BACKUP_TAR_BYTES = 16 * 1024 * 1024 * 1024
/** A saved zone is small JSON; larger means it is not ours. */
export const MAX_BACKUP_ZONE_BYTES = 1024 * 1024
const MAX_LISTING_BYTES = 32 * 1024 * 1024
const DATABASE = /^[a-z][a-z0-9]{0,15}_[a-z0-9_]{1,47}$/
const MEMBER = /^\.xpanel-backup-data\/(?:(databases)\/([a-z][a-z0-9]{0,15}_[a-z0-9_]{1,47})\.sql|(dns)\/([a-z0-9.-]{1,253})\.json)$/

export type BackupPart = 'database' | 'dns'
export interface BackupPartDigest { name: string; bytes: number; sha256: string }
export interface BackupDataManifest { version: 1; username: string; databases: BackupPartDigest[]; zones: BackupPartDigest[] }
export interface BuiltBackupArchive { file: string; bytes: number; databases: string[]; zones: string[] }
export interface BackupArchiveListing { members: number; databases: string[]; zones: string[]; manifest: boolean }
export interface BackupArchiveBuildDeps {
  run: BackupCommandRunner
  /** Logical dump of one account database into a new file at outputPath. */
  dump(account: BackupAccountTarget, database: string, outputPath: string): Promise<{ bytes: number; sha256: string }>
}

export const backupPartMember = (part: BackupPart, name: string): string => part === 'database'
  ? DATABASE.test(name) ? `${BACKUP_DATA_DIR}/databases/${name}.sql` : fail('VALIDATION', 'invalid backup database name')
  : isBackupZoneName(name) ? `${BACKUP_DATA_DIR}/dns/${name}.json` : fail('VALIDATION', 'invalid backup zone name')
/** The part a tar member path stands for, or null for a home path. */
export const backupPartOf = (path: string): { part: BackupPart; name: string } | null => {
  const match = MEMBER.exec(path)
  if (!match) return null
  return match[1] ? { part: 'database', name: match[2]! } : isBackupZoneName(match[4]) ? { part: 'dns', name: match[4]! } : null
}

export function readBackupDataManifest(raw: unknown, username: string): BackupDataManifest {
  const bad = (): never => fail('VALIDATION', 'the backup data manifest is invalid', { stateChanged: false })
  const value = raw as Record<string, unknown>
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join() !== 'databases,username,version,zones' || value.version !== 1 || value.username !== username) return bad()
  const rows = (list: unknown, valid: (name: unknown) => boolean): BackupPartDigest[] => {
    if (!Array.isArray(list) || list.length > 1000) return bad()
    const parsed = list.map(item => {
      const row = item as Record<string, unknown>
      if (!row || typeof row !== 'object' || Object.keys(row).sort().join() !== 'bytes,name,sha256' || !valid(row.name)
        || typeof row.bytes !== 'number' || !Number.isSafeInteger(row.bytes) || row.bytes <= 0 || typeof row.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(row.sha256)) return bad()
      return { name: row.name as string, bytes: row.bytes, sha256: row.sha256 }
    })
    return new Set(parsed.map(row => row.name)).size === parsed.length ? parsed : bad()
  }
  return { version: 1, username, databases: rows(value.databases, name => typeof name === 'string' && DATABASE.test(name) && name.startsWith(username + '_')), zones: rows(value.zones, isBackupZoneName) }
}

/**
 * GNU tar --list output (default escape quoting, one member per line). Every member must stay relative and inside the archive;
 * parts are only the root-appended `.xpanel-backup-data/` entries, never a home path of the same name.
 */
export function readBackupArchiveListing(stdout: string): BackupArchiveListing {
  const databases: string[] = [], zones: string[] = []
  let members = 0, manifest = false
  for (const line of stdout.split('\n')) {
    if (!line) continue
    if (line.startsWith('/') || line.split('/').includes('..')) return fail('VALIDATION', 'the archive contains a path outside the account home', { stateChanged: false })
    members++
    if (line === './' + BACKUP_DATA_DIR || line.startsWith('./' + BACKUP_DATA_DIR + '/')) return fail('VALIDATION', 'the archive home contains the reserved backup data directory', { stateChanged: false })
    if (line !== BACKUP_DATA_DIR && !line.startsWith(BACKUP_DATA_DIR + '/')) continue
    if (line === BACKUP_DATA_MANIFEST) { manifest = true; continue }
    if ([BACKUP_DATA_DIR, BACKUP_DATA_DIR + '/', BACKUP_DATA_DIR + '/databases/', BACKUP_DATA_DIR + '/dns/'].includes(line)) continue
    const part = backupPartOf(line)
    if (!part) return fail('VALIDATION', 'the archive data directory holds an unexpected member', { stateChanged: false })
    ;(part.part === 'database' ? databases : zones).push(part.name)
  }
  if ((databases.length || zones.length) && !manifest || new Set(databases).size !== databases.length || new Set(zones).size !== zones.length) return fail('VALIDATION', 'the archive data members do not match a manifest', { stateChanged: false })
  return { members, databases: databases.sort(), zones: zones.sort(), manifest }
}

/** Root-owned 0700 directory without links; created when missing. */
const ensureRootDirectory = async (path: string): Promise<void> => {
  await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || process.platform === 'linux' && (process.getuid && info.uid !== process.getuid() || (info.mode & 0o077) !== 0)) fail('PRECONDITION_FAILED', 'the backup directory must be a private directory of the archive service')
}
const commandFailed = (what: string, stderr: string): never => fail('CONFIG_TEST_FAILED', `${what} failed: ${stderr.trim().slice(0, 500)}`, { stateChanged: false })
const stampOf = (date: Date): string => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')

/** Compresses a staged tar at low priority and links the complete file at `destination`, never over an existing one. */
const publish = async (run: BackupCommandRunner, tarPath: string, stage: string, destination: string): Promise<number> => {
  const gzipPath = posix.join(stage, 'archive.tar.gz')
  const compressed = await run({ argv: ['/usr/bin/gzip', '-c', '-n', '-6'], stdinPath: tarPath, stdoutPath: gzipPath, maxStdoutBytes: MAX_BACKUP_BYTES })
  if (compressed.killed === 'output limit') fail('LIMIT_EXCEEDED', 'the backup archive is larger than 2 GiB')
  if (!compressed.ok) commandFailed('archive compression', compressed.killed ?? compressed.stderr)
  await rm(tarPath, { force: true })
  await withPinnedHostTargetParent(destination, async pinned => {
    // link is exclusive: an existing archive is never overwritten, and only the complete file publishes.
    await link(gzipPath, pinned)
    if (process.platform === 'linux') { const parent = await open(dirname(pinned), constants.O_RDONLY | constants.O_DIRECTORY); try { await parent.sync() } finally { await parent.close() } }
  })
  return compressed.stdoutBytes
}
const withStage = async <T>(directory: string, task: (stage: string) => Promise<T>): Promise<T> => {
  const stage = posix.join(directory, '.build-' + randomUUID())
  await withPinnedHostTargetParent(stage, pinned => mkdir(pinned, { mode: 0o700 }))
  try { return await task(stage) } finally { await rm(stage, { recursive: true, force: true }).catch(() => undefined) }
}

/**
 * Builds one archive at low priority without staging anything in the account home: tar runs as the account and streams to a
 * root-only build directory, dumps and zones are appended by root, gzip compresses, and only the complete file is linked.
 */
export async function buildServerBackupArchive(input: { root?: string; account: BackupAccountTarget; databases: readonly string[]; zones: readonly { name: string; content: string }[]; excludeMail: boolean; now?: Date; nonce?: string; deps: BackupArchiveBuildDeps }): Promise<BuiltBackupArchive> {
  const { account, deps } = input
  assertBackupAccountTarget(account)
  const databases = [...new Set(input.databases)].sort(), zones = [...input.zones].sort((a, b) => a.name < b.name ? -1 : 1)
  if (databases.some(name => !DATABASE.test(name) || !name.startsWith(account.username + '_'))) fail('VALIDATION', 'a backup database does not belong to the account')
  if (zones.some(zone => !isBackupZoneName(zone.name) || Buffer.byteLength(zone.content) > MAX_BACKUP_ZONE_BYTES) || new Set(zones.map(zone => zone.name)).size !== zones.length) fail('VALIDATION', 'a backup zone is invalid')
  const root = input.root ?? DEFAULT_BACKUP_DIR, directory = posix.join(root, account.username)
  const file = backupFileName(account.username, stampOf(input.now ?? new Date()), input.nonce)
  await ensureRootDirectory(root); await ensureRootDirectory(directory)
  return withStage(directory, async stage => {
    const tarPath = posix.join(stage, 'home.tar')
    const home = await deps.run({ argv: ['/usr/bin/tar', '--create', '--file=-', `--directory=${account.home}`, '--exclude=./.xpanel-backup-*',
      ...(input.excludeMail ? ['--exclude=./mail', '--exclude=./etc'] : []), '--', '.'], runAsUser: account.username, stdoutPath: tarPath, maxStdoutBytes: MAX_BACKUP_TAR_BYTES })
    // GNU tar exit 1 on create means a file changed while it was read; the member is still a complete copy.
    if (home.killed || home.code > 1) commandFailed('home archive', home.killed ?? home.stderr)
    if (databases.length || zones.length) {
      const extra = posix.join(stage, 'extra'), data = posix.join(extra, BACKUP_DATA_DIR)
      await mkdir(extra, { mode: 0o700 }); await mkdir(data, { mode: 0o700 }); await mkdir(posix.join(data, 'databases'), { mode: 0o700 }); await mkdir(posix.join(data, 'dns'), { mode: 0o700 })
      const manifest: BackupDataManifest = { version: 1, username: account.username, databases: [], zones: [] }
      for (const name of databases) manifest.databases.push({ name, ...await deps.dump(account, name, posix.join(data, 'databases', name + '.sql')) })
      for (const zone of zones) {
        await writeFile(posix.join(data, 'dns', zone.name + '.json'), zone.content, { mode: 0o600, flag: 'wx' })
        manifest.zones.push({ name: zone.name, bytes: Buffer.byteLength(zone.content), sha256: createHash('sha256').update(zone.content).digest('hex') })
      }
      readBackupDataManifest(manifest, account.username)
      await writeFile(posix.join(data, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600, flag: 'wx' })
      const appended = await deps.run({ argv: ['/usr/bin/tar', '--append', `--file=${tarPath}`, `--directory=${extra}`, '--owner=0', '--group=0', '--numeric-owner', '--', BACKUP_DATA_DIR], maxStdoutBytes: 64 * 1024 })
      if (!appended.ok) commandFailed('backup data archive', appended.killed ?? appended.stderr)
    }
    const bytes = await publish(deps.run, tarPath, stage, posix.join(directory, file))
    return { file, bytes, databases, zones: zones.map(zone => zone.name) }
  })
}

export const controlSnapshotName = (date: Date, nonce?: string): string => `xpanel-control-${stampOf(date)}${nonce ? '-' + nonce : ''}.tar.gz`
/**
 * Once-per-run snapshot of the control state for disaster recovery and upgrade rollback: the desired-state directory plus a
 * consistent copy of the index database (`control.db`), into `<root>/_control/`. It is never restored per account.
 */
export async function buildControlSnapshot(input: { root?: string; stateDir: string; copyDatabase(outputPath: string): Promise<void>; run: BackupCommandRunner; now?: Date }): Promise<{ file: string; bytes: number }> {
  const root = input.root ?? DEFAULT_BACKUP_DIR, directory = posix.join(root, BACKUP_CONTROL), file = controlSnapshotName(input.now ?? new Date())
  await ensureRootDirectory(root); await ensureRootDirectory(directory)
  return withStage(directory, async stage => {
    const tarPath = posix.join(stage, 'control.tar'), extra = posix.join(stage, 'extra')
    const state = await input.run({ argv: ['/usr/bin/tar', '--create', '--file=-', `--directory=${input.stateDir}`, '--', '.'], stdoutPath: tarPath, maxStdoutBytes: MAX_BACKUP_TAR_BYTES })
    if (state.killed || state.code > 1) commandFailed('control state archive', state.killed ?? state.stderr)
    await mkdir(extra, { mode: 0o700 })
    await input.copyDatabase(posix.join(extra, 'control.db'))
    const appended = await input.run({ argv: ['/usr/bin/tar', '--append', `--file=${tarPath}`, `--directory=${extra}`, '--owner=0', '--group=0', '--numeric-owner', '--', 'control.db'], maxStdoutBytes: 64 * 1024 })
    if (!appended.ok) commandFailed('control database archive', appended.killed ?? appended.stderr)
    return { file, bytes: await publish(input.run, tarPath, stage, posix.join(directory, file)) }
  })
}

const listArchive = async (run: BackupCommandRunner, path: string): Promise<string> => {
  const listed = await run({ argv: ['/usr/bin/tar', '--list', '--gzip', `--file=${path}`], maxStdoutBytes: MAX_LISTING_BYTES })
  return listed.ok ? listed.stdout : fail('PRECONDITION_FAILED', 'the backup archive failed its integrity read', { stateChanged: false })
}
/** Full low-priority read of the gzip stream (CRC and length) and of every tar header; returns what the archive holds. */
export async function listServerBackupArchive(input: { root?: string; account: BackupAccountTarget; file: string; run: BackupCommandRunner }): Promise<BackupArchiveListing> {
  assertBackupAccountTarget(input.account)
  return readBackupArchiveListing(await listArchive(input.run, posix.join(input.root ?? DEFAULT_BACKUP_DIR, input.account.username, input.file)))
}
/** The same integrity read for a control snapshot: it must hold the database copy and stay relative. */
export async function listControlSnapshot(input: { root?: string; file: string; run: BackupCommandRunner }): Promise<{ members: number }> {
  if (!/^xpanel-control-[0-9]{8}T[0-9]{6}Z(?:-[a-f0-9]{12})?\.tar\.gz$/.test(input.file)) fail('VALIDATION', 'invalid control snapshot name')
  const lines = (await listArchive(input.run, posix.join(input.root ?? DEFAULT_BACKUP_DIR, BACKUP_CONTROL, input.file))).split('\n').filter(Boolean)
  if (lines.some(line => line.startsWith('/') || line.split('/').includes('..')) || !lines.includes('control.db')) fail('VALIDATION', 'the control snapshot is incomplete', { stateChanged: false })
  return { members: lines.length }
}

/** Extracts one part member to a new root-only file at low priority and checks its size; the caller checks the digest. */
export async function extractBackupPart(input: { root?: string; account: BackupAccountTarget; file: string; part: BackupPart; name: string; expected: BackupPartDigest; outputPath: string; run: BackupCommandRunner }): Promise<BackupPartDigest> {
  if (input.expected.name !== input.name) return fail('NOT_FOUND', 'the part is not in this backup', { stateChanged: false })
  const path = posix.join(input.root ?? DEFAULT_BACKUP_DIR, input.account.username, input.file)
  const extracted = await input.run({ argv: ['/usr/bin/tar', '--extract', '--gzip', '--to-stdout', '--occurrence=1', `--file=${path}`, '--', backupPartMember(input.part, input.name)], stdoutPath: input.outputPath, maxStdoutBytes: input.expected.bytes })
  if (!extracted.ok || extracted.stdoutBytes !== input.expected.bytes) return fail('PRECONDITION_FAILED', 'the backup part could not be read from the archive', { stateChanged: false })
  return input.expected
}
