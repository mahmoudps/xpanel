import { formatCidr, invalid, parseCidr } from './validate.ts'

/** Saved per-account edge policy: cPanel IP Blocker addresses and the NGINX cache epoch the proxy cache key starts with. */
export interface AccountEdgePolicy {
  /** canonical addresses and CIDR blocks */
  deny: readonly string[]
  /** null until the first purge; a new value makes every cached response of the account unreachable */
  cacheEpoch: string | null
  /** a live transfer's destination address while this server proxies the account; null while the account is frozen for the final sync */
  movedTo?: string | null
}

export const ACCOUNT_EDGE_DENY_MAX = 1000
const EPOCH = /^[a-z0-9]{1,16}$/

/** The destination presents the site's own certificate under the requested name; the address comes from the pinned link, not from the name. */
export const movedTarget = (address: string): { url: string; tls: true; pre: string[] } => {
  const parsed = parseCidr(address, 'moved account address')
  if (parsed.family !== 4 || parsed.prefix !== 32) return invalid('moved account address', address, 'must be one IPv4 address')
  return { url: `https://${parsed.address}`, tls: true, pre: ['proxy_ssl_name $host;'] }
}

/** server{} lines of every site of one account; the cache key in proxyLocation reads $xpanel_cache_epoch. */
export const renderAccountEdgeServer = (policy?: AccountEdgePolicy | null, cache = true): string[] => {
  const deny = policy?.deny ?? []
  if (deny.length > ACCOUNT_EDGE_DENY_MAX) return invalid('blocked addresses', deny.length, `more than ${ACCOUNT_EDGE_DENY_MAX} entries`)
  const epoch = policy?.cacheEpoch ?? null
  if (epoch !== null && !EPOCH.test(epoch)) return invalid('cache epoch', epoch, 'must be 1-16 lowercase letters or digits')
  // With the cache off no location sets the status, so the account can still see that responses skip the cache.
  return [...deny.map((entry) => `deny ${formatCidr(parseCidr(entry, 'blocked address'))};`), `set $xpanel_cache_epoch "${epoch === null ? '' : `${epoch}:`}";`, ...(cache ? [] : ['add_header X-Cache-Status BYPASS always;'])]
}
