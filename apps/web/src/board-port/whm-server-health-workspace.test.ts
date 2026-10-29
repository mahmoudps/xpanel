import { describe, expect, it } from 'vitest'
import { renderWhmServerHealth, renderWhmServerLimits } from './whm-server-health-workspace.ts'

const pages = { health: renderWhmServerHealth, limits: renderWhmServerLimits }

describe('WHM server health and limits renderers', () => {
  it.each(Object.entries(pages))('renders %s in English and Arabic with ASCII digits and logical direction', (_kind, render) => {
    const en = render({ locale: 'en', canRead: true }), ar = render({ locale: 'ar', canRead: true })
    expect(en).toContain('lang="en" dir="ltr"')
    expect(ar).toContain('lang="ar" dir="rtl"')
    expect(ar).toMatch(/[\u0600-\u06ff]/)
    expect(en + ar).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
    expect(en + ar).not.toMatch(/\b(?:margin|padding)-(?:left|right)\b|\b(?:left|right):/)
    expect(en).toContain('data-server-health-can-read="true"')
    expect(en).not.toContain(' disabled')
  })
  it('keeps the approved layout in unavailable mode with no form and every control disabled', () => {
    for (const render of Object.values(pages)) {
      const html = render({ locale: 'en', canRead: false })
      expect(html).not.toContain('<form')
      expect(html).toContain('data-server-health-can-read="false"')
      expect(html).toContain('data-state="unavailable"')
      const controls = html.match(/<(?:button|input|select)\b[^>]*>/g) ?? []
      expect(controls.length).toBeGreaterThan(0)
      for (const control of controls) expect(control).toContain(' disabled')
    }
  })
  it('links the health page to the pages that own slower reads and the limits page to plan editing', () => {
    const health = renderWhmServerHealth({ locale: 'en', canRead: true }), limits = renderWhmServerLimits({ locale: 'ar', canRead: true })
    for (const href of ['/whm/software/updates', '/whm/monitoring/repair', '/whm/monitoring/server-info']) expect(health).toContain(`href="${href}"`)
    expect(health).toContain('data-whm-server-health-checks')
    expect(health).toContain('data-whm-server-health-thresholds')
    expect(limits).toContain('href="/whm/plans"')
    expect(limits).toContain('data-whm-server-health-accounts')
    expect(limits).toContain('<bdi dir="ltr" data-whm-server-health-observed-at>')
    expect(limits).toContain('90%')
  })
})
