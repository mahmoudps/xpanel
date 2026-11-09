// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWhmDetailPage } from './board-port/approved-xwhm.ts'
import { renderAccountPlugins } from './board-port/account-plugins-home.ts'
import { renderStoreExtension } from './board-port/extensions/store.ts'
import { translator } from './i18n.ts'
import { renderV2AccountPlugins } from './themes/v2/components/account-plugins.ts'
import { renderV2WhmAccountToolsPage } from './themes/v2/pages/xwhm/account-tools/index.ts'
import { renderV2WhmPanelPage } from './themes/v2/pages/xwhm/panel/index.ts'
import { renderV2WhmSoftwarePage } from './themes/v2/pages/xwhm/software/index.ts'
import { WHM_EXTEND_CLIENT_BINDING } from './whm-extend-client.ts'

type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
type Theme = 'classic' | 'v2'
const ROOT = { kind: 'root' as const, id: 'synthetic-root', username: 'synthetic-root' }
const R1 = 'a'.repeat(64), R2 = 'b'.repeat(64)
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222'
const tick = async () => { for (let index = 0; index < 10; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const cells = (selector: string) => [...document.querySelectorAll(selector + ' tr')].map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent))
const markup = (theme: Theme, route: string): string => {
  if (theme === 'classic') return route === '/whm/software/site-software' ? renderStoreExtension({ locale: 'en', route, principal: ROOT }) : renderWhmDetailPage({ activeRoute: route, principal: ROOT, locale: 'en' })!
  if (route === '/whm/accounts/health') return renderV2WhmAccountToolsPage({ activeRoute: route, principal: ROOT, locale: 'en' }, { canRead: true, canManage: true, root: true })!
  if (route === '/whm/software/site-software') return renderV2WhmSoftwarePage({ activeRoute: route, principal: ROOT, locale: 'en', dataAuthority: { canRead: true, canManage: true } })!
  return renderV2WhmPanelPage(translator('en'), { activeRoute: route, principal: ROOT, locale: 'en' }, { canRead: true, canManage: true })!
}
const boot = (theme: Theme, route: string, send: Send, ask: (options: Record<string, unknown>) => Promise<unknown> = async () => true) => {
  document.body.innerHTML = markup(theme, route)
  ;(window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest = send
  new Function('return ' + WHM_EXTEND_CLIENT_BINDING)()(ask)
}
const choose = (selector: string, value: string) => { const select = $<HTMLSelectElement>(selector); select.value = value; select.dispatchEvent(new Event('change')) }
afterEach(() => { document.body.innerHTML = ''; delete (window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest })

describe.each(['classic', 'v2'] as const)('WHM extend workspaces in the %s theme', theme => {
  it('turns demo mode on for one account with a revision-bound list and reads it back', async () => {
    const accounts = [{ id: A, username: 'alpha', primaryDomain: 'alpha.example.test', status: 'active' }, { id: B, username: 'bravo', primaryDomain: 'bravo.example.test', status: 'active' }]
    let saved = { state: 'default', accountIds: [] as string[], revision: R1, updatedAt: null, accounts }
    const send = vi.fn(async (method: string, _path: string, body?: unknown) => { if (method === 'PUT') saved = { ...saved, state: 'saved', accountIds: (body as { accountIds: string[] }).accountIds, revision: R2 }; return saved })
    boot(theme, '/whm/accounts/health', send)
    await tick()
    expect(cells('[data-demo-mode-rows]')).toEqual([['No account is in demo mode.']])
    expect($<HTMLButtonElement>('[data-demo-mode-enable]').disabled).toBe(true)
    choose('[data-demo-mode-account]', B)
    expect($<HTMLButtonElement>('[data-demo-mode-enable]').disabled).toBe(false)
    $<HTMLButtonElement>('[data-demo-mode-enable]').click()
    await tick()
    expect(send).toHaveBeenCalledWith('PUT', '/api/server/demo-mode', { accountIds: [B], expectedRevision: R1 })
    expect(cells('[data-demo-mode-rows]')).toEqual([['bravo', 'bravo.example.test', 'Active']])
    expect($('[data-demo-mode-result]').textContent).toBe('Demo mode is on for bravo.')
    expect($<HTMLButtonElement>('[data-demo-mode-disable]').disabled).toBe(false)
  })

  it('lists hooks in run order and enables, reorders and deletes the selected one', async () => {
    const hook = (id: string, executable: string, enabled = true) => ({ id, point: 'account.suspend', stage: 'pre', executable, sha256: R1, args: [], timeoutSeconds: 10, enabled, blocking: id === A, description: '' })
    const view = (hooks: unknown[], revision = R1) => ({ state: 'saved', hooks, updatedAt: null, revision, points: [], directory: '/usr/local/libexec/xpanel/hooks', observation: { state: 'read', hooks: [{ id: A, state: 'reviewed' }, { id: B, state: 'hook_executable_changed' }] } })
    const send = vi.fn(async (method: string) => method === 'GET' ? view([hook(A, '/usr/local/libexec/xpanel/hooks/gate'), hook(B, '/usr/local/libexec/xpanel/hooks/notify', false)]) : view([hook(B, '/usr/local/libexec/xpanel/hooks/notify', false), hook(A, '/usr/local/libexec/xpanel/hooks/gate')], R2))
    boot(theme, '/whm/panel/developer', send)
    await tick()
    expect($('[data-hooks-directory]').textContent).toBe('/usr/local/libexec/xpanel/hooks')
    expect(cells('[data-hooks-rows]')).toEqual([
      ['Account suspended', 'Before', '/usr/local/libexec/xpanel/hooks/gate', 'Enabled, Blocking, 10 s timeout', 'Unchanged since registration'],
      ['Account suspended', 'Before', '/usr/local/libexec/xpanel/hooks/notify', 'Disabled, Not blocking, 10 s timeout', 'The file changed after it was registered, so it does not run. Register it again after review.'],
    ])
    choose('[data-hooks-select]', B)
    expect($<HTMLButtonElement>('[data-hooks-action="enable"]').disabled).toBe(false)
    expect($<HTMLButtonElement>('[data-hooks-action="down"]').disabled).toBe(true)
    $<HTMLButtonElement>('[data-hooks-action="up"]').click()
    await tick()
    expect(send).toHaveBeenCalledWith('POST', `/api/server/hooks/${B}/move`, { direction: 'up', expectedRevision: R1 })
    expect(cells('[data-hooks-rows]')[0]![2]).toBe('/usr/local/libexec/xpanel/hooks/notify')
    expect($('[data-hooks-result]').textContent).toBe('The hook order was saved.')
  })

  it('reads registered applications including an invalid registration and its reason', async () => {
    boot(theme, '/whm/panel/developer', async (_method, path) => path === '/api/server/registered-apps'
      ? { directory: 'extended/panel/apps', truncated: false, apps: [{ origin: 'internal', state: 'registered', name: 'xwhm', displayName: 'xWHM', surface: 'xwhm', entryUrl: '/whm', acls: [], features: [], description: '', reason: null },
        { origin: 'broken.json', state: 'invalid', name: 'broken', displayName: null, surface: null, entryUrl: null, acls: [], features: [], description: '', reason: 'registration_unreadable' }] }
      : { state: 'default', hooks: [], revision: R1, observation: { state: 'unavailable', hooks: [] } })
    await tick()
    expect(cells('[data-registered-apps-rows]')).toEqual([['xWHM', 'xWHM', 'None', '/whm', 'Built in', 'Registered'], ['broken', 'Not read', 'Not read', 'Not read', 'broken.json', 'Invalid registration (registration_unreadable)']])
  })

  it('sends a cPanel plugin archive as base64 with its name from the file', async () => {
    const send = vi.fn(async (_method: string, path: string) => path === '/api/server/plugins' ? { plugins: [] } : {})
    boot(theme, '/whm/panel/developer', send)
    await tick()
    const input = $<HTMLInputElement>('[data-plugin-packages-file]'), bytes = new Uint8Array(70_000).fill(7)
    Object.defineProperty(input, 'files', { value: [new File([bytes], 'Acme-Tools.tar.gz', { type: 'application/gzip' })] })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    $<HTMLButtonElement>('[data-plugin-packages-action="install"]').click()
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith('POST', '/api/server/plugins', expect.objectContaining({ name: 'acme-tools', overwrite: false })))
    const body = send.mock.calls.find(call => call[0] === 'POST') as unknown as [string, string, { archive: string }]
    expect(Buffer.from(body[2].archive, 'base64')).toEqual(Buffer.from(bytes))
  })

  it('opens a preview of the selected installed theme and leaves a theme it cannot read closed', async () => {
    const themes = [{ id: 'classic', name: null, version: null, base: null, builtIn: true, state: 'installed', installedAt: null }, { id: 'broken', name: null, version: null, base: null, builtIn: false, state: 'invalid', installedAt: null }]
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    boot(theme, '/whm/panel/branding', async () => ({ themes }))
    await tick()
    const preview = $<HTMLButtonElement>('[data-theme-packages-action="preview"]')
    choose('[data-theme-packages-select]', 'broken')
    expect(preview.disabled).toBe(true)
    choose('[data-theme-packages-select]', 'classic')
    expect(preview.disabled).toBe(false)
    preview.click()
    expect(open).toHaveBeenCalledWith('/whm/panel/branding?previewTheme=classic', '_blank', 'noopener')
    open.mockRestore()
  })

  it('builds a plugin package from added items, downloads it and installs a package file', async () => {
    let plugins: unknown[] = []
    const send = vi.fn(async (method: string, path: string, body?: unknown) => {
      if (path === '/api/server/plugin-generator') return { format: 'xpanel-plugin-package-v1', ...(body as object) }
      if (path === '/api/server/plugins' && method === 'POST') plugins = [{ name: 'acme', state: 'installed', items: [{}], installedAt: '2026-11-07T08:00:00.000Z' }]
      if (path === '/api/server/plugins') return { plugins }
      return { state: 'default', hooks: [], revision: R1, observation: { state: 'unavailable', hooks: [] }, apps: [] }
    })
    const created: Blob[] = []
    Object.assign(URL, { createObjectURL: (blob: Blob) => { created.push(blob); return 'blob:plugin' }, revokeObjectURL: () => undefined })
    boot(theme, '/whm/panel/developer', send)
    await tick()
    expect(cells('[data-plugin-packages-rows]')).toEqual([['No plugins are installed.']])
    const fill = (key: string, value: string) => { const input = $<HTMLInputElement>(`[data-plugin-generator-input="${key}"]`); input.value = value; input.dispatchEvent(new Event('input')) }
    for (const [key, value] of [['name', 'acme'], ['id', 'notes'], ['item', 'Notes'], ['group', 'Apps'], ['priority', '10'], ['uri', '/files']] as const) fill(key, value)
    const icon = $<HTMLInputElement>('[data-plugin-generator-icon]')
    Object.defineProperty(icon, 'files', { configurable: true, value: [new File(['<svg/>'], 'icon.svg', { type: 'image/svg+xml' })] })
    icon.dispatchEvent(new Event('change'))
    $<HTMLButtonElement>('[data-plugin-packages-action="add"]').click()
    await tick()
    expect(cells('[data-plugin-generator-rows]')).toEqual([['notes', 'Notes', 'Apps', '10', '/files']])
    $<HTMLButtonElement>('[data-plugin-packages-action="generate"]').click()
    await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/plugin-generator', { name: 'acme', overwrite: false, items: [{ id: 'notes', name: 'Notes', group: 'Apps', priority: 10, uri: '/files', feature: null, icon: { type: 'image/svg+xml', data: btoa('<svg/>') } }] })
    expect(created).toHaveLength(1)
    expect($('[data-plugin-packages-result]').textContent).toBe('The package was generated. Install it here or on another server.')
    const file = $<HTMLInputElement>('[data-plugin-packages-file]')
    Object.defineProperty(file, 'files', { value: [new File(['{"format":"xpanel-plugin-package-v1"}'], 'acme.json', { type: 'application/json' })] })
    file.dispatchEvent(new Event('change'))
    $<HTMLButtonElement>('[data-plugin-packages-action="install"]').click()
    await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/plugins', { package: { format: 'xpanel-plugin-package-v1' }, overwrite: false })
    expect(cells('[data-plugin-packages-rows]')).toEqual([['acme', '1', '2026-11-07 08:00 UTC', 'Installed']])
  })

  it('shows plugin icons by group on the home page and stays hidden without items', async () => {
    const root = theme === 'classic' ? renderAccountPlugins({ locale: 'en' }) : renderV2AccountPlugins(translator('en'), true)
    document.body.innerHTML = root
    const links = [{ plugin: 'acme', id: 'a', name: 'First', group: 'Apps', priority: 1, uri: 'https://example.test/app', icon: '/api/account/plugins/acme/a/icon' }, { plugin: 'acme', id: 'b', name: 'Second', group: 'Apps', priority: 2, uri: '/files', icon: '/api/account/plugins/acme/b/icon' }]
    ;(window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest = async () => ({ items: links })
    new Function('return ' + WHM_EXTEND_CLIENT_BINDING)()(async () => true)
    await tick()
    expect($('[data-account-plugins]').hidden).toBe(false)
    expect([...document.querySelectorAll('[data-account-plugins-list] h2')].map(node => node.textContent)).toEqual(['Apps'])
    const anchors = [...document.querySelectorAll<HTMLAnchorElement>('[data-account-plugins-list] a')]
    expect(anchors.map(anchor => [anchor.getAttribute('href'), anchor.rel, anchor.textContent])).toEqual([['https://example.test/app', 'noopener noreferrer', 'First'], ['/files', '', 'Second']])
    expect(anchors[0]!.querySelector('img')!.getAttribute('src')).toBe('/api/account/plugins/acme/a/icon')
    document.body.innerHTML = root
    ;(window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest = async () => ({ items: [{ ...links[0], uri: 'javascript:alert(1)' }] })
    new Function('return ' + WHM_EXTEND_CLIENT_BINDING)()(async () => true)
    await tick()
    expect($('[data-account-plugins]').dataset.state).toBe('failed')
    expect($('[data-account-plugins-status]').textContent).toBe('Plugins could not be read. Nothing was changed.')
    expect(document.querySelector('[data-account-plugins-list] a')).toBeNull()
    document.body.innerHTML = root
    ;(window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest = async () => { throw Object.assign(new Error('denied'), { status: 404 }) }
    new Function('return ' + WHM_EXTEND_CLIENT_BINDING)()(async () => true)
    await tick()
    expect($('[data-account-plugins]').hidden).toBe(true)
  })

  it('uploads a theme package file and shows its refusal reason', async () => {
    const themes = [{ id: 'classic', name: null, version: null, base: null, builtIn: true, state: 'installed', installedAt: null }]
    const send = vi.fn(async (method: string) => { if (method === 'POST') throw Object.assign(new Error('refused'), { status: 400, code: 'VALIDATION', details: { stateChanged: false, reason: 'insufficient_contrast' } }); return { themes } })
    boot(theme, '/whm/panel/branding', send)
    await tick()
    expect(cells('[data-theme-packages-rows]')).toEqual([['Classic', 'Built in', 'Not read', 'With this release', 'Installed']])
    const input = $<HTMLInputElement>('[data-theme-packages-file]')
    Object.defineProperty(input, 'files', { value: [new File(['{"format":"xpanel-theme-package-v1"}'], 'acme.json', { type: 'application/json' })] })
    input.dispatchEvent(new Event('change'))
    expect($<HTMLButtonElement>('[data-theme-packages-action="upload"]').disabled).toBe(false)
    $<HTMLButtonElement>('[data-theme-packages-action="upload"]').click()
    await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/themes', { format: 'xpanel-theme-package-v1' })
    expect($('[data-theme-packages-result]').textContent).toBe('Text and its background need a contrast ratio of at least 4.5:1.')
    choose('[data-theme-packages-select]', 'classic')
    expect($<HTMLButtonElement>('[data-theme-packages-action="delete"]').disabled).toBe(true)
  })

  it('offers an application of the verified signed catalog', async () => {
    const host = { trust: { state: 'configured', keyIds: ['xpanel-release-2026'], reason: null }, catalog: { state: 'read', reason: null, keyId: 'xpanel-release-2026', sequence: 3, issuedAt: '2026-11-06T11:00:00.000Z', expiresAt: '2026-11-20T12:00:00.000Z', revision: R1, applications: [{ id: 'sample', name: 'Sample', versions: ['1.2.3'] }] } }
    let offered: string[] = []
    const send = vi.fn(async (method: string, _path: string, body?: unknown) => { if (method === 'PUT') offered = (body as { offered: string[] }).offered; return { host, offer: { state: offered.length ? 'saved' : 'default', offered, updatedAt: null, revision: offered.length ? R2 : R1 } } })
    boot(theme, '/whm/software/site-software', send)
    await tick()
    expect($('[data-site-software-fact="trust"]').textContent).toBe('Release signing key configured')
    expect($('[data-site-software-fact="sequence"]').textContent).toBe('3 · xpanel-release-2026')
    expect(cells('[data-site-software-rows]')).toEqual([['Sample', '1.2.3', 'Not offered']])
    choose('[data-site-software-select]', 'sample')
    $<HTMLButtonElement>('[data-site-software-action="offer"]').click()
    await tick()
    expect(send).toHaveBeenCalledWith('PUT', '/api/server/site-software', { offered: ['sample'], expectedRevision: R1 })
    expect(cells('[data-site-software-rows]')).toEqual([['Sample', '1.2.3', 'Offered to accounts']])
  })

  it('keeps every control disabled in a closed workspace, where only reads run', async () => {
    const send = vi.fn(async (_method: string, _path: string) => ({}))
    document.body.innerHTML = theme === 'classic' ? renderWhmDetailPage({ activeRoute: '/whm/panel/developer', principal: ROOT, locale: 'en', capabilityUnavailable: true })!
      : renderV2WhmPanelPage(translator('en'), { activeRoute: '/whm/panel/developer', principal: ROOT, locale: 'en' }, { canRead: false, canManage: false })!
    ;(window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest = send
    new Function('return ' + WHM_EXTEND_CLIENT_BINDING)()(async () => true)
    await tick()
    expect(send.mock.calls.every(call => call[0] === 'GET')).toBe(true)
    for (const control of document.querySelectorAll<HTMLButtonElement>('[data-hooks-workspace] button, [data-registered-apps-workspace] button')) expect(control.disabled).toBe(true)
  })
})
