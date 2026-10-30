import { assertAcl, fail, isUuid, isXpanelError, type Account, type ErrorCode, type Plan, type Principal, type Reseller } from '@xpanel/core'
import {
  assertProvisioningReply,
  canonicalProvisioningIdentity,
  parseProvisioningReconcileRequest,
  type ProvisioningReconcileReply,
  type ProvisioningReconcileRequest,
} from '../../../packages/core/src/account-provisioning-contract.ts'
import { LinuxHostExecutor } from './executor.ts'

/** Independently verified preparation facts. The password hash is not part of this view. */
export interface VerifiedPreparationMetadata {
  readonly reference: string
  readonly actorKey: string
  readonly operationKey: string
  readonly requestIdentity: string
  readonly preparationIdentity: string
  readonly desiredStateDigest: string
  readonly planIdentity: string
  readonly phase: 'complete'
}

/**
 * Supplied by trusted agent startup. Absence refuses before host effects.
 * `execute` is the only native entry; this handler never calls `/reconcile`.
 */
export interface AgentAccountProvisioningRuntime {
  readPreparation(input: {
    reference: string
    actorKey: string
    operationKey: string
  }): Promise<VerifiedPreparationMetadata>
  execute(input: {
    request: ProvisioningReconcileRequest
    actor: Principal
    account: Account
    scope: { accountId: string; resellerId: string | null }
  }, context: {
    signal: AbortSignal
    assertAuthority(): Promise<void>
  }): Promise<ProvisioningReconcileReply>
}

export interface ProvisioningPrincipalView {
  readonly id: string
  readonly kind: 'root' | 'reseller' | 'user'
  readonly username: string
  readonly disabled: boolean
}

export interface ProvisioningJobView {
  readonly id: string
  readonly kind: string
  readonly accountId: string | null
  readonly actor: string
  readonly status: string
  readonly leaseOwner: string | null
  readonly fencingToken: number
  readonly leaseExpiresAt: string | null
  readonly requestFingerprint: string
  readonly idempotencyKey: string | null
  readonly attempt: number
  readonly checkpointData: Record<string, unknown>
  readonly completedSteps: readonly string[]
  readonly cancelRequested: boolean
  readonly needsAttention: boolean
}

/** Pure read ports. They are test seams, not native proof. */
export interface AccountProvisioningReadPorts {
  getPrincipal(id: string): Promise<ProvisioningPrincipalView | null>
  getDurableJob(id: string): Promise<ProvisioningJobView | null>
  getAccount(id: string): Promise<Account | null>
  readSnapshot(): Promise<{ readonly checksum: string; readonly revision?: number }>
  getDnsZone(name: string): Promise<unknown>
  getPlan(id: string): Promise<Plan | null>
  getReseller(id: string): Promise<Reseller | null>
}

export interface AccountProvisioningHandlerInput {
  /** Authenticated `x-xpanel-principal-id`. A body actor is not accepted in its place. */
  readonly principalId: string | null | undefined
  readonly request: Request
  readonly runtime?: AgentAccountProvisioningRuntime
  readonly executor?: unknown
  readonly ports: AccountProvisioningReadPorts
}

interface HostCheckpoint {
  readonly accountId: string
  readonly username: string
  readonly uid: number
  readonly gid: number
  readonly home: string
  readonly primaryDomain: string
  readonly planId: string
  readonly ownerId: string | null
  readonly preparationReference: string
  readonly preparationIdentity: string
  readonly desiredZoneIdentity: string
  readonly hostAttempt: number
  readonly hostNoEffectAttempt: null
}

const HEX = /^[0-9a-f]{64}$/
const activeHostEffects = new Set<string>()
const json = (body: unknown): Response => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
})
const closed = (code: ErrorCode, message: string, detail: Record<string, unknown> = {}): never =>
  fail(code, message, { stateChanged: false, ...detail })
const whole = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)

const readBody = async (request: Request): Promise<unknown> => {
  const raw = await request.text()
  if (Buffer.byteLength(raw) > 65_536) closed('VALIDATION', 'account provisioning request exceeds its bounded body size')
  try { return JSON.parse(raw) } catch { return closed('VALIDATION', 'account provisioning request must be valid JSON') }
}

