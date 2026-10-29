import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { link, open, readdir, statfs, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { fail } from '@xpanel/core'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import { backupDestinationProofCurrent, backupDestinationTargetDigest, backupScheduleDue, isBackupCredentialRef, nextBackupCronRun, parseBackupCron, readBackupCredentialProfiles, readBackupDestinationProof } from '../../../packages/core/src/backup-destination.ts'
import type { BackupCredentialProfile, BackupCron, BackupDestinationProof, BackupDestinationTarget } from '../../../packages/core/src/backup-destination.ts'
import { DEFAULT_BACKUP_DIR, listAccountBackups, MAX_BACKUP_BYTES, openAccountBackupArchive } from './account-backup.ts'
import { buildControlSnapshot, buildServerBackupArchive, listControlSnapshot, listServerBackupArchive } from './acct-backup-archive.ts'
import type { BackupArchiveBuildDeps, BackupArchiveListing } from './acct-backup-archive.ts'
import { runBackupCommand } from './backup-low-priority.ts'
import type { BackupCommandRunner } from './backup-low-priority.ts'
import type { BackupAccountTarget } from './account-backup.ts'
import type { AgentExecutor } from './executor.ts'
import { withPinnedHostTargetParent } from './host-target-parent.ts'
import { BACKUP_CONTROL, BACKUP_RUN_LIMITS, backupArchiveName, backupRunDetail, backupRunLedgerRevision, parseBackupArchiveName, planBackupRetention, readBackupRunLedger } from './acct-backup-plan.ts'
import type { BackupPartRestore, BackupPartRestoreItem, BackupRecovery, BackupRemoteArchive, BackupRetentionKeep, BackupRetentionRow, BackupRun, BackupRunArchive, BackupRunEntry, BackupRunLedger, BackupRunsView, BackupStorageSpace } from './acct-backup-plan.ts'
import { BACKUP_TRANSFER_KINDS } from './acct-backup-s3.ts'
import type { BackupArchiveSource, BackupTransferProvider, BackupTransferSession } from './acct-backup-s3.ts'

export const BACKUP_RUN_LEDGER_PATH = '/var/lib/xpanel/backup-runs.json'
export const BACKUP_TRANSFER_TIMEOUT_MS = 30 * 60_000
const MAX_RUN_ACCOUNTS = 1000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const USERNAME = /^[a-z][a-z0-9]{0,15}$/
const HEX = /^[0-9a-f]{64}$/

export interface BackupRunAccount extends BackupAccountTarget { id: string }
interface SavedDestination { target: BackupDestinationTarget; enabled: boolean; verification: BackupDestinationProof | null }
interface SavedSchedule { enabled: boolean; cron: string; parsed: BackupCron; retentionCount: number; retentionWeekly: number; retentionMonthly: number; includeMail: boolean; includeDatabases: boolean; includeDns: boolean; includeControl: boolean; selectedAccounts: 'all' | string[]; destinationIds: string[]; updatedAt: string }
export interface SavedBackupConfig { destinations: SavedDestination[]; schedule: SavedSchedule | null }
interface ActiveDestination { target: BackupDestinationTarget; profile: BackupCredentialProfile }
export interface BackupRetentionPreview { destinationId: string; retentionDays: number; keep: BackupRetentionKeep; planDigest: string; rows: BackupRetentionRow[] }

const invalidConfig = (): never => { throw new Error('invalid_backup_configuration') }
const object = (raw: unknown): raw is Record<string, unknown> => !!raw && typeof raw === 'object' && !Array.isArray(raw)
const textOrNull = (raw: unknown, max: number): string | null => raw === null || raw === undefined ? null : typeof raw === 'string' && raw.length <= max ? raw : invalidConfig()
/** Reads the API-published destination and schedule files; anything outside the saved grammar makes the configuration unavailable. */
export function readSavedBackupConfig(raw: { destinations: unknown; schedule: unknown }): SavedBackupConfig {
  const destinations = raw.destinations === null ? [] : Array.isArray(raw.destinations) && raw.destinations.length <= 50 ? raw.destinations.map(item => {
    if (!object(item) || typeof item.id !== 'string' || !UUID.test(item.id) || typeof item.name !== 'string' || !['s3', 'sftp', 'rsync', 'backblaze', 'ftp', 'local'].includes(item.kind as string) || typeof item.endpoint !== 'string'
      || typeof item.pathPrefix !== 'string' || typeof item.retentionDays !== 'number' || !Number.isSafeInteger(item.retentionDays) || item.retentionDays < 1 || item.retentionDays > 3650 || typeof item.enabled !== 'boolean'
      || typeof item.createdAt !== 'string' || !(item.credentialRef === undefined || item.credentialRef === null || isBackupCredentialRef(item.credentialRef))) return invalidConfig()
    const target: BackupDestinationTarget = { id: item.id, name: item.name, kind: item.kind as BackupDestinationTarget['kind'], endpoint: item.endpoint, bucket: textOrNull(item.bucket, 255), region: textOrNull(item.region, 64), pathPrefix: item.pathPrefix, username: textOrNull(item.username, 128), retentionDays: item.retentionDays, createdAt: item.createdAt, credentialRef: (item.credentialRef as string | null | undefined) ?? null }
    return { target, enabled: item.enabled, verification: readBackupDestinationProof(item.verification ?? null) }
  }) : invalidConfig()
  if (new Set(destinations.map(item => item.target.id)).size !== destinations.length) invalidConfig()
  if (raw.schedule === null) return { destinations, schedule: null }
  // Fields added later read with the API's defaults, as the API reads the same file.
  const s = object(raw.schedule) ? { retentionWeekly: 4, retentionMonthly: 0, includeDns: true, includeControl: true, ...raw.schedule } : raw.schedule
  if (!object(s) || typeof s.enabled !== 'boolean' || typeof s.cron !== 'string' || typeof s.retentionCount !== 'number' || !Number.isSafeInteger(s.retentionCount) || s.retentionCount < 1 || s.retentionCount > 3650 || typeof s.includeMail !== 'boolean' || typeof s.includeDatabases !== 'boolean' || typeof s.includeDns !== 'boolean' || typeof s.includeControl !== 'boolean'
    || [s.retentionWeekly, s.retentionMonthly].some(value => typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 3650)
    || !(s.selectedAccounts === 'all' || Array.isArray(s.selectedAccounts) && s.selectedAccounts.length <= 10_000 && s.selectedAccounts.every(value => typeof value === 'string' && value.length <= 64))
    || !Array.isArray(s.destinationIds) || s.destinationIds.length > 50 || s.destinationIds.some(value => typeof value !== 'string' || !UUID.test(value)) || typeof s.updatedAt !== 'string' || !Number.isFinite(Date.parse(s.updatedAt))) return invalidConfig()
  return { destinations, schedule: { enabled: s.enabled, cron: s.cron, parsed: parseBackupCron(s.cron), retentionCount: s.retentionCount, retentionWeekly: s.retentionWeekly as number, retentionMonthly: s.retentionMonthly as number, includeMail: s.includeMail, includeDatabases: s.includeDatabases, includeDns: s.includeDns, includeControl: s.includeControl, selectedAccounts: s.selectedAccounts === 'all' ? 'all' : [...s.selectedAccounts as string[]], destinationIds: [...s.destinationIds as string[]], updatedAt: s.updatedAt } }
}
const backupConfigPath = (stateRoot: string, file: string): string => join(stateRoot, 'extended', 'backups', file)
export const readBackupConfigFiles = (stateRoot: string) => async (): Promise<{ destinations: unknown; schedule: unknown }> => ({
  destinations: await readJsonIfExists<unknown>(backupConfigPath(stateRoot, 'destinations.json')), schedule: await readJsonIfExists<unknown>(backupConfigPath(stateRoot, 'schedule.json')) })
/** deps.readBackupDestination for the probe route and the S3 provider: the saved target only, never request data. */
export const readSavedBackupDestination = (readConfig: () => Promise<{ destinations: unknown; schedule: unknown }>) => async (id: string): Promise<BackupDestinationTarget | null> =>
  readSavedBackupConfig(await readConfig()).destinations.find(item => item.target.id === id)?.target ?? null

const sha256Of = async (chunks: AsyncIterable<Uint8Array>, maxBytes: number): Promise<{ bytes: number; sha256: string }> => {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of chunks) { bytes += chunk.byteLength; if (bytes > maxBytes) throw new Error('archive_limit'); hash.update(chunk) }
  return { bytes, sha256: hash.digest('hex') }
}
async function* handleChunks(handle: FileHandle, bytes: number): AsyncIterable<Uint8Array> {
  const buffer = Buffer.alloc(1024 * 1024)
  let remaining = bytes
  try {
    while (remaining > 0) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, remaining), null)
      if (bytesRead <= 0) throw new Error('archive_truncated')
      remaining -= bytesRead
      yield Buffer.from(buffer.subarray(0, bytesRead))
    }
  } finally { await handle.close() }
}
/** Local archive as an upload source: digested once, then re-opened (same size, no links) for each transfer. */
export async function localBackupArchiveSource(root: string, account: BackupAccountTarget, file: string): Promise<BackupArchiveSource> {
  const first = await openAccountBackupArchive(root, account, file)
  const digest = await sha256Of(handleChunks(first.handle, first.bytes), MAX_BACKUP_BYTES)
  return { ...digest, path: posix.join(root, account.username, file), chunks: async function* () {
    const again = await openAccountBackupArchive(root, account, file)
    if (again.bytes !== digest.bytes) { await again.handle.close(); throw new Error('archive_changed') }
    yield* handleChunks(again.handle, again.bytes)
  } }
}
/** A root-owned regular file (the control snapshot) as an upload source, digested once and re-opened per transfer. */
export async function localFileSource(path: string): Promise<BackupArchiveSource> {
  const openFile = async (): Promise<{ handle: FileHandle; bytes: number }> => {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1 || info.size <= 0 || info.size > MAX_BACKUP_BYTES) { await handle.close(); return fail('PRECONDITION_FAILED', 'the snapshot must be a single regular file within 2 GiB') }
    return { handle, bytes: info.size }
  }
  const first = await openFile()
  const digest = await sha256Of(handleChunks(first.handle, first.bytes), MAX_BACKUP_BYTES)
  return { ...digest, path, chunks: async function* () {
    const again = await openFile()
    if (again.bytes !== digest.bytes) { await again.handle.close(); throw new Error('archive_changed') }
    yield* handleChunks(again.handle, again.bytes)
  } }
}
/** Streams a recovered archive beside the local archives; the name publishes only after size and sha256 match, never over an existing file. */
export async function storeRecoveredBackupArchive(root: string, username: string, file: string, chunks: AsyncIterable<Uint8Array>, expected: { bytes: number; sha256: string }): Promise<'recovered' | 'exists' | 'mismatch'> {
  const destination = posix.join(root, username, backupArchiveName(username, file).split('/')[1]!)
  return withPinnedHostTargetParent(destination, async pinned => {
    const temporary = posix.join(dirname(pinned), '.recover-' + randomUUID())
    const output = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    let closed = false
    try {
      const hash = createHash('sha256')
      let bytes = 0
      for await (const chunk of chunks) {
        bytes += chunk.byteLength
        if (bytes > expected.bytes) return 'mismatch'
        hash.update(chunk)
        let offset = 0
        while (offset < chunk.byteLength) { const { bytesWritten } = await output.write(chunk.subarray(offset)); if (bytesWritten <= 0) throw new Error('recover_write'); offset += bytesWritten }
      }
      if (bytes !== expected.bytes || hash.digest('hex') !== expected.sha256) return 'mismatch'
      await output.sync(); await output.close(); closed = true
      try { await link(temporary, pinned) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists'; throw error }
      if (process.platform === 'linux') { const parent = await open(dirname(pinned), constants.O_RDONLY | constants.O_DIRECTORY); try { await parent.sync() } finally { await parent.close() } }
      return 'recovered'
    } finally {
      if (!closed) await output.close().catch(() => undefined)
      await unlink(temporary).catch(() => undefined)
    }
  })
}

export interface BackupRunDeps {
  readConfig(): Promise<{ destinations: unknown; schedule: unknown }>
  provider: BackupTransferProvider | null
  listAccounts(): Promise<readonly BackupRunAccount[]>
  /** buildServerBackupArchive on a Linux host; null where account archives cannot be created. */
  createBackup: ((account: BackupRunAccount, options: { excludeMail: boolean; includeDatabases: boolean; includeDns: boolean }) => Promise<{ file: string; bytes: number; databases: string[]; zones: string[] }>) | null
  /** Integrity read of a local archive (listServerBackupArchive); throws when it fails. */
  verifyArchive(account: BackupRunAccount, file: string): Promise<BackupArchiveListing>
  readLocalArchive(account: BackupRunAccount, file: string): Promise<BackupArchiveSource>
  /** Local archives of one account as `<username>/<file>` names, for retention. */
  listLocalArchives(account: BackupRunAccount): Promise<BackupRemoteArchive[]>
  deleteLocalArchive(account: BackupRunAccount, file: string): Promise<void>
  /** Once-per-run control-state snapshot (build, integrity read, source, list, delete); null where it cannot be taken. */
  control?: {
    build(): Promise<{ file: string; bytes: number }>; verify(file: string): Promise<unknown>; read(file: string): Promise<BackupArchiveSource>
    list(): Promise<BackupRemoteArchive[]>; delete(file: string): Promise<void>
  } | null
  /** Space on the local archive filesystem; null where it cannot be read. */
  storage?: () => Promise<BackupStorageSpace | null>
  /** Ensures the root-only account archive directory, then stores through storeRecoveredBackupArchive. */
  storeRecovered(account: BackupRunAccount, file: string, chunks: AsyncIterable<Uint8Array>, expected: { bytes: number; sha256: string }): Promise<'recovered' | 'exists' | 'mismatch'>
  readLedger(): Promise<unknown>
  writeLedger(ledger: BackupRunLedger): Promise<void>
  now?: () => Date
  transferTimeoutMs?: number
}
export const backupLedgerFile = (path = BACKUP_RUN_LEDGER_PATH) => ({ readLedger: () => readJsonIfExists<unknown>(path), writeLedger: (ledger: BackupRunLedger) => atomicWriteJson(path, ledger, 0o600) })
export const defaultBackupArchiveRoot = (): string => process.env.XPANEL_BACKUP_DIR || DEFAULT_BACKUP_DIR
/** Defaults for a per-account backup when no schedule is saved: everything included, kept on this server. */
const ACCOUNT_DEFAULTS = { includeMail: true, includeDatabases: true, includeDns: true, destinationIds: [] as string[] }

/** One backup operation (run, retention apply, recovery or restore) at a time in this agent process; ROOT keeps a single instance. */
export function createBackupRunController(deps: BackupRunDeps) {
  const now = deps.now ?? (() => new Date())
  let active: { id: string; done: Promise<void> } | null = null
  const signal = (): AbortSignal => AbortSignal.timeout(deps.transferTimeoutMs ?? BACKUP_TRANSFER_TIMEOUT_MS)
  const ledger = async (): Promise<BackupRunLedger> => {
    const saved = readBackupRunLedger(await deps.readLedger())
    // A running record not owned by this process was interrupted; its outcome is unknown, never failed or succeeded.
    return { ...saved, runs: saved.runs.map(run => run.state === 'running' && run.id !== active?.id ? { ...run, state: 'unknown' as const } : run),
      recoveries: saved.recoveries.map(item => item.state === 'running' && item.id !== active?.id ? { ...item, state: 'unknown' as const, reason: 'interrupted' as const } : item),
      restores: saved.restores.map(item => item.state === 'running' && item.id !== active?.id ? { ...item, state: 'unknown' as const } : item) }
  }
  const config = async (): Promise<SavedBackupConfig | null> => { try { return readSavedBackupConfig(await deps.readConfig()) } catch { return null } }
  const activeDestinations = async (saved: SavedBackupConfig, ids: readonly string[], requireEnabled = true): Promise<ActiveDestination[]> => {
    if (!deps.provider || !ids.length) return []
    let profiles: BackupCredentialProfile[]
    try { profiles = readBackupCredentialProfiles(await deps.provider.profiles(AbortSignal.timeout(5000))) } catch { return [] }
    return ids.flatMap(id => {
      const destination = saved.destinations.find(item => item.target.id === id)
      const profile = destination && profiles.find(item => item.ref === destination.target.credentialRef && item.kinds.includes(destination.target.kind as BackupCredentialProfile['kinds'][number]))
      return destination && profile && (destination.enabled || !requireEnabled) && (BACKUP_TRANSFER_KINDS as readonly string[]).includes(destination.target.kind) && backupDestinationProofCurrent(destination.target, destination.verification, profile.revision) ? [{ target: destination.target, profile }] : []
    })
  }
  const openSession = (destination: ActiveDestination): Promise<BackupTransferSession> => deps.provider!.open({ destinationId: destination.target.id, targetDigest: backupDestinationTargetDigest(destination.target), credentialRef: destination.target.credentialRef!, credentialRevision: destination.profile.revision }, AbortSignal.timeout(5000))
  const persist = async (change: (current: BackupRunLedger) => BackupRunLedger): Promise<BackupRunLedger> => { const next = change(await ledger()); readBackupRunLedger(next); await deps.writeLedger(next); return next }
  const claim = (id: string, task: () => Promise<void>): void => { const slot = { id, done: Promise.resolve() }; active = slot; slot.done = task().catch(() => undefined).finally(() => { if (active === slot) active = null }) }
  const busy = (): void => { if (active) fail('CONFLICT', 'another backup operation is running; wait for it to finish', { stateChanged: false }) }
  const keepOf = (saved: SavedBackupConfig | null): BackupRetentionKeep => ({ daily: saved?.schedule?.retentionCount ?? 7, weekly: saved?.schedule?.retentionWeekly ?? 0, monthly: saved?.schedule?.retentionMonthly ?? 0 })

  async function view(): Promise<BackupRunsView> {
    const storage = await deps.storage?.().catch(() => null) ?? null
    let current: BackupRunLedger
    // An unreadable history (older format or damage) is reported with its path; nothing runs until an operator moves it aside.
    try { current = await ledger() } catch { return { available: false, reason: 'invalid_ledger', revision: createHash('sha256').update('invalid_ledger').digest('hex'), schedule: null, storage, activeId: null, runs: [], recoveries: [], restores: [], nativeQualified: false } }
    const saved = await config()
    const destinations = saved?.schedule ? await activeDestinations(saved, saved.schedule.destinationIds) : []
    // A schedule without destinations keeps verified local archives only; selected destinations must all be active.
    const selected = saved?.schedule?.destinationIds.length ?? 0
    const reason = !deps.createBackup ? 'no_executor' : selected && !deps.provider ? 'no_provider' : !saved ? 'invalid_configuration' : !saved.schedule ? 'no_schedule' : destinations.length !== selected ? 'no_destination' : null
    const schedule = saved?.schedule ? { enabled: saved.schedule.enabled, cron: saved.schedule.cron, nextRunAt: saved.schedule.enabled ? nextBackupCronRun(saved.schedule.parsed, new Date(Math.max(now().getTime() - 60_000, Date.parse(current.lastScheduledAt ?? saved.schedule.updatedAt))))?.toISOString() ?? null : null, lastScheduledAt: current.lastScheduledAt } : null
    return { available: reason === null, reason, revision: backupRunLedgerRevision(current), schedule, storage, activeId: active?.id ?? null, runs: current.runs, recoveries: current.recoveries, restores: current.restores, nativeQualified: false }
  }

  /** Names a retention plan must keep: copies of a running run, the newest verified copy per account and recovered archives. */
  const protectedNames = (current: BackupRunLedger, destinationId: string | null): Set<string> => {
    const names = new Set<string>(), newest = new Map<string, string>()
    for (const run of current.runs) {
      const copies = destinationId === null
        ? [...run.archives, ...run.control ? [run.control] : []].map(item => ({ username: item.username, file: item.file, verified: item.integrity === 'verified' }))
        : run.entries.filter(entry => entry.destinationId === destinationId).map(entry => ({ username: entry.username, file: entry.file, verified: entry.outcome === 'verified' }))
      for (const copy of copies) {
        if (!copy.file) continue
        const name = copy.username + '/' + copy.file
        if (run.state === 'running') names.add(name)
        if (copy.verified && (newest.get(copy.username) ?? '') < name) newest.set(copy.username, name)
      }
    }
    for (const name of newest.values()) names.add(name)
    for (const item of current.recoveries) if (item.state === 'recovered' || item.state === 'running') names.add(item.username + '/' + item.file)
    return names
  }
  async function retention(saved: SavedBackupConfig, destination: ActiveDestination, session: BackupTransferSession, current: BackupRunLedger): Promise<BackupRetentionPreview> {
    const keep = keepOf(saved)
    const plan = planBackupRetention({ archives: await session.listArchives(signal()), retentionDays: destination.target.retentionDays, keep, protectedNames: protectedNames(current, destination.target.id), now: now() })
    return { destinationId: destination.target.id, retentionDays: destination.target.retentionDays, keep, ...plan }
  }
  const withDestination = async <T>(id: string, task: (saved: SavedBackupConfig, destination: ActiveDestination, session: BackupTransferSession) => Promise<T>, requireEnabled = true): Promise<T> => {
    const saved = await config()
    if (!saved || !deps.provider) return fail('PRECONDITION_FAILED', 'a trusted remote backup transport is unavailable', { stateChanged: false })
    const [destination] = await activeDestinations(saved, [id], requireEnabled)
    if (!destination) return fail('PRECONDITION_FAILED', 'the destination must be enabled with a current verification before its archives are read or changed', { stateChanged: false })
    const session = await openSession(destination).catch(() => fail('SERVICE_UNAVAILABLE', 'the remote destination could not be opened', { stateChanged: false }))
    try { return await task(saved, destination, session) } finally { await session.closeAndDrain(AbortSignal.timeout(5000)).catch(() => undefined) }
  }
  /** Deletes exactly the planned names, then re-lists: verified only when none of them is still present. */
  const applyRetention = async (session: BackupTransferSession, plan: BackupRetentionPreview): Promise<{ deleted: string[]; outcome: 'verified' | 'failed' | 'unknown' }> => {
    const names = plan.rows.filter(row => row.action === 'delete').map(row => row.name), deleted: string[] = []
    let attemptedFailure = false
    for (const name of names) { try { await session.deleteArchive(name, signal()); deleted.push(name) } catch { attemptedFailure = true } }
    try { const remaining = new Set((await session.listArchives(signal())).map(item => item.name)); return { deleted: deleted.filter(name => !remaining.has(name)), outcome: names.some(name => remaining.has(name)) ? attemptedFailure ? 'failed' : 'unknown' : 'verified' } }
    catch { return { deleted: [], outcome: 'unknown' } }
  }

  /** Retention of local archives (and control snapshots) after a verified scheduled run, same plan without a day floor. */
  async function pruneLocal(accounts: readonly BackupRunAccount[], keep: BackupRetentionKeep): Promise<number> {
    const names = protectedNames(await ledger(), null)
    let deleted = 0
    const prune = async (archives: BackupRemoteArchive[], remove: (file: string) => Promise<void>): Promise<void> => {
      for (const row of planBackupRetention({ archives, retentionDays: 0, keep, protectedNames: names, now: now() }).rows) if (row.action === 'delete') { await remove(row.name.split('/')[1]!); deleted++ }
    }
    for (const account of accounts) await prune(await deps.listLocalArchives(account), file => deps.deleteLocalArchive(account, file))
    if (deps.control) await prune(await deps.control.list(), file => deps.control!.delete(file))
    return deleted
  }

  /** Uploads one verified local copy to every run destination and re-reads it; a copy counts only when size and SHA-256 match. */
  async function upload(run: BackupRun, username: string, file: string | null, source: BackupArchiveSource | null, reason: BackupRunEntry['reason']): Promise<void> {
    for (const destinationId of run.destinationIds) {
      const entry: BackupRunEntry = { username, destinationId, file: source ? file : null, bytes: source?.bytes ?? null, sha256: source?.sha256 ?? null, outcome: 'failed', reason: reason ?? 'backup_failed' }
      run.entries.push(entry)
      if (!source || !file) continue
      const fresh = await config()
      const [destination] = fresh ? await activeDestinations(fresh, [destinationId]) : []
      if (!destination) { entry.reason = 'destination_inactive'; continue }
      let session: BackupTransferSession
      try { session = await openSession(destination) } catch { entry.reason = 'transport_unavailable'; continue }
      const name = backupArchiveName(username, file)
      try {
        try { await session.putArchive(name, source, signal()) } catch { entry.outcome = 'unknown'; entry.reason = 'upload_unknown'; continue }
        try {
          const stream = await session.readArchive(name, source.bytes, signal())
          const copy = stream ? await sha256Of(stream, source.bytes) : null
          if (copy && copy.bytes === source.bytes && copy.sha256 === source.sha256) { entry.outcome = 'verified'; entry.reason = null } else entry.reason = 'readback_mismatch'
        } catch { entry.outcome = 'unknown'; entry.reason = 'upload_unknown' }
      } finally { await session.closeAndDrain(AbortSignal.timeout(5000)).catch(() => undefined) }
    }
  }
  const failedArchive = (username: string): BackupRunArchive => ({ username, file: null, bytes: null, sha256: null, databases: [], zones: [], integrity: 'failed', reason: 'backup_failed', detail: null })

  async function executeRun(run: BackupRun, accounts: readonly BackupRunAccount[], keep: BackupRetentionKeep, includeControl: boolean): Promise<void> {
    const save = async (): Promise<void> => { await persist(current => ({ ...current, runs: current.runs.map(item => item.id === run.id ? structuredClone(run) : item) })).catch(() => undefined) }
    if (includeControl && deps.control) {
      const control = failedArchive(BACKUP_CONTROL)
      let source: BackupArchiveSource | null = null
      try {
        const built = await deps.control.build()
        control.file = built.file; control.reason = 'integrity_failed'
        await deps.control.verify(built.file)
        source = await deps.control.read(built.file)
        Object.assign(control, { bytes: source.bytes, sha256: source.sha256, integrity: 'verified', reason: null })
      } catch (error) { source = null; control.detail = backupRunDetail(error) }
      run.control = control
      await upload(run, BACKUP_CONTROL, control.file, source, control.reason)
      await save()
    }
    for (const account of accounts) {
      const archive = failedArchive(account.username)
      let source: BackupArchiveSource | null = null
      try {
        const built = await deps.createBackup!(account, { excludeMail: !run.mailIncluded, includeDatabases: run.databasesIncluded, includeDns: run.dnsIncluded })
        Object.assign(archive, { file: built.file, databases: [...built.databases].sort(), zones: [...built.zones].sort(), reason: 'integrity_failed' })
        // The archive must read back completely, holding exactly the parts it was built with, before it counts or is uploaded.
        const listing = await deps.verifyArchive(account, built.file), read = await deps.readLocalArchive(account, built.file)
        if (listing.databases.join() !== archive.databases.join() || listing.zones.join() !== archive.zones.join()) throw new Error('the archive does not hold the parts it was built with')
        if (read.bytes > 0) { source = read; Object.assign(archive, { bytes: read.bytes, sha256: read.sha256, integrity: 'verified', reason: null }) }
      } catch (error) { source = null; archive.detail = backupRunDetail(error) }
      run.archives.push(archive)
      await upload(run, account.username, archive.file, source, archive.reason)
      await save()
    }
    const copies = [...run.archives, ...run.control ? [run.control] : []]
    const verified = run.archives.length > 0 && copies.every(item => item.integrity === 'verified') && run.entries.every(entry => entry.outcome === 'verified')
    if (verified && run.trigger === 'schedule') {
      for (const destinationId of run.destinationIds) {
        try {
          const result = await withDestination(destinationId, async (current, destination, session) => applyRetention(session, await retention(current, destination, session, await ledger())))
          run.retention.push({ destinationId, deleted: result.deleted.length, outcome: result.outcome })
        } catch { run.retention.push({ destinationId, deleted: 0, outcome: 'unknown' }) }
      }
      run.localDeleted = await pruneLocal(accounts, keep).catch(() => null)
    }
    run.state = verified ? 'succeeded' : run.entries.some(entry => entry.outcome === 'unknown') ? 'unknown' : 'failed'
    run.finishedAt = now().toISOString()
    await save()
  }

  /** `usernames` limits an `account` run to those accounts; it uses the saved schedule's parts and destinations, or keeps local copies of everything. */
  async function start(trigger: BackupRun['trigger'], actor: string, expectedRevision?: string, usernames?: readonly string[]): Promise<BackupRun> {
    busy()
    const current = await ledger()
    if (expectedRevision !== undefined && backupRunLedgerRevision(current) !== expectedRevision) return fail('CONFLICT', 'backup run history changed; read it again', { stateChanged: false })
    const saved = await config()
    if (!deps.createBackup || !saved || trigger !== 'account' && !saved.schedule) return fail('PRECONDITION_FAILED', 'scheduled backups need a Linux host executor and a saved schedule', { stateChanged: false })
    const policy = saved.schedule ?? ACCOUNT_DEFAULTS
    const destinations = await activeDestinations(saved, policy.destinationIds)
    if (destinations.length !== policy.destinationIds.length) return fail('PRECONDITION_FAILED', 'every selected destination must be enabled with a current verification and a trusted transport', { stateChanged: false })
    const selection = trigger === 'account' ? [...usernames ?? []] : saved.schedule!.selectedAccounts
    const accounts = (await deps.listAccounts()).filter(account => account.status !== 'terminating' && USERNAME.test(account.username) && (selection === 'all' || selection.includes(account.username) || selection.includes(account.id)))
    if (trigger === 'account' && accounts.length !== selection.length) return fail('NOT_FOUND', 'a selected account does not exist or is being removed', { stateChanged: false })
    if (!accounts.length || accounts.length > MAX_RUN_ACCOUNTS || (accounts.length + 1) * destinations.length > BACKUP_RUN_LIMITS.entries) return fail('PRECONDITION_FAILED', 'the run must select 1 to ' + MAX_RUN_ACCOUNTS + ' accounts within the run entry limit', { stateChanged: false })
    busy()
    const startedAt = now().toISOString(), includeControl = trigger !== 'account' && (saved.schedule?.includeControl ?? false)
    const run: BackupRun = { id: randomUUID(), trigger, actor, startedAt, finishedAt: null, state: 'running', destinationIds: destinations.map(item => item.target.id), accounts: accounts.length,
      mailIncluded: policy.includeMail, databasesIncluded: policy.includeDatabases, dnsIncluded: policy.includeDns, archives: [], control: null, entries: [], retention: [], localDeleted: null }
    await persist(value => ({ ...value, ...(trigger === 'schedule' ? { lastScheduledAt: startedAt } : {}), runs: [structuredClone(run), ...value.runs].slice(0, BACKUP_RUN_LIMITS.runs) }))
    claim(run.id, () => executeRun(run, accounts, keepOf(saved), includeControl).catch(async () => {
      run.state = 'unknown'; run.finishedAt = now().toISOString()
      await persist(value => ({ ...value, runs: value.runs.map(item => item.id === run.id ? structuredClone(run) : item) })).catch(() => undefined)
    }))
    return run
  }

  return {
    view,
    start: (actor: string, expectedRevision: string) => start('manual', actor, expectedRevision),
    /** Backs up the named accounts again (run actions, "Create backup"): local copies plus the saved destinations. */
    startAccounts: (actor: string, usernames: readonly string[], expectedRevision?: string) => start('account', actor, expectedRevision, usernames),
    /** Timer entry point (ROOT calls it about once a minute). Never throws; skipped ticks change nothing. */
    async tick(): Promise<{ started: string } | { skipped: string }> {
      try {
        if (active) return { skipped: 'busy' }
        const saved = await config(), current = await ledger()
        if (!saved?.schedule?.enabled) return { skipped: 'disabled' }
        if (!backupScheduleDue(saved.schedule.parsed, new Date(current.lastScheduledAt ?? saved.schedule.updatedAt), now())) return { skipped: 'not_due' }
        return { started: (await start('schedule', 'scheduler')).id }
      } catch { return { skipped: 'unavailable' } }
    },
    retentionPreview: (destinationId: string) => withDestination(destinationId, async (saved, destination, session) => retention(saved, destination, session, await ledger())),
    async retentionApply(destinationId: string, expectedPlanDigest: string): Promise<{ destinationId: string; deleted: string[]; outcome: 'verified' | 'failed' | 'unknown' }> {
      busy()
      const id = randomUUID()
      let release!: () => void
      active = { id, done: new Promise<void>(resolve => { release = resolve }) }
      try {
        return { destinationId, ...await withDestination(destinationId, async (saved, destination, session) => {
          const plan = await retention(saved, destination, session, await ledger())
          if (plan.planDigest !== expectedPlanDigest) return fail('CONFLICT', 'remote archives or retention settings changed; review the plan again', { stateChanged: false })
          return applyRetention(session, plan)
        }) }
      } finally { release(); if (active?.id === id) active = null }
    },
    /** Free space where a verified destination stores archives, when its transport can report it (SFTP, local disk); activation is not required. */
    space: (destinationId: string) => withDestination(destinationId, async (_saved, _destination, session) => session.space ? session.space(AbortSignal.timeout(30_000)).catch(() => null) : null, false),
    async recover(destinationId: string, input: { runId: string; username: string; file: string }, actor: string, expectedRevision: string): Promise<BackupRecovery> {
      busy()
      const current = await ledger()
      if (backupRunLedgerRevision(current) !== expectedRevision) return fail('CONFLICT', 'backup run history changed; read it again', { stateChanged: false })
      const entry = current.runs.find(run => run.id === input.runId)?.entries.find(item => item.destinationId === destinationId && item.username === input.username && item.file === input.file && item.outcome === 'verified')
      if (!entry || !entry.bytes || !entry.sha256 || !HEX.test(entry.sha256)) return fail('NOT_FOUND', 'no verified remote copy of this archive is recorded', { stateChanged: false })
      const account = (await deps.listAccounts()).find(item => item.username === input.username)
      if (!account || account.status === 'terminating') return fail('NOT_FOUND', 'the account no longer exists', { stateChanged: false })
      const saved = await config()
      if (!saved || !(await activeDestinations(saved, [destinationId])).length) return fail('PRECONDITION_FAILED', 'the destination must be enabled with a current verification before recovery', { stateChanged: false })
      busy()
      const recovery: BackupRecovery = { id: randomUUID(), actor, destinationId, username: input.username, file: input.file, startedAt: now().toISOString(), finishedAt: null, state: 'running', reason: null }
      await persist(value => ({ ...value, recoveries: [structuredClone(recovery), ...value.recoveries].slice(0, BACKUP_RUN_LIMITS.recoveries) }))
      const finish = async (state: BackupRecovery['state'], reason: BackupRecovery['reason']): Promise<void> => {
        recovery.state = state; recovery.reason = reason; recovery.finishedAt = now().toISOString()
        await persist(value => ({ ...value, recoveries: value.recoveries.map(item => item.id === recovery.id ? structuredClone(recovery) : item) })).catch(() => undefined)
      }
      claim(recovery.id, async () => {
        try {
          const outcome = await withDestination(destinationId, async (_saved, _destination, session) => {
            const stream = await session.readArchive(backupArchiveName(input.username, input.file), entry.bytes!, signal())
            return stream ? deps.storeRecovered(account, input.file, stream, { bytes: entry.bytes!, sha256: entry.sha256! }) : 'missing' as const
          })
          await finish(outcome === 'recovered' ? 'recovered' : 'failed', outcome === 'recovered' ? null : outcome)
        } catch { await finish('unknown', 'transport') }
      })
      return recovery
    },
    /** The newest verified local archive record of this name: its digest and the parts it was built with. */
    async verifiedArchive(username: string, file: string): Promise<{ sha256: string; databases: string[]; zones: string[] } | null> {
      const found = (await ledger()).runs.flatMap(run => run.archives).find(item => item.username === username && item.file === file && item.integrity === 'verified')
      return found?.sha256 ? { sha256: found.sha256, databases: found.databases, zones: found.zones } : null
    },
    /**
     * Restores parts one at a time in the background slot. `perform` does the archive work for one part; every part starts as
     * not attempted, so an interrupted restore never reads as complete. `finish` runs once with the final record.
     */
    async restoreParts(input: { username: string; file: string; items: readonly { part: BackupPartRestoreItem['part']; name: string }[] }, actor: string,
      perform: (item: { part: BackupPartRestoreItem['part']; name: string }) => Promise<Pick<BackupPartRestoreItem, 'bytes' | 'result' | 'reason'>>, finish: (restore: BackupPartRestore) => Promise<void>): Promise<BackupPartRestore> {
      busy()
      const restore: BackupPartRestore = { id: randomUUID(), actor, username: input.username, file: input.file, startedAt: now().toISOString(), finishedAt: null, state: 'running',
        items: input.items.map(item => ({ part: item.part, name: item.name, bytes: null, result: 'not-attempted' as const, reason: 'interrupted' as const })) }
      await persist(value => ({ ...value, restores: [structuredClone(restore), ...value.restores].slice(0, BACKUP_RUN_LIMITS.restores) }))
      const save = (): Promise<unknown> => persist(value => ({ ...value, restores: value.restores.map(item => item.id === restore.id ? structuredClone(restore) : item) })).catch(() => undefined)
      claim(restore.id, async () => {
        try {
          for (const item of restore.items) {
            Object.assign(item, await perform({ part: item.part, name: item.name }).catch(() => ({ bytes: null, result: 'failed' as const, reason: 'restore-failed' as const })))
            await save()
          }
          restore.state = 'finished'
        } catch { restore.state = 'unknown' }
        restore.finishedAt = now().toISOString()
        await save()
        await finish(structuredClone(restore)).catch(() => undefined)
      })
      return restore
    },
    /** Test and shutdown hook: resolves when the current background operation settles. */
    idle: async (): Promise<void> => { await active?.done },
  }
}
export type BackupRunController = ReturnType<typeof createBackupRunController>
/** Production wiring on a Linux host executor; other hosts pass executor null and the controller reports no_executor. */
export function createHostBackupRunController(input: { executor: AgentExecutor | null; stateRoot: string; provider: BackupTransferProvider | null; listAccounts(): Promise<readonly BackupRunAccount[]>
  /** Account MariaDB databases and their low-priority logical dump; absent where MariaDB is not administered here. */
  databases?: { list(account: BackupRunAccount): Promise<string[]>; dump: BackupArchiveBuildDeps['dump'] }
  /** The account's DNS zones as saved desired state (JSON). */
  zones?: { list(account: BackupRunAccount): Promise<{ name: string; content: string }[]> }
  /** Consistent copy of the control index database for the control snapshot. */
  copyControlDatabase?: (outputPath: string) => Promise<void>
  run?: BackupCommandRunner; root?: string; ledgerPath?: string }): BackupRunController {
  const root = input.root ?? defaultBackupArchiveRoot(), executor = input.executor, run = input.run ?? runBackupCommand, databases = input.databases
  const noDump: BackupArchiveBuildDeps['dump'] = () => fail('PRECONDITION_FAILED', 'database dumps are unavailable on this host', { stateChanged: false })
  const controlDir = posix.join(root, BACKUP_CONTROL), copyControlDatabase = input.copyControlDatabase
  return createBackupRunController({ readConfig: readBackupConfigFiles(input.stateRoot), provider: input.provider, listAccounts: input.listAccounts, ...backupLedgerFile(input.ledgerPath),
    createBackup: executor ? async (account, options) => buildServerBackupArchive({ root, account, excludeMail: options.excludeMail,
      databases: options.includeDatabases && databases ? await databases.list(account) : [], zones: options.includeDns && input.zones ? await input.zones.list(account) : [], deps: { run, dump: databases?.dump ?? noDump } }) : null,
    verifyArchive: (account, file) => listServerBackupArchive({ root, account, file, run }),
    readLocalArchive: (account, file) => localBackupArchiveSource(root, account, file),
    listLocalArchives: async account => (await listAccountBackups(root, account)).flatMap(item => {
      const name = account.username + '/' + item.file, parsed = parseBackupArchiveName(name)
      return parsed ? [{ name, bytes: item.bytes, lastModified: parsed.createdAt }] : []
    }),
    deleteLocalArchive: (account, file) => withPinnedHostTargetParent(posix.join(root, ...backupArchiveName(account.username, file).split('/')), pinned => unlink(pinned)),
    control: executor && copyControlDatabase ? {
      build: () => buildControlSnapshot({ root, stateDir: input.stateRoot, copyDatabase: copyControlDatabase, run }),
      verify: file => listControlSnapshot({ root, file, run }),
      read: file => localFileSource(posix.join(controlDir, backupArchiveName(BACKUP_CONTROL, file).split('/')[1]!)),
      list: async () => {
        let names: string[] = []
        try { names = await readdir(controlDir) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        return names.flatMap(file => { const parsed = parseBackupArchiveName(BACKUP_CONTROL + '/' + file); return parsed ? [{ name: BACKUP_CONTROL + '/' + file, bytes: 0, lastModified: parsed.createdAt }] : [] })
      },
      delete: file => withPinnedHostTargetParent(posix.join(controlDir, backupArchiveName(BACKUP_CONTROL, file).split('/')[1]!), pinned => unlink(pinned)),
    } : null,
    storage: async () => { const info = await statfs(root); return { freeBytes: Number(info.bavail) * Number(info.bsize), totalBytes: Number(info.blocks) * Number(info.bsize) } },
    storeRecovered: async (account, file, chunks, expected) => {
      if (!executor) return fail('PRECONDITION_FAILED', 'archive recovery needs a Linux host executor', { stateChanged: false })
      await executor.runAction({ kind: 'ensure-dir', path: root, mode: 0o700, owner: 'root', group: 'root' })
      await executor.runAction({ kind: 'ensure-dir', path: posix.join(root, account.username), mode: 0o700, owner: 'root', group: 'root' })
      return storeRecoveredBackupArchive(root, account.username, file, chunks, expected)
    } })
}

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const readSmallJson = async (req: Request, keys: readonly (readonly string[])[]): Promise<Record<string, unknown>> => {
  if (req.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') return fail('VALIDATION', 'JSON is required', { stateChanged: false })
  const text = await req.text()
  if (Buffer.byteLength(text) > 4096) return fail('VALIDATION', 'the backup request is too large', { stateChanged: false })
  let body: unknown
  try { body = JSON.parse(text) } catch { return fail('VALIDATION', 'invalid backup request JSON', { stateChanged: false }) }
  if (!object(body) || !keys.some(shape => Object.keys(body).length === shape.length && shape.every(key => Object.hasOwn(body, key)))) return fail('VALIDATION', 'the backup request takes only ' + keys.map(shape => shape.join(', ')).join(' or '), { stateChanged: false })
  return body
}
const revisionOf = (raw: unknown): string => typeof raw === 'string' && HEX.test(raw) ? raw : fail('VALIDATION', 'a 64-character hexadecimal revision is required', { stateChanged: false })
/** 1 to 50 distinct usernames for a per-account run. */
export const readBackupRunUsernames = (raw: unknown): string[] => Array.isArray(raw) && raw.length >= 1 && raw.length <= 50 && raw.every(name => typeof name === 'string' && USERNAME.test(name)) && new Set(raw).size === raw.length
  ? [...raw as string[]] : fail('VALIDATION', 'select 1 to 50 accounts to back up', { stateChanged: false })

/** /host/backups/runs and /host/backups/destinations/<id>/{retention,recover,space}; root only, fresh authority before every mutation. */
export async function handleBackupRunsRoute(req: Request, url: URL, method: string, ctx: { authorize(action: string): Promise<{ actor: string }>; controller: BackupRunController | null }): Promise<Response | null> {
  const runs = url.pathname === '/host/backups/runs', match = /^\/host\/backups\/destinations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(retention|recover|space)$/.exec(url.pathname)
  if (!runs && !match) return null
  const action = runs ? 'host.backups.runs' : 'host.backups.' + match![2]
  await ctx.authorize(action)
  if (url.search) return fail('VALIDATION', 'backup runs accept no query selectors', { stateChanged: false })
  const allow = match?.[2] === 'recover' ? 'POST' : match?.[2] === 'space' ? 'GET' : 'GET, POST'
  if (!allow.split(', ').includes(method)) return new Response(null, { status: 405, headers: { allow } })
  if (!ctx.controller) return fail('PRECONDITION_FAILED', 'scheduled backup execution is unavailable on this host', { stateChanged: false, nativeApplied: false })
  const controller = ctx.controller
  if (runs && method === 'GET') return json(await controller.view())
  if (match?.[2] === 'retention' && method === 'GET') return json(await controller.retentionPreview(match[1]!))
  if (match?.[2] === 'space') return json({ destinationId: match[1], space: await controller.space(match[1]!) })
  if (runs) {
    const body = await readSmallJson(req, [['expectedRevision'], ['expectedRevision', 'accounts']])
    const expected = revisionOf(body.expectedRevision), usernames = body.accounts === undefined ? null : readBackupRunUsernames(body.accounts)
    const { actor } = await ctx.authorize(action)
    const run = usernames ? await controller.startAccounts(actor, usernames, expected) : await controller.start(actor, expected)
    return json({ runId: run.id, state: run.state }, 202)
  }
  if (match![2] === 'retention') {
    const body = await readSmallJson(req, [['expectedPlanDigest']])
    const digest = revisionOf(body.expectedPlanDigest)
    await ctx.authorize(action)
    return json(await controller.retentionApply(match![1]!, digest))
  }
  const body = await readSmallJson(req, [['expectedRevision', 'runId', 'username', 'file']])
  if (typeof body.runId !== 'string' || !UUID.test(body.runId) || typeof body.username !== 'string' || !USERNAME.test(body.username) || typeof body.file !== 'string') return fail('VALIDATION', 'a recorded run, account and archive are required', { stateChanged: false })
  try { backupArchiveName(body.username, body.file) } catch { return fail('VALIDATION', 'the archive name does not belong to this account', { stateChanged: false }) }
  const expected = revisionOf(body.expectedRevision)
  const { actor } = await ctx.authorize(action)
  const recovery = await controller.recover(match![1]!, { runId: body.runId, username: body.username, file: body.file }, actor, expected)
  return json({ recoveryId: recovery.id, state: recovery.state }, 202)
}
