import { assertDbNameOwned, fail } from '@xpanel/core'
import type { Account, Database, DatabaseUser, FeatureList, Plan } from '@xpanel/core'
import { services } from '@xpanel/render'
import { parseMariadbBatch } from './mariadb-admin.ts'
import type { MariadbAdminClient, MariadbAdminSql } from './mariadb-admin.ts'
import type { AgentCallerIdentity } from './server.ts'

/** Saved names beyond these caps are counted as omitted, never queried. 50 x 20 table rows keep the reply far below the 1 MiB API read bound. */
export const INSIGHTS_MAX_DATABASES = 50
export const INSIGHTS_MAX_USERS = 200
export const INSIGHTS_TOP_TABLES = 20
export const DATABASE_INSIGHTS_TOOL = 'database-insights'

const LIST = '%NAMES%'
/**
 * Fixed read-only templates. The only variable part is the IN list, built from saved names that passed
 * the ownership grammar and quoted with the render quoteString helper. `_` is literal outside LIKE.
 * information_schema reports estimates for InnoDB rows and sizes (MariaDB "Information Schema TABLES Table").
 */
export const INSIGHTS_TEMPLATES = {
  schemas: `SELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME IN (${LIST}) ORDER BY SCHEMA_NAME`,
  totals: `SELECT TABLE_SCHEMA, COUNT(*), COALESCE(SUM(DATA_LENGTH), 0), COALESCE(SUM(INDEX_LENGTH), 0), COALESCE(SUM(DATA_FREE), 0) FROM information_schema.TABLES WHERE TABLE_SCHEMA IN (${LIST}) AND TABLE_TYPE <> 'VIEW' GROUP BY TABLE_SCHEMA ORDER BY TABLE_SCHEMA`,
  // -1 marks a NULL the engine did not report; real sizes and row estimates are never negative.
  tables: `SELECT s, t, e, r, d, i, f FROM (SELECT TABLE_SCHEMA AS s, TABLE_NAME AS t, COALESCE(ENGINE, '') AS e, COALESCE(TABLE_ROWS, -1) AS r, COALESCE(DATA_LENGTH, -1) AS d, COALESCE(INDEX_LENGTH, -1) AS i, COALESCE(DATA_FREE, -1) AS f, ROW_NUMBER() OVER (PARTITION BY TABLE_SCHEMA ORDER BY COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0) DESC, TABLE_NAME) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA IN (${LIST}) AND TABLE_TYPE <> 'VIEW') ranked WHERE n <= ${INSIGHTS_TOP_TABLES} ORDER BY s, n`,
  /** user names and their host-entry count only; authentication columns are never selected. */
  users: `SELECT User, COUNT(*) FROM mysql.user WHERE User IN (${LIST}) GROUP BY User ORDER BY User`,
} as const
export type InsightsStatementKind = keyof typeof INSIGHTS_TEMPLATES

const NAME = /^[a-z][a-z0-9_]{0,63}$/
const QUOTED_LIST = /^'[a-z][a-z0-9_]{0,63}'(?:, '[a-z][a-z0-9_]{0,63}')*$/
const capOf = (kind: InsightsStatementKind): number => kind === 'users' ? INSIGHTS_MAX_USERS : INSIGHTS_MAX_DATABASES

export function accountDatabaseInsightsStatement(kind: InsightsStatementKind, names: readonly string[]): string {
  if (!Object.hasOwn(INSIGHTS_TEMPLATES, kind) || !Array.isArray(names) || names.length < 1 || names.length > capOf(kind) || names.some(name => typeof name !== 'string' || !NAME.test(name)) || new Set(names).size !== names.length) throw new Error('invalid_insights_names')
  return INSIGHTS_TEMPLATES[kind].replace(LIST, names.map(services.quoteString).join(', '))
}

/** Exact-text admission: a template with a bounded list of strict quoted names, nothing else. */
export function isAccountDatabaseInsightsStatement(statement: unknown): boolean {
  if (typeof statement !== 'string') return false
  return (Object.keys(INSIGHTS_TEMPLATES) as InsightsStatementKind[]).some(kind => {
    const [head, tail] = INSIGHTS_TEMPLATES[kind].split(LIST) as [string, string]
    if (statement.length <= head.length + tail.length || !statement.startsWith(head) || !statement.endsWith(tail)) return false
    const list = statement.slice(head.length, statement.length - tail.length), names = list.split(', ')
    return QUOTED_LIST.test(list) && names.length <= capOf(kind) && new Set(names).size === names.length
  })
}

export const admitInsights = (client: MariadbAdminClient): MariadbAdminSql => async statement => {
  if (!isAccountDatabaseInsightsStatement(statement)) return fail('VALIDATION', 'unreviewed database insights statement', { stateChanged: false })
  return client.query([statement])
}

