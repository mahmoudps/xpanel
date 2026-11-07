import { DB_RUNUSER, postgresqlQueryArgv } from './db-engines-command.ts'

/**
 * Reviewed grammar of the WHM database service tools (Redis, MongoDB, PostgreSQL and phpMyAdmin access).
 * Fixed binaries, fixed units and fixed paths; a variable is a port, a stamped file name or a checked database name.
 * Passwords never reach argv: redis and mongod are spoken to over a socket, and the MongoDB tools read a root-only file.
 */
export const DB_SERVICE_SYSTEMCTL = '/usr/bin/systemctl'
export const DB_SERVICE_INSTALL = '/usr/bin/install'
export const DB_SERVICE_RM = '/usr/bin/rm'
export const MONGODUMP = '/usr/bin/mongodump'
export const MONGORESTORE = '/usr/bin/mongorestore'
export const MONGO_ADMIN_USER = 'xpanel-admin'
export const MONGO_ADMIN_FILE = '/etc/xpanel/mongodb-admin.json'
/** mongodump(1) --config: a YAML file whose password key keeps the secret out of argv. */
export const MONGO_TOOLS_CONFIG = '/etc/xpanel/mongodb-tools.yaml'
export const REDIS_BACKUP_DIR = '/var/backups/xpanel/redis'
export const MONGO_BACKUP_DIR = '/var/backups/xpanel/mongodb'
export const PG_BACKUP_DIR = '/var/backups/xpanel/postgresql'
export const PG_DROP_CLUSTER = '/usr/bin/pg_dropcluster'
export const PG_UPGRADE_CLUSTER = '/usr/bin/pg_upgradecluster'
/** postgresql-NN names to ask the repositories about; PGDG and distributions keep to this range today. */
export const PG_MAJORS: readonly number[] = [13, 14, 15, 16, 17, 18]
export const DB_SERVICE_ACTIONS = ['start', 'stop', 'restart', 'reload', 'enable', 'disable'] as const
export type DbServiceAction = typeof DB_SERVICE_ACTIONS[number]

const UNIT = /^(?:redis-server|redis|valkey-server|valkey|mongod|postgresql|postgresql@[0-9]{2}-main)\.service$/
const REDIS_FILE = /^redis-[0-9]{8}T[0-9]{6}Z\.rdb$/
const MONGO_FILE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}\.archive\.gz$/
const REDIS_DATA = /^\/var\/lib\/(?:redis|valkey)(?:\/[a-z0-9_-]{1,64})?\/[A-Za-z0-9_-]{1,64}\.rdb$/
export const MONGO_DATABASE = /^[a-z][a-z0-9_]{0,62}$/
export const isRedisBackupName = (name: unknown): name is string => typeof name === 'string' && REDIS_FILE.test(name)
export const isMongoBackupName = (name: unknown): name is string => typeof name === 'string' && MONGO_FILE.test(name)
export const isRedisDataFile = (path: unknown): path is string => typeof path === 'string' && REDIS_DATA.test(path) && !path.includes('..')
export const isDbServiceUnit = (unit: unknown): unit is string => typeof unit === 'string' && UNIT.test(unit)
const port = (value: number): string => { if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('invalid_port'); return String(value) }

