// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmWhmcsWorkspace } from './board-port/whm-whmcs-workspace.ts'
import { renderV2WhmWhmcs } from './themes/v2/pages/xwhm/panel/whmcs.ts'
import { translator } from './i18n.ts'
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


type WhmcsTheme = 'classic' | 'v2'
const WHMCS_PROTOTYPES = ['whm-whmcs-remove', 'whm-whmcs-result-ok', 'whm-whmcs-result-refused', 'whm-whmcs-result-failed'] as const
const WHMCS_FAULTS = ['missing', 'duplicate', 'wrong-root', 'missing-slot', 'duplicate-slot', 'wrong-slot-tag'] as const
const mountWhmcsTheme = (theme: WhmcsTheme, locale: 'en' | 'ar' = 'en', canManage = true): void => {
  document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
  document.body.innerHTML = theme === 'classic' ? renderWhmWhmcsWorkspace({ locale, canManage }) : renderV2WhmWhmcs(translator(locale), { locale, activeRoute: '/whm/panel/whmcs', principal: { kind: 'root', id: 'fixture-root', username: 'operator' } }, { canRead: canManage, canManage })
}
const startWhmcs = (send: Requester, ask: Ask = async () => true): void => {
  ;(window as Window & { xpanelSessionRequest?: Requester }).xpanelSessionRequest = send
  new Function('return ' + WHM_WHMCS_CLIENT_BINDING)()(ask)
}
const whmcsPrototype = (name: string): HTMLTemplateElement => document.querySelector<HTMLTemplateElement>('template[data-xp-template="' + name + '"]')!
const damageWhmcsPrototype = (name: typeof WHMCS_PROTOTYPES[number], fault: typeof WHMCS_FAULTS[number]): void => {
  const template = whmcsPrototype(name); expect(template).not.toBeNull()
  const root = template.content.firstElementChild as HTMLElement, slot = template.content.querySelector<HTMLElement>('[data-xp-slot="content"]')!
  if (fault === 'missing') { template.remove(); return }
  if (fault === 'duplicate') { template.after(template.cloneNode(true)); return }
  if (fault === 'wrong-root') { root.replaceWith(document.createElement(name === 'whm-whmcs-remove' ? 'span' : 'button')); return }
  if (fault === 'missing-slot') slot.removeAttribute('data-xp-slot')
  if (fault === 'duplicate-slot') root.append(slot.cloneNode(true))
  if (fault === 'wrong-slot-tag') { slot.removeAttribute('data-xp-slot'); const wrong = document.createElement(name === 'whm-whmcs-remove' ? 'span' : 'div'); wrong.dataset.xpSlot = 'content'; root.append(wrong) }
}
const issuedTokenRouter = (): ReturnType<typeof router> => {
  let gets = 0
  return router({ 'GET /api/server/panel/whmcs': () => gets++ === 0 ? defaults() : saved({ enabled: false }, R3), 'GET /api/server/panel/whmcs/activity': () => ({ entries: [] }), 'POST /api/server/panel/whmcs/token': () => ({ ...saved({ enabled: false }, R3), secret: SECRET }) })
}

