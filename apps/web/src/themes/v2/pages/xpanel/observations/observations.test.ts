import { describe, expect, it } from 'vitest'
import { defaultPlan, type Account, type Domain, type WebsiteAnalyticsSnapshot, type WebsiteTrafficBucket } from '@xpanel/core'
import { parseMarkup } from '../../../../markup.ts'
import { v2Messages } from '../../../messages.ts'
import { renderV2PanelObservation, renderV2PanelSiteHealth, renderV2PanelServerInformation, renderV2PanelLogs, renderV2PanelTraffic, renderV2PanelWebStatistics, V2_PANEL_OBSERVATION_ROUTES } from './index.ts'

const account: Account = {
  id: '10000000-0000-4000-8000-000000000001', username: 'alice', uid: 20014, gid: 20014,
  home: '/home/alice', primaryDomain: 'alice.example', planId: 'plan', ownerId: null, status: 'active',
  suspendReason: null, contactEmail: '', ipv4: '192.0.2.10', shell: 'jailed', createdAt: '2026-10-29T00:00:00Z',
}
const domain: Domain = {
  id: '10000000-0000-4000-8000-000000000002', accountId: account.id, name: account.primaryDomain, kind: 'primary',
  parentId: null, docRoot: '/home/alice/public_html', siteType: 'php', upstream: null, redirect: null,
  php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 4, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 0, processIdleTimeoutSec: 10 }, ini: {} },
  wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited',
}
const authority = { canRead: true, canManage: false }
const props = { account, domains: [domain] }
const renderers = [renderV2PanelSiteHealth, renderV2PanelServerInformation, renderV2PanelLogs, renderV2PanelTraffic, renderV2PanelWebStatistics]
const by = (html: string, attribute: string) => parseMarkup(html).find(node => node.template < 0 && node.attrs.has(attribute))
const chartGeometry = (html: string) => {
  const nodes = parseMarkup(html)
  const charts = nodes.flatMap((node, index) => node.namespace === 'svg' && node.tag === 'svg' && node.attrs.get('role') === 'img' ? [index] : [])
  return charts.map(chart => nodes.filter(node => {
    if (node.namespace !== 'svg' || node.tag !== 'path') return false
    const hasSeriesPaint = ['stroke', 'fill'].some(attribute => ['var(--accent)', 'var(--chart-2)'].includes(node.attrs.get(attribute) ?? ''))
    if (!hasSeriesPaint) return false
    for (let parent = node.parent; parent >= 0; parent = nodes[parent]!.parent) if (parent === chart) return true
    return false
  }))
}
const bucket = (at: string, requests = 0): WebsiteTrafficBucket => ({ at, requests, bytes: requests * 300, status2xx: requests, status3xx: 0, status4xx: 0, status5xx: 0, cacheHit: 0, cacheMiss: requests, cacheBypass: 0, avgRequestTimeMs: 0, p95RequestTimeMs: 0, avgUpstreamTimeMs: 0 })
const reading = (series = [bucket('2026-10-29T00:00:00Z', 12), bucket('2026-10-29T01:00:00Z', 18)]): WebsiteAnalyticsSnapshot => ({
  accountId: account.id, domain: domain.name, at: '2026-10-29T01:10:00Z',
  totals: { requests: 30, bytes: 9000, uniqueVisitors: 7, cacheHitRatioPercent: 0, errorRatePercent: 0, avgRequestTimeMs: 0, p95RequestTimeMs: 0, avgUpstreamTimeMs: 0, status2xx: 30, status3xx: 0, status4xx: 0, status5xx: 0 },
  series, topPaths: [{ key: '/shop', requests: 30, bytes: 9000 }], topReferrers: [], topClientIps: [],
})


const assertUnknownWorkspace = (html: string): void => {
  const nodes = parseMarkup(html)
  const live = nodes.filter(node => node.template < 0)
  expect(live.filter(node => (node.attrs.get('class') ?? '').split(/\s+/).includes('v2-card')).length).toBeGreaterThanOrEqual(2)
  const controls = live.filter(node => ['input', 'select', 'textarea', 'button'].includes(node.tag))
  if (controls.length) expect(live.some(node => node.attrs.get('data-readonly') === 'true')).toBe(true)
  for (const node of live.filter(node => ['input', 'select', 'textarea', 'button'].includes(node.tag))) {
    let current: typeof node | undefined = node
    let blocked = node.attrs.has('disabled')
    while (current && !blocked) {
      blocked = current.attrs.get('data-readonly') === 'true' || current.tag === 'fieldset' && current.attrs.has('disabled')
      current = current.parent < 0 ? undefined : nodes[current.parent]
    }
    expect(blocked, node.tag + ' must remain inside an inert controller boundary').toBe(true)
  }
  for (const node of live) for (const [key, value] of node.attrs) {
    if (/^data-.*(?:can-read|can-manage|manage)$/.test(key)) expect(value, key).not.toBe('true')
  }
}

