import { randomUUID } from 'node:crypto'
import { fail, msgid } from '@xpanel/core'
import { applicationDigest, isApplicationArtifactPath, isApplicationDigest, isApplicationId, isApplicationVersion, verifyApplicationArtifact } from '../../../packages/os/src/application-artifact.ts'
import type { ApplicationArtifactDescriptor, ApplicationArtifactFile, VerifiedApplicationArtifact } from '../../../packages/os/src/application-artifact.ts'
import { assertApplicationCatalogCurrent, compareApplicationVersions, selectApplicationRelease } from './application-catalog.ts'
import type { ApplicationCatalogPolicy, VerifiedApplicationCatalog } from './application-catalog.ts'
import type { HostJobCommandResult, HostJobCommandStep, HostJobPlan, HostJobRun, HostJobStepRun } from './host-job-contract.ts'

export type ApplicationInstallAction = 'install' | 'update' | 'remove' | 'rollback'
export type ApplicationInstallAuthorityAction = ApplicationInstallAction | 'read'
export interface ApplicationInstallRequest { readonly action: ApplicationInstallAction; readonly appId: string; readonly version?: string; readonly expectedRevision: string; readonly expectedCatalogRevision: string }
/** Derived from the current account + owned domain under the canonical account lifecycle lease. No caller path. */
export interface ApplicationTarget { readonly accountId: string; readonly domainId: string; readonly uid: number; readonly gid: number; readonly identity: string }
export interface ApplicationInstalledVersion { readonly appId: string; readonly version: string; readonly artifactSha256: string; readonly files: readonly ApplicationArtifactFile[] }
export interface ApplicationObservedState {
  readonly revision: string
  readonly unmanagedRevision: string
  readonly empty: boolean
  readonly managedClean: boolean
  readonly recoveryRequired: boolean
  readonly installation: (ApplicationInstalledVersion & { readonly previous: ApplicationInstalledVersion | null }) | null
}
export interface ApplicationRecovery {
  readonly transactionId: string
  readonly state: 'committed' | 'restored' | 'not_started' | 'unknown'
  readonly beforeRevision: string
  readonly committedRevision: string | null
  readonly observation: ApplicationObservedState
}
export interface ApplicationTransactionIntent {
  readonly transactionId: string
  readonly action: ApplicationInstallAction
  readonly appId: string
  readonly catalogRevision: string
  readonly catalogSequence: number
  readonly expectedRevision: string
  readonly next: Readonly<ApplicationInstalledVersion> | null
}
/**
 * Trusted native port only: every operation is relative to held no-follow directory descriptors,
 * rechecks the original uid/gid/inode identity, and holds an exclusive per-target transaction lock.
 * snapshot persists/fsyncs complete exact managed-file + metadata preimages before apply can start.
 * apply changes only that snapshot's owned path set, preserving unrelated files; recover uses CAS,
 * never overwrites concurrent data, and proves restored/committed state from digest readback.
 * A deadline abort must drain all underlying effects before a method resolves or rejects.
 */
