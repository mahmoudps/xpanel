// Row <-> core type mappers. Limits: SQL NULL <-> 'unlimited', explicitly.
import { fail, formatCidr, parseCidr, parseServiceLogin } from '@xpanel/core'
import type {
  Account,
  AuditEntry,
  Domain,
  FirewallRule,
  Id,
  Limit,
  PhpSettings,
  Plan,
  Reseller,
  ResellerAcl,
  ServerSettings,
  ServiceUser,
} from '@xpanel/core'
import type {
  accounts,
  auditLog,
  domains,
  firewallRules,
  plans,
  resellers,
  serverSettings,
  serviceUsers,
} from './schema.ts'

export type PlanRow = typeof plans.$inferSelect
export type PlanInsert = typeof plans.$inferInsert
export type AccountRow = typeof accounts.$inferSelect
export type AccountInsert = typeof accounts.$inferInsert
export type ResellerRow = typeof resellers.$inferSelect
export type ResellerInsert = typeof resellers.$inferInsert
export type DomainRow = typeof domains.$inferSelect
export type DomainInsert = typeof domains.$inferInsert
export type ServiceUserRow = typeof serviceUsers.$inferSelect
export type ServiceUserInsert = typeof serviceUsers.$inferInsert
export type FirewallRuleRow = typeof firewallRules.$inferSelect
export type FirewallRuleInsert = typeof firewallRules.$inferInsert
export type ServerSettingsRow = typeof serverSettings.$inferSelect
export type ServerSettingsInsert = typeof serverSettings.$inferInsert
export type AuditRow = typeof auditLog.$inferSelect

const MAX_LIMIT = Number.MAX_SAFE_INTEGER

export const limitFromDb = (v: number | null): Limit => (v === null ? 'unlimited' : v)

/** 'unlimited' -> NULL; anything but a non-negative safe integer is rejected (no -1, no NaN, no 1.5). */
export const limitToDb = (l: Limit, what = 'limit'): number | null => {
  if (l === 'unlimited') return null
  if (typeof l !== 'number' || !Number.isSafeInteger(l) || l < 0 || l > MAX_LIMIT) {
    return fail('VALIDATION', `${what} must be a non-negative integer or 'unlimited'`, { what, value: String(l) })
  }
  return l
}

/** Postgres prints inet/cidr hosts as `a.b.c.d/32`; core's canonical form is the bare address. */
export const canonicalCidr = (v: string): string => {
  const c = parseCidr(v)
  return c ? formatCidr(c) : fail('VALIDATION', 'stored network is not a valid CIDR', { value: v })
}

const iso = (d: Date): string => d.toISOString()
const isoOrNull = (d: Date | null): string | null => (d ? d.toISOString() : null)

// ---------------------------------------------------------------- plan

export const planFromRow = (r: PlanRow): Plan => ({
  id: r.id,
  name: r.name,
  ownerId: r.ownerId,
  featureListId: r.featureListId,
  resources: {
    diskMb: limitFromDb(r.diskMb),
    bandwidthMbMonth: limitFromDb(r.bandwidthMbMonth),
    ioReadBps: limitFromDb(r.ioReadBps),
    ioWriteBps: limitFromDb(r.ioWriteBps),
    ioReadIops: limitFromDb(r.ioReadIops),
    ioWriteIops: limitFromDb(r.ioWriteIops),
    memoryMb: limitFromDb(r.memoryMb),
    maxProcesses: limitFromDb(r.maxProcesses),
    cpuPercent: limitFromDb(r.cpuPercent),
  },
  caps: {
    addonDomains: limitFromDb(r.addonDomains),
    aliasDomains: limitFromDb(r.aliasDomains),
    subdomains: limitFromDb(r.subdomains),
    mailboxes: limitFromDb(r.mailboxes),
    forwarders: limitFromDb(r.forwarders),
    mailingLists: limitFromDb(r.mailingLists),
    ftpAccounts: limitFromDb(r.ftpAccounts),
    databases: limitFromDb(r.databases),
    phpWorkers: limitFromDb(r.phpWorkers),
  },
  dedicatedIp: r.dedicatedIp,
  shell: r.shell,
  defaultMailboxQuotaMb: limitFromDb(r.defaultMailboxQuotaMb),
})

