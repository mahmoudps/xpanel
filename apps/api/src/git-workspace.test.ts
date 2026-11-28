import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Account } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import type { AccountSshPorts } from './account-ssh-workspace.ts'
import { GIT_WEBHOOK_INDEX_STATE, handleGitWebhookRoute, handleGitWorkspaceRoute, projectGitView } from './git-workspace.ts'

const account = { id: '11111111-1111-4111-8111-111111111111', username: 'alice', planId: 'plan', status: 'active' } as Account
const caller = { principal: { kind: 'user', id: 'principal', username: 'alice', accountId: account.id }, principalRecord: {}, apiTokenId: null, scopes: [] } as unknown as AuthenticatedCaller
const hash = 'a'.repeat(40)
const view = (op = 'list') => ({ context: { accountId: account.id, username: 'alice' }, revision: 'a'.repeat(64), repositories: ['repo'], nativeAvailable: true, selected: op === 'list' ? null : { path: 'repo', branch: 'main', head: hash, dirty: false, changedFiles: 0, remote: 'https://example.com/site.git', branches: [{ name: 'main', hash, current: true }], commits: [{ hash, at: '2026-10-27T00:00:00+00:00', subject: 'Saved commit' }] }, application: { op, state: op === 'list' || op === 'inspect' ? 'read' : 'verified', verificationRequired: false } })
function setup() {
  let disabled: string[] = [], current = caller
  const readAgent = vi.fn(async (_caller: unknown, _path: string, input?: unknown) => view(input ? (input as { op: string }).op : 'list'))
  const ports: AccountSshPorts = { store: { getAccount: async () => account, getPlan: async () => ({ featureListId: 'features' }), getFeatureList: async () => ({ disabled }) } as unknown as StateStore, requireCaller: async () => current, readAgent: readAgent as unknown as AccountSshPorts['readAgent'] }
  const route = (method = 'GET', body?: unknown, search = '') => { const url = new URL('http://panel.test/api/account/git' + search); return handleGitWorkspaceRoute(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), url, method, ports) }
  return { ports, readAgent, route, disable: () => { disabled = ['git-version-control'] }, foreign: () => { current = { ...caller, principal: { kind: 'root', id: 'root', username: 'root' } } } }
}
describe('account Git API boundary', () => {
  it('binds every dispatch to the current account and projects only the reviewed reply fields', async () => {
    const t = setup(), response = await t.route('POST', { op: 'inspect', path: 'repo' })
    expect((await response!.json()).selected).toMatchObject({ path: 'repo', branch: 'main', head: hash })
    expect(t.readAgent.mock.calls[0]!.slice(1)).toEqual(['/accounts/alice/git', { op: 'inspect', path: 'repo' }, false, 'POST'])
    expect(projectGitView({ ...view(), secret: 'discard' }, account, { op: 'list' })).not.toHaveProperty('secret')
  })
  it('refuses unowned, disabled and selector-injected requests before the agent', async () => {
    const t = setup(); await expect(t.route('GET', undefined, '?accountId=foreign')).rejects.toMatchObject({ code: 'VALIDATION' }); expect(t.readAgent).not.toHaveBeenCalled()
    t.disable(); await expect(t.route()).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(t.readAgent).not.toHaveBeenCalled()
    const other = setup(); other.foreign(); await expect(other.route()).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(other.readAgent).not.toHaveBeenCalled()
  })
  it('rechecks feature revocation after an await instead of releasing stale protected data', async () => {
    const t = setup(); t.readAgent.mockImplementation(async () => { t.disable(); return view() })
    await expect(t.route()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: false } })
  })
  it('reports an unverifiable mutation response as uncertain', async () => {
    const t = setup(); t.readAgent.mockImplementation(async () => ({ ...view('pull'), context: { accountId: 'foreign', username: 'alice' } }))
    await expect(t.route('POST', { op: 'pull', path: 'repo', expectedHead: hash, expectedRevision: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, unknownOutcome: true, verificationRequired: true } })
  })
  it('refuses incoherent branch, head, history, path and registry acknowledgements', () => {
    const valid = view('inspect'), selected = valid.selected!
    for (const raw of [{ ...valid, selected: { ...selected, path: 'foreign' } }, { ...valid, selected: { ...selected, branches: [] } }, { ...valid, selected: { ...selected, commits: [{ ...selected.commits[0], hash: 'b'.repeat(40) }] } }, { ...valid, selected: { ...selected, dirty: true } }, { ...valid, nativeAvailable: false }]) expect(() => projectGitView(raw, account, { op: 'inspect', path: 'repo' })).toThrow()
    expect(() => projectGitView({ ...view('remove'), selected: null }, account, { op: 'remove', path: 'repo', expectedRevision: 'a'.repeat(64) })).toThrow()
  })
  it('projects deployment release history, rollback target and webhook info', () => {
    const second = 'b'.repeat(40)
    const rollbackView = {
      ...view('rollback'),
      deployed: { commit: second, at: '2026-11-08T10:00:00.000Z', op: 'rollback' as const },
      releases: [
        { commit: second, at: '2026-11-08T10:00:00.000Z', op: 'rollback' as const },
        { commit: hash, at: '2026-11-07T10:00:00.000Z', op: 'deploy' as const },
      ],
      webhook: { configured: true, url: '/api/account/git/webhook/0123456789abcdef', updatedAt: '2026-11-07T10:00:00.000Z' },
    }
    const projected = projectGitView(rollbackView, account, { op: 'rollback', path: 'repo', targetCommit: second, expectedRevision: 'a'.repeat(64) })
    expect(projected.deployed).toEqual({ commit: second, at: '2026-11-08T10:00:00.000Z', op: 'rollback' })
    expect(projected.releases).toHaveLength(2)
    expect(projected.webhook?.configured).toBe(true)
    expect(() => projectGitView({ ...rollbackView, deployed: { commit: hash, at: '2026-11-08T10:00:00.000Z', op: 'rollback' } }, account, { op: 'rollback', path: 'repo', targetCommit: second, expectedRevision: 'a'.repeat(64) })).toThrow()
  })

  it('indexes rotated webhooks, removes on delete, and dispatches POST /api/account/git/webhook/<id> with token verification and rate limit', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'xp-git-hook-'))
    try {
      const hookId = '0123456789abcdef'
      const rateHookId = 'fedcba9876543210'
      const hookToken = 'w'.repeat(48)
      const lease = { assertFencingToken: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }
      let disabled: string[] = []
      const readAgent = vi.fn(async (_caller: unknown, path: string, input?: unknown) => {
        if (path === '/accounts/alice/git/webhook') return { ok: true, path: 'repo', deployed: { commit: hash, at: '2026-11-28T09:00:00.000Z', op: 'deploy' } }
        const op = input ? (input as { op: string }).op : 'list'
        if (op === 'webhook-rotate') {
          return { ...view('webhook-rotate'), webhook: { configured: true, url: '/api/account/git/webhook/' + hookId + '?token=' + hookToken, updatedAt: '2026-11-28T08:00:00.000Z' } }
        }
        return op === 'remove' ? { ...view('remove'), selected: null, revision: 'b'.repeat(64), repositories: [] } : view(op)
      })
      const store = {
        rootDir,
        getWriterLock: () => ({ acquire: async () => lease }),
        getAccount: async (id: string) => id === account.id ? { ...account, shell: 'jailed' } : null,
        getPlan: async () => ({ featureListId: 'features' }),
        getFeatureList: async () => ({ disabled }),
      } as unknown as StateStore
      const ports: AccountSshPorts = { store, requireCaller: async () => caller, readAgent: readAgent as unknown as AccountSshPorts['readAgent'] }
      const rotated = await handleGitWorkspaceRoute(
        new Request('http://panel.test/api/account/git', { method: 'POST', body: JSON.stringify({ op: 'webhook-rotate', path: 'repo', expectedRevision: 'a'.repeat(64) }) }),
        new URL('http://panel.test/api/account/git'),
        'POST',
        ports,
      )
      expect(rotated!.status).toBe(200)
      const indexAfterRotate = JSON.parse(await readFile(join(rootDir, GIT_WEBHOOK_INDEX_STATE), 'utf8')) as { version: number; hooks: Record<string, { accountId: string; path: string }> }
      expect(indexAfterRotate.hooks[hookId]).toMatchObject({ accountId: account.id, path: 'repo' })

      const emitAudit = vi.fn(async () => undefined)
      const webhookPorts = {
        store,
        readAgent: readAgent as unknown as AccountSshPorts['readAgent'],
        findAccountPrincipal: async () => ({ id: 'principal', username: 'alice', kind: 'user', disabled: false, accountId: account.id }),
        emitAudit,
        now: () => new Date('2026-11-28T09:00:00.000Z'),
      }
      const callHook = (path: string, method = 'POST', headers: Record<string, string> = {}) =>
        handleGitWebhookRoute(new Request('http://panel.test' + path, { method, headers }), new URL('http://panel.test' + path), method, webhookPorts)

      expect((await callHook('/api/account/git/webhook/' + hookId, 'GET')).status).toBe(405)
      expect((await callHook('/api/account/git/webhook/0000000000000000?token=' + hookToken)).status).toBe(403)
      expect((await callHook('/api/account/git/webhook/' + hookId)).status).toBe(403)
      const okQuery = await callHook('/api/account/git/webhook/' + hookId + '?token=' + hookToken)
      expect(okQuery.status).toBe(200)
      expect(readAgent).toHaveBeenLastCalledWith(expect.anything(), '/accounts/alice/git/webhook', { path: 'repo', webhookId: hookId, token: hookToken }, true, 'POST')

      const okHeader = await callHook('/api/account/git/webhook/' + hookId, 'POST', { 'x-git-webhook-token': hookToken })
      expect(okHeader.status).toBe(200)

      disabled = ['git-version-control']
      expect((await callHook('/api/account/git/webhook/' + hookId + '?token=' + hookToken)).status).toBe(403)
      disabled = []

      await writeFile(join(rootDir, GIT_WEBHOOK_INDEX_STATE), JSON.stringify({ version: 1, hooks: { ...indexAfterRotate.hooks, [rateHookId]: { accountId: account.id, path: 'repo', updatedAt: '2026-11-28T08:00:00.000Z' } } }))
      let lastStatus = 0
      for (let i = 0; i < 31; i++) {
        lastStatus = (await callHook('/api/account/git/webhook/' + rateHookId + '?token=' + hookToken)).status
      }
      expect(lastStatus).toBe(429)

      const removed = await handleGitWorkspaceRoute(
        new Request('http://panel.test/api/account/git', { method: 'POST', body: JSON.stringify({ op: 'remove', path: 'repo', expectedRevision: 'a'.repeat(64) }) }),
        new URL('http://panel.test/api/account/git'),
        'POST',
        ports,
      )
      expect(removed!.status).toBe(200)
      const indexAfterRemove = JSON.parse(await readFile(join(rootDir, GIT_WEBHOOK_INDEX_STATE), 'utf8')) as { hooks: Record<string, unknown> }
      expect(indexAfterRemove.hooks[hookId]).toBeUndefined()
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})
