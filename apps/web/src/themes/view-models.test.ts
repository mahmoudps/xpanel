import { expect, it } from 'vitest'
import { unavailableView, type WebAppRenderState } from '../app.ts'

const account = {
  id: '11111111-1111-4111-8111-111111111111', ownerId: null, username: 'owner',
  primaryDomain: 'site.example.test', status: 'active' as const, planId: '22222222-2222-4222-8222-222222222222',
}
const owner = { kind: 'user' as const, id: account.id, accountId: account.id, username: account.username }
const state = (changes: Partial<WebAppRenderState> = {}): WebAppRenderState => ({
  surface: 'xpanel', visibility: { principal: owner, disabledFeatures: new Set() },
  workspaceSummary: { account }, ...changes,
})
const model = (input: WebAppRenderState, route = '/software/store') => unavailableView(input, 'en', 'light', 'comfortable', route)

it('does not forward a provider record without an authenticated principal', () => {
  const view = model(state({ visibility: undefined }))
  expect(view.admitted).toBe(false)
  expect(view.summary).toBeUndefined()
  expect(view.storeAccount).toBeUndefined()
  expect(view.session).toBeUndefined()
})

it('keeps another tenant out of the summary and the store target', () => {
  const view = model(state({ workspaceSummary: { account: { ...account, id: '44444444-4444-4444-8444-444444444444', primaryDomain: 'other.example.test' } } }))
  expect(view.summary?.accountEmpty).toBe(true)
  expect(view.summary?.fields.map(field => field.value)).not.toContain('other.example.test')
  expect(view.storeAccount).toBeUndefined()
})

it('passes only the active owning account identity needed by the read-only store', () => {
  const view = model(state())
  expect(view.admitted).toBe(true)
  expect(view.storeAccount).toEqual({ id: account.id, status: 'active' })
  expect(view.summary?.fields.find(field => field.key === 'primary-domain')?.value).toBe(account.primaryDomain)
})

it('does not pass store targets to denied or security documents', () => {
  const denied = model(state(), '/whm/accounts')
  expect(denied.admitted).toBe(false)
  expect(denied.storeAccount).toBeUndefined()
  const security = model(state(), '/security/account')
  expect(security.securityPage).toBe(true)
  expect(security.storeAccount).toBeUndefined()
  expect(security.summary).toBeUndefined()
})

it('preserves the suspended-account summary without admitting a store target', () => {
  const view = model(state({ workspaceSummary: { account: { ...account, status: 'suspended' } } }))
  expect(view.summary?.accountEmpty).toBe(false)
  expect(view.summary?.fields.find(field => field.key === 'status')?.value).toBe('Suspended')
  expect(view.storeAccount).toBeUndefined()
})

it('keeps the optional MFA presentation decision in core', () => {
  const root: WebAppRenderState = {
    surface: 'xwhm', visibility: { principal: { kind: 'root', id: '33333333-3333-4333-8333-333333333333', username: 'root' }, disabledFeatures: new Set() },
    security: { totpEnabled: false }, mfaRuntimeMode: 'optional',
  }
  expect(model(root, '/whm').summary?.mfaHref).toBe('/whm/security/sign-in')
  expect(model({ ...root, mfaRuntimeMode: 'disabled' }, '/whm').summary?.mfaHref).toBeUndefined()
})
