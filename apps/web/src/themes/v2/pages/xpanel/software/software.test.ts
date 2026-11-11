import { describe, expect, it } from 'vitest'
import type { Account, Domain } from '@xpanel/core'
import { parseMarkup } from '../../../../markup.ts'
import { renderV2PanelStorePage, V2_PANEL_STORE_ROUTES } from '../store/index.ts'
import { PANEL_HTACCESS_CSS, renderV2PanelHtaccessPage } from './htaccess.ts'
import { renderV2PanelPhpPage } from './php.ts'
import { PANEL_SOFTWARE_PAGES_CSS, PANEL_SOFTWARE_PAGES_ROUTES } from './styles.ts'

const account: Account = {
  id: '10000000-0000-4000-8000-000000000001', username: 'alice', uid: 20014, gid: 20014,
  home: '/home/alice', primaryDomain: 'alice.example', planId: 'plan', ownerId: null, status: 'active',
  suspendReason: null, contactEmail: '', ipv4: '192.0.2.10', shell: 'jailed', createdAt: '2026-10-29T00:00:00Z',
}
const domain: Domain = {
  id: '10000000-0000-4000-8000-000000000002', accountId: account.id, name: account.primaryDomain, kind: 'primary',
  parentId: null, docRoot: '/home/alice/public_html', siteType: 'php', upstream: null, redirect: null,
  php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 4, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 500, processIdleTimeoutSec: 10 }, ini: { memory_limit: '256M' } },
  wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited',
}
const props = { account, domains: [domain] }
const manage = { canRead: true, canManage: true }
const pageClasses = (html: string, prefix: RegExp) => new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap(match => match[1]!.split(/\s+/)).filter(name => prefix.test(name)))

describe('V2 account PHP page', () => {
  it('shows the stored runtime in the status strip and keeps the select-bound form fields', () => {
    const html = renderV2PanelPhpPage({ ...props, activeRoute: '/software/php' }, manage)
    const nodes = parseMarkup(html)
    expect(html).toContain('PHP 8.3 · PHP-FPM')
    expect(html).toContain('data-domain-php-form')
    expect(html).toContain('data-domain-php-status')
    for (const name of ['domainId', 'version', 'handler', 'fpm.mode', 'fpm.maxChildren', 'fpm.processIdleTimeoutSec', 'ini.memory_limit', 'ini.max_execution_time']) {
      const control = nodes.find(node => node.attrs.get('name') === name)
      expect(control, name).toBeDefined()
      expect(control!.attrs.has('disabled'), name).toBe(false)
      expect(['input', 'select'], name).toContain(control!.tag)
    }
    expect(nodes.find(node => node.attrs.get('name') === 'ini.memory_limit')!.attrs.get('value')).toBe('256M')
  })

  it('groups the settings in three tab panels with the pool selected', () => {
    const nodes = parseMarkup(renderV2PanelPhpPage(props, manage))
    const tabs = nodes.filter(node => node.attrs.get('role') === 'tab')
    expect(tabs.map(tab => tab.attrs.get('data-presentation-tab'))).toEqual(['runtime', 'pool', 'ini'])
    expect(tabs.map(tab => tab.attrs.get('aria-selected'))).toEqual(['false', 'true', 'false'])
    const panels = nodes.filter(node => node.attrs.get('role') === 'tabpanel')
    expect(panels.map(panel => panel.attrs.has('hidden'))).toEqual([true, false, true])
    for (const tab of tabs) expect(panels.some(panel => panel.attrs.get('id') === tab.attrs.get('aria-controls') && panel.attrs.get('aria-labelledby') === tab.attrs.get('id'))).toBe(true)
  })

  it('marks the saved handler and compares saved values with an unread running state', () => {
    const html = renderV2PanelPhpPage(props, manage)
    expect(html).toMatch(/<li data-current="true"><strong>PHP-FPM<\/strong>/)
    expect(html).toMatch(/<li data-offered="false"><strong>suPHP<\/strong>/)
    expect(html).toMatch(/<th scope="row"><bdi dir="ltr" class="v2-mono">pm\.max_children<\/bdi><\/th><td><bdi dir="ltr" class="v2-mono">4<\/bdi><\/td><td>Not read<\/td>/)
  })

  it('shows no account or domain value without a readable account', () => {
    const html = renderV2PanelPhpPage(props)
    for (const value of [account.username, domain.name, domain.id, '256M', 'PHP 8.3']) expect(html, value).not.toContain(value)
    expect(html).toContain('data-readonly="true"')
    expect(html).not.toContain('data-current="true"')
    const submit = parseMarkup(html).find(node => node.tag === 'button' && node.attrs.get('type') === 'submit')!
    expect(submit.attrs.has('disabled')).toBe(true)
  })
})

describe('V2 account software page styles', () => {
  it('styles every page class of the PHP page and lists the routes that need the sheet', () => {
    const classes = pageClasses(renderV2PanelPhpPage(props, manage), /^v2-panel-php/)
    expect(classes.size).toBeGreaterThan(8)
    for (const name of classes) expect(PANEL_SOFTWARE_PAGES_CSS, name).toContain(`.${name}`)
    expect(PANEL_SOFTWARE_PAGES_ROUTES).toEqual(['/software/php', '/software/optimize', ...V2_PANEL_STORE_ROUTES])
  })

  it('opens a closed tab panel that holds an invalid field and marks each of the three tabs', () => {
    expect(PANEL_SOFTWARE_PAGES_CSS).toContain('.v2-panel-php-tabs>.v2-tabpanel[hidden]:has(:invalid){display:flex!important')
    const html = renderV2PanelPhpPage(props, manage)
    for (const key of ['runtime', 'pool', 'ini']) {
      expect(html).toContain(`id="v2-php-${key}"`)
      expect(PANEL_SOFTWARE_PAGES_CSS).toContain(`:has(#v2-php-${key} :invalid) #v2-php-tab-${key}`)
    }
  })

  it('keeps the .htaccess save controls in the apply bar and styles its page classes', () => {
    const html = renderV2PanelHtaccessPage({ ...props, activeRoute: '/software/htaccess' }, manage)
    expect(html).toMatch(/<section class="v2-card v2-panel-ht-apply"[^>]*><p role="status" data-state="unread" data-htaccess-status[^>]*>[^<]+<\/p><div class="v2-panel-settings__actions"><button[^>]*data-htaccess-discard[^>]*>[^<]+<\/button><button[^>]*data-htaccess-save[^>]*>/)
    const classes = pageClasses(html, /^v2-panel-ht-/)
    expect(classes.size).toBeGreaterThan(4)
    for (const name of classes) expect(PANEL_HTACCESS_CSS, name).toContain(`.${name}`)
    expect(renderV2PanelHtaccessPage(props)).not.toContain(domain.name)
  })

  it('renders every store route and no other route', () => {
    for (const route of V2_PANEL_STORE_ROUTES) expect(renderV2PanelStorePage({ ...props, activeRoute: route }, manage), route).toContain(`data-v2-settings-route="${route}"`)
    expect(renderV2PanelStorePage({ ...props, activeRoute: '/software/php' }, manage)).toBeUndefined()
  })
})
