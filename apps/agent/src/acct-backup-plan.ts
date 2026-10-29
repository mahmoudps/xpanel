import { createHash } from 'node:crypto'
import { archiveCreatedAt, BACKUP_ARCHIVE_NAME } from './backup-file-restore-request.ts'

/** Pure scheduled-backup ledger, remote archive key grammar and retention plan, shared by the agent runner and the API reply check. */
export const BACKUP_RUN_LIMITS = { runs: 30, entries: 2000, recoveries: 30, restores: 30, restoreItems: 20, retention: 50, listed: 10_000, detail: 500 } as const
/** Pseudo-account of the once-per-run control-state snapshot; never a username (usernames start with a letter). */
export const BACKUP_CONTROL = '_control'
const CONTROL_ARCHIVE = /^xpanel-control-([0-9]{8}T[0-9]{6}Z)(?:-[a-f0-9]{12})?\.tar\.gz$/
export type BackupRunEntryOutcome = 'verified' | 'failed' | 'unknown'
export const BACKUP_RUN_REASONS = ['backup_failed', 'integrity_failed', 'destination_inactive', 'transport_unavailable', 'upload_unknown', 'readback_mismatch', 'interrupted'] as const
export type BackupRunReason = typeof BACKUP_RUN_REASONS[number]
export interface BackupRunEntry { username: string; destinationId: string; file: string | null; bytes: number | null; sha256: string | null; outcome: BackupRunEntryOutcome; reason: BackupRunReason | null }
export interface BackupRetentionOutcome { destinationId: string; deleted: number; outcome: BackupRunEntryOutcome }
/**
 * The local archive of one account (or the control snapshot) in a run: built, then fully read back (gzip CRC and every tar
 * header) before any upload. `detail` keeps the failing command's message, without control characters, for the run log.
 */
