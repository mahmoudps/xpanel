import { AsyncLocalStorage } from 'node:async_hooks'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { fail } from '@xpanel/core'
import { WriterLock } from '@xpanel/state'
import type { WriterLease } from '@xpanel/state'
import type { Db } from './client.ts'
import { assertNoActiveDatabaseTransaction, assertRegisteredDatabaseRunner, getStrictDatabaseIdentity } from './sql-runner.ts'
import { requireOperationalIdentity } from './repos/official-references.ts'

export const HOST_OPERATION_GUARD_DIRECTORY = '/var/lib/xpanel-agent/host-operations'
declare const hostOperationGuardBrand: unique symbol

/** Opaque physical exclusion scope; neither this type nor a logical job lease proves authorization. */
export interface HostOperationGuard {
  readonly [hostOperationGuardBrand]: true
}

export interface HostOperationGuardBinding {
  readonly databaseFile: string
  readonly databaseDevice: string
  readonly databaseInode: string
  readonly issuerId: string
}

export interface HostOperationGuardOptions {
  readonly acquireTimeoutMs?: number
  readonly retryIntervalMs?: number
}

interface DirectoryPin {
  readonly path: string
  readonly handle: FileHandle
  readonly device: bigint
  readonly inode: bigint
  readonly private: boolean
}

interface DatabasePin {
  readonly path: string
  readonly device: bigint
  readonly inode: bigint
}

interface GuardScope {
  phase: 'held' | 'closing' | 'released' | 'faulted'
  faulted: boolean
  readonly binding: HostOperationGuardBinding
  readonly directories: readonly DirectoryPin[]
  readonly databasePin: DatabasePin
  readonly lease: WriterLease
  readonly assertions: Set<Promise<void>>
}

const capabilities = new WeakMap<object, GuardScope>()
const scopes = new AsyncLocalStorage<GuardScope>()

const requireLinuxRoot = (): void => {
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.geteuid?.() !== 0) {
    fail('PRECONDITION_FAILED', 'host operation ownership requires actual Linux root')
  }
}

const optionsFor = (value: HostOperationGuardOptions): Required<HostOperationGuardOptions> => {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return fail('VALIDATION', 'invalid host operation guard options')
  }
  const keys = Reflect.ownKeys(value)
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if ((key !== 'acquireTimeoutMs' && key !== 'retryIntervalMs') || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      return fail('VALIDATION', 'unknown host operation guard option')
    }
  }
  const acquireTimeoutMs = value.acquireTimeoutMs === undefined ? 15_000 : value.acquireTimeoutMs
  const retryIntervalMs = value.retryIntervalMs === undefined ? 15 : value.retryIntervalMs
  if (!Number.isSafeInteger(acquireTimeoutMs) || acquireTimeoutMs < 1 || acquireTimeoutMs > 60_000 ||
      !Number.isSafeInteger(retryIntervalMs) || retryIntervalMs < 1 || retryIntervalMs > 1_000) {
    return fail('VALIDATION', 'host operation guard time bounds are invalid')
  }
  return { acquireTimeoutMs, retryIntervalMs }
}

const captureDatabaseBinding = async (db: Db): Promise<HostOperationGuardBinding> => {
  if (!db || typeof db.transaction !== 'function') return fail('PRECONDITION_FAILED', 'a genuine strict database connection is required')
  return db.transaction(async tx => {
    const { file, device, inode } = getStrictDatabaseIdentity(tx)
    const issuerId = await requireOperationalIdentity(tx)
    return Object.freeze({ databaseFile: file, databaseDevice: device, databaseInode: inode, issuerId })
  })
}

const pinDatabasePath = async (binding: HostOperationGuardBinding): Promise<DatabasePin> => {
  const file = binding.databaseFile
  if (!isAbsolute(file) || resolve(file) !== file || file.includes('\0') || await realpath(file) !== file) {
    return fail('PRECONDITION_FAILED', 'the strict operation database path must be canonical')
  }
  const info = await lstat(file, { bigint: true })
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n ||
      String(info.dev) !== binding.databaseDevice || String(info.ino) !== binding.databaseInode) {
    return fail('PRECONDITION_FAILED', 'the strict operation database path is unsafe')
  }
  return { path: file, device: info.dev, inode: info.ino }
}

