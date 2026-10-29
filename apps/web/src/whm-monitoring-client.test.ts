// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmMonitoringDisk, renderWhmMonitoringLogs, renderWhmMonitoringPerformance, renderWhmMonitoringProcesses } from './board-port/whm-monitoring-workspace.ts'
import { WHM_MONITORING_CLIENT_BINDING, readDiskView, readLogsView, readPerformanceView, readProcessesView, readSignalOutcome } from './whm-monitoring-client.ts'

const tick = async () => { for (let index = 0; index < 4; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const process = (pid: number, overrides: Record<string, unknown> = {}) => ({ pid, ppid: 1, uid: 20001, user: 'alice', cpuPercent: pid / 1000, memoryPercent: 1, rssBytes: 1048576 * pid, elapsedSeconds: 90061, startedAt: '2026-10-26T10:58:59.000Z', stat: 'S', comm: 'php-fpm8.3', account: 'alice', protection: null, ...overrides })
const processes = (items = [process(4242), process(1301, { uid: 0, user: 'root', account: null, comm: 'nginx', protection: 'root' }), process(5000, { uid: 33, user: 'www-data', account: null, comm: 'Web Content' })]) => ({ state: 'read', observedAt: '2026-10-27T12:00:00.000Z', total: items.length, truncated: false, items, accounts: [{ username: 'alice', processes: 1, cpuPercent: 4.24, rssBytes: 4447010816 }] })
const disk = () => ({ observedAt: '2026-10-27T12:00:00.000Z', filesystems: { state: 'read', inodes: 'read', items: [{ filesystem: '/dev/vda1', type: 'ext4', mount: '/', totalBytes: 107374182400, usedBytes: 42949672960, availableBytes: 64424509440, inodes: { total: 1000, used: 250, free: 750 } }, { filesystem: '/dev/vdb1', type: 'btrfs', mount: '/srv/My Data', totalBytes: 1024, usedBytes: 0, availableBytes: 1024, inodes: null }] }, accounts: { state: 'unavailable', source: 'repquota', mount: '/', items: [], reason: 'quota-report-unavailable' } })
const logs = (query: { unit: string; lines: number; since: string | null; priority: number | null }) => ({ state: 'read', ...query, observedAt: '2026-10-27T12:00:00.000Z', order: 'newest-first', truncated: false, items: [{ at: '2026-10-27T11:59:00.000Z', priority: 3, unit: query.unit, pid: 1301, message: '<img src=x onerror=alert(1)>', messageTruncated: true }, { at: '2026-10-27T11:58:00.000Z', priority: null, unit: null, pid: null, message: null, messageTruncated: false }] })
const performance = (window: '1h' | '24h' | '7d', filled = true) => {
  const buckets = window === '1h' ? 60 : window === '24h' ? 96 : 168, seconds = window === '1h' ? 60 : window === '24h' ? 900 : 3600
  const points = Array.from({ length: buckets }, (_, index) => {
    const sampled = filled && (index === buckets - 1 || index === buckets - 2 || index === 3)
    const metric = (avg: number) => sampled ? { avg, max: avg + 1 } : null
    return { at: new Date(Date.UTC(2026, 9, 27, 11) + index * seconds * 1000).toISOString(), samples: sampled ? 2 : 0, values: { cpuPercent: metric(10 + index), memoryMb: metric(500), load1: metric(0.5), processes: metric(90), diskMb: metric(4096) } }
  })
  return { state: 'read', scope: 'host', source: 'metrics-history', window, from: '2026-10-27T11:00:00.000Z', to: '2026-10-27T12:00:00.000Z', bucketSeconds: seconds, samples: points.reduce((sum, point) => sum + point.samples, 0), truncated: false, points }
}
type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
const boot = (html: string, send?: Send, askDialog?: (options: Record<string, unknown>) => Promise<unknown>, ar = false) => {
  document.body.innerHTML = `<section data-whm-detail-route="/whm/monitoring" data-capability-state="authorized">${html}</section>`
  if (send) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
  document.documentElement.lang = ar ? 'ar' : 'en'; document.documentElement.dir = ar ? 'rtl' : 'ltr'
  new Function('return ' + WHM_MONITORING_CLIENT_BINDING)()(askDialog)
}
afterEach(() => { document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr' })
const text = (selector: string) => document.querySelector(selector)!.textContent ?? ''
const state = () => document.querySelector<HTMLElement>('[data-whm-monitoring-status]')!.dataset.state
beforeEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('monitoring client parsers', () => {
  it('accept the reviewed contracts and reject unsafe or inconsistent values', () => {
    expect(readProcessesView(processes()).items).toHaveLength(3)
    for (const bad of [{ ...processes(), truncated: true }, { ...processes(), total: 1 }, processes([process(4242, { comm: 'x\u001b[2J' })]), processes([process(4242, { account: '<b>' })]), processes([process(4242, { protection: 'none' })]), processes([process(4242), process(4242)]), processes([process(4242, { args: undefined, startedAt: '2026-10-26' })])])
      expect(() => readProcessesView(bad)).toThrow()
    const body = { pid: 4242, uid: 20001, comm: 'php-fpm8.3', startedAt: '2026-10-26T10:58:59.000Z', signal: 'TERM' as const }
    expect(readSignalOutcome({ state: 'attempted', signal: 'TERM', pid: 4242, commandOk: true, observedAt: '2026-10-27T12:00:00.000Z', verificationRequired: true }, body).state).toBe('attempted')
    for (const bad of [{ state: 'attempted', signal: 'TERM', pid: 4242, commandOk: true, observedAt: '2026-10-27T12:00:00.000Z', verificationRequired: false }, { state: 'confirmed', signal: 'KILL', pid: 4242, commandOk: true, observedAt: '2026-10-27T12:00:00.000Z', verificationRequired: false }, { state: 'confirmed', signal: 'TERM', pid: 1, commandOk: true, observedAt: '2026-10-27T12:00:00.000Z', verificationRequired: false }])
      expect(() => readSignalOutcome(bad, body)).toThrow()
    expect(readDiskView(disk()).accounts.reason).toBe('quota-report-unavailable')
    expect(() => readDiskView({ ...disk(), accounts: { ...disk().accounts, items: [{ username: 'alice', usedBytes: 1, limitBytes: null }] } })).toThrow()
    const query = { unit: 'nginx.service', lines: 10, since: null, priority: null }
    expect(readLogsView(logs(query), query).items).toHaveLength(2)
    expect(() => readLogsView(logs({ ...query, unit: 'ssh.service' }), query)).toThrow()
    expect(() => readLogsView(logs(query), { ...query, lines: 1 })).toThrow()
    expect(readPerformanceView(performance('24h'), '24h').points).toHaveLength(96)
    expect(() => readPerformanceView(performance('24h'), '7d')).toThrow()
    expect(() => readPerformanceView({ ...performance('1h'), samples: 1 }, '1h')).toThrow()
    const gap = performance('1h'); gap.points[0]!.values.cpuPercent = { avg: 0, max: 0 }
    expect(() => readPerformanceView(gap, '1h')).toThrow()
  })
  it('serializes a self-contained binding without HTML injection or direct fetch', () => {
    expect(WHM_MONITORING_CLIENT_BINDING).not.toContain('innerHTML')
    expect(WHM_MONITORING_CLIENT_BINDING).not.toContain('fetch(')
    expect(typeof new Function('return ' + WHM_MONITORING_CLIENT_BINDING)()).toBe('function')
  })
})

describe('monitoring client binding', () => {
  it('keeps the workspace but reads nothing without transport or admission', async () => {
    boot(renderWhmMonitoringProcesses({ locale: 'en', canRead: true, canSignal: true }))
    expect(state()).toBe('unavailable')
    expect(document.querySelector<HTMLButtonElement>('[data-whm-monitoring-refresh]')!.disabled).toBe(true)
    const send = vi.fn(async () => processes())
    boot(renderWhmMonitoringDisk({ locale: 'en', canRead: false }), send); await tick()
    boot(renderWhmMonitoringPerformance({ locale: 'en', canRead: true }).replace('data-monitoring-can-read="true"', 'data-monitoring-can-read="true" data-wiring="soon"'), send); await tick()
    expect(send).not.toHaveBeenCalled()
  })
  it('reads, filters and sorts processes, then signals TERM and a separately confirmed KILL', async () => {
    let current = processes()
    const send = vi.fn(async (method: string, path: string, body?: unknown) => {
      if (method === 'GET') return current
      const signal = (body as { signal: string }).signal
      if (signal === 'TERM') return { state: 'attempted', signal, pid: 4242, commandOk: true, observedAt: '2026-10-27T12:00:01.000Z', verificationRequired: true }
      current = processes(current.items.filter(item => item.pid !== 4242))
      return { state: 'confirmed', signal, pid: 4242, commandOk: true, observedAt: '2026-10-27T12:00:02.000Z', verificationRequired: false }
    })
    const ask = vi.fn(async () => true)
    boot(renderWhmMonitoringProcesses({ locale: 'en', canRead: true, canSignal: true }), send, ask); await tick()
    expect(send).toHaveBeenCalledWith('GET', '/api/server/monitoring/processes')
    expect(state()).toBe('read')
    const pids = () => [...document.querySelectorAll('[data-whm-monitoring-rows] tr')].map(row => row.querySelector('td')!.textContent)
    expect(pids()).toEqual(['5000', '4242', '1301'])
    expect(text('[data-whm-monitoring-rows]')).toContain('Protected: root process')
    expect(text('[data-whm-monitoring-rows]')).toContain('1d 01:01:01')
    const search = document.querySelector<HTMLInputElement>('[data-whm-monitoring-search]')!
    search.value = 'web'; search.dispatchEvent(new Event('input')); expect(pids()).toEqual(['5000'])
    search.value = ''; search.dispatchEvent(new Event('input'))
    const owner = document.querySelector<HTMLSelectElement>('[data-whm-monitoring-account]')!
    owner.value = 'alice'; owner.dispatchEvent(new Event('change')); expect(pids()).toEqual(['4242'])
    owner.value = ''; owner.dispatchEvent(new Event('change'))
    const sort = document.querySelector<HTMLSelectElement>('[data-whm-monitoring-sort]')!
    sort.value = 'pid'; sort.dispatchEvent(new Event('change')); expect(pids()).toEqual(['1301', '4242', '5000'])
    expect(document.querySelectorAll('[data-whm-monitoring-signal="KILL"]')).toHaveLength(0)
    const row = () => [...document.querySelectorAll('[data-whm-monitoring-rows] tr')].find(item => item.querySelector('td')!.textContent === '4242')!
    row().querySelector<HTMLButtonElement>('[data-whm-monitoring-signal="TERM"]')!.click(); await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/monitoring/processes/signal', { pid: 4242, uid: 20001, comm: 'php-fpm8.3', startedAt: '2026-10-26T10:58:59.000Z', signal: 'TERM' })
    expect(state()).toBe('uncertain')
    expect(text('[data-whm-monitoring-status]')).toContain('still present')
    row().querySelector<HTMLButtonElement>('[data-whm-monitoring-signal="KILL"]')!.click(); await tick()
    expect(ask).toHaveBeenCalledTimes(2)
    expect((ask.mock.calls[1] as unknown as [Record<string, unknown>])[0].title).toBe('Force stop with KILL?')
    expect(send).toHaveBeenCalledWith('POST', '/api/server/monitoring/processes/signal', { pid: 4242, uid: 20001, comm: 'php-fpm8.3', startedAt: '2026-10-26T10:58:59.000Z', signal: 'KILL', killConfirmed: true })
    expect(state()).toBe('saved')
    expect(pids()).toEqual(['1301', '5000'])
  })
  it('sends nothing when confirmation is declined and reports 409 and unknown outcomes truthfully', async () => {
    const send = vi.fn(async (method: string): Promise<unknown> => { if (method === 'GET') return processes(); throw Object.assign(new Error('refused'), { status: 409, details: { stateChanged: false } }) })
    const ask = vi.fn(async () => false)
    boot(renderWhmMonitoringProcesses({ locale: 'en', canRead: true, canSignal: true }), send, ask); await tick()
    document.querySelector<HTMLButtonElement>('[data-whm-monitoring-signal="TERM"]')!.click(); await tick()
    expect(send.mock.calls.some(([method]) => method === 'POST')).toBe(false)
    ask.mockResolvedValue(true)
    document.querySelector<HTMLButtonElement>('[data-whm-monitoring-signal="TERM"]')!.click(); await tick()
    expect(state()).toBe('stale')
    send.mockImplementation(async (method: string) => { if (method === 'GET') return processes(); throw Object.assign(new Error('gone'), { status: 503, details: { stateChanged: true, unknownOutcome: true } }) })
    document.querySelector<HTMLButtonElement>('[data-whm-monitoring-signal="TERM"]')!.click(); await tick()
    expect([state(), text('[data-whm-monitoring-status]')]).toEqual(['uncertain', 'The signal outcome requires review. No retry was sent; read the process list before acting again.'])
    boot(renderWhmMonitoringProcesses({ locale: 'en', canRead: true, canSignal: false }), async () => processes()); await tick()
    expect(document.querySelector('[data-whm-monitoring-signal]')).toBeNull()
  })
  it.each([false, true])('reads filesystems with unavailable quota usage (arabic=%s)', async ar => {
    boot(renderWhmMonitoringDisk({ locale: ar ? 'ar' : 'en', canRead: true }), async () => disk(), undefined, ar); await tick()
    expect(state()).toBe('read')
    expect(text('[data-whm-monitoring-rows]')).toContain('40.0 GiB')
    expect(text('[data-whm-monitoring-rows]')).toContain('/srv/My Data')
    expect(text('[data-whm-monitoring-rows]')).toContain('25%')
    expect(document.querySelector<HTMLElement>('[data-whm-monitoring-quota-status]')!.dataset.state).toBe('unavailable')
    expect(document.body.innerHTML).not.toMatch(/[٠-٩۰-۹]/)
  })
  it('validates log selectors before sending and renders messages as text', async () => {
    const send = vi.fn(async (_method: string, path: string) => { const params = new URL(path, 'https://panel.test').searchParams; return logs({ unit: params.get('unit')!, lines: Number(params.get('lines')), since: params.get('since'), priority: params.has('priority') ? Number(params.get('priority')) : null }) })
    boot(renderWhmMonitoringLogs({ locale: 'en', canRead: true }), send); await tick()
    expect(send).not.toHaveBeenCalled()
    const lines = document.querySelector<HTMLInputElement>('[data-whm-monitoring-lines]')!, refresh = document.querySelector<HTMLButtonElement>('[data-whm-monitoring-refresh]')!
    lines.value = '501'; refresh.click(); await tick()
    expect([send.mock.calls.length, state()]).toEqual([0, 'failed'])
    lines.value = '20'
    document.querySelector<HTMLSelectElement>('[data-whm-monitoring-unit]')!.value = 'ssh.service'
    document.querySelector<HTMLInputElement>('[data-whm-monitoring-since]')!.value = '2026-10-27T10:00'
    document.querySelector<HTMLSelectElement>('[data-whm-monitoring-priority]')!.value = '3'
    refresh.click(); await tick()
    expect(send).toHaveBeenCalledWith('GET', '/api/server/monitoring/logs?unit=ssh.service&lines=20&since=2026-10-27T10%3A00%3A00.000Z&priority=3')
    expect(state()).toBe('read')
    expect(document.querySelector('[data-whm-monitoring-rows] img')).toBeNull()
    expect(text('[data-whm-monitoring-rows]')).toContain('<img src=x onerror=alert(1)> [truncated at 4 KiB]')
    expect(text('[data-whm-monitoring-rows]')).toContain('No message was recorded')
  })
  it('draws gap-aware charts and keeps an empty window explicit', async () => {
    const send = vi.fn(async (_method: string, path: string) => path.endsWith('7d') ? performance('7d', false) : performance('1h'))
    boot(renderWhmMonitoringPerformance({ locale: 'en', canRead: true }), send); await tick()
    expect(send).toHaveBeenCalledWith('GET', '/api/server/monitoring/performance?window=1h')
    expect(state()).toBe('read')
    const cpu = document.querySelector('[data-whm-monitoring-chart="cpuPercent"]')!
    expect([cpu.querySelectorAll('polyline').length, cpu.querySelectorAll('circle').length]).toEqual([1, 1])
    expect(text('[data-whm-monitoring-summary-rows]')).toContain('69')
    const range = document.querySelector<HTMLSelectElement>('[data-whm-monitoring-window]')!
    range.value = '7d'; range.dispatchEvent(new Event('change')); await tick()
    expect(state()).toBe('empty')
    expect(cpu.querySelector('svg')).toBeNull()
    expect(text('[data-whm-monitoring-summary-rows]')).toContain('No samples')
  })
})


describe('full timestamp display additional monitoring surfaces', () => {
  it.each(['en', 'ar'] as const)('formats process observation without changing signal identity in %s', async locale => {
    const raw = { ...processes(), observedAt: '2026-10-27T12:00:01.123Z' }, before = JSON.stringify(raw)
    const send = vi.fn(async () => raw)
    boot(renderWhmMonitoringProcesses({ locale, canRead: true, canSignal: true }), send, async () => true, locale === 'ar'); await tick()
    expect(text('[data-whm-monitoring-observed-at]')).toBe('2026-10-27 12:00 UTC')
    expect(document.querySelector('[data-whm-monitoring-observed-at]')!.getAttribute('dir')).toBe('ltr')
    expect(send).toHaveBeenCalledWith('GET', '/api/server/monitoring/processes')
    expect(readProcessesView(raw).items[0]!.startedAt).toBe('2026-10-26T10:58:59.000Z')
    expect(JSON.stringify(raw)).toBe(before)
  })
  it.each(['en', 'ar'] as const)('formats disk observation without changing inode or quota facts in %s', async locale => {
    const raw = { ...disk(), observedAt: '2026-10-27T12:00:02.007Z' }, before = JSON.stringify(raw)
    const send = vi.fn(async () => raw)
    boot(renderWhmMonitoringDisk({ locale, canRead: true }), send, undefined, locale === 'ar'); await tick()
    expect(text('[data-whm-monitoring-observed-at]')).toBe('2026-10-27 12:00 UTC')
    expect(send).toHaveBeenCalledWith('GET', '/api/server/monitoring/disk')
    expect(readDiskView(raw).observedAt).toBe('2026-10-27T12:00:02.007Z')
    expect(JSON.stringify(raw)).toBe(before)
  })
  it.each(['en', 'ar'] as const)('formats structured journal time but preserves canonical query and raw message in %s', async locale => {
    const query = { unit: 'ssh.service', lines: 20, since: '2026-10-27T10:00:00.000Z', priority: 3 }
    const raw = { ...logs(query), observedAt: '2026-10-27T12:00:03.120Z' }
    raw.items[0]!.at = '2026-10-27T11:59:04.456Z'
    raw.items[0]!.message = 'raw evidence timestamp=2026-10-27T11:58:07.234Z'
    raw.items[0]!.messageTruncated = false
    const before = JSON.stringify(raw), send = vi.fn(async () => raw)
    boot(renderWhmMonitoringLogs({ locale, canRead: true }), send, undefined, locale === 'ar')
    document.querySelector<HTMLInputElement>('[data-whm-monitoring-lines]')!.value = '20'
    document.querySelector<HTMLSelectElement>('[data-whm-monitoring-unit]')!.value = 'ssh.service'
    document.querySelector<HTMLInputElement>('[data-whm-monitoring-since]')!.value = '2026-10-27T10:00'
    document.querySelector<HTMLSelectElement>('[data-whm-monitoring-priority]')!.value = '3'
    document.querySelector<HTMLButtonElement>('[data-whm-monitoring-refresh]')!.click(); await tick()
    expect(text('[data-whm-monitoring-observed-at]')).toBe('2026-10-27 12:00 UTC')
    expect(document.querySelector('[data-whm-monitoring-rows] tr td:first-child bdi[dir="ltr"]')!.textContent).toBe('2026-10-27 11:59 UTC')
    expect(text('[data-whm-monitoring-message]')).toBe('raw evidence timestamp=2026-10-27T11:58:07.234Z')
    expect(send).toHaveBeenCalledWith('GET', '/api/server/monitoring/logs?unit=ssh.service&lines=20&since=2026-10-27T10%3A00%3A00.000Z&priority=3')
    expect(readLogsView(raw, query).items[0]!.at).toBe('2026-10-27T11:59:04.456Z')
    expect(JSON.stringify(raw)).toBe(before)
  })
  it('marks a truncated journal message in Arabic', async () => {
    const query = { unit: 'ssh.service', lines: 20, since: '2026-10-27T10:00:00.000Z', priority: 3 }
    boot(renderWhmMonitoringLogs({ locale: 'ar', canRead: true }), vi.fn(async () => logs(query)), undefined, true)
    document.querySelector<HTMLInputElement>('[data-whm-monitoring-lines]')!.value = '20'
    document.querySelector<HTMLSelectElement>('[data-whm-monitoring-unit]')!.value = 'ssh.service'
    document.querySelector<HTMLInputElement>('[data-whm-monitoring-since]')!.value = '2026-10-27T10:00'
    document.querySelector<HTMLSelectElement>('[data-whm-monitoring-priority]')!.value = '3'
    document.querySelector<HTMLButtonElement>('[data-whm-monitoring-refresh]')!.click(); await tick()
    expect(text('[data-whm-monitoring-message]')).toBe('<img src=x onerror=alert(1)> [مقتطعة عند 4 KiB]')
  })
  it.each(['en', 'ar'] as const)('formats performance window metadata without changing point times or chart gaps in %s', async locale => {
    const raw = { ...performance('1h'), from: '2026-10-27T11:00:05.000Z', to: '2026-10-27T12:00:06.125Z' }, before = JSON.stringify(raw)
    const send = vi.fn(async () => raw)
    boot(renderWhmMonitoringPerformance({ locale, canRead: true }), send, undefined, locale === 'ar'); await tick()
    expect(text('[data-whm-monitoring-observed-range]')).toBe('2026-10-27 11:00 UTC / 2026-10-27 12:00 UTC')
    expect(send).toHaveBeenCalledWith('GET', '/api/server/monitoring/performance?window=1h')
    expect(readPerformanceView(raw, '1h').points[0]!.at).toBe('2026-10-27T11:00:00.000Z')
    expect(readPerformanceView(raw, '1h').points[0]!.values.cpuPercent).toBeNull()
    expect(document.querySelectorAll('[data-whm-monitoring-chart="cpuPercent"] polyline')).toHaveLength(1)
    expect(document.querySelectorAll('[data-whm-monitoring-chart="cpuPercent"] circle')).toHaveLength(1)
    expect(text('[data-whm-monitoring-chart="cpuPercent"] [data-whm-monitoring-chart-state]')).toBe(locale === 'ar' ? 'المتوسط لكل فترة. أعلى عينة: 70' : 'Average per interval. Peak sample: 70')
    expect(JSON.stringify(raw)).toBe(before)
  })
})
