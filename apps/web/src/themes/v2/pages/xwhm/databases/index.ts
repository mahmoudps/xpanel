import { whmDatabaseTemplates, dbEngineTemplates, databaseTuningTemplates } from '../../../client-templates/data-workspaces.ts'
import { actions, button, check, context, esc, facts, field, fields, link, note, page, section, split, status, table, technical, type WhmDataPageInput } from '../software/common.ts'
import { dbQuotaTool, dbServiceWorkspace, pmaAccessTool } from './services.ts'

export type WhmDatabaseInput = WhmDataPageInput
export const V2_WHM_DATABASE_ROUTES = Object.freeze(['/whm/databases', '/whm/databases/users', '/whm/databases/phpmyadmin', '/whm/databases/tuning', '/whm/databases/processes', '/whm/databases/servers', '/whm/databases/upgrade', '/whm/databases/redis', '/whm/databases/mongodb'] as const)
/** The database pages' own rules. They load beside the shared data stylesheet (WHM_DATA_COMMON_CSS), which the route registry already serves on these routes. */
export const WHM_DATABASE_PAGES_CSS = `.v2-whm-data pre[data-dbs-log]{max-block-size:320px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}
.v2-whm-data[data-whm-detail-route^="/whm/databases"] p[data-state]{margin:0;font-size:13px;line-height:1.6;color:var(--text-2)}
.v2-whm-data[data-whm-detail-route^="/whm/databases"]>p[data-state]:not([data-state=failed]){padding:12px var(--space-2);border:1px solid var(--line);border-radius:var(--radius-notice);background:var(--surface)}
.v2-whm-data[data-whm-detail-route^="/whm/databases"] p[data-state]:is([data-state=failed],[data-state=uncertain],[data-state=unavailable]){color:var(--text)}
.v2-whm-data[data-whm-detail-route^="/whm/databases"]>p[data-state=uncertain]{border-color:var(--bad-line);background:var(--bad-soft)}
.v2-whm-data[data-whm-detail-route^="/whm/databases"]>p[data-state]:is([data-state=partial],[data-state=unavailable]){border-color:var(--warn-line);background:var(--warn-soft)}
.v2-whm-data[data-whm-detail-route^="/whm/databases"] table{min-inline-size:0}
.v2-whm-data[data-whm-detail-route^="/whm/databases"] table :is(th,td){padding-inline:12px;white-space:normal}
.v2-whm-data[data-whm-detail-route^="/whm/databases"] table th{vertical-align:bottom}
.v2-whm-data[data-whm-detail-route^="/whm/databases"] table td{overflow-wrap:break-word}
.v2-whm-data[data-whm-detail-route^="/whm/databases"] table td:first-child{overflow-wrap:anywhere}
.v2-whm-data[data-whm-detail-route^="/whm/databases"] table td:has(>button+button)>button{margin-block:2px;margin-inline-end:var(--space-1)}
.v2-whm-data[data-whm-detail-route^="/whm/databases"] input[type=file]{inline-size:100%;max-inline-size:480px;min-block-size:var(--target);padding:6px;border:1px dashed var(--line-strong);border-radius:var(--radius-control);background:var(--subtle);color:var(--text-2);font-size:13px}
.v2-whm-data[data-whm-detail-route^="/whm/databases"] input[type=file]::file-selector-button{min-block-size:var(--target);margin-inline-end:12px;padding:0 12px;border:1px solid var(--line-strong);border-radius:var(--radius-chip);background:var(--surface);color:var(--text);font:inherit;font-weight:600;cursor:pointer}
.v2-whm-data[data-whm-detail-route^="/whm/databases"] table td>button.v2-btn{padding-inline:12px}
.v2-whm-data[data-whm-detail-route^="/whm/databases"] input[type=number]{max-inline-size:240px}
.v2-whm-data[data-whm-detail-route^="/whm/databases"]>.v2-card .v2-whm-data__facts,.v2-whm-data[data-whm-detail-route^="/whm/databases"]>div>.v2-card .v2-whm-data__facts{grid-template-columns:repeat(auto-fit,minmax(min(180px,100%),1fr))}
.v2-whm-data[data-whm-detail-route^="/whm/databases"] [data-db-tuning-plan]>article{gap:12px;padding-block-start:var(--space-2);border-block-start:1px solid var(--line)}
.v2-whm-data[data-whm-detail-route^="/whm/databases"] [data-db-tuning-plan]>article:first-child{padding-block-start:0;border-block-start:0}
.v2-whm-data[data-whm-detail-route^="/whm/databases"] [data-db-tuning-plan]>article>.v2-whm-data__actions{justify-content:space-between}
.v2-whm-data [data-db-tuning-plan]:empty::before{content:attr(data-empty-text);font-size:13px;color:var(--muted)}
.v2-whm-data[data-whm-detail-route="/whm/databases/upgrade"]>ol{list-style:none;margin:0;padding:0;display:flex;flex-direction:row;flex-wrap:wrap;gap:var(--space-1)}
.v2-whm-data[data-whm-detail-route="/whm/databases/upgrade"]>ol>li{padding:6px 12px;border:1px solid var(--line);border-radius:var(--radius-pill);background:var(--surface);font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}
.v2-whm-data[data-whm-detail-route^="/whm/databases"] tbody th{background:none;color:var(--text);font-size:14px;font-weight:400}
.v2-whm-data[data-whm-detail-route^="/whm/databases"] td>bdi.v2-mono:is([data-xp-slot=databases],[data-xp-slot=trash],[data-xp-slot=users],[data-xp-slot=grants],[data-xp-slot=size],[data-xp-slot=tables]){font-family:var(--font-sans);font-variant-numeric:tabular-nums}
@media(min-width:1101px){.v2-whm-data[data-whm-detail-route^="/whm/databases"]>.v2-card .v2-whm-data__facts:has(>:nth-child(5):last-child){grid-template-columns:repeat(5,minmax(0,1fr))}.v2-whm-data[data-whm-detail-route="/whm/databases/phpmyadmin"]>.v2-whm-data__split{grid-template-columns:repeat(2,minmax(0,1fr))}.v2-whm-data:is([data-whm-detail-route="/whm/databases/redis"],[data-whm-detail-route="/whm/databases/mongodb"])>.v2-whm-data__split{grid-template-columns:minmax(0,1fr)}.v2-whm-data:is([data-whm-detail-route="/whm/databases/redis"],[data-whm-detail-route="/whm/databases/mongodb"])>.v2-whm-data__split .v2-whm-data__facts:has(>:nth-child(10):last-child){grid-template-columns:repeat(5,minmax(0,1fr))}.v2-whm-data:is([data-whm-detail-route="/whm/databases/redis"],[data-whm-detail-route="/whm/databases/mongodb"])>.v2-whm-data__split .v2-whm-data__facts:has(>:nth-child(6):last-child){grid-template-columns:repeat(3,minmax(0,1fr))}}
@media(max-width:600px){.v2-whm-data[data-whm-detail-route^="/whm/databases"] .v2-whm-data__facts{grid-template-columns:repeat(2,minmax(0,1fr))}.v2-whm-data[data-whm-detail-route^="/whm/databases"] :is(th,td){overflow-wrap:anywhere}}
`
type DatabaseKind = 'overview' | 'users' | 'processes' | 'servers'

