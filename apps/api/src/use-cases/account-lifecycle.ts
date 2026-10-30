import { createHash, randomUUID } from 'node:crypto'
import type { ReconcileResult } from '@xpanel/agent'
import {
  assertAcl,
  assertCanSeeAccount,
  changePlanImpact,
  fail,
  isXpanelError,
  sliceUnit,
  suspensionEffects,
  type Account,
  type Id,
  type Plan,
  type PlanImpact,
  type PlanUsage,
  type Principal,
  type Reseller,
  type ResellerAcl,
  type SuspensionEffect,
} from '@xpanel/core'
import {
  acquireJobLease,
  appendAudit,
  completeJobWithLease,
  computeJobRequestFingerprint,
  createUserPrincipal,
  deletePrincipal,
  enqueueDurableJob,
  findPrincipalByAccountId,
  getDurableJob,
  isJobStepCompleted,
  listSessionsForPrincipal,
  reindexFromState,
  revokeAllApiTokensForPrincipal,
  revokeAllSessionsForPrincipal,
  renewJobLease,
  saveJobCheckpoint,
  setPrincipalDisabled,
  type Db,
  type DurableJobRecord,
} from '@xpanel/db'
import { services, system } from '@xpanel/render'
import type { NewAccount, ResellerUsage, StateStore } from '@xpanel/state'
import { ProvisioningLease } from './provisioning-lease.ts'
import { assertProvisioningReply, canonicalProvisioningIdentity, type AccountExecutionObservation, type AuthorizeProvisioning, type LifecycleEffectsPort, type LifecycleReconcilePort, type ProvisioningReconcilePort, type ProvisioningReconcileRequest } from './account-provisioning-port.ts'
import { assertPreparedSources, preparedAccountZone, provisionActorKey, provisioningRequestKey, type PreparedAccountRecord, type PreparedAccountState } from './account-provisioning-prepared.ts'
import type { ProvisioningPreparationStore } from './provisioning-preparation.ts'

// ---------------------------------------------------------------------------
// Types & Contracts
// ---------------------------------------------------------------------------

/** systemd logind user slice unit name for an account UID (`user-<uid>.slice`). */
export const userSliceUnit = (uid: number): string => `user-${uid}.slice`

export interface AccountLifecycleDeps {
  readonly store: StateStore
  readonly db: Db
  readonly reconciler?: LifecycleReconcilePort
  readonly executor?: LifecycleEffectsPort
  readonly workerId?: string
  /** Trusted runtime construction only; request bodies cannot configure these authorities. */
  readonly provisioningPort?: ProvisioningReconcilePort
  readonly authorizeProvisioning?: AuthorizeProvisioning
  readonly preparations?: ProvisioningPreparationStore
  readonly readAccountTemplates?: () => Promise<unknown>
}

export type ProvisionJobStep =
  | 'reserve_and_create_state'
  | 'ensure_principal_and_zone'
  | 'reconcile_host'
  | 'finalize_index_and_audit'

export interface ProvisionJobCheckpointState {
  readonly accountId: Id
  readonly username: string
  readonly uid: number
  readonly primaryDomain: string
  readonly planId: Id
  readonly ownerId: Id | null
  readonly principalId?: Id
  readonly generationId?: number | null
  readonly preparationReference?: string
  readonly preparationIdentity?: string
  readonly desiredZoneIdentity?: string
  readonly gid?: number
  readonly home?: string
  readonly hostAttempt?: number
  readonly hostNoEffectAttempt?: number | null
}

export interface ProvisionAccountInput extends NewAccount {
  readonly actor: Principal
  readonly idempotencyKey?: string
  readonly provisionDefaultZone?: boolean
  readonly nameservers?: readonly string[]
  readonly reconcile?: boolean
  /**
   * Fault injection hook for deterministic testing of mid-create failures
   * and durable job resumption without orphaned state or UID reuse.
   */
  readonly faultInjection?: {
    /** Throws inside StateStore.createAccount after UID allocation & domain file write, before account.json commit. */
    readonly failBeforeAccountJsonCommit?: boolean
    /** Simulates worker crash after completing a specific durable job checkpoint step. */
    readonly crashAfterStep?: ProvisionJobStep
  }
}

export interface ProvisionAccountResult {
  readonly account: Account
  readonly job: DurableJobRecord
  readonly principalId: Id
  readonly reconciliation: ReconcileResult | null
  readonly resumedFromStep: number
  readonly execution?: AccountExecutionObservation
}

export interface PlanChangePreview {
  readonly accountId: Id
  readonly username: string
  readonly currentPlanId: Id
  readonly targetPlanId: Id
  readonly usage: PlanUsage
  readonly impact: PlanImpact
  readonly allowed: boolean
  readonly resellerFits: boolean
  readonly effectiveShellBefore: string
  readonly effectiveShellAfter: string
  readonly sliceName: string
}

export interface ApplyPlanChangeInput {
  readonly accountId: Id
  readonly newPlanId: Id
  readonly actor: Principal
  readonly usageOverrides?: {
    readonly diskMb?: number
    readonly bandwidthMbMonth?: number
    readonly forwarders?: number
    readonly mailingLists?: number
  }
  readonly reconcile?: boolean
}

export interface ApplyPlanChangeResult {
  readonly account: Account
  readonly preview: PlanChangePreview
  readonly reconciliation: ReconcileResult | null
}

export interface ResellerDashboardSummary {
  readonly reseller: Reseller
  readonly usage: ResellerUsage
  readonly accounts: readonly Account[]
  readonly plans: readonly Plan[]
}

export interface TransferOwnershipInput {
  readonly accountId: Id
  readonly newOwnerId: Id | null
  readonly targetPlanId?: Id
  readonly actor: Principal
  readonly reconcile?: boolean
}

export interface TransferOwnershipResult {
  readonly account: Account
  readonly previousOwnerId: Id | null
  readonly newOwnerId: Id | null
  readonly reconciliation: ReconcileResult | null
}

export interface SuspendAccountInput {
  readonly accountId: Id
  readonly reason: string
  readonly actor: Principal
  readonly reconcile?: boolean
}

export interface UnsuspendAccountInput {
  readonly accountId: Id
  readonly actor: Principal
  readonly reconcile?: boolean
}

export interface SuspensionTransitionResult {
  readonly account: Account
  readonly effects: readonly SuspensionEffect[]
  readonly panelPrincipalDisabled: boolean
  readonly activeSessionsRemaining: number
  readonly lockedDatabaseUsers: readonly string[]
  readonly unlockedDatabaseUsers: readonly string[]
  readonly reconciliation: ReconcileResult | null
}

export interface TerminateAccountInput {
  readonly accountId: Id
  readonly confirmUsername: string
  readonly actor: Principal
  readonly reconcile?: boolean
}

