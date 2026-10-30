import { describe, expect, it } from 'vitest'
import { parseMarkup } from '../../../../markup.ts'
import { V2_SECURITY_SLOT } from '../../../surfaces/slots.ts'
import { WHM_MONITORING_ROUTES, renderV2WhmMonitoringPage } from './index.ts'
import { WHM_SECURITY_ROUTES, renderV2WhmSecurityPage } from '../security/index.ts'
import { WHM_ACTIVITY_ROUTES, renderV2WhmActivityPage } from '../activity/index.ts'
import { WHM_OBSERVATION_CSS, type WhmObservationInput } from './common.ts'

const admitted: WhmObservationInput = { observationAuthority: { canRead: true, canManage: true } }
const render = (route: string, props: WhmObservationInput = admitted): string => {
  const input = { ...props, activeRoute: route }
  const html = renderV2WhmMonitoringPage(input) ?? renderV2WhmSecurityPage(input) ?? renderV2WhmActivityPage(input)
  if (!html) throw new Error(`No diagnostic body for ${route}`)
  return html
}
const routes = [...WHM_MONITORING_ROUTES, ...WHM_SECURITY_ROUTES, ...WHM_ACTIVITY_ROUTES]
const nodes = (route: string, props?: WhmObservationInput) => parseMarkup(render(route, props))
const one = (route: string, hook: string, props?: WhmObservationInput) => {
  const result = nodes(route, props).find(node => node.attrs.has(hook))
  if (!result) throw new Error(`Missing ${hook}`)
  return result
}

