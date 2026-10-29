import { describe, expect, it } from 'vitest'
import { DB_UPGRADE_BACKUP_DIR_ARGV, MARIADB_UPGRADE_ARGV, PG_VERSION_SQL, PSQL_SCRIPT_ARGV, isDatabaseEngineCommand, mariadbTryRestartArgv, mariadbUpgradeDumpArgv, pgAccountDatabasesSql, pgAccountRolesSql, postgresqlQueryArgv } from './db-engines-command.ts'

describe('database engine command grammar', () => {
  it('admits only the exact reviewed argv', () => {
    for (const argv of [postgresqlQueryArgv(PG_VERSION_SQL), postgresqlQueryArgv(pgAccountDatabasesSql('alice')), postgresqlQueryArgv(pgAccountRolesSql('bob2')), [...DB_UPGRADE_BACKUP_DIR_ARGV], [...MARIADB_UPGRADE_ARGV], mariadbTryRestartArgv('mariadb.service'), mariadbUpgradeDumpArgv('20261028T101500Z')]) expect(isDatabaseEngineCommand(argv)).toBe(true)
    expect(pgAccountDatabasesSql('alice')).toContain("LIKE 'alice\\_%'")
  })
  it('refuses injected SQL, other users, binaries, units and backup paths', () => {
    const psql = postgresqlQueryArgv(PG_VERSION_SQL)
    for (const argv of [
      [...psql.slice(0, -1), 'SELECT 1'], [...psql.slice(0, -1), pgAccountDatabasesSql('alice').replace('LIMIT 1001', 'LIMIT 1001; DROP DATABASE x')], [...psql.slice(0, -1), pgAccountRolesSql('alice').replace("'alice'", "'alice' OR true")],
      psql.map(item => item === 'postgres' ? 'root' : item), ['/usr/bin/systemctl', 'try-restart', '--', 'nginx.service'], mariadbUpgradeDumpArgv('20261028T101500Z').map(item => item.replace('pre-upgrade-', '../pre-upgrade-')),
      [...mariadbUpgradeDumpArgv('20261028T101500Z'), '--no-data'], ['/usr/bin/mariadb-upgrade'], [1 as unknown as string], [...PSQL_SCRIPT_ARGV],
    ]) expect(isDatabaseEngineCommand(argv)).toBe(false)
    expect(() => pgAccountDatabasesSql("a'b")).toThrow(); expect(() => mariadbUpgradeDumpArgv('../x')).toThrow(); expect(() => mariadbTryRestartArgv('sshd.service')).toThrow()
  })
})
