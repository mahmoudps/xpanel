import { LOGIN_CLIENT_SCRIPT } from './login-client.ts'
import { Script } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { renderWebApp } from './app.ts'
import { renderMailSurface } from './surfaces/xmail.ts'
import { renderPanelSurface } from './surfaces/xpanel.ts'
import { renderWhmSurface } from './surfaces/xwhm.ts'
import { BROWSER_REALTIME_SCRIPT } from './ws-client.ts'
import type { Account, Plan, Principal } from '@xpanel/core'
import { composedRouteSpecs, nativeComposedRoutePaths } from './board-port/composed/all.ts'
import { renderComposedRoutes } from './board-port/composed/render.ts'

const unavailableProviderRead = (): never => { throw new Error('unqualified_provider_read') }

const summaryAccount: Account = {
  id: 'private-account-id', username: 'owner7', uid: 9123456, gid: 9123457,
  home: '/private-home-marker', primaryDomain: 'owner7.example.test', planId: 'private-plan-id',
  ownerId: 'private-reseller-id', status: 'active', suspendReason: 'private-suspension-marker',
  contactEmail: 'private-contact-marker@example.test', ipv4: '192.0.2.199', shell: 'none', createdAt: '2026-10-23T00:00:00Z',
}
const summaryPlan: Plan = {
  id: summaryAccount.planId, name: 'Configured plan7', ownerId: null, featureListId: 'private-feature-id',
  resources: { diskMb: 1000, bandwidthMbMonth: 'unlimited', ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 10, ioWriteIops: 10, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
  caps: { addonDomains: 1, aliasDomains: 1, subdomains: 1, mailboxes: 1, forwarders: 1, mailingLists: 1, ftpAccounts: 1, databases: 1, phpWorkers: 1 },
  dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100,
}
const summaryOwner: Principal = { kind: 'user', id: 'private-principal-id', username: 'owner7', accountId: summaryAccount.id }

describe('verified production availability', () => {
  it.each(composedRouteSpecs.filter(row => !nativeComposedRoutePaths.has(row.route)))('retains an inert composed layout without provider reads on $route', spec => {
    for (const locale of ['en', 'ar'] as const) {
      const html = renderWebApp({
        surface: spec.surface, activeRoute: spec.route, locale, catalog: [],
        visibility: { principal: spec.surface === 'xwhm' ? { kind: 'root', id: 'root', username: 'administrator7' } : summaryOwner },
        panel: { account: summaryAccount, get domains() { return unavailableProviderRead() }, get serviceUsers() { return unavailableProviderRead() } },
      })
      expect(html).toContain(`data-composed-route="${spec.route}"`)
      expect(html).toContain('data-read-state="unavailable"')
      expect(html).toContain('data-tool-availability="unverified"')
      expect(html).not.toMatch(/<form\b|data-read-state="(?:loaded|empty)"/)
      const staticOnly = renderComposedRoutes([spec], {
        locale, route: spec.route,
        get account() { return unavailableProviderRead() },
        get accounts() { return unavailableProviderRead() },
        get domains() { return unavailableProviderRead() },
        get serviceUsers() { return unavailableProviderRead() },
      }, true)
      expect(staticOnly).toContain('data-read-state="unavailable"')
      expect(staticOnly).not.toMatch(/<form\b|data-read-state="(?:loaded|empty)"/)
    }
  })

  it.each([
    '/software/installer', '/software/store', '/software/store/app', '/software/store/install',
    '/software/store/progress', '/software/store/installed', '/software/store/updates', '/software/store/error',
    '/whm/software/site-software', '/whm/software/store', '/whm/software/store/extensions', '/whm/software/store/activity',
  ])('retains disabled store components without unqualified provider data on %s', route => {
    const root = route.startsWith('/whm/')
    const html = renderWebApp({
      surface: root ? 'xwhm' : 'xpanel', activeRoute: route, catalog: [],
      visibility: { principal: root ? { kind: 'root', id: 'root', username: 'administrator7' } : summaryOwner },
      panel: { account: summaryAccount, domains: [{ accountId: summaryAccount.id, name: 'private-store-domain-marker' } as never] },
    })
    expect(html).toContain('data-extension-view')
    expect(html).toContain('data-installer-state="unavailable"')
    expect(html).toContain('data-tool-availability="unverified"')
    expect(html).toMatch(/<button\b[^>]*disabled[^>]*data-wiring="unavailable"/)
    expect(html).not.toMatch(/<form\b|data-installer-progress="(?:running|complete)"/)
    for (const marker of ['private-store-domain-marker', '/private-home-marker', 'private-contact-marker']) expect(html).not.toContain(marker)
  })

  it.each(['foreign', 'suspended', 'missing'] as const)('does not expose an unavailable store layout for a %s account', kind => {
    const html = renderWebApp({
      surface: 'xpanel', activeRoute: '/software/installer', catalog: [], visibility: { principal: summaryOwner },
      ...(kind === 'missing' ? {} : { panel: { account: { ...summaryAccount, ...(kind === 'foreign' ? { id: 'foreign-account' } : { status: 'suspended' as const }) } } }),
    })
    expect(html).not.toContain('data-extension-view')
    expect(html).not.toMatch(/<form\b/)
  })

  it.each(['xwhm', 'xpanel', 'xmail'] as const)('keeps an anonymous %s workspace unavailable without admitting registered navigation', surface => {
    const html = renderWebApp({
      surface, locale: 'en',
      whm: { accounts: [summaryAccount] },
      panel: { account: summaryAccount, plan: summaryPlan },
      mail: { mailbox: 'private-mailbox-marker@example.test', messages: [] },
    })
    expect(html).toContain('data-tool-availability="unverified"')
    expect(html).toContain(surface === 'xwhm' ? 'Server dashboard' : surface === 'xmail' ? 'Inbox' : 'Home')
    expect(html).not.toContain('data-action="logout"')
    expect(html).not.toMatch(/data-nav-route=|data-nav-wiring=|data-workspace-identity=|data-workspace-account-overview=/)
    const sidebar = /<aside class="xp-sidebar"[\s\S]*?<\/aside>/.exec(html)?.[0] ?? ''
    // The public account menu retains a security destination; it grants no workspace admission.
    const securityRoute = surface === 'xwhm' ? '/whm/security/sign-in' : surface === 'xmail' ? '/mail/settings/security' : '/security/account'
    expect(html).toMatch(new RegExp(`href="${securityRoute}[^\"]*" data-security-link="true"`))
    if (surface === 'xmail') expect(sidebar).toContain('data-security-link="true"')
    else expect(sidebar).not.toContain('data-security-link="true"')
    expect(sidebar.replace(/<a\b[^>]*data-security-link="true"[^>]*>[\s\S]*?<\/a>/g, '')).not.toMatch(/<a\b/)
    expect(html).not.toMatch(/<form\b|data-cmdk-item="/)
    expect(html).not.toContain('alice-shop.com')
    expect(html).not.toMatch(/data-generation-chip=|data-service-row=|data-account-row=|data-mail-uid=|data-realtime-enabled="true"/)
    for (const marker of ['owner7.example.test', 'Configured plan7', 'private-mailbox-marker', 'private-account-id', 'private-contact-marker']) expect(html).not.toContain(marker)
  })

  it.each([
    { surface: 'xwhm', route: '/whm', navigation: '/whm/accounts', forbidden: ['/home', '/mail/inbox'], principal: { kind: 'root', id: 'private-root-id', username: 'administrator7' } },
    { surface: 'xpanel', route: '/resources', navigation: '/resources', forbidden: ['/whm/accounts', '/whm/server/setup'], principal: summaryOwner },
    { surface: 'xmail', route: '/mail/inbox', navigation: '/mail/compose', forbidden: ['/whm/accounts', '/whm/server/setup', '/home'], principal: summaryOwner },
  ] as const)('shows only role-admitted unqualified navigation and minimal identity on $surface', row => {
    const html = renderWebApp({
      surface: row.surface, locale: 'en', activeRoute: row.route, catalog: [],
      visibility: { principal: row.principal, disabledFeatures: new Set() },
      whm: { accounts: [summaryAccount] },
      panel: { recentAudit: [{ action: 'private-audit-action-marker', target: 'private-audit-target-marker' }] },
      mail: { mailbox: 'private-mailbox-marker@example.test', messages: [], composeDraft: { to: 'private-recipient-marker@example.test', cc: '', subject: 'private-subject-marker', body: 'private-body-marker' } },
    })
    expect(html).toContain('data-tool-availability="unverified"')
    expect(html).toContain(`data-nav-route="${row.navigation}" data-nav-wiring="soon"`)
    expect(html).toContain('Coming soon')
    expect(html).toMatch(/<button\b[^>]*disabled[^>]*data-wiring="soon"/)
    const sidebar = /<aside class="xp-sidebar"[\s\S]*?<\/aside>/.exec(html)?.[0] ?? ''
    for (const route of row.forbidden) expect(sidebar).not.toContain(`data-nav-route="${route}"`)
    expect(html).toContain('data-workspace-identity="true"')
    expect(html).toContain(row.principal.username)
    expect(html.match(/data-workspace-field="([^"]+)"/g)).toEqual(['data-workspace-field="username"', 'data-workspace-field="role"'])
    expect(html).toContain('data-action="logout"')
    // Unqualified documents omit the qualified-only palette, including an owner's eligible Home link.
    expect(html).not.toMatch(/id="xp-cmdk-modal"|data-cmdk-item="/)
    expect(html).not.toMatch(/<form\b|data-generation-chip=|data-service-row=|data-account-row=|data-mail-uid=|data-realtime-enabled="true"/)
    for (const marker of ['owner7.example.test', 'Configured plan7', row.principal.id, 'private-account-id', 'private-contact-marker', 'private-audit-action-marker', 'private-audit-target-marker', 'private-mailbox-marker', 'private-recipient-marker', 'private-subject-marker', 'private-body-marker']) expect(html).not.toContain(marker)
  })

  it('does not publish provider payloads just because a principal is authenticated', () => {
    const html = renderWebApp({
      surface: 'xmail', visibility: { principal: { kind: 'user', id: 'u1', username: 'owner', accountId: 'a1' } },
      mail: { mailbox: 'private-marker@example.test', messages: [] },
    })
    expect(html).toContain('data-tool-availability="unverified"')
    expect(html).not.toContain('private-marker')
    expect(html).toContain('data-workspace-identity="true"')
    expect(html).not.toContain('data-workspace-account-overview=')
  })

  it.each(['en', 'ar'] as const)('renders the home port for a resolved account in %s and keeps other secrets out', locale => {
    const html = renderWebApp({ surface: 'xpanel', locale, visibility: { principal: summaryOwner }, panel: { account: summaryAccount, plan: summaryPlan } })
    for (const value of ['owner7', 'owner7.example.test', 'Configured plan7', '/private-home-marker', '192.0.2.199']) expect(html).toContain(value)
    expect(html).toContain('data-board-port="xpanel-home"')
    expect(html).toContain('data-action="logout"')
    expect(html).toContain(locale === 'ar' ? 'قيد التفعيل' : 'Coming soon')
    if (locale === 'ar') expect(html).toContain('<bdi dir="ltr">owner7.example.test</bdi>')
    expect(html).not.toContain('data-tool-availability="unverified"')
    expect(html).not.toMatch(/<form\b|data-generation-chip=|[\u0660-\u0669\u06f0-\u06f9]/)
    for (const marker of ['private-contact-marker', 'private-account-id', 'private-plan-id', 'private-feature-id', 'private-suspension-marker', '9123457', 'quotaUsed']) expect(html).not.toContain(marker)
  })

  it.each([
    { kind: 'root', id: 'private-root', username: 'administrator7' },
    { kind: 'reseller', id: summaryAccount.ownerId!, username: 'reseller7' },
  ] satisfies Principal[])('allows the account summary for its authorized $kind principal', principal => {
    const html = renderWebApp({ surface: 'xpanel', visibility: { principal }, panel: { account: summaryAccount, plan: summaryPlan } })
    expect(html).toContain('owner7.example.test')
    expect(html).toContain(principal.username)
    expect(html.match(/data-workspace-field=/g)).toHaveLength(6)
    expect(html).toContain('Selected account')
  })

  it.each([
    { kind: 'user', id: 'other-user-id', username: 'other-owner', accountId: 'other-account-id' },
    { kind: 'reseller', id: 'other-reseller-id', username: 'other-reseller' },
  ] satisfies Principal[])('does not disclose another account to $kind', principal => {
    const html = renderWebApp({ surface: 'xpanel', visibility: { principal }, panel: { account: summaryAccount, plan: summaryPlan } })
    expect(html).toContain('data-workspace-account-empty="true"')
    expect(html).not.toContain('owner7.example.test')
    expect(html).not.toContain('Configured plan7')
  })

  it.each([
    ['suspended', 'Suspended', 'معلق'],
    ['terminating', 'Terminating', 'قيد الإنهاء'],
  ] as const)('localizes a non-active account status %s on the summary', (status, en, ar) => {
    for (const locale of ['en', 'ar'] as const) {
      const html = renderWebApp({ surface: 'xpanel', locale, visibility: { principal: summaryOwner }, panel: { account: { ...summaryAccount, status }, plan: summaryPlan } })
      expect(html).toContain(locale === 'ar' ? ar : en)
      expect(html).not.toContain('data-service-row=')
      expect(html).toContain('data-tool-availability="unverified"')
    }
  })

  it.each(['xwhm', 'xmail'] as const)('shows identity without account state on %s', surface => {
    const html = renderWebApp({ surface, visibility: { principal: summaryOwner }, panel: { account: summaryAccount, plan: summaryPlan } })
    expect(html).toContain('data-workspace-identity="true"')
    expect(html).not.toContain('data-workspace-account-overview=')
    expect(html).not.toContain(summaryAccount.primaryDomain)
    expect(html).not.toContain(summaryPlan.name)
  })

  it('ignores account and plan payloads without a signed-in principal', () => {
    const html = renderWebApp({ surface: 'xpanel', panel: { account: summaryAccount, plan: summaryPlan } })
    expect(html).not.toContain('data-workspace-identity=')
    expect(html).not.toContain('data-workspace-account-overview=')
    expect(html).not.toContain('owner7.example.test')
  })

  it('uses clear unavailable fields for missing accounts and mismatched plans', () => {
    const missing = renderWebApp({ surface: 'xpanel', visibility: { principal: summaryOwner } })
    expect(missing).toContain('No authorized account is available to display.')
    for (const plan of [undefined, { ...summaryPlan, id: 'unrelated-plan-id', name: 'Hidden unrelated plan' }]) {
      const html = renderWebApp({ surface: 'xpanel', visibility: { principal: summaryOwner }, panel: { account: summaryAccount, ...(plan ? { plan } : {}) } })
      expect(html).toContain('data-board-port="xpanel-home"')
      expect(html).not.toContain('Hidden unrelated plan')
      expect(html).not.toContain('Configured plan7')
    }
  })

  it('escapes all externally supplied summary labels and values', () => {
    const html = renderWebApp({ surface: 'xpanel', visibility: { principal: { ...summaryOwner, username: '<script>identity-marker</script>' } }, panel: { account: { ...summaryAccount, username: '<img src=x onerror=account-marker>', primaryDomain: '<script>domain-marker</script>' }, plan: { ...summaryPlan, name: '<svg onload=plan-marker>' } } })
    expect(html).toContain('data-board-port="xpanel-home"')
    expect(html).toContain('&lt;img src=x onerror=account-marker&gt;')
    expect(html).toContain('&lt;script&gt;domain-marker&lt;/script&gt;')
    expect(html).toContain('&lt;svg onload=plan-marker&gt;')
    expect(html).not.toMatch(/<script>identity-marker|<img src=x|<svg onload=plan-marker|<script>domain-marker/)
  })

  it('keeps login reachable and gives the command palette no privileged static routes', () => {
    const html = renderWebApp({ surface: 'login' })
    expect(html).toMatch(/<form\b/)
    expect(html).not.toContain('data-tool-availability="unverified"')
    expect(html).not.toContain('data-cmdk-item="')
  })

  it('renders an Arabic unavailable state with Latin digits', () => {
    const html = renderWebApp({ surface: 'xpanel', locale: 'ar' })
    expect(html).toContain('قيد التفعيل')
    expect(html).toContain('<h1 class="xp-page-title">الرئيسية</h1>')
    expect(html).toContain('<title>الرئيسية — xPanel</title>')
    // Inline client bindings carry their own error strings; the generic workspace card is page markup.
    const markup = html.replace(/<script\b[\s\S]*?<\/script>/g, '')
    expect(markup).not.toContain('مساحة العمل')
    expect(markup).not.toContain('tool groups planned')
    expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })

  it('uses the real page heading and keeps security free of the unavailable-tools card', () => {
    const home = renderWebApp({ surface: 'xwhm', locale: 'en', visibility: { principal: { kind: 'root', id: 'root', username: 'root' } } })
    expect(home).toContain('<h1 class="xp-page-title">Server dashboard</h1>')
    expect(home).toContain('<title>Server dashboard — xWHM</title>')
    expect(home).not.toContain('>Workspace<')
    const security = renderWebApp({
      surface: 'xwhm', locale: 'en', activeRoute: '/whm/security/sign-in',
      visibility: { principal: { kind: 'root', id: 'root', username: 'root' } },
      security: { totpEnabled: false },
    })
    expect(security).toContain('<h1 class="xp-page-title">Sign-in security</h1>')
    expect(security).toContain('<title>Sign-in security — xWHM</title>')
    expect(security).toContain('data-security-page="true"')
    expect(security).toContain('data-account-security="two-factor"')
    expect(security).not.toContain('class="xp-card xp-workspace-availability"')
    expect(security).toContain('data-security-link="true"')
  })

  it('does not retain unfiltered favorites or navigation links in direct design renderers', () => {
    for (const render of [renderWhmSurface, renderPanelSurface, renderMailSurface]) {
      const html = render({ locale: 'en' })
      const sidebar = /<aside class="xp-sidebar"[\s\S]*?<\/aside>/.exec(html)?.[0] ?? ''
      expect(sidebar).toContain('data-navigation-empty="true"')
      expect(sidebar).toContain('data-security-link="true"')
      expect(sidebar.replace(/<a\b[^>]*data-security-link="true"[^>]*>[\s\S]*?<\/a>/g, '')).not.toMatch(/<a\b/)
      expect(html).toContain('data-screen="unavailable"')
      expect(html).not.toMatch(/data-account-row=|data-mail-uid=|data-service-row=|data-generation-chip=|<form\b/)
      expect(html).not.toContain('alice-shop.com')
    }
  })

  it.each(['xwhm', 'xpanel', 'xmail'] as const)('does not authorize an arbitrary active route from an authenticated %s principal', surface => {
    const principal = surface === 'xwhm'
      ? { kind: 'root' as const, id: 'synthetic-root', username: 'synthetic-root' }
      : { kind: 'user' as const, id: 'synthetic-owner', username: 'synthetic-owner', accountId: 'synthetic-account' }
    const html = renderWebApp({ surface, activeRoute: '/synthetic-unregistered-route', visibility: { principal, disabledFeatures: new Set() } })
    expect(html).toContain('data-tool-availability="unverified"')
    expect(html).not.toMatch(/<form\b|data-cmdk-item="/)
    expect(html).not.toContain('data-realtime-enabled="true"')
  })
})

describe('emitted browser JavaScript syntax', () => {
  it('parses the complete emitted script rather than the TypeScript template source', () => {
    expect(() => new Script(BROWSER_REALTIME_SCRIPT, { filename: 'xpanel-realtime-client.js' })).not.toThrow()
    expect(() => new Script(LOGIN_CLIENT_SCRIPT, { filename: 'xpanel-login-client.js' })).not.toThrow()
    const html = renderWebApp({ surface: 'login' })
    const emitted = /<script id="xpanel-login-client">([\s\S]*?)<\/script>/.exec(html)?.[1]
    expect(emitted).toBeTruthy()
    expect(() => new Script(emitted!, { filename: 'xpanel-emitted.js' })).not.toThrow()
  })
})


describe('bounded workspace summary DTO', () => {
  const account = { id: summaryAccount.id, ownerId: summaryAccount.ownerId, username: summaryAccount.username, primaryDomain: summaryAccount.primaryDomain, status: summaryAccount.status, planId: summaryAccount.planId }
  const plan = { id: summaryPlan.id, name: summaryPlan.name }

  it.each(['en', 'ar'] as const)('renders a minimal DTO in %s without service-state fields', locale => {
    const html = renderWebApp({ surface: 'xpanel', locale, visibility: { principal: summaryOwner }, workspaceSummary: { account, plan } })
    expect(html).toContain('owner7.example.test')
    expect(html).toContain('Configured plan7')
    expect(html.match(/data-workspace-field=/g)).toHaveLength(5)
    expect(html).not.toMatch(/private-|data-realtime-enabled="true"/)
  })

  it('does not fall back to a larger provider payload when the explicit DTO is empty and the account is not active', () => {
    const html = renderWebApp({ surface: 'xpanel', visibility: { principal: summaryOwner }, workspaceSummary: {}, panel: { account: { ...summaryAccount, status: 'suspended' }, plan: summaryPlan } })
    expect(html).toContain('data-workspace-account-empty="true"')
    expect(html).not.toContain(summaryAccount.primaryDomain)
    expect(html).not.toContain(summaryPlan.name)
  })

  it.each([
    { kind: 'user', id: 'foreign-principal', username: 'foreign7', accountId: 'foreign-account' },
    { kind: 'reseller', id: 'foreign-reseller', username: 'foreign7' },
  ] satisfies Principal[])('refuses a foreign DTO for $kind without relying on its provider', principal => {
    const html = renderWebApp({ surface: 'xpanel', visibility: { principal }, workspaceSummary: { account, plan } })
    expect(html).toContain('data-workspace-account-empty="true"')
    expect(html).not.toContain(account.primaryDomain)
    expect(html).not.toContain(plan.name)
  })

  it('does not label an account with a different plan ID', () => {
    const html = renderWebApp({ surface: 'xpanel', visibility: { principal: summaryOwner }, workspaceSummary: { account, plan: { id: 'wrong-plan', name: 'Foreign plan marker' } } })
    expect(html).not.toContain('Foreign plan marker')
    expect(html).toContain('Unavailable')
  })

  it('escapes account and plan text in the minimal DTO', () => {
    const html = renderWebApp({ surface: 'xpanel', visibility: { principal: summaryOwner }, workspaceSummary: { account: { ...account, primaryDomain: '<img src=x onerror=alert(1)>' }, plan: { ...plan, name: '<script>marker</script>' } } })
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('&lt;script&gt;marker&lt;/script&gt;')
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('<script>marker')
  })
})