export const planResourcesToRow = (res: Plan['resources']) => ({
  diskMb: limitToDb(res.diskMb, 'resources.diskMb'),
  bandwidthMbMonth: limitToDb(res.bandwidthMbMonth, 'resources.bandwidthMbMonth'),
  ioReadBps: limitToDb(res.ioReadBps, 'resources.ioReadBps'),
  ioWriteBps: limitToDb(res.ioWriteBps, 'resources.ioWriteBps'),
  ioReadIops: limitToDb(res.ioReadIops, 'resources.ioReadIops'),
  ioWriteIops: limitToDb(res.ioWriteIops, 'resources.ioWriteIops'),
  memoryMb: limitToDb(res.memoryMb, 'resources.memoryMb'),
  maxProcesses: limitToDb(res.maxProcesses, 'resources.maxProcesses'),
  cpuPercent: limitToDb(res.cpuPercent, 'resources.cpuPercent'),
})

export const planCapsToRow = (caps: Plan['caps']) => ({
  addonDomains: limitToDb(caps.addonDomains, 'caps.addonDomains'),
  aliasDomains: limitToDb(caps.aliasDomains, 'caps.aliasDomains'),
  subdomains: limitToDb(caps.subdomains, 'caps.subdomains'),
  mailboxes: limitToDb(caps.mailboxes, 'caps.mailboxes'),
  forwarders: limitToDb(caps.forwarders, 'caps.forwarders'),
  mailingLists: limitToDb(caps.mailingLists, 'caps.mailingLists'),
  ftpAccounts: limitToDb(caps.ftpAccounts, 'caps.ftpAccounts'),
  databases: limitToDb(caps.databases, 'caps.databases'),
  phpWorkers: limitToDb(caps.phpWorkers, 'caps.phpWorkers'),
})

export const planToRow = (p: Omit<Plan, 'id'> & { id?: Id }): PlanInsert => ({
  ...(p.id ? { id: p.id } : {}),
  name: p.name,
  ownerId: p.ownerId,
  featureListId: p.featureListId,
  ...planResourcesToRow(p.resources),
  ...planCapsToRow(p.caps),
  dedicatedIp: p.dedicatedIp,
  shell: p.shell,
  defaultMailboxQuotaMb: limitToDb(p.defaultMailboxQuotaMb, 'defaultMailboxQuotaMb'),
})

// ---------------------------------------------------------------- account

export const accountFromRow = (r: AccountRow): Account => ({
  id: r.id,
  username: r.username,
  uid: r.uid,
  gid: r.gid,
  home: r.home,
  primaryDomain: r.primaryDomain,
  planId: r.planId,
  ownerId: r.ownerId,
  status: r.status,
  suspendReason: r.suspendReason,
  contactEmail: r.contactEmail,
  ipv4: r.ipv4,
  shell: r.shell,
  createdAt: iso(r.createdAt),
})

/** The core type carries no suspension time, so a suspended account needs `suspendedAt`. */
export const accountToRow = (a: Account, opts: { suspendedAt?: Date } = {}): AccountInsert => ({
  id: a.id,
  username: a.username,
  uid: a.uid,
  gid: a.gid,
  home: a.home,
  primaryDomain: a.primaryDomain,
  planId: a.planId,
  ownerId: a.ownerId,
  status: a.status,
  suspendReason: a.suspendReason,
  suspendedAt:
    a.status !== 'suspended'
      ? null
      : (opts.suspendedAt ?? fail('VALIDATION', 'a suspended account needs suspendedAt', { id: a.id })),
  contactEmail: a.contactEmail,
  ipv4: a.ipv4,
  shell: a.shell,
  createdAt: new Date(a.createdAt),
})

// ---------------------------------------------------------------- reseller

