import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { link, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WriterLock, type WriterLease } from './writer-lock.ts'

const ioFault = vi.hoisted(() => ({ failRenameTo: '', failIntentClear: false, partialCleanup: '' }))
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, rm: async (...args: Parameters<typeof original.rm>) => {
    if (String(args[0]) === ioFault.partialCleanup) {
      await original.rm(join(String(args[0]), 'server.json'), { force: true }); throw Error('synthetic partial artifact cleanup failure')
    }
    if (ioFault.failIntentClear && String(args[0]).endsWith('intent.json')) throw Error('synthetic intent cleanup failure')
    return original.rm(...args)
  }, rename: async (...args: Parameters<typeof original.rename>) => {
    if (String(args[1]) === ioFault.failRenameTo) throw Error('synthetic rollback write failure')
    return original.rename(...args)
  } }
})

const cleanup: (() => Promise<unknown>)[] = []
let base: string
let root: string
beforeEach(async () => {
  ioFault.failRenameTo = ''; ioFault.failIntentClear = false; ioFault.partialCleanup = ''
  const parent = resolve('.tools/r01-lock-tests')
  await mkdir(parent, { recursive: true })
  base = await mkdtemp(join(parent, 'case-'))
  root = join(base, 'state')
  await mkdir(root)
  cleanup.push(async () => { if (!resolve(base).startsWith(parent + '\\') && !resolve(base).startsWith(parent + '/')) throw Error('unsafe fixture cleanup'); await rm(base, { recursive: true, force: true }) })
})
afterEach(async () => { ioFault.failRenameTo = ''; ioFault.failIntentClear = false; ioFault.partialCleanup = ''; vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
const lock = () => new WriterLock(root, { acquireTimeoutMs: 80, retryIntervalMs: 5, deadOwnerGraceMs: 0 })
const acquire = async (writer = lock()) => { const lease = await writer.acquire(); cleanup.push(() => lease.release()); return lease }
const json = async (path: string, value: unknown) => writeFile(path, JSON.stringify(value))
const orphan = async (intent: unknown) => {
  await mkdir(join(root, '.lock'))
  await json(join(root, '.lock/owner.json'), { pid: 99999999, fencingToken: 5, leaseId: randomUUID(), acquiredAt: '2026-10-23T00:00:00Z' })
  await json(join(root, 'authority.json'), { revision: 0, fencingToken: 5, updatedAt: '2026-10-23T00:00:00Z', references: {} })
  await writeFile(join(root, '.lock/intent.json'), typeof intent === 'string' ? intent : JSON.stringify(intent))
}
const intent = (patch: Record<string, unknown> = {}) => ({ op: 'test', fencingToken: 5, baseRevision: 0, createdRelPaths: [], backups: [], recordedAt: '2026-10-23T00:00:00Z', ...patch })

describe('writer lock security boundaries', () => {
  it('cannot force-recover a live or paused owner while its OS mutex is held', async () => {
    const writer = lock()
    const lease = await acquire(writer)
    const before = await readFile(writer.authorityFilePath, 'utf8')
    await expect(lock().forceRecoverLease()).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await readFile(writer.authorityFilePath, 'utf8')).toBe(before)
    await expect(lease.assertFencingToken()).resolves.toMatchObject({ fencingToken: lease.fencingToken })
  })

  it('never rewinds a burned fencing token when restoring an uncommitted authority', async () => {
    const writer = lock()
    const first = await acquire(writer)
    await first.restorePreAcquireAuthorityIfUncommitted()
    await first.release()
    const second = await acquire(writer)
    expect(second.fencingToken).toBeGreaterThan(first.fencingToken)
  })

  it('a released lease cannot clear a newer owner journal', async () => {
    const writer = lock()
    const stale = await acquire(writer)
    await stale.release()
    const active = await acquire(writer)
    await active.recordIntent({ op: 'active-owner', createdRelPaths: [], backups: [] })
    const before = await readFile(writer.intentFilePath, 'utf8')
    await expect(stale.clearIntent()).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await readFile(writer.intentFilePath, 'utf8')).toBe(before)
    await active.commitAuthority()
  })

  it('preserves and recovers an uncommitted journal after explicit release', async () => {
    const path = join(root, 'payload.json')
    await json(path, { value: 'original' })
    const writer = lock()
    const lease = await acquire(writer)
    await lease.recordIntent({ op: 'replace-payload', createdRelPaths: [], backups: [{ relPath: 'payload.json', existed: true, contentBase64: Buffer.from(JSON.stringify({ value: 'original' })).toString('base64') }] })
    await json(path, { value: 'partial' })
    await lease.release()
    const recovery = await acquire(writer)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ value: 'original' })
    await recovery.commitAuthority()
  })

  it('refuses malformed orphan intent and retains its exact forensic bytes', async () => {
    await orphan('{ invalid journal')
    const before = await readFile(join(root, '.lock/intent.json'), 'utf8')
    await expect(lock().acquire()).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(await readFile(join(root, '.lock/intent.json'), 'utf8')).toBe(before)
  })

  it('validates every orphan path before any recovery filesystem effect', async () => {
    const outside = join(base, 'outside.json')
    await json(outside, { untouched: true })
    await json(join(root, 'safe.json'), { untouched: true })
    await orphan(intent({ createdRelPaths: ['safe.json', '../outside.json'] }))
    const before = await readFile(join(root, '.lock/intent.json'), 'utf8')
    await expect(lock().acquire()).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(JSON.parse(await readFile(outside, 'utf8'))).toEqual({ untouched: true })
    expect(JSON.parse(await readFile(join(root, 'safe.json'), 'utf8'))).toEqual({ untouched: true })
    expect(await readFile(join(root, '.lock/intent.json'), 'utf8')).toBe(before)
  })
})

