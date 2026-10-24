import type { Account, AccountLimitGap, HostLimitObservation, Plan, ResourceLimits } from '@xpanel/core'
import type { AgentExecutor } from './executor.ts'
import { accountIoTarget, ioMountForTarget, resolveAccountIoDevices } from './io-device.ts'

export const LIMIT_GAP_KEYS: readonly AccountLimitGap[] = ['memory', 'pids', 'io', 'cpu', 'disk']
export interface ObservedAccountLimits {
  memoryMax: string | null
  pidsMax: string | null
  cpuMax: string | null
  ioMax: string | null
  /** repquota's default block unit is 1024 bytes; retain the hard-cap quantity. */
  diskQuotaHardKb: number | null
  ioDevices: readonly string[] | null
}

const number = (text: string): number | null => /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null
const matches = (text: string | null, expected: number): boolean => text !== null && number(text.trim()) === expected
const deviceId = (device: string): string => device.replace(/^\/dev\/block\//, '')

/** Preserve quantities, and reject a human-readable or unknown-unit quota report. */
export const parseRepquota = (stdout: string): Map<string, number> | null => {
  if (!/Block limits/i.test(stdout) || /(?:blocks?|limits?)\s*\((?:MB|GB|MiB|GiB)\)|\b(?:Mbytes|Gbytes)\b/i.test(stdout)) return null
  const result = new Map<string, number>()
  for (const line of stdout.split('\n')) {
    const match = /^(\S+)\s+[+-]{2}\s+(\d+)\s+(\d+)\s+(\d+)\b/.exec(line.trim())
    if (!match?.[1] || !match[4]) continue
    const hard = number(match[4])
    if (hard === null || result.has(match[1])) return null
    result.set(match[1], hard)
  }
  return result.size ? result : null
}

export const compareAccountLimits = (resources: ResourceLimits, observed: ObservedAccountLimits | null): { gaps: AccountLimitGap[]; unavailable: boolean } => {
  if (!observed) return { gaps: [], unavailable: true }
  const gaps = new Set<AccountLimitGap>()
  let unavailable = false
  const cap = (key: AccountLimitGap, expected: number | 'unlimited', raw: string | null, scale = 1): void => {
    if (expected === 'unlimited') return
    if (raw === null) unavailable = true
    else if (!matches(raw, expected * scale)) gaps.add(key)
  }
  cap('memory', resources.memoryMb, observed.memoryMax, 1024 * 1024)
  cap('pids', resources.maxProcesses, observed.pidsMax)
  if (resources.cpuPercent !== 'unlimited') {
    if (observed.cpuMax === null) unavailable = true
    else {
      const parts = observed.cpuMax.trim().split(/\s+/)
      const quota = number(parts[0] ?? ''), period = number(parts[1] ?? '')
      if (parts.length !== 2 || quota === null || period === null || period <= 0 || quota * 100 !== resources.cpuPercent * period) gaps.add('cpu')
    }
  }
  const ioCaps = [['rbps', resources.ioReadBps], ['wbps', resources.ioWriteBps], ['riops', resources.ioReadIops], ['wiops', resources.ioWriteIops]] as const
  if (ioCaps.some(([, value]) => value !== 'unlimited')) {
    if (observed.ioMax === null || !observed.ioDevices?.length) unavailable = true
    else {
      const rows = new Map<string, Map<string, string>>()
      let valid = true
      for (const line of observed.ioMax.trim().split('\n').filter(Boolean)) {
        const [device, ...values] = line.trim().split(/\s+/)
        if (!device || !/^\d+:\d+$/.test(device) || rows.has(device)) { valid = false; continue }
        const row = new Map<string, string>()
        for (const value of values) {
          const pair = /^(rbps|wbps|riops|wiops)=(\d+|max)$/.exec(value)
          if (!pair?.[1] || !pair[2] || row.has(pair[1])) { valid = false; continue }
          row.set(pair[1], pair[2])
        }
        rows.set(device, row)
      }
      if (!valid || observed.ioDevices.some(device => ioCaps.some(([key, expected]) => expected !== 'unlimited' && !matches(rows.get(deviceId(device))?.get(key) ?? '', expected)))) gaps.add('io')
    }
  }
  if (resources.diskMb !== 'unlimited') {
    if (observed.diskQuotaHardKb === null) unavailable = true
    else if (observed.diskQuotaHardKb !== resources.diskMb * 1024) gaps.add('disk')
  }
  return { gaps: LIMIT_GAP_KEYS.filter(key => gaps.has(key)), unavailable }
}

export const unavailableHostLimits = (): HostLimitObservation => ({ status: 'unavailable', checkedAccounts: 0, unavailableAccounts: 0, gaps: [] })

/** Read-only evidence. Controller delegation alone never establishes an assigned plan cap. */
export const observeHostLimits = async (executor: AgentExecutor, accounts: readonly Account[], plans: readonly Plan[], quotaFilesystem: string | null): Promise<HostLimitObservation> => {
  const active = accounts.filter(account => account.status !== 'terminating')
  if (!active.length) return unavailableHostLimits()
  const devices = await resolveAccountIoDevices(executor, active, quotaFilesystem ?? '/home')
  let mountinfo: string | null = null
  try { mountinfo = await executor.readFile('/proc/self/mountinfo') } catch { /* Unknown mount means unknown quota identity. */ }
  const quotaReports = new Map<string, Map<string, number> | null>()
  const allGaps = new Set<AccountLimitGap>()
  let checkedAccounts = 0, unavailableAccounts = 0
  for (const account of active) {
    const plan = plans.find(plan => plan.id === account.planId)
    if (!plan) { unavailableAccounts++; continue }
    const mount = mountinfo ? ioMountForTarget(mountinfo, accountIoTarget(account, quotaFilesystem ?? '/home')) : null
    if (mount && !quotaReports.has(mount.mountPoint)) {
      let quotas: Map<string, number> | null = null
      try {
        const report = await executor.runCommand(['/usr/sbin/repquota', '-u', mount.mountPoint])
        if (report.ok) quotas = parseRepquota(report.stdout)
      } catch { /* An unread report is unavailable, never successful quota evidence. */ }
      quotaReports.set(mount.mountPoint, quotas)
    }
    let observed: ObservedAccountLimits | null = null
    try {
      const slice = await executor.readSliceMetrics(account.uid)
      if (slice) observed = { memoryMax: slice.memoryMax ?? null, pidsMax: slice.pidsMax ?? null, cpuMax: slice.cpuMax ?? null, ioMax: slice.ioMax ?? null, diskQuotaHardKb: mount ? quotaReports.get(mount.mountPoint)?.get(account.username) ?? null : null, ioDevices: devices?.get(account.id) ?? null }
    } catch { /* Each account's unread evidence stays unavailable. */ }
    const comparison = compareAccountLimits(plan.resources, observed)
    comparison.gaps.forEach(gap => allGaps.add(gap))
    if (comparison.unavailable) unavailableAccounts++
    else checkedAccounts++
  }
  const gaps = LIMIT_GAP_KEYS.filter(key => allGaps.has(key))
  return { status: unavailableAccounts ? 'unavailable' : gaps.length ? 'gaps' : 'verified', checkedAccounts, unavailableAccounts, gaps }
}