export interface BackupRunArchive { username: string; file: string | null; bytes: number | null; sha256: string | null; databases: string[]; zones: string[]; integrity: 'verified' | 'failed'; reason: 'backup_failed' | 'integrity_failed' | null; detail: string | null }
export interface BackupRun {
  /** `account` runs back up selected accounts again: no control snapshot and no retention. */
  id: string; trigger: 'schedule' | 'manual' | 'account'; actor: string; startedAt: string; finishedAt: string | null; state: 'running' | 'succeeded' | 'failed' | 'unknown'
  destinationIds: string[]; accounts: number; mailIncluded: boolean; databasesIncluded: boolean; dnsIncluded: boolean
  archives: BackupRunArchive[]; control: BackupRunArchive | null; entries: BackupRunEntry[]; retention: BackupRetentionOutcome[]
  /** Local archives removed by retention after a successful scheduled run; null when retention did not run. */
  localDeleted: number | null
}
export interface BackupRecovery { id: string; actor: string; destinationId: string; username: string; file: string; startedAt: string; finishedAt: string | null; state: 'running' | 'recovered' | 'failed' | 'unknown'; reason: 'exists' | 'missing' | 'mismatch' | 'transport' | 'interrupted' | null }
export const BACKUP_PART_RESTORE_RESULTS = ['restored', 'failed', 'not-attempted'] as const
export const BACKUP_PART_RESTORE_REASONS = ['not-in-archive', 'database-missing', 'zone-missing', 'digest-mismatch', 'extract-failed', 'restore-failed', 'archive-changed', 'interrupted'] as const
export type BackupPartRestoreItem = { part: 'database' | 'dns'; name: string; bytes: number | null; result: typeof BACKUP_PART_RESTORE_RESULTS[number]; reason: typeof BACKUP_PART_RESTORE_REASONS[number] | null }
/** Databases and DNS zones restored from one ledger-verified server archive, one result per selected item. */
export interface BackupPartRestore { id: string; actor: string; username: string; file: string; startedAt: string; finishedAt: string | null; state: 'running' | 'finished' | 'unknown'; items: BackupPartRestoreItem[] }
export interface BackupRunLedger { version: 1; lastScheduledAt: string | null; runs: BackupRun[]; recoveries: BackupRecovery[]; restores: BackupPartRestore[] }
export interface BackupStorageSpace { freeBytes: number; totalBytes: number }
export interface BackupRunsView {
  /** `invalid_ledger`: the run history file is in an older or damaged format; move it aside to start a new history. */
  available: boolean; reason: 'no_executor' | 'no_provider' | 'no_schedule' | 'no_destination' | 'invalid_configuration' | 'invalid_ledger' | null; revision: string
  schedule: { enabled: boolean; cron: string; nextRunAt: string | null; lastScheduledAt: string | null } | null
  /** Space on the filesystem of the local archive store; null where it cannot be read. */
  storage: BackupStorageSpace | null
  activeId: string | null; runs: BackupRun[]; recoveries: BackupRecovery[]; restores: BackupPartRestore[]; nativeQualified: false
}
export interface BackupRemoteArchive { name: string; bytes: number; lastModified: string }
export const BACKUP_RETENTION_REASONS = ['newest', 'protected', 'within_count', 'weekly', 'monthly', 'within_days', 'expired'] as const
export interface BackupRetentionRow { name: string; username: string; createdAt: string; bytes: number; action: 'keep' | 'delete'; reason: typeof BACKUP_RETENTION_REASONS[number] }
/** Grandfather-father-son copies: the newest `daily` archives, plus the newest archive of each of the last `weekly` ISO weeks and `monthly` months. */
export interface BackupRetentionKeep { daily: number; weekly: number; monthly: number }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HEX = /^[0-9a-f]{64}$/
const USERNAME = /^[a-z][a-z0-9]{0,15}$/
const ACTOR = /^[A-Za-z0-9_.@:-]{1,64}$/
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const DATABASE = /^[a-z][a-z0-9]{0,15}_[a-z0-9_]{1,47}$/
const ZONE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/
export const EMPTY_BACKUP_RUN_LEDGER: BackupRunLedger = Object.freeze({ version: 1, lastScheduledAt: null, runs: [], recoveries: [], restores: [] }) as BackupRunLedger
const bad = (): never => { throw new Error('invalid_backup_run_ledger') }
const object = (raw: unknown): raw is Record<string, unknown> => !!raw && typeof raw === 'object' && !Array.isArray(raw)
const exact = (raw: unknown, keys: readonly string[]): Record<string, unknown> => object(raw) && Object.keys(raw).length === keys.length && keys.every(key => Object.hasOwn(raw, key)) ? raw : bad()
const stamp = (raw: unknown, nullable = false): string | null => nullable && raw === null ? null : typeof raw === 'string' && STAMP.test(raw) && Number.isFinite(Date.parse(raw)) ? raw : bad()
const int = (raw: unknown, max: number, nullable = false): number | null => nullable && raw === null ? null : typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 && raw <= max ? raw : bad()
const oneOf = <T extends string>(raw: unknown, values: readonly T[], nullable = false): T | null => nullable && raw === null ? null : values.includes(raw as T) ? raw as T : bad()
const uuid = (raw: unknown): string => typeof raw === 'string' && UUID.test(raw) ? raw : bad()
export const isBackupZoneName = (name: unknown): name is string => typeof name === 'string' && ZONE.test(name)
/** One line of a failing command's message for the run log: printable, bounded, never empty. */
export const backupRunDetail = (raw: unknown): string | null => {
  const text = String(raw instanceof Error ? raw.message : raw ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]+/gu, ' ').trim().slice(0, BACKUP_RUN_LIMITS.detail)
  return text || null
}

