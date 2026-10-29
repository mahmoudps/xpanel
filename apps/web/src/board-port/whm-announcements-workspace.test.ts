import { describe, expect, it } from 'vitest'
import { renderWhmAnnouncementsWorkspace } from './whm-announcements-workspace.ts'

const controls = (html: string): string[] => html.match(/<(?:input|select|textarea|button)\b[^>]*>/g) ?? []

describe('WHM announcements workspace renderer', () => {
  it('renders the complete English page: list, bilingual editor, audience, window and preview', () => {
    const html = renderWhmAnnouncementsWorkspace({ locale: 'en', canManage: true })
    expect(html).toContain('data-whm-detail-route="/whm/accounts/announcements"')
    expect(html).toContain('data-announcements-can-manage="true"')
    expect(html).toContain('<h1>Announcements</h1>')
    expect(html).toContain('Nothing is emailed.')
    expect(html).toContain('Announcements have not been read. No announcement is assumed to be shown.')
    expect(html).toMatch(/<form class="xp-whm-announcements__group" data-whm-announcements-form [^>]*novalidate>/)
    for (const name of ['title-en', 'body-en', 'title-ar', 'body-ar', 'severity', 'audience', 'plan', 'reseller', 'usernames', 'starts', 'ends']) expect(html).toContain(`data-whm-announcements-input="${name}"`)
    expect(html).toMatch(/<input id="whm-announcements-title-ar" [^>]*lang="ar" dir="rtl" maxlength="140"/)
    expect(html).toMatch(/<textarea id="whm-announcements-body-en" [^>]*maxlength="2000"/)
    expect(html).toContain('<option value="maintenance">Maintenance</option>')
    expect(html).toContain('<option value="accounts">Listed accounts</option>')
    expect(html.match(/data-whm-announcements-audience-field="(?:plan|reseller|accounts)" hidden/g)).toHaveLength(3)
    expect(html).toContain('<label for="whm-announcements-starts">Starts (UTC)</label>')
    expect(html).toContain('data-whm-announcements-preview="ar" lang="ar" dir="rtl"')
    expect(html).toContain('<th scope="col">Shown (UTC)</th>')
    expect(html).toContain('links are not made clickable')
    for (const id of html.match(/aria-describedby="[^"]+"/g) ?? []) expect(html).toContain(`id="${id.slice(18, -1)}"`)
    for (const label of html.match(/<label for="[^"]+"/g) ?? []) expect(html).toContain(`id="${label.slice(12, -1)}"`)
  })

  it('renders Arabic RTL copy with ASCII digits only', () => {
    const html = renderWhmAnnouncementsWorkspace({ locale: 'ar', canManage: true })
    expect(html).toContain('lang="ar" dir="rtl"')
    expect(html).toContain('<h1>الإعلانات</h1>')
    expect(html).toContain('حتى 100')
    expect(html).not.toMatch(/[٠-٩۰-۹]/)
    expect(html).not.toMatch(/>(?:Title|Message|Severity|Audience|Preview|Refresh|Create announcement|Cancel editing|English|Arabic)</)
  })

  it('keeps the full layout but renders every control disabled and no form when unavailable', () => {
    const html = renderWhmAnnouncementsWorkspace({ locale: 'en', canManage: false })
    expect(html).toContain('data-capability-state="unavailable"')
    expect(html).not.toContain('<form')
    const all = controls(html)
    expect(all.length).toBeGreaterThan(12)
    for (const control of all) expect(control, control).toMatch(/\sdisabled(?:[\s>]|$)/)
    expect(html).not.toContain('type="submit"')
  })
})
