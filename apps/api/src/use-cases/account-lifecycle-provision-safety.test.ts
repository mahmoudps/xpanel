import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostReconciler, ReconcileResult } from '@xpanel/agent'
import { XpanelError, type Account, type Principal } from '@xpanel/core'
import type { Db, DurableJobRecord } from '@xpanel/db'
import type { StateStore } from '@xpanel/state'
import { AccountLifecycleCoordinator, isFreshProvisioningHostEffect, type ProvisionAccountInput } from './account-lifecycle.ts'
import { canonicalProvisioningIdentity } from './account-provisioning-port.ts'
import { preparedAccountZone, provisioningRequestKey } from './account-provisioning-prepared.ts'
import { createAuthenticatedProvisioningPort } from './account-provisioning-transport.ts'

const dbPort = vi.hoisted(() => ({
  enqueue: vi.fn(), lease: vi.fn(), complete: vi.fn(), checkpoint: vi.fn(), principal: vi.fn(),
  createPrincipal: vi.fn(), reindex: vi.fn(), audit: vi.fn(),
  getJob: vi.fn(), renew: vi.fn(),
}))
vi.mock('@xpanel/db', async importOriginal => ({
  ...await importOriginal<typeof import('@xpanel/db')>(),
  enqueueDurableJob: dbPort.enqueue, acquireJobLease: dbPort.lease,
  completeJobWithLease: dbPort.complete, saveJobCheckpoint: dbPort.checkpoint,
  findPrincipalByAccountId: dbPort.principal, createUserPrincipal: dbPort.createPrincipal,
  reindexFromState: dbPort.reindex, appendAudit: dbPort.audit,
  getDurableJob: dbPort.getJob,
  renewJobLease: dbPort.renew,
}))

const root: Principal = { id: 'root-id', kind: 'root', username: 'root' }
const account = (): Account => ({ id: 'account-id', username: 'tenant', uid: 20000, gid: 20000, home: '/home/tenant', primaryDomain: 'tenant.example.test', planId: 'plan-id', ownerId: null, status: 'active', suspendReason: null, contactEmail: 'ops@example.test', ipv4: '203.0.113.10', shell: 'jailed', createdAt: '2026-10-29T00:00:00Z' })
const input = (): ProvisionAccountInput => ({ actor: root, username: 'tenant', primaryDomain: 'tenant.example.test', planId: 'plan-id', ownerId: null, contactEmail: 'ops@example.test', ipv4: '203.0.113.10', shell: 'jailed', passwordHash: 'opaque-credential-input', php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 1, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 500, processIdleTimeoutSec: 10 }, ini: {} }, provisionDefaultZone: false })
const checkpoint = () => ({ accountId: 'account-id', username: 'tenant', uid: 20000, primaryDomain: 'tenant.example.test', planId: 'plan-id', ownerId: null })
const job = (extra: Partial<DurableJobRecord> = {}): DurableJobRecord => ({ id: 'job-id', kind: 'account.provision', accountId: null, actor: 'root', status: 'running', progress: 0, summary: '', detail: {}, error: null, logPath: null, createdAt: '', startedAt: null, finishedAt: null, updatedAt: '', idempotencyKey: 'key', requestFingerprint: '', targetRevision: null, leaseOwner: 'worker', fencingToken: 1, leaseExpiresAt: null, attempt: 1, maxAttempts: 5, checkpointStep: null, checkpointData: {}, completedSteps: [], cancelRequested: false, cancelReason: null, failureClass: null, needsAttention: false, referenceCode: null, ...extra })

const harness = () => {
  const store = { getAccountByUsername: vi.fn(async () => null as Account | null), createAccount: vi.fn(async () => account()),
    getAccount: vi.fn(async () => account()), getReseller: vi.fn(async () => ({ id: 'reseller-id', acl: ['create-account'] })),
    getDnsZone: vi.fn(), saveDnsZone: vi.fn(), readSnapshot: vi.fn(async () => ({})) }
  const reconcile = vi.fn(async (): Promise<ReconcileResult> => ({ status: 'noop', generation: null, stateChecksum: 'state' }))
  const coordinator = new AccountLifecycleCoordinator({ store: store as unknown as StateStore, db: {} as Db,
    reconciler: { reconcile } as unknown as HostReconciler, workerId: 'worker' })
  return { store, reconcile, coordinator }
}

