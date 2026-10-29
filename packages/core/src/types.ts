import type { DatabaseRemoteAccessEntry } from './database-remote-access.ts'

// Domain model shared by api, agent, render, state, db, lifecycle and web.
// Desired state lives in files under /var/lib/xpanel/state/; these types are its pure, framework-free shape.

/** A capped quantity. `'unlimited'` is always explicit, never a magic number. */
export type Limit = number | 'unlimited'

export type Id = string

export type Engine = 'apache' | 'openlitespeed'
export type PhpHandler = 'fpm' | 'cgi' | 'suphp' | 'lsphp'
export type FpmMode = 'ondemand' | 'dynamic' | 'static'
export type SiteType = 'php' | 'static' | 'proxy' | 'node' | 'python'
export type DomainKind = 'primary' | 'addon' | 'alias' | 'subdomain'
export type AccountStatus = 'active' | 'suspended' | 'terminating'
export type ShellAccess = 'none' | 'jailed'
export type ApacheMpm = 'itk' | 'prefork'

/** Who is acting. Service users (mail/FTP/WebDisk) never get a panel principal. */
export type Principal =
  | { kind: 'root'; id: Id; username: string }
  | { kind: 'reseller'; id: Id; username: string }
  | { kind: 'user'; id: Id; username: string; accountId: Id }

/** xPanel team roles (catalog spec manage-team). */
export type TeamRole = 'administrator' | 'database' | 'email' | 'web'
/**
 * A signed-in account team member. It is never a Principal: a team session acts as its owning account's
 * user principal, narrowed on every request to these roles, so it cannot reach root, reseller or other accounts.
 */
export interface TeamPrincipal {
  kind: 'team'
  /** Member id in the account team file. */
  id: Id
  username: string
  /** Sign-in name, member@primary-domain. */
  login: string
  accountId: Id
  roles: readonly TeamRole[]
}

/** Per-account resource caps. Applied to `xpanel-<uid>.slice` through cgroup v2. */
export interface ResourceLimits {
  diskMb: Limit
  bandwidthMbMonth: Limit
  /** bytes per second */
  ioReadBps: Limit
  ioWriteBps: Limit
  ioReadIops: Limit
  ioWriteIops: Limit
  memoryMb: Limit
  /** cgroup pids.max */
  maxProcesses: Limit
  /** CPUQuota percent of one core (100 = one core) */
  cpuPercent: Limit
}

export type AccountLimitGap = 'memory' | 'pids' | 'io' | 'cpu' | 'disk'

/** A read-only comparison of assigned plans with observed host caps, not workload qualification. */
export interface HostLimitObservation {
  status: 'verified' | 'gaps' | 'unavailable'
  checkedAccounts: number
  unavailableAccounts: number
  gaps: AccountLimitGap[]
}

export interface PlanCaps {
  addonDomains: Limit
  aliasDomains: Limit
  subdomains: Limit
  mailboxes: Limit
  forwarders: Limit
  mailingLists: Limit
  ftpAccounts: Limit
  databases: Limit
  /** max PHP workers (pm.max_children) any single domain may request */
  phpWorkers: Limit
}

export type PlanCapKey = keyof PlanCaps

export interface Plan {
  id: Id
  name: string
  /** reseller id, or null for root-owned plans */
  ownerId: Id | null
  featureListId: Id
  resources: ResourceLimits
  caps: PlanCaps
  dedicatedIp: boolean
  shell: ShellAccess
  defaultMailboxQuotaMb: Limit
}

/** Feature list: the set of xPanel tool feature keys an account may see. */
export interface FeatureList {
  id: Id
  name: string
  ownerId: Id | null
  /** feature keys from the catalog that are disabled */
  disabled: string[]
}

export interface Account {
  id: Id
  username: string
  uid: number
  gid: number
  home: string
  primaryDomain: string
  planId: Id
  /** reseller id, or null when owned by root */
  ownerId: Id | null
  status: AccountStatus
  suspendReason: string | null
  contactEmail: string
  ipv4: string
  /** Optional primary IPv6 address assigned to this account */
  ipv6?: string | null
  /** Additional dedicated/delegated IPv4 or IPv6 addresses assigned to this account */
  extraIps?: string[]
  /** Canonical account database host allowlist; localhost remains implicit. */
  databaseRemoteAccess?: DatabaseRemoteAccessEntry[]
  shell: ShellAccess
  createdAt: string
}

