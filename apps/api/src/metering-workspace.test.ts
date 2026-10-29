import { describe, expect, it, vi } from 'vitest'
import type { AuthenticatedCaller } from './auth.ts'
import { handleMeteringWorkspaceRoute, projectBandwidthReport, projectIoView } from './metering-workspace.ts'

const host = { cpuPercent: 12, memoryUsedBytes: 4096, memoryTotalBytes: 8192, loadAvg1m: 1, psiSomeAvg10: 0, psiFullAvg10: 0, awaitMs: null }
const row = { accountId: '11111111-1111-4111-8111-111111111111', username: 'alice', uid: 20009, readBytesPerSec: 4096, writeBytesPerSec: 0, readIops: 3, writeIops: 0, cpuPercent: 31.5, memoryCurrentBytes: 1048576, memoryLimitMb: 1024, pidsCurrent: 9, pidsLimit: 'unlimited', statusLevel: 'ok' }
const disk = { state: 'read', observedAt: '2026-10-28T12:00:00.000Z', intervalSeconds: 60, awaitMs: 4.2, devices: [{ name: 'vda', readAwaitMs: 3, writeAwaitMs: null, utilPercent: 10 }] }
const io = () => ({ state: 'partial', reason: null, observedAt: '2026-10-28T12:00:00.000Z', host: { ...host }, disk: structuredClone(disk), accounts: [{ ...row }], unmeasuredAccounts: 1 })
const UNAVAILABLE_DISK = { state: 'unavailable', observedAt: null, intervalSeconds: null, awaitMs: null, devices: [] }
const totals = (count: number, receivedBytes: number, sentBytes: number) => ({ count, receivedBytes, sentBytes })
const bandwidth = () => ({ state: 'partial', month: '2026-10', since: '2026-10-28T11:00:00.000Z', updatedAt: '2026-10-28T12:00:00.000Z',
  sources: { web: { state: 'partial', since: '2026-10-28T11:00:00.000Z' }, mail: { state: 'read', since: '2026-10-01T00:00:00Z' }, ftp: { state: 'unavailable', since: null } },
  pendingBytes: 0, unavailableSites: 0, skippedLines: 0,
  accounts: [
    { username: 'alice', domain: 'alice.test', status: 'active', month: { web: totals(2, 200, 1024), mail: totals(1, 76, 0), ftp: null }, totalBytes: 1300, limitBytes: 1000, usedPercent: 130, limitState: 'over', enforced: true, limited: true },
    { username: 'bob', domain: 'bob.test', status: 'suspended', month: { web: null, mail: null, ftp: null }, totalBytes: null, limitBytes: 1000, usedPercent: null, limitState: 'unmeasured', enforced: false, limited: false },
  ] })
const root = { principal: { kind: 'root', id: 'r', username: 'root' } } as AuthenticatedCaller

describe('metering API boundary', () => {
  it('drops internal account ids and keeps unmeasured host fields null', () => {
    const view = projectIoView({ ...io(), extra: 'not returned' })
    expect(view.accounts[0]).not.toHaveProperty('accountId'); expect(view.host?.awaitMs).toBeNull(); expect(view).not.toHaveProperty('extra')
    expect(projectIoView({ ...io(), extra: 'x' }).disk).toEqual(disk)
    expect(projectIoView({ state: 'unavailable', reason: 'paused', observedAt: null, host: null, disk: UNAVAILABLE_DISK, accounts: [], unmeasuredAccounts: 0 }).reason).toBe('paused')
  })
  it('refuses invented or incoherent IO readings', () => {
    expect(() => projectIoView({ ...io(), state: 'unavailable' })).toThrow()
    expect(() => projectIoView({ ...io(), accounts: [{ ...row, readIops: -1 }] })).toThrow()
    expect(() => projectIoView({ ...io(), accounts: [{ ...row }, { ...row }] })).toThrow()
    expect(() => projectIoView({ ...io(), host: { ...host, cpuPercent: 'high' } })).toThrow()
    expect(() => projectIoView({ ...io(), disk: { ...disk, devices: [{ ...disk.devices[0], name: '../etc' }] } })).toThrow()
    expect(() => projectIoView({ ...io(), disk: { ...disk, state: 'idle' } })).toThrow()
  })
  it('keeps unmeasured bandwidth null, never zero, and refuses measured rows without totals', () => {
    expect(projectBandwidthReport(bandwidth())).toEqual(bandwidth())
    const zero = bandwidth(); zero.accounts[1]!.totalBytes = 0
    expect(() => projectBandwidthReport(zero)).toThrow()
    const ftp = bandwidth() as { accounts: { month: Record<string, unknown> }[] }; ftp.accounts[0]!.month.ftp = totals(1, 1, 1)
    expect(() => projectBandwidthReport(ftp)).toThrow()
    expect(() => projectBandwidthReport({ ...bandwidth(), accounts: [{ ...bandwidth().accounts[0]!, limited: 'yes' }] })).toThrow()
    expect(() => projectBandwidthReport({ ...bandwidth(), state: 'unavailable' })).toThrow()
  })
  it('authorizes before and after the host read and refuses selectors', async () => {
    const helpers = { requireCaller: vi.fn(async () => root), assertRoot: vi.fn(async () => {}), readHost: vi.fn(async (_caller: AuthenticatedCaller, path: string) => path.endsWith('/io') ? io() : bandwidth()) }
    for (const path of ['/api/server/monitoring/io', '/api/server/monitoring/bandwidth']) {
      const url = new URL('http://h' + path)
      expect((await handleMeteringWorkspaceRoute(new Request(url), url, 'GET', helpers))!.status).toBe(200)
    }
    expect(helpers.readHost.mock.calls.map(call => call[1])).toEqual(['/host/monitoring/io', '/host/monitoring/bandwidth'])
    expect(helpers.assertRoot).toHaveBeenCalledTimes(4)
    const polluted = new URL('http://h/api/server/monitoring/io?uid=0')
    await expect(handleMeteringWorkspaceRoute(new Request(polluted), polluted, 'GET', helpers)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(helpers.readHost).toHaveBeenCalledTimes(2)
    const other = new URL('http://h/api/server/monitoring/disk')
    expect(await handleMeteringWorkspaceRoute(new Request(other), other, 'GET', helpers)).toBeNull()
  })
})
