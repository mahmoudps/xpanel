import { describe, expect, it } from 'vitest'
import { tools, type CatalogTool } from '@xpanel/catalog'
import { defaultPlan, type Account } from '@xpanel/core'
import { renderWebApp, serveWebUi, unavailableView, type WebAppRenderState } from '../app.ts'
import { roleLabel } from '../chrome.ts'
import { projectPanelSurface } from '../models/theme-surface.ts'
import type { PanelSurfaceProps, ThemeViewProps, UnavailableProps } from './contract.ts'
import { parseMarkup, type MarkupNode } from './markup.ts'
import { createV2PanelSurface } from './v2/surfaces/xpanel.ts'
import { v2Messages } from './v2/messages.ts'

const account: Account = {
  id: 'owner-record', username: 'alice', uid: 20031, gid: 20031, home: '/home/alice',
  primaryDomain: 'alice.test', planId: 'owner-plan', ownerId: null, status: 'active',
  suspendReason: null, contactEmail: 'owner@alice.test', ipv4: '192.0.2.31',
  shell: 'none', createdAt: '2026-10-22T00:00:00Z',
}
const visibility = {
  principal: { kind: 'user' as const, id: 'owner-principal', username: account.username, accountId: account.id },
  disabledFeatures: new Set<string>(),
}
const unverified = tools.map(tool => ({ ...tool, status: 'implemented' as const, delivery: { ...tool.delivery, status: 'implemented' as const } }))
const qualified = tools.map(tool => ({ ...tool, status: 'verified' as const, delivery: { ...tool.delivery, status: 'verified' as const } }))
const state = (locale: 'en' | 'ar', catalog: readonly CatalogTool[] = unverified): WebAppRenderState => ({
  surface: 'xpanel', uiTheme: 'v2', locale, accountId: account.id, visibility, catalog,
  panel: { account, plan: defaultPlan({ id: account.planId, name: 'Owner plan' }) },
})
const under = (nodes: readonly MarkupNode[], node: MarkupNode, ancestor: MarkupNode): boolean => {
  const at = nodes.indexOf(ancestor)
  for (let parent = node.parent; parent >= 0; parent = nodes[parent]!.parent) if (parent === at) return true
  return false
}
const accountMenu = (html: string) => {
  const nodes = parseMarkup(html)
  const menus = nodes.filter(node => node.namespace === 'html' && node.template < 0 && node.tag === 'details' && node.attrs.has('data-user-menu'))
  expect(menus).toHaveLength(1)
  const menu = menus[0]!
  return { nodes, menu, children: nodes.filter(node => under(nodes, node, menu)) }
}

const expectPersonalHref = (href: string | undefined, pathname: string, locale: 'en' | 'ar', input: WebAppRenderState): void => {
  // Normal core document links preserve locale, appearance and this owning account.
  expect(href).toMatch(/^\/(?!\/)/)
  const url = new URL(href!, 'http://localhost')
  expect(url.origin).toBe('http://localhost')
  expect(url.username).toBe('')
  expect(url.password).toBe('')
  expect(url.pathname).toBe(pathname)
  expect(url.hash).toBe('')
  expect([...url.searchParams.keys()].sort()).toEqual(['accountId', 'density', 'lang', 'theme'])
  expect(url.searchParams.getAll('lang')).toEqual([locale])
  expect(url.searchParams.getAll('theme')).toEqual([input.theme ?? 'light'])
  expect(url.searchParams.getAll('density')).toEqual([input.density ?? 'comfortable'])
  expect(input.accountId).toBe(account.id)
  expect(url.searchParams.getAll('accountId')).toEqual([input.accountId])
}

