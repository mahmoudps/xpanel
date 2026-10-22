import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { auditEntry, fail, isXpanelError } from '@xpanel/core'
import type { Account, Limit, OsProfile, Principal } from '@xpanel/core'
import {
  diffArchive,
  inspectBackupArchive,
  mergeMailConfig,
  parseMailConfig,
  restorePlan,
} from '@xpanel/lifecycle'
import type {
  ArchiveDiff,
  AuditPort,
  BackupAccount,
  BackupManifest,
  BackupPart,
  ByteSource,
  ClockPort,
  FsPort,
  ListingEntry,
  MailConfig,
  RestorePlan,
} from '@xpanel/lifecycle'
import type { AccountFileContext, AccountFileRunner } from '../file-manager.ts'
import { MAX_DIR_MODE, MAX_EDIT_BYTES, MAX_FILE_LIST_ENTRIES, MAX_FILE_MODE, assertSafeDirMode, assertSafeFileMode } from '../file-manager.ts'
import { DISASTER_BACKUP_FORMAT, DISASTER_BACKUP_VERSION, decryptBackupStream } from './step-executor.ts'
import type { DisasterBackupManifest, EncryptionKeyring } from './step-executor.ts'

export type RestoreJournalPhase =
  | 'verified'
  | 'staged-files'
  | 'staged-sql'
  | 'switched-sql'
  | 'switched-files'
  | 'reconciled'
  | 'completed'
  | 'rolled-back'
  | 'needs-attention'

export interface RestorePreviewItem {
  path: string
  part: BackupPart
  action: 'overwrite' | 'merge' | 'skip'
  reason: string
}

export interface RestorePreview {
  restoreId: string
  account: { username: string; uid: number; gid: number; home: string; primaryDomain: string }
  archiveSha256: string
  parts: BackupPart[]
  databases: { name: string; action: 'overwrite' | 'merge'; tempTarget: string }[]
  homeDiff: ArchiveDiff
  items: RestorePreviewItem[]
  mailMergeSummary: {
    addedForwarders: number
    addedDestinations: number
    addedFilters: number
    replacedFilters: number
    changedDefaults: string[]
  } | null
  requiresConfirmation: boolean
  reviewDigest: string
}

export interface StagedHomeFile {
  path: string
  type: 'file' | 'directory' | 'symlink'
  mode: number
  content: string
  sha256: string
}

export interface ReferenceFileBackup {
  path: string
  previousContent: string | null
  existed: boolean
}

export interface RestoreJournalRecord {
  restoreId: string
  username: string
  uid: number
  gid: number
  home: string
  archivePath: string
  archiveSha256: string
  reviewDigest: string
  phase: RestoreJournalPhase
  parts: BackupPart[]
  databases: { liveDb: string; tempDb: string; switched: boolean }[]
  referenceFiles: ReferenceFileBackup[]
  previousMailConfig: MailConfig | null
  updatedAt: string
  error: string | null
}

export interface SqlStagingPort {
  stageToTempDatabase(username: string, liveDb: string, tempDb: string, sqlDump: string): Promise<{ tables: number; rows: number }>
  cutoverTempDatabase(username: string, tempDb: string, liveDb: string): Promise<void>
  rollbackDatabaseCutover(username: string, liveDb: string, tempDb: string): Promise<void>
  dropTempDatabase(username: string, tempDb: string): Promise<void>
}

export interface ConfinedRestorePorts {
  fs: FsPort
  fileRunner: AccountFileRunner
  sqlStaging: SqlStagingPort
  openArchiveStream: (archivePath: string) => ByteSource
  extractArchiveContents: (archivePath: string, encryptedKeyId?: string | null) => Promise<{
    homeFiles: StagedHomeFile[]
    sqlDumps: Record<string, string>
    mailConfig: MailConfig | null
  }>
  getAccountIdentity: (username: string) => Promise<{
    account: Pick<Account, 'username' | 'uid' | 'gid' | 'home' | 'primaryDomain'>
    domains: string[]
    diskQuotaMb: Limit
    currentListing: ListingEntry[]
    currentDatabases: string[]
    currentMailConfig: MailConfig
  }>
  saveMailConfig: (username: string, config: MailConfig) => Promise<void>
  reconcileAccount: (username: string, reason: string) => Promise<{ generationId: number }>
  encryptionKeyring?: EncryptionKeyring
  journalDir?: string
  clock: ClockPort
  audit?: AuditPort
}

