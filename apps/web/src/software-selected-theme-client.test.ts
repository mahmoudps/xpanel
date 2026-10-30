// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { builtinEnvironments, type EnvironmentReturn } from 'vitest/runtime'
import { translator } from './i18n.ts'
import { renderSwContainersWorkspace, renderSwContainerEngineWorkspace } from './board-port/sw-containers-workspace.ts'
import { renderWhmUpdatesWorkspace } from './board-port/whm-updates-workspace.ts'
import { renderV2WhmSoftwarePage } from './themes/v2/pages/xwhm/software/index.ts'
import { SW_CONTAINERS_CLIENT_BINDING } from './sw-containers-client.ts'
import { WHM_UPDATES_CLIENT_BINDING } from './whm-updates-client.ts'

let testDom: EnvironmentReturn | undefined
beforeEach(async () => {
  testDom = await builtinEnvironments.jsdom.setup(globalThis, { jsdom: { url: 'https://whm.example.test/whm/software/containers', runScripts: 'outside-only' } })
})
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const mount = (html: string) => {
  document.documentElement.lang = 'en'
  document.body.innerHTML = html
  vi.stubGlobal('xpT', translator('en')); return document
}
afterEach(async () => {
  try {
    document.body.replaceChildren()
    delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
    vi.restoreAllMocks(); vi.unstubAllGlobals()
  } finally { await testDom?.teardown(globalThis); testDom = undefined }
})
const render = (theme: 'classic' | 'v2', route: string) => theme === 'v2' ? renderV2WhmSoftwarePage({ activeRoute: route, dataAuthority: { canRead: true, canManage: true } })! : route.endsWith('/engine') ? renderSwContainerEngineWorkspace({ locale: 'en', canRead: true, canManage: false }) : route.endsWith('/updates') ? renderWhmUpdatesWorkspace({ locale: 'en', canRead: true, canApply: true }) : renderSwContainersWorkspace({ locale: 'en', canRead: true, canManage: true })
const boot = (binding: string, send: (method: string, path: string, body?: unknown) => Promise<unknown>, ask = vi.fn(async () => true)) => { Object.assign(window, { xpanelSessionRequest: send }); new Function('return ' + binding)()(ask); return ask }
const list = () => ({ scope: 'host-engines', state: 'read', reason: null, observedAt: '2026-10-29T12:00:00.000Z', rootlessAccounts: 'not-read', actions: { lifecycle: true }, engines: [{ engine: 'podman', state: 'read', reason: null, version: '4.9.3', revision: 'b'.repeat(64), containers: [{ id: 'a'.repeat(64), name: 'web', image: 'nginx:latest', state: 'running', status: 'Up 2 hours', ports: ['0.0.0.0:8080->80/tcp'] }] }, { engine: 'docker', state: 'absent', reason: 'engine-absent', version: null, revision: null, containers: [] }] })
const engine = () => ({ scope: 'host-engines', state: 'read', reason: null, observedAt: '2026-10-29T12:00:00.000Z', actions: { pull: false, registryWrite: false, daemonWrite: false, networkWrite: false, volumeWrite: false }, engines: [{ engine: 'podman', state: 'read', reason: null, version: '4.9.3', facts: { runtime: 'crun', storageDriver: 'overlay', cgroupVersion: '2', rootless: false, registries: ['docker.io'] }, images: [{ id: 'c'.repeat(64), tags: ['nginx:latest'], size: '187.0 MB' }], networks: [{ id: 'd'.repeat(64), name: 'podman', driver: 'bridge' }], volumes: [] }] })
const plan = () => ({ plan: { state: 'read', source: 'apt', observedAt: '2026-10-29T12:00:00.000Z', revision: 'c'.repeat(64), packages: [{ name: 'openssl', current: '3.0.1', candidate: '3.0.2', origin: 'Ubuntu:24.04/security', security: true, kernel: false, held: false, newInstall: false }], holds: ['nginx'], rebootRequired: false, counts: { total: 1, security: 1, kernel: 0, held: 1 } }, safety: { state: 'read', writers: [], database: 'clean' }, actions: { refresh: true, apply: true } })

