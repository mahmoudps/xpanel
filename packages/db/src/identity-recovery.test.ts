import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checksumStateTree, type StateSnapshot } from '@xpanel/state'
import { createDb, type DbHandle } from './client.ts'
import {
  captureRevocationWatermark,
  computeSealKeyFingerprint,
  createIdentityAuthorityBackup,
  readRevocationWatermark,
  recoverFromMfaSealKeyLoss,
  restoreIdentityAuthorityBackup,
  rotateMfaSealKey,
  sealTotpSecretWithKey,
  unsealTotpSecretWithKey,
  verifyIdentityAuthorityBackup,
} from './identity-recovery.ts'
import { migrate } from './migrate.ts'
import {
  consumeRecoveryHash,
  consumeTotpStep,
  createApiToken,
  createResellerPrincipal,
  createRootPrincipal,
  createSession,
  findActiveApiTokenByHash,
  findActiveSessionByTokenHash,
  getPendingTotpEnrollment,
  getPrincipal,
  listIndexedAccounts,
  listIndexedDomains,
  listIndexedPlans,
  listIndexedResellers,
  reindexFromState,
  revokeApiToken,
  revokeSession,
  searchIndex,
  setPasswordHash,
  setTotpSecret,
  startTotpEnrollment,
} from './repos/index.ts'
import { ARGON2 } from './testing.ts'

const sha = (label: string): string => createHash('sha256').update(label, 'utf8').digest('hex')

const handles: DbHandle[] = []
const tempDirs: string[] = []

const OLD_SERVER_SECRET = 'old-server-master-secret-at-least-32-bytes!!'
const NEW_SERVER_SECRET = 'new-rotated-server-secret-at-least-32-bytes!'
const ROTATED_ARGON2 = ARGON2.replace('t=3', 't=4')
const TOTP_BASE32_ROOT = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'
const TOTP_BASE32_RESELLER = 'KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU'

const futureIso = (ms = 3_600_000): string => new Date(Date.now() + ms).toISOString()

afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.close()))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const createFileDb = async (name = 'identity.db'): Promise<{ dir: string; filename: string; handle: DbHandle }> => {
  const dir = await mkdtemp(join(tmpdir(), 'xpanel-id-recovery-'))
  tempDirs.push(dir)
  const filename = join(dir, name)
  const handle = createDb(filename)
  handles.push(handle)
  await migrate(handle.db)
  return { dir, filename, handle }
}