describe('v2 WHM diagnostic, security and activity bodies', () => {
  it('dispatches the 24 distinct documents without claiming other documents', () => {
    expect(new Set(routes).size).toBe(24)
    for (const route of routes) {
      const html = render(route)
      expect(html).toContain(`data-whm-detail-route="${route}"`)
      expect(html.match(/<h1\b/g)).toHaveLength(1)
      expect(html).not.toMatch(/class="[^"\n]*\bxp-|<style\b|<script\b/)
    }
    expect(renderV2WhmMonitoringPage({ activeRoute: '/whm/accounts' })).toBeUndefined()
    expect(renderV2WhmSecurityPage({ activeRoute: '/whm/security/firewall' })).toBeUndefined()
    expect(renderV2WhmActivityPage({ activeRoute: '/whm' })).toBeUndefined()
  })

  it('defaults read and mutation admission to unavailable while retaining all page controls', () => {
    for (const route of routes) {
      const html = render(route, {})
      expect(html).toContain('data-capability-state="unavailable"')
      const controls = parseMarkup(html).filter(node => node.template < 0 && ['input', 'select', 'textarea', 'button'].includes(node.tag) && node.attrs.get('type') !== 'hidden')
      expect(controls.every(node => node.attrs.has('disabled')), route).toBe(true)
      expect(html).not.toMatch(/data-(?:monitoring-can-(?:read|signal)|repair-can-(?:read|repair)|security-tools-can-(?:read|manage)|sec-can-(?:read|manage)|jobs-can-read|support-can-read)="true"/)
    }
  })

  it('keeps a failed host capability stronger than supplied management authority', () => {
    for (const route of routes) {
      const html = render(route, { ...admitted, capabilityUnavailable: true })
      expect(html).toContain('data-capability-state="unavailable"')
      expect(parseMarkup(html).filter(node => node.template < 0 && ['input', 'select', 'textarea', 'button'].includes(node.tag) && node.attrs.get('type') !== 'hidden').every(node => node.attrs.has('disabled')), route).toBe(true)
    }
  })

  it('separates process reads from process signals and keeps restricted process identity copy', () => {
    const html = render('/whm/monitoring/processes', { observationAuthority: { canRead: true, canManage: false } })
    expect(html).toContain('data-monitoring-can-read="true"')
    expect(html).toContain('data-monitoring-can-signal="false"')
    expect(html).toContain('Command arguments are not read')
    expect(one('/whm/monitoring/processes', 'data-whm-monitoring-refresh').attrs.has('disabled')).toBe(false)
    expect(html).toContain('colspan="10"')
  })

  it('does not turn unread history, quotas or network counters into zero measurements', () => {
    const performance = render('/whm/monitoring/performance')
    expect(performance).toContain('Intervals without a sample are gaps, not zero.')
    const outline = parseMarkup(performance)
    const inChart = (index: number): boolean => {
      for (let parent = outline[index]!.parent; parent >= 0; parent = outline[parent]!.parent) if (outline[parent]!.attrs.has('data-whm-monitoring-chart')) return true
      return false
    }
    expect(outline.filter((node, index) => node.namespace === 'svg' && inChart(index))).toHaveLength(0)
    expect(performance.match(/data-whm-monitoring-chart=/g)).toHaveLength(5)
    expect(render('/whm/monitoring/disk')).toContain('Without enabled quotas, per-account usage stays unavailable')
    expect(render('/whm/monitoring/traffic')).toContain('No missing sample is displayed as zero.')
    expect(render('/whm/monitoring/io')).toContain('Account IO history is not recorded.')
  })

  it('requires the reviewed host log unit list and bounds before enabling a read', () => {
    expect(one('/whm/monitoring/logs', 'data-whm-monitoring-refresh').attrs.has('disabled')).toBe(true)
    const props = { ...admitted, monitoringLogUnits: ['nginx.service', 'xpanel-api.service'], monitoringLogDefaultLines: 100, monitoringLogMaxLines: 500 }
    const html = render('/whm/monitoring/logs', props)
    expect(one('/whm/monitoring/logs', 'data-whm-monitoring-refresh', props).attrs.has('disabled')).toBe(false)
    expect(html).toContain('value="nginx.service"')
    expect(html).toContain('max="500"')
    expect(html).toContain('value="100"')
    expect(one('/whm/monitoring/logs', 'data-whm-monitoring-refresh', { ...props, monitoringLogMaxLines: 501 }).attrs.has('disabled')).toBe(true)
  })

  it('preserves alert delivery, actual evaluation side effects and all 10 rule rows', () => {
    const html = render('/whm/monitoring/alerts')
    expect(html).toContain('data-whm-alerts-log')
    expect(html).toContain('delivers like a scheduled check')
    expect(html.match(/data-whm-alerts-rule=/g)).toHaveLength(10)
    expect(one('/whm/monitoring/alerts', 'data-whm-alerts-save').attrs.has('disabled')).toBe(true)
    const readOnly = { observationAuthority: { canRead: true, canManage: false } }
    expect(one('/whm/monitoring/alerts', 'data-whm-alerts-evaluate', readOnly).attrs.has('disabled')).toBe(true)
  })

  it('keeps repair preview and job outcome hidden and start disabled until real review', () => {
    expect(one('/whm/monitoring/repair', 'data-whm-repair-preview').attrs.has('hidden')).toBe(true)
    expect(one('/whm/monitoring/repair', 'data-whm-repair-job').attrs.has('hidden')).toBe(true)
    expect(one('/whm/monitoring/repair', 'data-whm-repair-start').attrs.has('disabled')).toBe(true)
    expect(render('/whm/monitoring/repair')).toContain('Nothing changes until you preview and start a reviewed repair.')
  })

  it('keeps benchmark confirmation, bounds, cleanup and explicit start separate', () => {
    expect(one('/whm/monitoring/benchmark', 'data-benchmark-confirm').attrs.get('pattern')).toBe('RUN')
    expect(one('/whm/monitoring/benchmark', 'data-benchmark-start').attrs.has('disabled')).toBe(true)
    expect(render('/whm/monitoring/benchmark')).toContain('No benchmark starts automatically.')
    expect(render('/whm/monitoring/benchmark')).toContain('retained temporary file blocks the next run')
  })

  it('preserves WAF and panel access readback boundaries and lockout safeguards', () => {
    expect(render('/whm/security/waf')).toContain('a bad pattern keeps the previous generation')
    expect(render('/whm/security/flood')).toContain('SSH and the panel ports keep their own sign-in protection.')
    const html = render('/whm/security/panel-access')
    for (const listener of ['xpanel', 'xwhm', 'xmail']) expect(html).toContain(`data-sec-input="${listener}"`)
    expect(html).toContain('A save that removes your current address is refused.')
    expect(one('/whm/security/panel-access', 'data-sec-action').attrs.has('disabled')).toBe(false)
  })

  it('retains protected root SSH keys and does not invent editable password policy', () => {
    const html = render('/whm/security/ssh', { ...admitted, serverSettings: { sshPort: 22 } as WhmObservationInput['serverSettings'] })
    expect(html).toContain('Existing and fleet keys are protected.')
    expect(html).toContain('Password policy and root-login changes have not been connected.')
    expect(html).toContain('name="sshPort"')
    expect(html).toContain('value="22"')
    expect(one('/whm/security/ssh', 'data-whm-ssh-add').attrs.has('disabled')).toBe(true)
  })

  it('inserts only the core-owned security slot on sign-in without forcing enrollment', () => {
    const html = render('/whm/security/sign-in')
    expect(html.split(V2_SECURITY_SLOT)).toHaveLength(2)
    expect(html).toContain('Enrollment is optional.')
    expect(html).not.toContain('name="totp"')
    expect(render('/whm/security')).toContain('Global function policy and per-account exceptions have not been read.')
  })

  it('does not expose denied audit rows, raw secrets or internal references in exports', () => {
    const opaque = '11111111-1111-4111-8111-111111111111'
    const props = { ...admitted, auditEntries: [{ id: opaque, at: '2026-10-29T12:00:00.000Z', actor: opaque, action: 'auth.login', target: `account:${opaque}`, outcome: 'ok', detail: { password: 'fixture-private-value' } }] as WhmObservationInput['auditEntries'] }
    const html = render('/whm/audit', props)
    expect(html).not.toContain('fixture-private-value')
    const visible = html.replace(/<[^>]*>/g, '')
    expect(visible).not.toContain(opaque)
    const denied = render('/whm/audit', { ...props, observationAuthority: { canRead: false, canManage: false } })
    expect(denied).not.toContain(opaque)
    expect(denied).not.toContain('data-audit-export')
    expect(html).toContain('data-audit-export')
  })

  it('preserves text filters ending in Z while normalizing only UTC date inputs', () => {
    const items = nodes('/whm/audit', { ...admitted, auditList: { actor: 'OperatorZ', action: 'ActionZ', target: 'siteZ', before: '', hasMore: false, oldestId: '', from: '2026-10-29T12:00:00.000Z', to: '2026-10-29T13:00:00.000Z' } })
    const value = (name: string) => items.find(node => node.attrs.get('name') === name)?.attrs.get('value')
    expect(value('actor')).toBe('OperatorZ')
    expect(value('action')).toBe('ActionZ')
    expect(value('target')).toBe('siteZ')
    expect(value('from')).toBe('2026-10-29T12:00:00.000')
    expect(value('to')).toBe('2026-10-29T13:00:00.000')
  })

  it('retains job detail and support manifest confirmation without inventing completion', () => {
    const jobs = render('/whm/jobs')
    for (const hook of ['data-whm-jobs-steps', 'data-whm-jobs-verification-detail', 'data-whm-jobs-log', 'data-whm-jobs-outcome', 'data-whm-jobs-field="reference"']) expect(jobs).toContain(hook)
    expect(jobs).toContain('No job status or completion is assumed.')
    const support = render('/whm/support')
    expect(support).toContain('Nothing is sent anywhere')
    expect(one('/whm/support', 'data-whm-support-download').attrs.has('disabled')).toBe(true)
    expect(one('/whm/support', 'data-whm-support-confirm').attrs.has('disabled')).toBe(true)
  })

  it('keeps RTL field and table alignment local to the diagnostic bodies', () => {
    expect(WHM_OBSERVATION_CSS).toContain('gap:32px')
    expect(WHM_OBSERVATION_CSS).toContain('gap:24px')
    expect(WHM_OBSERVATION_CSS).toContain('gap:16px')
    expect(WHM_OBSERVATION_CSS).toContain('gap:8px')
    expect(WHM_OBSERVATION_CSS).toContain('text-align:var(--v2-control-align,start)')
    expect(WHM_OBSERVATION_CSS).not.toMatch(/text-align\s*:\s*(?:left|right)|var\(--xp-/)
    for (const route of routes) {
      const html = render(route, { ...admitted, locale: 'ar' })
      expect(html).toContain('lang="ar" dir="rtl"')
      expect(html).not.toMatch(/[٠-٩۰-۹]/)
    }
  })
})
