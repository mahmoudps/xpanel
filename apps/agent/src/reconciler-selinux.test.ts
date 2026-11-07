import { open, type FileHandle } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { suggestServerSettings } from '@xpanel/core'
import type { HostAction } from '@xpanel/core'
import { createTestDb, type TestDbHandle } from '@xpanel/db'
import { profileFor } from '@xpanel/os'
import { createTestStateStore, type TestStateStoreHandle } from '@xpanel/state'
import { FakeHostExecutor } from './executor.ts'
import { compileDesiredGeneration, HostReconciler } from './reconciler.ts'
import { SELINUX_ENFORCE_PATH } from './selinux-homes.ts'

const ARGON2 = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const ubuntu = profileFor('ID=ubuntu\nVERSION_ID="24.04"\n')
const el = profileFor('ID=almalinux\nVERSION_ID="9.6"\n')
const ACCOUNT_PATHS = ['/home/alice', '/home/alice/public_html', '/home/alice/tmp', '/home/alice/logs', '/home/alice/mail']
const contextActions = (actions: readonly HostAction[]) => actions.filter(action => action.kind === 'exec' && action.argv[0] === '/usr/sbin/restorecon' && action.runAsUser !== undefined)
// Device flushes, not these contracts, set the wall time; flush durability is proven by packages/state atomic-durability tests.
let restoreFileSync = (): void => {}
beforeAll(async () => {
  const probe = await open(fileURLToPath(import.meta.url), 'r')
  try {
    const sync = vi.spyOn(Object.getPrototypeOf(probe) as FileHandle, 'sync').mockResolvedValue(undefined)
    restoreFileSync = () => sync.mockRestore()
  } finally { await probe.close() }
})
afterAll(() => restoreFileSync())

describe('EL account paths in a generation', { tags: ['feature'] }, () => {
  let state: TestStateStoreHandle
  let db: TestDbHandle
  beforeEach(async () => {
    state = await createTestStateStore()
    db = await createTestDb()
    const suggested = suggestServerSettings({ cores: 2, memoryMb: 2048 })
    await state.store.saveServerSettings({ hostname: 'srv1.example.com', nameservers: ['ns1.example.com', 'ns2.example.com'], adminEmail: 'ops@example.com', engine: 'apache', apacheMpm: 'itk',
      panelPort: 2087, sshPort: 22, nginx: suggested.nginx, apache: suggested.apache, backendPort: 8080, backendTlsPort: 8443 })
    await state.store.saveServerIp({ address: '203.0.113.10', version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
    const features = await state.store.createFeatureList({ name: 'Standard', ownerId: null, disabled: [] })
    const plan = await state.store.createPlan({ name: 'Pro', ownerId: null, featureListId: features.id,
      resources: { diskMb: 10_240, bandwidthMbMonth: 102_400, ioReadBps: 50_000_000, ioWriteBps: 50_000_000, ioReadIops: 2000, ioWriteIops: 2000, memoryMb: 1024, maxProcesses: 64, cpuPercent: 200 },
      caps: { addonDomains: 10, aliasDomains: 10, subdomains: 20, mailboxes: 20, forwarders: 20, mailingLists: 5, ftpAccounts: 10, databases: 10, phpWorkers: 8 },
      dedicatedIp: false, shell: 'jailed', defaultMailboxQuotaMb: 1024 })
    await state.store.createAccount({ username: 'alice', passwordHash: ARGON2, primaryDomain: 'alice.example.com', planId: plan.id, ownerId: null, contactEmail: 'alice@example.com', ipv4: '203.0.113.10', shell: 'jailed',
      php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 4, startServers: 2, minSpareServers: 1, maxSpareServers: 3, maxRequests: 500, processIdleTimeoutSec: 10 }, ini: {} } })
  })
  afterEach(async () => { await state.close(); await db.close() })

  it('labels the account directories after creating them, on EL with SELinux only', async () => {
    const snapshot = await state.store.readSnapshot()
    const { preActions } = compileDesiredGeneration(snapshot, { os: el, selinux: true })
    expect(contextActions(preActions)).toEqual([{ kind: 'exec', runAsUser: 'alice', argv: ['/usr/sbin/restorecon', '-F', '-i', ...ACCOUNT_PATHS] }])
    const created = preActions.findLastIndex(action => action.kind === 'ensure-dir' && action.path === '/home/alice/mail')
    expect(created).toBeGreaterThanOrEqual(0)
    expect(preActions.findIndex(action => action.kind === 'exec' && action.argv[0] === '/usr/sbin/restorecon')).toBeGreaterThan(created)
    expect(contextActions(compileDesiredGeneration(snapshot, { os: el, selinux: false }).preActions)).toEqual([])
    expect(contextActions(compileDesiredGeneration(snapshot, { os: ubuntu, selinux: true }).preActions)).toEqual([])
  })

  it('names a document root outside public_html', async () => {
    const snapshot = await state.store.readSnapshot()
    const domains = [...snapshot.domains, { ...snapshot.domains[0]!, id: 'addon', name: 'shop.example.com', kind: 'addon' as const, docRoot: '/home/alice/shop.example.com' }]
    const [action] = contextActions(compileDesiredGeneration({ ...snapshot, domains }, { os: el, selinux: true }).preActions)
    expect(action).toMatchObject({ runAsUser: 'alice', argv: ['/usr/sbin/restorecon', '-F', '-i', ...ACCOUNT_PATHS, '/home/alice/shop.example.com'] })
  })

  it('applies the observation although it changes no rendered file, and walks a new document root once', async () => {
    const executor = new FakeHostExecutor()
    executor.files.set(SELINUX_ENFORCE_PATH, { path: SELINUX_ENFORCE_PATH, content: '1', mode: 0o644 })
    const reconciler = new HostReconciler({ store: state.store, db: db.db, executor, os: el })
    expect(await reconciler.reconcile({ actor: 'root', mailAuth: null })).toMatchObject({ status: 'applied' })
    expect(contextActions(executor.executedActions)).toEqual([
      { kind: 'exec', runAsUser: 'alice', argv: ['/usr/sbin/restorecon', '-F', '-i', ...ACCOUNT_PATHS] },
      { kind: 'exec', runAsUser: 'alice', argv: ['/usr/sbin/restorecon', '-R', '-F', '-i', '/home/alice/public_html'] },
    ])
    executor.executedActions.length = 0
    expect(await reconciler.reconcile({ actor: 'root', mailAuth: null })).toMatchObject({ status: 'noop' })
    expect(contextActions(executor.executedActions)).toEqual([])
    expect(await reconciler.reconcile({ actor: 'root', mailAuth: null, force: true })).toMatchObject({ status: 'applied' })
    expect(contextActions(executor.executedActions)).toEqual([{ kind: 'exec', runAsUser: 'alice', argv: ['/usr/sbin/restorecon', '-F', '-i', ...ACCOUNT_PATHS] }])
  })

  it('runs no relabel on Debian and Ubuntu', async () => {
    const executor = new FakeHostExecutor()
    executor.files.set(SELINUX_ENFORCE_PATH, { path: SELINUX_ENFORCE_PATH, content: '1', mode: 0o644 })
    expect(await new HostReconciler({ store: state.store, db: db.db, executor, os: ubuntu }).reconcile({ actor: 'root', mailAuth: null })).toMatchObject({ status: 'applied' })
    expect(contextActions(executor.executedActions)).toEqual([])
  })
})
