// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderMailxArchiveWorkspace } from './board-port/mailx-archive-workspace.ts'
import { MAILX_ARCHIVE_CLIENT_BINDING, readMailxArchiveView } from './mailx-archive-client.ts'

const tick = async () => { for (let index = 0; index < 8; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
const row = { domain: 'shop.example', mailbox: 'archive@shop.example', incoming: true, outgoing: false, retentionDays: 30 }
const view = (extra: Record<string, unknown> = {}) => ({ context: { account: 'alice' }, saved: true, revision: 'a'.repeat(64), compositeRevision: 'b'.repeat(64),
  choices: [{ domain: 'shop.example', mailboxes: ['archive@shop.example', 'info@shop.example'] }, { domain: 'blog.example', mailboxes: [] }],
  policy: { domains: [row] }, updatedAt: '2026-10-28T09:00:00.000Z', host: 'connected', observedAt: '2026-10-28T10:00:00.000Z', state: 'applied',
  rows: [{ domain: 'shop.example', admission: 'eligible', conflicts: [] }], capabilities: { retentionJobs: true }, application: null, ...extra })
const mount = (canManage = true) => { document.body.innerHTML = renderMailxArchiveWorkspace({ locale: 'en', canManage }) }
const boot = (request?: (method: string, path: string, body?: unknown) => Promise<unknown>, ask?: (options: unknown) => Promise<unknown>) => {
  if (request) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  new Function('return ' + MAILX_ARCHIVE_CLIENT_BINDING)()(ask)
}
const shop = () => document.querySelector<HTMLTableRowElement>('tr[data-domain="shop.example"]')!
afterEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('email archive client', () => {
  it('parses strictly', () => {
    expect(readMailxArchiveView(view()).policy.domains).toEqual([row])
    for (const bad of [view({ saved: false }), view({ rows: [] }), view({ policy: { domains: [{ ...row, retentionDays: 4000 }] } }), view({ capabilities: {} }), view({ host: 'up' })]) expect(() => readMailxArchiveView(bad)).toThrow()
  })
  it('stays inert without manage authority', async () => {
    const send = vi.fn(async () => view())
    mount(false); boot(send); await tick()
    expect(send).not.toHaveBeenCalled()
    expect(document.querySelector('[data-mailx-archive-status]')!.getAttribute('data-state')).toBe('unavailable')
  })
  it('paints owned domains, saves only selected rows and confirms retention before submitting a job', async () => {
    const calls: [string, string, unknown][] = []
    const send = vi.fn(async (method: string, path: string, body?: unknown) => { calls.push([method, path, body]); return method === 'GET' ? view() : method === 'PUT' ? { ...view(), application: { outcome: 'applied' } } : { job: { id: 'j1', status: 'queued' } } })
    const ask = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    mount(); boot(send, ask); await tick()
    expect(shop().querySelector<HTMLSelectElement>('select')!.value).toBe('archive@shop.example')
    expect(document.querySelector('tr[data-domain="blog.example"] select')!.textContent).toContain('No mailbox on this domain')
    shop().querySelector<HTMLInputElement>('[data-archive-direction="outgoing"]')!.checked = true
    document.querySelector<HTMLFormElement>('[data-mailx-archive-form]')!.requestSubmit(); await tick()
    expect(calls[1]).toEqual(['PUT', '/api/account/mailx/archive', { policy: { domains: [{ ...row, outgoing: true }] }, expectedRevision: 'a'.repeat(64) }])
    const run = shop().querySelector<HTMLButtonElement>('button')!
    expect(run.disabled).toBe(false)
    run.click(); await tick()
    expect(calls.some(([method]) => method === 'POST')).toBe(false)
    run.click(); await tick()
    expect(ask.mock.calls[1]![0]).toMatchObject({ danger: true })
    expect(calls.find(([method]) => method === 'POST')).toEqual(['POST', '/api/account/mailx/archive/retention', { domain: 'shop.example', expectedRevision: 'a'.repeat(64) }])
  })
  it('locks retention for unlimited rows and reports copy-rule conflicts', async () => {
    mount(); boot(async () => view({ policy: { domains: [{ ...row, retentionDays: 0 }] }, rows: [{ domain: 'shop.example', admission: 'eligible', conflicts: ['incoming'] }] })); await tick()
    expect(shop().querySelector<HTMLButtonElement>('button')!.disabled).toBe(true)
    expect(shop().textContent).toContain('server copy rule')
  })
})
