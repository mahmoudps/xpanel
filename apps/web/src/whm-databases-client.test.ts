// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWhmDatabasesWorkspace } from './board-port/whm-databases-workspace.ts'
import type { WhmDatabasesKind } from './board-port/whm-databases-workspace.ts'
import { readWhmDatabaseKillOutcome, readWhmDatabasesView, WHM_DATABASES_CLIENT_BINDING } from './whm-databases-client.ts'

const at = '2026-10-27T10:00:00.000Z'
const status = { Uptime: 3600, Threads_connected: 3, Threads_running: 1, Connections: 120, Max_used_connections: 9, Aborted_connects: 0, Questions: 5000, Slow_queries: 2 }
const overview = () => ({
  scope: { saved: 'saved-configuration', observed: 'host-observation' },
  saved: { accounts: [{ account: 'alpha', owner: 'agency', status: 'active', databases: 1, trashedDatabases: 0, users: 1, grants: 1, observedSizeBytes: 4096 }], totals: { accounts: 1, databases: 1, trashedDatabases: 0, users: 1, grants: 1 } },
  observed: { state: 'read', observedAt: at, version: '10.11.6-MariaDB', status, schemaCount: 3, totalSizeBytes: 4103 },
  databases: [{ name: 'alpha_wp', account: 'alpha', trashed: false, sizeBytes: 4096, tables: 3, drift: 'in-sync' }, { name: 'information_schema', account: null, trashed: null, sizeBytes: 0, tables: 80, drift: 'system' }, { name: 'stray_db', account: null, trashed: null, sizeBytes: 7, tables: 0, drift: 'server-only' }],
  drift: { savedOnly: 0, serverOnly: 1 },
})
const users = () => ({ scope: { saved: 'saved-configuration', observed: 'host-observation' }, ownerPage: '/databases/mariadb', observed: { state: 'read', observedAt: at }, users: [{ user: 'alpha_app', host: 'localhost', account: 'alpha', role: false, grants: [{ database: 'alpha_wp', privileges: ['SELECT'] }], drift: 'in-sync' }, { user: 'alpha_app', host: '%', account: null, role: false, grants: null, drift: 'server-only' }], drift: { savedOnly: 0, serverOnly: 1 } })
const processRow = (id: number, user: string, db: string | null, extra: Record<string, unknown> = {}) => ({ id, user, host: 'localhost', db, command: 'Query', timeSeconds: 12, threadState: 'Sending data', protected: false, protectedReason: null, account: user === 'alpha_app' ? 'alpha' : null, ...extra })
const processes = (rows = [processRow(5, 'alpha_app', 'alpha_wp'), processRow(7, 'root', null, { protected: true, protectedReason: 'system-account' })]) => ({ scope: { observed: 'host-observation' }, observed: { state: 'read', observedAt: at }, queryText: 'not-read', processes: rows })
const servers = () => ({ engines: [{ engine: 'mariadb', label: 'MariaDB', savedDatabases: 3, service: { state: 'active', unit: 'mariadb.service' }, configuration: { source: 'agent-client-configuration', protocol: 'socket', socket: '/run/mysqld/mysqld.sock' }, observed: { state: 'read', observedAt: at, version: '10.11.6-MariaDB', variables: { port: 3306, socket: '/run/mysqld/mysqld.sock', bind_address: '127.0.0.1', skip_networking: 'OFF', max_connections: 151 } } }] })
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const mount = (kind: WhmDatabasesKind, options: { canRead?: boolean; canKill?: boolean } = {}) => { document.body.innerHTML = `<section data-whm-detail-route="/whm/databases" data-capability-state="authorized">${renderWhmDatabasesWorkspace({ kind, locale: 'en', canRead: options.canRead ?? true, canKill: options.canKill ?? true })}</section>` }
const boot = (request?: (method: string, path: string, body?: unknown) => Promise<unknown>, ask?: (options: Record<string, unknown>) => Promise<unknown>) => { if (request) (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request; new Function('return ' + WHM_DATABASES_CLIENT_BINDING)()(ask) }
const statusOf = () => document.querySelector<HTMLElement>('[data-whm-db-status]')!
beforeEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest })

