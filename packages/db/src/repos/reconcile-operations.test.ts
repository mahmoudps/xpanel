import { createStrictTestDb } from '../strict-test-db.ts'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { bindReconcileOperation } from '@xpanel/core'
import { createDb, type Db, type DbHandle } from '../client.ts'
import type { HostOperationGuard } from '../host-operation-guard.ts'
import { acquireJobLease, completeJobWithLease, createJob, enqueueDurableJob, executeLeasedJobStep, finishJob, getDurableJob, getJob, listJobs, renewJobLease, requestJobCancellation, saveJobCheckpoint, updateJobProgress } from './jobs.ts'
import { reserveLegacyJobReferenceRepair } from './official-references.ts'
import { pruneExpiredOperationalRecords } from './audit.ts'
import { runOperationalRetentionPrune } from './metrics.ts'
import { claimReconcileOperation, confirmReconcileIntent, getReconcileHostBlocker, getReconcileOperation, getReconcilePublicOperation, quarantineExpiredReconcileOperations, requestReconcileCancellation, reserveReconcileOperation } from './reconcile-operations.ts'

const handles: DbHandle[] = []
afterEach(async () => { for (const h of handles.splice(0).reverse()) await h.close() })
const fresh = async () => { const h = await createStrictTestDb(); handles.push(h); return h }
const context = () => ({ source: { revision: 1, checksum: 'a'.repeat(64), committedLeaseId: randomUUID() }, subject: { kind: 'server' }, action: 'server.reconcile', authorization: { principalId: randomUUID(), credential: { kind: 'local_operator', id: null, revision: 0 }, audience: 'management', scopes: ['*'] } })
const snapshot = { locator: '/var/lib/xpanel-agent/snapshots/source-1.json', sha256: 'b'.repeat(64) }

