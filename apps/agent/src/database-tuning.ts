import { fail } from '@xpanel/core'
import { MARIADB_ADMIN_VERSION_SQL } from '../../../packages/os/src/mariadb-admin-command.ts'
import { parseMariadbBatch, parseMariadbVersion } from './mariadb-admin.ts'
import type { MariadbAdminClient, MariadbAdminSql } from './mariadb-admin.ts'
import type { AgentCallerIdentity } from './server.ts'

export const DATABASE_TUNING_VARIABLES = ['innodb_buffer_pool_size', 'max_connections', 'tmp_table_size', 'max_heap_table_size', 'table_open_cache', 'thread_cache_size', 'slow_query_log', 'long_query_time'] as const
export const DATABASE_TUNING_STATUS = ['Uptime', 'Uptime_since_flush_status', 'Threads_connected', 'Threads_running', 'Max_used_connections', 'Connections', 'Aborted_connects', 'Connection_errors_max_connections', 'Slow_queries', 'Questions', 'Innodb_buffer_pool_reads', 'Innodb_buffer_pool_read_requests', 'Created_tmp_disk_tables', 'Created_tmp_tables', 'Open_tables', 'Opened_tables', 'Threads_created'] as const
export const DATABASE_TUNING_VARIABLES_SQL = `SHOW GLOBAL VARIABLES WHERE Variable_name IN (${DATABASE_TUNING_VARIABLES.map(name => `'${name}'`).join(', ')})`
export const DATABASE_TUNING_STATUS_SQL = `SHOW GLOBAL STATUS WHERE Variable_name IN (${DATABASE_TUNING_STATUS.map(name => `'${name}'`).join(', ')})`
export type DatabaseTuningVariables = Record<Exclude<typeof DATABASE_TUNING_VARIABLES[number], 'slow_query_log'>, number> & { slow_query_log: 'ON' | 'OFF' }
export type DatabaseTuningStatus = Record<typeof DATABASE_TUNING_STATUS[number], number>
export type DatabaseTuningCheckId = 'connections' | 'buffer-pool' | 'temporary-tables' | 'slow-log' | 'table-cache' | 'thread-cache'
export type DatabaseTuningNext = 'review-connections' | 'sample-buffer-pool' | 'sample-temporary-tables' | 'review-slow-log' | 'sample-table-cache' | 'sample-thread-cache' | 'read-again'
export interface DatabaseTuningCheck { id: DatabaseTuningCheckId; state: 'review' | 'observe' | 'unavailable'; evidence: { name: string; value: number | string }[]; next: DatabaseTuningNext }
export interface DatabaseTuningObservation {
  engine: 'mariadb'; state: 'read' | 'partial' | 'unavailable'; observedAt: string | null; version: string | null
  variables: DatabaseTuningVariables | null; status: DatabaseTuningStatus | null
}
export interface DatabaseTuningView extends DatabaseTuningObservation {
  plan: { kind: 'advisory'; state: 'ready' | 'unavailable'; checks: DatabaseTuningCheck[] }
  capabilities: { apply: false }
}

