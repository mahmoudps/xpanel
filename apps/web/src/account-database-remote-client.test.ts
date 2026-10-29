// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACCOUNT_DATABASE_REMOTE_CLIENT_BINDING, readDatabaseRemoteClientView } from './account-database-remote-client.ts'
import { renderAccountDatabaseRemoteWorkspace } from './board-port/account-database-remote-workspace.ts'
const accountId = '11111111-1111-4111-8111-111111111111', username = 'alice', date = '2026-10-27T00:00:00.000Z'
const entry = { host: '192.0.2.0/24', comment: 'Office', createdAt: date, firewall: 'verified', grants: 'verified' }
const view = (entries: unknown[] = [], available = true, applied = false) => ({ context: { accountId, username }, revision: (applied ? 'b' : 'a').repeat(64), entries, limit: 100, users: 2, databases: 1, capability: { canChange: available, reason: available ? 'qualified' : 'native_provider_unavailable' }, application: { status: applied ? 'applied' : 'read', nativeQualified: available } })
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const find = <T extends HTMLElement>(name: string): T => document.querySelector<T>('[data-remote-' + name + ']')!
const set = (name: string, value: string) => { const input = find<HTMLInputElement>(name); input.value = value; input.dispatchEvent(new Event('input')) }
async function bind(send: (...args: unknown[]) => Promise<unknown>, allowed = true, ar = false) { Object.assign(window, { xpanelSessionRequest: send }); document.body.innerHTML = renderAccountDatabaseRemoteWorkspace({ lang: ar ? 'ar' : 'en', accountId, username, canManage: allowed }); document.documentElement.lang = ar ? 'ar' : 'en'; document.documentElement.dir = ar ? 'rtl' : 'ltr'; (new Function('return ' + ACCOUNT_DATABASE_REMOTE_CLIENT_BINDING)() as (ask: unknown) => void)(undefined); await tick() }
afterEach(() => { document.body.replaceChildren(); document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr'; delete (window as unknown as Record<string, unknown>).xpanelSessionRequest })
describe('remote database owner client', () => {
  it('keeps approved table/form/confirmation content in both languages with isolated ASCII technical values', () => {
    for (const lang of ['en', 'ar'] as const) { const html = renderAccountDatabaseRemoteWorkspace({ lang, accountId, username, canManage: true }); expect(html).toContain('data-remote-selected-panel hidden'); expect(html).toContain('data-remote-comment'); expect(html).toContain('data-remote-confirmation'); expect(html).toContain('<bdi dir="ltr"'); expect(html).not.toMatch(/[٠-٩۰-۹]/) }
    expect(ACCOUNT_DATABASE_REMOTE_CLIENT_BINDING).not.toContain('innerHTML')
  })
  it('rejects wrong account, auth leakage, injected hosts and false native proof', () => {
    for (const raw of [{ ...view(), context: { accountId: 'other', username } }, { ...view(), authString: 'hidden' }, view([{ ...entry, host: '<script>' }]), view([{ ...entry, firewall: 'unavailable' }]), view([entry, entry])]) expect(() => readDatabaseRemoteClientView(raw, accountId, username, false)).toThrow()
  })
  it('keeps unqualified saved policy readable and mutations disabled; unavailable page sends no request', async () => {
    const send = vi.fn(async () => view([], false)); await bind(send); expect(send).toHaveBeenCalledOnce(); expect(find<HTMLButtonElement>('save').disabled).toBe(true); expect(find<HTMLButtonElement>('refresh').disabled).toBe(false)
    send.mockClear(); await bind(send, false); expect(send).not.toHaveBeenCalled(); expect(find<HTMLButtonElement>('refresh').disabled).toBe(true)
  })
  it('canonicalizes legacy range before add and requires exact changed-target acknowledgement', async () => {
    const send = vi.fn(async (method: unknown) => method === 'GET' ? view() : view([entry], true, true)); await bind(send)
    set('host', '192.0.2.%'); set('comment', 'Office'); find<HTMLButtonElement>('save').click(); await tick()
    expect(send).toHaveBeenLastCalledWith('POST', '/api/account/database-remote-access', { action: 'add', host: '192.0.2.0/24', comment: 'Office', expectedRevision: 'a'.repeat(64) })
    expect(find('rows').textContent).toContain('192.0.2.0/24'); expect(find('status').dataset.state).toBe('ready')
  })
  it('locks edit and remove until the exact existing host is confirmed and sends captured CAS', async () => {
    const send = vi.fn(async (method: unknown) => method === 'GET' ? view([entry]) : view([], true, true)); await bind(send, true, true)
    document.querySelector<HTMLButtonElement>('[data-remote-rows] button')!.click(); expect(find<HTMLButtonElement>('remove').disabled).toBe(true)
    set('confirmation', '192.0.2.0/24'); find<HTMLButtonElement>('remove').click(); await tick()
    expect(send).toHaveBeenLastCalledWith('POST', '/api/account/database-remote-access', { action: 'remove', host: '192.0.2.0/24', expectedRevision: 'a'.repeat(64) })
  })
  it('locks an uncertain mutation until refresh and never exposes raw transport details', async () => {
    const send = vi.fn(async (method: unknown) => { if (method === 'GET') return view(); throw new Error('PRIVATE_SQL_DETAIL') }); await bind(send)
    set('host', '192.0.2.7'); find<HTMLButtonElement>('save').click(); await tick(); expect(find<HTMLButtonElement>('save').disabled).toBe(true); expect(document.body.textContent).not.toContain('PRIVATE_SQL_DETAIL')
    find<HTMLButtonElement>('refresh').click(); await tick(); expect(find<HTMLButtonElement>('save').disabled).toBe(false)
  })
})

describe('readable date closure remote database', () => {
  for (const ar of [false, true]) it('formats creation while preserving native holds, host and revision in ' + (ar ? 'ar' : 'en'), async () => {
    const source = view([{ ...entry, createdAt: '2026-10-27T09:01:02.123Z', firewall: 'unavailable', grants: 'unavailable' }], false), before = JSON.stringify(source), send = vi.fn(async () => source)
    await bind(send, true, ar)
    const stamp = document.querySelector('[data-remote-rows] tr td:nth-child(3) bdi')!
    expect(stamp.textContent).toBe('2026-10-27 09:01 UTC'); expect(stamp.getAttribute('dir')).toBe('ltr')
    expect(find<HTMLButtonElement>('save').disabled).toBe(true); expect(find('rows').textContent).toContain('192.0.2.0/24')
    expect(find('scope').textContent).toBe(ar ? 'مستخدمو قواعد البيانات: 2 · قواعد البيانات النشطة: 1' : '2 database users · 1 active databases')
    expect(JSON.stringify(source)).toBe(before); expect(readDatabaseRemoteClientView(source, accountId, username, false).entries[0]!.createdAt).toBe('2026-10-27T09:01:02.123Z')
    expect(readDatabaseRemoteClientView(source, accountId, username, false).revision).toBe('a'.repeat(64))
    expect(send.mock.calls).toEqual([['GET', '/api/account/database-remote-access', undefined]]); expect(document.body.textContent).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
  })
})