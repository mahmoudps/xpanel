import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { assertDemoModeAdmits, handleDemoModeRoute } from './demo-mode.ts'
import type { DemoModeHelpers, DemoModeView } from './demo-mode.ts'
import { panelConfigRevision } from './panel-config-file.ts'

const ROOT = { principal: { id: '11111111-1111-4111-8111-111111111111', kind: 'root', username: 'root' }, sessionId: 's1', apiTokenId: null } as AuthenticatedCaller
const RESELLER = { principal: { id: '22222222-2222-4222-8222-222222222222', kind: 'reseller', username: 'reseller1' }, sessionId: 's2', apiTokenId: null } as AuthenticatedCaller
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const user = (accountId: string) => ({ principal: { id: '33333333-3333-4333-8333-333333333333', kind: 'user', username: 'demo1', accountId }, sessionId: 's3', apiTokenId: null }) as AuthenticatedCaller
const stamp = '2026-11-07T08:00:00.000Z'
let root = ''
const accounts = [
  { id: B, username: 'bravo', primaryDomain: 'bravo.example.test', status: 'active' },
  { id: A, username: 'alpha', primaryDomain: 'alpha.example.test', status: 'suspended' },
  { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', username: 'gone', primaryDomain: 'gone.example.test', status: 'terminating' },
]
function harness(caller = ROOT) {
  const lease = { assertFencingToken: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }
  const store = { rootDir: root, getWriterLock: () => ({ acquire: async () => lease }), listAccounts: async () => accounts } as unknown as DemoModeHelpers['store']
  const helpers = { requireCaller: vi.fn(async () => caller), emitAudit: vi.fn(async () => undefined), now: () => new Date(stamp), store,
    assertRoot: vi.fn(async (who: AuthenticatedCaller) => { if (who.principal.kind !== 'root') fail('FORBIDDEN', 'root role is required') }) } as unknown as DemoModeHelpers
  const send = (method = 'GET', body?: unknown, path = '/api/server/demo-mode') => handleDemoModeRoute(new Request('http://api.test' + path, { method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), new URL('http://api.test' + path), method, helpers)
  const read = async () => (await (await send())!.json()) as DemoModeView
  return { helpers, send, read, store }
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'xp-demo-mode-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('demo mode workspace', { tags: ['unit'] }, () => {
  it('lists current accounts, saves a revision-bound list, reads it back and audits the change by username', async () => {
    const h = harness()
    const first = await h.read()
    expect(first).toEqual({ state: 'default', accountIds: [], updatedAt: null, revision: panelConfigRevision('demo-mode:v1', null),
      accounts: [{ id: A, username: 'alpha', primaryDomain: 'alpha.example.test', status: 'suspended' }, { id: B, username: 'bravo', primaryDomain: 'bravo.example.test', status: 'active' }] })
    const saved = await (await h.send('PUT', { accountIds: [B, A], expectedRevision: first.revision }))!.json() as DemoModeView
    expect(saved).toMatchObject({ state: 'saved', accountIds: [A, B], updatedAt: stamp })
    expect(await h.read()).toEqual(saved)
    expect(JSON.parse(await readFile(join(root, 'extended', 'panel', 'demo-mode.json'), 'utf8'))).toEqual({ version: 1, accountIds: [A, B], updatedAt: stamp })
    expect(h.helpers.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'server.demo_mode.updated', target: 'demo-mode', detail: { enabled: ['alpha', 'bravo'], disabled: [], demoAccounts: 2 } }))
    await expect(h.send('PUT', { accountIds: [], expectedRevision: first.revision })).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    const cleared = await (await h.send('PUT', { accountIds: [B], expectedRevision: saved.revision }))!.json() as DemoModeView
    expect(cleared.accountIds).toEqual([B])
    expect(h.helpers.emitAudit).toHaveBeenLastCalledWith(expect.objectContaining({ detail: { enabled: [], disabled: ['alpha'], demoAccounts: 1 } }))
  })

  it('is root only, strict about its body, and refuses unknown or terminating accounts', async () => {
    await expect(harness(RESELLER).send()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const h = harness(), { revision } = await h.read()
    await expect(h.send('GET', undefined, '/api/server/demo-mode?account=alpha')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await h.send('DELETE'))!.status).toBe(405)
    for (const body of [{ accountIds: [A] }, { accountIds: [A], expectedRevision: revision, extra: 1 }, { accountIds: [A, A], expectedRevision: revision }, { accountIds: ['alpha'], expectedRevision: revision }])
      await expect(h.send('PUT', body)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(h.send('PUT', { accountIds: ['cccccccc-cccc-4ccc-8ccc-cccccccccccc'], expectedRevision: revision })).rejects.toMatchObject({ code: 'VALIDATION', detail: { reason: 'unknown_account' } })
    expect(h.helpers.emitAudit).not.toHaveBeenCalled()
  })

  it('refuses every write of a demo account user, never root or resellers, and keeps sign-out open', async () => {
    const h = harness(), { revision } = await h.read()
    await h.send('PUT', { accountIds: [A], expectedRevision: revision })
    await expect(assertDemoModeAdmits(h.store, user(A), '/api/domains')).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { reason: 'demo_mode_readonly', stateChanged: false } })
    await expect(assertDemoModeAdmits(h.store, user(A), '/api/auth/logout')).resolves.toBeUndefined()
    await expect(assertDemoModeAdmits(h.store, user(B), '/api/domains')).resolves.toBeUndefined()
    await expect(assertDemoModeAdmits(h.store, ROOT, '/api/accounts')).resolves.toBeUndefined()
    await expect(assertDemoModeAdmits(h.store, RESELLER, '/api/accounts')).resolves.toBeUndefined()
  })

  it('refuses user writes while the saved list cannot be verified', async () => {
    const h = harness()
    await mkdir(join(root, 'extended', 'panel'), { recursive: true })
    await writeFile(join(root, 'extended', 'panel', 'demo-mode.json'), JSON.stringify({ version: 1, accountIds: ['not-an-id'], updatedAt: stamp }))
    expect((await h.read()).state).toBe('invalid')
    await expect(assertDemoModeAdmits(h.store, user(B), '/api/domains')).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { reason: 'demo_mode_unverified' } })
    await expect(assertDemoModeAdmits(h.store, ROOT, '/api/accounts')).resolves.toBeUndefined()
  })
})
