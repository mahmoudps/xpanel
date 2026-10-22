import { DB_NAME_MAX, DB_USER_MAX, fail, validateDocRoot } from '@xpanel/core'
import type { DomainKind, Limit, ShellAccess, SiteType } from '@xpanel/core'
import { edge, services } from '@xpanel/render'
import { parseMailConfig } from '../backup/mail-config.ts'
import type { MailConfig } from '../backup/mail-config.ts'
import { parseSemver } from '../upgrade/semver.ts'
import { assertAddress, assertDomain, assertHostedAddress, assertSourceDbName, domainOf, exactKeys, isIpv4, isIsoDate, isObj, isUsernameSyntax } from '../validate.ts'
import { isPlanName } from './session.ts'

// manifest.json of xPanel's own account archive. Everything in it is untrusted on import:
// it may come from another server or an uploaded file.

const ACCOUNT_ARCHIVE_FORMAT = 'xpanel-account'
const ACCOUNT_ARCHIVE_VERSION = 1

export interface ArchiveDomain {
  name: string
  kind: DomainKind
  parent: string | null
  /** relative to the account home */
  docRoot: string
  siteType: SiteType
  phpVersion: string
  wildcard: boolean
  upstream: string | null
}

export interface ArchiveDbUser {
  name: string
  hosts: string[]
  grants: { database: string; privileges: services.MariadbPrivilege[] }[]
}

export interface AccountArchiveManifest {
  format: typeof ACCOUNT_ARCHIVE_FORMAT
  version: typeof ACCOUNT_ARCHIVE_VERSION
  createdAt: string
  source: { hostname: string; panelVersion: string }
  account: { username: string; primaryDomain: string; contactEmail: string; plan: string; shell: ShellAccess; ipv4: string }
  domains: ArchiveDomain[]
  databases: string[]
  /** no password material: imported users must set a new password */
  dbUsers: ArchiveDbUser[]
  mailboxes: { address: string; quotaMb: Limit }[]
  mail: MailConfig
  /** domains whose zone is in dns/<zone>.json */
  zones: string[]
}

const DOMAIN_KINDS = { primary: true, addon: true, alias: true, subdomain: true } as const satisfies Record<DomainKind, true>
const SITE_TYPES = { php: true, static: true, proxy: true, node: true, python: true } as const satisfies Record<SiteType, true>
const UPSTREAM_SITES: ReadonlySet<SiteType> = new Set(['proxy', 'node', 'python'])
const MAX_DOMAINS = 5000

const list = (v: unknown, what: string, max: number): unknown[] =>
  Array.isArray(v) && v.length <= max ? v : fail('VALIDATION', `${what} must be a list of at most ${max} entries`)

const strictLimit = (v: unknown, what: string): Limit =>
  v === 'unlimited' || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) ? v : fail('VALIDATION', `invalid ${what}`)

const parseDomain = (d: unknown, home: string): ArchiveDomain => {
  if (!isObj(d)) return fail('VALIDATION', 'invalid domain entry')
  exactKeys(d, ['name', 'kind', 'parent', 'docRoot', 'siteType', 'phpVersion', 'wildcard', 'upstream'], 'domain')
  const name = assertDomain(d.name)
  if (typeof d.kind !== 'string' || !Object.hasOwn(DOMAIN_KINDS, d.kind)) fail('VALIDATION', `invalid kind for ${name}`)
  if (typeof d.siteType !== 'string' || !Object.hasOwn(SITE_TYPES, d.siteType)) fail('VALIDATION', `invalid site type for ${name}`)
  if (typeof d.phpVersion !== 'string' || !/^\d\.\d{1,2}$/.test(d.phpVersion)) fail('VALIDATION', `invalid PHP version for ${name}`)
  if (typeof d.wildcard !== 'boolean') fail('VALIDATION', `invalid wildcard flag for ${name}`)
  if (typeof d.docRoot !== 'string' || d.docRoot.startsWith('/')) fail('VALIDATION', `document root of ${name} must be relative to the home`)
  // the core rule keeps docroots out of mail, etc, tmp, logs, ssl and hidden directories
  if (validateDocRoot(home, d.docRoot) !== `${home}/${d.docRoot}`) fail('VALIDATION', `document root of ${name} is not canonical`)
  const siteType = d.siteType as SiteType
  let upstream: string | null = null
  if (UPSTREAM_SITES.has(siteType)) {
    edge.parseUpstream(d.upstream, `upstream of ${name}`)
    upstream = d.upstream as string
  } else if (d.upstream !== null) fail('VALIDATION', `${siteType} site ${name} cannot have an upstream`)
  return {
    name,
    kind: d.kind as DomainKind,
    parent: d.parent === null ? null : assertDomain(d.parent, `parent of ${name}`),
    docRoot: d.docRoot as string,
    siteType,
    phpVersion: d.phpVersion as string,
    wildcard: d.wildcard as boolean,
    upstream,
  }
}

