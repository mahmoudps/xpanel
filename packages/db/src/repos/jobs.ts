import { createHash, randomUUID } from 'node:crypto'
import {
  assertAbsPath,
  assertId,
  assertIdOrNull,
  assertInt,
  assertLine,
  fail,
  isUuid,
  oneOf,
  redactSecrets,
} from '@xpanel/core'
import type { Id } from '@xpanel/core'
import type { Db } from '../client.ts'
import { JOB_STATUSES } from '../schema.ts'
import { withSqliteErrors } from '../sqlite-errors.ts'
import { clampLimit, first, mustExist, nowIso } from './util.ts'

export type JobStatus = (typeof JOB_STATUSES)[number]
export type JobFailureClass = 'retryable' | 'permanent' | 'unknown_outcome'

const FAILURE_CLASSES: readonly JobFailureClass[] = ['retryable', 'permanent', 'unknown_outcome']

export interface JobRecord {
  id: Id
  kind: string
  accountId: Id | null
  actor: string
  status: JobStatus
  progress: number
  summary: string
  detail: Record<string, unknown>
  error: string | null
  logPath: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  updatedAt: string
}

export interface DurableJobRecord extends JobRecord {
  idempotencyKey: string | null
  requestFingerprint: string
  targetRevision: number | null
  leaseOwner: string | null
  fencingToken: number
  leaseExpiresAt: string | null
  attempt: number
  maxAttempts: number
  checkpointStep: string | null
  checkpointData: Record<string, unknown>
  completedSteps: string[]
  cancelRequested: boolean
  cancelReason: string | null
  failureClass: JobFailureClass | null
  needsAttention: boolean
  referenceCode: string
}

interface JobRow {
  id: string
  kind: string
  account_id: string | null
  actor: string
  status: JobStatus
  progress: number
  summary: string
  detail: string
  error: string | null
  log_path: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  updated_at: string
  [k: string]: unknown
}

interface DurableJobJoinedRow extends JobRow {
  idempotency_key: string | null
  request_fingerprint: string | null
  target_revision: number | null
  lease_owner: string | null
  fencing_token: number | null
  lease_expires_at: string | null
  attempt: number | null
  max_attempts: number | null
  checkpoint_step: string | null
  checkpoint_json: string | null
  completed_steps_json: string | null
  cancel_requested: number | null
  cancel_reason: string | null
  failure_class: JobFailureClass | null
  needs_attention: number | null
  reference_code: string | null
}

const JOB_KIND_RE = /^[a-z][a-z0-9_.:-]{0,127}$/
const DEFAULT_LEASE_MS = 30_000
const MIN_LEASE_MS = 50
const MAX_LEASE_MS = 3_600_000

const JOB_RUNTIME_LEASES_DDL = `
CREATE TABLE IF NOT EXISTS job_runtime_leases (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  idempotency_key TEXT UNIQUE,
  request_fingerprint TEXT NOT NULL DEFAULT '',
  target_revision INTEGER,
  lease_owner TEXT,
  fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  lease_expires_at TEXT,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
  checkpoint_step TEXT,
  checkpoint_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(checkpoint_json) AND json_type(checkpoint_json) = 'object'),
  completed_steps_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(completed_steps_json) AND json_type(completed_steps_json) = 'array'),
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
  cancel_reason TEXT,
  failure_class TEXT CHECK (failure_class IS NULL OR failure_class IN ('retryable', 'permanent', 'unknown_outcome')),
  needs_attention INTEGER NOT NULL DEFAULT 0 CHECK (needs_attention IN (0, 1)),
  reference_code TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS job_runtime_leases_owner_idx ON job_runtime_leases (lease_owner, lease_expires_at);
`

/**
 * Lazily initializes the operational `job_runtime_leases` table so existing migration
 * checksums and strict schema table lists remain untouched until durable job operations run.
 */
export const ensureJobDurabilityTables = async (db: Db): Promise<void> => {
  await db.exec(JOB_RUNTIME_LEASES_DDL)
}

const fromRow = (r: JobRow): JobRecord => ({
  id: r.id,
  kind: r.kind,
  accountId: r.account_id,
  actor: r.actor,
  status: r.status,
  progress: r.progress,
  summary: r.summary,
  detail: JSON.parse(r.detail) as Record<string, unknown>,
  error: r.error,
  logPath: r.log_path,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  updatedAt: r.updated_at,
})

