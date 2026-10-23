// Pure validation of desired-state JSON files. Both the API (before writing)
// and the root agent (when reading the state tree) run these exact validators.
import { createHash } from 'node:crypto'
import {
  assertAbsPath,
  assertBool,
  assertDbNameOwned,
  assertDbPrivileges,
  assertEmail,
  assertId,
  assertIdOrNull,
  assertInt,
  assertIp,
  assertIpv4,
  assertIpv6,
  assertIsoDate,
  assertLimit,
  assertLine,
  assertName,
  assertPhpSettings,
  assertRedirectTarget,
  assertRelPath,
  assertResellerAcl,
  assertServiceHash,
  assertSha256Hex,
  assertUpstream,
  canonicalIp,
  dbUserName,
  fail,
  isUnlimited,
  limitLte,
  MAX_ACCOUNT_UID,
  MIN_ACCOUNT_UID,
  oneOf,
  parseServiceLogin,
  planErrors,
  validateDocRoot,
  validateDomainCustomConfig,
  validateDomainName,
  validateFirewallRules,
  validateHome,
  validateMailIpConfig,
  validatePrefixList,
  validateServerIpEntry,
  validateServerIpPool,
  validateServerSettings,
  validateUsername,
} from '@xpanel/core'
import type {
  AccountStatus,
  Database,
  DnsRecord,
  DnsRecordType,
  Domain,
  DomainCustomConfig,
  DomainKind,
  FeatureList,
  Plan,
  Reseller,
  ShellAccess,
  SiteType,
} from '@xpanel/core'
import type {
  AllocatedReferenceRecord,
  CronJobState,
  DnsZoneState,
  FirewallState,
  PrefixList,
  StateAuthorityMetadata,
  StateSnapshot,
  StoredAccount,
  StoredCertificate,
  StoredDatabaseUser,
  StoredServerSettings,
  StoredServiceUser,
  UidAllocatorState,
} from './types.ts'

