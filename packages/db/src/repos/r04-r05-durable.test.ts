import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isXpanelError } from '@xpanel/core'
import { createTestDb, type TestDbHandle } from '../client.ts'
import {
  acquireJobLease,
  appendAudit,
  completeJobWithLease,
  enqueueDurableJob,
  executeLeasedJobStep,
  GENESIS_AUDIT_HASH,
  getDurableJob,
  listAudit,
  listJobs,
  pruneExpiredOperationalRecords,
   recordLoginAttempt,
  recordMetricsSample,
  renewJobLease,
  replayAuditLogToIndex,
  requestJobCancellation,
  rotateAuditLog,
  saveJobCheckpoint,
  verifyAuditChain,
} from './index.ts'

const handles: TestDbHandle[] = []
const tempDirs: string[] = []

const freshDb = async (): Promise<TestDbHandle> => {
  const h = await createTestDb()
  handles.push(h)
  return h
}

const freshDir = async (): Promise<string> => {
  const d = await mkdtemp(join(tmpdir(), 'xpanel-r04-r05-'))
  tempDirs.push(d)
  return d
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.close()))
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('R04 (A23, A21) — Durable jobs with leases, fencing tokens, idempotency, checkpoints & safe cancellation', () => {
  it('deduplicates identical idempotencyKey requests, rejects payload conflicts, redacts secrets, and allocates server reference codes', async () => {
    const h = await freshDb()

    const first = await enqueueDurableJob(h.db, {
      kind: 'backup.create',
      actor: 'root',
      summary: 'Nightly backup for alice',
      idempotencyKey: 'idem-backup-alice-2026-10-22',
      targetRevision: 7,
      detail: {
        destination: 's3://backups/alice',
        secretAccessKey: 'super-secret-s3-key-123456',
        dsn: 'mysql://alice:hunter2@localhost/alice_db',
      },
    })

    expect(first.deduplicated).toBe(false)
    expect(first.referenceCode).toBe('XP-JOB-000001')
    expect(first.detail.secretAccessKey).toBe('[REDACTED]')
    expect(String(first.detail.dsn)).toContain('[REDACTED]@')

    // Replay with identical parameters returns the exact same job without duplicate creation
    const replay = await enqueueDurableJob(h.db, {
      kind: 'backup.create',
      actor: 'root',
      summary: 'Nightly backup for alice',
      idempotencyKey: 'idem-backup-alice-2026-10-22',
      targetRevision: 7,
      detail: {
        destination: 's3://backups/alice',
        secretAccessKey: 'super-secret-s3-key-123456',
        dsn: 'mysql://alice:hunter2@localhost/alice_db',
      },
    })

    expect(replay.deduplicated).toBe(true)
    expect(replay.id).toBe(first.id)
    expect(replay.referenceCode).toBe('XP-JOB-000001')
    expect(await listJobs(h.db)).toHaveLength(1)

    // Reusing the same idempotencyKey with different parameters fails with CONFLICT
    await expect(
      enqueueDurableJob(h.db, {
        kind: 'backup.create',
        actor: 'root',
        summary: 'Different destination',
        idempotencyKey: 'idem-backup-alice-2026-10-22',
        targetRevision: 8,
        detail: { destination: 's3://backups/bob' },
      }),
    ).rejects.toSatisfy((err: unknown) => isXpanelError(err) && err.code === 'CONFLICT')
  })

  it('prevents two workers from holding an active lease simultaneously and fences off stale workers after lease expiry', async () => {
    const h = await freshDb()
    const t0 = new Date('2026-10-22T12:00:00.000Z')

    const job = await enqueueDurableJob(h.db, {
      kind: 'transfer.account',
      actor: 'root',
      summary: 'Transfer alice',
      idempotencyKey: 'idem-transfer-1',
    })

    // Worker 1 acquires the lease at t0 for 10 seconds
    const lease1 = await acquireJobLease(h.db, {
      jobId: job.id,
      workerId: 'worker-1',
      leaseDurationMs: 10_000,
      now: t0,
    })
    expect(lease1).not.toBeNull()
    expect(lease1!.leaseOwner).toBe('worker-1')
    expect(lease1!.fencingToken).toBe(1)
    expect(lease1!.attempt).toBe(1)

    // Worker 2 attempts to acquire the same job while Worker 1's lease is still active (t0 + 5s)
    const t5s = new Date(t0.getTime() + 5_000)
    await expect(
      acquireJobLease(h.db, {
        jobId: job.id,
        workerId: 'worker-2',
        leaseDurationMs: 10_000,
        now: t5s,
      }),
    ).rejects.toSatisfy((err: unknown) => isXpanelError(err) && err.code === 'CONFLICT')

    // Polling for any eligible job at t5s returns null because the only job has an active lease
    const polledWhileActive = await acquireJobLease(h.db, {
      workerId: 'worker-2',
      now: t5s,
    })
    expect(polledWhileActive).toBeNull()

    // At t0 + 15s, Worker 1's lease has expired; Worker 2 steals the lease and increments fencingToken to 2
    const t15s = new Date(t0.getTime() + 15_000)
    const lease2 = await acquireJobLease(h.db, {
      workerId: 'worker-2',
      leaseDurationMs: 30_000,
      now: t15s,
    })
    expect(lease2).not.toBeNull()
    expect(lease2!.id).toBe(job.id)
    expect(lease2!.leaseOwner).toBe('worker-2')
    expect(lease2!.fencingToken).toBe(2)
    expect(lease2!.attempt).toBe(2)

    // Zombie Worker 1 wakes up at t0 + 16s with stale fencingToken=1: all writes are rejected with CONFLICT
    const t16s = new Date(t0.getTime() + 16_000)
    await expect(
      renewJobLease(h.db, {
        jobId: job.id,
        workerId: 'worker-1',
        fencingToken: 1,
        now: t16s,
      }),
    ).rejects.toSatisfy((err: unknown) => isXpanelError(err) && err.code === 'CONFLICT')

    await expect(
      saveJobCheckpoint(h.db, {
        jobId: job.id,
        workerId: 'worker-1',
        fencingToken: 1,
        step: 'rsync-homedir',
        progress: 50,
        now: t16s,
      }),
    ).rejects.toSatisfy((err: unknown) => isXpanelError(err) && err.code === 'CONFLICT')

    await expect(
      completeJobWithLease(h.db, {
        jobId: job.id,
        workerId: 'worker-1',
        fencingToken: 1,
        status: 'succeeded',
        now: t16s,
      }),
    ).rejects.toSatisfy((err: unknown) => isXpanelError(err) && err.code === 'CONFLICT')

    // Worker 2 with current fencingToken=2 completes the job cleanly
    const finished = await completeJobWithLease(h.db, {
      jobId: job.id,
      workerId: 'worker-2',
      fencingToken: 2,
      status: 'succeeded',
      summary: 'Transfer completed by worker-2',
      now: t16s,
    })
    expect(finished.status).toBe('succeeded')
    expect(finished.progress).toBe(100)
    expect(finished.leaseOwner).toBeNull()
  })

  it('persists step checkpoints and never repeats completed destructive steps upon lease recovery', async () => {
    const h = await freshDb()
    const t0 = new Date('2026-10-22T13:00:00.000Z')

    const job = await enqueueDurableJob(h.db, {
      kind: 'reconcile.host',
      actor: 'root',
      summary: 'Multi-step destructive job',
      idempotencyKey: 'idem-destructive-steps',
    })

    const sideEffects = {
      snapshotCreated: 0,
      destructiveCutover: 0,
      postVerify: 0,
    }

    // Worker 1 claims the job, completes step 1 and step 2, then crashes before step 3
    const lease1 = (await acquireJobLease(h.db, {
      jobId: job.id,
      workerId: 'worker-1',
      leaseDurationMs: 10_000,
      now: t0,
    }))!

    const s1 = await executeLeasedJobStep(h.db, {
      jobId: job.id,
      workerId: 'worker-1',
      fencingToken: lease1.fencingToken,
      step: 'create-snapshot',
      progress: 40,
      now: t0,
      run: async () => {
        sideEffects.snapshotCreated++
        return { snapshotId: 'snap-1' }
      },
      toCheckpointData: (res) => res,
    })
    expect(s1.skipped).toBe(false)
    expect(s1.job.progress).toBe(40)

    const s2 = await executeLeasedJobStep(h.db, {
      jobId: job.id,
      workerId: 'worker-1',
      fencingToken: lease1.fencingToken,
      step: 'destructive-cutover',
      progress: 100, // intermediate checkpoint must cap progress at 99
      now: t0,
      run: async () => {
        sideEffects.destructiveCutover++
        return { cutoverAt: t0.toISOString() }
      },
      toCheckpointData: (res) => res,
    })
    expect(s2.skipped).toBe(false)
    expect(s2.job.progress).toBe(99)
    expect(s2.job.completedSteps).toEqual(['create-snapshot', 'destructive-cutover'])

    // Worker 1 crashes; lease expires at t0 + 20s; Worker 2 recovers the job
    const t20s = new Date(t0.getTime() + 20_000)
    const lease2 = (await acquireJobLease(h.db, {
      jobId: job.id,
      workerId: 'worker-2',
      leaseDurationMs: 30_000,
      now: t20s,
    }))!
    expect(lease2.fencingToken).toBe(2)
    expect(lease2.completedSteps).toEqual(['create-snapshot', 'destructive-cutover'])
    expect(lease2.checkpointData).toMatchObject({ snapshotId: 'snap-1' })

    // Worker 2 runs the handler from the top: steps 1 and 2 are skipped; only step 3 executes
    const r1 = await executeLeasedJobStep(h.db, {
      jobId: job.id,
      workerId: 'worker-2',
      fencingToken: lease2.fencingToken,
      step: 'create-snapshot',
      now: t20s,
      run: async () => {
        sideEffects.snapshotCreated++
        return {}
      },
    })
    expect(r1.skipped).toBe(true)

    const r2 = await executeLeasedJobStep(h.db, {
      jobId: job.id,
      workerId: 'worker-2',
      fencingToken: lease2.fencingToken,
      step: 'destructive-cutover',
      now: t20s,
      run: async () => {
        sideEffects.destructiveCutover++
        return {}
      },
    })
    expect(r2.skipped).toBe(true)

    const r3 = await executeLeasedJobStep(h.db, {
      jobId: job.id,
      workerId: 'worker-2',
      fencingToken: lease2.fencingToken,
      step: 'verify-service-health',
      progress: 95,
      now: t20s,
      run: async () => {
        sideEffects.postVerify++
        return { healthy: true }
      },
      toCheckpointData: (res) => res,
    })
    expect(r3.skipped).toBe(false)

    // Each side effect ran exactly once across the crash and recovery
    expect(sideEffects).toEqual({
      snapshotCreated: 1,
      destructiveCutover: 1,
      postVerify: 1,
    })

    const completed = await completeJobWithLease(h.db, {
      jobId: job.id,
      workerId: 'worker-2',
      fencingToken: lease2.fencingToken,
      status: 'succeeded',
      now: t20s,
    })
    expect(completed.status).toBe('succeeded')
    expect(completed.progress).toBe(100)
  })

  it('supports safe checkpoint cancellation with artifact cleanup for running jobs and immediate cancellation for queued jobs', async () => {
    const h = await freshDb()
    const t0 = new Date('2026-10-22T14:00:00.000Z')

    // 1. Queued job cancellation is immediate
    const queuedJob = await enqueueDurableJob(h.db, {
      kind: 'backup.create',
      actor: 'root',
      summary: 'Queued job to cancel',
    })
    const cancelledQueued = await requestJobCancellation(h.db, {
      jobId: queuedJob.id,
      actor: 'root',
      reason: 'User aborted before start',
      now: t0,
    })
    expect(cancelledQueued.status).toBe('cancelled')
    await expect(
      acquireJobLease(h.db, { jobId: queuedJob.id, workerId: 'worker-1', now: t0 }),
    ).rejects.toSatisfy((err: unknown) => isXpanelError(err) && err.code === 'PRECONDITION_FAILED')

    // 2. Running job cancellation records cancelRequested and settles at the next safe checkpoint
    const runningJob = await enqueueDurableJob(h.db, {
      kind: 'backup.create',
      actor: 'root',
      summary: 'Running job to cancel safely',
    })
    const lease = (await acquireJobLease(h.db, {
      jobId: runningJob.id,
      workerId: 'worker-1',
      leaseDurationMs: 30_000,
      now: t0,
    }))!

    let tempArtifactCleaned = false
    let step2Executed = false

    await executeLeasedJobStep(h.db, {
      jobId: runningJob.id,
      workerId: 'worker-1',
      fencingToken: lease.fencingToken,
      step: 'stage-temp-archive',
      progress: 50,
      now: t0,
      run: async () => ({ tempFile: '/var/tmp/backup.part' }),
    })

    // Operator requests cancellation while step 1 is done and job is still running
    const cancelReq = await requestJobCancellation(h.db, {
      jobId: runningJob.id,
      actor: 'root',
      reason: 'Stop before upload',
      now: t0,
    })
    expect(cancelReq.status).toBe('running')
    expect(cancelReq.cancelRequested).toBe(true)

    // Worker reaches the next checkpoint, cleans up temporary artifacts, and settles as cancelled
    const step2Outcome = await executeLeasedJobStep(h.db, {
      jobId: runningJob.id,
      workerId: 'worker-1',
      fencingToken: lease.fencingToken,
      step: 'upload-archive',
      now: t0,
      onCancelCleanup: async () => {
        tempArtifactCleaned = true
      },
      run: async () => {
        step2Executed = true
        return {}
      },
    })

    expect(step2Outcome.cancelled).toBe(true)
    expect(step2Outcome.skipped).toBe(true)
    expect(tempArtifactCleaned).toBe(true)
    expect(step2Executed).toBe(false)
    expect(step2Outcome.job.status).toBe('cancelled')
    expect(step2Outcome.job.leaseOwner).toBeNull()
  })

  it('marks jobs as needs_attention when maxAttempts are exhausted so broken jobs do not retry forever', async () => {
    const h = await freshDb()
    const t0 = new Date('2026-10-22T15:00:00.000Z')

    const job = await enqueueDurableJob(h.db, {
      kind: 'upgrade.run',
      actor: 'root',
      maxAttempts: 1,
    })

    await acquireJobLease(h.db, {
      jobId: job.id,
      workerId: 'worker-1',
      leaseDurationMs: 5_000,
      now: t0,
    })

    const t10s = new Date(t0.getTime() + 10_000)
    await expect(
      acquireJobLease(h.db, {
        jobId: job.id,
        workerId: 'worker-2',
        leaseDurationMs: 5_000,
        now: t10s,
      }),
    ).rejects.toSatisfy((err: unknown) => isXpanelError(err) && err.code === 'PRECONDITION_FAILED')

    const afterExhaustion = await getDurableJob(h.db, job.id)
    expect(afterExhaustion?.status).toBe('failed')
    expect(afterExhaustion?.needsAttention).toBe(true)
    expect(afterExhaustion?.failureClass).toBe('unknown_outcome')
  })
})

