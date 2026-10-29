// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACCOUNT_NETWORK_TOOLS_CLIENT_BINDING, readNetworkToolsView } from './account-network-tools-client.ts'
import { renderAccountNetworkToolsWorkspace } from './board-port/account-network-tools-workspace.ts'

const accountId = '11111111-1111-4111-8111-111111111111'
const view = (tool: string, query: Record<string, unknown>, extra: Record<string, unknown>) => ({ context: { accountId, tool }, query, outcome: 'completed', target: { address: '93.184.215.14', family: 4 }, result: null, observedAt: '2026-10-27T02:00:00.000Z', ...extra })
const pingResult = () => ({ transmitted: 4, received: 3, errors: 0, lossPercent: 25, rtt: { minMs: 10, avgMs: 11, maxMs: 12 } })
const ping = () => view('ping', { host: 'example.com' }, { result: pingResult() })
const trace = () => view('traceroute', { host: '93.184.215.14' }, { result: { reached: true, hops: [{ hop: 1, address: null, nonPublic: true, rttMs: 0.3, note: null }, { hop: 2, address: null, nonPublic: false, rttMs: null, note: null }, { hop: 3, address: '93.184.215.14', nonPublic: false, rttMs: 9, note: null }] } })
const dns = () => view('dns', { name: '_dmarc.example.com', type: 'TXT' }, { target: null, result: { status: 'answer', records: ['v=DMARC1; p=reject <b>x</b>'], truncated: false } })
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
afterEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; document.body.replaceChildren() })
async function bind(html: string, request?: (method: string, path: string, body?: unknown) => Promise<unknown>, ar = false) {
  if (request) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  document.body.innerHTML = html
  document.documentElement.lang = ar ? 'ar' : 'en'; document.documentElement.dir = ar ? 'rtl' : 'ltr'
  ;(new Function('return ' + ACCOUNT_NETWORK_TOOLS_CLIENT_BINDING)() as (confirm: unknown) => void)(undefined)
  await settle()
}
const $ = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!
const choose = (selector: string, value: string, event = 'change') => { $<HTMLInputElement | HTMLSelectElement>(selector).value = value; $(selector).dispatchEvent(new Event(event)) }
const runAndSettle = async () => { $<HTMLButtonElement>('[data-nettools-run]').click(); await settle(); await settle() }

