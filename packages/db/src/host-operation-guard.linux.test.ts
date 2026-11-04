import { createStrictTestDb } from './strict-test-db.ts'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, chown, lstat, mkdtemp, readFile, rename, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { disposableVmAcknowledgement } from '../../../scripts/test-linux-preflight.mjs'
import { createDb, type Db, type DbHandle } from './client.ts'
import { migrate } from './migrate.ts'
import { initializeOperationalMetadata, requireOperationalIdentity } from './repos/official-references.ts'
import { getStrictDatabaseIdentity, getStrictOperationDatabaseOrigin } from './sql-runner.ts'
import { withReadonlyOperationDatabase, withReobservedReadonlyOperationDatabase, assertReadonlyOperationDatabaseOutsideTransaction, type ReadonlyOperationDatabase } from './readonly-operation-database.ts'
import {
  HOST_OPERATION_GUARD_DIRECTORY,
  assertHostOperationGuardActive,
  assertHostOperationGuardHeld,
  withHostOperationGuard,
  withReadonlyHostOperationGuard,
  withReopenedReadonlyHostOperationGuard,
} from './host-operation-guard.ts'
import type { HostOperationGuard, HostOperationGuardBinding } from './host-operation-guard.ts'

// Fixed namespace tests belong only in a fresh disposable VM. No installed service is touched.
const parent = '/var/lib/xpanel-agent'
const handles: DbHandle[] = []
const directories: string[] = []
const children = new Set<ReturnType<typeof spawn>>()
let ownedParent: { device: bigint; inode: bigint } | undefined
let admitted = false
beforeAll(async () => {
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.geteuid?.() !== 0 ||
      process.env.XPANEL_TEST_DISPOSABLE_VM !== disposableVmAcknowledgement) {
    throw new Error('BLOCKED: actual Linux root inside an explicitly acknowledged disposable VM is required')
  }
  const existing = await lstat(parent).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (existing) throw new Error('BLOCKED: host operation namespace already exists; preserve it and use a fresh disposable VM')
  admitted = true
})
const stopChildren = async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) {
    const exit = new Promise<void>(resolve => child.once('exit', () => resolve()))
    child.kill('SIGKILL')
    await exit
  }
  children.clear()
}
afterEach(async () => {
  await stopChildren()
  for (const handle of handles.splice(0)) await handle.close()
  for (const directory of directories.splice(0)) {
    if (!directory.startsWith('/root/xpanel-host-guard-')) throw new Error('Unsafe fixture cleanup target')
    await rm(directory, { recursive: true, force: true })
  }
})
afterAll(async () => {
  await stopChildren()
  if (!admitted || !ownedParent) return
  const current = await lstat(parent, { bigint: true })
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== ownedParent.device || current.ino !== ownedParent.inode) {
    throw new Error('Host operation fixture root changed; retain it for inspection')
  }
  // All fixture connections/scopes/processes are closed. Never remove a live writer guard.
  await rm(parent, { recursive: true })
})
const fixture = async () => {
  const directory = await mkdtemp('/root/xpanel-host-guard-')
  directories.push(directory)
  const file = join(directory, 'control.sqlite')
  const handle = createDb(file, { durability: 'strict' })
  handles.push(handle)
  await migrate(handle.db)
  await initializeOperationalMetadata(handle.db)
  const binding = await handle.db.transaction(async tx => {
    const identity = getStrictDatabaseIdentity(tx)
    return {
      databaseFile: identity.file, databaseDevice: identity.device, databaseInode: identity.inode,
      issuerId: await requireOperationalIdentity(tx),
    }
  })
  return { handle, binding, file }
}
const recordOwnedParent = async () => {
  const info = await lstat(parent, { bigint: true })
  if (!ownedParent) ownedParent = { device: info.dev, inode: info.ino }
  expect(info.dev).toBe(ownedParent.device)
  expect(info.ino).toBe(ownedParent.inode)
}
const childProgram = `
const [guardUrl,clientUrl,dbPath,mode,timeout]=process.argv.slice(1)
const {withHostOperationGuard}=await import(guardUrl)
const {createDb}=await import(clientUrl)
const handle=createDb(dbPath,{durability:'strict'})
try {
 await withHostOperationGuard(handle.db,{acquireTimeoutMs:Number(timeout),retryIntervalMs:5},async()=>{
  process.stdout.write('GUARD_READY\\n')
  if(mode==='hold') await new Promise(resolve=>{process.stdin.on('data',chunk=>{if(String(chunk).includes('RELEASE'))resolve()});process.stdin.resume()})
 })
 process.stdout.write('GUARD_RELEASED\\n')
} catch(error) {process.stdout.write(JSON.stringify({rejected:true,code:error.code??null})+'\\n');process.exitCode=2}
finally {await handle.close()}
`
const launch = (file: string, mode: 'once' | 'hold', timeout = 2_000, gid?: number) => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', childProgram,
    pathToFileURL(join(import.meta.dirname, 'host-operation-guard.ts')).href,
    pathToFileURL(join(import.meta.dirname, 'client.ts')).href, file, mode, String(timeout)],
  { stdio: ['pipe', 'pipe', 'pipe'], ...(gid === undefined ? {} : { uid: 0, gid }) })
  children.add(child)
  let stdout = '', stderr = ''
  child.stdout!.on('data', chunk => { stdout += String(chunk) })
  child.stderr!.on('data', chunk => { stderr += String(chunk) })
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => { children.delete(child); resolve({ code, signal, stdout, stderr }) })
  })
  return { child, done, output: () => stdout }
}
const ready = async (worker: ReturnType<typeof launch>) => {
  const deadline = Date.now() + 10_000
  while (!worker.output().includes('GUARD_READY')) {
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) throw new Error('Actual owner exited before acquiring physical exclusion')
    if (Date.now() >= deadline) throw new Error('Actual owner acquisition timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

// Fault injection stays in a separate process before the observer import.
// Every SQLite and filesystem operation is real; the product exposes no seam.
const initializationFaultProgram = String.raw`
import * as fs from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { DatabaseSync, StatementSync } from 'node:sqlite'
const [observerUrl,file,mode]=process.argv.slice(1), wal=file+'-wal'
const before=fs.lstatSync(wal,{bigint:true}), original=fs.readFileSync(wal)
const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
const held=wal+'.aba-original', replacement=wal+'.aba-replacement'
const originalPrepare=DatabaseSync.prototype.prepare, originalIterate=StatementSync.prototype.iterate
const statements=new WeakSet()
let injected=false, completed=false, restored=false, callback=false, rejected=false, reason=null, connection
let originalVersion=null, marker=null, transientVersion=null, stableVersion=null, issuer=null, queriedIssuer=null, purgeBypassed=false
let markerOffset=-1
if(mode!=='namespace') {
 const size=original.readUInt32BE(8), pageSize=size===1?65536:size
 if(pageSize<512 || (original.length-32)%(pageSize+24)!==0) throw new Error('Fixture WAL frames are incomplete')
 for(let at=32;at+24+pageSize<=original.length;at+=24+pageSize) if(original.readUInt32BE(at)===1) markerOffset=at+24+60
 if(markerOffset<0) throw new Error('Fixture must contain a page1 WAL frame')
 originalVersion=original.readUInt32BE(markerOffset); marker=originalVersion===0x13579?0x24680:0x13579
}
const scalar=()=>[...Reflect.apply(originalIterate,Reflect.apply(originalPrepare,connection,['PRAGMA user_version']),[])][0].user_version
const restore=()=>{
 if(!injected || restored) return
 if(mode==='namespace') {
  fs.renameSync(wal,replacement); fs.renameSync(held,wal)
 } else {
  const fd=fs.openSync(wal,'r+')
  try { if(fs.writeSync(fd,original.subarray(markerOffset,markerOffset+4),0,4,markerOffset)!==4) throw new Error('Fixture restore was short') }
  finally { fs.closeSync(fd) }
  const ns=before.mtimeNs, timestamp='@'+(ns/1000000000n)+'.'+String(ns%1000000000n).padStart(9,'0')
  const touched=spawnSync('/usr/bin/touch',['-m','-d',timestamp,wal],{timeout:5000,encoding:'utf8'})
  if(touched.status!==0 || touched.signal || touched.error) throw new Error('Fixture exact mtime restore failed')
 }
 restored=true
}
DatabaseSync.prototype.prepare=function(sql,...args){
 if(mode==='bytes-without-purge' && sql==='PRAGMA shrink_memory') { purgeBypassed=true; return Reflect.apply(originalPrepare,this,['SELECT 1']) }
 if(!injected && sql==='PRAGMA main.data_version') {
  connection=this
  if(mode==='namespace') {
   fs.renameSync(wal,held); fs.copyFileSync(held,wal,fs.constants.COPYFILE_EXCL); fs.chmodSync(wal,Number(before.mode&0o7777n))
  } else {
   const fd=fs.openSync(wal,'r+'), bytes=Buffer.alloc(4); bytes.writeUInt32BE(marker)
   try { if(fs.writeSync(fd,bytes,0,4,markerOffset)!==4) throw new Error('Fixture injection was short') }
   finally { fs.closeSync(fd) }
  }
  injected=true
  try { const statement=Reflect.apply(originalPrepare,this,[sql,...args]); statements.add(statement); return statement }
  catch(error) { restore(); throw error }
 }
 return Reflect.apply(originalPrepare,this,[sql,...args])
}
StatementSync.prototype.iterate=function*(...args){
 const target=statements.has(this)
 try {
  yield* Reflect.apply(originalIterate,this,args)
  if(target) { completed=true; if(mode!=='namespace') transientVersion=scalar() }
 } finally { if(target) restore() }
}
try {
 const observer=await import(observerUrl)
 try {
  await observer.withReadonlyOperationDatabase(file,async reader=>{
   callback=true
   issuer=observer.getReadonlyOperationDatabaseOrigin(reader).issuerId
   queriedIssuer=(await reader.query('SELECT issuer_id FROM operational_identity WHERE singleton=1'))[0].issuer_id
   if(mode!=='namespace') stableVersion=scalar()
  })
 } catch(error) { rejected=true; reason=error.detail?.reason??null }
} finally {
 try { restore() } finally { DatabaseSync.prototype.prepare=originalPrepare; StatementSync.prototype.iterate=originalIterate }
}
const after=fs.lstatSync(wal,{bigint:true})
process.stdout.write(JSON.stringify({injected,completed,restored,callback,rejected,reason,originalVersion,marker,transientVersion,stableVersion,issuer,queriedIssuer,purgeBypassed,
 sameInode:before.dev===after.dev&&before.ino===after.ino,sameBytes:digest(original)===digest(fs.readFileSync(wal)),mtimeRestored:before.mtimeNs===after.mtimeNs})+'\n')
`
const unsupportedRuntimeProgram = String.raw`
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
const [observerUrl,file]=process.argv.slice(1), descriptor=Object.getOwnPropertyDescriptor(process,'version')
const originalOpen=fs.open, originalPrepare=DatabaseSync.prototype.prepare, originalClose=DatabaseSync.prototype.close
let fileOpens=0, sqlitePrepares=0, sqliteCloses=0, callback=false, rejected=false, reason=null
fs.open=function(...args){fileOpens++;return Reflect.apply(originalOpen,this,args)}
DatabaseSync.prototype.prepare=function(...args){sqlitePrepares++;return Reflect.apply(originalPrepare,this,args)}
DatabaseSync.prototype.close=function(...args){sqliteCloses++;return Reflect.apply(originalClose,this,args)}
syncBuiltinESMExports()
Object.defineProperty(process,'version',{...descriptor,value:'v26.12.2'})
try {
 const {withReadonlyOperationDatabase}=await import(observerUrl)
 try {await withReadonlyOperationDatabase(file,async()=>{callback=true})}
 catch(error){rejected=true;reason=error.detail?.reason??null}
} finally {
 Object.defineProperty(process,'version',descriptor);fs.open=originalOpen;syncBuiltinESMExports()
 DatabaseSync.prototype.prepare=originalPrepare;DatabaseSync.prototype.close=originalClose
}
process.stdout.write(JSON.stringify({fileOpens,sqlitePrepares,sqliteCloses,callback,rejected,reason})+'\n')
`
const initializationFault = async (file: string, mode: 'namespace' | 'bytes' | 'bytes-without-purge' | 'runtime') => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', mode === 'runtime' ? unsupportedRuntimeProgram : initializationFaultProgram,
    pathToFileURL(join(import.meta.dirname, 'readonly-operation-database.ts')).href, file, mode],
  { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, killSignal: 'SIGKILL' })
  children.add(child)
  let stdout = '', stderr = ''
  child.stdout!.on('data', chunk => { stdout += String(chunk); if (stdout.length > 16384) child.kill('SIGKILL') })
  child.stderr!.on('data', chunk => { stderr += String(chunk); if (stderr.length > 16384) child.kill('SIGKILL') })
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => { children.delete(child); resolve({ code, signal }) })
  })
  expect(result.signal, stderr).toBe(null)
  expect(result.code, stderr).toBe(0)
  return JSON.parse(stdout) as Record<string, unknown>
}

