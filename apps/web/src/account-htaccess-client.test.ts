// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { ACCOUNT_HTACCESS_CLIENT_BINDING, createHtaccessController, readHtaccessView, type HtaccessClientView } from './account-htaccess-client.ts'
import { renderAccountHtaccessWorkspace } from './board-port/account-htaccess-workspace.ts'
import { formatDisplayDateTime } from './tokens.ts'
const accountId = '11111111-1111-4111-8111-111111111111', domainId = '22222222-2222-4222-8222-222222222222'
const view = (content = '# old\n', revision = 'a'.repeat(64)): HtaccessClientView => ({ context: { accountId, domainId, domainName: 'example.test', path: 'public_html/.htaccess', engine: 'apache', phpHandler: 'fpm' },
  document: { exists: true, content, sizeBytes: new TextEncoder().encode(content).length, mtime: '2026-10-26T12:00:00.000Z', revision }, versions: [],
  capabilities: { canSave: true, canValidate: true, canRestore: true, canMigrate: false, reason: null }, policy: { valid: true, issues: [], phpLines: [] },
  application: { status: 'read', nativeQualified: false, syntaxChecked: false, httpStatus: null }, reviewRequired: false })
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
describe('account .htaccess controller', () => {
  it('retains approved editor actions and serializes a self-contained safe binding', () => {
    const html = renderAccountHtaccessWorkspace({ locale: 'ar', accountId, domains: [{ id: domainId, accountId, name: 'example.test' }], canManage: true })
    for (const component of ['editor', 'gutter', 'preset', 'validate', 'save', 'migrate', 'versions', 'discard', 'php-before', 'php-after', 'php-rows', 'undo-migration']) expect(html).toContain('data-htaccess-' + component)
    expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/); expect(ACCOUNT_HTACCESS_CLIENT_BINDING).not.toContain('innerHTML')
    expect(() => new Function('return ' + ACCOUNT_HTACCESS_CLIENT_BINDING)).not.toThrow()
  })
  it.each(['en', 'ar'] as const)('renders readable UTC version metadata while preserving machine time and source in %s', async locale => {
    const storedAt = '2026-10-27T09:01:02.123456Z', actor = 'Synthetic component reviewer 2026'
    const source = '# Preserve source timestamp ' + storedAt + '\nRewriteEngine On\n'
    const observed = view(source)
    observed.versions = [{ id: '44444444-4444-4444-8444-444444444444', at: storedAt, actor, sizeBytes: 12345, revision: 'c'.repeat(64), state: 'kept', current: false, canRestore: false }]
    const original = JSON.stringify(observed)
    expect(readHtaccessView(clone(observed), domainId, accountId).versions[0]!.at).toBe(storedAt)
    expect(formatDisplayDateTime(storedAt)).toBe('2026-10-27 09:01 UTC')
    const listeners: EventListener[] = [], add = window.addEventListener.bind(window)
    const spy = vi.spyOn(window, 'addEventListener').mockImplementation((name, callback, options) => { if (name === 'beforeunload') listeners.push(callback as EventListener); add(name, callback, options) })
    const request = vi.fn(async (method: string, path: string) => {
      expect(method).toBe('GET'); expect(path).toBe('/api/domains/' + domainId + '/htaccess')
      return clone(observed)
    })
    const transportWindow = window as Window & { xpanelSessionRequest?: typeof request }
    transportWindow.xpanelSessionRequest = request
    document.body.innerHTML = renderAccountHtaccessWorkspace({ locale, accountId, domains: [{ id: domainId, accountId, name: 'example.test' }], canManage: true })
    try {
      const binding = new Function('return ' + ACCOUNT_HTACCESS_CLIENT_BINDING)() as (confirm: unknown) => void
      const confirm = vi.fn(async () => false)
      binding(confirm)
      await vi.waitFor(() => expect(document.querySelector<HTMLElement>('[data-htaccess-status]')!.dataset.state).toBe('read'))
      const history = document.querySelector<HTMLElement>('[data-htaccess-versions]')!, row = history.querySelector('tr')!
      expect(row.querySelectorAll('td')).toHaveLength(5)
      expect(row.querySelector('td:nth-child(2)')!.textContent).toBe(actor)
      expect(row.querySelector('td:nth-child(3)')!.textContent).toBe('12345')
      expect(row.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true)
      expect(document.querySelector<HTMLTextAreaElement>('[data-htaccess-editor]')!.value).toBe(source)
      expect(request.mock.calls).toEqual([['GET', '/api/domains/' + domainId + '/htaccess']])
      expect(confirm).not.toHaveBeenCalled()
      const time = row.querySelector<HTMLTimeElement>('td:first-child time')
      expect(time).not.toBeNull()
      expect(time!.textContent).toBe('2026-10-27 09:01 UTC')
      expect(time!.textContent).toBe(formatDisplayDateTime(storedAt))
      expect(time!.dateTime).toBe(storedAt)
      expect(time!.getAttribute('datetime')).toBe(storedAt)
      expect(time!.closest('bdi')!.dir).toBe('ltr')
      expect(history.textContent).not.toContain(storedAt)
      expect(history.textContent).not.toContain(observed.versions[0]!.id)
      expect(history.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
      expect(JSON.stringify(observed)).toBe(original)
    } finally { for (const listener of listeners) window.removeEventListener('beforeunload', listener); spy.mockRestore(); delete transportWindow.xpanelSessionRequest; document.body.replaceChildren() }
  })
  it.each(['en', 'ar'] as const)('uses readable UTC version metadata in a canceled restore confirmation in %s', async locale => {
    const storedAt = '2026-10-27T09:01:02.123456Z', versionId = '44444444-4444-4444-8444-444444444444'
    const source = '# Source timestamp stays ' + storedAt + '\nRewriteEngine On\n', observed = view(source)
    observed.versions = [{ id: versionId, at: storedAt, actor: 'Synthetic restore reviewer 2026', sizeBytes: 12345, revision: 'c'.repeat(64), state: 'kept', current: false, canRestore: true }]
    observed.policy.issues = [{ line: 3, code: 'directive', message: 'Directive is not allowed' }]
    const original = JSON.stringify(observed)
    expect(readHtaccessView(clone(observed), domainId, accountId).versions[0]!.at).toBe(storedAt)
    const listeners: EventListener[] = [], add = window.addEventListener.bind(window)
    const spy = vi.spyOn(window, 'addEventListener').mockImplementation((name, callback, options) => { if (name === 'beforeunload') listeners.push(callback as EventListener); add(name, callback, options) })
    const request = vi.fn(async (method: string, path: string) => {
      expect(method).toBe('GET'); expect(path).toBe('/api/domains/' + domainId + '/htaccess')
      return clone(observed)
    })
    const transportWindow = window as Window & { xpanelSessionRequest?: typeof request }
    transportWindow.xpanelSessionRequest = request
    document.body.innerHTML = renderAccountHtaccessWorkspace({ locale, accountId, domains: [{ id: domainId, accountId, name: 'example.test' }], canManage: true })
    document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
    try {
      const confirm = vi.fn(async (_options: Record<string, unknown>) => false)
      const binding = new Function('return ' + ACCOUNT_HTACCESS_CLIENT_BINDING)() as (confirm: unknown) => void
      binding(confirm)
      await vi.waitFor(() => expect(document.querySelector<HTMLElement>('[data-htaccess-status]')!.dataset.state).toBe('read'))
      const restore = document.querySelector<HTMLButtonElement>('[data-htaccess-versions] button')!
      expect(restore.disabled).toBe(false)
      restore.click()
      await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
      await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-htaccess-versions] button')!.disabled).toBe(false))
      const confirmation = confirm.mock.calls[0]![0], body = String(confirmation.body)
      expect(confirmation.title).toBe(locale === 'ar' ? 'استعادة نسخة محفوظة' : 'Restore kept file')
      expect(document.querySelector('[data-htaccess-issues] li')!.textContent).toBe((locale === 'ar' ? 'السطر 3: ' : 'Line 3: ') + 'Directive is not allowed')
      expect(body.split('\n')[0]).toBe('example.test')
      expect(body.split('\n')[1]).toBe('2026-10-27 09:01 UTC')
      expect(body.split('\n')[1]).toBe(formatDisplayDateTime(storedAt))
      expect(body).not.toContain(storedAt)
      expect(body).not.toContain(versionId)
      expect(request.mock.calls).toEqual([['GET', '/api/domains/' + domainId + '/htaccess']])
      expect(document.querySelector<HTMLTextAreaElement>('[data-htaccess-editor]')!.value).toBe(source)
      expect(observed.versions[0]!.id).toBe(versionId)
      expect(observed.versions[0]!.at).toBe(storedAt)
      expect(observed.document.revision).toBe('a'.repeat(64))
      expect(JSON.stringify(observed)).toBe(original)
    } finally { for (const listener of listeners) window.removeEventListener('beforeunload', listener); spy.mockRestore(); delete transportWindow.xpanelSessionRequest; document.body.replaceChildren(); document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr' }
  })
  it('rejects a response for another account', () => { expect(() => readHtaccessView({ ...view(), context: { ...view().context, accountId: '33333333-3333-4333-8333-333333333333' } }, domainId, accountId)).toThrow() })
  it('keeps useful draft content after canceled save and sends no mutation', async () => {
    const request = vi.fn(async () => clone(view())), controller = createHtaccessController({ domainId, accountId, request, admitted: () => true, confirm: async () => false })
    await controller.load(); controller.edit('# useful new draft\n'); await controller.save()
    expect(controller.state.draft).toBe('# useful new draft\n'); expect(request).toHaveBeenCalledTimes(1); expect(controller.state.dirty).toBe(true)
  })
  it('sends the captured revision and requires matching fresh file readback', async () => {
    let current = view()
    const request = vi.fn(async (method: string, _path: string, body?: unknown) => {
      if (method === 'PUT') { const input = body as { content: string; expectedRevision: string }; expect(input.expectedRevision).toBe('a'.repeat(64)); current = view(input.content, 'b'.repeat(64)); return { ...clone(current), application: { status: 'saved', syntaxChecked: true, nativeQualified: false, httpStatus: 200 } } }
      return clone(current)
    })
    const controller = createHtaccessController({ domainId, accountId, request, admitted: () => true, confirm: async () => true })
    await controller.load(); controller.edit('RewriteEngine On\n'); await controller.save()
    expect(request.mock.calls.map(call => call[0])).toEqual(['GET', 'PUT', 'GET']); expect(controller.state.dirty).toBe(false); expect(controller.state.status).toBe('saved')
  })
  it('keeps the draft and stops all retries after an unknown mutation outcome', async () => {
    const request = vi.fn(async (method: string) => { if (method === 'PUT') throw { status: 503, details: { stateChanged: true, unknownOutcome: true } }; return clone(view()) })
    const controller = createHtaccessController({ domainId, accountId, request, admitted: () => true, confirm: async () => true })
    await controller.load(); controller.edit('# retain me\n'); await controller.save(); await controller.save()
    expect(controller.state.review).toBe(true); expect(controller.state.draft).toBe('# retain me\n'); expect(request).toHaveBeenCalledTimes(2)
  })
  it('does not install a late response after admission is withdrawn', async () => {
    let admitted = true, finish!: (value: unknown) => void
    const pending = new Promise<unknown>(resolve => { finish = resolve })
    const controller = createHtaccessController({ domainId, accountId, request: async () => pending, admitted: () => admitted })
    const loading = controller.load(); admitted = false; finish(view()); await loading; expect(controller.state.view).toBeNull()
  })
  it('sends the current useful draft and its captured PHP revision to migration', async () => {
    let current = { ...view(), phpRevision: 'c'.repeat(64), capabilities: { ...view().capabilities, canMigrate: true } }
    const draft = '# useful comment\nphp_value memory_limit 128M\n'
    const request = vi.fn(async (method: string, path: string, body?: unknown) => {
      if (method === 'POST') {
        expect(path).toContain('/migrate-php'); expect(body).toEqual({ content: draft, expectedRevision: 'a'.repeat(64), expectedPhpRevision: 'c'.repeat(64) })
        current = { ...current, ...view('# useful comment\n', 'd'.repeat(64)), phpRevision: 'e'.repeat(64) }
        return { ...clone(current), application: { status: 'saved', syntaxChecked: true, nativeQualified: false, httpStatus: 200 }, migration: { phpRevision: current.phpRevision, keys: ['memory_limit'], status: 'applied' } }
      }
      return clone(current)
    })
    const controller = createHtaccessController({ domainId, accountId, request, admitted: () => true, confirm: async () => true })
    await controller.load(); controller.edit(draft); await controller.migratePhp()
    expect(controller.state.draft).toBe('# useful comment\n'); expect(controller.state.status).toBe('saved')
  })
  it('fills compatibility and before/after panels from the draft without sending a mutation', async () => {
    const listeners: EventListener[] = [], add = window.addEventListener.bind(window)
    const spy = vi.spyOn(window, 'addEventListener').mockImplementation((name, callback, options) => { if (name === 'beforeunload') listeners.push(callback as EventListener); add(name, callback, options) })
    const request = vi.fn(async () => clone(view()))
    const transportWindow = window as Window & { xpanelSessionRequest?: typeof request }
    transportWindow.xpanelSessionRequest = request
    document.body.innerHTML = renderAccountHtaccessWorkspace({ locale: 'en', accountId, domains: [{ id: domainId, accountId, name: 'example.test' }], canManage: true })
    try {
      const binding = new Function('return ' + ACCOUNT_HTACCESS_CLIENT_BINDING)() as (confirm: unknown) => void
      binding(async () => true)
      const editor = document.querySelector<HTMLTextAreaElement>('[data-htaccess-editor]')!
      await vi.waitFor(() => expect(editor.readOnly).toBe(false))
      editor.value = '# keep\nphp_value memory_limit 128M\nphp_flag display_errors Off\n'; editor.dispatchEvent(new Event('input'))
      expect(document.querySelector('[data-htaccess-php-before]')?.textContent).toContain('php_value memory_limit 128M')
      expect(document.querySelector('[data-htaccess-php-after]')?.textContent).toBe('memory_limit = 128M\ndisplay_errors = Off')
      expect(document.querySelector('[data-htaccess-php-rows]')?.textContent).toContain('memory_limit')
      expect(document.querySelector<HTMLButtonElement>('[data-htaccess-undo-migration]')?.disabled).toBe(true); expect(request).toHaveBeenCalledTimes(1)
    } finally { for (const listener of listeners) window.removeEventListener('beforeunload', listener); spy.mockRestore(); delete transportWindow.xpanelSessionRequest; document.body.replaceChildren() }
  })
})
