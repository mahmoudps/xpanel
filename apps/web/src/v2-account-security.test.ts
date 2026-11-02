// Uses the real registered theme. Synthetic catalog facts select document branches only.
import { describe, expect, it } from 'vitest'
import { tools, type CatalogTool } from '@xpanel/catalog'
import { defaultPlan, type Account, type Principal } from '@xpanel/core'
import { renderWebApp, serveWebUi, type WebAppRenderState } from './app.ts'
import { parseMarkup } from './themes/markup.ts'

const locales = ['en', 'ar'] as const
const plan = defaultPlan({ id: 'security-plan', name: 'Security plan' })
const account: Account = { id: 'security-account', username: 'securityowner', uid: 20031, gid: 20031, home: '/home/securityowner', primaryDomain: 'security.example.test', planId: plan.id, ownerId: null, status: 'active', suspendReason: null, contactEmail: 'owner@example.test', ipv4: '192.0.2.31', shell: 'none', createdAt: '2026-10-30T00:00:00Z' }
const principal: Principal = { kind: 'user', id: 'security-principal', username: account.username, accountId: account.id }
const catalog: CatalogTool[] = tools.map((tool): CatalogTool => ({ ...tool, status: 'verified', delivery: { ...tool.delivery, status: 'verified' } }))

function state(extra: Partial<WebAppRenderState> = {}): WebAppRenderState {
  return { surface: 'xpanel', activeRoute: '/security/account', uiTheme: 'v2', theme: 'dark', visibility: { principal }, panel: { account, plan }, catalog, ...extra }
}

function cards(html: string) {
  return parseMarkup(html).filter(node => node.template < 0 && node.attrs.get('data-account-security') === 'two-factor')
}

function card(html: string) {
  const matches = cards(html)
  expect(matches).toHaveLength(1)
  const current = matches[0]
  if (!current) throw new Error('Missing actual account-security card')
  expect(current.tag).toBe('section')
  return current
}

function expectNoEnrollment(html: string): void {
  const nodes = parseMarkup(html).filter(node => node.template < 0)
  for (const hook of ['data-auth-setup-form', 'data-auth-enroll-form', 'data-auth-totp-secret', 'data-auth-recovery-codes']) {
    expect(nodes.some(node => node.attrs.has(hook)), hook).toBe(false)
  }
}

describe('registered V2 account-security authority', () => {
  for (const locale of locales) {
    it('does not invent a factor state when authenticated factor facts are absent in ' + locale, { tags: ['feature'] }, () => {
      const html = renderWebApp(state({ locale, mfaRuntimeMode: 'disabled' }))
      expect(cards(html)).toHaveLength(0)
      expectNoEnrollment(html)
    })

    for (const configured of [false, true]) it('preserves configured=' + configured + ' while development disables enrollment in ' + locale, { tags: ['feature'] }, () => {
      const html = renderWebApp(state({ locale, security: { totpEnabled: configured }, mfaRuntimeMode: 'disabled' }))
      const current = card(html)
      expect(current.attrs.get('data-auth-state')).toBe('development-disabled')
      expect(current.attrs.get('data-mfa-configured')).toBe(String(configured))
      expect(current.attrs.has('data-mfa-disabled')).toBe(true)
      expectNoEnrollment(html)
      expect(html).not.toContain('data-v2-account-security-slot')
    })

    it('keeps optional enrollment available without making it mandatory in ' + locale, { tags: ['feature'] }, () => {
      const html = renderWebApp(state({ locale, security: { totpEnabled: false } }))
      expect(card(html).attrs.get('data-auth-state')).toBe('optional')
      expect(parseMarkup(html).filter(node => node.template < 0 && node.attrs.has('data-auth-setup-form'))).toHaveLength(1)
      expect(parseMarkup(html).filter(node => node.template < 0 && node.attrs.has('data-auth-enroll-form'))).toHaveLength(1)
      expect(html).not.toContain('data-mfa-required')
    })

    it('does not grant enrollment to a handed-off session in ' + locale, { tags: ['feature'] }, () => {
      const html = renderWebApp(state({ locale, security: { totpEnabled: false }, impersonation: { target: account.username, issuer: 'operator' } }))
      expect(card(html).attrs.get('data-auth-readonly')).toBe('true')
      expectNoEnrollment(html)
    })

    it('uses server factor policy despite conflicting request display preferences in ' + locale, { tags: ['feature'] }, async () => {
      const response = await serveWebUi(new Request('https://panel.example.test/security/account?theme=dark&mfaMode=optional&readOnly=false&impersonation=false&lang=' + locale), async () => state({ locale, security: { totpEnabled: true }, mfaRuntimeMode: 'disabled' }))
      const html = await response.text()
      expect(response.status).toBe(200)
      expect(card(html).attrs.get('data-auth-state')).toBe('development-disabled')
      expectNoEnrollment(html)
    })
  }
})