const bad = (): never => { throw new Error('invalid_insights_observation') }
const count = (raw: string): number => /^(?:0|[1-9][0-9]{0,15})$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : bad()
const maybe = (raw: string): number | null => raw === '-1' ? null : count(raw)
const CHARSET = /^[a-z0-9_]{1,64}$/
const member = (raw: string, names: ReadonlySet<string>): string => names.has(raw) ? raw : bad()
const once = <T>(map: Map<string, T>, key: string, value: T): void => { if (map.has(key)) bad(); map.set(key, value) }

export interface InsightsSchemaRow { characterSet: string; collation: string }
export interface InsightsTotalsRow { tables: number; dataBytes: number; indexBytes: number; freeBytes: number }
export interface InsightsTable { name: string; engine: string | null; rows: number | null; dataBytes: number | null; indexBytes: number | null; freeBytes: number | null }

export function parseInsightsSchemas(stdout: string, names: ReadonlySet<string>): Map<string, InsightsSchemaRow> {
  const rows = new Map<string, InsightsSchemaRow>()
  for (const [name, charset, collation] of parseMariadbBatch(stdout, 3)) once(rows, member(name!, names), { characterSet: CHARSET.test(charset!) ? charset! : bad(), collation: CHARSET.test(collation!) ? collation! : bad() })
  return rows
}
export function parseInsightsTotals(stdout: string, names: ReadonlySet<string>): Map<string, InsightsTotalsRow> {
  const rows = new Map<string, InsightsTotalsRow>()
  for (const [name, tables, data, index, free] of parseMariadbBatch(stdout, 5)) once(rows, member(name!, names), { tables: count(tables!), dataBytes: count(data!), indexBytes: count(index!), freeBytes: count(free!) })
  return rows
}
export function parseInsightsTables(stdout: string, names: ReadonlySet<string>): Map<string, InsightsTable[]> {
  const rows = new Map<string, InsightsTable[]>()
  for (const [schema, table, engine, tableRows, data, index, free] of parseMariadbBatch(stdout, 7)) {
    const list = rows.get(member(schema!, names)) ?? []
    // Table identifiers are at most 64 characters (MariaDB "Identifier Names").
    if (!table || [...table].length > 64 || list.length >= INSIGHTS_TOP_TABLES || list.some(row => row.name === table) || engine !== '' && !/^[A-Za-z0-9_]{1,64}$/.test(engine!)) bad()
    list.push({ name: table!, engine: engine || null, rows: maybe(tableRows!), dataBytes: maybe(data!), indexBytes: maybe(index!), freeBytes: maybe(free!) })
    rows.set(schema!, list)
  }
  return rows
}
export function parseInsightsUsers(stdout: string, names: ReadonlySet<string>): Map<string, number> {
  const rows = new Map<string, number>()
  for (const [user, hosts] of parseMariadbBatch(stdout, 2)) { const n = count(hosts!); once(rows, member(user!, names), n >= 1 ? n : bad()) }
  return rows
}

const valid = (check: () => unknown): boolean => { try { check(); return true } catch { return false } }
/** Saved, non-trashed names of this account that pass the ownership grammar; nothing from the request is ever used. */
export function ownedInsightNames(account: Account, databases: readonly Database[], users: readonly DatabaseUser[]) {
  const dbs = [...new Set(databases.filter(db => db.accountId === account.id && db.trashedAt === null).map(db => db.name))].sort()
  const accountUsers = [...new Set(users.filter(user => user.accountId === account.id).map(user => user.name))].sort()
  const okDb = dbs.filter(name => NAME.test(name) && valid(() => assertDbNameOwned(account.username, name)))
  const okUser = accountUsers.filter(name => NAME.test(name) && valid(() => services.assertDbUser(name, account.username)))
  const databasesQueried = okDb.slice(0, INSIGHTS_MAX_DATABASES), usersQueried = okUser.slice(0, INSIGHTS_MAX_USERS)
  return { databases: databasesQueried, users: usersQueried, omitted: { databases: dbs.length - databasesQueried.length, users: accountUsers.length - usersQueried.length } }
}

export type InsightsServerState = 'present' | 'absent' | null
export interface AccountDatabaseInsightsView {
  context: { accountId: string; username: string }
  state: 'read' | 'partial' | 'unavailable'
  observedAt: string
  limits: { maxDatabases: number; maxUsers: number; tablesPerDatabase: number }
  omitted: { databases: number; users: number }
  databases: { name: string; server: InsightsServerState; characterSet: string | null; collation: string | null; tables: number | null; dataBytes: number | null; indexBytes: number | null; freeBytes: number | null; largestTables: InsightsTable[] | null }[]
  users: { name: string; server: InsightsServerState; hosts: number | null }[]
}

const attempt = async <T>(run: MariadbAdminSql | null, kind: InsightsStatementKind, names: readonly string[], parse: (stdout: string, names: ReadonlySet<string>) => T): Promise<T | null> => {
  if (!run) return null
  // Execution, credential and parse failures are all 'not observed'; server stderr never reaches the owner.
  try { return parse(await run(accountDatabaseInsightsStatement(kind, names)), new Set(names)) } catch { return null }
}

