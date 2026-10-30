import type { DocumentProps, ThemeSurface } from '../contract.ts'
import { createV2Stylesheet, type V2Stylesheet } from './stylesheet.ts'
import { V2_PANEL_HOME_CSS } from './pages/xpanel/home.ts'
import { V2_PANEL_RESOURCES_CSS } from './pages/xpanel/resources.ts'
import { EMAIL_ACCOUNTS_CSS } from './pages/xpanel/email/accounts.ts'
import { EMAIL_ROUTING_CSS } from './pages/xpanel/email/forwarders.ts'
import { V2_FILES_CSS } from './pages/xpanel/files/styles.ts'
import { PANEL_SERVICES_CSS } from './pages/xpanel/services/common.ts'
import { PANEL_DATABASES_CSS } from './pages/xpanel/databases/styles.ts'
import { DOMAIN_PAGES_CSS } from './pages/xpanel/domains/common.ts'
import { PANEL_OPERATIONS_CSS } from './pages/xpanel/operations/styles.ts'
import { PANEL_SETTINGS_CSS } from './pages/xpanel/settings/common.ts'
import { PANEL_HTACCESS_CSS } from './pages/xpanel/software/htaccess.ts'
import { PANEL_ADDITIONAL_CSS } from './pages/xpanel/email-tools/common.ts'
import { PANEL_UTILITY_CLIENT_CSS } from './pages/xpanel/settings/utility-client-templates.ts'
import { WHM_OVERVIEW_CSS } from './pages/xwhm/overview/index.ts'
import { WHM_ACCOUNTS_CSS } from './pages/xwhm/accounts/list.ts'
import { WHM_ACCOUNT_CREATE_CSS } from './pages/xwhm/accounts/create.ts'
import { HOST_PAGES_CSS } from './pages/xwhm/host/common.ts'
import { LIFECYCLE_PAGES_CSS } from './pages/xwhm/lifecycle/shared.ts'
import { WHM_PLANS_CSS } from './pages/xwhm/plans/common.ts'
import { WHM_RESELLERS_CSS } from './pages/xwhm/resellers/styles.ts'
import { WHM_NETWORK_CSS } from './pages/xwhm/domains/common.ts'
import { WHM_MAIL_CSS } from './pages/xwhm/mail/common.ts'
import { WHM_OBSERVATION_CSS } from './pages/xwhm/monitoring/common.ts'
import { WHM_RECOVERY_TOOLS_CSS } from './pages/xwhm/recovery-tools/common.ts'
import { WHM_DATA_COMMON_CSS } from './pages/xwhm/software/common.ts'
import { WHM_SERVER_CSS } from './pages/xwhm/server/styles.ts'
import { WHM_PANEL_CSS } from './pages/xwhm/panel/styles.ts'
import { WHM_DIAGNOSTIC_CLIENT_CSS } from './pages/xwhm/whm-diagnostic-client-templates.ts'
import { V2_MAIL_CSS } from './pages/xmail/styles.ts'
import { MAIL_WORKSPACES_CSS } from './pages/xmail/workspaces/common.ts'
import { MAIL_ORGANIZER_CSS } from './pages/xmail/workspaces/organizer.ts'
import { V2_LOGIN_CSS } from './surfaces/login.ts'
import { V2_STATUS_CSS } from './surfaces/status.ts'
import { V2_UNAVAILABLE_CSS } from './surfaces/unavailable.ts'
import { V2_SLOTS_CSS } from './surfaces/slots.ts'

export interface V2RouteStylesheet {
  readonly surface: ThemeSurface
  readonly routes: readonly string[]
  readonly stylesheet: Readonly<V2Stylesheet>
  readonly dependencies: readonly Readonly<V2Stylesheet>[]
}

