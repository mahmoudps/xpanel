import { posix } from 'node:path'
import { fail } from '@xpanel/core'
import type { OsProfile } from '@xpanel/core'
import { hashing } from '../archive/reader.ts'
import type { ByteSource } from '../archive/reader.ts'
import { assertExecSteps } from '../steps.ts'
import type { LifecycleStep, ManifestSource, ManifestStep } from '../steps.ts'
import { lifecycleTools } from '../tools.ts'
import type { LifecycleTools } from '../tools.ts'
import { assertAccountHome, assertDatabaseName, assertDomain, assertId, assertSafeAbsPath, assertUsername, compactStamp, isIsoDate, isUnder, isUnderHomes } from '../validate.ts'
import { homeTarFiles } from './home-files.ts'
import { parseMailConfig } from './mail-config.ts'
import type { MailConfig } from './mail-config.ts'
import { BACKUP_FORMAT, BACKUP_VERSION, HOME_ARCHIVE, MAIL_CONFIG_FILE, MANIFEST_FILE, SQL_DIR, buildManifest, expandParts, sqlPath } from './manifest.ts'
import type { BackupManifest, BackupPart, BackupScope, ManifestFile, ManifestHeader } from './manifest.ts'

export type BackupDestination = 'download' | 'account-dir' | 'remote'
export const BACKUP_DESTINATIONS: readonly BackupDestination[] = ['download', 'account-dir', 'remote']

export interface BackupAccount {
  username: string
  home: string
  primaryDomain: string
  /** every domain of the account; mail config must stay on them */
  domains: string[]
}

export interface BackupRoots {
  /** root-owned 0700 staging area */
  work: string
  /** root-owned area the API streams downloads from */
  downloads: string
}

export const DEFAULT_BACKUP_ROOTS: BackupRoots = {
  work: '/var/lib/xpanel/backups/work',
  downloads: '/var/lib/xpanel/backups/downloads',
}

export interface BackupRequest {
  os: Pick<OsProfile, 'family'>
  account: BackupAccount
  parts: BackupScope[]
  destination: BackupDestination
  /** the account's databases from desired state */
  databases: string[]
  /** forwarders, default addresses and filters from desired state */
  mail: MailConfig
  createdAt: string
  remote?: { targetId: string }
  roots?: Partial<BackupRoots>
}

export interface BackupPlan {
  id: string
  parts: BackupPart[]
  fileName: string
  /** where the finished archive ends up: a local path, or `remote:<target>/<key>` */
  artifact: string
  header: ManifestHeader
  steps: LifecycleStep[]
}

/** Earlier backups kept in ~/backups are never folded into a new one. */
const HOME_EXCLUDES: readonly string[] = ['./backups/xpanel-backup-*']
const ACCOUNT_BACKUP_DIR = 'backups'

const homeTarArgv = (t: LifecycleTools, home: string): string[] =>
  [t.tar, '--create', '--gzip', '--file=-', `--directory=${home}`, ...HOME_EXCLUDES.map((e) => `--exclude=${e}`), '.']

/**
 * Runs as the account's Linux user over the local socket (unix_socket auth for the account's
 * own MariaDB user), so MariaDB itself limits the dump to the account's grants. The name is
 * a validated `<user>_<suffix>`, so it can never be read as an option.
 */
const dumpArgv = (t: LifecycleTools, user: string, db: string): string[] => [
  t.mariadbDump, '--no-defaults', `--user=${user}`, '--single-transaction', '--quick', '--routines', '--triggers',
  '--events', '--hex-blob', '--default-character-set=utf8mb4', '--no-tablespaces', db,
]

const normalizeRoots = (r: Partial<BackupRoots> | undefined): BackupRoots => {
  const roots = { ...DEFAULT_BACKUP_ROOTS, ...(r ?? {}) }
  assertSafeAbsPath(roots.work, 'backup work root')
  assertSafeAbsPath(roots.downloads, 'backup downloads root')
  if (isUnderHomes(roots.work) || isUnderHomes(roots.downloads)) fail('VALIDATION', 'backup roots must not be inside homes')
  if (isUnder(roots.work, roots.downloads) || isUnder(roots.downloads, roots.work)) fail('VALIDATION', 'backup work and download roots must not nest')
  return roots
}

export const validateBackupAccount = (a: BackupAccount): BackupAccount => {
  const username = assertUsername(a?.username)
  const home = assertAccountHome(a.home, username)
  const primaryDomain = assertDomain(a.primaryDomain, 'primary domain')
  if (!Array.isArray(a.domains)) fail('VALIDATION', 'account domains required')
  const domains = [...new Set([primaryDomain, ...a.domains.map((d) => assertDomain(d))])]
  return { username, home, primaryDomain, domains }
}

const ROOT_DIR = { mode: 0o700, owner: 'root', group: 'root' } as const

/**
 * Steps for an account backup. Home is tarred by the account user (so symlinks in the
 * home can never make root read someone else's files); dumps run as the account's own
 * MariaDB user; root assembles the outer archive and manifest in a root-only staging dir.
 */
