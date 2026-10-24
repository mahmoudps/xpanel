import type { ResourceLimits } from '@xpanel/core'
import { ioWriteEnforced } from './account-usage.ts'

export const LIMIT_GAP_KEYS = ['memory', 'pids', 'io', 'cpu', 'disk'] as const
export type LimitGap = (typeof LIMIT_GAP_KEYS)[number]

export interface ObservedAccountLimits {
  memoryMax: string | null
  pidsMax: string | null
  cpuMax: string | null
  ioMax: string | null
  /** True when a hard quota is set. False when the read succeeded and none is set. Null when unread. */
  diskQuota: boolean | null
}

const finite = (value: number | 'unlimited'): boolean => value !== 'unlimited'

const numericCap = (text: string | null): boolean => {
  if (!text) return false
  const value = text.trim()
  return value.length > 0 && value !== 'max' && /^\d+$/.test(value)
}

/** `cpu.max` is `quota period`. `max` is not a plan cap. */
export const cpuQuotaEnforced = (text: string | null): boolean => {
  if (!text) return false
  const quota = text.trim().split(/\s+/)[0] ?? ''
  return quota.length > 0 && quota !== 'max' && quota !== '0' && /^\d+$/.test(quota)
}

/**
 * Plan limits that this account is not actually applying. An unread slice
 * counts every finite plan limit as open. An unlimited plan field is not a gap.
 */
export const gapsForAccount = (
  resources: ResourceLimits,
  observed: ObservedAccountLimits | null,
): LimitGap[] => {
  const gaps: LimitGap[] = []
  const memory = !observed || !numericCap(observed.memoryMax)
  const pids = !observed || !numericCap(observed.pidsMax)
  const io = !observed || !ioWriteEnforced(observed.ioMax)
  const cpu = !observed || !cpuQuotaEnforced(observed.cpuMax)
  const disk = !observed || observed.diskQuota !== true
  if (finite(resources.memoryMb) && memory) gaps.push('memory')
  if (finite(resources.maxProcesses) && pids) gaps.push('pids')
  if (finite(resources.ioWriteBps) && io) gaps.push('io')
  if (finite(resources.cpuPercent) && cpu) gaps.push('cpu')
  if (finite(resources.diskMb) && disk) gaps.push('disk')
  return gaps
}

export const unionLimitGaps = (rows: readonly (readonly LimitGap[])[]): LimitGap[] => {
  const present = new Set(rows.flat())
  return LIMIT_GAP_KEYS.filter(key => present.has(key))
}

/**
 * Usernames with a non-zero hard block quota in `repquota -u` output.
 * Null when the text is not a quota report.
 */
export const parseRepquota = (stdout: string): Set<string> | null => {
  if (!/\s--\s/.test(stdout) && !/Block/i.test(stdout)) return null
  const users = new Set<string>()
  let parsed = false
  for (const line of stdout.split('\n')) {
    const match = /^(\S+)\s+[+-]{2}\s+\d+\s+\d+\s+(\d+)/.exec(line.trim())
    if (!match?.[1] || !match[2]) continue
    parsed = true
    if (Number(match[2]) > 0) users.add(match[1])
  }
  return parsed ? users : null
}