describe('R05 (A24) — Durable file-first fsync hash-chained JSONL audit trail, fail-closed sink policy, rotation & replay', () => {
  it('writes fsync hash-chained JSONL entries before indexing, redacts inline/nested secrets, and prevents newline injection', async () => {
    const h = await freshDb()
    const dir = await freshDir()
    const auditLogFilePath = join(dir, 'audit.jsonl')

    const e1 = await appendAudit(
      h.db,
      {
        actor: 'root\ninjected-actor',
        action: 'account.create',
        target: 'alice\r\nforged-line password=my-secret-pass',
        detail: {
          passwordHash: '$argon2id$v=19$secret',
          privateKey: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC\n-----END PRIVATE KEY-----',
          authHeader: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secretpayload',
          dbUrl: 'mysql://alice:topsecret@127.0.0.1/alice_db',
          note: 'line1\nline2\u202e',
        },
        outcome: 'ok',
      },
      { auditLogFilePath, requireDurableFile: true },
    )

    const e2 = await appendAudit(
      h.db,
      {
        actor: 'root',
        action: 'firewall.update',
        target: 'rule:ssh',
        detail: { port: 2222 },
        outcome: 'ok',
      },
      { auditLogFilePath, requireDurableFile: true },
    )

    expect(e1.seq).toBe(1)
    expect(e1.prevHash).toBe(GENESIS_AUDIT_HASH)
    expect(e1.entryHash).toMatch(/^[0-9a-f]{64}$/)
    expect(e2.seq).toBe(2)
    expect(e2.prevHash).toBe(e1.entryHash)

    const rawFile = await readFile(auditLogFilePath, 'utf8')
    const lines = rawFile.trim().split('\n')
    expect(lines).toHaveLength(2)

    expect(rawFile).not.toContain('my-secret-pass')
    expect(rawFile).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC')
    expect(rawFile).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')
    expect(rawFile).not.toContain('topsecret')

    const verify = await verifyAuditChain(auditLogFilePath)
    expect(verify.valid).toBe(true)
    expect(verify.entriesVerified).toBe(2)
    expect(verify.lastEntryHash).toBe(e2.entryHash)
  })

  it('enforces fail-closed policy when the durable audit sink fails (ENOSPC) before acknowledging or indexing critical mutations', async () => {
    const h = await freshDb()
    const dir = await freshDir()
    const auditLogFilePath = join(dir, 'audit.jsonl')

    const enospc = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    await expect(
      appendAudit(
        h.db,
        {
          actor: 'root',
          action: 'account.delete',
          target: 'alice',
          detail: { reason: 'termination' },
          outcome: 'ok',
        },
        {
          auditLogFilePath,
          requireDurableFile: true,
          simulateSinkError: enospc,
        },
      ),
    ).rejects.toSatisfy(
      (err: unknown) =>
        isXpanelError(err) && err.code === 'SERVICE_UNAVAILABLE' && err.detail.errno === 'ENOSPC',
    )

    // Verify zero rows were added to SQLite audit_log when the durable sink failed
    const rows = await listAudit(h.db)
    expect(rows).toHaveLength(0)

    // Missing auditLogFilePath when requireDurableFile is true also fails closed
    await expect(
      appendAudit(
        h.db,
        {
          actor: 'root',
          action: 'account.delete',
          target: 'alice',
          outcome: 'ok',
        },
        { requireDurableFile: true },
      ),
    ).rejects.toSatisfy((err: unknown) => isXpanelError(err) && err.code === 'PRECONDITION_FAILED')
  })

  it('detects mid-chain tampering and quarantines truncated crash tails cleanly', async () => {
    const h = await freshDb()
    const dir = await freshDir()
    const auditLogFilePath = join(dir, 'audit.jsonl')

    await appendAudit(h.db, { actor: 'root', action: 'account.create', target: 'alice', outcome: 'ok' }, { auditLogFilePath })
    await appendAudit(h.db, { actor: 'root', action: 'account.suspend', target: 'alice', outcome: 'ok' }, { auditLogFilePath })
    await appendAudit(h.db, { actor: 'root', action: 'account.unsuspend', target: 'alice', outcome: 'ok' }, { auditLogFilePath })

    // 1. Simulate a truncated tail line from a crash mid-write (no trailing newline)
    await appendFile(auditLogFilePath, '{"seq":4,"eventUid":"partial-crash-line', 'utf8')
    const recovered = await verifyAuditChain(auditLogFilePath, { quarantineTruncatedTail: true })
    expect(recovered.valid).toBe(true)
    expect(recovered.entriesVerified).toBe(3)
    expect(recovered.quarantinedTail).toBe('{"seq":4,"eventUid":"partial-crash-line')

    // 2. Tamper with entry #2 in the middle of the log
    const cleanText = await readFile(auditLogFilePath, 'utf8')
    const tamperedText = cleanText.replace('"target":"alice"', '"target":"mallory"')
    await writeFile(auditLogFilePath, tamperedText, 'utf8')

    const tamperedCheck = await verifyAuditChain(auditLogFilePath)
    expect(tamperedCheck.valid).toBe(false)
    expect(tamperedCheck.tamperedAtSeq).toBe(1)
    expect(tamperedCheck.error).toMatch(/entryHash mismatch/)
  })

  it('preserves hash-chain continuity across log rotations and replays durable JSONL entries into SQLite idempotently', async () => {
    const h = await freshDb()
    const dir = await freshDir()
    const auditLogFilePath = join(dir, 'audit.jsonl')

    await appendAudit(h.db, { actor: 'root', action: 'plan.create', target: 'pro', outcome: 'ok' }, { auditLogFilePath })
    const e2 = await appendAudit(h.db, { actor: 'root', action: 'account.create', target: 'alice', outcome: 'ok' }, { auditLogFilePath })

    // Rotate active log into archive segment 1
    const rot = await rotateAuditLog(auditLogFilePath)
    expect(rot.rotatedEntries).toBe(2)
    expect(rot.lastSeq).toBe(2)
    expect(rot.lastEntryHash).toBe(e2.entryHash)

    // Append entry #3 while simulating SQLite index outage (allowSpoolOnIndexFailure: true)
    const e3 = await appendAudit(
      h.db,
      {
        actor: 'root',
        action: 'domain.create',
        target: 'shop.alice.example.com',
        outcome: 'ok',
      },
      {
        auditLogFilePath,
        allowSpoolOnIndexFailure: true,
        simulateIndexError: new Error('SQLITE_BUSY: database is locked'),
      },
    )
    expect(e3.seq).toBe(3)
    expect(e3.prevHash).toBe(e2.entryHash)

    // Verify chain across rotated archive and active file
    const chainAcrossRotation = await verifyAuditChain(auditLogFilePath, {
      archivePaths: [rot.archivePath],
    })
    expect(chainAcrossRotation.valid).toBe(true)
    expect(chainAcrossRotation.entriesVerified).toBe(3)

    // SQLite currently has only 2 rows because entry #3 failed to index during outage
    expect(await listAudit(h.db)).toHaveLength(2)

    // Replay durable JSONL files into SQLite index: indexes entry #3 and skips entries #1 and #2
    const replay1 = await replayAuditLogToIndex(h.db, {
      auditLogFilePath,
      archivePaths: [rot.archivePath],
    })
    expect(replay1).toEqual({ indexed: 1, skipped: 2, quarantinedTail: null })
    expect(await listAudit(h.db)).toHaveLength(3)

    // Second replay is a complete idempotent no-op
    const replay2 = await replayAuditLogToIndex(h.db, {
      auditLogFilePath,
      archivePaths: [rot.archivePath],
    })
    expect(replay2).toEqual({ indexed: 0, skipped: 3, quarantinedTail: null })
    expect(await listAudit(h.db)).toHaveLength(3)
  })

  it('prunes expired operational records while never deleting append-only audit_log history', async () => {
    const h = await freshDb()
    await appendAudit(h.db, { actor: 'root', action: 'server.setup', target: 'srv1', outcome: 'ok' })
    await recordMetricsSample(h.db, { scope: 'host', cpuPercent: 15, memoryMb: 512 })
    await recordLoginAttempt(h.db, { username: 'root', ip: '192.0.2.5', success: true })

    const future = new Date(Date.now() + 120 * 86_400_000)
    const pruned = await pruneExpiredOperationalRecords(h.db, {
      now: future,
      metricsRetentionDays: 30,
      loginAttemptsRetentionDays: 90,
      finishedJobsRetentionDays: 30,
    })

    expect(pruned.metricsDeleted).toBe(1)
    expect(pruned.loginAttemptsDeleted).toBe(1)
    expect(pruned.auditDeleted).toBe(0)
    expect(await listAudit(h.db)).toHaveLength(1)
  })
})
