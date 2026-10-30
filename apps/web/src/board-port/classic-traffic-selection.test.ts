/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type { Account, Domain, WebsiteAnalyticsSnapshot } from '@xpanel/core'
import { translator, type Locale } from '../i18n.ts'
import { buildApprovedPanelPage } from './approved-xpanel-pages.ts'
import { renderApprovedXpanelWorkspace, type ApprovedXpanelWorkspaceProps } from './approved-xpanel-workspaces.ts'

const account: Account = {
  id: '11111111-1111-4111-8111-111111111111', username: 'trafficowner', uid: 20042, gid: 20042, home: '/home/trafficowner',
  primaryDomain: 'owner-traffic.example.test', planId: '22222222-2222-4222-8222-222222222222', ownerId: null, status: 'active',
  suspendReason: null, contactEmail: 'owner@example.test', ipv4: '192.0.2.42', ipv6: null, shell: 'none', createdAt: '2026-10-29T10:00:00.000Z',
}
const primary: Domain = {
  id: '33333333-3333-4333-8333-333333333333', accountId: account.id, name: account.primaryDomain, kind: 'primary', parentId: null,
  docRoot: account.home + '/public_html', siteType: 'php', upstream: null, redirect: null,
  php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 1, startServers: 1, minSpareServers: 1,
    maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} },
  wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited',
}
const addon: Domain = { ...primary, id: '44444444-4444-4444-8444-444444444444', name: 'addon.owner-traffic.example.test', kind: 'addon', docRoot: account.home + '/addon' }
const foreign: Domain = { ...primary, id: '55555555-5555-4555-8555-555555555555', accountId: '66666666-6666-4666-8666-666666666666', name: 'foreign-traffic.example.test' }
const observation = (patch: Partial<WebsiteAnalyticsSnapshot> = {}): WebsiteAnalyticsSnapshot => ({
  domain: addon.name, accountId: account.id, at: '2026-10-29T10:00:00.000Z',
  totals: { requests: 23, bytes: 1024, uniqueVisitors: 5, cacheHitRatioPercent: 0, errorRatePercent: 0,
    avgRequestTimeMs: 10, p95RequestTimeMs: 20, avgUpstreamTimeMs: 5, status2xx: 21, status3xx: 0, status4xx: 0, status5xx: 2 },
  series: [], topPaths: [{ key: '/owned-addon-page.php', requests: 23, bytes: 1024, errors5xx: 2 }], topReferrers: [], topClientIps: [],
  ...patch,
})
const props = (route: string, locale: Locale, patch: Partial<ApprovedXpanelWorkspaceProps> = {}): ApprovedXpanelWorkspaceProps => ({
  route, locale, readOnly: false, theme: 'dark', density: 'compact', account,
  // The primary intentionally precedes the selected addon, and a foreign row
  // must never become an option merely because it was supplied to presentation.
  domains: [primary, addon, foreign], activeDomain: addon.name,
  websiteAnalyticsWindow: '7d', websiteAnalyticsDomainSelectionAvailable: true, websiteAnalytics: observation(),
  visibility: { principal: { kind: 'user', id: '77777777-7777-4777-8777-777777777777', username: account.username, accountId: account.id } },
  ...patch,
})
const render = (input: ApprovedXpanelWorkspaceProps): HTMLElement => {
  document.documentElement.lang = input.locale
  document.documentElement.dir = input.locale === 'ar' ? 'rtl' : 'ltr'
  const html = renderApprovedXpanelWorkspace(input)
  expect(html).toBeDefined()
  document.body.innerHTML = html!
  return document.body
}
const buttons = (root: HTMLElement, name: string): HTMLButtonElement[] => [...root.querySelectorAll<HTMLButtonElement>(`button[name="${name}"]`)]
const selectionButtons = (root: HTMLElement): HTMLButtonElement[] => [...buttons(root, 'domain'), ...buttons(root, 'window')]

