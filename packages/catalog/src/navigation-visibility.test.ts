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

const fileManagerToolIds = ['file-manager', 'file-text-editor', 'html-editor', 'images']
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
    expect(visibleNavigation({ principal: owner, disabledFeatures: new Set() })).toEqual([])
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
    expect(routesOf(visibleNavigation(ownerContext, fixtures))).toEqual(['/files/manager'])
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

  it.each(['filemanager', 'html-editor', 'images'])('still denies the owner file manager when feature %s is disabled', feature => {
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
    expect(routesOf(visibleNavigation(ownerContext, fixtures))).toEqual(['/files/manager'])
    expect(visibleNavigation({ principal: reseller, reseller: { acl: [] } }, fixtures)).toEqual([])
  })

  it('does not qualify the production catalog or reveal unrelated administrator routes', () => {
    const before = JSON.stringify(productionTools)
    const privateCatalog = qualifiedToolFixtures(productionTools.filter(entry => entry.status !== 'out-of-scope').map(entry => entry.id))
    expect(routesOf(visibleNavigation(ownerContext, privateCatalog)).some(route => route.startsWith('/whm'))).toBe(false)
    expect(JSON.stringify(productionTools)).toBe(before)
    expect(productionTools.filter(entry => entry.status === 'verified')).toEqual([])
    expect(visibleNavigation(ownerContext)).toEqual([])
  })
})
