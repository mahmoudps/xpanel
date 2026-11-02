import type { PanelSurfaceProps } from '../../../../contract.ts'
import { NO_SETTINGS_AUTHORITY, type PanelSettingsAuthority } from '../settings/common.ts'
import { renderV2PanelStorePage } from '../store/index.ts'
import { renderV2PanelHtaccessPage, PANEL_HTACCESS_CSS } from './htaccess.ts'
import { renderV2OptimizePage } from './optimize.ts'
import { renderV2PanelPhpPage } from './php.ts'

export { renderV2PanelHtaccessPage, renderV2OptimizePage, renderV2PanelPhpPage, PANEL_HTACCESS_CSS }
export { PANEL_SETTINGS_CSS as PANEL_SOFTWARE_CSS } from '../settings/common.ts'

export function renderV2PanelSoftwarePage(props: PanelSurfaceProps, authority: PanelSettingsAuthority = NO_SETTINGS_AUTHORITY): string | undefined {
  switch (props.activeRoute) {
    case '/software/php': return renderV2PanelPhpPage(props, authority)
    case '/software/htaccess': return renderV2PanelHtaccessPage(props, authority)
    case '/software/optimize': return renderV2OptimizePage(props, authority)
    case '/software/installer': return renderV2PanelStorePage(props, authority)
    default: return undefined
  }
}
