import { describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { developerReadDescriptors, handleDeveloperWorkspaceRoute, parseDeveloperOperation } from './developer-workspace.ts'
import type { DeveloperWorkspaceHelpers } from './developer-workspace.ts'
import { handleIntegrationWorkspaceRoute } from './integration-workspace.ts'

const ROOT = { principal: { id: '11111111-1111-4111-8111-111111111111', kind: 'root', username: 'root' }, sessionId: 'interactive-one', apiTokenId: null, scopes: ['*'] } as AuthenticatedCaller
const USER = { principal: { id: '22222222-2222-4222-8222-222222222222', kind: 'user', accountId: '33333333-3333-4333-8333-333333333333', username: 'alice' }, sessionId: 'interactive-two', apiTokenId: null, scopes: ['*'] } as AuthenticatedCaller
const BASE = '/api/server/panel/developer', STAMP = '2026-10-27T12:00:00.000Z'
const identity = (caller = ROOT) => ({ principal: caller.principal, csrfToken: 'sensitive-csrf-fixture', session: 'sensitive-session-fixture' })
function harness(initial = ROOT) {
  let caller = initial, disabled: string[] = [], active = true
  const store = { getAccount: vi.fn(async () => ({ id: USER.principal.kind === 'user' ? USER.principal.accountId : '', username: 'alice', status: active ? 'active' : 'suspended', planId: 'plan' })),
    getPlan: vi.fn(async () => ({ featureListId: 'features' })), getFeatureList: vi.fn(async () => ({ disabled })) }
  const helpers = { store, requireCaller: vi.fn(async () => caller), assertRoot: vi.fn(async (c: AuthenticatedCaller) => { if (c.principal.kind !== 'root') fail('FORBIDDEN', 'root required') }), emitAudit: vi.fn(async () => undefined),
    dispatchRead: vi.fn(async () => Response.json(identity(caller))), now: () => new Date(STAMP) } as unknown as DeveloperWorkspaceHelpers & { dispatchRead: ReturnType<typeof vi.fn> }
  const send = (method = 'GET', body?: unknown, path = BASE, contentType = 'application/json') => {
    const url = new URL('https://panel.test' + path), req = new Request(url, { method, headers: { cookie: 'synthetic-sealed-session', 'x-csrf-token': 'synthetic-csrf', origin: 'https://panel.test', 'content-type': contentType }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) })
    return path.startsWith('/api/server/panel/integrations') ? handleIntegrationWorkspaceRoute(req, url, method, helpers) : handleDeveloperWorkspaceRoute(req, url, method, helpers)
  }
  return { helpers, send, setCaller: (next: AuthenticatedCaller) => { caller = next }, disable: () => { disabled = ['api_shell'] }, suspend: () => { active = false } }
}

