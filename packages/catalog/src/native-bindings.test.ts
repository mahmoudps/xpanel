import { describe, expect, it } from 'vitest'
import { tools } from './data/index.ts'
import { navigation } from './data/navigation.ts'
import { HOST_PROBES, PHASE1_TOOL_PROBES, qualifyHostTools, type HostQualificationReport } from './host-qualification.ts'
import { canOpenRegisteredRoute, visibleNavigation } from './navigation.ts'
import type { CatalogTool, NavSurface } from './types.ts'
import { isVisible, type VisibilityContext } from './visibility.ts'

const nativeIds = ['feature-list-crud', 'server-settings-edit', 'domain-php-settings', 'dns-zone-records']
const broadIds = ['feature-manager', 'tweak-packages', 'initial-setup-wizard', 'basic-server-setup', 'php-version-selector', 'multiphp-ini-editor', 'zone-editor', 'dnssec']
const settingsRoutes = ['/whm/server/setup', '/whm/services/web', '/whm/security/ssh']
const root: VisibilityContext = { principal: { kind: 'root', id: 'root', username: 'root' } }
const owner: VisibilityContext = {
  principal: { kind: 'user', id: 'owner', username: 'owner', accountId: 'account' },
  disabledFeatures: new Set<string>(),
}
const reseller = (acl: NonNullable<VisibilityContext['reseller']>['acl']): VisibilityContext => ({
  principal: { kind: 'reseller', id: 'reseller', username: 'reseller' }, reseller: { acl },
})
const allPassed: HostQualificationReport = {
  executor: 'linux', probes: Object.fromEntries(HOST_PROBES.map(probe => [probe, 'passed'])),
}
const nativeDefinitions = tools.filter(tool => nativeIds.includes(tool.id))
const qualify = (report: HostQualificationReport | null = allPassed): CatalogTool[] =>
  qualifyHostTools(nativeDefinitions.map(tool => ({ ...tool, status: 'verified' as const, delivery: { ...tool.delivery, status: 'verified' as const } })), report, true)
const routesOf = (surfaces: readonly NavSurface[]): string[] =>
  surfaces.flatMap(surface => surface.sections.flatMap(section => section.pages.map(page => page.route)))
const page = (route: string) => navigation.flatMap(surface => surface.sections.flatMap(section => section.pages))
  .find(entry => entry.route === route)!

