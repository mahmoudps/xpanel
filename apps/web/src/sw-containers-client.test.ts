// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderSwContainerEngineWorkspace, renderSwContainersWorkspace } from './board-port/sw-containers-workspace.ts'
import { SW_CONTAINERS_CLIENT_BINDING } from './sw-containers-client.ts'

const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const id = 'a'.repeat(64)
const list = (lifecycle = true) => ({ scope: 'host-engines', state: 'read', reason: null, observedAt: '2026-10-28T09:01:02.000Z', rootlessAccounts: 'not-read', actions: { lifecycle }, engines: [{ engine: 'podman', state: 'read', reason: null, version: '4.9.3', revision: 'b'.repeat(64), containers: [{ id, name: 'web', image: 'nginx:latest', state: 'running', status: 'Up 2 hours', ports: ['0.0.0.0:8080->80/tcp'] }] }, { engine: 'docker', state: 'absent', reason: 'engine-absent', version: null, revision: null, containers: [] }] })
const engine = { scope: 'host-engines', state: 'read', reason: null, observedAt: '2026-10-28T09:01:02.000Z', actions: { pull: false, registryWrite: false, daemonWrite: false, networkWrite: false, volumeWrite: false }, engines: [{ engine: 'podman', state: 'read', reason: null, version: '4.9.3', facts: { runtime: 'crun', storageDriver: 'overlay', cgroupVersion: '2', rootless: false, registries: ['docker.io'] }, images: [{ id: 'c'.repeat(64), tags: ['nginx:latest'], size: '187.0 MB' }], networks: [{ id: 'd'.repeat(64), name: 'podman', driver: 'bridge' }], volumes: [] }] }
const boot = (request: (method: string, path: string, body?: unknown) => Promise<unknown>, ask?: () => Promise<boolean>) => { (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request; new Function('return ' + SW_CONTAINERS_CLIENT_BINDING)()(ask) }
beforeEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr' })

describe('container workspaces', () => {
  it('renders every approved control in both directions with ASCII digits', () => {
    for (const locale of ['en', 'ar'] as const) {
      document.body.innerHTML = renderSwContainersWorkspace({ locale, canRead: true, canManage: true }) + renderSwContainerEngineWorkspace({ locale, canRead: true, canManage: false })
      expect(document.querySelector<HTMLElement>('[data-sw-containers]')!.dir).toBe(locale === 'ar' ? 'rtl' : 'ltr')
      expect(document.querySelectorAll('button:disabled').length).toBe(7)
      expect(document.body.textContent).not.toMatch(/[٠-٩۰-۹]/)
    }
  })
  it('reads containers, keeps absent engines honest and submits a confirmed lifecycle job once', async () => {
    document.body.innerHTML = renderSwContainersWorkspace({ locale: 'en', canRead: true, canManage: true })
    const send = vi.fn(async (method: string) => method === 'GET' ? list() : { job: { id: 'job-7', kind: 'software.container.stop' } }), ask = vi.fn(async () => true)
    boot(send, ask); await tick()
    expect(document.querySelector('[data-sw-engine-state="docker"]')!.textContent).toBe('Not installed')
    expect(document.querySelector('[data-sw-engine-state="podman"]')!.textContent).toBe('4.9.3')
    const row = document.querySelector('tbody[data-sw-containers] tr')!
    expect(row.textContent).toContain('web'); expect(row.querySelector('bdi')!.dir).toBe('ltr')
    const start = row.querySelector<HTMLButtonElement>('[data-sw-action="start"]')!, stop = row.querySelector<HTMLButtonElement>('[data-sw-action="stop"]')!
    expect(start.disabled).toBe(true); expect(stop.disabled).toBe(false)
    stop.click(); await tick()
    expect(ask).toHaveBeenCalledOnce()
    expect(send.mock.calls[1]).toEqual(['POST', '/api/server/software/containers/action', { engine: 'podman', containerId: id, action: 'stop', expectedRevision: 'b'.repeat(64) }])
    expect(document.querySelector<HTMLElement>('[data-sw-job]')!.hidden).toBe(false)
    expect(document.querySelector<HTMLAnchorElement>('[data-sw-job-link]')!.getAttribute('href')).toBe('/whm/jobs?job=job-7')
    expect(stop.disabled).toBe(true)
  })
  it('locks after an unknown outcome and refuses actions without the job runner', async () => {
    document.body.innerHTML = renderSwContainersWorkspace({ locale: 'en', canRead: true, canManage: true })
    const send = vi.fn(async (method: string) => { if (method === 'GET') return list(); throw { status: 503, details: { stateChanged: true, unknownOutcome: true } } })
    boot(send, async () => true); await tick()
    document.querySelector<HTMLButtonElement>('[data-sw-action="stop"]')!.click(); await tick()
    expect(document.querySelector('[data-sw-status]')!.getAttribute('data-state')).toBe('uncertain')
    expect(document.querySelector<HTMLButtonElement>('[data-sw-action="restart"]')!.disabled).toBe(true)
    document.body.innerHTML = renderSwContainersWorkspace({ locale: 'en', canRead: true, canManage: true })
    boot(vi.fn(async () => list(false)), async () => true); await tick()
    expect(document.querySelector<HTMLButtonElement>('[data-sw-action="stop"]')!.disabled).toBe(true)
    expect(document.querySelector('[data-sw-status]')!.textContent).toContain('host job runner is not connected')
  })
  it('does not call transport without admission and never echoes raw errors', async () => {
    document.body.innerHTML = renderSwContainersWorkspace({ locale: 'en', canRead: false, canManage: false })
    const send = vi.fn(); boot(send); await tick(); expect(send).not.toHaveBeenCalled()
    document.body.innerHTML = renderSwContainersWorkspace({ locale: 'en', canRead: true, canManage: true })
    boot(vi.fn(async () => { throw new Error('private-socket-path') })); await tick()
    expect(document.body.textContent).not.toContain('private-socket-path'); expect(document.querySelector('[data-sw-status]')!.getAttribute('data-state')).toBe('failed')
  })
  it('paints engine facts, images, registries and networks while every engine write stays disabled', async () => {
    document.documentElement.lang = 'ar'; document.documentElement.dir = 'rtl'
    document.body.innerHTML = renderSwContainerEngineWorkspace({ locale: 'ar', canRead: true, canManage: false })
    boot(vi.fn(async () => engine)); await tick()
    expect(document.querySelector('tbody[data-sw-facts]')!.textContent).toContain('crun')
    expect(document.querySelector('tbody[data-sw-images]')!.textContent).toContain('nginx:latest')
    expect(document.querySelector('tbody[data-sw-registries]')!.textContent).toContain('docker.io')
    expect(document.querySelector('[data-sw-observed]')!.textContent).toBe('2026-10-28 09:01 UTC')
    expect([...document.querySelectorAll<HTMLButtonElement>('button:not([data-sw-refresh])')].every(button => button.disabled)).toBe(true)
    expect(document.body.textContent).not.toMatch(/[٠-٩۰-۹]/)
    document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr'
  })
})
