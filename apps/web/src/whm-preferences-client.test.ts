// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmPreferencesWorkspace } from './board-port/whm-preferences-workspace.ts'
import { readAdminPreferencesView, WHM_PREFERENCES_CLIENT_BINDING } from './whm-preferences-client.ts'
import type { AdminPreferencesView } from './whm-preferences-client.ts'

const R1 = 'a'.repeat(64), R2 = 'b'.repeat(64), STAMP = '2026-10-27T12:00:00.000Z'
const defaults = (): AdminPreferencesView => ({ state: 'default', preferences: { language: 'en', theme: 'light', density: 'comfortable' }, updatedAt: null, revision: R1, application: 'next_navigation' })
const saved = (): AdminPreferencesView => ({ state: 'saved', preferences: { language: 'ar', theme: 'dark', density: 'compact' }, updatedAt: STAMP, revision: R2, application: 'next_navigation' })
type Requester = (method: string, path: string, body?: unknown) => Promise<unknown>
const flush = async () => { for (let index = 0; index < 10; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const $ = <T extends Element = HTMLElement>(selector: string): T => document.querySelector<T>(selector)!
const choice = (name: string): HTMLSelectElement => $(`[data-whm-preferences-input="${name}"]`)
const boot = (send?: Requester, locale: 'en' | 'ar' = 'en', canManage = true, parentUnavailable = false) => {
  document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
  const html = renderWhmPreferencesWorkspace({ locale, canManage })
  document.body.innerHTML = parentUnavailable ? `<div data-readonly="true">${html}</div>` : html
  if (send) (window as Window & { xpanelSessionRequest?: Requester }).xpanelSessionRequest = send
  new Function('return ' + WHM_PREFERENCES_CLIENT_BINDING)()()
}
const submit = () => $<HTMLFormElement>('[data-whm-preferences-form]').dispatchEvent(new Event('submit', { cancelable: true }))
const desired = () => { choice('language').value = 'ar'; choice('theme').value = 'dark'; choice('density').value = 'compact' }
beforeEach(() => { delete (window as Window & { xpanelSessionRequest?: Requester }).xpanelSessionRequest })
afterEach(() => { document.body.innerHTML = '' })

describe('administrator preferences response parser', () => {
  it('accepts exact default, saved and unavailable views', () => {
    expect(readAdminPreferencesView(defaults())).toEqual(defaults())
    expect(readAdminPreferencesView(saved())).toEqual(saved())
    expect(readAdminPreferencesView({ ...defaults(), state: 'invalid', preferences: null })).toMatchObject({ state: 'invalid', preferences: null })
  })
  it('rejects unexpected fields, invalid choices, timestamps and state contradictions', () => {
    for (const invalid of [
      { ...defaults(), principalId: 'private' }, { ...defaults(), application: 'applied' }, { ...defaults(), revision: 'bad' },
      { ...defaults(), state: 'saved' }, { ...saved(), updatedAt: 'today' }, { ...defaults(), state: 'invalid' },
      { ...defaults(), preferences: { ...defaults().preferences, theme: 'dark' } },
      { ...saved(), preferences: { ...saved().preferences, language: 'fr' } }, { ...saved(), preferences: { ...saved().preferences, scope: 'all' } },
    ]) expect(() => readAdminPreferencesView(invalid)).toThrow()
  })
})

describe('administrator preferences client', () => {
  it('does not read without transport, admission or in a read-only parent', async () => {
    boot(); await flush(); expect($('[data-whm-preferences-status]').dataset.state).toBe('unavailable')
    const send = vi.fn<Requester>(async () => defaults())
    boot(send, 'en', false); await flush(); expect(send).not.toHaveBeenCalled()
    boot(send, 'en', true, true); await flush(); expect(send).not.toHaveBeenCalled()
    expect($<HTMLButtonElement>('[data-whm-preferences-save]').disabled).toBe(true)
    expect(WHM_PREFERENCES_CLIENT_BINDING).not.toContain('innerHTML')
    expect(WHM_PREFERENCES_CLIENT_BINDING).not.toContain('fetch(')
  })
  it('reads defaults, saves the captured revision, independently reads back, and offers a clean apply URL', async () => {
    let getCount = 0
    const send = vi.fn<Requester>(async method => method === 'PUT' || getCount++ > 0 ? saved() : defaults())
    boot(send); await flush()
    expect(choice('language').value).toBe('en')
    desired(); submit(); await flush()
    expect(send.mock.calls).toEqual([
      ['GET', '/api/admin/preferences'], ['PUT', '/api/admin/preferences', { language: 'ar', theme: 'dark', density: 'compact', expectedRevision: R1 }], ['GET', '/api/admin/preferences'],
    ])
    expect($('[data-whm-preferences-save-status]').dataset.state).toBe('read')
    expect($<HTMLAnchorElement>('[data-whm-preferences-apply]').getAttribute('href')).toBe('/whm/preferences')
    expect($<HTMLElement>('[data-whm-preferences-apply]').hidden).toBe(false)
    expect($('[data-whm-preferences-field="updatedAt"] bdi').getAttribute('dir')).toBe('ltr')
    expect(choice('theme').value).toBe('dark')
  })
  it('locks the stale draft after conflict until an explicit reload', async () => {
    const send = vi.fn<Requester>(async method => { if (method === 'GET') return defaults(); throw Object.assign(new Error('conflict'), { status: 409 }) })
    boot(send); await flush(); desired(); submit(); await flush()
    expect(choice('language').value).toBe('ar')
    expect($<HTMLButtonElement>('[data-whm-preferences-save]').disabled).toBe(true)
    expect($('[data-whm-preferences-save-status]').textContent).toContain('changed since')
    submit(); await flush(); expect(send.mock.calls.filter(([method]) => method === 'PUT')).toHaveLength(1)
    $<HTMLButtonElement>('[data-whm-preferences-reload]').click(); await flush()
    expect($<HTMLButtonElement>('[data-whm-preferences-save]').disabled).toBe(false)
  })
  it('refuses wrong-value acknowledgements without claiming saved or retrying', async () => {
    const send = vi.fn<Requester>(async method => method === 'GET' ? defaults() : { ...saved(), preferences: { ...saved().preferences, theme: 'light' } })
    boot(send); await flush(); desired(); submit(); await flush()
    expect($('[data-whm-preferences-save-status]').dataset.state).toBe('failed')
    expect($<HTMLButtonElement>('[data-whm-preferences-save]').disabled).toBe(true)
    expect($<HTMLElement>('[data-whm-preferences-apply]').hidden).toBe(true)
    expect(send.mock.calls).toHaveLength(2)
  })
  it('refuses a mismatched readback after an accepted write', async () => {
    let gets = 0
    const send = vi.fn<Requester>(async method => method === 'PUT' ? saved() : gets++ === 0 ? defaults() : { ...saved(), revision: 'c'.repeat(64) })
    boot(send); await flush(); desired(); submit(); await flush()
    expect($('[data-whm-preferences-save-status]').dataset.state).toBe('failed')
    expect($<HTMLButtonElement>('[data-whm-preferences-save]').disabled).toBe(true)
    expect(send.mock.calls).toHaveLength(3)
  })
  it('shows invalid saved state with disabled edits and preserves Arabic labels and direction', async () => {
    boot(async () => ({ ...defaults(), state: 'invalid', preferences: null }), 'ar'); await flush()
    expect($('[data-whm-preferences-workspace]').getAttribute('dir')).toBe('rtl')
    expect($('[data-whm-preferences-workspace]').getAttribute('lang')).toBe('ar')
    expect($('[data-whm-preferences-status]').dataset.state).toBe('failed')
    expect(choice('language').disabled).toBe(true)
    expect($('[data-whm-preferences-field="theme"]').textContent).toBe('غير متاح')
    expect(document.body.textContent).not.toMatch(/[٠-٩۰-۹]/)
    for (const name of ['language', 'theme', 'density']) expect(document.querySelector(`label[for="${choice(name).id}"]`)).not.toBeNull()
  })
  it('reports unknown write outcomes without issuing an automatic read or replay', async () => {
    const send = vi.fn<Requester>(async method => { if (method === 'GET') return defaults(); throw { details: { stateChanged: true, verificationRequired: true } } })
    boot(send); await flush(); desired(); submit(); await flush()
    expect(send.mock.calls).toHaveLength(2)
    expect($('[data-whm-preferences-save-status]').textContent).toContain('could not be verified')
    expect($<HTMLButtonElement>('[data-whm-preferences-reload]').disabled).toBe(false)
  })
})

describe('complete administrator preference timestamps', () => {
  it.each(['en', 'ar'] as const)('preserves the complete saved instant in %s', async locale => {
    const instant = '2026-10-27T12:13:14.567Z'
    const send = vi.fn<Requester>(async () => ({ ...saved(), updatedAt: instant }))
    boot(send, locale); await flush()
    const timestamp = $('[data-whm-preferences-field="updatedAt"] bdi')
    expect(timestamp.textContent).toBe('2026-10-27 12:13 UTC')
    expect(timestamp.getAttribute('dir')).toBe('ltr')
    expect(send.mock.calls).toEqual([['GET', '/api/admin/preferences']])
  })
})
