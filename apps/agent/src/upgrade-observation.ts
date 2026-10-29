import { createHash, createPublicKey } from 'node:crypto'
import { constants } from 'node:fs'
import type { Stats } from 'node:fs'
import { lstat, open, readdir, readlink, statfs } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fail } from '@xpanel/core'
import { currentSchemaVersion, latestUpgrade } from '@xpanel/db'
import type { Db, UpgradeRecord } from '@xpanel/db'
import { DEFAULT_LAYOUT, compareSemver, parseRewindJournal, parseSemver, readLock, rewindJournalPath } from '@xpanel/lifecycle'
import type { LockState, RewindState, RewindStep, UpgradeLayout } from '@xpanel/lifecycle'
import { parseOsRelease } from '@xpanel/os'
import type { OsRelease } from '@xpanel/os'
import { RELEASE_VERIFICATION_LIMITS } from '../../../scripts/release-verifier.mjs'
import { parseSignedReleaseManifest, verifyReleaseArtifactSignature } from './lifecycle/upgrade-runner.ts'
import type { ReleaseVerificationKey, SignedReleaseManifest } from './lifecycle/upgrade-runner.ts'

/** Root-owned Ed25519 publisher keys (`{"schemaVersion":1,"keys":[{"keyId","algorithm":"ed25519","publicKey"}]}`). */
export const RELEASE_KEYS_PATH = '/etc/xpanel/release-keys.json'
/** runUpgrade requires the archive directly inside layout.downloadsDir, so staged releases wait there. */
export const STAGED_RELEASE_DIR = DEFAULT_LAYOUT.downloadsDir
export const RELEASE_MANIFEST_SUFFIX = '.manifest.json'
export const RELEASE_ARCHIVE_SUFFIX = '.tar.gz'
const MAX_KEYS_BYTES = 16 * 1024
const MAX_KEYS = 8
const MAX_MANIFEST_BYTES = 4096
const MAX_STAGED = 16
const MAX_DIRECTORY_ENTRIES = 256
const MAX_ARCHIVE_BYTES = RELEASE_VERIFICATION_LIMITS.compressedBytes
const EXACT_VERSION = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export interface FileFacts {
  kind: 'file' | 'directory' | 'symlink' | 'other'
  uid: number
  mode: number
  size: number
  nlink: number
  dev: number
  ino: number
  mtimeMs: number
  ctimeMs: number
}

/** Read-only host filesystem port. Reads open the named file without following a final symlink. */
export interface UpgradeHostFs {
  lstat(path: string): Promise<FileFacts | null>
  read(path: string, maxBytes: number): Promise<{ facts: FileFacts; bytes: Buffer }>
  sha256(path: string, maxBytes: number): Promise<{ facts: FileFacts; sha256: string }>
  list(path: string): Promise<string[] | null>
  readlink(path: string): Promise<string | null>
  freeBytes(path: string): Promise<number>
}

const facts = (s: Stats): FileFacts => ({
  kind: s.isSymbolicLink() ? 'symlink' : s.isFile() ? 'file' : s.isDirectory() ? 'directory' : 'other',
  uid: s.uid, mode: s.mode & 0o7777, size: s.size, nlink: s.nlink, dev: s.dev, ino: s.ino, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs,
})
const missing = (error: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException)?.code))
const refuse = (reason: string): never => fail('PRECONDITION_FAILED', `upgrade observation refused: ${reason}`, { reason, stateChanged: false })
const openNoFollow = (path: string) => open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
const same = (a: FileFacts, b: FileFacts): boolean => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs

