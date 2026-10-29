import { describe, expect, it, vi } from 'vitest'
import type { Account } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import type { AccountSshPorts } from './account-ssh-workspace.ts'
import { handleGitWorkspaceRoute, projectGitView } from './git-workspace.ts'

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
})