export type ResellerAcl =
  | 'create-account'
  | 'edit-account'
  | 'suspend-account'
  | 'terminate-account'
  | 'change-plan'
  | 'manage-plans'
  | 'manage-feature-lists'
  | 'manage-dns'
  | 'manage-ssl'
  | 'change-password'
  | 'list-accounts'
  | 'allow-unlimited-plans'
  | 'allow-oversell'
  | 'transfer'

export interface Reseller {
  id: Id
  username: string
  acl: ResellerAcl[]
  maxAccounts: Limit
  totalDiskMb: Limit
  totalBandwidthMb: Limit
  /** when false, sum of assigned plan limits may not exceed totals */
  oversell: boolean
  nameservers: string[]
  delegatedIps: string[]
}

export interface PhpSettings {
  version: string
  handler: PhpHandler
  fpm: {
    mode: FpmMode
    maxChildren: number
    startServers: number
    minSpareServers: number
    maxSpareServers: number
    maxRequests: number
    processIdleTimeoutSec: number
  }
  /** values written to .user.ini or the pool (php_value/php_flag never via .htaccess) */
  ini: Record<string, string>
}

export interface Domain {
  id: Id
  accountId: Id
  name: string
  kind: DomainKind
  /** parent domain for subdomains/aliases */
  parentId: Id | null
  docRoot: string
  siteType: SiteType
  /** for proxy/node/python sites: upstream like http://127.0.0.1:3000 */
  upstream: string | null
  redirect: { to: string; code: 301 | 302 } | null
  php: PhpSettings
  /** serves `*.name` (DNS `*` record + ServerAlias); explicit subdomains win */
  wildcard: boolean
  certificateId: Id | null
  suspended: boolean
  expiresAt: string | null
  /** per-path quota inside the account quota, MB */
  pathQuotaMb: Limit
  /** Ordered directory index basenames; omission preserves the legacy engine defaults. */
  indexFiles?: string[]
  /** Optional domain-specific IPv4 override (defaults to account.ipv4 when null/omitted) */
  ipv4?: string | null
  /** Optional domain-specific IPv6 override (defaults to account.ipv6 when null/omitted) */
  ipv6?: string | null
}

export interface ServiceUser {
  id: Id
  accountId: Id
  /** user@domain */
  login: string
  services: { email: boolean; ftp: boolean; webdisk: boolean }
  mailboxQuotaMb: Limit
  /** relative to account home */
  ftpDir: string
}

export interface Database {
  id: Id
  accountId: Id
  engine: 'mariadb' | 'postgresql'
  /** always prefixed `<username>_` */
  name: string
  /** PostgreSQL only: the owning `<username>_<suffix>` login role, fixed at creation */
  owner?: string
  /** set when moved to the trash, dropped after retention */
  trashedAt: string | null
}

export interface DatabaseUser {
  id: Id
  accountId: Id
  name: string
  grants: { databaseId: Id; privileges: string[] }[]
}

export type DnsRecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS' | 'SRV' | 'CAA'

export interface DnsRecord {
  id: Id
  zone: string
  /** relative name, '@' for apex, '*' for wildcard */
  name: string
  type: DnsRecordType
  ttl: number
  content: string
  priority: number | null
}

export interface Certificate {
  id: Id
  accountId: Id | null
  /** e.g. ['example.com', '*.example.com'] */
  names: string[]
  source: 'acme' | 'upload' | 'self-signed'
  challenge: 'http-01' | 'dns-01' | null
  notAfter: string
  autoRenew: boolean
}

export type FirewallAction = 'accept' | 'drop' | 'reject'

export interface FirewallRule {
  id: Id
  kind: 'port' | 'ip' | 'forward' | 'icmp' | 'prefix-list'
  action: FirewallAction
  protocol: 'tcp' | 'udp' | 'both' | null
  /** single port or range "8000-8100" */
  port: string | null
  /** CIDR or address */
  source: string | null
  /** for forward: destination host:port */
  forwardTo: string | null
  /** for prefix-list: list name */
  list: string | null
  comment: string
  enabled: boolean
}

export interface DefaultSitePolicy {
  response: 'reject' | 'redirect'
  redirectTo: string | null
  refuseHttps: boolean
}

export interface ServerSettings {
  hostname: string
  nameservers: string[]
  adminEmail: string
  engine: Engine
  apacheMpm: ApacheMpm
  panelPort: number
  sshPort: number
  nginx: {
    workerProcesses: number | 'auto'
    workerConnections: number
    workerRlimitNofile: number
    multiAccept: boolean
    keepaliveTimeoutSec: number
  }
  apache: {
    startServers: number
    minSpareServers: number
    maxSpareServers: number
    maxRequestWorkers: number
    maxConnectionsPerChild: number
    serverLimit: number
  }
  /** loopback port Apache/OLS listens on behind Nginx; closed in the firewall */
  backendPort: number
  backendTlsPort: number
  /** Explicit policy for unbound HTTP names; absent preserves the original 404 catch-all. */
  defaultSite?: DefaultSitePolicy
}

