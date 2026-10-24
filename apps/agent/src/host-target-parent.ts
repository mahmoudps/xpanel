import { constants } from 'node:fs'
import { lstat, open, readdir, readlink, rmdir, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, parse, posix } from 'node:path'
import { fail } from '@xpanel/core'

/** Retire an owned descriptor without losing the operation's primary failure. */
export async function withOwnedHostFileHandle<T>(handle: FileHandle, operation: (handle: FileHandle) => Promise<T>): Promise<T> {
  let operationFailed = false
  let primaryFailure: unknown
  try { return await operation(handle) }
  catch (error) { operationFailed = true; primaryFailure = error; throw error }
  finally {
    try { await handle.close() }
    catch (error) {
      if (operationFailed) throw new AggregateError([primaryFailure, error], 'managed host operation failed and its descriptor could not be closed', { cause: primaryFailure })
      throw error
    }
  }
}

/** The caller authorizes the original canonical path before invoking this primitive. */
export async function withPinnedHostTargetParent<T>(path: string, operation: (anchoredPath: string) => Promise<T>): Promise<T> {
  if (process.platform !== 'linux') {
    // Explicit grants support owned portable fixtures. Production requires
    // Linux/root and its Unix matcher cannot grant Windows paths. This refuses
    // existing junctions; it does not qualify native race confinement.
    let parent = dirname(path)
    while (parent !== parse(parent).root) {
      const metadata = await lstat(parent)
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail('PRECONDITION_FAILED', 'managed host target ancestors must be directories without links')
      parent = dirname(parent)
    }
    return operation(path)
  }

  let normalized = path
  if (path.startsWith('/var/run/')) {
    const run = await lstat('/var/run')
    if (run.isSymbolicLink()) {
      const parent = await lstat('/var')
      if (run.uid !== 0 || !parent.isDirectory() || parent.uid !== 0 || (parent.mode & 0o022) !== 0 ||
          posix.resolve('/var', await readlink('/var/run')) !== '/run') {
        fail('PRECONDITION_FAILED', 'the managed /var/run alias must be root-owned and resolve to /run')
      }
      normalized = `/run/${path.slice('/var/run/'.length)}`
    }
    // A physical /var/run directory is a different legitimate target. Walk it
    // unchanged rather than silently redirecting its contents to /run.
  }
  const components = dirname(normalized).split('/').filter(Boolean)
  const handles: FileHandle[] = []
  let operationFailed = false
  let primaryFailure: unknown
  try {
    let parent = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    handles.push(parent)
    for (const component of components) {
      parent = await open(`/proc/self/fd/${parent.fd}/${component}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      handles.push(parent)
    }
    return await operation(`/proc/self/fd/${parent.fd}/${basename(normalized)}`)
  } catch (error) {
    operationFailed = true
    primaryFailure = error
    throw error
  } finally {
    // Attempt every close even after an error; never fall back to a pathname.
    const closed = await Promise.allSettled(handles.reverse().map(handle => handle.close()))
    const failures = closed.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length > 0) {
      throw new AggregateError(operationFailed ? [primaryFailure, ...failures] : failures,
        'managed host target descriptors could not all be closed', operationFailed ? { cause: primaryFailure } : undefined)
    }
  }
}

/** Remove entries only relative to a retained directory, without pathname recursion. */
export async function removePinnedHostTree(path: string | Buffer, depth = 0): Promise<void> {
  if (process.platform !== 'linux') fail('PRECONDITION_FAILED', 'recursive managed removal requires native Linux directory descriptors')
  if (depth >= 128) fail('PRECONDITION_FAILED', 'managed removal exceeds the supported directory depth')
  let directory: FileHandle
  try {
    directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return
    if (code !== 'ENOTDIR' && code !== 'ELOOP') throw error
    // unlink never traverses the final entry, including symlinks and hard links.
    try { await unlink(path) }
    catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure }
    return
  }
  let operationFailed = false
  let primaryFailure: unknown
  try {
    const prefix = Buffer.from(`/proc/self/fd/${directory.fd}/`)
    for (const name of await readdir(`/proc/self/fd/${directory.fd}`, { encoding: 'buffer' })) {
      if (name.length === 0 || name.includes(0) || name.includes(0x2f) || name.equals(Buffer.from('.')) || name.equals(Buffer.from('..'))) {
        fail('PRECONDITION_FAILED', 'managed directory contains an invalid entry name')
      }
      await removePinnedHostTree(Buffer.concat([prefix, name]), depth + 1)
    }
  } catch (error) {
    operationFailed = true
    primaryFailure = error
    throw error
  } finally {
    try { await directory.close() }
    catch (error) {
      if (operationFailed) throw new AggregateError([primaryFailure, error], 'managed removal failed and its directory could not be closed', { cause: primaryFailure })
      throw error
    }
  }
  // The caller retains the parent. A replaced nonempty entry or symlink causes
  // an error here; do not recurse into a replacement or claim success.
  try { await rmdir(path) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}
