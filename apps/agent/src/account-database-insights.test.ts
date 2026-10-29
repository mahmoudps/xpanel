import { describe, expect, it, vi } from 'vitest'
import type { Account, Database, DatabaseUser, Plan } from '@xpanel/core'
import { MARIADB_ADMIN_SCHEMAS_SQL } from '../../../packages/os/src/mariadb-admin-command.ts'
import {
  INSIGHTS_MAX_DATABASES, INSIGHTS_TEMPLATES, accountDatabaseInsightsStatement, handleAccountDatabaseInsightsRoute, isAccountDatabaseInsightsStatement, ownedInsightNames,
  parseInsightsSchemas, parseInsightsTables, parseInsightsTotals, parseInsightsUsers,
} from './account-database-insights.ts'
import type { AccountDatabaseInsightsRouteDeps } from './account-database-insights.ts'

const ACCOUNT = '11111111-1111-4111-8111-111111111111', OTHER = '99999999-9999-4999-8999-999999999999'
const account = { id: ACCOUNT, username: 'alice', uid: 1001, gid: 1001, home: '/home/alice', status: 'active', planId: 'plan', primaryDomain: 'example.test' } as Account
const db = (name: string, accountId = ACCOUNT, trashedAt: string | null = null): Database => ({ id: name, accountId, engine: 'mariadb', name, trashedAt })
const user = (name: string, accountId = ACCOUNT): DatabaseUser => ({ id: name, accountId, name, grants: [] })
const lines = (...rows: string[][]): string => rows.map(row => row.join('\t') + '\n').join('')
const set = (...names: string[]): ReadonlySet<string> => new Set(names)

describe('database insights statements', () => {
  it('builds exact templates from quoted owned names and admits only those texts', () => {
    const sql = accountDatabaseInsightsStatement('schemas', ['alice_shop', 'alice_wp'])
    expect(sql).toBe("SELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME IN ('alice_shop', 'alice_wp') ORDER BY SCHEMA_NAME")
    for (const kind of Object.keys(INSIGHTS_TEMPLATES) as (keyof typeof INSIGHTS_TEMPLATES)[]) expect(isAccountDatabaseInsightsStatement(accountDatabaseInsightsStatement(kind, ['alice_wp']))).toBe(true)
    expect(accountDatabaseInsightsStatement('tables', ['alice_wp'])).toContain('WHERE n <= 20 ORDER BY s, n')
    const head = INSIGHTS_TEMPLATES.schemas.split('%NAMES%')[0]!, tail = INSIGHTS_TEMPLATES.schemas.split('%NAMES%')[1]!
    for (const list of ["'alice_wp'); DROP DATABASE alice_wp; --", "'alice_wp' OR 1=1", "'Alice_wp'", "'alice_wp','alice_x'", "'alice_wp', 'alice_wp'", '', "''", "'alice\\'wp'"])
      expect(isAccountDatabaseInsightsStatement(head + list + tail)).toBe(false)
    expect(isAccountDatabaseInsightsStatement(MARIADB_ADMIN_SCHEMAS_SQL)).toBe(false)
    expect(isAccountDatabaseInsightsStatement(INSIGHTS_TEMPLATES.users)).toBe(false)
    expect(isAccountDatabaseInsightsStatement(sql + ';')).toBe(false); expect(isAccountDatabaseInsightsStatement(42)).toBe(false)
    const many = Array.from({ length: INSIGHTS_MAX_DATABASES + 1 }, (_, index) => 'alice_d' + index)
    expect(isAccountDatabaseInsightsStatement(head + many.map(name => `'${name}'`).join(', ') + tail)).toBe(false)
    for (const names of [[], many, ["alice_wp'"], ['ALICE_wp'], ['alice_wp', 'alice_wp'], ['1alice']]) expect(() => accountDatabaseInsightsStatement('schemas', names)).toThrow('invalid_insights_names')
  })
})

