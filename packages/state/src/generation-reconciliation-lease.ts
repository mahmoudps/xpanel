import { DatabaseSync } from 'node:sqlite'
import { lstat, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fail } from '@xpanel/core'
import { claimStateOwnership } from './ownership.ts'
import { acquireWriterMutex, WRITER_MUTEX_FILE } from './writer-mutex.ts'

/** The existing physical SQLite mutex protocol is reused in the generations directory. */
export const generationReconciliationMutexPath = (stateRoot: string): string => join(stateRoot, 'generations', WRITER_MUTEX_FILE)

export async function withGenerationReconciliationLease<T>(stateRoot: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(stateRoot, { recursive: true, mode: 0o750 })
  const root = await lstat(stateRoot)
  if (!root.isDirectory() || root.isSymbolicLink() || process.platform !== 'win32' && (root.mode & 0o022) !== 0) return fail('PRECONDITION_FAILED', 'generation operations require a protected real state directory')
  await claimStateOwnership(stateRoot)
  const directory = join(stateRoot, 'generations')
  await mkdir(directory, { recursive: true, mode: 0o750 })
  const parent = await lstat(directory)
  if (!parent.isDirectory() || parent.isSymbolicLink() || process.platform !== 'win32' && (parent.mode & 0o022) !== 0) return fail('PRECONDITION_FAILED', 'generation operations require a real protected generations directory')
  await claimStateOwnership(directory)
  const lease = await acquireWriterMutex(generationReconciliationMutexPath(stateRoot), 15000, 15)
  try { await lease.assertStable(); const result = await operation(); await lease.assertStable(); return result }
  finally { await lease.release() }
}

/** Existing inode inspection only: no directory, database, schema or reference is created. */
export async function readGenerationReconciliationLeaseAvailable(stateRoot: string): Promise<boolean> {
  let database: DatabaseSync | undefined
  try {
    const root = await lstat(stateRoot, { bigint: true })
    const directory = await lstat(join(stateRoot, 'generations'), { bigint: true })
    const path = generationReconciliationMutexPath(stateRoot), before = await lstat(path, { bigint: true })
    if (!root.isDirectory() || root.isSymbolicLink() || process.platform !== 'win32' && (root.mode & 0o022n) !== 0n
      || !directory.isDirectory() || directory.isSymbolicLink() || process.platform !== 'win32' && (directory.mode & 0o022n) !== 0n
      || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || process.platform !== 'win32' && ((before.mode & 0o777n) !== 0o660n || before.gid !== directory.gid)) return false
    database = new DatabaseSync(path, { readOnly: true, timeout: 0 })
    database.prepare('PRAGMA schema_version').get()
    const after = await lstat(path, { bigint: true })
    return after.isFile() && !after.isSymbolicLink() && after.nlink === 1n && before.dev === after.dev && before.ino === after.ino && before.mode === after.mode && before.gid === after.gid
  } catch { return false }
  finally { database?.close() }
}
