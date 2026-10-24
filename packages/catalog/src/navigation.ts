import { tools } from './data/index.ts'
import { navigation } from './data/navigation.ts'
import type { CatalogTool, NavPage, NavSurface } from './types.ts'
import { visibleTools, type VisibilityContext } from './visibility.ts'

/** Read-only subdocuments inherit one canonical page's authority and capability placement. */
export const registeredDocumentAliases = Object.freeze([
  ...['/software/store', '/software/store/app', '/software/store/install', '/software/store/progress', '/software/store/installed', '/software/store/updates', '/software/store/error']
    .map(route => Object.freeze({ route, parentRoute: '/software/installer' })),
  ...['/whm/software/store', '/whm/software/store/extensions', '/whm/software/store/activity']
    .map(route => Object.freeze({ route, parentRoute: '/whm/software/site-software' })),
])
const canonicalParents = new Map(registeredDocumentAliases.map(row => [row.route, row.parentRoute]))
export const canonicalNavigationRoute = (route: string): string => canonicalParents.get(route) ?? route

const pagesByRoute = new Map(navigation.flatMap(surface => surface.sections.flatMap(section => section.pages.map(page => [page.route, page] as const))))

const allowsPageRole = (page: NavPage, ctx: VisibilityContext): boolean => {
  if (ctx.principal.kind === 'user') return page.roles.includes('owner')
  if (ctx.principal.kind === 'root') return page.roles.some(role => role === 'root' || role === 'reseller' || role.startsWith('reseller:'))
  if (ctx.principal.kind !== 'reseller') return false
  return page.roles.some(role => role === 'reseller'
    || (role.startsWith('reseller:') && ctx.reseller?.acl.some(acl => role === `reseller:${acl}`)))
}

/** Role admission for a registered document, independent of tool qualification. */
export const canOpenRegisteredRoute = (route: string, ctx?: VisibilityContext): boolean => {
  const page = pagesByRoute.get(canonicalNavigationRoute(route))
  return ctx !== undefined && page !== undefined && allowsPageRole(page, ctx)
}

/** Registered documents may show disabled capabilities; this does not qualify any tool. */
export const visibleRegisteredNavigation = (
  ctx?: VisibilityContext,
  registry: readonly NavSurface[] = navigation,
): NavSurface[] => {
  if (ctx === undefined) return []
  return registry.map(surface => ({
    ...surface,
    sections: surface.sections.map(section => ({
      ...section,
      pages: section.pages.filter(page => allowsPageRole(page, ctx)),
    })).filter(section => section.pages.length > 0),
  })).filter(surface => surface.sections.length > 0)
}

/** A page exposes multiple actions, so every represented capability must be available. */
export const visibleNavigation = (
  ctx?: VisibilityContext,
  catalog: readonly CatalogTool[] = tools,
  design: readonly NavSurface[] = navigation,
): NavSurface[] => {
  if (ctx === undefined) return []
  const allowed = new Set(visibleTools(catalog, ctx).map(tool => tool.id))
  // Home opens once the session names an account. Its tools stay listed, qualified or not.
  const accountResolved = ctx.principal.kind === 'user' && ctx.principal.accountId.trim().length > 0
  if (allowed.size === 0 && !accountResolved) return []
  const pageReady = (page: NavPage): boolean => {
    if (!allowsPageRole(page, ctx)) return false
    if (page.route === '/home' && accountResolved) return true
    if (page.tools.length === 0) return false
    if (page.tools.every(id => allowed.has(id))) return true
    // The server dashboard reads the same host sample as Server Information.
    // Its own tools stay on this page, and the page opens once that probe is verified.
    if (page.route === '/whm' && allowed.has('server-information')) return true
    // The audit log opens once the audit_log probe can read the log. The page's
    // other tools stay listed and do not have to be verified first.
    return page.route === '/whm/audit' && allowed.has('audit-log')
  }
  return design.map(surface => ({
    ...surface,
    sections: surface.sections.map(section => ({
      ...section,
      pages: section.pages.filter(pageReady),
    })).filter(section => section.pages.length > 0),
  })).filter(surface => surface.sections.length > 0)
}
