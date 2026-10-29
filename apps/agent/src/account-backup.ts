import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { link, lstat, open, readdir, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, posix } from 'node:path'
import { fail } from '@xpanel/core'
import type { AgentExecutor } from './executor.ts'
import { withPinnedHostTargetParent } from './host-target-parent.ts'

export const DEFAULT_BACKUP_DIR = '/var/lib/xpanel/backups'
export const MAX_BACKUP_BYTES = 2 * 1024 * 1024 * 1024
export const RESTORE_STAGING_DIR = '/run/xpanel/account-restores'

const USERNAME_RE = /^[a-z][a-z0-9]{0,15}$/
const STAMP_RE = /^[0-9]{8}T[0-9]{6}Z$/
const NONCE_RE = /^[a-f0-9]{12}$/

export interface BackupAccountTarget {
  username: string
  home: string
  uid: number
  status: string
}

export interface BackupArchive {
  file: string
  bytes: number
}

const stampOf = (date: Date): string => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')

export const assertBackupAccountTarget = (account: BackupAccountTarget): void => {
  if (!USERNAME_RE.test(account.username)) fail('VALIDATION', 'account username is invalid')
  if (account.home !== `/home/${account.username}`) fail('PRECONDITION_FAILED', 'the account home is not the expected directory')
  if (!Number.isInteger(account.uid) || account.uid < 20_000 || account.uid > 60_000) fail('PRECONDITION_FAILED', 'the account is not a panel-managed user')
  if (account.status === 'terminating') fail('PRECONDITION_FAILED', 'a terminating account cannot be backed up or restored')
}

export const backupFileName = (username: string, stamp: string, nonce?: string): string => {
  if (!USERNAME_RE.test(username) || !STAMP_RE.test(stamp) || nonce !== undefined && !NONCE_RE.test(nonce)) fail('VALIDATION', 'backup file name is invalid')
  return `xpanel-backup-${username}-${stamp}${nonce ? '-' + nonce : ''}.tar.gz`
}

export const assertBackupFileName = (username: string, file: string): string => {
  if (!USERNAME_RE.test(username)) fail('VALIDATION', 'account username is invalid')
  const expected = new RegExp(`^xpanel-backup-${username}-[0-9]{8}T[0-9]{6}Z(?:-[a-f0-9]{12})?\\.tar\\.gz$`)
  if (file !== posix.basename(file) || !expected.test(file)) fail('VALIDATION', 'backup file name is invalid')
  return file
}

const archivePath = (root: string, username: string, file: string): string => posix.join(root, username, assertBackupFileName(username, file))

/** Opens the exact regular archive through retained parent descriptors, never a symlink. */
export const openAccountBackupArchive = async (root: string, account: BackupAccountTarget, file: string): Promise<{ handle: FileHandle; bytes: number }> => {
  assertBackupAccountTarget(account)
  return withPinnedHostTargetParent(archivePath(root, account.username, file), async pinned => {
    const before = await lstat(pinned)
    if (!before.isFile() || before.isSymbolicLink()) fail('PRECONDITION_FAILED', 'the backup archive must be a regular file without links')
    const handle = await open(pinned, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.nlink !== 1 || info.dev !== before.dev || info.ino !== before.ino || !Number.isSafeInteger(info.size) || info.size <= 0) fail('PRECONDITION_FAILED', 'the backup archive must be a single regular file')
      if (info.size > MAX_BACKUP_BYTES) fail('LIMIT_EXCEEDED', 'the account backup is larger than 2 GiB')
      if (process.getuid && info.uid !== process.getuid()) fail('PRECONDITION_FAILED', 'the backup archive is not owned by the archive service')
      return { handle, bytes: info.size }
    } catch (error) { await handle.close(); throw error }
  })
}

const assertMembers = (listing: string): void => {
  for (const raw of listing.split('\n')) {
    const member = raw.trim()
    if (!member) continue
    if (member.startsWith('/') || member.split('/').includes('..') || member.includes('\\')) {
      fail('VALIDATION', 'the archive contains a path outside the account home')
    }
  }
}

