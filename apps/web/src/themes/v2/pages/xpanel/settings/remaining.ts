import type { PanelSurfaceProps } from '../../../../contract.ts'
import { renderV2PanelAdvancedPage } from '../advanced/index.ts'
import { renderV2SiteSettingsPage } from '../domains/site-settings.ts'
import { renderV2WebDiskPage } from '../files/web-disk.ts'
import { renderV2PanelSecurityPage } from '../security/index.ts'
import { renderV2PanelSoftwarePage } from '../software/index.ts'
import { renderV2PanelStorePage } from '../store/index.ts'
import { NO_SETTINGS_AUTHORITY, type PanelSettingsAuthority } from './common.ts'
import { renderV2PanelPreferencesPage } from './index.ts'

export { PANEL_SETTINGS_CSS } from './common.ts'
export { PANEL_HTACCESS_CSS } from '../software/htaccess.ts'
export { renderV2SiteSettingsPage, renderV2WebDiskPage }
export const V2_PANEL_SETTINGS_ROUTES: readonly string[] = Object.freeze([
  '/security/ssl/issue', '/security/ssl/files', '/security/account', '/security/waf', '/security/ip-blocker', '/security/hotlink', '/security/ssh', '/security/virus-scanner',
  '/software/php', '/software/installer', '/software/htaccess', '/software/optimize',
  '/advanced/network-tools', '/advanced/indexes', '/advanced/error-pages', '/advanced/handlers', '/advanced/mime-types', '/advanced/api-shell',
  '/preferences', '/preferences/language', '/preferences/users', '/preferences/team',
  '/software/store', '/software/store/app', '/software/store/install', '/software/store/progress', '/software/store/installed', '/software/store/updates', '/software/store/error',
  '/files/web-disk', '/domains/site-settings',
])

/** A missing route remains missing: core must provide its own body instead of an outage fallback. */
export function renderV2PanelSettingsPage(props: PanelSurfaceProps, authority: PanelSettingsAuthority = NO_SETTINGS_AUTHORITY): string | undefined {
  if (props.activeRoute === '/files/web-disk') return renderV2WebDiskPage(props, authority)
  if (props.activeRoute === '/domains/site-settings') return renderV2SiteSettingsPage(props, authority)
  return renderV2PanelSecurityPage(props, authority) ?? renderV2PanelAdvancedPage(props, authority)
    ?? renderV2PanelSoftwarePage(props, authority) ?? renderV2PanelPreferencesPage(props, authority)
    ?? renderV2PanelStorePage(props, authority)
}
