// Atomic file primitives for the desired-state tree (/var/lib/xpanel/state).
// Every write goes to a sibling temp file, fsyncs the file descriptor, closes it,
// renames over the target, and fsyncs the parent directory.
import { lstat, mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { constants } from 'node:fs'
import { claimStateOwnership } from './ownership.ts'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fail } from '@xpanel/core'

let tmpSeq = 0

export type StateDirectoryDurabilityPhase = 'open' | 'sync' | 'close'

/** Publication may already be visible. This error never proves unchanged data or rollback. */
export class StateDirectoryDurabilityError extends Error {
  readonly code = 'STATE_DIRECTORY_DURABILITY'
  readonly directory: string
  readonly phase: StateDirectoryDurabilityPhase
  closeCause?: unknown
  constructor(directory: string, phase: StateDirectoryDurabilityPhase, cause: unknown) {
    super('state directory durability could not be confirmed', { cause })
    this.name = 'StateDirectoryDurabilityError'
    this.directory = directory
    this.phase = phase
  }
}

export const isStateDirectoryDurabilityError = (error: unknown): error is StateDirectoryDurabilityError =>
  error instanceof StateDirectoryDurabilityError

/**
 * Linux/BSD failures are fatal. Windows retains a bounded best-effort exception:
 * directory open EISDIR/EPERM; directory sync EINVAL/ENOTSUP. Actual Node 26 on
 * Windows also returns EPERM/fsync for an opened directory: that exception
 * additionally requires fstat on this same descriptor to prove it is a directory.
 * A failed descriptor check keeps the original error fatal. These bounded OS
 * compatibility codes do not establish Windows power-loss durability or prove
 * that every such failure is an unsupported filesystem operation. Permission,
 * capacity, I/O, unknown and all close failures otherwise remain fatal.
 */
const windowsUnsupportedDirectoryOperation = (phase: 'open' | 'sync', error: unknown): boolean => {
  if (process.platform !== 'win32') return false
  const code = (error as NodeJS.ErrnoException | null)?.code
  return phase === 'open' ? code === 'EISDIR' || code === 'EPERM' : code === 'EINVAL' || code === 'ENOTSUP'
}

/** Sync a published directory entry; preserve the first failure if close also fails. */
export const fsyncDir = async (dir: string): Promise<void> => {
  let fh
  try {
    fh = await open(dir, 'r')
  } catch (cause) {
    if (windowsUnsupportedDirectoryOperation('open', cause)) return
    throw new StateDirectoryDurabilityError(dir, 'open', cause)
  }
  let failure: StateDirectoryDurabilityError | undefined
  try {
    await fh.sync()
  } catch (cause) {
    let unsupported = windowsUnsupportedDirectoryOperation('sync', cause)
    const io = cause as NodeJS.ErrnoException | null
    if (!unsupported && process.platform === 'win32' && io?.code === 'EPERM' && io.syscall === 'fsync') {
      try { unsupported = (await fh.stat()).isDirectory() === true }
      catch { /* Failure to prove the descriptor is a directory preserves the original error. */ }
    }
    if (!unsupported) failure = new StateDirectoryDurabilityError(dir, 'sync', cause)
  }
  try { await fh.close() }
  catch (cause) {
    if (failure) failure.closeCause = cause
    else failure = new StateDirectoryDurabilityError(dir, 'close', cause)
  }
  if (failure) throw failure
}

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const isTransientRenameContention = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
}
const writeSyncedPayload = async (handle: FileHandle, payload: string, mode: number, rootOwned: boolean): Promise<void> => {
  if (rootOwned) await handle.chown(0, 0)
  await handle.chmod(mode)
  await handle.writeFile(payload, 'utf8')
  await handle.sync()
}
const renameWithRetry = async (source: string, target: string): Promise<void> => {
  for (let attempt = 0; ; attempt++) {
    try { await rename(source, target); return }
    catch (error) {
      if (attempt >= 5 || !isTransientRenameContention(error)) throw error
      await sleepMs(5 * (attempt + 1))
    }
  }
}

/**
 * Atomically writes canonical JSON (`2`-space indented + trailing newline) to `filePath`.
 * Mode defaults to 0o640 per STANDARDS.md.
 * When `beforeCommit` is provided (e.g. fencing-token assertion), it runs after the temp file
 * is synced and closed, immediately before the atomic `rename` over `filePath`.
 */
