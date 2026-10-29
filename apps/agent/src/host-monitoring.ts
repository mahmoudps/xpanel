import { fail } from '@xpanel/core'
import {
  MONITORING_DF_INODE_ARGV, MONITORING_DF_SPACE_ARGV, MONITORING_PS_ARGV, monitoringJournalArgv, monitoringKillArgv,
} from '../../../packages/os/src/monitoring-command.ts'
import type { MonitoringLogQuery, MonitoringSignal, MonitoringSignalRequest } from '../../../packages/os/src/monitoring-command.ts'
import { ioMountForTarget } from './io-device.ts'

export interface MonitoringCommandResult { ok: boolean; stdout: string; stderr: string }
export type MonitoringRun = (argv: string[]) => Promise<MonitoringCommandResult>
export interface MonitoringAccount { username: string; uid: number; status?: string }

export const MAX_PROCESS_ROWS = 4000
const MAX_PS_LINES = 65_536
const MAX_DF_LINES = 4096
const MAX_LOG_MESSAGE_BYTES = 4096
/** The API reads at most 1 MiB from the agent; keep the whole log response below it. */
const MAX_LOG_ITEM_BYTES = 960 * 1024
const IDENTITY_START_TOLERANCE_MS = 2000

export interface ObservedProcess {
  pid: number; ppid: number; uid: number; user: string
  cpuPercent: number; memoryPercent: number; rssBytes: number; elapsedSeconds: number
  /** Derived from etimes at observation time, second precision. */
  startedAt: string
  stat: string; comm: string
}
export type ProcessProtection = 'init' | 'kernel' | 'agent' | 'root' | 'panel' | 'protected-command'
export interface ProcessView extends ObservedProcess { account: string | null; protection: ProcessProtection | null }
export interface ProcessAccountSummary { username: string; processes: number; cpuPercent: number; rssBytes: number }
export interface ProcessObservation {
  state: 'read' | 'unavailable'; observedAt: string; total: number; truncated: boolean
  items: ProcessView[]; accounts: ProcessAccountSummary[]
  reason?: 'process-list-unavailable' | 'invalid-process-list'
}
export interface FilesystemView {
  filesystem: string; type: string; mount: string; totalBytes: number; usedBytes: number; availableBytes: number
  /** Null when the filesystem reports no inode table (for example btrfs) or the inode read is unavailable. */
  inodes: { total: number; used: number; free: number } | null
}
export interface AccountDiskView { username: string; usedBytes: number | null; limitBytes: number | null }
export interface DiskObservation {
  observedAt: string
  filesystems: { state: 'read' | 'unavailable'; items: FilesystemView[]; inodes: 'read' | 'unavailable'; reason?: 'filesystems-unavailable' | 'invalid-filesystems' }
  accounts: { state: 'read' | 'unavailable'; source: 'repquota'; mount: string | null; items: AccountDiskView[]; reason?: 'quota-mount-unavailable' | 'quota-report-unavailable' | 'invalid-quota-report' }
}
export interface LogEntryView { at: string; priority: number | null; unit: string | null; pid: number | null; message: string | null; messageTruncated: boolean }
export interface LogObservation {
  state: 'read' | 'unavailable'; unit: string; lines: number; since: string | null; priority: number | null
  observedAt: string; order: 'newest-first'; truncated: boolean; items: LogEntryView[]
  reason?: 'journal-unavailable' | 'invalid-journal'
}
export interface SignalOutcome {
  state: 'confirmed' | 'attempted' | 'unknown'; signal: MonitoringSignal; pid: number
  commandOk: boolean; observedAt: string; verificationRequired: boolean
}

const command = async (run: MonitoringRun, argv: readonly string[]): Promise<MonitoringCommandResult> => {
  try { return await run([...argv]) } catch { return { ok: false, stdout: '', stderr: '' } }
}
const integer = (text: string, max = Number.MAX_SAFE_INTEGER): number => {
  const value = Number(text)
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value > max) throw new Error('invalid_integer')
  return value
}
const dataLines = (stdout: string, max: number): string[] => {
  if (typeof stdout !== 'string' || stdout.includes('\u0000')) throw new Error('invalid_output')
  const lines = stdout.split('\n').filter(line => line.trim().length > 0)
  if (lines.length > max) throw new Error('output_capacity')
  return lines
}

