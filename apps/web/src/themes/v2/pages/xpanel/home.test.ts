import { describe, expect, it } from 'vitest'
import { defaultPlan, type Account, type Domain, type WebsiteAnalyticsSnapshot } from '@xpanel/core'
import { tools } from '@xpanel/catalog'
import { v2Messages } from '../../messages.ts'
import { parseMarkup, type MarkupNode } from '../../../markup.ts'
import { PANEL_HOME_TOOL_GROUPS, V2_PANEL_HOME_CSS, panelHomeMeters, renderV2PanelHome, selectedPanelPlan, type PanelPageProps } from './home.ts'

const account: Account = {
  id: 'private-account-key', username: 'sam', uid: 20031, gid: 20031, home: '/home/sam', primaryDomain: 'sam.test',
  planId: 'plan-a', ownerId: null, status: 'active', suspendReason: null, contactEmail: 'owner@sam.test',
  ipv4: '192.0.2.31', shell: 'none', createdAt: '2026-10-22T00:00:00Z',
}
const plan = defaultPlan({ id: account.planId, name: 'Business' })
const domain: Domain = {
  id: 'private-domain-key', accountId: account.id, name: account.primaryDomain, kind: 'primary', parentId: null,
  docRoot: '/home/sam/public_html', siteType: 'php', upstream: null, redirect: null,
  php: { version: '8.3', handler: 'fpm', ini: {}, fpm: { mode: 'ondemand', maxChildren: 4, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 500, processIdleTimeoutSec: 10 } }, wildcard: false, certificateId: null,
  suspended: false, expiresAt: null, pathQuotaMb: 'unlimited',
}
const qualified = tools.map(tool => ({ ...tool, status: 'verified' as const, delivery: { ...tool.delivery, status: 'verified' as const } }))
const props = (more: Partial<PanelPageProps> = {}): PanelPageProps => ({
  account, plan, domains: [domain], catalog: qualified,
  visibility: { principal: { kind: 'user', id: 'user', username: account.username, accountId: account.id }, disabledFeatures: new Set() },
  ...more,
})
const under = (nodes: readonly MarkupNode[], node: MarkupNode, ancestor: MarkupNode): boolean => {
  const at = nodes.indexOf(ancestor)
  for (let parent = node.parent; parent >= 0; parent = nodes[parent]!.parent) if (parent === at) return true
  return false
}
const traffic = (): WebsiteAnalyticsSnapshot => ({
  domain: domain.name, accountId: account.id, at: '2026-10-29T10:00:00Z',
  totals: { requests: 42, bytes: 16000, uniqueVisitors: 23, cacheHitRatioPercent: 0, errorRatePercent: 0,
    avgRequestTimeMs: 0, p95RequestTimeMs: 0, avgUpstreamTimeMs: 0, status2xx: 42, status3xx: 0, status4xx: 0, status5xx: 0 },
  series: [], topPaths: [], topReferrers: [], topClientIps: [],
})

