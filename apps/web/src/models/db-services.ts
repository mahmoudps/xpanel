/** The sections of the database service tools; each theme draws them with its own components and the same hooks. */
export type DbServiceEngine = 'redis' | 'mongodb' | 'postgresql'
export type DbSectionPart =
  | { kind: 'facts'; attribute: string; rows: readonly (readonly [string, string])[] }
  | { kind: 'fields'; fields: readonly DbSectionField[] }
  | { kind: 'check'; label: string; hook: string; value?: string }
  | { kind: 'actions'; buttons: readonly { label: string; hook: string; value?: string; primary?: boolean }[] }
  | { kind: 'table'; hook: string; value: string; title: string; headers: readonly string[] }
  | { kind: 'note'; text: string }
  | { kind: 'status'; hook: string; text: string }
  | { kind: 'editor'; file: string; label: string }
  | { kind: 'log' }
  | { kind: 'upload'; id: string; label: string; hook: string }
export interface DbSectionField { id: string; label: string; hook: string; value?: string; type?: 'text' | 'number' | 'password'; options?: readonly (readonly [string, string])[]; textarea?: boolean; dir?: 'ltr' }
export interface DbSection { key: string; title: string; parts: readonly DbSectionPart[] }
/** The tool whose verification opens the controls of each engine page. */
export const DB_SERVICE_TOOLS: Readonly<Record<string, string>> = { '/whm/databases/redis': 'aapanel-redis-service', '/whm/databases/mongodb': 'aapanel-mongodb-service', '/whm/databases/servers': 'aapanel-postgresql-service' }

const control = (buttons: readonly (readonly [string, string])[]): DbSectionPart => ({ kind: 'actions', buttons: buttons.map(([label, value]) => ({ label, hook: 'data-dbs-control', value })) })
const service = (rows: readonly (readonly [string, string])[]): DbSection => ({ key: 'service', title: msgid('Service control'), parts: [{ kind: 'status', hook: 'data-dbs-status', text: msgid('The service has not been read.') }, { kind: 'facts', attribute: 'data-dbs-fact', rows: [['state', msgid('Service')], ['boot', msgid('Starts at boot')], ...rows] },
  control([[msgid('Start'), 'start'], [msgid('Stop'), 'stop'], [msgid('Restart'), 'restart'], [msgid('Start at boot'), 'enable'], [msgid('Do not start at boot'), 'disable']])] })
const field = (engine: string, name: string, label: string, extra: Partial<DbSectionField> = {}): DbSectionField => ({ id: `db-${engine}-${name}`, label, hook: 'data-dbs-field', value: name, dir: 'ltr', ...extra })
const save: DbSectionPart = { kind: 'actions', buttons: [{ label: msgid('Save settings'), hook: 'data-dbs-settings-save', primary: true }] }
const editor = (key: string, file: string, title: string, label: string): DbSection => ({ key, title, parts: [{ kind: 'editor', file, label }] })
const backups = (note: string, upload: readonly DbSectionPart[] = []): DbSection => ({ key: 'backups', title: msgid('Backups'), parts: [{ kind: 'actions', buttons: [{ label: msgid('Create backup'), hook: 'data-dbs-backup', primary: true }] }, ...upload, { kind: 'table', hook: 'data-dbs-rows', value: 'backups', title: msgid('Backups'), headers: [msgid('File'), msgid('Size'), msgid('Created (UTC)'), msgid('Restore'), msgid('Delete')] }, { kind: 'note', text: note }] })

