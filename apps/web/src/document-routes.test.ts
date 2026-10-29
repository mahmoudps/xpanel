import { describe, expect, it } from 'vitest'
import { canonicalNavigationRoute, navigation } from '@xpanel/catalog'
import { serveWebUi } from './app.ts'
import { resolveSurfaceSection } from './shell.ts'
import { contextualizeDocumentLinks, contextualizeNavigationHref, resolveWebDocumentRoute } from './document-routes.ts'

describe('product document route identity and context', () => {
  it('keeps managed mail folder identity while inheriting Inbox qualification', () => {
    for (const route of ['/mail/sent', '/mail/drafts', '/mail/trash']) {
      expect(resolveWebDocumentRoute(route)).toEqual({ surface: 'xmail', activeRoute: route })
      expect(canonicalNavigationRoute(route)).toBe('/mail/inbox')
    }
  })
  it('recognizes every declared product page without promoting its capability', () => {
    for (const surface of navigation) for (const section of surface.sections) for (const page of section.pages) {
      expect(resolveWebDocumentRoute(page.route)).toEqual({ surface: surface.surface, activeRoute: page.route })
    }
  })
  it('keeps administrative catalog placeholders outside the implemented screen registry', () => {
    const routes = ['/whm/email/bcc', '/whm/email/marketing', '/whm/software/deployments', '/whm/software/application-projects', '/whm/software/composer', '/whm/services/ftp-log-analysis', '/whm/services/default-index']
    expect(routes).toHaveLength(7)
    for (const route of routes) {
      expect(resolveWebDocumentRoute(route)).toEqual({ surface: 'xwhm', activeRoute: route })
      expect(resolveSurfaceSection('xwhm', route)).toBeUndefined()
    }
  })
  it('normalizes reviewed entry aliases and rejects invented documents and reference files', () => {
    expect(resolveWebDocumentRoute('/panel')).toEqual({surface:'xpanel',activeRoute:'/home'})
    expect(resolveWebDocumentRoute('/panel/files/manager')).toEqual({surface:'xpanel',activeRoute:'/files/manager'})
    expect(resolveWebDocumentRoute('/mail')).toEqual({surface:'xmail',activeRoute:'/mail/inbox'})
    expect(resolveWebDocumentRoute('/whm/accounts/')).toEqual({surface:'xwhm',activeRoute:'/whm/accounts'})
    for (const path of ['/whm/does-not-exist','/panel/whm/accounts','/reference-a.dc.html','/support.js','/api/accounts','/whm-extra','/design/system','/design/components','/design/navigation']) expect(resolveWebDocumentRoute(path)).toBeNull()
  })
  it('retains language, theme, density and account while preserving destination overrides', () => {
    const context = {locale:'ar',theme:'light',density:'compact',accountId:'account-fixture'} as const
    const url = new URL(contextualizeNavigationHref('/domains?view=all#new',context),'http://localhost')
    expect(Object.fromEntries(url.searchParams)).toEqual({view:'all',lang:'ar',theme:'light',density:'compact',accountId:'account-fixture'})
    expect(url.hash).toBe('#new')
    expect(contextualizeNavigationHref('/home?lang=en&theme=dark',context)).toContain('lang=en&theme=dark')
    expect(contextualizeNavigationHref('/login',context)).not.toContain('accountId')
    for (const target of ['https://example.test/','//example.test/home','/api/domains','#content']) expect(contextualizeNavigationHref(target,context)).toBe(target)
  })
  it('escapes contextual attributes and leaves forms, assets and external links unchanged', () => {
    const html = '<a href="/home?view=all&amp;lang=en">Home</a><form action="/api/save"></form><a href="https://example.test/">External</a>'
    const output = contextualizeDocumentLinks(html,{locale:'ar',theme:'light',accountId:'a"<b>'})
    expect(output).toContain('view=all&amp;lang=en&amp;theme=light&amp;accountId=a%22%3Cb%3E')
    expect(output).toContain('<form action="/api/save"></form>')
    expect(output).toContain('<a href="https://example.test/">External</a>')
  })
  it('keeps the selected account and density when same-document locale or theme links replace the query', () => {
    const context = {locale:'ar',theme:'light',density:'compact',accountId:'selected-second-account',activeRoute:'/whm/accounts'} as const
    const localeUrl = new URL(contextualizeNavigationHref('?surface=xwhm&lang=en&theme=light',context),'http://localhost')
    expect(localeUrl.pathname).toBe('/whm/accounts')
    expect(Object.fromEntries(localeUrl.searchParams)).toEqual({surface:'xwhm',lang:'en',theme:'light',density:'compact',accountId:'selected-second-account'})
    const themeUrl = new URL(contextualizeNavigationHref('?surface=xwhm&lang=ar&theme=dark',context),'http://localhost')
    expect(themeUrl.searchParams.get('accountId')).toBe('selected-second-account')
    expect(themeUrl.searchParams.get('theme')).toBe('dark')
  })
})

describe('public login document identity and static icons', () => {
  it.each(['xpanel', 'xwhm', 'xmail'] as const)('serves a stable tenant-free SVG mark for %s', async audience => {
    const request = new Request('http://localhost/assets/favicon-' + audience + '.svg')
    const first = await serveWebUi(request)
    const second = await serveWebUi(new Request(request.url + '?accountId=synthetic-private-context&lang=ar&target=xwhm'))
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(first.headers.get('content-type')).toBe('image/svg+xml; charset=utf-8')
    const svg = await first.text()
    expect(await second.text()).toBe(svg)
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">')
    expect(svg).not.toMatch(/synthetic-private-context|script|foreignObject|href=|<text\b/)
    const otherIcons = await Promise.all(['xpanel', 'xwhm', 'xmail'].filter(value => value !== audience).map(async value => (await serveWebUi(new Request('http://localhost/assets/favicon-' + value + '.svg'))).text()))
    expect(otherIcons.every(other => other !== svg)).toBe(true)
  })

  it('does not promote a URL target into a document title or profile icon', async () => {
    const generic = await serveWebUi(new Request('http://localhost/login?target=xwhm&audience=xmail'))
    const genericHtml = await generic.text()
    expect(genericHtml).toContain('<title>xPanel Sign In — xPanel Control Plane</title>')
    expect(genericHtml).toContain('href="/assets/favicon.svg"')
    expect(genericHtml).not.toMatch(/<div\b[^>]*\bdata-login-audience=/)
    const bound = await serveWebUi(new Request('http://localhost/login?target=xwhm&lang=ar'), () => ({ surface: 'login', login: { audience: 'xmail', targetSurface: 'xmail' } }))
    const boundHtml = await bound.text()
    expect(boundHtml).toContain('<title>xMail — دخول البريد</title>')
    expect(boundHtml).toContain('href="/assets/favicon-xmail.svg"')
  })

  it('preserves the generic icon and refuses invented profile asset paths', async () => {
    const legacy = await serveWebUi(new Request('http://localhost/assets/favicon.svg'))
    const alias = await serveWebUi(new Request('http://localhost/favicon.ico'))
    expect(legacy.status).toBe(200)
    expect(await legacy.text()).toBe(await alias.text())
    for (const path of ['/assets/favicon-root.svg', '/assets/favicon-xmail.svg/extra']) {
      expect((await serveWebUi(new Request('http://localhost' + path))).status).toBe(404)
    }
  })
})
