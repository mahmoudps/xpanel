import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { XpanelError } from '@xpanel/core'
import type { PhpSettings } from '@xpanel/core'
import {
  REBUILT_DERIVED_TABLES,
  UNTOUCHED_OPERATIONAL_TABLES,
  appendAudit,
  createApiToken,
  createJob,
  createRootPrincipal,
  createSession,
  createTestDb,
  createUserPrincipal,
  findActiveApiTokenByHash,
  findActiveSessionByTokenHash,
  findPrincipalByUsername,
  getPendingTotpEnrollment,
  listAudit,
  listIndexedAccounts,
  listIndexedDomains,
  listJobs,
  reindexFromState,
  setTotpSecret,
  startTotpEnrollment,
  verifySnapshotCoherence,
} from '../../db/src/index.ts'
import { createStateStore, createTestStateStore } from './store.ts'
import type { TestStateStoreHandle } from './store.ts'
import {
  checksumStateTree,
  formatShortReference,
  isValidShortReference,
  validateShortReference,
} from './validate-state.ts'
import { WriterLock } from './writer-lock.ts'

const ARGON2 =
  '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'

const sha = (seed: string): string => createHash('sha256').update(seed).digest('hex')

const defaultPhp = (): PhpSettings => ({
  version: '8.3',
  handler: 'fpm',
  fpm: {
    mode: 'ondemand',
    maxChildren: 5,
    startServers: 2,
    minSpareServers: 1,
    maxSpareServers: 3,
    maxRequests: 500,
    processIdleTimeoutSec: 10,
  },
  ini: {},
})

const STORE_MODULE_URL = new URL('./store.ts', import.meta.url).href
const THIS_DIR = fileURLToPath(new URL('.', import.meta.url))

interface WorkerAccountTask {
  rootDir: string
  username: string
  primaryDomain: string
  planId: string
  ownerId: string | null
  contactEmail: string
  ipv4: string
}

const runChildWorkerAccountCreate = (
  task: WorkerAccountTask,
): Promise<{ ok: true; uid: number; id: string; username: string } | { ok: false; code: string; message: string }> =>
  new Promise((resolve, reject) => {
    const script = `
      import { createStateStore } from ${JSON.stringify(STORE_MODULE_URL)};
      const payload = JSON.parse(process.argv[1]);
      const store = createStateStore(payload.rootDir);
      try {
        const acc = await store.createAccount({
          username: payload.username,
          passwordHash: ${JSON.stringify(ARGON2)},
          primaryDomain: payload.primaryDomain,
          planId: payload.planId,
          ownerId: payload.ownerId,
          contactEmail: payload.contactEmail,
          ipv4: payload.ipv4,
          shell: 'jailed',
          php: ${JSON.stringify(defaultPhp())},
        });
        process.stdout.write(JSON.stringify({ ok: true, uid: acc.uid, id: acc.id, username: acc.username }) + '\\n');
      } catch (err) {
        process.stdout.write(JSON.stringify({
          ok: false,
          code: err && typeof err === 'object' && 'code' in err ? String(err.code) : 'UNKNOWN',
          message: err instanceof Error ? err.message : String(err),
        }) + '\\n');
      }
    `
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e', script, JSON.stringify(task)],
      {
        cwd: THIS_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code) => {
      const lines = stdout
        .trim()
        .split(/\r?\n/)
        .filter((line) => line.startsWith('{') && line.endsWith('}'))
      const last = lines.at(-1)
      if (!last) {
        reject(new Error(`worker exited with code ${code}: stdout=${stdout} stderr=${stderr}`))
        return
      }
      resolve(JSON.parse(last))
    })
  })

