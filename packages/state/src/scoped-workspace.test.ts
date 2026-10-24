import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StateStore, createTestStateStore, type TestStateStoreHandle } from './store.ts'
import type { Account, FeatureList, Plan } from '@xpanel/core'

const publicHash = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

let handle: TestStateStoreHandle
let account: Account
let plan: Plan
let featureList: FeatureList
beforeEach(async () => {
  handle = await createTestStateStore()
  for (const address of ['192.0.2.10', '192.0.2.11']) await handle.store.saveServerIp({ address, version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: address === '192.0.2.10', notes: 'Diagnostic inventory' })
  featureList = await handle.store.createFeatureList({ name: 'Scoped features', ownerId: null, disabled: [] })
  plan = await handle.store.createPlan({ name: 'Scoped plan', ownerId: null, featureListId: featureList.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 'unlimited', ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 10, ioWriteIops: 10, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 1, aliasDomains: 1, subdomains: 1, mailboxes: 1, forwarders: 1, mailingLists: 1, ftpAccounts: 1, databases: 1, phpWorkers: 1 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100,
  })
  account = await handle.store.createAccount({ username: 'owner7', primaryDomain: 'owner7.example.test', passwordHash: publicHash, planId: plan.id, ownerId: null, contactEmail: 'owner7@example.test', ipv4: '192.0.2.10', shell: 'none',
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 1, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} },
  })
})
afterEach(async () => { vi.restoreAllMocks(); await handle.close() })
const hinted = () => handle.store.getAccount(account.id, { username: account.username })
const workspace = () => handle.store.readAccountWorkspace(account.id, { username: account.username })
const accountPath = () => join(handle.store.rootDir, 'accounts', account.username, 'account.json')

