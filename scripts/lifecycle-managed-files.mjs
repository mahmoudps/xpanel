import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readlink, rename, symlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { assertOwnedFile, withTrustedDirectory, readTrustedFile, requireLinuxRoot } from './lifecycle-ownership.mjs'

// Internal root-owned file primitives, not an authorization API. Every effect caller
// must hold its own native host/admission authority and exact finite path policy.
const fail = code => { throw Object.assign(new Error(code), { code }) }
export const managedBytesHash = bytes => createHash('sha256').update(bytes).digest('hex')
export async function syncManagedDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}
export async function captureManagedFile(path, maxBytes = 1024 * 1024) {
  requireLinuxRoot()
  return withTrustedDirectory(dirname(path), async parent => {
    const named = await lstat(path, { bigint: true })
    if (named.uid !== 0n || named.gid !== 0n) fail('MANAGED_FILE_OWNERSHIP_CHANGED')
    let bytes = null, target = null, hash = null
    if (named.isSymbolicLink()) target = await readlink(path)
    else {
      const held = await readTrustedFile(path, { maxBytes })
      if (held.info.dev !== named.dev || held.info.ino !== named.ino) fail('MANAGED_FILE_CHANGED')
      bytes = held.bytes; hash = held.sha256
    }
    const entry = Object.freeze({ path, kind: target === null ? 'file' : 'symlink', device: String(named.dev), inode: String(named.ino), size: Number(named.size), mode: Number(named.mode & 0o7777n), sha256: hash, target })
    await assertOwnedFile(entry); await parent.verify()
    return Object.freeze({ entry, bytes })
  })
}
export async function managedPathAbsent(path) {
  try { await lstat(path); return false } catch (error) { if (error.code !== 'ENOENT') throw error; return true }
}

/** Existing directories are verified, never repaired. Newly created directories receive exact metadata. */
export async function ensureManagedPrivateDirectory(path, assertAuthority) {
  requireLinuxRoot(); await assertAuthority()
  return withTrustedDirectory(dirname(path), async parent => {
    let created = false
    try { await mkdir(path, { mode: 0o700 }); created = true }
    catch (error) { if (error.code !== 'EEXIST') throw error }
    const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      if (created) { await directory.chown(0, 0); await directory.chmod(0o700) }
      const [opened, named] = await Promise.all([directory.stat({ bigint: true }), lstat(path, { bigint: true })])
      if (!opened.isDirectory() || !named.isDirectory() || named.isSymbolicLink() || opened.uid !== 0n || opened.gid !== 0n || (opened.mode & 0o7777n) !== 0o700n
        || opened.dev !== named.dev || opened.ino !== named.ino || opened.mode !== named.mode || opened.uid !== named.uid || opened.gid !== named.gid) fail('MANAGED_DIRECTORY_UNTRUSTED')
      await directory.sync(); await syncManagedDirectory(dirname(path)); await parent.verify(); await assertAuthority()
      return Object.freeze({ path, device: String(opened.dev), inode: String(opened.ino), created })
    } finally { await directory.close() }
  })
}

/** No implicit overwrite: expected is the last captured inode or explicit absence. */
export async function replaceManagedFile(path, bytes, mode, expected, assertAuthority) {
  requireLinuxRoot()
  if (!Buffer.isBuffer(bytes) || ![0o600, 0o644, 0o755].includes(mode) || typeof assertAuthority !== 'function') fail('MANAGED_WRITE_INVALID')
  await assertAuthority()
  return withTrustedDirectory(dirname(path), async parent => {
    const temporary = path + '.lifecycle-' + randomUUID() + '.tmp'
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
    let identity
    try {
      await handle.chown(0, 0); await handle.chmod(mode); await handle.writeFile(bytes); await handle.sync()
      identity = await handle.stat({ bigint: true })
    } finally { await handle.close() }
    // Keep an uncertain temporary for explicit recovery; never remove an unverified name.
    await assertAuthority(); await parent.verify()
    if (expected === null) { if (!await managedPathAbsent(path)) fail('MANAGED_PATH_EXISTS') }
    else { if (expected.path !== path || expected.kind !== 'file') fail('MANAGED_PREIMAGE_INVALID'); await assertOwnedFile(expected) }
    await rename(temporary, path); await syncManagedDirectory(dirname(path))
    const actual = await captureManagedFile(path, bytes.length)
    if (actual.entry.device !== String(identity.dev) || actual.entry.inode !== String(identity.ino)
      || actual.entry.sha256 !== managedBytesHash(bytes) || actual.entry.mode !== mode) fail('MANAGED_WRITE_READBACK_FAILED')
    // The path now names the read-back replacement; an authority that pins this file must check that identity.
    await parent.verify(); await assertAuthority(actual)
    return actual
  })
}

export async function replaceManagedLink(path, target, expected, assertAuthority) {
  requireLinuxRoot(); await assertAuthority()
  return withTrustedDirectory(dirname(path), async parent => {
    const temporary = path + '.lifecycle-' + randomUUID() + '.tmp'
    await symlink(target, temporary)
    const created = await lstat(temporary, { bigint: true })
    await assertAuthority(); await parent.verify()
    if (expected === null) { if (!await managedPathAbsent(path)) fail('MANAGED_PATH_EXISTS') }
    else { if (expected.path !== path || expected.kind !== 'symlink') fail('MANAGED_PREIMAGE_INVALID'); await assertOwnedFile(expected) }
    await rename(temporary, path); await syncManagedDirectory(dirname(path))
    const actual = await captureManagedFile(path)
    if (actual.entry.device !== String(created.dev) || actual.entry.inode !== String(created.ino) || actual.entry.target !== target) fail('MANAGED_LINK_READBACK_FAILED')
    await parent.verify(); await assertAuthority(); return actual
  })
}