const invalid = (): never => { throw new Error('invalid_database_tuning_observation') }
const integer = (raw: string): number => /^(?:0|[1-9][0-9]{0,15})$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : invalid()
const number = (raw: string): number => /^(?:0|[1-9][0-9]{0,7})(?:\.[0-9]{1,6})?$/.test(raw) && Number.isFinite(Number(raw)) ? Number(raw) : invalid()
const names = <N extends string>(stdout: string, expected: readonly N[]): Map<N, string> => {
  const result = new Map<N, string>()
  // MariaDB SHOW GLOBAL returns one tab-separated name/value row per variable (mariadb(1) --batch).
  for (const [name, value] of parseMariadbBatch(stdout, 2)) {
    if (!(expected as readonly string[]).includes(name!) || result.has(name as N)) return invalid()
    result.set(name as N, value!)
  }
  return result.size === expected.length ? result : invalid()
}
export function parseDatabaseTuningVariables(stdout: string): DatabaseTuningVariables {
  const rows = names(stdout, DATABASE_TUNING_VARIABLES)
  const result = Object.fromEntries([...rows].map(([name, raw]) => [name, name === 'slow_query_log' ? (raw === 'ON' || raw === 'OFF' ? raw : invalid()) : name === 'long_query_time' ? number(raw) : integer(raw)])) as DatabaseTuningVariables
  return result.max_connections > 0 ? result : invalid()
}
export function parseDatabaseTuningStatus(stdout: string): DatabaseTuningStatus {
  return Object.fromEntries([...names(stdout, DATABASE_TUNING_STATUS)].map(([name, raw]) => [name, integer(raw)])) as DatabaseTuningStatus
}
export function isDatabaseTuningStatement(statement: unknown): boolean {
  return statement === MARIADB_ADMIN_VERSION_SQL || statement === DATABASE_TUNING_VARIABLES_SQL || statement === DATABASE_TUNING_STATUS_SQL
}
export const admitDatabaseTuning = (client: MariadbAdminClient): MariadbAdminSql => async statement => {
  if (!isDatabaseTuningStatement(statement)) return fail('VALIDATION', 'unreviewed database tuning statement', { stateChanged: false })
  return client.query([statement])
}
const stateOf = (parts: readonly unknown[]): DatabaseTuningObservation['state'] => parts.every(part => part !== null) ? 'read' : parts.every(part => part === null) ? 'unavailable' : 'partial'

/** Counters describe the current status interval, not rates or a workload-specific optimal configuration. */
export function buildDatabaseTuningView(observation: DatabaseTuningObservation): DatabaseTuningView {
  const v = observation.variables, s = observation.status
  const check = (id: DatabaseTuningCheckId, next: DatabaseTuningNext, keys: readonly string[], review = false): DatabaseTuningCheck => {
    const values = { ...v, ...s }
    const available = keys.every(key => Object.hasOwn(values, key))
    return { id, state: !available ? 'unavailable' : review ? 'review' : 'observe', evidence: available ? keys.map(name => ({ name, value: values[name as keyof typeof values]! })) : [], next: available ? next : 'read-again' }
  }
  const checks: DatabaseTuningCheck[] = [
    check('connections', 'review-connections', ['max_connections', 'Threads_connected', 'Max_used_connections', 'Connection_errors_max_connections', 'Aborted_connects'], !!s && s.Connection_errors_max_connections > 0),
    check('buffer-pool', 'sample-buffer-pool', ['innodb_buffer_pool_size', 'Innodb_buffer_pool_reads', 'Innodb_buffer_pool_read_requests']),
    check('temporary-tables', 'sample-temporary-tables', ['tmp_table_size', 'max_heap_table_size', 'Created_tmp_disk_tables', 'Created_tmp_tables'], !!s && s.Created_tmp_disk_tables > 0),
    check('slow-log', 'review-slow-log', ['slow_query_log', 'long_query_time', 'Slow_queries'], v?.slow_query_log === 'OFF'),
    check('table-cache', 'sample-table-cache', ['table_open_cache', 'Open_tables', 'Opened_tables']),
    check('thread-cache', 'sample-thread-cache', ['thread_cache_size', 'Threads_created', 'Connections']),
  ]
  return { ...observation, plan: { kind: 'advisory', state: checks.some(row => row.state !== 'unavailable') ? 'ready' : 'unavailable', checks }, capabilities: { apply: false } }
}

export async function readDatabaseTuning(run: MariadbAdminSql | null, authorize: () => Promise<void> = async () => undefined, now: () => Date = () => new Date()): Promise<DatabaseTuningView> {
  const attempt = async <T>(sql: string, parse: (stdout: string) => T): Promise<T | null> => {
    if (!run) return null
    let result: T | null = null
    try { result = parse(await run(sql)) } catch { /* Credentials, stderr and partial output are never exposed. */ }
    // Keep revocation failures outside the observation-error catch.
    await authorize()
    return result
  }
  // Each statement starts one protected client process; keep reads sequential.
  const version = await attempt(MARIADB_ADMIN_VERSION_SQL, parseMariadbVersion)
  const variables = await attempt(DATABASE_TUNING_VARIABLES_SQL, parseDatabaseTuningVariables)
  const status = await attempt(DATABASE_TUNING_STATUS_SQL, parseDatabaseTuningStatus)
  await authorize()
  return buildDatabaseTuningView({ engine: 'mariadb', state: stateOf([version, variables, status]), observedAt: now().toISOString(), version, variables, status })
}

