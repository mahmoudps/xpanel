// @vitest-environment node
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { builtinEnvironments, type EnvironmentReturn } from 'vitest/runtime'
import { renderWebApp, serveWebUi, type WebAppRenderState } from './app.ts'
import { isLocale, translator } from './i18n.ts'
import { LOGIN_CLIENT_SCRIPT } from './login-client.ts'
import { renderAccountSecurityCard } from './surfaces/account-security.ts'
import { classicTheme } from './themes/classic/index.ts'
import * as themeRegistry from './themes/registry.ts'
import { renderV2AccountSecurityCard, renderV2AccountSecuritySlot, V2_SECURITY_SLOT } from './themes/v2/surfaces/slots.ts'
import { parseMarkup } from './themes/markup.ts'

const owner = { kind: 'user' as const, id: 'security-owner', username: 'owner', accountId: 'security-account' }
const root = { kind: 'root' as const, id: 'security-root', username: 'root' }
const securityPages = [
  { surface: 'xwhm', route: '/whm/security/sign-in', principal: root },
  { surface: 'xpanel', route: '/security/account', principal: owner },
  { surface: 'xmail', route: '/mail/settings/security', principal: owner },
] as const

let testDom: EnvironmentReturn | undefined
beforeEach(async () => {
  testDom = await builtinEnvironments.jsdom.setup(globalThis, { jsdom: { url: 'https://panel.example.test/security/account', runScripts: 'outside-only' } })
  vi.stubGlobal('xpT', (message: string, values?: Readonly<Record<string, string | number>>) => {
    const lang = document.documentElement.lang
    return translator(isLocale(lang) ? lang : undefined)(message, values)
  })
})
afterEach(async () => {
  try {
    vi.restoreAllMocks()
    document.body.replaceChildren()
    vi.unstubAllGlobals()
  } finally {
    await testDom?.teardown(globalThis)
    testDom = undefined
  }
})

describe('core account security body dispatch', () => {
  const strictSecurityTheme = () => {
    const accountSecurity = vi.fn(renderV2AccountSecuritySlot)
    const securityBody = () => `<main><h1>Security</h1>${V2_SECURITY_SLOT}</main>`
    vi.spyOn(themeRegistry, 'resolveUiTheme').mockReturnValue({
      ...classicTheme,
      id: 'v2',
      renderUnavailable: securityBody,
      renderWhm: securityBody,
      renderPanel: securityBody,
      renderMail: securityBody,
      slots: { ...classicTheme.slots, accountSecurity },
    })
    return accountSecurity
  }

  it.each([400, 403, 404, 421, 500, 503] as const)('does not insert a security card into an actual %s status body on any security route', status => {
    const insert = strictSecurityTheme()
    for (const page of securityPages) {
      const html = renderWebApp({ surface: page.surface, activeRoute: page.route, visibility: { principal: page.principal }, security: { totpEnabled: false }, error: { status } })
      expect(html).toContain(`data-status-page="${status}"`)
      const nodes = parseMarkup(html)
      expect(nodes.filter(node => node.attrs.get('data-account-security') === 'two-factor')).toHaveLength(0)
      expect(nodes.some(node => node.attrs.has('data-auth-setup-form') || node.attrs.has('data-auth-enroll-form') || node.attrs.has('data-auth-totp-secret') || node.attrs.has('data-auth-recovery-codes'))).toBe(false)
      expect(nodes.some(node => node.attrs.get('id') === 'xpanel-realtime-client')).toBe(false)
    }
    expect(insert).not.toHaveBeenCalled()
  })

  it.each(securityPages)('still inserts exactly one strict theme-owned card on $surface $route', page => {
    const insert = strictSecurityTheme()
    const html = renderWebApp({ surface: page.surface, activeRoute: page.route, visibility: { principal: page.principal }, security: { totpEnabled: false } })
    expect(insert).toHaveBeenCalledTimes(1)
    const nodes = parseMarkup(html)
    expect(nodes.filter(node => node.attrs.get('data-account-security') === 'two-factor')).toHaveLength(1)
    expect(nodes.filter(node => node.tag === 'form' && node.attrs.has('data-auth-setup-form'))).toHaveLength(1)
    expect(nodes.some(node => node.attrs.has('data-v2-account-security-slot'))).toBe(false)
  })

  it('uses the server handed-off session fact despite conflicting URL display preferences', async () => {
    const insert = strictSecurityTheme()
    const state: WebAppRenderState = { surface: 'xpanel', visibility: { principal: owner }, security: { totpEnabled: false }, impersonation: { target: 'owner', issuer: 'operator' } }
    const response = await serveWebUi(new Request('https://panel.example.test/security/account?readOnly=false&impersonation=false'), async () => state)
    const html = await response.text()
    expect(insert).toHaveBeenCalledTimes(1)
    expect(insert.mock.calls[0]?.[0].security.readOnly).toBe(true)
    const nodes = parseMarkup(html)
    expect(nodes.some(node => node.attrs.get('data-auth-readonly') === 'true')).toBe(true)
    expect(nodes.some(node => node.attrs.has('data-impersonation-end'))).toBe(true)
    expect(nodes.some(node => node.attrs.has('data-auth-setup-form') || node.attrs.has('data-auth-enroll-form') || node.attrs.has('data-auth-totp-secret') || node.attrs.has('data-auth-recovery-codes'))).toBe(false)
  })

  it('does not create a handed-off state from request query parameters', async () => {
    const insert = strictSecurityTheme()
    await serveWebUi(new Request('https://panel.example.test/security/account?readOnly=true&impersonation=true'), async () => ({ surface: 'xpanel', visibility: { principal: owner }, security: { totpEnabled: false } }))
    expect(insert).toHaveBeenCalledTimes(1)
    expect(insert.mock.calls[0]?.[0].security.readOnly).toBeUndefined()
  })
})

