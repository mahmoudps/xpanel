import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, rename, rm, statfs, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { posix } from 'node:path'
import { backupDestinationTargetDigest } from '../../../packages/core/src/backup-destination.ts'
import type { BackupCredentialProfile, BackupDestinationTarget } from '../../../packages/core/src/backup-destination.ts'
import { BACKUP_CONTROL, BACKUP_RUN_LIMITS, parseBackupArchiveName } from './acct-backup-plan.ts'
import type { BackupRemoteArchive } from './acct-backup-plan.ts'
import type { BackupArchiveSource, BackupTransferProvider, BackupTransferSession } from './acct-backup-s3.ts'

/** The built-in credential of a separate local disk: nothing secret, so its revision is fixed. */
export const LOCAL_DISK_PROFILE: BackupCredentialProfile = { ref: 'local-disk', label: 'This server (separate disk)', kinds: ['local'], revision: createHash('sha256').update('xpanel-local-disk-v1').digest('hex') }
const PROBE_KEY = /^\.xpanel-probe\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SEGMENT = /^[A-Za-z0-9._-]{1,128}$/
/** System and panel trees a destination may never be inside. */
const FORBIDDEN = ['/proc', '/sys', '/dev', '/run', '/etc', '/home', '/root', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/var/lib/xpanel', '/var/lib/mysql', '/var/lib/powerdns', '/tmp']

/** The saved directory: absolute, segment-confined and outside system and panel trees. */
export function localDiskDirectory(target: BackupDestinationTarget): string {
  const bad = (): never => { throw new Error('unsupported_backup_destination') }
  if (target.kind !== 'local' || target.credentialRef !== LOCAL_DISK_PROFILE.ref) return bad()
  const segments = target.pathPrefix.split('/').filter(Boolean)
  if (!target.pathPrefix.startsWith('/') || !segments.length || segments.length > 16 || segments.some(part => part === '.' || part === '..' || !SEGMENT.test(part))) return bad()
  const directory = '/' + segments.join('/')
  return FORBIDDEN.some(tree => directory === tree || directory.startsWith(tree + '/')) ? bad() : directory
}

async function* fileChunks(handle: FileHandle, bytes: number): AsyncIterable<Uint8Array> {
  const buffer = Buffer.alloc(1024 * 1024)
  let remaining = bytes
  try {
    while (remaining > 0) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, remaining), null)
      if (bytesRead <= 0) throw new Error('archive_truncated')
      remaining -= bytesRead
      yield Buffer.from(buffer.subarray(0, bytesRead))
    }
  } finally { await handle.close() }
}

/**
 * Archives on a separate local disk (design: "Local directory, separate disk"). The directory must already exist, be a real
 * directory owned by root, and sit on another filesystem than the archive store, so one failed disk never takes both copies.
 * Writes go to a unique `.part` name and are renamed into place.
 */
export function createLocalDiskBackupProvider(deps: { readDestination(id: string): Promise<BackupDestinationTarget | null>; archiveRoot: string }): BackupTransferProvider {
  return {
    async profiles() { return [LOCAL_DISK_PROFILE] },
    async open(binding) {
      const target = await deps.readDestination(binding.destinationId)
      if (!target || backupDestinationTargetDigest(target) !== binding.targetDigest || target.credentialRef !== binding.credentialRef || binding.credentialRevision !== LOCAL_DISK_PROFILE.revision) throw new Error('backup_destination_binding_changed')
      const directory = localDiskDirectory(target)
      const info = await lstat(directory), store = await lstat(deps.archiveRoot)
      if (!info.isDirectory() || info.isSymbolicLink() || process.platform === 'linux' && info.uid !== 0 || info.dev === store.dev) throw new Error('local_destination_not_separate')
      const path = (name: string): string => posix.join(directory, ...name.split('/'))
      const archive = (name: string): string => { if (!parseBackupArchiveName(name)) throw new Error('invalid_remote_archive_name'); return name }
      const probe = (key: string): string => { if (!PROBE_KEY.test(key)) throw new Error('invalid_probe_key'); return key }
      const write = async (name: string, chunks: AsyncIterable<Uint8Array>): Promise<void> => {
        const final = path(name), part = final + '.part-' + randomUUID()
        await mkdir(posix.dirname(final), { recursive: true, mode: 0o700 })
        const handle = await open(part, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        try { for await (const chunk of chunks) await handle.write(chunk); await handle.sync() } catch (error) { await handle.close(); await rm(part, { force: true }); throw error }
        await handle.close()
        await rename(part, final)
      }
      const read = async (name: string, maxBytes: number): Promise<{ handle: FileHandle; bytes: number } | null> => {
        let handle: FileHandle
        try { handle = await open(path(name), constants.O_RDONLY | constants.O_NOFOLLOW) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
        const stat = await handle.stat()
        if (!stat.isFile() || stat.size > maxBytes) { await handle.close(); throw new Error('remote_response_limit') }
        return { handle, bytes: stat.size }
      }
      const session: BackupTransferSession = {
        binding: { ...binding, remote: true, confined: true, pinnedPeer: true, redirects: false },
        async writeProbe(key, bytes) { await write(probe(key), (async function* () { yield bytes })()) },
        async readProbe(key, maxBytes) { const found = await read(probe(key), maxBytes); if (!found) return null; const parts: Uint8Array[] = []; for await (const chunk of fileChunks(found.handle, found.bytes)) parts.push(chunk); return Buffer.concat(parts) },
        async deleteProbe(key) { await unlink(path(probe(key))) },
        async closeAndDrain() { /* no connection */ },
        async putArchive(name, source: BackupArchiveSource) { await write(archive(name), source.chunks()) },
        async readArchive(name, maxBytes) { const found = await read(archive(name), maxBytes); return found ? fileChunks(found.handle, found.bytes) : null },
        async deleteArchive(name) { await unlink(path(archive(name))) },
        async listArchives() {
          const found: BackupRemoteArchive[] = []
          for (const owner of await readdir(directory).catch(() => [] as string[])) {
            if (owner !== BACKUP_CONTROL && !/^[a-z][a-z0-9]{0,15}$/.test(owner)) continue
            for (const file of await readdir(posix.join(directory, owner)).catch(() => [] as string[])) {
              const name = owner + '/' + file, parsed = parseBackupArchiveName(name)
              if (!parsed) continue
              const stat = await lstat(path(name))
              if (stat.isFile()) found.push({ name, bytes: stat.size, lastModified: parsed.createdAt })
              if (found.length > BACKUP_RUN_LIMITS.listed) throw new Error('remote_listing_limit')
            }
          }
          return found
        },
        async space() { const info = await statfs(directory); return { freeBytes: Number(info.bavail) * Number(info.bsize), totalBytes: Number(info.blocks) * Number(info.bsize) } },
      }
      return session
    },
  }
}
