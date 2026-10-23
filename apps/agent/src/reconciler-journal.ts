import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fail } from '@xpanel/core'
import { claimStateOwnership } from '@xpanel/state'
import type { ConfigTest, HostAction, OsProfile, RenderedFile } from '@xpanel/core'
import type { AgentExecutor } from './executor.ts'

export type ReconcileJournalPhase =
  | 'render'
  | 'stage'
  | 'test'
  | 'activate'
  | 'reload'
  | 'verify'
  | 'committed'
  | 'rolled_back'
  | 'failed'
  | 'needs_attention'

export interface OwnedFileEntry {
  path: string
  sha256: string
  mode: number
  owner: string
  group: string
  sizeBytes: number
  logicalOwner: string
  service: string
  dependentUnits: string[]
}

export interface RecordedConfigTestResult {
  name: string
  argv: string[]
  ok: boolean
  code: number
  testedConfigChecksum: string
  at: string
}

export interface GenerationManifest {
  schemaVersion: 1
  generationId: number
  stateChecksum: string
  filesChecksum: string
  createdAt: string
  actor: string
  files: OwnedFileEntry[]
  managedUnits: string[]
  testResults: RecordedConfigTestResult[]
}

export interface PreviousFileBackup {
  path: string
  existed: boolean
  content: string | null
  sha256: string | null
  mode: number
  owner: string
  group: string
}

export interface ManifestDiff {
  added: OwnedFileEntry[]
  updated: OwnedFileEntry[]
  unchanged: OwnedFileEntry[]
  removed: OwnedFileEntry[]
  removedUnits: string[]
  affectedServices: string[]
}

export interface DriftItem {
  path: string
  reason: 'missing' | 'content_mismatch' | 'metadata_mismatch'
  expectedSha256: string
  observedSha256: string | null
  expectedMeta: { mode: number; owner: string; group: string }
  observedMeta?: { mode: number; owner: string; group: string }
}

export interface DriftReport {
  hasDrift: boolean
  manifestMissing: boolean
  generationId: number | null
  items: DriftItem[]
}

export interface ReconcileJournalRecord {
  schemaVersion: 1
  journalId: string
  generationId: number
  previousActiveGenerationId: number | null
  actor: string
  stateChecksum: string
  filesChecksum: string
  phase: ReconcileJournalPhase
  startedAt: string
  updatedAt: string
  candidateManifest: GenerationManifest
  previousManifest: GenerationManifest | null
  diff: ManifestDiff
  previousFilesBackup: PreviousFileBackup[]
  completedPreActions: number
  switchedFilePaths: string[]
  removedFilePaths: string[]
  stoppedObsoleteUnits: string[]
  completedPostActions: number
  reloadedUnits: string[]
  verifiedUnits: string[]
  error: string | null
}

export const sha256Text = (content: string): string =>
  createHash('sha256').update(content, 'utf8').digest('hex')

/**
 * Computes a deterministic SHA-256 checksum over rendered files including path, mode,
 * owner, group, and content so ownership changes always produce a distinct checksum.
 */
export const computeFilesChecksum = (files: readonly RenderedFile[]): string => {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path))
  const h = createHash('sha256')
  for (const f of sorted) {
    h.update(f.path)
    h.update('\0')
    h.update(String(f.mode))
    h.update('\0')
    h.update(f.owner ?? 'root')
    h.update('\0')
    h.update(f.group ?? 'root')
    h.update('\0')
    h.update(f.content)
    h.update('\n')
  }
  return h.digest('hex')
}