describe('database insights ownership and parsers', () => {
  it('keeps only saved, active, owned names and counts the rest as omitted', () => {
    const owned = ownedInsightNames(account, [db('alice_wp'), db('bob_wp', OTHER), db('alice_old', ACCOUNT, '2026-10-01T00:00:00.000Z'), db('bob_shop'), db('alice_shop'), db('alice_wp')],
      [user('alice'), user('alice_app'), user('bob_app', OTHER), user('bob_x'), user('alice_' + 'x'.repeat(40))])
    expect(owned).toEqual({ databases: ['alice_shop', 'alice_wp'], users: ['alice', 'alice_app'], omitted: { databases: 1, users: 2 } })
    const capped = ownedInsightNames(account, Array.from({ length: 52 }, (_, index) => db('alice_d' + String(index).padStart(2, '0'))), [])
    expect(capped.databases).toHaveLength(50); expect(capped.omitted.databases).toBe(2)
  })
  it('parses each fixed result strictly and refuses rows for names that were not asked for', () => {
    const names = set('alice_shop', 'alice_wp')
    expect(parseInsightsSchemas(lines(['alice_wp', 'utf8mb4', 'utf8mb4_unicode_ci']), names).get('alice_wp')).toEqual({ characterSet: 'utf8mb4', collation: 'utf8mb4_unicode_ci' })
    expect(parseInsightsTotals(lines(['alice_wp', '12', '1048576', '65536', '0']), names).get('alice_wp')).toEqual({ tables: 12, dataBytes: 1048576, indexBytes: 65536, freeBytes: 0 })
    expect(parseInsightsTables(lines(['alice_wp', 'wp_posts', 'InnoDB', '420', '81920', '16384', '0'], ['alice_wp', 'seq', '', '-1', '-1', '-1', '-1']), names).get('alice_wp')).toEqual([
      { name: 'wp_posts', engine: 'InnoDB', rows: 420, dataBytes: 81920, indexBytes: 16384, freeBytes: 0 }, { name: 'seq', engine: null, rows: null, dataBytes: null, indexBytes: null, freeBytes: null }])
    expect(parseInsightsUsers(lines(['alice', '2']), set('alice')).get('alice')).toBe(2)
    expect(() => parseInsightsSchemas(lines(['bob_wp', 'utf8mb4', 'utf8mb4_general_ci']), names)).toThrow()
    expect(() => parseInsightsSchemas(lines(['alice_wp', 'utf8mb4', 'utf8mb4_general_ci'], ['alice_wp', 'utf8mb4', 'utf8mb4_general_ci']), names)).toThrow()
    expect(() => parseInsightsSchemas(lines(['alice_wp', 'utf8 mb4', 'x']), names)).toThrow()
    expect(() => parseInsightsTotals(lines(['alice_wp', '-2', '0', '0', '0']), names)).toThrow()
    expect(() => parseInsightsTotals(lines(['alice_wp', 'NULL', '0', '0', '0']), names)).toThrow()
    expect(() => parseInsightsTables(lines(...Array.from({ length: 21 }, (_, index) => ['alice_wp', 't' + index, 'InnoDB', '1', '1', '1', '0'])), names)).toThrow()
    expect(() => parseInsightsTables(lines(['alice_wp', 't', 'Inno DB', '1', '1', '1', '0']), names)).toThrow()
    expect(() => parseInsightsTables(lines(['alice_wp', 't', 'InnoDB', '1', '1', '1', '0'], ['alice_wp', 't', 'InnoDB', '1', '1', '1', '0']), names)).toThrow()
    expect(() => parseInsightsTables(lines(['alice_wp', 'x'.repeat(65), 'InnoDB', '1', '1', '1', '0']), names)).toThrow()
    expect(() => parseInsightsUsers(lines(['alice', '0']), set('alice'))).toThrow()
    expect(() => parseInsightsUsers(lines(['root', '1']), set('alice'))).toThrow()
  })
})

