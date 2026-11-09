import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGeneration, createRootPrincipal, createSession, createTestDb, hostOperationInFlight, markFailed, setTotpSecret } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import { FakeHostExecutor, HostReconciler, LinuxHostExecutor, type AgentApp } from '@xpanel/agent'
import { fail } from '@xpanel/core'
import { services } from '@xpanel/render'
import { profileFor } from '@xpanel/os'
import { bindVerifiedRequestPeer, createAgentApp } from '../../agent/src/server.ts'
import type { AgentAccountProvisioningRuntime } from '../../agent/src/account-provisioning-handler.ts'
import { noEffectFailure } from '../../agent/src/account-provisioning-runtime.ts'
import { HOST_EFFECT_NOT_STARTED } from '../../agent/src/host-effect-authority.ts'
import { ALERT_FILES, startAlertScheduler } from './alert-runtime.ts'
import type { DeliveryTransports } from './alert-delivery.ts'
import { startMailCertScheduler } from './mail-cert-scheduler.ts'
import { readAutoSslState } from './autossl.ts'
import { deriveCsrfToken } from './auth.ts'
import { sessionCookieName, sessionTokenHash } from './entry-points.ts'
import { createApiApp, INGRESS_SECRET_HEADER } from './server.ts'
import { canonicalProvisioningIdentity } from './use-cases/account-provisioning-port.ts'
import type { PreparedAccountState } from './use-cases/account-provisioning-prepared.ts'
import { memoryPreparations } from './testing/provisioning-preparation-fixture.ts'
import { settledAccountCreation } from './testing/account-create-settle.ts'

// H only: the API, the Agent provisioning route and admission, the StateStore and both schedulers are the real
// code paths. The CA order and the native workload observation are synthetic; nothing here proves host effects.
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const SECRET = 'scheduler-race-synthetic-server-secret-32-bytes'
const INGRESS = 'scheduler-race-synthetic-ingress-secret-32-bytes'
const ORIGIN = 'https://whm.example.test:2087'
const TOKEN = 'a'.repeat(64)
const API_UID = 19700
const os = profileFor('ID=ubuntu\nVERSION_ID=24.04\nVERSION_CODENAME=noble')
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })

async function host() {
  const database = await createTestDb(), state = await createTestStateStore()
  cleanup.push(() => database.close(), () => state.close())
  // As both daemons register it at startup: background writes wait while a host operation binds the revision.
  state.store.registerHostOperationProbe(() => hostOperationInFlight(database.db))
  const feature = await state.store.createFeatureList({ name: 'Scheduler race', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Scheduler race plan', ownerId: null, featureListId: feature.id,
    resources: { diskMb: 1024, bandwidthMbMonth: 10240, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 10, ioWriteIops: 10, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 2, aliasDomains: 2, subdomains: 2, mailboxes: 2, forwarders: 2, mailingLists: 2, ftpAccounts: 2, databases: 2, phpWorkers: 2 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 128 })
  await state.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const root = await createRootPrincipal(database.db, { username: 'root', passwordHash: HASH, forcePasswordChange: false })
  await setTotpSecret(database.db, root.id, new Uint8Array(32))
  const sessionToken = 'scheduler-race-session-' + randomUUID()
  await createSession(database.db, { principalId: root.id, tokenHash: sessionTokenHash(sessionToken, 'xwhm'), expiresAt: new Date(Date.now() + 600_000).toISOString(), mfaVerified: true })

  const preparations = memoryPreparations(state.store)
  const reconciler = new HostReconciler({ store: state.store, db: database.db, executor: new FakeHostExecutor(), os })
  const linux = new LinuxHostExecutor()
  for (const method of ['runCommand', 'runAction', 'writeFile', 'removePath'] as const) vi.spyOn(linux, method).mockRejectedValue(new Error('H fixture must not execute host effects'))
  // The minute that lands inside the host step: on the lab host the agent and API timers fired 60 s after start.
  const during: (() => Promise<unknown>)[] = []
  // A host step the reconciler stopped before any host primitive, as reconciler.ts reports it; null runs normally.
  let stopBeforeEffect: (() => Promise<void>) | null = null
  const runtime: AgentAccountProvisioningRuntime = {
    async readPreparation({ reference, actorKey, operationKey }) {
      const saved = await preparations.load<PreparedAccountState>(reference, actorKey)
      const identity = canonicalProvisioningIdentity(saved.desiredState)
      return { reference, actorKey, operationKey, requestIdentity: saved.requestIdentity, preparationIdentity: identity, desiredStateDigest: identity, planIdentity: saved.desiredState.planIdentity, phase: 'complete' }
    },
    async execute(input, context) {
      const { account: a, desired: d } = input.request.authority
      await context.assertAuthority()
      if (stopBeforeEffect) {
        const stop = stopBeforeEffect
        stopBeforeEffect = null
        await stop()
        const generation = await createGeneration(database.db, { checksum: 'c'.repeat(64), actor: 'fixture' })
        await markFailed(database.db, generation.id, 'stopped before any host effect')
        let refusal: unknown
        try { fail('PRECONDITION_FAILED', 'stopped before any host effect: host operation authority is no longer current', { generationId: generation.id, stateChanged: false, reason: HOST_EFFECT_NOT_STARTED }) } catch (error) { refusal = error }
        return (await noEffectFailure(database.db, input.request, refusal))!
      }
      const reconciliation = await reconciler.reconcile({ actor: input.actor.kind + ':' + input.actor.username, scope: input.scope, expectedState: { revision: d.revision, checksum: d.checksum } })
      for (const tick of during) await tick()
      await context.assertAuthority()
      if (reconciliation.status === 'failed' || !reconciliation.generation) throw new Error('fixture reconcile failed')
      const zone = (await state.store.getDnsZone(a.primaryDomain))!, cgroup = 'user-' + a.uid + '.slice'
      return { binding: input.request.binding, outcome: 'known', reconciliation,
        execution: { accountId: a.id, uid: a.uid, gid: a.gid, home: a.home, revision: d.revision, generationId: reconciliation.generation.id,
          generationChecksum: reconciliation.generation.checksum, sourceChecksum: d.checksum, cgroup, services: ['fixture-account-http.service'],
          quota: { enforced: true, filesystem: '/fixture-filesystem' }, dns: { zone: a.primaryDomain, serial: zone.serial, authoritative: true }, php: { status: 200, uid: a.uid, cgroup } } }
    },
  }
  const agent = createAgentApp({ store: state.store, db: database.db, reconciler, executor: linux, accountProvisioning: runtime,
    os: { id: os.id, versionId: os.versionId, family: os.family }, agentToken: TOKEN, expectedPeerUid: API_UID, allowRootPeer: false,
    benchmarkStore: {} as never })
  const orders: string[] = []
  const agentApp: AgentApp = { subscribe: listener => agent.subscribe(listener), fetch: async incoming => {
    const path = new URL(incoming.url).pathname
    // The certificate authority is the one synthetic party: the order returns issued material.
    if (/^\/accounts\/[a-z0-9]+\/certificates$/.test(path)) {
      const { domain } = await incoming.json() as { domain: string }, id = randomUUID(), files = services.certFiles(id)
      orders.push(domain)
      return Response.json({ certificate: { id, names: [domain], notAfter: new Date(Date.now() + 90 * 86_400_000).toISOString(), notBefore: new Date().toISOString(), fingerprintSha256: 'b'.repeat(64), certPath: files.fullchain, keyPath: files.privkey } })
    }
    const request = new Request(incoming, { headers: { ...Object.fromEntries(incoming.headers), 'x-xpanel-peer-uid': String(API_UID), 'x-xpanel-role': 'root' } })
    bindVerifiedRequestPeer(request, { peer: { uid: API_UID, gid: API_UID + 1, pid: 4242 }, allowedPeerUids: new Set([API_UID]), credentialSource: 'SO_PEERCRED' })
    return agent.fetch(request)
  } }
  const transports = { serverName: 'server.example.test', email: { send: async () => undefined }, webhook: { send: async () => undefined } } as unknown as DeliveryTransports
  const mailCerts = startMailCertScheduler({ db: database.db, store: state.store, agentApp, agentToken: TOKEN, publicOrigin: ORIGIN, admit: task => task(),
    transports, caa: async () => [], resolves: async () => true, everyMs: 3_600_000 })
  const monitoring = startAlertScheduler({ db: database.db, store: state.store, agentApp, agentToken: TOKEN, admit: task => task(), everyMs: 100, transports })
  cleanup.push(() => mailCerts.stop(), () => monitoring.stop())
  const api = createApiApp({ db: database.db, store: state.store, serverSecret: SECRET, entryPoint: 'xwhm', publicOrigin: ORIGIN, allowedOrigins: [ORIGIN],
    ingressSecret: INGRESS, requireSecureCookies: true, requireOriginHeader: true, provisioningPreparations: preparations, agentApp, agentToken: TOKEN })
  const headers = { 'content-type': 'application/json', origin: ORIGIN, cookie: sessionCookieName('xwhm', true) + '=' + sessionToken, 'x-csrf-token': deriveCsrfToken(sessionToken, SECRET, 'xwhm'),
    [INGRESS_SECRET_HEADER]: INGRESS, 'x-forwarded-proto': 'https', 'x-forwarded-for': '192.0.2.20' }
  const read = (path: string) => api.fetch(new Request(ORIGIN + path, { headers }), { remoteAddress: '127.0.0.1' })
  const create = async (username: string) => settledAccountCreation(await api.fetch(new Request(ORIGIN + '/api/accounts', { method: 'POST', headers, body: JSON.stringify({ username, primaryDomain: username + '.example.test', planId: plan.id, passwordHash: HASH,
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 100, processIdleTimeoutSec: 10 }, ini: {} } }) }), { remoteAddress: '127.0.0.1' }), read)
  return { state, during, mailCerts, orders, create, stopNextHostStep: (stop: () => Promise<void>) => { stopBeforeEffect = stop } }
}

