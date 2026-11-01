/// <reference lib="dom" />
// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import { tools, type CatalogTool } from '@xpanel/catalog'
import type { Account } from '@xpanel/core'
import { renderWebApp, serveWebUi, unavailableView, type WebAppRenderState } from './app.ts'
import { roleLabel } from './chrome.ts'
import { translator, type Locale } from './i18n.ts'
import { registeredThemeDocuments, type UiThemeId } from './themes/contract.ts'

// This is the Core presentation boundary. Current mailbox/session lifetime admission is
// separately exercised by the normal API producer tests; these labels grant no authority.
const mailbox = 'reader@example.test'
const reserved = 'mbx0123456789abcdef0123456789abcdef'
const catalog = tools.map<CatalogTool>(tool => ({ ...tool, status: 'implemented', delivery: { ...tool.delivery, status: 'implemented' } }))
const appearances = (['classic', 'v2'] as const).flatMap(uiTheme => (['en', 'ar'] as const).map(locale => ({ uiTheme, locale })))
const mailRoutes = registeredThemeDocuments().filter(document => document.surface === 'xmail').map(document => document.route)
const mailState = (locale: Locale, uiTheme: UiThemeId, route: string, suppliedMailbox: string | undefined, username = reserved): WebAppRenderState => ({
  surface: 'xmail', locale, uiTheme, activeRoute: route, catalog, mfaRuntimeMode: 'optional', security: { totpEnabled: false },
  visibility: { principal: { kind: 'user', id: '11111111-1111-4111-8111-111111111111', accountId: '22222222-2222-4222-8222-222222222222', username }, disabledFeatures: new Set() },
  ...(suppliedMailbox === undefined ? {} : { mail: { mailbox: suppliedMailbox } }),
})

beforeAll(async () => {
  expect(mailRoutes).toHaveLength(23)
  // Use the normal registered package preparation, without executing any browser script.
  const response = await serveWebUi(new Request('https://mail.example.test/mail/inbox'), () => mailState('en', 'v2', '/mail/inbox', mailbox))
  expect(response.status).toBe(200)
})

const menuFor = (input: WebAppRenderState): { document: Document; menu: HTMLDetailsElement; summary: HTMLElement } => {
  const document = new DOMParser().parseFromString(renderWebApp(input), 'text/html')
  const menus = document.querySelectorAll<HTMLDetailsElement>('details[data-user-menu]')
  expect(menus).toHaveLength(1)
  const menu = menus.item(0), summary = menu?.querySelector<HTMLElement>('summary')
  if (!menu || !summary) throw new Error('missing live user menu fixture')
  return { document, menu, summary }
}
const expectSessionControls = (menu: HTMLDetailsElement): void => {
  expect(menu.querySelector('button[data-action="logout"]')).not.toBeNull()
  const chooser = menu.querySelector<HTMLElement>('[data-ui-theme-preferences]')
  expect(chooser?.dataset.uiThemeCanRead).toBe('true')
  const form = chooser?.querySelector('[data-ui-theme-form]')
  expect(form).not.toBeNull()
  expect(form?.querySelector('[name="username"],[name="mailbox"],[name="principalId"]')).toBeNull()
}

