import { describe, expect, it } from 'vitest'
import { renderWhmFtpLog } from './whm-ftp-log-workspace.ts'

describe('WHM FTP log analysis renderer', () => {
  it('renders the complete workspace in English and Arabic with LTR technical fields and ASCII digits', () => {
    for (const locale of ['en', 'ar'] as const) {
      const html = renderWhmFtpLog({ locale, canRead: true })
      expect(html).toContain(`dir="${locale === 'ar' ? 'rtl' : 'ltr'}"`)
      expect(html).toContain(`lang="${locale}"`)
      expect(html).toContain(locale === 'ar' ? 'البحث في نشاط FTP' : 'Search FTP activity')
      expect(html).toContain(locale === 'ar' ? 'موجات الدخول الفاشل' : 'Failed sign-in bursts')
      expect(html).toContain(locale === 'ar' ? 'المستخدم المحدد' : 'Selected user')
      expect(html).not.toMatch(/[٠-٩۰-۹]/)
      for (const hook of ['data-ftp-log-form', 'data-ftp-log-rows', 'data-ftp-log-table="users"', 'data-ftp-log-table="clients"', 'data-ftp-log-table="bursts"', 'data-ftp-log-detail-facts', 'data-ftp-log-count="uploadBytes"']) expect(html).toContain(hook)
      expect(html.match(/<input [^>]*>/g)!.every(tag => tag.includes('dir="ltr"') && tag.includes(' disabled'))).toBe(true)
      expect(html).toContain('<bdi dir="ltr" data-ftp-log-fact="window">')
    }
  })
  it('keeps the unavailable layout inert without a form', () => {
    const html = renderWhmFtpLog({ locale: 'en', canRead: false })
    expect(html).toContain('FTP log analysis is unavailable here. Nothing was read.')
    expect(html).not.toContain('<form')
    expect(html).toContain('data-ftp-log-can-read="false"')
    expect(html.match(/<button [^>]*>/g)!.every(tag => tag.includes(' disabled'))).toBe(true)
  })
})