export const dbServiceControlArgv = (action: DbServiceAction, unit: string): string[] => {
  if (!DB_SERVICE_ACTIONS.includes(action) || !isDbServiceUnit(unit)) throw new Error('invalid_database_service')
  return [DB_SERVICE_SYSTEMCTL, action, '--', unit]
}
export const dbBackupDirArgv = (directory: typeof REDIS_BACKUP_DIR | typeof MONGO_BACKUP_DIR): string[] => [DB_SERVICE_INSTALL, '-d', '-m', '0700', '-o', 'root', '-g', 'root', '--', directory]
export const redisBackupCopyArgv = (source: string, name: string): string[] => {
  if (!isRedisDataFile(source) || !isRedisBackupName(name)) throw new Error('invalid_redis_backup')
  return [DB_SERVICE_INSTALL, '-m', '0600', '-o', 'root', '-g', 'root', '--', source, `${REDIS_BACKUP_DIR}/${name}`]
}
export const redisRestoreCopyArgv = (name: string, target: string, owner: 'redis' | 'valkey'): string[] => {
  if (!isRedisBackupName(name) || !isRedisDataFile(target) || owner !== 'redis' && owner !== 'valkey') throw new Error('invalid_redis_backup')
  return [DB_SERVICE_INSTALL, '-m', '0640', '-o', owner, '-g', owner, '--', `${REDIS_BACKUP_DIR}/${name}`, target]
}
export const dbBackupRemoveArgv = (engine: 'redis' | 'mongodb', name: string): string[] => {
  if (engine === 'redis' ? !isRedisBackupName(name) : !isMongoBackupName(name)) throw new Error('invalid_database_backup')
  return [DB_SERVICE_RM, '-f', '--', `${engine === 'redis' ? REDIS_BACKUP_DIR : MONGO_BACKUP_DIR}/${name}`]
}
const mongoAuth = (value: number): string[] => [`--config=${MONGO_TOOLS_CONFIG}`, '--host=127.0.0.1', `--port=${port(value)}`, `--username=${MONGO_ADMIN_USER}`, '--authenticationDatabase=admin']
export const mongodumpArgv = (mongoPort: number, name: string, database: string | null): string[] => {
  if (!isMongoBackupName(name) || database !== null && !MONGO_DATABASE.test(database)) throw new Error('invalid_mongodb_backup')
  return [MONGODUMP, ...mongoAuth(mongoPort), `--archive=${MONGO_BACKUP_DIR}/${name}`, '--gzip', ...(database ? [`--db=${database}`] : [])]
}
export const mongorestoreArgv = (mongoPort: number, name: string): string[] => {
  if (!isMongoBackupName(name)) throw new Error('invalid_mongodb_backup')
  return [MONGORESTORE, ...mongoAuth(mongoPort), `--archive=${MONGO_BACKUP_DIR}/${name}`, '--gzip', '--drop']
}

