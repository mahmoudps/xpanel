import { createHash, randomUUID } from 'node:crypto'
import {
  assertAbsPath, assertId, assertInt, assertLine, fail, isUuid,
  parseBoundReconcileOperation, parseReconcileOperationState, projectReconcilePublicOperation,
  type BoundReconcileOperation, type ReconcileOperationState, type ReconcilePublicOperation,
} from '@xpanel/core'
import type { Db } from '../client.ts'
import { assertNoActiveDatabaseTransaction, assertRegisteredDatabaseRunner, assertStrictDurableTransaction, getStrictDatabaseIdentity } from '../sql-runner.ts'
import { assertHostOperationGuardActive, assertHostOperationGuardHeld, type HostOperationGuard } from '../host-operation-guard.ts'
import { withSqliteErrors } from '../sqlite-errors.ts'
import { issueReservedJobReferenceTx, requireOperationalIdentity, reserveOfficialJobReferenceTx } from './official-references.ts'
import { assertOperationIntentReceipt } from './operation-audit-authority.ts'

interface OperationRow extends Record<string, unknown> {
  job_id: string; issuer_id: string; request_key: string; request_fingerprint: string; binding_json: string
  source_revision: number; source_checksum: string; source_committed_lease_id: string | null
  snapshot_locator: string; snapshot_sha256: string; status: string; phase: string; reason: string | null
  intent_event_uid: string | null; intent_entry_hash: string | null; host_epoch: number | null
  execution_started_at: string | null
  generation_id: number | null; journal_locator: string | null; journal_sha256: string | null
  receipt_json: string | null; created_at: string; updated_at: string; settled_at: string | null
  reference_code: string | null; cancel_requested: number; lease_owner: string | null
  fencing_token: number; lease_expires_at: string | null; attempt: number; max_attempts: number
}

/** Private worker state. A route must use getReconcilePublicOperation instead. */
export interface ReconcileOperationRecord {
  readonly jobId: string
  readonly issuerId: string
  readonly binding: BoundReconcileOperation
  readonly state: ReconcileOperationState
  readonly snapshot: Readonly<{ locator: string; sha256: string }>
  readonly intent: Readonly<{ eventUid: string; entryHash: string }> | null
  readonly hostEpoch: number | null
  readonly executionStartedAt: string | null
  readonly leaseOwner: string | null
  readonly fencingToken: number
  readonly leaseExpiresAt: string | null
  readonly attempt: number
  readonly maxAttempts: number
  readonly generationId: number | null
  readonly journal: Readonly<{ locator: string; sha256: string }> | null
}

const sha256 = (value: unknown, field: string): string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : fail('VALIDATION', `${field} must be a SHA-256 digest`)
const operationTransaction = <T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> => {
  assertRegisteredDatabaseRunner(db)
  assertNoActiveDatabaseTransaction()
  return db.transaction(fn)
}