export interface TerminateAccountResult {
  readonly terminatedAccountId: Id
  readonly username: string
  readonly burnedUid: number
  readonly removedDomains: readonly string[]
  readonly removedDatabases: readonly string[]
  readonly removedDatabaseUsers: readonly string[]
  readonly removedServiceUsers: readonly string[]
  readonly removedCronJobIds: readonly string[]
  readonly removedZones: readonly string[]
  readonly reconciliation: ReconcileResult | null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const actorLabel = (actor: Principal): string => `${actor.kind}:${actor.username}`

const DEFAULT_NAMESERVERS = ['ns1.xpanel.internal', 'ns2.xpanel.internal'] as const

const STEP_INDEX: Readonly<Record<ProvisionJobStep, number>> = {
  reserve_and_create_state: 1,
  ensure_principal_and_zone: 2,
  reconcile_host: 3,
  finalize_index_and_audit: 4,
}

export class SimulatedProvisionCrashError extends Error {
  readonly step: ProvisionJobStep
  readonly jobId: Id

  constructor(step: ProvisionJobStep, jobId: Id) {
    super(`simulated provisioning crash after step '${step}' (job ${jobId})`)
    this.name = 'SimulatedProvisionCrashError'
    this.step = step
    this.jobId = jobId
  }
}

// ---------------------------------------------------------------------------
// AccountLifecycleCoordinator (H04)
// ---------------------------------------------------------------------------

/**
 * Coordinates the full hosting account lifecycle (H04):
 * - Durable, checkpointed account provisioning with permanent UID burn on mid-create failure
 * - Plan & feature-list inspection and live plan changes (quota, cgroup slice, PHP-FPM pool, shell)
 * - Reseller capacity enforcement, multi-tenant visibility boundaries, and root ownership transfer
 * - Complete multi-surface suspension & unsuspension (panel/sessions/API tokens, shell, FTP, WebDisk,
 *   mail login & delivery, MariaDB account lock/unlock, cron timers, cgroup slice, HTTP 503 vhost)
 * - Safe, complete account termination across all host & database surfaces without reusing burnt UIDs
 */
export class AccountLifecycleCoordinator {
  private readonly store: StateStore
  private readonly db: Db
  private readonly reconciler: LifecycleReconcilePort | undefined
  private readonly executor: LifecycleEffectsPort | undefined
  private readonly workerId: string
  private readonly provisioningPort: ProvisioningReconcilePort | undefined
  private readonly authorizeProvisioning: AuthorizeProvisioning | undefined
  private readonly preparations: ProvisioningPreparationStore | undefined
  private readonly readAccountTemplates: (() => Promise<unknown>) | undefined

  constructor(deps: AccountLifecycleDeps) {
    this.store = deps.store
    this.db = deps.db
    this.reconciler = deps.reconciler
    this.executor = deps.executor
    this.workerId = deps.workerId ?? `lifecycle-worker-${randomUUID().slice(0, 8)}`
    this.provisioningPort = deps.provisioningPort
    this.authorizeProvisioning = deps.authorizeProvisioning
    this.preparations = deps.preparations
    this.readAccountTemplates = deps.readAccountTemplates
  }

  /**
   * Authorizes a lifecycle action for `actor` (`root` or `reseller` holding `acl` and owning the target).
   */
  private async authorizeResellerOrRoot(
    actor: Principal,
    acl: ResellerAcl,
    targetOwnerId: Id | null,
  ): Promise<void> {
    if (actor.kind === 'root') return
    if (actor.kind !== 'reseller') {
      fail('FORBIDDEN', `privilege "${acl}" requires a reseller or root`, { acl })
    }
    if (targetOwnerId !== actor.id) {
      fail('FORBIDDEN', 'account or resource belongs to another reseller', {
        actorId: actor.id,
        targetOwnerId,
      })
    }
    const reseller = await this.store.getReseller(actor.id)
    assertAcl(actor, reseller, acl)
  }

  /**
   * Computes current resource & capability usage (`PlanUsage`) for an account from desired state.
   */
  async computeAccountUsage(
    accountId: Id,
    overrides: {
      readonly diskMb?: number
      readonly bandwidthMbMonth?: number
      readonly forwarders?: number
      readonly mailingLists?: number
    } = {},
  ): Promise<PlanUsage> {
    const [domainCounts, domains, databases, serviceUsers] = await Promise.all([
      this.store.countDomainsByKind(accountId),
      this.store.listDomains({ accountId }),
      this.store.listDatabases(accountId, { includeTrashed: false }),
      this.store.listServiceUsers(accountId),
    ])

    const mailboxes = serviceUsers.filter((u) => u.services.email).length
    const ftpAccounts = serviceUsers.filter((u) => u.services.ftp).length
    const maxPhpWorkers = domains.reduce(
      (max, d) => Math.max(max, d.php.fpm.maxChildren),
      1,
    )

    return {
      caps: {
        addonDomains: domainCounts.addon,
        aliasDomains: domainCounts.alias,
        subdomains: domainCounts.subdomain,
        mailboxes,
        forwarders: overrides.forwarders ?? 0,
        mailingLists: overrides.mailingLists ?? 0,
        ftpAccounts,
        databases: databases.length,
        phpWorkers: maxPhpWorkers,
      },
      ...(overrides.diskMb !== undefined && { diskMb: overrides.diskMb }),
      ...(overrides.bandwidthMbMonth !== undefined && {
        bandwidthMbMonth: overrides.bandwidthMbMonth,
      }),
    }
  }

  /**
   * Provisions a new hosting account via a durable, resumable job (`account.provision`).
   * If a crash occurs mid-create inside `StateStore.createAccount`, the allocated UID remains
   * permanently burnt in `uid-allocator.json` while partial files are cleaned up.
   * If a crash occurs between durable job steps, calling `provisionAccount` again with the
   * same input/idempotencyKey resumes from the saved checkpoint without duplicating the account
   * or burning an extra UID.
   */
  async provisionAccount(input: ProvisionAccountInput): Promise<ProvisionAccountResult> {
    return this.provisionAccountInternal(input)
  }

  /** Production API path: load the immutable credential/desired-state authority, never a supplied hash. */
  async provisionPreparedAccount(input: { actor: Principal; idempotencyKey: string; preparationReference: string }): Promise<ProvisionAccountResult> {
    if (!this.preparations || !this.provisioningPort || !this.authorizeProvisioning || !this.readAccountTemplates) {
      return fail('SERVICE_UNAVAILABLE', 'durable account provisioning authorities are not connected', { stateChanged: false })
    }
    const prepared = await this.preparations.load<PreparedAccountState>(input.preparationReference, provisionActorKey(input.actor))
    if (canonicalProvisioningIdentity(prepared.desiredState.account) !== prepared.requestIdentity) {
      return fail('PRECONDITION_FAILED', 'private preparation request identity is inconsistent', { stateChanged: false, verificationRequired: true })
    }
    if (prepared.desiredState.operationKey !== provisioningRequestKey(input.actor, input.idempotencyKey)) {
      return fail('CONFLICT', 'provisioning preparation belongs to another request', { stateChanged: false })
    }
    await this.authorizeProvisioning({ actor: input.actor, accountId: null, ownerId: prepared.desiredState.account.ownerId })
    return this.provisionAccountInternal({ ...prepared.desiredState.account, passwordHash: prepared.passwordHash,
      actor: input.actor, idempotencyKey: provisioningRequestKey(input.actor, input.idempotencyKey),
      provisionDefaultZone: true, reconcile: true }, prepared)
  }

