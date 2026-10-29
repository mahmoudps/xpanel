import type { Account, Plan, ResourceLimits } from '@xpanel/core'
import type { CanonicalIoAnalyticsRead } from './analytics.ts'
import type { AccountSliceMetrics, AgentExecutor } from './executor.ts'
import { parseRepquotaUsage } from './host-monitoring.ts'
import { accountIoTarget, ioMountForTarget, resolveAccountIoDevices } from './io-device.ts'
import { compareAccountLimits } from './limit-gaps.ts'
import type { ObservedAccountLimits } from './limit-gaps.ts'

export const MAX_LIMITS_BATCH = 50
/** Usage at or above this share of the plan limit is flagged as high. */
export const LIMIT_HIGH_PERCENT = 90
export const LIMIT_RESOURCES = ['cpu', 'memory', 'processes', 'io-read-bps', 'io-write-bps', 'io-read-iops', 'io-write-iops', 'disk'] as const
export type LimitResource = typeof LIMIT_RESOURCES[number]
export type LimitEnforcement = 'match' | 'drift' | 'unavailable'
export type LimitUsageState = 'ok' | 'high' | 'unlimited' | 'unavailable'
export interface LimitRow {
  id: LimitResource
  /** Plan value in base units: CPU percent of one core, bytes, processes, bytes/s or operations/s. Null when the plan is missing. */
  limit: number | 'unlimited' | null
  /** Raw kernel cgroup value (or quota hard limit in bytes for disk). Null when it was not read. */
  enforced: string | null
  enforcement: LimitEnforcement
  usage: number | null
  percent: number | null
  usageState: LimitUsageState
}
export interface AccountLimits {
  username: string; status: Account['status']; plan: string | null
  slice: 'read' | 'not-active' | 'unavailable'; quota: 'read' | 'unavailable'
  high: number; drift: number; unavailable: number; rows: LimitRow[]
}
export interface ServerLimitsReport {
  observedAt: string; host: 'read' | 'unavailable'; highPercent: number
  /** The daemon-owned resource sample supplies CPU and IO rates; memory, processes and disk are read directly. */
  sample: { state: 'read' | 'unavailable'; observedAt: string | null; reason: string | null }
  accounts: AccountLimits[]
}
export type ServerLimitsExecutor = AgentExecutor

const FIELD: Readonly<Record<LimitResource, keyof ResourceLimits>> = {
  cpu: 'cpuPercent', memory: 'memoryMb', processes: 'maxProcesses', 'io-read-bps': 'ioReadBps', 'io-write-bps': 'ioWriteBps', 'io-read-iops': 'ioReadIops', 'io-write-iops': 'ioWriteIops', disk: 'diskMb',
}
const IO_KEY: Readonly<Partial<Record<LimitResource, string>>> = { 'io-read-bps': 'rbps', 'io-write-bps': 'wbps', 'io-read-iops': 'riops', 'io-write-iops': 'wiops' }
const MIB = 1024 * 1024
const UNLIMITED: ResourceLimits = { diskMb: 'unlimited', bandwidthMbMonth: 'unlimited', ioReadBps: 'unlimited', ioWriteBps: 'unlimited', ioReadIops: 'unlimited', ioWriteIops: 'unlimited', memoryMb: 'unlimited', maxProcesses: 'unlimited', cpuPercent: 'unlimited' }

/** cgroup v2 io.max lines ("MAJ:MIN rbps=N wbps=max ...") reduced to one key. */
const ioLines = (ioMax: string, key: string): string => ioMax.split('\n').map(line => line.trim().split(/\s+/)).filter(parts => parts[0])
  .map(parts => parts[0] + ' ' + (parts.slice(1).find(token => token.startsWith(key + '=')) ?? key + '=max')).join('\n')

/** An unlimited plan matches only when the kernel enforces no cap (cgroup v2 "max", no IO cap, no quota). */
function unlimitedEnforcement(id: LimitResource, raw: string | null): LimitEnforcement {
  if (raw === null) return 'unavailable'
  const value = raw.trim()
  if (id === 'disk') return value === '0' ? 'match' : 'drift'
  if (id === 'cpu') return value.split(/\s+/)[0] === 'max' ? 'match' : 'drift'
  if (IO_KEY[id]) return value.split('\n').every(line => line === '' || /=max$/.test(line)) ? 'match' : 'drift'
  return value === 'max' ? 'match' : 'drift'
}

const usageState = (usage: number | null, limit: number | 'unlimited' | null): { percent: number | null; usageState: LimitUsageState } => {
  if (usage === null || limit === null) return { percent: null, usageState: 'unavailable' }
  if (limit === 'unlimited') return { percent: null, usageState: 'unlimited' }
  const percent = limit > 0 ? Math.round(usage / limit * 1000) / 10 : usage > 0 ? 100 : 0
  return { percent, usageState: percent >= LIMIT_HIGH_PERCENT ? 'high' : 'ok' }
}