const checkpointOf = (data: Record<string, unknown> | null | undefined): HostCheckpoint => {
  if (!data) closed('PRECONDITION_FAILED', 'account provisioning host effects require a saved account checkpoint')
  const accountId = data.accountId
  const username = data.username
  const uid = data.uid
  const gid = data.gid
  const home = data.home
  const primaryDomain = data.primaryDomain
  const planId = data.planId
  const ownerId = data.ownerId
  const preparationReference = data.preparationReference
  const preparationIdentity = data.preparationIdentity
  const desiredZoneIdentity = data.desiredZoneIdentity
  const hostAttempt = data.hostAttempt
  if (typeof accountId !== 'string' || typeof username !== 'string' || !whole(uid) || uid < 1
    || !whole(gid) || gid < 1 || typeof home !== 'string' || typeof primaryDomain !== 'string'
    || typeof planId !== 'string' || !(ownerId === null || typeof ownerId === 'string')
    || typeof preparationReference !== 'string' || typeof preparationIdentity !== 'string' || !HEX.test(preparationIdentity)
    || typeof desiredZoneIdentity !== 'string' || !HEX.test(desiredZoneIdentity) || !whole(hostAttempt) || hostAttempt < 1
    || !Object.hasOwn(data, 'hostNoEffectAttempt') || data.hostNoEffectAttempt !== null) {
    closed('PRECONDITION_FAILED', 'account provisioning host effects require the current account checkpoint')
  }
  return {
    accountId, username, uid, gid, home, primaryDomain, planId, ownerId, preparationReference,
    preparationIdentity, desiredZoneIdentity, hostAttempt, hostNoEffectAttempt: null,
  }
}

/**
 * POST /host/account-provisioning. Peer, service and principal admission stay in the agent server.
 * This function binds the saved account, checkpoint, fence and current lease, then asks the runtime to execute.
 */
export async function handleAccountProvisioning(input: AccountProvisioningHandlerInput): Promise<Response> {
  if (!isUuid(input.principalId)) closed('UNAUTHENTICATED', 'an authenticated principal is required')
  const principalId = input.principalId
  if (!input.runtime) closed('SERVICE_UNAVAILABLE', 'account provisioning runtime is not connected', { reason: 'account_provisioning_runtime_unavailable' })
  if (!(input.executor instanceof LinuxHostExecutor)) closed('PRECONDITION_FAILED', 'account provisioning requires the native Linux host executor', { reason: 'linux_host_executor_required' })
  const runtime = input.runtime
  const url = new URL(input.request.url)
  if (input.request.method.toUpperCase() !== 'POST' || url.pathname !== '/host/account-provisioning') {
    closed('VALIDATION', 'account provisioning is only available as POST /host/account-provisioning')
  }
  if (url.search) closed('VALIDATION', 'account provisioning does not accept query selectors')
  if (input.request.signal.aborted) closed('PRECONDITION_FAILED', 'account provisioning was cancelled before host effects')
  const request = parseProvisioningReconcileRequest(await readBody(input.request))
  const loaded = await bind(input.ports, principalId, request)
  const flight = `${loaded.job.id}:${loaded.job.fencingToken}`
  if (activeHostEffects.has(flight)) {
    fail('CONFLICT', 'account provisioning host execution is already bound to this fence', { stateChanged: false })
  }
  let started = false
  const assertAuthority = async (): Promise<void> => {
    let current: BoundProvisioning
    try {
      current = await bind(input.ports, principalId, request)
      await bindPreparation(input.ports, runtime, current, request)
    } catch (error) {
      if (started && isXpanelError(error)) {
        fail(error.code, error.message, { ...error.detail, stateChanged: true, verificationRequired: true })
      }
      throw error
    }
    if (current.principal.id !== loaded.principal.id || current.principal.kind !== loaded.principal.kind
      || current.principal.username !== loaded.principal.username || current.job.fencingToken !== loaded.job.fencingToken
      || current.job.leaseOwner !== loaded.job.leaseOwner || current.job.attempt !== loaded.job.attempt
      || current.account.id !== loaded.account.id || current.account.uid !== loaded.account.uid
      || current.account.home !== loaded.account.home || current.account.planId !== loaded.account.planId
      || current.snapshotRevision !== loaded.snapshotRevision || current.snapshotChecksum !== loaded.snapshotChecksum) {
      fail('CONFLICT', 'account provisioning authority changed before the result was acknowledged', started
        ? { stateChanged: true, verificationRequired: true }
        : { stateChanged: false })
    }
  }
  activeHostEffects.add(flight)
  try {
    await assertAuthority()
    started = true
    const reply = await runtime.execute({
      request,
      actor: { id: loaded.principal.id, kind: loaded.principal.kind, username: loaded.principal.username },
      account: loaded.account,
      scope: { accountId: loaded.account.id, resellerId: loaded.account.ownerId },
    }, { signal: input.request.signal, assertAuthority })
    await assertAuthority()
    if (!reply || typeof reply !== 'object' || reply.reconciliation == null) {
      fail('PRECONDITION_FAILED', 'a null reconciliation is not a verified host effect', {
        stateChanged: true, verificationRequired: true, freshExecution: false,
      })
    }
    const execution = assertProvisioningReply(request, reply)
    return json({
      binding: reply.binding,
      outcome: reply.outcome,
      reconciliation: reply.reconciliation,
      ...(execution ? { execution } : {}),
    })
  } finally {
    activeHostEffects.delete(flight)
  }
}

