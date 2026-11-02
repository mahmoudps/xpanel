import type { PanelSurfaceProps } from '../../../../contract.ts'
import { NO_SETTINGS_AUTHORITY, type PanelSettingsAuthority } from './common.ts'
import { renderV2AccountLanguagePage, renderV2AccountPreferencesPage, renderV2ServiceUsersPage } from './preferences.ts'
import { renderV2AccountTeamPage } from './team.ts'

export { renderV2AccountLanguagePage, renderV2AccountPreferencesPage, renderV2ServiceUsersPage, renderV2AccountTeamPage }
export { PANEL_SETTINGS_CSS, NO_SETTINGS_AUTHORITY, type PanelSettingsAuthority } from './common.ts'

export function renderV2PanelPreferencesPage(props: PanelSurfaceProps, authority: PanelSettingsAuthority = NO_SETTINGS_AUTHORITY): string | undefined {
  switch (props.activeRoute) {
    case '/preferences': return renderV2AccountPreferencesPage(props, authority)
    case '/preferences/language': return renderV2AccountLanguagePage(props, authority)
    case '/preferences/users': return renderV2ServiceUsersPage(props, authority)
    case '/preferences/team': return renderV2AccountTeamPage(props, authority)
    default: return undefined
  }
}
