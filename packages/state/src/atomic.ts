// Atomic file primitives for the desired-state tree (/var/lib/xpanel/state).
// Every write goes to a sibling temp file, fsyncs the file descriptor, closes it,
// renames over the target, and fsyncs the parent directory.
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { claimStateOwnership } from './ownership.ts'
import { basename, dirname, join } from 'node:path'
import { fail } from '@xpanel/core'

let tmpSeq = 0

/** Fsyncs a directory where the OS permits opening directories for sync (Linux/BSD). */
const fsyncDir = async (dir: string): Promise<void> => {
  let fh
  try {
    fh = await open(dir, 'r')
    await fh.sync()
  } catch {
    // Windows and some virtual filesystems do not allow opening or syncing a directory fd.
  } finally {
    await fh?.close()
  }
}

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const isTransientRenameContention = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
}

/**
 * Atomically writes canonical JSON (`2`-space indented + trailing newline) to `filePath`.
 * Mode defaults to 0o640 per STANDARDS.md.
 * When `beforeCommit` is provided (e.g. fencing-token assertion), it runs after the temp file
 * is synced and closed, immediately before the atomic `rename` over `filePath`.
 */
export const atomicWriteJson = async (
  filePath: string,
  data: unknown,
  mode = 0o640,
  beforeCommit?: () => unknown | Promise<unknown>,
): Promise<void> => {
  const dir = dirname(filePath)
  await mkdir(dir, { recursive: true, mode: 0o750 })
  await claimStateOwnership(dir)
  const tmpName = `.${basename(filePath)}.${process.pid}-${++tmpSeq}.tmp`
  const tmpPath = join(dir, tmpName)
  const payload = `${JSON.stringify(data, null, 2)}\n`
  let fh
  try {
    fh = await open(tmpPath, 'w', mode)
    await fh.writeFile(payload, 'utf8')
    await fh.sync()
  } catch (e) {
    await fh?.close().catch(() => undefined)
    await rm(tmpPath, { force: true }).catch(() => undefined)
    throw e
  }
  await fh.close()
  try {
    if (beforeCommit) await beforeCommit()
    await claimStateOwnership(tmpPath)
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(tmpPath, filePath)
        break
      } catch (err) {
        if (attempt < 5 && isTransientRenameContention(err)) {
          await sleepMs(5 * (attempt + 1))
          continue
        }
        throw err
      }
    }
  } catch (e) {
    await rm(tmpPath, { force: true }).catch(() => undefined)
    throw e
  }
  await claimStateOwnership(filePath)
  await fsyncDir(dir)
}

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
