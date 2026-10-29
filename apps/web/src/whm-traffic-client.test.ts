// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWhmTrafficWorkspace } from './board-port/whm-traffic-workspace.ts'
import { readWhmTrafficView, WHM_TRAFFIC_CLIENT_BINDING } from './whm-traffic-client.ts'
const tick = async () => { for (let n = 0; n < 5; n++) await new Promise(resolve => setTimeout(resolve, 0)) }
const view = () => ({ scope: 'server', observedAt: '2026-10-27T12:00:00Z', interfaces: { state: 'read', intervalMs: 1000, skipped: 0, items: [{ name: 'eth0', state: 'read', receivedBps: 10, sentBps: 20 }] }, http: { state: 'partial', rows: [], accounts: [], readSites: 1, omittedRows: 0, omittedSites: 2, unavailableSites: 0, skippedLines: 3, truncated: true, from: null, to: null }, history: { state: 'unavailable', reason: 'network_counters_not_recorded' } })
afterEach(() => { delete (window as any).xpanelSessionRequest; document.body.innerHTML = ''; document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr' })
describe('traffic browser workflow', () => {
  it.each(['en', 'ar'] as const)('renders observed rates and coverage in %s', async locale => { document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'; document.body.innerHTML = renderWhmTrafficWorkspace({ locale, canRead: true }); const send = vi.fn(async () => view()); (window as any).xpanelSessionRequest = send; new Function('return ' + WHM_TRAFFIC_CLIENT_BINDING)()(); await tick(); expect(send).toHaveBeenCalledTimes(1); expect(document.querySelector('[data-traffic-table="interfaces"]')!.textContent).toContain('eth0'); expect(document.querySelector('[data-traffic-coverage]')!.textContent).toBe(locale === 'ar' ? 'المواقع المقروءة: 1؛ غير المتاحة: 0؛ المواقع المستبعدة: 2؛ الصفوف المستبعدة: 0؛ الأسطر المتجاوزة: 3؛ جزء أخير محدود، استُبعدت السجلات الأقدم.' : 'Read sites: 1; unavailable: 0; omitted sites: 2; omitted rows: 0; skipped lines: 3; bounded tail, older entries omitted.'); expect(document.querySelector('[data-traffic-status]')!.getAttribute('data-state')).toBe('partial'); expect(document.querySelector('[data-traffic-table="interfaces"] bdi')!.getAttribute('dir')).toBe('ltr') })
  it('refuses malformed readings and never binds denied pages', async () => { const bad = view(); bad.interfaces.items[0]!.receivedBps = -1; expect(() => readWhmTrafficView(bad)).toThrow(); document.body.innerHTML = renderWhmTrafficWorkspace({ locale: 'en', canRead: false }); const send = vi.fn(); (window as any).xpanelSessionRequest = send; new Function('return ' + WHM_TRAFFIC_CLIENT_BINDING)()(); await tick(); expect(send).not.toHaveBeenCalled() })
  it('refuses duplicated interfaces and incoherent time or history states', () => { const duplicate = view(); duplicate.interfaces.items.push(duplicate.interfaces.items[0]!); expect(() => readWhmTrafficView(duplicate)).toThrow(); const times = view() as any; times.http.from = '2026-10-27T12:00:00Z'; expect(() => readWhmTrafficView(times)).toThrow(); const history = view() as any; history.history.state = 'read'; expect(() => readWhmTrafficView(history)).toThrow(); const sample = view(); sample.interfaces.intervalMs = 0; expect(() => readWhmTrafficView(sample)).toThrow() })
})


describe('readable metadata datetime - traffic', () => {
  it.each(['en', 'ar'] as const)('formats observation and coverage metadata in %s without altering intervals or raw boundaries', async locale => {
    const raw = { ...view(), observedAt: '2026-10-27T12:00:01.123456Z', http: { ...view().http, from: '2026-10-27T10:00:00.000Z', to: '2026-10-27T12:00:00.654321Z' } }
    const before = JSON.stringify(raw), send = vi.fn(async (_method: string, _path: string) => raw)
    document.body.innerHTML = renderWhmTrafficWorkspace({ locale, canRead: true }); (window as any).xpanelSessionRequest = send
    new Function('return ' + WHM_TRAFFIC_CLIENT_BINDING)()(); await tick()
    expect(document.querySelector('[data-traffic-observed]')!.textContent).toBe('2026-10-27 12:00 UTC')
    expect(document.querySelector('[data-traffic-observed]')!.getAttribute('dir')).toBe('ltr')
    const endpoints = [...document.querySelectorAll('[data-traffic-coverage] bdi[dir="ltr"]')].map(node => node.textContent)
    expect(endpoints).toEqual(['2026-10-27 10:00 UTC', '2026-10-27 12:00 UTC'])
    expect(document.querySelector('[data-traffic-interval]')!.textContent).toBe('1000 ms')
    expect(send.mock.calls).toEqual([['GET', '/api/server/monitoring/traffic']])
    const parsed = readWhmTrafficView(raw)
    expect(parsed.observedAt).toBe('2026-10-27T12:00:01.123456Z')
    expect(parsed.http.from).toBe('2026-10-27T10:00:00.000Z'); expect(parsed.http.to).toBe('2026-10-27T12:00:00.654321Z')
    expect(JSON.stringify(raw)).toBe(before)
  })
  it.each(['en', 'ar'] as const)('keeps absent coverage endpoints distinct from zero fractions in %s', async locale => {
    const raw = view(), send = vi.fn(async (_method: string, _path: string) => raw)
    document.body.innerHTML = renderWhmTrafficWorkspace({ locale, canRead: true }); (window as any).xpanelSessionRequest = send
    new Function('return ' + WHM_TRAFFIC_CLIENT_BINDING)()(); await tick()
    expect(document.querySelector('[data-traffic-observed]')!.textContent).toBe('2026-10-27 12:00 UTC')
    expect(document.querySelectorAll('[data-traffic-coverage] bdi')).toHaveLength(0)
    expect(readWhmTrafficView(raw).http.from).toBeNull(); expect(readWhmTrafficView(raw).http.to).toBeNull()
    expect(send.mock.calls).toEqual([['GET', '/api/server/monitoring/traffic']])
    expect(() => readWhmTrafficView({ ...raw, observedAt: null })).toThrow()
  })
})
