import { describe, expect, it, vi } from 'vitest'
import { assertPageHtml, handleWebTemplatesRoute } from './web-templates-workspace.ts'
import type { WebTemplatesPorts } from './web-templates-workspace.ts'
import type { AuthenticatedCaller } from './auth.ts'

const reseller = '11111111-1111-4111-8111-111111111111'
const setup = (over: Partial<WebTemplatesPorts> = {}, kind = 'root') => {
  const files: Record<string, unknown> = {}, apply = vi.fn(async () => ({ ok: true })), audit = vi.fn(async () => undefined)
  let body: Record<string, unknown> = {}
  const ports: WebTemplatesPorts = { requireCaller: async () => ({ principal: { kind, username: 'admin' } }) as AuthenticatedCaller, readJsonBody: async () => body, resellerOf: async () => kind === 'reseller' ? reseller : null,
    read: async scope => files[scope] ?? null, write: async (scope, value) => { files[scope] = value; return value }, apply, audit, now: () => new Date('2026-11-07T00:00:00.000Z'), ...over }
  const call = async (method: string, path = '/api/accounts/web-templates', input: Record<string, unknown> = {}) => {
    body = input
    const request = new Request('http://x' + path, { method })
    return await (await handleWebTemplatesRoute(request, new URL(request.url), method, ports))!.json() as Record<string, any>
  }
  return { files, apply, audit, call }
}

describe('Web Template Editor', () => {
  it('saves into the caller scope and publishes through the host', async () => {
    const { files, apply, call } = setup({}, 'reseller')
    const first = await call('GET')
    expect(first).toMatchObject({ scope: reseller, pages: { suspended: { state: 'shipped' } } })
    const saved = await call('PUT', '/api/accounts/web-templates/suspended', { html: '<h1>Closed</h1>', expectedRevision: first.revision })
    expect(saved).toMatchObject({ published: true, pages: { suspended: { state: 'custom', html: '<h1>Closed</h1>' } } })
    expect(Object.keys(files)).toEqual([reseller])
    expect(apply).toHaveBeenCalledOnce()
  })
  it('restores the shipped page and refuses a stale revision', async () => {
    const { call } = setup(), first = await call('GET')
    const saved = await call('PUT', '/api/accounts/web-templates/default', { html: 'x', expectedRevision: first.revision })
    await expect(call('PUT', '/api/accounts/web-templates/default', { html: 'y', expectedRevision: first.revision })).rejects.toMatchObject({ code: 'CONFLICT' })
    const reverted = await call('DELETE', '/api/accounts/web-templates/default', { expectedRevision: saved.revision })
    expect(reverted.pages.default.state).toBe('shipped')
    expect(reverted.pages.default.html).toBe(reverted.pages.default.shipped)
  })
  it('says so when the page is saved but the host did not publish it', async () => {
    const { call } = setup({ apply: async () => { throw new Error('agent') } }), first = await call('GET')
    expect(await call('PUT', '/api/accounts/web-templates/default', { html: 'x', expectedRevision: first.revision })).toMatchObject({ published: false, application: null })
  })
  it('never calls a page published without a host', async () => {
    const { call } = setup({ apply: async () => null }), first = await call('GET')
    expect(await call('PUT', '/api/accounts/web-templates/default', { html: 'x', expectedRevision: first.revision })).toMatchObject({ published: false, application: null })
  })
  it('bounds a page and refuses an account owner', async () => {
    expect(() => assertPageHtml('')).toThrow()
    expect(() => assertPageHtml('a'.repeat(64 * 1024 + 1))).toThrow()
    expect(() => assertPageHtml('a\u0000b')).toThrow()
    await expect(setup({}, 'user').call('GET')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