describe('agent database insights route', () => {
  const principal = { kind: 'user', id: 'p-alice', username: 'alice', accountId: ACCOUNT, disabled: false }
  const answers = (sql: string): string => {
    if (sql.startsWith('SELECT SCHEMA_NAME')) return lines(['alice_wp', 'utf8mb4', 'utf8mb4_unicode_ci'])
    if (sql.startsWith('SELECT TABLE_SCHEMA')) return lines(['alice_wp', '2', '98304', '16384', '4096'])
    if (sql.startsWith('SELECT s, t')) return lines(['alice_wp', 'wp_posts', 'InnoDB', '420', '81920', '16384', '4096'], ['alice_wp', 'wp_options', 'Aria', '9', '16384', '0', '0'])
    return lines(['alice_app', '1'])
  }
  const setup = (over: { role?: 'user' | 'root' | 'reseller'; disabled?: string[]; client?: boolean; fail?: string; principals?: (typeof principal | null)[]; databases?: Database[][] } = {}) => {
    const sent: string[] = [], principals = [...(over.principals ?? [])], lists = [...(over.databases ?? [])]
    const query = vi.fn(async (statements: readonly string[]) => {
      const sql = statements[0]!
      expect(statements).toHaveLength(1); expect(isAccountDatabaseInsightsStatement(sql)).toBe(true); expect(sql).not.toContain('bob')
      sent.push(sql)
      if (over.fail && sql.startsWith(over.fail)) throw new Error('Access denied for user')
      return answers(sql)
    })
    const deps: AccountDatabaseInsightsRouteDeps = {
      caller: { principalId: 'p-alice', actor: 'alice', role: over.role ?? 'user', accountId: over.role && over.role !== 'user' ? null : ACCOUNT, resellerId: null },
      store: { getAccountByUsername: async name => name === 'alice' ? account : null, getPlan: async () => ({ featureListId: 'list' }) as Plan, getFeatureList: async () => ({ id: 'list', name: 'f', ownerId: null, disabled: over.disabled ?? [] }),
        listDatabases: async () => lists.length ? lists.shift()! : [db('alice_wp'), db('alice_empty'), db('alice_gone'), db('bob_wp', OTHER)], listDatabaseUsers: async () => [user('alice_app'), user('alice_old'), user('bob_app', OTHER)] },
      currentPrincipal: async () => principals.length ? principals.shift()! : principal,
      ...(over.client === false ? {} : { mariadb: { query, socketPath: null } }), now: () => new Date('2026-10-27T03:00:00.000Z'),
    }
    const call = (path: string, method = 'GET') => { const url = new URL('http://agent.local' + path); return handleAccountDatabaseInsightsRoute(new Request(url, { method }), url, method, deps) }
    return { call, query, sent }
  }

  it('reports observed sizes, largest tables and existence for the owner\'s names only', async () => {
    const t = setup(), body = await (await t.call('/accounts/alice/database-insights'))!.json()
    expect(t.sent).toHaveLength(4); expect(t.sent[0]).toContain("IN ('alice_empty', 'alice_gone', 'alice_wp')"); expect(t.sent[3]).toContain("IN ('alice_app', 'alice_old')")
    expect(body).toEqual({ context: { accountId: ACCOUNT, username: 'alice' }, state: 'read', observedAt: '2026-10-27T03:00:00.000Z', limits: { maxDatabases: 50, maxUsers: 200, tablesPerDatabase: 20 }, omitted: { databases: 0, users: 0 },
      databases: [
        { name: 'alice_empty', server: 'absent', characterSet: null, collation: null, tables: null, dataBytes: null, indexBytes: null, freeBytes: null, largestTables: null },
        { name: 'alice_gone', server: 'absent', characterSet: null, collation: null, tables: null, dataBytes: null, indexBytes: null, freeBytes: null, largestTables: null },
        { name: 'alice_wp', server: 'present', characterSet: 'utf8mb4', collation: 'utf8mb4_unicode_ci', tables: 2, dataBytes: 98304, indexBytes: 16384, freeBytes: 4096, largestTables: [
          { name: 'wp_posts', engine: 'InnoDB', rows: 420, dataBytes: 81920, indexBytes: 16384, freeBytes: 4096 }, { name: 'wp_options', engine: 'Aria', rows: 9, dataBytes: 16384, indexBytes: 0, freeBytes: 0 }] }],
      users: [{ name: 'alice_app', server: 'present', hosts: 1 }, { name: 'alice_old', server: 'absent', hosts: null }] })
    expect(await t.call('/accounts/alice/databases')).toBeNull()
  })
  it('reports a failed statement as not observed and a missing client as unavailable', async () => {
    const partial = await (await setup({ fail: 'SELECT s, t' }).call('/accounts/alice/database-insights'))!.json() as any
    expect(partial.state).toBe('partial'); expect(partial.databases[2]).toMatchObject({ server: 'present', tables: 2, largestTables: null })
    const noSchemas = await (await setup({ fail: 'SELECT SCHEMA_NAME' }).call('/accounts/alice/database-insights'))!.json() as any
    expect(noSchemas.databases.map((row: { server: string | null }) => row.server)).toEqual([null, null, 'present']); expect(noSchemas.databases[0].tables).toBeNull()
    const offline = setup({ client: false }), view = await (await offline.call('/accounts/alice/database-insights'))!.json() as any
    expect(view.state).toBe('unavailable'); expect(view.databases.every((row: { server: unknown }) => row.server === null)).toBe(true); expect(view.users[0]).toEqual({ name: 'alice_app', server: null, hosts: null })
    const none = setup({ databases: [[], []] }), empty = await (await none.call('/accounts/alice/database-insights'))!.json() as any
    expect(empty.databases).toEqual([]); expect(none.sent).toHaveLength(1)
  })
  it('refuses other roles, other usernames, disabled plans, revoked owners and changed database lists', async () => {
    for (const role of ['root', 'reseller'] as const) await expect(setup({ role }).call('/accounts/alice/database-insights')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const other = setup(); await expect(other.call('/accounts/bob/database-insights')).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(other.query).not.toHaveBeenCalled()
    const disabled = setup({ disabled: ['database-insights'] }); await expect(disabled.call('/accounts/alice/database-insights')).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(disabled.query).not.toHaveBeenCalled()
    const revoked = setup({ principals: [principal, { ...principal, disabled: true }] })
    await expect(revoked.call('/accounts/alice/database-insights')).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(revoked.query).toHaveBeenCalled()
    await expect(setup({ databases: [[db('alice_wp')], [db('alice_wp'), db('alice_new')]] }).call('/accounts/alice/database-insights')).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(setup().call('/accounts/alice/database-insights?schema=bob_wp')).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await setup().call('/accounts/alice/database-insights', 'POST'))!.status).toBe(405)
  })
})
