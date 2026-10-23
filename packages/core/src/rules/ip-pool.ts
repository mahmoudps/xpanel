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
  if (o.version !== undefined && o.version !== version) return fail('VALIDATION', 'IP family does not match address')
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
  if (o.isPrimary !== undefined && typeof o.isPrimary !== 'boolean') return fail('VALIDATION', 'isPrimary must be a boolean')
  const isPrimary = o.isPrimary === true
  if (isPrimary && (role !== 'shared' || ownerKind !== 'root')) return fail('VALIDATION', 'the default IP must be root-owned and shared')
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

/** Inventory policy, never proof that the address is configured on a Linux interface. */
export const validateServerIpPool = (value: unknown): ServerIpEntry[] => {
  if (!Array.isArray(value) || value.length > 4096) return fail('VALIDATION', 'IP pool must contain at most 4096 entries')
  const entries = value.map(validateServerIpEntry), ids = new Set<string>(), addresses = new Set<string>(), defaults = new Set<number>()
  for (const entry of entries) {
    hostingAddress(entry.address)
    if (ids.has(entry.id) || addresses.has(entry.address)) fail('VALIDATION', 'duplicate IP pool ID or canonical address')
    if (entry.isPrimary && defaults.has(entry.version)) fail('VALIDATION', 'only one default shared IP is allowed per address family')
    ids.add(entry.id); addresses.add(entry.address); if (entry.isPrimary) defaults.add(entry.version)
  }
  return entries.sort((a, b) => a.address.localeCompare(b.address))
}

export type IpAssignmentRequest = { mode: 'shared' } | { mode: 'dedicated'; poolId?: Id }
export interface AccountIpRequest {
  ipAssignment?: IpAssignmentRequest
  ipv4?: string
  ipv6?: string | null
  extraIps?: string[]
}
export interface AccountIpContext {
  /** Omitted for a new-account preview; reads never allocate an account ID. */
  accountId?: Id
  ownerId: Id | null
  planDedicatedIp: boolean
  reseller: Pick<Reseller, 'id' | 'delegatedIps'> | null
  pool: readonly ServerIpEntry[]
  allAccounts: readonly Pick<Account, 'id' | 'ipv4' | 'ipv6' | 'extraIps'>[]
  domains?: readonly (Pick<Domain, 'accountId' | 'ipv4' | 'ipv6'> & Partial<Pick<Domain, 'name'>>)[]
  mailIpConfig?: MailIpConfig | null
}
const hostingAddress = (raw: string): string => {
  const { address, version } = canonicalIp(raw), ip = parseIp(address)!
  if (version === 4 ? ip.value >> 24n === 0n || ip.value >> 24n === 127n || ip.value >> 16n === 0xa9fen || ip.value >> 28n >= 0xen : ip.value === 0n || ip.value === 1n || ip.value >> 118n === 0x3fan || ip.value >> 120n === 0xffn) fail('VALIDATION', 'IP address cannot be assigned for hosting')
  return address
}
const addressReferences = (address: string, context: AccountIpContext): boolean => {
  const same = (raw: string | null | undefined) => raw != null && canonicalIp(raw).address === address
  if (context.allAccounts.some(account => account.id !== context.accountId && [account.ipv4, account.ipv6, ...(account.extraIps ?? [])].some(same))) return true
  if (context.domains?.some(domain => domain.accountId !== context.accountId && [domain.ipv4, domain.ipv6].some(same))) return true
  const mail = context.mailIpConfig
  return !!mail && ([mail.defaultIpv4, mail.defaultIpv6].some(same) || mail.domainOverrides.some(override =>
    !context.domains?.some(domain => domain.accountId === context.accountId && domain.name === override.domainName)
    && [override.ipv4, override.ipv6].some(same)))
}
const targetCanUse = (entry: ServerIpEntry, context: AccountIpContext): boolean => {
  if (entry.role === 'mail') return false
  if (entry.ownerKind === 'account') return entry.ownerId === context.accountId
  if (entry.ownerKind === 'reseller') return entry.ownerId === context.ownerId
  return context.ownerId === null || entry.role === 'shared' && entry.isPrimary || !!context.reseller?.delegatedIps.some(raw => canonicalIp(raw).address === entry.address)
}
const assignedAddress = (raw: unknown, context: AccountIpContext, version?: 4 | 6): string => {
  const parsed = canonicalIp(raw)
  if (version && parsed.version !== version) fail('VALIDATION', 'address family does not match requested assignment')
  const address = hostingAddress(parsed.address), entry = context.pool.find(ip => ip.address === address)
  if (!entry || !targetCanUse(entry, context)) return fail('FORBIDDEN', 'IP is not in the account owner’s assignable server pool')
  if (entry.role === 'dedicated') {
    if (!context.planDedicatedIp) fail('FORBIDDEN', 'the hosting plan does not permit a dedicated IP')
    if (addressReferences(address, context)) fail('CONFLICT', 'dedicated IP is already reserved')
  }
  return address
}

