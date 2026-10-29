import { describe, expect, it } from 'vitest'
import { FILE_WORKSPACE_LIMITS as limits, validateFileWorkspaceReply, validateFileWorkspaceRequest, type FileWorkspaceRequest } from './file-workspace-validation.ts'

const mtime = '2026-10-25T00:00:00.000Z'
const id = '11111111-1111-4111-8111-111111111111'
const entry = (path = 'docs/a.txt', patch: object = {}) => ({ name: path.split('/').at(-1)!, path, kind: 'file', sizeBytes: 3, mode: 0o640, mtime, ...patch })
const item = (patch: object = {}) => ({ id, originalPath: 'docs/a.txt', name: 'a.txt', sizeBytes: 3, deletedAt: mtime, ...patch })
const request = (value: unknown): FileWorkspaceRequest => validateFileWorkspaceRequest(value)
const requestError = (operation: () => unknown) => expect(operation).toThrowError(expect.objectContaining({ code: 'VALIDATION' }))
const replyError = (operation: () => unknown) => expect(operation).toThrowError(expect.objectContaining({ code: 'CONFIG_TEST_FAILED' }))

describe('pure file workspace requests', () => {
  it('normalizes all existing operations and preserves their distinct defaults', () => {
    expect(request({ op: 'list' })).toEqual({ op: 'list', path: '', showHidden: true })
    expect(request({ op: 'list', path: 'docs', showHidden: false })).toEqual({ op: 'list', path: 'docs', showHidden: false })
    for (const op of ['read', 'get-bytes', 'trash']) expect(request({ op, path: 'docs/a.txt' })).toEqual({ op, path: 'docs/a.txt' })
    expect(request({ op: 'write', path: 'docs/a.txt', content: '' })).toEqual({ op: 'write', path: 'docs/a.txt', content: '', overwrite: true, mode: 0o640 })
    expect(request({ op: 'put-bytes', path: 'docs/a.bin', contentBase64: '', overwrite: false })).toEqual({ op: 'put-bytes', path: 'docs/a.bin', contentBase64: '', overwrite: false, mode: 0o640 })
    expect(request({ op: 'mkdir', path: 'docs' })).toEqual({ op: 'mkdir', path: 'docs', mode: 0o750 })
    expect(request({ op: 'chmod', path: 'docs' })).toEqual({ op: 'chmod', path: 'docs', mode: 0o640 })
    expect(request({ op: 'list-trash' })).toEqual({ op: 'list-trash' })
    expect(request({ op: 'restore', trashId: id })).toEqual({ op: 'restore', trashId: id, overwrite: false })
    expect(request({ op: 'empty-trash' })).toEqual({ op: 'empty-trash' })
    expect(request({ op: 'empty-trash', olderThanDays: 0 })).toEqual({ op: 'empty-trash', olderThanDays: 0 })
    expect(request({ op: 'empty-trash', olderThanDays: 36500 })).toEqual({ op: 'empty-trash', olderThanDays: 36500 })
  })
  it('accepts well-formed Unicode and literal percent names without normalizing target identity', () => {
    for (const path of ['ملفات/فاتورة.txt', 'docs/a b.txt', 'docs/%2e%2e.txt', '.hidden', 'docs/.trashbox', 'docs/.trash/a', 'docs/e\u0301.txt']) expect(request({ op: 'read', path })).toEqual({ op: 'read', path })
    const input = { op: 'read', path: 'docs/first.txt' }
    const captured = request(input)
    input.path = 'docs/second.txt'
    expect(captured).toEqual({ op: 'read', path: 'docs/first.txt' })
  })
  it.each(['', '/', '/etc/passwd', 'C:drive', 'c:/drive', '\\\\server\\share', 'docs\\file', '.', '..', './a', 'a/../b', 'a//b', 'a/', '.trash', '.trash/a', 'a\u0000b', 'a\nb', 'a\u0085b', '\ud800'])('rejects unsafe content paths: %j', path => {
    requestError(() => request({ op: 'read', path }))
    requestError(() => request({ op: 'write', path, content: '' }))
  })
  it('allows only the list root alias and checks UTF8 path bytes', () => {
    expect(request({ op: 'list', path: '' })).toMatchObject({ path: '' })
    requestError(() => request({ op: 'list', path: '.' }))
    const bound = 'ع/'.repeat(1365) + 'a'
    expect(Buffer.byteLength(bound)).toBe(4096)
    expect(request({ op: 'read', path: bound })).toMatchObject({ path: bound })
    requestError(() => request({ op: 'read', path: bound + 'a' }))
  })
  it.each([null, [], 42, {}, { op: 'unknown' }, { op: 'toString' }, { op: 'list', path: null }, { op: 'list', path: undefined }, { op: 'list', showHidden: 'false' }, { op: 'list', showHidden: undefined }, { op: 'read' }, { op: 'read', path: 'a', uid: 1000 }, { op: 'write', path: 'a' }, { op: 'write', path: 'a', content: null }, { op: 'write', path: 'a', content: '\ud800' }, { op: 'write', path: 'a', content: '', overwrite: 0 }, { op: 'write', path: 'a', content: '', mode: undefined }, { op: 'put-bytes', path: 'a' }, { op: 'mkdir', path: 'a', content: '' }, { op: 'list-trash', path: '' }, { op: 'restore', trashId: 'not-a-uuid' }, { op: 'restore', trashId: id, overwrite: 'false' }, { op: 'empty-trash', olderThanDays: -1 }, { op: 'empty-trash', olderThanDays: 0.5 }, { op: 'empty-trash', olderThanDays: 36501 }, { op: 'empty-trash', olderThanDays: '1' }])('rejects wrong primitives and unknown operation fields: %j', input => requestError(() => request(input)))
  it.each([0, -1, 0o644, 0o666, 0o750, 0o4640, 0.5, '0640', true])('rejects unsafe regular-file mode %j', mode => requestError(() => request({ op: 'write', path: 'a', content: '', mode })))
  it('preserves valid file and directory permission subsets', () => {
    expect(request({ op: 'write', path: 'a', content: '', mode: 0o600, overwrite: false })).toMatchObject({ mode: 0o600, overwrite: false })
    expect(request({ op: 'mkdir', path: 'docs', mode: 0o750 })).toMatchObject({ mode: 0o750 })
    expect(request({ op: 'chmod', path: 'docs', mode: 0o750 })).toMatchObject({ mode: 0o750 })
    requestError(() => request({ op: 'mkdir', path: 'docs', mode: 0o751 }))
  })
  it('uses UTF8 text bytes and preserves explicit empty and NUL-containing text', () => {
    const content = 'ع'.repeat(limits.textBytes / 2)
    expect(request({ op: 'write', path: 'a', content })).toMatchObject({ content })
    expect(() => request({ op: 'write', path: 'a', content: content + 'a' })).toThrowError(expect.objectContaining({ code: 'LIMIT_EXCEEDED', detail: { stateChanged: false } }))
    expect(request({ op: 'write', path: 'a', content: 'a\u0000b' })).toMatchObject({ content: 'a\u0000b' })
  })
  it.each(['Zg', 'Zg=', 'Zg===', 'Zh==', 'AA-_', 'Zg==\n', ' Zg==', '====', 42, null])('rejects noncanonical base64: %j', contentBase64 => requestError(() => request({ op: 'put-bytes', path: 'a', contentBase64 })))
  it('accepts the exact 2 MiB binary limit and rejects one extra byte', () => {
    const contentBase64 = Buffer.alloc(limits.binaryBytes, 7).toString('base64')
    expect(request({ op: 'put-bytes', path: 'a', contentBase64 })).toMatchObject({ contentBase64 })
    requestError(() => request({ op: 'put-bytes', path: 'a', contentBase64: Buffer.alloc(limits.binaryBytes + 1).toString('base64') }))
  })
})

