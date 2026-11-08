import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthenticatedCaller } from './auth.ts'
import { handleLeechProtectionRoute, validateLeechAgentView } from './leech-protection-workspace.ts'
import type { LeechProtectionPorts } from './leech-protection-workspace.ts'
import { leechStatePath } from '../../agent/src/leech-protection.ts'

const ACCOUNT = { id: '22222222-2222-4222-8222-222222222222', username: 'alice', status: 'active', planId: 'p' }
const OWNER = { principal: { kind: 'user', id: '33333333-3333-4333-8333-333333333333', username: 'alice', accountId: ACCOUNT.id }, sessionId: 'two', apiTokenId: null, scopes: [], principalRecord: {} } as unknown as AuthenticatedCaller
const ROOT = { principal: { kind: 'root', id: '11111111-1111-4111-8111-111111111111', username: 'root' }, sessionId: 'one', apiTokenId: null, scopes: [], principalRecord: {} } as unknown as AuthenticatedCaller
const NOW = new Date('2026-11-07T10:00:00.000Z')
const FOLDER = { path: 'public_html/members', maxLogins: 4, redirectUrl: 'https://example.test/shared', alertEmail: null, disableUsers: false }
let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'xp-leech-api-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function harness(options: { caller?: AuthenticatedCaller; disabled?: string[]; reason?: 'engine' | 'monitor' | null } = {}) {
  const lease = { assertFencingToken: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }
  const agent = vi.fn(async (_caller: unknown, _path: string, input: { op: string; path?: string }) => ({
    context: { accountId: ACCOUNT.id, username: 'alice' }, capabilities: { canSave: !options.reason, reason: options.reason ?? null },
    folders: input.op === 'apply' && input.path === FOLDER.path ? [{ ...FOLDER, state: 'applied', flagged: [], disabled: [] }] : [] }))
  const ports = {
    requireCaller: vi.fn(async () => options.caller ?? OWNER), emitAudit: vi.fn(async () => undefined), readAgent: agent, now: () => NOW,
    store: { rootDir: root, getWriterLock: () => ({ acquire: async () => lease }), getAccount: async () => ACCOUNT, getPlan: async () => ({ featureListId: 'f' }), getFeatureList: async () => ({ disabled: options.disabled ?? [] }) },
  } as unknown as LeechProtectionPorts
  const send = async (method = 'GET', body?: unknown, path = '/api/account/leech-protection'): Promise<Record<string, any>> => {
    const response = await handleLeechProtectionRoute(new Request('http://api.test' + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), new URL('http://api.test' + path), method, ports)
    return response!.json()
  }
  return { ports, agent, send, lease }
}
const saved = async () => JSON.parse(await readFile(join(root, leechStatePath(ACCOUNT.id)), 'utf8'))