const readOperationTx = async (db: Db, jobId: string): Promise<ReconcileOperationRecord | null> => {
  const [row] = await db.query<OperationRow>(`SELECT o.*,l.cancel_requested,l.lease_owner,l.fencing_token,l.lease_expires_at,l.attempt,l.max_attempts,
    r.reference_code FROM reconcile_operations o JOIN job_runtime_leases l ON l.job_id=o.job_id
    LEFT JOIN official_reference_ledger r ON r.issuer_id=o.issuer_id AND r.kind='job' AND r.entity_id=o.job_id AND r.publication_state='issued' AND r.tombstoned_at IS NULL
    WHERE o.job_id=$1`, [jobId])
  if (!row) return null
  const binding = parseBoundReconcileOperation(JSON.parse(row.binding_json))
  if (binding.requestKey !== row.request_key || binding.requestFingerprint !== row.request_fingerprint || binding.source.revision !== row.source_revision || binding.source.checksum !== row.source_checksum || binding.source.committedLeaseId !== row.source_committed_lease_id) return fail('PRECONDITION_FAILED', 'stored reconcile binding is inconsistent')
  const state = parseReconcileOperationState({
    schemaVersion: 1, reference: row.reference_code, source: binding.source,
    configurationScope: 'global_configuration', targetVerified: false, verificationRequired: true,
    cancelRequested: row.cancel_requested === 1, status: row.status, phase: row.phase,
    needsAttention: row.status === 'needs_attention', reason: row.reason,
    receipt: row.receipt_json === null ? null : JSON.parse(row.receipt_json),
  })
  return Object.freeze({ jobId: row.job_id, issuerId: row.issuer_id, binding, state,
    snapshot: Object.freeze({ locator: row.snapshot_locator, sha256: row.snapshot_sha256 }),
    intent: row.intent_event_uid && row.intent_entry_hash ? Object.freeze({ eventUid: row.intent_event_uid, entryHash: row.intent_entry_hash }) : null,
    hostEpoch: row.host_epoch, executionStartedAt: row.execution_started_at, leaseOwner: row.lease_owner, fencingToken: row.fencing_token,
    leaseExpiresAt: row.lease_expires_at, attempt: row.attempt, maxAttempts: row.max_attempts,
    generationId: row.generation_id, journal: row.journal_locator && row.journal_sha256 ? Object.freeze({ locator: row.journal_locator, sha256: row.journal_sha256 }) : null,
  })
}

export const getReconcileOperation = async (db: Db, jobId: string): Promise<ReconcileOperationRecord | null> => {
  if (!isUuid(jobId)) return null
  await requireOperationalIdentity(db)
  return readOperationTx(db, jobId.toLowerCase())
}

export const getReconcilePublicOperation = async (db: Db, jobId: string): Promise<ReconcilePublicOperation | null> => {
  const operation = await getReconcileOperation(db, jobId)
  return operation ? projectReconcilePublicOperation(operation.state) : null
}

/** Reserves durable state only. accepted:false is not permission to return an accepted response. */
export const reserveReconcileOperation = (
  db: Db,
  boundValue: unknown,
  snapshot: { locator: string; sha256: string },
): Promise<{ operation: ReconcileOperationRecord; deduplicated: boolean; accepted: boolean }> => withSqliteErrors(async () => {
  const binding = parseBoundReconcileOperation(boundValue)
  const locator = assertAbsPath(snapshot.locator, 'snapshot.locator')
  const snapshotDigest = sha256(snapshot.sha256, 'snapshot.sha256')
  return operationTransaction(db, async tx => {
    assertStrictDurableTransaction(tx)
    const issuer = await requireOperationalIdentity(tx)
    const [existing] = await tx.query<{ job_id: string; request_fingerprint: string; snapshot_sha256: string }>('SELECT job_id,request_fingerprint,snapshot_sha256 FROM reconcile_operations WHERE issuer_id=$1 AND request_key=$2', [issuer, binding.requestKey])
    if (existing) {
      if (existing.request_fingerprint !== binding.requestFingerprint || existing.snapshot_sha256 !== snapshotDigest) return fail('CONFLICT', 'reconcile request key already binds a different operation')
      const operation = (await readOperationTx(tx, existing.job_id))!
      return { operation, deduplicated: true, accepted: operation.intent !== null && operation.state.status !== 'awaiting_intent' }
    }
    const jobId = randomUUID()
    const now = new Date().toISOString()
    const reference = await reserveOfficialJobReferenceTx(tx, { jobId, at: new Date(now), issued: false })
    const accountId = binding.subject.kind === 'server' ? null : binding.subject.account.id
    await tx.query(`INSERT INTO jobs(id,kind,account_id,actor,status,summary,created_at,updated_at) VALUES($1,'host.reconcile',$2,$3,'queued','Host configuration',$4,$4)`, [jobId, accountId, binding.authorization.principalId, now])
    await tx.query(`INSERT INTO job_runtime_leases(job_id,request_fingerprint,target_revision,reference_code,updated_at) VALUES($1,$2,$3,$4,$5)`, [jobId, binding.requestFingerprint, binding.source.revision, reference, now])
    await tx.query(`INSERT INTO reconcile_operations(job_id,issuer_id,request_key,request_fingerprint,binding_json,source_revision,source_checksum,source_committed_lease_id,snapshot_locator,snapshot_sha256,status,phase,reason,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'awaiting_intent','intent','submission_not_accepted',$11,$11)`, [jobId, issuer, binding.requestKey, binding.requestFingerprint, JSON.stringify(binding), binding.source.revision, binding.source.checksum, binding.source.committedLeaseId, locator, snapshotDigest, now])
    return { operation: (await readOperationTx(tx, jobId))!, deduplicated: false, accepted: false }
  })
})