describe('account network tools page', () => {
  it('renders bilingual copy, ASCII digits, every tool and no form', () => {
    for (const lang of ['en', 'ar'] as const) {
      const html = renderAccountNetworkToolsWorkspace({ lang, accountId, canManage: true })
      expect(html).toContain(`dir="${lang === 'ar' ? 'rtl' : 'ltr'}"`); expect(html).not.toContain('<form'); expect(html).not.toMatch(/[٠-٩۰-۹]/)
      for (const value of ['dns', 'ping', 'traceroute', 'port', 'CAA']) expect(html).toContain(`value="${value}"`)
    }
    expect(renderAccountNetworkToolsWorkspace({ lang: 'ar', accountId, canManage: true })).toContain('تتبع المسار')
    expect(ACCOUNT_NETWORK_TOOLS_CLIENT_BINDING).not.toContain('innerHTML')
  })
  it('stays inert and private in read-only mode', async () => {
    const request = vi.fn(async () => clone(ping())), html = renderAccountNetworkToolsWorkspace({ lang: 'en', accountId: '', canManage: false })
    expect(html).not.toContain('<form'); expect(html).not.toContain(accountId); expect(html).toContain('data-account=""')
    await bind(html, request)
    expect([...document.querySelectorAll<HTMLButtonElement | HTMLSelectElement | HTMLInputElement>('button,select,input')].every(control => control.disabled)).toBe(true)
    $<HTMLButtonElement>('[data-nettools-run]').click(); await settle()
    expect(request).not.toHaveBeenCalled(); expect($('p[data-nettools-status]').getAttribute('data-state')).toBe('unavailable')
    document.body.replaceChildren(); await bind(`<div data-wiring="soon">${renderAccountNetworkToolsWorkspace({ lang: 'en', accountId, canManage: true })}</div>`, request)
    expect($<HTMLButtonElement>('[data-nettools-run]').disabled).toBe(true); expect(request).not.toHaveBeenCalled()
  })
  it('parses replies strictly against the request just sent', () => {
    expect(readNetworkToolsView(clone(ping()), accountId, 'ping', { host: 'Example.com.' }).result).toMatchObject({ received: 3 })
    expect(readNetworkToolsView(clone(view('ping', { host: '2001:db8::1' }, { target: { address: '2001:db8::1', family: 6 }, result: pingResult() })), accountId, 'ping', { host: '2001:DB8:0::1' }).target).toEqual({ address: '2001:db8::1', family: 6 })
    expect(readNetworkToolsView(clone(dns()), accountId, 'dns', { name: '_dmarc.example.com', type: 'TXT' }).result).toMatchObject({ status: 'answer' })
    for (const [bad, tool, sent] of [[{ ...ping(), context: { accountId, tool: 'traceroute' } }, 'ping', { host: 'example.com' }], [ping(), 'ping', { host: 'other.com' }], [{ ...ping(), extra: 1 }, 'ping', { host: 'example.com' }],
      [{ ...ping(), result: { ...pingResult(), received: 5 } }, 'ping', { host: 'example.com' }], [{ ...ping(), target: { address: '93.184.215.14', family: 6 } }, 'ping', { host: 'example.com' }], [{ ...dns(), result: { status: 'answer', records: ['a\nb'], truncated: false } }, 'dns', { name: '_dmarc.example.com', type: 'TXT' }],
      [{ ...dns(), query: { name: '_dmarc.example.com', type: 'A' } }, 'dns', { name: '_dmarc.example.com', type: 'TXT' }], [{ ...trace(), result: { reached: true, hops: [] } }, 'traceroute', { host: '93.184.215.14' }], [{ ...ping(), outcome: 'refused' }, 'ping', { host: 'example.com' }],
      [view('port', { host: 'example.com', port: 25 }, { result: { state: 'maybe', elapsedMs: 1 } }), 'port', { host: 'example.com', port: 25 }], [view('port', { host: 'example.com', port: 25 }, { result: { state: 'open', elapsedMs: 1 } }), 'port', { host: 'example.com', port: 26 }]] as const)
      expect(() => readNetworkToolsView(clone(bad), accountId, tool, sent as Record<string, string | number>)).toThrow()
  })
  it('runs the chosen tool and renders results as text', async () => {
    const replies: Record<string, unknown> = { ping: ping(), traceroute: trace(), dns: dns(), port: view('port', { host: 'example.com', port: 25 }, { result: { state: 'filtered', elapsedMs: 3001 } }) }
    const request = vi.fn(async (_method: string, path: string) => clone(replies[path.split('/').at(-1)!]))
    await bind(renderAccountNetworkToolsWorkspace({ lang: 'en', accountId, canManage: true }), request)
    expect(request).not.toHaveBeenCalled(); expect($<HTMLElement>('[data-nettools-field="port"]').hidden).toBe(true)
    choose('[data-nettools-host]', '_dmarc.example.com', 'input'); choose('[data-nettools-type]', 'TXT'); await runAndSettle()
    expect(request).toHaveBeenLastCalledWith('POST', '/api/account/network-tools/dns', { name: '_dmarc.example.com', type: 'TXT' })
    expect(document.querySelector('[data-nettools-rows] b')).toBeNull(); expect($('[data-nettools-rows]').textContent).toContain('p=reject <b>x</b>'); expect($('p[data-nettools-status]').getAttribute('data-state')).toBe('read')
    choose('[data-nettools-tool]', 'ping'); expect($<HTMLElement>('[data-nettools-field="type"]').hidden).toBe(true); expect($('p[data-nettools-status]').getAttribute('data-state')).toBe('unread')
    choose('[data-nettools-host]', 'example.com', 'input'); await runAndSettle()
    expect(request).toHaveBeenLastCalledWith('POST', '/api/account/network-tools/ping', { host: 'example.com' }); expect($('[data-nettools-summary]').textContent).toContain('3 / 4'); expect($('[data-nettools-address]').textContent).toBe('93.184.215.14')
    choose('[data-nettools-tool]', 'traceroute'); choose('[data-nettools-host]', '93.184.215.14', 'input'); await runAndSettle()
    expect(document.querySelectorAll('[data-nettools-rows] tr')).toHaveLength(3); expect($('[data-nettools-rows]').textContent).toContain('Private network (hidden)'); expect($('[data-nettools-summary]').textContent).toContain('3 hops')
    choose('[data-nettools-tool]', 'port'); choose('[data-nettools-host]', 'example.com', 'input'); choose('[data-nettools-port]', '70000', 'input'); await runAndSettle()
    expect($('p[data-nettools-status]').getAttribute('data-state')).toBe('invalid'); expect(request).toHaveBeenCalledTimes(3)
    choose('[data-nettools-port]', '25', 'input'); await runAndSettle()
    expect(request).toHaveBeenLastCalledWith('POST', '/api/account/network-tools/port', { host: 'example.com', port: 25 }); expect($('[data-nettools-summary]').textContent).toContain('did not answer within 3 seconds')
  })
  it('explains refusals, rate limits and busy runs without inventing results', async () => {
    let next: () => Promise<unknown> = async () => clone(view('ping', { host: 'intranet.example.com' }, { outcome: 'refused', target: null, result: null }))
    await bind(renderAccountNetworkToolsWorkspace({ lang: 'ar', accountId, canManage: true }), vi.fn(async () => next()), true)
    choose('[data-nettools-tool]', 'ping'); choose('[data-nettools-host]', 'intranet.example.com', 'input'); await runAndSettle()
    expect($('[data-nettools-summary]').textContent).toContain('تُختبر عناوين الإنترنت العامة فقط'); expect($('[data-nettools-address]').textContent).toBe('-')
    for (const [code, text] of [['LIMIT_EXCEEDED', 'في الدقيقة'], ['CONFLICT', 'فحص آخر'], ['VALIDATION', 'اسم نطاق'], ['SERVICE_UNAVAILABLE', 'تعذر تشغيل الفحص']] as const) {
      next = async () => { throw Object.assign(new Error('refused'), { code }) }; await runAndSettle()
      expect($('p[data-nettools-status]').getAttribute('data-state')).toBe('failed'); expect($('p[data-nettools-status]').textContent).toContain(text); expect($('[data-nettools-at]').textContent).toBe('لم يُشغَّل')
      expect($<HTMLButtonElement>('[data-nettools-run]').disabled).toBe(false)
    }
    expect(document.body.textContent).not.toMatch(/[٠-٩۰-۹]/)
  })
})


