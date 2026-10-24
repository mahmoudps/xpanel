import { describe, expect, it } from 'vitest'
import type { Principal } from '@xpanel/core'
import { visibleNavigation } from './navigation.ts'
import { tools as productionTools } from './data/index.ts'
import { navigation } from './data/navigation.ts'
import { isVisible } from './visibility.ts'
import type { CatalogTool, NavSurface } from './types.ts'

const owner: Principal = { kind: 'user', id: 'u1', username: 'owner', accountId: 'a1' }
const root: Principal = { kind: 'root', id: 'r1', username: 'root' }
const reseller: Principal = { kind: 'reseller', id: 'rs1', username: 'reseller' }
const tool = (over: Partial<CatalogTool> = {}): CatalogTool => ({
  id: 'file', name: 'File', summary: '', groupId: 'files', surface: 'xpanel', featureKey: 'filemanager',
  resellerAcl: null, rootOnly: false, entity: 'file', status: 'verified',
  delivery: { status: 'verified', reason: 'Synthetic navigation fixture.', evidence: [] }, ...over,
})
const design: NavSurface[] = [{
  surface: 'xpanel', sections: [{ id: 'files', name: 'Files', icon: 'File', pages: [{
    id: 'file', name: 'File', route: '/files', template: 'list', artboard: null,
    primaryAction: 'Create', roles: ['owner'], tools: ['file'], keywords: [], summary: '',
  }] }],
}]

const fileManagerToolIds = ['file-manager', 'file-text-editor']
const ownerContractSplits = [
  { route: '/email/forwarders', core: ['forwarders', 'domain-forwarders', 'default-address', 'autoresponders'], adminRoute: '/whm/email/bcc', admin: ['aapanel-mail-bcc'] },
  { route: '/email/mailing-lists', core: ['mailing-lists'], adminRoute: '/whm/email/marketing', admin: ['aapanel-mail-subscribers', 'aapanel-mail-campaigns', 'aapanel-mail-automation'] },
  { route: '/files/ftp', core: ['ftp-accounts', 'ftp-connections', 'anonymous-ftp'], adminRoute: '/whm/services/ftp-log-analysis', admin: ['aapanel-ftp-logs'] },
  { route: '/software/installer', core: ['app-installer'], adminRoute: '/whm/software/deployments', admin: ['aapanel-one-click-deploy'] },
  { route: '/software/apps', core: ['nodejs-apps', 'python-apps', 'ruby-apps', 'application-manager', 'web-apps'], adminRoute: '/whm/software/application-projects', admin: ['aapanel-go-project', 'aapanel-java-project'] },
  { route: '/software/packages', core: ['php-pear-packages', 'perl-modules'], adminRoute: '/whm/software/composer', admin: ['aapanel-composer'] },
  { route: '/advanced/indexes', core: ['indexes'], adminRoute: '/whm/services/default-index', admin: ['aapanel-default-index'] },
]
const ownerContext = { principal: owner, disabledFeatures: new Set<string>() }
const routesOf = (surfaces: readonly NavSurface[]): string[] =>
  surfaces.flatMap(surface => surface.sections.flatMap(section => section.pages.map(page => page.route)))
const qualifiedToolFixtures = (ids: readonly string[]): CatalogTool[] => ids.map(id => {
  const definition = productionTools.find(entry => entry.id === id)
  if (!definition) throw new Error(`Missing actual catalog definition: ${id}`)
  return {
    ...definition,
    status: 'verified',
    delivery: { status: 'verified', reason: 'Private navigation regression fixture; not production qualification.', evidence: [] },
  }
})

