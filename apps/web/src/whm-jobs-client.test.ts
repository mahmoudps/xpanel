// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { renderWhmJobsWorkspace } from './board-port/whm-jobs-workspace.ts'
import { readJobListView, readJobLogView, readJobView, WHM_JOBS_CLIENT_BINDING } from './whm-jobs-client.ts'

const ID = '0f3c2a64-8b1d-4c2e-9a7f-5d6e7f8a9b0c'
const OTHER = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d'
const job = (overrides: Record<string, unknown> = {}) => ({
  id: ID, referenceCode: 'XP-JOB-2026-000123', kind: 'system.packages.upgrade', status: 'running', progress: 50, summary: 'Upgrade 2 packages', actor: 'root', accountId: null,
  createdAt: '2026-10-27T10:00:00.000Z', startedAt: '2026-10-27T10:00:01.000Z' as string | null, finishedAt: null as string | null,
  steps: [{ id: 'refresh', title: 'Refresh package lists', state: 'succeeded', exitCode: 0 }, { id: 'upgrade', title: 'Upgrade selected packages', state: 'running', exitCode: null }],
  error: null, failureClass: null, cancelRequested: false, verification: null, logBytes: 20, ...overrides,
})
const log = (overrides: Record<string, unknown> = {}) => ({ id: ID, available: true, offset: 0, nextOffset: 10, total: 20, truncated: false, text: 'first part', ...overrides })

type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
const flush = async () => { for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0) }
const boot = (send?: Send, ask?: (options: Record<string, unknown>) => Promise<unknown>, locale: 'en' | 'ar' = 'en', canRead = true) => {
  // The client translator follows the document language, as it does in a page.
  document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
  document.body.innerHTML = renderWhmJobsWorkspace({ locale, canRead })
  if (send) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
  new Function('return ' + WHM_JOBS_CLIENT_BINDING)()(ask)
}
const routes = (handlers: Record<string, (path: string, method: string) => unknown>): Mock<Send> => vi.fn<Send>(async (method, path) => {
  const key = Object.keys(handlers).find(prefix => (method + ' ' + path).startsWith(prefix))
  if (!key) throw Object.assign(new Error('unexpected ' + path), { status: 404 })
  return handlers[key]!(path, method)
})
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
})
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr' })

describe('WHM jobs client parsers', () => {
  it('accepts the agent job contract and rejects unsafe or inconsistent data', () => {
    expect(readJobView(job()).steps[1]!.state).toBe('running')
    expect(readJobView(job()).referenceCode).toBe('XP-JOB-2026-000123')
    expect(readJobView(job({ referenceCode: 'LEGACY/77-A' })).referenceCode).toBe('LEGACY/77-A')
    expect(readJobView(job({ referenceCode: null })).referenceCode).toBeNull()
    for (const referenceCode of [undefined, ID, 'XP-JOB-000000', 'bad\u202eref']) expect(() => readJobView(job({ referenceCode }))).toThrow()
    expect(readJobListView({ jobs: [job(), job({ id: OTHER })] })).toHaveLength(2)
    expect(() => readJobView(job({ id: ID.toUpperCase() }))).toThrow()
    expect(() => readJobView(job({ status: 'done' }))).toThrow()
    expect(() => readJobView(job({ summary: 'a\u202eb' }))).toThrow()
    expect(() => readJobView(job({ progress: 101 }))).toThrow()
    expect(() => readJobView(job({ failureClass: 'maybe' }))).toThrow()
    expect(readJobView(job({ steps: [{ id: 'zone-1', title: 'Check zone {zone}', titleValues: { zone: 'example.com' }, state: 'pending', exitCode: null }] })).steps[0]).toEqual({ id: 'zone-1', title: 'Check zone {zone}', titleValues: { zone: 'example.com' }, state: 'pending', exitCode: null })
    expect(() => readJobView(job({ steps: [{ id: 'x', title: 'Check zone {zone}', state: 'done', exitCode: null }] }))).toThrow()
    expect(() => readJobView(job({ steps: [{ id: 'x', title: { en: 'Old', ar: 'Old' }, state: 'pending', exitCode: null }] }))).toThrow()
    expect(() => readJobView(job({ steps: [{ id: 'x', title: 'Check zone {zone}', titleValues: { 'bad name': 'x' }, state: 'pending', exitCode: null }] }))).toThrow()
    expect(() => readJobView(job({ verification: { ok: true, detail: { blob: 'x'.repeat(20000) } } }))).toThrow()
    expect(() => readJobView(job({ createdAt: '27/10/2026' }))).toThrow()
    expect(() => readJobListView({ jobs: [job(), job()] })).toThrow()
    expect(readJobLogView(log()).text).toBe('first part')
    expect(() => readJobLogView(log({ nextOffset: 30 }))).toThrow()
    expect(() => readJobLogView(log({ text: 'bad\u001b[0m' }))).toThrow()
    expect(() => readJobLogView(log({ available: false }))).toThrow()
  })
})

