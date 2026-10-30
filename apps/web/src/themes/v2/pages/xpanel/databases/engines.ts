import { dbEngineTemplates } from '../../../client-templates/data-workspaces.ts'
import { escapeHtml } from '../../../html.ts'
import {
  databaseContext, dbButton, dbCard, dbEmptyRow, dbFacts, dbField, dbPage, dbTable,
  NO_DATABASE_AUTHORITY, relatedDatabasePage, technical, type DatabasePageAuthority, type DatabasePageProps, type DatabaseRoute,
} from './common.ts'

type AccountEnginePage = 'phpmyadmin' | 'postgresql' | 'phppgadmin'

/** Engine health and SSO readiness are always supplied by the existing authenticated client. */
export function renderV2AccountDatabaseEnginePage(props: DatabasePageProps, page: AccountEnginePage, authority: DatabasePageAuthority = NO_DATABASE_AUTHORITY): string {
  const { account, canRead, canManage, canReadPostgreSqlFacts, direction, locale, t } = databaseContext(props, authority)
  const route = `/databases/${page}` as DatabaseRoute
  const title = page === 'postgresql' ? t('PostgreSQL databases') : page === 'phpmyadmin' ? 'phpMyAdmin' : 'phpPgAdmin'
  // The existing phpMyAdmin open handler uses its read flag for the SSO POST too.
  const connected = page === 'phpmyadmin' ? canManage : canRead
  const unread = t('Not read')
  const facts = (rows: readonly (readonly [string, string])[]): string => dbFacts(rows.map(([key, label]) => ({
    label, valueHtml: key === 'account' && account ? technical(account.username) : escapeHtml(unread), hooks: { 'data-db-fact': key },
  })))
  const status = `<p data-db-status data-state="unread" role="status">${escapeHtml(t('Database server information has not been read yet.'))}</p>`
  const refresh = dbButton(t('Refresh'), { 'data-db-action': 'refresh' }, { disabled: !connected })
  let body: string
  if (page === 'phpmyadmin') {
    const launch = dbCard('phpmyadmin-launch', 'phpMyAdmin', `<p>${escapeHtml(t('Opens phpMyAdmin in a new tab with a temporary database user that can reach only your databases. It expires after 30 minutes, and no password is shown or typed.'))}</p>${status}
${facts([['account', t('Account')], ['installed', t('phpMyAdmin package')], ['databases', t('Databases included')], ['signon', t('Single sign-on')], ['session', t('Session length')], ['ticket', t('Sign-on link validity')]])}
<div class="v2-db-actions">${dbButton(t('Open phpMyAdmin'), { 'data-db-action': 'open' }, { primary: true, disabled: true })}${refresh}</div>
<p class="v2-db-notes">${escapeHtml(t('Create databases and database users on the MariaDB databases page so they stay mapped for backups:'))}</p>${relatedDatabasePage(t, authority, '/databases/mariadb', t('Manage databases'))}`)
    const checks = dbCard('phpmyadmin-checks', t('Sign-on setup'), `<ol class="v2-db-check-list" data-db-checks><li>${escapeHtml(unread)}</li></ol><p class="v2-db-notes">${escapeHtml(t('Each requirement is checked on the server. Sign-on stays unavailable until all of them pass.'))}</p>`)
    body = `<div class="v2-db-columns"><div>${launch}</div><aside aria-label="${escapeHtml(t('Sign-on setup'))}">${checks}</aside></div>`
  } else if (page === 'phppgadmin') {
    body = dbCard('phppgadmin-launch', 'phpPgAdmin', `${status}${facts([['account', t('Account')], ['installed', t('phpPgAdmin package')], ['postgresql', t('PostgreSQL server')], ['signon', t('Single sign-on')]])}
<div class="v2-db-actions">${dbButton(t('Open phpPgAdmin'), undefined, { primary: true, disabled: true })}${refresh}</div>
<p class="v2-db-notes">${escapeHtml(t('phpPgAdmin has no documented single sign-on method, so xPanel does not open it or place a database password in the browser.'))}</p>`)
  } else {
    const server = dbCard('pg-server', t('PostgreSQL server'), `${status}${facts([['account', t('Account')], ['state', t('Server state')], ['version', t('Server version')], ['limit', t('Databases used (MariaDB and PostgreSQL)')], ['observedAt', t('Observed at (UTC)')]])}<div class="v2-db-actions">${refresh}</div>`)
    const savedDatabases = canReadPostgreSqlFacts ? props.databases?.filter(database => database.accountId === account!.id && database.engine === 'postgresql') : undefined
    const databaseRows = savedDatabases === undefined ? dbEmptyRow(5, unread) : savedDatabases.length === 0
      ? dbEmptyRow(5, t(msgctxt('theme:v2', 'No saved databases. Create a database configuration to begin.')))
      : savedDatabases.map(database => `<tr><td>${technical(database.name)}</td>${Array.from({ length: 4 }, () => `<td>${escapeHtml(unread)}</td>`).join('')}</tr>`).join('')
    const databases = dbCard('pg-databases', t('PostgreSQL databases'), dbTable('v2-db-pg-databases', t('PostgreSQL databases'), [t('Database'), t('Owner role'), t('Size'), t('Status'), t('Actions')], databaseRows, { 'data-db-rows': 'databases', 'data-columns': 5 }), { flush: true, description: t('Databases saved for your account, with their size on the server. A database in the trash refuses connections; deleting it from the trash removes it from the server.') })
    const roles = dbCard('pg-users', t('PostgreSQL users'), dbTable('v2-db-pg-users', t('PostgreSQL users'), [t('User'), t('Can sign in'), t('Actions')], dbEmptyRow(3, unread), { 'data-db-rows': 'roles', 'data-columns': 3 }), { flush: true })
    const formTag = canManage ? 'form' : 'div'
    const formAttributes = canManage ? ' novalidate' : ''
    const prefix = account ? `${account.username}_` : ''
    const passwordHelp = `<p class="v2-db-notes">${escapeHtml(t('Use 8 to 256 printable ASCII characters. xPanel keeps only a SCRAM-SHA-256 verifier, never the password.'))}</p>`
    const createDatabase = dbCard('pg-create', t('Create a PostgreSQL database'), `<${formTag} data-db-pg-form="database" class="v2-db-form"${formAttributes}><div class="v2-db-fields">${dbField('v2-db-pg-name', t('Database name'), `<input id="v2-db-pg-name" name="name" type="text" dir="ltr" disabled maxlength="63" autocomplete="off" spellcheck="false"${prefix ? ` placeholder="${escapeHtml(prefix)}app"` : ''}>`)}${dbField('db-pg-owner', t('Owner user'), '<select id="db-pg-owner" name="owner" dir="ltr" disabled></select>')}</div><div class="v2-db-actions">${dbButton(t('Create database'), undefined, { submit: true, primary: true, disabled: true })}</div></${formTag}><p class="v2-db-notes">${escapeHtml(t('The owner user has full control of the database. Other accounts cannot connect to it. Create a user first.'))}</p>`)
    const createUser = dbCard('pg-create-user', t('Create a PostgreSQL user'), `<${formTag} data-db-pg-form="user" class="v2-db-form"${formAttributes}><div class="v2-db-fields">${dbField('v2-db-pg-user', t('User name'), `<input id="v2-db-pg-user" name="name" type="text" dir="ltr" disabled maxlength="32" autocomplete="off" spellcheck="false"${prefix ? ` placeholder="${escapeHtml(prefix)}app"` : ''}>`)}${dbField('v2-db-pg-password', t('Password'), '<input id="v2-db-pg-password" name="password" type="password" dir="ltr" disabled minlength="8" maxlength="256" autocomplete="new-password">')}</div><div class="v2-db-actions">${dbButton(t('Create user'), undefined, { submit: true, primary: true, disabled: true })}</div></${formTag}>${passwordHelp}`)
    const password = dbCard('pg-password', t('Change a PostgreSQL user password'), `<${formTag} data-db-pg-form="password" class="v2-db-form"${formAttributes}><div class="v2-db-fields">${dbField('db-pg-password-user', t('User'), '<select id="db-pg-password-user" name="user" dir="ltr" disabled></select>')}${dbField('v2-db-pg-password-new', t('New password'), '<input id="v2-db-pg-password-new" name="password" type="password" dir="ltr" disabled minlength="8" maxlength="256" autocomplete="new-password">')}</div><div class="v2-db-actions">${dbButton(t('Change password'), undefined, { submit: true, primary: true, disabled: true })}</div></${formTag}>${passwordHelp}`)
    body = `${server}${databases}${roles}<div class="v2-db-columns"><div class="v2-db-stack">${createDatabase}${createUser}</div><aside aria-label="${escapeHtml(t('Change a PostgreSQL user password'))}">${password}</aside></div>`
  }
  return dbPage(t, route, title, t(msgctxt('theme:v2', 'Account-scoped database access with server-read readiness and current session authorization.')),
    `<div class="v2-db-workspace" data-db-engine="account-${page}" data-account="${escapeHtml(account?.id ?? '')}" data-username="${escapeHtml(account?.username ?? '')}" data-db-can-read="${connected}" data-db-can-manage="${canManage}"${canRead ? '' : ' data-capability-unavailable="true"'} lang="${locale}" dir="${direction}">${body}${dbEngineTemplates()}</div>`)
}

export const renderV2PhpMyAdminPage = (props: DatabasePageProps, authority: DatabasePageAuthority = NO_DATABASE_AUTHORITY): string =>
  renderV2AccountDatabaseEnginePage(props, 'phpmyadmin', authority)
export const renderV2PostgreSqlPage = (props: DatabasePageProps, authority: DatabasePageAuthority = NO_DATABASE_AUTHORITY): string =>
  renderV2AccountDatabaseEnginePage(props, 'postgresql', authority)
export const renderV2PhpPgAdminPage = (props: DatabasePageProps, authority: DatabasePageAuthority = NO_DATABASE_AUTHORITY): string =>
  renderV2AccountDatabaseEnginePage(props, 'phppgadmin', authority)
