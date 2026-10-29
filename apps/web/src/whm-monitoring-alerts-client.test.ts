// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { renderWhmMonitoringAlertsWorkspace } from './board-port/whm-monitoring-alerts-workspace.ts'
import { readMonitoringAlertsView, WHM_MONITORING_ALERTS_CLIENT_BINDING } from './whm-monitoring-alerts-client.ts'

const IDS = ['load', 'memory', 'swap', 'disk-space', 'disk-inodes', 'services', 'drift', 'certificates', 'reboot', 'bandwidth']
const pct = (min: number, max: number, value: number, direction = 'above') => ({ unit: 'percent', direction, min, max, decimals: 0, default: value })
const BOUNDS: Record<string, Record<string, unknown> | null> = {
  load: { unit: 'per-processor', direction: 'above', min: 0.5, max: 10, decimals: 1, default: 1 }, memory: pct(1, 50, 15, 'below'), swap: pct(10, 99, 50),
  'disk-space': pct(50, 99, 85), 'disk-inodes': pct(50, 99, 85), services: null, drift: null, certificates: { unit: 'days', direction: 'below', min: 1, max: 14, decimals: 0, default: 14 }, reboot: null, bandwidth: pct(50, 100, 80),
}
const DEFAULTS = IDS.map(id => ({ id, enabled: true, threshold: (BOUNDS[id]?.default as number | undefined) ?? null }))
const R1 = 'a'.repeat(64), R2 = 'b'.repeat(64)
const EVALUATED = '2026-10-27T12:05:00.000Z', FIRED = '2026-10-27T10:00:00.000Z'
const DELIVERY = { scheduler: { everyMinutes: 5, lastRun: null }, state: 'none', channels: { alerts: true, email: 2, webhook: true, active: ['email', 'webhook'] }, pending: [], log: [] }
const NOTICE = 'aln_' + 'c'.repeat(24)
const LOG = [
  { at: EVALUATED, noticeId: NOTICE, kind: 'firing', ruleId: 'disk-space', channel: 'webhook', result: 'failed', attempt: 1, error: 'rejected_status', status: 503 },
  { at: EVALUATED, noticeId: NOTICE, kind: 'firing', ruleId: 'disk-space', channel: 'email', result: 'sent', attempt: 1, error: null, status: null },
]
const view = (overrides: Record<string, unknown> = {}) => ({ state: 'default', rules: DEFAULTS, quiet: null, updatedAt: null, updatedBy: null, revision: R1, bounds: BOUNDS,
  delivery: DELIVERY, evaluationState: 'none', evaluation: null, ...overrides })
const result = (id: string, overrides: Record<string, unknown> = {}) => ({ id, enabled: true, threshold: DEFAULTS.find(rule => rule.id === id)!.threshold, state: 'ok', severity: null, health: 'ok', value: null, matches: [], evidence: 'evidence for ' + id, firstFiredAt: null, ...overrides })
const evaluation = (patch: Record<string, Record<string, unknown>> = {}, overrides: Record<string, unknown> = {}) => ({ evaluatedAt: EVALUATED, observedAt: '2026-10-27T12:04:59.000Z', host: 'read', rulesRevision: R1, quiet: false, results: IDS.map(id => result(id, patch[id])), ...overrides })
const evaluated = (patch: Record<string, Record<string, unknown>> = {}, overrides: Record<string, unknown> = {}, delivery: Record<string, unknown> = {}) => view({ evaluationState: 'read', evaluation: evaluation(patch, overrides), delivery: { ...DELIVERY, ...delivery } })
const FIRING = { 'disk-space': { state: 'firing', severity: 'critical', health: 'problem', value: 96, matches: ['/'], firstFiredAt: FIRED }, load: { state: 'unavailable', health: 'warning' }, reboot: { state: 'disabled', enabled: false } }
type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const boot = (send?: Send, locale: 'en' | 'ar' = 'en', canManage = true) => {
  document.body.innerHTML = renderWhmMonitoringAlertsWorkspace({ locale, canManage })
  if (send) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
  document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
  new Function('return ' + WHM_MONITORING_ALERTS_CLIENT_BINDING)()()
}
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const row = (id: string) => $(`[data-whm-alerts-rule="${id}"]`)
const threshold = (id: string) => row(id).querySelector<HTMLInputElement>('[data-whm-alerts-threshold]')!
const enabled = (id: string) => row(id).querySelector<HTMLInputElement>('[data-whm-alerts-enabled]')!
const submit = () => $<HTMLFormElement>('[data-whm-alerts-form]').dispatchEvent(new Event('submit', { cancelable: true }))
const puts = (send: Mock<Send>) => send.mock.calls.filter(([method]) => method === 'PUT')

beforeEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })
afterEach(() => { document.body.innerHTML = ''; document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr' })

describe('WHM monitoring alerts client parser', () => {
  it('accepts consistent views and a delivery log of known results only', () => {
    expect(readMonitoringAlertsView(view()).rules).toHaveLength(10)
    expect(readMonitoringAlertsView(evaluated(FIRING)).evaluation!.results[3]).toMatchObject({ state: 'firing', severity: 'critical', firstFiredAt: FIRED })
    expect(readMonitoringAlertsView(evaluated(FIRING, {}, { log: LOG })).delivery.log[0]).toMatchObject({ channel: 'webhook', error: 'rejected_status', status: 503 })
    for (const bad of [
      view({ delivery: { notifications: 'not_sent', scheduler: 'none' } }), view({ delivery: { ...DELIVERY, scheduler: { everyMinutes: 0, lastRun: null } } }),
      view({ delivery: { ...DELIVERY, log: [{ ...LOG[0], result: 'delivered' }] } }), view({ delivery: { ...DELIVERY, log: [{ ...LOG[0], ruleId: 'nope' }] } }),
      view({ delivery: { ...DELIVERY, log: [{ ...LOG[0], kind: 'test' }] } }), view({ delivery: { ...DELIVERY, channels: { ...DELIVERY.channels, active: ['sms'] } } }),
      view({ rules: DEFAULTS.map(rule => rule.id === 'disk-space' ? { ...rule, threshold: 100 } : rule) }), view({ rules: DEFAULTS.map(rule => rule.id === 'services' ? { ...rule, threshold: 1 } : rule) }),
      view({ rules: [...DEFAULTS].reverse() }), view({ state: 'saved' }), view({ evaluationState: 'read' }), view({ quiet: { start: '22:00', end: '22:00' } }), view({ revision: 'x' }),
      evaluated({ 'disk-space': { state: 'firing', severity: 'critical', health: 'problem' } }), evaluated({ 'disk-space': { state: 'firing', severity: 'warning', health: 'problem', firstFiredAt: FIRED } }),
      evaluated({ 'disk-space': { state: 'ok', severity: 'warning' } }), evaluated({ reboot: { state: 'disabled' } }), evaluated({ load: { state: 'firing', severity: 'warning', health: 'warning', firstFiredAt: '2026-10-28T00:00:00.000Z' } }),
      evaluated({ drift: { evidence: 'a\u202eb' } }), evaluated({}, { results: [] }),
    ]) expect(() => readMonitoringAlertsView(bad), JSON.stringify(bad).slice(0, 160)).toThrow()
  })
})

describe('WHM monitoring alerts client binding', () => {
  it('sends nothing without admission and keeps every control disabled', async () => {
    const send = vi.fn<Send>()
    boot(send, 'en', false)
    await flush()
    expect(send).not.toHaveBeenCalled()
    expect($('[data-whm-alerts-status]').dataset.state).toBe('unavailable')
    expect($('[data-whm-alerts-eval-status]').dataset.state).toBe('unavailable')
    expect([...document.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button')].every(control => control.disabled)).toBe(true)
    expect(WHM_MONITORING_ALERTS_CLIENT_BINDING).not.toContain('innerHTML')
    expect(WHM_MONITORING_ALERTS_CLIENT_BINDING).not.toContain('fetch(')
  })

  it('reads rules with their bounds, evaluates on demand and shows severity and firing-since', async () => {
    const send: Mock<Send> = vi.fn<Send>(async method => method === 'GET' ? view() : evaluated(FIRING, {}, { state: 'read', log: LOG, scheduler: { everyMinutes: 5, lastRun: { at: EVALUATED, result: 'evaluated' } } }))
    boot(send)
    await flush()
    expect(send).toHaveBeenCalledWith('GET', '/api/server/monitoring-alerts')
    expect([threshold('disk-space').value, threshold('disk-space').min, threshold('disk-space').max, threshold('load').step]).toEqual(['85', '50', '99', '0.1'])
    expect(row('disk-space').querySelector('[data-whm-alerts-range]')!.textContent).toBe('Fires at or above 85 % used. Allowed: 50 - 99. Default: 85.')
    expect($('[data-whm-alerts-eval-status]').textContent).toBe('No evaluation has been recorded yet. The schedule evaluates the rules, or select Evaluate now.')
    expect($('[data-whm-alerts-fact="notifications"]').textContent).toBe('Sent by email to 2 recipients and to the webhook.')
    expect($('[data-whm-alerts-fact="scheduler"]').textContent).toBe('Every 5 minutes. No scheduled check has run yet.')
    expect($('[data-whm-alerts-log]').textContent).toBe('No message has been sent or attempted.')
    $<HTMLButtonElement>('[data-whm-alerts-evaluate]').click(); await flush()
    expect(send).toHaveBeenLastCalledWith('POST', '/api/server/monitoring-alerts/evaluate')
    const disk = $('[data-whm-alerts-result="disk-space"]')
    expect(disk.dataset.severity).toBe('critical')
    expect(disk.querySelector('.xp-badge--critical')!.textContent).toBe('Critical')
    expect(disk.textContent).toContain('Measured: 96 % used. Fires at or above 85 % used.')
    expect(disk.textContent).toContain('Firing since 2026-10-27 10:00 UTC, for 2 h 5 min as of the last evaluation.')
    expect(disk.textContent).toContain('Affected: /')
    expect($('[data-whm-alerts-result="load"]').textContent).toContain('The value could not be read from the health observation')
    expect($('[data-whm-alerts-result="reboot"]').textContent).toContain('This rule is disabled')
    expect($('[data-whm-alerts-fact="firing"]').textContent).toBe('1')
    expect($('[data-whm-alerts-eval-status]').textContent).toBe('One alert is firing.')
    expect(disk.textContent).toContain('Last message (Firing) 2026-10-27 12:05 UTC: Webhook: Not sent: the receiver answered with status 503; retrying; Email: Sent.')
    expect($('[data-whm-alerts-result="memory"]').textContent).toContain('No message has been sent for this alert.')
    expect($('[data-whm-alerts-fact="scheduler"]').textContent).toBe('Every 5 minutes. Last check 2026-10-27 12:05 UTC: evaluated.')
    const rows = [...document.querySelectorAll('[data-whm-alerts-log] tr')].map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent))
    expect(rows).toEqual([['2026-10-27 12:05 UTC', 'Disk space per filesystem', 'Firing', 'Webhook', 'Not sent: the receiver answered with status 503; retrying'],
      ['2026-10-27 12:05 UTC', 'Disk space per filesystem', 'Firing', 'Email', 'Sent']])
  })

  it('says why nothing is sent when alerts have no channel, and marks a quiet evaluation', async () => {
    boot(vi.fn<Send>(async () => evaluated(FIRING, { quiet: true }, { channels: { alerts: false, email: 1, webhook: false, active: [] } })))
    await flush()
    expect($('[data-whm-alerts-fact="notifications"]').textContent).toBe('Not sent. Monitoring alerts are not selected on the notifications page.')
    expect($('[data-whm-alerts-eval-status]').textContent).toBe('One alert is firing. The quiet window was active, so nothing was sent.')
  })

  it('validates thresholds and the quiet window locally, then saves under the observed revision', async () => {
    const saved = view({ state: 'saved', revision: R2, updatedAt: EVALUATED, updatedBy: 'root', quiet: { start: '22:00', end: '06:00' }, rules: DEFAULTS.map(rule => rule.id === 'disk-space' ? { ...rule, threshold: 90 } : rule) })
    const send: Mock<Send> = vi.fn<Send>(async method => method === 'GET' ? view() : saved)
    boot(send)
    await flush()
    threshold('disk-space').value = '100'
    submit(); await flush()
    expect(threshold('disk-space').getAttribute('aria-invalid')).toBe('true')
    expect(puts(send)).toHaveLength(0)
    threshold('disk-space').value = '90'
    const quiet = $<HTMLInputElement>('[data-whm-alerts-quiet]')
    quiet.checked = true; quiet.dispatchEvent(new Event('change'))
    expect($<HTMLInputElement>('[data-whm-alerts-quiet-start]').disabled).toBe(false)
    $<HTMLInputElement>('[data-whm-alerts-quiet-start]').value = '22:00'; $<HTMLInputElement>('[data-whm-alerts-quiet-end]').value = '22:00'
    submit(); await flush()
    expect(puts(send)).toHaveLength(0)
    $<HTMLInputElement>('[data-whm-alerts-quiet-end]').value = '06:00'
    enabled('reboot').checked = false
    submit(); await flush()
    expect(puts(send)).toEqual([['PUT', '/api/server/monitoring-alerts', { rules: DEFAULTS.map(rule => rule.id === 'disk-space' ? { ...rule, threshold: 90 } : rule.id === 'reboot' ? { ...rule, enabled: false } : rule), quiet: { start: '22:00', end: '06:00' }, expectedRevision: R1 }]])
    expect($('[data-whm-alerts-save-status]').textContent).toBe('Rules saved. They apply from the next evaluation.')
    expect(threshold('disk-space').value).toBe('90')
    expect($('[data-whm-alerts-fact="updated"]').textContent).toBe('2026-10-27 12:05 UTC')
  })

  it('explains conflicts and unavailable evaluation, and reports an invalid rules file in Arabic', async () => {
    const send: Mock<Send> = vi.fn<Send>(async method => { if (method === 'GET') return view(); throw Object.assign(new Error('refused'), { status: method === 'PUT' ? 409 : 412 }) })
    boot(send)
    await flush()
    submit(); await flush()
    expect($('[data-whm-alerts-save-status]').textContent).toBe('The rules changed since they were read. Reload them before saving.')
    $<HTMLButtonElement>('[data-whm-alerts-evaluate]').click(); await flush()
    expect($('[data-whm-alerts-eval-status]').textContent).toContain('Evaluation is unavailable')
    boot(vi.fn<Send>(async () => view({ state: 'invalid' })), 'ar')
    await flush()
    expect($('[data-whm-alerts-status]').textContent).toBe('تعذّر التحقق من ملف القواعد المحفوظ، لذا تُعرض القيم الافتراضية والتقييم غير متاح. الحفظ هنا يستبدله.')
    expect($<HTMLButtonElement>('[data-whm-alerts-evaluate]').disabled).toBe(true)
    boot(vi.fn<Send>(async () => ({ state: 'saved' })))
    await flush()
    expect($('[data-whm-alerts-status]').dataset.state).toBe('failed')
    expect($<HTMLButtonElement>('[data-whm-alerts-save]').disabled).toBe(true)
  })
})

describe('WHM monitoring alerts full timestamp display', () => {
  it.each(['en', 'ar'] as const)('preserves complete saved, evaluated, observed and firing instants in %s', async locale => {
    const updatedAt = '2026-10-27T12:01:02.345Z', evaluatedAt = '2026-10-27T12:05:09.876Z'
    const observedAt = '2026-10-27T12:04:58.765Z', firstFiredAt = '2026-10-27T10:00:03.210Z'
    const payload = { ...evaluated({ ...FIRING, 'disk-space': { ...FIRING['disk-space'], firstFiredAt } }, { evaluatedAt, observedAt }), state: 'saved', updatedAt, updatedBy: 'root' }
    const canonicalPayload = JSON.stringify(payload)
    const send = vi.fn<Send>(async () => payload)
    boot(send, locale); await flush()
    expect($('[data-whm-alerts-status]').dataset.state).toBe('read')
    for (const [field, expected] of [['updated', '2026-10-27 12:01 UTC'], ['evaluated-at', '2026-10-27 12:05 UTC'], ['observed-at', '2026-10-27 12:04 UTC']] as const) {
      const stamp = $(`[data-whm-alerts-fact="${field}"] bdi`)
      expect(stamp.textContent).toBe(expected)
      expect(stamp.getAttribute('dir')).toBe('ltr')
    }
    const firing = [...document.querySelectorAll('[data-whm-alerts-result="disk-space"] bdi')].find(node => node.textContent === '2026-10-27 10:00 UTC')
    expect(firing).toBeDefined()
    expect(firing!.getAttribute('dir')).toBe('ltr')
    expect(row('disk-space').querySelector('[data-whm-alerts-range]')!.textContent).toContain(locale === 'ar' ? 'المسموح: 50 - 99. الافتراضي: 85.' : 'Allowed: 50 - 99. Default: 85.')
    expect($('[data-whm-alerts-result="disk-space"]').textContent).toContain(locale === 'ar' ? 'المتأثر: /' : 'Affected: /')
    expect($('[data-whm-alerts-result="disk-space"]').textContent).toContain(locale === 'ar' ? 'لمدة ساعتين و5 دقائق' : 'for 2 h 5 min')
    expect(JSON.stringify(payload)).toBe(canonicalPayload)
    expect(send.mock.calls.map(([method]) => method)).toEqual(['GET'])
    expect(document.body.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
})
