import { describe, expect, it } from 'vitest'
import { tools } from './data/index.ts'
import { navigation } from './data/navigation.ts'
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
})
