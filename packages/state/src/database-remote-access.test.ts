import { link, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { databaseRemoteAccessRevision } from '@xpanel/core'
import type { DatabaseRemoteAccessSnapshot } from '@xpanel/core'
import { createTestStateStore } from './store.ts'
import type { TestStateStoreHandle } from './store.ts'
const passwordHash = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const entry = { host: '192.0.2.0/24', comment: 'Office', createdAt: '2026-10-27T00:00:00.000Z' }
let handle: TestStateStoreHandle, accountId: string, accountPath: string
beforeEach(async () => {
  handle = await createTestStateStore()
  const store = handle.store
  await store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: 'Synthetic remote database fixture' })
  const features = await store.createFeatureList({ name: 'Remote fixture features', ownerId: null, disabled: [] })
  const plan = await store.createPlan({ name: 'Remote fixture plan', ownerId: null, featureListId: features.id, resources: { diskMb: 1000, bandwidthMbMonth: 1000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 10, ioWriteIops: 10, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 }, caps: { addonDomains: 1, aliasDomains: 1, subdomains: 1, mailboxes: 1, forwarders: 1, mailingLists: 1, ftpAccounts: 1, databases: 2, phpWorkers: 1 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  const account = await store.createAccount({ username: 'remote9', passwordHash, primaryDomain: 'remote9.example.test', planId: plan.id, ownerId: null, contactEmail: 'remote9@example.test', ipv4: '192.0.2.10', shell: 'none', php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 1, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } })
  accountId = account.id; accountPath = join(store.rootDir, 'accounts', account.username, 'account.json')
  const db = await store.createDatabase({ accountId, name: 'remote9_app' })
  await store.createDatabaseUser({ accountId, name: 'remote9_user', authPlugin: 'mysql_native_password', authString: '*' + 'A'.repeat(40), initialGrant: { databaseId: db.id, privileges: ['SELECT'] } })
})
afterEach(async () => { vi.restoreAllMocks(); await handle.close() })
const read = () => handle.store.readDatabaseRemoteAccess(accountId)
describe('canonical remote database policy StateStore lease', () => {
  it('roundtrips one canonical source through account/public/snapshot and fences all stored grant/auth changes', async () => {
    const before = await read(), revision = databaseRemoteAccessRevision(before), desiredRevision = await handle.store.getRevision()
    await handle.store.withDatabaseRemoteAccessLease(accountId, revision, async (snapshot, tx) => { expect(snapshot.users[0]?.authString).toBe('*' + 'A'.repeat(40)); tx.onAbort(async () => undefined); await tx.commit([entry]) })
    const after = await read()
    expect(after.account.databaseRemoteAccess).toEqual([entry]); expect((await handle.store.getAccount(accountId))?.databaseRemoteAccess).toEqual([entry])
    expect((await handle.store.readSnapshot()).accounts.find(row => row.id === accountId)?.databaseRemoteAccess).toEqual([entry])
    expect(await handle.store.getRevision()).toBe(desiredRevision + 1)
    expect(after.users).toEqual(before.users); expect(after.databases).toEqual(before.databases)
    const called = vi.fn(async () => undefined)
    await expect(handle.store.withDatabaseRemoteAccessLease(accountId, revision, called)).rejects.toMatchObject({ code: 'CONFLICT' }); expect(called).not.toHaveBeenCalled()
    const current = databaseRemoteAccessRevision(after)
    await handle.store.setDatabaseUserAuth(after.users[0]!.id, '*' + 'B'.repeat(40), 'mysql_native_password')
    expect(databaseRemoteAccessRevision(await read())).not.toBe(current)
    expect(await handle.store.getWriterLock().readLockHolder()).toBeNull()
  })
  it('compensates under the writer lease and restores exact account bytes/revision after a postwrite failure', async () => {
    const before = await read(), source = await readFile(accountPath), revision = await handle.store.getRevision(), restore = vi.fn(async () => { expect(await handle.store.getWriterLock().readLockHolder()).not.toBeNull() })
    await expect(handle.store.withDatabaseRemoteAccessLease(accountId, databaseRemoteAccessRevision(before), async (_snapshot, tx) => { tx.onAbort(restore); await tx.commit([entry]); throw new Error('synthetic audit failure') })).rejects.toThrow()
    expect(restore).toHaveBeenCalledOnce(); expect(await readFile(accountPath)).toEqual(source); expect(await handle.store.getRevision()).toBe(revision)
    expect((await read()).account.databaseRemoteAccess ?? []).toEqual([])
  })
  it('refuses nested snapshots/mutations and duplicate commit/recovery registration without deadlocking', async () => {
    for (const kind of ['snapshot', 'mutation', 'commit', 'registration'] as const) {
      const snapshot = await read()
      await expect(handle.store.withDatabaseRemoteAccessLease(accountId, databaseRemoteAccessRevision(snapshot), async (_snapshot, tx) => {
        tx.onAbort(async () => undefined)
        if (kind === 'snapshot') await handle.store.readSnapshot()
        if (kind === 'mutation') await handle.store.markTerminating(accountId)
        if (kind === 'registration') tx.onAbort(async () => undefined)
        await tx.commit([entry]); if (kind === 'commit') await tx.commit([entry])
      })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
      expect(await handle.store.getWriterLock().readLockHolder()).toBeNull()
    }
  })
  it('refuses a source swap between coherent snapshot and preimage before invoking any native callback', async () => {
    const initial = await read(), callback = vi.fn(async () => undefined)
    const boundary = handle.store as unknown as { databaseRemoteAccessUnlocked(id: string): Promise<DatabaseRemoteAccessSnapshot> }
    const original = boundary.databaseRemoteAccessUnlocked.bind(handle.store)
    vi.spyOn(boundary, 'databaseRemoteAccessUnlocked').mockImplementationOnce(async id => { const snapshot = await original(id); const source = JSON.parse(await readFile(accountPath, 'utf8')); await writeFile(accountPath, JSON.stringify({ ...source, contactEmail: 'external@example.test' })); return snapshot })
    await expect(handle.store.withDatabaseRemoteAccessLease(accountId, databaseRemoteAccessRevision(initial), callback)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(callback).not.toHaveBeenCalled(); expect((await handle.store.getAccount(accountId))?.contactEmail).toBe('external@example.test')
  })
  it('preserves an externally replaced inode before commit while compensating native work', async () => {
    const initial = await read(), source = JSON.parse(await readFile(accountPath, 'utf8')), external = Buffer.from(JSON.stringify({ ...source, contactEmail: 'external@example.test' })), restore = vi.fn(async () => undefined)
    await expect(handle.store.withDatabaseRemoteAccessLease(accountId, databaseRemoteAccessRevision(initial), async (_snapshot, tx) => { tx.onAbort(restore); const staging = accountPath + '.external-test'; await writeFile(staging, external); await rename(staging, accountPath); await tx.commit([entry]) })).rejects.toThrow()
    expect(restore).toHaveBeenCalledOnce(); expect(await readFile(accountPath)).toEqual(external)
    expect((await handle.store.getAccount(accountId))?.databaseRemoteAccess ?? []).toEqual([])
    await read().catch(() => null)
    expect(await readFile(accountPath)).toEqual(external)
  })
  it('preserves an external postcommit edit and refuses an acknowledgement', async () => {
    const initial = await read(), restore = vi.fn(async () => undefined)
    await expect(handle.store.withDatabaseRemoteAccessLease(accountId, databaseRemoteAccessRevision(initial), async (_snapshot, tx) => { tx.onAbort(restore); await tx.commit([entry]); const written = JSON.parse(await readFile(accountPath, 'utf8')); await writeFile(accountPath, JSON.stringify({ ...written, contactEmail: 'postcommit@example.test' })) })).rejects.toThrow()
    expect(restore).toHaveBeenCalledOnce(); expect((await handle.store.getAccount(accountId))?.contactEmail).toBe('postcommit@example.test')
    const external = await readFile(accountPath)
    await read().catch(() => null)
    expect(await readFile(accountPath)).toEqual(external)
  })
  it('keeps a stopped-writer hold when the published account inode becomes multiply linked before final readback', async () => {
    const initial = await read(), restore = vi.fn(async () => undefined)
    await expect(handle.store.withDatabaseRemoteAccessLease(accountId, databaseRemoteAccessRevision(initial), async (_snapshot, tx) => { tx.onAbort(restore); await tx.commit([entry]); await link(accountPath, accountPath + '.external-link') })).rejects.toThrow()
    expect(restore).toHaveBeenCalledOnce()
    const preserved = await readFile(accountPath)
    expect(JSON.parse(preserved.toString('utf8')).databaseRemoteAccess).toEqual([entry])
    expect((await readdir(handle.rootDir)).filter(name => name.startsWith('.remote-access-review-'))).toHaveLength(1)
    await expect(read()).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await readFile(accountPath)).toEqual(preserved)
  })
})