  private async provisionAccountInternal(input: ProvisionAccountInput, prepared?: PreparedAccountRecord): Promise<ProvisionAccountResult> {
    await this.authorizeResellerOrRoot(input.actor, 'create-account', input.ownerId)
    const actorKind = input.actor.kind
    if (actorKind !== 'root' && actorKind !== 'reseller') return fail('FORBIDDEN', 'account provisioning requires a privileged actor')
    if (input.reconcile !== false && !(prepared ? this.provisioningPort : this.reconciler)) {
      fail('SERVICE_UNAVAILABLE', 'account provisioning requires a connected host reconciliation provider', { stateChanged: false })
    }

    const canonicalUser = input.username.trim().toLowerCase()
    const idempotencyKey = input.idempotencyKey ?? `account.provision:${canonicalUser}`

    const requestDetail = {
      provisioningFingerprintVersion: prepared ? 3 : 2,
      ...(prepared && { preparationReference: prepared.reference, preparationIdentity: canonicalProvisioningIdentity(prepared.desiredState) }),
      username: input.username,
      primaryDomain: input.primaryDomain,
      planId: input.planId,
      ownerId: input.ownerId,
      contactEmail: input.contactEmail,
      ipv4: input.ipv4,
      ...(input.ipAssignment !== undefined && { ipAssignment: input.ipAssignment }),
      ...(input.ipv6 !== undefined && { ipv6: input.ipv6 }),
      ...(input.extraIps !== undefined && { extraIps: input.extraIps }),
      shell: input.shell,
      php: input.php,
      forcePasswordChange: input.forcePasswordChange ?? false,
      provisionDefaultZone: input.provisionDefaultZone ?? true,
      nameservers: [...(input.nameservers ?? DEFAULT_NAMESERVERS)],
      homeBase: input.homeBase ?? '/home',
      reconcile: input.reconcile !== false,
    }
    // Bind credential input without persisting it in job detail or bypassing redaction.
    const publicFingerprint = computeJobRequestFingerprint({
      kind: 'account.provision', accountId: null, actor: actorLabel(input.actor), detail: requestDetail,
    })
    const requestFingerprint = createHash('sha256').update(JSON.stringify([
      'account.provision:v2', publicFingerprint, input.passwordHash,
    ])).digest('hex')
    let enqueued: DurableJobRecord & { deduplicated: boolean }
    try {
      enqueued = await enqueueDurableJob(this.db, {
        kind: 'account.provision',
        idempotencyKey,
        requestFingerprint,
        accountId: null,
        actor: actorLabel(input.actor),
        summary: `Provision account ${input.username} (${input.primaryDomain})`,
        detail: requestDetail,
        maxAttempts: 5,
      })
    } catch (err) {
      if (isXpanelError(err) && err.code === 'CONFLICT' && typeof err.detail.existingJobId === 'string') {
        let prior: DurableJobRecord | null
        try {
          prior = await getDurableJob(this.db, err.detail.existingJobId)
        } catch {
          return fail('PRECONDITION_FAILED', 'saved provisioning request identity could not be verified; recovery review is required', {
            stateChanged: false, verificationRequired: true, reason: 'provisioning_identity_unavailable',
          })
        }
        if (prior?.kind === 'account.provision' && prior.actor === actorLabel(input.actor)
          && prior.detail.provisioningFingerprintVersion === undefined) {
          return fail('PRECONDITION_FAILED', 'legacy provisioning job lacks complete request identity; explicit recovery review is required', {
            stateChanged: false, verificationRequired: true, reason: 'legacy_provisioning_identity_unverifiable',
          })
        }
      }
      throw err
    }

    // If the job was already completed in an earlier idempotent run, return it directly
    if (enqueued.deduplicated && enqueued.status === 'succeeded') {
      const cp = enqueued.checkpointData as unknown as ProvisionJobCheckpointState
      const acc = await this.store.getAccount(cp.accountId)
      const principal = await findPrincipalByAccountId(this.db, cp.accountId)
      if (acc && principal) {
        await this.authorizeResellerOrRoot(input.actor, 'create-account', acc.ownerId)
        this.assertProvisionCheckpointIdentity(acc, cp)
        return {
          account: acc,
          job: enqueued,
          principalId: principal.id,
          reconciliation: null,
          resumedFromStep: enqueued.completedSteps.length,
        }
      }
    }

    const initialLease = await acquireJobLease(this.db, {
      jobId: enqueued.id,
      workerId: this.workerId,
      leaseDurationMs: 60_000,
    })

    if (!initialLease) {
      return fail('CONFLICT', `unable to acquire lease for provisioning job ${enqueued.id}`)
    }

    let leased: DurableJobRecord = initialLease

    const resumedFromStep = leased.completedSteps.length
    let checkpointState: ProvisionJobCheckpointState | null =
      leased.checkpointData && typeof leased.checkpointData.accountId === 'string'
        ? (leased.checkpointData as unknown as ProvisionJobCheckpointState)
        : null
    let unknownOutcome = false
    let uncheckpointedCreation = false
    let observedExecution: AccountExecutionObservation | undefined
    const leaseAuthority = new ProvisioningLease(initialLease, () => renewJobLease(this.db, {
      jobId: initialLease.id, workerId: this.workerId, fencingToken: initialLease.fencingToken, leaseDurationMs: 60_000,
    }))
    let authAccountId: Id | null = checkpointState?.accountId ?? null
    const assertAuthority = async (): Promise<void> => {
      await leaseAuthority.assert()
      try {
        await this.authorizeResellerOrRoot(input.actor, 'create-account', input.ownerId)
        await this.authorizeProvisioning?.({ actor: input.actor, accountId: authAccountId, ownerId: input.ownerId })
      } catch (error) { if (checkpointState) unknownOutcome = true; throw error }
      if (prepared) {
        if (!this.authorizeProvisioning || !this.readAccountTemplates) return fail('SERVICE_UNAVAILABLE', 'fresh provisioning authorization is unavailable')
        try { await assertPreparedSources(this.store, prepared, this.readAccountTemplates) }
        catch (error) { if (checkpointState) unknownOutcome = true; throw error }
      }
    }

    try {
      await assertAuthority()
      if (isJobStepCompleted(leased, 'reconcile_host_intent') && !isJobStepCompleted(leased, 'reconcile_host')
        && (checkpointState?.hostAttempt === undefined || checkpointState.hostAttempt !== checkpointState.hostNoEffectAttempt)) {
        unknownOutcome = true
        fail('PRECONDITION_FAILED', 'a prior host execution has no acknowledged outcome; operator recovery is required', { verificationRequired: true })
      }
      // Step 1: Reserve UID and create desired-state account + primary domain
      if (!isJobStepCompleted(leased, 'reserve_and_create_state') || !checkpointState) {
        const existingAccount = await this.store.getAccountByUsername(input.username)
        let created: Account
        if (existingAccount) {
          await this.authorizeResellerOrRoot(input.actor, 'create-account', existingAccount.ownerId)
          unknownOutcome = enqueued.deduplicated
          return fail('CONFLICT', 'existing account has no identity checkpoint for this provisioning job; recovery review is required', {
            stateChanged: false, verificationRequired: enqueued.deduplicated,
          })
        } else {
          const storeHooks = (this.store as unknown as { hooks?: Record<string, unknown> }).hooks
          const prevBeforeCommit = storeHooks?.onBeforeAccountCommit
          if (input.faultInjection?.failBeforeAccountJsonCommit && storeHooks) {
            storeHooks.onBeforeAccountCommit = async () => {
              throw new Error('injected failure before account.json commit after UID allocation')
            }
          }
          try {
            await assertAuthority()
            uncheckpointedCreation = true
            created = await this.store.createAccount({
              username: input.username,
              primaryDomain: input.primaryDomain,
              planId: input.planId,
              ownerId: input.ownerId,
              contactEmail: input.contactEmail,
              ipv4: input.ipv4,
              ...(input.ipAssignment !== undefined && { ipAssignment: input.ipAssignment }),
              ...(input.ipv6 !== undefined && { ipv6: input.ipv6 }),
              ...(input.extraIps !== undefined && { extraIps: input.extraIps }),
              shell: input.shell,
              php: input.php,
              passwordHash: input.passwordHash,
              ...(input.forcePasswordChange !== undefined && {
                forcePasswordChange: input.forcePasswordChange,
              }),
              ...(input.homeBase !== undefined && { homeBase: input.homeBase }),
            }, prepared ? { expectedRevision: prepared.desiredState.sourceRevision } : undefined)
          } finally {
            if (storeHooks) {
              storeHooks.onBeforeAccountCommit = prevBeforeCommit
            }
          }
        }

        checkpointState = {
          accountId: created.id,
          username: created.username,
          uid: created.uid,
          gid: created.gid,
          home: created.home,
          primaryDomain: created.primaryDomain,
          planId: created.planId,
          ownerId: created.ownerId,
          ...(prepared && { preparationReference: prepared.reference, preparationIdentity: canonicalProvisioningIdentity(prepared.desiredState) }),
        }
        authAccountId = created.id

        await assertAuthority()
        leased = await saveJobCheckpoint(this.db, {
          jobId: leased.id,
          workerId: this.workerId,
          fencingToken: leased.fencingToken,
          step: 'reserve_and_create_state',
          progress: 25,
          summary: `Created state for ${created.username} (UID ${created.uid})`,
          data: checkpointState as unknown as Record<string, unknown>,
        })
        uncheckpointedCreation = false

        if (input.faultInjection?.crashAfterStep === 'reserve_and_create_state') {
          throw new SimulatedProvisionCrashError('reserve_and_create_state', leased.id)
        }
      }

      const account =
        (await this.store.getAccount(checkpointState.accountId)) ??
        fail('NOT_FOUND', `provisioned account ${checkpointState.accountId} missing from state`)
      await this.authorizeResellerOrRoot(input.actor, 'create-account', account.ownerId)
      this.assertProvisionCheckpointIdentity(account, checkpointState)
      authAccountId = account.id
      if (prepared && (checkpointState.preparationReference !== prepared.reference
        || checkpointState.preparationIdentity !== canonicalProvisioningIdentity(prepared.desiredState))) {
        unknownOutcome = true
        fail('CONFLICT', 'the saved account checkpoint is not bound to this private preparation', { verificationRequired: true })
      }
      await assertAuthority()

      // Step 2: Ensure panel principal & default DNS zone exist
      let principal = await findPrincipalByAccountId(this.db, account.id)
      const desiredZone = prepared ? preparedAccountZone(prepared, account) : null
      if (prepared && principal && (principal.kind !== 'user' || principal.username !== account.username
        || principal.accountId !== account.id || principal.passwordHash !== prepared.passwordHash)) {
        unknownOutcome = true
        fail('CONFLICT', 'saved principal does not match this account preparation', { verificationRequired: true })
      }
      if (!isJobStepCompleted(leased, 'ensure_principal_and_zone') || !principal) {
        if (desiredZone) {
          const desiredZoneIdentity = canonicalProvisioningIdentity(desiredZone)
          if (checkpointState.desiredZoneIdentity && checkpointState.desiredZoneIdentity !== desiredZoneIdentity) {
            unknownOutcome = true
            fail('CONFLICT', 'saved DNS intent does not match the exact account template', { verificationRequired: true })
          }
          checkpointState = { ...checkpointState, desiredZoneIdentity }
          await assertAuthority()
          leased = await saveJobCheckpoint(this.db, { jobId: leased.id, workerId: this.workerId,
            fencingToken: leased.fencingToken, step: 'principal_and_zone_intent', progress: 30,
            data: checkpointState as unknown as Record<string, unknown> })
        }
        if (!principal) {
          await assertAuthority()
          principal = await createUserPrincipal(this.db, {
            accountId: account.id,
            username: account.username,
            passwordHash: input.passwordHash,
            forcePasswordChange: input.forcePasswordChange ?? false,
          })
        }

        await assertAuthority()
        if (desiredZone) {
          const current = await this.store.getDnsZone(account.primaryDomain)
          if (current && canonicalProvisioningIdentity(current) !== checkpointState.desiredZoneIdentity) {
            unknownOutcome = true
            fail('CONFLICT', 'an existing DNS zone does not match this operation intent', { verificationRequired: true })
          }
          if (!current) await this.store.saveDnsZone(desiredZone, {
            expectedRevision: await this.store.getRevision(),
            dnsGuard: async existing => {
              if (existing) fail('CONFLICT', 'DNS zone appeared after the provisioning precondition', { verificationRequired: true })
            },
          })
        } else if (input.provisionDefaultZone !== false) {
          const existingZone = await this.store.getDnsZone(account.primaryDomain)
          if (!existingZone) {
            const ns = input.nameservers ?? DEFAULT_NAMESERVERS
            const defaultRecords = services.defaultZoneRecords(account.primaryDomain, {
              ipv4: account.ipv4,
              ipv6: account.ipv6 ?? null,
              nameservers: [...ns],
              mailHost: `mail.${account.primaryDomain}`,
              adminEmail: account.contactEmail,
              serial: 2026102201,
            })
            await this.store.saveDnsZone({
              id: randomUUID(),
              name: account.primaryDomain,
              accountId: account.id,
              serial: 2026102201,
              records: defaultRecords
                .filter(
                  (r): r is services.ZoneRecord & { type: Exclude<services.ZoneRecordType, 'SOA'> } =>
                    r.type !== 'SOA',
                )
                .map((r) => ({
                  id: randomUUID(),
                  zone: account.primaryDomain,
                  name: r.name,
                  type: r.type,
                  ttl: r.ttl,
                  content: r.content,
                  priority: r.priority,
                })),
            })
          }
        }

        checkpointState = {
          ...checkpointState,
          principalId: principal.id,
        }

        await assertAuthority()
        leased = await saveJobCheckpoint(this.db, {
          jobId: leased.id,
          workerId: this.workerId,
          fencingToken: leased.fencingToken,
          step: 'ensure_principal_and_zone',
          progress: 55,
          summary: `Configured principal and DNS zone for ${account.primaryDomain}`,
          data: checkpointState as unknown as Record<string, unknown>,
        })

        if (input.faultInjection?.crashAfterStep === 'ensure_principal_and_zone') {
          throw new SimulatedProvisionCrashError('ensure_principal_and_zone', leased.id)
        }
      }
      if (desiredZone && canonicalProvisioningIdentity(await this.store.getDnsZone(account.primaryDomain)) !== checkpointState.desiredZoneIdentity) {
        unknownOutcome = true
        fail('CONFLICT', 'account DNS no longer matches its persisted preparation', { verificationRequired: true })
      }

      // Step 3: Reconcile host surfaces (Linux user/group, 0750 home, quota, slice, PHP-FPM, vhost, DNS)
      let reconciliation: ReconcileResult | null = null
      if (!isJobStepCompleted(leased, 'reconcile_host')) {
        if ((prepared ? this.provisioningPort : this.reconciler) && input.reconcile !== false) {
          await assertAuthority()
          checkpointState = { ...checkpointState, hostAttempt: leased.attempt, hostNoEffectAttempt: null }
          leased = await saveJobCheckpoint(this.db, { jobId: leased.id, workerId: this.workerId,
            fencingToken: leased.fencingToken, step: 'reconcile_host_intent', progress: 60,
            data: checkpointState as unknown as Record<string, unknown> })
          unknownOutcome = true
          if (prepared) {
            await assertAuthority()
            const snapshot = await this.store.readSnapshot()
            const currentLease = leaseAuthority.current
            const authority = {
              actor: { id: input.actor.id, kind: actorKind, username: input.actor.username },
              account: { id: account.id, username: account.username, ownerId: account.ownerId, planId: account.planId,
                uid: account.uid, gid: account.gid, home: account.home, primaryDomain: account.primaryDomain },
              operation: { id: leased.id, workerId: this.workerId, fencingToken: leased.fencingToken,
                leaseExpiresAt: currentLease.leaseExpiresAt!, requestFingerprint: leased.requestFingerprint },
              desired: { revision: snapshot.revision ?? await this.store.getRevision(), checksum: snapshot.checksum,
                preparationReference: prepared.reference, preparationIdentity: canonicalProvisioningIdentity(prepared.desiredState) },
            }
            const request: ProvisioningReconcileRequest = { authority, binding: canonicalProvisioningIdentity(authority) }
            const reply = await this.provisioningPort!.reconcile(request, { signal: leaseAuthority.abort.signal, assertAuthority })
            await assertAuthority()
            observedExecution = assertProvisioningReply(request, reply)
            reconciliation = reply.reconciliation
          } else {
            reconciliation = await this.reconciler!.reconcile({ actor: actorLabel(input.actor), force: true,
              scope: { accountId: account.id, resellerId: account.ownerId } })
            await assertAuthority()
          }
          if (reconciliation.status === 'failed') {
            unknownOutcome = reconciliation.stateChanged !== false && reconciliation.rolledBack !== true
              || reconciliation.verificationRequired === true
            if (!unknownOutcome && reconciliation.stateChanged === false) {
              checkpointState = { ...checkpointState, hostNoEffectAttempt: leased.attempt }
              leased = await saveJobCheckpoint(this.db, { jobId: leased.id, workerId: this.workerId,
                fencingToken: leased.fencingToken, step: 'reconcile_host_no_effect',
                data: checkpointState as unknown as Record<string, unknown> })
            }
            fail('PRECONDITION_FAILED', `host reconciliation failed during account provisioning: ${reconciliation.error}`, {
              stateChanged: true, hostStateChanged: reconciliation.stateChanged ?? true, verificationRequired: unknownOutcome,
            })
          }
        }

        checkpointState = {
          ...checkpointState,
          generationId: reconciliation?.generation?.id ?? null,
        }

        await assertAuthority()
        leased = await saveJobCheckpoint(this.db, {
          jobId: leased.id,
          workerId: this.workerId,
          fencingToken: leased.fencingToken,
          step: 'reconcile_host',
          progress: 85,
          summary: `Reconciled host surfaces for ${account.username}`,
          data: checkpointState as unknown as Record<string, unknown>,
        })
        unknownOutcome = false

        if (input.faultInjection?.crashAfterStep === 'reconcile_host') {
          throw new SimulatedProvisionCrashError('reconcile_host', leased.id)
        }
      }

      // Step 4: Update SQLite search index & write audit log, then complete durable job
      await assertAuthority()
      const snap = await this.store.readSnapshot()
      await reindexFromState(this.db, snap)

      await assertAuthority()
      await appendAudit(this.db, {
        actor: actorLabel(input.actor),
        action: 'account.provisioned',
        target: `account:${account.username}`,
        detail: {
          accountId: account.id,
          uid: account.uid,
          primaryDomain: account.primaryDomain,
          planId: account.planId,
          ownerId: account.ownerId,
          jobId: leased.id,
          resumedFromStep,
        },
        outcome: 'ok',
      })

      await leaseAuthority.stop()
      await assertAuthority()
      const completedJob = await completeJobWithLease(this.db, {
        jobId: leased.id,
        workerId: this.workerId,
        fencingToken: leased.fencingToken,
        status: 'succeeded',
        summary: `Account ${account.username} provisioned (UID ${account.uid})`,
        detail: {
          accountId: account.id,
          username: account.username,
          uid: account.uid,
          principalId: principal.id,
          generationId: checkpointState.generationId ?? null,
        },
      })

      return {
        account,
        job: completedJob,
        principalId: principal.id,
        reconciliation,
        resumedFromStep,
        ...(observedExecution && { execution: observedExecution }),
      }
    } catch (err) {
      await leaseAuthority.stop().catch(() => undefined)
      if (leaseAuthority.lost && checkpointState) unknownOutcome = true
      if (uncheckpointedCreation) {
        try {
          if (await this.store.getAccountByUsername(input.username)) unknownOutcome = true
        } catch {
          unknownOutcome = true
        }
      }
      const permanent = isXpanelError(err) && ['VALIDATION', 'FORBIDDEN', 'CONFLICT', 'LIMIT_EXCEEDED', 'OVERSELL_BLOCKED'].includes(err.code)
      await completeJobWithLease(this.db, {
        jobId: leased.id,
        workerId: this.workerId,
        fencingToken: leased.fencingToken,
        status: 'failed',
        error: (err as Error).message,
        failureClass: unknownOutcome ? 'unknown_outcome' : permanent ? 'permanent' : 'retryable',
        needsAttention: unknownOutcome,
        requeueOnRetryable: !unknownOutcome && !permanent,
      }).catch(() => undefined)
      if (unknownOutcome) {
        return fail(isXpanelError(err) ? err.code : 'PRECONDITION_FAILED', err instanceof Error ? err.message : String(err), {
          ...(isXpanelError(err) ? err.detail : {}), stateChanged: true, verificationRequired: true,
        })
      }
      throw err
    } finally {
      await leaseAuthority.stop().catch(() => undefined)
    }
  }

