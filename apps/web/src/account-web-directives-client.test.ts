// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACCOUNT_WEB_DIRECTIVES_CLIENT_BINDING, createWebDirectivesController, readWebDirectivesView } from './account-web-directives-client.ts'
import { ACCOUNT_WEB_DIRECTIVE_ROUTES, renderAccountErrorPagesWorkspace, renderAccountHandlersWorkspace, renderAccountHotlinkWorkspace, renderAccountIndexesWorkspace, renderAccountIpBlockerWorkspace, renderAccountMimeTypesWorkspace, renderAccountRedirectsWorkspace, renderAccountWebDirectivePage } from './board-port/account-web-directives-workspace.ts'

const accountId = '11111111-1111-4111-8111-111111111111', domainId = '22222222-2222-4222-8222-222222222222'
const input = (locale: 'en' | 'ar' = 'en', canManage = true) => ({ locale, accountId, domains: [{ id: domainId, accountId, name: 'example.test' }, { id: '33333333-3333-4333-8333-333333333333', accountId: '44444444-4444-4444-8444-444444444444', name: 'other.test' }], canManage })
const view = (feature: string, model: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ feature, context: { accountId, domainId, domainName: 'example.test', path: 'public_html/.htaccess', engine: 'apache' },
  document: { exists: true, revision: 'a'.repeat(64), sizeBytes: 40, unmanagedLines: 2, managedFeatures: [] }, managed: false, model, conflict: null, capabilities: { canSave: true, reason: null },
  application: { status: 'read', syntaxChecked: false, httpStatus: null, nativeQualified: false }, ...(feature === 'error-pages' ? { existence: 'not-checked' } : {}), ...extra })
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const listeners: EventListener[] = []
afterEach(() => { for (const listener of listeners.splice(0)) window.removeEventListener('beforeunload', listener); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; document.body.replaceChildren(); vi.restoreAllMocks() })
function bind(html: string, request: (method: string, path: string, body?: unknown) => Promise<unknown>, confirm: unknown = async () => true) {
  const add = window.addEventListener.bind(window)
  vi.spyOn(window, 'addEventListener').mockImplementation((name, callback, options) => { if (name === 'beforeunload') listeners.push(callback as EventListener); add(name, callback, options) })
  ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  document.body.innerHTML = html
  ;(new Function('return ' + ACCOUNT_WEB_DIRECTIVES_CLIENT_BINDING)() as (confirm: unknown) => void)(confirm)
}
const $ = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!