// current_setting() reports the paths the running server really uses, on Debian and EL alike.
export const PG_SERVICE_FILES_SQL = "SELECT current_setting('config_file'), current_setting('hba_file'), current_setting('data_directory'), current_setting('server_version_num'), COALESCE(pg_catalog.pg_current_logfile(), '')"
export const PG_SERVICE_SETTING_NAMES = ['effective_cache_size', 'log_min_duration_statement', 'maintenance_work_mem', 'max_connections', 'port', 'shared_buffers', 'work_mem'] as const
export const PG_SERVICE_SETTINGS_SQL = `SELECT name, setting, COALESCE(unit, ''), pending_restart FROM pg_catalog.pg_settings WHERE name IN (${PG_SERVICE_SETTING_NAMES.map(name => `'${name}'`).join(', ')}) ORDER BY name`
// The view parses the file on disk, so an edit is checked before the server loads it.
export const PG_HBA_ERRORS_SQL = "SELECT line_number, error FROM pg_catalog.pg_hba_file_rules WHERE error IS NOT NULL ORDER BY line_number LIMIT 5"
export const PG_PING_SQL = 'SELECT 1'
export const PG_DATABASES_SQL = 'SELECT datname FROM pg_catalog.pg_database WHERE NOT datistemplate ORDER BY 1'
const PG_SQL: readonly string[] = [PG_SERVICE_FILES_SQL, PG_SERVICE_SETTINGS_SQL, PG_HBA_ERRORS_SQL, PG_PING_SQL, PG_DATABASES_SQL]
const PG_DATA = /^(?:\/var\/lib\/postgresql\/[0-9]{2}\/main|\/var\/lib\/pgsql\/data)$/
// A moved data directory: lowercase path parts under roots that hold no account or panel state.
const PG_MOVED = /^\/(?:srv|data|mnt|opt|var\/lib)\/(?!xpanel)(?:[a-z0-9_-][a-z0-9._-]{0,63}\/){0,6}[a-z0-9_-][a-z0-9._-]{0,63}$/
export const isPostgresqlDataPath = (path: unknown): path is string => typeof path === 'string' && (PG_DATA.test(path) || PG_MOVED.test(path) && !path.split('/').includes('..'))
const VERSION = /^[A-Za-z0-9][A-Za-z0-9.+~:_-]{0,127}$/
const PACKAGE = /^[A-Za-z0-9][A-Za-z0-9+._-]{0,63}$/
const CONF_OPTIONS = ['-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold'] as const
export const versionSpecs = (family: 'debian' | 'rhel', names: readonly string[], version: string): string[] => {
  if (!VERSION.test(version) || !names.every(name => PACKAGE.test(name))) throw new Error('invalid_package_version')
  return names.map(name => family === 'debian' ? `${name}=${version}` : `${name}-${version}`)
}
/** apt-get(8) --allow-downgrades lets one exact version go in either direction; dnf(8) install does that for a full version. */
export const versionInstallArgv = (family: 'debian' | 'rhel', specs: readonly string[]): string[] => family === 'debian' ? ['/usr/bin/apt-get', 'install', '-y', '-q', '--allow-downgrades', '--no-install-recommends', ...CONF_OPTIONS, '--', ...specs] : ['/usr/bin/dnf', '-y', '-q', 'install', '--', ...specs]
/** Both versions are on disk before anything changes, so a rollback needs no network. */
export const versionFetchArgv = (family: 'debian' | 'rhel', specs: readonly string[], installed: boolean): string[] => family === 'debian' ? ['/usr/bin/apt-get', 'install', '-y', '-q', '-d', ...(installed ? ['--reinstall'] : []), '--allow-downgrades', '--no-install-recommends', '--', ...specs] : ['/usr/bin/dnf', '-y', '-q', '--downloadonly', installed ? 'reinstall' : 'install', '--', ...specs]
export const dnfVersionListArgv = (name: string): string[] => { if (name !== 'redis' && name !== 'valkey') throw new Error('invalid_package_name'); return ['/usr/bin/dnf', '-q', 'list', '--showduplicates', '--available', name] }
export const dnfModuleListArgv = (): string[] => ['/usr/bin/dnf', '-q', 'module', 'list', 'postgresql']
export const dnfModuleArgv = (verb: 'reset' | 'enable', target: string): string[] => ['/usr/bin/dnf', '-y', '-q', 'module', verb, target]
export const dbDataSizeArgv = (data: string): string[] => { if (!isPostgresqlDataPath(data)) throw new Error('invalid_postgresql_data'); return ['/usr/bin/du', '-sk', '--', data] }
const PG_BINARY = /^(?:\/usr\/lib\/postgresql\/[0-9]{2}\/bin\/postgres|\/usr\/bin\/postgres)$/
/**
 * postgres(1) -C reads the whole configuration and exits, also beside a running server. pg_file_settings cannot do this:
 * it reports a valid value that waits for a restart and an invalid one with the same text.
 */
export const pgConfigCheckArgv = (binary: string, data: string, config: string): string[] => {
  if (!PG_BINARY.test(binary) || !isPostgresqlDataPath(data) || !isPostgresqlConfigPath(config)) throw new Error('invalid_postgresql_check')
  return [DB_RUNUSER, '-u', 'postgres', '--', binary, '-D', data, '-c', `config_file=${config}`, '-C', 'port']
}

const PG_FILE = /^\/etc\/postgresql\/[0-9]{2}\/main\/(?:postgresql|pg_hba)\.conf$/
const PG_START = /^\/etc\/postgresql\/[0-9]{2}\/main\/start\.conf$/
/** The Debian /etc tree, or a file directly in a data directory, wherever that directory was moved to. */
export const isPostgresqlConfigPath = (path: unknown): path is string => {
  if (typeof path !== 'string') return false
  if (PG_FILE.test(path)) return true
  const at = path.lastIndexOf('/'), name = path.slice(at + 1)
  return ['postgresql.conf', 'pg_hba.conf', 'postgresql.auto.conf'].includes(name) && isPostgresqlDataPath(path.slice(0, at)) && !(name !== 'postgresql.auto.conf' && path.startsWith('/var/lib/postgresql/'))
}
const PG_LOG = /^\/var\/log\/postgresql\/postgresql-[0-9]{2}-main\.log$/
const PG_DATA_LOG = /^(.+)\/log\/postgresql-[A-Za-z0-9_.-]{1,64}\.log$/
export const isPostgresqlLogPath = (path: unknown): path is string => typeof path === 'string' && (PG_LOG.test(path) || isPostgresqlDataPath(PG_DATA_LOG.exec(path)?.[1]))
export const isMongoLogPath = (path: unknown): path is string => typeof path === 'string' && /^\/var\/log\/mongodb\/[a-z0-9_-]{1,64}\.log$/.test(path)

