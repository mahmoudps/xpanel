import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestStateStore } from './store.ts'
import type { TestStateStoreHandle } from './store.ts'
import { postgresqlScramVerifier } from './pg-state.ts'

const passwordHash = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const verifier = postgresqlScramVerifier('pencil-pencil', Buffer.alloc(16, 3)), other = postgresqlScramVerifier('another-secret', Buffer.alloc(16, 4))
let handle: TestStateStoreHandle, accountId: string
beforeEach(async () => {
  handle = await createTestStateStore()
  const store = handle.store
  await store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: 'Synthetic PostgreSQL fixture' })
  const features = await store.createFeatureList({ name: 'PostgreSQL fixture features', ownerId: null, disabled: [] })
  const plan = await store.createPlan({ name: 'PostgreSQL fixture plan', ownerId: null, featureListId: features.id, resources: { diskMb: 1000, bandwidthMbMonth: 1000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 10, ioWriteIops: 10, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 }, caps: { addonDomains: 1, aliasDomains: 1, subdomains: 1, mailboxes: 1, forwarders: 1, mailingLists: 1, ftpAccounts: 1, databases: 2, phpWorkers: 1 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  const account = await store.createAccount({ username: 'pgfix', passwordHash, primaryDomain: 'pgfix.example.test', planId: plan.id, ownerId: null, contactEmail: 'pgfix@example.test', ipv4: '192.0.2.10', shell: 'none', php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 1, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } })
  accountId = account.id
})
afterEach(async () => { await handle.close() })

describe('PostgreSQL desired state', () => {
  it('saves users and owned databases in files, keeps verifiers out of reads and shares the plan database limit with MariaDB', async () => {
    const store = handle.store
    const user = await store.createPostgresqlUser({ accountId, name: 'pgfix_app', authString: verifier })
    expect(user).toEqual({ id: user.id, accountId, name: 'pgfix_app' })
    await expect(store.createPostgresqlUser({ accountId, name: 'pgfix_app', authString: verifier })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(store.createPostgresqlDatabase({ accountId, name: 'pgfix_shop', owner: 'pgfix_none' })).rejects.toThrow()
    const shop = await store.createPostgresqlDatabase({ accountId, name: 'pgfix_shop', owner: 'pgfix_app' })
    expect(shop).toMatchObject({ engine: 'postgresql', name: 'pgfix_shop', owner: 'pgfix_app', trashedAt: null })
    await store.createDatabase({ accountId, name: 'pgfix_maria' })
    await expect(store.createPostgresqlDatabase({ accountId, name: 'pgfix_more', owner: 'pgfix_app' })).rejects.toThrow()
    await expect(store.createDatabase({ accountId, name: 'pgfix_maria2' })).rejects.toThrow()
    const read = await store.readAccountPostgresql(accountId)
    expect(read).toEqual({ databases: [shop], users: [user] }); expect(JSON.stringify(read)).not.toContain('SCRAM')
    const file = JSON.parse(await readFile(join(store.rootDir, 'accounts', 'pgfix', 'postgresql', 'users', 'pgfix_app.json'), 'utf8'))
    expect(file.authString).toBe(verifier)
    const snapshot = await store.readSnapshot()
    expect(snapshot.postgresqlDatabases).toEqual([shop]); expect(snapshot.postgresqlUsers?.[0]?.authString).toBe(verifier)
    expect(snapshot.databases.map(database => database.name)).toEqual(['pgfix_maria'])
  })
  it('trashes and restores with the owner guard, purges only from the trash and deletes a user only after its databases', async () => {
    const store = handle.store
    const user = await store.createPostgresqlUser({ accountId, name: 'pgfix_app', authString: verifier })
    const shop = await store.createPostgresqlDatabase({ accountId, name: 'pgfix_shop', owner: 'pgfix_app' })
    await expect(store.purgePostgresqlDatabase({ accountId, id: shop.id })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(store.setPostgresqlDatabaseTrash({ accountId, id: shop.id, action: 'trash' }, { stateGuard: { expectedTrashedAt: null, confirmation: 'pgfix_other' } })).rejects.toMatchObject({ code: 'CONFLICT' })
    const trashed = await store.setPostgresqlDatabaseTrash({ accountId, id: shop.id, action: 'trash' }, { stateGuard: { expectedTrashedAt: null, confirmation: 'pgfix_shop' } })
    expect(trashed.trashedAt).toMatch(/Z$/)
    await expect(store.deletePostgresqlUser({ accountId, id: user.id })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    const restored = await store.setPostgresqlDatabaseTrash({ accountId, id: shop.id, action: 'restore' }, { stateGuard: { expectedTrashedAt: trashed.trashedAt, confirmation: 'pgfix_shop' } })
    expect(restored.trashedAt).toBeNull()
    await store.setPostgresqlDatabaseTrash({ accountId, id: shop.id, action: 'trash' })
    expect(await store.purgePostgresqlDatabase({ accountId, id: shop.id })).toMatchObject({ name: 'pgfix_shop' })
    expect((await store.setPostgresqlUserPassword({ accountId, id: user.id, authString: other })).name).toBe('pgfix_app')
    expect((await store.readSnapshot()).postgresqlUsers?.[0]?.authString).toBe(other)
    await expect(store.setPostgresqlUserPassword({ accountId, id: user.id, authString: 'plain' })).rejects.toThrow()
    await store.deletePostgresqlUser({ accountId, id: user.id })
    expect(await store.readAccountPostgresql(accountId)).toEqual({ databases: [], users: [] })
    expect((await store.readSnapshot()).postgresqlUsers).toBeUndefined()
  })
  it('carries PostgreSQL state through a validated generation snapshot and restore', async () => {
    const store = handle.store
    await store.createPostgresqlUser({ accountId, name: 'pgfix_app', authString: verifier })
    const shop = await store.createPostgresqlDatabase({ accountId, name: 'pgfix_shop', owner: 'pgfix_app' })
    const saved = await store.saveGenerationSnapshot(1)
    expect((await store.readValidatedGenerationSnapshot(1))?.postgresqlDatabases).toEqual([shop])
    await store.setPostgresqlDatabaseTrash({ accountId, id: shop.id, action: 'trash' })
    await store.restoreGenerationSnapshot(1)
    expect((await store.readAccountPostgresql(accountId)).databases).toEqual([shop])
    expect((await store.readSnapshot()).checksum).toBe(saved.checksum)
  })
})
