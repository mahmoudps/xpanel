import { afterEach, describe, expect, it, vi } from 'vitest'
import { fail, isXpanelError } from '@xpanel/core'
import { createTestDb, listMetricsHistory, recordMetricsSample } from '@xpanel/db'
import type { MetricsSample, TestDbHandle } from '@xpanel/db'
import type { AuthenticatedCaller } from './auth.ts'
import { downsampleHostMetrics, handleMonitoringWorkspaceRoute, projectDisk, projectLogs, projectProcesses } from './monitoring-workspace.ts'
import type { MonitoringWorkspaceHelpers } from './monitoring-workspace.ts'

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0)
const caller = (kind = 'root', sessionId = 's1', id = 'p-root') => ({ principal: { id, kind, username: kind }, sessionId, apiTokenId: null }) as unknown as AuthenticatedCaller
const processRow = { pid: 4242, ppid: 1, uid: 20001, user: 'alice', cpuPercent: 1.5, memoryPercent: 1, rssBytes: 20971520, elapsedSeconds: 120, startedAt: '2026-10-27T11:58:00.000Z', stat: 'S', comm: 'php-fpm8.3', account: 'alice', protection: null }
const processes = { state: 'read', observedAt: '2026-10-27T12:00:00.000Z', total: 1, truncated: false, items: [processRow], accounts: [{ username: 'alice', processes: 1, cpuPercent: 1.5, rssBytes: 20971520 }] }
const disk = { observedAt: '2026-10-27T12:00:00.000Z', filesystems: { state: 'read', inodes: 'read', items: [{ filesystem: '/dev/vda1', type: 'ext4', mount: '/', totalBytes: 100, usedBytes: 40, availableBytes: 60, inodes: { total: 10, used: 2, free: 8 } }] }, accounts: { state: 'read', source: 'repquota', mount: '/', items: [{ username: 'alice', usedBytes: 2048, limitBytes: null }] } }
const logs = { state: 'read', unit: 'nginx.service', lines: 100, since: null, priority: null, observedAt: '2026-10-27T12:00:00.000Z', order: 'newest-first', truncated: false, items: [{ at: '2026-10-27T11:59:00.000Z', priority: 6, unit: 'nginx.service', pid: 1301, message: 'ready', messageTruncated: false }] }
const signalBody = { pid: 4242, uid: 20001, comm: 'php-fpm8.3', startedAt: '2026-10-27T11:58:00.000Z', signal: 'TERM' }
const outcome = { state: 'confirmed', signal: 'TERM', pid: 4242, commandOk: true, observedAt: '2026-10-27T12:00:01.000Z', verificationRequired: false }

const helpers = (overrides: Partial<MonitoringWorkspaceHelpers> = {}) => {
  const readHost = vi.fn(async (_caller: AuthenticatedCaller, path: string, _body?: unknown): Promise<unknown> => path.startsWith('/host/monitoring/logs') ? logs : path.endsWith('/signal') ? outcome : path.endsWith('/disk') ? disk : processes)
  const emitAudit = vi.fn(async (_entry: { action: string; outcome: string }) => ({}))
  const assertRoot = vi.fn(async (current: AuthenticatedCaller) => { if (current.principal.kind !== 'root') fail('FORBIDDEN', 'root role is required for this operation') })
  const value: MonitoringWorkspaceHelpers = { requireCaller: async () => caller(), assertRoot, emitAudit, readHost, listHostMetrics: async () => [], now: () => new Date(NOW), ...overrides }
  return { value, readHost, emitAudit, assertRoot }
}
const call = (path: string, value: MonitoringWorkspaceHelpers, init: RequestInit = {}) => {
  const url = new URL('https://panel.test' + path)
  return handleMonitoringWorkspaceRoute(new Request(url, init), url, init.method ?? 'GET', value)
}
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const refusal = async (promise: Promise<unknown>) => { try { await promise; return 'resolved' } catch (error) { return isXpanelError(error) ? [error.code, error.detail.stateChanged] : String(error) } }