export interface ApplicationTargetSession {
  readonly target: ApplicationTarget
  observe(signal: AbortSignal): Promise<ApplicationObservedState>
  snapshot(intent: ApplicationTransactionIntent, before: ApplicationObservedState, signal: AbortSignal): Promise<{ transactionId: string; beforeRevision: string; durable: true }>
  apply(intent: ApplicationTransactionIntent, artifact: VerifiedApplicationArtifact | null, signal: AbortSignal): Promise<void>
  commit(transactionId: string, expectedRevision: string, signal: AbortSignal): Promise<{ transactionId: string; committedRevision: string }>
  recover(transactionId: string, signal: AbortSignal): Promise<ApplicationRecovery>
  close(): Promise<void>
}
/** Never construct from a request or mere binary presence. No native implementation is supplied here. */
export interface ApplicationArtifactProvider {
  readonly admission: Readonly<{ descriptorConfinement: true; accountLifetimeFence: true; durablePreimages: true; scopedWrites: true; digestReadback: true; boundedDeadlines: true; contentAddressedEgress: true }>
  /** Configured trusted content store only, keyed by signed digest; enforces the byte cap while reading. */
  readArtifact(descriptor: ApplicationArtifactDescriptor, signal: AbortSignal): Promise<Uint8Array>
  /** Opening descriptors is read-only; a failed open must not create a transaction or change account files. */
  openTarget(target: ApplicationTarget, signal: AbortSignal): Promise<ApplicationTargetSession>
  /** Persisted server journals only, descriptor-bound to this account target; never request-provided. */
  pendingTransactions(target: ApplicationTarget, signal: AbortSignal): Promise<readonly { transactionId: string; beforeRevision: string; expectedCommittedRevision: string | null }[]>
}
export interface ApplicationInstallDeps {
  provider: ApplicationArtifactProvider | null
  catalog: () => Promise<VerifiedApplicationCatalog>
  policy: () => ApplicationCatalogPolicy
  /** Fresh account/domain authorization; returns server-derived immutable ownership identity. */
  assertFresh: (action: ApplicationInstallAuthorityAction) => Promise<ApplicationTarget>
  /** Credential/permission revalidation inside the lease; MUST NOT re-enter StateStore. */
  assertAuthority: (action: ApplicationInstallAuthorityAction) => Promise<void>
  /** The existing canonical StateStore account lifecycle lease; cleanup also retains identity exclusion. */
  withAccountLease: <T>(target: ApplicationTarget, operation: (fresh: ApplicationTarget) => Promise<T>) => Promise<T>
}

// This path is an IPC dispatch marker, not permission to execute a root helper. The dedicated
// coordinator run port MUST intercept it; generic host/native command runners must never admit it.
export const APPLICATION_TRANSACTION_COMMAND = '/usr/libexec/xpanel/application-transaction'
const STAGES = ['snapshot', 'apply', 'readback', 'commit', 'recover'] as const
type Stage = typeof STAGES[number]
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const TIMEOUT: Readonly<Record<Stage, number>> = Object.freeze({ snapshot: 60_000, apply: 120_000, readback: 60_000, commit: 30_000, recover: 120_000 })
const unchanged = { stateChanged: false }
const invalid = (): never => fail('VALIDATION', 'the application installation intent or observation is invalid', unchanged)
const unavailable = (): never => fail('PRECONDITION_FAILED', 'application writes require an admitted descriptor-confined account artifact provider', { ...unchanged, reason: 'application_provider_unavailable' })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, fields: readonly string[]): boolean => Object.keys(value).sort().join(',') === [...fields].sort().join(',')

