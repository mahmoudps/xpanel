import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultPlan, fail, suggestServerSettings, type HostAction, type RenderedFile } from '@xpanel/core'
import { createTestDb, getGeneration, type TestDbHandle } from '@xpanel/db'
import { profileFor } from '@xpanel/os'
import { createTestStateStore, type TestStateStoreHandle } from '@xpanel/state'
import { FakeHostExecutor } from './executor.ts'
import { authorizedHostEffect } from './host-effect-authority.ts'
import { HostReconciler, onDemandService, rollbackReloadActions } from './reconciler.ts'

const reloads = (unit: string): boolean => rollbackReloadActions(unit).some(action => action.kind === 'systemd' && action.verb === 'reload')

describe('rollback of units without a reload job', { tags: ['unit'] }, () => {
  it('restarts a socket with its on-demand service stopped instead of reloading either', () => {
    for (const unit of ['xpanel-webdiskd-qa2-05c39af3ac5b.socket', 'xpanel-webdisk-qa2-05c39af3ac5b.socket', 'xpanel-caldav-qa1.socket', 'xpanel-appproxy-alice-blog.socket', 'ssh.socket']) {
      expect(reloads(unit), unit).toBe(false)
    }
    expect(rollbackReloadActions('xpanel-webdiskd-qa2-05c39af3ac5b.socket')).toEqual([
      { kind: 'systemd', verb: 'stop', unit: 'xpanel-webdiskd-qa2-05c39af3ac5b.service' },
      { kind: 'systemd', verb: 'stop', unit: 'xpanel-webdiskd-qa2-05c39af3ac5b.socket' },
      { kind: 'systemd', verb: 'start', unit: 'xpanel-webdiskd-qa2-05c39af3ac5b.socket' },
    ])
    expect(rollbackReloadActions('ssh.socket')).toEqual([{ kind: 'systemd', verb: 'restart', unit: 'ssh.socket' }])
  })

  it('stops an on-demand service and restarts the xPanel daemons that have no ExecReload', () => {
    expect(rollbackReloadActions('xpanel-caldav-qa1.service')).toEqual([{ kind: 'systemd', verb: 'stop', unit: 'xpanel-caldav-qa1.service' }])
    expect(onDemandService('xpanel-app-alice-blog.service')).toBeNull()
    for (const unit of ['xpanel-app-alice-blog.service', 'xpanel-ctr-alice-web.service', 'xpanel-redis-alice.service', 'xpanel-memcached-alice.service']) {
      expect(rollbackReloadActions(unit), unit).toEqual([{ kind: 'systemd', verb: 'restart', unit }])
    }
  })
})

// A modeled executor the reconciler treats as native, as in reconciler-authority-lapse.test.ts.
const os = profileFor('ID=ubuntu\nVERSION_ID="24.04"\n')
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNo'