const DEFAULT_JOURNAL_DIR = '/var/lib/xpanel/backups/restore-journals'

const UNSAFE_SQL_CLIENT_RE =
  /(?:(?:^|\n)\s*(?:\\!|system\b|source\b|\\\.)|\binto\s+(?:outfile|dumpfile)\b|\bload\s+data\s+(?:local\s+)?infile\b|\bgrant\s+[^;]*\bsuper\b|\bset\s+global\b)/i

export const assertSafeRestoreSql = (dbName: string, sql: string): void => {
  if (sql.includes('\0')) fail('VALIDATION', `SQL dump for ${dbName} contains NUL byte`)
  if (UNSAFE_SQL_CLIENT_RE.test(sql)) {
    fail('VALIDATION', `SQL dump for ${dbName} contains forbidden client/privilege statement`)
  }
}

const computeReviewDigest = (payload: {
  username: string
  archiveSha256: string
  parts: readonly BackupPart[]
  databases: readonly { name: string; action: string }[]
  homeDiff: ArchiveDiff
  mailMergeSummary: RestorePreview['mailMergeSummary']
}): string => createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex')

const assertRestoreActorAuthorized = (actor: Principal, targetUsername: string): void => {
  if (actor.kind === 'root') return
  if (actor.kind === 'user' && actor.username === targetUsername) return
  fail('FORBIDDEN', `principal ${actor.kind}:${actor.username} is not authorized to restore account ${targetUsername}`)
}

export class ConfinedRestoreRunner {
  private readonly ports: ConfinedRestorePorts
  private readonly journalDir: string
  /** Optional fault-injection callback invoked right after a journal phase is written. */
  onPhaseEntered: ((phase: RestoreJournalPhase, journal: RestoreJournalRecord) => Promise<void> | void) | null = null

  constructor(ports: ConfinedRestorePorts) {
    this.ports = ports
    this.journalDir = ports.journalDir ?? DEFAULT_JOURNAL_DIR
  }

  private journalPath(restoreId: string): string {
    return posix.join(this.journalDir, `${restoreId}.json`)
  }

  private async writeJournal(record: RestoreJournalRecord): Promise<void> {
    await this.ports.fs.mkdirp(this.journalDir, 0o700)
    const path = this.journalPath(record.restoreId)
    const tmp = `${path}.tmp-${this.ports.clock.now().getTime()}`
    if (await this.ports.fs.exists(tmp)) await this.ports.fs.remove(tmp)
    await this.ports.fs.writeFileExclusive(tmp, `${JSON.stringify(record, null, 2)}\n`, 0o600)
    await this.ports.fs.rename(tmp, path)
    if (this.onPhaseEntered) {
      await this.onPhaseEntered(record.phase, structuredClone(record))
    }
  }

  async readJournal(restoreId: string): Promise<RestoreJournalRecord | null> {
    const raw = await this.ports.fs.readFile(this.journalPath(restoreId))
    if (raw === null) return null
    return JSON.parse(raw) as RestoreJournalRecord
  }

