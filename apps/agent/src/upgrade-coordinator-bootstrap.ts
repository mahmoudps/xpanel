import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { fail, isUuid } from '@xpanel/core'
import { completeJobWithLease, createDb, getDurableJob, getStrictOperationDatabaseOrigin, getUpgrade } from '@xpanel/db'
import type { Db } from '@xpanel/db'
import type { UpgradeObservationDeps } from './upgrade-observation.ts'
import { assertUpgradeIntentCurrent } from './upgrade-coordinator-validation.ts'
import { parseUpgradeProcessBinding, readUpgradeIntentJob } from './upgrade-coordinator-contract.ts'
import type { UpgradeProcessBinding } from './upgrade-coordinator-contract.ts'
import { RELEASE_KEYS_PATH } from './upgrade-observation.ts'
import { runNativeLifecycleCommand } from './lifecycle/native-runtime.ts'
import { withLifecycleWriterAdmission } from '../../../scripts/lifecycle-admission.mjs'

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const review = (): never => fail('SERVICE_UNAVAILABLE', 'consumed upgrade handoff requires operator inspection; native execution will not be replayed', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
export interface UpgradeHandoffConsumerOptions {
  db: Db
  observation?: Omit<UpgradeObservationDeps, 'db' | 'coordinatorAvailable'>
  /** Native runtime only in production; injectable solely for isolated protocol tests. */
  runNative(input: unknown, binding: UpgradeProcessBinding): Promise<unknown>
}

/** One-shot consumer. Its CAS is only a durable protocol fence; native root safety remains mandatory. */
export async function consumeUpgradeHandoff(rawBinding: unknown, options: UpgradeHandoffConsumerOptions) {
  const binding = parseUpgradeProcessBinding(rawBinding)
  const { saved, verified } = await withLifecycleWriterAdmission(async () => {
  const saved = readUpgradeIntentJob(await getDurableJob(options.db, binding.jobId), binding)
  if (saved.job.checkpointStep !== 'dispatch-committed') return fail('PRECONDITION_FAILED', 'upgrade handoff is not awaiting first consumption; do not replay it', { stateChanged: false, verificationRequired: true })
  const verified = await assertUpgradeIntentCurrent(options.db, saved.intent, options.observation)
  const now = new Date().toISOString()
  // Previous-step CAS prevents two consumers sharing one dispatch receipt from both entering native runtime.
  const claimed = await options.db.query<{ job_id: string }>(`UPDATE job_runtime_leases SET checkpoint_step='native-consumed', checkpoint_json=$1, updated_at=$2
    WHERE job_id=$3 AND request_fingerprint=$4 AND reference_code=$5 AND lease_owner=$6 AND fencing_token=$7
      AND lease_expires_at>$2 AND checkpoint_step='dispatch-committed' AND cancel_requested=0 AND needs_attention=0
      AND EXISTS(SELECT 1 FROM jobs WHERE id=$3 AND status='running' AND kind='lifecycle.upgrade.handoff') RETURNING job_id`,
    [JSON.stringify({ ...saved.job.checkpointData, nativeConsumedAt: now, automaticReplay: false }), now, binding.jobId, binding.requestFingerprint, binding.referenceCode, binding.workerId, binding.fencingToken])
  if (claimed.length !== 1) return fail('CONFLICT', 'upgrade handoff was consumed or its lease changed', { stateChanged: false, verificationRequired: true })
  return { saved, verified }
  })
  try {
    await assertUpgradeIntentCurrent(options.db, saved.intent, options.observation)
    const result = await options.runNative({ schemaVersion: 1, command: 'upgrade', mode: 'apply', json: true, assumeYes: true,
      artifact: { path: saved.intent.release.archivePath, expectedArchiveSha256: saved.intent.release.sha256, keyId: verified.manifest.keyId, signingKeyPath: RELEASE_KEYS_PATH } }, binding)
    const details = object(result) && object(result.details) ? result.details : null
    if (!object(result) || result.exitCode !== 0 || result.code !== 'LIFECYCLE_NATIVE_COMMITTED' || result.outcome !== 'committed' || !details || details.currentVersion !== saved.intent.release.version || !isUuid(details.upgradeId)) return review()
    const upgrade = await getUpgrade(options.db, details.upgradeId as string)
    if (!upgrade || upgrade.status !== 'succeeded' || upgrade.toVersion !== saved.intent.release.version || upgrade.actor !== saved.intent.actor) return review()
    const current = readUpgradeIntentJob(await getDurableJob(options.db, binding.jobId), binding).job
    if (current.checkpointStep !== 'native-consumed') return review()
    const completed = await withLifecycleWriterAdmission(() => completeJobWithLease(options.db, { jobId: binding.jobId, workerId: binding.workerId, fencingToken: binding.fencingToken, status: 'succeeded',
      summary: 'Native upgrade machine confirmed the exact signed release', detail: { ...current.detail, upgradeId: upgrade.id, nativeOutcome: 'committed', verificationRequired: false } }))
    return { upgradeId: upgrade.id, job: { id: completed.id, referenceCode: completed.referenceCode, status: completed.status } }
  } catch {
    await withLifecycleWriterAdmission(() => completeJobWithLease(options.db, { jobId: binding.jobId, workerId: binding.workerId, fencingToken: binding.fencingToken, status: 'failed',
      error: 'Native upgrade result is unverified; current-authority recovery requires operator inspection', failureClass: 'unknown_outcome', needsAttention: true })).catch(() => undefined)
    return review()
  }
}

/** Explicit out-of-process entry seam. No launcher or systemd unit is installed or activated by this module. */
export async function runNativeUpgradeCoordinatorBootstrap(rawBinding: unknown) {
  const binding = parseUpgradeProcessBinding(rawBinding)
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.geteuid?.() !== 0) return fail('PRECONDITION_FAILED', 'native upgrade bootstrap requires root on Linux', { stateChanged: false })
  if (process.version !== 'v26.12.1' || process.env.NODE_OPTIONS || process.env.NODE_PATH) return fail('PRECONDITION_FAILED', 'native upgrade bootstrap requires the pinned clean runtime', { stateChanged: false })
  const path = '/var/lib/xpanel/control.db', pinned = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let handle: ReturnType<typeof createDb> | undefined
  try {
    const info = await pinned.stat({ bigint: true })
    if (!info.isFile() || info.nlink !== 1n) return fail('PRECONDITION_FAILED', 'canonical upgrade database pin is invalid', { stateChanged: false })
    handle = createDb(path, { durability: 'strict' })
    const origin = await handle.db.transaction(async tx => getStrictOperationDatabaseOrigin(tx))
    if (origin.file !== path || origin.device !== String(info.dev) || origin.inode !== String(info.ino)) return fail('PRECONDITION_FAILED', 'canonical upgrade database changed', { stateChanged: false })
    return await consumeUpgradeHandoff(binding, { db: handle.db, runNative: runNativeLifecycleCommand })
  } finally { try { if (handle) await handle.close() } finally { await pinned.close() } }
}