  private assertProvisionCheckpointIdentity(account: Account, checkpoint: ProvisionJobCheckpointState): void {
    if (account.id !== checkpoint.accountId || account.username !== checkpoint.username || account.uid !== checkpoint.uid
      || account.primaryDomain !== checkpoint.primaryDomain || account.ownerId !== checkpoint.ownerId || account.planId !== checkpoint.planId
      || (checkpoint.gid !== undefined && account.gid !== checkpoint.gid) || (checkpoint.home !== undefined && account.home !== checkpoint.home)) {
      fail('CONFLICT', 'provisioned account identity or ownership changed; the saved job cannot adopt it', { stateChanged: false })
    }
  }

  /**
   * Previews the exact resource, capability, shell, PHP-FPM, quota, and cgroup slice
   * effects of changing an account's plan before applying the mutation.
   */
  async previewPlanChange(
    accountId: Id,
    newPlanId: Id,
    opts: {
      actor?: Principal
      usageOverrides?: {
        readonly diskMb?: number
        readonly bandwidthMbMonth?: number
        readonly forwarders?: number
        readonly mailingLists?: number
      }
    } = {},
  ): Promise<PlanChangePreview> {
    const account =
      (await this.store.getAccount(accountId)) ?? fail('NOT_FOUND', `account ${accountId} not found`)
    if (opts.actor) {
      assertCanSeeAccount(opts.actor, account)
    }

    const [currentPlan, targetPlan, usage] = await Promise.all([
      this.store.getPlan(account.planId),
      this.store.getPlan(newPlanId),
      this.computeAccountUsage(account.id, opts.usageOverrides),
    ])

    const oldPlan = currentPlan ?? fail('NOT_FOUND', `current plan ${account.planId} not found`)
    const newPlan = targetPlan ?? fail('NOT_FOUND', `target plan ${newPlanId} not found`)

    if (newPlan.ownerId !== null && newPlan.ownerId !== account.ownerId) {
      fail('FORBIDDEN', 'target plan belongs to another reseller')
    }

    const impact = changePlanImpact(oldPlan, newPlan, usage)
    const allowed = impact.violations.length === 0

    let resellerFits = true
    if (account.ownerId !== null) {
      const reseller = await this.store.getReseller(account.ownerId)
      const usageSummary = await this.store.resellerUsage(account.ownerId)
      if (reseller && !reseller.oversell) {
        if (
          reseller.totalDiskMb !== 'unlimited' &&
          (newPlan.resources.diskMb === 'unlimited' ||
            usageSummary.diskMb === 'unlimited' ||
            (oldPlan.resources.diskMb !== 'unlimited' &&
              usageSummary.diskMb - oldPlan.resources.diskMb + newPlan.resources.diskMb >
                reseller.totalDiskMb))
        ) {
          resellerFits = false
        }
        if (
          reseller.totalBandwidthMb !== 'unlimited' &&
          (newPlan.resources.bandwidthMbMonth === 'unlimited' ||
            usageSummary.bandwidthMb === 'unlimited' ||
            (oldPlan.resources.bandwidthMbMonth !== 'unlimited' &&
              usageSummary.bandwidthMb -
                oldPlan.resources.bandwidthMbMonth +
                newPlan.resources.bandwidthMbMonth >
                reseller.totalBandwidthMb))
        ) {
          resellerFits = false
        }
      }
    }

    return {
      accountId: account.id,
      username: account.username,
      currentPlanId: oldPlan.id,
      targetPlanId: newPlan.id,
      usage,
      impact,
      allowed,
      resellerFits,
      effectiveShellBefore: system.effectiveShell(account, oldPlan),
      effectiveShellAfter: system.effectiveShell(account, newPlan),
      sliceName: sliceUnit(account.uid),
    }
  }

