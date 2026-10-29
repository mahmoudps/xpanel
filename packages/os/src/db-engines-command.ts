/**
 * Reviewed database-engine command grammar for the root agent. Exact argv only: fixed binaries, fixed
 * flags and fixed SQL texts; the single variable input is an already validated account username or a
 * fixed-format backup file stamp. Package and unit reads reuse the software-center and service-manager
 * grammars; package upgrades reuse the package-manager grammar.
 */
export const DB_RUNUSER = '/usr/sbin/runuser'
export const DB_PSQL = '/usr/bin/psql'
export const DB_ADMIN_DEFAULTS_FILE = '/etc/xpanel/mariadb-admin.cnf'
export const DB_UPGRADE_BACKUP_DIR = '/var/backups/xpanel/mariadb-upgrade'
export const DB_MARIADB_UNITS = ['mariadb.service', 'mysql.service'] as const
export const DB_PG_MAX_ROWS = 1000
const ACCOUNT = /^[a-z][a-z0-9]{0,15}$/
const STAMP = /^[0-9]{8}T[0-9]{6}Z$/

/** psql(1): -X no psqlrc, -q quiet, -A unaligned, -t tuples only, -F field separator; ON_ERROR_STOP makes a failed statement exit 3. */
const PSQL_PREFIX = [DB_RUNUSER, '-u', 'postgres', '--', DB_PSQL, '-X', '-q', '-A', '-t', '-F', '\t', '-v', 'ON_ERROR_STOP=1', '-d', 'postgres', '-c'] as const
export const PG_VERSION_SQL = 'SHOW server_version'
// LIKE treats backslash as the default escape character, so `\_` is a literal underscore (standard_conforming_strings is on by default).
export const pgAccountDatabasesSql = (username: string): string => {
  if (!ACCOUNT.test(username)) throw new Error('invalid_account_username')
  return `SELECT d.datname, pg_catalog.pg_get_userbyid(d.datdba), pg_catalog.pg_database_size(d.oid) FROM pg_catalog.pg_database d WHERE NOT d.datistemplate AND d.datname LIKE '${username}\\_%' ORDER BY d.datname LIMIT ${DB_PG_MAX_ROWS + 1}`
}
export const pgAccountRolesSql = (username: string): string => {
  if (!ACCOUNT.test(username)) throw new Error('invalid_account_username')
  return `SELECT r.rolname, r.rolcanlogin FROM pg_catalog.pg_roles r WHERE r.rolname = '${username}' OR r.rolname LIKE '${username}\\_%' ORDER BY r.rolname LIMIT ${DB_PG_MAX_ROWS + 1}`
}
export const postgresqlQueryArgv = (sql: string): string[] => [...PSQL_PREFIX, sql]
/**
 * psql(1) running a reviewed statement script from stdin (`-f -`, needed for \gexec); VERBOSITY=terse keeps statement
 * text out of error output. Only the PostgreSQL SQL runner spawns it, so it is not admitted for runCommand.
 */
export const PSQL_SCRIPT_ARGV = [DB_RUNUSER, '-u', 'postgres', '--', DB_PSQL, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=terse', '-d', 'postgres', '-f', '-'] as const

/** install(1) creates the root-only directory before mariadb-dump writes its file with the process umask. */
export const DB_UPGRADE_BACKUP_DIR_ARGV = ['/usr/bin/install', '-d', '-m', '0700', '-o', 'root', '-g', 'root', '--', DB_UPGRADE_BACKUP_DIR] as const
export const dbUpgradeBackupFile = (stamp: string): string => {
  if (!STAMP.test(stamp)) throw new Error('invalid_backup_stamp')
  return `${DB_UPGRADE_BACKUP_DIR}/pre-upgrade-${stamp}.sql`
}
/** mariadb-dump(1): --defaults-extra-file must come first; --single-transaction gives a consistent InnoDB snapshot. */
export const mariadbUpgradeDumpArgv = (stamp: string): string[] => ['/usr/bin/mariadb-dump', `--defaults-extra-file=${DB_ADMIN_DEFAULTS_FILE}`, '--all-databases', '--single-transaction', '--routines', '--events', '--triggers', `--result-file=${dbUpgradeBackupFile(stamp)}`]
/** mariadb-upgrade(1) checks and updates system tables; it exits 0 and does nothing when already current. */
export const MARIADB_UPGRADE_ARGV = ['/usr/bin/mariadb-upgrade', `--defaults-extra-file=${DB_ADMIN_DEFAULTS_FILE}`] as const
/** systemctl(1) try-restart restarts a running unit and leaves a stopped one stopped. */
export const mariadbTryRestartArgv = (unit: string): string[] => {
  if (!(DB_MARIADB_UNITS as readonly string[]).includes(unit)) throw new Error('invalid_mariadb_unit')
  return ['/usr/bin/systemctl', 'try-restart', '--', unit]
}

const same = (argv: readonly unknown[], allowed: readonly string[]): boolean => argv.length === allowed.length && allowed.every((value, index) => argv[index] === value)
export function isDatabaseEngineCommand(argv: readonly unknown[]): boolean {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) return false
  if (same(argv, DB_UPGRADE_BACKUP_DIR_ARGV) || same(argv, MARIADB_UPGRADE_ARGV)) return true
  if (DB_MARIADB_UNITS.some(unit => same(argv, mariadbTryRestartArgv(unit)))) return true
  const dump = /^--result-file=\/var\/backups\/xpanel\/mariadb-upgrade\/pre-upgrade-([0-9]{8}T[0-9]{6}Z)\.sql$/.exec(String(argv.at(-1)))
  if (dump && same(argv, mariadbUpgradeDumpArgv(dump[1]!))) return true
  if (argv.length !== PSQL_PREFIX.length + 1 || !PSQL_PREFIX.every((value, index) => argv[index] === value)) return false
  const sql = argv.at(-1) as string
  if (sql === PG_VERSION_SQL) return true
  const account = /^SELECT (?:d\.datname|r\.rolname)[^']*'([a-z][a-z0-9]{0,15})(?:\\_%)?'/.exec(sql)?.[1]
  return !!account && (sql === pgAccountDatabasesSql(account) || sql === pgAccountRolesSql(account))
}