export interface AuditEntry {
  id: Id
  at: string
  actor: string
  action: string
  target: string
  detail: Record<string, unknown>
  outcome: 'ok' | 'denied' | 'failed'
}

/**
 * Dynamic per-domain custom configuration (cPanel `userdata` / vhost drop-in model).
 * Stored in desired-state files and rendered into `/etc/xpanel/userdata/<user>/<domain>/`
 * plus `<docRoot>/.user.ini`, tested with `nginx -t` and `apachectl configtest` before reload.
 */
export interface DomainCustomConfig {
  domainId: Id
  accountId: Id
  domainName: string
  /** Custom Nginx directives included inside the site's server {} block */
  nginxInclude: string
  /** Custom Apache directives included inside the site's <VirtualHost> block */
  apacheInclude: string
  /** Per-directory PHP INI directives written to <docRoot>/.user.ini */
  userIni: Record<string, string>
  /** Structured custom HTTP response headers (name -> value) */
  customHeaders: Record<string, string>
  /** URI prefixes that bypass the Nginx proxy cache (e.g. ['/cart', '/checkout']) */
  cacheBypassPaths: string[]
  updatedAt: string
  updatedBy: 'root' | 'reseller' | 'user'
}

/**
 * Dynamic per-account custom configuration (`accounts/<user>/userdata.json`).
 */
export interface AccountCustomConfig {
  accountId: Id
  username: string
  /** Global PHP INI overrides applied across all pools/wrappers of this account */
  phpIniOverrides: Record<string, string>
  /** Default environment variables injected into account units and shells */
  environmentVars: Record<string, string>
  updatedAt: string
}

export type IpRole = 'shared' | 'dedicated' | 'mail'
export type IpOwnerKind = 'root' | 'reseller' | 'account'

/**
 * Multi-IPv4 / Multi-IPv6 address entry in the server IP pool.
 * Supports root-owned shared/dedicated IPs, reseller-delegated IPs, account-dedicated IPs,
 * and dedicated outbound mail server IPs.
 */
export interface ServerIpEntry {
  id: Id
  /** Canonical IPv4 or IPv6 address */
  address: string
  version: 4 | 6
  /** Subnet prefix length (1..32 for IPv4, 1..128 for IPv6) */
  prefixLength: number
  /** Network interface name, e.g. eth0, ens3 */
  interfaceName: string
  role: IpRole
  ownerKind: IpOwnerKind
  /** null for root, reseller.id for reseller, account.id for account */
  ownerId: Id | null
  /** Reverse DNS (PTR) hostname used for HELO and rDNS checks */
  ptrHostname: string | null
  isPrimary: boolean
  notes: string
}

export type MailOutboundMode = 'server-default' | 'account-ip' | 'domain-ip' | 'custom-map'

export interface DomainMailIpOverride {
  domainName: string
  ipv4: string | null
  ipv6: string | null
  heloHostname: string | null
}

/**
 * Outbound mail IP & HELO configuration for Postfix (`sender_dependent_default_transport_maps`).
 * Allows routing outbound mail through the server default IP, each account's own IP, each
 * domain's own IP, or an explicit per-domain custom IPv4/IPv6 + HELO map.
 */
export interface MailIpConfig {
  mode: MailOutboundMode
  defaultIpv4: string | null
  defaultIpv6: string | null
  defaultHelo: string | null
  domainOverrides: DomainMailIpOverride[]
}

export interface IoAnalyticsPoint {
  at: string
  readBytesPerSec: number
  writeBytesPerSec: number
  readIops: number
  writeIops: number
  awaitMs: number
  psiSomeAvg10: number
  psiFullAvg10: number
  cpuPercent: number
  memoryUsedBytes: number
  memoryTotalBytes: number
  loadAvg1m: number
}

export interface AccountIoRank {
  accountId: Id
  username: string
  uid: number
  readBytesPerSec: number
  writeBytesPerSec: number
  readIops: number
  writeIops: number
  memoryCurrentBytes: number
  memoryLimitMb: Limit
  pidsCurrent: number
  pidsLimit: Limit
  cpuPercent: number
  statusLevel: 'ok' | 'warn' | 'critical'
}