export const nodeUpgradeFs: UpgradeHostFs = {
  async lstat(path) { try { return facts(await lstat(path)) } catch (error) { if (missing(error)) return null; throw error } },
  async read(path, maxBytes) {
    const handle = await openNoFollow(path)
    try {
      const info = facts(await handle.stat())
      if (info.kind !== 'file' || info.size > maxBytes) return refuse('file-not-bounded-regular')
      const bytes = await handle.readFile()
      if (bytes.length > maxBytes) return refuse('file-not-bounded-regular')
      return { facts: info, bytes }
    } finally { await handle.close() }
  },
  async sha256(path, maxBytes) {
    const handle = await openNoFollow(path)
    try {
      const before = facts(await handle.stat())
      if (before.kind !== 'file' || before.size > maxBytes) return refuse('archive-not-bounded-regular')
      const hash = createHash('sha256')
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk)
      if (!same(before, facts(await handle.stat()))) return refuse('archive-changed-while-hashing')
      return { facts: before, sha256: hash.digest('hex') }
    } finally { await handle.close() }
  },
  async list(path) { try { return await readdir(path) } catch (error) { if (missing(error)) return null; throw error } },
  async readlink(path) { try { return await readlink(path) } catch (error) { if (missing(error) || (error as NodeJS.ErrnoException).code === 'EINVAL') return null; throw error } },
  async freeBytes(path) {
    const value = await statfs(path, { bigint: true })
    const bytes = value.bavail * value.bsize
    return bytes > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(bytes)
  },
}

const trusted = (info: FileFacts | null, kind: FileFacts['kind'], ownerUid: number): boolean =>
  !!info && info.kind === kind && info.uid === ownerUid && (info.mode & 0o022) === 0 && (kind !== 'file' || info.nlink === 1)

/** Root-owned, not group/other writable, no symlink in the file or any ancestor; null when absent. */
export const readTrustedFile = async (fs: UpgradeHostFs, path: string, maxBytes: number, ownerUid = 0): Promise<Buffer | null> => {
  const named = await fs.lstat(path)
  if (!named) return null
  if (!trusted(named, 'file', ownerUid)) return refuse('trusted-file-unsafe')
  for (let directory = dirname(path); ; directory = dirname(directory)) {
    if (!trusted(await fs.lstat(directory), 'directory', ownerUid)) return refuse('trusted-file-unsafe')
    if (dirname(directory) === directory) break
  }
  const held = await fs.read(path, maxBytes)
  if (!same(held.facts, named) || !trusted(held.facts, 'file', ownerUid)) return refuse('trusted-file-unsafe')
  return held.bytes
}

export type ReleaseTrustReason = 'no-trusted-release-keys' | 'hmac-release-key-refused' | 'release-keys-file-unsafe' | 'release-keys-invalid'
export interface ReleaseTrust {
  state: 'configured' | 'missing' | 'invalid'
  keys: ReleaseVerificationKey[]
  keyIds: string[]
  source: string
  reason: ReleaseTrustReason | null
}

const untrusted = (source: string, state: 'missing' | 'invalid', reason: ReleaseTrustReason): ReleaseTrust => ({ state, keys: [], keyIds: [], source, reason })

/** Production release trust is Ed25519 public keys only; an HMAC secret is refused, never downgraded. */
export const loadTrustedReleaseKeys = async (options: { fs?: UpgradeHostFs; path?: string; ownerUid?: number } = {}): Promise<ReleaseTrust> => {
  const source = options.path ?? RELEASE_KEYS_PATH
  let bytes: Buffer | null
  try { bytes = await readTrustedFile(options.fs ?? nodeUpgradeFs, source, MAX_KEYS_BYTES, options.ownerUid ?? 0) }
  catch { return untrusted(source, 'invalid', 'release-keys-file-unsafe') }
  if (bytes === null) return untrusted(source, 'missing', 'no-trusted-release-keys')
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { return untrusted(source, 'invalid', 'release-keys-invalid') }
  const document = value as Record<string, unknown>
  if (!document || typeof document !== 'object' || Array.isArray(document) || Object.keys(document).sort().join(',') !== 'keys,schemaVersion' || document.schemaVersion !== 1 || !Array.isArray(document.keys) || document.keys.length > MAX_KEYS) return untrusted(source, 'invalid', 'release-keys-invalid')
  const keys: ReleaseVerificationKey[] = []
  for (const raw of document.keys as unknown[]) {
    const entry = raw as Record<string, unknown>
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return untrusted(source, 'invalid', 'release-keys-invalid')
    if (entry.algorithm !== 'ed25519') return untrusted(source, 'invalid', String(entry.algorithm).toLowerCase().includes('hmac') || 'secret' in entry ? 'hmac-release-key-refused' : 'release-keys-invalid')
    if (Object.keys(entry).sort().join(',') !== 'algorithm,keyId,publicKey' || typeof entry.keyId !== 'string' || !KEY_ID.test(entry.keyId) || keys.some(key => key.keyId === entry.keyId)
      || typeof entry.publicKey !== 'string' || entry.publicKey.length > 1024 || !entry.publicKey.startsWith('-----BEGIN PUBLIC KEY-----')) return untrusted(source, 'invalid', 'release-keys-invalid')
    try { if (createPublicKey(entry.publicKey).asymmetricKeyType !== 'ed25519') return untrusted(source, 'invalid', 'release-keys-invalid') }
    catch { return untrusted(source, 'invalid', 'release-keys-invalid') }
    keys.push({ keyId: entry.keyId, kind: 'ed25519-pem', publicKeyOrSecret: entry.publicKey })
  }
  if (keys.length === 0) return untrusted(source, 'missing', 'no-trusted-release-keys')
  return { state: 'configured', keys, keyIds: keys.map(key => key.keyId), source, reason: null }
}