export function readApplicationInstallRequest(value: unknown): Readonly<ApplicationInstallRequest> {
  if (!object(value) || !['install', 'update', 'remove', 'rollback'].includes(String(value.action)) || !isApplicationId(value.appId) || !isApplicationDigest(value.expectedRevision) || !isApplicationDigest(value.expectedCatalogRevision)) return invalid()
  const versioned = value.action === 'install' || value.action === 'update'
  if (!exact(value, ['action', 'appId', 'expectedRevision', 'expectedCatalogRevision', ...(versioned ? ['version'] : [])]) || versioned && !isApplicationVersion(value.version)) return invalid()
  return Object.freeze({ action: value.action as ApplicationInstallAction, appId: value.appId, expectedRevision: value.expectedRevision, expectedCatalogRevision: value.expectedCatalogRevision, ...(versioned ? { version: value.version as string } : {}) })
}
const targetOf = (value: ApplicationTarget): Readonly<ApplicationTarget> => {
  if (!object(value) || !exact(value as unknown as Record<string, unknown>, ['accountId', 'domainId', 'uid', 'gid', 'identity']) || !UUID.test(value.accountId) || !UUID.test(value.domainId)
    || !Number.isSafeInteger(value.uid) || value.uid < 1000 || !Number.isSafeInteger(value.gid) || value.gid < 1000 || !isApplicationDigest(value.identity)) return invalid()
  return Object.freeze({ ...value })
}
const sameTarget = (a: ApplicationTarget, b: ApplicationTarget): boolean => a.accountId === b.accountId && a.domainId === b.domainId && a.uid === b.uid && a.gid === b.gid && a.identity === b.identity
const assertTarget = (a: ApplicationTarget, b: ApplicationTarget): void => { if (!sameTarget(a, targetOf(b))) fail('CONFLICT', 'the application account target identity changed', unchanged) }
const versionOf = (value: unknown): ApplicationInstalledVersion => {
  if (!object(value) || !exact(value, ['appId', 'version', 'artifactSha256', 'files']) || !isApplicationId(value.appId) || !isApplicationVersion(value.version) || !isApplicationDigest(value.artifactSha256)
    || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > 2048) return invalid()
  let previous = ''
  const paths = new Set<string>()
  const files = value.files.map(raw => {
    if (!object(raw) || !exact(raw, ['path', 'sha256', 'bytes', 'mode']) || !isApplicationArtifactPath(raw.path) || raw.path <= previous || paths.has(raw.path.toLowerCase()) || [...paths].some(path => path.startsWith(String(raw.path).toLowerCase() + '/') || String(raw.path).toLowerCase().startsWith(path + '/')) || !isApplicationDigest(raw.sha256)
      || !Number.isSafeInteger(raw.bytes) || Number(raw.bytes) < 0 || Number(raw.bytes) > 8 * 1024 * 1024 || raw.mode !== '0644') return invalid()
    previous = raw.path; paths.add(raw.path.toLowerCase())
    return Object.freeze({ path: raw.path, sha256: raw.sha256, bytes: Number(raw.bytes), mode: '0644' as const })
  })
  return Object.freeze({ appId: value.appId, version: value.version, artifactSha256: value.artifactSha256, files: Object.freeze(files) })
}
export const readApplicationObservedState = (value: unknown): Readonly<ApplicationObservedState> => {
  if (!object(value) || !exact(value, ['revision', 'unmanagedRevision', 'empty', 'managedClean', 'recoveryRequired', 'installation']) || !isApplicationDigest(value.revision) || !isApplicationDigest(value.unmanagedRevision)
    || typeof value.empty !== 'boolean' || typeof value.managedClean !== 'boolean' || typeof value.recoveryRequired !== 'boolean') return invalid()
  let installation: ApplicationObservedState['installation'] = null
  if (value.installation !== null) {
    if (!object(value.installation) || !exact(value.installation, ['appId', 'version', 'artifactSha256', 'files', 'previous']) || value.empty) return invalid()
    const { previous, ...current } = value.installation
    const parsed = versionOf(current), prior = previous === null ? null : versionOf(previous)
    if (prior && prior.appId !== parsed.appId) return invalid()
    installation = Object.freeze({ ...parsed, previous: prior })
  }
  return Object.freeze({ revision: value.revision, unmanagedRevision: value.unmanagedRevision, empty: value.empty, managedClean: value.managedClean, recoveryRequired: value.recoveryRequired, installation })
}

export const isApplicationInstallCommand = (argv: readonly string[]): boolean => Array.isArray(argv) && argv.length === 3 && argv[0] === APPLICATION_TRANSACTION_COMMAND && UUID.test(argv[1] ?? '') && (STAGES as readonly string[]).includes(argv[2] ?? '')
const step = (transactionId: string, stage: Stage): HostJobCommandStep => ({ id: stage, title: ({ snapshot: msgid('Save recoverable preimage'), apply: msgid('Apply reviewed application change'), readback: msgid('Verify account files'), commit: msgid('Commit verified installation'), recover: msgid('Verify transaction recovery') })[stage], argv: [APPLICATION_TRANSACTION_COMMAND, transactionId, stage], timeoutMs: TIMEOUT[stage], mutates: stage !== 'readback' })