describe('selected-theme software controllers', () => {
  it.each(['classic', 'v2'] as const)('preserves %s container action admission and confirmed job payload', async theme => {
    const doc = mount(render(theme, '/whm/software/containers'))
    const send = vi.fn(async (method: string, _path: string, _body?: unknown) => method === 'GET' ? list() : { job: { id: 'job-7', kind: 'software.container.stop' } })
    const ask = boot(SW_CONTAINERS_CLIENT_BINDING, send); await settle()
    const row = doc.querySelector('tbody[data-sw-containers] tr')!
    expect(row.querySelectorAll('td')).toHaveLength(7)
    expect(row.querySelector('bdi')?.getAttribute('dir')).toBe('ltr')
    expect(row.querySelector<HTMLButtonElement>('[data-sw-action="start"]')!.disabled).toBe(true)
    const stop = row.querySelector<HTMLButtonElement>('[data-sw-action="stop"]')!
    expect(stop.className).toBe(theme === 'v2' ? 'v2-btn' : 'xp-btn')
    stop.click(); await settle()
    expect(ask).toHaveBeenCalledOnce()
    expect(send.mock.calls.find(call => call[0] === 'POST')).toEqual(['POST', '/api/server/software/containers/action', { engine: 'podman', containerId: 'a'.repeat(64), action: 'stop', expectedRevision: 'b'.repeat(64) }])
    expect(stop.disabled).toBe(true)
    expect(doc.querySelector('[data-sw-status]')?.getAttribute('data-state')).toBe('submitted')
  })

  it.each(['classic', 'v2'] as const)('fills %s engine resources with their semantic column counts and empty spans', async theme => {
    const doc = mount(render(theme, '/whm/software/containers/engine'))
    const send = vi.fn(async (_method: string, _path: string) => engine()); boot(SW_CONTAINERS_CLIENT_BINDING, send); await settle()
    for (const [key, cells] of [['facts', 5], ['images', 4], ['registries', 2], ['networks', 4]] as const) expect(doc.querySelectorAll(`[data-sw-${key}] tr td`)).toHaveLength(cells)
    expect(doc.querySelector('[data-sw-volumes] td')?.getAttribute('colspan')).toBe('3')
    expect(doc.querySelector('[data-sw-facts]')?.textContent).toContain('crun')
    expect(doc.querySelector('[data-sw-images]')?.textContent).toContain('nginx:latest')
    expect(send.mock.calls.every(call => call[0] === 'GET')).toBe(true)
  })

  it.each(['classic', 'v2'] as const)('preserves %s package selection, held rows and cancellation before apply', async theme => {
    const doc = mount(render(theme, '/whm/software/updates'))
    const send = vi.fn(async (_method: string, _path: string, _body?: unknown) => plan())
    const ask = boot(WHM_UPDATES_CLIENT_BINDING, send, vi.fn(async () => false))
    doc.querySelector<HTMLButtonElement>('[data-whm-updates-action="read"]')!.click(); await settle()
    const boxes = [...doc.querySelectorAll<HTMLInputElement>('[data-whm-updates-select]')]
    expect(boxes.map(item => [item.value, item.disabled])).toEqual([['openssl', false], ['nginx', true]])
    expect(doc.querySelectorAll('[data-whm-updates-rows] tr')).toHaveLength(2)
    expect(doc.querySelectorAll('[data-whm-updates-rows] tr:first-child td')).toHaveLength(7)
    boxes[0]!.checked = true; boxes[0]!.dispatchEvent(new Event('change', { bubbles: true }))
    doc.querySelector<HTMLButtonElement>('[data-whm-updates-action="selected"]')!.click(); await settle()
    expect(ask).toHaveBeenCalledOnce()
    expect(send.mock.calls.every(call => call[0] === 'GET')).toBe(true)
  })
})