describe.each(['classic', 'v2'] as const)('%s complete WHMCS theme prototypes', theme => {
  it.each(['en', 'ar'] as const)('preserves %s theme buttons, all result badges and revision-bound save readback', async locale => {
    mountWhmcsTheme(theme, locale)
    const prototype = whmcsPrototype('whm-whmcs-remove').content.firstElementChild as HTMLButtonElement
    expect(prototype.type).toBe('button'); expect(prototype.disabled).toBe(true)
    let current = saved()
    const entries = [...activity.entries, { at: STAMP, action: 'create', username: 'bob', result: 'failed', reason: 'failed', ip: '203.0.113.10' }]
    const send = router({ 'GET /api/server/panel/whmcs': () => current, 'GET /api/server/panel/whmcs/activity': () => ({ entries }), 'PUT /api/server/panel/whmcs': body => {
      const { expectedRevision: _revision, ...values } = body as NonNullable<WhmcsView['settings']> & { expectedRevision: string }
      current = saved(values, R3); return current
    } })
    startWhmcs(send); await flush()
    const remove = $<HTMLButtonElement>('[data-whm-whmcs-plan-rows] button')
    expect(remove.type).toBe('button'); expect(remove.disabled).toBe(false); expect(prototype.disabled).toBe(true)
    expect(remove.className).toBe(prototype.className); expect(remove.textContent).toBe(translator(locale)('Remove'))
    expect(remove.getAttribute('aria-label')).toBe(translator(locale)('Remove mapping, row {index}', { index: 1 }))
    const rows = [...document.querySelectorAll('[data-whm-whmcs-log-rows] tr')]
    for (const [index, result] of (['ok', 'refused', 'failed'] as const).entries()) {
      const badge = rows[index]!.querySelector('td:nth-child(4) > span > span')!
      const authored = whmcsPrototype('whm-whmcs-result-' + result).content.firstElementChild!
      expect(badge.className).toBe(authored.className)
      expect(badge.textContent).toBe(translator(locale)({ ok: 'Completed', refused: 'Refused', failed: 'Failed' }[result]!))
      if (theme === 'v2') { expect(badge.classList.contains('xp-badge')).toBe(false); expect(badge.querySelector('[aria-hidden="true"]')).not.toBeNull() }
    }
    remove.click(); expect(document.querySelectorAll('[data-whm-whmcs-plan-package]')).toHaveLength(0)
    expect(send.mock.calls.every(([method]) => method === 'GET')).toBe(true)
    $<HTMLButtonElement>('[data-whm-whmcs-plan-add]').click()
    $<HTMLInputElement>('[data-whm-whmcs-plan-package]').value = ' Pro Plus '
    $<HTMLSelectElement>('[data-whm-whmcs-plan-id]').value = 'plan-pro'
    submit(); await flush()
    expect(send.mock.calls.find(([method]) => method === 'PUT')).toEqual(['PUT', '/api/server/panel/whmcs', { enabled: true, whmcsUrl: 'https://billing.example.test', allowedAddresses: ['203.0.113.10'], ssoTarget: 'xwhm', autoCreate: true, planMap: [{ package: 'Pro Plus', planId: 'plan-pro' }], expectedRevision: R2 }])
    expect(send.mock.calls.at(-1)).toEqual(['GET', '/api/server/panel/whmcs'])
    expect($('[data-whm-whmcs-save-status]').dataset.state).toBe('read'); expect(document.body.textContent).not.toContain(SECRET)
    expect(document.body.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
  it.each(WHMCS_PROTOTYPES.flatMap(name => WHMCS_FAULTS.map(fault => ({ name, fault }))))('blocks every startup request for $name $fault', async ({ name, fault }) => {
    mountWhmcsTheme(theme); damageWhmcsPrototype(name, fault)
    const send = vi.fn<Requester>(async () => saved()), ask = vi.fn<Ask>(async () => true)
    startWhmcs(send, ask); await flush()
    expect(send).not.toHaveBeenCalled(); expect(ask).not.toHaveBeenCalled()
    expect($('[data-whm-whmcs-status]').dataset.state).toBe('unavailable')
    expect([...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('input,select,textarea,button')].every(control => control.disabled)).toBe(true)
    expect($('[data-whm-whmcs-secret]').textContent).toBe('')
  })
  it.each(['enabled', 'submit'] as const)('refuses a natively unsafe %s remove prototype', async fault => {
    mountWhmcsTheme(theme)
    const button = whmcsPrototype('whm-whmcs-remove').content.firstElementChild as HTMLButtonElement
    if (fault === 'enabled') button.disabled = false; else button.type = 'submit'
    const send = vi.fn<Requester>(async () => saved()); startWhmcs(send); await flush(); expect(send).not.toHaveBeenCalled()
  })
  it('keeps a denied renderer inert even when its save button is forced enabled', async () => {
    mountWhmcsTheme(theme, 'en', false)
    const send = vi.fn<Requester>(async () => saved()); startWhmcs(send); await flush()
    $<HTMLButtonElement>('[data-whm-whmcs-save]').disabled = false; submit(); await flush()
    expect(send).not.toHaveBeenCalled(); expect($('[data-whm-whmcs-status]').dataset.state).toBe('unavailable')
  })
  it.each(['resolved', 'rejected'] as const)('blocks activity and stale painting after prototype loss during a %s settings read', async settlement => {
    mountWhmcsTheme(theme)
    let resolve!: (value: unknown) => void, reject!: (error: Error) => void
    const send = vi.fn<Requester>(() => new Promise<unknown>((yes, no) => { resolve = yes; reject = no }))
    startWhmcs(send); await flush(); expect(send).toHaveBeenCalledOnce()
    whmcsPrototype('whm-whmcs-result-failed').remove()
    if (settlement === 'resolved') resolve(saved()); else reject(new Error('unavailable'))
    await flush(); expect(send).toHaveBeenCalledOnce(); expect($('[data-whm-whmcs-status]').dataset.state).toBe('unavailable')
    expect($<HTMLInputElement>('[data-whm-whmcs-identifier]').value).toBe('')
  })
  it('does not remove a captured mapping after another finite prototype is lost', async () => {
    mountWhmcsTheme(theme); const send = router({ 'GET /api/server/panel/whmcs': () => saved(), 'GET /api/server/panel/whmcs/activity': () => activity })
    startWhmcs(send); await flush(); whmcsPrototype('whm-whmcs-result-failed').remove()
    $<HTMLButtonElement>('[data-whm-whmcs-plan-rows] button').click()
    expect(document.querySelectorAll('[data-whm-whmcs-plan-package]')).toHaveLength(1)
    expect(send.mock.calls).toHaveLength(2); expect($<HTMLButtonElement>('[data-whm-whmcs-save]').disabled).toBe(true)
  })
  it.each(['resolved', 'rejected'] as const)('keeps a %s PUT unverified and sends no readback after template loss', async settlement => {
    mountWhmcsTheme(theme)
    let resolve!: (value: unknown) => void, reject!: (error: Error) => void
    const send = router({ 'GET /api/server/panel/whmcs': () => saved(), 'GET /api/server/panel/whmcs/activity': () => ({ entries: [] }), 'PUT /api/server/panel/whmcs': () => new Promise<unknown>((yes, no) => { resolve = yes; reject = no }) })
    startWhmcs(send); await flush(); submit(); await flush(); whmcsPrototype('whm-whmcs-result-failed').remove()
    if (settlement === 'resolved') resolve(saved({}, R3)); else reject(new Error('transport failed'))
    await flush()
    expect(send.mock.calls.map(([method]) => method)).toEqual(['GET', 'GET', 'PUT'])
    expect($('[data-whm-whmcs-save-status]').textContent).toContain('could not be verified')
    expect($('[data-whm-whmcs-save-status]').textContent).not.toContain('were not saved')
    expect($<HTMLButtonElement>('[data-whm-whmcs-save]').disabled).toBe(true)
  })
  it.each(['template', 'authority'] as const)('blocks token creation when %s disappears during confirmation', async fault => {
    mountWhmcsTheme(theme)
    let confirm!: (value: unknown) => void
    const ask: Ask = () => new Promise(yes => { confirm = yes })
    const send = router({ 'GET /api/server/panel/whmcs': () => defaults(), 'GET /api/server/panel/whmcs/activity': () => ({ entries: [] }) })
    startWhmcs(send, ask); await flush(); $<HTMLButtonElement>('[data-whm-whmcs-rotate]').click(); await flush()
    if (fault === 'template') whmcsPrototype('whm-whmcs-result-failed').remove(); else $('[data-whm-whmcs-workspace]').dataset.whmcsCanManage = 'false'
    confirm(true); await flush()
    expect(send.mock.calls.every(([method]) => method === 'GET')).toBe(true)
    expect($('[data-whm-whmcs-secret]').textContent).toBe(''); expect($('[data-whm-whmcs-reveal]').hidden).toBe(true)
  })
  it('never exposes an issued token after template loss during POST', async () => {
    mountWhmcsTheme(theme)
    let resolve!: (value: unknown) => void
    const send = router({ 'GET /api/server/panel/whmcs': () => defaults(), 'GET /api/server/panel/whmcs/activity': () => ({ entries: [] }), 'POST /api/server/panel/whmcs/token': () => new Promise<unknown>(yes => { resolve = yes }) })
    startWhmcs(send); await flush(); $<HTMLButtonElement>('[data-whm-whmcs-rotate]').click(); await flush(); whmcsPrototype('whm-whmcs-remove').remove()
    resolve({ ...saved({ enabled: false }, R3), secret: SECRET }); await flush()
    expect(send.mock.calls.map(([method]) => method)).toEqual(['GET', 'GET', 'POST'])
    expect(document.body.textContent).not.toContain(SECRET); expect($('[data-whm-whmcs-reveal]').hidden).toBe(true)
    expect($('[data-whm-whmcs-token-status]').textContent).toContain('could not be verified')
  })
  it('clears a legitimately revealed token if the readback loses a prototype', async () => {
    mountWhmcsTheme(theme)
    let gets = 0, resolve!: (value: unknown) => void
    const send = router({ 'GET /api/server/panel/whmcs': () => gets++ === 0 ? defaults() : new Promise<unknown>(yes => { resolve = yes }), 'GET /api/server/panel/whmcs/activity': () => ({ entries: [] }), 'POST /api/server/panel/whmcs/token': () => ({ ...saved({ enabled: false }, R3), secret: SECRET }) })
    startWhmcs(send); await flush(); $<HTMLButtonElement>('[data-whm-whmcs-rotate]').click(); await flush()
    expect($('[data-whm-whmcs-secret]').textContent).toBe(SECRET)
    whmcsPrototype('whm-whmcs-result-refused').remove(); resolve(saved({ enabled: false }, R3)); await flush()
    expect($('[data-whm-whmcs-secret]').textContent).toBe(''); expect($('[data-whm-whmcs-reveal]').hidden).toBe(true)
    expect($('[data-whm-whmcs-token-status]').textContent).toContain('could not be verified')
  })
  it('sends no native download after template loss while reading the module blob', async () => {
    mountWhmcsTheme(theme)
    let resolve!: (value: Blob) => void
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, headers: new Headers({ 'content-disposition': 'attachment; filename="xpanel.php"' }), blob: () => new Promise<Blob>(yes => { resolve = yes }) }))
    vi.stubGlobal('fetch', fetchMock)
    const create = vi.fn(() => 'blob:module'), revoke = vi.fn(); Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    try {
      startWhmcs(router({ 'GET /api/server/panel/whmcs': () => saved(), 'GET /api/server/panel/whmcs/activity': () => ({ entries: [] }) })); await flush()
      $<HTMLButtonElement>('[data-whm-whmcs-download]').click(); await flush(); whmcsPrototype('whm-whmcs-result-failed').remove(); resolve(new Blob(['module'])); await flush()
      expect(fetchMock).toHaveBeenCalledWith('/api/server/panel/whmcs/module', { credentials: 'same-origin', cache: 'no-store' })
      expect(create).not.toHaveBeenCalled(); expect(revoke).not.toHaveBeenCalled(); expect(click).not.toHaveBeenCalled()
      expect($('[data-whm-whmcs-download-status]').textContent).toContain('could not be verified')
    } finally { click.mockRestore() }
  })
  it('hides the credential and reports no copied success after prototype loss during clipboard acknowledgement', async () => {
    mountWhmcsTheme(theme)
    let resolve!: () => void
    const writeText = vi.fn(() => new Promise<void>(yes => { resolve = yes })); vi.stubGlobal('navigator', { clipboard: { writeText } })
    startWhmcs(issuedTokenRouter()); await flush(); $<HTMLButtonElement>('[data-whm-whmcs-rotate]').click(); await flush()
    expect($('[data-whm-whmcs-secret]').textContent).toBe(SECRET)
    $<HTMLButtonElement>('[data-whm-whmcs-copy]').click(); await flush(); expect(writeText).toHaveBeenCalledWith(SECRET)
    whmcsPrototype('whm-whmcs-remove').remove(); resolve(); await flush()
    expect($('[data-whm-whmcs-secret]').textContent).toBe(''); expect($('[data-whm-whmcs-reveal]').hidden).toBe(true)
    expect($('[data-whm-whmcs-copy-status]').hidden).toBe(true)
    $<HTMLButtonElement>('[data-whm-whmcs-copy]').disabled = false; $<HTMLButtonElement>('[data-whm-whmcs-copy]').click(); expect(writeText).toHaveBeenCalledOnce()
  })
})