  /**
   * Changes an account's hosting plan, enforces capability & reseller limits,
   * reconciles the host (updating systemd slice limits, filesystem quota, PHP-FPM pool caps,
   * and login shell), and updates the SQLite index.
   */
  async applyPlanChange(input: ApplyPlanChangeInput): Promise<ApplyPlanChangeResult> {
    const existing =
      (await this.store.getAccount(input.accountId)) ??
      fail('NOT_FOUND', `account ${input.accountId} not found`)

    await this.authorizeResellerOrRoot(input.actor, 'change-plan', existing.ownerId)

    const preview = await this.previewPlanChange(existing.id, input.newPlanId, {
      actor: input.actor,
      ...(input.usageOverrides !== undefined && { usageOverrides: input.usageOverrides }),
    })

    if (!preview.allowed) {
      fail(
        'LIMIT_EXCEEDED',
        `Account usage exceeds the new plan limits (${preview.impact.violations.map((v) => v.key).join(', ')})`,
        { violations: preview.impact.violations },
      )
    }

    const updated = await this.store.changePlan(existing.id, input.newPlanId)

    let reconciliation: ReconcileResult | null = null
    if (this.reconciler && input.reconcile !== false) {
      reconciliation = await this.reconciler.reconcile({
        actor: actorLabel(input.actor),
        force: true,
        scope: { accountId: updated.id, resellerId: updated.ownerId },
      })
      if (reconciliation.status === 'failed') {
        fail('PRECONDITION_FAILED', `host reconciliation failed during plan change: ${reconciliation.error}`)
      }
    } else {
      const snap = await this.store.readSnapshot()
      await reindexFromState(this.db, snap)
    }

    await appendAudit(this.db, {
      actor: actorLabel(input.actor),
      action: 'account.plan_changed',
      target: `account:${updated.username}`,
      detail: {
        accountId: updated.id,
        previousPlanId: existing.planId,
        newPlanId: updated.planId,
        sliceName: preview.sliceName,
      },
      outcome: 'ok',
    })

    return {
      account: updated,
      preview,
      reconciliation,
    }
  }

