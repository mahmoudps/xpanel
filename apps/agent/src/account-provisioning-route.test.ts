import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultPlan } from '@xpanel/core'
import { acquireJobLease, activate, createGeneration, createRootPrincipal, createTestDb, enqueueDurableJob, initializeOperationalMetadata, markTested, saveJobCheckpoint, type TestDbHandle } from '@xpanel/db'
import { profileFor } from '@xpanel/os'
import { createTestStateStore, type TestStateStoreHandle } from '@xpanel/state'
import { canonicalProvisioningIdentity, type ProvisioningAuthority, type ProvisioningReconcileReply } from '../../../packages/core/src/account-provisioning-contract.ts'
import { accountSliceCgroupPath } from '../../../packages/render/src/system/slice.ts'
import type { AgentAccountProvisioningRuntime, VerifiedPreparationMetadata } from './account-provisioning-handler.ts'
import { FakeHostExecutor, LinuxHostExecutor } from './executor.ts'
import { HostReconciler, type ReconcileResult } from './reconciler.ts'
import { bindVerifiedRequestPeer, createAgentApp, type AgentServerDeps } from './server.ts'

// H only: synthetic peer context and execution receipt exercise the actual app
// admission/dispatch. They do not qualify kernel peer credentials or host work.
const TOKEN = 'a'.repeat(64)
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNo'
const API_UID = 19700
const API_GID = 19701
const os = profileFor('ID=ubuntu\nVERSION_ID="24.04"\n')

