import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthenticatedCaller } from './auth.ts'
import { SHARE_MISS_LIMIT, SHARE_MISS_WINDOW_MS, createShareMissLimiter, handleFileShareDownload, handleFileShareLinksRoute } from './file-share-links-workspace.ts'
import type { FileShareDownloadPorts, FileShareLinksHelpers } from './file-share-links-workspace.ts'
import { stateConfigFile } from './panel-config-file.ts'
import { FILE_SHARE_LINKS_STATE_PATH, parseShareLinks, shareTokenHash } from '../../agent/src/file-share-links.ts'
import type { FileShareLink, FileShareLinks } from '../../agent/src/file-share-links.ts'

const token = 'a'.repeat(43), now = new Date('2026-11-07T12:00:00Z')
const caller = { principal: { id: 'root-id', kind: 'root', username: 'root' } } as unknown as AuthenticatedCaller
const link = (over: Partial<FileShareLink> = {}): FileShareLink => ({ id: 'fsl_0123456789abcdef', tokenHash: shareTokenHash(token), accountId: 'acc', username: 'alice', file: 'public_html/report.pdf', fileId: '1:2', sizeBytes: 5, expiresAt: '2026-11-08T12:00:00Z', createdAt: '2026-11-07T11:00:00Z', createdBy: 'root', createdById: 'root-id', ...over })
const fileResponse = () => new Response('hello', { headers: { 'content-disposition': 'attachment; filename="report.pdf"', 'content-length': '5' } })
const ports = (rows: FileShareLink[], over: Partial<FileShareDownloadPorts> = {}): FileShareDownloadPorts => ({ limiter: createShareMissLimiter(), uses: createShareMissLimiter(Date.now, 1000), clientAddress: () => '203.0.113.9', readLinks: async () => rows, openFile: vi.fn(async () => fileResponse()), emitAudit: vi.fn(async () => undefined), now: () => now, ...over })
const download = (path: string, context: FileShareDownloadPorts, method = 'GET') => { const url = new URL('https://panel.test' + path); return handleFileShareDownload(new Request(url, { method }), url, method, context) }
const answer = async (response: Response) => ({ status: response.status, body: await response.text(), headers: [...response.headers.entries()].sort() })

