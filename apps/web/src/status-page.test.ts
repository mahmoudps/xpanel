import { describe, expect, it } from 'vitest'
import { qualifyHostTools, tools } from '@xpanel/catalog'
import type { Principal } from '@xpanel/core'
import { renderWebApp, serveWebUi } from './app.ts'
import { formatDisplayName, publicContactEmail } from './display-name.ts'
import { DESIGN_TOKENS_CSS } from './tokens.ts'
import { renderWhmSurface } from './surfaces/xwhm.ts'

const owner: Principal = { kind: 'user', id: 'owner-id', username: 'mahmoud', accountId: 'account-id' }
const panels = [
  { surface: 'xpanel' as const, origin: 'https://panel.example.test:2083' },
  { surface: 'xwhm' as const, origin: 'https://whm.example.test:2087' },
  { surface: 'xmail' as const, origin: 'https://mail.example.test:2096' },
]

describe('display names', () => {
  it('spaces an unspaced camel-case plan name and keeps names that already have spaces or hyphens', () => {
    expect(formatDisplayName('BusinessLive')).toBe('Business Live')
    expect(formatDisplayName('HTTPResponse')).toBe('HTTP Response')
    expect(formatDisplayName('Configured plan7')).toBe('Configured plan7')
    expect(formatDisplayName('Summary plan7')).toBe('Summary plan7')
    expect(formatDisplayName('Starter')).toBe('Starter')
    expect(formatDisplayName('Already-Hyphenated')).toBe('Already-Hyphenated')
    expect(publicContactEmail(' ops@example.test ')).toBe('ops@example.test')
    expect(publicContactEmail('support@xpanel.internal')).toBe('support@xpanel.internal')
    expect(publicContactEmail('not an email')).toBeUndefined()
    expect(publicContactEmail('')).toBeUndefined()
  })

  it('formats the visible plan label and keeps the stored name on the row key', () => {
    const html = renderWebApp({
      surface: 'xpanel',
      visibility: { principal: owner },
      workspaceSummary: {
        account: { id: 'account-id', ownerId: null, username: 'mahmoud', primaryDomain: 'mahmoud.example.test', status: 'active', planId: 'plan-id' },
        plan: { id: 'plan-id', name: 'BusinessLive' },
      },
    })
    expect(html).toContain('Business Live')
    expect(html).not.toContain('BusinessLive')
    const plans = renderWhmSurface({
      locale: 'en',
      activeRoute: '/whm/plans',
      visibility: { principal: { kind: 'root', id: 'root-id', username: 'root' }, disabledFeatures: new Set() },
      plans: [{
        id: 'plan-id', name: 'BusinessLive', ownerId: null, featureListId: 'features',
        resources: { diskMb: 1, bandwidthMbMonth: 1, ioReadBps: 1, ioWriteBps: 1, ioReadIops: 1, ioWriteIops: 1, memoryMb: 1, maxProcesses: 1, cpuPercent: 1 },
        caps: { addonDomains: 0, aliasDomains: 0, subdomains: 0, mailboxes: 0, forwarders: 0, mailingLists: 0, ftpAccounts: 0, databases: 0, phpWorkers: 0 },
        dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 1,
      }],
    })
    expect(plans).toContain('data-plan-row="BusinessLive"')
    expect(plans).toContain('>Business Live<')
  })
})