/** Every host action and file write is an admitted primitive; the authority lapses at the first live file write. */
function nativeHost() {
  const fake = new FakeHostExecutor()
  const actions: HostAction[] = []
  let lapseOnWrite = false, lapsed = false
  const executor: FakeHostExecutor = new Proxy(fake, {
    has: (target, key) => key !== 'files' && Reflect.has(target, key),
    get: (target, key) => {
      if (key === 'runAction') return (action: HostAction) => { actions.push(action); return authorizedHostEffect(executor, () => target.runAction(action)) }
      if (key === 'writeFile') return (file: RenderedFile) => { if (lapseOnWrite) lapsed = true; return authorizedHostEffect(executor, () => target.writeFile(file)) }
      if (key === 'runCommand') return async (argv: string[]) => argv[1] === '-v' ? { ok: true, code: 0, stdout: '', stderr: 'nginx version: nginx/1.24.0' } : target.runCommand(argv)
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const effectAuthority = { signal: new AbortController().signal, assertAuthority: async () => {
    if (lapsed) fail('CONFLICT', 'the provisioning job is not an active account.provision operation')
  } }
  return { fake, executor, actions, effectAuthority, lapseAtFirstWrite: () => { lapseOnWrite = true } }
}

describe.runIf(process.platform === 'linux')('an account whose provisioning authority lapsed after its user was created', () => {
  let state: TestStateStoreHandle
  let db: TestDbHandle
  let host: ReturnType<typeof nativeHost>
  let reconciler: HostReconciler
  let lapse: unknown
  // One built scene: an applied generation with qa1's socket units, then qa4's generation lapsing at its first live write.
  beforeAll(async () => {
    state = await createTestStateStore()
    db = await createTestDb()
    const suggested = suggestServerSettings({ cores: 2, memoryMb: 2048 })
    await state.store.saveServerSettings({ hostname: 'srv1.example.com', nameservers: ['ns1.example.com', 'ns2.example.com'], adminEmail: 'ops@example.com', engine: 'apache', apacheMpm: 'itk', panelPort: 2087, sshPort: 22, nginx: suggested.nginx, apache: suggested.apache, backendPort: 8080, backendTlsPort: 8443 })
    const features = await state.store.createFeatureList({ name: 'Socket fixture', ownerId: null, disabled: [] })
    const { id: _id, ...plan } = defaultPlan({ id: crypto.randomUUID(), name: 'Socket fixture', featureListId: features.id })
    const planId = (await state.store.createPlan(plan)).id
    await state.store.saveServerIp({ address: '203.0.113.10', version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
    const addAccount = (username: string) => state.store.createAccount({ username, passwordHash: HASH, primaryDomain: `${username}.example.test`, planId, ownerId: null,
      contactEmail: 'ops@example.test', ipv4: '203.0.113.10', shell: 'jailed', php: { version: '8.3', handler: 'fpm',
        fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 500, processIdleTimeoutSec: 10 }, ini: {} } })
    await addAccount('qa1')
    host = nativeHost()
    reconciler = new HostReconciler({ store: state.store, db: db.db, executor: host.executor, os })
    if ((await reconciler.reconcile({ actor: 'root', mailAuth: null })).status !== 'applied') throw new Error('fixture generation was not applied')
    await addAccount('qa4')
    host.actions.length = 0
    host.lapseAtFirstWrite()
    lapse = await reconciler.reconcile({ actor: 'root:root', mailAuth: null, effectAuthority: host.effectAuthority }).then(() => null, (error: unknown) => error)
  }, 20_000)
  afterAll(async () => { await state?.close(); await db?.close() })

  it('rolls the socket units back without a reload', { tags: ['feature'] }, async () => {
    // The lapse ends the request as an unverified outcome; the rollback ran outside the lapsed authority.
    expect(lapse).toMatchObject({ code: 'CONFLICT', detail: { stateChanged: true, verificationRequired: true } })
    expect(host.actions).toContainEqual(expect.objectContaining({ kind: 'ensure-user', name: 'qa4' }))
    expect(host.actions.filter(action => action.kind === 'systemd' && action.verb === 'reload' && action.unit.endsWith('.socket'))).toEqual([])
    expect(host.fake.units.get('xpanel-caldav-qa1.socket')?.active).toBe(true)
    const journal = await reconciler.journal.readActiveJournal()
    expect(journal).toMatchObject({ phase: 'needs_attention' })
    expect(journal).not.toHaveProperty('rollbackFailed')
    expect((await getGeneration(db.db, journal!.generationId))?.status).toBe('rolled_back')
  })

  // One full reconcile of the recovered source: about 2 s on the qualification guest.
  it('applies the saved account once the operator resolves the generation', { tags: ['slow'] }, async () => {
    // xpanel reconcile --resolve-failed <id> --attest-pre-actions, then the next reconcile applies the saved account.
    const journal = await reconciler.journal.readActiveJournal()
    await reconciler.resolveFailedGeneration(journal!.generationId, 'root', { attestPreActions: true })
    expect((await reconciler.reconcile({ actor: 'root', mailAuth: null })).status).toBe('applied')
    expect(host.fake.units.get('xpanel-caldav-qa4.socket')).toMatchObject({ enabled: true, active: true })
    expect(await reconciler.journal.readActiveJournal()).toBeNull()
  })
})