export const resellerFromRow = (r: ResellerRow & { username: string }): Reseller => ({
  id: r.id,
  username: r.username,
  acl: r.acl as ResellerAcl[],
  maxAccounts: limitFromDb(r.maxAccounts),
  totalDiskMb: limitFromDb(r.totalDiskMb),
  totalBandwidthMb: limitFromDb(r.totalBandwidthMb),
  oversell: r.oversell,
  nameservers: r.nameservers,
  delegatedIps: r.delegatedIps.map(canonicalCidr),
})

/** The username lives on the principal row. */
export const resellerToRow = (r: Reseller): ResellerInsert => ({
  id: r.id,
  acl: [...new Set(r.acl)],
  maxAccounts: limitToDb(r.maxAccounts, 'maxAccounts'),
  totalDiskMb: limitToDb(r.totalDiskMb, 'totalDiskMb'),
  totalBandwidthMb: limitToDb(r.totalBandwidthMb, 'totalBandwidthMb'),
  oversell: r.oversell,
  nameservers: r.nameservers,
  delegatedIps: r.delegatedIps,
})

// ---------------------------------------------------------------- domain

export const domainFromRow = (r: DomainRow): Domain => ({
  id: r.id,
  accountId: r.accountId,
  name: r.name,
  kind: r.kind,
  parentId: r.parentId,
  docRoot: r.docRoot,
  siteType: r.siteType,
  upstream: r.upstream,
  redirect: r.redirectTo !== null && r.redirectCode !== null ? { to: r.redirectTo, code: r.redirectCode as 301 | 302 } : null,
  php: r.php as PhpSettings,
  wildcard: r.wildcard,
  certificateId: r.certificateId,
  suspended: r.suspended,
  expiresAt: isoOrNull(r.expiresAt),
  pathQuotaMb: limitFromDb(r.pathQuotaMb),
})

export const domainToRow = (d: Omit<Domain, 'id'> & { id?: Id }): DomainInsert => ({
  ...(d.id ? { id: d.id } : {}),
  accountId: d.accountId,
  name: d.name,
  kind: d.kind,
  parentId: d.parentId,
  docRoot: d.docRoot,
  siteType: d.siteType,
  upstream: d.upstream,
  redirectTo: d.redirect?.to ?? null,
  redirectCode: d.redirect?.code ?? null,
  php: d.php,
  wildcard: d.wildcard,
  certificateId: d.certificateId,
  suspended: d.suspended,
  expiresAt: d.expiresAt === null ? null : new Date(d.expiresAt),
  pathQuotaMb: limitToDb(d.pathQuotaMb, 'pathQuotaMb'),
})

// ---------------------------------------------------------------- service user

export const serviceUserFromRow = (r: ServiceUserRow & { domainName: string }): ServiceUser => ({
  id: r.id,
  accountId: r.accountId,
  login: `${r.localPart}@${r.domainName}`,
  services: { email: r.email, ftp: r.ftp, webdisk: r.webdisk },
  mailboxQuotaMb: limitFromDb(r.mailboxQuotaMb),
  ftpDir: r.ftpDir,
})

/** The caller resolves the login's domain (core parseServiceLogin) to `domainId`. */
export const serviceUserToRow = (
  u: Omit<ServiceUser, 'id'> & { id?: Id },
  domainId: Id,
  passwordHash: string,
): ServiceUserInsert => ({
  ...(u.id ? { id: u.id } : {}),
  accountId: u.accountId,
  domainId,
  localPart: parseServiceLogin(u.login).local,
  passwordHash,
  email: u.services.email,
  ftp: u.services.ftp,
  webdisk: u.services.webdisk,
  mailboxQuotaMb: limitToDb(u.mailboxQuotaMb, 'mailboxQuotaMb'),
  ftpDir: u.ftpDir,
})

// ---------------------------------------------------------------- firewall

export const firewallRuleFromRow = (r: FirewallRuleRow): FirewallRule => ({
  id: r.id,
  kind: r.kind,
  action: r.action,
  protocol: r.protocol,
  port: r.port,
  source: r.source === null ? null : canonicalCidr(r.source),
  forwardTo: r.forwardTo,
  list: r.list,
  comment: r.comment,
  enabled: r.enabled,
})

