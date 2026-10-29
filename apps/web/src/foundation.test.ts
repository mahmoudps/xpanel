// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import axe from 'axe-core'
import { renderUserMenu, roleLabel, surfaceContextHref } from './chrome.ts'
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

  it('preserves additional local controls without any panel switch or external or executable menu link', () => {
    const html = renderUserMenu({ ...operator, menuLinks: [
      { label: '<Active>', href: '/whm/jobs?state=active' },
      { label: 'Unsafe absolute', href: 'https://unapproved.example.test' },
      { label: 'Unsafe host', href: '//unapproved.example.test' },
      { label: 'Unsafe scheme', href: 'javascript:alert(1)' },
    ] })
    expect(html).not.toMatch(/data-panel-switch|https:\/\//)
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

describe('user menu visible identity and accessible name', () => {
  const textEngine = axe as typeof axe & { setup(root: Document): void; teardown(): void }
  const visibleTextOf = axe.commons.text as typeof axe.commons.text & { visible(element: Element): string }
  afterEach(() => { textEngine.teardown(); document.body.replaceChildren() })
  const principals = [
    { kind: 'root', id: 'private-root-principal', username: 'root' },
    { kind: 'user', id: 'private-owner-principal', username: 'browserowner', accountId: 'private-owner-account' },
  ] as const
  const contexts = principals.flatMap(principal => (['en', 'ar'] as const).map(locale => ({ principal, locale })))

  it.each(contexts)('includes the complete visible name and role for $principal.kind in $locale without changing scoped controls', ({ principal, locale }) => {
    const root = principal.kind === 'root'
    const role = roleLabel(principal.kind, locale)
    const path = root ? '/whm/security/sign-in' : '/mail'
    const html = renderUserMenu({
      surface: root ? 'xwhm' : 'xmail', locale, theme: 'light', density: 'compact', path,
      username: principal.username, role, signedIn: true,
      ...(!root ? { accountId: principal.accountId } : {}),
    })
    document.body.innerHTML = html
    textEngine.setup(document)
    const summary = document.querySelector<HTMLElement>('[data-user-menu] > summary')!
    const visibleText = visibleTextOf.visible(summary)
    const accessibleName = axe.commons.text.accessibleText(summary)
    const initial = principal.username.charAt(0).toLowerCase()
    expect(visibleText).toBe(`${initial} ${principal.username} ${role}`)
    expect(accessibleName).toContain(visibleText)
    expect(accessibleName).toBe(`${locale === 'ar' ? 'قائمة المستخدم' : 'User menu for'} ${visibleText}`)
    expect(summary.textContent).not.toContain(principal.id)
    expect(document.querySelector('[data-action="logout"]')).not.toBeNull()
    expect(document.querySelector('[data-theme-toggle="dark"]')).not.toBeNull()
    const security = new URL(document.querySelector<HTMLAnchorElement>('[data-security-link]')!.getAttribute('href')!, 'https://panel.example.test')
    expect(security.pathname).toBe(root ? '/whm/security/sign-in' : '/mail/settings/security')
    expect(security.searchParams.get('lang')).toBe(locale)
    expect(security.searchParams.get('theme')).toBe('light')
    expect(security.searchParams.get('density')).toBe('compact')
    expect(security.searchParams.get('accountId')).toBe(root ? null : principal.accountId)
  })
})
