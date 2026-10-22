import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestStateStore } from '@xpanel/state'
import { createTestDb, type TestDbHandle } from '../client.ts'
import { ARGON2, php, sha } from '../testing.ts'
import {
  activate,
  appendAudit,
  checkLockout,
  clearLockout,
  consumeRecoveryHash,
  createApiToken,
  createGeneration,
  createJob,
  createRootPrincipal,
  createSession,
  createUpgrade,
  createUserPrincipal,
  findActiveApiTokenByHash,
  findActiveSessionByTokenHash,
  findPrincipalByUsername,
  finishJob,
  finishUpgrade,
  inFlightUpgrade,
  latestActive,
  listAudit,
  listGenerations,
  listIndexedAccounts,
  listIndexedDomains,
  listIndexedPlans,
  listIndexedResellers,
  listJobs,
  listMetricsHistory,
  markFailed,
  markSessionMfaVerified,
  markTested,
  previousGeneration,
  recordLoginAttempt,
  recordMetricsSample,
  reindexFromState,
  revokeAllSessionsForPrincipal,
  rollbackTo,
  searchIndex,
  setPasswordHash,
  setTotpSecret,
  setUpgradePhase,
  updateJobProgress,
  upsertLockout,
} from './index.ts'

const handles: TestDbHandle[] = []
const dirs: string[] = []

const freshDb = async (): Promise<TestDbHandle> => {
  const h = await createTestDb()
  handles.push(h)
  return h
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.close()))
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('principals, sessions, apiTokens & lockouts', () => {
  it('manages principals, 2FA recovery codes, sessions, API tokens, and lockouts', async () => {
    const h = await freshDb()
    const root = await createRootPrincipal(h.db, { username: 'root', passwordHash: ARGON2 })
    expect(root.forcePasswordChange).toBe(true)

    await setPasswordHash(h.db, root.id, ARGON2, { forceChange: false })
    const recHash = sha('7')
    const secret = new Uint8Array(20).fill(9)
    await setTotpSecret(h.db, root.id, secret, [recHash])
    const updated = await findPrincipalByUsername(h.db, 'root')
    expect(updated?.totpEnabled).toBe(true)
    expect(updated?.totpRecoveryHashes).toEqual([recHash])
    expect(await consumeRecoveryHash(h.db, root.id, recHash)).toBe(true)
    expect(await consumeRecoveryHash(h.db, root.id, recHash)).toBe(false)

    const future = new Date(Date.now() + 3600_000).toISOString()
    const sessHash = sha('a')
    const sess = await createSession(h.db, {
      principalId: root.id,
      tokenHash: sessHash,
      expiresAt: future,
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
    })
    expect((await findActiveSessionByTokenHash(h.db, sessHash))?.id).toBe(sess.id)
    const verified = await markSessionMfaVerified(h.db, sess.id)
    expect(verified.mfaVerified).toBe(true)
    expect(await revokeAllSessionsForPrincipal(h.db, root.id)).toBe(1)
    expect(await findActiveSessionByTokenHash(h.db, sessHash)).toBeNull()

    const tokHash = sha('b')
    const tok = await createApiToken(h.db, {
      principalId: root.id,
      name: 'deploy-ci',
      tokenHash: tokHash,
      scopes: ['account.read', 'domain.write'],
      allowedIps: ['203.0.113.7', '10.0.0.0/8'],
      expiresAt: future,
    })
    expect(tok.allowedIps).toEqual(['203.0.113.7/32', '10.0.0.0/8'])
    expect((await findActiveApiTokenByHash(h.db, tokHash))?.id).toBe(tok.id)

    await recordLoginAttempt(h.db, { username: 'root', ip: '198.51.100.4', success: false, reason: 'bad_password' })
    const lock = await upsertLockout(h.db, {
      ip: '198.51.100.4',
      failures: 5,
      reason: 'too many failed attempts',
      lockedUntil: future,
    })
    expect((await checkLockout(h.db, { ip: '198.51.100.4' }))?.id).toBe(lock.id)
    expect(await clearLockout(h.db, { ip: '198.51.100.4' })).toBe(1)
    expect(await checkLockout(h.db, { ip: '198.51.100.4' })).toBeNull()
  })
})

