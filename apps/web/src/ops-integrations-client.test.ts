// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderOpsIntegrationsWorkspace } from './board-port/ops-integrations-workspace.ts'
import { OPS_INTEGRATIONS_CLIENT_BINDING, readIntegrationsView } from './ops-integrations-client.ts'

const tick = async () => { for (let index = 0; index < 4; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const rev = (char: string) => char.repeat(64)
const endpoint = { id: 'whk_' + 'a'.repeat(16), url: 'https://hooks.example.com/xpanel', events: ['account.created'], active: true, secretPresent: true }
const view = (overrides: Record<string, unknown> = {}) => ({
  endpoints: [] as unknown[], events: ['account.created', 'account.suspended', 'backup.completed'], signatureScheme: 'hmac-sha256-t-v1', secretsLocation: 'extended/integrations/secrets.json',
  savedRevision: rev('1'), activeRevision: rev('2'), invalid: false, egress: { state: 'unavailable', reason: 'no_reviewed_webhook_egress' }, deliveries: [] as unknown[], ...overrides,
})
type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
const boot = (send?: Send, canManage = true, locale: 'en' | 'ar' = 'en') => {
  document.body.innerHTML = `<section data-whm-detail-route="/whm/panel/integrations" data-capability-state="authorized">${renderOpsIntegrationsWorkspace({ locale, canRead: true, canManage })}</section>`
  if (send) (window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest = send
  document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
  new Function('return ' + OPS_INTEGRATIONS_CLIENT_BINDING)()()
}
const action = (key: string) => document.querySelector<HTMLButtonElement>('[data-ops-int-action="' + key + '"]')!
const status = () => document.querySelector<HTMLElement>('[data-ops-int-status]')!
beforeEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr' })

describe('integrations client', () => {
  it('validates the contract and rejects bad URLs, events and deliveries', () => {
    expect(readIntegrationsView(view({ endpoints: [endpoint] })).endpoints).toHaveLength(1)
    expect(() => readIntegrationsView(view({ endpoints: [{ ...endpoint, url: 'http://x' }] }))).toThrow()
    expect(() => readIntegrationsView(view({ endpoints: [{ ...endpoint, events: ['nope'] }] }))).toThrow()
    expect(() => readIntegrationsView(view({ signatureScheme: 'md5' }))).toThrow()
    expect(() => readIntegrationsView(view({ deliveries: [{ id: 'x', endpointId: endpoint.id, event: 'account.created', createdAt: 'now', state: 'delivered', attempts: 1, lastStatus: 700 }] }))).toThrow()
  })
  it('reads webhooks, shows the unavailable egress state and the signature scheme', async () => {
    boot(vi.fn(async () => view({ endpoints: [endpoint] })))
    action('read').click(); await tick()
    expect(status().dataset.state).toBe('read')
    expect(document.querySelector('[data-ops-int-fact="scheme"]')!.textContent).toBe('hmac-sha256-t-v1')
    expect(document.querySelector('[data-ops-int-fact="egress"]')!.textContent).toBe('Unavailable')
    expect(document.querySelector('[data-ops-int-rows]')!.textContent).toContain('hooks.example.com')
    expect(document.querySelector<HTMLButtonElement>('[data-ops-int-test]')!.disabled).toBe(true)
  })
  it('adds an endpoint with selected events and saves it', async () => {
    let stored = view()
    const send = vi.fn(async (method: string, _path: string, body?: unknown) => { if (method === 'PUT') stored = view({ savedRevision: rev('9'), endpoints: ((body as { config: { endpoints: Record<string, unknown>[] } }).config.endpoints).map(e => ({ ...e, secretPresent: true })) }); return stored })
    boot(send)
    action('read').click(); await tick()
    ;(document.querySelector<HTMLInputElement>('[data-ops-int-url]')!).value = 'https://hooks.example.com/new'
    ;(document.querySelector<HTMLInputElement>('[data-ops-int-events] input[value="account.created"]')!).checked = true
    document.querySelector<HTMLButtonElement>('[data-ops-int-add]')!.click()
    expect(document.querySelector('[data-ops-int-rows]')!.textContent).toContain('hooks.example.com/new')
    document.querySelector<HTMLButtonElement>('[data-ops-int-save]')!.click(); await tick()
    const put = send.mock.calls.find(callArgs => callArgs[0] === 'PUT')!
    expect((put[2] as { config: { endpoints: { url: string; events: string[] }[] } }).config.endpoints[0]).toMatchObject({ url: 'https://hooks.example.com/new', events: ['account.created'] })
    expect(status().dataset.state).toBe('saved')
  })
  it('sends a signed test when egress is available and shows the delivery log', async () => {
    const stored = view({ endpoints: [endpoint], egress: { state: 'available', reason: null }, deliveries: [{ id: 'whd_1', endpointId: endpoint.id, event: 'account.created', createdAt: '2026-10-28T09:00:00.000Z', state: 'delivered', attempts: 1, lastStatus: 200 }] })
    const send = vi.fn(async (method: string, path: string) => path === '/api/server/integrations/test' ? { delivery: { id: 'whd_1', endpointId: endpoint.id, event: 'account.created', state: 'delivered', attempts: 1, lastStatus: 200 } } : stored)
    boot(send)
    action('read').click(); await tick()
    expect(document.querySelector('[data-ops-int-log]')!.textContent).toContain('Delivered')
    document.querySelector<HTMLButtonElement>('[data-ops-int-test]')!.click(); await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/integrations/test', { id: endpoint.id })
    expect(status().dataset.state).toBe('read')
  })
  it('rejects an invalid endpoint before any request', async () => {
    const send = vi.fn(async (_method: string, _path?: string, _body?: unknown) => view())
    boot(send)
    action('read').click(); await tick()
    ;(document.querySelector<HTMLInputElement>('[data-ops-int-url]')!).value = 'http://insecure'
    document.querySelector<HTMLButtonElement>('[data-ops-int-add]')!.click()
    expect(status().dataset.state).toBe('failed')
    expect(send.mock.calls.filter(callArgs => callArgs[0] === 'PUT')).toHaveLength(0)
  })
})
