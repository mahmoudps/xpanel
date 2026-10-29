// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmAccountTemplatesWorkspace } from './board-port/acct-templates-workspace.ts'
import { readWhmAccountTemplatesView, WHM_ACCOUNT_TEMPLATES_CLIENT_BINDING } from './acct-templates-client.ts'

const R1 = 'a'.repeat(64), R2 = 'b'.repeat(64)
const T1 = '77777777-7777-4777-8777-000000000001', PLAN = '33333333-3333-4333-8333-333333333333'
const page = { title: 'Welcome', body: 'Soon.' }
const template = (overrides: Record<string, unknown> = {}) => ({ id: T1, name: 'Shared', records: [{ name: 'shop', ttl: 3600, type: 'CNAME', priority: null, content: 'www.%domain%.' }], zone: 'shop 3600 CNAME www.%domain%.', defaultPage: page, suspendedPage: page, planIds: [PLAN], updatedAt: '2026-10-27T10:00:00.000Z', updatedBy: 'root', preview: [{ name: 'shop', type: 'CNAME', ttl: 3600, priority: null, content: 'www.example.com.' }], ...overrides })
const view = (overrides: Record<string, unknown> = {}) => ({ state: 'saved', revision: R1, templates: [template()], plans: [{ id: PLAN, name: 'Starter' }], placeholders: ['%domain%'], sample: {}, application: { appliedToNewAccounts: true, defaultPagePublished: false, suspendedPagePublished: false }, ...overrides })
type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const boot = (send?: Send, locale: 'en' | 'ar' = 'en', canManage = true, ask?: (options: Record<string, unknown>) => Promise<unknown>) => {
  document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
  document.body.innerHTML = renderWhmAccountTemplatesWorkspace({ locale, canManage })
  if (send) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
  new Function('return ' + WHM_ACCOUNT_TEMPLATES_CLIENT_BINDING)()(ask, locale === 'ar')
}
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const input = (name: string) => $<HTMLInputElement>(`[data-acct-templates-input="${name}"]`)

beforeEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })
afterEach(() => { document.body.innerHTML = ''; document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr' })

describe('account templates parser', () => {
  it('accepts the server view and refuses claims of page publication', () => {
    expect(readWhmAccountTemplatesView(view()).templates[0]!.recordCount).toBe(1)
    for (const bad of [view({ application: { appliedToNewAccounts: false, defaultPagePublished: false, suspendedPagePublished: false } }), view({ application: { appliedToNewAccounts: true, defaultPagePublished: false, suspendedPagePublished: true } }), view({ state: 'default' }), view({ templates: [template(), template()] }), view({ templates: [template({ planIds: ['x'] })] })])
      expect(() => readWhmAccountTemplatesView(bad)).toThrow()
  })
})

describe('account templates client', () => {
  it('paints templates, opens one for editing with its preview and saves it with the revision', async () => {
    const send = vi.fn(async (method: string) => method === 'GET' ? view() : view({ revision: R2, templates: [template({ name: 'Renamed' })], changed: T1 }))
    boot(send)
    await flush()
    expect($('[data-acct-templates-rows]').textContent).toContain('Starter')
    expect($('[data-acct-templates-application]').textContent).toContain('template records')
    expect($('[data-acct-templates-pages]').dataset.state).toBe('unavailable')
    $<HTMLButtonElement>('[data-action="edit"]').click()
    expect(input('zone').value).toBe('shop 3600 CNAME www.%domain%.')
    expect($('[data-acct-templates-preview]').textContent).toContain('www.example.com.')
    expect($<HTMLInputElement>('[data-acct-templates-plans] input').checked).toBe(true)
    input('name').value = 'Renamed'
    $<HTMLFormElement>('[data-acct-templates-form]').dispatchEvent(new Event('submit', { cancelable: true }))
    await flush()
    expect(send).toHaveBeenLastCalledWith('PUT', '/api/server/account-templates/' + T1, expect.objectContaining({ name: 'Renamed', planIds: [PLAN], expectedRevision: R1 }))
    expect($('[data-acct-templates-save-status]').dataset.state).toBe('ok')
  })
  it('reports a refused zone line without claiming success', async () => {
    const send = vi.fn(async (method: string) => { if (method === 'GET') return view({ templates: [], state: 'default' }); throw Object.assign(new Error('bad'), { status: 400, details: { line: 2 } }) })
    boot(send)
    await flush()
    input('name').value = 'New'; input('zone').value = 'a 1 A %ipv4%\nb x A'
    $<HTMLFormElement>('[data-acct-templates-form]').dispatchEvent(new Event('submit', { cancelable: true }))
    await flush()
    expect($('[data-acct-templates-save-status]').dataset.state).toBe('failed')
    expect($('[data-acct-templates-save-status]').textContent).toContain('line 2')
  })
  it('deletes only after confirmation and stays read-only without authority', async () => {
    const send = vi.fn(async (method: string) => method === 'GET' ? view() : view({ revision: R2, templates: [] }))
    boot(send, 'en', true, async () => true)
    await flush()
    $<HTMLButtonElement>('[data-action="delete"]').click()
    await flush()
    expect(send).toHaveBeenLastCalledWith('DELETE', '/api/server/account-templates/' + T1, { expectedRevision: R1 })
    document.body.innerHTML = ''
    const quiet = vi.fn(async () => view())
    boot(quiet, 'ar', false)
    await flush()
    expect(quiet).not.toHaveBeenCalled()
    expect($('[data-acct-templates-workspace]').getAttribute('dir')).toBe('rtl')
  })
})
