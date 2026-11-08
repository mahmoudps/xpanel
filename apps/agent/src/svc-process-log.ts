import { MONITORING_PS_ARGV } from '../../../packages/os/src/monitoring-command.ts'
import { parsePsOutput } from './host-monitoring.ts'
import type { MonitoringAccount, MonitoringRun, ObservedProcess } from './host-monitoring.ts'

/** Rebuildable sampler output; it never holds desired state. */
export const PROCESS_LOG_PATH = '/var/lib/xpanel/svc/daily-process-log.json'
export const PROCESS_LOG_SAMPLE_MS = 5 * 60_000
const KEPT_DAYS = 2
const USERS_PER_DAY = 2000
const TOP_PER_DAY = 200

interface UserDay { samples: number; cpu: number; memory: number; dbProcesses: number; domain: string | null }
interface TopProcess { user: string; comm: string; peakCpu: number }
export interface ProcessLogDay { day: string; samples: number; users: Record<string, UserDay>; top: TopProcess[] }
export interface ProcessLogFile { days: ProcessLogDay[] }
export interface ProcessLogReport { day: string; samples: number; sampleMinutes: number; users: { user: string; domain: string | null; cpuPercent: number; memoryPercent: number; dbProcesses: number }[]; top: { user: string; domain: string | null; comm: string; peakCpuPercent: number }[] }

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const count = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const validUser = (value: unknown): value is UserDay => object(value) && count(value.samples) && count(value.cpu) && count(value.memory) && count(value.dbProcesses) && (value.domain === null || typeof value.domain === 'string')
/** A damaged file is sampler output, so it restarts empty instead of stopping the report. */
export function parseProcessLog(raw: unknown): ProcessLogFile {
  if (!object(raw) || !Array.isArray(raw.days)) return { days: [] }
  const days = raw.days.filter((day): day is ProcessLogDay => object(day) && typeof day.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day.day) && count(day.samples) && object(day.users) && Object.values(day.users).every(validUser) && Array.isArray(day.top)
    && day.top.every(row => object(row) && typeof row.user === 'string' && typeof row.comm === 'string' && count(row.peakCpu)))
  return { days: days.slice(-KEPT_DAYS) }
}

export interface ProcessSample { rows: readonly ObservedProcess[]; accounts: readonly (MonitoringAccount & { primaryDomain?: string | null })[]; dbProcesses: ReadonlyMap<string, number>; at: Date }

/** One sample: every user with a process or a database connection counts for this sample; a user's absence adds zero to its average. */
export function addProcessSample(file: ProcessLogFile, sample: ProcessSample): ProcessLogFile {
  const dayName = sample.at.toISOString().slice(0, 10)
  const day = file.days.find(item => item.day === dayName) ?? { day: dayName, samples: 0, users: {}, top: [] }
  const domains = new Map(sample.accounts.map(account => [account.username, account.primaryDomain ?? null]))
  day.samples++
  const totals = new Map<string, { cpu: number; memory: number }>()
  for (const row of sample.rows) {
    const total = totals.get(row.user) ?? { cpu: 0, memory: 0 }
    total.cpu += row.cpuPercent; total.memory += row.memoryPercent
    totals.set(row.user, total)
    const top = day.top.find(item => item.user === row.user && item.comm === row.comm)
    if (top) top.peakCpu = Math.max(top.peakCpu, row.cpuPercent)
    else day.top.push({ user: row.user, comm: row.comm, peakCpu: row.cpuPercent })
  }
  for (const [user, dbProcesses] of sample.dbProcesses) if (!totals.has(user) && dbProcesses > 0) totals.set(user, { cpu: 0, memory: 0 })
  for (const [user, total] of totals) {
    const entry = day.users[user] ?? (Object.keys(day.users).length < USERS_PER_DAY ? { samples: 0, cpu: 0, memory: 0, dbProcesses: 0, domain: domains.get(user) ?? null } : null)
    if (!entry) continue
    entry.samples++; entry.cpu += total.cpu; entry.memory += total.memory; entry.dbProcesses += sample.dbProcesses.get(user) ?? 0
    day.users[user] = entry
  }
  day.top = day.top.sort((left, right) => right.peakCpu - left.peakCpu).slice(0, TOP_PER_DAY)
  return { days: [...file.days.filter(item => item.day !== dayName), day].sort((left, right) => left.day.localeCompare(right.day)).slice(-KEPT_DAYS) }
}

const round = (value: number): number => Math.round(value * 100) / 100
/** Averages over the day's samples, as cPanel's report. */
export function processLogReport(file: ProcessLogFile, dayName: string): ProcessLogReport | null {
  const day = file.days.find(item => item.day === dayName)
  if (!day) return null
  const users = Object.entries(day.users).map(([user, entry]) => ({ user, domain: entry.domain, cpuPercent: round(entry.cpu / day.samples), memoryPercent: round(entry.memory / day.samples), dbProcesses: round(entry.dbProcesses / day.samples) }))
    .sort((left, right) => right.cpuPercent - left.cpuPercent || left.user.localeCompare(right.user))
  return { day: day.day, samples: day.samples, sampleMinutes: PROCESS_LOG_SAMPLE_MS / 60_000, users, top: day.top.map(row => ({ user: row.user, domain: day.users[row.user]?.domain ?? null, comm: row.comm, peakCpuPercent: round(row.peakCpu) })) }
}

export interface ProcessLogSampler { tick: () => Promise<void> }
export function createProcessLogSampler(deps: {
  run: MonitoringRun; accounts: () => Promise<ProcessSample['accounts']>; dbProcesses: () => Promise<ReadonlyMap<string, number>>
  read: () => Promise<unknown>; write: (file: ProcessLogFile) => Promise<void>; now?: () => Date
}): ProcessLogSampler {
  const now = deps.now ?? (() => new Date())
  let last = 0, running = false
  return {
    tick: async () => {
      const at = now()
      if (running || at.getTime() - last < PROCESS_LOG_SAMPLE_MS) return
      running = true
      try {
        const listing = await deps.run([...MONITORING_PS_ARGV])
        if (!listing.ok) return
        const rows = parsePsOutput(listing.stdout, at.getTime())
        last = at.getTime()
        // A database that cannot be read leaves that column at zero for this sample; processes are still counted.
        const dbProcesses = await deps.dbProcesses().catch(() => new Map<string, number>())
        await deps.write(addProcessSample(parseProcessLog(await deps.read().catch(() => null)), { rows, accounts: await deps.accounts(), dbProcesses, at }))
      } catch { /* The next tick samples again; a report never depends on one sample. */ } finally { running = false }
    },
  }
}

/** information_schema.PROCESSLIST grouped by the part of each database user before its first underscore, the account prefix. */
export const parseDbProcessCounts = (rows: readonly { user: string; count: number }[], usernames: ReadonlySet<string>): Map<string, number> => {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const owner = row.user.split('_')[0]!
    if (usernames.has(owner)) counts.set(owner, (counts.get(owner) ?? 0) + row.count)
  }
  return counts
}
