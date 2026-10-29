import { fail } from '@xpanel/core'
import { assertBackupFileName } from './account-backup.ts'

/** Request grammar shared by the API boundary and the agent; no host access here. */
export const MAX_RESTORE_SELECTION = 500
export const MAX_RESTORE_FILES = 500
export const MAX_LISTED_ARCHIVES = 200
export const MAX_RESTORE_PATH_BYTES = 4096
export const BACKUP_ARCHIVE_NAME = /^xpanel-backup-[a-z][a-z0-9]{0,15}-([0-9]{8}T[0-9]{6}Z)(?:-([a-f0-9]{12}))?\.tar\.gz$/
export const RESTORE_REVISION = /^[0-9a-f]{64}$/
const unchanged = { stateChanged: false }

export type RestoreDestination = 'new-folder' | 'in-place'
export type RestoreRefusal = 'too-large' | 'path-too-long' | 'mail-preserved' | 'reserved'
export type RestoreResult = 'restored' | 'skipped-exists' | 'failed' | 'not-attempted'
export type BackupFileRequest =
  | { op: 'browse'; file: string }
  | { op: 'preview'; file: string; paths: string[]; destination: RestoreDestination }
  | { op: 'restore'; file: string; paths: string[]; destination: RestoreDestination; expectedRevision: string }

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export const archiveCreatedAt = (file: string): string => { const stamp = BACKUP_ARCHIVE_NAME.exec(file)![1]!; return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z` }
export const restoreFolderName = (file: string): string => { const match = BACKUP_ARCHIVE_NAME.exec(file)!; return 'restored-' + match[1] + (match[2] ? '-' + match[2] : '') }

export const restorePath = (value: unknown): string => {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > MAX_RESTORE_PATH_BYTES || !value.isWellFormed() || /[\u0000-\u001f\u007f\\]/.test(value)
    || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..')) return fail('VALIDATION', 'selected paths must be relative to the account home without traversal', unchanged)
  return value
}

/** Shared by the API boundary and the agent: exact keys, archive names of this account only, bounded selections. */
export function parseBackupFileRequest(op: BackupFileRequest['op'], username: string, body: unknown): BackupFileRequest {
  const keys = op === 'browse' ? ['file'] : op === 'preview' ? ['file', 'paths', 'destination'] : ['file', 'paths', 'destination', 'expectedRevision']
  if (!object(body) || Object.keys(body).length !== keys.length || keys.some(key => !Object.hasOwn(body, key))) return fail('VALIDATION', 'file restore ' + op + ' takes only ' + keys.join(', '), unchanged)
  let file: string
  try { file = assertBackupFileName(username, body.file as string) } catch { return fail('VALIDATION', 'the backup archive name is invalid for this account', unchanged) }
  if (op === 'browse') return { op, file }
  if (!Array.isArray(body.paths) || body.paths.length === 0 || body.paths.length > MAX_RESTORE_SELECTION) return fail('VALIDATION', `select 1 to ${MAX_RESTORE_SELECTION} files or folders`, unchanged)
  const paths = body.paths.map(restorePath)
  if (new Set(paths).size !== paths.length) return fail('VALIDATION', 'a selected path is repeated', unchanged)
  if (body.destination !== 'new-folder' && body.destination !== 'in-place') return fail('VALIDATION', 'the destination must be new-folder or in-place', unchanged)
  if (op === 'preview') return { op, file, paths, destination: body.destination }
  if (typeof body.expectedRevision !== 'string' || !RESTORE_REVISION.test(body.expectedRevision)) return fail('VALIDATION', 'the reviewed restore revision is required', unchanged)
  return { op, file, paths, destination: body.destination, expectedRevision: body.expectedRevision }
}