export type StagedSignatureState = 'verified' | 'unverified' | 'invalid' | 'no-trusted-keys'
export interface StagedRelease {
  manifest: string
  version: string | null
  schemaVersion: number | null
  bytes: number | null
  sha256: string | null
  keyId: string | null
  signatureState: StagedSignatureState
  reason: string | null
}
export interface VerifiedStagedRelease { manifest: SignedReleaseManifest; archivePath: string }

// shortcut: digests are memoized by file identity in-process; a restart re-hashes (bounded by MAX_STAGED).
const archiveDigests = new Map<string, string>()
const digestOf = async (fs: UpgradeHostFs, path: string, info: FileFacts): Promise<string> => {
  const key = [path, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join('\0')
  const known = archiveDigests.get(key)
  if (known) return known
  const held = await fs.sha256(path, MAX_ARCHIVE_BYTES)
  if (!same(held.facts, info)) return refuse('archive-changed-while-hashing')
  if (archiveDigests.size >= 64) archiveDigests.clear()
  archiveDigests.set(key, held.sha256)
  return held.sha256
}

/** Pairs `<name>.manifest.json` with `<name>.tar.gz` in the fixed staging directory. */
export const readStagedReleases = async (fs: UpgradeHostFs, directory: string, trust: ReleaseTrust, ownerUid = 0): Promise<{ state: 'read' | 'missing'; truncated: boolean; releases: StagedRelease[]; verified: Map<string, VerifiedStagedRelease> }> => {
  const names = await fs.list(directory)
  const verified = new Map<string, VerifiedStagedRelease>()
  if (names === null) return { state: 'missing', truncated: false, releases: [], verified }
  const manifests = names.filter(name => name.endsWith(RELEASE_MANIFEST_SUFFIX) && FILE_NAME.test(name)).sort()
  const truncated = names.length > MAX_DIRECTORY_ENTRIES || manifests.length > MAX_STAGED
  const releases: StagedRelease[] = []
  for (const name of manifests.slice(0, MAX_STAGED)) {
    const row: StagedRelease = { manifest: name, version: null, schemaVersion: null, bytes: null, sha256: null, keyId: null, signatureState: 'invalid', reason: null }
    releases.push(row)
    let manifest: SignedReleaseManifest
    try {
      const path = join(directory, name)
      if ((await fs.lstat(path))?.kind !== 'file') { row.reason = 'manifest-not-regular-file'; continue }
      manifest = parseSignedReleaseManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode((await fs.read(path, MAX_MANIFEST_BYTES)).bytes)))
    } catch { row.reason = 'manifest-invalid'; continue }
    Object.assign(row, { version: manifest.version, schemaVersion: manifest.schemaVersion, bytes: manifest.bytes, sha256: manifest.sha256, keyId: manifest.keyId })
    if (releases.some(other => other !== row && other.version === manifest.version)) { row.reason = 'duplicate-version'; continue }
    if (trust.keys.length === 0) { row.signatureState = 'no-trusted-keys'; row.reason = trust.reason; continue }
    if (!trust.keyIds.includes(manifest.keyId)) { row.signatureState = 'unverified'; row.reason = 'untrusted-key'; continue }
    const archivePath = join(directory, name.slice(0, -RELEASE_MANIFEST_SUFFIX.length) + RELEASE_ARCHIVE_SUFFIX)
    try {
      const archive = await fs.lstat(archivePath)
      if (!archive) { row.reason = 'archive-missing'; continue }
      // Mirrors the native engine's archive checks so "verified" is never shown for an archive it refuses.
      if (!trusted(archive, 'file', ownerUid) || archive.size > MAX_ARCHIVE_BYTES) { row.reason = 'archive-unsafe'; continue }
      if (await digestOf(fs, archivePath, archive) !== manifest.sha256) { row.reason = 'archive-checksum-mismatch'; continue }
    } catch { row.reason = 'archive-unreadable'; continue }
    try { verifyReleaseArtifactSignature(manifest, trust.keys) } catch { row.reason = 'signature-mismatch'; continue }
    row.signatureState = 'verified'
    verified.set(manifest.version, { manifest, archivePath })
  }
  return { state: 'read', truncated, releases, verified }
}