interface BoundProvisioning {
  readonly principal: ProvisioningPrincipalView
  readonly account: Account
  readonly job: ProvisioningJobView
  readonly checkpoint: HostCheckpoint
  readonly snapshotRevision: number
  readonly snapshotChecksum: string
}

const bind = async (ports: AccountProvisioningReadPorts, principalId: string, request: ProvisioningReconcileRequest): Promise<BoundProvisioning> => {
  const principal = await ports.getPrincipal(principalId)
  if (!principal || principal.disabled || principal.id !== principalId) closed('UNAUTHENTICATED', 'an enabled authenticated principal is required')
  const claim = request.authority.actor
  if (claim.id !== principal.id || claim.kind !== principal.kind || claim.username !== principal.username) {
    closed('FORBIDDEN', 'the request actor is not the authenticated principal')
  }
  if (principal.kind === 'user') closed('FORBIDDEN', 'user principals cannot provision accounts')
  if (principal.kind !== 'root' && principal.kind !== 'reseller') closed('FORBIDDEN', 'account provisioning requires a privileged actor')
  const claimed = request.authority.account
  const account = await ports.getAccount(claimed.id)
  if (!account) closed('NOT_FOUND', 'provisioning account was not found')
  if (account.status !== 'active') closed('FORBIDDEN', 'account is not active')
  if (account.id !== claimed.id || account.username !== claimed.username || account.ownerId !== claimed.ownerId
    || account.planId !== claimed.planId || account.uid !== claimed.uid || account.gid !== claimed.gid
    || account.home !== claimed.home || account.primaryDomain !== claimed.primaryDomain) {
    closed('CONFLICT', 'the account claim does not match current account state')
  }
  if (principal.kind === 'reseller') {
    if (account.ownerId !== principal.id) closed('FORBIDDEN', 'account belongs to another reseller')
    assertAcl({ id: principal.id, kind: 'reseller', username: principal.username }, await ports.getReseller(principal.id), 'create-account')
  }
  const snapshot = await ports.readSnapshot()
  const desired = request.authority.desired
  if (snapshot.revision !== desired.revision || snapshot.checksum !== desired.checksum) {
    closed('CONFLICT', 'the saved source revision does not match the provisioning request')
  }
  const job = await ports.getDurableJob(request.authority.operation.id)
  if (!job || job.kind !== 'account.provision' || job.status !== 'running' || job.cancelRequested || job.needsAttention) {
    closed('CONFLICT', 'the provisioning job is not an active account.provision operation')
  }
  if (job.id !== request.authority.operation.id || job.actor !== `${principal.kind}:${principal.username}`
    || job.requestFingerprint !== request.authority.operation.requestFingerprint
    || job.leaseOwner !== request.authority.operation.workerId || !job.idempotencyKey) {
    closed('CONFLICT', 'the provisioning job is not bound to the authenticated operation')
  }
  if (job.accountId !== null && job.accountId !== account.id) closed('CONFLICT', 'the provisioning job is bound to another account')
  // Heartbeat renewal changes leaseExpiresAt. The fence and owner are the authority, not the request's old expiry.
  if (job.fencingToken !== request.authority.operation.fencingToken) {
    closed('CONFLICT', 'the provisioning fence does not match the current lease')
  }
  const expires = Date.parse(job.leaseExpiresAt ?? '')
  if (!job.leaseExpiresAt || !Number.isFinite(expires) || expires <= Date.now()) {
    closed('CONFLICT', 'the current provisioning lease is not valid')
  }
  const checkpoint = checkpointOf(job.checkpointData)
  if (checkpoint.accountId !== account.id || checkpoint.username !== account.username || checkpoint.uid !== account.uid
    || checkpoint.gid !== account.gid || checkpoint.home !== account.home || checkpoint.primaryDomain !== account.primaryDomain
    || checkpoint.planId !== account.planId || checkpoint.ownerId !== account.ownerId
    || checkpoint.preparationReference !== desired.preparationReference || checkpoint.preparationIdentity !== desired.preparationIdentity) {
    closed('CONFLICT', 'the saved account checkpoint does not match the current account')
  }
  if (!job.completedSteps.includes('reconcile_host_intent') || checkpoint.hostAttempt !== job.attempt) {
    closed('PRECONDITION_FAILED', 'account provisioning host effects require the current intent checkpoint')
  }
  if (job.completedSteps.includes('reconcile_host') || checkpoint.hostNoEffectAttempt !== null) {
    fail('PRECONDITION_FAILED', 'completed account provisioning is not a fresh host execution', { stateChanged: false, freshExecution: false })
  }
  const zone = await ports.getDnsZone(account.primaryDomain)
  if (!zone || typeof zone !== 'object' || Array.isArray(zone)) closed('CONFLICT', 'the account zone does not match the saved DNS intent')
  const zoneRecord = zone as { accountId?: unknown; name?: unknown }
  if (zoneRecord.name !== account.primaryDomain || (zoneRecord.accountId !== undefined && zoneRecord.accountId !== account.id)
    || canonicalProvisioningIdentity(zone) !== checkpoint.desiredZoneIdentity) {
    closed('CONFLICT', 'the account zone does not match the saved DNS intent')
  }
  return { principal, account, job, checkpoint, snapshotRevision: desired.revision, snapshotChecksum: desired.checksum }
}

