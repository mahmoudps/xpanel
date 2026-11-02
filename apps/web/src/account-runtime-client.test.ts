// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderAccountCacheWorkspace, renderAccountContainersWorkspace, renderRuntimeAppsSection } from './board-port/account-runtime-workspace.ts'
import { ACCOUNT_RUNTIME_CLIENT_BINDING, readAccountRuntimeView } from './account-runtime-client.ts'
import type { Account } from '@xpanel/core'
import { renderV2AccountRuntimePage } from './themes/v2/pages/xpanel/operations/runtime.ts'

// Keep the real catalog parser while supplying Node file URLs in this DOM test realm.
vi.mock('./themes/v2/messages.ts', async () => {
  const { createThemeMessages } = await import('./theme-messages.ts')
  const { readFileSync } = await import('node:fs')
  const { URL: NodeURL, fileURLToPath } = await import('node:url')
  const read = (locale: string) => readFileSync(fileURLToPath(new NodeURL(`./themes/v2/locales/${locale}.po`, import.meta.url)), 'utf8')
  return { v2Messages: createThemeMessages('v2', read('en'), { ar: read('ar') }) }
})

const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', DOMAIN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const account: Account = { id: ACCOUNT, username: 'alice', uid: 20001, gid: 20001, home: '/home/alice', primaryDomain: 'alice-shop.com', planId: 'plan', ownerId: null, status: 'active', suspendReason: null, contactEmail: '', ipv4: '192.0.2.10', shell: 'jailed', createdAt: '2026-10-29T00:00:00Z' }
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
  it.each(['apps', 'containers', 'cache'] as const)('fills the selected v2 %s row/action templates without classic presentation classes', async kind => {
    const html = renderV2AccountRuntimePage({ locale: 'en', account }, kind, { canRead: true, canManage: true })
    const state = kind === 'containers' ? view({ containers: [{ name: 'web', image: 'docker.io/library/nginx:1.26', envKeys: [], enabled: false, state: 'stopped', since: null, memoryBytes: null, cpuNs: null, restarts: null, updatedAt: '2026-10-29T00:00:00.000Z' }] }) : view()
    await boot(html, async () => state)
    const body = document.querySelector<HTMLElement>(`[data-runtime-${kind === 'apps' ? 'apps' : kind === 'containers' ? 'containers' : 'cache'}]`)!
    expect(body.querySelectorAll('tr')).toHaveLength(kind === 'cache' ? 2 : 1)
    expect(body.querySelector('tr')!.children).toHaveLength(6)
    expect(body.querySelector('[data-runtime-row]')?.classList.contains('v2-btn')).toBe(true)
    expect(body.querySelector('[class*="xp-"]')).toBeNull()
    if (kind === 'apps') {
      click(body.querySelector('[data-runtime-row="edit"]'))
      const environment = document.querySelector('[data-runtime-env]')!
      expect(environment.querySelector<HTMLInputElement>('[data-xp-slot="name"]')!.value).toBe('TOKEN')
      expect(environment.querySelector('[class*="xp-"]')).toBeNull()
      expect(environment.querySelector('input')?.getAttribute('dir')).toBe('ltr')
    }
  })
  it('rejects a duplicate runtime template before requesting the account view', async () => {
    const holder = document.createElement('div'); holder.innerHTML = renderRuntimeAppsSection({ lang: 'en', canManage: true })
    const root = holder.querySelector<HTMLElement>('[data-runtime-workspace]')!, template = root.querySelector('template[data-xp-template="runtime-apps-row"]')!
    root.append(template.cloneNode(true))
    const send = vi.fn(async () => view()); await boot(holder.innerHTML, send)
    expect(send).not.toHaveBeenCalled()
    expect(document.querySelector('[data-runtime-status]')!.getAttribute('data-state')).toBe('unavailable')
    expect([...document.querySelectorAll<HTMLButtonElement>('button')].every(button => button.disabled)).toBe(true)
  })
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

  it('moves horizontal tabs with arrows, Home and End without issuing runtime requests', async () => {
    const send = vi.fn(async () => view())
    await boot(renderRuntimeAppsSection({ lang: 'en', canManage: true }), send)
    ;(document.querySelector('[data-runtime-setup]') as HTMLElement).hidden = false
    const tab = (name: string) => document.querySelector<HTMLButtonElement>('[data-runtime-tab="' + name + '"]')!
    const key = (button: HTMLButtonElement, value: string) => button.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))
    send.mockClear(); tab('settings').focus()
    expect(key(tab('settings'), 'ArrowRight')).toBe(false)
    expect(document.activeElement).toBe(tab('variables'))
    expect(tab('variables').tabIndex).toBe(0)
    expect(tab('settings').tabIndex).toBe(-1)
    expect((document.querySelector('[data-runtime-panel="variables"]') as HTMLElement).hidden).toBe(false)
    key(tab('variables'), 'End'); expect(document.activeElement).toBe(tab('logs'))
    key(tab('logs'), 'Home'); expect(document.activeElement).toBe(tab('settings'))
    key(tab('settings'), 'ArrowLeft'); expect(document.activeElement).toBe(tab('logs'))
    expect(send).not.toHaveBeenCalled()
  })

  it('reverses arrow direction in an Arabic workspace while Home and End keep document order', async () => {
    await boot(renderRuntimeAppsSection({ lang: 'ar', canManage: true }), async () => view())
    ;(document.querySelector('[data-runtime-setup]') as HTMLElement).hidden = false
    const tab = (name: string) => document.querySelector<HTMLButtonElement>('[data-runtime-tab="' + name + '"]')!
    tab('settings').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(tab('logs'))
    tab('logs').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(tab('settings'))
    tab('settings').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(tab('logs'))
  })

  it('skips disabled and hidden tabs and leaves modified browser shortcuts alone', async () => {
    await boot(renderRuntimeAppsSection({ lang: 'en', canManage: true }), async () => view())
    ;(document.querySelector('[data-runtime-setup]') as HTMLElement).hidden = false
    const tab = (name: string) => document.querySelector<HTMLButtonElement>('[data-runtime-tab="' + name + '"]')!
    tab('variables').disabled = true; tab('deploy').hidden = true
    tab('settings').focus()
    tab('settings').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(tab('logs'))
    const shortcut = new KeyboardEvent('keydown', { key: 'Home', ctrlKey: true, bubbles: true, cancelable: true })
    expect(tab('logs').dispatchEvent(shortcut)).toBe(true)
    expect(document.activeElement).toBe(tab('logs'))
    expect(tab('variables').getAttribute('aria-selected')).toBe('false')
  })

  it('keeps nested workspaces independent and does not attach duplicate keyboard handlers', async () => {
    const holder = document.createElement('div')
    holder.innerHTML = renderRuntimeAppsSection({ lang: 'en', canManage: true })
    const outer = holder.querySelector<HTMLElement>('[data-runtime-workspace]')!
    const nested = document.createElement('div')
    nested.innerHTML = renderRuntimeAppsSection({ lang: 'en', canManage: true })
    outer.append(nested.firstElementChild!)
    await boot(holder.innerHTML, async () => view())
    const roots = [...document.querySelectorAll<HTMLElement>('[data-runtime-workspace]')]
    roots.forEach(root => { (root.querySelector('[data-runtime-setup]') as HTMLElement).hidden = false })
    const outerSettings = roots[0]!.querySelector<HTMLButtonElement>('[data-runtime-tab="settings"]')!
    const outerVariables = roots[0]!.querySelector<HTMLButtonElement>('[data-runtime-tab="variables"]')!
    const innerSettings = roots[1]!.querySelector<HTMLButtonElement>('[data-runtime-tab="settings"]')!
    const focus = vi.spyOn(outerVariables, 'focus')
    new Function('return ' + ACCOUNT_RUNTIME_CLIENT_BINDING)()(vi.fn(async () => true))
    outerSettings.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    expect(outerVariables.getAttribute('aria-selected')).toBe('true')
    expect(innerSettings.getAttribute('aria-selected')).toBe('true')
    expect(focus).toHaveBeenCalledTimes(1)
  })
})