export interface UpgradeHistoryView {
  id: string
  fromVersion: string
  toVersion: string
  fromSchemaVersion: number | null
  toSchemaVersion: number | null
  status: UpgradeRecord['status']
  phase: UpgradeRecord['phase']
  error: string | null
  actor: string
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}
export const projectUpgradeRecord = (row: UpgradeRecord): UpgradeHistoryView => ({
  id: row.id, fromVersion: row.fromVersion, toVersion: row.toVersion, fromSchemaVersion: row.fromSchemaVersion, toSchemaVersion: row.toSchemaVersion,
  status: row.status, phase: row.phase, error: row.error === null ? null : row.error.slice(0, 2000), actor: row.actor,
  createdAt: row.createdAt, startedAt: row.startedAt, finishedAt: row.finishedAt,
})

export interface UpgradeLockView { present: boolean | null; state: LockState | 'unreadable' | null; to: string | null; at: string | null }
/** The latest upgrade's rewind journal; null when that upgrade never rewound. */
export interface UpgradeRewindView { state: RewindState | 'unreadable'; done: RewindStep[]; problems: string[]; updatedAt: string | null }

export interface UpgradeObservation {
  observedAt: string
  revision: string
  current: { state: 'read' | 'unavailable'; version: string | null; releasePath: string | null }
  schemaVersion: number | null
  os: { id: string; versionId: string; prettyName: string } | null
  freeBytes: number | null
  freeBytesPath: string
  activeTransfers: number | null
  lock: UpgradeLockView
  retirementPending: boolean | null
  maintenance: boolean | null
  lastUpgrade: UpgradeHistoryView | null
  rewind: UpgradeRewindView | null
  trust: { state: ReleaseTrust['state']; keysConfigured: number; keyIds: string[]; source: string; reason: ReleaseTrustReason | null }
  staged: { directory: string; state: 'read' | 'missing' | 'unavailable'; truncated: boolean; releases: StagedRelease[] }
  coordinator: { available: boolean; reason: 'upgrade-coordinator-unavailable' | null }
  availability: { preflight: { enabled: boolean; reasons: string[] }; start: { enabled: boolean; reasons: string[] }; candidates: string[] }
  snapshotsDir: string
}

export interface UpgradeObservationDeps {
  db: Db
  fs?: UpgradeHostFs
  now?: () => Date
  layout?: Partial<UpgradeLayout>
  keysPath?: string
  osReleasePath?: string
  /** Expected owner of trusted files; production is root. */
  ownerUid?: number
  /** Same persisted count the native machine reads (non-lifecycle queued/running jobs). */
  countActiveTransfers?: () => Promise<number>
  coordinatorAvailable?: boolean
}