/** Only an actual durable audit producer/restart-verifier capability can confirm submission. */
export const confirmReconcileIntent = (db: Db, jobId: string, receipt: unknown): Promise<ReconcileOperationRecord> => withSqliteErrors(async () => {
  const id = assertId(jobId, 'jobId')
  return operationTransaction(db, async tx => {
    assertStrictDurableTransaction(tx)
    await requireOperationalIdentity(tx)
    const operation = await readOperationTx(tx, id)
    if (!operation) return fail('NOT_FOUND', 'reconcile operation does not exist')
    const verified = assertOperationIntentReceipt(receipt, { purpose: 'host.reconcile.intent', jobId: id, requestFingerprint: operation.binding.requestFingerprint, action: operation.binding.action, principalId: operation.binding.authorization.principalId }, tx)
    if (operation.intent) {
      if (operation.intent.eventUid !== verified.eventUid || operation.intent.entryHash !== verified.entryHash) return fail('CONFLICT', 'operation intent differs from the confirmed audit record')
      return operation
    }
    if (operation.state.status !== 'awaiting_intent') return fail('PRECONDITION_FAILED', 'operation is not awaiting intent confirmation')
    const now = new Date().toISOString()
    await issueReservedJobReferenceTx(tx, id, now)
    await tx.query("UPDATE reconcile_operations SET status='queued',phase='queued',reason=NULL,intent_event_uid=$1,intent_entry_hash=$2,updated_at=$3 WHERE job_id=$4 AND status='awaiting_intent'", [verified.eventUid, verified.entryHash, now, id])
    return (await readOperationTx(tx, id))!
  })
})

/** Records a cancellation request; authorization is independently enforced by the receiver. */
export const requestReconcileCancellation = (db: Db, jobId: string): Promise<ReconcileOperationRecord> => withSqliteErrors(async () => operationTransaction(db, async tx => {
  assertStrictDurableTransaction(tx)
  const issuer = await requireOperationalIdentity(tx)
  const id = assertId(jobId, 'jobId')
  const operation = await readOperationTx(tx, id)
  if (!operation) return fail('NOT_FOUND', 'reconcile operation does not exist')
  if (operation.state.status === 'cancelled') return operation
  if (operation.state.status !== 'awaiting_intent' && operation.state.status !== 'queued' && operation.state.status !== 'running' && operation.state.status !== 'cancelling') return fail('PRECONDITION_FAILED', 'operation cannot be cancelled in this state')
  const now = new Date().toISOString()
  if (operation.state.status === 'awaiting_intent' || operation.state.status === 'queued') {
    await tx.query("UPDATE official_reference_ledger SET publication_state='abandoned' WHERE issuer_id=$1 AND kind='job' AND entity_id=$2 AND publication_state='reserved'", [issuer, id])
    await tx.query("UPDATE reconcile_operations SET status='cancelled',phase='settled',reason='cancelled_before_effect',settled_at=$1,updated_at=$1 WHERE job_id=$2", [now, id])
    await tx.query("UPDATE jobs SET status='cancelled',finished_at=$1,updated_at=$1 WHERE id=$2", [now, id])
  } else {
    await tx.query("UPDATE reconcile_operations SET status='cancelling',updated_at=$1 WHERE job_id=$2", [now, id])
  }
  await tx.query('UPDATE job_runtime_leases SET cancel_requested=1,updated_at=$1 WHERE job_id=$2', [now, id])
  return (await readOperationTx(tx, id))!
}))

