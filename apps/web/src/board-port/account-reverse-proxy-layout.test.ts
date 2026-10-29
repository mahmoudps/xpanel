// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canOpenRegisteredRoute, tools, visibleNavigation } from '@xpanel/catalog'
import type { Account, Domain } from '@xpanel/core'
import { renderAccountReverseProxyWorkspace } from './account-reverse-proxy-workspace.ts'
import { renderApprovedXpanelWorkspace } from './approved-xpanel-workspaces.ts'
import { ACCOUNT_REVERSE_PROXY_CLIENT_BINDING } from '../account-reverse-proxy-client.ts'
import { resolveWebDocumentRoute } from '../document-routes.ts'

const accountId = '11111111-1111-4111-8111-111111111111'
const owner = { principal: { kind: 'user' as const, id: '22222222-2222-4222-8222-222222222222', accountId, username: 'privateowner' }, disabledFeatures: new Set<string>() }
afterEach(() => { document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; vi.restoreAllMocks() })

describe('existing reverse-proxy presentation remains inert without a provider', () => {
  it('already registers and role-admits the document while keeping the owner capability unavailable', () => {
    expect(resolveWebDocumentRoute('/domains/reverse-proxy')).toEqual({ surface: 'xpanel', activeRoute: '/domains/reverse-proxy' })
    expect(canOpenRegisteredRoute('/domains/reverse-proxy', owner)).toBe(true)
    const catalog = tools.map(tool => ({ ...tool, status: 'verified' as const }))
    const routes = visibleNavigation(owner, catalog).flatMap(surface => surface.sections.flatMap(section => section.pages.map(page => page.route)))
    expect(routes).not.toContain('/domains/reverse-proxy')
  })

  it.each(['en', 'ar'] as const)('retains every existing card with blank identity and no transport under %s', async lang => {
    await assertInertBinding(renderAccountReverseProxyWorkspace({ lang, accountId: '', home: '', canManage: false }), lang)
  })

  it.each([['en', true], ['en', false], ['ar', true], ['ar', false]] as const)('opens the %s workspace for the owner only outside read-only mode (readOnly=%s) on a qualified catalog', async (lang, readOnly) => {
    const account = { id: accountId, username: 'privateowner', home: '/home/privateowner', status: 'active', primaryDomain: 'private.example.test' } as Account
    const domain = { id: '33333333-3333-4333-8333-333333333333', accountId, name: account.primaryDomain, docRoot: '/home/privateowner/public_html' } as Domain
    const html = renderApprovedXpanelWorkspace({ route: '/domains/reverse-proxy', locale: lang, readOnly, account, domains: [domain], activeDomain: domain.name,
      visibility: owner, catalog: tools.map(tool => ({ ...tool, status: 'verified' as const })), nativeHtml: '<div>private-native-metadata</div>' })!
    document.body.innerHTML = html
    expect(document.querySelectorAll('h1')).toHaveLength(1)
    const wrapper = document.querySelector<HTMLElement>('[data-approved-xpanel-workspace="/domains/reverse-proxy"]')!
    expect(html).not.toContain('private-native-metadata')
    if (!readOnly) {
      const root = document.querySelector<HTMLElement>('[data-reverse-proxy]')!
      expect(wrapper.dataset.workspaceMode).toBe('connected'); expect(wrapper.dataset.wiring).toBeUndefined()
      expect(root.dataset.rpAccount).toBe(accountId); expect(root.dataset.rpHome).toBe(account.home); expect(root.dataset.rpManage).toBe('true')
      return
    }
    expect(wrapper.dataset.workspaceMode).toBe('read-only'); expect(wrapper.dataset.wiring).toBe('soon')
    for (const value of [accountId, domain.id, account.username, account.home, domain.name]) expect(html).not.toContain(value)
    await assertInertBinding(html, lang)
  })
})

async function assertInertBinding(html: string, lang: 'en' | 'ar'): Promise<void> {
    document.body.innerHTML = `<section data-wiring="unavailable" data-capability-unavailable="true">${html}</section>`
    const root = document.querySelector<HTMLElement>('[data-reverse-proxy]')!
    expect(root.dataset.rpAccount).toBe(''); expect(root.dataset.rpHome).toBe(''); expect(root.dataset.rpManage).toBe('false')
    expect(root.querySelectorAll('.xp-acct-tool__card')).toHaveLength(4)
    for (const heading of ['rp-sites', 'rp-change', 'rp-steps', 'rp-limits']) expect(root.querySelector('#' + heading)).not.toBeNull()
    expect(root.querySelectorAll('form')).toHaveLength(0)
    const controls = [...root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select')]
    expect(controls.length).toBeGreaterThan(0); expect(controls.every(control => control.disabled)).toBe(true)
    const request = vi.fn(async () => { throw new Error('unexpected_transport') }), confirm = vi.fn(async () => true)
    ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
    ;(new Function('return ' + ACCOUNT_REVERSE_PROXY_CLIENT_BINDING)() as (ask: unknown) => void)(confirm)
    for (const control of controls) {
      control.dispatchEvent(new Event('input', { bubbles: true })); control.dispatchEvent(new Event('change', { bubbles: true })); control.dispatchEvent(new MouseEvent('click', { bubbles: true })); control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    }
    await Promise.resolve(); await Promise.resolve()
    expect(request).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled(); expect(controls.every(control => control.disabled)).toBe(true)
    expect(root.querySelector('[data-rp-status]')?.getAttribute('data-state')).toBe('unavailable')
    expect(html).not.toContain(accountId); expect(html).not.toContain('privateowner')
}