function databaseMapTool(input: WhmDatabaseInput): string {
  const { t, canRead } = context(input), text = (id: string, label: string, hook: string, maxlength: number): string => field(id, label, { kind: 'input', type: 'text', disabled: true, dir: 'ltr', maxlength, autocomplete: 'off', hooks: { [hook]: true } })
  return section('database-map', t(msgid('Assign to an account')), `<div class="v2-whm-data__stack" data-db-map-tool data-can-manage="${canRead && input.dataAuthority?.canDbMap === true}">`
    + fields(text('v2-db-map-account', t(msgid('Account')), 'data-db-map-account', 16) + text('v2-db-map-databases', t(msgid('Databases, separated by commas')), 'data-db-map-databases', 2000) + text('v2-db-map-users', t(msgid('Database users, separated by commas')), 'data-db-map-users', 2000))
    + actions(button(t(msgid('Assign')), { 'data-db-map-submit': true }, true, true)) + status(t(msgid('Assigning objects has not started.')), { 'data-db-map-status': true })
    + note(t(msgid('Only objects that no account owns can be assigned, and objects never move between accounts. A user keeps its password and its grants on the account databases.'))) + '</div>')
}
function databaseHostsTool(input: WhmDatabaseInput): string {
  const { t, canRead } = context(input)
  return section('database-hosts', t(msgid('Additional access hosts')), `<div class="v2-whm-data__stack" data-db-hosts-tool data-can-manage="${canRead && input.dataAuthority?.canDbHosts === true}">`
    + field('v2-db-hosts-list', t(msgid('Hosts, one per line')), { kind: 'textarea', rows: 5, disabled: true, dir: 'ltr', hooks: { 'data-db-hosts-list': true } })
    + actions(button(t(msgid('Save list')), { 'data-db-hosts-save': true }) + button(t(msgid('Push to all accounts')), { 'data-db-hosts-push': true })) + status(t(msgid('Access hosts have not been read.')), { 'data-db-hosts-status': true })
    + note(t(msgid('Use exact IP addresses or an IPv4 network. An account owner can remove a pushed host from the account; the next push adds it again.'))) + '</div>')
}
function databaseProfiles(input: WhmDatabaseInput): string {
  const { t, canRead } = context(input), manage = canRead && input.dataAuthority?.canDbProfiles === true
  const text = (key: string, label: string, maxlength: number, type?: 'password' | 'number'): string => field('v2-db-' + key, t(label), { kind: 'input', ...(type ? { type } : {}), ...(type === 'number' ? { min: 1, max: 65535, value: '3306' } : {}), disabled: true, dir: 'ltr', maxlength, spellcheck: false, autocomplete: type === 'password' ? 'new-password' : 'off', hooks: { 'data-sec-input': key } })
  return `<div data-db-profiles-workspace data-sec-can-read="${canRead}" data-sec-can-manage="${manage}"><template data-xp-template="sec-action"><button type="button" class="v2-btn" disabled><span data-xp-slot="label"></span></button></template><template data-xp-template="sec-action-group"><div class="v2-whm-data__actions" data-xp-slot="items"></div></template>`
    + section('database-profiles', t(msgid('Database server profiles')), status(t(msgid('Nothing has been read yet.')), { 'data-sec-status': true }) + `<p role="status" data-sec-result hidden></p>` + facts(t, [['profile-active', msgid('Active server')]], 'data-sec-field')
      + table(t, t(msgid('Database server profiles')), [msgid('Name'), msgid('Server'), msgid('User'), msgid('State'), msgid('Validation'), msgid('Actions')], { 'data-sec-rows': 'profiles' }, t(msgid('No profiles have been read.')))
      + fields(text('profile-name', msgid('Profile name'), 32) + text('profile-host', msgid('Server host'), 253) + text('profile-port', msgid('Port'), 5, 'number') + text('profile-user', msgid('Administrator user'), 80) + text('profile-password', msgid('Password'), 128, 'password') + text('profile-description', msgid('Description'), 200))
      + fields(field('v2-db-profile-ca', t(msgid('Server CA certificate')), { kind: 'textarea', rows: 6, disabled: true, dir: 'ltr', maxlength: 8192, spellcheck: false, autocomplete: 'off', hooks: { 'data-sec-input': 'profile-ca' } }, t(msgid('TLS is required. The client checks the server certificate and host name against this PEM certificate before it sends the user or password. Leave it empty to keep the saved one.'))))
      + note(t(msgid('The password is stored only in a root-only file on this server and is never shown again. Activating a profile never moves data, and it is refused while databases are saved on the active server.')))
      + actions(button(t(msgid('Refresh')), { 'data-sec-action': 'profiles-refresh' }, !canRead) + button(t(msgid('Save profile')), { 'data-sec-action': 'profile-save' }, true, true))) + '</div>'
}
function databaseServerTools(input: WhmDatabaseInput): string {
  const { t, canRead } = context(input), secret = (id: string, label: string, hook: string): string => field(id, label, { kind: 'input', type: 'password', disabled: true, autocomplete: 'new-password', dir: 'ltr', maxlength: 128, spellcheck: false, hooks: { [hook]: true } })
  return section('database-settings', t(msgid('MariaDB server settings')), `<div class="v2-whm-data__stack" data-db-settings-tool data-can-manage="${canRead && input.dataAuthority?.canDbSettings === true}">`
    + check(t(msgid('Set open_files_limit and max_allowed_packet')), { 'data-db-setting-limits': true }) + check(t(msgid('Size the InnoDB buffer pool from server memory')), { 'data-db-setting-pool': true })
    + actions(button(t(msgid('Save settings')), { 'data-db-settings-save': true }, true, true)) + status(t(msgid('Database settings have not been read.')), { 'data-db-settings-status': true }) + '</div>')
    + section('database-postgresql', t(msgid('Configure PostgreSQL')), `<div class="v2-whm-data__stack" data-db-pg-tool data-can-manage="${canRead && input.dataAuthority?.canPostgresql === true}">`
      + facts(t, [['state', msgid('Service')], ['version', msgid('Version')], ['missing', msgid('Accounts without a role')]], 'data-db-pg-fact') + actions(button(t(msgid('Create missing roles')), { 'data-db-pg-roles': true }))
      + fields(secret('v2-db-pg-new', t(msgid('New superuser password')), 'data-db-pg-new') + secret('v2-db-pg-confirm', t(msgid('Confirm password')), 'data-db-pg-confirm'))
      + actions(button(t(msgid('Generate password')), { 'data-db-pg-generate': true }) + button(t(msgid('Change password')), { 'data-db-pg-submit': true }, true, true)) + status(t(msgid('PostgreSQL has not been read.')), { 'data-db-pg-status': true })
      + note(t(msgid('A new role is named after the account with _owner and has no known password until the owner sets one. The host-based authentication file stays as the package installed it.'))) + '</div>')
}

