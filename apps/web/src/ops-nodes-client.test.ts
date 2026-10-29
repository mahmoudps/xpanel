// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderOpsNodesWorkspace } from './board-port/ops-nodes-workspace.ts'
import { OPS_NODES_CLIENT_BINDING, readNodesView } from './ops-nodes-client.ts'

const tick = async () => { for (let index = 0; index < 4; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const rev = (char: string) => char.repeat(64)
const node = { id: 'node_' + 'a'.repeat(16), label: 'Node 2', hostname: 'node2.example.com', port: 2087, fingerprint: 'b'.repeat(64), role: 'all' as const }
const view = (overrides: Record<string, unknown> = {}) => ({ config: { nodes: [] as unknown[] }, savedRevision: rev('1'), activeRevision: rev('2'), invalid: false, thisServer: { hostname: 'panel.example.com' }, singleNode: true, channel: { verification: 'unavailable' }, ...overrides })
type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
const boot = (send?: Send, canManage = true, locale: 'en' | 'ar' = 'en') => {
  document.body.innerHTML = `<section data-whm-detail-route="/whm/server/nodes" data-capability-state="authorized">${renderOpsNodesWorkspace({ locale, canRead: true, canManage })}</section>`
  if (send) (window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest = send
  document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
  new Function('return ' + OPS_NODES_CLIENT_BINDING)()()
}
const action = (key: string) => document.querySelector<HTMLButtonElement>('[data-ops-nodes-action="' + key + '"]')!
const status = () => document.querySelector<HTMLElement>('[data-ops-nodes-status]')!
const setInput = (name: string, value: string) => { (document.querySelector('[data-ops-nodes-' + name + ']') as HTMLInputElement).value = value }
beforeEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr' })

describe('server nodes client', () => {
  it('validates the contract and rejects malformed nodes and hostnames', () => {
    expect(readNodesView(view({ config: { nodes: [node] }, singleNode: false })).config.nodes).toHaveLength(1)
    expect(() => readNodesView(view({ config: { nodes: [{ ...node, hostname: 'nodots' }] } }))).toThrow()
    expect(() => readNodesView(view({ config: { nodes: [{ ...node, fingerprint: 'zz' }] } }))).toThrow()
    expect(() => readNodesView(view({ thisServer: { hostname: 'nodots' } }))).toThrow()
    expect(() => readNodesView(view({ channel: { verification: 'maybe' } }))).toThrow()
  })
  it('shows the single-node honest state and the unavailable channel capability', async () => {
    boot(vi.fn(async () => view()))
    action('read').click(); await tick()
    expect(status().dataset.state).toBe('read')
    expect(document.querySelector<HTMLElement>('[data-ops-nodes-single]')!.hidden).toBe(false)
    expect(document.querySelector('[data-ops-nodes-fact="this"]')!.textContent).toBe('panel.example.com')
    expect(document.querySelector('[data-ops-nodes-fact="channel"]')!.textContent).toBe('Unavailable')
  })
  it('registers a node draft and saves it with the observed revision', async () => {
    let stored = view()
    const send = vi.fn(async (method: string, _path: string, body?: unknown) => { if (method === 'PUT') stored = view({ savedRevision: rev('9'), singleNode: false, config: (body as { config: unknown }).config as never }); return stored })
    boot(send)
    action('read').click(); await tick()
    setInput('label', 'Mail node'); setInput('host', 'node2.example.com'); setInput('fingerprint', 'B'.repeat(64))
    document.querySelector<HTMLButtonElement>('[data-ops-nodes-add]')!.click()
    expect(document.querySelector('[data-ops-nodes-rows]')!.textContent).toContain('node2.example.com:2087')
    document.querySelector<HTMLButtonElement>('[data-ops-nodes-save]')!.click(); await tick()
    const put = send.mock.calls.find(callArgs => callArgs[0] === 'PUT')!
    expect((put[2] as { config: { nodes: { hostname: string }[] } }).config.nodes[0]!.hostname).toBe('node2.example.com')
    expect(status().dataset.state).toBe('saved')
  })
  it('reports an honest pending enrollment when channel verification is unavailable', async () => {
    const send = vi.fn(async (method: string, path: string) => path === '/api/server/nodes/verify' ? { id: node.id, enrollment: 'pending', reason: 'authenticated_channel_unavailable' } : view({ config: { nodes: [node] }, singleNode: false }))
    boot(send)
    action('read').click(); await tick()
    document.querySelector<HTMLButtonElement>('[data-ops-nodes-verify]')!.click(); await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/nodes/verify', { id: node.id })
    expect(status().textContent).toContain('Channel verification is unavailable')
    expect(document.querySelector('[data-ops-nodes-rows]')!.textContent).toContain('Pending')
  })
  it('rejects an invalid node before any request', async () => {
    const send = vi.fn(async (_method: string, _path?: string, _body?: unknown) => view())
    boot(send)
    action('read').click(); await tick()
    setInput('label', 'x'); setInput('host', 'bad host'); setInput('fingerprint', 'short')
    document.querySelector<HTMLButtonElement>('[data-ops-nodes-add]')!.click()
    expect(status().dataset.state).toBe('failed')
    expect(send.mock.calls.filter(callArgs => callArgs[0] === 'PUT')).toHaveLength(0)
  })
})