/** Remote objects are named `<username>/<archive>` (or `_control/<snapshot>`) under the destination prefix; nothing else is ours. */
export function parseBackupArchiveName(name: unknown): { username: string; file: string; createdAt: string } | null {
  if (typeof name !== 'string' || name.length > 80) return null
  const [username, file, extra] = name.split('/')
  if (extra !== undefined || !username || !file) return null
  if (username === BACKUP_CONTROL) {
    const stamp = CONTROL_ARCHIVE.exec(file)?.[1]
    return stamp ? { username, file, createdAt: `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}.000Z` } : null
  }
  if (!USERNAME.test(username) || !BACKUP_ARCHIVE_NAME.test(file) || !file.startsWith(`xpanel-backup-${username}-`)) return null
  return { username, file, createdAt: archiveCreatedAt(file).replace(/Z$/, '.000Z') }
}
export const backupArchiveName = (username: string, file: string): string => parseBackupArchiveName(username + '/' + file)?.file === file ? username + '/' + file : bad()

const entryOf = (raw: unknown): BackupRunEntry => {
  const value = exact(raw, ['username', 'destinationId', 'file', 'bytes', 'sha256', 'outcome', 'reason'])
  if (typeof value.username !== 'string' || !(USERNAME.test(value.username) || value.username === BACKUP_CONTROL) || !(value.file === null || parseBackupArchiveName(value.username + '/' + value.file)) || !(value.sha256 === null || typeof value.sha256 === 'string' && HEX.test(value.sha256))) return bad()
  const entry: BackupRunEntry = { username: value.username, destinationId: uuid(value.destinationId), file: value.file as string | null, bytes: int(value.bytes, Number.MAX_SAFE_INTEGER, true), sha256: value.sha256 as string | null, outcome: oneOf(value.outcome, ['verified', 'failed', 'unknown'])!, reason: oneOf(value.reason, BACKUP_RUN_REASONS, true) }
  // A verified copy always names its archive, size and digest; anything else must say why.
  return entry.outcome === 'verified' ? (entry.file && entry.bytes && entry.sha256 && !entry.reason ? entry : bad()) : entry.reason ? entry : bad()
}
const archiveOf = (raw: unknown, control = false): BackupRunArchive => {
  const value = exact(raw, ['username', 'file', 'bytes', 'sha256', 'databases', 'zones', 'integrity', 'reason', 'detail'])
  if (typeof value.username !== 'string' || (control ? value.username !== BACKUP_CONTROL : !USERNAME.test(value.username)) || !(value.file === null || parseBackupArchiveName(value.username + '/' + value.file)) || !(value.sha256 === null || typeof value.sha256 === 'string' && HEX.test(value.sha256))
    || !Array.isArray(value.databases) || value.databases.length > 1000 || value.databases.some(name => typeof name !== 'string' || !DATABASE.test(name) || !name.startsWith(value.username + '_'))
    || !Array.isArray(value.zones) || value.zones.length > 1000 || !value.zones.every(isBackupZoneName) || control && (value.databases.length || value.zones.length)
    || !(value.detail === null || typeof value.detail === 'string' && backupRunDetail(value.detail) === value.detail)) return bad()
  const archive: BackupRunArchive = { username: value.username, file: value.file as string | null, bytes: int(value.bytes, Number.MAX_SAFE_INTEGER, true), sha256: value.sha256 as string | null, databases: [...value.databases as string[]], zones: [...value.zones as string[]],
    integrity: oneOf(value.integrity, ['verified', 'failed'])!, reason: oneOf(value.reason, ['backup_failed', 'integrity_failed'], true), detail: value.detail as string | null }
  return archive.integrity === 'verified' ? (archive.file && archive.bytes && archive.sha256 && !archive.reason && !archive.detail ? archive : bad()) : archive.reason ? archive : bad()
}
const runOf = (raw: unknown): BackupRun => {
  const value = exact(raw, ['id', 'trigger', 'actor', 'startedAt', 'finishedAt', 'state', 'destinationIds', 'accounts', 'mailIncluded', 'databasesIncluded', 'dnsIncluded', 'archives', 'control', 'entries', 'retention', 'localDeleted'])
  if (typeof value.actor !== 'string' || !ACTOR.test(value.actor) || typeof value.mailIncluded !== 'boolean' || typeof value.databasesIncluded !== 'boolean' || typeof value.dnsIncluded !== 'boolean' || !Array.isArray(value.destinationIds) || value.destinationIds.length > 50
    || !Array.isArray(value.archives) || value.archives.length > BACKUP_RUN_LIMITS.entries || !Array.isArray(value.entries) || value.entries.length > BACKUP_RUN_LIMITS.entries || !Array.isArray(value.retention) || value.retention.length > BACKUP_RUN_LIMITS.retention) return bad()
  const run: BackupRun = { id: uuid(value.id), trigger: oneOf(value.trigger, ['schedule', 'manual', 'account'])!, actor: value.actor, startedAt: stamp(value.startedAt)!, finishedAt: stamp(value.finishedAt, true), state: oneOf(value.state, ['running', 'succeeded', 'failed', 'unknown'])!,
    destinationIds: value.destinationIds.map(uuid), accounts: int(value.accounts, 100_000)!, mailIncluded: value.mailIncluded, databasesIncluded: value.databasesIncluded, dnsIncluded: value.dnsIncluded,
    archives: value.archives.map(item => archiveOf(item)), control: value.control === null ? null : archiveOf(value.control, true), entries: value.entries.map(entryOf), localDeleted: int(value.localDeleted, BACKUP_RUN_LIMITS.listed, true),
    retention: value.retention.map(item => { const r = exact(item, ['destinationId', 'deleted', 'outcome']); return { destinationId: uuid(r.destinationId), deleted: int(r.deleted, BACKUP_RUN_LIMITS.listed)!, outcome: oneOf(r.outcome, ['verified', 'failed', 'unknown'])! } }) }
  // An interrupted run is unknown and has no observed end time; only running and unknown runs lack finishedAt.
  // A success has every local archive (and the control snapshot) verified and every remote copy re-read.
  const copies = run.archives.length + (run.control ? 1 : 0)
  if (run.state === 'running' && run.finishedAt !== null || (run.state === 'succeeded' || run.state === 'failed') && run.finishedAt === null || run.trigger === 'account' && run.control
    || run.state === 'succeeded' && (!run.archives.length || [...run.archives, ...run.control ? [run.control] : []].some(archive => archive.integrity !== 'verified') || run.entries.some(entry => entry.outcome !== 'verified') || run.entries.length !== copies * run.destinationIds.length)) return bad()
  return run
}
const recoveryOf = (raw: unknown): BackupRecovery => {
  const value = exact(raw, ['id', 'actor', 'destinationId', 'username', 'file', 'startedAt', 'finishedAt', 'state', 'reason'])
  if (typeof value.actor !== 'string' || !ACTOR.test(value.actor) || typeof value.username !== 'string' || !USERNAME.test(value.username) || typeof value.file !== 'string' || !parseBackupArchiveName(value.username + '/' + value.file)) return bad()
  const recovery: BackupRecovery = { id: uuid(value.id), actor: value.actor, destinationId: uuid(value.destinationId), username: value.username, file: value.file, startedAt: stamp(value.startedAt)!, finishedAt: stamp(value.finishedAt, true), state: oneOf(value.state, ['running', 'recovered', 'failed', 'unknown'])!, reason: oneOf(value.reason, ['exists', 'missing', 'mismatch', 'transport', 'interrupted'], true) }
  return !(recovery.state === 'running' && recovery.finishedAt !== null) && !((recovery.state === 'recovered' || recovery.state === 'failed') && recovery.finishedAt === null) && (recovery.state === 'recovered' || recovery.state === 'running') === (recovery.reason === null) ? recovery : bad()
}
const restoreOf = (raw: unknown): BackupPartRestore => {
  const value = exact(raw, ['id', 'actor', 'username', 'file', 'startedAt', 'finishedAt', 'state', 'items'])
  if (typeof value.actor !== 'string' || !ACTOR.test(value.actor) || typeof value.username !== 'string' || !USERNAME.test(value.username) || typeof value.file !== 'string' || !parseBackupArchiveName(value.username + '/' + value.file)
    || !Array.isArray(value.items) || !value.items.length || value.items.length > BACKUP_RUN_LIMITS.restoreItems) return bad()
  const username = value.username
  const items = value.items.map((item): BackupPartRestoreItem => {
    const row = exact(item, ['part', 'name', 'bytes', 'result', 'reason'])
    const part = oneOf(row.part, ['database', 'dns'] as const)!
    if (part === 'database' ? typeof row.name !== 'string' || !DATABASE.test(row.name) || !row.name.startsWith(username + '_') : !isBackupZoneName(row.name)) return bad()
    const parsed = { part, name: row.name as string, bytes: int(row.bytes, Number.MAX_SAFE_INTEGER, true), result: oneOf(row.result, BACKUP_PART_RESTORE_RESULTS)!, reason: oneOf(row.reason, BACKUP_PART_RESTORE_REASONS, true) }
    return (parsed.result === 'restored') === (parsed.reason === null) ? parsed : bad()
  })
  const restore: BackupPartRestore = { id: uuid(value.id), actor: value.actor, username, file: value.file, startedAt: stamp(value.startedAt)!, finishedAt: stamp(value.finishedAt, true), state: oneOf(value.state, ['running', 'finished', 'unknown'])!, items }
  return new Set(items.map(item => item.part + ':' + item.name)).size === items.length && !(restore.state === 'running' && restore.finishedAt !== null) && !(restore.state === 'finished' && restore.finishedAt === null) ? restore : bad()
}
/** Strict ledger reader; null is "no run yet". Anything unreadable throws so a corrupt ledger is never shown as empty. */
export function readBackupRunLedger(raw: unknown): BackupRunLedger {
  if (raw === null || raw === undefined) return { version: 1, lastScheduledAt: null, runs: [], recoveries: [], restores: [] }
  const value = exact(raw, ['version', 'lastScheduledAt', 'runs', 'recoveries', 'restores'])
  if (value.version !== 1 || !Array.isArray(value.runs) || value.runs.length > BACKUP_RUN_LIMITS.runs || !Array.isArray(value.recoveries) || value.recoveries.length > BACKUP_RUN_LIMITS.recoveries || !Array.isArray(value.restores) || value.restores.length > BACKUP_RUN_LIMITS.restores) return bad()
  const ledger: BackupRunLedger = { version: 1, lastScheduledAt: stamp(value.lastScheduledAt, true), runs: value.runs.map(runOf), recoveries: value.recoveries.map(recoveryOf), restores: value.restores.map(restoreOf) }
  const ids = [...ledger.runs, ...ledger.recoveries, ...ledger.restores].map(item => item.id)
  if (new Set(ids).size !== ids.length || [...ledger.runs, ...ledger.recoveries, ...ledger.restores].filter(item => item.state === 'running').length > 1) return bad()
  return ledger
}
export const backupRunLedgerRevision = (ledger: BackupRunLedger): string => createHash('sha256').update(JSON.stringify(ledger)).digest('hex')
const spaceOf = (raw: unknown): BackupStorageSpace | null => {
  if (raw === null) return null
  const value = exact(raw, ['freeBytes', 'totalBytes'])
  const space = { freeBytes: int(value.freeBytes, Number.MAX_SAFE_INTEGER)!, totalBytes: int(value.totalBytes, Number.MAX_SAFE_INTEGER)! }
  return space.freeBytes <= space.totalBytes ? space : bad()
}

