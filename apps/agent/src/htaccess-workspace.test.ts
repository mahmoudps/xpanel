import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { fail } from '@xpanel/core'
import type { Account, Domain, ServerSettings } from '@xpanel/core'
import { HtaccessWorkspace, deriveHtaccessTarget, type HtaccessTarget } from './htaccess-workspace.ts'
import { inspectHtaccess, planHtaccessPhpMigration } from './htaccess-policy.ts'
import { probeHtaccessTarget } from './htaccess-native.ts'
import { JailedFileManager, type AccountFileContext, type AccountFileRequest, type FileText } from './file-manager.ts'

// Files and Apache parsing are declared test transports. History uses private
// temporary files; the probe uses an actual unprivileged loopback HTTP server.
const ACCOUNT = '11111111-1111-4111-8111-111111111111', DOMAIN = '22222222-2222-4222-8222-222222222222'
const target: HtaccessTarget = { accountId: ACCOUNT, domainId: DOMAIN, username: 'alice', domainName: 'example.test', home: '/home/alice', docRoot: '/home/alice/public_html', path: 'public_html/.htaccess', engine: 'apache', backendPort: 8080, phpHandler: 'fpm', active: true }
const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) { if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('xpanel-htaccess-test-')) throw new Error('unsafe test cleanup'); await rm(directory, { recursive: true, force: true }) } })
async function fixture(initial: string | null = 'RewriteEngine Off\n') {
  const historyDir = await mkdtemp(join(tmpdir(), 'xpanel-htaccess-test-')); directories.push(historyDir)
  let tick = 0, revoked = false
  const makeFile = (content: string): FileText => ({ path: target.path, content, sizeBytes: Buffer.byteLength(content), mtime: new Date(1700000000000 + ++tick * 1000).toISOString() })
  let file: FileText | null = initial === null ? null : makeFile(initial)
  const checked = vi.fn(async (path: string, content: string | null, expected: FileText | null) => {
    expect(path).toBe(target.path)
    if (JSON.stringify(expected) !== JSON.stringify(file)) return fail('CONFLICT', 'changed preimage', { stateChanged: false })
    file = content === null ? null : makeFile(content)
    return file === null ? null : { ...file, name: '.htaccess', kind: 'file' as const, mode: 0o640 }
  })
  const probe = vi.fn(async () => 200)
  const validator = { available: vi.fn(async () => true), check: vi.fn(async () => ({ valid: true, nativeChecked: true, issues: [], checkedAt: new Date().toISOString() })) }
  const workspace = new HtaccessWorkspace({ historyDir, actor: 'owner', validator, probe,
    resolve: async () => { if (revoked) return fail('FORBIDDEN', 'revoked', { stateChanged: false }); return target },
    files: () => ({ readText: async () => { if (file === null) return fail('NOT_FOUND', 'missing'); return { ...file } }, writeTextChecked: checked }) })
  return { workspace, checked, probe, validator, historyDir, file: () => file, external: (content: string) => { file = makeFile(content) }, revoke: () => { revoked = true } }
}
describe('protected .htaccess policy and migration', () => {
  it('uses the current serving parent for an alias without trusting its legacy docroot', () => {
    const account = { id: ACCOUNT, username: 'alice', home: '/home/alice', status: 'active' } as Account
    const parent = { id: '33333333-3333-4333-8333-333333333333', accountId: ACCOUNT, name: 'parent.example.test', kind: 'primary', docRoot: '/home/alice/public_html', siteType: 'php', suspended: false, php: { handler: 'fpm' } } as Domain
    const alias = { ...parent, id: DOMAIN, kind: 'alias', parentId: parent.id, name: 'alias.example.test', docRoot: '/home/alice/legacy-unused' } as Domain
    const settings = { engine: 'apache', backendPort: 8080 } as ServerSettings
    expect(() => deriveHtaccessTarget(account, alias, settings)).toThrow()
    expect(deriveHtaccessTarget(account, alias, settings, parent)).toMatchObject({ domainId: DOMAIN, domainName: alias.name, docRoot: parent.docRoot, path: 'public_html/.htaccess', active: true })
    expect(() => deriveHtaccessTarget(account, alias, settings, { ...parent, accountId: '44444444-4444-4444-8444-444444444444' })).toThrow()
    expect(deriveHtaccessTarget(account, alias, settings, { ...parent, suspended: true }).active).toBe(false)
  })
  it('accepts per-directory rewrites and refuses privileged or executable directives', () => {
    expect(inspectHtaccess('RewriteEngine On\nRewriteRule ^ /index.php [L]\n<FilesMatch "^private$">\nRequire all denied\n</FilesMatch>\n').valid).toBe(true)
    for (const line of ['Include /etc/passwd', 'Options +ExecCGI', 'RewriteRule ^ http://internal/ [P]', 'RewriteRule ^ - [H=application/x-httpd-php]', 'Header set X-Test "expr=%{REQUEST_URI}"', 'Header set X-Test "%{SERVER_SECRET}e"', '<Directory /etc>']) expect(inspectHtaccess(line).valid, line).toBe(false)
  })
  it('preserves unrelated bytes and mixed line endings when planning PHP migration', () => {
    const plan = planHtaccessPhpMigration('# keep\r\nphp_value memory_limit 128M\nRewriteEngine Off\r\nphp_flag display_errors Off\n')
    expect(plan.settings).toEqual({ memory_limit: '128M', display_errors: 'Off' }); expect(plan.content).toBe('# keep\r\nRewriteEngine Off\r\n')
    expect(() => planHtaccessPhpMigration('php_value memory_limit 128M\nphp_value memory_limit 256M\n')).toThrow()
    expect(() => planHtaccessPhpMigration('<FilesMatch "private.php">\nphp_value memory_limit 128M\n</FilesMatch>\n')).toThrow()
    expect(() => planHtaccessPhpMigration('php_value disable_functions ""\n')).toThrow()
    expect(() => planHtaccessPhpMigration('php_flag display_errors perhaps\n')).toThrow()
    expect(() => planHtaccessPhpMigration('Header set X-Test \\\nphp_value memory_limit 128M\n')).toThrow()
  })
})
describe('real orchestration with declared test transports', () => {
  it('allocates no history on read, saves a preimage and restores it', async () => {
    const f = await fixture(), before = await f.workspace.read('alice', DOMAIN)
    expect(await readdir(f.historyDir)).toEqual([])
    const saved = await f.workspace.save('alice', DOMAIN, 'RewriteEngine On\n', before.document.revision)
    expect(f.file()?.content).toBe('RewriteEngine On\n'); expect(saved.application.status).toBe('saved')
    const restored = await f.workspace.restore('alice', DOMAIN, saved.versions.find(item => item.state === 'kept')!.id, saved.document.revision)
    expect(restored.document.content).toBe(before.document.content); expect(f.checked).toHaveBeenCalledTimes(2)
  })
  it('removes the new file after a failed check if the original was absent', async () => {
    const f = await fixture(null), before = await f.workspace.read('alice', DOMAIN)
    f.probe.mockResolvedValueOnce(200).mockResolvedValueOnce(500)
    const result = await f.workspace.save('alice', DOMAIN, 'RewriteEngine On\n', before.document.revision)
    expect(result.application.status).toBe('rolled_back'); expect(result.document.exists).toBe(false); expect(f.file()).toBeNull(); expect(f.checked.mock.calls[1]?.[1]).toBeNull()
  })
  it('preserves concurrent changes and holds uncertainty without replay', async () => {
    const f = await fixture(), before = await f.workspace.read('alice', DOMAIN)
    f.probe.mockResolvedValueOnce(200).mockImplementationOnce(async () => { f.external('# external writer\n'); return 500 })
    await expect(f.workspace.save('alice', DOMAIN, 'RewriteEngine On\n', before.document.revision)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true } })
    expect(f.file()?.content).toBe('# external writer\n')
    const observed = await f.workspace.read('alice', DOMAIN); expect(observed.reviewRequired).toBe(true)
    await expect(f.workspace.save('alice', DOMAIN, '', observed.document.revision)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' }); expect(f.checked).toHaveBeenCalledTimes(2)
  })
  it('permits a checked repair of HTTP 500 and refuses stale or revoked writes', async () => {
    const f = await fixture(), before = await f.workspace.read('alice', DOMAIN)
    f.probe.mockResolvedValueOnce(500).mockResolvedValueOnce(200)
    const saved = await f.workspace.save('alice', DOMAIN, 'RewriteEngine On\n', before.document.revision)
    expect(saved.application.status).toBe('saved')
    await expect(f.workspace.save('alice', DOMAIN, '', before.document.revision)).rejects.toMatchObject({ code: 'CONFLICT' })
    f.revoke(); await expect(f.workspace.save('alice', DOMAIN, '', saved.document.revision)).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(f.checked).toHaveBeenCalledTimes(1)
  })
  it('reports prewrite parser and probe failures as known unchanged', async () => {
    const f = await fixture(), before = await f.workspace.read('alice', DOMAIN)
    f.validator.check.mockRejectedValueOnce(new Error('parser unavailable'))
    await expect(f.workspace.save('alice', DOMAIN, 'RewriteEngine On\n', before.document.revision)).rejects.toMatchObject({ detail: { stateChanged: false } })
    f.probe.mockRejectedValueOnce(new Error('probe unavailable'))
    await expect(f.workspace.save('alice', DOMAIN, 'RewriteEngine On\n', before.document.revision)).rejects.toMatchObject({ detail: { stateChanged: false } }); expect(f.checked).not.toHaveBeenCalled()
  })
})
it('carries exact checked preimage/removal internally and rejects traversal', async () => {
  const calls: AccountFileRequest[] = [], runner = { run: async (_context: AccountFileContext, request: Readonly<AccountFileRequest>) => { calls.push(request); return null } }
  const manager = new JailedFileManager('/home/alice', 'unlimited', { account: { username: 'alice', home: '/home/alice', uid: 1001, gid: 1001 }, runner })
  const expected: FileText = { path: target.path, content: '# old\n', sizeBytes: 6, mtime: '2026-10-26T12:00:00.000Z' }
  await manager.writeTextChecked(target.path, null, expected)
  expect(calls[0]).toMatchObject({ op: 'write-checked', remove: true, content: '', expectedExists: true, expectedContent: expected.content, expectedMtime: expected.mtime })
  await expect(manager.writeTextChecked('../.htaccess', null, expected)).rejects.toThrow()
})
it('uses loopback and the authoritative Host without following redirects', async () => {
  let host = '', forwarded = ''
  const server = createServer((request, response) => { host = request.headers.host ?? ''; forwarded = String(request.headers['x-forwarded-proto']); response.writeHead(302, { location: 'http://unreachable.invalid/' }); response.end() })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try { const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing test port'); expect(await probeHtaccessTarget({ ...target, backendPort: address.port })).toBe(302); expect(host).toBe('example.test'); expect(forwarded).toBe('https') }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})
