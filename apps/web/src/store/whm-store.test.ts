import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { defaultPlan, type AuditEntry, type Plan } from '@xpanel/core'
import { getSurfacePageTitle, resolveSurfaceSection } from '../shell.ts'
import { renderWhmSurface, type WhmSurfaceProps } from '../surfaces/xwhm.ts'
import { STORE_CSS } from './styles.ts'
import { renderRootStore, WHM_STORE_ROUTES } from './whm-store.ts'

const plan: Plan = defaultPlan({ id: 'plan-1', name: 'Starter', featureListId: 'features-1' })
const audit: AuditEntry = {
  id: 'fixture-audit', at: '2026-10-22T14:05:00Z', actor: 'synthetic-root',
  action: 'service_user.deleted', target: 'Synthetic target', detail: {}, outcome: 'ok',
}
const principal = { kind: 'root' as const, id: 'fixture-root', username: 'operator' }

const whm = (route: string, locale: 'en' | 'ar' = 'en', plans: Plan[] = [plan]): string =>
  renderWhmSurface({ principal, plans, auditEntries: [audit], locale, activeRoute: route, hostname: 'srv1.xpanel.test' } as WhmSurfaceProps)

const storeMarkup = (html: string): string => html.replace(/<style id="xp-store-styles">[\s\S]*?<\/style>/, '')

describe('root app store', () => {
  it('renders every root store screen in English and Arabic without a fake catalog', () => {
    for (const route of WHM_STORE_ROUTES) {
      assert.equal(resolveSurfaceSection('xwhm', route), 'store')
      for (const locale of ['en', 'ar'] as const) {
        const html = storeMarkup(whm(route, locale))
        assert.equal(getSurfacePageTitle('xwhm', 'store', locale, route).length > 0, true)
        assert.match(html, /data-store="root"/)
        assert.equal(html.match(/<h1\b/g)?.length, 1)
        assert.doesNotMatch(html, /wordpress|softaculous|installatron|v1\.4\.2|service_user\.deleted|sha256|BEGIN PRIVATE/i)
        assert.doesNotMatch(html, /aria-valuenow/)
        assert.match(html, locale === 'ar' ? /قيد التفعيل/ : /Coming soon/)
        assert.match(html, /data-wiring="soon"/)
      }
    }
  })

  it('shows a real plan name and leaves keys, sources, and installer activity unread', () => {
    const catalog = storeMarkup(whm('/whm/software/store'))
    assert.match(catalog, /Starter/)
    assert.match(catalog, /Not read/)
    assert.doesNotMatch(catalog, /features-1/)
    assert.match(catalog, /No catalog source was read/)
    assert.match(catalog, /No application was read/)
    assert.match(catalog, /Private keys stay off this screen/)
    assert.match(catalog, /The installer is not connected/)
    const empty = storeMarkup(whm('/whm/software/store', 'en', []))
    assert.match(empty, /No plan was read/)
    assert.doesNotMatch(empty, /Starter/)
    const extensions = storeMarkup(whm('/whm/software/store/extensions'))
    assert.match(extensions, /No extension was read/)
    assert.match(extensions, /data-progress="idle"/)
    assert.doesNotMatch(extensions, /data-progress="indeterminate"/)
    assert.match(storeMarkup(whm('/whm/software/store/activity')), /No installer activity was read/)
  })

  it('keeps determinate motion on inline size and shimmer on the indeterminate state', () => {
    assert.match(STORE_CSS, /transition:\s*inline-size/)
    assert.match(STORE_CSS, /\[data-progress="indeterminate"\]/)
    assert.match(STORE_CSS, /xp-shimmer/)
    assert.match(STORE_CSS, /prefers-reduced-motion:\s*reduce/)
    assert.match(STORE_CSS, /animation:\s*none/)
    const html = storeMarkup(renderRootStore({ locale: 'en', route: '/whm/software/store/extensions', plans: [] }))
    assert.match(html, /data-progress="idle"/)
    assert.doesNotMatch(html, /aria-valuenow/)
  })
})
