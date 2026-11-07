import { describe, expect, it, vi } from 'vitest'
import { assertSkeletonPath, copySkeleton, handleSkeletonRoute, skeletonFolders } from './skeleton-workspace.ts'
import type { SkeletonPorts } from './skeleton-workspace.ts'
import type { AuthenticatedCaller } from './auth.ts'

const reseller = '11111111-1111-4111-8111-111111111111'
const setup = (kind = 'root') => {
  const files: Record<string, unknown> = {}
  let body: Record<string, unknown> = {}
  const ports: SkeletonPorts = { requireCaller: async () => ({ principal: { kind, username: 'a' } }) as AuthenticatedCaller, readJsonBody: async () => body, resellerOf: async () => kind === 'reseller' ? reseller : null, read: async scope => files[scope] ?? null, write: async (scope, value) => { files[scope] = value; return value }, audit: async () => undefined }
  const call = async (method: string, path: string, input: Record<string, unknown> = {}) => { body = input; const request = new Request('http://x' + path, { method }); return await (await handleSkeletonRoute(request, new URL(request.url), method, ports))!.json() as Record<string, any> }
  return { files, call }
}
const base64 = (text: string): string => Buffer.from(text).toString('base64')

describe('Skeleton Directory', () => {
  it('holds files by owner, and a reseller never sees root files', async () => {
    const root = setup(), first = await root.call('GET', '/api/accounts/skeleton')
    const saved = await root.call('PUT', '/api/accounts/skeleton/file', { path: 'public_html/index.html', contentBase64: base64('hi'), expectedRevision: first.revision })
    expect(saved).toMatchObject({ scope: 'root', files: [{ path: 'public_html/index.html', bytes: 2 }] })
    expect(JSON.stringify(saved)).not.toContain(base64('hi'))
    const other = setup('reseller')
    expect(await other.call('GET', '/api/accounts/skeleton')).toMatchObject({ scope: reseller, files: [] })
    const removed = await root.call('DELETE', '/api/accounts/skeleton/file', { path: 'public_html/index.html', expectedRevision: saved.revision })
    expect(removed.files).toEqual([])
    await expect(root.call('DELETE', '/api/accounts/skeleton/file', { path: 'public_html/index.html', expectedRevision: removed.revision })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
  it('stays inside the two folders', () => {
    expect(assertSkeletonPath('public_ftp/readme.txt')).toBe('public_ftp/readme.txt')
    for (const path of ['public_html', 'etc/passwd', 'public_html/../x', 'public_html/.htaccess', '/public_html/a', 'public_html//a', 'mail/a']) expect(() => assertSkeletonPath(path), path).toThrow()
  })
  it('refuses more than a file can hold and mixed file and folder names', async () => {
    const { call } = setup(), first = await call('GET', '/api/accounts/skeleton')
    await expect(call('PUT', '/api/accounts/skeleton/file', { path: 'public_html/a', contentBase64: Buffer.alloc(1024 * 1024 + 1).toString('base64'), expectedRevision: first.revision })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    await expect(call('PUT', '/api/accounts/skeleton/file', { path: 'public_html/a', contentBase64: 'x', expectedRevision: first.revision })).rejects.toMatchObject({ code: 'VALIDATION' })
    const saved = await call('PUT', '/api/accounts/skeleton/file', { path: 'public_html/a', contentBase64: base64('x'), expectedRevision: first.revision })
    await expect(call('PUT', '/api/accounts/skeleton/file', { path: 'public_html/a/b', contentBase64: base64('x'), expectedRevision: saved.revision })).rejects.toMatchObject({ code: 'CONFLICT' })
  })
  it('copies as the account and reports a file it could not write', async () => {
    const file = { path: 'public_ftp/in/a.txt', contentBase64: base64('a'), bytes: 1 }, top = { path: 'public_html/b.txt', contentBase64: base64('b'), bytes: 1 }
    expect(skeletonFolders([file, top])).toEqual(['public_ftp', 'public_ftp/in'])
    const op = vi.fn(async (body: Record<string, unknown>) => body.path !== top.path)
    expect(await copySkeleton({ readFiles: async () => [file, top], op })).toEqual({ copied: 1, failed: [top.path] })
    expect(op.mock.calls.map(([body]) => [body.op, body.path, body.overwrite])).toEqual([['mkdir', 'public_ftp', undefined], ['mkdir', 'public_ftp/in', undefined], ['put-bytes', file.path, false], ['put-bytes', top.path, false]])
  })
})
