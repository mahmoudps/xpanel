import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultPlan, fail, suggestServerSettings, type HostAction } from '@xpanel/core'
import { createTestDb, getGeneration, latestActive, type TestDbHandle } from '@xpanel/db'
import { profileFor } from '@xpanel/os'
import { createTestStateStore, type TestStateStoreHandle } from '@xpanel/state'
import { FakeHostExecutor } from './executor.ts'
import { authorizedHostEffect } from './host-effect-authority.ts'
import { HostReconciler } from './reconciler.ts'

// H only: a modeled executor that the reconciler treats as native, so prerequisites run in the test phase
// under the admitted authority exactly as on a host. It proves the journal decision, not host effects.
const os = profileFor('ID=ubuntu\nVERSION_ID="24.04"\n')
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNo'
let state: TestStateStoreHandle
let db: TestDbHandle
beforeEach(async () => {
  state = await createTestStateStore()
  db = await createTestDb()
  const suggested = suggestServerSettings({ cores: 2, memoryMb: 2048 })
  await state.store.saveServerSettings({ hostname: 'srv1.example.com', nameservers: ['ns1.example.com', 'ns2.example.com'], adminEmail: 'ops@example.com', engine: 'apache', apacheMpm: 'itk', panelPort: 2087, sshPort: 22, nginx: suggested.nginx, apache: suggested.apache, backendPort: 8080, backendTlsPort: 8443 })
  const features = await state.store.createFeatureList({ name: 'Lapse fixture', ownerId: null, disabled: [] })
  const { id: _id, ...plan } = defaultPlan({ id: crypto.randomUUID(), name: 'Lapse fixture', featureListId: features.id })
  const saved = await state.store.createPlan(plan)
  await state.store.saveServerIp({ address: '203.0.113.10', version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  await state.store.createAccount({ username: 'tenant', passwordHash: HASH, primaryDomain: 'tenant.example.test', planId: saved.id, ownerId: null,
    contactEmail: 'ops@example.test', ipv4: '203.0.113.10', shell: 'jailed', php: { version: '8.3', handler: 'fpm',
      fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 500, processIdleTimeoutSec: 10 }, ini: {} } })
})
afterEach(async () => { await state.close(); await db.close() })

/** Lapses the authority once `after` host actions have started; every action is an admitted host primitive. */
function nativeHost(after: number) {
  const fake = new FakeHostExecutor()
  let started = 0, lapsed = false
  const executor: FakeHostExecutor = new Proxy(fake, {
    has: (target, key) => key !== 'files' && Reflect.has(target, key),
    get: (target, key) => {
      if (key === 'runAction') return (action: HostAction) => { if (started++ === after) lapsed = true; return authorizedHostEffect(executor, () => target.runAction(action)) }
      if (key === 'runCommand') return async (argv: string[]) => argv[1] === '-v' ? { ok: true, code: 0, stdout: '', stderr: 'nginx version: nginx/1.24.0' } : target.runCommand(argv)
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const effectAuthority = { signal: new AbortController().signal, assertAuthority: async () => {
    if (lapsed) fail('CONFLICT', 'the saved source revision does not match the provisioning request')
  } }
  return { executor, effectAuthority, started: () => started }
}

describe.runIf(process.platform === 'linux')('a host operation authority that lapses during native prerequisites', { tags: ['feature'] }, () => {
  it('fails the generation cleanly when no host primitive started, so the next reconcile proceeds', async () => {
    const host = nativeHost(0)
    const reconciler = new HostReconciler({ store: state.store, db: db.db, executor: host.executor, os })
    const refused = await reconciler.reconcile({ actor: 'root:root', mailAuth: null, effectAuthority: host.effectAuthority }).then(() => null, (error: unknown) => error)
    expect(refused).toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    const generationId = (refused as { detail: { generationId: number } }).detail.generationId
    expect(await reconciler.journal.readActiveJournal()).toBeNull()
    expect(await reconciler.journal.readGenerationJournal(generationId)).toMatchObject({ phase: 'failed', preActionsNeedVerification: false, completedPreActions: 0 })
    expect((await getGeneration(db.db, generationId))?.status).toBe('failed')
    // The next reconcile passes the journal gate and reaches its source check; a stale source still refuses there.
    await expect(reconciler.reconcile({ actor: 'root', mailAuth: null, expectedState: { revision: -1, checksum: 'stale' } }))
      .rejects.toThrow('the saved account source changed before reconciliation')
    expect(host.started()).toBe(1)
  })

  // One full native generation (about 3 s); the authority and journal rules are covered fast in their own tests.
  it('finishes the generation once a prerequisite ran before the lapse, so the next reconcile proceeds', { tags: ['slow'] }, async () => {
    const host = nativeHost(1)
    const reconciler = new HostReconciler({ store: state.store, db: db.db, executor: host.executor, os })
    // The lapse is reported when the operation acknowledges; it no longer stops the host half way.
    await expect(reconciler.reconcile({ actor: 'root:root', mailAuth: null, effectAuthority: host.effectAuthority })).rejects.toMatchObject({ detail: { stateChanged: true, verificationRequired: true } })
    expect(host.started()).toBeGreaterThan(2)
    // Both gates every later reconcile passes first (reconciler.ts reconcileAdmitted).
    await expect(reconciler.journal.assertNoUnresolvedPreparation()).resolves.toBeUndefined()
    expect(await reconciler.journal.readActiveJournal()).toBeNull()
    expect((await latestActive(db.db))?.status).toBe('active')
  })
})
