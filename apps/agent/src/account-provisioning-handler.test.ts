import { describe, expect, it, vi } from 'vitest'
import type { Account, Plan } from '@xpanel/core'
import {
  assertProvisioningReply,
  canonicalProvisioningIdentity,
  type ProvisioningAuthority,
  type ProvisioningReconcileReply,
} from '../../../packages/core/src/account-provisioning-contract.ts'
import {
  handleAccountProvisioning,
  type AccountProvisioningReadPorts,
  type AgentAccountProvisioningRuntime,
  type ProvisioningJobView,
  type VerifiedPreparationMetadata,
} from './account-provisioning-handler.ts'
import { LinuxHostExecutor } from './executor.ts'

const principalId = '11111111-1111-4111-8111-111111111111'
const accountId = '22222222-2222-4222-8222-222222222222'
const planId = '33333333-3333-4333-8333-333333333333'
const jobId = '44444444-4444-4444-8444-444444444444'
const preparationReference = '55555555-5555-4555-8555-555555555555'
const otherPrincipalId = '99999999-9999-4999-8999-999999999999'
const checksum = 'b'.repeat(64)
const preparationIdentity = 'c'.repeat(64)
const fingerprint = 'a'.repeat(64)
const digest = 'd'.repeat(64)
const generationChecksum = 'e'.repeat(64)
const operationKey = `account.provision:v3:${'f'.repeat(64)}`
const renewedLease = '2099-01-01T00:00:00.000Z'
const previousLease = '2020-01-01T00:00:00.000Z'
const cgroup = 'user-20000.slice'

const plan: Plan = {
  id: planId, name: 'basic', ownerId: null, featureListId: '77777777-7777-4777-8777-777777777777',
  resources: { diskMb: 1024, bandwidthMbMonth: 1024, ioReadBps: 1024, ioWriteBps: 1024, ioReadIops: 100, ioWriteIops: 100, memoryMb: 256, maxProcesses: 20, cpuPercent: 20 },
  caps: { addonDomains: 0, aliasDomains: 0, subdomains: 0, mailboxes: 1, forwarders: 0, mailingLists: 0, ftpAccounts: 0, databases: 1, phpWorkers: 1 },
  dedicatedIp: false, shell: 'jailed', defaultMailboxQuotaMb: 256,
}
const zone = {
  id: '66666666-6666-4666-8666-666666666666', accountId, name: 'tenant.example.test', serial: 2026103001, records: [],
}
const storedAccount: Account = {
  id: accountId, username: 'tenant', uid: 20000, gid: 20000, home: '/home/tenant', primaryDomain: 'tenant.example.test',
  planId, ownerId: null, status: 'active', suspendReason: null, contactEmail: 'ops@example.test', ipv4: '203.0.113.10',
  shell: 'jailed', createdAt: '2026-10-29T00:00:00.000Z',
}
const principal = { id: principalId, kind: 'root' as const, username: 'root', disabled: false }
const metadata: VerifiedPreparationMetadata = {
  reference: preparationReference, actorKey: `root:${principalId}`, operationKey, requestIdentity: '1'.repeat(64),
  preparationIdentity, desiredStateDigest: digest, planIdentity: canonicalProvisioningIdentity(plan), phase: 'complete',
}

const authority = (): ProvisioningAuthority => ({
  actor: { id: principalId, kind: 'root', username: 'root' },
  account: {
    id: accountId, username: 'tenant', ownerId: null, planId, uid: 20000, gid: 20000, home: '/home/tenant',
    primaryDomain: 'tenant.example.test',
  },
  operation: { id: jobId, workerId: 'worker-7', fencingToken: 4, leaseExpiresAt: previousLease, requestFingerprint: fingerprint },
  desired: { revision: 8, checksum, preparationReference, preparationIdentity },
})

