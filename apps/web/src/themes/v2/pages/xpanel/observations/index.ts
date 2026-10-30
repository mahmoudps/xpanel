import type { PanelSurfaceProps } from '../../../../contract.ts'
import { renderV2PanelSiteHealth, renderV2PanelServerInformation } from './health.ts'
import { renderV2PanelLogs } from './logs.ts'
import { renderV2PanelTraffic, renderV2PanelWebStatistics } from './traffic.ts'
import type { PanelObservationAuthority } from './common.ts'

export { renderV2PanelSiteHealth, renderV2PanelServerInformation, renderV2PanelLogs, renderV2PanelTraffic, renderV2PanelWebStatistics }
export { PANEL_OBSERVATIONS_CSS } from './common.ts'
export type { PanelObservationAuthority } from './common.ts'
export const V2_PANEL_OBSERVATION_ROUTES = Object.freeze(['/health', '/server-information', '/metrics/traffic', '/metrics/logs', '/metrics/web-stats'] as const)
export function renderV2PanelObservation(props: PanelSurfaceProps, authority?: PanelObservationAuthority): string | undefined {
  switch (props.activeRoute) {
    case '/health': return renderV2PanelSiteHealth(props, authority)
    case '/server-information': return renderV2PanelServerInformation(props, authority)
    case '/metrics/traffic': return renderV2PanelTraffic(props, authority)
    case '/metrics/logs': return renderV2PanelLogs(props, authority)
    case '/metrics/web-stats': return renderV2PanelWebStatistics(props, authority)
    default: return undefined
  }
}
