import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDb, type ConfigGeneration } from '@xpanel/db'
import { createTestStateStore, type StateAuthorityMetadata } from '@xpanel/state'
import type { AccountIdentity } from '@xpanel/lifecycle'
import type { Account } from '@xpanel/core'
import { account, domain } from '../../../../packages/render/src/edge/testkit.ts'
import { debianOs } from '../../../../packages/render/src/system/testkit.ts'
import { FakeHostExecutor } from '../executor.ts'
import { ReconcilerJournal } from '../reconciler-journal.ts'
import type { HostEffectAuthority } from '../host-effect-authority.ts'
import type { HeldNativeAccountHttpRequest, NativeAccountHttpOptions } from '../account-provisioning-http.ts'
import type { NativeAccountHttpSubject } from '../account-provisioning-http-source.ts'
import { createNativeLifecycleCanary, type NativeLifecycleCanaryOptions } from './native-canary.ts'

// Synthetic scope/transport composition only. No native capability or Linux qualification is minted by these tests.
const fixture = vi.hoisted(() => {
  const generation: ConfigGeneration = { id: 7, checksum: 'd'.repeat(64), status: 'active', actor: 'root', createdAt: '2026-10-31T00:00:00Z', testedAt: null, activatedAt: null, error: null }
  const state: { operation: string; kind: string; allowed: boolean; opens: number; closes: number; releases: number; uid: number; generation: ConfigGeneration;
    openHook: (context: HostEffectAuthority) => Promise<void>; closeFails: boolean; exchangeOptions: unknown } = {
    operation: 'operation-a', kind: 'upgrade', allowed: true, opens: 0, closes: 0, releases: 0, uid: 20001, generation,
    openHook: async () => {}, closeFails: false, exchangeOptions: undefined,
  }
  return state
})
vi.mock('@xpanel/db', async () => {
  const original = await vi.importActual<typeof import('@xpanel/db')>('@xpanel/db')
  return { ...original, latestActive: async () => ({ ...fixture.generation }) }
})
vi.mock('../../../../scripts/lifecycle-root-safety.mjs', () => ({
  captureCurrentLifecycleObservationScope: async () => {
    if (!fixture.allowed) throw new Error('fixture actual scope denied')
    const captured = fixture.operation, controller = new AbortController()
    return { operationId: captured, kind: fixture.kind, readOnly: true, signal: controller.signal,
      async assertAuthority() { if (!fixture.allowed || captured !== fixture.operation || controller.signal.aborted) throw new Error('fixture actual scope denied') },
      release() { fixture.releases++; controller.abort() },
    }
  },
}))
vi.mock('../account-provisioning-http.ts', () => ({
  createNativeHeldAccountHttp: (options: NativeAccountHttpOptions) => (fixture.exchangeOptions = options, {
    async assertAvailable(_account: Account, context: HostEffectAuthority) { await context.assertAuthority() },
    async open(subject: NativeAccountHttpSubject, context: HostEffectAuthority): Promise<HeldNativeAccountHttpRequest> {
      fixture.opens++; await fixture.openHook(context); await context.assertAuthority()
      const unit = 'xpanel-php-fpm-' + subject.account.username + '-8.3.service'
      let closePromise: Promise<void> | undefined
      return { requestBinding: subject.binding, challenge: subject.challenge, status: 200, pid: 701, unit, mainPid: 700,
        observedProcess: { pid: 701, parentPid: 700, startTime: '12345', state: 'S', uids: Array(4).fill(fixture.uid), gids: Array(4).fill(subject.account.gid),
          cgroup: '/xpanel.slice/xpanel-' + subject.account.uid + '.slice/' + unit },
        assertCurrent: () => context.assertAuthority(),
        close() { return closePromise ??= (async () => { fixture.closes++; if (fixture.closeFails) throw new Error('fixture close failed'); await context.assertAuthority() })() },
      }
    },
  }),
}))
const cleanup: Array<() => Promise<void>> = []
beforeEach(() => {
  fixture.operation = 'operation-a'; fixture.kind = 'upgrade'; fixture.allowed = true; fixture.opens = 0; fixture.closes = 0; fixture.releases = 0
  fixture.uid = 20001; fixture.generation.id = 7; fixture.generation.status = 'active'; fixture.generation.checksum = 'd'.repeat(64)
  fixture.openHook = async () => {}; fixture.closeFails = false
})
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })

async function scene() {
  const database = await createTestDb(), state = await createTestStateStore()
  cleanup.push(async () => { await database.close(); await state.close() })
  const snapshot = await state.store.readSnapshot()
  const tenant = account({ id: '22222222-2222-4222-8222-222222222222', planId: '33333333-3333-4333-8333-333333333333', uid: 20001, gid: 20001, primaryDomain: 'tenant.example.test' })
  const stored = { ...tenant, suspendedAt: null }
  const primary = domain({ id: '66666666-6666-4666-8666-666666666666', accountId: tenant.id, name: tenant.primaryDomain,
    php: { ...domain().php, handler: 'fpm' } })
  snapshot.accounts = [stored]; snapshot.domains = [primary]; snapshot.checksum = 'b'.repeat(64); snapshot.revision = 5
  const meta: StateAuthorityMetadata = { revision: 5, fencingToken: 1, updatedAt: '2026-10-31T00:00:00Z', references: {} }
  const journal = new ReconcilerJournal(state.rootDir)
  vi.spyOn(journal, 'readManifest').mockImplementation(async generationId => ({ schemaVersion: 1, generationId, stateChecksum: snapshot.checksum,
    filesChecksum: fixture.generation.checksum, createdAt: '2026-10-31T00:00:00Z', actor: 'root', files: [], managedUnits: [], testResults: [] }))
  const databaseReader = { withReadonlyDatabase: async () => { throw new Error('fixture exchange reader is not used by the simulated exchange') } }
  const options: NativeLifecycleCanaryOptions = { db: database.db, databaseReader, executor: new FakeHostExecutor(), os: debianOs, reconciler: { journal },
    store: { readSnapshot: async () => structuredClone(snapshot), getAuthorityMetadata: async () => ({ ...meta }), listDomains: async () => snapshot.domains,
      // Portable state-observation seam only; production pins real state files.
      withReadonlyObservation: async work => {
        const baseline = JSON.stringify({ snapshot, meta })
        let live = true
        const assertCurrent = async () => {
          if (!live || JSON.stringify({ snapshot, meta }) !== baseline) throw new Error('fixture observation changed or retired')
        }
        try {
          const result = await work({ snapshot: structuredClone(snapshot), authority: Object.freeze({ ...meta }), assertCurrent })
          await assertCurrent(); return result
        } finally { live = false }
      },
      getAccount: async id => snapshot.accounts.find(value => value.id === id) ?? null },
    addon: { openListener() { throw new Error('native unavailable in this fixture') }, acceptPeer: () => null, verifyListenerSocket: () => false,
      closeListener() {}, closeFd() {}, getSocketPeerCred() { throw new Error('native unavailable in this fixture') } },
  }
  const canaries = createNativeLifecycleCanary(options)
  const identity = (): AccountIdentity => ({ username: tenant.username, uid: tenant.uid, gid: tenant.gid, slice: 'xpanel-' + tenant.uid + '.slice', quotas: {} })
  const issued = async () => {
    const selection = await canaries.select(); await canaries.assertSelectionCurrent(selection)
    const targets = await canaries.bindIdentities([identity()]), target = targets[0]
    if (!target) throw new Error('fixture target missing')
    return target
  }
  return { canaries, tenant, stored, primary, snapshot, meta, identity, issued, databaseReader }
}