interface Work {
  target: Readonly<ApplicationTarget>
  catalog: VerifiedApplicationCatalog
  before: Readonly<ApplicationObservedState>
  intent: Readonly<ApplicationTransactionIntent>
  artifact: VerifiedApplicationArtifact | null
  session: ApplicationTargetSession | null
  readback: Readonly<ApplicationObservedState> | null
  phase: number
  started: boolean
  commitAttempted: boolean
  committed: boolean
  busy: boolean
  recovery: ApplicationRecovery | null
  key: string
  prepared: PreparedApplicationJob | null
}
export interface PreparedApplicationJob { readonly transactionId: string; readonly plan: HostJobPlan; readonly discardUnstarted: () => boolean }
const ADMISSIONS = ['descriptorConfinement', 'accountLifetimeFence', 'durablePreimages', 'scopedWrites', 'digestReadback', 'boundedDeadlines', 'contentAddressedEgress'] as const
export function applicationInstallProviderAvailable(provider: ApplicationArtifactProvider | null | undefined): provider is ApplicationArtifactProvider {
  return !!provider && object(provider.admission) && ADMISSIONS.every(name => provider.admission[name] === true) && typeof provider.readArtifact === 'function' && typeof provider.openTarget === 'function' && typeof provider.pendingTransactions === 'function'
}
const expectedInstallation = (observed: ApplicationObservedState, intent: ApplicationTransactionIntent, before: ApplicationObservedState): boolean => {
  if (observed.recoveryRequired || !observed.managedClean || observed.unmanagedRevision !== before.unmanagedRevision) return false
  if (!intent.next) return observed.installation === null
  const actual = observed.installation
  const prior = before.installation === null ? null : { appId: before.installation.appId, version: before.installation.version, artifactSha256: before.installation.artifactSha256, files: before.installation.files }
  return !!actual && actual.appId === intent.next.appId && actual.version === intent.next.version && actual.artifactSha256 === intent.next.artifactSha256
    && JSON.stringify(actual.files) === JSON.stringify(intent.next.files) && JSON.stringify(actual.previous) === JSON.stringify(prior)
}

/**
 * The only dispatcher for APPLICATION_TRANSACTION_COMMAND. It is intentionally process-local and
 * rejects unknown/expired prepared intents. It supplies no root executor or filesystem fallback.
 * Native qualification and durable startup recovery remain the injected provider's prerequisites.
 */
export class ApplicationInstallCoordinator {
  private readonly deps: ApplicationInstallDeps
  private readonly works = new Map<string, Work>()
  private admission: Promise<unknown> = Promise.resolve()
  constructor(deps: ApplicationInstallDeps) { this.deps = deps }

  private provider(): ApplicationArtifactProvider {
    if (!applicationInstallProviderAvailable(this.deps.provider) || typeof this.deps.withAccountLease !== 'function' || typeof this.deps.assertAuthority !== 'function') return unavailable()
    return this.deps.provider
  }

  prepare(value: unknown): Promise<PreparedApplicationJob> {
    const work = this.admission.then(() => this.prepareOne(value))
    this.admission = work.catch(() => undefined)
    return work
  }

