// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACCOUNT_EDGE_CLIENT_BINDING, readAccountEdgeView } from './account-edge-client.ts'
import { renderAccountEdgeCacheCard, renderAccountIpBlockerWorkspace } from './board-port/account-edge-workspace.ts'

const accountId = '11111111-1111-4111-8111-111111111111'
const ipb = (entries: { entry: string; first: string; last: string }[], extra: Record<string, unknown> = {}) => ({ context: { accountId, username: 'alice' }, state: entries.length ? 'saved' : 'default', revision: (entries.length ? 'b' : 'a').repeat(64), limit: 1000, updatedAt: null, entries, ...extra })
const cache = (enabled: boolean, purgedAt: string | null, extra: Record<string, unknown> = {}) => ({ context: { accountId, username: 'alice' }, state: 'saved', revision: (enabled ? 'c' : 'd').repeat(64), enabled, purgedAt, updatedAt: null, ...extra })
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
afterEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; document.body.replaceChildren(); vi.restoreAllMocks() })
const boot = (html: string, request: (method: string, path: string, body?: unknown) => Promise<unknown>, confirm: unknown = async () => true) => {
  ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  document.body.innerHTML = html
  ;(new Function('return ' + ACCOUNT_EDGE_CLIENT_BINDING)() as (confirm: unknown) => void)(confirm)
}
const $ = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!

