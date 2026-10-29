import { describe, expect, it } from 'vitest'
import { renderWhmSecurityToolsWorkspace } from './whm-security-tools-workspace.ts'

const pages = ['intrusion', 'antivirus', 'isolation'] as const
const controls = (html: string) => [...html.matchAll(/<(input|select|textarea|button)\b[^>]*>/g)].map(match => match[0])

describe('WHM security tools renderer', () => {
  it('renders each English page with its own sections and unread states', () => {
    const intrusion = renderWhmSecurityToolsWorkspace({ page: 'intrusion', locale: 'en', canRead: true, canManage: true })
    expect(intrusion).toContain('data-security-tools-page="intrusion"')
    expect(intrusion).toContain('data-whm-security-tools-rows="jails"')
    expect(intrusion).toContain('data-whm-security-tools-rows="banned"')
    expect(intrusion).toContain('href="/whm/software/catalog?lang=en"')
    expect(intrusion).toContain('Subnet entries are shown but cannot be unbanned here.')
    const antivirus = renderWhmSecurityToolsWorkspace({ page: 'antivirus', locale: 'en', canRead: true, canManage: true })
    for (const key of ['scans', 'findings', 'updates']) expect(antivirus).toContain(`data-whm-security-tools-rows="${key}"`)
    expect(antivirus).toContain('Quarantine and deletion are not available here.')
    expect(antivirus).toMatch(/data-whm-security-tools-scan disabled/)
    const isolation = renderWhmSecurityToolsWorkspace({ page: 'isolation', locale: 'en', canRead: true, canManage: true })
    expect(isolation).toContain('data-whm-security-tools-rows="checks"')
    expect(isolation).toContain('href="/whm/monitoring/repair?lang=en"')
    expect(isolation).toContain('This view is read-only.')
    for (const page of pages) {
      const html = renderWhmSecurityToolsWorkspace({ page, locale: 'en', canRead: true, canManage: true })
      expect(html).toContain('dir="ltr"')
      expect(html).toContain('Nothing has been read yet.')
      expect(html).not.toContain('<form')
      expect(html).not.toContain('Changes require root authorization.')
      expect(html).toMatch(/@media\(min-width:601px\)\{\.xp-whm-security-tools__card\{padding:var\(--xp-space-card\)\}\}/)
      expect(html).toMatch(/gap:8px/); expect(html).toMatch(/gap:16px/); expect(html).toMatch(/gap:24px/); expect(html).toMatch(/gap:32px/)
    }
  })
  it('renders Arabic RTL copy with ASCII digits and technical values isolated left-to-right', () => {
    for (const page of pages) {
      const html = renderWhmSecurityToolsWorkspace({ page, locale: 'ar', canRead: true, canManage: true })
      expect(html).toContain('dir="rtl"'); expect(html).toContain('lang="ar"')
      expect(html).toContain('<bdi dir="ltr" data-whm-security-tools-fact="observed-at">غير مقروء</bdi>')
      expect(html).toContain('لم يُقرأ شيء بعد.')
      expect(html).not.toMatch(/[٠-٩۰-۹]/)
      expect(html).not.toMatch(/Nothing has been read yet|Refresh</)
    }
    expect(renderWhmSecurityToolsWorkspace({ page: 'antivirus', locale: 'ar', canRead: true, canManage: true })).toContain('100 MB')
    expect(renderWhmSecurityToolsWorkspace({ page: 'intrusion', locale: 'ar', canRead: true, canManage: true })).toContain('dir="ltr" maxlength="45"')
  })
  it('keeps the layout inert without root read authority: every control disabled and no form', () => {
    for (const page of pages) for (const locale of ['en', 'ar'] as const) {
      const html = renderWhmSecurityToolsWorkspace({ page, locale, canRead: false, canManage: true })
      expect(html).toContain('data-security-tools-can-read="false"')
      expect(html).toContain('data-security-tools-can-manage="false"')
      expect(html).toContain('data-state="unavailable"')
      expect(html).not.toContain('<form')
      const found = controls(html)
      expect(found.length).toBeGreaterThan(0)
      for (const control of found) expect(control).toMatch(/\sdisabled[\s>]/)
    }
    expect(renderWhmSecurityToolsWorkspace({ page: 'intrusion', locale: 'en', canRead: true, canManage: false })).toContain('Changes require root authorization.')
  })
})