const checkDomainTree = (domains: ArchiveDomain[], primaryDomain: string): void => {
  const names = new Set(domains.map((d) => d.name))
  if (names.size !== domains.length) fail('VALIDATION', 'duplicate domain in archive')
  const primaries = domains.filter((d) => d.kind === 'primary')
  if (primaries.length !== 1 || primaries[0]?.name !== primaryDomain) fail('VALIDATION', 'exactly one primary domain matching the account is required')
  const byName = new Map(domains.map((d) => [d.name, d]))
  for (const d of domains) {
    const needsParent = d.kind === 'alias' || d.kind === 'subdomain'
    if (needsParent !== (d.parent !== null)) fail('VALIDATION', `parent mismatch for ${d.name}`)
    if (d.parent === null) continue
    const p = byName.get(d.parent)
    if (!p) fail('VALIDATION', `parent ${d.parent} of ${d.name} is not in the archive`)
    if (d.kind === 'alias' && p?.kind !== 'primary' && p?.kind !== 'addon') fail('VALIDATION', `alias ${d.name} must point at a primary or addon domain`)
    if (d.kind === 'subdomain' && !d.name.endsWith(`.${d.parent}`)) fail('VALIDATION', `subdomain ${d.name} is not under ${d.parent}`)
  }
}

const parseDbUser = (u: unknown, username: string, databases: readonly string[]): ArchiveDbUser => {
  if (!isObj(u)) return fail('VALIDATION', 'invalid database user')
  exactKeys(u, ['name', 'hosts', 'grants'], 'database user')
  const name = u.name === username ? username : assertSourceDbName(u.name, username, DB_USER_MAX, 'database user')
  const hosts = list(u.hosts, `hosts of ${name}`, services.MAX_DB_HOSTS).map((h) => {
    const host = services.assertDbHost(h)
    return host === h ? host : fail('VALIDATION', `host ${String(h).slice(0, 80)} of ${name} is not canonical`)
  })
  if (hosts.length === 0) fail('VALIDATION', `database user ${name} needs at least one host`)
  const grants = list(u.grants, `grants of ${name}`, 10_000).map((g) => {
    if (!isObj(g)) return fail('VALIDATION', `invalid grant for ${name}`)
    exactKeys(g, ['database', 'privileges'], 'grant')
    if (typeof g.database !== 'string' || !databases.includes(g.database)) fail('VALIDATION', `grant for ${name} names a database outside the archive`)
    return { database: g.database as string, privileges: services.normalizePrivileges(g.privileges) }
  })
  return { name, hosts: [...new Set(hosts)], grants }
}