describe('account provisioning beside the scheduled minute work (H)', () => {
  it.runIf(process.platform === 'linux')('creates an account while AutoSSL and monitoring run, and leaves its certificate for the next minute', async () => {
    const h = await host()
    h.during.push(() => h.mailCerts.tick())
    const response = await h.create('qa3')
    expect(response.status, await response.clone().text()).toBe(201)
    // AutoSSL saw the new domain inside the host step and placed no order: the binding would move the bound revision.
    expect(h.orders).toEqual([])
    expect((await h.state.store.readSnapshot()).domains.find(domain => domain.name === 'qa3.example.test')?.certificateId).toBeNull()
    // The row stays queued for the next minute (autossl.test.ts orders it once no host operation runs).
    expect((await readAutoSslState(h.state.store)).queue).toMatchObject([{ domain: 'qa3.example.test', attempts: 0 }])
    // Monitoring ran throughout: its run files live under extended/ and never move the desired-state revision.
    await access(join(h.state.rootDir, 'extended', ALERT_FILES.delivery))
  })

  it.runIf(process.platform === 'linux')('runs the same request again without operator recovery when no host action ran', async () => {
    const h = await host()
    // An operator request moves the revision during the host step; the agent stops before any host primitive.
    h.stopNextHostStep(async () => { await h.state.store.saveServerIp({ address: '192.0.2.11', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'dedicated', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: false, notes: '' }) })
    const refused = await h.create('qa4')
    expect(refused.status).toBe(412)
    const retried = await h.create('qa4')
    expect(retried.status, await retried.clone().text()).toBe(201)
    expect((await retried.json() as { operation: { resumedFromStep: number | null } }).operation.resumedFromStep).not.toBeNull()
  })
})
