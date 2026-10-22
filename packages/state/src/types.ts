import type {
  Account,
  AccountStatus,
  Certificate,
  Database,
  DatabaseUser,
  DnsRecord,
  Domain,
  DomainCustomConfig,
  FeatureList,
  FirewallRule,
  Id,
  Limit,
  LockoutContext,
  MailIpConfig,
  PhpSettings,
  Plan,
  PlanCaps,
  Reseller,
  ResourceLimits,
  ServerIpEntry,
  ServerSettings,
  ServiceUser,
  ShellAccess,
} from '@xpanel/core'

export interface StoredServerSettings {
  settings: ServerSettings
  setupCompletedAt: string | null
  updatedAt: string
}

export interface PrefixList {
  name: string
  /** canonical CIDRs */
  entries: string[]
}

export interface FirewallState {
  rules: FirewallRule[]
  prefixLists: PrefixList[]
}

export interface FirewallGuard {
  lockout: Omit<LockoutContext, 'prefixLists'> | null
}

export type NewFirewallRule = Omit<FirewallRule, 'id'> & { id?: string }

export interface UidAllocation {
  uid: number
  username: string
  allocatedAt: string
}

export interface UidAllocatorState {
  nextUid: number
  allocated: UidAllocation[]
}

export type ReferenceKind = 'JOB' | 'BKP' | 'MIG' | 'GEN' | 'UPG' | (string & {})

export interface AllocatedReferenceRecord {
  ref: string
  kind: string
  sequence: number
  entityId: string | null
  allocatedAt: string
}

export interface StateAuthorityMetadata {
  revision: number
  fencingToken: number
  updatedAt: string
  references: Record<string, number>
  allocatedReferences?: Record<string, AllocatedReferenceRecord>
}

export interface WriterLockHolder {
  pid: number
  fencingToken: number
  acquiredAt: string
  leaseId: string
}

export interface MutationOptions {
  expectedRevision?: number
  fencingToken?: number
}

export interface StoredAccount extends Account {
  suspendedAt: string | null
}

export interface NewAccount extends MutationOptions {
  username: string
  /** argon2id PHC hash for the owner's panel login */
  passwordHash: string
  forcePasswordChange?: boolean
  primaryDomain: string
  planId: Id
  /** reseller id, or null for root-owned */
  ownerId: Id | null
  contactEmail: string
  ipv4: string
  ipv6?: string | null
  extraIps?: string[]
  shell: ShellAccess
  /** parent of the home directory, default /home */
  homeBase?: string
  /** PHP settings of the primary domain, checked against the plan's worker and memory caps */
  php: PhpSettings
}

export interface AccountFilter {
  /** undefined = all, null = root-owned, id = that reseller's accounts */
  ownerId?: Id | null
  status?: AccountStatus
  planId?: Id
}

export type NewPlan = Omit<Plan, 'id'>

export interface PlanPatch {
  name?: string
  featureListId?: Id
  resources?: Partial<ResourceLimits>
  caps?: Partial<PlanCaps>
  dedicatedIp?: boolean
  shell?: ShellAccess
  defaultMailboxQuotaMb?: Plan['defaultMailboxQuotaMb']
}

export type NewReseller = Omit<Reseller, 'id'> & { id?: Id; passwordHash: string; forcePasswordChange?: boolean }
export type ResellerPatch = Partial<Omit<Reseller, 'id' | 'username'>>

export interface ResellerUsage {
  accounts: number
  diskMb: Limit
  bandwidthMb: Limit
}

export type NewDomain = Omit<Domain, 'id'>
export type DomainPatch = Partial<
  Pick<
    Domain,
    | 'docRoot'
    | 'siteType'
    | 'upstream'
    | 'redirect'
    | 'php'
    | 'wildcard'
    | 'certificateId'
    | 'suspended'
    | 'expiresAt'
    | 'pathQuotaMb'
    | 'ipv4'
    | 'ipv6'
  >
>