const SHELLS: readonly ShellAccess[] = ['none', 'jailed']
const STATUSES: readonly AccountStatus[] = ['active', 'suspended', 'terminating']
const KINDS: readonly DomainKind[] = ['primary', 'addon', 'alias', 'subdomain']
const SITE_TYPES: readonly SiteType[] = ['php', 'static', 'proxy', 'node', 'python']
const UPSTREAM_TYPES: readonly SiteType[] = ['proxy', 'node', 'python']
const FEATURE_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const AUTH_RE = /^[A-Za-z0-9*+/=]{1,128}$/
const DNS_TYPES: readonly DnsRecordType[] = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA']
const DNS_REL_NAME_RE = /^(@|\*|(\*\.)?[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*)$/
const CRON_SCHEDULE_RE =
  /^(@(yearly|annually|monthly|weekly|daily|hourly|reboot)|[0-9*/,-]{1,64} [0-9*/,-]{1,64} [0-9*/,-]{1,64} [0-9A-Za-z*/,-]{1,64} [0-9A-Za-z*/,-]{1,64})$/

export const assertFeatureKeys = (keys: unknown): string[] => {
  if (!Array.isArray(keys) || keys.length > 1024) return fail('VALIDATION', 'disabled must be a list of feature keys')
  for (const k of keys) {
    if (typeof k !== 'string' || !FEATURE_KEY_RE.test(k)) return fail('VALIDATION', 'invalid feature key', { key: String(k) })
  }
  return [...new Set(keys as string[])].sort()
}

export const assertResellerNameservers = (ns: unknown): string[] => {
  if (!Array.isArray(ns) || ns.length > 8) return fail('VALIDATION', 'nameservers: at most 8 host names')
  const out = ns.map((n) => validateDomainName(n))
  return new Set(out).size === out.length ? out : fail('VALIDATION', 'nameservers must be distinct')
}

export const assertDelegatedIps = (ips: unknown): string[] => {
  if (!Array.isArray(ips) || ips.length > 4096) return fail('VALIDATION', 'delegatedIps must be a list')
  const out = ips.map((ip) =>
    typeof ip === 'string' && ip.includes('/') ? fail('VALIDATION', 'delegated ip must be a single address') : assertIp(ip, 'delegated ip'),
  )
  return [...new Set(out)]
}

export const assertDbAuth = (plugin: unknown, auth: unknown): { authPlugin: 'mysql_native_password' | 'ed25519'; authString: string } => {
  const p = plugin ?? 'mysql_native_password'
  if (p !== 'mysql_native_password' && p !== 'ed25519') return fail('VALIDATION', 'authPlugin must be mysql_native_password or ed25519')
  if (typeof auth !== 'string' || !AUTH_RE.test(auth)) return fail('VALIDATION', 'authString must be a MariaDB hash')
  if (p === 'mysql_native_password' && !/^\*[0-9A-F]{40}$/.test(auth)) return fail('VALIDATION', 'mysql_native_password hash is * + 40 hex')
  return { authPlugin: p, authString: auth }
}

export const validateStoredServer = (v: unknown): StoredServerSettings => {
  if (typeof v !== 'object' || v === null) return fail('VALIDATION', 'server state must be an object')
  const o = v as Record<string, unknown>
  return {
    settings: validateServerSettings(o.settings as StoredServerSettings['settings']),
    setupCompletedAt: o.setupCompletedAt == null ? null : assertIsoDate(o.setupCompletedAt, 'setupCompletedAt').toISOString(),
    updatedAt: assertIsoDate(o.updatedAt, 'updatedAt').toISOString(),
  }
}

export const validatePrefixLists = (lists: unknown): PrefixList[] => {
  if (!Array.isArray(lists) || lists.length > 256) return fail('VALIDATION', 'prefixLists must be an array of at most 256 lists')
  const out = lists.map((l: { name?: unknown; entries?: unknown }) => validatePrefixList(l?.name, l?.entries))
  const seen = new Set<string>()
  for (const l of out) {
    if (seen.has(l.name)) fail('VALIDATION', `duplicate prefix list "${l.name}"`, { name: l.name })
    seen.add(l.name)
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export const validateFirewallState = (v: unknown): FirewallState => {
  if (typeof v !== 'object' || v === null) return fail('VALIDATION', 'firewall state must be an object')
  const o = v as Record<string, unknown>
  const rules = validateFirewallRules(o.rules)
  const prefixLists = validatePrefixLists(o.prefixLists ?? [])
  const names = new Set(prefixLists.map((l) => l.name))
  for (const r of rules) {
    if (r.list !== null && !names.has(r.list)) fail('VALIDATION', `prefix list "${r.list}" does not exist`, { list: r.list, ruleId: r.id })
  }
  return { rules, prefixLists }
}

const START_ACCOUNT_UID = 20000

export const validateUidAllocator = (v: unknown): UidAllocatorState => {
  if (typeof v !== 'object' || v === null) return fail('VALIDATION', 'uid allocator state must be an object')
  const o = v as Record<string, unknown>
  const nextUid = assertInt(o.nextUid, START_ACCOUNT_UID, MAX_ACCOUNT_UID + 1, 'nextUid')
  if (!Array.isArray(o.allocated)) return fail('VALIDATION', 'allocated must be an array')
  const seenUids = new Set<number>()
  const allocated = o.allocated.map((item) => {
    if (typeof item !== 'object' || item === null) return fail('VALIDATION', 'uid allocation must be an object')
    const rec = item as Record<string, unknown>
    const uid = assertInt(rec.uid, START_ACCOUNT_UID, MAX_ACCOUNT_UID, 'uid')
    if (seenUids.has(uid)) fail('VALIDATION', `duplicate allocated uid ${uid}`)
    if (uid >= nextUid) fail('VALIDATION', `allocated uid ${uid} >= nextUid ${nextUid}`)
    seenUids.add(uid)
    return {
      uid,
      username: validateUsername(rec.username as string),
      allocatedAt: assertIsoDate(rec.allocatedAt, 'allocatedAt').toISOString(),
    }
  })
  return { nextUid, allocated }
}

export const validateFeatureListFile = (v: unknown): FeatureList => {
  if (typeof v !== 'object' || v === null) return fail('VALIDATION', 'feature list must be an object')
  const o = v as Record<string, unknown>
  return {
    id: assertId(o.id, 'id'),
    name: assertName(o.name, 'name'),
    ownerId: assertIdOrNull(o.ownerId ?? null, 'ownerId'),
    disabled: assertFeatureKeys(o.disabled),
  }
}

export const validatePlanFile = (v: unknown): Plan => {
  if (typeof v !== 'object' || v === null) return fail('VALIDATION', 'plan must be an object')
  const p = v as Plan
  const errors = planErrors(p)
  if (errors.length > 0) fail('VALIDATION', `invalid plan: ${errors.join('; ')}`, { errors })
  return {
    id: assertId(p.id, 'id'),
    name: p.name,
    ownerId: assertIdOrNull(p.ownerId ?? null, 'ownerId'),
    featureListId: assertId(p.featureListId, 'featureListId'),
    resources: { ...p.resources },
    caps: { ...p.caps },
    dedicatedIp: p.dedicatedIp,
    shell: p.shell,
    defaultMailboxQuotaMb: p.defaultMailboxQuotaMb,
  }
}

export const validateResellerFile = (v: unknown): Reseller => {
  if (typeof v !== 'object' || v === null) return fail('VALIDATION', 'reseller must be an object')
  const r = v as Record<string, unknown>
  return {
    id: assertId(r.id, 'id'),
    username: validateUsername(r.username as string),
    acl: assertResellerAcl(r.acl),
    maxAccounts: assertLimit(r.maxAccounts, 'maxAccounts', { min: 0 }),
    totalDiskMb: assertLimit(r.totalDiskMb, 'totalDiskMb', { min: 0 }),
    totalBandwidthMb: assertLimit(r.totalBandwidthMb, 'totalBandwidthMb', { min: 0 }),
    oversell: assertBool(r.oversell, 'oversell'),
    nameservers: assertResellerNameservers(r.nameservers),
    delegatedIps: assertDelegatedIps(r.delegatedIps),
  }
}

export const validateAccountFile = (v: unknown): StoredAccount => {
  if (typeof v !== 'object' || v === null) return fail('VALIDATION', 'account must be an object')
  const a = v as Record<string, unknown>
  const username = validateUsername(a.username as string)
  const uid = assertInt(a.uid, MIN_ACCOUNT_UID, MAX_ACCOUNT_UID, 'uid')
  const gid = assertInt(a.gid, MIN_ACCOUNT_UID, MAX_ACCOUNT_UID, 'gid')
  if (gid !== uid) fail('VALIDATION', 'gid must equal uid')
  const home = validateHome(a.home as string)
  if (!home.endsWith(`/${username}`)) fail('VALIDATION', 'home must end with /<username>')
  const status = oneOf(a.status, STATUSES, 'status')
  const suspendReason = a.suspendReason == null ? null : assertLine(a.suspendReason, 512, 'suspendReason', { allowEmpty: false })
  const suspendedAt = a.suspendedAt == null ? null : assertIsoDate(a.suspendedAt, 'suspendedAt').toISOString()
  if (status === 'suspended' && suspendedAt === null) fail('VALIDATION', 'suspended account needs suspendedAt')
  if (status !== 'suspended' && (suspendReason !== null || suspendedAt !== null)) {
    fail('VALIDATION', 'non-suspended account must not have suspendReason or suspendedAt')
  }
  return {
    id: assertId(a.id, 'id'),
    username,
    uid,
    gid,
    home,
    primaryDomain: validateDomainName(a.primaryDomain as string),
    planId: assertId(a.planId, 'planId'),
    ownerId: assertIdOrNull(a.ownerId ?? null, 'ownerId'),
    status,
    suspendReason,
    suspendedAt,
    contactEmail: assertEmail(a.contactEmail, 'contactEmail'),
    ipv4: assertIpv4(a.ipv4, 'ipv4'),
    ...(a.ipv6 != null && { ipv6: assertIpv6(a.ipv6, 'ipv6') }),
    ...(Array.isArray(a.extraIps) &&
      a.extraIps.length > 0 && {
        extraIps: [...new Set(a.extraIps.map((ip) => canonicalIp(ip, 'extraIp').address))],
      }),
    shell: oneOf(a.shell, SHELLS, 'shell'),
    createdAt: assertIsoDate(a.createdAt, 'createdAt').toISOString(),
  }
}

export const validateDomainFile = (
  v: unknown,
  ctx: { account: StoredAccount; plan: Plan; reservedLoopbackPorts: ReadonlySet<number> },
): Domain => {
  if (typeof v !== 'object' || v === null) return fail('VALIDATION', 'domain must be an object')
  const d = v as Record<string, unknown>
  const id = assertId(d.id, 'id')
  const accountId = assertId(d.accountId, 'accountId')
  if (accountId !== ctx.account.id) fail('VALIDATION', 'domain accountId does not match owning account')
  const name = validateDomainName(d.name as string)
  const kind = oneOf(d.kind, KINDS, 'kind')
  const parentId = assertIdOrNull(d.parentId ?? null, 'parentId')
  if ((kind === 'primary' || kind === 'addon') !== (parentId === null)) {
    fail('VALIDATION', `${kind} domains ${parentId === null ? 'need a' : 'have no'} parent`)
  }
  if (parentId !== null && parentId === id) fail('VALIDATION', 'domain cannot be its own parent')
  const docRoot = validateDocRoot(ctx.account.home, d.docRoot as string)
  const siteType = oneOf(d.siteType, SITE_TYPES, 'siteType')
  const needsUpstream = UPSTREAM_TYPES.includes(siteType)
  if (needsUpstream !== (d.upstream !== null && d.upstream !== undefined)) {
    fail('VALIDATION', needsUpstream ? `${siteType} sites need an upstream` : `${siteType} sites take no upstream`)
  }
  let upstream: string | null = null
  if (needsUpstream) {
    const target = assertUpstream(d.upstream)
    if (target.loopbackPort !== null && (target.loopbackPort < 1024 || ctx.reservedLoopbackPorts.has(target.loopbackPort))) {
      fail('VALIDATION', 'a local upstream must use an unprivileged port that is not the panel, SSH or web backend port', { upstream: target.url })
    }
    upstream = target.url
  }
  let redirect: { to: string; code: 301 | 302 } | null = null
  if (d.redirect !== null && d.redirect !== undefined) {
    const r = d.redirect as { to?: unknown; code?: unknown }
    if (typeof r !== 'object' || (r.code !== 301 && r.code !== 302)) {
      return fail('VALIDATION', 'redirect must be { to, code: 301 | 302 }')
    }
    redirect = { to: assertRedirectTarget(r.to), code: r.code }
  }
  const pathQuotaMb = assertLimit(d.pathQuotaMb, 'pathQuotaMb', { min: 1 })
  if (!isUnlimited(pathQuotaMb) && !limitLte(pathQuotaMb, ctx.plan.resources.diskMb)) {
    fail('VALIDATION', 'pathQuotaMb may not exceed the account disk quota', { pathQuotaMb, diskMb: ctx.plan.resources.diskMb })
  }
  return {
    id,
    accountId,
    name,
    kind,
    parentId,
    docRoot,
    siteType,
    upstream,
    redirect,
    php: assertPhpSettings(d.php, { phpWorkers: ctx.plan.caps.phpWorkers, memoryMb: ctx.plan.resources.memoryMb }),
    wildcard: assertBool(d.wildcard, 'wildcard'),
    certificateId: assertIdOrNull(d.certificateId ?? null, 'certificateId'),
    suspended: assertBool(d.suspended, 'suspended'),
    expiresAt: d.expiresAt == null ? null : assertIsoDate(d.expiresAt, 'expiresAt').toISOString(),
    pathQuotaMb,
    ...(d.ipv4 != null && { ipv4: assertIpv4(d.ipv4, 'domain.ipv4') }),
    ...(d.ipv6 != null && { ipv6: assertIpv6(d.ipv6, 'domain.ipv6') }),
  }
}

export const validateServiceUserFile = (
  v: unknown,
  ctx: { account: StoredAccount; plan: Plan; domainsById: ReadonlyMap<string, Domain> },
): StoredServiceUser => {
  if (typeof v !== 'object' || v === null) return fail('VALIDATION', 'service user must be an object')
  const u = v as Record<string, unknown>
  const id = assertId(u.id, 'id')
  const accountId = assertId(u.accountId, 'accountId')
  if (accountId !== ctx.account.id) fail('VALIDATION', 'service user accountId mismatch')
  const domainId = assertId(u.domainId, 'domainId')
  const dom = ctx.domainsById.get(domainId)
  if (!dom || dom.accountId !== accountId) return fail('VALIDATION', 'service user domain does not belong to account')
  const localPart = typeof u.localPart === 'string' ? u.localPart : fail('VALIDATION', 'localPart must be a string')
  const parsed = parseServiceLogin(`${localPart}@${dom.name}`)
  const s = u.services as StoredServiceUser['services']
  if (typeof s !== 'object' || s === null || ![s.email, s.ftp, s.webdisk].every((b) => typeof b === 'boolean')) {
    return fail('VALIDATION', 'services must be { email, ftp, webdisk } booleans')
  }
  if (!s.email && !s.ftp && !s.webdisk) return fail('VALIDATION', 'a service user needs at least one service')
  const mailboxQuotaMb = assertLimit(u.mailboxQuotaMb, 'mailboxQuotaMb', { min: 1 })
  if (!isUnlimited(mailboxQuotaMb) && !limitLte(mailboxQuotaMb, ctx.plan.resources.diskMb)) {
    fail('VALIDATION', 'mailboxQuotaMb may not exceed the account disk quota')
  }
  return {
    id,
    accountId,
    domainId,
    localPart: parsed.local,
    login: `${parsed.local}@${dom.name}`,
    passwordHash: assertServiceHash(u.passwordHash),
    services: { email: s.email, ftp: s.ftp, webdisk: s.webdisk },
    mailboxQuotaMb,
    ftpDir: assertRelPath(u.ftpDir, 'ftpDir'),
  }
}

export const validateDatabaseFile = (v: unknown, account: StoredAccount): Database => {
  if (typeof v !== 'object' || v === null) return fail('VALIDATION', 'database must be an object')
  const d = v as Record<string, unknown>
  const accountId = assertId(d.accountId, 'accountId')
  if (accountId !== account.id) fail('VALIDATION', 'database accountId mismatch')
  if (d.engine !== 'mariadb') fail('VALIDATION', 'engine must be mariadb')
  return {
    id: assertId(d.id, 'id'),
    accountId,
    engine: 'mariadb',
    name: assertDbNameOwned(account.username, d.name as string),
    trashedAt: d.trashedAt == null ? null : assertIsoDate(d.trashedAt, 'trashedAt').toISOString(),
  }
}

export const validateDatabaseUserFile = (
  v: unknown,
  ctx: { account: StoredAccount; databasesById: ReadonlyMap<string, Database> },
): StoredDatabaseUser => {
  if (typeof v !== 'object' || v === null) return fail('VALIDATION', 'database user must be an object')
  const u = v as Record<string, unknown>
  const accountId = assertId(u.accountId, 'accountId')
  if (accountId !== ctx.account.id) fail('VALIDATION', 'database user accountId mismatch')
  const owned = assertDbNameOwned(ctx.account.username, u.name as string)
  const name = dbUserName(ctx.account.username, owned.slice(ctx.account.username.length + 1))
  const auth = assertDbAuth(u.authPlugin, u.authString)
  if (!Array.isArray(u.grants)) return fail('VALIDATION', 'grants must be a list')
  const grants = u.grants
    .map((g: { databaseId?: unknown; privileges?: unknown }) => {
      const databaseId = assertId(g?.databaseId, 'databaseId')
      const target = ctx.databasesById.get(databaseId)
      if (!target || target.accountId !== accountId) fail('FORBIDDEN', 'database belongs to another account')
      return { databaseId, privileges: assertDbPrivileges(g?.privileges) }
    })
    .sort((a, b) => a.databaseId.localeCompare(b.databaseId))
  return {
    id: assertId(u.id, 'id'),
    accountId,
    name,
    ...auth,
    grants,
  }
}

export const validateCertificateFile = (v: unknown): StoredCertificate => {
  if (typeof v !== 'object' || v === null) return fail('VALIDATION', 'certificate must be an object')
  const c = v as Record<string, unknown>
  if (!Array.isArray(c.names) || c.names.length < 1 || c.names.length > 100) {
    return fail('VALIDATION', 'certificate names must be 1..100 names')
  }
  const names = c.names.map((n) => {
    if (typeof n !== 'string') return fail('VALIDATION', 'certificate name must be string')
    return n.startsWith('*.') ? `*.${validateDomainName(n.slice(2))}` : validateDomainName(n)
  })
  const source = oneOf(c.source, ['acme', 'upload', 'self-signed'] as const, 'source')
  const challenge = c.challenge == null ? null : oneOf(c.challenge, ['http-01', 'dns-01'] as const, 'challenge')
  if ((source === 'acme') !== (challenge !== null)) fail('VALIDATION', 'acme certificates require a challenge; others take null')
  const autoRenew = assertBool(c.autoRenew ?? false, 'autoRenew')
  if (source !== 'acme' && autoRenew) fail('VALIDATION', 'only acme certificates can autoRenew')
  if (challenge === 'http-01' && names.some((n) => n.startsWith('*.'))) fail('VALIDATION', 'wildcard certificates require dns-01')
  const notBefore = c.notBefore == null ? null : assertIsoDate(c.notBefore, 'notBefore').toISOString()
  const notAfter = assertIsoDate(c.notAfter, 'notAfter').toISOString()
  if (notBefore !== null && new Date(notBefore) >= new Date(notAfter)) fail('VALIDATION', 'notBefore must be before notAfter')
  return {
    id: assertId(c.id, 'id'),
    accountId: assertIdOrNull(c.accountId ?? null, 'accountId'),
    names,
    source,
    challenge,
    notBefore,
    notAfter,
    autoRenew,
    certPath: assertAbsPath(c.certPath, 'certPath'),
    keyPath: assertAbsPath(c.keyPath, 'keyPath'),
    chainPath: c.chainPath == null ? null : assertAbsPath(c.chainPath, 'chainPath'),
    fingerprintSha256: c.fingerprintSha256 == null ? null : assertSha256Hex(c.fingerprintSha256, 'fingerprintSha256'),
    lastError: c.lastError == null ? null : assertLine(c.lastError, 4000, 'lastError'),
    renewedAt: c.renewedAt == null ? null : assertIsoDate(c.renewedAt, 'renewedAt').toISOString(),
  }
}

export const validateDnsZoneFile = (v: unknown): DnsZoneState => {
  if (typeof v !== 'object' || v === null) return fail('VALIDATION', 'dns zone must be an object')
  const z = v as Record<string, unknown>
  const zoneName = validateDomainName(z.name as string)
  const serial = assertInt(z.serial, 1, 4_294_967_295, 'serial')
  if (!Array.isArray(z.records)) return fail('VALIDATION', 'zone records must be an array')
  const records: DnsRecord[] = z.records.map((r: Record<string, unknown>) => {
    const type = oneOf(r.type, DNS_TYPES, 'type')
    const name = typeof r.name === 'string' && r.name.length <= 253 && DNS_REL_NAME_RE.test(r.name) ? r.name : fail('VALIDATION', 'invalid dns record name')
    const priority = r.priority == null ? null : assertInt(r.priority, 0, 65535, 'priority')
    if ((type === 'MX' || type === 'SRV') !== (priority !== null)) fail('VALIDATION', `${type} records ${priority === null ? 'require' : ' forbid'} priority`)
    const content = assertLine(r.content, 4096, 'content', { allowEmpty: false })
    if (type === 'A') assertIpv4(content, 'A record content')
    if (type === 'AAAA') {
      const ip = assertIp(content, 'AAAA record content')
      if (!ip.includes(':')) fail('VALIDATION', 'AAAA record must be IPv6')
    }
    return {
      id: assertId(r.id, 'id'),
      zone: zoneName,
      name,
      type,
      ttl: assertInt(r.ttl ?? 14400, 0, 2_147_483_647, 'ttl'),
      content,
      priority,
    }
  })
  return {
    id: assertId(z.id, 'id'),
    accountId: assertIdOrNull(z.accountId ?? null, 'accountId'),
    name: zoneName,
    serial,
    records,
  }
}

export const validateCronJob = (v: unknown, accountId: string): CronJobState => {
  if (typeof v !== 'object' || v === null) return fail('VALIDATION', 'cron job must be an object')
  const c = v as Record<string, unknown>
  const schedule = typeof c.schedule === 'string' && CRON_SCHEDULE_RE.test(c.schedule) ? c.schedule : fail('VALIDATION', 'invalid cron schedule')
  return {
    id: assertId(c.id, 'id'),
    accountId: assertId(c.accountId ?? accountId, 'accountId'),
    schedule,
    command: assertLine(c.command, 4096, 'command', { allowEmpty: false }),
    comment: assertLine(c.comment ?? '', 255, 'comment'),
    enabled: assertBool(c.enabled ?? true, 'enabled'),
  }
}

export const validateDomainCustomConfigFile = (
  v: unknown,
  ctx: { account: StoredAccount; domainsById: ReadonlyMap<string, Domain> },
): DomainCustomConfig => {
  const cfg = validateDomainCustomConfig(v, {
    accountId: ctx.account.id,
    accountHome: ctx.account.home,
  })
  const dom = ctx.domainsById.get(cfg.domainId)
  if (!dom || dom.accountId !== ctx.account.id) {
    fail('VALIDATION', 'custom config domain does not belong to account', { domainId: cfg.domainId })
  }
  return cfg
}

export const validateIpPoolFile = (v: unknown) => {
  return validateServerIpPool(v)
}

export const validateMailIpConfigFile = (v: unknown) => validateMailIpConfig(v)

const REFERENCE_PREFIX_RE = /^[A-Z]{2,8}$/
const SHORT_REFERENCE_RE = /^([A-Z]{2,8})-([0-9]{6,12})$/

const REFERENCE_KIND_ALIASES: Readonly<Record<string, string>> = {
  JOB: 'JOB',
  job: 'JOB',
  jobs: 'JOB',
  BKP: 'BKP',
  bkp: 'BKP',
  backup: 'BKP',
  backups: 'BKP',
  BACKUP: 'BKP',
  MIG: 'MIG',
  mig: 'MIG',
  migration: 'MIG',
  migrations: 'MIG',
  MIGRATION: 'MIG',
  transfer: 'MIG',
  TRANSFER: 'MIG',
  GEN: 'GEN',
  gen: 'GEN',
  generation: 'GEN',
  generations: 'GEN',
  GENERATION: 'GEN',
  UPG: 'UPG',
  upg: 'UPG',
  upgrade: 'UPG',
  upgrades: 'UPG',
  UPGRADE: 'UPG',
}

export const normalizeReferenceKind = (kind: unknown): string => {
  if (typeof kind !== 'string' || kind.trim().length === 0) {
    return fail('VALIDATION', 'reference kind must be a non-empty ASCII string')
  }
  const trimmed = kind.trim()
  const mapped = REFERENCE_KIND_ALIASES[trimmed] ?? REFERENCE_KIND_ALIASES[trimmed.toLowerCase()]
  if (mapped) return mapped
  if (REFERENCE_PREFIX_RE.test(trimmed)) return trimmed
  return fail('VALIDATION', `invalid reference kind "${trimmed}" (expected uppercase ASCII prefix like JOB, BKP, MIG, GEN)`, {
    kind: trimmed,
  })
}

export const formatShortReference = (kind: unknown, sequence: number): string => {
  const prefix = normalizeReferenceKind(kind)
  const seq = assertInt(sequence, 1, 999_999_999, 'sequence')
  const digits = String(seq).padStart(6, '0')
  return `${prefix}-${digits}`
}

export const isValidShortReference = (ref: unknown): ref is string => {
  if (typeof ref !== 'string') return false
  const m = SHORT_REFERENCE_RE.exec(ref)
  if (!m) return false
  const seq = Number(m[2])
  return Number.isSafeInteger(seq) && seq >= 1
}

export const validateShortReference = (ref: unknown, field = 'reference'): string => {
  if (!isValidShortReference(ref)) {
    return fail('VALIDATION', `${field} must be a canonical ASCII reference (e.g. JOB-000001), never a truncated UUID`, {
      [field]: String(ref).slice(0, 64),
    })
  }
  return ref
}

export const validateStateAuthority = (v: unknown): StateAuthorityMetadata => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return fail('VALIDATION', 'state authority metadata must be an object')
  }
  const o = v as Record<string, unknown>
  const committedLeaseId = o.committedLeaseId
  if (committedLeaseId !== undefined && (typeof committedLeaseId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(committedLeaseId))) fail('VALIDATION', 'committedLeaseId must be a UUID')
  const revision = assertInt(o.revision, 0, Number.MAX_SAFE_INTEGER, 'revision')
  const fencingToken = assertInt(o.fencingToken, 0, Number.MAX_SAFE_INTEGER, 'fencingToken')
  const updatedAt = assertIsoDate(o.updatedAt, 'updatedAt').toISOString()

  if (typeof o.references !== 'object' || o.references === null || Array.isArray(o.references)) {
    return fail('VALIDATION', 'authority references must be an object')
  }
  const references: Record<string, number> = {}
  for (const [rawKey, rawVal] of Object.entries(o.references as Record<string, unknown>)) {
    const prefix = normalizeReferenceKind(rawKey)
    const count = assertInt(rawVal, 0, 999_999_999, `references.${prefix}`)
    references[prefix] = count
  }

  let allocatedReferences: Record<string, AllocatedReferenceRecord> | undefined
  if (o.allocatedReferences !== undefined) {
    if (typeof o.allocatedReferences !== 'object' || o.allocatedReferences === null || Array.isArray(o.allocatedReferences)) {
      return fail('VALIDATION', 'allocatedReferences must be an object')
    }
    allocatedReferences = {}
    for (const [key, item] of Object.entries(o.allocatedReferences as Record<string, unknown>)) {
      if (typeof item !== 'object' || item === null) return fail('VALIDATION', 'allocatedReference entry must be an object')
      const rec = item as Record<string, unknown>
      const kind = normalizeReferenceKind(rec.kind)
      const sequence = assertInt(rec.sequence, 1, 999_999_999, 'allocatedReference.sequence')
      const ref = validateShortReference(rec.ref, 'allocatedReference.ref')
      if (ref !== formatShortReference(kind, sequence)) {
        return fail('VALIDATION', `allocatedReference.ref "${ref}" does not match ${kind} sequence ${sequence}`)
      }
      if ((references[kind] ?? 0) < sequence) {
        return fail('VALIDATION', `allocatedReference sequence ${sequence} exceeds counter for ${kind}`)
      }
      allocatedReferences[key] = {
        ref,
        kind,
        sequence,
        entityId: rec.entityId == null ? null : assertLine(rec.entityId, 128, 'entityId', { allowEmpty: false }),
        allocatedAt: assertIsoDate(rec.allocatedAt, 'allocatedAt').toISOString(),
      }
    }
  }

  return {
    ...(committedLeaseId !== undefined ? { committedLeaseId: committedLeaseId as string } : {}),
    revision,
    fencingToken,
    updatedAt,
    references,
    ...(allocatedReferences && Object.keys(allocatedReferences).length > 0 ? { allocatedReferences } : {}),
  }
}

/** Deterministic SHA-256 of the entire desired state (excluding volatile timestamps). */
export const checksumStateTree = (tree: Omit<StateSnapshot, 'checksum' | 'revision'> & { revision?: number }): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        server: tree.server ? { settings: tree.server.settings, setupCompletedAt: tree.server.setupCompletedAt } : null,
        firewall: tree.firewall,
        featureLists: tree.featureLists,
        plans: tree.plans,
        resellers: tree.resellers,
        accounts: tree.accounts,
        domains: tree.domains,
        serviceUsers: tree.serviceUsers,
        databases: tree.databases,
        databaseUsers: tree.databaseUsers,
        certificates: tree.certificates,
        zones: tree.zones,
        cronJobs: tree.cronJobs,
        ...(tree.domainCustomConfigs && tree.domainCustomConfigs.length > 0
          ? {
              domainCustomConfigs: tree.domainCustomConfigs.map((c) => ({
                domainId: c.domainId,
                accountId: c.accountId,
                nginxInclude: c.nginxInclude,
                apacheInclude: c.apacheInclude,
                userIni: c.userIni,
                customHeaders: c.customHeaders,
                cacheBypassPaths: c.cacheBypassPaths,
              })),
            }
          : {}),
        ...(tree.ipPool && tree.ipPool.length > 0 ? { ipPool: tree.ipPool } : {}),
        ...(tree.mailIpConfig ? { mailIpConfig: tree.mailIpConfig } : {}),
      }),
      'utf8',
    )
    .digest('hex')