describe('actual root host operation guard in a fresh disposable VM', () => {
  it('creates new private directories as root:root even when the daemon group is 987', async () => {
    const f = await fixture(), result = await launch(f.file, 'once', 2_000, 987).done
    expect(result.code, result.stderr + result.stdout).toBe(0)
    await recordOwnedParent()
    for (const path of [parent, HOST_OPERATION_GUARD_DIRECTORY]) {
      const info = await lstat(path)
      expect(info.uid).toBe(0)
      expect(info.gid).toBe(0)
      expect(info.mode & 0o7777).toBe(0o700)
    }
  })

  it('checks genuine scope, exact DB/issuer binding and runtime identity rather than object shape', async () => {
    const f = await fixture()
    let escaped: HostOperationGuard | undefined
    await withHostOperationGuard(f.handle.db, {}, async cap => {
      escaped = cap
      await assertHostOperationGuardHeld(cap, f.binding)
      assertHostOperationGuardActive(cap, f.binding)
      for (const copy of [{ ...cap }, new Proxy(cap, {}), JSON.parse(JSON.stringify(cap))]) {
        expect(() => assertHostOperationGuardActive(copy, f.binding)).toThrow()
        await expect(assertHostOperationGuardHeld(copy, f.binding)).rejects.toThrow()
      }
      for (const changed of [{ ...f.binding, issuerId: randomUUID() }, { ...f.binding, databaseFile: f.file + '.other' },
        { ...f.binding, databaseDevice: f.binding.databaseDevice + '0' }, { ...f.binding, databaseInode: f.binding.databaseInode + '0' }]) {
        expect(() => assertHostOperationGuardActive(cap, changed)).toThrow()
        await expect(assertHostOperationGuardHeld(cap, changed)).rejects.toThrow()
      }
      let reads = 0
      const accessorBinding = { ...f.binding, get issuerId(): string { reads++; throw new Error('untrusted getter') } }
      for (const malformed of [{ ...f.binding, trusted: true }, accessorBinding, null] as unknown as HostOperationGuardBinding[]) {
        expect(() => assertHostOperationGuardActive(cap, malformed)).toThrow()
        await expect(assertHostOperationGuardHeld(cap, malformed)).rejects.toThrow()
      }
      expect(reads).toBe(0)
      await expect(withHostOperationGuard(f.handle.db, {}, async () => undefined)).rejects.toThrow()
      await assertHostOperationGuardHeld(cap, f.binding)
    })
    await recordOwnedParent()
    expect(() => assertHostOperationGuardActive(escaped, f.binding)).toThrow()
    await expect(assertHostOperationGuardHeld(escaped, f.binding)).rejects.toThrow()
  })

  it('refuses a fake outer transaction returning copied real-file provenance before minting physical authority', async () => {
    const f = await fixture()
    let providerCalls = 0, callbacks = 0
    const fakeOuter = { transaction: async () => { providerCalls++; return { ...f.binding } } } as unknown as Db
    await expect(withHostOperationGuard(fakeOuter, {}, async () => { callbacks++ }))
      .rejects.toThrow('a registered public database runner is required')
    expect(providerCalls).toBe(0)
    expect(callbacks).toBe(0)
    await withHostOperationGuard(f.handle.db, {}, async cap => { await assertHostOperationGuardHeld(cap, f.binding) })
    await recordOwnedParent()
  })

  it('rejects a delayed descendant after callback closure and releases after callback failure', async () => {
    const f = await fixture(), marker = new Error('actual callback failure')
    let resume!: () => void, delayed!: Promise<void>
    const gate = new Promise<void>(resolve => { resume = resolve })
    await expect(withHostOperationGuard(f.handle.db, {}, async cap => {
      delayed = gate.then(async () => {
        expect(() => assertHostOperationGuardActive(cap, f.binding)).toThrow()
        await expect(assertHostOperationGuardHeld(cap, f.binding)).rejects.toThrow()
      })
      throw marker
    })).rejects.toBe(marker)
    await recordOwnedParent()
    resume()
    await delayed
    const successor = await launch(f.file, 'once').done
    expect(successor.code, successor.stderr + successor.stdout).toBe(0)
  })

  it('permits the synchronous CAS lifetime check but refuses physical work inside a real active transaction', async () => {
    const f = await fixture()
    await withHostOperationGuard(f.handle.db, {}, async cap => {
      await f.handle.db.transaction(async tx => {
        const origin = getStrictDatabaseIdentity(tx)
        const actual = { databaseFile: origin.file, databaseDevice: origin.device, databaseInode: origin.inode,
          issuerId: await requireOperationalIdentity(tx) }
        assertHostOperationGuardActive(cap, actual)
        await expect(assertHostOperationGuardHeld(cap, actual))
          .rejects.toThrow('no active outer database transaction is allowed for this operation')
        await expect(withHostOperationGuard(f.handle.db, {}, async () => undefined))
          .rejects.toThrow('no active outer database transaction is allowed for this operation')
      })
      await assertHostOperationGuardHeld(cap, f.binding)
    })
    await recordOwnedParent()
  })

  it('drains and refuses an unfinished physical assertion instead of silently acknowledging it', async () => {
    const f = await fixture()
    let pending!: Promise<unknown>
    await expect(withHostOperationGuard(f.handle.db, {}, async cap => {
      pending = assertHostOperationGuardHeld(cap, f.binding).catch(error => error)
      return 'unfinished assertion'
    })).rejects.toBeInstanceOf(AggregateError)
    expect(await pending).toHaveProperty('code', 'CONFLICT')
    await recordOwnedParent()
    expect((await launch(f.file, 'once').done).code).toBe(0)
  })

  it('refuses caller-selected path/platform options and invalid time bounds before creating a scope', async () => {
    const f = await fixture()
    for (const options of [{ directory: '/tmp/unsafe' }, { platform: 'linux' }, { serviceGid: 987 },
      { acquireTimeoutMs: 0 }, { acquireTimeoutMs: 60_001 }, { retryIntervalMs: 0 }, { retryIntervalMs: 1_001 },
      { acquireTimeoutMs: null }, { retryIntervalMs: null }] as unknown as Parameters<typeof withHostOperationGuard>[1][]) {
      let called = false
      await expect(withHostOperationGuard(f.handle.db, options, async () => { called = true })).rejects.toThrow()
      expect(called).toBe(false)
    }
  })

  it('refuses existing unsafe modes and group ownership without repairing them', async () => {
    const f = await fixture()
    await withHostOperationGuard(f.handle.db, {}, async () => undefined)
    await recordOwnedParent()
    try {
      await chmod(HOST_OPERATION_GUARD_DIRECTORY, 0o750)
      await expect(withHostOperationGuard(f.handle.db, {}, async () => undefined)).rejects.toThrow()
      expect((await lstat(HOST_OPERATION_GUARD_DIRECTORY)).mode & 0o7777).toBe(0o750)
      await chmod(HOST_OPERATION_GUARD_DIRECTORY, 0o700)
      await chown(HOST_OPERATION_GUARD_DIRECTORY, 0, 987)
      await expect(withHostOperationGuard(f.handle.db, {}, async () => undefined)).rejects.toThrow()
      expect((await lstat(HOST_OPERATION_GUARD_DIRECTORY)).gid).toBe(987)
    } finally {
      await chown(HOST_OPERATION_GUARD_DIRECTORY, 0, 0)
      await chmod(HOST_OPERATION_GUARD_DIRECTORY, 0o700)
    }
  })

  it('revokes the callback capability after a real held-directory check fails', async () => {
    const f = await fixture()
    await expect(withHostOperationGuard(f.handle.db, {}, async cap => {
      try {
        await chmod(HOST_OPERATION_GUARD_DIRECTORY, 0o750)
        await expect(assertHostOperationGuardHeld(cap, f.binding)).rejects.toThrow()
      } finally { await chmod(HOST_OPERATION_GUARD_DIRECTORY, 0o700) }
      expect(() => assertHostOperationGuardActive(cap, f.binding)).toThrow()
      await expect(assertHostOperationGuardHeld(cap, f.binding)).rejects.toThrow()
      return 'must not become an acknowledged result'
    })).rejects.toThrowError(expect.objectContaining({ code: 'CONFLICT' }))
    await recordOwnedParent()
    expect((await launch(f.file, 'once').done).code).toBe(0)
  })

  it('refuses a symlink at a stopped-writer boundary without following or repairing it', async () => {
    const f = await fixture(), saved = HOST_OPERATION_GUARD_DIRECTORY + '.fixture-saved'
    await withHostOperationGuard(f.handle.db, {}, async () => undefined)
    await recordOwnedParent()
    await rename(HOST_OPERATION_GUARD_DIRECTORY, saved)
    try {
      await symlink(saved, HOST_OPERATION_GUARD_DIRECTORY, 'dir')
      await expect(withHostOperationGuard(f.handle.db, {}, async () => undefined)).rejects.toThrow()
      expect((await lstat(HOST_OPERATION_GUARD_DIRECTORY)).isSymbolicLink()).toBe(true)
    } finally {
      await rm(HOST_OPERATION_GUARD_DIRECTORY)
      await rename(saved, HOST_OPERATION_GUARD_DIRECTORY)
    }
  })

  it('keeps physical exclusion across a paused live owner and permits a successor only after actual death', async () => {
    const f = await fixture(), owner = launch(f.file, 'hold')
    await ready(owner)
    await recordOwnedParent()
    owner.child.kill('SIGSTOP')
    try {
      const contender = await launch(f.file, 'once', 200).done
      expect(contender.code, contender.stderr + contender.stdout).toBe(2)
      expect(contender.stdout).toContain('"code":"CONFLICT"')
      expect(contender.stdout).not.toContain('GUARD_READY')
      expect(owner.child.exitCode).toBeNull()
      expect(owner.child.signalCode).toBeNull()
      owner.child.kill('SIGKILL')
      expect((await owner.done).signal).toBe('SIGKILL')
      const successor = await launch(f.file, 'once').done
      expect(successor.code, successor.stderr + successor.stdout).toBe(0)
    } finally {
      if (owner.child.exitCode === null && owner.child.signalCode === null) {
        owner.child.kill('SIGKILL')
        await owner.done
      }
    }
  })
})


