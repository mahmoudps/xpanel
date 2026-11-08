import { parseBackupCron } from './backup-destination.ts'
import { fail } from './errors.ts'
import { canonicalIp } from './rules/ip-pool.ts'
import { validateDomainName } from './rules/naming.ts'
import type { TlsProtocol } from './types.ts'

const unchanged = { stateChanged: false }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: unknown, keys: readonly string[], what: string): Record<string, unknown> =>
  object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) ? value : fail('VALIDATION', `${what} must be { ${keys.join(', ')} }`, unchanged)

/** Desired-state files of the server operation tools, below the state root. */
export const SERVER_OPERATIONS_STATE = {
  resolvers: 'extended/server/resolvers.json',
  domainForwards: 'extended/server/domain-forwards.json',
  roles: 'extended/server/service-roles.json',
  systemMail: 'extended/server/system-mail.json',
  panelTls: 'extended/server/panel-tls.json',
  maintenance: 'extended/server/maintenance-schedule.json',
  updates: 'extended/server/update-preferences.json',
  updateLedger: 'extended/server/update-ledger.json',
} as const

// ---- Change Hostname ----------------------------------------------------------------------

/** Service subdomains the panel publishes per domain; a host name in one of them would shadow that service. */
const SERVICE_LABELS: readonly string[] = ['cpanel', 'whm', 'webmail', 'webdisk', 'cpcalendars', 'cpcontacts', 'autodiscover', 'autoconfig']
export const SERVER_HOSTNAME_MAX = 60
/** Every one must be acknowledged before a MariaDB upgrade starts. */
export const DB_UPGRADE_WARNINGS = ['service-restart', 'no-downgrade'] as const

/** cPanel Change Hostname: a lowercase Latin FQDN, never an account domain or a service subdomain. */
export const validateServerHostname = (value: unknown, accountDomains: readonly string[] = []): string => {
  const invalid = (rule: string): never => fail('VALIDATION', 'the server host name must be a lowercase FQDN of at most 60 characters that does not start with www or a digit', { ...unchanged, reason: 'INVALID_HOSTNAME', rule })
  if (typeof value !== 'string' || value !== value.toLowerCase() || value.length > SERVER_HOSTNAME_MAX || value.endsWith('-') || !value.includes('.')) return invalid('shape')
  if (value.startsWith('www') || /^[0-9]/.test(value)) return invalid('prefix')
  let name: string
  try { name = validateDomainName(value) } catch { return invalid('shape') }
  if (SERVICE_LABELS.includes(name.split('.')[0]!)) return invalid('service-subdomain')
  if (accountDomains.includes(name)) return invalid('account-domain')
  return name
}

// ---- Resolver Configuration ---------------------------------------------------------------

export const validateServerResolvers = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length < 2 || value.length > 3) return fail('VALIDATION', 'a primary and a secondary resolver are required, a tertiary is optional', { ...unchanged, reason: 'resolver_count' })
  const resolvers = value.map(item => {
    try { return canonicalIp(item, 'resolver').address } catch { return fail('VALIDATION', 'each resolver must be an IPv4 or IPv6 address', { ...unchanged, reason: 'resolver_invalid' }) }
  })
  return new Set(resolvers).size === resolvers.length ? resolvers : fail('VALIDATION', 'each resolver may be listed once', { ...unchanged, reason: 'resolver_duplicate' })
}

// ---- Domain Forwarding --------------------------------------------------------------------

export interface DomainForward { domain: string; url: string; ip: string; createdAt: string }
export const DOMAIN_FORWARDS_MAX = 256

export const validateForwardUrl = (value: unknown): string => {
  const invalid = (): never => fail('VALIDATION', 'the forward target must be an http or https URL', { ...unchanged, reason: 'forward_url_invalid' })
  // The URL reaches an nginx return directive: quotes, `$` and whitespace are refused, never escaped into another target.
  if (typeof value !== 'string' || value.length > 2000 || !/^[\x21-\x7e]+$/.test(value) || /["'\\$;{}<>^`|]/.test(value)) return invalid()
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && url.hostname && !url.username && !url.password ? value : invalid() } catch { return invalid() }
}

export const validateDomainForwards = (value: unknown): DomainForward[] => {
  if (!Array.isArray(value) || value.length > DOMAIN_FORWARDS_MAX) return fail('VALIDATION', `at most ${DOMAIN_FORWARDS_MAX} domain forwards are saved`, unchanged)
  const forwards = value.map((raw): DomainForward => {
    const item = exact(raw, ['domain', 'url', 'ip', 'createdAt'], 'domain forward')
    const ip = canonicalIp(item.ip, 'forwarder IP')
    if (ip.version !== 4 || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt))) return fail('VALIDATION', 'a domain forward needs an IPv4 address and a time', unchanged)
    return { domain: validateDomainName(item.domain), url: validateForwardUrl(item.url), ip: ip.address, createdAt: item.createdAt }
  })
  return new Set(forwards.map(item => item.domain)).size === forwards.length ? forwards : fail('VALIDATION', 'a domain may be forwarded once', unchanged)
}

