import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { resolveServingDomain } from '@xpanel/core'
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import {
  assertAliasTarget,
  assertArgon2Hash,
  assertBool,
  assertCapAvailable,
  assertDbNameOwned,
  assertDbPrivileges,
  parseOwnerDatabaseStateRequest,
  databaseRemoteAccessRevision,
  parseDatabaseRemoteEntries,
  assertDomainUnique,
  assertEmail,
  accountContactRevision,
  assertAccountContactRevision,
  assertAccountDomainGraph,
  assertDomainWorkspaceRevision,
  domainWorkspaceRevision,
  assertId,
  assertIdOrNull,
  assertInt,
  assertIpv4,
  assertIpv6,
  assertIpAssignableToDomain,
  assertLine,
  assertName,
  assertNoSelfLockout,
  assertPhpSettings,
  assertRelPath,
  assertResellerAcl,
  assertResellerCapacity,
  assertServiceHash,
  assertSha256Hex,
  canRenamePrimary,
  dbUserName,
  defaultDocRoot,
  fail,
  isUuid,
  isXpanelError,
  MAX_ACCOUNT_UID,
  oneOf,
  parseServiceLogin,
  sumLimits,
  validateDomainName,
  validateFirewallRule,
  validateFirewallRules,
  validateHome,
  validateIpList,
  validateMailIpConfig,
  validatePrefixList,
  validateServerIpEntry,
  validateServerSettings,
  validateUsername,
  canonicalIp,
  resolveAccountIpAssignment,
  validateServerIpPool,
  projectAccountIpAvailability,
} from '@xpanel/core'
import type {
  Account,
  AccountStatus,
  Database,
  DatabaseUser,
  DatabaseRemoteAccessEntry,
  DatabaseRemoteAccessSnapshot,
  DatabaseRemoteAccessTransaction,
  Domain,
  DomainCustomConfig,
  DomainKind,
  DomainWorkspaceSource,
  DomainWorkspaceTransition,
  FeatureList,
  FirewallRule,
  Id,
  Limit,
  MailIpConfig,
  Plan,
  PlanCapKey,
  Reseller,
  ServerIpEntry,
  ServerSettings,
  ServiceUser,
  ShellAccess,
} from '@xpanel/core'
import { AsyncMutex, atomicRemove, atomicWriteJson, isStateDirectoryDurabilityError, listJsonFiles, listSubdirs, readJsonIfExists } from './atomic.ts'
import type {
  AccountFilter,
  CronJobState,
  DnsZoneState,
  DnsZoneMutationOptions,
  CronMutationOptions,
  CertificateMutationOptions,
  DomainPatch,
  DomainMutationOptions,
  DomainWorkspaceRead,
  DatabaseMutationOptions,
  FirewallGuard,
  FirewallMutationOptions,
  FirewallPendingChange,
  FirewallState,
  MailRoutingState,
  MutationOptions,
  ServerSettingsMutationOptions,
  RestoreGenerationMutationOptions,
  NewAccount,
  NewCertificate,
  NewDatabaseUser,
  NewDomain,
  NewFirewallRule,
  NewPlan,
  NewReseller,
  NewServiceUser,
  PlanPatch,
  PrefixList,
  ReferenceKind,
  ResellerPatch,
  ResellerUsage,
  ServiceUserPatch,
  StateAuthorityMetadata,
  StateSnapshot,
  StateStoreHooks,
  StoredAccount,
  StoredCertificate,
  StoredDatabaseUser,
  StoredServerSettings,
  StoredServiceUser,
  UidAllocatorState,
} from './types.ts'
import {
  assertDbAuth,
  assertDelegatedIps,
  assertFeatureKeys,
  assertResellerNameservers,
  checksumStateTree,
  validateAccountFile,
  validateCertificateFile,
  validateCronJob,
  validateDatabaseFile,
  validateDatabaseUserFile,
  validateDnsZoneFile,
  validateDomainCustomConfigFile,
  validateDomainFile,
  validateFeatureListFile,
  validateFirewallState,
  validatePlanFile,
  validateIpPoolFile,
  validatePrefixLists,
  validateResellerFile,
  validateServiceUserFile,
  validateStoredServer,
  validateUidAllocator,
} from './validate-state.ts'
import { WriterLock, type WriterLease, type WriterLockOptions } from './writer-lock.ts'
import { toPublicPostgresqlUser, validatePostgresqlDatabaseFile, validatePostgresqlUserFile, type PostgresqlUser, type StoredPostgresqlUser } from './pg-state.ts'

export * from './writer-lock.ts'

const SHELLS: readonly ShellAccess[] = ['none', 'jailed']
const STATUSES: readonly AccountStatus[] = ['active', 'suspended', 'terminating']
const KINDS: readonly DomainKind[] = ['primary', 'addon', 'alias', 'subdomain']
const CAP_OF: Record<Exclude<DomainKind, 'primary'>, PlanCapKey> = {
  addon: 'addonDomains',
  alias: 'aliasDomains',
  subdomain: 'subdomains',
}
const RULE_ID_MAX = 64

interface MutationJournal {
  recorded: boolean
  restored: boolean
  rollbackProjection?: () => Promise<void>
}

const mustExist = <T>(row: T | null | undefined, what: string, id: unknown): T =>
  row ?? fail('NOT_FOUND', `${what} not found`, { what, id: String(id).slice(0, 128) })

const toPublicAccount = (a: StoredAccount): Account => ({
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
  contactEmail: a.contactEmail,
  ipv4: a.ipv4,
  ...(a.ipv6 !== undefined && { ipv6: a.ipv6 }),
  ...(a.extraIps !== undefined && { extraIps: [...a.extraIps] }),
  ...(a.databaseRemoteAccess !== undefined && { databaseRemoteAccess: a.databaseRemoteAccess.map(entry => ({ ...entry })) }),
  shell: a.shell,
  createdAt: a.createdAt,
  ...(a.bandwidthLimitedMonth !== undefined && { bandwidthLimitedMonth: a.bandwidthLimitedMonth }),
})

