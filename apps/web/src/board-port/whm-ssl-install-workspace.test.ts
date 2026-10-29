import { describe, expect, it } from 'vitest'
import { renderWhmSslInstallChoices, renderWhmSslInstallWorkspace } from './whm-ssl-install-workspace.ts'

describe('WHM manual certificate installation renderer', () => {
  it.each(['en', 'ar'] as const)('renders an inert %s wizard with every control disabled until bound', locale => {
    const html = renderWhmSslInstallWorkspace({ locale, canManage: true }) + renderWhmSslInstallChoices({ locale })
    expect(html).toContain(`lang="${locale}" dir="${locale === 'ar' ? 'rtl' : 'ltr'}"`)
    for (const key of ['domain', 'names', 'certificate', 'chain', 'key', 'checks', 'status', 'refresh', 'submit', 'clear', 'result', 'facts', 'choices']) expect(html).toContain('data-ssl-install-' + key)
    for (const control of html.matchAll(/<(?:input|select|textarea|button)\b[^>]*>/g)) expect(control[0]).toMatch(/\bdisabled\b/)
    expect(html).not.toMatch(/<form\b|innerHTML/)
    expect(html).toMatch(/<bdi dir="ltr">-----BEGIN CERTIFICATE-----<\/bdi>/)
    expect([...html.matchAll(/data-ssl-install-step="\d"/g)]).toHaveLength(3)
    expect(html).not.toMatch(/[٠-٩۰-۹]/)
    if (locale === 'ar') { expect(html).toContain('تثبيت الشهادة'); expect(html).toContain('المفتاح الخاص (PEM)'); expect(html).not.toContain('Install certificate') }
    else { expect(html).toContain('Install certificate'); expect(html).toContain('CA bundle (optional)') }
  })
  it('marks the management capability from the caller and keeps the result panel hidden', () => {
    expect(renderWhmSslInstallWorkspace({ locale: 'en', canManage: false })).toContain('data-ssl-install-can-manage="false"')
    expect(renderWhmSslInstallWorkspace({ locale: 'en', canManage: true })).toMatch(/data-ssl-install-result[^>]*hidden/)
  })
})
