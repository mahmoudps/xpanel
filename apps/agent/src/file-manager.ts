import { isAbsolute } from 'node:path'
import { fail, validateHome, validateUsername } from '@xpanel/core'
import type { Account, Limit } from '@xpanel/core'

/** Browser text/code editor maximum UTF-8 payload: 1 MiB. */
export const MAX_EDIT_BYTES = 1024 * 1024
export const MAX_FILE_MODE = 0o640
export const MAX_DIR_MODE = 0o750
export const MAX_FILE_LIST_ENTRIES = 10_000

type FileAccount = Pick<Account, 'username' | 'uid' | 'gid' | 'home'>

export interface FileEntry {
  name: string
  path: string
  kind: 'file' | 'directory' | 'symlink'
  sizeBytes: number
  mode: number
  mtime: string
}

export interface TrashItem {
  id: string
  originalPath: string
  name: string
  sizeBytes: number
  deletedAt: string
}

export interface FileText {
  path: string
  content: string
  sizeBytes: number
  mtime: string
}

export interface AccountFileContext {
  account: Readonly<FileAccount>
  homeRoot: string
  diskQuotaMb: Limit
  maxEditBytes: number
  maxFileMode: number
  maxDirMode: number
  maxListEntries: number
}

export type AccountFileRequest =
  | { op: 'list'; path: string; showHidden: boolean }
  | { op: 'read'; path: string }
  | { op: 'write'; path: string; content: string; overwrite: boolean; mode: number }
  | { op: 'mkdir'; path: string; mode: number }
  | { op: 'chmod'; path: string; mode: number }
  | { op: 'trash'; path: string }
  | { op: 'list-trash' }
  | { op: 'restore'; trashId: string; overwrite: boolean }
  | { op: 'empty-trash'; olderThanDays?: number }

/**
 * Runs the entire operation after enforcing tenant identity, descriptor-based
 * path confinement and applicable kernel quotas. Recording or simulating an
 * isolated command does not implement this execution contract.
 */
export interface AccountFileRunner {
  run(context: Readonly<AccountFileContext>, request: Readonly<AccountFileRequest>): Promise<unknown>
}

export interface JailedFileManagerOptions {
  account: FileAccount
  runner?: AccountFileRunner
}

const TRASH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_RETENTION_DAYS = 36_500

export const assertSafeFileMode = (mode: number): number => {
  if (!Number.isSafeInteger(mode) || mode <= 0 || mode > MAX_FILE_MODE || (mode & ~MAX_FILE_MODE) !== 0) {
    fail('VALIDATION', 'regular file mode must not exceed 0640')
  }
  return mode
}

export const assertSafeDirMode = (mode: number): number => {
  if (!Number.isSafeInteger(mode) || mode <= 0 || mode > MAX_DIR_MODE || (mode & ~MAX_DIR_MODE) !== 0) {
    fail('VALIDATION', 'directory mode must not exceed 0750')
  }
  return mode
}

const relativePath = (value: string): string => {
  if (typeof value !== 'string' || !value.isWellFormed() || Buffer.byteLength(value, 'utf8') > 4096) {
    fail('VALIDATION', 'invalid account-relative path')
  }
  if (value === '') fail('VALIDATION', 'path is required')
  if (/[\u0000-\u001f\u007f\\]/.test(value) || value.startsWith('/') || /^[a-z]:/i.test(value)) {
    fail('FORBIDDEN', 'path must be relative to the account home')
  }
  if (value.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    fail('FORBIDDEN', 'path traversal outside the account home is forbidden')
  }
  return value
}

const contentPath = (value: string): string => {
  const path = relativePath(value)
  if (path === '.trash' || path.startsWith('.trash/')) {
    fail('FORBIDDEN', 'trash contents are accessible only through trash operations')
  }
  return path
}

const trashId = (value: string): string => {
  if (typeof value !== 'string' || !TRASH_ID.test(value)) fail('VALIDATION', 'invalid trash item identifier')
  return value
}

const booleanOption = (value: boolean | undefined, defaultValue: boolean): boolean => {
  if (value !== undefined && typeof value !== 'boolean') fail('VALIDATION', 'option must be a boolean')
  return value ?? defaultValue
}

const invalidResult = (op: AccountFileRequest['op']): never =>
  fail('CONFIG_TEST_FAILED', 'confined file runner returned an invalid result', { operation: op })

const resultRecord = (value: unknown, keys: readonly string[], op: AccountFileRequest['op']): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidResult(op)
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(record, key))) {
    return invalidResult(op)
  }
  return record
}

const validByteCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const validTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return false
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return false
  const normalized = value.includes('.')
    ? value.replace(/\.(\d{1,3})Z$/, (_, digits: string) => `.${digits.padEnd(3, '0')}Z`)
    : value.replace(/Z$/, '.000Z')
  return date.toISOString() === normalized
}

