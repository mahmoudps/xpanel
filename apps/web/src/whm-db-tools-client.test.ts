// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderDbAccessHostsCard, renderDbMapCard, renderDbServerToolCards, renderDbWizardCard } from './board-port/whm-db-tools-workspace.ts'
import { dbWizardNameError, readAccessHostLines, splitDbNames, WHM_DB_TOOLS_CLIENT_BINDING } from './whm-db-tools-client.ts'

const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const boot = (request: (method: string, path: string, body?: unknown) => Promise<unknown>, ask = vi.fn(async () => true)) => { (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest = request; new Function('return ' + WHM_DB_TOOLS_CLIENT_BINDING)()(ask); return ask }
const el = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!
beforeEach(() => { delete (window as Window & { xpanelSessionRequest?: unknown }).xpanelSessionRequest; (globalThis as { xpT?: unknown }).xpT = (message: string, values?: Record<string, string>) => Object.entries(values ?? {}).reduce((text, [key, value]) => text.replace(`{${key}}`, value), message) })

describe('database tool helpers', () => {
  it('splits lists and keeps saved comments', () => {
    expect(splitDbNames('a_b, c_d\ne_f, a_b')).toEqual(['a_b', 'c_d', 'e_f'])
    expect(readAccessHostLines('203.0.113.10\n\n203.0.113.11\n', [{ host: '203.0.113.11', comment: 'office' }])).toEqual([{ host: '203.0.113.10', comment: '' }, { host: '203.0.113.11', comment: 'office' }])
  })
  it('rejects a backtick at step 1 and an overlong prefixed name', () => {
    expect(dbWizardNameError('shop', 'alice', 'mariadb')).toBeNull()
    expect(dbWizardNameError('sh`op', 'alice', 'mariadb')).toBe('invalid')
    expect(dbWizardNameError('x'.repeat(58), 'alice', 'postgresql')).toBe('long')
    expect(dbWizardNameError('x'.repeat(58), 'alice', 'mariadb')).toBeNull()
  })
})

describe('Database Map Tool client', () => {
  it('stays closed without the verified tool and explains a refusal', async () => {
    document.body.innerHTML = `<section>${renderDbMapCard('en', false)}</section>`
    boot(async () => ({})); await tick()
    expect(el<HTMLButtonElement>('[data-db-map-submit]').disabled).toBe(true)
    document.body.innerHTML = `<section>${renderDbMapCard('en', true)}</section>`
    const send = vi.fn(async () => { throw { details: { stateChanged: false, reason: 'already_owned' } } }); boot(send); await tick()
    el<HTMLInputElement>('[data-db-map-account]').value = 'alice'; el<HTMLInputElement>('[data-db-map-databases]').value = 'bob_x, bob_y'
    el<HTMLButtonElement>('[data-db-map-submit]').click(); await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/databases/ownership', { account: 'alice', databases: ['bob_x', 'bob_y'], users: [] })
    expect(el('[data-db-map-status]').textContent).toContain('already belongs')
  })
})

describe('access hosts client', () => {
  it('saves with the revision, pushes after a confirmation and shows every outcome', async () => {
    document.body.innerHTML = `<section>${renderDbAccessHostsCard('en', true)}</section>`
    const view = { revision: 'r1', hosts: [{ host: '203.0.113.10', comment: 'office' }] }
    const send = vi.fn(async (method: string, path: string) => path.endsWith('/push') ? { accounts: [{ account: 'a', state: 'applied', added: [] }, { account: 'b', state: 'failed', added: [] }], pending: ['c'] } : view)
    const ask = boot(send); await tick()
    expect(el<HTMLTextAreaElement>('[data-db-hosts-list]').value).toBe('203.0.113.10')
    el<HTMLButtonElement>('[data-db-hosts-save]').click(); await tick()
    expect(send.mock.calls.find(call => call[0] === 'PUT')?.[2 as never]).toEqual({ hosts: [{ host: '203.0.113.10', comment: 'office' }], expectedRevision: 'r1' })
    el<HTMLButtonElement>('[data-db-hosts-push]').click(); await tick()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(el('[data-db-hosts-status]').textContent).toBe('Applied: 1. Already present: 0. Failed: 1. Not reached: 1.')
    expect(el('[data-db-hosts-status]').dataset.state).toBe('uncertain')
  })
})

describe('server tool cards client', () => {
  it('confirms before a database restart and sends the revision', async () => {
    document.body.innerHTML = `<section>${renderDbServerToolCards('en', { canSettings: true, canPostgresql: false })}</section>`
    const send = vi.fn(async (method: string, path: string) => path.endsWith('/settings') ? { revision: 'r', state: 'read', autotuneLimits: true, innodbBufferPoolByRam: false, application: { status: 'applied' } } : { installed: true, running: true, version: '14', accountsWithoutRole: [] })
    const ask = boot(send, vi.fn(async () => true)); await tick()
    el<HTMLButtonElement>('[data-db-settings-save]').click(); await tick()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(send.mock.calls.find(call => call[0] === 'PUT')?.[2 as never]).toEqual({ autotuneLimits: true, innodbBufferPoolByRam: false, expectedRevision: 'r' })
  })
  it('shows PostgreSQL state and clears the password after a change', async () => {
    document.body.innerHTML = `<section>${renderDbServerToolCards('en', { canSettings: false, canPostgresql: true })}</section>`
    const send = vi.fn(async (method: string, path: string) => path === '/api/server/databases/postgresql' ? { installed: true, running: true, version: '14.24', accountsWithoutRole: ['alice'] } : path.endsWith('/settings') ? { revision: 'r', state: 'read' } : { verificationRequired: false })
    boot(send); await tick()
    expect(el('[data-db-pg-fact="missing"]').textContent).toBe('1')
    expect(el<HTMLButtonElement>('[data-db-pg-roles]').disabled).toBe(false)
    const password = el<HTMLInputElement>('[data-db-pg-new]'), confirm = el<HTMLInputElement>('[data-db-pg-confirm]')
    password.value = confirm.value = 'Abcdefgh1234!xyz'; confirm.dispatchEvent(new Event('input'))
    el<HTMLButtonElement>('[data-db-pg-submit]').click(); await tick()
    expect(send).toHaveBeenCalledWith('POST', '/api/server/databases/postgresql/superuser-password', { password: 'Abcdefgh1234!xyz' })
    expect(password.value).toBe(''); expect(el('[data-db-pg-status]').textContent).not.toContain('Abcdefgh')
  })
})

describe('database wizards', () => {
  const mount = (engine: 'mariadb' | 'postgresql', canManage = true) => { document.body.innerHTML = `<section>${renderDbWizardCard('en', { engine, username: 'alice', canManage })}</section>` }
  const next = async () => { el<HTMLButtonElement>('[data-db-wizard-next]').click(); await tick() }
  it('rejects a bad name at step 1 and creates nothing', async () => {
    mount('mariadb'); const send = vi.fn(async () => ({})); boot(send); await tick()
    el<HTMLInputElement>('[data-db-wizard-name]').value = 'sh`op'; await next()
    expect(el('[data-db-wizard-status]').dataset.state).toBe('failed'); expect(send).not.toHaveBeenCalled()
  })
  it('creates the prefixed database, user and grant for MariaDB, then offers another', async () => {
    mount('mariadb'); const send = vi.fn(async (_method: string, path: string) => path === '/api/databases' ? { database: { id: 'd1' } } : {}); boot(send); await tick()
    el<HTMLInputElement>('[data-db-wizard-name]').value = 'shop'; await next()
    el<HTMLInputElement>('[data-db-wizard-user]').value = 'app'; el<HTMLInputElement>('[data-db-wizard-password]').value = 'Secret-pass-1'; await next()
    el<HTMLInputElement>('[data-db-wizard-all]').checked = true; await next()
    expect(send.mock.calls[0]).toEqual(['POST', '/api/databases', { name: 'alice_shop' }])
    expect(send.mock.calls[1]![1]).toBe('/api/databases/users')
    expect(send.mock.calls[1]![2 as never]).toMatchObject({ name: 'alice_app', password: 'Secret-pass-1', databaseId: 'd1' })
    expect(el('[data-db-wizard-summary]').textContent).toContain('alice_shop')
    expect(el<HTMLInputElement>('[data-db-wizard-password]').value).toBe('')
  })
  it('creates the PostgreSQL user before the database it owns', async () => {
    mount('postgresql'); const send = vi.fn(async () => ({})); boot(send); await tick()
    el<HTMLInputElement>('[data-db-wizard-name]').value = 'shop'; await next()
    el<HTMLInputElement>('[data-db-wizard-user]').value = 'app'; el<HTMLInputElement>('[data-db-wizard-password]').value = 'Secret-pass-1'; await next(); await next()
    expect(send.mock.calls.map(call => (call as unknown[])[1])).toEqual(['/api/account/database-engines/postgresql/users', '/api/account/database-engines/postgresql/databases'])
    expect((send.mock.calls[1] as unknown[])[2]).toEqual({ name: 'alice_shop', owner: 'alice_app' })
  })
  it('stays closed without the verified tool', async () => {
    mount('mariadb', false); boot(async () => ({})); await tick()
    expect(el<HTMLButtonElement>('[data-db-wizard-next]').disabled).toBe(true)
  })
})
