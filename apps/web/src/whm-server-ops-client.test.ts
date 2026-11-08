// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWhmServerOpsCards } from './board-port/whm-server-ops-workspace.ts'
import { renderV2ServerOps } from './themes/v2/pages/xwhm/server/server-ops.ts'
import { v2Messages } from './themes/v2/messages.ts'
import { WHM_SERVER_OPS_CLIENT_BINDING } from './whm-server-ops-client.ts'
import { SERVER_OPS_CARDS, type ServerOpsCardId } from '@xpanel/core'

type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
const tick = async () => { for (let index = 0; index < 12; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const R1 = 'a'.repeat(64), R2 = 'b'.repeat(64)
const THEMES = {
  classic: (ids: readonly ServerOpsCardId[], canManage: boolean) => renderWhmServerOpsCards({ ids, locale: 'en', canManage }),
  v2: (ids: readonly ServerOpsCardId[], canManage: boolean) => renderV2ServerOps(v2Messages.translator('en'), ids, canManage),
}
const boot = (html: string, send: Send, ask: (options: Record<string, unknown>) => Promise<unknown> = async () => true) => {
  document.body.innerHTML = html
  ;(window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest = send
  new Function('return ' + WHM_SERVER_OPS_CLIENT_BINDING)()(ask)
}
const input = (name: string) => document.querySelector<HTMLInputElement>(`[name="${name}"]`)!
const status = () => document.querySelector<HTMLElement>('[data-server-ops-status]')!
const submit = () => document.querySelector<HTMLButtonElement>('[data-server-ops-submit]')!.click()
afterEach(() => { document.body.innerHTML = ''; delete (window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest })

describe.each(Object.entries(THEMES))('server operation cards in %s', (_theme, render) => {
  it('renders every card disabled until the client read its state', () => {
    const html = render(Object.keys(SERVER_OPS_CARDS) as ServerOpsCardId[], true)
    document.body.innerHTML = html
    expect(document.querySelectorAll('[data-server-ops]').length).toBe(13)
    expect(document.querySelectorAll('[data-server-ops] :is(input,select):not([disabled])').length).toBe(0)
    expect(document.querySelectorAll('[data-server-ops-submit]:not([disabled])').length).toBe(0)
    expect(html).not.toMatch(/<style\b|<script\b/)
  })

  it('reads resolvers, sends them with the revision and shows the host result', async () => {
    const send = vi.fn<Send>(async (method) => method === 'GET' ? { revision: R1, resolvers: ['192.0.2.1', '192.0.2.2'] } : { revision: R2, resolvers: ['192.0.2.3', '192.0.2.2'], applied: true })
    boot(render(['resolvers'], true), send); await tick()
    expect(input('primary').value).toBe('192.0.2.1')
    expect(input('primary').disabled).toBe(false)
    input('primary').value = '192.0.2.3'
    submit(); await tick()
    expect(send).toHaveBeenLastCalledWith('PUT', '/api/server/resolvers', { resolvers: ['192.0.2.3', '192.0.2.2'], expectedRevision: R1 })
    expect(status().dataset.state).toBe('saved')
  })

  it('shows the stable refusal and never claims success', async () => {
    const send = vi.fn<Send>(async (method) => { if (method === 'GET') return { revision: R1, forwards: [] }; throw { status: 412, details: { reason: 'NO_FREE_IP', stateChanged: false } } })
    boot(render(['domain-forwards'], true), send); await tick()
    input('domain').value = 'example.org'; input('url').value = 'https://example.net/'
    submit(); await tick()
    expect(status().dataset.state).toBe('failed')
    expect(status().textContent).toContain('No free address')
  })

  it('reviews a profile before activating it and links its job', async () => {
    const send = vi.fn<Send>(async (method, path) => method === 'GET' ? { revision: R1, state: { profile: 'full', optional: [] }, effective: ['web', 'dns'] }
      : path.endsWith('/review') ? { changes: [{ role: 'web', change: 'disable' }], effective: ['dns'] }
        : { revision: R2, state: { profile: 'dns-only', optional: [] }, effective: ['dns'], job: { id: '11111111-1111-4111-8111-111111111111', status: 'queued' } })
    const ask = vi.fn(async () => true)
    boot(render(['role-profile'], true), send, ask); await tick()
    const profile = input('profile') as unknown as HTMLSelectElement
    profile.value = 'dns-only'
    submit(); await tick()
    expect(ask).toHaveBeenCalledOnce()
    expect(send.mock.calls.map(call => call[0] + ' ' + call[1])).toEqual(['GET /api/server/role-profile', 'POST /api/server/role-profile/review', 'PUT /api/server/role-profile'])
    expect(document.querySelector<HTMLAnchorElement>('[data-server-ops-job]')!.getAttribute('href')).toBe('/whm/jobs?job=11111111-1111-4111-8111-111111111111')
  })

  it('stops at the review when the dialog is declined', async () => {
    const send = vi.fn<Send>(async (method, path) => method === 'GET' ? { revision: R1, state: { profile: 'full', optional: [] }, effective: [] } : path.endsWith('/review') ? { changes: [] } : {})
    boot(render(['role-profile'], true), send, async () => false); await tick()
    submit(); await tick()
    expect(send).toHaveBeenCalledTimes(2)
    expect(status().dataset.state).toBe('cancelled')
  })

  it('keeps every control disabled without manage authority', async () => {
    const send = vi.fn<Send>(async () => ({ revision: R1, resolvers: ['192.0.2.1', '192.0.2.2'] }))
    boot(render(['resolvers'], false), send); await tick()
    expect(input('primary').disabled).toBe(true)
    expect(document.querySelector<HTMLButtonElement>('[data-server-ops-submit]')!.disabled).toBe(true)
    expect(input('primary').value).toBe('192.0.2.1')
  })
})

describe.each(['classic', 'v2'] as const)('send to the configuration cluster in %s', theme => {
  const read = { revision: R1, tier: 'release', updates: 'manual', securityPatches: true, owner: null, ledger: null }
  const saved = async (reply: Record<string, unknown>) => {
    const calls: unknown[][] = []
    boot(THEMES[theme](['updates'], true), async (method, path, body) => { calls.push([method, path, body]); return method === 'GET' ? read : { ...read, revision: R2, ...reply } })
    await tick()
    return calls
  }
  it('sends the choice only when it is ticked and says how many members received it', async () => {
    const calls = await saved({ cluster: { version: 4, members: 2 } })
    input('sendToCluster').checked = true
    submit(); await tick()
    expect((calls.at(-1)![2] as Record<string, unknown>).sendToCluster).toBe(true)
    expect(status().textContent).toContain('2 cluster members')
  })
  it('reports a server without members instead of claiming a push', async () => {
    await saved({ cluster: null })
    input('sendToCluster').checked = true
    submit(); await tick()
    expect(status().textContent).toBe('Preferences saved. There are no cluster members to send them to.')
  })
  it('leaves an ordinary save as it was', async () => {
    const calls = await saved({})
    submit(); await tick()
    expect(calls.at(-1)![2]).not.toHaveProperty('sendToCluster')
    expect(status().textContent).toBe('Preferences saved.')
  })
})
