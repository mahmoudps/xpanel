import { describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { handleAccountHealthWorkspaceRoute } from './account-health-workspace.ts'
import type { AccountHealthWorkspaceHelpers } from './account-health-workspace.ts'

const caller = (kind: string, id = kind + '-1', extra: Record<string, unknown> = {}) => ({ principal: { kind, id, username: kind }, sessionId: 'session-1', apiTokenId: null, scopes: [], ...extra }) as unknown as AuthenticatedCaller
const usernames = (count: number) => Array.from({ length: count }, (_, index) => 'u' + String(index).padStart(3, '0'))
const agentReport = (path: string) => {
  const names = new URL('http://agent.local' + path).searchParams.getAll('username')
  return Response.json({ observedAt: '2026-10-27T10:00:00.000Z', host: 'read', accounts: names.map(username => ({ username, primaryDomain: username + '.example.test', status: 'active', problems: 0, unavailable: 0, checks: [] })) })
}
const helpers = (overrides: Partial<AccountHealthWorkspaceHelpers> = {}, visible = ['alice', 'bob']) => {
  const forwarded: string[] = []
  const value: AccountHealthWorkspaceHelpers = {
    requireCaller: vi.fn(async () => caller('root')),
    visibleAccounts: vi.fn(async () => visible.map(username => ({ username }))),
    forward: vi.fn(async (_caller, path) => { forwarded.push(path); return agentReport(path) }),
    now: () => new Date('2026-10-27T10:00:00.000Z'),
    ...overrides,
  }
  return { value, forwarded }
}
const call = (h: AccountHealthWorkspaceHelpers, path: string, method = 'GET') => {
  const url = new URL('http://localhost' + path)
  return handleAccountHealthWorkspaceRoute(new Request(url, { method }), url, method, h)
}

describe('account health workspace API', () => {
  it('checks the first visible batch and lists the rest as pending', async () => {
    const { value, forwarded } = helpers({}, usernames(120).reverse())
    const response = await call(value, '/api/accounts/health')
    expect(response!.status).toBe(200); expect(response!.headers.get('cache-control')).toBe('no-store')
    const body = await response!.json()
    expect(body.accounts).toHaveLength(50); expect(body.accounts[0].username).toBe('u000')
    expect(body.pending).toEqual(usernames(120).slice(50)); expect(body.truncated).toBe(false); expect(body.host).toBe('read')
    expect(forwarded).toHaveLength(1)
    expect(new URL('http://agent.local' + forwarded[0]).searchParams.getAll('username')).toEqual(usernames(50))
    expect(forwarded[0]!.startsWith('/host/accounts/health?')).toBe(true)
    expect(await call(value, '/api/accounts')).toBeNull()
  })

  it('rechecks exactly the selected visible accounts and refuses others as absent', async () => {
    const { value, forwarded } = helpers()
    const body = await (await call(value, '/api/accounts/health?username=bob'))!.json()
    expect(body.accounts.map((entry: { username: string }) => entry.username)).toEqual(['bob']); expect(body.pending).toEqual([])
    expect(forwarded).toEqual(['/host/accounts/health?username=bob'])
    await expect(call(value, '/api/accounts/health?username=carol')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(forwarded).toHaveLength(1)
  })

  it('scopes resellers through the visible-account helper', async () => {
    const visibleAccounts = vi.fn(async (current: AuthenticatedCaller) => current.principal.kind === 'reseller' ? [{ username: 'alice' }] : [{ username: 'alice' }, { username: 'bob' }])
    const { value, forwarded } = helpers({ requireCaller: async () => caller('reseller'), visibleAccounts })
    expect((await (await call(value, '/api/accounts/health'))!.json()).accounts.map((entry: { username: string }) => entry.username)).toEqual(['alice'])
    await expect(call(value, '/api/accounts/health?username=bob')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(forwarded).toEqual(['/host/accounts/health?username=alice'])
  })

  it('returns an empty truthful result without a host call when nothing is visible', async () => {
    const { value, forwarded } = helpers({}, [])
    expect(await (await call(value, '/api/accounts/health'))!.json()).toEqual({ observedAt: '2026-10-27T10:00:00.000Z', host: 'unavailable', accounts: [], pending: [], truncated: false })
    expect(forwarded).toEqual([])
  })

  it.each([['user', caller('user')], ['mailbox', caller('user', 'user-1', { principalKind: 'mailbox' })]])('refuses a %s principal before any read (403)', async (_name, current) => {
    const { value, forwarded } = helpers({ requireCaller: async () => current })
    await expect(call(value, '/api/accounts/health')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(forwarded).toEqual([]); expect(value.visibleAccounts).not.toHaveBeenCalled()
  })

  it('propagates a policy refusal from authentication (403)', async () => {
    const { value, forwarded } = helpers({ requireCaller: async () => fail('FORBIDDEN', 'reseller lacks the "list-accounts" privilege') })
    await expect(call(value, '/api/accounts/health')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(forwarded).toEqual([])
  })

  it.each([
    ['extra key', '/api/accounts/health?username=alice&path=/etc'], ['duplicate', '/api/accounts/health?username=alice&username=alice'],
    ['grammar', '/api/accounts/health?username=Alice'], ['option-like', '/api/accounts/health?username=-x'],
    ['too many', '/api/accounts/health?' + usernames(51).map(name => 'username=' + name).join('&')],
  ])('refuses selectors (422 VALIDATION): %s', async (_name, path) => {
    const { value, forwarded } = helpers({}, usernames(60))
    await expect(call(value, path)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(forwarded).toEqual([])
  })

  it('refuses wrong methods, changed authority and unbound host responses', async () => {
    expect((await call(helpers().value, '/api/accounts/health', 'POST'))!.status).toBe(405)
    let calls = 0
    await expect(call(helpers({ requireCaller: async () => calls++ ? caller('root', 'root-2') : caller('root') }).value, '/api/accounts/health')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const smuggled = helpers({ forward: async () => Response.json({ observedAt: 'x', host: 'read', accounts: [{ username: 'mallory' }, { username: 'bob' }] }) })
    await expect(call(smuggled.value, '/api/accounts/health')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    const huge = helpers({ forward: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) })
    await expect(call(huge.value, '/api/accounts/health')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    const refused = helpers({ forward: async () => Response.json({ detail: 'account not found' }, { status: 404 }) })
    await expect(call(refused.value, '/api/accounts/health')).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'account not found' })
    const offline = helpers({ forward: async () => fail('PRECONDITION_FAILED', 'privileged host agent is not connected', { stateChanged: false }) })
    await expect(call(offline.value, '/api/accounts/health')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    const broken = helpers({ forward: async () => { throw new Error('socket closed') } })
    await expect(call(broken.value, '/api/accounts/health')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  })

  it('drops accounts that stopped being visible during the host read', async () => {
    let reads = 0
    const { value } = helpers({ visibleAccounts: async () => reads++ ? [{ username: 'alice' }] : [{ username: 'alice' }, { username: 'bob' }] })
    expect((await (await call(value, '/api/accounts/health'))!.json()).accounts.map((entry: { username: string }) => entry.username)).toEqual(['alice'])
  })
})
