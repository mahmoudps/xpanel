import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStateStore } from './store.ts'
import type { TestStateStoreHandle } from './store.ts'
import type { StateSnapshot } from './types.ts'
import { checksumStateTree } from './validate-state.ts'

const fault = vi.hoisted(() => ({ mode: '', match: '', remaining: 0, baseRevision: 0, artifactsAtCommit: [] as string[], authorityPublishedRoot: '', directoryFailures: 0 }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  const ioError = () => Object.assign(new Error('injected restore I/O failure'), { code: 'EIO' })
  const pathText = (path: unknown) => String(path).replace(/\\/g, '/')
  return {
    ...fs,
    mkdtemp: async (...args: Parameters<typeof fs.mkdtemp>) => {
      if (fault.mode === 'backup-create' && pathText(args[0]).includes('/.restore-backup-')) throw ioError()
      return fs.mkdtemp(...args)
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const path = pathText(args[0])
      if (fault.mode === 'stage-write' && path.includes('/.restore-stage-') && path.includes(fault.match) && fault.remaining-- > 0) throw ioError()
      // Files and authority rename are real; only the post-publication directory
      // sync failure is modeled. This is not native power-loss qualification.
      if (fault.mode === 'authority-dirsync' && path === fault.authorityPublishedRoot && args[1] === 'r') {
        return { sync: async () => { fault.directoryFailures++; throw ioError() }, close: async () => undefined }
      }
      return fs.open(...args)
    },
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      const path = pathText(args[0])
      if (fault.mode === 'stage-read' && path.includes('/.restore-stage-') && path.includes('/accounts/') && fault.remaining-- > 0) throw ioError()
      return fs.readFile(...args)
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      const from = pathText(args[0])
      const to = pathText(args[1])
      const authorityCommit = fault.mode.startsWith('authority-') && to.endsWith('/authority.json')
        && Number(JSON.parse(await fs.readFile(args[0], 'utf8')).revision) > fault.baseRevision
      if (authorityCommit) {
        fault.artifactsAtCommit = (await fs.readdir(to.slice(0, to.lastIndexOf('/')))).filter(name => name.startsWith('.restore-'))
        if (fault.mode === 'authority-before') throw ioError()
      }
      if ((fault.mode === 'activate' || fault.mode === 'rollback') && from.includes('/.restore-stage-') && from.endsWith(`/${fault.match}`)) throw ioError()
      if (fault.mode === 'rollback' && from.includes('/.restore-backup-') && from.endsWith(`/${fault.match}`)) throw ioError()
      await fs.rename(...args)
      if (authorityCommit && fault.mode === 'authority-dirsync') fault.authorityPublishedRoot = to.slice(0, to.lastIndexOf('/'))
      if (authorityCommit && fault.mode === 'authority-after') throw ioError()
      const corruptTarget = fault.match === 'feature-lists' ? to.includes('/feature-lists/') : to.endsWith('/uid-allocator.json')
      if (fault.mode === 'stage-corrupt' && to.includes('/.restore-stage-') && corruptTarget && fault.remaining-- > 0) {
        const value = JSON.parse(await fs.readFile(args[1], 'utf8')) as Record<string, unknown>
        if (fault.match === 'feature-lists') value.name = 'Unexpected staged contents'
        else value.nextUid = Number(value.nextUid) + 1
        await fs.writeFile(args[1], JSON.stringify(value))
      }
    },
  }
})

const treeBytes = async (root: string, prefix = ''): Promise<Record<string, string>> => {
  const files: Record<string, string> = {}
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (['generations', 'authority.json', '.writer-mutex.sqlite', '.writer-mutex.sqlite-journal', '.writer-mutex.sqlite-wal', '.writer-mutex.sqlite-shm'].includes(entry.name)) continue
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) Object.assign(files, await treeBytes(join(root, entry.name), rel))
    else files[rel] = (await readFile(join(root, entry.name))).toString('base64')
  }
  return files
}

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'

