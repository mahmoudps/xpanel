import { fail } from '@xpanel/core'
import type { AccountFileRequest, FileBytes, FileEntry, FileText, TrashItem } from '../../agent/src/file-manager.ts'

// Aligned with the existing agent wire contract without importing its native runtime.
export const FILE_WORKSPACE_LIMITS = Object.freeze({
  pathBytes: 4096, textBytes: 1024 * 1024, binaryBytes: 2 * 1024 * 1024,
  listEntries: 10000, fileMode: 0o640, directoryMode: 0o750, retentionDays: 36500,
})
export type FileWorkspaceRequest = Exclude<AccountFileRequest, { op: 'write-checked' }>
export interface FileWorkspaceReplyMap {
  list: { entries: FileEntry[] }
  read: FileText
  write: FileEntry
  'put-bytes': FileEntry
  'get-bytes': FileBytes
  mkdir: FileEntry
  chmod: FileEntry
  trash: TrashItem
  'list-trash': { items: TrashItem[] }
  restore: FileEntry
  'empty-trash': { removed: number }
  'purge-trash': TrashItem
}
export type FileWorkspaceReply<T extends FileWorkspaceRequest = FileWorkspaceRequest> = FileWorkspaceReplyMap[T['op']]
const fields = {
  list: ['path', 'showHidden'], read: ['path'], write: ['path', 'content', 'overwrite', 'mode'],
  'put-bytes': ['path', 'contentBase64', 'overwrite', 'mode'], 'get-bytes': ['path'],
  mkdir: ['path', 'mode'], chmod: ['path', 'mode'], trash: ['path'], 'list-trash': [],
  restore: ['trashId', 'overwrite'], 'empty-trash': ['olderThanDays'], 'purge-trash': ['trashId', 'originalPath', 'deletedAt'],
} as const
const TRASH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const badRequest = (message: string): never => fail('VALIDATION', message)
const badReply = (op: FileWorkspaceRequest['op']): never => fail('CONFIG_TEST_FAILED', 'File workspace returned an invalid reply', { operation: op })
const own = (value: object, key: string): boolean => Object.hasOwn(value, key)
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const bytes = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const unicode = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length <= maximum && value.isWellFormed() && Buffer.byteLength(value, 'utf8') <= maximum
const pathValid = (value: unknown, root = false): value is string => {
  if (!unicode(value, FILE_WORKSPACE_LIMITS.pathBytes)) return false
  if (value === '') return root
  if (/[\u0000-\u001f\u007f-\u009f\\]/u.test(value) || value.startsWith('/') || /^[a-z]:/i.test(value)) return false
  // Managed trash is accessible only through its dedicated operations.
  if (value === '.trash' || value.startsWith('.trash/')) return false
  return value.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}
const path = (value: unknown, root = false): string => pathValid(value, root) ? value : badRequest('A canonical account-relative path is required')
const option = (body: Record<string, unknown>, key: string, fallback: boolean): boolean => !own(body, key) ? fallback : typeof body[key] === 'boolean' ? body[key] as boolean : badRequest(key + ' must be a boolean')
const mode = (value: unknown, ceiling: number): number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= ceiling && (value & ~ceiling) === 0 ? value : badRequest('File mode exceeds the allowed permission bits')
const base64 = (value: unknown): Buffer | null => {
  if (typeof value !== 'string' || value.length > Math.ceil(FILE_WORKSPACE_LIMITS.binaryBytes / 3) * 4 || !BASE64.test(value)) return null
  const decoded = Buffer.from(value, 'base64')
  return decoded.length <= FILE_WORKSPACE_LIMITS.binaryBytes && decoded.toString('base64') === value ? decoded : null
}

