import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { createLifecycleHooks, handleHooksRoute } from './hooks-workspace.ts'
import type { HookHost, HooksView, HooksWorkspaceHelpers } from './hooks-workspace.ts'

const ROOT = { principal: { id: '11111111-1111-4111-8111-111111111111', kind: 'root', username: 'root' }, sessionId: 's1', apiTokenId: null } as AuthenticatedCaller
const RESELLER = { principal: { id: '22222222-2222-4222-8222-222222222222', kind: 'reseller', username: 'reseller1' }, sessionId: 's2', apiTokenId: null } as AuthenticatedCaller
const DIR = '/usr/local/libexec/xpanel/hooks'
const SHA = 'a'.repeat(64)
const account = { id: '33333333-3333-4333-8333-333333333333', username: 'alice', primaryDomain: 'alice.example.test', planId: '44444444-4444-4444-8444-444444444444' }
const { planId: _plan, ...hookAccount } = account
let root = ''
function harness(callHost?: HookHost, caller = ROOT) {
  const lease = { assertFencingToken: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }
  const store = { rootDir: root, getWriterLock: () => ({ acquire: async () => lease }) } as unknown as HooksWorkspaceHelpers['store']
  const helpers = { requireCaller: vi.fn(async () => caller), emitAudit: vi.fn(async () => undefined), now: () => new Date('2026-11-07T08:00:00.000Z'), store, ...(callHost ? { callHost } : {}),
    assertRoot: vi.fn(async (who: AuthenticatedCaller) => { if (who.principal.kind !== 'root') fail('FORBIDDEN', 'root role is required') }) } as unknown as HooksWorkspaceHelpers
  const send = async (method: string, path = '/api/server/hooks', body?: unknown) => {
    const response = await handleHooksRoute(new Request('http://api.test' + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), new URL('http://api.test' + path), method, helpers)
    return response
  }
  const read = async () => (await (await send('GET'))!.json()) as HooksView
  return { helpers, send, read, store }
}
const reviewed: HookHost = async (_caller, path, body) => path === '/host/hooks/inspect' ? { executable: (body as { executable: string }).executable, state: 'reviewed', sha256: SHA, bytes: 20 } : { directory: DIR, hooks: [] }
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'xp-hooks-api-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('hooks workspace', { tags: ['unit'] }, () => {
  it('registers a reviewed executable with its pinned digest, then enables, reorders within its event and deletes', async () => {
    const h = harness(reviewed)
    const first = await h.read()
    expect(first).toMatchObject({ state: 'default', hooks: [], directory: DIR, observation: { state: 'read', hooks: [] } })
    expect(first.points.map(point => point.point)).toEqual(['account.create', 'account.suspend', 'account.unsuspend', 'account.terminate'])
    const register = async (name: string, revision: string, extra: Record<string, unknown> = {}) => (await (await h.send('POST', undefined, { point: 'account.suspend', stage: 'pre', executable: `${DIR}/${name}`, expectedRevision: revision, ...extra }))!.json()) as HooksView
    const one = await register('one', first.revision, { blocking: true, args: ['--strict'] })
    expect(one.hooks).toEqual([expect.objectContaining({ executable: DIR + '/one', sha256: SHA, args: ['--strict'], timeoutSeconds: 10, enabled: true, blocking: true, description: '' })])
    const post = await register('post', one.revision, { stage: 'post' })
    const two = await register('two', post.revision)
    const [a, b, c] = two.hooks!
    expect(h.helpers.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.hook.registered', target: 'hook:' + a!.id, detail: expect.objectContaining({ sha256: SHA, blocking: true }) }))
    const moved = (await (await h.send('POST', `/api/server/hooks/${c!.id}/move`, { direction: 'up', expectedRevision: two.revision }))!.json()) as HooksView
    // The post-stage hook between them is not a peer, so the two pre-stage hooks swap places around it.
    expect(moved.hooks!.map(hook => hook.id)).toEqual([c!.id, b!.id, a!.id])
    await expect(h.send('POST', `/api/server/hooks/${c!.id}/move`, { direction: 'up', expectedRevision: moved.revision })).rejects.toMatchObject({ code: 'CONFLICT' })
    const disabled = (await (await h.send('PATCH', `/api/server/hooks/${a!.id}`, { enabled: false, expectedRevision: moved.revision }))!.json()) as HooksView
    expect(disabled.hooks!.find(hook => hook.id === a!.id)!.enabled).toBe(false)
    const removed = (await (await h.send('DELETE', `/api/server/hooks/${b!.id}`, { expectedRevision: disabled.revision }))!.json()) as HooksView
    expect(removed.hooks!.map(hook => hook.id)).toEqual([c!.id, a!.id])
    expect(JSON.parse(await readFile(join(root, 'extended', 'panel', 'hooks.json'), 'utf8')).hooks).toHaveLength(2)
    await expect(h.send('PATCH', `/api/server/hooks/${a!.id}`, { enabled: true, expectedRevision: two.revision })).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('refuses unreviewed paths, refused files, post-stage blocking, resellers and registration without the agent', async () => {
    const refused: HookHost = async (_caller, _path, body) => ({ executable: (body as { executable: string }).executable, state: 'refused', reason: 'hook_executable_mode' })
    const { revision } = await harness(reviewed).read()
    const body = { point: 'account.suspend', stage: 'pre', executable: DIR + '/one', expectedRevision: revision }
    await expect(harness(reviewed).send('POST', undefined, { ...body, executable: '/usr/bin/id' })).rejects.toMatchObject({ code: 'VALIDATION', detail: { reason: 'hook_path_not_reviewed' } })
    await expect(harness(reviewed).send('POST', undefined, { ...body, stage: 'post', blocking: true })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(harness(reviewed).send('POST', undefined, { ...body, point: 'account.create' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(harness(refused).send('POST', undefined, body)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'hook_executable_mode' } })
    await expect(harness().send('POST', undefined, body)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'hooks_unavailable' } })
    await expect(harness(reviewed, RESELLER).send('GET')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await harness().read()).observation).toEqual({ state: 'unavailable', hooks: [] })
  })

  it('blocks an action only when a pre-stage blocking hook refused it or could not run', async () => {
    const h = harness(reviewed)
    const view = (await (await h.send('POST', undefined, { point: 'account.suspend', stage: 'pre', executable: DIR + '/gate', blocking: true, expectedRevision: (await h.read()).revision }))!.json()) as HooksView
    const runs: unknown[] = []
    const host = (blocked: string | null): HookHost => async (_caller, path, body) => { runs.push([path, body]); return { results: [], blocked } }
    const emitAudit = vi.fn(async () => undefined)
    await expect(createLifecycleHooks({ store: h.store, callHost: host(null), emitAudit }).before('account.suspend', account, ROOT)).resolves.toBeUndefined()
    expect(runs).toEqual([['/host/hooks/run', { point: 'account.suspend', stage: 'pre', account: hookAccount, enhancements: {} }]])
    await mkdir(join(root, 'extended/plans'), { recursive: true })
    await writeFile(join(root, 'extended/plans/enhancements.json'), JSON.stringify({ definitions: [{ id: 'priority-support', label: 'Priority support', kind: 'flag', min: null, max: null }, { id: 'extra-sites', label: 'Extra sites', kind: 'limit', min: 0, max: 9 }],
      planAssignments: { [account.planId]: { 'extra-sites': 1 } }, accountAssignments: { [account.id]: { 'extra-sites': 3, 'priority-support': true } }, resellerLimits: {} }))
    runs.length = 0
    await createLifecycleHooks({ store: h.store, callHost: host(null), emitAudit }).before('account.suspend', account, ROOT)
    expect(runs).toEqual([['/host/hooks/run', expect.objectContaining({ enhancements: { 'extra-sites': 3, 'priority-support': true } })]])
    await writeFile(join(root, 'extended/plans/enhancements.json'), '{"definitions":"tampered"}')
    runs.length = 0
    await createLifecycleHooks({ store: h.store, callHost: host(null), emitAudit }).before('account.suspend', account, ROOT)
    expect(runs).toEqual([['/host/hooks/run', expect.objectContaining({ enhancements: null })]])
    await rm(join(root, 'extended/plans/enhancements.json'))
    await expect(createLifecycleHooks({ store: h.store, callHost: host(view.hooks![0]!.id), emitAudit }).before('account.suspend', account, ROOT))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'hook_blocked', hookId: view.hooks![0]!.id, stateChanged: false } })
    await expect(createLifecycleHooks({ store: h.store, emitAudit }).before('account.suspend', account, ROOT)).rejects.toMatchObject({ detail: { reason: 'hooks_unavailable' } })
    expect(emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.hook.ran', outcome: 'failed', detail: expect.objectContaining({ reason: 'hooks_unavailable' }) }))
    runs.length = 0
    await createLifecycleHooks({ store: h.store, callHost: host(null), emitAudit }).before('account.unsuspend', account, ROOT)
    expect(runs).toEqual([])
    await h.send('PATCH', `/api/server/hooks/${view.hooks![0]!.id}`, { enabled: false, expectedRevision: view.revision })
    await createLifecycleHooks({ store: h.store, emitAudit }).before('account.suspend', account, ROOT)
  })
})
