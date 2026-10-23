import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StateStore, createTestStateStore, type TestStateStoreHandle } from './store.ts'
import type { NewAccount } from './types.ts'

const io = vi.hoisted(() => ({ afterRead: null as null | ((path: string, value: unknown) => Promise<unknown>) }))
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...fs,
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      const value = await fs.readFile(...args)
      return io.afterRead ? io.afterRead(String(args[0]).replace(/\\/g, '/'), value) : value
    },
  }
})

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

let handle: TestStateStoreHandle
let featureId: string
let planId: string
const accountInput = (): NewAccount => ({
  username: 'snapshot7', passwordHash: HASH, primaryDomain: 'snapshot7.example.test', planId, ownerId: null,
  contactEmail: 'snapshot7@example.test', ipv4: '192.0.2.10', shell: 'none',
  php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 1, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} },
})
beforeEach(async () => {
  io.afterRead = null
  handle = await createTestStateStore()
  featureId = (await handle.store.createFeatureList({ name: 'Stable features', ownerId: null, disabled: [] })).id
  planId = (await handle.store.createPlan({
    name: 'Snapshot plan', ownerId: null, featureListId: featureId,
    resources: { diskMb: 1000, bandwidthMbMonth: 1000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 10, ioWriteIops: 10, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 1, aliasDomains: 1, subdomains: 1, mailboxes: 1, forwarders: 1, mailingLists: 1, ftpAccounts: 1, databases: 1, phpWorkers: 1 },
    dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100,
  })).id
})
afterEach(async () => { io.afterRead = null; vi.restoreAllMocks(); await handle.close() })

const featurePath = () => join(handle.rootDir, 'feature-lists', featureId + '.json')
const isFeature = (path: string) => path.endsWith('/feature-lists/' + featureId + '.json')