// procps ps(1): pcpu/pmem are percentages, rss is KiB, etimes is seconds; comm is last so it may contain spaces.
const PS_ROW = /^\s*(\d{1,7})\s+(\d{1,7})\s+(\d{1,10})\s+(\S{1,64})\s+(\d{1,6}(?:\.\d{1,3})?)\s+(\d{1,3}(?:\.\d{1,3})?)\s+(\d{1,15})\s+(\d{1,12})\s+([DIRSTtWXZ<NLsl+]{1,8})\s+(.{1,64})$/
export function parsePsOutput(stdout: string, observedAtMs: number): ObservedProcess[] {
  const nowSeconds = Math.floor(observedAtMs / 1000), seen = new Set<number>()
  return dataLines(stdout, MAX_PS_LINES).map(line => {
    const match = PS_ROW.exec(line)
    if (!match || /[\u0000-\u001f\u007f]/.test(match[10]!)) throw new Error('invalid_process_row')
    const pid = integer(match[1]!), elapsedSeconds = integer(match[8]!)
    if (pid < 1 || seen.has(pid) || elapsedSeconds > nowSeconds) throw new Error('invalid_process_row')
    seen.add(pid)
    return {
      pid, ppid: integer(match[2]!), uid: integer(match[3]!, 4_294_967_295), user: match[4]!,
      cpuPercent: Number(match[5]), memoryPercent: Number(match[6]), rssBytes: integer(match[7]!) * 1024, elapsedSeconds,
      startedAt: new Date((nowSeconds - elapsedSeconds) * 1000).toISOString(), stat: match[9]!, comm: match[10]!,
    }
  })
}

const PROTECTED_COMMANDS = new Set(['systemd', 'init', 'sshd', 'mariadbd', 'mysqld', 'master', 'dovecot', 'pdns_server', 'pdns_recursor', 'nft', 'dbus-daemon', 'dbus-broker', 'rsyslogd', 'cron', 'crond', 'agetty', 'chronyd', 'polkitd'])
const PANEL_USERS = new Set(['xpanel', 'xpanel-agent'])
/** Evaluated on the fresh host read only. Root, the panel and core service masters are never signalled from here. */
export function processProtection(row: Pick<ObservedProcess, 'pid' | 'ppid' | 'uid' | 'user' | 'comm'>, self: { pid: number; ppid: number }): ProcessProtection | null {
  if (row.pid <= 1) return 'init'
  // Linux kernel threads are kthreadd (pid 2) and its children.
  if (row.pid === 2 || row.ppid === 2) return 'kernel'
  if (row.pid === self.pid || row.pid === self.ppid) return 'agent'
  if (row.uid === 0) return 'root'
  if (PANEL_USERS.has(row.user)) return 'panel'
  // nginx and postfix workers respawn under their master; the masters run as root or are named explicitly.
  if (PROTECTED_COMMANDS.has(row.comm) || row.comm.startsWith('systemd-') || row.comm.startsWith('xpanel') || row.comm === 'nginx' && row.ppid === 1) return 'protected-command'
  return null
}

export const sameProcessIdentity = (row: ObservedProcess, reviewed: Pick<MonitoringSignalRequest, 'pid' | 'uid' | 'comm' | 'startedAt'>): boolean =>
  row.pid === reviewed.pid && row.uid === reviewed.uid && row.comm === reviewed.comm && Math.abs(Date.parse(row.startedAt) - Date.parse(reviewed.startedAt)) <= IDENTITY_START_TOLERANCE_MS

const observeRows = async (run: MonitoringRun, now: () => Date): Promise<{ observedAt: Date; rows: ObservedProcess[] | null; reason?: ProcessObservation['reason'] }> => {
  const result = await command(run, MONITORING_PS_ARGV), observedAt = now()
  if (!result.ok) return { observedAt, rows: null, reason: 'process-list-unavailable' }
  try { return { observedAt, rows: parsePsOutput(result.stdout, observedAt.getTime()) } } catch { return { observedAt, rows: null, reason: 'invalid-process-list' } }
}

