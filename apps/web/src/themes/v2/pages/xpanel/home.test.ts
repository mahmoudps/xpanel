import { describe, expect, it } from 'vitest'
import { defaultPlan, type Account, type Domain, type WebsiteAnalyticsSnapshot } from '@xpanel/core'
import { unqualifiedTools as tools } from '@xpanel/catalog'
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
    // Two numbers are isolated together; a limit of a GiB or more reads in GiB.
    expect(meters[0]!.valueText).toBe('⁦0 B / 5.00 GiB⁩')
    expect(meters[0]!.percent).toBe(0)
    expect(meters[4]!.valueText).toBe('⁦0 / 100⁩')
    expect(meters[1]!.valueText).toContain('Unavailable')
  })

  it('isolates a numeric limit after an unavailable reading so its unit follows its number in Arabic', () => {
    const [disk] = panelHomeMeters(props(), v2Messages.translator('ar'))
    expect(disk!.valueText).toMatch(/ \/ ⁦[0-9.]+ [MG]iB⁩$/)
    expect(disk!.valueText).not.toMatch(/[٠-٩]/)
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
    expect(html).toContain('data-tool-capability="domain-htaccess"')
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
    expect(V2_PANEL_HOME_CSS).toContain('.v2-panel-home .v2-home-tool-group{display:block;min-inline-size:0;padding:var(--space-2) 12px 12px')
    expect(V2_PANEL_HOME_CSS).toContain('.v2-panel-home .v2-home-tool-grid{display:flex;flex-direction:column')
  })

  it('opens the SSL and site log cards from the tools that deliver their pages', () => {
    const card = (catalog: PanelPageProps['catalog'], keys: string) => parseMarkup(renderV2PanelHome(props({ catalog }))).find(node => node.attrs.get('data-tool-keys')?.endsWith(keys))!
    const without = (id: string) => qualified.map(tool => tool.id === id ? { ...tool, status: 'researched' as const, delivery: { ...tool.delivery, status: 'researched' as const } } : tool)
    for (const [keys, id] of [['https certificate autossl wildcard tls', 'ssl-tls-status'], ['error log apache nginx', 'visitors']] as const) {
      expect(card(qualified, keys).attrs.get('data-tool-capability')).toBe(id)
      expect(card(qualified, keys).tag).toBe('a')
      expect(card(without(id), keys).tag).toBe('button')
    }
    expect(card(without('ssl-certificates'), 'https certificate autossl wildcard tls').tag).toBe('a')
  })

  it('does not treat a foreign certificate record as the stored certificate of an owned site', () => {
    const certificateId = 'owned-domain-certificate-reference'
    const html = renderV2PanelHome(props({ domains: [{ ...domain, certificateId }], certificates: [{ id: certificateId, accountId: 'another-account', names: ['other.test'], source: 'acme', challenge: 'http-01', notAfter: '2027-01-01T00:00:00Z', autoRenew: true }] }))
    expect(html).not.toContain('>Stored certificate<')
    expect(html).not.toContain('other.test')
    expect(html).not.toContain('>No stored certificate<')
    expect(html).toContain('Not read')
  })

  it('shows the stored expiry only under an owned stored certificate', () => {
    const certificateId = 'owned-domain-certificate-reference'
    const certificate = { id: certificateId, accountId: account.id, names: [domain.name], source: 'acme' as const, challenge: 'http-01' as const, notAfter: '2027-01-12T09:00:00Z', autoRenew: true }
    const html = renderV2PanelHome(props({ domains: [{ ...domain, certificateId }], certificates: [certificate] }))
    expect(html).toContain('data-home-site-expiry>Expires (UTC) <bdi dir="ltr">2027-01-12 09:00</bdi>')
    expect(renderV2PanelHome(props({ domains: [{ ...domain, certificateId }], certificates: [{ ...certificate, accountId: 'another-account' }] }))).not.toContain('data-home-site-expiry')
    expect(renderV2PanelHome(props())).not.toContain('data-home-site-expiry')
  })

  it('names the active generation only when core supplied a valid one', () => {
    expect(renderV2PanelHome(props({ generationId: 142 }))).toMatch(/data-home-generation>.*Applied in generation #142/)
    expect(renderV2PanelHome(props())).not.toContain('data-home-generation')
    expect(renderV2PanelHome(props({ generationId: 0 }))).not.toContain('data-home-generation')
    expect(renderV2PanelHome({ generationId: 142 })).not.toContain('data-home-generation')
  })

  it('marks a measured warning with its level and stays plain without one', () => {
    const usage = { phpVersion: null, diskBytes: 5000 * 1024 * 1024, memoryBytes: null, processCount: null, bandwidth: 'unmeasured' as const }
    expect(renderV2PanelHome(props({ usage }))).toMatch(/data-account-warning="disk" data-level="critical"/)
    expect(renderV2PanelHome(props())).not.toContain('data-account-warning=')
  })

  it('keeps the full home layout without account identity when no account was supplied', () => {
    const html = renderV2PanelHome({})
    expect(html).toContain('v2-home-sites-title')
    expect(html).toContain('v2-home-information-title')
    expect(html).toContain('Not read')
    expect(html).not.toContain('data-account=')
  })
})

