// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { unqualifiedTools as tools, type CatalogTool } from '@xpanel/catalog'
import { defaultPlan, type Account, type Domain } from '@xpanel/core'
import { ACCOUNT_HTACCESS_CLIENT_BINDING, type HtaccessClientView } from './account-htaccess-client.ts'
import { renderApprovedXpanelWorkspace } from './board-port/approved-xpanel-workspaces.ts'
import { projectPanelSurface } from './models/theme-surface.ts'
import { createV2PanelSurface } from './themes/v2/surfaces/xpanel.ts'
import { renderV2PanelHtaccessPage } from './themes/v2/pages/xpanel/software/htaccess.ts'
import type { PanelSurfaceProps } from './themes/contract.ts'

const account: Account = { id: '11111111-1111-4111-8111-111111111111', username: 'alice', uid: 20041, gid: 20041, home: '/home/alice', primaryDomain: 'alice.example.test', planId: '33333333-3333-4333-8333-333333333333', ownerId: null, status: 'active', suspendReason: null, contactEmail: 'owner@example.test', ipv4: '192.0.2.41', shell: 'none', createdAt: '2026-10-30T00:00:00Z' }
const domain: Domain = { id: '22222222-2222-4222-8222-222222222222', accountId: account.id, name: account.primaryDomain, kind: 'primary', parentId: null, docRoot: '/home/alice/public_html', siteType: 'php', upstream: null, redirect: null, php: { version: '8.3', handler: 'fpm', ini: {}, fpm: { mode: 'ondemand', maxChildren: 4, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 500, processIdleTimeoutSec: 10 } }, wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited' }
const newId = 'domain-htaccess', basePath = '/api/domains/' + domain.id + '/htaccess'
// Only the bounded owner core is synthetically qualified; aaPanel remains researched.
const catalog: CatalogTool[] = tools.map(tool => tool.id === newId ? { ...tool, status: 'verified', delivery: { ...tool.delivery, status: 'verified', evidence: [] } } : tool)
const props = (patch: Partial<PanelSurfaceProps> = {}): PanelSurfaceProps => ({ activeRoute: '/software/htaccess', account, plan: defaultPlan({ id: account.planId, name: 'Fixture plan' }), domains: [domain], activeDomain: domain.name, catalog, visibility: { principal: { kind: 'user', id: '44444444-4444-4444-8444-444444444444', username: account.username, accountId: account.id }, disabledFeatures: new Set() }, ...patch })
const v2 = createV2PanelSurface(projectPanelSurface, () => '<section data-owner-core-denied></section>')
const render = (theme: 'classic' | 'v2', input: PanelSurfaceProps): HTMLElement => {
  document.body.innerHTML = theme === 'v2' ? v2(input) : renderApprovedXpanelWorkspace({ ...input, route: '/software/htaccess', locale: input.locale ?? 'en', readOnly: false }) ?? ''
  return document.body
}
const observed = (content = '# kept\n', revision = 'a'.repeat(64)): HtaccessClientView => ({ context: { accountId: account.id, domainId: domain.id, domainName: domain.name, path: 'public_html/.htaccess', engine: 'apache', phpHandler: 'fpm' }, document: { exists: true, content, sizeBytes: new TextEncoder().encode(content).length, mtime: '2026-10-30T12:00:00Z', revision }, versions: [], capabilities: { canSave: true, canValidate: true, canRestore: true, canMigrate: false, reason: null }, policy: { valid: true, issues: [], phpLines: [] }, application: { status: 'read', nativeQualified: false, syntaxChecked: false, httpStatus: null }, reviewRequired: false })
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const listeners: EventListener[] = []
function bind(confirm: (options: Record<string, unknown>) => Promise<boolean>) {
  const add = window.addEventListener.bind(window)
  vi.spyOn(window, 'addEventListener').mockImplementation((name, callback, options) => { if (name === 'beforeunload') listeners.push(callback as EventListener); add(name, callback, options) })
  const binding = new Function('return ' + ACCOUNT_HTACCESS_CLIENT_BINDING)() as (ask: unknown) => void
  binding(confirm)
}
afterEach(() => { for (const listener of listeners.splice(0)) window.removeEventListener('beforeunload', listener); vi.restoreAllMocks(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; document.body.replaceChildren(); document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr' })

for (const theme of ['classic', 'v2'] as const) describe(theme + ' bounded owner htaccess', () => {
  it.each(['en', 'ar'] as const)('binds actual %s read/validate/save/restore markup with captured revisions and truthful PHP absence', async locale => {
    let current = observed(); const kept = current.document.content, draft = '# draft\nRewriteEngine On\n'
    const versionId = '55555555-5555-4555-8555-555555555555'
    const request = vi.fn(async (method: string, path: string, body?: unknown) => {
      if (method === 'GET' && path === basePath) return clone(current)
      if (method === 'POST' && path === basePath) { expect(body).toEqual({ content: draft, expectedRevision: 'a'.repeat(64) }); return { ...clone(current), validation: { valid: true, nativeChecked: true, issues: [], checkedAt: '2026-10-30T12:00:01Z' } } }
      if (method === 'PUT' && path === basePath) {
        expect(body).toEqual({ content: draft, expectedRevision: 'a'.repeat(64) }); current = observed(draft, 'b'.repeat(64))
        current.versions = [{ id: versionId, at: '2026-10-30T12:00:00Z', actor: 'Synthetic owner', sizeBytes: new TextEncoder().encode(kept).length, revision: 'a'.repeat(64), state: 'kept', current: false, canRestore: true }]
        return { ...clone(current), application: { status: 'saved', nativeQualified: false, syntaxChecked: true, httpStatus: 200 } }
      }
      if (method === 'POST' && path === basePath + '/restore') { expect(body).toEqual({ versionId, expectedRevision: 'b'.repeat(64) }); current = observed(kept, 'c'.repeat(64)); return { ...clone(current), application: { status: 'restored', nativeQualified: false, syntaxChecked: true, httpStatus: 200 } } }
      throw new Error('Unexpected bounded rewrite transport ' + method + ' ' + path)
    })
    ;(window as Window & { xpanelSessionRequest?: typeof request }).xpanelSessionRequest = request
    const root = render(theme, props({ locale })), workspace = root.querySelector<HTMLElement>('[data-htaccess-workspace]')!
    expect(root.querySelectorAll('[data-htaccess-workspace]')).toHaveLength(1)
    expect(workspace.dataset.htaccessManage).toBe('true')
    expect(workspace.querySelectorAll('template[data-xp-template]')).toHaveLength(5)
    const ids = [...root.querySelectorAll<HTMLElement>('[id]')].map(element => element.id); expect(new Set(ids).size).toBe(ids.length)
    for (const key of ['editor', 'gutter', 'preset', 'refresh', 'validate', 'save', 'migrate', 'discard', 'php-before', 'php-after', 'php-rows', 'undo-migration', 'versions']) expect(workspace.querySelector('[data-htaccess-' + key + ']')).not.toBeNull()
    const confirm = vi.fn(async (_options: Record<string, unknown>) => true); bind(confirm)
    const editor = workspace.querySelector<HTMLTextAreaElement>('[data-htaccess-editor]')!
    await vi.waitFor(() => expect(editor.readOnly).toBe(false))
    expect(editor.value).toBe(kept)
    expect(workspace.querySelector<HTMLButtonElement>('[data-htaccess-migrate]')!.disabled).toBe(true)
    expect(workspace.querySelector<HTMLButtonElement>('[data-htaccess-undo-migration]')!.disabled).toBe(true)
    editor.value = draft; editor.dispatchEvent(new Event('input'))
    workspace.querySelector<HTMLButtonElement>('[data-htaccess-validate]')!.click()
    await vi.waitFor(() => expect(request.mock.calls.some(call => call[0] === 'POST')).toBe(true))
    await vi.waitFor(() => expect(workspace.querySelector<HTMLButtonElement>('[data-htaccess-save]')!.disabled).toBe(false))
    workspace.querySelector<HTMLButtonElement>('[data-htaccess-save]')!.click()
    await vi.waitFor(() => expect(request.mock.calls.map(call => call[0])).toEqual(['GET', 'POST', 'PUT', 'GET']))
    await vi.waitFor(() => expect(workspace.querySelector<HTMLButtonElement>('[data-htaccess-versions] button')!.disabled).toBe(false))
    workspace.querySelector<HTMLButtonElement>('[data-htaccess-versions] button')!.click()
    await vi.waitFor(() => expect(request.mock.calls.map(call => call[0])).toEqual(['GET', 'POST', 'PUT', 'GET', 'POST', 'GET']))
    await vi.waitFor(() => expect(editor.value).toBe(kept))
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(workspace.querySelector<HTMLButtonElement>('[data-htaccess-migrate]')!.disabled).toBe(true)
    expect(root.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
  it.each(['domain-htaccess', 'aapanel-url-rewrite', 'missing-policy', 'unqualified', 'foreign-account', 'team-no-tool'] as const)('starts no request for %s', denial => {
    const current = props(); let patch: Partial<PanelSurfaceProps>
    if (denial === 'missing-policy') patch = { visibility: { principal: current.visibility!.principal } }
    else if (denial === 'unqualified') patch = { catalog: tools }
    else if (denial === 'foreign-account') patch = { visibility: { ...current.visibility!, principal: { kind: 'user', id: 'foreign', username: 'bob', accountId: '66666666-6666-4666-8666-666666666666' } } }
    else if (denial === 'team-no-tool') patch = { visibility: { ...current.visibility!, allowedToolIds: new Set<string>() } }
    else patch = { visibility: { ...current.visibility!, disabledFeatures: new Set([denial]) } }
    const request = vi.fn(async () => clone(observed())); (window as Window & { xpanelSessionRequest?: typeof request }).xpanelSessionRequest = request
    const root = render(theme, props(patch)); bind(async () => true)
    expect(root.querySelector<HTMLElement>('[data-htaccess-workspace]')?.dataset.htaccessManage).not.toBe('true')
    expect(request).not.toHaveBeenCalled()
  })
  it.each(['missing-template', 'duplicate-template', 'wrong-root', 'wrong-slot-tag'] as const)('fails typed preflight before the first GET for %s', defect => {
    const request = vi.fn(async () => clone(observed())); (window as Window & { xpanelSessionRequest?: typeof request }).xpanelSessionRequest = request
    const root = render(theme, props()), workspace = root.querySelector<HTMLElement>('[data-htaccess-workspace]')!
    const template = workspace.querySelector<HTMLTemplateElement>('template[data-xp-template="htaccess-version"]')!
    if (defect === 'missing-template') template.remove()
    if (defect === 'duplicate-template') template.after(template.cloneNode(true))
    if (defect === 'wrong-root') { const wrong = document.createElement('div'); wrong.append(...template.content.childNodes); template.content.replaceChildren(wrong) }
    if (defect === 'wrong-slot-tag') { const old = template.content.querySelector('[data-xp-slot="restore"]')!, wrong = document.createElement('span'); wrong.setAttribute('data-xp-slot', 'restore'); old.replaceWith(wrong) }
    bind(async () => true)
    expect(request).not.toHaveBeenCalled()
    expect(workspace.querySelector<HTMLElement>('[data-htaccess-status]')!.dataset.state).toBe('unavailable')
    expect(workspace.querySelector<HTMLTextAreaElement>('[data-htaccess-editor]')!.readOnly).toBe(true)
    expect([...workspace.querySelectorAll<HTMLButtonElement>('button')].every(button => button.disabled)).toBe(true)
  })
})
it('retains the full V2 unqualified presentation and the explicit no-operation explanation', () => {
  document.body.innerHTML = renderV2PanelHtaccessPage(props({ catalog: tools }))
  expect(document.querySelector<HTMLElement>('[data-htaccess-workspace]')!.dataset.htaccessManage).toBe('false')
  for (const key of ['editor', 'validate', 'save', 'migrate', 'php-before', 'php-after', 'versions']) expect(document.querySelector('[data-htaccess-' + key + ']')).not.toBeNull()
  expect(document.body.textContent).toContain('This route is not qualified for file changes.')
})