describe('styled status pages', () => {
  it.each([404, 403, 421, 500, 503] as const)('renders %s in English and Arabic inside or outside the shell', status => {
    const signedIn = renderWebApp({
      surface: 'xpanel', locale: 'en', theme: 'light',
      visibility: { principal: owner },
      panels,
      error: {
        status,
        ...(status === 404 ? { workspaceHref: '/panel' } : {}),
        ...(status === 403 ? { suggested: 'xwhm' } : {}),
        ...(status === 500 || status === 503 ? { retryHref: '/panel' } : {}),
      },
    })
    expect(signedIn).toContain(`data-status="${status}"`)
    expect(signedIn).toContain(`data-status-page="${status}"`)
    expect(signedIn).toContain('dir="ltr"')
    expect(signedIn).toContain('data-user-menu')
    expect(signedIn).toContain('mahmoud')
    expect(signedIn).toMatch(/<h1 class="xp-page-title">[^<]+<\/h1>/)
    expect(signedIn).not.toMatch(/<form\b/)
    expect(signedIn).toContain('data-nav-route="/home"')
    expect(signedIn).toContain('Coming soon')
    expect(signedIn).toContain('data-nav-route="/domains"')
    expect(signedIn).toContain('aria-current="page"')
    expect(signedIn).not.toContain('Not yet available')
    if (status === 404) {
      expect(signedIn).toContain('Back to workspace')
      expect(signedIn).toContain('xp-icon-back')
      expect(signedIn).toContain('href="/panel?')
    }
    if (status === 403) expect(signedIn).toContain('https://whm.example.test:2087/login?lang=en&amp;theme=light')
    if (status === 421) {
      for (const origin of ['panel.example.test:2083', 'whm.example.test:2087', 'mail.example.test:2096']) expect(signedIn).toContain(origin)
    }
    if (status === 500 || status === 503) expect(signedIn).toContain('Try again')

    const guest = renderWebApp({ surface: 'xmail', locale: 'ar', theme: 'dark', panels, error: { status, surface: 'xmail' } })
    expect(guest).toContain('dir="rtl"')
    expect(guest).toContain('data-status-page="' + status + '"')
    expect(guest).toContain('xp-icon-back')
    expect(guest).not.toContain('data-user-menu')
    if (status !== 421) expect(guest).toContain('تسجيل الدخول')
  })

  it('mirrors the back icon in Arabic and lists design pages before their tools are connected', () => {
    expect(DESIGN_TOKENS_CSS).toContain('html[dir="rtl"] .xp-icon-back { transform: scaleX(-1); }')
    const html = renderWebApp({ surface: 'xpanel', locale: 'ar', visibility: { principal: owner }, supportEmail: 'ops@example.test' })
    const sidebar = /<aside class="xp-sidebar"[\s\S]*?<\/aside>/.exec(html)?.[0] ?? ''
    for (const route of ['/domains', '/email/accounts', '/files/manager', '/databases/mariadb', '/security/account', '/software/php']) {
      expect(sidebar).toContain(`data-nav-route="${route}"`)
    }
    expect(sidebar).toContain('قيد التفعيل')
    expect(sidebar).toContain('data-security-link="true"')
    expect(sidebar).not.toContain('data-planned-group=')
    expect(html).toContain('data-user-menu')
    expect(html).toContain('data-action="logout"')
    expect(html).toContain('data-density-option="comfortable" aria-current="true"')
    expect(html).toContain('data-density-option="compact"')
    expect(html).toContain('mailto:ops@example.test')
    const card = /class="xp-card xp-workspace-availability"[\s\S]*?<\/section>/.exec(html)?.[0] ?? ''
    expect(card).not.toContain('data-action="logout"')
    const plain = renderWebApp({ surface: 'xwhm', locale: 'en' })
    expect(plain).toContain('contact your hosting provider')
    expect(plain).not.toContain('mailto:')
    expect(plain).not.toContain('support@xpanel.internal')
  })

  it('keeps qualified sections on a signed-in 404', () => {
    const catalog = qualifyHostTools(tools, {
      executor: 'linux',
      probes: { 'control-plane': 'passed', 'host-info': 'passed', audit_log: 'passed' },
    })
    const html = renderWebApp({
      surface: 'xwhm',
      locale: 'en',
      visibility: { principal: { kind: 'root', id: 'root-id', username: 'root' } },
      catalog,
      error: { status: 404, workspaceHref: '/whm', hostname: 'host.example.test' },
    })
    expect(html).toContain('data-nav-route="/whm/audit" data-nav-wiring="live"')
    expect(html).toContain('data-nav-route="/whm/monitoring/server-info"')
    expect(html).toContain('data-nav-route="/whm/accounts" data-nav-wiring="soon"')
    expect(html).toContain('Coming soon')
    expect(html).toContain('aria-current="page"')
    expect(html).toContain('host.example.test')
    expect(html).not.toContain('Not yet available')
    const arabic = renderWebApp({
      surface: 'xwhm',
      locale: 'ar',
      visibility: { principal: { kind: 'root', id: 'root-id', username: 'root' } },
      catalog,
      error: { status: 404, workspaceHref: '/whm', hostname: 'host.example.test' },
    })
    expect(arabic).toContain('data-nav-route="/whm/audit"')
    expect(arabic).toContain('قيد التفعيل')
    expect(arabic).not.toContain('غير متاحة بعد')
  })

  it('returns HTML 404 for an unknown document and plain text for a missing asset', async () => {
    const missing = await serveWebUi(new Request('http://localhost/panel/email'))
    expect(missing.status).toBe(404)
    expect(missing.headers.get('content-type')).toContain('text/html')
    const html = await missing.text()
    expect(html).toContain('data-status-page="404"')
    expect(html).toContain('This page is not here')
    expect(html).not.toContain('data-tool-availability="unverified"')
    const asset = await serveWebUi(new Request('http://localhost/assets/missing.js'))
    expect(asset.status).toBe(404)
    expect(await asset.text()).toBe('Not Found')
    const known = await serveWebUi(new Request('http://localhost/panel/domains'))
    expect(known.status).toBe(200)
    expect(await known.text()).toContain('data-tool-availability="unverified"')
  })

  it('does not copy a foreign account id from the query onto an error page', async () => {
    const response = await serveWebUi(new Request('http://localhost/panel?accountId=foreign-account-id'), async () => ({
      surface: 'xpanel' as const,
      visibility: { principal: owner },
      error: { status: 404 as const, workspaceHref: '/panel' },
    }))
    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain('foreign-account-id')
  })
})
