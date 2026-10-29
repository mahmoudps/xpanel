// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderSwAddonServicesWorkspace } from './board-port/sw-addon-services-workspace.ts'
import { readAddonPackageStates, SW_ADDON_SERVICES_CLIENT_BINDING } from './sw-addon-services-client.ts'
import { handleSwAddonServicesWorkspaceRoute } from '../../api/src/sw-addon-services-workspace.ts'

const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const row = (id: string, unit: string, componentId: string | null, load = 'not-found', active = 'inactive', sub = 'dead', boot: string | null = null) => ({ id, unit, componentId, state: 'read', load, active, sub, boot, revision: (id.length % 10).toString().repeat(64) })
const view = (control = true) => ({ scope: 'host-addon-services', state: 'read', reason: null, observedAt: '2026-10-28T00:00:00.000Z', actions: { control, configure: false }, services: [row('memcached', 'memcached.service', 'memcached', 'loaded', 'active', 'running', 'enabled'), row('rabbitmq', 'rabbitmq-server.service', 'rabbitmq'), row('elasticsearch', 'elasticsearch.service', null), row('opensearch', 'opensearch.service', null)] })
const catalog = { page: 'catalog', state: 'read', components: [{ id: 'memcached', state: 'installed' }, { id: 'rabbitmq', state: 'absent' }] }
const boot = (request: (method: string, path: string, body?: unknown) => Promise<unknown>, ask?: () => Promise<boolean>) => { (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request; new Function('return ' + SW_ADDON_SERVICES_CLIENT_BINDING)()(ask) }
beforeEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('add-on services workspace', () => {
  it('renders both directions with the configuration component kept and disabled', () => {
    for (const locale of ['en', 'ar'] as const) {
      document.body.innerHTML = renderSwAddonServicesWorkspace({ locale, canRead: true, canManage: true })
      expect(document.querySelector<HTMLElement>('[data-sw-addons]')!.dir).toBe(locale === 'ar' ? 'rtl' : 'ltr')
      expect(document.querySelectorAll('button:disabled').length).toBe(1)
      expect(document.body.textContent).not.toMatch(/[٠-٩۰-۹]/)
    }
  })
  it('combines unit and package states and submits one confirmed service job', async () => {
    document.body.innerHTML = renderSwAddonServicesWorkspace({ locale: 'en', canRead: true, canManage: true })
    const send = vi.fn(async (method: string, path: string) => method === 'POST' ? { job: { id: 'job-3', kind: 'software.addon.stop' } } : path.includes('software-center') ? catalog : view()), ask = vi.fn(async () => true)
    boot(send, ask); await tick()
    const rows = [...document.querySelectorAll('[data-sw-addons-rows] tr')]
    expect(rows.map(item => item.children[2]!.textContent)).toEqual(['Installed', 'Not installed', 'No reviewed package', 'No reviewed package'])
    expect(rows[0]!.querySelector<HTMLButtonElement>('[data-sw-action="start"]')!.disabled).toBe(true)
    expect(rows[1]!.querySelector<HTMLButtonElement>('[data-sw-action="start"]')!.disabled).toBe(true)
    rows[0]!.querySelector<HTMLButtonElement>('[data-sw-action="stop"]')!.click(); await tick()
    expect(ask).toHaveBeenCalledOnce()
    expect(send.mock.calls.at(-1)).toEqual(['POST', '/api/server/software/addon-services/action', { serviceId: 'memcached', action: 'stop', expectedRevision: '9'.repeat(64) }])
    expect(document.querySelector<HTMLElement>('[data-sw-addons-job]')!.hidden).toBe(false)
    expect(rows[0]!.querySelector<HTMLButtonElement>('[data-sw-action="restart"]')!.disabled).toBe(true)
  })
  it('keeps package states unread when the catalog fails, and refuses without the runner', async () => {
    document.body.innerHTML = renderSwAddonServicesWorkspace({ locale: 'en', canRead: true, canManage: true })
    boot(vi.fn(async (_method: string, path: string) => { if (path.includes('software-center')) throw new Error('down'); return view(false) }), async () => true); await tick()
    expect(document.querySelector('[data-sw-addons-rows] tr')!.children[2]!.textContent).toBe('Not read')
    expect(document.querySelector<HTMLButtonElement>('[data-sw-action="stop"]')!.disabled).toBe(true)
    expect(() => readAddonPackageStates({ page: 'module', state: 'read', components: [] })).toThrow()
  })
  it('the API refuses unknown units and unverifiable replies', async () => {
    const principal = { id: 'p', username: 'root' }
    const helpers = { requireCaller: vi.fn(async () => ({ principal }) as never), assertRoot: vi.fn(async () => {}), emitAudit: vi.fn(async () => {}) as never, callHost: vi.fn(async (): Promise<unknown> => ({ ...view(), services: view().services.slice(0, 3) })) }
    const url = new URL('http://api.local/api/server/software/addon-services')
    await expect(handleSwAddonServicesWorkspaceRoute(new Request(url), url, 'GET', helpers)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    const action = new URL('http://api.local/api/server/software/addon-services/action')
    await expect(handleSwAddonServicesWorkspaceRoute(new Request(action, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ serviceId: 'sshd', action: 'stop', expectedRevision: '0'.repeat(64) }) }), action, 'POST', helpers)).rejects.toMatchObject({ code: 'VALIDATION' })
    helpers.callHost = vi.fn(async () => ({ job: { id: 'job-1', kind: 'software.addon.stop' } }))
    const ok = await handleSwAddonServicesWorkspaceRoute(new Request(action, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ serviceId: 'memcached', action: 'stop', expectedRevision: '0'.repeat(64) }) }), action, 'POST', helpers)
    expect(ok!.status).toBe(202); expect(helpers.emitAudit).toHaveBeenCalledTimes(2)
  })
})