export function validateFileWorkspaceRequest(input: unknown): FileWorkspaceRequest {
  if (!object(input) || typeof input.op !== 'string' || !own(fields, input.op)) return badRequest('Unsupported file workspace request')
  const op = input.op as FileWorkspaceRequest['op']
  if (Object.keys(input).some(key => key !== 'op' && !(fields[op] as readonly string[]).includes(key))) return badRequest('Unknown file workspace request field')
  switch (op) {
    case 'list': return { op, path: own(input, 'path') ? path(input.path, true) : '', showHidden: option(input, 'showHidden', true) }
    case 'read': case 'get-bytes': case 'trash': return { op, path: path(input.path) }
    case 'write': {
      if (typeof input.content !== 'string' || !input.content.isWellFormed()) return badRequest('Explicit well-formed UTF8 content is required')
      if (Buffer.byteLength(input.content, 'utf8') > FILE_WORKSPACE_LIMITS.textBytes) return fail('LIMIT_EXCEEDED', 'content exceeds the 1 MiB editor limit', { stateChanged: false })
      return { op, path: path(input.path), content: input.content, overwrite: option(input, 'overwrite', true), mode: mode(own(input, 'mode') ? input.mode : FILE_WORKSPACE_LIMITS.fileMode, FILE_WORKSPACE_LIMITS.fileMode) }
    }
    case 'put-bytes': {
      if (!base64(input.contentBase64)) return badRequest('Explicit canonical base64 within 2 MiB is required')
      return { op, path: path(input.path), contentBase64: input.contentBase64 as string, overwrite: option(input, 'overwrite', true), mode: mode(own(input, 'mode') ? input.mode : FILE_WORKSPACE_LIMITS.fileMode, FILE_WORKSPACE_LIMITS.fileMode) }
    }
    case 'mkdir': return { op, path: path(input.path), mode: mode(own(input, 'mode') ? input.mode : FILE_WORKSPACE_LIMITS.directoryMode, FILE_WORKSPACE_LIMITS.directoryMode) }
    case 'chmod': return { op, path: path(input.path), mode: mode(own(input, 'mode') ? input.mode : FILE_WORKSPACE_LIMITS.fileMode, FILE_WORKSPACE_LIMITS.directoryMode) }
    case 'list-trash': return { op }
    case 'restore':
      if (typeof input.trashId !== 'string' || !TRASH_ID.test(input.trashId)) return badRequest('A valid trash item ID is required')
      return { op, trashId: input.trashId, overwrite: option(input, 'overwrite', false) }
    case 'empty-trash':
      if (!own(input, 'olderThanDays')) return { op }
      if (!bytes(input.olderThanDays) || input.olderThanDays > FILE_WORKSPACE_LIMITS.retentionDays) return badRequest('Trash retention days must be an integer between 0 and 36500')
      return { op, olderThanDays: input.olderThanDays }
    case 'purge-trash':
      if (typeof input.trashId !== 'string' || !TRASH_ID.test(input.trashId)) return badRequest('A valid trash item ID is required')
      // originalPath and deletedAt are the reviewed revision; the agent refuses the purge when either changed.
      if (!timestamp(input.deletedAt)) return badRequest('The trashed time of the reviewed item is required')
      return { op, trashId: input.trashId, originalPath: path(input.originalPath), deletedAt: input.deletedAt }
  }
}
const result = (value: unknown, required: readonly string[], op: FileWorkspaceRequest['op']): Record<string, unknown> => {
  if (!object(value) || Object.keys(value).length !== required.length || required.some(key => !own(value, key))) return badReply(op)
  return value
}
const timestamp = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return false
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return false
  const normalized = value.includes('.') ? value.replace(/\.(\d{1,3})Z$/, (_, digits: string) => '.' + digits.padEnd(3, '0') + 'Z') : value.replace(/Z$/, '.000Z')
  return date.toISOString() === normalized
}
const entry = (value: unknown, op: FileWorkspaceRequest['op'], expectedPath?: string): FileEntry => {
  const item = result(value, ['name', 'path', 'kind', 'sizeBytes', 'mode', 'mtime'], op)
  if (!pathValid(item.path) || item.name !== item.path.split('/').at(-1) || expectedPath !== undefined && item.path !== expectedPath ||
      !['file', 'directory', 'symlink'].includes(String(item.kind)) || typeof item.kind !== 'string' || !bytes(item.sizeBytes) ||
      typeof item.mode !== 'number' || !Number.isSafeInteger(item.mode) || item.mode < 0 || item.mode > 0o7777 || !timestamp(item.mtime)) return badReply(op)
  return { name: item.name as string, path: item.path, kind: item.kind as FileEntry['kind'], sizeBytes: item.sizeBytes, mode: item.mode, mtime: item.mtime }
}
const changedEntry = (value: unknown, op: FileWorkspaceRequest['op'], expectedPath?: string): FileEntry => {
  const item = entry(value, op, expectedPath)
  const ceiling = item.kind === 'directory' ? FILE_WORKSPACE_LIMITS.directoryMode : FILE_WORKSPACE_LIMITS.fileMode
  if (item.kind === 'symlink' || item.mode <= 0 || (item.mode & ~ceiling) !== 0) return badReply(op)
  return item
}
const list = (value: unknown, op: FileWorkspaceRequest['op']): unknown[] => {
  if (!Array.isArray(value) || value.length > FILE_WORKSPACE_LIMITS.listEntries) return badReply(op)
  for (let i = 0; i < value.length; i++) if (!own(value, String(i))) return badReply(op)
  return value
}
const trashItem = (value: unknown, op: FileWorkspaceRequest['op'], expectedPath?: string): TrashItem => {
  const item = result(value, ['id', 'originalPath', 'name', 'sizeBytes', 'deletedAt'], op)
  if (typeof item.id !== 'string' || !TRASH_ID.test(item.id) || !pathValid(item.originalPath) || item.name !== item.originalPath.split('/').at(-1) ||
      expectedPath !== undefined && item.originalPath !== expectedPath || !bytes(item.sizeBytes) || !timestamp(item.deletedAt)) return badReply(op)
  return { id: item.id, originalPath: item.originalPath, name: item.name as string, sizeBytes: item.sizeBytes, deletedAt: item.deletedAt }
}

