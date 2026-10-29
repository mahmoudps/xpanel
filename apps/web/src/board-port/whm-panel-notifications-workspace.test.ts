import { describe, expect, it } from 'vitest'
import { PANEL_NOTIFICATION_EVENT_LABELS, renderWhmPanelNotificationsWorkspace } from './whm-panel-notifications-workspace.ts'

const controls = (html: string): string[] => html.match(/<(?:input|select|textarea|button)\b[^>]*>/g) ?? []

describe('WHM notifications workspace renderer', () => {
  it('renders the complete English page with the delivery channels and a test control the client enables', () => {
    const html = renderWhmPanelNotificationsWorkspace({ locale: 'en', canManage: true })
    expect(html).toContain('data-whm-detail-route="/whm/panel/notifications"')
    expect(html).toContain('data-notifications-can-manage="true"')
    expect(html).toContain('<h1>Notifications</h1>')
    expect(html).toContain('Notification settings have not been read. No recipient or event is assumed.')
    expect(html).toContain('Monitoring alerts are sent when that event is selected below. The other events are written to the audit log, but none of them sends a message yet.')
    expect(html).toContain('an HTTPS webhook signed with HMAC-SHA256')
    expect(html).toMatch(/<button type="button" class="xp-btn" data-whm-notifications-test [^>]*disabled>Send test message<\/button>/)
    expect(html).toContain('<input id="whm-notifications-webhook-url" class="xp-whm-notifications__url" type="url" dir="ltr"')
    for (const marker of ['data-whm-notifications-webhook-enabled', 'data-whm-notifications-key', 'data-whm-notifications-key-status', 'data-whm-notifications-test-status', 'data-whm-notifications-field="signingKey"']) expect(html).toContain(marker)
    expect(html).toContain('<bdi dir="ltr" class="xp-help">monitoring.alert</bdi>')
    expect(html).toMatch(/<form class="xp-whm-notifications__group" data-whm-notifications-form [^>]*novalidate>/)
    expect(html.match(/data-whm-notifications-event/g)).toHaveLength(Object.keys(PANEL_NOTIFICATION_EVENT_LABELS).length)
    expect(html).toContain('<bdi dir="ltr" class="xp-help">reconcile.failed</bdi>')
    for (const marker of ['data-whm-notifications-recipients', 'data-whm-notifications-save', 'data-whm-notifications-reload', 'data-whm-notifications-status', 'data-whm-notifications-loading', 'data-whm-notifications-field="updated"']) expect(html).toContain(marker)
  })

  it('renders Arabic RTL copy with ASCII digits only', () => {
    const html = renderWhmPanelNotificationsWorkspace({ locale: 'ar', canManage: true })
    expect(html).toContain('lang="ar" dir="rtl"')
    expect(html).toContain('<h1>الإشعارات</h1>')
    expect(html).toContain('حتى 10')
    expect(html).not.toMatch(/[٠-٩۰-۹]/)
    expect(html).not.toMatch(/>(?:Recipients|Events|Save settings|Reload|Send test message|Delivery)</)
  })

  it('keeps the full layout but renders every control disabled and no form when unavailable', () => {
    const html = renderWhmPanelNotificationsWorkspace({ locale: 'en', canManage: false })
    expect(html).toContain('data-capability-state="unavailable"')
    expect(html).not.toContain('<form')
    const all = controls(html)
    expect(all.length).toBeGreaterThan(10)
    for (const control of all) expect(control, control).toMatch(/\sdisabled(?:[\s>]|$)/)
    expect(html).not.toContain('type="submit"')
  })
})