/** Strict reader of the agent reply for GET /host/backups/runs. */
export function readBackupRunsView(raw: unknown): BackupRunsView {
  const value = exact(raw, ['available', 'reason', 'revision', 'schedule', 'storage', 'activeId', 'runs', 'recoveries', 'restores', 'nativeQualified'])
  if (typeof value.available !== 'boolean' || value.nativeQualified !== false || typeof value.revision !== 'string' || !HEX.test(value.revision)) return bad()
  const reason = oneOf(value.reason, ['no_executor', 'no_provider', 'no_schedule', 'no_destination', 'invalid_configuration', 'invalid_ledger'], true)
  if (value.available !== (reason === null)) return bad()
  let schedule: BackupRunsView['schedule'] = null
  if (value.schedule !== null) {
    const s = exact(value.schedule, ['enabled', 'cron', 'nextRunAt', 'lastScheduledAt'])
    if (typeof s.enabled !== 'boolean' || typeof s.cron !== 'string' || s.cron.length > 100 || !/^[0-9*,/ -]+$/.test(s.cron)) return bad()
    schedule = { enabled: s.enabled, cron: s.cron, nextRunAt: stamp(s.nextRunAt, true), lastScheduledAt: stamp(s.lastScheduledAt, true) }
  }
  const ledger = readBackupRunLedger({ version: 1, lastScheduledAt: schedule?.lastScheduledAt ?? null, runs: value.runs, recoveries: value.recoveries, restores: value.restores })
  const activeId = value.activeId === null ? null : uuid(value.activeId)
  const running = [...ledger.runs, ...ledger.recoveries, ...ledger.restores].find(item => item.state === 'running')
  if ((running?.id ?? null) !== activeId) return bad()
  return { available: value.available, reason, revision: value.revision, schedule, storage: spaceOf(value.storage), activeId, runs: ledger.runs, recoveries: ledger.recoveries, restores: ledger.restores, nativeQualified: false }
}