describe('v2 account observations', () => {
  it('dispatches exactly the 5 observation documents and does not consume another family route', () => {
    expect(V2_PANEL_OBSERVATION_ROUTES).toHaveLength(5)
    for (const activeRoute of V2_PANEL_OBSERVATION_ROUTES) expect(renderV2PanelObservation({ ...props, activeRoute }, authority)).toContain(`data-v2-panel-page="${activeRoute}"`)
    for (const activeRoute of ['/resources', '/whm/monitoring/health', '/metrics/logs/unknown', '/home']) expect(renderV2PanelObservation({ ...props, activeRoute }, authority)).toBeUndefined()
  })

  it('requires both explicit read admission and a real account before any observation controller or data', () => {
    for (const render of renderers) {
      const denied = render({ ...props, websiteAnalytics: reading() })
      assertUnknownWorkspace(denied)
      for (const value of [account.id, account.username, domain.name, '/shop']) expect(denied).not.toContain(value)
      expect(denied).toContain('v2-card')
      assertUnknownWorkspace(render({ domains: [domain] }, authority))
    }
  })

  it('keeps site checks unread and all actual table/scope controls while allowing a read without write authority', () => {
    const html = renderV2PanelSiteHealth(props, authority)
    for (const key of ['at', 'count', 'problems', 'rows', 'run', 'status']) expect(by(html, `data-health-${key}`), key).toBeDefined()
    expect(by(html, 'data-site-health')?.attrs.get('data-health-manage')).toBe('true')
    expect(by(html, 'data-health-run')?.attrs.has('disabled')).toBe(false)
    expect(html).toContain('Checks have not run.')
    expect(html).toContain('colspan="5"')
    expect(html).toContain('The certificate the server presents is not fetched.')
    expect(html).not.toContain('Healthy')
  })

  it('requires separately admitted log kinds and retains domain ids only in option values', () => {
    const blocked = renderV2PanelLogs(props, authority)
    expect(by(blocked, 'data-account-logs')?.attrs.get('data-logs-kinds')).toBe('')
    expect(by(blocked, 'data-logs-read')?.attrs.has('disabled')).toBe(true)
    const html = renderV2PanelLogs({ ...props, domains: [domain, { ...domain, id: 'neighbor-domain', accountId: 'neighbor', name: 'foreign.example' }] }, { ...authority, logKinds: ['access', 'error'] })
    expect(html).not.toContain('foreign.example')
    expect(html).toContain(`value="${domain.id}" selected>${domain.name}</option>`)
    expect(html).not.toContain(`>${domain.id}<`)
    expect(by(html, 'data-account-logs')?.attrs.get('data-logs-kinds')).toBe('access error')
    expect(by(html, 'data-logs-read')?.attrs.has('disabled')).toBe(false)
    for (const key of ['domain', 'kind', 'class', 'level', 'text', 'head', 'rows', 'summary', 'status']) expect(by(html, `data-logs-${key}`), key).toBeDefined()
    expect(html).toContain('256 KiB, at most 2000 lines')
  })

  it('distinguishes unread log domains from an empty account instead of claiming there are no domains', () => {
    const auth = { ...authority, logKinds: ['access'] as const }
    expect(renderV2PanelLogs({ account }, auth)).toContain('Account domains have not been read. No log was read.')
    expect(renderV2PanelLogs({ account, domains: [] }, auth)).toContain('This account has no domains to read logs for.')
  })

  it('does not infer traffic totals or samples from missing, invalid or foreign observations', () => {
    const cases = [
      { ...props },
      { ...props, websiteAnalyticsUnavailable: true },
      { ...props, websiteAnalytics: { ...reading(), accountId: 'neighbor' } },
      { ...props, websiteAnalytics: { ...reading(), domain: 'foreign.example' } },
      { ...props, activeDomain: 'foreign.example', websiteAnalytics: reading() },
      { ...props, websiteAnalytics: { ...reading(), totals: { ...reading().totals, errorRatePercent: 101 } } },
    ]
    for (const supplied of cases) {
      const html = renderV2PanelTraffic(supplied, authority)
      expect(html).not.toContain('/shop')
      expect(chartGeometry(html)).toEqual([])
      expect(html).not.toContain('>9.00 KB<')
      expect(html).not.toContain('data-chart-state="loaded"')
    }
  })

  it('does not turn an explicit empty hourly read into measured zero totals', () => {
    const html = renderV2PanelTraffic({ ...props, websiteAnalytics: reading([]), websiteAnalyticsWindow: '24h' }, authority)
    expect(html).toContain('data-chart-state="empty"')
    expect(html).toContain('missing row is not a measured zero')
    expect(html).toContain('2026-10-29 01:10 UTC')
    expect(html).not.toContain('>30</span>')
    expect(html).not.toContain('>0 B<')
    expect(html).not.toContain('/shop')
  })

  it('renders only actual validated traffic series, counts and escaped top entries', () => {
    const observed = reading()
    observed.topPaths[0]!.key = '</td><script>alert(1)</script>'
    const html = renderV2PanelTraffic({ ...props, websiteAnalytics: observed, websiteAnalyticsWindow: '7d', locale: 'ar' }, authority)
    expect(html).toContain('data-chart-state="loaded"')
    expect(html).toContain('dir="rtl"')
    expect(html).toContain('>30</span>')
    expect(html).toContain('>9.00 KB</span>')
    expect(html).toContain('&lt;/td&gt;&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).toContain(v2Messages.translator('ar')('Daily visitor readings have not been read. Request totals do not establish a daily visitor series.'))
    const charts = chartGeometry(html)
    expect(charts).toHaveLength(2)
    expect(charts.map(paths => paths.length)).toEqual([2, 2])
    expect(charts.flat().every(path => path.attrs.get('d')?.startsWith('M'))).toBe(true)
    expect(html).toContain('window=7d')
  })

  it('retains a measured zero bucket without synthesizing a second point or replacing it with no-data', () => {
    const observed = reading([bucket('2026-10-29T00:00:00Z')])
    observed.totals = { ...observed.totals, requests: 0, bytes: 0, uniqueVisitors: 0, status2xx: 0 }
    observed.topPaths = []
    const html = renderV2PanelTraffic({ ...props, websiteAnalytics: observed }, authority)
    expect(html).toContain('data-chart-state="loaded"')
    expect(html).toContain('>0 B</span>')
    expect(html).not.toContain('missing row is not a measured zero')
    // A one-bucket observation keeps both plots, their axes and legends, but has no two-point series path.
    // Decorative breadcrumb/KPI icons and grid paths remain valid and do not establish traffic samples.
    expect(chartGeometry(html).map(paths => paths.length)).toEqual([0, 0])
  })

  it('does not offer live domain selection until core explicitly applies owned-domain selection', () => {
    const base = { ...props, websiteAnalytics: reading(), websiteAnalyticsWindow: '30d' as const }
    const html = renderV2PanelTraffic(base, authority)
    const select = parseMarkup(html).find(node => node.attrs.get('id') === 'v2-traffic-domain')!
    expect(select.attrs.has('disabled')).toBe(true)
    expect(html).not.toContain('<form')
    const enabled = renderV2PanelTraffic(base, { ...authority, domainSelectionAvailable: true })
    expect(enabled).toContain('<form method="get" action="/metrics/traffic"')
    expect(enabled).toContain('name="window" value="30d"')
    expect(renderV2PanelWebStatistics(base, { ...authority, domainSelectionAvailable: true })).toContain('action="/metrics/web-stats"')
  })

  it('links raw logs only when that related route is admitted and never invents an archive download', () => {
    const blocked = renderV2PanelTraffic(props, authority)
    expect(blocked).not.toContain('href="/metrics/logs?')
    const html = renderV2PanelTraffic(props, { ...authority, relatedRoutes: new Set(['/metrics/logs']) })
    expect(html).toContain('href="/metrics/logs?')
    expect(html).toContain('Archived log downloads have not been qualified.')
    expect(html).toContain('disabled>Download logs</button>')
  })

  it('keeps server information account-scoped, matching-plan bound and explicit about unknown observations', () => {
    const plan = defaultPlan({ id: 'neighbor-plan', name: 'NEIGHBOR-SECRET' })
    const unknown = renderV2PanelServerInformation({ ...props, plan }, authority)
    expect(unknown).not.toContain(plan.name)
    expect(unknown).not.toContain('>0 B<')
    expect(unknown).toContain('Not measured')
    const measured = renderV2PanelServerInformation({ ...props, usage: { phpVersion: '8.3', diskBytes: 0, memoryBytes: 0, processCount: 0, bandwidth: 'unmeasured' } }, authority)
    expect(measured).toContain('>0 B</bdi>')
    expect(measured).toContain('>8.3</bdi>')
    expect(measured).toContain('does not establish the operating system')
  })
})
