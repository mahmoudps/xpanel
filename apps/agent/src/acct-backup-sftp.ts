import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, rm, writeFile } from 'node:fs/promises'
import { posix } from 'node:path'
import { backupDestinationTargetDigest } from '../../../packages/core/src/backup-destination.ts'
import type { BackupCredentialProfile, BackupDestinationTarget } from '../../../packages/core/src/backup-destination.ts'
import { BACKUP_CONTROL, BACKUP_RUN_LIMITS, parseBackupArchiveName } from './acct-backup-plan.ts'
import { createLocalDiskBackupProvider } from './acct-backup-local.ts'
import type { BackupRemoteArchive } from './acct-backup-plan.ts'
import { createS3BackupProvider, readBackupCredentialFile } from './acct-backup-s3.ts'
import type { BackupArchiveSource, BackupTransferProvider, BackupTransferSession, StoredCredential } from './acct-backup-s3.ts'
import { runBackupCommand } from './backup-low-priority.ts'
import type { BackupCommandRunner } from './backup-low-priority.ts'

/** Pinned SFTP host keys, one known_hosts file per destination target digest: a changed endpoint starts a new pin. */
export const BACKUP_KNOWN_HOSTS_DIR = '/var/lib/xpanel/backup-known-hosts'
/** Root-only scratch space for probe files and downloaded copies being re-read. */
export const BACKUP_TRANSFER_DIR = '/var/lib/xpanel/backup-transfer'
const PROBE_KEY = /^\.xpanel-probe\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SEGMENT = /^[A-Za-z0-9._-]{1,128}$/
const USER = /^[a-z_][a-z0-9_.-]{0,31}$/
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\[[0-9a-fA-F:.]{2,45}\])$/
const MISSING = /not found|No such file/i

/** Saved fields the session connects to: host, port, login and an absolute, segment-confined remote directory. */
export function sftpDestinationBinding(target: BackupDestinationTarget): { host: string; port: number; user: string; prefix: string } {
  const bad = (): never => { throw new Error('unsupported_backup_destination') }
  if (target.kind !== 'sftp' || !target.username || !USER.test(target.username)) return bad()
  let url: URL
  try { url = new URL(target.endpoint) } catch { return bad() }
  if (url.protocol !== 'sftp:' || url.username || url.password || url.search || url.hash || !(url.pathname === '' || url.pathname === '/') || !HOST.test(url.hostname)) return bad()
  const port = url.port ? Number(url.port) : 22
  const segments = target.pathPrefix.split('/').filter(Boolean)
  if (!target.pathPrefix.startsWith('/') || !segments.length || segments.length > 16 || segments.some(part => part === '.' || part === '..' || !SEGMENT.test(part)) || !Number.isSafeInteger(port) || port < 1 || port > 65535) return bad()
  return { host: url.hostname, port, user: target.username, prefix: '/' + segments.join('/') }
}

/** ssh_config(5) options: key only, no agent or forwarding, host key accepted once and then pinned for this target. */
export function sftpArgv(input: { host: string; port: number; user: string; keyPath: string; knownHosts: string }): string[] {
  const options = ['BatchMode=yes', 'IdentitiesOnly=yes', `IdentityFile=${input.keyPath}`, 'StrictHostKeyChecking=accept-new', `UserKnownHostsFile=${input.knownHosts}`, 'GlobalKnownHostsFile=/dev/null',
    'PasswordAuthentication=no', 'KbdInteractiveAuthentication=no', 'ForwardAgent=no', 'ClearAllForwardings=yes', 'UpdateHostKeys=no', 'ConnectTimeout=10', 'ServerAliveInterval=15', 'ServerAliveCountMax=4']
  return ['/usr/bin/sftp', '-F', '/dev/null', '-b', '-', ...options.flatMap(option => ['-o', option]), '-P', String(input.port), '--', `${input.user}@${input.host}`]
}

/** mkdir for each missing level; a leading `-` lets sftp(1) batch mode continue when the directory exists. */
export const sftpMkdirs = (directory: string): string[] => directory.split('/').filter(Boolean).map((_, index, parts) => `-mkdir "/${parts.slice(0, index + 1).join('/')}"`)

/** `ls -1` of the prefix: account directory names only; batch echo lines (`sftp> ...`) are ignored. */
export function readSftpNames(stdout: string): string[] {
  return stdout.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('sftp>')).map(line => posix.basename(line)).filter(name => name === BACKUP_CONTROL || /^[a-z][a-z0-9]{0,15}$/.test(name))
}
/**
 * One batch of `-ls -ln "<prefix>/<user>"` sections: regular files named like that account's archives, with their sizes.
 * A name printed with a path belongs to its parent directory; a bare name to the section of the echoed command before it.
 */
