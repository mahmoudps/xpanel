import { describe, expect, it, vi } from 'vitest'
import type { Account, Certificate, Domain } from '@xpanel/core'
import { handleForceHttpsRoute, httpsCovered } from './domain-force-https.ts'
import type { AuthenticatedCaller } from './auth.ts'

const accountId = '11111111-1111-4111-8111-111111111111', id = '22222222-2222-4222-8222-222222222222', other = '33333333-3333-4333-8333-333333333333'
const domain = (over: Partial<Domain> = {}): Domain => ({ id, accountId, name: 'example.test', kind: 'primary', parentId: null, certificateId: 'c1', ...over }) as Domain
const certificate = (over: Partial<Certificate> = {}): Certificate => ({ id: 'c1', accountId, names: ['example.test'], source: 'acme', challenge: 'http-01', notAfter: '2027-01-01T00:00:00.000Z', autoRenew: true, ...over })
const now = new Date('2026-11-07T00:00:00.000Z')
const run = (body: unknown, ports: Partial<Parameters<typeof handleForceHttpsRoute>[3]> = {}) => {
  const set = vi.fn(async () => [domain()])
  const request = new Request('http://x/api/domains/force-https', { method: 'POST' })
  const response = handleForceHttpsRoute(request, new URL(request.url), 'POST', {
    requireCaller: async () => ({ principal: { kind: 'root' } }) as AuthenticatedCaller, readJsonBody: async () => body as Record<string, unknown>,
    getDomain: async wanted => wanted === id ? domain() : null, getAccount: async () => ({ id: accountId }) as Account, listCertificates: async () => [certificate()], assertCanModify: async () => undefined,
    mutate: async (_request, _caller, _account, _expected, change) => { await change({} as never); return { reconcile: { status: 'applied' }, view: { revision: 'r' } } }, setForceHttps: set, now: () => now, ...ports })
  return { response, set }
}

describe('force HTTPS redirect', () => {
  it('needs an unexpired certificate that covers the name', () => {
    expect(httpsCovered(domain(), [certificate()], now)).toBe(true)
    expect(httpsCovered(domain(), [certificate({ notAfter: '2026-01-01T00:00:00.000Z' })], now)).toBe(false)
    expect(httpsCovered(domain(), [certificate({ names: ['other.test'] })], now)).toBe(false)
    expect(httpsCovered(domain({ name: 'www.example.test', certificateId: null }), [certificate({ names: ['*.example.test'] })], now)).toBe(true)
  })
  it('refuses CERT_REQUIRED before any state change, and turning off needs no certificate', async () => {
    const refused = run({ domainIds: [id], enabled: true, expectedRevision: 'a' }, { listCertificates: async () => [] })
    await expect(refused.response).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'cert_required', domains: ['example.test'], stateChanged: false } })
    expect(refused.set).not.toHaveBeenCalled()
    const off = run({ domainIds: [id], enabled: false, expectedRevision: 'a' }, { listCertificates: async () => [] })
    expect(await (await off.response)!.json()).toEqual({ revision: 'r', stateChanged: true, reconcile: { status: 'applied' } })
    expect(off.set).toHaveBeenCalledWith(accountId, [id], false, {})
  })
  it('takes one account at a time and bounded, distinct ids', async () => {
    await expect(run({ domainIds: [id, id], enabled: true }).response).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(run({ domainIds: [], enabled: true }).response).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(run({ domainIds: [id], enabled: 'yes' }).response).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(run({ domainIds: [id, other], enabled: true }).response).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(run({ domainIds: [id, other], enabled: true }, { getDomain: async wanted => domain({ id: wanted, accountId: wanted === id ? accountId : other }) }).response).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})