function checkedReply(request: FileWorkspaceRequest, input: unknown): FileWorkspaceReply {
  const op = request.op
  let reply: FileWorkspaceReply
  switch (op) {
    case 'list': {
      const body = result(input, ['entries'], op), seen = new Set<string>()
      const entries = list(body.entries, op).map(value => {
        const item = entry(value, op)
        if (item.path.split('/').slice(0, -1).join('/') !== request.path || seen.has(item.path) || !request.showHidden && item.name.startsWith('.')) return badReply(op)
        seen.add(item.path)
        return item
      })
      reply = { entries }; break
    }
    case 'read': {
      const body = result(input, ['path', 'content', 'sizeBytes', 'mtime'], op)
      if (body.path !== request.path || !unicode(body.content, FILE_WORKSPACE_LIMITS.textBytes) || !bytes(body.sizeBytes) || body.sizeBytes !== Buffer.byteLength(body.content, 'utf8') || !timestamp(body.mtime)) return badReply(op)
      reply = { path: request.path, content: body.content, sizeBytes: body.sizeBytes, mtime: body.mtime }; break
    }
    case 'get-bytes': {
      const body = result(input, ['path', 'contentBase64', 'sizeBytes', 'mtime'], op), decoded = base64(body.contentBase64)
      if (body.path !== request.path || !decoded || !bytes(body.sizeBytes) || body.sizeBytes !== decoded.length || !timestamp(body.mtime)) return badReply(op)
      reply = { path: request.path, contentBase64: body.contentBase64 as string, sizeBytes: body.sizeBytes, mtime: body.mtime }; break
    }
    case 'write': case 'put-bytes': {
      const item = changedEntry(input, op, request.path)
      const size = op === 'write' ? Buffer.byteLength(request.content, 'utf8') : base64(request.contentBase64)?.length
      if (item.kind !== 'file' || item.mode !== request.mode || item.sizeBytes !== size) return badReply(op)
      reply = item; break
    }
    case 'mkdir': {
      const item = changedEntry(input, op, request.path)
      if (item.kind !== 'directory' || item.mode !== request.mode || item.sizeBytes !== 0) return badReply(op)
      reply = item; break
    }
    case 'chmod': {
      const item = changedEntry(input, op, request.path)
      if (item.mode !== request.mode) return badReply(op)
      reply = item; break
    }
    case 'trash': reply = trashItem(input, op, request.path); break
    case 'list-trash': {
      const body = result(input, ['items'], op), seen = new Set<string>()
      const items = list(body.items, op).map(value => {
        const item = trashItem(value, op)
        if (seen.has(item.id)) return badReply(op)
        seen.add(item.id)
        return item
      })
      reply = { items }; break
    }
    // Restore's existing protocol supplies only trashId, not an expected originalPath.
    case 'restore': reply = changedEntry(input, op); break
    case 'empty-trash': {
      const body = result(input, ['removed'], op)
      if (!bytes(body.removed) || body.removed > FILE_WORKSPACE_LIMITS.listEntries) return badReply(op)
      reply = { removed: body.removed }; break
    }
    case 'purge-trash': {
      const item = trashItem(input, op, request.originalPath)
      if (item.id !== request.trashId || item.deletedAt !== request.deletedAt) return badReply(op)
      reply = item; break
    }
    default: return badReply(op)
  }
  return reply
}

export function validateFileWorkspaceReply<T extends FileWorkspaceRequest>(request: T, input: unknown): FileWorkspaceReply<T> {
  return checkedReply(request, input) as FileWorkspaceReply<T>
}
