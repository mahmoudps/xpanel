import { renderV2WhmDomainsPage } from './index.ts'
import { renderV2WhmDnsPage, renderV2WhmDnsClusterPage, renderV2WhmDnsProvidersPage, renderV2WhmDnsToolsPage } from '../dns/index.ts'
import { renderV2WhmTlsInstallPage, renderV2WhmTlsPage } from '../tls/index.ts'
import type { WhmNetworkAuthority, WhmNetworkProps } from './common.ts'
import { CLOSED_NETWORK_AUTHORITY } from './common.ts'

export { renderV2WhmDomainsPage, renderV2WhmDnsPage, renderV2WhmDnsToolsPage, renderV2WhmDnsProvidersPage, renderV2WhmDnsClusterPage, renderV2WhmTlsPage, renderV2WhmTlsInstallPage }
export { WHM_NETWORK_CSS, type WhmNetworkAuthority, type WhmNetworkProps } from './common.ts'

const NETWORK_PAGES: Readonly<Record<string, (props: WhmNetworkProps, authority: WhmNetworkAuthority) => string>> = {
  '/whm/domains': renderV2WhmDomainsPage,
  '/whm/dns': renderV2WhmDnsPage,
  '/whm/dns/more': renderV2WhmDnsToolsPage,
  '/whm/dns/providers': renderV2WhmDnsProvidersPage,
  '/whm/dns/cluster': renderV2WhmDnsClusterPage,
  '/whm/ssl': renderV2WhmTlsPage,
  '/whm/ssl/install': renderV2WhmTlsInstallPage,
}

/** Exact registered routes only. Other families remain the surface dispatcher's responsibility. */
export const renderV2WhmNetworkPage = (props: WhmNetworkProps, authority: WhmNetworkAuthority = CLOSED_NETWORK_AUTHORITY): string | undefined =>
  NETWORK_PAGES[props.activeRoute ?? '']?.(props, authority)
