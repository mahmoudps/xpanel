import { randomUUID } from 'node:crypto'
import { fail, isUuid } from '@xpanel/core'
import type { Principal } from '@xpanel/core'
import { appendAudit, getDurableJob, listUpgrades } from '@xpanel/db'
import type { Db, DurableJobRecord } from '@xpanel/db'
import { preflight } from '@xpanel/lifecycle'
import type { PreflightReport, ReleaseInfo } from '@xpanel/lifecycle'
import { signedReleaseManifestDigest, verifyReleaseArtifactSignature } from './lifecycle/upgrade-runner.ts'
import type { SignedReleaseManifest } from './lifecycle/upgrade-runner.ts'
import { observeUpgradeInputs, projectUpgradeRecord, upgradeRevision } from './upgrade-observation.ts'
import { readUpgradeIntentJob } from './upgrade-coordinator-contract.ts'
import type { ObservedUpgradeInputs, UpgradeObservationDeps } from './upgrade-observation.ts'

export interface UpgradeCaller { principalId: string; actor: string; role: string }

/** The exact verified release handed to the native coordinator, which owns the machine run. */
export interface UpgradeHandoff { actor: Principal; release: ReleaseInfo; manifest: SignedReleaseManifest; handoffId: string; expectedRevision: string }
export interface UpgradeCoordinatorAcknowledgement { upgradeId: string | null; handoffId?: string; job?: Pick<DurableJobRecord, 'id' | 'referenceCode' | 'status'>; deduplicated?: boolean }

/**
 * Starts the side-by-side upgrade machine outside this process (the agent itself is restarted by it).
 * Lock, snapshot, migrations, health gate and rollback stay inside runUpgrade; nothing here bypasses them.
 */
export interface UpgradeCoordinator {
  availability?(): Promise<{ available: boolean; reasons: readonly string[] }>
  start(input: UpgradeHandoff): Promise<UpgradeCoordinatorAcknowledgement>
}

export interface UpgradeRouteContext {
  db: Db
  caller: UpgradeCaller
  /** Re-reads the current principal from the control DB. */
  authenticate(): Promise<UpgradeCaller>
  assertRootCaller(caller: UpgradeCaller, target: string): Promise<void>
  observation?: Omit<UpgradeObservationDeps, 'db' | 'coordinatorAvailable'>
  coordinator?: UpgradeCoordinator
}

const ROUTES: Readonly<Record<string, string>> = { '/host/upgrade': 'GET', '/host/upgrade/status': 'GET', '/host/upgrade/preflight': 'POST', '/host/upgrade/start': 'POST' }
const EXACT_VERSION = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/
const REVISION = /^[0-9a-f]{64}$/

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const unchanged = (code: 'CONFLICT' | 'PRECONDITION_FAILED' | 'VALIDATION' | 'FORBIDDEN', message: string, detail: Record<string, unknown> = {}): never => fail(code, message, { ...detail, stateChanged: false })

/** Strict grammar shared with the API boundary: no caller-supplied free space, OS, versions or schema numbers. */
export const parseUpgradeRequest = async (req: Request, start: boolean): Promise<{ targetVersion: string; expectedRevision: string }> => {
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return unchanged('VALIDATION', 'JSON is required')
  const text = await req.text()
  if (text.length > 4096) return unchanged('VALIDATION', 'upgrade request is too large')
  let body: unknown
  try { body = JSON.parse(text) } catch { return unchanged('VALIDATION', 'request body is not valid JSON') }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return unchanged('VALIDATION', 'request body must be an object')
  const value = body as Record<string, unknown>
  const allowed = start ? ['targetVersion', 'expectedRevision', 'confirm'] : ['targetVersion', 'expectedRevision']
  const unsupported = Object.keys(value).filter(key => !allowed.includes(key))
  if (unsupported.length) return unchanged('VALIDATION', 'unsupported upgrade field; preflight inputs come only from host observations', { fields: unsupported.slice(0, 16) })
  if (typeof value.targetVersion !== 'string' || !EXACT_VERSION.test(value.targetVersion)) return unchanged('VALIDATION', 'an exact staged release version is required')
  if (typeof value.expectedRevision !== 'string' || !REVISION.test(value.expectedRevision)) return unchanged('VALIDATION', 'the observed upgrade revision is required')
  if (start && value.confirm !== `upgrade ${value.targetVersion}`) return unchanged('VALIDATION', 'type the exact confirmation to start the upgrade', { reason: 'confirmation-mismatch' })
  return { targetVersion: value.targetVersion, expectedRevision: value.expectedRevision }
}