beforeEach(() => {
  vi.resetAllMocks()
  dbPort.enqueue.mockResolvedValue({ ...job(), deduplicated: false })
  dbPort.lease.mockImplementation(async (_db: Db, input: { workerId: string }) => job({ leaseOwner: input.workerId, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() }))
  dbPort.renew.mockImplementation(async (_db: Db, input: { workerId: string; fencingToken: number }) => job({ leaseOwner: input.workerId, fencingToken: input.fencingToken, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() }))
  dbPort.principal.mockResolvedValue({ id: 'principal-id' })
  dbPort.checkpoint.mockImplementation(async (_db: Db, cp: { step: string; data: Record<string, unknown> }) => job({ checkpointData: cp.data, completedSteps: [cp.step] }))
  dbPort.complete.mockResolvedValue(job({ status: 'succeeded' }))
})

describe('provisioning identity and uncertain host effects', () => {
  it('blocks a prior unacknowledged host-start checkpoint instead of replaying native work', async () => {
    const h = harness()
    dbPort.lease.mockResolvedValue(job({ checkpointData: { ...checkpoint(), hostAttempt: 1, hostNoEffectAttempt: null }, completedSteps: ['reserve_and_create_state', 'reconcile_host_intent'] }))
    await expect(h.coordinator.provisionAccount(input())).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { verificationRequired: true } })
    expect(h.reconcile).not.toHaveBeenCalled()
    expect(dbPort.complete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ failureClass: 'unknown_outcome', needsAttention: true, requeueOnRetryable: false }))
  })
  it('does not acknowledge host success after losing the database lease', async () => {
    const h = harness()
    dbPort.renew.mockImplementation(async (_db: Db, authority: { workerId: string }) => {
      if (h.reconcile.mock.calls.length) throw new Error('lease lost after host response')
      return job({ leaseOwner: authority.workerId, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() })
    })
    await expect(h.coordinator.provisionAccount(input())).rejects.toMatchObject({ detail: { verificationRequired: true } })
    expect(h.reconcile).toHaveBeenCalledTimes(1)
    expect(dbPort.complete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ failureClass: 'unknown_outcome', needsAttention: true }))
  })
  it('rejects a reseller adopting another owner account even when the requested owner is itself', async () => {
    const h = harness()
    h.store.getAccountByUsername.mockResolvedValue({ ...account(), ownerId: 'other-reseller' })
    const reseller: Principal = { id: 'reseller-id', kind: 'reseller', username: 'seller' }
    await expect(h.coordinator.provisionAccount({ ...input(), actor: reseller, ownerId: reseller.id })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(dbPort.principal).not.toHaveBeenCalled()
    expect(h.store.createAccount).not.toHaveBeenCalled()
    expect(h.reconcile).not.toHaveBeenCalled()
  })

  it('refuses to adopt an existing username without a durable account checkpoint', async () => {
    const h = harness()
    h.store.getAccountByUsername.mockResolvedValue(account())
    await expect(h.coordinator.provisionAccount(input())).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(h.store.createAccount).not.toHaveBeenCalled()
    expect(dbPort.createPrincipal).not.toHaveBeenCalled()
    expect(h.store.saveDnsZone).not.toHaveBeenCalled()
    expect(h.reconcile).not.toHaveBeenCalled()
    expect(dbPort.complete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ failureClass: 'permanent', requeueOnRetryable: false }))
  })

  it('keeps an uncheckpointed account on a replay for recovery review without auto-requeue', async () => {
    const h = harness()
    h.store.getAccountByUsername.mockResolvedValue(account())
    dbPort.enqueue.mockResolvedValue({ ...job(), deduplicated: true })
    await expect(h.coordinator.provisionAccount(input())).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(dbPort.complete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ failureClass: 'unknown_outcome', needsAttention: true, requeueOnRetryable: false }))
    expect(h.store.createAccount).not.toHaveBeenCalled()
    expect(h.reconcile).not.toHaveBeenCalled()
  })

  it('rechecks account identity on succeeded-job replay rather than returning a substituted account', async () => {
    const h = harness()
    h.store.getAccount.mockResolvedValue({ ...account(), uid: 20001 })
    dbPort.enqueue.mockResolvedValue({ ...job({ status: 'succeeded', checkpointData: checkpoint() }), deduplicated: true })
    await expect(h.coordinator.provisionAccount(input())).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(dbPort.lease).not.toHaveBeenCalled()
    expect(h.reconcile).not.toHaveBeenCalled()
  })

  it('reauthorizes the current owner on a completed-job replay after ownership transfer', async () => {
    const h = harness()
    const reseller: Principal = { id: 'reseller-id', kind: 'reseller', username: 'seller' }
    h.store.getAccount.mockResolvedValue({ ...account(), ownerId: 'other-reseller' })
    dbPort.enqueue.mockResolvedValue({ ...job({ status: 'succeeded', checkpointData: { ...checkpoint(), ownerId: reseller.id } }), deduplicated: true })
    await expect(h.coordinator.provisionAccount({ ...input(), actor: reseller, ownerId: reseller.id })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(dbPort.lease).not.toHaveBeenCalled()
    expect(h.reconcile).not.toHaveBeenCalled()
  })

  it('rechecks ownership on a resumed job before principal or host operations', async () => {
    const h = harness()
    h.store.getAccount.mockResolvedValue({ ...account(), ownerId: 'new-owner' })
    dbPort.lease.mockResolvedValue(job({ checkpointData: checkpoint(), completedSteps: ['reserve_and_create_state'] }))
    await expect(h.coordinator.provisionAccount(input())).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(dbPort.principal).not.toHaveBeenCalled()
    expect(h.reconcile).not.toHaveBeenCalled()
  })

  it('does not retry when host reconciliation throws after entry', async () => {
    const h = harness()
    h.reconcile.mockRejectedValue(new Error('lost response after applying host state'))
    await expect(h.coordinator.provisionAccount(input())).rejects.toThrow('lost response')
    expect(dbPort.complete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ failureClass: 'unknown_outcome', needsAttention: true, requeueOnRetryable: false }))
  })

  it('does not treat an unreadable post-create identity as a proved absent account', async () => {
    const h = harness()
    h.store.getAccountByUsername.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('identity lookup unavailable'))
    h.store.createAccount.mockRejectedValue(new Error('creation acknowledgement lost'))
    await expect(h.coordinator.provisionAccount(input())).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: true, verificationRequired: true } })
    expect(dbPort.complete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ failureClass: 'unknown_outcome', requeueOnRetryable: false }))
    expect(h.reconcile).not.toHaveBeenCalled()
  })

  it('keeps a proved no-effect config rejection distinct from an uncertain host outcome', async () => {
    const h = harness()
    h.reconcile.mockResolvedValue({ status: 'failed', generation: {} as never, failedTest: 'syntax', error: 'rejected', stateChanged: false })
    await expect(h.coordinator.provisionAccount(input())).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: true, hostStateChanged: false } })
    expect(dbPort.complete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ failureClass: 'retryable', needsAttention: false, requeueOnRetryable: true }))
  })

  it('retains an attention requirement even when file rollback completed', async () => {
    const h = harness()
    h.reconcile.mockResolvedValue({ status: 'failed', generation: {} as never, failedTest: 'reload', error: 'rejected', rolledBack: true, verificationRequired: true })
    await expect(h.coordinator.provisionAccount(input())).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(dbPort.complete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ failureClass: 'unknown_outcome', needsAttention: true }))
  })

  it('requires a connected host provider unless desired-state-only provisioning was explicitly requested', async () => {
    const h = harness()
    const coordinator = new AccountLifecycleCoordinator({ store: h.store as unknown as StateStore, db: {} as Db })
    await expect(coordinator.provisionAccount(input())).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: false } })
    expect(dbPort.enqueue).not.toHaveBeenCalled()
    expect(h.store.createAccount).not.toHaveBeenCalled()
  })

  it('refuses legacy fingerprints explicitly without creating, leasing or retrying an old job', async () => {
    const h = harness()
    dbPort.enqueue.mockRejectedValue(new XpanelError('CONFLICT', 'idempotency key already used with different request parameters', { existingJobId: 'old-job' }))
    dbPort.getJob.mockResolvedValue(job({ actor: 'root:root', detail: {}, checkpointData: checkpoint() }))
    await expect(h.coordinator.provisionAccount(input())).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: {
      reason: 'legacy_provisioning_identity_unverifiable', stateChanged: false, verificationRequired: true,
    } })
    expect(dbPort.lease).not.toHaveBeenCalled()
    expect(dbPort.complete).not.toHaveBeenCalled()
    expect(h.store.createAccount).not.toHaveBeenCalled()
    expect(h.reconcile).not.toHaveBeenCalled()
  })

  it('keeps a changed versioned request as a conflict without treating it as legacy recovery', async () => {
    const h = harness()
    dbPort.enqueue.mockRejectedValue(new XpanelError('CONFLICT', 'idempotency key already used with different request parameters', { existingJobId: 'current-job' }))
    dbPort.getJob.mockResolvedValue(job({ actor: 'root:root', detail: { provisioningFingerprintVersion: 2 } }))
    await expect(h.coordinator.provisionAccount(input())).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(dbPort.lease).not.toHaveBeenCalled()
    expect(h.store.createAccount).not.toHaveBeenCalled()
  })

  it('binds operational and credential inputs without putting credentials in job detail', async () => {
    const h = harness()
    const fingerprints: string[] = []
    dbPort.enqueue.mockImplementation(async (_db: Db, request: { requestFingerprint: string; detail: unknown }) => {
      fingerprints.push(request.requestFingerprint)
      expect(JSON.stringify(request.detail)).not.toContain('opaque-credential-input')
      throw new Error('stop after recording request identity')
    })
    const original = input()
    for (const variant of [original, { ...original, nameservers: ['ns.changed.example.test'] }, { ...original, homeBase: '/srv/hosting' },
      { ...original, passwordHash: 'different-opaque-credential-input' }, { ...original, reconcile: false }]) {
      await expect(h.coordinator.provisionAccount(variant)).rejects.toThrow('stop after recording request identity')
    }
    expect(new Set(fingerprints).size).toBe(5)
    expect(fingerprints.every(value => /^[a-f0-9]{64}$/.test(value))).toBe(true)
  })

  it('does not report a completed replay with null reconciliation as a new host effect', async () => {
    const h = harness()
    dbPort.enqueue.mockResolvedValue({ ...job({ status: 'succeeded', checkpointData: checkpoint(), completedSteps: ['reserve_and_create_state', 'ensure_principal_and_zone', 'reconcile_host', 'finalize_index_and_audit'] }), deduplicated: true })
    const result = await h.coordinator.provisionAccount(input())
    expect(result.reconciliation).toBeNull()
    expect(result.execution).toBeUndefined()
    expect(isFreshProvisioningHostEffect(result)).toBe(false)
    expect(h.reconcile).not.toHaveBeenCalled()
    expect(dbPort.lease).not.toHaveBeenCalled()
  })

  it('rejects a stale fence even when the renewed lease expiration is still valid', async () => {
    const h = harness()
    dbPort.lease.mockResolvedValue(job({ leaseOwner: 'worker', fencingToken: 4, leaseExpiresAt: '2020-01-01T00:00:00.000Z' }))
    dbPort.renew.mockResolvedValue(job({ leaseOwner: 'worker', fencingToken: 9, leaseExpiresAt: '2099-01-01T00:00:00.000Z' }))
    await expect(h.coordinator.provisionAccount(input())).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(h.reconcile).not.toHaveBeenCalled()
    expect(h.store.createAccount).not.toHaveBeenCalled()
  })

  it('keeps a renewed lease when the fence is unchanged', async () => {
    const h = harness()
    dbPort.lease.mockResolvedValue(job({ leaseOwner: 'worker', fencingToken: 4, leaseExpiresAt: '2020-01-01T00:00:00.000Z' }))
    dbPort.renew.mockResolvedValue(job({ leaseOwner: 'worker', fencingToken: 4, leaseExpiresAt: '2099-01-01T00:00:00.000Z' }))
    await h.coordinator.provisionAccount(input())
    expect(h.reconcile).toHaveBeenCalledTimes(1)
  })

  it('does not checkpoint a null reconciliation as a new host effect', async () => {
    const h = harness()
    h.reconcile.mockResolvedValue(null as never)
    await expect(h.coordinator.provisionAccount(input())).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED', detail: { freshExecution: false, verificationRequired: true },
    })
    expect(h.reconcile).toHaveBeenCalledTimes(1)
    expect(dbPort.checkpoint.mock.calls.map(call => call[1].step)).not.toContain('reconcile_host')
  })
})

