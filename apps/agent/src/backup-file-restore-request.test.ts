import { describe, expect, it } from 'vitest'
import { archiveCreatedAt, parseBackupFileRequest, restoreFolderName } from './backup-file-restore-request.ts'

const FILE = 'xpanel-backup-alice-20261026T100000Z.tar.gz'

describe('file restore request grammar', () => {
  it('derives the restored folder and creation time from the archive name only', () => {
    expect(restoreFolderName(FILE)).toBe('restored-20261026T100000Z')
    expect(restoreFolderName('xpanel-backup-alice-20261027T090000Z-0123456789ab.tar.gz')).toBe('restored-20261027T090000Z-0123456789ab')
    expect(archiveCreatedAt(FILE)).toBe('2026-10-26T10:00:00Z')
  })
  it('accepts exact keys, this account\'s archives and bounded unique selections', () => {
    expect(parseBackupFileRequest('browse', 'alice', { file: FILE })).toEqual({ op: 'browse', file: FILE })
    expect(parseBackupFileRequest('preview', 'alice', { file: FILE, paths: ['public_html'], destination: 'in-place' })).toEqual({ op: 'preview', file: FILE, paths: ['public_html'], destination: 'in-place' })
    expect(parseBackupFileRequest('restore', 'alice', { file: FILE, paths: ['a'], destination: 'new-folder', expectedRevision: 'f'.repeat(64) })).toMatchObject({ op: 'restore', expectedRevision: 'f'.repeat(64) })
  })
  it.each([
    ['browse', { file: FILE, paths: [] }], ['browse', { file: 'xpanel-backup-bob-20261026T100000Z.tar.gz' }], ['browse', { file: 42 }], ['browse', []],
    ['preview', { file: FILE, paths: Array.from({ length: 501 }, (_, index) => 'f' + index), destination: 'new-folder' }],
    ['preview', { file: FILE, paths: ['a', 'a'], destination: 'new-folder' }], ['preview', { file: FILE, paths: ['a'], destination: 'overwrite' }],
    ['preview', { file: FILE, paths: ['a/../../etc'], destination: 'new-folder' }], ['preview', { file: FILE, paths: [7], destination: 'new-folder' }],
    ['preview', { file: FILE, paths: ['x'.repeat(4097)], destination: 'new-folder' }],
    ['restore', { file: FILE, paths: ['a'], destination: 'in-place', expectedRevision: 'x' }], ['restore', { file: FILE, paths: ['a'], destination: 'in-place' }],
  ] as const)('refuses %s %j', (op, body) => {
    expect(() => parseBackupFileRequest(op, 'alice', body)).toThrow(expect.objectContaining({ code: 'VALIDATION' }))
  })
})