  private async prepareOne(value: unknown): Promise<PreparedApplicationJob> {
    const provider = this.provider(), request = readApplicationInstallRequest(value)
    const catalog = await this.deps.catalog()
    assertApplicationCatalogCurrent(catalog, this.deps.policy())
    if (request.expectedCatalogRevision !== catalog.revision) return fail('CONFLICT', 'the signed application catalog changed; review it again', unchanged)
    const target = targetOf(await this.deps.assertFresh(request.action))
    await this.deps.assertAuthority(request.action)
    const key = applicationDigest(JSON.stringify({ target, request }))
    const existing = [...this.works.values()].find(work => work.key === key)
    if (existing?.prepared) return existing.prepared
    if (this.works.size >= 4) return fail('PRECONDITION_FAILED', 'the bounded application job queue is full', unchanged)
    const before = await this.deps.withAccountLease(target, async fresh => {
      assertTarget(target, fresh)
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), TIMEOUT.readback)
      let session: ApplicationTargetSession | null = null
      try {
        session = await provider.openTarget(target, controller.signal)
        assertTarget(target, session.target)
        const observed = readApplicationObservedState(await session.observe(controller.signal))
        if (controller.signal.aborted) throw new Error('deadline')
        return observed
      } finally { clearTimeout(timer); await session?.close() }
    })
    if (before.revision !== request.expectedRevision) return fail('CONFLICT', 'the application target changed; read it again', unchanged)
    if (before.recoveryRequired || !before.managedClean) return fail('PRECONDITION_FAILED', 'application files or a prior transaction require recovery review', unchanged)
    if (request.action === 'install' ? before.installation !== null || !before.empty : !before.installation || before.installation.appId !== request.appId) return fail('PRECONDITION_FAILED', 'the selected action does not match the observed application installation', unchanged)
    let version: string | null = request.version ?? null
    if (request.action === 'update' && compareApplicationVersions(version!, before.installation!.version) <= 0) return fail('CONFLICT', 'application updates must select a newer signed version', unchanged)
    if (request.action === 'rollback') {
      version = before.installation!.previous?.version ?? null
      if (!version || compareApplicationVersions(version, before.installation!.version) >= 0) return fail('PRECONDITION_FAILED', 'no prior verified application version is available for rollback', unchanged)
    }
    let artifact: VerifiedApplicationArtifact | null = null
    if (version !== null) {
      const release = selectApplicationRelease(catalog, request.appId, version, this.deps.policy())
      if (request.action === 'rollback' && release.artifact.sha256 !== before.installation!.previous!.artifactSha256) return fail('CONFLICT', 'the prior application artifact no longer matches the signed catalog', unchanged)
      const retainedBytes = [...this.works.values()].reduce((total, work) => total + (work.artifact?.descriptor.bytes ?? 0), 0)
      if (retainedBytes + release.artifact.bytes > 64 * 1024 * 1024) return fail('PRECONDITION_FAILED', 'the bounded application artifact queue is full', unchanged)
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), TIMEOUT.snapshot)
      try {
        artifact = verifyApplicationArtifact(await provider.readArtifact(release.artifact, controller.signal), release.artifact, request.appId, version)
        if (controller.signal.aborted) throw new Error('deadline')
      } finally { clearTimeout(timer) }
    }
    assertTarget(target, await this.deps.assertFresh(request.action))
    assertApplicationCatalogCurrent(catalog, this.deps.policy())
    const transactionId = randomUUID()
    const next: ApplicationInstalledVersion | null = artifact ? Object.freeze({ appId: artifact.appId, version: artifact.version, artifactSha256: artifact.descriptor.sha256, files: artifact.files }) : null
    const intent: Readonly<ApplicationTransactionIntent> = Object.freeze({ transactionId, action: request.action, appId: request.appId, catalogRevision: catalog.revision, catalogSequence: catalog.sequence, expectedRevision: before.revision, next })
    const work: Work = { target, catalog, before, intent, artifact, session: null, readback: null, phase: 0, started: false, commitAttempted: false, committed: false, busy: false, recovery: null, key, prepared: null }
    const plan: HostJobPlan = Object.freeze({ kind: 'application.' + request.action, summary: `${request.action} ${request.appId}${version ? ' ' + version : ''}`, accountId: target.accountId,
      fingerprint: { target: { accountId: target.accountId, domainId: target.domainId, identity: target.identity }, action: request.action, appId: request.appId, version, expectedRevision: before.revision, catalogRevision: catalog.revision },
      detail: { action: request.action, appId: request.appId, version, domainId: target.domainId, artifactSha256: artifact?.descriptor.sha256 ?? null },
      steps: Object.freeze((['snapshot', 'apply', 'readback', 'commit'] as const).map(stage => Object.freeze(step(transactionId, stage)))),
      policy: (argv: readonly string[]) => isApplicationInstallCommand(argv) && argv[1] === transactionId,
      beforeStep: async () => { await this.fresh(work); assertTarget(target, await this.deps.assertFresh(request.action)) },
      verify: async () => {
        if (!work.committed || !work.session) return { ok: false, detail: { transaction: 'not_committed' } }
        const observation = await this.observe(work)
        return { ok: expectedInstallation(observation, intent, before) && observation.revision === work.readback?.revision, detail: { transaction: 'committed', revision: observation.revision } }
      },
      finalize: async (run: HostJobStepRun) => {
        let confirmed = !work.started, state: string = work.started ? 'unknown' : 'not_started'
        try {
          if (work.started) {
            const result = await run(step(transactionId, 'recover'))
            confirmed = result.ok && !result.timedOut && work.recovery !== null && work.recovery.state !== 'unknown'
            state = work.recovery?.state ?? 'unknown'
          }
        } catch { confirmed = false }
        finally {
          try { await work.session?.close() } catch { confirmed = false }
          this.works.delete(transactionId)
        }
        return { ok: confirmed, detail: { transaction: state, recoveryVerified: confirmed } }
      },
    })
    const prepared: PreparedApplicationJob = Object.freeze({ transactionId, plan, discardUnstarted: () => !work.started && this.works.delete(transactionId) })
    work.prepared = prepared; this.works.set(transactionId, work)
    return prepared
  }

  private async fresh(work: Work): Promise<void> {
    const catalog = await this.deps.catalog()
    assertApplicationCatalogCurrent(catalog, this.deps.policy())
    if (catalog.revision !== work.catalog.revision) return fail('CONFLICT', 'the signed application catalog changed while the job was queued', unchanged)
    if (work.intent.next) {
      const release = selectApplicationRelease(catalog, work.intent.appId, work.intent.next.version, this.deps.policy())
      if (release.artifact.sha256 !== work.intent.next.artifactSha256) return fail('CONFLICT', 'the signed application artifact changed while the job was queued', unchanged)
    }
    await this.deps.assertAuthority(work.intent.action)
  }

  private async observe(work: Work): Promise<Readonly<ApplicationObservedState>> {
    return this.deps.withAccountLease(work.target, async fresh => {
      assertTarget(work.target, fresh)
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), TIMEOUT.readback)
      try {
        const observed = readApplicationObservedState(await work.session!.observe(controller.signal))
        if (controller.signal.aborted) throw new Error('deadline')
        return observed
      } finally { clearTimeout(timer) }
    })
  }

  readonly run: HostJobRun = async (argv, options): Promise<HostJobCommandResult> => {
    if (!isApplicationInstallCommand(argv)) return fail('FORBIDDEN', 'the command is outside the application transaction dispatcher', unchanged)
    const work = this.works.get(argv[1]!), stage = argv[2] as Stage
    if (!work || options?.env !== undefined || options?.timeoutMs !== TIMEOUT[stage]) return fail('FORBIDDEN', 'the application transaction is not active or its command bounds changed', unchanged)
    this.provider()
    if (stage !== 'recover') await this.fresh(work)
    if (work.busy) return fail('CONFLICT', 'the application transaction already has an active command', unchanged)
    work.busy = true
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), TIMEOUT[stage])
    try {
      await this.deps.withAccountLease(work.target, async fresh => {
        assertTarget(work.target, fresh)
        if (stage !== 'recover') await this.deps.assertAuthority(work.intent.action)
        if (controller.signal.aborted) throw new Error('deadline')
        if (stage === 'snapshot') {
          if (work.started || work.phase !== 0) return invalid()
          work.started = true
          work.session = await this.provider().openTarget(work.target, controller.signal)
          assertTarget(work.target, work.session.target)
          const observed = readApplicationObservedState(await work.session.observe(controller.signal))
          if (observed.revision !== work.before.revision || JSON.stringify(observed) !== JSON.stringify(work.before)) return fail('CONFLICT', 'the application target changed before snapshot', unchanged)
          const receipt = await work.session.snapshot(work.intent, work.before, controller.signal)
          if (receipt.transactionId !== work.intent.transactionId || receipt.beforeRevision !== work.before.revision || receipt.durable !== true) throw new Error('snapshot_unverified')
          work.phase = 1
        } else if (stage === 'recover') {
          if (!work.started || work.recovery) return invalid()
          if (!work.session) { work.session = await this.provider().openTarget(work.target, controller.signal); assertTarget(work.target, work.session.target) }
          const recovery = await work.session.recover(work.intent.transactionId, controller.signal)
          const observation = readApplicationObservedState(recovery.observation)
          if (recovery.transactionId !== work.intent.transactionId || recovery.beforeRevision !== work.before.revision
            || (recovery.state === 'committed' ? !work.commitAttempted || recovery.committedRevision !== observation.revision || !expectedInstallation(observation, work.intent, work.before)
              : !['restored', 'not_started'].includes(recovery.state) || recovery.committedRevision !== null || JSON.stringify(observation) !== JSON.stringify(work.before))) throw new Error('recovery_unverified')
          work.recovery = Object.freeze({ ...recovery, observation })
        } else {
          if (!work.session || work.phase !== ({ apply: 1, readback: 2, commit: 3 } as const)[stage]) return invalid()
          if (stage === 'apply') {
            const current = readApplicationObservedState(await work.session.observe(controller.signal))
            if (JSON.stringify(current) !== JSON.stringify(work.before)) return fail('CONFLICT', 'the application target changed after snapshot', unchanged)
            if (controller.signal.aborted) throw new Error('deadline')
            await work.session.apply(work.intent, work.artifact, controller.signal); work.phase = 2
          } else if (stage === 'readback') {
            const observation = readApplicationObservedState(await work.session.observe(controller.signal))
            if (!expectedInstallation(observation, work.intent, work.before)) throw new Error('application_readback_unverified')
            work.readback = observation; work.phase = 3
          } else {
            const current = readApplicationObservedState(await work.session.observe(controller.signal))
            if (JSON.stringify(current) !== JSON.stringify(work.readback)) throw new Error('application_commit_stale')
            if (controller.signal.aborted) throw new Error('deadline')
            work.commitAttempted = true
            const receipt = await work.session.commit(work.intent.transactionId, current.revision, controller.signal)
            if (receipt.transactionId !== work.intent.transactionId || receipt.committedRevision !== current.revision) throw new Error('commit_unverified')
            work.committed = true; work.phase = 4
          }
        }
      })
      if (controller.signal.aborted) return { ok: false, code: null, stdout: '', stderr: 'the application stage exceeded its bounded deadline', timedOut: true }
      return { ok: true, code: 0, stdout: JSON.stringify({ stage, verified: true }), stderr: '', timedOut: false }
    } catch { return { ok: false, code: null, stdout: '', stderr: 'the application stage outcome could not be verified', timedOut: controller.signal.aborted } }
    finally { clearTimeout(timer); work.busy = false }
  }
}