export const createBackupPlan = (req: BackupRequest): BackupPlan => {
  const tools = lifecycleTools(req.os)
  const account = validateBackupAccount(req.account)
  const { username, home } = account
  const parts = expandParts(req.parts)
  if (!BACKUP_DESTINATIONS.includes(req.destination)) fail('VALIDATION', 'invalid backup destination')
  if (!isIsoDate(req.createdAt)) fail('VALIDATION', 'createdAt must be an ISO timestamp')
  const roots = normalizeRoots(req.roots)
  if (!Array.isArray(req.databases)) fail('VALIDATION', 'databases must be a list')
  const databases = parts.includes('databases') ? [...new Set(req.databases.map((d) => assertDatabaseName(d, username)))].sort() : []
  const mail = parts.includes('mail-config') ? parseMailConfig(req.mail, account.domains) : null
  const targetId = req.destination === 'remote' ? assertId(req.remote?.targetId, 'remote target') : null

  const id = `${username}-${compactStamp(new Date(req.createdAt))}`
  const fileName = `xpanel-backup-${id}.tar.gz`
  const work = posix.join(roots.work, id)
  const steps: LifecycleStep[] = [{ kind: 'ensure-dir', path: work, ...ROOT_DIR }]
  const members: string[] = []
  const sources: ManifestSource[] = []

  if (parts.includes('home')) {
    steps.push({ kind: 'exec-io', argv: homeTarArgv(tools, home), runAsUser: username, stdoutTo: { path: posix.join(work, HOME_ARCHIVE), mode: 0o600 }, okExitCodes: [0, 1] })
    members.push(HOME_ARCHIVE)
    sources.push({ part: 'home', tarGz: HOME_ARCHIVE })
  }
  if (databases.length) {
    steps.push({ kind: 'ensure-dir', path: posix.join(work, SQL_DIR), ...ROOT_DIR })
    for (const db of databases) {
      steps.push({ kind: 'exec-io', argv: dumpArgv(tools, username, db), runAsUser: username, stdoutTo: { path: posix.join(work, sqlPath(db)), mode: 0o600 } })
      sources.push({ part: 'databases', file: sqlPath(db) })
    }
    members.push(SQL_DIR)
  }
  if (mail) {
    steps.push({ kind: 'write-file', file: { path: posix.join(work, MAIL_CONFIG_FILE), content: `${JSON.stringify(mail, null, 2)}\n`, mode: 0o600, owner: 'root', group: 'root' } })
    members.push(MAIL_CONFIG_FILE)
    sources.push({ part: 'mail-config', file: MAIL_CONFIG_FILE })
  }

  const header: ManifestHeader = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    account: { username, primaryDomain: account.primaryDomain },
    parts,
    created: req.createdAt,
    databases,
  }
  steps.push({ kind: 'write-manifest', root: work, output: posix.join(work, MANIFEST_FILE), header, sources })

  const userDownloads = posix.join(roots.downloads, username)
  const packed = req.destination === 'download' ? posix.join(userDownloads, fileName) : posix.join(roots.work, fileName)
  if (req.destination === 'download') steps.push({ kind: 'ensure-dir', path: userDownloads, ...ROOT_DIR })
  // manifest.json first: restores and imports read it before anything else
  steps.push({ kind: 'exec', argv: [tools.tar, '--create', '--gzip', `--file=${packed}`, `--directory=${work}`, '--', MANIFEST_FILE, ...members] })

  let artifact = packed
  if (req.destination === 'account-dir') {
    const dir = posix.join(home, ACCOUNT_BACKUP_DIR)
    artifact = posix.join(dir, fileName)
    steps.push({ kind: 'exec-io', argv: [tools.mkdir, '-p', '-m', '0700', '--', dir], runAsUser: username })
    steps.push({ kind: 'exec-io', argv: [tools.dd, `of=${artifact}`, 'bs=1M', 'conv=excl', 'oflag=nofollow', 'status=none'], runAsUser: username, stdinFrom: packed })
    steps.push({ kind: 'remove-path', path: packed })
  } else if (targetId) {
    const objectKey = `${username}/${fileName}`
    artifact = `remote:${targetId}/${objectKey}`
    steps.push({ kind: 'remote-upload', from: packed, targetId, objectKey })
    steps.push({ kind: 'remove-path', path: packed })
  }
  steps.push({ kind: 'remove-path', path: work })
  assertExecSteps(steps)
  return { id, parts, fileName, artifact, header, steps }
}

/** Executor side of a write-manifest step; `open` streams a staged file. */
export const computeManifest = async (step: ManifestStep, open: (path: string) => ByteSource): Promise<BackupManifest> => {
  const files: ManifestFile[] = []
  for (const s of step.sources) {
    if (s.part === 'home') {
      files.push(...(await homeTarFiles(open(posix.join(step.root, s.tarGz)))).values())
      continue
    }
    const d = await hashing(toBuffers(open(posix.join(step.root, s.file)))).finish()
    files.push({ path: s.file, part: s.part, type: 'file', ...d })
  }
  return buildManifest(step.header, files)
}

async function* toBuffers(src: ByteSource): AsyncGenerator<Buffer> {
  for await (const c of src) yield Buffer.from(c.buffer, c.byteOffset, c.byteLength)
}