const resultPath = (value: unknown, op: AccountFileRequest['op']): string => {
  if (typeof value !== 'string') return invalidResult(op)
  try {
    return contentPath(value)
  } catch {
    return invalidResult(op)
  }
}

const fileEntry = (value: unknown, op: AccountFileRequest['op'], expectedPath?: string): FileEntry => {
  const entry = resultRecord(value, ['name', 'path', 'kind', 'sizeBytes', 'mode', 'mtime'], op)
  const path = resultPath(entry.path, op)
  if (entry.name !== path.split('/').at(-1) || (expectedPath !== undefined && path !== expectedPath) ||
      (entry.kind !== 'file' && entry.kind !== 'directory' && entry.kind !== 'symlink') || !validByteCount(entry.sizeBytes) ||
      typeof entry.mode !== 'number' || !Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o7777 ||
      !validTimestamp(entry.mtime)) return invalidResult(op)
  return {
    name: entry.name as string, path, kind: entry.kind as FileEntry['kind'],
    sizeBytes: entry.sizeBytes, mode: entry.mode, mtime: entry.mtime,
  }
}

const changedEntry = (value: unknown, op: AccountFileRequest['op'], expectedPath?: string): FileEntry => {
  const entry = fileEntry(value, op, expectedPath)
  if (entry.kind === 'symlink') return invalidResult(op)
  const ceiling = entry.kind === 'directory' ? MAX_DIR_MODE : MAX_FILE_MODE
  if (entry.mode <= 0 || (entry.mode & ~ceiling) !== 0) return invalidResult(op)
  return entry
}

const trashItem = (value: unknown, op: AccountFileRequest['op'], expectedPath?: string): TrashItem => {
  const item = resultRecord(value, ['id', 'originalPath', 'name', 'sizeBytes', 'deletedAt'], op)
  const path = resultPath(item.originalPath, op)
  if (typeof item.id !== 'string' || !TRASH_ID.test(item.id) || item.name !== path.split('/').at(-1) ||
      (expectedPath !== undefined && path !== expectedPath) || !validByteCount(item.sizeBytes) ||
      !validTimestamp(item.deletedAt)) return invalidResult(op)
  return { id: item.id, originalPath: path, name: item.name as string, sizeBytes: item.sizeBytes, deletedAt: item.deletedAt }
}

const boundedList = (value: unknown, op: AccountFileRequest['op']): unknown[] => {
  if (!Array.isArray(value) || value.length > MAX_FILE_LIST_ENTRIES) return invalidResult(op)
  return value
}

/** Tenant content is accessed exclusively by the confined runner, never this process. */
export class JailedFileManager {
  readonly homeRoot: string
  readonly diskQuotaMb: Limit
  private readonly context: Readonly<AccountFileContext>
  private readonly runner: AccountFileRunner | undefined

  constructor(homeRoot: string, diskQuotaMb: Limit, opts: JailedFileManagerOptions) {
    if (!opts?.account) fail('PRECONDITION_FAILED', 'account identity is required for confined file operations')
    const account = opts.account
    validateUsername(account.username)
    validateHome(account.home, account.username)
    if (!Number.isSafeInteger(account.uid) || account.uid < 1000 || account.uid > 65_533 ||
        !Number.isSafeInteger(account.gid) || account.gid < 1000 || account.gid > 65_533) {
      fail('VALIDATION', 'a non-root account identity (UID/GID in 1000..65533) is required for confined file operations')
    }
    if (typeof homeRoot !== 'string' || !isAbsolute(homeRoot) || /[\u0000-\u001f\u007f]/.test(homeRoot)) {
      fail('VALIDATION', 'an absolute trusted account home is required')
    }
    if (diskQuotaMb !== 'unlimited' && (!Number.isSafeInteger(diskQuotaMb) || diskQuotaMb < 0)) {
      fail('VALIDATION', 'disk quota must be a non-negative integer or unlimited')
    }
    this.homeRoot = homeRoot
    this.diskQuotaMb = diskQuotaMb
    this.runner = opts.runner
    this.context = Object.freeze({
      account: Object.freeze({ username: account.username, uid: account.uid, gid: account.gid, home: account.home }),
      homeRoot, diskQuotaMb,
      maxEditBytes: MAX_EDIT_BYTES, maxFileMode: MAX_FILE_MODE, maxDirMode: MAX_DIR_MODE,
      maxListEntries: MAX_FILE_LIST_ENTRIES,
    })
  }

  private execute(request: AccountFileRequest): Promise<unknown> {
    const runner = this.runner
    if (runner && typeof runner.run === 'function') {
      return runner.run(this.context, Object.freeze(request))
    }
    return fail('PRECONDITION_FAILED', 'confined account file runner is not installed; file operations are unavailable')
  }