describe('unqualified mailbox header labels', { tags: ['feature'] }, () => {
  const cases = appearances.flatMap(appearance => mailRoutes.map(route => ({ ...appearance, route })))
  it.each(cases)('uses the trusted mailbox in visible and accessible $uiTheme $locale $route header', ({ uiTheme, locale, route }) => {
    const input = mailState(locale, uiTheme, route, mailbox)
    const principal = input.visibility?.principal
    const descriptor = unavailableView(input, locale, 'light', 'comfortable', route)
    expect(descriptor.session).toEqual({ username: mailbox, role: '' })
    expect(descriptor.signedIn).toBe(true)
    expect(descriptor.visibility?.principal).toBe(principal)
    expect(input.visibility?.principal.username).toBe(reserved)
    expect(input.mail?.mailbox).toBe(mailbox)
    expect(descriptor.readOnlyFacts?.surface).toBe('xmail')
    if (descriptor.readOnlyFacts?.surface === 'xmail') expect(descriptor.readOnlyFacts.mail).toBe(input.mail)
    const { menu, summary } = menuFor(input)
    expect(summary.textContent).toContain(mailbox)
    expect(summary.getAttribute('aria-label')).toContain(mailbox)
    expect(menu.outerHTML).not.toContain(reserved)
    expect(summary.textContent).not.toContain(roleLabel('user', locale))
    expect(summary.getAttribute('aria-label')).not.toContain(roleLabel('user', locale))
    expectSessionControls(menu)
    const security = menu.querySelector<HTMLAnchorElement>('a[data-security-link]')
    if (!security) throw new Error('missing mailbox security menu link')
    const href = new URL(security.getAttribute('href') ?? '', 'https://mail.example.test')
    expect(href.pathname).toBe('/mail/settings/security')
    expect(href.searchParams.has('accountId')).toBe(false)
    expect(href.searchParams.has('mailbox')).toBe(false)
    expect(input.visibility?.principal).toBe(principal)
    expect(input.uiTheme).toBe(uiTheme)
  })

  const missing = [
    { name: 'absent facts', value: undefined, username: reserved },
    { name: 'empty address', value: '', username: reserved },
    { name: 'malformed address', value: 'not a mailbox', username: reserved },
    { name: 'URL-shaped address', value: 'https://mail.example.test/inbox', username: reserved },
    { name: 'multiline address', value: 'reader@example.test\nforged', username: reserved },
    { name: 'address-shaped principal without facts', value: undefined, username: 'principal@example.test' },
  ]
  const unavailableCases = appearances.flatMap(appearance => missing.map(example => ({ ...appearance, ...example })))
  it.each(unavailableCases)('keeps a neutral $uiTheme $locale header for $name', ({ uiTheme, locale, value, username }) => {
    // Missing-mailbox factor recovery is an existing admitted page, not a fabricated mailbox.
    const input = mailState(locale, uiTheme, '/mail/settings/security', value, username)
    const principal = input.visibility?.principal
    const descriptor = unavailableView(input, locale, 'light', 'comfortable', '/mail/settings/security')
    expect(descriptor.session).toBeUndefined()
    expect(descriptor.signedIn).toBe(true)
    expect(descriptor.visibility?.principal).toBe(principal)
    expect(input.visibility?.principal.username).toBe(username)
    const { menu, summary } = menuFor(input)
    expect(summary.textContent).toContain(translator(locale)('Account'))
    expect(summary.getAttribute('aria-label')).toContain(translator(locale)('Account'))
    expect(menu.outerHTML).not.toContain(username)
    expect(summary.textContent).not.toContain(roleLabel('user', locale))
    expect(summary.getAttribute('aria-label')).not.toContain(roleLabel('user', locale))
    expectSessionControls(menu)
    expect(input.mail?.mailbox).toBe(value)
    expect(input.visibility?.principal).toBe(principal)
  })
})

describe('other realm menu identity remains canonical', { tags: ['feature'] }, () => {
  const owner: Account = { id: '44444444-4444-4444-8444-444444444444', username: 'owner', uid: 20031, gid: 20031, home: '/home/owner', primaryDomain: 'owner.example.test',
    planId: '55555555-5555-4555-8555-555555555555', ownerId: null, status: 'active', suspendReason: null, contactEmail: 'owner@example.test', ipv4: '192.0.2.31', shell: 'none', createdAt: '2026-10-22T00:00:00Z' }
  const cases = appearances.flatMap(appearance => (['xpanel', 'xwhm'] as const).map(surface => ({ ...appearance, surface })))
  it.each(cases)('preserves the $surface $uiTheme $locale identity despite unrelated mail facts', ({ surface, uiTheme, locale }) => {
    const principal = surface === 'xpanel'
      ? { kind: 'user' as const, id: '66666666-6666-4666-8666-666666666666', username: owner.username, accountId: owner.id }
      : { kind: 'root' as const, id: '77777777-7777-4777-8777-777777777777', username: 'root' }
    const route = surface === 'xpanel' ? '/security/account' : '/whm/preferences'
    // Preferences uses the existing qualification-independent V2 WHM surface and its Root copy.
    const menuRole = surface === 'xwhm' && uiTheme === 'v2' && route === '/whm/preferences'
      ? translator(locale)('Root') : roleLabel(principal.kind, locale)
    const input: WebAppRenderState = { surface, uiTheme, locale, activeRoute: route, catalog, visibility: { principal, disabledFeatures: new Set() },
      security: { totpEnabled: false }, mail: { mailbox }, ...(surface === 'xpanel' ? { panel: { account: owner } } : { whm: { principal } }) }
    const descriptor = unavailableView(input, locale, 'light', 'comfortable', route)
    expect(descriptor.session).toEqual({ username: principal.username, role: roleLabel(principal.kind, locale), ...(principal.kind === 'user' ? { accountId: owner.id } : {}) })
    expect(descriptor.visibility?.principal).toBe(principal)
    expect(descriptor.signedIn).toBe(true)
    expect(input.accountId).toBeUndefined()
    const { menu, summary } = menuFor(input)
    expect(summary.textContent).toContain(principal.username)
    expect(summary.textContent).toContain(menuRole)
    expect(summary.getAttribute('aria-label')).toContain(principal.username)
    expect(summary.getAttribute('aria-label')).toContain(menuRole)
    expect(menu.outerHTML).not.toContain(mailbox)
    expectSessionControls(menu)
    expect(input.visibility?.principal).toBe(principal)
  })
})
