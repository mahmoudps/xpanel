import { describe, expect, it, vi } from 'vitest'
import type { Account, Domain, Plan } from '@xpanel/core'
import { readAccountIsolation } from './security-tools-isolation.ts'
import type { IsolationExecutor } from './security-tools-isolation.ts'

const account = { id: 'a1', username: 'alice', uid: 1001, gid: 1001, home: '/home/alice', status: 'active', shell: 'jailed', planId: 'p1' } as Account
const plan = { id: 'p1', shell: 'jailed', resources: { diskMb: 1000, bandwidthMbMonth: 'unlimited', ioReadBps: 'unlimited', ioWriteBps: 'unlimited', ioReadIops: 'unlimited', ioWriteIops: 'unlimited', memoryMb: 512, maxProcesses: 100, cpuPercent: 50 } } as Plan
const domains = [{ accountId: 'a1', siteType: 'php', php: { handler: 'fpm', version: '8.3' } }, { accountId: 'a1', siteType: 'php', php: { handler: 'fpm', version: '8.3' } }, { accountId: 'b2', siteType: 'php', php: { handler: 'fpm', version: '8.2' } }] as Domain[]
const metrics = { uid: 1001, cpuUsageUsec: 0, memoryCurrentBytes: 0, ioReadBytes: 0, ioWriteBytes: 0, pidsCurrent: 3, memoryMax: '536870912\n', pidsMax: '100\n', cpuMax: '50000 100000\n', ioMax: '' }
const host = (overrides: Record<string, { ok: boolean; code: number; stdout: string; stderr: string }> = {}, sliceMetrics: unknown = metrics) => {
  const outputs: Record<string, { ok: boolean; code: number; stdout: string; stderr: string }> = {
    '/usr/bin/getent -- passwd alice': { ok: true, code: 0, stdout: 'alice:x:1001:1001::/home/alice:/opt/xpanel/bin/jailshell\n', stderr: '' },
    '/usr/bin/systemctl show xpanel-1001.slice --property=LoadState,ActiveState': { ok: true, code: 0, stdout: 'LoadState=loaded\nActiveState=active\n', stderr: '' },
    '/usr/bin/systemctl show xpanel-php-fpm-alice-8.3.service --property=LoadState,ActiveState,User,Group,Slice': { ok: true, code: 0, stdout: 'Slice=xpanel-1001.slice\nUser=alice\nGroup=alice\nLoadState=loaded\nActiveState=active\n', stderr: '' },
    ...overrides,
  }
  const runCommand = vi.fn(async (argv: string[]) => outputs[argv.join(' ')] ?? { ok: false, code: 1, stdout: '', stderr: 'unexpected' })
  const executor = { runCommand, readSliceMetrics: vi.fn(async () => sliceMetrics) } as unknown as IsolationExecutor
  return { executor, runCommand }
}
const home = async () => ({ type: 'directory' as const, uid: 1001, gid: 1001, mode: 0o750 })
const states = (report: Awaited<ReturnType<typeof readAccountIsolation>>) => Object.fromEntries(report.checks.map(item => [item.id, item.state]))

