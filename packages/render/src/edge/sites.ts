// How an account's domains become served sites. Shared by the Nginx, Apache and OLS renderers
// so every engine answers the same names the same way.
import { domainServingState } from '@xpanel/core'
import type { Account, Certificate, Domain, ServerSettings } from '@xpanel/core'
import {
  assertAccount,
  assertBackendPort,
  assertDomainBelongs,
  assertPort,
  invalid,
  isDomainName,
  parseUpstream,
  type Upstream,
} from './validate.ts'

export interface SiteGroup {
  /** the domain whose settings (docroot, PHP, mode) the site uses */
  main: Domain
  /** parked/alias domains that mirror `main` */
  aliases: Domain[]
  /** exact names, `main.name` first */
  names: string[]
  /** `*.name` entries for wildcard domains; explicit subdomains are separate groups and win */
  wildcards: string[]
  /** the domain (main or alias) each served name belongs to */
  owners: Map<string, Domain>
}

const wwwOf = (name: string): string | null => {
  if (name.startsWith('www.')) return null
  const w = `www.${name}`
  return isDomainName(w) ? w : null
}

const namesFor = (d: Domain, declared: Set<string>): { names: string[]; wildcards: string[] } => {
  const www = wwwOf(d.name)
  return {
    names: www && !declared.has(www) ? [d.name, www] : [d.name],
    wildcards: d.wildcard ? [`*.${d.name}`] : [],
  }
}

const joinsParent = (d: Domain): boolean => d.kind === 'alias' && !d.redirect && !d.suspended

const own = (g: SiteGroup, d: Domain, names: string[]): void => {
  for (const n of names) g.owners.set(n, d)
}

/**
 * Groups domains into sites. Aliases join their parent (or the primary domain) unless they
 * redirect or are suspended on their own. Every other domain, explicit subdomains included,
 * is its own site, so an exact subdomain name always beats the parent's `*.name`.
 * Throws VALIDATION on foreign domains, dangling aliases and duplicate names.
 */
export const groupSites = (account: Account, domains: Domain[]): SiteGroup[] => {
  assertAccount(account)
  if (!Array.isArray(domains)) return invalid('domains', domains, 'must be an array')
  for (const d of domains) assertDomainBelongs(account, d)

  const byId = new Map<string, Domain>()
  for (const d of domains) {
    if (byId.has(d.id)) invalid('domain id', d.id, 'is duplicated')
    byId.set(d.id, d)
  }
  const declared = new Set(domains.map((d) => d.name))
  const primary = domains.find((d) => d.kind === 'primary') ?? domains.find((d) => d.name === account.primaryDomain)

  const groups = new Map<string, SiteGroup>()
  for (const d of domains) {
    if (joinsParent(d)) continue
    const { names, wildcards } = namesFor(d, declared)
    const g: SiteGroup = { main: d, aliases: [], names, wildcards, owners: new Map() }
    own(g, d, [...names, ...wildcards])
    groups.set(d.id, g)
  }
  for (const d of domains) {
    if (!joinsParent(d)) continue
    const parent = d.parentId ? byId.get(d.parentId) : primary
    if (!parent) return invalid('alias domain', d.name, 'has no parent domain in this account')
    const g = groups.get(parent.id)
    if (!g) return invalid('alias domain', d.name, `parent ${parent.name} is itself an alias`)
    const { names, wildcards } = namesFor(d, declared)
    g.aliases.push(d)
    g.names.push(...names)
    g.wildcards.push(...wildcards)
    own(g, d, [...names, ...wildcards])
  }

  const seen = new Set<string>()
  for (const g of groups.values()) {
    for (const n of [...g.names, ...g.wildcards]) {
      if (seen.has(n)) invalid('server name', n, 'is used by more than one site')
      seen.add(n)
    }
  }
  return [...groups.values()]
}

export type SiteMode = 'suspended' | 'redirect' | 'backend' | 'upstream'

/** A point in time for expiry checks; renderers default to the time of rendering. */
export type RenderTime = Date | string

const toDate = (now: RenderTime | undefined): Date => {
  if (now === undefined) return new Date()
  const d = typeof now === 'string' ? new Date(now) : now
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d : invalid('now', now, 'is not a date')
}

