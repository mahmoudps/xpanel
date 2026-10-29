// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACCOUNT_DATABASE_INSIGHTS_CLIENT_BINDING, insightsBytes, readDatabaseInsightsView } from './account-database-insights-client.ts'
import { renderAccountDatabaseInsightsWorkspace } from './board-port/account-database-insights-workspace.ts'

const accountId = '11111111-1111-4111-8111-111111111111'
const table = (name: string, dataBytes: number | null = 16384) => ({ name, engine: 'InnoDB', rows: 3, dataBytes, indexBytes: 0, freeBytes: 0 })
const reply = (over: Record<string, unknown> = {}) => ({ context: { accountId, username: 'alice' }, state: 'read', observedAt: '2026-10-27T03:00:00.000Z', limits: { maxDatabases: 50, maxUsers: 200, tablesPerDatabase: 20 }, omitted: { databases: 0, users: 0 },
  databases: [{ name: 'alice_wp', server: 'present', characterSet: 'utf8mb4', collation: 'utf8mb4_unicode_ci', tables: 2, dataBytes: 1500000, indexBytes: 500000, freeBytes: 0, largestTables: [table('wp_posts'), table('<img src=x>')] },
    { name: 'alice_shop', server: 'present', characterSet: 'utf8mb4', collation: 'utf8mb4_general_ci', tables: 0, dataBytes: 0, indexBytes: 0, freeBytes: 0, largestTables: [] },
    { name: 'alice_gone', server: 'absent', characterSet: null, collation: null, tables: null, dataBytes: null, indexBytes: null, freeBytes: null, largestTables: null }],
  users: [{ name: 'alice_app', server: 'present', hosts: 2 }, { name: 'alice_old', server: 'absent', hosts: null }], ...over })
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
afterEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; document.body.replaceChildren() })
async function bind(html: string, request?: (method: string, path: string) => Promise<unknown>, ar = false) {
  if (request) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request
  document.body.innerHTML = html
  document.documentElement.lang = ar ? 'ar' : 'en'; document.documentElement.dir = ar ? 'rtl' : 'ltr'
  ;(new Function('return ' + ACCOUNT_DATABASE_INSIGHTS_CLIENT_BINDING)() as (confirm: unknown) => void)(undefined)
  await settle(); await settle()
}
const $ = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!
const rows = (key: string): string[][] => [...document.querySelectorAll(`[data-insights-${key}] tr`)].map(row => [...row.querySelectorAll('td')].map(td => td.textContent ?? ''))

