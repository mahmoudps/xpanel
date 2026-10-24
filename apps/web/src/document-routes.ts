import { navigation, registeredDocumentAliases } from '@xpanel/catalog'
import { designReferenceRoutesEnabled } from './design-board.ts'

export type DocumentSurface = 'login' | 'xwhm' | 'xpanel' | 'xmail'
export interface WebDocumentRoute { surface: DocumentSurface; activeRoute: string }
const routes = new Map(navigation.flatMap(surface => surface.sections.flatMap(section => section.pages.map(page => [page.route, surface.surface] as const))))

for (const alias of registeredDocumentAliases) {
  const surface = routes.get(alias.parentRoute)
  if (surface) routes.set(alias.route, surface)
}

/** Recognizes product documents only. It does not grant a capability or authorize an account. */
export function resolveWebDocumentRoute(pathname: string): WebDocumentRoute | null {
  if (pathname === '/login') return { surface: 'login', activeRoute: '/login' }
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  if (path === '/' || path === '/panel') return { surface: 'xpanel', activeRoute: '/home' }
  if (designReferenceRoutesEnabled() && (path === '/design/system' || path === '/design/components' || path === '/design/navigation')) return { surface: 'xpanel', activeRoute: path }
  if (path === '/mail') return { surface: 'xmail', activeRoute: '/mail/inbox' }
  const surface = routes.get(path)
  if (surface) return { surface, activeRoute: path }
  if (path.startsWith('/panel/')) {
    const accountPath = path.slice('/panel'.length)
    if (routes.get(accountPath) === 'xpanel') return { surface: 'xpanel', activeRoute: accountPath }
  }
  return null
}

export interface NavigationContext {
  locale: 'en' | 'ar'
  theme: 'light' | 'dark'
  density?: 'comfortable' | 'compact'
  accountId?: string
  activeRoute?: string
}

/** Keeps explicit destination choices and carries only the reviewed UI context parameters. */
export function contextualizeNavigationHref(href: string, context: NavigationContext): string {
  if ((!href.startsWith('/') && !href.startsWith('?')) || href.startsWith('//')) return href
  if (href.startsWith('?') && !context.activeRoute) return href
  const url = new URL(href, `http://xpanel.invalid${context.activeRoute ?? '/'}`)
  if (!resolveWebDocumentRoute(url.pathname)) return href
  if (!url.searchParams.has('lang')) url.searchParams.set('lang', context.locale)
  if (!url.searchParams.has('theme')) url.searchParams.set('theme', context.theme)
  if (context.density && !url.searchParams.has('density')) url.searchParams.set('density', context.density)
  if (context.accountId && url.pathname !== '/login' && !url.searchParams.has('accountId')) url.searchParams.set('accountId', context.accountId)
  return `${url.pathname}${url.search}${url.hash}`
}

/** Applies URL context to our generated, quoted anchor attributes; it never selects or hides HTML content. */
export function contextualizeDocumentLinks(html: string, context: NavigationContext): string {
  return html.replace(/(<a\b[^>]*\bhref=")([^"]*)(")/g, (_match, start: string, raw: string, end: string) => {
    const href = raw.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    const target = contextualizeNavigationHref(href, context)
    const escaped = target.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    return `${start}${escaped}${end}`
  })
}
