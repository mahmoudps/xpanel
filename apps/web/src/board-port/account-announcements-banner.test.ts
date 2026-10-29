import { describe, expect, it } from 'vitest'
import { renderAccountAnnouncementNotice, renderAccountAnnouncementsBanner } from './account-announcements-banner.ts'
import type { AccountAnnouncementNotice } from './account-announcements-banner.ts'

const notice = (overrides: Partial<AccountAnnouncementNotice> = {}): AccountAnnouncementNotice => ({
  id: '77777777-7777-4777-8777-000000000001', severity: 'maintenance', title: { en: 'Planned maintenance', ar: 'صيانة مجدولة' },
  body: { en: 'Mail restarts tonight.\nExpect 5 minutes.', ar: 'يُعاد تشغيل البريد الليلة.' }, startsAt: null, endsAt: '2026-10-30T18:00:00.000Z', ...overrides,
})

describe('account announcements banner renderer', () => {
  it('renders a hidden, empty region when there is nothing to show', () => {
    const html = renderAccountAnnouncementsBanner({ locale: 'en', announcements: [] })
    expect(html).toMatch(/<section class="xp-account-announcements" data-account-announcements data-state="unread" lang="en" dir="ltr" aria-label="Announcements" hidden>/)
    expect(html).not.toContain('data-account-announcement=')
    expect(html).not.toContain(' id=')
  })

  it('renders English notices with severity, end time and a labelled dismiss control', () => {
    const html = renderAccountAnnouncementsBanner({ locale: 'en', announcements: [notice(), notice({ id: '77777777-7777-4777-8777-000000000002', severity: 'warning', endsAt: null })] })
    expect(html).not.toMatch(/aria-label="Announcements" hidden/)
    expect(html.match(/role="status"/g)).toHaveLength(3)
    expect(html).toContain('<span class="xp-account-announcement__severity">Maintenance</span><span>Planned maintenance</span>')
    expect(html).toContain('<p class="xp-help">Until <bdi dir="ltr">2026-10-30 18:00 UTC</bdi></p>')
    expect(html).toContain('aria-label="Dismiss announcement: Planned maintenance">Dismiss</button>')
    expect(html).toContain('data-severity="warning"')
    expect(html.match(/Until /g)).toHaveLength(1)
  })

  it('renders Arabic RTL notices with ASCII digits only in its own copy', () => {
    const html = renderAccountAnnouncementsBanner({ locale: 'ar', announcements: [notice()] })
    expect(html).toContain('lang="ar" dir="rtl" aria-label="الإعلانات"')
    expect(html).toContain('<span class="xp-account-announcement__severity">صيانة</span><span>صيانة مجدولة</span>')
    expect(html).toContain('حتى <bdi dir="ltr">2026-10-30 18:00 UTC</bdi>')
    expect(html).toContain('aria-label="إخفاء الإعلان: صيانة مجدولة">إخفاء</button>')
    expect(html).not.toMatch(/[٠-٩۰-۹]/)
    expect(html).not.toMatch(/>(?:Dismiss|Maintenance|Until )</)
  })

  it('escapes announcement text instead of rendering it as markup', () => {
    const html = renderAccountAnnouncementNotice(notice({ title: { en: '<img src=x onerror=alert(1)>', ar: 'x' }, body: { en: '<script>alert(1)</script> & "q"', ar: 'x' } }), 'en', true)
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;')
  })
})

describe('complete server announcement timestamps', () => {
  it.each(['en', 'ar'] as const)('preserves the exact end instant in %s', locale => {
    const endsAt = '2026-10-30T18:19:20.345Z'
    const html = renderAccountAnnouncementsBanner({ locale, announcements: [notice({ endsAt })] })
    expect(html).toContain('<bdi dir="ltr">2026-10-30 18:19 UTC</bdi>')
    expect(html).not.toMatch(/[٠-٩۰-۹]/)
  })
})