describe('native workspace capability boundaries', () => {
  it('never treats healthy host probes as release acceptance', () => {
    expect(qualifyHostTools(nativeDefinitions, allPassed, true).some(tool => tool.status === 'verified')).toBe(false)
  })
  it('declares only 4 narrow native capabilities with the actual API feature keys and roles', () => {
    expect(nativeDefinitions).toHaveLength(4)
    const byId = new Map(nativeDefinitions.map(tool => [tool.id, tool]))
    expect(byId.get('feature-list-crud')).toMatchObject({ surface: 'xwhm', rootOnly: false, resellerAcl: 'manage-feature-lists', featureKey: null })
    expect(byId.get('server-settings-edit')).toMatchObject({ surface: 'xwhm', rootOnly: true, resellerAcl: null, featureKey: null })
    expect(byId.get('domain-php-settings')).toMatchObject({ surface: 'xpanel', featureKey: 'domains' })
    expect(byId.get('dns-zone-records')).toMatchObject({ surface: 'xpanel', featureKey: 'zone-editor' })
    expect(nativeDefinitions.every(tool => tool.status === 'researched' && tool.delivery.status === 'researched')).toBe(true)
    expect(PHASE1_TOOL_PROBES['feature-list-crud']).toEqual(['control-plane'])
    expect(PHASE1_TOOL_PROBES['server-settings-edit']).toEqual(['control-plane'])
    expect(PHASE1_TOOL_PROBES['domain-php-settings']).toEqual(['control-plane', 'apache'])
    expect(PHASE1_TOOL_PROBES['dns-zone-records']).toEqual(['control-plane', 'pdns'])
  })

  it.each(nativeIds)('qualifies %s only after every declared host probe passes', id => {
    expect(qualify().find(tool => tool.id === id)?.status).toBe('verified')
    for (const probe of PHASE1_TOOL_PROBES[id]!) {
      for (const result of [undefined, 'failed'] as const) {
        const probes = { ...allPassed.probes }
        if (result === undefined) delete probes[probe]
        else probes[probe] = result
        expect(qualify({ executor: 'linux', probes }).find(tool => tool.id === id)?.status, `${probe}: ${result}`).toBe('researched')
      }
    }
  })

  it.each(['fake', 'unknown'] as const)('never qualifies a %s executor even with every probe passed', executor => {
    expect(qualify({ ...allPassed, executor }).some(tool => tool.status === 'verified')).toBe(false)
  })

  it('keeps missing reports and disabled qualification closed', () => {
    expect(qualify(null).some(tool => tool.status === 'verified')).toBe(false)
    expect(qualifyHostTools(nativeDefinitions, allPassed, false).some(tool => tool.status === 'verified')).toBe(false)
  })

  it('does not promote the original broader IDs even with all supported host probes passed', () => {
    const qualified = qualifyHostTools(tools, allPassed, true)
    for (const id of broadIds) {
      expect(qualified.find(tool => tool.id === id)?.status, id).toBe('researched')
      expect(PHASE1_TOOL_PROBES[id], id).toBeUndefined()
    }
    expect(page('/whm/plans/features').tools).toEqual(['feature-manager', 'tweak-packages', 'feature-list-crud'])
    expect(page('/software/php').tools).toEqual(['php-version-selector', 'multiphp-ini-editor', 'domain-php-settings'])
    expect(page('/domains/zone-editor').tools).toEqual(['zone-editor', 'dnssec', 'dns-zone-records'])
    expect(page('/whm/server/setup').tools).toEqual(['initial-setup-wizard', 'basic-server-setup', 'advanced-settings-browser', 'tweak-system', 'disk-quota-setup', 'aapanel-linux-tools', 'server-settings-edit'])
  })

  it('opens only the explicit role-admitted workspaces from narrow capabilities', () => {
    const catalog = qualify()
    expect(routesOf(visibleNavigation(root, catalog)).sort()).toEqual(['/whm/plans/features', ...settingsRoutes].sort())
    expect(routesOf(visibleNavigation(owner, catalog)).sort()).toEqual(['/home', '/software/php', '/domains/zone-editor'].sort())
    expect(routesOf(visibleNavigation(reseller(['manage-feature-lists']), catalog))).toEqual(['/whm/plans/features'])
    expect(visibleNavigation(undefined, catalog)).toEqual([])
    for (const tool of catalog) expect(isVisible(tool, root)).toBe(tool.surface === 'xwhm')
  })

  it('requires manage-feature-lists at both registered page and capability boundaries', () => {
    const catalog = qualify()
    expect(page('/whm/plans/features').roles).toEqual(['root', 'reseller:manage-feature-lists'])
    for (const context of [reseller([]), reseller(['manage-plans']), reseller(['manage-dns']), owner]) {
      expect(canOpenRegisteredRoute('/whm/plans/features', context)).toBe(false)
      expect(routesOf(visibleNavigation(context, catalog))).not.toContain('/whm/plans/features')
    }
    const admitted = reseller(['manage-feature-lists'])
    expect(canOpenRegisteredRoute('/whm/plans/features', admitted)).toBe(true)
    expect(routesOf(visibleNavigation(admitted, catalog))).toContain('/whm/plans/features')
    expect(routesOf(visibleNavigation(admitted, catalog.filter(tool => tool.id !== 'feature-list-crud')))).not.toContain('/whm/plans/features')
  })

  it('keeps every settings workspace root-only, including SSH and web settings', () => {
    const catalog = qualify()
    for (const context of [owner, reseller(['manage-feature-lists', 'manage-plans', 'edit-account', 'manage-dns'])]) {
      for (const route of settingsRoutes) {
        expect(canOpenRegisteredRoute(route, context)).toBe(false)
        expect(routesOf(visibleNavigation(context, catalog))).not.toContain(route)
      }
    }
    for (const route of settingsRoutes) {
      expect(routesOf(visibleNavigation(root, catalog.filter(tool => tool.id !== 'server-settings-edit')))).not.toContain(route)
    }
  })

  it.each([
    { route: '/software/php', id: 'domain-php-settings', feature: 'domains' },
    { route: '/domains/zone-editor', id: 'dns-zone-records', feature: 'zone-editor' },
  ])('requires qualified $id and actual enabled feature $feature for $route', ({ route, id, feature }) => {
    const catalog = qualify()
    expect(routesOf(visibleNavigation(owner, catalog))).toContain(route)
    expect(routesOf(visibleNavigation({ principal: owner.principal }, catalog))).not.toContain(route)
    expect(routesOf(visibleNavigation({ ...owner, disabledFeatures: new Set([feature]) }, catalog))).not.toContain(route)
    expect(routesOf(visibleNavigation(owner, catalog.filter(tool => tool.id !== id)))).not.toContain(route)
    const unqualified = catalog.map(tool => tool.id === id ? {
      ...tool, status: 'researched' as const, delivery: { ...tool.delivery, status: 'researched' as const },
    } : tool)
    expect(routesOf(visibleNavigation(owner, unqualified))).not.toContain(route)
    expect(routesOf(visibleNavigation(root, catalog))).not.toContain(route)
    expect(routesOf(visibleNavigation(reseller(['edit-account', 'manage-dns']), catalog))).not.toContain(route)
  })
})