describe('lifecycle canary composition with simulated native scope and held exchange; not native qualification', { tags: ['feature'] }, () => {
  it('gives the held account HTTP exchange fresh pinned readers and never the control handle', async () => {
    const s = await scene(), exchange = fixture.exchangeOptions as NativeAccountHttpOptions
    expect(exchange.databaseReader).toBe(s.databaseReader)
    expect('db' in exchange).toBe(false)
  })
  it('accepts empty-host selection only while the actual stored host remains empty', async () => {
    const s = await scene(); s.snapshot.accounts = []; s.snapshot.domains = []
    const choice = await s.canaries.select(); expect(choice.username).toBeNull()
    await s.canaries.assertSelectionCurrent(choice); expect(fixture.opens).toBe(0)
  })
  it('refuses a nonempty host without a real active primary FPM target', async () => {
    const s = await scene(); s.primary.suspended = true
    await expect(s.canaries.select()).rejects.toThrow(); expect(fixture.opens).toBe(0)
  })
  it('refuses usernames and copied projections instead of treating them as authority', async () => {
    const s = await scene(), target = await s.issued()
    for (const supplied of [s.tenant.username, { ...target }, JSON.parse(JSON.stringify(target)), true]) await expect(s.canaries.observe(supplied)).rejects.toThrow()
    expect(fixture.opens).toBe(0)
  })
  it('returns the actual held worker UID and cgroup only after completion and current checks', async () => {
    const s = await scene(), target = await s.issued()
    await expect(s.canaries.observe(target)).resolves.toEqual({ httpStatus: 200, servedByUid: 20001, cgroupSlice: 'xpanel-20001.slice', serviceActive: true })
    expect(fixture.closes).toBe(1)
  })
  it('rejects a held worker with a different UID instead of returning the requested UID', async () => {
    const s = await scene(), target = await s.issued(); fixture.uid = 33
    await expect(s.canaries.observe(target)).rejects.toThrow(); expect(fixture.closes).toBe(1)
  })
  it('refuses a target issued in another actual lifecycle operation', async () => {
    const s = await scene(), target = await s.issued(); fixture.operation = 'operation-b'
    await expect(s.canaries.observe(target)).rejects.toThrow(); expect(fixture.opens).toBe(0)
  })
  it('refuses delete/recreate under the same username and numeric UID', async () => {
    const s = await scene(), target = await s.issued(); s.stored.id = '77777777-7777-4777-8777-777777777777'
    await expect(s.canaries.observe(target)).rejects.toThrow(); expect(fixture.opens).toBe(0)
  })
  it('rechecks lifetime and state commit after held async acquisition', async () => {
    const s = await scene(), target = await s.issued()
    fixture.openHook = async () => { await Promise.resolve(); s.stored.createdAt = '2026-10-31T01:00:00Z'; s.meta.fencingToken++ }
    await expect(s.canaries.observe(target)).rejects.toThrow()
  })
  it('rechecks the actual current generation after held async acquisition', async () => {
    const s = await scene(), target = await s.issued(); fixture.openHook = async () => { await Promise.resolve(); fixture.generation.id++ }
    await expect(s.canaries.observe(target)).rejects.toThrow()
  })
  it('refuses authority revocation during acquisition', async () => {
    const s = await scene(), target = await s.issued(); fixture.openHook = async () => { await Promise.resolve(); fixture.allowed = false }
    await expect(s.canaries.observe(target)).rejects.toThrow(); expect(fixture.releases).toBeGreaterThan(0)
  })
  it('refuses a primary-domain expiry crossed during a held await', async () => {
    const s = await scene(); let clock = Date.now(); s.primary.expiresAt = new Date(clock + 5000).toISOString()
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    const target = await s.issued(); fixture.openHook = async () => { await Promise.resolve(); clock += 5001 }
    await expect(s.canaries.observe(target)).rejects.toThrow()
  })
  it('does not accept evidence when held response cleanup is uncertain', async () => {
    const s = await scene(), target = await s.issued(); fixture.closeFails = true
    await expect(s.canaries.observe(target)).rejects.toThrow('fixture close failed'); expect(fixture.releases).toBeGreaterThan(0)
  })
  it('refuses an empty selection if a real stored account appears before scope admission', async () => {
    const s = await scene(); s.snapshot.accounts = []; const choice = await s.canaries.select(); s.snapshot.accounts = [s.stored]
    await expect(s.canaries.assertSelectionCurrent(choice)).rejects.toThrow(); expect(fixture.opens).toBe(0)
  })
})
