/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerIpEntry } from '@xpanel/core'
import { renderWhmSurface } from './surfaces/xwhm.ts'
import { BROWSER_REALTIME_SCRIPT } from './ws-client.ts'
import { readWhmIpPool, WHM_IPS_CLIENT_BINDING, whmIpDraft } from './whm-ips-client.ts'
import { renderV2WhmServerIps } from './themes/v2/pages/xwhm/server/ips.ts'
import { translator } from './i18n.ts'

type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
const ip = (patch: Partial<ServerIpEntry> = {}): ServerIpEntry => ({ id: '11111111-1111-4111-8111-111111111111', address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '', ...patch })
const primary = ip(), spare = ip({ id: '22222222-2222-4222-8222-222222222222', address: '2001:db8::20', version: 6, prefixLength: 64, isPrimary: false, ptrHostname: 'spare.example.test' })
const added = ip({ id: '33333333-3333-4333-8333-333333333333', address: '192.0.2.50', role: 'dedicated', isPrimary: false })
const tick = async () => { for (let index = 0; index < 8; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const boot = (send: Send | undefined, ask: (options: Record<string, unknown>) => Promise<unknown> = async () => true, root = true, html?: string) => {
  document.body.innerHTML = html ?? renderWhmSurface({ locale: 'en', activeRoute: '/whm/server/ips', principal: root ? { kind: 'root', id: 'fixture-root', username: 'operator' } : { kind: 'reseller', id: 'fixture-reseller', username: 'reseller' }, ipPool: [primary, spare] })
  if (send) (window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest = send
  new Function('return ' + WHM_IPS_CLIENT_BINDING)()(ask)
}
const fill = (values: Record<string, string>) => { for (const [name, value] of Object.entries(values)) ($('[data-add-ip-form]') as HTMLFormElement).querySelector<HTMLInputElement>(`[name="${name}"]`)!.value = value }
const submit = () => $('[data-add-ip-form]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
afterEach(() => { document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('IP pool helpers', () => {
  it('serializes a closed browser helper graph without SSR import bindings', () => { expect(WHM_IPS_CLIENT_BINDING).not.toContain('__vite_ssr_import_') })
  it('reads only canonical pool entries and builds a root-owned draft', () => {
    expect(readWhmIpPool({ ips: [primary, spare] })).toHaveLength(2)
    for (const bad of [{ ips: [primary, primary] }, { ips: [{ ...primary, ownerId: spare.id }] }, { ips: [{ ...spare, version: 4 }] }, {}]) expect(() => readWhmIpPool(bad)).toThrow()
    expect(whmIpDraft({ address: ' 192.0.2.50 ', prefixLength: '24', role: 'dedicated', ownerKind: 'root', ptrHostname: '' })).toEqual({ address: '192.0.2.50', prefixLength: 24, role: 'dedicated', ownerKind: 'root', ownerId: null, ptrHostname: null })
    expect(() => whmIpDraft({ address: '192.0.2.50', prefixLength: '33', role: 'shared', ownerKind: 'root', ptrHostname: '' })).toThrow()
  })
})

describe('IP pool binding', () => {
  it.each(['classic', 'v2'] as const)('uses selected %s row/pill/action templates and its named count after a verified add', async theme => {
    const html = theme === 'classic' ? undefined : renderV2WhmServerIps(translator('en'), { locale: 'en', activeRoute: '/whm/server/ips', principal: { kind: 'root', id: 'fixture-root', username: 'operator' }, ipPool: [primary, spare] }, { canRead: true, canManage: true })
    let pool = [primary, spare]
    const send = vi.fn<Send>(async method => { if (method === 'POST') { pool = [...pool, added]; return { ip: added, reconcile: null } }; return { ips: pool } })
    boot(send, undefined, true, html)
    fill({ address: '192.0.2.50', prefixLength: '24', role: 'dedicated' }); submit(); await tick()
    const row = document.querySelector<HTMLElement>(`[data-ip-id="${added.id}"]`)!
    expect(row.children).toHaveLength(8)
    expect(row.querySelector('[data-ip-remove]')!.classList.contains(theme === 'v2' ? 'v2-btn' : 'xp-btn')).toBe(true)
    expect(row.querySelector('[data-xp-slot="address"]')?.getAttribute('dir')).toBe('ltr')
    expect(row.querySelector('[data-xp-action="role"]')?.textContent).toBe('dedicated')
    expect($('[data-ip-pool-count-label]').textContent).toBe('3 addresses')
    if (theme === 'v2') expect(row.querySelector('[class*="xp-"]')).toBeNull()
    expect(send.mock.calls.map(call => call[0])).toEqual(['POST', 'GET'])
  })
  it('refuses ambiguous IP markup before a mutation can start', async () => {
    const html = renderV2WhmServerIps(translator('en'), { locale: 'en', activeRoute: '/whm/server/ips', principal: { kind: 'root', id: 'fixture-root', username: 'operator' }, ipPool: [primary, spare] }, { canRead: true, canManage: true })
    const holder = document.createElement('div'); holder.innerHTML = html
    const root = holder.querySelector('[data-whm-ip-pool]')!, template = root.querySelector('template[data-xp-template="whm-ip-row"]')!
    root.append(template.cloneNode(true)); const send = vi.fn<Send>(async () => ({ ips: [primary, spare] }))
    boot(send, undefined, true, holder.innerHTML); fill({ address: '192.0.2.50', prefixLength: '24', role: 'dedicated' }); submit(); await tick()
    expect(send).not.toHaveBeenCalled()
    expect($('[data-add-ip-status]').dataset.state).toBe('unavailable')
    expect($<HTMLButtonElement>('[data-add-ip-form] button[type="submit"]').disabled).toBe(true)
  })
  it('is registered with the page client and keeps controls disabled without root', async () => {
    expect(BROWSER_REALTIME_SCRIPT).toContain(WHM_IPS_CLIENT_BINDING)
    boot(vi.fn<Send>(async () => ({ ips: [] })), undefined, false); await tick()
    expect($<HTMLButtonElement>('[data-add-ip-form] button[type="submit"]').disabled).toBe(true)
    expect($('[data-add-ip-status]').dataset.state).toBe('unavailable')
  })
  it('adds an address through POST /api/ips and shows it only after the pool read-back', async () => {
    let pool = [primary, spare]
    const send = vi.fn<Send>(async (method) => { if (method === 'POST') { pool = [...pool, added]; return { ip: added, reconcile: null } } return { ips: pool } })
    boot(send); await tick()
    expect($<HTMLButtonElement>('[data-add-ip-form] button[type="submit"]').disabled).toBe(false)
    fill({ address: '192.0.2.50', prefixLength: '24', role: 'dedicated' }); submit(); await tick()
    expect(send.mock.calls[0]).toEqual(['POST', '/api/ips', { address: '192.0.2.50', prefixLength: 24, role: 'dedicated', ownerKind: 'root', ownerId: null, ptrHostname: null }])
    expect(send.mock.calls[1]).toEqual(['GET', '/api/ips'])
    expect($('[data-add-ip-status]').dataset.state).toBe('saved')
    expect(document.querySelector(`[data-ip-id="${added.id}"]`)).not.toBeNull()
    expect($('[data-ip-pool-count]').textContent).toContain('3 addresses')
  })
  it('refuses owners the form cannot name, reports a refusal and locks after an uncertain outcome', async () => {
    let mode: 'refuse' | 'unknown' = 'refuse'
    const send = vi.fn<Send>(async (method) => { if (method === 'GET') return { ips: [primary, spare] }; if (mode === 'refuse') throw { status: 409, details: { stateChanged: false } }; throw { status: 503, details: { verificationRequired: true } } })
    boot(send); await tick()
    fill({ address: '192.0.2.50', prefixLength: '24', ownerKind: 'account' }); submit(); await tick()
    expect(send).not.toHaveBeenCalled()
    fill({ ownerKind: 'root' }); submit(); await tick()
    expect($('[data-add-ip-status]').dataset.state).toBe('failed')
    expect($<HTMLButtonElement>('[data-add-ip-form] button[type="submit"]').disabled).toBe(false)
    mode = 'unknown'; submit(); await tick()
    expect($('[data-add-ip-status]').dataset.state).toBe('uncertain')
    expect($<HTMLButtonElement>('[data-add-ip-form] button[type="submit"]').disabled).toBe(true)
    expect($<HTMLButtonElement>(`[data-ip-remove="${spare.id}"]`).disabled).toBe(true)
    expect(send.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(2)
  })
  it('removes a secondary address only after a danger confirmation and verifies its absence', async () => {
    let pool = [primary, spare]
    const ask = vi.fn(async () => true)
    const send = vi.fn<Send>(async (method) => { if (method === 'DELETE') { pool = [primary]; return { ok: true, reconcile: null } } return { ips: pool } })
    boot(send, ask); await tick()
    expect(document.querySelector(`[data-ip-remove="${primary.id}"]`)).toBeNull()
    $(`[data-ip-remove="${spare.id}"]`).click(); await tick()
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ danger: true, body: '2001:db8::20' }))
    expect(send.mock.calls.map(call => call.slice(0, 2))).toEqual([['DELETE', `/api/ips/${spare.id}`], ['GET', '/api/ips']])
    expect(document.querySelector(`[data-ip-id="${spare.id}"]`)).toBeNull()
    expect($('[data-ip-pool-status]').dataset.state).toBe('saved')
  })
})
