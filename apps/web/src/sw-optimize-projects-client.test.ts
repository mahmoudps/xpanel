// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderSwOptimizeWorkspace } from './board-port/sw-optimize-workspace.ts'
import { renderSwAppProjectsWorkspace } from './board-port/sw-app-projects-workspace.ts'
import { SW_OPTIMIZE_CLIENT_BINDING } from './sw-optimize-client.ts'
import { readSwProjectRuntimes, SW_APP_PROJECTS_CLIENT_BINDING } from './sw-app-projects-client.ts'
import { handleSwOptimizeWorkspaceRoute } from '../../api/src/sw-optimize-workspace.ts'

const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const optimize = (state: 'read' | 'unavailable' = 'read') => ({ context: { accountId: 'acc-1', username: 'alice' }, state, reason: state === 'read' ? null : 'edge-config-unavailable', policy: state === 'read' ? { compression: 'on', types: ['text/html', 'text/css'], minLength: 1024, proxied: ['any'], cache: { configured: true, maxSize: '1024m' } } : null, domains: [{ name: 'a.example', redirect: false, suspended: false }, { name: 'b.example', redirect: true, suspended: false }], actions: { siteCompression: false, siteCache: false, purge: false } })
const runtimes = { page: 'runtime', state: 'read', components: [{ id: 'golang', state: 'installed', installed: [{ name: 'golang-go', versions: ['2:1.22~2'] }] }, { id: 'openjdk-17', state: 'absent', installed: [] }, { id: 'nodejs', state: 'installed', installed: [] }] }
const boot = (binding: string, send: (method: string, path: string) => Promise<unknown>) => { (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send; new Function('return ' + binding)()() }
beforeEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('website optimization workspace', () => {
  it('paints the observed policy per site and keeps per-site rules and purge disabled', async () => {
    document.body.innerHTML = renderSwOptimizeWorkspace({ lang: 'en', canRead: true })
    const send = vi.fn(async () => optimize()); boot(SW_OPTIMIZE_CLIENT_BINDING, send); await tick()
    expect(send).toHaveBeenCalledWith('GET', '/api/account/optimize')
    expect(document.querySelector('[data-sw-optimize-cache]')!.textContent).toBe('On, up to 1024m')
    expect(document.querySelector('[data-sw-optimize-types]')!.textContent).toBe('text/html, text/css')
    expect([...document.querySelectorAll('[data-sw-optimize-domains] tr')].map(row => row.children[2]!.textContent)).toEqual(['Cached when eligible', 'Not cached: redirect'])
    expect([...document.querySelectorAll<HTMLButtonElement>('button:not([data-sw-optimize-refresh])')].every(button => button.disabled)).toBe(true)
  })
  it('states unavailable edge configuration truthfully and renders RTL with ASCII digits', async () => {
    document.body.innerHTML = renderSwOptimizeWorkspace({ lang: 'ar', canRead: true })
    expect(document.querySelector<HTMLElement>('[data-sw-optimize]')!.dir).toBe('rtl')
    boot(SW_OPTIMIZE_CLIENT_BINDING, vi.fn(async () => optimize('unavailable'))); await tick()
    expect(document.querySelector('[data-sw-optimize-status]')!.getAttribute('data-state')).toBe('unavailable')
    expect(document.querySelector('[data-sw-optimize-domains]')!.textContent).toContain('a.example')
    expect(document.body.textContent).not.toMatch(/[٠-٩۰-۹]/)
  })
  it('the API pins the session account', async () => {
    const account = { id: 'acc-1', username: 'alice', status: 'active', planId: 'p' }
    const ports = { store: { getAccount: async () => account, getPlan: async () => ({ featureListId: 'f' }), getFeatureList: async () => ({ disabled: [] }) } as never, requireCaller: async () => ({ principal: { kind: 'user', id: 'u1', accountId: 'acc-1', username: 'alice' }, scopes: [] }) as never, readAgent: vi.fn(async () => ({ ...optimize(), context: { accountId: 'acc-2', username: 'alice' } })) as never }
    const url = new URL('http://api.local/api/account/optimize')
    await expect(handleSwOptimizeWorkspaceRoute(new Request(url), url, 'GET', ports)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(handleSwOptimizeWorkspaceRoute(new Request(new URL('http://api.local/api/account/optimize?purge=1')), new URL('http://api.local/api/account/optimize?purge=1'), 'GET', ports)).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})

describe('Go and Java projects workspace', () => {
  it('reads Go and Java runtime states from the software center and keeps project controls disabled', async () => {
    document.body.innerHTML = renderSwAppProjectsWorkspace({ locale: 'en', canRead: true })
    const send = vi.fn(async () => runtimes); boot(SW_APP_PROJECTS_CLIENT_BINDING, send); await tick()
    expect(send).toHaveBeenCalledWith('GET', '/api/server/software-center?page=runtime')
    const rows = [...document.querySelectorAll('[data-sw-projects-runtimes] tr')].map(row => [...row.children].map(cell => cell.textContent))
    expect(rows).toEqual([['Go', 'Installed', '2:1.22~2'], ['OpenJDK 17', 'Not installed', 'None']])
    expect(document.querySelectorAll('button:disabled').length).toBe(3)
    expect(() => readSwProjectRuntimes({ ...runtimes, page: 'catalog' })).toThrow()
  })
  it('never echoes transport errors', async () => {
    document.body.innerHTML = renderSwAppProjectsWorkspace({ locale: 'ar', canRead: true })
    boot(SW_APP_PROJECTS_CLIENT_BINDING, vi.fn(async () => { throw new Error('private-detail') })); await tick()
    expect(document.body.textContent).not.toContain('private-detail'); expect(document.querySelector('[data-sw-projects-status]')!.getAttribute('data-state')).toBe('failed')
  })
})