export interface ObservedUpgradeInputs {
  observation: UpgradeObservation
  osRelease: OsRelease | null
  verified: Map<string, VerifiedStagedRelease>
  trust: ReleaseTrust
  layout: UpgradeLayout
}

export const countPersistedActiveJobs = async (db: Db): Promise<number> => {
  const rows = await db.query<{ count: number }>("SELECT COUNT(*) AS count FROM jobs WHERE status IN ('queued','running') AND kind NOT LIKE 'lifecycle.%'")
  const count = Number(rows[0]?.count)
  if (!Number.isSafeInteger(count) || count < 0) return refuse('active-transfers-unreadable')
  return count
}

// An unreadable fact is reported as unknown (null) and blocks the gates that need it.
const attempt = async <T>(read: () => Promise<T>): Promise<T | null> => { try { return await read() } catch { return null } }

/** Volatile free space and the read time stay out of the decision revision. */
export const upgradeRevision = (observation: Omit<UpgradeObservation, 'revision'>): string => {
  const { observedAt: _observedAt, freeBytes: _freeBytes, ...stable } = observation
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex')
}

const UNREADABLE_REWIND: UpgradeRewindView = { state: 'unreadable', done: [], problems: [], updatedAt: null }
const readRewind = async (fs: UpgradeHostFs, layout: UpgradeLayout, recordId: string | null): Promise<UpgradeRewindView | null> => {
  if (recordId === null) return null
  try {
    const path = rewindJournalPath(layout, recordId)
    if ((await fs.lstat(path)) === null) return null
    const j = parseRewindJournal((await fs.read(path, 64 * 1024)).bytes.toString('utf8'))
    return j ? { state: j.state, done: j.done, problems: j.problems.slice(0, 8).map(p => p.slice(0, 500)), updatedAt: j.updatedAt } : UNREADABLE_REWIND
  } catch {
    // A journal that exists but cannot be read is never shown as "no rewind".
    return UNREADABLE_REWIND
  }
}