export interface ReconcileExecutionLease {
  readonly jobId: string
  readonly workerId: string
  readonly fencingToken: number
  readonly hostEpoch: number
  readonly guard: HostOperationGuard
}

const guardedTransaction = async <T>(db: Db, guard: unknown, fn: (tx: Db, issuer: string) => Promise<T>): Promise<T> => {
  assertRegisteredDatabaseRunner(db)
  assertNoActiveDatabaseTransaction()
  const binding = await db.transaction(async tx => { const origin = getStrictDatabaseIdentity(tx); return { databaseFile: origin.file, databaseDevice: origin.device, databaseInode: origin.inode, issuerId: await requireOperationalIdentity(tx) } })
  await assertHostOperationGuardHeld(guard, binding)
  return db.transaction(async tx => {
    const origin = getStrictDatabaseIdentity(tx)
    const actual = { databaseFile: origin.file, databaseDevice: origin.device, databaseInode: origin.inode, issuerId: await requireOperationalIdentity(tx) }
    assertHostOperationGuardActive(guard, actual)
    return fn(tx, actual.issuerId)
  })
}

const activeLeaseTx = async (tx: Db, lease: ReconcileExecutionLease, now: string): Promise<ReconcileOperationRecord> => {
  const operation = await readOperationTx(tx, assertId(lease.jobId))
  if (!operation) return fail('NOT_FOUND', 'reconcile operation does not exist')
  const [authority] = await tx.query<{ last_epoch: number }>('SELECT last_epoch FROM reconcile_host_epochs WHERE issuer_id=$1', [operation.issuerId])
  if (!authority || operation.hostEpoch !== lease.hostEpoch || authority.last_epoch !== lease.hostEpoch || operation.leaseOwner !== lease.workerId || operation.fencingToken !== lease.fencingToken || !operation.leaseExpiresAt || operation.leaseExpiresAt <= now) return fail('CONFLICT', 'reconcile execution lease is expired or superseded')
  if (operation.state.status !== 'running' && operation.state.status !== 'cancelling') return fail('PRECONDITION_FAILED', 'reconcile operation is not running')
  return operation
}

const leaseDuration = (value: number | undefined): number => value === undefined ? 30_000 : assertInt(value, 50, 3_600_000, 'leaseDurationMs')

export type ReconcileClaimResult =
  | { readonly status: 'claimed'; readonly lease: ReconcileExecutionLease }
  | { readonly status: 'idle' }
  | { readonly status: 'blocked'; readonly blockingJobId: string; readonly blockingStatus: 'running' | 'cancelling' | 'needs_attention'; readonly reference: string | null; readonly reason: string }

const quarantineExpiredTx = async (tx: Db, now: string): Promise<number> => {
  const expired = await tx.query<{ job_id: string }>(`SELECT o.job_id FROM reconcile_operations o JOIN job_runtime_leases l ON l.job_id=o.job_id
    WHERE o.status IN ('running','cancelling') AND l.lease_expires_at IS NOT NULL AND l.lease_expires_at <= $1 ORDER BY l.lease_expires_at,o.job_id LIMIT 100`, [now])
  for (const { job_id: id } of expired) {
    await tx.query("UPDATE reconcile_operations SET status='needs_attention',phase='attention',reason='lease_lost',updated_at=$1 WHERE job_id=$2", [now, id])
    await tx.query("UPDATE jobs SET status='failed',error='Execution lease lost; owned runtime quiescence and recovery inspection are required',finished_at=$1,updated_at=$1 WHERE id=$2", [now, id])
    await tx.query("UPDATE job_runtime_leases SET lease_owner=NULL,lease_expires_at=NULL,needs_attention=1,failure_class='unknown_outcome',updated_at=$1 WHERE job_id=$2", [now, id])
  }
  return expired.length
}

