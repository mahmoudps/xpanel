// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderAccountCacheWorkspace, renderAccountContainersWorkspace, renderRuntimeAppsSection } from './board-port/account-runtime-workspace.ts'
import { ACCOUNT_RUNTIME_CLIENT_BINDING, readAccountRuntimeView } from './account-runtime-client.ts'

const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', DOMAIN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const view = (patch: Record<string, unknown> = {}) => ({
  context: { accountId: ACCOUNT, username: 'alice', home: '/home/alice' }, revision: '1'.repeat(64),
  plan: { apps: true, cache: true, containers: true, cacheMaxMb: 256, memoryMb: 1024, cpuPercent: 100, maxProcesses: 128, maxApps: 10, maxContainers: 5 },
  host: { runtimes: [{ kind: 'node', available: true, version: '18.19.1', reason: null }, { kind: 'python', available: true, version: '3.12.3', reason: null }, { kind: 'ruby', available: false, version: null, reason: 'not-installed' }],
    cache: [{ service: 'redis', available: true, version: '7.0.15', binary: '/usr/bin/redis-server', reason: null }, { service: 'memcached', available: false, version: null, binary: null, reason: 'not-installed' }],
    containers: { available: false, version: '4.9.3', reason: 'no-subordinate-ids' } },
  domains: [{ id: DOMAIN, name: 'alice-shop.com' }],
  apps: [{ name: 'shop', runtime: 'node', root: 'apps/shop', startup: 'server.js', domainId: DOMAIN, path: '/api', env: [{ name: 'TOKEN', value: 'x' }], enabled: true, state: 'running', since: '2026-10-29T01:00:00.000Z', restarts: 0, health: 200, deps: 'succeeded', preflight: [], updatedAt: '2026-10-29T00:00:00.000Z' }],
  cache: [{ service: 'redis', enabled: false, memoryMb: null, socket: '/home/alice/.xpanel-cache/redis.sock', state: 'stopped', since: null, memoryBytes: null, updatedAt: null },
    { service: 'memcached', enabled: false, memoryMb: null, socket: '/home/alice/.xpanel-cache/memcached.sock', state: 'stopped', since: null, memoryBytes: null, updatedAt: null }],
  imageCleanup: 'none', containers: [], ...patch,
})
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const boot = async (html: string, send: (method: string, path: string, body?: unknown) => Promise<unknown>, ask = vi.fn(async () => true)) => {
  document.documentElement.lang = 'en'
  document.body.innerHTML = html
  ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
  new Function('return ' + ACCOUNT_RUNTIME_CLIENT_BINDING)()(ask)
  await tick()
  return ask
}
const click = (el: Element | null) => (el as HTMLElement).click()
afterEach(() => { document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('account runtime client', () => {
  it('pads the containers and cache cards 24px from 768px, scoped to those two pages', () => {
    const rule = '@media(min-width:768px){:is([data-runtime-workspace=containers],[data-runtime-workspace=cache]) .xp-acct-tool__card{padding:var(--xp-space-card)}}'
    for (const html of [renderAccountContainersWorkspace({ lang: 'ar', canManage: true }), renderAccountCacheWorkspace({ lang: 'en', canManage: true })]) expect(html).toContain(rule)
    expect(renderAccountCacheWorkspace({ lang: 'en', canManage: true })).toContain('data-runtime-workspace="cache"')
    expect(renderAccountContainersWorkspace({ lang: 'en', canManage: true })).toContain('data-runtime-workspace="containers"')
  })

  it('accepts only views of its grammar', () => {
    expect(readAccountRuntimeView(view()).apps[0]!.name).toBe('shop')
    expect(() => readAccountRuntimeView(view({ cache: [] }))).toThrow()
    expect(() => readAccountRuntimeView({ ...view(), extra: 1 })).toThrow()
  })

  it('paints apps with versions and health, edits an app and saves it with the read revision', async () => {
    const send = vi.fn(async (method: string, _path: string, _body?: unknown) => method === 'GET' ? view() : { op: 'app.save', revision: '2'.repeat(64), changed: true })
    await boot(renderRuntimeAppsSection({ lang: 'en', canManage: true }), send)
    expect(document.querySelector('[data-runtime-version="node"]')!.textContent).toBe('Version 18.19.1')
    expect(document.querySelector('[data-runtime-version="ruby"]')!.textContent).toBe('Not installed')
    expect(document.querySelector('[data-runtime-apps]')!.textContent).toContain('alice-shop.com/api')
    click(document.querySelector('[data-runtime-row="edit"]'))
    expect((document.querySelector('[data-runtime-input="root"]') as HTMLInputElement).value).toBe('apps/shop')
    click(document.querySelector('[data-runtime-action="app-save"]'))
    await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/account/runtime', { op: 'app.save', expectedRevision: '1'.repeat(64), app: { name: 'shop', runtime: 'node', root: 'apps/shop', startup: 'server.js', domainId: DOMAIN, path: '/api', env: { TOKEN: 'x' } } })
  })

  it('enables Redis within the plan cap and refuses an out-of-plan memory limit locally', async () => {
    const send = vi.fn(async (method: string) => method === 'GET' ? view() : { op: 'cache.save', revision: '2'.repeat(64), changed: true })
    await boot(renderAccountCacheWorkspace({ lang: 'en', canManage: true }), send)
    expect(document.querySelector('[data-runtime-cache]')!.textContent).toContain('/home/alice/.xpanel-cache/redis.sock')
    click(document.querySelector('[data-runtime-row="cache.enable"][data-runtime-name="redis"]'))
    await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/account/runtime', { op: 'cache.save', service: 'redis', enabled: true, memoryMb: 64, expectedRevision: '1'.repeat(64) })
    expect((document.querySelector('[data-runtime-row="cache.enable"][data-runtime-name="memcached"]') as HTMLButtonElement).disabled).toBe(true)
    ;(document.querySelector('[data-runtime-input="memory"]') as HTMLInputElement).value = '512'
    send.mockClear()
    click(document.querySelector('[data-runtime-action="cache-save"]'))
    await tick()
    expect(send).not.toHaveBeenCalledWith('POST', expect.anything(), expect.anything())
    expect(document.querySelector('[data-runtime-status]')!.textContent).toContain('8 to 256 MB')
  })

  it('reports the missing container prerequisite and keeps running disabled', async () => {
    await boot(renderAccountContainersWorkspace({ lang: 'en', canManage: true }), async () => view())
    expect(document.querySelector('[data-runtime-stat="engine"]')!.textContent).toBe('Unavailable: no subordinate IDs for this account')
    expect((document.querySelector('[data-runtime-action="ctr-run"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows what an app still needs with its fix and keeps Start disabled until it is ready', async () => {
    const pending = view({ apps: [{ ...view().apps[0], enabled: false, state: 'stopped', since: null, health: null, preflight: ['venv-missing'], runtime: 'python', startup: 'passenger_wsgi.py' }] })
    await boot(renderRuntimeAppsSection({ lang: 'en', canManage: true }), async () => pending)
    expect(document.querySelector('[data-runtime-apps]')!.textContent).toContain('Needs setup')
    expect((document.querySelector('[data-runtime-row="app.start"]') as HTMLButtonElement).disabled).toBe(true)
    click(document.querySelector('[data-runtime-row="edit"]'))
    expect(document.querySelector('[data-runtime-preflight]')!.textContent).toBe('The Python environment .venv is missing. Run Install dependencies.')
  })

  it('reclaims image space after confirmation and shows the cleanup state', async () => {
    const send = vi.fn(async (method: string) => method === 'GET' ? view({ host: { ...view().host, containers: { available: true, version: '4.9.3', reason: null } }, imageCleanup: 'succeeded' }) : { op: 'container.prune', revision: '2'.repeat(64), changed: false })
    const ask = await boot(renderAccountContainersWorkspace({ lang: 'en', canManage: true }), send)
    expect(document.querySelector('[data-runtime-stat="cleanup"]')!.textContent).toBe('Succeeded')
    click(document.querySelector('[data-runtime-action="ctr-prune"]'))
    await tick()
    expect(ask).toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith('POST', '/api/account/runtime', { op: 'container.prune', expectedRevision: '1'.repeat(64) })
  })

  it('stays unread and unbound without permission', async () => {
    const send = vi.fn(async () => view())
    await boot(renderAccountCacheWorkspace({ lang: 'en', canManage: false }), send)
    expect(send).not.toHaveBeenCalled()
    expect(document.querySelector('[data-runtime-status]')!.getAttribute('data-state')).toBe('unavailable')
  })
})