// These child-process cases exercise real OS lock release, rather than simulated PID liveness.

const childWriter = async (mode: 'hold' | 'reclaim') => {
  const moduleUrl = pathToFileURL(resolve('packages/state/src/writer-lock.ts')).href
  const script = `import { WriterLock } from ${JSON.stringify(moduleUrl)};
    import { writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    const root=${JSON.stringify(root)};
    const lease=await new WriterLock(root,{acquireTimeoutMs:3000,retryIntervalMs:5}).acquire();
    if(${JSON.stringify(mode)}==='hold'){
      await lease.recordIntent({op:'child-write',createdRelPaths:['partial.json'],backups:[]});
      await writeFile(join(root,'partial.json'),JSON.stringify({partial:true}));
      process.send({ready:true,token:lease.fencingToken});setInterval(()=>{},1000);
    }else{
      const meta=await lease.commitAuthority();await lease.release();process.send({done:true,token:lease.fencingToken,revision:meta.revision});process.disconnect();
    }`
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let diagnostics = ''
  child.stderr?.on('data', chunk => { diagnostics += String(chunk) })
  const exit = new Promise<void>(resolve => child.once('exit', () => resolve()))
  cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exit })
  const result = await new Promise<{ ready?: boolean; done?: boolean; token: number; revision?: number }>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('child fixture timed out: ' + diagnostics)) }, 5000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { if (code !== 0) { clearTimeout(timer); reject(Error('child fixture exited: ' + diagnostics)) } })
    child.once('message', value => { clearTimeout(timer); resolve(value as { token: number }) })
  })
  return { child, result, exit }
}