export async function readProcesses(run: MonitoringRun, accounts: readonly MonitoringAccount[], self: { pid: number; ppid: number }, now: () => Date = () => new Date()): Promise<ProcessObservation> {
  const observed = await observeRows(run, now), observedAt = observed.observedAt.toISOString()
  if (!observed.rows) return { state: 'unavailable', observedAt, total: 0, truncated: false, items: [], accounts: [], reason: observed.reason! }
  const owners = new Map(accounts.filter(account => account.status !== 'terminating').map(account => [account.uid, account.username]))
  const summaries = new Map<string, ProcessAccountSummary>()
  const items = observed.rows.map(row => {
    const account = owners.get(row.uid) ?? null
    if (account) {
      const summary = summaries.get(account) ?? { username: account, processes: 0, cpuPercent: 0, rssBytes: 0 }
      summary.processes++; summary.cpuPercent = Math.round((summary.cpuPercent + row.cpuPercent) * 10) / 10; summary.rssBytes += row.rssBytes
      summaries.set(account, summary)
    }
    return { ...row, account, protection: processProtection(row, self) }
  })
  return {
    state: 'read', observedAt, total: items.length, truncated: items.length > MAX_PROCESS_ROWS, items: items.slice(0, MAX_PROCESS_ROWS),
    accounts: [...summaries.values()].sort((left, right) => left.username.localeCompare(right.username)),
  }
}

/**
 * Identity-bound signal. `beforeDispatch` re-checks authority and audits right before kill runs.
 * Success means a later read no longer shows the reviewed process; anything else stays attempted/unknown.
 */
export async function signalProcess(run: MonitoringRun, request: MonitoringSignalRequest, options: {
  self: { pid: number; ppid: number }; beforeDispatch: () => Promise<void>; now?: () => Date; sleep?: (ms: number) => Promise<void>; rereads?: number
}): Promise<SignalOutcome> {
  const now = options.now ?? (() => new Date()), sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const before = await observeRows(run, now)
  if (!before.rows) return fail('PRECONDITION_FAILED', 'the process list could not be read before signalling', { stateChanged: false })
  const row = before.rows.find(item => item.pid === request.pid)
  if (!row || !sameProcessIdentity(row, request)) return fail('CONFLICT', 'the reviewed process changed or exited before signalling', { stateChanged: false, reason: 'process-changed' })
  const protection = processProtection(row, options.self)
  if (protection) return fail('FORBIDDEN', 'this process is protected from panel signals', { stateChanged: false, reason: 'protected-process', protection })
  const argv = monitoringKillArgv(row.pid, request.signal)
  await options.beforeDispatch()
  const result = await command(run, argv)
  let state: SignalOutcome['state'] = 'unknown', observedAt = now()
  for (let attempt = 0; attempt < (options.rereads ?? 4); attempt++) {
    if (attempt) await sleep(200)
    const after = await observeRows(run, now)
    observedAt = after.observedAt
    if (!after.rows) { state = 'unknown'; continue }
    if (!after.rows.some(item => sameProcessIdentity(item, request))) { state = 'confirmed'; break }
    state = 'attempted'
  }
  return { state, signal: request.signal, pid: request.pid, commandOk: result.ok, observedAt: observedAt.toISOString(), verificationRequired: state !== 'confirmed' }
}

