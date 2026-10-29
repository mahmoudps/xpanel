import { createHash } from 'node:crypto'
import { archiveCreatedAt, BACKUP_ARCHIVE_NAME } from './backup-file-restore-request.ts'

/** Pure scheduled-backup ledger, remote archive key grammar and retention plan, shared by the agent runner and the API reply check. */
export const BACKUP_RUN_LIMITS = { runs: 30, entries: 2000, recoveries: 30, retention: 50, listed: 10_000 } as const
export type BackupRunEntryOutcome = 'verified' | 'failed' | 'unknown'
export const BACKUP_RUN_REASONS = ['backup_failed', 'destination_inactive', 'transport_unavailable', 'upload_unknown', 'readback_mismatch', 'interrupted'] as const
export type BackupRunReason = typeof BACKUP_RUN_REASONS[number]
export interface BackupRunEntry { username: string; destinationId: string; file: string | null; bytes: number | null; sha256: string | null; outcome: BackupRunEntryOutcome; reason: BackupRunReason | null }
export interface BackupRetentionOutcome { destinationId: string; deleted: number; outcome: BackupRunEntryOutcome }
export interface BackupRun {
  id: string; trigger: 'schedule' | 'manual'; actor: string; startedAt: string; finishedAt: string | null; state: 'running' | 'succeeded' | 'failed' | 'unknown'
  destinationIds: string[]; accounts: number; mailIncluded: boolean; databasesIncluded: false; entries: BackupRunEntry[]; retention: BackupRetentionOutcome[]
}
export interface BackupRecovery { id: string; actor: string; destinationId: string; username: string; file: string; startedAt: string; finishedAt: string | null; state: 'running' | 'recovered' | 'failed' | 'unknown'; reason: 'exists' | 'missing' | 'mismatch' | 'transport' | 'interrupted' | null }
export interface BackupRunLedger { version: 1; lastScheduledAt: string | null; runs: BackupRun[]; recoveries: BackupRecovery[] }
export interface BackupRunsView {
  available: boolean; reason: 'no_executor' | 'no_provider' | 'no_schedule' | 'no_destination' | 'invalid_configuration' | null; revision: string
  schedule: { enabled: boolean; cron: string; nextRunAt: string | null; lastScheduledAt: string | null } | null
  activeId: string | null; runs: BackupRun[]; recoveries: BackupRecovery[]; nativeQualified: false
}
export interface BackupRemoteArchive { name: string; bytes: number; lastModified: string }
export interface BackupRetentionRow { name: string; username: string; createdAt: string; bytes: number; action: 'keep' | 'delete'; reason: 'newest' | 'protected' | 'within_count' | 'within_days' | 'expired' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HEX = /^[0-9a-f]{64}$/
const USERNAME = /^[a-z][a-z0-9]{0,15}$/
const ACTOR = /^[A-Za-z0-9_.@:-]{1,64}$/
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
export const EMPTY_BACKUP_RUN_LEDGER: BackupRunLedger = Object.freeze({ version: 1, lastScheduledAt: null, runs: [], recoveries: [] }) as BackupRunLedger
const bad = (): never => { throw new Error('invalid_backup_run_ledger') }
const object = (raw: unknown): raw is Record<string, unknown> => !!raw && typeof raw === 'object' && !Array.isArray(raw)
const exact = (raw: unknown, keys: readonly string[]): Record<string, unknown> => object(raw) && Object.keys(raw).length === keys.length && keys.every(key => Object.hasOwn(raw, key)) ? raw : bad()
const stamp = (raw: unknown, nullable = false): string | null => nullable && raw === null ? null : typeof raw === 'string' && STAMP.test(raw) && Number.isFinite(Date.parse(raw)) ? raw : bad()
const int = (raw: unknown, max: number, nullable = false): number | null => nullable && raw === null ? null : typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 && raw <= max ? raw : bad()
const oneOf = <T extends string>(raw: unknown, values: readonly T[], nullable = false): T | null => nullable && raw === null ? null : values.includes(raw as T) ? raw as T : bad()
const uuid = (raw: unknown): string => typeof raw === 'string' && UUID.test(raw) ? raw : bad()

/** Remote objects are named `<username>/<archive>` under the destination prefix; nothing else is ours. */
export function parseBackupArchiveName(name: unknown): { username: string; file: string; createdAt: string } | null {
  if (typeof name !== 'string' || name.length > 80) return null
  const [username, file, extra] = name.split('/')
  if (extra !== undefined || !username || !file || !USERNAME.test(username) || !BACKUP_ARCHIVE_NAME.test(file) || !file.startsWith(`xpanel-backup-${username}-`)) return null
  return { username, file, createdAt: archiveCreatedAt(file).replace(/Z$/, '.000Z') }
}
export const backupArchiveName = (username: string, file: string): string => parseBackupArchiveName(username + '/' + file)?.file === file ? username + '/' + file : bad()

const entryOf = (raw: unknown): BackupRunEntry => {
  const value = exact(raw, ['username', 'destinationId', 'file', 'bytes', 'sha256', 'outcome', 'reason'])
  if (typeof value.username !== 'string' || !USERNAME.test(value.username) || !(value.file === null || parseBackupArchiveName(value.username + '/' + value.file)) || !(value.sha256 === null || typeof value.sha256 === 'string' && HEX.test(value.sha256))) return bad()
  const entry: BackupRunEntry = { username: value.username, destinationId: uuid(value.destinationId), file: value.file as string | null, bytes: int(value.bytes, Number.MAX_SAFE_INTEGER, true), sha256: value.sha256 as string | null, outcome: oneOf(value.outcome, ['verified', 'failed', 'unknown'])!, reason: oneOf(value.reason, BACKUP_RUN_REASONS, true) }
  // A verified copy always names its archive, size and digest; anything else must say why.
  return entry.outcome === 'verified' ? (entry.file && entry.bytes && entry.sha256 && !entry.reason ? entry : bad()) : entry.reason ? entry : bad()
}
const runOf = (raw: unknown): BackupRun => {
  const value = exact(raw, ['id', 'trigger', 'actor', 'startedAt', 'finishedAt', 'state', 'destinationIds', 'accounts', 'mailIncluded', 'databasesIncluded', 'entries', 'retention'])
  if (typeof value.actor !== 'string' || !ACTOR.test(value.actor) || typeof value.mailIncluded !== 'boolean' || value.databasesIncluded !== false || !Array.isArray(value.destinationIds) || value.destinationIds.length > 50
    || !Array.isArray(value.entries) || value.entries.length > BACKUP_RUN_LIMITS.entries || !Array.isArray(value.retention) || value.retention.length > BACKUP_RUN_LIMITS.retention) return bad()
  const run: BackupRun = { id: uuid(value.id), trigger: oneOf(value.trigger, ['schedule', 'manual'])!, actor: value.actor, startedAt: stamp(value.startedAt)!, finishedAt: stamp(value.finishedAt, true), state: oneOf(value.state, ['running', 'succeeded', 'failed', 'unknown'])!,
    destinationIds: value.destinationIds.map(uuid), accounts: int(value.accounts, 100_000)!, mailIncluded: value.mailIncluded, databasesIncluded: false, entries: value.entries.map(entryOf),
    retention: value.retention.map(item => { const r = exact(item, ['destinationId', 'deleted', 'outcome']); return { destinationId: uuid(r.destinationId), deleted: int(r.deleted, BACKUP_RUN_LIMITS.listed)!, outcome: oneOf(r.outcome, ['verified', 'failed', 'unknown'])! } }) }
  // An interrupted run is unknown and has no observed end time; only running and unknown runs lack finishedAt.
  if (run.state === 'running' && run.finishedAt !== null || (run.state === 'succeeded' || run.state === 'failed') && run.finishedAt === null || run.state === 'succeeded' && (!run.entries.length || run.entries.some(entry => entry.outcome !== 'verified'))) return bad()
  return run
}
const recoveryOf = (raw: unknown): BackupRecovery => {
  const value = exact(raw, ['id', 'actor', 'destinationId', 'username', 'file', 'startedAt', 'finishedAt', 'state', 'reason'])
  if (typeof value.actor !== 'string' || !ACTOR.test(value.actor) || typeof value.username !== 'string' || typeof value.file !== 'string' || !parseBackupArchiveName(value.username + '/' + value.file)) return bad()
  const recovery: BackupRecovery = { id: uuid(value.id), actor: value.actor, destinationId: uuid(value.destinationId), username: value.username, file: value.file, startedAt: stamp(value.startedAt)!, finishedAt: stamp(value.finishedAt, true), state: oneOf(value.state, ['running', 'recovered', 'failed', 'unknown'])!, reason: oneOf(value.reason, ['exists', 'missing', 'mismatch', 'transport', 'interrupted'], true) }
  return !(recovery.state === 'running' && recovery.finishedAt !== null) && !((recovery.state === 'recovered' || recovery.state === 'failed') && recovery.finishedAt === null) && (recovery.state === 'recovered' || recovery.state === 'running') === (recovery.reason === null) ? recovery : bad()
}
/** Strict ledger reader; null is "no run yet". Anything unreadable throws so a corrupt ledger is never shown as empty. */
export function readBackupRunLedger(raw: unknown): BackupRunLedger {
  if (raw === null || raw === undefined) return { version: 1, lastScheduledAt: null, runs: [], recoveries: [] }
  const value = exact(raw, ['version', 'lastScheduledAt', 'runs', 'recoveries'])
  if (value.version !== 1 || !Array.isArray(value.runs) || value.runs.length > BACKUP_RUN_LIMITS.runs || !Array.isArray(value.recoveries) || value.recoveries.length > BACKUP_RUN_LIMITS.recoveries) return bad()
  const ledger: BackupRunLedger = { version: 1, lastScheduledAt: stamp(value.lastScheduledAt, true), runs: value.runs.map(runOf), recoveries: value.recoveries.map(recoveryOf) }
  if (new Set(ledger.runs.map(run => run.id)).size !== ledger.runs.length || new Set(ledger.recoveries.map(item => item.id)).size !== ledger.recoveries.length || ledger.runs.filter(run => run.state === 'running').length + ledger.recoveries.filter(item => item.state === 'running').length > 1) return bad()
  return ledger
}
export const backupRunLedgerRevision = (ledger: BackupRunLedger): string => createHash('sha256').update(JSON.stringify(ledger)).digest('hex')

/** Strict reader of the agent reply for GET /host/backups/runs. */
export function readBackupRunsView(raw: unknown): BackupRunsView {
  const value = exact(raw, ['available', 'reason', 'revision', 'schedule', 'activeId', 'runs', 'recoveries', 'nativeQualified'])
  if (typeof value.available !== 'boolean' || value.nativeQualified !== false || typeof value.revision !== 'string' || !HEX.test(value.revision)) return bad()
  const reason = oneOf(value.reason, ['no_executor', 'no_provider', 'no_schedule', 'no_destination', 'invalid_configuration'], true)
  if (value.available !== (reason === null)) return bad()
  let schedule: BackupRunsView['schedule'] = null
  if (value.schedule !== null) {
    const s = exact(value.schedule, ['enabled', 'cron', 'nextRunAt', 'lastScheduledAt'])
    if (typeof s.enabled !== 'boolean' || typeof s.cron !== 'string' || s.cron.length > 100 || !/^[0-9*,/ -]+$/.test(s.cron)) return bad()
    schedule = { enabled: s.enabled, cron: s.cron, nextRunAt: stamp(s.nextRunAt, true), lastScheduledAt: stamp(s.lastScheduledAt, true) }
  }
  const ledger = readBackupRunLedger({ version: 1, lastScheduledAt: schedule?.lastScheduledAt ?? null, runs: value.runs, recoveries: value.recoveries })
  const activeId = value.activeId === null ? null : uuid(value.activeId)
  const running = [...ledger.runs, ...ledger.recoveries].find(item => item.state === 'running')
  if ((running?.id ?? null) !== activeId) return bad()
  return { available: value.available, reason, revision: value.revision, schedule, activeId, runs: ledger.runs, recoveries: ledger.recoveries, nativeQualified: false }
}

/**
 * Per account, keep the newest archive, every protected name (newest verified ledger copy, active run) and the newest
 * `retentionCount`; delete only archives that are also older than `retentionDays`. Unknown names are never listed.
 */
export function planBackupRetention(input: { archives: readonly BackupRemoteArchive[]; retentionDays: number; retentionCount: number; protectedNames: ReadonlySet<string>; now: Date }): { rows: BackupRetentionRow[]; planDigest: string } {
  const cutoff = input.now.getTime() - input.retentionDays * 86_400_000
  const groups = new Map<string, (BackupRemoteArchive & { username: string; createdAt: string })[]>()
  for (const archive of input.archives) {
    const parsed = parseBackupArchiveName(archive.name)
    if (!parsed) continue
    groups.set(parsed.username, [...groups.get(parsed.username) ?? [], { ...archive, username: parsed.username, createdAt: parsed.createdAt }])
  }
  const rows: BackupRetentionRow[] = []
  for (const [username, archives] of [...groups].sort(([a], [b]) => a < b ? -1 : 1)) {
    archives.sort((a, b) => a.name < b.name ? 1 : -1).forEach((archive, rank) => {
      const reason: BackupRetentionRow['reason'] = rank === 0 ? 'newest' : input.protectedNames.has(archive.name) ? 'protected' : rank < input.retentionCount ? 'within_count' : Date.parse(archive.createdAt) >= cutoff ? 'within_days' : 'expired'
      rows.push({ name: archive.name, username, createdAt: archive.createdAt, bytes: archive.bytes, action: reason === 'expired' ? 'delete' : 'keep', reason })
    })
  }
  return { rows, planDigest: createHash('sha256').update(JSON.stringify([input.retentionDays, input.retentionCount, rows])).digest('hex') }
}
