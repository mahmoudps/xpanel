import { describe, expect, it } from 'vitest'
import { composedRouteSpecs } from '../all.ts'

describe('account route metadata', () => {
  it('preserves 39 paths across 8 families without fake forms, controller aliases or provenance', () => {
    const routes = composedRouteSpecs.filter(spec => spec.surface === 'xpanel')
    expect(routes).toHaveLength(39)
    expect(new Set(routes.map(spec => spec.section)).size).toBe(8)
    for (const spec of routes) {
      expect(Object.keys(spec).sort()).toEqual(['action', 'bind', 'columns', 'fields', 'group', 'layout', 'lede', 'route', 'section', 'surface', 'title'])
      expect(spec.fields).toEqual([])
      expect(spec.action).toBeNull()
      if (spec.bind === 'soon') {
        expect(spec.columns).toEqual([])
        expect(spec.layout).toBe('settings')
      }
    }
    expect(JSON.stringify(routes)).not.toMatch(/\/api\/|\.dc\.html|DESIGN-COVERAGE/)
  })
})