describe('public share route', () => {
  it('serves that one file as a download and records the use before the first byte', async () => {
    const context = ports([link()]), response = await download('/share/' + token, context)
    expect(response.status).toBe(200); expect(await response.text()).toBe('hello')
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="report.pdf"')
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff'); expect(response.headers.get('content-security-policy')).toContain('sandbox')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(vi.mocked(context.emitAudit).mock.calls[0]![0]).toMatchObject({ action: 'file_share.link_used', actor: 'anonymous', principalId: null, detail: { linkId: link().id, client: '203.0.113.9' } })
    expect(JSON.stringify(vi.mocked(context.emitAudit).mock.calls[0])).not.toContain(token)
  })
  it('answers exactly the same for unknown, expired, revoked and malformed tokens', async () => {
    const unknown = await answer(await download('/share/' + 'b'.repeat(43), ports([link()])))
    const expired = await answer(await download('/share/' + token, ports([link({ expiresAt: now.toISOString() })])))
    const revoked = await answer(await download('/share/' + token, ports([])))
    const malformed = await answer(await download('/share/short', ports([link()])))
    const unreadable = await answer(await download('/share/' + token, ports([], { readLinks: async () => { throw new Error('corrupt') } })))
    expect(unknown).toMatchObject({ status: 404, body: 'Not found' })
    for (const other of [expired, revoked, malformed, unreadable]) expect(other).toEqual(unknown)
  })
  it('answers the same when the agent refuses the file, as for a symlink or a replaced file', async () => {
    const unknown = await answer(await download('/share/' + 'b'.repeat(43), ports([link()])))
    const refused = ports([link()], { openFile: async () => Response.json({ code: 'NOT_FOUND' }, { status: 404 }) })
    expect(await answer(await download('/share/' + token, refused))).toEqual(unknown); expect(refused.emitAudit).not.toHaveBeenCalled()
    const thrown = ports([link()], { openFile: async () => { throw new Error('agent gone') } })
    expect(await answer(await download('/share/' + token, thrown))).toEqual(unknown)
  })
  it('refuses traversal and path shapes without touching the agent', async () => {
    const context = ports([link()])
    for (const path of ['/share/..%2F..%2Fetc%2Fpasswd', '/share/' + token + '/../../etc/passwd', '/share/' + token + '%2Fpublic_html', '/share/%2e%2e', '/share/' + token + '?file=/etc/passwd', '/share/' + token + '?code=1']) {
      expect((await download(path, context)).status, path).toBe(404)
    }
    expect(context.openFile).not.toHaveBeenCalled()
  })
  it('accepts GET alone, with no lookup', async () => {
    const context = ports([link()])
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) expect((await download('/share/' + token, context, method)).status, method).toBe(405)
    expect(context.openFile).not.toHaveBeenCalled(); expect(context.emitAudit).not.toHaveBeenCalled()
  })
  it('rate limits misses by client, for live tokens too, until the window ends', async () => {
    let clock = 0; const limiter = createShareMissLimiter(() => clock), context = ports([link()], { limiter })
    for (let index = 0; index < SHARE_MISS_LIMIT; index++) expect((await download('/share/' + 'b'.repeat(43), context)).status).toBe(404)
    const limited = await download('/share/' + token, context)
    expect(limited.status).toBe(429); expect(limited.headers.get('retry-after')).toBe('600'); expect(context.openFile).not.toHaveBeenCalled()
    expect((await download('/share/' + token, { ...context, clientAddress: () => '203.0.113.10' })).status).toBe(200)
    clock += SHARE_MISS_WINDOW_MS
    expect((await download('/share/' + token, context)).status).toBe(200)
  })
  it('does not count a served file as a miss', async () => {
    const context = ports([link()]); for (let index = 0; index < SHARE_MISS_LIMIT + 2; index++) expect((await download('/share/' + token, context)).status).toBe(200)
  })
  it('rate limits served files by client too', async () => {
    const context = ports([link()], { uses: createShareMissLimiter(() => 0, 2) })
    expect((await download('/share/' + token, context)).status).toBe(200); expect((await download('/share/' + token, context)).status).toBe(200)
    expect((await download('/share/' + token, context)).status).toBe(429); expect(context.emitAudit).toHaveBeenCalledTimes(2)
  })
  it('refuses new addresses when the table is full', () => {
    const limiter = createShareMissLimiter(() => 0); for (let index = 0; index < 4096; index++) limiter.miss('10.0.' + index)
    expect(limiter.blocked('203.0.113.1')).toBe(true); expect(limiter.blocked('10.0.1')).toBe(false)
  })
  it('sends nothing when the use cannot be recorded', async () => {
    const body = fileResponse(), context = ports([link()], { openFile: async () => body, emitAudit: async () => { throw new Error('audit down') } })
    const response = await download('/share/' + token, context)
    expect(response.status).toBe(503); expect(await response.text()).not.toContain('hello')
  })
})