describe('writer OS mutex and recovery', () => {
  it('clean authority barriers have no authority/reference/UID side effects', async () => {
    const writer = lock()
    const lease = await acquire(writer)
    await lease.commitAuthority({ incrementRevision: false, references: { JOB: 3 } })
    await lease.release()
    const before = await readFile(writer.authorityFilePath, 'utf8')
    expect((await writer.readAuthorityAtBarrier()).references).toEqual({ JOB: 3 })
    expect((await writer.readAuthorityAtBarrier()).fencingToken).toBe(lease.fencingToken)
    expect(await readFile(writer.authorityFilePath, 'utf8')).toBe(before)
  })
  it('a barrier waits asynchronously for a paused writer and never reads its partial tree', async () => {
    const writer = lock()
    const lease = await acquire(writer)
    await lease.recordIntent({ op: 'paused', createdRelPaths: ['partial.json'], backups: [] })
    await json(join(root, 'partial.json'), { partial: true })
    let observed = false
    const pending = new WriterLock(root, { acquireTimeoutMs: 500, retryIntervalMs: 5 }).readAuthorityAtBarrier().then(value => { observed = true; return value })
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(observed).toBe(false)
    await lease.release()
    await pending
    await expect(readFile(join(root, 'partial.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('refuses legacy live PID and ownerless publication without filesystem effects', async () => {
    await mkdir(join(root, '.lock'))
    await json(join(root, '.lock/owner.json'), { pid: process.pid, fencingToken: 1, leaseId: randomUUID(), acquiredAt: new Date().toISOString() })
    await expect(lock().forceRecoverLease()).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(JSON.parse(await readFile(join(root, '.lock/owner.json'), 'utf8')).pid).toBe(process.pid)
    await rm(join(root, '.lock/owner.json'))
    await expect(lock().acquire()).rejects.toMatchObject({ code: 'CONFLICT' })
  })
  it('serializes queued journal, commit and release operations and rejects every later cleanup', async () => {
    const writer = lock()
    const lease = await acquire(writer)
    const journal = lease.recordIntent({ op: 'queued', createdRelPaths: [], backups: [] })
    const commit = lease.commitAuthority({ incrementRevision: false })
    const release = lease.release()
    await Promise.all([journal, commit, release])
    await expect(lease.recordIntent({ op: 'stale', createdRelPaths: [], backups: [] })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(lease.commitAuthority()).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(lease.restorePreAcquireAuthorityIfUncommitted()).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(lease.clearIntent()).rejects.toMatchObject({ code: 'CONFLICT' })
    expect((await writer.readAuthorityAtBarrier()).committedLeaseId).toBe(lease.leaseId)
  })
  it('retains the complete journal after a rollback write fails and retries idempotently', async () => {
    const backup = (path: string) => ({ relPath: path, existed: true, contentBase64: Buffer.from(JSON.stringify({ original: path })).toString('base64') })
    await json(join(root, 'one.json'), { partial: 1 }); await json(join(root, 'two.json'), { partial: 2 })
    await orphan(intent({ backups: [backup('one.json'), backup('two.json')] }))
    const before = await readFile(join(root, '.lock/intent.json'), 'utf8')
    ioFault.failRenameTo = join(root, 'two.json')
    await expect(lock().readAuthorityAtBarrier()).rejects.toThrow('synthetic rollback write failure')
    expect(await readFile(join(root, '.lock/intent.json'), 'utf8')).toBe(before)
    ioFault.failRenameTo = ''
    await lock().readAuthorityAtBarrier()
    expect(JSON.parse(await readFile(join(root, 'one.json'), 'utf8'))).toEqual({ original: 'one.json' })
    expect(JSON.parse(await readFile(join(root, 'two.json'), 'utf8'))).toEqual({ original: 'two.json' })
  })
  it('recovers a real killed writer and serializes simultaneous reclaimers', async () => {
    const held = await childWriter('hold')
    expect(held.result.ready).toBe(true)
    let ticks = 0
    const interval = setInterval(() => { ticks++ }, 5)
    try { await expect(lock().forceRecoverLease()).rejects.toMatchObject({ code: 'CONFLICT' }) } finally { clearInterval(interval) }
    expect(ticks).toBeGreaterThan(2)
    expect(JSON.parse(await readFile(join(root, 'partial.json'), 'utf8'))).toEqual({ partial: true })
    held.child.kill('SIGKILL'); await held.exit
    const reclaimers = await Promise.all([childWriter('reclaim'), childWriter('reclaim')])
    await Promise.all(reclaimers.map(value => value.exit))
    expect(new Set(reclaimers.map(value => value.result.token)).size).toBe(2)
    expect(reclaimers.every(value => value.result.token > held.result.token)).toBe(true)
    expect(reclaimers.map(value => value.result.revision).sort()).toEqual([1, 2])
    await expect(readFile(join(root, 'partial.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await lock().readAuthorityAtBarrier()).revision).toBe(2)
  }, 15000)
})


describe('writer journal commit identity', () => {
  it('preserves an incrementRevision:false committed payload across lost cleanup acknowledgment', async () => {
    const writer = lock()
    const path = join(root, 'metadata.json')
    const original = '{ \"value\": \"old\" }\n'
    await writeFile(path, original)
    const lease = await writer.acquire()
    cleanup.push(() => lease.release().catch(() => undefined))
    await lease.recordIntent({ op: 'metadata-no-revision', createdRelPaths: [], backups: [{ relPath: 'metadata.json', existed: true, contentBase64: Buffer.from(original).toString('base64') }] })
    await json(path, { value: 'committed' })
    ioFault.failIntentClear = true
    await expect(lease.commitAuthority({ incrementRevision: false })).rejects.toThrow('synthetic intent cleanup failure')
    expect((await writer.readAuthority()).committedLeaseId).toBe(lease.leaseId)
    expect((await writer.readAuthority()).revision).toBe(0)
    await expect(lease.release()).rejects.toThrow('synthetic intent cleanup failure')
    ioFault.failIntentClear = false
    expect((await writer.readAuthorityAtBarrier()).revision).toBe(0)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ value: 'committed' })
  })
  it('restores exact raw preimage bytes and never rewinds the epoch on ordinary rollback', async () => {
    const writer = lock()
    const bytes = Buffer.from('{\n\t\"value\" : \"old\", \"count\" : 2\n}  \n')
    const path = join(root, 'metadata.json')
    await writeFile(path, bytes)
    const lease = await acquire(writer)
    await lease.recordIntent({ op: 'metadata-rollback', createdRelPaths: [], backups: [{ relPath: 'metadata.json', existed: true, contentBase64: bytes.toString('base64') }] })
    await json(path, { changed: true })
    await lease.rollbackIntent()
    expect(await readFile(path)).toEqual(bytes)
    await expect(readFile(writer.intentFilePath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await lease.assertFencingToken()).fencingToken).toBe(lease.fencingToken)
  })
  it('rejects a prospective escaping journal before its publication', async () => {
    const writer = lock()
    const lease = await acquire(writer)
    await expect(lease.recordIntent({ op: 'unsafe', createdRelPaths: ['../outside.json'], backups: [] })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(readFile(writer.intentFilePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('refuses a recovery path through a directory junction before any outside effect', async () => {
    const outside = join(base, 'outside')
    await mkdir(outside)
    await json(join(outside, 'value.json'), { untouched: true })
    await mkdir(join(root, 'safe'))
    await symlink(outside, join(root, 'safe/link'), process.platform === 'win32' ? 'junction' : 'dir')
    await orphan(intent({ createdRelPaths: ['safe/link/value.json'] }))
    await expect(lock().readAuthorityAtBarrier()).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(JSON.parse(await readFile(join(outside, 'value.json'), 'utf8'))).toEqual({ untouched: true })
  })
})


const restoreEntries = ['feature-lists', 'plans', 'resellers', 'accounts', 'certificates', 'zones', 'server.json', 'firewall.json', 'uid-allocator.json', 'ip-pool.json', 'mail-ips.json']
const uid = (uid: number, username: string) => ({ uid, username, allocatedAt: '2026-10-23T00:00:00.000Z' })
describe('restore journal UID crash recovery', () => {
  it('unions surviving backup/stage UID burns when the live allocator was moved away before a crash', async () => {
    const writer = lock(), stageName = '.restore-stage-test', backupName = '.restore-backup-test'
    await mkdir(join(root, stageName)); await mkdir(join(root, backupName))
    await json(join(root, 'uid-allocator.json'), { nextUid: 20001, allocated: [uid(20000, 'olduser')] })
    await json(join(root, stageName, 'uid-allocator.json'), { nextUid: 20002, allocated: [uid(20000, 'olduser'), uid(20001, 'burneduser')] })
    const lease = await acquire(writer)
    await lease.recordRestoreIntent({ stageName, backupName, entries: restoreEntries })
    await rename(join(root, 'uid-allocator.json'), join(root, backupName, 'uid-allocator.json'))
    await lease.release()
    await writer.readAuthorityAtBarrier()
    expect(JSON.parse(await readFile(join(root, 'uid-allocator.json'), 'utf8'))).toEqual({ nextUid: 20002, allocated: [uid(20000, 'olduser'), uid(20001, 'burneduser')] })
    await expect(readFile(writer.intentFilePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('retains restore journal until committed cleanup and never rolls back an unchanged-revision commit', async () => {
    const writer = lock(), stageName = '.restore-stage-test', backupName = '.restore-backup-test'
    await mkdir(join(root, stageName)); await mkdir(join(root, backupName))
    await json(join(root, 'uid-allocator.json'), { nextUid: 20001, allocated: [uid(20000, 'olduser')] })
    await json(join(root, stageName, 'uid-allocator.json'), { nextUid: 20002, allocated: [uid(20000, 'olduser'), uid(20001, 'burneduser')] })
    await json(join(root, 'server.json'), { hostname: 'old.example.test' })
    await json(join(root, stageName, 'server.json'), { hostname: 'new.example.test' })
    const lease = await acquire(writer)
    await lease.recordRestoreIntent({ stageName, backupName, entries: restoreEntries })
    if (process.platform !== 'win32') {
      expect((await lstat(writer.intentFilePath)).mode & 0o777).toBe(0o640)
      expect((await lstat(writer.intentFilePath)).gid).toBe((await lstat(root)).gid)
    }
    for (const name of ['server.json', 'uid-allocator.json']) { await rename(join(root, name), join(root, backupName, name)); await rename(join(root, stageName, name), join(root, name)) }
    await lease.commitAuthority({ incrementRevision: false })
    expect(JSON.parse(await readFile(writer.intentFilePath, 'utf8')).restore.stageName).toBe(stageName)
    await lease.release()
    expect(JSON.parse(await readFile(join(root, 'server.json'), 'utf8'))).toEqual({ hostname: 'new.example.test' })
    expect((await writer.readAuthorityAtBarrier()).revision).toBe(0)
    await expect(readFile(writer.intentFilePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('preserves unknown restore artifacts before changing any other canonical entry', async () => {
    const writer = lock(), stageName = '.restore-stage-test', backupName = '.restore-backup-test'
    await mkdir(join(root, stageName)); await mkdir(join(root, backupName))
    await json(join(root, 'uid-allocator.json'), { nextUid: 20001, allocated: [uid(20000, 'olduser')] })
    await json(join(root, stageName, 'uid-allocator.json'), { nextUid: 20001, allocated: [uid(20000, 'olduser')] })
    await json(join(root, 'server.json'), { hostname: 'old.example.test' })
    await json(join(root, stageName, 'server.json'), { hostname: 'new.example.test' })
    const lease = await acquire(writer)
    await lease.recordRestoreIntent({ stageName, backupName, entries: restoreEntries })
    await rename(join(root, 'server.json'), join(root, backupName, 'server.json'))
    await json(join(root, 'server.json'), { hostname: 'unknown.example.test' })
    const evidence = await readFile(writer.intentFilePath, 'utf8')
    await lease.release()
    await expect(writer.readAuthorityAtBarrier()).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(await readFile(writer.intentFilePath, 'utf8')).toBe(evidence)
    expect(JSON.parse(await readFile(join(root, 'server.json'), 'utf8'))).toEqual({ hostname: 'unknown.example.test' })
  })
})


describe('restore artifact cleanup replay', () => {
  it('resumes partial recursive cleanup from a durable canonical proof without intact artifact hashes', async () => {
    const writer = lock(), stageName = '.restore-stage-test', backupName = '.restore-backup-test'
    await mkdir(join(root, stageName)); await mkdir(join(root, backupName))
    for (const path of [join(root, 'uid-allocator.json'), join(root, stageName, 'uid-allocator.json')]) await json(path, { nextUid: 20001, allocated: [uid(20000, 'olduser')] })
    await json(join(root, 'server.json'), { hostname: 'old.example.test' })
    await json(join(root, stageName, 'server.json'), { hostname: 'new.example.test' })
    const lease = await writer.acquire()
    cleanup.push(() => lease.release().catch(() => undefined))
    await lease.recordRestoreIntent({ stageName, backupName, entries: restoreEntries })
    await rename(join(root, 'server.json'), join(root, backupName, 'server.json'))
    await rename(join(root, stageName, 'server.json'), join(root, 'server.json'))
    await rename(join(root, 'uid-allocator.json'), join(root, backupName, 'uid-allocator.json'))
    await rename(join(root, stageName, 'uid-allocator.json'), join(root, 'uid-allocator.json'))
    await lease.commitAuthority()
    ioFault.partialCleanup = join(root, backupName)
    await expect(lease.release()).rejects.toThrow('synthetic partial artifact cleanup failure')
    const journal = JSON.parse(await readFile(writer.intentFilePath, 'utf8'))
    expect(journal.restore.cleanup.canonicalHashes).toHaveLength(restoreEntries.length)
    await expect(readFile(join(root, backupName, 'server.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    ioFault.partialCleanup = ''
    await writer.readAuthorityAtBarrier()
    expect(JSON.parse(await readFile(join(root, 'server.json'), 'utf8'))).toEqual({ hostname: 'new.example.test' })
    await expect(readFile(writer.intentFilePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})


describe('mutex inode and metadata publication', () => {
  it('publishes shared owner and intent metadata with a stable inode binding', async () => {
    const writer = lock(), lease = await acquire(writer)
    await lease.recordIntent({ op: 'shared-metadata', createdRelPaths: [], backups: [] })
    const holder = JSON.parse(await readFile(writer.ownerFilePath, 'utf8'))
    expect(holder.protocol).toBe('sqlite-v1')
    expect(holder.mutexIdentity).toMatch(/^[0-9]+:[0-9]+$/)
    expect((await lstat(writer.mutexFilePath)).nlink).toBe(1)
    if (process.platform !== 'win32') {
      const parent = await lstat(root)
      expect((await lstat(writer.mutexFilePath)).mode & 0o777).toBe(0o660)
      expect((await lstat(writer.lockDirPath)).mode & 0o7777).toBe(0o2770)
      for (const path of [writer.ownerFilePath, writer.intentFilePath]) { expect((await lstat(path)).mode & 0o777).toBe(0o640); expect((await lstat(path)).gid).toBe(parent.gid) }
    }
    await lease.commitAuthority()
  })
  it('refuses a multiply-linked mutex without opening a second inode lock', async () => {
    const writer = lock()
    await writer.readAuthorityAtBarrier()
    await link(writer.mutexFilePath, join(base, 'unexpected-hardlink.sqlite'))
    await expect(writer.acquire()).rejects.toMatchObject({ code: 'VALIDATION' })
  })
  it('refuses orphan recovery after the closed mutex inode was replaced', async () => {
    const writer = lock(), lease = await acquire(writer)
    await lease.recordIntent({ op: 'orphan-binding', createdRelPaths: ['partial.json'], backups: [] })
    await json(join(root, 'partial.json'), { preserved: true })
    await lease.release() // All fixture writers are stopped before simulating offline inode corruption.
    await rename(writer.mutexFilePath, join(base, 'replaced-mutex.sqlite'))
    await expect(writer.readAuthorityAtBarrier()).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(JSON.parse(await readFile(join(root, 'partial.json'), 'utf8'))).toEqual({ preserved: true })
    expect(JSON.parse(await readFile(writer.intentFilePath, 'utf8')).op).toBe('orphan-binding')
  })
  it('serializes concurrent first initialization in this process and across fresh child processes', async () => {
    await Promise.all(Array.from({ length: 8 }, () => lock().readAuthorityAtBarrier()))
    const cleanRoot = join(base, 'fresh')
    await mkdir(cleanRoot)
    root = cleanRoot
    const children = await Promise.all([childWriter('reclaim'), childWriter('reclaim')])
    await Promise.all(children.map(value => value.exit))
    expect(children.map(value => value.result.revision).sort()).toEqual([1, 2])
  }, 15000)
  it('rejects ancestor-overlapping journal paths before publication and recovery effects', async () => {
    const writer = lock(), lease = await acquire(writer)
    await expect(lease.recordIntent({ op: 'overlap', createdRelPaths: ['accounts/owner'], backups: [{ relPath: 'accounts/owner/account.json', existed: false }] })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(readFile(writer.intentFilePath)).rejects.toMatchObject({ code: 'ENOENT' })
    await lease.release()
    await mkdir(join(root, 'accounts/owner'), { recursive: true })
    await json(join(root, 'accounts/owner/account.json'), { preserved: true })
    await orphan(intent({ createdRelPaths: ['accounts/owner'], backups: [{ relPath: 'accounts/owner/account.json', existed: false }] }))
    await expect(writer.readAuthorityAtBarrier()).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(JSON.parse(await readFile(join(root, 'accounts/owner/account.json'), 'utf8'))).toEqual({ preserved: true })
  })
})


describe('protected authority aliases', () => {
  it.each(['AUTHORITY.JSON', 'Authority.Json', 'authority.json.', 'authority.json ', 'AUTHO~1.JSO'])('rejects %s before journal publication and authority effects', async relPath => {
    const writer = lock(), lease = await acquire(writer)
    const authority = await readFile(writer.authorityFilePath, 'utf8')
    await expect(lease.recordIntent({ op: 'alias-denial', createdRelPaths: [relPath], backups: [] })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(readFile(writer.intentFilePath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(writer.authorityFilePath, 'utf8')).toBe(authority)
  })
})
