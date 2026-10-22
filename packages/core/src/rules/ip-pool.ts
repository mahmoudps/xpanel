import { fail } from '../errors.ts'
import type {
  Account,
  Domain,
  DomainMailIpOverride,
  Id,
  IpOwnerKind,
  IpRole,
  MailIpConfig,
  MailOutboundMode,
  Reseller,
  ServerIpEntry,
} from '../types.ts'
import { formatCidr, parseIp } from './firewall.ts'
import { validateDomainName } from './naming.ts'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const IFACE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,31}$/
const IP_ROLES: readonly IpRole[] = ['shared', 'dedicated', 'mail']
const IP_OWNERS: readonly IpOwnerKind[] = ['root', 'reseller', 'account']
const MAIL_MODES: readonly MailOutboundMode[] = ['server-default', 'account-ip', 'domain-ip', 'custom-map']

export const canonicalIp = (v: unknown, what = 'ip'): { address: string; version: 4 | 6 } => {
  if (typeof v !== 'string') return fail('VALIDATION', `${what} must be a string`)
  const parsed = parseIp(v.trim())
  if (!parsed) return fail('VALIDATION', `invalid IP address for ${what}`, { value: v })
  const address = formatCidr({ ...parsed, prefix: parsed.version === 4 ? 32 : 128 }).replace(/\/(?:32|128)$/, '')
  return { address, version: parsed.version }
}

export const assertIpv6 = (v: unknown, what = 'ipv6'): string => {
  const { address, version } = canonicalIp(v, what)
  if (version !== 6) return fail('VALIDATION', `${what} must be an IPv6 address`, { value: v })
  return address
}

export const assertIpv4Strict = (v: unknown, what = 'ipv4'): string => {
  const { address, version } = canonicalIp(v, what)
  if (version !== 4 || address !== v) return fail('VALIDATION', `${what} must be a canonical IPv4 address`, { value: v })
  return address
}

export const validateIpList = (v: unknown, what = 'extraIps', max = 64): string[] => {
  if (!Array.isArray(v)) return fail('VALIDATION', `${what} must be an array of IPv4/IPv6 addresses`)
  if (v.length > max) return fail('VALIDATION', `${what} must have at most ${max} addresses`)
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of v) {
    const { address } = canonicalIp(item, what)
    if (!seen.has(address)) {
      seen.add(address)
      out.push(address)
    }
  }
  return out
}

export const validateServerIpEntry = (v: unknown): ServerIpEntry => {
  if (typeof v !== 'object' || v === null) return fail('VALIDATION', 'server IP entry must be an object')
  const o = v as Record<string, unknown>
  const id = typeof o.id === 'string' && UUID_RE.test(o.id) ? o.id.toLowerCase() : fail('VALIDATION', 'invalid server IP id')
  const { address, version } = canonicalIp(o.address, 'address')
  const maxPrefix = version === 4 ? 32 : 128
  const prefixLength =
    typeof o.prefixLength === 'number' && Number.isSafeInteger(o.prefixLength) && o.prefixLength >= 1 && o.prefixLength <= maxPrefix
      ? o.prefixLength
      : fail('VALIDATION', `prefixLength must be 1..${maxPrefix}`)
  const interfaceName =
    typeof o.interfaceName === 'string' && IFACE_RE.test(o.interfaceName)
      ? o.interfaceName
      : fail('VALIDATION', 'invalid network interface name')
  const role = IP_ROLES.includes(o.role as IpRole) ? (o.role as IpRole) : fail('VALIDATION', 'role must be shared, dedicated, or mail')
  const ownerKind = IP_OWNERS.includes(o.ownerKind as IpOwnerKind)
    ? (o.ownerKind as IpOwnerKind)
    : fail('VALIDATION', 'ownerKind must be root, reseller, or account')
  let ownerId: Id | null = null
  if (ownerKind === 'root') {
    if (o.ownerId != null) return fail('VALIDATION', 'root-owned IP entry must have ownerId: null')
  } else {
    if (typeof o.ownerId !== 'string' || !UUID_RE.test(o.ownerId)) {
      return fail('VALIDATION', `${ownerKind}-owned IP entry requires a valid ownerId UUID`)
    }
    ownerId = o.ownerId.toLowerCase()
  }
  const ptrHostname = o.ptrHostname == null || o.ptrHostname === '' ? null : validateDomainName(String(o.ptrHostname))
  const isPrimary = typeof o.isPrimary === 'boolean' ? o.isPrimary : false
  const notes = typeof o.notes === 'string' && o.notes.length <= 255 && !/[\r\n\0]/.test(o.notes) ? o.notes : ''

  return {
    id,
    address,
    version,
    prefixLength,
    interfaceName,
    role,
    ownerKind,
    ownerId,
    ptrHostname,
    isPrimary,
    notes,
  }
}

/**
 * Verifies that an IPv4 or IPv6 address can be assigned to an account by the caller (`root` or `reseller`),
 * enforcing reseller delegation boundaries and dedicated-IP exclusivity across accounts.
 */