describe('generations, upgrades, jobs, metrics & audit', () => {
  it('drives generation lifecycle, upgrades, jobs, metrics, and dual-writes audit log', async () => {
    const h = await freshDb()
    const g1 = await createGeneration(h.db, { checksum: sha('1'), actor: 'root' })
    await markTested(h.db, g1.id)
    await activate(h.db, g1.id)
    expect((await latestActive(h.db))?.id).toBe(g1.id)

    const g2 = await createGeneration(h.db, { checksum: sha('2'), actor: 'root' })
    await markTested(h.db, g2.id)
    await activate(h.db, g2.id)
    expect((await latestActive(h.db))?.id).toBe(g2.id)
    expect((await previousGeneration(h.db))?.id).toBe(g1.id)

    await rollbackTo(h.db, g1.id, 'nginx reload failed')
    expect((await latestActive(h.db))?.id).toBe(g1.id)

    const g3 = await createGeneration(h.db, { checksum: sha('3'), actor: 'root' })
    await markFailed(h.db, g3.id, 'nginx -t syntax error')
    expect((await listGenerations(h.db)).length).toBe(3)

    const up = await createUpgrade(h.db, { fromVersion: '1.0.0', toVersion: '1.1.0', actor: 'root', fromSchemaVersion: 1 })
    expect((await inFlightUpgrade(h.db))?.id).toBe(up.id)
    await setUpgradePhase(h.db, up.id, 'snapshot', { snapshotPath: '/var/lib/xpanel/snapshots/s1.tar.gz' })
    const settled = await finishUpgrade(h.db, up.id, {
      status: 'succeeded',
      toSchemaVersion: 1,
      healthReport: { ok: true },
    })
    expect(settled.status).toBe('succeeded')
    expect(await inFlightUpgrade(h.db)).toBeNull()

    const job = await createJob(h.db, { kind: 'backup.create', actor: 'root', summary: 'Queued backup' })
    await updateJobProgress(h.db, job.id, 50, 'Archiving home')
    const doneJob = await finishJob(h.db, job.id, { status: 'succeeded', summary: 'Backup complete' })
    expect(doneJob.progress).toBe(100)
    expect((await listJobs(h.db)).length).toBe(1)

    await recordMetricsSample(h.db, { scope: 'host', cpuPercent: 12.5, memoryMb: 380, diskMb: 4096, load1: 0.42 })
    expect((await listMetricsHistory(h.db, { scope: 'host' }))[0]?.cpuPercent).toBe(12.5)

    const tmp = await mkdtemp(join(tmpdir(), 'xpanel-audit-'))
    dirs.push(tmp)
    const auditFile = join(tmp, 'audit.log')
    const entry = await appendAudit(
      h.db,
      {
        actor: 'root',
        action: 'account.create',
        target: 'alice',
        detail: { domain: 'alice-shop.com', password: 'secret-value' },
        outcome: 'ok',
      },
      { auditLogFilePath: auditFile },
    )
    expect(entry.detail.password).toBe('[REDACTED]')
    const listed = await listAudit(h.db, { actor: 'root' })
    expect(listed).toHaveLength(1)
    const fileContent = await readFile(auditFile, 'utf8')
    expect(JSON.parse(fileContent.trim())).toMatchObject({ action: 'account.create', target: 'alice' })
  })
})

describe('reindexFromState & FTS5 searchIndex', () => {
  it('rebuilds idx_* and search_fts from @xpanel/state snapshot with state-file-wins semantics', async () => {
    const h = await freshDb()
    const { store, close } = await createTestStateStore()
    try {
      const fl = await store.createFeatureList({ name: 'Default', ownerId: null, disabled: [] })
      const plan = await store.createPlan({
        name: 'Business',
        ownerId: null,
        featureListId: fl.id,
        resources: {
          diskMb: 20_480,
          bandwidthMbMonth: 'unlimited',
          ioReadBps: 'unlimited',
          ioWriteBps: 'unlimited',
          ioReadIops: 'unlimited',
          ioWriteIops: 'unlimited',
          memoryMb: 1024,
          maxProcesses: 128,
          cpuPercent: 100,
        },
        caps: {
          addonDomains: 10,
          aliasDomains: 'unlimited',
          subdomains: 20,
          mailboxes: 50,
          forwarders: 50,
          mailingLists: 5,
          ftpAccounts: 10,
          databases: 20,
          phpWorkers: 8,
        },
        dedicatedIp: false,
        shell: 'jailed',
        defaultMailboxQuotaMb: 1024,
      })
      const reseller = await store.createReseller({
        username: 'reseller1',
        passwordHash: ARGON2,
        acl: ['create-account'],
        maxAccounts: 20,
        totalDiskMb: 204_800,
        totalBandwidthMb: 'unlimited',
        oversell: false,
        nameservers: ['ns1.xpanel.test'],
        delegatedIps: ['192.0.2.10'],
      })
      const acc = await store.createAccount({
        username: 'alice',
        passwordHash: ARGON2,
        primaryDomain: 'alice-shop.com',
        planId: plan.id,
        ownerId: reseller.id,
        contactEmail: 'ops@alice-shop.com',
        ipv4: '192.0.2.10',
        shell: 'jailed',
        php: php(),
      })
      await createUserPrincipal(h.db, {
        username: acc.username,
        passwordHash: ARGON2,
        accountId: acc.id,
      })
      await store.createServiceUser({
        accountId: acc.id,
        login: 'support@alice-shop.com',
        passwordHash: ARGON2,
        services: { email: true, ftp: false, webdisk: false },
        mailboxQuotaMb: 512,
        ftpDir: '',
      })
      await store.createDatabase({ accountId: acc.id, name: 'alice_shop' })

      const snap = await store.readSnapshot()
      const stats = await reindexFromState(h.db, snap)
      expect(stats).toEqual({
        resellers: 1,
        plans: 1,
        accounts: 1,
        domains: 1,
        serviceUsers: 1,
        databases: 1,
        ftsEntries: 6,
      })

      expect((await listIndexedAccounts(h.db))[0]?.username).toBe('alice')
      expect((await listIndexedDomains(h.db))[0]?.name).toBe('alice-shop.com')
      expect((await listIndexedPlans(h.db))[0]?.name).toBe('Business')
      expect((await listIndexedResellers(h.db))[0]?.username).toBe('reseller1')

      const hits = await searchIndex(h.db, 'alice')
      expect(hits.map((x) => x.kind).sort()).toEqual(['account', 'database', 'domain', 'service-user'])
    } finally {
      await close()
    }
  })
})