type QuotaRow = { usedBytes: number; hardKb: number } | null
function quotaReader(executor: ServerLimitsExecutor): (account: Account) => Promise<QuotaRow> {
  let mountinfo: Promise<string | null> | undefined
  const reports = new Map<string, Promise<ReturnType<typeof parseRepquotaUsage> | null>>()
  return async account => {
    mountinfo ??= executor.readFile('/proc/self/mountinfo').catch(() => null)
    const text = await mountinfo
    const mount = text ? ioMountForTarget(text, accountIoTarget(account, '/home'))?.mountPoint ?? null : null
    if (!mount) return null
    if (!reports.has(mount)) reports.set(mount, executor.runCommand(['/usr/sbin/repquota', '-u', mount]).then(result => result.ok ? parseRepquotaUsage(result.stdout) : null).catch(() => null))
    const row = (await reports.get(mount))?.get(account.username)
    // repquota(8) prints 0 for no hard limit; parseRepquotaUsage reports that as null.
    return row ? { usedBytes: row.usedBytes, hardKb: row.hardBytes === null ? 0 : row.hardBytes / 1024 } : null
  }
}

/** Read-only plan limits versus kernel-enforced caps and observed usage for the given saved accounts. */
export async function readServerLimits(input: {
  accounts: readonly Account[]; plans: readonly Plan[]; executor: ServerLimitsExecutor | null
  readResources: (() => Promise<CanonicalIoAnalyticsRead>) | null; now?: () => Date
}): Promise<ServerLimitsReport> {
  const observedAt = (input.now ?? (() => new Date()))().toISOString()
  let resources: CanonicalIoAnalyticsRead | null = null
  if (input.readResources) try { resources = await input.readResources() } catch { resources = null }
  const sample: ServerLimitsReport['sample'] = resources?.available ? { state: 'read', observedAt: resources.snapshot.at, reason: null }
    : { state: 'unavailable', observedAt: resources?.observedAt ?? null, reason: resources ? resources.reason : 'not-sampled' }
  const executor = input.executor
  const devices = executor ? await resolveAccountIoDevices(executor, input.accounts, '/home') : null
  const quota = executor ? quotaReader(executor) : null
  const accounts: AccountLimits[] = []
  for (const account of input.accounts) {
    const plan = input.plans.find(entry => entry.id === account.planId) ?? null
    let slice: AccountSliceMetrics | null | undefined
    if (executor) try { slice = await executor.readSliceMetrics(account.uid) } catch { slice = undefined }
    let disk: QuotaRow = null
    if (quota) try { disk = await quota(account) } catch { disk = null }
    const rank = resources?.available ? resources.snapshot.accounts.find(entry => entry.username === account.username) ?? null : null
    const observed: ObservedAccountLimits = { memoryMax: slice?.memoryMax ?? null, pidsMax: slice?.pidsMax ?? null, cpuMax: slice?.cpuMax ?? null, ioMax: slice?.ioMax ?? null, diskQuotaHardKb: disk?.hardKb ?? null, ioDevices: devices?.get(account.id) ?? null }
    const usage: Record<LimitResource, number | null> = {
      cpu: rank?.cpuPercent ?? null, memory: slice?.memoryCurrentBytes ?? null, processes: slice?.pidsCurrent ?? null,
      'io-read-bps': rank?.readBytesPerSec ?? null, 'io-write-bps': rank?.writeBytesPerSec ?? null, 'io-read-iops': rank?.readIops ?? null, 'io-write-iops': rank?.writeIops ?? null, disk: disk?.usedBytes ?? null,
    }
    const raw = (id: LimitResource): string | null => id === 'disk' ? disk ? String(disk.hardKb * 1024) : null
      : !slice ? null : IO_KEY[id] ? ioLines(slice.ioMax ?? '', IO_KEY[id]!) : (id === 'cpu' ? slice.cpuMax : id === 'memory' ? slice.memoryMax : slice.pidsMax)?.trim() ?? null
    const rows = LIMIT_RESOURCES.map((id): LimitRow => {
      const value = plan ? plan.resources[FIELD[id]] : null
      const limit = value === null || value === 'unlimited' ? value : id === 'memory' || id === 'disk' ? value * MIB : value
      const enforced = raw(id)
      let enforcement: LimitEnforcement = 'unavailable'
      if (value === 'unlimited') enforcement = unlimitedEnforcement(id, enforced)
      else if (value !== null) {
        const comparison = compareAccountLimits({ ...UNLIMITED, [FIELD[id]]: value }, observed)
        enforcement = comparison.gaps.length ? 'drift' : comparison.unavailable ? 'unavailable' : 'match'
      }
      return { id, limit, enforced, enforcement, usage: usage[id], ...usageState(usage[id], limit) }
    })
    accounts.push({
      username: account.username, status: account.status, plan: plan?.name ?? null,
      slice: slice === undefined || !executor ? 'unavailable' : slice === null ? 'not-active' : 'read', quota: disk ? 'read' : 'unavailable',
      high: rows.filter(row => row.usageState === 'high').length, drift: rows.filter(row => row.enforcement === 'drift').length,
      unavailable: rows.filter(row => row.enforcement === 'unavailable' || row.usageState === 'unavailable').length, rows,
    })
  }
  return { observedAt, host: executor ? 'read' : 'unavailable', highPercent: LIMIT_HIGH_PERCENT, sample, accounts }
}
