import { system } from '@xpanel/render'
import type { AgentExecutor } from './executor.ts'

const unescapeMount = (value: string): string => value.replace(/\\([0-7]{3})/g,
  (_match, oct: string) => String.fromCharCode(Number.parseInt(oct, 8)))

/** Select the covering mount before validating it: a nested non-block mount must never inherit its parent's device. */
export const ioMountForTarget = (mountinfo: string, target: string): { device: string; mountPoint: string } | null => {
  if (!target.startsWith('/') || target.split('/').some(part => part === '.' || part === '..')) return null
  const wanted = target.replace(/\/+$/, '') || '/'
  let best: { length: number; device: string; filesystem: string; mountPoint: string } | undefined
  for (const line of mountinfo.split('\n')) {
    const parts = line.trim().split(/\s+/)
    const separator = parts.indexOf('-')
    if (separator < 6 || !parts[4]) continue
    const point = unescapeMount(parts[4]).replace(/\/+$/, '') || '/'
    if (!(point === '/' || wanted === point || wanted.startsWith(`${point}/`))) continue
    if (best && point.length < best.length) continue
    best = { length: point.length, device: parts[2] ?? '', filesystem: parts[separator + 1] ?? '', mountPoint: point }
  }
  if (!best || !/^[1-9]\d*:\d+$/.test(best.device) || /^(?:tmpfs|nfs\d*|overlay|fuse.*|cifs|proc|sysfs)$/.test(best.filesystem)) return null
  try { return { device: system.toSystemdIoDevice(best.device), mountPoint: best.mountPoint } } catch { return null }
}

export const ioDeviceForMount = (mountinfo: string, target: string): string | null => ioMountForTarget(mountinfo, target)?.device ?? null

export interface AccountIoTarget { id: string; username: string; home?: string | null; status?: string }

export const accountIoTarget = (account: AccountIoTarget, quotaFilesystem: string): string =>
  account.home?.startsWith('/') ? account.home : `${quotaFilesystem.replace(/\/+$/, '') || '/home'}/${account.username}`

export const ioDevicesByAccount = (mountinfo: string, accounts: readonly AccountIoTarget[], quotaFilesystem: string): Map<string, string[]> =>
  new Map(accounts.filter(account => account.status !== 'terminating').map(account => {
    const device = ioDeviceForMount(mountinfo, accountIoTarget(account, quotaFilesystem))
    return [account.id, device ? [device] : []]
  }))

export const resolveAccountIoDevices = async (executor: AgentExecutor, accounts: readonly AccountIoTarget[], quotaFilesystem: string): Promise<Map<string, string[]> | null> => {
  try {
    const mountinfo = await executor.readFile('/proc/self/mountinfo')
    const nested = await executor.readFile('/sys/fs/cgroup/xpanel.slice/cgroup.subtree_control')
    const subtree = nested ?? await executor.readFile('/sys/fs/cgroup/cgroup.subtree_control')
    if (!mountinfo || !subtree?.split(/\s+/).includes('io')) return null
    return ioDevicesByAccount(mountinfo, accounts, quotaFilesystem)
  } catch { return null }
}