const job = (fencingToken = 4): ProvisioningJobView => ({
  id: jobId, kind: 'account.provision', accountId: null, actor: 'root:root', status: 'running', leaseOwner: 'worker-7',
  fencingToken, leaseExpiresAt: renewedLease, requestFingerprint: fingerprint, idempotencyKey: operationKey, attempt: 2,
  cancelRequested: false, needsAttention: false,
  completedSteps: ['reserve_and_create_state', 'ensure_principal_and_zone', 'reconcile_host_intent'],
  checkpointData: {
    accountId, username: 'tenant', uid: 20000, gid: 20000, home: '/home/tenant', primaryDomain: 'tenant.example.test',
    planId, ownerId: null, preparationReference, preparationIdentity, desiredZoneIdentity: canonicalProvisioningIdentity(zone),
    hostAttempt: 2, hostNoEffectAttempt: null,
  },
})

const acceptedReply = (body: ProvisioningAuthority, binding: string): ProvisioningReconcileReply => {
  const reply = {
    binding, outcome: 'known' as const,
    reconciliation: { status: 'noop', generation: { id: 3, checksum: generationChecksum, status: 'active' }, stateChecksum: checksum },
    execution: {
      accountId, uid: 20000, gid: 20000, home: '/home/tenant', revision: 8, generationId: 3, generationChecksum,
      sourceChecksum: checksum, cgroup, services: ['php-fpm'], quota: { enforced: true, filesystem: '/home' },
      dns: { zone: 'tenant.example.test', serial: 2026103001, authoritative: true }, php: { status: 200 as const, uid: 20000, cgroup },
    },
  } as ProvisioningReconcileReply
  assertProvisioningReply({ authority: body, binding }, reply)
  return reply
}

const scene = () => {
  const body = authority()
  const binding = canonicalProvisioningIdentity(body)
  const reply = acceptedReply(body, binding)
  const readPreparation = vi.fn(async () => ({ ...metadata, passwordHash: 'stored-prepared-credential-hash' }) as VerifiedPreparationMetadata)
  const execute = vi.fn(async (input: {
    actor: { id: string; kind: string; username: string }
    account: Account
    scope: { accountId: string; resellerId: string | null }
    request: { binding: string }
  }) => {
    void input
    return reply
  })
  const runtime: AgentAccountProvisioningRuntime = { readPreparation, execute }
  const ports = {
    getPrincipal: vi.fn(async (id: string) => id === principalId ? principal : null),
    getDurableJob: vi.fn(async () => job()),
    getAccount: vi.fn(async () => storedAccount),
    readSnapshot: vi.fn(async () => ({ checksum, revision: 8 })),
    getDnsZone: vi.fn(async () => zone),
    getPlan: vi.fn(async () => plan),
    getReseller: vi.fn(async () => null),
  }
  function call(id?: string | null, url = 'http://agent.local/host/account-provisioning') {
    return handleAccountProvisioning({
    principalId: arguments.length === 0 ? principalId : id, runtime, executor: new LinuxHostExecutor(), ports: ports as AccountProvisioningReadPorts,
    request: new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authority: body, binding }) }),
    })
  }
  return { runtime, readPreparation, execute, ports, call, binding, reply }
}

