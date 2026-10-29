import { describe, expect, it } from 'vitest'
import { renderWhmUpdatesWorkspace } from './whm-updates-workspace.ts'

describe('WHM system updates workspace renderer', () => {
  it('renders the English plan, actions and package table in a truthful unread state', () => {
    const html = renderWhmUpdatesWorkspace({ locale: 'en', canRead: true, canApply: true })
    expect(html).toContain('dir="ltr"')
    expect(html).toContain('No update plan has been read. Nothing has been changed.')
    for (const label of ['Source', 'Observed at (UTC)', 'Pending packages', 'Security updates', 'Kernel packages', 'Held packages', 'Reboot required', 'Candidate', 'Origin']) expect(html).toContain(label)
    expect(html).toContain('<button type="button" class="xp-btn" data-whm-updates-action="read">Read update plan</button>')
    for (const key of ['refresh', 'security', 'selected', 'all']) expect(html).toMatch(new RegExp('data-whm-updates-action="' + key + '" disabled'))
    expect(html).toContain('needrestart only lists services')
    expect(html).toContain('data-whm-updates-job hidden')
    expect(html).toContain('<bdi dir="ltr" data-whm-updates-fact="observed-at">Not read</bdi>')
    expect(html).not.toContain('undefined')
  })
  it('renders Arabic RTL copy with ASCII digits and isolated technical values', () => {
    const html = renderWhmUpdatesWorkspace({ locale: 'ar', canRead: true, canApply: false })
    expect(html).toContain('lang="ar" dir="rtl"')
    for (const label of ['خطة التحديث', 'قراءة خطة التحديث', 'تطبيق تحديثات الأمان', 'تطبيق المحدد', 'تطبيق الكل', 'الحزم المحجوزة', 'إعادة التشغيل مطلوبة', 'وقت الرصد (UTC)']) expect(html).toContain(label)
    expect(html).toContain('data-updates-can-apply="false"')
    expect(html).not.toMatch(/[٠-٩۰-۹]/)
    expect(html).toContain('<bdi dir="ltr" data-whm-updates-fact="source">غير مقروء</bdi>')
    expect(html).toContain('href="/whm/jobs?lang=ar"')
  })
  it('keeps every action disabled when reads are not allowed', () => {
    const html = renderWhmUpdatesWorkspace({ locale: 'en', canRead: false, canApply: false })
    expect(html.match(/data-whm-updates-action="[a-z]+" disabled/g)).toHaveLength(5)
    expect(html).toContain('data-updates-can-read="false"')
  })
})

describe('kernel exclusion option renderer', () => {
  it.each(['en', 'ar'] as const)('preserves the table and explicit per-job option in %s', locale => {
    const html = renderWhmUpdatesWorkspace({ locale, canRead: true, canApply: true })
    expect(html).toContain('data-whm-updates-exclude-kernel')
    expect(html).toContain('aria-describedby="whm-updates-exclude-help"')
    expect(html).toContain('.xp-whm-updates__option{display:flex;flex-direction:column;gap:8px}')
    expect(html).toContain('data-whm-updates-rows')
    expect(html).not.toMatch(/[٠-٩۰-۹]/)
  })
  it('keeps the visible option disabled for an unavailable workspace', () => {
    const html = renderWhmUpdatesWorkspace({ locale: 'en', canRead: false, canApply: false })
    expect(html).toContain('data-whm-updates-exclude-kernel aria-describedby="whm-updates-exclude-help" disabled')
  })
})

