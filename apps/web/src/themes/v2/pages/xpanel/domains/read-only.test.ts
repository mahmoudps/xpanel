import { renderV2DnsPage } from '../services/dns.ts'
import { renderV2TlsPage } from '../services/tls.ts'
import { renderV2CronPage } from '../services/cron.ts'
import { renderV2PanelQuarantine } from '../email-tools/quarantine.ts'
import { renderV2PanelSiteHealth } from '../observations/health.ts'
import { describe, expect, it } from 'vitest'
import { domainContext } from './common.ts'
import { renderV2CloudflarePage } from './cloudflare.ts'

describe('domain unknown and stored-fact boundaries', () => {
  it('keeps the complete unknown Cloudflare layout without enabling native reads', () => {
    const html = renderV2CloudflarePage({}, { presentation: 'read-only', canRead: false, canManage: false, canReadFacts: false, authorizedTools: new Set() })
    expect(html).toContain('data-readonly="true"')
    expect(html).toContain('data-sec-can-read="false"')
    expect(html).toContain('v2-cf-zone-heading')
    expect(html).toContain('data-sec-rows="domains"')
  })
  it('does not infer observed empty domains from absent facts', () => {
    const context = domainContext({}, { canRead: false, canManage: false })
    expect(context.account).toBeUndefined()
    expect(context.domainsObserved).toBe(false)
  })
})

for (const render of [renderV2DnsPage, renderV2TlsPage, renderV2CronPage, renderV2PanelQuarantine, renderV2PanelSiteHealth]) {
  it('preserves an unknown full workspace with an explicit controller boundary: ' + render.name, () => {
    const html = render({}, { presentation: 'read-only', canRead: false, canManage: false, canReadFacts: false, authorizedTools: new Set() })
    expect(html).toContain('data-readonly="true"')
    expect(html).toContain('v2-card')
    expect(html).not.toContain('data-cron-manage="true"')
    expect(html).not.toContain('data-health-manage="true"')
  })
}
