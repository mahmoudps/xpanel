import { describe, expect, it } from 'vitest'
import { getSurfaceNavigationLabel, getSurfacePageTitle, renderLiveUpdatesIndicator, renderSurfaceShell, renderSurfaceUnavailable, resolveSurfaceSection } from './shell.ts'
import { renderMailSurface } from './surfaces/xmail.ts'
import { renderPanelSurface } from './surfaces/xpanel.ts'
import { renderWhmSurface } from './surfaces/xwhm.ts'

describe('shared surface shell', () => {
  it.each(['xpanel', 'xwhm', 'xmail'] as const)('provides one accessible mobile navigation and main landmark for %s', surface => {
    const html = renderSurfaceShell({ surface, locale: 'en', sidebar: '<nav>Tools</nav>', topbar: '<span>Workspace</span>', content: '<h1>Task</h1>' })
    expect(html.match(/<main\b/g)).toHaveLength(1)
    expect(html.match(/id="xp-sidebar"/g)).toHaveLength(1)
    expect(html).toContain('href="#main-content"')
    expect(html).toContain('id="main-content"')
    expect(html).toMatch(/data-action="toggle-mobile-nav"[^>]+aria-controls="xp-sidebar"[^>]+aria-expanded="false"/)
    expect(html).toMatch(/class="xp-sidebar"[^>]+data-xp-sidebar[^>]+tabindex="-1"/)
    expect(html).toMatch(/data-action="close-mobile-nav"[^>]+data-xp-nav-backdrop hidden/)
    expect(html).toContain('data-xp-shell-content')
    expect(html).toMatch(/<details class="xp-toolbar-options" open data-xp-toolbar-options>/)
    expect(html).toContain('<summary class="xp-btn">Search & account</summary>')
    expect(html).toContain('<div class="xp-toolbar-options__content"><span>Workspace</span></div>')
    expect(html).toContain('<h1>Task</h1>')
  })

  it('localizes mobile controls and keeps ASCII digits', () => {
    const html = renderSurfaceShell({ surface: 'xpanel', locale: 'ar', sidebar: '<nav>248</nav>', topbar: '', content: '<h1>الحساب 42</h1>' })
    expect(html).toContain('إغلاق القائمة')
    expect(html).toContain('انتقل إلى المحتوى')
    expect(html).toContain('البحث والحساب')
    expect(html).toContain('الحساب 42')
    expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })

  it('escapes the unavailable state return route', () => {
    expect(renderSurfaceUnavailable('en', '/home?value="unsafe"')).toContain('href="/home?value=&quot;unsafe&quot;"')
  })

  it('reports unavailable updates when transport is disabled, and connecting only for enabled transport', () => {
    const disabled = renderLiveUpdatesIndicator('en', false)
    expect(disabled).toContain('data-ws-indicator="unavailable"')
    expect(disabled).toContain('Live updates unavailable')
    expect(disabled).not.toContain('Connecting')
    expect(renderLiveUpdatesIndicator('ar', false)).toContain('التحديثات المباشرة غير متاحة')
    const enabled = renderLiveUpdatesIndicator('en', true)
    expect(enabled).toContain('data-ws-indicator="disconnected"')
    expect(enabled).toContain('Connecting')
    expect(enabled).not.toContain('Live stream connected')
  })

  it('renders missing identity data without manufacturing hosting or mailbox activity', () => {
    for (const html of [renderPanelSurface(), renderWhmSurface(), renderMailSurface()]) {
      expect(html).toContain('data-screen="unavailable"')
      expect(html).not.toMatch(/<form\b|data-generation-chip=|alice-shop\.com|Preflight Passed|Payout #/)
    }
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('does not advertise an absent generation record from %s', generationId => {
    const html = renderWhmSurface({ principal: { kind: 'root', id: 'operator-test', username: 'operator' }, generationId })
    expect(html).not.toContain('data-generation-chip=')
  })

  it('uses the selected task as the single H1 and does not assert an unobserved active generation', () => {
    const html = renderWhmSurface({ principal: { kind: 'root', id: 'operator-test', username: 'operator' }, activeRoute: '/whm/accounts/new', generationId: 19 })
    expect(html.match(/<h1\b/g)).toHaveLength(1)
    expect(html).toContain('class="xp-page-title">Create account</h1>')
    expect(html).toContain('data-generation-chip="19"')
    expect(html).not.toContain('Gen #19 · active')
  })
})

describe('explicit surface screen selection', () => {
  it('names actual tasks in both locales and reuses existing Arabic navigation labels', () => {
    expect(getSurfacePageTitle('xpanel', 'domains', 'en', '/domains')).toBe('Domains')
    expect(getSurfacePageTitle('xwhm', 'create-account', 'ar', '/whm/accounts/new')).toBe('إنشاء حساب')
    expect(getSurfacePageTitle('xmail', 'compose', 'en', '/mail/compose')).toBe('Compose message')
    expect(getSurfaceNavigationLabel('xpanel', 'section', { id: 'domains', name: 'Domains' }, 'ar')).toBe('النطاقات')
    expect(getSurfaceNavigationLabel('xmail', 'page', { id: 'compose', name: 'Compose message' }, 'ar')).toBe('إنشاء رسالة')
  })
  it('separates account creation, IP tasks, and mail settings from their list screens', () => {
    expect(resolveSurfaceSection('xwhm', '/whm/accounts')).toBe('accounts')
    expect(resolveSurfaceSection('xwhm', '/whm/accounts/new')).toBe('create-account')
    expect(resolveSurfaceSection('xwhm', '/whm/server/ips')).toBe('ips')
    expect(resolveSurfaceSection('xwhm', '/whm/email/outbound')).toBe('mail-ips')
    expect(resolveSurfaceSection('xmail', '/mail/settings/filters')).toBe('filters')
    expect(resolveSurfaceSection('xmail', '/mail/settings/autoresponder')).toBe('autoresponder')
    expect(resolveSurfaceSection('xmail', '/mail/compose')).toBe('compose')
  })

  it('does not map unknown, unimplemented, or another surface routes to a dashboard', () => {
    expect(resolveSurfaceSection('xpanel', '/domains/not-a-screen')).toBeUndefined()
    expect(resolveSurfaceSection('xpanel', '/software/containers')).toBeUndefined()
    expect(resolveSurfaceSection('xmail', '/whm/accounts')).toBeUndefined()
    expect(resolveSurfaceSection('xwhm', '/mail/inbox')).toBeUndefined()
  })
})