export const PMA_TICKET_DIR = '/var/lib/xpanel-phpmyadmin'
export const PMA_HTPASSWD = '/etc/nginx/xpanel-phpmyadmin.htpasswd'
/** The agent-owned files of these tools; every other engine path stays refused. */
export function isDbServiceHostTarget(path: string, operation: string): boolean {
  if (path === PMA_TICKET_DIR) return operation === 'ensure-directory'
  if (['/usr/share/phpmyadmin/xpanel-signon.php', '/usr/share/phpMyAdmin/xpanel-signon.php', '/etc/phpmyadmin/conf.d/90-xpanel-signon.php', '/etc/phpMyAdmin/config.inc.php', '/etc/xpanel/database-web-clients.json', '/etc/xpanel/phpmyadmin-fpm.conf'].includes(path)) return operation === 'read' || operation === 'write' || operation === 'remove'
  if (['/etc/redis/redis.conf', '/etc/redis.conf', '/etc/valkey/valkey.conf', '/etc/mongod.conf', MONGO_ADMIN_FILE, MONGO_TOOLS_CONFIG].includes(path) || isPostgresqlConfigPath(path) || PG_START.test(path)) return operation === 'read' || operation === 'write'
  return false
}

const same = (argv: readonly unknown[], allowed: readonly string[]): boolean => argv.length === allowed.length && allowed.every((value, index) => argv[index] === value)
export function isDatabaseServiceCommand(argv: readonly unknown[]): boolean {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) return false
  const words = argv as string[]
  if (words[0] === DB_SERVICE_SYSTEMCTL) return words.length === 4 && DB_SERVICE_ACTIONS.includes(words[1] as DbServiceAction) && words[2] === '--' && isDbServiceUnit(words[3])
  if (PG_SQL.some(sql => same(words, postgresqlQueryArgv(sql)))) return true
  if (same(words, dnfModuleListArgv())) return true
  try {
    if (words[0] === '/usr/bin/dnf') return same(words, dnfVersionListArgv(words[5] ?? ''))
    if (words[0] === '/usr/bin/du') return same(words, dbDataSizeArgv(words[3] ?? ''))
    if (words[0] === DB_RUNUSER && words[4] !== undefined && words[4].endsWith('/postgres')) return same(words, pgConfigCheckArgv(words[4], words[6] ?? '', (words[8] ?? '').slice('config_file='.length)))
    if (words[0] === DB_SERVICE_RM) return words.length === 4 && [['redis', REDIS_BACKUP_DIR], ['mongodb', MONGO_BACKUP_DIR]].some(([engine, dir]) => words[3]!.startsWith(dir + '/') && same(words, dbBackupRemoveArgv(engine as 'redis', words[3]!.slice(dir!.length + 1))))
    if (words[0] === DB_SERVICE_INSTALL) {
      if (same(words, dbBackupDirArgv(REDIS_BACKUP_DIR)) || same(words, dbBackupDirArgv(MONGO_BACKUP_DIR))) return true
      if (words.length !== 10) return false
      const backup = words[9]!.startsWith(REDIS_BACKUP_DIR + '/') ? redisBackupCopyArgv(words[8]!, words[9]!.slice(REDIS_BACKUP_DIR.length + 1)) : redisRestoreCopyArgv(words[8]!.slice(REDIS_BACKUP_DIR.length + 1), words[9]!, words[4] as 'redis')
      return same(words, backup)
    }
    if (words[0] === MONGODUMP || words[0] === MONGORESTORE) {
      const archive = /^--archive=\/var\/backups\/xpanel\/mongodb\/([^/]+)$/.exec(words[6] ?? '')?.[1], mongoPort = Number(/^--port=([0-9]{1,5})$/.exec(words[3] ?? '')?.[1])
      if (!archive) return false
      return words[0] === MONGORESTORE ? same(words, mongorestoreArgv(mongoPort, archive)) : same(words, mongodumpArgv(mongoPort, archive, words[8]?.slice(5) ?? null))
    }
  } catch { return false }
  return false
}
