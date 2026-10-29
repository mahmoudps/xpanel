import { fail, isXpanelError } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import { authorizeAccountOwner, workspaceJson } from './account-ssh-workspace.ts'
import type { AccountSshPorts } from './account-ssh-workspace.ts'
import { DATABASE_INSIGHTS_TOOL, INSIGHTS_MAX_DATABASES, INSIGHTS_MAX_USERS, INSIGHTS_TOP_TABLES } from '../../agent/src/account-database-insights.ts'
import type { AccountDatabaseInsightsView } from '../../agent/src/account-database-insights.ts'

export const ACCOUNT_DATABASE_INSIGHTS_PATH = '/api/account/database-insights'
export type AccountDatabaseInsightsPorts = AccountSshPorts

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>, expected: readonly string[]): boolean => Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key))
const size = (value: unknown, min = 0): boolean => value === null || typeof value === 'number' && Number.isSafeInteger(value) && value >= min
const SERVER = [null, 'present', 'absent']
const CHARSET = /^[a-z0-9_]{1,64}$/
const TABLE_NAME = (value: unknown): boolean => typeof value === 'string' && value.length > 0 && [...value].length <= 64 && value.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/u.test(value)

/** Pins the agent reply to the signed-in account and to names it owns in saved state, with the documented bounds. */
export function validateAccountDatabaseInsightsView(raw: unknown, account: Account, databases: ReadonlySet<string>, users: ReadonlySet<string>): AccountDatabaseInsightsView {
  const bad = (): never => fail('CONFIG_TEST_FAILED', 'protected database insights reply is invalid')
  if (!object(raw) || !keys(raw, ['context', 'state', 'observedAt', 'limits', 'omitted', 'databases', 'users']) || !object(raw.context) || !keys(raw.context, ['accountId', 'username']) || raw.context.accountId !== account.id || raw.context.username !== account.username
    || !['read', 'partial', 'unavailable'].includes(raw.state as string) || typeof raw.observedAt !== 'string' || raw.observedAt.length > 64 || !Number.isFinite(Date.parse(raw.observedAt))
    || !object(raw.limits) || !keys(raw.limits, ['maxDatabases', 'maxUsers', 'tablesPerDatabase']) || raw.limits.maxDatabases !== INSIGHTS_MAX_DATABASES || raw.limits.maxUsers !== INSIGHTS_MAX_USERS || raw.limits.tablesPerDatabase !== INSIGHTS_TOP_TABLES
    || !object(raw.omitted) || !keys(raw.omitted, ['databases', 'users']) || raw.omitted.databases === null || !size(raw.omitted.databases) || raw.omitted.users === null || !size(raw.omitted.users)
    || !Array.isArray(raw.databases) || raw.databases.length > INSIGHTS_MAX_DATABASES || !Array.isArray(raw.users) || raw.users.length > INSIGHTS_MAX_USERS) return bad()
  const seen = new Set<string>()
  for (const row of raw.databases) {
    if (!object(row) || !keys(row, ['name', 'server', 'characterSet', 'collation', 'tables', 'dataBytes', 'indexBytes', 'freeBytes', 'largestTables']) || typeof row.name !== 'string' || !databases.has(row.name) || seen.has(row.name) || !SERVER.includes(row.server as string | null)
      || ![row.characterSet, row.collation].every(value => value === null || typeof value === 'string' && CHARSET.test(value)) || ![row.tables, row.dataBytes, row.indexBytes, row.freeBytes].every(value => size(value))
      || row.server !== 'present' && (row.tables !== null || row.largestTables !== null || row.characterSet !== null) || !(row.largestTables === null || Array.isArray(row.largestTables) && row.largestTables.length <= INSIGHTS_TOP_TABLES)) return bad()
    seen.add(row.name)
    const names = new Set<string>()
    for (const table of (row.largestTables ?? []) as unknown[]) {
      if (!object(table) || !keys(table, ['name', 'engine', 'rows', 'dataBytes', 'indexBytes', 'freeBytes']) || !TABLE_NAME(table.name) || names.has(table.name as string) || !(table.engine === null || typeof table.engine === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(table.engine))
        || ![table.rows, table.dataBytes, table.indexBytes, table.freeBytes].every(value => size(value))) return bad()
      names.add(table.name as string)
    }
  }
  seen.clear()
  for (const row of raw.users) {
    if (!object(row) || !keys(row, ['name', 'server', 'hosts']) || typeof row.name !== 'string' || !users.has(row.name) || seen.has(row.name) || !SERVER.includes(row.server as string | null) || !size(row.hosts, 1) || (row.server === 'present') !== (row.hosts !== null)) return bad()
    seen.add(row.name)
  }
  return raw as unknown as AccountDatabaseInsightsView
}

/** GET only. Names come from the session account's saved state; the browser never names a schema. */
export async function handleAccountDatabaseInsightsRoute(req: Request, url: URL, method: string, ports: AccountDatabaseInsightsPorts): Promise<Response | null> {
  if (url.pathname !== ACCOUNT_DATABASE_INSIGHTS_PATH) return null
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  if (url.search) return fail('VALIDATION', 'database insights do not accept selectors', { stateChanged: false })
  const { caller, account } = await authorizeAccountOwner(ports, req, [DATABASE_INSIGHTS_TOOL], 'Database insights')
  const raw = await ports.readAgent(caller, '/accounts/' + account.username + '/database-insights')
  const databases = new Set((await ports.store.listDatabases(account.id)).filter(db => db.accountId === account.id).map(db => db.name))
  const users = new Set((await ports.store.listDatabaseUsers(account.id)).filter(user => user.accountId === account.id).map(user => user.name))
  try { return workspaceJson(validateAccountDatabaseInsightsView(raw, account, databases, users)) }
  catch (error) { if (isXpanelError(error) && error.code !== 'CONFIG_TEST_FAILED') throw error; return fail('SERVICE_UNAVAILABLE', 'the protected database insights read could not be verified', { stateChanged: false }) }
}