// These cases execute the actual reader and the same fixed native lock as strict managers.
// They do not mint prepared/admission/coordinator readiness or fake a product installation.
describe('actual read-only manager host exclusion in the disposable VM', () => {
  const readonlyFixture = async () => {
    const f = await fixture()
    for (const path of [f.file, f.file + '-wal', f.file + '-shm']) await chmod(path, 0o600)
    return f
  }
  const bytes = async (file: string) => Promise.all([file, file + '-wal'].map(async path =>
    createHash('sha256').update(await readFile(path)).digest('hex')))

  it('holds the real lock with zero SQL writes, rejects strict registration and retires leaked capabilities', async () => {
    const f = await readonlyFixture(), before = await bytes(f.file)
    const walBefore = await lstat(f.file + '-wal', { bigint: true })
    let escaped: HostOperationGuard | undefined, readerAfter: ReadonlyOperationDatabase | undefined
    await withReadonlyOperationDatabase(f.file, async reader => {
      readerAfter = reader
      const walOpened = await lstat(f.file + '-wal', { bigint: true })
      // The actual root SQLite open updates ctime via fchown without changing
      // ownership, permissions, inode, length, mtime or WAL bytes.
      expect(walOpened.ctimeNs).toBeGreaterThan(walBefore.ctimeNs)
      for (const key of ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs'] as const) expect(walOpened[key]).toBe(walBefore[key])
      expect(await bytes(f.file)).toEqual(before)
      await withReadonlyHostOperationGuard(reader, {}, async cap => {
        escaped = cap
        await assertHostOperationGuardHeld(cap, f.binding)
        assertHostOperationGuardActive(cap, f.binding)
        expect(() => getStrictOperationDatabaseOrigin(reader)).toThrow()
        await expect(reader.exec('DELETE FROM operational_identity')).rejects.toThrow()
        expect(await reader.query('SELECT total_changes() AS n')).toEqual([{ n: 0 }])
        for (const copy of [{ ...reader }, new Proxy(reader, {})]) {
          await expect(withReadonlyHostOperationGuard(copy as never, {}, async () => undefined)).rejects.toThrow()
        }
        for (const copy of [{ ...cap }, new Proxy(cap, {})]) expect(() => assertHostOperationGuardActive(copy, f.binding)).toThrow()
      })
      await recordOwnedParent()
      expect(() => assertHostOperationGuardActive(escaped, f.binding)).toThrow()
    })
    expect(await bytes(f.file)).toEqual(before)
    await expect(withReadonlyHostOperationGuard(readerAfter!, {}, async () => undefined)).rejects.toThrow()
    // The normal strict path can acquire after the read-only owner actually retired.
    await withHostOperationGuard(f.handle.db, {}, async cap => { await assertHostOperationGuardHeld(cap, f.binding) })
  })

  it('revokes physical authority on actual WAL drift and never acknowledges a swallowed refusal', async () => {
    const f = await readonlyFixture()
    let guardedWriterRan = false
    await expect(withReadonlyOperationDatabase(f.file, reader => withReadonlyHostOperationGuard(reader, {}, async cap => {
      await f.handle.db.exec('CREATE TABLE readonly_guard_writer_probe (id INTEGER PRIMARY KEY)')
      guardedWriterRan = true
      await expect(assertHostOperationGuardHeld(cap, f.binding)).rejects.toThrow()
      expect(() => assertHostOperationGuardActive(cap, f.binding)).toThrow()
      return 'cannot acknowledge a changed origin'
    }))).rejects.toThrow()
    expect(guardedWriterRan).toBe(true)
    await recordOwnedParent()
    await withHostOperationGuard(f.handle.db, {}, async cap => { await assertHostOperationGuardHeld(cap, f.binding) })
  })

  it('reopens short readers across an unrelated WAL commit while retaining physical ownership', async () => {
    const f = await readonlyFixture()
    let retained: HostOperationGuard | undefined
    await withReopenedReadonlyHostOperationGuard(f.file, {}, async (capability, binding) => {
      retained = capability
      expect(binding).toEqual(f.binding)
      await recordOwnedParent()
      await assertHostOperationGuardHeld(capability, binding)
      const before = await bytes(f.file)
      await f.handle.db.exec('CREATE TABLE reopened_guard_writer_probe (id INTEGER PRIMARY KEY)')
      expect(await bytes(f.file)).not.toEqual(before)
      const after = await bytes(f.file)
      await assertHostOperationGuardHeld(capability, binding)
      expect(await bytes(f.file)).toEqual(after)
    })
    expect(() => assertHostOperationGuardActive(retained, f.binding)).toThrow()
  })

  it('reopens only its own retired reader after a verified same-WAL collision', async () => {
    const f = await readonlyFixture()
    let started!: () => void, written!: () => void
    const admitted = new Promise<void>(resolve => { started = resolve })
    const advanced = new Promise<void>(resolve => { written = resolve })
    let attempts = 0
    let original: ReadonlyOperationDatabase | undefined
    const result = withReobservedReadonlyOperationDatabase(f.file, async reader => {
      if (++attempts === 1) {
        original = reader
        started()
        await advanced
      }
      return reader.query('SELECT total_changes() AS n')
    })
    await Promise.race([admitted, result])
    await f.handle.db.exec('CREATE TABLE reobserved_wal_probe (id INTEGER PRIMARY KEY)')
    written()
    await expect(result).resolves.toEqual([{ n: 0 }])
    expect(attempts).toBe(2)
    await expect(original!.query('SELECT total_changes() AS n')).rejects.toThrow()
  })

  it('does not reobserve a changed WAL mode', async () => {
    const f = await readonlyFixture()
    let attempts = 0
    await expect(withReobservedReadonlyOperationDatabase(f.file, async reader => {
      attempts++
      await chmod(f.file + '-wal', 0o640)
      return reader.query('SELECT total_changes() AS n')
    })).rejects.toThrow()
    expect(attempts).toBe(1)
  })

  it('rejects a later WAL ctime change even when ownership and bytes remain identical', async () => {
    const f = await readonlyFixture(), before = await bytes(f.file)
    let captured = false
    await expect(withReadonlyOperationDatabase(f.file, async reader => {
      captured = true
      const wal = await lstat(f.file + '-wal', { bigint: true })
      await chown(f.file + '-wal', Number(wal.uid), Number(wal.gid))
      const changed = await lstat(f.file + '-wal', { bigint: true })
      expect(changed.ctimeNs).toBeGreaterThan(wal.ctimeNs)
      expect(await bytes(f.file)).toEqual(before)
      await expect(reader.query('SELECT total_changes() AS n')).rejects.toThrow()
    })).rejects.toThrow()
    expect(captured).toBe(true)
  })

  it('keeps the existing options allowlist and never accepts caller availability or lock roots', async () => {
    const f = await readonlyFixture()
    await withReadonlyOperationDatabase(f.file, async reader => {
      for (const options of [{ stopped: true }, { directory: '/tmp/forged-host-lock' }, { assertCurrent: async () => undefined }]) {
        let invoked = false
        await expect(withReadonlyHostOperationGuard(reader, options as never, async () => { invoked = true })).rejects.toThrow()
        expect(invoked).toBe(false)
      }
    })
  })

  it('refuses a restored WAL name after actual SQLite initialization on a replacement inode', async () => {
    const f = await readonlyFixture(), result = await initializationFault(f.file, 'namespace')
    expect(result).toMatchObject({ injected: true, completed: true, restored: true, callback: false, rejected: true,
      reason: 'database_initialization_ancestor_changed', sameInode: true, sameBytes: true, mtimeRestored: true })
  })

  it('refuses an unreviewed live-observer runtime before opening files or SQLite', async () => {
    const f = await readonlyFixture()
    expect(await initializationFault(f.file, 'runtime')).toEqual({ fileOpens: 0, sqlitePrepares: 0, sqliteCloses: 0,
      callback: false, rejected: true, reason: 'pinned_wal_initialization_runtime_required' })
  })

  it('discards transient native page1 content before establishing the stable database proof', async () => {
    const f = await readonlyFixture()
    // This child bypasses only the purge to prove the real native marker is
    // discriminating; the next child executes the unchanged product sequence.
    const withoutPurge = await initializationFault(f.file, 'bytes-without-purge')
    expect(withoutPurge).toMatchObject({ injected: true, completed: true, restored: true, callback: true, rejected: false,
      purgeBypassed: true, sameInode: true, sameBytes: true, mtimeRestored: true })
    expect(withoutPurge.transientVersion).toBe(withoutPurge.marker)
    expect(withoutPurge.stableVersion).toBe(withoutPurge.marker)
    expect(withoutPurge.stableVersion).not.toBe(withoutPurge.originalVersion)
    const stable = await initializationFault(f.file, 'bytes')
    expect(stable).toMatchObject({ injected: true, completed: true, restored: true, callback: true, rejected: false,
      purgeBypassed: false, sameInode: true, sameBytes: true, mtimeRestored: true,
      issuer: f.binding.issuerId, queriedIssuer: f.binding.issuerId })
    expect(stable.transientVersion).toBe(stable.marker)
    expect(stable.stableVersion).toBe(stable.originalVersion)
    expect(stable.stableVersion).not.toBe(stable.marker)
  })
})


describe('read-only host guard lock order', () => {
  it('refuses outer reader and transaction identities while a real read snapshot is active', async () => {
    const f = await fixture()
    for (const path of [f.file, f.file + '-wal', f.file + '-shm']) await chmod(path, 0o600)
    await withReadonlyOperationDatabase(f.file, async reader => {
      await reader.transaction(async tx => {
        for (const value of [reader, tx]) {
          expect(() => assertReadonlyOperationDatabaseOutsideTransaction(value)).toThrow()
          let invoked = false
          await expect(withReadonlyHostOperationGuard(value as never, {}, async () => { invoked = true })).rejects.toThrow()
          expect(invoked).toBe(false)
        }
      })
      assertReadonlyOperationDatabaseOutsideTransaction(reader)
      await withReadonlyHostOperationGuard(reader, {}, async cap => { await assertHostOperationGuardHeld(cap, f.binding) })
      await recordOwnedParent()
    })
  })
})
