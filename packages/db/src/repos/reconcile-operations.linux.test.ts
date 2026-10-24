import { createStrictTestDb } from '../strict-test-db.ts'
import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { bindReconcileOperation } from '@xpanel/core'
import { disposableVmAcknowledgement } from '../../../../scripts/test-linux-preflight.mjs'
import { createDb, type DbHandle } from '../client.ts'
import { withHostOperationGuard } from '../host-operation-guard.ts'
import { migrate } from '../migrate.ts'
import { ARGON2 } from '../testing.ts'
import { createRootPrincipal } from './principals.ts'
import { createRootOperationAuditAuthority } from './operation-audit-authority.ts'
import { confirmLegacyJobReferenceRepair, initializeOperationalMetadata, reserveLegacyJobReferenceRepair } from './official-references.ts'
import { getDurableJob, getJob } from './jobs.ts'
import {
  checkpointReconcileOperation, claimReconcileOperation, confirmReconcileIntent, getReconcileOperation,
  recordReconcileEffectIntent, recordReconcileEffectObservation, renewReconcileLease,
  requestReconcileCancellation, reserveReconcileOperation, settleReconcileOperation,
} from './reconcile-operations.ts'

// Real Linux root guards and audit sync; only control-plane metadata, never hosting-service proof.
// Run this file alone with maxWorkers=1 in a fresh disposable VM, not an installed server.
const guardParent = '/var/lib/xpanel-agent'
const handles: DbHandle[] = []
const directories: string[] = []
let admitted = false
let ownedParent: { device: bigint; inode: bigint } | undefined
beforeAll(async () => {
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.geteuid?.() !== 0 || process.env.XPANEL_TEST_DISPOSABLE_VM !== disposableVmAcknowledgement) {
    throw new Error('BLOCKED: actual Linux root in an explicitly acknowledged disposable VM is required')
  }
  const existing = await lstat(guardParent).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (existing) throw new Error('BLOCKED: preserve existing host-operation namespace and use a fresh disposable VM')
  admitted = true
})
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
  for (const directory of directories.splice(0)) {
    if (!directory.startsWith('/root/xpanel-r04-db-')) throw new Error('Unsafe fixture cleanup target')
    await rm(directory, { recursive: true, force: true })
  }
})
afterAll(async () => {
  if (!admitted || !ownedParent) return
  const current = await lstat(guardParent, { bigint: true })
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== ownedParent.device || current.ino !== ownedParent.inode) throw new Error('Guard fixture identity changed; preserve for inspection')
  // Every guard scope has returned and every connection is closed before owned fixture removal.
  await rm(guardParent, { recursive: true })
})
const recordOwnedParent = async () => {
  const current = await lstat(guardParent, { bigint: true })
  if (!ownedParent) ownedParent = { device: current.dev, inode: current.ino }
  expect(current.dev).toBe(ownedParent.device)
  expect(current.ino).toBe(ownedParent.inode)
}
const fixture = async () => {
  const directory = await mkdtemp('/root/xpanel-r04-db-')
  directories.push(directory)
  await chmod(directory, 0o700)
  const sink = join(directory, 'audit')
  await mkdir(sink, { mode: 0o700 })
  const handle = createDb(join(directory, 'control.sqlite'), { durability: 'strict' })
  handles.push(handle)
  await migrate(handle.db)
  await initializeOperationalMetadata(handle.db)
  const principal = await createRootPrincipal(handle.db, { username: 'operator', passwordHash: ARGON2, forcePasswordChange: false })
  const authority = await createRootOperationAuditAuthority(handle.db, { directory: sink })
  const accepted = async (key: string) => {
    const bound = bindReconcileOperation({ schemaVersion: 1, requestKey: key }, {
      source: { revision: 1, checksum: 'a'.repeat(64), committedLeaseId: randomUUID() },
      subject: { kind: 'server' }, action: 'server.reconcile',
      authorization: { principalId: principal.id, credential: { kind: 'local_operator', id: null, revision: 0 }, audience: 'management', scopes: ['*'] },
    })
    const reserved = await reserveReconcileOperation(handle.db, bound, { locator: join(directory, 'snapshot.json'), sha256: 'b'.repeat(64) })
    expect(reserved.accepted).toBe(false)
    expect((await getJob(handle.db, reserved.operation.jobId))?.referenceCode).toBeNull()
    const receipt = await authority.appendReconcileIntent({ purpose: 'host.reconcile.intent', jobId: reserved.operation.jobId, requestFingerprint: bound.requestFingerprint, action: bound.action, principalId: principal.id })
    const confirmed = await confirmReconcileIntent(handle.db, reserved.operation.jobId, receipt)
    expect(confirmed.state.status).toBe('queued')
    expect(confirmed.state.reference).toMatch(/^XP-JOB-[0-9]{4}-[0-9]{6,16}$/)
    expect((await getJob(handle.db, confirmed.jobId))?.referenceCode).toBe(confirmed.state.reference)
    expect((await confirmReconcileIntent(handle.db, confirmed.jobId, await authority.recoverReconcileIntent({ purpose: 'host.reconcile.intent', jobId: confirmed.jobId, requestFingerprint: bound.requestFingerprint, action: bound.action, principalId: principal.id }))).state.reference).toBe(confirmed.state.reference)
    return confirmed
  }
  return { directory, handle, principal, authority, accepted }
}