describe('monitoring workspace API', () => {
  it('requires root, exact methods and no selectors on fixed reads', async () => {
    const denied = helpers({ requireCaller: async () => caller('reseller') })
    for (const path of ['/api/server/monitoring/processes', '/api/server/monitoring/disk', '/api/server/monitoring/logs?unit=nginx.service', '/api/server/monitoring/performance']) expect(await refusal(call(path, denied.value))).toEqual(['FORBIDDEN', false])
    expect(denied.readHost).not.toHaveBeenCalled()
    const { value, readHost } = helpers()
    expect(await call('/api/server/php/inventory', value)).toBeNull()
    expect((await call('/api/server/monitoring/processes', value, { method: 'POST' }))!.status).toBe(405)
    expect((await call('/api/server/monitoring/processes/signal', value))!.headers.get('allow')).toBe('POST')
    for (const path of ['/api/server/monitoring/processes?sort=cpu', '/api/server/monitoring/disk?path=/', '/api/server/monitoring/logs?unit=cron.service', '/api/server/monitoring/logs?unit=nginx.service&since=-1h',
      '/api/server/monitoring/performance?window=30d', '/api/server/monitoring/performance?window=1h&window=7d', '/api/server/monitoring/performance?scope=account'])
      expect(await refusal(call(path, value))).toEqual(['VALIDATION', false])
    expect(readHost).not.toHaveBeenCalled()
  })
  it('forwards canonical reads and projects only reviewed fields', async () => {
    const readHost = vi.fn(async (_caller: AuthenticatedCaller, path: string) => path.startsWith('/host/monitoring/logs') ? { ...logs, unit: 'ssh.service', lines: 50, priority: 3, secret: 'x' } : { ...processes, items: [{ ...processRow, args: 'mysql -pSECRET' }] })
    const { value } = helpers({ readHost })
    const read = await (await call('/api/server/monitoring/processes', value))!.json()
    expect(read.items[0]).toEqual(processRow)
    expect(JSON.stringify(read)).not.toContain('SECRET')
    const log = await (await call('/api/server/monitoring/logs?priority=3&unit=ssh.service&lines=50', value))!.json()
    expect(readHost.mock.calls.at(-1)![1]).toBe('/host/monitoring/logs?unit=ssh.service&lines=50&priority=3')
    expect(log).not.toHaveProperty('secret')
    expect(await (await call('/api/server/monitoring/disk', helpers().value))!.json()).toEqual(disk)
  })
  it('refuses malformed or mismatched host observations', () => {
    for (const bad of [{ ...processes, items: [{ ...processRow, comm: 'a\u001bb' }] }, { ...processes, total: 0 }, { ...processes, truncated: true }, { ...processes, items: [{ ...processRow, protection: 'none' }] }, { ...processes, state: 'unavailable' }, { ...processes, items: [processRow, processRow], total: 2 }])
      expect(() => projectProcesses(bad)).toThrow()
    expect(() => projectDisk({ ...disk, filesystems: { ...disk.filesystems, items: [{ ...disk.filesystems.items[0], mount: 'relative' }] } })).toThrow()
    expect(() => projectDisk({ ...disk, accounts: { ...disk.accounts, items: [{ username: 'alice', usedBytes: -1, limitBytes: null }] } })).toThrow()
    const query = { unit: 'nginx.service', lines: 100, since: null, priority: null }
    expect(() => projectLogs({ ...logs, unit: 'ssh.service' }, query)).toThrow()
    expect(() => projectLogs({ ...logs, items: [{ ...logs.items[0], message: 'x'.repeat(4097) }] }, query)).toThrow()
    expect(() => projectLogs(logs, { ...query, lines: 0 })).toThrow()
    expect(projectLogs({ ...logs, state: 'unavailable', items: [], reason: 'journal-unavailable' }, query).reason).toBe('journal-unavailable')
  })
  it('passes agent 403, 409 and 422 refusals through unchanged', async () => {
    for (const code of ['FORBIDDEN', 'CONFLICT', 'VALIDATION'] as const) {
      const { value } = helpers({ readHost: async () => fail(code, 'the protected host request was refused', { stateChanged: false }) })
      expect(await refusal(call('/api/server/monitoring/processes', value))).toEqual([code, false])
      expect(await refusal(call('/api/server/monitoring/processes/signal', value, post(signalBody)))).toEqual([code, false])
    }
  })
  it('signals with a fresh root re-check, canonical body and audited outcome', async () => {
    const { value, readHost, emitAudit, assertRoot } = helpers()
    expect(await (await call('/api/server/monitoring/processes/signal', value, post(signalBody)))!.json()).toEqual(outcome)
    expect(readHost.mock.calls[0]!.slice(1)).toEqual(['/host/monitoring/processes/signal', signalBody])
    expect(assertRoot).toHaveBeenCalledTimes(2)
    expect(emitAudit.mock.calls.map(([entry]) => [entry.action, entry.outcome])).toEqual([['server.process.signal_requested', 'ok'], ['server.process.signal', 'ok']])
    const kill = vi.fn(async () => ({ ...outcome, signal: 'KILL' }))
    expect(await (await call('/api/server/monitoring/processes/signal', helpers({ readHost: kill }).value, post({ ...signalBody, signal: 'KILL', killConfirmed: true })))!.json()).toMatchObject({ signal: 'KILL', state: 'confirmed' })
    expect((kill.mock.calls[0] as unknown[])[2]).toEqual({ ...signalBody, signal: 'KILL', killConfirmed: true })
  })
  it('refuses changed authority, unconfirmed KILL, failed pre-audit and unverifiable acknowledgements', async () => {
    let calls = 0
    for (const overrides of [
      { requireCaller: async () => calls++ % 2 ? caller('root', 's2') : caller() },
      { requireCaller: async () => calls++ % 2 ? caller('reseller') : caller() },
      { emitAudit: vi.fn(async () => { throw new Error('db') }) },
    ]) {
      const { value, readHost } = helpers(overrides)
      expect(await refusal(call('/api/server/monitoring/processes/signal', value, post(signalBody)))).toEqual([overrides.emitAudit ? 'PRECONDITION_FAILED' : 'FORBIDDEN', false])
      expect(readHost).not.toHaveBeenCalled()
    }
    const { value, readHost } = helpers()
    for (const init of [post({ ...signalBody, signal: 'KILL' }), post({ ...signalBody, pid: 1 }), post({ ...signalBody, path: '/x' }), { method: 'POST', body: JSON.stringify(signalBody) }])
      expect(await refusal(call('/api/server/monitoring/processes/signal', value, init))).toEqual(['VALIDATION', false])
    expect(readHost).not.toHaveBeenCalled()
    for (const ack of [{ ...outcome, pid: 4243 }, { ...outcome, signal: 'KILL' }, { ...outcome, state: 'attempted' }, { ...outcome, state: 'gone' }]) {
      const current = helpers({ readHost: async () => ack })
      expect(await refusal(call('/api/server/monitoring/processes/signal', current.value, post(signalBody)))).toEqual(['PRECONDITION_FAILED', true])
    }
    const attempted = helpers({ readHost: async () => ({ ...outcome, state: 'attempted', verificationRequired: true }) })
    expect(await (await call('/api/server/monitoring/processes/signal', attempted.value, post(signalBody)))!.json()).toMatchObject({ state: 'attempted', verificationRequired: true })
    expect(attempted.emitAudit.mock.calls.at(-1)![0].outcome).toBe('failed')
  })
})

