// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderSwApplicationsWorkspace } from './board-port/sw-applications-workspace.ts'
import { SW_APPLICATIONS_CLIENT_BINDING } from './sw-applications-client.ts'
import { handleSwApplicationsWorkspaceRoute } from '../../api/src/sw-applications-workspace.ts'

const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const accountId = '11111111-1111-4111-8111-111111111111', domainId = '22222222-2222-4222-8222-222222222222', H = (c: string) => c.repeat(64)
const view = (selected: unknown = null, catalogState: 'read' | 'unavailable' = 'read') => ({ context: { accountId, username: 'alice' },
  catalog: catalogState === 'read' ? { state: 'read', reason: null, revision: H('c'), sequence: 7, expiresAt: '2026-10-29T12:00:00.000Z', applications: [{ id: 'sample', name: 'Sample', versions: ['1.2.3', '1.2.4'] }] } : { state: 'unavailable', reason: 'not-configured', revision: null, sequence: null, expiresAt: null, applications: [] },
  domains: [{ id: domainId, name: 'a.example' }], instances: [], selected })
const readable = (installation: unknown = null, writesAvailable = true) => ({ domainId, path: '', state: 'read', reason: null, revision: H('b'), installation, recoveryRequired: false, modified: false, writesAvailable })
const boot = (send: (method: string, path: string, body?: unknown) => Promise<unknown>, ask?: () => Promise<boolean>) => { (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send; new Function('return ' + SW_APPLICATIONS_CLIENT_BINDING)()(ask) }
const pick = async (selector: string, value: string) => { const node = document.querySelector<HTMLSelectElement>(selector)!; node.value = value; node.dispatchEvent(new Event('change')); await tick() }
beforeEach(() => { document.body.innerHTML = renderSwApplicationsWorkspace({ lang: 'en', canManage: true }); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('applications workspace', () => {
  it('renders both directions with every action disabled before a verified read', () => {
    for (const lang of ['en', 'ar'] as const) {
      document.body.innerHTML = renderSwApplicationsWorkspace({ lang, canManage: true })
      expect(document.querySelector<HTMLElement>('[data-sw-apps]')!.dir).toBe(lang === 'ar' ? 'rtl' : 'ltr')
      expect([...document.querySelectorAll<HTMLButtonElement>('[data-sw-apps-action]')].every(button => button.disabled)).toBe(true)
      expect(document.body.textContent).not.toMatch(/[٠-٩۰-۹]/)
    }
  })
  it('reads inside a read-only frame but never writes, with every control disabled', async () => {
    document.body.innerHTML = '<div data-readonly="true">' + renderSwApplicationsWorkspace({ lang: 'en', canManage: true }) + '</div>'
    const send = vi.fn(async (_method: string, _path: string, _body?: unknown) => view())
    boot(send, async () => true); await tick()
    expect(document.querySelector('[data-sw-apps-catalog]')!.textContent).toBe('Verified signed catalog')
    expect(send).toHaveBeenCalled()
    expect((send.mock.calls as unknown[][]).every(call => call[0] === 'GET')).toBe(true)
    expect([...document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select')].filter(control => !control.matches('[role="tab"],[aria-pressed]')).every(control => control.disabled)).toBe(true)
  })
  it('keeps installs disabled while the provider is unavailable and never shows an installed app', async () => {
    boot(vi.fn(async (_m: string, path: string) => view(path.includes('?') ? { domainId, path: '', state: 'unavailable', reason: 'application_provider_unavailable', revision: null, installation: null, recoveryRequired: null, modified: null, writesAvailable: false } : null)), async () => true); await tick()
    await pick('[data-sw-apps-domain-select]', domainId); await pick('[data-sw-apps-app-select]', 'sample'); await pick('[data-sw-apps-version-select]', '1.2.3')
    expect(document.querySelector('[data-sw-apps-installed]')!.textContent).toBe('Unavailable')
    expect(document.querySelector<HTMLButtonElement>('[data-sw-apps-action="install"]')!.disabled).toBe(true)
    expect(document.querySelector('[data-sw-apps-capability]')!.textContent).toContain('descriptor-confined')
  })
  it('submits one reviewed install job with both revisions and then locks', async () => {
    const send = vi.fn(async (method: string, path: string) => method === 'POST' ? { job: { id: 'job-5', kind: 'application.install' } } : view(path.includes('?') ? readable() : null)), ask = vi.fn(async () => true)
    boot(send, ask); await tick(); await pick('[data-sw-apps-domain-select]', domainId); await pick('[data-sw-apps-app-select]', 'sample'); await pick('[data-sw-apps-version-select]', '1.2.4')
    const install = document.querySelector<HTMLButtonElement>('[data-sw-apps-action="install"]')!
    expect(install.disabled).toBe(false); expect(document.querySelector<HTMLButtonElement>('[data-sw-apps-action="remove"]')!.disabled).toBe(true)
    install.click(); await tick()
    expect(send).toHaveBeenLastCalledWith('POST', '/api/account/applications/jobs', { domainId, path: '', action: 'install', appId: 'sample', version: '1.2.4', expectedRevision: H('b'), expectedCatalogRevision: H('c') })
    expect(document.querySelector('[data-sw-apps-status]')!.textContent).toContain('job-5'); expect(install.disabled).toBe(true)
  })
  it('reads and installs under a directory, lists installations and opens one for management', async () => {
    const installed = { domainId, domain: 'a.example', path: 'blog', appId: 'sample', version: '1.2.3', previousVersion: null, database: 'alice_app1', updatedAt: '2026-11-07T12:00:00.000Z' }
    const send = vi.fn(async (method: string, path: string, _body?: unknown) => method === 'POST' ? { job: { id: 'job-8', kind: 'application.remove' } } : { ...view(path.includes('?') ? { ...readable({ appId: 'sample', version: '1.2.3', previousVersion: null }), path: 'blog', modified: true } : null), instances: [installed] })
    boot(send, async () => true); await tick()
    expect(document.querySelector('[data-sw-apps-instances]')!.textContent).toContain('a.example/blog')
    await pick('[data-sw-apps-instance-select]', domainId + '|blog')
    expect(send).toHaveBeenLastCalledWith('GET', '/api/account/applications?domainId=' + domainId + '&path=blog')
    expect(document.querySelector('[data-sw-apps-recovery]')!.textContent).toBe('Files changed outside this tool')
    await pick('[data-sw-apps-app-select]', 'sample'); await pick('[data-sw-apps-version-select]', '1.2.4')
    expect(document.querySelector<HTMLButtonElement>('[data-sw-apps-action="update"]')!.disabled).toBe(true)
    const remove = document.querySelector<HTMLButtonElement>('[data-sw-apps-action="remove"]')!
    expect(remove.disabled).toBe(false)
    remove.click(); await tick()
    expect(send).toHaveBeenLastCalledWith('POST', '/api/account/applications/jobs', { domainId, path: 'blog', action: 'remove', appId: 'sample', expectedRevision: H('b'), expectedCatalogRevision: H('c') })
  })
  it('offers Recover only for a stranded change and reads again after it', async () => {
    const send = vi.fn(async (method: string, path: string, _body?: unknown) => method === 'POST' ? { results: [] } : view(path.includes('?') ? { ...readable({ appId: 'sample', version: '1.2.3', previousVersion: null }, true), recoveryRequired: true } : null))
    boot(send, async () => true); await tick()
    await pick('[data-sw-apps-domain-select]', domainId)
    const recover = document.querySelector<HTMLButtonElement>('[data-sw-apps-action="recover"]')!
    expect(recover.disabled).toBe(false); expect(document.querySelector<HTMLButtonElement>('[data-sw-apps-action="remove"]')!.disabled).toBe(true)
    recover.click(); await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/account/applications/recover', { domainId, path: '' })
    expect(document.querySelector('[data-sw-apps-status]')!.textContent).toContain('Recovery finished')
  })
  it('the API validates the change grammar before the agent and pins the job to the account', async () => {
    const account = { id: accountId, username: 'alice', status: 'active', planId: 'p' }
    const readAgent = vi.fn(async () => ({ job: { id: 'job-5', kind: 'application.install', accountId } }))
    const ports = { store: { getAccount: async () => account, getPlan: async () => ({ featureListId: 'f' }), getFeatureList: async () => ({ disabled: [] }) } as never, requireCaller: async () => ({ principal: { kind: 'user', id: 'u1', accountId, username: 'alice' }, scopes: [] }) as never, readAgent: readAgent as never }
    const url = new URL('http://api.local/api/account/applications/jobs')
    const post = (body: unknown) => handleSwApplicationsWorkspaceRoute(new Request(url, { method: 'POST', body: JSON.stringify(body) }), url, 'POST', ports)
    const body = { domainId, action: 'install', appId: 'sample', version: '1.2.4', expectedRevision: H('b'), expectedCatalogRevision: H('c') }
    expect((await post(body))!.status).toBe(202)
    expect(readAgent).toHaveBeenCalledWith(expect.anything(), '/accounts/alice/applications/jobs', { ...body, path: '' }, true)
    await expect(post({ ...body, path: '/home/alice' })).rejects.toMatchObject({ code: 'VALIDATION' }); await expect(post({ ...body, action: 'remove' })).rejects.toMatchObject({ code: 'VALIDATION' })
    readAgent.mockResolvedValueOnce({ job: { id: 'job-6', kind: 'application.install', accountId: 'other' } })
    await expect(post(body)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true } })
  })
})
