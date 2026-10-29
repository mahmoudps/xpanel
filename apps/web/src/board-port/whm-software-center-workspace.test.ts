import { describe, expect, it } from 'vitest'
import { renderWhmModuleInstallers, renderWhmRuntimes, renderWhmSoftwareCatalog } from './whm-software-center-workspace.ts'

const renderers = { catalog: renderWhmSoftwareCatalog, module: renderWhmModuleInstallers, runtime: renderWhmRuntimes } as const
describe('software center workspace renderers', () => {
  it.each(Object.entries(renderers))('renders the %s page in English and Arabic with the full workspace structure', (page, render) => {
    for (const locale of ['en', 'ar'] as const) {
      const html = render({ locale, canRead: true, canManage: true })
      expect(html).toContain(`data-sc-page="${page}"`)
      expect(html).toContain(`lang="${locale}" dir="${locale === 'ar' ? 'rtl' : 'ltr'}"`)
      for (const marker of ['data-sc-source="shipped"', 'data-sc-source="external"', 'data-sc-category', 'data-sc-search', 'data-sc-refresh', 'data-sc-status', 'data-sc-groups', 'data-sc-preview', 'data-sc-preview-extra', 'data-sc-accept-extra', 'data-sc-confirm', 'data-sc-job-link']) expect(html).toContain(marker)
      expect(html).toContain('data-sc-can-manage="true"')
      expect(html).not.toMatch(/[٠-٩۰-۹]/)
      expect(html).toContain('href="/whm/jobs"')
      if (locale === 'ar') {
        expect(html).toContain('الفهرس المراجَع المضمَّن')
        expect(html).toContain('غير متاح')
        expect(html).not.toContain('Read installed packages')
      } else {
        expect(html).toContain('Shipped reviewed catalog')
        expect(html).toContain('signed third-party catalogs are not supported')
      }
    }
    expect(render({ locale: 'en', canRead: true, canManage: true })).toContain('<bdi dir="ltr" data-sc-observed-at>')
  })

  it('lists page-specific categories and the PHP version fact only on the module page', () => {
    expect(renderWhmSoftwareCatalog({ locale: 'en', canRead: true, canManage: true })).toContain('<option value="security">Security</option>')
    expect(renderWhmRuntimes({ locale: 'ar', canRead: true, canManage: true })).toContain('<option value="java">Java</option>')
    expect(renderWhmModuleInstallers({ locale: 'ar', canRead: true, canManage: true })).toContain('<option value="perl">وحدات Perl</option>')
    expect(renderWhmModuleInstallers({ locale: 'en', canRead: true, canManage: true })).toContain('data-sc-php-versions')
    expect(renderWhmRuntimes({ locale: 'en', canRead: true, canManage: true })).not.toContain('data-sc-php-versions')
  })

  it('never grants management without read authority and claims no state before a read', () => {
    const html = renderWhmSoftwareCatalog({ locale: 'en', canRead: false, canManage: true })
    expect(html).toContain('data-sc-can-read="false"')
    expect(html).toContain('data-sc-can-manage="false"')
    expect(html).toMatch(/data-sc-refresh disabled/)
    expect(html).toContain('No component is shown as installed or available.')
    expect(html).not.toMatch(/xp-badge--ok">Installed/)
  })

  it('uses only the approved spacing scale and page-scoped selectors', () => {
    const css = /<style>([\s\S]*?)<\/style>/.exec(renderWhmSoftwareCatalog({ locale: 'en', canRead: true, canManage: true }))![1]!
    for (const [, value] of css.matchAll(/(?:gap|padding):(\d+)px/g)) expect(['8', '16', '24', '32']).toContain(value)
    for (const rule of css.split('}').map(part => part.trim()).filter(part => part && !part.startsWith('@media'))) expect(rule.replace(/^@media[^{]*\{/, '')).toMatch(/^\.xp-whm-software/)
  })
})
