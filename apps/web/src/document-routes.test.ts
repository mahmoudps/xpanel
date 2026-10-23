import { describe, expect, it } from 'vitest'
import { navigation } from '@xpanel/catalog'
import { resolveSurfaceSection } from './shell.ts'
import { contextualizeDocumentLinks, contextualizeNavigationHref, resolveWebDocumentRoute } from './document-routes.ts'

describe('product document route identity and context', () => {
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
    for (const path of ['/whm/does-not-exist','/panel/whm/accounts','/reference-a.dc.html','/support.js','/api/accounts','/whm-extra']) expect(resolveWebDocumentRoute(path)).toBeNull()
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