const fromDurableRow = (r: DurableJobJoinedRow): DurableJobRecord => ({
  ...fromRow(r),
  idempotencyKey: r.idempotency_key ?? null,
  requestFingerprint: r.request_fingerprint ?? '',
  targetRevision: r.target_revision ?? null,
  leaseOwner: r.lease_owner ?? null,
  fencingToken: r.fencing_token ?? 0,
  leaseExpiresAt: r.lease_expires_at ?? null,
  attempt: r.attempt ?? 0,
  maxAttempts: r.max_attempts ?? 3,
  checkpointStep: r.checkpoint_step ?? null,
  checkpointData: r.checkpoint_json ? (JSON.parse(r.checkpoint_json) as Record<string, unknown>) : {},
  completedSteps: r.completed_steps_json ? (JSON.parse(r.completed_steps_json) as string[]) : [],
  cancelRequested: r.cancel_requested === 1,
  cancelReason: r.cancel_reason ?? null,
  failureClass: r.failure_class ?? null,
  needsAttention: r.needs_attention === 1,
  referenceCode: r.reference_code ?? `XP-JOB-000000`,
})

const canonicalizeValue = (val: unknown): unknown => {
  if (val === null || typeof val !== 'object') return val
  if (Array.isArray(val)) return val.map(canonicalizeValue)
  const record = val as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((k) => [k, canonicalizeValue(record[k])]),
  )
}

export const computeJobRequestFingerprint = (input: {
  kind: string
  accountId: Id | null
  actor: string
  targetRevision?: number | null
  detail: Record<string, unknown>
}): string => {
  const payload = canonicalizeValue({
    kind: input.kind,
    accountId: input.accountId,
    actor: input.actor,
    targetRevision: input.targetRevision ?? null,
    detail: redactSecrets(input.detail),
  })
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex')
}

const allocateNextReferenceCode = async (tx: Db): Promise<string> => {
  const rows = await tx.query<{ seq: number }>(
    `SELECT COALESCE(MAX(rowid), 0) + 1 AS seq FROM job_runtime_leases`,
  )
  const seq = rows[0]?.seq ?? 1
  return `XP-JOB-${String(seq).padStart(6, '0')}`
}

const queryDurableJobTx = async (tx: Db, id: Id): Promise<DurableJobRecord | null> => {
  if (!isUuid(id)) return null
  const rows = await tx.query<DurableJobJoinedRow>(
    `SELECT
       j.*,
       l.idempotency_key,
       l.request_fingerprint,
       l.target_revision,
       l.lease_owner,
       l.fencing_token,
       l.lease_expires_at,
       l.attempt,
       l.max_attempts,
       l.checkpoint_step,
       l.checkpoint_json,
       l.completed_steps_json,
       l.cancel_requested,
       l.cancel_reason,
       l.failure_class,
       l.needs_attention,
       l.reference_code
     FROM jobs j
     LEFT JOIN job_runtime_leases l ON l.job_id = j.id
     WHERE j.id = $1`,
    [id.toLowerCase()],
  )
  const row = first(rows)
  return row ? fromDurableRow(row) : null
}

const ensureLeaseRowForLegacyJobTx = async (tx: Db, jobId: Id, now: string): Promise<void> => {
  const existing = await tx.query<{ job_id: string }>(
    `SELECT job_id FROM job_runtime_leases WHERE job_id = $1`,
    [jobId],
  )
  if (existing.length > 0) return
  const refCode = await allocateNextReferenceCode(tx)
  await tx.query(
    `INSERT INTO job_runtime_leases (
       job_id, idempotency_key, request_fingerprint, reference_code, updated_at
     ) VALUES ($1, NULL, '', $2, $3)`,
    [jobId, refCode, now],
  )
}

export const createJob = (
  db: Db,
  input: {
    id?: Id
    kind: string
    accountId?: Id | null
    actor: string
    summary?: string
    detail?: Record<string, unknown>
    logPath?: string | null
  },
): Promise<JobRecord> =>
  withSqliteErrors(async () => {
    const id = input.id !== undefined ? assertId(input.id, 'id') : randomUUID()
    if (typeof input.kind !== 'string' || !JOB_KIND_RE.test(input.kind)) {
      fail('VALIDATION', 'job kind must look like backup.create')
    }
    const accountId = assertIdOrNull(input.accountId ?? null, 'accountId')
    const actor = assertLine(input.actor, 255, 'actor', { allowEmpty: false })
    const summary = assertLine(input.summary ?? '', 512, 'summary')
    const rawDetail = input.detail ?? {}
    if (typeof rawDetail !== 'object' || rawDetail === null || Array.isArray(rawDetail)) {
      fail('VALIDATION', 'job detail must be an object')
    }
    const detail = redactSecrets(rawDetail)
    const logPath = input.logPath == null ? null : assertAbsPath(input.logPath, 'logPath')
    const now = nowIso()
    const rows = await db.query<JobRow>(
      `INSERT INTO jobs (
        id, kind, account_id, actor, status, progress, summary, detail, log_path, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 'queued', 0, $5, $6, $7, $8, $9)
      RETURNING *`,
      [id, input.kind, accountId, actor, summary, JSON.stringify(detail), logPath, now, now],
    )
    return fromRow(rows[0]!)
  })

