import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { FakeHostExecutor, type HostReconciler, type AgentApp } from '@xpanel/agent'
import { fail } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { ApiServerDeps } from '../server.ts'
import { parseProvisioningReconcileRequest } from '../use-cases/account-provisioning-port.ts'
import type { PrepareProvisioningInput, PreparedProvisioning, ProvisioningPreparationStore } from '../use-cases/provisioning-preparation.ts'

/** H-layer memory adapter only: no POSIX ownership/HMAC or native workload qualification. */
export const memoryPreparations = (store: StateStore): ProvisioningPreparationStore => {
  const records = new Map<string, { actor: string; value: PreparedProvisioning<unknown> }>()
  const requests = new Map<string, string>()
  const locked = async <T>(work: () => Promise<T>): Promise<T> => {
    const lease = await store.getWriterLock().acquire()
    try { await lease.assertFencingToken(); const result = await work(); await lease.assertFencingToken(); return result } finally { await lease.release() }
  }
  return {
    async prepare<T>(input: PrepareProvisioningInput<T>): Promise<PreparedProvisioning<T>> {
      return locked(async () => {
        const key = JSON.stringify([input.actorKey, input.idempotencyKey]), existing = requests.get(key)
        if (existing) {
          const saved = records.get(existing)!.value
          if (saved.requestIdentity !== input.requestIdentity || !await input.verifyCredentialIntent(input.credentialIntent, saved.passwordHash)) fail('CONFLICT', 'the fixture request changed', { stateChanged: false })
          return saved as PreparedProvisioning<T>
        }
        const desiredState = await input.prepareDesiredState(), passwordHash = await input.preparePasswordHash()
        if (!await input.verifyCredentialIntent(input.credentialIntent, passwordHash)) fail('CONFLICT', 'the fixture credential changed', { stateChanged: false })
        const value = { reference: randomUUID(), requestIdentity: input.requestIdentity, desiredState: structuredClone(desiredState), passwordHash }
        records.set(value.reference, { actor: input.actorKey, value }); requests.set(key, value.reference)
        return value
      })
    },
    async load<T>(reference: string, actor: string): Promise<PreparedProvisioning<T>> {
      return locked(async () => {
        const saved = records.get(reference)
        if (!saved || saved.actor !== actor) return fail('FORBIDDEN', 'the fixture preparation is unavailable')
        return saved.value as PreparedProvisioning<T>
      })
    },
  }
}

/**
 * Explicit API protocol fixture. Configuration generations come from the existing
 * HostReconciler/FakeHostExecutor; the bounded execution receipt is synthetic H data,
 * never an independent PHP/UID/cgroup observation or a production readiness claim.
 * Default production preparation, transport, authorization and activation stay intact.
 */
export function preparedAccountFixture(input: {
  store: StateStore
  reconciler: HostReconciler
  executor: FakeHostExecutor
  agentApp: AgentApp
  agentToken: string
  onProvision?: () => void
}): Pick<ApiServerDeps, 'provisioningPreparations' | 'agentApp'> {
  assert.ok(input.executor instanceof FakeHostExecutor, 'This fixture requires the explicit fake executor')
  return {
    provisioningPreparations: memoryPreparations(input.store),
    agentApp: {
      subscribe: listener => input.agentApp.subscribe(listener),
      fetch: async request => {
        if (new URL(request.url).pathname !== '/host/account-provisioning') return input.agentApp.fetch(request)
        if (request.method !== 'POST') return new Response(null, { status: 405 })
        const rpc = parseProvisioningReconcileRequest(await request.json())
        if (request.headers.get('x-xpanel-agent-token') !== input.agentToken
          || request.headers.get('x-xpanel-principal-id') !== rpc.authority.actor.id) {
          return Response.json({ error: 'Synthetic service authentication refused' }, { status: 403 })
        }
        const a = rpc.authority.account, d = rpc.authority.desired
        const account = await input.store.getAccount(a.id)
        assert.ok(account, 'Prepared account must already exist in the real test StateStore')
        assert.deepEqual({ id: account.id, username: account.username, ownerId: account.ownerId, planId: account.planId,
          uid: account.uid, gid: account.gid, home: account.home, primaryDomain: account.primaryDomain }, a)
        request.signal.throwIfAborted()
        input.onProvision?.()
        const reconciliation = await input.reconciler.reconcile({
          actor: rpc.authority.actor.kind + ':' + rpc.authority.actor.username,
          scope: { accountId: a.id, resellerId: account.ownerId }, expectedState: { revision: d.revision, checksum: d.checksum },
        })
        request.signal.throwIfAborted()
        if (reconciliation.status === 'failed') return Response.json({ binding: rpc.binding, outcome: 'known', reconciliation })
        const generation = reconciliation.generation, zone = await input.store.getDnsZone(a.primaryDomain)
        assert.ok(generation, 'The real fake-host reconcile must have an active persisted generation')
        assert.ok(zone, 'The prepared DNS zone must exist before the synthetic observation')
        const cgroup = 'user-' + a.uid + '.slice'
        return Response.json({ binding: rpc.binding, outcome: 'known', reconciliation,
          execution: { accountId: a.id, uid: a.uid, gid: a.gid, home: a.home, revision: d.revision,
            generationId: generation.id, generationChecksum: generation.checksum, sourceChecksum: d.checksum,
            cgroup, services: ['fixture-account-http.service'], quota: { enforced: true, filesystem: '/fixture-filesystem' },
            dns: { zone: a.primaryDomain, serial: zone.serial, authoritative: true }, php: { status: 200, uid: a.uid, cgroup } } })
      },
    },
  }
}
