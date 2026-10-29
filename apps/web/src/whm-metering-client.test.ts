// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWhmBandwidthWorkspace, renderWhmIoWorkspace } from './board-port/whm-metering-workspace.ts'
import { readWhmBandwidthView, readWhmIoView, WHM_METERING_CLIENT_BINDING } from './whm-metering-client.ts'

const tick = async () => { for (let n = 0; n < 5; n++) await new Promise(resolve => setTimeout(resolve, 0)) }
const io = () => ({ state: 'partial', reason: null, observedAt: '2026-10-28T14:05:00.000Z',
  host: { cpuPercent: 12, memoryUsedBytes: 4 * 1024 ** 3, memoryTotalBytes: 8 * 1024 ** 3, loadAvg1m: 1, psiSomeAvg10: 0.5, psiFullAvg10: 0, awaitMs: null },
  accounts: [{ username: 'yousef', uid: 20009, readBytesPerSec: 4.1 * 1024 ** 2, writeBytesPerSec: 2.2 * 1024 ** 2, readIops: 102, writeIops: 55, cpuPercent: 31.5, memoryCurrentBytes: 958 * 1024 ** 2, memoryLimitMb: 1024, pidsCurrent: 96, pidsLimit: 128, statusLevel: 'ok' }],
  disk: { state: 'read', observedAt: '2026-10-28T14:05:00.000Z', intervalSeconds: 60, awaitMs: 4.25, devices: [{ name: 'vda', readAwaitMs: 3, writeAwaitMs: null, utilPercent: 12.5 }] },
  unmeasuredAccounts: 1 })
const totals = (count: number, receivedBytes: number, sentBytes: number) => ({ count, receivedBytes, sentBytes })
const bandwidth = () => ({ state: 'partial', month: '2026-10', since: '2026-09-01T00:00:00.000Z', updatedAt: '2026-10-28T14:05:00.000Z', pendingBytes: 0, unavailableSites: 0, skippedLines: 0,
  sources: { web: { state: 'read', since: '2026-09-01T00:00:00.000Z' }, mail: { state: 'partial', since: '2026-10-28T10:00:00Z' }, ftp: { state: 'unavailable', since: null } },
  accounts: [
    { username: 'alice', domain: 'alice.test', status: 'active', month: { web: totals(12, 1024, 2048), mail: totals(2, 1024, 0), ftp: null }, totalBytes: 4096, limitBytes: 4000, usedPercent: 102.4, limitState: 'over', enforced: true, limited: true },
    { username: 'bob', domain: 'bob.test', status: 'suspended', month: { web: null, mail: null, ftp: null }, totalBytes: null, limitBytes: null, usedPercent: null, limitState: 'unmeasured', enforced: false, limited: false },
  ] })
const bind = () => new Function('return ' + WHM_METERING_CLIENT_BINDING)()()
const cells = (table = '') => [...document.querySelectorAll(`[data-whm-metering-rows${table ? `="${table}"` : '="io"],[data-whm-metering-rows="bandwidth"'}] tr`)].map(row => [...row.querySelectorAll('td')].map(td => td.textContent))
afterEach(() => { delete (window as any).xpanelSessionRequest; document.body.innerHTML = '' })

