import type {
  Account,
  AccountStatus,
  Certificate,
  Database,
  DatabaseUser,
  OwnerDatabaseStateRequest,
  DnsRecord,
  Domain,
  DomainCustomConfig,
  DomainWorkspaceSource,
  DomainWorkspaceTransition,
  FeatureList,
  FirewallRule,
  Id,
  IpAssignmentRequest,
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
import type { StoredPostgresqlUser } from './pg-state.ts'

export interface StoredServerSettings {
  settings: ServerSettings
  setupCompletedAt: string | null
  updatedAt: string
}

/** Trusted settings authorization runs inside the existing authority writer lease. */
export interface ServerSettingsMutationOptions extends MutationOptions {
  settingsGuard?: (current: ServerSettings | null) => Promise<void>
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

/** An applied firewall change that auto-reverts unless the saving session confirms it in time. */
export interface FirewallPendingChange {
  id: string
  /** ISO 8601 UTC; after it the last confirmed rules are restored */
  deadline: string
  actor: string
  sessionIp: string
  /** firewallRevision of the rules this change wrote; a newer write supersedes the revert */
  appliedRevision: string
  /** the last confirmed rules, restored on revert */
  previous: FirewallState
}

export interface FirewallMutationOptions extends MutationOptions {
  /** firewallRevision the caller reviewed; the write is refused when the rules changed since */
  expectedFirewallRevision?: string
  /** records the change as pending until confirmFirewallChange */
  confirmation?: Omit<FirewallPendingChange, 'appliedRevision' | 'previous'>
}

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
  /** Atomic commit identity, including writes that do not increment business revision. */
  committedLeaseId?: string
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

/** Trusted generation checks; invoked under the writer lease before restore publication. */
export interface RestoreGenerationMutationOptions extends MutationOptions {
  restoreGuard?: (current: StateSnapshot, target: StateSnapshot) => Promise<void>
}

/** Trusted DNS precondition/authorization, evaluated under the existing writer lease. */
export interface DnsZoneMutationOptions extends MutationOptions {
  dnsGuard?: (current: DnsZoneState | null) => Promise<void>
}

/** Server-owned checks run under the same lease that publishes the new configuration. */
export interface CronMutationOptions extends MutationOptions {
  cronGuard?: (account: Account, current: readonly CronJobState[]) => Promise<void>
}

export interface CertificateMutationOptions extends MutationOptions {
  certificateGuard?: (current: StoredCertificate | null, domains: readonly Domain[]) => Promise<void>
}

/** Trusted server callbacks; never populated from an HTTP request body. */
export interface DatabaseMutationOptions extends MutationOptions {
  stateGuard?: OwnerDatabaseStateRequest
  authorize?: (account: Account) => Promise<void>
  onMutationStarted?: () => void
  onCommitted?: (authorityRevision: number) => void
  prepareIndex?: (account: Account, database: Database) => Promise<{
    apply: () => Promise<void>
    rollback: () => Promise<void>
  }>
  prepareTransitionIndex?: (account: Account, before: Database, after: Database) => Promise<{
    apply: () => Promise<void>
    rollback: () => Promise<void>
  }>
}

/** Trusted server ports, never deserialized from an HTTP domain body. */
export interface DomainMutationGuard {
  accountId: Id
  expectedRevision: string
  authorize: (account: Account, current: Domain | null) => Promise<void>
  safeLeaf?: boolean
  prepareProjection?: (transition: DomainWorkspaceTransition) => Promise<{
    apply: () => Promise<void>
    rollback: () => Promise<void>
  }>
  onCommitted?: (authorityRevision: number) => void
}

export interface DomainMutationOptions extends MutationOptions {
  domainGuard?: DomainMutationGuard
}

export interface DomainWorkspaceRead {
  source: DomainWorkspaceSource
  revision: string
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
  ipv4?: string
  /** Explicit desired-state allocation; omission selects the persisted shared IPv4 default. */
  ipAssignment?: IpAssignmentRequest
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
  enforceBandwidth?: boolean
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
    | 'indexFiles'
    | 'proxy'
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
  initialGrant?: { databaseId: Id; privileges: string[] }
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
  maxRuntimeSec?: number
}

/**
 * Saved account mail routing under `extended/`: forwarders, domain forwarders, default
 * addresses, filter rules and autoresponders. Records stay as saved; the mail renderer
 * checks each one and reports the ones it cannot apply.
 */
export interface MailRoutingState {
  forwarders: unknown[]
  domainForwarders: unknown[]
  defaultAddresses: unknown[]
  filters: unknown[]
  vacations: unknown[]
  /** autoresponders of addresses without a mailbox; present only when one is saved */
  autoresponders?: unknown[]
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
  /** present only when at least one routing record is saved */
  mailRouting?: MailRoutingState
  /** present only when the server holds PostgreSQL users; each database's owner is one of them */
  postgresqlDatabases?: Database[]
  postgresqlUsers?: StoredPostgresqlUser[]
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