/** Strict parse of an untrusted account archive manifest. */
export const parseAccountManifest = (raw: unknown): AccountArchiveManifest => {
  if (!isObj(raw)) return fail('VALIDATION', 'manifest must be an object')
  exactKeys(raw, ['format', 'version', 'createdAt', 'source', 'account', 'domains', 'databases', 'dbUsers', 'mailboxes', 'mail', 'zones'], 'manifest')
  if (raw.format !== ACCOUNT_ARCHIVE_FORMAT) fail('VALIDATION', 'not an xPanel account archive')
  if (raw.version !== ACCOUNT_ARCHIVE_VERSION) fail('VALIDATION', 'unsupported account archive version')
  if (!isIsoDate(raw.createdAt)) fail('VALIDATION', 'invalid createdAt')
  const src = raw.source
  if (!isObj(src)) return fail('VALIDATION', 'invalid source')
  exactKeys(src, ['hostname', 'panelVersion'], 'source')
  const hostname = assertDomain(src.hostname, 'source hostname')
  if (!parseSemver(src.panelVersion)) fail('VALIDATION', 'invalid source panel version')
  const a = raw.account
  if (!isObj(a)) return fail('VALIDATION', 'manifest account missing')
  exactKeys(a, ['username', 'primaryDomain', 'contactEmail', 'plan', 'shell', 'ipv4'], 'manifest account')
  // the source name may be reserved here; importAccountArchive applies the local rules to the target name
  const username = isUsernameSyntax(a.username) ? a.username : fail('VALIDATION', 'invalid account name')
  const primaryDomain = assertDomain(a.primaryDomain, 'primary domain')
  if (!isPlanName(a.plan)) fail('VALIDATION', 'invalid plan name')
  if (a.shell !== 'none' && a.shell !== 'jailed') fail('VALIDATION', 'invalid shell')
  if (!isIpv4(a.ipv4)) fail('VALIDATION', 'invalid source IPv4 address')
  const home = `/home/${username}`
  const domains = list(raw.domains, 'domains', MAX_DOMAINS).map((d) => parseDomain(d, home))
  checkDomainTree(domains, primaryDomain)
  const names = new Set(domains.map((d) => d.name))
  const databases = list(raw.databases, 'databases', 10_000).map((x) => assertSourceDbName(x, username, DB_NAME_MAX))
  if (new Set(databases).size !== databases.length) fail('VALIDATION', 'duplicate database')
  const dbUsers = list(raw.dbUsers, 'database users', 10_000).map((u) => parseDbUser(u, username, databases))
  if (new Set(dbUsers.map((u) => u.name)).size !== dbUsers.length) fail('VALIDATION', 'duplicate database user')
  const mailboxes = list(raw.mailboxes, 'mailboxes', 100_000).map((m) => {
    if (!isObj(m)) return fail('VALIDATION', 'invalid mailbox')
    exactKeys(m, ['address', 'quotaMb'], 'mailbox')
    const address = assertHostedAddress(m.address, 'mailbox')
    if (!names.has(domainOf(address))) fail('VALIDATION', `mailbox ${address} is not on an archived domain`)
    return { address, quotaMb: strictLimit(m.quotaMb, `quota of ${address}`) }
  })
  if (new Set(mailboxes.map((m) => m.address)).size !== mailboxes.length) fail('VALIDATION', 'duplicate mailbox')
  const zones = list(raw.zones, 'zones', MAX_DOMAINS).map((z) => (typeof z === 'string' && names.has(z) ? z : fail('VALIDATION', 'zones must be archived domains')))
  if (new Set(zones).size !== zones.length) fail('VALIDATION', 'duplicate zone')
  return {
    format: ACCOUNT_ARCHIVE_FORMAT,
    version: ACCOUNT_ARCHIVE_VERSION,
    createdAt: raw.createdAt as string,
    source: { hostname, panelVersion: src.panelVersion as string },
    account: {
      username,
      primaryDomain,
      contactEmail: assertAddress(a.contactEmail, 'contact email'),
      plan: a.plan as string,
      shell: a.shell as ShellAccess,
      ipv4: a.ipv4 as string,
    },
    domains,
    databases,
    dbUsers,
    mailboxes,
    mail: parseMailConfig(raw.mail, [...names]),
    zones,
  }
}
