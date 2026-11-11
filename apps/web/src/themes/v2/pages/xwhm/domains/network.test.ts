import { describe, expect, it } from 'vitest'
import type { Account, Domain } from '@xpanel/core'
import { parseMarkup } from '../../../../markup.ts'
import { renderV2WhmDomainsPage, renderV2WhmDnsPage, renderV2WhmDnsToolsPage, renderV2WhmDnsProvidersPage, renderV2WhmDnsClusterPage, renderV2WhmTlsPage, renderV2WhmTlsInstallPage, renderV2WhmNetworkPage, WHM_NETWORK_CSS } from './routes.ts'

const account: Account = {
  id: '10000000-0000-4000-8000-000000000001', username: 'alice', uid: 21001, gid: 21001,
  home: '/home/alice', primaryDomain: 'alice.example.test', planId: '10000000-0000-4000-8000-000000000002',
  ownerId: null, status: 'active', suspendReason: null, contactEmail: '', ipv4: '192.0.2.10', shell: 'jailed', createdAt: '2026-10-29T00:00:00Z',
}
const domain: Domain = {
  id: '10000000-0000-4000-8000-000000000003', accountId: account.id, name: account.primaryDomain,
  kind: 'primary', parentId: null, docRoot: '/home/alice/public_html', siteType: 'php', upstream: null, redirect: null,
  php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 4, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 0, processIdleTimeoutSec: 10 }, ini: {} },
  wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited',
}
const authority = { canRead: true, canManage: true }
const live = (html: string) => parseMarkup(html).filter(node => node.template === -1)

