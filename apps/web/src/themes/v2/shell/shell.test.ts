import { describe, expect, it } from 'vitest'
import { tools, type VisibilityContext } from '@xpanel/catalog'
import type { Locale } from '../../../i18n.ts'
import { v2Messages } from '../messages.ts'
import { renderV2Document } from '../document.ts'
import { renderV2Shell, type V2ShellProps } from './shell.ts'

// Every tool qualified, so the sidebar shows the full role-filtered navigation.
const catalog = tools.map(tool => ({ ...tool, status: 'verified' as const, delivery: { ...tool.delivery, status: 'verified' as const } }))
const root: VisibilityContext = { principal: { kind: 'root', id: 'r1', username: 'root' } }
const owner: VisibilityContext = { principal: { kind: 'user', id: 'u1', username: 'alice', accountId: 'a1' }, disabledFeatures: new Set() }

const shell = (locale: Locale = 'en', overrides: Partial<V2ShellProps> = {}): string => renderV2Shell(v2Messages.translator(locale), {
  surface: 'xwhm', activeRoute: '/whm/accounts', homeHref: '/whm', visibility: root, catalog,
  realtimeEnabled: true, server: { name: 'srv1.xpanel.test', generationId: 142 }, languages: [{ tag: locale === 'en' ? 'ar' : 'en', href: '/whm/accounts?lang=ar' }],
  scheme: { current: 'dark', toggleHref: '/whm/accounts?theme=light' }, unread: 3,
  account: { signedIn: true, username: 'root', roleLabel: 'Server administrator', securityHref: '/whm/security/sign-in' },
  contentHtml: '<h1>Accounts</h1>',
  commandPalette: { entries: [{ key: 'k1', kind: 'page', label: 'Accounts', section: 'Accounts', route: '/whm/accounts', href: '/whm/accounts', hint: '/whm/accounts', search: 'accounts', persistable: true }] },
  activity: { generation: { id: 142, applied: true } },
  reconcile: { generationId: 143, status: 'running', observed: true, stages: ['render', 'test', 'switch', 'reload', 'verify'].map(stage => ({ stage, label: stage, status: 'pending' as const })) },
  ...overrides,
})

// The stable semantic shell hooks the realtime runtime binds to.
const CONTRACT = {
  attributes: ['data-xp-sidebar', 'data-xp-toolbar-options', 'data-xp-nav-backdrop', 'data-nav-route', 'data-ws-indicator'],
  actions: ['open-cmdk', 'toggle-mobile-nav', 'close-mobile-nav', 'logout', 'close-activity-drawer'],
  ids: ['main-content', 'xp-cmdk-modal', 'xp-activity-drawer', 'xp-reconcile-banner', 'xp-toast-region'],
  documentAttributes: ['data-theme', 'data-surface', 'data-realtime-enabled'],
} as const

