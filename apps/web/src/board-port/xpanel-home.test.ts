import { resolveWebDocumentRoute } from '../document-routes.ts'
import { parseMarkup } from '../themes/markup.ts'
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { defaultPlan } from '@xpanel/core'
import { renderPanelSurface } from '../surfaces/xpanel.ts'
import { renderWebApp } from '../app.ts'
import { readdirSync, readFileSync } from 'node:fs'
import { renderXpanelHome, xpanelHomeFromProps } from './xpanel-home.ts'
import { renderFidelityDocument } from './xpanel-home.fixture.ts'

const account = {
  id: 'home-account', username: 'alice', uid: 20014, gid: 20014, home: '/home/alice', primaryDomain: 'alice-shop.com',
  planId: 'plan', ownerId: null, status: 'active' as const, suspendReason: null, contactEmail: 'owner@alice-shop.com',
  ipv4: '10.0.0.21', ipv6: null, shell: 'none' as const, createdAt: '2026-10-22T14:05:00Z',
}

describe('xPanel home board port', () => {
  it('keeps the English fixture free of bidi markup and on the board chrome', () => {
    const html = renderFidelityDocument('ltr')
    assert.equal(html.includes('<bdi'), false)
    const markup = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    assert.equal(markup.includes('dir="rtl"'), false)
    assert.equal(html.includes('box-shadow'), false)
    assert.match(html, /35 tools in 9 groups/)
    assert.match(html, /Generation 142 · 2026-10-22 13:52 UTC/)
    assert.match(html, /aria-label="xPanel navigation"/)
    assert.match(html, /<h1 style="margin: 0; font-size: 22px; font-weight: 600">Home<\/h1>/)
    assert.match(html, /Your plan’s feature list decides which tools appear here\./)
  })

  it('matches the Arabic board’s isolates, active edge, and counted tools', () => {
    const html = renderFidelityDocument('ar')
    for (const marker of [
      'dir="rtl"',
      'تنقل xPanel',
      '<bdi dir="ltr" style="font-family: \'IBM Plex Mono\', monospace; font-size: 17px; font-weight: 500; color: light-dark(#1D5BD6,var(--xp-accent,#1D5BD6))">xPanel</bdi>',
      '<bdi dir="ltr">alice · uid 20014</bdi>',
      '<bdi dir="ltr" style="color: light-dark(#344054,var(--xp-text-secondary,#344054)); font-weight: 500; font-variant-numeric: tabular-nums">3.2 / 10 GB</bdi>',
      'inset -3px 0 0 light-dark(#1D5BD6,var(--xp-border-focus,#1D5BD6))',
      '35 أداة في 9 مجموعات',
      'الرئيسية',
      'scaleX(-1)',
      'dir="auto"',
      'font-size: 12px; font-weight: 600; color: light-dark(#5D6B7E,var(--xp-text-muted,#5D6B7E))',
    ]) assert.ok(html.includes(marker), marker)
    assert.equal(html.includes('>Home<'), false)
    assert.equal(html.includes('letter-spacing: 0.02em'), false)
  })

  it('keeps the phone fixture closed, with Files expanded and its own meter order', () => {
    const html = renderFidelityDocument('phone')
    assert.match(html, /aria-expanded="false"/)
    assert.match(html, />35 tools</)
    assert.doesNotMatch(html, /35 tools in 9 groups/)
    const bandwidth = html.indexOf('Monthly bandwidth')
    const disk = html.indexOf('>Disk<')
    assert.ok(bandwidth > 0 && bandwidth < disk)
    assert.match(html, /id="m-group-tools-0" data-tool-panel="true" style="display: flex/)
    assert.match(html, /id="m-group-tools-1" data-tool-panel="true" style="display: none/)
    assert.match(html, /<template id="xpanel-home-drawer">/)
    assert.equal((html.match(/<h1\b/g) ?? []).length, 1)
    assert.equal(html.includes('<bdi'), false)
  })

  it('binds the account and leaves unknown usage empty', () => {
    const plan = defaultPlan({ id: 'plan', name: 'Synthetic plan', featureListId: 'features' })
    const html = renderPanelSurface({
      account, plan, activeRoute: '/home',
      domains: [{ id: 'd', accountId: account.id, name: account.primaryDomain, kind: 'primary', parentId: null, docRoot: '/home/alice/public_html', siteType: 'php', upstream: null, redirect: null,
        php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 4, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 500, processIdleTimeoutSec: 10 }, ini: {} }, wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited', ipv4: account.ipv4, ipv6: null }],
      databases: [{ id: 'db', accountId: account.id, engine: 'mariadb', name: 'alice_fixture', trashedAt: null }],
      serviceUsers: [{ id: 'u', accountId: account.id, login: 'info@alice-shop.com', services: { email: true, ftp: true, webdisk: false }, mailboxQuotaMb: 1024, ftpDir: 'public_html' }],
      files: [{ name: 'trashed-fixture.txt', path: '/home/alice/.trash/trashed-fixture.txt', kind: 'file', sizeBytes: 64, modeOctal: '0640', modifiedAt: '2026-10-22T14:05:00Z', trashed: true }],
      dnsRecords: [{ id: 'dns', zone: account.primaryDomain, name: '@', type: 'A', ttl: 3600, content: account.ipv4, priority: null }],
    })
    const headings = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)].map(match => match[1]!.replace(/<[^>]*>/g, '').trim())
    assert.deepEqual(headings, ['Home'])
    assert.match(html, /data-board-port="xpanel-home"/)
    assert.match(html, /data-resource-metrics="unavailable"/)
    assert.match(html, /10\.0\.0\.21/)
    assert.match(html, /Synthetic plan/)
    assert.match(html, /8\.3 · PHP-FPM/)
    assert.match(html, /— \/ 5 GB/)
    assert.match(html, /1 \/ 10/)
    assert.doesNotMatch(html, /3\.2 \/ 10 GB|Generation 142|alice-blog\.net|orders@alice-shop\.com|1,431|10\.0\.0\.12|data-generation-chip=/)
    assert.doesNotMatch(html, /[\u0660-\u0669\u06f0-\u06f9]/)
    const emptyHtml = renderXpanelHome(xpanelHomeFromProps({
      locale: 'ar',
      account: { username: 'owner', uid: 1000, home: '/home/owner', primaryDomain: 'example.test', ipv4: '192.0.2.10' },
      actionHtml: '<section data-action-state="conflict" data-preserve-draft="true"><bdi dir="ltr">JOB-000077</bdi></section>',
    }))
    assert.match(emptyHtml, /data-action-state="conflict"/)
    assert.match(emptyHtml, /<bdi dir="ltr">JOB-000077<\/bdi>/)
    assert.match(emptyHtml, /لا تغييرات مسجّلة لهذا الحساب بعد\./)
    assert.equal((emptyHtml.match(/<h1\b/g) ?? []).length, 1)
  })

  it('lists unqualified tools as disabled coming-soon rows and keeps qualified ones linked', () => {
    const qualified = new Set(['/files/manager', '/email/accounts'])
    const html = renderXpanelHome(xpanelHomeFromProps({
      locale: 'en',
      account: { username: 'owner', uid: 1000, home: '/home/owner', primaryDomain: 'example.test', ipv4: '192.0.2.10' },
      qualifiedRoutes: qualified,
      signOutLabel: 'Sign out',
    }))
    const rows = (source: string) => source.match(/<li data-tool="true"[\s\S]*?<\/li>/g)?.join('\n') ?? ''
    const tools = rows(html)
    assert.match(html, /35 tools in 9 groups/)
    assert.match(tools, /<a href="\/files\/manager"/)
    assert.match(tools, /<a href="\/email\/accounts"/)
    assert.doesNotMatch(html, /\/mail\/|messages\.example/)
    assert.match(tools, /<a href="\/security\/account"/)
    assert.match(html, /href="\?lang=ar"/)
    assert.match(html, /data-action="logout"/)
    assert.match(tools, /aria-disabled="true"/)
    assert.match(tools, />Coming soon</)
    assert.match(tools, /data-tool-wiring="soon"/)
    assert.doesNotMatch(tools, /<a href="\/files\/backup"/)
    const arabic = renderXpanelHome(xpanelHomeFromProps({
      locale: 'ar',
      account: { username: 'owner', uid: 1000, home: '/home/owner', primaryDomain: 'example.test', ipv4: '192.0.2.10' },
      qualifiedRoutes: new Set(),
    }))
    const arabicTools = rows(arabic)
    assert.match(arabicTools, /قيد التفعيل/)
    assert.match(arabic, /35 أداة في 9 مجموعات/)
    assert.match(arabicTools, /<a href="\/security\/account"/)
    assert.doesNotMatch(arabicTools, /<a href="\/files\/manager"/)
    const specimen = renderFidelityDocument('ltr')
    assert.doesNotMatch(specimen, /aria-disabled="true"|Coming soon/)
  })
  it('routes the webmail tile and xMail item to Email accounts on this panel in desktop and phone views', () => {
    for (const locale of ['en', 'ar'] as const) for (const theme of ['dark', 'light'] as const) {
      const model = xpanelHomeFromProps({ locale, theme, account, qualifiedRoutes: new Set(['/email/accounts']) })
      for (const view of [model.desktop, model.phone]) {
        assert.equal(view.nav.flatMap(group => group.items).find(item => item.icon === 'inbox')?.href, '/email/accounts')
        assert.equal(view.groups.flatMap(group => group.tools).find(item => item.icon === 'inbox')?.href, '/email/accounts')
        assert.equal(view.groups.flatMap(group => group.tools).find(item => item.icon === 'inbox')?.enabled, true)
      }
      const html = renderPanelSurface({ account, activeRoute: '/home', locale, theme })
      assert.doesNotMatch(html, /href="(?:https?:)?\/\/|href="\/mail|data-nav-route="\/mail/)
    }
    const unqualified = xpanelHomeFromProps({ account, qualifiedRoutes: new Set() })
    assert.equal(unqualified.desktop.groups.flatMap(group => group.tools).find(item => item.icon === 'inbox')?.enabled, false)
  })

  it('renders no other panel or account context in the full xPanel document', () => {
    const html = renderWebApp({
      surface: 'xpanel' as const, activeRoute: '/home', locale: 'ar' as const, theme: 'light' as const,
      accountId: account.id,
      visibility: { principal: { kind: 'user' as const, id: 'owner', username: account.username, accountId: account.id } },
      panel: { account },
    })
    // Inline sign-in client code keeps its own audience map; rendered markup has no xMail destination.
    assert.doesNotMatch(html.replace(/<(style|script)\b[\s\S]*?<\/\1>/g, ''), /href="\/mail|\/mail\/inbox|data-panel-switch|messages\.example/)
    assert.match(html, /href="\/resources\?lang=ar&amp;theme=light&amp;density=comfortable&amp;accountId=home-account"/)
  })
  it('keeps board sample data out of product code', () => {
    for (const name of ['./xpanel-home.ts', './xmail-inbox.ts', './xmail-compose.ts']) {
      const product = readFileSync(new URL(name, import.meta.url), 'utf8')
      for (const sample of ['alice-shop.com', '198.51.100.24', '1,431 today', 'Generation 142']) assert.ok(!product.includes(sample), `${name}: ${sample}`)
    }
    const scripts = new URL('../../../../scripts/', import.meta.url)
    for (const entry of readdirSync(scripts).filter(entry => entry.startsWith('board-fidelity-'))) {
      const text = readFileSync(new URL(entry, scripts), 'utf8')
      for (const privatePath of ['/cursor/stores', '/opt/cursor']) assert.ok(!text.includes(privatePath), `${entry}: ${privatePath}`)
    }
    const src = new URL('../', import.meta.url)
    const walk = (dir: URL): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
      ? walk(new URL(entry.name + '/', dir))
      : entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.fixture.ts') ? [new URL(entry.name, dir).pathname] : [])
    const importers = walk(src).filter(file => /from '[^']*\.fixture\.ts'/.test(readFileSync(decodeURIComponent(file).replace(/^\/([A-Za-z]:)/, '$1'), 'utf8')))
    assert.deepEqual(importers, [])
  })
})


describe('authenticated Home account menu', () => {
  it.each(['en', 'ar'] as const)('renders two native menu owners with unique controls and the trusted document context in %s', { tags: ['feature'] }, locale => {
    for (const route of ['/home', '/panel']) {
      const documentRoute = resolveWebDocumentRoute(route)
      assert.ok(documentRoute && documentRoute.surface === 'xpanel')
      const html = renderWebApp({
        surface: 'xpanel', activeRoute: documentRoute.activeRoute, locale, theme: 'light', density: 'compact', accountId: account.id,
        visibility: { principal: { kind: 'user', id: 'home-menu-owner', username: account.username, accountId: account.id } },
        panel: { account },
      })
      const nodes = parseMarkup(html), live = nodes.filter(node => node.namespace === 'html' && node.template === -1)
      const menus = live.filter(node => node.tag === 'details' && node.attrs.has('data-user-menu'))
      assert.equal(menus.length, 2, route)
      const choices = live.filter(node => node.tag === 'select' && node.attrs.has('data-ui-theme-choice'))
      assert.deepEqual(choices.map(node => node.attrs.get('id')).sort(), ['xp-home-desktop-ui-theme-choice', 'xp-home-phone-ui-theme-choice'])
      const ids = live.flatMap(node => node.attrs.has('id') ? [node.attrs.get('id')] : [])
      assert.equal(new Set(ids).size, ids.length)
      for (const menu of menus) {
        const menuIndex = nodes.indexOf(menu)
        const descendants = live.filter(node => {
          let parent = node.parent
          while (parent >= 0) {
            if (parent === menuIndex) return true
            const ancestor = nodes[parent]
            if (!ancestor) break
            parent = ancestor.parent
          }
          return false
        })
        const summary = descendants.find(node => node.tag === 'summary' && node.parent === menuIndex)
        assert.ok(summary)
        assert.ok(summary.attrs.get('aria-label')?.includes(account.username))
        assert.equal(summary.attrs.get('role'), undefined)
        assert.equal(descendants.filter(node => node.attrs.has('data-ui-theme-choice')).length, 1)
        assert.equal(descendants.filter(node => node.attrs.get('data-action') === 'logout').length, 1)
        const choice = descendants.find(node => node.attrs.has('data-ui-theme-choice'))
        assert.ok(choice)
        assert.equal(live.filter(node => node.tag === 'label' && node.attrs.get('for') === choice.attrs.get('id')).length, 1)
        const security = descendants.find(node => node.tag === 'a' && node.attrs.has('data-security-link'))
        assert.ok(security)
        const href = security.attrs.get('href')
        assert.ok(href)
        const url = new URL(href.replaceAll('&amp;', '&'), 'https://panel.example.test')
        assert.equal(url.pathname, '/security/account')
        assert.equal(url.searchParams.get('lang'), locale)
        assert.equal(url.searchParams.get('theme'), 'light')
        assert.equal(url.searchParams.get('density'), 'compact')
        assert.equal(url.searchParams.get('accountId'), account.id)
      }
    }
  })

  it('keeps an absent authenticated menu model noninteractive instead of inferring sign-in from account labels', { tags: ['feature'] }, () => {
    const nodes = parseMarkup(renderXpanelHome(xpanelHomeFromProps({ account })))
    assert.equal(nodes.filter(node => node.attrs.has('data-user-menu')).length, 0)
    assert.equal(nodes.filter(node => node.tag === 'span' && node.attrs.get('class') === 'xp-home-avatar' && node.attrs.get('role') === 'img').length, 2)
    assert.equal(nodes.filter(node => node.attrs.has('data-ui-theme-preferences') || node.attrs.get('data-action') === 'logout').length, 0)
  })

  it('uses the shared sign-in menu for an explicit signed-out model without personal preference or logout controls', { tags: ['feature'] }, () => {
    const nodes = parseMarkup(renderXpanelHome(xpanelHomeFromProps({
      account, userMenu: { locale: 'en', theme: 'light', density: 'comfortable', path: '/home', surface: 'xpanel', signedIn: false },
    })))
    assert.equal(nodes.filter(node => node.tag === 'details' && node.attrs.has('data-user-menu')).length, 2)
    assert.equal(nodes.filter(node => node.attrs.has('data-ui-theme-preferences') || node.attrs.get('data-action') === 'logout').length, 0)
    assert.equal(nodes.filter(node => node.tag === 'a' && node.attrs.get('href')?.startsWith('/login?')).length, 2)
  })
})


describe('Home account query context ownership', () => {
  for (const selected of [false, true]) {
    it.each(['en', 'ar'] satisfies readonly ('en' | 'ar')[])('uses only selected account query context (selected=' + selected + ') in %s', { tags: ['feature'] }, locale => {
      for (const route of ['/home', '/panel', '/panel/home']) {
        const documentRoute = resolveWebDocumentRoute(route)
        assert.ok(documentRoute && documentRoute.surface === 'xpanel')
        assert.equal(documentRoute.activeRoute, '/home')
        const html = renderWebApp({
          surface: 'xpanel', uiTheme: 'classic', activeRoute: documentRoute.activeRoute, locale,
          theme: 'light', density: 'compact', ...(selected ? { accountId: account.id } : {}),
          visibility: { principal: { kind: 'user', id: 'home-query-owner', username: account.username, accountId: account.id } },
          panel: { account },
        })
        const live = parseMarkup(html).filter(node => node.namespace === 'html' && node.template < 0)
        assert.equal(live.filter(node => node.tag === 'details' && node.attrs.has('data-user-menu')).length, 2, route)
        assert.equal(live.filter(node => node.attrs.has('data-ui-theme-choice')).length, 2, route)
        const logoutButtons = live.filter(node => node.attrs.get('data-action') === 'logout')
        assert.equal(logoutButtons.length, 4, route)
        assert.equal(logoutButtons.filter(node => (node.attrs.get('class') ?? '').split(/\s+/).includes('xp-menu-signout')).length, 2, route)
        for (const button of logoutButtons) {
          assert.equal(button.tag, 'button')
          assert.equal(button.attrs.get('type'), 'button')
          assert.equal(button.attrs.has('disabled'), false)
        }
        let contextualControls = 0
        for (const anchor of live.filter(node => node.tag === 'a' && node.attrs.has('href'))) {
          const href = anchor.attrs.get('href')
          if (href === undefined) throw new Error('Missing live Home link')
          const url = new URL(href, 'https://panel.example.test/home')
          if (url.origin !== 'https://panel.example.test') continue
          if (!selected) assert.equal(url.searchParams.has('accountId'), false, route + ' ' + url.pathname)
          if (anchor.attrs.has('data-security-link') || anchor.attrs.has('data-lang-switch')
            || anchor.attrs.has('data-theme-toggle') || anchor.attrs.has('data-density-option') || url.pathname === '/resources') {
            contextualControls++
            assert.equal(url.searchParams.get('accountId'), selected ? account.id : null, route + ' ' + url.pathname)
            if (anchor.attrs.has('data-theme-toggle')) {
              assert.equal(anchor.attrs.get('data-theme-toggle'), 'dark')
              assert.equal(url.searchParams.get('theme'), 'dark')
            } else assert.equal(url.searchParams.get('theme'), 'light')
            if (anchor.attrs.has('data-density-option')) {
              const targetDensity = anchor.attrs.get('data-density-option')
              assert.ok(targetDensity === 'comfortable' || targetDensity === 'compact')
              assert.equal(url.searchParams.get('density'), targetDensity)
            } else assert.equal(url.searchParams.get('density'), 'compact')
          }
        }
        assert.ok(contextualControls >= 6, route)
      }
    })
  }
})
