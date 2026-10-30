import { describe, expect, it } from 'vitest'
import type { Account, Certificate, Domain } from '@xpanel/core'
import { renderV2CronPage, renderV2DnsPage, renderV2PanelServicePage, renderV2TlsPage } from './index.ts'
import { technical } from './common.ts'

const account: Account = {
  id: '10000000-0000-4000-8000-000000000001', username: 'alice', uid: 20014, gid: 20014,
  home: '/home/alice', primaryDomain: 'alice.example', planId: 'plan', ownerId: null,
  status: 'active', suspendReason: null, contactEmail: '', ipv4: '192.0.2.10', shell: 'none', createdAt: '2026-10-29T00:00:00Z',
}
const domain: Domain = {
  id: '10000000-0000-4000-8000-000000000002', accountId: account.id, name: account.primaryDomain, kind: 'primary',
  parentId: null, docRoot: '/home/alice/public_html', siteType: 'php', upstream: null, redirect: null,
  php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 4, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 0, processIdleTimeoutSec: 10 }, ini: {} },
  wildcard: false, certificateId: 'cert-owned', suspended: false, expiresAt: null, pathQuotaMb: 'unlimited',
}
const certificate: Certificate = { id: 'cert-owned', accountId: account.id, names: [account.primaryDomain], source: 'acme', challenge: 'http-01', notAfter: '2027-01-01T00:00:00Z', autoRenew: true }

describe('v2 xPanel service pages', () => {
  it('dispatches only the implemented service routes without replacing unrelated pages', () => {
    expect(renderV2PanelServicePage({ account, activeRoute: '/home' })).toBeUndefined()
    expect(renderV2PanelServicePage({ account, activeRoute: '/security/ssl/issue' })).toBeUndefined()
    for (const route of ['/domains/zone-editor', '/security/ssl', '/advanced/cron']) {
      expect(renderV2PanelServicePage({ account, activeRoute: route })).toContain('data-v2-panel-service')
    }
  })

  it('requires an authorized account before emitting workspace controls or supplied collections', () => {
    for (const render of [renderV2DnsPage, renderV2TlsPage, renderV2CronPage]) {
      const html = render({ domains: [domain], certificates: [certificate] }, { canManage: true })
      expect(html).toContain('role="alert"')
      expect(html).not.toContain(account.primaryDomain)
      expect(html).not.toContain('data-v2-panel-service')
    }
  })

  it('does not grant DNS management from a populated account or expose a foreign domain', () => {
    const html = renderV2DnsPage({ account, domains: [domain, { ...domain, id: 'foreign', accountId: 'other', name: 'foreign.example' }], activeDomain: 'foreign.example' })
    expect(html).toContain('data-readonly="true"')
    expect(html).toContain(`<option value="${domain.name}" selected>`)
    expect(html).not.toContain('foreign.example')
    expect(html).toContain('data-dns-status data-state="unread"')
  })

  it('keeps zone editor hooks available while waiting for the authoritative API read', () => {
    const html = renderV2DnsPage({ account, domains: [domain] }, { canManage: true })
    for (const hook of ['editor', 'zone', 'account', 'new-name', 'records', 'status', 'add-record', 'add-zone', 'save', 'delete']) expect(html).toContain(`data-dns-${hook}`)
    expect(html).not.toContain('data-readonly="true"')
    expect(html).toContain('Serving state not read')
    expect(html).not.toContain('In sync')
    expect(html).not.toContain('Passing')
  })

  it('filters foreign TLS records and never exposes internal certificate references as text', () => {
    const html = renderV2TlsPage({ account, domains: [domain], certificates: [certificate, { ...certificate, id: 'foreign-cert', accountId: 'other', names: ['foreign.example'] }] }, { canManage: true })
    expect(html).toContain(account.primaryDomain)
    expect(html).not.toContain('foreign.example')
    expect(html).not.toContain('cert-owned')
    expect(html).not.toContain('foreign-cert')
    expect(html).toContain('Requested')
    expect(html).toContain('AutoSSL not read')
  })

  it('escapes stored certificate names and keeps private-key inputs empty until user entry', () => {
    const html = renderV2TlsPage({ account, domains: [domain], certificates: [{ ...certificate, names: ['<img src=x onerror=alert(1)>'] }] })
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('<img src=x')
    expect(html).toMatch(/<textarea[^>]*data-account-ssl-key disabled><\/textarea>/)
    expect(html).toContain('data-ssl-can-manage="false"')
    expect(html).toMatch(/<form[^>]*data-certificate-form[\s\S]*?<fieldset disabled>/)
  })

  it('keeps certificate controls complete even before domains are returned', () => {
    const html = renderV2TlsPage({ account }, { canManage: true })
    for (const hook of ['rows', 'status', 'autossl', 'autossl-chip', 'domain', 'key', 'cert', 'bundle', 'install', 'detail', 'facts']) expect(html).toContain(`data-account-ssl-${hook}`)
    expect(html).toContain('data-ssl-can-manage="false"')
    expect(html).toContain('Stored certificates have not been read.')
    expect(html).not.toContain('value="0"')
  })

  it('keeps cron fields and real action hooks without inventing jobs or run outcomes', () => {
    const html = renderV2CronPage({ account }, { canManage: true })
    for (const hook of ['minute', 'hour', 'day', 'month', 'weekday', 'command', 'comment', 'runtime']) expect(html).toContain(`data-cron-field="${hook}"`)
    for (const hook of ['refresh', 'new', 'save', 'reset', 'run', 'observe', 'capacity', 'preview', 'preview-state', 'username', 'home', 'enabled', 'unlimited', 'preset']) expect(html).toContain(`data-cron-${hook}`)
    expect(html).toContain('data-cron-manage="true"')
    expect(html).toContain('The scheduled job list has not been read.')
    expect(html).not.toContain('timers active')
    expect(html).not.toContain('Succeeded')
    expect(html).toMatch(/<textarea[^>]*data-cron-field="command"[^>]*maxlength="4096"[^>]*disabled>/)
  })

  it('defaults cron authority to read only and keeps unconnected output mail disabled', () => {
    const html = renderV2CronPage({ account })
    expect(html).toContain('data-cron-manage="false"')
    expect(html).toMatch(/data-cron-refresh disabled/)
    expect(html).toMatch(/id="v2-cron-mailto"[^>]* disabled/)
    expect(html).toContain('Output email is unavailable; no delivery setting is saved from this control.')
  })

  it('isolates technical text and normalizes digit glyphs without changing the number', () => {
    expect(technical('\u0662\u0660\u0662\u0666-\u06f1\u06f0-29')).toBe('<bdi dir="ltr" class="v2-mono">2026-10-29</bdi>')
  })
})