describe('prepared account provisioning', () => {
  const storedHash = 'stored-prepared-credential-hash'
  const nameservers = ['ns1.xpanel.internal', 'ns2.xpanel.internal']
  const plan = { id: 'plan-id', name: 'basic', ownerId: null, featureListId: 'feature-list', resources: { diskMb: 1 }, caps: {}, dedicatedIp: false, shell: 'jailed' as const, defaultMailboxQuotaMb: 0 }
  const accountFields = () => ({ username: 'tenant', primaryDomain: 'tenant.example.test', planId: 'plan-id', ownerId: null as null, contactEmail: 'ops@example.test', ipv4: '203.0.113.10', shell: 'jailed' as const, php: input().php })
  const prepared = () => {
    const accountInput = accountFields()
    const desiredState = { account: accountInput, sourceRevision: 2, operationKey: provisioningRequestKey(root, 'retry-key'), planIdentity: canonicalProvisioningIdentity(plan), template: null, nameservers, serial: 2026103001 }
    return { reference: '55555555-5555-4555-8555-555555555555', requestIdentity: canonicalProvisioningIdentity(accountInput), passwordHash: storedHash, desiredState }
  }
  const preparedHarness = () => {
    const record = prepared()
    let savedZone: unknown = null
    const store = {
      getAccountByUsername: vi.fn(async () => null as ReturnType<typeof account> | null),
      createAccount: vi.fn(async () => account()),
      getAccount: vi.fn(async () => account()),
      getReseller: vi.fn(async () => ({ id: 'reseller-id', acl: ['create-account'] })),
      getDnsZone: vi.fn(async () => savedZone),
      saveDnsZone: vi.fn(async (zone: unknown) => { savedZone = zone }),
      readSnapshot: vi.fn(async () => ({ checksum: 'b'.repeat(64), revision: 8 })),
      getPlan: vi.fn(async () => plan),
      getServerSettings: vi.fn(async () => ({ nameservers })),
      getRevision: vi.fn(async () => 8),
    }
    const reconcile = vi.fn(async (request: { authority: { operation: { fencingToken: number; leaseExpiresAt: string } } }) => {
      void request
      return { binding: 'unused', outcome: 'known' as const, reconciliation: null }
    })
    const coordinator = new AccountLifecycleCoordinator({
      store: store as unknown as StateStore, db: {} as Db, workerId: 'worker',
      provisioningPort: { reconcile } as never, authorizeProvisioning: async () => undefined,
      preparations: { prepare: vi.fn(), load: vi.fn(async () => record) } as never,
      readAccountTemplates: async () => null,
    })
    return { store, reconcile, coordinator, record }
  }

  it('reuses the prepared credential hash and does not run host effects when the checkpoint is not saved', async () => {
    const h = preparedHarness()
    dbPort.checkpoint.mockRejectedValueOnce(new Error('checkpoint lost'))
    await expect(h.coordinator.provisionPreparedAccount({ actor: root, idempotencyKey: 'retry-key', preparationReference: h.record.reference })).rejects.toThrow('checkpoint lost')
    expect(h.store.createAccount).toHaveBeenCalledWith(expect.objectContaining({ passwordHash: storedHash }), expect.anything())
    const recorded = dbPort.enqueue.mock.calls[0] as [unknown, { detail?: unknown }] | undefined
    expect(JSON.stringify(recorded?.[1]?.detail)).not.toContain(storedHash)
    expect(dbPort.createPrincipal).not.toHaveBeenCalled()
    expect(h.reconcile).not.toHaveBeenCalled()
  })

  it('does not repeat host effects while an intent checkpoint has no acknowledged outcome', async () => {
    const h = preparedHarness()
    dbPort.lease.mockResolvedValue(job({
      checkpointData: { ...checkpoint(), preparationReference: h.record.reference, preparationIdentity: canonicalProvisioningIdentity(h.record.desiredState), hostAttempt: 1, hostNoEffectAttempt: null },
      completedSteps: ['reserve_and_create_state', 'ensure_principal_and_zone', 'reconcile_host_intent'],
    }))
    await expect(h.coordinator.provisionPreparedAccount({ actor: root, idempotencyKey: 'retry-key', preparationReference: h.record.reference })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED', detail: { verificationRequired: true },
    })
    expect(h.store.createAccount).not.toHaveBeenCalled()
    expect(h.reconcile).not.toHaveBeenCalled()
  })

  it('returns a completed prepared replay with null reconciliation and does not execute the host again', async () => {
    const h = preparedHarness()
    dbPort.enqueue.mockResolvedValue({ ...job({ status: 'succeeded', checkpointData: checkpoint(), completedSteps: ['reserve_and_create_state', 'ensure_principal_and_zone', 'reconcile_host', 'finalize_index_and_audit'] }), deduplicated: true })
    const result = await h.coordinator.provisionPreparedAccount({ actor: root, idempotencyKey: 'retry-key', preparationReference: h.record.reference })
    expect(result.reconciliation).toBeNull()
    expect(result.execution).toBeUndefined()
    expect(isFreshProvisioningHostEffect(result)).toBe(false)
    expect(h.reconcile).not.toHaveBeenCalled()
    expect(h.store.createAccount).not.toHaveBeenCalled()
    expect(dbPort.lease).not.toHaveBeenCalled()
  })

  it('sends the current renewed lease and does not accept a null reconciliation as a host effect', async () => {
    const h = preparedHarness()
    const hosted = { ...account(), id: '22222222-2222-4222-8222-222222222222' }
    h.store.getAccount.mockResolvedValue(hosted)
    const zone = preparedAccountZone(h.record, hosted)
    h.store.getDnsZone.mockResolvedValue(zone)
    dbPort.principal.mockResolvedValue({ id: '33333333-3333-4333-8333-333333333333', kind: 'user', username: 'tenant', accountId: hosted.id, passwordHash: storedHash })
    dbPort.lease.mockResolvedValue(job({
      leaseOwner: 'worker', fencingToken: 4, leaseExpiresAt: '2020-01-01T00:00:00.000Z',
      checkpointData: {
        ...checkpoint(), accountId: hosted.id, gid: 20000, home: '/home/tenant', preparationReference: h.record.reference,
        preparationIdentity: canonicalProvisioningIdentity(h.record.desiredState), desiredZoneIdentity: canonicalProvisioningIdentity(zone),
      },
      completedSteps: ['reserve_and_create_state', 'ensure_principal_and_zone'],
    }))
    dbPort.renew.mockResolvedValue(job({ leaseOwner: 'worker', fencingToken: 4, leaseExpiresAt: '2099-01-01T00:00:00.000Z' }))
    dbPort.checkpoint.mockImplementation(async (_db: Db, cp: { step: string; data: Record<string, unknown>; fencingToken: number }) => job({
      fencingToken: cp.fencingToken, leaseOwner: 'worker', leaseExpiresAt: '2099-01-01T00:00:00.000Z', checkpointData: cp.data, completedSteps: [cp.step],
    }))
    await expect(h.coordinator.provisionPreparedAccount({ actor: root, idempotencyKey: 'retry-key', preparationReference: h.record.reference })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED', detail: { freshExecution: false, verificationRequired: true },
    })
    expect(h.reconcile).toHaveBeenCalledTimes(1)
    expect(h.reconcile.mock.calls[0]?.[0].authority.operation).toMatchObject({ fencingToken: 4, leaseExpiresAt: '2099-01-01T00:00:00.000Z' })
    expect(h.store.createAccount).not.toHaveBeenCalled()
    expect(dbPort.createPrincipal).not.toHaveBeenCalled()
    expect(dbPort.checkpoint.mock.calls.map(call => call[1].step)).not.toContain('reconcile_host')
  })

  it('sends the trusted principal id and refuses to call the agent when that id is omitted', async () => {
    const token = 'a'.repeat(64)
    const actorId = '11111111-1111-4111-8111-111111111111'
    const sent: Request[] = []
    const port = createAuthenticatedProvisioningPort({
      token, fetch: async request => { sent.push(request); return new Response(null, { status: 503 }) },
    })
    const trusted = { actor: { id: actorId, kind: 'root', username: 'root' }, marker: 'trusted-actor' }
    await expect(port.reconcile({ authority: trusted as never, binding: canonicalProvisioningIdentity(trusted) }, {
      signal: AbortSignal.timeout(1_000), assertAuthority: async () => undefined,
    })).rejects.toThrow()
    expect(sent[0]?.headers.get('x-xpanel-principal-id')).toBe(actorId)
    const omitted = { actor: { id: '', kind: 'root', username: 'root' }, marker: 'missing-principal' }
    const calls = sent.length
    await expect(port.reconcile({ authority: omitted as never, binding: canonicalProvisioningIdentity(omitted) }, {
      signal: AbortSignal.timeout(1_000), assertAuthority: async () => { throw new Error('authority refreshed') },
    })).rejects.toMatchObject({ code: 'UNAUTHENTICATED', detail: { stateChanged: false } })
    expect(sent).toHaveLength(calls)
  })
})
