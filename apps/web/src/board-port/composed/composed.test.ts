import { describe, expect, it } from 'vitest'
import { defaultPlan, type Account, type Principal, type Reseller, type ResellerAcl } from '@xpanel/core'
import { composedRouteSpecs, composedXpanelRoutes, nativeComposedRoutePaths } from './all.ts'
import { renderComposedRoutes, renderComposedXpanel } from './render.ts'
import { approvedXpanelWorkspaceRoutes } from '../approved-xpanel-workspaces.ts'
import { renderWhmDetailPage } from '../approved-xwhm.ts'
import type { ComposedContext } from './context.ts'

const plan = defaultPlan({ id: 'plan-internal', name: 'Standard', featureListId: 'features-internal' })
const account: Account = { id: 'account-internal', username: 'alpha', uid: 20001, gid: 20001, home: '/home/alpha', primaryDomain: 'alpha.example.test', ownerId: 'reseller-internal', planId: plan.id, status: 'active', suspendReason: null, contactEmail: '', ipv4: '192.0.2.1', shell: 'none', createdAt: '2026-10-24T00:00:00Z' }
const reseller: Reseller = { id: 'reseller-internal', username: 'reseller-alpha', acl: ['list-accounts'], maxAccounts: 8, totalDiskMb: 1024, totalBandwidthMb: 2048, oversell: { disk: false, bandwidth: false }, nameservers: [], delegatedIps: [] }
const owner: ComposedContext = { locale: 'en', route: '/server-information', principal: { kind: 'user', id: 'user-internal', username: 'alpha', accountId: account.id }, account, plan }
const root: ComposedContext = { locale: 'en', route: '/whm/accounts/health', principal: { kind: 'root', id: 'root-internal', username: 'root' } }

