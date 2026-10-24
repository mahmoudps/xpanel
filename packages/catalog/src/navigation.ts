import { tools } from './data/index.ts'
import { navigation } from './data/navigation.ts'
import type { CatalogTool, NavPage, NavSurface } from './types.ts'
import { visibleTools, type VisibilityContext } from './visibility.ts'

const allowsPageRole = (page: NavPage, ctx: VisibilityContext): boolean => {
  if (ctx.principal.kind === 'user') return page.roles.includes('owner')
  if (ctx.principal.kind === 'root') return page.roles.some(role => role === 'root' || role.startsWith('reseller'))
  return page.roles.some(role => role === 'reseller'
    || (role.startsWith('reseller:') && ctx.reseller?.acl.some(acl => role === `reseller:${acl}`)))
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
    // Stored plan limits are enough to open this page. Its three tools stay
    // unverified until a host probe reports live series; a disabled feature still hides it.
    // A catalog that does not list those tools is not this page, so the shortcut stays off.
    if (page.route === '/resources' && accountResolved && ctx.disabledFeatures) {
      const listed = page.tools.flatMap(id => {
        const tool = catalog.find(entry => entry.id === id)
        return tool ? [tool] : []
      })
      const featureOff = listed.some(tool => typeof tool.featureKey === 'string' && tool.featureKey.length > 0 && ctx.disabledFeatures!.has(tool.featureKey))
      if (listed.length === page.tools.length && page.tools.length > 0 && !featureOff) return true
    }
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