describe('R04 durable operation reservation and authority boundaries', () => {
  it('rejects a structural provider before it can fabricate a reservation or host-claim result', async () => {
    let invoked = 0
    const fake = Object.defineProperty({}, 'transaction', { get() { invoked++; return () => Promise.resolve({ status: 'claimed', accepted: true }) } }) as Db
    const bound = bindReconcileOperation({ schemaVersion: 1, requestKey: 'fake-operation-provider' }, context())
    await expect(reserveReconcileOperation(fake, bound, snapshot)).rejects.toThrow('a registered public database runner is required')
    await expect(confirmReconcileIntent(fake, randomUUID(), {})).rejects.toThrow('a registered public database runner is required')
    await expect(claimReconcileOperation(fake, { workerId: 'worker', guard: {} as HostOperationGuard })).rejects.toThrow('a registered public database runner is required')
    await expect(quarantineExpiredReconcileOperations(fake)).rejects.toThrow('a registered public database runner is required')
    expect(invoked).toBe(0)
  })

  it('keeps reserved numbers invisible across old and new reads and strips private source context', async () => {
    const h = await fresh(); const bound = bindReconcileOperation({ schemaVersion: 1, requestKey: 'reserve-one' }, context())
    const result = await reserveReconcileOperation(h.db, bound, snapshot)
    expect(result.accepted).toBe(false)
    expect(result.operation.state).toMatchObject({ status: 'awaiting_intent', reference: null, receipt: null })
    expect((await getJob(h.db, result.operation.jobId))?.referenceCode).toBeNull()
    expect((await getDurableJob(h.db, result.operation.jobId))?.referenceCode).toBeNull()
    expect((await listJobs(h.db))[0]?.referenceCode).toBeNull()
    const publicState = await getReconcilePublicOperation(h.db, result.operation.jobId)
    expect(publicState).toMatchObject({ sourceRevision: 1, status: 'awaiting_intent', reference: null })
    expect(JSON.stringify(publicState)).not.toContain(bound.source.checksum)
    expect(JSON.stringify(publicState)).not.toContain(bound.source.committedLeaseId)
    expect(JSON.stringify(publicState)).not.toContain(bound.authorization.principalId)
    expect(JSON.stringify(publicState)).not.toContain('snapshot')
    expect((await h.db.query<{ publication_state: string }>('SELECT publication_state FROM official_reference_ledger'))[0]?.publication_state).toBe('reserved')
  })

  it('deduplicates the full trusted binding and rejects changed scope/action/source or snapshot', async () => {
    const h = await fresh(); const trusted = context(); const request = { schemaVersion: 1, requestKey: 'same-request' }
    const first = await reserveReconcileOperation(h.db, bindReconcileOperation(request, trusted), snapshot)
    for (let i = 0; i < 10; i++) expect((await reserveReconcileOperation(h.db, bindReconcileOperation(request, trusted), snapshot)).operation.jobId).toBe(first.operation.jobId)
    for (const changed of [{ ...trusted, action: 'server.restart' }, { ...trusted, source: { ...trusted.source, revision: 2 } }, { ...trusted, authorization: { ...trusted.authorization, scopes: ['server:read'] } }]) {
      await expect(reserveReconcileOperation(h.db, bindReconcileOperation(request, changed), snapshot)).rejects.toMatchObject({ code: 'CONFLICT' })
    }
    await expect(reserveReconcileOperation(h.db, bindReconcileOperation(request, trusted), { ...snapshot, sha256: 'c'.repeat(64) })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await h.db.query('SELECT * FROM jobs')).toHaveLength(1)
    expect(await h.db.query('SELECT * FROM official_reference_ledger')).toHaveLength(1)
    expect((await h.db.query<{ last_sequence: number }>('SELECT last_sequence FROM official_reference_counters'))[0]?.last_sequence).toBe(1)
  })

  it('rejects forged durable intent metadata and forged host guards without confirming or executing', async () => {
    const h = await fresh(); const bound = bindReconcileOperation({ schemaVersion: 1, requestKey: 'deny-forged' }, context())
    const { operation } = await reserveReconcileOperation(h.db, bound, snapshot)
    await expect(confirmReconcileIntent(h.db, operation.jobId, { durable: true, eventUid: randomUUID(), entryHash: 'c'.repeat(64) })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(claimReconcileOperation(h.db, { jobId: operation.jobId, workerId: 'worker', guard: { held: true } as unknown as HostOperationGuard })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect((await getReconcileOperation(h.db, operation.jobId))?.state.status).toBe('awaiting_intent')
    expect((await getJob(h.db, operation.jobId))?.referenceCode).toBeNull()
    expect((await getDurableJob(h.db, operation.jobId))?.attempt).toBe(0)
  })

  it('rejects every generic mutating job entrypoint for the reserved reconcile kind', async () => {
    const h = await fresh(); const { operation } = await reserveReconcileOperation(h.db, bindReconcileOperation({ schemaVersion: 1, requestKey: 'no-generic-bypass' }, context()), snapshot)
    const lease = { jobId: operation.jobId, workerId: 'worker', fencingToken: 1 }
    let ran = false
    const calls = [
      () => createJob(h.db, { kind: 'host.reconcile', actor: 'root' }),
      () => enqueueDurableJob(h.db, { kind: 'host.reconcile', actor: 'root' }),
      () => updateJobProgress(h.db, operation.jobId, 1),
      () => finishJob(h.db, operation.jobId, { status: 'failed', error: 'blocked' }),
      () => acquireJobLease(h.db, { jobId: operation.jobId, workerId: 'worker' }),
      () => acquireJobLease(h.db, { kind: 'host.reconcile', workerId: 'worker' }),
      () => renewJobLease(h.db, lease),
      () => saveJobCheckpoint(h.db, { ...lease, step: 'activate' }),
      () => requestJobCancellation(h.db, { jobId: operation.jobId, actor: 'root' }),
      () => completeJobWithLease(h.db, { ...lease, status: 'succeeded' }),
      () => executeLeasedJobStep(h.db, { ...lease, step: 'activate', run: async () => { ran = true } }),
    ]
    for (const call of calls) await expect(call()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(ran).toBe(false)
    expect(await acquireJobLease(h.db, { workerId: 'worker' })).toBeNull()
    expect((await getReconcileOperation(h.db, operation.jobId))?.state.status).toBe('awaiting_intent')
  })

  it('does not accept an unverified NORMAL connection even against an initialized file', async () => {
    const h = await fresh(); const [main] = (await h.db.query<{ name: string; file: string }>('PRAGMA database_list')).filter(row => row.name === 'main')
    const normal = createDb(main!.file); handles.push(normal)
    await expect(reserveReconcileOperation(normal.db, bindReconcileOperation({ schemaVersion: 1, requestKey: 'normal-rejected' }, context()), snapshot)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(await h.db.query('SELECT * FROM jobs')).toHaveLength(0)
  })

  it('cancels an unaccepted reservation without issuing it or enabling a retry to enqueue', async () => {
    const h = await fresh(); const bound = bindReconcileOperation({ schemaVersion: 1, requestKey: 'cancel-reservation' }, context())
    const { operation } = await reserveReconcileOperation(h.db, bound, snapshot)
    expect((await requestReconcileCancellation(h.db, operation.jobId)).state).toMatchObject({ status: 'cancelled', reason: 'cancelled_before_effect', reference: null })
    expect((await reserveReconcileOperation(h.db, bound, snapshot)).accepted).toBe(false)
    expect((await h.db.query<{ publication_state: string }>('SELECT publication_state FROM official_reference_ledger'))[0]?.publication_state).toBe('abandoned')
    expect((await getJob(h.db, operation.jobId))?.referenceCode).toBeNull()
  })

  it.each(['running', 'cancelling'] as const)('quarantines expired %s metadata without claiming quiescence or poisoning the next queued operation', async interruptedStatus => {
    const h = await fresh()
    const old = (await reserveReconcileOperation(h.db, bindReconcileOperation({ schemaVersion: 1, requestKey: `interrupted-${interruptedStatus}` }, context()), snapshot)).operation
    const next = (await reserveReconcileOperation(h.db, bindReconcileOperation({ schemaVersion: 1, requestKey: `following-${interruptedStatus}` }, context()), snapshot)).operation
    // Persisted crash-state fixtures only. They mint no audit/guard capability and authorize no execution.
    await h.db.transaction(async tx => {
      const now = new Date().toISOString()
      for (const id of [old.jobId, next.jobId]) {
        await tx.query("UPDATE official_reference_ledger SET publication_state='issued',issued_at=$1 WHERE entity_id=$2", [now, id])
        await tx.query("UPDATE reconcile_operations SET status='queued',phase='queued',reason=NULL,intent_event_uid=$1,intent_entry_hash=$2 WHERE job_id=$3", [randomUUID(), 'f'.repeat(64), id])
      }
      await tx.query("UPDATE reconcile_operations SET status=$1,phase='prepare',host_epoch=1,execution_started_at='2000-01-01T00:00:00.000Z' WHERE job_id=$2", [interruptedStatus, old.jobId])
      await tx.query("UPDATE jobs SET status='running' WHERE id=$1", [old.jobId])
      await tx.query("UPDATE job_runtime_leases SET lease_owner='dead-worker',fencing_token=1,attempt=1,lease_expires_at='2000-01-01T00:00:00.000Z',cancel_requested=$1 WHERE job_id=$2", [interruptedStatus === 'cancelling' ? 1 : 0, old.jobId])
    })
    expect(await quarantineExpiredReconcileOperations(h.db)).toBe(1)
    expect(await quarantineExpiredReconcileOperations(h.db)).toBe(0)
    expect((await getReconcileOperation(h.db, old.jobId))?.state).toMatchObject({ status: 'needs_attention', reason: 'lease_lost' })
    expect(await getReconcileHostBlocker(h.db)).toMatchObject({ status: 'blocked', blockingJobId: old.jobId, reason: 'lease_lost' })
    expect((await getReconcileOperation(h.db, next.jobId))?.state.status).toBe('queued')
    expect((await getDurableJob(h.db, next.jobId))?.attempt).toBe(0)
    expect(await h.db.query('SELECT * FROM reconcile_operation_effects')).toHaveLength(0)
  })

  it.each(['running', 'cancelling'] as const)('reports an unexpired %s incumbent as a host admission blocker without changing its lease or epoch', async activeStatus => {
    const h = await fresh()
    const first = (await reserveReconcileOperation(h.db, bindReconcileOperation({ schemaVersion: 1, requestKey: `active-${activeStatus}` }, context()), snapshot)).operation
    const next = (await reserveReconcileOperation(h.db, bindReconcileOperation({ schemaVersion: 1, requestKey: `queued-${activeStatus}` }, context()), snapshot)).operation
    // Actual DB readiness fixture only; no audit/physical-guard capability and no execution claim.
    await h.db.transaction(async tx => {
      const now = new Date().toISOString()
      for (const id of [first.jobId, next.jobId]) {
        await tx.query("UPDATE official_reference_ledger SET publication_state='issued',issued_at=$1 WHERE entity_id=$2", [now, id])
        await tx.query("UPDATE reconcile_operations SET status='queued',phase='queued',reason=NULL,intent_event_uid=$1,intent_entry_hash=$2 WHERE job_id=$3", [randomUUID(), 'f'.repeat(64), id])
      }
      await tx.query('UPDATE reconcile_host_epochs SET last_epoch=1 WHERE issuer_id=$1', [first.issuerId])
      await tx.query("UPDATE reconcile_operations SET status=$1,phase='prepare',host_epoch=1,execution_started_at=$2 WHERE job_id=$3", [activeStatus, now, first.jobId])
      await tx.query("UPDATE job_runtime_leases SET lease_owner='incumbent',fencing_token=1,attempt=1,lease_expires_at='2999-01-01T00:00:00.000Z',cancel_requested=$1 WHERE job_id=$2", [activeStatus === 'cancelling' ? 1 : 0, first.jobId])
      await tx.query("UPDATE jobs SET status='running' WHERE id=$1", [first.jobId])
    })
    const before = await h.db.query('SELECT * FROM job_runtime_leases ORDER BY job_id')
    const epochs = await h.db.query('SELECT * FROM reconcile_host_epochs')
    expect(await getReconcileHostBlocker(h.db)).toMatchObject({ status: 'blocked', blockingJobId: first.jobId, blockingStatus: activeStatus, reason: 'execution_in_progress' })
    expect(await quarantineExpiredReconcileOperations(h.db)).toBe(0)
    expect((await getReconcileOperation(h.db, first.jobId))?.state.status).toBe(activeStatus)
    expect((await getReconcileOperation(h.db, next.jobId))?.state.status).toBe('queued')
    expect(await h.db.query('SELECT * FROM job_runtime_leases ORDER BY job_id')).toEqual(before)
    expect(await h.db.query('SELECT * FROM reconcile_host_epochs')).toEqual(epochs)
  })

  it.each(['audit', 'metrics'] as const)('preserves operations, unresolved attention and pending repairs through the %s pruner', async mode => {
    const h = await fresh(); const { operation } = await reserveReconcileOperation(h.db, bindReconcileOperation({ schemaVersion: 1, requestKey: `prune-${mode}` }, context()), snapshot)
    await requestReconcileCancellation(h.db, operation.jobId)
    const attention = await createJob(h.db, { kind: 'backup.create', actor: 'root' })
    await finishJob(h.db, attention.id, { status: 'failed', error: 'unknown outcome' })
    await h.db.query('UPDATE job_runtime_leases SET needs_attention=1 WHERE job_id=$1', [attention.id])
    const prunable = await createJob(h.db, { kind: 'backup.create', actor: 'root' }); await finishJob(h.db, prunable.id, { status: 'succeeded' })
    const repairJob = randomUUID()
    await h.db.query("INSERT INTO jobs(id,kind,actor,status,finished_at) VALUES($1,'backup.create','root','failed','2000-01-01T00:00:00.000Z')", [repairJob])
    await reserveLegacyJobReferenceRepair(h.db, { jobId: repairJob, requestKey: `repair-${mode}`, principalId: randomUUID(), reason: 'Reviewed legacy metadata' })
    const now = new Date(Date.now() + 120 * 86_400_000)
    if (mode === 'audit') await pruneExpiredOperationalRecords(h.db, { now })
    else await runOperationalRetentionPrune(h.db, { now })
    for (const id of [operation.jobId, attention.id, repairJob]) expect(await getJob(h.db, id)).not.toBeNull()
    expect(await getJob(h.db, prunable.id)).toBeNull()
    expect(await h.db.query('SELECT * FROM official_reference_ledger')).toHaveLength(4)
    expect((await h.db.query<{ tombstoned_at: string | null }>('SELECT tombstoned_at FROM official_reference_ledger WHERE entity_id=$1', [prunable.id]))[0]?.tombstoned_at).not.toBeNull()
  })
})
