// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderSecWorkspace } from './board-port/sec-workspace.ts'
import { PANEL_ACCESS_CLIENT_BINDING, readPanelAccessView } from './panel-access-client.ts'

type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
const tick = async () => { for (let index = 0; index < 12; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const R = 'a'.repeat(64)
const view = (extra: Record<string, unknown> = {}) => ({
  state: 'saved', gate: { entrance: { path: 'door-2026-x', listeners: ['xwhm'] }, response: { kind: 'not-found', url: null }, basicAuth: null, stopped: [] }, updatedAt: '2026-11-07T10:00:00.000Z', revision: R,
  temporaryLogins: [{ id: 'a'.repeat(16), note: 'support', issuer: 'root', createdAt: '2026-11-07T10:00:00.000Z', expiresAt: '2026-11-07T11:00:00.000Z', usedAt: null, revokedAt: null, state: 'unused' }],
  host: { available: true, origins: { xpanel: 'https://panel.example.com:2083', xwhm: 'https://whm.panel.example.com:2087', xmail: 'https://mail.panel.example.com:2096' }, binding: { ports: { xpanel: 2083, xwhm: 2087, xmail: 2096 }, hosts: { xpanel: null, xwhm: null, xmail: null } }, open: [], trial: null, applying: false, lifecycle: null, certificate: null },
  client: { listener: 'xwhm' }, publicOrigin: 'https://whm.panel.example.com:2087', ...extra })
const root = () => document.querySelector<HTMLElement>('[data-panel-access]')!
const $ = <T extends Element = HTMLElement>(selector: string) => root().querySelector<T>(selector)!
const boot = async (send: Send, ask: (options: Record<string, unknown>) => Promise<unknown> = async () => true, canManage = true) => {
  document.body.innerHTML = renderSecWorkspace({ page: 'panel-access', locale: 'en', canRead: true, canManage })
  ;(window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest = send
  new Function('return ' + PANEL_ACCESS_CLIENT_BINDING)()(ask)
  await tick()
}
afterEach(() => { document.body.innerHTML = '' })

describe('panel access client', () => {
  it('rejects a view outside its shape', () => {
    expect(readPanelAccessView(view()).revision).toBe(R)
    expect(() => readPanelAccessView({ ...view(), revision: 'x' })).toThrow()
    expect(() => readPanelAccessView({ ...view(), temporaryLogins: 'none' })).toThrow()
  })

  it('paints the saved rules and the addresses from the host', async () => {
    await boot(async () => view())
    expect($<HTMLInputElement>('[data-sec-input="pa-entrance-path"]').value).toBe('door-2026-x')
    expect($<HTMLInputElement>('[data-sec-input="pa-entrance-on"]').checked).toBe(true)
    expect($<HTMLInputElement>('[data-sec-input="pa-port-xwhm"]').value).toBe('2087')
    expect($('[data-sec-field="pa-origin-xwhm"]').textContent).toBe('https://whm.panel.example.com:2087')
    expect($('[data-sec-field="pa-entrance-url"]').textContent).toBe('https://whm.panel.example.com:2087/door-2026-x')
    expect($('[data-sec-rows="pa-temporary"]').textContent).toContain('support')
    expect(PANEL_ACCESS_CLIENT_BINDING).not.toContain('innerHTML')
  })

  it('keeps every control locked for a reader who cannot manage', async () => {
    await boot(async () => view(), undefined, false)
    expect($<HTMLButtonElement>('[data-sec-action="pa-gate-save"]').disabled).toBe(true)
    expect($<HTMLInputElement>('[data-sec-input="pa-port-xwhm"]').disabled).toBe(true)
    expect($<HTMLButtonElement>('[data-sec-action="pa-refresh"]').disabled).toBe(false)
  })

  it('sends the saved revision and an empty password to keep the old one', async () => {
    const calls: [string, string, unknown][] = []
    await boot(async (method, path, body) => { calls.push([method, path, body]); return view({ gate: { ...view().gate, basicAuth: { username: 'guard', listeners: ['xwhm'] } } }) })
    $('[data-sec-action="pa-gate-save"]').click()
    await tick()
    const put = calls.find(([method]) => method === 'PUT')!
    expect(put[1]).toBe('/api/server/panel-access/gate')
    expect(put[2]).toMatchObject({ expectedRevision: R, entrance: { path: 'door-2026-x', listeners: ['xwhm'] }, basicAuth: { username: 'guard', password: '', listeners: ['xwhm'] } })
  })

  it('warns before saving an entrance and sends nothing when declined', async () => {
    const send = vi.fn<Send>(async () => view()), ask = vi.fn(async () => false)
    await boot(send, ask)
    $('[data-sec-action="pa-gate-save"]').click()
    await tick()
    expect(String(ask.mock.calls[0]?.[0 as never] ?? '')).toBeDefined()
    expect(send.mock.calls.some(([method]) => method === 'PUT')).toBe(false)
  })

  it('moves the panel and names PORT_IN_USE when refused', async () => {
    const send: Send = async (method, path) => {
      if (method === 'PUT' && path.endsWith('/binding')) throw Object.assign(new Error('x'), { status: 409, code: 'CONFLICT', details: { reason: 'PORT_IN_USE', stateChanged: false } })
      return view()
    }
    await boot(send)
    const port = $<HTMLInputElement>('[data-sec-input="pa-port-xwhm"]')
    port.value = '18888'
    $('[data-sec-action="pa-binding-save"]').click()
    await tick()
    expect($('[data-sec-result]').textContent).toBe('That port is in use on this server. Nothing was changed.')
  })

  it('shows a new link once and offers the waiting change', async () => {
    const send: Send = async (method, path) => method === 'POST' && path.endsWith('/temporary-logins') ? { url: 'https://whm.panel.example.com:2087/login/temporary/token' } : view({ host: { ...view().host, trial: { deadline: '2026-11-07T10:10:00.000Z' } } })
    await boot(send)
    expect($('[data-sec-field="pa-trial"]').textContent).toContain('2026-11-07 10:10')
    $('[data-sec-action="pa-temp-create"]').click()
    await tick()
    expect($('[data-sec-field="pa-temp-url"]').textContent).toBe('https://whm.panel.example.com:2087/login/temporary/token')
  })
})