function databaseWorkspace(input: WhmDatabaseInput, kind: DatabaseKind): string {
  const { t, canRead, canKill } = context(input), canRepair = kind === 'overview' && canRead && input.dataAuthority?.canRepair === true
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
      + section('database-maintenance', t(msgid('Repair a database')), fields(field('v2-whm-db-maint-database', t(msgid('Database')), { kind: 'select', disabled: true, hooks: { 'data-whm-db-maint-database': true }, options: [{ value: '', label: t(msgid('Not read')) }] })
        + field('v2-whm-db-maint-action', t(msgid('Operation')), { kind: 'select', disabled: true, hooks: { 'data-whm-db-maint-action': true }, options: [{ value: 'check', label: t(msgid('Check tables')) }, { value: 'repair', label: t(msgid('Repair tables')) }] }))
        + actions(button(t(msgid('Run')), { 'data-whm-db-maint-run': true }, true, true)) + status(t(msgid('Choose a database observed on the server.')), { 'data-whm-db-maint-status': true })
        + rows('maintenance', t(msgid('Table results')), [msgid('Table'), msgid('Engine'), msgid('Result'), msgid('Message')]) + note(t(msgid('Runs CHECK TABLE or REPAIR TABLE on every table of one database. Storage engines without repair support, such as InnoDB, are reported as not supported.'))))
      + databaseMapTool(input) + dbQuotaTool(input, input.dataAuthority?.canDbQuota)
  } else if (kind === 'users') {
    body = section('database-users-summary', t(titles.users), facts(t, [observedAt, ['savedOnly', msgctxt('theme:v2', 'Saved only')], ['serverOnly', msgctxt('theme:v2', 'Server only')]], 'data-whm-db-fact') + note(t(msgctxt('theme:v2', 'Only database user names and hosts are read. Password hashes are never read.'))))
      + section('database-users-list', t(msgctxt('theme:v2', 'Users, grants and drift')), filters(true) + rows('users', t(titles.users), [msgid('User'), msgctxt('theme:v2', 'Host'), msgid('Account'), msgctxt('theme:v2', 'Saved grants'), msgid('Role'), msgctxt('theme:v2', 'Drift')]) + note(t(msgctxt('theme:v2', 'Account owners manage database users, passwords and grants in xPanel.'))))
      + databaseHostsTool(input)
  } else if (kind === 'processes') {
    body = section('database-processes', t(titles.processes), facts(t, [observedAt, ['count', msgid('Processes')]], 'data-whm-db-fact') + filters(false) + rows('processes', t(titles.processes), [msgctxt('theme:v2', 'Connection'), msgid('User'), msgid('Account'), msgctxt('theme:v2', 'Client host'), msgid('Database'), msgid('Command'), msgctxt('theme:v2', 'Time (seconds)'), msgid('State'), msgid('Action')]) + note(t(msgctxt('theme:v2', 'Query text is not read. Root, system, replication and the panel connection are protected from termination.'))))
  } else {
    const canRootPassword = canRead && input.dataAuthority?.canRootPassword === true
    body = section('database-engines', t(msgctxt('theme:v2', 'Database engines')), rows('engines', t(msgctxt('theme:v2', 'Database engines')), [msgctxt('theme:v2', 'Engine'), msgid('Service'), msgid('Unit'), msgid('Version'), msgctxt('theme:v2', 'Saved databases')]))
      + databaseProfiles(input) + databaseServerTools(input) + dbServiceWorkspace(input, 'postgresql', input.dataAuthority?.canDbService)
      + section('database-root-password', t(msgid('MariaDB root password')), `<div class="v2-whm-data__stack" data-whm-db-root-password data-can-manage="${canRootPassword}">${facts(t, [['clientFile', msgid('Root client file')]], 'data-db-root-fact')}`
        + fields(field('v2-whm-db-root-new', t(msgid('New password')), { kind: 'input', type: 'password', disabled: true, autocomplete: 'new-password', dir: 'ltr', maxlength: 128, spellcheck: false, hooks: { 'data-db-root-new': true } }) + field('v2-whm-db-root-confirm', t(msgid('Confirm password')), { kind: 'input', type: 'password', disabled: true, autocomplete: 'new-password', dir: 'ltr', maxlength: 128, spellcheck: false, hooks: { 'data-db-root-confirm': true } }))
        + note('', { 'data-db-root-strength': true }) + actions(button(t(msgid('Generate password')), { 'data-db-root-generate': true }) + button(t(msgid('Change password')), { 'data-db-root-submit': true }, true, true))
        + status(t(msgid('The root password state has not been read.')), { 'data-db-root-status': true }) + note(t(msgid('Sets the password for root@localhost and saves it in /root/.my.cnf. The server root account keeps signing in through the local socket. Characters such as quotes and backslashes can break some web database clients.'))) + '</div>')
      + split(section('database-client', t(msgctxt('theme:v2', 'Panel client configuration')), facts(t, [['protocol', msgctxt('theme:v2', 'Protocol')], ['clientSocket', msgctxt('theme:v2', 'Socket')]], 'data-whm-db-fact') + note(t(msgctxt('theme:v2', 'The client connection is independent of MariaDB server configuration.')))), section('database-variables', t(msgctxt('theme:v2', 'Observed server settings')), facts(t, [['port', msgid('Port')], ['socket', msgctxt('theme:v2', 'Socket')], ['bind_address', msgctxt('theme:v2', 'Bind address')], ['skip_networking', msgctxt('theme:v2', 'Networking disabled')], ['max_connections', msgctxt('theme:v2', 'Maximum connections')], observedAt], 'data-whm-db-fact')))
  }
  return page(input, route, t(titles[kind]), t(msgctxt('theme:v2', 'Saved database configuration and current MariaDB observations.')), status(t(msgctxt('theme:v2', 'Database information has not been read yet.')), { 'data-whm-db-status': true }) + body + whmDatabaseTemplates(), { 'data-whm-databases': true, 'data-db-kind': kind, 'data-db-can-read': String(canRead), 'data-db-can-kill': String(kind === 'processes' && canKill), 'data-db-can-repair': String(canRepair) }, button(t(msgid('Read again')), { 'data-whm-db-refresh': true }, !canRead))
}