export const listAccountBackups = async (root: string, account: BackupAccountTarget): Promise<BackupArchive[]> => {
  assertBackupAccountTarget(account)
  let names: string[] = []
  try {
    names = await withPinnedHostTargetParent(posix.join(root, account.username, '.archive-list'), pinned => readdir(dirname(pinned)))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const files: BackupArchive[] = []
  for (const name of names.sort()) {
    if (!new RegExp(`^xpanel-backup-${account.username}-[0-9]{8}T[0-9]{6}Z(?:-[a-f0-9]{12})?\\.tar\\.gz$`).test(name)) continue
    const info = await lstat(posix.join(root, account.username, name))
    if (!info.isFile()) continue
    files.push({ file: name, bytes: info.size })
  }
  return files
}

export const createAccountBackup = async (input: {
  executor: AgentExecutor
  root?: string
  account: BackupAccountTarget
  now?: Date
  nonce?: string
  /** Home-file restore preserves mailbox data and account mail settings separately. */
  excludeMail?: boolean
  readSize?: (path: string) => Promise<number>
}): Promise<BackupArchive> => {
  assertBackupAccountTarget(input.account)
  const root = input.root ?? DEFAULT_BACKUP_DIR
  const stamp = stampOf(input.now ?? new Date())
  const file = backupFileName(input.account.username, stamp, input.nonce)
  const directory = posix.join(root, input.account.username)
  const destination = archivePath(root, input.account.username, file)
  const staging = posix.join(input.account.home, `.xpanel-backup-${stamp}${input.nonce ? '-' + input.nonce : ''}.tar.gz`)
  await input.executor.runAction({ kind: 'ensure-dir', path: root, mode: 0o700, owner: 'root', group: 'root' })
  await input.executor.runAction({ kind: 'ensure-dir', path: directory, mode: 0o700, owner: 'root', group: 'root' })
  try {
    await input.executor.runAction({
      kind: 'exec',
      runAsUser: input.account.username,
      argv: ['/usr/bin/tar', '--create', '--gzip', `--file=${staging}`, `--directory=${input.account.home}`, `--exclude=${posix.basename(staging)}`, ...(input.excludeMail ? ['--exclude=./mail', '--exclude=./etc'] : []), '--', '.'],
    })
    const bytes = input.readSize
      ? await input.readSize(staging)
      : await storeRegularFile(staging, destination)
    if (!Number.isSafeInteger(bytes) || bytes <= 0) fail('PRECONDITION_FAILED', 'the backup archive size could not be read')
    if (bytes > MAX_BACKUP_BYTES) fail('LIMIT_EXCEEDED', 'the account backup is larger than 2 GiB')
    if (input.readSize) {
      await input.executor.runAction({ kind: 'exec', argv: ['/usr/bin/cp', '--', staging, destination] })
      await input.executor.runAction({ kind: 'exec', argv: ['/bin/chmod', '0600', '--', destination] })
    }
    return { file, bytes }
  } finally {
    await input.executor.runAction({ kind: 'remove-path', path: staging }).catch(() => undefined)
  }
}

export const restoreAccountBackup = async (input: {
  executor: AgentExecutor
  root?: string
  account: BackupAccountTarget
  file: string
  /** Owner home-only restore preserves mailbox data and mail settings. */
  preserveMail?: boolean
  /** Trusted fixture port; the dispatcher never accepts this from a request body. */
  inspectSource?: (path: string) => Promise<void>
}): Promise<{ file: string }> => {
  assertBackupAccountTarget(input.account)
  const root = input.root ?? DEFAULT_BACKUP_DIR
  const file = assertBackupFileName(input.account.username, input.file)
  const source = archivePath(root, input.account.username, file)
  const listed = await input.executor.runCommand(['/usr/bin/tar', '--list', '--gzip', `--file=${source}`])
  if (!listed.ok) fail('PRECONDITION_FAILED', 'the backup archive could not be read')
  assertMembers(listed.stdout)
  if (input.inspectSource) await input.inspectSource(source)
  else { const opened = await openAccountBackupArchive(root, input.account, file); await opened.handle.close() }
  const directory = posix.join(RESTORE_STAGING_DIR, input.account.username)
  const staging = posix.join(directory, `${randomUUID()}.tar.gz`)
  await input.executor.runAction({ kind: 'ensure-dir', path: RESTORE_STAGING_DIR, mode: 0o711, owner: 'root', group: 'root' })
  await input.executor.runAction({ kind: 'ensure-dir', path: directory, mode: 0o710, owner: 'root', group: input.account.username })
  try {
    await input.executor.runAction({ kind: 'exec', argv: ['/usr/bin/cp', '--', source, staging] })
    await input.executor.runAction({ kind: 'exec', argv: ['/bin/chown', `root:${input.account.username}`, '--', staging] })
    await input.executor.runAction({ kind: 'exec', argv: ['/bin/chmod', '0640', '--', staging] })
    await input.executor.runAction({
      kind: 'exec',
      runAsUser: input.account.username,
      argv: ['/usr/bin/tar', '--extract', '--gzip', `--file=${staging}`, `--directory=${input.account.home}`, '--no-overwrite-dir', '--no-same-owner', '--anchored', '--exclude=./.xpanel-backup-data', '--exclude=.xpanel-backup-data', ...(input.preserveMail ? ['--anchored', '--exclude=./mail', '--exclude=./etc', '--exclude=mail', '--exclude=etc'] : []), '--'],
    })
  } finally {
    await input.executor.runAction({ kind: 'remove-path', path: staging }).catch(() => undefined)
  }
  return { file }
}

const writeAll = async (handle: FileHandle, chunk: Buffer): Promise<void> => {
  let offset = 0
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk.subarray(offset))
    if (bytesWritten <= 0) fail('PRECONDITION_FAILED', 'the backup archive could not be stored')
    offset += bytesWritten
  }
}