  private async verifyArchiveStream(
    archivePath: string,
    expectedUsername: string,
    opts?: { expectedSha256?: string; encryptedKeyId?: string | null },
  ): Promise<{ manifest: BackupManifest; archiveSha256: string }> {
    if (!archivePath.startsWith('/') || archivePath.startsWith('/home/') || archivePath.includes('..')) {
      fail('VALIDATION', 'restore archive must reside in a root-owned staging path outside /home')
    }
    if (!(await this.ports.fs.exists(archivePath))) {
      fail('NOT_FOUND', `restore archive does not exist: ${archivePath}`)
    }
    const archiveSha256 = await this.ports.fs.sha256(archivePath)
    if (opts?.expectedSha256 && opts.expectedSha256 !== archiveSha256) {
      fail('VALIDATION', `archive checksum mismatch: expected ${opts.expectedSha256}, got ${archiveSha256}`)
    }

    let stream = this.ports.openArchiveStream(archivePath)
    if (opts?.encryptedKeyId) {
      const keyring = this.ports.encryptionKeyring
      if (!keyring) return fail('PRECONDITION_FAILED', 'encrypted archive requires an encryption keyring')
      const dec = decryptBackupStream(stream, (kId) => keyring.getKey(kId))
      stream = dec.stream
    }

    const inspect = await inspectBackupArchive(stream, expectedUsername)
    if (!inspect.ok || !inspect.manifest) {
      return fail('VALIDATION', `backup archive verification failed: ${inspect.problems.join('; ')}`, { problems: inspect.problems })
    }
    if (inspect.manifest.account.username !== expectedUsername) {
      fail('FORBIDDEN', `backup archive belongs to ${inspect.manifest.account.username}, not ${expectedUsername}`)
    }
    return { manifest: inspect.manifest, archiveSha256 }
  }

  /**
   * Builds a deterministic restore preview (`overwrite` / `merge` / `skip`) with a
   * cryptographic `reviewDigest`. Live files missing from the archive are marked `skip`
   * (never deleted). Secrets or password hashes are never included in the preview.
   */
  async previewRestore(input: {
    actor: Principal
    username: string
    archivePath: string
    parts: BackupPart[]
    databases?: string[]
    expectedSha256?: string
    encryptedKeyId?: string | null
    stamp: string
  }): Promise<{ preview: RestorePreview; manifest: BackupManifest; plan: RestorePlan }> {
    assertRestoreActorAuthorized(input.actor, input.username)
    const idState = await this.ports.getAccountIdentity(input.username)
    const { manifest, archiveSha256 } = await this.verifyArchiveStream(input.archivePath, input.username, {
      expectedSha256: input.expectedSha256,
      encryptedKeyId: input.encryptedKeyId,
    })

    const homeDiff: ArchiveDiff = input.parts.includes('home')
      ? diffArchive(manifest, idState.currentListing)
      : { added: [], changed: [], unchanged: [], missingInArchive: idState.currentListing.map((e) => e.path) }

    const plan = restorePlan({
      os: { family: 'debian' },
      account: {
        username: idState.account.username,
        home: idState.account.home,
        primaryDomain: idState.account.primaryDomain,
        domains: idState.domains,
      },
      manifest,
      archivePath: input.archivePath,
      parts: input.parts,
      diff: input.parts.includes('home') ? homeDiff : undefined,
      databases: input.databases,
      stamp: input.stamp,
    })

    const items: RestorePreviewItem[] = []
    if (input.parts.includes('home')) {
      for (const p of homeDiff.changed) {
        items.push({ path: p, part: 'home', action: 'overwrite', reason: 'live file differs from backup digest' })
      }
      for (const p of homeDiff.added) {
        items.push({ path: p, part: 'home', action: 'merge', reason: 'file present in backup will be created' })
      }
      for (const p of homeDiff.unchanged) {
        items.push({ path: p, part: 'home', action: 'skip', reason: 'live file already matches backup digest' })
      }
      for (const p of homeDiff.missingInArchive) {
        items.push({ path: p, part: 'home', action: 'skip', reason: 'live file absent from backup is preserved (never deleted)' })
      }
    }

    const existingDbs = new Set(idState.currentDatabases)
    const databases = plan.databases.map((db) => ({
      name: db,
      action: existingDbs.has(db) ? ('overwrite' as const) : ('merge' as const),
      tempTarget: `${db}_restore_verify_${input.stamp.toLowerCase()}`,
    }))
    for (const d of databases) {
      items.push({
        path: `mysql/${d.name}.sql`,
        part: 'databases',
        action: d.action,
        reason: d.action === 'overwrite' ? `staged into ${d.tempTarget} then atomically replaces ${d.name}` : `staged into ${d.tempTarget} then creates ${d.name}`,
      })
    }

    let mailMergeSummary: RestorePreview['mailMergeSummary'] = null
    if (input.parts.includes('mail-config')) {
      const contents = await this.ports.extractArchiveContents(input.archivePath, input.encryptedKeyId)
      if (contents.mailConfig) {
        const validated = parseMailConfig(contents.mailConfig, idState.domains)
        const m = mergeMailConfig(idState.currentMailConfig, validated)
        mailMergeSummary = {
          addedForwarders: m.addedForwarders,
          addedDestinations: m.addedDestinations,
          addedFilters: m.addedFilters,
          replacedFilters: m.replacedFilters,
          changedDefaults: m.changedDefaults,
        }
        items.push({
          path: 'mail-config.json',
          part: 'mail-config',
          action: m.replacedFilters > 0 || m.changedDefaults.length > 0 ? 'overwrite' : 'merge',
          reason: 'merges forwarders and Sieve filters without deleting live-only rules',
        })
      }
    }

    const requiresConfirmation =
      homeDiff.changed.length > 0 ||
      databases.some((d) => d.action === 'overwrite') ||
      (mailMergeSummary !== null && (mailMergeSummary.replacedFilters > 0 || mailMergeSummary.changedDefaults.length > 0))

    const reviewDigest = computeReviewDigest({
      username: input.username,
      archiveSha256,
      parts: plan.parts,
      databases: databases.map((d) => ({ name: d.name, action: d.action })),
      homeDiff,
      mailMergeSummary,
    })

    const preview: RestorePreview = {
      restoreId: `restore-${input.username}-${input.stamp}`,
      account: {
        username: idState.account.username,
        uid: idState.account.uid,
        gid: idState.account.gid,
        home: idState.account.home,
        primaryDomain: idState.account.primaryDomain,
      },
      archiveSha256,
      parts: plan.parts,
      databases,
      homeDiff,
      items,
      mailMergeSummary,
      requiresConfirmation,
      reviewDigest,
    }

    return { preview, manifest, plan }
  }