function engineWorkspace(input: WhmDatabaseInput, engine: 'phpmyadmin' | 'upgrade' | 'redis' | 'mongodb'): string {
  const { t, canRead, canManage } = context(input)
  const title = { phpmyadmin: 'phpMyAdmin', upgrade: t(msgctxt('theme:v2', 'Database upgrade')), redis: 'Redis', mongodb: 'MongoDB' }[engine]
  const rows = (name: string, label: string, headers: readonly string[]) => table(t, label, headers, { 'data-db-rows': name })
  let body: string
  if (engine === 'phpmyadmin') {
    body = split(section('database-sso', t(msgctxt('theme:v2', 'Open phpMyAdmin')), facts(t, [['installed', msgctxt('theme:v2', 'phpMyAdmin package')], ['signon', msgctxt('theme:v2', 'Single sign-on')], ['session', msgctxt('theme:v2', 'Session length')], ['ticket', msgctxt('theme:v2', 'Sign-on link validity')]], 'data-db-fact') + actions(button(t(msgctxt('theme:v2', 'Open phpMyAdmin')), { 'data-db-action': 'open' }, true, true)) + note(t(msgctxt('theme:v2', 'Sign-on uses a temporary database administrator and opens only after every server requirement passes. No password is shown.')))),
      section('database-sso-checks', t(msgctxt('theme:v2', 'Sign-on setup')), `<ol class="v2-whm-data__list" data-db-checks><li>${esc(t(msgid('Not read')))}</li></ol>`)) + section('database-pga', 'phpPgAdmin', facts(t, [['phppgadmin', msgctxt('theme:v2', 'phpPgAdmin package')]], 'data-db-fact') + note(t(msgid('phpPgAdmin sign-on is for account owners and covers their own databases. There is no server-wide phpPgAdmin sign-on.')))) + pmaAccessTool(input, input.dataAuthority?.canPmaAccess)
  } else if (engine === 'upgrade') {
    body = `<ol class="v2-whm-data__list" aria-label="${esc(t(msgctxt('theme:v2', 'Upgrade steps')))}"><li>1 · ${esc(t(msgid('Review')))}</li><li>2 · ${esc(t(msgctxt('theme:v2', 'Back up')))}</li><li>3 · ${esc(t(msgid('Upgrade')))}</li></ol>`
      + section('database-upgrade-review', t(msgctxt('theme:v2', 'Review the installed server')), facts(t, [['installed', msgctxt('theme:v2', 'Installed package')], ['running', msgctxt('theme:v2', 'Running version')], ['unit', msgctxt('theme:v2', 'Service unit')], ['active', msgctxt('theme:v2', 'Service state')], ['family', msgctxt('theme:v2', 'Package manager')], ['observedAt', msgctxt('theme:v2', 'Observed at (UTC)')]], 'data-db-fact') + rows('packages', t(msgctxt('theme:v2', 'Pending MariaDB packages')), [msgid('Package'), msgid('Installed'), msgid('Available'), msgctxt('theme:v2', 'Origin'), msgid('Security')]) + note('', { 'data-db-blocked': true }, true))
      + section('database-upgrade-backup', t(msgctxt('theme:v2', 'Back up')), note(t(msgctxt('theme:v2', 'A complete logical backup is required before package changes. The upgrade stops if backup fails.'))) + `<p>${technical('/var/backups/xpanel/mariadb-upgrade')}</p>`)
      + section('database-upgrade-apply', t(msgid('Upgrade')), status(t(msgid('Not read')), { 'data-db-plan': true }) + actions(button(t(msgctxt('theme:v2', 'Start upgrade')), { 'data-db-action': 'upgrade' }, true, true)) + note('', { 'data-db-job': true }, true) + note(t(msgctxt('theme:v2', 'Repository upgrades run as verified host jobs. Submission is not completion.'))))
  } else {
    const configuration = engine === 'redis'
      ? [['configPath', msgctxt('theme:v2', 'Configuration file')], ['configState', msgctxt('theme:v2', 'File state')], ['port', msgid('Port')], ['bind', msgctxt('theme:v2', 'Listen addresses')], ['protectedMode', msgctxt('theme:v2', 'Protected mode')], ['unixSocket', msgctxt('theme:v2', 'Unix socket')], ['maxmemory', msgctxt('theme:v2', 'Memory limit')], ['maxmemoryPolicy', msgctxt('theme:v2', 'Eviction policy')], ['requirePass', msgctxt('theme:v2', 'Password required')], ['appendOnly', msgctxt('theme:v2', 'Append-only file')]] as const
      : [['configPath', msgctxt('theme:v2', 'Configuration file')], ['configState', msgctxt('theme:v2', 'File state')], ['port', msgid('Port')], ['bindIp', msgctxt('theme:v2', 'Listen addresses')], ['authorization', msgctxt('theme:v2', 'Access control')], ['dbPath', msgctxt('theme:v2', 'Data directory')]] as const
    body = section(`database-${engine}-next`, t(msgctxt('theme:v2', 'Next step')), status(t(msgid('Not read')), { 'data-db-next': true }) + actions(link(t(msgctxt('theme:v2', 'Manage services')), '/whm/services/more')))
      + split(section(`database-${engine}-configuration`, t(msgid('Configuration')), facts(t, configuration, 'data-db-fact') + note(t(msgctxt('theme:v2', 'Unset settings retain server defaults and secrets are never read.')))), section(`database-${engine}-server`, t(msgid('Server')), facts(t, [['package', msgid('Package')], ['version', msgctxt('theme:v2', 'Installed version')], ['unit', msgctxt('theme:v2', 'Service unit')], ['active', msgctxt('theme:v2', 'Service state')], ['enabled', msgctxt('theme:v2', 'Starts at boot')], ['observedAt', msgctxt('theme:v2', 'Observed at (UTC)')]], 'data-db-fact')), true) + dbServiceWorkspace(input, engine, input.dataAuthority?.canDbService)
  }
  return page(input, `/whm/databases/${engine}`, title, t(msgctxt('theme:v2', 'Read installed database components and review guarded operations.')), status(t(msgctxt('theme:v2', 'Server information has not been read yet.')), { 'data-db-status': true }) + body + dbEngineTemplates(), { 'data-db-engine': `whm-${engine}`, 'data-db-can-read': String(canRead), 'data-db-can-manage': String(canManage) }, button(t(msgid('Read again')), { 'data-db-action': 'refresh' }, !canRead))
}

