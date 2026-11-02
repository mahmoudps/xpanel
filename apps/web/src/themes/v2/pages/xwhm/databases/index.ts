import { whmDatabaseTemplates, dbEngineTemplates, databaseTuningTemplates } from '../../../client-templates/data-workspaces.ts'
import { actions, button, context, esc, facts, field, fields, link, note, page, section, split, status, table, technical, WHM_DATA_COMMON_CSS, type WhmDataPageInput } from '../software/common.ts'

export type WhmDatabaseInput = WhmDataPageInput
export const V2_WHM_DATABASE_ROUTES = Object.freeze(['/whm/databases', '/whm/databases/users', '/whm/databases/phpmyadmin', '/whm/databases/tuning', '/whm/databases/processes', '/whm/databases/servers', '/whm/databases/upgrade', '/whm/databases/redis', '/whm/databases/mongodb'] as const)
export const WHM_DATABASE_PAGES_CSS = WHM_DATA_COMMON_CSS
type DatabaseKind = 'overview' | 'users' | 'processes' | 'servers'

function databaseWorkspace(input: WhmDatabaseInput, kind: DatabaseKind): string {
  const { t, canRead, canKill } = context(input)
  const titles = { overview: msgctxt('theme:v2', 'Databases'), users: msgctxt('theme:v2', 'Database users'), processes: msgctxt('theme:v2', 'Database processes'), servers: msgctxt('theme:v2', 'Database servers') }
  const route = kind === 'overview' ? '/whm/databases' : `/whm/databases/${kind}`
  const observedAt = ['observedAt', msgctxt('theme:v2', 'Observed at (UTC)')] as const
  const filters = (drift: boolean) => fields(field(`v2-whm-db-search-${kind}`, t(msgid('Search')), { kind: 'input', type: 'search', disabled: true, autocomplete: 'off', hooks: { 'data-whm-db-search': true } }) + (drift ? field(`v2-whm-db-drift-${kind}`, t(msgctxt('theme:v2', 'Drift')), { kind: 'select', disabled: true, hooks: { 'data-whm-db-drift-filter': true }, options: [['', msgid('All')], ['in-sync', msgctxt('theme:v2', 'In sync')], ['saved-only', msgctxt('theme:v2', 'Saved only')], ['server-only', msgctxt('theme:v2', 'Server only')], ['system', msgctxt('theme:v2', 'System')], ['unverified', msgctxt('theme:v2', 'Not verified')]].map(([value, label]) => ({ value: value!, label: t(label!) })) }) : '')) + note(t(msgctxt('theme:v2', 'No loaded rows match these filters.')), { 'data-whm-db-filter-empty': true }, true)
  const rows = (name: string, title: string, headers: readonly string[]) => table(t, title, headers, { 'data-whm-db-rows': name })
  let body: string
  if (kind === 'overview') {
    body = split(section('database-server', t(msgctxt('theme:v2', 'Observed on the server')), facts(t, [['version', msgid('Version')], ['Uptime', msgctxt('theme:v2', 'Uptime')], ['Threads_connected', msgctxt('theme:v2', 'Connected threads')], ['Threads_running', msgctxt('theme:v2', 'Running threads')], ['Connections', msgctxt('theme:v2', 'Connection attempts')], ['Max_used_connections', msgctxt('theme:v2', 'Peak connections')], ['Aborted_connects', msgctxt('theme:v2', 'Aborted connects')], ['Questions', msgctxt('theme:v2', 'Statements')], ['Slow_queries', msgctxt('theme:v2', 'Slow queries')], ['schemaCount', msgctxt('theme:v2', 'Schemas')], ['totalSizeBytes', msgctxt('theme:v2', 'Data and index size')], observedAt], 'data-whm-db-fact')),
      section('database-saved', t(msgctxt('theme:v2', 'Saved configuration')), facts(t, [['accounts', msgid('Accounts')], ['databases', msgid('Databases')], ['trashedDatabases', msgctxt('theme:v2', 'In trash')], ['users', msgctxt('theme:v2', 'Database users')], ['grants', msgctxt('theme:v2', 'Grants')]], 'data-whm-db-fact') + note(t(msgctxt('theme:v2', 'Saved configuration and server observations are independent.'))))
      + section('database-drift', t(msgctxt('theme:v2', 'Schema drift')), facts(t, [['savedOnly', msgctxt('theme:v2', 'Saved only')], ['serverOnly', msgctxt('theme:v2', 'Server only')]], 'data-whm-db-fact')))
      + section('database-accounts', t(msgctxt('theme:v2', 'Saved configuration by account')), rows('accounts', t(msgctxt('theme:v2', 'Saved database configuration by account')), [msgid('Account'), msgid('Owner'), msgid('Status'), msgid('Databases'), msgctxt('theme:v2', 'In trash'), msgid('Users'), msgctxt('theme:v2', 'Grants'), msgctxt('theme:v2', 'Observed size')]))
      + section('database-schemas', t(msgctxt('theme:v2', 'Databases and drift')), filters(true) + rows('databases', t(msgctxt('theme:v2', 'Saved and observed databases')), [msgid('Database'), msgid('Account'), msgctxt('theme:v2', 'Saved state'), msgid('Size'), msgctxt('theme:v2', 'Tables'), msgctxt('theme:v2', 'Drift')]) + note(t(msgctxt('theme:v2', 'Server-only schemas are not attributed to an account.'))))
  } else if (kind === 'users') {
    body = section('database-users-summary', t(titles.users), facts(t, [observedAt, ['savedOnly', msgctxt('theme:v2', 'Saved only')], ['serverOnly', msgctxt('theme:v2', 'Server only')]], 'data-whm-db-fact') + note(t(msgctxt('theme:v2', 'Only database user names and hosts are read. Password hashes are never read.'))))
      + section('database-users-list', t(msgctxt('theme:v2', 'Users, grants and drift')), filters(true) + rows('users', t(titles.users), [msgid('User'), msgctxt('theme:v2', 'Host'), msgid('Account'), msgctxt('theme:v2', 'Saved grants'), msgid('Role'), msgctxt('theme:v2', 'Drift')]) + note(t(msgctxt('theme:v2', 'Account owners manage database users, passwords and grants in xPanel.'))))
  } else if (kind === 'processes') {
    body = section('database-processes', t(titles.processes), facts(t, [observedAt, ['count', msgid('Processes')]], 'data-whm-db-fact') + filters(false) + rows('processes', t(titles.processes), [msgctxt('theme:v2', 'Connection'), msgid('User'), msgid('Account'), msgctxt('theme:v2', 'Client host'), msgid('Database'), msgid('Command'), msgctxt('theme:v2', 'Time (seconds)'), msgid('State'), msgid('Action')]) + note(t(msgctxt('theme:v2', 'Query text is not read. Root, system, replication and the panel connection are protected from termination.'))))
  } else {
    body = section('database-engines', t(msgctxt('theme:v2', 'Database engines')), rows('engines', t(msgctxt('theme:v2', 'Database engines')), [msgctxt('theme:v2', 'Engine'), msgid('Service'), msgid('Unit'), msgid('Version'), msgctxt('theme:v2', 'Saved databases')]))
      + split(section('database-client', t(msgctxt('theme:v2', 'Panel client configuration')), facts(t, [['protocol', msgctxt('theme:v2', 'Protocol')], ['clientSocket', msgctxt('theme:v2', 'Socket')]], 'data-whm-db-fact') + note(t(msgctxt('theme:v2', 'The client connection is independent of MariaDB server configuration.')))), section('database-variables', t(msgctxt('theme:v2', 'Observed server settings')), facts(t, [['port', msgid('Port')], ['socket', msgctxt('theme:v2', 'Socket')], ['bind_address', msgctxt('theme:v2', 'Bind address')], ['skip_networking', msgctxt('theme:v2', 'Networking disabled')], ['max_connections', msgctxt('theme:v2', 'Maximum connections')], observedAt], 'data-whm-db-fact')))
  }
  return page(input, route, t(titles[kind]), t(msgctxt('theme:v2', 'Saved database configuration and current MariaDB observations.')), actions(button(t(msgid('Read again')), { 'data-whm-db-refresh': true }, !canRead)) + status(t(msgctxt('theme:v2', 'Database information has not been read yet.')), { 'data-whm-db-status': true }) + body + whmDatabaseTemplates(), { 'data-whm-databases': true, 'data-db-kind': kind, 'data-db-can-read': String(canRead), 'data-db-can-kill': String(kind === 'processes' && canKill) })
}