describe('verified navigation policy', () => {
  it('fails closed without an authenticated context and leaves design metadata unchanged', () => {
    const before = JSON.stringify(design)
    expect(visibleNavigation(undefined, [tool()], design)).toEqual([])
    expect(visibleNavigation({ principal: owner, disabledFeatures: new Set() }, [tool()], design)).toHaveLength(1)
    expect(JSON.stringify(design)).toBe(before)
  })

  it('does not publish unverified catalog navigation in any surface', () => {
    expect(routesOf(visibleNavigation({ principal: owner, disabledFeatures: new Set() }))).toEqual(['/home'])
    expect(visibleNavigation({ principal: { ...owner, accountId: '' }, disabledFeatures: new Set() })).toEqual([])
    expect(visibleNavigation({ principal: root })).toEqual([])
    expect(visibleNavigation({ principal: reseller, reseller: { acl: ['manage-dns'] } })).toEqual([])
  })

  it('requires feature availability, page role and tool audience together', () => {
    expect(visibleNavigation({ principal: owner }, [tool()], design)).toEqual([])
    expect(visibleNavigation({ principal: owner, disabledFeatures: new Set(['filemanager']) }, [tool()], design)).toEqual([])
    expect(visibleNavigation({ principal: root }, [tool()], design)).toEqual([])
    const rootOnlyPage = structuredClone(design)
    rootOnlyPage[0]!.sections[0]!.pages[0]!.roles = ['root']
    expect(visibleNavigation({ principal: owner, disabledFeatures: new Set() }, [tool()], rootOnlyPage)).toEqual([])
  })

  it('does not expose a mixed page when one represented action is unverified', () => {
    const mixed = structuredClone(design)
    mixed[0]!.sections[0]!.pages[0]!.tools.push('trash')
    expect(visibleNavigation({ principal: owner, disabledFeatures: new Set() }, [tool(), tool({ id: 'trash', status: 'researched' })], mixed)).toEqual([])
    expect(visibleNavigation({ principal: owner, disabledFeatures: new Set() }, [tool(), tool({ id: 'trash' })], mixed)).toHaveLength(1)
  })

  it('enforces reseller ACLs both on the page and the represented capability', () => {
    const admin = structuredClone(design)
    admin[0]!.surface = 'xwhm'
    admin[0]!.sections[0]!.pages[0]!.roles = ['root', 'reseller:manage-dns']
    const dns = tool({ surface: 'xwhm', featureKey: null, resellerAcl: 'manage-dns' })
    expect(visibleNavigation({ principal: reseller, reseller: { acl: [] } }, [dns], admin)).toEqual([])
    expect(visibleNavigation({ principal: reseller, reseller: { acl: ['manage-dns'] } }, [dns], admin)).toHaveLength(1)
    expect(visibleNavigation({ principal: reseller, reseller: { acl: ['manage-dns'] } }, [tool({ ...dns, rootOnly: true })], admin)).toEqual([])
    expect(visibleNavigation({ principal: root }, [dns], admin)).toHaveLength(1)
  })

  it('drops pages without deliverable capabilities and all empty containers', () => {
    const empty = structuredClone(design)
    empty[0]!.sections[0]!.pages[0]!.tools = []
    expect(visibleNavigation({ principal: owner, disabledFeatures: new Set() }, [tool()], empty)).toEqual([])
  })

  it('allows the actual owner file manager when its account capabilities are qualified', () => {
    const fixtures = qualifiedToolFixtures(fileManagerToolIds)
    const page = navigation.find(surface => surface.surface === 'xpanel')!.sections
      .flatMap(section => section.pages).find(entry => entry.route === '/files/manager')!
    expect(page.tools).toEqual(fileManagerToolIds)
    expect(routesOf(visibleNavigation(ownerContext, fixtures))).toEqual(['/home', '/files/manager'])
    expect(visibleNavigation({ principal: root }, fixtures)).toEqual([])
  })

  it.each(fileManagerToolIds)('still denies the actual owner file manager if %s is missing or unqualified', id => {
    const fixtures = qualifiedToolFixtures(fileManagerToolIds)
    expect(routesOf(visibleNavigation(ownerContext, fixtures.filter(entry => entry.id !== id))))
      .not.toContain('/files/manager')
    const unqualified = fixtures.map(entry => entry.id === id ? {
      ...entry, status: 'researched' as const, delivery: { ...entry.delivery, status: 'researched' as const },
    } : entry)
    expect(routesOf(visibleNavigation(ownerContext, unqualified))).not.toContain('/files/manager')
  })

  it.each(['filemanager'])('still denies the owner file manager when feature %s is disabled', feature => {
    expect(routesOf(visibleNavigation({ principal: owner, disabledFeatures: new Set([feature]) }, qualifiedToolFixtures(fileManagerToolIds))))
      .not.toContain('/files/manager')
  })

  it('keeps file-sharing links on a separate root-only page without granting them to owners or resellers', () => {
    const fixtures = qualifiedToolFixtures([...fileManagerToolIds, 'aapanel-file-share'])
    const share = fixtures.find(entry => entry.id === 'aapanel-file-share')!
    expect(share.surface).toBe('aapanel')
    expect(share.rootOnly).toBe(true)
    expect(isVisible(share, ownerContext)).toBe(false)
    expect(isVisible(share, { principal: root })).toBe(true)
    expect(isVisible(share, { principal: reseller, reseller: { acl: [] } })).toBe(false)
    expect(routesOf(visibleNavigation({ principal: root }, fixtures))).toEqual(['/whm/server/file-sharing'])
    expect(routesOf(visibleNavigation(ownerContext, fixtures))).toEqual(['/home', '/files/manager'])
    expect(visibleNavigation({ principal: reseller, reseller: { acl: [] } }, fixtures)).toEqual([])
  })

  it('does not qualify the production catalog or reveal unrelated administrator routes', () => {
    const before = JSON.stringify(productionTools)
    const privateCatalog = qualifiedToolFixtures(productionTools.filter(entry => entry.status !== 'out-of-scope').map(entry => entry.id))
    expect(routesOf(visibleNavigation(ownerContext, privateCatalog)).some(route => route.startsWith('/whm'))).toBe(false)
    expect(JSON.stringify(productionTools)).toBe(before)
    expect(productionTools.filter(entry => entry.status === 'verified')).toEqual([])
    expect(routesOf(visibleNavigation(ownerContext))).toEqual(['/home'])
    expect(visibleNavigation({ principal: root })).toEqual([])
  })

  it.each(ownerContractSplits)('keeps $route eligible using only its qualified account capabilities', contract => {
    const page = navigation.flatMap(surface => surface.sections.flatMap(section => section.pages))
      .find(entry => entry.route === contract.route)!
    expect(page.tools).toEqual(contract.core)
    const fixtures = qualifiedToolFixtures(contract.core)
    expect(routesOf(visibleNavigation(ownerContext, fixtures))).toContain(contract.route)
    expect(routesOf(visibleNavigation(ownerContext, fixtures))).not.toContain(contract.adminRoute)
    expect(routesOf(visibleNavigation({ principal: root }, fixtures))).not.toContain(contract.route)
    expect(routesOf(visibleNavigation({ principal: reseller, reseller: { acl: [] } }, fixtures))).not.toContain(contract.route)
  })

  it.each(ownerContractSplits)('still requires every account capability and enabled feature for $route', contract => {
    const fixtures = qualifiedToolFixtures(contract.core)
    for (const id of contract.core) {
      expect(routesOf(visibleNavigation(ownerContext, fixtures.filter(entry => entry.id !== id))), `missing ${id}`)
        .not.toContain(contract.route)
      for (const status of ['researched', 'implemented', 'integrated'] as const) {
        const unqualified = fixtures.map(entry => entry.id === id ? {
          ...entry, status, delivery: { ...entry.delivery, status },
        } : entry)
        expect(routesOf(visibleNavigation(ownerContext, unqualified)), `${id}: ${status}`).not.toContain(contract.route)
      }
    }
    const features = [...new Set(fixtures.flatMap(entry => entry.featureKey === null ? [] : [entry.featureKey]))]
    expect(features.length).toBeGreaterThan(0)
    for (const feature of features) {
      expect(routesOf(visibleNavigation({ principal: owner, disabledFeatures: new Set([feature]) }, fixtures)), feature)
        .not.toContain(contract.route)
    }
  })

  it.each(ownerContractSplits)('keeps $adminRoute root-only and requires every administrative capability', contract => {
    const fixtures = qualifiedToolFixtures([...contract.core, ...contract.admin])
    for (const id of contract.admin) {
      const definition = fixtures.find(entry => entry.id === id)!
      expect(definition.rootOnly).toBe(true)
      expect(definition.surface).toBe('aapanel')
      expect(isVisible(definition, ownerContext)).toBe(false)
      expect(isVisible(definition, { principal: reseller, reseller: { acl: ['manage-dns', 'edit-account'] } })).toBe(false)
      expect(routesOf(visibleNavigation({ principal: root }, fixtures.filter(entry => entry.id !== id))), `missing ${id}`)
        .not.toContain(contract.adminRoute)
      const unqualified = fixtures.map(entry => entry.id === id ? {
        ...entry, status: 'researched' as const, delivery: { ...entry.delivery, status: 'researched' as const },
      } : entry)
      expect(routesOf(visibleNavigation({ principal: root }, unqualified)), `unqualified ${id}`).not.toContain(contract.adminRoute)
    }
    expect(routesOf(visibleNavigation({ principal: root }, fixtures))).toContain(contract.adminRoute)
    expect(routesOf(visibleNavigation(ownerContext, fixtures))).toContain(contract.route)
    expect(routesOf(visibleNavigation(ownerContext, fixtures))).not.toContain(contract.adminRoute)
    expect(routesOf(visibleNavigation({ principal: reseller, reseller: { acl: ['manage-dns', 'edit-account'] } }, fixtures)))
      .not.toContain(contract.adminRoute)
  })

  it('keeps the three routes without a bounded owner contract unavailable even in a qualified synthetic catalog', () => {
    const fixtures = qualifiedToolFixtures(productionTools.filter(entry => entry.status !== 'out-of-scope').map(entry => entry.id))
    for (const route of ['/domains/site-settings', '/domains/reverse-proxy', '/software/htaccess']) {
      const page = navigation.flatMap(surface => surface.sections.flatMap(section => section.pages)).find(entry => entry.route === route)!
      expect(page.tools.length).toBeGreaterThan(0)
      expect(page.tools.some(id => fixtures.find(entry => entry.id === id)?.rootOnly)).toBe(true)
      expect(routesOf(visibleNavigation(ownerContext, fixtures))).not.toContain(route)
    }
  })
})