export const assertIpAssignableToAccount = (
  rawIp: unknown,
  opts: {
    expectedVersion?: 4 | 6
    callerKind?: 'root' | 'reseller'
    reseller?: Pick<Reseller, 'id' | 'delegatedIps'> | null
    accountId?: Id
    pool?: readonly ServerIpEntry[]
    allAccounts?: readonly Pick<Account, 'id' | 'ipv4' | 'ipv6' | 'extraIps'>[]
  } = {},
): string => {
  const { address, version } = canonicalIp(rawIp, opts.expectedVersion === 6 ? 'ipv6' : 'ip')
  if (opts.expectedVersion && version !== opts.expectedVersion) {
    fail('VALIDATION', `expected IPv${opts.expectedVersion} address, got IPv${version}`, { ip: address })
  }

  const poolEntry = opts.pool?.find((e) => e.address === address)

  // Reseller caller can only use IPs delegated to that reseller
  if (opts.callerKind === 'reseller') {
    const res = opts.reseller ?? fail('FORBIDDEN', 'reseller context is required')
    const delegated = new Set(res.delegatedIps.map((ip) => canonicalIp(ip).address))
    const ownedInPool = poolEntry?.ownerKind === 'reseller' && poolEntry.ownerId === res.id
    if (!delegated.has(address) && !ownedInPool) {
      return fail('FORBIDDEN', `IP address ${address} is not delegated to reseller`, { ip: address, resellerId: res.id })
    }
  }

  if (poolEntry) {
    if (poolEntry.ownerKind === 'account' && poolEntry.ownerId !== null && poolEntry.ownerId !== opts.accountId) {
      fail('CONFLICT', `dedicated IP ${address} is reserved for another account`, { ip: address })
    }
    if (
      poolEntry.ownerKind === 'reseller' &&
      opts.reseller &&
      poolEntry.ownerId !== null &&
      poolEntry.ownerId !== opts.reseller.id
    ) {
      fail('FORBIDDEN', `IP ${address} belongs to another reseller`, { ip: address })
    }
    if (poolEntry.role === 'dedicated' && opts.allAccounts) {
      const other = opts.allAccounts.find(
        (a) =>
          a.id !== opts.accountId &&
          (a.ipv4 === address || a.ipv6 === address || (a.extraIps ?? []).includes(address)),
      )
      if (other) {
        fail('CONFLICT', `dedicated IP ${address} is already in use by another account`, {
          ip: address,
          otherAccountId: other.id,
        })
      }
    }
  }

  return address
}

/**
 * Verifies that a domain-specific IPv4 or IPv6 override belongs to the owning account,
 * its reseller's delegated pool, or an available entry in the server IP pool.
 */
export const assertIpAssignableToDomain = (
  rawIp: unknown,
  opts: {
    expectedVersion?: 4 | 6
    account: Pick<Account, 'id' | 'ownerId' | 'ipv4' | 'ipv6' | 'extraIps'>
    reseller?: Pick<Reseller, 'id' | 'delegatedIps'> | null
    pool?: readonly ServerIpEntry[]
  },
): string => {
  const { address, version } = canonicalIp(rawIp, opts.expectedVersion === 6 ? 'ipv6' : 'ip')
  if (opts.expectedVersion && version !== opts.expectedVersion) {
    fail('VALIDATION', `expected IPv${opts.expectedVersion} address, got IPv${version}`, { ip: address })
  }

  const accountIps = new Set<string>([
    opts.account.ipv4,
    ...(opts.account.ipv6 ? [opts.account.ipv6] : []),
    ...(opts.account.extraIps ?? []),
  ])
  if (accountIps.has(address)) return address

  if (opts.reseller) {
    const delegated = new Set(opts.reseller.delegatedIps.map((ip) => canonicalIp(ip).address))
    if (delegated.has(address)) return address
  }

  if (opts.pool && opts.pool.length > 0) {
    const entry =
      opts.pool.find((e) => e.address === address) ??
      fail('FORBIDDEN', `IP ${address} is not in the server IP pool or assigned to this account`, { ip: address })
    if (entry.ownerKind === 'account' && entry.ownerId !== opts.account.id) {
      return fail('FORBIDDEN', `IP ${address} is assigned to another account`, { ip: address })
    }
    if (entry.ownerKind === 'reseller' && entry.ownerId !== opts.account.ownerId) {
      return fail('FORBIDDEN', `IP ${address} is delegated to another reseller`, { ip: address })
    }
    return address
  }

  fail('FORBIDDEN', `domain IP ${address} is not assigned to account`, { ip: address })
  return address
}

/**
 * Resolves the effective IPv4 and IPv6 addresses a domain listens on and publishes in DNS.
 * Domain-level overrides win over the account's primary IPv4/IPv6.
 */