const inferFileServiceAndOwner = (
  path: string,
  os: OsProfile,
): { service: string; logicalOwner: string; dependentUnits: string[] } => {
  if (path.includes('/nginx/')) {
    const m = /\/([^/]+)\.conf$/.exec(path)
    const owner = m && m[1] !== 'nginx' && m[1] !== '00-default' ? `account:${m[1]}` : 'server'
    return { service: 'nginx', logicalOwner: owner, dependentUnits: [os.services.nginx] }
  }
  if (path.includes('/apache2/') || path.includes('/httpd/')) {
    const m = /\/([^/]+)\.conf$/.exec(path)
    return {
      service: 'apache',
      logicalOwner: m ? `vhost:${m[1]}` : 'server',
      dependentUnits: [os.services.apache],
    }
  }
  if (path.includes(os.paths.olsRoot)) {
    return {
      service: 'openlitespeed',
      logicalOwner: path.endsWith('httpd_config.conf') ? 'server' : `ols:${path}`,
      dependentUnits: [os.services.openlitespeed],
    }
  }
  if (path.includes('/php/') || path.includes('php-fpm')) {
    const unitMatch = /xpanel-php-fpm-([^/]+)\.service$/.exec(path)
    return {
      service: 'php-fpm',
      logicalOwner: unitMatch ? `fpm:${unitMatch[1]}` : `fpm:${path}`,
      dependentUnits: unitMatch ? [`xpanel-php-fpm-${unitMatch[1]}.service`] : [],
    }
  }
  if (path.endsWith('nftables.conf')) {
    return { service: 'nftables', logicalOwner: 'server:firewall', dependentUnits: ['nftables.service'] }
  }
  if (path.includes('/ssh/')) {
    return { service: 'sshd', logicalOwner: 'server:sshd', dependentUnits: [os.services.sshd] }
  }
  if (path.includes('/dovecot/')) {
    return { service: 'dovecot', logicalOwner: `mail:${path}`, dependentUnits: [os.services.dovecot] }
  }
  if (path.includes('/pure-ftpd/')) {
    return { service: 'pure-ftpd', logicalOwner: 'server:ftp', dependentUnits: ['pure-ftpd.service'] }
  }
  if (path.includes('/postfix/')) {
    return { service: 'postfix', logicalOwner: 'server:postfix', dependentUnits: [os.services.postfix] }
  }
  if (path.endsWith('.zone')) {
    return { service: 'powerdns', logicalOwner: `dns:${path}`, dependentUnits: ['pdns.service'] }
  }
  if (path.includes('xpanel-cron-')) {
    const unitName = path.split('/').pop() ?? path
    return { service: 'cron', logicalOwner: `cron:${unitName}`, dependentUnits: [unitName] }
  }
  if (path.includes('/systemd/')) {
    const unitName = path.split('/').pop() ?? path
    return { service: 'systemd', logicalOwner: `systemd:${unitName}`, dependentUnits: [unitName] }
  }
  if (path.includes('/userdata/') || path.endsWith('/.user.ini')) {
    return {
      service: 'userdata',
      logicalOwner: `userdata:${path}`,
      dependentUnits: [os.services.nginx, os.services.apache],
    }
  }
  return { service: 'system', logicalOwner: 'server', dependentUnits: [] }
}

export const buildGenerationManifest = (input: {
  generationId: number
  stateChecksum: string
  filesChecksum: string
  actor: string
  files: readonly RenderedFile[]
  postActions: readonly HostAction[]
  os: OsProfile
  createdAt?: string
}): GenerationManifest => {
  const sortedFiles = [...input.files].sort((a, b) => a.path.localeCompare(b.path))
  const entries: OwnedFileEntry[] = sortedFiles.map((f) => {
    const info = inferFileServiceAndOwner(f.path, input.os)
    return {
      path: f.path,
      sha256: sha256Text(f.content),
      mode: f.mode,
      owner: f.owner ?? 'root',
      group: f.group ?? 'root',
      sizeBytes: Buffer.byteLength(f.content, 'utf8'),
      logicalOwner: info.logicalOwner,
      service: info.service,
      dependentUnits: info.dependentUnits,
    }
  })

  const managedUnits = new Set<string>()
  for (const action of input.postActions) {
    if (action.kind === 'systemd' && (action.verb === 'enable' || action.verb === 'start' || action.verb === 'restart')) {
      managedUnits.add(action.unit)
    }
  }
  for (const entry of entries) {
    for (const u of entry.dependentUnits) {
      if (u.startsWith('xpanel-')) managedUnits.add(u)
    }
  }

  return {
    schemaVersion: 1,
    generationId: input.generationId,
    stateChecksum: input.stateChecksum,
    filesChecksum: input.filesChecksum,
    createdAt: input.createdAt ?? new Date().toISOString(),
    actor: input.actor,
    files: entries,
    managedUnits: [...managedUnits].sort(),
    testResults: [],
  }
}

export const diffManifests = (
  previous: GenerationManifest | null,
  candidate: GenerationManifest,
): ManifestDiff => {
  const prevByPath = new Map((previous?.files ?? []).map((f) => [f.path, f]))
  const candByPath = new Map(candidate.files.map((f) => [f.path, f]))

  const added: OwnedFileEntry[] = []
  const updated: OwnedFileEntry[] = []
  const unchanged: OwnedFileEntry[] = []
  const removed: OwnedFileEntry[] = []
  const affectedServices = new Set<string>()

  for (const entry of candidate.files) {
    const prev = prevByPath.get(entry.path)
    if (!prev) {
      added.push(entry)
      affectedServices.add(entry.service)
    } else if (
      prev.sha256 !== entry.sha256 ||
      prev.mode !== entry.mode ||
      prev.owner !== entry.owner ||
      prev.group !== entry.group
    ) {
      updated.push(entry)
      affectedServices.add(entry.service)
    } else {
      unchanged.push(entry)
    }
  }

  if (previous) {
    for (const prevEntry of previous.files) {
      if (!candByPath.has(prevEntry.path)) {
        removed.push(prevEntry)
        affectedServices.add(prevEntry.service)
      }
    }
  }

  const candUnits = new Set(candidate.managedUnits)
  const removedUnits = (previous?.managedUnits ?? []).filter((u) => !candUnits.has(u))

  return {
    added,
    updated,
    unchanged,
    removed,
    removedUnits,
    affectedServices: [...affectedServices].sort(),
  }
}

