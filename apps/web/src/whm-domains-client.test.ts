// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWhmDomainWorkspace, WHM_DOMAINS_CLIENT_BINDING } from './whm-domains-client.ts'
import { renderWhmDomainsWorkspace } from './board-port/whm-domains-workspace.ts'
import type { DomainWorkspaceRow, DomainWorkspaceView } from './domain-workspace-client.ts'

const account = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', username: 'account-one', home: '/home/accountone', status: 'active' as const }
const other = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', username: 'account-two', home: '/home/accounttwo', status: 'active' as const }
const id = (suffix: number) => 'cccccccc-cccc-4ccc-8ccc-' + String(suffix).padStart(12, '0')
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const row = (patch: Partial<DomainWorkspaceRow> = {}): DomainWorkspaceRow => ({
  id: id(1), accountId: account.id, name: 'account-one.example.test', kind: 'primary', parentId: null,
  docRoot: account.home + '/public_html', siteType: 'php', upstream: null, redirect: null,
  php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} },
  wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited', ipv4: '192.0.2.1', ipv6: null, ...patch,
})
const view = (revision = '1', domains = [row()]): DomainWorkspaceView => ({ context: { accountId: account.id, home: account.home }, revision: revision.repeat(64), domains,
  limits: { addonDomains: 5, aliasDomains: 5, subdomains: 5 }, removals: domains.map(domain => ({ domainId: domain.id, canRemove: domain.kind !== 'primary' && !domains.some(child => child.parentId === domain.id), childCount: domains.filter(child => child.parentId === domain.id).length, serviceUserCount: 0 })), application: { status: 'not_requested', targetVerified: false } })
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const status = () => document.querySelector<HTMLElement>('[data-whm-domain-status]')!
const button = (name: string) => document.querySelector<HTMLButtonElement>('[data-whm-domain-' + name + ']')!
const createInput = (name: string) => document.querySelector<HTMLInputElement | HTMLSelectElement>('[data-whm-domain-create] [name="' + name + '"]')!
const enter = (name: string, value: string) => { const control = createInput(name); control.value = value; control.dispatchEvent(new Event(control instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })) }
let listeners: EventListener[]

beforeEach(() => {
  listeners = []
  const add = window.addEventListener.bind(window)
  vi.spyOn(window, 'addEventListener').mockImplementation((name, callback, options) => { if (name === 'beforeunload') listeners.push(callback as EventListener); add(name, callback, options) })
  document.body.innerHTML = '<section data-whm-detail-route="/whm/domains"><table data-whm-filter-table><tbody><tr><td><span data-whm-filter-row data-account="account-two">Preserved other account</span></td></tr></tbody></table>' + renderWhmDomainsWorkspace({ locale: 'en', accounts: [account, other], canManage: true }) + '</section>'
  delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest
})
afterEach(() => { for (const listener of listeners) window.removeEventListener('beforeunload', listener); vi.restoreAllMocks(); document.body.replaceChildren(); delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

const model = () => {
  let current = view(), mode = 'normal'
  const calls: { method: string; path: string; body?: unknown }[] = []
  const transport = vi.fn(async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, ...(body === undefined ? {} : { body }) })
    if (method === 'GET') {
      if (mode === 'read-error') throw new Error('unread')
      return clone(current)
    }
    if (mode === 'denied') throw { status: 422, details: { stateChanged: false } }
    if (mode === 'unknown') throw { status: 503, details: { stateChanged: true, unknownOutcome: true } }
    const input = body as Record<string, unknown>
    if (input.expectedRevision !== current.revision) throw { status: 409, details: { stateChanged: false } }
    if (method === 'POST') {
      const parent = current.domains.find(domain => domain.id === input.parentId)
      const domain = row({ id: id(2), name: String(input.name).toLowerCase(), kind: input.kind as 'addon' | 'alias' | 'subdomain', parentId: input.parentId as string ?? null,
        docRoot: input.kind === 'alias' ? parent!.docRoot : input.docRoot ? account.home + '/' + input.docRoot : account.home + '/domains/' + String(input.name).toLowerCase() + '/public_html', siteType: input.kind === 'alias' ? parent!.siteType : input.siteType as 'php' | 'static', php: parent?.php ?? row().php,
        upstream: input.kind === 'alias' ? parent!.upstream : null, redirect: input.kind === 'alias' ? parent!.redirect : null })
      current = view('2', [...current.domains, domain])
      return { ...clone(current), domain: clone(domain), stateChanged: true }
    }
    const target = path.split('/').at(-1)
    if (method === 'PATCH') {
      const previous = current.domains.find(domain => domain.id === target)!
      const docRoot = String(input.docRoot).startsWith('/') ? String(input.docRoot) : account.home + '/' + input.docRoot
      const domains = current.domains.map(domain => domain.id === target || domain.kind === 'alias' && domain.parentId === target ? { ...domain, docRoot } : domain)
      current = view('3', domains)
      return { ...clone(current), domain: clone({ ...previous, docRoot }), stateChanged: true }
    }
    const removed = current.domains.find(domain => domain.id === target)!
    current = view('4', current.domains.filter(domain => domain.id !== target))
    return { ...clone(current), ok: true, removed: { id: removed.id, name: removed.name }, stateChanged: true }
  })
  const ask = vi.fn(async (options: Record<string, unknown>): Promise<unknown> => options.input === true ? options.body : true)
  const boot = () => { (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = transport; new Function('return ' + WHM_DOMAINS_CLIENT_BINDING)()(ask) }
  return { transport, calls, ask, boot, setMode: (value: string) => { mode = value }, setView: (value: DomainWorkspaceView) => { current = value }, writes: () => calls.filter(call => call.method !== 'GET') }
}