const sampleHostingSnapshot = (): StateSnapshot => {
  const resellerId = '11111111-1111-4111-8111-111111111111'
  const planId = '22222222-2222-4222-8222-222222222222'
  const featureListId = '33333333-3333-4333-8333-333333333333'
  const accountId = '44444444-4444-4444-8444-444444444444'
  const domainId = '55555555-5555-4555-8555-555555555555'
  const now = new Date().toISOString()
  const base: Omit<StateSnapshot, 'checksum'> = {
    server: null,
    firewall: { rules: [], prefixLists: [] },
    uidAllocator: { nextUid: 20002, allocated: [{ uid: 20001, username: 'tenantalpha', allocatedAt: now }] },
    resellers: [
      {
        id: resellerId,
        username: 'partnerone',
        acl: ['list-accounts', 'create-account'],
        maxAccounts: 25,
        totalDiskMb: 50_000,
        totalBandwidthMb: 500_000,
        oversell: false,
        nameservers: ['ns1.example.test', 'ns2.example.test'],
        delegatedIps: ['192.0.2.10'],
      },
    ],
    featureLists: [
      {
        id: featureListId,
        name: 'default',
        ownerId: null,
        disabled: [],
      },
    ],
    plans: [
      {
        id: planId,
        name: 'pro-hosting',
        ownerId: resellerId,
        featureListId,
        resources: {
          diskMb: 10_000,
          bandwidthMbMonth: 100_000,
          ioReadBps: 'unlimited',
          ioWriteBps: 'unlimited',
          ioReadIops: 'unlimited',
          ioWriteIops: 'unlimited',
          memoryMb: 1024,
          cpuPercent: 100,
          maxProcesses: 40,
        },
        caps: {
          addonDomains: 10,
          aliasDomains: 10,
          subdomains: 20,
          databases: 10,
          mailboxes: 25,
          forwarders: 25,
          mailingLists: 5,
          ftpAccounts: 10,
          phpWorkers: 4,
        },
        dedicatedIp: false,
        shell: 'none',
        defaultMailboxQuotaMb: 1024,
      },
    ],
    accounts: [
      {
        id: accountId,
        username: 'tenantalpha',
        uid: 20001,
        gid: 20001,
        home: '/home/tenantalpha',
        primaryDomain: 'alpha.example.test',
        planId,
        ownerId: resellerId,
        status: 'active',
        suspendReason: null,
        suspendedAt: null,
        contactEmail: 'ops@alpha.example.test',
        ipv4: '192.0.2.10',
        shell: 'none',
        createdAt: now,
      },
    ],
    domains: [
      {
        id: domainId,
        accountId,
        name: 'alpha.example.test',
        kind: 'primary',
        parentId: null,
        docRoot: '/home/tenantalpha/public_html',
        siteType: 'php',
        upstream: null,
        redirect: null,
        php: {
          version: '8.3',
          handler: 'fpm',
          fpm: {
            mode: 'ondemand',
            maxChildren: 4,
            startServers: 2,
            minSpareServers: 1,
            maxSpareServers: 3,
            maxRequests: 500,
            processIdleTimeoutSec: 10,
          },
          ini: {},
        },
        wildcard: false,
        certificateId: null,
        suspended: false,
        expiresAt: null,
        pathQuotaMb: 'unlimited',
      },
    ],
    serviceUsers: [],
    databases: [],
    databaseUsers: [],
    zones: [],
    certificates: [],
    cronJobs: [],
    ipPool: [],
  }
  return {
    ...base,
    checksum: checksumStateTree(base),
  }
}

