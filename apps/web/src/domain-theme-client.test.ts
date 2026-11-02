/// <reference lib="dom" />
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { defaultPlan, msgctxt, msgid, type Account, type Domain } from '@xpanel/core'
import { translator } from './i18n.ts'
import { DOMAIN_WORKSPACE_CLIENT_BINDING } from './domain-workspace-client.ts'
import { ACCOUNT_DYNAMIC_DNS_CLIENT_BINDING } from './account-dynamic-dns-client.ts'
import { ACCT_STAGING_CLIENT_BINDING } from './acct-staging-client.ts'
import { ACCOUNT_SITE_PUBLISHER_CLIENT_BINDING } from './account-site-publisher-client.ts'
import { ACCOUNT_REVERSE_PROXY_CLIENT_BINDING } from './account-reverse-proxy-client.ts'
import { ACCOUNT_WEB_DIRECTIVES_CLIENT_BINDING } from './account-web-directives-client.ts'
import { renderAccountDomains } from './board-port/extensions/account-domains.ts'
import { renderAccountDynamicDnsWorkspace } from './board-port/account-dynamic-dns-workspace.ts'
import { renderAccountStagingWorkspace } from './board-port/acct-staging-workspace.ts'
import { renderAccountSitePublisherWorkspace } from './board-port/account-site-publisher-workspace.ts'
import { renderAccountReverseProxyWorkspace } from './board-port/account-reverse-proxy-workspace.ts'
import { renderAccountRedirectsWorkspace } from './board-port/account-web-directives-workspace.ts'
import { renderV2DomainsPage, renderV2DynamicDnsPage, renderV2StagingPage, renderV2SitePublisherPage, renderV2ReverseProxyPage, renderV2RedirectsPage } from './themes/v2/pages/xpanel/domains/index.ts'

const accountId = '11111111-1111-4111-8111-111111111111', domainId = '22222222-2222-4222-8222-222222222222'
const stamp = '2026-10-29T12:00:00.000Z', revision = 'a'.repeat(64)
const account: Account = { id: accountId, username: 'alice', uid: 20014, gid: 20014, home: '/home/alice', primaryDomain: 'example.test', planId: 'plan', ownerId: null, status: 'active', suspendReason: null, contactEmail: '', ipv4: '192.0.2.10', shell: 'none', createdAt: stamp }
const domain: Domain = { id: domainId, accountId, name: account.primaryDomain, kind: 'primary', parentId: null, docRoot: account.home + '/public_html', siteType: 'php', upstream: null, redirect: null, php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 4, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 100, processIdleTimeoutSec: 10 }, ini: {} }, wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited' }
const addon: Domain = { ...domain, id: '33333333-3333-4333-8333-333333333333', name: 'shop.example.test', kind: 'addon', docRoot: account.home + '/shop' }
const plan = defaultPlan({ id: account.planId, name: 'Standard', featureListId: 'features' })
plan.caps.addonDomains = 4; plan.caps.aliasDomains = 4; plan.caps.subdomains = 4
const authority = { canRead: true, canManage: true }
const props = { account, domains: [domain], plan }
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const domainView = (domains = [domain, addon]) => ({ context: { accountId, home: account.home }, revision, domains, limits: { addonDomains: 2, aliasDomains: 'unlimited', subdomains: 6 }, removals: domains.map(row => ({ domainId: row.id, canRemove: row.kind !== 'primary', childCount: 0, serviceUserCount: 0 })), application: { status: 'unverified', targetVerified: false } })
type TestDom = { window: Window & typeof globalThis }
const requireFromHarness = createRequire(createRequire(import.meta.url).resolve('vitest'))
const { JSDOM } = requireFromHarness('jsdom') as { JSDOM: new (html: string, options: { url: string; runScripts: 'outside-only' }) => TestDom }
const liveDoms: TestDom[] = []
const settle = async (): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
function mount(html: string, binding: string, request: (method: string, path: string, body?: unknown) => Promise<unknown>) {
  const dom = new JSDOM(html, { url: 'https://panel.example.test/', runScripts: 'outside-only' }); liveDoms.push(dom)
  Object.assign(dom.window, { msgid, msgctxt, xpT: translator('en'), xpanelSessionRequest: request })
  const boot = dom.window.Function('return ' + binding)() as (confirm: unknown) => void
  boot(async () => true)
  return { dom, document: dom.window.document, boot }
}
afterEach(() => { for (const dom of liveDoms.splice(0)) dom.window.close() })

