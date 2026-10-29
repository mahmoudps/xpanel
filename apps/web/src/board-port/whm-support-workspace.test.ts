import { describe, expect, it } from 'vitest'
import { renderWhmSupportWorkspace } from './whm-support-workspace.ts'

describe('WHM support renderer', () => {
  it('renders English and Arabic with ASCII digits, logical direction and every section', () => {
    const en = renderWhmSupportWorkspace({ locale: 'en', canRead: true }), ar = renderWhmSupportWorkspace({ locale: 'ar', canRead: true })
    expect(en).toContain('lang="en" dir="ltr"')
    expect(ar).toContain('lang="ar" dir="rtl"')
    expect(ar).toMatch(/[؀-ۿ]/)
    expect(ar).toContain('تنزيل حزمة الدعم')
    expect(en + ar).not.toMatch(/[٠-٩۰-۹]/)
    expect(en + ar).not.toMatch(/\b(?:margin|padding)-(?:left|right)\b|\b(?:left|right):/)
    for (const section of ['summary', 'services', 'configuration', 'jobs', 'bundle', 'contact']) expect(en).toContain(`data-whm-support-section="${section}"`)
    for (const marker of ['data-whm-support-included', 'data-whm-support-excluded', 'data-whm-support-redaction', 'data-whm-support-services', 'data-whm-support-jobs', 'data-whm-support-contact']) expect(en).toContain(marker)
    expect(en).toContain('data-support-can-read="true"')
    expect(en).toContain('href="/whm/jobs"')
    expect(en).toContain('href="/whm/monitoring/repair"')
  })

  it('keeps the download and its confirmation disabled until the manifest is read', () => {
    const html = renderWhmSupportWorkspace({ locale: 'en', canRead: true })
    expect(html).toMatch(/<input type="checkbox"[^>]*data-whm-support-confirm disabled>/)
    expect(html).toMatch(/<button[^>]*data-whm-support-download disabled>/)
    expect(html).toMatch(/<button[^>]*data-whm-support-refresh>/)
    expect(html).toContain('<label class="xp-whm-support__confirm" for="whm-support-confirm">')
  })

  it('stays inert in unavailable mode: no form, every control disabled, unavailable status', () => {
    const html = renderWhmSupportWorkspace({ locale: 'ar', canRead: false })
    expect(html).not.toContain('<form')
    expect(html).toContain('data-support-can-read="false"')
    expect(html).toContain('data-state="unavailable"')
    const controls = html.match(/<(?:button|input|select)\b[^>]*>/g) ?? []
    expect(controls.length).toBe(3)
    for (const control of controls) expect(control).toContain(' disabled')
  })
})