/** Sequential on purpose: each statement is one client process on a 1 vCPU host. */
export async function readAccountDatabaseInsights(run: MariadbAdminSql | null, account: Account, owned: ReturnType<typeof ownedInsightNames>, now: () => Date = () => new Date()): Promise<AccountDatabaseInsightsView> {
  const observedAt = now().toISOString(), names = owned.databases, people = owned.users
  const parts: unknown[] = []
  const track = <T>(value: T | null): T | null => { parts.push(value); return value }
  const schemas = names.length ? track(await attempt(run, 'schemas', names, parseInsightsSchemas)) : null
  const totals = names.length ? track(await attempt(run, 'totals', names, parseInsightsTotals)) : null
  const tables = names.length ? track(await attempt(run, 'tables', names, parseInsightsTables)) : null
  const users = people.length ? track(await attempt(run, 'users', people, parseInsightsUsers)) : null
  const state = !run ? 'unavailable' : parts.every(part => part !== null) ? 'read' : parts.every(part => part === null) ? 'unavailable' : 'partial'
  return {
    context: { accountId: account.id, username: account.username }, state, observedAt,
    limits: { maxDatabases: INSIGHTS_MAX_DATABASES, maxUsers: INSIGHTS_MAX_USERS, tablesPerDatabase: INSIGHTS_TOP_TABLES }, omitted: owned.omitted,
    databases: names.map(name => {
      // Without the schema list, a totals row still proves the schema exists; its absence proves nothing.
      const present = schemas ? schemas.has(name) : totals?.has(name) ? true : null
      const meta = schemas?.get(name), sum = present === true && totals ? totals.get(name) ?? { tables: 0, dataBytes: 0, indexBytes: 0, freeBytes: 0 } : null
      return { name, server: present === null ? null : present ? 'present' : 'absent', characterSet: meta?.characterSet ?? null, collation: meta?.collation ?? null,
        tables: sum?.tables ?? null, dataBytes: sum?.dataBytes ?? null, indexBytes: sum?.indexBytes ?? null, freeBytes: sum?.freeBytes ?? null,
        largestTables: present === true && tables ? tables.get(name) ?? [] : null }
    }),
    users: people.map(name => ({ name, server: users ? users.has(name) ? 'present' as const : 'absent' as const : null, hosts: users?.get(name) ?? null })),
  }
}

export interface AccountDatabaseInsightsRouteDeps {
  caller: AgentCallerIdentity
  store: { getAccountByUsername(username: string): Promise<Account | null>; getPlan(id: string): Promise<Plan | null>; getFeatureList(id: string): Promise<FeatureList | null>; listDatabases(accountId: string): Promise<Database[]>; listDatabaseUsers(accountId: string): Promise<DatabaseUser[]> }
  currentPrincipal(): Promise<{ kind: string; id: string; username: string; accountId: string | null; disabled: boolean } | null>
  /** The protected admin client; absent, every observation is reported unavailable. */
  mariadb?: MariadbAdminClient
  now?: () => Date
}
const ROUTE = /^\/accounts\/([a-z][a-z0-9]{0,15})\/database-insights$/

/** Owner read of their own databases and users; lifecycle-free, with a fresh principal and saved-name re-check after the reads. */
export async function handleAccountDatabaseInsightsRoute(_req: Request, url: URL, method: string, deps: AccountDatabaseInsightsRouteDeps): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  if (url.search) return fail('VALIDATION', 'database insights do not accept query selectors', { stateChanged: false })
  const username = match[1]!, caller = deps.caller
  if (caller.role !== 'user' || !caller.accountId) return fail('FORBIDDEN', 'database insights are read by the signed-in account owner', { stateChanged: false })
  const authorize = async () => {
    const account = await deps.store.getAccountByUsername(username), principal = await deps.currentPrincipal()
    if (!account || account.id !== caller.accountId || account.status !== 'active' || !principal || principal.disabled || principal.kind !== 'user' || principal.id !== caller.principalId || principal.accountId !== account.id || principal.username !== account.username) return fail('FORBIDDEN', 'the current account owner is not authorized', { stateChanged: false })
    const plan = await deps.store.getPlan(account.planId), features = plan ? await deps.store.getFeatureList(plan.featureListId) : null
    if (!features || features.disabled.includes(DATABASE_INSIGHTS_TOOL)) return fail('FORBIDDEN', 'database insights are disabled by the account plan', { stateChanged: false })
    return { account, owned: ownedInsightNames(account, await deps.store.listDatabases(account.id), await deps.store.listDatabaseUsers(account.id)) }
  }
  const first = await authorize()
  const view = await readAccountDatabaseInsights(deps.mariadb ? admitInsights(deps.mariadb) : null, first.account, first.owned, deps.now)
  // A revoked owner never receives the result; a database list that changed mid-read is not reported against stale names.
  const fresh = await authorize()
  if (fresh.account.id !== first.account.id || JSON.stringify(fresh.owned) !== JSON.stringify(first.owned)) return fail('CONFLICT', 'the saved databases changed while reading; read again', { stateChanged: false })
  return new Response(JSON.stringify(view), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}
