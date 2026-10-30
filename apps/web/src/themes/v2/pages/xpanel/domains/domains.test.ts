import { describe, expect, it } from 'vitest'
import { defaultPlan, type Account, type Domain } from '@xpanel/core'
import { parseMarkup } from '../../../../markup.ts'
import { icon } from '../../../icons.ts'
import { renderV2CloudflarePage, renderV2DomainPage, renderV2DomainsPage, renderV2DynamicDnsPage, renderV2RedirectsPage, renderV2ReverseProxyPage, renderV2SitePublisherPage, renderV2StagingPage } from './index.ts'

const account: Account = {
  id: '10000000-0000-4000-8000-000000000001', username: 'alice', uid: 20014, gid: 20014,
  home: '/home/alice', primaryDomain: 'alice.example', planId: 'plan', ownerId: null,
  status: 'active', suspendReason: null, contactEmail: '', ipv4: '192.0.2.10', shell: 'none', createdAt: '2026-10-29T00:00:00Z',
}
const domain: Domain = {
  id: '10000000-0000-4000-8000-000000000002', accountId: account.id, name: account.primaryDomain, kind: 'primary',
  parentId: null, docRoot: '/home/alice/public_html', siteType: 'php', upstream: null, redirect: null,
  php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 4, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 0, processIdleTimeoutSec: 10 }, ini: {} },
  wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited',
}
const authority = { canRead: true, canManage: true }
const props = { account, domains: [domain] }
const renderers = [renderV2DomainsPage, renderV2ReverseProxyPage, renderV2StagingPage, renderV2DynamicDnsPage, renderV2SitePublisherPage, renderV2RedirectsPage, renderV2CloudflarePage]


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

