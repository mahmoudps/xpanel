import { describe, expect, it, vi } from 'vitest'
import type { Account } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import type { AccountSshPorts } from './account-ssh-workspace.ts'
import { handleDatabaseRemoteAccessWorkspaceRoute, validateDatabaseRemoteAccessView } from './database-remote-access-workspace.ts'
const id = '11111111-1111-4111-8111-111111111111', pid = '22222222-2222-4222-8222-222222222222', createdAt = '2026-10-27T00:00:00.000Z'
const account = { id, username: 'alice', createdAt, status: 'active', planId: pid } as Account
const view = (applied = false) => ({ context: { accountId: id, username: 'alice' }, revision: 'b'.repeat(64), entries: applied ? [{ host: '192.0.2.7', comment: 'Office', createdAt, firewall: 'verified', grants: 'verified' }] : [], limit: 100, users: 1, databases: 1, capability: { canChange: applied, reason: applied ? 'qualified' : 'native_provider_unavailable' }, application: { status: applied ? 'applied' : 'read', nativeQualified: applied } })
function setup() {
  const caller = { principal: { kind: 'user', accountId: id, id: pid, username: 'alice' }, sessionId: 'fixture', apiTokenId: null, scopes: [] } as unknown as AuthenticatedCaller
  const store = { getAccount: vi.fn(async () => account), getPlan: vi.fn(async () => ({ featureListId: pid })), getFeatureList: vi.fn(async () => ({ disabled: [] })) }
  const requireCaller = vi.fn(async () => caller), readAgent = vi.fn(async () => view())
  const ports = { store: store as unknown as StateStore, requireCaller, readAgent } as AccountSshPorts
  const send = (body?: unknown, path = '/api/account/database-remote-access') => { const url = new URL('https://panel.test' + path); return handleDatabaseRemoteAccessWorkspaceRoute(new Request(url, { method: body ? 'POST' : 'GET', ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) }), url, body ? 'POST' : 'GET', ports) }
  const add = { action: 'add', expectedRevision: 'a'.repeat(64), host: '192.0.2.7', comment: 'Office' }
  return { caller, requireCaller, readAgent, ports, send, add }
}
describe('remote database owner API boundary', () => {
  it('forwards only a session-derived owner target with exact parsed body and validated acknowledgement', async () => {
    const ctx = setup(); ctx.readAgent.mockResolvedValue(view(true))
    const response = await ctx.send(ctx.add)
    expect(response?.status).toBe(200); expect(ctx.readAgent).toHaveBeenCalledWith(ctx.caller, '/accounts/alice/database-remote-access', ctx.add, true, 'POST')
  })
  it('rejects selectors, extra owner fields and nonowner caller before forwarding', async () => {
    const ctx = setup()
    await expect(ctx.send(undefined, '/api/account/database-remote-access?accountId=' + id)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(ctx.send({ ...ctx.add, accountId: id })).rejects.toMatchObject({ code: 'VALIDATION' })
    ctx.requireCaller.mockResolvedValue({ ...ctx.caller, principal: { kind: 'root', id: pid, username: 'root' } } as AuthenticatedCaller)
    await expect(ctx.send()).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(ctx.readAgent).not.toHaveBeenCalled()
  })
  it('refuses wrong-scope, leaked auth, fake capability and wrong-target replies', () => {
    for (const raw of [{ ...view(), context: { accountId: pid, username: 'alice' } }, { ...view(), authString: 'hidden' }, { ...view(), capability: { canChange: true, reason: 'qualified' } }, { ...view(true), entries: [{ ...view(true).entries[0], host: '198.51.100.2' }] }]) expect(() => validateDatabaseRemoteAccessView(raw, account, raw === undefined ? undefined : raw.application.status === 'applied' ? setup().add as import('../../../packages/core/src/database-remote-access.ts').DatabaseRemoteAccessRequest : undefined)).toThrow()
  })
  it('withholds reads after transport revocation and marks mutated outcomes unknown', async () => {
    for (const mutation of [false, true]) {
      const ctx = setup()
      ctx.readAgent.mockImplementation(async () => { ctx.requireCaller.mockRejectedValue(new Error('revoked')); return view(mutation) })
      if (mutation) await expect(ctx.send(ctx.add)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true, stateChanged: true } })
      else await expect(ctx.send()).rejects.toThrow('revoked')
    }
  })
  it('withholds an acknowledgement if the account ownership tuple changes during transport', async () => {
    for (const mutation of [false, true]) {
      const ctx = setup()
      ctx.readAgent.mockImplementation(async () => { vi.mocked(ctx.ports.store.getAccount).mockResolvedValue({ ...account, ownerId: pid }); return view(mutation) })
      await expect(ctx.send(mutation ? ctx.add : undefined)).rejects.toMatchObject({ code: mutation ? 'SERVICE_UNAVAILABLE' : 'FORBIDDEN' })
    }
  })
})