// POSIX df -P: one header line, then one line per filesystem; the mount point is last and may contain spaces.
const DF_SPACE_ROW = /^(\S{1,1024})\s+(\S{1,64})\s+(\d{1,20})\s+(\d{1,20})\s+(\d{1,20})\s+(?:\d{1,3}%|-)\s+(\/.{0,4095})$/
const DF_INODE_ROW = /^(\S{1,1024})\s+(\d{1,20})\s+(\d{1,20})\s+(\d{1,20})\s+(?:\d{1,3}%|-)\s+(\/.{0,4095})$/
const dfRows = (stdout: string): string[] => {
  const lines = dataLines(stdout, MAX_DF_LINES)
  if (lines.length < 2) throw new Error('invalid_df')
  // The header is locale-dependent; POSIX output always prints exactly one.
  return lines.slice(1)
}
export function parseDfSpace(stdout: string): Omit<FilesystemView, 'inodes'>[] {
  const mounts = new Set<string>()
  return dfRows(stdout).map(line => {
    const match = DF_SPACE_ROW.exec(line)
    if (!match || mounts.has(match[6]!) || /[\u0000-\u001f\u007f]/.test(line)) throw new Error('invalid_df_row')
    mounts.add(match[6]!)
    return { filesystem: match[1]!, type: match[2]!, mount: match[6]!, totalBytes: integer(match[3]!), usedBytes: integer(match[4]!), availableBytes: integer(match[5]!) }
  })
}
export function parseDfInodeTable(stdout: string): Map<string, { total: number; used: number; free: number }> {
  const result = new Map<string, { total: number; used: number; free: number }>()
  for (const line of dfRows(stdout)) {
    const match = DF_INODE_ROW.exec(line)
    if (!match || result.has(match[5]!) || /[\u0000-\u001f\u007f]/.test(line)) throw new Error('invalid_df_inode_row')
    const total = integer(match[2]!), used = integer(match[3]!), free = integer(match[4]!)
    if (used > total) throw new Error('invalid_df_inode_row')
    result.set(match[5]!, { total, used, free })
  }
  return result
}

/** repquota(8) default report: blocks are 1 KiB; a human-unit report is refused rather than guessed. */
export function parseRepquotaUsage(stdout: string): Map<string, { usedBytes: number; hardBytes: number | null }> {
  if (typeof stdout !== 'string' || !/Block limits/i.test(stdout) || /(?:blocks?|limits?)\s*\((?:MB|GB|MiB|GiB)\)|\b(?:Mbytes|Gbytes)\b/i.test(stdout)) throw new Error('invalid_quota_report')
  const result = new Map<string, { usedBytes: number; hardBytes: number | null }>()
  for (const line of dataLines(stdout, 100_000)) {
    const match = /^(\S+)\s+[+-]{2}\s+(\d+)\s+(\d+)\s+(\d+)\b/.exec(line.trim())
    if (!match) continue
    if (result.has(match[1]!)) throw new Error('duplicate_quota_row')
    const hard = integer(match[4]!)
    result.set(match[1]!, { usedBytes: integer(match[2]!) * 1024, hardBytes: hard > 0 ? hard * 1024 : null })
  }
  if (!result.size) throw new Error('invalid_quota_report')
  return result
}

/** Filesystems from df; per-account home usage only from the existing user-quota report (never du over every home). */
export async function readDisk(run: MonitoringRun, readFile: ((path: string) => Promise<string | null>) | undefined, accounts: readonly MonitoringAccount[], now: () => Date = () => new Date()): Promise<DiskObservation> {
  const [space, inodes] = await Promise.all([command(run, MONITORING_DF_SPACE_ARGV), command(run, MONITORING_DF_INODE_ARGV)])
  const observedAt = now().toISOString()
  let filesystems: DiskObservation['filesystems'] = { state: 'unavailable', items: [], inodes: 'unavailable', reason: 'filesystems-unavailable' }
  if (space.ok) {
    try {
      const rows = parseDfSpace(space.stdout)
      let table: Map<string, { total: number; used: number; free: number }> | null = null
      if (inodes.ok) try { table = parseDfInodeTable(inodes.stdout) } catch { /* Inode counts stay unavailable; byte figures are independent. */ }
      filesystems = { state: 'read', inodes: table ? 'read' : 'unavailable', items: rows.map(row => { const counts = table?.get(row.mount); return { ...row, inodes: counts && counts.total > 0 ? counts : null } }) }
    } catch { filesystems = { state: 'unavailable', items: [], inodes: 'unavailable', reason: 'invalid-filesystems' } }
  }
  const active = accounts.filter(account => account.status !== 'terminating').sort((left, right) => left.username.localeCompare(right.username))
  let mount: string | null = null
  try { const mountinfo = readFile ? await readFile('/proc/self/mountinfo') : null; mount = mountinfo ? ioMountForTarget(mountinfo, '/home')?.mountPoint ?? null : null } catch { /* Unknown mount means unknown quota identity. */ }
  if (!mount) return { observedAt, filesystems, accounts: { state: 'unavailable', source: 'repquota', mount: null, items: [], reason: 'quota-mount-unavailable' } }
  const report = await command(run, ['/usr/sbin/repquota', '-u', mount])
  if (!report.ok) return { observedAt, filesystems, accounts: { state: 'unavailable', source: 'repquota', mount, items: [], reason: 'quota-report-unavailable' } }
  try {
    const usage = parseRepquotaUsage(report.stdout)
    return { observedAt, filesystems, accounts: { state: 'read', source: 'repquota', mount, items: active.map(account => { const row = usage.get(account.username); return { username: account.username, usedBytes: row?.usedBytes ?? null, limitBytes: row?.hardBytes ?? null } }) } }
  } catch { return { observedAt, filesystems, accounts: { state: 'unavailable', source: 'repquota', mount, items: [], reason: 'invalid-quota-report' } } }
}

