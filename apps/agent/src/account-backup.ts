import { constants } from 'node:fs'
import { lstat, open, readdir, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { posix } from 'node:path'
import { fail } from '@xpanel/core'
import type { AgentExecutor } from './executor.ts'

export const DEFAULT_BACKUP_DIR = '/var/lib/xpanel/backups'
export const MAX_BACKUP_BYTES = 2 * 1024 * 1024 * 1024

const USERNAME_RE = /^[a-z][a-z0-9]{0,15}$/
const STAMP_RE = /^[0-9]{8}T[0-9]{6}Z$/

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

const assertTarget = (account: BackupAccountTarget): void => {
  if (!USERNAME_RE.test(account.username)) fail('VALIDATION', 'account username is invalid')
  if (account.home !== `/home/${account.username}`) fail('PRECONDITION_FAILED', 'the account home is not the expected directory')
  if (!Number.isInteger(account.uid) || account.uid < 20_000 || account.uid > 60_000) fail('PRECONDITION_FAILED', 'the account is not a panel-managed user')
  if (account.status === 'terminating') fail('PRECONDITION_FAILED', 'a terminating account cannot be backed up or restored')
}

export const backupFileName = (username: string, stamp: string): string => {
  if (!USERNAME_RE.test(username) || !STAMP_RE.test(stamp)) fail('VALIDATION', 'backup file name is invalid')
  return `xpanel-backup-${username}-${stamp}.tar.gz`
}

export const assertBackupFileName = (username: string, file: string): string => {
  const expected = new RegExp(`^xpanel-backup-${username}-[0-9]{8}T[0-9]{6}Z\\.tar\\.gz$`)
  if (file !== posix.basename(file) || !expected.test(file)) fail('VALIDATION', 'backup file name is invalid')
  return file
}

const archivePath = (root: string, username: string, file: string): string => posix.join(root, username, assertBackupFileName(username, file))

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
  assertTarget(account)
  let names: string[] = []
  try {
    names = await readdir(posix.join(root, account.username))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const files: BackupArchive[] = []
  for (const name of names.sort()) {
    if (!new RegExp(`^xpanel-backup-${account.username}-[0-9]{8}T[0-9]{6}Z\\.tar\\.gz$`).test(name)) continue
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
  readSize?: (path: string) => Promise<number>
}): Promise<BackupArchive> => {
  assertTarget(input.account)
  const root = input.root ?? DEFAULT_BACKUP_DIR
  const stamp = stampOf(input.now ?? new Date())
  const file = backupFileName(input.account.username, stamp)
  const directory = posix.join(root, input.account.username)
  const destination = archivePath(root, input.account.username, file)
  const staging = posix.join(input.account.home, `.xpanel-backup-${stamp}.tar.gz`)
  await input.executor.runAction({ kind: 'ensure-dir', path: root, mode: 0o700, owner: 'root', group: 'root' })
  await input.executor.runAction({ kind: 'ensure-dir', path: directory, mode: 0o700, owner: 'root', group: 'root' })
  try {
    await input.executor.runAction({
      kind: 'exec',
      runAsUser: input.account.username,
      argv: ['/usr/bin/tar', '--create', '--gzip', `--file=${staging}`, `--directory=${input.account.home}`, `--exclude=.xpanel-backup-${stamp}.tar.gz`, '--', '.'],
    })
    const bytes = input.readSize
      ? await input.readSize(staging)
      : await storeRegularFile(staging, destination)
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
}): Promise<{ file: string }> => {
  assertTarget(input.account)
  const root = input.root ?? DEFAULT_BACKUP_DIR
  const file = assertBackupFileName(input.account.username, input.file)
  const source = archivePath(root, input.account.username, file)
  const listed = await input.executor.runCommand(['/usr/bin/tar', '--list', '--gzip', `--file=${source}`])
  if (!listed.ok) fail('PRECONDITION_FAILED', 'the backup archive could not be read')
  assertMembers(listed.stdout)
  const staging = posix.join(input.account.home, `.xpanel-restore-${file}`)
  try {
    await input.executor.runAction({ kind: 'exec', argv: ['/usr/bin/cp', '--', source, staging] })
    await input.executor.runAction({ kind: 'exec', argv: ['/bin/chown', `${input.account.username}:${input.account.username}`, '--', staging] })
    await input.executor.runAction({ kind: 'exec', argv: ['/bin/chmod', '0600', '--', staging] })
    await input.executor.runAction({
      kind: 'exec',
      runAsUser: input.account.username,
      argv: ['/usr/bin/tar', '--extract', '--gzip', `--file=${staging}`, `--directory=${input.account.home}`, '--no-overwrite-dir', '--'],
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
  try {
    const info = await input.stat()
    if (!info.isFile() || info.size < 0 || !Number.isSafeInteger(info.size)) fail('PRECONDITION_FAILED', 'the backup archive size could not be read')
    if (info.size > MAX_BACKUP_BYTES) fail('LIMIT_EXCEEDED', 'the account backup is larger than 2 GiB')
    output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    const buffer = Buffer.alloc(1024 * 1024)
    let remaining = info.size
    while (remaining > 0) {
      const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, remaining), null)
      if (bytesRead <= 0) fail('PRECONDITION_FAILED', 'the backup archive could not be stored')
      await writeAll(output, buffer.subarray(0, bytesRead))
      remaining -= bytesRead
    }
    return info.size
  } catch (error) {
    if (output) await rm(destination, { force: true }).catch(() => undefined)
    throw error
  } finally {
    await output?.close()
    await input.close()
  }
}
