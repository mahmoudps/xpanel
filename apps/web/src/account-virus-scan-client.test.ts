// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACCOUNT_VIRUS_SCAN_CLIENT_BINDING, readAccountVirusScanView } from './account-virus-scan-client.ts'
import { renderAccountVirusScanWorkspace } from './board-port/account-virus-scan-workspace.ts'

const accountId = '11111111-1111-4111-8111-111111111111', JOB = '00000001-0000-4000-8000-000000000000', NEW = '00000002-0000-4000-8000-000000000000'
const scan = (extra: Record<string, unknown> = {}) => ({ jobId: JOB, status: 'succeeded', result: 'infected', createdAt: '2026-10-27T11:00:00.000Z', finishedAt: '2026-10-27T11:01:00.000Z', listComplete: true,
  summary: { knownViruses: 1, engineVersion: '1.0.7', scannedDirectories: 2, scannedFiles: 312, infectedFiles: 1, dataScanned: '1 MB', time: '1 sec' }, infected: [{ path: 'public_html/<img src=x>.php', signature: 'Php.Webshell-1' }], ...extra })
const view = (extra: Record<string, unknown> = {}) => ({ context: { accountId, username: 'alice' }, observedAt: '2026-10-27T12:00:00.000Z', jobsAvailable: true,
  engine: { state: 'read', version: '1.0.7', signatureVersion: 27440, signatureDate: 'Mon Oct 26 08:21:44 2026' }, limits: { history: 10, cooldownMinutes: 15, findingsPerScan: 50 },
  start: { allowed: true, reason: null, availableAt: null }, scans: [scan()], started: null, ...extra })
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
afterEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; document.body.replaceChildren(); document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr' })
async function bind(html: string, request?: (method: string, path: string, body?: unknown) => Promise<unknown>, ar = false) {
  if (request) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  document.documentElement.lang = ar ? 'ar' : 'en'; document.documentElement.dir = ar ? 'rtl' : 'ltr'
  document.body.innerHTML = html
  ;(new Function('return ' + ACCOUNT_VIRUS_SCAN_CLIENT_BINDING)() as (confirm: unknown) => void)(undefined)
  await settle(); await settle()
}
const $ = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!