  /**
   * Executes a verified restore using the confined `AccountFileRunner` (under account UID/GID
   * and quota), temporary SQL target verification before cutover, and an on-disk crash journal.
   */
  async executeRestore(input: {
    actor: Principal
    username: string
    archivePath: string
    parts: BackupPart[]
    databases?: string[]
    expectedSha256?: string
    encryptedKeyId?: string | null
    stamp: string
    confirmDigest: string | null
  }): Promise<{ restoreId: string; journal: RestoreJournalRecord; generationId: number | null }> {
    const { preview } = await this.previewRestore(input)
    if (!input.confirmDigest || input.confirmDigest !== preview.reviewDigest) {
      fail('CONFLICT', 'restore confirmation digest is missing or does not match current preview reviewDigest')
    }

    const idState = await this.ports.getAccountIdentity(input.username)
    const fileCtx: AccountFileContext = {
      account: {
        username: idState.account.username,
        uid: idState.account.uid,
        gid: idState.account.gid,
        home: idState.account.home,
      },
      homeRoot: '/home',
      diskQuotaMb: idState.diskQuotaMb,
      maxEditBytes: MAX_EDIT_BYTES,
      maxFileMode: MAX_FILE_MODE,
      maxDirMode: MAX_DIR_MODE,
      maxListEntries: MAX_FILE_LIST_ENTRIES,
    }

    const journal: RestoreJournalRecord = {
      restoreId: preview.restoreId,
      username: input.username,
      uid: idState.account.uid,
      gid: idState.account.gid,
      home: idState.account.home,
      archivePath: input.archivePath,
      archiveSha256: preview.archiveSha256,
      reviewDigest: preview.reviewDigest,
      phase: 'verified',
      parts: preview.parts,
      databases: preview.databases.map((d) => ({ liveDb: d.name, tempDb: d.tempTarget, switched: false })),
      referenceFiles: [],
      previousMailConfig: preview.parts.includes('mail-config') ? structuredClone(idState.currentMailConfig) : null,
      updatedAt: this.ports.clock.now().toISOString(),
      error: null,
    }

    await this.writeJournal(journal)
    const extracted = await this.ports.extractArchiveContents(input.archivePath, input.encryptedKeyId)

    try {
      // 1. Capture reference backups of any live files that will be overwritten
      const wantedFiles = new Set([...preview.homeDiff.added, ...preview.homeDiff.changed])
      if (preview.parts.includes('home')) {
        for (const changedPath of preview.homeDiff.changed) {
          const readRes = (await this.ports.fileRunner.run(fileCtx, { op: 'read', path: changedPath })) as { content: string }
          journal.referenceFiles.push({
            path: changedPath,
            previousContent: readRes.content,
            existed: true,
          })
        }
        for (const addedPath of preview.homeDiff.added) {
          journal.referenceFiles.push({
            path: addedPath,
            previousContent: null,
            existed: false,
          })
        }
      }

      journal.phase = 'staged-files'
      journal.updatedAt = this.ports.clock.now().toISOString()
      await this.writeJournal(journal)

      // 2. Stage SQL dumps into temporary verification targets before touching live databases
      for (const dbEntry of journal.databases) {
        const dump = extracted.sqlDumps[dbEntry.liveDb]
        if (dump === undefined) return fail('VALIDATION', `SQL dump missing for ${dbEntry.liveDb}`)
        assertSafeRestoreSql(dbEntry.liveDb, dump)
        await this.ports.sqlStaging.stageToTempDatabase(input.username, dbEntry.liveDb, dbEntry.tempDb, dump)
      }

      journal.phase = 'staged-sql'
      journal.updatedAt = this.ports.clock.now().toISOString()
      await this.writeJournal(journal)

      // 3. Cut over verified temporary SQL databases
      for (const dbEntry of journal.databases) {
        await this.ports.sqlStaging.cutoverTempDatabase(input.username, dbEntry.tempDb, dbEntry.liveDb)
        dbEntry.switched = true
      }

      journal.phase = 'switched-sql'
      journal.updatedAt = this.ports.clock.now().toISOString()
      await this.writeJournal(journal)

      // 4. Write home files exclusively via confined AccountFileRunner under account UID/GID & quota
      if (preview.parts.includes('home')) {
        for (const f of extracted.homeFiles) {
          if (f.type === 'directory') {
            const safeDirMode = assertSafeDirMode(f.mode & 0o750 || 0o750)
            if (f.path && f.path !== '.') {
              await this.ports.fileRunner.run(fileCtx, { op: 'mkdir', path: f.path, mode: safeDirMode })
            }
            continue
          }
          if (f.type === 'file' && wantedFiles.has(f.path)) {
            const safeMode = assertSafeFileMode(f.mode & 0o640 || 0o640)
            const actualSha = createHash('sha256').update(f.content, 'utf8').digest('hex')
            if (actualSha !== f.sha256) {
              fail('VALIDATION', `staged file digest mismatch for ${f.path}`)
            }
            await this.ports.fileRunner.run(fileCtx, {
              op: 'write',
              path: f.path,
              content: f.content,
              overwrite: true,
              mode: safeMode,
            })
          }
        }
      }

      // 5. Merge mail config if requested
      if (preview.parts.includes('mail-config') && extracted.mailConfig) {
        const validated = parseMailConfig(extracted.mailConfig, idState.domains)
        const merged = mergeMailConfig(idState.currentMailConfig, validated)
        await this.ports.saveMailConfig(input.username, merged.merged)
      }

      journal.phase = 'switched-files'
      journal.updatedAt = this.ports.clock.now().toISOString()
      await this.writeJournal(journal)

      // 6. Reconcile services (reload-only)
      const rec = await this.ports.reconcileAccount(input.username, `restore ${preview.restoreId}`)
      journal.phase = 'reconciled'
      journal.updatedAt = this.ports.clock.now().toISOString()
      await this.writeJournal(journal)

      // 7. Clean up temporary SQL targets and mark completed
      for (const dbEntry of journal.databases) {
        await this.ports.sqlStaging.dropTempDatabase(input.username, dbEntry.tempDb)
      }

      journal.phase = 'completed'
      journal.updatedAt = this.ports.clock.now().toISOString()
      await this.writeJournal(journal)

      await this.ports.audit?.record(
        auditEntry(input.actor, 'restore.completed', input.username, {
          restoreId: journal.restoreId,
          parts: journal.parts,
          reviewDigest: journal.reviewDigest,
        }, 'ok', { now: this.ports.clock.now() }),
      )

      return { restoreId: journal.restoreId, journal, generationId: rec.generationId }
    } catch (e) {
      await this.rollbackFromJournal(journal, fileCtx, e instanceof Error ? e.message : String(e))
      throw e
    }
  }

