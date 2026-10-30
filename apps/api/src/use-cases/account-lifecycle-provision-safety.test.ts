import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostReconciler, ReconcileResult } from '@xpanel/agent'
import { XpanelError, type Account, type Principal } from '@xpanel/core'
import type { Db, DurableJobRecord } from '@xpanel/db'
import type { StateStore } from '@xpanel/state'
import { AccountLifecycleCoordinator, type ProvisionAccountInput } from './account-lifecycle.ts'

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
})
