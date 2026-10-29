import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fail, isXpanelError } from '@xpanel/core'
import type { Account, Domain } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { HtaccessWorkspace, type HtaccessTarget } from '../../agent/src/htaccess-workspace.ts'
import type { FileText } from '../../agent/src/file-manager.ts'
import { handleWebDirectivesRoute } from './web-directives-workspace.ts'

// The agent side is the actual checked HtaccessWorkspace; only files, the native
// parser and the loopback probe are declared test transports.
const ACCOUNT = '11111111-1111-4111-8111-111111111111', DOMAIN = '22222222-2222-4222-8222-222222222222'
const account = { id: ACCOUNT, username: 'alice', planId: '33333333-3333-4333-8333-333333333333', status: 'active' } as Account
const domain = { id: DOMAIN, accountId: ACCOUNT, name: 'example.test' } as Domain
const root = { principal: { kind: 'root', id: 'root-principal', username: 'root' }, apiTokenId: null, scopes: [] } as unknown as AuthenticatedCaller
const owner = { principal: { kind: 'user', id: 'user-principal', username: 'alice', accountId: ACCOUNT }, apiTokenId: null, scopes: [] } as unknown as AuthenticatedCaller
const original = '# keep\r\nRewriteEngine On\r\nRewriteRule ^index\\.php$ - [L]\r\n'
const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) { if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('xpanel-web-directives-')) throw new Error('unsafe test cleanup'); await rm(directory, { recursive: true, force: true }) } })

async function fixture(options: { content?: string | null; engine?: string; probes?: number[]; disabled?: string[]; caller?: AuthenticatedCaller } = {}) {
  const historyDir = await mkdtemp(join(tmpdir(), 'xpanel-web-directives-')); directories.push(historyDir)
  const target: HtaccessTarget = { accountId: ACCOUNT, domainId: DOMAIN, username: 'alice', domainName: 'example.test', home: '/home/alice', docRoot: '/home/alice/public_html', path: 'public_html/.htaccess', engine: options.engine ?? 'apache', backendPort: 8080, phpHandler: 'fpm', active: true }
  let tick = 0
  const make = (content: string): FileText => ({ path: target.path, content, sizeBytes: Buffer.byteLength(content), mtime: new Date(1700000000000 + ++tick * 1000).toISOString() })
  let file: FileText | null = options.content === null ? null : make(options.content ?? original)
  const writes = vi.fn(async (_path: string, content: string | null, expected: FileText | null) => {
    if (JSON.stringify(expected) !== JSON.stringify(file)) return fail('CONFLICT', 'changed preimage', { stateChanged: false })
    file = content === null ? null : make(content)
    return file && { ...file, name: '.htaccess', kind: 'file' as const, mode: 0o640 }
  })
  const probes = [...(options.probes ?? [200, 200])]
  const workspace = new HtaccessWorkspace({ historyDir, actor: 'alice', probe: async () => probes.shift() ?? 200, resolve: async () => target,
    validator: { available: async () => true, check: async () => ({ valid: true, nativeChecked: true, issues: [], checkedAt: new Date().toISOString() }) },
    files: () => ({ readText: async () => file ? { ...file } : fail('NOT_FOUND', 'missing'), writeTextChecked: writes }) })
  const callAgent = vi.fn(async (path: string, input: { body: unknown }) => {
    expect(path).toBe('/accounts/alice/htaccess/' + DOMAIN)
    try { return Response.json(await workspace.handle('alice', DOMAIN, input.body)) }
    catch (error) { if (!isXpanelError(error)) throw error; return Response.json({ error: { message: error.message, details: error.detail } }, { status: error.code === 'CONFLICT' ? 409 : error.code === 'VALIDATION' ? 422 : 412 }) }
  })
  const store = { getDomain: async (id: string) => id === DOMAIN ? domain : null, getAccount: async (id: string) => id === ACCOUNT ? account : null,
    getPlan: async () => ({ featureListId: 'list' }), getFeatureList: async () => ({ disabled: options.disabled ?? [] }) } as unknown as StateStore
  const access = vi.fn(async () => undefined)
  const ports = { store, requireCaller: async () => options.caller ?? root, assertCanAccessAccount: access, readJsonBody: async (req: Request) => await req.json() as Record<string, unknown>, callAgent }
  const route = (feature: string, method = 'GET', body?: unknown, search = '') => {
    const url = new URL('http://panel.test/api/domains/' + DOMAIN + '/web-directives/' + feature + search)
    return handleWebDirectivesRoute(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), url, method, ports)
  }
  const readJson = async (feature: string): Promise<Record<string, any>> => (await route(feature))!.json()
  return { route, readJson, writes, callAgent, access, file: () => file }
}