export interface StoredServiceUser extends ServiceUser {
  domainId: Id
  localPart: string
  passwordHash: string
}

export type NewServiceUser = Omit<ServiceUser, 'id'> & {
  /** scheme-tagged hash for dovecot/FTP, e.g. {ARGON2ID}$argon2id$... */
  passwordHash: string
}

export interface ServiceUserPatch {
  services?: ServiceUser['services']
  mailboxQuotaMb?: Limit
  ftpDir?: string
  passwordHash?: string
}

export interface StoredDatabaseUser extends DatabaseUser {
  authPlugin: 'mysql_native_password' | 'ed25519'
  authString: string
}

export interface NewDatabaseUser {
  accountId: Id
  name: string
  /** MariaDB authentication string (hash) */
  authString: string
  authPlugin?: 'mysql_native_password' | 'ed25519'
}

export interface StoredCertificate extends Certificate {
  notBefore: string | null
  certPath: string
  keyPath: string
  chainPath: string | null
  fingerprintSha256: string | null
  lastError: string | null
  renewedAt: string | null
}

export interface NewCertificate {
  id?: Id
  accountId: Id | null
  names: string[]
  source: 'acme' | 'upload' | 'self-signed'
  challenge?: 'http-01' | 'dns-01' | null
  notBefore?: string | null
  notAfter: string
  autoRenew?: boolean
  certPath: string
  keyPath: string
  chainPath?: string | null
  fingerprintSha256?: string | null
}

export interface DnsZoneState {
  id: Id
  accountId: Id | null
  name: string
  serial: number
  records: DnsRecord[]
}

export interface CronJobState {
  id: Id
  accountId: Id
  schedule: string
  command: string
  comment: string
  enabled: boolean
}

/** Complete, validated desired-state tree read from `/var/lib/xpanel/state/`. */
export interface StateSnapshot {
  checksum: string
  revision?: number
  server: StoredServerSettings | null
  firewall: FirewallState
  uidAllocator: UidAllocatorState
  featureLists: FeatureList[]
  plans: Plan[]
  resellers: Reseller[]
  accounts: StoredAccount[]
  domains: Domain[]
  serviceUsers: StoredServiceUser[]
  databases: Database[]
  databaseUsers: StoredDatabaseUser[]
  certificates: StoredCertificate[]
  zones: DnsZoneState[]
  cronJobs: CronJobState[]
  domainCustomConfigs?: DomainCustomConfig[]
  ipPool?: ServerIpEntry[]
  mailIpConfig?: MailIpConfig | null
}

/**
 * Optional hooks so `packages/db` (or `apps/api`) can keep principals and the
 * search index in sync with state-file mutations in a single coordinated step.
 */
export interface StateStoreHooks {
  onCreateUserPrincipal?: (p: {
    accountId: Id
    username: string
    passwordHash: string
    forcePasswordChange: boolean
  }) => void | Promise<void>
  onDeleteAccount?: (accountId: Id) => void | Promise<void>
  onCreateResellerPrincipal?: (p: {
    id: Id
    username: string
    passwordHash: string
    forcePasswordChange: boolean
  }) => void | Promise<void>
  onDeleteReseller?: (resellerId: Id) => void | Promise<void>
  /**
   * Optional set, array, or predicate of existing Linux host UIDs (e.g. from /etc/passwd)
   * so `allocateUidUnlocked` permanently burns/skips any colliding host UID and never reuses it.
   */
  existingHostUids?:
    | ReadonlySet<number>
    | readonly number[]
    | (() => ReadonlySet<number> | readonly number[] | Promise<ReadonlySet<number> | readonly number[]>)
    | ((uid: number, username: string) => boolean | Promise<boolean>)
  /**
   * Optional lifecycle hook invoked after UID burn and domain file write, before final account commit.
   */
  onBeforeAccountCommit?: (p: {
    accountId: Id
    username: string
    uid: number
    fencingToken: number
  }) => void | Promise<void>
}