interface Evaluated { inputs: ObservedUpgradeInputs; release: ReleaseInfo; manifest: SignedReleaseManifest; report: PreflightReport }

/** Pure preflight over observed values only, for one verified staged release. */
const evaluate = (inputs: ObservedUpgradeInputs, request: { targetVersion: string; expectedRevision: string }): Evaluated => {
  const { observation } = inputs
  if (observation.revision !== request.expectedRevision) return unchanged('CONFLICT', 'upgrade observations changed; review them again', { reason: 'revision-changed', revision: observation.revision })
  if (!observation.availability.preflight.enabled) return unchanged('PRECONDITION_FAILED', 'upgrade preflight is unavailable', { reasons: observation.availability.preflight.reasons })
  const staged = inputs.verified.get(request.targetVersion)
  if (!staged || !observation.availability.candidates.includes(request.targetVersion)) return unchanged('PRECONDITION_FAILED', 'the target is not a verified staged release newer than the current one', { reasons: ['staged-release-not-verified'] })
  const { manifest, archivePath } = staged
  const release: ReleaseInfo = { version: manifest.version, schemaVersion: manifest.schemaVersion, archivePath, sha256: manifest.sha256, bytes: manifest.bytes }
  const report = preflight({
    freeBytes: observation.freeBytes!, releaseBytes: manifest.bytes, os: inputs.osRelease!, activeTransfers: observation.activeTransfers!,
    currentVersion: observation.current.version!, targetVersion: manifest.version,
    schemaVersions: { current: observation.schemaVersion!, target: manifest.schemaVersion },
  })
  return { inputs, release, manifest, report }
}

