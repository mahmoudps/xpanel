import { describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { Account, Plan } from '@xpanel/core'
import type { FileEntry, FileText } from './file-manager.ts'
import { GIT_REGISTRY, handleAccountGitRoute, parseGitBranches, parseGitHistory, parseGitRequest, parseSafeGitConfig, runGitRequest } from './account-git.ts'
import type { AccountGitRouteDeps, GitRequest } from './account-git.ts'
import type { AccountGitRun } from './account-git-runner.ts'

const account = { id: '11111111-1111-4111-8111-111111111111', username: 'alice', planId: 'plan', status: 'active', uid: 1001, gid: 1001, home: '/home/alice' } as Account
const hash = 'a'.repeat(40), other = 'b'.repeat(40), config = 'core.repositoryformatversion\n0\0core.bare\nfalse\0remote.origin.url\nhttps://example.com/site.git\0'
const entry = (name: string, kind: FileEntry['kind'] = 'directory'): FileEntry => ({ name, path: name, kind, mode: 0o750, sizeBytes: 0, mtime: new Date(0).toISOString() })
function setup(paths = ['repo']) {
  let tick = 0, branch = 'main', dirty = false, malformed = false
  const tree = new Map<string, FileEntry[]>([['', [entry('repo'), entry(GIT_REGISTRY, 'file')]], ['repo', [entry('.git')]], ['repo/.git', [entry('config', 'file')]]])
  let file: FileText = { path: GIT_REGISTRY, content: JSON.stringify(paths) + '\n', sizeBytes: 10, mtime: new Date(0).toISOString() }
  const files = {
    list: vi.fn(async (path: string) => tree.get(path) ?? []), readText: vi.fn(async () => ({ ...file })),
    writeTextChecked: vi.fn(async (_path: string, content: string | null, expected: FileText | null) => { if (JSON.stringify(file) !== JSON.stringify(expected)) return fail('CONFLICT', 'changed', { stateChanged: false }); file = { ...file, content: content!, mtime: new Date(++tick * 1000).toISOString() }; return entry(GIT_REGISTRY, 'file') }),
    mkdir: vi.fn(async (path: string) => { tree.get('')!.push(entry(path)); tree.set(path, []); return entry(path) }),
  }
  const run = vi.fn(async (_account: Account, path: string, operation: Parameters<AccountGitRun>[2]) => {
    let stdout = ''
    if (operation.op === 'config') stdout = malformed ? 'include.path\n/etc/gitconfig\0' : config
    if (operation.op === 'head') stdout = branch + '\n'
    if (operation.op === 'branches') stdout = 'main\t' + hash + '\t' + (branch === 'main' ? '*' : ' ') + '\nrelease\t' + other + '\t' + (branch === 'release' ? '*' : ' ') + '\n'
    if (operation.op === 'history') stdout = (branch === 'main' ? hash : other) + '\t2026-10-27T01:00:00+00:00\tSaved commit\n'
    if (operation.op === 'status') stdout = dirty ? ' M index.html\n' : ''
    if (operation.op === 'checkout') branch = operation.branch
    if (operation.op === 'init') { branch = operation.branch; tree.set(path, [entry('.git')]); tree.set(path + '/.git', [entry('config', 'file')]) }
    return { ok: true, code: 0, stdout, stderr: '' }
  })
  const authorize = vi.fn(async () => undefined)
  const request = (request: GitRequest, native: AccountGitRun | null = run) => runGitRequest({ account, files, run: native, request, authorize })
  return { request, files, run, authorize, tree, setDirty: () => { dirty = true }, malformed: () => { malformed = true }, file: () => file }
}
describe('protected account Git workspace', () => {
  it('strictly parses operation selectors and output, refusing executable config and metadata', () => {
    expect(parseGitRequest('GET')).toEqual({ op: 'list' })
    for (const raw of [{ op: 'list' }, { op: 'inspect', path: '../bob' }, { op: 'inspect', path: 'repo', accountId: 'bob' }, { op: 'pull', path: 'repo', expectedRevision: 'a'.repeat(64), expectedHead: 'HEAD' }]) expect(() => parseGitRequest('POST', raw)).toThrow()
    expect(() => parseGitRequest('DELETE', { op: 'inspect', path: 'repo' })).toThrow()
    expect(parseSafeGitConfig(config).remote).toBe('https://example.com/site.git')
    for (const text of ['include.path\n/tmp/config\0', 'core.hooksPath\n/tmp/hooks\0', 'filter.lfs.smudge\nsh\0', 'core.bare\ntrue\0', 'remote.origin.url\nfile:///etc\0']) expect(() => parseSafeGitConfig(text)).toThrow()
    expect(() => parseGitBranches('main\tbad\t*\n')).toThrow(); expect(() => parseGitHistory(hash + '\t2026-10-27T01:00:00+00:00\tbad\u202e\n')).toThrow()
  })
  it('lists and removes only the saved entry while native Git is unavailable', async () => {
    const t = setup(), read = await t.request({ op: 'list' }, null)
    expect(read.nativeAvailable).toBe(false)
    const removed = await t.request({ op: 'remove', path: 'repo', expectedRevision: read.revision }, null)
    expect(removed.repositories).toEqual([]); expect(removed.application.state).toBe('verified'); expect(t.files.mkdir).not.toHaveBeenCalled(); expect(t.run).not.toHaveBeenCalled()
    expect(t.tree.get('repo')).toEqual([entry('.git')])
  })
  it('inspects real command-shaped output and switches only an existing branch with captured clean HEAD', async () => {
    const t = setup(), read = await t.request({ op: 'list' }), details = await t.request({ op: 'inspect', path: 'repo' })
    expect(details.selected).toMatchObject({ branch: 'main', head: hash, dirty: false, commits: [{ hash }] })
    const changed = await t.request({ op: 'checkout', path: 'repo', branch: 'release', expectedHead: hash, expectedRevision: read.revision })
    expect(changed.selected).toMatchObject({ branch: 'release', head: other }); expect(t.authorize.mock.calls.length).toBeGreaterThan(5)
  })
  it('refuses stale revision, dirty files, changed HEAD, unsafe config and linked metadata before writes', async () => {
    const t = setup(), read = await t.request({ op: 'list' })
    await expect(t.request({ op: 'remove', path: 'repo', expectedRevision: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'CONFLICT' })
    const body = { op: 'pull', path: 'repo', expectedHead: hash, expectedRevision: read.revision } as const
    await expect(t.request({ ...body, expectedHead: other })).rejects.toMatchObject({ code: 'CONFLICT' })
    t.setDirty(); await expect(t.request(body)).rejects.toMatchObject({ code: 'CONFLICT' })
    t.malformed(); await expect(t.request(body)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    t.tree.set('repo', [entry('.git', 'symlink')]); await expect(t.request({ op: 'inspect', path: 'repo' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(t.run.mock.calls.some(call => call[2].op === 'pull')).toBe(false)
  })
  it('marks a failed attempted native mutation uncertain without pretending registration succeeded', async () => {
    const t = setup(), read = await t.request({ op: 'list' })
    const failed: AccountGitRun = async () => ({ ok: false, code: 1, stdout: '', stderr: 'failure' })
    await expect(t.request({ op: 'clone', path: 'new', url: 'https://example.com/site.git', expectedRevision: read.revision }, failed)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, unknownOutcome: true, verificationRequired: true } })
    expect(t.files.writeTextChecked).not.toHaveBeenCalled(); expect(JSON.parse(t.file().content)).toEqual(['repo'])
  })
  it('rechecks clean HEAD at the write boundary and stops on fresh revocation before any native write', async () => {
    const t = setup(), read = await t.request({ op: 'list' })
    let statusReads = 0
    const raced: AccountGitRun = async (a, path, operation) => { const result = await t.run(a, path, operation); if (operation.op === 'status' && ++statusReads === 2) result.stdout = ' M index.html\n'; return result }
    await expect(t.request({ op: 'pull', path: 'repo', expectedHead: hash, expectedRevision: read.revision }, raced)).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    expect(t.run.mock.calls.some(call => call[2].op === 'pull')).toBe(false)
    t.authorize.mockImplementation(async () => fail('FORBIDDEN', 'revoked', { stateChanged: false }))
    await expect(t.request({ op: 'remove', path: 'repo', expectedRevision: read.revision })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(t.files.writeTextChecked).not.toHaveBeenCalled()
  })
  it('checks current principal, feature and account lifecycle identity under the lease', async () => {
    const t = setup(), principal = { kind: 'user', id: 'principal', accountId: account.id, username: 'alice', disabled: false }
    let disabled: string[] = [], leases = 0
    const deps: AccountGitRouteDeps = { caller: { role: 'user', actor: 'user:alice', principalId: 'principal', accountId: account.id, resellerId: null },
      store: { getAccountByUsername: async () => account, getPlan: async () => ({ id: 'plan', featureListId: 'features' }) as Plan, getFeatureList: async () => ({ id: 'features', name: 'features', ownerId: null, disabled }), withAccountLifecycleLease: async (_id, action) => { leases++; return action(account) } },
      currentPrincipal: async () => principal, files: () => t.files, run: null, audit: vi.fn(async () => undefined) }
    const url = new URL('http://agent/accounts/alice/git'), route = () => handleAccountGitRoute(new Request(url), url, 'GET', deps)
    expect((await route())!.status).toBe(200); expect(leases).toBe(1)
    disabled = ['git-version-control']; await expect(route()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    disabled = []; principal.disabled = true; await expect(route()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    principal.disabled = false; principal.accountId = 'foreign'; await expect(route()).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