const writeJson = async (
  filePath: string,
  data: unknown,
  mode = 0o640,
  beforeCommit?: () => unknown | Promise<unknown>,
  rootOwned = false,
): Promise<void> => {
  const dir = dirname(filePath)
  if (rootOwned) return writeRootOwnedJson(filePath, data, mode, beforeCommit)
  // mkdir returns the first directory it created: every new level takes the state owner, not only the leaf,
  // or a root writer (the agent) leaves an intermediate directory the API cannot write into.
  const firstCreated = await mkdir(dir, { recursive: true, mode: 0o750 })
  const levels = [dir]
  if (firstCreated !== undefined) while (levels[0] !== firstCreated && dirname(levels[0]!) !== levels[0]) levels.unshift(dirname(levels[0]!))
  for (const level of levels) await claimStateOwnership(level)
  const tmpName = `.${basename(filePath)}.${process.pid}-${++tmpSeq}.tmp`
  const tmpPath = join(dir, tmpName)
  const payload = `${JSON.stringify(data, null, 2)}\n`
  let fh
  let temporaryIdentity: { dev: number; ino: number } | undefined
  const removeOwnedTemporary = async (): Promise<void> => {
    const identity = temporaryIdentity
    if (!identity) return
    try {
      const named = await lstat(tmpPath)
      if (named.isFile() && named.dev === identity.dev && named.ino === identity.ino) {
        await rm(tmpPath, { force: true })
      }
    } catch { /* Best-effort cleanup never removes a path whose ownership is unproved. */ }
  }
  try {
    fh = await open(tmpPath, 'wx', mode)
    const created = await fh.stat()
    temporaryIdentity = { dev: created.dev, ino: created.ino }
    // Creation mode is filtered by umask; enforce the requested mode on this owned FD.
    await writeSyncedPayload(fh, payload, mode, false)
    await fh.close()
  } catch (e) {
    await fh?.close().catch(() => undefined)
    await removeOwnedTemporary()
    throw e
  }
  try {
    if (beforeCommit) await beforeCommit()
    await claimStateOwnership(tmpPath)
    await renameWithRetry(tmpPath, filePath)
  } catch (e) {
    await removeOwnedTemporary()
    throw e
  }
  await claimStateOwnership(filePath)
  await fsyncDir(dir)
}

export const atomicWriteJson = async (filePath: string, data: unknown, mode = 0o640, beforeCommit?: () => unknown | Promise<unknown>): Promise<void> =>
  writeJson(filePath, data, mode, beforeCommit)

export const requireActualLinuxRoot = (): void => {
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.geteuid?.() !== 0) {
    return fail('PRECONDITION_FAILED', 'root-owned state requires actual Linux root')
  }
}

/** Validate and pin every directory in a root-only state path. No existing inode is repaired. */
export const pinRootOwnedDirectory = async (directory: string) => {
  requireActualLinuxRoot()
  if (!isAbsolute(directory) || resolve(directory) !== directory) return fail('VALIDATION', 'root-owned directory path must be canonical')
  const paths: string[] = [sep]
  for (const part of directory.slice(1).split(sep).filter(Boolean)) paths.push(join(paths.at(-1)!, part))
  const pins: { path: string; handle: Awaited<ReturnType<typeof open>>; dev: bigint; ino: bigint }[] = []
  const assert = async (): Promise<void> => {
    requireActualLinuxRoot()
    for (const [i, pin] of pins.entries()) {
      const [held, named] = await Promise.all([pin.handle.stat({ bigint: true }), lstat(pin.path, { bigint: true })])
      const safe = (s: typeof held) => s.isDirectory() && !s.isSymbolicLink() && s.uid === 0n && (s.mode & 0o022n) === 0n &&
        (i !== pins.length - 1 || s.gid === 0n && (s.mode & 0o7777n) === 0o700n)
      if (!safe(held) || !safe(named) || held.dev !== pin.dev || held.ino !== pin.ino || named.dev !== pin.dev || named.ino !== pin.ino) {
        return fail('CONFLICT', 'root-owned state directory changed or is unsafe')
      }
    }
  }
  try {
    for (const path of paths) {
      const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try {
        const info = await handle.stat({ bigint: true })
        pins.push({ path, handle, dev: info.dev, ino: info.ino })
      } catch (error) { await handle.close(); throw error }
    }
    await assert()
    return { handle: pins.at(-1)!.handle, assert, close: async () => {
      const errors: unknown[] = []
      for (const pin of pins.reverse()) try { await pin.handle.close() } catch (error) { errors.push(error) }
      if (errors.length) throw new AggregateError(errors, 'root-owned directory descriptors could not be closed')
    } }
  } catch (error) {
    for (const pin of pins.reverse()) await pin.handle.close().catch(() => undefined)
    throw error
  }
}

