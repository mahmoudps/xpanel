import type { RenderedFile } from '@xpanel/core'

export const RESOLV_CONF_PATH = '/etc/resolv.conf'
/** NetworkManager rewrites resolv.conf unless told not to; EL hosts run it, the Ubuntu server profiles do not. */
export const NM_DNS_NONE_PATH = '/etc/NetworkManager/conf.d/90-xpanel-dns.conf'

/** resolv.conf(5): the saved nameservers in order; search, domain, options and sortlist lines of the live file stay. */
export const renderResolvConf = (resolvers: readonly string[], previous: string | null): RenderedFile => {
  const kept = (previous ?? '').split('\n').filter(line => /^\s*(?:search|domain|options|sortlist)\s/.test(line))
  return { path: RESOLV_CONF_PATH, content: ['# Managed by xPanel: WHM Resolver Configuration', ...resolvers.map(address => `nameserver ${address}`), ...kept, ''].join('\n'), mode: 0o644, owner: 'root', group: 'root' }
}

export const renderNetworkManagerDnsNone = (): RenderedFile =>
  ({ path: NM_DNS_NONE_PATH, content: '# Managed by xPanel: resolv.conf is rendered from WHM Resolver Configuration\n[main]\ndns=none\n', mode: 0o644, owner: 'root', group: 'root' })
