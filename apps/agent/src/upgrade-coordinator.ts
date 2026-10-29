import { randomUUID } from 'node:crypto'
import { fail } from '@xpanel/core'
import { acquireJobLease, completeJobWithLease, enqueueDurableJob, getDurableJob, getPrincipal, saveJobCheckpoint } from '@xpanel/db'
import type { Db, DurableJobRecord } from '@xpanel/db'
import type { UpgradeCoordinator, UpgradeHandoff } from './upgrade-routes.ts'
import type { UpgradeObservationDeps } from './upgrade-observation.ts'
import { signedReleaseManifestDigest } from './lifecycle/upgrade-runner.ts'
import { assertUpgradeIntentCurrent } from './upgrade-coordinator-validation.ts'
import { parseUpgradeIntent, parseUpgradeProcessBinding, readUpgradeIntentJob, UPGRADE_HANDOFF_KIND, UPGRADE_HANDOFF_LEASE_MS, upgradeIntentFingerprint } from './upgrade-coordinator-contract.ts'
import type { UpgradeProcessBinding } from './upgrade-coordinator-contract.ts'
import { withLifecycleWriterAdmission } from '../../../scripts/lifecycle-admission.mjs'

export interface UpgradeProcessReadiness { available: boolean; reasons: readonly string[] }
/** Trusted composition only. A provider must launch the pinned native bootstrap in its independently owned root unit.
 * It must prove root-safety prerequisites and the hosted-request UID producer; callback shape alone is no evidence. */
