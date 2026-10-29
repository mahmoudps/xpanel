/**
 * Reviewed root MariaDB administration statements. Only these exact texts, plus KILL with a
 * validated decimal thread id, are admitted; nothing caller-supplied is ever interpolated.
 * Row caps use LIMIT 5001 so the reader can tell a full result from a truncated one.
 */
export const MARIADB_ADMIN_MAX_ROWS = 5000
/** Created by MariaDB or the distribution package: never tenant drift and never killable. */
export const MARIADB_SYSTEM_USERS = ['root', 'mariadb.sys', 'mysql', 'mysql.sys', 'debian-sys-maint'] as const
export const MARIADB_SYSTEM_SCHEMAS = ['information_schema', 'mysql', 'performance_schema', 'sys'] as const
export const MARIADB_ADMIN_STATUS_NAMES = ['Uptime', 'Threads_connected', 'Threads_running', 'Connections', 'Max_used_connections', 'Aborted_connects', 'Questions', 'Slow_queries'] as const
export const MARIADB_ADMIN_VARIABLE_NAMES = ['port', 'socket', 'bind_address', 'skip_networking', 'max_connections'] as const
const names = (list: readonly string[]): string => list.map(name => `'${name}'`).join(', ')

export const MARIADB_ADMIN_VERSION_SQL = 'SELECT VERSION()'
export const MARIADB_ADMIN_STATUS_SQL = `SHOW GLOBAL STATUS WHERE Variable_name IN (${names(MARIADB_ADMIN_STATUS_NAMES)})`
export const MARIADB_ADMIN_VARIABLES_SQL = `SHOW GLOBAL VARIABLES WHERE Variable_name IN (${names(MARIADB_ADMIN_VARIABLE_NAMES)})`
/** Every schema, including empty ones, with table data+index bytes from information_schema.TABLES. */
export const MARIADB_ADMIN_SCHEMAS_SQL = 'SELECT s.SCHEMA_NAME, COALESCE(SUM(t.DATA_LENGTH + t.INDEX_LENGTH), 0), COUNT(t.TABLE_NAME) FROM information_schema.SCHEMATA s LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME GROUP BY s.SCHEMA_NAME ORDER BY s.SCHEMA_NAME LIMIT 5001'
/** user@host and the role flag only; authentication columns are never selected. */
export const MARIADB_ADMIN_ACCOUNTS_SQL = 'SELECT User, Host, is_role FROM mysql.user ORDER BY User, Host LIMIT 5001'
/** INFO (query text) is deliberately omitted. The last two columns flag this session and the admin account. */
export const MARIADB_ADMIN_PROCESSLIST_SQL = "SELECT ID, USER, HOST, COALESCE(DB, ''), COMMAND, TIME, COALESCE(STATE, ''), ID = CONNECTION_ID(), USER = SUBSTRING(CURRENT_USER(), 1, CHAR_LENGTH(CURRENT_USER()) - CHAR_LENGTH(SUBSTRING_INDEX(CURRENT_USER(), '@', -1)) - 1) FROM information_schema.PROCESSLIST ORDER BY ID LIMIT 5001"

const FIXED = new Set<string>([MARIADB_ADMIN_VERSION_SQL, MARIADB_ADMIN_STATUS_SQL, MARIADB_ADMIN_VARIABLES_SQL, MARIADB_ADMIN_SCHEMAS_SQL, MARIADB_ADMIN_ACCOUNTS_SQL, MARIADB_ADMIN_PROCESSLIST_SQL])
const KILL = /^KILL (QUERY|CONNECTION) ([1-9][0-9]{0,15})$/

export type MariadbKillMode = 'query' | 'connection'
export const isMariadbThreadId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1

export function mariadbKillStatement(mode: MariadbKillMode, id: unknown): string {
  if (mode !== 'query' && mode !== 'connection') throw new Error('invalid_kill_mode')
  if (!isMariadbThreadId(id)) throw new Error('invalid_thread_id')
  return `KILL ${mode === 'query' ? 'QUERY' : 'CONNECTION'} ${id}`
}

export function isMariadbAdminStatement(statement: unknown): boolean {
  if (typeof statement !== 'string') return false
  if (FIXED.has(statement)) return true
  const kill = KILL.exec(statement)
  return !!kill && isMariadbThreadId(Number(kill[2]))
}
