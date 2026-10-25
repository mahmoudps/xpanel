import { describe, expect, it } from 'vitest'
import { renderUserMenu, surfaceContextHref } from './chrome.ts'
import { renderSurfaceToolbar, renderSurfaceToolbarEnd } from './shell.ts'
import { DESIGN_TOKENS_CSS } from './tokens.ts'

const operator = {
  surface: 'xwhm' as const, locale: 'ar' as const, theme: 'light' as const,
  density: 'comfortable' as const, path: '/whm/audit?actor=operator&lang=ar',
  username: 'operator', role: 'مدير النظام', signedIn: true,
}

describe('shared workspace toolbar', () => {
  it('keeps search, transport state, identity and account controls in the same reachable toolbar', () => {
    const html = renderSurfaceToolbar({ ...operator, realtimeEnabled: true, generationId: 43, version: '0.1.0', activityHref: '/whm/jobs', menuLinks: [{ label: 'xMail', href: '/mail' }] })
    expect(html).toContain('class="xp-topbar__start"')
    expect(html).toContain('class="xp-page-search__label"')
    expect(html).toContain('data-action="open-cmdk"')
    expect(html).toContain('data-ws-indicator="disconnected"')
    expect(html).toContain('data-generation-chip="43"')
    expect(html).toContain('<bdi dir="ltr">0.1.0</bdi>')
    expect(html).toContain('data-lang-switch="en"')
    expect(html).toContain('data-user-menu')
    expect(html).toContain('data-theme-toggle="dark"')
    expect(html).toContain('data-density-option="compact"')
    expect(html).toContain('href="/whm/jobs"')
    expect(html).toContain('href="/mail"')
    expect(html).toContain('data-action="logout"')
    expect(html).not.toContain('Live stream connected')
  })

  it('retains filters and carries each UI context key once when switching language', () => {
    const href = surfaceContextHref(operator, { locale: 'en' })
    const url = new URL(href, 'https://xpanel.invalid')
    expect(url.pathname).toBe('/whm/audit')
    expect(url.searchParams.get('actor')).toBe('operator')
    expect(url.searchParams.getAll('lang')).toEqual(['en'])
    expect(url.searchParams.get('theme')).toBe('light')
    expect(url.searchParams.get('density')).toBe('comfortable')
    expect(renderSurfaceToolbarEnd(operator)).toContain('actor=operator&amp;lang=en')
  })

  it.each([undefined, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('does not advertise a generation for %s', generationId => {
    expect(renderSurfaceToolbarEnd({ ...operator, generationId })).not.toContain('data-generation-chip=')
  })

  it('preserves additional controls without accepting external or executable menu links', () => {
    const html = renderUserMenu({ ...operator, links: [
      { surface: 'xmail', origin: 'https://mail.example.test:2096' },
      { surface: 'xpanel', origin: 'https://panel.example.test:2083/path' },
    ], menuLinks: [
      { label: '<Active>', href: '/whm/jobs?state=active' },
      { label: 'Unsafe absolute', href: 'https://unapproved.example.test' },
      { label: 'Unsafe host', href: '//unapproved.example.test' },
      { label: 'Unsafe scheme', href: 'javascript:alert(1)' },
    ] })
    expect(html).toContain('data-panel-switch="xmail"')
    expect(html).toContain('https://mail.example.test:2096/mail/inbox?lang=ar&amp;theme=light&amp;density=comfortable')
    expect(html).toContain('&lt;Active&gt;')
    expect(html).not.toContain('unapproved.example.test')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('panel.example.test')
  })

  it('escapes identity data and never renders inline handlers from it', () => {
    const html = renderUserMenu({ ...operator, username: '<operator "test">' })
    expect(html).toContain('&lt;operator &quot;test&quot;&gt;')
    expect(html).not.toContain('<operator')
    expect(html).not.toMatch(/onclick=/)
  })

  it('retains the labelled desktop search and a single hierarchy for board cards', () => {
    expect(DESIGN_TOKENS_CSS).toContain('--xp-space-label: 8px;')
    expect(DESIGN_TOKENS_CSS).toContain('--xp-space-group: 24px;')
    expect(DESIGN_TOKENS_CSS).toContain('.xp-board-canvas { display: flex; flex-direction: column; gap: var(--xp-space-section);')
    expect(DESIGN_TOKENS_CSS).toContain('.xp-board-section__body { padding: 0;')
    expect(DESIGN_TOKENS_CSS).not.toContain('.xp-page-search > :is(.xp-page-search__label, kbd)')
    expect(DESIGN_TOKENS_CSS).not.toContain('.xp-board-section__head { padding: 16px 20px;')
  })
})