const assertDatabasePath = async (pin: DatabasePin): Promise<void> => {
  const info = await lstat(pin.path, { bigint: true })
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.dev !== pin.device || info.ino !== pin.inode) {
    fail('CONFLICT', 'the operation database inode changed; stopped-writer recovery is required')
  }
}

const assertDirectory = async (pin: DirectoryPin): Promise<void> => {
  const [opened, named] = await Promise.all([pin.handle.stat({ bigint: true }), lstat(pin.path, { bigint: true })])
  const unsafe = (info: typeof opened): boolean => !info.isDirectory() || info.isSymbolicLink() || info.uid !== 0n ||
    (pin.private ? info.gid !== 0n || (info.mode & 0o7777n) !== 0o700n : (info.mode & 0o022n) !== 0n)
  if (unsafe(opened) || unsafe(named) || opened.dev !== pin.device || opened.ino !== pin.inode ||
      named.dev !== pin.device || named.ino !== pin.inode) {
    fail('CONFLICT', 'a trusted host operation directory changed or has unsafe ownership or permissions')
  }
}

const openDirectory = async (path: string, isPrivate: boolean, created: boolean, parent?: DirectoryPin): Promise<DirectoryPin> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const initial = await handle.stat({ bigint: true })
    const named = await lstat(path, { bigint: true })
    if (!initial.isDirectory() || initial.uid !== 0n || !named.isDirectory() || named.isSymbolicLink() ||
        initial.dev !== named.dev || initial.ino !== named.ino) {
      fail('PRECONDITION_FAILED', 'the host operation directory is not a trusted root-owned inode')
    }
    if (created) {
      // Restrict only the inode this call created; never repair an existing directory or daemon GID.
      await handle.chown(0, 0)
      await handle.chmod(0o700)
      await handle.sync()
      await parent?.handle.sync()
    }
    const pin: DirectoryPin = { path, handle, device: initial.dev, inode: initial.ino, private: isPrivate }
    await assertDirectory(pin)
    return pin
  } catch (error) {
    try { await handle.close() }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'host operation directory validation and cleanup failed') }
    throw error
  }
}

const closeDirectories = async (pins: readonly DirectoryPin[]): Promise<unknown[]> => {
  const errors: unknown[] = []
  for (const pin of [...pins].reverse()) {
    try { await pin.handle.close() } catch (error) { errors.push(error) }
  }
  return errors
}

const pinGuardDirectories = async (): Promise<DirectoryPin[]> => {
  const pins: DirectoryPin[] = []
  try {
    for (const path of ['/', '/var', '/var/lib']) pins.push(await openDirectory(path, false, false))
    for (const path of ['/var/lib/xpanel-agent', HOST_OPERATION_GUARD_DIRECTORY]) {
      const parent = pins.at(-1)!
      await assertDirectory(parent)
      let created = false
      try { await mkdir(path, { mode: 0o700 }); created = true }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      pins.push(await openDirectory(path, true, created, parent))
      await assertDirectory(parent)
    }
    return pins
  } catch (error) {
    const cleanup = await closeDirectories(pins)
    if (cleanup.length) throw new AggregateError([error, ...cleanup], 'host operation directory setup and cleanup failed')
    throw error
  }
}

const activeScope = (capability: unknown, expected: HostOperationGuardBinding): GuardScope => {
  const state = capability !== null && typeof capability === 'object' ? capabilities.get(capability) : undefined
  if (!state) return fail('PRECONDITION_FAILED', 'a genuine root host operation guard capability is required')
  if (scopes.getStore() !== state || state.phase !== 'held') return fail('CONFLICT', 'the host operation guard is outside its active callback scope')
  const keys = expected && typeof expected === 'object' ? Reflect.ownKeys(expected) : []
  if (keys.length !== 4 || !keys.includes('databaseFile') || !keys.includes('databaseDevice') ||
      !keys.includes('databaseInode') || !keys.includes('issuerId') || keys.some(key => {
    const property = Object.getOwnPropertyDescriptor(expected, key)
    return !property?.enumerable || !Object.hasOwn(property, 'value')
  })) return fail('PRECONDITION_FAILED', 'an actual operation database and issuer binding is required')
  if (expected.databaseFile !== state.binding.databaseFile || expected.databaseDevice !== state.binding.databaseDevice ||
      expected.databaseInode !== state.binding.databaseInode || expected.issuerId !== state.binding.issuerId) {
    return fail('CONFLICT', 'the host operation guard belongs to another database or issuer')
  }
  return state
}

