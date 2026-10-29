import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { renderLoginSurface, type LoginSurfaceProps } from './surfaces/login.ts'

const origins = { xpanel: 'https://panel.example.test:2083', xwhm: 'https://whm.example.test:2087', xmail: 'https://mail.example.test:2096' } as const

describe('approved sign-in composition with real authentication boundaries', () => {
  for (const audience of ['xpanel', 'xwhm', 'xmail'] as const) {
    for (const locale of ['en', 'ar'] as const) {
      it(`shows only its own panel and keeps the contextual layout for ${audience}/${locale}`, () => {
        const html = renderLoginSurface({ audience, locale, theme: 'light', publicOrigin: origins[audience] })
        assert.match(html, /data-login-design="approved"/)
        assert.match(html, /class="xp-login-entry"/)
        assert.match(html, /<aside class="xp-login-aside"/)
        assert.match(html, /<footer class="xp-login-footer" role="contentinfo"/)
        // A sign-in page has no switcher, tab, link or name of another panel.
        assert.doesNotMatch(html, /xp-login-profile-tabs|data-login-profile=|data-panel-link=|name="(?:role|audience|targetSurface)"/)
        const own = new URL(origins[audience]).host
        assert.ok(html.includes(`<span class="xp-brand__sub" dir="ltr">${own}</span>`))
        assert.ok(html.includes(`<bdi dir="ltr">${own}</bdi>`))
        const visible = html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ')
        for (const other of (['xpanel', 'xwhm', 'xmail'] as const).filter(surface => surface !== audience)) {
          assert.ok(!html.includes(new URL(origins[other]).host), other)
          assert.ok(!visible.includes({ xpanel: 'xPanel', xwhm: 'xWHM', xmail: 'xMail' }[other]), other)
        }
        assert.equal((html.match(/<main\b/g) ?? []).length, 1)
        assert.equal((html.match(/<h1\b/g) ?? []).length, 1)
        assert.match(html, /method="post" action="\/api\/auth\/login"/)
        assert.match(html, /id="login-password" name="password" type="password"/)
        assert.doesNotMatch(html, /id="login-password"[^>]+\bvalue=/)
        assert.doesNotMatch(html, /xPanel v[0-9]|sc-camel-on-click|toTotp|verify\s*:/)
        assert.doesNotMatch(html, /[\u0660-\u0669\u06f0-\u06f9]/)
      })
    }
  }

  it('never uses a query target as listener identity', () => {
    const html = renderLoginSurface({ targetSurface: 'xwhm' })
    assert.doesNotMatch(html, /data-login-audience=|class="xp-login-profile-tabs"|class="xp-brand__sub"/)
    assert.match(html, /Sign in to xPanel/)
  })

  it('renders no host for an inexact or credential-bearing own origin', () => {
    for (const publicOrigin of ['https://user:do-not-render@panel.example.test:2083', 'http://panel.example.test:2083', 'https://panel.example.test:2083/login']) {
      const html = renderLoginSurface({ audience: 'xpanel', publicOrigin })
      assert.doesNotMatch(html, /do-not-render|panel\.example\.test|class="xp-brand__sub"/)
    }
  })

  it('shows one generic message after a failed handoff, keeping the sign-in form', () => {
    const html = renderLoginSurface({ audience: 'xmail', handoffFailed: true })
    assert.match(html, /data-auth-error data-lockout-state="unknown" data-handoff-failed >This sign-in link is invalid or has expired\./)
    assert.match(html, /data-login-form/)
    assert.doesNotMatch(renderLoginSurface({ audience: 'xmail' }), /data-handoff-failed/)
  })

  it('retains optional factor fields only behind the actual server challenge', () => {
    const html = renderLoginSurface({ audience: 'xwhm', mfaMode: 'optional' })
    assert.match(html, /data-auth-state="credentials"/)
    assert.match(html, /data-auth-mfa-fields data-2fa-step="unknown" hidden/)
    assert.match(html, /id="login-otp" name="totpCode"[^>]+pattern="\[0-9\]\{6\}"/)
    assert.match(html, /id="login-recovery-code" name="recoveryCode"/)
    assert.match(html, /aria-describedby="login-otp-help"/)
    assert.match(html, /aria-describedby="login-recovery-help"/)
    assert.match(html, /data-action="change-login-credentials"/)
    assert.match(html, /data-action="toggle-login-factor" data-login-factor-toggle/)
    assert.match(html, /id="login-factor-recovery" data-login-factor="recovery" hidden/)
    assert.match(html, /Enabling two-factor authentication is optional/)
    assert.doesNotMatch(html, /Password, then two-factor code|Step 1 of 2|Two-factor check passed/)
    assert.doesNotMatch(html, /name="(?:totpCode|recoveryCode)"[^>]+\bvalue=/)
  })

  it('omits factor inputs in disabled development mode without erasing account factors', () => {
    const html = renderLoginSurface({ audience: 'xpanel', mfaMode: 'disabled' })
    assert.match(html, /data-mfa-disabled/)
    assert.match(html, /Saved factors stay unchanged/)
    assert.doesNotMatch(html, /data-auth-mfa-fields|name="totpCode"|name="recoveryCode"|data-action="toggle-login-factor"|data-action="change-login-credentials"/)
    assert.match(html, /Two-factor verification is disabled in this development environment/)
  })

  it('renders the paused view only from the real lockout state and escapes observed values', () => {
    const html = renderLoginSurface({ audience: 'xmail', username: '<unsafe>', lockout: { locked: true, lockedUntil: '2026-10-25T12:30:00Z', retryAfterSec: 19.2 } })
    assert.match(html, /data-auth-state="locked"/)
    assert.match(html, /data-retry-after="20"/)
    assert.match(html, /data-login-lockout-details/)
    assert.match(html, /data-observed-lockout-until/)
    assert.match(html, /2026-10-25T12:30:00Z/)
    assert.match(html, /id="locked-username"[^>]+value="&lt;unsafe&gt;" disabled/)
    assert.doesNotMatch(html, /<unsafe>|Try again in 14 minutes|after 5 failed attempts from/)
    assert.match(html, /:not\(\[data-auth-state="locked"\]\) \.xp-login-lockout-details \{ display:none; \}/)
  })

  it('never accepts a caller-provided authenticated presentation or invents MFA success', () => {
    const html = renderLoginSurface({ audience: 'xwhm', authState: 'authenticated', authenticated: true } as LoginSurfaceProps)
    assert.match(html, /data-auth-state="credentials"/)
    assert.match(html, /class="xp-login-success" data-login-success data-required-auth-state="authenticated"/)
    assert.match(html, /\.xp-login-success \{ display:none;/)
    assert.match(html, /\[data-auth-state="authenticated"\] \.xp-login-success \{ display:flex;/)
    assert.doesNotMatch(html, /data-auth-state="authenticated"[^\]]/)
    assert.doesNotMatch(html, /Two-factor check passed|Session for .*203\.0\.113/)
  })
})