  /**
   * Returns a multi-tenant scoped reseller summary (usage, owned accounts, usable plans),
   * strictly enforcing reseller isolation so one reseller can never view another reseller's tenants.
   */
  async getResellerDashboardSummary(
    actor: Principal,
    resellerId: Id,
  ): Promise<ResellerDashboardSummary> {
    await this.authorizeResellerOrRoot(actor, 'list-accounts', resellerId)

    const [reseller, usage, accounts, allPlans] = await Promise.all([
      this.store.getReseller(resellerId),
      this.store.resellerUsage(resellerId),
      this.store.listAccounts({ ownerId: resellerId }),
      this.store.listPlans(),
    ])

    const resellerRecord =
      reseller ?? fail('NOT_FOUND', `reseller ${resellerId} not found`)
    const plans = allPlans.filter((p) => p.ownerId === null || p.ownerId === resellerId)

    return {
      reseller: resellerRecord,
      usage,
      accounts,
      plans,
    }
  }

  /**
   * Transfers ownership of an account between root (`null`) and a reseller (or between resellers).
   * Root-only operation (`actor.kind === 'root'`).
   */
  async transferAccountOwnership(input: TransferOwnershipInput): Promise<TransferOwnershipResult> {
    if (input.actor.kind !== 'root') {
      fail('FORBIDDEN', 'only root is allowed to transfer account ownership')
    }

    const existing =
      (await this.store.getAccount(input.accountId)) ??
      fail('NOT_FOUND', `account ${input.accountId} not found`)

    if (input.targetPlanId && input.targetPlanId !== existing.planId) {
      const targetPlan =
        (await this.store.getPlan(input.targetPlanId)) ??
        fail('NOT_FOUND', `target plan ${input.targetPlanId} not found`)
      if (targetPlan.ownerId !== null && targetPlan.ownerId !== input.newOwnerId) {
        fail('FORBIDDEN', 'target plan belongs to another reseller')
      }
      if (targetPlan.ownerId === null) {
        await this.store.changePlan(existing.id, targetPlan.id)
        await this.store.changeOwner(existing.id, input.newOwnerId)
      } else {
        await this.store.changeOwner(existing.id, input.newOwnerId)
        await this.store.changePlan(existing.id, targetPlan.id)
      }
    } else {
      await this.store.changeOwner(existing.id, input.newOwnerId)
    }

    const updated =
      (await this.store.getAccount(existing.id)) ??
      fail('NOT_FOUND', `account ${existing.id} not found after ownership transfer`)

    let reconciliation: ReconcileResult | null = null
    if (this.reconciler && input.reconcile !== false) {
      reconciliation = await this.reconciler.reconcile({
        actor: actorLabel(input.actor),
        force: true,
        scope: { accountId: updated.id, resellerId: updated.ownerId },
      })
    } else {
      const snap = await this.store.readSnapshot()
      await reindexFromState(this.db, snap)
    }

    await appendAudit(this.db, {
      actor: actorLabel(input.actor),
      action: 'account.owner_changed',
      target: `account:${updated.username}`,
      detail: {
        accountId: updated.id,
        previousOwnerId: existing.ownerId,
        newOwnerId: updated.ownerId,
        planId: updated.planId,
      },
      outcome: 'ok',
    })

    return {
      account: updated,
      previousOwnerId: existing.ownerId,
      newOwnerId: updated.ownerId,
      reconciliation,
    }
  }

