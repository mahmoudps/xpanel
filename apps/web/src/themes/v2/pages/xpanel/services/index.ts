import type { PanelSurfaceProps } from '../../../../contract.ts'
import type { PanelServiceAuthority } from './common.ts'
import { renderV2DnsPage } from './dns.ts'
import { renderV2TlsPage } from './tls.ts'
import { renderV2CronPage } from './cron.ts'

export { renderV2DnsPage } from './dns.ts'
export { renderV2TlsPage } from './tls.ts'
export { renderV2CronPage } from './cron.ts'
export { PANEL_SERVICES_CSS, type PanelServiceAuthority } from './common.ts'

/** Undefined leaves unrelated routes to their own renderer. */
export function renderV2PanelServicePage(props: PanelSurfaceProps, authority: PanelServiceAuthority = { canManage: false }): string | undefined {
  if (props.activeRoute === '/domains/zone-editor') return renderV2DnsPage(props, authority)
  if (props.activeRoute === '/security/ssl') return renderV2TlsPage(props, authority)
  if (props.activeRoute === '/advanced/cron') return renderV2CronPage(props, authority)
  return undefined
}
