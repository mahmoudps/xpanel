import { describe, expect, it } from 'vitest'
import { tools } from './data/index.ts'
import { navigation } from './data/navigation.ts'
import { canonicalNavigationRoute, registeredDocumentAliases, canOpenRegisteredRoute, visibleNavigation, visibleRegisteredNavigation } from './navigation.ts'
import type { VisibilityContext } from './visibility.ts'
import { catalogKeys } from './i18n.ts'
import type { NavSurfaceId, Surface } from './types.ts'
import arCatalog from './locales/ar.json' with { type: 'json' }

const ar: Record<string, string> = arCatalog
const ACLS = new Set([
  'create-account', 'edit-account', 'suspend-account', 'terminate-account', 'change-plan', 'manage-plans',
  'manage-feature-lists', 'manage-dns', 'manage-ssl', 'change-password', 'list-accounts', 'allow-unlimited-plans',
  'allow-oversell', 'transfer',
])
const pages = navigation.flatMap(s => s.sections.flatMap(sec => sec.pages.map(p => ({ surface: s.surface, section: sec, page: p }))))

describe('navigation', () => {
  it('binds store subdocuments to existing capability pages without duplicating tools or changing roles', () => {
    expect(registeredDocumentAliases).toHaveLength(10)
    expect(new Set(registeredDocumentAliases.map(row => row.route)).size).toBe(10)
    const owner: VisibilityContext = { principal: { kind: 'user', id: 'owner', username: 'owner', accountId: 'account' }, disabledFeatures: new Set() }
    const root: VisibilityContext = { principal: { kind: 'root', id: 'root', username: 'root' }, disabledFeatures: new Set() }
    const reseller: VisibilityContext = { principal: { kind: 'reseller', id: 'reseller', username: 'reseller' }, reseller: { acl: ['list-accounts'] }, disabledFeatures: new Set() }
    for (const row of registeredDocumentAliases) {
      expect(canonicalNavigationRoute(row.route)).toBe(row.parentRoute)
      expect(pages.some(({ page }) => page.route === row.parentRoute)).toBe(true)
      for (const context of [owner, root, reseller]) expect(canOpenRegisteredRoute(row.route, context)).toBe(canOpenRegisteredRoute(row.parentRoute, context))
      expect(visibleNavigation(owner, tools).some(surface => surface.sections.some(section => section.pages.some(page => page.route === row.route)))).toBe(false)
    }
    expect(canOpenRegisteredRoute('/software/store/unknown', owner)).toBe(false)
    expect(canonicalNavigationRoute('/software/apps')).toBe('/software/apps')
  })

  it('denies registered document admission without a caller and never admits an unknown route', () => {
    expect(visibleRegisteredNavigation()).toEqual([])
    expect(canOpenRegisteredRoute('/whm')).toBe(false)
    expect(canOpenRegisteredRoute('/not-registered', { principal: { kind: 'root', id: 'fixture-root', username: 'root' } })).toBe(false)
  })

  it.each([
    { kind: 'root', acl: [], allow: ['/whm', '/whm/accounts', '/whm/accounts/new', '/whm/server/setup', '/whm/server/upgrade', '/whm/audit'], deny: ['/home', '/mail/inbox', '/security/account'] },
    { kind: 'reseller', acl: ['list-accounts'], allow: ['/whm', '/whm/accounts'], deny: ['/whm/accounts/new', '/whm/server/setup', '/whm/server/upgrade', '/whm/resellers', '/whm/audit', '/whm/security/firewall', '/home'] },
    { kind: 'reseller', acl: ['create-account'], allow: ['/whm', '/whm/accounts/new'], deny: ['/whm/accounts', '/whm/server/upgrade', '/whm/audit'] },
    { kind: 'user', acl: [], allow: ['/home', '/resources', '/advanced/terminal', '/mail/inbox', '/security/account'], deny: ['/whm', '/whm/accounts', '/whm/server/setup', '/whm/server/upgrade'] },
  ] as const)('admits $kind $acl only to registry roles and explicit ACLs', row => {
    const principal = row.kind === 'user'
      ? { kind: 'user' as const, id: 'fixture-user', username: 'owner', accountId: 'fixture-account' }
      : { kind: row.kind, id: 'fixture-' + row.kind, username: row.kind }
    const context: VisibilityContext = { principal, ...(row.kind === 'reseller' ? { reseller: { acl: [...row.acl] } } : {}), disabledFeatures: new Set() }
    const admitted = visibleRegisteredNavigation(context).flatMap(surface => surface.sections.flatMap(section => section.pages.map(page => page.route)))
    for (const route of row.allow) { expect(canOpenRegisteredRoute(route, context), route).toBe(true); expect(admitted).toContain(route) }
    for (const route of row.deny) { expect(canOpenRegisteredRoute(route, context), route).toBe(false); expect(admitted).not.toContain(route) }
  })

  it('keeps role admission separate from qualification and leaves registry and tool status unchanged', () => {
    const context: VisibilityContext = { principal: { kind: 'user', id: 'fixture-owner', username: 'owner', accountId: 'fixture-account' }, disabledFeatures: new Set(['terminal', 'domains']) }
    const before = JSON.stringify({ navigation, tools })
    expect(canOpenRegisteredRoute('/advanced/terminal', context)).toBe(true)
    expect(visibleRegisteredNavigation(context).flatMap(surface => surface.sections.flatMap(section => section.pages.map(page => page.route)))).toContain('/resources')
    expect(visibleNavigation(context, tools).flatMap(surface => surface.sections.flatMap(section => section.pages.map(page => page.route)))).not.toContain('/resources')
    expect(JSON.stringify({ navigation, tools })).toBe(before)
  })

  it('delivers every in-scope tool on exactly one page', () => {
    const placed = pages.flatMap(({ page }) => page.tools)
    const inScope = tools.filter(t => t.status !== 'out-of-scope').map(t => t.id)
    expect(placed.filter((id, i) => placed.indexOf(id) !== i)).toEqual([])
    expect([...inScope].sort()).toEqual([...placed].sort())
  })

  it('places tools on a surface their audience uses', () => {
    const allowed: Record<Surface, NavSurfaceId[]> = {
      xpanel: ['xpanel', 'xmail'],
      xmail: ['xmail', 'xpanel'],
      xwhm: ['xwhm'],
      aapanel: ['xpanel', 'xwhm'],
    }
    const surfaceOf = new Map(tools.map(t => [t.id, t.surface]))
    for (const { surface, page } of pages) {
      for (const id of page.tools) expect(allowed[surfaceOf.get(id)!], `${surface}:${page.id} → ${id}`).toContain(surface)
    }
  })

  it('has unique routes, ids and valid roles', () => {
    const routes = pages.map(({ page }) => page.route)
    expect(new Set(routes).size).toBe(routes.length)
    for (const s of navigation) {
      const ids = s.sections.flatMap(sec => sec.pages.map(p => p.id))
      expect(new Set(ids).size, s.surface).toBe(ids.length)
    }
    for (const { surface, page } of pages) {
      expect(page.roles.length, page.id).toBeGreaterThan(0)
      for (const role of page.roles) {
        const [kind, acl] = role.split(':')
        expect(['owner', 'root', 'reseller'], `${page.id} ${role}`).toContain(kind)
        if (acl) expect(ACLS.has(acl), `${page.id} ${role}`).toBe(true)
        if (surface === 'xwhm') expect(kind, page.id).not.toBe('owner')
        else expect(kind, page.id).toBe('owner')
      }
    }
  })

  it('keeps menus within ergonomic limits', () => {
    for (const s of navigation) {
      expect(s.sections.length, s.surface).toBeLessThanOrEqual(14)
      for (const sec of s.sections) expect(sec.pages.length, `${s.surface}:${sec.id}`).toBeLessThanOrEqual(12)
    }
  })

  it('translates every section and page name', () => {
    const missing = navigation.flatMap(s => s.sections.flatMap(sec => [
      catalogKeys.sectionName(s.surface, sec.id),
      ...sec.pages.map(p => catalogKeys.pageName(s.surface, p.id)),
    ])).filter(key => !ar[key]?.trim())
    expect(missing).toEqual([])
  })

  it('represents separated administrator actions as root-only metadata without a task screen or action', () => {
    const routes = ['/whm/email/bcc', '/whm/email/marketing', '/whm/services/ftp-log-analysis',
      '/whm/software/deployments', '/whm/software/application-projects', '/whm/software/composer', '/whm/services/default-index']
    for (const route of routes) {
      const entry = pages.find(({ page }) => page.route === route)!
      expect(entry.surface).toBe('xwhm')
      expect(entry.page.roles).toEqual(['root'])
      expect(entry.page.artboard).toBeNull()
      expect(entry.page.primaryAction).toBeNull()
      expect(entry.page.summary).toContain('unavailable until')
      expect(entry.page.tools.every(id => tools.find(tool => tool.id === id)?.rootOnly)).toBe(true)
    }
  })

  it('removes administrative promises from the separated owner page summaries and search aliases', () => {
    const excluded = [
      { route: '/email/forwarders', terms: /\bbcc\b/i },
      { route: '/email/mailing-lists', terms: /campaign|automation|suppression|templated|event-triggered/i },
      { route: '/files/ftp', terms: /ftp logs|log analysis|user's ftp activity/i },
      { route: '/software/installer', terms: /one-click app deploy/i },
      { route: '/software/apps', terms: /\bgo\b|\bjava\b/i },
      { route: '/software/packages', terms: /composer/i },
      { route: '/advanced/indexes', terms: /default index files|directoryindex|index\.php|index\.html|which files serve/i },
    ]
    for (const { route, terms } of excluded) {
      const page = pages.find(entry => entry.page.route === route)!.page
      expect([page.summary, ...page.keywords].join(' '), route).not.toMatch(terms)
    }
  })
})