describe('account provisioning admission', () => {
  it('refuses when the trusted principal id is omitted and does not read the body actor', async () => {
    const { readPreparation, execute, ports, call } = scene()
    await expect(call(undefined)).rejects.toMatchObject({ code: 'UNAUTHENTICATED', detail: { stateChanged: false } })
    expect(ports.getPrincipal).not.toHaveBeenCalled()
    expect(readPreparation).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('uses the trusted principal id rather than the body actor', async () => {
    const { execute, ports, call } = scene()
    await expect(call(otherPrincipalId)).rejects.toMatchObject({ code: 'UNAUTHENTICATED', detail: { stateChanged: false } })
    expect(ports.getPrincipal).toHaveBeenCalledTimes(1)
    expect(ports.getPrincipal).toHaveBeenCalledWith(otherPrincipalId)
    expect(ports.getPrincipal).not.toHaveBeenCalledWith(principalId)
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects a body actor that does not match the loaded principal', async () => {
    const { execute, ports, call } = scene()
    ports.getPrincipal.mockResolvedValue({ ...principal, username: 'operator' })
    await expect(call()).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { stateChanged: false } })
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects a stale fence even when the saved lease expiration is current', async () => {
    const { readPreparation, execute, ports, call } = scene()
    ports.getDurableJob.mockResolvedValue(job(9))
    await expect(call()).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    expect(readPreparation).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('accepts a renewed lease expiration when the fence and owner are unchanged', async () => {
    const { execute, call, binding } = scene()
    expect(authority().operation.leaseExpiresAt).not.toBe(renewedLease)
    const response = await call()
    expect(response.status).toBe(200)
    const body = await response.json() as { reconciliation: { status: string } | null; execution: { accountId: string } }
    expect(body.reconciliation).not.toBeNull()
    expect(body.reconciliation?.status).toBe('noop')
    expect(JSON.stringify(body)).not.toContain('stored-prepared-credential-hash')
    expect(execute).toHaveBeenCalledTimes(1)
    const execution = execute.mock.calls[0]?.[0]
    expect(execution?.actor).toMatchObject({ id: principalId, kind: 'root', username: 'root' })
    expect(execution?.account.contactEmail).toBe('ops@example.test')
    expect(execution?.scope).toEqual({ accountId, resellerId: null })
    expect(execution?.request.binding).toBe(binding)
  })

  it('does not report a null reconciliation as a new host effect', async () => {
    const { execute, call } = scene()
    execute.mockResolvedValue({ binding: canonicalProvisioningIdentity(authority()), outcome: 'known', reconciliation: null } as never)
    await expect(call()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED', detail: { freshExecution: false, verificationRequired: true },
    })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('refuses a missing runtime before preparation or host effects', async () => {
    const { ports, binding } = scene()
    const body = authority()
    await expect(handleAccountProvisioning({
      principalId, runtime: undefined, executor: new LinuxHostExecutor(), ports: ports as AccountProvisioningReadPorts,
      request: new Request('http://agent.local/host/account-provisioning', {
        method: 'POST', body: JSON.stringify({ authority: body, binding }),
      }),
    })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: false, reason: 'account_provisioning_runtime_unavailable' } })
    expect(ports.getPrincipal).not.toHaveBeenCalled()
  })

  it('refuses when the executor is not the native Linux host executor', async () => {
    const { runtime, readPreparation, execute, ports, binding } = scene()
    const body = authority()
    await expect(handleAccountProvisioning({
      principalId, runtime, executor: { runCommand: async () => undefined }, ports: ports as AccountProvisioningReadPorts,
      request: new Request('http://agent.local/host/account-provisioning', {
        method: 'POST', body: JSON.stringify({ authority: body, binding }),
      }),
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false, reason: 'linux_host_executor_required' } })
    expect(readPreparation).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('does not execute host effects without the intent checkpoint', async () => {
    const { execute, ports, call } = scene()
    ports.getDurableJob.mockResolvedValue({ ...job(), completedSteps: ['reserve_and_create_state'] })
    await expect(call()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    expect(execute).not.toHaveBeenCalled()
  })

  it('does not treat a completed host checkpoint as a fresh execution', async () => {
    const { execute, ports, call } = scene()
    ports.getDurableJob.mockResolvedValue({ ...job(), completedSteps: [...job().completedSteps, 'reconcile_host'] })
    await expect(call()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { freshExecution: false, stateChanged: false } })
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects query selectors before host effects', async () => {
    const { execute, call } = scene()
    await expect(call(principalId, 'http://agent.local/host/account-provisioning?force=1')).rejects.toMatchObject({
      code: 'VALIDATION', detail: { stateChanged: false },
    })
    expect(execute).not.toHaveBeenCalled()
  })

  it('does not start a second host effect for the same fence', async () => {
    const { execute, call, reply } = scene()
    let release: (value: ProvisioningReconcileReply) => void = () => undefined
    let entered: () => void = () => undefined
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<ProvisioningReconcileReply>(resolve => { release = resolve })
    execute.mockImplementation(() => { entered(); return gate })
    const first = call()
    await started
    await expect(call()).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    expect(execute).toHaveBeenCalledTimes(1)
    release(reply)
    expect((await first).status).toBe(200)
  })
})
