import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StateStore, createTestStateStore } from './store.ts'
import type { TestStateStoreHandle } from './store.ts'
import type { NewAccount } from './types.ts'

// Local state only. A callback must use local host ports, never agent self-RPC.
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
let handle: TestStateStoreHandle, planId: string
const input = (): NewAccount => ({ username: 'lease9', passwordHash: HASH, primaryDomain: 'lease9.example.test', planId, ownerId: null, contactEmail: 'lease9@example.test', ipv4: '192.0.2.10', shell: 'none',
  php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 1, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } })
beforeEach(async () => {
  handle = await createTestStateStore()
  await handle.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: 'Synthetic lifecycle lease' })
  const features = await handle.store.createFeatureList({ name: 'Lease fixture features', ownerId: null, disabled: [] })
  planId = (await handle.store.createPlan({ name: 'Lease fixture plan', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 1000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 10, ioWriteIops: 10, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 1, aliasDomains: 1, subdomains: 1, mailboxes: 1, forwarders: 1, mailingLists: 1, ftpAccounts: 1, databases: 1, phpWorkers: 1 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })).id
})
afterEach(async () => { vi.restoreAllMocks(); await handle.close() })

describe('immutable active account operation lifetime', () => {
  it('excludes termination from another StateStore until the local host operation finishes', async () => {
    const account = await handle.store.createAccount(input()), external = new StateStore(handle.rootDir)
    const entered = deferred(), release = deferred(), attempted = deferred(), events: string[] = []
    const lock = external.getWriterLock(), acquire = lock.acquire.bind(lock)
    vi.spyOn(lock, 'acquire').mockImplementation(async (...args) => { attempted.resolve(); return acquire(...args) })
    const operation = handle.store.withAccountLifecycleLease(account.id, async fresh => { expect(fresh.id).toBe(account.id); events.push('operation-start'); entered.resolve(); await release.promise; events.push('operation-end'); return fresh.uid })
    await entered.promise
    let terminated = false
    const writer = external.markTerminating(account.id).then(result => { terminated = true; events.push('terminating'); return result })
    try { await attempted.promise; expect(terminated).toBe(false); expect(events).toEqual(['operation-start']) }
    finally { release.resolve() }
    expect(await operation).toBe(account.uid); expect((await writer).status).toBe('terminating')
    expect(events).toEqual(['operation-start', 'operation-end', 'terminating'])
  })
  it('does not advance desired-state revision and releases the lock after success or failure', async () => {
    const account = await handle.store.createAccount(input()), before = await handle.store.getRevision()
    expect(await handle.store.withAccountLifecycleLease(account.id, async fresh => ({ id: fresh.id, home: fresh.home }))).toEqual({ id: account.id, home: account.home })
    expect(await handle.store.getRevision()).toBe(before); expect(await handle.store.getWriterLock().readLockHolder()).toBeNull()
    const failure = new Error('declared local host failure')
    await expect(handle.store.withAccountLifecycleLease(account.id, async () => { throw failure })).rejects.toBe(failure)
    expect(await handle.store.getRevision()).toBe(before); expect(await handle.store.getWriterLock().readLockHolder()).toBeNull()
    expect((await handle.store.withAccountLifecycleLease(account.id, async fresh => fresh)).id).toBe(account.id)
  })
  it('refuses a terminating lifetime and never transfers a stale id to a reused username', async () => {
    const previous = await handle.store.createAccount(input()), effect = vi.fn(async () => true)
    await handle.store.markTerminating(previous.id)
    await expect(handle.store.withAccountLifecycleLease(previous.id, effect)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' }); expect(effect).not.toHaveBeenCalled()
    expect(await handle.store.deleteAccount(previous.id)).toBe(true)
    const replacement = await handle.store.createAccount(input())
    expect(replacement.username).toBe(previous.username); expect(replacement.id).not.toBe(previous.id); expect(replacement.uid).not.toBe(previous.uid)
    await expect(handle.store.withAccountLifecycleLease(previous.id, effect)).rejects.toMatchObject({ code: 'NOT_FOUND' }); expect(effect).not.toHaveBeenCalled()
    expect(await handle.store.withAccountLifecycleLease(replacement.id, async fresh => fresh.id)).toBe(replacement.id)
  })
  it('fails promptly if a callback attempts a public snapshot or nested mutation', async () => {
    const account = await handle.store.createAccount(input()), before = await handle.store.getRevision()
    await expect(handle.store.withAccountLifecycleLease(account.id, async () => handle.store.readSnapshot())).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(handle.store.withAccountLifecycleLease(account.id, async () => handle.store.markTerminating(account.id))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect((await handle.store.getAccount(account.id))?.status).toBe('active'); expect(await handle.store.getRevision()).toBe(before)
  })
})