describe('v2 account domain workflows', () => {
  it('renders the approved branch and link paths as decorative icons without mirroring identity symbols', () => {
    const branch = 'M6 4v10a4 4 0 0 0 4 4h8M15 15l3 3-3 3'
    const link = 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'
    for (const [name, path] of [['branch', branch], ['link', link]] as const) {
      const html = icon(name, 16)
      const svg = parseMarkup(html).find(node => node.tag === 'svg')!
      expect(Object.fromEntries(svg.attrs)).toMatchObject({ 'aria-hidden': 'true', focusable: 'false', width: '16', height: '16', viewbox: '0 0 24 24' })
      expect(html).toContain(`<path d="${path}"/>`)
      expect(svg.attrs.get('class')).toBe('v2-icon')
      expect(renderV2DomainsPage(props, authority)).toContain(`<path d="${path}"/>`)
    }
    expect(icon('arrow')).toContain('class="v2-icon v2-flip"')
  })

  it('dispatches only the 7 implemented catalog routes without inventing a create route or qualifying unavailable pages', () => {
    for (const route of ['/domains', '/domains/staging', '/domains/redirects', '/domains/reverse-proxy', '/domains/dynamic-dns', '/domains/cloudflare', '/domains/site-publisher']) {
      expect(renderV2DomainPage({ ...props, activeRoute: route }, authority), route).toContain('v2-domain-page')
    }
    for (const route of ['/domains/new', '/domains/add', '/domains/site-settings', '/domains/zone-editor', '/security/ssl', '/software/htaccess']) {
      expect(renderV2DomainPage({ ...props, activeRoute: route }, authority), route).toBeUndefined()
    }
  })

  it('fails closed before exposing account data or workspace controls when read authority is absent', () => {
    for (const render of renderers) {
      const html = render(props)
      assertUnknownWorkspace(html)
      expect(html).not.toContain(account.id)
      expect(html).not.toContain(account.primaryDomain)
      expect(html).not.toContain(account.home)
      expect(html).toContain('v2-card')
    }
  })

  it('filters foreign domains even when selected by name and never renders internal IDs as public references', () => {
    const foreign = { ...domain, id: 'private-foreign-domain', accountId: 'another-account', name: 'foreign.example', docRoot: '/home/foreign/site' }
    for (const render of [renderV2DomainsPage, renderV2SitePublisherPage, renderV2RedirectsPage]) {
      const html = render({ ...props, domains: [domain, foreign], activeDomain: foreign.name }, authority)
      expect(html).not.toContain(foreign.name)
      expect(html).not.toContain(foreign.docRoot)
      expect(html).not.toContain(`>${domain.id}<`)
      expect(html).not.toContain(`>${account.id}<`)
    }
  })

  it('keeps an unread domain collection distinct from a successfully read empty collection', () => {
    const unread = renderV2DomainsPage({ account }, authority)
    const empty = renderV2DomainsPage({ account, domains: [] }, authority)
    expect(unread).toContain('<p data-domain-count>Not read</p>')
    expect(unread).not.toContain('No domains were returned.')
    expect(empty).toContain('<p data-domain-count>0</p>')
    expect(empty).toContain('No domains were returned.')
  })

  it('uses only the stored plan belonging to this account and does not invent a primary or quota observation', () => {
    const plan = defaultPlan({ id: 'foreign-plan', name: 'Foreign plan', featureListId: 'features' })
    plan.caps.addonDomains = 979999
    const html = renderV2DomainsPage({ ...props, plan }, authority)
    expect(html).not.toContain('979999')
    expect(html).not.toContain('Foreign plan')
    expect(html).toContain('The plan has not been read.')
    const empty = renderV2DomainsPage({ account, domains: [] }, authority)
    const nodes = parseMarkup(empty)
    expect(nodes.filter(node => node.attrs.has('data-domain-limit-kind')).map(node => node.attrs.get('data-domain-limit-kind'))).toEqual(['primary', 'addon', 'subdomain', 'alias'])
    const values = [...empty.matchAll(/<span\b[^>]*\bdata-domain-limit-value(?:\s[^>]*)?>([^<]*)<\/span>/g)].map(match => match[1])
    expect(values).toEqual(['0', '0', '0', '0'])
    for (const meter of nodes.filter(node => node.attrs.has('data-domain-limit-meter'))) {
      expect(meter.attrs.get('style')).toBe('inline-size:0%')
      expect(nodes[meter.parent]?.attrs.has('hidden')).toBe(true)
    }
  })

  it('keeps the approved domain and document-root hierarchy while exposing the real inline create and settings hooks', () => {
    const html = renderV2DomainsPage(props, authority)
    const nodes = parseMarkup(html)
    const table = nodes.find(node => node.attrs.has('data-domain-table'))!
    expect(table.tag).toBe('table')
    expect(nodes.filter(node => node.tag === 'th')).toHaveLength(7)
    expect(html).toContain('<strong><bdi dir="ltr">alice.example</bdi></strong><span><bdi dir="ltr">/home/alice/public_html</bdi></span>')
    for (const name of ['kind', 'name', 'parentId', 'docRoot', 'siteType']) expect(html).toContain(`name="${name}"`)
    expect(nodes.find(node => node.attrs.has('data-domain-create'))?.tag).toBe('form')
    expect(nodes.find(node => node.attrs.has('data-domain-settings-form'))?.tag).toBe('form')
    expect(nodes.find(node => node.attrs.has('data-domain-create-submit'))?.attrs.has('disabled')).toBe(true)
    expect(html).toContain('data-domain-primary-rename')
    expect(html).toContain('Serving, DNS and TLS have not been verified.')
    expect(html).not.toContain('nginx -t passed')
  })

  it('retains read-only domain refresh without granting mutations and closes suspended account writes', () => {
    const readOnly = parseMarkup(renderV2DomainsPage(props, { canRead: true, canManage: false }))
    expect(readOnly.find(node => node.attrs.has('data-domain-workspace'))?.attrs.get('data-domain-manage')).toBe('false')
    expect(readOnly.find(node => node.attrs.has('data-domain-refresh'))?.attrs.has('disabled')).toBe(false)
    expect(readOnly.find(node => node.attrs.has('data-domain-create-submit'))?.attrs.has('disabled')).toBe(true)
    expect(renderV2DomainsPage({ ...props, account: { ...account, status: 'suspended' } }, authority)).toContain('data-domain-manage="false"')
  })

  it('preserves reverse-proxy native constraints and keeps upstream error first in the controller scope', () => {
    const nodes = parseMarkup(renderV2ReverseProxyPage(props, authority))
    const firstError = nodes.find(node => node.attrs.has('data-rp-error'))!
    expect(firstError.attrs.has('data-rp-headers-error')).toBe(false)
    expect(nodes.find(node => node.attrs.has('data-rp-headers-error'))?.attrs.has('data-rp-error')).toBe(true)
    expect(Object.fromEntries(nodes.find(node => node.attrs.has('data-rp-upstream'))!.attrs)).toMatchObject({ type: 'text', dir: 'ltr', maxlength: '512', disabled: '' })
    expect(nodes.find(node => node.attrs.has('data-rp-mode'))?.tag).toBe('select')
    expect(nodes.find(node => node.attrs.has('data-rp-header-rows'))?.tag).toBe('tbody')
    expect(nodes.find(node => node.attrs.has('data-rp-websocket'))?.attrs.get('type')).toBe('checkbox')
    expect(nodes.find(node => node.attrs.has('data-rp-save'))?.attrs.has('disabled')).toBe(true)
  })

  it('does not mount staging writes until a real review and acknowledgment exists', () => {
    const html = renderV2StagingPage(props, authority)
    const nodes = parseMarkup(html)
    expect(Object.fromEntries(nodes.find(node => node.attrs.has('data-staging-ack'))!.attrs)).toMatchObject({ type: 'checkbox', disabled: '' })
    expect(nodes.find(node => node.attrs.has('data-staging-promote'))?.attrs.has('disabled')).toBe(true)
    expect(nodes.find(node => node.attrs.has('data-staging-review'))?.tag).toBe('tbody')
    expect(nodes.find(node => node.attrs.has('data-staging-results'))?.tag).toBe('tbody')
    expect(html).toContain('Databases are not copied')
    expect(html).toContain('No changes have been reviewed.')
    expect(html).toContain('No change has run.')
  })

  it('keeps dynamic DNS secrets empty and hidden before a real one-time issue', () => {
    const nodes = parseMarkup(renderV2DynamicDnsPage(props, authority))
    expect(nodes.find(node => node.attrs.has('data-ddns-issued'))?.attrs.has('hidden')).toBe(true)
    expect(nodes.find(node => node.attrs.has('data-ddns-confirm'))?.attrs.has('hidden')).toBe(true)
    expect(nodes.find(node => node.attrs.has('data-ddns-hostname'))?.attrs.get('maxlength')).toBe('253')
    expect(nodes.find(node => node.attrs.has('data-ddns-description'))?.attrs.get('maxlength')).toBe('200')
    for (const hook of ['rotate', 'delete', 'copy', 'hide', 'username', 'secret', 'endpoint']) expect(nodes.some(node => node.attrs.has(`data-ddns-${hook}`)), hook).toBe(true)
    expect(renderV2DynamicDnsPage(props, { canRead: true, canManage: false })).toContain('data-ddns-manage="false"')
  })

  it('isolates the publisher preview and preserves disabled publish and rollback until verified capabilities', () => {
    const nodes = parseMarkup(renderV2SitePublisherPage(props, authority))
    const frame = nodes.find(node => node.attrs.has('data-sitepub-frame'))!
    expect(frame.tag).toBe('iframe')
    expect(Object.fromEntries(frame.attrs)).toMatchObject({ sandbox: '', referrerpolicy: 'no-referrer', hidden: '' })
    expect(frame.attrs.has('srcdoc')).toBe(false)
    for (const hook of ['publish', 'rollback']) expect(nodes.find(node => node.attrs.has(`data-sitepub-${hook}`))?.attrs.has('disabled')).toBe(true)
    expect(nodes.find(node => node.attrs.has('data-sitepub-message'))?.attrs.get('maxlength')).toBe('2000')
    expect(nodes.find(node => node.attrs.has('data-sitepub-domain'))?.tag).toBe('select')
  })

  it('preserves redirect draft validation and validation-on-save without inventing a separate test endpoint', () => {
    const html = renderV2RedirectsPage(props, authority)
    const nodes = parseMarkup(html)
    expect(nodes.find(node => node.attrs.get('data-wd-field') === 'status')?.tag).toBe('select')
    expect(nodes.find(node => node.attrs.get('data-wd-field') === 'path')?.attrs.get('maxlength')).toBe('512')
    expect(nodes.find(node => node.attrs.get('data-wd-field') === 'target')?.attrs.get('maxlength')).toBe('2048')
    for (const key of ['status', 'path', 'target']) expect(nodes.some(node => node.attrs.get('data-wd-error-for') === key)).toBe(true)
    expect(nodes.find(node => node.attrs.has('data-wd-save'))?.attrs.has('disabled')).toBe(true)
    expect(html).toContain('A failed check restores the kept file.')
    expect(html).not.toContain('data-wd-test')
  })

  it('keeps Cloudflare account scope separate from administrative token and provider setup', () => {
    const html = renderV2CloudflarePage(props, { canRead: true, canManage: false })
    const nodes = parseMarkup(html)
    expect(html).toContain('data-sec-page="account-cloudflare" data-sec-can-read="true" data-sec-can-manage="false"')
    expect(nodes.find(node => node.attrs.get('data-sec-action') === 'refresh')?.attrs.has('disabled')).toBe(false)
    expect(nodes.find(node => node.attrs.has('data-sec-zone-truncated'))?.attrs.has('hidden')).toBe(true)
    expect(nodes.filter(node => node.attrs.has('data-sec-rows')).map(node => node.attrs.get('data-sec-rows'))).toEqual(['domains', 'records'])
    expect(html).not.toContain('type="password"')
    expect(html).not.toContain('data-sec-input="token"')
    expect(html).not.toContain('data-sec-action="connect"')
  })

  it('escapes supplied domain names and paths without making an HTML-valued view model', () => {
    const html = renderV2DomainsPage({ account, domains: [{ ...domain, name: '<img src=x onerror=alert(1)>', docRoot: '/home/alice/<script>bad()</script>' }] }, authority)
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;')
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('<script>bad()')
  })

  it('keeps technical fact values isolated inline under their labels in Arabic', () => {
    const html = renderV2ReverseProxyPage({ ...props, locale: 'ar' }, authority)
    const nodes = parseMarkup(html)
    expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
    for (const value of nodes.filter(node => node.tag === 'dd')) expect(value.attrs.has('dir')).toBe(false)
    expect(nodes.find(node => node.attrs.has('data-rp-root'))?.attrs.get('dir')).toBe('ltr')
    expect(nodes.find(node => node.attrs.has('data-rp-selected'))?.attrs.get('dir')).toBe('ltr')
  })
})