describe('web directives over the checked .htaccess workspace', () => {
  it('reads a feature model and saves only its managed block with the captured revision', async () => {
    const t = await fixture()
    const before = await t.readJson('redirects')
    expect(before).toMatchObject({ feature: 'redirects', managed: false, model: { entries: [] }, conflict: null, capabilities: { canSave: true, reason: null }, document: { exists: true, unmanagedLines: 3, managedFeatures: [] }, context: { path: 'public_html/.htaccess', engine: 'apache' } })
    expect(before).not.toHaveProperty('document.content')
    const model = { entries: [{ status: 301, path: '/old', target: 'https://example.org/new' }] }
    const saved = await (await t.route('redirects', 'PUT', { expectedRevision: before.document.revision, model }))!.json()
    expect(saved).toMatchObject({ managed: true, model, application: { status: 'saved', syntaxChecked: true, httpStatus: 200 }, document: { managedFeatures: ['redirects'] } })
    expect(t.file()!.content).toBe('# BEGIN xPanel redirects\r\nRedirect 301 /old https://example.org/new\r\n# END xPanel redirects\r\n' + original)
    expect(t.access).toHaveBeenCalledWith(root, account, 'domain.web-directives.redirects')
    const after = await t.readJson('redirects')
    expect(after).toMatchObject({ model, document: { revision: saved.document.revision } })
    const removed = await (await t.route('redirects', 'PUT', { expectedRevision: after.document.revision, model: { entries: [] } }))!.json()
    expect(removed).toMatchObject({ managed: false, application: { status: 'saved' } }); expect(t.file()!.content).toBe(original)
    const pages = await (await t.route('error-pages', 'PUT', { expectedRevision: removed.document.revision, model: { entries: [{ code: 404, path: '/missing.html' }] } }))!.json()
    expect(pages).toMatchObject({ existence: 'not-checked', model: { entries: [{ code: 404, path: '/missing.html' }] } })
  })
  it('creates the file when it does not exist and reports a guarded rollback truthfully', async () => {
    const created = await fixture({ content: null })
    const empty = await created.readJson('indexes')
    expect(empty).toMatchObject({ document: { exists: false, unmanagedLines: 0 }, model: { listing: 'inherit' } })
    await created.route('indexes', 'PUT', { expectedRevision: empty.document.revision, model: { listing: 'disabled' } })
    expect(created.file()!.content).toBe('# BEGIN xPanel indexes\nOptions -Indexes\n# END xPanel indexes\n')
    const failing = await fixture({ probes: [200, 500] })
    const current = await failing.readJson('mime-types')
    const result = await (await failing.route('mime-types', 'PUT', { expectedRevision: current.document.revision, model: { entries: [{ type: 'text/markdown', extensions: ['.md'] }] } }))!.json()
    expect(result).toMatchObject({ managed: false, model: { entries: [] }, application: { status: 'rolled_back', httpStatus: 500 } })
    expect(failing.file()!.content).toBe(original); expect(failing.writes).toHaveBeenCalledTimes(2)
  })
  it('refuses stale revisions, field errors, extra keys and no-op saves before any write', async () => {
    const t = await fixture(), current = await t.readJson('ip-blocker'), hotlink = await t.readJson('hotlink')
    expect(hotlink.model).toEqual({ enabled: false, allowedHosts: ['example.test', 'www.example.test'], extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'], allowEmptyReferrer: true, redirectUrl: null })
    await expect(t.route('redirects', 'PUT', { expectedRevision: 'f'.repeat(64), model: { entries: [{ status: 301, path: '/a', target: 'https://example.org/' }] } })).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    await expect(t.route('redirects', 'PUT', { expectedRevision: current.document.revision, model: { entries: [{ status: 301, path: '/a\nProxyPass / http://internal/', target: 'https://example.org/' }] } })).rejects.toMatchObject({ code: 'VALIDATION', detail: { fields: [{ field: 'entries.0.path', code: 'path' }] } })
    await expect(t.route('redirects', 'PUT', { expectedRevision: current.document.revision, model: { entries: [] }, content: 'Include /etc/passwd' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(t.route('redirects', 'PUT', { expectedRevision: current.document.revision, model: { entries: [] } })).rejects.toMatchObject({ code: 'VALIDATION', detail: { fields: [{ field: 'model', code: 'unchanged' }] } })
    await expect(t.route('redirects', 'GET', undefined, '?path=/etc')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(t.route('redirects', 'POST', {})).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(await t.route('handlers')).toBeNull(); expect(await t.route('RewriteRule')).toBeNull()
    expect(t.writes).not.toHaveBeenCalled()
  })
  it('keeps policy-refused, conflicted and non-Apache features unavailable', async () => {
    const t = await fixture()
    const blocked = await t.readJson('ip-blocker')
    expect(blocked.capabilities).toEqual({ canSave: false, reason: 'policy' })
    await expect(t.route('ip-blocker', 'PUT', { expectedRevision: blocked.document.revision, model: { entries: ['192.0.2.1'] } })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'policy' } })
    const conflicted = await fixture({ content: '# BEGIN xPanel redirects\nRedirect 301 /a https://example.org/\n' })
    expect(await conflicted.readJson('error-pages')).toMatchObject({ conflict: { code: 'marker_unbalanced', line: 1 }, capabilities: { canSave: false, reason: 'conflict' } })
    const nginx = await fixture({ engine: 'nginx' })
    expect((await nginx.readJson('hotlink')).capabilities).toEqual({ canSave: false, reason: 'engine' })
    expect(conflicted.writes).not.toHaveBeenCalled(); expect(nginx.writes).not.toHaveBeenCalled(); expect(t.writes).not.toHaveBeenCalled()
  })
  it('enforces the feature plan entry for account owners before reading', async () => {
    const t = await fixture({ caller: owner, disabled: ['hotlink-protection'] })
    await expect(t.route('hotlink')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await t.readJson('redirects')).capabilities.canSave).toBe(true)
    expect(t.callAgent).toHaveBeenCalledTimes(1)
  })
})
