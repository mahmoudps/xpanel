import { describe, expect, it } from 'vitest'
import { canonicalNavigationRoute, registeredDocumentAliases, tools, visibleNavigation } from '@xpanel/catalog'
import { defaultPlan, type Account, type Principal } from '@xpanel/core'
import { projectPanelSurface, projectWhmSurface } from '../../../models/theme-surface.ts'
import type { PanelSurfaceProps, ThemeViewProps, WhmSurfaceProps } from '../../contract.ts'
import { parseMarkup } from '../../markup.ts'
import { V2_SECURITY_SLOT } from './slots.ts'
import { createV2PanelSurface } from './xpanel.ts'
import { createV2WhmSurface } from './xwhm.ts'

const catalog = tools.map(tool => ({ ...tool, status: 'verified' as const, delivery: { ...tool.delivery, status: 'verified' as const } }))
const account: Account = { id: 'account-internal', username: 'alice', uid: 20001, gid: 20001, home: '/home/alice', primaryDomain: 'alice.test', planId: 'plan-internal', ownerId: null, status: 'active', suspendReason: null, contactEmail: 'owner@example.test', ipv4: '192.0.2.10', shell: 'none', createdAt: '2026-10-29T00:00:00Z' }
const plan = defaultPlan({ id: account.planId, name: 'Business' })
const panel: PanelSurfaceProps = { account, plan, visibility: { principal: { kind: 'user', id: 'principal-internal', username: account.username, accountId: account.id }, disabledFeatures: new Set() }, catalog }
const principal: Principal = { kind: 'root', id: 'root-internal', username: 'operator' }
const whm: WhmSurfaceProps = { principal, visibility: { principal }, accounts: [account], plans: [plan], catalog }
const renderPanel = createV2PanelSurface(projectPanelSurface, () => '<section data-core-panel-denied></section>')
const renderWhm = createV2WhmSurface(projectWhmSurface, () => '<section data-core-whm-denied></section>')
const documents = (surface: 'xpanel' | 'xwhm'): string[] => {
  const canonical = visibleNavigation(surface === 'xpanel' ? panel.visibility! : whm.visibility!, catalog).find(item => item.surface === surface)!.sections.flatMap(section => section.pages.map(page => page.route))
  const allowed = new Set(canonical)
  return [...canonical, ...registeredDocumentAliases.filter(alias => allowed.has(canonicalNavigationRoute(alias.route))).map(alias => alias.route)]
}