describe.each(['classic', 'v2'] as const)('%s authenticated domain row updates', theme => {
  const v2 = theme === 'v2'
  const themed = (actual: string, classic: string) => v2 ? actual : classic
  it('keeps its domain columns and semantic quotas after reads, repeated binding and refresh', async () => {
    let current = domainView()
    const send = vi.fn(async () => clone(current))
    const html = themed(renderV2DomainsPage(props, authority), renderAccountDomains({ lang: 'en', expectedAccountId: accountId, home: account.home, canManage: true }))
    const { document, boot } = mount(html, DOMAIN_WORKSPACE_CLIENT_BINDING, send)
    await settle(); boot(async () => true); await settle()
    expect(send).toHaveBeenCalledTimes(1)
    const row = document.querySelector('[data-domain-rows] tr')!
    expect(row.children).toHaveLength(v2 ? 7 : 8)
    expect(row.querySelector('[data-xp-slot="name"]')?.textContent).toBe(account.primaryDomain)
    expect(row.querySelector('[data-xp-slot="root"]')?.textContent).toBe(domain.docRoot)
    expect(row.querySelector<HTMLButtonElement>('[data-xp-slot="remove"]')?.disabled).toBe(true)
    const label = document.querySelector('[data-domain-limits]')!
    if (v2) {
      const cards = [...label.querySelectorAll('[data-domain-limit-kind]')]
      expect(cards).toHaveLength(4); expect(cards.every(card => card.querySelector('svg'))).toBe(true)
      expect(label.querySelector('[data-domain-limit-kind="primary"] [data-domain-limit-value]')?.textContent).toBe('1')
      expect(label.querySelector('[data-domain-limit-kind="addon"] [data-domain-limit-value]')?.textContent).toBe('1')
      expect(label.querySelector('[data-domain-limit-kind="addon"] [data-domain-limit-unit]')?.textContent).toBe('/ 2')
      expect(label.querySelector<HTMLElement>('[data-domain-limit-kind="addon"] [data-domain-limit-meter]')?.style.inlineSize).toBe('50%')
      expect(label.querySelector('[data-domain-limit-kind="alias"] [data-domain-limit-unit]')?.textContent).toBe('Unlimited')
      expect(document.querySelector('[data-domain-create-review] .v2-domain-fact')).not.toBeNull()
    } else expect(label.querySelectorAll('.xp-extension__fact')).toHaveLength(3)
    current = { ...domainView([]), revision: 'b'.repeat(64) }
    document.querySelector<HTMLButtonElement>('[data-domain-refresh]')!.click(); await settle()
    expect(document.querySelector('[data-domain-rows] td')?.getAttribute('colspan')).toBe(v2 ? '7' : '8')
    expect(document.querySelector('[data-domain-count]')?.textContent).toBe('0 saved names')
    if (v2) expect(label.querySelectorAll('[data-domain-limit-kind]')).toHaveLength(4)
  })

  it('retains the dynamic DNS row skin and hostname confirmation without exposing its stored key as a reference', async () => {
    const credential = { id: 'ddns_' + 'a'.repeat(22), hostname: 'home.example.test', zone: 'example.test', type: 'A', description: 'Router & "private"', createdAt: stamp, updatedAt: stamp, lastChangedAt: null, pending: false }
    const send = vi.fn(async () => ({ context: { accountId }, revision, entries: [credential], zones: [{ name: 'example.test' }], limit: 25 }))
    const { document } = mount(themed(renderV2DynamicDnsPage(props, authority), renderAccountDynamicDnsWorkspace({ lang: 'en', accountId, canManage: true })), ACCOUNT_DYNAMIC_DNS_CLIENT_BINDING, send)
    await settle()
    const row = document.querySelector('[data-ddns-rows] tr')!
    expect(row.children).toHaveLength(6); expect(row.querySelector('[data-xp-slot="description"]')?.textContent).toBe(credential.description)
    expect(row.querySelector('private')).toBeNull(); expect(row.textContent).not.toContain(credential.id)
    const manage = row.querySelector<HTMLButtonElement>('[data-xp-slot="manage"]')!
    expect(manage.classList.contains(v2 ? 'v2-btn' : 'xp-btn')).toBe(true)
    manage.click(); expect(document.querySelector<HTMLElement>('[data-ddns-confirm]')!.hidden).toBe(false)
    expect(document.querySelector<HTMLButtonElement>('[data-ddns-delete]')!.disabled).toBe(true)
    expect(send.mock.calls).toHaveLength(1)
  })

  it('keeps staging row actions and reviewed differences in the selected theme', async () => {
    const send = vi.fn(async (method: string, path: string) => {
      if (method === 'GET') return { context: { accountId, username: account.username }, domains: [{ id: domainId, name: domain.name, kind: domain.kind }], records: [{ domainId, domain: domain.name, state: 'ready', files: 3, createdAt: stamp, createdBy: account.username, promotedAt: null }], revision, capabilities: { agent: true } }
      expect(path).toBe('/api/account/staging/' + domainId + '/review')
      return { context: { accountId, username: account.username, domainId, domain: domain.name }, live: { path: 'public_html', files: 3, bytes: 30, links: 0 }, staging: { path: 'staging/' + domain.name, exists: true, files: 3, bytes: 30, links: 0 }, rows: [{ path: 'index.html', change: 'change', bytes: 10 }], revision, limits: {} }
    })
    const { document } = mount(themed(renderV2StagingPage(props, authority), renderAccountStagingWorkspace({ lang: 'en', accountId, canManage: true })), ACCT_STAGING_CLIENT_BINDING, send)
    await settle()
    const row = document.querySelector('[data-staging-rows] tr')!
    expect(row.children).toHaveLength(7)
    expect(row.querySelector('time')?.getAttribute('datetime')).toBe(stamp)
    const review = row.querySelector<HTMLButtonElement>('[data-action="review"]')!
    expect(review.classList.contains(v2 ? 'v2-btn' : 'xp-btn')).toBe(true)
    review.click(); await settle()
    expect(document.querySelector('[data-staging-review] [data-xp-slot="path"]')?.textContent).toBe('index.html')
    expect(document.querySelector<HTMLButtonElement>('[data-staging-promote]')!.disabled).toBe(true)
    expect(send.mock.calls.map(call => call[0])).toEqual(['GET', 'POST'])
  })

  it('rejects a markup-bearing dynamic DNS description before painting any returned row', async () => {
    const send = vi.fn(async () => ({ context: { accountId }, revision, entries: [{ id: 'ddns_' + 'a'.repeat(22), hostname: 'home.example.test', zone: 'example.test', type: 'A', description: 'Router <private>', createdAt: stamp, updatedAt: stamp, lastChangedAt: null, pending: false }], zones: [{ name: 'example.test' }], limit: 25 }))
    const { document } = mount(themed(renderV2DynamicDnsPage(props, authority), renderAccountDynamicDnsWorkspace({ lang: 'en', accountId, canManage: true })), ACCOUNT_DYNAMIC_DNS_CLIENT_BINDING, send)
    await settle()
    expect(document.querySelector('[data-ddns-status]')?.getAttribute('data-state')).toBe('error')
    expect(document.querySelector('[data-ddns-rows] [data-xp-slot="hostname"]')).toBeNull()
    expect(document.querySelector<HTMLButtonElement>('[data-ddns-create]')?.disabled).toBe(true)
    expect(send.mock.calls).toHaveLength(1)
  })

  it('fills publisher file facts while keeping preview and unqualified publishing separate', async () => {
    const send = vi.fn(async () => ({ context: { accountId, domainId, domainName: domain.name, path: 'public_html' }, revision, files: ['index.html', 'index.htm', 'index.php'].map(name => ({ name, exists: false, hash: null, sizeBytes: 0 })), recovery: { status: 'none', createdAt: null }, capabilities: { canPublish: false, canRollback: false }, application: { status: 'read', nativeQualified: false } }))
    const { document } = mount(themed(renderV2SitePublisherPage(props, authority), renderAccountSitePublisherWorkspace({ lang: 'en', accountId, domains: [{ id: domainId, name: domain.name }], canManage: true })), ACCOUNT_SITE_PUBLISHER_CLIENT_BINDING, send)
    await settle()
    expect(document.querySelectorAll('[data-sitepub-files] tr')).toHaveLength(3)
    expect(document.querySelector('[data-sitepub-files] [data-xp-slot="name"]')?.textContent).toBe('index.html')
    expect(document.querySelector<HTMLButtonElement>('[data-sitepub-preview]')!.disabled).toBe(false)
    expect(document.querySelector<HTMLButtonElement>('[data-sitepub-publish]')!.disabled).toBe(true)
    expect(document.querySelector('[data-sitepub-frame]')?.getAttribute('sandbox')).toBe('')
    expect(send.mock.calls).toHaveLength(1)
  })

  it('clones reverse proxy rows and editable headers without a class from the other theme', async () => {
    const send = vi.fn(async () => domainView())
    const { document } = mount(themed(renderV2ReverseProxyPage(props, authority), renderAccountReverseProxyWorkspace({ lang: 'en', accountId, home: account.home, canManage: true })), ACCOUNT_REVERSE_PROXY_CLIENT_BINDING, send)
    await settle()
    const row = document.querySelector('[data-rp-rows] tr')!
    expect(row.children).toHaveLength(5)
    row.querySelector<HTMLButtonElement>('[data-xp-slot="configure"]')!.click()
    document.querySelector<HTMLSelectElement>('[data-rp-mode]')!.value = 'proxy'
    const change = document.createEvent('Event'); change.initEvent('change', false, false)
    document.querySelector('[data-rp-mode]')!.dispatchEvent(change)
    document.querySelector<HTMLButtonElement>('[data-rp-add-header]')!.click()
    const header = document.querySelector('[data-rp-header]')!
    expect(header.children).toHaveLength(3)
    expect(header.querySelector<HTMLInputElement>('[data-rp-header-field="name"]')?.maxLength).toBe(64)
    expect(header.querySelector('button')?.classList.contains(v2 ? 'v2-btn' : 'xp-btn')).toBe(true)
    if (v2) expect(row.querySelector('[class^="xp-"], [class*=" xp-"]')).toBeNull()
    header.querySelector<HTMLButtonElement>('button')!.click(); expect(document.querySelector('[data-rp-header]')).toBeNull()
    expect(send.mock.calls).toHaveLength(1)
  })

  it('uses the redirect adapter template for editable rows and the empty state after removal', async () => {
    const send = vi.fn(async () => ({ feature: 'redirects', context: { accountId, domainId, domainName: domain.name, path: 'public_html/.htaccess', engine: 'apache' }, document: { exists: true, revision, sizeBytes: 40, unmanagedLines: 0, managedFeatures: ['redirects'] }, managed: true, model: { entries: [{ status: 301, path: '/old', target: 'https://new.example.test/' }] }, conflict: null, capabilities: { canSave: true, reason: null }, application: { status: 'read', syntaxChecked: false, httpStatus: null, nativeQualified: false } }))
    const { document } = mount(themed(renderV2RedirectsPage(props, authority), renderAccountRedirectsWorkspace({ locale: 'en', accountId, domains: [domain], canManage: true })), ACCOUNT_WEB_DIRECTIVES_CLIENT_BINDING, send)
    await settle()
    const row = document.querySelector('[data-wd-rows] tr')!
    expect(row.children).toHaveLength(4); expect(row.querySelector('[data-xp-slot="target"]')?.textContent).toBe('https://new.example.test/')
    expect(row.querySelector('[data-xp-slot="status"]')?.tagName).toBe('BDI')
    expect(row.querySelector('[data-xp-slot="status"]')?.getAttribute('dir')).toBe('ltr')
    expect(row.querySelector('[data-xp-slot="status"]')?.textContent).toBe('301')
    const buttons = [...row.querySelectorAll<HTMLButtonElement>('button')]
    expect(buttons).toHaveLength(2); expect(buttons.every(button => button.classList.contains(v2 ? 'v2-btn' : 'xp-btn'))).toBe(true)
    buttons[1]!.click()
    expect(document.querySelector('[data-wd-rows] td')?.getAttribute('colspan')).toBe('4')
    expect(document.querySelector<HTMLButtonElement>('[data-wd-save]')!.disabled).toBe(false)
    expect(send.mock.calls).toHaveLength(1)
  })

  it('refuses missing or duplicate row templates before dispatching a domain read', () => {
    const html = themed(renderV2DomainsPage(props, authority), renderAccountDomains({ lang: 'en', expectedAccountId: accountId, home: account.home, canManage: true }))
    for (const malformed of [html.replace('data-xp-template="domain-row"', 'data-xp-template="different-row"'), html.replace('</template>', '</template><template data-xp-template="domain-row"><tr></tr></template>')]) {
      const send = vi.fn(async () => domainView())
      expect(() => mount(malformed, DOMAIN_WORKSPACE_CLIENT_BINDING, send)).toThrow('client_template_unavailable')
      expect(send).not.toHaveBeenCalled()
    }
  })
})