describe('v2 account home', () => {
  it('keeps unobserved values unknown while retaining the requested sections', () => {
    const html = renderV2PanelHome(props())
    expect(html).toContain('Your sites')
    expect(html).toContain('Resource usage')
    expect(html).toContain('General information')
    expect(html).toContain('Recent changes')
    expect(html).toContain('Not reported by the agent')
    expect(html).toContain('Recent account changes were not read.')
    expect(html).not.toContain('Filesystem quota enforced')
    expect(html).not.toContain('Visitors today')
  })

  it('renders actual zero readings without converting them to missing or inventing enforcement', () => {
    const input = props({ usage: { phpVersion: null, diskBytes: 0, memoryBytes: 0, processCount: 0, bandwidth: 'unmeasured' } })
    const meters = panelHomeMeters(input, v2Messages.translator('en'))
    expect(meters[0]!.valueText).toBe('0 MiB / 5120 MiB')
    expect(meters[0]!.percent).toBe(0)
    expect(meters[4]!.valueText).toBe('0 / 100')
    expect(meters[1]!.valueText).toContain('Unavailable')
  })

  it('does not treat a foreign plan or child record as the account configuration', () => {
    const input = props({ plan: { ...plan, id: 'other-plan', name: 'Foreign plan' }, domains: [domain, { ...domain, id: 'other-domain', accountId: 'another-account', name: 'other.test' }] })
    expect(selectedPanelPlan(input)).toBeUndefined()
    const html = renderV2PanelHome(input)
    expect(html).not.toContain('Foreign plan')
    expect(html).not.toContain('other.test')
    expect(html).not.toContain('private-domain-key')
  })

  it('uses only validated traffic bound to the displayed account and selected domain', () => {
    const html = renderV2PanelHome(props({ websiteAnalytics: traffic(), websiteAnalyticsWindow: '24h' }))
    expect(html).toContain('<span>23</span>')
    expect(html).toContain('24h · sam.test')
    expect(html).not.toContain('v2-kpi__spark')
    for (const observation of [{ ...traffic(), accountId: 'other' }, { ...traffic(), domain: 'other.test' }, { ...traffic(), totals: { ...traffic().totals, requests: NaN } }]) {
      expect(renderV2PanelHome(props({ websiteAnalytics: observation }))).toContain('A validated account traffic observation is required.')
    }
    expect(renderV2PanelHome(props({ websiteAnalytics: traffic(), websiteAnalyticsUnavailable: true }))).toContain('A validated account traffic observation is required.')
  })

  it('distinguishes unread and empty site lists instead of displaying sample sites', () => {
    expect(renderV2PanelHome(props({ domains: undefined }))).toContain('The account domain list was not read.')
    expect(renderV2PanelHome(props({ domains: [] }))).toContain('No domains.')
    expect(renderV2PanelHome(props({ domains: [] }))).not.toContain('alice-shop.com')
  })

  it('keeps account facts under labels with inline technical isolation and escaped content', () => {
    const html = renderV2PanelHome(props({ locale: 'ar', account: { ...account, username: '<script>bad()</script>' } }))
    expect(html).toContain('<bdi dir="ltr" class="v2-mono">&lt;script&gt;bad()&lt;/script&gt;</bdi>')
    expect(html).not.toContain('<script>bad()')
    expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
    expect(html).toContain('<dl class="v2-panel-facts">')
  })

  it('shows only catalog-qualified tool links and keeps native page actions truthful', () => {
    const html = renderV2PanelHome(props({ visibility: undefined }))
    expect(html).toContain('No tools are available for this account.')
    expect(html).not.toContain('href="/software/php')
    expect(html).not.toContain('href="/domains"')
    expect(html).not.toContain('>Live<')
  })

  it('preserves the 35 presentation cards and 9 groups while hiding disallowed capabilities', () => {
    expect(PANEL_HOME_TOOL_GROUPS).toHaveLength(9)
    expect(PANEL_HOME_TOOL_GROUPS.reduce((sum, group) => sum + group.tools.length, 0)).toBe(35)
    const html = renderV2PanelHome(props({ visibility: { principal: { kind: 'user', id: 'user', username: account.username, accountId: account.id }, disabledFeatures: new Set(['filemanager']) } }))
    expect(html).not.toContain('data-tool-capability="file-manager"')
    expect(html).not.toContain('data-tool-capability="aapanel-url-rewrite"')
    expect(html).toContain('data-tool-capability="backup"')
  })

  it('retains an authorized unqualified card as disabled without attaching a working link', () => {
    const catalog = qualified.map(tool => tool.id === 'backup' ? { ...tool, status: 'implemented' as const, delivery: { ...tool.delivery, status: 'implemented' as const } } : tool)
    const html = renderV2PanelHome(props({ catalog }))
    expect(html).toMatch(/<button[^>]+disabled[^>]+data-tool-capability="backup"/)
    expect(html).not.toMatch(/<a[^>]+data-tool-capability="backup"/)
  })

  it('uses readable audit copy without exposing raw event codes or opaque target references', () => {
    const html = renderV2PanelHome(props({ recentAudit: [{ action: 'not.a.real.code', target: 'account:300ecfad-626d-4b52-a84a-f94db0b16cc1', actor: 'user:mbx1234567890' }] }))
    expect(html).toContain('Recorded event')
    expect(html).not.toContain('not.a.real.code')
    expect(html).not.toContain('300ecfad-626d-4b52-a84a-f94db0b16cc1')
    expect(html).not.toContain('mbx1234567890')
  })

  it('offers mobile site cards with the same factual fields and unique menu targets', () => {
    const html = renderV2PanelHome(props())
    expect(html).toContain('class="v2-home-sites-desktop"')
    expect(html).toContain('class="v2-home-sites-mobile"')
    expect(html).toContain('class="v2-home-site-card__facts"')
    expect(html).toContain('id="v2-home-site-table-0"')
    expect(html).toContain('id="v2-home-site-card-0"')
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives the shared filter native group disclosures and a preauthored clear action', () => {
    const html = renderV2PanelHome(props())
    expect(html).toContain('<details class="v2-home-tool-group" open data-home-accordion data-home-collapse-below="600"')
    expect(html.match(/data-home-filter(?:\s|>)/g)).toHaveLength(1)
    expect(html).toContain('data-home-filter-clear')
    expect(html).toContain('data-home-empty-title')
    expect(html).toContain('aria-describedby="tool-filter-count"')
  })

  it('places the full-width sites card before the tools and account-summary columns with 5 coherent table columns', () => {
    const nodes = parseMarkup(renderV2PanelHome(props()))
    const sites = nodes.find(node => node.attrs.has('data-home-sites'))!
    const columns = nodes.find(node => node.attrs.get('class') === 'v2-home-columns')!
    expect(sites.parent).toBe(columns.parent)
    expect(nodes.indexOf(sites)).toBeLessThan(nodes.indexOf(columns))
    expect(under(nodes, sites, columns)).toBe(false)
    const table = nodes.find(node => node.tag === 'table' && node.attrs.get('id') === 'v2-home-sites')!
    const heads = nodes.filter(node => node.tag === 'th' && under(nodes, node, table))
    expect(heads).toHaveLength(5)
    const body = nodes.find(node => node.tag === 'tbody' && under(nodes, node, table))!
    const row = nodes.find(node => node.tag === 'tr' && node.parent === nodes.indexOf(body))!
    const cells = nodes.filter(node => node.tag === 'td' && node.parent === nodes.indexOf(row))
    expect(cells).toHaveLength(5)
    expect(nodes.some(node => node.attrs.get('class') === 'v2-home-site__root v2-mono' && under(nodes, node, cells[0]!))).toBe(true)
    expect(nodes.some(node => node.attrs.get('class') === 'v2-home-site__mark' && under(nodes, node, cells[0]!))).toBe(true)
  })

  it('uses separate tool-group cards with inline icon, label and hint while retaining unqualified positions', () => {
    const baseline = parseMarkup(renderV2PanelHome(props()))
    const unqualifiedCatalog = qualified.map(tool => tool.id === 'backup' ? { ...tool, status: 'implemented' as const, delivery: { ...tool.delivery, status: 'implemented' as const } } : tool)
    const nodes = parseMarkup(renderV2PanelHome(props({ catalog: unqualifiedCatalog })))
    const toolsRoot = nodes.find(node => node.attrs.has('data-home-tools'))!
    expect(toolsRoot.tag).toBe('section')
    expect(toolsRoot.attrs.get('class')).toBe('v2-home-tools')
    const groups = nodes.filter(node => node.attrs.has('data-tool-group'))
    expect(groups).toHaveLength(9)
    for (const group of groups) {
      expect(group.tag).toBe('details')
      expect(group.attrs.get('data-home-collapse-below')).toBe('600')
      expect(group.attrs.has('open')).toBe(true)
      const ownTools = nodes.filter(node => node.attrs.has('data-tool') && under(nodes, node, group))
      expect(ownTools.length).toBeGreaterThan(0)
      for (const tool of ownTools) {
        const direct = nodes.filter(node => node.parent === nodes.indexOf(tool))
        expect(direct.map(node => node.attrs.get('class'))).toEqual([
          expect.stringContaining('v2-home-tool__tile'), 'v2-home-tool__label', 'v2-home-tool__hint v2-num',
        ])
      }
    }
    expect(nodes.filter(node => node.attrs.has('data-tool'))).toHaveLength(baseline.filter(node => node.attrs.has('data-tool')).length)
    expect(nodes.find(node => node.attrs.get('data-tool-capability') === 'backup')?.attrs.has('disabled')).toBe(true)
    expect(V2_PANEL_HOME_CSS).toContain('.v2-panel-home .v2-home-tool-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))')
    expect(V2_PANEL_HOME_CSS).toContain('.v2-panel-home .v2-home-tool-group{display:block;min-inline-size:0;padding:var(--v2-panel-padding)')
    expect(V2_PANEL_HOME_CSS).toContain('.v2-panel-home .v2-home-tool-grid{display:flex;flex-direction:column')
  })

  it('does not treat a foreign certificate record as the stored certificate of an owned site', () => {
    const certificateId = 'owned-domain-certificate-reference'
    const html = renderV2PanelHome(props({ domains: [{ ...domain, certificateId }], certificates: [{ id: certificateId, accountId: 'another-account', names: ['other.test'], source: 'acme', challenge: 'http-01', notAfter: '2027-01-01T00:00:00Z', autoRenew: true }] }))
    expect(html).not.toContain('>Stored certificate<')
    expect(html).not.toContain('other.test')
    expect(html).not.toContain('>No stored certificate<')
    expect(html).toContain('Not read')
  })

  it('keeps the full home layout without account identity when no account was supplied', () => {
    const html = renderV2PanelHome({})
    expect(html).toContain('v2-home-sites-title')
    expect(html).toContain('v2-home-information-title')
    expect(html).toContain('Not read')
    expect(html).not.toContain('data-account=')
  })
})