const page = (surface: ThemeSurface, name: string, routes: readonly string[], css: string | readonly string[], dependencies: readonly Readonly<V2Stylesheet>[] = []): Readonly<V2RouteStylesheet> =>
  Object.freeze({ surface, routes: Object.freeze([...routes]), stylesheet: createV2Stylesheet(name, typeof css === 'string' ? [css] : css), dependencies: Object.freeze([...dependencies]) })

const mailFolderStylesheet = page('xmail', 'mail-workspace', ['/mail/inbox', '/mail/sent', '/mail/drafts', '/mail/trash', '/mail/compose'], V2_MAIL_CSS)
const panelSettingsStylesheet = page('xpanel', 'panel-settings', [
  '/security/ssl/issue', '/security/ssl/files', '/security/account', '/security/waf', '/security/ip-blocker',
  '/security/hotlink', '/security/ssh', '/security/virus-scanner', '/software/php', '/software/installer', '/software/optimize',
  '/advanced/network-tools', '/advanced/indexes', '/advanced/error-pages', '/advanced/handlers', '/advanced/mime-types', '/advanced/api-shell',
  '/preferences', '/preferences/language', '/preferences/users', '/preferences/team',
  '/software/store', '/software/store/app', '/software/store/install', '/software/store/progress',
  '/software/store/installed', '/software/store/updates', '/software/store/error', '/files/web-disk', '/domains/site-settings',
], PANEL_SETTINGS_CSS)

/** Branding/footer and document slots are shared by all actual views, including login and status. */
export const v2SharedStylesheets = Object.freeze([createV2Stylesheet('shared-slots', [V2_SLOTS_CSS])])

export const v2ViewStylesheets = Object.freeze({
  login: createV2Stylesheet('login', [V2_LOGIN_CSS]),
  status: createV2Stylesheet('status', [V2_STATUS_CSS]),
  unavailable: createV2Stylesheet('unavailable', [V2_UNAVAILABLE_CSS]),
})

/** Shared dynamic fragments load only where the exact selected document owns those fragments. */
export const v2SupplementalStylesheets: readonly Readonly<V2RouteStylesheet>[] = Object.freeze([
  page('xpanel', 'panel-virus-scan', ['/security/virus-scanner'], PANEL_UTILITY_CLIENT_CSS),
  page('xwhm', 'whm-diagnostics', [
    '/whm/monitoring/health', '/whm/monitoring/limits', '/whm/monitoring/alerts',
    '/whm/monitoring/repair', '/whm/accounts/health',
  ], WHM_DIAGNOSTIC_CLIENT_CSS),
])

