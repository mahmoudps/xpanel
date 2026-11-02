import { renderV2DnsPage } from '../services/dns.ts'
import { renderV2TlsPage } from '../services/tls.ts'
import { renderV2CronPage } from '../services/cron.ts'
import { renderV2PanelQuarantine } from '../email-tools/quarantine.ts'
import { renderV2PanelSiteHealth } from '../observations/health.ts'
import { describe, expect, it } from 'vitest'
import type { PanelSurfaceProps } from '../../../../contract.ts'
import { parseMarkup } from '../../../../markup.ts'
import type { PanelServiceAuthority } from '../services/common.ts'
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


interface AccountServiceCase {
  kind: string
  render: (props: PanelSurfaceProps, authority?: PanelServiceAuthority) => string
}
const accountServices: readonly AccountServiceCase[] = [
  { kind: 'dns', render: renderV2DnsPage },
  { kind: 'tls', render: renderV2TlsPage },
  { kind: 'cron', render: renderV2CronPage },
]
const closedServiceAuthority: PanelServiceAuthority = { presentation: 'read-only', canRead: false, canManage: false, canReadFacts: false, authorizedTools: new Set() }
function assertUnknownServiceClosed(html: string, kind: string): void {
  const nodes = parseMarkup(html)
  const roots = nodes.filter(node => node.template < 0 && node.attrs.get('data-v2-panel-service') === kind)
  expect(roots).toHaveLength(1)
  expect(roots[0]?.attrs.get('data-readonly')).toBe('true')
  expect(nodes.some(node => node.template < 0 && node.tag === 'form')).toBe(false)
  nodes.forEach((node, index) => {
    if (node.template >= 0) return
    if (node.attrs.has('data-cron-manage')) expect(node.attrs.get('data-cron-manage')).toBe('false')
    if (node.attrs.has('data-ssl-can-manage')) expect(node.attrs.get('data-ssl-can-manage')).toBe('false')
    if (!['input', 'select', 'textarea', 'button'].includes(node.tag)) return
    let closed = node.attrs.has('disabled')
    for (let at = index; at >= 0; at = nodes[at]?.parent ?? -1) {
      const ancestor = nodes[at]
      if (!ancestor) throw new Error('Broken native control ancestry')
      closed ||= ancestor.tag === 'fieldset' && ancestor.attrs.has('disabled')
    }
    expect(closed, kind + ':' + node.tag).toBe(true)
  })
}

describe('account-service presentation is independent from missing live account authority', () => {
  const liveModes: readonly { name: string; authority?: PanelServiceAuthority }[] = [
    { name: 'default' }, { name: 'explicit live', authority: { presentation: 'live', canRead: true, canManage: true } },
  ]
  for (const service of accountServices) {
    it.each(liveModes)(service.kind + ' retains the missing-account guard for $name rendering', { tags: ['feature'] }, mode => {
      const html = service.render({}, mode.authority)
      const nodes = parseMarkup(html)
      expect(nodes.some(node => node.template < 0 && node.attrs.has('data-v2-panel-service'))).toBe(false)
      expect(nodes.some(node => node.template < 0 && ['input', 'select', 'textarea', 'button', 'form'].includes(node.tag))).toBe(false)
      expect(html).toContain('An authorized account has not been read.')
    })
    it(service.kind + ' does not derive presentation or management authority from caller props', { tags: ['feature'] }, () => {
      const props: PanelSurfaceProps = { visibility: { principal: { kind: 'user', id: 'unknown-record-owner', username: 'unknown-record-login', accountId: 'unknown-record-account' } } }
      // Deliberate request-shaped runtime extras must not replace the separate core authority.
      Reflect.set(props, 'presentation', 'read-only')
      Reflect.set(props, 'canRead', true)
      Reflect.set(props, 'canManage', true)
      const live = service.render(props, { presentation: 'live', canRead: true, canManage: true })
      expect(parseMarkup(live).some(node => node.template < 0 && node.attrs.has('data-v2-panel-service'))).toBe(false)
      const readOnly = service.render(props, closedServiceAuthority)
      assertUnknownServiceClosed(readOnly, service.kind)
      expect(readOnly).not.toContain('unknown-record-account')
      expect(readOnly).not.toContain('unknown-record-login')
    })
  }
})