/** The next pool address nothing uses: never the primary, a reserved or a releasing address, nor one already forwarding. */
export const nextForwarderIp = (pool: readonly { address: string; version: 4 | 6; isPrimary: boolean; reserved?: boolean; releasing?: unknown }[], inUse: ReadonlySet<string>): string => {
  const free = pool.find(entry => entry.version === 4 && !entry.isPrimary && !entry.reserved && !entry.releasing && !inUse.has(entry.address))
  return free ? free.address : fail('PRECONDITION_FAILED', 'no free address is left in the IP pool for a domain forward', { ...unchanged, reason: 'NO_FREE_IP' })
}

// ---- Enable DKIM and SPF for All ----------------------------------------------------------

/** Adds the server's main address to an SPF policy, before its `all` term and keeping every other term; null when it already lists it. */
export const spfWithAddress = (spf: string, address: string): string | null => {
  const { address: ip, version } = canonicalIp(address, 'server address')
  const term = `ip${version}:${ip}`, words = spf.trim().split(/\s+/)
  if (words.some(word => word.replace(/^[+]/, '').toLowerCase() === term)) return null
  const all = words.findIndex(word => /^[+?~-]?all$/i.test(word) || /^redirect=/i.test(word))
  return [...words.slice(0, all < 0 ? words.length : all), `+${term}`, ...(all < 0 ? [] : words.slice(all))].join(' ')
}
export const defaultSpf = (address: string): string => spfWithAddress('v=spf1 +a +mx ~all', address)!

// ---- Server Profile, DNS and FTP server selection -----------------------------------------

export const SERVER_ROLES = ['web', 'mail', 'spam', 'dns', 'ftp', 'mysql', 'postgresql'] as const
export type ServerRole = (typeof SERVER_ROLES)[number]
export const SERVER_PROFILE_IDS = ['full', 'dns-only', 'mail-only', 'database'] as const
export type ServerProfileId = (typeof SERVER_PROFILE_IDS)[number]
/** cPanel Server Profile: the roles a profile always runs, and those the operator may add. */
export const SERVER_PROFILES: Readonly<Record<ServerProfileId, { enabled: readonly ServerRole[]; optional: readonly ServerRole[] }>> = {
  full: { enabled: ['web', 'mail', 'spam', 'dns', 'ftp', 'mysql'], optional: ['postgresql'] },
  'dns-only': { enabled: ['dns'], optional: ['mail', 'mysql'] },
  'mail-only': { enabled: ['mail', 'spam'], optional: ['dns', 'mysql'] },
  database: { enabled: ['mysql'], optional: ['postgresql', 'dns'] },
}
/** Decision 6: PowerDNS and Pure-FTPd are the only daemons, with a disable option, so no second daemon runs on 1 GB. */
export const DNS_SERVER_CHOICES = ['powerdns', 'disabled'] as const
export const FTP_SERVER_CHOICES = ['pure-ftpd', 'disabled'] as const
export interface ServerRoleState { profile: ServerProfileId; optional: ServerRole[]; dnsServer: (typeof DNS_SERVER_CHOICES)[number]; ftpServer: (typeof FTP_SERVER_CHOICES)[number] }
export const defaultServerRoles = (): ServerRoleState => ({ profile: 'full', optional: [], dnsServer: 'powerdns', ftpServer: 'pure-ftpd' })

export const validateServerRoles = (value: unknown): ServerRoleState => {
  const raw = exact(value, ['profile', 'optional', 'dnsServer', 'ftpServer'], 'server roles')
  const profile = raw.profile as ServerProfileId
  if (!SERVER_PROFILE_IDS.includes(profile)) return fail('VALIDATION', 'unknown server profile', { ...unchanged, reason: 'profile_unknown' })
  const allowed = SERVER_PROFILES[profile].optional
  if (!Array.isArray(raw.optional) || raw.optional.some(role => !allowed.includes(role as ServerRole)) || new Set(raw.optional).size !== raw.optional.length) return fail('VALIDATION', 'this profile does not offer that optional role', { ...unchanged, reason: 'optional_role_invalid' })
  if (!DNS_SERVER_CHOICES.includes(raw.dnsServer as never) || !FTP_SERVER_CHOICES.includes(raw.ftpServer as never)) return fail('VALIDATION', 'unknown daemon choice', { ...unchanged, reason: 'daemon_choice_invalid' })
  return { profile, optional: SERVER_ROLES.filter(role => (raw.optional as unknown[]).includes(role)), dnsServer: raw.dnsServer as ServerRoleState['dnsServer'], ftpServer: raw.ftpServer as ServerRoleState['ftpServer'] }
}