/** Non-I/O lifetime/binding assertion for a short DB CAS, after the real physical assertion. */
export const assertHostOperationGuardActive = (capability: unknown, expected: HostOperationGuardBinding): void => {
  activeScope(capability, expected)
}

/** Checks the actual held WriterLease and pinned paths outside any control DB transaction. */
export const assertHostOperationGuardHeld = async (capability: unknown, expected: HostOperationGuardBinding): Promise<void> => {
  assertNoActiveDatabaseTransaction()
  const state = activeScope(capability, expected)
  const pending = (async () => {
    for (const pin of state.directories) await assertDirectory(pin)
    await assertDatabasePath(state.databasePin)
    await state.lease.assertFencingToken()
    activeScope(capability, expected)
  })()
  state.assertions.add(pending)
  try { await pending }
  catch (error) {
    state.faulted = true
    if (state.phase === 'held') state.phase = 'faulted'
    throw error
  }
  finally { state.assertions.delete(pending) }
}

/**
 * Owns real host exclusion until the callback settles. The callback must await all mutations and
 * native-child quiescence; this capability cannot kill/fence detached children or authorize effects.
 */
export const withHostOperationGuard = async <T>(
  db: Db,
  options: HostOperationGuardOptions,
  callback: (capability: HostOperationGuard) => Promise<T>,
): Promise<T> => {
  assertRegisteredDatabaseRunner(db)
  requireLinuxRoot()
  assertNoActiveDatabaseTransaction()
  const lockOptions = optionsFor(options)
  if (typeof callback !== 'function') return fail('VALIDATION', 'a host operation callback is required')
  if (scopes.getStore()?.phase === 'held') return fail('PRECONDITION_FAILED', 'nested host operation guards are unsupported')
  const binding = await captureDatabaseBinding(db)
  const databasePin = await pinDatabasePath(binding)
  const directories = await pinGuardDirectories()
  let lease: WriterLease | undefined
  let state: GuardScope | undefined
  let result: T | undefined
  let failure: unknown
  let failed = false
  try {
    lease = await new WriterLock(HOST_OPERATION_GUARD_DIRECTORY, lockOptions).acquire()
    const current = await captureDatabaseBinding(db)
    if (current.databaseFile !== binding.databaseFile || current.databaseDevice !== binding.databaseDevice ||
        current.databaseInode !== binding.databaseInode || current.issuerId !== binding.issuerId) {
      fail('CONFLICT', 'the strict operation database or issuer changed while acquiring host ownership')
    }
    const ownedScope: GuardScope = { phase: 'held', faulted: false, binding, directories, databasePin, lease, assertions: new Set() }
    state = ownedScope
    const capability = Object.freeze(Object.create(null)) as HostOperationGuard
    capabilities.set(capability, ownedScope)
    result = await scopes.run(ownedScope, async () => {
      try {
        await assertHostOperationGuardHeld(capability, binding)
        return await callback(capability)
      } finally {
        // Invalidate inside the owning scope before its wrapper promise settles.
        ownedScope.phase = 'closing'
      }
    })
    if (ownedScope.faulted) fail('CONFLICT', 'host operation physical ownership failed; callback result cannot be acknowledged')
  } catch (error) { failed = true; failure = error }

  // Invalidate before any await so escaped callbacks cannot reuse a closing/released capability.
  if (state) state.phase = 'closing'
  const cleanupErrors: unknown[] = []
  if (state) for (const assertion of await Promise.allSettled([...state.assertions])) {
    if (assertion.status === 'rejected') cleanupErrors.push(assertion.reason)
  }
  if (lease) { try { await lease.release() } catch (error) { cleanupErrors.push(error) } }
  cleanupErrors.push(...await closeDirectories(directories))
  if (state) state.phase = 'released'
  if (cleanupErrors.length) throw new AggregateError(failed ? [failure, ...cleanupErrors] : cleanupErrors, 'host operation guard cleanup requires inspection')
  if (failed) throw failure
  return result as T
}