describe('independent v2 WHM domains, DNS and certificate pages', () => {
  it('dispatches exactly the 7 implemented routes without replacing other pages', () => {
    for (const route of ['/whm/domains', '/whm/dns', '/whm/dns/more', '/whm/dns/providers', '/whm/dns/cluster', '/whm/ssl', '/whm/ssl/install']) {
      expect(renderV2WhmNetworkPage({ activeRoute: route }, authority)).toContain(`data-whm-detail-route="${route}"`)
      expect(renderV2WhmNetworkPage({ activeRoute: route }, authority)).toContain('data-capability-state="authorized"')
    }
    expect(renderV2WhmNetworkPage({ activeRoute: '/whm/ssl/install/other' }, authority)).toBeUndefined()
    expect(renderV2WhmNetworkPage({ activeRoute: '/whm/accounts' }, authority)).toBeUndefined()
  })

  it('does not infer authority from supplied accounts or domain observations', () => {
    const html = renderV2WhmDomainsPage({ accounts: [account], domains: [domain] })
    expect(html).toContain('data-readonly="true"')
    expect(html).toContain('data-capability-state="unavailable"')
    expect(html).toContain('data-whm-domains-manage="false"')
    expect(html).not.toContain(domain.name)
    expect(html).not.toContain(account.home)
    expect(live(html).filter(node => ['input', 'select', 'button'].includes(node.tag)).every(node => node.attrs.has('disabled'))).toBe(true)
  })

  it('filters supplied collections to the core-authorized account set and escapes saved names', () => {
    const html = renderV2WhmDomainsPage({ accounts: [account, { ...account, id: 'foreign', username: 'other' }], domains: [{ ...domain, name: '<img src=x onerror=alert(1)>' }, { ...domain, accountId: 'foreign', name: 'foreign.example.test' }] }, { ...authority, accountIds: new Set([account.id]) })
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('foreign.example.test')
    expect(html).not.toContain('value="foreign"')
  })

  it('uses the approved 8-column domain layout and supplies its independent row template', () => {
    const nodes = parseMarkup(renderV2WhmDomainsPage({ accounts: [account], domains: [domain] }, authority))
    const tableIndex = nodes.findIndex(node => node.tag === 'table' && node.attrs.has('data-whm-filter-table'))
    const headIndex = nodes.findIndex(node => node.tag === 'thead' && node.parent === tableIndex)
    const headRow = nodes.findIndex(node => node.tag === 'tr' && node.parent === headIndex)
    expect(nodes.filter(node => node.tag === 'th' && node.parent === headRow)).toHaveLength(8)
    const template = nodes.findIndex(node => node.tag === 'template' && node.attrs.get('data-xp-template') === 'whm-domain-row')
    const row = nodes.findIndex(node => node.tag === 'tr' && node.template === template)
    expect(nodes.filter(node => node.tag === 'td' && node.parent === row)).toHaveLength(8)
    expect(nodes.find(node => node.template === template && node.attrs.get('data-xp-action') === 'open')?.tag).toBe('button')
    expect(nodes.filter(node => node.attrs.has('data-whm-filter-row')).every(node => node.tag === 'span')).toBe(true)
    for (const name of ['whm-search', 'whm-account', 'whm-ssl', 'whm-php', 'whm-page-size']) expect(nodes.some(node => node.attrs.get('name') === name)).toBe(true)
  })

  it('counts the loaded domains by kind in the tiles and filter, and says Not read without a list', () => {
    const html = renderV2WhmDomainsPage({ accounts: [account], domains: [domain, { ...domain, id: 'addon-1', name: 'shop.example.test', kind: 'addon' }] }, authority)
    expect(html).toContain('<h2>Primary domains</h2>')
    expect(html).toContain('<span>1</span><span class="v2-kpi__unit">of 2 domains</span>')
    expect(html).toContain('data-whm-kind data-kind="addon" aria-pressed="false">Addon<span class="v2-count v2-num">1</span>')
    expect(html).toContain('Hosted domains · 2')
    expect(html).toContain('href="#v2-whm-network-domain-create-heading"')
    const unread = renderV2WhmDomainsPage({ accounts: [account] }, authority)
    expect(unread.match(/<article class="v2-kpi" data-state="unread">/g)).toHaveLength(4)
    expect(unread).not.toContain('v2-count')
    expect(unread).not.toContain('of 0 domains')
  })

  it('retains native domain forms and independent guarded default-site controls', () => {
    const nodes = live(renderV2WhmDomainsPage({ accounts: [account] }, authority))
    for (const hook of ['data-whm-domain-create', 'data-whm-domain-settings', 'data-default-site-form']) expect(nodes.find(node => node.attrs.has(hook))?.tag).toBe('form')
    for (const name of ['kind', 'name', 'parentId', 'siteType', 'docRoot']) expect(nodes.some(node => node.attrs.get('name') === name)).toBe(true)
    expect(nodes.find(node => node.attrs.has('data-default-site-workspace'))?.attrs.get('data-default-site-enabled')).toBe('false')
    for (const hook of ['response', 'redirect', 'refuse-https', 'save', 'discard', 'refresh', 'requests', 'status', 'observation-status']) expect(nodes.some(node => node.attrs.has(`data-default-site-${hook}`))).toBe(true)
  })

  it('keeps the saved-zone editor closed to mutations until core grants management', () => {
    const html = renderV2WhmDnsPage({ accounts: [account] }, { canRead: true, canManage: false })
    const nodes = live(html)
    expect(nodes.find(node => node.attrs.has('data-dns-editor'))?.attrs.get('data-readonly')).toBe('true')
    for (const hook of ['zone', 'account']) expect(nodes.find(node => node.attrs.has(`data-dns-${hook}`))?.tag).toBe('select')
    expect(nodes.find(node => node.attrs.has('data-dns-records'))?.tag).toBe('tbody')
    for (const hook of ['refresh', 'add-record', 'add-zone', 'save', 'delete']) expect(nodes.find(node => node.attrs.has(`data-dns-${hook}`))?.attrs.get('type')).toBe('button')
    expect(html).toContain('SOA serials are allocated by the server.')
    expect(html).toContain('Nothing has been imported.')
  })

  it('lays the zone list, its count and the new-zone form inside the editor the controller reads', () => {
    const nodes = parseMarkup(renderV2WhmDnsPage({ accounts: [account] }, authority))
    const editor = nodes.findIndex(node => node.attrs.has('data-dns-editor'))
    const inside = (index: number): boolean => { for (let at = index; at >= 0; at = nodes[at]!.parent) if (at === editor) return true; return false }
    for (const hook of ['data-whm-dns-zone-rows', 'data-whm-dns-zone-count', 'data-dns-refresh', 'data-dns-new-name', 'data-dns-account', 'data-dns-add-zone', 'data-dns-records', 'data-dns-status']) expect(inside(nodes.findIndex(node => node.attrs.has(hook))), hook).toBe(true)
    expect(inside(nodes.findIndex(node => node.attrs.has('data-dns-file')))).toBe(false)
    expect(nodes.find(node => node.attrs.has('data-whm-dns-zone-count'))?.attrs.get('role')).toBe('status')
    expect(nodes.find(node => node.attrs.get('href') === '#v2-whm-network-dns-new-name')?.tag).toBe('a')
    expect(renderV2WhmDnsPage({ accounts: [account] }, { canRead: true, canManage: false })).not.toContain('href="#v2-whm-network-dns-new-name"')
  })

  it('uses actual API numeric bounds in its record and TTL templates', () => {
    const nodes = parseMarkup(renderV2WhmDnsPage({}, authority))
    expect(nodes.find(node => node.attrs.get('data-xp-slot') === 'ttl')?.attrs.get('max')).toBe('2147483647')
    expect(nodes.find(node => node.attrs.get('data-xp-slot') === 'priority')?.attrs.get('max')).toBe('65535')
    const tools = live(renderV2WhmDnsToolsPage({}, authority))
    const ttl = tools.find(node => node.attrs.has('data-whm-dns-tools-ttl'))!
    expect(Object.fromEntries(ttl.attrs)).toMatchObject({ min: '0', max: '2147483647', step: '1', dir: 'ltr' })
    for (const key of ['jobs', 'results', 'compare', 'nameservers', 'zones', 'preview', 'applied']) expect(tools.find(node => node.attrs.get('data-whm-dns-tools-rows') === key)?.tag).toBe('tbody')
  })

  it('keeps DNS checks read-only independently from revision-bound TTL changes', () => {
    const html = renderV2WhmDnsToolsPage({}, { canRead: true, canManage: false })
    expect(html).toContain('data-capability-state="authorized"')
    expect(html).toContain('data-dns-tools-can-read="true" data-dns-tools-can-manage="false"')
    expect(html).toContain('Up to 32 zones per change.')
    expect(html).not.toContain('Every zone ran')
    expect(live(html).find(node => node.attrs.get('data-whm-dns-tools-run') === 'apply')?.attrs.has('disabled')).toBe(true)
  })

  it.each(['en', 'ar'] as const)('keeps unavailable presentation and capability overrides authoritative in %s', { tags: ['unit'] }, locale => {
    for (const route of ['/whm/domains', '/whm/dns', '/whm/dns/more', '/whm/dns/providers', '/whm/dns/cluster', '/whm/ssl', '/whm/ssl/install']) {
      for (const html of [
        renderV2WhmNetworkPage({ activeRoute: route, locale }, { ...authority, presentation: 'read-only' }),
        renderV2WhmNetworkPage({ activeRoute: route, locale, capabilityUnavailable: true }, authority),
      ]) {
        if (html === undefined) throw new Error('Missing implemented network route')
        const root = live(html).find(node => node.attrs.get('data-whm-detail-route') === route)
        expect(root?.attrs.get('data-capability-state'), route).toBe('unavailable')
        expect(root?.attrs.get('data-readonly'), route).toBe('true')
      }
    }
  })

  it('never presets or echoes a Cloudflare secret and preserves provider isolation hooks', () => {
    const nodes = live(renderV2WhmDnsProvidersPage({}, authority))
    const token = nodes.find(node => node.attrs.get('data-sec-input') === 'token')!
    expect(Object.fromEntries(token.attrs)).toMatchObject({ type: 'password', maxlength: '40', autocomplete: 'off', disabled: '' })
    expect(token.attrs.has('value')).toBe(false)
    expect(nodes.find(node => node.attrs.has('data-sec-workspace'))?.attrs.get('data-sec-page')).toBe('dns-providers')
    for (const key of ['accounts', 'links', 'records']) expect(nodes.find(node => node.attrs.get('data-sec-rows') === key)?.tag).toBe('tbody')
  })

  it('retains saved, applied and observed cluster state as separate unread facts', () => {
    const html = renderV2WhmDnsClusterPage({}, authority)
    const nodes = live(html)
    expect(html).toContain('data-sec-page="dns-cluster"')
    for (const key of ['application', 'launch', 'primary', 'include-dir', 'axfr', 'updated', 'verify-peer', 'verify-counts', 'verify-at']) expect(nodes.some(node => node.attrs.get('data-sec-field') === key)).toBe(true)
    expect(nodes.find(node => node.attrs.get('data-sec-input') === 'peer-name')?.attrs.get('maxlength')).toBe('253')
    expect(nodes.find(node => node.attrs.get('data-sec-input') === 'peer-address')?.attrs.get('maxlength')).toBe('45')
    expect(html).not.toContain('In sync')
  })

  it('shows supplied certificate dates as saved facts without inventing renewal or served TLS', () => {
    const html = renderV2WhmTlsPage({ certificates: [{ names: ['<script>unsafe</script>'], notAfter: '2027-01-01T00:00:00Z' }] }, authority)
    expect(html).toContain('&lt;script&gt;unsafe&lt;/script&gt;')
    expect(html).not.toContain('<script>unsafe')
    expect(html).toContain('2027-01-01 00:00 UTC')
    expect(html).toContain('Stored; served TLS unverified')
    for (const hook of ['data-ssl-status', 'data-ssl-queue-status', 'data-ssl-order-log-status', 'data-ssl-management-status']) expect(html).toContain(hook)
    expect(html).not.toContain('TLS readiness reported')
  })

  it('starts private PEM controls empty and keeps structural checks separate from server verification', () => {
    const html = renderV2WhmTlsInstallPage({}, authority)
    const nodes = live(html)
    for (const key of ['certificate', 'chain', 'key']) {
      const area = nodes.find(node => node.attrs.has(`data-ssl-install-${key}`))!
      expect(area.tag).toBe('textarea')
      expect(Object.fromEntries(area.attrs)).toMatchObject({ autocomplete: 'off', spellcheck: 'false', disabled: '', dir: 'ltr' })
    }
    for (const key of ['names', 'checks', 'result', 'facts', 'choices']) expect(nodes.some(node => node.attrs.has(`data-ssl-install-${key}`))).toBe(true)
    expect(nodes.filter(node => node.attrs.has('data-ssl-install-step') && node.attrs.get('aria-current') === 'step')).toHaveLength(1)
    expect(html).toContain('These are structural checks only.')
    expect(html).not.toContain('-----BEGIN PRIVATE KEY-----')
  })

  it('keeps value direction inside fact values and scopes responsive geometry to this family', () => {
    const nodes = live(renderV2WhmDnsClusterPage({ locale: 'ar' }, authority))
    for (const value of nodes.filter(node => node.tag === 'dd')) expect(value.attrs.has('dir')).toBe(false)
    expect(WHM_NETWORK_CSS).not.toMatch(/(?:text-align|float|clear):(?:left|right)/)
    expect(WHM_NETWORK_CSS).toContain('gap:var(--space-1)')
    expect(WHM_NETWORK_CSS).toContain('@media(max-width:640px)')
    expect(renderV2WhmDnsToolsPage({ locale: 'ar' }, authority)).not.toMatch(/[٠-٩۰-۹]/)
  })
})

