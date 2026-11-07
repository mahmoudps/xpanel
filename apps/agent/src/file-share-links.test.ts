import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Account } from '@xpanel/core'
import { FILE_SHARE_LINKS_STATE_PATH, findShareLink, handleFileShareLinkRoute, parseShareLinks, shareTokenHash } from './file-share-links.ts'
import type { FileShareLink, FileShareLinkRouteContext, OpenedShareFile } from './file-share-links.ts'

const token = 'a'.repeat(43), tokenHash = shareTokenHash(token), now = new Date('2026-11-07T12:00:00Z')
const row = (over: Partial<FileShareLink> = {}): FileShareLink => ({ id: 'fsl_0123456789abcdef', tokenHash, accountId: 'acc', username: 'alice', file: 'public_html/report one.pdf', fileId: '1:2', sizeBytes: 5, expiresAt: '2026-11-08T12:00:00Z', createdAt: '2026-11-07T11:00:00Z', createdBy: 'root', createdById: 'root-id', ...over })
const account = { id: 'acc', username: 'alice', uid: 1001, home: '/home/alice', status: 'active' } as Account
const opened = (fileId = '1:2'): OpenedShareFile => ({ handle: { close: vi.fn(async () => undefined), createReadStream: () => { const { Readable } = process.getBuiltinModule('node:stream'); return Readable.from([Buffer.from('hello')]) } } as never, sizeBytes: 5, fileId })
const roots: string[] = []
async function context(links: FileShareLink[], over: Partial<FileShareLinkRouteContext> = {}): Promise<FileShareLinkRouteContext> {
  const rootDir = await mkdtemp(join(tmpdir(), 'share-route-')); roots.push(rootDir)
  const path = join(rootDir, FILE_SHARE_LINKS_STATE_PATH); await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify({ links }))
  return { assertRoot: async () => undefined, principalId: 'root-id', rootDir, readAccounts: async () => [account], openFile: vi.fn(async () => opened()), now: () => now, ...over }
}
const content = (ctx: FileShareLinkRouteContext, hash = tokenHash, method = 'GET') => { const url = new URL(`http://agent/host/file-sharing/links/${hash}/content`); return handleFileShareLinkRoute(new Request(url, { method }), url, method, ctx) }
const inspect = (ctx: FileShareLinkRouteContext, body: unknown) => { const url = new URL('http://agent/host/file-sharing/links/inspect'); return handleFileShareLinkRoute(new Request(url, { method: 'POST', body: JSON.stringify(body) }), url, 'POST', ctx) }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('share link rows', () => {
  it('accepts only complete rows and never a plain token', () => {
    expect(parseShareLinks({ links: [row()] })!.links).toHaveLength(1)
    for (const bad of [{ links: [{ ...row(), token }] }, { links: [row({ tokenHash: token })] }, { links: [row({ file: '../x' })] }, { links: [row({ expiresAt: 'never' })] }, { links: [], extra: 1 }, []]) expect(parseShareLinks(bad)).toBeNull()
  })
  it('matches a live hash only', () => {
    expect(findShareLink([row()], tokenHash, now)?.id).toBe('fsl_0123456789abcdef')
    expect(findShareLink([row({ expiresAt: now.toISOString() })], tokenHash, now)).toBeNull()
    expect(findShareLink([row()], shareTokenHash('b'.repeat(43)), now)).toBeNull()
  })
})

describe('agent share file route', () => {
  it('streams only the saved file as a sanitized attachment', async () => {
    const ctx = await context([row()]), response = await content(ctx)
    expect(ctx.openFile).toHaveBeenCalledWith('/home/alice', 'public_html/report one.pdf', 1001)
    expect(await response!.text()).toBe('hello')
    expect(response!.headers.get('content-disposition')).toBe('attachment; filename="report_one.pdf"')
    expect(response!.headers.get('content-type')).toBe('application/octet-stream')
  })
  it('names nothing but a saved live link created by this principal', async () => {
    await expect(content(await context([row()]), 'f'.repeat(64))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(content(await context([row({ expiresAt: now.toISOString() })]))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(content(await context([]))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(content(await context([row({ createdById: 'someone-else' })]))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const url = new URL(`http://agent/host/file-sharing/links/${tokenHash}/content?path=/etc/shadow`)
    await expect(handleFileShareLinkRoute(new Request(url), url, 'GET', await context([row()]))).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await content(await context([row()]), tokenHash, 'POST'))!.status).toBe(405)
  })
  it('stops serving when the account stops or the file was replaced', async () => {
    await expect(content(await context([row()], { readAccounts: async () => [{ ...account, status: 'suspended' }] }))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(content(await context([row()], { readAccounts: async () => [] }))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const replaced = opened('9:9')
    await expect(content(await context([row()], { openFile: async () => replaced }))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(replaced.handle.close).toHaveBeenCalled()
  })
  it('inspects one file inside an active account and nothing else', async () => {
    const ctx = await context([]), response = await inspect(ctx, { path: '/home/alice/public_html/report.pdf' })
    expect(await response!.json()).toEqual({ accountId: 'acc', username: 'alice', file: 'public_html/report.pdf', fileId: '1:2', sizeBytes: 5 })
    await expect(inspect(ctx, { path: '/etc/passwd' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(inspect(ctx, { path: '/home/alice/../bob/x' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(inspect(ctx, { path: '/home/alice/' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(inspect(ctx, { path: ['/home/alice/a', '/home/alice/b'] })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(inspect(await context([], { openFile: null }), { path: '/home/alice/a' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
})
