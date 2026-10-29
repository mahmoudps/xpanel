import { tools } from './data/index.ts'
import { navigation } from './data/navigation.ts'
import type { CatalogTool, NavPage, NavSurface } from './types.ts'
import { visibleTools, type VisibilityContext } from './visibility.ts'

/** Subdocuments inherit one canonical page's authority and capability placement. */
export const registeredDocumentAliases = Object.freeze([
  ...['/software/store', '/software/store/app', '/software/store/install', '/software/store/progress', '/software/store/installed', '/software/store/updates', '/software/store/error']
    .map(route => Object.freeze({ route, parentRoute: '/software/installer' })),
  ...['/whm/software/store', '/whm/software/store/extensions', '/whm/software/store/activity']
    .map(route => Object.freeze({ route, parentRoute: '/whm/software/site-software' })),
  // Search retains Inbox document authority; its own tool/feature gate stays independent.
  ...['/mail/sent', '/mail/drafts', '/mail/trash', '/mail/search']
    .map(route => Object.freeze({ route, parentRoute: '/mail/inbox' })),
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

/**
 * Mounted workspaces that open on their implemented core tool. The page's other tools stay
 * individually unqualified and the workspace keeps their controls disabled.
 */
const WORKSPACE_CORE_TOOLS: Readonly<Record<string, string>> = {
  // This manager's selected service jobs do not implement the other tools on the page.
  '/whm/services/more': 'service-manager',
  '/whm/services/health': 'service-config-health',
  '/whm/panel/developer': 'api-explorer',
  '/whm/panel/integrations': 'integrations-hub',
  '/whm/panel/settings': 'aapanel-panel-general',
  '/whm/panel/branding': 'panel-branding',
  '/whm/panel/languages': 'application-locales',
  '/whm/panel/whmcs': 'whmcs-integration',
  // The owner proxy switch is a domain workspace write; the page's other aaPanel proxy tools stay unqualified.
  '/domains/reverse-proxy': 'domains',
  '/email/calendars-contacts': 'calendars-contacts-management',
  '/mail/later': 'webmail-search',
  '/mail/settings/spam': 'webmail-spam-box',
  '/whm/software/updates': 'os-update',
  '/whm/software/catalog': 'software-center',
  // The software center's component catalog also holds these pages' module and runtime rows.
  '/whm/software/modules': 'software-center',
  '/whm/software/runtimes': 'software-center',
  '/whm/server/upgrade': 'panel-upgrade',
  // Read-only DNS checks; the bulk DNS record tools on this page stay unqualified.
  '/whm/email/quality': 'mail-quality',
  // Manual installation only; CSR generation stays unqualified.
  '/whm/ssl/install': 'install-ssl',
  // In-panel announcements only; the email-all tools stay unqualified.
  '/whm/accounts/announcements': 'panel-news',
  // Root-only facts and redacted bundle; tweak-support stays unqualified.
  '/whm/support': 'support-center',
  // Root-only zone checks and bulk TTL; hostname A record and DNS cleanup stay unqualified.
  '/whm/dns/more': 'zone-ttl-bulk',
  '/whm/monitoring/processes': 'process-manager',
  '/whm/monitoring/logs': 'aapanel-os-log-audit',
  '/whm/email/delivery': 'mail-delivery-reports',
  '/whm/email/server': 'mta-basic-editor',
  // Routing is part of the same root-only Postfix observation; a reseller DNS ACL does not admit it.
  '/whm/email/routing': 'mta-basic-editor',
  '/whm/databases': 'databases-admin',
  '/whm/databases/users': 'db-users-admin',
  // Server version, status and variables come from the same root MariaDB connection as the process list.
  '/whm/databases/servers': 'db-process-list',
  // Read-only MariaDB observations; the full tuning/apply tool remains unqualified.
  '/whm/databases/tuning': 'db-process-list',
  '/whm/server/cron': 'aapanel-cron-tasks',
  '/whm/server/networking': 'change-hostname',
  '/whm/services/ftp': 'ftp-server-config',
  '/whm/services/certificates': 'service-ssl-certificates',
  '/whm/accounts/health': 'account-health',
  '/whm/panel/notifications': 'notification-center',
  '/whm/security/antivirus': 'aapanel-clamav',
  '/whm/security/isolation': 'account-isolation',
}

/** Pages require their full capability set or an explicitly scoped implemented workspace. */
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
    if (page.route === '/whm/audit' && allowed.has('audit-log')) return true
    // Only these native operations admit the workspace; broader page tools remain
    // individually unqualified and their unavailable controls stay disabled.
    if (page.route === '/whm/plans/features') return allowed.has('feature-list-crud')
    if (['/whm/server/setup', '/whm/services/web', '/whm/security/ssh'].includes(page.route)) {
      return allowed.has('server-settings-edit')
    }
    if (page.route === '/software/php') return allowed.has('domain-php-settings')
    if (page.route === '/domains/zone-editor') return allowed.has('dns-zone-records')
    const core = WORKSPACE_CORE_TOOLS[page.route]
    return core !== undefined && allowed.has(core)
  }
  return design.map(surface => ({
    ...surface,
    sections: surface.sections.map(section => ({
      ...section,
      pages: section.pages.filter(pageReady),
    })).filter(section => section.pages.length > 0),
  })).filter(surface => surface.sections.length > 0)
}
