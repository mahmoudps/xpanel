import { describe, expect, it } from 'vitest'
import { renderWhmMailboxMaintenanceWorkspace } from './whm-mailbox-maintenance-workspace.ts'

const controls = (html: string) => [...html.matchAll(/<(input|select|textarea|button)\b[^>]*>/g)].map(match => match[0])

describe('WHM mailbox maintenance renderer', () => {
  it('renders the English picker, usage tables, actions and truthful notes', () => {
    const html = renderWhmMailboxMaintenanceWorkspace({ locale: 'en', canRead: true, canManage: true })
    for (const key of ['mailboxes', 'quota', 'folders']) expect(html).toContain(`data-whm-mailbox-maintenance-rows="${key}"`)
    for (const operation of ['quota-recalc', 'resync', 'index']) expect(html).toMatch(new RegExp(`data-whm-mailbox-maintenance-run="${operation}" disabled`))
    expect(html).toContain('data-whm-mailbox-maintenance-search')
    expect(html).toContain('href="/whm/jobs?lang=en"')
    expect(html).toContain('Repairing maildir ownership or permissions is not available here.')
    expect(html).toContain('available only when Dovecot full text search is configured')
    expect(html).toContain('Nothing has been read yet.')
    expect(html).toContain('dir="ltr"')
    expect(html).not.toContain('<form')
    expect(html).not.toContain('Changes require root authorization.')
    expect(html).toMatch(/@media\(min-width:601px\)\{\.xp-whm-mailbox-maintenance__card\{padding:24px\}\}/)
    for (const gap of ['gap:8px', 'gap:16px', 'gap:24px', 'gap:32px']) expect(html).toContain(gap)
  })
  it('renders Arabic RTL copy with ASCII digits and technical values isolated left-to-right', () => {
    const html = renderWhmMailboxMaintenanceWorkspace({ locale: 'ar', canRead: true, canManage: true })
    expect(html).toContain('dir="rtl"'); expect(html).toContain('lang="ar"')
    expect(html).toContain('<bdi dir="ltr" data-whm-mailbox-maintenance-fact="observed-at">غير مقروء</bdi>')
    expect(html).toContain('لم يُقرأ شيء بعد.')
    expect(html).toContain('32')
    expect(html).toContain('dir="ltr" maxlength="254"')
    expect(html).not.toMatch(/[٠-٩۰-۹]/)
    expect(html).not.toMatch(/Nothing has been read yet|Refresh<|Mailbox usage/)
  })
  it('keeps the layout inert without root read authority: every control disabled and no form', () => {
    for (const locale of ['en', 'ar'] as const) {
      const html = renderWhmMailboxMaintenanceWorkspace({ locale, canRead: false, canManage: true })
      expect(html).toContain('data-mailbox-maintenance-can-read="false"')
      expect(html).toContain('data-mailbox-maintenance-can-manage="false"')
      expect(html).toContain('data-state="unavailable"')
      expect(html).not.toContain('<form')
      const found = controls(html)
      expect(found.length).toBeGreaterThan(0)
      for (const control of found) expect(control).toMatch(/\sdisabled[\s>]/)
    }
    expect(renderWhmMailboxMaintenanceWorkspace({ locale: 'en', canRead: true, canManage: false })).toContain('Changes require root authorization.')
  })
})
