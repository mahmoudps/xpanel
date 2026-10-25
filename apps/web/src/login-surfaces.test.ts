import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { renderLoginSurface, type LoginSurfaceProps } from './surfaces/login.ts'
import { renderWebApp } from './app.ts'

const audiences = ['xpanel', 'xwhm', 'xmail'] as const
const brands = { xpanel: 'xPanel', xwhm: 'xWHM', xmail: 'xMail' }
const headings = { xpanel: { en: 'Account sign in', ar: 'دخول الحساب' }, xwhm: { en: 'Server sign in', ar: 'دخول إدارة الخادم' }, xmail: { en: 'Mail sign in', ar: 'دخول البريد' } }

describe('listener-specific sign-in presentation', () => {
  for (const audience of audiences) {
    for (const locale of ['en', 'ar'] as const) {
      it(audience + ' identifies its account boundary in ' + locale, () => {
        const html = renderLoginSurface({ audience, locale })
        assert.match(html, new RegExp('data-login-audience="' + audience + '"'))
        const heading = html.match(/<h1[^>]*>(.*?)<\/h1>/s)?.[1]
        assert.equal(heading, headings[audience][locale])
        const document = renderWebApp({ surface: 'login', locale, login: { audience } })
        assert.ok(document.includes('<title>' + brands[audience] + ' — ' + headings[audience][locale] + '</title>'))
        assert.ok(document.includes('href="/assets/favicon-' + audience + '.svg"'))
        assert.equal((document.match(/<main\b/g) ?? []).length, 1)
        assert.equal((document.match(/<h1\b/g) ?? []).length, 1)
        assert.match(document, /<main[^>]+aria-labelledby="login-heading"/)
        assert.match(document, /<header[^>]+role="banner"/)
        assert.match(document, /<form[^>]+aria-labelledby="login-heading"[^>]+data-login-form/)
        assert.match(html, new RegExp('<span class="xp-brand__name" dir="ltr">' + brands[audience] + '</span>'))
        const reveal = html.match(/<button[^>]+data-action="toggle-password"[\s\S]*?<\/button>/)?.[0]
        assert.ok(reveal)
        assert.match(reveal, /type="button"/)
        assert.match(reveal, /aria-controls="login-password"/)
        assert.match(reveal, /aria-pressed="false"/)
        assert.ok(reveal.includes('aria-label="' + (locale === 'ar' ? 'إظهار كلمة المرور' : 'Show password') + '"'))
        assert.match(reveal, /data-password-show/)
        assert.match(reveal, /data-password-hide[^>]+hidden/)
        assert.equal((reveal.match(/<svg\b/g) ?? []).length, 2)

        assert.equal((html.match(/<h1\b/g) ?? []).length, 1)
        assert.match(html, /<form[^>]+aria-labelledby="login-heading"[^>]+data-login-form/)
        assert.match(html, /id="login-description"/)
        assert.match(html, /<aside[^>]+aria-label=/)
        assert.match(html, /<footer[^>]+role="contentinfo"/)
        assert.match(html, /data-login-design="approved"/)
        assert.match(html, /class="xp-login-profile-tabs"/)
        assert.match(html, /data-login-success data-required-auth-state="authenticated"/)
        assert.match(html, /data-login-lockout-details/)
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

  it('preserves an explicit escaped document title without changing the listener icon', () => {
    const html = renderWebApp({ surface: 'login', title: 'Operations <sign in>', login: { audience: 'xwhm' } })
    assert.ok(html.includes('<title>Operations &lt;sign in&gt;</title>'))
    assert.ok(html.includes('href="/assets/favicon-xwhm.svg"'))
  })

  it('keeps malformed or target-only identities on the generic document title and icon', () => {
    for (const login of [{ targetSurface: 'xmail' }, { audience: '__proto__' }, { audience: '\"><svg onload=unsafe()>' }] as LoginSurfaceProps[]) {
      const html = renderWebApp({ surface: 'login', login })
      assert.ok(html.includes('<title>xPanel Sign In — xPanel Control Plane</title>'))
      assert.ok(html.includes('href="/assets/favicon.svg"'))
      assert.doesNotMatch(html, /<div\b[^>]*\bdata-login-audience=|onload=unsafe/)
    }
    const workspace = renderWebApp({ surface: 'xwhm', login: { audience: 'xmail' } })
    assert.ok(workspace.includes('href="/assets/favicon.svg"'))
  })

  it('never upgrades a target query into a listener identity', () => {
    const legacy = renderLoginSurface({ targetSurface: 'xwhm' })
    assert.doesNotMatch(legacy, /data-login-audience/)
    assert.match(legacy, /Sign in to xPanel/)
    const scoped = renderLoginSurface({ audience: 'xmail', targetSurface: 'xwhm' })
    assert.match(scoped, /Mail sign in/)
    const links = scoped.match(/href="[^"]+"/g) ?? []
    assert.equal(links.length, 2)
    assert.ok(links.every(link => link.includes('target=xmail')))
  })

  it('rejects malformed presentation selectors before rendering attributes or links', () => {
    const html = renderLoginSurface({ audience: '\"><img src=x onerror=unsafe()>', targetSurface: '\" onclick=unsafe()' } as unknown as LoginSurfaceProps)
    assert.doesNotMatch(html, /<img|onclick=|data-login-audience/)
    assert.match(html, /target=xpanel/)
  })

  it('asks xMail for the mailbox address', () => {
    const html = renderLoginSurface({ audience: 'xmail', locale: 'en' })
    assert.match(html, /Mailbox address/)
    assert.doesNotMatch(html, /Hosting account username/)
    assert.doesNotMatch(html, /Mail workspace|Your hosting, in one place|Account access|sign-in address|Mail tools/)
    assert.doesNotMatch(html, /type="email"|IMAP|SMTP|Sieve|delivery|name="email"/)
  })

  it('keeps administrator recovery commands out of public sign-in pages', () => {
    for (const audience of ['xpanel', 'xmail'] as const) {
      const html = renderLoginSurface({ audience })
      assert.match(html, /This page cannot reset a password/)
      assert.doesNotMatch(html, /reset-password|disable-2fa/)
      assert.match(html, /<details[^>]+data-account-recovery><summary>Sign-in help<\/summary>/)
      assert.doesNotMatch(html, /<details[^>]+open/)
    }
    for (const html of [renderLoginSurface({ audience: 'xwhm' }), renderLoginSurface()]) {
      assert.match(html, /data-admin-note/)
      assert.match(html, /Server administrator/)
      assert.match(html, /operations runbook/)
      assert.doesNotMatch(html, /reset-password|disable-2fa|<pre\b/)
      assert.doesNotMatch(html, /<details[^>]+open/)
    }
  })

  it('names the panel, labels the theme control, and links only safe sibling origins', () => {
    const bare = renderLoginSurface({ audience: 'xpanel', theme: 'light' })
    assert.match(bare, /data-login-product="xpanel"/)
    assert.match(bare, /aria-label="Dark theme"/)
    assert.match(bare, /class="xp-login-theme__label"/)
    assert.match(bare, /data-password-label>Show</)
    assert.doesNotMatch(bare, /data-panel-link|mailto:/)
    const linked = renderLoginSurface({
      audience: 'xpanel', theme: 'light', supportEmail: 'ops@example.test',
      panels: [
        { surface: 'xpanel', origin: 'https://panel.example.test:2083' },
        { surface: 'xwhm', origin: 'https://whm.example.test:2087' },
        { surface: 'xmail', origin: 'http://mail.example.test:2096' },
        { surface: 'xmail', origin: 'https://user:pass@mail.example.test:2096' },
      ],
    })
    assert.match(linked, /data-panel-link="xwhm" href="https:\/\/whm\.example\.test:2087\/login\?lang=en&amp;theme=light"/)
    assert.match(linked, /mailto:ops@example.test/)
    assert.doesNotMatch(linked, /data-panel-link="xpanel"|data-panel-link="xmail"|http:\/\/mail/)
    assert.doesNotMatch(renderLoginSurface({ audience: 'xmail', supportEmail: 'not an email' }), /mailto:/)
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