export const getJob = async (db: Db, id: Id): Promise<JobRecord | null> => {
  if (!isUuid(id)) return null
  const rows = await db.query<JobRow>(`SELECT * FROM jobs WHERE id = $1`, [id.toLowerCase()])
  const row = first(rows)
  return row ? fromRow(row) : null
}

export const getDurableJob = async (db: Db, id: Id): Promise<DurableJobRecord | null> => {
  if (!isUuid(id)) return null
  await ensureJobDurabilityTables(db)
  return queryDurableJobTx(db, id.toLowerCase())
}

export const updateJobProgress = (
  db: Db,
  id: Id,
  progress: number,
  summary?: string,
): Promise<JobRecord> =>
  withSqliteErrors(async () => {
    const jid = assertId(id, 'id')
    const pct = assertInt(progress, 0, 100, 'progress')
    const current = mustExist(await getJob(db, jid), 'job', jid)
    if (current.status !== 'queued' && current.status !== 'running') {
      fail('PRECONDITION_FAILED', `job is already ${current.status}`, { id: jid, status: current.status })
    }
    const nextSummary = summary !== undefined ? assertLine(summary, 512, 'summary') : current.summary
    const now = nowIso()
    const startedAt = current.startedAt ?? now
    const rows = await db.query<JobRow>(
      `UPDATE jobs
       SET status = 'running', progress = $1, summary = $2, started_at = $3, updated_at = $4
       WHERE id = $5
       RETURNING *`,
      [pct, nextSummary, startedAt, now, jid],
    )
    return fromRow(mustExist(rows[0], 'job', jid))
  })

export const finishJob = (
  db: Db,
  id: Id,
  outcome: {
    status: 'succeeded' | 'failed' | 'cancelled'
    error?: string | null
    summary?: string
    detail?: Record<string, unknown>
  },
): Promise<JobRecord> =>
  withSqliteErrors(async () => {
    const jid = assertId(id, 'id')
    const status = oneOf(outcome.status, ['succeeded', 'failed', 'cancelled'] as const, 'status')
    const current = mustExist(await getJob(db, jid), 'job', jid)
    if (current.status !== 'queued' && current.status !== 'running') {
      fail('PRECONDITION_FAILED', `job is already ${current.status}`, { id: jid, status: current.status })
    }
    const error = outcome.error ?? null
    if (status === 'failed' && (typeof error !== 'string' || error.length === 0)) {
      fail('VALIDATION', 'failed job needs an error message')
    }
    const summary = outcome.summary !== undefined ? assertLine(outcome.summary, 512, 'summary') : current.summary
    const rawDetail = outcome.detail ?? current.detail
    if (typeof rawDetail !== 'object' || rawDetail === null || Array.isArray(rawDetail)) {
      fail('VALIDATION', 'job detail must be an object')
    }
    const detail = redactSecrets(rawDetail)
    const progress = status === 'succeeded' ? 100 : current.progress
    const now = nowIso()
    const startedAt = current.startedAt ?? now
    const rows = await db.query<JobRow>(
      `UPDATE jobs
       SET status = $1, progress = $2, summary = $3, detail = $4, error = $5,
           started_at = $6, finished_at = $7, updated_at = $8
       WHERE id = $9
       RETURNING *`,
      [status, progress, summary, JSON.stringify(detail), error, startedAt, now, now, jid],
    )
    return fromRow(mustExist(rows[0], 'job', jid))
  })