describe('complete v2 account surface dispatch', () => {
  it.each(documents('xpanel'))('renders the actual body for %s inside exactly one surface shell', activeRoute => {
    const html = renderPanel({ ...panel, activeRoute })
    expect(html).not.toContain('data-core-panel-denied')
    expect(html.match(/id="main-content"/g)).toHaveLength(1)
    expect(html.match(/id="xp-sidebar"/g)).toHaveLength(1)
    expect(html.match(/<h1\b/g)).toHaveLength(1)
    expect(html).not.toContain('xp-board-port')
    expect(html.split(V2_SECURITY_SLOT).length - 1).toBe(activeRoute === '/security/account' ? 1 : 0)
  })

  it.each(['/domains/site-settings', '/software/htaccess'])('preserves core denial for %s without a bounded owner tool', activeRoute => {
    expect(renderPanel({ ...panel, activeRoute })).toBe('<section data-core-panel-denied></section>')
  })

  it('forwards real denied inputs to core without leaking account facts', () => {
    let observed: unknown
    const input = { ...panel, account: undefined, activeRoute: '/home' }
    const html = createV2PanelSurface(projectPanelSurface, props => { observed = props; return '<section>Unavailable</section>' })(input)
    expect(observed).toBe(input)
    expect(html).toBe('<section>Unavailable</section>')
    expect(html).not.toContain(account.username)
  })

  it('keeps domain forwarders available without optional mailbox suggestions', () => {
    const domain = { id: 'domain-a', accountId: account.id, name: account.primaryDomain, kind: 'primary' as const, parentId: null, docRoot: account.home + '/public_html', siteType: 'static' as const, upstream: null, redirect: null,
      php: { version: '8.3', handler: 'fpm' as const, ini: {}, fpm: { mode: 'ondemand' as const, maxChildren: 4, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 500, processIdleTimeoutSec: 10 } }, wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited' as const }
    const html = renderPanel({ ...panel, activeRoute: '/email/forwarders', domains: [domain] })
    expect(html).toContain('data-forwarder-manage="true"')
    expect(html).toContain('data-forwarder-create')
    expect(html).toContain('data-autoresponder-form')
    expect(html).toContain('<datalist id="autoresponder-mailboxes"></datalist>')
    expect(renderPanel({ ...panel, activeRoute: '/email/forwarders', domains: undefined })).toContain('data-forwarder-manage="false"')
    expect(renderPanel({ ...panel, account: { ...account, status: 'suspended' }, activeRoute: '/email/forwarders', domains: [domain] })).toContain('data-forwarder-manage="false"')
  })

  it('throws an explicit implementation gap instead of hiding a qualified missing renderer', () => {
    const view = projectPanelSurface(panel)!
    const missing = { ...view, route: '/missing-qualified-panel', props: { ...view.props, activeRoute: '/missing-qualified-panel' } }
    expect(() => createV2PanelSurface(() => missing, () => '<p>Unavailable</p>')(panel)).toThrow('v2_panel_implementation_gap:/missing-qualified-panel')
  })

  it('keeps one action outcome and preserves the selected traffic window in scheme/language links', () => {
    const html = renderPanel({ ...panel, activeRoute: '/metrics/traffic', activeDomain: account.primaryDomain, websiteAnalyticsWindow: '7d', actionState: { state: 'conflict', preserveDraft: true, jobId: 'opaque-private-job' } })
    expect(html.match(/data-action-state="conflict"/g)).toHaveLength(1)
    expect(html).not.toContain('opaque-private-job')
    const href = parseMarkup(html).find(node => node.tag === 'a' && node.attrs.get('data-lang-switch') === 'ar')?.attrs.get('href')
    expect(href).toBeDefined()
    const url = new URL(href!, 'https://panel.example.test')
    expect(url.searchParams.get('window')).toBe('7d')
    expect(url.searchParams.get('domain')).toBe(account.primaryDomain)
  })
})

describe('complete v2 operator surface dispatch', () => {
  it.each(documents('xwhm'))('renders the actual body for %s inside exactly one surface shell', activeRoute => {
    const html = renderWhm({ ...whm, activeRoute })
    expect(html).not.toContain('data-core-whm-denied')
    expect(html.match(/id="main-content"/g)).toHaveLength(1)
    expect(html.match(/id="xp-sidebar"/g)).toHaveLength(1)
    expect(html.match(/<h1\b/g)).toHaveLength(1)
    expect(html).not.toContain('xp-board-port')
    expect(html.split(V2_SECURITY_SLOT).length - 1).toBe(activeRoute === '/whm/security/sign-in' ? 1 : 0)
  })

  it('forwards genuine denied inputs and throws for qualified missing implementations', () => {
    expect(renderWhm({ ...whm, capabilityUnavailable: true })).toBe('<section data-core-whm-denied></section>')
    const view = projectWhmSurface(whm)!
    const missing = { ...view, route: '/missing-qualified-whm', props: { ...view.props, activeRoute: '/missing-qualified-whm' } }
    expect(() => createV2WhmSurface(() => missing, () => '<p>Unavailable</p>')(whm)).toThrow('v2_whm_implementation_gap:/missing-qualified-whm')
  })

  it('preserves loaded audit filters and cursor on language and scheme switches', () => {
    const auditList = { actor: 'operator', action: 'account.update', target: 'account:alice', before: 'opaque-cursor', outcome: 'denied', from: '2026-10-01', to: '2026-10-29', hasMore: true, oldestId: 'opaque-cursor' }
    const html = renderWhm({ ...whm, activeRoute: '/whm/audit', auditList })
    const href = parseMarkup(html).find(node => node.tag === 'a' && node.attrs.get('data-lang-switch') === 'ar')?.attrs.get('href')
    expect(href).toBeDefined()
    const url = new URL(href!, 'https://whm.example.test')
    for (const key of ['actor', 'action', 'target', 'before', 'outcome', 'from', 'to'] as const) expect(url.searchParams.get(key)).toBe(auditList[key])
  })

  it('passes protected branding to both shells while escaping project labels', () => {
    const branding: NonNullable<ThemeViewProps['branding']> = { companyName: 'Example', productName: '<b>Hosted tools</b>', footerText: '', hidePoweredBy: false, primaryColor: '#102030', accentColor: '#405060', supportUrl: '', supportEmail: '', logoUrl: null, faviconUrl: null }
    for (const html of [renderPanel({ ...panel, branding }), renderWhm({ ...whm, branding })]) {
      expect(html).toContain('&lt;b&gt;Hosted tools&lt;/b&gt;')
      expect(html).not.toContain('<b>Hosted tools</b>')
    }
  })
})
