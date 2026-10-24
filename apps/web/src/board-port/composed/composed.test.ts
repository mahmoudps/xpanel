import { describe, expect, it } from 'vitest'
import { defaultPlan, type Account, type Domain, type Reseller, type ServiceUser } from '@xpanel/core'
import { composedRouteSpecs, composedXpanelRoutes, composedXwhmRoutes, nativeComposedRoutePaths } from './all.ts'
import { renderComposedRoutes, renderComposedXpanel, renderComposedXwhm } from './render.ts'
import type { ComposedContext } from './context.ts'

const plan = defaultPlan({ id: 'plan-internal', name: 'Standard', featureListId: 'features-internal' })
const account: Account = { id: 'account-internal', username: 'alpha', uid: 20001, gid: 20001, home: '/home/alpha', primaryDomain: 'alpha.example.test', ownerId: 'reseller-internal', planId: plan.id, status: 'active', suspendReason: null, contactEmail: '', ipv4: '192.0.2.1', shell: 'none', createdAt: '2026-10-24T00:00:00Z' }
const reseller: Reseller = { id: 'reseller-internal', username: 'reseller-alpha', acl: ['list-accounts'], maxAccounts: 8, totalDiskMb: 1024, totalBandwidthMb: 2048, oversell: false, nameservers: [], delegatedIps: [] }
const owner: ComposedContext = { locale: 'en', route: '/files/web-disk', principal: { kind: 'user', id: 'user-internal', username: 'alpha', accountId: account.id }, account, plan }
const root: ComposedContext = { locale: 'en', route: '/whm/accounts/health', principal: { kind: 'root', id: 'root-internal', username: 'root' } }
const membership: ServiceUser = { id: 'membership-internal', accountId: account.id, login: 'disk@alpha.example.test', services: { ftp: true, webdisk: true, email: false }, mailboxQuotaMb: 999999, ftpDir: 'public_html' }

