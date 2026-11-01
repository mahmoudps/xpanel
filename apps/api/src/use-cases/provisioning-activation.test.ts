import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertProvisioningAuthorization, defaultPlan, type Account, type Principal } from '@xpanel/core'
import { createProvisioningCheckpointObservation, parseProvisioningCheckpointObservation } from '../../../../packages/core/src/account-provisioning-contract.ts'
import { acquireJobLease, activate, createApiToken, createGeneration, createRootPrincipal, createTestDb, createUserPrincipal,
  enqueueDurableJob, findActiveApiTokenByHash, findActiveSessionByTokenHash, findPrincipalByAccountId, getDurableJob,
  getPrincipal, markTested, saveJobCheckpoint, type Db } from '@xpanel/db'
import type { StateStore } from '@xpanel/state'
import { canonicalProvisioningIdentity, type AccountExecutionObservation, type ProvisioningAuthority } from './account-provisioning-port.ts'
import { provisioningRequestKey, type PreparedAccountRecord } from './account-provisioning-prepared.ts'
import { activatePreparedProvisioningPrincipal } from './provisioning-activation.ts'

const PHC = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const closing: (() => Promise<void>)[] = []
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const close of closing.splice(0).reverse()) await close() })
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

/** Real admitted SQLite transactions; StateStore/host observations are isolated ports, not Linux evidence. */
const fixture = async () => {
  const handle = await createTestDb(); closing.push(() => handle.close())
  const db = handle.db, root = await createRootPrincipal(db, { username: 'operator', passwordHash: PHC, forcePasswordChange: false })
  const actor: Principal = { kind: 'root', id: root.id, username: root.username }
  const account: Account = { id: randomUUID(), username: 'tenant', uid: 20000, gid: 20000, home: '/home/tenant', primaryDomain: 'tenant.example.test',
    planId: randomUUID(), ownerId: null, status: 'active', suspendReason: null, contactEmail: 'owner@example.test', ipv4: '192.0.2.20', shell: 'jailed', createdAt: new Date().toISOString() }
  const plan = defaultPlan({ id: account.planId, featureListId: randomUUID(), name: 'Activation fixture' })
  const principal = await createUserPrincipal(db, { username: account.username, accountId: account.id, passwordHash: PHC, disabled: true })
  const tokenHash = createHash('sha256').update('activation-test-only-token').digest('hex')
  const token = await createApiToken(db, { principalId: actor.id, name: 'Activation fixture', tokenHash, scopes: ['accounts:write'], expiresAt: new Date(Date.now() + 3600_000).toISOString() })
  const prepared: PreparedAccountRecord = { reference: randomUUID(), requestIdentity: '1'.repeat(64), passwordHash: PHC, desiredState: {
    account: { username: account.username, primaryDomain: account.primaryDomain, planId: plan.id, ownerId: null, contactEmail: account.contactEmail,
      ipv4: account.ipv4, shell: account.shell, php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 1, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 100, processIdleTimeoutSec: 10 }, ini: {} } },
    sourceRevision: 7, operationKey: provisioningRequestKey(actor, 'activation-fixture'), planIdentity: canonicalProvisioningIdentity(plan), template: null,
    nameservers: [], serial: 2026103001, authorizationRef: { kind: 'api-token', principalId: actor.id, tokenId: token.id, tokenHash, clientIp: '192.0.2.30', scope: 'accounts:write' },
  } }
  const created = await createGeneration(db, { checksum: 'a'.repeat(64), actor: 'activation-fixture' })
  await markTested(db, created.id); const generation = await activate(db, created.id)
  const queued = await enqueueDurableJob(db, { kind: 'account.provision', actor: 'root:operator', summary: 'Activation fixture',
    idempotencyKey: prepared.desiredState.operationKey, requestFingerprint: 'd'.repeat(64), detail: {} })
  const leased = (await acquireJobLease(db, { jobId: queued.id, workerId: 'activation-worker', leaseDurationMs: 60_000 }))!
  const authority: ProvisioningAuthority = { actor, account: { id: account.id, username: account.username, ownerId: null, planId: plan.id, uid: account.uid, gid: account.gid, home: account.home, primaryDomain: account.primaryDomain },
    operation: { id: leased.id, workerId: 'activation-worker', fencingToken: leased.fencingToken, leaseExpiresAt: leased.leaseExpiresAt!, requestFingerprint: leased.requestFingerprint },
    desired: { revision: 7, checksum: 'b'.repeat(64), preparationReference: prepared.reference, preparationIdentity: canonicalProvisioningIdentity(prepared.desiredState) } }
  const proof: AccountExecutionObservation = { accountId: account.id, uid: account.uid, gid: account.gid, home: account.home, revision: 7,
    generationId: generation.id, generationChecksum: generation.checksum, sourceChecksum: authority.desired.checksum, cgroup: 'user-20000.slice',
    services: ['fixture.service'], quota: { enforced: true, filesystem: '/fixture-filesystem' }, dns: { zone: account.primaryDomain, serial: 2026103001, authoritative: true }, php: { status: 200, uid: account.uid, cgroup: 'user-20000.slice' } }
  const checkpoint = { accountId: account.id, username: account.username, uid: account.uid, gid: account.gid, home: account.home,
    primaryDomain: account.primaryDomain, planId: plan.id, ownerId: null, principalId: principal.id, generationId: generation.id,
    preparationReference: prepared.reference, preparationIdentity: authority.desired.preparationIdentity,
    observedContext: createProvisioningCheckpointObservation({ authority, binding: canonicalProvisioningIdentity(authority) }, proof) }
  for (const step of ['reserve_and_create_state', 'ensure_principal_and_zone', 'reconcile_host', 'principal_activation_intent']) {
    await saveJobCheckpoint(db, { jobId: leased.id, workerId: 'activation-worker', fencingToken: leased.fencingToken, step, data: checkpoint })
  }
  let held = false, revision = 7
  const lease = { assertFencingToken: vi.fn(async () => ({ revision })), release: vi.fn(async () => { held = false }) }
  const store = { getWriterLock: () => ({ acquire: async () => { held = true; return lease } }),
    readSnapshot: vi.fn(async () => { if (held) throw new Error('a public snapshot may not re-enter the held writer barrier'); return { revision, checksum: proof.sourceChecksum } }),
    getPlan: async () => plan, getServerSettings: async () => ({ nameservers: [] }), getAccount: async () => account,
  } as unknown as StateStore
  const input: Parameters<typeof activatePreparedProvisioningPrincipal>[0] = { db, store, actor, account, prepared,
    jobId: leased.id, workerId: 'activation-worker', fencingToken: leased.fencingToken, requestFingerprint: leased.requestFingerprint,
    expectedActor: leased.actor, principalId: principal.id, proof, recordedAuthority: authority, recordedExecution: proof,
    readTemplates: async () => null, authorizeCredential: (tx, value) => assertProvisioningAuthorization({ ...value, policy: { mode: 'optional' },
      ports: { principal: id => getPrincipal(tx, id), session: hash => findActiveSessionByTokenHash(tx, hash), apiToken: hash => findActiveApiTokenByHash(tx, hash), whmcs: async () => null } }) }
  return { db, actor, principal, account, token, input, lease, setRevision: (next: number) => { revision = next } }
}