export interface IoAnalyticsSnapshot {
  at: string
  current: IoAnalyticsPoint
  history: IoAnalyticsPoint[]
  accounts: AccountIoRank[]
}

export interface WebsiteTrafficBucket {
  at: string
  requests: number
  bytes: number
  status2xx: number
  status3xx: number
  status4xx: number
  status5xx: number
  cacheHit: number
  cacheMiss: number
  cacheBypass: number
  avgRequestTimeMs: number
  p95RequestTimeMs: number
  avgUpstreamTimeMs: number
}

export interface WebsiteTopEntry {
  key: string
  requests: number
  bytes: number
  errors5xx?: number
}

export interface WebsiteAnalyticsSnapshot {
  domain: string
  accountId: Id | null
  at: string
  totals: {
    requests: number
    bytes: number
    uniqueVisitors: number
    cacheHitRatioPercent: number
    errorRatePercent: number
    avgRequestTimeMs: number
    p95RequestTimeMs: number
    avgUpstreamTimeMs: number
    status2xx: number
    status3xx: number
    status4xx: number
    status5xx: number
  }
  series: WebsiteTrafficBucket[]
  topPaths: WebsiteTopEntry[]
  topReferrers: WebsiteTopEntry[]
  topClientIps: WebsiteTopEntry[]
}

export type ReconcileStage = 'render' | 'test' | 'switch' | 'reload' | 'verify'

export interface LiveEventScope {
  /** null = server-wide (root only); otherwise visible to root, owning reseller, and the account owner */
  accountId?: Id | null
  resellerId?: Id | null
  /** for xMail mailbox events */
  mailboxLogin?: string | null
}

export type LiveEvent =
  | {
      id: string
      at: string
      kind: 'reconcile.stage'
      scope: LiveEventScope
      data: {
        generationId: number
        stage: ReconcileStage
        status: 'running' | 'passed' | 'failed'
        detail?: string
      }
    }
  | {
      id: string
      at: string
      kind: 'reconcile.applied'
      scope: LiveEventScope
      data: {
        generationId: number
        stateChecksum: string
        filesCount: number
        durationMs: number
      }
    }
  | {
      id: string
      at: string
      kind: 'reconcile.failed'
      scope: LiveEventScope
      data: {
        generationId: number
        failedTest: string
        error: string
      }
    }
  | {
      id: string
      at: string
      kind: 'metrics.tick'
      scope: LiveEventScope
      data: {
        uid: number | null
        cpuUsageUsec: number
        memoryCurrentBytes: number
        ioReadBytes: number
        ioWriteBytes: number
        pidsCurrent: number
        loadAvg1m?: number
      }
    }
  | {
      id: string
      at: string
      kind: 'service.health'
      scope: LiveEventScope
      data: {
        services: { name: string; active: boolean; enabled: boolean }[]
      }
    }
  | {
      id: string
      at: string
      kind: 'job.updated'
      scope: LiveEventScope
      data: {
        jobId: Id
        kind: string
        status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
        progress: number
        logChunk?: string
        error?: string | null
      }
    }
  | {
      id: string
      at: string
      kind: 'mail.received'
      scope: LiveEventScope
      data: {
        mailbox: string
        folder: string
        uid: number
        from: string
        subject: string
        sizeBytes: number
        unreadCount: number
      }
    }
  | {
      id: string
      at: string
      kind: 'mail.changed'
      scope: LiveEventScope
      data: { folder: 'INBOX' }
    }
  | {
      id: string
      at: string
      kind: 'mail.flags'
      scope: LiveEventScope
      data: { mailbox: string; folder: 'INBOX'; uid: number; flags: string[] }
    }
  | {
      id: string
      at: string
      kind: 'security.ban'
      scope: LiveEventScope
      data: {
        ip: string
        reason: string
        expiresAt: string
      }
    }
  | {
      id: string
      at: string
      kind: 'io.analytics'
      scope: LiveEventScope
      data: IoAnalyticsSnapshot
    }
  | {
      id: string
      at: string
      kind: 'website.analytics'
      scope: LiveEventScope
      data: WebsiteAnalyticsSnapshot
    }
  | {
      id: string
      at: string
      kind: 'terminal.output'
      scope: LiveEventScope
      data: {
        sessionId: string
        username: string
        stream: 'stdout' | 'stderr' | 'exit'
        chunk: string
        exitCode?: number
      }
    }
  | {
      id: string
      at: string
      kind: 'audit.entry'
      scope: LiveEventScope
      data: AuditEntry
    }

export type LiveEventKind = LiveEvent['kind']