describe('A25(a): derived index loss vs identity authority separation', () => {
  it('rebuilds idx_* and search_fts via reindexFromState while preserving principals, MFA, and revocations untouched', async () => {
    const { handle } = await createFileDb()
    const snapshot = sampleHostingSnapshot()
    await reindexFromState(handle.db, snapshot)

    const root = await createRootPrincipal(handle.db, {
      username: 'root',
      passwordHash: ARGON2,
      forcePasswordChange: false,
    })
    const sealedRoot = sealTotpSecretWithKey(TOTP_BASE32_ROOT, OLD_SERVER_SECRET)
    await setTotpSecret(handle.db, root.id, sealedRoot, [sha('rec-1'), sha('rec-2')])
    expect(await consumeTotpStep(handle.db, root.id, 150, sealedRoot)).toBe(true)

    const activeSession = await createSession(handle.db, {
      principalId: root.id,
      tokenHash: sha('sess-active'),
      expiresAt: futureIso(),
      mfaVerified: true,
    })
    const revokedSession = await createSession(handle.db, {
      principalId: root.id,
      tokenHash: sha('sess-revoked'),
      expiresAt: futureIso(),
      mfaVerified: true,
    })
    await revokeSession(handle.db, revokedSession.id)

    const activeToken = await createApiToken(handle.db, {
      principalId: root.id,
      name: 'active-token',
      tokenHash: sha('tok-active'),
      scopes: ['accounts:read'],
      expiresAt: futureIso(),
    })
    const revokedToken = await createApiToken(handle.db, {
      principalId: root.id,
      name: 'revoked-token',
      tokenHash: sha('tok-revoked'),
      scopes: ['*'],
      expiresAt: futureIso(),
    })
    await revokeApiToken(handle.db, revokedToken.id)

    // Simulate total loss of derived SQLite index tables and FTS5 index
    await handle.db.exec(`
      DELETE FROM idx_databases;
      DELETE FROM idx_service_users;
      DELETE FROM idx_domains;
      DELETE FROM idx_accounts;
      DELETE FROM idx_plans;
      DELETE FROM idx_resellers;
      DELETE FROM search_fts;
    `)
    expect(await listIndexedAccounts(handle.db)).toEqual([])
    expect(await searchIndex(handle.db, 'alpha')).toEqual([])

    // Rebuild index from authoritative hosting state
    const reindexed = await reindexFromState(handle.db, snapshot)
    expect(reindexed.accounts).toBe(1)
    expect(reindexed.domains).toBe(1)
    expect(reindexed.resellers).toBe(1)
    expect(reindexed.plans).toBe(1)
    expect((await listIndexedAccounts(handle.db)).map((a) => a.username)).toEqual(['tenantalpha'])
    expect((await listIndexedDomains(handle.db)).map((d) => d.name)).toEqual(['alpha.example.test'])
    expect((await listIndexedResellers(handle.db)).map((r) => r.username)).toEqual(['partnerone'])
    expect((await listIndexedPlans(handle.db)).map((p) => p.name)).toEqual(['pro-hosting'])
    expect((await searchIndex(handle.db, 'alpha')).length).toBeGreaterThan(0)

    // Verify credentials, MFA secret, replay barrier, and revocations are completely intact
    const rootAfter = await getPrincipal(handle.db, root.id)
    expect(rootAfter?.passwordHash).toBe(ARGON2)
    expect(rootAfter?.totpEnabled).toBe(true)
    expect(unsealTotpSecretWithKey(rootAfter!.totpSecretEnc!, OLD_SERVER_SECRET)).toBe(TOTP_BASE32_ROOT)
    expect(rootAfter?.totpLastStep).toBe(150)
    expect(await consumeTotpStep(handle.db, root.id, 150, sealedRoot)).toBe(false)
    expect((await findActiveSessionByTokenHash(handle.db, sha('sess-active')))?.id).toBe(activeSession.id)
    expect(await findActiveSessionByTokenHash(handle.db, sha('sess-revoked'))).toBeNull()
    expect((await findActiveApiTokenByHash(handle.db, sha('tok-active')))?.id).toBe(activeToken.id)
    expect(await findActiveApiTokenByHash(handle.db, sha('tok-revoked'))).toBeNull()
  })

  it('never fabricates principals or MFA state from hosting state during reindexFromState', async () => {
    const { handle } = await createFileDb()
    const snapshot = sampleHostingSnapshot()
    await reindexFromState(handle.db, snapshot)
    const rows = await handle.db.query<{ c: number }>(`SELECT count(*) AS c FROM principals`)
    expect(rows[0]?.c).toBe(0)
  })
})

