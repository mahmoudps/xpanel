// @vitest-environment jsdom
import type { Account } from '@xpanel/core'
import { renderPanelSurface } from './surfaces/xpanel.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderUserMenu } from './chrome.ts'
import { renderWebApp } from './app.ts'
import { translator } from './i18n.ts'
import { renderV2Shell } from './themes/v2/shell/shell.ts'
import { readUiThemePreferencesView, UI_THEME_CLIENT_BINDING, type UiThemePreferencesView } from './ui-theme-client.ts'

type Requester = (method: string, path: string, body?: unknown) => Promise<unknown>
type Theme = 'classic' | 'v2'
const REVISION = 'a'.repeat(64), SAVED_REVISION = 'b'.repeat(64), STAMP = '2026-10-29T20:00:00.000Z'
const initial = (overrides: Partial<UiThemePreferencesView> = {}): UiThemePreferencesView => ({
  state: 'default', uiTheme: 'classic', choices: ['classic', 'v2'], revision: REVISION, updatedAt: null,
  application: 'next_navigation', ...overrides,
})
const saved = (overrides: Partial<UiThemePreferencesView> = {}): UiThemePreferencesView => initial({
  state: 'saved', uiTheme: 'v2', revision: SAVED_REVISION, updatedAt: STAMP, ...overrides,
})
const settle = async () => { for (let index = 0; index < 16; index++) await Promise.resolve() }
const $ = <T extends Element = HTMLElement>(selector: string): T => document.querySelector<T>(selector)!
const controller = (): ((reload?: () => void) => void) => new Function('return ' + UI_THEME_CLIENT_BINDING)()
const menu = (theme: Theme, signedIn = true, locale: 'en' | 'ar' = 'en'): string => theme === 'classic'
  ? renderUserMenu({ locale, theme: 'dark', density: 'compact', path: '/home', signedIn, username: 'alice', surface: 'xpanel' })
  : renderV2Shell(translator(locale), { surface: 'xpanel', activeRoute: '/home', homeHref: '/home', realtimeEnabled: false,
    languages: [], scheme: { current: 'dark', toggleHref: '/home?theme=light' }, account: { signedIn, username: 'alice' }, contentHtml: '<h1>Account</h1>' })
const mount = (request?: Requester, theme: Theme = 'classic', reload: () => void = vi.fn(), locale: 'en' | 'ar' = 'en') => {
  document.documentElement.lang = locale
  document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
  document.body.innerHTML = menu(theme, true, locale)
  if (request) (window as Window & { xpanelSessionRequest?: Requester }).xpanelSessionRequest = request
  controller()(reload)
  return reload
}
const selectTheme = (value = 'v2') => {
  const select = $<HTMLSelectElement>('[data-ui-theme-choice]')
  select.value = value
  select.dispatchEvent(new Event('change'))
}
const submit = () => $<HTMLFormElement>('[data-ui-theme-form]').dispatchEvent(new Event('submit', { cancelable: true }))

beforeEach(() => {
  delete (window as Window & { xpanelSessionRequest?: Requester }).xpanelSessionRequest
  window.history.replaceState(null, '', '/mail/compose?lang=ar&theme=light&density=compact&accountId=account#draft')
})
afterEach(() => { document.body.replaceChildren() })

describe('personal UI theme response', () => {
  it('accepts exact default, saved and corrupt-record views', () => {
    for (const value of [initial(), saved(), initial({ state: 'invalid', uiTheme: null })]) expect(readUiThemePreferencesView(value)).toEqual(value)
  })
  it('rejects unexpected identity fields, invalid registry choices and contradictory state', () => {
    for (const value of [
      { ...initial(), owner: 'private' }, { ...initial(), choices: [] }, { ...initial(), choices: ['classic', 'classic'] },
      { ...initial(), choices: ['CLASSIC'] }, { ...initial(), uiTheme: 'missing' }, { ...initial(), revision: 'bad' },
      { ...initial(), application: 'applied' }, { ...initial(), updatedAt: STAMP }, { ...saved(), updatedAt: 'today' },
      { ...initial(), state: 'invalid' }, { ...initial(), state: 'invalid', uiTheme: null, updatedAt: STAMP },
    ]) expect(() => readUiThemePreferencesView(value)).toThrow('invalid_ui_preferences')
  })
})

