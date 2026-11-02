import type { WhmSurfaceProps } from '../../../../contract.ts'
import { NO_ACCOUNT_TOOL_AUTHORITY, type WhmAccountToolAuthority } from './common.ts'
import { renderV2WhmAccountAnnouncementsPage, renderV2WhmAccountBandwidthPage, renderV2WhmAccountHealthPage, renderV2WhmAccountTemplatesPage } from './pages.ts'

export { WHM_ACCOUNT_TOOLS_CSS, type WhmAccountToolAuthority } from './common.ts'
export { renderV2WhmAccountAnnouncementsPage, renderV2WhmAccountBandwidthPage, renderV2WhmAccountHealthPage, renderV2WhmAccountTemplatesPage } from './pages.ts'
export const V2_WHM_ACCOUNT_TOOL_ROUTES = Object.freeze(['/whm/accounts/health', '/whm/accounts/bandwidth', '/whm/accounts/announcements', '/whm/accounts/templates'] as const)
export function renderV2WhmAccountToolsPage(props: WhmSurfaceProps, authority: WhmAccountToolAuthority = NO_ACCOUNT_TOOL_AUTHORITY): string | undefined {
  switch (props.activeRoute) {
    case '/whm/accounts/health': return renderV2WhmAccountHealthPage(props, authority)
    case '/whm/accounts/bandwidth': return renderV2WhmAccountBandwidthPage(props, authority)
    case '/whm/accounts/announcements': return renderV2WhmAccountAnnouncementsPage(props, authority)
    case '/whm/accounts/templates': return renderV2WhmAccountTemplatesPage(props, authority)
    default: return undefined
  }
}