describe('additive composed route presentation', () => {
  it('aggregates all 22 families with unique paths and preserves native controllers', () => {
    expect(composedRouteSpecs).toHaveLength(135)
    expect(new Set(composedRouteSpecs.map(spec => spec.route)).size).toBe(135)
    expect(new Set(composedRouteSpecs.map(spec => `${spec.surface}/${spec.section}`)).size).toBe(22)
    expect(composedXpanelRoutes.length + composedXwhmRoutes.length).toBe(118)
    // These exact two bodies are covered with their canonical and child views by
    // extensions-acceptance; the generic renderer must not shadow their adapter.
    expect(renderComposedXpanel({ ...owner, route: '/software/installer' })).toBeUndefined()
    expect(renderComposedXwhm({ ...root, route: '/whm/software/site-software' })).toBeUndefined()
    for (const spec of [...composedXpanelRoutes, ...composedXwhmRoutes]) expect(nativeComposedRoutePaths.has(spec.route)).toBe(false)
    for (const spec of composedRouteSpecs.filter(spec => nativeComposedRoutePaths.has(spec.route))) {
      expect(renderComposedRoutes([spec], { ...root, route: spec.route })).toBeUndefined()
    }
    expect(renderComposedXpanel({ ...owner, route: '/unknown' })).toBeUndefined()
    expect(renderComposedXwhm({ ...root, route: '/whm/unknown' })).toBeUndefined()
  })

  it('does not turn absent, failed or denied reads into empty results', () => {
    expect(renderComposedXpanel(owner)).toContain('data-read-state="unread"')
    expect(renderComposedXpanel({ ...owner, serviceUsers: [] })).toContain('data-read-state="empty"')
    expect(renderComposedXpanel({ ...owner, serviceUsers: [], failedReads: ['serviceUsers'] })).toContain('data-read-state="failed"')
    const denied = renderComposedXpanel({ ...owner, principal: undefined, serviceUsers: [membership] })!
    expect(denied).toContain('data-read-state="denied"')
    expect(denied).not.toContain(membership.login)
    const wrongOwner = renderComposedXpanel({ ...owner, principal: { kind: 'user', id: 'other', username: 'other', accountId: 'neighbor' }, serviceUsers: [membership] })!
    expect(wrongOwner).toContain('data-read-state="denied"')
    expect(wrongOwner).not.toContain(membership.login)
  })

  it('filters neighboring account rows and never borrows mailbox quota for WebDisk', () => {
    const html = renderComposedXpanel({ ...owner, serviceUsers: [membership, { ...membership, accountId: 'neighbor', login: 'neighbor@example.test' }] })!
    expect(html).toContain('disk@alpha.example.test')
    expect(html).toContain('public_html')
    expect(html).not.toContain('neighbor@example.test')
    expect(html).not.toContain('999999')
    expect(html).not.toContain('membership-internal')
    expect(html).toContain('<bdi dir="ltr">')
    expect(html).not.toContain('<form')
    expect(html).not.toContain('/api/')
  })

  it('escapes actual values and renders certificate assignments without internal references', () => {
    const domain = { accountId: account.id, name: '<img src=x onerror=alert(1)>', certificateId: 'certificate-internal' } as Domain
    const html = renderComposedXpanel({ ...owner, route: '/security/ssl/files', domains: [domain, { ...domain, accountId: 'neighbor', name: 'neighbor.example.test' }] })!
    expect(html).toContain('&lt;img')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('certificate-internal')
    expect(html).not.toContain('neighbor.example.test')
    expect(html).toContain('Assigned')
  })

  it('retains terminating status and unmeasured usage without invented zeros', () => {
    const html = renderComposedXwhm({ ...root, accounts: [{ ...account, status: 'terminating' }] })!
    expect(html).toContain('Terminating')
    expect(html).toContain('Not measured')
    expect(html).not.toContain('account-internal')
    const panel = renderComposedXpanel({ ...owner, route: '/server-information', plan: { ...plan, id: 'neighbor-plan', name: 'SECRET-PLAN' } })!
    expect(panel).not.toContain('SECRET-PLAN')
    expect(panel).toContain('Not read')
    expect(panel).not.toContain('0 B')
  })

  it('requires trusted reseller read ACL and filters own accounts and reseller records', () => {
    const context: ComposedContext = { ...root, principal: { kind: 'reseller', id: reseller.id, username: reseller.username }, reseller, resellers: [reseller, { ...reseller, id: 'neighbor', username: 'NEIGHBOR' }] }
    const accounts = renderComposedXwhm({ ...context, accounts: [account, { ...account, ownerId: 'neighbor', username: 'NEIGHBOR-ACCOUNT' }] })!
    expect(accounts).toContain('alpha.example.test')
    expect(accounts).not.toContain('NEIGHBOR-ACCOUNT')
    const records = renderComposedXwhm({ ...context, route: '/whm/resellers/more' })!
    expect(records).toContain(reseller.username)
    expect(records).toContain('None')
    expect(records).not.toContain('NEIGHBOR')
    const denied = renderComposedXwhm({ ...context, route: '/whm/resellers/more', reseller: { ...reseller, acl: [] } })!
    expect(denied).toContain('data-read-state="denied"')
    expect(denied).not.toContain(reseller.username)
    expect(renderComposedXwhm({ ...root, route: '/whm/resellers/more' })).toContain('data-read-state="unread"')
    expect(renderComposedXwhm({ ...root, route: '/whm/resellers/more', resellers: [] })).toContain('data-read-state="empty"')
    const deniedOwner = renderComposedXwhm({ ...root, principal: owner.principal, accounts: [account] })!
    expect(deniedOwner).toContain('data-read-state="denied"')
    expect(deniedOwner).not.toContain(account.primaryDomain)
    const missingPrincipal = renderComposedXwhm({ ...root, principal: undefined, accounts: [account] })!
    expect(missingPrincipal).toContain('data-read-state="denied"')
    expect(missingPrincipal).not.toContain(account.primaryDomain)
  })

  it('keeps trusted reseller authorization separate from unread or empty collections', () => {
    const context: ComposedContext = { ...root, route: '/whm/resellers/more', principal: { kind: 'reseller', id: reseller.id, username: reseller.username }, reseller }
    const unread = renderComposedXwhm(context)!
    expect(unread).toContain('data-read-state="unread"')
    expect(unread).not.toContain(reseller.username)
    expect(renderComposedXwhm({ ...context, resellers: [] })).toContain('data-read-state="empty"')
    for (const authorization of [undefined, { id: 'neighbor', acl: reseller.acl }, { id: reseller.id, acl: [] }]) {
      const denied = renderComposedXwhm({ ...context, reseller: authorization, resellers: [reseller] })!
      expect(denied).toContain('data-read-state="denied"')
      expect(denied).not.toContain(reseller.username)
    }
    const selectedAccount = { ...owner, principal: context.principal, reseller, serviceUsers: [membership] }
    expect(renderComposedXpanel(selectedAccount)).toContain(membership.login)
    expect(renderComposedXpanel({ ...selectedAccount, account: { ...account, ownerId: 'neighbor' } })).toContain('data-read-state="denied"')
    expect(renderComposedXpanel({ ...selectedAccount, reseller: undefined })).toContain('data-read-state="denied"')
  })

  it('keeps unavailable workflows truthful and non-operational in both locales', () => {
    for (const locale of ['en', 'ar'] as const) {
      for (const spec of [...composedXpanelRoutes, ...composedXwhmRoutes].filter(row => row.bind === 'soon')) {
        const html = renderComposedRoutes([spec], { ...(spec.surface === 'xpanel' ? owner : root), route: spec.route, locale })!
        expect(html).toContain('data-read-state="unavailable"')
        expect(html).not.toContain('<form')
        expect(html).not.toContain('<button')
        expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
      }
    }
  })
})