describe('R01 — state, identity & recovery authority (A18, A25, A58)', () => {
  let h: TestStateStoreHandle
  let planId: string

  beforeEach(async () => {
    h = await createTestStateStore()
    for (const suffix of [10, 11, 20, 30, 31, 32, 40, 50, 60]) await h.store.saveServerIp({ address: `192.0.2.${suffix}`, version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: suffix === 10, notes: 'Diagnostic inventory' })
    const fl = await h.store.createFeatureList({
      name: 'Standard',
      ownerId: null,
      disabled: [],
    })
    const plan = await h.store.createPlan({
      name: 'Pro',
      ownerId: null,
      featureListId: fl.id,
      resources: {
        diskMb: 10240,
        bandwidthMbMonth: 102400,
        ioReadBps: 'unlimited',
        ioWriteBps: 'unlimited',
        ioReadIops: 'unlimited',
        ioWriteIops: 'unlimited',
        memoryMb: 1024,
        maxProcesses: 40,
        cpuPercent: 200,
      },
      caps: {
        addonDomains: 5,
        aliasDomains: 5,
        subdomains: 10,
        mailboxes: 10,
        forwarders: 20,
        mailingLists: 2,
        ftpAccounts: 5,
        databases: 5,
        phpWorkers: 6,
      },
      dedicatedIp: false,
      shell: 'jailed',
      defaultMailboxQuotaMb: 512,
    })
    planId = plan.id
  })

  afterEach(async () => {
    await h.close()
  })

  it('serializes multi-process child_process account creations, enforces domain uniqueness & reseller caps, and never reuses UIDs', async () => {
    const reseller = await h.store.createReseller({
      username: 'rescap',
      passwordHash: ARGON2,
      acl: ['create-account', 'list-accounts'],
      maxAccounts: 2,
      totalDiskMb: 50000,
      totalBandwidthMb: 500000,
      oversell: false,
      nameservers: ['ns1.example.test'],
      delegatedIps: ['192.0.2.50'],
    })

    // 1. Four real OS processes race to create accounts under a reseller with maxAccounts = 2
    const capResults = await Promise.all(
      ['mpuser1', 'mpuser2', 'mpuser3', 'mpuser4'].map((username) =>
        runChildWorkerAccountCreate({
          rootDir: h.rootDir,
          username,
          primaryDomain: `${username}.example.test`,
          planId,
          ownerId: reseller.id,
          contactEmail: `ops@${username}.example.test`,
          ipv4: '192.0.2.50',
        }),
      ),
    )

    const capSuccesses = capResults.filter((r): r is Extract<typeof r, { ok: true }> => r.ok)
    const capFailures = capResults.filter((r): r is Extract<typeof r, { ok: false }> => !r.ok)
    expect(capSuccesses).toHaveLength(2)
    expect(capFailures).toHaveLength(2)
    for (const f of capFailures) {
      expect(f.code).toBe('LIMIT_EXCEEDED')
    }
    expect(new Set(capSuccesses.map((s) => s.uid)).size).toBe(2)

    // 2. Three real OS processes race to claim the exact same primary domain
    const domResults = await Promise.all(
      ['domrace1', 'domrace2', 'domrace3'].map((username) =>
        runChildWorkerAccountCreate({
          rootDir: h.rootDir,
          username,
          primaryDomain: 'contended-domain.example.test',
          planId,
          ownerId: null,
          contactEmail: `${username}@example.test`,
          ipv4: '192.0.2.10',
        }),
      ),
    )
    const domSuccesses = domResults.filter((r): r is Extract<typeof r, { ok: true }> => r.ok)
    const domFailures = domResults.filter((r): r is Extract<typeof r, { ok: false }> => !r.ok)
    expect(domSuccesses).toHaveLength(1)
    expect(domFailures).toHaveLength(2)
    for (const f of domFailures) {
      expect(f.code).toBe('CONFLICT')
    }

    const snap = await h.store.readSnapshot()
    expect(snap.accounts).toHaveLength(3)
    expect(snap.domains.filter((d) => d.name === 'contended-domain.example.test')).toHaveLength(1)
  }, 30000)

  it('enforces fencing tokens, monotonic revisions, and expectedRevision CAS conflict detection', async () => {
    const auth0 = await h.store.getAuthorityMetadata()
    // beforeEach registered 9 diagnostic IP entries, then the feature list and plan.
    expect(auth0.revision).toBe(11)
    expect(auth0.fencingToken).toBeGreaterThanOrEqual(11)

    // Matching expectedRevision succeeds and increments revision to 12.
    const acc = await h.store.createAccount(
      {
        username: 'casuser',
        passwordHash: ARGON2,
        primaryDomain: 'casuser.example.test',
        planId,
        ownerId: null,
        contactEmail: 'cas@example.test',
        ipv4: '192.0.2.11',
        shell: 'jailed',
        php: defaultPhp(),
      },
      { expectedRevision: 11 },
    )
    expect(acc.uid).toBe(20000)

    const auth1 = await h.store.getAuthorityMetadata()
    expect(auth1.revision).toBe(12)
    expect(auth1.fencingToken).toBeGreaterThan(auth0.fencingToken)

    // Stale expectedRevision is rejected with CONFLICT without mutating state
    await expect(
      h.store.suspendAccount(acc.id, 'stale write attempt', { expectedRevision: 11 }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect((await h.store.getAccount(acc.id))?.status).toBe('active')

    // Stale fencingToken is rejected with CONFLICT
    await expect(
      h.store.suspendAccount(acc.id, 'stale token attempt', { fencingToken: auth0.fencingToken }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect((await h.store.getAccount(acc.id))?.status).toBe('active')

    // A paused live owner keeps the OS mutex: recovery must await termination or release.
    const rawLock = h.store.getWriterLock()
    const staleLease = await rawLock.acquire()
    await expect(new WriterLock(h.rootDir, { acquireTimeoutMs: 80, retryIntervalMs: 5 }).forceRecoverLease()).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(staleLease.assertFencingToken()).resolves.toMatchObject({ fencingToken: staleLease.fencingToken })
    await staleLease.release()
    const recoveredMeta = await rawLock.forceRecoverLease()
    expect(recoveredMeta.fencingToken).toBeGreaterThan(staleLease.fencingToken)
    const newerLease = await rawLock.acquire()
    expect(newerLease.fencingToken).toBeGreaterThan(staleLease.fencingToken)
    await newerLease.commitAuthority({ incrementRevision: true })
    await newerLease.release()

    await expect(staleLease.assertFencingToken()).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(staleLease.commitAuthority({ incrementRevision: true })).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('never steals a lock while the owner PID is alive, and recovers dead-PID crash intents while preserving burned UIDs', async () => {
    const liveLock = new WriterLock(h.rootDir, { acquireTimeoutMs: 120, retryIntervalMs: 10 })
    const contenderLock = new WriterLock(h.rootDir, { acquireTimeoutMs: 120, retryIntervalMs: 10 })

    const lease = await liveLock.acquire()
    try {
      // Even though acquireTimeoutMs (120ms) elapses, process.pid is alive so contenderLock must NOT steal the lock
      await expect(contenderLock.acquire()).rejects.toMatchObject({ code: 'CONFLICT' })
      // Original lease still owns its fencing token
      await expect(lease.assertFencingToken()).resolves.toMatchObject({ fencingToken: lease.fencingToken })
    } finally {
      await lease.release()
    }

    // Simulate a crashed writer (dead PID 999999) that burned UID 20000 and wrote a partial account dir before dying
    const partialAccountDir = join(h.rootDir, 'accounts', 'crasheduser')
    await mkdir(join(partialAccountDir, 'domains'), { recursive: true })
    await writeFile(
      join(partialAccountDir, 'domains', 'crashed.example.test.json'),
      JSON.stringify({ id: randomUUID(), name: 'crashed.example.test' }),
    )
    await writeFile(
      join(h.rootDir, 'uid-allocator.json'),
      JSON.stringify({
        nextUid: 20001,
        allocated: [{ uid: 20000, username: 'crasheduser', allocatedAt: new Date().toISOString() }],
      }),
    )
    // Real legacy journal and authority epochs must agree before recovery.
    const authority = await h.store.getWriterLock().readAuthority()
    await writeFile(join(h.rootDir, 'authority.json'), JSON.stringify({ ...authority, fencingToken: 99 }))
    const lockDir = join(h.rootDir, '.lock')
    await mkdir(lockDir, { recursive: true })
    await writeFile(
      join(lockDir, 'owner.json'),
      JSON.stringify({
        pid: 999999,
        fencingToken: 99,
        acquiredAt: new Date(Date.now() - 60_000).toISOString(),
        leaseId: randomUUID(),
      }),
    )
    await writeFile(
      join(lockDir, 'intent.json'),
      JSON.stringify({
        op: 'createAccount:crasheduser',
        fencingToken: 99,
        baseRevision: 11,
        createdRelPaths: ['accounts/crasheduser'],
        backups: [],
        recordedAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    )

    // Next mutation recovers the dead-PID lock, rolls back partialAccountDir, and keeps UID 20000 burned
    const recoveredAcc = await h.store.createAccount({
      username: 'survivor',
      passwordHash: ARGON2,
      primaryDomain: 'crashed.example.test',
      planId,
      ownerId: null,
      contactEmail: 'survivor@example.test',
      ipv4: '192.0.2.20',
      shell: 'jailed',
      php: defaultPhp(),
    })
    expect(recoveredAcc.uid).toBe(20001)
    expect(await h.store.getAccountByUsername('crasheduser')).toBeNull()

    const snap = await h.store.readSnapshot()
    expect(snap.uidAllocator.nextUid).toBe(20002)
    expect(snap.uidAllocator.allocated.map((a) => ({ uid: a.uid, username: a.username }))).toEqual([
      { uid: 20000, username: 'crasheduser' },
      { uid: 20001, username: 'survivor' },
    ])
  })

  it('burns UIDs permanently on mid-mutation failure, account deletion, and host /etc/passwd UID collision (A18)', async () => {
    let failBeforeCommit = true
    const hookedStore = createStateStore(h.rootDir, {
      existingHostUids: () => [20000, 20002],
      onBeforeAccountCommit: async ({ username }) => {
        if (failBeforeCommit && username === 'abortedacct') {
          throw new XpanelError('SERVICE_UNAVAILABLE', 'simulated crash after UID allocation and domain write')
        }
      },
    })

    // UID 20000 is on the host, so 'abortedacct' gets 20001, then fails before account.json commit
    await expect(
      hookedStore.createAccount({
        username: 'abortedacct',
        passwordHash: ARGON2,
        primaryDomain: 'aborted.example.test',
        planId,
        ownerId: null,
        contactEmail: 'aborted@example.test',
        ipv4: '192.0.2.30',
        shell: 'jailed',
        php: defaultPhp(),
      }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })

    // Partial domain file was rolled back, so 'aborted.example.test' is free, but UIDs 20000, 20001, and host UID 20002 are burned!
    failBeforeCommit = false
    const created = await hookedStore.createAccount({
      username: 'goodacct',
      passwordHash: ARGON2,
      primaryDomain: 'aborted.example.test',
      planId,
      ownerId: null,
      contactEmail: 'good@example.test',
      ipv4: '192.0.2.31',
      shell: 'jailed',
      php: defaultPhp(),
    })
    expect(created.uid).toBe(20003)

    // Terminate and delete 'goodacct', then create another account — UID 20003 is never reused
    await hookedStore.markTerminating(created.id)
    expect(await hookedStore.deleteAccount(created.id)).toBe(true)

    const afterDelete = await hookedStore.createAccount({
      username: 'nextacct',
      passwordHash: ARGON2,
      primaryDomain: 'next.example.test',
      planId,
      ownerId: null,
      contactEmail: 'next@example.test',
      ipv4: '192.0.2.32',
      shell: 'jailed',
      php: defaultPhp(),
    })
    expect(afterDelete.uid).toBe(20004)
  })

  it('prevents compile-vs-save TOCTOU drift by verifying immutable StateSnapshot handoff in saveGenerationSnapshot', async () => {
    await h.store.createAccount({
      username: 'genuser',
      passwordHash: ARGON2,
      primaryDomain: 'genuser.example.test',
      planId,
      ownerId: null,
      contactEmail: 'gen@example.test',
      ipv4: '192.0.2.40',
      shell: 'jailed',
      php: defaultPhp(),
    })

    const snap1 = await h.store.readSnapshot()
    expect(snap1.revision).toBe(12)

    // Saving the exact pre-read snapshot succeeds when revision has not drifted
    const saved1 = await h.store.saveGenerationSnapshot(1, snap1)
    expect(saved1.checksum).toBe(snap1.checksum)
    expect(saved1.revision).toBe(snap1.revision)

    // Mutate state after reading snap1 so revision advances to 13.
    await h.store.createFeatureList({
      name: 'Concurrent mutation after compile',
      ownerId: null,
      disabled: ['terminal'],
    })

    // Attempting to save stale snap1 as generation 2 after state drifted is rejected with CONFLICT
    await expect(h.store.saveGenerationSnapshot(2, snap1)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
  })

  it('allocates server-side monotonic short references under the writer lock and never truncates UUIDs (A58)', async () => {
    const jobEntity1 = randomUUID()
    const jobEntity2 = randomUUID()
    const backupEntity1 = randomUUID()
    const migEntity1 = randomUUID()
    const genEntity1 = '1'

    // Read before allocation returns null (never allocates on read or truncates UUID)
    expect(await h.store.getAllocatedReference('job', jobEntity1)).toBeNull()

    const refJob1 = await h.store.allocateReference('job', { entityId: jobEntity1 })
    const refJob2 = await h.store.allocateReference('job', { entityId: jobEntity2 })
    const refBkp1 = await h.store.allocateReference('backup', { entityId: backupEntity1 })
    const refMig1 = await h.store.allocateReference('migration', { entityId: migEntity1 })
    const refGen1 = await h.store.allocateReference('generation', { entityId: genEntity1 })

    expect(refJob1).toBe('JOB-000001')
    expect(refJob2).toBe('JOB-000002')
    expect(refBkp1).toBe('BKP-000001')
    expect(refMig1).toBe('MIG-000001')
    expect(refGen1).toBe('GEN-000001')

    // Idempotent re-allocation for the same (kind, entityId) returns the existing reference without advancing sequence
    const refJob1Again = await h.store.allocateReference('job', { entityId: jobEntity1 })
    expect(refJob1Again).toBe('JOB-000001')
    expect(await h.store.getAllocatedReference('job', jobEntity1)).toBe('JOB-000001')

    // Validator accepts canonical short references and rejects truncated UUID fragments
    expect(validateShortReference('JOB-000001', 'job')).toBe('JOB-000001')
    expect(formatShortReference('backup', 42)).toBe('BKP-000042')
    expect(isValidShortReference(jobEntity1.slice(0, 8))).toBe(false)
    expect(() => validateShortReference(jobEntity1.slice(0, 8), 'job')).toThrow(XpanelError)
  })

  it('verifies snapshot coherence before wiping idx_* and preserves SQLite operational/identity authority tables (A25)', async () => {
    const dbHandle = await createTestDb()
    try {
      const acc = await h.store.createAccount({
        username: 'alice',
        passwordHash: ARGON2,
        primaryDomain: 'alice.example.test',
        planId,
        ownerId: null,
        contactEmail: 'alice@example.test',
        ipv4: '192.0.2.60',
        shell: 'jailed',
        php: defaultPhp(),
      })

      // Populate operational & identity/recovery authority tables in SQLite
      const rootPrincipal = await createRootPrincipal(dbHandle.db, {
        username: 'root',
        passwordHash: ARGON2,
      })
      const userPrincipal = await createUserPrincipal(dbHandle.db, {
        username: acc.username,
        passwordHash: ARGON2,
        accountId: acc.id,
      })
      await setTotpSecret(dbHandle.db, rootPrincipal.id, new Uint8Array(20).fill(7), [sha('rec1')])
      const sessHash = sha('sess-r01')
      const future = new Date(Date.now() + 3600_000).toISOString()
      const session = await createSession(dbHandle.db, {
        principalId: userPrincipal.id,
        tokenHash: sessHash,
        expiresAt: future,
        ip: '198.51.100.10',
        userAgent: 'R01-Authority-Test/1.0',
      })
      const pendingTotp = await startTotpEnrollment(dbHandle.db, {
        principalId: userPrincipal.id,
        sessionId: session.id,
        sealedSecret: new Uint8Array(20).fill(9),
        recoveryHashes: [sha('rec2')],
        expectedPasswordHash: ARGON2,
      })
      const tokHash = sha('tok-r01')
      const token = await createApiToken(dbHandle.db, {
        principalId: rootPrincipal.id,
        name: 'deploy-automation',
        tokenHash: tokHash,
        scopes: ['account.read', 'domain.write'],
        allowedIps: ['198.51.100.10'],
        expiresAt: future,
      })
      await appendAudit(dbHandle.db, {
        actor: 'root',
        action: 'account.create',
        target: acc.username,
        detail: { accountId: acc.id },
        outcome: 'ok',
      })
      const job = await createJob(dbHandle.db, {
        kind: 'account.create',
        actor: 'root',
        accountId: acc.id,
        summary: 'Provisioning alice',
      })

      const snap = await h.store.readSnapshot()
      const firstStats = await reindexFromState(dbHandle.db, snap)
      expect(firstStats).toEqual({
        resellers: 0,
        plans: 1,
        accounts: 1,
        domains: 1,
        serviceUsers: 0,
        databases: 0,
        ftsEntries: 3,
      })
      expect(firstStats.snapshotVerified).toBe(true)
      expect(firstStats.rebuiltDerivedTables).toEqual(REBUILT_DERIVED_TABLES)
      expect(firstStats.untouchedOperationalTables).toEqual(UNTOUCHED_OPERATIONAL_TABLES)
      expect(firstStats.report?.identityRecoveryAuthority).toBe('sqlite-operational-db')
      expect(firstStats.report?.desiredStateAuthority).toBe('filesystem-state-tree')
      expect(firstStats.report?.operationalRowCountsPreserved).toEqual({
        principals: 2,
        sessions: 1,
        totp_enrollments: 1,
        api_tokens: 1,
        audit_log: 1,
        jobs: 1,
      })

      // Tamper with snapshot (e.g. broken checksum or dangling planId) — reindexFromState must refuse BEFORE wiping idx_*
      const badChecksumSnap = { ...structuredClone(snap), checksum: 'f'.repeat(64) }
      await expect(reindexFromState(dbHandle.db, badChecksumSnap)).rejects.toMatchObject({
        code: 'VALIDATION',
      })

      const danglingPlanSnap = structuredClone(snap)
      danglingPlanSnap.accounts[0]!.planId = randomUUID()
      danglingPlanSnap.checksum = checksumStateTree(danglingPlanSnap)
      expect(() => verifySnapshotCoherence(danglingPlanSnap)).toThrow(XpanelError)
      await expect(reindexFromState(dbHandle.db, danglingPlanSnap)).rejects.toMatchObject({
        code: 'VALIDATION',
      })

      // Derived idx_accounts and idx_domains are still intact after refused reindex!
      expect(await listIndexedAccounts(dbHandle.db)).toHaveLength(1)
      expect(await listIndexedDomains(dbHandle.db)).toHaveLength(1)

      // Operational & identity/recovery tables are 100% intact
      const foundAlice = await findPrincipalByUsername(dbHandle.db, 'alice')
      expect(foundAlice?.username).toBe('alice')
      expect((await getPendingTotpEnrollment(dbHandle.db, userPrincipal.id, session.id))?.enrollmentId).toBe(
        pendingTotp.enrollmentId,
      )
      expect((await findActiveSessionByTokenHash(dbHandle.db, sessHash))?.id).toBe(session.id)
      expect((await findActiveApiTokenByHash(dbHandle.db, tokHash))?.id).toBe(token.id)
      expect(await listAudit(dbHandle.db, { actor: 'root' })).toHaveLength(1)
      expect(await listJobs(dbHandle.db)).toHaveLength(1)
      expect(job.id).toBeTruthy()
    } finally {
      await dbHandle.close()
    }
  })
})
