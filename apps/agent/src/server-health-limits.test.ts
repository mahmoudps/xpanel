import { describe, expect, it } from 'vitest'
import { defaultPlan, type Account } from '@xpanel/core'
import type { CanonicalIoAnalyticsRead } from './analytics.ts'
import { FakeHostExecutor, type AccountSliceMetrics } from './executor.ts'
import { LIMIT_HIGH_PERCENT, readServerLimits } from './server-health-limits.ts'
import type { AccountLimits, LimitResource } from './server-health-limits.ts'

const MIB = 1024 * 1024
const base = defaultPlan({ id: 'plan', name: 'Standard', featureListId: 'features' })
const plan = { ...base, resources: { ...base.resources, memoryMb: 1024, maxProcesses: 64, cpuPercent: 150, diskMb: 2048, ioReadBps: 1000, ioWriteBps: 2000, ioReadIops: 30, ioWriteIops: 40 } }
const alice = { id: 'a1', username: 'alice', uid: 20001, home: '/home/alice', planId: 'plan', status: 'active' } as Account
const slice = (overrides: Partial<AccountSliceMetrics> = {}): AccountSliceMetrics => ({
  uid: 20001, cpuUsageUsec: 0, memoryCurrentBytes: 1000 * MIB, ioReadBytes: 0, ioWriteBytes: 0, pidsCurrent: 10,
  memoryMax: '1073741824\n', pidsMax: '32\n', cpuMax: '150000 100000\n', ioMax: '8:2 rbps=1000 wbps=2000 riops=30 wiops=40\n', ...overrides,
})
const quota = (used: number, hard: number) => `*** Report for user quotas on device /dev/sda2\nBlock grace time: 7days\nBlock limits\nUser used soft hard grace\nalice -- ${used} 0 ${hard} 0 0 0\n`
class Host extends FakeHostExecutor {
  metrics: AccountSliceMetrics | null | Error = slice()
  report = quota(102400, 2097152)
  commands: string[][] = []
  override async readFile(path: string): Promise<string | null> {
    return ({ '/proc/self/mountinfo': '1 0 8:2 / /home rw - ext4 /dev/sda2 rw\n', '/sys/fs/cgroup/cgroup.subtree_control': 'cpu memory io pids\n' } as Record<string, string>)[path] ?? null
  }
  override async runCommand(argv: string[]) { this.commands.push(argv); return { ok: true, code: 0, stdout: this.report, stderr: '' } }
  override async readSliceMetrics(): Promise<AccountSliceMetrics | null> { if (this.metrics instanceof Error) throw this.metrics; return this.metrics }
}
const sample = (cpuPercent = 140): CanonicalIoAnalyticsRead => ({ available: true, snapshot: { at: '2026-10-27T09:59:55.000Z', current: {} as never, history: [], accounts: [
  { accountId: 'a1', username: 'alice', uid: 20001, readBytesPerSec: 100, writeBytesPerSec: 1900, readIops: 3, writeIops: 4, memoryCurrentBytes: 0, memoryLimitMb: 1024, pidsCurrent: 0, pidsLimit: 64, cpuPercent, statusLevel: 'ok' },
] } })
const now = () => new Date('2026-10-27T10:00:00.000Z')
const rows = (account: AccountLimits) => Object.fromEntries(account.rows.map(row => [row.id, row])) as Record<LimitResource, AccountLimits['rows'][number]>