describe('real Agent account provisioning route admission (H)', () => {
  let state: TestStateStoreHandle
  let db: TestDbHandle
  let authority: ProvisioningAuthority
  let metadata: VerifiedPreparationMetadata
  let receipt: ProvisioningReconcileReply<ReconcileResult>
  let reconciler: HostReconciler
  let executor: LinuxHostExecutor
  let runtime: AgentAccountProvisioningRuntime
  const readPreparation = vi.fn<AgentAccountProvisioningRuntime['readPreparation']>()
  const execute = vi.fn<AgentAccountProvisioningRuntime['execute']>()

  beforeAll(async () => {
    state = await createTestStateStore()
    db = await createTestDb()
    await initializeOperationalMetadata(db.db)
    const principal = await createRootPrincipal(db.db, { username: 'root', passwordHash: HASH })
    const features = await state.store.createFeatureList({ name: 'Route fixture', ownerId: null, disabled: [] })
    const { id: ignoredPlanId, ...settings } = defaultPlan({ id: randomUUID(), name: 'Route fixture', featureListId: features.id })
    void ignoredPlanId
    const plan = await state.store.createPlan(settings)
    await state.store.saveServerIp({ address: '203.0.113.10', version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
    const account = await state.store.createAccount({ username: 'tenant', passwordHash: HASH, primaryDomain: 'tenant.example.test', planId: plan.id, ownerId: null,
      contactEmail: 'ops@example.test', ipv4: '203.0.113.10', shell: 'jailed', php: { version: '8.3', handler: 'fpm',
        fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 500, processIdleTimeoutSec: 10 }, ini: {} } })
    const zone = { id: randomUUID(), name: account.primaryDomain, accountId: account.id, serial: 2026103001, records: [] }
    await state.store.saveDnsZone(zone)
    const savedZone = await state.store.getDnsZone(account.primaryDomain)
    if (!savedZone) throw new Error('fixture zone unavailable')
    const snapshot = await state.store.readSnapshot()
    const revision = snapshot.revision
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) throw new Error('fixture revision unavailable')
    const preparationReference = randomUUID(), preparationIdentity = 'c'.repeat(64)
    const operationKey = 'account.provision:v3:' + 'd'.repeat(64)
    const job = await enqueueDurableJob(db.db, { kind: 'account.provision', actor: 'root:root', summary: 'Route fixture', idempotencyKey: operationKey })
    const lease = await acquireJobLease(db.db, { jobId: job.id, workerId: 'route-worker', leaseDurationMs: 60_000 })
    if (!lease?.leaseExpiresAt) throw new Error('fixture lease unavailable')
    const checkpoint = { accountId: account.id, username: account.username, uid: account.uid, gid: account.gid, home: account.home,
      primaryDomain: account.primaryDomain, planId: account.planId, ownerId: account.ownerId, preparationReference, preparationIdentity,
      desiredZoneIdentity: canonicalProvisioningIdentity(savedZone), hostAttempt: lease.attempt, hostNoEffectAttempt: null }
    for (const step of ['reserve_and_create_state', 'ensure_principal_and_zone', 'reconcile_host_intent']) {
      await saveJobCheckpoint(db.db, { jobId: job.id, workerId: 'route-worker', fencingToken: lease.fencingToken, step, data: checkpoint })
    }
    authority = { actor: { id: principal.id, kind: 'root', username: principal.username },
      account: { id: account.id, username: account.username, ownerId: account.ownerId, planId: account.planId, uid: account.uid, gid: account.gid, home: account.home, primaryDomain: account.primaryDomain },
      operation: { id: job.id, workerId: 'route-worker', fencingToken: lease.fencingToken, leaseExpiresAt: lease.leaseExpiresAt, requestFingerprint: job.requestFingerprint },
      desired: { revision, checksum: snapshot.checksum, preparationReference, preparationIdentity } }
    metadata = { reference: preparationReference, actorKey: 'root:' + principal.id, operationKey, requestIdentity: 'e'.repeat(64), preparationIdentity,
      desiredStateDigest: 'f'.repeat(64), planIdentity: canonicalProvisioningIdentity(plan), phase: 'complete' }
    const generation = await createGeneration(db.db, { checksum: 'b'.repeat(64), actor: 'route-fixture' })
    await markTested(db.db, generation.id)
    const active = await activate(db.db, generation.id)
    const cgroup = accountSliceCgroupPath(account.uid)
    receipt = { binding: canonicalProvisioningIdentity(authority), outcome: 'known', reconciliation: { status: 'noop', generation: active, stateChecksum: snapshot.checksum },
      execution: { accountId: account.id, uid: account.uid, gid: account.gid, home: account.home, revision, generationId: active.id,
        generationChecksum: active.checksum, sourceChecksum: snapshot.checksum, cgroup, services: ['nginx.service'], quota: { enforced: true, filesystem: '/home' },
        dns: { zone: account.primaryDomain, serial: zone.serial, authoritative: true }, php: { status: 200, uid: account.uid, cgroup } } }
    reconciler = new HostReconciler({ store: state.store, db: db.db, executor: new FakeHostExecutor(), os })
    vi.spyOn(reconciler, 'reconcile').mockRejectedValue(new Error('no generic reconciliation fallback in this fixture'))
    executor = new LinuxHostExecutor()
    for (const method of ['runCommand', 'runAction', 'writeFile', 'removePath'] as const) vi.spyOn(executor, method).mockRejectedValue(new Error('H fixture must not execute host effects'))
    readPreparation.mockResolvedValue(metadata)
    runtime = { readPreparation, execute }
    execute.mockImplementation(async (_input, context) => { await context.assertAuthority(); return receipt })
  })
  afterAll(async () => { await state?.close(); await db?.close() })
  beforeEach(() => { readPreparation.mockClear(); execute.mockClear() })

  const app = (overrides: Partial<AgentServerDeps> = {}) => createAgentApp({ store: state.store, db: db.db, reconciler, executor, accountProvisioning: runtime,
    os: { id: os.id, versionId: os.versionId, family: os.family }, agentToken: TOKEN, expectedPeerUid: API_UID, allowRootPeer: false,
    // This unused store prevents native benchmark initialization in the H fixture.
    benchmarkStore: {} as NonNullable<AgentServerDeps['benchmarkStore']>, ...overrides })
  const request = (options: { peer?: 'allowed' | 'outsider' | 'missing'; token?: string; principalId?: string; body?: ProvisioningAuthority } = {}) => {
    const body = options.body ?? authority
    const req = new Request('http://agent.local/host/account-provisioning', { method: 'POST', headers: {
      'x-xpanel-agent-token': options.token ?? TOKEN, 'x-xpanel-principal-id': options.principalId ?? authority.actor.id,
      'x-xpanel-peer-uid': String(API_UID), 'x-xpanel-role': 'root', 'content-type': 'application/json',
    }, body: JSON.stringify({ authority: body, binding: canonicalProvisioningIdentity(body) }) })
    if (options.peer !== 'missing') bindVerifiedRequestPeer(req, { peer: { uid: options.peer === 'outsider' ? API_UID + 1 : API_UID, gid: API_GID, pid: 12345 },
      allowedPeerUids: new Set([API_UID]), credentialSource: 'SO_PEERCRED' })
    return req
  }

  it('does not accept a forged peer header without its trusted listener context', async () => {
    expect((await app().fetch(request({ peer: 'missing' }))).status).toBe(412)
    expect(execute).not.toHaveBeenCalled()
  })
  it('rejects an outside peer before runtime dispatch', async () => {
    expect((await app().fetch(request({ peer: 'outsider' }))).status).toBe(403)
    expect(execute).not.toHaveBeenCalled()
  })
  it('requires both the service credential and the persisted principal', async () => {
    expect((await app().fetch(request({ token: 'b'.repeat(64) }))).status).toBe(401)
    expect((await app().fetch(request({ principalId: randomUUID() }))).status).toBe(401)
    expect(execute).not.toHaveBeenCalled()
  })
  it('reports a missing trusted runtime without executing the generic reconciler', async () => {
    const response = await app({ accountProvisioning: undefined }).fetch(request())
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ code: 'SERVICE_UNAVAILABLE', status: 503,
      details: { stateChanged: false, reason: 'account_provisioning_runtime_unavailable' } })
    expect(reconciler.reconcile).not.toHaveBeenCalled()
    expect(readPreparation).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })
  it('does not turn a simulated executor into native admission', async () => {
    const simulatedExecutor = new FakeHostExecutor()
    const hostEffects = (['runCommand', 'runAction', 'writeFile', 'removePath'] as const).map(method => vi.spyOn(simulatedExecutor, method))
    const response = await app({ executor: simulatedExecutor }).fetch(request())
    expect(response.status).toBe(412)
    expect(await response.json()).toMatchObject({ code: 'PRECONDITION_FAILED', status: 412,
      details: { stateChanged: false, reason: 'linux_host_executor_required' } })
    expect(reconciler.reconcile).not.toHaveBeenCalled()
    expect(readPreparation).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    for (const effect of hostEffects) expect(effect).not.toHaveBeenCalled()
  })
  it.runIf(process.platform === 'linux')('dispatches the actual Linux route through admission to the synthetic trusted runtime (H only)', async () => {
    const response = await app().fetch(request())
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({ binding: receipt.binding, outcome: 'known' })
    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ actor: authority.actor, scope: { accountId: authority.account.id, resellerId: null } })
    expect(reconciler.reconcile).not.toHaveBeenCalled()
  })
  it.runIf(process.platform === 'linux')('rejects body actor and stale fence claims on the actual mounted route', async () => {
    expect((await app().fetch(request({ body: { ...authority, actor: { ...authority.actor, id: randomUUID() } } }))).status).toBe(403)
    expect((await app().fetch(request({ body: { ...authority, operation: { ...authority.operation, fencingToken: authority.operation.fencingToken + 1 } } }))).status).toBe(409)
    expect(execute).not.toHaveBeenCalled()
  })
})
