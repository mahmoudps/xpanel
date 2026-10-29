import { fail } from '@xpanel/core'
import { getPrincipal } from '@xpanel/db'
import type { Db } from '@xpanel/db'
import { preflight } from '@xpanel/lifecycle'
import { observeUpgradeInputs } from './upgrade-observation.ts'
import type { UpgradeObservationDeps } from './upgrade-observation.ts'
import { signedReleaseManifestDigest, verifySignedManifestForRelease } from './lifecycle/upgrade-runner.ts'
import type { UpgradeIntent } from './upgrade-coordinator-contract.ts'

/** Re-observation only; these checks never replace the native root-safety producer. */
export async function assertUpgradeIntentCurrent(db: Db, intent: UpgradeIntent, observation?: Omit<UpgradeObservationDeps, 'db' | 'coordinatorAvailable'>) {
  const owner = await getPrincipal(db, intent.principalId)
  if (!owner || owner.disabled || owner.kind !== 'root' || owner.username !== intent.actor) return fail('FORBIDDEN', 'upgrade handoff owner is no longer authorized', { stateChanged: false })
  const inputs = await observeUpgradeInputs({ ...observation, db, coordinatorAvailable: true }), view = inputs.observation
  if (view.revision !== intent.expectedRevision || !view.availability.start.enabled || !view.availability.candidates.includes(intent.release.version)) return fail('CONFLICT', 'upgrade observations changed before handoff consumption', { stateChanged: false })
  const staged = inputs.verified.get(intent.release.version)
  if (!staged || staged.archivePath !== intent.release.archivePath || signedReleaseManifestDigest(staged.manifest) !== intent.manifestDigest) return fail('PRECONDITION_FAILED', 'staged release no longer matches the durable upgrade intent', { stateChanged: false })
  verifySignedManifestForRelease(staged.manifest, intent.release, inputs.trust.keys)
  const report = preflight({ freeBytes: view.freeBytes!, releaseBytes: intent.release.bytes, os: inputs.osRelease!, activeTransfers: view.activeTransfers!,
    currentVersion: view.current.version!, targetVersion: intent.release.version, schemaVersions: { current: view.schemaVersion!, target: intent.release.schemaVersion } })
  if (!report.ok) return fail('PRECONDITION_FAILED', 'upgrade handoff preflight no longer passes', { stateChanged: false })
  const fresh = await getPrincipal(db, intent.principalId)
  if (!fresh || fresh.disabled || fresh.kind !== 'root' || fresh.username !== intent.actor) return fail('FORBIDDEN', 'upgrade handoff owner changed during verification', { stateChanged: false })
  return { inputs, manifest: staged.manifest }
}