describe('server resource limits', () => {
  it('compares plan limits with kernel caps and flags usage at or above 90 percent', async () => {
    const host = new Host()
    const report = await readServerLimits({ accounts: [alice], plans: [plan], executor: host, readResources: async () => sample(), now })
    expect(report).toMatchObject({ observedAt: '2026-10-27T10:00:00.000Z', host: 'read', highPercent: LIMIT_HIGH_PERCENT, sample: { state: 'read', observedAt: '2026-10-27T09:59:55.000Z', reason: null } })
    const account = report.accounts[0]!, row = rows(account)
    expect(account).toMatchObject({ username: 'alice', plan: 'Standard', slice: 'read', quota: 'read', high: 3, drift: 1, unavailable: 0 })
    expect(row.cpu).toMatchObject({ limit: 150, enforced: '150000 100000', enforcement: 'match', usage: 140, percent: 93.3, usageState: 'high' })
    expect(row.memory).toMatchObject({ limit: 1024 * MIB, enforcement: 'match', usage: 1000 * MIB, percent: 97.7, usageState: 'high' })
    expect(row.processes).toMatchObject({ limit: 64, enforced: '32', enforcement: 'drift', usage: 10, percent: 15.6, usageState: 'ok' })
    expect(row['io-write-bps']).toMatchObject({ limit: 2000, enforced: '8:2 wbps=2000', enforcement: 'match', usage: 1900, percent: 95, usageState: 'high' })
    expect(row['io-read-iops']).toMatchObject({ enforced: '8:2 riops=30', enforcement: 'match', percent: 10 })
    expect(row.disk).toMatchObject({ limit: 2048 * MIB, enforced: String(2097152 * 1024), enforcement: 'match', usage: 102400 * 1024, percent: 4.9, usageState: 'ok' })
    expect(host.commands).toEqual([['/usr/sbin/repquota', '-u', '/home']])
  })

  it('treats unlimited plans as matching only uncapped kernel values', async () => {
    const unlimited = { ...plan, resources: { ...plan.resources, memoryMb: 'unlimited' as const, cpuPercent: 'unlimited' as const, ioWriteBps: 'unlimited' as const, diskMb: 'unlimited' as const } }
    const host = new Host()
    host.metrics = slice({ memoryMax: 'max\n', cpuMax: 'max 100000\n', ioMax: '8:2 rbps=1000 wbps=max riops=30 wiops=40\n' })
    host.report = quota(10, 0)
    let row = rows((await readServerLimits({ accounts: [alice], plans: [unlimited], executor: host, readResources: async () => sample(), now })).accounts[0]!)
    for (const id of ['memory', 'cpu', 'io-write-bps', 'disk'] as const) expect(row[id]).toMatchObject({ limit: 'unlimited', enforcement: 'match', usageState: 'unlimited', percent: null })
    host.metrics = slice({ memoryMax: '1073741824\n', cpuMax: '50000 100000\n' })
    host.report = quota(10, 1024)
    row = rows((await readServerLimits({ accounts: [alice], plans: [unlimited], executor: host, readResources: null, now })).accounts[0]!)
    for (const id of ['memory', 'cpu', 'io-write-bps', 'disk'] as const) expect(row[id].enforcement).toBe('drift')
  })

  it('keeps every unread observation unavailable instead of healthy', async () => {
    const host = new Host()
    host.metrics = null
    host.report = 'repquota: Cannot stat() mounted device'
    let account = (await readServerLimits({ accounts: [alice], plans: [plan], executor: host, readResources: async () => { throw new Error('down') }, now })).accounts[0]!
    expect(account).toMatchObject({ slice: 'not-active', quota: 'unavailable', high: 0, drift: 0, unavailable: 8 })
    for (const row of account.rows) expect(row).toMatchObject({ enforced: null, enforcement: 'unavailable', usage: null, usageState: 'unavailable' })
    host.metrics = new Error('cgroup read failed')
    account = (await readServerLimits({ accounts: [alice], plans: [plan], executor: host, readResources: null, now })).accounts[0]!
    expect(account.slice).toBe('unavailable')
    const offline = await readServerLimits({ accounts: [alice], plans: [plan], executor: null, readResources: async () => ({ available: false, snapshot: null, reason: 'stale', fieldReasons: {}, observedAt: '2026-10-27T09:00:00.000Z' }), now })
    expect(offline).toMatchObject({ host: 'unavailable', sample: { state: 'unavailable', reason: 'stale', observedAt: '2026-10-27T09:00:00.000Z' } })
    expect(offline.accounts[0]).toMatchObject({ slice: 'unavailable', quota: 'unavailable', unavailable: 8 })
    const orphan = (await readServerLimits({ accounts: [{ ...alice, planId: 'gone' }], plans: [plan], executor: new Host(), readResources: async () => sample(), now })).accounts[0]!
    expect(orphan.plan).toBeNull()
    for (const row of orphan.rows) expect(row).toMatchObject({ limit: null, enforcement: 'unavailable', usageState: 'unavailable', percent: null })
  })

  it('reads the quota report once per mount for a batch', async () => {
    const host = new Host()
    const bob = { ...alice, id: 'b1', username: 'bob', uid: 20002, home: '/home/bob' } as Account
    const report = await readServerLimits({ accounts: [alice, bob], plans: [plan], executor: host, readResources: async () => sample(), now })
    expect(report.accounts.map(account => [account.username, account.quota])).toEqual([['alice', 'read'], ['bob', 'unavailable']])
    expect(host.commands).toHaveLength(1)
  })
})
