// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DB_ENGINES_CLIENT_BINDING, dbReadReply } from './db-engines-client.ts'
import { renderAccountDbEngineWorkspace, renderWhmDbEngineWorkspace } from './board-port/db-engines-workspace.ts'

const accountId = '11111111-1111-4111-8111-111111111111', at = '2026-10-28T10:00:00.000Z'
const absent = { installed: false, package: null, service: null }
const engines = (redis: unknown = absent, redisConfig: unknown = null) => ({ observedAt: at, family: 'debian', packages: 'read', products: { mariadb: absent, postgresql: absent, redis, mongodb: absent, phpmyadmin: absent, phppgadmin: absent }, redisConfig, mongodbConfig: null, postgresqlVersion: null })
const webClient = (state = 'ready', reason: string | null = null, accountView = false) => accountView
  ? { context: { accountId, username: 'alice' }, client: 'phpmyadmin', installed: true, signon: { state, reason }, databases: 2, ticketSeconds: 60, sessionSeconds: 1800 }
  : { client: 'phpmyadmin', installed: true, signon: { state, reason }, databases: null, ticketSeconds: 60, sessionSeconds: 1800, phppgadmin: false }
const signon = { client: 'phpmyadmin', action: 'https://panel.test:2083/phpmyadmin/xpanel-signon.php', ticket: 'T'.repeat(43), expiresAt: at, sessionExpiresAt: '2026-10-28T10:30:00.000Z' }
const pkg = { name: 'mariadb-server', current: '1:10.11.6', candidate: '1:10.11.11', origin: 'Debian', security: true, kernel: false, held: false, newInstall: false }
const upgrade = (canApply = true) => ({ state: 'read', reason: null, observedAt: at, revision: 'a'.repeat(64), family: 'debian', installed: { name: 'mariadb-server', version: '1:10.11.6' }, running: '10.11.6-MariaDB', unit: { unit: 'mariadb.service', active: 'active' }, packages: [pkg], blocked: [], backupDirectory: '/var/backups/xpanel/mariadb-upgrade', canApply })
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const q = <T extends HTMLElement>(selector: string): T => document.querySelector<T>(selector)!
async function bind(html: string, send: (...args: unknown[]) => Promise<unknown>, ask?: (options: Record<string, unknown>) => Promise<unknown>) {
  Object.assign(window, { xpanelSessionRequest: send }); document.body.innerHTML = html
  ;(new Function('return ' + DB_ENGINES_CLIENT_BINDING)() as (ask: unknown, rtl: boolean) => void)(ask, false); await tick()
}
afterEach(() => { document.body.replaceChildren(); delete (window as unknown as Record<string, unknown>).xpanelSessionRequest; document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr'; vi.restoreAllMocks() })

describe('database engine pages', () => {
  it('keep every approved component with ASCII digits, isolated technical values and no innerHTML in the binding', () => {
    for (const locale of ['en', 'ar'] as const) {
      for (const page of ['phpmyadmin', 'upgrade', 'redis', 'mongodb'] as const) { const html = renderWhmDbEngineWorkspace({ page, locale, canRead: true, canManage: true }); expect(html).toContain('data-db-status'); expect(html).not.toMatch(/[٠-٩۰-۹]/) }
      for (const page of ['phpmyadmin', 'postgresql', 'phppgadmin'] as const) expect(renderAccountDbEngineWorkspace({ page, lang: locale, accountId, username: 'alice', canManage: true })).toContain('<bdi dir="ltr">alice</bdi>')
    }
    expect(renderWhmDbEngineWorkspace({ page: 'upgrade', locale: 'ar', canRead: true, canManage: true })).toContain('dir="rtl"')
    expect(renderWhmDbEngineWorkspace({ page: 'upgrade', locale: 'en', canRead: true, canManage: true })).toContain('/var/backups/xpanel/mariadb-upgrade')
    expect(renderAccountDbEngineWorkspace({ page: 'postgresql', lang: 'en', accountId, username: 'alice', canManage: true })).toContain('Create database')
    expect(DB_ENGINES_CLIENT_BINDING).not.toContain('innerHTML')
  })
  it('reject leaked secrets, foreign objects and false readiness', () => {
    for (const [kind, raw] of [['signon', { ...signon, password: 'x' }], ['signon', { ...signon, action: 'https://panel.test/x?ticket=1' }], ['web-client', { ...webClient(), signon: { state: 'ready', reason: 'bridge-missing' } }], ['upgrade', { ...upgrade(), blocked: ['mariadb-server'] }], ['account-postgresql', { context: { accountId, username: 'alice' }, observedAt: at, state: 'read', version: null, databases: [{ name: 'bob_app', owner: 'bob', sizeBytes: 1 }], roles: [], provisioning: 'available', saved: { databases: [], users: [], limit: { used: 0, max: null } } }], ['account-phpmyadmin', webClient('ready', null, false)]] as const) expect(() => dbReadReply(kind, raw, accountId, 'alice')).toThrow()
  })
})

describe('phpMyAdmin sign-on client', () => {
  it('opens phpMyAdmin by posting the single-use ticket to a new tab and never shows it', async () => {
    const submitted: HTMLFormElement[] = []
    vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(function (this: HTMLFormElement) { submitted.push(this.cloneNode(true) as HTMLFormElement) })
    const send = vi.fn(async (method: unknown) => method === 'GET' ? webClient('ready', null, true) : signon)
    await bind(renderAccountDbEngineWorkspace({ page: 'phpmyadmin', lang: 'en', accountId, username: 'alice', canManage: true }), send)
    expect(q('[data-db-fact="databases"]').textContent).toBe('2'); const open = q<HTMLButtonElement>('[data-db-action="open"]'); expect(open.disabled).toBe(false)
    open.click(); await tick()
    expect(send).toHaveBeenLastCalledWith('POST', '/api/account/database-engines/phpmyadmin/sign-on', {})
    expect(submitted).toHaveLength(1); expect(submitted[0]!.method).toBe('post'); expect(submitted[0]!.target).toBe('_blank'); expect(submitted[0]!.action).toBe(signon.action)
    expect((submitted[0]!.querySelector('input[name="ticket"]') as HTMLInputElement).value).toBe(signon.ticket)
    expect(document.body.textContent).not.toContain(signon.ticket); expect(document.querySelector('form')).toBeNull()
  })
  it('keeps open disabled and marks the failing setup requirement when sign-on is not configured', async () => {
    await bind(renderWhmDbEngineWorkspace({ page: 'phpmyadmin', locale: 'en', canRead: true, canManage: true }), vi.fn(async () => webClient('not-configured', 'bridge-modified')))
    expect(q<HTMLButtonElement>('[data-db-action="open"]').disabled).toBe(true)
    const checks = [...document.querySelectorAll('[data-db-checks] li')].map(li => li.textContent)
    expect(checks[1]).toContain('Passed'); expect(checks[2]).toContain('Failed'); expect(checks[3]).toContain('Not checked')
    expect(q('[data-db-status]').textContent).toBe('The sign-on bridge differs from the reviewed file.')
  })
  it('sends nothing on an unavailable page', async () => {
    const send = vi.fn(async () => webClient())
    await bind(renderAccountDbEngineWorkspace({ page: 'phpmyadmin', lang: 'en', accountId, username: 'alice', canManage: false }), send)
    expect(send).not.toHaveBeenCalled(); expect(q('[data-db-status]').dataset.state).toBe('unavailable')
  })
})

describe('MariaDB upgrade client', () => {
  it('submits only after confirmation with the observed revision and then locks until read again', async () => {
    const send = vi.fn(async (method: unknown) => method === 'GET' ? upgrade() : { job: { id: 'job-1', kind: 'database.mariadb.upgrade', referenceCode: 'J-1001', status: 'queued' } })
    let answer = false
    const ask = vi.fn(async () => answer)
    await bind(renderWhmDbEngineWorkspace({ page: 'upgrade', locale: 'en', canRead: true, canManage: true }), send, ask)
    expect(q('[data-db-rows="packages"]').textContent).toContain('1:10.11.11')
    const start = q<HTMLButtonElement>('[data-db-action="upgrade"]'); start.click(); await tick()
    expect(send).toHaveBeenCalledTimes(1)
    answer = true; start.click(); await tick()
    expect(send).toHaveBeenLastCalledWith('POST', '/api/server/databases/upgrade/apply', { expectedRevision: 'a'.repeat(64) })
    expect(q('[data-db-job]').textContent).toContain('J-1001'); expect(start.disabled).toBe(true)
  })
  it('explains a current server and keeps the action disabled', async () => {
    await bind(renderWhmDbEngineWorkspace({ page: 'upgrade', locale: 'en', canRead: true, canManage: true }), vi.fn(async () => ({ ...upgrade(false), packages: [] })))
    expect(q('[data-db-plan]').textContent).toBe('MariaDB is current for the configured repositories.'); expect(q<HTMLButtonElement>('[data-db-action="upgrade"]').disabled).toBe(true)
  })
})

describe('Redis, MongoDB and PostgreSQL clients', () => {
  it('shows the honest next step when Redis is absent and config facts when present', async () => {
    await bind(renderWhmDbEngineWorkspace({ page: 'redis', locale: 'en', canRead: true, canManage: true }), vi.fn(async () => engines()))
    expect(q('[data-db-next]').textContent).toContain('Redis is not installed'); expect(q('[data-db-fact="package"]').textContent).toBe('Not installed')
    const facts = { port: 6379, bind: ['127.0.0.1'], protectedMode: 'yes', unixSocket: null, maxmemory: null, maxmemoryPolicy: null, requirePass: true, aclFile: false, appendOnly: null, includes: 0 }
    await bind(renderWhmDbEngineWorkspace({ page: 'redis', locale: 'en', canRead: true, canManage: true }), vi.fn(async () => engines({ installed: true, package: { name: 'redis-server', version: '5:7.0.15-1' }, service: { unit: 'redis-server.service', active: 'active', sub: 'running', enabled: 'enabled' } }, { path: '/etc/redis/redis.conf', state: 'read', facts })))
    expect(q('[data-db-fact="port"] bdi').textContent).toBe('6379'); expect(q('[data-db-fact="maxmemory"]').textContent).toBe('Not set (server default)'); expect(q('[data-db-fact="requirePass"]').textContent).toBe('Yes')
    expect(q('[data-db-status]').dataset.state).toBe('ready')
  })
  it('keeps every PostgreSQL change disabled while the server is not running', async () => {
    document.documentElement.lang = 'ar'; document.documentElement.dir = 'rtl'
    const send = vi.fn(async () => pgView({ state: 'stopped', version: null, databases: [], roles: [], provisioning: 'unavailable' }))
    await bind(renderAccountDbEngineWorkspace({ page: 'postgresql', lang: 'ar', accountId, username: 'alice', canManage: true }), send)
    expect(q('[data-db-rows="databases"]').textContent).toContain('alice_shop'); expect(q('[data-db-rows="roles"] bdi').getAttribute('dir')).toBe('ltr')
    expect([...document.querySelectorAll<HTMLInputElement>('[data-db-pg-form] :is(input, select, button), [data-db-pg-act]')].every(control => control.disabled)).toBe(true)
    expect(q('[data-db-status]').dataset.state).toBe('unavailable'); expect(document.body.textContent).not.toMatch(/[٠-٩۰-۹]/)
    q<HTMLFormElement>('[data-db-pg-form="user"]').requestSubmit(); await tick()
    expect(send).toHaveBeenCalledTimes(1)
  })
})

const shopId = '22222222-2222-4222-8222-222222222222', userId = '33333333-3333-4333-8333-333333333333'
const pgView = (over: Record<string, unknown> = {}) => ({
  context: { accountId, username: 'alice' }, observedAt: at, state: 'read', version: '16.4', provisioning: 'available',
  databases: [{ name: 'alice_shop', owner: 'alice_app', sizeBytes: 2048 }, { name: 'alice_manual', owner: 'alice', sizeBytes: 1024 }], roles: [{ name: 'alice_app', login: true }],
  saved: { databases: [{ id: shopId, name: 'alice_shop', owner: 'alice_app', trashedAt: null }], users: [{ id: userId, name: 'alice_app' }], limit: { used: 1, max: 5 } }, ...over,
})
const change = (kind: string, name: string) => ({ stateChanged: true, kind, name, application: { status: 'global_configuration_applied', targetVerified: false } })

describe('PostgreSQL provisioning client', () => {
  it('shows saved and server-only objects and fills the owner choices', async () => {
    await bind(renderAccountDbEngineWorkspace({ page: 'postgresql', lang: 'en', accountId, username: 'alice', canManage: true }), vi.fn(async () => pgView()))
    const rows = [...document.querySelectorAll('[data-db-rows="databases"] tr')].map(row => row.textContent)
    expect(rows[0]).toContain('alice_shop'); expect(rows[0]).toContain('2.0 KiB'); expect(rows[0]).toContain('Active'); expect(rows[0]).toContain('Move to trash')
    expect(rows[1]).toContain('Not saved in xPanel'); expect(q('[data-db-fact="limit"]').textContent).toBe('1 of 5')
    expect([...q<HTMLSelectElement>('#db-pg-owner').options].map(option => option.value)).toEqual(['alice_app'])
    expect([...q<HTMLSelectElement>('#db-pg-password-user').options].map(option => option.value)).toEqual([userId])
    expect(q<HTMLButtonElement>('[data-db-pg-form="database"] button').disabled).toBe(false)
  })
  it('creates a prefixed user, moves a database to the trash after confirmation and reads again', async () => {
    const send = vi.fn(async (method: unknown, path: unknown) => method === 'GET' ? pgView() : String(path).endsWith('/users') ? change('user', 'alice_new') : change('database', 'alice_shop'))
    const ask = vi.fn(async () => true)
    await bind(renderAccountDbEngineWorkspace({ page: 'postgresql', lang: 'en', accountId, username: 'alice', canManage: true }), send, ask)
    q<HTMLInputElement>('#db-pg-user').value = 'New'; q<HTMLInputElement>('#db-pg-password').value = 'long enough secret'
    q<HTMLFormElement>('[data-db-pg-form="user"]').requestSubmit(); await tick(); await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/account/database-engines/postgresql/users', { name: 'alice_new', password: 'long enough secret' })
    expect(q<HTMLInputElement>('#db-pg-password').value).toBe(''); expect(q('[data-db-status]').textContent).toContain('The user was saved')
    q<HTMLButtonElement>('[data-db-pg-act="trash"]').click(); await tick(); await tick()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('POST', `/api/account/database-engines/postgresql/databases/${shopId}/trash`, { expectedTrashedAt: null, confirmation: 'alice_shop' })
    expect(send.mock.calls.filter(call => call[0] === 'GET')).toHaveLength(3)
    expect(document.body.textContent).not.toContain('long enough secret')
  })
  it('restores with the observed trash time and explains refused changes without claiming success', async () => {
    const trashedAt = '2026-10-28T09:00:00.000Z'
    const view = pgView({ saved: { databases: [{ id: shopId, name: 'alice_shop', owner: 'alice_app', trashedAt }], users: [{ id: userId, name: 'alice_app' }], limit: { used: 0, max: null } } })
    const send = vi.fn(async (method: unknown) => { if (method === 'GET') return view; throw Object.assign(new Error('refused'), { code: 'PRECONDITION_FAILED', details: { stateChanged: false } }) })
    await bind(renderAccountDbEngineWorkspace({ page: 'postgresql', lang: 'en', accountId, username: 'alice', canManage: true }), send, vi.fn(async () => true))
    expect(q('[data-db-fact="limit"]').textContent).toBe('0 of unlimited')
    q<HTMLButtonElement>('[data-db-pg-act="restore"]').click(); await tick(); await tick()
    expect(send).toHaveBeenCalledWith('POST', `/api/account/database-engines/postgresql/databases/${shopId}/restore`, { expectedTrashedAt: trashedAt, confirmation: 'alice_shop' })
    expect(q('[data-db-status]').dataset.state).toBe('error'); expect(q('[data-db-status]').textContent).toContain('Nothing was changed')
    q<HTMLButtonElement>('[data-db-pg-act="purge"]').click(); await tick(); await tick()
    expect(send).toHaveBeenLastCalledWith('GET', '/api/account/database-engines/postgresql')
  })
  it('rejects foreign saved names, false availability and loose change replies', () => {
    for (const raw of [pgView({ provisioning: 'unavailable' }), pgView({ saved: { databases: [{ id: shopId, name: 'bob_shop', owner: 'alice_app', trashedAt: null }], users: [], limit: { used: 0, max: 1 } } }), pgView({ saved: { databases: [], users: [{ id: 'x', name: 'alice_app' }], limit: { used: 0, max: 1 } } })]) expect(() => dbReadReply('account-postgresql', raw, accountId, 'alice')).toThrow()
    for (const raw of [{ ...change('user', 'alice_app'), password: 'x' }, change('user', 'bob_app'), { ...change('user', 'alice_app'), stateChanged: false }]) expect(() => dbReadReply('pg-change', raw, accountId, 'alice')).toThrow()
  })
})