const isoWeek = (date: Date): string => {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7))
  return day.getUTCFullYear() + '-W' + Math.ceil(((day.getTime() - Date.UTC(day.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7)
}
/**
 * Per account, keep the newest archive, every protected name (newest verified ledger copy, active run, recovered copy), the newest
 * `keep.daily`, and the newest archive of each of the last `keep.weekly` ISO weeks and `keep.monthly` months; delete only archives that
 * are also older than `retentionDays`. Unknown names are never listed.
 */
export function planBackupRetention(input: { archives: readonly BackupRemoteArchive[]; retentionDays: number; keep: BackupRetentionKeep; protectedNames: ReadonlySet<string>; now: Date }): { rows: BackupRetentionRow[]; planDigest: string } {
  const cutoff = input.now.getTime() - input.retentionDays * 86_400_000
  const groups = new Map<string, (BackupRemoteArchive & { username: string; createdAt: string })[]>()
  for (const archive of input.archives) {
    const parsed = parseBackupArchiveName(archive.name)
    if (!parsed) continue
    groups.set(parsed.username, [...groups.get(parsed.username) ?? [], { ...archive, username: parsed.username, createdAt: parsed.createdAt }])
  }
  const rows: BackupRetentionRow[] = []
  for (const [username, archives] of [...groups].sort(([a], [b]) => a < b ? -1 : 1)) {
    archives.sort((a, b) => a.name < b.name ? 1 : -1)
    // The newest archive of a period represents it; the newest `weekly`/`monthly` periods are kept.
    const representatives = (period: (date: Date) => string, count: number): Set<string> => {
      const seen = new Map<string, string>()
      for (const archive of archives) { const key = period(new Date(archive.createdAt)); if (!seen.has(key)) seen.set(key, archive.name) }
      return new Set([...seen.values()].slice(0, count))
    }
    const weekly = representatives(isoWeek, input.keep.weekly), monthly = representatives(date => date.toISOString().slice(0, 7), input.keep.monthly)
    archives.forEach((archive, rank) => {
      const reason: BackupRetentionRow['reason'] = rank === 0 ? 'newest' : input.protectedNames.has(archive.name) ? 'protected' : rank < input.keep.daily ? 'within_count'
        : weekly.has(archive.name) ? 'weekly' : monthly.has(archive.name) ? 'monthly' : Date.parse(archive.createdAt) >= cutoff ? 'within_days' : 'expired'
      rows.push({ name: archive.name, username, createdAt: archive.createdAt, bytes: archive.bytes, action: reason === 'expired' ? 'delete' : 'keep', reason })
    })
  }
  return { rows, planDigest: createHash('sha256').update(JSON.stringify([input.retentionDays, input.keep, rows])).digest('hex') }
}