/** Conservative metadata quarantine only. It proves no child quiescence or host recovery. */
export const quarantineExpiredReconcileOperations = (db: Db): Promise<number> => withSqliteErrors(async () => operationTransaction(db, async tx => {
  assertStrictDurableTransaction(tx)
  await requireOperationalIdentity(tx)
  return quarantineExpiredTx(tx, new Date().toISOString())
}))

const hostBlockerTx = async (tx: Db): Promise<Extract<ReconcileClaimResult, { status: 'blocked' }> | null> => {
  const [row] = await tx.query<{ job_id: string; status: 'running' | 'cancelling' | 'needs_attention'; reason: string; reference_code: string | null }>(`SELECT o.job_id,o.status,
    CASE WHEN o.status IN ('running','cancelling') THEN 'execution_in_progress' ELSE o.reason END AS reason,r.reference_code FROM reconcile_operations o
    LEFT JOIN official_reference_ledger r ON r.entity_id=o.job_id AND r.kind='job' AND r.publication_state='issued' AND r.tombstoned_at IS NULL
    WHERE o.status IN ('running','cancelling','needs_attention')
    ORDER BY CASE WHEN o.status='needs_attention' THEN 0 ELSE 1 END,o.created_at,o.job_id LIMIT 1`)
  return row ? Object.freeze({ status: 'blocked', blockingJobId: row.job_id, blockingStatus: row.status, reference: row.reference_code, reason: row.reason }) : null
}

/** Private canonical-control-plane admission state; not a runtime incident inspection receipt. */
export const getReconcileHostBlocker = async (db: Db): Promise<Extract<ReconcileClaimResult, { status: 'blocked' }> | null> => {
  await requireOperationalIdentity(db)
  return hostBlockerTx(db)
}

