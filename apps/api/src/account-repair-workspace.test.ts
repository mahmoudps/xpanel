import { describe, expect, it, vi } from 'vitest'
import type { AuthenticatedCaller } from './auth.ts'
import { handleAccountRepairWorkspaceRoute } from './account-repair-workspace.ts'
import type { AccountRepairWorkspaceHelpers } from './account-repair-workspace.ts'

const caller = { principal: { id: 'p', kind: 'root', username: 'root' } } as unknown as AuthenticatedCaller
const helpers = (over: Partial<AccountRepairWorkspaceHelpers> = {}): AccountRepairWorkspaceHelpers => ({ requireCaller: async () => caller, assertRoot: vi.fn(async () => undefined), callHost: vi.fn(async () => ({ job: { id: 'job' }, accounts: [] })), rerender: vi.fn(async () => ({ ok: true, status: 200 })), emitAudit: vi.fn(async () => undefined), ...over })
const call = (path: string, body: unknown, ports: AccountRepairWorkspaceHelpers, method = 'POST') => { const url = new URL('https://panel/api/accounts/repair/' + path); return handleAccountRepairWorkspaceRoute(new Request(url, { method, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) }), url, method, ports) }

describe('account repair workspace', () => {
  it('requires root first and only POST', async () => {
    const refused = helpers({ assertRoot: async () => { throw new Error('denied') } })
    await expect(call('preview', { accounts: ['alice'] }, refused)).rejects.toThrow('denied'); expect(refused.callHost).not.toHaveBeenCalled()
    expect((await call('run', null, helpers(), 'GET'))!.status).toBe(405)
  })
  it('runs both fixes, reports each and audits', async () => {
    const ports = helpers(), response = await call('run', { accounts: ['alice'], fixes: ['ownership', 'rerender'] }, ports)
    expect(await response!.json()).toEqual({ job: { id: 'job' }, rerender: 'applied' })
    expect(vi.mocked(ports.emitAudit).mock.calls[0]![0]).toMatchObject({ action: 'accounts.repair_submitted', detail: { accounts: ['alice'], fixes: ['ownership', 'rerender'], reconcile: true } })
  })
  it('states a failed or absent re-render and skips the job when not chosen', async () => {
    const ports = helpers({ rerender: async () => ({ ok: false, status: 412 }) })
    expect(await (await call('run', { accounts: ['alice'], fixes: ['rerender'] }, ports))!.json()).toEqual({ job: null, rerender: 'failed' }); expect(ports.callHost).not.toHaveBeenCalled()
    expect(await (await call('run', { accounts: ['alice'], fixes: ['rerender'] }, helpers({ rerender: async () => null })))!.json()).toMatchObject({ rerender: 'not-connected' })
  })
  it('refuses unknown fixes', async () => {
    for (const body of [{ accounts: ['a'], fixes: [] }, { accounts: ['a'], fixes: ['rm'] }, { accounts: ['a'], fixes: ['rerender', 'rerender'] }, { accounts: 'a', fixes: ['rerender'] }, { accounts: ['a'] }]) await expect(call('run', body, helpers()), JSON.stringify(body)).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})
