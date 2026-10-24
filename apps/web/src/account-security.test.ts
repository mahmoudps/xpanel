import { describe, expect, it } from 'vitest'
import { renderWebApp } from './app.ts'
import { LOGIN_CLIENT_SCRIPT } from './login-client.ts'
import { renderLoginSurface } from './surfaces/login.ts'

const root = { kind: 'root' as const, id: 'root-id', username: 'root' }
const reseller = { kind: 'reseller' as const, id: 'reseller-id', username: 'resell' }
const owner = { kind: 'user' as const, id: 'user-id', username: 'owner', accountId: 'account-id' }

describe('optional two-factor enrollment', () => {
  it('keeps sign-in from treating enrollment as a gate', () => {
    expect(renderLoginSurface({ audience: 'xwhm' })).not.toMatch(/must complete enrollment|data-auth-setup-form|data-mfa-recommendation/)
    expect(LOGIN_CLIENT_SCRIPT).not.toMatch(/step\('enrollment-required'\)/)
    expect(LOGIN_CLIENT_SCRIPT).toMatch(/mfaEnrollmentRequired/)
    expect(LOGIN_CLIENT_SCRIPT).toMatch(/redirectToWorkspace\(\)/)
  })

  it.each(['en', 'ar'] as const)('recommends authenticator setup for root without blocking the workspace (%s)', locale => {
    const home = renderWebApp({
      surface: 'xwhm', locale, activeRoute: '/whm', visibility: { principal: root }, security: { totpEnabled: false },
    })
    expect(home).toContain('data-mfa-optional-link')
    expect(home).toContain('href="/whm/security/sign-in')
    expect(home).not.toMatch(/<form[^>]*data-auth-setup-form/)
    expect(home).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)

    const security = renderWebApp({
      surface: 'xwhm', locale, activeRoute: '/whm/security/sign-in', visibility: { principal: root }, security: { totpEnabled: false },
    })
    expect(security).toContain('data-mfa-recommendation')
    expect(security).toContain('data-auth-setup-form')
    expect(security).toContain('data-auth-recovery')
    expect(security).not.toContain('data-mfa-optional-link')
    expect(security).not.toMatch(/must complete enrollment|إلزامي/)
    expect(security).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
    if (locale === 'ar') expect(security).toMatch(/[\u0600-\u06ff]/)

    const enrolled = renderWebApp({
      surface: 'xwhm', locale, activeRoute: '/whm/security/sign-in', visibility: { principal: root }, security: { totpEnabled: true },
    })
    expect(enrolled).toContain('data-mfa-enabled="true"')
    const isolatedTechnicalText = [...enrolled.matchAll(/<bdi dir="ltr" class="xp-mono"(?: [^>]*)?>(.*?)<\/bdi>/g)]
      .map(match => match[1]!.replace(/<[^>]+>/g, ''))
    expect(isolatedTechnicalText.filter(text => text === 'xpanel disable-2fa root --confirm')).toHaveLength(1)
    expect(enrolled).not.toMatch(/<form[^>]*data-auth-setup-form/)
    expect(enrolled).not.toContain('data-mfa-recommendation')
  })

  it('offers optional enrollment to resellers and account owners without the root recommendation', () => {
    const resellerPage = renderWebApp({
      surface: 'xwhm', activeRoute: '/whm/security/sign-in', visibility: { principal: reseller }, security: { totpEnabled: false },
    })
    expect(resellerPage).toContain('data-auth-setup-form')
    expect(resellerPage).not.toContain('data-mfa-recommendation')
    expect(resellerPage).not.toContain('disable-2fa')

    const account = renderWebApp({
      surface: 'xpanel', activeRoute: '/security/account', visibility: { principal: owner }, security: { totpEnabled: false },
    })
    expect(account).toContain('data-auth-setup-form')
    expect(account).not.toContain('data-mfa-recommendation')
    expect(account).not.toContain('disable-2fa')

    const mail = renderWebApp({
      surface: 'xmail', activeRoute: '/mail/settings/security', visibility: { principal: owner }, security: { totpEnabled: true },
    })
    expect(mail).toContain('data-mfa-enabled="true"')
    expect(mail).not.toMatch(/<form[^>]*data-auth-setup-form/)
    expect(mail).not.toContain('disable-2fa')
  })
})
