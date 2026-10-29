// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACCOUNT_PACKAGES_CLIENT_BINDING, readAccountPackagesView } from './account-packages-client.ts'
import { renderAccountPackagesWorkspace } from './board-port/account-packages-workspace.ts'

const accountId = '11111111-1111-4111-8111-111111111111'
const pkg = { name: 'Config_Lite', version: '1.0.0', source: 'https://pear.php.net/get/Config_Lite-1.0.0.tgz', archiveSha256: 'c'.repeat(64), requires: [], files: [{ path: 'Config/Lite.php', sha256: 'd'.repeat(64) }] }
const view = (op = 'read', installed = false) => ({ context: { accountId, username: 'alice' }, ecosystem: 'pear', scope: 'managed-private-library', library: '.xpanel-packages/pear/library', revision: (op === 'read' ? 'a' : 'b').repeat(64), catalogRevision: 'f'.repeat(64), inventory: 'verified', packages: installed ? [pkg] : [], available: [{ name: pkg.name, version: pkg.version, source: pkg.source, requires: [], summary: '<img src=x> release ١' }], recovery: op === 'read' ? 'none' : 'committed', capabilities: { install: true, remove: true, recover: false }, application: { op, state: op === 'read' ? 'read' : 'verified', verificationRequired: false } })
const settle = () => new Promise(resolve => setTimeout(resolve, 0)), $ = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!
afterEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; document.body.replaceChildren() })
async function bind(request: (method: string, path: string, body?: unknown) => Promise<unknown>, manage = true, ask: unknown = async () => true) {
  ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request; document.body.innerHTML = renderAccountPackagesWorkspace({ lang: 'en', accountId, canManage: manage })
  ;(new Function('return ' + ACCOUNT_PACKAGES_CLIENT_BINDING)() as (ask: unknown) => void)(ask); await settle(); await settle()
}
describe('account package library controller', () => {
  it('preserves bilingual library, catalog, recovery and unsupported module components', () => {
    for (const lang of ['en', 'ar'] as const) { const html = renderAccountPackagesWorkspace({ lang, accountId, canManage: true }); expect(html).toContain(`dir="${lang === 'ar' ? 'rtl' : 'ltr'}"`); expect(html).not.toMatch(/[٠-٩۰-۹]/); for (const part of ['data-packages-installed', 'data-packages-available', 'data-packages-recover', 'data-packages-search', '<bdi dir="ltr">.xpanel-packages/pear/library</bdi>']) expect(html).toContain(part) }
    expect(ACCOUNT_PACKAGES_CLIENT_BINDING).not.toContain('innerHTML')
  })
  it('keeps denied pages inert and unavailable system/Perl controls permanently disabled', async () => {
    const request = vi.fn(async () => view()); await bind(request, false); expect(request).not.toHaveBeenCalled(); expect([...document.querySelectorAll<HTMLButtonElement>('button')].every(button => button.disabled)).toBe(true)
    await bind(request); expect([...document.querySelectorAll<HTMLButtonElement>('[aria-labelledby="packages-other"] button')].every(button => button.disabled)).toBe(true)
  })
  it('reads safe text, normalizes digits and confirms exact revision/name before posting an install', async () => {
    const ask = vi.fn(async () => true), request = vi.fn(async (_method: string, _path: string, body?: unknown) => body ? view((body as { op: string }).op, true) : view())
    await bind(request, true, ask); expect($('[data-packages-available]').textContent).toContain('<img src=x> release 1'); expect(document.querySelector('[data-packages-available] img')).toBeNull()
    $<HTMLButtonElement>('[data-package-op="install"]').click(); await settle(); await settle(); await settle()
    expect(ask).toHaveBeenCalledOnce(); expect(request.mock.calls.at(-1)).toEqual(['POST', '/api/account/packages', { op: 'install', name: 'Config_Lite', expectedRevision: 'a'.repeat(64) }]); expect($('[data-packages-installed]').textContent).toContain('Config_Lite'); expect($<HTMLButtonElement>('[data-package-op="install"]').disabled).toBe(true)
  })
  it('disables unmet dependencies and missing provider capability without substituting success', async () => {
    await bind(async () => ({ ...view(), available: [{ ...view().available[0]!, requires: [{ name: 'Missing', version: '1.0.0' }] }] })); expect($<HTMLButtonElement>('[data-package-op="install"]').disabled).toBe(true)
    await bind(async () => ({ ...view(), catalogRevision: null, available: [], capabilities: { install: false, remove: false, recover: false } })); expect($('[data-packages-available]').textContent).toContain('unavailable'); expect($('[data-packages-capability]').textContent).toContain('unavailable')
  })
  it('locks unknown mutations, refreshes pending recovery and requires explicit confirmed recovery', async () => {
    let attempted = false
    const request = vi.fn(async (_method: string, _path: string, body?: unknown) => { if (body) { attempted = true; throw Object.assign(new Error('lost'), { details: { stateChanged: true, verificationRequired: true } }) } return attempted ? { ...view(), inventory: 'recovery-required', recovery: 'prepared', capabilities: { install: false, remove: false, recover: true } } : view() })
    await bind(request); $<HTMLButtonElement>('[data-package-op="install"]').click(); await settle(); await settle(); await settle(); expect(request).toHaveBeenCalledTimes(2); expect($<HTMLButtonElement>('[data-package-op="install"]').disabled).toBe(true)
    $<HTMLButtonElement>('[data-packages-refresh]').click(); await settle(); await settle(); expect($<HTMLButtonElement>('[data-packages-recover]').disabled).toBe(false); expect($('[data-packages-inventory]').textContent).toContain('Recovery required')
  })
  it('rejects foreign or incoherent acknowledgements independently of API projection', () => {
    for (const raw of [{ ...view(), context: { accountId: 'foreign', username: 'alice' } }, { ...view(), details: { verificationRequired: true } }, { ...view(), scope: 'system-packages' }, { ...view(), catalogRevision: null }, { ...view(), recovery: 'prepared' }, { ...view('install', true), packages: [{ ...pkg, files: [{ path: '../escape.php', sha256: 'd'.repeat(64) }] }] }]) expect(() => readAccountPackagesView(raw, accountId, { op: 'read' })).toThrow()
  })
  it('locks uncertain errors even when they also claim stateChanged false', async () => {
    await bind(async (_method, _path, body) => { if (body) throw Object.assign(new Error('inconsistent transport'), { details: { stateChanged: false, unknownOutcome: true } }); return view() })
    $<HTMLButtonElement>('[data-package-op="install"]').click(); await settle(); await settle(); await settle()
    expect($<HTMLButtonElement>('[data-package-op="install"]').disabled).toBe(true); expect($<HTMLButtonElement>('[data-packages-refresh]').disabled).toBe(false)
  })
})
