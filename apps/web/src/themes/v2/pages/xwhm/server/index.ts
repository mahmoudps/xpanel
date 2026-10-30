import type { Translate } from '../../../../../i18n.ts'
import type { WhmSurfaceProps } from '../../../../contract.ts'
import { DENIED_ADMIN_AUTHORITY, type WhmAdminAuthority } from './common.ts'
import { renderV2WhmTerminal } from './terminal.ts'
import { renderV2WhmFileSharing, renderV2WhmServerNodes } from './sharing-nodes.ts'
import { renderV2WhmSetup } from './setup.ts'
import { renderV2WhmServerNetwork, renderV2WhmServerRole, renderV2WhmServerTimers } from './observations.ts'
import { renderV2WhmServerIps } from './ips.ts'
import { renderV2WhmTrustedProxies } from './trusted-proxies.ts'
export { DENIED_ADMIN_AUTHORITY, type WhmAdminAuthority } from './common.ts'
export { WHM_SERVER_CSS } from './styles.ts'

export const V2_WHM_SERVER_ROUTES = ['/whm/server/terminal', '/whm/server/file-sharing', '/whm/server/setup', '/whm/server/networking', '/whm/server/ips', '/whm/server/trusted-proxies', '/whm/server/cron', '/whm/server/nodes', '/whm/server/role'] as const

export function renderV2WhmServerPage(t: Translate, props: WhmSurfaceProps, authority: WhmAdminAuthority = DENIED_ADMIN_AUTHORITY): string | undefined {
  switch (props.activeRoute) {
    case '/whm/server/terminal': return renderV2WhmTerminal(t, props, authority)
    case '/whm/server/file-sharing': return renderV2WhmFileSharing(t, props, authority)
    case '/whm/server/setup': return renderV2WhmSetup(t, props, authority)
    case '/whm/server/networking': return renderV2WhmServerNetwork(t, props, authority)
    case '/whm/server/ips': return renderV2WhmServerIps(t, props, authority)
    case '/whm/server/trusted-proxies': return renderV2WhmTrustedProxies(t, props, authority)
    case '/whm/server/cron': return renderV2WhmServerTimers(t, props, authority)
    case '/whm/server/nodes': return renderV2WhmServerNodes(t, props, authority)
    case '/whm/server/role': return renderV2WhmServerRole(t, props, authority)
    default: return undefined
  }
}
