// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmSiteInstancesCard } from './board-port/whm-extend-workspace.ts'
import { SITE_INSTANCES_CLIENT_BINDING } from './site-software-instances-client.ts'

const tick = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const row = { username: 'alice', accountId: '11111111-1111-4111-8111-111111111111', domainId: '22222222-2222-4222-8222-222222222222', domain: 'a.example', path: 'blog', appId: 'sample', version: '1.0.0', previousVersion: null, database: 'alice_app1', updatedAt: '2026-11-07T12:00:00.000Z', revision: 'a'.repeat(64), accountStatus: 'active' }
const catalog = { host: { catalog: { state: 'read', applications: [{ id: 'sample', name: 'Sample', versions: ['1.1.0', '1.0.0'], stored: ['1.0.0'] }] } } }
const send = (overrides: Record<string, unknown> = {}) => vi.fn(async (method: string, path: string, _body?: unknown) => {
  if (path in overrides) { const value = overrides[path]; if (value instanceof Error) throw value; return value }
  if (method === 'GET') return path.endsWith('/instances') ? { instances: [row] } : catalog
  return { job: { id: 'job-7', kind: 'application.update' } }
})
const boot = (transport: unknown, ask?: () => Promise<boolean>) => {
  (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = transport
  new Function('return ' + SITE_INSTANCES_CLIENT_BINDING)()(ask)
}
const q = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!
beforeEach(() => { document.body.innerHTML = renderWhmSiteInstancesCard({ locale: 'en', canManage: true }); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('installed site software', () => {
  it('lists every copy and stored release, with actions locked until one is chosen', async () => {
    boot(send()); await tick()
    expect(q('[data-site-instances-rows]').textContent).toContain('a.example/blog')
    expect(q('[data-site-instances-rows]').textContent).toContain('alice_app1')
    expect(q('[data-site-instances-releases]').textContent).toContain('Not stored')
    expect(q<HTMLButtonElement>('[data-site-instances-action="update"]').disabled).toBe(true)
    const select = q<HTMLSelectElement>('[data-site-instances-select]')
    select.value = row.revision; select.dispatchEvent(new Event('change'))
    expect(q<HTMLButtonElement>('[data-site-instances-action="update"]').disabled).toBe(false)
    expect(q<HTMLButtonElement>('[data-site-instances-action="remove"]').disabled).toBe(false)
  })
  it('submits the latest version as a job only after review, naming the row it read', async () => {
    const transport = send(), ask = vi.fn(async () => true)
    boot(transport, ask); await tick()
    const select = q<HTMLSelectElement>('[data-site-instances-select]')
    select.value = row.revision; select.dispatchEvent(new Event('change'))
    q('[data-site-instances-action="update"]').click(); await tick()
    expect(ask).toHaveBeenCalledOnce()
    expect(transport).toHaveBeenCalledWith('POST', '/api/server/site-software/instances/jobs', { username: 'alice', domainId: row.domainId, path: 'blog', action: 'update', expectedRecord: row.revision, version: '1.1.0' })
    expect(q('[data-site-instances-status]').dataset.state).toBe('submitted')
    expect(q<HTMLButtonElement>('[data-site-instances-action="update"]').disabled).toBe(true)
  })
  it('sends nothing when the review is declined and reports a refused or unknown job truthfully', async () => {
    const declined = send()
    boot(declined, vi.fn(async () => false)); await tick()
    const select = q<HTMLSelectElement>('[data-site-instances-select]')
    select.value = row.revision; select.dispatchEvent(new Event('change'))
    q('[data-site-instances-action="remove"]').click(); await tick()
    expect(declined.mock.calls.filter(call => call[0] === 'POST')).toEqual([])

    document.body.innerHTML = renderWhmSiteInstancesCard({ locale: 'en', canManage: true })
    boot(send({ '/api/server/site-software/instances/jobs': Object.assign(new Error('x'), { details: { stateChanged: true } }) }), vi.fn(async () => true)); await tick()
    const next = q<HTMLSelectElement>('[data-site-instances-select]')
    next.value = row.revision; next.dispatchEvent(new Event('change'))
    q('[data-site-instances-action="remove"]').click(); await tick()
    expect(q('[data-site-instances-status]').dataset.state).toBe('uncertain')
  })
  it('uploads a release in chunks with its offset and reads the list again', async () => {
    const transport = send({ '/api/server/site-software/artifacts': { received: 3, complete: true, bytes: 3 } })
    boot(transport); await tick()
    const release = q<HTMLSelectElement>('[data-site-instances-release-select]'), file = q<HTMLInputElement>('[data-site-instances-file]')
    release.value = 'sample|1.1.0'
    Object.defineProperty(file, 'files', { configurable: true, value: [{ size: 3, slice: () => ({ arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }) }] })
    file.dispatchEvent(new Event('change'))
    q('[data-site-instances-action="upload"]').click(); await tick()
    expect(transport).toHaveBeenCalledWith('POST', '/api/server/site-software/artifacts', { appId: 'sample', version: '1.1.0', offset: 0, contentBase64: 'AQID' })
    expect(q('[data-site-instances-status]').textContent).toContain('signed digest')
  })
  it('stays unavailable without authority and reads nothing', async () => {
    document.body.innerHTML = renderWhmSiteInstancesCard({ locale: 'en', canManage: false })
    const transport = send()
    boot(transport); await tick()
    expect(transport).not.toHaveBeenCalled()
    expect(q('[data-site-instances-status]').dataset.state).toBe('unavailable')
    expect([...document.querySelectorAll<HTMLButtonElement>('[data-site-instances-action]')].every(button => button.disabled)).toBe(true)
  })
})