/** Explicit renderer coverage. A catalog alias alone does not establish an implemented page. */
export const v2RouteStylesheets: readonly Readonly<V2RouteStylesheet>[] = Object.freeze([
  page('xpanel', 'panel-home', ['/home'], V2_PANEL_HOME_CSS),
  page('xpanel', 'panel-resources', ['/resources'], V2_PANEL_RESOURCES_CSS),
  page('xpanel', 'panel-email-accounts', ['/email/accounts'], EMAIL_ACCOUNTS_CSS),
  page('xpanel', 'panel-email-routing', ['/email/forwarders'], EMAIL_ROUTING_CSS),
  page('xpanel', 'panel-files', ['/files/manager', '/files/trash', '/files/directory-privacy'], V2_FILES_CSS),
  page('xpanel', 'panel-services', ['/domains/zone-editor', '/security/ssl', '/advanced/cron'], PANEL_SERVICES_CSS),
  page('xpanel', 'panel-databases', [
    '/databases/mariadb', '/databases/insights', '/databases/remote-access',
    '/databases/phpmyadmin', '/databases/postgresql', '/databases/phppgadmin',
  ], PANEL_DATABASES_CSS),
  page('xpanel', 'panel-domains', [
    '/domains', '/domains/staging', '/domains/redirects', '/domains/reverse-proxy',
    '/domains/dynamic-dns', '/domains/cloudflare', '/domains/site-publisher',
  ], DOMAIN_PAGES_CSS),
  page('xpanel', 'panel-operations', [
    '/files/backup', '/files/ftp', '/files/git', '/advanced/terminal',
    '/software/apps', '/software/containers', '/software/cache', '/software/packages',
  ], PANEL_OPERATIONS_CSS),
  panelSettingsStylesheet,
  page('xpanel', 'panel-htaccess', ['/software/htaccess'], PANEL_HTACCESS_CSS, [panelSettingsStylesheet.stylesheet]),
  page('xpanel', 'panel-email-observations', [
    '/email/mailing-lists', '/email/filters', '/email/deliverability', '/email/spam-filters',
    '/email/spam-quarantine', '/email/archive', '/email/encryption', '/email/calendars-contacts',
    '/health', '/server-information', '/metrics/traffic', '/metrics/logs', '/metrics/web-stats',
  ], PANEL_ADDITIONAL_CSS),
  page('xwhm', 'whm-overview', ['/whm'], WHM_OVERVIEW_CSS),
  page('xwhm', 'whm-accounts', ['/whm/accounts'], WHM_ACCOUNTS_CSS),
  page('xwhm', 'whm-account-create', ['/whm/accounts/new'], WHM_ACCOUNT_CREATE_CSS),
  page('xwhm', 'whm-host', ['/whm/services', '/whm/services/more', '/whm/security/firewall', '/whm/software/php'], HOST_PAGES_CSS),
  page('xwhm', 'whm-lifecycle', [
    '/whm/backups', '/whm/backups/restore', '/whm/backups/destinations',
    '/whm/transfers', '/whm/transfers/server', '/whm/server/upgrade',
  ], LIFECYCLE_PAGES_CSS),
  page('xwhm', 'whm-plans', ['/whm/plans', '/whm/plans/features', '/whm/plans/enhancements'], WHM_PLANS_CSS),
  page('xwhm', 'whm-resellers', [
    '/whm/resellers', '/whm/resellers/privileges', '/whm/resellers/more', '/whm/resellers/ips-nameservers',
  ], WHM_RESELLERS_CSS),
  page('xwhm', 'whm-network', [
    '/whm/domains', '/whm/dns', '/whm/dns/more', '/whm/dns/providers', '/whm/dns/cluster', '/whm/ssl', '/whm/ssl/install',
  ], WHM_NETWORK_CSS),
  page('xwhm', 'whm-mail', [
    '/whm/email/monitor', '/whm/email/queue', '/whm/email/delivery', '/whm/email/outbound', '/whm/email/spam', '/whm/email/quality',
    '/whm/email/routing', '/whm/email/relay', '/whm/email/server', '/whm/email/maintenance', '/whm/email/bcc', '/whm/email/marketing',
  ], WHM_MAIL_CSS),
  page('xwhm', 'whm-observations', [
    '/whm/monitoring/health', '/whm/monitoring/alerts', '/whm/monitoring/repair', '/whm/monitoring/performance',
    '/whm/monitoring/traffic', '/whm/monitoring/io', '/whm/monitoring/limits', '/whm/monitoring/processes',
    '/whm/monitoring/disk', '/whm/monitoring/logs', '/whm/monitoring/server-info', '/whm/monitoring/benchmark',
    '/whm/security', '/whm/security/intrusion', '/whm/security/flood', '/whm/security/waf', '/whm/security/isolation',
    '/whm/security/antivirus', '/whm/security/ssh', '/whm/security/panel-access', '/whm/security/sign-in',
    '/whm/jobs', '/whm/audit', '/whm/support',
  ], WHM_OBSERVATION_CSS),
  page('xwhm', 'whm-account-recovery', [
    '/whm/accounts/health', '/whm/accounts/bandwidth', '/whm/accounts/announcements', '/whm/accounts/templates',
    '/whm/backups/restore-more', '/whm/backups/files', '/whm/transfers/convert-addon',
  ], WHM_RECOVERY_TOOLS_CSS),
  page('xwhm', 'whm-data', [
    '/whm/databases', '/whm/databases/users', '/whm/databases/phpmyadmin', '/whm/databases/tuning', '/whm/databases/processes',
    '/whm/databases/servers', '/whm/databases/upgrade', '/whm/databases/redis', '/whm/databases/mongodb',
    '/whm/software/runtimes', '/whm/software/catalog', '/whm/software/site-software', '/whm/software/modules',
    '/whm/software/addon-services', '/whm/software/containers', '/whm/software/containers/engine', '/whm/software/updates',
    '/whm/software/deployments', '/whm/software/application-projects', '/whm/software/composer',
    '/whm/software/store', '/whm/software/store/extensions', '/whm/software/store/activity',
    '/whm/services/web', '/whm/services/health', '/whm/services/ftp', '/whm/services/dns',
    '/whm/services/certificates', '/whm/services/ftp-log-analysis', '/whm/services/default-index',
  ], WHM_DATA_COMMON_CSS),
  page('xwhm', 'whm-server', [
    '/whm/server/terminal', '/whm/server/file-sharing', '/whm/server/setup', '/whm/server/networking',
    '/whm/server/ips', '/whm/server/trusted-proxies', '/whm/server/cron', '/whm/server/nodes', '/whm/server/role',
  ], WHM_SERVER_CSS),
  page('xwhm', 'whm-panel', [
    '/whm/panel/settings', '/whm/panel/data', '/whm/panel/branding', '/whm/panel/languages', '/whm/panel/notifications',
    '/whm/panel/integrations', '/whm/panel/whmcs', '/whm/panel/api-tokens', '/whm/panel/developer', '/whm/preferences',
  ], WHM_PANEL_CSS),
  mailFolderStylesheet,
  page('xmail', 'mail-tools', [
    '/mail/search', '/mail/folders', '/mail/later', '/mail/calendar', '/mail/contacts', '/mail/settings/calendars',
    '/mail/settings/filters', '/mail/settings/spam', '/mail/settings/autoresponder', '/mail/settings/forwarders',
    '/mail/overview', '/mail/tools/disk-usage', '/mail/tools/connect-devices', '/mail/tools/track-delivery',
    '/mail/tools/mailing-lists', '/mail/settings/preferences', '/mail/settings/identities', '/mail/settings/security',
  ], [MAIL_WORKSPACES_CSS, MAIL_ORGANIZER_CSS], [mailFolderStylesheet.stylesheet]),
])

