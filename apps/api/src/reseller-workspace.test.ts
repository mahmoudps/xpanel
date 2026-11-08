import { afterEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import { createTestStateStore, type TestStateStoreHandle } from '@xpanel/state'
import { DeliveryFailure } from './alert-delivery.ts'
import type { AuthenticatedCaller } from './auth.ts'
import { handleResellerWorkspaceRoute, type ResellerWorkspaceHelpers } from './reseller-workspace.ts'

const ARGON2 = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const root = { principal: { kind: 'root', id: '11111111-1111-4111-8111-111111111111', username: 'root' } } as unknown as AuthenticatedCaller
const reseller = { principal: { kind: 'reseller', id: '22222222-2222-4222-8222-222222222222', username: 'res1' } } as unknown as AuthenticatedCaller
const handles: TestStateStoreHandle[] = []
afterEach(async () => { for (const handle of handles.splice(0)) await handle.close() })

const fixture = async (caller = root, email: ResellerWorkspaceHelpers['email'] = async () => {}) => {
  const h = await createTestStateStore(); handles.push(h)
  const make = (username: string, contactEmail?: string) => h.store.createReseller({ username, passwordHash: ARGON2, acl: ['create-account'], maxAccounts: 10, totalDiskMb: 'unlimited', totalBandwidthMb: 'unlimited',
    oversell: { disk: false, bandwidth: false }, nameservers: ['ns1.example.test', 'ns2.example.test'], delegatedIps: [], ...(contactEmail && { contactEmail }) } as never)
  const audits: Record<string, unknown>[] = [], sent = vi.fn(email)
  const helpers: ResellerWorkspaceHelpers = {
    requireCaller: vi.fn(async () => caller),
    assertRoot: vi.fn(async (c: AuthenticatedCaller) => { if (c.principal.kind !== 'root') fail('FORBIDDEN', 'root role is required for this operation') }),
    emitAudit: vi.fn(async (entry: Record<string, unknown>) => { audits.push(entry) }),
    store: h.store, email: sent, reindex: vi.fn(async () => {}),
  }
  const call = async (method: string, path: string, body?: unknown) => {
    const url = new URL('http://localhost' + path)
    const response = await handleResellerWorkspaceRoute(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }), url, method, helpers)
    return { status: response?.status ?? null, body: response ? await response.json() as Record<string, unknown> : null }
  }
  return { ...h, make, audits, sent, helpers, call }
}
const codeOf = async (promise: Promise<unknown>): Promise<string> => { try { await promise; return 'ok' } catch (error) { return (error as { code?: string }).code ?? 'unknown' } }

describe('reseller privilege lists and Email All Resellers', { tags: ['feature'] }, () => {
  it('saves a privilege list and resets many resellers to it', async () => {
    const f = await fixture(), one = await f.make('resone'), two = await f.make('restwo')
    expect(await f.call('PUT', '/api/resellers/acl-lists/support', { acl: ['list-accounts', 'suspend-account'] })).toMatchObject({ status: 200, body: { list: { name: 'support', acl: ['list-accounts', 'suspend-account'] } } })
    expect(await f.call('GET', '/api/resellers/acl-lists')).toMatchObject({ body: { lists: [{ name: 'support' }] } })
    const applied = await f.call('POST', '/api/resellers/acl-lists/support/apply', { resellerIds: [one.id, two.id] })
    expect((applied.body!.resellers as { acl: string[] }[]).map(item => item.acl)).toEqual([['list-accounts', 'suspend-account'], ['list-accounts', 'suspend-account']])
    expect(f.helpers.reindex).toHaveBeenCalledOnce()
    expect(f.audits.at(-1)).toMatchObject({ action: 'reseller.acl_list.applied', detail: { resellers: ['resone', 'restwo'] } })
    expect(await codeOf(f.call('PUT', '/api/resellers/acl-lists/support', { acl: ['root-everything'] }))).toBe('VALIDATION')
    expect(await f.call('DELETE', '/api/resellers/acl-lists/support')).toMatchObject({ status: 200 })
    expect(await codeOf(f.call('DELETE', '/api/resellers/acl-lists/support'))).toBe('NOT_FOUND')
    expect(await codeOf((await fixture(reseller)).call('GET', '/api/resellers/acl-lists'))).toBe('FORBIDDEN')
  })

  it('sends one message per reseller contact and reports who has none or failed', async () => {
    const f = await fixture(root, async message => { if (message.to[0] === 'down@example.test') throw new DeliveryFailure('refused', 550) })
    await f.make('resone', 'one@example.test'); await f.make('restwo', 'down@example.test'); await f.make('resthree')
    const result = await f.call('POST', '/api/resellers/email', { subject: 'Maintenance', body: 'Tonight at 22:00 UTC.' })
    expect(result).toMatchObject({ status: 200, body: { sent: ['resone'], failed: [{ username: 'restwo', error: 'refused' }], withoutContact: ['resthree'] } })
    expect(f.sent.mock.calls.map(([message]) => message.to)).toEqual([['one@example.test'], ['down@example.test']])
    for (const bad of [{ subject: '', body: 'x' }, { subject: 'a\nb', body: 'x' }, { subject: 'ok', body: '' }, { subject: 'ok', body: 'x', bcc: 'all' }]) {
      expect(await codeOf(f.call('POST', '/api/resellers/email', bad)), JSON.stringify(bad)).toBe('VALIDATION')
    }
    const none = await fixture()
    await none.make('resone')
    expect(await codeOf(none.call('POST', '/api/resellers/email', { subject: 'Hello', body: 'x' }))).toBe('PRECONDITION_FAILED')
    expect(none.sent).not.toHaveBeenCalled()
  })
})