export function readSftpArchives(stdout: string): BackupRemoteArchive[] {
  const found: BackupRemoteArchive[] = []
  let section: string | null = null
  for (const raw of stdout.split('\n')) {
    const line = raw.trim(), echo = /^sftp> -?ls -ln "([^"]+)"$/.exec(line)
    if (echo) { section = posix.basename(echo[1]!); continue }
    const fields = line.split(/\s+/)
    if (fields.length < 9 || !fields[0]!.startsWith('-') || !/^\d{1,16}$/.test(fields[4]!)) continue
    const path = fields[fields.length - 1]!, username = path.includes('/') ? posix.basename(posix.dirname(path)) : section
    const name = username + '/' + posix.basename(path), parsed = parseBackupArchiveName(name)
    if (parsed) found.push({ name, bytes: Number(fields[4]), lastModified: parsed.createdAt })
  }
  return found
}

/** `df` of the remote path (statvfs@openssh.com): 1 KiB blocks Size, Used, Avail; null when the server cannot tell. */
export function readSftpSpace(stdout: string): { freeBytes: number; totalBytes: number } | null {
  for (const line of stdout.split('\n').reverse()) {
    const fields = line.trim().split(/\s+/)
    if (fields.length >= 3 && fields.slice(0, 3).every(field => /^\d{1,15}$/.test(field))) {
      const [size, , avail] = fields.map(Number) as [number, number, number]
      return avail <= size ? { freeBytes: avail * 1024, totalBytes: size * 1024 } : null
    }
  }
  return null
}
const scratchIn = async (directory: string): Promise<string> => {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || process.platform === 'linux' && (info.mode & 0o077) !== 0) throw new Error('unsafe_backup_transfer_dir')
  return posix.join(directory, randomUUID())
}
async function* fileChunks(path: string, onDone: () => Promise<void>): AsyncIterable<Uint8Array> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024 })) yield chunk as Uint8Array }
  finally { await handle.close(); await onDone() }
}

/**
 * SFTP transport through OpenSSH sftp(1) batch mode at low priority. Every remote path is the saved prefix plus an account
 * archive or probe name; uploads go to a unique `.part` name and are renamed into place, so a partial file never carries the archive name.
 */
