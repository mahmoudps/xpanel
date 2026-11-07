import { MONITORING_PS_ARGV, monitoringKillArgv } from '../../../packages/os/src/monitoring-command.ts'
import { parsePsOutput, processProtection, sameProcessIdentity } from './host-monitoring.ts'
import type { MonitoringAccount, MonitoringRun, ObservedProcess } from './host-monitoring.ts'
import type { SvcProcessKillerPolicy } from './svc-policy.ts'

export const PROCESS_KILLER_REPORT_PATH = '/var/lib/xpanel/svc/process-killer.json'
const REPORTS_KEPT = 30
export interface KilledProcess { pid: number; user: string; comm: string; outcome: 'confirmed' | 'attempted' }
export interface ProcessKillerRun { at: string; trigger: 'nightly' | 'manual'; state: 'completed' | 'unavailable'; killed: KilledProcess[]; trustedSkipped: number; mailed: boolean }
export interface ProcessKillerReports { runs: ProcessKillerRun[] }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export const parseKillerReports = (raw: unknown): ProcessKillerReports => object(raw) && Array.isArray(raw.runs) ? { runs: raw.runs.filter((run): run is ProcessKillerRun => object(run) && typeof run.at === 'string' && Array.isArray(run.killed) && typeof run.mailed === 'boolean').slice(-REPORTS_KEPT) } : { runs: [] }

/** Only processes of hosting accounts are candidates, so system users are always exempt, and panel signal protections still hold. */
export function forbiddenProcesses(rows: readonly ObservedProcess[], policy: Pick<SvcProcessKillerPolicy, 'names' | 'trustedUsers'>, accounts: readonly MonitoringAccount[], self: { pid: number; ppid: number }): { targets: ObservedProcess[]; trustedSkipped: number } {
  const owners = new Map(accounts.filter(account => account.status !== 'terminating').map(account => [account.uid, account.username]))
  const names = new Set(policy.names), trusted = new Set(policy.trustedUsers)
  const matched = rows.filter(row => names.has(row.comm) && owners.has(row.uid) && processProtection(row, self) === null)
  const targets = matched.filter(row => !trusted.has(owners.get(row.uid)!))
  return { targets, trustedSkipped: matched.length - targets.length }
}

/** One run: read the list, kill each match by identity, read again to confirm. A kill never reports success unverified. */
export async function runProcessKiller(input: {
  run: MonitoringRun; policy: SvcProcessKillerPolicy; accounts: readonly MonitoringAccount[]; self: { pid: number; ppid: number }; trigger: ProcessKillerRun['trigger']; now?: () => Date
}): Promise<ProcessKillerRun> {
  const now = input.now ?? (() => new Date()), at = now().toISOString()
  const read = async (): Promise<ObservedProcess[] | null> => {
    try { const listing = await input.run([...MONITORING_PS_ARGV]); return listing.ok ? parsePsOutput(listing.stdout, now().getTime()) : null } catch { return null }
  }
  const before = await read()
  if (!before) return { at, trigger: input.trigger, state: 'unavailable', killed: [], trustedSkipped: 0, mailed: false }
  const { targets, trustedSkipped } = forbiddenProcesses(before, input.policy, input.accounts, input.self)
  for (const row of targets) await input.run(monitoringKillArgv(row.pid, 'KILL')).catch(() => null)
  const after = targets.length ? await read() : before
  const killed = targets.map((row): KilledProcess => ({ pid: row.pid, user: row.user, comm: row.comm,
    outcome: after && !after.some(item => sameProcessIdentity(item, { pid: row.pid, uid: row.uid, comm: row.comm, startedAt: row.startedAt })) ? 'confirmed' : 'attempted' }))
  return { at, trigger: input.trigger, state: 'completed', killed, trustedSkipped, mailed: false }
}

export const appendKillerRun = (reports: ProcessKillerReports, run: ProcessKillerRun): ProcessKillerReports => ({ runs: [...reports.runs, run].slice(-REPORTS_KEPT) })