/** Run under the state writer lease; the resulting account is the sole reservation record. */
export const resolveAccountIpAssignment = (request: AccountIpRequest, context: AccountIpContext): { ipv4: string; ipv6?: string | null; extraIps?: string[] } => {
  const pool = validateServerIpPool(context.pool)
  context = { ...context, pool }
  if (context.ownerId !== null && context.reseller?.id !== context.ownerId) fail('FORBIDDEN', 'account reseller context is unavailable')
  const assignment = request.ipAssignment
  if (assignment !== undefined && (typeof assignment !== 'object' || assignment === null || !['shared', 'dedicated'].includes(assignment.mode)
    || Object.keys(assignment).some(key => key !== 'mode' && !(assignment.mode === 'dedicated' && key === 'poolId')))) fail('VALIDATION', 'invalid IP assignment request')
  if (assignment?.mode === 'dedicated' && assignment.poolId !== undefined && (typeof assignment.poolId !== 'string' || !UUID_RE.test(assignment.poolId) || assignment.poolId !== assignment.poolId.toLowerCase())) fail('VALIDATION', 'poolId must be a canonical UUID')
  if (assignment !== undefined && request.ipv4 !== undefined) fail('VALIDATION', 'IP assignment mode cannot be combined with a literal IPv4')
  let ipv4: string
  if (request.ipv4 !== undefined) ipv4 = assignedAddress(request.ipv4, context, 4)
  else if (assignment?.mode === 'dedicated') {
    if (!context.planDedicatedIp) fail('FORBIDDEN', 'the hosting plan does not permit a dedicated IP')
    const selected = assignment.poolId === undefined ? undefined : pool.find(entry => entry.id === assignment.poolId)
    if (assignment.poolId !== undefined && (!selected || selected.version !== 4 || selected.role !== 'dedicated' || !targetCanUse(selected, context))) fail('FORBIDDEN', 'dedicated IP selection is unavailable to this owner')
    const entry = selected ?? pool.find(entry => entry.version === 4 && entry.role === 'dedicated' && targetCanUse(entry, context) && !addressReferences(entry.address, context))
    if (!entry) return fail('PRECONDITION_FAILED', 'no unallocated dedicated IPv4 is available', { reason: 'dedicated_ipv4_unavailable', stateChanged: false })
    ipv4 = assignedAddress(entry.address, context, 4)
  } else {
    const entry = pool.find(entry => entry.version === 4 && entry.isPrimary && entry.role === 'shared' && entry.ownerKind === 'root')
    if (!entry) return fail('PRECONDITION_FAILED', 'no default shared IPv4 is configured', { reason: 'shared_ipv4_unavailable', stateChanged: false })
    ipv4 = assignedAddress(entry.address, context, 4)
  }
  const ipv6 = request.ipv6 === undefined ? undefined : request.ipv6 === null ? null : assignedAddress(request.ipv6, context, 6)
  const extraIps = request.extraIps === undefined ? undefined : validateIpList(request.extraIps).map(address => assignedAddress(address, context))
  if (extraIps && extraIps.length !== request.extraIps!.length) fail('VALIDATION', 'an account address cannot be repeated')
  const values = [ipv4, ...(ipv6 ? [ipv6] : []), ...(extraIps ?? [])]
  if (new Set(values).size !== values.length) fail('VALIDATION', 'an account address cannot be repeated')
  return { ipv4, ...(ipv6 !== undefined && { ipv6 }), ...(extraIps !== undefined && { extraIps }) }
}

/** Advisory desired-state projection; commit always repeats selection under the writer lease. */
export const projectAccountIpAvailability = (raw: AccountIpContext) => {
  const context = { ...raw, pool: validateServerIpPool(raw.pool) }
  if (context.ownerId !== null && context.reseller?.id !== context.ownerId) fail('FORBIDDEN', 'account reseller context is unavailable')
  const shared = context.pool.find(entry => entry.version === 4 && entry.isPrimary && entry.role === 'shared' && entry.ownerKind === 'root')
  const unallocated = context.planDedicatedIp ? context.pool.filter(entry => entry.role === 'dedicated' && targetCanUse(entry, context) && !addressReferences(entry.address, context)).map(entry => ({ poolId: entry.id, address: entry.address, version: entry.version })) : []
  return { scope: 'desired-state' as const, hostBinding: 'unverified' as const,
    defaultSharedIpv4: shared ? { poolId: shared.id, address: shared.address } : null,
    dedicated: { entitled: context.planDedicatedIp, unallocated, count: unallocated.length } }
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
    ownerId?: Id | null
    planDedicatedIp?: boolean
    pool?: readonly ServerIpEntry[]
    allAccounts?: readonly Pick<Account, 'id' | 'ipv4' | 'ipv6' | 'extraIps'>[]
  } = {},
): string => {
  const { address, version } = canonicalIp(rawIp, opts.expectedVersion === 6 ? 'ipv6' : 'ip')
  if (opts.expectedVersion && version !== opts.expectedVersion) {
    fail('VALIDATION', `expected IPv${opts.expectedVersion} address, got IPv${version}`, { ip: address })
  }

  const ownerId = opts.ownerId === undefined ? opts.callerKind === 'reseller' ? opts.reseller?.id ?? fail('FORBIDDEN', 'reseller context is required') : null : opts.ownerId
  return assignedAddress(address, { accountId: opts.accountId, ownerId, planDedicatedIp: opts.planDedicatedIp ?? false,
    reseller: opts.reseller ?? null, pool: validateServerIpPool(opts.pool ?? []), allAccounts: opts.allAccounts ?? [] }, opts.expectedVersion)
}

/**
 * Verifies that a domain-specific IPv4 or IPv6 override is already assigned to its account.
 * Delegation or unallocated inventory alone does not reserve an address for a domain.
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
  ].map(value => canonicalIp(value).address))
  if (accountIps.has(address)) return address

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