export interface QualifiedUpgradeProcessProvider {
  readiness(): Promise<UpgradeProcessReadiness>
  launch(binding: Readonly<UpgradeProcessBinding>): Promise<{ accepted: true; binding: UpgradeProcessBinding }>
}
const held = (): never => fail('PRECONDITION_FAILED', 'native upgrade process provider is unqualified', { stateChanged: false, reasons: ['upgrade-native-provider-unqualified'] })
const review = (): never => fail('SERVICE_UNAVAILABLE', 'upgrade handoff outcome requires inspection; do not dispatch it again', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
const projected = (job: DurableJobRecord) => ({ id: job.id, referenceCode: job.referenceCode!, status: job.status })

/** Durable outbox and one-shot dispatch. This class never runs the upgrade machine inside the agent. */
export class DurableUpgradeCoordinator implements UpgradeCoordinator {
  private readonly workerId = 'upgrade-coordinator-' + randomUUID()
  constructor(privateOptions: { db: Db; provider?: QualifiedUpgradeProcessProvider; observation?: Omit<UpgradeObservationDeps, 'db' | 'coordinatorAvailable'> }) { this.options = privateOptions }
  private readonly options: { db: Db; provider?: QualifiedUpgradeProcessProvider; observation?: Omit<UpgradeObservationDeps, 'db' | 'coordinatorAvailable'> }

  async availability(): Promise<UpgradeProcessReadiness> {
    if (!this.options.provider) return { available: false, reasons: ['upgrade-native-provider-unqualified', 'upgrade-hosted-uid-unqualified'] }
    try {
      const observed = await this.options.provider.readiness()
      if (!observed || typeof observed.available !== 'boolean' || !Array.isArray(observed.reasons) || observed.reasons.length > 16 || observed.reasons.some(value => typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,95}$/.test(value)) || observed.available && observed.reasons.length) return { available: false, reasons: ['upgrade-native-provider-unqualified'] }
      return { available: observed.available, reasons: [...observed.reasons] }
    } catch { return { available: false, reasons: ['upgrade-native-provider-unqualified'] } }
  }

  async start(input: UpgradeHandoff) {
    return withLifecycleWriterAdmission(() => this.startAdmitted(input))
  }

  private async startAdmitted(input: UpgradeHandoff) {
    if (input.actor.kind !== 'root') return fail('FORBIDDEN', 'upgrade handoffs require root', { stateChanged: false })
    if (!(await this.availability()).available || !this.options.provider) return held()
    const intent = parseUpgradeIntent({ version: 1, handoffId: input.handoffId, principalId: input.actor.id, actor: input.actor.username,
      expectedRevision: input.expectedRevision, release: input.release, manifestDigest: signedReleaseManifestDigest(input.manifest) })
    await assertUpgradeIntentCurrent(this.options.db, intent, this.options.observation)
    const fingerprint = upgradeIntentFingerprint(intent)
    const enqueued = await enqueueDurableJob(this.options.db, { kind: UPGRADE_HANDOFF_KIND, actor: intent.actor, accountId: null, maxAttempts: 1,
      idempotencyKey: 'upgrade-handoff:' + fingerprint, requestFingerprint: fingerprint, summary: 'Signed panel upgrade handoff', detail: { upgradeHandoff: intent } })
    let job: DurableJobRecord = enqueued
    const saved = readUpgradeIntentJob(job)
    if (saved.job.status === 'failed' || saved.job.needsAttention || saved.job.cancelRequested) return review()
    if (saved.job.status === 'succeeded' || saved.job.status === 'running') {
      if (saved.job.status === 'running' && (!saved.job.leaseExpiresAt || saved.job.leaseExpiresAt <= new Date().toISOString())) return review()
      return { upgradeId: null, handoffId: saved.intent.handoffId, job: projected(saved.job), deduplicated: true }
    }
    const leased = await acquireJobLease(this.options.db, { jobId: job.id, workerId: this.workerId, leaseDurationMs: UPGRADE_HANDOFF_LEASE_MS })
    if (!leased) return review()
    const binding = parseUpgradeProcessBinding({ jobId: leased.id, requestFingerprint: leased.requestFingerprint, referenceCode: leased.referenceCode, workerId: this.workerId, fencingToken: leased.fencingToken })
    let dispatchCommitted = false
    try {
      await assertUpgradeIntentCurrent(this.options.db, saved.intent, this.options.observation)
      if (!(await this.availability()).available) return held()
      job = await saveJobCheckpoint(this.options.db, { ...binding, step: 'dispatch-committed', progress: 1, data: { dispatch: 'one-shot', verificationRequired: true } })
      dispatchCommitted = true
      await assertUpgradeIntentCurrent(this.options.db, saved.intent, this.options.observation)
      const acknowledgement = await this.options.provider.launch(Object.freeze({ ...binding }))
      if (acknowledgement?.accepted !== true || JSON.stringify(parseUpgradeProcessBinding(acknowledgement.binding)) !== JSON.stringify(binding)) return review()
      const owner = await getPrincipal(this.options.db, saved.intent.principalId)
      if (!owner || owner.disabled || owner.kind !== 'root' || owner.username !== saved.intent.actor) return review()
      const current = readUpgradeIntentJob(await getDurableJob(this.options.db, job.id)).job
      if (current.status === 'failed' || current.needsAttention) return review()
      return { upgradeId: null, handoffId: saved.intent.handoffId, job: projected(current), deduplicated: enqueued.deduplicated }
    } catch (error) {
      await completeJobWithLease(this.options.db, { jobId: binding.jobId, workerId: binding.workerId, fencingToken: binding.fencingToken, status: 'failed',
        error: dispatchCommitted ? 'Native process launch or acknowledgement is unverified; operator inspection required' : 'Upgrade handoff refused before native dispatch',
        failureClass: dispatchCommitted ? 'unknown_outcome' : 'permanent', needsAttention: dispatchCommitted }).catch(() => undefined)
      if (!dispatchCommitted) throw error
      return review()
    }
  }

  /** Restart recovery is observation-only: persisted dispatch is never replayed and no historical authority is restored. */
  async inspectRecovery() {
    const rows = await this.options.db.query<{ id: string }>('SELECT id FROM jobs WHERE kind=$1 AND status IN (\'queued\',\'running\') ORDER BY created_at,id LIMIT 101', [UPGRADE_HANDOFF_KIND])
    if (rows.length > 100) return fail('PRECONDITION_FAILED', 'upgrade handoff recovery inventory exceeds its bound', { stateChanged: false })
    const jobs = []
    for (const row of rows) {
      const { job } = readUpgradeIntentJob(await getDurableJob(this.options.db, row.id))
      jobs.push({ ...projected(job), state: job.status === 'queued' && job.attempt === 0 ? 'not_dispatched' : 'review_required', relaunchAllowed: false })
    }
    return { jobs, automaticRecovery: false }
  }
}