describe('strict operation-bound file workspace replies', () => {
  it('keeps list metadata permissive without offering symlink edit/write semantics', () => {
    const req = request({ op: 'list', path: 'docs' })
    const entries = [entry('docs/large.bin', { sizeBytes: Number.MAX_SAFE_INTEGER, mode: 0o644 }), entry('docs/link', { kind: 'symlink', mode: 0o777 }), entry('docs/sub', { kind: 'directory', sizeBytes: 4096, mode: 0o755 })]
    expect(validateFileWorkspaceReply(req, { entries })).toEqual({ entries })
    expect(validateFileWorkspaceReply(request({ op: 'list', path: '' }), { entries: [entry('root.txt')] })).toMatchObject({ entries: [{ path: 'root.txt' }] })
    expect(validateFileWorkspaceReply(req, { entries: [] })).toEqual({ entries: [] })
  })
  it.each([{ entries: [entry('other/a.txt')] }, { entries: [entry('docs/nested/a.txt')] }, { entries: [entry(), entry()] }, { entries: [entry('docs/.trash/a')] }, { entries: [entry('docs/a', { name: 'different' })] }, { entries: [entry('docs/a', { kind: 'unknown' })] }, { entries: [entry('docs/a', { sizeBytes: -1 })] }, { entries: [entry('docs/a', { sizeBytes: Infinity })] }, { entries: [entry('docs/a', { mode: 0o10000 })] }, { entries: [entry('docs/a', { mtime: '2026-02-31T00:00:00Z' })] }, { entries: [null] }, { entries: Array(1) }, {}, { entries: null }, { entries: [], unexpected: true }])('rejects wrong directory, duplicate and malformed list data: %j', input => replyError(() => validateFileWorkspaceReply(request({ op: 'list', path: 'docs' }), input)))
  it('bounds listing count without confusing nested user folders with managed root trash', () => {
    replyError(() => validateFileWorkspaceReply(request({ op: 'list', path: 'docs' }), { entries: Array(limits.listEntries + 1).fill(entry()) }))
    expect(validateFileWorkspaceReply(request({ op: 'list', path: 'docs/.trash' }), { entries: [entry('docs/.trash/a')] })).toMatchObject({ entries: [{ path: 'docs/.trash/a' }] })
  })
  it('requires hidden-filter compliance and valid UTC timestamps', () => {
    replyError(() => validateFileWorkspaceReply(request({ op: 'list', path: 'docs', showHidden: false }), { entries: [entry('docs/.hidden')] }))
    for (const time of ['2026-10-25T00:00:00Z', '2026-10-25T00:00:00.1Z', '2026-10-25T00:00:00.12Z']) expect(validateFileWorkspaceReply(request({ op: 'list', path: 'docs' }), { entries: [entry('docs/a', { mtime: time })] })).toMatchObject({ entries: [{ mtime: time }] })
    replyError(() => validateFileWorkspaceReply(request({ op: 'list', path: 'docs' }), { entries: [entry('docs/a', { mtime: '2026-10-25T00:00:00+00:00' })] }))
  })
  it('requires read content/path/byte count and preserves legitimate empty files', () => {
    const req = request({ op: 'read', path: 'docs/a.txt' })
    expect(validateFileWorkspaceReply(req, { path: 'docs/a.txt', content: '', sizeBytes: 0, mtime })).toEqual({ path: 'docs/a.txt', content: '', sizeBytes: 0, mtime })
    expect(validateFileWorkspaceReply(req, { path: 'docs/a.txt', content: 'ع', sizeBytes: 2, mtime })).toMatchObject({ content: 'ع' })
    for (const input of [{ path: 'wrong', content: '', sizeBytes: 0, mtime }, { path: 'docs/a.txt', sizeBytes: 0, mtime }, { path: 'docs/a.txt', content: null, sizeBytes: 0, mtime }, { path: 'docs/a.txt', content: 'ع', sizeBytes: 1, mtime }, { path: 'docs/a.txt', content: '\ud800', sizeBytes: 3, mtime }, { path: 'docs/a.txt', content: 'a'.repeat(limits.textBytes + 1), sizeBytes: limits.textBytes + 1, mtime }]) replyError(() => validateFileWorkspaceReply(req, input))
  })
  it('checks exact write target, kind, requested/default mode and UTF8 byte count', () => {
    const req = request({ op: 'write', path: 'docs/a.txt', content: 'عa' })
    expect(validateFileWorkspaceReply(req, entry())).toEqual(entry())
    for (const input of [entry('docs/other.txt'), entry('docs/a.txt', { kind: 'symlink' }), entry('docs/a.txt', { kind: 'directory' }), entry('docs/a.txt', { sizeBytes: 2 }), entry('docs/a.txt', { mode: 0o600 }), entry('docs/a.txt', { mode: 0o644 }), { entry: entry() }, { ...entry(), ok: true }]) replyError(() => validateFileWorkspaceReply(req, input))
    expect(validateFileWorkspaceReply(request({ op: 'write', path: 'docs/a.txt', content: '', mode: 0o600 }), entry('docs/a.txt', { sizeBytes: 0, mode: 0o600 }))).toMatchObject({ sizeBytes: 0 })
  })
  it('validates binary read and upload with canonical encoding and exact sizes', () => {
    const req = request({ op: 'get-bytes', path: 'docs/a.bin' })
    expect(validateFileWorkspaceReply(req, { path: 'docs/a.bin', contentBase64: '', sizeBytes: 0, mtime })).toMatchObject({ sizeBytes: 0 })
    for (const input of [{ path: 'wrong', contentBase64: 'Zg==', sizeBytes: 1, mtime }, { path: 'docs/a.bin', contentBase64: 'Zh==', sizeBytes: 1, mtime }, { path: 'docs/a.bin', contentBase64: 'Zg==', sizeBytes: 2, mtime }, { path: 'docs/a.bin', contentBase64: 'Zg==', sizeBytes: 1 }]) replyError(() => validateFileWorkspaceReply(req, input))
    const put = request({ op: 'put-bytes', path: 'docs/a.bin', contentBase64: 'Zg==', overwrite: false })
    expect(validateFileWorkspaceReply(put, entry('docs/a.bin', { sizeBytes: 1 }))).toMatchObject({ sizeBytes: 1 })
    replyError(() => validateFileWorkspaceReply(put, entry('docs/a.bin', { sizeBytes: 2 })))
  })
  it('preserves mkdir/chmod/restore entry shapes with operation-specific modes', () => {
    const mkdir = request({ op: 'mkdir', path: 'docs/sub' })
    expect(validateFileWorkspaceReply(mkdir, entry('docs/sub', { kind: 'directory', mode: 0o750, sizeBytes: 0 }))).toMatchObject({ kind: 'directory' })
    for (const input of [entry('docs/sub', { kind: 'directory', mode: 0o750, sizeBytes: 4096 }), entry('docs/sub', { mode: 0o640 }), entry('docs/sub', { kind: 'symlink', mode: 0o750, sizeBytes: 0 })]) replyError(() => validateFileWorkspaceReply(mkdir, input))
    expect(validateFileWorkspaceReply(request({ op: 'chmod', path: 'docs/sub', mode: 0o750 }), entry('docs/sub', { kind: 'directory', mode: 0o750 }))).toMatchObject({ mode: 0o750 })
    replyError(() => validateFileWorkspaceReply(request({ op: 'chmod', path: 'docs/a.txt', mode: 0o750 }), entry('docs/a.txt', { mode: 0o750 })))
    expect(validateFileWorkspaceReply(request({ op: 'restore', trashId: id }), entry())).toEqual(entry())
    replyError(() => validateFileWorkspaceReply(request({ op: 'restore', trashId: id }), entry('docs/a.txt', { kind: 'symlink' })))
  })
  it('preserves exact trash/list-trash/empty-trash wrappers and bounded metadata', () => {
    expect(validateFileWorkspaceReply(request({ op: 'trash', path: 'docs/a.txt' }), item())).toEqual(item())
    replyError(() => validateFileWorkspaceReply(request({ op: 'trash', path: 'other' }), item()))
    expect(validateFileWorkspaceReply(request({ op: 'list-trash' }), { items: [item()] })).toEqual({ items: [item()] })
    for (const input of [{ items: [item(), item()] }, { items: [item({ id: 'bad' })] }, { items: [item({ name: 'wrong' })] }, { items: [item({ originalPath: '.trash/a' })] }, [item()]]) replyError(() => validateFileWorkspaceReply(request({ op: 'list-trash' }), input))
    expect(validateFileWorkspaceReply(request({ op: 'empty-trash' }), { removed: 0 })).toEqual({ removed: 0 })
    expect(validateFileWorkspaceReply(request({ op: 'empty-trash' }), { removed: 10000 })).toEqual({ removed: 10000 })
    for (const input of [0, {}, { removed: -1 }, { removed: 0.5 }, { removed: 10001 }, { removed: 1, ok: true }]) replyError(() => validateFileWorkspaceReply(request({ op: 'empty-trash' }), input))
  })
  it('throws without inventing a no-effect claim after a malformed write acknowledgement', () => {
    try { validateFileWorkspaceReply(request({ op: 'write', path: 'docs/a.txt', content: '' }), {}) }
    catch (error) {
      expect(error).toMatchObject({ code: 'CONFIG_TEST_FAILED', detail: { operation: 'write' } })
      expect((error as { detail: Record<string, unknown> }).detail).not.toHaveProperty('stateChanged')
      return
    }
    throw new Error('Expected malformed acknowledgement rejection')
  })
})