// Synthetic delivery fixtures test admission only. Production remains researched.
describe('bounded owner rewrite home card', () => {
  it('renders all 35 approved account cards and keeps the new production rewrite card disabled', () => {
    const complete = parseMarkup(renderV2PanelHome(props()))
    expect(complete.filter(node => node.attrs.has('data-tool-capability'))).toHaveLength(35)
    const production = parseMarkup(renderV2PanelHome(props({ catalog: tools })))
    const rewrite = production.find(node => node.attrs.get('data-tool-capability') === 'domain-htaccess')!
    expect(rewrite.tag).toBe('button'); expect(rewrite.attrs.has('disabled')).toBe(true)
    expect(rewrite.attrs.has('href')).toBe(false)
    expect(production.some(node => node.attrs.get('data-tool-capability') === 'aapanel-url-rewrite')).toBe(false)
  })
  it.each(['domain-htaccess', 'aapanel-url-rewrite'])('retains the saved plan denial for %s', deny => {
    const html = renderV2PanelHome(props({ visibility: { ...props().visibility!, disabledFeatures: new Set([deny]) } }))
    expect(html).not.toContain('data-tool-capability="domain-htaccess"')
  })
  it('never makes the rewrite card eligible without a feature policy', () => {
    const html = renderV2PanelHome(props({ visibility: { principal: props().visibility!.principal } }))
    expect(html).not.toContain('data-tool-capability="domain-htaccess"')
  })
})

describe('v2 home registered personal navigation', () => {
  const personalIds = ['change-language', 'two-factor-auth', 'api-tokens', 'password-security'] as const
  const unverified = qualified.map(tool => ({ ...tool, status: 'implemented' as const, delivery: { ...tool.delivery, status: 'implemented' as const } }))

  it.each(['en', 'ar'] as const)('keeps authorized personal links available without qualifying native tools in %s', locale => {
    const html = renderV2PanelHome(props({ locale, catalog: unverified }))
    const nodes = parseMarkup(html)
    const currentLanguageHint = '<span class="v2-home-tool__hint v2-num">' + (locale === 'en' ? 'English' : 'العربية') + '</span>'
    expect(html).toContain(currentLanguageHint)
    for (const id of personalIds) {
      const item = nodes.find(node => node.attrs.get('data-tool-capability') === id)!
      expect(item.tag, id).toBe('a')
      expect(item.attrs.get('href')).toBe(id === 'change-language' ? (locale === 'en' ? '?lang=ar' : '?lang=en') : '/security/account')
      expect(item.attrs.has('disabled')).toBe(false)
    }
    const native = nodes.find(node => node.attrs.get('data-tool-capability') === 'backup')!
    expect(native.tag).toBe('button')
    expect(native.attrs.has('disabled')).toBe(true)
    expect(native.attrs.has('href')).toBe(false)
  })

  it.each(['en', 'ar'] as const)('retains team authorization before making a personal link in %s', locale => {
    const visibility = { ...props().visibility!, allowedToolIds: new Set(['backup']) }
    const nodes = parseMarkup(renderV2PanelHome(props({ locale, catalog: unverified, visibility })))
    for (const id of personalIds) expect(nodes.some(node => node.attrs.get('data-tool-capability') === id)).toBe(false)
    const native = nodes.find(node => node.attrs.get('data-tool-capability') === 'backup')!
    expect(native.tag).toBe('button')
    expect(native.attrs.has('disabled')).toBe(true)
  })

  it('does not infer personal authorization without a visibility context', () => {
    const nodes = parseMarkup(renderV2PanelHome(props({ catalog: unverified, visibility: undefined })))
    expect(nodes.some(node => node.attrs.has('data-tool-capability'))).toBe(false)
  })

  it('does not fabricate catalog definitions when the supplied catalog is empty', () => {
    const nodes = parseMarkup(renderV2PanelHome(props({ catalog: [] })))
    expect(nodes.some(node => node.attrs.has('data-tool-capability'))).toBe(false)
  })

  it('renders the applied generation timestamp and TLS certificate renewal strip when supplied', () => {
    const soonIso = new Date(Date.now() + 7 * 86_400_000).toISOString()
    const html = renderV2PanelHome(props({
      generationId: 18,
      generationActivatedAt: '2026-11-11T08:30:00.000Z',
      certificates: [{
        id: 'cert-1',
        accountId: account.id,
        names: [domain.name],
        source: 'acme',
        challenge: 'http-01',
        notAfter: soonIso,
        autoRenew: true,
      }],
      autoSsl: { state: 'active', nextRunAt: '2026-11-12T03:00:00.000Z', lastRunAt: null, renewDays: 30 },
    }))
    expect(html).toContain('data-home-generation')
    expect(html).toContain('Applied in generation #18 · 2026-11-11 08:30 UTC')
    expect(html).toContain('data-cert-renewal-strip')
    expect(html).toContain('1 expiring within 30 days · 0 healthy')
    expect(html).toContain('Next AutoSSL renewal check: 2026-11-12 03:00 UTC')
  })
})