export const firewallRuleToRow = (f: FirewallRule, sortOrder: number): FirewallRuleInsert => ({
  id: f.id,
  kind: f.kind,
  action: f.action,
  protocol: f.protocol,
  port: f.port,
  source: f.source,
  forwardTo: f.forwardTo,
  list: f.list,
  comment: f.comment,
  enabled: f.enabled,
  sortOrder,
})

// ---------------------------------------------------------------- server settings

export const serverSettingsFromRow = (r: ServerSettingsRow): ServerSettings => ({
  hostname: r.hostname,
  nameservers: r.nameservers,
  adminEmail: r.adminEmail,
  engine: r.engine,
  apacheMpm: r.apacheMpm,
  panelPort: r.panelPort,
  sshPort: r.sshPort,
  nginx: {
    workerProcesses: r.nginxWorkerProcesses === null ? 'auto' : r.nginxWorkerProcesses,
    workerConnections: r.nginxWorkerConnections,
    workerRlimitNofile: r.nginxWorkerRlimitNofile,
    multiAccept: r.nginxMultiAccept,
    keepaliveTimeoutSec: r.nginxKeepaliveTimeoutSec,
  },
  apache: {
    startServers: r.apacheStartServers,
    minSpareServers: r.apacheMinSpareServers,
    maxSpareServers: r.apacheMaxSpareServers,
    maxRequestWorkers: r.apacheMaxRequestWorkers,
    maxConnectionsPerChild: r.apacheMaxConnectionsPerChild,
    serverLimit: r.apacheServerLimit,
  },
  backendPort: r.backendPort,
  backendTlsPort: r.backendTlsPort,
})

export const serverSettingsToRow = (s: ServerSettings): ServerSettingsInsert => {
  const wp = s.nginx.workerProcesses
  if (wp !== 'auto' && (typeof wp !== 'number' || !Number.isSafeInteger(wp) || wp < 1)) {
    return fail('VALIDATION', "nginx.workerProcesses must be a positive integer or 'auto'", { value: String(wp) })
  }
  return {
    id: 1,
    hostname: s.hostname,
    nameservers: s.nameservers,
    adminEmail: s.adminEmail,
    engine: s.engine,
    apacheMpm: s.apacheMpm,
    panelPort: s.panelPort,
    sshPort: s.sshPort,
    nginxWorkerProcesses: wp === 'auto' ? null : wp,
    nginxWorkerConnections: s.nginx.workerConnections,
    nginxWorkerRlimitNofile: s.nginx.workerRlimitNofile,
    nginxMultiAccept: s.nginx.multiAccept,
    nginxKeepaliveTimeoutSec: s.nginx.keepaliveTimeoutSec,
    apacheStartServers: s.apache.startServers,
    apacheMinSpareServers: s.apache.minSpareServers,
    apacheMaxSpareServers: s.apache.maxSpareServers,
    apacheMaxRequestWorkers: s.apache.maxRequestWorkers,
    apacheMaxConnectionsPerChild: s.apache.maxConnectionsPerChild,
    apacheServerLimit: s.apache.serverLimit,
    backendPort: s.backendPort,
    backendTlsPort: s.backendTlsPort,
  }
}

// ---------------------------------------------------------------- audit

export const auditFromRow = (r: AuditRow): AuditEntry => ({
  id: String(r.id),
  at: iso(r.at),
  actor: r.actor,
  action: r.action,
  target: r.target,
  detail: r.detail as Record<string, unknown>,
  outcome: r.outcome,
})

/** The database assigns id and time: an append-only trail does not take timestamps from callers. */
export const auditToRow = (e: Omit<AuditEntry, 'id' | 'at'>): typeof auditLog.$inferInsert => ({
  actor: e.actor,
  action: e.action,
  target: e.target,
  detail: e.detail,
  outcome: e.outcome,
})
