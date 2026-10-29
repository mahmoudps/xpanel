import { describe, expect, it, vi } from 'vitest'
import type { Account, Domain, Plan } from '@xpanel/core'
import { handleComposerWorkspaceRoute, parseComposerDocuments } from './composer-workspace.ts'
import type { ComposerWorkspaceContext } from './composer-workspace.ts'
import { COMPOSER_VERSION_ARGV } from '../../../packages/os/src/composer-command.ts'
import { readComposerWorkspaceView } from '../../../packages/os/src/composer-command-view.ts'

const account = { id: 'a', username: 'alpha', uid: 1001, gid: 1001, home: '/home/alpha', status: 'active', planId: 'plan' } as Account
const domain = { id: 'site-a', accountId: 'a', name: 'example.test', siteType: 'php', docRoot: '/home/alpha/public_html', suspended: false, php: { version: '8.3' } } as Domain
const lock = JSON.stringify({ packages: [{ name: 'vendor/package', version: '1.2.0', source: { url: 'https://private.invalid' } }], 'packages-dev': [] })
function fixture() {
  const content = new Map<string, string>([['public_html/composer.json', JSON.stringify({ require: { php: '^8.1', 'vendor/package': '^1.0' }, scripts: { post: 'private-script' }, repositories: [{ url: 'https://private.invalid' }], config: { 'http-basic': { private: 'private-credential' } } })], ['public_html/composer.lock', lock], ['public_html/vendor/composer/installed.json', JSON.stringify({ packages: [{ name: 'vendor/package', version: '1.2.0' }] })]])
  const directories = ['public_html', 'public_html/vendor', 'public_html/vendor/composer']
  const overrides = new Map<string, string>()
  const list = vi.fn(async (path: string) => {
    const prefix = path ? path + '/' : ''
    const entries = [...directories, ...content.keys()].filter(key => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
    return entries.map(key => ({ name: key.slice(prefix.length), path: key, kind: overrides.get(key) ?? (directories.includes(key) ? 'directory' : 'file'), sizeBytes: Buffer.byteLength(content.get(key) ?? ''), mtime: '2026-10-27T00:00:00.000Z', mode: 0o640 }))
  })
  const readText = vi.fn(async (path: string) => ({ path, content: content.get(path)!, sizeBytes: Buffer.byteLength(content.get(path)!), mtime: '2026-10-27T00:00:00.000Z' }))
  const run = vi.fn(async () => ({ ok: true, code: 0, stdout: 'Composer version 2.8.12 2026-01-01 00:00:00\n', stderr: 'private-stderr' }))
  const ctx: ComposerWorkspaceContext = { assertRoot: vi.fn(async () => ({ actor: 'root' })), run, files: vi.fn(() => ({ list, readText } as never)), now: () => new Date('2026-10-27T00:00:00.000Z'), store: { listAccounts: vi.fn(async () => [account]), listDomains: vi.fn(async () => [domain]), getPlan: vi.fn(async () => ({ id: 'plan' }) as Plan), withAccountLifecycleLease: vi.fn(async (_id, operation) => operation(account)) } }
  return { ctx, content, overrides, list, readText, run }
}
async function read(ctx: ComposerWorkspaceContext, query = '?domainId=site-a', method = 'GET') { const url = new URL('http://local/host/composer' + query); return handleComposerWorkspaceRoute(new Request(url), url, method, ctx) }
async function responseView(response: Response | null) {
  if (!response) throw new Error('missing_composer_response')
  const raw: unknown = await response.json()
  expect(JSON.stringify(raw)).not.toMatch(/private-|PRIVATE|source|repositories|scripts/)
  return readComposerWorkspaceView(raw)
}
async function projectView(response: Response | null) {
  const view = await responseView(response)
  if (!view.selected) throw new Error('missing_selected_composer_project')
  return view.selected
}
describe('Composer protected project observation', () => {
  it('resolves a saved PHP root and reads bounded dependency metadata through the account lease', async () => {
    const f = fixture(), response = await read(f.ctx), view = await responseView(response)
    expect(view.selected).toMatchObject({ state: 'read', manifest: 'present', lock: 'present', vendor: 'present', lockMatch: 'matches', lockFreshness: 'not-verified', packages: [{ name: 'vendor/package', requirement: '^1.0', locked: '1.2.0', installed: '1.2.0' }] })
    expect(f.run).toHaveBeenCalledWith([...COMPOSER_VERSION_ARGV]); expect(f.ctx.store.withAccountLifecycleLease).toHaveBeenCalledOnce()
    expect(JSON.stringify(view)).not.toMatch(/private-|source|repositories|scripts/)
    expect(view.actions.install).toBe(false); expect(response!.headers.get('cache-control')).toBe('no-store')
  })
  it('reads targets without opening project files and ignores unrelated or inactive sites', async () => {
    const f = fixture(); f.ctx.store.listDomains = async () => [domain, { ...domain, id: 'static', siteType: 'static' }, { ...domain, id: 'suspended', suspended: true }, { ...domain, id: 'outside', docRoot: '/root/private' }, { ...domain, id: 'traversal', docRoot: '/home/alpha/public_html/../private' }]
    const view = await responseView(await read(f.ctx, ''))
    expect(view.projects).toHaveLength(1); expect(view.selected).toBeNull(); expect(f.list).not.toHaveBeenCalled()
  })
  it.each(['?path=/root', '?domainId=site-a&domainId=site-a', '?domainId=../private', '?url=https://private.invalid'])('rejects unsafe selectors %s before native providers', async query => {
    const f = fixture(); await expect(read(f.ctx, query)).rejects.toMatchObject({ code: 'VALIDATION' }); expect(f.run).not.toHaveBeenCalled(); expect(f.list).not.toHaveBeenCalled()
  })
  it('checks root before all protected observations and refreshes authority after awaits', async () => {
    const f = fixture(); f.ctx.assertRoot = async () => { throw new Error('denied') }
    await expect(read(f.ctx)).rejects.toThrow('denied'); expect(f.run).not.toHaveBeenCalled()
    const g = fixture(); let calls = 0; g.ctx.assertRoot = async () => ({ actor: ++calls === 1 ? 'root' : 'another' })
    await expect(read(g.ctx)).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(g.list).not.toHaveBeenCalled()
  })
  it('reports a missing manifest distinctly without inventing empty installed state', async () => {
    const f = fixture(); f.content.delete('public_html/composer.json')
    const view = await responseView(await read(f.ctx)); expect(view.selected).toMatchObject({ state: 'missing', reason: 'composer-json-missing', manifest: 'missing', lock: 'unavailable', packages: [] })
  })
  it.each(['public_html/composer.lock', 'public_html/vendor/composer/installed.json'])('refuses malformed %s without returning partial packages', async path => {
    const f = fixture(); f.content.set(path, '{')
    const view = await responseView(await read(f.ctx)); expect(view.selected).toMatchObject({ state: 'unavailable', reason: 'invalid-project-data', packages: [] })
  })
  it('refuses symlink project data and oversized files before readText', async () => {
    const f = fixture(); f.overrides.set('public_html/composer.json', 'symlink')
    expect((await projectView(await read(f.ctx))).state).toBe('unavailable'); expect(f.readText).not.toHaveBeenCalled()
    const g = fixture(); g.content.set('public_html/composer.json', 'x'.repeat(1024 * 1024 + 1))
    expect((await projectView(await read(g.ctx))).state).toBe('unavailable'); expect(g.readText).not.toHaveBeenCalled()
  })
  it('keeps failed/malformed version probes and unavailable native files unavailable', async () => {
    const f = fixture(); f.run.mockResolvedValue({ ok: true, code: 0, stdout: 'Composer version 2.8.12\nPRIVATE\n', stderr: '' }); f.ctx.files = () => null
    const view = await responseView(await read(f.ctx)); expect(view.binary.state).toBe('unavailable'); expect(view.selected).toMatchObject({ reason: 'project-read-unavailable' }); expect(JSON.stringify(view)).not.toContain('PRIVATE')
  })
  it('refuses selected sites whose saved document root changed under the lease', async () => {
    const f = fixture(); let calls = 0; f.ctx.store.listDomains = async () => [++calls === 1 ? domain : { ...domain, docRoot: '/home/alpha/other' }]
    await expect(read(f.ctx)).rejects.toMatchObject({ code: 'CONFLICT' }); expect(f.list).not.toHaveBeenCalled()
  })
  it('distinguishes changed installed versions and detects changing documents', async () => {
    const f = fixture(); f.content.set('public_html/vendor/composer/installed.json', JSON.stringify([{ name: 'vendor/package', version: '1.1.0' }]))
    expect((await projectView(await read(f.ctx))).lockMatch).toBe('differs')
    const g = fixture(), original = g.readText.getMockImplementation()!; let calls = 0
    g.readText.mockImplementation(async path => { const result = await original(path); if (path === 'public_html/composer.json' && ++calls > 1) result.content = '{}'; return result })
    expect((await projectView(await read(g.ctx))).reason).toBe('invalid-project-data')
  })
  it('supports Composer 1/2 metadata and refuses duplicate or credential-bearing dependency versions', () => {
    expect(parseComposerDocuments('{"require-dev":{"test/tool":"^1"}}', null, null)[0]).toMatchObject({ name: 'test/tool', development: true, locked: null, installed: null })
    expect(() => parseComposerDocuments('{}', '{"packages":[],"packages-dev":[{},{}]}', null)).toThrow()
    expect(() => parseComposerDocuments('{"require":{"test/tool":"https://user:private@host/"}}', null, null)).toThrow()
    expect(() => parseComposerDocuments('{}', lock, '[{"name":"test/tool","version":"1.0"},{"name":"test/tool","version":"1.0"}]')).toThrow()
  })
  it('allows only GET and does not consume unrelated routes', async () => {
    const f = fixture(); expect((await read(f.ctx, '', 'POST'))!.status).toBe(405); expect(f.run).not.toHaveBeenCalled()
    const url = new URL('http://local/other'); expect(await handleComposerWorkspaceRoute(new Request(url), url, 'GET', f.ctx)).toBeNull()
  })
  it('keeps the new Composer transaction routes unavailable without the qualified native provider', async () => {
    const f = fixture(), url = new URL('http://local/host/composer/jobs/preview')
    await expect(handleComposerWorkspaceRoute(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'install', domainId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }) }), url, 'POST', f.ctx)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    expect(f.run).not.toHaveBeenCalled(); expect(f.list).not.toHaveBeenCalled()
  })
})