/** Native GET form submission replaces the action query with successful form controls. */
const submittedUrl = (button: HTMLButtonElement): URL => {
  const form = button.form
  expect(form).not.toBeNull()
  expect(form!.method.toLowerCase()).toBe('get')
  const fields = new FormData(form!, button)
  const url = new URL(form!.getAttribute('action') ?? '', 'https://panel.example.test')
  const search = new URLSearchParams()
  for (const [name, value] of fields.entries()) {
    expect(typeof value).toBe('string')
    search.append(name, String(value))
  }
  url.search = search.toString()
  return url
}
afterEach(() => { document.body.replaceChildren(); document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr' })

describe('classic traffic domain and range navigation', () => {
  it.each([
    ['/metrics/traffic', 'en'], ['/metrics/traffic', 'ar'],
    ['/metrics/web-stats', 'en'], ['/metrics/web-stats', 'ar'],
  ] as const)('submits owned domain and range GET controls on %s in %s without losing page context', (route, locale) => {
    const input = props(route, locale, { nativeHtml: '<section data-native-traffic><h1>Existing website traffic chart</h1><div data-chart-state="loaded"></div></section>' })
    const root = render(input)
    expect(root.querySelectorAll(`[data-approved-xpanel-workspace="${route}"]`)).toHaveLength(1)
    expect(root.querySelectorAll('h1')).toHaveLength(1)
    expect(root.querySelectorAll('[data-native-traffic]')).toHaveLength(1)
    expect(root.querySelector('#panel-detail-metrics-scope-0')).toBeNull()
    expect(root.querySelectorAll('[data-workspace-section="metrics-scope"]')).toHaveLength(1)
    expect(root.querySelectorAll('form')).toHaveLength(2)
    const domains = buttons(root, 'domain'), ranges = buttons(root, 'window')
    expect(domains.map(button => button.value)).toEqual([primary.name, addon.name])
    expect(ranges.map(button => button.value)).toEqual(['1h', '24h', '7d', '30d'])
    expect(selectionButtons(root).every(button => !button.disabled)).toBe(true)
    expect(domains.filter(button => button.getAttribute('aria-pressed') === 'true').map(button => button.value)).toEqual([addon.name])
    expect(ranges.filter(button => button.getAttribute('aria-pressed') === 'true').map(button => button.value)).toEqual(['7d'])
    for (const button of domains) expect(button.querySelector('bdi')?.getAttribute('dir')).toBe('ltr')
    const domainUrl = submittedUrl(domains[0]!)
    const rangeUrl = submittedUrl(ranges.find(button => button.value === '30d')!)
    for (const url of [domainUrl, rangeUrl]) {
      expect(url.pathname).toBe(route)
      expect(url.searchParams.get('lang')).toBe(locale)
      expect(url.searchParams.get('theme')).toBe('dark')
      expect(url.searchParams.get('density')).toBe('compact')
      expect(url.searchParams.getAll('domain')).toHaveLength(1)
      expect(url.searchParams.getAll('window')).toHaveLength(1)
    }
    expect(domainUrl.searchParams.get('domain')).toBe(primary.name)
    expect(domainUrl.searchParams.get('window')).toBe('7d')
    expect(rangeUrl.searchParams.get('domain')).toBe(addon.name)
    expect(rangeUrl.searchParams.get('window')).toBe('30d')
    expect(root.textContent).not.toContain(foreign.name)
    expect(root.querySelectorAll('[data-workspace-table="top-pages"] tbody tr')).toHaveLength(1)
    expect(root.querySelector('[data-workspace-table="top-pages"] tbody tr td bdi')?.textContent).toBe('/owned-addon-page.php')
    for (const node of root.querySelectorAll('[data-technical-value="true"] bdi')) {
      expect(node.getAttribute('dir')).toBe('ltr')
      expect(node.classList.contains('xp-mono')).toBe(true)
    }
    const top = buildApprovedPanelPage(input).sections.find(section => section.id === 'top-pages')!
    expect(top.rows?.[0]?.[0]).toBe('/owned-addon-page.php')
    expect(top.read).toBe(true)
  })

  const denied: ReadonlyArray<readonly [string, Partial<ApprovedXpanelWorkspaceProps>]> = [
    ['missing trusted flag', { websiteAnalyticsDomainSelectionAvailable: undefined }],
    ['false trusted flag', { websiteAnalyticsDomainSelectionAvailable: false }],
    ['read-only workspace', { readOnly: true }],
    ['foreign active selection', { activeDomain: foreign.name }],
  ]
  it.each(denied)('keeps the navigation fail-closed for %s', (_reason, patch) => {
    const root = render(props('/metrics/traffic', 'en', patch))
    expect(buttons(root, 'window')).toHaveLength(4)
    expect(selectionButtons(root).every(button => button.disabled)).toBe(true)
    expect(buttons(root, 'domain').some(button => button.value === foreign.name)).toBe(false)
    if (patch.activeDomain === foreign.name) {
      expect(buttons(root, 'domain').filter(button => button.getAttribute('aria-pressed') === 'true')).toHaveLength(0)
      expect(root.querySelector('[data-workspace-table="top-pages"] tbody [data-technical-value]')).toBeNull()
    }
  })

  it.each(['en', 'ar'] as const)('keeps unread rows human and selection usable without inventing observations in %s', locale => {
    const root = render(props('/metrics/web-stats', locale, { websiteAnalytics: undefined, websiteAnalyticsUnavailable: true }))
    expect(selectionButtons(root).every(button => !button.disabled)).toBe(true)
    const unread = root.querySelector('[data-workspace-table="top-pages"] tbody td')!
    expect(unread.textContent).toBe(translator(locale)('These records have not been read.'))
    expect(unread.querySelector('bdi')).toBeNull()
    expect(root.querySelector('[data-workspace-table="top-pages"] [data-technical-value]')).toBeNull()
    expect(root.querySelector('[data-chart-state="unread"]')).not.toBeNull()
    expect(root.querySelector('[data-chart-state="loaded"]')).toBeNull()
    expect(root.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })

  it.each(['domain', 'accountId'] as const)('does not render an observation whose %s belongs to another website', key => {
    const reading = observation(key === 'domain' ? { domain: foreign.name } : { accountId: foreign.accountId })
    reading.topPaths = [{ key: '/foreign-private-payload.php', requests: 999, bytes: 9999, errors5xx: 1 }]
    const root = render(props('/metrics/traffic', 'en', { websiteAnalytics: reading,
      nativeHtml: '<section data-unverified-native-traffic><h1>Unverified reading</h1><p>/foreign-private-payload.php</p></section>' }))
    expect(root.textContent).not.toContain('/foreign-private-payload.php')
    expect(root.querySelector('[data-unverified-native-traffic]')).toBeNull()
    expect(root.querySelectorAll('h1')).toHaveLength(1)
    expect(root.querySelector('[data-workspace-table="top-pages"] tbody [data-technical-value]')).toBeNull()
    expect(root.querySelector('[data-workspace-table="top-pages"] tbody td')?.textContent).toBe('These records have not been read.')
    expect(buttons(root, 'domain').filter(button => button.getAttribute('aria-pressed') === 'true').map(button => button.value)).toEqual([addon.name])
  })
})