describe('v2 domain row repaint and DNS record filter', () => {
  it('repaints a domain row from a template with the same cell structure as the server row', () => {
    const nodes = parseMarkup(renderV2WhmDomainsPage({ accounts: [account], domains: [domain], principal: { kind: 'root', id: 'r', username: 'root' } }, authority))
    const template = nodes.findIndex(node => node.tag === 'template' && node.attrs.get('data-xp-template') === 'whm-domain-row')
    const tableIndex = nodes.findIndex(node => node.tag === 'table' && node.attrs.has('data-whm-filter-table'))
    const serverRow = nodes.findIndex(node => node.tag === 'tr' && node.template === -1 && nodes[node.parent]?.tag === 'tbody' && nodes[node.parent]?.parent === tableIndex)
    const templateRow = nodes.findIndex(node => node.tag === 'tr' && node.template === template)
    const inside = (index: number, root: number): boolean => { for (let at = nodes[index]!.parent; at >= 0; at = nodes[at]!.parent) { if (nodes[at]!.tag === 'svg' || nodes[at]!.attrs.get('class') === 'v2-menu') return false; if (at === root) return true } return false }
    // A slot span inside a span only carries the value the server row writes as text; the status pill tone follows the row state.
    const slotText = (node: (typeof nodes)[number]) => node.tag === 'span' && node.attrs.has('data-xp-slot') && nodes[node.parent]?.tag === 'span'
    const shape = (cell: number) => nodes.flatMap((node, index) => node.tag !== 'svg' && node.attrs.get('class') !== 'v2-menu' && !slotText(node) && inside(index, cell) ? [`${node.tag}.${(node.attrs.get('class') ?? '').replace(/v2-pill--[a-z]+/, 'v2-pill--tone')}`] : [])
    const cells = (row: number) => nodes.flatMap((node, index) => node.tag === 'td' && node.parent === row ? [index] : [])
    const server = cells(serverRow), painted = cells(templateRow)
    expect(painted).toHaveLength(server.length)
    // The last cell differs only by the server row's menu and its link: the client opens the editor with a button.
    for (let index = 0; index < server.length - 1; index++) expect(shape(painted[index]!)).toEqual(shape(server[index]!))
    for (const slot of ['name', 'docroot', 'kind', 'wildcard', 'account', 'ssl', 'php-version', 'php-handler', 'status', 'site-type']) expect(nodes.some(node => node.template === template && node.attrs.get('data-xp-slot') === slot)).toBe(true)
    expect(nodes.find(node => node.template === template && node.attrs.get('data-xp-action') === 'select')?.attrs.get('type')).toBe('checkbox')
  })

  it('filters loaded zone records by text and record type', () => {
    const html = renderV2WhmDnsPage({ accounts: [account] }, authority)
    expect(html).toMatch(/aria-labelledby="v2-whm-network-dns-editor-heading">.*<div class="v2-whm-network__records" data-list-filter>.*data-list-filter-search.*<select id="v2-whm-dns-record-type" data-list-filter-key="type"><option value="" selected>All<\/option><option value="A">A<\/option>/s)
    expect(html).toContain('data-list-filter-empty hidden')
    expect(html).toMatch(/<template data-xp-template="dns-record-row"><tr data-list-row>.*data-list-field="type"/s)
  })
})
