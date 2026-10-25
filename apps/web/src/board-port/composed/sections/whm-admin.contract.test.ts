import { describe, expect, it } from 'vitest'
import { navigation, tools } from '@xpanel/catalog'
import { resolveSurfaceSection } from '../../../shell.ts'
import { composedRouteSpecs, composedXwhmRoutes, nativeComposedRoutePaths } from '../all.ts'
import { renderComposedRoutes } from '../render.ts'
import { xwhm_software } from './xwhm-software.ts'
import { xwhm_server } from './xwhm-server.ts'
import { xwhm_security } from './xwhm-security.ts'
import { xwhm_panel } from './xwhm-panel.ts'
import { xwhm_resellers } from './xwhm-resellers.ts'
import { xwhm_plans } from './xwhm-plans.ts'
import { xwhm_services } from './xwhm-services.ts'

const families = [
  [xwhm_software, 11], [xwhm_server, 8], [xwhm_security, 7],
  [xwhm_panel, 10], [xwhm_resellers, 3], [xwhm_plans, 1], [xwhm_services, 7],
] as const
const routes = families.flatMap(([items]) => [...items])
const nativeRoutes = [
  ['/whm/server/ips', 'ips'], ['/whm/panel/data', 'generations'],
  ['/whm/services/health', 'services'], ['/whm/security/sign-in', 'security'],
  ['/whm/resellers/privileges', 'resellers'],
] as const

describe('xWHM administration route contracts', () => {
  it('retains canonical route and tool identities without promoting qualification', () => {
    const pages = navigation.find(surface => surface.surface === 'xwhm')!.sections.flatMap(section => section.pages)
    const knownTools = new Set(tools.map(tool => tool.id))
    for (const [items, count] of families) expect(items).toHaveLength(count)
    expect(routes).toHaveLength(47)
    expect(new Set(routes.map(spec => spec.route)).size).toBe(47)
    for (const spec of routes) {
      const page = pages.find(page => page.route === spec.route)
      expect(page, spec.route).toBeDefined()
      for (const toolId of page!.tools) expect(knownTools.has(toolId), toolId).toBe(true)
      expect(spec.surface).toBe('xwhm')
      expect(composedRouteSpecs).toContain(spec)
      expect(Object.keys(spec).sort()).toEqual([
        'action', 'bind', 'columns', 'fields', 'group', 'layout', 'lede', 'route', 'section', 'surface', 'title',
      ])
      expect(spec.action).toBeNull()
      expect(spec.fields).toEqual([])
      expect(spec.title.every(value => value.trim().length > 0)).toBe(true)
      expect(spec.lede.every(value => value.trim().length > 0)).toBe(true)
    }
  })

  it('preserves existing native IP, generation, service, security and reseller controllers', () => {
    for (const [route, section] of nativeRoutes) {
      expect(routes.some(spec => spec.route === route), route).toBe(true)
      expect(nativeComposedRoutePaths.has(route), route).toBe(true)
      expect(composedXwhmRoutes.some(spec => spec.route === route), route).toBe(false)
      expect(resolveSurfaceSection('xwhm', route)).toBe(section)
      expect(renderComposedRoutes(routes, { locale: 'en', route, principal: { kind: 'root', id: 'root-test', username: 'root' } })).toBeUndefined()
    }
  })

  it('preserves unwired administration layouts without active command or mutation controls', () => {
    const unwired = routes.filter(spec => spec.bind === 'soon')
    expect(unwired).toHaveLength(44)
    const terminal = unwired.find(spec => spec.route === '/whm/server/terminal')!
    expect(terminal.layout).not.toBe('terminal')
    expect(terminal.lede[0]).toContain('dedicated server session')
    expect(unwired.find(spec => spec.route === '/whm/services/health')!.lede[0]).toContain('A running service is not a configuration-drift result')
    for (const spec of unwired) {
      expect(spec.columns).toEqual([])
      if (nativeComposedRoutePaths.has(spec.route)) continue
      for (const locale of ['en', 'ar'] as const) {
        const html = renderComposedRoutes(routes, { locale, route: spec.route, principal: { kind: 'root', id: 'root-test', username: 'root' } })!
        expect(html, spec.route).toContain('data-read-state="unavailable"')
        // Preserve an unavailable editor's approved structure without enabling commands or mutations.
        expect(html, spec.route).not.toMatch(/<form\b|<input\b|<select\b|<button\b|<table\b|\/api\/|data-terminal/)
        expect(html, spec.route).not.toMatch(/<(?:script|iframe|object|embed)\b|\s(?:on[a-z]+|action|formaction|href)\s*=|data-(?:command|endpoint|submit)/i)
        const editorCount = spec.layout === 'editor' ? 1 : 0
        expect(html.match(/<textarea\b/gi) ?? [], spec.route).toHaveLength(editorCount)
        const editors = [...html.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)]
        expect(editors, spec.route).toHaveLength(editorCount)
        for (const [, attributes, contents] of editors) {
          expect(attributes, spec.route).toMatch(/(?:^|\s)disabled(?:\s|=|$)/)
          expect(attributes, spec.route).toMatch(/(?:^|\s)readonly(?:\s|=|$)/)
          expect(attributes, spec.route).toContain('data-wiring="unavailable"')
          expect(attributes, spec.route).not.toMatch(/\s(?:name|form)\s*=/i)
          expect(contents?.trim(), spec.route).toBe('')
        }
        expect(html, spec.route).not.toContain('data-wiring="read-only"')
      }
    }
  })

  it('does not expose the default-index editor without an authorized administrator context', () => {
    const route = '/whm/services/default-index'
    const principals = [undefined, { kind: 'user' as const, id: 'user-test', username: 'root', accountId: 'account-test' }, { kind: 'reseller' as const, id: 'reseller-test', username: 'root' }]
    for (const principal of principals) for (const locale of ['en', 'ar'] as const) {
      const html = renderComposedRoutes(routes, { locale, route, principal })!
      expect(html).toContain('data-read-state="denied"')
      expect(html).not.toMatch(/<form\b|<input\b|<select\b|<textarea\b|<button\b|<table\b|\/api\/|data-terminal/)
    }
  })

  it('limits nonempty data bindings to stored reseller read models', () => {
    const readModels = routes.filter(spec => spec.bind !== 'soon')
    expect(readModels.map(spec => [spec.route, spec.bind])).toEqual([
      ['/whm/resellers/more', 'resellers'],
      ['/whm/resellers/privileges', 'reseller-acl'],
      ['/whm/resellers/ips-nameservers', 'resellers'],
    ])
    for (const spec of readModels) {
      expect(spec.action).toBeNull()
      expect(spec.fields).toEqual([])
      expect(spec.columns.length).toBeGreaterThan(0)
      expect(spec.lede[0]).toMatch(/(?:Only loaded|unavailable|does not change)/)
    }
    const serialized = JSON.stringify(routes)
    expect(serialized).not.toContain('/api/')
    expect(serialized).not.toContain('mailboxQuotaMb')
  })
})
