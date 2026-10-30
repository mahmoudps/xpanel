import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { translator } from './i18n.ts'
import { builtinEnvironments, type EnvironmentReturn } from 'vitest/runtime'
import { ACCOUNT_HTACCESS_CLIENT_BINDING, type HtaccessClientView } from './account-htaccess-client.ts'
import { ACCOUNT_WEB_DIRECTIVES_CLIENT_BINDING } from './account-web-directives-client.ts'
import { renderAccountHtaccessWorkspace } from './board-port/account-htaccess-workspace.ts'
import { renderAccountIpBlockerWorkspace } from './board-port/account-web-directives-workspace.ts'
import * as classic from './board-port/account-directive-client-templates.ts'
import * as v2 from './themes/v2/pages/xpanel/advanced/directive-client-templates.ts'

let environment: EnvironmentReturn
beforeEach(async () => {
  environment = await builtinEnvironments.jsdom.setup(globalThis, { jsdom: { url: 'https://panel.example.test', runScripts: 'outside-only' } })
  vi.stubGlobal('xpT', translator('en'))
})
afterEach(async () => { await environment.teardown(globalThis); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const accountId = '11111111-1111-4111-8111-111111111111', domainId = '22222222-2222-4222-8222-222222222222'
const input = { locale: 'en' as const, accountId, domains: [{ id: domainId, accountId, name: 'example.test' }], canManage: true }
const saved: HtaccessClientView = { context: { accountId, domainId, domainName: 'example.test', path: 'public_html/.htaccess', engine: 'apache', phpHandler: 'fpm' }, document: { exists: true, content: 'php_value memory_limit 128M', sizeBytes: 27, mtime: '2026-10-26T12:00:00.000Z', revision: 'a'.repeat(64) }, versions: [{ id: '44444444-4444-4444-8444-444444444444', at: '2026-10-26T12:00:00.000Z', actor: '<literal reviewer>', sizeBytes: 27, revision: 'a'.repeat(64), state: 'kept', current: true, canRestore: false }], capabilities: { canValidate: true, canSave: true, canRestore: false, canMigrate: false, reason: null }, application: { status: 'read', nativeQualified: false, syntaxChecked: false, httpStatus: null }, policy: { valid: true, issues: [], phpLines: [] }, reviewRequired: false }
const directives = { feature: 'ip-blocker', context: { accountId, domainId, domainName: 'example.test', path: 'public_html/.htaccess', engine: 'apache' }, document: { exists: true, revision: 'a'.repeat(64), sizeBytes: 40, unmanagedLines: 2, managedFeatures: ['ip-blocker'] }, managed: true, model: { entries: ['192.0.2.1'] }, conflict: null, capabilities: { canSave: true, reason: null }, application: { status: 'read', syntaxChecked: false, httpStatus: null, nativeQualified: false } }

// The workspace is the existing controller contract; the selected theme supplies every dynamic node.
for (const [theme, factory] of [['classic', classic], ['v2', v2]] as const) describe(theme + ' protected file controller templates', () => {
  function mount(kind: 'htaccess' | 'directives', corrupt?: 'missing' | 'duplicate' | 'slot', denied = false) {
    document.body.innerHTML = kind === 'htaccess' ? renderAccountHtaccessWorkspace(input) : renderAccountIpBlockerWorkspace(input)
    const root = document.querySelector<HTMLElement>(kind === 'htaccess' ? '[data-htaccess-workspace]' : '[data-web-directives]')!
    root.querySelectorAll('template').forEach(template => template.remove())
    root.insertAdjacentHTML('beforeend', kind === 'htaccess' ? factory.htaccessClientTemplates() : factory.webDirectiveClientTemplates())
    if (corrupt) {
      const template = root.querySelector<HTMLTemplateElement>('template')!
      if (corrupt === 'missing') template.remove()
      if (corrupt === 'duplicate') template.after(template.cloneNode(true))
      if (corrupt === 'slot') template.content.querySelector('[data-xp-slot]')!.remove()
    }
    if (denied) root.dataset.readonly = 'true'
    const request = vi.fn(async () => structuredClone(kind === 'htaccess' ? saved : directives))
    Object.assign(window, { xpanelSessionRequest: request })
    const binding = kind === 'htaccess' ? ACCOUNT_HTACCESS_CLIENT_BINDING : ACCOUNT_WEB_DIRECTIVES_CLIENT_BINDING
    ;(new Function('return ' + binding)() as (confirm: unknown) => void)(async () => false)
    return { root, request }
  }
  it('fills actual PHP/history rows without exposing kept version identifiers or interpreting content as HTML', async () => {
    const { root, request } = mount('htaccess')
    await vi.waitFor(() => expect(root.querySelector('[data-htaccess-status]')?.getAttribute('data-state')).toBe('read'))
    expect(request.mock.calls).toHaveLength(1)
    const php = root.querySelector('[data-htaccess-php-rows] tr')!
    expect(php.querySelector('[data-xp-slot="directive"]')?.textContent).toBe('php_value memory_limit')
    expect(php.querySelector('[data-xp-slot="value"]')?.textContent).toBe('128M')
    const row = root.querySelector('[data-htaccess-versions] tr')!
    expect(row.querySelector('[data-xp-slot="actor"]')?.textContent).toBe('<literal reviewer>')
    expect(row.querySelector('literal')).toBeNull()
    expect(row.querySelector('time')?.getAttribute('datetime')).toBe(saved.versions[0]!.at)
    expect(row.querySelector<HTMLButtonElement>('[data-xp-slot="restore"]')?.disabled).toBe(true)
    expect(row.textContent).not.toContain(saved.versions[0]!.id)
    expect(row.querySelector('button')?.classList.contains(theme === 'classic' ? 'xp-btn' : 'v2-btn')).toBe(true)
  })
  it('renders selected-theme rule actions and edits only local draft state', async () => {
    const { root, request } = mount('directives')
    await vi.waitFor(() => expect(root.querySelector('[data-wd-status]')?.getAttribute('data-state')).toBe('read'))
    const row = root.querySelector('[data-wd-rows] tr')!
    expect(row.textContent).toContain('192.0.2.1')
    expect(row.querySelector('button')?.classList.contains(theme === 'classic' ? 'xp-btn' : 'v2-btn')).toBe(true)
    row.querySelector<HTMLButtonElement>('button')!.click()
    expect(root.querySelector<HTMLInputElement>('[data-wd-field="address"]')?.value).toBe('192.0.2.1')
    expect(request.mock.calls).toHaveLength(1)
  })
  for (const kind of ['htaccess', 'directives'] as const) {
    it.each(['missing', 'duplicate', 'slot'] as const)('refuses ' + kind + ' %s template before any request', corrupt => {
      const { root, request } = mount(kind, corrupt)
      expect(request).not.toHaveBeenCalled()
      expect(root.querySelector(kind === 'htaccess' ? '[data-htaccess-status]' : '[data-wd-status]')?.getAttribute('data-state')).toBe('unavailable')
      root.querySelectorAll<HTMLButtonElement>('button').forEach(button => expect(button.disabled).toBe(true))
    })
    it('refuses ' + kind + ' under a read-only ancestor without any request', () => { expect(mount(kind, undefined, true).request).not.toHaveBeenCalled() })
  }
})