  /**
   * Suspends an account across every control-plane and host surface (A34):
   * 1. Panel login disabled & all active sessions + API tokens immediately revoked
   * 2. SSH/shell changed to `/usr/sbin/nologin`
   * 3. Pure-FTPd virtual users omitted & `.pdb` regenerated
   * 4. WebDisk access denied via disabled principal / revoked tokens
   * 5. Dovecot IMAP/POP3/SMTP-submission login denied (`nologin=y reason=suspended`) & delivery deferred
   * 6. MariaDB database users locked (`ALTER USER ... ACCOUNT LOCK`)
   * 7. Account systemd cron timers stopped & disabled
   * 8. Account cgroup slice (`xpanel-<uid>.slice` and `user-<uid>.slice`) & PHP-FPM pools stopped
   * 9. Edge/backend vhosts switched to the HTTP 503 suspended maintenance page
   */
  async suspendAccount(input: SuspendAccountInput): Promise<SuspensionTransitionResult> {
    const existing =
      (await this.store.getAccount(input.accountId)) ??
      fail('NOT_FOUND', `account ${input.accountId} not found`)

    await this.authorizeResellerOrRoot(input.actor, 'suspend-account', existing.ownerId)

    const suspended = await this.store.suspendAccount(existing.id, input.reason)
    const effects = suspensionEffects(suspended)

    // 1. Disable panel principal & revoke all active sessions and API tokens
    const principal = await findPrincipalByAccountId(this.db, suspended.id)
    let activeSessionsRemaining = 0
    if (principal) {
      await setPrincipalDisabled(this.db, principal.id, true)
      await revokeAllSessionsForPrincipal(this.db, principal.id)
      await revokeAllApiTokensForPrincipal(this.db, principal.id)
      const remaining = await listSessionsForPrincipal(this.db, principal.id)
      activeSessionsRemaining = remaining.filter((s) => s.revokedAt === null).length
    }

    // 2. Reconcile host (shell -> nologin, vhosts -> 503 suspended page, FPM stopped, cron stopped, Dovecot denied, FTP omitted)
    let reconciliation: ReconcileResult | null = null
    if (this.reconciler && input.reconcile !== false) {
      reconciliation = await this.reconciler.reconcile({
        actor: actorLabel(input.actor),
        force: true,
        scope: { accountId: suspended.id, resellerId: suspended.ownerId },
      })
      if (reconciliation.status === 'failed') {
        fail('PRECONDITION_FAILED', `host reconciliation failed during account suspension: ${reconciliation.error}`)
      }
    } else {
      const snap = await this.store.readSnapshot()
      await reindexFromState(this.db, snap)
    }

    // 3. Stop account slices and lock MariaDB database users on the executor
    const dbUsers = await this.store.listDatabaseUsers(suspended.id)
    const lockedDatabaseUsers = dbUsers.map((u) => u.name)

    if (this.executor) {
      await this.executor.runAction({
        kind: 'systemd',
        verb: 'stop',
        unit: sliceUnit(suspended.uid),
      })
      await this.executor.runAction({
        kind: 'systemd',
        verb: 'stop',
        unit: userSliceUnit(suspended.uid),
      })
      if (lockedDatabaseUsers.length > 0) {
        await this.executor.runAction({
          kind: 'sql',
          engine: 'mariadb',
          statements: lockedDatabaseUsers.map(
            (name) => `ALTER USER '${name}'@'localhost' ACCOUNT LOCK;`,
          ),
        })
      }
    }

    await appendAudit(this.db, {
      actor: actorLabel(input.actor),
      action: 'account.suspended',
      target: `account:${suspended.username}`,
      detail: {
        accountId: suspended.id,
        reason: suspended.suspendReason,
        lockedDatabaseUsers,
        slice: sliceUnit(suspended.uid),
      },
      outcome: 'ok',
    })

    return {
      account: suspended,
      effects,
      panelPrincipalDisabled: principal ? true : false,
      activeSessionsRemaining,
      lockedDatabaseUsers,
      unlockedDatabaseUsers: [],
      reconciliation,
    }
  }

