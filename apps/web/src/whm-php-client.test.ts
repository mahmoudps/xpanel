// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmPhpReadback } from './board-port/whm-php-workspace.ts'
import { readPhpInventoryView, readPhpManageView, readPhpUsageView, WHM_PHP_CLIENT_BINDING } from './whm-php-client.ts'
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
    expect(send.mock.calls.map(call => call.slice(0, 2))).toEqual([['GET', '/api/server/php/inventory'], ['GET', '/api/server/php/usage'], ['GET', '/api/server/php/manage']])
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
    expect(send.mock.calls.map(call => call.slice(0, 2))).toEqual([['GET', '/api/server/php/inventory'], ['GET', '/api/server/php/usage'], ['GET', '/api/server/php/manage']])
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

const manageView = () => ({
  state: 'read', reason: null, family: 'debian', observedAt: '2026-10-29T00:00:00.000Z', revision: 'c'.repeat(64), defaultVersion: '8.3', installable: ['8.2'], capabilities: { install: true, remove: true, extensions: true, ini: true }, actions: { manage: true }, usage: [], exceptions: [{ account: 'omar', functions: ['proc_open'], reason: 'Laravel queue worker', grantedAt: '2026-08-02T00:00:00.000Z', grantedBy: 'root' }], exceptionsRevision: 'e'.repeat(64),
  versions: [{ version: '8.3', packages: ['php8.3-fpm'], fpmInstalled: true, fpmBinary: '/usr/sbin/php-fpm8.3', iniFile: '/etc/php/8.3/fpm/php.ini', managedIni: '/etc/php/8.3/fpm/conf.d/99-xpanel.ini', ini: { memory_limit: '256M' }, lifecycle: { state: 'security' }, domainCount: 1, accountCount: 1,
    extensions: [{ module: 'opcache', package: 'opcache', installed: true, enabled: true, purpose: null }, { module: 'redis', package: 'redis', installed: false, enabled: false, purpose: null }] }],
})
describe('WHM PHP management writes', () => {
  const page = () => `<section data-whm-detail-route="/whm/software/php" data-capability-state="authorized"><section data-whm-detail-section="php-versions">${renderWhmPhpReadback({ locale: 'en', canRead: true })}<table><tbody></tbody></table><select name="php-selected-version" disabled></select><button data-php-action="set-default" disabled data-wiring="soon">Set as default</button><details><summary>Confirm</summary><button data-php-action="confirm-remove" disabled>Remove</button></details></section><section data-whm-detail-section="php-install"><input name="php-install-request" disabled><button data-php-action="install-version" disabled>Install</button></section><section data-whm-detail-section="php-extensions"><select name="php-extension-version" disabled></select><table><tbody></tbody></table></section><section data-whm-detail-section="php-configure"><select name="php-version" disabled></select><input name="memory_limit" disabled><button data-php-action="apply-ini" disabled>Test and apply</button></section><section data-whm-detail-section="php-functions"><table><tbody></tbody></table><details><summary>New</summary><select name="php-exception-account" disabled><option value="karim">karim</option></select><textarea name="php-exception-reason" disabled></textarea><input type="checkbox" name="php-exception-exec" disabled><input type="checkbox" name="php-exception-popen" disabled><button data-php-action="grant-exception" disabled>Grant exception</button></details></section></section>`
  const bootWith = (send: (method: string, path: string, body?: unknown) => Promise<unknown>, ask = vi.fn(async () => true)) => {
    document.body.innerHTML = page(); (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
    new Function('return ' + WHM_PHP_CLIENT_BINDING)()(ask); return ask
  }
  const reads = (path: string) => path.endsWith('/inventory') ? inventory() : path.endsWith('/usage') ? usage() : manageView()
  it('hides only the semantic draft extension choices after a host read, independent of theme class names', async () => {
    bootWith(vi.fn(async (_method: string, path: string) => reads(path)))
    const section = document.querySelector('[data-whm-detail-section="php-extensions"]')!
    const draft = document.createElement('div'); draft.dataset.phpExtensionDraftGrid = ''; draft.className = 'v2-host__choices'; draft.textContent = 'Draft only'
    const independent = document.createElement('div'); independent.className = 'xp-whm-detail-choice-grid'; independent.textContent = 'Independent controls'
    section.append(draft, independent); await tick()
    expect(draft.hidden).toBe(true); expect(independent.hidden).toBe(false)
    expect(section.querySelector('[data-php-extension="opcache"]')).not.toBeNull()
  })
  it('enables the reviewed controls and paints extension switches from the host observation', async () => {
    bootWith(vi.fn(async (_method: string, path: string) => reads(path))); await tick()
    expect(document.querySelector<HTMLButtonElement>('[data-php-action="set-default"]')!.disabled).toBe(false)
    expect(document.querySelector<HTMLInputElement>('[name="memory_limit"]')!.value).toBe('256M')
    const boxes = document.querySelectorAll<HTMLInputElement>('[data-php-extension]')
    expect([...boxes].map(box => [box.dataset.phpExtension, box.checked, box.disabled])).toEqual([['opcache', true, false], ['redis', false, false]])
    expect(document.querySelector('[data-whm-detail-section="php-versions"] tbody:not([data-whm-php-usage])')!.textContent).toContain('Default')
  })
  it('previews, confirms and submits an ini change bound to the observed revision', async () => {
    const send = vi.fn(async (method: string, path: string, _body?: unknown) => method === 'GET' ? reads(path) : path.endsWith('/preview') ? { preview: { state: 'ready', reason: null } } : { job: { id: 'job-1', referenceCode: 'J-1001' } })
    const ask = bootWith(send); await tick()
    document.querySelector<HTMLInputElement>('[name="memory_limit"]')!.value = '512M'
    document.querySelector<HTMLButtonElement>('[data-php-action="apply-ini"]')!.click(); await tick(); await tick()
    const body = { operation: 'set-ini', version: '8.3', ini: { memory_limit: '512M' }, expectedRevision: 'c'.repeat(64) }
    expect(send.mock.calls.filter(call => call[0] === 'POST')).toEqual([['POST', '/api/server/php/manage/preview', body], ['POST', '/api/server/php/manage/apply', body]])
    expect(ask).toHaveBeenCalledOnce()
    expect(document.querySelector('[data-whm-detail-section="php-configure"] [data-php-manage-status]')!.textContent).toContain('J-1001')
  })
  it.each([
    { referenceCode: null, locale: 'en', expected: 'Unnumbered' },
    { referenceCode: undefined, locale: 'en', expected: 'Unnumbered' },
    { referenceCode: '', locale: 'en', expected: 'Unnumbered' },
    { referenceCode: '  ', locale: 'en', expected: 'Unnumbered' },
    { referenceCode: 123, locale: 'en', expected: 'Unnumbered' },
    { referenceCode: null, locale: 'ar', expected: 'غير مرقمة' },
  ])('shows a localized unnumbered job without exposing its storage id ($locale, $referenceCode)', async ({ referenceCode, locale, expected }) => {
    const internalId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const send = vi.fn(async (method: string, path: string) => method === 'GET' ? reads(path) : path.endsWith('/preview') ? { preview: { state: 'ready', reason: null } } : { job: { id: internalId, referenceCode } })
    document.documentElement.lang = locale
    try {
      bootWith(send); await tick()
      document.querySelector<HTMLButtonElement>('[data-php-action="apply-ini"]')!.click(); await tick(); await tick()
      const message = document.querySelector('[data-whm-detail-section="php-configure"] [data-php-manage-status]')!.textContent
      expect(message).toContain(expected)
      expect(message).not.toContain(internalId)
      expect(send.mock.calls.filter(call => call[0] === 'POST').map(call => call[1])).toEqual(['/api/server/php/manage/preview', '/api/server/php/manage/apply'])
    } finally { document.documentElement.lang = 'en' }
  })
  it('sends nothing when the host refuses the preview or the user cancels', async () => {
    const send = vi.fn(async (method: string, path: string) => method === 'GET' ? reads(path) : { preview: { state: 'blocked', reason: 'nothing-to-do' } })
    bootWith(send, vi.fn(async () => false)); await tick()
    document.querySelector<HTMLButtonElement>('[data-php-action="apply-ini"]')!.click(); await tick(); await tick()
    expect(send.mock.calls.some(call => call[1] === '/api/server/php/manage/apply')).toBe(false)
    expect(document.querySelector('[data-whm-detail-section="php-configure"] [data-php-manage-status]')!.textContent).toContain('nothing-to-do')
  })
  it('lists exceptions with revoke and grants a new one bound to the exceptions revision', async () => {
    const send = vi.fn(async (method: string, path: string, _body?: unknown) => method === 'GET' ? reads(path) : { disableFunctions: 'shell_exec' })
    const ask = bootWith(send); await tick()
    const body = document.querySelector('[data-whm-detail-section="php-functions"] tbody')!
    expect(body.textContent).toContain('omar')
    expect(body.querySelector('button')!.textContent).toBe('Revoke')
    document.querySelector<HTMLTextAreaElement>('[name="php-exception-reason"]')!.value = 'Ghostscript thumbnails'
    document.querySelector<HTMLInputElement>('[name="php-exception-exec"]')!.checked = true
    document.querySelector<HTMLButtonElement>('[data-php-action="grant-exception"]')!.click(); await tick(); await tick()
    expect(ask).toHaveBeenCalledOnce()
    expect(send.mock.calls.find(call => call[0] === 'POST')).toEqual(['POST', '/api/server/php/exceptions', { account: 'karim', functions: ['exec'], reason: 'Ghostscript thumbnails', expectedRevision: 'e'.repeat(64) }])
    document.querySelector('[data-whm-detail-section="php-functions"] tbody button')!.dispatchEvent(new MouseEvent('click')); await tick(); await tick()
    expect(send.mock.calls.find(call => call[0] === 'DELETE')).toEqual(['DELETE', '/api/server/php/exceptions/omar', { expectedRevision: 'e'.repeat(64) }])
  })
  it('reads the management contract strictly', () => {
    expect(readPhpManageView(manageView()).versions[0]!.extensions).toHaveLength(2)
    expect(() => readPhpManageView({ ...manageView(), revision: 'x' })).toThrow()
    expect(() => readPhpManageView({ ...manageView(), versions: [{ ...manageView().versions[0], extensions: [{ module: '<b>', package: null, installed: true, enabled: true }] }] })).toThrow()
  })
})
