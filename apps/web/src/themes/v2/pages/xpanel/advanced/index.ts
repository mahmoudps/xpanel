import type { PanelSurfaceProps } from '../../../../contract.ts'
import { NO_SETTINGS_AUTHORITY, type PanelSettingsAuthority } from '../settings/common.ts'
import { renderV2WebDirectivePage } from './directives.ts'
import { renderV2AccountApiExplorerPage, renderV2NetworkToolsPage } from './tools.ts'

export { renderV2WebDirectivePage, renderV2AccountApiExplorerPage, renderV2NetworkToolsPage }
export { PANEL_SETTINGS_CSS as PANEL_ADVANCED_CSS } from '../settings/common.ts'

export function renderV2PanelAdvancedPage(props: PanelSurfaceProps, authority: PanelSettingsAuthority = NO_SETTINGS_AUTHORITY): string | undefined {
  switch (props.activeRoute) {
    case '/advanced/network-tools': return renderV2NetworkToolsPage(props, authority)
    case '/advanced/api-shell': return renderV2AccountApiExplorerPage(props, authority)
    case '/advanced/indexes': return renderV2WebDirectivePage(props, 'indexes', authority)
    case '/advanced/error-pages': return renderV2WebDirectivePage(props, 'error-pages', authority)
    case '/advanced/mime-types': return renderV2WebDirectivePage(props, 'mime-types', authority)
    case '/advanced/handlers': return renderV2WebDirectivePage(props, 'handlers', authority)
    default: return undefined
  }
}