describe('v2 shell', () => {
  it('emits every hook of the realtime shell contract', () => {
    const html = shell()
    for (const name of CONTRACT.attributes) expect(html, name).toMatch(new RegExp(`\\s${name}(?:[\\s=>])`))
    for (const action of CONTRACT.actions) expect(html, action).toContain(`data-action="${action}"`)
    for (const id of CONTRACT.ids) expect(html.match(new RegExp(`\\sid="${id}"`, 'g')), id).toHaveLength(1)
    const document = renderV2Document({ htmlAttributes: 'lang="en" dir="ltr" data-theme="dark" data-surface="xwhm" data-realtime-enabled="true"', htmlAttributeSuffix: ' data-ui-theme="v2"', faviconHref: '/favicon.svg', headHtml: '', title: 'Accounts', bodyHtml: html })
    const htmlTag = document.match(/<html[^>]*>/)![0]
    for (const name of CONTRACT.documentAttributes) expect(htmlTag, name).toContain(` ${name}="`)
  })

  it('keeps the element shapes the runtime relies on', () => {
    const html = shell()
    expect(html).toMatch(/<aside class="v2-side" id="xp-sidebar" data-xp-sidebar tabindex="-1" aria-label="xWHM navigation">/)
    expect(html).toMatch(/data-action="toggle-mobile-nav" aria-controls="xp-sidebar" aria-expanded="false"/)
    expect(html).toMatch(/<button type="button" class="v2-backdrop" data-action="close-mobile-nav" data-xp-nav-backdrop hidden tabindex="-1" aria-label="[^"]+"><\/button>/)
    expect(html).toMatch(/<details class="v2-tools" open data-xp-toolbar-options><summary class="v2-btn">/)
    expect(html).toMatch(/<main id="main-content" class="v2-main" tabindex="-1">/)
    expect(html.match(/<main\b/g)).toHaveLength(1)
    expect(html).toContain('<a class="v2-skip" href="#main-content">Skip to content</a>')
    expect(html).toMatch(/data-ws-indicator="disconnected" role="status"/)
    expect(shell('en', { realtimeEnabled: false })).toMatch(/data-ws-indicator="unavailable" role="status" aria-label="Live updates off"/)
    expect(html).toMatch(/data-action="open-cmdk" aria-keyshortcuts="Control\+K Meta\+K"/)
    expect(html).toMatch(/data-action="open-activity-drawer" aria-controls="xp-activity-drawer" aria-label="Notifications, 3 unread"/)
    expect(html).toContain('data-generation-chip="142"')
    expect(html).toMatch(/<a class="v2-btn v2-top__lang" href="\/whm\/accounts\?lang=ar" lang="ar" hreflang="ar" data-lang-switch="ar">/)
    expect(html).toContain('data-theme-toggle="light" aria-label="Light theme"')
    expect(html).toMatch(/<details class="v2-account" data-user-menu>.*data-security-link="true".*<button type="button" class="v2-menu__item v2-menu__item--danger" data-action="logout">Sign out<\/button>/s)
    expect(shell('en', { account: { signedIn: false, signInHref: '/login' } })).not.toContain('data-action="logout"')
  })

  it('renders the quick bar, activity drawer and reconcile banner hooks', () => {
    const html = shell()
    for (const hook of ['data-xp-cmdk="true"', 'data-cmdk-surface="xwhm"', 'data-cmdk-search="true"', 'data-cmdk-results', 'data-cmdk-empty', 'data-cmdk-status', 'data-count-label="Results"',
      'data-cmdk-history', 'data-cmdk-favorites', 'data-cmdk-favorites-section', 'data-cmdk-recents', 'data-cmdk-recents-section', 'data-cmdk-scope="all"', 'data-action="close-cmdk"',
      'data-cmdk-group="page"', 'data-cmdk-row', 'data-cmdk-item="/whm/accounts"', 'data-cmdk-kind="page"', 'data-cmdk-key="k1"', 'data-cmdk-persistable="true"', 'data-cmdk-search-text="accounts"', 'data-cmdk-favorite="/whm/accounts"']) {
      expect(html, hook).toContain(hook)
    }
    expect(html).toMatch(/<div id="xp-cmdk-modal"[^>]* hidden role="dialog" aria-modal="true" aria-labelledby="xp-cmdk-title">/)
    expect(html).toMatch(/<input id="xp-cmdk-input" type="search" data-xp-filter-input="true" data-cmdk-search="true" role="combobox"[^>]*aria-controls="xp-cmdk-results"/)
    expect(html).toMatch(/<a id="xp-cmdk-option-0"[^>]*role="option" aria-selected="false" tabindex="-1">.*<strong>Accounts<\/strong>/)
    expect(html).toMatch(/<div id="xp-activity-drawer"[^>]* data-xp-drawer="activity" hidden role="dialog" aria-modal="true" aria-labelledby="xp-activity-drawer-title">/)
    expect(html).toMatch(/<section id="xp-reconcile-banner"[^>]* data-reconcile-banner="true" data-generation-id="143" data-reconcile-status="running" aria-labelledby="xp-reconcile-title">/)
    for (const stage of ['render', 'test', 'switch', 'reload', 'verify']) expect(html).toMatch(new RegExp(`data-step-status="pending" data-stage="${stage}"`))
  })

  it('builds collapsible sections from the role-filtered catalog with the current route marked', () => {
    const html = shell()
    const routes = [...html.matchAll(/<a href="([^"]+)" data-nav-route="([^"]+)"/g)]
    expect(routes.length).toBeGreaterThan(10)
    for (const [, href, route] of routes) expect(href).toBe(route)
    expect(html.match(/aria-current="page"/g)).toHaveLength(1)
    expect(html).toContain('<a href="/whm/accounts" data-nav-route="/whm/accounts" aria-current="page">')
    expect(html).toMatch(/<details open><summary>[^]*?<span>Accounts<\/span>/)
    expect(routes.every(([, , route]) => route!.startsWith('/whm'))).toBe(true)
    // An account owner never sees xWHM pages, and nothing is listed without visibility.
    const ownerHtml = shell('en', { surface: 'xpanel', activeRoute: '/home', homeHref: '/home', visibility: owner })
    expect(ownerHtml).toContain('data-nav-route="/home" aria-current="page"')
    expect(ownerHtml).not.toContain('data-nav-route="/whm')
    expect(shell('en', { visibility: undefined })).toContain('data-navigation-empty="true"')
  })

  it('renders right-to-left Arabic through the translator with ASCII digits', () => {
    const html = shell('ar')
    expect(html).toMatch(/[؀-ۿ]/)
    expect(html).not.toMatch(/[٠-٩۰-۹]/)
    expect(html).toContain('class="v2-icon v2-nav__chev v2-flip"')
    const document = renderV2Document({ htmlAttributes: 'lang="ar" dir="rtl" data-theme="light"', htmlAttributeSuffix: ' data-ui-theme="v2"', faviconHref: '/favicon.svg', headHtml: '', title: 'x', bodyHtml: html })
    expect(document).toContain('<html lang="ar" dir="rtl" data-theme="light" data-ui-theme="v2">')
  })
})