  /**
   * Unsuspends an account and restores all configured services cleanly (A34).
   */
  async unsuspendAccount(input: UnsuspendAccountInput): Promise<SuspensionTransitionResult> {
    const existing =
      (await this.store.getAccount(input.accountId)) ??
      fail('NOT_FOUND', `account ${input.accountId} not found`)

    await this.authorizeResellerOrRoot(input.actor, 'suspend-account', existing.ownerId)

    const active = await this.store.unsuspendAccount(existing.id)
    const effects = suspensionEffects(active)

    const principal = await findPrincipalByAccountId(this.db, active.id)
    let activeSessionsRemaining = 0
    if (principal) {
      await setPrincipalDisabled(this.db, principal.id, false)
      const remaining = await listSessionsForPrincipal(this.db, principal.id)
      activeSessionsRemaining = remaining.filter((s) => s.revokedAt === null).length
    }

    let reconciliation: ReconcileResult | null = null
    if (this.reconciler && input.reconcile !== false) {
      reconciliation = await this.reconciler.reconcile({
        actor: actorLabel(input.actor),
        force: true,
        scope: { accountId: active.id, resellerId: active.ownerId },
      })
      if (reconciliation.status === 'failed') {
        fail('PRECONDITION_FAILED', `host reconciliation failed during account unsuspension: ${reconciliation.error}`)
      }
    } else {
      const snap = await this.store.readSnapshot()
      await reindexFromState(this.db, snap)
    }

    const dbUsers = await this.store.listDatabaseUsers(active.id)
    const unlockedDatabaseUsers = dbUsers.map((u) => u.name)

    if (this.executor) {
      await this.executor.runAction({
        kind: 'systemd',
        verb: 'start',
        unit: sliceUnit(active.uid),
      })
      if (unlockedDatabaseUsers.length > 0) {
        await this.executor.runAction({
          kind: 'sql',
          engine: 'mariadb',
          statements: unlockedDatabaseUsers.map(
            (name) => `ALTER USER '${name}'@'localhost' ACCOUNT UNLOCK;`,
          ),
        })
      }
    }

    await appendAudit(this.db, {
      actor: actorLabel(input.actor),
      action: 'account.unsuspended',
      target: `account:${active.username}`,
      detail: {
        accountId: active.id,
        unlockedDatabaseUsers,
        slice: sliceUnit(active.uid),
      },
      outcome: 'ok',
    })

    return {
      account: active,
      effects,
      panelPrincipalDisabled: false,
      activeSessionsRemaining,
      lockedDatabaseUsers: [],
      unlockedDatabaseUsers,
      reconciliation,
    }
  }

  /**
   * Safely and completely terminates an account across all control-plane and host surfaces (A22, A35).
   */
  async terminateAccount(input: TerminateAccountInput): Promise<TerminateAccountResult> {
    const existing =
      (await this.store.getAccount(input.accountId)) ??
      fail('NOT_FOUND', `account ${input.accountId} not found`)

    await this.authorizeResellerOrRoot(input.actor, 'terminate-account', existing.ownerId)

    if (input.confirmUsername !== existing.username) {
      fail('VALIDATION', 'termination confirmation must match the exact account username', {
        expected: existing.username,
        received: input.confirmUsername,
      })
    }

    // Collect pre-termination inventory for audit & verification
    const [domains, dbs, dbUsers, serviceUsers, cronJobs, zones, certs] = await Promise.all([
      this.store.listDomains({ accountId: existing.id }),
      this.store.listDatabases(existing.id, { includeTrashed: true }),
      this.store.listDatabaseUsers(existing.id),
      this.store.listServiceUsers(existing.id),
      this.store.listCronJobs(existing.id),
      this.store.listDnsZones(existing.id),
      this.store.listCertificates(existing.id),
    ])

    // Remove account-owned DNS zones and certificates so candidate generation diff removes their host files
    for (const z of zones) {
      await this.store.deleteDnsZone(z.name)
    }
    for (const c of certs) {
      await this.store.deleteCertificate(c.id)
    }

    // Revoke sessions & tokens and delete the panel principal
    const principal = await findPrincipalByAccountId(this.db, existing.id)
    if (principal) {
      await revokeAllSessionsForPrincipal(this.db, principal.id)
      await revokeAllApiTokensForPrincipal(this.db, principal.id)
      await deletePrincipal(this.db, principal.id)
    }

    await this.store.markTerminating(existing.id)

    let reconciliation: ReconcileResult | null = null
    if (this.reconciler && input.reconcile !== false) {
      reconciliation = await this.reconciler.reconcile({
        actor: actorLabel(input.actor),
        force: true,
        scope: { accountId: existing.id, resellerId: existing.ownerId },
      })
      if (reconciliation.status === 'failed') {
        fail('PRECONDITION_FAILED', `host reconciliation failed during account termination: ${reconciliation.error}`)
      }
    } else {
      await this.store.deleteAccount(existing.id)
      const snap = await this.store.readSnapshot()
      await reindexFromState(this.db, snap)
    }

    await appendAudit(this.db, {
      actor: actorLabel(input.actor),
      action: 'account.terminated',
      target: `account:${existing.username}`,
      detail: {
        accountId: existing.id,
        burnedUid: existing.uid,
        removedDomains: domains.map((d) => d.name),
        removedDatabases: dbs.map((d) => d.name),
        removedDatabaseUsers: dbUsers.map((u) => u.name),
        removedServiceUsers: serviceUsers.map((u) => u.login),
        removedCronJobIds: cronJobs.map((c) => c.id),
        removedZones: zones.map((z) => z.name),
      },
      outcome: 'ok',
    })

    return {
      terminatedAccountId: existing.id,
      username: existing.username,
      burnedUid: existing.uid,
      removedDomains: domains.map((d) => d.name),
      removedDatabases: dbs.map((d) => d.name),
      removedDatabaseUsers: dbUsers.map((u) => u.name),
      removedServiceUsers: serviceUsers.map((u) => u.login),
      removedCronJobIds: cronJobs.map((c) => c.id),
      removedZones: zones.map((z) => z.name),
      reconciliation,
    }
  }
}