describe('full snapshot source consistency', () => {
  it('keeps a stable fast read free of business revision, fencing and reference mutations', async () => {
    const before = await handle.store.getAuthorityMetadata()
    const snapshot = await handle.store.readSnapshot()
    expect(snapshot.featureLists[0]?.id).toBe(featureId)
    expect(snapshot.revision).toBe(before.revision)
    expect(await handle.store.getAuthorityMetadata()).toEqual(before)
    expect(await handle.store.getWriterLock().readLockHolder()).toBeNull()
  })

  it('rethrows the original stable I/O failure and leaves no active lease', async () => {
    const failure = Object.assign(new Error('stable snapshot I/O failure'), { code: 'EIO' })
    io.afterRead = async (path, value) => { if (isFeature(path)) throw failure; return value }
    await expect(handle.store.readSnapshot()).rejects.toBe(failure)
    io.afterRead = null
    expect(await handle.store.getWriterLock().readLockHolder()).toBeNull()
    expect((await handle.store.readSnapshot()).featureLists[0]?.id).toBe(featureId)
  })

  it('waits for an independent same-instance create instead of borrowing its write lease', async () => {
    const entered = deferred()
    const resume = deferred()
    handle.store.setHooks({ onBeforeAccountCommit: async () => { entered.resolve(); await resume.promise } })
    const writer = handle.store.createAccount(accountInput())
    await entered.promise
    let settled = false
    const reader = handle.store.readSnapshot().finally(() => { settled = true })
    let settledWhileWriterHeld = false
    try { await pause(25); settledWhileWriterHeld = settled } finally { resume.resolve() }
    const account = await writer
    const snapshot = await reader
    expect(settledWhileWriterHeld).toBe(false)
    expect(snapshot.accounts.map(value => value.id)).toEqual([account.id])
    expect(snapshot.domains.map(value => value.accountId)).toEqual([account.id])
    expect(snapshot.revision).toBe(await handle.store.getRevision())
  })

  it('retries a validation failure captured while another committed writer changed the source', async () => {
    const external = new StateStore(handle.rootDir)
    let injected = false
    io.afterRead = async (path, original) => {
      if (!isFeature(path) || injected) return original
      injected = true
      const lease = await external.getWriterLock().acquire()
      const text = String(original)
      try {
        await writeFile(featurePath(), '{transient uncommitted feature')
        io.afterRead = null
        const unstable = await readFile(featurePath(), 'utf8')
        const next = { ...JSON.parse(text), name: 'Committed features' }
        await writeFile(featurePath(), JSON.stringify(next))
        await lease.commitAuthority()
        return unstable
      } finally { await lease.release() }
    }
    const snapshot = await handle.store.readSnapshot()
    expect(injected).toBe(true)
    expect(snapshot.featureLists[0]?.name).toBe('Committed features')
    expect(snapshot.revision).toBe(await handle.store.getRevision())
  })

  it('rethrows stable corrupt JSON without replacing the authority or allocating identifiers', async () => {
    await writeFile(featurePath(), '{stable corruption')
    const before = await handle.store.getAuthorityMetadata()
    await expect(handle.store.readSnapshot()).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(await handle.store.getAuthorityMetadata()).toEqual(before)
    expect(await handle.store.getWriterLock().readLockHolder()).toBeNull()
  })

  it.each(['value', 'error'] as const)('uses a real fallback lease and releases it after returning a %s', async outcome => {
    const external = new StateStore(handle.rootDir)
    let reads = 0
    let competing: Promise<unknown> | undefined
    let blockedDuringFallback = false
    io.afterRead = async (path, original) => {
      if (!isFeature(path)) return original
      reads++
      const hook = io.afterRead
      io.afterRead = null
      try {
        if (reads <= 5) await external.updateFeatureList(featureId, { name: 'Writer version ' + reads })
        else if (reads === 6) {
          let committed = false
          competing = external.updateFeatureList(featureId, { name: 'After fallback' }).then(value => { committed = true; return value })
          await pause(25)
          blockedDuringFallback = !committed
        }
      } finally { io.afterRead = hook }
      return reads === 6 && outcome === 'error' ? '{stable fallback corruption' : original
    }
    const result = await handle.store.readSnapshot().then(snapshot => ({ snapshot }), error => ({ error }))
    io.afterRead = null
    await competing
    expect(reads).toBe(6)
    expect(blockedDuringFallback).toBe(true)
    if (outcome === 'value') {
      expect('snapshot' in result && result.snapshot.featureLists[0]?.name).toBe('Writer version 5')
    } else {
      expect('error' in result && result.error).toMatchObject({ code: 'VALIDATION' })
    }
    expect((await handle.store.getFeatureList(featureId))?.name).toBe('After fallback')
    expect(await handle.store.getWriterLock().readLockHolder()).toBeNull()
  })

  it('fails promptly for a reentrant public snapshot without granting its hook lease ownership', async () => {
    let error: unknown
    handle.store.setHooks({ onBeforeAccountCommit: async () => {
      error = await handle.store.readSnapshot().then(() => null, reason => reason)
    } })
    await handle.store.createAccount(accountInput())
    expect(error).toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect((await handle.store.readSnapshot()).accounts).toHaveLength(1)
  })

  it.each(['workspace', 'mutation'] as const)('rejects a reentrant public %s instead of deadlocking behind the same operation', async operation => {
    let outcome: unknown
    let attempted: Promise<unknown> | undefined
    handle.store.setHooks({ onBeforeAccountCommit: async () => {
      attempted = operation === 'workspace'
        ? handle.store.readAccountWorkspace('00000000-0000-4000-8000-000000000001')
        : handle.store.createFeatureList({ name: 'Nested write', ownerId: null, disabled: [] })
      outcome = await Promise.race([attempted.then(() => null, reason => reason), pause(50).then(() => 'deadlock')])
    } })
    await handle.store.createAccount(accountInput())
    await attempted?.catch(() => undefined)
    expect(outcome).toMatchObject({ code: 'PRECONDITION_FAILED' })
  })

  it('does not cache a completed call context as write authority in a detached descendant', async () => {
    const runLater = deferred()
    let later: Promise<unknown> | undefined
    handle.store.setHooks({ onBeforeAccountCommit: () => {
      later = runLater.promise.then(() => handle.store.readSnapshot())
    } })
    await handle.store.createAccount(accountInput())
    runLater.resolve()
    await expect(later).resolves.toMatchObject({ accounts: [expect.objectContaining({ username: 'snapshot7' })] })
  })
})