describe('WHM jobs client binding', () => {
  it.each(['en', 'ar'] as const)('shows a null reference as unnumbered in history and detail with internal routing retained: %s', async locale => {
    const current = job({ referenceCode: null, status: 'succeeded', steps: [] })
    const send = routes({ 'GET /api/jobs?': () => ({ jobs: [current] }), [`GET /api/jobs/${ID}/log`]: () => log(), [`GET /api/jobs/${ID}`]: () => ({ job: current }) })
    boot(send, undefined, locale); await flush()
    expect($('[data-whm-jobs-rows] td').textContent).toBe(locale === 'ar' ? 'غير مرقمة' : 'Unnumbered')
    $<HTMLButtonElement>('[data-whm-jobs-select]').click(); await flush()
    expect($('[data-whm-jobs-field="reference"]').textContent).toBe(locale === 'ar' ? 'غير مرقمة' : 'Unnumbered')
    expect(document.body.textContent).not.toContain(ID)
    expect(send).toHaveBeenCalledWith('GET', '/api/jobs/' + ID)
  })
  it('keeps the page visible but sends nothing without transport or admission', async () => {
    boot()
    expect($('[data-whm-jobs-status]').dataset.state).toBe('unavailable')
    expect($<HTMLButtonElement>('[data-whm-jobs-refresh]').disabled).toBe(true)
    const send = vi.fn<Send>()
    boot(send, undefined, 'en', false); await flush()
    expect(send).not.toHaveBeenCalled()
    expect($('[data-whm-jobs-status]').dataset.state).toBe('unavailable')
  })

  it('reads history, opens a job with its steps and log, pages the log and polls while running', async () => {
    const send = routes({
      'GET /api/jobs?': () => ({ jobs: [job()] }),
      [`GET /api/jobs/${ID}/log?offset=0`]: () => log(),
      [`GET /api/jobs/${ID}/log?offset=10`]: () => log({ offset: 10, nextOffset: 20, text: ' second' }),
      [`GET /api/jobs/${ID}/log?offset=20`]: () => log({ offset: 20, nextOffset: 20, text: '' }),
      [`GET /api/jobs/${ID}`]: () => ({ job: job() }),
    })
    boot(send); await flush()
    expect(send.mock.calls[0]!.slice(0, 2)).toEqual(['GET', '/api/jobs?limit=50'])
    expect($('[data-whm-jobs-status]').dataset.state).toBe('read')
    const row = $('[data-whm-jobs-rows] tr')
    expect(row.textContent).toContain('system.packages.upgrade')
    expect(row.querySelector('.xp-badge--reconciling')!.textContent).toBe('Running')
    expect(row.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('50')
    expect(row.querySelector('bdi[dir="ltr"]')!.textContent).toBe('XP-JOB-2026-000123')
    expect(row.textContent).not.toContain(ID)
    $<HTMLButtonElement>('[data-whm-jobs-select]').click(); await flush()
    expect($('[data-whm-jobs-select]').getAttribute('aria-pressed')).toBe('true')
    expect($('[data-whm-jobs-steps]').textContent).toContain('Upgrade selected packages')
    expect($('[data-whm-jobs-steps]').textContent).toContain('Running')
    expect($('[data-whm-jobs-field="started"] bdi[dir="ltr"]').textContent).toBe('2026-10-27 10:00 UTC')
    expect($('[data-whm-jobs-field="reference"]').textContent).toBe('XP-JOB-2026-000123')
    expect($('[data-whm-jobs-log]').textContent).toBe('first part')
    expect($('[data-whm-jobs-log-status]').textContent).toContain('Showing 10 of 20 bytes')
    expect($<HTMLButtonElement>('[data-whm-jobs-cancel]').disabled).toBe(true)
    $<HTMLButtonElement>('[data-whm-jobs-log-more]').click(); await flush()
    expect($('[data-whm-jobs-log]').textContent).toBe('first part second')
    expect($<HTMLButtonElement>('[data-whm-jobs-log-more]').disabled).toBe(true)
    const before = send.mock.calls.filter(call => call[1].startsWith('/api/jobs?')).length
    await vi.advanceTimersByTimeAsync(5000); await flush()
    expect(send.mock.calls.filter(call => call[1].startsWith('/api/jobs?')).length).toBe(before + 1)
    expect(WHM_JOBS_CLIENT_BINDING).not.toContain('innerHTML')
    expect(WHM_JOBS_CLIENT_BINDING).not.toContain('fetch(')
  })

  it('stops polling when nothing is running or the page is hidden', async () => {
    const send = routes({ 'GET /api/jobs?': () => ({ jobs: [job({ status: 'succeeded', progress: 100, finishedAt: '2026-10-27T10:05:00.000Z', steps: [] })] }) })
    boot(send); await flush()
    await vi.advanceTimersByTimeAsync(20000); await flush()
    expect(send).toHaveBeenCalledTimes(1)
    const running = routes({ 'GET /api/jobs?': () => ({ jobs: [job()] }) })
    boot(running); await flush()
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(20000); await flush()
    expect(running).toHaveBeenCalledTimes(1)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange')); await flush()
    expect(running).toHaveBeenCalledTimes(2)
  })

  it('explains an unknown outcome and shows the recorded verification', async () => {
    const finished = job({ status: 'failed', progress: 50, finishedAt: '2026-10-27T10:05:00.000Z', failureClass: 'unknown_outcome', error: 'step upgrade exited with code 100 while changing the host; the outcome is unknown',
      steps: [{ id: 'refresh', title: 'Refresh package lists', state: 'succeeded', exitCode: 0 }, { id: 'zone-1', title: 'Check zone {zone}', titleValues: { zone: 'example.com' }, state: 'unknown', exitCode: 100 }],
      verification: { ok: false, detail: { stillUpgradable: 2 } } })
    const send = routes({ 'GET /api/jobs?': () => ({ jobs: [finished] }), [`GET /api/jobs/${ID}/log`]: () => log({ nextOffset: 20, text: 'all of it here.....' }), [`GET /api/jobs/${ID}`]: () => ({ job: finished }) })
    boot(send, undefined, 'ar'); await flush()
    $<HTMLButtonElement>('[data-whm-jobs-select]').click(); await flush()
    expect($('[data-whm-jobs-outcome]').hidden).toBe(false)
    expect($('[data-whm-jobs-failure]').dataset.failureClass).toBe('unknown_outcome')
    expect($('[data-whm-jobs-failure]').textContent).toContain('قد يكون المضيف قد تغيّر جزئيًا')
    expect($('[data-whm-jobs-steps]').textContent).toContain('النتيجة غير معروفة')
    expect($('[data-whm-jobs-steps]').textContent).toContain('100')
    expect($('[data-whm-jobs-steps]').textContent).toContain('تحديث قوائم الحزم')
    expect($('[data-whm-jobs-steps]').textContent).toContain('فحص المنطقة example.com')
    expect($('[data-whm-jobs-verification]').textContent).toBe('لم يؤكد فحص المضيف النتيجة المتوقعة.')
    expect($('[data-whm-jobs-log-status]').textContent).toBe('عرض 20 من 20 بايت.')
    expect($('[data-whm-jobs-verification-detail]').textContent).toContain('"stillUpgradable": 2')
    expect($<HTMLButtonElement>('[data-whm-jobs-cancel]').disabled).toBe(true)
    expect(document.body.textContent).not.toMatch(/[٠-٩۰-۹]/)
  })

  it('cancels only after confirmation and reports the recorded result', async () => {
    let current = job({ status: 'queued', progress: 0, startedAt: null, steps: [{ id: 'refresh', title: 'Refresh package lists', state: 'pending', exitCode: null }] })
    const send = routes({
      'GET /api/jobs?': () => ({ jobs: [current] }), [`GET /api/jobs/${ID}/log`]: () => log({ nextOffset: 20, text: 'queued line' }), [`GET /api/jobs/${ID}`]: () => ({ job: current }),
      [`POST /api/jobs/${ID}/cancel`]: () => { current = { ...current, status: 'cancelled', cancelRequested: true, finishedAt: '2026-10-27T10:01:00.000Z', steps: [{ ...current.steps[0]!, state: 'skipped' }] }; return { job: current } },
    })
    const answers = [false, true]
    const ask = vi.fn(async (_options: Record<string, unknown>) => answers.shift())
    boot(send, ask); await flush()
    $<HTMLButtonElement>('[data-whm-jobs-select]').click(); await flush()
    const cancel = $<HTMLButtonElement>('[data-whm-jobs-cancel]')
    expect(cancel.disabled).toBe(false)
    cancel.click(); await flush()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(send.mock.calls.some(call => call[0] === 'POST')).toBe(false)
    cancel.click(); await flush()
    expect(ask.mock.calls[1]![0]).toMatchObject({ danger: true, body: 'The job has not started. Cancelling it now means none of its steps will run.' })
    expect(send.mock.calls.filter(call => call[0] === 'POST').map(call => call.slice(0, 2))).toEqual([['POST', `/api/jobs/${ID}/cancel`]])
    expect($('[data-whm-jobs-cancel-status]').textContent).toBe('The job was cancelled before it started.')
    expect($('[data-whm-jobs-steps]').textContent).toContain('Did not run')
    expect(cancel.disabled).toBe(true)
  })

  it('reports an unverifiable cancellation without claiming it happened', async () => {
    const send = routes({ 'GET /api/jobs?': () => ({ jobs: [job()] }), [`GET /api/jobs/${ID}/log`]: () => log({ nextOffset: 20 }), [`GET /api/jobs/${ID}`]: () => ({ job: job() }),
      [`POST /api/jobs/${ID}/cancel`]: () => { throw Object.assign(new Error('x'), { status: 503, details: { stateChanged: true, unknownOutcome: true } }) } })
    boot(send, async () => true); await flush()
    $<HTMLButtonElement>('[data-whm-jobs-select]').click(); await flush()
    $<HTMLButtonElement>('[data-whm-jobs-cancel]').click(); await flush()
    expect($('[data-whm-jobs-cancel-status]').dataset.state).toBe('failed')
    expect($('[data-whm-jobs-cancel-status]').textContent).toBe('The cancellation result could not be verified. Refresh the job before acting again.')
  })

  it('opens a job linked by id even when it is not on the first page', async () => {
    window.history.replaceState(null, '', '/whm/jobs?job=' + OTHER)
    const linked = job({ id: OTHER, status: 'succeeded', progress: 100, finishedAt: '2026-10-27T10:05:00.000Z', steps: [] })
    const send = routes({ 'GET /api/jobs?': () => ({ jobs: [job()] }), [`GET /api/jobs/${OTHER}/log`]: () => log({ id: OTHER, nextOffset: 20, text: 'old job' }), [`GET /api/jobs/${OTHER}`]: () => ({ job: linked }) })
    try {
      boot(send); await flush()
      expect($('[data-whm-jobs-field="status"]').textContent).toBe('Succeeded')
      expect($('[data-whm-jobs-log]').textContent).toBe('old job')
      expect($('[data-whm-jobs-select]').getAttribute('aria-pressed')).toBe('false')
    } finally { window.history.replaceState(null, '', '/') }
  })

  it('validates the kind filter locally and shows agent unavailability truthfully', async () => {
    const send = vi.fn<Send>(async () => { throw Object.assign(new Error('down'), { status: 503 }) })
    boot(send); await flush()
    expect($('[data-whm-jobs-status]').dataset.state).toBe('failed')
    expect($('[data-whm-jobs-status]').textContent).toBe('The host agent or its job runner is unavailable. No job state was read.')
    expect($('[data-whm-jobs-rows]').textContent).toBe('No jobs have been read.')
    send.mockClear()
    $<HTMLInputElement>('[data-whm-jobs-kind-filter]').value = 'System Packages'
    $<HTMLFormElement>('[data-whm-jobs-filters]').dispatchEvent(new Event('submit', { cancelable: true })); await flush()
    expect(send).not.toHaveBeenCalled()
    expect($('[data-whm-jobs-kind-filter]').getAttribute('aria-invalid')).toBe('true')
    $<HTMLInputElement>('[data-whm-jobs-kind-filter]').value = 'system.packages'
    $<HTMLSelectElement>('[data-whm-jobs-status-filter]').value = 'failed'
    $<HTMLFormElement>('[data-whm-jobs-filters]').dispatchEvent(new Event('submit', { cancelable: true })); await flush()
    expect(send.mock.calls[0]!.slice(0, 2)).toEqual(['GET', '/api/jobs?status=failed&kindPrefix=system.packages&limit=50'])
  })
})


describe('readable metadata datetime - jobs', () => {
  it.each(['en', 'ar'] as const)('formats list and detail in %s while ISO records, log and verification payloads stay exact', async locale => {
    const machineLog = 'machine log at 2026-10-27T10:00:00.123Z'
    const current = job({ status: 'succeeded', progress: 100, steps: [], createdAt: '2026-10-27T10:00:00.000Z', startedAt: '2026-10-27T10:00:01.123Z', finishedAt: '2026-10-27T10:00:05.450Z', logBytes: machineLog.length, verification: { ok: true, detail: { observedAt: '2026-10-27T10:00:05.450Z' } } })
    const before = JSON.stringify(current)
    const send = routes({ 'GET /api/jobs?': () => ({ jobs: [current] }), [`GET /api/jobs/${ID}/log`]: () => log({ nextOffset: machineLog.length, total: machineLog.length, text: machineLog }), [`GET /api/jobs/${ID}`]: () => ({ job: current }) })
    boot(send, undefined, locale); await flush()
    const cells = $('[data-whm-jobs-rows] tr').querySelectorAll('td')
    expect(cells[5]!.querySelector('bdi[dir="ltr"]')!.textContent).toBe('2026-10-27 10:00 UTC')
    expect(cells[6]!.querySelector('bdi[dir="ltr"]')!.textContent).toBe('2026-10-27 10:00 UTC')
    expect(cells[7]!.querySelector('bdi[dir="ltr"]')!.textContent).toBe('2026-10-27 10:00 UTC')
    $<HTMLButtonElement>('[data-whm-jobs-select]').click(); await flush()
    expect($('[data-whm-jobs-field="created"] bdi[dir="ltr"]').textContent).toBe('2026-10-27 10:00 UTC')
    expect($('[data-whm-jobs-field="started"] bdi[dir="ltr"]').textContent).toBe('2026-10-27 10:00 UTC')
    expect($('[data-whm-jobs-field="finished"] bdi[dir="ltr"]').textContent).toBe('2026-10-27 10:00 UTC')
    expect($('[data-whm-jobs-field="reference"]').textContent).toBe('XP-JOB-2026-000123')
    expect($('[data-whm-jobs-log]').textContent).toBe(machineLog)
    expect($('[data-whm-jobs-verification-detail]').textContent).toContain('2026-10-27T10:00:05.450Z')
    expect(send.mock.calls.every(([method]) => method === 'GET')).toBe(true)
    expect(send).toHaveBeenCalledWith('GET', '/api/jobs/' + ID)
    expect(readJobView(current)).toMatchObject({ createdAt: '2026-10-27T10:00:00.000Z', startedAt: '2026-10-27T10:00:01.123Z', finishedAt: '2026-10-27T10:00:05.450Z' })
    expect(JSON.stringify(current)).toBe(before)
  })
  it.each(['en', 'ar'] as const)('preserves nullable job timestamps and human created time in %s', async locale => {
    const current = job({ status: 'succeeded', progress: 100, steps: [], startedAt: null, finishedAt: null, logBytes: 0 })
    const send = routes({ 'GET /api/jobs?': () => ({ jobs: [current] }), [`GET /api/jobs/${ID}/log`]: () => log({ nextOffset: 0, total: 0, text: '' }), [`GET /api/jobs/${ID}`]: () => ({ job: current }) })
    boot(send, undefined, locale); await flush(); $<HTMLButtonElement>('[data-whm-jobs-select]').click(); await flush()
    expect($('[data-whm-jobs-field="created"] bdi[dir="ltr"]').textContent).toBe('2026-10-27 10:00 UTC')
    expect($('[data-whm-jobs-field="started"]').textContent).toBe(locale === 'ar' ? 'لم تبدأ' : 'Not started')
    expect($('[data-whm-jobs-field="finished"]').textContent).toBe(locale === 'ar' ? 'لم تنتهِ' : 'Not finished')
    expect(readJobView(current).startedAt).toBeNull(); expect(readJobView(current).finishedAt).toBeNull()
    expect(send.mock.calls.every(([method]) => method === 'GET')).toBe(true)
  })
})
