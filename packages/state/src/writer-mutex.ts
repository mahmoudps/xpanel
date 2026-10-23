import { DatabaseSync } from 'node:sqlite'
import { chmod, chown, lstat, mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fail } from '@xpanel/core'

/** Permanent operational inode: never raw-read, copy, rename or unlink while writers may run. */
export const WRITER_MUTEX_FILE = '.writer-mutex.sqlite'
export interface WriterMutexGuard { readonly identity: string; assertStable(): Promise<void>; release(): Promise<void> }
const busy = (error: unknown): boolean => {
  const item = error as { code?: string; errcode?: number }
  return item.code === 'SQLITE_BUSY' || item.code === 'SQLITE_LOCKED' || typeof item.errcode === 'number' && [5, 6].includes(item.errcode & 255)
}
const localInitializers = new Map<string, Promise<unknown>>()
const inspect = (path: string) => lstat(path, { bigint: true }).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** SQLite owns every opened mutex fd; do not fs.open/readFile it, even for hashing. */
const openInitialized = async (path: string, timeoutMs: number, retryMs: number): Promise<DatabaseSync> => {
  const previous = localInitializers.get(path) ?? Promise.resolve()
  const pending = previous.catch(() => undefined).then(async () => {
    const start = Date.now(), initDir = path + '-init'
    const parent = await lstat(dirname(path), { bigint: true })
    const validate = (info: NonNullable<Awaited<ReturnType<typeof inspect>>>) => {
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || process.platform !== 'win32' && (info.mode & 0o777n) !== 0o660n || process.platform !== 'win32' && info.gid !== parent.gid) return fail('VALIDATION', 'state writer mutex has unsafe type, links, mode or group')
    }
    for (;;) {
      const info = await inspect(path)
      if (info) {
        if (!await inspect(initDir)) { validate(info); return new DatabaseSync(path, { timeout: 0 }) }
        // Another process may be between SQLite creation and restrictive permission publication.
      } else {
        let ownsInit = false
        try {
          try { await mkdir(initDir, { mode: 0o700 }); ownsInit = true }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
          if (ownsInit) {
            const appeared = await inspect(path)
            if (appeared) { validate(appeared); return new DatabaseSync(path, { timeout: 0 }) }
            const db = new DatabaseSync(path, { timeout: 0 })
            try {
              const created = await inspect(path)
              if (!created || !created.isFile() || created.isSymbolicLink() || created.nlink !== 1n) fail('VALIDATION', 'new state writer mutex inode is invalid')
              if (process.platform !== 'win32') { await chown(path, -1, Number(parent.gid)); await chmod(path, 0o660) }
              validate((await inspect(path))!)
              return db
            } catch (error) { db.close(); throw error }
          }
        } finally { if (ownsInit) await rm(initDir, { recursive: true }) }
      }
      if (Date.now() - start >= timeoutMs) return fail('CONFLICT', 'state writer mutex initialization requires stopped-writer inspection')
      await sleep(retryMs)
    }
  })
  localInitializers.set(path, pending)
  try { return await pending } finally { if (localInitializers.get(path) === pending) localInitializers.delete(path) }
}

/** One connection per scope; busy_timeout=0 plus asynchronous retries keeps same-process progress possible. */
export const acquireWriterMutex = async (path: string, timeoutMs: number, retryMs: number): Promise<WriterMutexGuard> => {
  const db = await openInitialized(path, timeoutMs, retryMs)
  let initial
  try {
    initial = await inspect(path)
    if (!initial || !initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1n) fail('VALIDATION', 'state writer mutex inode is unavailable')
  } catch (error) { db.close(); throw error }
  const identity = initial!.dev + ':' + initial!.ino
  const assertStable = async () => {
    const current = await inspect(path)
    if (!current || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || current.dev + ':' + current.ino !== identity || process.platform !== 'win32' && ((current.mode & 0o777n) !== 0o660n || current.gid !== initial!.gid)) return fail('CONFLICT', 'state writer mutex inode changed; stopped-writer inspection is required')
  }
  let held = false, closed = false
  const start = Date.now()
  try {
    db.exec('PRAGMA busy_timeout=0')
    for (;;) {
      await assertStable()
      try { db.exec('BEGIN IMMEDIATE'); held = true; break }
      catch (error) {
        if (!busy(error)) throw error
        if (Date.now() - start >= timeoutMs) return fail('CONFLICT', 'timed out waiting for the state writer OS mutex', { timeoutMs })
        await sleep(Math.min(retryMs + Math.floor(Math.random() * 5), Math.max(1, timeoutMs - (Date.now() - start))))
      }
    }
  } catch (error) { db.close(); throw error }
  return { identity, assertStable, release: async () => {
    if (closed) return
    closed = true
    try { await assertStable() } finally { try { if (held) db.exec('ROLLBACK') } finally { db.close() } }
  } }
}
