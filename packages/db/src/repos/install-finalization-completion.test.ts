import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestDb, type TestDbHandle } from '../client.ts'
import { createRootPrincipal, getPrincipal } from './principals.ts'
import {
  acquireJobLease,
  completeJobWithLease,
  enqueueDurableJob,
  getDurableJob,
  type CompleteJobLeaseAdmission,
} from './jobs.ts'

const handles: TestDbHandle[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(handles.splice(0).map(handle => handle.close()))
})

async function leasedJob() {
  const handle = await createTestDb()
  handles.push(handle)
  const root = await createRootPrincipal(handle.db, {
    username: 'finalization-root', passwordHash: '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0MTIzNA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', forcePasswordChange: false,
  })
  const queued = await enqueueDurableJob(handle.db, {
    kind: 'lifecycle.adopt', actor: root.username, summary: 'Isolated finalization admission',
    detail: { subjectDigest: '1'.repeat(64) },
  })
  const job = await acquireJobLease(handle.db, {
    jobId: queued.id, workerId: 'isolated-finalizer', leaseDurationMs: 30_000,
  })
  if (!job || !job.leaseExpiresAt) throw new Error('test fixture did not acquire a bounded lease')
  return { handle, root, job, deadline: Date.parse(job.leaseExpiresAt), input: {
    jobId: job.id, workerId: 'isolated-finalizer', fencingToken: job.fencingToken,
    status: 'succeeded' as const, summary: 'Observed ownership finalization',
  } }
}

async function expectRetainedLease(fixture: Awaited<ReturnType<typeof leasedJob>>) {
  const current = await getDurableJob(fixture.handle.db, fixture.job.id)
  expect(current).toMatchObject({
    status: 'running', leaseOwner: fixture.job.leaseOwner,
    fencingToken: fixture.job.fencingToken, leaseExpiresAt: fixture.job.leaseExpiresAt,
    progress: fixture.job.progress, finishedAt: null, detail: fixture.job.detail,
  })
}

describe('install finalization completion admission', () => {
  it('preserves completion behavior for existing callers without a guard', async () => {
    const fixture = await leasedJob()
    const completed = await completeJobWithLease(fixture.handle.db, fixture.input)
    expect(completed).toMatchObject({ status: 'succeeded', progress: 100, leaseOwner: null, leaseExpiresAt: null })
    expect(completed.referenceCode).toBe(fixture.job.referenceCode)
  })

  it('runs both guard phases in the same admitted transaction around the actual completion write', async () => {
    const fixture = await leasedJob()
    const phases: string[] = []
    const guard: CompleteJobLeaseAdmission = async (tx, current, phase) => {
      const root = await getPrincipal(tx, fixture.root.id)
      if (!root || root.disabled || root.forcePasswordChange) throw new Error('root authority changed')
      const row = await getDurableJob(tx, current.id)
      phases.push(phase + ':' + row?.status)
      expect(current.id).toBe(fixture.job.id)
      expect(current.fencingToken).toBe(fixture.job.fencingToken)
    }
    await completeJobWithLease(fixture.handle.db, fixture.input, guard)
    expect(phases).toEqual(['before:running', 'after:succeeded'])
  })

  it.each(['before', 'after'] as const)('rolls back all completion fields when the %s guard rejects', async deniedPhase => {
    const fixture = await leasedJob()
    await expect(completeJobWithLease(fixture.handle.db, fixture.input, async (_tx, _current, phase) => {
      if (phase === deniedPhase) throw new Error('authority revoked')
    })).rejects.toThrow('authority revoked')
    await expectRetainedLease(fixture)
  })

  it.each(['before', 'after'] as const)('uses a fresh real lease clock after the %s callback await', async expiredPhase => {
    const fixture = await leasedJob()
    const deadline = fixture.deadline
    const pinnedInputClock = new Date(Date.now())
    vi.useFakeTimers({ toFake: ['Date'] })
    await expect(completeJobWithLease(fixture.handle.db, { ...fixture.input, now: pinnedInputClock }, async (tx, current, phase) => {
      await getDurableJob(tx, current.id)
      if (phase === expiredPhase) vi.setSystemTime(deadline + 1)
    })).rejects.toThrow(/lease.*expired/i)
    vi.useRealTimers()
    await expectRetainedLease(fixture)
  })

  it('observes root revocation committed while completion waits behind the real database writer', async () => {
    const fixture = await leasedJob()
    let releaseWriter: () => void = () => { throw new Error('writer gate was not initialized') }
    let writerEntered: () => void = () => { throw new Error('writer entry was not initialized') }
    const gate = new Promise<void>(resolve => { releaseWriter = resolve })
    const entered = new Promise<void>(resolve => { writerEntered = resolve })
    const writer = fixture.handle.db.transaction(async tx => {
      writerEntered()
      await gate
      await tx.query('UPDATE principals SET disabled = 1 WHERE id = $1', [fixture.root.id])
    })
    await entered
    let completion: Promise<unknown> | undefined
    try {
      completion = completeJobWithLease(fixture.handle.db, fixture.input, async tx => {
        const root = await getPrincipal(tx, fixture.root.id)
        if (!root || root.disabled) throw new Error('queued root authority revoked')
      })
      const rejection = expect(completion).rejects.toThrow('queued root authority revoked')
      releaseWriter()
      await writer
      await rejection
    } finally {
      releaseWriter()
      await writer
      if (completion) await completion.catch(() => undefined)
    }
    await expectRetainedLease(fixture)
  })

  it('passes current cancellation to the guard and leaves the cancelled request unsettled', async () => {
    const fixture = await leasedJob()
    await fixture.handle.db.transaction(tx => tx.query(
      'UPDATE job_runtime_leases SET cancel_requested = 1 WHERE job_id = $1', [fixture.job.id],
    ))
    await expect(completeJobWithLease(fixture.handle.db, fixture.input, async (_tx, current) => {
      if (current.cancelRequested) throw new Error('finalization cancelled')
    })).rejects.toThrow('finalization cancelled')
    await expectRetainedLease(fixture)
    expect((await getDurableJob(fixture.handle.db, fixture.job.id))?.cancelRequested).toBe(true)
  })

  it('rolls back a retryable requeue when the after-write guard rejects', async () => {
    const fixture = await leasedJob()
    await expect(completeJobWithLease(fixture.handle.db, {
      ...fixture.input, status: 'failed', error: 'retryable isolated failure',
      failureClass: 'retryable', requeueOnRetryable: true,
    }, async (_tx, _current, phase) => {
      if (phase === 'after') throw new Error('requeue admission revoked')
    })).rejects.toThrow('requeue admission revoked')
    await expectRetainedLease(fixture)
  })
})