function tuningWorkspace(input: WhmDatabaseInput): string {
  const { t, canRead } = context(input)
  return page(input, '/whm/databases/tuning', t(msgctxt('theme:v2', 'Database tuning')), t(msgctxt('theme:v2', 'Review observed MariaDB counters before planning changes. No settings are applied here.')), status(t(msgctxt('theme:v2', 'Database tuning observations have not been read yet.')), { 'data-db-tuning-status': true })
    + section('database-tuning-summary', t(msgctxt('theme:v2', 'MariaDB observations')), facts(t, [['version', msgid('Version')], ['observedAt', msgctxt('theme:v2', 'Observed at (UTC)')], ['Uptime', msgctxt('theme:v2', 'Server uptime (seconds)')], ['Uptime_since_flush_status', msgctxt('theme:v2', 'Status interval (seconds)')]], 'data-db-tuning-fact'))
    + section('database-tuning-settings', t(msgctxt('theme:v2', 'Runtime settings')), table(t, t(msgctxt('theme:v2', 'Observed runtime settings')), [msgctxt('theme:v2', 'Setting or counter'), msgctxt('theme:v2', 'Observed value')], { 'data-db-tuning-rows': 'variables' }))
    + section('database-tuning-counters', t(msgctxt('theme:v2', 'Status counters')), table(t, t(msgctxt('theme:v2', 'MariaDB status counters')), [msgctxt('theme:v2', 'Setting or counter'), msgctxt('theme:v2', 'Observed value')], { 'data-db-tuning-rows': 'status' }) + note(t(msgctxt('theme:v2', 'One counter reading does not establish a workload trend.'))))
    + section('database-tuning-plan', t(msgctxt('theme:v2', 'Tuning review plan')), `<div class="v2-whm-data__stack" data-db-tuning-plan data-empty-text="${esc(t(msgctxt('theme:v2', 'Read MariaDB to prepare the advisory plan.')))}">${note(t(msgctxt('theme:v2', 'Read MariaDB to prepare the advisory plan.')))}</div>`) + databaseTuningTemplates(), { 'data-whm-database-tuning': true, 'data-can-read': String(canRead) }, button(t(msgid('Read again')), { 'data-db-tuning-read': true }, !canRead))
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
