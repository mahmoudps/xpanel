import { describe, expect, it, vi } from 'vitest'
import { fail, isXpanelError } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { policyForRequest } from './authorization.ts'
import { entryPointAllowsApiRoute } from './entry-points.ts'
import { handleRootIdentityWorkspaceRoute } from './root-identity-workspace.ts'
import type { RootIdentityHelpers } from './root-identity-workspace.ts'

const ROOT = { principal: { kind: 'root', id: '11111111-1111-4111-8111-111111111111', username: 'root' }, principalRecord: {}, sessionId: 's1', apiTokenId: null, scopes: ['*'] } as unknown as AuthenticatedCaller
const observation = { observedAt: '2026-11-07T00:00:00.000Z', family: 'rhel', group: 'wheel', state: 'read', members: [{ username: 'rocky', account: false }, { username: 'alice', account: true }], accounts: [{ username: 'alice', member: true }] }
const reason = async (run: () => Promise<unknown>) => { try { await run(); return 'passed' } catch (error) { return isXpanelError(error) ? `${error.code}:${String(error.detail.reason ?? error.detail.secondFactor ?? '')}` : error } }

function harness(overrides: Partial<RootIdentityHelpers> = {}, caller: AuthenticatedCaller = ROOT, host = true) {
  const events: string[] = []
  const callHost = vi.fn(async (_caller: AuthenticatedCaller, path: string, body?: Record<string, unknown>) =>
    path === '/host/identity/root-password' ? { outcome: 'applied', scheme: 'y' } : body ? { outcome: 'applied', observation } : observation)
  const helpers: RootIdentityHelpers = {
    requireCaller: async () => caller,
    assertRoot: async current => { if (current.principal.kind !== 'root') fail('FORBIDDEN', 'root required') },
    emitAudit: async entry => { events.push(entry.action + ':' + entry.outcome) },
    verifyPassword: async (_caller, password) => password === 'current-password', checkLockout: async () => null,
    recordFailure: async (_caller, why) => { events.push('failure:' + why) },
    secondFactorEnrolled: () => false, verifySecondFactor: async (_caller, code) => code === '123456',
    ...(host ? { callHost } : {}), ...overrides,
  }
  const send = (path: string, method = 'GET', body?: unknown, origin = 'https://whm.example.test:2087') =>
    handleRootIdentityWorkspaceRoute(new Request('https://whm.example.test:2087' + path, { method, headers: { origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), new URL('https://whm.example.test:2087' + path), method, helpers)
  return { events, callHost, send }
}
const change = { currentPassword: 'current-password', password: 'Correct-Horse-9-Battery', confirmation: 'Correct-Horse-9-Battery' }

describe('Change Root Password', () => {
  it('is a root-only xWHM route', () => {
    expect(policyForRequest('/api/server/root-password', 'POST')).toMatchObject({ resource: 'server', rootOnly: true })
    expect(entryPointAllowsApiRoute('xwhm', '/api/server/root-password', 'POST')).toBe(true)
    expect(entryPointAllowsApiRoute('xpanel', '/api/server/root-password', 'POST')).toBe(false)
  })

  it('re-authenticates, applies the strength rule and audits before and after the host change', async () => {
    const h = harness()
    expect(await (await h.send('/api/server/root-password'))!.json()).toEqual({ capability: { reauthentication: 'required', secondFactor: 'not_enrolled', audit: 'enabled' }, host: 'connected' })
    expect(await reason(() => h.send('/api/server/root-password', 'POST', { ...change, confirmation: 'other' }))).toBe('VALIDATION:confirmation_mismatch')
    expect(await reason(() => h.send('/api/server/root-password', 'POST', { ...change, password: 'short', confirmation: 'short' }))).toBe('VALIDATION:')
    expect(await reason(() => h.send('/api/server/root-password', 'POST', { ...change, currentPassword: 'guess' }))).toBe('UNAUTHENTICATED:')
    expect(h.events).toContain('failure:invalid_root_password_reauthentication')
    expect(h.callHost).not.toHaveBeenCalled()
    expect(await (await h.send('/api/server/root-password', 'POST', change))!.json()).toEqual({ outcome: 'applied', scheme: 'y' })
    expect(h.callHost).toHaveBeenCalledWith(ROOT, '/host/identity/root-password', { password: change.password })
    expect(h.events.slice(-2)).toEqual(['server.root_password.change_requested:ok', 'server.root_password.changed:ok'])
  })

  it('asks for the enrolled second factor and refuses tokens, handoffs and pages from elsewhere', async () => {
    const enrolled = harness({ secondFactorEnrolled: () => true })
    expect(await reason(() => enrolled.send('/api/server/root-password', 'POST', change))).toBe('UNAUTHENTICATED:required')
    expect((await enrolled.send('/api/server/root-password', 'POST', { ...change, totpCode: '123456' }))!.status).toBe(200)
    expect(await reason(() => harness().send('/api/server/root-password', 'POST', change, ''))).toBe('FORBIDDEN:')
    expect(await reason(() => harness({}, { ...ROOT, apiTokenId: 't1' } as AuthenticatedCaller).send('/api/server/root-password', 'POST', change))).toBe('FORBIDDEN:')
    expect(await reason(() => harness({}, { ...ROOT, principal: { kind: 'reseller', id: 'r', username: 'res' } } as unknown as AuthenticatedCaller).send('/api/server/root-password', 'GET'))).toBe('FORBIDDEN:')
    const failing = harness({ callHost: vi.fn(async () => fail('SERVICE_UNAVAILABLE', 'unverified', { stateChanged: true, verificationRequired: true })) })
    expect(await reason(() => failing.send('/api/server/root-password', 'POST', change))).toBe('SERVICE_UNAVAILABLE:')
    expect(failing.events.slice(-1)).toEqual(['server.root_password.changed:failed'])
  })
})

describe('Manage Wheel Group Users', () => {
  it('reads the host group strictly and changes one hosting account with audit', async () => {
    const h = harness()
    expect(await (await h.send('/api/server/sec/admin-group'))!.json()).toEqual({ observation, reason: null })
    expect(await (await h.send('/api/server/sec/admin-group', 'POST', { action: 'remove', username: 'alice' }))!.json()).toEqual({ outcome: 'applied', observation })
    expect(h.events).toEqual(['server.sec.admin_group.change_requested:ok', 'server.sec.admin_group.changed:ok'])
    expect(await reason(() => h.send('/api/server/sec/admin-group', 'POST', { action: 'add', username: 'root;id' }))).toBe('VALIDATION:')
    expect(await (await harness({ callHost: vi.fn(async () => ({ ...observation, members: [{ username: 'x y', account: false }] })) }).send('/api/server/sec/admin-group'))!.json()).toEqual({ observation: null, reason: 'observation_unverified' })
    expect(await (await harness({}, ROOT, false).send('/api/server/sec/admin-group'))!.json()).toEqual({ observation: null, reason: 'host_agent_unavailable' })
  })
})