describe('account IP blocker and cache controls', () => {
  it('reads the list, adds an entry with the read revision and removes one after confirmation', async () => {
    const added = [{ entry: '10.5.3.3', first: '10.5.3.3', last: '10.5.3.3' }, { entry: '10.5.3.4/30', first: '10.5.3.4', last: '10.5.3.7' }]
    const request = vi.fn(async (method: string, _path: string, body?: unknown) => method === 'GET' ? ipb([]) : (body as { add?: string }).add ? ipb(added, { reconcile: 'requested' }) : ipb(added.slice(1), { reconcile: 'not_connected', revision: 'e'.repeat(64) }))
    const confirm = vi.fn(async () => true)
    boot(renderAccountIpBlockerWorkspace({ lang: 'en', accountId, canManage: true }), request, confirm)
    await vi.waitFor(() => expect($('[data-ipb-status]').getAttribute('data-state')).toBe('read'))
    expect($('[data-ipb-rows]').textContent).toBe('No addresses are blocked.')
    const input = $<HTMLInputElement>('[data-ipb-input]'); input.value = '10.5.3.3-7'; $<HTMLButtonElement>('[data-ipb-add]').click()
    await vi.waitFor(() => expect($('[data-ipb-status]').getAttribute('data-state')).toBe('saved'))
    expect(request).toHaveBeenNthCalledWith(2, 'POST', '/api/account/ip-blocker', { expectedRevision: 'a'.repeat(64), add: '10.5.3.3-7' })
    expect([...document.querySelectorAll('[data-ipb-rows] tr')].map(row => row.textContent)).toEqual(['10.5.3.310.5.3.310.5.3.3Remove', '10.5.3.4/3010.5.3.410.5.3.7Remove'])
    expect(input.value).toBe(''); expect($('[data-ipb-count]').textContent).toBe('2 blocks of 1000')
    document.querySelector<HTMLButtonElement>('[data-ipb-rows] button')!.click()
    await vi.waitFor(() => expect($('[data-ipb-status]').getAttribute('data-state')).toBe('warning'))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenNthCalledWith(3, 'POST', '/api/account/ip-blocker', { expectedRevision: 'b'.repeat(64), remove: '10.5.3.3' })
    expect($('[data-ipb-status]').textContent).toBe('Saved. No host agent is connected, so nothing is applied yet.')
  })
  it('shows a refused field without saving and locks after an uncertain outcome', async () => {
    let calls = 0
    const request = vi.fn(async (method: string) => {
      if (method === 'GET') return ipb([])
      calls++
      throw calls === 1 ? { status: 422, details: { stateChanged: false, fields: [{ field: 'add', code: 'protected_address' }] } } : { status: 503, details: { stateChanged: true, unknownOutcome: true } }
    })
    boot(renderAccountIpBlockerWorkspace({ lang: 'en', accountId, canManage: true }), request)
    await vi.waitFor(() => expect($('[data-ipb-status]').getAttribute('data-state')).toBe('read'))
    $<HTMLInputElement>('[data-ipb-input]').value = '127.0.0.1'; $<HTMLButtonElement>('[data-ipb-add]').click()
    await vi.waitFor(() => expect($('[data-ipb-status]').getAttribute('data-state')).toBe('fields'))
    expect($('[data-ipb-error]').textContent).toContain('Loopback'); expect($<HTMLButtonElement>('[data-ipb-add]').disabled).toBe(false)
    $<HTMLButtonElement>('[data-ipb-add]').click()
    await vi.waitFor(() => expect($('[data-ipb-status]').getAttribute('data-state')).toBe('uncertain'))
    expect($<HTMLButtonElement>('[data-ipb-add]').disabled).toBe(true); expect($<HTMLButtonElement>('[data-ipb-refresh]').disabled).toBe(false)
  })
  it('purges and switches the cache with the read revision', async () => {
    const request = vi.fn(async (method: string, _path: string, body?: unknown) => method === 'GET' ? cache(true, null) : (body as { op: string }).op === 'purge' ? cache(true, '2026-11-07T10:05:00.000Z', { reconcile: 'requested' }) : cache(false, '2026-11-07T10:05:00.000Z', { reconcile: 'requested' }))
    boot(renderAccountEdgeCacheCard({ lang: 'en', accountId, canManage: true }), request)
    await vi.waitFor(() => expect($('[data-edge-cache-status]').getAttribute('data-state')).toBe('read'))
    expect($('[data-edge-cache-state]').textContent).toBe('On for your sites'); expect($('[data-edge-cache-purged]').textContent).toBe('Never')
    $<HTMLButtonElement>('[data-edge-cache-purge]').click()
    await vi.waitFor(() => expect($('[data-edge-cache-purged]').textContent).toBe('2026-11-07 10:05 UTC'))
    expect(request).toHaveBeenNthCalledWith(2, 'POST', '/api/account/edge-cache', { expectedRevision: 'c'.repeat(64), op: 'purge' })
    $<HTMLButtonElement>('[data-edge-cache-toggle]').click()
    await vi.waitFor(() => expect($('[data-edge-cache-state]').textContent).toBe('Off for your sites'))
    expect(request).toHaveBeenNthCalledWith(3, 'POST', '/api/account/edge-cache', { expectedRevision: 'c'.repeat(64), op: 'disable' })
    expect($<HTMLButtonElement>('[data-edge-cache-purge]').disabled).toBe(true); expect($('[data-edge-cache-toggle]').textContent).toBe('Turn the cache on')
  })
  it('stays inert without management admission and rejects foreign or malformed replies', () => {
    const request = vi.fn(async () => ({}))
    boot(renderAccountIpBlockerWorkspace({ lang: 'ar', accountId, canManage: false }) + renderAccountEdgeCacheCard({ lang: 'ar', accountId, canManage: false }), request)
    expect(request).not.toHaveBeenCalled()
    expect($('[data-ipb-status]').getAttribute('data-state')).toBe('unavailable'); expect($('[data-edge-cache-status]').getAttribute('data-state')).toBe('unavailable')
    expect(document.body.innerHTML).not.toMatch(/[٠-٩۰-۹]/); expect($<HTMLElement>('[data-ip-blocker]').dir).toBe('rtl')
    expect(() => readAccountEdgeView({ ...ipb([]), context: { accountId: '22222222-2222-4222-8222-222222222222', username: 'alice' } }, 'ip-blocker', accountId)).toThrow()
    expect(() => readAccountEdgeView(ipb([{ entry: '<b>', first: '1', last: '2' }]), 'ip-blocker', accountId)).toThrow()
    expect(() => readAccountEdgeView({ ...cache(true, null), enabled: 'yes' }, 'cache', accountId)).toThrow()
    expect(ACCOUNT_EDGE_CLIENT_BINDING).not.toContain('innerHTML')
  })
})