describe('theme account security read-only state', () => {
  it.each(['en', 'ar'] as const)('preserves stored factor facts and disables factor management in both themes (%s)', locale => {
    for (const render of [renderAccountSecurityCard, renderV2AccountSecurityCard]) {
      for (const totpEnabled of [false, true]) {
        const html = render({ locale, totpEnabled, readOnly: true, principalKind: 'user', surface: 'xpanel' })
        expect(html).toContain('data-auth-readonly="true"')
        expect(html).toContain(`data-mfa-configured="${totpEnabled}"`)
        expect(html).toContain('id="account-security-heading"')
        expect(html).not.toMatch(/<form\b|data-auth-recovery-codes|data-auth-totp-secret/)
        expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
        if (locale === 'en') expect(html).toContain('Two-factor settings cannot be changed from a handed-off session.')
      }
      const disabled = render({ locale, totpEnabled: true, readOnly: true, mfaMode: 'disabled', principalKind: 'user', surface: 'xpanel' })
      expect(disabled).toContain('data-mfa-disabled')
      expect(disabled).toContain('data-mfa-configured="true"')
      expect(disabled).not.toContain('data-auth-setup-form')
    }
  })
})

const mountClient = (options: { readOnly?: boolean; disabled?: boolean } = {}) => {
  document.documentElement.lang = 'en'
  document.documentElement.setAttribute('data-mfa-mode', options.disabled ? 'disabled' : 'optional')
  document.documentElement.removeAttribute('data-status')
  // A stale optional card deliberately retains controls: the client must still honor the trusted card fact.
  document.body.innerHTML = renderAccountSecurityCard({ locale: 'en', totpEnabled: false, principalKind: 'user', surface: 'xpanel' })
  const card = document.querySelector<HTMLElement>('[data-account-security]')!
  if (options.readOnly) card.setAttribute('data-auth-readonly', 'true')
  const submissions = new Map<string, (event: Event) => Promise<void> | void>()
  for (const kind of ['setup', 'enroll']) {
    const form = document.querySelector<HTMLFormElement>(`[data-auth-${kind}-form]`)!
    vi.spyOn(form, 'addEventListener').mockImplementation((name, listener) => {
      if (name === 'submit') submissions.set(kind, listener as (event: Event) => Promise<void> | void)
    })
  }
  const listeners: { name: string; listener: EventListenerOrEventListenerObject }[] = []
  const originalAdd = document.addEventListener.bind(document)
  const spy = vi.spyOn(document, 'addEventListener').mockImplementation((name, listener, config) => { listeners.push({ name, listener }); originalAdd(name, listener, config) })
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, json: async (): Promise<Record<string, unknown>> => ({ csrfToken: 'synthetic-token' }) }))
  const location = { href: 'https://panel.example.test/security/account', origin: 'https://panel.example.test', assign: vi.fn(), reload: vi.fn() }
  runInNewContext(LOGIN_CLIENT_SCRIPT, { document, window: { document, location }, xpT: translator('en'), msgid, msgctxt, URL, Blob, Date, AbortController, setTimeout, clearTimeout, DOMParser, fetch })
  spy.mockRestore()
  return { card, fetch, location, submit: (kind: string) => submissions.get(kind)!(new Event('submit', { cancelable: true })), cleanup: () => { for (const entry of listeners) document.removeEventListener(entry.name, entry.listener) } }
}