describe('A25(b): identity authority backup, tamper verification, and watermarked restore', () => {
  it('restores identity DB from backup while preventing resurrection of post-backup revoked sessions, tokens, recovery codes, and TOTP steps', async () => {
    const primary = await createFileDb('primary.db')
    const backupDir = join(primary.dir, 'backup')
    const watermarkFile = join(primary.dir, 'watermark.json')

    const root = await createRootPrincipal(primary.handle.db, {
      username: 'root',
      passwordHash: ARGON2,
      forcePasswordChange: false,
    })
    const reseller = await createResellerPrincipal(primary.handle.db, {
      id: '11111111-1111-4111-8111-111111111111',
      username: 'partnerone',
      passwordHash: ARGON2,
    })

    const sealedRoot = sealTotpSecretWithKey(TOTP_BASE32_ROOT, OLD_SERVER_SECRET)
    const recUsedAfterBackup = sha('recovery-used-after-backup')
    const recUnused = sha('recovery-unused')
    await setTotpSecret(primary.handle.db, root.id, sealedRoot, [recUsedAfterBackup, recUnused])
    expect(await consumeTotpStep(primary.handle.db, root.id, 150, sealedRoot)).toBe(true)

    const sessKeep = await createSession(primary.handle.db, {
      principalId: root.id,
      tokenHash: sha('sess-keep'),
      expiresAt: futureIso(),
      mfaVerified: true,
    })
    const sessRevokeAfterBackup = await createSession(primary.handle.db, {
      principalId: root.id,
      tokenHash: sha('sess-revoke-later'),
      expiresAt: futureIso(),
      mfaVerified: true,
    })
    const sessAlreadyRevoked = await createSession(primary.handle.db, {
      principalId: root.id,
      tokenHash: sha('sess-already-revoked'),
      expiresAt: futureIso(),
      mfaVerified: true,
    })
    await revokeSession(primary.handle.db, sessAlreadyRevoked.id)

    const resellerSessBeforeReset = await createSession(primary.handle.db, {
      principalId: reseller.id,
      tokenHash: sha('reseller-sess-before-reset'),
      expiresAt: futureIso(),
      mfaVerified: false,
    })

    const tokKeep = await createApiToken(primary.handle.db, {
      principalId: root.id,
      name: 'keep-token',
      tokenHash: sha('tok-keep'),
      scopes: ['accounts:read'],
      expiresAt: futureIso(),
    })
    const tokRevokeAfterBackup = await createApiToken(primary.handle.db, {
      principalId: root.id,
      name: 'revoke-later-token',
      tokenHash: sha('tok-revoke-later'),
      scopes: ['*'],
      expiresAt: futureIso(),
    })
    const resellerTokBeforeReset = await createApiToken(primary.handle.db, {
      principalId: reseller.id,
      name: 'reseller-token',
      tokenHash: sha('reseller-tok-before-reset'),
      scopes: ['accounts:read'],
      expiresAt: futureIso(),
    })

    // 1. Create consistent identity authority backup at T1
    const manifest = await createIdentityAuthorityBackup(primary.handle.db, {
      backupDir,
      serverSecret: OLD_SERVER_SECRET,
    })
    expect(manifest.counts.principals).toBe(2)
    expect(manifest.counts.activeSessions).toBe(3)
    expect(manifest.counts.revokedSessions).toBe(1)
    expect(manifest.counts.activeApiTokens).toBe(3)
    expect(manifest.sealKeyFingerprint).toBe(computeSealKeyFingerprint(OLD_SERVER_SECRET))

    const verification = await verifyIdentityAuthorityBackup({
      backupDir,
      serverSecret: OLD_SERVER_SECRET,
    })
    expect(verification.ok).toBe(true)
    expect(verification.sealKeyStatus).toBe('verified')

    // 2. Perform post-backup mutations on primary DB before disaster:
    // - Revoke sessRevokeAfterBackup and tokRevokeAfterBackup
    // - Advance root TOTP step from 150 -> 155
    // - Consume recovery code recUsedAfterBackup
    // - Reset reseller password (which revokes resellerSessBeforeReset and resellerTokBeforeReset)
    await revokeSession(primary.handle.db, sessRevokeAfterBackup.id)
    await revokeApiToken(primary.handle.db, tokRevokeAfterBackup.id)
    expect(await consumeTotpStep(primary.handle.db, root.id, 155, sealedRoot)).toBe(true)
    expect(await consumeRecoveryHash(primary.handle.db, root.id, recUsedAfterBackup)).toBe(true)
    await setPasswordHash(primary.handle.db, reseller.id, ROTATED_ARGON2)

    const postMutationWatermark = await captureRevocationWatermark(primary.handle.db, {
      previousWatermark: manifest.watermark,
      watermarkPath: watermarkFile,
    })
    const loadedWatermark = await readRevocationWatermark(watermarkFile)
    expect(loadedWatermark.sha256).toBe(postMutationWatermark.sha256)
    expect(loadedWatermark.epoch).toBeGreaterThan(manifest.watermark.epoch)

    // 3. Simulate total loss of primary identity DB: open a replacement DB with hosting index populated
    await primary.handle.close()
    const replacement = await createFileDb('replacement.db')
    const snapshot = sampleHostingSnapshot()
    await reindexFromState(replacement.handle.db, snapshot)

    // 4. Restore identity authority from the T1 backup + monotonic revocation watermark
    const restoreResult = await restoreIdentityAuthorityBackup(replacement.handle.db, {
      backupDir,
      serverSecret: OLD_SERVER_SECRET,
      watermark: loadedWatermark,
    })
    expect(restoreResult.restoredPrincipals).toBe(2)
    expect(restoreResult.restoredActiveSessions).toBe(1) // Only sessKeep!
    expect(restoreResult.restoredRevokedSessions).toBe(3) // sessAlreadyRevoked + sessRevokeAfterBackup + resellerSessBeforeReset!
    expect(restoreResult.restoredActiveApiTokens).toBe(1) // Only tokKeep!
    expect(restoreResult.restoredRevokedApiTokens).toBe(2) // tokRevokeAfterBackup + resellerTokBeforeReset!

    // Hosting index in replacement DB is untouched
    expect((await listIndexedAccounts(replacement.handle.db)).map((a) => a.username)).toEqual(['tenantalpha'])

    // Active credentials that were never revoked still work
    expect((await findActiveSessionByTokenHash(replacement.handle.db, sha('sess-keep')))?.id).toBe(sessKeep.id)
    expect((await findActiveApiTokenByHash(replacement.handle.db, sha('tok-keep')))?.id).toBe(tokKeep.id)

    // Revoked sessions and tokens CANNOT resurrect even though they were active in the T1 backup!
    expect(await findActiveSessionByTokenHash(replacement.handle.db, sha('sess-already-revoked'))).toBeNull()
    expect(await findActiveSessionByTokenHash(replacement.handle.db, sha('sess-revoke-later'))).toBeNull()
    expect(await findActiveSessionByTokenHash(replacement.handle.db, sha('reseller-sess-before-reset'))).toBeNull()
    expect(await findActiveApiTokenByHash(replacement.handle.db, sha('tok-revoke-later'))).toBeNull()
    expect(await findActiveApiTokenByHash(replacement.handle.db, sha('reseller-tok-before-reset'))).toBeNull()
    expect(resellerSessBeforeReset.id).toBeDefined()
    expect(resellerTokBeforeReset.id).toBeDefined()

    // Consumed TOTP steps (<= 155) and consumed recovery code CANNOT be replayed after restore!
    expect(await consumeTotpStep(replacement.handle.db, root.id, 150, sealedRoot)).toBe(false)
    expect(await consumeTotpStep(replacement.handle.db, root.id, 155, sealedRoot)).toBe(false)
    expect(await consumeTotpStep(replacement.handle.db, root.id, 156, sealedRoot)).toBe(true)
    expect(await consumeRecoveryHash(replacement.handle.db, root.id, recUsedAfterBackup)).toBe(false)
    expect(await consumeRecoveryHash(replacement.handle.db, root.id, recUnused)).toBe(true)
    expect(await consumeRecoveryHash(replacement.handle.db, root.id, recUnused)).toBe(false)
  })

  it('rejects tampered backup manifests, tampered SQLite snapshots, and tampered watermarks before modifying target DB', async () => {
    const source = await createFileDb('source.db')
    const root = await createRootPrincipal(source.handle.db, { username: 'root', passwordHash: ARGON2 })
    const backupDir = join(source.dir, 'backup')
    await createIdentityAuthorityBackup(source.handle.db, { backupDir, serverSecret: OLD_SERVER_SECRET })

    const target = await createFileDb('target.db')
    const sentinel = await createRootPrincipal(target.handle.db, { username: 'root', passwordHash: ROTATED_ARGON2 })

    // Tamper with manifest JSON
    const manifestPath = join(backupDir, 'identity-manifest.json')
    const rawManifest = await readFile(manifestPath, 'utf8')
    await writeFile(manifestPath, rawManifest.replace('"principals": 1', '"principals": 99'), 'utf8')
    await expect(verifyIdentityAuthorityBackup({ backupDir })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(restoreIdentityAuthorityBackup(target.handle.db, { backupDir })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    })
    expect((await getPrincipal(target.handle.db, sentinel.id))?.passwordHash).toBe(ROTATED_ARGON2)
    await writeFile(manifestPath, rawManifest, 'utf8')

    // Tamper with snapshot SQLite file
    const snapshotPath = join(backupDir, 'identity-snapshot.db')
    const rawSnapshot = await readFile(snapshotPath)
    const corrupted = Buffer.from(rawSnapshot)
    corrupted[corrupted.byteLength - 1] = (corrupted[corrupted.byteLength - 1] ?? 0) ^ 0xff
    await writeFile(snapshotPath, corrupted)
    await expect(verifyIdentityAuthorityBackup({ backupDir })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await writeFile(snapshotPath, rawSnapshot)

    expect(root.id).toBeDefined()
  })
})

describe('A25(c): MFA sealing secret rotation and loss recovery drill', () => {
  it('rotates the MFA sealing secret atomically when the old secret is known, preserving replay barriers and revoking sessions/tokens', async () => {
    const { handle } = await createFileDb()
    const root = await createRootPrincipal(handle.db, { username: 'root', passwordHash: ARGON2 })
    const sealedOld = sealTotpSecretWithKey(TOTP_BASE32_ROOT, OLD_SERVER_SECRET)
    await setTotpSecret(handle.db, root.id, sealedOld, [sha('rec-a')])
    expect(await consumeTotpStep(handle.db, root.id, 220, sealedOld)).toBe(true)

    await createSession(handle.db, {
      principalId: root.id,
      tokenHash: sha('sess-before-rotate'),
      expiresAt: futureIso(),
      mfaVerified: true,
    })
    await createApiToken(handle.db, {
      principalId: root.id,
      name: 'tok-before-rotate',
      tokenHash: sha('tok-before-rotate'),
      scopes: ['*'],
      expiresAt: futureIso(),
    })

    const rotated = await rotateMfaSealKey(handle.db, {
      oldServerSecret: OLD_SERVER_SECRET,
      newServerSecret: NEW_SERVER_SECRET,
    })
    expect(rotated.rotatedPrincipals).toEqual([root.id])
    expect(rotated.revokedSessions).toBe(1)
    expect(rotated.revokedApiTokens).toBe(1)
    expect(rotated.sealKeyFingerprint).toBe(computeSealKeyFingerprint(NEW_SERVER_SECRET))

    const updated = (await getPrincipal(handle.db, root.id))!
    expect(updated.totpEnabled).toBe(true)
    expect(updated.totpLastStep).toBe(220)
    expect(updated.totpRecoveryHashes).toEqual([sha('rec-a')])
    expect(() => unsealTotpSecretWithKey(updated.totpSecretEnc!, OLD_SERVER_SECRET)).toThrow()
    expect(unsealTotpSecretWithKey(updated.totpSecretEnc!, NEW_SERVER_SECRET)).toBe(TOTP_BASE32_ROOT)
    expect(await findActiveSessionByTokenHash(handle.db, sha('sess-before-rotate'))).toBeNull()
    expect(await findActiveApiTokenByHash(handle.db, sha('tok-before-rotate'))).toBeNull()
  })

  it('handles loss of the MFA sealing secret by revoking sessions and tokens and clearing factors until the principal enrolls again', async () => {
    const { dir, handle } = await createFileDb()
    const root = await createRootPrincipal(handle.db, {
      username: 'root',
      passwordHash: ARGON2,
      forcePasswordChange: false,
    })
    const reseller = await createResellerPrincipal(handle.db, {
      username: 'partnerone',
      passwordHash: ARGON2,
    })
    const sealedRoot = sealTotpSecretWithKey(TOTP_BASE32_ROOT, OLD_SERVER_SECRET)
    const sealedReseller = sealTotpSecretWithKey(TOTP_BASE32_RESELLER, OLD_SERVER_SECRET)
    await setTotpSecret(handle.db, root.id, sealedRoot, [sha('root-rec')])
    await setTotpSecret(handle.db, reseller.id, sealedReseller, [sha('reseller-rec')])

    const rootSess = await createSession(handle.db, {
      principalId: root.id,
      tokenHash: sha('root-sess-active'),
      expiresAt: futureIso(),
      mfaVerified: true,
    })
    const rootRevokedSess = await createSession(handle.db, {
      principalId: root.id,
      tokenHash: sha('root-sess-revoked'),
      expiresAt: futureIso(),
      mfaVerified: true,
    })
    await revokeSession(handle.db, rootRevokedSess.id)
    await createApiToken(handle.db, {
      principalId: root.id,
      name: 'root-token',
      tokenHash: sha('root-tok-active'),
      scopes: ['*'],
      expiresAt: futureIso(),
    })

    await startTotpEnrollment(handle.db, {
      principalId: root.id,
      sessionId: rootSess.id,
      expectedPasswordHash: ARGON2,
      sealedSecret: sealTotpSecretWithKey(TOTP_BASE32_ROOT, OLD_SERVER_SECRET),
      recoveryHashes: [sha('pending-rec')],
    })

    const backupDir = join(dir, 'backup-before-key-loss')
    await createIdentityAuthorityBackup(handle.db, {
      backupDir,
      serverSecret: OLD_SERVER_SECRET,
    })

    // 1. Default verification / restore with NEW_SERVER_SECRET fails closed rather than silently breaking MFA
    await expect(
      verifyIdentityAuthorityBackup({ backupDir, serverSecret: NEW_SERVER_SECRET, requireMatchingSealKey: true }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    const checkOnly = await verifyIdentityAuthorityBackup({
      backupDir,
      serverSecret: NEW_SERVER_SECRET,
      requireMatchingSealKey: false,
    })
    expect(checkOnly.sealKeyStatus).toBe('mismatch')
    expect(checkOnly.unsealablePrincipalIds.sort()).toEqual([root.id, reseller.id].sort())

    // 2. Explicit live recovery from MFA seal-key loss
    const recovery = await recoverFromMfaSealKeyLoss(handle.db, {
      newServerSecret: NEW_SERVER_SECRET,
      actor: 'cli:root',
    })
    expect(recovery.recoveredPrincipals.sort()).toEqual([root.id, reseller.id].sort())
    expect(recovery.revokedSessions).toBe(1) // Only the 1 active session; the already-revoked session stays revoked
    expect(recovery.revokedApiTokens).toBe(1)
    expect(recovery.clearedPendingEnrollments).toBe(1)
    expect(recovery.mfaReenrollmentRequired).toBe(true)

    const rootAfter = (await getPrincipal(handle.db, root.id))!
    expect(rootAfter.totpEnabled).toBe(false)
    expect(rootAfter.totpSecretEnc).toBeNull()
    expect(rootAfter.totpRecoveryHashes).toEqual([])
    expect(rootAfter.totpLastStep).toBeNull()
    expect(await getPendingTotpEnrollment(handle.db, root.id, rootSess.id)).toBeNull()
    expect(await findActiveSessionByTokenHash(handle.db, sha('root-sess-active'))).toBeNull()
    expect(await findActiveSessionByTokenHash(handle.db, sha('root-sess-revoked'))).toBeNull()
    expect(await findActiveApiTokenByHash(handle.db, sha('root-tok-active'))).toBeNull()

    // 3. Also test restoreIdentityAuthorityBackup with explicit onSealKeyMismatch: 'reset-mfa'
    const replacement = await createFileDb('replacement-after-key-loss.db')
    const restoredWithReset = await restoreIdentityAuthorityBackup(replacement.handle.db, {
      backupDir,
      serverSecret: NEW_SERVER_SECRET,
      onSealKeyMismatch: 'reset-mfa',
    })
    expect(restoredWithReset.mfaResetPrincipalIds.sort()).toEqual([root.id, reseller.id].sort())
    expect(restoredWithReset.restoredActiveSessions).toBe(0)
    expect(restoredWithReset.restoredRevokedSessions).toBe(2)
    expect(restoredWithReset.restoredActiveApiTokens).toBe(0)
    expect(restoredWithReset.restoredRevokedApiTokens).toBe(1)
    expect((await getPrincipal(replacement.handle.db, root.id))?.totpEnabled).toBe(false)
    expect(await findActiveSessionByTokenHash(replacement.handle.db, sha('root-sess-active'))).toBeNull()
    expect(await findActiveApiTokenByHash(replacement.handle.db, sha('root-tok-active'))).toBeNull()
  })

  it('rolls back MFA seal-key recovery or restore completely if session/token revocation or audit fails', async () => {
    const { handle } = await createFileDb()
    const root = await createRootPrincipal(handle.db, { username: 'root', passwordHash: ARGON2 })
    const sealedRoot = sealTotpSecretWithKey(TOTP_BASE32_ROOT, OLD_SERVER_SECRET)
    await setTotpSecret(handle.db, root.id, sealedRoot, [sha('root-rec')])
    const session = await createSession(handle.db, {
      principalId: root.id,
      tokenHash: sha('root-sess'),
      expiresAt: futureIso(),
      mfaVerified: true,
    })

    await handle.db.exec(`
      CREATE TRIGGER reject_recovery_audit BEFORE INSERT ON audit_log
      WHEN NEW.action = 'auth.mfa_seal_key_loss_recovered'
      BEGIN SELECT RAISE(ABORT, 'Audit failure during MFA seal key recovery'); END
    `)

    await expect(
      recoverFromMfaSealKeyLoss(handle.db, { newServerSecret: NEW_SERVER_SECRET }),
    ).rejects.toBeDefined()

    // Principal MFA state and active session are untouched after rollback
    const unchanged = (await getPrincipal(handle.db, root.id))!
    expect(unchanged.totpEnabled).toBe(true)
    expect(unchanged.totpSecretEnc).toEqual(sealedRoot)
    expect((await findActiveSessionByTokenHash(handle.db, sha('root-sess')))?.id).toBe(session.id)
    expect(randomUUID()).toBeDefined()
  })

  it('keeps a live session that shares the principal password timestamp', async () => {
    const source = await createFileDb('same-ms.db')
    const root = await createRootPrincipal(source.handle.db, {
      username: 'root',
      passwordHash: ARGON2,
      forcePasswordChange: false,
    })
    const session = await createSession(source.handle.db, {
      principalId: root.id,
      tokenHash: sha('same-ms-session'),
      expiresAt: futureIso(),
      mfaVerified: true,
    })
    const stamp = '2026-10-23T18:00:00.000Z'
    await source.handle.db.query(`UPDATE principals SET password_changed_at = $1 WHERE id = $2`, [stamp, root.id])
    await source.handle.db.query(`UPDATE sessions SET created_at = $1 WHERE id = $2`, [stamp, session.id])
    const backupDir = join(source.dir, 'backup')
    const manifest = await createIdentityAuthorityBackup(source.handle.db, {
      backupDir,
      serverSecret: OLD_SERVER_SECRET,
    })
    expect(manifest.watermark.principals[root.id]?.revokedAllBefore).toBeNull()
    const replacement = await createFileDb('same-ms-restore.db')
    const restored = await restoreIdentityAuthorityBackup(replacement.handle.db, {
      backupDir,
      serverSecret: OLD_SERVER_SECRET,
    })
    expect(restored.restoredActiveSessions).toBe(1)
    expect((await findActiveSessionByTokenHash(replacement.handle.db, sha('same-ms-session')))?.id).toBe(session.id)
  })
})
