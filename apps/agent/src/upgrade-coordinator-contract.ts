import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { fail, isUuid } from '@xpanel/core'
import type { DurableJobRecord } from '@xpanel/db'
import type { ReleaseInfo } from '@xpanel/lifecycle'

export const UPGRADE_HANDOFF_KIND = 'lifecycle.upgrade.handoff'
export const UPGRADE_HANDOFF_LEASE_MS = 3_600_000
const SHA = /^[0-9a-f]{64}$/
const VERSION = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => object(v) && Object.keys(v).sort().join(',') === keys.sort().join(',')
const bad = (): never => fail('PRECONDITION_FAILED', 'upgrade handoff binding requires inspection', { stateChanged: false })
export interface UpgradeIntent {
  version: 1; handoffId: string; principalId: string; actor: string; expectedRevision: string
  release: ReleaseInfo; manifestDigest: string
}
export interface UpgradeProcessBinding { jobId: string; requestFingerprint: string; referenceCode: string; workerId: string; fencingToken: number }
export const upgradeIntentFingerprint = (intent: UpgradeIntent): string => {
  const { handoffId: _handoffId, ...stable } = intent
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex')
}
export function parseUpgradeIntent(raw: unknown): UpgradeIntent {
  if (!exact(raw, ['version', 'handoffId', 'principalId', 'actor', 'expectedRevision', 'release', 'manifestDigest']) || raw.version !== 1 || !isUuid(raw.handoffId) || !isUuid(raw.principalId)
    || typeof raw.actor !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(raw.actor) || typeof raw.expectedRevision !== 'string' || !SHA.test(raw.expectedRevision) || typeof raw.manifestDigest !== 'string' || !SHA.test(raw.manifestDigest)
    || !exact(raw.release, ['version', 'schemaVersion', 'archivePath', 'sha256', 'bytes'])) return bad()
  const r = raw.release
  if (typeof r.version !== 'string' || !VERSION.test(r.version) || !Number.isSafeInteger(r.schemaVersion) || Number(r.schemaVersion) < 0 || typeof r.archivePath !== 'string' || !isAbsolute(r.archivePath) || r.archivePath.length > 4095 || /[\u0000-\u001f\u007f]/.test(r.archivePath)
    || typeof r.sha256 !== 'string' || !SHA.test(r.sha256) || !Number.isSafeInteger(r.bytes) || Number(r.bytes) < 1) return bad()
  return { version: 1, handoffId: raw.handoffId as string, principalId: raw.principalId as string, actor: raw.actor, expectedRevision: raw.expectedRevision,
    release: { version: r.version, schemaVersion: Number(r.schemaVersion), archivePath: r.archivePath, sha256: r.sha256, bytes: Number(r.bytes) }, manifestDigest: raw.manifestDigest }
}
export function parseUpgradeProcessBinding(raw: unknown): UpgradeProcessBinding {
  if (!exact(raw, ['jobId', 'requestFingerprint', 'referenceCode', 'workerId', 'fencingToken']) || !isUuid(raw.jobId) || typeof raw.requestFingerprint !== 'string' || !SHA.test(raw.requestFingerprint)
    || typeof raw.referenceCode !== 'string' || !/^XP-JOB-[0-9]{4}-[0-9]{6,16}$/.test(raw.referenceCode) || BigInt(raw.referenceCode.split('-')[3]!) === 0n
    || typeof raw.workerId !== 'string' || !/^upgrade-coordinator-[0-9a-f-]{36}$/.test(raw.workerId) || !Number.isSafeInteger(raw.fencingToken) || Number(raw.fencingToken) < 1) return bad()
  return { jobId: raw.jobId as string, requestFingerprint: raw.requestFingerprint, referenceCode: raw.referenceCode, workerId: raw.workerId, fencingToken: Number(raw.fencingToken) }
}
export function readUpgradeIntentJob(job: DurableJobRecord | null, binding?: UpgradeProcessBinding, now = new Date()): { job: DurableJobRecord; intent: UpgradeIntent } {
  if (!job || job.kind !== UPGRADE_HANDOFF_KIND || job.accountId !== null || job.maxAttempts !== 1 || !job.referenceCode) return bad()
  const intent = parseUpgradeIntent(job.detail.upgradeHandoff), fingerprint = upgradeIntentFingerprint(intent)
  if (job.actor !== intent.actor || job.requestFingerprint !== fingerprint || job.idempotencyKey !== 'upgrade-handoff:' + fingerprint || !/^XP-JOB-[0-9]{4}-[0-9]{6,16}$/.test(job.referenceCode)) return bad()
  if (binding && (job.id !== binding.jobId || job.requestFingerprint !== binding.requestFingerprint || job.referenceCode !== binding.referenceCode || job.status !== 'running' || job.needsAttention || job.cancelRequested
    || job.fencingToken !== binding.fencingToken || job.leaseOwner !== binding.workerId || !job.leaseExpiresAt || job.leaseExpiresAt <= now.toISOString())) return bad()
  return { job, intent }
}