const byRoute = new Map<string, Readonly<V2RouteStylesheet>>()
for (const entry of v2RouteStylesheets) {
  for (const route of entry.routes) {
    if (byRoute.has(route)) throw new Error('Duplicate v2 page stylesheet route')
    byRoute.set(route, entry)
  }
}

/** Core passes the listener's surface and dispatched route; this selection never changes admission. */
export function v2StylesheetsForDocument(props: Pick<DocumentProps, 'route' | 'surface' | 'viewKind'>): readonly Readonly<V2Stylesheet>[] {
  if (props.viewKind === 'status') return [v2ViewStylesheets.status]
  if (props.viewKind === 'login') return [v2ViewStylesheets.login]
  if (props.viewKind !== undefined && props.viewKind !== 'workspace' && props.viewKind !== 'unavailable') return []
  const entry = props.route === undefined ? undefined : byRoute.get(props.route)
  const routeStylesheets = entry !== undefined && entry.surface === props.surface
    ? [...entry.dependencies, entry.stylesheet, ...v2SupplementalStylesheets.filter(extra => extra.surface === entry.surface && extra.routes.includes(props.route!)).map(extra => extra.stylesheet)] : []
  return props.viewKind === 'unavailable' ? [v2ViewStylesheets.unavailable, ...routeStylesheets] : routeStylesheets
}