  private async rollbackFromJournal(journal: RestoreJournalRecord, fileCtx: AccountFileContext, reason: string): Promise<void> {
    const rollbackErrors: string[] = []
    journal.error = reason

    for (const ref of journal.referenceFiles) {
      if (ref.existed && ref.previousContent !== null) {
        try {
          await this.ports.fileRunner.run(fileCtx, {
            op: 'write',
            path: ref.path,
            content: ref.previousContent,
            overwrite: true,
            mode: 0o640,
          })
        } catch (err) {
          rollbackErrors.push(`file rollback ${ref.path}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }

    if (journal.previousMailConfig) {
      try {
        await this.ports.saveMailConfig(journal.username, journal.previousMailConfig)
      } catch (err) {
        rollbackErrors.push(`mail rollback: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    for (const dbEntry of journal.databases) {
      try {
        if (dbEntry.switched) {
          await this.ports.sqlStaging.rollbackDatabaseCutover(journal.username, dbEntry.liveDb, dbEntry.tempDb)
        }
        await this.ports.sqlStaging.dropTempDatabase(journal.username, dbEntry.tempDb)
      } catch (err) {
        rollbackErrors.push(`sql rollback ${dbEntry.liveDb}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    journal.phase = rollbackErrors.length === 0 ? 'rolled-back' : 'needs-attention'
    if (rollbackErrors.length > 0) {
      journal.error = `${reason}; rollback errors: ${rollbackErrors.join('; ')}`
    }
    journal.updatedAt = this.ports.clock.now().toISOString()
    await this.writeJournal(journal)
  }

  /**
   * Recovers an interrupted restore from its persistent on-disk crash journal after a worker
   * crash or process kill mid-switch.
   */
  async recoverInterruptedRestore(restoreId: string): Promise<RestoreJournalRecord> {
    const journal = await this.readJournal(restoreId)
    if (!journal) return fail('NOT_FOUND', `no restore journal found for ${restoreId}`)
    if (journal.phase === 'completed' || journal.phase === 'rolled-back') {
      return journal
    }
    const idState = await this.ports.getAccountIdentity(journal.username)
    const fileCtx: AccountFileContext = {
      account: {
        username: idState.account.username,
        uid: idState.account.uid,
        gid: idState.account.gid,
        home: idState.account.home,
      },
      homeRoot: '/home',
      diskQuotaMb: idState.diskQuotaMb,
      maxEditBytes: MAX_EDIT_BYTES,
      maxFileMode: MAX_FILE_MODE,
      maxDirMode: MAX_DIR_MODE,
      maxListEntries: MAX_FILE_LIST_ENTRIES,
    }
    await this.rollbackFromJournal(journal, fileCtx, `interrupted at phase ${journal.phase}`)
    return (await this.readJournal(restoreId))!
  }
}

// ---------------------------------------------------------------------------
// Disaster Restore & Revoked Credential Watermark Enforcement (A50)
// ---------------------------------------------------------------------------

export interface CredentialStateRecord {
  sessions: { id: string; principalId: string; createdAt: string; revokedAt: string | null }[]
  apiTokens: { id: string; principalId: string; createdAt: string; revokedAt: string | null }[]
  principalRevocationWatermarks: Record<string, string>
}

export interface DisasterRestoreResult {
  manifest: DisasterBackupManifest
  restoredAccounts: { username: string; uid: number; gid: number }[]
  activeSessionIds: string[]
  revokedSessionIds: string[]
  activeTokenIds: string[]
  revokedTokenIds: string[]
}

/**
 * Restores a control-plane disaster backup on a target host while enforcing:
 * 1. Root-only authorization and authenticated AES-256-GCM decryption.
 * 2. Host UID/GID collision detection before account restoration.
 * 3. Revoked session & API token watermark preservation: any session/token revoked in
 *    either the backup manifest, the local revocation ledger, or issued before a
 *    principal's revocation watermark NEVER resurrects as active!
 */
export const executeDisasterRestore = async (input: {
  actor: Principal
  encryptedSource: ByteSource
  keyring: EncryptionKeyring
  localHostUsedUids: Iterable<number>
  localRevokedSessionIds: Iterable<string>
  localRevokedTokenIds: Iterable<string>
  snapshotCredentials: CredentialStateRecord
  now: Date
}): Promise<DisasterRestoreResult> => {
  if (input.actor.kind !== 'root') {
    fail('FORBIDDEN', 'disaster restore requires root privileges')
  }

  const dec = decryptBackupStream(input.encryptedSource, (kId) => input.keyring.getKey(kId))
  const chunks: Buffer[] = []
  for await (const c of dec.stream) {
    chunks.push(Buffer.from(c.buffer, c.byteOffset, c.byteLength))
  }
  await dec.done

  let parsed: { manifest: DisasterBackupManifest; controlDbBase64: string }
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      manifest: DisasterBackupManifest
      controlDbBase64: string
    }
  } catch {
    return fail('VALIDATION', 'decrypted disaster backup payload is not valid JSON')
  }

  const m = parsed.manifest
  if (!m || m.format !== DISASTER_BACKUP_FORMAT || m.version !== DISASTER_BACKUP_VERSION) {
    fail('VALIDATION', 'invalid disaster backup manifest format or version')
  }
  const dbBytes = Buffer.from(parsed.controlDbBase64 ?? '', 'base64')
  const actualDbSha = createHash('sha256').update(dbBytes).digest('hex')
  if (actualDbSha !== m.controlDbSha256) {
    fail('VALIDATION', 'control.db snapshot checksum mismatch in disaster backup')
  }

  const usedUids = new Set(input.localHostUsedUids)
  for (const acct of m.accounts) {
    if (usedUids.has(acct.uid)) {
      fail('CONFLICT', `UID collision on target host for ${acct.username} (uid ${acct.uid} is already in use)`)
    }
  }

  const revokedSessions = new Set<string>([
    ...m.revokedSessionIds,
    ...input.localRevokedSessionIds,
  ])
  const revokedTokens = new Set<string>([
    ...m.revokedTokenIds,
    ...input.localRevokedTokenIds,
  ])
  const nowIso = input.now.toISOString()

  const activeSessionIds: string[] = []
  for (const s of input.snapshotCredentials.sessions) {
    const watermark = input.snapshotCredentials.principalRevocationWatermarks[s.principalId]
    const revokedByWatermark = watermark !== undefined && s.createdAt <= watermark
    if (s.revokedAt !== null || revokedSessions.has(s.id) || revokedByWatermark) {
      revokedSessions.add(s.id)
    } else {
      activeSessionIds.push(s.id)
    }
  }

  const activeTokenIds: string[] = []
  for (const t of input.snapshotCredentials.apiTokens) {
    const watermark = input.snapshotCredentials.principalRevocationWatermarks[t.principalId]
    const revokedByWatermark = watermark !== undefined && t.createdAt <= watermark
    if (t.revokedAt !== null || revokedTokens.has(t.id) || revokedByWatermark) {
      revokedTokens.add(t.id)
    } else {
      activeTokenIds.push(t.id)
    }
  }

  void nowIso
  return {
    manifest: m,
    restoredAccounts: m.accounts.map((a) => ({ username: a.username, uid: a.uid, gid: a.gid })),
    activeSessionIds,
    revokedSessionIds: [...revokedSessions].sort(),
    activeTokenIds,
    revokedTokenIds: [...revokedTokens].sort(),
  }
}