/** Signed catalog plus account-derived target observation for a workspace's expectedRevision. */
export async function readApplicationInstallation(deps: ApplicationInstallDeps): Promise<{
  catalog: VerifiedApplicationCatalog; target: Readonly<ApplicationTarget>; observation: Readonly<ApplicationObservedState> | null; writesAvailable: boolean; reason: 'application_provider_unavailable' | null
}> {
  const catalog = await deps.catalog()
  assertApplicationCatalogCurrent(catalog, deps.policy())
  const target = targetOf(await deps.assertFresh('read'))
  await deps.assertAuthority('read')
  if (!applicationInstallProviderAvailable(deps.provider)) return { catalog, target, observation: null, writesAvailable: false, reason: 'application_provider_unavailable' }
  const provider = deps.provider
  const observation = await deps.withAccountLease(target, async fresh => {
    assertTarget(target, fresh); await deps.assertAuthority('read')
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), TIMEOUT.readback)
    let session: ApplicationTargetSession | null = null
    try {
      session = await provider.openTarget(target, controller.signal); assertTarget(target, session.target)
      const result = readApplicationObservedState(await session.observe(controller.signal))
      if (controller.signal.aborted) throw new Error('deadline')
      return result
    } finally { clearTimeout(timer); await session?.close() }
  })
  assertTarget(target, await deps.assertFresh('read'))
  return { catalog, target, observation, writesAvailable: !observation.recoveryRequired && observation.managedClean, reason: null }
}

