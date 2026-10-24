import { describe, expect, it } from 'vitest'
import { renderWebApp } from './app.ts'
import { renderLoginSurface } from './surfaces/login.ts'

describe('development-disabled MFA presentation', () => {
  it.each(['en', 'ar'] as const)('renders truthful %s sign-in without factor inputs', locale => {
    const html = renderLoginSurface({ locale, audience: 'xwhm', mfaMode: 'disabled' })
    expect(html).toContain('data-mfa-disabled')
    expect(html).not.toMatch(/<[^>]+data-auth-mfa-fields|name="(?:totpCode|recoveryCode)"/)
    expect(html).toContain('name="password"')
    expect(html).toContain('data-auth-password-change')
    expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })

  it.each(['en', 'ar'] as const)('keeps %s stored factor state distinct from runtime verification', locale => {
    for (const kind of ['root', 'reseller', 'user'] as const) for (const configured of [false, true]) {
      const html = renderWebApp({ surface: kind === 'user' ? 'xpanel' : 'xwhm', locale, activeRoute: kind === 'user' ? '/security/account' : '/whm/security/sign-in', visibility: { principal: kind === 'user' ? { kind, id: 'fixture-owner', username: 'owner', accountId: 'fixture-account' } : { kind, id: 'fixture-' + kind, username: kind } }, security: { totpEnabled: configured }, mfaRuntimeMode: 'disabled' })
      const card = /<section[^>]*data-account-security="two-factor"[\s\S]*?<\/section>/.exec(html)![0]
      expect(card).toContain(`data-mfa-configured="${configured}"`)
      expect(card).toContain('data-mfa-disabled')
      expect(card).not.toMatch(/<form|data-mfa-enabled|data-mfa-recommendation|data-auth-recovery/)
    }
  })
})