/** Guard first, database lease second. A previous partial effect always requires recovery review. */
export const claimReconcileOperation = (db: Db, input: { guard: HostOperationGuard; workerId: string; jobId?: string; leaseDurationMs?: number }): Promise<ReconcileClaimResult> => withSqliteErrors(async () => {
  const worker = assertLine(input.workerId, 128, 'workerId', { allowEmpty: false })
  const duration = leaseDuration(input.leaseDurationMs)
  const id = input.jobId === undefined ? null : assertId(input.jobId, 'jobId')
  return guardedTransaction(db, input.guard, async (tx, issuer) => {
    const nowDate = new Date()
    const now = nowDate.toISOString()
    await quarantineExpiredTx(tx, now)
    const blocker = await hostBlockerTx(tx)
    if (blocker) return blocker
    const [candidate] = await tx.query<{ job_id: string }>(`SELECT o.job_id FROM reconcile_operations o JOIN job_runtime_leases l ON l.job_id=o.job_id
      WHERE o.issuer_id=$1 AND ($2 IS NULL OR o.job_id=$2) AND o.status='queued'
      ORDER BY o.created_at,o.job_id LIMIT 1`, [issuer, id])
    if (!candidate) return { status: 'idle' }
    const operation = (await readOperationTx(tx, candidate.job_id))!
    if (!operation.intent || operation.state.reference === null) return fail('PRECONDITION_FAILED', 'unconfirmed or unissued operation is ineligible')
    const previousEffects = await tx.query<{ found: number }>('SELECT 1 AS found FROM reconcile_operation_effects WHERE job_id=$1 LIMIT 1', [operation.jobId])
    if (operation.attempt >= operation.maxAttempts || previousEffects.length > 0) {
      await tx.query("UPDATE reconcile_operations SET status='needs_attention',phase='attention',reason='effect_outcome_unknown',updated_at=$1 WHERE job_id=$2", [now, operation.jobId])
      await tx.query("UPDATE jobs SET status='failed',error='Reconcile execution requires recovery review',finished_at=$1,updated_at=$1 WHERE id=$2", [now, operation.jobId])
      await tx.query("UPDATE job_runtime_leases SET lease_owner=NULL,lease_expires_at=NULL,needs_attention=1,failure_class='unknown_outcome',updated_at=$1 WHERE job_id=$2", [now, operation.jobId])
      return (await hostBlockerTx(tx))!
    }
    if (operation.state.cancelRequested) {
      await tx.query("UPDATE reconcile_operations SET status='needs_attention',phase='attention',reason='effect_outcome_unknown',updated_at=$1 WHERE job_id=$2", [now, operation.jobId])
      await tx.query("UPDATE jobs SET status='failed',error='Inconsistent cancellation requires owned runtime recovery inspection',finished_at=$1,updated_at=$1 WHERE id=$2", [now, operation.jobId])
      await tx.query("UPDATE job_runtime_leases SET lease_owner=NULL,lease_expires_at=NULL,needs_attention=1,failure_class='unknown_outcome',updated_at=$1 WHERE job_id=$2", [now, operation.jobId])
      return (await hostBlockerTx(tx))!
    }
    const [epoch] = await tx.query<{ last_epoch: number }>('UPDATE reconcile_host_epochs SET last_epoch=last_epoch+1 WHERE issuer_id=$1 AND last_epoch<9007199254740991 RETURNING last_epoch', [issuer])
    if (!epoch || operation.fencingToken >= Number.MAX_SAFE_INTEGER) return fail('LIMIT_EXCEEDED', 'reconcile execution epoch is exhausted')
    const token = operation.fencingToken + 1
    await tx.query("UPDATE job_runtime_leases SET lease_owner=$1,fencing_token=$2,attempt=attempt+1,lease_expires_at=$3,updated_at=$4 WHERE job_id=$5", [worker, token, new Date(nowDate.getTime() + duration).toISOString(), now, operation.jobId])
    await tx.query("UPDATE jobs SET status='running',started_at=COALESCE(started_at,$1),updated_at=$1 WHERE id=$2", [now, operation.jobId])
    await tx.query("UPDATE reconcile_operations SET status='running',phase='prepare',host_epoch=$1,execution_started_at=$2,updated_at=$2 WHERE job_id=$3", [epoch.last_epoch, now, operation.jobId])
    return Object.freeze({ status: 'claimed', lease: Object.freeze({ jobId: operation.jobId, workerId: worker, fencingToken: token, hostEpoch: epoch.last_epoch, guard: input.guard }) })
  })
})

export const renewReconcileLease = (db: Db, lease: ReconcileExecutionLease, durationMs?: number): Promise<ReconcileOperationRecord> => withSqliteErrors(async () => {
  const duration = leaseDuration(durationMs)
  return guardedTransaction(db, lease.guard, async tx => {
    const nowDate = new Date()
    const now = nowDate.toISOString()
    await activeLeaseTx(tx, lease, now)
    await tx.query('UPDATE job_runtime_leases SET lease_expires_at=$1,updated_at=$2 WHERE job_id=$3', [new Date(nowDate.getTime() + duration).toISOString(), now, lease.jobId])
    return (await readOperationTx(tx, lease.jobId))!
  })
})

export const checkpointReconcileOperation = (db: Db, lease: ReconcileExecutionLease, input: { phase: 'prepare' | 'stage' | 'test' | 'activate' | 'reload' | 'verify' | 'settle'; generationId?: number; journal?: { locator: string; sha256: string } }): Promise<ReconcileOperationRecord> => withSqliteErrors(async () => {
  const generation = input.generationId === undefined ? null : assertInt(input.generationId, 1, Number.MAX_SAFE_INTEGER, 'generationId')
  const locator = input.journal === undefined ? null : assertAbsPath(input.journal.locator, 'journal.locator')
  const journalDigest = input.journal === undefined ? null : sha256(input.journal.sha256, 'journal.sha256')
  return guardedTransaction(db, lease.guard, async tx => {
    const now = new Date().toISOString()
    const operation = await activeLeaseTx(tx, lease, now)
    parseReconcileOperationState({ ...operation.state, phase: input.phase })
    if (generation !== null && (await tx.query('SELECT id FROM config_generations WHERE id=$1', [generation])).length !== 1) return fail('PRECONDITION_FAILED', 'operation generation must exist in the durable generation registry')
    if (operation.generationId !== null && generation !== null && operation.generationId !== generation) return fail('CONFLICT', 'operation generation is already bound')
    if (operation.journal && input.journal && (operation.journal.locator !== locator || operation.journal.sha256 !== journalDigest)) return fail('CONFLICT', 'operation journal is already bound')
    await tx.query('UPDATE reconcile_operations SET phase=$1,generation_id=COALESCE(generation_id,$2),journal_locator=COALESCE(journal_locator,$3),journal_sha256=COALESCE(journal_sha256,$4),updated_at=$5 WHERE job_id=$6', [input.phase, generation, locator, journalDigest, now, lease.jobId])
    return (await readOperationTx(tx, lease.jobId))!
  })
})

