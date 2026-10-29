// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACCOUNT_SITE_PUBLISHER_CLIENT_BINDING, readSitePublisherView } from './account-site-publisher-client.ts'
import { renderAccountSitePublisherWorkspace } from './board-port/account-site-publisher-workspace.ts'

const accountId = '11111111-1111-4111-8111-111111111111', domainId = '22222222-2222-4222-8222-222222222222'
const view = () => ({ context: { accountId, domainId, domainName: 'example.test', path: 'public_html' }, revision: 'a'.repeat(64), files: ['index.html', 'index.htm', 'index.php'].map(name => ({ name, exists: false, hash: null, sizeBytes: 0 })), recovery: { status: 'none', createdAt: null }, capabilities: { canPublish: false, canRollback: false }, application: { status: 'read', nativeQualified: false } })
const html = (canManage = true, lang: 'en' | 'ar' = 'en') => renderAccountSitePublisherWorkspace({ lang, accountId, domains: [{ id: domainId, name: 'example.test' }], canManage })
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const $ = <T extends Element>(name: string): T => document.querySelector<T>('[data-sitepub-' + name + ']')!
async function bind(canManage: boolean, request: (method: string, path: string, body?: unknown) => Promise<unknown>) {
  document.body.innerHTML = html(canManage)
  ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  new Function('return ' + ACCOUNT_SITE_PUBLISHER_CLIENT_BINDING)()(async () => true)
  await settle(); await settle()
}
afterEach(() => { document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr'; document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; vi.restoreAllMocks() })
describe('site publisher workspace', () => {
  it('keeps approved controls in both languages with an isolated preview and truthful backup boundary', () => {
    for (const lang of ['en', 'ar'] as const) { const markup = html(true, lang); expect(markup).toContain('dir="' + (lang === 'ar' ? 'rtl' : 'ltr') + '"'); expect(markup).toContain('sandbox=""'); expect(markup).toContain('data-sitepub-publish disabled'); expect(markup).not.toMatch(/[٠-٩۰-۹]/); expect(markup).toContain(lang === 'en' ? '30-day retention' : '30 يومًا') }
    expect(html()).not.toContain('<form'); expect(ACCOUNT_SITE_PUBLISHER_CLIENT_BINDING).not.toContain('innerHTML')
  })
  it('leaves unavailable and read-only pages inert', async () => {
    const request = vi.fn(async () => view())
    await bind(false, request)
    expect(request).not.toHaveBeenCalled(); expect([...document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input,select,textarea')].every(control => control.disabled)).toBe(true)
  })
  it('allows preview while publishing is unqualified and never sends a publish request', async () => {
    const request = vi.fn(async (method: string, path: string) => path.endsWith('/preview') ? { html: '<!doctype html><html><body>Hello</body></html>', hash: 'b'.repeat(64) } : view())
    await bind(true, request)
    expect(request).toHaveBeenCalledWith('GET', '/api/domains/' + domainId + '/site-publisher')
    $<HTMLInputElement>('title').value = 'Title'; $<HTMLTextAreaElement>('message').value = 'Message'
    expect($<HTMLButtonElement>('preview').disabled).toBe(false); expect($<HTMLButtonElement>('publish').disabled).toBe(true)
    $<HTMLButtonElement>('preview').click(); await settle(); await settle()
    expect($<HTMLIFrameElement>('frame').hidden).toBe(false); expect($<HTMLButtonElement>('publish').disabled).toBe(true)
    $<HTMLButtonElement>('publish').click(); await settle()
    expect(request.mock.calls.some(call => call[1].endsWith('/publish'))).toBe(false)
  })
  it('rejects foreign targets, unsafe paths and forged publish availability', () => {
    expect(readSitePublisherView(view(), accountId, domainId)).toEqual(view())
    for (const change of [{ context: { ...view().context, accountId: domainId } }, { context: { ...view().context, path: '/root' } }, { context: { ...view().context, path: 'a/../b' } }, { capabilities: { canPublish: true, canRollback: false } }, { application: { status: 'published', nativeQualified: false } }]) expect(() => readSitePublisherView({ ...view(), ...change }, accountId, domainId)).toThrow()
  })
  it('locks controls after an invalid read and escapes domain labels', async () => {
    await bind(true, async () => ({ ...view(), context: { ...view().context, accountId: domainId } }))
    expect($<HTMLButtonElement>('preview').disabled).toBe(true); expect($('status').getAttribute('data-state')).toBe('failed')
    expect(renderAccountSitePublisherWorkspace({ lang: 'en', accountId, domains: [{ id: domainId, name: '<img src=x>' }], canManage: true })).toContain('&lt;img src=x&gt;')
  })
})
describe('readable publisher recovery metadata', () => {
  it.each(['en', 'ar'] as const)('shows human backup creation time without enabling publishing in %s', async locale => {
    const storedAt = '2026-10-27T09:01:02.123Z'
    const observed = { ...view(), recovery: { status: 'prepared', createdAt: storedAt }, capabilities: { canPublish: false, canRollback: true } }
    expect(readSitePublisherView(observed, accountId, domainId).recovery.createdAt).toBe(storedAt)
    const original = JSON.stringify(observed), request = vi.fn(async (method: string, path: string) => {
      expect(method).toBe('GET'); expect(path).toBe('/api/domains/' + domainId + '/site-publisher')
      return JSON.parse(JSON.stringify(observed))
    })
    document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
    document.body.innerHTML = html(true, locale)
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
    const confirm = vi.fn(async (_options: Record<string, unknown>) => false)
    new Function('return ' + ACCOUNT_SITE_PUBLISHER_CLIENT_BINDING)()(confirm)
    await vi.waitFor(() => expect($('status').getAttribute('data-state')).toBe('read'))
    const created = $<HTMLElement>('created'), time = created.querySelector<HTMLTimeElement>('time')
    expect(time).not.toBeNull(); expect(time!.textContent).toBe('2026-10-27 09:01 UTC'); expect(time!.dateTime).toBe(storedAt)
    expect(created.dir).toBe('ltr'); expect(created.textContent).not.toContain(storedAt)
    expect($<HTMLButtonElement>('publish').disabled).toBe(true); expect($('recovery').textContent).toContain(locale === 'ar' ? 'الاستعادة مطلوبة' : 'recovery required')
    $<HTMLTextAreaElement>('message').value = 'Source timestamp ' + storedAt
    expect($<HTMLTextAreaElement>('message').value).toBe('Source timestamp ' + storedAt)
    expect(request).toHaveBeenCalledTimes(1); expect(confirm).not.toHaveBeenCalled(); expect(JSON.stringify(observed)).toBe(original)
    $<HTMLButtonElement>('rollback').click()
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
    expect(confirm.mock.calls[0]![0].body).toBe(locale === 'ar' ? 'استعادة ملفات البداية المحفوظة للنطاق example.test وإزالة صفحة الناشر.' : 'Restore the saved index files for example.test and remove the publisher page.')
    expect(request).toHaveBeenCalledTimes(1)
  })
})