const pinnedAccountPreimage = async (path: string): Promise<{ bytes: Buffer; identity: string }> => {
  const before = await lstat(path, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 1024n * 1024n) fail('PRECONDITION_FAILED', 'account source is not a bounded regular file', { stateChanged: false })
  const identity = (value: typeof before) => `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || identity(opened) !== identity(before)) fail('CONFLICT', 'account source changed while opening', { stateChanged: false })
    const bytes = await handle.readFile()
    const held = await handle.stat({ bigint: true }), named = await lstat(path, { bigint: true })
    if (!named.isFile() || named.isSymbolicLink() || identity(held) !== identity(before) || identity(named) !== identity(before)) fail('CONFLICT', 'account source changed while reading', { stateChanged: false })
    return { bytes, identity: identity(before) }
  } finally { await handle.close() }
}

const toPublicServiceUser = (u: StoredServiceUser): ServiceUser => ({
  id: u.id,
  accountId: u.accountId,
  login: u.login,
  services: { ...u.services },
  mailboxQuotaMb: u.mailboxQuotaMb,
  ftpDir: u.ftpDir,
})

const toPublicDatabaseUser = (u: StoredDatabaseUser): DatabaseUser => ({
  id: u.id,
  accountId: u.accountId,
  name: u.name,
  grants: u.grants.map((g) => ({ databaseId: g.databaseId, privileges: [...g.privileges] })),
})

/** Saved mail routing paths under `extended/`, shared with the API routes that write them. */
export const MAIL_ROUTING_FILES = {
  forwarders: ['mail', 'forwarders.json'],
  domainForwarders: ['mail', 'domain-forwarders.json'],
  defaultAddresses: ['mail', 'default-addresses.json'],
  filters: ['mail', 'filters.json'],
  autoresponders: ['mail', 'autoresponders.json'],
} as const

const restoreEntries = ['feature-lists', 'plans', 'resellers', 'accounts', 'certificates', 'zones', 'server.json', 'firewall.json', 'uid-allocator.json', 'ip-pool.json', 'mail-ips.json',
  ...Object.values(MAIL_ROUTING_FILES).map((rel) => ['extended', ...rel].join('/')), 'extended/webmail/vacation'] as const

const restoreIndex = <T>(values: readonly T[], key: (value: T) => string, kind: string): Map<string, T> => {
  const index = new Map<string, T>()
  for (const value of values) {
    const id = key(value)
    if (index.has(id)) fail('VALIDATION', `duplicate ${kind} in generation snapshot`, { id })
    index.set(id, value)
  }
  return index
}

const restorePathExists = async (path: string): Promise<boolean> => {
  try { await lstat(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Content identity of the rule set; firewall writes are bound to the revision the caller read. */
export const firewallRevision = (state: FirewallState): string =>
  createHash('sha256').update(JSON.stringify({ rules: state.rules, prefixLists: state.prefixLists })).digest('hex')

export class StateStore {
  readonly rootDir: string
  readonly writerLock: WriterLock
  private readonly mutex = new AsyncMutex()
  private hooks: StateStoreHooks
  private readonly operationContext = new AsyncLocalStorage<{ active: boolean }>()

  constructor(rootDir: string, hooks: StateStoreHooks = {}, lockOptions: WriterLockOptions = {}) {
    this.rootDir = rootDir
    this.hooks = hooks
    this.writerLock = new WriterLock(rootDir, lockOptions)
  }

  setHooks(hooks: StateStoreHooks): void {
    this.hooks = hooks
  }

  registerHostUids(
    existingHostUids: StateStoreHooks['existingHostUids'],
  ): void {
    this.hooks = { ...this.hooks, existingHostUids }
  }

  getWriterLock(): WriterLock {
    return this.writerLock
  }

  getAuthorityMetadata(): Promise<StateAuthorityMetadata> {
    return this.writerLock.readAuthority()
  }

  async getRevision(): Promise<number> {
    const auth = await this.writerLock.readAuthority()
    return auth.revision
  }

  async getFencingToken(): Promise<number> {
    const auth = await this.writerLock.readAuthority()
    return auth.fencingToken
  }

  assertFencingToken(expectedToken: number): Promise<StateAuthorityMetadata> {
    return this.writerLock.assertFencingToken(expectedToken)
  }

  /**
   * Allocates a server-side short ASCII reference (`JOB-000001`, `BKP-000001`, `MIG-000001`, `GEN-000001`)
   * persisted on disk in `authority.json` under the cross-process writer lock (A58).
   */
  async allocateReference(
    kind: ReferenceKind,
    opts: { entityId?: string; expectedRevision?: number; fencingToken?: number } = {},
  ): Promise<string> {
    this.assertNotReentrant()
    return this.mutex.run(() => this.runOperation(() => this.writerLock.allocateReference(kind, opts)))
  }

  /**
   * Reads a previously allocated reference for `(kind, entityId)` without ever allocating on read
   * or truncating a UUID (A58).
   */
  getAllocatedReference(kind: ReferenceKind, entityId: string): Promise<string | null> {
    return this.writerLock.getAllocatedReference(kind, entityId)
  }

  private assertNotReentrant(): void {
    if (this.operationContext.getStore()?.active) {
      fail('PRECONDITION_FAILED', 'a state operation cannot reenter a public snapshot, workspace or mutation')
    }
  }

  private runOperation<T>(fn: () => Promise<T>): Promise<T> {
    const context = { active: true }
    return this.operationContext.run(context, async () => {
      try { return await fn() } finally { context.active = false }
    })
  }

  private async writeStateJson(lease: WriterLease, filePath: string, data: unknown, mode = 0o640): Promise<void> {
    await atomicWriteJson(filePath, data, mode, () => lease.assertFencingToken())
  }

  private async removeStatePath(lease: WriterLease, targetPath: string): Promise<boolean> {
    return atomicRemove(targetPath, () => lease.assertFencingToken())
  }

  private async withMutationLock<T>(
    opts: MutationOptions | undefined,
    fn: (lease: WriterLease) => Promise<T>,
    internalOpts: {
      incrementRevision?: boolean
      restoreAuthorityOnAbort?: boolean
      onAbort?: (lease: WriterLease) => Promise<void>
      onCommit?: (lease: WriterLease, result: T, authority: StateAuthorityMetadata) => Promise<void>
    } = {},
  ): Promise<T> {
    this.assertNotReentrant()
    return this.mutex.run(() => this.runOperation(async () => {
      const lease = await this.writerLock.acquire()
      let shouldCommit = true
      let hasResult = false
      let result!: T
      const complete = async (authority: StateAuthorityMetadata): Promise<T> => {
        if (result && typeof result === 'object' && 'checksum' in result && 'uidAllocator' in result && internalOpts.incrementRevision !== false) {
          ;(result as unknown as StateSnapshot).revision = authority.revision
        }
        await internalOpts.onCommit?.(lease, result, authority)
        return result
      }
      try {
        if (opts?.fencingToken !== undefined) await lease.assertFencingToken(opts.fencingToken)
        if (opts?.expectedRevision !== undefined) {
          const expected = assertInt(opts.expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'expectedRevision')
          if (lease.initialAuthority.revision !== expected) {
            return fail('CONFLICT', 'revision conflict: expected revision ' + expected + ', current revision is ' + lease.initialAuthority.revision,
              { expectedRevision: expected, currentRevision: lease.initialAuthority.revision })
          }
        }
        result = await fn(lease)
        hasResult = true
        if (result === false) shouldCommit = false
        if (shouldCommit) return await complete(await lease.commitAuthority({ incrementRevision: internalOpts.incrementRevision !== false }))
        if (internalOpts.restoreAuthorityOnAbort) await lease.restorePreAcquireAuthorityIfUncommitted()
        return result
      } catch (error) {
        // A successful read of renamed bytes cannot acknowledge directory durability.
        // Publication may already have happened; do not claim an unchanged tree or
        // attempt rollback from this uncertainty.
        if (isStateDirectoryDurabilityError(error)) throw error
        const authority = await lease.assertFencingToken().catch(() => null)
        if (hasResult && shouldCommit && authority?.committedLeaseId === lease.leaseId) return await complete(authority)
        if (internalOpts.onAbort) {
          if (!authority || authority.revision !== lease.initialAuthority.revision) {
            throw new AggregateError([error], 'state mutation requires recovery; source commit could not be disproved')
          }
          try { await internalOpts.onAbort(lease) }
          catch (failure) { throw new AggregateError([error, failure], 'state mutation rollback requires recovery') }
        }
        if (internalOpts.restoreAuthorityOnAbort) await lease.restorePreAcquireAuthorityIfUncommitted()
        throw error
      } finally { await lease.release() }
    }))
  }

  private path(...segments: string[]): string {
    return join(this.rootDir, ...segments)
  }

  private accountDir(username: string): string {
    return this.path('accounts', username)
  }

  // ---------------------------------------------------------------- low-level tree reader

  private async readServerFile(): Promise<StoredServerSettings | null> {
    const raw = await readJsonIfExists<unknown>(this.path('server.json'))
    return raw === null ? null : validateStoredServer(raw)
  }

  private async readFirewallFile(): Promise<FirewallState> {
    const raw = await readJsonIfExists<unknown>(this.path('firewall.json'))
    return raw === null ? { rules: [], prefixLists: [] } : validateFirewallState(raw)
  }

  private async readUidAllocatorFile(): Promise<UidAllocatorState> {
    const raw =
      (await readJsonIfExists<unknown>(this.path('uid-allocator.json'))) ??
      (await readJsonIfExists<unknown>(this.path('uids.json')))
    return raw === null ? { nextUid: 20000, allocated: [] } : validateUidAllocator(raw)
  }

  private async readFeatureListFiles(): Promise<FeatureList[]> {
    const files = await listJsonFiles(this.path('feature-lists'))
    const lists = await Promise.all(files.map(async (f) => validateFeatureListFile(await readJsonIfExists(f))))
    return lists.sort((a, b) => a.name.localeCompare(b.name))
  }

  private async readPlanFiles(): Promise<Plan[]> {
    const files = await listJsonFiles(this.path('plans'))
    const plans = await Promise.all(files.map(async (f) => validatePlanFile(await readJsonIfExists(f))))
    return plans.sort((a, b) => a.name.localeCompare(b.name))
  }

  private async readResellerFiles(): Promise<Reseller[]> {
    const files = await listJsonFiles(this.path('resellers'))
    const resellers = await Promise.all(files.map(async (f) => validateResellerFile(await readJsonIfExists(f))))
    return resellers.sort((a, b) => a.username.localeCompare(b.username))
  }

  private async readCertificateFiles(): Promise<StoredCertificate[]> {
    const files = await listJsonFiles(this.path('certificates'))
    const certs = await Promise.all(files.map(async (f) => validateCertificateFile(await readJsonIfExists(f))))
    return certs.sort((a, b) => a.id.localeCompare(b.id))
  }

  private async readZoneFiles(): Promise<DnsZoneState[]> {
    const files = await listJsonFiles(this.path('zones'))
    const zones = await Promise.all(files.map(async (f) => validateDnsZoneFile(await readJsonIfExists(f))))
    return zones.sort((a, b) => a.name.localeCompare(b.name))
  }

  private async readIpPoolFile(): Promise<ServerIpEntry[]> {
    const raw = await readJsonIfExists<unknown[]>(this.path('ip-pool.json'))
    if (raw === null) return []
    return validateIpPoolFile(raw)
  }

  private async readMailIpConfigFile(): Promise<MailIpConfig | null> {
    const raw = await readJsonIfExists<unknown>(this.path('mail-ips.json'))
    return raw === null ? null : validateMailIpConfig(raw)
  }

  /** Saved routing records, or null when none are saved. */
  async readMailRouting(): Promise<MailRoutingState | null> {
    const list = async (rel: string): Promise<unknown[]> => {
      // unreadable or malformed files enter the snapshot as one marker row: the checksum changes and the
      // agent's strict forwarding reader refuses the reconcile instead of the whole panel failing every read
      let raw: unknown
      try { raw = await readJsonIfExists<unknown>(this.path('extended', ...MAIL_ROUTING_FILES[rel as keyof typeof MAIL_ROUTING_FILES])) } catch { return [{ unreadable: rel }] }
      if (raw === null) return []
      return Array.isArray(raw) ? raw : [{ unreadable: rel }]
    }
    const vacationFiles = await listJsonFiles(this.path('extended', 'webmail', 'vacation'))
    const vacations = (await Promise.all(vacationFiles.sort().map((f) => readJsonIfExists<unknown>(f).catch(() => ({ unreadable: 'vacation' }))))).filter((v) => v !== null)
    const routing: MailRoutingState = {
      forwarders: await list('forwarders'),
      domainForwarders: await list('domainForwarders'),
      defaultAddresses: await list('defaultAddresses'),
      filters: await list('filters'),
      vacations,
    }
    const autoresponders = await list('autoresponders')
    if (autoresponders.length) routing.autoresponders = autoresponders
    return Object.values(routing).some((records) => records.length > 0) ? routing : null
  }

  private async readSnapshotUnlocked(overrideRevision?: number): Promise<StateSnapshot> {
    const [authority, server, firewall, uidAllocator, featureLists, plans, resellers, certificates, zones, ipPool, mailIpConfig, mailRouting] =
      await Promise.all([
        overrideRevision === undefined ? this.writerLock.readAuthority() : Promise.resolve(null),
        this.readServerFile(),
        this.readFirewallFile(),
        this.readUidAllocatorFile(),
        this.readFeatureListFiles(),
        this.readPlanFiles(),
        this.readResellerFiles(),
        this.readCertificateFiles(),
        this.readZoneFiles(),
        this.readIpPoolFile(),
        this.readMailIpConfigFile(),
        this.readMailRouting(),
      ])
    const revision = overrideRevision ?? authority?.revision ?? 0
    const plansById = new Map(plans.map((p) => [p.id, p]))
    const reservedPorts = new Set<number>(
      server ? [server.settings.panelPort, server.settings.sshPort, server.settings.backendPort, server.settings.backendTlsPort] : [],
    )
    const userDirs = await listSubdirs(this.path('accounts'))
    const accounts: StoredAccount[] = []
    const domains: Domain[] = []
    const serviceUsers: StoredServiceUser[] = []
    const databases: Database[] = []
    const databaseUsers: StoredDatabaseUser[] = []
    const postgresqlDatabases: Database[] = []
    const postgresqlUsers: StoredPostgresqlUser[] = []
    const cronJobs: CronJobState[] = []
    const domainCustomConfigs: DomainCustomConfig[] = []

    for (const username of userDirs) {
      const rawAcc = await readJsonIfExists<unknown>(join(this.accountDir(username), 'account.json'))
      if (rawAcc === null) continue
      const account = validateAccountFile(rawAcc)
      if (account.username !== username) {
        fail('VALIDATION', `account directory "${username}" does not match account.username "${account.username}"`)
      }
      const plan = mustExist(plansById.get(account.planId), 'plan', account.planId)
      accounts.push(account)

      const domFiles = await listJsonFiles(join(this.accountDir(username), 'domains'))
      const accDomains: Domain[] = []
      for (const df of domFiles) {
        const d = validateDomainFile(await readJsonIfExists(df), { account, plan, reservedLoopbackPorts: reservedPorts })
        accDomains.push(d)
        domains.push(d)
      }
      const domainsById = new Map(accDomains.map((d) => [d.id, d]))

      const userdataFiles = await listJsonFiles(join(this.accountDir(username), 'userdata'))
      for (const udf of userdataFiles) {
        const cfg = validateDomainCustomConfigFile(await readJsonIfExists(udf), { account, domainsById })
        domainCustomConfigs.push(cfg)
      }

      const userFiles = await listJsonFiles(join(this.accountDir(username), 'users'))
      for (const uf of userFiles) {
        const u = validateServiceUserFile(await readJsonIfExists(uf), { account, plan, domainsById })
        serviceUsers.push(u)
      }

      const dbFiles = await listJsonFiles(join(this.accountDir(username), 'databases'))
      const accDbs: Database[] = []
      for (const dbf of dbFiles) {
        const db = validateDatabaseFile(await readJsonIfExists(dbf), account)
        accDbs.push(db)
        databases.push(db)
      }
      const dbsById = new Map(accDbs.map((d) => [d.id, d]))

      const dbUserFiles = await listJsonFiles(join(this.accountDir(username), 'db-users'))
      for (const duf of dbUserFiles) {
        const dbu = validateDatabaseUserFile(await readJsonIfExists(duf), { account, databasesById: dbsById })
        databaseUsers.push(dbu)
      }
      const postgresql = await this.readAccountPostgresqlUnlocked(account)
      postgresqlDatabases.push(...postgresql.databases)
      postgresqlUsers.push(...postgresql.users)

      const rawCron = await readJsonIfExists<unknown[]>(join(this.accountDir(username), 'cron.json'))
      if (rawCron !== null) {
        if (!Array.isArray(rawCron)) fail('VALIDATION', 'cron.json must be an array')
        for (const c of rawCron) cronJobs.push(validateCronJob(c, account.id))
      }
    }

    accounts.sort((a, b) => a.username.localeCompare(b.username))
    domains.sort((a, b) => a.name.localeCompare(b.name))
    serviceUsers.sort((a, b) => a.login.localeCompare(b.login))
    databases.sort((a, b) => a.name.localeCompare(b.name))
    databaseUsers.sort((a, b) => a.name.localeCompare(b.name))
    postgresqlDatabases.sort((a, b) => a.name.localeCompare(b.name))
    postgresqlUsers.sort((a, b) => a.name.localeCompare(b.name))
    cronJobs.sort((a, b) => a.id.localeCompare(b.id))
    domainCustomConfigs.sort((a, b) => a.domainId.localeCompare(b.domainId))

    const base = {
      revision,
      server,
      firewall,
      uidAllocator,
      featureLists,
      plans,
      resellers,
      accounts,
      domains,
      serviceUsers,
      databases,
      databaseUsers,
      certificates,
      zones,
      cronJobs,
      ...(domainCustomConfigs.length > 0 ? { domainCustomConfigs } : {}),
      ...(ipPool.length > 0 ? { ipPool } : {}),
      ...(mailIpConfig !== null ? { mailIpConfig } : {}),
      ...(mailRouting !== null ? { mailRouting } : {}),
      ...(postgresqlUsers.length > 0 ? { postgresqlDatabases, postgresqlUsers } : {}),
    }
    return { ...base, checksum: checksumStateTree(base) }
  }

  /**
   * Reads and validates every desired-state file on disk and checks all cross-entity
   * invariants under a consistent revision boundary. Used by the root agent before rendering
   * and by `xpanel reindex`.
   */
  private async readSnapshotUnderLease(lease: WriterLease, revision = lease.initialAuthority.revision): Promise<StateSnapshot> {
    await lease.assertFencingToken()
    const snapshot = await this.readSnapshotUnlocked(revision)
    await lease.assertFencingToken()
    return snapshot
  }

  async readSnapshot(): Promise<StateSnapshot> {
    this.assertNotReentrant()
    return this.runOperation(async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const before = await this.writerLock.readAuthorityAtBarrier()
        let outcome: { snapshot: StateSnapshot } | { error: unknown }
        try { outcome = { snapshot: await this.readSnapshotUnlocked(before.revision) } }
        catch (error) { outcome = { error } }
        const after = await this.writerLock.readAuthorityAtBarrier()
        if (before.revision === after.revision && before.fencingToken === after.fencingToken) {
          if ('error' in outcome) throw outcome.error
          return outcome.snapshot
        }
      }
      return this.mutex.run(async () => {
        const lease = await this.writerLock.acquire()
        try { return await this.readSnapshotUnderLease(lease) }
        finally { await lease.release() }
      })
    })
  }

  /**
   * Pins an active account lifetime against termination and username reuse.
   * Use local ports only; never reenter snapshots, mutations or agent RPC here.
   * Host/read operations under this lease do not advance desired-state revision.
   */
  async withAccountLifecycleLease<T>(accountId: Id, operation: (account: Account) => Promise<T>): Promise<T> {
    this.assertNotReentrant()
    return this.mutex.run(() => this.runOperation(async () => {
      const lease = await this.writerLock.acquire()
      try {
        const account = await this.lockStoredAccount(accountId)
        if (account.status !== 'active') fail('PRECONDITION_FAILED', 'an active account is required', { stateChanged: false })
        await lease.assertFencingToken()
        const result = await operation(toPublicAccount(account))
        await lease.assertFencingToken()
        return result
      } finally { await lease.release() }
    }))
  }

  /** Coherent cron preparation; release the API-side lease before agent RPC. */
  withCronAccountLease<T>(accountId: Id, operation: (account: Account, jobs: readonly CronJobState[]) => Promise<T>): Promise<T> {
    return this.withAccountLifecycleLease(accountId, async account => operation(account, await this.listCronJobs(account.id)))
  }

  /** Changes canonical hostname and wizard projection under their source lease. */
  commitHostname<T extends { hostname: string; updatedAt: string }>(
    hostname: string,
    prepareWizard: (canonical: string, now: string) => Promise<T>,
  ): Promise<T> {
    let preimages: { relPath: string; existed: boolean; contentBase64?: string }[] = []
    let intentRecorded = false
    return this.withMutationLock(undefined, async lease => {
      const canonical = validateDomainName(hostname)
      const serverPath = this.path('server.json')
      const serverRaw = await readJsonIfExists<unknown>(serverPath)
      const server = serverRaw === null ? null : validateStoredServer(serverRaw)
      const now = new Date().toISOString()
      const prepared = await prepareWizard(canonical, now)
      if (!prepared || typeof prepared !== 'object' || Array.isArray(prepared)) fail('VALIDATION', 'hostname wizard projection must be an object')
      const next = { ...prepared, hostname: canonical, updatedAt: now }
      const paths = ['extended/setup-wizard.json', ...(server ? ['server.json'] : [])]
      preimages = await Promise.all(paths.map(async relPath => {
        try { return { relPath, existed: true, contentBase64: (await readFile(this.path(relPath))).toString('base64') } }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { relPath, existed: false }
          throw error
        }
      }))
      await lease.recordIntent({ op: 'changeHostname', createdRelPaths: [], backups: preimages })
      intentRecorded = true
      await this.writeStateJson(lease, this.path('extended/setup-wizard.json'), next)
      if (server) await this.writeStateJson(lease, serverPath, { ...server, settings: { ...server.settings, hostname: canonical }, updatedAt: now })
      return next
    }, {
      restoreAuthorityOnAbort: true,
      onAbort: async lease => {
        if (intentRecorded) await lease.rollbackIntent()

      },
    })
  }

  // ---------------------------------------------------------------- server settings

  async getServerSettings(): Promise<ServerSettings | null> {
    const s = await this.readServerFile()
    return s ? s.settings : null
  }

  saveServerSettings(s: ServerSettings, opts?: ServerSettingsMutationOptions): Promise<ServerSettings> {
    return this.withMutationLock(opts, async (lease) => {
      const validated = validateServerSettings(s)
      const current = await this.readServerFile()
      await opts?.settingsGuard?.(current?.settings ?? null)
      const settings = validated.defaultSite === undefined && current?.settings.defaultSite !== undefined
        ? { ...validated, defaultSite: current.settings.defaultSite }
        : validated
      const next: StoredServerSettings = {
        settings,
        setupCompletedAt: current?.setupCompletedAt ?? null,
        updatedAt: new Date().toISOString(),
      }
      await this.writeStateJson(lease, this.path('server.json'), next)
      return settings
    })
  }

  async isSetupComplete(): Promise<boolean> {
    const s = await this.readServerFile()
    return s?.setupCompletedAt != null
  }

  markSetupComplete(opts?: MutationOptions): Promise<void> {
    return this.withMutationLock(opts, async (lease) => {
      const current = await this.readServerFile()
      if (!current) return fail('PRECONDITION_FAILED', 'save the server settings before completing setup')
      const next: StoredServerSettings = {
        ...current,
        setupCompletedAt: current.setupCompletedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      await this.writeStateJson(lease, this.path('server.json'), next)
    })
  }

  // ---------------------------------------------------------------- feature lists

  createFeatureList(input: Omit<FeatureList, 'id'>, opts?: MutationOptions): Promise<FeatureList> {
    return this.withMutationLock(opts, async (lease) => {
      if (typeof input !== 'object' || input === null) fail('VALIDATION', 'feature list must be an object')
      const fl: FeatureList = {
        id: randomUUID(),
        name: assertName(input.name),
        ownerId: assertIdOrNull(input.ownerId ?? null, 'ownerId'),
        disabled: assertFeatureKeys(input.disabled),
      }
      if (fl.ownerId !== null) mustExist(await this.getResellerUnlocked(fl.ownerId), 'reseller', fl.ownerId)
      const existing = await this.readFeatureListFiles()
      if (existing.some((x) => x.ownerId === fl.ownerId && x.name.toLowerCase() === fl.name.toLowerCase())) {
        fail('CONFLICT', `feature list "${fl.name}" already exists`, { name: fl.name })
      }
      await this.writeStateJson(lease, this.path('feature-lists', `${fl.id}.json`), fl)
      return fl
    })
  }

  async getFeatureList(id: Id): Promise<FeatureList | null> {
    if (!isUuid(id)) return null
    const raw = await readJsonIfExists<unknown>(this.path('feature-lists', `${id.toLowerCase()}.json`))
    return raw === null ? null : validateFeatureListFile(raw)
  }

  async listFeatureLists(opts: { ownerId?: Id | null } = {}): Promise<FeatureList[]> {
    const ownerId = opts.ownerId === undefined ? undefined : opts.ownerId === null ? null : assertId(opts.ownerId, 'ownerId')
    const all = await this.readFeatureListFiles()
    return ownerId === undefined ? all : all.filter((f) => f.ownerId === ownerId)
  }

  updateFeatureList(id: Id, patch: Partial<Pick<FeatureList, 'name' | 'disabled'>>, opts?: MutationOptions): Promise<FeatureList> {
    return this.withMutationLock(opts, async (lease) => {
      const fid = assertId(id, 'id')
      const current = mustExist(await this.getFeatureList(fid), 'feature list', id)
      const next: FeatureList = {
        ...current,
        ...(patch.name !== undefined && { name: assertName(patch.name) }),
        ...(patch.disabled !== undefined && { disabled: assertFeatureKeys(patch.disabled) }),
      }
      if (next.name.toLowerCase() !== current.name.toLowerCase()) {
        const all = await this.readFeatureListFiles()
        if (all.some((x) => x.id !== current.id && x.ownerId === current.ownerId && x.name.toLowerCase() === next.name.toLowerCase())) {
          fail('CONFLICT', `feature list "${next.name}" already exists`, { name: next.name })
        }
      }
      await this.writeStateJson(lease, this.path('feature-lists', `${current.id}.json`), next)
      return next
    })
  }

  deleteFeatureList(id: Id, opts?: MutationOptions): Promise<boolean> {
    return this.withMutationLock(opts, async (lease) => {
      if (!isUuid(id)) return false
      const fid = id.toLowerCase()
      const current = await this.getFeatureList(fid)
      if (!current) return false
      const plans = await this.readPlanFiles()
      if (plans.some((p) => p.featureListId === fid)) {
        fail('CONFLICT', 'feature list is in use by a plan', { id: fid })
      }
      return this.removeStatePath(lease, this.path('feature-lists', `${fid}.json`))
    })
  }

  // ---------------------------------------------------------------- plans

  private async assertFeatureListUsable(plan: Pick<Plan, 'featureListId' | 'ownerId'>): Promise<void> {
    const fl = mustExist(await this.getFeatureList(plan.featureListId), 'feature list', plan.featureListId)
    if (fl.ownerId !== null && fl.ownerId !== plan.ownerId) fail('FORBIDDEN', 'the feature list belongs to another reseller')
  }

  createPlan(input: NewPlan, opts?: MutationOptions): Promise<Plan> {
    return this.withMutationLock(opts, async (lease) => {
      const plan = validatePlanFile({ ...input, id: randomUUID() })
      if (plan.ownerId !== null) mustExist(await this.getResellerUnlocked(plan.ownerId), 'reseller', plan.ownerId)
      await this.assertFeatureListUsable(plan)
      const all = await this.readPlanFiles()
      if (all.some((x) => x.ownerId === plan.ownerId && x.name.toLowerCase() === plan.name.toLowerCase())) {
        fail('CONFLICT', `plan "${plan.name}" already exists`, { name: plan.name })
      }
      await this.writeStateJson(lease, this.path('plans', `${plan.id}.json`), plan)
      return plan
    })
  }

  async getPlan(id: Id): Promise<Plan | null> {
    if (!isUuid(id)) return null
    const raw = await readJsonIfExists<unknown>(this.path('plans', `${id.toLowerCase()}.json`))
    return raw === null ? null : validatePlanFile(raw)
  }

  async listPlans(opts: { ownerId?: Id | null } = {}): Promise<Plan[]> {
    const ownerId = opts.ownerId === undefined ? undefined : opts.ownerId === null ? null : assertId(opts.ownerId, 'ownerId')
    const all = await this.readPlanFiles()
    return ownerId === undefined ? all : all.filter((p) => p.ownerId === ownerId)
  }

  updatePlan(id: Id, patch: PlanPatch, opts?: MutationOptions): Promise<Plan> {
    return this.withMutationLock(opts, async (lease) => {
      const pid = assertId(id, 'id')
      const current = mustExist(await this.getPlan(pid), 'plan', id)
      if (typeof patch !== 'object' || patch === null) fail('VALIDATION', 'plan patch must be an object')
      const next = validatePlanFile({
        ...current,
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.featureListId !== undefined && { featureListId: patch.featureListId }),
        ...(patch.resources !== undefined && { resources: { ...current.resources, ...patch.resources } }),
        ...(patch.caps !== undefined && { caps: { ...current.caps, ...patch.caps } }),
        ...(patch.dedicatedIp !== undefined && { dedicatedIp: patch.dedicatedIp }),
        ...(patch.enforceBandwidth !== undefined && { enforceBandwidth: patch.enforceBandwidth }),
        ...(patch.shell !== undefined && { shell: patch.shell }),
        ...(patch.defaultMailboxQuotaMb !== undefined && { defaultMailboxQuotaMb: patch.defaultMailboxQuotaMb }),
      })
      if (next.name.toLowerCase() !== current.name.toLowerCase()) {
        const all = await this.readPlanFiles()
        if (all.some((x) => x.id !== current.id && x.ownerId === current.ownerId && x.name.toLowerCase() === next.name.toLowerCase())) {
          fail('CONFLICT', `plan "${next.name}" already exists`, { name: next.name })
        }
      }
      if (next.featureListId !== current.featureListId) await this.assertFeatureListUsable(next)
      await this.assertResellersStillFit(next)
      if (next.dedicatedIp !== current.dedicatedIp) {
        await this.assertAccountIpAssignments((await this.readAllAccountsUnlocked()).filter(account => account.planId === current.id), { plan: next })
      }
      await this.writeStateJson(lease, this.path('plans', `${current.id}.json`), next)
      return next
    })
  }

  async countAccountsOnPlan(id: Id): Promise<number> {
    if (!isUuid(id)) return 0
    const accounts = await this.readAllAccountsUnlocked()
    return accounts.filter((a) => a.planId === id.toLowerCase()).length
  }

  deletePlan(id: Id, opts?: MutationOptions): Promise<boolean> {
    return this.withMutationLock(opts, async (lease) => {
      if (!isUuid(id)) return false
      const pid = id.toLowerCase()
      const current = await this.getPlan(pid)
      if (!current) return false
      const accounts = await this.readAllAccountsUnlocked()
      if (accounts.some((a) => a.planId === pid)) {
        fail('CONFLICT', 'plan is in use by an account', { id: pid })
      }
      return this.removeStatePath(lease, this.path('plans', `${pid}.json`))
    })
  }

  // ---------------------------------------------------------------- resellers

  private async getResellerUnlocked(id: Id): Promise<Reseller | null> {
    if (!isUuid(id)) return null
    const raw = await readJsonIfExists<unknown>(this.path('resellers', `${id.toLowerCase()}.json`))
    return raw === null ? null : validateResellerFile(raw)
  }

  createReseller(input: NewReseller, opts?: MutationOptions): Promise<Reseller> {
    return this.withMutationLock(opts, async (lease) => {
      const username = validateUsername(input.username)
      const passwordHash = assertArgon2Hash(input.passwordHash)
      const forcePasswordChange = input.forcePasswordChange === undefined ? false : assertBool(input.forcePasswordChange, 'forcePasswordChange')
      const id = input.id ? assertId(input.id, 'id') : randomUUID()
      const reseller = validateResellerFile({
        ...input,
        id,
        username,
        acl: assertResellerAcl(input.acl),
        nameservers: assertResellerNameservers(input.nameservers),
        delegatedIps: assertDelegatedIps(input.delegatedIps),
        oversell: assertBool(input.oversell, 'oversell'),
      })
      const [resellers, accounts] = await Promise.all([this.readResellerFiles(), this.readAllAccountsUnlocked()])
      if (
        resellers.some((r) => r.username.toLowerCase() === username.toLowerCase() || r.id === id) ||
        accounts.some((a) => a.username.toLowerCase() === username.toLowerCase())
      ) {
        fail('CONFLICT', `username "${username}" is already taken`, { username })
      }
      if (this.hooks.onCreateResellerPrincipal) {
        await this.hooks.onCreateResellerPrincipal({ id, username, passwordHash, forcePasswordChange })
      }
      await this.writeStateJson(lease, this.path('resellers', `${reseller.id}.json`), reseller)
      return reseller
    })
  }

  getReseller(id: Id): Promise<Reseller | null> {
    return this.getResellerUnlocked(id)
  }

  async getResellerByUsername(username: string): Promise<Reseller | null> {
    if (typeof username !== 'string' || username.length > 64) return null
    const lower = username.toLowerCase()
    const all = await this.readResellerFiles()
    return all.find((r) => r.username.toLowerCase() === lower) ?? null
  }

  listResellers(): Promise<Reseller[]> {
    return this.readResellerFiles()
  }

  updateReseller(id: Id, patch: ResellerPatch, opts?: MutationOptions): Promise<Reseller> {
    return this.withMutationLock(opts, async (lease) => {
      const current = mustExist(await this.getResellerUnlocked(id), 'reseller', id)
      const next = validateResellerFile({
        ...current,
        ...patch,
        id: current.id,
        username: current.username,
        acl: patch.acl === undefined ? current.acl : assertResellerAcl(patch.acl),
        nameservers: patch.nameservers === undefined ? current.nameservers : assertResellerNameservers(patch.nameservers),
        delegatedIps: patch.delegatedIps === undefined ? current.delegatedIps : assertDelegatedIps(patch.delegatedIps),
        oversell: patch.oversell === undefined ? current.oversell : assertBool(patch.oversell, 'oversell'),
      })
      if (JSON.stringify(next.delegatedIps) !== JSON.stringify(current.delegatedIps)) {
        await this.assertAccountIpAssignments((await this.readAllAccountsUnlocked()).filter(account => account.ownerId === current.id), { reseller: next })
      }
      await this.writeStateJson(lease, this.path('resellers', `${current.id}.json`), next)
      return next
    })
  }

  deleteReseller(id: Id, opts?: MutationOptions): Promise<boolean> {
    return this.withMutationLock(opts, async (lease) => {
      if (!isUuid(id)) return false
      const rid = id.toLowerCase()
      const current = await this.getResellerUnlocked(rid)
      if (!current) return false
      const accounts = await this.readAllAccountsUnlocked()
      if (accounts.some((a) => a.ownerId === rid)) {
        fail('CONFLICT', 'reseller still owns accounts', { id: rid })
      }
      const plans = await this.readPlanFiles()
      for (const p of plans.filter((x) => x.ownerId === rid)) {
        await this.removeStatePath(lease, this.path('plans', `${p.id}.json`))
      }
      const lists = await this.readFeatureListFiles()
      for (const fl of lists.filter((x) => x.ownerId === rid)) {
        await this.removeStatePath(lease, this.path('feature-lists', `${fl.id}.json`))
      }
      await this.removeStatePath(lease, this.path('resellers', `${rid}.json`))
      if (this.hooks.onDeleteReseller) await this.hooks.onDeleteReseller(rid)
      return true
    })
  }

  async resellerUsage(id: Id): Promise<ResellerUsage> {
    if (!isUuid(id)) return { accounts: 0, diskMb: 0, bandwidthMb: 0 }
    const rid = id.toLowerCase()
    const [accounts, plans] = await Promise.all([this.readAllAccountsUnlocked(), this.readPlanFiles()])
    const plansById = new Map(plans.map((p) => [p.id, p]))
    const owned = accounts.filter((a) => a.ownerId === rid)
    const disks: Limit[] = []
    const bws: Limit[] = []
    for (const a of owned) {
      const p = plansById.get(a.planId)
      if (p) {
        disks.push(p.resources.diskMb)
        bws.push(p.resources.bandwidthMbMonth)
      }
    }
    return {
      accounts: owned.length,
      diskMb: sumLimits(disks),
      bandwidthMb: sumLimits(bws),
    }
  }

  private async assertResellerHasRoom(
    resellerId: Id,
    plan: Plan,
    opts: { isNewAccount: boolean; exceptAccountId?: Id },
  ): Promise<void> {
    const reseller = mustExist(await this.getResellerUnlocked(resellerId), 'reseller', resellerId)
    const [accounts, plans] = await Promise.all([this.readAllAccountsUnlocked(), this.readPlanFiles()])
    const plansById = new Map(plans.map((p) => [p.id, p]))
    const owned = accounts
      .filter((a) => a.ownerId === resellerId && a.id !== opts.exceptAccountId)
      .map((a) => ({ accountPlanId: a.planId, plan: mustExist(plansById.get(a.planId), 'plan', a.planId) }))
    assertResellerCapacity({ reseller, ownedAccounts: owned, newPlan: plan, isNewAccount: opts.isNewAccount })
  }

  private async assertResellersStillFit(plan: Plan): Promise<void> {
    const [accounts, plans] = await Promise.all([this.readAllAccountsUnlocked(), this.readPlanFiles()])
    const plansById = new Map(plans.map((p) => [p.id, p]))
    plansById.set(plan.id, plan)
    const ownerIds = [...new Set(accounts.filter((a) => a.planId === plan.id && a.ownerId !== null).map((a) => a.ownerId as Id))]
    for (const ownerId of ownerIds) {
      const reseller = mustExist(await this.getResellerUnlocked(ownerId), 'reseller', ownerId)
      const owned = accounts
        .filter((a) => a.ownerId === ownerId)
        .map((a) => ({ accountPlanId: a.planId, plan: mustExist(plansById.get(a.planId), 'plan', a.planId) }))
      const standIn = owned.findIndex((o) => o.accountPlanId === plan.id)
      const others = owned.filter((_, i) => i !== standIn)
      assertResellerCapacity({ reseller, ownedAccounts: others, newPlan: plan, isNewAccount: false })
    }
  }

  // ---------------------------------------------------------------- UID allocator & accounts

  private async isHostUidTaken(uid: number, username: string): Promise<boolean> {
    const src = this.hooks.existingHostUids
    if (!src) return false
    if (typeof src === 'function') {
      const res = await (src as (uid: number, username: string) => unknown)(uid, username)
      if (typeof res === 'boolean') return res
      if (res instanceof Set) return res.has(uid)
      if (Array.isArray(res)) return res.includes(uid)
      return Boolean(res)
    }
    if (src instanceof Set) return src.has(uid)
    if (Array.isArray(src)) return src.includes(uid)
    return false
  }

  private async allocateUidUnlocked(lease: WriterLease, username: string): Promise<number> {
    const validUser = validateUsername(username)
    const [state, existingAccounts] = await Promise.all([
      this.readUidAllocatorFile(),
      this.readAllAccountsUnlocked(),
    ])
    const usedUids = new Set<number>([
      ...state.allocated.map((a) => a.uid),
      ...existingAccounts.map((a) => a.uid),
    ])
    const highestExisting = usedUids.size > 0 ? Math.max(...usedUids) + 1 : state.nextUid
    let candidate = Math.max(state.nextUid, highestExisting)
    const newlyAllocated = [...state.allocated]
    const now = new Date().toISOString()

    while (candidate <= MAX_ACCOUNT_UID) {
      if (usedUids.has(candidate) || (await this.isHostUidTaken(candidate, validUser))) {
        if (!newlyAllocated.some((a) => a.uid === candidate)) {
          newlyAllocated.push({
            uid: candidate,
            username: 'hostreserved',
            allocatedAt: now,
          })
        }
        usedUids.add(candidate)
        candidate++
        continue
      }
      break
    }

    if (candidate > MAX_ACCOUNT_UID) fail('LIMIT_EXCEEDED', 'UID range 20000..60000 exhausted')
    const uid = candidate
    const next: UidAllocatorState = {
      nextUid: uid + 1,
      allocated: [...newlyAllocated, { uid, username: validUser, allocatedAt: now }],
    }
    await this.writeStateJson(lease, this.path('uid-allocator.json'), next)
    return uid
  }

  allocateUid(username: string, opts?: MutationOptions): Promise<number> {
    return this.withMutationLock(opts, (lease) => this.allocateUidUnlocked(lease, username), { incrementRevision: false })
  }

  async maxAllocatedUid(): Promise<number | null> {
    const state = await this.readUidAllocatorFile()
    return state.allocated.length === 0 ? null : state.nextUid - 1
  }

  private async readAllAccountsUnlocked(): Promise<StoredAccount[]> {
    const userDirs = await listSubdirs(this.path('accounts'))
    const out: StoredAccount[] = []
    for (const u of userDirs) {
      const raw = await readJsonIfExists<unknown>(join(this.accountDir(u), 'account.json'))
      if (raw !== null) out.push(validateAccountFile(raw))
    }
    return out.sort((a, b) => a.username.localeCompare(b.username))
  }

  private async findStoredAccountById(id: unknown): Promise<StoredAccount | null> {
    if (!isUuid(id)) return null
    const target = id.toLowerCase()
    const all = await this.readAllAccountsUnlocked()
    return all.find((a) => a.id === target) ?? null
  }

  private async lockStoredAccount(id: unknown): Promise<StoredAccount> {
    const aid = assertId(id, 'accountId')
    const acc = mustExist(await this.findStoredAccountById(aid), 'account', id)
    if (acc.status === 'terminating') fail('PRECONDITION_FAILED', 'the account is being terminated', { id: acc.id })
    return acc
  }

  private assertPlanUsable(plan: Plan, ownerId: Id | null): void {
    if (plan.ownerId !== null && plan.ownerId !== ownerId) fail('FORBIDDEN', 'the plan belongs to another reseller')
  }

  private async readAllDomainsUnlocked(): Promise<Domain[]> {
    const [accounts, plans, server] = await Promise.all([
      this.readAllAccountsUnlocked(),
      this.readPlanFiles(),
      this.readServerFile(),
    ])
    const plansById = new Map(plans.map((p) => [p.id, p]))
    const reserved = new Set<number>(
      server ? [server.settings.panelPort, server.settings.sshPort, server.settings.backendPort, server.settings.backendTlsPort] : [],
    )
    const out: Domain[] = []
    for (const account of accounts) {
      const plan = mustExist(plansById.get(account.planId), 'plan', account.planId)
      const files = await listJsonFiles(join(this.accountDir(account.username), 'domains'))
      for (const f of files) {
        out.push(validateDomainFile(await readJsonIfExists(f), { account, plan, reservedLoopbackPorts: reserved }))
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  private async assertDomainNameFree(name: string, accountId: Id | undefined, ignore: ReadonlySet<Id> = new Set()): Promise<void> {
    const all = (await this.readAllDomainsUnlocked()).filter((d) => !ignore.has(d.id))
    assertDomainUnique(name, all, accountId)
  }

  createAccount(input: NewAccount, opts?: MutationOptions): Promise<Account> {
    const mergedOpts: MutationOptions | undefined =
      opts ??
      (input && (input.expectedRevision !== undefined || input.fencingToken !== undefined)
        ? {
            ...(input.expectedRevision !== undefined && { expectedRevision: input.expectedRevision }),
            ...(input.fencingToken !== undefined && { fencingToken: input.fencingToken }),
          }
        : undefined)
    return this.withMutationLock(mergedOpts, async (lease) => {
      const username = validateUsername(input.username)
      const home = validateHome(`${input.homeBase ?? '/home'}/${username}`)
      const primaryDomain = validateDomainName(input.primaryDomain)
      const ownerId = assertIdOrNull(input.ownerId, 'ownerId')
      const contactEmail = assertEmail(input.contactEmail, 'contactEmail')
      const shell = oneOf(input.shell, SHELLS, 'shell')
      const passwordHash = assertArgon2Hash(input.passwordHash)
      const forcePasswordChange = input.forcePasswordChange === undefined ? false : assertBool(input.forcePasswordChange, 'forcePasswordChange')

      const plan = mustExist(await this.getPlan(assertId(input.planId, 'planId')), 'plan', input.planId)
      this.assertPlanUsable(plan, ownerId)
      const php = assertPhpSettings(input.php, { phpWorkers: plan.caps.phpWorkers, memoryMb: plan.resources.memoryMb })
      if (ownerId !== null) await this.assertResellerHasRoom(ownerId, plan, { isNewAccount: true })
      await this.assertDomainNameFree(primaryDomain, undefined)

      const accountId = randomUUID()
      const [accounts, resellers, pool, domains, mailIpConfig] = await Promise.all([this.readAllAccountsUnlocked(), this.readResellerFiles(), this.readIpPoolFile(), this.readAllDomainsUnlocked(), this.readMailIpConfigFile()])
      const { ipv4, ipv6, extraIps } = resolveAccountIpAssignment(input, { accountId, ownerId, planDedicatedIp: plan.dedicatedIp,
        reseller: ownerId === null ? null : resellers.find(reseller => reseller.id === ownerId) ?? null, pool, allAccounts: accounts, domains, mailIpConfig })

      // Journal the allocator preimage before reserving a UID. A failed create rolls that
      // reservation back. A crash whose journal has no preimage still keeps the burn.
      const allocatorRel = 'uid-allocator.json'
      let allocatorBackup: { relPath: string; existed: boolean; contentBase64?: string }
      try {
        allocatorBackup = { relPath: allocatorRel, existed: true, contentBase64: (await readFile(this.path(allocatorRel))).toString('base64') }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        allocatorBackup = { relPath: allocatorRel, existed: false }
      }
      await lease.recordIntent({
        op: 'createAccount',
        createdRelPaths: [`accounts/${username}`],
        backups: [allocatorBackup],
      })
      let uid = 0
      try {
      uid = await this.allocateUidUnlocked(lease, username)
      if (
        accounts.some((a) => a.username.toLowerCase() === username.toLowerCase()) ||
        resellers.some((r) => r.username.toLowerCase() === username.toLowerCase())
      ) {
        fail('CONFLICT', `username "${username}" is already taken`, { username })
      }

      const account: StoredAccount = {
        id: accountId,
        username,
        uid,
        gid: uid,
        home,
        primaryDomain,
        planId: plan.id,
        ownerId,
        status: 'active',
        suspendReason: null,
        suspendedAt: null,
        contactEmail,
        ipv4,
        ...(ipv6 !== undefined && { ipv6 }),
        ...(extraIps !== undefined && { extraIps }),
        shell,
        createdAt: new Date().toISOString(),
      }
      const domain: Domain = {
        id: randomUUID(),
        accountId: account.id,
        name: primaryDomain,
        kind: 'primary',
        parentId: null,
        docRoot: defaultDocRoot(account, 'primary', primaryDomain),
        siteType: 'php',
        upstream: null,
        redirect: null,
        php,
        wildcard: false,
        certificateId: null,
        suspended: false,
        expiresAt: null,
        pathQuotaMb: 'unlimited',
      }

      if (this.hooks.onCreateUserPrincipal) {
        await this.hooks.onCreateUserPrincipal({ accountId: account.id, username, passwordHash, forcePasswordChange })
      }
      await this.writeStateJson(lease, join(this.accountDir(username), 'domains', `${primaryDomain}.json`), domain)
      if (this.hooks.onBeforeAccountCommit) {
        await this.hooks.onBeforeAccountCommit({
          accountId: account.id,
          username,
          uid,
          fencingToken: lease.fencingToken,
        })
      }
      await this.writeStateJson(lease, join(this.accountDir(username), 'account.json'), account)
      return toPublicAccount(account)
      } catch (error) {
        await lease.rollbackIntent().catch(() => undefined)
        if (this.hooks.onDeleteAccount) await Promise.resolve(this.hooks.onDeleteAccount(accountId)).catch(() => undefined)
        throw error
      }
    })
  }

  /** A principal's username is a fast path hint; the persisted account ID remains authoritative. */
  async getAccount(id: Id, hint?: { username: string }): Promise<Account | null> {
    if (!isUuid(id)) return null
    const target = id.toLowerCase()
    if (hint !== undefined) {
      let username: string | null = null
      try { username = validateUsername(hint.username) } catch (error) {
        if (!isXpanelError(error) || error.code !== 'VALIDATION') throw error
      }
      if (username !== null) {
        const raw = await readJsonIfExists<unknown>(join(this.accountDir(username), 'account.json'))
        if (raw !== null) {
          const account = validateAccountFile(raw)
          if (account.username === username && account.id === target) return toPublicAccount(account)
        }
      }
    }
    // Aliases and imported principals may use another login name. Never replace ID authority with a hint.
    const account = await this.findStoredAccountById(target)
    if (!account) return null
    const canonical = await readJsonIfExists<unknown>(join(this.accountDir(account.username), 'account.json'))
    if (canonical === null) return null
    const checked = validateAccountFile(canonical)
    return checked.id === target && checked.username === account.username ? toPublicAccount(checked) : null
  }

  /**
   * Reads the linked account, plan and feature list under a real cross-process lease.
   * This bounded projection neither caches authorization nor scans unrelated service state.
   * A real lease also avoids authority ABA during an aborted state restore.
   */
  async readAccountWorkspace(id: Id, hint?: { username: string }): Promise<{
    account: Account | null
    plan: Plan | null
    featureList: FeatureList | null
  }> {
    this.assertNotReentrant()
    return this.mutex.run(() => this.runOperation(async () => {
      const lease = await this.writerLock.acquire()
      try {
        await lease.assertFencingToken()
        const account = await this.getAccount(id, hint)
        const candidatePlan = account ? await this.getPlan(account.planId) : null
        const plan = candidatePlan?.id === account?.planId ? candidatePlan : null
        const candidateList = plan ? await this.getFeatureList(plan.featureListId) : null
        const featureList = candidateList?.id === plan?.featureListId ? candidateList : null
        await lease.assertFencingToken()
        return { account, plan, featureList }
      } finally {
        await lease.release()
      }
    }))
  }

  async getAccountByUsername(username: string): Promise<Account | null> {
    if (typeof username !== 'string' || username.length > 64) return null
    const lower = username.toLowerCase()
    const all = await this.readAllAccountsUnlocked()
    const found = all.find((a) => a.username.toLowerCase() === lower)
    return found ? toPublicAccount(found) : null
  }

  private filterAccounts(all: StoredAccount[], f: AccountFilter = {}): StoredAccount[] {
    const ownerId = f.ownerId === undefined ? undefined : f.ownerId === null ? null : assertId(f.ownerId, 'ownerId')
    const status = f.status === undefined ? undefined : oneOf(f.status, STATUSES, 'status')
    const planId = f.planId === undefined ? undefined : assertId(f.planId, 'planId')
    return all.filter(
      (a) =>
        (ownerId === undefined || a.ownerId === ownerId) &&
        (status === undefined || a.status === status) &&
        (planId === undefined || a.planId === planId),
    )
  }

  async listAccounts(f: AccountFilter = {}): Promise<Account[]> {
    return this.filterAccounts(await this.readAllAccountsUnlocked(), f).map(toPublicAccount)
  }

  async countAccounts(f: AccountFilter = {}): Promise<number> {
    return this.filterAccounts(await this.readAllAccountsUnlocked(), f).length
  }

  suspendAccount(id: Id, reason: string, opts?: MutationOptions): Promise<Account> {
    return this.withMutationLock(opts, async (lease) => {
      const aid = assertId(id, 'id')
      const r = assertLine(reason, 512, 'suspend reason', { allowEmpty: false })
      const current = mustExist(await this.findStoredAccountById(aid), 'account', id)
      if (current.status === 'terminating') {
        fail('PRECONDITION_FAILED', `cannot suspend an account that is ${current.status}`, { id, status: current.status })
      }
      const next: StoredAccount = { ...current, status: 'suspended', suspendReason: r, suspendedAt: new Date().toISOString() }
      await this.writeStateJson(lease, join(this.accountDir(current.username), 'account.json'), next)
      return toPublicAccount(next)
    })
  }

  unsuspendAccount(id: Id, opts?: MutationOptions): Promise<Account> {
    return this.withMutationLock(opts, async (lease) => {
      const aid = assertId(id, 'id')
      const current = mustExist(await this.findStoredAccountById(aid), 'account', id)
      if (current.status !== 'suspended') {
        fail('PRECONDITION_FAILED', `cannot unsuspend an account that is ${current.status}`, { id, status: current.status })
      }
      const next: StoredAccount = { ...current, status: 'active', suspendReason: null, suspendedAt: null }
      await this.writeStateJson(lease, join(this.accountDir(current.username), 'account.json'), next)
      return toPublicAccount(next)
    })
  }

  /** Records (month) or clears (null) enforced monthly bandwidth limits in one mutation; the edge serves the limit page while one is set. */
  setBandwidthLimits(changes: readonly { accountId: Id; month: string | null }[], opts?: MutationOptions): Promise<Account[]> {
    return this.withMutationLock(opts, async (lease) => {
      if (!Array.isArray(changes) || changes.length === 0 || changes.length > 10_000) fail('VALIDATION', 'bandwidth limit changes must be a non-empty list')
      const written: Account[] = [], seen = new Set<string>()
      for (const change of changes) {
        const aid = assertId(change.accountId, 'accountId')
        if (seen.has(aid)) fail('VALIDATION', 'an account may change once per bandwidth limit write')
        seen.add(aid)
        if (change.month !== null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(change.month)) fail('VALIDATION', 'bandwidthLimitedMonth must be YYYY-MM')
        const current = mustExist(await this.findStoredAccountById(aid), 'account', aid)
        const { bandwidthLimitedMonth: _previous, ...rest } = current
        const next: StoredAccount = change.month === null ? rest : { ...rest, bandwidthLimitedMonth: change.month }
        await this.writeStateJson(lease, join(this.accountDir(current.username), 'account.json'), next)
        written.push(toPublicAccount(next))
      }
      return written
    })
  }

  markTerminating(id: Id, opts?: MutationOptions): Promise<Account> {
    return this.withMutationLock(opts, async (lease) => {
      const aid = assertId(id, 'id')
      const current = mustExist(await this.findStoredAccountById(aid), 'account', id)
      const next: StoredAccount = { ...current, status: 'terminating', suspendReason: null, suspendedAt: null }
      await this.writeStateJson(lease, join(this.accountDir(current.username), 'account.json'), next)
      return toPublicAccount(next)
    })
  }

  deleteAccount(id: Id, opts?: MutationOptions): Promise<boolean> {
    return this.withMutationLock(opts, async (lease) => {
      if (!isUuid(id)) return false
      const current = await this.findStoredAccountById(id)
      if (!current) return false
      if (current.status !== 'terminating') {
        fail('PRECONDITION_FAILED', 'only a terminating account can be deleted', { id, status: current.status })
      }
      const pool = await this.readIpPoolFile()
      if ([current.ipv4, ...(current.ipv6 ? [current.ipv6] : []), ...(current.extraIps ?? [])]
        .some(address => pool.find(entry => entry.address === canonicalIp(address).address)?.role !== 'shared')) {
        fail('PRECONDITION_FAILED', 'dedicated IP release requires verified target-bound deprovisioning', { reason: 'ip_release_unverified', stateChanged: false })
      }
      for (const domain of (await this.readAllDomainsUnlocked()).filter(domain => domain.accountId === current.id)) this.assertDomainIpRelease(domain, current, pool, false)
      // Remove account certificates and zones
      const certs = await this.readCertificateFiles()
      for (const c of certs.filter((x) => x.accountId === current.id)) {
        await this.removeStatePath(lease, this.path('certificates', `${c.id}.json`))
      }
      const zones = await this.readZoneFiles()
      for (const z of zones.filter((x) => x.accountId === current.id)) {
        await this.removeStatePath(lease, this.path('zones', `${z.name}.json`))
      }
      await this.removeStatePath(lease, this.accountDir(current.username))
      if (this.hooks.onDeleteAccount) await this.hooks.onDeleteAccount(current.id)
      return true
    })
  }

  changePlan(id: Id, planId: Id, opts?: MutationOptions): Promise<Account> {
    return this.withMutationLock(opts, async (lease) => {
      const account = await this.lockStoredAccount(id)
      const plan = mustExist(await this.getPlan(assertId(planId, 'planId')), 'plan', planId)
      if (plan.id === account.planId) return toPublicAccount(account)
      this.assertPlanUsable(plan, account.ownerId)
      const pool = await this.readIpPoolFile()
      if (!plan.dedicatedIp && pool.some(entry => entry.role === 'dedicated' && [account.ipv4, account.ipv6, ...(account.extraIps ?? [])].some(value => value != null && canonicalIp(value).address === entry.address))) {
        fail('PRECONDITION_FAILED', 'plan change requires a verified dedicated IP transition', { reason: 'ip_transition_unverified', stateChanged: false })
      }
      await this.assertAccountIpAssignments([account], { plan })
      const allDomains = (await this.readAllDomainsUnlocked()).filter((d) => d.accountId === account.id)
      for (const d of allDomains) {
        assertPhpSettings(d.php, { phpWorkers: plan.caps.phpWorkers, memoryMb: plan.resources.memoryMb })
      }
      if (account.ownerId !== null) {
        await this.assertResellerHasRoom(account.ownerId, plan, { isNewAccount: false, exceptAccountId: account.id })
      }
      const next: StoredAccount = { ...account, planId: plan.id }
      await this.writeStateJson(lease, join(this.accountDir(account.username), 'account.json'), next)
      return toPublicAccount(next)
    })
  }

  changeOwner(id: Id, ownerId: Id | null, opts?: MutationOptions): Promise<Account> {
    return this.withMutationLock(opts, async (lease) => {
      const account = await this.lockStoredAccount(id)
      const nextOwner = assertIdOrNull(ownerId, 'ownerId')
      if (nextOwner === account.ownerId) return toPublicAccount(account)
      const plan = mustExist(await this.getPlan(account.planId), 'plan', account.planId)
      this.assertPlanUsable(plan, nextOwner)
      const [pool, accounts, domains, mailIpConfig, resellers] = await Promise.all([this.readIpPoolFile(), this.readAllAccountsUnlocked(), this.readAllDomainsUnlocked(), this.readMailIpConfigFile(), this.readResellerFiles()])
      resolveAccountIpAssignment(account, { accountId: account.id, ownerId: nextOwner, planDedicatedIp: plan.dedicatedIp, pool, allAccounts: accounts, domains, mailIpConfig,
        reseller: nextOwner === null ? null : resellers.find(reseller => reseller.id === nextOwner) ?? null })
      if (nextOwner !== null) {
        await this.assertResellerHasRoom(nextOwner, plan, { isNewAccount: true, exceptAccountId: account.id })
      }
      const next: StoredAccount = { ...account, ownerId: nextOwner }
      await this.writeStateJson(lease, join(this.accountDir(account.username), 'account.json'), next)
      return toPublicAccount(next)
    })
  }

  updateAccount(
    id: Id,
    patch: { contactEmail?: string; ipv4?: string; ipv6?: string | null; extraIps?: string[]; shell?: ShellAccess },
    opts?: MutationOptions,
  ): Promise<Account> {
    return this.withMutationLock(opts, async (lease) => {
      const aid = assertId(id, 'id')
      const current = mustExist(await this.findStoredAccountById(aid), 'account', id)
      if ((patch.ipv4 !== undefined && canonicalIp(patch.ipv4).address !== current.ipv4)
        || (patch.ipv6 !== undefined && (patch.ipv6 === null ? null : canonicalIp(patch.ipv6).address) !== (current.ipv6 ?? null))
        || (patch.extraIps !== undefined && JSON.stringify(validateIpList(patch.extraIps).sort()) !== JSON.stringify([...(current.extraIps ?? [])].sort()))) {
        fail('PRECONDITION_FAILED', 'IP changes require a verified reserve/apply/release transition', { reason: 'ip_transition_unverified', stateChanged: false })
      }
      const next: StoredAccount = {
        ...current,
        ...(patch.contactEmail !== undefined && { contactEmail: assertEmail(patch.contactEmail, 'contactEmail') }),
        ...(patch.ipv4 !== undefined && { ipv4: assertIpv4(patch.ipv4) }),
        ...(patch.ipv6 !== undefined && { ipv6: patch.ipv6 === null ? null : assertIpv6(patch.ipv6, 'ipv6') }),
        ...(patch.extraIps !== undefined && { extraIps: validateIpList(patch.extraIps, 'extraIps') }),
        ...(patch.shell !== undefined && { shell: oneOf(patch.shell, SHELLS, 'shell') }),
      }
      await this.writeStateJson(lease, join(this.accountDir(current.username), 'account.json'), next)
      return toPublicAccount(next)
    })
  }

  /** Contact metadata and its derived index share one writer lease and guarded compensation. */
  async updateAccountContactEmail(
    id: Id,
    contactEmail: unknown,
    ports: {
      expectedContactRevision: string
      authorize: (current: Account) => Promise<void>
      prepareIndex: (current: Account) => Promise<() => Promise<void>>
      synchronizeIndex: (updated: Account) => Promise<void>
    },
  ): Promise<Account> {
    const email = assertEmail(contactEmail, 'contactEmail')
    const expected = assertAccountContactRevision(ports.expectedContactRevision)
    let intentRecorded = false
    let restored = false
    let restoreIndex: (() => Promise<void>) | undefined
    let reason = 'contact_update_failed'
    try {
      return await this.withMutationLock(undefined, async lease => {
        const current = mustExist(await this.findStoredAccountById(assertId(id)), 'account', id)
        const account = toPublicAccount(current)
        await ports.authorize(account)
        if (accountContactRevision(account) !== expected) {
          return fail('CONFLICT', 'account contact details changed; reload before saving', { reason: 'contact_revision_conflict', stateChanged: false })
        }
        restoreIndex = await ports.prepareIndex(account)
        const relPath = `accounts/${current.username}/account.json`
        const contentBase64 = (await readFile(this.path(relPath))).toString('base64')
        await lease.recordIntent({ op: 'updateAccountContactEmail', createdRelPaths: [], backups: [{ relPath, existed: true, contentBase64 }] })
        intentRecorded = true
        const updated = toPublicAccount({ ...current, contactEmail: email })
        await this.writeStateJson(lease, this.path(relPath), { ...current, contactEmail: email })
        reason = 'contact_index_failed'
        await ports.synchronizeIndex(updated)
        reason = 'contact_commit_failed'
        return updated
      }, {
        restoreAuthorityOnAbort: true,
        onAbort: async lease => {
          if (!intentRecorded) return
          // Keep the state intent if index restoration fails, so recovery evidence survives.
          await restoreIndex!()
          await lease.rollbackIntent()
          restored = true
        },
      })
    } catch (error) {
      if (!intentRecorded) throw error
      return fail('SERVICE_UNAVAILABLE', 'account contact update requires verification', {
        reason, verificationRequired: true, stateChanged: !restored, ...(!restored && { unknownOutcome: true }),
      })
    }
  }

  // ---------------------------------------------------------------- domains

  async countDomainsByKind(accountId: Id): Promise<Record<DomainKind, number>> {
    const out: Record<DomainKind, number> = { primary: 0, addon: 0, alias: 0, subdomain: 0 }
    if (!isUuid(accountId)) return out
    const aid = accountId.toLowerCase()
    for (const d of await this.readAllDomainsUnlocked()) {
      if (d.accountId === aid) out[d.kind]++
    }
    return out
  }

  private async assertCertificateOwned(certificateId: unknown, accountId: Id): Promise<Id | null> {
    const cid = assertIdOrNull(certificateId, 'certificateId')
    if (cid === null) return null
    const cert = mustExist(await this.getCertificate(cid), 'certificate', cid)
    if (cert.accountId !== accountId) fail('FORBIDDEN', 'the certificate belongs to another account')
    return cid
  }

  private async domainWorkspaceUnlocked(accountId: Id): Promise<DomainWorkspaceRead> {
    const account = mustExist(await this.findStoredAccountById(accountId), 'account', accountId)
    const plan = mustExist(await this.getPlan(account.planId), 'plan', account.planId)
    const features = mustExist(await this.getFeatureList(plan.featureListId), 'feature list', plan.featureListId)
    const allDomains = await this.readAllDomainsUnlocked()
    assertAccountDomainGraph(allDomains, account.id)
    const domains = allDomains.filter(domain => domain.accountId === account.id)
    const dependencies = domains.map(domain => ({ domainId: domain.id,
      childCount: domains.filter(child => child.parentId === domain.id).length, serviceUserCount: 0 }))
    const byId = new Map(dependencies.map(dependency => [dependency.domainId, dependency]))
    const byName = new Map(domains.map(domain => [domain.name, domain.id]))
    for (const file of await listJsonFiles(join(this.accountDir(account.username), 'users'))) {
      const raw = await readJsonIfExists<Record<string, unknown>>(file)
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('PRECONDITION_FAILED', 'service user configuration requires review', { stateChanged: false })
      if (raw.accountId !== undefined && raw.accountId !== account.id) fail('PRECONDITION_FAILED', 'service user scope requires review', { stateChanged: false })
      const bindings = new Set<Id>()
      if (typeof raw.domainId === 'string') {
        if (!byId.has(raw.domainId)) fail('PRECONDITION_FAILED', 'service user domain requires review', { stateChanged: false })
        bindings.add(raw.domainId)
      }
      if (typeof raw.login === 'string') {
        const name = raw.login.slice(raw.login.lastIndexOf('@') + 1).toLowerCase()
        const bound = byName.get(name)
        if (!bound) return fail('PRECONDITION_FAILED', 'service user domain requires review', { stateChanged: false })
        bindings.add(bound)
      }
      if (!bindings.size) fail('PRECONDITION_FAILED', 'service user binding requires review', { stateChanged: false })
      for (const id of bindings) byId.get(id)!.serviceUserCount++
    }
    const managedConfigDigests: Record<Id, string> = {}
    for (const domain of domains) {
      const file = join(this.accountDir(account.username), 'userdata', `${domain.id}.json`)
      try {
        const stat = await lstat(file)
        if (!stat.isFile() || stat.isSymbolicLink()) fail('PRECONDITION_FAILED', 'managed domain configuration requires review', { stateChanged: false })
        const bytes = await readFile(file)
        JSON.parse(bytes.toString('utf8'))
        managedConfigDigests[domain.id] = createHash('sha256').update(bytes).digest('hex')
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    const source: DomainWorkspaceSource = { account: toPublicAccount(account), plan, disabledFeatures: features.disabled,
      domains, dependencies, managedConfigDigests }
    return { source, revision: domainWorkspaceRevision(source) }
  }

  async readDomainWorkspace(accountId: Id): Promise<DomainWorkspaceRead> {
    const aid = assertId(accountId, 'accountId')
    this.assertNotReentrant()
    return this.runOperation(async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const before = await this.writerLock.readAuthorityAtBarrier()
        let outcome: { value: DomainWorkspaceRead } | { error: unknown }
        try { outcome = { value: await this.domainWorkspaceUnlocked(aid) } } catch (error) { outcome = { error } }
        const after = await this.writerLock.readAuthorityAtBarrier()
        if (before.revision === after.revision && before.fencingToken === after.fencingToken) {
          if ('error' in outcome) throw outcome.error
          return outcome.value
        }
      }
      return this.mutex.run(async () => {
        const lease = await this.writerLock.acquire()
        try {
          await lease.assertFencingToken()
          const result = await this.domainWorkspaceUnlocked(aid)
          await lease.assertFencingToken()
          return result
        } finally { await lease.release() }
      })
    })
  }

  private withJournaledMutation<T>(opts: MutationOptions | undefined, resource: 'domain' | 'database' | 'certificate',
    onCommitted: ((revision: number) => void) | undefined,
    fn: (lease: WriterLease, journal: MutationJournal) => Promise<T>): Promise<T> {
    const journal: MutationJournal = { recorded: false, restored: false }
    return this.withMutationLock(opts, lease => fn(lease, journal), {
      restoreAuthorityOnAbort: true,
      onAbort: async lease => {
        if (!journal.recorded) return
        await journal.rollbackProjection?.()
        await lease.rollbackIntent()
        journal.restored = true
      },
      onCommit: async (_lease, _result, authority) => { onCommitted?.(authority.revision) },
    }).catch(error => {
      if (!journal.recorded) {
        if (isXpanelError(error)) return fail(error.code, error.message, { ...error.detail, stateChanged: false })
        throw error
      }
      return fail('SERVICE_UNAVAILABLE', resource + ' configuration requires verification', {
        reason: resource + '_state_unverified', stateChanged: !journal.restored,
        verificationRequired: true, ...(!journal.restored && { unknownOutcome: true }),
      })
    })
  }

  private withDomainMutation<T>(opts: DomainMutationOptions | undefined,
    fn: (lease: WriterLease, journal: MutationJournal) => Promise<T>): Promise<T> {
    return this.withJournaledMutation(opts, 'domain', opts?.domainGuard?.onCommitted, fn)
  }

  private withDatabaseMutation<T>(opts: DatabaseMutationOptions | undefined,
    fn: (lease: WriterLease, journal: MutationJournal) => Promise<T>): Promise<T> {
    return this.withJournaledMutation(opts, 'database', opts?.onCommitted, fn)
  }

  private async authorizeDomainMutation(opts: DomainMutationOptions | undefined, account: StoredAccount, current: Domain | null): Promise<DomainWorkspaceRead> {
    const guard = opts?.domainGuard
    if (guard) {
      if (guard.accountId !== account.id) fail('FORBIDDEN', 'domain scope is unavailable', { stateChanged: false })
      await guard.authorize(toPublicAccount(account), current)
    }
    const workspace = await this.domainWorkspaceUnlocked(account.id)
    if (guard && assertDomainWorkspaceRevision(guard.expectedRevision) !== workspace.revision) {
      fail('CONFLICT', 'domain workspace changed; reload before retrying', { stateChanged: false })
    }
    return workspace
  }

  private async prepareDomainMutation(lease: WriterLease, journal: MutationJournal, opts: DomainMutationOptions | undefined,
    account: StoredAccount, before: Domain[], after: Domain[], extraPaths: string[] = []): Promise<(() => Promise<void>) | undefined> {
    const transition: DomainWorkspaceTransition = { account: toPublicAccount(account), before, after,
      affectedIds: [...new Set([...before, ...after].map(domain => domain.id))] }
    const projection = await opts?.domainGuard?.prepareProjection?.(transition)
    const paths = [...new Set([...before, ...after].map(domain => join(this.accountDir(account.username), 'domains', `${domain.name}.json`)).concat(extraPaths))]
    const backups: { relPath: string; existed: boolean; contentBase64?: string }[] = []
    for (const file of paths) {
      const relPath = relative(this.rootDir, file).replaceAll('\\', '/')
      try {
        const stat = await lstat(file)
        if (!stat.isFile() || stat.isSymbolicLink()) fail('PRECONDITION_FAILED', 'domain configuration requires review', { stateChanged: false })
        const bytes = await readFile(file)
        const expected = before.find(domain => file === join(this.accountDir(account.username), 'domains', `${domain.name}.json`))
        if (expected) {
          const raw = JSON.parse(bytes.toString('utf8'))
          if (raw.id !== expected.id || raw.accountId !== account.id || raw.name !== expected.name) fail('PRECONDITION_FAILED', 'domain source requires review', { stateChanged: false })
        } else if (after.some(domain => file === join(this.accountDir(account.username), 'domains', `${domain.name}.json`))) {
          fail('CONFLICT', 'domain source already exists', { stateChanged: false })
        }
        backups.push({ relPath, existed: true, contentBase64: bytes.toString('base64') })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        if (before.some(domain => file === join(this.accountDir(account.username), 'domains', `${domain.name}.json`))) fail('PRECONDITION_FAILED', 'domain source is missing', { stateChanged: false })
        backups.push({ relPath, existed: false })
      }
    }
    journal.rollbackProjection = projection?.rollback
    // Mark before publication: an uncertain journal rename must retain unknown outcome.
    journal.recorded = true
    await lease.recordIntent({ op: 'domainWorkspace', createdRelPaths: [], backups })
    return projection?.apply
  }

  createDomain(input: NewDomain, opts?: DomainMutationOptions): Promise<Domain> {
    return this.withDomainMutation(opts, async (lease, journal) => {
      if (typeof input !== 'object' || input === null) fail('VALIDATION', 'domain must be an object')
      const kind = oneOf(input.kind, KINDS, 'kind')
      if (kind === 'primary') fail('VALIDATION', 'the primary domain is created with the account; rename it instead')
      const capKey = CAP_OF[kind as Exclude<DomainKind, 'primary'>]
      const name = validateDomainName(input.name)
      const parentId = assertIdOrNull(input.parentId, 'parentId')
      if ((kind === 'addon') !== (parentId === null)) fail('VALIDATION', `${kind} domains ${kind === 'addon' ? 'have no' : 'need a'} parent`)

      const account = await this.lockStoredAccount(input.accountId)
      await this.authorizeDomainMutation(opts, account, null)
      const plan = mustExist(await this.getPlan(account.planId), 'plan', account.planId)
      const counts = await this.countDomainsByKind(account.id)
      assertCapAvailable(plan, { [capKey]: counts[kind] }, capKey)

      const allDomains = await this.readAllDomainsUnlocked()
      let docRoot = input.docRoot
      let inheritedRuntime: Pick<Domain, 'siteType' | 'upstream' | 'redirect' | 'php'> | undefined
      if (parentId !== null) {
        const parent = mustExist(allDomains.find((d) => d.id === parentId), 'parent domain', parentId)
        if (parent.accountId !== account.id) fail('FORBIDDEN', 'parent domain belongs to another account')
        if (kind === 'alias') {
          assertAliasTarget(account.id, parent)
          const resolved = validateDomainFile(
            { ...input, id: randomUUID(), accountId: account.id, name, kind: 'addon', parentId: null },
            { account, plan, reservedLoopbackPorts: new Set() },
          ).docRoot
          if (resolved !== parent.docRoot) {
            fail('VALIDATION', 'an alias uses the document root of the domain it points at', { docRoot: parent.docRoot })
          }
          docRoot = parent.docRoot
          if (opts?.domainGuard?.safeLeaf) inheritedRuntime = { siteType: parent.siteType, upstream: parent.upstream, redirect: parent.redirect, php: parent.php }
        }
        if (kind === 'subdomain' && !name.endsWith(`.${parent.name}`)) {
          fail('VALIDATION', `subdomain must end with .${parent.name}`)
        }
      }
      await this.assertDomainNameFree(name, account.id)
      const certificateId = await this.assertCertificateOwned(input.certificateId, account.id)
      const server = await this.readServerFile()
      const reserved = new Set<number>(
        server ? [server.settings.panelPort, server.settings.sshPort, server.settings.backendPort, server.settings.backendTlsPort] : [],
      )
      const domain = validateDomainFile(
        {
          ...input,
          ...inheritedRuntime,
          id: randomUUID(),
          accountId: account.id,
          name,
          kind,
          parentId,
          docRoot,
          certificateId,
        },
        { account, plan, reservedLoopbackPorts: reserved },
      )
      if (domain.ipv4 != null) assertIpAssignableToDomain(domain.ipv4, { expectedVersion: 4, account })
      if (domain.ipv6 != null) assertIpAssignableToDomain(domain.ipv6, { expectedVersion: 6, account })
      const applyProjection = await this.prepareDomainMutation(lease, journal, opts, account, [], [domain])
      await this.writeStateJson(lease, join(this.accountDir(account.username), 'domains', `${domain.name}.json`), domain)
      await applyProjection?.()
      return domain
    })
  }

  async getDomain(id: Id): Promise<Domain | null> {
    if (!isUuid(id)) return null
    const did = id.toLowerCase()
    return (await this.readAllDomainsUnlocked()).find((d) => d.id === did) ?? null
  }

  async getDomainByName(name: string): Promise<Domain | null> {
    if (typeof name !== 'string' || name.length > 253) return null
    const lower = name.toLowerCase()
    return (await this.readAllDomainsUnlocked()).find((d) => d.name.toLowerCase() === lower) ?? null
  }

  async listDomains(f: { accountId?: Id; kind?: DomainKind } = {}): Promise<Domain[]> {
    const accountId = f.accountId === undefined ? undefined : assertId(f.accountId, 'accountId')
    const kind = f.kind === undefined ? undefined : oneOf(f.kind, KINDS, 'kind')
    return (await this.readAllDomainsUnlocked()).filter(
      (d) => (accountId === undefined || d.accountId === accountId) && (kind === undefined || d.kind === kind),
    )
  }

  updateDomain(id: Id, patch: DomainPatch, opts?: DomainMutationOptions): Promise<Domain> {
    return this.withDomainMutation(opts, async (lease, journal) => {
      if (typeof patch !== 'object' || patch === null) fail('VALIDATION', 'domain patch must be an object')
      const did = assertId(id, 'id')
      const allDomains = await this.readAllDomainsUnlocked()
      const current = mustExist(allDomains.find((d) => d.id === did), 'domain', id)
      const account = await this.lockStoredAccount(current.accountId)
      await this.authorizeDomainMutation(opts, account, current)
      const plan = mustExist(await this.getPlan(account.planId), 'plan', account.planId)
      if (patch.docRoot !== undefined && current.kind === 'alias') {
        fail('VALIDATION', 'an alias uses the document root of the domain it points at')
      }
      const certificateId =
        patch.certificateId !== undefined ? await this.assertCertificateOwned(patch.certificateId, account.id) : current.certificateId
      const server = await this.readServerFile()
      const reserved = new Set<number>(
        server ? [server.settings.panelPort, server.settings.sshPort, server.settings.backendPort, server.settings.backendTlsPort] : [],
      )
      const next = validateDomainFile(
        {
          ...current,
          ...patch,
          id: current.id,
          accountId: current.accountId,
          name: current.name,
          kind: current.kind,
          parentId: current.parentId,
          certificateId,
        },
        { account, plan, reservedLoopbackPorts: reserved },
      )
      if (next.ipv4 !== current.ipv4 || next.ipv6 !== current.ipv6) {
        this.assertDomainIpRelease({ ipv4: next.ipv4 === current.ipv4 ? null : current.ipv4, ipv6: next.ipv6 === current.ipv6 ? null : current.ipv6 }, account, await this.readIpPoolFile(), true)
      }
      if (next.ipv4 != null) assertIpAssignableToDomain(next.ipv4, { expectedVersion: 4, account })
      if (next.ipv6 != null) assertIpAssignableToDomain(next.ipv6, { expectedVersion: 6, account })
      const aliases = patch.docRoot !== undefined && next.docRoot !== current.docRoot
        ? allDomains.filter(d => d.accountId === account.id && d.parentId === current.id && d.kind === 'alias') : []
      const updatedAliases = aliases.map(alias => ({ ...alias, docRoot: next.docRoot }))
      const applyProjection = await this.prepareDomainMutation(lease, journal, opts, account, [current, ...aliases], [next, ...updatedAliases])
      await this.writeStateJson(lease, join(this.accountDir(account.username), 'domains', `${next.name}.json`), next)
      if (patch.docRoot !== undefined && next.docRoot !== current.docRoot) {
        for (const alias of aliases) {
          const updatedAlias: Domain = { ...alias, docRoot: next.docRoot }
          await this.writeStateJson(lease, join(this.accountDir(account.username), 'domains', `${alias.name}.json`), updatedAlias)
        }
      }
      await applyProjection?.()
      return next
    })
  }

  renameDomain(id: Id, newName: string, opts?: MutationOptions): Promise<Domain> {
    return this.withMutationLock(opts, async (lease) => {
      const name = validateDomainName(newName)
      const did = assertId(id, 'id')
      const allDomains = await this.readAllDomainsUnlocked()
      const current = mustExist(allDomains.find((d) => d.id === did), 'domain', id)
      const account = await this.lockStoredAccount(current.accountId)
      if (name === current.name) return current
      if (current.kind === 'subdomain') {
        const parent = mustExist(allDomains.find((d) => d.id === current.parentId), 'parent domain', current.parentId)
        if (!name.endsWith(`.${parent.name}`)) fail('VALIDATION', `subdomain must end with .${parent.name}`)
      }

      let moves: { id: Id; from: string; to: string }[]
      if (current.kind === 'primary') {
        const r = canRenamePrimary(toPublicAccount(account), name, allDomains)
        if (!r.ok) {
          return fail(account.status === 'active' ? 'CONFLICT' : 'PRECONDITION_FAILED', `cannot rename: ${r.reasons.join('; ')}`, {
            reasons: r.reasons,
          })
        }
        moves = [
          { id: current.id, from: current.name, to: name },
          ...r.subdomainRenames.map((m) => ({ id: m.id, from: m.from, to: m.to })),
        ]
      } else {
        const old = current.name
        const moving = allDomains.filter((d) => d.accountId === account.id && d.kind === 'subdomain' && d.name.endsWith(`.${old}`))
        const ignore = new Set([current.id, ...moving.map((d) => d.id)])
        moves = [
          { id: current.id, from: old, to: name },
          ...moving.map((d) => ({ id: d.id, from: d.name, to: `${d.name.slice(0, -old.length)}${name}` })),
        ]
        for (const m of moves) await this.assertDomainNameFree(validateDomainName(m.to), account.id, ignore)
      }

      const domDir = join(this.accountDir(account.username), 'domains')
      const byId = new Map(allDomains.map((d) => [d.id, d]))
      const toRemove = new Set(moves.map((m) => m.from))
      for (const m of moves) {
        toRemove.delete(m.to)
        const dom = mustExist(byId.get(m.id), 'domain', m.id)
        await this.writeStateJson(lease, join(domDir, `${m.to}.json`), { ...dom, name: m.to })
      }
      for (const oldFile of toRemove) {
        await this.removeStatePath(lease, join(domDir, `${oldFile}.json`))
      }
      if (current.kind === 'primary') {
        await this.writeStateJson(lease, join(this.accountDir(account.username), 'account.json'), { ...account, primaryDomain: name })
      }
      // Update any service users whose domain was renamed
      const domainsById = new Map(
        allDomains.map((d) => {
          const mv = moves.find((m) => m.id === d.id)
          return [d.id, mv ? { ...d, name: mv.to } : d]
        }),
      )
      const plan = mustExist(await this.getPlan(account.planId), 'plan', account.planId)
      const userFiles = await listJsonFiles(join(this.accountDir(account.username), 'users'))
      for (const uf of userFiles) {
        const u = validateServiceUserFile(await readJsonIfExists(uf), { account, plan, domainsById })
        await this.writeStateJson(lease, uf, u)
      }
      return { ...current, name }
    })
  }

  deleteDomain(id: Id, opts?: DomainMutationOptions): Promise<boolean> {
    return this.withDomainMutation(opts, async (lease, journal) => {
      if (!isUuid(id)) return false
      const did = id.toLowerCase()
      const allDomains = await this.readAllDomainsUnlocked()
      const current = allDomains.find((d) => d.id === did)
      if (!current) {
        if (opts?.domainGuard) fail('CONFLICT', 'domain no longer exists; reload before retrying', { stateChanged: false })
        return false
      }
      const account = mustExist(await this.findStoredAccountById(current.accountId), 'account', current.accountId)
      const workspace = await this.authorizeDomainMutation(opts, account, current)
      if (current.kind === 'primary') fail('PRECONDITION_FAILED', 'the primary domain is removed only with its account', { stateChanged: false })
      if (opts?.domainGuard?.safeLeaf) {
        const dependency = workspace.source.dependencies.find(item => item.domainId === current.id)!
        if (dependency.childCount || dependency.serviceUserCount) fail('PRECONDITION_FAILED', 'remove dependent domains and service users first', { stateChanged: false, reason: 'domain_dependencies' })
      }
      const toDelete = new Set<Id>([current.id])
      let added = true
      while (added) {
        added = false
        for (const d of allDomains) {
          if (d.accountId === account.id && d.parentId && toDelete.has(d.parentId) && !toDelete.has(d.id)) {
            toDelete.add(d.id)
            added = true
          }
        }
      }
      const pool = await this.readIpPoolFile()
      const removing = allDomains.filter(domain => domain.accountId === account.id && toDelete.has(domain.id))
      for (const domain of removing) this.assertDomainIpRelease(domain, account, pool, true)
      const names = new Set(removing.map(domain => domain.name))
      const userFiles: string[] = []
      for (const file of await listJsonFiles(join(this.accountDir(account.username), 'users'))) {
        const raw = await readJsonIfExists<{ domainId?: string; login?: string }>(file)
        if ((raw?.domainId && toDelete.has(raw.domainId)) || (raw?.login && names.has(raw.login.slice(raw.login.lastIndexOf('@') + 1).toLowerCase()))) userFiles.push(file)
      }
      const userdata = removing.map(domain => join(this.accountDir(account.username), 'userdata', `${domain.id}.json`))
      const applyProjection = await this.prepareDomainMutation(lease, journal, opts, account, removing, [], [...userdata, ...userFiles])
      for (const d of removing) {
        await this.removeStatePath(lease, join(this.accountDir(account.username), 'domains', `${d.name}.json`))
        await this.removeStatePath(lease, join(this.accountDir(account.username), 'userdata', `${d.id}.json`))
      }
      for (const file of userFiles) await this.removeStatePath(lease, file)
      await applyProjection?.()
      return true
    })
  }

  // ---------------------------------------------------------------- service users

  private async readAllServiceUsersUnlocked(): Promise<StoredServiceUser[]> {
    const [accounts, plans, domains] = await Promise.all([
      this.readAllAccountsUnlocked(),
      this.readPlanFiles(),
      this.readAllDomainsUnlocked(),
    ])
    const plansById = new Map(plans.map((p) => [p.id, p]))
    const domainsById = new Map(domains.map((d) => [d.id, d]))
    const out: StoredServiceUser[] = []
    for (const account of accounts) {
      const plan = mustExist(plansById.get(account.planId), 'plan', account.planId)
      const files = await listJsonFiles(join(this.accountDir(account.username), 'users'))
      for (const f of files) {
        out.push(validateServiceUserFile(await readJsonIfExists(f), { account, plan, domainsById }))
      }
    }
    return out.sort((a, b) => a.login.localeCompare(b.login))
  }

  private assertServiceCaps(
    existing: StoredServiceUser[],
    plan: Plan,
    next: ServiceUser['services'],
    before: ServiceUser['services'] | null,
  ): void {
    const caps: { service: 'email' | 'ftp'; cap: PlanCapKey }[] = [
      { service: 'email', cap: 'mailboxes' },
      { service: 'ftp', cap: 'ftpAccounts' },
    ]
    for (const { service, cap } of caps) {
      if (!next[service] || before?.[service]) continue
      const count = existing.filter((u) => u.services[service]).length
      assertCapAvailable(plan, { [cap]: count }, cap)
    }
  }

  createServiceUser(input: NewServiceUser, opts?: MutationOptions): Promise<ServiceUser> {
    return this.withMutationLock(opts, async (lease) => {
      if (typeof input !== 'object' || input === null) fail('VALIDATION', 'service user must be an object')
      const { local, domain: domainName } = parseServiceLogin(input.login)
      const passwordHash = assertServiceHash(input.passwordHash)
      const ftpDir = assertRelPath(input.ftpDir, 'ftpDir')
      const account = await this.lockStoredAccount(input.accountId)
      const plan = mustExist(await this.getPlan(account.planId), 'plan', account.planId)
      const allDomains = (await this.readAllDomainsUnlocked()).filter((d) => d.accountId === account.id)
      const domain = allDomains.find((d) => d.name.toLowerCase() === domainName)
      if (!domain) return fail('VALIDATION', 'login domain is not a domain of this account', { domain: domainName })

      const existing = (await this.readAllServiceUsersUnlocked()).filter((u) => u.accountId === account.id)
      if (existing.some((u) => u.domainId === domain.id && u.localPart === local)) {
        fail('CONFLICT', `service user "${local}@${domain.name}" already exists`, { login: `${local}@${domain.name}` })
      }
      const domainsById = new Map(allDomains.map((d) => [d.id, d]))
      const stored = validateServiceUserFile(
        {
          id: randomUUID(),
          accountId: account.id,
          domainId: domain.id,
          localPart: local,
          login: `${local}@${domain.name}`,
          passwordHash,
          services: input.services,
          mailboxQuotaMb: input.mailboxQuotaMb,
          ftpDir,
        },
        { account, plan, domainsById },
      )
      this.assertServiceCaps(existing, plan, stored.services, null)
      await this.writeStateJson(lease, join(this.accountDir(account.username), 'users', `${stored.id}.json`), stored)
      return toPublicServiceUser(stored)
    })
  }

  async getServiceUser(id: Id): Promise<ServiceUser | null> {
    if (!isUuid(id)) return null
    const uid = id.toLowerCase()
    const found = (await this.readAllServiceUsersUnlocked()).find((u) => u.id === uid)
    return found ? toPublicServiceUser(found) : null
  }

  async getServiceUserByLogin(login: string): Promise<ServiceUser | null> {
    let parsed: { local: string; domain: string }
    try {
      parsed = parseServiceLogin(login)
    } catch {
      return null
    }
    const canonical = `${parsed.local}@${parsed.domain}`
    const found = (await this.readAllServiceUsersUnlocked()).find((u) => u.login.toLowerCase() === canonical)
    return found ? toPublicServiceUser(found) : null
  }

  async getServiceUserHash(id: Id): Promise<string | null> {
    if (!isUuid(id)) return null
    const uid = id.toLowerCase()
    const found = (await this.readAllServiceUsersUnlocked()).find((u) => u.id === uid)
    return found?.passwordHash ?? null
  }

  async listServiceUsers(accountId: Id): Promise<ServiceUser[]> {
    if (!isUuid(accountId)) return []
    const aid = accountId.toLowerCase()
    return (await this.readAllServiceUsersUnlocked()).filter((u) => u.accountId === aid).map(toPublicServiceUser)
  }

  /** Service users for one account. Reads that account's users directory and does not scan other accounts. */
  async listOwnedServiceUsers(username: string): Promise<ServiceUser[]> {
    if (typeof username !== 'string' || !/^[a-z][a-z0-9]{1,15}$/.test(username)) return []
    this.assertNotReentrant()
    return this.mutex.run(() => this.runOperation(async () => {
      const rawAcc = await readJsonIfExists<unknown>(join(this.accountDir(username), 'account.json'))
      if (rawAcc === null) return []
      const account = validateAccountFile(rawAcc)
      const plan = await this.getPlan(account.planId)
      if (!plan) return []
      const server = await this.readServerFile()
      const reservedPorts = new Set<number>(server
        ? [server.settings.panelPort, server.settings.sshPort, server.settings.backendPort, server.settings.backendTlsPort]
        : [])
      const domainsById = new Map<string, Domain>()
      for (const file of await listJsonFiles(join(this.accountDir(username), 'domains'))) {
        const raw = await readJsonIfExists<unknown>(file)
        if (raw === null) continue
        const domain = validateDomainFile(raw, { account, plan, reservedLoopbackPorts: reservedPorts })
        domainsById.set(domain.id, domain)
      }
      const users: ServiceUser[] = []
      for (const file of await listJsonFiles(join(this.accountDir(username), 'users'))) {
        const raw = await readJsonIfExists<unknown>(file)
        if (raw === null) continue
        users.push(toPublicServiceUser(validateServiceUserFile(raw, { account, plan, domainsById })))
      }
      return users
    }))
  }

  updateServiceUser(id: Id, patch: ServiceUserPatch, opts?: MutationOptions): Promise<ServiceUser> {
    return this.withMutationLock(opts, async (lease) => {
      if (typeof patch !== 'object' || patch === null) fail('VALIDATION', 'service user patch must be an object')
      const uid = assertId(id, 'id')
      const allUsers = await this.readAllServiceUsersUnlocked()
      const current = mustExist(allUsers.find((u) => u.id === uid), 'service user', id)
      const account = await this.lockStoredAccount(current.accountId)
      const plan = mustExist(await this.getPlan(account.planId), 'plan', account.planId)
      const allDomains = (await this.readAllDomainsUnlocked()).filter((d) => d.accountId === account.id)
      const domainsById = new Map(allDomains.map((d) => [d.id, d]))
      const next = validateServiceUserFile(
        {
          ...current,
          ...(patch.services !== undefined && { services: patch.services }),
          ...(patch.mailboxQuotaMb !== undefined && { mailboxQuotaMb: patch.mailboxQuotaMb }),
          ...(patch.ftpDir !== undefined && { ftpDir: patch.ftpDir }),
          ...(patch.passwordHash !== undefined && { passwordHash: patch.passwordHash }),
        },
        { account, plan, domainsById },
      )
      if (patch.services !== undefined) {
        const accountUsers = allUsers.filter((u) => u.accountId === account.id)
        this.assertServiceCaps(accountUsers, plan, next.services, current.services)
      }
      await this.writeStateJson(lease, join(this.accountDir(account.username), 'users', `${current.id}.json`), next)
      return toPublicServiceUser(next)
    })
  }

  deleteServiceUser(id: Id, opts?: MutationOptions): Promise<boolean> {
    return this.withMutationLock(opts, async (lease) => {
      if (!isUuid(id)) return false
      const uid = id.toLowerCase()
      const current = (await this.readAllServiceUsersUnlocked()).find((u) => u.id === uid)
      if (!current) return false
      const account = mustExist(await this.findStoredAccountById(current.accountId), 'account', current.accountId)
      return this.removeStatePath(lease, join(this.accountDir(account.username), 'users', `${current.id}.json`))
    })
  }

  // ---------------------------------------------------------------- databases & database users

  private async readAllDatabasesUnlocked(): Promise<{ db: Database; username: string }[]> {
    const accounts = await this.readAllAccountsUnlocked()
    const out: { db: Database; username: string }[] = []
    for (const account of accounts) {
      const files = await listJsonFiles(join(this.accountDir(account.username), 'databases'))
      for (const f of files) {
        out.push({ db: validateDatabaseFile(await readJsonIfExists(f), account), username: account.username })
      }
    }
    return out.sort((a, b) => a.db.name.localeCompare(b.db.name))
  }

  private async readAllDatabaseUsersUnlocked(): Promise<{ user: StoredDatabaseUser; username: string }[]> {
    const [accounts, dbs] = await Promise.all([this.readAllAccountsUnlocked(), this.readAllDatabasesUnlocked()])
    const dbsById = new Map(dbs.map((x) => [x.db.id, x.db]))
    const out: { user: StoredDatabaseUser; username: string }[] = []
    for (const account of accounts) {
      const files = await listJsonFiles(join(this.accountDir(account.username), 'db-users'))
      for (const f of files) {
        out.push({
          user: validateDatabaseUserFile(await readJsonIfExists(f), { account, databasesById: dbsById }),
          username: account.username,
        })
      }
    }
    return out.sort((a, b) => a.user.name.localeCompare(b.user.name))
  }

  private async prepareDatabaseCreationIntent(lease: WriterLease, journal: MutationJournal,
    opts: DatabaseMutationOptions | undefined, file: string): Promise<void> {
    try {
      await lstat(file)
      return fail('PRECONDITION_FAILED', 'database configuration path already exists', { stateChanged: false })
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    opts?.onMutationStarted?.()
    journal.recorded = true
    await lease.recordIntent({ op: 'databaseWorkspaceCreate', createdRelPaths: [],
      backups: [{ relPath: relative(this.rootDir, file).replaceAll('\\', '/'), existed: false }] })
  }

  createDatabase(input: { accountId: Id; name: string }, opts?: DatabaseMutationOptions): Promise<Database> {
    return this.withDatabaseMutation(opts, async (lease, journal) => {
      const account = await this.lockStoredAccount(input.accountId)
      await opts?.authorize?.(toPublicAccount(account))
      const name = assertDbNameOwned(account.username, input.name)
      const plan = mustExist(await this.getPlan(account.planId), 'plan', account.planId)
      const allDbs = await this.readAllDatabasesUnlocked()
      if (allDbs.some((x) => x.db.name === name)) {
        fail('CONFLICT', `database "${name}" already exists`, { name })
      }
      const liveCount = allDbs.filter((x) => x.db.accountId === account.id && x.db.trashedAt === null).length
      assertCapAvailable(plan, { databases: liveCount + await this.livePostgresqlDatabases(account) }, 'databases')
      const db: Database = {
        id: randomUUID(),
        accountId: account.id,
        engine: 'mariadb',
        name,
        trashedAt: null,
      }
      const projection = await opts?.prepareIndex?.(toPublicAccount(account), db)
      journal.rollbackProjection = projection?.rollback
      const file = join(this.accountDir(account.username), 'databases', `${db.name}.json`)
      await this.prepareDatabaseCreationIntent(lease, journal, opts, file)
      await this.writeStateJson(lease, file, db)
      await projection?.apply()
      return db
    })
  }

  async getDatabase(id: Id): Promise<Database | null> {
    if (!isUuid(id)) return null
    const did = id.toLowerCase()
    return (await this.readAllDatabasesUnlocked()).find((x) => x.db.id === did)?.db ?? null
  }

  /** Reads one account's database metadata under a lease without scanning other accounts. */
  async readAccountDatabases(id: Id, hint?: { username: string; includeTrashed?: boolean }): Promise<{
    databases: Database[]
    databaseUsers: DatabaseUser[]
  }> {
    this.assertNotReentrant()
    return this.mutex.run(() => this.runOperation(async () => {
      const lease = await this.writerLock.acquire()
      try {
        await lease.assertFencingToken()
        const linked = await this.getAccount(id, hint)
        if (!linked) {
          await lease.assertFencingToken()
          return { databases: [], databaseUsers: [] }
        }
        const account = validateAccountFile(await readJsonIfExists(join(this.accountDir(linked.username), 'account.json')))
        if (account.id !== linked.id || account.username !== linked.username) {
          fail('VALIDATION', 'database workspace account identity mismatch')
        }
        const databases: Database[] = []
        for (const file of await listJsonFiles(join(this.accountDir(account.username), 'databases'))) {
          databases.push(validateDatabaseFile(await readJsonIfExists(file), account))
        }
        const databasesById = new Map(databases.map(database => [database.id, database]))
        const databaseUsers: DatabaseUser[] = []
        for (const file of await listJsonFiles(join(this.accountDir(account.username), 'db-users'))) {
          databaseUsers.push(toPublicDatabaseUser(validateDatabaseUserFile(await readJsonIfExists(file), { account, databasesById })))
        }
        await lease.assertFencingToken()
        return {
          databases: databases.filter(database => hint?.includeTrashed || database.trashedAt === null).sort((a, b) => a.name.localeCompare(b.name)),
          databaseUsers: databaseUsers.sort((a, b) => a.name.localeCompare(b.name)),
        }
      } finally {
        await lease.release()
      }
    }))
  }

  private async databaseRemoteAccessUnlocked(accountId: Id): Promise<DatabaseRemoteAccessSnapshot> {
    const account = await this.lockStoredAccount(accountId)
    if (account.status !== 'active') fail('PRECONDITION_FAILED', 'an active account is required', { stateChanged: false })
    const databases: Database[] = []
    for (const file of await listJsonFiles(join(this.accountDir(account.username), 'databases'))) {
      databases.push(validateDatabaseFile(await readJsonIfExists(file), account))
    }
    const databasesById = new Map(databases.map(database => [database.id, database]))
    const users: StoredDatabaseUser[] = []
    for (const file of await listJsonFiles(join(this.accountDir(account.username), 'db-users'))) {
      users.push(validateDatabaseUserFile(await readJsonIfExists(file), { account, databasesById }))
    }
    return { account: toPublicAccount(account), databases: databases.sort((a, b) => a.name.localeCompare(b.name)), users: users.sort((a, b) => a.name.localeCompare(b.name)) }
  }

  /** Private service snapshot; stored authentication data must never be projected to an HTTP view. */
  async readDatabaseRemoteAccess(accountId: Id): Promise<DatabaseRemoteAccessSnapshot> {
    this.assertNotReentrant()
    return this.mutex.run(() => this.runOperation(async () => {
      const lease = await this.writerLock.acquire()
      try {
        const snapshot = await this.databaseRemoteAccessUnlocked(assertId(accountId))
        await lease.assertFencingToken()
        return snapshot
      } finally { await lease.release() }
    }))
  }

  /** One canonical account preimage and native compensation share the same fenced writer lease. */
  async withDatabaseRemoteAccessLease<T>(accountId: Id, expectedRevision: string,
    callback: (snapshot: DatabaseRemoteAccessSnapshot, tx: DatabaseRemoteAccessTransaction) => Promise<T>): Promise<T> {
    if (!/^[0-9a-f]{64}$/.test(expectedRevision)) fail('VALIDATION', 'a current remote-access revision is required', { stateChanged: false })
    let restore: (() => Promise<void>) | undefined
    let intent = false
    let committed = false
    let writeStarted = false
    let externalChange = false
    let published: Awaited<ReturnType<typeof pinnedAccountPreimage>> | undefined
    let accountPath = ''
    return this.withMutationLock(undefined, async lease => {
      const snapshot = await this.databaseRemoteAccessUnlocked(assertId(accountId))
      if (databaseRemoteAccessRevision(snapshot) !== expectedRevision) fail('CONFLICT', 'database remote access changed; reload before saving', { stateChanged: false })
      const relPath = `accounts/${snapshot.account.username}/account.json`
      accountPath = this.path(relPath)
      const preimage = await pinnedAccountPreimage(accountPath)
      const original = JSON.parse(preimage.bytes.toString('utf8')) as Record<string, unknown>
      if (JSON.stringify(toPublicAccount(validateAccountFile(original))) !== JSON.stringify(snapshot.account)) fail('CONFLICT', 'account lifetime changed before remote-access preparation', { stateChanged: false })
      await lease.recordIntent({ op: 'databaseRemoteAccess', createdRelPaths: [], backups: [{ relPath, existed: true, contentBase64: preimage.bytes.toString('base64') }] })
      intent = true
      const result = await callback(snapshot, {
        onAbort: operation => {
          if (restore || committed || typeof operation !== 'function') fail('PRECONDITION_FAILED', 'remote-access recovery must be registered once before effects', { stateChanged: false })
          restore = operation
        },
        commit: async (entries: DatabaseRemoteAccessEntry[]) => {
          if (committed || !restore) fail('PRECONDITION_FAILED', 'remote-access commit requires one registered recovery operation', { stateChanged: false })
          const canonical = parseDatabaseRemoteEntries(entries)
          await lease.assertFencingToken()
          let current: Awaited<ReturnType<typeof pinnedAccountPreimage>>
          try { current = await pinnedAccountPreimage(accountPath) }
          catch (error) { externalChange = true; throw error }
          if (current.identity !== preimage.identity || !current.bytes.equals(preimage.bytes)) {
            externalChange = true
            fail('CONFLICT', 'account source changed outside the remote-access transaction', { stateChanged: false })
          }
          const next = { ...original, databaseRemoteAccess: canonical }
          validateAccountFile(next)
          writeStarted = true
          await this.writeStateJson(lease, accountPath, next)
          try { published = await pinnedAccountPreimage(accountPath) }
          catch (error) { externalChange = true; throw error }
          if (JSON.stringify(JSON.parse(published.bytes.toString('utf8'))) !== JSON.stringify(next)) {
            externalChange = true
            fail('SERVICE_UNAVAILABLE', 'remote-access metadata requires readback review', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
          }
          committed = true
        },
      })
      if (!committed) fail('PRECONDITION_FAILED', 'remote-access transaction did not commit a canonical policy', { stateChanged: false })
      let final: Awaited<ReturnType<typeof pinnedAccountPreimage>>
      try { final = await pinnedAccountPreimage(accountPath) }
      catch (error) { externalChange = true; throw error }
      if (!published || final.identity !== published.identity || !final.bytes.equals(published.bytes)) {
        externalChange = true
        fail('SERVICE_UNAVAILABLE', 'remote-access source changed before acknowledgment', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
      }
      return result
    }, { restoreAuthorityOnAbort: true, onAbort: async lease => {
      if (!intent) return
      if (!externalChange && writeStarted && published) {
        try { const current = await pinnedAccountPreimage(accountPath); externalChange = current.identity !== published.identity || !current.bytes.equals(published.bytes) }
        catch { externalChange = true }
      }
      if (externalChange) {
        const failures: unknown[] = []
        try { await lease.quarantineExternalAccountIntent(relative(this.rootDir, accountPath).replaceAll('\\', '/')) } catch (error) { failures.push(error) }
        try { if (restore) await restore() } catch (error) { failures.push(error) }
        if (failures.length) throw new AggregateError(failures, 'external account source was preserved; native recovery requires review')
        return
      }
      let nativeRecoveryFailure: unknown
      let nativeRecoveryFailed = false
      try { if (restore) await restore() } catch (error) { nativeRecoveryFailed = true; nativeRecoveryFailure = error }
      if (nativeRecoveryFailed) throw nativeRecoveryFailure
      if (!writeStarted) { await lease.rollbackIntent(); return }
      if (published) {
        let current: Awaited<ReturnType<typeof pinnedAccountPreimage>>
        try { current = await pinnedAccountPreimage(accountPath) }
        catch (error) { await lease.quarantineExternalAccountIntent(relative(this.rootDir, accountPath).replaceAll('\\', '/')); throw error }
        if (current.identity !== published.identity || !current.bytes.equals(published.bytes)) {
          await lease.quarantineExternalAccountIntent(relative(this.rootDir, accountPath).replaceAll('\\', '/'), createHash('sha256').update(current.bytes).digest('hex'))
          fail('SERVICE_UNAVAILABLE', 'external account changes were preserved; remote-access recovery requires review', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
        }
      }
      await lease.rollbackIntent()
    } })
  }

  async listDatabases(accountId: Id, opts: { includeTrashed?: boolean } = {}): Promise<Database[]> {
    if (!isUuid(accountId)) return []
    const aid = accountId.toLowerCase()
    return (await this.readAllDatabasesUnlocked())
      .map((x) => x.db)
      .filter((d) => d.accountId === aid && (opts.includeTrashed ? true : d.trashedAt === null))
  }

  private changeDatabaseTrashState(id: Id, action: 'trash' | 'restore', opts?: DatabaseMutationOptions): Promise<Database> {
    return this.withDatabaseMutation(opts, async (lease, journal) => {
      const did = assertId(id, 'id')
      const allDbs = await this.readAllDatabasesUnlocked()
      const entry = mustExist(allDbs.find((x) => x.db.id === did), 'database', id)
      const account = await this.lockStoredAccount(entry.db.accountId)
      await opts?.authorize?.(toPublicAccount(account))
      if (opts?.stateGuard) {
        const guard = parseOwnerDatabaseStateRequest(opts.stateGuard, action)
        if (guard.confirmation !== entry.db.name || guard.expectedTrashedAt !== entry.db.trashedAt) {
          fail('CONFLICT', 'database state changed; reload before retrying', { stateChanged: false })
        }
      }
      if (action === 'trash' ? entry.db.trashedAt !== null : entry.db.trashedAt === null) return entry.db
      if (action === 'restore') {
        const plan = mustExist(await this.getPlan(account.planId), 'plan', account.planId)
        const liveCount = allDbs.filter(x => x.db.accountId === account.id && x.db.trashedAt === null).length
        assertCapAvailable(plan, { databases: liveCount + await this.livePostgresqlDatabases(account) }, 'databases')
      }
      const next: Database = { ...entry.db, trashedAt: action === 'trash' ? new Date().toISOString() : null }
      const projection = await opts?.prepareTransitionIndex?.(toPublicAccount(account), entry.db, next)
      const file = join(this.accountDir(entry.username), 'databases', `${next.name}.json`)
      const stat = await lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink()) fail('PRECONDITION_FAILED', 'database configuration requires review', { stateChanged: false })
      const bytes = await readFile(file)
      const source = JSON.parse(bytes.toString('utf8'))
      if (source.id !== next.id || source.accountId !== account.id || source.name !== next.name || source.trashedAt !== entry.db.trashedAt) {
        fail('PRECONDITION_FAILED', 'database source requires review', { stateChanged: false })
      }
      opts?.onMutationStarted?.()
      journal.rollbackProjection = projection?.rollback
      journal.recorded = true
      await lease.recordIntent({ op: 'databaseWorkspaceState', createdRelPaths: [],
        backups: [{ relPath: relative(this.rootDir, file).replaceAll('\\', '/'), existed: true, contentBase64: bytes.toString('base64') }] })
      await this.writeStateJson(lease, file, next)
      await projection?.apply()
      return next
    })
  }

  trashDatabase(id: Id, opts?: DatabaseMutationOptions): Promise<Database> {
    return this.changeDatabaseTrashState(id, 'trash', opts)
  }

  restoreDatabase(id: Id, opts?: DatabaseMutationOptions): Promise<Database> {
    return this.changeDatabaseTrashState(id, 'restore', opts)
  }

  async listTrashedDatabasesBefore(cutoff: Date): Promise<Database[]> {
    const t = cutoff.getTime()
    return (await this.readAllDatabasesUnlocked())
      .map((x) => x.db)
      .filter((d) => d.trashedAt !== null && new Date(d.trashedAt).getTime() < t)
  }

  purgeDatabase(id: Id, opts?: MutationOptions): Promise<boolean> {
    return this.withMutationLock(opts, async (lease) => {
      if (!isUuid(id)) return false
      const did = id.toLowerCase()
      const entry = (await this.readAllDatabasesUnlocked()).find((x) => x.db.id === did)
      if (!entry) return false
      if (entry.db.trashedAt === null) fail('PRECONDITION_FAILED', 'move the database to the trash first')
      // Remove grants referencing this database from the account's db-users
      const dbUsers = (await this.readAllDatabaseUsersUnlocked()).filter((u) => u.user.accountId === entry.db.accountId)
      for (const u of dbUsers) {
        if (u.user.grants.some((g) => g.databaseId === did)) {
          const updated: StoredDatabaseUser = {
            ...u.user,
            grants: u.user.grants.filter((g) => g.databaseId !== did),
          }
          await this.writeStateJson(lease, join(this.accountDir(u.username), 'db-users', `${u.user.name}.json`), updated)
        }
      }
      return this.removeStatePath(lease, join(this.accountDir(entry.username), 'databases', `${entry.db.name}.json`))
    })
  }

  createDatabaseUser(input: NewDatabaseUser, opts?: DatabaseMutationOptions): Promise<DatabaseUser> {
    return this.withDatabaseMutation(opts, async (lease, journal) => {
      const account = await this.lockStoredAccount(input.accountId)
      await opts?.authorize?.(toPublicAccount(account))
      const owned = assertDbNameOwned(account.username, input.name)
      const name = dbUserName(account.username, owned.slice(account.username.length + 1))
      const auth = assertDbAuth(input.authPlugin, input.authString)
      const allUsers = await this.readAllDatabaseUsersUnlocked()
      if (allUsers.some((u) => u.user.name === name)) {
        fail('CONFLICT', `database user "${name}" already exists`, { name })
      }
      const grants: DatabaseUser['grants'] = []
      if (input.initialGrant !== undefined) {
        if (!input.initialGrant || typeof input.initialGrant !== 'object' || Array.isArray(input.initialGrant)) fail('VALIDATION', 'initial grant must be an object')
        const databaseId = assertId(input.initialGrant.databaseId, 'databaseId')
        const privileges = assertDbPrivileges(input.initialGrant.privileges)
        const target = mustExist(await this.getDatabase(databaseId), 'database', databaseId)
        if (target.accountId !== account.id) fail('FORBIDDEN', 'database belongs to another account')
        if (target.trashedAt !== null) fail('PRECONDITION_FAILED', 'database is in the trash')
        grants.push({ databaseId, privileges })
      }
      const stored: StoredDatabaseUser = {
        id: randomUUID(),
        accountId: account.id,
        name,
        ...auth,
        grants,
      }
      const file = join(this.accountDir(account.username), 'db-users', `${stored.name}.json`)
      await this.prepareDatabaseCreationIntent(lease, journal, opts, file)
      await this.writeStateJson(lease, file, stored)
      return toPublicDatabaseUser(stored)
    })
  }

  async getDatabaseUser(id: Id): Promise<DatabaseUser | null> {
    if (!isUuid(id)) return null
    const uid = id.toLowerCase()
    const entry = (await this.readAllDatabaseUsersUnlocked()).find((x) => x.user.id === uid)
    return entry ? toPublicDatabaseUser(entry.user) : null
  }

  async listDatabaseUsers(accountId: Id): Promise<DatabaseUser[]> {
    if (!isUuid(accountId)) return []
    const aid = accountId.toLowerCase()
    return (await this.readAllDatabaseUsersUnlocked())
      .filter((x) => x.user.accountId === aid)
      .map((x) => toPublicDatabaseUser(x.user))
  }

  setDatabaseUserAuth(
    id: Id,
    authString: string,
    authPlugin?: 'mysql_native_password' | 'ed25519',
    opts?: MutationOptions,
  ): Promise<void> {
    return this.withMutationLock(opts, async (lease) => {
      const uid = assertId(id, 'id')
      const auth = assertDbAuth(authPlugin, authString)
      const entry = mustExist((await this.readAllDatabaseUsersUnlocked()).find((x) => x.user.id === uid), 'database user', id)
      const next: StoredDatabaseUser = { ...entry.user, ...auth }
      await this.writeStateJson(lease, join(this.accountDir(entry.username), 'db-users', `${next.name}.json`), next)
    })
  }

  setGrant(input: { databaseUserId: Id; databaseId: Id; privileges: string[]; expectedPrivileges?: string[] | null }, opts?: DatabaseMutationOptions): Promise<DatabaseUser> {
    return this.withDatabaseMutation(opts, async (lease, journal) => {
      const userId = assertId(input.databaseUserId, 'databaseUserId')
      const databaseId = assertId(input.databaseId, 'databaseId')
      const privileges = assertDbPrivileges(input.privileges)
      const userEntry = mustExist((await this.readAllDatabaseUsersUnlocked()).find((x) => x.user.id === userId), 'database user', userId)
      const account = await this.lockStoredAccount(userEntry.user.accountId)
      await opts?.authorize?.(toPublicAccount(account))
      const target = mustExist(await this.getDatabase(databaseId), 'database', databaseId)
      if (target.accountId !== userEntry.user.accountId) fail('FORBIDDEN', 'database belongs to another account')
      if (target.trashedAt !== null) fail('PRECONDITION_FAILED', 'database is in the trash')
      if (Object.hasOwn(input, 'expectedPrivileges')) {
        const expected = input.expectedPrivileges === null ? null : assertDbPrivileges(input.expectedPrivileges)
        const current = userEntry.user.grants.find(grant => grant.databaseId === databaseId)?.privileges ?? null
        if (JSON.stringify(expected) !== JSON.stringify(current)) {
          fail('CONFLICT', 'database privileges changed; reload before retrying', { stateChanged: false })
        }
      }
      const grants = [
        ...userEntry.user.grants.filter((g) => g.databaseId !== databaseId),
        { databaseId, privileges },
      ].sort((a, b) => a.databaseId.localeCompare(b.databaseId))
      const next: StoredDatabaseUser = { ...userEntry.user, grants }
      const file = join(this.accountDir(userEntry.username), 'db-users', `${next.name}.json`)
      const stat = await lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink()) fail('PRECONDITION_FAILED', 'database user configuration requires review', { stateChanged: false })
      const bytes = await readFile(file)
      const source = JSON.parse(bytes.toString('utf8'))
      if (source.id !== next.id || source.accountId !== account.id || source.name !== next.name) {
        fail('PRECONDITION_FAILED', 'database user source requires review', { stateChanged: false })
      }
      opts?.onMutationStarted?.()
      journal.recorded = true
      await lease.recordIntent({ op: 'databaseWorkspaceGrant', createdRelPaths: [],
        backups: [{ relPath: relative(this.rootDir, file).replaceAll('\\', '/'), existed: true, contentBase64: bytes.toString('base64') }] })
      await this.writeStateJson(lease, file, next)
      return toPublicDatabaseUser(next)
    })
  }

  revokeGrant(databaseUserId: Id, databaseId: Id, opts?: MutationOptions): Promise<boolean> {
    return this.withMutationLock(opts, async (lease) => {
      if (!isUuid(databaseUserId) || !isUuid(databaseId)) return false
      const uid = databaseUserId.toLowerCase()
      const did = databaseId.toLowerCase()
      const userEntry = (await this.readAllDatabaseUsersUnlocked()).find((x) => x.user.id === uid)
      if (!userEntry || !userEntry.user.grants.some((g) => g.databaseId === did)) return false
      const next: StoredDatabaseUser = {
        ...userEntry.user,
        grants: userEntry.user.grants.filter((g) => g.databaseId !== did),
      }
      await this.writeStateJson(lease, join(this.accountDir(userEntry.username), 'db-users', `${next.name}.json`), next)
      return true
    })
  }

  deleteDatabaseUser(id: Id, opts?: MutationOptions): Promise<boolean> {
    return this.withMutationLock(opts, async (lease) => {
      if (!isUuid(id)) return false
      const uid = id.toLowerCase()
      const entry = (await this.readAllDatabaseUsersUnlocked()).find((x) => x.user.id === uid)
      if (!entry) return false
      return this.removeStatePath(lease, join(this.accountDir(entry.username), 'db-users', `${entry.user.name}.json`))
    })
  }

  // ---------------------------------------------------------------- PostgreSQL databases & users

  private postgresqlPath(account: StoredAccount, kind: 'users' | 'databases', name: string): string {
    return join(this.accountDir(account.username), 'postgresql', kind, `${name}.json`)
  }

  private async readAccountPostgresqlUnlocked(account: StoredAccount): Promise<{ databases: Database[]; users: StoredPostgresqlUser[] }> {
    const dir = join(this.accountDir(account.username), 'postgresql')
    const users: StoredPostgresqlUser[] = []
    for (const file of await listJsonFiles(join(dir, 'users'))) users.push(validatePostgresqlUserFile(await readJsonIfExists(file), account))
    const owners = new Set(users.map((user) => user.name))
    const databases: Database[] = []
    for (const file of await listJsonFiles(join(dir, 'databases'))) databases.push(validatePostgresqlDatabaseFile(await readJsonIfExists(file), account, owners))
    return { databases: databases.sort((a, b) => a.name.localeCompare(b.name)), users: users.sort((a, b) => a.name.localeCompare(b.name)) }
  }

  /** Plans cap MariaDB and PostgreSQL databases together; trashed databases do not count. */
  private async livePostgresqlDatabases(account: StoredAccount): Promise<number> {
    return (await this.readAccountPostgresqlUnlocked(account)).databases.filter((database) => database.trashedAt === null).length
  }

  private async liveMariadbDatabases(account: StoredAccount): Promise<number> {
    let count = 0
    for (const file of await listJsonFiles(join(this.accountDir(account.username), 'databases'))) {
      if (validateDatabaseFile(await readJsonIfExists(file), account).trashedAt === null) count++
    }
    return count
  }

  /** One account's PostgreSQL databases (trashed ones included) and users, without verifiers. */
  async readAccountPostgresql(accountId: Id): Promise<{ databases: Database[]; users: PostgresqlUser[] }> {
    this.assertNotReentrant()
    return this.mutex.run(() => this.runOperation(async () => {
      const lease = await this.writerLock.acquire()
      try {
        await lease.assertFencingToken()
        const account = await this.findStoredAccountById(assertId(accountId, 'accountId'))
        const read = account ? await this.readAccountPostgresqlUnlocked(account) : { databases: [], users: [] }
        await lease.assertFencingToken()
        return { databases: read.databases, users: read.users.map(toPublicPostgresqlUser) }
      } finally {
        await lease.release()
      }
    }))
  }

  private async lockPostgresqlAccount(accountId: Id, opts: DatabaseMutationOptions | undefined) {
    const account = await this.lockStoredAccount(accountId)
    await opts?.authorize?.(toPublicAccount(account))
    return { account, ...(await this.readAccountPostgresqlUnlocked(account)) }
  }

  /** One journaled PostgreSQL state file change: `next` writes the file, null removes it. */
  private async commitPostgresqlFile(lease: WriterLease, journal: MutationJournal, opts: DatabaseMutationOptions | undefined,
    file: string, expected: 'absent' | 'present', next: object | null): Promise<void> {
    let bytes: Buffer | null = null
    try {
      const stat = await lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink()) fail('PRECONDITION_FAILED', 'PostgreSQL configuration requires review', { stateChanged: false })
      bytes = await readFile(file)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if ((bytes !== null) !== (expected === 'present')) fail('CONFLICT', 'PostgreSQL configuration changed; reload before retrying', { stateChanged: false })
    opts?.onMutationStarted?.()
    journal.recorded = true
    await lease.recordIntent({ op: 'postgresqlWorkspace', createdRelPaths: [], backups: [{ relPath: relative(this.rootDir, file).replaceAll('\\', '/'),
      existed: bytes !== null, ...(bytes !== null && { contentBase64: bytes.toString('base64') }) }] })
    if (next) await this.writeStateJson(lease, file, next)
    else await this.removeStatePath(lease, file)
  }

  createPostgresqlUser(input: { accountId: Id; name: string; authString: string }, opts?: DatabaseMutationOptions): Promise<PostgresqlUser> {
    return this.withDatabaseMutation(opts, async (lease, journal) => {
      const { account, users } = await this.lockPostgresqlAccount(input.accountId, opts)
      const stored = validatePostgresqlUserFile({ id: randomUUID(), accountId: account.id, name: input.name, authPlugin: 'scram-sha-256', authString: input.authString }, account)
      if (users.some((user) => user.name === stored.name)) fail('CONFLICT', `PostgreSQL user "${stored.name}" already exists`, { name: stored.name, stateChanged: false })
      await this.commitPostgresqlFile(lease, journal, opts, this.postgresqlPath(account, 'users', stored.name), 'absent', stored)
      return toPublicPostgresqlUser(stored)
    })
  }

  setPostgresqlUserPassword(input: { accountId: Id; id: Id; authString: string }, opts?: DatabaseMutationOptions): Promise<PostgresqlUser> {
    return this.withDatabaseMutation(opts, async (lease, journal) => {
      const { account, users } = await this.lockPostgresqlAccount(input.accountId, opts)
      const user = mustExist(users.find((item) => item.id === assertId(input.id, 'id')), 'PostgreSQL user', input.id)
      const next = validatePostgresqlUserFile({ ...user, authString: input.authString }, account)
      await this.commitPostgresqlFile(lease, journal, opts, this.postgresqlPath(account, 'users', user.name), 'present', next)
      return toPublicPostgresqlUser(next)
    })
  }

  /** A user that owns a database (in the trash or not) stays until that database is deleted. */
  deletePostgresqlUser(input: { accountId: Id; id: Id }, opts?: DatabaseMutationOptions): Promise<PostgresqlUser> {
    return this.withDatabaseMutation(opts, async (lease, journal) => {
      const { account, users, databases } = await this.lockPostgresqlAccount(input.accountId, opts)
      const user = mustExist(users.find((item) => item.id === assertId(input.id, 'id')), 'PostgreSQL user', input.id)
      if (databases.some((database) => database.owner === user.name)) fail('PRECONDITION_FAILED', 'delete the PostgreSQL databases this user owns first', { stateChanged: false })
      await this.commitPostgresqlFile(lease, journal, opts, this.postgresqlPath(account, 'users', user.name), 'present', null)
      return toPublicPostgresqlUser(user)
    })
  }

  createPostgresqlDatabase(input: { accountId: Id; name: string; owner: string }, opts?: DatabaseMutationOptions): Promise<Database> {
    return this.withDatabaseMutation(opts, async (lease, journal) => {
      const { account, users, databases } = await this.lockPostgresqlAccount(input.accountId, opts)
      const database = validatePostgresqlDatabaseFile({ id: randomUUID(), accountId: account.id, engine: 'postgresql', name: input.name, owner: input.owner, trashedAt: null },
        account, new Set(users.map((user) => user.name)))
      if (databases.some((item) => item.name === database.name)) fail('CONFLICT', `PostgreSQL database "${database.name}" already exists`, { name: database.name, stateChanged: false })
      const plan = mustExist(await this.getPlan(account.planId), 'plan', account.planId)
      assertCapAvailable(plan, { databases: databases.filter((item) => item.trashedAt === null).length + await this.liveMariadbDatabases(account) }, 'databases')
      await this.commitPostgresqlFile(lease, journal, opts, this.postgresqlPath(account, 'databases', database.name), 'absent', database)
      return database
    })
  }

  setPostgresqlDatabaseTrash(input: { accountId: Id; id: Id; action: 'trash' | 'restore' }, opts?: DatabaseMutationOptions): Promise<Database> {
    return this.withDatabaseMutation(opts, async (lease, journal) => {
      const { account, databases } = await this.lockPostgresqlAccount(input.accountId, opts)
      const database = mustExist(databases.find((item) => item.id === assertId(input.id, 'id')), 'PostgreSQL database', input.id)
      if (opts?.stateGuard) {
        const guard = parseOwnerDatabaseStateRequest(opts.stateGuard, input.action)
        if (guard.confirmation !== database.name || guard.expectedTrashedAt !== database.trashedAt) fail('CONFLICT', 'database state changed; reload before retrying', { stateChanged: false })
      }
      if (input.action === 'trash' ? database.trashedAt !== null : database.trashedAt === null) return database
      if (input.action === 'restore') {
        const plan = mustExist(await this.getPlan(account.planId), 'plan', account.planId)
        assertCapAvailable(plan, { databases: databases.filter((item) => item.trashedAt === null).length + await this.liveMariadbDatabases(account) }, 'databases')
      }
      const next: Database = { ...database, trashedAt: input.action === 'trash' ? new Date().toISOString() : null }
      await this.commitPostgresqlFile(lease, journal, opts, this.postgresqlPath(account, 'databases', database.name), 'present', next)
      return next
    })
  }

  /** Removes a trashed database from desired state; the caller drops it on the server first. */
  purgePostgresqlDatabase(input: { accountId: Id; id: Id }, opts?: DatabaseMutationOptions): Promise<Database> {
    return this.withDatabaseMutation(opts, async (lease, journal) => {
      const { account, databases } = await this.lockPostgresqlAccount(input.accountId, opts)
      const database = mustExist(databases.find((item) => item.id === assertId(input.id, 'id')), 'PostgreSQL database', input.id)
      if (database.trashedAt === null) fail('PRECONDITION_FAILED', 'move the database to the trash first', { stateChanged: false })
      await this.commitPostgresqlFile(lease, journal, opts, this.postgresqlPath(account, 'databases', database.name), 'present', null)
      return database
    })
  }

  // ---------------------------------------------------------------- certificates, DNS zones & cron jobs

  createCertificate(input: NewCertificate, opts?: MutationOptions): Promise<StoredCertificate> {
    return this.withMutationLock(opts, async (lease) => {
      const cert = validateCertificateFile({
        ...input,
        id: input.id ?? randomUUID(),
        challenge: input.challenge ?? null,
        notBefore: input.notBefore ?? null,
        autoRenew: input.autoRenew ?? false,
        chainPath: input.chainPath ?? null,
        fingerprintSha256: input.fingerprintSha256 ?? null,
        lastError: null,
        renewedAt: null,
      })
      if (cert.accountId !== null) mustExist(await this.findStoredAccountById(cert.accountId), 'account', cert.accountId)
      await this.writeStateJson(lease, this.path('certificates', `${cert.id}.json`), cert)
      return cert
    })
  }

  /** Publish validated certificate metadata and its selected domain in one recoverable lease. */
  saveCertificateBinding(input: NewCertificate, domainId: Id, opts?: CertificateMutationOptions): Promise<StoredCertificate> {
    return this.withJournaledMutation(opts, 'certificate', undefined, async (lease, journal) => {
      const cert = validateCertificateFile({ ...input, id: input.id ?? randomUUID(),
        challenge: input.challenge ?? null, notBefore: input.notBefore ?? null, autoRenew: input.autoRenew ?? false,
        chainPath: input.chainPath ?? null, fingerprintSha256: input.fingerprintSha256 ?? null, lastError: null, renewedAt: null })
      if (cert.accountId === null) return fail('VALIDATION', 'an owned certificate is required for a domain binding', { stateChanged: false })
      const account = await this.lockStoredAccount(cert.accountId)
      if (account.status !== 'active') return fail('PRECONDITION_FAILED', 'an active account is required for certificate installation', { stateChanged: false })
      const domains = await this.readAllDomainsUnlocked()
      const domain = domains.find(row => row.id === assertId(domainId, 'domainId') && row.accountId === account.id)
      if (!domain) return fail('NOT_FOUND', 'certificate domain not found', { stateChanged: false })
      const current = await this.getCertificate(cert.id)
      if (current && current.accountId !== account.id) return fail('NOT_FOUND', 'certificate not found', { stateChanged: false })
      const exact = domains.map(row => ({ ...row, wildcard: false }))
      const covers = (name: string): boolean => cert.names.some(candidate => candidate === name
        || (candidate.startsWith('*.') && name.indexOf('.') > 0 && name.slice(name.indexOf('.') + 1) === candidate.slice(2)))
      if (new Set(cert.names).size !== cert.names.length || cert.names.some(name => {
        const owner = name.startsWith('*.') ? exact.find(row => row.name === name.slice(2)) : resolveServingDomain(name, exact)
        return owner?.accountId !== account.id
      })) return fail('FORBIDDEN', 'every certificate name must belong to this account', { stateChanged: false })
      if (!covers(domain.name)) return fail('VALIDATION', 'certificate names do not cover this domain', { stateChanged: false })
      if (current && current.names.some(name => !cert.names.includes(name))) return fail('CONFLICT', 'existing certificate names must be preserved', { stateChanged: false })
      if (domains.some(row => row.certificateId === cert.id && (row.accountId !== account.id || !covers(row.name)))) return fail('CONFLICT', 'existing certificate assignments require review', { stateChanged: false })
      await opts?.certificateGuard?.(current, domains)
      const next = { ...domain, certificateId: cert.id }
      const certFile = this.path('certificates', cert.id + '.json')
      const domainFile = join(this.accountDir(account.username), 'domains', domain.name + '.json')
      await this.prepareCertificateIntent(lease, journal, 'saveCertificateBinding', [
        { file: certFile, current }, { file: domainFile, current: domain },
      ])
      await this.writeStateJson(lease, certFile, cert)
      await this.writeStateJson(lease, domainFile, next)
      if (JSON.stringify(await readJsonIfExists(certFile)) !== JSON.stringify(cert)
        || JSON.stringify(await readJsonIfExists(domainFile)) !== JSON.stringify(next)) throw new Error('certificate_binding_readback_mismatch')
      return cert
    })
  }

  private async prepareCertificateIntent(lease: WriterLease, journal: MutationJournal, op: string,
    files: { file: string; current: { id: Id; accountId: Id | null; name?: string } | null }[]): Promise<void> {
    const backups: { relPath: string; existed: boolean; contentBase64?: string }[] = []
    for (const { file, current } of files) {
      const relPath = relative(this.rootDir, file).replaceAll('\\', '/')
      try {
        const stat = await lstat(file)
        if (!stat.isFile() || stat.isSymbolicLink()) return fail('PRECONDITION_FAILED', 'certificate configuration requires review', { stateChanged: false })
        const bytes = await readFile(file)
        if (!current) return fail('CONFLICT', 'certificate source already exists', { stateChanged: false })
        const raw = JSON.parse(bytes.toString('utf8'))
        if (raw.id !== current.id || raw.accountId !== current.accountId || (current.name !== undefined && raw.name !== current.name)) return fail('PRECONDITION_FAILED', 'certificate source requires review', { stateChanged: false })
        backups.push({ relPath, existed: true, contentBase64: bytes.toString('base64') })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        if (current) return fail('PRECONDITION_FAILED', 'certificate source is missing', { stateChanged: false })
        backups.push({ relPath, existed: false })
      }
    }
    journal.recorded = true
    await lease.recordIntent({ op, createdRelPaths: [], backups })
  }

  async getCertificate(id: Id): Promise<StoredCertificate | null> {
    if (!isUuid(id)) return null
    const raw = await readJsonIfExists<unknown>(this.path('certificates', `${id.toLowerCase()}.json`))
    return raw === null ? null : validateCertificateFile(raw)
  }

  async listCertificates(accountId?: Id | null): Promise<StoredCertificate[]> {
    const aid = accountId === undefined ? undefined : accountId === null ? null : assertId(accountId, 'accountId')
    const all = await this.readCertificateFiles()
    return aid === undefined ? all : all.filter((c) => c.accountId === aid)
  }

  deleteCertificate(id: Id, opts?: CertificateMutationOptions): Promise<boolean> {
    return this.withJournaledMutation(opts, 'certificate', undefined, async (lease, journal) => {
      if (!isUuid(id)) return false
      const cid = id.toLowerCase()
      const [accounts, domains] = await Promise.all([this.readAllAccountsUnlocked(), this.readAllDomainsUnlocked()])
      const current = await this.getCertificate(cid)
      await opts?.certificateGuard?.(current, domains)
      if (!current) return false
      const accById = new Map(accounts.map((a) => [a.id, a]))
      const bound = domains.filter(row => row.certificateId === cid).map(domain => {
        const account = mustExist(accById.get(domain.accountId), 'account', domain.accountId)
        return { domain, file: join(this.accountDir(account.username), 'domains', domain.name + '.json') }
      })
      const certFile = this.path('certificates', cid + '.json')
      await this.prepareCertificateIntent(lease, journal, 'deleteCertificateBindings', [
        { file: certFile, current }, ...bound.map(({ domain, file }) => ({ file, current: domain })),
      ])
      for (const { domain, file } of bound) await this.writeStateJson(lease, file, { ...domain, certificateId: null })
      if (!await this.removeStatePath(lease, certFile)) throw new Error('certificate_removal_unverified')
      if (await readJsonIfExists(certFile) !== null) throw new Error('certificate_removal_readback_mismatch')
      for (const { domain, file } of bound) {
        if (JSON.stringify(await readJsonIfExists(file)) !== JSON.stringify({ ...domain, certificateId: null })) throw new Error('certificate_assignment_removal_readback_mismatch')
      }
      return true
    })
  }

  saveDnsZone(zone: DnsZoneState, opts?: DnsZoneMutationOptions): Promise<DnsZoneState> {
    return this.withMutationLock(opts, async (lease) => {
      const validated = validateDnsZoneFile(zone)
      await opts?.dnsGuard?.(await this.getDnsZone(validated.name))
      if (validated.accountId !== null) mustExist(await this.findStoredAccountById(validated.accountId), 'account', validated.accountId)
      await this.writeStateJson(lease, this.path('zones', `${validated.name}.json`), validated)
      return validated
    })
  }

  async getDnsZone(name: string): Promise<DnsZoneState | null> {
    let canonical: string
    try {
      canonical = validateDomainName(name)
    } catch {
      return null
    }
    const raw = await readJsonIfExists<unknown>(this.path('zones', `${canonical}.json`))
    return raw === null ? null : validateDnsZoneFile(raw)
  }

  async listDnsZones(accountId?: Id | null): Promise<DnsZoneState[]> {
    const aid = accountId === undefined ? undefined : accountId === null ? null : assertId(accountId, 'accountId')
    const all = await this.readZoneFiles()
    return aid === undefined ? all : all.filter((z) => z.accountId === aid)
  }

  deleteDnsZone(name: string, opts?: DnsZoneMutationOptions): Promise<boolean> {
    return this.withMutationLock(opts, async (lease) => {
      let canonical: string
      try {
        canonical = validateDomainName(name)
      } catch {
        return false
      }
      await opts?.dnsGuard?.(await this.getDnsZone(canonical))
      return this.removeStatePath(lease, this.path('zones', `${canonical}.json`))
    })
  }

  saveCronJobs(accountId: Id, jobs: CronJobState[], opts?: CronMutationOptions): Promise<CronJobState[]> {
    return this.withMutationLock(opts, async (lease) => {
      const account = await this.lockStoredAccount(accountId)
      if (!Array.isArray(jobs)) fail('VALIDATION', 'jobs must be an array')
      const validated = jobs.map((j) => validateCronJob({ ...j, accountId: account.id }, account.id))
      await opts?.cronGuard?.(toPublicAccount(account), await this.listCronJobs(account.id))
      await this.writeStateJson(lease, join(this.accountDir(account.username), 'cron.json'), validated)
      return validated
    })
  }

  async listCronJobs(accountId: Id): Promise<CronJobState[]> {
    if (!isUuid(accountId)) return []
    const account = await this.findStoredAccountById(accountId)
    if (!account) return []
    const raw = await readJsonIfExists<unknown[]>(join(this.accountDir(account.username), 'cron.json'))
    return raw === null ? [] : raw.map((j) => validateCronJob(j, account.id))
  }

  // ---------------------------------------------------------------- domain custom configs (userdata)

  saveDomainCustomConfig(
    input: Omit<DomainCustomConfig, 'updatedAt' | 'domainName' | 'updatedBy'> & {
      domainName?: string
      updatedBy?: 'root' | 'reseller' | 'user'
      updatedAt?: string
    },
    opts?: MutationOptions,
  ): Promise<DomainCustomConfig> {
    return this.withMutationLock(opts, async (lease) => {
      if (typeof input !== 'object' || input === null) fail('VALIDATION', 'custom config must be an object')
      const did = assertId(input.domainId, 'domainId')
      const allDomains = await this.readAllDomainsUnlocked()
      const domain = mustExist(allDomains.find((d) => d.id === did), 'domain', did)
      const account = await this.lockStoredAccount(domain.accountId)
      const accDomains = allDomains.filter((d) => d.accountId === account.id)
      const domainsById = new Map(accDomains.map((d) => [d.id, d]))
      const validated = validateDomainCustomConfigFile(
        {
          ...input,
          domainId: domain.id,
          accountId: account.id,
          domainName: input.domainName ?? domain.name,
          updatedBy: input.updatedBy ?? 'user',
          updatedAt: input.updatedAt ?? new Date().toISOString(),
        },
        { account, domainsById },
      )
      await this.writeStateJson(lease, join(this.accountDir(account.username), 'userdata', `${domain.id}.json`), validated)
      return validated
    })
  }

  async getDomainCustomConfig(domainId: Id): Promise<DomainCustomConfig | null> {
    if (!isUuid(domainId)) return null
    const did = domainId.toLowerCase()
    const allDomains = await this.readAllDomainsUnlocked()
    const domain = allDomains.find((d) => d.id === did)
    if (!domain) return null
    const account = await this.findStoredAccountById(domain.accountId)
    if (!account) return null
    const raw = await readJsonIfExists<unknown>(join(this.accountDir(account.username), 'userdata', `${domain.id}.json`))
    if (raw === null) return null
    const domainsById = new Map(allDomains.filter((d) => d.accountId === account.id).map((d) => [d.id, d]))
    return validateDomainCustomConfigFile(raw, { account, domainsById })
  }

  async listDomainCustomConfigs(accountId?: Id): Promise<DomainCustomConfig[]> {
    const aid = accountId === undefined ? undefined : assertId(accountId, 'accountId')
    const [accounts, allDomains] = await Promise.all([this.readAllAccountsUnlocked(), this.readAllDomainsUnlocked()])
    const out: DomainCustomConfig[] = []
    for (const account of accounts) {
      if (aid !== undefined && account.id !== aid) continue
      const domainsById = new Map(allDomains.filter((d) => d.accountId === account.id).map((d) => [d.id, d]))
      const files = await listJsonFiles(join(this.accountDir(account.username), 'userdata'))
      for (const f of files) {
        out.push(validateDomainCustomConfigFile(await readJsonIfExists(f), { account, domainsById }))
      }
    }
    return out.sort((a, b) => a.domainId.localeCompare(b.domainId))
  }

  deleteDomainCustomConfig(domainId: Id, opts?: MutationOptions): Promise<boolean> {
    return this.withMutationLock(opts, async (lease) => {
      if (!isUuid(domainId)) return false
      const did = domainId.toLowerCase()
      const allDomains = await this.readAllDomainsUnlocked()
      const domain = allDomains.find((d) => d.id === did)
      if (!domain) return false
      const account = await this.findStoredAccountById(domain.accountId)
      if (!account) return false
      return this.removeStatePath(lease, join(this.accountDir(account.username), 'userdata', `${domain.id}.json`))
    })
  }

  // ---------------------------------------------------------------- multi-IP pool & mail outbound IPs

  listServerIps(): Promise<ServerIpEntry[]> {
    return this.readIpPoolFile()
  }

  /** Advisory consistent preview. Unlike a recovery barrier, this read never creates a lease. */
  async readAccountIpAllocationOptions(input: { planId: Id; ownerId: Id | null }) {
    this.assertNotReentrant()
    const planId = assertId(input.planId, 'planId'), ownerId = assertIdOrNull(input.ownerId, 'ownerId')
    return this.runOperation(async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const before = await this.writerLock.readAuthority()
        if (await this.writerLock.readLockHolder()) continue
        let outcome: { snapshot: StateSnapshot } | { error: unknown }
        try { outcome = { snapshot: await this.readSnapshotUnlocked(before.revision) } }
        catch (error) { outcome = { error } }
        const holder = await this.writerLock.readLockHolder(), after = await this.writerLock.readAuthority()
        if (holder || before.revision !== after.revision || before.fencingToken !== after.fencingToken || before.committedLeaseId !== after.committedLeaseId) continue
        if ('error' in outcome) throw outcome.error
        const snapshot = outcome.snapshot, plan = mustExist(snapshot.plans.find(plan => plan.id === planId), 'plan', planId)
        this.assertPlanUsable(plan, ownerId)
        const reseller = ownerId === null ? null : mustExist(snapshot.resellers.find(reseller => reseller.id === ownerId), 'reseller', ownerId)
        return projectAccountIpAvailability({ ownerId, planDedicatedIp: plan.dedicatedIp, reseller,
          pool: snapshot.ipPool ?? [], allAccounts: snapshot.accounts, domains: snapshot.domains, mailIpConfig: snapshot.mailIpConfig })
      }
      return fail('CONFLICT', 'IP allocation preview changed or a writer requires completion', { reason: 'ip_preview_unstable', stateChanged: false })
    })
  }

  saveServerIp(input: Omit<ServerIpEntry, 'id'> & { id?: Id }, opts?: MutationOptions): Promise<ServerIpEntry> {
    return this.withMutationLock(opts, async (lease) => {
      if (typeof input !== 'object' || input === null) fail('VALIDATION', 'server IP entry must be an object')
      const current = await this.readIpPoolFile()
      const entry = validateServerIpEntry({
        ...input,
        id: input.id ?? randomUUID(),
      })
      const existingByAddr = current.find((e) => e.address === entry.address && e.id !== entry.id)
      if (existingByAddr) {
        fail('CONFLICT', `IP address "${entry.address}" is already in the pool`, { address: entry.address })
      }
      const previous = current.find(ip => ip.id === entry.id)
      if (previous && JSON.stringify(previous) !== JSON.stringify(entry) && await this.ipHasReferences(previous.address)) {
        if (['address', 'version', 'prefixLength', 'interfaceName', 'role', 'ownerKind', 'ownerId'].some(key => previous[key as keyof ServerIpEntry] !== entry[key as keyof ServerIpEntry])) fail('CONFLICT', 'IP inventory changes would strand an existing assignment')
      }
      const next = validateServerIpPool([...current.filter((e) => e.id !== entry.id), entry])
      await this.writeStateJson(lease, this.path('ip-pool.json'), next)
      return entry
    })
  }

  deleteServerIp(id: Id, opts?: MutationOptions): Promise<boolean> {
    return this.withMutationLock(opts, async (lease) => {
      if (!isUuid(id)) return false
      const targetId = id.toLowerCase()
      const current = await this.readIpPoolFile()
      const entry = current.find((e) => e.id === targetId)
      if (!entry) return false
      if (entry.isPrimary || await this.ipHasReferences(entry.address)) fail('CONFLICT', 'default or referenced IP cannot be removed')
      const next = current.filter((e) => e.id !== targetId)
      await this.writeStateJson(lease, this.path('ip-pool.json'), next)
      return true
    })
  }

  getMailIpConfig(): Promise<MailIpConfig | null> {
    return this.readMailIpConfigFile()
  }

  private async ipHasReferences(address: string): Promise<boolean> {
    const [accounts, domains, mail, resellers] = await Promise.all([this.readAllAccountsUnlocked(), this.readAllDomainsUnlocked(), this.readMailIpConfigFile(), this.readResellerFiles()])
    const same = (raw: string | null | undefined) => raw != null && canonicalIp(raw).address === address
    return accounts.some(account => [account.ipv4, account.ipv6, ...(account.extraIps ?? [])].some(same))
      || domains.some(domain => [domain.ipv4, domain.ipv6].some(same))
      || resellers.some(reseller => reseller.delegatedIps.some(same))
      || !!mail && ([mail.defaultIpv4, mail.defaultIpv6].some(same) || mail.domainOverrides.some(override => [override.ipv4, override.ipv6].some(same)))
  }

  /** A legacy standalone reference is not a deprovision receipt, even if inventory was lost. */
  private assertDomainIpRelease(domain: Pick<Domain, 'ipv4' | 'ipv6'>, account: Pick<Account, 'ipv4' | 'ipv6' | 'extraIps'>, pool: readonly ServerIpEntry[], accountRetained: boolean): void {
    const retained = new Set(accountRetained ? [account.ipv4, account.ipv6, ...(account.extraIps ?? [])].filter((value): value is string => value != null).map(value => canonicalIp(value).address) : [])
    for (const value of [domain.ipv4, domain.ipv6]) {
      if (value == null) continue
      const address = canonicalIp(value).address
      if (!retained.has(address) && pool.find(entry => entry.address === address)?.role !== 'shared') {
        fail('PRECONDITION_FAILED', 'standalone domain IP release requires verified target-bound deprovisioning', { reason: 'ip_release_unverified', stateChanged: false })
      }
    }
  }

  /** Reuses allocation policy while holding the existing writer lease; never issues reservations. */
  private async assertAccountIpAssignments(accounts: readonly StoredAccount[], changes: { plan?: Plan; reseller?: Reseller; mailIpConfig?: MailIpConfig } = {}): Promise<void> {
    if (accounts.length === 0) return
    const [pool, allAccounts, domains, plans, resellers, storedMail] = await Promise.all([
      this.readIpPoolFile(), this.readAllAccountsUnlocked(), this.readAllDomainsUnlocked(), this.readPlanFiles(), this.readResellerFiles(), this.readMailIpConfigFile(),
    ])
    for (const account of accounts) {
      const plan = changes.plan ?? mustExist(plans.find(plan => plan.id === account.planId), 'plan', account.planId)
      const reseller = account.ownerId === null ? null : changes.reseller?.id === account.ownerId ? changes.reseller : resellers.find(reseller => reseller.id === account.ownerId) ?? null
      resolveAccountIpAssignment(account, { accountId: account.id, ownerId: account.ownerId, planDedicatedIp: plan.dedicatedIp,
        reseller, pool, allAccounts, domains, mailIpConfig: changes.mailIpConfig ?? storedMail })
    }
  }

  saveMailIpConfig(input: MailIpConfig, opts?: MutationOptions): Promise<MailIpConfig> {
    return this.withMutationLock(opts, async (lease) => {
      const validated = validateMailIpConfig(input)
      const [pool, accounts, domains, previous] = await Promise.all([this.readIpPoolFile(), this.readAllAccountsUnlocked(), this.readAllDomainsUnlocked(), this.readMailIpConfigFile()])
      const addresses = (config: MailIpConfig) => [config.defaultIpv4, config.defaultIpv6, ...config.domainOverrides.flatMap(override => [override.ipv4, override.ipv6])].filter((value): value is string => value !== null).map(value => canonicalIp(value).address)
      for (const address of addresses(validated)) {
        const entry = pool.find(entry => entry.address === address) ?? fail('FORBIDDEN', 'mail IP is not in the server pool')
        const global = address === validated.defaultIpv4 || address === validated.defaultIpv6
        const targets = validated.domainOverrides.filter(override => override.ipv4 === address || override.ipv6 === address)
          .map(override => domains.find(domain => domain.name === override.domainName))
          .map(domain => accounts.find(account => account.id === domain?.accountId))
        if (entry.ownerKind !== 'root' && (global || targets.length === 0 || targets.some(account => !account || (entry.ownerKind === 'account' ? entry.ownerId !== account.id : entry.ownerId !== account.ownerId)))) {
          fail('FORBIDDEN', 'mail IP belongs to another account owner')
        }
        if (entry.role === 'dedicated' && domains.some(domain => [domain.ipv4, domain.ipv6].some(value => value != null && canonicalIp(value).address === address)
          && (global || targets.some(account => account?.id !== domain.accountId)))) fail('CONFLICT', 'dedicated IP is already reserved by a domain')
      }
      const nextAddresses = new Set(addresses(validated))
      if (previous && addresses(previous).some(address => !nextAddresses.has(address)
        && pool.find(entry => entry.address === address)?.role !== 'shared'
        && !accounts.some(account => [account.ipv4, account.ipv6, ...(account.extraIps ?? [])].some(value => value != null && canonicalIp(value).address === address)))) {
        fail('PRECONDITION_FAILED', 'mail IP release requires verified target-bound deprovisioning', { reason: 'ip_release_unverified', stateChanged: false })
      }
      await this.assertAccountIpAssignments(accounts, { mailIpConfig: validated })
      await this.writeStateJson(lease, this.path('mail-ips.json'), validated)
      return validated
    })
  }

  // ---------------------------------------------------------------- firewall

  listFirewallRules(): Promise<FirewallRule[]> {
    return this.readFirewallFile().then((s) => s.rules)
  }

  listPrefixLists(): Promise<PrefixList[]> {
    return this.readFirewallFile().then((s) => s.prefixLists)
  }

  getFirewallState(): Promise<FirewallState> {
    return this.readFirewallFile()
  }

  async getFirewallRule(id: Id): Promise<FirewallRule | null> {
    if (typeof id !== 'string' || id.length === 0 || id.length > RULE_ID_MAX) return null
    const state = await this.readFirewallFile()
    return state.rules.find((r) => r.id === id) ?? null
  }

  private assertGuard(guard: unknown): FirewallGuard {
    const g = guard as FirewallGuard | null | undefined
    if (typeof g !== 'object' || g === null || !('lockout' in g)) {
      return fail('VALIDATION', 'firewall changes need the saving session for the lockout check (or lockout: null without one)')
    }
    return g
  }

  private assertFirewallSafe(state: FirewallState, guard: FirewallGuard): void {
    const names = new Set(state.prefixLists.map((l) => l.name))
    for (const r of state.rules) {
      if (r.list !== null && !names.has(r.list)) fail('VALIDATION', `prefix list "${r.list}" does not exist`, { list: r.list, ruleId: r.id })
    }
    if (guard.lockout === null) return
    const prefixLists = Object.fromEntries(state.prefixLists.map((l) => [l.name, l.entries]))
    assertNoSelfLockout(state.rules, { ...guard.lockout, prefixLists })
  }

  private changeFirewall<T>(
    guard: FirewallGuard,
    fn: (state: FirewallState, g: FirewallGuard) => Promise<{ next: FirewallState; result: T }>,
    opts?: FirewallMutationOptions,
  ): Promise<T> {
    return this.withMutationLock(opts, async (lease) => {
      const g = this.assertGuard(guard)
      const current = await this.readFirewallFile()
      if (opts?.expectedFirewallRevision !== undefined && opts.expectedFirewallRevision !== firewallRevision(current)) {
        fail('CONFLICT', 'the firewall rules changed since they were read; reload before saving', { stateChanged: false, currentRevision: firewallRevision(current) })
      }
      const { next, result } = await fn(current, g)
      if (result !== false) {
        const written: FirewallState = { rules: next.rules, prefixLists: next.prefixLists }
        if (opts?.confirmation) {
          // an unconfirmed earlier change keeps its baseline: a revert always lands on confirmed rules
          const baseline = (await this.readFirewallPendingFile())?.previous ?? current
          const pending: FirewallPendingChange = { ...opts.confirmation, appliedRevision: firewallRevision(written), previous: baseline }
          await this.writeStateJson(lease, this.path('firewall-pending.json'), pending)
        }
        await this.writeStateJson(lease, this.path('firewall.json'), { ...written, updatedAt: new Date().toISOString() })
      }
      return result
    })
  }

  private async readFirewallPendingFile(): Promise<FirewallPendingChange | null> {
    const raw = await readJsonIfExists<Record<string, unknown>>(this.path('firewall-pending.json'))
    if (raw === null) return null
    if (typeof raw !== 'object' || typeof raw.id !== 'string' || typeof raw.deadline !== 'string' || !Number.isFinite(Date.parse(raw.deadline))
      || typeof raw.actor !== 'string' || typeof raw.sessionIp !== 'string' || typeof raw.appliedRevision !== 'string') {
      return fail('VALIDATION', 'pending firewall change is malformed')
    }
    return { id: raw.id, deadline: raw.deadline, actor: raw.actor, sessionIp: raw.sessionIp, appliedRevision: raw.appliedRevision, previous: validateFirewallState(raw.previous) }
  }

  getFirewallPending(): Promise<FirewallPendingChange | null> {
    return this.readFirewallPendingFile()
  }

  /** Keeps the applied rules. False when no pending change has this id. */
  confirmFirewallChange(id: string, opts?: MutationOptions): Promise<boolean> {
    return this.withMutationLock(opts, async (lease) => {
      const pending = await this.readFirewallPendingFile()
      if (!pending || pending.id !== id) return false
      await this.removeStatePath(lease, this.path('firewall-pending.json'))
      return true
    })
  }

  /**
   * Restores the last confirmed rules of an unconfirmed change. A later write that did not keep
   * the pending baseline supersedes it: the current rules stay and the pending record is dropped.
   */
  revertFirewallChange(id: string, opts?: MutationOptions): Promise<'reverted' | 'superseded' | 'missing'> {
    return this.withMutationLock(opts, async (lease) => {
      const pending = await this.readFirewallPendingFile()
      if (!pending || pending.id !== id) return 'missing' as const
      const current = await this.readFirewallFile()
      await this.removeStatePath(lease, this.path('firewall-pending.json'))
      if (firewallRevision(current) !== pending.appliedRevision) return 'superseded' as const
      await this.writeStateJson(lease, this.path('firewall.json'), { ...pending.previous, updatedAt: new Date().toISOString() })
      return 'reverted' as const
    })
  }

  createFirewallRule(input: NewFirewallRule, guard: FirewallGuard, opts?: FirewallMutationOptions): Promise<FirewallRule> {
    return this.changeFirewall(
      guard,
      async (state, g) => {
        if (typeof input !== 'object' || input === null) fail('VALIDATION', 'rule must be an object')
        const rule = validateFirewallRule({ ...input, id: input.id ?? randomUUID() })
        if (state.rules.some((r) => r.id === rule.id)) fail('CONFLICT', `firewall rule "${rule.id}" already exists`, { id: rule.id })
        const next: FirewallState = { ...state, rules: [...state.rules, rule] }
        this.assertFirewallSafe(next, g)
        return { next, result: rule }
      },
      opts,
    )
  }

  updateFirewallRule(id: Id, patch: Partial<Omit<FirewallRule, 'id'>>, guard: FirewallGuard, opts?: FirewallMutationOptions): Promise<FirewallRule> {
    return this.changeFirewall(
      guard,
      async (state, g) => {
        const current = state.rules.find((r) => r.id === id) ?? fail('NOT_FOUND', 'firewall rule not found', { id: String(id).slice(0, RULE_ID_MAX) })
        if (typeof patch !== 'object' || patch === null || 'id' in patch) fail('VALIDATION', 'patch must be an object without id')
        const updated = validateFirewallRule({ ...current, ...patch, id: current.id })
        const next: FirewallState = { ...state, rules: state.rules.map((r) => (r.id === current.id ? updated : r)) }
        this.assertFirewallSafe(next, g)
        return { next, result: updated }
      },
      opts,
    )
  }

  deleteFirewallRule(id: Id, guard: FirewallGuard, opts?: FirewallMutationOptions): Promise<boolean> {
    return this.changeFirewall(
      guard,
      async (state, g) => {
        if (!state.rules.some((r) => r.id === id)) return { next: state, result: false }
        const next: FirewallState = { ...state, rules: state.rules.filter((r) => r.id !== id) }
        this.assertFirewallSafe(next, g)
        return { next, result: true }
      },
      opts,
    )
  }

  moveFirewallRule(id: Id, position: number, guard: FirewallGuard, opts?: FirewallMutationOptions): Promise<FirewallRule[]> {
    return this.changeFirewall(
      guard,
      async (state, g) => {
        const rule = state.rules.find((r) => r.id === id) ?? fail('NOT_FOUND', 'firewall rule not found', { id: String(id).slice(0, RULE_ID_MAX) })
        if (!Number.isSafeInteger(position) || position < 0 || position >= state.rules.length) {
          fail('VALIDATION', `position must be 0..${state.rules.length - 1}`)
        }
        const rest = state.rules.filter((r) => r.id !== id)
        const rules = [...rest.slice(0, position), rule, ...rest.slice(position)]
        const next: FirewallState = { ...state, rules }
        this.assertFirewallSafe(next, g)
        return { next, result: rules }
      },
      opts,
    )
  }

  replaceFirewall(nextInput: { rules: unknown; prefixLists: unknown }, guard: FirewallGuard, opts?: FirewallMutationOptions): Promise<FirewallState> {
    return this.changeFirewall(
      guard,
      async (_state, g) => {
        if (typeof nextInput !== 'object' || nextInput === null) fail('VALIDATION', 'firewall import must be { rules, prefixLists }')
        const next: FirewallState = {
          rules: validateFirewallRules(nextInput.rules),
          prefixLists: validatePrefixLists(nextInput.prefixLists),
        }
        this.assertFirewallSafe(next, g)
        return { next, result: next }
      },
      opts,
    )
  }

  savePrefixList(name: string, entries: string[], guard: FirewallGuard, opts?: MutationOptions): Promise<PrefixList> {
    return this.changeFirewall(
      guard,
      async (state, g) => {
        const list = validatePrefixList(name, entries)
        const prefixLists = [...state.prefixLists.filter((l) => l.name !== list.name), list].sort((a, b) => a.name.localeCompare(b.name))
        const next: FirewallState = { ...state, prefixLists }
        this.assertFirewallSafe(next, g)
        return { next, result: list }
      },
      opts,
    )
  }

  deletePrefixList(name: string, guard: FirewallGuard, opts?: MutationOptions): Promise<boolean> {
    return this.changeFirewall(
      guard,
      async (state) => {
        if (!state.prefixLists.some((l) => l.name === name)) return { next: state, result: false }
        const user = state.rules.find((r) => r.list === name)
        if (user) fail('CONFLICT', `prefix list "${name}" is used by rule "${user.id}"`, { name, ruleId: user.id })
        const next: FirewallState = { ...state, prefixLists: state.prefixLists.filter((l) => l.name !== name) }
        return { next, result: true }
      },
      opts,
    )
  }

  // ---------------------------------------------------------------- generation snapshots

  private assertGenId(genId: number): number {
    return typeof genId === 'number' && Number.isSafeInteger(genId) && genId > 0
      ? genId
      : fail('VALIDATION', 'generation id must be a positive integer')
  }

  /**
   * Saves the validated state tree of an applied generation for instant rollback.
   * Accepts an optional pre-read immutable `StateSnapshot` (the exact snapshot passed to
   * `compileDesiredGeneration`) so the saved generation snapshot is guaranteed to match the
   * compiled generation without a compile-vs-save TOCTOU window.
   */
  saveGenerationSnapshot(
    genId: number,
    snapshotOrOpts?: StateSnapshot | MutationOptions,
    opts?: MutationOptions,
  ): Promise<StateSnapshot> {
    const isSnapshot =
      snapshotOrOpts !== undefined &&
      snapshotOrOpts !== null &&
      typeof snapshotOrOpts === 'object' &&
      'checksum' in snapshotOrOpts &&
      'accounts' in snapshotOrOpts
    const providedSnapshot = isSnapshot ? (snapshotOrOpts as StateSnapshot) : undefined
    const mutationOpts = isSnapshot ? opts : (snapshotOrOpts as MutationOptions | undefined)
    return this.withMutationLock(
      mutationOpts,
      async (lease) => {
        const id = this.assertGenId(genId)
        let snap: StateSnapshot
        if (providedSnapshot) {
          snap = this.validateRestoreSnapshot(providedSnapshot)
          if (providedSnapshot.revision !== undefined) {
            if (
              mutationOpts?.expectedRevision === undefined &&
              providedSnapshot.revision !== lease.initialAuthority.revision
            ) {
              return fail(
                'CONFLICT',
                `cannot save generation snapshot ${id}: state revision advanced from ${providedSnapshot.revision} to ${lease.initialAuthority.revision} since compilation`,
                {
                  genId: id,
                  compiledRevision: providedSnapshot.revision,
                  currentRevision: lease.initialAuthority.revision,
                },
              )
            }
            snap.revision = providedSnapshot.revision
          } else {
            snap.revision = lease.initialAuthority.revision
          }
        } else {
          snap = await this.readSnapshotUnderLease(lease)
        }
        await this.writeStateJson(lease, this.path('generations', `${id}.json`), snap)
        return snap
      },
      { incrementRevision: false, restoreAuthorityOnAbort: true },
    )
  }

  async readGenerationSnapshot(genId: number): Promise<StateSnapshot | null> {
    const id = this.assertGenId(genId)
    return readJsonIfExists<StateSnapshot>(this.path('generations', `${id}.json`))
  }

  /** Read-only validation for guarded recovery admission; preserves the legacy raw reader. */
  async readValidatedGenerationSnapshot(genId: number): Promise<StateSnapshot | null> {
    const snapshot = await this.readGenerationSnapshot(genId)
    return snapshot === null ? null : this.validateRestoreSnapshot(snapshot)
  }

  private validateRestoreSnapshot(raw: unknown): StateSnapshot {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('VALIDATION', 'generation snapshot must be an object')
    const input = raw as Record<string, unknown>
    const collection = (key: string, optional = false): unknown[] => {
      const value = input[key]
      if (optional && value === undefined) return []
      return Array.isArray(value) ? value : fail('VALIDATION', `generation snapshot ${key} must be an array`)
    }
    const server = input.server === null ? null : validateStoredServer(input.server)
    const firewall = validateFirewallState(input.firewall)
    const uidAllocator = validateUidAllocator(input.uidAllocator)
    const featureLists = collection('featureLists').map(validateFeatureListFile)
    const plans = collection('plans').map(validatePlanFile)
    const resellers = collection('resellers').map(validateResellerFile)
    const certificates = collection('certificates').map(validateCertificateFile)
    const zones = collection('zones').map(validateDnsZoneFile)
    const accounts = collection('accounts').map(validateAccountFile)
    const featuresById = restoreIndex(featureLists, (value) => value.id, 'feature list')
    const plansById = restoreIndex(plans, (value) => value.id, 'plan')
    const resellersById = restoreIndex(resellers, (value) => value.id, 'reseller')
    const accountsById = restoreIndex(accounts, (value) => value.id, 'account')
    restoreIndex(accounts, (value) => value.username, 'account username')
    restoreIndex(accounts, (value) => String(value.uid), 'account UID')
    restoreIndex(certificates, (value) => value.id, 'certificate')
    restoreIndex(zones, (value) => value.name, 'DNS zone')
    for (const plan of plans) {
      mustExist(featuresById.get(plan.featureListId), 'feature list', plan.featureListId)
      if (plan.ownerId !== null) mustExist(resellersById.get(plan.ownerId), 'reseller', plan.ownerId)
    }
    for (const account of accounts) {
      mustExist(plansById.get(account.planId), 'plan', account.planId)
      if (account.ownerId !== null) mustExist(resellersById.get(account.ownerId), 'reseller', account.ownerId)
      if (!uidAllocator.allocated.some((allocation) => allocation.uid === account.uid && allocation.username === account.username)) {
        fail('VALIDATION', 'generation snapshot account is missing its UID allocation', { accountId: account.id })
      }
    }
    const accountFor = (value: unknown): StoredAccount => {
      if (typeof value !== 'object' || value === null) return fail('VALIDATION', 'account resource must be an object')
      const id = assertId((value as Record<string, unknown>).accountId, 'accountId')
      return mustExist(accountsById.get(id), 'account', id)
    }
    const reservedPorts = new Set(server ? [server.settings.panelPort, server.settings.sshPort, server.settings.backendPort, server.settings.backendTlsPort] : [])
    const domains = collection('domains').map((value) => {
      const account = accountFor(value)
      return validateDomainFile(value, { account, plan: plansById.get(account.planId)!, reservedLoopbackPorts: reservedPorts })
    })
    restoreIndex(domains, (value) => value.id, 'domain')
    restoreIndex(domains, (value) => value.name, 'domain name')
    const domainsFor = (account: StoredAccount) => new Map(domains.filter((domain) => domain.accountId === account.id).map((domain) => [domain.id, domain]))
    const serviceUsers = collection('serviceUsers').map((value) => {
      const account = accountFor(value)
      return validateServiceUserFile(value, { account, plan: plansById.get(account.planId)!, domainsById: domainsFor(account) })
    })
    restoreIndex(serviceUsers, (value) => value.id, 'service user')
    restoreIndex(serviceUsers, (value) => value.login, 'service login')
    const databases = collection('databases').map((value) => validateDatabaseFile(value, accountFor(value)))
    restoreIndex(databases, (value) => value.id, 'database')
    restoreIndex(databases, (value) => value.name, 'database name')
    const databaseUsers = collection('databaseUsers').map((value) => {
      const account = accountFor(value)
      const databasesById = new Map(databases.filter((database) => database.accountId === account.id).map((database) => [database.id, database]))
      return validateDatabaseUserFile(value, { account, databasesById })
    })
    restoreIndex(databaseUsers, (value) => value.id, 'database user')
    restoreIndex(databaseUsers, (value) => value.name, 'database user name')
    const postgresqlUsers = collection('postgresqlUsers', true).map((value) => validatePostgresqlUserFile(value, accountFor(value)))
    restoreIndex(postgresqlUsers, (value) => value.id, 'PostgreSQL user')
    restoreIndex(postgresqlUsers, (value) => value.name, 'PostgreSQL user name')
    const postgresqlDatabases = collection('postgresqlDatabases', true).map((value) => {
      const account = accountFor(value)
      return validatePostgresqlDatabaseFile(value, account, new Set(postgresqlUsers.filter((user) => user.accountId === account.id).map((user) => user.name)))
    })
    restoreIndex(postgresqlDatabases, (value) => value.id, 'PostgreSQL database')
    restoreIndex(postgresqlDatabases, (value) => value.name, 'PostgreSQL database name')
    const cronJobs = collection('cronJobs').map((value) => validateCronJob(value, accountFor(value).id))
    restoreIndex(cronJobs, (value) => value.id, 'cron job')
    const domainCustomConfigs = collection('domainCustomConfigs', true).map((value) => {
      const account = accountFor(value)
      return validateDomainCustomConfigFile(value, { account, domainsById: domainsFor(account) })
    })
    restoreIndex(domainCustomConfigs, (value) => value.domainId, 'domain custom configuration')
    const ipPool = input.ipPool === undefined ? [] : validateIpPoolFile(input.ipPool)
    const mailIpConfig = input.mailIpConfig == null ? null : validateMailIpConfig(input.mailIpConfig)
    // routing records stay raw; the renderer checks each one
    const routing = input.mailRouting === undefined ? null : input.mailRouting as Record<string, unknown> | null
    const mailRouting: MailRoutingState | null = routing === null ? null : {
      forwarders: [], domainForwarders: [], defaultAddresses: [], filters: [], vacations: [],
    }
    if (routing !== null) {
      if (typeof routing !== 'object' || Array.isArray(routing)) fail('VALIDATION', 'generation snapshot mailRouting must be an object')
      for (const key of ['forwarders', 'domainForwarders', 'defaultAddresses', 'filters', 'vacations', 'autoresponders'] as const) {
        const records = routing[key]
        if (key === 'autoresponders' && records === undefined) continue
        if (!Array.isArray(records)) fail('VALIDATION', `generation snapshot mailRouting.${key} must be an array`)
        mailRouting![key] = records as unknown[]
      }
    }
    const checksum = assertSha256Hex(input.checksum, 'snapshot checksum')
    if (checksumStateTree(input as unknown as StateSnapshot) !== checksum) fail('VALIDATION', 'generation snapshot checksum does not match its contents')
    const revision =
      input.revision === undefined ? undefined : assertInt(input.revision, 0, Number.MAX_SAFE_INTEGER, 'snapshot revision')
    const normalized: Omit<StateSnapshot, 'checksum'> = {
      ...(revision !== undefined ? { revision } : {}),
      server, firewall, uidAllocator,
      featureLists: featureLists.sort((a, b) => a.name.localeCompare(b.name)),
      plans: plans.sort((a, b) => a.name.localeCompare(b.name)),
      resellers: resellers.sort((a, b) => a.username.localeCompare(b.username)),
      certificates: certificates.sort((a, b) => a.id.localeCompare(b.id)),
      zones: zones.sort((a, b) => a.name.localeCompare(b.name)),
      accounts: accounts.sort((a, b) => a.username.localeCompare(b.username)),
      domains: domains.sort((a, b) => a.name.localeCompare(b.name)),
      serviceUsers: serviceUsers.sort((a, b) => a.login.localeCompare(b.login)),
      databases: databases.sort((a, b) => a.name.localeCompare(b.name)),
      databaseUsers: databaseUsers.sort((a, b) => a.name.localeCompare(b.name)),
      cronJobs: cronJobs.sort((a, b) => a.id.localeCompare(b.id)),
      ...(domainCustomConfigs.length ? { domainCustomConfigs } : {}), ...(ipPool.length ? { ipPool } : {}), ...(mailIpConfig ? { mailIpConfig } : {}),
      ...(mailRouting ? { mailRouting } : {}),
      ...(postgresqlUsers.length ? {
        postgresqlDatabases: postgresqlDatabases.sort((a, b) => a.name.localeCompare(b.name)),
        postgresqlUsers: postgresqlUsers.sort((a, b) => a.name.localeCompare(b.name)),
      } : {}),
    }
    normalized.domainCustomConfigs?.sort((a, b) => a.domainId.localeCompare(b.domainId))
    return { ...normalized, checksum: checksumStateTree(normalized) }
  }

  private async writeRestoreTree(lease: WriterLease, root: string, snap: StateSnapshot): Promise<void> {
    const path = (...parts: string[]) => join(root, ...parts)
    if (snap.server) await this.writeStateJson(lease, path('server.json'), snap.server)
    await this.writeStateJson(lease, path('firewall.json'), snap.firewall)
    await this.writeStateJson(lease, path('uid-allocator.json'), snap.uidAllocator)
    for (const feature of snap.featureLists) await this.writeStateJson(lease, path('feature-lists', `${feature.id}.json`), feature)
    for (const plan of snap.plans) await this.writeStateJson(lease, path('plans', `${plan.id}.json`), plan)
    for (const reseller of snap.resellers) await this.writeStateJson(lease, path('resellers', `${reseller.id}.json`), reseller)
    for (const certificate of snap.certificates) await this.writeStateJson(lease, path('certificates', `${certificate.id}.json`), certificate)
    for (const zone of snap.zones) await this.writeStateJson(lease, path('zones', `${zone.name}.json`), zone)
    const accounts = new Map(snap.accounts.map((account) => [account.id, account]))
    const accountPath = (id: string, ...parts: string[]) => path('accounts', mustExist(accounts.get(id), 'account', id).username, ...parts)
    for (const account of snap.accounts) await this.writeStateJson(lease, accountPath(account.id, 'account.json'), account)
    for (const domain of snap.domains) await this.writeStateJson(lease, accountPath(domain.accountId, 'domains', `${domain.name}.json`), domain)
    for (const user of snap.serviceUsers) await this.writeStateJson(lease, accountPath(user.accountId, 'users', `${user.id}.json`), user)
    for (const database of snap.databases) await this.writeStateJson(lease, accountPath(database.accountId, 'databases', `${database.name}.json`), database)
    for (const user of snap.databaseUsers) await this.writeStateJson(lease, accountPath(user.accountId, 'db-users', `${user.name}.json`), user)
    for (const user of snap.postgresqlUsers ?? []) await this.writeStateJson(lease, accountPath(user.accountId, 'postgresql', 'users', `${user.name}.json`), user)
    for (const database of snap.postgresqlDatabases ?? []) await this.writeStateJson(lease, accountPath(database.accountId, 'postgresql', 'databases', `${database.name}.json`), database)
    for (const account of snap.accounts) {
      const jobs = snap.cronJobs.filter((job) => job.accountId === account.id)
      if (jobs.length) await this.writeStateJson(lease, accountPath(account.id, 'cron.json'), jobs)
    }
    for (const config of snap.domainCustomConfigs ?? []) await this.writeStateJson(lease, accountPath(config.accountId, 'userdata', `${config.domainId}.json`), config)
    if (snap.ipPool?.length) await this.writeStateJson(lease, path('ip-pool.json'), snap.ipPool)
    if (snap.mailIpConfig) await this.writeStateJson(lease, path('mail-ips.json'), snap.mailIpConfig)
    const routing = snap.mailRouting
    if (!routing) return
    if (Object.values(routing).some((records) => records?.some((record: unknown) => !record || typeof record !== 'object' || 'unreadable' in record))) {
      fail('VALIDATION', 'generation snapshot holds unreadable mail routing and cannot be restored')
    }
    for (const [key, rel] of Object.entries(MAIL_ROUTING_FILES)) {
      const records = routing[key as keyof typeof MAIL_ROUTING_FILES] ?? []
      if (records.length) await this.writeStateJson(lease, path('extended', ...rel), records)
    }
    for (const vacation of routing.vacations as { mailbox?: unknown }[]) {
      if (typeof vacation.mailbox !== 'string' || !vacation.mailbox) return fail('VALIDATION', 'generation snapshot holds a vacation without a mailbox')
      await this.writeStateJson(lease, path('extended', 'webmail', 'vacation', `${encodeURIComponent(vacation.mailbox)}.json`), vacation)
    }
  }

  private async cleanupRestoreArtifacts(paths: readonly string[]): Promise<void> {
    for (const path of paths) {
      try { await rm(path, { recursive: true, force: true }) } catch {
        // Cleanup is after commit or a successful rollback; it must not misreport the state outcome.
        process.emitWarning(`generation restore artifact requires cleanup: ${path}`, { code: 'XPANEL_RESTORE_CLEANUP' })
      }
    }
  }

  private async publishRestoreTree(stage: string, lease: WriterLease, artifacts: string[]): Promise<StateSnapshot> {
    const backup = await mkdtemp(this.path('.restore-backup-'))
    artifacts.push(backup)
    await lease.recordRestoreIntent({ stageName: basename(stage), backupName: basename(backup), entries: restoreEntries })
    for (const name of restoreEntries) {
      await lease.assertFencingToken()
      // routing entries sit below extended/; their parents must exist on both sides of each rename
      if (await restorePathExists(this.path(name))) { await mkdir(dirname(join(backup, name)), { recursive: true }); await rename(this.path(name), join(backup, name)) }
      if (await restorePathExists(join(stage, name))) { await mkdir(dirname(this.path(name)), { recursive: true }); await rename(join(stage, name), this.path(name)) }
    }
    // The restore journal, stage and backup survive until the outer authority commit is proven.
    // WriterLease.release performs validated committed cleanup under the same writer guard.
    return this.readSnapshotUnderLease(lease, lease.initialAuthority.revision + 1)
  }

  /** Applies one reviewed multi-file change: preimages of every touched path are journaled first, any failure restores them. */
  private async journaledFileSet(lease: WriterLease, op: string, created: string[], touched: string[], build: () => Promise<{ writes: [string, unknown][]; removes: string[] }>): Promise<void> {
    const backups: { relPath: string; existed: boolean; contentBase64?: string }[] = []
    for (const file of new Set(touched)) {
      const relPath = relative(this.rootDir, file).replaceAll('\\', '/')
      try { backups.push({ relPath, existed: true, contentBase64: (await readFile(file)).toString('base64') }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; backups.push({ relPath, existed: false }) }
    }
    await lease.recordIntent({ op, createdRelPaths: created, backups })
    try {
      const { writes, removes } = await build()
      const allowed = new Set(touched)
      if ([...writes.map(([file]) => file), ...removes].some(file => !allowed.has(file) && !created.some(rel => relative(this.rootDir, file).replaceAll('\\', '/').startsWith(rel + '/')))) fail('PRECONDITION_FAILED', 'a journaled change touched an unplanned path')
      for (const [file, value] of writes) await this.writeStateJson(lease, file, value)
      for (const file of removes) await this.removeStatePath(lease, file)
    } catch (error) {
      await lease.rollbackIntent().catch(() => undefined)
      throw error
    }
  }

  /**
   * Converts an addon domain into its own account in one journaled mutation. The new account takes the addon as its
   * primary domain, with the addon's subdomains and aliases (document roots moved under the new home), their mail
   * service users, DNS zones and certificates; the account keeps the source addresses. Pass the reviewed revision.
   */
  convertAddonDomain(input: AddonConversionInput, opts?: MutationOptions): Promise<AddonConversionResult> {
    return this.withMutationLock(opts, async (lease) => {
      const username = validateUsername(input.username)
      const home = validateHome(`/home/${username}`)
      const passwordHash = assertArgon2Hash(input.passwordHash)
      const contactEmail = assertEmail(input.contactEmail, 'contactEmail')
      const shell = oneOf(input.shell, SHELLS, 'shell')
      const source = await this.lockStoredAccount(input.sourceAccountId)
      if (source.status !== 'active') fail('PRECONDITION_FAILED', 'the source account must be active', { stateChanged: false })
      const plan = mustExist(await this.getPlan(assertId(input.planId, 'planId')), 'plan', input.planId)
      this.assertPlanUsable(plan, null)
      const [accounts, resellers, domains, users, zones, certificates, pool, mailIpConfig, server] = await Promise.all([this.readAllAccountsUnlocked(), this.readResellerFiles(), this.readAllDomainsUnlocked(),
        this.readAllServiceUsersUnlocked(), this.readZoneFiles(), this.readCertificateFiles(), this.readIpPoolFile(), this.readMailIpConfigFile(), this.readServerFile()])
      if (accounts.some(a => a.username === username) || resellers.some(r => r.username.toLowerCase() === username)) fail('CONFLICT', `username "${username}" is already taken`, { stateChanged: false })
      const addon = mustExist(domains.find(d => d.id === input.domainId && d.kind === 'addon' && d.accountId === source.id), 'addon domain', input.domainId)
      const moved = [addon]
      for (let i = 0; i < moved.length; i++) moved.push(...domains.filter(d => d.parentId === moved[i]!.id && !moved.includes(d)))
      const movedIds = new Set(moved.map(d => d.id)), names = new Set(moved.map(d => d.name))
      const docRoot = defaultDocRoot({ home, username }, 'primary', addon.name)
      const remap = (path: string): string => path === addon.docRoot ? docRoot : path.startsWith(addon.docRoot + '/') ? docRoot + path.slice(addon.docRoot.length)
        : fail('PRECONDITION_FAILED', 'a subdomain of the addon has its document root outside the addon document root', { stateChanged: false })
      const movedUsers = users.filter(u => movedIds.has(u.domainId))
      if (movedUsers.some(u => Object.entries(u.services).some(([service, on]) => service !== 'email' && on))) fail('PRECONDITION_FAILED', 'move or remove the FTP and WebDisk users of this domain first', { stateChanged: false })
      const certIds = new Set(moved.flatMap(d => d.certificateId ? [d.certificateId] : []))
      if (domains.some(d => !movedIds.has(d.id) && d.certificateId !== null && certIds.has(d.certificateId))) fail('PRECONDITION_FAILED', 'a certificate of this domain also serves a domain that stays', { stateChanged: false })
      for (const d of moved) if (await readJsonIfExists(join(this.accountDir(source.username), 'userdata', `${d.id}.json`)) !== null) fail('PRECONDITION_FAILED', 'remove the custom web server configuration of this domain first', { stateChanged: false })
      for (const [kind, key] of [['subdomain', 'subdomains'], ['alias', 'aliasDomains']] as const) {
        const cap = plan.caps[key], count = moved.filter(d => d.kind === kind).length
        if (cap !== 'unlimited' && count > cap) fail('LIMIT_EXCEEDED', `the plan allows ${cap} ${key}; the domain brings ${count}`, { stateChanged: false })
      }
      const mailCap = plan.caps.mailboxes, mailboxes = movedUsers.filter(u => u.services.email).length
      if (mailCap !== 'unlimited' && mailboxes > mailCap) fail('LIMIT_EXCEEDED', `the plan allows ${mailCap} mailboxes; the domain brings ${mailboxes}`, { stateChanged: false })
      const accountId = randomUUID()
      const ips = resolveAccountIpAssignment({ ipv4: source.ipv4, ...(source.ipv6 ? { ipv6: source.ipv6 } : {}) }, { accountId, ownerId: null, planDedicatedIp: plan.dedicatedIp, reseller: null, pool, allAccounts: accounts, domains, mailIpConfig })
      const reserved = new Set<number>(server ? [server.settings.panelPort, server.settings.sshPort, server.settings.backendPort, server.settings.backendTlsPort] : [])
      const sourceDir = this.accountDir(source.username), targetDir = this.accountDir(username)
      const zoneFiles = zones.filter(z => names.has(z.name)), certFiles = certificates.filter(c => certIds.has(c.id))
      const removes = [...moved.map(d => join(sourceDir, 'domains', `${d.name}.json`)), ...movedUsers.map(u => join(sourceDir, 'users', `${u.id}.json`))]
      const rewrites = [...zoneFiles.map(z => this.path('zones', `${z.name}.json`)), ...certFiles.map(c => this.path('certificates', `${c.id}.json`))]
      let result!: AddonConversionResult
      await this.journaledFileSet(lease, 'convertAddonDomain', [`accounts/${username}`], [...removes, ...rewrites, this.path('uid-allocator.json')], async () => {
        const uid = await this.allocateUidUnlocked(lease, username)
        const account: StoredAccount = { id: accountId, username, uid, gid: uid, home, primaryDomain: addon.name, planId: plan.id, ownerId: null, status: 'active', suspendReason: null, suspendedAt: null,
          contactEmail, ipv4: ips.ipv4, ...(ips.ipv6 !== undefined && { ipv6: ips.ipv6 }), ...(ips.extraIps !== undefined && { extraIps: ips.extraIps }), shell, createdAt: new Date().toISOString() }
        const nextDomains = moved.map(d => validateDomainFile({ ...d, accountId, kind: d.id === addon.id ? 'primary' : d.kind, parentId: d.id === addon.id ? null : d.parentId, docRoot: remap(d.docRoot) }, { account, plan, reservedLoopbackPorts: reserved }))
        const byId = new Map(nextDomains.map(d => [d.id, d]))
        const nextUsers = movedUsers.map(u => validateServiceUserFile({ ...u, accountId }, { account, plan, domainsById: byId }))
        result = { account: toPublicAccount(account), domains: nextDomains.map(d => d.name), serviceUsers: nextUsers.map(u => u.login), zones: zoneFiles.map(z => z.name), certificates: certFiles.map(c => c.id) }
        return { removes, writes: [
          ...nextDomains.map((d): [string, unknown] => [join(targetDir, 'domains', `${d.name}.json`), d]),
          ...nextUsers.map((u): [string, unknown] => [join(targetDir, 'users', `${u.id}.json`), u]),
          ...zoneFiles.map((z): [string, unknown] => [this.path('zones', `${z.name}.json`), validateDnsZoneFile({ ...z, accountId })]),
          ...certFiles.map((c): [string, unknown] => [this.path('certificates', `${c.id}.json`), validateCertificateFile({ ...c, accountId })]),
          [join(targetDir, 'account.json'), account],
        ] }
      })
      return result
    })
  }

  /**
   * Undoes convertAddonDomain while the new account still holds exactly the converted domains and mail users: the
   * original domain records return to the source account and the new account's files are removed. Its UID stays burnt.
   */
  revertAddonConversion(input: { accountId: Id; sourceAccountId: Id; domains: readonly Domain[] }, opts?: MutationOptions): Promise<{ domains: string[] }> {
    return this.withMutationLock(opts, async (lease) => {
      const target = await this.lockStoredAccount(input.accountId), source = await this.lockStoredAccount(input.sourceAccountId)
      const plan = mustExist(await this.getPlan(source.planId), 'plan', source.planId)
      const [domains, users, zones, certificates, server] = await Promise.all([this.readAllDomainsUnlocked(), this.readAllServiceUsersUnlocked(), this.readZoneFiles(), this.readCertificateFiles(), this.readServerFile()])
      const current = domains.filter(d => d.accountId === target.id), ids = new Set(input.domains.map(d => d.id))
      if (current.length !== ids.size || current.some(d => !ids.has(d.id))) fail('CONFLICT', 'the converted account changed; it cannot be reverted automatically', { stateChanged: false })
      if (await readJsonIfExists(join(this.accountDir(target.username), 'cron.json')) !== null || (await listJsonFiles(join(this.accountDir(target.username), 'databases'))).length) fail('CONFLICT', 'the converted account has new resources; it cannot be reverted automatically', { stateChanged: false })
      const reserved = new Set<number>(server ? [server.settings.panelPort, server.settings.sshPort, server.settings.backendPort, server.settings.backendTlsPort] : [])
      const restored = input.domains.map(d => validateDomainFile({ ...d, accountId: source.id }, { account: source, plan, reservedLoopbackPorts: reserved }))
      const byId = new Map([...domains.filter(d => d.accountId === source.id), ...restored].map(d => [d.id, d]))
      const movedUsers = users.filter(u => u.accountId === target.id)
      const nextUsers = movedUsers.map(u => validateServiceUserFile({ ...u, accountId: source.id }, { account: source, plan, domainsById: byId }))
      const names = new Set(restored.map(d => d.name)), targetDir = this.accountDir(target.username), sourceDir = this.accountDir(source.username)
      const zoneFiles = zones.filter(z => names.has(z.name) && z.accountId === target.id), certFiles = certificates.filter(c => c.accountId === target.id)
      const removes = [...current.map(d => join(targetDir, 'domains', `${d.name}.json`)), ...movedUsers.map(u => join(targetDir, 'users', `${u.id}.json`)), join(targetDir, 'account.json')]
      const writes: [string, unknown][] = [
        ...restored.map((d): [string, unknown] => [join(sourceDir, 'domains', `${d.name}.json`), d]),
        ...nextUsers.map((u): [string, unknown] => [join(sourceDir, 'users', `${u.id}.json`), u]),
        ...zoneFiles.map((z): [string, unknown] => [this.path('zones', `${z.name}.json`), validateDnsZoneFile({ ...z, accountId: source.id })]),
        ...certFiles.map((c): [string, unknown] => [this.path('certificates', `${c.id}.json`), validateCertificateFile({ ...c, accountId: source.id })]),
      ]
      await this.journaledFileSet(lease, 'revertAddonConversion', [], [...removes, ...writes.map(([file]) => file)], async () => ({ writes, removes }))
      return { domains: restored.map(d => d.name) }
    })
  }

  /** Validates before mutation and rolls back ordinary publication failures under the cross-process writer lock. */
  restoreGenerationSnapshot(genId: number, opts?: RestoreGenerationMutationOptions): Promise<StateSnapshot> {
    const artifacts: string[] = []
    return this.withMutationLock(
      opts,
      async (lease) => {
        const id = this.assertGenId(genId)
        const snap = this.validateRestoreSnapshot(mustExist(await readJsonIfExists<unknown>(this.path('generations', `${id}.json`)), 'generation snapshot', id))
        if (opts?.restoreGuard) await opts.restoreGuard(await this.readSnapshotUnderLease(lease), snap)
        const currentUids = await this.readUidAllocatorFile()
        const allocated = new Map(currentUids.allocated.map((allocation) => [allocation.uid, allocation]))
        for (const allocation of snap.uidAllocator.allocated) {
          const previous = allocated.get(allocation.uid)
          if (previous && previous.username !== allocation.username) fail('VALIDATION', 'generation snapshot conflicts with a burnt UID allocation', { uid: allocation.uid })
          if (!previous) allocated.set(allocation.uid, allocation)
        }
        snap.uidAllocator = validateUidAllocator({ nextUid: Math.max(currentUids.nextUid, snap.uidAllocator.nextUid), allocated: [...allocated.values()].sort((a, b) => a.uid - b.uid) })
        const stage = await mkdtemp(this.path('.restore-stage-'))
        artifacts.push(stage)
        try {
          await this.writeRestoreTree(lease, stage, snap)
          const prepared = await new StateStore(stage).readSnapshot()
          const { checksum: _checksum, ...restored } = snap
          if (prepared.checksum !== checksumStateTree(restored) || JSON.stringify(prepared.uidAllocator) !== JSON.stringify(snap.uidAllocator)) {
            fail('VALIDATION', 'prepared generation tree does not match the validated snapshot')
          }
        } catch (error) {
          await this.cleanupRestoreArtifacts([stage])
          throw error
        }
        return this.publishRestoreTree(stage, lease, artifacts)
      },
      {
        restoreAuthorityOnAbort: true,
        onAbort: async lease => {
          await lease.rollbackRestoreIntent()
          await this.cleanupRestoreArtifacts(artifacts)
        },
      },
    )
  }
}

/** StateStore.convertAddonDomain: the reviewed addon, the new account name and plan, and an unusable password hash. */
export interface AddonConversionInput { sourceAccountId: Id; domainId: Id; username: string; planId: Id; passwordHash: string; contactEmail: string; shell: ShellAccess }
export interface AddonConversionResult { account: Account; domains: string[]; serviceUsers: string[]; zones: string[]; certificates: string[] }

export const createStateStore = (rootDir: string, hooks: StateStoreHooks = {}): StateStore => new StateStore(rootDir, hooks)

export interface TestStateStoreHandle {
  store: StateStore
  rootDir: string
  close: () => Promise<void>
}

export const createTestStateStore = async (hooks: StateStoreHooks = {}): Promise<TestStateStoreHandle> => {
  const rootDir = await mkdtemp(join(tmpdir(), 'xpanel-state-'))
  return {
    store: new StateStore(rootDir, hooks),
    rootDir,
    close: () => rm(rootDir, { recursive: true, force: true }),
  }
}