const bindPreparation = async (
  ports: AccountProvisioningReadPorts,
  runtime: AgentAccountProvisioningRuntime,
  bound: BoundProvisioning,
  request: ProvisioningReconcileRequest,
): Promise<void> => {
  const metadata = await runtime.readPreparation({
    reference: request.authority.desired.preparationReference,
    actorKey: `${bound.principal.kind}:${bound.principal.id}`,
    operationKey: bound.job.idempotencyKey ?? '',
  })
  const desired = request.authority.desired
  if (!metadata || metadata.phase !== 'complete' || metadata.reference !== desired.preparationReference
    || metadata.actorKey !== `${bound.principal.kind}:${bound.principal.id}` || metadata.operationKey !== bound.job.idempotencyKey
    || !HEX.test(metadata.requestIdentity) || metadata.preparationIdentity !== desired.preparationIdentity
    || !HEX.test(metadata.desiredStateDigest) || !HEX.test(metadata.planIdentity)) {
    closed('PRECONDITION_FAILED', 'the saved account preparation is not a completed match for this operation')
  }
  const plan = await ports.getPlan(bound.account.planId)
  if (!plan || plan.id !== bound.account.planId || (plan.ownerId !== null && plan.ownerId !== bound.account.ownerId)
    || canonicalProvisioningIdentity(plan) !== metadata.planIdentity) {
    closed('CONFLICT', 'the current plan is not the plan bound to this preparation')
  }
}
