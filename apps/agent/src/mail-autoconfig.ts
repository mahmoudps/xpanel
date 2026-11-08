import type { edge } from '@xpanel/render'

/** The hostname mail clients reach and the account's domains with at least one mailbox; none when no client could use it. */
export function mailAutoconfigOption(snapshot: {
  server?: { settings: { hostname: string } } | null
  domains: readonly { id: string; name: string; accountId: string; suspended?: boolean }[]
  serviceUsers: readonly { accountId: string; domainId?: string; services: { email: boolean } }[]
}, accountId: string): edge.MailAutoconfigOption | undefined {
  const hostname = snapshot.server?.settings.hostname.trim().toLowerCase().replace(/\.$/, '') ?? ''
  // A bare or invalid server name cannot carry a certificate mail clients accept, so nothing is advertised.
  if (hostname.length > 253 || !/^(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(hostname)) return undefined
  const domains = snapshot.domains.filter(domain => domain.accountId === accountId && domain.suspended !== true
    && snapshot.serviceUsers.some(user => user.accountId === accountId && user.domainId === domain.id && user.services.email)).map(domain => domain.name).sort()
  return domains.length ? { hostname, domains } : undefined
}