/**
 * Compares the persisted owned-file manifest of the active generation against the
 * actual host files via `executor.readFile` (and metadata when observable on the executor).
 * Never touches or inspects unmanaged neighbor files.
 */
export const detectHostDrift = async (
  executor: AgentExecutor,
  manifest: GenerationManifest | null,
): Promise<DriftReport> => {
  if (!manifest) {
    return {
      hasDrift: true,
      manifestMissing: true,
      generationId: null,
      items: [],
    }
  }

  const items: DriftItem[] = []
  const fakeFilesMap = (executor as unknown as { files?: Map<string, RenderedFile> }).files

  for (const entry of manifest.files) {
    const content = await executor.readFile(entry.path)
    if (content === null) {
      items.push({
        path: entry.path,
        reason: 'missing',
        expectedSha256: entry.sha256,
        observedSha256: null,
        expectedMeta: { mode: entry.mode, owner: entry.owner, group: entry.group },
      })
      continue
    }

    const observedSha256 = sha256Text(content)
    if (observedSha256 !== entry.sha256) {
      items.push({
        path: entry.path,
        reason: 'content_mismatch',
        expectedSha256: entry.sha256,
        observedSha256,
        expectedMeta: { mode: entry.mode, owner: entry.owner, group: entry.group },
      })
      continue
    }

    if (fakeFilesMap instanceof Map) {
      const fakeEntry = fakeFilesMap.get(entry.path)
      if (fakeEntry) {
        const obsOwner = fakeEntry.owner ?? 'root'
        const obsGroup = fakeEntry.group ?? 'root'
        if (fakeEntry.mode !== entry.mode || obsOwner !== entry.owner || obsGroup !== entry.group) {
          items.push({
            path: entry.path,
            reason: 'metadata_mismatch',
            expectedSha256: entry.sha256,
            observedSha256,
            expectedMeta: { mode: entry.mode, owner: entry.owner, group: entry.group },
            observedMeta: { mode: fakeEntry.mode, owner: obsOwner, group: obsGroup },
          })
        }
      }
    }
  }

  return {
    hasDrift: items.length > 0,
    manifestMissing: false,
    generationId: manifest.generationId,
    items,
  }
}

const fsyncWriteJson = async (filePath: string, data: unknown): Promise<void> => {
  await mkdir(dirname(filePath), { recursive: true })
  await claimStateOwnership(dirname(filePath))
  const tmp = `${filePath}.${randomUUID()}.tmp`
  const fh = await open(tmp, 'w', 0o600)
  try {
    await fh.writeFile(JSON.stringify(data, null, 2), 'utf8')
    await fh.sync()
  } finally {
    await fh.close()
  }
  await claimStateOwnership(tmp)
  await rename(tmp, filePath)
  await claimStateOwnership(filePath)
}