const boundedObject = (value: unknown, field: string): string => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return fail('VALIDATION', `${field} must be a plain object`)
  const text = JSON.stringify(value)
  if (Buffer.byteLength(text, 'utf8') > 64 * 1024) return fail('LIMIT_EXCEEDED', `${field} is too large`)
  return text
}

/** Commits effect intent before the caller performs any host effect. This method executes none. */
export const recordReconcileEffectIntent = (db: Db, lease: ReconcileExecutionLease, input: { effectKey: string; intent: Record<string, unknown> }): Promise<{ sequence: number; alreadyObserved: boolean }> => withSqliteErrors(async () => {
  const key = assertLine(input.effectKey, 128, 'effectKey', { allowEmpty: false })
  const text = boundedObject(input.intent, 'intent')
  const fingerprint = createHash('sha256').update(text).digest('hex')
  return guardedTransaction(db, lease.guard, async tx => {
    const now = new Date().toISOString()
    const operation = await activeLeaseTx(tx, lease, now)
    if (operation.state.cancelRequested) return fail('PRECONDITION_FAILED', 'cancellation prevents a new host effect')
    const [existing] = await tx.query<{ effect_sequence: number; intent_sha256: string; state: string }>('SELECT effect_sequence,intent_sha256,state FROM reconcile_operation_effects WHERE job_id=$1 AND attempt=$2 AND effect_key=$3', [lease.jobId, operation.attempt, key])
    if (existing) {
      if (existing.intent_sha256 !== fingerprint) return fail('CONFLICT', 'effect key already has different intent')
      if (existing.state !== 'observed') return fail('PRECONDITION_FAILED', 'existing effect intent has an unknown outcome and must not be replayed')
      return { sequence: existing.effect_sequence, alreadyObserved: true }
    }
    const [last] = await tx.query<{ sequence: number }>('SELECT COALESCE(MAX(effect_sequence),0)+1 AS sequence FROM reconcile_operation_effects WHERE job_id=$1 AND attempt=$2', [lease.jobId, operation.attempt])
    const sequence = assertInt(last?.sequence, 1, 1024, 'effectSequence')
    await tx.query(`INSERT INTO reconcile_operation_effects(job_id,attempt,effect_sequence,effect_key,host_epoch,lease_fencing_token,intent_json,intent_sha256,state,started_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'started',$9)`, [lease.jobId, operation.attempt, sequence, key, lease.hostEpoch, lease.fencingToken, text, fingerprint, now])
    return { sequence, alreadyObserved: false }
  })
})

