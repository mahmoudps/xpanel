import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import type { Domain } from '@xpanel/core'
import { renderPanelSurface, type PanelSurfaceProps } from '../surfaces/xpanel.ts'
import { STORE_CSS } from './styles.ts'
import { renderAccountStore, PANEL_STORE_ROUTES } from './panel-store.ts'

const domain: Domain = {
  id: 'domain-1', accountId: 'account-1', name: 'alice-shop.com', kind: 'primary', parentId: null,
  docRoot: '/home/alice/public_html', siteType: 'php', upstream: null, redirect: null,
  php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 4, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 500, processIdleTimeoutSec: 10 }, ini: {} },
  wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited',
}

const account = {
  id: 'account-1', username: 'alice', uid: 20014, gid: 20014, home: '/home/alice', primaryDomain: 'alice-shop.com',
  planId: 'plan-1', ownerId: null, status: 'active' as const, suspendReason: null, contactEmail: 'owner@alice-shop.com',
  ipv4: '10.0.0.21', ipv6: null, shell: 'jailed' as const, createdAt: '2026-10-22T14:05:00Z',
}

const panel = (route: string, locale: 'en' | 'ar' = 'en', domains: Domain[] = [domain]): string =>
  renderPanelSurface({ account, domains, locale, activeRoute: route } as PanelSurfaceProps)

const storeMarkup = (html: string): string => html.replace(/<style id="xp-store-styles">[\s\S]*?<\/style>/, '')

describe('account app store', () => {
  it('renders every store screen in English and Arabic without a fake catalog', () => {
    for (const route of PANEL_STORE_ROUTES) {
      for (const locale of ['en', 'ar'] as const) {
        const html = storeMarkup(panel(route, locale))
        assert.match(html, /data-store-screen="[^"]+"/)
        assert.equal(html.match(/<h1\b/g)?.length, 1)
        assert.doesNotMatch(html, /wordpress|softaculous|installatron|v1\.4\.2/i)
        assert.doesNotMatch(html, /aria-valuenow/)
        assert.match(html, locale === 'ar' ? /قيد التفعيل/ : /Coming soon/)
        assert.match(html, /data-wiring="soon"/)
      }
    }
  })

  it('binds a real domain on the install screen and leaves the catalog empty', () => {
    const html = panel('/software/store/install')
    assert.match(html, /<select id="store-domain"[^>]*>[\s\S]*alice-shop\.com/)
    assert.match(html, /data-store-install="true"/)
    assert.match(html, /disabled data-wiring="soon"/)
    const emptySelect = panel('/software/store/install', 'en', []).match(/<select id="store-domain"[\s\S]*?<\/select>/)?.[0] ?? ''
    assert.match(emptySelect, /No domain was read/)
    assert.doesNotMatch(emptySelect, /alice-shop\.com/)
    assert.match(panel('/software/store'), /The signed catalog was not read/)
    assert.match(panel('/software/store/installed'), /No installed application was read/)
    assert.match(panel('/software/store/updates'), /No update was read/)
    const progress = storeMarkup(panel('/software/store/progress'))
    assert.match(progress, /data-progress="idle"/)
    assert.doesNotMatch(progress, /data-progress="indeterminate"/)
    assert.match(panel('/software/store/error'), /The installer is not connected/)
  })

  it('keeps determinate motion on inline size and shimmer on the indeterminate state', () => {
    assert.match(STORE_CSS, /transition:\s*inline-size/)
    assert.match(STORE_CSS, /\[data-progress="indeterminate"\]/)
    assert.match(STORE_CSS, /xp-shimmer/)
    assert.match(STORE_CSS, /prefers-reduced-motion:\s*reduce/)
    assert.match(STORE_CSS, /animation:\s*none/)
    const html = storeMarkup(renderAccountStore({ locale: 'en', route: '/software/store/progress', domains: [] }))
    assert.match(html, /data-progress="idle"/)
    assert.doesNotMatch(html, /aria-valuenow/)
  })
})