describe('fresh scoped account reads', () => {
  it('reads the canonical known account without scanning unrelated accounts', async () => {
    const unrelated = join(handle.store.rootDir, 'accounts', 'unrelated7')
    await mkdir(unrelated)
    await writeFile(join(unrelated, 'account.json'), '{corrupt unrelated fixture')
    expect(await hinted()).toEqual(account)
    const result = await workspace()
    expect(result).toEqual({ account, plan, featureList })
    await expect(handle.store.getAccount(account.id)).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it.each(['alias7', '../outside', '/absolute', 'Owner7'])('retains ID authority when a trusted hint is %s', async username => {
    expect(await handle.store.getAccount(account.id, { username })).toEqual(account)
    expect(await handle.store.readAccountWorkspace(account.id, { username })).toEqual({ account, plan, featureList })
    expect(await handle.store.getAccount(randomUUID(), { username: account.username })).toBeNull()
  })

  it('observes suspension and reactivation immediately without authorization caching', async () => {
    expect((await hinted())?.status).toBe('active')
    await handle.store.suspendAccount(account.id, 'Fixture suspension')
    expect((await hinted())?.status).toBe('suspended')
    expect((await workspace()).account?.status).toBe('suspended')
    await handle.store.unsuspendAccount(account.id)
    expect((await hinted())?.status).toBe('active')
  })

  it('refuses a directory whose account username no longer matches its canonical file', async () => {
    const raw = JSON.parse(await readFile(accountPath(), 'utf8')) as Record<string, unknown>
    await writeFile(accountPath(), JSON.stringify({ ...raw, username: 'other7', home: '/home/other7' }))
    expect(await hinted()).toBeNull()
    expect((await workspace()).account).toBeNull()
  })

  it('does not accept a linked plan with a different persisted ID', async () => {
    await writeFile(join(handle.store.rootDir, 'plans', plan.id + '.json'), JSON.stringify({ ...plan, id: randomUUID() }))
    expect(await workspace()).toEqual({ account, plan: null, featureList: null })
  })

  it('does not accept a linked feature list with a different persisted ID', async () => {
    await writeFile(join(handle.store.rootDir, 'feature-lists', featureList.id + '.json'), JSON.stringify({ ...featureList, id: randomUUID() }))
    expect(await workspace()).toEqual({ account, plan, featureList: null })
  })

  it('does not allocate a public reference or change the state revision when taking a read lease', async () => {
    const before = await handle.store.getAuthorityMetadata()
    await workspace()
    const after = await handle.store.getAuthorityMetadata()
    expect(after.revision).toBe(before.revision)
    expect(after.fencingToken).toBeGreaterThan(before.fencingToken)
    expect(after.references).toEqual(before.references)
    expect(after.allocatedReferences).toEqual(before.allocatedReferences)
    expect(await handle.store.getWriterLock().readLockHolder()).toBeNull()
  })
})

describe('scoped database metadata reads', () => {
  const databases = () => handle.store.readAccountDatabases(account.id, { username: account.username })

  it('reads active databases and public users despite corrupt unrelated state, without allocating references', async () => {
    const trashed = await handle.store.createDatabase({ accountId: account.id, name: 'owner7_trashed' })
    const user = await handle.store.createDatabaseUser({ accountId: account.id, name: 'owner7_app', authPlugin: 'ed25519', authString: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq' })
    const granted = await handle.store.setGrant({ databaseUserId: user.id, databaseId: trashed.id, privileges: ['SELECT'] })
    await handle.store.trashDatabase(trashed.id)
    const live = await handle.store.createDatabase({ accountId: account.id, name: 'owner7_live' })
    const unrelated = join(handle.store.rootDir, 'accounts', 'unrelated7')
    await mkdir(unrelated)
    await writeFile(join(unrelated, 'account.json'), '{corrupt unrelated fixture')
    const before = await handle.store.getAuthorityMetadata()
    expect(await databases()).toEqual({ databases: [live], databaseUsers: [granted] })
    expect(JSON.stringify(await databases())).not.toMatch(/authString|authPlugin|passwordHash/)
    const after = await handle.store.getAuthorityMetadata()
    expect(after.revision).toBe(before.revision)
    expect(after.references).toEqual(before.references)
    expect(after.allocatedReferences).toEqual(before.allocatedReferences)
    expect(await handle.store.getWriterLock().readLockHolder()).toBeNull()
  })

  it('keeps the account ID authoritative for incorrect hints and missing accounts', async () => {
    const live = await handle.store.createDatabase({ accountId: account.id, name: 'owner7_live' })
    expect(await handle.store.readAccountDatabases(account.id, { username: 'alias7' })).toEqual({ databases: [live], databaseUsers: [] })
    expect(await handle.store.readAccountDatabases(randomUUID(), { username: account.username })).toEqual({ databases: [], databaseUsers: [] })
  })

  it('rejects corrupt owned metadata instead of reporting an empty database count', async () => {
    await mkdir(join(handle.store.rootDir, 'accounts', account.username, 'databases'))
    await writeFile(join(handle.store.rootDir, 'accounts', account.username, 'databases', 'broken.json'), '{corrupt owned fixture')
    await expect(databases()).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(await handle.store.getWriterLock().readLockHolder()).toBeNull()
  })
})

describe('workspace read lease consistency', () => {
  it('waits for a same-instance active mutation instead of treating activeLease as request ownership', async () => {
    let resume!: () => void
    let entered!: () => void
    const enteredPromise = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { resume = resolve })
    handle.store.setHooks({ onBeforeAccountCommit: async () => { entered(); await gate } })
    const writer = handle.store.createAccount({ username: 'writer7', primaryDomain: 'writer7.example.test', passwordHash: publicHash, planId: plan.id, ownerId: null, contactEmail: 'writer7@example.test', ipv4: '192.0.2.11', shell: 'none',
      php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 1, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} },
    })
    await enteredPromise
    let settled = false
    const reader = workspace().finally(() => { settled = true })
    try { await delay(25); expect(settled).toBe(false) } finally { resume() }
    await writer
    expect((await reader).account?.id).toBe(account.id)
  })

  it('waits through an external aborted authority restore and never exposes intermediate file contents', async () => {
    const external = new StateStore(handle.store.rootDir)
    const lease = await external.getWriterLock().acquire()
    const original = await readFile(accountPath(), 'utf8')
    const raw = JSON.parse(original) as Record<string, unknown>
    await writeFile(accountPath(), JSON.stringify({ ...raw, status: 'suspended', suspendReason: 'Intermediate fixture write', suspendedAt: new Date().toISOString() }))
    let settled = false
    const reader = workspace().finally(() => { settled = true })
    try {
      await delay(25)
      expect(settled).toBe(false)
      await writeFile(accountPath(), original)
      await lease.restorePreAcquireAuthorityIfUncommitted()
    } finally { await lease.release() }
    expect((await reader).account?.status).toBe('active')
  })

  it('prevents an external writer from mixing a new plan into an in-flight projection', async () => {
    const otherPlan = await handle.store.createPlan({ ...plan, name: 'Second scoped plan' })
    const external = new StateStore(handle.store.rootDir)
    const getPlan = handle.store.getPlan.bind(handle.store)
    let resume!: () => void
    let entered!: () => void
    const enteredPromise = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { resume = resolve })
    vi.spyOn(handle.store, 'getPlan').mockImplementationOnce(async id => { entered(); await gate; return getPlan(id) })
    const reader = workspace()
    await enteredPromise
    let written = false
    const writer = external.changePlan(account.id, otherPlan.id).then(() => { written = true })
    try { await delay(25); expect(written).toBe(false) } finally { resume() }
    expect((await reader).plan?.id).toBe(plan.id)
    await writer
    expect((await workspace()).plan?.id).toBe(otherPlan.id)
  })

  it('releases its read lease when a linked file is corrupt', async () => {
    await writeFile(join(handle.store.rootDir, 'plans', plan.id + '.json'), '{corrupt fixture')
    await expect(workspace()).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(await handle.store.getWriterLock().readLockHolder()).toBeNull()
    const lease = await new StateStore(handle.store.rootDir).getWriterLock().acquire()
    await lease.release()
  })
})
