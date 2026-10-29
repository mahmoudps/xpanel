// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderOpsFileSharingWorkspace } from './board-port/ops-file-sharing-workspace.ts'
import { OPS_FILE_SHARING_CLIENT_BINDING, readFileSharingView } from './ops-file-sharing-client.ts'

const tick = async () => { for (let index = 0; index < 4; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const rev = (char: string) => char.repeat(64)
const share = { id: 'shr_' + 'a'.repeat(16), path: '/srv/shares/team', clients: [{ host: '10.0.0.0/24', permission: 'rw', squashRoot: true, subtreeCheck: true }] }
const view = (overrides: Record<string, unknown> = {}) => ({
  config: { shares: [share] }, savedRevision: rev('1'), activeRevision: rev('2'), invalid: false,
  observed: { state: 'read', managedPresent: true, shares: [{ ...share, exportState: 'exported' }], foreignExports: ['/data'], reason: null }, ...overrides,
})
type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
const boot = (send?: Send, ask: ((o: Record<string, unknown>) => Promise<unknown>) | undefined = async () => true, locale: 'en' | 'ar' = 'en', canManage = true) => {
  document.body.innerHTML = `<section data-whm-detail-route="/whm/server/file-sharing" data-capability-state="authorized">${renderOpsFileSharingWorkspace({ locale, canRead: true, canManage })}</section>`
  if (send) (window as Window & { xpanelSessionRequest?: Send }).xpanelSessionRequest = send
  document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
  new Function('return ' + OPS_FILE_SHARING_CLIENT_BINDING)()(ask)
}
const action = (key: string) => document.querySelector<HTMLButtonElement>('[data-ops-shares-action="' + key + '"]')!
const status = () => document.querySelector<HTMLElement>('[data-ops-shares-status]')!
beforeEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr' })

describe('file sharing client parser', () => {
  it('accepts the contract and rejects unsafe shares, revisions and foreign exports', () => {
    expect(readFileSharingView(view()).observed.foreignExports).toEqual(['/data'])
    const mutate = (change: (value: ReturnType<typeof view>) => void) => { const value = JSON.parse(JSON.stringify(view())); change(value); return () => readFileSharingView(value) }
    expect(mutate(value => { value.observed.shares[0]!.path = '/etc/passwd' })).toThrow()
    expect(mutate(value => { value.observed.foreignExports = ['relative'] })).toThrow()
    expect(mutate(value => { (value as Record<string, unknown>).savedRevision = 'short' })).toThrow()
    expect(mutate(value => { value.observed.shares[0]!.exportState = 'bogus' as never })).toThrow()
    expect(mutate(value => { value.config.shares[0]!.clients = [] })).toThrow()
  })
})

describe('file sharing client binding', () => {
  it('reads shares, shows export state and the foreign export list', async () => {
    const send = vi.fn(async () => view())
    boot(send)
    action('read').click(); await tick()
    expect(send).toHaveBeenCalledWith('GET', '/api/server/file-sharing')
    expect(status().dataset.state).toBe('read')
    expect(document.querySelector('[data-ops-shares-rows]')!.textContent).toContain('/srv/shares/team')
    expect(document.querySelector('[data-ops-shares-fact="nfs"]')!.textContent).toBe('Available')
    expect(document.querySelector<HTMLElement>('[data-ops-shares-foreign-card]')!.hidden).toBe(false)
    expect(document.querySelector('[data-ops-shares-foreign]')!.textContent).toContain('/data')
  })
  it('adds a draft share and saves it with the observed revision', async () => {
    let stored = view({ config: { shares: [] }, observed: { state: 'read', managedPresent: false, shares: [], foreignExports: [], reason: null } })
    const send = vi.fn(async (method: string, _path: string, body?: unknown) => { if (method === 'PUT') { stored = view({ savedRevision: rev('9'), config: (body as { config: unknown }).config as never }) } return stored })
    boot(send)
    action('read').click(); await tick()
    ;(document.querySelector<HTMLInputElement>('[data-ops-shares-path]')!).value = '/srv/shares/new'
    ;(document.querySelector<HTMLInputElement>('[data-ops-shares-host]')!).value = '10.0.0.0/24'
    document.querySelector<HTMLButtonElement>('[data-ops-shares-add]')!.click()
    expect(document.querySelector('[data-ops-shares-rows]')!.textContent).toContain('/srv/shares/new')
    document.querySelector<HTMLButtonElement>('[data-ops-shares-save]')!.click(); await tick()
    const put = send.mock.calls.find(callArgs => callArgs[0] === 'PUT')!
    expect((put[2] as { config: { shares: { path: string }[] } }).config.shares[0]!.path).toBe('/srv/shares/new')
    expect((put[2] as { expectedSavedRevision: string }).expectedSavedRevision).toBe(rev('1'))
    expect(status().dataset.state).toBe('saved')
  })
  it('rejects a path outside the managed roots before any request', async () => {
    const send = vi.fn(async (_method: string, _path?: string, _body?: unknown) => view({ config: { shares: [] }, observed: { state: 'read', managedPresent: false, shares: [], foreignExports: [], reason: null } }))
    boot(send)
    action('read').click(); await tick()
    ;(document.querySelector<HTMLInputElement>('[data-ops-shares-path]')!).value = '/etc/passwd'
    ;(document.querySelector<HTMLInputElement>('[data-ops-shares-host]')!).value = '*'
    document.querySelector<HTMLButtonElement>('[data-ops-shares-add]')!.click()
    expect(status().dataset.state).toBe('failed')
    expect(send.mock.calls.filter(callArgs => callArgs[0] === 'PUT')).toHaveLength(0)
  })
  it('confirms then applies and reflects a restored rollback (ar)', async () => {
    const send = vi.fn(async (method: string, _path?: string, _body?: unknown) => { if (method === 'POST') throw Object.assign(new Error('x'), { details: { rolledBack: true } }); return view() })
    const ask = vi.fn(async () => true)
    boot(send, ask, 'ar')
    action('read').click(); await tick()
    action('apply').click(); await tick()
    expect(ask).toHaveBeenCalled()
    expect(send.mock.calls.some(callArgs => callArgs[0] === 'POST' && callArgs[1] === '/api/server/file-sharing/apply')).toBe(true)
    expect(status().dataset.state).toBe('conflict')
  })
  it('shows an unavailable NFS server honestly and keeps apply disabled', async () => {
    boot(vi.fn(async () => view({ observed: { state: 'unavailable', managedPresent: false, shares: [], foreignExports: [], reason: 'nfs_server_unavailable' } })))
    action('read').click(); await tick()
    expect(status().dataset.state).toBe('unavailable')
    expect(document.querySelector('[data-ops-shares-fact="nfs"]')!.textContent).toBe('Not installed')
    expect(action('apply').disabled).toBe(true)
  })
})
