// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWhmNginxProxyWorkspace } from './board-port/whm-nginx-proxy-workspace.ts'
import { readNginxProxyView, WHM_NGINX_PROXY_CLIENT_BINDING } from './whm-nginx-proxy-client.ts'

const rev = (char: string): string => char.repeat(64)
const overview = (enabled = true, extra: Record<string, unknown> = {}) => ({ accounts: [{ id: '1', username: 'alice', primaryDomain: 'alice.example', rules: 1, cache: { state: 'default', revision: rev('c'), enabled, purgedAt: null } }, { id: '2', username: 'bob', primaryDomain: 'bob.example', rules: 0, cache: { state: 'saved', revision: rev('d'), enabled: true, purgedAt: '2026-11-07T10:00:00.000Z' } }], domains: [{ name: 'alice.example', account: 'alice' }, { name: 'bob.example', account: 'bob' }], ...extra })
const domain = (name: string, rules: unknown[], revision = 'a', extra: Record<string, unknown> = {}) => ({ domain: { name, account: 'alice', siteType: 'php' }, state: rules.length ? 'saved' : 'default', revision: rev(revision), limit: 64, updatedAt: null, rules, ...extra })
const rule = { path: '/app', target: 'https://203.0.113.7:9443', websocket: true, hostHeader: 'client', refusal: null }
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
afterEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; document.body.replaceChildren(); vi.restoreAllMocks() })
const boot = (request: (method: string, path: string, body?: unknown) => Promise<unknown>, confirm: unknown = async () => true, canManage = true) => {
  ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  document.body.innerHTML = renderWhmNginxProxyWorkspace({ locale: 'en', canManage })
  ;(new Function('return ' + WHM_NGINX_PROXY_CLIENT_BINDING)() as (confirm: unknown) => void)(confirm)
}
const $ = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!

