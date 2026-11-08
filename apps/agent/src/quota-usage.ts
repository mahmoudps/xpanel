import type { AgentExecutor } from './executor.ts'
import { ioMountForTarget } from './io-device.ts'

/** Used disk per Linux user from one `repquota -u` of the home filesystem (the user quota report the account pages read). */
export interface QuotaUsageRead {
  state: 'read' | 'unavailable'
  reason: 'quota_unavailable' | 'report_unreadable' | null
  observedAt: string
  users: { username: string; usedBytes: number }[]
}

const USER = /^[a-z_][a-z0-9_-]{0,31}$/

/** repquota's default block unit is 1024 bytes; a report in other units is refused rather than misread. */
export const parseRepquotaUsage = (stdout: string): { username: string; usedBytes: number }[] | null => {
  if (!/Block limits/i.test(stdout) || /(?:blocks?|limits?)\s*\((?:MB|GB|MiB|GiB)\)|\b(?:Mbytes|Gbytes)\b/i.test(stdout)) return null
  const users = new Map<string, number>()
  for (const line of stdout.split('\n')) {
    const match = /^(\S+)\s+[+-]{2}\s+(\d+)\s/.exec(line.trim())
    if (!match || !USER.test(match[1]!)) continue
    const used = Number(match[2])
    if (!Number.isSafeInteger(used) || users.has(match[1]!)) return null
    users.set(match[1]!, used * 1024)
  }
  return [...users].map(([username, usedBytes]) => ({ username, usedBytes }))
}

export async function readQuotaUsage(executor: AgentExecutor, home = '/home', now = new Date()): Promise<QuotaUsageRead> {
  const observedAt = now.toISOString(), off = (reason: QuotaUsageRead['reason']): QuotaUsageRead => ({ state: 'unavailable', reason, observedAt, users: [] })
  let mountinfo: string | null = null
  try { mountinfo = await executor.readFile('/proc/self/mountinfo') } catch { return off('quota_unavailable') }
  const mount = mountinfo ? ioMountForTarget(mountinfo, home) : null
  if (!mount) return off('quota_unavailable')
  try {
    const report = await executor.runCommand(['/usr/sbin/repquota', '-u', mount.mountPoint])
    const users = report.ok ? parseRepquotaUsage(report.stdout) : null
    return users ? { state: 'read', reason: null, observedAt, users } : off(report.ok ? 'report_unreadable' : 'quota_unavailable')
  } catch { return off('quota_unavailable') }
}
