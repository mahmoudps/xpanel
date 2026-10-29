// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWhmBenchmarkWorkspace } from './board-port/whm-benchmark-workspace.ts'
import { readWhmBenchmarkView, WHM_BENCHMARK_CLIENT_BINDING } from './whm-benchmark-client.ts'
const tick = async () => { for (let n = 0; n < 5; n++) await new Promise(resolve => setTimeout(resolve, 0)) }
const view = () => ({ history: { state: 'read', results: [] }, jobsAvailable: true, limits: { cpuSeconds: 5, diskBytes: 67108864, maxRuntimeSeconds: 60 }, network: 'not_measured' })
afterEach(() => { delete (window as any).xpanelSessionRequest; document.body.innerHTML = '' })
describe('benchmark browser workflow', () => {
  it.each(['en', 'ar'] as const)('requires explicit confirmation in %s and never starts on load', async locale => {
    document.body.innerHTML = renderWhmBenchmarkWorkspace({ locale, canManage: true })
    const send = vi.fn(async (method: string) => method === 'GET' ? view() : { job: { id: '11111111-1111-4111-8111-111111111111', kind: 'system.monitoring.benchmark', status: 'queued' } }); (window as any).xpanelSessionRequest = send
    new Function('return ' + WHM_BENCHMARK_CLIENT_BINDING)()(); await tick()
    expect(send).toHaveBeenCalledTimes(1); expect(send.mock.calls[0]![0]).toBe('GET')
    const button = document.querySelector<HTMLButtonElement>('[data-benchmark-start]')!, input = document.querySelector<HTMLInputElement>('[data-benchmark-confirm]')!
    expect(button.disabled).toBe(true); input.value = 'RUN'; input.dispatchEvent(new Event('input')); expect(button.disabled).toBe(false)
    document.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true })); await tick(); expect(send.mock.calls[1]![0]).toBe('POST'); expect(button.disabled).toBe(true)
    expect(document.body.textContent).not.toContain('11111111-1111')
  })
  it('does not bind a denied page and rejects invented results', async () => { document.body.innerHTML = renderWhmBenchmarkWorkspace({ locale: 'en', canManage: false }); const send = vi.fn(); (window as any).xpanelSessionRequest = send; new Function('return ' + WHM_BENCHMARK_CLIENT_BINDING)()(); await tick(); expect(send).not.toHaveBeenCalled(); expect(() => readWhmBenchmarkView({ ...view(), history: { state: 'read', results: [{ state: 'measured' }] } })).toThrow() })
  it('locks ambiguous submission rather than retrying automatically', async () => { document.body.innerHTML = renderWhmBenchmarkWorkspace({ locale: 'en', canManage: true }); const send = vi.fn(async (method: string) => { if (method === 'POST') throw new Error('network'); return view() }); (window as any).xpanelSessionRequest = send; new Function('return ' + WHM_BENCHMARK_CLIENT_BINDING)()(); await tick(); const input = document.querySelector<HTMLInputElement>('input')!; input.value = 'RUN'; input.dispatchEvent(new Event('input')); document.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true })); await tick(); expect(document.querySelector<HTMLButtonElement>('[data-benchmark-start]')!.disabled).toBe(true); expect(document.querySelector('[data-benchmark-status]')!.textContent).toContain('unknown') })
})


describe('readable metadata datetime - benchmark', () => {
  it.each(['en', 'ar'] as const)('formats supplied history timestamps in %s without starting work or changing instants', async locale => {
    const result = { startedAt: '2026-10-27T10:00:00.123456Z', finishedAt: '2026-10-27T10:00:05.123456Z', state: 'partial', cpuBytesPerSecond: 104857600, diskWriteBytesPerSecond: null, diskReadBytesPerSecond: null, cleanup: 'unknown', network: 'not_measured' }
    const raw = { ...view(), history: { state: 'read', results: [result, { ...result, startedAt: '2026-10-27T09:00:00.000Z', finishedAt: '2026-10-27T09:00:05.000Z' }] } }
    const before = JSON.stringify(raw)
    const send = vi.fn(async (_method: string, _path: string) => raw)
    document.body.innerHTML = renderWhmBenchmarkWorkspace({ locale, canManage: true }); (window as any).xpanelSessionRequest = send
    new Function('return ' + WHM_BENCHMARK_CLIENT_BINDING)()(); await tick()
    const rows = document.querySelectorAll('[data-benchmark-history] tr')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.querySelector('td:first-child bdi[dir="ltr"]')!.textContent).toBe('2026-10-27 10:00 UTC')
    expect(rows[1]!.querySelector('td:first-child bdi[dir="ltr"]')!.textContent).toBe('2026-10-27 09:00 UTC')
    expect(send.mock.calls).toEqual([['GET', '/api/server/monitoring/benchmark']])
    expect(document.querySelector<HTMLButtonElement>('[data-benchmark-start]')!.disabled).toBe(true)
    expect(readWhmBenchmarkView(raw)).toEqual(raw)
    expect(JSON.stringify(raw)).toBe(before)
    expect(Date.parse(result.finishedAt) - Date.parse(result.startedAt)).toBe(5000)
    expect(() => readWhmBenchmarkView({ ...raw, history: { state: 'read', results: [{ ...result, startedAt: null }] } })).toThrow()
  })
})
