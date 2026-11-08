import { fail, isXpanelError, type Account, type MfaRuntimePolicy } from '@xpanel/core'
import { getDurableJob, getGeneration, latestActive, type Db } from '@xpanel/db'
import { assertProvisioningReply, canonicalProvisioningIdentity, parseProvisioningCheckpointObservation, parseProvisioningReconcileRequest, type AccountExecutionObservation, type ProvisioningReconcileRequest, type ProvisioningReconcileReply } from '../../../packages/core/src/account-provisioning-contract.ts'
import { assertProvisioningAuthorization, type ProvisioningAuthorizationReadPorts } from './account-provisioning-authorization.ts'
import type { AgentAccountProvisioningRuntime } from './account-provisioning-handler.ts'
import { AccountProvisioningPreparationReader } from './account-provisioning-preparation.ts'
import { LinuxHostExecutor } from './executor.ts'
import { assertHostEffectAuthority, HOST_EFFECT_NOT_STARTED, withHostEffectAuthority, type HostEffectAuthority } from './host-effect-authority.ts'
import type { HostReconciler, ReconcileResult } from './reconciler.ts'

type Manifest = NonNullable<Awaited<ReturnType<HostReconciler['journal']['readManifest']>>>
type RuntimeInput = Parameters<AgentAccountProvisioningRuntime['execute']>[0]
type RuntimeContext = Parameters<AgentAccountProvisioningRuntime['execute']>[1]

/**
 * Trusted native startup dependency. A service state, configuration file or PHP
 * echo cannot supply this proof. Missing providers refuse before host effects.
 */
export interface AccountProvisioningObservationProvider {
  assertAvailable(input: { readonly account: Account; readonly request: ProvisioningReconcileRequest }, context: HostEffectAuthority): Promise<void>
  observe(input: {
    readonly account: Account
    readonly request: ProvisioningReconcileRequest
    readonly reconciliation: ReconcileResult
    readonly manifest: Manifest
  }, context: HostEffectAuthority): Promise<AccountExecutionObservation>
}

export interface AccountProvisioningRuntimeOptions {
  readonly db: Db
  readonly executor: LinuxHostExecutor
  readonly reconciler: HostReconciler
  readonly preparations: AccountProvisioningPreparationReader
  readonly authorization: ProvisioningAuthorizationReadPorts
  readonly policy: MfaRuntimePolicy
  /** Only trusted startup code can supply an independently qualified native observer. */
  readonly observer?: AccountProvisioningObservationProvider
}

/**
 * The reconciler proved that no host primitive started (reconciler.ts) and failed its generation: a known failure
 * without an effect. The API records it as such, so the same request may run again without operator recovery.
 */
export async function noEffectFailure(db: Db, request: ProvisioningReconcileRequest, error: unknown): Promise<ProvisioningReconcileReply<ReconcileResult> | null> {
  if (!isXpanelError(error) || error.detail.reason !== HOST_EFFECT_NOT_STARTED || error.detail.stateChanged !== false) return null
  const generation = await getGeneration(db, Number(error.detail.generationId))
  if (!generation || generation.status !== 'failed') return null
  const failed = { binding: request.binding, outcome: 'known' as const, reconciliation: { status: 'failed' as const, generation, failedTest: 'host-operation-authority', error: error.message, stateChanged: false } }
  assertProvisioningReply(request, failed)
  return failed
}

const unavailable = (): never => fail('SERVICE_UNAVAILABLE', 'account provisioning requires an independent native workload observer', {
  stateChanged: false, reason: 'account_provisioning_native_observer_unavailable',
})