const version = (note: string): DbSection => ({ key: 'version', title: msgid('Version'), parts: [{ kind: 'fields', fields: [{ id: 'db-version-target', label: msgid('Switch to'), hook: 'data-dbs-version-target', options: [['', msgid('Not read')]], dir: 'ltr' }] }, { kind: 'actions', buttons: [{ label: msgid('Switch version'), hook: 'data-dbs-version-switch', primary: true }] }, { kind: 'note', text: note }] })
const POLICIES = ['noeviction', 'allkeys-lru', 'allkeys-lfu', 'allkeys-random', 'volatile-lru', 'volatile-lfu', 'volatile-random', 'volatile-ttl']
export function dbServiceSections(engine: DbServiceEngine): readonly DbSection[] {
  if (engine === 'redis') return [
    service([['version', msgid('Running version')], ['usedMemory', msgid('Memory used')], ['clients', msgid('Connected clients')]]),
    { key: 'settings', title: msgid('Redis settings'), parts: [{ kind: 'fields', fields: [field(engine, 'port', msgid('Port'), { type: 'number' }), field(engine, 'maxmemoryMb', msgid('Memory limit (MB, 0 for none)'), { type: 'number' }), field(engine, 'maxclients', msgid('Maximum clients'), { type: 'number' }), field(engine, 'maxmemoryPolicy', msgid('Eviction policy'), { options: POLICIES.map(item => [item, item]) }), field(engine, 'persistence', msgid('Persistence'), { options: [['rdb', msgid('Snapshots')], ['aof', msgid('Append-only file')], ['none', msgid('None')]] })] }, { kind: 'check', label: msgid('Allow remote clients'), hook: 'data-dbs-field', value: 'remoteAccess' }, save, { kind: 'note', text: msgid('Redis restarts to load these values. Remote clients need a password here and a rule in the firewall.') }] },
    version(msgid('Versions are those your repositories offer. The job backs up and checks the data, keeps both versions ready, switches, and puts the previous version and data back if Redis does not answer with every key.')),
    { key: 'password', title: msgid('Redis password'), parts: [{ kind: 'facts', attribute: 'data-dbs-fact', rows: [['password', msgid('Password')]] }, { kind: 'fields', fields: [field(engine, 'password', msgid('New password'), { type: 'password' })] }, { kind: 'actions', buttons: [{ label: msgid('Generate password'), hook: 'data-dbs-password-generate' }, { label: msgid('Set password'), hook: 'data-dbs-password-save', primary: true }, { label: msgid('Remove password'), hook: 'data-dbs-password-clear' }] }, { kind: 'note', text: msgid('The password stays in the configuration file and is never shown here. Sites that use this Redis need the new password.') }] },
    { key: 'keys', title: msgid('Keys'), parts: [{ kind: 'fields', fields: [{ id: 'db-redis-keys-db', label: msgid('Database'), hook: 'data-dbs-keys-db', options: [['0', '0']] }, { id: 'db-redis-keys-match', label: msgid('Name filter, such as user:*'), hook: 'data-dbs-keys-match', dir: 'ltr' }] }, { kind: 'actions', buttons: [{ label: msgid('Read keys'), hook: 'data-dbs-keys-read', primary: true }, { label: msgid('Show more'), hook: 'data-dbs-keys-more' }, { label: msgid('Clear this database'), hook: 'data-dbs-flush' }, { label: msgid('Clear all databases'), hook: 'data-dbs-flush-all' }] },
      { kind: 'table', hook: 'data-dbs-rows', value: 'keys', title: msgid('Keys'), headers: [msgid('Key'), msgid('Type'), msgid('Length'), msgid('Expires in'), msgid('Value'), msgid('Delete')] },
      { kind: 'fields', fields: [field(engine, 'keyName', msgid('Key')), field(engine, 'ttl', msgid('Time to live in seconds (empty for none)'), { type: 'number' }), field(engine, 'keyValue', msgid('Value'), { textarea: true })] }, { kind: 'actions', buttons: [{ label: msgid('Save key'), hook: 'data-dbs-key-save' }] }, { kind: 'note', text: msgid('Add and edit work on text keys. Lists, sets, hashes and streams can be listed and deleted.') }] },
    backups(msgid('Snapshots are kept in a root-only directory. A restore stops Redis, replaces its data file and starts it again.')),
    editor('config', 'config', msgid('Configuration file'), msgid('Configuration file')),
  ]
  if (engine === 'mongodb') return [
    service([['version', msgid('Running version')], ['dataDirectory', msgid('Data directory')]]),
    { key: 'settings', title: msgid('MongoDB settings'), parts: [{ kind: 'fields', fields: [field(engine, 'port', msgid('Port'), { type: 'number' }), field(engine, 'bindIp', msgid('Listen addresses, separated by commas'))] }, save, { kind: 'note', text: msgid('MongoDB restarts and the new addresses are checked on the running server. Remote clients need access control here and a rule in the firewall.') }] },
    { key: 'auth', title: msgid('Access control'), parts: [{ kind: 'facts', attribute: 'data-dbs-fact', rows: [['authorization', msgid('Access control')], ['admin', msgid('xPanel administrator')]] }, { kind: 'actions', buttons: [{ label: msgid('Turn on'), hook: 'data-dbs-auth-on', primary: true }, { label: msgid('Turn off'), hook: 'data-dbs-auth-off' }] }, { kind: 'note', text: msgid('xPanel creates its own administrator first. Its password stays in a root-only file and is never shown.') }] },
    { key: 'databases', title: msgid('Databases'), parts: [{ kind: 'table', hook: 'data-dbs-rows', value: 'databases', title: msgid('Databases'), headers: [msgid('Select'), msgid('Database'), msgid('Size'), msgid('Users'), msgid('Back up')] }, { kind: 'actions', buttons: [{ label: msgid('Delete selected'), hook: 'data-dbs-db-delete' }] },
      { kind: 'fields', fields: [field(engine, 'dbName', msgid('Database')), field(engine, 'dbUser', msgid('User')), field(engine, 'dbPassword', msgid('Password'), { type: 'password' })] }, { kind: 'actions', buttons: [{ label: msgid('Create database'), hook: 'data-dbs-db-create', primary: true }] }, { kind: 'note', text: msgid('Databases are created on this server. Remote servers need a registered server profile, which this release does not offer.') }] },
    backups(msgid('Backups use mongodump in a verified job. An uploaded file must be a gzipped mongodump archive; after the upload, restore it from this list.'), [{ kind: 'upload', id: 'db-mongodb-import', label: msgid('Archive to import'), hook: 'data-dbs-import-file' }, { kind: 'actions', buttons: [{ label: msgid('Upload archive'), hook: 'data-dbs-import-upload' }] }]),
    editor('config', 'config', msgid('Configuration file'), msgid('Configuration file')),
    { key: 'log', title: msgid('Log'), parts: [{ kind: 'log' }] },
  ]
  return [
    service([['version', msgid('Running version')], ['dataDirectory', msgid('Data directory')], ['pending', msgid('Waiting for a restart')]]),
    { key: 'settings', title: msgid('PostgreSQL settings'), parts: [{ kind: 'fields', fields: [field(engine, 'port', msgid('Port'), { type: 'number' }), field(engine, 'maxConnections', msgid('Maximum connections'), { type: 'number' }), field(engine, 'sharedBuffers', msgid('Shared buffers, such as 128MB')), field(engine, 'workMem', msgid('Work memory, such as 4MB')), field(engine, 'maintenanceWorkMem', msgid('Maintenance memory, such as 64MB')), field(engine, 'effectiveCacheSize', msgid('Effective cache size, such as 256MB')), field(engine, 'logMinDurationMs', msgid('Slow query log threshold in ms (-1 for off)'), { type: 'number' })] }, save, { kind: 'note', text: msgid('Saved with ALTER SYSTEM. PostgreSQL restarts when a value needs it, and the panel moves to a new port with it.') }] },
    version(msgid('Major versions your repositories offer, upward only. The job dumps every database, checks the dump, upgrades a copy of the cluster and keeps the old one stopped. It goes back to the old cluster if a database is missing afterwards.')),
    { key: 'data-directory', title: msgid('Data directory'), parts: [{ kind: 'fields', fields: [field(engine, 'dataTarget', msgid('New path, such as /srv/postgresql/data'))] }, { kind: 'actions', buttons: [{ label: msgid('Move data directory'), hook: 'data-dbs-data-move', primary: true }] }, { kind: 'note', text: msgid('PostgreSQL stops while its data is copied and every file is compared. The original stays where it is until you remove it, and the server goes back to it if the copy does not start.') }] },
    editor('client-auth', 'hba', msgid('Client authentication rules'), msgid('Client authentication rules')),
    editor('config', 'config', msgid('Configuration file'), msgid('Configuration file')),
    { key: 'log', title: msgid('Log'), parts: [{ kind: 'log' }] },
  ]
}