const queuedActivation = async (f: Awaited<ReturnType<typeof fixture>>, duringWriter: (tx: Db) => Promise<void>) => {
  const entered = deferred(), release = deferred(), enqueued = deferred()
  const writer = f.db.transaction(async tx => { entered.resolve(); await release.promise; await duringWriter(tx) })
  await entered.promise
  // Only the transaction runner is usable inside the callback; an accidental outer-runner query fails this fixture.
  const runner: Db = { query: async () => { throw new Error('activation used the queued outer query runner') },
    exec: async () => { throw new Error('activation used the queued outer script runner') },
    transaction: <T>(work: (tx: Db) => Promise<T>) => { enqueued.resolve(); return f.db.transaction(work) } }
  const outcome = activatePreparedProvisioningPrincipal({ ...f.input, db: runner }).then(() => ({ ok: true as const }), error => ({ ok: false as const, error }))
  const reachedQueue = await Promise.race([enqueued.promise.then(() => true), outcome.then(() => false)])
  if (!reachedQueue) { release.resolve(); await writer; throw new Error('activation refused before the intended DB queue boundary') }
  return { release, writer, outcome }
}

describe('prepared principal activation at admitted transaction authority', { tags: ['feature'] }, () => {
  it('enables only the bound disabled principal with current source/generation/job/credential authority', async () => {
    const f = await fixture()
    const persisted = (await getDurableJob(f.db, f.input.jobId))!.checkpointData
    expect(parseProvisioningCheckpointObservation(persisted.observedContext)).toEqual({
      request: { authority: f.input.recordedAuthority, binding: canonicalProvisioningIdentity(f.input.recordedAuthority) }, execution: f.input.recordedExecution,
    })
    expect(JSON.stringify(persisted)).not.toContain('[REDACTED]')
    await activatePreparedProvisioningPrincipal(f.input)
    expect(await findPrincipalByAccountId(f.db, f.account.id)).toMatchObject({ id: f.principal.id, disabled: false })
    expect(f.lease.release).toHaveBeenCalledOnce()
    expect((await getDurableJob(f.db, f.input.jobId))!.status).toBe('running')
  })

  it('samples lease time after the queued writer instead of enabling from a pre-queue clock', async () => {
    const f = await fixture(), held = await queuedActivation(f, async () => {})
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse(f.input.recordedAuthority.operation.leaseExpiresAt) + 1)
    held.release.resolve(); await held.writer
    const outcome = await held.outcome
    expect(outcome).toMatchObject({ ok: false, error: { code: 'PRECONDITION_FAILED' } })
    expect(await findPrincipalByAccountId(f.db, f.account.id)).toMatchObject({ disabled: true })
  })

  it('refuses legacy redacted checkpoints instead of inferring an original proof from current job fields', async () => {
    const f = await fixture()
    await saveJobCheckpoint(f.db, { jobId: f.input.jobId, workerId: f.input.workerId, fencingToken: f.input.fencingToken,
      step: 'principal_activation_intent', data: { observedContext: null, observedAuthority: f.input.recordedAuthority, observedExecution: f.input.recordedExecution } })
    expect((await getDurableJob(f.db, f.input.jobId))!.checkpointData.observedAuthority).toBe('[REDACTED]')
    await expect(activatePreparedProvisioningPrincipal(f.input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(await findPrincipalByAccountId(f.db, f.account.id)).toMatchObject({ disabled: true })
  })

  it('observes original token revocation committed by the queued writer and never enables sign-in', async () => {
    const f = await fixture(), held = await queuedActivation(f, tx => tx.query('UPDATE api_tokens SET revoked_at = $1 WHERE id = $2', [new Date().toISOString(), f.token.id]).then(() => {}))
    held.release.resolve(); await held.writer
    expect(await held.outcome).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await findPrincipalByAccountId(f.db, f.account.id)).toMatchObject({ disabled: true })
  })

  it('rejects a source epoch that changes between the snapshot and admitted activation', async () => {
    const f = await fixture(), held = await queuedActivation(f, async () => { f.setRevision(8) })
    held.release.resolve(); await held.writer
    expect(await held.outcome).toMatchObject({ ok: false, error: { code: 'PRECONDITION_FAILED' } })
    expect(await findPrincipalByAccountId(f.db, f.account.id)).toMatchObject({ disabled: true })
  })

  it('refuses a job rebound to a different account by the queued writer', async () => {
    const f = await fixture(), held = await queuedActivation(f, tx => tx.query('UPDATE jobs SET account_id = $1 WHERE id = $2', [randomUUID(), f.input.jobId]).then(() => {}))
    held.release.resolve(); await held.writer
    expect(await held.outcome).toMatchObject({ ok: false, error: { code: 'PRECONDITION_FAILED' } })
    expect(await findPrincipalByAccountId(f.db, f.account.id)).toMatchObject({ disabled: true })
  })

  it('does not activate against a different active generation', async () => {
    const f = await fixture(), other = await createGeneration(f.db, { checksum: 'e'.repeat(64) })
    await markTested(f.db, other.id); await activate(f.db, other.id)
    await expect(activatePreparedProvisioningPrincipal(f.input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(await findPrincipalByAccountId(f.db, f.account.id)).toMatchObject({ disabled: true })
  })

  it('rolls back the enable if authority expires before the activation transaction commits', async () => {
    const f = await fixture(), original = f.input.authorizeCredential
    let checks = 0
    f.input.authorizeCredential = async (tx, value) => {
      if (++checks === 2) { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse(f.token.expiresAt) + 1) }
      await original(tx, value)
    }
    await expect(activatePreparedProvisioningPrincipal(f.input)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await findPrincipalByAccountId(f.db, f.account.id)).toMatchObject({ disabled: true })
  })
})