const capUtf8 = (text: string): { message: string; truncated: boolean } => {
  if (Buffer.byteLength(text) <= MAX_LOG_MESSAGE_BYTES) return { message: text, truncated: false }
  let bytes = 0, end = 0
  for (const character of text) { const size = Buffer.byteLength(character); if (bytes + size > MAX_LOG_MESSAGE_BYTES) break; bytes += size; end += character.length }
  return { message: text.slice(0, end), truncated: true }
}
// systemd Journal JSON Format: non-UTF-8 or binary values are byte arrays, repeated fields are arrays, and fields over 4096 bytes are null.
const decodeMessage = (value: unknown): string | null => {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) throw new Error('invalid_journal_message')
  if (value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) return Buffer.from(value as number[]).toString('utf8')
  if (value.every(part => typeof part === 'string')) return value.join('\n')
  throw new Error('invalid_journal_message')
}
export function parseJournalJson(stdout: string): LogEntryView[] {
  return dataLines(stdout, 100_000).map(line => {
    const entry: unknown = JSON.parse(line)
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('invalid_journal_entry')
    const fields = entry as Record<string, unknown>, realtime = fields.__REALTIME_TIMESTAMP
    if (typeof realtime !== 'string' || !/^\d{1,17}$/.test(realtime)) throw new Error('invalid_journal_entry')
    const at = new Date(Number(BigInt(realtime) / 1000n))
    const priority = fields.PRIORITY, unit = fields._SYSTEMD_UNIT, pid = fields._PID
    if (!Number.isFinite(at.getTime()) || priority !== undefined && (typeof priority !== 'string' || !/^[0-7]$/.test(priority))
      || unit !== undefined && (typeof unit !== 'string' || unit.length > 256 || /[\u0000-\u001f\u007f]/.test(unit)) || pid !== undefined && (typeof pid !== 'string' || !/^\d{1,10}$/.test(pid))) throw new Error('invalid_journal_entry')
    const decoded = decodeMessage(fields.MESSAGE), capped = decoded === null ? null : capUtf8(decoded)
    return { at: at.toISOString(), priority: typeof priority === 'string' ? Number(priority) : null, unit: typeof unit === 'string' ? unit : null, pid: typeof pid === 'string' ? Number(pid) : null, message: capped?.message ?? null, messageTruncated: capped?.truncated ?? false }
  })
}

export async function readLogs(run: MonitoringRun, query: MonitoringLogQuery, now: () => Date = () => new Date()): Promise<LogObservation> {
  const result = await command(run, monitoringJournalArgv(query)), observedAt = now().toISOString()
  const base = { unit: query.unit, lines: query.lines, since: query.since, priority: query.priority, observedAt, order: 'newest-first' as const }
  if (!result.ok) return { ...base, state: 'unavailable', truncated: false, items: [], reason: 'journal-unavailable' }
  let entries: LogEntryView[]
  try { entries = parseJournalJson(result.stdout) } catch { return { ...base, state: 'unavailable', truncated: false, items: [], reason: 'invalid-journal' } }
  if (entries.length > query.lines) return { ...base, state: 'unavailable', truncated: false, items: [], reason: 'invalid-journal' }
  const items: LogEntryView[] = []
  let bytes = 0, truncated = false
  for (const entry of entries.reverse()) {
    bytes += Buffer.byteLength(JSON.stringify(entry)) + 1
    if (bytes > MAX_LOG_ITEM_BYTES) { truncated = true; break }
    items.push(entry)
  }
  return { ...base, state: 'read', truncated, items }
}