describe('host performance history', () => {
  let handle: TestDbHandle | undefined
  afterEach(async () => { await handle?.close(); handle = undefined })
  const sample = (at: number, cpuPercent: number, overrides: Partial<MetricsSample> = {}): MetricsSample => ({ id: at, at: new Date(at).toISOString(), scope: 'host', accountId: null, cpuPercent, memoryMb: 512, diskMb: 4096, bandwidthBytes: 0, ioReadBps: 0, ioWriteBps: 0, processes: 90, load1: 0.5, ...overrides })

  it('downsamples into fixed buckets with gaps, averages and maxima', () => {
    const history = downsampleHostMetrics([sample(NOW - 30_000, 10), sample(NOW - 50_000, 30), sample(NOW - 3_599_000, 5), sample(NOW - 7_200_000, 99)], '1h', NOW, false)
    expect([history.points.length, history.bucketSeconds, history.samples, history.from]).toEqual([60, 60, 3, '2026-10-27T11:00:00.000Z'])
    expect(history.points[59]!.values.cpuPercent).toEqual({ avg: 20, max: 30 })
    expect(history.points[0]!.samples).toBe(1)
    expect(history.points[30]).toEqual({ at: '2026-10-27T11:30:00.000Z', samples: 0, values: { cpuPercent: null, memoryMb: null, load1: null, processes: null, diskMb: null } })
    expect(downsampleHostMetrics([], '24h', NOW, false).points).toHaveLength(96)
    expect(downsampleHostMetrics([], '7d', NOW, false).bucketSeconds).toBe(3600)
    expect(() => downsampleHostMetrics([sample(NOW, 1, { scope: 'account' })], '1h', NOW, false)).toThrow()
    expect(() => downsampleHostMetrics([sample(NOW, Number.NaN)], '1h', NOW, false)).toThrow()
  })
  it('reads only host-scope history through the real repository and pages with its cursor', async () => {
    handle = await createTestDb()
    const db = handle.db
    for (const [offset, cpuPercent] of [[60_000, 10], [120_000, 20], [5_000_000, 70]] as const) await recordMetricsSample(db, { scope: 'host', at: new Date(NOW - offset).toISOString(), cpuPercent, memoryMb: 600, load1: 1, processes: 80, diskMb: 2048 })
    const list = vi.fn((options: { since: string; limit: number }) => listMetricsHistory(db, { scope: 'host', ...options }))
    const { value } = helpers({ listHostMetrics: list })
    const history = await (await call('/api/server/monitoring/performance', value))!.json()
    expect([history.state, history.window, history.samples, history.truncated, history.scope]).toEqual(['read', '1h', 2, false, 'host'])
    expect(history.points.filter((point: { samples: number }) => point.samples).map((point: { values: { cpuPercent: { avg: number } } }) => point.values.cpuPercent.avg)).toEqual([20, 10])
    expect(list).toHaveBeenCalledWith({ since: '2026-10-27T11:00:00.000Z', limit: 2000 })
    const week = await (await call('/api/server/monitoring/performance?window=7d', value))!.json()
    expect([week.samples, week.points.length]).toEqual([3, 168])
  })
  it('reports truncation and unavailable history truthfully', async () => {
    const pages = vi.fn(async (options: { cursor?: { at: string; id: number } }) => Array.from({ length: 2000 }, (_, index) => sample(NOW - 1000 - index - (options.cursor ? NOW - Date.parse(options.cursor.at) : 0), 1)))
    const { value } = helpers({ listHostMetrics: pages })
    const history = await (await call('/api/server/monitoring/performance?window=7d', value))!.json()
    expect([history.truncated, pages.mock.calls.length]).toEqual([true, 11])
    const broken = await (await call('/api/server/monitoring/performance', helpers({ listHostMetrics: async () => { throw new Error('sqlite') } }).value))!.json()
    expect([broken.state, broken.reason, broken.points]).toEqual(['unavailable', 'history-unavailable', []])
  })
})
