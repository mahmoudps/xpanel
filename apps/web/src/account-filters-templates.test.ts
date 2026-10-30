// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { builtinEnvironments, type EnvironmentReturn } from 'vitest/runtime'
import { translator } from './i18n.ts'
import { ACCOUNT_FILTERS_CLIENT_BINDING, type FilterRecord, type FilterSelection } from './account-filters-client.ts'
import { renderFilterWorkspace } from './board-port/extensions/account-filters.ts'
import { renderV2PanelEmailFilters } from './themes/v2/pages/xpanel/email-tools/filters.ts'
import { renderMailFiltersPage } from './themes/v2/pages/xmail/workspaces/settings.ts'

let testDom: EnvironmentReturn | undefined
beforeEach(async () => {
  testDom = await builtinEnvironments.jsdom.setup(globalThis, { jsdom: { url: 'https://panel.example.test/email-filters', runScripts: 'outside-only' } })
})

const account = { id: 'account-a', username: 'alice', uid: 20014, gid: 20014, home: '/home/alice', primaryDomain: 'alice.example.test', planId: 'p1', ownerId: null, status: 'active' as const, suspendReason: null, contactEmail: '', ipv4: '192.0.2.1', ipv6: null, extraIps: [], shell: 'jailed' as const, createdAt: '2026-10-29T00:00:00Z' }
const record = (): FilterRecord => ({ id: 'r1', accountId: account.id, scope: 'global', mailbox: null, name: 'Invoices <img src=x>', priority: 1, enabled: true, matchAll: true, conditions: [{ field: 'subject', comparator: 'contains', value: 'invoice <script>text</script>' }], actions: [{ type: 'fileinto', target: 'Invoices' }, { type: 'stop' }], createdAt: '2026-10-25T00:00:00Z', application: { state: 'pending', reason: null } })
const scope: FilterSelection = { scope: 'global', mailbox: null }
const page = (theme: 'classic' | 'v2' | 'v2-mail') => theme === 'classic' ? renderFilterWorkspace({ lang: 'en', canManage: true, expectedAccountId: account.id, mailboxes: [{ login: 'info@alice.example.test' }] }) : theme === 'v2' ? renderV2PanelEmailFilters({ locale: 'en', account, serviceUsers: [] }, { canRead: true, canManage: true }) : renderMailFiltersPage({ locale: 'en', route: '/mail/filters', mailbox: 'info@alice.example.test', canRead: true, canManage: true })
const q = <T extends Element = HTMLElement>(selector: string): T => document.querySelector<T>(selector)!
const idle = async () => vi.waitFor(() => expect(q('[data-filter-workspace]').getAttribute('aria-busy')).toBe('false'))
function mount(theme: 'classic' | 'v2' | 'v2-mail', options: { rows?: FilterRecord[]; blocked?: boolean; failWrite?: boolean; tamper?: (root: HTMLElement) => void } = {}) {
  const selected: FilterSelection = theme === 'v2-mail' ? { scope: 'mailbox', mailbox: 'info@alice.example.test' } : scope
  let rows: FilterRecord[] = (options.rows ?? [record()]).map(row => ({ ...row, ...selected })), revision = 'a'.repeat(64)
  const envelope = () => ({ context: { ...selected, accountId: account.id }, filters: rows, revision, application: { generationId: null }, compilation: { status: options.blocked ? 'blocked' : 'ready', ...(options.blocked ? { reason: 'legacy_invalid' } : {}) }, compiledSieve: options.blocked ? null : 'keep;\n' })
  const request = vi.fn(async (method: string, path: string, body?: unknown): Promise<unknown> => {
    if (path === '/api/mail/filters/test') return { context: scope, notRun: 1, rules: [{ hidden: true, name: null, matched: true, stopped: false, tests: [], actions: [{ type: 'redirect' }] }, { hidden: false, name: 'Own rule', matched: true, stopped: true, tests: [{ field: 'subject', comparator: 'contains', value: '<img src=x>', actual: ['<b>invoice</b>'], matched: true }], actions: [{ type: 'fileinto', target: '<img src=x>' }] }], outcome: { folders: ['Invoices'], redirects: [null], discarded: false, rejected: null, markedRead: false, stopped: true } }
    if (method === 'GET') return envelope()
    if (options.failWrite) throw new Error('response_lost')
    const payload = body as Record<string, unknown>
    expect(payload.expectedRevision).toBe(revision)
    revision = 'b'.repeat(64)
    if (method === 'DELETE') { rows = []; return { ...envelope(), ok: true } }
    const next = { ...rows[0]!, ...payload, id: 'r1', application: { state: 'pending' as const, reason: null } } as FilterRecord
    rows = [next]; return { ...envelope(), filter: next }
  })
  document.documentElement.lang = 'en'; document.body.innerHTML = page(theme)
  options.tamper?.(q('[data-filter-workspace]'))
  Object.assign(window, { xpT: translator('en'), xpanelSessionRequest: request })
  const ask = vi.fn(async () => true)
  window.eval(ACCOUNT_FILTERS_CLIENT_BINDING)(ask)
  return { request, ask }
}
afterEach(async () => {
  try {
    document.body.replaceChildren()
    delete (window as Window & { xpT?: unknown }).xpT
    delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
    vi.restoreAllMocks()
  } finally { await testDom?.teardown(globalThis); testDom = undefined }
})