function engineWorkspace(input: WhmDatabaseInput, engine: 'phpmyadmin' | 'upgrade' | 'redis' | 'mongodb'): string {
  const { t, canRead, canManage } = context(input)
  const title = { phpmyadmin: 'phpMyAdmin', upgrade: t(msgctxt('theme:v2', 'Database upgrade')), redis: 'Redis', mongodb: 'MongoDB' }[engine]
  const rows = (name: string, label: string, headers: readonly string[]) => table(t, label, headers, { 'data-db-rows': name })
  let body: string
  if (engine === 'phpmyadmin') {
    body = split(section('database-sso', t(msgctxt('theme:v2', 'Open phpMyAdmin')), facts(t, [['installed', msgctxt('theme:v2', 'phpMyAdmin package')], ['signon', msgctxt('theme:v2', 'Single sign-on')], ['session', msgctxt('theme:v2', 'Session length')], ['ticket', msgctxt('theme:v2', 'Sign-on link validity')]], 'data-db-fact') + actions(button(t(msgctxt('theme:v2', 'Open phpMyAdmin')), { 'data-db-action': 'open' }, true, true)) + note(t(msgctxt('theme:v2', 'Sign-on uses a temporary database administrator and opens only after every server requirement passes. No password is shown.'))))
      + section('database-sso-checks', t(msgctxt('theme:v2', 'Sign-on setup')), `<ol class="v2-whm-data__list" data-db-checks><li>${esc(t(msgid('Not read')))}</li></ol>`), section('database-pga', 'phpPgAdmin', facts(t, [['phppgadmin', msgctxt('theme:v2', 'phpPgAdmin package')]], 'data-db-fact') + note(t(msgctxt('theme:v2', 'phpPgAdmin has no supported single sign-on. Database passwords are never placed in the browser.')))))
  } else if (engine === 'upgrade') {
    body = `<ol class="v2-whm-data__list" aria-label="${esc(t(msgctxt('theme:v2', 'Upgrade steps')))}"><li>1 · ${esc(t(msgid('Review')))}</li><li>2 · ${esc(t(msgctxt('theme:v2', 'Back up')))}</li><li>3 · ${esc(t(msgid('Upgrade')))}</li></ol>`
      + section('database-upgrade-review', t(msgctxt('theme:v2', 'Review the installed server')), facts(t, [['installed', msgctxt('theme:v2', 'Installed package')], ['running', msgctxt('theme:v2', 'Running version')], ['unit', msgctxt('theme:v2', 'Service unit')], ['active', msgctxt('theme:v2', 'Service state')], ['family', msgctxt('theme:v2', 'Package manager')], ['observedAt', msgctxt('theme:v2', 'Observed at (UTC)')]], 'data-db-fact') + rows('packages', t(msgctxt('theme:v2', 'Pending MariaDB packages')), [msgid('Package'), msgid('Installed'), msgid('Available'), msgctxt('theme:v2', 'Origin'), msgid('Security')]) + note('', { 'data-db-blocked': true }, true))
      + section('database-upgrade-backup', t(msgctxt('theme:v2', 'Back up')), note(t(msgctxt('theme:v2', 'A complete logical backup is required before package changes. The upgrade stops if backup fails.'))) + `<p>${technical('/var/backups/xpanel/mariadb-upgrade')}</p>`)
      + section('database-upgrade-apply', t(msgid('Upgrade')), status(t(msgid('Not read')), { 'data-db-plan': true }) + actions(button(t(msgctxt('theme:v2', 'Start upgrade')), { 'data-db-action': 'upgrade' }, true, true)) + note('', { 'data-db-job': true }, true) + note(t(msgctxt('theme:v2', 'Repository upgrades run as verified host jobs. Submission is not completion.'))))
  } else {
    const configuration = engine === 'redis'
      ? [['configPath', msgctxt('theme:v2', 'Configuration file')], ['configState', msgctxt('theme:v2', 'File state')], ['port', msgid('Port')], ['bind', msgctxt('theme:v2', 'Listen addresses')], ['protectedMode', msgctxt('theme:v2', 'Protected mode')], ['unixSocket', msgctxt('theme:v2', 'Unix socket')], ['maxmemory', msgctxt('theme:v2', 'Memory limit')], ['maxmemoryPolicy', msgctxt('theme:v2', 'Eviction policy')], ['requirePass', msgctxt('theme:v2', 'Password required')], ['appendOnly', msgctxt('theme:v2', 'Append-only file')]] as const
      : [['configPath', msgctxt('theme:v2', 'Configuration file')], ['configState', msgctxt('theme:v2', 'File state')], ['port', msgid('Port')], ['bindIp', msgctxt('theme:v2', 'Listen addresses')], ['authorization', msgctxt('theme:v2', 'Access control')], ['dbPath', msgctxt('theme:v2', 'Data directory')]] as const
    body = split(section(`database-${engine}-server`, t(msgid('Server')), facts(t, [['package', msgid('Package')], ['version', msgctxt('theme:v2', 'Installed version')], ['unit', msgctxt('theme:v2', 'Service unit')], ['active', msgctxt('theme:v2', 'Service state')], ['enabled', msgctxt('theme:v2', 'Starts at boot')], ['observedAt', msgctxt('theme:v2', 'Observed at (UTC)')]], 'data-db-fact')) + section(`database-${engine}-configuration`, t(msgid('Configuration')), facts(t, configuration, 'data-db-fact') + note(t(msgctxt('theme:v2', 'Configuration is read only. Unset settings retain server defaults and secrets are never read.')))),
      section(`database-${engine}-data`, t(engine === 'redis' ? msgctxt('theme:v2', 'Keys') : msgid('Databases')), note(t(msgctxt('theme:v2', 'The panel holds no database credentials for this service and does not browse its data.')))) + section(`database-${engine}-next`, t(msgctxt('theme:v2', 'Next step')), status(t(msgid('Not read')), { 'data-db-next': true }) + link(t(msgctxt('theme:v2', 'Manage services')), '/whm/services/more')))
  }
  return page(input, `/whm/databases/${engine}`, title, t(msgctxt('theme:v2', 'Read installed database components and review guarded operations.')), actions(button(t(msgid('Read again')), { 'data-db-action': 'refresh' }, !canRead)) + status(t(msgctxt('theme:v2', 'Server information has not been read yet.')), { 'data-db-status': true }) + body + dbEngineTemplates(), { 'data-db-engine': `whm-${engine}`, 'data-db-can-read': String(canRead), 'data-db-can-manage': String(canManage) })
}

