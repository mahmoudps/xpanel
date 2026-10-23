import { describe, expect, it } from 'vitest'
import { renderWebApp } from './app.ts'
import { designPages, readDesignAdapter, readPanelPhpPage, renderDesignMain, renderHomeToolGrid } from './design-board.ts'
import { renderPanelSurface } from './surfaces/xpanel.ts'
import { renderWhmSurface } from './surfaces/xwhm.ts'

describe('design board routes', () => {
  it('gives every artifact screen a route and an empty adapter until its tool is connected', () => {
    const routes = designPages.map(page => page.route)
    expect(new Set(routes).size).toBe(routes.length)
    expect(routes).toEqual(expect.arrayContaining([
      '/home', '/resources', '/files/manager', '/files/backup', '/files/directory-privacy',
      '/domains', '/domains/site-settings', '/domains/zone-editor', '/databases/mariadb',
      '/email/accounts', '/software/php', '/software/htaccess', '/advanced/cron',
      '/metrics/traffic', '/security/ssl', '/security/account',
      '/design/system', '/design/components', '/design/navigation',
      '/whm', '/whm/server/setup', '/whm/accounts', '/whm/accounts/new', '/whm/plans',
      '/whm/plans/features', '/whm/resellers', '/whm/domains', '/whm/services/web',
      '/whm/software/php', '/whm/ssl', '/whm/dns', '/whm/services', '/whm/security/firewall',
      '/whm/security', '/whm/security/ssh', '/whm/backups', '/whm/transfers',
      '/whm/server/upgrade', '/whm/audit', '/mail/inbox', '/mail/compose',
    ]))
    for (const page of designPages.filter(item => !item.live)) {
      expect(readDesignAdapter(page.route)).toEqual({ wired: false, records: [] })
    }
    expect(readPanelPhpPage()).toEqual({ wired: false, records: [] })
  })

  it('renders an unwired page with the empty state and no invented records', () => {
    const html = renderDesignMain('/software/php', 'en')
    expect(html).toContain('data-design-page="/software/php"')
    expect(html).toContain('data-wiring="soon"')
    expect(html).toContain('Coming soon')
    expect(html).toContain('No PHP selection yet')
    expect(html).toContain('Domain and version')
    expect(html).toContain('disabled')
    expect(html).not.toMatch(/<form\b|alice|3\.2|salma/)
    const cron = renderDesignMain('/advanced/cron', 'en')
    expect(cron).toContain('No cron jobs yet')
    expect(cron).toContain('Scheduled jobs')
    expect(cron).not.toMatch(/alice|20014|xpanel-cron/)
    const system = renderDesignMain('/design/system', 'en')
    expect(system).toContain('data-token="accent"')
    expect(system).not.toMatch(/alice|3\.2/)
    const components = renderDesignMain('/design/components', 'en')
    expect(components).toContain('xp-meter__fill')
    expect(components).toContain('style="width:0%"')
    expect(components).toContain('xp-meter__indet')
    expect(components).toContain('xp-status-icon--spin')
    expect(components).toContain('xp-skeleton')
    expect(components).toContain('xp-toast__drain')
    expect(components).toContain('aria-pressed="true"')
    expect(components).toContain('aria-invalid="true"')
    expect(components).toContain('aria-checked="true"')
    expect(components).not.toMatch(/<form\b|alice|salma|3\.2/)
    const componentsAr = renderDesignMain('/design/components', 'ar')
    expect(componentsAr).toContain('قيد التفعيل')
    expect(componentsAr).not.toContain('Coming soon')
    const map = renderDesignMain('/design/navigation', 'en')
    expect(map).toContain('href="/whm/security/ssh"')
    expect(map).not.toMatch(/\b187\b/)
    const tools = renderHomeToolGrid('en', new Set(['/files/manager']))
    expect(tools).toContain('File manager')
    expect(tools).toContain('Backup wizard')
    expect(tools).toContain('Coming soon')
    expect(tools).not.toMatch(/alice|3\.2|8 tools/)
    const arabic = renderDesignMain('/software/php', 'ar')
    expect(arabic).toContain('قيد التفعيل')
    expect(arabic).not.toContain('Coming soon')
  })

  it('serves the unwired routes from the product shell', () => {
    for (const route of ['/software/php', '/advanced/cron', '/files/backup', '/design/navigation', '/whm/security/ssh', '/whm/plans/features']) {
      const surface = route.startsWith('/whm') ? 'xwhm' as const : 'xpanel' as const
      const html = renderWebApp({ surface, activeRoute: route, locale: 'en' })
      expect(html).toContain(`data-design-page="${route}"`)
      expect(html).toContain('data-nav-wiring="soon"')
      expect(html).not.toMatch(/<form\b/)
    }
    const php = renderPanelSurface({
      locale: 'en', activeRoute: '/software/php',
      account: { id: 'a', username: 'owner', uid: 1, gid: 1, home: '/home/owner', primaryDomain: 'owner.example.test', planId: 'p', ownerId: null, status: 'active', suspendReason: null, contactEmail: 'owner@example.test', ipv4: '192.0.2.1', ipv6: null, extraIps: [], shell: 'none', createdAt: '2026-10-23T00:00:00Z' },
    })
    expect(php).toContain('data-design-page="/software/php"')
    expect(php).not.toContain('192.0.2.1')
    const features = renderWhmSurface({ locale: 'en', activeRoute: '/whm/plans/features', principal: { kind: 'root', id: 'root', username: 'root' } })
    expect(features).toContain('data-design-page="/whm/plans/features"')
    expect(features).not.toContain('data-plan-editor-form')
  })
})
