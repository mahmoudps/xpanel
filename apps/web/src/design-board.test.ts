import { afterEach, describe, expect, it } from 'vitest'
import { renderWebApp } from './app.ts'
import { designPages, designReferenceRoutesEnabled, readDesignAdapter, readPanelPhpPage, renderDesignMain, renderDesignNav, renderHomeToolGrid } from './design-board.ts'
import { resolveWebDocumentRoute } from './document-routes.ts'
import { renderPanelSurface } from './surfaces/xpanel.ts'
import { renderWhmSurface } from './surfaces/xwhm.ts'

const withDesignPages = <T>(fn: () => T): T => {
  const previous = process.env.XPANEL_DESIGN_PAGES
  process.env.XPANEL_DESIGN_PAGES = '1'
  try {
    return fn()
  } finally {
    if (previous === undefined) delete process.env.XPANEL_DESIGN_PAGES
    else process.env.XPANEL_DESIGN_PAGES = previous
  }
}

describe('design board routes', () => {
  afterEach(() => {
    delete process.env.XPANEL_DESIGN_PAGES
  })

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
    expect(cron).toContain('data-board-layout="/advanced/cron"')
    expect(cron).toContain('No cron jobs yet')
    expect(cron).toContain('Scheduled jobs')
    expect(cron).toContain('Every 5 minutes')
    expect(cron).not.toMatch(/alice|20014|xpanel-cron/)
    expect(renderDesignMain('/files/backup', 'en')).toContain('What do you want to back up?')
    expect(renderDesignMain('/whm/security/ssh', 'en')).toContain('No addresses banned by SSH')
    expect(renderDesignMain('/design/system', 'en')).toBe('')
    const system = withDesignPages(() => renderDesignMain('/design/system', 'en'))
    expect(system).toContain('data-token="accent"')
    expect(system).not.toMatch(/alice|3\.2/)
    const components = withDesignPages(() => renderDesignMain('/design/components', 'en'))
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
    const componentsAr = withDesignPages(() => renderDesignMain('/design/components', 'ar'))
    expect(componentsAr).toContain('قيد التفعيل')
    expect(componentsAr).not.toContain('Coming soon')
    const map = withDesignPages(() => renderDesignMain('/design/navigation', 'en'))
    expect(map).toContain('href="/whm/security/ssh"')
    expect(map).not.toMatch(/\b187\b/)
    const tools = renderHomeToolGrid('en', new Set(['/files/manager', '/mail/inbox']))
    expect(tools).toContain('href="/mail/inbox"')
    const absoluteTools = renderHomeToolGrid('en', new Set(['/files/manager', '/mail/inbox']), 'https://mail.example.test:2096')
    expect(absoluteTools).toContain('href="https://mail.example.test:2096/mail/inbox"')
    expect(absoluteTools).not.toContain('href="/mail/inbox"')
    const nav = renderDesignNav('xpanel', 'en', '/home', new Set(['/mail/inbox']), 'https://mail.example.test:2096')
    expect(nav).toContain('href="https://mail.example.test:2096/mail/inbox"')
    expect(nav).toContain('data-nav-route="/mail/inbox"')
    expect(nav).toContain('data-nav-wiring="live"')
    expect(tools).toContain('File manager')
    expect(tools).toContain('Backup wizard')
    expect(tools).toContain('Coming soon')
    expect(tools).not.toMatch(/alice|3\.2|8 tools/)
    const arabic = renderDesignMain('/software/php', 'ar')
    expect(arabic).toContain('قيد التفعيل')
    expect(arabic).not.toContain('Coming soon')
  })

  it('keeps the design specimens out of the product sidebar until the development flag is set', () => {
    expect(designReferenceRoutesEnabled()).toBe(false)
    const nav = renderDesignNav('xpanel', 'en', '/home', new Set(['/home']))
    expect(nav).not.toContain('/design/system')
    expect(nav).not.toContain('/design/components')
    expect(nav).not.toContain('/design/navigation')
    const shell = renderWebApp({ surface: 'xpanel', activeRoute: '/home', locale: 'en' })
    expect(shell).not.toContain('data-nav-route="/design/system"')
    expect(resolveWebDocumentRoute('/design/system')).toBeNull()
    const opened = withDesignPages(() => renderWebApp({ surface: 'xpanel', activeRoute: '/design/system', locale: 'en' }))
    expect(opened).toContain('data-design-page="/design/system"')
    expect(opened).toContain('data-nav-route="/design/system"')
    expect(withDesignPages(() => resolveWebDocumentRoute('/design/components'))).toEqual({ surface: 'xpanel', activeRoute: '/design/components' })
  })

  it('serves the unwired routes from the product shell', () => {
    for (const route of ['/software/php', '/advanced/cron', '/files/backup', '/whm/security/ssh', '/whm/plans/features']) {
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
