import { describe, expect, it, vi } from 'vitest'
import type { Account, Plan } from '@xpanel/core'
import { accountAdminRow, handleAccountAdminRoute, parseForcedPasswords } from './account-admin-workspace.ts'
import type { AccountAdminPorts } from './account-admin-workspace.ts'
import type { AuthenticatedCaller } from './auth.ts'

const account = (username: string, over: Partial<Account> = {}): Account => ({ id: username, username, primaryDomain: username + '.test', status: 'active', home: '/home/' + username, shell: 'none', planId: 'p', ...over }) as Account
const plan = { id: 'p', shell: 'none' } as Plan
const ports = (over: Partial<AccountAdminPorts> = {}, body: unknown = {}): AccountAdminPorts => ({
  requireCaller: async () => ({ principal: { kind: 'root' } }) as AuthenticatedCaller, readJsonBody: async () => body as Record<string, unknown>,
  listAccounts: async () => [account('alice'), account('bob')], getPlan: async () => plan, assertCanModify: async () => undefined,
  readForcedPassword: async () => false, setForcedPassword: async () => undefined, audit: async () => undefined, rearrange: async () => ({ home: '/home2/alice', job: { id: 'j' } }), recoverRearrange: async () => ({ outcome: 'cancelled' }), ...over })
const call = async (path: string, method: string, value: AccountAdminPorts) => {
  const request = new Request('http://x' + path, { method })
  return await (await handleAccountAdminRoute(request, new URL(request.url), method, value))!.json()
}

describe('account administration', () => {
  it('reports a shell that differs from the package as an override', () => {
    expect(accountAdminRow(account('alice'), plan, true)).toMatchObject({ shellSource: 'package', forcedPassword: true })
    expect(accountAdminRow(account('alice', { shell: 'jailed' }), plan, false)).toMatchObject({ shellSource: 'override', planShell: 'none' })
    expect(accountAdminRow(account('alice'), null, null)).toMatchObject({ shellSource: 'override', planShell: null, forcedPassword: null })
  })
  it('takes exact usernames mapped to booleans', () => {
    expect(parseForcedPasswords({ users: { alice: true, bob: false }, stopOnFailure: true })).toEqual({ users: new Map([['alice', true], ['bob', false]]), stopOnFailure: true })
    for (const body of [{}, { users: [] }, { users: {} }, { users: { alice: 'yes' } }, { users: { 'Bad Name': true } }, { users: { alice: true }, stopOnFailure: 'no' }, { users: { alice: true }, other: 1 }]) expect(() => parseForcedPasswords(body as Record<string, unknown>)).toThrow()
  })
  it('sets the flag per account and never reaches an account outside the caller', async () => {
    const set = vi.fn(async () => undefined), audit = vi.fn(async () => undefined)
    const reply = await call('/api/accounts/admin/password-change', 'PUT', ports({ setForcedPassword: set, audit }, { users: { alice: true, bob: false, carol: true } }))
    expect(reply).toEqual({ updated: [{ username: 'alice', forced: true }, { username: 'bob', forced: false }], failed: [{ username: 'carol', reason: 'account_not_found' }] })
    expect(set).toHaveBeenCalledTimes(2)
    expect(audit).toHaveBeenCalledTimes(2)
  })
  it('stops at the first failure when asked and says what it did not attempt', async () => {
    const set = vi.fn(async () => undefined)
    const reply = await call('/api/accounts/admin/password-change', 'PUT', ports({ setForcedPassword: set, assertCanModify: async (_c, target) => { if (target.username === 'alice') throw Object.assign(new Error('x'), { detail: { reason: 'nope' } }) } }, { users: { alice: true, bob: true }, stopOnFailure: true }))
    expect(reply).toEqual({ updated: [], failed: [{ username: 'alice', reason: 'nope' }, { username: 'bob', reason: 'not_attempted' }] })
    expect(set).not.toHaveBeenCalled()
  })
  it('moves an account for root only, and only an account root can see', async () => {
    const id = '11111111-1111-4111-8111-111111111111', path = `/api/accounts/${id}/rearrange`
    const value = ports({ listAccounts: async () => [account('alice', { id })] }, { root: '/home2' })
    expect(await call(path, 'POST', value)).toEqual({ home: '/home2/alice', job: { id: 'j' } })
    await expect(call(path, 'POST', { ...value, requireCaller: async () => ({ principal: { kind: 'reseller' } }) as AuthenticatedCaller })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(call(path, 'POST', { ...value, listAccounts: async () => [] })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(call(path, 'POST', { ...value, readJsonBody: async () => ({ root: '/home2', extra: 1 }) })).rejects.toMatchObject({ code: 'VALIDATION' })
  })
  it('refuses an account owner and an account without a panel identity', async () => {
    await expect(call('/api/accounts/admin', 'GET', ports({ requireCaller: async () => ({ principal: { kind: 'user' } }) as AuthenticatedCaller }))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await call('/api/accounts/admin/password-change', 'PUT', ports({ readForcedPassword: async () => null }, { users: { alice: true } }))).toEqual({ updated: [], failed: [{ username: 'alice', reason: 'identity_unavailable' }] })
  })
})
