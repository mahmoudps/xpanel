import type { PanelSurfaceProps } from '../../../../contract.ts'
import { renderV2CloudflarePage } from './cloudflare.ts'
import { NO_DOMAIN_AUTHORITY, type DomainPageAuthority } from './common.ts'
import { renderV2DomainsPage } from './domains.ts'
import { renderV2DynamicDnsPage } from './dynamic-dns.ts'
import { renderV2SitePublisherPage } from './publisher.ts'
import { renderV2RedirectsPage } from './redirects.ts'
import { renderV2ReverseProxyPage } from './reverse-proxy.ts'
import { renderV2StagingPage } from './staging.ts'

export { DOMAIN_PAGES_CSS, type DomainPageAuthority } from './common.ts'
export { renderV2DomainsPage, renderV2DynamicDnsPage, renderV2SitePublisherPage, renderV2RedirectsPage, renderV2ReverseProxyPage, renderV2StagingPage, renderV2CloudflarePage }

/** The dispatcher binds only actual domain workflows. Core owns every admission decision. */
export function renderV2DomainPage(props: PanelSurfaceProps, authority: DomainPageAuthority = NO_DOMAIN_AUTHORITY): string | undefined {
  switch (props.activeRoute) {
    case '/domains': return renderV2DomainsPage(props, authority)
    case '/domains/staging': return renderV2StagingPage(props, authority)
    case '/domains/redirects': return renderV2RedirectsPage(props, authority)
    case '/domains/reverse-proxy': return renderV2ReverseProxyPage(props, authority)
    case '/domains/dynamic-dns': return renderV2DynamicDnsPage(props, authority)
    case '/domains/cloudflare': return renderV2CloudflarePage(props, authority)
    case '/domains/site-publisher': return renderV2SitePublisherPage(props, authority)
    default: return undefined
  }
}
