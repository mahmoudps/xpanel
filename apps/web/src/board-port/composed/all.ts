import { xpanel_advanced } from './sections/xpanel-advanced.ts'
import { xpanel_databases } from './sections/xpanel-databases.ts'
import { xpanel_domains } from './sections/xpanel-domains.ts'
import { xpanel_files } from './sections/xpanel-files.ts'
import { xpanel_general } from './sections/xpanel-general.ts'
import { xpanel_security } from './sections/xpanel-security.ts'
import { xpanel_metrics } from './sections/xpanel-metrics.ts'
import { xpanel_software } from './sections/xpanel-software.ts'
import { xwhm_databases } from './sections/xwhm-databases.ts'
import { xwhm_accounts } from './sections/xwhm-accounts.ts'
import { xwhm_monitoring } from './sections/xwhm-monitoring.ts'
import { xwhm_domains } from './sections/xwhm-domains.ts'
import { xwhm_backups } from './sections/xwhm-backups.ts'
import { xwhm_email } from './sections/xwhm-email.ts'
import { xwhm_home } from './sections/xwhm-home.ts'
import { xwhm_software } from './sections/xwhm-software.ts'
import { xwhm_server } from './sections/xwhm-server.ts'
import { xwhm_security } from './sections/xwhm-security.ts'
import { xwhm_panel } from './sections/xwhm-panel.ts'
import { xwhm_resellers } from './sections/xwhm-resellers.ts'
import { xwhm_plans } from './sections/xwhm-plans.ts'
import { xwhm_services } from './sections/xwhm-services.ts'

/** Existing controllers always retain priority over additive route metadata. */
export const nativeComposedRoutePaths: ReadonlySet<string> = new Set([
  "/home",
  "/panel",
  "/resources",
  "/domains",
  "/domains/site-settings",
  "/metrics/traffic",
  "/metrics/web-stats",
  "/files/manager",
  "/files/trash",
  "/advanced/terminal",
  "/databases/mariadb",
  "/email/accounts",
  "/files/ftp",
  "/security/ssl",
  "/security/ssl/issue",
  "/security/account",
  "/domains/zone-editor",
  "/files/backup",
  "/files/directory-privacy",
  "/software/php",
  // Dedicated read-only catalog adapters own these canonical destinations.
  "/software/installer",
  "/whm/software/site-software",
  "/software/htaccess",
  "/advanced/cron",
  "/design/system",
  "/design/components",
  "/design/navigation",
  "/whm",
  "/whm/monitoring/io",
  "/whm/services",
  "/whm/services/health",
  "/whm/accounts",
  "/whm/accounts/new",
  "/whm/plans",
  "/whm/plans/features",
  "/whm/resellers",
  "/whm/dns",
  "/whm/backups/restore",
  "/whm/monitoring/server-info",
  "/whm/resellers/privileges",
  "/whm/server/ips",
  "/whm/email/outbound",
  "/whm/security/firewall",
  "/whm/audit",
  "/whm/panel/data",
  "/whm/server/upgrade",
  "/whm/transfers",
  "/whm/security/sign-in",
  "/whm/server/setup",
  "/whm/domains",
  "/whm/ssl",
  "/whm/backups",
  "/whm/services/web",
  "/whm/software/php",
  "/whm/security",
  "/whm/security/ssh"
])

export const composedRouteSpecs = [
  ...xpanel_advanced,
  ...xpanel_databases,
  ...xpanel_domains,
  ...xpanel_files,
  ...xpanel_general,
  ...xpanel_security,
  ...xpanel_metrics,
  ...xpanel_software,
  ...xwhm_databases,
  ...xwhm_accounts,
  ...xwhm_monitoring,
  ...xwhm_domains,
  ...xwhm_backups,
  ...xwhm_email,
  ...xwhm_home,
  ...xwhm_software,
  ...xwhm_server,
  ...xwhm_security,
  ...xwhm_panel,
  ...xwhm_resellers,
  ...xwhm_plans,
  ...xwhm_services,
] as const

export const composedXpanelRoutes = composedRouteSpecs.filter(spec => spec.surface === 'xpanel' && !nativeComposedRoutePaths.has(spec.route))
export const composedXwhmRoutes = composedRouteSpecs.filter(spec => spec.surface === 'xwhm' && !nativeComposedRoutePaths.has(spec.route))