describe('account virus scanner page', () => {
  it('renders bilingual markup with the quarantine note, ASCII digits and no form', () => {
    for (const lang of ['en', 'ar'] as const) {
      const html = renderAccountVirusScanWorkspace({ lang, accountId, canManage: true })
      expect(html).toContain(`dir="${lang === 'ar' ? 'rtl' : 'ltr'}"`); expect(html).not.toMatch(/[٠-٩۰-۹]/); expect(html).not.toContain('<form')
      for (const part of ['data-vscan-start', 'data-vscan-refresh', 'data-vscan-rows', 'data-vscan-status', 'data-vscan-next', 'href="/files/manager"']) expect(html).toContain(part)
    }
    expect(renderAccountVirusScanWorkspace({ lang: 'en', accountId, canManage: true })).toContain('Quarantine and automatic deletion are not available')
    expect(renderAccountVirusScanWorkspace({ lang: 'ar', accountId, canManage: true })).toContain('العزل والحذف التلقائي غير متاحين')
    expect(ACCOUNT_VIRUS_SCAN_CLIENT_BINDING).not.toContain('innerHTML')
  })
  it('keeps the read-only page inert: no account id, every control disabled, nothing requested', async () => {
    const html = renderAccountVirusScanWorkspace({ lang: 'en', accountId: '', canManage: false })
    expect(html).not.toContain('href="/files/manager"'); expect(html).toContain('data-account=""')
    const request = vi.fn(async () => clone(view()))
    await bind(html, request)
    expect(request).not.toHaveBeenCalled(); expect([...document.querySelectorAll<HTMLButtonElement>('button')].every(control => control.disabled)).toBe(true)
    expect($('[data-vscan-status]').getAttribute('data-state')).toBe('unavailable')
  })
  it('strictly rejects foreign, absolute-path or inconsistent replies', () => {
    expect(readAccountVirusScanView(clone(view()), accountId).scans[0]).toMatchObject({ result: 'infected', scannedFiles: 312, infectedFiles: 1 })
    for (const bad of [{ ...view(), context: { accountId: '22222222-2222-4222-8222-222222222222', username: 'bob' } }, { ...view(), scans: [scan({ infected: [{ path: '/home/alice/x', signature: 'A' }] })] },
      { ...view(), scans: [scan({ infected: [{ path: '../bob/x', signature: 'A' }] })] }, { ...view(), start: { allowed: false, reason: 'cooldown', availableAt: null } }, { ...view(), start: { allowed: true, reason: 'scan_active', availableAt: null } },
      { ...view(), scans: [scan({ result: 'maybe' })] }, { ...view(), limits: { history: 100, cooldownMinutes: 15, findingsPerScan: 50 } }, { ...view(), started: { jobId: NEW } }])
      expect(() => readAccountVirusScanView(clone(bad), accountId)).toThrow()
    expect(() => readAccountVirusScanView(clone(view()), accountId, true)).toThrow()
  })
  it('reads on bind, renders findings as text, starts a scan and locks while one is active', async () => {
    const queued = scan({ jobId: NEW, status: 'queued', result: 'pending', finishedAt: null, summary: null, infected: [], listComplete: false })
    const request = vi.fn(async (method: string, path: string, body?: unknown) => {
      expect(path).toBe('/api/account/virus-scan')
      return method === 'GET' ? clone(view()) : (expect(body).toEqual({}), clone(view({ start: { allowed: false, reason: 'scan_active', availableAt: null }, scans: [queued, scan()], started: { jobId: NEW } })))
    })
    await bind(renderAccountVirusScanWorkspace({ lang: 'en', accountId, canManage: true }), request)
    expect(request).toHaveBeenCalledWith('GET', '/api/account/virus-scan')
    expect($('[data-vscan-signatures]').textContent).toBe('27440'); expect($('[data-vscan-next]').textContent).toBe('Available now')
    expect(document.querySelector('[data-vscan-rows] img')).toBeNull(); expect($('[data-vscan-rows]').textContent).toContain('~/public_html/<img src=x>.php')
    expect($('[data-vscan-rows] [data-state-chip="problem"]').textContent).toBe('Infected files found')
    $<HTMLButtonElement>('[data-vscan-start]').click(); await settle(); await settle()
    expect(request).toHaveBeenLastCalledWith('POST', '/api/account/virus-scan', {}); expect($('[data-vscan-status]').getAttribute('data-state')).toBe('started')
    expect($<HTMLButtonElement>('[data-vscan-start]').disabled).toBe(true); expect($('[data-vscan-next]').textContent).toBe('After the current scan finishes')
  })
  it.each(['en', 'ar'] as const)('preserves complete scanner instants in %s without starting a job', async locale => {
    const createdAt = '2026-10-27T10:11:12.345Z', observedAt = '2026-10-27T12:13:14.567Z', availableAt = '2026-10-27T12:28:14.567Z'
    const request = vi.fn(async () => clone(view({ observedAt, start: { allowed: false, reason: 'cooldown', availableAt }, scans: [scan({ createdAt })] })))
    await bind(renderAccountVirusScanWorkspace({ lang: locale, accountId, canManage: true }), request, locale === 'ar')
    expect($('[data-vscan-rows] tr:first-child td:first-child bdi[dir="ltr"]').textContent).toBe('2026-10-27 10:11 UTC')
    expect($('[data-vscan-next]').textContent).toBe((locale === 'ar' ? 'بعد ' : 'After ') + '2026-10-27 12:28 UTC')
    expect($('[data-vscan-next] bdi[dir="ltr"]').textContent).toBe('2026-10-27 12:28 UTC')
    expect($('[data-vscan-status]').textContent).toBe((locale === 'ar' ? 'قُرئ في ' : 'Read at ') + '2026-10-27 12:13 UTC.')
    expect($('[data-vscan-status] bdi[dir="ltr"]').textContent).toBe('2026-10-27 12:13 UTC')
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('GET', '/api/account/virus-scan')
    expect($<HTMLButtonElement>('[data-vscan-start]').disabled).toBe(true)
    expect(document.body.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
  it('shows the cooldown and blocks a retry after an unconfirmed start until refreshed', async () => {
    let fail: unknown = Object.assign(new Error('x'), { status: 503, details: { unknownOutcome: true } })
    const request = vi.fn(async (method: string) => { if (method === 'POST') throw fail; return clone(view()) })
    await bind(renderAccountVirusScanWorkspace({ lang: 'en', accountId, canManage: true }), request)
    $<HTMLButtonElement>('[data-vscan-start]').click(); await settle(); await settle()
    expect($('[data-vscan-status]').getAttribute('data-state')).toBe('uncertain'); expect($<HTMLButtonElement>('[data-vscan-start]').disabled).toBe(true)
    $<HTMLButtonElement>('[data-vscan-refresh]').click(); await settle(); await settle()
    expect($<HTMLButtonElement>('[data-vscan-start]').disabled).toBe(false)
    fail = Object.assign(new Error('x'), { status: 422, details: { stateChanged: false, reason: 'cooldown' } })
    $<HTMLButtonElement>('[data-vscan-start]').click(); await settle(); await settle()
    expect($('[data-vscan-status]').getAttribute('data-state')).toBe('refused'); expect($<HTMLButtonElement>('[data-vscan-start]').disabled).toBe(false)
    document.body.replaceChildren()
    await bind(renderAccountVirusScanWorkspace({ lang: 'en', accountId, canManage: true }), async () => clone(view({ start: { allowed: false, reason: 'cooldown', availableAt: '2026-10-27T12:10:00.000Z' }, scans: [] })))
    expect($('[data-vscan-next]').textContent).toBe('After 2026-10-27 12:10 UTC'); expect($<HTMLButtonElement>('[data-vscan-start]').disabled).toBe(true)
    expect($('[data-vscan-rows]').textContent).toContain('No scans have been started')
  })
})