describe('pinned WHM domain workspace adapter', () => {
  it('pins all reads and creates to the captured administrative account', async () => {
    const f = model(), workspace = createWhmDomainWorkspace({ account, request: f.transport, admitted: () => true })
    await workspace.refresh(); workspace.editCreate({ name: 'addon.example.test' }); await workspace.create()
    expect(f.calls.filter(call => call.method === 'GET').every(call => call.path === '/api/domains?accountId=' + account.id + '&workspace=1')).toBe(true)
    expect(f.writes()[0]).toMatchObject({ method: 'POST', path: '/api/domains', body: { accountId: account.id, expectedRevision: '1'.repeat(64), name: 'addon.example.test' } })
    expect(workspace.state.status).toBe('saved')
  })
  it('rejects foreign account DTOs and absent admission before transport', async () => {
    const f = model(); f.setView({ ...view(), context: { accountId: other.id, home: other.home } })
    const workspace = createWhmDomainWorkspace({ account, request: f.transport, admitted: () => true })
    await workspace.refresh(); expect(workspace.state.status).toBe('failed')
    const denied = createWhmDomainWorkspace({ account, request: f.transport, admitted: () => false })
    const count = f.calls.length; await denied.refresh(); expect(f.calls).toHaveLength(count)
  })
  it('captures account identity rather than retaining a mutable caller selection object', async () => {
    const f = model(), selection = { ...account }
    const workspace = createWhmDomainWorkspace({ account: selection, request: f.transport, admitted: () => true })
    selection.id = other.id; selection.home = other.home
    await workspace.refresh()
    expect(f.calls[0]!.path).toBe('/api/domains?accountId=' + account.id + '&workspace=1')
    expect(workspace.state.status).toBe('read')
  })
})

