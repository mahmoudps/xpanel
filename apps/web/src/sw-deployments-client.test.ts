// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account } from '@xpanel/core'
import { renderSwDeploymentsWorkspace } from './board-port/sw-deployments-workspace.ts'
import { SW_DEPLOYMENTS_CLIENT_BINDING } from './sw-deployments-client.ts'
import { handleSwDeploymentsWorkspaceRoute } from '../../api/src/sw-deployments-workspace.ts'

const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const old = 'a'.repeat(40), next = 'c'.repeat(40), revision = 'f'.repeat(64)
const repo = (head: string, dirty = false) => ({ path: 'site', branch: 'main', head, dirty, changedFiles: dirty ? 2 : 0, remote: 'https://example.com/site.git', branches: [{ name: 'main', hash: head, current: true }], commits: [{ hash: head, at: '2026-10-28T01:00:00+00:00', subject: 'Release' }] })
const view = (selected: null | object, account: string | null = 'alice', nativeAvailable = true) => ({ scope: 'account-git-deployments', filesAvailable: true, nativeAvailable, accounts: [{ username: 'alice', gitAllowed: true }, { username: 'bob', gitAllowed: false }], selected: account === null ? null : { context: { accountId: '11111111-1111-4111-8111-111111111111', username: account }, revision, repositories: ['site'], selected, nativeAvailable, application: { op: 'list', state: 'read', verificationRequired: false } } })
const boot = (send: (method: string, path: string, body?: unknown) => Promise<unknown>, ask?: () => Promise<boolean>) => { (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send; new Function('return ' + SW_DEPLOYMENTS_CLIENT_BINDING)()(ask) }
const choose = async (name: string) => { const select = document.querySelector<HTMLSelectElement>('[data-sw-dep-account]')!; select.value = name; select.dispatchEvent(new Event('change')); await tick() }
beforeEach(() => { document.body.innerHTML = renderSwDeploymentsWorkspace({ locale: 'en', canRead: true, canManage: true }); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('deployments workspace', () => {
  it('renders both directions with ASCII digits and a disabled deploy control', () => {
    for (const locale of ['en', 'ar'] as const) {
      document.body.innerHTML = renderSwDeploymentsWorkspace({ locale, canRead: true, canManage: true })
      expect(document.querySelector<HTMLElement>('[data-sw-deployments]')!.dir).toBe(locale === 'ar' ? 'rtl' : 'ltr'); expect(document.querySelector<HTMLButtonElement>('[data-sw-dep-pull]')!.disabled).toBe(true)
      expect(document.body.textContent).not.toMatch(/[٠-٩۰-۹]/)
    }
  })
  it('selects an account, inspects a repository and deploys the reviewed commit after confirmation', async () => {
    const send = vi.fn(async (method: string, path: string) => method === 'GET' ? view(null, path.includes('?') ? 'alice' : null) : path.endsWith('/inspect') ? view(repo(old)) : view(repo(next)))
    const ask = vi.fn(async () => true)
    boot(send, ask); await tick()
    const options = [...document.querySelectorAll<HTMLOptionElement>('[data-sw-dep-account] option')]
    expect(options.find(option => option.value === 'bob')!.disabled).toBe(true)
    await choose('alice')
    document.querySelector<HTMLButtonElement>('[data-sw-dep-repositories] button')!.click(); await tick()
    expect(document.querySelector('[data-sw-dep-head]')!.textContent).toBe(old)
    const pull = document.querySelector<HTMLButtonElement>('[data-sw-dep-pull]')!; expect(pull.disabled).toBe(false)
    pull.click(); await tick()
    expect(ask).toHaveBeenCalledOnce(); expect(send).toHaveBeenLastCalledWith('POST', '/api/server/software/deployments/pull', { account: 'alice', path: 'site', expectedHead: old, expectedRevision: revision })
    expect(document.querySelector('[data-sw-dep-head]')!.textContent).toBe(next); expect(document.querySelector('[data-sw-dep-status]')!.textContent).toContain(next.slice(0, 12))
  })
  it('refuses to deploy dirty trees or without the isolated runner, and locks after unknown outcomes', async () => {
    let dirty = true
    const send = vi.fn(async (method: string, path: string) => { if (method === 'GET') return view(null, path.includes('?') ? 'alice' : null); if (path.endsWith('/inspect')) return view(repo(old, dirty)); throw { status: 503, details: { stateChanged: true } } })
    boot(send, async () => true); await tick(); await choose('alice')
    document.querySelector<HTMLButtonElement>('[data-sw-dep-repositories] button')!.click(); await tick()
    expect(document.querySelector<HTMLButtonElement>('[data-sw-dep-pull]')!.disabled).toBe(true)
    dirty = false; document.querySelector<HTMLButtonElement>('[data-sw-dep-repositories] button')!.click(); await tick()
    document.querySelector<HTMLButtonElement>('[data-sw-dep-pull]')!.click(); await tick()
    expect(document.querySelector('[data-sw-dep-status]')!.getAttribute('data-state')).toBe('uncertain'); expect(document.querySelector<HTMLButtonElement>('[data-sw-dep-pull]')!.disabled).toBe(true)
  })
  it('the API pins the account and refuses forged or unverifiable replies', async () => {
    const account = { id: '11111111-1111-4111-8111-111111111111', username: 'alice' } as Account, principal = { id: 'p', username: 'root' }
    const helpers = { requireCaller: vi.fn(async () => ({ principal }) as never), assertRoot: vi.fn(async () => {}), emitAudit: vi.fn(async () => {}) as never, getAccountByUsername: vi.fn(async (name: string) => name === 'alice' ? account : null), callHost: vi.fn(async () => view(null)) }
    const get = (query: string) => { const url = new URL('http://api.local/api/server/software/deployments' + query); return handleSwDeploymentsWorkspaceRoute(new Request(url), url, 'GET', helpers) }
    expect((await (await get('?account=alice'))!.json()).selected.repositories).toEqual(['site'])
    helpers.callHost = vi.fn(async () => ({ ...view(null), selected: { ...view(null).selected!, context: { accountId: 'other', username: 'alice' } } }))
    await expect(get('?account=alice')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(get('?account=carol')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const url = new URL('http://api.local/api/server/software/deployments/pull')
    helpers.callHost = vi.fn(async () => view(repo(next, true)))
    await expect(handleSwDeploymentsWorkspaceRoute(new Request(url, { method: 'POST', body: JSON.stringify({ account: 'alice', path: 'site', expectedHead: old, expectedRevision: revision }) }), url, 'POST', helpers)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true } })
    expect(helpers.emitAudit).toHaveBeenCalledOnce()
  })
})
