import { LOGIN_CLIENT_SCRIPT } from './login-client.ts'
import { Script } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { renderWebApp } from './app.ts'
import { renderMailSurface } from './surfaces/xmail.ts'
import { renderPanelSurface } from './surfaces/xpanel.ts'
import { renderWhmSurface } from './surfaces/xwhm.ts'
import { BROWSER_REALTIME_SCRIPT } from './ws-client.ts'
import type { Account, Plan, Principal } from '@xpanel/core'

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
  it.each(['xwhm', 'xpanel', 'xmail'] as const)('shows an honest unavailable workspace for %s without publishing service actions', surface => {
    const html = renderWebApp({ surface, locale: 'en' })
    expect(html).toContain('data-tool-availability="unverified"')
    expect(html).toContain('data-nav-wiring="soon"')
    expect(html).toContain(surface === 'xwhm' ? 'Server dashboard' : surface === 'xmail' ? 'Inbox' : 'Home')
    expect(html).not.toContain('data-action="logout"')
    const sidebar = /<aside class="xp-sidebar"[\s\S]*?<\/aside>/.exec(html)?.[0] ?? ''
    expect(sidebar).toContain('data-security-link="true"')
    expect(sidebar).toContain('data-nav-route=')
    expect(html).not.toMatch(/<form\b|data-cmdk-item="/)
    expect(html).not.toContain('alice-shop.com')
    expect(html).not.toContain('data-generation-chip=')
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

  it.each(['en', 'ar'] as const)('shows only scoped account summary fields in %s while tools remain unavailable', locale => {
    const html = renderWebApp({ surface: 'xpanel', locale, visibility: { principal: summaryOwner }, panel: { account: summaryAccount, plan: summaryPlan } })
    for (const value of ['owner7', 'owner7.example.test', 'Configured plan7']) expect(html).toContain(value)
    expect(html).toContain(locale === 'ar' ? 'مالك الحساب' : 'Account owner')
    expect(html).toContain(locale === 'ar' ? 'نشط' : 'Active')
    expect(html.match(/data-workspace-field=/g)).toHaveLength(5)
    expect(html).toContain('<bdi dir="ltr">owner7.example.test</bdi>')
    expect(html).toContain('data-tool-availability="unverified"')
    expect(html).not.toMatch(/data-realtime-enabled="true"|<form\b|data-cmdk-item=|data-generation-chip=|[\u0660-\u0669\u06f0-\u06f9]/)
    for (const marker of ['private-', '9123456', '9123457', '192.0.2.199', 'Resource usage', 'quotaUsed', 'unlimited']) expect(html).not.toContain(marker)
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
    ['active', 'Active', 'نشط'],
    ['suspended', 'Suspended', 'معلق'],
    ['terminating', 'Terminating', 'قيد الإنهاء'],
  ] as const)('localizes the configured account status %s without claiming service health', (status, en, ar) => {
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
      expect(html).toMatch(/data-workspace-field="plan"[^]*?Unavailable/)
      expect(html).not.toContain('Hidden unrelated plan')
    }
  })

  it('escapes all externally supplied summary labels and values', () => {
    const html = renderWebApp({ surface: 'xpanel', visibility: { principal: { ...summaryOwner, username: '<script>identity-marker</script>' } }, panel: { account: { ...summaryAccount, username: '<img src=x onerror=account-marker>', primaryDomain: '<script>domain-marker</script>' }, plan: { ...summaryPlan, name: '<svg onload=plan-marker>' } } })
    expect(html).toContain('&lt;script&gt;identity-marker&lt;/script&gt;')
    expect(html).toContain('&lt;img src=x onerror=account-marker&gt;')
    expect(html).toContain('&lt;script&gt;domain-marker&lt;/script&gt;')
    expect(html).toContain('&lt;svg onload=plan-marker&gt;')
    expect(html).not.toMatch(/<script>identity-marker|<img src=x|<svg onload=plan-marker/)
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
    expect(html).not.toContain('مساحة العمل')
    expect(html).not.toContain('tool groups planned')
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

  it('does not fall back to a larger provider payload when the explicit DTO is empty', () => {
    const html = renderWebApp({ surface: 'xpanel', visibility: { principal: summaryOwner }, workspaceSummary: {}, panel: { account: summaryAccount, plan: summaryPlan } })
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
