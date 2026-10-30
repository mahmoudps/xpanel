import type { Translate } from '../../../../../i18n.ts'
import type { WhmSurfaceProps } from '../../../../contract.ts'
import { DENIED_ADMIN_AUTHORITY, type WhmAdminAuthority } from '../server/common.ts'
import { renderV2WhmPanelSettings, renderV2WhmBranding } from './configuration.ts'
import { renderV2WhmLanguages, renderV2WhmPreferences } from './locales-preferences.ts'
import { renderV2WhmPanelTokens } from './tokens.ts'
import { renderV2WhmNotifications } from './notifications.ts'
import { renderV2WhmIntegrations, renderV2WhmDeveloper } from './integrations-developer.ts'
import { renderV2WhmPanelData } from './data.ts'
import { renderV2WhmWhmcs } from './whmcs.ts'
export { WHM_PANEL_CSS } from './styles.ts'
export { V2_PANEL_TOKEN_SCOPES } from './tokens.ts'
export { V2_PANEL_NOTIFICATION_EVENTS } from './notifications.ts'
export const V2_WHM_PANEL_ROUTES = ['/whm/panel/settings', '/whm/panel/data', '/whm/panel/branding', '/whm/panel/languages', '/whm/panel/notifications', '/whm/panel/integrations', '/whm/panel/whmcs', '/whm/panel/api-tokens', '/whm/panel/developer', '/whm/preferences'] as const

export function renderV2WhmPanelPage(t: Translate, props: WhmSurfaceProps, authority: WhmAdminAuthority = DENIED_ADMIN_AUTHORITY): string | undefined {
  switch (props.activeRoute) {
    case '/whm/panel/settings': return renderV2WhmPanelSettings(t, props, authority)
    case '/whm/panel/data': return renderV2WhmPanelData(t, props, authority)
    case '/whm/panel/branding': return renderV2WhmBranding(t, props, authority)
    case '/whm/panel/languages': return renderV2WhmLanguages(t, props, authority)
    case '/whm/panel/notifications': return renderV2WhmNotifications(t, props, authority)
    case '/whm/panel/integrations': return renderV2WhmIntegrations(t, props, authority)
    case '/whm/panel/whmcs': return renderV2WhmWhmcs(t, props, authority)
    case '/whm/panel/api-tokens': return renderV2WhmPanelTokens(t, props, authority)
    case '/whm/panel/developer': return renderV2WhmDeveloper(t, props, authority)
    case '/whm/preferences': return renderV2WhmPreferences(t, props, authority)
    default: return undefined
  }
}
