import { describe, expect, it } from 'vitest'
import { renderWhmServiceDetailWorkspace } from './whm-service-detail-workspace.ts'

const kinds = ['dns', 'ftp', 'certificates'] as const

describe('WHM service detail workspace renderer', () => {
  it('renders each English page with its facts, table and truthful unread state', () => {
    const dns = renderWhmServiceDetailWorkspace({ kind: 'dns', locale: 'en', canRead: true, canRestart: true })
    expect(dns).toContain('data-whm-service-detail-workspace="dns"')
    expect(dns).toContain('data-service-detail-can-restart="true"')
    expect(dns).toContain('data-whm-service-detail-restart="pdns" disabled')
    for (const key of ['unit', 'state', 'control', 'version', 'zone-dir', 'rendered', 'present', 'observed-at']) expect(dns).toContain(`data-whm-service-detail-fact="${key}"`)
    for (const key of ['state', 'text']) expect(dns).toContain(`data-whm-service-detail-filter="${key}"`)
    expect(dns).toContain('pdnsutil check-zone and changes nothing')
    const ftp = renderWhmServiceDetailWorkspace({ kind: 'ftp', locale: 'en', canRead: true, canRestart: true })
    expect(ftp).toContain('data-whm-service-detail-restart="pure-ftpd" disabled')
    expect(ftp).toContain('The running process flags are not read here.')
    const certificates = renderWhmServiceDetailWorkspace({ kind: 'certificates', locale: 'en', canRead: true, canRestart: true })
    expect(certificates).not.toContain('data-whm-service-detail-restart')
    expect(certificates).toContain('data-service-detail-can-restart="false"')
    expect(certificates).toContain('href="/whm/ssl?lang=en"')
    expect(certificates).toContain('private keys are checked for presence and never opened')
    for (const kind of kinds) {
      const html = renderWhmServiceDetailWorkspace({ kind, locale: 'en', canRead: true, canRestart: true })
      expect(html).toContain('dir="ltr"')
      expect(html).toContain('This service has not been read.')
      expect(html).toContain('data-whm-service-detail-rows')
      expect(html).toMatch(/@media\(min-width:601px\)\{\.xp-whm-service-detail__card\{padding:24px\}\}/)
      expect(html).not.toContain('<form')
      expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
    }
  })
  it('renders Arabic RTL copy with technical values isolated left-to-right', () => {
    for (const kind of kinds) {
      const html = renderWhmServiceDetailWorkspace({ kind, locale: 'ar', canRead: true, canRestart: true })
      expect(html).toContain('dir="rtl"'); expect(html).toContain('lang="ar"')
      expect(html).toContain('لم تُقرأ هذه الخدمة.')
      expect(html).toContain('<bdi dir="ltr" data-whm-service-detail-fact="observed-at">')
      expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
      expect(html).not.toMatch(/This service has not been read|Refresh</)
    }
    expect(renderWhmServiceDetailWorkspace({ kind: 'dns', locale: 'ar', canRead: true, canRestart: true })).toContain('dir="ltr" maxlength="253"')
    expect(renderWhmServiceDetailWorkspace({ kind: 'certificates', locale: 'ar', canRead: true, canRestart: true })).toContain('href="/whm/ssl?lang=ar"')
  })
  it('keeps the layout inert without authorization: every control disabled and no form', () => {
    for (const kind of kinds) {
      const html = renderWhmServiceDetailWorkspace({ kind, locale: 'en', canRead: false, canRestart: true })
      expect(html).toContain('data-service-detail-can-read="false"')
      expect(html).toContain('data-service-detail-can-restart="false"')
      expect(html).toContain('data-whm-service-detail-refresh disabled')
      expect(html).not.toContain('<form')
      const controls = html.match(/<(?:input|select|textarea|button)\b[^>]*>/g) ?? []
      expect(controls.length).toBeGreaterThan(0)
      for (const control of controls) expect(control).toMatch(/\sdisabled(?:[\s>]|$)/)
      if (kind !== 'certificates') expect(html).toContain('Restarting this service requires root authorization.')
    }
  })
})
