// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACCOUNT_LOGS_CLIENT_BINDING, filterAccountLogEntries, readAccountLogsView } from './account-logs-client.ts'
import { renderAccountLogsWorkspace } from './board-port/account-logs-workspace.ts'

const accountId = '11111111-1111-4111-8111-111111111111', domainId = '22222222-2222-4222-8222-222222222222', otherId = '33333333-3333-4333-8333-333333333333'
const domains = [{ id: domainId, accountId, name: 'example.test' }, { id: otherId, accountId: '44444444-4444-4444-8444-444444444444', name: 'other.test' }]
const entry = (status: number, uri: string) => ({ time: '2026-10-27T01:00:0' + (status % 10) + '+00:00', host: 'example.test', ip: '192.0.2.9', method: 'GET', uri, status, bytes: 10, referer: '', agent: 'curl/8' })
const access = (entries = [entry(200, '/'), entry(404, '/missing'), entry(503, '/api')]) => ({ context: { accountId, domainId, domainName: 'example.test', site: 'example.test', kind: 'access' }, file: { exists: true, sizeBytes: 900, mtime: null, truncated: false },
  limits: { maxBytes: 262144, maxLines: 2000, linesDropped: 0 }, observedAt: '2026-10-27T02:00:00.000Z', entries, unparsedLines: 1 })
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
afterEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; document.body.replaceChildren(); document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr' })
async function bind(html: string, request?: (method: string, path: string) => Promise<unknown>) {
  if (request) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  document.body.innerHTML = html
  ;(new Function('return ' + ACCOUNT_LOGS_CLIENT_BINDING)() as (confirm: unknown) => void)(undefined)
  await settle()
}
const $ = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!

