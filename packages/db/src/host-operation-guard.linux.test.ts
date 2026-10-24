import { createStrictTestDb } from './strict-test-db.ts'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, chown, lstat, mkdtemp, rename, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { disposableVmAcknowledgement } from '../../../scripts/test-linux-preflight.mjs'
import { createDb, type Db, type DbHandle } from './client.ts'
import { migrate } from './migrate.ts'
import { initializeOperationalMetadata, requireOperationalIdentity } from './repos/official-references.ts'
import { getStrictDatabaseIdentity } from './sql-runner.ts'
import {
  HOST_OPERATION_GUARD_DIRECTORY,
  assertHostOperationGuardActive,
  assertHostOperationGuardHeld,
  withHostOperationGuard,
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
