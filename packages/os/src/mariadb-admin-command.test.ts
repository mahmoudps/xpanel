import { describe, expect, it } from 'vitest'
import { MARIADB_ADMIN_ACCOUNTS_SQL, MARIADB_ADMIN_PROCESSLIST_SQL, MARIADB_ADMIN_SCHEMAS_SQL, MARIADB_ADMIN_STATUS_SQL, MARIADB_ADMIN_VARIABLES_SQL, MARIADB_ADMIN_VERSION_SQL, isMariadbAdminStatement, mariadbKillStatement } from './mariadb-admin-command.ts'

describe('MariaDB admin statement grammar', () => {
  it('admits only the fixed observation texts and validated KILL ids', () => {
    for (const sql of [MARIADB_ADMIN_VERSION_SQL, MARIADB_ADMIN_STATUS_SQL, MARIADB_ADMIN_VARIABLES_SQL, MARIADB_ADMIN_SCHEMAS_SQL, MARIADB_ADMIN_ACCOUNTS_SQL, MARIADB_ADMIN_PROCESSLIST_SQL, 'KILL QUERY 42', 'KILL CONNECTION 9007199254740991']) expect(isMariadbAdminStatement(sql)).toBe(true)
    for (const sql of ['', 'SELECT 1', MARIADB_ADMIN_VERSION_SQL + ';', ' ' + MARIADB_ADMIN_VERSION_SQL, 'KILL 42', 'KILL QUERY 0', 'KILL QUERY 042', 'KILL QUERY -1', 'KILL QUERY 1; DROP DATABASE x', 'KILL QUERY 1 ', 'kill query 1', 'KILL QUERY 99999999999999999', 'KILL CONNECTION 1.5', 'SHOW FULL PROCESSLIST', 'SELECT User, Host, Password FROM mysql.user', null, 42]) expect(isMariadbAdminStatement(sql)).toBe(false)
  })
  it('builds KILL only from a positive safe integer and a known mode', () => {
    expect(mariadbKillStatement('query', 7)).toBe('KILL QUERY 7')
    expect(mariadbKillStatement('connection', 8)).toBe('KILL CONNECTION 8')
    for (const id of [0, -1, 1.5, Number.NaN, 2 ** 53, '7', '7; DROP DATABASE x', null, undefined]) expect(() => mariadbKillStatement('query', id)).toThrow('invalid_thread_id')
    expect(() => mariadbKillStatement('all' as 'query', 7)).toThrow('invalid_kill_mode')
  })
  it('never selects query text or authentication material', () => {
    expect(MARIADB_ADMIN_PROCESSLIST_SQL).not.toMatch(/\bINFO\b/)
    expect(MARIADB_ADMIN_ACCOUNTS_SQL).not.toMatch(/Password|authentication_string|plugin|Priv/i)
    for (const sql of [MARIADB_ADMIN_SCHEMAS_SQL, MARIADB_ADMIN_ACCOUNTS_SQL, MARIADB_ADMIN_PROCESSLIST_SQL]) expect(sql).toMatch(/LIMIT 5001$/)
  })
})
