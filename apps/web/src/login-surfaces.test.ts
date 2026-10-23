import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { renderLoginSurface, type LoginSurfaceProps } from './surfaces/login.ts'

const audiences = ['xpanel', 'xwhm', 'xmail'] as const
const brands = { xpanel: 'xPanel', xwhm: 'xWHM', xmail: 'xMail' }

describe('listener-specific sign-in presentation', () => {
  for (const audience of audiences) {
    for (const locale of ['en', 'ar'] as const) {
      it(audience + ' identifies its account boundary in ' + locale, () => {
        const html = renderLoginSurface({ audience, locale })
        assert.match(html, new RegExp('data-login-audience="' + audience + '"'))
        const heading = html.match(/<h1[^>]*>(.*?)<\/h1>/s)?.[1]
        assert.ok(heading?.includes(brands[audience]))
        assert.equal((html.match(/<h1\b/g) ?? []).length, 1)
        assert.match(html, /<form[^>]+aria-labelledby="login-heading"[^>]+data-login-form/)
        assert.doesNotMatch(html, /id="login-description"|<aside|<footer|xp-login-step|xp-login-emblem/)
        for (const field of ['login-username', 'login-password', 'login-otp', 'login-recovery-code']) {
          assert.ok(html.includes('for="' + field + '"'))
          assert.ok(html.includes('id="' + field + '"'))
        }
        assert.match(html, /name="username"[^>]+autocomplete="username"[^>]+autocapitalize="none"[^>]+spellcheck="false"/)
        assert.match(html, /name="password"[^>]+autocomplete="current-password"/)
        assert.match(html, /data-auth-mfa-fields[^>]+hidden/)
        assert.match(html, /data-auth-submit disabled/)
        assert.doesNotMatch(html, /name="(?:role|audience|targetSurface)"/)
        assert.doesNotMatch(html, /xp-login-surface-link/)
        assert.doesNotMatch(html, /Step 1 of 2|Argon2id|HttpOnly|Automatic lockout/)
        assert.doesNotMatch(html, /[\u0660-\u0669\u06f0-\u06f9]/)
      })
    }
  }

  it('never upgrades a target query into a listener identity', () => {
    const legacy = renderLoginSurface({ targetSurface: 'xwhm' })
    assert.doesNotMatch(legacy, /data-login-audience/)
    assert.match(legacy, /Sign in to xPanel/)
    const scoped = renderLoginSurface({ audience: 'xmail', targetSurface: 'xwhm' })
    assert.match(scoped, /Sign in to xMail/)
    const links = scoped.match(/href="[^"]+"/g) ?? []
    assert.equal(links.length, 2)
    assert.ok(links.every(link => link.includes('target=xmail')))
  })

  it('rejects malformed presentation selectors before rendering attributes or links', () => {
    const html = renderLoginSurface({ audience: '\"><img src=x onerror=unsafe()>', targetSurface: '\" onclick=unsafe()' } as unknown as LoginSurfaceProps)
    assert.doesNotMatch(html, /<img|onclick=|data-login-audience/)
    assert.match(html, /target=xpanel/)
  })

  it('describes the current account mail boundary without promising mailbox authentication', () => {
    const html = renderLoginSurface({ audience: 'xmail', locale: 'en' })
    assert.match(html, /Hosting account username/)
    assert.doesNotMatch(html, /Mail workspace|Your hosting, in one place|Account access|sign-in address|Mail tools/)
    assert.doesNotMatch(html, /type="email"|IMAP|SMTP|Sieve|delivery|name="email"/)
  })

  it('keeps administrator recovery commands out of account-facing sign-in pages', () => {
    for (const audience of ['xpanel', 'xmail'] as const) {
      const html = renderLoginSurface({ audience })
      assert.match(html, /Contact your hosting administrator/)
      assert.doesNotMatch(html, /data-cli-recovery|xpanel reset-password|disable-2fa/)
      assert.match(html, /<details[^>]+data-account-recovery><summary>Sign-in help<\/summary>/)
      assert.doesNotMatch(html, /<details[^>]+open/)
    }
    assert.match(renderLoginSurface({ audience: 'xwhm' }), /data-cli-recovery/)
    assert.match(renderLoginSurface(), /xpanel reset-password/)
  })

  it('escapes server-provided values and preserves observed lockout on every audience', () => {
    for (const audience of audiences) {
      const props: LoginSurfaceProps = {
        audience, username: '\"><script>unsafe()</script>', errorMessage: '<img src=x onerror=unsafe()>',
        lockout: { locked: true, lockedUntil: '\" onmouseover=unsafe()', retryAfterSec: 12.1 },
      }
      const html = renderLoginSurface(props)
      assert.doesNotMatch(html, /<script>|<img|data-locked-until="" onmouseover/)
      assert.match(html, /data-auth-state="locked"/)
      assert.match(html, /data-retry-after="13"/)
      assert.match(html, /data-lockout-state="locked"/)
      assert.match(html, /&lt;script&gt;/)
      assert.match(html, /&lt;img/)
    }
  })
})