describe('network diagnostic human completion dates preserve request identity', () => {
  it.each(['en', 'ar'] as const)('shows UTC metadata in %s while retaining raw observation and exact target query', async lang => {
    const rawAt = '2026-10-27T04:00:00.123456+02:00', value = { ...ping(), observedAt: rawAt }, original = JSON.stringify(value)
    expect(readNetworkToolsView(value, accountId, 'ping', { host: 'example.com' }).observedAt).toBe(rawAt)
    const request = vi.fn(async (_method: string, _path: string, _body?: unknown) => value)
    await bind(renderAccountNetworkToolsWorkspace({ lang, accountId, canManage: true }), request, lang === 'ar')
    choose('[data-nettools-tool]', 'ping'); choose('[data-nettools-host]', 'example.com', 'input'); await runAndSettle()
    const fact = $('[data-nettools-at]'), note = $('p[data-nettools-status]')
    expect(fact.textContent).toBe('2026-10-27 02:00 UTC')
    expect(fact.tagName).toBe('BDI'); expect(fact.getAttribute('dir')).toBe('ltr')
    expect(note.querySelector('bdi')?.textContent).toBe('2026-10-27 02:00 UTC')
    expect(note.querySelector('bdi')?.dir).toBe('ltr')
    expect(note.textContent).toBe((lang === 'ar' ? 'انتهى في ' : 'Finished at ') + '2026-10-27 02:00 UTC.')
    expect($('[data-nettools-summary]').textContent).toBe(lang === 'ar' ? 'رد الهدف على 3 / 4 من حزم الاختبار.' : 'The target replied to 3 / 4 probes.')
    expect(request.mock.calls).toEqual([['POST', '/api/account/network-tools/ping', { host: 'example.com' }]])
    expect(JSON.stringify(value)).toBe(original)
  })
})
