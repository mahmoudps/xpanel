// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmWhmcsWorkspace } from './board-port/whm-whmcs-workspace.ts'
import { readWhmcsActivity, readWhmcsView, WHM_WHMCS_CLIENT_BINDING } from './whm-whmcs-client.ts'
import type { WhmcsView } from './whm-whmcs-client.ts'

const R1 = 'a'.repeat(64), R2 = 'b'.repeat(64), R3 = 'c'.repeat(64), STAMP = '2026-10-29T10:00:00.000Z'
const SECRET = 'xpw_' + 'Q'.repeat(39) + 'Zz9_'
const PLANS = [{ id: 'plan-basic', name: 'Basic', accounts: 2 }, { id: 'plan-pro', name: 'Pro', accounts: 1 }]
const defaults = (): WhmcsView => ({ state: 'default', settings: { enabled: false, whmcsUrl: '', allowedAddresses: [], ssoTarget: 'xpanel', autoCreate: false, planMap: [] },
  apiIdentifier: null, token: null, updatedAt: null, revision: R1, plans: PLANS })
const saved = (overrides: Partial<WhmcsView['settings'] & object> = {}, revision = R2): WhmcsView => ({ state: 'saved',
  settings: { enabled: true, whmcsUrl: 'https://billing.example.test', allowedAddresses: ['203.0.113.10'], ssoTarget: 'xwhm', autoCreate: true, planMap: [{ package: 'Starter', planId: 'plan-basic' }], ...overrides },
  apiIdentifier: 'whmcs_0123456789ab', token: { hint: 'Zz9_', createdAt: STAMP }, updatedAt: STAMP, revision, plans: PLANS })
const activity = { entries: [{ at: STAMP, action: 'suspend', username: 'alice', result: 'ok', reason: 'completed', ip: '203.0.113.10' }, { at: STAMP, action: null, username: null, result: 'refused', reason: 'token_invalid', ip: '198.51.100.7' }] }
type Requester = (method: string, path: string, body?: unknown) => Promise<unknown>
type Ask = (options: Record<string, unknown>) => Promise<unknown>
const flush = async () => { for (let index = 0; index < 12; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const $ = <T extends Element = HTMLElement>(selector: string): T => document.querySelector<T>(selector)!
const input = <T extends HTMLElement = HTMLInputElement>(name: string): T => $<T>(`[data-whm-whmcs-input="${name}"]`)
const boot = (send?: Requester, ask: Ask | undefined = async () => true, locale: 'en' | 'ar' = 'en', canManage = true) => {
  document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
  document.body.innerHTML = renderWhmWhmcsWorkspace({ locale, canManage })
  if (send) (window as Window & { xpanelSessionRequest?: Requester }).xpanelSessionRequest = send
  new Function('return ' + WHM_WHMCS_CLIENT_BINDING)()(ask)
}
const router = (routes: Record<string, (body?: unknown) => unknown>) => vi.fn<Requester>(async (method, path, body) => {
  const handler = routes[method + ' ' + path]
  if (!handler) throw Object.assign(new Error('unexpected ' + method + ' ' + path), { status: 500 })
  return handler(body)
})
const submit = () => $<HTMLFormElement>('[data-whm-whmcs-form]').dispatchEvent(new Event('submit', { cancelable: true }))
beforeEach(() => { delete (window as Window & { xpanelSessionRequest?: Requester }).xpanelSessionRequest })
afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals() })

describe('WHMCS page layout', () => {
  it('spaces sibling fields inside the connection fieldset with the field gap, not the group gap', () => {
    const html = renderWhmWhmcsWorkspace({ locale: 'en', canManage: true })
    expect(html).toContain('.xp-whm-whmcs__fieldset{display:flex;flex-direction:column;gap:16px;')
  })
})

