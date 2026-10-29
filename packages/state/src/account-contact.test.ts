import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { accountContactRevision, fail, type Account } from '@xpanel/core'
import { createTestStateStore, type TestStateStoreHandle } from './store.ts'

const fixtures: TestStateStoreHandle[] = []
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close() })

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const fixture = async () => {
  const handle = await createTestStateStore()
  fixtures.push(handle)
  const features = await handle.store.createFeatureList({ name: 'Contact policy', ownerId: null, disabled: [] })
  const plan = await handle.store.createPlan({
    name: 'Contact plan', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 4, forwarders: 4, mailingLists: 5, ftpAccounts: 5, databases: 5, phpWorkers: 5 },
    dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100,
  })
  await handle.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const account = await handle.store.createAccount({
    username: 'contact9', passwordHash: HASH, primaryDomain: 'contact9.example.test',
    planId: plan.id, ownerId: null, contactEmail: 'Alice@example.test', ipv4: '192.0.2.10', shell: 'none',
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} },
  })
  const indexed = { email: account.contactEmail }
  const ports = {
    expectedContactRevision: accountContactRevision(account),
    authorize: vi.fn(async (_current: Account) => {}),
    prepareIndex: vi.fn(async (_current: Account) => {
      const previous = indexed.email
      return async () => { indexed.email = previous }
    }),
    synchronizeIndex: vi.fn(async (updated: Account) => { indexed.email = updated.contactEmail }),
  }
  return { ...handle, account, indexed, ports, accountPath: join(handle.rootDir, 'accounts', account.username, 'account.json') }
}

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('contact email state transaction; isolated callbacks, no native or delivery proof', () => {
  it('canonicalizes contact email and synchronizes the public index before authority commit', async () => {
    const f = await fixture()
    const before = await f.store.getAuthorityMetadata()
    const authorityPath = f.store.getWriterLock().authorityFilePath
    let synchronizedBeforeCommit = false
    const updated = await f.store.updateAccountContactEmail(f.account.id, 'Changed@EXAMPLE.TEST', {
      ...f.ports,
      synchronizeIndex: async current => {
        expect(current).not.toHaveProperty('passwordHash')
        expect(current.contactEmail).toBe('Changed@example.test')
        const authority = JSON.parse(await readFile(authorityPath, 'utf8')) as { revision: number }
        synchronizedBeforeCommit = authority.revision === before.revision
        await f.ports.synchronizeIndex(current)
      },
    })
    expect(updated).toEqual({ ...f.account, contactEmail: 'Changed@example.test' })
    expect(updated).not.toHaveProperty('passwordHash')
    expect(f.ports.authorize).toHaveBeenCalledWith(f.account)
    expect(f.ports.prepareIndex).toHaveBeenCalledWith(f.account)
    expect(synchronizedBeforeCommit).toBe(true)
    expect(f.indexed.email).toBe(updated.contactEmail)
    expect((await f.store.getAccount(f.account.id))?.contactEmail).toBe(updated.contactEmail)
    expect((await f.store.getAuthorityMetadata()).revision).toBe(before.revision + 1)
    await expect(readFile(f.store.getWriterLock().intentFilePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('authorizes the fresh account before rejecting a stale representation tag without preparing or writing', async () => {
    const f = await fixture()
    const raw = await readFile(f.accountPath)
    await expect(f.store.updateAccountContactEmail(f.account.id, 'Changed@example.test', {
      ...f.ports, expectedContactRevision: '0'.repeat(64),
    })).rejects.toMatchObject({ code: 'CONFLICT', detail: { reason: 'contact_revision_conflict', stateChanged: false } })
    expect(f.ports.authorize).toHaveBeenCalledOnce()
    expect(f.ports.authorize).toHaveBeenCalledWith(f.account)
    expect(f.ports.prepareIndex).not.toHaveBeenCalled()
    expect(f.ports.synchronizeIndex).not.toHaveBeenCalled()
    expect(await readFile(f.accountPath)).toEqual(raw)
    expect(f.indexed.email).toBe(f.account.contactEmail)
  })

  it('denies current authorization before index preparation or account-file effects', async () => {
    const f = await fixture()
    const raw = await readFile(f.accountPath)
    const denied = vi.fn(async () => { fail('FORBIDDEN', 'synthetic current policy denial') })
    await expect(f.store.updateAccountContactEmail(f.account.id, 'Changed@example.test', {
      ...f.ports, authorize: denied,
    })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(denied).toHaveBeenCalledOnce()
    expect(f.ports.prepareIndex).not.toHaveBeenCalled()
    expect(f.ports.synchronizeIndex).not.toHaveBeenCalled()
    expect(await readFile(f.accountPath)).toEqual(raw)
    expect(f.indexed.email).toBe(f.account.contactEmail)
  })

  it('restores exact raw account bytes and the prepared index preimage on ordinary synchronization failure', async () => {
    const f = await fixture()
    const raw = ' \n' + JSON.stringify(JSON.parse(await readFile(f.accountPath, 'utf8')), null, 3) + '\r\n\n'
    await writeFile(f.accountPath, raw)
    const before = await f.store.getAuthorityMetadata()
    let restored = 0
    await expect(f.store.updateAccountContactEmail(f.account.id, 'Changed@example.test', {
      ...f.ports,
      prepareIndex: async () => {
        const preimage = f.indexed.email
        return async () => { restored++; f.indexed.email = preimage }
      },
      synchronizeIndex: async current => {
        f.indexed.email = current.contactEmail
        throw new Error('synthetic synchronization failure after index effect')
      },
    })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { reason: 'contact_index_failed', verificationRequired: true, stateChanged: false } })
    expect(restored).toBe(1)
    expect(await readFile(f.accountPath, 'utf8')).toBe(raw)
    expect(f.indexed.email).toBe(f.account.contactEmail)
    expect((await f.store.getAuthorityMetadata()).revision).toBe(before.revision)
    await expect(readFile(f.store.getWriterLock().intentFilePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('completes rollback under the retained lease before a queued newer contact update can commit', async () => {
    const f = await fixture()
    const entered = deferred(), release = deferred()
    const events: string[] = []
    let enteredSync = false
    const first = f.store.updateAccountContactEmail(f.account.id, 'First@example.test', {
      ...f.ports,
      prepareIndex: async () => {
        const preimage = f.indexed.email
        return async () => { events.push('restore'); f.indexed.email = preimage }
      },
      synchronizeIndex: async current => {
        enteredSync = true
        events.push('first-sync')
        f.indexed.email = current.contactEmail
        entered.resolve()
        await release.promise
        throw new Error('synthetic first synchronization failure')
      },
    }).then(value => ({ value, error: null }), error => ({ value: null, error }))
    void first.then(() => entered.resolve())
    await entered.promise
    let secondAuthorized = false
    const second = f.store.updateAccountContactEmail(f.account.id, 'Latest@example.test', {
      ...f.ports,
      authorize: async current => {
        secondAuthorized = true
        events.push('second-authorize')
        expect(current.contactEmail).toBe(f.account.contactEmail)
      },
      synchronizeIndex: async current => { events.push('second-sync'); f.indexed.email = current.contactEmail },
    })
    await Promise.resolve()
    const authorizedBeforeRelease = secondAuthorized
    release.resolve()
    const [failed, updated] = await Promise.all([first, second])
    expect(enteredSync).toBe(true)
    expect(authorizedBeforeRelease).toBe(false)
    expect(failed.error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: false } })
    expect(events).toEqual(['first-sync', 'restore', 'second-authorize', 'second-sync'])
    expect(updated.contactEmail).toBe('Latest@example.test')
    expect(f.indexed.email).toBe(updated.contactEmail)
    expect((await f.store.getAccount(f.account.id))?.contactEmail).toBe(updated.contactEmail)
  })

  it('propagates preparation failure before any file write or synchronization effect', async () => {
    const f = await fixture()
    const raw = await readFile(f.accountPath)
    const failure = new Error('synthetic index preimage read failure')
    await expect(f.store.updateAccountContactEmail(f.account.id, 'Changed@example.test', {
      ...f.ports, prepareIndex: async () => { throw failure },
    })).rejects.toBe(failure)
    expect(f.ports.authorize).toHaveBeenCalledWith(f.account)
    expect(f.ports.synchronizeIndex).not.toHaveBeenCalled()
    expect(await readFile(f.accountPath)).toEqual(raw)
    expect(f.indexed.email).toBe(f.account.contactEmail)
    await expect(readFile(f.store.getWriterLock().intentFilePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains the raw-file intent and reports uncertainty when prepared index restoration fails', async () => {
    const f = await fixture()
    const raw = await readFile(f.accountPath)
    await expect(f.store.updateAccountContactEmail(f.account.id, 'Changed@example.test', {
      ...f.ports,
      prepareIndex: async () => async () => { throw new Error('synthetic index restore failure') },
      synchronizeIndex: async current => { f.indexed.email = current.contactEmail; throw new Error('synthetic synchronization failure') },
    })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      detail: { reason: 'contact_index_failed', verificationRequired: true, stateChanged: true, unknownOutcome: true },
    })
    const intent = JSON.parse(await readFile(f.store.getWriterLock().intentFilePath, 'utf8')) as {
      op: string; backups: { relPath: string; existed: boolean; contentBase64: string }[]
    }
    expect(intent.op).toBe('updateAccountContactEmail')
    expect(intent.backups).toHaveLength(1)
    expect(intent.backups[0]?.relPath).toBe(`accounts/${f.account.username}/account.json`)
    expect(intent.backups[0]?.existed).toBe(true)
    expect(Buffer.from(intent.backups[0]!.contentBase64, 'base64')).toEqual(raw)
    expect((await f.store.getAccount(f.account.id))?.contactEmail).toBe('Changed@example.test')
  })
})