describe('account web directive pages', () => {
  it('renders seven bilingual pages that keep technical values isolated and ASCII digits', () => {
    const renderers = [renderAccountErrorPagesWorkspace, renderAccountIndexesWorkspace, renderAccountMimeTypesWorkspace, renderAccountHandlersWorkspace, renderAccountHotlinkWorkspace, renderAccountIpBlockerWorkspace, renderAccountRedirectsWorkspace]
    expect(Object.keys(ACCOUNT_WEB_DIRECTIVE_ROUTES).sort()).toEqual(['/advanced/error-pages', '/advanced/handlers', '/advanced/indexes', '/advanced/mime-types', '/domains/redirects', '/security/hotlink', '/security/ip-blocker'])
    for (const locale of ['en', 'ar'] as const) for (const render of renderers) {
      const html = render(input(locale))
      expect(html).not.toMatch(/[٠-٩۰-۹]/); expect(html).toContain(`dir="${locale === 'ar' ? 'rtl' : 'ltr'}"`); expect(html).not.toContain('other.test')
      if (render === renderAccountHandlersWorkspace) { expect(html).toContain('data-web-directives-unavailable="handlers"'); expect(html).not.toMatch(/<(?:input|button|select)/); continue }
      for (const part of ['data-wd-domain', 'data-wd-rows', 'data-wd-save', 'data-wd-refresh', 'data-wd-discard', 'data-wd-notice', 'data-wd-issues', 'data-wd-error-for', '<bdi dir="ltr" data-wd-path>']) expect(html).toContain(part)
    }
    expect(renderAccountWebDirectivePage('ip-blocker', input('ar'))).toContain('حظر عناوين الشبكة')
    expect(renderAccountRedirectsWorkspace(input('en', false))).toContain('data-wd-manage="false"')
    expect(ACCOUNT_WEB_DIRECTIVES_CLIENT_BINDING).not.toContain('innerHTML'); expect(() => new Function('return ' + ACCOUNT_WEB_DIRECTIVES_CLIENT_BINDING)).not.toThrow()
  })
  it('strictly rejects foreign, malformed or inconsistent replies', () => {
    const good = view('redirects', { entries: [{ status: 301, path: '/a', target: 'https://example.org/' }] })
    expect(readWebDirectivesView(clone(good), 'redirects', domainId, accountId).model).toEqual(good.model)
    for (const bad of [{ ...good, context: { ...good.context, accountId: '55555555-5555-4555-8555-555555555555' } }, { ...good, feature: 'hotlink' }, { ...good, model: { entries: [{ status: 307, path: '/a', target: 'x' }] } },
      { ...good, model: { entries: [], extra: true } }, { ...good, capabilities: { canSave: true, reason: 'policy' } }, { ...good, context: { ...good.context, path: '../.htaccess' } }, { ...good, existence: 'not-checked' },
      { ...good, conflict: { code: 'Not A Code', line: 1 } }, { ...good, application: { ...good.application, nativeQualified: true } }, { ...good, document: { ...good.document, managedFeatures: ['handlers'] } }])
      expect(() => readWebDirectivesView(clone(bad), 'redirects', domainId, accountId)).toThrow()
    expect(() => readWebDirectivesView(view('error-pages', { entries: [] }, { existence: undefined }), 'error-pages', domainId, accountId)).toThrow()
  })
  it('saves the draft with the captured revision, requires matching readback and keeps drafts on refusal', async () => {
    let current = view('ip-blocker', { entries: [] })
    const request = vi.fn(async (method: string, path: string, body?: unknown) => {
      expect(path).toBe('/api/domains/' + domainId + '/web-directives/ip-blocker')
      if (method === 'PUT') { expect(body).toEqual({ expectedRevision: 'a'.repeat(64), model: { entries: ['192.0.2.1'] } }); current = view('ip-blocker', { entries: ['192.0.2.1'] }, { managed: true, document: { ...current.document, revision: 'b'.repeat(64) } }); return { ...clone(current), application: { status: 'saved', syntaxChecked: true, httpStatus: 200, nativeQualified: false } } }
      return clone(current)
    })
    const controller = createWebDirectivesController({ feature: 'ip-blocker', domainId, accountId, request, admitted: () => true, confirm: async () => true })
    await controller.load(); controller.edit({ entries: ['192.0.2.1'] }); expect(controller.state.dirty).toBe(true); await controller.save()
    expect(request.mock.calls.map(call => call[0])).toEqual(['GET', 'PUT', 'GET']); expect(controller.state).toMatchObject({ status: 'saved', dirty: false, review: false }); expect(controller.state.view?.application.httpStatus).toBe(200)
    const refused = vi.fn(async (method: string) => { if (method === 'PUT') throw Object.assign(new Error('refused'), { status: 422, details: { stateChanged: false, fields: [{ field: 'entries.0', code: 'protected_address' }] } }); return clone(view('ip-blocker', { entries: [] })) })
    const second = createWebDirectivesController({ feature: 'ip-blocker', domainId, accountId, request: refused, admitted: () => true, confirm: async () => true })
    await second.load(); second.edit({ entries: ['127.0.0.1'] }); await second.save()
    expect(second.state).toMatchObject({ status: 'fields', review: false, dirty: true, fields: [{ field: 'entries.0', code: 'protected_address' }] }); expect(second.state.draft).toEqual({ entries: ['127.0.0.1'] })
    const canceled = vi.fn(async () => clone(view('ip-blocker', { entries: [] })))
    const third = createWebDirectivesController({ feature: 'ip-blocker', domainId, accountId, request: canceled, admitted: () => true, confirm: async () => false })
    await third.load(); third.edit({ entries: ['192.0.2.9'] }); await third.save(); expect(canceled).toHaveBeenCalledTimes(1); expect(third.state.dirty).toBe(true)
  })
  it('locks after unknown outcomes and reports rollback and Apache refusals truthfully', async () => {
    const unknown = vi.fn(async (method: string) => { if (method === 'PUT') throw { status: 503, details: { stateChanged: true, unknownOutcome: true } }; return clone(view('indexes', { listing: 'inherit' })) })
    const locked = createWebDirectivesController({ feature: 'indexes', domainId, accountId, request: unknown, admitted: () => true, confirm: async () => true })
    await locked.load(); locked.edit({ listing: 'disabled' }); await locked.save(); await locked.save()
    expect(locked.state).toMatchObject({ review: true, status: 'uncertain' }); expect(unknown).toHaveBeenCalledTimes(2); expect(locked.state.draft).toEqual({ listing: 'disabled' })
    const rolled = vi.fn(async (method: string) => method === 'PUT' ? { ...view('indexes', { listing: 'inherit' }), application: { status: 'rolled_back', syntaxChecked: true, httpStatus: 500, nativeQualified: false } } : clone(view('indexes', { listing: 'inherit' })))
    const back = createWebDirectivesController({ feature: 'indexes', domainId, accountId, request: rolled, admitted: () => true, confirm: async () => true })
    await back.load(); back.edit({ listing: 'enabled' }); await back.save()
    expect(back.state).toMatchObject({ status: 'rolled_back', dirty: true, draft: { listing: 'enabled' } }); expect(back.state.view?.application.httpStatus).toBe(500)
    const invalid = vi.fn(async (method: string) => method === 'PUT' ? { ...view('indexes', { listing: 'inherit' }), application: { status: 'validated', syntaxChecked: true, httpStatus: null, nativeQualified: false }, validation: { valid: false, nativeChecked: true, issues: [{ line: 2, code: 'apache_config_test' }] } } : clone(view('indexes', { listing: 'inherit' })))
    const refused = createWebDirectivesController({ feature: 'indexes', domainId, accountId, request: invalid, admitted: () => true, confirm: async () => true })
    await refused.load(); refused.edit({ listing: 'enabled' }); await refused.save()
    expect(refused.state).toMatchObject({ status: 'invalid', dirty: true, review: false }); expect(invalid).toHaveBeenCalledTimes(2)
  })
  it('binds a list page: adds and removes draft rows, shows field errors per row and sends one guarded save', async () => {
    let saved: unknown
    const request = vi.fn(async (method: string, _path: string, body?: unknown) => {
      if (method === 'PUT') { saved = body; throw Object.assign(new Error('refused'), { status: 422, details: { stateChanged: false, fields: [{ field: 'entries.0.target', code: 'redirect_loop' }] } }) }
      return clone(view('redirects', { entries: [] }))
    })
    bind(renderAccountRedirectsWorkspace(input()), request)
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-wd-add]').disabled).toBe(false))
    expect($('[data-wd-notice]').textContent).toContain('2 lines that this page does not manage')
    $<HTMLButtonElement>('[data-wd-add]').click()
    expect($('[data-wd-error-for="path"]').textContent).toBe('This value is required.'); expect($<HTMLInputElement>('#wd-redirects-path').getAttribute('aria-invalid')).toBe('true')
    $<HTMLInputElement>('#wd-redirects-path').value = '/old'; $<HTMLInputElement>('#wd-redirects-target').value = 'https://example.test/old/new'
    $<HTMLButtonElement>('[data-wd-add]').click()
    expect($('[data-wd-rows]').textContent).toContain('/old'); expect($<HTMLButtonElement>('[data-wd-save]').disabled).toBe(false)
    $<HTMLButtonElement>('[data-wd-save]').click()
    await vi.waitFor(() => expect($('[data-wd-status]').getAttribute('data-state')).toBe('fields'))
    expect(saved).toEqual({ expectedRevision: 'a'.repeat(64), model: { entries: [{ status: 301, path: '/old', target: 'https://example.test/old/new' }] } })
    expect($('[data-wd-rows]').textContent).toContain('This target would redirect back to itself.'); expect($('[data-wd-status]').getAttribute('role')).toBe('alert')
    const remove = [...document.querySelectorAll<HTMLButtonElement>('[data-wd-rows] button')].find(node => node.textContent === 'Remove')!
    remove.click(); expect($('[data-wd-rows]').textContent).toContain('No rules are managed'); expect($<HTMLButtonElement>('[data-wd-save]').disabled).toBe(true)
    expect(request.mock.calls.map(call => call[0])).toEqual(['GET', 'PUT'])
  })
  it('binds settings pages and keeps policy-refused pages read-only', async () => {
    const request = vi.fn(async (_method: string, path: string) => path.endsWith('/hotlink')
      ? clone(view('hotlink', { enabled: false, allowedHosts: ['example.test'], extensions: ['png'], allowEmptyReferrer: true, redirectUrl: null }))
      : clone(view('ip-blocker', { entries: [] }, { capabilities: { canSave: false, reason: 'policy' } })))
    bind(renderAccountHotlinkWorkspace(input()) + renderAccountIpBlockerWorkspace(input()), request)
    await vi.waitFor(() => expect($<HTMLInputElement>('#wd-hotlink-enabled').disabled).toBe(false))
    expect($<HTMLTextAreaElement>('#wd-hotlink-allowedHosts').value).toBe('example.test')
    const enabled = $<HTMLInputElement>('#wd-hotlink-enabled'); enabled.checked = true; enabled.dispatchEvent(new Event('change'))
    const action = $<HTMLSelectElement>('#wd-hotlink-action'); action.value = 'redirect'; action.dispatchEvent(new Event('change'))
    expect($('[data-wd-error-for="redirectUrl"]').textContent).toBe('This value is required.')
    expect($<HTMLButtonElement>('[data-web-directives="hotlink"] [data-wd-save]').disabled).toBe(false)
    await vi.waitFor(() => expect($('[data-web-directives="ip-blocker"] [data-wd-notice]').textContent).toContain('does not permit these directives'))
    expect($<HTMLButtonElement>('[data-web-directives="ip-blocker"] [data-wd-add]').disabled).toBe(true); expect($<HTMLInputElement>('#wd-ip-blocker-address').disabled).toBe(true)
    expect(request.mock.calls.every(call => call[0] === 'GET')).toBe(true)
  })
  it('stays unavailable without management admission and sends nothing', () => {
    const request = vi.fn(async () => ({}))
    bind(renderAccountErrorPagesWorkspace(input('en', false)), request)
    expect($('[data-wd-status]').getAttribute('data-state')).toBe('unavailable'); expect($<HTMLButtonElement>('[data-wd-save]').disabled).toBe(true); expect(request).not.toHaveBeenCalled()
  })
})