describe('share link management', () => {
  const roots: string[] = []
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
  async function setup(over: Partial<FileShareLinksHelpers> = {}) {
    const rootDir = await mkdtemp(tmpdir() + '/share-api-'); roots.push(rootDir)
    const store = { rootDir, getWriterLock: () => ({ acquire: async () => ({ release: async () => undefined, assertFencingToken: async () => undefined }) }) } as never
    const file = stateConfigFile<FileShareLinks>(store, FILE_SHARE_LINKS_STATE_PATH, 'file-share-links', parseShareLinks, () => ({ links: [] }))
    const helpers: FileShareLinksHelpers = { requireCaller: async () => caller, assertRoot: vi.fn(async () => undefined), file, inspect: vi.fn(async () => ({ accountId: 'acc', username: 'alice', file: 'public_html/report.pdf', fileId: '1:2', sizeBytes: 5 })), emitAudit: vi.fn(async () => undefined), now: () => now, ...over }
    const call = (method: string, path = '', body?: unknown) => { const url = new URL('https://panel.test/api/server/file-sharing/links' + path); return handleFileShareLinksRoute(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), url, method, helpers) }
    const revision = async () => ((await (await call('GET'))!.json()) as { revision: string }).revision
    const create = async (over2: Record<string, unknown> = {}) => call('POST', '', { path: '/home/alice/public_html/report.pdf', expiresHours: 24, expectedRevision: await revision(), ...over2 })
    return { helpers, call, create, rootDir }
  }
  it('returns a long random token once and saves only its hash', async () => {
    const { create, helpers, rootDir, call } = await setup(), response = await create(), body = await response!.json() as { path: string; link: { expiresAt: string } }
    const value = body.path.slice('/share/'.length)
    expect(response!.status).toBe(201); expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(body.link.expiresAt).toBe('2026-11-08T12:00:00.000Z')
    const saved = await readFile(rootDir + '/' + FILE_SHARE_LINKS_STATE_PATH, 'utf8')
    expect(saved).not.toContain(value); expect(saved).toContain(shareTokenHash(value))
    expect(JSON.stringify(await (await call('GET'))!.json())).not.toContain(shareTokenHash(value))
    expect(vi.mocked(helpers.emitAudit).mock.calls[0]![0]).toMatchObject({ action: 'file_share.link_created', actor: 'root', target: 'file:alice:public_html/report.pdf' })
    expect(JSON.stringify(vi.mocked(helpers.emitAudit).mock.calls)).not.toContain(value)
    expect(((await create()) as Response).status).toBe(201)
    expect(new Set([value, ((await (await create())!.json()) as { path: string }).path.slice(7)]).size).toBe(2)
  })
  it('requires an expiry within bounds, one path and the current revision', async () => {
    const { create, helpers } = await setup()
    for (const expiresHours of [undefined, null, 0, -1, 721, 1.5, '24']) await expect(create({ expiresHours }), String(expiresHours)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(create({ path: ['/a', '/b'] })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(create({ code: 'extra' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(create({ expectedRevision: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(helpers.emitAudit).not.toHaveBeenCalled()
  })
  it('creates nothing for a path the agent refuses', async () => {
    const { create, call } = await setup({ inspect: async () => { throw Object.assign(new Error('no'), { code: 'NOT_FOUND' }) } })
    await expect(create()).rejects.toThrow('no'); expect(((await (await call('GET'))!.json()) as { links: unknown[] }).links).toEqual([])
  })
  it('withdraws a link that could not be recorded and shows no token', async () => {
    const { create, call } = await setup({ emitAudit: async () => { throw new Error('audit down') } })
    await expect(create()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(((await (await call('GET'))!.json()) as { links: unknown[] }).links).toEqual([])
  })
  it('revokes a link, records it, and the token then answers as unknown', async () => {
    const { create, call, helpers, rootDir } = await setup(), created = await (await create())!.json() as { path: string; link: { id: string } }
    const before = await readFile(rootDir + '/' + FILE_SHARE_LINKS_STATE_PATH, 'utf8')
    expect((await call('DELETE', '/' + created.link.id))!.status).toBe(200)
    const after = parseShareLinks(JSON.parse(await readFile(rootDir + '/' + FILE_SHARE_LINKS_STATE_PATH, 'utf8')))!
    expect(before).toContain(created.link.id); expect(after.links).toEqual([])
    expect(vi.mocked(helpers.emitAudit).mock.calls.at(-1)![0]).toMatchObject({ action: 'file_share.link_revoked', detail: { linkId: created.link.id } })
    expect((await download(created.path, ports(after.links))).status).toBe(404)
    await expect(call('DELETE', '/fsl_0000000000000000')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
  it('states a revocation that could not be recorded', async () => {
    let fail = false; const { create, call } = await setup({ emitAudit: async () => { if (fail) throw new Error('audit down') } }), created = await (await create())!.json() as { link: { id: string } }
    fail = true; await expect(call('DELETE', '/' + created.link.id)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true } })
  })
  it('requires root before anything else and takes no selectors', async () => {
    const { call, helpers } = await setup({ assertRoot: async () => { throw new Error('denied') } })
    await expect(call('GET')).rejects.toThrow('denied'); expect(helpers.inspect).not.toHaveBeenCalled()
    const open = await setup(); await expect(open.call('GET', '?all=1')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await open.call('PUT', '', {}))!.status).toBe(405); expect((await open.call('GET', '/fsl_0123456789abcdef'))!.status).toBe(405)
  })
})