describe('account isolation observation', () => {
  it('confirms every rendered control and runs only the reviewed read-only commands', async () => {
    const { executor, runCommand } = host()
    const report = await readAccountIsolation({ account, plan, domains, executor, inspectHome: home, now: () => new Date('2026-10-27T10:00:00Z') })
    expect(report).toMatchObject({ username: 'alice', uid: 1001, state: 'ok', counts: { ok: 9, drift: 0, unavailable: 0 }, observedAt: '2026-10-27T10:00:00.000Z' })
    expect(states(report)).toEqual({ passwd: 'ok', shell: 'ok', home: 'ok', slice: 'ok', memory: 'ok', processes: 'ok', cpu: 'ok', io: 'ok', 'fpm-8.3': 'ok' })
    expect(report.checks.find(item => item.id === 'home')).toEqual({ id: 'home', state: 'ok', expected: 'directory 1001:1001 0750', observed: 'directory 1001:1001 0750' })
    expect(runCommand.mock.calls.map(call => call[0][0])).toEqual(['/usr/bin/getent', '/usr/bin/systemctl', '/usr/bin/systemctl'])
  })
  it('reports drift for a changed shell, open home, missing slice unit, wrong limits and a shared FPM identity', async () => {
    const { executor } = host({
      '/usr/bin/getent -- passwd alice': { ok: true, code: 0, stdout: 'alice:x:1001:1001::/home/alice:/bin/bash\n', stderr: '' },
      '/usr/bin/systemctl show xpanel-1001.slice --property=LoadState,ActiveState': { ok: true, code: 0, stdout: 'LoadState=not-found\nActiveState=inactive\n', stderr: '' },
      '/usr/bin/systemctl show xpanel-php-fpm-alice-8.3.service --property=LoadState,ActiveState,User,Group,Slice': { ok: true, code: 0, stdout: 'LoadState=loaded\nUser=www-data\nGroup=www-data\nSlice=system.slice\n', stderr: '' },
    }, { ...metrics, memoryMax: 'max\n', pidsMax: '200\n', cpuMax: 'max 100000\n' })
    const report = await readAccountIsolation({ account, plan, domains, executor, inspectHome: async () => ({ type: 'directory', uid: 1001, gid: 1001, mode: 0o755 }) })
    expect(report.state).toBe('drift')
    expect(states(report)).toMatchObject({ passwd: 'ok', shell: 'drift', home: 'drift', slice: 'drift', memory: 'drift', processes: 'drift', cpu: 'drift', 'fpm-8.3': 'drift' })
    expect(report.checks.find(item => item.id === 'fpm-8.3')!.observed).toBe('User=www-data Group=www-data Slice=system.slice')
    expect(report.checks.find(item => item.id === 'slice')!.observed).toBe('not-found inactive')
  })
  it('treats a missing user and a symlinked home as drift, and unread evidence as unavailable', async () => {
    const { executor } = host({ '/usr/bin/getent -- passwd alice': { ok: false, code: 2, stdout: '', stderr: '' } }, null)
    const report = await readAccountIsolation({ account, plan, domains: [], executor, inspectHome: async () => ({ type: 'symlink', uid: 0, gid: 0, mode: 0o777 }) })
    expect(states(report)).toEqual({ passwd: 'drift', shell: 'unavailable', home: 'drift', slice: 'ok', memory: 'unavailable', processes: 'unavailable', cpu: 'unavailable', io: 'unavailable' })
    expect(report.checks.find(item => item.id === 'memory')!.observed).toBe('not active')
    const failing = { runCommand: async () => { throw new Error('spawn') }, readSliceMetrics: async () => { throw new Error('io') } } as unknown as IsolationExecutor
    const unread = await readAccountIsolation({ account, plan: null, domains, executor: failing, inspectHome: async () => { throw new Error('EACCES') } })
    expect(unread.state).toBe('unavailable')
    expect(states(unread)).toEqual({ passwd: 'unavailable', shell: 'unavailable', home: 'unavailable', slice: 'unavailable', plan: 'unavailable', 'fpm-8.3': 'unavailable' })
  })
  it('compares unlimited plans with cgroup max and finite IO with resolved devices', async () => {
    const unlimited = { ...plan, resources: { ...plan.resources, memoryMb: 'unlimited', maxProcesses: 'unlimited', cpuPercent: 'unlimited', ioReadBps: 1048576 } } as Plan
    const { executor } = host({}, { ...metrics, memoryMax: 'max', pidsMax: 'max', cpuMax: 'max 100000', ioMax: '8:0 rbps=1048576 wbps=max riops=max wiops=max\n' })
    expect(states(await readAccountIsolation({ account, plan: unlimited, domains: [], executor, inspectHome: home, ioDevices: ['8:0'] }))).toMatchObject({ memory: 'ok', processes: 'ok', cpu: 'ok', io: 'ok' })
    expect(states(await readAccountIsolation({ account, plan: unlimited, domains: [], executor, inspectHome: home, ioDevices: null }))).toMatchObject({ io: 'unavailable' })
    const { executor: capped } = host({}, { ...metrics, memoryMax: '536870912', ioMax: '8:0 rbps=1048576 wbps=max riops=max wiops=max\n' })
    expect(states(await readAccountIsolation({ account, plan: { ...plan, resources: { ...plan.resources, memoryMb: 'unlimited' } } as Plan, domains: [], executor: capped, inspectHome: home }))).toMatchObject({ memory: 'drift', io: 'drift' })
  })
})