describe('account site logs page', () => {
  it('renders owned domains only, bilingual copy, ASCII digits and no form', () => {
    for (const lang of ['en', 'ar'] as const) {
      const html = renderAccountLogsWorkspace({ lang, accountId, domains, kinds: ['access', 'error'] })
      expect(html).toContain('example.test'); expect(html).not.toContain('other.test'); expect(html).not.toContain('<form'); expect(html).not.toMatch(/[٠-٩۰-۹]/)
      expect(html).toContain(`dir="${lang === 'ar' ? 'rtl' : 'ltr'}"`)
    }
    expect(renderAccountLogsWorkspace({ lang: 'ar', accountId, domains, kinds: ['error'] })).toContain('سجل الأخطاء')
    expect(renderAccountLogsWorkspace({ lang: 'en', accountId, domains, kinds: ['error'] })).not.toContain('value="access"')
    expect(ACCOUNT_LOGS_CLIENT_BINDING).not.toContain('innerHTML')
  })
  it('stays inert without a permitted log kind', async () => {
    const request = vi.fn(async () => clone(access()))
    await bind(renderAccountLogsWorkspace({ lang: 'en', accountId, domains, kinds: [] }), request)
    expect([...document.querySelectorAll<HTMLButtonElement | HTMLSelectElement | HTMLInputElement>('button,select,input')].every(control => control.disabled)).toBe(true)
    expect(request).not.toHaveBeenCalled(); expect($('p[data-logs-status]').getAttribute('data-state')).toBe('unavailable')
  })
  it('parses strictly and filters by status class, severity and text, newest first', () => {
    const view = readAccountLogsView(clone(access()), accountId, domainId, 'access')
    expect(filterAccountLogEntries(view, { status: 'all', level: 'all', text: '' }).map(item => (item as { status: number }).status)).toEqual([503, 404, 200])
    expect(filterAccountLogEntries(view, { status: '4', level: 'all', text: '' })).toHaveLength(1); expect(filterAccountLogEntries(view, { status: 'all', level: 'all', text: 'API' })).toHaveLength(1)
    const errors = readAccountLogsView({ ...clone(access()), context: { ...access().context, kind: 'error' }, entries: [{ time: '2026/10/27 01:00:00', level: 'warn', message: 'slow' }, { time: '2026/10/27 01:00:01', level: 'crit', message: 'down' }, { time: null, level: null, message: 'tail' }] }, accountId, domainId, 'error')
    expect(filterAccountLogEntries(errors, { status: 'all', level: 'error', text: '' }).map(item => (item as { message: string }).message)).toEqual(['down'])
    for (const bad of [{ ...access(), context: { ...access().context, domainId: otherId } }, { ...access(), entries: [{ ...entry(200, '/'), uri: 'a\nb' }] }, { ...access(), entries: [{ ...entry(200, '/'), extra: 1 }] }, { ...access(), entries: [{ ...entry(200, '/'), status: 700 }] },
      { ...access(), limits: { maxBytes: 1 << 30, maxLines: 2000, linesDropped: 0 } }, { ...access(), entries: Array.from({ length: 2001 }, () => entry(200, '/')) }])
      expect(() => readAccountLogsView(clone(bad), accountId, domainId, 'access')).toThrow()
    expect(() => readAccountLogsView({ ...clone(access()), context: { ...access().context, kind: 'error' }, entries: [{ time: 'x', level: 'loud', message: 'm' }] }, accountId, domainId, 'error')).toThrow()
  })
  it('reads the selected log on request and renders filtered rows as text', async () => {
    const request = vi.fn(async (_method: string, path: string) => { expect(path).toBe('/api/account/logs/' + domainId + '/access'); return clone(access([entry(200, '/'), entry(500, '/<img src=x>')])) })
    await bind(renderAccountLogsWorkspace({ lang: 'en', accountId, domains, kinds: ['access', 'error'] }), request)
    expect(request).not.toHaveBeenCalled()
    $<HTMLButtonElement>('[data-logs-read]').click(); await settle(); await settle()
    expect(document.querySelectorAll('[data-logs-rows] tr')).toHaveLength(2); expect(document.querySelector('[data-logs-rows] img')).toBeNull(); expect($('[data-logs-rows]').textContent).toContain('/<img src=x>')
    $<HTMLSelectElement>('[data-logs-class]').value = '5'; $('[data-logs-class]').dispatchEvent(new Event('change'))
    expect(document.querySelectorAll('[data-logs-rows] tr')).toHaveLength(1); expect($('[data-logs-summary]').textContent).toContain('1 / 2')
    $<HTMLSelectElement>('[data-logs-kind]').value = 'error'; $('[data-logs-kind]').dispatchEvent(new Event('change'))
    expect(document.querySelectorAll('[data-logs-rows] tr')).toHaveLength(0); expect($('p[data-logs-status]').getAttribute('data-state')).toBe('unread')
    const failing = vi.fn(async () => { throw Object.assign(new Error('nope'), { status: 404 }) })
    document.body.replaceChildren(); await bind(renderAccountLogsWorkspace({ lang: 'en', accountId, domains, kinds: ['access'] }), failing)
    $<HTMLButtonElement>('[data-logs-read]').click(); await settle(); await settle()
    expect($('p[data-logs-status]').getAttribute('data-state')).toBe('failed'); expect($<HTMLButtonElement>('[data-logs-read]').disabled).toBe(false)
  })
})