export const DB_QUOTA_SECTION: DbSection = { key: 'quota', title: msgid('Database size limits'), parts: [
  { kind: 'table', hook: 'data-db-quota-rows', value: 'quota', title: msgid('Database size limits'), headers: [msgid('Database'), msgid('Account'), msgid('Size'), msgid('Limit'), msgid('State')] },
  { kind: 'fields', fields: [{ id: 'db-quota-database', label: msgid('Database'), hook: 'data-db-quota-database', options: [['', msgid('Not read')]] }, { id: 'db-quota-limit', label: msgid('Limit in MB'), hook: 'data-db-quota-limit', type: 'number', dir: 'ltr' }] },
  { kind: 'actions', buttons: [{ label: msgid('Save limit'), hook: 'data-db-quota-save', primary: true }, { label: msgid('Remove limit'), hook: 'data-db-quota-clear' }] },
  { kind: 'status', hook: 'data-db-quota-status', text: msgid('Database limits have not been read.') },
  { kind: 'note', text: msgid('Over its limit, a database keeps SELECT, DELETE and DROP, so its owner can make room, and loses every privilege that adds data until it is under the limit.') } ] }

export const PMA_ACCESS_SECTION: DbSection = { key: 'pma-access', title: msgid('phpMyAdmin access'), parts: [
  { kind: 'check', label: msgid('Allow public access'), hook: 'data-pma-public' },
  { kind: 'fields', fields: [{ id: 'db-pma-http', label: msgid('HTTP port (empty for off)'), hook: 'data-pma-http', type: 'number', dir: 'ltr' }, { id: 'db-pma-https', label: msgid('HTTPS port'), hook: 'data-pma-https', type: 'number', dir: 'ltr' }, { id: 'db-pma-php', label: msgid('PHP version'), hook: 'data-pma-php', options: [['', msgid('Not read')]] }, { id: 'db-pma-user', label: msgid('Access user (empty for no extra password)'), hook: 'data-pma-user', dir: 'ltr' }, { id: 'db-pma-password', label: msgid('Access password'), hook: 'data-pma-password', type: 'password' }] },
  { kind: 'actions', buttons: [{ label: msgid('Save access'), hook: 'data-pma-save', primary: true }] },
  { kind: 'status', hook: 'data-pma-status', text: msgid('phpMyAdmin access has not been read.') },
  { kind: 'note', text: msgid('With public access off, other addresses get 403. The extra password asks every visitor before phpMyAdmin opens; leave its field empty to keep the current one.') } ] }