describe('WHM database renderers', () => {
  it.each(['overview', 'users', 'processes', 'servers'] as const)('renders %s in English and Arabic with ASCII digits and RTL direction', kind => {
    const en = renderWhmDatabasesWorkspace({ kind, locale: 'en', canRead: true, canKill: true }), arabic = renderWhmDatabasesWorkspace({ kind, locale: 'ar', canRead: true, canKill: true })
    expect(en).toContain('dir="ltr"'); expect(arabic).toContain('lang="ar" dir="rtl"')
    expect(arabic).toMatch(/[\u0600-\u06ff]/); expect(en).not.toMatch(/[\u0600-\u06ff]/)
    for (const html of [en, arabic]) { expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/); expect(html).toContain(`data-db-kind="${kind}"`); expect(html).toContain(`data-db-can-kill="${kind === 'processes'}"`) }
  })
  it('marks saved and observed sources, the owner page and the unread state', () => {
    expect(renderWhmDatabasesWorkspace({ kind: 'overview', locale: 'en', canRead: true, canKill: false })).toMatch(/Saved configuration[\s\S]*Observed on the server|Observed on the server[\s\S]*Saved configuration/)
    expect(renderWhmDatabasesWorkspace({ kind: 'users', locale: 'ar', canRead: true, canKill: false })).toContain('<bdi dir="ltr">/databases/mariadb</bdi>')
    expect(renderWhmDatabasesWorkspace({ kind: 'processes', locale: 'en', canRead: true, canKill: true })).toContain('Query text is not read')
    const denied = renderWhmDatabasesWorkspace({ kind: 'processes', locale: 'en', canRead: false, canKill: true })
    expect(denied).toContain('data-whm-db-refresh disabled'); expect(denied).toContain('data-db-can-kill="false"')
  })
})

describe('WHM database client parsers', () => {
  it('accepts each documented reply shape', () => {
    expect(readWhmDatabasesView('overview', overview())).toMatchObject({ kind: 'overview', drift: { serverOnly: 1 } })
    expect(readWhmDatabasesView('users', users())).toMatchObject({ kind: 'users' })
    expect(readWhmDatabasesView('processes', processes())).toMatchObject({ kind: 'processes', processes: [{ id: 5 }, { id: 7, protectedReason: 'system-account' }] })
    expect(readWhmDatabasesView('servers', servers())).toMatchObject({ kind: 'servers', engine: { savedDatabases: 3 } })
    expect(readWhmDatabasesView('processes', { ...processes(), observed: { state: 'unavailable', observedAt: null }, processes: null })).toMatchObject({ processes: null })
  })
  it('refuses malformed, inconsistent or unsafe replies', () => {
    const cases: [string, unknown][] = [
      ['overview', { ...overview(), drift: null }], ['overview', { ...overview(), scope: { saved: 'host-observation', observed: 'host-observation' } }], ['overview', { ...overview(), observed: { ...overview().observed, status: { Uptime: 1 } } }],
      ['overview', { ...overview(), databases: [{ name: 'a\u202eb', account: null, trashed: null, sizeBytes: 0, tables: 0, drift: 'server-only' }] }], ['overview', { ...overview(), observed: { ...overview().observed, observedAt: null } }],
      ['users', { ...users(), ownerPage: '/whm' }], ['users', { ...users(), users: [{ ...users().users[0], account: 'acc-uuid-1' }] }], ['users', { ...users(), drift: null }],
      ['processes', { ...processes(), queryText: 'SELECT secret' }], ['processes', processes([processRow(5, 'a', null), processRow(5, 'b', null)])], ['processes', processes([processRow(0, 'a', null)])], ['processes', processes([processRow(5, 'a', null, { protected: true, protectedReason: null })])],
      ['servers', { engines: [...servers().engines, ...servers().engines] }], ['servers', { engines: [{ ...servers().engines[0], engine: 'postgresql' }] }], ['unknown', overview()], ['overview', null],
    ]
    for (const [kind, value] of cases) expect(() => readWhmDatabasesView(kind, value)).toThrow()
  })
  it('accepts only an exact echo of the kill request with consistent outcome semantics', () => {
    const request = { id: 5, mode: 'query' as const, user: 'alpha_app', db: 'alpha_wp' }
    expect(readWhmDatabaseKillOutcome({ ...request, outcome: 'confirmed', statementAccepted: true, after: 'idle', verificationRequired: false }, request)).toEqual({ outcome: 'confirmed', after: 'idle' })
    for (const value of [{ ...request, id: 6, outcome: 'confirmed', statementAccepted: true, after: 'absent', verificationRequired: false }, { ...request, outcome: 'confirmed', statementAccepted: false, after: 'absent', verificationRequired: false }, { ...request, outcome: 'attempted', statementAccepted: true, after: 'active', verificationRequired: false }, { ...request, db: null, outcome: 'confirmed', statementAccepted: true, after: 'absent', verificationRequired: false }]) expect(() => readWhmDatabaseKillOutcome(value, request)).toThrow()
  })
})