it('binds the actual V2 sealed-mailbox workspace without an account-wide scope selector', async () => {
  const { request } = mount('v2-mail'); await idle()
  expect(request.mock.calls[0]).toEqual(['GET', '/api/mail/filters?scope=mailbox&mailbox=info%40alice.example.test'])
  expect(document.querySelector('[data-filter-scope]')).toBeNull()
  q<HTMLButtonElement>('[data-filter-action="edit"]').click()
  expect(q<HTMLSelectElement>('[data-condition-field="field"]').value).toBe('subject')
  expect(q('[data-filter-workspace]').querySelector('[class^="xp-"]')).toBeNull()
})

describe.each(['classic', 'v2'] as const)('%s selected filter templates', theme => {
  it('paints the selected rule markup and safe text with truthful application state', async () => {
    mount(theme); await idle()
    expect(q('[data-filter-list]').textContent).toContain('Invoices <img src=x>')
    expect(q('[data-filter-list]').textContent).toContain('Mail server: saved, not applied yet')
    expect(q('[data-filter-list]').querySelector('img,script')).toBeNull()
    if (theme === 'v2') expect(q('[data-filter-list]').querySelector('[class^="xp-"]')).toBeNull()
    expect(q('[data-filter-preview]').textContent).toBe('keep;\n')
  })
  it('builds named controls and saves size/redirect semantics through revision-bound readback', async () => {
    const { request } = mount(theme); await idle()
    q<HTMLButtonElement>('[data-filter-action="edit"]').click()
    const field = q<HTMLSelectElement>('[data-condition-field="field"]'); field.value = 'size'; field.dispatchEvent(new Event('change', { bubbles: true }))
    expect([...q<HTMLSelectElement>('[data-condition-field="comparator"]').options].map(item => item.value)).toEqual(['over', 'under'])
    q<HTMLInputElement>('[data-condition-field="value"]').value = '1K'
    const type = q<HTMLSelectElement>('[data-action-field="type"]'); type.value = 'redirect'; type.dispatchEvent(new Event('change', { bubbles: true }))
    const target = q<HTMLInputElement>('[data-action-field="target"]'); target.value = '  SALES@EXAMPLE.TEST '; target.setCustomValidity('')
    q<HTMLFormElement>('[data-filter-editor]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(q('[data-filter-status]').getAttribute('data-state')).toBe('saved'))
    const call = request.mock.calls.find(call => call[0] === 'PATCH')!
    expect(call[2]).toMatchObject({ conditions: [{ field: 'size', comparator: 'over', value: '1024' }], actions: [{ type: 'redirect', target: 'sales@example.test' }, { type: 'stop' }], expectedRevision: 'a'.repeat(64) })
    expect(request.mock.calls.filter(call => call[0] === 'GET')).toHaveLength(3)
    const label = q<HTMLLabelElement>('label[for="' + field.id + '"]'); expect(label.textContent).toBe('Field')
  })
  it('preserves an interior stop action and later actions when reopening and saving', async () => {
    const original = { ...record(), actions: [{ type: 'keep' }, { type: 'stop' }, { type: 'mark-read' }] }
    const { request } = mount(theme, { rows: [original] }); await idle(); q<HTMLButtonElement>('[data-filter-action="edit"]').click()
    expect([...document.querySelectorAll<HTMLSelectElement>('[data-action-field="type"]')].map(select => select.value)).toEqual(['keep', 'stop', 'mark-read'])
    expect(q<HTMLInputElement>('input[name="stop"]').checked).toBe(false)
    q<HTMLFormElement>('[data-filter-editor]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(q('[data-filter-status]').getAttribute('data-state')).toBe('saved'))
    expect(request.mock.calls.find(call => call[0] === 'PATCH')?.[2]).toMatchObject({ actions: original.actions })
  })
  it('keeps the actual 50-condition and 10-action budgets without truncating saved rows', async () => {
    const original = { ...record(), conditions: Array.from({ length: 50 }, () => ({ field: 'subject', comparator: 'contains', value: 'x' })), actions: Array.from({ length: 10 }, () => ({ type: 'keep' })) }
    mount(theme, { rows: [original] }); await idle(); q<HTMLButtonElement>('[data-filter-action="edit"]').click()
    expect(document.querySelectorAll('[data-filter-condition]')).toHaveLength(50)
    expect(document.querySelectorAll('[data-filter-action-row]')).toHaveLength(10)
    expect(q<HTMLButtonElement>('[data-filter-add-condition]').disabled).toBe(true)
    expect(q<HTMLButtonElement>('[data-filter-add-action]').disabled).toBe(true)
    expect(q<HTMLInputElement>('input[name="stop"]').disabled).toBe(true)
  })
  it('retains a draft and locks further writes after an uncertain response', async () => {
    const { request } = mount(theme, { failWrite: true }); await idle(); q<HTMLButtonElement>('[data-filter-action="edit"]').click()
    q<HTMLFormElement>('[data-filter-editor]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(q('[data-filter-status]').getAttribute('data-state')).toBe('uncertain'))
    expect(q<HTMLFormElement>('[data-filter-editor]').hidden).toBe(false)
    expect(q<HTMLButtonElement>('[data-filter-editor] [data-filter-write]').disabled).toBe(true)
    expect(request.mock.calls.filter(call => call[0] === 'PATCH')).toHaveLength(1)
  })
  it('keeps blocked legacy metadata visible and permits only its explicit deletion', async () => {
    const { request } = mount(theme, { blocked: true, rows: [{ ...record(), name: null, conditions: null, actions: null } as unknown as FilterRecord] }); await idle()
    expect(q('[data-filter-list]').textContent).toContain('Saved metadata is blocked and has not been rewritten.')
    expect(q('[data-filter-list]').querySelector('[data-filter-action="edit"]')).toBeNull()
    q<HTMLButtonElement>('[data-filter-action="delete"]').click()
    await vi.waitFor(() => expect(request.mock.calls.some(call => call[0] === 'DELETE')).toBe(true))
    await idle()
    expect(request.mock.calls.some(call => call[0] === 'PATCH')).toBe(false)
  })
  it('renders the dry-run trace through theme slots without leaking hidden rule details or HTML', async () => {
    mount(theme); await idle(); q<HTMLButtonElement>('[data-filter-test-run]').click()
    await vi.waitFor(() => expect(q('[data-filter-test-status]').textContent).toContain('Test finished.'))
    expect(q('[data-filter-trace]').textContent).toContain('Account-wide rule (details not shown)')
    expect(q('[data-filter-trace]').textContent).toContain('<b>invoice</b>')
    expect(q('[data-filter-trace]').querySelector('img,b')).toBeNull()
    expect(q('[data-filter-outcome]').textContent).toContain('an address of an account-wide rule')
  })
  it('fails closed before an authenticated read when a required theme slot is missing', async () => {
    const { request } = mount(theme, { tamper: root => root.querySelector<HTMLTemplateElement>('template[data-xp-template="filter-condition-builder"]')!.content.querySelector('[data-xp-slot="field"]')!.remove() })
    expect(request).not.toHaveBeenCalled()
    expect(q('[data-filter-status]').getAttribute('data-state')).toBe('failed')
  })
})
