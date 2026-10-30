import { describe, expect, it } from 'vitest'
import type { DocumentProps } from '../contract.ts'
import type { WebBranding } from '../../branding.ts'
import { renderV2Document } from './document.ts'
import { v2Stylesheet } from './assets.ts'
import { v2SharedStylesheets, v2StylesheetsForDocument, v2ViewStylesheets } from './route-assets.ts'
import { v2Messages } from './messages.ts'
import { renderV2EmailAccountsPage } from './pages/xpanel/email/accounts.ts'
import { renderV2EmailForwardersPage } from './pages/xpanel/email/forwarders.ts'

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

  it('loads only the trusted surface route chunk in head after the shared foundation', () => {
    const context = { surface: 'xpanel' as const, route: '/files/trash' }
    const page = v2StylesheetsForDocument(context)[0]!
    const html = renderV2Document({ ...props, ...context })
    expect(html.indexOf(v2Stylesheet.href)).toBeLessThan(html.indexOf(page.href))
    expect(html.indexOf(page.href)).toBeLessThan(html.indexOf(props.headHtml))
    expect(html.split(page.path)).toHaveLength(2)
    expect(html).not.toContain('/assets/themes/v2/mail-workspace.css')
    expect(html.indexOf(page.href)).toBeLessThan(html.indexOf('</head>'))
    expect(html).toContain(`<body>${props.bodyHtml}</body>`)
  })

  it('adds no route stylesheet for a different surface or an unimplemented alias', () => {
    for (const context of [
      { surface: 'xmail' as const, route: '/mail/not-implemented' },
      { surface: 'xwhm' as const, route: '/mail/inbox' },
      { surface: 'login' as const, route: '/home' },
    ]) {
      const html = renderV2Document({ ...props, ...context })
      const stylesheetLinks = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(match => match[1])
      expect(stylesheetLinks).toEqual([expect.stringContaining('fonts.googleapis.com'), v2Stylesheet.href, ...v2SharedStylesheets.map(asset => asset.href)])
    }
  })

  it('preserves cached dependency order for the settings editor and exact store documents', () => {
    const editor = v2StylesheetsForDocument({ surface: 'xpanel', route: '/software/htaccess' })
    const html = renderV2Document({ ...props, surface: 'xpanel', route: '/software/htaccess', viewKind: 'workspace' })
    const stylesheetLinks = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(match => match[1])
    expect(stylesheetLinks).toEqual([
      expect.stringContaining('fonts.googleapis.com'), v2Stylesheet.href,
      ...v2SharedStylesheets.map(asset => asset.href), ...editor.map(asset => asset.href),
    ])
    expect(editor.map(asset => asset.path)).toEqual(['/assets/themes/v2/panel-settings.css', '/assets/themes/v2/panel-htaccess.css'])
    expect(html.indexOf(editor[1]!.href)).toBeLessThan(html.indexOf(props.headHtml))
    const store = renderV2Document({ ...props, surface: 'xwhm', route: '/whm/software/store/activity', viewKind: 'workspace' })
    expect(store).toContain('/assets/themes/v2/whm-data.css?v=')
    expect(store).not.toContain('/assets/themes/v2/panel-settings.css')
    expect(store).not.toContain('/assets/themes/v2/panel-htaccess.css')
    expect(store).toContain(`<body>${props.bodyHtml}</body>`)
  })

  it('delivers shared diagnostic fragment CSS once in the head of its owning documents', () => {
    for (const route of ['/whm/monitoring/health', '/whm/monitoring/limits', '/whm/monitoring/alerts', '/whm/monitoring/repair', '/whm/accounts/health']) {
      const context = { surface: 'xwhm' as const, route }
      const selected = v2StylesheetsForDocument(context)
      const html = renderV2Document({ ...props, ...context, viewKind: 'workspace' })
      expect(selected.at(-1)!.path).toBe('/assets/themes/v2/whm-diagnostics.css')
      for (const asset of selected) {
        expect(html.split(asset.href), route).toHaveLength(2)
        expect(html.indexOf(asset.href), route).toBeLessThan(html.indexOf('</head>'))
      }
      expect(html).toContain(`<body>${props.bodyHtml}</body>`)
    }
    expect(renderV2Document({ ...props, surface: 'xwhm', route: '/whm/monitoring/logs', viewKind: 'workspace' })).not.toContain('/assets/themes/v2/whm-diagnostics.css')
    expect(renderV2Document({ ...props, surface: 'xwhm', route: '/whm/monitoring/health', viewKind: 'status' })).not.toContain('/assets/themes/v2/whm-diagnostics.css')
  })

  it('selects the actual login or status view even when the requested route names a workspace', () => {
    for (const viewKind of ['login', 'status'] as const) {
      const html = renderV2Document({ ...props, viewKind, surface: 'xpanel', route: '/home' })
      expect(html).toContain(`href="${v2ViewStylesheets[viewKind].href}"`)
      expect(html).not.toContain('/assets/themes/v2/panel-home.css')
      for (const shared of v2SharedStylesheets) expect(html.split(shared.href)).toHaveLength(2)
    }
    const statusWithoutRoute = renderV2Document({ ...props, viewKind: 'status' })
    expect(statusWithoutRoute).toContain(`href="${v2ViewStylesheets.status.href}"`)
    const misleadingBody = renderV2Document({ ...props, bodyHtml: '<div class="v2-login v2-status-card"></div>' })
    expect(misleadingBody).not.toContain('/assets/themes/v2/login.css')
    expect(misleadingBody).not.toContain('/assets/themes/v2/status.css')
  })

  it('delivers email page styles once through cached head assets instead of duplicate inline blocks', () => {
    const t = v2Messages.translator('en')
    const pages = [
      { route: '/email/accounts', bodyHtml: renderV2EmailAccountsPage(t, {
        account: { username: 'alice', primaryDomain: 'example.test' }, domains: { state: 'unread' },
        users: { state: 'unread' }, canManage: false,
      }) },
      { route: '/email/forwarders', bodyHtml: renderV2EmailForwardersPage(t, { domains: [], mailboxes: [], canManage: false }) },
    ]
    for (const page of pages) {
      expect(page.bodyHtml).not.toContain('<style')
      const context = { surface: 'xpanel' as const, route: page.route }
      const stylesheet = v2StylesheetsForDocument(context)[0]!
      const html = renderV2Document({ ...props, ...context, bodyHtml: page.bodyHtml })
      expect(html.split(stylesheet.href)).toHaveLength(2)
      expect(html.indexOf(stylesheet.href)).toBeLessThan(html.indexOf('</head>'))
      expect(html).toContain(`<body>${page.bodyHtml}</body>`)
    }
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