export const observeUpgradeInputs = async (deps: UpgradeObservationDeps): Promise<ObservedUpgradeInputs> => {
  const fs = deps.fs ?? nodeUpgradeFs
  const ownerUid = deps.ownerUid ?? 0
  const layout: UpgradeLayout = { ...DEFAULT_LAYOUT, ...(deps.layout ?? {}) }
  const trust = await loadTrustedReleaseKeys({ fs, path: deps.keysPath ?? RELEASE_KEYS_PATH, ownerUid })
  const target = await attempt(() => fs.readlink(layout.currentLink))
  const linked = target && dirname(target) === layout.releasesDir && EXACT_VERSION.test(basename(target)) ? basename(target) : null
  // The machine derives "from" from the current link; the release's own VERSION marker must agree.
  const marker = linked ? await attempt(async () => (await fs.read(join(target!, 'VERSION'), 64)).bytes.toString('utf8').trim()) : null
  const currentVersion = linked && marker === linked ? linked : null
  const osRelease = await attempt(async () => parseOsRelease((await fs.read(deps.osReleasePath ?? '/etc/os-release', 16 * 1024)).bytes.toString('utf8')))
  const [schemaVersion, freeBytes, activeTransfers, lockPresent, lock, retirement, maintenance, last, staged] = await Promise.all([
    attempt(() => currentSchemaVersion(deps.db)),
    attempt(() => fs.freeBytes(layout.root)),
    attempt(() => (deps.countActiveTransfers ?? (() => countPersistedActiveJobs(deps.db)))()),
    attempt(async () => (await fs.lstat(layout.lockFile)) !== null),
    attempt(() => readLock({ readFile: async path => (await fs.read(path, 4096)).bytes.toString('utf8') }, layout.lockFile)),
    attempt(async () => (await fs.lstat(join(layout.snapshotsDir, 'retirement-attention.json'))) !== null),
    attempt(async () => (await fs.lstat(layout.maintenanceFile)) !== null),
    attempt(() => latestUpgrade(deps.db)),
    attempt(() => readStagedReleases(fs, layout.downloadsDir, trust, ownerUid)),
  ])
  const verified = staged?.verified ?? new Map<string, VerifiedStagedRelease>()
  const rewind = await readRewind(fs, layout, last?.id ?? null)
  const candidates = currentVersion ? [...verified.keys()].filter(version => compareSemver(version, currentVersion) > 0).sort((a, b) => compareSemver(b, a)) : []
  const lastView = last ? projectUpgradeRecord(last) : null
  const coordinatorAvailable = deps.coordinatorAvailable === true
  const preflightReasons = [
    ...(trust.reason ? [trust.reason] : []),
    ...(trust.state === 'configured' && candidates.length === 0 ? ['no-verified-staged-release'] : []),
    ...(currentVersion ? [] : ['current-release-unreadable']),
    ...(osRelease ? [] : ['os-release-unreadable']),
    ...(schemaVersion === null ? ['schema-unreadable'] : []),
    ...(freeBytes === null ? ['free-space-unreadable'] : []),
    ...(activeTransfers === null ? ['active-transfers-unreadable'] : []),
  ]
  const startReasons = [
    ...preflightReasons,
    ...(lockPresent !== false ? ['upgrade-lock-present'] : []),
    ...(retirement !== false ? ['retirement-pending'] : []),
    ...(maintenance !== false ? ['maintenance-retained'] : []),
    ...(lastView && (lastView.status === 'pending' || lastView.status === 'running') ? ['upgrade-in-flight'] : []),
    ...(coordinatorAvailable ? [] : ['upgrade-coordinator-unavailable']),
  ]
  const unsigned: Omit<UpgradeObservation, 'revision'> = {
    observedAt: (deps.now ?? (() => new Date()))().toISOString(),
    current: { state: currentVersion ? 'read' : 'unavailable', version: currentVersion, releasePath: currentVersion ? target : null },
    schemaVersion,
    os: osRelease ? { id: osRelease.id, versionId: osRelease.versionId, prettyName: osRelease.prettyName } : null,
    freeBytes,
    freeBytesPath: layout.root,
    activeTransfers,
    lock: { present: lockPresent, state: lockPresent === false ? null : lock?.state ?? 'unreadable', to: lock?.to ?? null, at: lock?.at ?? null },
    retirementPending: retirement,
    maintenance,
    lastUpgrade: lastView,
    rewind,
    trust: { state: trust.state, keysConfigured: trust.keys.length, keyIds: trust.keyIds, source: trust.source, reason: trust.reason },
    staged: { directory: layout.downloadsDir, state: staged?.state ?? 'unavailable', truncated: staged?.truncated ?? false, releases: staged?.releases ?? [] },
    coordinator: { available: coordinatorAvailable, reason: coordinatorAvailable ? null : 'upgrade-coordinator-unavailable' },
    availability: { preflight: { enabled: preflightReasons.length === 0, reasons: preflightReasons }, start: { enabled: startReasons.length === 0, reasons: [...new Set(startReasons)] }, candidates },
    snapshotsDir: layout.snapshotsDir,
  }
  return { observation: { ...unsigned, revision: upgradeRevision(unsigned) }, osRelease, verified, trust, layout }
}

export const readUpgradeObservation = async (deps: UpgradeObservationDeps): Promise<UpgradeObservation> => (await observeUpgradeInputs(deps)).observation

/** Native coordinator gate: the exact archive's signed manifest must verify against root-held Ed25519 keys. */
export const releaseManifestPathFor = (archivePath: string): string => {
  if (!archivePath.endsWith(RELEASE_ARCHIVE_SUFFIX)) return fail('VALIDATION', 'release archive must be a .tar.gz file')
  return archivePath.slice(0, -RELEASE_ARCHIVE_SUFFIX.length) + RELEASE_MANIFEST_SUFFIX
}
export const readReleaseManifestFor = async (archivePath: string, fs: UpgradeHostFs = nodeUpgradeFs, ownerUid = 0): Promise<SignedReleaseManifest> => {
  const bytes = await readTrustedFile(fs, releaseManifestPathFor(archivePath), MAX_MANIFEST_BYTES, ownerUid)
  if (bytes === null) return refuse('release-manifest-missing')
  return parseSignedReleaseManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
}