describe('additive composed route presentation', () => {
  it('aggregates all 22 families with unique paths and preserves native controllers', () => {
    expect(composedRouteSpecs).toHaveLength(136)
    expect(new Set(composedRouteSpecs.map(spec => spec.route)).size).toBe(136)
    expect(new Set(composedRouteSpecs.map(spec => `${spec.surface}/${spec.section}`)).size).toBe(22)
    expect(composedXpanelRoutes).toHaveLength(1)
    // Every WHM spec has a native page, so nothing renders a composed WHM layout.
    expect(composedRouteSpecs.filter(spec => spec.surface === 'xwhm' && !nativeComposedRoutePaths.has(spec.route))).toEqual([])
    // An approved xPanel workspace renders its route, so its composed spec must not stay a composed route.
    expect(composedXpanelRoutes.filter(spec => approvedXpanelWorkspaceRoutes.has(spec.route)).map(spec => spec.route)).toEqual([])
    // Workspace routes: specs stay as metadata while their native workspaces render them.
    for (const route of ['/whm/server/terminal', '/whm/server/file-sharing', '/whm/server/nodes', '/software/apps', '/software/optimize', '/whm/software/addon-services', '/whm/software/containers',
      '/whm/software/containers/engine', '/whm/software/deployments', '/whm/software/application-projects', '/whm/email/spam', '/whm/email/relay', '/whm/email/bcc', '/whm/email/marketing',
      '/whm/accounts/templates', '/whm/plans/enhancements', '/whm/backups/restore-more', '/whm/transfers/convert-addon', '/whm/transfers/server', '/domains/staging',
      '/software/containers', '/software/cache', '/whm/panel/settings', '/whm/panel/branding', '/whm/panel/languages', '/whm/panel/whmcs', '/domains/reverse-proxy', '/security/ssl/files', '/whm/resellers/more', '/whm/resellers/ips-nameservers']) {
      expect(composedRouteSpecs.some(spec => spec.route === route), route).toBe(true)
      expect(nativeComposedRoutePaths.has(route), route).toBe(true)
    }
    // Workspace (security) routes: their specs stay as metadata while the native WAF, flood, panel access, DNS provider and cluster workspaces render them.
    for (const route of ['/whm/security/waf', '/whm/security/flood', '/whm/security/panel-access', '/whm/dns/providers', '/whm/dns/cluster', '/security/waf', '/domains/cloudflare']) {
      expect(composedRouteSpecs.some(spec => spec.route === route), route).toBe(true)
      expect(nativeComposedRoutePaths.has(route), route).toBe(true)
    }
    const nextNativeRoutes = ['/software/packages', '/databases/remote-access', '/advanced/api-shell', '/whm/server/trusted-proxies', '/whm/backups/destinations', '/whm/panel/developer', '/whm/panel/integrations']
    expect(composedRouteSpecs.filter(spec => nextNativeRoutes.includes(spec.route)).map(spec => spec.route).sort()).toEqual([...nextNativeRoutes].sort())
    for (const route of nextNativeRoutes) {
      expect(nativeComposedRoutePaths.has(route), route).toBe(true)
      expect(composedXpanelRoutes.some(spec => spec.route === route), route).toBe(false)
      expect(renderComposedRoutes(composedRouteSpecs, { ...root, route }), route).toBeUndefined()
    }
    for (const route of ['/email/calendars-contacts', '/mail/later', '/mail/settings/spam', '/mail/tools/mailing-lists']) {
      expect(nativeComposedRoutePaths.has(route), route).toBe(true)
      expect(composedRouteSpecs.some(spec => spec.route === route), route).toBe(false)
    }
    for (const route of ['/whm/services/more', '/whm/services/default-index', '/whm/services/nginx-proxy', '/whm/software/composer', '/whm/monitoring/benchmark', '/whm/monitoring/traffic', '/whm/accounts/bandwidth', '/domains/dynamic-dns', '/domains/site-publisher', '/files/git']) {
      expect(composedRouteSpecs.some(spec => spec.route === route), route).toBe(true)
      expect(nativeComposedRoutePaths.has(route), route).toBe(true)
    }
    // Encryption has its existing dedicated email registry, not a generic composed spec.
    expect(composedRouteSpecs.some(spec => spec.route === '/email/encryption')).toBe(false)
    expect(nativeComposedRoutePaths.has('/email/encryption')).toBe(true)
    // These exact two bodies are covered with their canonical and child views by
    // extensions-acceptance; the generic renderer must not shadow their adapter.
    expect(renderComposedXpanel({ ...owner, route: '/software/installer' })).toBeUndefined()
    expect(renderComposedRoutes(composedRouteSpecs, { ...root, route: '/whm/software/site-software' })).toBeUndefined()
    for (const spec of composedXpanelRoutes) expect(nativeComposedRoutePaths.has(spec.route)).toBe(false)
    for (const spec of composedRouteSpecs.filter(spec => nativeComposedRoutePaths.has(spec.route))) {
      expect(renderComposedRoutes([spec], { ...root, route: spec.route })).toBeUndefined()
    }
    expect(renderComposedXpanel({ ...owner, route: '/unknown' })).toBeUndefined()
    expect(renderComposedRoutes(composedRouteSpecs, { ...root, route: '/whm/unknown' })).toBeUndefined()
  })

  it('does not turn failed or denied reads into results', () => {
    expect(renderComposedXpanel({ ...owner, failedReads: ['usage'] })).toContain('data-read-state="failed"')
    const denied = renderComposedXpanel({ ...owner, principal: undefined })!
    expect(denied).toContain('data-read-state="denied"')
    expect(denied).not.toContain(account.primaryDomain)
    const wrongOwner = renderComposedXpanel({ ...owner, principal: { kind: 'user', id: 'other', username: 'other', accountId: 'neighbor' } })!
    expect(wrongOwner).toContain('data-read-state="denied"')
    expect(wrongOwner).not.toContain(account.primaryDomain)
  })

  it('escapes actual values and renders facts without internal references', () => {
    const html = renderComposedXpanel({ ...owner, account: { ...account, primaryDomain: '<img src=x onerror=alert(1)>' } })!
    expect(html).toContain('&lt;img')
    expect(html).not.toContain('<img')
    expect(html).not.toContain(account.id)
  })

  it('keeps unread usage unread without invented zeros', () => {
    const panel = renderComposedXpanel({ ...owner, plan: { ...plan, id: 'neighbor-plan', name: 'SECRET-PLAN' } })!
    expect(panel).not.toContain('SECRET-PLAN')
    expect(panel).toContain('Not read')
    expect(panel).not.toContain('0 B')
  })

  it('requires the reseller ACL on the native reseller pages and filters own records', () => {
    const principal = { kind: 'reseller' as const, id: reseller.id, username: reseller.username }
    const page = (who: Principal | undefined, activeRoute: string, acl: readonly ResellerAcl[]) => renderWhmDetailPage({ activeRoute, resellers: [reseller, { ...reseller, id: 'neighbor', username: 'NEIGHBOR' }], ...(who ? { visibility: { principal: who, reseller: { acl: [...acl] } } } : {}) })!
    for (const [route, acl] of [['/whm/resellers/more', 'list-accounts'], ['/whm/resellers/ips-nameservers', 'manage-dns']] as const) {
      const records = page(principal, route, [acl])
      expect(records).toContain(reseller.username)
      expect(records).not.toContain('NEIGHBOR')
      expect(records).not.toContain('<form')
      expect(records).not.toContain('data-whm-reseller-email')
    }
    for (const html of [page(principal, '/whm/resellers/ips-nameservers', []), page(principal, '/whm/resellers/more', []), page(owner.principal, '/whm/resellers/more', []), page(undefined, '/whm/resellers/more', [])]) {
      expect(html).toContain('data-whm-detail-denied')
      expect(html).not.toContain(reseller.username)
      expect(html).not.toContain('NEIGHBOR')
    }
    const all = page(root.principal, '/whm/resellers/more', [])
    expect(all).toContain('NEIGHBOR')
    expect(all).toContain('data-whm-reseller-email')
    expect(renderWhmDetailPage({ activeRoute: '/whm/resellers/more', capabilityUnavailable: true })).toContain('data-network-editable="false"')
  })

  it('keeps trusted reseller authorization on a selected account', () => {
    const principal = { kind: 'reseller' as const, id: reseller.id, username: reseller.username }
    const selectedAccount = { ...owner, principal, reseller }
    expect(renderComposedXpanel(selectedAccount)).toContain(account.primaryDomain)
    expect(renderComposedXpanel({ ...selectedAccount, account: { ...account, ownerId: 'neighbor' } })).toContain('data-read-state="denied"')
    expect(renderComposedXpanel({ ...selectedAccount, reseller: undefined })).toContain('data-read-state="denied"')
  })

  it('keeps unavailable workflows truthful and non-operational in both locales', () => {
    for (const locale of ['en', 'ar'] as const) {
      for (const spec of composedXpanelRoutes.filter(row => row.bind === 'soon')) {
        const html = renderComposedRoutes([spec], { ...(spec.surface === 'xpanel' ? owner : root), route: spec.route, locale })!
        expect(html).toContain('data-read-state="unavailable"')
        expect(html).not.toContain('<form')
        expect(html).not.toContain('<button')
        expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
      }
    }
  })
})
