// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmLanguagesWorkspace } from './board-port/whm-languages-workspace.ts'
import { readPanelLanguagesView, WHM_LANGUAGES_CLIENT_BINDING } from './whm-languages-client.ts'
import type { PanelLanguagesView } from './whm-languages-client.ts'

const R1 = 'a'.repeat(64), R2 = 'b'.repeat(64), SHA = 'c'.repeat(64), STAMP = '2026-10-29T12:13:14.567Z'
const row = (tag: 'en' | 'ar', extra: Partial<PanelLanguagesView['locales'][number]> = {}) => ({ tag, name: tag === 'en' ? 'English' : 'Arabic', nativeName: tag === 'en' ? 'English' : 'Arabic native',
  dir: tag === 'en' ? 'ltr' : 'rtl', source: tag === 'en', offered: true, messages: 4000, override: null, overrideState: 'none', runtime: 'applied', ...extra }) as PanelLanguagesView['locales'][number]
const defaults = (): PanelLanguagesView => ({ locales: [row('en'), row('ar')], defaultLocale: 'en', policyState: 'default', updatedAt: null, revision: R1 })
const uploaded = (): PanelLanguagesView => ({ ...defaults(), revision: R2, locales: [row('en'), row('ar', { override: { uploadedAt: STAMP, uploadedBy: 'root', sha256: SHA, entries: 3 }, overrideState: 'saved', runtime: 'restart_required' })] })
type Requester = (method: string, path: string, body?: unknown) => Promise<unknown>
const flush = async () => { for (let index = 0; index < 10; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const $ = <T extends Element = HTMLElement>(selector: string): T => document.querySelector<T>(selector)!
const boot = (send?: Requester, ask: (options: Record<string, unknown>) => Promise<unknown> = async () => true, canManage = true) => {
  document.body.innerHTML = renderWhmLanguagesWorkspace({ locale: 'en', canManage })
  if (send) (window as Window & { xpanelSessionRequest?: Requester }).xpanelSessionRequest = send
  new Function('return ' + WHM_LANGUAGES_CLIENT_BINDING)()(ask)
}
const choose = (text: string, name = 'ar.po') => {
  const input = $<HTMLInputElement>('[data-whm-languages-file="ar"]')
  Object.defineProperty(input, 'files', { value: [new File([text], name)], configurable: true })
  input.dispatchEvent(new Event('change'))
}
beforeEach(() => { delete (window as Window & { xpanelSessionRequest?: Requester }).xpanelSessionRequest })
afterEach(() => { document.body.innerHTML = '' })

describe('languages response parser', () => {
  it('accepts exact views and rejects contradictions', () => {
    expect(readPanelLanguagesView(uploaded())).toEqual(uploaded())
    for (const bad of [
      { ...defaults(), extra: 1 }, { ...defaults(), revision: 'x' }, { ...defaults(), policyState: 'saved' }, { ...defaults(), defaultLocale: 'fr' },
      { ...defaults(), locales: [row('ar'), row('en')] }, { ...defaults(), locales: [row('en', { offered: false }), row('ar')] },
      { ...defaults(), locales: [row('en'), row('ar', { overrideState: 'saved' })] }, { ...defaults(), locales: [row('en'), row('ar', { runtime: 'maybe' as 'applied' })] },
    ]) expect(() => readPanelLanguagesView(bad)).toThrow()
  })
})

describe('languages client', () => {
  it('reads nothing without transport or authority and renders no fake locale actions', async () => {
    boot(); await flush()
    expect($('[data-whm-languages-status]').dataset.state).toBe('unavailable')
    const send = vi.fn<Requester>(async () => defaults())
    boot(send, undefined, false); await flush()
    expect(send).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toMatch(/Add locale|Delete locale|Copy/)
    expect(document.querySelector('[data-whm-languages-upload="en"]')).toBeNull()
    for (const locale of ['en', 'ar'] as const) {
      const html = renderWhmLanguagesWorkspace({ locale, canManage: false })
      expect(html).not.toMatch(/<form\b|[٠-٩۰-۹]/)
      for (const control of html.matchAll(/<(?:input|select|textarea|button)\b[^>]*>/g)) expect(control[0]).toMatch(/\bdisabled\b/)
    }
    expect(WHM_LANGUAGES_CLIENT_BINDING).not.toContain('innerHTML')
    expect(WHM_LANGUAGES_CLIENT_BINDING).not.toContain('fetch(')
  })
  it('paints the read view and saves locales with the observed revision and an independent readback', async () => {
    const saved: PanelLanguagesView = { ...defaults(), revision: R2, policyState: 'saved', updatedAt: STAMP, defaultLocale: 'ar', locales: [row('en', { offered: false }), row('ar')] }
    let reads = 0
    const send = vi.fn<Requester>(async method => method === 'PUT' || reads++ > 0 ? saved : defaults())
    boot(send); await flush()
    expect($('[data-whm-languages-messages="en"]').textContent).toBe('4000 source messages')
    expect($('[data-whm-languages-setting="ar"]').textContent).toContain('Release catalog')
    expect($<HTMLButtonElement>('[data-whm-languages-remove="ar"]').disabled).toBe(true)
    $<HTMLInputElement>('[data-whm-languages-offered][value="en"]').checked = false
    $<HTMLSelectElement>('[data-whm-languages-default]').value = 'ar'
    $<HTMLFormElement>('[data-whm-languages-form]').dispatchEvent(new Event('submit', { cancelable: true })); await flush()
    expect(send.mock.calls).toEqual([['GET', '/api/server/panel/languages'], ['PUT', '/api/server/panel/languages', { offered: ['ar'], defaultLocale: 'ar', expectedRevision: R1 }], ['GET', '/api/server/panel/languages']])
    expect($('[data-whm-languages-save-status]').dataset.state).toBe('read')
    expect($('[data-whm-languages-status]').textContent).toContain('2026-10-29 12:13 UTC')
  })
  it('refuses a default that is not offered without sending', async () => {
    const send = vi.fn<Requester>(async () => defaults())
    boot(send); await flush()
    $<HTMLInputElement>('[data-whm-languages-offered][value="en"]').checked = false
    $<HTMLFormElement>('[data-whm-languages-form]').dispatchEvent(new Event('submit', { cancelable: true })); await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect($('[data-whm-languages-save-status]').dataset.state).toBe('failed')
  })
  it('uploads a confirmed .po file and reports restart required after readback', async () => {
    let reads = 0
    const send = vi.fn<Requester>(async method => method === 'PUT' || reads++ > 0 ? uploaded() : defaults())
    const ask = vi.fn(async () => true)
    boot(send, ask); await flush()
    choose('msgid ""\nmsgstr ""\n"Language: ar\\n"\n'); await flush()
    expect(ask).toHaveBeenCalledOnce()
    const [method, path, body] = send.mock.calls[1]!
    expect([method, path]).toEqual(['PUT', '/api/server/panel/languages/ar/catalog?expectedRevision=' + R1])
    expect(body).toBeInstanceOf(Blob)
    expect((body as Blob).type).toBe('text/x-gettext-translation')
    expect(await (body as Blob).text()).toBe('msgid ""\nmsgstr ""\n"Language: ar\\n"\n')
    expect($('[data-whm-languages-catalog-status]').dataset.state).toBe('read')
    expect($('[data-whm-languages-setting="ar"]').textContent).toContain('applies when the panel next starts')
    expect($('[data-whm-languages-setting="ar"]').textContent).toContain('2026-10-29 12:13 UTC')
    expect($<HTMLButtonElement>('[data-whm-languages-remove="ar"]').disabled).toBe(false)
  })
  it('shows server field errors with line numbers and refuses non-.po files locally', async () => {
    const send = vi.fn<Requester>(async method => { if (method === 'GET') return defaults(); throw Object.assign(new Error('refused'), { status: 400, details: { stateChanged: false, problemCount: 21, fields: [{ field: 'msgstr', code: 'placeholder_mismatch', line: 12, msgid: 'Hello {name}' }] } }) })
    boot(send); await flush()
    choose('x', 'ar.txt'); await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect($('[data-whm-languages-catalog-status]').textContent).toContain('.po')
    choose('x'); await flush()
    const errors = $('[data-whm-languages-errors]')
    expect(errors.hidden).toBe(false)
    expect(errors.textContent).toContain('Line 12: The translation does not use the same placeholders as the source.')
    expect(errors.querySelector('bdi')!.textContent).toBe(' Hello {name}')
    expect(errors.textContent).toContain('20 more problems')
    expect($('[data-whm-languages-catalog-status]').dataset.state).toBe('failed')
  })
  it('removes only after confirmation and locks on a stale revision until reload', async () => {
    const send = vi.fn<Requester>(async method => { if (method === 'GET') return uploaded(); throw Object.assign(new Error('conflict'), { status: 409, details: { stateChanged: false } }) })
    const ask = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
    boot(send, ask); await flush()
    $<HTMLButtonElement>('[data-whm-languages-remove="ar"]').click(); await flush()
    expect(send).toHaveBeenCalledTimes(1)
    $<HTMLButtonElement>('[data-whm-languages-remove="ar"]').click(); await flush()
    expect(send.mock.calls[1]).toEqual(['DELETE', '/api/server/panel/languages/ar/catalog', { expectedRevision: R2 }])
    expect($('[data-whm-languages-catalog-status]').dataset.state).toBe('stale')
    expect($<HTMLButtonElement>('[data-whm-languages-save]').disabled).toBe(true)
    $<HTMLButtonElement>('[data-whm-languages-reload]').click(); await flush()
    expect($<HTMLButtonElement>('[data-whm-languages-save]').disabled).toBe(false)
  })
  it('downloads the catalog through the session transport as a .po file', async () => {
    const send = vi.fn<Requester>(async (_method, path) => path.endsWith('/catalog') ? { locale: 'ar', filename: 'ar.po', catalog: 'msgid ""' } : defaults())
    const created = vi.fn(() => 'blob:x'), revoked = vi.fn()
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: revoked })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    boot(send); await flush()
    $<HTMLButtonElement>('[data-whm-languages-download="ar"]').click(); await flush()
    expect(send.mock.calls[1]).toEqual(['GET', '/api/server/panel/languages/ar/catalog'])
    expect(click).toHaveBeenCalledOnce(); expect(revoked).toHaveBeenCalledWith('blob:x')
    expect($('[data-whm-languages-catalog-status]').textContent).toContain('ar.po')
    click.mockRestore()
  })
})