  async list(path = '', opts: { showHidden?: boolean } = {}): Promise<FileEntry[]> {
    const relative = path === '' ? '' : contentPath(path)
    const showHidden = booleanOption(opts.showHidden, true)
    const result = boundedList(await this.execute({ op: 'list', path: relative, showHidden }), 'list')
    const entries = result.map((item) => fileEntry(item, 'list'))
    const paths = new Set<string>()
    for (const entry of entries) {
      const parent = entry.path.split('/').slice(0, -1).join('/')
      if (parent !== relative || paths.has(entry.path) || (!showHidden && entry.name.startsWith('.'))) invalidResult('list')
      paths.add(entry.path)
    }
    return entries
  }

  async readText(path: string): Promise<FileText> {
    const relative = contentPath(path)
    const result = resultRecord(await this.execute({ op: 'read', path: relative }), ['path', 'content', 'sizeBytes', 'mtime'], 'read')
    if (result.path !== relative || typeof result.content !== 'string' || !result.content.isWellFormed() || !validByteCount(result.sizeBytes) ||
        !validTimestamp(result.mtime) || result.sizeBytes !== Buffer.byteLength(result.content, 'utf8') ||
        result.sizeBytes > MAX_EDIT_BYTES) return invalidResult('read')
    return { path: relative, content: result.content, sizeBytes: result.sizeBytes, mtime: result.mtime }
  }

  async writeText(path: string, content: string, opts: { overwrite?: boolean; mode?: number } = {}): Promise<FileEntry> {
    const relative = contentPath(path)
    if (typeof content !== 'string' || !content.isWellFormed()) fail('VALIDATION', 'content must be well-formed Unicode text')
    if (Buffer.byteLength(content, 'utf8') > MAX_EDIT_BYTES) fail('LIMIT_EXCEEDED', 'content exceeds the 1 MiB editor limit')
    const mode = assertSafeFileMode(opts.mode ?? MAX_FILE_MODE)
    const overwrite = booleanOption(opts.overwrite, true)
    const entry = changedEntry(await this.execute({ op: 'write', path: relative, content, overwrite, mode }), 'write', relative)
    if (entry.kind !== 'file' || entry.mode !== mode || entry.sizeBytes !== Buffer.byteLength(content, 'utf8')) return invalidResult('write')
    return entry
  }

  async mkdir(path: string, mode = MAX_DIR_MODE): Promise<FileEntry> {
    const relative = contentPath(path)
    assertSafeDirMode(mode)
    const entry = changedEntry(await this.execute({ op: 'mkdir', path: relative, mode }), 'mkdir', relative)
    if (entry.kind !== 'directory' || entry.mode !== mode || entry.sizeBytes !== 0) return invalidResult('mkdir')
    return entry
  }

  async chmod(path: string, mode: number): Promise<FileEntry> {
    const relative = contentPath(path)
    assertSafeDirMode(mode)
    const entry = changedEntry(await this.execute({ op: 'chmod', path: relative, mode }), 'chmod', relative)
    if (entry.mode !== mode) return invalidResult('chmod')
    return entry
  }

  async moveToTrash(path: string): Promise<TrashItem> {
    const relative = contentPath(path)
    return trashItem(await this.execute({ op: 'trash', path: relative }), 'trash', relative)
  }

  async listTrash(): Promise<TrashItem[]> {
    const items = boundedList(await this.execute({ op: 'list-trash' }), 'list-trash').map((item) => trashItem(item, 'list-trash'))
    if (new Set(items.map((item) => item.id)).size !== items.length) return invalidResult('list-trash')
    return items
  }

  async restoreFromTrash(id: string, opts: { overwrite?: boolean } = {}): Promise<FileEntry> {
    const identifier = trashId(id)
    const overwrite = booleanOption(opts.overwrite, false)
    return changedEntry(await this.execute({ op: 'restore', trashId: identifier, overwrite }), 'restore')
  }

  async emptyTrash(opts: { olderThanDays?: number } = {}): Promise<number> {
    const days = opts.olderThanDays
    if (days !== undefined && (!Number.isSafeInteger(days) || days < 0 || days > MAX_RETENTION_DAYS)) {
      fail('VALIDATION', 'trash retention days must be an integer in 0..36500')
    }
    const request: AccountFileRequest = { op: 'empty-trash', ...(days !== undefined && { olderThanDays: days }) }
    const removed = await this.execute(request)
    if (!validByteCount(removed) || removed > MAX_FILE_LIST_ENTRIES) return invalidResult('empty-trash')
    return removed
  }
}

export * from './account-file-runner.ts'
