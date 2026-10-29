// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWhmTrustedProxiesWorkspace } from './board-port/whm-trusted-proxies-workspace.ts'
import { readTrustedProxiesClientView, WHM_TRUSTED_PROXIES_CLIENT_BINDING } from './whm-trusted-proxies-client.ts'
const empty = { cidrs: [], header: 'X-Forwarded-For' }, policy = { cidrs: ['173.245.48.0/20'], header: 'X-Forwarded-For' }
const base = () => ({ state: 'default', policy: empty, updatedAt: null, revision: 'a'.repeat(64), application: 'saved_only', observation: { state: 'unavailable', active: null, activation: 'unavailable', reason: 'protected_native_provider_unavailable' } })
const saved = () => ({ ...base(), state: 'saved', policy, updatedAt: '2026-10-27T12:00:00.000Z', revision: 'b'.repeat(64) })
type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const boot = (send?: Send, locale: 'en' | 'ar' = 'en', canManage = true) => { delete (window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest; document.body.innerHTML = renderWhmTrustedProxiesWorkspace({ locale, canManage }); if (send) (window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest = send; new Function('return ' + WHM_TRUSTED_PROXIES_CLIENT_BINDING)()() }
afterEach(() => { document.body.innerHTML = '' })
describe('trusted proxy client', () => {
  it('strictly rejects invented applied states and inconsistent native availability', () => {
    expect(readTrustedProxiesClientView(base()).application).toBe('saved_only')
    expect(() => readTrustedProxiesClientView({ ...base(), application: 'active' })).toThrow()
    expect(() => readTrustedProxiesClientView({ ...base(), observation: { ...base().observation, activation: 'available' } })).toThrow()
    expect(() => readTrustedProxiesClientView({ ...saved(), policy: { ...policy, header: 'Forwarded' } })).toThrow()
  })
  it('does not send without authorization or transport; activation stays unavailable', async () => {
    const send = vi.fn<Send>(async () => base())
    boot(send, 'en', false); await flush(); expect(send).not.toHaveBeenCalled()
    boot(); await flush(); expect($('[data-trusted-proxies-status]').dataset.state).toBe('unavailable')
    boot(send); await flush(); expect($<HTMLButtonElement>('[data-trusted-proxies-apply]').disabled).toBe(true)
    expect(WHM_TRUSTED_PROXIES_CLIENT_BINDING).not.toContain('innerHTML')
  })
  it('saves the captured revision and independently verifies the saved-only result', async () => {
    let gets = 0
    const send = vi.fn<Send>(async method => method === 'PUT' || gets++ > 0 ? saved() : base())
    boot(send); await flush(); $<HTMLTextAreaElement>('[data-trusted-proxies-cidrs]').value = policy.cidrs[0]!
    $<HTMLFormElement>('[data-trusted-proxies-form]').dispatchEvent(new Event('submit', { cancelable: true })); await flush()
    expect(send).toHaveBeenCalledWith('PUT', '/api/server/trusted-proxies', { policy, expectedRevision: 'a'.repeat(64) })
    expect($('[data-trusted-proxies-save-status]').textContent).toContain('Active trust was not changed')
    expect($<HTMLButtonElement>('[data-trusted-proxies-apply]').disabled).toBe(true)
    expect($('[data-trusted-proxies-rows] bdi').getAttribute('dir')).toBe('ltr')
  })
  it('retains a conflicted draft and blocks automatic retries', async () => {
    const send = vi.fn<Send>(async method => { if (method === 'GET') return base(); throw { status: 409 } })
    boot(send); await flush(); $<HTMLTextAreaElement>('[data-trusted-proxies-cidrs]').value = policy.cidrs[0]!
    $<HTMLFormElement>('[data-trusted-proxies-form]').dispatchEvent(new Event('submit', { cancelable: true })); await flush()
    expect($<HTMLTextAreaElement>('[data-trusted-proxies-cidrs]').value).toBe(policy.cidrs[0])
    expect($<HTMLButtonElement>('[data-trusted-proxies-save]').disabled).toBe(true)
    expect($('[data-trusted-proxies-save-status]').textContent).toContain('Reload')
    expect(send.mock.calls).toHaveLength(2)
  })
  it('renders Arabic direction and ASCII digits with the full unavailable controls intact', async () => {
    boot(async () => saved(), 'ar'); await flush()
    expect($('[data-whm-trusted-proxies-workspace]').getAttribute('dir')).toBe('rtl')
    expect(document.body.textContent).not.toMatch(/[٠-٩۰-۹]/)
    expect($('[data-trusted-proxies-confirm]')).not.toBeNull()
    expect($<HTMLButtonElement>('[data-trusted-proxies-apply]').disabled).toBe(true)
  })
})

describe('complete trusted proxy timestamps', () => {
  it.each(['en', 'ar'] as const)('preserves the complete saved instant without activation in %s', async locale => {
    const instant = '2026-10-27T12:13:14.567Z'
    const send = vi.fn<Send>(async () => ({ ...saved(), updatedAt: instant }))
    boot(send, locale); await flush()
    const timestamp = $('[data-trusted-proxies-field="updated"] bdi')
    expect(timestamp.textContent).toBe('2026-10-27 12:13 UTC')
    expect(timestamp.getAttribute('dir')).toBe('ltr')
    expect(send.mock.calls).toEqual([['GET', '/api/server/trusted-proxies']])
    expect($<HTMLButtonElement>('[data-trusted-proxies-apply]').disabled).toBe(true)
  })
})