describe('WHM NGINX reverse proxy page', () => {
  it('reads the domains, adds a rule with the read revision and removes one after confirmation', async () => {
    const confirm = vi.fn(async () => true)
    const request = vi.fn(async (method: string, path: string, body?: unknown) => {
      if (method === 'GET') return path === '/api/server/nginx-proxy' ? overview() : domain('alice.example', [])
      return (body as { add?: unknown }).add ? domain('alice.example', [rule], 'b', { reconcile: 'requested' }) : domain('alice.example', [], 'c', { reconcile: 'not_connected' })
    })
    boot(request, confirm)
    await vi.waitFor(() => expect($('[data-np-status]').getAttribute('data-state')).toBe('read'))
    expect($('[data-np-rows]').textContent).toBe('This domain has no reverse proxy rules.')
    expect([...document.querySelectorAll('[data-np-accounts] tr')].map(row => row.querySelector('bdi')!.textContent)).toEqual(['alice', 'bob'])
    $<HTMLInputElement>('[data-np-path]').value = '/app'; $<HTMLInputElement>('[data-np-target]').value = rule.target
    $<HTMLButtonElement>('[data-np-add]').click()
    await vi.waitFor(() => expect($('[data-np-status]').getAttribute('data-state')).toBe('saved'))
    expect(request).toHaveBeenLastCalledWith('POST', '/api/server/nginx-proxy/domains/alice.example', { expectedRevision: rev('a'), add: { path: '/app', target: rule.target, websocket: true, hostHeader: 'client' } })
    expect($('[data-np-status]').textContent).toBe('Saved. The server is testing the configuration and applying it.')
    expect($<HTMLInputElement>('[data-np-path]').value).toBe('')
    expect($('[data-np-count]').textContent).toContain('1 rule')
    document.querySelector<HTMLButtonElement>('[data-np-rows] button')!.click()
    await vi.waitFor(() => expect($('[data-np-status]').getAttribute('data-state')).toBe('warning'))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenLastCalledWith('POST', '/api/server/nginx-proxy/domains/alice.example', { expectedRevision: rev('b'), remove: '/app' })
    expect($('[data-np-status]').textContent).toBe('Saved. No host agent is connected, so nothing is applied yet.')
  })

  it('names a refused target without saving and locks after an uncertain outcome', async () => {
    let calls = 0
    const request = vi.fn(async (method: string, path: string) => {
      if (method === 'GET') return path === '/api/server/nginx-proxy' ? overview() : domain('alice.example', [])
      if (++calls === 1) throw Object.assign(new Error('refused'), { details: { stateChanged: false, fields: [{ field: 'target', code: 'panel_port' }] } })
      throw Object.assign(new Error('lost'), { details: { stateChanged: true } })
    })
    boot(request)
    await vi.waitFor(() => expect($('[data-np-status]').getAttribute('data-state')).toBe('read'))
    $<HTMLInputElement>('[data-np-path]').value = '/x'; $<HTMLInputElement>('[data-np-target]').value = 'http://203.0.113.7:2083'
    $<HTMLButtonElement>('[data-np-add]').click()
    await vi.waitFor(() => expect($('[data-np-status]').getAttribute('data-state')).toBe('fields'))
    expect($('[data-np-error]').textContent).toBe('A rule cannot reach a panel or web backend port.')
    expect($<HTMLButtonElement>('[data-np-add]').disabled).toBe(false)
    $<HTMLButtonElement>('[data-np-add]').click()
    await vi.waitFor(() => expect($('[data-np-status]').getAttribute('data-state')).toBe('uncertain'))
    expect($<HTMLButtonElement>('[data-np-add]').disabled).toBe(true)
  })

  it('shows a saved rule the server no longer admits', async () => {
    boot(vi.fn(async (_method: string, path: string) => path === '/api/server/nginx-proxy' ? overview() : domain('alice.example', [{ ...rule, refusal: 'panel_port' }])))
    await vi.waitFor(() => expect($('[data-np-rows]').textContent).toContain('A rule cannot reach a panel or web backend port.'))
  })

  it('switches one account, then the filtered list, with each read revision', async () => {
    const request = vi.fn(async (method: string, path: string) => method === 'GET' ? path === '/api/server/nginx-proxy' ? overview() : domain('alice.example', []) : overview(false, { changed: 1, reconcile: 'requested' }))
    boot(request)
    await vi.waitFor(() => expect($('[data-np-cache-status]').getAttribute('data-state')).toBe('read'))
    await vi.waitFor(() => expect($<HTMLButtonElement>('[data-np-accounts] [data-xp-action="toggle"]').disabled).toBe(false))
    $<HTMLButtonElement>('[data-np-accounts] [data-xp-action="toggle"]').click()
    await vi.waitFor(() => expect($('[data-np-cache-status]').getAttribute('data-state')).toBe('saved'))
    expect(request).toHaveBeenLastCalledWith('POST', '/api/server/nginx-proxy/cache', { op: 'disable', accounts: [{ username: 'alice', expectedRevision: rev('c') }] })
    expect($('[data-np-accounts] tr').textContent).toContain('Turn on')
    const filter = $<HTMLInputElement>('[data-np-filter]'); filter.value = 'bob'; filter.dispatchEvent(new Event('input'))
    expect(document.querySelectorAll('[data-np-accounts] tr')).toHaveLength(1)
    $<HTMLButtonElement>('[data-np-all-purge]').click()
    await vi.waitFor(() => expect(request).toHaveBeenLastCalledWith('POST', '/api/server/nginx-proxy/cache', { op: 'purge', accounts: [{ username: 'bob', expectedRevision: rev('d') }] }))
  })

  it('reads and sends nothing without management authority', async () => {
    const request = vi.fn(async () => overview())
    boot(request, async () => true, false)
    await tick()
    expect(request).not.toHaveBeenCalled()
    expect($('[data-np-status]').getAttribute('data-state')).toBe('unavailable')
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-nginx-proxy] button')) expect(button.disabled).toBe(true)
  })

  it('rejects replies of the wrong shape', () => {
    expect(() => readNginxProxyView({ accounts: [], domains: [{ name: 1 }] }, 'overview')).toThrow()
    expect(() => readNginxProxyView(domain('other.example', []), 'domain', 'alice.example')).toThrow()
    expect(() => readNginxProxyView(domain('alice.example', [{ ...rule, hostHeader: 'x' }]), 'domain', 'alice.example')).toThrow()
    expect(readNginxProxyView(domain('alice.example', [rule]), 'domain', 'alice.example')).toMatchObject({ rules: [rule] })
  })
})