describe('native R04 database integration with genuine root authorities', () => {
  it.each(['running', 'cancelling'] as const)('blocks same-guard second claims while the %s incumbent retains its lease, then admits work only after settlement', async activeStatus => {
    const f = await fixture(), first = await f.accepted(`incumbent-${activeStatus}`), next = await f.accepted(`blocked-${activeStatus}`)
    await withHostOperationGuard(f.handle.db, {}, async guard => {
      await recordOwnedParent()
      const claimed = await claimReconcileOperation(f.handle.db, { guard, workerId: 'incumbent-worker', jobId: first.jobId })
      if (claimed.status !== 'claimed') throw new Error('Expected actual incumbent claim')
      if (activeStatus === 'cancelling') await requestReconcileCancellation(f.handle.db, first.jobId)
      const before = await f.handle.db.query('SELECT * FROM job_runtime_leases ORDER BY job_id')
      const epochs = await f.handle.db.query('SELECT * FROM reconcile_host_epochs')
      for (const jobId of [next.jobId, first.jobId]) {
        expect(await claimReconcileOperation(f.handle.db, { guard, workerId: 'second-worker', jobId })).toMatchObject({ status: 'blocked', blockingJobId: first.jobId, blockingStatus: activeStatus, reason: 'execution_in_progress' })
      }
      expect(await f.handle.db.query('SELECT * FROM job_runtime_leases ORDER BY job_id')).toEqual(before)
      expect(await f.handle.db.query('SELECT * FROM reconcile_host_epochs')).toEqual(epochs)
      await renewReconcileLease(f.handle.db, claimed.lease)
      await settleReconcileOperation(f.handle.db, claimed.lease, { status: 'failed', reason: 'host_execution_failed' })
      const following = await claimReconcileOperation(f.handle.db, { guard, workerId: 'following-worker', jobId: next.jobId })
      if (following.status !== 'claimed') throw new Error('Terminal incumbent should permit next claim')
      expect(following.lease.hostEpoch).toBe(claimed.lease.hostEpoch + 1)
      await settleReconcileOperation(f.handle.db, following.lease, { status: 'failed', reason: 'host_execution_failed' })
    })
  })

  it('blocks a new guard scope before an abandoned incumbent lease expires without upgrading the stale capability or assuming no child survives', async () => {
    const f = await fixture(), first = await f.accepted('preexpiry-first'), next = await f.accepted('preexpiry-second')
    await withHostOperationGuard(f.handle.db, {}, async guard => {
      await recordOwnedParent()
      const result = await claimReconcileOperation(f.handle.db, { guard, workerId: 'abandoned-worker', jobId: first.jobId, leaseDurationMs: 60_000 })
      if (result.status !== 'claimed') throw new Error('Expected actual first claim')
      // No child/effect is started by the fixture. Returning without settlement models unknown runtime ownership.
    })
    const before = await f.handle.db.query('SELECT * FROM job_runtime_leases ORDER BY job_id')
    const epochs = await f.handle.db.query('SELECT * FROM reconcile_host_epochs')
    await withHostOperationGuard(f.handle.db, {}, async guard => {
      expect(await claimReconcileOperation(f.handle.db, { guard, workerId: 'reacquired-worker', jobId: next.jobId })).toMatchObject({ status: 'blocked', blockingJobId: first.jobId, blockingStatus: 'running', reason: 'execution_in_progress' })
    })
    expect(await f.handle.db.query('SELECT * FROM job_runtime_leases ORDER BY job_id')).toEqual(before)
    expect(await f.handle.db.query('SELECT * FROM reconcile_host_epochs')).toEqual(epochs)
  })

  it('confirms actual synced intent, persists guarded effect metadata and a failed outcome without claiming service success', async () => {
    const f = await fixture(), operation = await f.accepted('effect-metadata')
    let escaped: Parameters<typeof renewReconcileLease>[1] | undefined
    await withHostOperationGuard(f.handle.db, {}, async guard => {
      await recordOwnedParent()
      const claimed = await claimReconcileOperation(f.handle.db, { guard, workerId: 'native-metadata-worker', jobId: operation.jobId })
      expect(claimed.status).toBe('claimed')
      if (claimed.status !== 'claimed') throw new Error('Actual guard did not admit queued operation')
      escaped = claimed.lease
      await renewReconcileLease(f.handle.db, claimed.lease)
      await checkpointReconcileOperation(f.handle.db, claimed.lease, { phase: 'stage' })
      const effect = await recordReconcileEffectIntent(f.handle.db, claimed.lease, { effectKey: 'diagnostic-metadata', intent: { diagnosticOnly: true } })
      await expect(recordReconcileEffectIntent(f.handle.db, claimed.lease, { effectKey: 'diagnostic-metadata', intent: { diagnosticOnly: true } })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
      await recordReconcileEffectObservation(f.handle.db, claimed.lease, effect.sequence, { diagnosticOnly: true, serviceProbeExecuted: false })
      expect(await recordReconcileEffectIntent(f.handle.db, claimed.lease, { effectKey: 'diagnostic-metadata', intent: { diagnosticOnly: true } })).toMatchObject({ alreadyObserved: true })
      const settled = await settleReconcileOperation(f.handle.db, claimed.lease, { status: 'failed', reason: 'host_execution_failed' })
      expect(settled.state).toMatchObject({ status: 'failed', receipt: null, reference: operation.state.reference })
    })
    await expect(renewReconcileLease(f.handle.db, escaped!)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect((await getDurableJob(f.handle.db, operation.jobId))?.status).toBe('failed')
  })

  it('blocks subsequent host admission after actual lease expiry even with no effect intent, without asserting child quiescence', async () => {
    const f = await fixture(), first = await f.accepted('expires-first'), next = await f.accepted('waits-second')
    await withHostOperationGuard(f.handle.db, {}, async guard => {
      await recordOwnedParent()
      const claimed = await claimReconcileOperation(f.handle.db, { guard, workerId: 'expiring-worker', jobId: first.jobId, leaseDurationMs: 50 })
      if (claimed.status !== 'claimed') throw new Error('Expected actual first claim')
      await new Promise(resolve => setTimeout(resolve, 80))
      await expect(renewReconcileLease(f.handle.db, claimed.lease)).rejects.toMatchObject({ code: 'CONFLICT' })
      expect(await claimReconcileOperation(f.handle.db, { guard, workerId: 'next-worker', jobId: next.jobId })).toMatchObject({ status: 'blocked', blockingJobId: first.jobId, reason: 'lease_lost' })
    })
    await withHostOperationGuard(f.handle.db, {}, async guard => {
      expect(await claimReconcileOperation(f.handle.db, { guard, workerId: 'later-worker', jobId: next.jobId })).toMatchObject({ status: 'blocked', blockingJobId: first.jobId })
    })
    expect((await getReconcileOperation(f.handle.db, next.jobId))?.attempt).toBe(0)
    expect(await f.handle.db.query('SELECT * FROM reconcile_operation_effects')).toHaveLength(0)
  })

  it('quarantines an inconsistent queued cancellation and returns a durable blocker instead of repeatedly throwing at the queue head', async () => {
    const f = await fixture(), first = await f.accepted('inconsistent-first'), next = await f.accepted('following-queued')
    await f.handle.db.query('UPDATE job_runtime_leases SET cancel_requested=1 WHERE job_id=$1', [first.jobId])
    await withHostOperationGuard(f.handle.db, {}, async guard => {
      await recordOwnedParent()
      expect(await claimReconcileOperation(f.handle.db, { guard, workerId: 'review-worker', jobId: first.jobId })).toMatchObject({ status: 'blocked', blockingJobId: first.jobId, reason: 'effect_outcome_unknown' })
      expect(await claimReconcileOperation(f.handle.db, { guard, workerId: 'review-worker', jobId: next.jobId })).toMatchObject({ status: 'blocked', blockingJobId: first.jobId })
    })
    expect((await getReconcileOperation(f.handle.db, next.jobId))?.attempt).toBe(0)
  })

  it('confirms explicit legacy metadata repair through its own synced audit purpose and preserves the issued reference on replay', async () => {
    const f = await fixture(), id = randomUUID()
    await f.handle.db.query("INSERT INTO jobs(id,kind,actor,status) VALUES($1,'backup.create','root','failed')", [id])
    const input = { jobId: id, requestKey: 'reviewed-metadata-repair', principalId: f.principal.id, reason: 'Unissued legacy metadata review' }
    const repair = await reserveLegacyJobReferenceRepair(f.handle.db, input)
    expect(repair.reference).toBeNull()
    if (!repair.intentBinding || !repair.repairId) throw new Error('Expected explicit repair reservation')
    const receipt = await f.authority.appendReferenceRepairIntent(repair.intentBinding)
    const confirmed = await confirmLegacyJobReferenceRepair(f.handle.db, repair.repairId, receipt)
    expect(confirmed.state).toBe('confirmed')
    expect(confirmed.reference).toMatch(/^XP-JOB-[0-9]{4}-[0-9]{6,16}$/)
    expect((await getJob(f.handle.db, id))?.referenceCode).toBe(confirmed.reference)
    expect(await confirmLegacyJobReferenceRepair(f.handle.db, repair.repairId, await f.authority.recoverReferenceRepairIntent(repair.intentBinding))).toEqual(confirmed)
    expect(await f.handle.db.query('SELECT * FROM reconcile_operation_effects')).toHaveLength(0)
  })
})