export const effectiveServerRoles = (state: ServerRoleState): Set<ServerRole> => {
  const roles = new Set<ServerRole>([...SERVER_PROFILES[state.profile].enabled, ...state.optional])
  if (state.dnsServer === 'disabled') roles.delete('dns')
  if (state.ftpServer === 'disabled') roles.delete('ftp')
  return roles
}
export interface ServerRoleChange { role: ServerRole; change: 'enable' | 'disable' }
export const serverRoleChanges = (from: ServerRoleState, to: ServerRoleState): ServerRoleChange[] => {
  const before = effectiveServerRoles(from), after = effectiveServerRoles(to)
  return SERVER_ROLES.flatMap((role): ServerRoleChange[] => before.has(role) === after.has(role) ? [] : [{ role, change: after.has(role) ? 'enable' : 'disable' }])
}
/** Plan feature keys a disabled role takes out of user menus and their API, on top of the plan's own feature list. */
export const ROLE_FEATURE_KEYS: Readonly<Record<ServerRole, readonly string[]>> = {
  web: [], spam: ['spamassassin, spambox (Apache SpamAssassin, Spam Box)'], postgresql: [],
  mail: ['popaccts (Email Accounts)', 'Email Filtering Manager'], dns: ['zone-editor'], ftp: ['ftpaccts'], mysql: ['mysql'],
}
export const roleDisabledFeatures = (state: ServerRoleState): string[] => {
  const roles = effectiveServerRoles(state)
  return SERVER_ROLES.flatMap(role => roles.has(role) ? [] : ROLE_FEATURE_KEYS[role])
}

// ---- Edit System Mail Preferences ---------------------------------------------------------