describe('account database insights page', () => {
  it('renders bilingual read-only markup with ASCII digits, no form and a link to the manager', () => {
    for (const lang of ['en', 'ar'] as const) {
      const html = renderAccountDatabaseInsightsWorkspace({ lang, accountId, canManage: true })
      expect(html).toContain(`dir="${lang === 'ar' ? 'rtl' : 'ltr'}"`); expect(html).not.toContain('<form'); expect(html).not.toMatch(/[٠-٩۰-۹]/); expect(html).toContain('href="/databases/mariadb"')
    }
    expect(renderAccountDatabaseInsightsWorkspace({ lang: 'ar', accountId, canManage: true })).toContain('أكبر الجداول')
    const readOnly = renderAccountDatabaseInsightsWorkspace({ lang: 'en', accountId: '', canManage: false })
    expect(readOnly).toContain('data-insights-manage="false"'); expect(readOnly).toMatch(/data-insights-read disabled/); expect(readOnly).not.toContain(accountId)
    expect(ACCOUNT_DATABASE_INSIGHTS_CLIENT_BINDING).not.toContain('innerHTML')
  })
  it('stays inert in read-only mode', async () => {
    const request = vi.fn(async () => clone(reply()))
    await bind(renderAccountDatabaseInsightsWorkspace({ lang: 'en', accountId: '', canManage: false }), request)
    expect(request).not.toHaveBeenCalled(); expect($<HTMLButtonElement>('[data-insights-read]').disabled).toBe(true); expect($<HTMLSelectElement>('[data-insights-database]').disabled).toBe(true)
    expect($('[data-insights-status]').getAttribute('data-state')).toBe('unavailable')
  })
  it('parses strictly and formats decimal sizes', () => {
    expect(readDatabaseInsightsView(clone(reply()), accountId).databases).toHaveLength(3)
    for (const bad of [reply({ context: { accountId: '22222222-2222-4222-8222-222222222222', username: 'bob' } }), reply({ state: 'ok' }), reply({ extra: 1 }), reply({ limits: { maxDatabases: 5000, maxUsers: 200, tablesPerDatabase: 20 } }),
      reply({ databases: [{ ...reply().databases[0], name: "alice_wp'" }] }), reply({ databases: [{ ...reply().databases[0], largestTables: Array.from({ length: 21 }, (_, i) => table('t' + i)) }] }),
      reply({ databases: [reply().databases[0], reply().databases[0]] }), reply({ users: [{ name: 'alice_app', server: 'present', hosts: null }] }), reply({ databases: [{ ...reply().databases[0], largestTables: [table('a\u202eb')] }] }),
      reply({ databases: [{ ...reply().databases[0], dataBytes: -1 }] })])
      expect(() => readDatabaseInsightsView(clone(bad), accountId)).toThrow()
    expect([insightsBytes(null), insightsBytes(0), insightsBytes(999), insightsBytes(1500000), insightsBytes(16384)]).toEqual(['-', '0 B', '999 B', '1.50 MB', '16.4 KB'])
  })
  it('reads on open, renders rows as text and switches the largest-tables database', async () => {
    const request = vi.fn(async (method: string, path: string) => { expect([method, path]).toEqual(['GET', '/api/account/database-insights']); return clone(reply()) })
    await bind(renderAccountDatabaseInsightsWorkspace({ lang: 'en', accountId, canManage: true }), request)
    expect(request).toHaveBeenCalledTimes(1)
    expect(rows('databases').map(row => row.slice(0, 3))).toEqual([['alice_wp', 'Present', '2'], ['alice_shop', 'Present', '0'], ['alice_gone', 'Missing', '-']])
    expect(rows('users')).toEqual([['alice_app', 'Present', '2'], ['alice_old', 'Missing', '-']])
    expect(rows('tables').map(row => row[0])).toEqual(['wp_posts', '<img src=x>']); expect(document.querySelector('[data-insights-tables] img')).toBeNull()
    expect($('[data-insights-fact="size"]').textContent).toBe('2.00 MB'); expect($('[data-insights-fact="tables"]').textContent).toBe('2'); expect($('[data-insights-status]').getAttribute('data-state')).toBe('read')
    expect([...$<HTMLSelectElement>('[data-insights-database]').options].map(option => option.value)).toEqual(['alice_wp', 'alice_shop'])
    $<HTMLSelectElement>('[data-insights-database]').value = 'alice_shop'; $('[data-insights-database]').dispatchEvent(new Event('change'))
    expect(rows('tables')).toEqual([['This database has no tables.']])
  })
  it('shows partial and failed reads truthfully', async () => {
    const partial = reply({ state: 'partial', databases: [{ ...reply().databases[0], tables: null, dataBytes: null, indexBytes: null, freeBytes: null, largestTables: null }] })
    await bind(renderAccountDatabaseInsightsWorkspace({ lang: 'ar', accountId, canManage: true }), async () => clone(partial), true)
    expect($('[data-insights-status]').getAttribute('data-state')).toBe('partial'); expect($('[data-insights-fact="size"]').textContent).toBe('لم تُرصد'); expect(rows('tables')).toEqual([['تعذرت قراءة جداول قاعدة البيانات هذه.']])
    document.body.replaceChildren()
    await bind(renderAccountDatabaseInsightsWorkspace({ lang: 'en', accountId, canManage: true }), async () => { throw Object.assign(new Error('nope'), { status: 503 }) })
    expect($('[data-insights-status]').getAttribute('data-state')).toBe('failed'); expect($<HTMLButtonElement>('[data-insights-read]').disabled).toBe(false)
  })
})


describe('database insights human date display preserves raw evidence', () => {
  it.each(['en', 'ar'] as const)('shows exact precise UTC metadata in %s without rewriting raw data or names', async lang => {
    const rawAt = '2026-10-27T03:00:00.123456789Z', value = reply({ observedAt: rawAt }), original = JSON.stringify(value)
    expect(readDatabaseInsightsView(value, accountId).observedAt).toBe(rawAt)
    const request = vi.fn(async (_method: string, _path: string) => value)
    await bind(renderAccountDatabaseInsightsWorkspace({ lang, accountId, canManage: true }), request, lang === 'ar')
    const fact = $('[data-insights-fact="at"]'), note = $('[data-insights-status]')
    expect(fact.textContent).toBe('2026-10-27 03:00 UTC')
    expect(fact.tagName).toBe('BDI'); expect(fact.getAttribute('dir')).toBe('ltr')
    expect(note.querySelector('bdi')?.textContent).toBe('2026-10-27 03:00 UTC')
    expect(note.querySelector('bdi')?.dir).toBe('ltr')
    expect(note.textContent).toContain((lang === 'ar' ? 'قُرئت في ' : 'Read at ') + '2026-10-27 03:00 UTC.')
    expect(note.textContent).toContain(lang === 'ar' ? 'UTC. لم يُعثر على الخادم على 2 من قواعد البيانات أو المستخدمين المحفوظين.' : 'UTC. 2 saved databases or users were not found on the server.')
    expect(note.textContent).not.toContain(rawAt)
    expect([...$<HTMLSelectElement>('[data-insights-database]').options].map(option => option.value)).toEqual(['alice_wp', 'alice_shop'])
    expect(request.mock.calls).toEqual([['GET', '/api/account/database-insights']])
    expect(JSON.stringify(value)).toBe(original)
  })
})