/** Concrete production composition. It never falls back to generic /reconcile. */
export function createAccountProvisioningRuntime(options: AccountProvisioningRuntimeOptions): AgentAccountProvisioningRuntime {
  return {
    async readPreparation(input) { return (await options.preparations.read(input)).metadata },
    async execute(input: RuntimeInput, context: RuntimeContext): Promise<ProvisioningReconcileReply> {
      // Test seams elsewhere cannot make the ordinary daemon claim native success.
      if (!options.observer) return unavailable()
      if (process.platform !== 'linux' || process.getuid?.() !== 0 || !(options.executor instanceof LinuxHostExecutor)) {
        return fail('PRECONDITION_FAILED', 'account provisioning requires the root native Linux runtime', { stateChanged: false })
      }
      const request = parseProvisioningReconcileRequest(input.request)
      const job = await getDurableJob(options.db, request.authority.operation.id)
      if (!job?.idempotencyKey) return fail('PRECONDITION_FAILED', 'account provisioning requires its saved durable operation', { stateChanged: false })
      const prepared = await options.preparations.read({ reference: request.authority.desired.preparationReference,
        actorKey: input.actor.kind + ':' + input.actor.id, operationKey: job.idempotencyKey })
      if (prepared.metadata.preparationIdentity !== request.authority.desired.preparationIdentity) {
        return fail('CONFLICT', 'account provisioning preparation changed before host execution', { stateChanged: false })
      }
      const authority: HostEffectAuthority = {
        signal: context.signal,
        assertAuthority: async () => {
          if (context.signal.aborted) return fail('PRECONDITION_FAILED', 'account provisioning was cancelled', { stateChanged: false })
          await context.assertAuthority()
          await assertProvisioningAuthorization({ reference: prepared.authorizationRef,
            actor: input.actor, planId: input.account.planId, ports: options.authorization, policy: options.policy })
          await context.assertAuthority()
          if (context.signal.aborted) return fail('PRECONDITION_FAILED', 'account provisioning was cancelled', { stateChanged: false })
        },
      }
      const observationAuthority: HostEffectAuthority = { ...authority, readOnly: true }
      await authority.assertAuthority()
      await withHostEffectAuthority(options.executor, observationAuthority, () => options.observer!.assertAvailable({ account: input.account, request }, observationAuthority))
      let attempted = false
      try {
        let reconciliation: ReconcileResult
        if (job.completedSteps.includes('reconcile_host')) {
          const saved = parseProvisioningCheckpointObservation(job.checkpointData.observedContext)
          const previous = saved.request
          const active = await latestActive(options.db)
          if (!active || job.checkpointData.generationId !== active.id
            || canonicalProvisioningIdentity(previous.authority.actor) !== canonicalProvisioningIdentity(request.authority.actor)
            || canonicalProvisioningIdentity(previous.authority.account) !== canonicalProvisioningIdentity(request.authority.account)
            || canonicalProvisioningIdentity(previous.authority.desired) !== canonicalProvisioningIdentity(request.authority.desired)
            || previous.authority.operation.id !== request.authority.operation.id
            || previous.authority.operation.requestFingerprint !== request.authority.operation.requestFingerprint) {
            return fail('PRECONDITION_FAILED', 'saved host proof is not the current account operation and generation', { stateChanged: false, verificationRequired: true })
          }
          reconciliation = { status: 'noop', generation: active, stateChecksum: request.authority.desired.checksum }
          // Validate saved facts against their original authority and the actual
          // current generation. This is not the new independent observation.
          assertProvisioningReply(previous, { binding: previous.binding, outcome: 'known', reconciliation,
            execution: saved.execution })
        } else {
          attempted = true
          try {
            reconciliation = await options.reconciler.reconcile({ actor: input.actor.kind + ':' + input.actor.username,
              scope: input.scope, expectedState: { revision: request.authority.desired.revision, checksum: request.authority.desired.checksum }, effectAuthority: authority })
          } catch (error) {
            const failed = await noEffectFailure(options.db, request, error)
            if (failed) return failed
            throw error
          }
        }
        await authority.assertAuthority()
        if (reconciliation.status === 'failed') {
          const failed = { binding: request.binding, outcome: 'known' as const, reconciliation }
          assertProvisioningReply(request, failed)
          return failed
        }
        if (!reconciliation.generation) return fail('PRECONDITION_FAILED', 'account provisioning did not activate a verified generation', { stateChanged: true, verificationRequired: true })
        const generation = reconciliation.generation
        const manifest = await options.reconciler.journal.readManifest(generation.id)
        const active = await latestActive(options.db)
        if (!manifest || !active || active.id !== generation.id || active.checksum !== generation.checksum
          || manifest.generationId !== generation.id || manifest.filesChecksum !== generation.checksum
          || manifest.stateChecksum !== request.authority.desired.checksum) {
          return fail('PRECONDITION_FAILED', 'the active generation is not the requested account source', { stateChanged: true, verificationRequired: true })
        }
        const execution = await withHostEffectAuthority(options.executor, observationAuthority, async () => {
          await assertHostEffectAuthority(options.executor)
          const drift = await options.reconciler.checkDrift()
          if (drift.hasDrift || drift.manifestMissing) return fail('PRECONDITION_FAILED', 'the active account generation has unverified host files', { stateChanged: true, verificationRequired: true })
          const observed = await options.observer!.observe({ account: input.account, request, reconciliation, manifest }, observationAuthority)
          await assertHostEffectAuthority(options.executor)
          const final = await latestActive(options.db)
          if (!final || final.id !== generation.id || final.checksum !== generation.checksum) {
            return fail('CONFLICT', 'the active generation changed during native account observation', { stateChanged: true, verificationRequired: true })
          }
          return observed
        })
        const reply = { binding: request.binding, outcome: 'known' as const, reconciliation, execution }
        assertProvisioningReply(request, reply)
        await authority.assertAuthority()
        return reply
      } catch (error) {
        if (isXpanelError(error)) throw error
        return fail('PRECONDITION_FAILED', 'account provisioning did not produce a verified native outcome', {
          stateChanged: attempted, verificationRequired: true,
        })
      }
    },
  }
}
