import { describe, expect, it } from 'vitest'
import { MONITORING_ALERT_ROWS, renderWhmMonitoringAlertsWorkspace } from './whm-monitoring-alerts-workspace.ts'
import { parseMarkup } from '../themes/markup.ts'

const liveElements = (html: string) => parseMarkup(html).filter(node => node.namespace === 'html' && node.template === -1)
const controls = (html: string) => liveElements(html).filter(node => ['button', 'input', 'select', 'fieldset'].includes(node.tag))


describe('WHM monitoring alerts renderer', () => {
  it.each(['en', 'ar'] as const)('renders %s with logical direction, ASCII digits and every rule row', locale => {
    const html = renderWhmMonitoringAlertsWorkspace({ locale, canManage: true })
    expect(html).toContain(locale === 'ar' ? 'lang="ar" dir="rtl"' : 'lang="en" dir="ltr"')
    if (locale === 'ar') expect(html).toMatch(/[؀-ۿ]/)
    expect(html).not.toMatch(/[٠-٩۰-۹]/)
    expect(html).not.toMatch(/\b(?:margin|padding)-(?:left|right)\b|\b(?:left|right):/)
    expect(html).toContain('data-alerts-can-manage="true"')
    expect(liveElements(html).some(node => node.tag === 'form')).toBe(true)
    expect(controls(html).length).toBeGreaterThan(9)
    expect(controls(html).every(node => !node.attrs.has('disabled'))).toBe(true)
    expect(parseMarkup(html).some(node => node.namespace === 'html' && node.tag === 'template')).toBe(true)
    for (const row of MONITORING_ALERT_ROWS) expect(html).toContain(`data-whm-alerts-rule="${row.id}"`)
    expect(html.match(/data-whm-alerts-threshold/g)).toHaveLength(MONITORING_ALERT_ROWS.filter(row => row.unit).length)
    expect(html).toContain('<input id="whm-alerts-quiet-start" type="time" dir="ltr"')
  })

  it('explains delivery, leaves its facts unread until the API answers, and links the notification settings', () => {
    const en = renderWhmMonitoringAlertsWorkspace({ locale: 'en', canManage: true }), ar = renderWhmMonitoringAlertsWorkspace({ locale: 'ar', canManage: true })
    expect(en).toContain('A firing alert is sent once when it starts and once when it clears')
    for (const key of ['notifications', 'scheduler', 'pending']) expect(en).toContain(`<dd data-whm-alerts-fact="${key}">Not read</dd>`)
    expect(en).toContain('<tbody data-whm-alerts-log><tr><td colspan="5" class="xp-help">No delivery has been read.</td></tr></tbody>')
    expect(ar).not.toContain('No delivery has been read.')
    for (const html of [en, ar]) for (const href of ['/whm/panel/notifications', '/whm/monitoring/health']) expect(html).toContain(`href="${href}"`)
    expect(en).toContain('data-whm-alerts-evaluate')
  })

  it('keeps the full layout in unavailable mode with no form and every control disabled', () => {
    const html = renderWhmMonitoringAlertsWorkspace({ locale: 'en', canManage: false })
    expect(liveElements(html).some(node => node.tag === 'form')).toBe(false)
    expect(html).toContain('data-alerts-can-manage="false"')
    expect(html.match(/data-state="unavailable"/g)).toHaveLength(2)
    expect(html.match(/data-whm-alerts-rule=/g)).toHaveLength(10)
    const found = controls(html)
    expect(found.length).toBeGreaterThan(9)
    for (const control of found) expect(control.attrs.has('disabled')).toBe(true)
  })
})