export async function handleUpgradeRoute(req: Request, url: URL, method: string, ctx: UpgradeRouteContext): Promise<Response | null> {
  const expected = ROUTES[url.pathname]
  if (!expected) return null
  await ctx.assertRootCaller(ctx.caller, 'host.upgrade')
  if (method !== expected) return new Response(null, { status: 405, headers: { allow: expected } })
  if (url.search) return unchanged('VALIDATION', 'upgrade routes do not accept selectors')
  const observe = async (): Promise<ObservedUpgradeInputs> => {
    let available = !!ctx.coordinator, reasons: readonly string[] = []
    if (ctx.coordinator?.availability) {
      try { const ready = await ctx.coordinator.availability(); available = ready.available === true; reasons = ready.reasons } catch { available = false; reasons = ['upgrade-native-provider-unqualified'] }
      if (!Array.isArray(reasons) || reasons.length > 16 || reasons.some(reason => typeof reason !== 'string' || !/^[a-z][a-z0-9-]{0,95}$/.test(reason))) { available = false; reasons = ['upgrade-native-provider-unqualified'] }
    }
    const inputs = await observeUpgradeInputs({ ...(ctx.observation ?? {}), db: ctx.db, coordinatorAvailable: available })
    if (!available && reasons.length) {
      const { revision: _revision, ...stable } = inputs.observation
      const unsigned = { ...stable, availability: { ...stable.availability, start: { enabled: false, reasons: [...new Set([...stable.availability.start.reasons, ...reasons])] } } }
      inputs.observation = { ...unsigned, revision: upgradeRevision(unsigned) }
    }
    return inputs
  }
  const fresh = async (target: string): Promise<UpgradeCaller> => {
    const caller = await ctx.authenticate()
    if (caller.principalId !== ctx.caller.principalId || caller.actor !== ctx.caller.actor) return unchanged('FORBIDDEN', 'upgrade authority changed')
    await ctx.assertRootCaller(caller, target)
    return caller
  }

  if (url.pathname === '/host/upgrade') return json((await observe()).observation)

  if (url.pathname === '/host/upgrade/status') {
    const inputs = await observe()
    const { observation } = inputs
    const history = (await listUpgrades(ctx.db, { limit: 20 })).map(projectUpgradeRecord)
    return json({ observedAt: observation.observedAt, revision: observation.revision, lock: observation.lock, retirementPending: observation.retirementPending, maintenance: observation.maintenance, current: observation.current, latest: history[0] ?? null, history })
  }

  const start = url.pathname === '/host/upgrade/start'
  const request = await parseUpgradeRequest(req, start)
  const evaluated = evaluate(await observe(), request)
  const { observation } = evaluated.inputs
  if (!start) {
    return json({ observedAt: observation.observedAt, revision: observation.revision, targetVersion: request.targetVersion, fromVersion: observation.current.version,
      report: evaluated.report, start: { enabled: evaluated.report.ok && observation.availability.start.enabled, reasons: [...(evaluated.report.ok ? [] : ['preflight-failed']), ...observation.availability.start.reasons] } })
  }

  if (!evaluated.report.ok) return unchanged('PRECONDITION_FAILED', 'preflight did not pass', { reasons: ['preflight-failed'], report: evaluated.report })
  if (!observation.availability.start.enabled || !ctx.coordinator) return unchanged('PRECONDITION_FAILED', 'the upgrade cannot start on this host', { reasons: observation.availability.start.reasons })
  const caller = await fresh('host.upgrade.start')
  // Signature bound to the archive bytes just hashed; re-checked here so a key rotation since the read refuses.
  try { verifyReleaseArtifactSignature(evaluated.manifest, evaluated.inputs.trust.keys) } catch { return unchanged('PRECONDITION_FAILED', 'staged release signature no longer verifies', { reasons: ['staged-release-not-verified'] }) }
  const handoffId = randomUUID()
  const target = `release:${evaluated.release.version}`
  try { await appendAudit(ctx.db, { actor: caller.actor, principalId: caller.principalId, action: 'upgrade.handoff_requested', target, detail: { handoffId, fromVersion: observation.current.version, sha256: evaluated.release.sha256, keyId: evaluated.manifest.keyId }, outcome: 'ok' }) }
  catch { return unchanged('PRECONDITION_FAILED', 'upgrade handoff could not be audited before dispatch') }
  const actor = await fresh('host.upgrade.start')
  let accepted: UpgradeCoordinatorAcknowledgement
  try { accepted = await ctx.coordinator.start({ actor: { kind: 'root', id: actor.principalId, username: actor.actor }, release: evaluated.release, manifest: evaluated.manifest, handoffId, expectedRevision: request.expectedRevision }) }
  catch (error) {
    await appendAudit(ctx.db, { actor: actor.actor, principalId: actor.principalId, action: 'upgrade.handoff_failed', target, detail: { handoffId }, outcome: 'failed' }).catch(() => undefined)
    return fail('SERVICE_UNAVAILABLE', 'the upgrade coordinator did not confirm the handoff', { handoffId, stateChanged: true, unknownOutcome: true, verificationRequired: true })
  }
  const upgradeId = typeof accepted?.upgradeId === 'string' ? accepted.upgradeId : null
  let acceptedHandoffId: string = handoffId
  let job: Pick<DurableJobRecord, 'id' | 'referenceCode' | 'status'> | undefined
  try {
    await fresh('host.upgrade.start')
    if (upgradeId !== null && !isUuid(upgradeId)) throw new Error('invalid_upgrade_acknowledgement')
    if (accepted.job) {
      const saved = readUpgradeIntentJob(await getDurableJob(ctx.db, accepted.job.id))
      if (saved.job.referenceCode !== accepted.job.referenceCode || saved.job.status !== accepted.job.status || saved.intent.principalId !== actor.principalId || saved.intent.actor !== actor.actor
        || saved.job.needsAttention || !['queued', 'running', 'succeeded'].includes(saved.job.status)
        || saved.intent.expectedRevision !== request.expectedRevision || saved.intent.manifestDigest !== signedReleaseManifestDigest(evaluated.manifest) || JSON.stringify(saved.intent.release) !== JSON.stringify(evaluated.release)
        || !isUuid(accepted.handoffId) || accepted.handoffId !== saved.intent.handoffId) throw new Error('invalid_durable_handoff')
      acceptedHandoffId = saved.intent.handoffId
      job = { id: saved.job.id, referenceCode: saved.job.referenceCode, status: saved.job.status }
    }
    await appendAudit(ctx.db, { actor: actor.actor, principalId: actor.principalId, action: 'upgrade.handoff_accepted', target, detail: { handoffId: acceptedHandoffId, upgradeId, ...(job ? { referenceCode: job.referenceCode } : {}) }, outcome: 'ok' })
  }
  catch { return fail('SERVICE_UNAVAILABLE', 'upgrade handoff was dispatched but requires audit review', { handoffId, stateChanged: true, verificationRequired: true }) }
  return json({ accepted: true, handoffId: acceptedHandoffId, upgradeId, targetVersion: evaluated.release.version, fromVersion: observation.current.version, ...(job ? { job, deduplicated: accepted.deduplicated === true } : {}) }, 202)
}
