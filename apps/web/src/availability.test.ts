import { LOGIN_CLIENT_SCRIPT } from './login-client.ts'
import { Script } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { renderWebApp } from './app.ts'
import { renderMailSurface } from './surfaces/xmail.ts'
import { renderPanelSurface } from './surfaces/xpanel.ts'
import { renderWhmSurface } from './surfaces/xwhm.ts'
import { BROWSER_REALTIME_SCRIPT } from './ws-client.ts'

describe('verified production availability', () => {
  it.each(['xwhm', 'xpanel', 'xmail'] as const)('shows an honest unavailable workspace for %s without publishing service actions', surface => {
    const html = renderWebApp({ surface, locale: 'en' })
    expect(html).toContain('data-tool-availability="unverified"')
    expect(html).toContain('No verified tools are authorized for this account.')
    expect(html).not.toMatch(/<form\b|data-nav-route="|data-cmdk-item="/)
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
  })

  it('keeps login reachable and gives the command palette no privileged static routes', () => {
    const html = renderWebApp({ surface: 'login' })
    expect(html).toMatch(/<form\b/)
    expect(html).not.toContain('data-tool-availability="unverified"')
    expect(html).not.toContain('data-cmdk-item="')
  })

  it('renders an Arabic unavailable state with Latin digits', () => {
    const html = renderWebApp({ surface: 'xpanel', locale: 'ar' })
    expect(html).toContain('الأدوات غير متاحة بعد')
    expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })

  it('does not retain unfiltered favorites or navigation links in direct design renderers', () => {
    for (const render of [renderWhmSurface, renderPanelSurface, renderMailSurface]) {
      const html = render({ locale: 'en' })
      const sidebar = /<aside class="xp-sidebar"[\s\S]*?<\/aside>/.exec(html)?.[0] ?? ''
      expect(sidebar).toContain('data-navigation-empty="true"')
      expect(sidebar).not.toMatch(/<a\b/)
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
    expect(html).not.toMatch(/<form\b|data-nav-route="|data-cmdk-item="/)
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