describe('WHM database client binding', () => {
  it('makes no request without transport or read admission', async () => {
    mount('overview'); boot(); expect(statusOf().dataset.state).toBe('unavailable')
    mount('overview', { canRead: false }); const send = vi.fn(); boot(send); await tick()
    expect(send).not.toHaveBeenCalled(); expect(document.querySelector<HTMLButtonElement>('[data-whm-db-refresh]')!.disabled).toBe(true)
  })
  it('paints the overview with separate saved and observed values and filters by drift', async () => {
    mount('overview'); const send = vi.fn(async () => overview()); boot(send); await tick()
    expect(send).toHaveBeenCalledWith('GET', '/api/server/databases/overview')
    expect(statusOf().dataset.state).toBe('read')
    expect(document.querySelector('[data-whm-db-fact="version"]')!.textContent).toBe('10.11.6-MariaDB')
    expect(document.querySelector('[data-whm-db-fact="Uptime"]')!.textContent).toBe('3600 seconds')
    expect(document.querySelector('[data-whm-db-fact="databases"]')!.textContent).toBe('1')
    expect(document.querySelector('[data-whm-db-rows="accounts"]')!.textContent).toContain('agency')
    const drift = document.querySelector<HTMLSelectElement>('[data-whm-db-drift-filter]')!
    expect(drift.disabled).toBe(false)
    drift.value = 'server-only'; drift.dispatchEvent(new Event('change'))
    const visible = [...document.querySelectorAll<HTMLTableRowElement>('[data-whm-db-rows="databases"] tr')].filter(row => !row.hidden).map(row => row.textContent)
    expect(visible).toHaveLength(1); expect(visible[0]).toContain('stray_db')
    const search = document.querySelector<HTMLInputElement>('[data-whm-db-search]')!
    search.value = 'nothing-matches'; search.dispatchEvent(new Event('input'))
    expect(document.querySelector<HTMLElement>('[data-whm-db-filter-empty]')!.hidden).toBe(false)
    expect(WHM_DATABASES_CLIENT_BINDING).not.toContain('innerHTML'); expect(WHM_DATABASES_CLIENT_BINDING).not.toContain('fetch(')
  })
  it('shows unavailable observations and refused replies without inventing values', async () => {
    mount('overview')
    boot(async () => ({ ...overview(), observed: { state: 'unavailable', observedAt: null, version: null, status: null, schemaCount: null, totalSizeBytes: null }, databases: [{ name: 'alpha_wp', account: 'alpha', trashed: false, sizeBytes: null, tables: null, drift: 'unverified' }], drift: null })); await tick()
    expect(statusOf().dataset.state).toBe('unavailable'); expect(document.querySelector('[data-whm-db-fact="version"]')!.textContent).toBe('Not observed')
    expect(document.querySelector('[data-whm-db-rows="databases"]')!.textContent).toContain('Not verified')
    mount('users'); boot(async () => ({ ...users(), ownerPage: '/elsewhere' })); await tick()
    expect(statusOf().dataset.state).toBe('failed'); expect(document.querySelector('[data-whm-db-rows="users"]')!.textContent).toBe('Not read')
  })
  it('confirms a kill naming id, user and database, posts the exact identity and re-reads', async () => {
    mount('processes')
    const send = vi.fn(async (method: string, _path: string, body?: unknown) => method === 'POST' ? { ...(body as object), outcome: 'confirmed', statementAccepted: true, after: 'idle', verificationRequired: false } : processes())
    const ask = vi.fn(async () => true)
    boot(send, ask); await tick()
    const rows = document.querySelectorAll('[data-whm-db-rows="processes"] tr')
    expect(rows[1]!.textContent).toContain('Protected: system account'); expect(rows[1]!.querySelector('button')).toBeNull()
    const button = rows[0]!.querySelector<HTMLButtonElement>('[data-whm-db-kill="query"]')!
    expect(button.disabled).toBe(false); button.click(); await tick()
    expect(ask).toHaveBeenCalledTimes(1)
    expect((ask.mock.calls[0] as unknown as [Record<string, string>])[0].body).toMatch(/Process 5 · user alpha_app · database alpha_wp/)
    expect(send.mock.calls.filter(call => call[0] === 'POST')).toEqual([['POST', '/api/server/databases/processes/kill', { id: 5, mode: 'query', user: 'alpha_app', db: 'alpha_wp' }]])
    expect(send.mock.calls.filter(call => call[0] === 'GET')).toHaveLength(2)
    expect(statusOf().dataset.state).toBe('read'); expect(statusOf().textContent).toContain('confirmed by a fresh read')
  })
  it('sends nothing when cancelled and reports 409 or uncertain outcomes truthfully', async () => {
    mount('processes'); const send = vi.fn(async (_method: string, _path: string) => processes()); boot(send, async () => false); await tick()
    document.querySelector<HTMLButtonElement>('[data-whm-db-kill="connection"]')!.click(); await tick()
    expect(send.mock.calls.some(call => call[0] === 'POST')).toBe(false)
    mount('processes')
    boot(async (method: string) => { if (method === 'POST') throw { status: 409, details: { stateChanged: false } }; return processes() }, async () => true); await tick()
    document.querySelector<HTMLButtonElement>('[data-whm-db-kill="connection"]')!.click(); await tick()
    expect(statusOf().dataset.state).toBe('failed'); expect(statusOf().textContent).toContain('changed before the kill')
    mount('processes')
    boot(async (method: string, _path: string, body?: unknown) => method === 'POST' ? { ...(body as object), outcome: 'attempted', statementAccepted: true, after: 'active', verificationRequired: true } : processes(), async () => true); await tick()
    document.querySelector<HTMLButtonElement>('[data-whm-db-kill="connection"]')!.click(); await tick()
    expect(statusOf().dataset.state).toBe('uncertain'); expect(statusOf().getAttribute('role')).toBe('alert')
    mount('processes', { canKill: false }); boot(async () => processes(), async () => true); await tick()
    expect(document.querySelector<HTMLButtonElement>('[data-whm-db-kill="query"]')!.disabled).toBe(true)
  })
  it('paints the configured engine, its service state and observed settings', async () => {
    mount('servers'); boot(async () => servers()); await tick()
    expect(document.querySelector('[data-whm-db-rows="engines"]')!.textContent).toContain('mariadb.service')
    expect(document.querySelector('[data-whm-db-fact="clientSocket"]')!.textContent).toBe('/run/mysqld/mysqld.sock')
    expect(document.querySelector('[data-whm-db-fact="protocol"]')!.textContent).toBe('Unix socket')
    expect(document.querySelector('[data-whm-db-fact="port"]')!.textContent).toBe('3306')
  })
})


