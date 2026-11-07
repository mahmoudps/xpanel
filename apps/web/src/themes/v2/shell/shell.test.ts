import { describe, expect, it } from 'vitest'
import { canOpenRegisteredRoute, isToolAuthorized, tools, type CatalogTool, type VisibilityContext } from '@xpanel/catalog'
import type { Locale } from '../../../i18n.ts'
import { v2Messages } from '../messages.ts'
import { renderV2Document } from '../document.ts'
import { renderV2Shell, SHELL_CSS, type V2ShellProps } from './shell.ts'

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
  it('uses surface-owned navigation and search without duplicating shell landmarks', () => {
    const html = shell('en', {
      surface: 'xmail', homeHref: '/mail/inbox', activeRoute: '/mail/inbox',
      sidebarHtml: '<nav data-mail-folders>Folders</nav>',
      contextControlHtml: '<select data-authorized-domain><option>example.test</option></select>',
      searchHtml: '<input type="search" data-mail-search aria-label="Search messages">',
    })
    expect(html).toContain('<nav data-mail-folders>Folders</nav>')
    expect(html).toContain('data-authorized-domain')
    expect(html).toContain('data-mail-search')
    expect(html).not.toContain('class="v2-nav"')
    expect(html).not.toContain('class="v2-search"')
    expect(html.match(/<main\b/g)).toHaveLength(1)
    expect(html.match(/id="xp-sidebar"/g)).toHaveLength(1)
    expect(html.match(/id="xp-cmdk-modal"/g)).toHaveLength(1)
  })

  it('escapes configured product identity in desktop and phone navigation', () => {
    const html = shell('en', { branding: {
      companyName: '', productName: 'Host <script>bad()</script>', footerText: '', hidePoweredBy: false,
      primaryColor: '', accentColor: '', supportUrl: '', supportEmail: '', logoUrl: null, faviconUrl: null,
    } })
    expect(html.match(/Host &lt;script&gt;bad\(\)&lt;\/script&gt;/g)).toHaveLength(3)
    expect(html).not.toContain('<script>bad()')
  })

  it('emits every hook of the realtime shell contract', () => {
    const html = shell()
    for (const name of CONTRACT.attributes) expect(html, name).toMatch(new RegExp(`\\s${name}(?:[\\s=>])`))
    for (const action of CONTRACT.actions) expect(html, action).toContain(`data-action="${action}"`)
    for (const id of CONTRACT.ids) expect(html.match(new RegExp(`\\sid="${id}"`, 'g')), id).toHaveLength(1)
    const document = renderV2Document({ htmlAttributes: 'lang="en" dir="ltr" data-theme="dark" data-surface="xwhm" data-realtime-enabled="true"', htmlAttributeSuffix: ' data-ui-theme="v2"', faviconHref: '/favicon.svg', headHtml: '', title: 'Accounts', bodyHtml: html })
    const htmlTag = document.match(/<html[^>]*>/)![0]
    for (const name of CONTRACT.documentAttributes) expect(htmlTag, name).toContain(` ${name}="`)
  })

  it('lets the search button shrink below its nowrap label on a phone', () => {
    expect(SHELL_CSS).toMatch(/\.v2-search\{[^}]*min-width:0/)
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
    expect(html).toMatch(/data-xp-activity-control="unavailable" disabled aria-disabled="true" title="Unavailable" aria-label="Activity &amp; Jobs"/)
    expect(html).not.toContain('data-action="open-activity-drawer"')
    expect(html).not.toContain('class="v2-top__badge')
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

  it.each(['en', 'ar'] satisfies readonly Locale[])('keeps approved account document navigation with no qualified tools in %s', locale => {
    const unqualifiedCatalog = tools.map((tool): CatalogTool => ({ ...tool, delivery: { ...tool.delivery, status: 'researched' } }))
    const before = JSON.stringify({ tools, unqualifiedCatalog })
    const html = shell(locale, { surface: 'xpanel', activeRoute: '/home', homeHref: '/home', visibility: owner, catalog: unqualifiedCatalog })
    const sections = [...html.matchAll(/<li data-nav-section="([^"]+)">/g)].map(match => match[1])
    expect(sections).toEqual(['general', 'email', 'files', 'databases', 'domains', 'metrics', 'security', 'software', 'advanced', 'preferences'])
    for (const route of ['/home', '/resources', '/email/accounts', '/files/manager', '/databases/mariadb', '/domains', '/metrics/traffic', '/security/account', '/software/php', '/advanced/cron', '/preferences']) {
      expect(canOpenRegisteredRoute(route, owner), route).toBe(true)
      expect(html, route).toContain(`data-nav-route="${route}"`)
    }
    expect(html).toContain('data-nav-route="/home" aria-current="page"')
    expect(html).toContain('<li data-nav-section="general"><details open>')
    expect(html).toContain('<li data-nav-section="files"><details>')
    expect(html).not.toContain('data-navigation-empty="true"')
    expect(html).not.toContain('data-nav-route="/whm')
    expect(html).not.toContain('data-nav-route="/mail/')
    expect(unqualifiedCatalog.every(tool => tool.delivery.status !== 'verified')).toBe(true)
    expect(JSON.stringify({ tools, unqualifiedCatalog })).toBe(before)
  })

  it.each(['en', 'ar'] satisfies readonly Locale[])('keeps document navigation separate from feature and team execution denials in %s', locale => {
    const unqualifiedCatalog = tools.map((tool): CatalogTool => ({ ...tool, delivery: { ...tool.delivery, status: 'researched' } }))
    const disabledFeatures = new Set(unqualifiedCatalog.flatMap(tool => tool.featureKey === null ? [] : [tool.featureKey]))
    const featureDenied: VisibilityContext = { ...owner, disabledFeatures }
    const teamDenied: VisibilityContext = { ...owner, allowedToolIds: new Set<string>() }
    const before = JSON.stringify(unqualifiedCatalog)
    expect(unqualifiedCatalog.filter(tool => tool.featureKey !== null).every(tool => !isToolAuthorized(tool, featureDenied))).toBe(true)
    expect(unqualifiedCatalog.every(tool => !isToolAuthorized(tool, teamDenied))).toBe(true)
    for (const visibility of [featureDenied, teamDenied]) {
      const html = shell(locale, { surface: 'xpanel', activeRoute: '/home', homeHref: '/home', visibility, catalog: unqualifiedCatalog })
      for (const route of ['/files/manager', '/domains', '/advanced/terminal', '/security/account']) {
        expect(canOpenRegisteredRoute(route, visibility), route).toBe(true)
        expect(html, route).toContain(`data-nav-route="${route}"`)
      }
    }
    expect(JSON.stringify(unqualifiedCatalog)).toBe(before)
  })

  it.each(['en', 'ar'] satisfies readonly Locale[])('retains registered-role and missing-caller navigation denials in %s', locale => {
    const unqualifiedCatalog = tools.map((tool): CatalogTool => ({ ...tool, delivery: { ...tool.delivery, status: 'researched' } }))
    const missing = shell(locale, { surface: 'xpanel', activeRoute: '/home', homeHref: '/home', visibility: undefined, catalog: unqualifiedCatalog })
    expect(missing).toContain('data-navigation-empty="true"')
    expect(missing).not.toContain('data-nav-route=')
    const otherRole = shell(locale, { surface: 'xpanel', activeRoute: '/home', homeHref: '/home', visibility: root, catalog: unqualifiedCatalog })
    for (const route of ['/home', '/files/manager', '/domains']) {
      expect(canOpenRegisteredRoute(route, root), route).toBe(false)
      expect(otherRole, route).not.toContain(`data-nav-route="${route}"`)
    }
    for (const match of otherRole.matchAll(/data-nav-route="([^"]+)"/g)) {
      const route = match[1]
      if (route === undefined) throw new Error('navigation_route_capture_missing')
      expect(canOpenRegisteredRoute(route, root), route).toBe(true)
    }
  })

  it.each(['en', 'ar'] satisfies readonly Locale[])('preserves WHM qualification and mailbox-owned navigation in %s', locale => {
    const unqualifiedCatalog = tools.map((tool): CatalogTool => ({ ...tool, delivery: { ...tool.delivery, status: 'researched' } }))
    const whm = shell(locale, { catalog: unqualifiedCatalog })
    expect(whm).toContain('data-navigation-empty="true"')
    expect(whm).not.toContain('data-nav-route="/whm/accounts"')
    const folders = '<nav data-mail-folders>Folders</nav>'
    const mail = shell(locale, { surface: 'xmail', activeRoute: '/mail/inbox', homeHref: '/mail/inbox', visibility: owner, catalog: unqualifiedCatalog, sidebarHtml: folders })
    expect(mail).toContain(folders)
    expect(mail).not.toContain('class="v2-nav"')
    const fallbackMail = shell(locale, { surface: 'xmail', activeRoute: '/mail/inbox', homeHref: '/mail/inbox', visibility: owner, catalog: unqualifiedCatalog })
    expect(fallbackMail).toContain('data-navigation-empty="true"')
    expect(fallbackMail).not.toContain('data-nav-route="/mail/inbox"')
  })
})
