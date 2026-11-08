import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, type TestDbHandle } from '@xpanel/db'
import { profileFor } from '@xpanel/os'
import { atomicWriteJson, createTestStateStore, type TestStateStoreHandle } from '@xpanel/state'
import { accountEdgeSiteOptions, clearAccountMoved, movedStatePath, readAccountEdge, removeAccountEdgeState } from './account-edge.ts'
import { FakeHostExecutor } from './executor.ts'
import { HostReconciler } from './reconciler.ts'

// Feature layer: the real reconciler renders the desired state of a moved account; the host executor is a fake,
// so this proves what is written, never that nginx, Postfix or Dovecot accept it.
const ARGON2 = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const os = profileFor('ID=ubuntu\nVERSION_ID="24.04"\n')
const DESTINATION = '198.51.100.7'

describe('a live transfer source applied by the reconciler', () => {
  let state: TestStateStoreHandle
  let db: TestDbHandle
  let executor: FakeHostExecutor
  let reconciler: HostReconciler
  let accountId: string
  const content = (match: RegExp): string => [...executor.files.entries()].filter(([path]) => match.test(path)).map(([, file]) => file.content).join('\n')
  const move = (ipv4: string | null = DESTINATION) => atomicWriteJson(join(state.rootDir, movedStatePath(accountId)), { version: 1, ipv4, hostname: 'whm.destination.example.net', movedAt: '2026-11-07T10:00:00.000Z' })
  const reconcile = async () => expect((await reconciler.reconcile({ actor: 'root', mailAuth: null })).status).toBe('applied')

  beforeEach(async () => {
    state = await createTestStateStore()
    db = await createTestDb()
    executor = new FakeHostExecutor()
    reconciler = new HostReconciler({ store: state.store, db: db.db, executor, os })
    const features = await state.store.createFeatureList({ name: 'Mail', ownerId: null, disabled: [] })
    const plan = await state.store.createPlan({ name: 'Mail plan', ownerId: null, featureListId: features.id,
      resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
      caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 10, forwarders: 10, mailingLists: 5, ftpAccounts: 5, databases: 5, phpWorkers: 5 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
    await state.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
    const account = await state.store.createAccount({ username: 'alice', passwordHash: ARGON2, primaryDomain: 'alice-shop.com', planId: plan.id, ownerId: null, contactEmail: 'alice@example.test', ipv4: '192.0.2.10', shell: 'none',
      php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } })
    accountId = account.id
    await state.store.createServiceUser({ accountId, login: 'info@alice-shop.com', passwordHash: `{ARGON2ID}${ARGON2}`, services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: '' })
  })
  afterEach(async () => { await state.close(); await db.close() })

  it('hands the sites, mail and logins of a suspended moved account to the destination', async () => {
    await state.store.suspendAccount(accountId, 'Live transfer to whm.destination.example.net')
    await move()
    await reconcile()
    expect(content(/\/xpanel\/transport$/)).toContain(`alice-shop.com\tsmtp:[${DESTINATION}]:25`)
    expect(content(/\/xpanel\/recipient_access$/)).not.toContain('450 4.2.1')
    expect(content(/\/xpanel\/virtual_mailboxes$|\/xpanel\/mailboxes$/)).toContain('info@alice-shop.com')
    expect(content(/alice-shop\.com\.passwd$/)).toContain(`proxy=y host=${DESTINATION} starttls=any-cert`)
    expect(content(/alice-shop\.com\.passwd$/)).not.toContain('nologin=y')
    // the site renderer receives the address; live-move.test.ts covers what it renders
    expect(accountEdgeSiteOptions(await readAccountEdge(state.rootDir, [{ id: accountId }]), accountId)).toEqual({ accountEdge: { deny: [], cacheEpoch: null, movedTo: DESTINATION } })
  })

  it('defers mail while the account is frozen, so nothing lands after the final sync', async () => {
    await move(null)
    await state.store.suspendAccount(accountId, 'Live transfer to whm.destination.example.net')
    await reconcile()
    expect(content(/\/xpanel\/recipient_access$/)).toContain('450 4.2.1')
    expect(content(/\/xpanel\/transport$/)).not.toContain('smtp:[')
    expect(content(/alice-shop\.com\.passwd$/)).toContain('nologin=y')
  })

  it('leaves an ordinary suspension delivering as it did', async () => {
    await state.store.suspendAccount(accountId, 'billing')
    await reconcile()
    expect(content(/\/xpanel\/recipient_access$/)).not.toContain('450 4.2.1')
  })

  it('stops passing through once the account is active again', async () => {
    await state.store.suspendAccount(accountId, 'moved')
    await move()
    await reconcile()
    await state.store.unsuspendAccount(accountId, { allowLocked: true })
    await reconcile()
    expect(content(/\/xpanel\/transport$/)).not.toContain(DESTINATION)
    expect(content(/alice-shop\.com\.passwd$/)).not.toContain('proxy=y')
    await clearAccountMoved(state.rootDir, accountId)
    await removeAccountEdgeState(state.rootDir, accountId)
  })

  it('refuses a damaged moved record rather than dropping it', async () => {
    await atomicWriteJson(join(state.rootDir, movedStatePath(accountId)), { version: 1, ipv4: 'nowhere', hostname: 'x', movedAt: 'x' })
    await expect(reconciler.reconcile({ actor: 'root', mailAuth: null })).rejects.toThrow(/saved edge configuration is invalid/)
  })
})