describe('leech protection workspace', () => {
  it('saves a folder under the revision, applies it through the agent and audits', async () => {
    const h = harness()
    const empty = await h.send()
    expect(empty).toMatchObject({ state: 'default', limit: 100, folders: [], capabilities: { canSave: true, reason: null } })
    const view = await h.send('POST', { expectedRevision: empty.revision, folder: FOLDER })
    expect(view).toMatchObject({ state: 'saved', updatedAt: NOW.toISOString(), folders: [{ path: FOLDER.path, state: 'applied' }] })
    expect(h.agent).toHaveBeenLastCalledWith(OWNER, '/accounts/alice/leech-protection', { op: 'apply', path: FOLDER.path }, true)
    expect(await saved()).toEqual({ version: 1, folders: [FOLDER], updatedAt: NOW.toISOString() })
    expect(h.ports.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'account.leech_protection.saved', target: 'account:alice', detail: { path: FOLDER.path, maxLogins: 4, disableUsers: false, alert: false } }))
    const removed = await h.send('POST', { expectedRevision: view.revision, remove: FOLDER.path })
    expect((await saved()).folders).toEqual([])
    expect(removed.state).toBe('saved')
    expect(h.ports.emitAudit).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'account.leech_protection.removed' }))
  })

  it('refuses a stale revision, bad fields and an unknown folder without writing', async () => {
    const h = harness()
    const empty = await h.send()
    await h.send('POST', { expectedRevision: empty.revision, folder: FOLDER })
    await expect(h.send('POST', { expectedRevision: empty.revision, folder: FOLDER })).rejects.toMatchObject({ code: 'CONFLICT' })
    const current = await h.send()
    await expect(h.send('POST', { expectedRevision: current.revision, folder: { ...FOLDER, maxLogins: 0 } })).rejects.toMatchObject({ code: 'VALIDATION', detail: { fields: [{ field: 'maxLogins', code: 'range' }] } })
    await expect(h.send('POST', { expectedRevision: current.revision, remove: 'public_html/none' })).rejects.toMatchObject({ code: 'VALIDATION', detail: { fields: [{ field: 'remove', code: 'not_found' }] } })
    await expect(h.send('POST', { expectedRevision: current.revision, remove: 'a', folder: FOLDER })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(h.send('POST', { folder: FOLDER })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await saved()).folders).toEqual([FOLDER])
  })

  it('reports an invalid saved file without asking the agent', async () => {
    const h = harness()
    await h.send('POST', { expectedRevision: (await h.send()).revision, folder: FOLDER })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(root, leechStatePath(ACCOUNT.id)), '{"version":2}')
    h.agent.mockClear()
    expect(await h.send()).toMatchObject({ state: 'invalid', folders: [], capabilities: { canSave: false } })
    expect(h.agent).not.toHaveBeenCalled()
    await expect(h.send('POST', { expectedRevision: (await h.send()).revision, folder: FOLDER })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })

  it('reports a failed apply after the save as needing review', async () => {
    const h = harness()
    const empty = await h.send()
    h.agent.mockRejectedValueOnce(new Error('agent down'))
    await expect(h.send('POST', { expectedRevision: empty.revision, folder: FOLDER })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: true, verificationRequired: true } })
    expect((await saved()).folders).toEqual([FOLDER])
  })

  it('serves the signed-in owner only, honours the plan and needs the agent', async () => {
    await expect(harness({ caller: ROOT }).send()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(harness({ disabled: ['leech-protection'] }).send()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(harness({ disabled: ['directory-privacy'] }).send()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const h = harness()
    await expect(h.send('GET', undefined, '/api/account/leech-protection?account=bob')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(await handleLeechProtectionRoute(new Request('http://api.test/other'), new URL('http://api.test/other'), 'GET', h.ports)).toBeNull()
    expect((await handleLeechProtectionRoute(new Request('http://api.test/api/account/leech-protection', { method: 'PUT' }), new URL('http://api.test/api/account/leech-protection'), 'PUT', h.ports))!.status).toBe(405)
    const offline = harness(); (offline.ports as { readAgent: unknown }).readAgent = null
    await expect(offline.send()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'host_agent_unavailable' } })
  })

  it('pins the agent reply', () => {
    const good = { context: { accountId: ACCOUNT.id, username: 'alice' }, capabilities: { canSave: true, reason: null }, folders: [{ ...FOLDER, state: 'applied', flagged: ['bob'], disabled: [] }] }
    expect(validateLeechAgentView(good, ACCOUNT)).toEqual(good)
    for (const bad of [null, { ...good, context: { accountId: 'other', username: 'alice' } }, { ...good, capabilities: { canSave: 'yes', reason: null } }, { ...good, folders: [{ ...good.folders[0], state: 'done' }] }, { ...good, folders: [{ ...good.folders[0], flagged: ['a b'] }] }, { ...good, folders: [{ ...good.folders[0], maxLogins: 0 }] }])
      expect(() => validateLeechAgentView(bad, ACCOUNT)).toThrow()
  })
})