/** Persists trusted observations; JSON syntax does not prove that a service probe ran. */
export const recordReconcileEffectObservation = (db: Db, lease: ReconcileExecutionLease, sequence: number, observation: Record<string, unknown>): Promise<void> => withSqliteErrors(async () => {
  const text = boundedObject(observation, 'observation')
  const index = assertInt(sequence, 1, 1024, 'effectSequence')
  return guardedTransaction(db, lease.guard, async tx => {
    const now = new Date().toISOString()
    const operation = await activeLeaseTx(tx, lease, now)
    const rows = await tx.query<{ effect_sequence: number }>("UPDATE reconcile_operation_effects SET state='observed',observation_json=$1,observed_at=$2 WHERE job_id=$3 AND attempt=$4 AND effect_sequence=$5 AND host_epoch=$6 AND lease_fencing_token=$7 AND state='started' RETURNING effect_sequence", [text, now, lease.jobId, operation.attempt, index, lease.hostEpoch, lease.fencingToken])
    if (rows.length !== 1) return fail('CONFLICT', 'effect intent is missing, superseded or already observed')
  })
})

/** Settles only under the live guard and lease; the receiver supplies actual observed evidence. */
export const settleReconcileOperation = (db: Db, lease: ReconcileExecutionLease, outcome: { status: 'applied' | 'unchanged' | 'failed' | 'cancelled' | 'superseded' | 'needs_attention'; reason?: string; receipt?: unknown }): Promise<ReconcileOperationRecord> => withSqliteErrors(async () => guardedTransaction(db, lease.guard, async tx => {
  const now = new Date().toISOString()
  const operation = await activeLeaseTx(tx, lease, now)
  const success = outcome.status === 'applied' || outcome.status === 'unchanged'
  const receipt = success ? outcome.receipt : null
  const state = parseReconcileOperationState({ ...operation.state, status: outcome.status, phase: outcome.status === 'needs_attention' ? 'attention' : 'settled', needsAttention: outcome.status === 'needs_attention', reason: success ? null : outcome.reason, receipt })
  const outstanding = await tx.query<{ state: string }>("SELECT state FROM reconcile_operation_effects WHERE job_id=$1 AND state != 'observed' LIMIT 1", [lease.jobId])
  if (outstanding.length && outcome.status !== 'needs_attention') return fail('PRECONDITION_FAILED', 'unobserved effects require recovery attention before final settlement')
  if (state.receipt && (operation.generationId === null || state.receipt.generation.id !== operation.generationId)) return fail('CONFLICT', 'receipt generation does not match the bound operation')
  if (state.receipt && state.receipt.observedAt > now) return fail('VALIDATION', 'receipt observation cannot be in the future')
  if (state.receipt) {
    if (!operation.executionStartedAt || state.receipt.observedAt < operation.executionStartedAt || state.receipt.observations.some(item => item.observedAt < operation.executionStartedAt!)) return fail('PRECONDITION_FAILED', 'receipt observations must belong to this execution epoch')
    const [generation] = await tx.query<{ status: string; checksum: string }>('SELECT status,checksum FROM config_generations WHERE id=$1', [operation.generationId])
    if (!generation || generation.status !== 'active' || generation.checksum !== state.receipt.generation.filesChecksum) return fail('PRECONDITION_FAILED', 'receipt must match the actual durable active generation')
  }
  const jobStatus = success ? 'succeeded' : outcome.status === 'cancelled' ? 'cancelled' : 'failed'
  await tx.query('UPDATE reconcile_operations SET status=$1,phase=$2,reason=$3,receipt_json=$4,settled_at=$5,updated_at=$5 WHERE job_id=$6', [state.status, state.phase, state.reason, state.receipt ? JSON.stringify(state.receipt) : null, now, lease.jobId])
  await tx.query('UPDATE jobs SET status=$1,progress=$2,error=$3,finished_at=$4,updated_at=$4 WHERE id=$5', [jobStatus, success ? 100 : 0, jobStatus === 'failed' ? 'Reconcile operation did not complete; inspect the operation outcome' : null, now, lease.jobId])
  await tx.query('UPDATE job_runtime_leases SET lease_owner=NULL,lease_expires_at=NULL,needs_attention=$1,failure_class=$2,updated_at=$3 WHERE job_id=$4', [outcome.status === 'needs_attention' ? 1 : 0, outcome.status === 'needs_attention' ? 'unknown_outcome' : null, now, lease.jobId])
  return (await readOperationTx(tx, lease.jobId))!
}))
