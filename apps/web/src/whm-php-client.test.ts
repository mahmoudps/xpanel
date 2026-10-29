// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmPhpReadback } from './board-port/whm-php-workspace.ts'
import { readPhpInventoryView, readPhpUsageView, WHM_PHP_CLIENT_BINDING } from './whm-php-client.ts'
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const inventory = () => ({ state: 'read', source: 'dpkg', observedAt: '2026-10-26T12:00:00.000Z', versions: [{ version: '8.3', supported: true, packages: [{ name: 'php8.3-cli', version: '8.3.12-1', component: 'cli' }, { name: 'php8.3-curl', version: '8.3.12-1', component: 'curl' }], binary: { state: 'read', scope: 'cli-without-ini', version: '8.3.12', sapi: 'cli', builtInExtensions: ['Core', 'json'] }, extensionEnablement: 'not-read', fpmRequest: 'not-read' }] })
const usage = () => ({ scope: 'saved-domain-configuration', observedRuntime: false, usage: [{ version: '8.3', domainCount: 1, domains: [{ name: 'site.example.test', account: 'alpha', handler: 'fpm' }] }] })
beforeEach(() => {
  document.body.innerHTML = `<section data-whm-detail-route="/whm/software/php" data-capability-state="authorized"><section data-whm-detail-section="php-versions">${renderWhmPhpReadback({ locale: 'en', canRead: true })}<table><tbody><tr><td>Not read</td></tr></tbody></table><select name="php-selected-version" disabled></select><button data-native-write disabled>Set default</button></section><section data-whm-detail-section="php-extensions"><select name="php-extension-version" disabled></select><table><tbody></tbody></table><input type="checkbox" disabled></section><section data-whm-detail-section="php-configure"><select name="php-version" disabled></select><textarea name="php-ini" disabled></textarea></section></section>`
  delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
})
const boot = (request?: (method: string, path: string) => Promise<unknown>) => { if (request) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request; new Function('return ' + WHM_PHP_CLIENT_BINDING)()() }
describe('WHM PHP inventory reader', () => {

  it.each([
    { locale: 'en', stamp: '2026-10-27T12:34:56.123Z', expected: '2026-10-27 12:34 UTC' },
    { locale: 'ar', stamp: '2026-10-27T12:34:56.000Z', expected: '2026-10-27 12:34 UTC' },
  ] as const)('renders readable datetime metadata for PHP without changing raw observations ($locale)', async ({ locale, stamp, expected }) => {
    document.querySelector<HTMLElement>('[data-whm-php-workspace]')!.outerHTML = renderWhmPhpReadback({ locale, canRead: true })
    const observed = { ...inventory(), observedAt: stamp }
    const send = vi.fn(async (_method: string, path: string) => path.endsWith('/inventory') ? observed : usage())
    document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
    boot(send); await tick()
    document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr'
    expect(document.querySelector('[data-whm-php-binary-status]')!.textContent).toBe(locale === 'ar' ? 'قُرئ ملف CLI التنفيذي دون php.ini: 8.3.12. لا يثبت هذا تفعيل امتدادات FPM أو التحقق من طلب للتطبيق.' : 'CLI binary read without php.ini: 8.3.12. This is not FPM extension enablement or application request verification.')
    const shown = document.querySelector<HTMLElement>('[data-whm-php-observed-at]')!
    expect(shown.textContent).toBe(expected)
    expect(shown.tagName).toBe('BDI'); expect(shown.dir).toBe('ltr')
    expect(readPhpInventoryView(observed).observedAt).toBe(stamp)
    expect(document.querySelector<HTMLElement>('[data-whm-php-status]')!.dataset.state).toBe('read')
    expect(document.querySelector<HTMLButtonElement>('[data-native-write]')!.disabled).toBe(true)
    expect(send.mock.calls.map(call => call.slice(0, 2))).toEqual([['GET', '/api/server/php/inventory'], ['GET', '/api/server/php/usage']])
  })

  it('requires distinct installed and desired evidence contracts', () => {
    expect(readPhpInventoryView(inventory()).versions[0]!.binary.scope).toBe('cli-without-ini')
    expect(readPhpUsageView(usage())[0]!.domains[0]!.account).toBe('alpha')
    expect(() => readPhpInventoryView({ ...inventory(), source: null })).toThrow()
    expect(() => readPhpUsageView({ ...usage(), observedRuntime: true })).toThrow()
  })
  it('does not accept an unbound binary or unsafe data as an observed runtime', () => {
    const wrong = inventory(); wrong.versions[0]!.binary.version = '8.2.12'
    expect(() => readPhpInventoryView(wrong)).toThrow()
    const bad = inventory(); bad.versions[0]!.packages[0]!.name = '<img src=x>'
    expect(() => readPhpInventoryView(bad)).toThrow()
    expect(() => readPhpUsageView({ ...usage(), usage: [{ version: '8.3', domainCount: 1, domains: [{ name: 'site.example.test', account: 'internal-uuid-key', handler: 'fpm' }] }] })).toThrow()
  })
  it('retains the workspace but makes no request without transport or admission', async () => {
    boot(); expect(document.querySelector<HTMLElement>('[data-whm-php-status]')!.dataset.state).toBe('unavailable')
    document.querySelector<HTMLElement>('[data-whm-php-workspace]')!.removeAttribute('data-php-bound')
    document.querySelector<HTMLElement>('[data-whm-php-workspace]')!.dataset.phpCanRead = 'false'
    const send = vi.fn(); boot(send); await tick(); expect(send).not.toHaveBeenCalled()
  })
  it('reads packages and saved assignments while leaving actual management controls disabled', async () => {
    const send = vi.fn(async (_method: string, path: string) => path.endsWith('/inventory') ? inventory() : usage())
    boot(send); await tick()
    expect(send.mock.calls.map(call => call.slice(0, 2))).toEqual([['GET', '/api/server/php/inventory'], ['GET', '/api/server/php/usage']])
    expect(document.querySelector<HTMLElement>('[data-whm-php-status]')!.dataset.state).toBe('read')
    expect(document.querySelector<HTMLSelectElement>('[name="php-selected-version"]')!.value).toBe('8.3')
    expect(document.querySelector<HTMLSelectElement>('[name="php-selected-version"]')!.disabled).toBe(false)
    expect(document.querySelector<HTMLButtonElement>('[data-native-write]')!.disabled).toBe(true)
    expect(document.querySelector<HTMLTextAreaElement>('[name="php-ini"]')!.disabled).toBe(true)
    expect(document.querySelector('[data-whm-detail-section="php-extensions"] tbody')!.textContent).toContain('FPM not read')
    expect(document.querySelector('[data-whm-php-usage]')!.textContent).toContain('site.example.test')
    expect(document.querySelector('[data-whm-php-usage]')!.textContent).toContain('alpha')
    expect(WHM_PHP_CLIENT_BINDING).not.toContain('innerHTML')
    expect(WHM_PHP_CLIENT_BINDING).not.toContain('fetch(')
  })
  it('does not call a desired version installed when package inventory is unavailable', async () => {
    boot(async (_method, path) => path.endsWith('/inventory') ? { state: 'unavailable', source: null, observedAt: '2026-10-26T12:00:00Z', versions: [] } : usage())
    await tick()
    expect(document.querySelector<HTMLElement>('[data-whm-php-status]')!.dataset.state).toBe('failed')
    expect(document.querySelector<HTMLSelectElement>('[name="php-selected-version"]')!.options).toHaveLength(0)
    expect(document.querySelector('[data-whm-php-usage]')!.textContent).toContain('site.example.test')
  })
})