export const listJobs = async (
  db: Db,
  opts: { accountId?: Id; status?: JobStatus; limit?: number } = {},
): Promise<JobRecord[]> => {
  const limit = clampLimit(opts.limit, 50, 500)
  const clauses: string[] = []
  const params: unknown[] = []
  if (opts.accountId !== undefined) {
    clauses.push(`account_id = $${params.length + 1}`)
    params.push(assertId(opts.accountId, 'accountId'))
  }
  if (opts.status !== undefined) {
    clauses.push(`status = $${params.length + 1}`)
    params.push(oneOf(opts.status, JOB_STATUSES, 'status'))
  }
  params.push(limit)
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = await db.query<JobRow>(
    `SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  )
  return rows.map(fromRow)
}

export interface EnqueueDurableJobInput {
  id?: Id
  kind: string
  accountId?: Id | null
  actor: string
  summary?: string
  detail?: Record<string, unknown>
  logPath?: string | null
  idempotencyKey?: string | null
  requestFingerprint?: string
  targetRevision?: number | null
  maxAttempts?: number
}

/**
 * Enqueues a durable background job with idempotency deduplication, redacted detail,
 * and a server-allocated reference code (`XP-JOB-XXXXXX`).
 *
 * - Replaying the same `idempotencyKey` with identical parameters returns the existing job (`deduplicated: true`).
 * - Reusing the same `idempotencyKey` with different actor/kind/accountId/payload fails with `CONFLICT`.
 */
export const enqueueDurableJob = (
  db: Db,
  input: EnqueueDurableJobInput,
): Promise<DurableJobRecord & { deduplicated: boolean }> =>
  withSqliteErrors(async () => {
    await ensureJobDurabilityTables(db)
    const id = input.id !== undefined ? assertId(input.id, 'id') : randomUUID()
    if (typeof input.kind !== 'string' || !JOB_KIND_RE.test(input.kind)) {
      fail('VALIDATION', 'job kind must look like backup.create')
    }
    const accountId = assertIdOrNull(input.accountId ?? null, 'accountId')
    const actor = assertLine(input.actor, 255, 'actor', { allowEmpty: false })
    const summary = assertLine(input.summary ?? '', 512, 'summary')
    const rawDetail = input.detail ?? {}
    if (typeof rawDetail !== 'object' || rawDetail === null || Array.isArray(rawDetail)) {
      fail('VALIDATION', 'job detail must be an object')
    }
    const detail = redactSecrets(rawDetail)
    const logPath = input.logPath == null ? null : assertAbsPath(input.logPath, 'logPath')
    const idempotencyKey =
      input.idempotencyKey == null
        ? null
        : assertLine(input.idempotencyKey, 255, 'idempotencyKey', { allowEmpty: false })
    const targetRevision =
      input.targetRevision == null ? null : assertInt(input.targetRevision, 0, 1_000_000_000, 'targetRevision')
    const maxAttempts = input.maxAttempts === undefined ? 3 : assertInt(input.maxAttempts, 1, 100, 'maxAttempts')
    const requestFingerprint =
      input.requestFingerprint !== undefined
        ? assertLine(input.requestFingerprint, 255, 'requestFingerprint', { allowEmpty: false })
        : computeJobRequestFingerprint({
            kind: input.kind,
            accountId,
            actor,
            targetRevision,
            detail,
          })

    return db.transaction(async (tx) => {
      if (idempotencyKey !== null) {
        const existingLease = await tx.query<{ job_id: string }>(
          `SELECT job_id FROM job_runtime_leases WHERE idempotency_key = $1`,
          [idempotencyKey],
        )
        const existingId = existingLease[0]?.job_id
        if (existingId) {
          const existingJob = mustExist(await queryDurableJobTx(tx, existingId), 'job', existingId)
          if (
            existingJob.kind !== input.kind ||
            existingJob.actor !== actor ||
            existingJob.accountId !== accountId ||
            existingJob.requestFingerprint !== requestFingerprint
          ) {
            fail('CONFLICT', 'idempotency key already used with different request parameters', {
              idempotencyKey,
              existingJobId: existingJob.id,
            })
          }
          return { ...existingJob, deduplicated: true }
        }
      }

      const now = nowIso()
      const refCode = await allocateNextReferenceCode(tx)
      await tx.query(
        `INSERT INTO jobs (
          id, kind, account_id, actor, status, progress, summary, detail, log_path, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, 'queued', 0, $5, $6, $7, $8, $9)`,
        [id, input.kind, accountId, actor, summary, JSON.stringify(detail), logPath, now, now],
      )
      await tx.query(
        `INSERT INTO job_runtime_leases (
          job_id, idempotency_key, request_fingerprint, target_revision,
          fencing_token, attempt, max_attempts, reference_code, updated_at
        ) VALUES ($1, $2, $3, $4, 0, 0, $5, $6, $7)`,
        [id, idempotencyKey, requestFingerprint, targetRevision, maxAttempts, refCode, now],
      )
      const created = mustExist(await queryDurableJobTx(tx, id), 'job', id)
      return { ...created, deduplicated: false }
    })
  })

export interface AcquireJobLeaseInput {
  jobId?: Id
  kind?: string
  workerId: string
  leaseDurationMs?: number
  now?: Date
}

/**
 * Atomically claims a queued job or steals an expired lease, incrementing the monotonic
 * `fencingToken` and `attempt` counter inside a transaction so two workers cannot hold
 * an active lease simultaneously and any late write from a stale worker is rejected.
 */
export const acquireJobLease = (
  db: Db,
  input: AcquireJobLeaseInput,
): Promise<DurableJobRecord | null> =>
  withSqliteErrors(async () => {
    await ensureJobDurabilityTables(db)
    const workerId = assertLine(input.workerId, 128, 'workerId', { allowEmpty: false })
    const leaseDurationMs =
      input.leaseDurationMs === undefined
        ? DEFAULT_LEASE_MS
        : assertInt(input.leaseDurationMs, MIN_LEASE_MS, MAX_LEASE_MS, 'leaseDurationMs')
    const nowDate = input.now ?? new Date()
    const now = nowDate.toISOString()
    const expiresAt = new Date(nowDate.getTime() + leaseDurationMs).toISOString()

    const outcome = await db.transaction(
      async (
        tx,
      ): Promise<
        | { kind: 'acquired'; job: DurableJobRecord }
        | { kind: 'none' }
        | { kind: 'cancelled_before_lease'; id: Id }
        | { kind: 'exhausted'; id: Id; message: string; attempt: number; maxAttempts: number }
      > => {
        let targetJobId: Id | null = null

        if (input.jobId !== undefined) {
          const jid = assertId(input.jobId, 'jobId')
          await ensureLeaseRowForLegacyJobTx(tx, jid, now)
          const current = mustExist(await queryDurableJobTx(tx, jid), 'job', jid)

          if (current.status === 'succeeded' || current.status === 'failed' || current.status === 'cancelled') {
            fail('PRECONDITION_FAILED', `job is already ${current.status}`, {
              id: jid,
              status: current.status,
            })
          }
          if (current.needsAttention) {
            fail('PRECONDITION_FAILED', 'job is flagged needs_attention and requires operator review', {
              id: jid,
            })
          }
          if (current.cancelRequested) {
            await tx.query(
              `UPDATE jobs SET status = 'cancelled', finished_at = $1, updated_at = $1 WHERE id = $2`,
              [now, jid],
            )
            await tx.query(
              `UPDATE job_runtime_leases SET lease_owner = NULL, lease_expires_at = NULL, updated_at = $1 WHERE job_id = $2`,
              [now, jid],
            )
            return { kind: 'cancelled_before_lease', id: jid }
          }
          if (
            current.status === 'running' &&
            current.leaseOwner !== null &&
            current.leaseExpiresAt !== null &&
            current.leaseExpiresAt > now
          ) {
            fail('CONFLICT', 'job already has an active lease', {
              id: jid,
              leaseOwner: current.leaseOwner,
              leaseExpiresAt: current.leaseExpiresAt,
              fencingToken: current.fencingToken,
            })
          }
          if (current.attempt >= current.maxAttempts) {
            const exhaustedMsg = `job exceeded maxAttempts (${current.maxAttempts}) after lease expiry`
            await tx.query(
              `UPDATE jobs SET status = 'failed', error = $1, finished_at = $2, updated_at = $2 WHERE id = $3`,
              [exhaustedMsg, now, jid],
            )
            await tx.query(
              `UPDATE job_runtime_leases
               SET lease_owner = NULL, lease_expires_at = NULL, failure_class = 'unknown_outcome', needs_attention = 1, updated_at = $1
               WHERE job_id = $2`,
              [now, jid],
            )
            return {
              kind: 'exhausted',
              id: jid,
              message: exhaustedMsg,
              attempt: current.attempt,
              maxAttempts: current.maxAttempts,
            }
          }
          targetJobId = jid
        } else {
          const kindFilter = input.kind !== undefined ? assertLine(input.kind, 128, 'kind', { allowEmpty: false }) : null
          const candidates = await tx.query<{ id: string }>(
            `SELECT j.id
             FROM jobs j
             LEFT JOIN job_runtime_leases l ON l.job_id = j.id
             WHERE ($1 IS NULL OR j.kind = $1)
               AND COALESCE(l.cancel_requested, 0) = 0
               AND COALESCE(l.needs_attention, 0) = 0
               AND COALESCE(l.attempt, 0) < COALESCE(l.max_attempts, 3)
               AND (
                 j.status = 'queued'
                 OR (j.status = 'running' AND l.lease_expires_at IS NOT NULL AND l.lease_expires_at <= $2)
               )
             ORDER BY j.created_at ASC, j.id ASC
             LIMIT 1`,
            [kindFilter, now],
          )
          const cand = first(candidates)
          if (!cand) return { kind: 'none' }
          await ensureLeaseRowForLegacyJobTx(tx, cand.id, now)
          targetJobId = cand.id
        }

        const current = mustExist(await queryDurableJobTx(tx, targetJobId), 'job', targetJobId)
        const nextFencingToken = current.fencingToken + 1
        const nextAttempt = current.attempt + 1
        const startedAt = current.startedAt ?? now

        await tx.query(
          `UPDATE jobs
           SET status = 'running', started_at = $1, updated_at = $2
           WHERE id = $3`,
          [startedAt, now, targetJobId],
        )
        await tx.query(
          `UPDATE job_runtime_leases
           SET lease_owner = $1,
               fencing_token = $2,
               lease_expires_at = $3,
               attempt = $4,
               updated_at = $5
           WHERE job_id = $6`,
          [workerId, nextFencingToken, expiresAt, nextAttempt, now, targetJobId],
        )

        return {
          kind: 'acquired',
          job: mustExist(await queryDurableJobTx(tx, targetJobId), 'job', targetJobId),
        }
      },
    )

    if (outcome.kind === 'none') return null
    if (outcome.kind === 'cancelled_before_lease') {
      return fail('PRECONDITION_FAILED', 'job cancellation was requested before lease acquisition', {
        id: outcome.id,
      })
    }
    if (outcome.kind === 'exhausted') {
      return fail('PRECONDITION_FAILED', outcome.message, {
        id: outcome.id,
        attempt: outcome.attempt,
        maxAttempts: outcome.maxAttempts,
      })
    }
    return outcome.job
  })

const assertActiveLeaseOwnerTx = async (
  tx: Db,
  jobId: Id,
  workerId: string,
  fencingToken: number,
  now: string,
): Promise<DurableJobRecord> => {
  const current = mustExist(await queryDurableJobTx(tx, jobId), 'job', jobId)
  if (current.fencingToken !== fencingToken) {
    fail('CONFLICT', 'stale fencing token rejected', {
      id: jobId,
      expectedFencingToken: current.fencingToken,
      providedFencingToken: fencingToken,
      currentLeaseOwner: current.leaseOwner,
    })
  }
  if (current.leaseOwner !== workerId) {
    fail('CONFLICT', 'lease is not owned by this worker', {
      id: jobId,
      expectedLeaseOwner: current.leaseOwner,
      providedWorkerId: workerId,
    })
  }
  if (current.status !== 'running') {
    fail('PRECONDITION_FAILED', `job is not running (status=${current.status})`, {
      id: jobId,
      status: current.status,
    })
  }
  if (!current.leaseExpiresAt || current.leaseExpiresAt <= now) {
    fail('CONFLICT', 'job lease has expired', {
      id: jobId,
      leaseExpiresAt: current.leaseExpiresAt,
      now,
    })
  }
  return current
}

export interface RenewJobLeaseInput {
  jobId: Id
  workerId: string
  fencingToken: number
  leaseDurationMs?: number
  now?: Date
}

export const renewJobLease = (
  db: Db,
  input: RenewJobLeaseInput,
): Promise<DurableJobRecord> =>
  withSqliteErrors(async () => {
    await ensureJobDurabilityTables(db)
    const jobId = assertId(input.jobId, 'jobId')
    const workerId = assertLine(input.workerId, 128, 'workerId', { allowEmpty: false })
    const fencingToken = assertInt(input.fencingToken, 1, 1_000_000_000, 'fencingToken')
    const leaseDurationMs =
      input.leaseDurationMs === undefined
        ? DEFAULT_LEASE_MS
        : assertInt(input.leaseDurationMs, MIN_LEASE_MS, MAX_LEASE_MS, 'leaseDurationMs')
    const nowDate = input.now ?? new Date()
    const now = nowDate.toISOString()
    const expiresAt = new Date(nowDate.getTime() + leaseDurationMs).toISOString()

    return db.transaction(async (tx) => {
      await assertActiveLeaseOwnerTx(tx, jobId, workerId, fencingToken, now)
      await tx.query(
        `UPDATE job_runtime_leases SET lease_expires_at = $1, updated_at = $2 WHERE job_id = $3 AND fencing_token = $4`,
        [expiresAt, now, jobId, fencingToken],
      )
      await tx.query(`UPDATE jobs SET updated_at = $1 WHERE id = $2`, [now, jobId])
      return mustExist(await queryDurableJobTx(tx, jobId), 'job', jobId)
    })
  })

export interface SaveJobCheckpointInput {
  jobId: Id
  workerId: string
  fencingToken: number
  step: string
  progress?: number
  summary?: string
  data?: Record<string, unknown>
  now?: Date
}

/**
 * Records a completed step checkpoint under the active lease and fencing token.
 * Progress at intermediate checkpoints is capped at 99 so 100 is only set upon verified completion.
 */
export const saveJobCheckpoint = (
  db: Db,
  input: SaveJobCheckpointInput,
): Promise<DurableJobRecord> =>
  withSqliteErrors(async () => {
    await ensureJobDurabilityTables(db)
    const jobId = assertId(input.jobId, 'jobId')
    const workerId = assertLine(input.workerId, 128, 'workerId', { allowEmpty: false })
    const fencingToken = assertInt(input.fencingToken, 1, 1_000_000_000, 'fencingToken')
    const step = assertLine(input.step, 128, 'step', { allowEmpty: false })
    const now = (input.now ?? new Date()).toISOString()

    return db.transaction(async (tx) => {
      const current = await assertActiveLeaseOwnerTx(tx, jobId, workerId, fencingToken, now)
      const pct =
        input.progress === undefined
          ? current.progress
          : Math.min(99, assertInt(input.progress, 0, 100, 'progress'))
      const nextSummary =
        input.summary !== undefined ? assertLine(input.summary, 512, 'summary') : current.summary

      const completedSteps = current.completedSteps.includes(step)
        ? current.completedSteps
        : [...current.completedSteps, step]
      const mergedData =
        input.data !== undefined
          ? redactSecrets({ ...current.checkpointData, ...input.data })
          : current.checkpointData

      await tx.query(
        `UPDATE jobs SET progress = $1, summary = $2, updated_at = $3 WHERE id = $4`,
        [pct, nextSummary, now, jobId],
      )
      await tx.query(
        `UPDATE job_runtime_leases
         SET checkpoint_step = $1,
             checkpoint_json = $2,
             completed_steps_json = $3,
             updated_at = $4
         WHERE job_id = $5 AND fencing_token = $6`,
        [step, JSON.stringify(mergedData), JSON.stringify(completedSteps), now, jobId, fencingToken],
      )

      return mustExist(await queryDurableJobTx(tx, jobId), 'job', jobId)
    })
  })

export const isJobStepCompleted = (
  job: Pick<DurableJobRecord, 'completedSteps'>,
  step: string,
): boolean => job.completedSteps.includes(step)

export interface RequestJobCancellationInput {
  jobId: Id
  actor: string
  reason?: string
  now?: Date
}

/**
 * Requests cancellation of a job.
 * - If `queued`, transitions immediately to `cancelled`.
 * - If `running`, records `cancel_requested = 1` durably so the active worker stops at the next safe checkpoint
 *   and cleans up temporary artifacts before settling `cancelled`.
 */
export const requestJobCancellation = (
  db: Db,
  input: RequestJobCancellationInput,
): Promise<DurableJobRecord> =>
  withSqliteErrors(async () => {
    await ensureJobDurabilityTables(db)
    const jobId = assertId(input.jobId, 'jobId')
    const actor = assertLine(input.actor, 255, 'actor', { allowEmpty: false })
    const reason = input.reason !== undefined ? assertLine(input.reason, 512, 'reason') : `cancelled by ${actor}`
    const now = (input.now ?? new Date()).toISOString()

    return db.transaction(async (tx) => {
      await ensureLeaseRowForLegacyJobTx(tx, jobId, now)
      const current = mustExist(await queryDurableJobTx(tx, jobId), 'job', jobId)
      if (current.status === 'cancelled') return current
      if (current.status === 'succeeded' || current.status === 'failed') {
        fail('PRECONDITION_FAILED', `cannot cancel job in terminal status ${current.status}`, {
          id: jobId,
          status: current.status,
        })
      }

      if (current.status === 'queued') {
        await tx.query(
          `UPDATE jobs
           SET status = 'cancelled', summary = $1, finished_at = $2, updated_at = $2
           WHERE id = $3`,
          [reason, now, jobId],
        )
        await tx.query(
          `UPDATE job_runtime_leases
           SET cancel_requested = 1, cancel_reason = $1, lease_owner = NULL, lease_expires_at = NULL, updated_at = $2
           WHERE job_id = $3`,
          [reason, now, jobId],
        )
      } else {
        await tx.query(
          `UPDATE job_runtime_leases
           SET cancel_requested = 1, cancel_reason = $1, updated_at = $2
           WHERE job_id = $3`,
          [reason, now, jobId],
        )
        await tx.query(`UPDATE jobs SET updated_at = $1 WHERE id = $2`, [now, jobId])
      }

      return mustExist(await queryDurableJobTx(tx, jobId), 'job', jobId)
    })
  })

export interface CompleteJobWithLeaseInput {
  jobId: Id
  workerId: string
  fencingToken: number
  status: 'succeeded' | 'failed' | 'cancelled'
  summary?: string
  detail?: Record<string, unknown>
  error?: string | null
  failureClass?: JobFailureClass | null
  needsAttention?: boolean
  requeueOnRetryable?: boolean
  now?: Date
}

/**
 * Settles a running job under CAS verification of `(workerId, fencingToken)` and active lease.
 * Rejects stale workers whose lease expired and was superseded by a higher fencing token.
 */
export const completeJobWithLease = (
  db: Db,
  input: CompleteJobWithLeaseInput,
): Promise<DurableJobRecord> =>
  withSqliteErrors(async () => {
    await ensureJobDurabilityTables(db)
    const jobId = assertId(input.jobId, 'jobId')
    const workerId = assertLine(input.workerId, 128, 'workerId', { allowEmpty: false })
    const fencingToken = assertInt(input.fencingToken, 1, 1_000_000_000, 'fencingToken')
    const status = oneOf(input.status, ['succeeded', 'failed', 'cancelled'] as const, 'status')
    const failureClass =
      input.failureClass == null ? null : oneOf(input.failureClass, FAILURE_CLASSES, 'failureClass')
    const now = (input.now ?? new Date()).toISOString()

    return db.transaction(async (tx) => {
      const current = await assertActiveLeaseOwnerTx(tx, jobId, workerId, fencingToken, now)
      const error = input.error ?? null
      if (status === 'failed' && (typeof error !== 'string' || error.length === 0)) {
        fail('VALIDATION', 'failed job needs an error message')
      }
      const nextSummary =
        input.summary !== undefined ? assertLine(input.summary, 512, 'summary') : current.summary
      const rawDetail = input.detail ?? current.detail
      if (typeof rawDetail !== 'object' || rawDetail === null || Array.isArray(rawDetail)) {
        fail('VALIDATION', 'job detail must be an object')
      }
      const detail = redactSecrets(rawDetail)

      const shouldRequeue =
        status === 'failed' &&
        failureClass === 'retryable' &&
        input.requeueOnRetryable === true &&
        !input.needsAttention &&
        !current.cancelRequested &&
        current.attempt < current.maxAttempts

      if (shouldRequeue) {
        await tx.query(
          `UPDATE jobs
           SET status = 'queued', summary = $1, detail = $2, error = $3, updated_at = $4
           WHERE id = $5`,
          [nextSummary, JSON.stringify(detail), error, now, jobId],
        )
        await tx.query(
          `UPDATE job_runtime_leases
           SET lease_owner = NULL,
               lease_expires_at = NULL,
               failure_class = 'retryable',
               needs_attention = 0,
               updated_at = $1
           WHERE job_id = $2 AND fencing_token = $3`,
          [now, jobId, fencingToken],
        )
        return mustExist(await queryDurableJobTx(tx, jobId), 'job', jobId)
      }

      const progress = status === 'succeeded' ? 100 : current.progress
      const needsAttention =
        input.needsAttention === true || failureClass === 'unknown_outcome' ? 1 : 0

      await tx.query(
        `UPDATE jobs
         SET status = $1,
             progress = $2,
             summary = $3,
             detail = $4,
             error = $5,
             finished_at = $6,
             updated_at = $6
         WHERE id = $7`,
        [status, progress, nextSummary, JSON.stringify(detail), error, now, jobId],
      )
      await tx.query(
        `UPDATE job_runtime_leases
         SET lease_owner = NULL,
             lease_expires_at = NULL,
             failure_class = $1,
             needs_attention = $2,
             updated_at = $3
         WHERE job_id = $4 AND fencing_token = $5`,
        [failureClass, needsAttention, now, jobId, fencingToken],
      )

      return mustExist(await queryDurableJobTx(tx, jobId), 'job', jobId)
    })
  })

/**
 * Executes a single destructive/idempotent job step under lease + fencing verification:
 * - If the step was already recorded in `completedSteps` during a previous attempt, skips `run()`
 *   so completed destructive steps are never repeated on lease recovery.
 * - If `cancelRequested` is set before the step starts, invokes optional `onCancelCleanup()` and
 *   transitions the job to `cancelled` at this safe checkpoint without running `run()`.
 */
export const executeLeasedJobStep = async <T>(
  db: Db,
  opts: {
    jobId: Id
    workerId: string
    fencingToken: number
    step: string
    progress?: number
    summary?: string
    now?: Date
    onCancelCleanup?: () => Promise<void>
    run: () => Promise<T>
    toCheckpointData?: (result: T) => Record<string, unknown>
  },
): Promise<{ skipped: boolean; cancelled: boolean; result?: T; job: DurableJobRecord }> => {
  await ensureJobDurabilityTables(db)
  const now = (opts.now ?? new Date()).toISOString()
  const precheck = await db.transaction(async (tx) =>
    assertActiveLeaseOwnerTx(tx, assertId(opts.jobId, 'jobId'), opts.workerId, opts.fencingToken, now),
  )

  if (precheck.cancelRequested) {
    if (opts.onCancelCleanup) {
      await opts.onCancelCleanup()
    }
    const cancelledJob = await completeJobWithLease(db, {
      jobId: opts.jobId,
      workerId: opts.workerId,
      fencingToken: opts.fencingToken,
      status: 'cancelled',
      summary: precheck.cancelReason ?? 'Cancelled at safe checkpoint',
      ...(opts.now && { now: opts.now }),
    })
    return { skipped: true, cancelled: true, job: cancelledJob }
  }

  if (isJobStepCompleted(precheck, opts.step)) {
    return { skipped: true, cancelled: false, job: precheck }
  }

  const result = await opts.run()
  const data = opts.toCheckpointData ? opts.toCheckpointData(result) : { [opts.step]: 'done' }
  const updated = await saveJobCheckpoint(db, {
    jobId: opts.jobId,
    workerId: opts.workerId,
    fencingToken: opts.fencingToken,
    step: opts.step,
    ...(opts.progress !== undefined && { progress: opts.progress }),
    ...(opts.summary !== undefined && { summary: opts.summary }),
    data,
    ...(opts.now && { now: opts.now }),
  })
  return { skipped: false, cancelled: false, result, job: updated }
}
