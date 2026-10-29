import { describe, expect, it } from 'vitest'
import type { DocumentProps } from '../contract.ts'
import type { WebBranding } from '../../branding.ts'
import { renderV2Document } from './document.ts'
import { v2Stylesheet } from './assets.ts'

const props: DocumentProps = {
  htmlAttributes: 'lang="ar" dir="rtl" data-theme="dark" data-surface="xwhm" data-mfa-mode="optional" data-realtime-enabled="true" data-session="&quot;&gt;&lt;b&gt;"',
  htmlAttributeSuffix: ' data-status="unavailable" data-ui-theme="v2"',
  title: 'Accounts — Custom Panel', faviconHref: '/branding/favicon?v=0123456789abcdef',
  faviconContentType: 'image/svg+xml', headHtml: '<script id="i18n"></script>', bodyHtml: '<main id="content">Body</main>',
}
const branding: WebBranding = {
  companyName: 'Provider', productName: 'Custom Panel', footerText: '', hidePoweredBy: false,
  primaryColor: '#123abc', accentColor: '#456def', supportUrl: '', supportEmail: '',
  logoUrl: '/branding/logo?v=0123456789abcdef', faviconUrl: '/branding/favicon?v=0123456789abcdef',
}

describe('v2 document contract', () => {
  it('preserves protected core attributes and their order without duplicating the theme or status', () => {
    const html = renderV2Document(props)
    expect(html).toContain(`<html ${props.htmlAttributes}${props.htmlAttributeSuffix}>`)
    expect(html.match(/ data-ui-theme=/g)).toHaveLength(1)
    expect(html.match(/ data-status=/g)).toHaveLength(1)
    expect(html).toContain('data-mfa-mode="optional"')
    expect(html).toContain('data-session="&quot;&gt;&lt;b&gt;"')
  })

  it('keeps the core title and favicon, escaping text and quoted attribute values', () => {
    const html = renderV2Document({ ...props, title: '<b>Custom & Panel</b>', faviconHref: '/favicon?kind=a&v=b', faviconContentType: 'image/svg+xml" injected="no' })
    expect(html).toContain('<title>&lt;b&gt;Custom &amp; Panel&lt;/b&gt;</title>')
    expect(html).toContain('href="/favicon?kind=a&amp;v=b"')
    expect(html).toContain('type="image/svg+xml&quot; injected=&quot;no"')
    expect(html).not.toContain('<b>Custom')
    const withoutType = renderV2Document({ ...props, faviconContentType: undefined })
    expect(withoutType).toContain(`<link rel="icon" href="${props.faviconHref}">`)
  })

  it('emits core head and body once, after its own content-versioned stylesheet', () => {
    const html = renderV2Document(props)
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html.indexOf(v2Stylesheet.href)).toBeLessThan(html.indexOf(props.headHtml))
    expect(html.match(/id="i18n"/g)).toHaveLength(1)
    expect(html.match(/id="content"/g)).toHaveLength(1)
    expect(html).toContain(`<body>${props.bodyHtml}</body>`)
    expect(html).not.toContain('data-brand-footer')
  })

  it('preserves validated branding attributes and styles without inventing a new title or favicon', () => {
    const html = renderV2Document({ ...props, branding })
    expect(html).toContain(`<html ${props.htmlAttributes} data-brand-logo data-brand-colors${props.htmlAttributeSuffix}>`)
    expect(html).toContain('--xp-brand-primary:#123abc;--xp-brand-accent:#456def;--xp-brand-logo:url("/branding/logo?v=0123456789abcdef")')
    expect(html.indexOf('id="xpanel-branding"')).toBeLessThan(html.indexOf(props.headHtml))
    expect(html).toContain(`<title>${props.title}</title>`)
    expect(html).toContain(`href="${props.faviconHref}"`)
  })

  it('rejects unsafe branding CSS and unowned logo paths through the core validator', () => {
    const html = renderV2Document({ ...props, branding: { ...branding, primaryColor: '#123456; background:url(https://bad.invalid)', accentColor: 'red', logoUrl: 'https://bad.invalid/logo.svg' } })
    expect(html).not.toContain('bad.invalid')
    expect(html).not.toContain('data-brand-logo')
    expect(html).not.toContain('data-brand-colors')
    expect(html).not.toContain('id="xpanel-branding"')
  })
})