/** Copies the regular file that tar wrote. A symlink is not followed and is not stored. */
const storeRegularFile = async (source: string, destination: string): Promise<number> => {
  let input: FileHandle
  try {
    input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    return fail('PRECONDITION_FAILED', 'the backup archive size could not be read')
  }
  let output: FileHandle | undefined
  let temporary: string | undefined
  let published = false
  try {
    const info = await input.stat()
    if (!info.isFile() || info.size < 0 || !Number.isSafeInteger(info.size)) fail('PRECONDITION_FAILED', 'the backup archive size could not be read')
    if (info.size > MAX_BACKUP_BYTES) fail('LIMIT_EXCEEDED', 'the account backup is larger than 2 GiB')
    await withPinnedHostTargetParent(destination, async pinned => {
      temporary = posix.join(dirname(pinned), '.backup-stage-' + randomUUID())
      try {
      output = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      const buffer = Buffer.alloc(1024 * 1024)
      let remaining = info.size
      while (remaining > 0) {
        const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, remaining), null)
        if (bytesRead <= 0) fail('PRECONDITION_FAILED', 'the backup archive could not be stored')
        await writeAll(output, buffer.subarray(0, bytesRead))
        remaining -= bytesRead
      }
      const after = await input.stat()
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) fail('CONFLICT', 'the backup source changed while it was stored', { stateChanged: false })
      await output.sync(); await output.close(); output = undefined
      // link is exclusive: an existing archive is never overwritten. Only complete bytes publish.
      await link(temporary, pinned); published = true
      await unlink(temporary); temporary = undefined
      if (process.platform === 'linux') {
        const parent = await open(dirname(pinned), constants.O_RDONLY | constants.O_DIRECTORY)
        try { await parent.sync() } finally { await parent.close() }
      }
      } finally {
        if (output) { await output.close(); output = undefined }
        if (temporary) { await unlink(temporary); temporary = undefined }
      }
    })
    return info.size
  } catch (error) {
    if (published) return fail('PRECONDITION_FAILED', 'archive publication requires inspection', { stateChanged: true, verificationRequired: true })
    throw error
  } finally {
    await output?.close()
    await input.close()
  }
}