export const SYSTEM_MAIL_USERS = ['root', 'nobody', 'xpanel'] as const
export type SystemMailUser = (typeof SYSTEM_MAIL_USERS)[number]
export type SystemMailForwards = Record<SystemMailUser, string | null>
const EMAIL = /^[A-Za-z0-9.!#%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/
const USERNAME = /^[a-z][a-z0-9]{0,15}$/

/** An address or a hosting username (its default mailbox); chains to root stay allowed, a self-reference never. */
export const validateSystemMailForwards = (value: unknown): SystemMailForwards => {
  const raw = exact(value, SYSTEM_MAIL_USERS, 'system mail forwards')
  return Object.fromEntries(SYSTEM_MAIL_USERS.map(user => {
    const target = raw[user]
    if (target !== null && (typeof target !== 'string' || target === user || !EMAIL.test(target) && !USERNAME.test(target))) return fail('VALIDATION', 'each forward must be an email address or a hosting username', { ...unchanged, reason: 'forward_target_invalid', user })
    return [user, target]
  })) as SystemMailForwards
}

// ---- cPanel Web Services Configuration ----------------------------------------------------

export interface PanelTlsPolicy { protocols: TlsProtocol[]; ciphers: string }
const TLS_PROTOCOLS: readonly TlsProtocol[] = ['TLSv1.2', 'TLSv1.3']
export const defaultPanelTlsPolicy = (): PanelTlsPolicy => ({ protocols: ['TLSv1.2', 'TLSv1.3'], ciphers: 'HIGH:!aNULL:!MD5' })
export const validatePanelTlsPolicy = (value: unknown): PanelTlsPolicy => {
  const raw = exact(value, ['protocols', 'ciphers'], 'panel TLS policy')
  const protocols = raw.protocols
  if (!Array.isArray(protocols) || protocols.length === 0 || protocols.some(item => !TLS_PROTOCOLS.includes(item as TlsProtocol)) || new Set(protocols).size !== protocols.length) return fail('VALIDATION', 'protocols must be distinct values from TLSv1.2 and TLSv1.3', { ...unchanged, reason: 'tls_protocols_invalid' })
  if (typeof raw.ciphers !== 'string' || !/^[A-Za-z0-9:+!@=_-]{1,1024}$/.test(raw.ciphers)) return fail('VALIDATION', 'ciphers must be an OpenSSL cipher list', { ...unchanged, reason: 'tls_ciphers_invalid' })
  return { protocols: TLS_PROTOCOLS.filter(item => protocols.includes(item)), ciphers: raw.ciphers }
}

// ---- Configure cPanel Cron Jobs -----------------------------------------------------------

export interface MaintenanceSchedule { updater: string }
export const defaultMaintenanceSchedule = (): MaintenanceSchedule => ({ updater: '30 3 * * *' })
export const validateMaintenanceSchedule = (value: unknown): MaintenanceSchedule => {
  const raw = exact(value, ['updater'], 'maintenance schedule')
  const invalid = (): never => fail('VALIDATION', 'a schedule is five cron fields: minute 0-59, hour 0-23, day 1-31, month 1-12, weekday 0-6', { ...unchanged, reason: 'schedule_invalid' })
  try { parseBackupCron(raw.updater) } catch { return invalid() }
  // crontab(5) also reads 7 as Sunday; cPanel documents 0 to 6 and refuses 7.
  if (/(?:^|[,-])7(?:$|[,/-])/.test((raw.updater as string).trim().split(/\s+/)[4]!)) return invalid()
  return { updater: (raw.updater as string).trim().split(/\s+/).join(' ') }
}
/** cPanel warns when a nightly job would run more than once per day. */
export const runsMoreThanDaily = (cron: string): boolean => {
  const [minute, hour] = cron.trim().split(/\s+/) as [string, string]
  return !/^[0-9]+$/.test(minute) || !/^[0-9]+$/.test(hour)
}

// ---- Update Preferences -------------------------------------------------------------------

export const UPDATE_TIERS = ['long-term', 'stable', 'release', 'current', 'edge'] as const
export type UpdateTier = (typeof UPDATE_TIERS)[number]
export interface UpdatePreferences {
  tier: UpdateTier
  updates: 'automatic' | 'manual'
  securityPatches: boolean
  /** Days a staged release of another major version waits after it was first seen before an automatic update takes it. */
  majorDelayDays: number
  /** The root principal the updater hands an upgrade off as; set on save and refused once it is disabled. */
  owner: { principalId: string; username: string } | null
}
export const defaultUpdatePreferences = (): UpdatePreferences => ({ tier: 'release', updates: 'manual', securityPatches: true, majorDelayDays: 0, owner: null })
export const validateUpdatePreferences = (value: unknown): UpdatePreferences => {
  const raw = exact(typeof value === 'object' && value !== null ? { majorDelayDays: 0, ...value } : value, ['tier', 'updates', 'securityPatches', 'majorDelayDays', 'owner'], 'update preferences')
  if (!Number.isSafeInteger(raw.majorDelayDays) || (raw.majorDelayDays as number) < 0 || (raw.majorDelayDays as number) > 365) return fail('VALIDATION', 'the major upgrade delay must be 0 to 365 days', unchanged)
  if (!UPDATE_TIERS.includes(raw.tier as UpdateTier)) return fail('VALIDATION', 'unknown release tier', { ...unchanged, reason: 'update_tier_unknown' })
  if (raw.updates !== 'automatic' && raw.updates !== 'manual' || typeof raw.securityPatches !== 'boolean') return fail('VALIDATION', 'updates must be automatic or manual and securityPatches a boolean', unchanged)
  const owner = raw.owner === null ? null : exact(raw.owner, ['principalId', 'username'], 'update owner')
  if (owner && (typeof owner.principalId !== 'string' || typeof owner.username !== 'string')) return fail('VALIDATION', 'update owner is invalid', unchanged)
  return { tier: raw.tier as UpdateTier, updates: raw.updates, securityPatches: raw.securityPatches, majorDelayDays: raw.majorDelayDays as number, owner: owner as UpdatePreferences['owner'] }
}

const VERSION = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/
const parts = (version: string): [number, number, number] | null => { const match = VERSION.exec(version); return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null }
/** Candidates still inside the major upgrade delay, by when each was first seen. An unseen one starts its delay now. */
export const heldByMajorDelay = (current: string, candidates: readonly string[], seen: Readonly<Record<string, string>>, delayDays: number, now: Date): string[] => {
  const from = parts(current)
  if (!from || delayDays === 0) return []
  return candidates.filter(version => { const to = parts(version); return !!to && to[0] !== from[0] && now.getTime() - Date.parse(seen[version] ?? now.toISOString()) < delayDays * 86_400_000 })
}
const newer = (a: readonly number[], b: readonly number[]): number => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!

/**
 * The staged release the updater may install, or null. The signed manifest names no tier, so a tier bounds how far an
 * automatic update may move from the current version: security patches stay inside major.minor, whatever the tier.
 */
export const selectAutomaticUpdate = (current: string, candidates: readonly string[], prefs: Pick<UpdatePreferences, 'tier' | 'updates' | 'securityPatches'>): string | null => {
  const from = parts(current)
  if (!from) return null
  const admits = (to: readonly number[]): boolean => {
    const sameMajor = to[0] === from[0], sameMinor = sameMajor && to[1] === from[1]
    if (prefs.securityPatches && sameMinor) return true
    if (prefs.updates !== 'automatic') return false
    return prefs.tier === 'long-term' ? sameMinor : prefs.tier === 'stable' || prefs.tier === 'release' ? sameMajor : true
  }
  const best = candidates.flatMap(version => { const to = parts(version); return to && newer(to, from) > 0 && admits(to) ? [{ version, to }] : [] }).sort((a, b) => newer(b.to, a.to))[0]
  return best?.version ?? null
}
