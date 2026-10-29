import { describe, expect, it } from 'vitest'
import { renderWebApp } from './app.ts'
import type { WebBranding } from './branding.ts'

const branding: WebBranding = { companyName: 'Example "Hosting"', productName: 'Example Panel', footerText: '© 2026 <Example>', hidePoweredBy: false,
  primaryColor: '#1d5bd6', accentColor: 'red;}', supportUrl: 'https://help.example.com/', supportEmail: 'help@example.com',
  logoUrl: '/branding/logo?v=0123456789abcdef', faviconUrl: '/branding/favicon?v=0123456789abcdef' }

describe('branding through the core document seam', () => {
  it('adds nothing when no branding is saved', () => {
    const html = renderWebApp({ surface: 'login', locale: 'en', login: { audience: 'xwhm', targetSurface: 'xwhm' } })
    // Theme CSS may name the hooks; the document itself carries no branding data.
    expect(html).not.toMatch(/<style id="xpanel-branding"|<html [^>]*data-brand-|<footer data-brand-footer|"\/branding\//)
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/assets/favicon-xwhm.svg" />')
  })
  it('gives every theme the product name, favicon, colour and logo data and an escaped semantic footer', () => {
    const html = renderWebApp({ surface: 'login', locale: 'en', login: { audience: 'xwhm', targetSurface: 'xwhm' }, branding })
    expect(html).toContain('<title>Example Panel — Server sign in</title>')
    expect(html).toContain('<link rel="icon" href="/branding/favicon?v=0123456789abcdef" />')
    expect(html).toContain('<style id="xpanel-branding">:root{--xp-brand-primary:#1d5bd6;--xp-brand-logo:url("/branding/logo?v=0123456789abcdef")}</style>')
    expect(html).toMatch(/<html [^>]* data-brand-logo data-brand-colors/)
    expect(html).toContain('<footer data-brand-footer role="contentinfo" aria-label="Example &quot;Hosting&quot;"><span data-brand-footer-text>© 2026 &lt;Example&gt;</span>')
    expect(html).toContain('<a data-brand-support-email href="mailto:help@example.com">')
    expect(html).toContain('Powered by xPanel')
    expect(renderWebApp({ surface: 'login', locale: 'en', branding: { ...branding, hidePoweredBy: true } })).not.toContain('Powered by')
    // Values that are not the exact shapes core produces never reach CSS or a link.
    expect(renderWebApp({ surface: 'login', locale: 'en', branding: { ...branding, primaryColor: '', logoUrl: 'javascript:alert(1)', faviconUrl: '//evil' } })).not.toMatch(/<style id="xpanel-branding"|javascript:|\/\/evil/)
  })
})