describe('readable date closure account logs', () => {
  for (const lang of ['en', 'ar'] as const) {
    it('formats observed log metadata while retaining original source time in ' + lang, async () => {
      const source = access(); source.observedAt = '2026-10-27T09:01:02.123Z'; const before = JSON.stringify(source), send = vi.fn(async () => source)
      document.documentElement.lang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr'
      Object.assign(window, { xpanelSessionRequest: send }); document.body.innerHTML = renderAccountLogsWorkspace({ lang, accountId, domains, kinds: ['access'] }); new Function('return ' + ACCOUNT_LOGS_CLIENT_BINDING)()(undefined)
      $<HTMLButtonElement>('[data-logs-read]').click(); await settle(); await settle()
      expect($('[data-logs-status]').textContent).toBe((lang === 'ar' ? 'قُرئ السجل في' : 'Log read at') + ' 2026-10-27 09:01 UTC.')
      expect($('[data-logs-summary]').textContent).toBe(lang === 'ar' ? 'عرض 3 / 3 من إدخالات الموقع example.test · تعذر تحليل سطر واحد' : 'Showing 3 / 3 entries of the site example.test · 1 lines could not be parsed')
      expect($('[data-logs-status] bdi').textContent).toBe('2026-10-27 09:01 UTC'); expect($('[data-logs-status] bdi').getAttribute('dir')).toBe('ltr')
      expect(JSON.stringify(source)).toBe(before); expect(readAccountLogsView(source, accountId, domainId, 'access').observedAt).toBe('2026-10-27T09:01:02.123Z')
      expect(send.mock.calls).toEqual([['GET', '/api/account/logs/' + domainId + '/access']])
    })
    it('formats zoned structured access times without changing raw request data in ' + lang, async () => {
      const source = access([{ ...entry(200, '/2026-10-27T09:01:02.123Z'), time: '2026-10-27T11:01:02.123+02:00', agent: 'raw 2026-10-27T09:01:02.123Z' }, { ...entry(404, '/legacy'), time: 'raw-unzoned' }]); source.observedAt = '2026-10-27T09:01:02.000Z'
      const before = JSON.stringify(source), send = vi.fn(async () => source)
      Object.assign(window, { xpanelSessionRequest: send }); document.body.innerHTML = renderAccountLogsWorkspace({ lang, accountId, domains, kinds: ['access', 'error'] }); new Function('return ' + ACCOUNT_LOGS_CLIENT_BINDING)()(undefined)
      $<HTMLButtonElement>('[data-logs-read]').click(); await settle(); await settle()
      const stamp = document.querySelectorAll('[data-logs-rows] tr')[1]!.querySelector('td:first-child bdi')!
      expect(stamp.textContent).toBe('2026-10-27 09:01 UTC'); expect(stamp.getAttribute('dir')).toBe('ltr')
      expect(document.querySelector('[data-logs-rows] tr td:first-child')?.textContent).toBe('raw-unzoned')
      expect($('[data-logs-rows]').textContent).toContain('raw 2026-10-27T09:01:02.123Z'); expect($('[data-logs-rows]').textContent).toContain('/2026-10-27T09:01:02.123Z')
      expect(JSON.stringify(source)).toBe(before); expect(readAccountLogsView(source, accountId, domainId, 'access').entries[0]!.time).toBe('2026-10-27T11:01:02.123+02:00')
      expect(send.mock.calls).toEqual([['GET', '/api/account/logs/' + domainId + '/access']]); expect(document.body.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
    })
    it('retains unzoned error timestamps, raw messages and continuations exactly in ' + lang, async () => {
      const source = { ...access(), context: { ...access().context, kind: 'error' }, entries: [{ time: '2026/10/27 11:01:02', level: 'error', message: 'raw 2026-10-27T09:01:02.123Z <b>message</b>' }, { time: null, level: null, message: 'continued 2026/10/27 11:01:03' }] }, before = JSON.stringify(source), send = vi.fn(async () => source)
      Object.assign(window, { xpanelSessionRequest: send }); document.body.innerHTML = renderAccountLogsWorkspace({ lang, accountId, domains, kinds: ['error'] }); new Function('return ' + ACCOUNT_LOGS_CLIENT_BINDING)()(undefined)
      $<HTMLButtonElement>('[data-logs-read]').click(); await settle(); await settle()
      const rows = document.querySelectorAll('[data-logs-rows] tr')
      expect(rows[0]!.children[0]!.textContent).toBe('-'); expect(rows[0]!.children[2]!.textContent).toBe('continued 2026/10/27 11:01:03')
      expect(rows[1]!.children[0]!.textContent).toBe('2026/10/27 11:01:02'); expect(rows[1]!.children[2]!.textContent).toBe('raw 2026-10-27T09:01:02.123Z <b>message</b>')
      expect(document.querySelector('[data-logs-rows] b')).toBeNull(); expect(JSON.stringify(source)).toBe(before)
      expect(readAccountLogsView(source, accountId, domainId, 'error').entries[0]!.time).toBe('2026/10/27 11:01:02')
      expect(send.mock.calls).toEqual([['GET', '/api/account/logs/' + domainId + '/error']])
    })
  }
})