export const resolveDomainEffectiveIps = (
  domain: Pick<Domain, 'ipv4' | 'ipv6'>,
  account: Pick<Account, 'ipv4' | 'ipv6'>,
): { ipv4: string; ipv6: string | null } => ({
  ipv4: domain.ipv4 ?? account.ipv4,
  ipv6: domain.ipv6 ?? account.ipv6 ?? null,
})

export const validateMailIpConfig = (v: unknown): MailIpConfig => {
  if (typeof v !== 'object' || v === null) return fail('VALIDATION', 'mail IP config must be an object')
  const o = v as Record<string, unknown>
  const mode = MAIL_MODES.includes(o.mode as MailOutboundMode)
    ? (o.mode as MailOutboundMode)
    : fail('VALIDATION', 'invalid mail outbound mode')
  const defaultIpv4 = o.defaultIpv4 == null || o.defaultIpv4 === '' ? null : assertIpv4Strict(o.defaultIpv4, 'defaultIpv4')
  const defaultIpv6 = o.defaultIpv6 == null || o.defaultIpv6 === '' ? null : assertIpv6(o.defaultIpv6, 'defaultIpv6')
  const defaultHelo = o.defaultHelo == null || o.defaultHelo === '' ? null : validateDomainName(String(o.defaultHelo))

  if (!Array.isArray(o.domainOverrides ?? [])) {
    return fail('VALIDATION', 'domainOverrides must be an array')
  }
  const rawOverrides = (o.domainOverrides ?? []) as unknown[]
  if (rawOverrides.length > 2048) return fail('VALIDATION', 'at most 2048 domain mail IP overrides are allowed')
  const seen = new Set<string>()
  const domainOverrides: DomainMailIpOverride[] = []
  for (const item of rawOverrides) {
    if (typeof item !== 'object' || item === null) return fail('VALIDATION', 'domain mail override must be an object')
    const r = item as Record<string, unknown>
    const domainName = validateDomainName(String(r.domainName ?? ''))
    if (seen.has(domainName)) fail('VALIDATION', `duplicate mail IP override for domain "${domainName}"`)
    seen.add(domainName)
    const ipv4 = r.ipv4 == null || r.ipv4 === '' ? null : assertIpv4Strict(r.ipv4, 'override.ipv4')
    const ipv6 = r.ipv6 == null || r.ipv6 === '' ? null : assertIpv6(r.ipv6, 'override.ipv6')
    const heloHostname = r.heloHostname == null || r.heloHostname === '' ? null : validateDomainName(String(r.heloHostname))
    if (!ipv4 && !ipv6 && !heloHostname) {
      fail('VALIDATION', `mail override for "${domainName}" must specify at least ipv4, ipv6, or heloHostname`)
    }
    domainOverrides.push({ domainName, ipv4, ipv6, heloHostname })
  }
  domainOverrides.sort((a, b) => a.domainName.localeCompare(b.domainName))

  return {
    mode,
    defaultIpv4,
    defaultIpv6,
    defaultHelo,
    domainOverrides,
  }
}

const sanitizeTransportSuffix = (ip: string): string => ip.replace(/[^a-zA-Z0-9]/g, '-')

/**
 * Resolves the outbound SMTP bind IPv4, IPv6, HELO hostname, and Postfix master.cf transport name
 * for a given domain according to `MailIpConfig` (`server-default`, `account-ip`, `domain-ip`, or `custom-map`).
 */
export const resolveDomainOutboundMailIp = (
  domain: Pick<Domain, 'name' | 'ipv4' | 'ipv6'>,
  account: Pick<Account, 'ipv4' | 'ipv6'>,
  mailConfig: MailIpConfig,
  serverFallback: { ipv4: string; ipv6?: string | null; hostname: string },
): { ipv4: string; ipv6: string | null; heloHostname: string; transportName: string } => {
  const override = mailConfig.domainOverrides.find((o) => o.domainName === domain.name.toLowerCase())
  const effectiveDom = resolveDomainEffectiveIps(domain, account)

  let ipv4 = mailConfig.defaultIpv4 ?? serverFallback.ipv4
  let ipv6 = mailConfig.defaultIpv6 ?? serverFallback.ipv6 ?? null
  let heloHostname = mailConfig.defaultHelo ?? serverFallback.hostname

  if (mailConfig.mode === 'account-ip') {
    ipv4 = account.ipv4
    ipv6 = account.ipv6 ?? ipv6
    heloHostname = `mail.${domain.name}`
  } else if (mailConfig.mode === 'domain-ip') {
    ipv4 = effectiveDom.ipv4
    ipv6 = effectiveDom.ipv6 ?? ipv6
    heloHostname = `mail.${domain.name}`
  }

  if (override) {
    if (override.ipv4) ipv4 = override.ipv4
    if (override.ipv6) ipv6 = override.ipv6
    if (override.heloHostname) heloHostname = override.heloHostname
  }

  const transportName = `xpanel-smtp-${sanitizeTransportSuffix(ipv4)}`
  return { ipv4, ipv6, heloHostname, transportName }
}
