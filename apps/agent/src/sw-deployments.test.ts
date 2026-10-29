import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { Account, FeatureList, Plan } from '@xpanel/core'
import type { FileEntry, FileText } from './file-manager.ts'
import { GIT_REGISTRY } from './account-git.ts'
import type { AccountGitRun } from './account-git-runner.ts'
import { handleSwDeploymentsRoute } from './sw-deployments.ts'
import type { SwDeploymentsContext } from './sw-deployments.ts'

const alice = { id: '11111111-1111-4111-8111-111111111111', username: 'alice', planId: 'plan', status: 'active', uid: 1001, gid: 1001, home: '/home/alice' } as Account
const bob = { ...alice, id: '22222222-2222-4222-8222-222222222222', username: 'bob', planId: 'nogit' } as Account
const old = 'a'.repeat(40), next = 'c'.repeat(40), config = 'core.repositoryformatversion\n0\0core.bare\nfalse\0remote.origin.url\nhttps://example.com/site.git\0'
const entry = (name: string, kind: FileEntry['kind'] = 'directory'): FileEntry => ({ name, path: name, kind, mode: 0o750, sizeBytes: 0, mtime: new Date(0).toISOString() })
const fixture = (overrides: Partial<SwDeploymentsContext> = {}) => {
  let head = old, dirty = false, actor = 'root'
  const tree = new Map<string, FileEntry[]>([['', [entry('site'), entry(GIT_REGISTRY, 'file')]], ['site', [entry('.git')]], ['site/.git', [entry('config', 'file')]]])
  const registry: FileText = { path: GIT_REGISTRY, content: JSON.stringify(['site']) + '\n', sizeBytes: 9, mtime: new Date(0).toISOString() }
  const files = { list: vi.fn(async (path: string) => tree.get(path) ?? []), readText: vi.fn(async () => ({ ...registry })), writeTextChecked: vi.fn(), mkdir: vi.fn() }
  const run = vi.fn(async (_account: Account, _path: string, operation: Parameters<AccountGitRun>[2]) => {
    const stdout = operation.op === 'config' ? config : operation.op === 'head' ? 'main\n' : operation.op === 'branches' ? 'main\t' + head + '\t*\n' : operation.op === 'history' ? head + '\t2026-10-28T01:00:00+00:00\tRelease\n' : operation.op === 'status' ? (dirty ? ' M index.html\n' : '') : ''
    if (operation.op === 'pull') head = next
    return { ok: true, code: 0, stdout, stderr: '' }
  })
  const audit = vi.fn(async () => {})
  const ctx: SwDeploymentsContext = {
    assertRoot: async () => ({ actor }), files: () => files as never, run, audit,
    store: { listAccounts: async () => [bob, alice], getAccountByUsername: async name => [alice, bob].find(item => item.username === name) ?? null, getPlan: async id => ({ id, featureListId: id }) as Plan,
      getFeatureList: async id => ({ id, disabled: id === 'nogit' ? ['git-version-control'] : [] }) as unknown as FeatureList, withAccountLifecycleLease: async (id, operation) => operation([alice, bob].find(item => item.id === id)!) },
    ...overrides,
  }
  return { ctx, run, audit, files, setDirty: () => { dirty = true }, switchActor: () => { actor = 'other' } }
}
const call = async (ctx: SwDeploymentsContext, path: string, body?: unknown) => { const url = new URL('http://agent.local' + path); return handleSwDeploymentsRoute(new Request(url, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), url, body === undefined ? 'GET' : 'POST', ctx) }
const revision = createHash('sha256').update(JSON.stringify(['site']) + '\n').digest('hex')

describe('account Git deployments for root', () => {
  it('lists active accounts with plan Git permission and reads one account registry under its lease', async () => {
    const { ctx } = fixture()
    const all = await (await call(ctx, '/host/software/deployments'))!.json() as any
    expect(all.accounts).toEqual([{ username: 'alice', gitAllowed: true }, { username: 'bob', gitAllowed: false }]); expect(all.selected).toBeNull()
    const one = await (await call(ctx, '/host/software/deployments?account=alice'))!.json() as any
    expect(one.selected.repositories).toEqual(['site']); expect(one.selected.revision).toBe(revision)
    await expect(call(ctx, '/host/software/deployments?account=bob')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(call(ctx, '/host/software/deployments?account=../x')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call(ctx, '/host/software/deployments?account=alice&path=site')).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(call(fixture({ files: null }).ctx, '/host/software/deployments?account=alice')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('deploys with a fast-forward pull only for the reviewed commit and audits the verified result', async () => {
    const { ctx, run, audit } = fixture()
    const inspected = await (await call(ctx, '/host/software/deployments/inspect', { account: 'alice', path: 'site' }))!.json() as any
    expect(inspected.selected.selected).toMatchObject({ path: 'site', head: old, dirty: false, remote: 'https://example.com/site.git' })
    await expect(call(ctx, '/host/software/deployments/pull', { account: 'alice', path: 'site', expectedHead: 'b'.repeat(40), expectedRevision: revision })).rejects.toMatchObject({ code: 'CONFLICT' })
    const deployed = await (await call(ctx, '/host/software/deployments/pull', { account: 'alice', path: 'site', expectedHead: old, expectedRevision: revision }))!.json() as any
    expect(deployed.selected.selected.head).toBe(next); expect(run.mock.calls.some(call => call[2].op === 'pull')).toBe(true)
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'software.deployment.pull', outcome: 'ok', detail: { path: 'site', head: next } }))
  })
  it('refuses dirty trees, missing runners, extra fields and changed authority', async () => {
    const dirty = fixture(); dirty.setDirty()
    await expect(call(dirty.ctx, '/host/software/deployments/pull', { account: 'alice', path: 'site', expectedHead: old, expectedRevision: revision })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(dirty.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed' }))
    await expect(call(fixture({ run: null }).ctx, '/host/software/deployments/inspect', { account: 'alice', path: 'site' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(call(fixture().ctx, '/host/software/deployments/inspect', { account: 'alice', path: 'site', url: 'https://evil.test' })).rejects.toMatchObject({ code: 'VALIDATION' })
    const changed = fixture(); const first = changed.ctx.assertRoot; let calls = 0
    changed.ctx.assertRoot = async action => (++calls > 1 ? { actor: 'other' } : first(action))
    await expect(call(changed.ctx, '/host/software/deployments?account=alice')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
