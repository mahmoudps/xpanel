import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { link, open, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { fail } from '@xpanel/core'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import { backupDestinationProofCurrent, backupDestinationTargetDigest, backupScheduleDue, isBackupCredentialRef, nextBackupCronRun, parseBackupCron, readBackupCredentialProfiles, readBackupDestinationProof } from '../../../packages/core/src/backup-destination.ts'
import type { BackupCredentialProfile, BackupCron, BackupDestinationProof, BackupDestinationTarget } from '../../../packages/core/src/backup-destination.ts'
import { DEFAULT_BACKUP_DIR, MAX_BACKUP_BYTES, openAccountBackupArchive } from './account-backup.ts'
import { createAccountBackup } from './account-backup.ts'
import type { BackupAccountTarget } from './account-backup.ts'
import type { AgentExecutor } from './executor.ts'
import { withPinnedHostTargetParent } from './host-target-parent.ts'
import { BACKUP_RUN_LIMITS, backupArchiveName, backupRunLedgerRevision, planBackupRetention, readBackupRunLedger } from './acct-backup-plan.ts'
import type { BackupRecovery, BackupRetentionRow, BackupRun, BackupRunEntry, BackupRunLedger, BackupRunsView } from './acct-backup-plan.ts'
import { BACKUP_S3_KINDS } from './acct-backup-s3.ts'
import type { BackupArchiveSource, BackupTransferProvider, BackupTransferSession } from './acct-backup-s3.ts'

export const BACKUP_RUN_LEDGER_PATH = '/var/lib/xpanel/backup-runs.json'
export const BACKUP_TRANSFER_TIMEOUT_MS = 30 * 60_000
const MAX_RUN_ACCOUNTS = 1000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const USERNAME = /^[a-z][a-z0-9]{0,15}$/
const HEX = /^[0-9a-f]{64}$/

export interface BackupRunAccount extends BackupAccountTarget { id: string }
interface SavedDestination { target: BackupDestinationTarget; enabled: boolean; verification: BackupDestinationProof | null }
interface SavedSchedule { enabled: boolean; cron: string; parsed: BackupCron; retentionCount: number; includeMail: boolean; selectedAccounts: 'all' | string[]; destinationIds: string[]; updatedAt: string }
export interface SavedBackupConfig { destinations: SavedDestination[]; schedule: SavedSchedule | null }
interface ActiveDestination { target: BackupDestinationTarget; profile: BackupCredentialProfile }
export interface BackupRetentionPreview { destinationId: string; retentionDays: number; retentionCount: number; planDigest: string; rows: BackupRetentionRow[] }

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
  const s = raw.schedule
  if (s === null) return { destinations, schedule: null }
  if (!object(s) || typeof s.enabled !== 'boolean' || typeof s.cron !== 'string' || typeof s.retentionCount !== 'number' || !Number.isSafeInteger(s.retentionCount) || s.retentionCount < 1 || s.retentionCount > 3650 || typeof s.includeMail !== 'boolean'
    || !(s.selectedAccounts === 'all' || Array.isArray(s.selectedAccounts) && s.selectedAccounts.length <= 10_000 && s.selectedAccounts.every(value => typeof value === 'string' && value.length <= 64))
    || !Array.isArray(s.destinationIds) || s.destinationIds.length > 50 || s.destinationIds.some(value => typeof value !== 'string' || !UUID.test(value)) || typeof s.updatedAt !== 'string' || !Number.isFinite(Date.parse(s.updatedAt))) return invalidConfig()
  return { destinations, schedule: { enabled: s.enabled, cron: s.cron, parsed: parseBackupCron(s.cron), retentionCount: s.retentionCount, includeMail: s.includeMail, selectedAccounts: s.selectedAccounts === 'all' ? 'all' : [...s.selectedAccounts as string[]], destinationIds: [...s.destinationIds as string[]], updatedAt: s.updatedAt } }
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
  return { ...digest, chunks: async function* () {
    const again = await openAccountBackupArchive(root, account, file)
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
  /** createAccountBackup on a Linux host executor; null where account archives cannot be created. */
  createBackup: ((account: BackupRunAccount, excludeMail: boolean) => Promise<{ file: string; bytes: number }>) | null
  readLocalArchive(account: BackupRunAccount, file: string): Promise<BackupArchiveSource>
  /** Ensures the root-only account archive directory, then stores through storeRecoveredBackupArchive. */
  storeRecovered(account: BackupRunAccount, file: string, chunks: AsyncIterable<Uint8Array>, expected: { bytes: number; sha256: string }): Promise<'recovered' | 'exists' | 'mismatch'>
  readLedger(): Promise<unknown>
  writeLedger(ledger: BackupRunLedger): Promise<void>
  now?: () => Date
  transferTimeoutMs?: number
}
export const backupLedgerFile = (path = BACKUP_RUN_LEDGER_PATH) => ({ readLedger: () => readJsonIfExists<unknown>(path), writeLedger: (ledger: BackupRunLedger) => atomicWriteJson(path, ledger, 0o600) })
export const defaultBackupArchiveRoot = (): string => process.env.XPANEL_BACKUP_DIR || DEFAULT_BACKUP_DIR

/** One backup operation (run, retention apply or recovery) at a time in this agent process; ROOT keeps a single instance. */
export function createBackupRunController(deps: BackupRunDeps) {
  const now = deps.now ?? (() => new Date())
  let active: { id: string; done: Promise<void> } | null = null
  const signal = (): AbortSignal => AbortSignal.timeout(deps.transferTimeoutMs ?? BACKUP_TRANSFER_TIMEOUT_MS)
  const ledger = async (): Promise<BackupRunLedger> => {
    const saved = readBackupRunLedger(await deps.readLedger())
    // A running record not owned by this process was interrupted; its outcome is unknown, never failed or succeeded.
    return { ...saved, runs: saved.runs.map(run => run.state === 'running' && run.id !== active?.id ? { ...run, state: 'unknown' as const } : run),
      recoveries: saved.recoveries.map(item => item.state === 'running' && item.id !== active?.id ? { ...item, state: 'unknown' as const, reason: 'interrupted' as const } : item) }
  }
  const config = async (): Promise<SavedBackupConfig | null> => { try { return readSavedBackupConfig(await deps.readConfig()) } catch { return null } }
  const activeDestinations = async (saved: SavedBackupConfig, ids: readonly string[]): Promise<ActiveDestination[]> => {
    if (!deps.provider) return []
    let profiles: BackupCredentialProfile[]
    try { profiles = readBackupCredentialProfiles(await deps.provider.profiles(AbortSignal.timeout(5000))) } catch { return [] }
    return ids.flatMap(id => {
      const destination = saved.destinations.find(item => item.target.id === id)
      const profile = destination && profiles.find(item => item.ref === destination.target.credentialRef && item.kinds.includes(destination.target.kind as BackupCredentialProfile['kinds'][number]))
      return destination && profile && destination.enabled && (BACKUP_S3_KINDS as readonly string[]).includes(destination.target.kind) && backupDestinationProofCurrent(destination.target, destination.verification, profile.revision) ? [{ target: destination.target, profile }] : []
    })
  }
  const openSession = (destination: ActiveDestination): Promise<BackupTransferSession> => deps.provider!.open({ destinationId: destination.target.id, targetDigest: backupDestinationTargetDigest(destination.target), credentialRef: destination.target.credentialRef!, credentialRevision: destination.profile.revision }, AbortSignal.timeout(5000))
  const persist = async (change: (current: BackupRunLedger) => BackupRunLedger): Promise<BackupRunLedger> => { const next = change(await ledger()); readBackupRunLedger(next); await deps.writeLedger(next); return next }
  const claim = (id: string, task: () => Promise<void>): void => { const slot = { id, done: Promise.resolve() }; active = slot; slot.done = task().catch(() => undefined).finally(() => { if (active === slot) active = null }) }
  const busy = (): void => { if (active) fail('CONFLICT', 'another backup operation is running; wait for it to finish', { stateChanged: false }) }

  async function view(): Promise<BackupRunsView> {
    const current = await ledger(), saved = await config()
    const destinations = saved?.schedule ? await activeDestinations(saved, saved.schedule.destinationIds) : []
    const reason = !deps.createBackup ? 'no_executor' : !deps.provider ? 'no_provider' : !saved ? 'invalid_configuration' : !saved.schedule ? 'no_schedule' : !destinations.length ? 'no_destination' : null
    const schedule = saved?.schedule ? { enabled: saved.schedule.enabled, cron: saved.schedule.cron, nextRunAt: saved.schedule.enabled ? nextBackupCronRun(saved.schedule.parsed, new Date(Math.max(now().getTime() - 60_000, Date.parse(current.lastScheduledAt ?? saved.schedule.updatedAt))))?.toISOString() ?? null : null, lastScheduledAt: current.lastScheduledAt } : null
    return { available: reason === null, reason, revision: backupRunLedgerRevision(current), schedule, activeId: active?.id ?? null, runs: current.runs, recoveries: current.recoveries, nativeQualified: false }
  }

  async function retention(saved: SavedBackupConfig, destination: ActiveDestination, session: BackupTransferSession, current: BackupRunLedger): Promise<BackupRetentionPreview> {
    const protectedNames = new Set<string>(), newest = new Map<string, string>()
    for (const run of current.runs) for (const entry of run.entries) {
      if (entry.destinationId !== destination.target.id || !entry.file) continue
      const name = entry.username + '/' + entry.file
      if (run.state === 'running') protectedNames.add(name)
      if (entry.outcome === 'verified' && (newest.get(entry.username) ?? '') < name) newest.set(entry.username, name)
    }
    for (const name of newest.values()) protectedNames.add(name)
    const retentionCount = saved.schedule?.retentionCount ?? 7
    const plan = planBackupRetention({ archives: await session.listArchives(signal()), retentionDays: destination.target.retentionDays, retentionCount, protectedNames, now: now() })
    return { destinationId: destination.target.id, retentionDays: destination.target.retentionDays, retentionCount, ...plan }
  }
  const withDestination = async <T>(id: string, task: (saved: SavedBackupConfig, destination: ActiveDestination, session: BackupTransferSession) => Promise<T>): Promise<T> => {
    const saved = await config()
    if (!saved || !deps.provider) return fail('PRECONDITION_FAILED', 'a trusted remote backup transport is unavailable', { stateChanged: false })
    const [destination] = await activeDestinations(saved, [id])
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

  async function executeRun(run: BackupRun, accounts: readonly BackupRunAccount[]): Promise<void> {
    const save = async (): Promise<void> => { await persist(current => ({ ...current, runs: current.runs.map(item => item.id === run.id ? structuredClone(run) : item) })).catch(() => undefined) }
    for (const account of accounts) {
      let source: BackupArchiveSource | null = null, file: string | null = null
      try { file = (await deps.createBackup!(account, !run.mailIncluded)).file; source = await deps.readLocalArchive(account, file) } catch { source = null }
      for (const destinationId of run.destinationIds) {
        const entry: BackupRunEntry = { username: account.username, destinationId, file: source ? file : null, bytes: source?.bytes ?? null, sha256: source?.sha256 ?? null, outcome: 'failed', reason: 'backup_failed' }
        run.entries.push(entry)
        if (!source || !file) continue
        const fresh = await config()
        const [destination] = fresh ? await activeDestinations(fresh, [destinationId]) : []
        if (!destination) { entry.reason = 'destination_inactive'; continue }
        let session: BackupTransferSession
        try { session = await openSession(destination) } catch { entry.reason = 'transport_unavailable'; continue }
        const name = backupArchiveName(account.username, file)
        try {
          try { await session.putArchive(name, source, signal()) } catch { entry.outcome = 'unknown'; entry.reason = 'upload_unknown'; continue }
          try {
            const stream = await session.readArchive(name, source.bytes, signal())
            const copy = stream ? await sha256Of(stream, source.bytes) : null
            if (copy && copy.bytes === source.bytes && copy.sha256 === source.sha256) { entry.outcome = 'verified'; entry.reason = null } else entry.reason = 'readback_mismatch'
          } catch { entry.outcome = 'unknown'; entry.reason = 'upload_unknown' }
        } finally { await session.closeAndDrain(AbortSignal.timeout(5000)).catch(() => undefined) }
      }
      await save()
    }
    const verified = run.entries.length > 0 && run.entries.every(entry => entry.outcome === 'verified')
    if (verified && run.trigger === 'schedule') {
      for (const destinationId of run.destinationIds) {
        try {
          const result = await withDestination(destinationId, async (current, destination, session) => applyRetention(session, await retention(current, destination, session, await ledger())))
          run.retention.push({ destinationId, deleted: result.deleted.length, outcome: result.outcome })
        } catch { run.retention.push({ destinationId, deleted: 0, outcome: 'unknown' }) }
      }
    }
    run.state = verified ? 'succeeded' : run.entries.some(entry => entry.outcome === 'unknown') ? 'unknown' : 'failed'
    run.finishedAt = now().toISOString()
    await save()
  }

  async function start(trigger: BackupRun['trigger'], actor: string, expectedRevision?: string): Promise<BackupRun> {
    busy()
    const current = await ledger()
    if (expectedRevision !== undefined && backupRunLedgerRevision(current) !== expectedRevision) return fail('CONFLICT', 'backup run history changed; read it again', { stateChanged: false })
    const saved = await config()
    if (!deps.createBackup || !deps.provider || !saved?.schedule) return fail('PRECONDITION_FAILED', 'scheduled backups need a Linux host executor, a trusted remote transport and a saved schedule', { stateChanged: false })
    const destinations = await activeDestinations(saved, saved.schedule.destinationIds)
    if (!destinations.length || destinations.length !== saved.schedule.destinationIds.length) return fail('PRECONDITION_FAILED', 'every selected destination must be enabled with a current verification', { stateChanged: false })
    const selection = saved.schedule.selectedAccounts
    const accounts = (await deps.listAccounts()).filter(account => account.status !== 'terminating' && USERNAME.test(account.username) && (selection === 'all' || selection.includes(account.username) || selection.includes(account.id)))
    if (!accounts.length || accounts.length > MAX_RUN_ACCOUNTS || accounts.length * destinations.length > BACKUP_RUN_LIMITS.entries) return fail('PRECONDITION_FAILED', 'the schedule must select 1 to ' + MAX_RUN_ACCOUNTS + ' accounts within the run entry limit', { stateChanged: false })
    busy()
    const startedAt = now().toISOString()
    const run: BackupRun = { id: randomUUID(), trigger, actor, startedAt, finishedAt: null, state: 'running', destinationIds: destinations.map(item => item.target.id), accounts: accounts.length, mailIncluded: saved.schedule.includeMail, databasesIncluded: false, entries: [], retention: [] }
    await persist(value => ({ ...value, ...(trigger === 'schedule' ? { lastScheduledAt: startedAt } : {}), runs: [structuredClone(run), ...value.runs].slice(0, BACKUP_RUN_LIMITS.runs) }))
    claim(run.id, () => executeRun(run, accounts).catch(async () => {
      run.state = 'unknown'; run.finishedAt = now().toISOString()
      await persist(value => ({ ...value, runs: value.runs.map(item => item.id === run.id ? structuredClone(run) : item) })).catch(() => undefined)
    }))
    return run
  }

  return {
    view,
    start: (actor: string, expectedRevision: string) => start('manual', actor, expectedRevision),
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
    /** Test and shutdown hook: resolves when the current background operation settles. */
    idle: async (): Promise<void> => { await active?.done },
  }
}
export type BackupRunController = ReturnType<typeof createBackupRunController>
/** Production wiring on a Linux host executor; other hosts pass executor null and the controller reports no_executor. */
export function createHostBackupRunController(input: { executor: AgentExecutor | null; stateRoot: string; provider: BackupTransferProvider | null; listAccounts(): Promise<readonly BackupRunAccount[]>; root?: string; ledgerPath?: string }): BackupRunController {
  const root = input.root ?? defaultBackupArchiveRoot(), executor = input.executor
  return createBackupRunController({ readConfig: readBackupConfigFiles(input.stateRoot), provider: input.provider, listAccounts: input.listAccounts, ...backupLedgerFile(input.ledgerPath),
    createBackup: executor ? (account, excludeMail) => createAccountBackup({ executor, root, account, excludeMail }) : null,
    readLocalArchive: (account, file) => localBackupArchiveSource(root, account, file),
    storeRecovered: async (account, file, chunks, expected) => {
      if (!executor) return fail('PRECONDITION_FAILED', 'archive recovery needs a Linux host executor', { stateChanged: false })
      await executor.runAction({ kind: 'ensure-dir', path: root, mode: 0o700, owner: 'root', group: 'root' })
      await executor.runAction({ kind: 'ensure-dir', path: posix.join(root, account.username), mode: 0o700, owner: 'root', group: 'root' })
      return storeRecoveredBackupArchive(root, account.username, file, chunks, expected)
    } })
}

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const readSmallJson = async (req: Request, keys: readonly string[]): Promise<Record<string, unknown>> => {
  if (req.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') return fail('VALIDATION', 'JSON is required', { stateChanged: false })
  const text = await req.text()
  if (Buffer.byteLength(text) > 1024) return fail('VALIDATION', 'the backup request is too large', { stateChanged: false })
  let body: unknown
  try { body = JSON.parse(text) } catch { return fail('VALIDATION', 'invalid backup request JSON', { stateChanged: false }) }
  if (!object(body) || Object.keys(body).length !== keys.length || keys.some(key => !Object.hasOwn(body, key))) return fail('VALIDATION', 'the backup request takes only ' + keys.join(', '), { stateChanged: false })
  return body
}
const revisionOf = (raw: unknown): string => typeof raw === 'string' && HEX.test(raw) ? raw : fail('VALIDATION', 'a 64-character hexadecimal revision is required', { stateChanged: false })

/** /host/backups/runs and /host/backups/destinations/<id>/{retention,recover}; root only, fresh authority before every mutation. */
export async function handleBackupRunsRoute(req: Request, url: URL, method: string, ctx: { authorize(action: string): Promise<{ actor: string }>; controller: BackupRunController | null }): Promise<Response | null> {
  const runs = url.pathname === '/host/backups/runs', match = /^\/host\/backups\/destinations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(retention|recover)$/.exec(url.pathname)
  if (!runs && !match) return null
  const action = runs ? 'host.backups.runs' : 'host.backups.' + match![2]
  await ctx.authorize(action)
  if (url.search) return fail('VALIDATION', 'backup runs accept no query selectors', { stateChanged: false })
  const allow = match?.[2] === 'recover' ? 'POST' : 'GET, POST'
  if (!allow.split(', ').includes(method)) return new Response(null, { status: 405, headers: { allow } })
  if (!ctx.controller) return fail('PRECONDITION_FAILED', 'scheduled backup execution is unavailable on this host', { stateChanged: false, nativeApplied: false })
  const controller = ctx.controller
  if (runs && method === 'GET') return json(await controller.view())
  if (match?.[2] === 'retention' && method === 'GET') return json(await controller.retentionPreview(match[1]!))
  if (runs) {
    const body = await readSmallJson(req, ['expectedRevision'])
    const { actor } = await ctx.authorize(action)
    const run = await controller.start(actor, revisionOf(body.expectedRevision))
    return json({ runId: run.id, state: run.state }, 202)
  }
  if (match![2] === 'retention') {
    const body = await readSmallJson(req, ['expectedPlanDigest'])
    const digest = revisionOf(body.expectedPlanDigest)
    await ctx.authorize(action)
    return json(await controller.retentionApply(match![1]!, digest))
  }
  const body = await readSmallJson(req, ['expectedRevision', 'runId', 'username', 'file'])
  if (typeof body.runId !== 'string' || !UUID.test(body.runId) || typeof body.username !== 'string' || !USERNAME.test(body.username) || typeof body.file !== 'string') return fail('VALIDATION', 'a recorded run, account and archive are required', { stateChanged: false })
  try { backupArchiveName(body.username, body.file) } catch { return fail('VALIDATION', 'the archive name does not belong to this account', { stateChanged: false }) }
  const expected = revisionOf(body.expectedRevision)
  const { actor } = await ctx.authorize(action)
  const recovery = await controller.recover(match![1]!, { runId: body.runId, username: body.username, file: body.file }, actor, expected)
  return json({ recoveryId: recovery.id, state: recovery.state }, 202)
}
