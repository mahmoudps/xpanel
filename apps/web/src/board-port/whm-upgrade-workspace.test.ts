import { describe, expect, it } from 'vitest'
import { renderWhmUpgradeWorkspace } from './whm-upgrade-workspace.ts'

describe('WHM upgrade workspace renderer', () => {
  it.each(['en', 'ar'] as const)('keeps every approved card with disabled controls until host observations are read (%s)', locale => {
    const { main, aside } = renderWhmUpgradeWorkspace({ locale, canManage: true, hostname: 'srv.example.test' })
    const html = main + aside
    for (const section of ['upgrade-version', 'upgrade-preflight', 'upgrade-job', 'upgrade-history']) expect(main).toContain(`data-whm-detail-section="${section}"`)
    for (const section of ['upgrade-touches', 'upgrade-health', 'upgrade-phases']) expect(aside).toContain(`data-whm-detail-section="${section}"`)
    for (const element of html.matchAll(/<(?:input|select|textarea|button)\b[^>]*>/g)) expect(element[0]).toMatch(/\bdisabled\b/)
    expect(html).not.toMatch(/<form\b|<h1\b/)
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]!)
    expect(new Set(ids).size).toBe(ids.length)
    expect(html).not.toMatch(/[٠-٩۰-۹]/)
    expect(html).toContain('data-upgrade-can-manage="true"')
    expect(html).toContain('<bdi dir="ltr">srv.example.test</bdi>')
    for (const check of ['disk-space', 'os-supported', 'no-active-transfer', 'version-newer', 'schema-compatible']) expect(main).toContain(`data-upgrade-check="${check}"`)
    if (locale === 'ar') {
      expect(main).toContain('dir="rtl"')
      for (const label of ['ما الذي يتغيّر', 'تأكيد الترقية', 'بدء الترقية', 'إعادة تشغيل الفحص المسبق', 'المضاف', 'إلغاء الترقية المعلقة']) expect(html).toContain(label)
      expect(html).toContain('<bdi dir="ltr">/home</bdi>')
    } else {
      for (const label of ['What changes', 'Confirm upgrade', 'Start upgrade', 'Run preflight again', 'Added', 'Cancel pending upgrade', 'Release notes are not part of the signed release manifest']) expect(html).toContain(label)
    }
  })

  it('marks the workspace unmanageable for a read-only view and never invents a release', () => {
    const { main } = renderWhmUpgradeWorkspace({ locale: 'en', canManage: false })
    expect(main).toContain('data-upgrade-can-manage="false"')
    expect(main).not.toMatch(/\b1\.5\.0\b|signature verified/)
  })
})