/** Root-only publication. The directory must already exist and be private. */
const writeRootOwnedJson = async (filePath: string, data: unknown, mode: number, beforeCommit?: () => unknown | Promise<unknown>): Promise<void> => {
  requireActualLinuxRoot()
  if (!isAbsolute(filePath) || resolve(filePath) !== filePath || ![0o600, 0o640].includes(mode)) return fail('VALIDATION', 'invalid root-owned state publication')
  const pin = await pinRootOwnedDirectory(dirname(filePath))
  const dir = `/proc/self/fd/${pin.handle.fd}`
  const target = join(dir, basename(filePath))
  const tmp = join(dir, `.${basename(filePath)}.${process.pid}-${++tmpSeq}.tmp`)
  const inspect = async (path: string) => lstat(path, { bigint: true }).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
  const safeTarget = (info: Awaited<ReturnType<typeof inspect>>): void => {
    if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.uid !== 0n || info.gid !== 0n || (info.mode & 0o022n) !== 0n)) fail('CONFLICT', 'root-owned state target is unsafe')
  }
  let temporaryIdentity: { dev: bigint; ino: bigint } | undefined
  let published = false, failed = false, failure: unknown
  try {
    const prior = await inspect(target)
    safeTarget(prior)
    const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
    try {
      const created = await fh.stat({ bigint: true })
      temporaryIdentity = { dev: created.dev, ino: created.ino }
      await writeSyncedPayload(fh, `${JSON.stringify(data, null, 2)}\n`, mode, true)
    } finally { await fh.close() }
    if (beforeCommit) await beforeCommit()
    await pin.assert()
    const current = await inspect(target)
    safeTarget(current)
    if ((prior === null) !== (current === null) || prior && current && (prior.dev !== current.dev || prior.ino !== current.ino)) return fail('CONFLICT', 'root-owned state target changed')
    const named = await inspect(tmp)
    if (!named || !named.isFile() || named.nlink !== 1n || named.uid !== 0n || named.gid !== 0n || named.dev !== temporaryIdentity.dev || named.ino !== temporaryIdentity.ino) return fail('CONFLICT', 'root-owned temporary file changed')
    await renameWithRetry(tmp, target)
    published = true
    temporaryIdentity = undefined
    await fsyncDir(dir)
    try { await pin.assert() }
    catch (cause) { throw new StateDirectoryDurabilityError(dirname(filePath), 'sync', cause) }
  } catch (cause) {
    failed = true
    failure = cause
  } finally {
    if (temporaryIdentity) {
      const named = await inspect(tmp).catch(() => null)
      if (named?.isFile() && named.dev === temporaryIdentity.dev && named.ino === temporaryIdentity.ino) await rm(tmp, { force: true }).catch(() => undefined)
    }
    try { await pin.close() }
    catch (cause) {
      if (failure instanceof StateDirectoryDurabilityError) failure.closeCause = cause
      else if (failed) failure = new AggregateError([failure, cause], 'root-owned publication and directory cleanup failed')
      else { failed = true; failure = cause }
    }
  }
  if (failed) {
    if (published && !isStateDirectoryDurabilityError(failure)) throw new StateDirectoryDurabilityError(dirname(filePath), 'close', failure)
    throw failure
  }
}

export const atomicWriteRootOwnedJson = async (filePath: string, data: unknown, mode = 0o640, beforeCommit?: () => unknown | Promise<unknown>): Promise<void> =>
  writeJson(filePath, data, mode, beforeCommit, true)

/** Reads and parses a JSON file, returning `null` if it does not exist. */
export const readJsonIfExists = async <T>(filePath: string): Promise<T | null> => {
  let raw: string
  for (let attempt = 0; ; attempt++) {
    try {
      raw = await readFile(filePath, 'utf8')
      break
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return null
      if (attempt < 4 && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')) {
        await sleepMs(4 * (attempt + 1))
        continue
      }
      throw e
    }
  }
  try {
    return JSON.parse(raw) as T
  } catch (e) {
    return fail('VALIDATION', `corrupt state file ${filePath}: ${(e as Error).message}`, { path: filePath })
  }
}

/** Removes a file or directory atomically and syncs the parent directory. */
export const atomicRemove = async (
  targetPath: string,
  beforeCommit?: () => unknown | Promise<unknown>,
): Promise<boolean> => {
  try {
    await stat(targetPath)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw e
  }
  if (beforeCommit) await beforeCommit()
  await rm(targetPath, { recursive: true, force: true })
  await fsyncDir(dirname(targetPath))
  return true
}

/** Lists `.json` files in a directory in deterministic lexical order; returns `[]` if missing. */
export const listJsonFiles = async (dir: string): Promise<string[]> => {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  return entries
    .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
    .sort()
    .map((f) => join(dir, f))
}

/** Lists subdirectories in deterministic lexical order; returns `[]` if missing. */
export const listSubdirs = async (dir: string): Promise<string[]> => {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort()
}

/**
 * FIFO in-process mutex to serialise state mutations so concurrent checks
 * (UID allocation, domain uniqueness, reseller capacity, plan caps) never race.
 */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve()

  run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.tail
    let release!: () => void
    this.tail = new Promise<void>((r) => {
      release = r
    })
    return prev.then(fn).finally(() => release())
  }
}