describe('factor client respects server read-only state', () => {
  it('blocks programmatic setup/enroll submits and restart/recovery controls without any API call', async () => {
    const h = mountClient({ readOnly: true })
    try {
      expect([...h.card.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button')].every(control => control.disabled)).toBe(true)
      // Removing an attribute after binding cannot turn the captured server state into write authority.
      h.card.removeAttribute('data-auth-readonly')
      await h.submit('setup')
      await h.submit('enroll')
      for (const action of ['restart-enrollment', 'acknowledge-recovery']) document.querySelector<HTMLElement>(`[data-action="${action}"]`)!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
      expect(h.fetch).not.toHaveBeenCalled()
      expect(h.card.getAttribute('data-auth-state')).toBe('optional')
      expect([...h.card.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button')].every(control => control.disabled)).toBe(true)
      expect(h.location.reload).not.toHaveBeenCalled()
      expect(h.location.assign).not.toHaveBeenCalled()
    } finally { h.cleanup() }
  })

  it('does not bind synthetic enrollment controls into the development-disabled API flow', async () => {
    const h = mountClient({ disabled: true })
    try {
      await h.submit('setup')
      await h.submit('enroll')
      expect(h.fetch).not.toHaveBeenCalled()
    } finally { h.cleanup() }
  })

  it('retains optional factor setup and restores the submit control after a genuine server failure', async () => {
    const h = mountClient()
    try {
      const setup = document.querySelector<HTMLFormElement>('[data-auth-setup-form]')!
      const input = setup.querySelector<HTMLInputElement>('[name="password"]')!
      const submit = setup.querySelector<HTMLButtonElement>('button[type="submit"]')!
      input.value = 'synthetic-password'
      h.fetch.mockImplementation(async url => url.endsWith('/api/auth/me')
        ? { ok: true, status: 200, json: async () => ({ csrfToken: 'synthetic-token' }) }
        : { ok: false, status: 403, json: async () => ({ error: { message: 'Rejected test setup' } }) })
      await h.submit('setup')
      expect(h.fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(['/api/auth/me', '/api/auth/2fa/setup'])
      expect(JSON.parse(h.fetch.mock.calls[1]?.[1]?.body as string)).toEqual({ password: 'synthetic-password' })
      expect(submit.disabled).toBe(false)
      expect(setup.getAttribute('aria-busy')).toBe('false')
      expect(input.value).toBe('')
    } finally { h.cleanup() }
  })
})