describe('normal V2 owner personal navigation', () => {
  const homeCases = (['en', 'ar'] as const).flatMap(locale =>
    (['/home', '/panel'] as const).flatMap(path =>
      (['unverified', 'empty'] as const).map(catalogState => ({ locale, path, catalogState }))))

  it.each(homeCases)('preserves the signed-in menu on $path in $locale with $catalogState capabilities', async ({ locale, path, catalogState }) => {
    const input = state(locale, catalogState === 'empty' ? [] : unverified)
    const response = await serveWebUi(new Request('http://localhost' + path + '?lang=' + locale), () => input)
    expect(response.status).toBe(200)
    const html = await response.text()
    const { children } = accountMenu(html)
    const summary = children.find(node => node.tag === 'summary')!
    expect(summary.attrs.get('aria-label')).toContain(account.username)
    expect(summary.attrs.get('aria-label')).toContain(roleLabel('user', locale))
    const security = children.filter(node => node.tag === 'a' && node.attrs.has('data-security-link'))
    expect(security).toHaveLength(1)
    expectPersonalHref(security[0]!.attrs.get('href'), '/security/account', locale, input)
    const nodes = parseMarkup(html)
    const toolRoots = nodes.filter(node => node.namespace === 'html' && node.template < 0 && node.attrs.has('data-home-tools'))
    expect(toolRoots).toHaveLength(1)
    const toolNodes = nodes.filter(node => node.attrs.has('data-tool-capability'))
    for (const tool of toolNodes) {
      expect(tool.namespace).toBe('html')
      expect(tool.template).toBeLessThan(0)
      expect(under(nodes, tool, toolRoots[0]!)).toBe(true)
    }
    for (const native of toolNodes.filter(node => !['change-language', 'two-factor-auth', 'api-tokens', 'password-security'].includes(node.attrs.get('data-tool-capability')!))) {
      expect(native.tag).toBe('button')
      expect(native.attrs.has('disabled')).toBe(true)
      expect(native.attrs.has('href')).toBe(false)
    }
    if (catalogState === 'unverified') {
      const t = v2Messages.translator(locale)
      for (const id of ['change-language', 'two-factor-auth', 'api-tokens', 'password-security']) {
        const links = toolNodes.filter(node => node.attrs.get('data-tool-capability') === id)
        expect(links, id).toHaveLength(id === 'password-security' ? 2 : 1)
        if (id === 'password-security') {
          // The approved Password and Contact email cards share document authority, not card identity.
          expect(links.map(link => link.attrs.get('data-tool-keys')).sort()).toEqual([
            t('Password') + ' password change sign-in',
            t('Contact email') + ' notifications contact email',
          ].sort())
        }
        for (const link of links) {
          expect(link.tag, id).toBe('a')
          expectPersonalHref(link.attrs.get('href'), id === 'change-language' ? '/home' : '/security/account',
            id === 'change-language' ? (locale === 'en' ? 'ar' : 'en') : locale, input)
        }
      }
    }
  })

  it.each(['en', 'ar'] as const)('passes the matching core role to another live panel document in %s', locale => {
    const input = { ...state(locale, qualified), activeRoute: '/resources' }
    const html = renderWebApp(input)
    const { children } = accountMenu(html)
    expect(children.find(node => node.tag === 'summary')!.attrs.get('aria-label')).toContain(roleLabel('user', locale))
    const security = children.filter(node => node.tag === 'a' && node.attrs.has('data-security-link'))
    expect(security).toHaveLength(1)
    expectPersonalHref(security[0]!.attrs.get('href'), '/security/account', locale, input)
  })
})

describe('V2 personal-menu identity boundary', () => {
  const renderPanel = createV2PanelSurface(projectPanelSurface, () => '<section data-core-panel-denied></section>')
  const props = (): PanelSurfaceProps & ThemeViewProps => ({
    ...state('en', qualified).panel!, locale: 'en', visibility, catalog: qualified, activeRoute: '/home',
  })
  const descriptor = (): UnavailableProps => unavailableView(state('en', qualified), 'en', 'light', 'comfortable', '/home')
  const foreignRole = 'FOREIGN_ROLE_MARKER'

  it.each(['missing-descriptor', 'missing-identity', 'foreign-username', 'foreign-account', 'foreign-principal', 'higher-role-principal'] as const)(
    'does not forward a role from %s',
    variant => {
      let view: UnavailableProps | undefined = descriptor()
      if (variant === 'missing-descriptor') view = undefined
      else {
        view = { ...view, session: { ...view.session!, role: foreignRole } }
        if (variant === 'missing-identity') view = { ...view, visibility: undefined }
        if (variant === 'foreign-username') view = { ...view, session: { ...view.session!, username: 'other' } }
        if (variant === 'foreign-account') view = { ...view, session: { ...view.session!, accountId: 'another-account' } }
        if (variant === 'foreign-principal') view = { ...view, visibility: { ...visibility, principal: { ...visibility.principal, id: 'another-principal' } } }
        if (variant === 'higher-role-principal') view = { ...view, visibility: { principal: { kind: 'root', id: visibility.principal.id, username: account.username } } }
      }
      const html = renderPanel({ ...props(), unavailableView: view })
      const { children } = accountMenu(html)
      expect(html).not.toContain(foreignRole)
      expect(children.find(node => node.tag === 'summary')!.attrs.get('aria-label')).not.toContain(roleLabel('user', 'en'))
    },
  )

  it.each(['foreign-account', 'missing-visibility', 'operator-principal'] as const)('does not construct an owning live shell for %s', variant => {
    const input = props()
    const html = renderPanel(variant === 'foreign-account'
      ? { ...input, account: { ...account, id: 'another-account' } }
      : variant === 'missing-visibility'
        ? { ...input, visibility: undefined }
        : { ...input, visibility: { principal: { kind: 'root', id: 'operator', username: 'root' } } })
    expect(html).toBe('<section data-core-panel-denied></section>')
    expect(html).not.toContain('data-user-menu')
    expect(html).not.toContain(account.primaryDomain)
  })
})