// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmAccountEnhancementsWorkspace } from './board-port/acct-enhancements-workspace.ts'
import { readWhmEnhancementsView, WHM_ENHANCEMENTS_CLIENT_BINDING } from './acct-enhancements-client.ts'

const R1 = 'a'.repeat(64), R2 = 'b'.repeat(64)
const PLAN = '33333333-3333-4333-8333-333333333333', RESELLER = '22222222-2222-4222-8222-222222222222', A = '55555555-5555-4555-8555-555555555551'
const definitions = [{ id: 'priority-support', label: 'Priority support', kind: 'flag', min: null, max: null }, { id: 'extra-sites', label: 'Extra sites', kind: 'limit', min: 0, max: 10 }]
const document_ = (overrides: Record<string, unknown> = {}) => ({ definitions, planAssignments: { [PLAN]: { 'extra-sites': 2 } }, accountAssignments: { [A]: { 'priority-support': true } }, resellerLimits: { [RESELLER]: { 'priority-support': 2 } }, ...overrides })
const directory = { plans: [{ id: PLAN, name: 'Starter' }], accounts: [{ id: A, username: 'alice', planId: PLAN, ownerId: RESELLER }], resellers: [{ id: RESELLER, username: 'res1' }] }
const view = (overrides: Record<string, unknown> = {}) => ({ state: 'saved', revision: R1, document: document_(), directory, application: { enforced: false, resellerAssignment: false }, ...overrides })
type Send = (method: string, path: string, body?: unknown) => Promise<unknown>
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const boot = (send?: Send, locale: 'en' | 'ar' = 'en', canManage = true, ask?: (options: Record<string, unknown>) => Promise<unknown>) => {
  document.documentElement.lang = locale; document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr'
  document.body.innerHTML = renderWhmAccountEnhancementsWorkspace({ locale, canManage })
  if (send) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
  new Function('return ' + WHM_ENHANCEMENTS_CLIENT_BINDING)()(ask)
}
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const input = (name: string) => $<HTMLInputElement & HTMLSelectElement>(`[data-acct-enh-input="${name}"]`)
const submit = (name: string) => $<HTMLFormElement>(`[data-acct-enh-form="${name}"]`).dispatchEvent(new Event('submit', { cancelable: true }))

beforeEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })
afterEach(() => { document.body.innerHTML = ''; document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr' })

describe('account enhancements parser', () => {
  it('accepts the server view and refuses enforcement claims or bad values', () => {
    expect(readWhmEnhancementsView(view()).document.definitions).toHaveLength(2)
    for (const bad of [view({ application: { enforced: true, resellerAssignment: false } }), view({ document: document_({ accountAssignments: { [A]: { 'extra-sites': 11 } } }) }), view({ document: document_({ planAssignments: { [PLAN]: { unknown: true } } }) }), view({ state: 'default' })])
      expect(() => readWhmEnhancementsView(bad)).toThrow()
  })
})

describe('account enhancements client', () => {
  it('paints definitions, assignments and reseller usage', async () => {
    boot(vi.fn(async () => view()))
    await flush()
    expect($('[data-acct-enh-rows="definitions"]').textContent).toContain('Extra sites')
    expect($('[data-acct-enh-rows="assignments"]').textContent).toContain('Starter')
    expect($('[data-acct-enh-rows="limits"]').textContent).toContain('res1')
    expect($('[data-acct-enh-application]').textContent).toContain('No xPanel feature reads them yet')
  })
  it('saves a limit assignment as the whole document with the revision', async () => {
    const send = vi.fn(async (method: string) => method === 'GET' ? view() : view({ revision: R2, document: document_({ accountAssignments: { [A]: { 'priority-support': true, 'extra-sites': 5 } } }) }))
    boot(send)
    await flush()
    input('assign-scope').value = 'account'; input('assign-scope').dispatchEvent(new Event('change'))
    input('assign-target').value = A
    input('assign-enhancement').value = 'extra-sites'; input('assign-enhancement').dispatchEvent(new Event('change'))
    expect($('[data-acct-enh-value-field]').hidden).toBe(false)
    input('assign-value').value = '5'
    submit('assignment')
    await flush()
    expect(send).toHaveBeenLastCalledWith('PUT', '/api/server/account-enhancements', expect.objectContaining({ expectedRevision: R1, accountAssignments: { [A]: { 'priority-support': true, 'extra-sites': 5 } } }))
    expect($('[data-acct-enh-save-status]').dataset.state).toBe('ok')
  })
  it('shows a limit refusal and deletes a definition with its references after confirmation', async () => {
    const send = vi.fn(async (method: string) => { if (method === 'GET') return view(); throw Object.assign(new Error('limit'), { status: 422, details: { limit: 0 } }) })
    boot(send, 'en', true, async () => true)
    await flush()
    input('limit-reseller').value = RESELLER; input('limit-enhancement').value = 'priority-support'; input('limit-value').value = '0'
    submit('limit')
    await flush()
    expect($('[data-acct-enh-save-status]').textContent).toContain('more often than the limit allows')
    $<HTMLButtonElement>('[data-acct-enh-rows="definitions"] .xp-btn--danger').click()
    await flush()
    expect(send).toHaveBeenLastCalledWith('PUT', '/api/server/account-enhancements', { expectedRevision: R1, definitions: [definitions[1]], planAssignments: { [PLAN]: { 'extra-sites': 2 } }, accountAssignments: {}, resellerLimits: {} })
  })
  it('stays read-only without authority', async () => {
    const send = vi.fn(async () => view())
    boot(send, 'ar', false)
    await flush()
    expect(send).not.toHaveBeenCalled()
    expect($('[data-acct-enh-status]').dataset.state).toBe('unavailable')
    expect($('[data-acct-enh-workspace]').getAttribute('dir')).toBe('rtl')
  })
})
