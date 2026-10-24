import { system } from '@xpanel/render'
import type { AgentExecutor } from './executor.ts'

const unescapeMount = (value: string): string =>
  value.replace(/\\([0-7]{3})/g, (_match, oct: string) => String.fromCharCode(Number.parseInt(oct, 8)))

/**
 * Block device for the longest mount that holds `target`, as a systemd IO
 * device (`/dev/block/major:minor`). `0:*` and unreadable lines are skipped.
 */
export const ioDeviceForMount = (mountinfo: string, target: string): string | null => {
  const wanted = target === '/' ? '/' : target.replace(/\/+$/, '')
  let best: { length: number; device: string } | null = null
  for (const line of mountinfo.split('\n')) {
    const fields = line.trim().split(' ')
    if (fields.length < 5) continue
    const majmin = fields[2] ?? ''
    const match = /^(\d+):(\d+)$/.exec(majmin)
    if (!match || match[1] === '0') continue
    const mount = unescapeMount(fields[4] ?? '')
    const point = mount === '/' ? '/' : mount.replace(/\/+$/, '')
    const holds = point === '/' || wanted === point || wanted.startsWith(`${point}/`)
    if (!holds) continue
    if (best && point.length < best.length) continue
    try {
      best = { length: point.length, device: system.toSystemdIoDevice(majmin) }
    } catch { /* A device systemd would reject is left unused. */ }
  }
  return best?.device ?? null
}

/**
 * Device for the account-home filesystem, only when the io controller is
 * already delegated. An empty result leaves `io.max` off rather than handing
 * systemd a device that rolls the generation back.
 */
export const resolveHomeIoDevice = async (executor: AgentExecutor, home: string): Promise<string | null> => {
  const mountinfo = await executor.readFile('/proc/self/mountinfo')
  const nested = await executor.readFile('/sys/fs/cgroup/xpanel.slice/cgroup.subtree_control')
  const subtree = nested ?? await executor.readFile('/sys/fs/cgroup/cgroup.subtree_control')
  if (!subtree?.split(/\s+/).includes('io') || !mountinfo) return null
  return ioDeviceForMount(mountinfo, home)
}

export interface AccountIoTarget {
  id: string
  username: string
  home?: string | null
  status?: string
}

/** Home when it is absolute. Otherwise the quota filesystem plus the username. */
export const accountIoTarget = (account: AccountIoTarget, quotaFilesystem: string): string => {
  const home = account.home?.trim() ?? ''
  if (home.startsWith('/')) return home
  const base = quotaFilesystem.trim().replace(/\/+$/, '') || '/home'
  return `${base}/${account.username}`
}

/**
 * One systemd device per account. A home the mount table does not cover is an
 * empty list, so that account's `io.max` stays unset.
 */
export const ioDevicesByAccount = (
  mountinfo: string,
  accounts: readonly AccountIoTarget[],
  quotaFilesystem: string,
): Map<string, string[]> => {
  const map = new Map<string, string[]>()
  for (const account of accounts) {
    if (account.status === 'terminating') continue
    const device = ioDeviceForMount(mountinfo, accountIoTarget(account, quotaFilesystem))
    map.set(account.id, device ? [device] : [])
  }
  return map
}

/** Mount devices for every account, only when the io controller is delegated. */
export const resolveAccountIoDevices = async (
  executor: AgentExecutor,
  accounts: readonly AccountIoTarget[],
  quotaFilesystem: string,
): Promise<Map<string, string[]> | null> => {
  const mountinfo = await executor.readFile('/proc/self/mountinfo')
  const nested = await executor.readFile('/sys/fs/cgroup/xpanel.slice/cgroup.subtree_control')
  const subtree = nested ?? await executor.readFile('/sys/fs/cgroup/cgroup.subtree_control')
  if (!subtree?.split(/\s+/).includes('io') || !mountinfo) return null
  return ioDevicesByAccount(mountinfo, accounts, quotaFilesystem)
}
