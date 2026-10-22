import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, describe, it } from 'vitest'
import type { Account, Plan } from '@xpanel/core'
import {
  appendAudit,
  createRootPrincipal,
  createTestDb,
  type TestDbHandle,
} from '@xpanel/db'
import { searchIndex } from '../../../packages/db/src/repos/reindex.ts'
import {
  BoundedTaskQueue,
  MonotonicMetricsTracker,
  createBoundedTaskQueue,
  createRetentionScheduler,
  listIndexedAccountsPage,
  listIndexedDomainsPage,
  listMetricsHistory,
  listMetricsHistoryPage,
  recordMetricsSample,
  recordMonotonicMetricsSample,
  runOperationalRetentionPrune,
} from '../../../packages/db/src/repos/metrics.ts'
import { IoAnalyticsEngine, parseCgroupCpuStat, parseCgroupIoStat } from './analytics.ts'
import { FakeHostExecutor } from './executor.ts'

const ARGON2 =
  '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'

const makePlan = (id: string): Plan =>
  ({
    id,
    name: 'Pro NVMe',
    resellerId: null,
    ownerId: null,
    featureListId: 'default',
    dedicatedIp: false,
    shell: 'jailed',
    resources: {
      diskMb: 50_000,
      bandwidthBytes: 1_000_000_000_000,
      bandwidthMbMonth: 1_000_000,
      memoryMb: 2048,
      cpuQuotaPercent: 200,
      cpuPercent: 200,
      ioReadBps: 50_000_000,
      ioWriteBps: 25_000_000,
      ioReadIops: 2_000,
      ioWriteIops: 1_000,
      maxProcesses: 64,
      inodes: 250_000,
    },
    caps: {
      domains: 10,
      subdomains: 50,
      parkedDomains: 10,
      mailboxes: 50,
      databases: 20,
      ftpAccounts: 10,
      cronJobs: 20,
      phpWorkers: 8,
    },
    features: {
      ssh: 'jailed',
      redis: true,
      nodejs: true,
      python: true,
      gitDeploy: true,
      dedicatedIp: false,
      staging: true,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }) as unknown as Plan

const makeAccount = (id: string, username: string, uid: number, planId: string): Account =>
  ({
    id,
    username,
    uid,
    gid: uid,
    home: `/home/${username}`,
    homeDir: `/home/${username}`,
    ownerId: null,
    planId,
    primaryDomain: `${username}.example.com`,
    contactEmail: `admin@${username}.example.com`,
    ipv4: '203.0.113.10',
    status: 'active',
    suspendReason: null,
    suspendedAt: null,
    suspensionPolicy: {
      http: 'maintenance_page',
      mailLogin: 'allow',
      mailDelivery: 'accept',
      ftp: 'deny',
      cron: 'pause',
    },
    shell: 'jailed',
    diskUsedMb: 512,
    bandwidthUsedBytes: 1_048_576,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }) as unknown as Account

describe('Q01 — Monotonic cgroup v2 delta metrics, bounded queues, retention & indexed pagination benchmarks (A54, A55)', () => {
  let dbHandle: TestDbHandle

  beforeEach(async () => {
    dbHandle = await createTestDb()
  })

  afterEach(async () => {
    await dbHandle.close()
  })

  it('A54: parses cgroup v2 io.stat & cpu.stat and handles missing/empty device counters safely', () => {
    const emptyIo = parseCgroupIoStat('')
    assert.deepEqual(emptyIo, {
      rbytes: 0,
      wbytes: 0,
      rios: 0,
      wios: 0,
      dbytes: 0,
      dios: 0,
      devices: 0,
    })

    const multiDeviceIo = parseCgroupIoStat(
      [
        '259:0 rbytes=10485760 wbytes=5242880 rios=120 wios=85 dbytes=0 dios=0',
        '259:1 rbytes=2097152 wbytes=1048576 rios=30 wios=15 dbytes=4096 dios=1',
      ].join('\n'),
    )
    assert.equal(multiDeviceIo.devices, 2)
    assert.equal(multiDeviceIo.rbytes, 12_582_912)
    assert.equal(multiDeviceIo.wbytes, 6_291_456)
    assert.equal(multiDeviceIo.rios, 150)
    assert.equal(multiDeviceIo.wios, 100)
    assert.equal(multiDeviceIo.dbytes, 4096)
    assert.equal(multiDeviceIo.dios, 1)

    const cpuStat = parseCgroupCpuStat(
      ['usage_usec 4500000', 'user_usec 3100000', 'system_usec 1400000', 'nr_periods 200', 'nr_throttled 12', 'throttled_usec 85000'].join(
        '\n',
      ),
    )
    assert.equal(cpuStat.usageUsec, 4_500_000)
    assert.equal(cpuStat.userUsec, 3_100_000)
    assert.equal(cpuStat.systemUsec, 1_400_000)
    assert.equal(cpuStat.nrPeriods, 200)
    assert.equal(cpuStat.nrThrottled, 12)
    assert.equal(cpuStat.throttledUsec, 85_000)
  })

  it('A54: enforces first-sample zero-rate safety, monotonic deltas, independent rios/wios IOPS, and counter-reset recovery', async () => {
    const planId = '11111111-1111-4111-8111-111111111111'
    const accId = '22222222-2222-4222-8222-222222222222'
    const plan = makePlan(planId)
    const account = makeAccount(accId, 'alice', 2001, planId)
    const plansById = new Map([[plan.id, plan]])
    const executor = new FakeHostExecutor()
    const engine = new IoAnalyticsEngine({ cpuCores: 2 })

    // Sample 1: Account has large cumulative counters since boot.
    // Must record baseline and return 0 rates (never divide cumulative counters by 60 or 5!).
    executor.sliceMetrics.set(account.uid, {
      uid: account.uid,
      cpuUsageUsec: 900_000_000,
      memoryCurrentBytes: 512 * 1024 * 1024,
      ioReadBytes: 600_000_000,
      ioWriteBytes: 300_000_000,
      pidsCurrent: 8,
      ioStatRaw: '259:0 rbytes=600000000 wbytes=300000000 rios=50000 wios=25000 dbytes=0 dios=0',
      cpuStatRaw: 'usage_usec 900000000\nuser_usec 600000000\nsystem_usec 300000000\n',
    } as never)

    const snap1 = await engine.sample([account], plansById, executor, {
      now: new Date('2026-10-22T12:00:00.000Z'),
      monotonicNowMs: 10_000,
    })
    const rank1 = snap1.accounts[0]!
    const meta1 = engine.getAccountSampleMeta(account.id)!
    assert.equal(meta1.firstSample, true)
    assert.equal(meta1.rateAvailable, false)
    assert.equal(meta1.counterReset, false)
    assert.equal(rank1.readBytesPerSec, 0)
    assert.equal(rank1.writeBytesPerSec, 0)
    assert.equal(rank1.readIops, 0)
    assert.equal(rank1.writeIops, 0)
    assert.equal(rank1.cpuPercent, 0)
    assert.equal(snap1.current.awaitMs, 0)
    assert.equal(snap1.current.psiSomeAvg10, 0)
    assert.equal(snap1.current.loadAvg1m, 0)

    // Sample 2: 5 seconds later on monotonic clock (even if wall clock jumped backward due to NTP!).
    // +50,000,000 rbytes (10 MB/s), +100 rios (20 read IOPS — large 500 KB reads, NOT 10MB/16KB = 610 IOPS!)
    // +2,048,000 wbytes (409.6 KB/s), +4,500 wios (900 write IOPS — small 512B writes -> 90% of 1000 IOPS cap -> warn!)
    // +2,500,000 cpu usage_usec over 5s -> 50% CPU
    executor.sliceMetrics.set(account.uid, {
      uid: account.uid,
      cpuUsageUsec: 902_500_000,
      memoryCurrentBytes: 512 * 1024 * 1024,
      ioReadBytes: 650_000_000,
      ioWriteBytes: 302_048_000,
      pidsCurrent: 9,
      ioStatRaw: '259:0 rbytes=650000000 wbytes=302048000 rios=50100 wios=29500 dbytes=0 dios=0',
      cpuStatRaw: 'usage_usec 902500000\n',
    } as never)

    const snap2 = await engine.sample([account], plansById, executor, {
      now: new Date('2026-10-22T11:59:50.000Z'), // Wall clock moved backward 10s
      monotonicNowMs: 15_000, // Monotonic clock advanced +5000ms
    })
    const rank2 = snap2.accounts[0]!
    const meta2 = engine.getAccountSampleMeta(account.id)!
    assert.equal(meta2.firstSample, false)
    assert.equal(meta2.rateAvailable, true)
    assert.equal(meta2.counterReset, false)
    assert.equal(meta2.elapsedSec, 5)
    assert.equal(rank2.readBytesPerSec, 10_000_000)
    assert.equal(rank2.writeBytesPerSec, 409_600)
    assert.equal(rank2.readIops, 20)
    assert.equal(rank2.writeIops, 900)
    assert.equal(rank2.cpuPercent, 50)
    assert.equal(rank2.statusLevel, 'warn') // Triggered by writeIops = 900 / 1000 (90%)

    // Sample 3: Slice or host reboot resets cumulative counters to lower numbers.
    // Must detect counterReset, emit 0 rates (no negative numbers or spikes), and re-baseline.
    executor.sliceMetrics.set(account.uid, {
      uid: account.uid,
      cpuUsageUsec: 100_000,
      memoryCurrentBytes: 256 * 1024 * 1024,
      ioReadBytes: 1_000_000,
      ioWriteBytes: 500_000,
      pidsCurrent: 4,
      ioStatRaw: '259:0 rbytes=1000000 wbytes=500000 rios=50 wios=25 dbytes=0 dios=0',
      cpuStatRaw: 'usage_usec 100000\n',
    } as never)

    const snap3 = await engine.sample([account], plansById, executor, {
      now: new Date('2026-10-22T12:00:10.000Z'),
      monotonicNowMs: 20_000,
    })
    const rank3 = snap3.accounts[0]!
    const meta3 = engine.getAccountSampleMeta(account.id)!
    assert.equal(meta3.counterReset, true)
    assert.equal(meta3.rateAvailable, false)
    assert.equal(rank3.readBytesPerSec, 0)
    assert.equal(rank3.writeBytesPerSec, 0)
    assert.equal(rank3.readIops, 0)
    assert.equal(rank3.writeIops, 0)
    assert.equal(rank3.cpuPercent, 0)

    // Sample 4: 2 seconds after counter reset, normal positive delta resumes cleanly.
    executor.sliceMetrics.set(account.uid, {
      uid: account.uid,
      cpuUsageUsec: 600_000,
      memoryCurrentBytes: 256 * 1024 * 1024,
      ioReadBytes: 5_000_000,
      ioWriteBytes: 1_500_000,
      pidsCurrent: 4,
      ioStatRaw: '259:0 rbytes=5000000 wbytes=1500000 rios=250 wios=125 dbytes=0 dios=0',
      cpuStatRaw: 'usage_usec 600000\n',
    } as never)

    const snap4 = await engine.sample([account], plansById, executor, {
      now: new Date('2026-10-22T12:00:12.000Z'),
      monotonicNowMs: 22_000,
    })
    const rank4 = snap4.accounts[0]!
    const meta4 = engine.getAccountSampleMeta(account.id)!
    assert.equal(meta4.rateAvailable, true)
    assert.equal(meta4.counterReset, false)
    assert.equal(rank4.readBytesPerSec, 2_000_000)
    assert.equal(rank4.writeBytesPerSec, 500_000)
    assert.equal(rank4.readIops, 100)
    assert.equal(rank4.writeIops, 50)
    assert.equal(rank4.cpuPercent, 25)

    // Also verify SQLite MonotonicMetricsTracker + recordMonotonicMetricsSample persistence
    const tracker = new MonotonicMetricsTracker()
    const firstDbSample = await recordMonotonicMetricsSample(dbHandle.db, tracker, {
      at: '2026-10-22T12:00:00.000Z',
      scope: 'account',
      accountId: account.id,
      monotonicMs: 1_000,
      cpuUsageUsec: 50_000_000,
      ioReadBytes: 200_000_000,
      ioWriteBytes: 100_000_000,
      ioReadOps: 4_000,
      ioWriteOps: 2_000,
      memoryMb: 512,
      processes: 6,
    })
    assert.equal(firstDbSample.delta.firstSample, true)
    assert.equal(firstDbSample.sample.cpuPercent, 0)
    assert.equal(firstDbSample.sample.ioReadBps, 0)
    assert.equal(firstDbSample.sample.ioWriteBps, 0)

    const secondDbSample = await recordMonotonicMetricsSample(dbHandle.db, tracker, {
      at: '2026-10-22T12:00:04.000Z',
      scope: 'account',
      accountId: account.id,
      monotonicMs: 5_000,
      cpuUsageUsec: 51_000_000,
      ioReadBytes: 240_000_000,
      ioWriteBytes: 108_000_000,
      ioReadOps: 4_400,
      ioWriteOps: 2_200,
      memoryMb: 512,
      processes: 6,
    })
    assert.equal(secondDbSample.delta.rateAvailable, true)
    assert.equal(secondDbSample.sample.cpuPercent, 25)
    assert.equal(secondDbSample.sample.ioReadBps, 10_000_000)
    assert.equal(secondDbSample.sample.ioWriteBps, 2_000_000)
    assert.equal(secondDbSample.delta.readIops, 100)
    assert.equal(secondDbSample.delta.writeIops, 50)
  })

  it('A55: BoundedTaskQueue enforces backpressure limits, per-account round-robin fairness, AbortSignal cancellation, and timeouts', async () => {
    const queue: BoundedTaskQueue = createBoundedTaskQueue({
      maxConcurrency: 1,
      maxQueueSize: 5,
      maxPerAccountQueued: 3,
      defaultTimeoutMs: 500,
    })

    const executionOrder: string[] = []
    let releaseBlocker!: () => void
    const blockerGate = new Promise<void>((resolve) => {
      releaseBlocker = resolve
    })

    // Occupy the single active concurrency slot
    const blockerTask = queue.enqueue(
      async () => {
        executionOrder.push('blocker')
        await blockerGate
        return 'blocker-done'
      },
      { accountId: 'acc-blocker' },
    )

    // Enqueue 3 tasks for noisy account 'acc-noisy' (reaches maxPerAccountQueued = 3)
    const noisy1 = queue.enqueue(
      async () => {
        executionOrder.push('noisy-1')
        return 'n1'
      },
      { accountId: 'acc-noisy' },
    )
    const noisy2 = queue.enqueue(
      async () => {
        executionOrder.push('noisy-2')
        return 'n2'
      },
      { accountId: 'acc-noisy' },
    )
    const noisy3 = queue.enqueue(
      async () => {
        executionOrder.push('noisy-3')
        return 'n3'
      },
      { accountId: 'acc-noisy' },
    )

    // 4th queued task for 'acc-noisy' must be rejected with BACKPRESSURE_ACCOUNT_LIMIT
    await assert.rejects(
      () => queue.enqueue(async () => 'n4', { accountId: 'acc-noisy' }),
      (err: Error & { code?: string }) => err.code === 'BACKPRESSURE_ACCOUNT_LIMIT',
    )

    // Enqueue 1 task for 'acc-quiet' and 1 cancellable task for 'acc-cancel' (reaches maxQueueSize = 5)
    const quiet1 = queue.enqueue(
      async () => {
        executionOrder.push('quiet-1')
        return 'q1'
      },
      { accountId: 'acc-quiet' },
    )

    const cancelCtrl = new AbortController()
    const cancelledWhileQueued = queue.enqueue(
      async () => {
        executionOrder.push('should-not-run')
        return 'cancelled'
      },
      { accountId: 'acc-cancel', signal: cancelCtrl.signal },
    )

    // Queue is now at capacity (5 queued: noisy1, noisy2, noisy3, quiet1, cancelledWhileQueued)
    await assert.rejects(
      () => queue.enqueue(async () => 'overflow', { accountId: 'acc-other' }),
      (err: Error & { code?: string }) => err.code === 'BACKPRESSURE_QUEUE_FULL',
    )

    // Cancel `cancelledWhileQueued` before it starts; its slot is immediately freed
    cancelCtrl.abort()
    await assert.rejects(
      () => cancelledWhileQueued,
      (err: Error & { code?: string }) => err.code === 'ERR_TASK_ABORTED',
    )
    assert.equal(queue.stats().queued, 4)

    // Release the blocker and await all remaining tasks
    releaseBlocker()
    const results = await Promise.all([blockerTask, noisy1, noisy2, noisy3, quiet1])
    assert.deepEqual(results, ['blocker-done', 'n1', 'n2', 'n3', 'q1'])

    // Verify per-account round-robin fairness: 'quiet-1' ran right after 'noisy-1', NOT after 'noisy-3'!
    assert.deepEqual(executionOrder, ['blocker', 'noisy-1', 'quiet-1', 'noisy-2', 'noisy-3'])

    // Verify timeout enforcement releases slot
    const slowTask = queue.enqueue(
      async (signal) =>
        new Promise<string>((resolve, reject) => {
          const t = setTimeout(() => resolve('too-late'), 200)
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(t)
              reject(new Error('aborted'))
            },
            { once: true },
          )
        }),
      { accountId: 'acc-slow', timeoutMs: 25 },
    )
    await assert.rejects(
      () => slowTask,
      (err: Error & { code?: string }) => err.code === 'ERR_TASK_TIMEOUT',
    )

    const afterTimeout = await queue.enqueue(async () => 'recovered', { accountId: 'acc-fast' })
    assert.equal(afterTimeout, 'recovered')
    assert.equal(queue.stats().timedOut, 1)
    assert.equal(queue.stats().rejectedBackpressure, 2)
  })

  it('A55: scheduled retention prunes expired operational tables on startup while preserving audit_log chain integrity', async () => {
    const now = new Date('2026-10-22T12:00:00.000Z')
    const fortyDaysAgo = new Date(now.getTime() - 40 * 86_400_000).toISOString()
    const twentyDaysAgo = new Date(now.getTime() - 20 * 86_400_000).toISOString()
    const twoDaysAgo = new Date(now.getTime() - 2 * 86_400_000).toISOString()
    const twoDaysAhead = new Date(now.getTime() + 2 * 86_400_000).toISOString()

    const root = await createRootPrincipal(dbHandle.db, { username: 'root', passwordHash: ARGON2 })

    // 1. Metrics history: 1 expired (40d old), 1 recent (2d old)
    await recordMetricsSample(dbHandle.db, {
      at: fortyDaysAgo,
      scope: 'host',
      cpuPercent: 12,
      memoryMb: 1024,
    })
    await recordMetricsSample(dbHandle.db, {
      at: twoDaysAgo,
      scope: 'host',
      cpuPercent: 18,
      memoryMb: 1536,
    })

    // 2. Sessions: 1 expired, 1 revoked 20d ago, 1 active
    await dbHandle.db.query(
      `INSERT INTO sessions (id, principal_id, token_hash, ip, user_agent, mfa_verified, created_at, last_seen_at, expires_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, 0, $6, $6, $7, NULL)`,
      ['11111111-1111-4111-8111-111111111111', root.id, '1'.repeat(64), '203.0.113.1', 'Test', fortyDaysAgo, twentyDaysAgo],
    )
    await dbHandle.db.query(
      `INSERT INTO sessions (id, principal_id, token_hash, ip, user_agent, mfa_verified, created_at, last_seen_at, expires_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, 0, $6, $6, $7, $8)`,
      ['22222222-2222-4222-8222-222222222222', root.id, '2'.repeat(64), '203.0.113.1', 'Test', fortyDaysAgo, twoDaysAhead, twentyDaysAgo],
    )
    await dbHandle.db.query(
      `INSERT INTO sessions (id, principal_id, token_hash, ip, user_agent, mfa_verified, created_at, last_seen_at, expires_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, 0, $6, $6, $7, NULL)`,
      ['33333333-3333-4333-8333-333333333333', root.id, '3'.repeat(64), '203.0.113.1', 'Test', twoDaysAgo, twoDaysAhead],
    )

    // 3. Login attempts & lockouts
    await dbHandle.db.query(
      `INSERT INTO login_attempts (at, surface, username, ip, success, reason) VALUES ($1, 'panel', 'root', '203.0.113.50', 0, 'bad password')`,
      [twentyDaysAgo],
    )
    await dbHandle.db.query(
      `INSERT INTO login_attempts (at, surface, username, ip, success, reason) VALUES ($1, 'panel', 'root', '203.0.113.50', 1, NULL)`,
      [twoDaysAgo],
    )
    await dbHandle.db.query(
      `INSERT INTO lockouts (id, username, ip, failures, reason, locked_until, created_at)
       VALUES ($1, NULL, '203.0.113.50', 5, 'expired lockout', $2, $3)`,
      ['44444444-4444-4444-8444-444444444444', twoDaysAgo, twentyDaysAgo],
    )
    await dbHandle.db.query(
      `INSERT INTO lockouts (id, username, ip, failures, reason, locked_until, created_at)
       VALUES ($1, NULL, '203.0.113.99', 5, 'active lockout', $2, $3)`,
      ['55555555-5555-4555-8555-555555555555', twoDaysAhead, twoDaysAgo],
    )

    // 4. Jobs: 1 old succeeded, 1 old failed, 1 recent succeeded, 1 running
    await dbHandle.db.query(
      `INSERT INTO jobs (id, kind, account_id, actor, status, progress, summary, detail, error, created_at, started_at, finished_at, updated_at)
       VALUES ($1, 'backup.run', NULL, 'root', 'succeeded', 100, 'ok', '{}', NULL, $2, $2, $2, $2)`,
      ['66666666-6666-4666-8666-666666666661', fortyDaysAgo],
    )
    await dbHandle.db.query(
      `INSERT INTO jobs (id, kind, account_id, actor, status, progress, summary, detail, error, created_at, started_at, finished_at, updated_at)
       VALUES ($1, 'ssl.issue', NULL, 'root', 'failed', 100, 'err', '{}', 'ACME timeout', $2, $2, $2, $2)`,
      ['66666666-6666-4666-8666-666666666662', fortyDaysAgo],
    )
    await dbHandle.db.query(
      `INSERT INTO jobs (id, kind, account_id, actor, status, progress, summary, detail, error, created_at, started_at, finished_at, updated_at)
       VALUES ($1, 'reconcile', NULL, 'root', 'succeeded', 100, 'ok', '{}', NULL, $2, $2, $2, $2)`,
      ['66666666-6666-4666-8666-666666666663', twoDaysAgo],
    )
    await dbHandle.db.query(
      `INSERT INTO jobs (id, kind, account_id, actor, status, progress, summary, detail, error, created_at, started_at, finished_at, updated_at)
       VALUES ($1, 'migration.import', NULL, 'root', 'running', 50, 'running', '{}', NULL, $2, $2, NULL, $2)`,
      ['66666666-6666-4666-8666-666666666664', fortyDaysAgo],
    )

    // 5. Audit log entries (including old ones — MUST NEVER BE PRUNED)
    await dbHandle.db.query(
      `INSERT INTO audit_log (at, actor, principal_id, ip, action, target, detail, outcome)
       VALUES ($1, 'root', NULL, NULL, 'system.install', 'host', '{}', 'ok')`,
      [fortyDaysAgo],
    )
    await appendAudit(dbHandle.db, {
      actor: 'root',
      action: 'account.create',
      target: 'alice',
      outcome: 'ok',
    })

    // Start scheduler with runOnStart: true (simulating service boot/restart)
    const scheduler = createRetentionScheduler(dbHandle.db, {
      now,
      runOnStart: true,
      metricsRetentionDays: 30,
      sessionsRetentionDays: 7,
      loginAttemptsRetentionDays: 14,
      jobsRetentionDays: 30,
    })
    const bootPrune = await scheduler.ready
    scheduler.stop()

    assert.equal(scheduler.runsCount(), 1)
    assert.equal(bootPrune.prunedMetrics, 1)
    assert.equal(bootPrune.prunedSessions, 2)
    assert.equal(bootPrune.prunedLoginAttempts, 1)
    assert.equal(bootPrune.prunedLockouts, 1)
    assert.equal(bootPrune.prunedTerminalJobs, 2)
    assert.equal(bootPrune.auditLogPreservedCount, 2)
    assert.equal(bootPrune.auditChainDigest.length, 64)

    // Re-running prune immediately produces 0 deletions and the exact same audit chain digest
    const secondRun = await runOperationalRetentionPrune(dbHandle.db, { now })
    assert.equal(secondRun.prunedMetrics, 0)
    assert.equal(secondRun.prunedSessions, 0)
    assert.equal(secondRun.prunedLoginAttempts, 0)
    assert.equal(secondRun.prunedLockouts, 0)
    assert.equal(secondRun.prunedTerminalJobs, 0)
    assert.equal(secondRun.auditLogPreservedCount, 2)
    assert.equal(secondRun.auditChainDigest, bootPrune.auditChainDigest)

    const remainingMetrics = await listMetricsHistory(dbHandle.db, { scope: 'host' })
    assert.equal(remainingMetrics.length, 1)
  })

  it('A55: cursor-paginated metrics, accounts, domains, and FTS search maintain deterministic ordering and meet p95 latency budgets', async () => {
    const planId = '11111111-1111-4111-8111-111111111111'
    const targetAccountId = '00000000-0000-4000-8000-000000000001'

    await dbHandle.db.transaction(async (tx) => {
      for (let i = 1; i <= 120; i++) {
        const padded = String(i).padStart(4, '0')
        const accId = `00000000-0000-4000-8000-00000000${padded}`
        const domId = `00000000-0000-4000-9000-00000000${padded}`
        const username = `tenant${padded}`
        const domainName = `portal-${padded}.example.com`
        const uid = 20_000 + i
        const createdAt = new Date(Date.UTC(2026, 0, 1, 0, Math.floor(i / 4), 0)).toISOString()

        await tx.query(
          `INSERT INTO idx_accounts (
            id, username, uid, gid, home, primary_domain, plan_id, owner_id,
            status, suspend_reason, suspended_at, contact_email, ipv4, shell, created_at, updated_at
          ) VALUES ($1, $2, $3, $3, $4, $5, $6, NULL, 'active', NULL, NULL, $7, '203.0.113.10', 'jailed', $8, $8)`,
          [accId, username, uid, `/home/${username}`, domainName, planId, `admin@${domainName}`, createdAt],
        )

        await tx.query(
          `INSERT INTO idx_domains (
            id, account_id, name, kind, parent_id, doc_root, site_type,
            upstream, redirect_to, redirect_code, php_version, php_handler,
            wildcard, certificate_id, suspended, expires_at, path_quota_mb, created_at, updated_at
          ) VALUES ($1, $2, $3, 'primary', NULL, $4, 'php', NULL, NULL, NULL, '8.3', 'fpm', 0, NULL, 0, '2027-01-01T00:00:00.000Z', NULL, $5, $5)`,
          [domId, accId, domainName, `/home/${username}/public_html`, createdAt],
        )

        await tx.query(
          `INSERT INTO search_fts (kind, entity_id, account_id, owner_id, title, subtitle, keywords)
           VALUES ('domain', $1, $2, '', $3, $4, $5)`,
          [domId, accId, domainName, `${username} (primary)`, `/home/${username}/public_html php php8.3`],
        )
      }
    })
    for (let i = 1; i <= 300; i++) {
      const ts = new Date(Date.UTC(2026, 9, 22, 10, 0, Math.floor(i / 3))).toISOString()
      await recordMetricsSample(dbHandle.db, {
        at: ts,
        scope: 'account',
        accountId: targetAccountId,
        cpuPercent: (i % 80) + 1,
        memoryMb: 256 + (i % 128),
        ioReadBps: i * 1024,
        ioWriteBps: i * 512,
        processes: 4,
      })
    }

    // Paginate through all 300 metrics rows in pages of 40, inserting a newer row mid-pagination
    const seenMetricIds = new Set<number>()
    let metricsCursor: { at: string; id: number } | undefined
    const pageLatenciesMs: number[] = []
    let pageCount = 0

    while (true) {
      const t0 = performance.now()
      const page = await listMetricsHistoryPage(dbHandle.db, {
        scope: 'account',
        accountId: targetAccountId,
        limit: 40,
        ...(metricsCursor !== undefined && { cursor: metricsCursor }),
      })
      pageLatenciesMs.push(performance.now() - t0)
      pageCount++

      for (const item of page.items) {
        assert.equal(seenMetricIds.has(item.id), false, `Duplicate metric row id ${item.id} across cursor pages`)
        seenMetricIds.add(item.id)
      }

      if (pageCount === 2) {
        // Concurrent insert at top of history while paginating
        await recordMetricsSample(dbHandle.db, {
          at: '2026-10-22T15:00:00.000Z',
          scope: 'account',
          accountId: targetAccountId,
          cpuPercent: 42,
        })
      }

      if (!page.hasMore || !page.nextCursor) break
      metricsCursor = page.nextCursor
    }

    assert.equal(seenMetricIds.size, 300)

    // Paginate through all 120 indexed accounts in pages of 25
    const seenAccountIds = new Set<string>()
    let accountCursor: { createdAt: string; id: string } | undefined
    while (true) {
      const t0 = performance.now()
      const page = await listIndexedAccountsPage(dbHandle.db, {
        limit: 25,
        ...(accountCursor !== undefined && { cursor: accountCursor }),
      })
      pageLatenciesMs.push(performance.now() - t0)
      for (const acc of page.items) {
        assert.equal(seenAccountIds.has(acc.id), false)
        seenAccountIds.add(acc.id)
      }
      if (!page.hasMore || !page.nextCursor) break
      accountCursor = page.nextCursor
    }
    assert.equal(seenAccountIds.size, 120)

    // Paginate indexed domains
    const domainPage = await listIndexedDomainsPage(dbHandle.db, { accountId: targetAccountId, limit: 10 })
    assert.equal(domainPage.items.length, 1)
    assert.equal(domainPage.items[0]?.name, 'portal-0001.example.com')

    // Benchmark FTS searchIndex
    const tSearch0 = performance.now()
    const hits = await searchIndex(dbHandle.db, 'portal 0042')
    const searchElapsedMs = performance.now() - tSearch0
    assert.equal(hits.some((h) => h.title.includes('portal-0042.example.com')), true)

    pageLatenciesMs.sort((a, b) => a - b)
    const p95Ms = pageLatenciesMs[Math.floor(pageLatenciesMs.length * 0.95)] ?? 0
    assert.equal(p95Ms < 50, true, `Expected cursor pagination p95 < 50ms, got ${p95Ms.toFixed(2)}ms`)
    assert.equal(searchElapsedMs < 50, true, `Expected FTS search < 50ms, got ${searchElapsedMs.toFixed(2)}ms`)
  })
})