describe('generation restore preserves live desired state on refusal', () => {
  let state: TestStateStoreHandle
  let snapshot: StateSnapshot
  let planId: string

  beforeEach(async () => {
    fault.mode = ''
    fault.match = ''
    fault.remaining = 0
    fault.baseRevision = 0
    fault.artifactsAtCommit = []
    fault.authorityPublishedRoot = ''
    fault.directoryFailures = 0
    state = await createTestStateStore()
    await state.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: 'Diagnostic inventory' })
    const feature = await state.store.createFeatureList({ name: 'Snapshot features', ownerId: null, disabled: [] })
    const plan = await state.store.createPlan({
      name: 'Snapshot plan', ownerId: null, featureListId: feature.id,
      resources: { diskMb: 1024, bandwidthMbMonth: 1024, ioReadBps: 'unlimited', ioWriteBps: 'unlimited', ioReadIops: 'unlimited', ioWriteIops: 'unlimited', memoryMb: 512, maxProcesses: 32, cpuPercent: 100 },
      caps: { addonDomains: 2, aliasDomains: 2, subdomains: 2, mailboxes: 2, forwarders: 2, mailingLists: 2, ftpAccounts: 2, databases: 2, phpWorkers: 2 },
      dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 128,
    })
    planId = plan.id
    await state.store.createAccount({
      username: 'restoreuser', passwordHash: HASH, primaryDomain: 'restore.example.test', planId, ownerId: null,
      contactEmail: 'admin@restore.example.test', ipv4: '192.0.2.10', shell: 'none',
      php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 500, processIdleTimeoutSec: 10 }, ini: {} },
    })
    snapshot = await state.store.saveGenerationSnapshot(1)
    await state.store.createFeatureList({ name: 'Current state that must survive refusal', ownerId: null, disabled: ['terminal'] })
  })

  afterEach(async () => {
    fault.mode = ''
    await state?.close()
  })

  const replaceSnapshot = async (mutate: (value: Record<string, unknown>) => void): Promise<void> => {
    const value = structuredClone(snapshot) as unknown as Record<string, unknown>
    mutate(value)
    value.checksum = checksumStateTree(value as unknown as StateSnapshot)
    await writeFile(join(state.rootDir, 'generations', '1.json'), JSON.stringify(value))
  }

  const expectRefusalWithoutLiveChange = async (): Promise<void> => {
    const before = await treeBytes(state.rootDir)
    const authority = await state.store.getAuthorityMetadata()
    const error = await state.store.restoreGenerationSnapshot(1).then(() => null, (reason: unknown) => reason)
    expect(await treeBytes(state.rootDir)).toEqual(before)
    const afterAuthority = await state.store.getAuthorityMetadata()
    expect(afterAuthority.revision).toBe(authority.revision)
    expect(afterAuthority.fencingToken).toBeGreaterThan(authority.fencingToken)
    expect(afterAuthority.references).toEqual(authority.references)
    expect(afterAuthority.allocatedReferences).toEqual(authority.allocatedReferences)
    expect(afterAuthority.committedLeaseId).toBe(authority.committedLeaseId)
    expect(error).toBeInstanceOf(Error)
    expect((await readdir(state.rootDir)).filter((name) => name.startsWith('.restore-'))).toEqual([])
  }

  it('rejects an inconsistent domain before deleting current account data (XP-032)', async () => {
    await replaceSnapshot((value) => { (value.domains as StateSnapshot['domains'])[0]!.accountId = randomUUID() })
    await expectRefusalWithoutLiveChange()
  })

  it.each(['plans', 'accounts', 'domains', 'databaseUsers', 'cronJobs'])('rejects a missing %s collection without deleting current state', async (field) => {
    await replaceSnapshot((value) => { delete value[field] })
    await expectRefusalWithoutLiveChange()
  })

  it('rejects a malformed entity before creating any restore files', async () => {
    await replaceSnapshot((value) => { value.accounts = [null] })
    await expectRefusalWithoutLiveChange()
  })

  it('rejects duplicate entities instead of silently overwriting the staged destination', async () => {
    await replaceSnapshot((value) => { (value.domains as StateSnapshot['domains']).push(snapshot.domains[0]!) })
    await expectRefusalWithoutLiveChange()
  })

  it('rejects a mismatched snapshot checksum without changing live state', async () => {
    await writeFile(join(state.rootDir, 'generations', '1.json'), JSON.stringify({ ...snapshot, checksum: '0'.repeat(64) }))
    await expectRefusalWithoutLiveChange()
  })

  it('preserves live state when the snapshot file is missing', async () => {
    await rm(join(state.rootDir, 'generations', '1.json'))
    await expectRefusalWithoutLiveChange()
  })

  it('preserves live state for corrupt JSON', async () => {
    await writeFile(join(state.rootDir, 'generations', '1.json'), '{broken')
    await expectRefusalWithoutLiveChange()
  })

  it('preserves live state when reading the snapshot fails', async () => {
    const path = join(state.rootDir, 'generations', '1.json')
    await rm(path)
    await mkdir(path)
    await expectRefusalWithoutLiveChange()
  })

  it.each(['firewall.json', 'uid-allocator.json', '/feature-lists/', '/plans/', 'account.json', '/domains/'])('preserves current state on a staged write failure at %s', async (match) => {
    fault.mode = 'stage-write'
    fault.match = match
    fault.remaining = 1
    await expectRefusalWithoutLiveChange()
  })

  it('preserves current state when validation cannot read the staged tree', async () => {
    fault.mode = 'stage-read'
    fault.remaining = 1
    await expectRefusalWithoutLiveChange()
  })

  it.each(['feature-lists', 'uid-allocator'])('detects valid-schema corruption of staged %s before publication', async (match) => {
    fault.mode = 'stage-corrupt'
    fault.match = match
    fault.remaining = 1
    await expectRefusalWithoutLiveChange()
  })

  it('preserves current state and cleans staging if backup directory creation fails', async () => {
    fault.mode = 'backup-create'
    await expectRefusalWithoutLiveChange()
  })

  it.each(['feature-lists', 'accounts'])('restores old entries if publishing the staged %s directory fails', async (match) => {
    fault.mode = 'activate'
    fault.match = match
    await expectRefusalWithoutLiveChange()
  })

  it('retains previous data and staging artifacts if publication rollback also fails', async () => {
    const before = await treeBytes(state.rootDir)
    fault.mode = 'rollback'
    fault.match = 'feature-lists'
    const error = await state.store.restoreGenerationSnapshot(1).then(() => null, (reason: unknown) => reason)
    expect(error).toBeInstanceOf(AggregateError)
    const entries = await readdir(state.rootDir)
    const backup = entries.find((name) => name.startsWith('.restore-backup-'))
    expect(backup).toBeDefined()
    expect(entries.some((name) => name.startsWith('.restore-stage-'))).toBe(true)
    const preserved = await treeBytes(join(state.rootDir, backup!))
    expect(preserved).toEqual(Object.fromEntries(Object.entries(before).filter(([name]) => name.startsWith('feature-lists/'))))
  })

  it('rolls back published directories if the outer authority commit fails before publication', async () => {
    fault.mode = 'authority-before'
    fault.baseRevision = await state.store.getRevision()
    await expectRefusalWithoutLiveChange()
    expect(fault.artifactsAtCommit.some(name => name.startsWith('.restore-backup-'))).toBe(true)
    expect(fault.artifactsAtCommit.some(name => name.startsWith('.restore-stage-'))).toBe(true)
  })

  it.each(['authority-observe', 'authority-after'])('retains rollback material until the committed lease is proven (%s)', async mode => {
    fault.mode = mode
    fault.baseRevision = await state.store.getRevision()
    const restored = await state.store.restoreGenerationSnapshot(1)
    expect(restored.accounts[0]?.username).toBe('restoreuser')
    expect((await state.store.getAuthorityMetadata()).revision).toBe(fault.baseRevision + 1)
    expect(fault.artifactsAtCommit.some(name => name.startsWith('.restore-backup-'))).toBe(true)
    expect(fault.artifactsAtCommit.some(name => name.startsWith('.restore-stage-'))).toBe(true)
    expect((await readdir(state.rootDir)).filter(name => name.startsWith('.restore-'))).toEqual([])
  })

  it('rejects an authority directory-sync EIO despite visible committed bytes and retains recovery evidence', async () => {
    fault.mode = 'authority-dirsync'
    fault.baseRevision = await state.store.getRevision()
    const error = await state.store.restoreGenerationSnapshot(1).then(() => null, (reason: unknown) => reason)
    expect(fault.directoryFailures).toBeGreaterThan(0)
    expect(error).toMatchObject({ name: 'StateDirectoryDurabilityError', code: 'STATE_DIRECTORY_DURABILITY', phase: 'sync', cause: { code: 'EIO' } })
    const authority = JSON.parse(await readFile(join(state.rootDir, 'authority.json'), 'utf8'))
    expect(authority.revision).toBe(fault.baseRevision + 1)
    expect(typeof authority.committedLeaseId).toBe('string')
    const journal = JSON.parse(await readFile(join(state.rootDir, '.lock', 'intent.json'), 'utf8'))
    expect(journal.leaseId).toBe(authority.committedLeaseId)
    expect(journal.op).toBe('restoreGenerationSnapshot')
    // Publication happened: do not claim unchanged data or roll it back on an
    // uncertain commit. Keep the exact recovery artifacts for guarded retry.
    expect(JSON.parse(await readFile(join(state.rootDir, 'feature-lists', `${snapshot.featureLists[0]!.id}.json`), 'utf8')).name).toBe('Snapshot features')
    expect((await readdir(state.rootDir)).some(name => name.startsWith('.restore-backup-'))).toBe(true)
    expect((await readdir(state.rootDir)).some(name => name.startsWith('.restore-stage-'))).toBe(true)
  })

  it('normalizes validated data before publication and removes restore artifacts after success', async () => {
    await replaceSnapshot((value) => { (value.featureLists as StateSnapshot['featureLists'])[0]!.disabled = ['terminal', 'file-manager', 'terminal'] })
    const restored = await state.store.restoreGenerationSnapshot(1)
    expect(restored.featureLists[0]!.disabled).toEqual(['file-manager', 'terminal'])
    expect(JSON.parse(await readFile(join(state.rootDir, 'feature-lists', `${restored.featureLists[0]!.id}.json`), 'utf8')).disabled).toEqual(['file-manager', 'terminal'])
    expect(restored.accounts[0]!.username).toBe('restoreuser')
    expect(restored.domains[0]!.name).toBe('restore.example.test')
    expect(await state.store.getPlan(planId)).not.toBeNull()
    expect((await readdir(state.rootDir)).filter((name) => name.startsWith('.restore-'))).toEqual([])
  })
})
