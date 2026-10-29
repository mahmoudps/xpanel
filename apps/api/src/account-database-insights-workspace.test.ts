import { describe, expect, it, vi } from 'vitest'
import type { Account, Database, DatabaseUser, Plan } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { handleAccountDatabaseInsightsRoute } from './account-database-insights-workspace.ts'
import type { ReadAgent } from './account-ssh-workspace.ts'
import { handleAccountDatabaseInsightsRoute as handleAgentInsights, isAccountDatabaseInsightsStatement } from '../../agent/src/account-database-insights.ts'

// The agent route is the actual handler; only the MariaDB client and the transport are doubles.
const ACCOUNT = '11111111-1111-4111-8111-111111111111', OTHER = '99999999-9999-4999-8999-999999999999'
const account = { id: ACCOUNT, username: 'alice', uid: 1001, gid: 1001, home: '/home/alice', status: 'active', planId: 'plan', primaryDomain: 'example.test' } as Account
const owner = { principal: { kind: 'user', id: 'p-alice', username: 'alice', accountId: ACCOUNT }, apiTokenId: null, scopes: [], principalRecord: { forcePasswordChange: false } } as unknown as AuthenticatedCaller
const databases: Database[] = [{ id: 'd1', accountId: ACCOUNT, engine: 'mariadb', name: 'alice_wp', trashedAt: null }, { id: 'd2', accountId: OTHER, engine: 'mariadb', name: 'bob_wp', trashedAt: null }]
const users: DatabaseUser[] = [{ id: 'u1', accountId: ACCOUNT, name: 'alice_app', grants: [] }, { id: 'u2', accountId: OTHER, name: 'bob_app', grants: [] }]
const lines = (...rows: string[][]): string => rows.map(row => row.join('\t') + '\n').join('')
const answer = (sql: string): string => sql.startsWith('SELECT SCHEMA_NAME') ? lines(['alice_wp', 'utf8mb4', 'utf8mb4_unicode_ci']) : sql.startsWith('SELECT TABLE_SCHEMA') ? lines(['alice_wp', '1', '16384', '0', '0'])
  : sql.startsWith('SELECT s, t') ? lines(['alice_wp', 'wp_posts', 'InnoDB', '3', '16384', '0', '0']) : lines(['alice_app', '2'])

function setup(options: { disabled?: string[]; caller?: AuthenticatedCaller; reply?: (value: Record<string, any>) => unknown } = {}) {
  const query = vi.fn(async (statements: readonly string[]) => { expect(isAccountDatabaseInsightsStatement(statements[0])).toBe(true); expect(statements[0]).not.toContain('bob'); return answer(statements[0]!) })
  const listDatabases = vi.fn(async (id: string) => databases.filter(db => db.accountId === id)), listDatabaseUsers = vi.fn(async (id: string) => users.filter(user => user.accountId === id))
  const readAgent = vi.fn(async (_caller: AuthenticatedCaller, path: string) => {
    const url = new URL('http://agent.local' + path)
    const response = await handleAgentInsights(new Request(url), url, 'GET', { caller: { principalId: 'p-alice', actor: 'alice', role: 'user', accountId: ACCOUNT, resellerId: null }, mariadb: { query, socketPath: null },
      store: { getAccountByUsername: async name => name === 'alice' ? account : null, getPlan: async () => ({ featureListId: 'list' }) as Plan, getFeatureList: async () => ({ id: 'list', name: 'f', ownerId: null, disabled: [] }), listDatabases, listDatabaseUsers },
      currentPrincipal: async () => ({ kind: 'user', id: 'p-alice', username: 'alice', accountId: ACCOUNT, disabled: false }), now: () => new Date('2026-10-27T03:00:00.000Z') })
    const value = await response!.json() as Record<string, any>
    return options.reply ? options.reply(value) : value
  })
  const store = { getAccount: async (id: string) => id === ACCOUNT ? account : null, getPlan: async () => ({ featureListId: 'list' }), getFeatureList: async () => ({ id: 'list', name: 'f', ownerId: null, disabled: options.disabled ?? [] }), listDatabases, listDatabaseUsers } as unknown as StateStore
  const ports = { store, requireCaller: async () => options.caller ?? owner, readAgent: readAgent as unknown as ReadAgent }
  const route = (path: string, method = 'GET') => { const url = new URL('http://panel.test' + path); return handleAccountDatabaseInsightsRoute(new Request(url, { method }), url, method, ports) }
  return { route, readAgent, query }
}

describe('account database insights workspace', () => {
  it('returns the owner\'s observed databases and users through the agent', async () => {
    const t = setup(), body = await (await t.route('/api/account/database-insights'))!.json() as Record<string, any>
    expect(t.readAgent.mock.calls[0]![1]).toBe('/accounts/alice/database-insights'); expect(t.query).toHaveBeenCalledTimes(4)
    expect(body.databases).toEqual([{ name: 'alice_wp', server: 'present', characterSet: 'utf8mb4', collation: 'utf8mb4_unicode_ci', tables: 1, dataBytes: 16384, indexBytes: 0, freeBytes: 0, largestTables: [{ name: 'wp_posts', engine: 'InnoDB', rows: 3, dataBytes: 16384, indexBytes: 0, freeBytes: 0 }] }])
    expect(body.users).toEqual([{ name: 'alice_app', server: 'present', hosts: 2 }]); expect(body.state).toBe('read')
  })
  it('refuses other roles and disabled plans before any agent read, and any selector', async () => {
    for (const kind of ['root', 'reseller'] as const) await expect(setup({ caller: { ...owner, principal: { kind, id: kind, username: kind } } as unknown as AuthenticatedCaller }).route('/api/account/database-insights')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const disabled = setup({ disabled: ['database-insights'] }); await expect(disabled.route('/api/account/database-insights')).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(disabled.readAgent).not.toHaveBeenCalled()
    const t = setup(); await expect(t.route('/api/account/database-insights?database=bob_wp')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await t.route('/api/account/database-insights', 'POST'))!.status).toBe(405); expect(await t.route('/api/account/database-insights/bob_wp')).toBeNull(); expect(t.readAgent).not.toHaveBeenCalled()
  })
  it('refuses replies naming foreign databases or users, other accounts, or out-of-bound shapes', async () => {
    const replies: ((value: Record<string, any>) => unknown)[] = [
      v => ({ ...v, databases: [...v.databases, { ...v.databases[0], name: 'bob_wp' }] }), v => ({ ...v, users: [{ name: 'bob_app', server: 'present', hosts: 1 }] }),
      v => ({ ...v, context: { accountId: OTHER, username: 'bob' } }), v => ({ ...v, databases: [v.databases[0], v.databases[0]] }), v => ({ ...v, extra: true }),
      v => ({ ...v, limits: { ...v.limits, tablesPerDatabase: 5000 } }), v => ({ ...v, databases: [{ ...v.databases[0], largestTables: Array.from({ length: 21 }, (_, i) => ({ ...v.databases[0].largestTables[0], name: 't' + i })) }] }),
      v => ({ ...v, databases: [{ ...v.databases[0], server: 'absent' }] }), v => ({ ...v, users: [{ ...v.users[0], hosts: null }] }), v => ({ ...v, databases: [{ ...v.databases[0], largestTables: [{ ...v.databases[0].largestTables[0], name: 'a\u202eb' }] }] }),
      v => ({ ...v, databases: [{ ...v.databases[0], dataBytes: -1 }] }), v => ({ ...v, state: 'ok' }),
    ]
    for (const reply of replies) await expect(setup({ reply }).route('/api/account/database-insights')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { stateChanged: false } })
  })
})
