/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_REALTIME_SCRIPT } from './ws-client.ts'
type Request = (method: string, path: string, body?: unknown) => Promise<unknown>
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
let listeners: [EventTarget, string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined][]
beforeEach(() => {
  listeners = []
  for (const target of [window, document]) {
    const add = target.addEventListener.bind(target)
    vi.spyOn(target, 'addEventListener').mockImplementation((name, callback, options) => { listeners.push([target, name, callback, options]); add(name, callback, options) })
  }
  document.documentElement.lang = 'en'; document.documentElement.dataset.realtimeEnabled = 'false'
})
afterEach(() => { for (const [target, name, callback, options] of listeners) target.removeEventListener(name, callback, options); document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: Request }).xpanelSessionRequest; vi.restoreAllMocks() })
const boot = (send: Request, attributes = '') => {
  document.body.innerHTML = '<section data-whm-dns-workspace ' + attributes + '><section data-dns-editor><select data-dns-zone></select><table><tbody data-dns-records></tbody></table><p data-dns-status></p><input data-dns-new-name><select data-dns-account><option value="internal-account-one">Alpha account</option></select><button data-dns-add-record>Add record</button><button data-dns-add-zone>Add zone</button><button data-dns-save>Save</button><button data-dns-delete>Delete</button></section><table><tbody data-whm-dns-zone-rows><tr><td colspan="5">Not read</td></tr></tbody></table><span data-whm-dns-zone-count>Not read</span><dd data-whm-dns-soa-serial>Not read</dd><p data-provider-health>Not read</p></section>'
  ;(window as Window & { xpanelSessionRequest?: Request }).xpanelSessionRequest = send
  new Function('window', 'document', BROWSER_REALTIME_SCRIPT)(window, document)
}
describe('authorized DNS read-only summary', () => {
  it('projects only returned zones using public account labels and serials without provider claims', async () => {
    const zones = [{ name: 'alpha.example.test', accountId: 'internal-account-one', serial: 2026102501, records: [{ id: 'record-one', type: 'A', name: '@', ttl: 300, content: '192.0.2.10', priority: null }] }, { name: '<img src=x>', accountId: 'unmapped-private-account-id', serial: 2026102502, records: [] }]
    const send = vi.fn<Request>().mockResolvedValue({ zones }); boot(send); await tick()
    const rows = Array.from(document.querySelectorAll('[data-whm-dns-zone-rows] tr'), row => Array.from(row.querySelectorAll('td'), cell => cell.textContent))
    expect(rows).toEqual([['alpha.example.test', 'Alpha account', '1', '2026102501', 'Not read'], ['<img src=x>', 'Not read', '0', '2026102502', 'Not read']])
    expect(document.querySelector('img')).toBeNull(); expect(document.querySelector('[data-whm-dns-zone-rows]')!.textContent).not.toContain('unmapped-private-account-id')
    expect(document.querySelector('[data-whm-dns-zone-count]')!.textContent).toBe('2'); expect(document.querySelector('[data-whm-dns-soa-serial]')!.textContent).toBe('2026102501')
    const select = document.querySelector<HTMLSelectElement>('[data-dns-zone]')!; select.value = zones[1]!.name; select.dispatchEvent(new Event('change'))
    expect(document.querySelector('[data-whm-dns-soa-serial]')!.textContent).toBe('2026102502'); expect(document.querySelector('[data-provider-health]')!.textContent).toBe('Not read')
    expect(send.mock.calls).toEqual([['GET', '/api/dns/zones']])
  })
  it('keeps unread values after a failed or malformed read', async () => {
    const send = vi.fn<Request>().mockResolvedValue({ zones: [{ name: 'missing-records', serial: 1 }] }); boot(send); await tick()
    expect(document.querySelector('[data-whm-dns-zone-count]')!.textContent).toBe('Not read'); expect(document.querySelector('[data-whm-dns-soa-serial]')!.textContent).toBe('Not read'); expect(document.querySelector('[data-whm-dns-zone-rows]')!.textContent).toBe('Not read')
  })
  it('represents an actually read empty collection without inventing provider health', async () => {
    const send = vi.fn<Request>().mockResolvedValue({ zones: [] }); boot(send); await tick()
    expect(document.querySelector('[data-whm-dns-zone-count]')!.textContent).toBe('0'); expect(document.querySelector('[data-whm-dns-zone-rows]')!.textContent).toContain('no DNS zones'); expect(document.querySelector('[data-whm-dns-soa-serial]')!.textContent).toBe('Not read')
  })
  it('does not read or wire an explicitly unavailable workspace', async () => {
    const send = vi.fn<Request>(); boot(send, 'data-capability-unavailable="true"'); await tick()
    document.querySelector<HTMLButtonElement>('[data-dns-save]')!.click(); expect(send).not.toHaveBeenCalled()
  })
})
