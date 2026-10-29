// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACCOUNT_DYNAMIC_DNS_CLIENT_BINDING, readDynamicDnsView } from './account-dynamic-dns-client.ts'
import { renderAccountDynamicDnsWorkspace } from './board-port/account-dynamic-dns-workspace.ts'
const accountId = '11111111-1111-4111-8111-111111111111', id = 'ddns_' + 'a'.repeat(22), password = 'b'.repeat(43), date = '2026-10-27T00:00:00.000Z'
const entry = { id, hostname: 'home.example.com', zone: 'example.com', type: 'A', description: 'Router', createdAt: date, updatedAt: date, lastChangedAt: null, pending: false }
const view = (entries: unknown[] = []) => ({ context: { accountId }, revision: 'a'.repeat(64), entries, zones: [{ name: 'example.com' }], limit: 25 })
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const find = <T extends HTMLElement>(name: string): T => document.querySelector<T>('[data-ddns-' + name + ']')!
const set = (name: string, value: string) => { const input = find<HTMLInputElement>(name); input.value = value; input.dispatchEvent(new Event('input')) }
async function bind(send: (...args: unknown[]) => Promise<unknown>, allowed = true, ar = false) {
  Object.assign(window, { xpanelSessionRequest: send })
  document.documentElement.lang = ar ? 'ar' : 'en'; document.documentElement.dir = ar ? 'rtl' : 'ltr'
  document.body.innerHTML = renderAccountDynamicDnsWorkspace({ lang: ar ? 'ar' : 'en', accountId, canManage: allowed })
  ;(new Function('return ' + ACCOUNT_DYNAMIC_DNS_CLIENT_BINDING)() as (ask: unknown) => void)(undefined)
  await tick()
}
afterEach(() => { document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr'; document.body.replaceChildren(); delete (window as unknown as Record<string, unknown>).xpanelSessionRequest })
describe('dynamic DNS client', () => {
  it('keeps Arabic/English, technical isolation, 8/16/24/32 layout tokens and truthful initial states', () => {
    for (const lang of ['en', 'ar'] as const) {
      const html = renderAccountDynamicDnsWorkspace({ lang, accountId, canManage: true })
      expect(html).toContain('data-ddns-issued hidden'); expect(html).toContain('data-ddns-confirm hidden'); expect(html).toContain('dir="' + (lang === 'ar' ? 'rtl' : 'ltr') + '"')
      expect(html).toContain('<bdi dir="ltr"'); expect(html).not.toMatch(/[٠-٩۰-۹]/); expect(html).not.toContain('<form')
      for (const distance of [8, 16, 24, 32]) expect(html).toContain('gap:' + distance + 'px')
    }
    expect(ACCOUNT_DYNAMIC_DNS_CLIENT_BINDING).not.toContain('innerHTML')
  })
  it('refuses wrong scope, extra fields, secret leaks, wrong issuance id and invalid records', () => {
    expect(readDynamicDnsView(view(), accountId, false).entries).toEqual([])
    for (const raw of [{ ...view(), context: { accountId: 'other' } }, { ...view(), secret: password }, view([{ ...entry, secretHash: 'f'.repeat(64) }]), view([{ ...entry, hostname: '<script>' }]), view([{ ...entry, id: '../bad' }]), view([{ ...entry, description: '<b>bad</b>' }])]) expect(() => readDynamicDnsView(raw, accountId, false)).toThrow()
    expect(() => readDynamicDnsView({ ...view([entry]), issued: { id, secret: password } }, accountId, true, 'ddns_' + 'z'.repeat(22))).toThrow()
    expect(() => readDynamicDnsView({ ...view([entry]), issued: { id, secret: password } }, accountId, false)).toThrow()
  })
  it('keeps disabled views inert without reading credentials', async () => {
    const send = vi.fn(async () => view())
    await bind(send, false)
    expect(send).not.toHaveBeenCalled()
    expect([...document.querySelectorAll<HTMLButtonElement>('button')].every(button => button.disabled)).toBe(true)
  })
  it('creates an owner-scoped credential and removes the one-time secret from DOM when hidden or refreshed', async () => {
    const send = vi.fn(async (method: unknown) => method === 'GET' ? view() : { ...view([entry]), issued: { id, secret: password } })
    await bind(send)
    set('hostname', 'home.example.com'); set('description', 'Router'); find<HTMLButtonElement>('create').click(); await tick()
    expect(send).toHaveBeenLastCalledWith('POST', '/api/account/dynamic-dns', { zone: 'example.com', hostname: 'home.example.com', type: 'A', description: 'Router', expectedRevision: 'a'.repeat(64) })
    expect(find('secret').textContent).toBe(password); expect(find<HTMLElement>('issued').hidden).toBe(false)
    expect(find('rows').textContent).not.toContain(id)
    find<HTMLButtonElement>('hide').click(); expect(find('secret').textContent).toBe(''); expect(find('username').textContent).toBe('')
    find<HTMLButtonElement>('refresh').click(); await tick(); expect(find('secret').textContent).toBe('')
  })
  it('requires exact hostname confirmation for rotate/delete and retains the DNS-record preservation copy', async () => {
    const send = vi.fn(async (method: unknown) => method === 'GET' ? view([entry]) : { ...view([entry]), issued: { id, secret: password } })
    await bind(send, true, true)
    document.querySelector<HTMLButtonElement>('[data-ddns-rows] button')!.click()
    expect(find<HTMLButtonElement>('rotate').disabled).toBe(true)
    set('confirm-name', 'home.example.com'); expect(find<HTMLButtonElement>('rotate').disabled).toBe(false)
    find<HTMLButtonElement>('rotate').click(); await tick()
    expect(send).toHaveBeenLastCalledWith('POST', '/api/account/dynamic-dns/' + id + '/rotate', { expectedRevision: 'a'.repeat(64) })
    expect(find('secret').textContent).toBe(password)
  })
  it('locks uncertain mutations until a successful refresh and never prints arbitrary transport errors', async () => {
    const send = vi.fn(async (method: unknown) => { if (method === 'GET') return view(); throw new Error('SECRET_TRANSPORT_DETAIL') })
    await bind(send); set('hostname', 'home.example.com'); find<HTMLButtonElement>('create').click(); await tick()
    expect(find<HTMLButtonElement>('create').disabled).toBe(true); expect(document.body.textContent).not.toContain('SECRET_TRANSPORT_DETAIL')
    find<HTMLButtonElement>('refresh').click(); await tick(); expect(find<HTMLButtonElement>('create').disabled).toBe(false)
  })
  it('does not show a late secret after the view loses capability', async () => {
    let resolve!: (value: unknown) => void
    const send = vi.fn(async (method: unknown) => method === 'GET' ? view() : new Promise(done => { resolve = done }))
    await bind(send); set('hostname', 'home.example.com'); find<HTMLButtonElement>('create').click(); await tick()
    document.querySelector<HTMLElement>('[data-account-dynamic-dns]')!.dataset.ddnsManage = 'false'
    resolve({ ...view([entry]), issued: { id, secret: password } }); await tick()
    expect(find('secret').textContent).toBe(''); expect(find<HTMLElement>('issued').hidden).toBe(true)
  })
})
describe('readable date closure dynamic DNS', () => {
  for (const ar of [false, true]) it('formats last change without changing raw dates or captured revision in ' + (ar ? 'ar' : 'en'), async () => {
    const source = view([{ ...entry, lastChangedAt: '2026-10-27T09:01:02.123Z' }, { ...entry, id: 'ddns_' + 'c'.repeat(22), hostname: 'other.example.com' }]), before = JSON.stringify(source), send = vi.fn(async () => source)
    await bind(send, true, ar)
    const stamp = document.querySelector('[data-ddns-rows] tr td:nth-child(4) bdi')!
    expect(stamp.textContent).toBe('2026-10-27 09:01 UTC'); expect(stamp.getAttribute('dir')).toBe('ltr')
    expect(document.querySelectorAll('[data-ddns-rows] tr')[1]!.children[3]!.textContent).toBe(ar ? 'لم يُحدّث' : 'Not updated')
    expect(document.querySelector('[data-ddns-rows] tr button')!.getAttribute('aria-label')).toBe((ar ? 'إدارة ' : 'Manage ') + entry.hostname)
    expect(find('count').textContent).toBe(ar ? '2 / 25 اعتمادًا' : '2 / 25 credentials')
    expect(JSON.stringify(source)).toBe(before); expect(readDynamicDnsView(source, accountId, false).entries[0]!.lastChangedAt).toBe('2026-10-27T09:01:02.123Z')
    expect(readDynamicDnsView(source, accountId, false).entries[0]!.createdAt).toBe(date); expect(readDynamicDnsView(source, accountId, false).revision).toBe('a'.repeat(64))
    expect(send.mock.calls).toEqual([['GET', '/api/account/dynamic-dns', undefined]]); expect(find('secret').textContent).toBe(''); expect(document.body.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
})