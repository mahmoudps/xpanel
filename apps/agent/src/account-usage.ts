import type { AgentExecutor } from './executor.ts'
import type { ResourceLimits } from '@xpanel/core'
import { compareAccountLimits } from './limit-gaps.ts'
import { ioDeviceForMount } from './io-device.ts'

const USERNAME = /^[a-z][a-z0-9]{0,15}$/
const PHP_VERSIONS = ['8.5', '8.4', '8.3', '8.2', '8.1', '8.0', '7.4'] as const

export interface AccountUsageSample {
  phpVersion: string | null
  diskBytes: number | null
  memoryBytes: number | null
  processCount: number | null
  /** Access logs are not parsed. The panel says so instead of showing a dash. */
  bandwidth: 'unmeasured'
  /** True only for matching assigned IO caps on the home device; null for missing evidence. */
  ioEnforced: boolean | null
  /** This UTC month's metered traffic (web, mail, FTP) from the bandwidth meter; absent when the meter has no report. */
  bandwidthMonth?: AccountBandwidthMonth
}
export interface AccountBandwidthMonth { month: string; totalBytes: number | null; limitBytes: number | null; usedPercent: number | null; enforced: boolean; limited: boolean }


const activeUnit = async (executor: AgentExecutor, unit: string): Promise<boolean> => {
  try {
    const result = await executor.runCommand(['/usr/bin/systemctl', 'is-active', unit])
    return result.ok && result.stdout.trim() === 'active'
  } catch {
    return false
  }
}

/**
 * Disk from du, memory and processes from the account slice, PHP from the
 * active xpanel-php-fpm unit. A failed read stays null. Bandwidth is unmeasured.
 */
export const readAccountUsage = async (
  executor: AgentExecutor,
  input: { username: string; uid: number; home: string; resources?: ResourceLimits },
): Promise<AccountUsageSample> => {
  const sample: AccountUsageSample = {
    phpVersion: null,
    diskBytes: null,
    memoryBytes: null,
    processCount: null,
    bandwidth: 'unmeasured',
    ioEnforced: null,
  }
  if (!USERNAME.test(input.username) || input.home !== `/home/${input.username}`) return sample
  for (const version of PHP_VERSIONS) {
    const unit = `xpanel-php-fpm-${input.username}-${version}.service`
    if (await activeUnit(executor, unit)) {
      sample.phpVersion = version
      break
    }
  }
  try {
    const du = await executor.runCommand(['/usr/bin/du', '-s', '-B1', input.home])
    const bytes = Number(du.stdout.trim().split(/\s+/)[0])
    if (du.ok && Number.isSafeInteger(bytes) && bytes >= 0) sample.diskBytes = bytes
  } catch { /* A failed du stays null. */ }
  try {
    const slice = await executor.readSliceMetrics(input.uid)
    if (slice) {
      sample.memoryBytes = slice.memoryCurrentBytes
      sample.processCount = slice.pidsCurrent
      if (input.resources && input.resources.ioWriteBps !== 'unlimited') {
        const mountinfo = await executor.readFile('/proc/self/mountinfo')
        const device = mountinfo ? ioDeviceForMount(mountinfo, input.home) : null
        const comparison = compareAccountLimits({ ...input.resources, memoryMb: 'unlimited', maxProcesses: 'unlimited', cpuPercent: 'unlimited', diskMb: 'unlimited' }, {
          memoryMax: null, pidsMax: null, cpuMax: null, diskQuotaHardKb: null,
          ioMax: slice.ioMax ?? null, ioDevices: device ? [device] : null,
        })
        sample.ioEnforced = comparison.unavailable ? null : !comparison.gaps.includes('io')
      }
    }
  } catch { /* A missing slice stays null. */ }
  return sample
}