describe('WHM database human observation timestamps preserve raw evidence', () => {
  it.each(['overview', 'users', 'processes', 'servers'] as const)('formats the visible %s instant in both locales without rewriting the reply', async kind => {
    const rawAt = '2026-10-27T10:00:00.123Z'
    for (const locale of ['en', 'ar'] as const) {
      const raw = kind === 'overview' ? overview() : kind === 'users' ? users() : kind === 'processes' ? processes() : servers()
      const observation = 'engines' in raw ? raw.engines[0]!.observed : raw.observed
      observation.observedAt = rawAt
      const original = JSON.stringify(raw), parsed = readWhmDatabasesView(kind, raw)
      expect((parsed.kind === 'servers' ? parsed.engine.observed : parsed.observed).observedAt).toBe(rawAt)
      document.body.innerHTML = `<section data-whm-detail-route="/whm/databases" data-capability-state="authorized">${renderWhmDatabasesWorkspace({ kind, locale, canRead: true, canKill: false })}</section>`
      const send = vi.fn(async (_method: string, _path: string) => raw)
      ;(window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = send
      new Function('return ' + WHM_DATABASES_CLIENT_BINDING)()(undefined)
      await tick()
      const fact = document.querySelector<HTMLElement>('[data-whm-db-fact="observedAt"]')!
      expect(fact.textContent).toBe('2026-10-27 10:00 UTC')
      expect(fact.querySelector('bdi')?.dir).toBe('ltr')
      expect(fact.textContent).not.toContain(rawAt)
      expect(send.mock.calls).toEqual([['GET', '/api/server/databases/' + kind]])
      expect(JSON.stringify(raw)).toBe(original)
    }
  })
  it('keeps the existing null observation label rather than formatting an invented instant', async () => {
    mount('overview')
    boot(async () => ({ ...overview(), observed: { state: 'unavailable', observedAt: null, version: null, status: null, schemaCount: null, totalSizeBytes: null }, databases: [{ name: 'alpha_wp', account: 'alpha', trashed: false, sizeBytes: null, tables: null, drift: 'unverified' }], drift: null }))
    await tick()
    const fact = document.querySelector<HTMLElement>('[data-whm-db-fact="observedAt"]')!
    expect(fact.textContent).toBe('Not observed'); expect(fact.querySelector('bdi')).toBeNull()
  })
})