/**
 * Explicit privileged recovery of persisted native journals after process loss. It does not
 * recreate a HostJobPlan, replay an installer, allocate a public reference or promote a failed job.
 * Only provider-listed descriptor-bound journals are eligible; no caller-selected transaction id.
 */
export async function recoverApplicationInstallations(deps: ApplicationInstallDeps): Promise<readonly { transactionId: string; state: ApplicationRecovery['state']; verified: boolean }[]> {
  if (!applicationInstallProviderAvailable(deps.provider)) return unavailable()
  const provider = deps.provider, target = targetOf(await deps.assertFresh('rollback'))
  await deps.assertAuthority('rollback')
  const pending = await deps.withAccountLease(target, async fresh => {
    assertTarget(target, fresh)
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), TIMEOUT.readback)
    try {
      const list = await provider.pendingTransactions(target, controller.signal)
      if (controller.signal.aborted || !Array.isArray(list) || list.length > 32
        || list.some(item => !object(item) || !exact(item, ['transactionId', 'beforeRevision', 'expectedCommittedRevision']) || typeof item.transactionId !== 'string' || !UUID.test(item.transactionId) || !isApplicationDigest(item.beforeRevision) || item.expectedCommittedRevision !== null && !isApplicationDigest(item.expectedCommittedRevision))) return invalid()
      if (new Set(list.map(item => item.transactionId)).size !== list.length) return invalid()
      return list.map(item => Object.freeze({ ...item }))
    } finally { clearTimeout(timer) }
  })
  const results: { transactionId: string; state: ApplicationRecovery['state']; verified: boolean }[] = []
  for (const item of pending) {
    const result = await deps.withAccountLease(target, async fresh => {
      assertTarget(target, fresh)
      await deps.assertAuthority('rollback')
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), TIMEOUT.recover)
      let session: ApplicationTargetSession | null = null, confirmed = false, state: ApplicationRecovery['state'] = 'unknown'
      try {
        session = await provider.openTarget(target, controller.signal); assertTarget(target, session.target)
        const receipt = await session.recover(item.transactionId, controller.signal), observed = readApplicationObservedState(receipt.observation)
        if (!controller.signal.aborted && receipt.transactionId === item.transactionId && receipt.beforeRevision === item.beforeRevision && !observed.recoveryRequired
          && (receipt.state === 'committed' ? item.expectedCommittedRevision !== null && receipt.committedRevision === item.expectedCommittedRevision && observed.revision === item.expectedCommittedRevision
            : ['restored', 'not_started'].includes(receipt.state) && receipt.committedRevision === null && observed.revision === item.beforeRevision)) {
          state = receipt.state; confirmed = true
        }
      } catch { confirmed = false }
      finally { clearTimeout(timer); try { await session?.close() } catch { confirmed = false } }
      return Object.freeze({ transactionId: item.transactionId, state: confirmed ? state : 'unknown' as const, verified: confirmed })
    })
    results.push(result)
  }
  return Object.freeze(results)
}