function tuningWorkspace(input: WhmDatabaseInput): string {
  const { t, canRead } = context(input)
  return page(input, '/whm/databases/tuning', t(msgctxt('theme:v2', 'Database tuning')), t(msgctxt('theme:v2', 'Review observed MariaDB counters before planning changes. No settings are applied here.')), actions(button(t(msgid('Read again')), { 'data-db-tuning-read': true }, !canRead)) + status(t(msgctxt('theme:v2', 'Database tuning observations have not been read yet.')), { 'data-db-tuning-status': true })
    + section('database-tuning-summary', t(msgctxt('theme:v2', 'MariaDB observations')), facts(t, [['version', msgid('Version')], ['observedAt', msgctxt('theme:v2', 'Observed at (UTC)')], ['Uptime', msgctxt('theme:v2', 'Server uptime (seconds)')], ['Uptime_since_flush_status', msgctxt('theme:v2', 'Status interval (seconds)')]], 'data-db-tuning-fact'))
    + section('database-tuning-settings', t(msgctxt('theme:v2', 'Runtime settings')), table(t, t(msgctxt('theme:v2', 'Observed runtime settings')), [msgctxt('theme:v2', 'Setting or counter'), msgctxt('theme:v2', 'Observed value')], { 'data-db-tuning-rows': 'variables' }))
    + section('database-tuning-counters', t(msgctxt('theme:v2', 'Status counters')), table(t, t(msgctxt('theme:v2', 'MariaDB status counters')), [msgctxt('theme:v2', 'Setting or counter'), msgctxt('theme:v2', 'Observed value')], { 'data-db-tuning-rows': 'status' }) + note(t(msgctxt('theme:v2', 'One counter reading does not establish a workload trend.'))))
    + section('database-tuning-plan', t(msgctxt('theme:v2', 'Tuning review plan')), `<div class="v2-whm-data__stack" data-db-tuning-plan>${note(t(msgctxt('theme:v2', 'Read MariaDB to prepare the advisory plan.')))}</div>`) + databaseTuningTemplates(), { 'data-whm-database-tuning': true, 'data-can-read': String(canRead) })
}

/** An unrelated route is never represented as an unavailable database operation. */
export function renderV2WhmDatabasePage(input: WhmDatabaseInput): string | undefined {
  switch (input.activeRoute) {
    case '/whm/databases': return databaseWorkspace(input, 'overview')
    case '/whm/databases/users': return databaseWorkspace(input, 'users')
    case '/whm/databases/processes': return databaseWorkspace(input, 'processes')
    case '/whm/databases/servers': return databaseWorkspace(input, 'servers')
    case '/whm/databases/tuning': return tuningWorkspace(input)
    case '/whm/databases/phpmyadmin': return engineWorkspace(input, 'phpmyadmin')
    case '/whm/databases/upgrade': return engineWorkspace(input, 'upgrade')
    case '/whm/databases/redis': return engineWorkspace(input, 'redis')
    case '/whm/databases/mongodb': return engineWorkspace(input, 'mongodb')
    default: return undefined
  }
}