/** The core serving state: suspended account or domain, or an expiry that passed (or does not parse). */
export const isSiteSuspended = (account: Account, d: Domain, now?: RenderTime): boolean =>
  domainServingState(account, d, toDate(now)) !== 'serving'

export const siteMode = (account: Account, d: Domain, now?: RenderTime): SiteMode => {
  if (isSiteSuspended(account, d, now)) return 'suspended'
  if (d.redirect) return 'redirect'
  return d.siteType === 'php' || d.siteType === 'static' ? 'backend' : 'upstream'
}

/**
 * Loopback ports of the services xPanel installs (MariaDB, PostgreSQL, Redis, Memcached,
 * PowerDNS API, ManageSieve, OpenLiteSpeed admin and default listener). A site upstream there
 * would turn the public edge into a relay to an internal service.
 */
export const LOCAL_SERVICE_PORTS: readonly number[] = [3306, 5432, 6379, 11211, 8081, 4190, 7080, 8088]

export interface UpstreamPolicy {
  /** let `proxy` sites reach RFC 1918 / ULA / CGNAT addresses */
  allowPrivateUpstreams?: boolean
  /** further loopback ports no site may proxy to (the API, monitoring, other internal daemons) */
  reservedPorts?: number[]
}

/**
 * Upstream of a proxy/node/python site. Node and Python apps run in the account slice on
 * loopback; generic reverse proxies may leave the host but never reach link-local
 * (cloud metadata), multicast or IPv4-mapped forms, nor the server's own control ports.
 */
export const siteUpstream = (d: Domain, settings: ServerSettings, policy: UpstreamPolicy = {}): Upstream => {
  if (!d.upstream) return invalid('upstream', d.upstream, `${d.siteType} site ${d.name} needs an upstream`)
  const u = parseUpstream(d.upstream)
  if (u.addressClass === 'forbidden') return invalid('upstream', d.upstream, 'targets a forbidden address range')
  if (d.siteType !== 'proxy' && u.addressClass !== 'loopback') {
    return invalid('upstream', d.upstream, `${d.siteType} apps must listen on loopback`)
  }
  if (u.addressClass === 'private' && !policy.allowPrivateUpstreams) {
    return invalid('upstream', d.upstream, 'targets a private address range')
  }
  if (u.addressClass === 'loopback') {
    const extra = (policy.reservedPorts ?? []).map((p) => assertPort('reserved port', p))
    const reserved = [assertBackendPort(settings), settings.backendTlsPort, settings.panelPort, settings.sshPort, ...LOCAL_SERVICE_PORTS, ...extra]
    if (reserved.includes(u.port)) return invalid('upstream', d.upstream, 'targets a reserved local port')
    if (u.port < 1024) return invalid('upstream', d.upstream, 'loopback apps must use an unprivileged port')
  }
  return u
}

const coversName = (pattern: string, host: string): boolean => {
  const p = pattern.toLowerCase()
  if (p === host) return true
  if (!p.startsWith('*.')) return false
  const rest = host.slice(host.indexOf('.') + 1)
  return host.includes('.') && rest === p.slice(2)
}

/** Whether the certificate is valid for `host` (an exact name, or a `*.name` server name). */
export const certCovers = (cert: Certificate, host: string): boolean => cert.names.some((n) => coversName(n, host))

/**
 * Certificate for one served name: the owning domain's own certificate, then the site's, then
 * any supplied certificate covering the name. An assigned certificate that does not cover the
 * name is never served for it (browsers would reject it).
 */
export const certForName = (host: string, owner: Domain, main: Domain, certs: Certificate[]): Certificate | null => {
  for (const id of [owner.certificateId, main.certificateId]) {
    const c = id ? certs.find((x) => x.id === id) : undefined
    if (c && certCovers(c, host)) return c
  }
  return certs.find((c) => certCovers(c, host)) ?? null
}

export const asCertList = (certs: Certificate | Certificate[] | null | undefined): Certificate[] =>
  certs ? (Array.isArray(certs) ? certs : [certs]) : []