describe('metering browser workflow', () => {
  it.each(['en', 'ar'] as const)('shows the measured IO sample and keeps unmeasured fields unavailable in %s', async locale => {
    document.body.innerHTML = renderWhmIoWorkspace({ locale, canRead: true })
    const send = vi.fn(async () => io()); (window as any).xpanelSessionRequest = send
    bind(); await tick()
    expect(send.mock.calls).toEqual([['GET', '/api/server/monitoring/io']])
    const fact = (key: string) => document.querySelector(`[data-whm-metering-fact="${key}"]`)!.textContent
    expect(fact('observed')).toBe('2026-10-28 14:05 UTC'); expect(fact('read')).toBe('4.1 MiB/s'); expect(fact('iops')).toBe('157 IOPS')
    expect(fact('latency')).toBe('4.3 ms (60 s)'); expect(fact('host')).toBe('12% CPU; 4.0 GiB / 8.0 GiB')
    expect(cells('devices')).toEqual([['vda', '3 ms', '-', '12.5%']])
    const [row] = cells()
    expect(row![0]).toBe('yousef (UID 20009, xpanel-20009.slice)'); expect(row![3]).toMatch(/^958 \/ 1024 MiB \(94%\); /); expect(row![5]).toMatch(/^96 \/ 128 PIDs \(75%\); /)
    expect(document.querySelector('[data-whm-metering-status]')!.getAttribute('data-state')).toBe('partial')
  })
  it('shows no IO totals while the sample has measured no account', async () => {
    document.body.innerHTML = renderWhmIoWorkspace({ locale: 'en', canRead: true })
    ;(window as any).xpanelSessionRequest = vi.fn(async () => ({ ...io(), accounts: [], unmeasuredAccounts: 2 }))
    bind(); await tick()
    for (const key of ['read', 'write', 'iops']) expect(document.querySelector(`[data-whm-metering-fact="${key}"]`)!.textContent).toBe('Not measured')
  })
  it('shows measured bandwidth and marks unmeasured accounts instead of zero', async () => {
    document.body.innerHTML = renderWhmBandwidthWorkspace({ locale: 'en', canRead: true })
    const send = vi.fn(async () => bandwidth()); (window as any).xpanelSessionRequest = send
    bind(); await tick()
    expect(send.mock.calls).toEqual([['GET', '/api/server/monitoring/bandwidth']])
    expect(cells()).toEqual([
      ['alice', 'alice.test', 'Active', '3.0 KiB', '1.0 KiB', 'Not measured', '4.0 KiB', '3.9 KiB (102.4%); Over limit; Limit page served'],
      ['bob', 'bob.test', 'Suspended', 'Not measured', 'Not measured', 'Not measured', 'Not measured', 'Unlimited'],
    ])
    expect(document.querySelector('[data-whm-metering-rows="bandwidth"] tr td:last-child')!.getAttribute('data-level')).toBe('critical')
    expect(document.querySelector('[data-whm-metering-fact="month"]')!.textContent).toBe('2026-10')
    expect(document.querySelector('[data-whm-metering-fact="ftp"]')!.textContent).toBe('Not counted')
    expect(document.querySelector('[data-whm-metering-fact="mail"]')!.textContent).toBe('Partly counted · 2026-10-28 10:00 UTC')
  })
  it('refuses malformed readings and never binds a denied page', async () => {
    expect(() => readWhmIoView({ ...io(), state: 'unavailable' })).toThrow()
    expect(() => readWhmBandwidthView({ ...bandwidth(), accounts: [{ ...bandwidth().accounts[1], totalBytes: 0 }] })).toThrow()
    expect(() => readWhmBandwidthView({ ...bandwidth(), accounts: [{ ...bandwidth().accounts[0], enforced: 'yes' }] })).toThrow()
    document.body.innerHTML = renderWhmIoWorkspace({ locale: 'en', canRead: false })
    const send = vi.fn(); (window as any).xpanelSessionRequest = send
    bind(); await tick()
    expect(send).not.toHaveBeenCalled(); expect(document.querySelector<HTMLButtonElement>('[data-whm-metering-refresh]')!.disabled).toBe(true)
  })
  it('reports a failed read without inventing an empty result', async () => {
    document.body.innerHTML = renderWhmBandwidthWorkspace({ locale: 'en', canRead: true })
    ;(window as any).xpanelSessionRequest = vi.fn(async () => { throw new Error('offline') })
    bind(); await tick()
    const status = document.querySelector('[data-whm-metering-status]')!
    expect(status.getAttribute('data-state')).toBe('failed'); expect(status.getAttribute('role')).toBe('alert')
  })
})