describe('WHMCS response parsers', () => {
  it('accepts exact default, saved and invalid views', () => {
    expect(readWhmcsView(defaults())).toEqual(defaults())
    expect(readWhmcsView(saved())).toEqual(saved())
    expect(readWhmcsView({ ...defaults(), state: 'invalid', settings: null })).toMatchObject({ state: 'invalid', settings: null })
  })
  it('rejects secrets, extra fields and contradictions', () => {
    for (const bad of [{ ...saved(), secret: SECRET }, { ...saved(), token: { hint: 'Zz9_', createdAt: STAMP, sha256: R1 } }, { ...defaults(), apiIdentifier: 'whmcs_0123456789ab' },
      { ...saved(), apiIdentifier: null }, { ...defaults(), state: 'invalid' }, { ...saved(), settings: { ...saved().settings, extra: 1 } }, { ...saved(), revision: 'x' },
      { ...saved(), plans: [{ id: 'p', name: 'P', accounts: -1 }] }]) expect(() => readWhmcsView(bad), JSON.stringify(bad)).toThrow()
    expect(readWhmcsActivity(activity)).toHaveLength(2)
    expect(() => readWhmcsActivity({ entries: [{ ...activity.entries[0], password: 'x' }] })).toThrow()
  })
})

describe('WHMCS page controller', () => {
  it('reads nothing without transport or authority and never writes markup strings', async () => {
    boot(); await flush(); expect($('[data-whm-whmcs-status]').dataset.state).toBe('unavailable')
    const send = vi.fn<Requester>(async () => defaults())
    boot(send, undefined, 'en', false); await flush()
    expect(send).not.toHaveBeenCalled()
    expect(input('enabled').disabled).toBe(true)
    expect(WHM_WHMCS_CLIENT_BINDING).not.toContain('innerHTML')
  })
  it('reads settings, plan counts and the activity log', async () => {
    boot(router({ 'GET /api/server/panel/whmcs': () => saved(), 'GET /api/server/panel/whmcs/activity': () => activity })); await flush()
    expect(input('enabled').checked).toBe(true)
    expect(input<HTMLTextAreaElement>('allowedAddresses').value).toBe('203.0.113.10')
    expect($<HTMLInputElement>('[data-whm-whmcs-identifier]').value).toBe('whmcs_0123456789ab')
    expect($('[data-whm-whmcs-plan-accounts]').textContent).toBe('2')
    expect($('[data-whm-whmcs-token] bdi').textContent).toBe('xpw_…Zz9_')
    expect($('[data-whm-whmcs-updated] bdi').textContent).toBe('2026-10-29 10:00 UTC')
    const rows = document.querySelectorAll('[data-whm-whmcs-log-rows] tr')
    expect(rows).toHaveLength(2)
    expect(rows[1]!.textContent).toContain('token_invalid')
  })
  it('saves the captured revision with plan mapping edits and reads back', async () => {
    let gets = 0
    const send = router({ 'GET /api/server/panel/whmcs': () => gets++ === 0 ? saved() : saved({ planMap: [{ package: 'Starter', planId: 'plan-basic' }, { package: 'Pro Plus', planId: 'plan-pro' }] }, R3),
      'PUT /api/server/panel/whmcs': () => saved({ planMap: [{ package: 'Starter', planId: 'plan-basic' }, { package: 'Pro Plus', planId: 'plan-pro' }] }, R3),
      'GET /api/server/panel/whmcs/activity': () => ({ entries: [] }) })
    boot(send); await flush()
    $<HTMLButtonElement>('[data-whm-whmcs-plan-add]').click()
    const last = document.querySelectorAll('[data-whm-whmcs-plan-rows] tr')[1]!
    last.querySelector<HTMLInputElement>('[data-whm-whmcs-plan-package]')!.value = ' Pro Plus '
    const select = last.querySelector<HTMLSelectElement>('[data-whm-whmcs-plan-id]')!; select.value = 'plan-pro'; select.dispatchEvent(new Event('change'))
    expect(last.querySelector('[data-whm-whmcs-plan-accounts]')!.textContent).toBe('1')
    submit(); await flush()
    expect(send.mock.calls.find(([method]) => method === 'PUT')).toEqual(['PUT', '/api/server/panel/whmcs', { enabled: true, whmcsUrl: 'https://billing.example.test', allowedAddresses: ['203.0.113.10'],
      ssoTarget: 'xwhm', autoCreate: true, planMap: [{ package: 'Starter', planId: 'plan-basic' }, { package: 'Pro Plus', planId: 'plan-pro' }], expectedRevision: R2 }])
    expect($('[data-whm-whmcs-save-status]').dataset.state).toBe('read')
  })
  it('refuses to enable without a token and marks a conflict as stale until reload', async () => {
    const send = router({ 'GET /api/server/panel/whmcs': () => defaults(), 'GET /api/server/panel/whmcs/activity': () => ({ entries: [] }),
      'PUT /api/server/panel/whmcs': () => { throw Object.assign(new Error('conflict'), { status: 409 }) } })
    boot(send); await flush()
    input('enabled').checked = true; input('whmcsUrl').value = 'https://billing.example.test'; input<HTMLTextAreaElement>('allowedAddresses').value = '203.0.113.10'
    submit(); await flush()
    expect($('[data-whm-whmcs-save-status]').textContent).toContain('API token')
    expect(send.mock.calls.some(([method]) => method === 'PUT')).toBe(false)
    input('enabled').checked = false; submit(); await flush()
    expect($('[data-whm-whmcs-save-status]').dataset.state).toBe('stale')
    expect($<HTMLButtonElement>('[data-whm-whmcs-save]').disabled).toBe(true)
    $<HTMLButtonElement>('[data-whm-whmcs-reload]').click(); await flush()
    expect($<HTMLButtonElement>('[data-whm-whmcs-save]').disabled).toBe(false)
  })
  it('creates a token only after confirmation, shows it once and verifies the readback', async () => {
    let gets = 0
    const send = router({ 'GET /api/server/panel/whmcs': () => gets++ === 0 ? defaults() : { ...saved({ enabled: false }), revision: R3 },
      'POST /api/server/panel/whmcs/token': () => ({ ...saved({ enabled: false }), revision: R3, secret: SECRET }), 'GET /api/server/panel/whmcs/activity': () => ({ entries: [] }) })
    const ask = vi.fn<Ask>(async () => false)
    boot(send, ask); await flush()
    $<HTMLButtonElement>('[data-whm-whmcs-rotate]').click(); await flush()
    expect(send.mock.calls.some(([method]) => method === 'POST')).toBe(false)
    ask.mockResolvedValue(true)
    $<HTMLButtonElement>('[data-whm-whmcs-rotate]').click(); await flush()
    expect(send.mock.calls.find(([method]) => method === 'POST')).toEqual(['POST', '/api/server/panel/whmcs/token', { expectedRevision: R1 }])
    expect($('[data-whm-whmcs-secret]').textContent).toBe(SECRET)
    expect($<HTMLElement>('[data-whm-whmcs-reveal]').hidden).toBe(false)
    expect($('[data-whm-whmcs-token-status]').dataset.state).toBe('read')
    $<HTMLButtonElement>('[data-whm-whmcs-done]').click()
    expect($('[data-whm-whmcs-secret]').textContent).toBe('')
    expect(document.body.textContent).not.toContain(SECRET)
  })
  it('downloads the module through a session fetch and a blob link', async () => {
    const fetchMock = vi.fn(async () => new Response('<?php', { headers: { 'content-disposition': 'attachment; filename="xpanel.php"' } }))
    vi.stubGlobal('fetch', fetchMock)
    const create = vi.fn(() => 'blob:module'), revoke = vi.fn()
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    boot(router({ 'GET /api/server/panel/whmcs': () => saved(), 'GET /api/server/panel/whmcs/activity': () => ({ entries: [] }) })); await flush()
    $<HTMLButtonElement>('[data-whm-whmcs-download]').click(); await flush()
    expect(fetchMock).toHaveBeenCalledWith('/api/server/panel/whmcs/module', { credentials: 'same-origin', cache: 'no-store' })
    expect(click).toHaveBeenCalledOnce(); expect(revoke).toHaveBeenCalledWith('blob:module')
    expect($('[data-whm-whmcs-download-status]').dataset.state).toBe('read')
    click.mockRestore()
  })
  it('keeps Arabic direction, ASCII digits and states single sign-on honestly', async () => {
    boot(router({ 'GET /api/server/panel/whmcs': () => saved(), 'GET /api/server/panel/whmcs/activity': () => activity }), undefined, 'ar'); await flush()
    expect($('[data-whm-whmcs-workspace]').getAttribute('dir')).toBe('rtl')
    expect(document.body.textContent).not.toMatch(/[٠-٩۰-۹]/)
    expect($('[data-whm-whmcs-updated] bdi').getAttribute('dir')).toBe('ltr')
    boot(undefined, undefined, 'en')
    expect(document.body.textContent).toContain('Single sign-on links are not available in this version.')
    for (const name of ['whmcsUrl', 'allowedAddresses', 'ssoTarget']) expect(document.querySelector(`label[for="${input(name).id}"]`)).not.toBeNull()
  })
})
