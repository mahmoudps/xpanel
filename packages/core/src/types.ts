// Domain model shared by api, agent, render, lifecycle and web.
// Desired state lives in Postgres; these types are its pure, framework-free shape.

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
  engine: 'mariadb'
  /** always prefixed `<username>_` */
  name: string
  /** set when moved to the MariaDB trash, dropped after retention */
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