describe('finite interactive API explorer', () => {
  it('ignores unrelated paths, lists only fixed GET operations and rejects every selector/body extension', async () => {
    const h = harness()
    expect(await h.send('GET', undefined, '/api/server/panel/developer/other')).toBeNull()
    expect(h.helpers.requireCaller).not.toHaveBeenCalled()
    const response = (await h.send())!
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ surface: 'administrator', available: true, writes: false, rawResponses: false, operations: developerReadDescriptors('administrator') })
    for (const body of [{}, { operation: 'DELETE' }, { operation: 'identity', path: '/api/server/settings' }, { operation: 'identity', method: 'POST' }, { operation: 'identity', url: 'https://outside.test' }, { operation: 'identity', headers: {} }, { operation: 'identity', body: {} }, { operation: 'identity', accountId: 'other' }, { operation: ['identity'] }]) expect(() => parseDeveloperOperation(body)).toThrow(expect.objectContaining({ code: 'VALIDATION' }))
    await expect(h.send('GET', undefined, BASE + '?account=other')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(h.helpers.dispatchRead).not.toHaveBeenCalled()
  })
  it('dispatches one same-origin fixed GET with original credentials, then removes IDs and CSRF from its result', async () => {
    const h = harness(), result = (await h.send('POST', { operation: 'identity' }))!
    const req = h.helpers.dispatchRead.mock.calls[0]![0] as Request
    expect(req.method).toBe('GET'); expect(req.url).toBe('https://panel.test/api/auth/me'); expect(req.body).toBeNull()
    expect(req.headers.get('cookie')).toBe('synthetic-sealed-session'); expect(req.headers.get('origin')).toBe('https://panel.test')
    const text = await result.text(), raw = JSON.parse(text)
    expect(raw).toEqual({ operation: 'identity', request: { method: 'GET', path: '/api/auth/me' }, state: 'read', status: 200, observedAt: STAMP, fields: [{ key: 'username', value: 'root' }, { key: 'role', value: 'root' }], tokens: [] })
    for (const secret of [ROOT.principal.id, 'sensitive-csrf-fixture', 'sensitive-session-fixture', 'synthetic-sealed-session']) expect(text).not.toContain(secret)
    expect(h.helpers.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ detail: { operation: 'identity', status: 200, state: 'read' } }))
  })
  it('pins identity and contact response to the current account, keeps root and owner routes separate', async () => {
    const h = harness(USER)
    await expect(h.send()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const path = '/api/account/developer', manifest = await (await h.send('GET', undefined, path))!.json()
    expect(manifest.operations).toEqual(developerReadDescriptors('account'))
    await expect(h.send('POST', { operation: 'tokens' }, path)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    h.helpers.dispatchRead.mockImplementation(async () => Response.json({ context: { accountId: USER.principal.kind === 'user' ? USER.principal.accountId : '' }, preferences: { contactEmail: 'alice@example.test', password: 'not-returned' }, revision: 'not-returned' }))
    const response = await h.send('POST', { operation: 'preferences' }, path)
    expect((await response!.json()).fields).toEqual([{ key: 'contactEmail', value: 'alice@example.test' }])
    h.helpers.dispatchRead.mockImplementation(async () => Response.json({ context: { accountId: 'foreign' }, preferences: { contactEmail: 'foreign@example.test' } }))
    await expect(h.send('POST', { operation: 'preferences' }, path)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  })
  it('projects own-root token metadata only; integrations cannot dispatch identity, preferences or external URLs', async () => {
    const h = harness(), path = '/api/server/panel/integrations'
    h.helpers.dispatchRead.mockImplementation(async () => Response.json({ tokens: [{ id: 'private-token-id', tokenHash: 'private-token-hash', secret: 'private-secret-fixture', name: 'inventory-reader', scopes: ['catalog:read'], expiresAt: STAMP, state: 'active' }], secret: 'private-secret-fixture' }))
    expect((await (await h.send('GET', undefined, path))!.json()).operations).toEqual(developerReadDescriptors('integrations'))
    await expect(h.send('POST', { operation: 'identity' }, path)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const text = await (await h.send('POST', { operation: 'tokens' }, path))!.text()
    expect(JSON.parse(text).tokens).toEqual([{ name: 'inventory-reader', scopes: ['catalog:read'], expiresAt: STAMP, state: 'active' }])
    expect(text).not.toMatch(/private-|tokenHash|secret|csrf/i)
    expect((h.helpers.dispatchRead.mock.calls[0]![0] as Request).url).toBe('https://panel.test/api/server/panel/api-tokens')
  })
  it('rejects bearer/noninteractive principals and revocation before returning any projected data', async () => {
    for (const caller of [{ ...ROOT, sessionId: null, apiTokenId: 'bearer' }, { ...ROOT, sessionId: null }]) { const h = harness(caller); await expect(h.send()).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(h.helpers.dispatchRead).not.toHaveBeenCalled() }
    const h = harness(); h.helpers.dispatchRead.mockImplementation(async () => { h.setCaller({ ...ROOT, sessionId: 'replaced' }); return Response.json(identity()) })
    await expect(h.send('POST', { operation: 'identity' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const owner = harness(USER); owner.helpers.dispatchRead.mockImplementation(async () => { owner.disable(); return Response.json(identity(USER)) })
    await expect(owner.send('POST', { operation: 'identity' }, '/api/account/developer')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('rechecks the selected target policy independently of the still-authorized explorer policy', async () => {
    const h = harness(USER), path = '/api/account/developer'
    h.helpers.dispatchRead.mockImplementation(async () => Response.json({ context: { accountId: USER.principal.kind === 'user' ? USER.principal.accountId : '' }, preferences: { contactEmail: 'alice@example.test' } }))
    h.helpers.requireCaller = vi.fn(async (request: Request) => {
      if (new URL(request.url).pathname === '/api/account/preferences') fail('FORBIDDEN', 'the contact preference feature was revoked')
      return USER
    })
    await expect(h.send('POST', { operation: 'preferences' }, path)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(h.helpers.emitAudit).not.toHaveBeenCalled()
  })
  it('returns sanitized refusal status without reading its body; rejects redirect/malformed/oversized replies', async () => {
    const h = harness()
    h.helpers.dispatchRead.mockImplementation(async () => new Response('private-foreign-response', { status: 403, headers: { 'set-cookie': 'private-credential' } }))
    const response = (await h.send('POST', { operation: 'identity' }))!, text = await response.text()
    expect(JSON.parse(text)).toMatchObject({ state: 'refused', status: 403, fields: [], tokens: [] }); expect(text).not.toContain('private-'); expect(response.headers.has('set-cookie')).toBe(false)
    for (const reply of [new Response(null, { status: 302, headers: { location: 'https://outside.test' } }), new Response('not-json', { headers: { 'content-type': 'application/json' } }), Response.json({ data: 'x'.repeat(256 * 1024) })]) {
      h.helpers.dispatchRead.mockImplementation(async () => reply)
      await expect(h.send('POST', { operation: 'identity' })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    }
    const before = h.helpers.dispatchRead.mock.calls.length
    await expect(h.send('POST', ' '.repeat(1025))).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(h.send('POST', { operation: 'identity' }, BASE, 'text/plain')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(h.helpers.dispatchRead.mock.calls.length).toBe(before)
  })
  it('keeps the absent read provider unavailable and refuses unexpected identity without data', async () => {
    const h = harness(); h.helpers.dispatchRead = undefined as never
    expect((await (await h.send())!.json()).available).toBe(false)
    await expect(h.send('POST', { operation: 'identity' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    const mismatch = harness(); mismatch.helpers.dispatchRead.mockImplementation(async () => Response.json(identity(USER)))
    await expect(mismatch.send('POST', { operation: 'identity' })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  })
})
