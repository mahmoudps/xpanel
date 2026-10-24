import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { loginDocumentTitle, renderLoginSurface, type LoginSurfaceProps } from './surfaces/login.ts'
import { renderWebApp } from './app.ts'

const audiences = ['xpanel', 'xwhm', 'xmail'] as const
const headings = {
  xpanel: { en: 'Sign in to xPanel', ar: 'تسجيل الدخول إلى <bdi dir="ltr">xPanel</bdi>' },
  xwhm: { en: 'Sign in to xWHM', ar: 'تسجيل الدخول إلى <bdi dir="ltr">xWHM</bdi>' },
  xmail: { en: 'Sign in to xMail', ar: 'تسجيل الدخول إلى <bdi dir="ltr">xMail</bdi>' },
}

describe('listener-specific sign-in presentation', () => {
  for (const audience of audiences) {
    for (const locale of ['en', 'ar'] as const) {
      it(audience + ' identifies its account boundary in ' + locale, () => {
        const html = renderLoginSurface({ audience, locale })
        assert.match(html, new RegExp('data-login-audience="' + audience + '"'))
        const heading = html.match(/<h1[^>]*>(.*?)<\/h1>/s)?.[1]
        assert.equal(heading, headings[audience][locale])
        const document = renderWebApp({ surface: 'login', locale, login: { audience } })
        assert.ok(document.includes('<title>' + loginDocumentTitle(audience, locale) + '</title>'))
        assert.ok(document.includes('href="/assets/favicon-' + audience + '.svg"'))
        assert.equal((document.match(/<main\b/g) ?? []).length, 1)
        assert.equal((document.match(/<h1\b/g) ?? []).length, 1)
        assert.match(document, /<main[^>]+aria-labelledby="login-heading"/)
        assert.match(document, /<header[^>]+role="banner"/)
        assert.match(document, /<form[^>]+aria-labelledby="login-heading"[^>]+data-login-form/)
        assert.match(html, /<span style="[^"]*">xPanel<\/span>/)
        assert.doesNotMatch(html, /xp-brand__name|xp-login-theme/)
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
        assert.match(html, /<footer[^>]+role="contentinfo"/)
        assert.doesNotMatch(html, /id="login-description"|<aside|xp-login-step|xp-login-emblem/)
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
      assert.ok(html.includes('<title>Sign in — xPanel</title>'))
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
    assert.match(scoped, /Sign in to xMail/)
    assert.match(scoped, /href="\/login\?lang=ar&amp;theme=dark&amp;target=xmail"/)
    assert.match(scoped, /href="\/mail\/inbox"/)
    assert.doesNotMatch(scoped, /target=xwhm/)
  })

  it('rejects malformed presentation selectors before rendering attributes or links', () => {
    const html = renderLoginSurface({ audience: '\"><img src=x onerror=unsafe()>', targetSurface: '\" onclick=unsafe()' } as unknown as LoginSurfaceProps)
    assert.doesNotMatch(html, /<img|onclick=|data-login-audience/)
    assert.match(html, /target=xpanel/)
  })

  it('asks xMail for the email address', () => {
    const html = renderLoginSurface({ audience: 'xmail', locale: 'en' })
    assert.match(html, /Email address/)
    assert.doesNotMatch(html, /Mailbox address|Hosting account username/)
    assert.doesNotMatch(html, /Mail workspace|Your hosting, in one place|Account access|sign-in address|Mail tools/)
    assert.doesNotMatch(html, /type="email"|IMAP|SMTP|Sieve|delivery|name="email"/)
  })

  it('keeps administrator recovery commands out of public sign-in pages', () => {
    for (const audience of ['xpanel', 'xmail', 'xwhm'] as const) {
      const html = renderLoginSurface({ audience })
      assert.doesNotMatch(html, /reset-password|disable-2fa|data-account-recovery|data-admin-note|<pre\b|<details/)
    }
    assert.match(renderLoginSurface({ audience: 'xwhm' }), /Forgot the root password\? Reset it from the server shell\./)
    assert.match(renderLoginSurface({ audience: 'xpanel' }), /Forgot your password\? Your hosting provider can reset it from xWHM\./)
    assert.match(renderLoginSurface(), /Sign in to xPanel/)
  })

  it('names the panel and links only safe sibling origins', () => {
    const bare = renderLoginSurface({ audience: 'xpanel', theme: 'light' })
    assert.match(bare, /data-login-product="xpanel"/)
    assert.doesNotMatch(bare, /aria-label="Dark theme"|xp-login-theme__label/)
    assert.match(bare, /data-password-label hidden>Show</)
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

  it('keeps the artboard sample off the live sign-in page', () => {
    const live = renderLoginSurface({ audience: 'xwhm', locale: 'en' })
    assert.doesNotMatch(live, /Orbit-plex-4127-lane|srv1\.xpanel\.test|203\.0\.113\.7|v1\.4\.2|data-login-companion/)
    assert.match(live, /data-login-lockout[^>]*hidden/)
    assert.match(live, /data-auth-state="credentials"/)
    const board = renderWebApp({
      surface: 'login', locale: 'en', theme: 'light',
      login: {
        audience: 'xwhm', username: 'root', passwordPreview: 'Orbit-plex-4127-lane', companionLockout: true,
        host: { hostname: 'srv1.xpanel.test', clientIp: '203.0.113.7', serverIp: '10.0.0.12', version: '1.4.2' },
        lockout: { locked: true, lockedUntil: '2026-10-22T14:19:00Z', lastAttemptAt: '2026-10-22T14:04:00Z', failures: 5, windowMinutes: 15, clientIp: '203.0.113.7', minutesRemaining: 14 },
      },
    })
    assert.match(board, /data-login-companion="true"/)
    assert.match(board, /data-auth-state="credentials"/)
    assert.match(board, /Sign-in is paused for 14 minutes after 5 failed attempts/)
    assert.doesNotMatch(board, /data-dc-tpl|id="dc-root"|data-sc-name/)
  })
})