describe('WHM domain browser binding', () => {
  it('constructs a self-contained binding without a new transport or innerHTML', () => {
    expect(() => new Function('return ' + WHM_DOMAINS_CLIENT_BINDING)()).not.toThrow()
    expect(WHM_DOMAINS_CLIENT_BINDING).not.toContain('fetch(')
    expect(WHM_DOMAINS_CLIENT_BINDING).not.toContain('innerHTML')
  })
  it('shows an explicit unavailable state and sends nothing without session transport', () => {
    new Function('return ' + WHM_DOMAINS_CLIENT_BINDING)()(undefined)
    expect(status().dataset.state).toBe('unavailable'); expect(button('create-submit').disabled).toBe(true)
  })
  it('refuses inherited unavailable admission with neutral containers and sends no read or write', async () => {
    document.body.innerHTML = '<section data-whm-detail-route="/whm/domains" data-capability-state="unavailable">' + renderWhmDomainsWorkspace({ locale: 'en', accounts: [account], canManage: false }) + '</section>'
    const f = model(); f.boot(); await tick()
    expect(document.querySelector('form')).toBeNull()
    document.querySelector('[data-whm-domain-create]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    document.querySelector('[data-whm-domain-settings]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    button('refresh').click(); await tick()
    expect(f.calls).toEqual([])
    expect(document.querySelector<HTMLSelectElement>('[data-whm-domain-account]')!.disabled).toBe(true)
  })
  it('reads actual account limits and preserves the other account overview rows', async () => {
    const f = model(); f.boot(); await tick()
    expect(status().dataset.state).toBe('read')
    expect(document.querySelector('[data-whm-domain-limits]')!.textContent).toContain('0 / 5')
    expect(document.querySelector('[data-whm-filter-table]')!.textContent).toContain('Preserved other account')
    expect(document.querySelector('[data-whm-filter-table]')!.textContent).toContain(row().name)
    expect(document.querySelector('[data-whm-filter-table]')!.textContent).not.toContain(account.id)
  })
  it('explains read-only access while allowing an authorized read without mutation controls', async () => {
    document.querySelector<HTMLElement>('[data-whm-domains-workspace]')!.dataset.whmDomainsManage = 'false'
    const f = model(); f.boot(); await tick()
    expect(status().dataset.state).toBe('read')
    expect(document.querySelector<HTMLElement>('[data-whm-domain-permission]')!.hidden).toBe(false)
    expect(document.querySelector('[data-whm-domain-permission]')!.textContent).toContain('Read-only')
    expect(createInput('name').disabled).toBe(true)
    expect(button('create-submit').disabled).toBe(true)
    expect(f.writes()).toHaveLength(0)
  })
  it('replaces an unread overview placeholder when an actual account read returns records', async () => {
    document.querySelector('[data-whm-filter-table] tbody')!.innerHTML = '<tr><td colspan="9">Records have not been read.</td></tr>'
    const f = model(); f.boot(); await tick()
    const table = document.querySelector('[data-whm-filter-table]')!
    expect(table.textContent).not.toContain('Records have not been read.')
    expect(table.textContent).toContain(row().name)
  })
  it('clears the previous account facts while a newly selected account read fails', async () => {
    const f = model(); f.boot(); await tick()
    expect(document.querySelector('[data-whm-domain-limits]')!.textContent).toContain('0 / 5')
    f.setMode('read-error')
    const select = document.querySelector<HTMLSelectElement>('[data-whm-domain-account]')!; select.value = other.id; select.dispatchEvent(new Event('change')); await tick()
    expect(status().dataset.state).toBe('failed')
    expect(document.querySelector('[data-whm-domain-limits]')!.textContent).toBe('')
    expect(document.querySelector<HTMLSelectElement>('[data-whm-domain-selected]')!.options).toHaveLength(0)
    expect(document.querySelector('[data-whm-domain-facts]')!.textContent).toBe('')
  })
  it('creates only after confirmation and verifies the exact saved readback', async () => {
    const f = model(); f.boot(); await tick(); enter('name', 'addon.example.test'); enter('siteType', 'static')
    document.querySelector<HTMLFormElement>('[data-whm-domain-create]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await tick(); await tick()
    expect(f.ask).toHaveBeenCalledTimes(1)
    expect(f.writes()[0]!.body).toMatchObject({ name: 'addon.example.test', siteType: 'static', accountId: account.id, expectedRevision: '1'.repeat(64) })
    expect(status().dataset.state).toBe('saved')
    expect(document.querySelector('[data-whm-filter-table]')!.textContent).toContain('addon.example.test')
  })
  it('cancels creation without sending and retains the typed draft', async () => {
    const f = model(); f.ask.mockResolvedValue(false); f.boot(); await tick(); enter('name', 'kept.example.test')
    document.querySelector<HTMLFormElement>('[data-whm-domain-create]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await tick()
    expect(f.writes()).toHaveLength(0); expect(createInput('name').value).toBe('kept.example.test')
  })
  it('shows an inherited proxy runtime truthfully and omits independent alias settings', async () => {
    const parent = row({ siteType: 'proxy', upstream: 'http://127.0.0.1:3000' })
    const f = model(); f.setView(view('1', [parent])); f.boot(); await tick()
    enter('kind', 'alias'); enter('parentId', parent.id); enter('name', 'alias.example.test')
    expect(createInput('siteType').value).toBe('proxy'); expect(createInput('siteType').disabled).toBe(true)
    expect(createInput('docRoot').value).toBe(parent.docRoot); expect(createInput('docRoot').disabled).toBe(true)
    document.querySelector<HTMLFormElement>('[data-whm-domain-create]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await tick(); await tick()
    const body = f.writes()[0]!.body as Record<string, unknown>
    expect(body).toMatchObject({ name: 'alias.example.test', kind: 'alias', parentId: parent.id, accountId: account.id })
    expect(body).not.toHaveProperty('siteType'); expect(body).not.toHaveProperty('docRoot')
    expect(status().dataset.state).toBe('saved')
  })
  it('selects a domain, guards primary removal, and saves a relative document root', async () => {
    const f = model(); f.boot(); await tick()
    const select = document.querySelector<HTMLSelectElement>('[data-whm-domain-selected]')!; select.value = id(1); select.dispatchEvent(new Event('change')); await tick()
    expect(button('remove').disabled).toBe(true)
    const control = document.querySelector<HTMLInputElement>('[data-whm-domain-settings] [name="docRoot"]')!; control.value = 'new-site'; control.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector<HTMLFormElement>('[data-whm-domain-settings]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await tick(); await tick()
    expect(f.writes()[0]).toMatchObject({ method: 'PATCH', body: { docRoot: 'new-site', expectedRevision: '1'.repeat(64) } })
    expect(status().dataset.state).toBe('saved')
  })
  it('deletes an eligible domain only after an exact-name confirmation', async () => {
    const addon = row({ id: id(2), kind: 'addon', name: 'remove.example.test', docRoot: account.home + '/remove' })
    const f = model(); f.setView(view('1', [row(), addon])); f.boot(); await tick()
    const select = document.querySelector<HTMLSelectElement>('[data-whm-domain-selected]')!; select.value = addon.id; select.dispatchEvent(new Event('change')); await tick()
    button('remove').click(); await tick(); await tick()
    expect(f.ask.mock.calls[0]![0]).toMatchObject({ input: true, preserveWhitespace: true, body: addon.name })
    expect(f.writes()[0]).toMatchObject({ method: 'DELETE', body: { confirmName: addon.name, expectedRevision: '1'.repeat(64) } })
    expect(status().dataset.state).toBe('saved')
    expect(document.querySelector('[data-whm-filter-table]')!.textContent).not.toContain(addon.name)
  })
  it('preserves an unknown draft and locks subsequent writes until explicit reload', async () => {
    const f = model(); f.boot(); await tick(); enter('name', 'unknown.example.test'); f.setMode('unknown')
    document.querySelector<HTMLFormElement>('[data-whm-domain-create]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await tick(); await tick()
    expect(status().dataset.state).toBe('uncertain'); expect(createInput('name').value).toBe('unknown.example.test'); expect(button('create-submit').disabled).toBe(true)
    const count = f.writes().length; button('refresh').click(); await tick(); expect(f.writes()).toHaveLength(count)
    expect(status().dataset.state).toBe('uncertain')
  })
  it('keeps stale drafts and definitely refused drafts without false success', async () => {
    const f = model(); f.boot(); await tick(); enter('name', 'stale.example.test'); f.setView(view('2'))
    document.querySelector<HTMLFormElement>('[data-whm-domain-create]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await tick(); await tick()
    expect(status().dataset.state).toBe('stale'); expect(f.writes()).toHaveLength(0); expect(createInput('name').value).toBe('stale.example.test')
  })
})