describe('personal UI theme chooser', () => {
  it.each([
    ['xpanel', '/resources', { kind: 'user', id: 'u1', username: 'alice', accountId: 'a1' }],
    ['xwhm', '/whm/accounts', { kind: 'root', id: 'root1', username: 'administrator' }],
    ['xmail', '/mail/compose', { kind: 'user', id: 'u1', username: 'alice', accountId: 'a1' }],
  ] as const)('keeps personal choices independent from unqualified %s operations', async (surface, route, principal) => {
    document.documentElement.lang = 'en'
    document.documentElement.dir = 'ltr'
    document.body.innerHTML = renderWebApp({ surface, activeRoute: route, locale: 'en', catalog: [], visibility: { principal } })
    const workspace = $('[data-tool-availability="unverified"]')
    const form = $<HTMLFormElement>('form[data-ui-theme-form]')
    expect(workspace).not.toBeNull()
    expect(form).not.toBeNull()
    expect(workspace.contains(form)).toBe(false)
    expect($<HTMLSelectElement>('[data-ui-theme-choice]').disabled).toBe(true)
    let reads = 0
    const request = vi.fn<Requester>(async method => method === 'PUT' || reads++ > 0 ? saved() : initial())
    ;(window as Window & { xpanelSessionRequest?: Requester }).xpanelSessionRequest = request
    const reload = vi.fn()
    controller()(reload)
    await settle()
    expect($<HTMLSelectElement>('[data-ui-theme-choice]').disabled).toBe(false)
    selectTheme(); submit(); await settle()
    expect(request.mock.calls).toEqual([
      ['GET', '/api/auth/ui-preferences'],
      ['PUT', '/api/auth/ui-preferences', { uiTheme: 'v2', expectedRevision: REVISION }],
      ['GET', '/api/auth/ui-preferences'],
    ])
    expect($('[data-ui-theme-status]').dataset.state).toBe('verified')
    expect(reload).toHaveBeenCalledOnce()
  })


  it.each<Theme>(['classic', 'v2'])('keeps the %s chooser hidden when only classic is actually registered', async theme => {
    const request = vi.fn<Requester>(async () => initial({ choices: ['classic'] }))
    const reload = mount(request, theme)
    await settle()
    expect($<HTMLElement>('[data-ui-theme-preferences]').hidden).toBe(true)
    expect($<HTMLSelectElement>('[data-ui-theme-choice]').options.length).toBe(1)
    expect($<HTMLSelectElement>('[data-ui-theme-choice]').disabled).toBe(true)
    selectTheme(); submit(); await settle()
    expect(request.mock.calls).toEqual([['GET', '/api/auth/ui-preferences']])
    expect(reload).not.toHaveBeenCalled()
  })
  it.each<Theme>(['classic', 'v2'])('saves from the %s menu and reloads the unchanged navigation only after independent readback', async theme => {
    let reads = 0
    const request = vi.fn<Requester>(async method => method === 'PUT' || reads++ > 0 ? saved() : initial())
    const href = window.location.href, reload = mount(request, theme)
    await settle()
    expect($<HTMLElement>('[data-ui-theme-preferences]').hidden).toBe(false)
    expect($<HTMLButtonElement>('[data-ui-theme-save]').disabled).toBe(true)
    selectTheme(); submit(); await settle()
    expect(request.mock.calls).toEqual([
      ['GET', '/api/auth/ui-preferences'], ['PUT', '/api/auth/ui-preferences', { uiTheme: 'v2', expectedRevision: REVISION }],
      ['GET', '/api/auth/ui-preferences'],
    ])
    expect($('[data-ui-theme-status]').dataset.state).toBe('verified')
    expect(reload).toHaveBeenCalledOnce()
    expect(window.location.href).toBe(href)
    expect(window.location.search).not.toContain('uiTheme')
  })
  it('does not read anonymous markup, missing transport, a denied chooser or malformed controls', async () => {
    const request = vi.fn<Requester>(async () => initial())
    document.body.innerHTML = menu('classic', false)
    ;(window as Window & { xpanelSessionRequest?: Requester }).xpanelSessionRequest = request
    controller()(); await settle()
    expect(document.querySelector('[data-ui-theme-preferences]')).toBeNull()
    expect(request).not.toHaveBeenCalled()
    delete (window as Window & { xpanelSessionRequest?: Requester }).xpanelSessionRequest
    mount(); await settle()
    expect($<HTMLSelectElement>('[data-ui-theme-choice]').disabled).toBe(true)
    document.body.innerHTML = menu('classic')
    $('[data-ui-theme-preferences]').dataset.uiThemeCanRead = 'false'
    ;(window as Window & { xpanelSessionRequest?: Requester }).xpanelSessionRequest = request
    controller()(); await settle(); expect(request).not.toHaveBeenCalled()
    document.body.innerHTML = menu('classic')
    $('[data-ui-theme-form]').append($('[data-ui-theme-choice]').cloneNode(true))
    controller()(); await settle(); expect(request).not.toHaveBeenCalled()
  })
  it('binds once and suppresses duplicate submits while a write is pending', async () => {
    let complete!: (value: unknown) => void
    const request = vi.fn<Requester>(async method => method === 'GET' ? initial() : new Promise(resolve => { complete = resolve }))
    const reload = mount(request)
    await settle(); controller()(reload); selectTheme(); submit(); submit(); await settle()
    expect(request.mock.calls.filter(([method]) => method === 'GET')).toHaveLength(1)
    expect(request.mock.calls.filter(([method]) => method === 'PUT')).toHaveLength(1)
    expect($<HTMLSelectElement>('[data-ui-theme-choice]').disabled).toBe(true)
    complete(saved()); await settle()
    expect(reload).not.toHaveBeenCalled()
  })
  it('keeps a corrupt saved record read-only and does not overwrite it', async () => {
    const request = vi.fn<Requester>(async () => initial({ state: 'invalid', uiTheme: null }))
    const reload = mount(request)
    await settle(); selectTheme(); submit(); await settle()
    expect($('[data-ui-theme-status]').dataset.state).toBe('failed')
    expect($<HTMLButtonElement>('[data-ui-theme-save]').disabled).toBe(true)
    expect(request).toHaveBeenCalledOnce()
    expect(reload).not.toHaveBeenCalled()
  })
  it('does not invent presentation for a new server choice the theme cannot label', async () => {
    const request = vi.fn<Requester>(async () => initial({ choices: ['classic', 'v2', 'unknown'] }))
    const reload = mount(request)
    await settle(); selectTheme(); submit(); await settle()
    expect($('[data-ui-theme-status]').dataset.state).toBe('failed')
    expect($<HTMLFormElement>('[data-ui-theme-form]').hidden).toBe(true)
    expect(request).toHaveBeenCalledOnce()
    expect(reload).not.toHaveBeenCalled()
  })
  it('reads a handed-off session choice but never submits a permanent change', async () => {
    const request = vi.fn<Requester>(async () => initial())
    document.body.innerHTML = '<aside data-impersonation></aside>' + menu('classic')
    ;(window as Window & { xpanelSessionRequest?: Requester }).xpanelSessionRequest = request
    const reload = vi.fn(); controller()(reload)
    await settle(); selectTheme(); submit(); await settle()
    expect($('[data-ui-theme-status]').dataset.state).toBe('readonly')
    expect($<HTMLSelectElement>('[data-ui-theme-choice]').disabled).toBe(true)
    expect(request.mock.calls).toEqual([['GET', '/api/auth/ui-preferences']])
    expect(reload).not.toHaveBeenCalled()
  })
  it.each([409, 401, 403, 503])('locks an uncertain or refused %s save until an explicit fresh read', async status => {
    const request = vi.fn<Requester>(async method => {
      if (method === 'GET') return initial()
      throw Object.assign(new Error('refused'), { status, ...(status === 503 ? { details: { unknownOutcome: true, stateChanged: true } } : {}) })
    })
    const reload = mount(request)
    await settle(); selectTheme(); submit(); await settle(); submit(); await settle()
    expect($('[data-ui-theme-status]').dataset.state).toBe('failed')
    if (status === 403) expect($('[data-ui-theme-status]').textContent).toContain('unavailable for this session')
    expect($<HTMLButtonElement>('[data-ui-theme-save]').disabled).toBe(true)
    expect(request.mock.calls.filter(([method]) => method === 'PUT')).toHaveLength(1)
    expect(reload).not.toHaveBeenCalled()
    $<HTMLButtonElement>('[data-ui-theme-reload]').click(); await settle()
    expect($<HTMLSelectElement>('[data-ui-theme-choice]').disabled).toBe(false)
  })
  it.each(['ack', 'revision', 'theme', 'timestamp', 'choices'])('does not reload after mismatched %s evidence', async mismatch => {
    let reads = 0
    const request = vi.fn<Requester>(async method => {
      if (method === 'PUT') return mismatch === 'ack' ? saved({ uiTheme: 'classic' }) : saved()
      if (reads++ === 0) return initial()
      return saved({ ...(mismatch === 'revision' ? { revision: 'c'.repeat(64) } : {}),
        ...(mismatch === 'theme' ? { uiTheme: 'classic' } : {}), ...(mismatch === 'timestamp' ? { updatedAt: '2026-10-29T20:01:00.000Z' } : {}),
        ...(mismatch === 'choices' ? { choices: ['v2', 'classic'] } : {}) })
    })
    const reload = mount(request)
    await settle(); selectTheme(); submit(); await settle()
    expect($('[data-ui-theme-status]').dataset.state).toBe('failed')
    expect($<HTMLButtonElement>('[data-ui-theme-save]').disabled).toBe(true)
    expect(reload).not.toHaveBeenCalled()
  })
  it('waits for readback before applying an acknowledged choice', async () => {
    let reads = 0, complete!: (value: unknown) => void
    const request = vi.fn<Requester>(async method => method === 'PUT' ? saved() : reads++ === 0 ? initial() : new Promise(resolve => { complete = resolve }))
    const reload = mount(request)
    await settle(); selectTheme(); submit(); await settle()
    expect(reload).not.toHaveBeenCalled()
    expect($('[data-ui-theme-status]').dataset.state).toBe('saving')
    complete(saved()); await settle()
    expect(reload).toHaveBeenCalledOnce()
  })
  it('does not apply a response to a removed document or replaced session transport', async () => {
    let finish!: (value: unknown) => void
    const request = vi.fn<Requester>(async method => method === 'PUT' ? new Promise(resolve => { finish = resolve }) : initial())
    const reload = mount(request)
    await settle(); selectTheme(); submit(); await settle()
    ;(window as Window & { xpanelSessionRequest?: Requester }).xpanelSessionRequest = async () => saved()
    finish(saved()); await settle()
    expect(reload).not.toHaveBeenCalled()
    expect(request.mock.calls).toHaveLength(2)
    document.body.replaceChildren()
    expect(reload).not.toHaveBeenCalled()
  })
  it('keeps verified-save feedback when browser navigation itself is unavailable', async () => {
    let reads = 0
    const request = vi.fn<Requester>(async method => method === 'PUT' || reads++ > 0 ? saved() : initial())
    const reload = vi.fn(() => { throw new Error('navigation unavailable') })
    mount(request, 'classic', reload)
    await settle(); selectTheme(); submit(); await settle()
    expect($('[data-ui-theme-status]').dataset.state).toBe('verified')
    expect($('[data-ui-theme-status]').textContent).toContain('Reload this page to apply it.')
    expect(reload).toHaveBeenCalledOnce()
  })
  it('keeps both theme labels and current document direction separate from color scheme preferences', async () => {
    const request = vi.fn<Requester>(async () => initial())
    mount(request, 'classic', vi.fn(), 'ar')
    await settle()
    expect(document.documentElement.dir).toBe('rtl')
    expect($('[data-ui-theme-preferences]').textContent).not.toMatch(/[٠-٩۰-۹]/)
    expect(UI_THEME_CLIENT_BINDING).not.toMatch(/localStorage|document\.cookie|fetch\(|\.className|\.style\./)
    expect(document.querySelector('[data-theme-toggle="light"]')).not.toBeNull()
    expect($<HTMLSelectElement>('[data-ui-theme-choice]').name).toBe('uiTheme')
  })
})


describe('responsive Home personal interface owners', () => {
  beforeEach(() => { document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr' })
  const homeAccount: Account = {
    id: 'home-interface-account', username: 'browserowner', uid: 20014, gid: 20014, home: '/home/browserowner',
    primaryDomain: 'home.example.test', planId: 'home-plan', ownerId: null, status: 'active', suspendReason: null,
    contactEmail: 'owner@home.example.test', ipv4: '192.0.2.10', ipv6: null, shell: 'none', createdAt: '2026-10-31T05:00:00.000Z',
  }
  const home = (): string => renderPanelSurface({
    account: homeAccount, activeRoute: '/home', locale: 'en', theme: 'dark', density: 'compact',
    visibility: { principal: { kind: 'user', id: 'home-interface-owner', username: homeAccount.username, accountId: homeAccount.id } },
  })
  const ownerControls = (instanceId: 'xp-home-desktop' | 'xp-home-phone') => {
    const select = document.getElementById(instanceId + '-ui-theme-choice')
    if (!(select instanceof HTMLSelectElement)) throw new Error('Missing owned Home interface choice')
    const owner = select.closest<HTMLElement>('[data-ui-theme-preferences]')
    if (!owner) throw new Error('Missing Home interface owner')
    const form = owner.querySelector<HTMLFormElement>('form[data-ui-theme-form]')
    const status = owner.querySelector<HTMLElement>('[data-ui-theme-status]')
    if (!form || !status) throw new Error('Missing owned Home interface controls')
    return { select, owner, form, status }
  }

  it.each(['xp-home-desktop', 'xp-home-phone'] as const)('binds %s once and submits only that owner with CAS and independent readback', { tags: ['feature'] }, async instanceId => {
    document.body.innerHTML = home()
    let reads = 0
    const request = vi.fn<Requester>(async method => method === 'PUT' || reads++ >= 2 ? saved() : initial())
    ;(window as Window & { xpanelSessionRequest?: Requester }).xpanelSessionRequest = request
    const reload = vi.fn(), bind = controller()
    bind(reload); await settle()
    expect(request.mock.calls).toEqual([['GET', '/api/auth/ui-preferences'], ['GET', '/api/auth/ui-preferences']])
    bind(reload); await settle()
    expect(request.mock.calls).toHaveLength(2)
    const selected = ownerControls(instanceId)
    const other = ownerControls(instanceId === 'xp-home-desktop' ? 'xp-home-phone' : 'xp-home-desktop')
    expect(selected.select.disabled).toBe(false)
    expect(other.select.disabled).toBe(false)
    selected.select.value = 'v2'
    selected.select.dispatchEvent(new Event('change'))
    selected.form.dispatchEvent(new Event('submit', { cancelable: true }))
    await settle()
    expect(request.mock.calls).toEqual([
      ['GET', '/api/auth/ui-preferences'], ['GET', '/api/auth/ui-preferences'],
      ['PUT', '/api/auth/ui-preferences', { uiTheme: 'v2', expectedRevision: REVISION }],
      ['GET', '/api/auth/ui-preferences'],
    ])
    expect(selected.status.dataset.state).toBe('verified')
    expect(other.select.value).toBe('classic')
    expect(other.status.dataset.state).not.toBe('verified')
    expect(reload).toHaveBeenCalledOnce()
  })

  it('keeps both handed-off Home preference owners read-only without a PUT', { tags: ['feature'] }, async () => {
    document.body.innerHTML = '<aside data-impersonation>Handed-off session</aside>' + home()
    const request = vi.fn<Requester>(async () => initial())
    ;(window as Window & { xpanelSessionRequest?: Requester }).xpanelSessionRequest = request
    const reload = vi.fn()
    controller()(reload); await settle()
    for (const instanceId of ['xp-home-desktop', 'xp-home-phone'] as const) {
      const controls = ownerControls(instanceId)
      expect(controls.select.disabled).toBe(true)
      controls.select.value = 'v2'
      controls.select.dispatchEvent(new Event('change'))
      controls.form.dispatchEvent(new Event('submit', { cancelable: true }))
      expect(controls.status.dataset.state).toBe('readonly')
    }
    await settle()
    expect(request.mock.calls).toEqual([['GET', '/api/auth/ui-preferences'], ['GET', '/api/auth/ui-preferences']])
    expect(reload).not.toHaveBeenCalled()
  })

  it('keeps both owners disabled when the normal session transport is absent', { tags: ['feature'] }, () => {
    document.body.innerHTML = home()
    controller()(vi.fn())
    for (const instanceId of ['xp-home-desktop', 'xp-home-phone'] as const) {
      const controls = ownerControls(instanceId)
      expect(controls.select.disabled).toBe(true)
      expect(controls.owner.hidden).toBe(true)
    }
  })
})