export function createSftpBackupProvider(deps: { readDestination(id: string): Promise<BackupDestinationTarget | null>; readCredentials?: () => Promise<StoredCredential[]>; run?: BackupCommandRunner; knownHostsDir?: string; transferDir?: string }): BackupTransferProvider {
  const readCredentials = deps.readCredentials ?? (() => readBackupCredentialFile()), run = deps.run ?? runBackupCommand, knownHostsDir = deps.knownHostsDir ?? BACKUP_KNOWN_HOSTS_DIR
  const scratch = (): Promise<string> => scratchIn(deps.transferDir ?? BACKUP_TRANSFER_DIR)
  return {
    async profiles() { return (await readCredentials()).map(item => item.profile).filter(profile => profile.kinds.includes('sftp')) },
    async open(binding) {
      const target = await deps.readDestination(binding.destinationId)
      const credential = (await readCredentials()).find(item => item.profile.ref === binding.credentialRef)
      if (!target || backupDestinationTargetDigest(target) !== binding.targetDigest || target.credentialRef !== binding.credentialRef || !credential || !('privateKeyPath' in credential) || credential.profile.revision !== binding.credentialRevision
        || !credential.profile.kinds.includes(target.kind as BackupCredentialProfile['kinds'][number])) throw new Error('backup_destination_binding_changed')
      const site = sftpDestinationBinding(target)
      await mkdir(knownHostsDir, { recursive: true, mode: 0o700 })
      const argv = sftpArgv({ ...site, keyPath: credential.privateKeyPath, knownHosts: posix.join(knownHostsDir, binding.targetDigest) })
      const batch = async (commands: readonly string[], signal: AbortSignal): Promise<{ ok: boolean; stdout: string; stderr: string }> =>
        run({ argv, stdinText: commands.join('\n') + '\n', maxStdoutBytes: 8 * 1024 * 1024, signal, timeoutMs: 6 * 60 * 60_000 })
      const must = async (commands: readonly string[], signal: AbortSignal): Promise<string> => {
        const result = await batch(commands, signal)
        if (!result.ok) throw new Error('remote_sftp_failed')
        return result.stdout
      }
      const remote = (name: string): string => site.prefix + '/' + name
      const archive = (name: string): string => { if (!parseBackupArchiveName(name)) throw new Error('invalid_remote_archive_name'); return name }
      const probe = (key: string): string => { if (!PROBE_KEY.test(key)) throw new Error('invalid_probe_key'); return key }
      const upload = async (local: string, name: string, signal: AbortSignal): Promise<void> => {
        const part = remote(name) + '.part-' + randomUUID()
        await must([...sftpMkdirs(posix.dirname(remote(name))), `put "${local}" "${part}"`, `rename "${part}" "${remote(name)}"`], signal)
          .catch(async error => { await batch([`-rm "${part}"`], AbortSignal.timeout(30_000)).catch(() => undefined); throw error })
      }
      /** Downloads to scratch; null when the remote file does not exist. */
      const download = async (name: string, maxBytes: number, signal: AbortSignal): Promise<string | null> => {
        const local = await scratch()
        const result = await batch([`get "${remote(name)}" "${local}"`], signal)
        if (!result.ok) { await rm(local, { force: true }); if (MISSING.test(result.stderr)) return null; throw new Error('remote_sftp_failed') }
        const info = await lstat(local)
        if (!info.isFile() || info.size > maxBytes) { await rm(local, { force: true }); throw new Error('remote_response_limit') }
        return local
      }
      const session: BackupTransferSession = {
        binding: { ...binding, remote: true, confined: true, pinnedPeer: true, redirects: false },
        async writeProbe(key, bytes, signal) {
          const local = await scratch()
          try { await writeFile(local, bytes, { mode: 0o600, flag: 'wx' }); await upload(local, probe(key), signal) } finally { await rm(local, { force: true }) }
        },
        async readProbe(key, maxBytes, signal) {
          const local = await download(probe(key), maxBytes, signal)
          if (!local) return null
          try { const handle = await open(local, constants.O_RDONLY | constants.O_NOFOLLOW); try { return new Uint8Array(await handle.readFile()) } finally { await handle.close() } } finally { await rm(local, { force: true }) }
        },
        async deleteProbe(key, signal) { await must([`rm "${remote(probe(key))}"`], signal) },
        async closeAndDrain() { /* each operation is its own sftp(1) process, already exited */ },
        async putArchive(name, source: BackupArchiveSource, signal) {
          if (source.path) return upload(source.path, archive(name), signal)
          const local = await scratch(), handle = await open(local, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
          try { for await (const chunk of source.chunks()) await handle.write(chunk); await handle.close(); await upload(local, archive(name), signal) }
          finally { await handle.close().catch(() => undefined); await rm(local, { force: true }) }
        },
        async readArchive(name, maxBytes, signal) {
          const local = await download(archive(name), maxBytes, signal)
          return local ? fileChunks(local, () => rm(local, { force: true })) : null
        },
        async deleteArchive(name, signal) { await must([`rm "${remote(archive(name))}"`], signal) },
        async space(signal) { const result = await batch([`df "${site.prefix}"`], signal); return result.ok ? readSftpSpace(result.stdout) : null },
        async listArchives(signal) {
          const top = await batch([`ls -1 "${site.prefix}"`], signal)
          if (!top.ok) { if (MISSING.test(top.stderr)) return []; throw new Error('remote_sftp_failed') }
          const users = readSftpNames(top.stdout)
          if (!users.length) return []
          const found = readSftpArchives(await must(users.map(username => `-ls -ln "${site.prefix}/${username}"`), signal))
          if (found.length > BACKUP_RUN_LIMITS.listed) throw new Error('remote_listing_limit')
          return found
        },
      }
      return session
    },
  }
}

/** One provider for every saved transport kind: credentials are read once per call, sessions open by the saved destination kind. */
export function createBackupTransportProvider(deps: { readDestination(id: string): Promise<BackupDestinationTarget | null>; readCredentials?: () => Promise<StoredCredential[]>; archiveRoot: string; s3?: BackupTransferProvider; sftp?: BackupTransferProvider; local?: BackupTransferProvider }): BackupTransferProvider {
  const readCredentials = deps.readCredentials ?? (() => readBackupCredentialFile())
  const s3 = deps.s3 ?? createS3BackupProvider({ readDestination: deps.readDestination, readCredentials })
  const sftp = deps.sftp ?? createSftpBackupProvider({ readDestination: deps.readDestination, readCredentials })
  const local = deps.local ?? createLocalDiskBackupProvider({ readDestination: deps.readDestination, archiveRoot: deps.archiveRoot })
  return {
    async profiles(signal) { return [...await local.profiles(signal), ...(await readCredentials()).map(item => item.profile)] },
    async open(binding, signal) {
      const target = await deps.readDestination(binding.destinationId)
      if (!target) throw new Error('backup_destination_binding_changed')
      return (target.kind === 'sftp' ? sftp : target.kind === 'local' ? local : s3).open(binding, signal)
    },
  }
}