const object = (raw: unknown): raw is Record<string, unknown> => !!raw && typeof raw === 'object' && !Array.isArray(raw)
const exact = (raw: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(raw).length === keys.length && keys.every(key => Object.hasOwn(raw, key))
const safeCount = (raw: unknown): raw is number => typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0
/** Project only the known observation; a provider cannot inject a plan or claim mutation support. */
export function projectDatabaseTuningView(raw: unknown): DatabaseTuningView {
  if (!object(raw) || !exact(raw, ['engine', 'state', 'observedAt', 'version', 'variables', 'status', 'plan', 'capabilities']) || raw.engine !== 'mariadb'
    || typeof raw.observedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw.observedAt) || !Number.isFinite(Date.parse(raw.observedAt))
    || raw.version !== null && (typeof raw.version !== 'string' || !/^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,4}[0-9A-Za-z.+_~-]{0,96}$/.test(raw.version))
    || raw.variables !== null && (!object(raw.variables) || !exact(raw.variables, DATABASE_TUNING_VARIABLES) || DATABASE_TUNING_VARIABLES.some(key => key === 'slow_query_log' ? !['ON', 'OFF'].includes(String((raw.variables as Record<string, unknown>)[key])) : key === 'long_query_time' ? typeof (raw.variables as Record<string, unknown>)[key] !== 'number' || !Number.isFinite((raw.variables as Record<string, number>)[key]) || (raw.variables as Record<string, number>)[key]! < 0 : !safeCount((raw.variables as Record<string, unknown>)[key])) || (raw.variables as Record<string, number>).max_connections! <= 0)
    || raw.status !== null && (!object(raw.status) || !exact(raw.status, DATABASE_TUNING_STATUS) || DATABASE_TUNING_STATUS.some(key => !safeCount((raw.status as Record<string, unknown>)[key])))
    || raw.state !== stateOf([raw.version, raw.variables, raw.status]) || !object(raw.capabilities) || !exact(raw.capabilities, ['apply']) || raw.capabilities.apply !== false) return invalid()
  const view = buildDatabaseTuningView({ engine: 'mariadb', state: raw.state as DatabaseTuningObservation['state'], observedAt: raw.observedAt, version: raw.version as string | null, variables: raw.variables as DatabaseTuningVariables | null, status: raw.status as DatabaseTuningStatus | null })
  if (JSON.stringify(raw.plan) !== JSON.stringify(view.plan)) return invalid()
  return view
}

export interface DatabaseTuningRouteContext {
  caller: AgentCallerIdentity; reauthenticate(): Promise<AgentCallerIdentity>; assertRoot(caller: AgentCallerIdentity, action: string): Promise<void>
  mariadb?: MariadbAdminClient; now?: () => Date
}
export async function handleDatabaseTuningRoute(_req: Request, url: URL, method: string, ctx: DatabaseTuningRouteContext): Promise<Response | null> {
  if (url.pathname !== '/host/databases/tuning') return null
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  if (url.search) return fail('VALIDATION', 'database tuning does not accept selectors or statements', { stateChanged: false })
  const authorize = async (): Promise<void> => {
    const fresh = await ctx.reauthenticate()
    await ctx.assertRoot(fresh, 'host.databases.tuning.read')
    if (fresh.principalId !== ctx.caller.principalId || fresh.actor !== ctx.caller.actor) return fail('FORBIDDEN', 'database tuning authority changed', { stateChanged: false })
  }
  await ctx.assertRoot(ctx.caller, 'host.databases.tuning.read')
  await authorize()
  const view = await readDatabaseTuning(ctx.mariadb ? admitDatabaseTuning(ctx.mariadb) : null, authorize, ctx.now)
  return new Response(JSON.stringify(view), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}