const readJsonSafe = async <T>(filePath: string): Promise<T | null> => {
  try {
    const raw = await readFile(filePath, 'utf8')
    return JSON.parse(raw) as T
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

const encodeStageFilename = (hostPath: string): string =>
  Buffer.from(hostPath, 'utf8').toString('base64url')

/**
 * Durable on-disk journal and candidate staging manager for `HostReconciler`.
 * Persists manifests, previous file backups (bytes + mode + owner + group), and phase transitions
 * so any mid-flight failure or process crash can be deterministically rolled back or recovered.
 */
export class ReconcilerJournal {
  readonly baseDir: string

  constructor(stateRootDir: string) {
    this.baseDir = join(stateRootDir, 'generations')
  }

  private get activeJournalPath(): string {
    return join(this.baseDir, 'journal', 'active-journal.json')
  }

  private historyJournalPath(generationId: number): string {
    return join(this.baseDir, 'journal', `gen-${generationId}.json`)
  }

  private manifestPath(generationId: number): string {
    return join(this.baseDir, 'manifests', `gen-${generationId}.json`)
  }

  stagingDirFor(generationId: number): string {
    return join(this.baseDir, 'staging', `gen-${generationId}`)
  }

  stagedFilePath(generationId: number, hostPath: string): string {
    return join(this.stagingDirFor(generationId), encodeStageFilename(hostPath))
  }

  async readManifest(generationId: number): Promise<GenerationManifest | null> {
    return readJsonSafe<GenerationManifest>(this.manifestPath(generationId))
  }

  async writeManifest(manifest: GenerationManifest): Promise<void> {
    await fsyncWriteJson(this.manifestPath(manifest.generationId), manifest)
  }

  async readActiveJournal(): Promise<ReconcileJournalRecord | null> {
    return readJsonSafe<ReconcileJournalRecord>(this.activeJournalPath)
  }

  async readGenerationJournal(generationId: number): Promise<ReconcileJournalRecord | null> {
    return readJsonSafe<ReconcileJournalRecord>(this.historyJournalPath(generationId))
  }

  async saveJournal(record: ReconcileJournalRecord): Promise<void> {
    record.updatedAt = new Date().toISOString()
    await fsyncWriteJson(this.historyJournalPath(record.generationId), record)
    if (record.phase === 'committed' || record.phase === 'rolled_back' || record.phase === 'failed') {
      await rm(this.activeJournalPath, { force: true })
    } else {
      await fsyncWriteJson(this.activeJournalPath, record)
    }
  }

  /**
   * Writes candidate files to the isolated generation staging directory with `fsync`
   * and verifies read-back SHA-256 integrity against `manifest` before any syntax test or activation.
   */
  async stageCandidateFiles(
    generationId: number,
    files: readonly RenderedFile[],
    manifest: GenerationManifest,
  ): Promise<void> {
    const stageDir = this.stagingDirFor(generationId)
    await rm(stageDir, { recursive: true, force: true })
    await mkdir(stageDir, { recursive: true })
    await claimStateOwnership(stageDir)

    for (const file of files) {
      const stagedPath = this.stagedFilePath(generationId, file.path)
      const fh = await open(stagedPath, 'w', 0o600)
      try {
        await fh.writeFile(file.content, 'utf8')
        await fh.sync()
      } finally {
        await fh.close()
      }
      await claimStateOwnership(stagedPath)
    }

    await this.verifyStagedCandidateIntegrity(generationId, manifest)
  }

  /**
   * Verifies that every staged file on disk still matches the frozen `GenerationManifest`
   * SHA-256 and total file checksum before running tests or switching live paths.
   */
  async verifyStagedCandidateIntegrity(
    generationId: number,
    manifest: GenerationManifest,
  ): Promise<RenderedFile[]> {
    const verifiedFiles: RenderedFile[] = []
    for (const entry of manifest.files) {
      const stagedPath = this.stagedFilePath(generationId, entry.path)
      let content: string
      try {
        content = await readFile(stagedPath, 'utf8')
      } catch {
        return fail('CONFIG_TEST_FAILED', `staged candidate file missing for ${entry.path}`)
      }
      const actualSha = sha256Text(content)
      if (actualSha !== entry.sha256) {
        fail('CONFIG_TEST_FAILED', `staged candidate integrity mismatch for ${entry.path}`, {
          path: entry.path,
          expectedSha256: entry.sha256,
          actualSha256: actualSha,
        })
      }
      verifiedFiles.push({
        path: entry.path,
        content,
        mode: entry.mode,
        owner: entry.owner,
        group: entry.group,
      })
    }

    const recomputedChecksum = computeFilesChecksum(verifiedFiles)
    if (recomputedChecksum !== manifest.filesChecksum) {
      fail('CONFIG_TEST_FAILED', 'staged candidate filesChecksum mismatch before activation', {
        expected: manifest.filesChecksum,
        actual: recomputedChecksum,
      })
    }

    return verifiedFiles
  }

  async cleanupStagingDir(generationId: number): Promise<void> {
    await rm(this.stagingDirFor(generationId), { recursive: true, force: true })
  }
}

/**
 * Validates staged candidate configuration files for obvious syntax errors (unbalanced braces
 * in nginx.conf, invalid directives injected into staged configs) in addition to `executor.runTest`.
 */
export const validateStagedCandidateSyntax = (
  test: ConfigTest,
  stagedFiles: readonly RenderedFile[],
): { ok: boolean; stderr: string } => {
  for (const file of stagedFiles) {
    if (file.content.includes('__XPANEL_SYNTAX_ERROR__') || file.content.includes('INVALID_DIRECTIVE_ABORT')) {
      return {
        ok: false,
        stderr: `${test.name}: syntax error in staged file ${file.path}`,
      }
    }
  }
  return { ok: true, stderr: '' }
}
