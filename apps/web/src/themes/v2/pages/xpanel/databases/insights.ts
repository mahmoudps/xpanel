import { databaseInsightsTemplates } from '../../../client-templates/data-workspaces.ts'
import { escapeHtml } from '../../../html.ts'
import {
  databaseContext, dbButton, dbCard, dbEmptyRow, dbFacts, dbField, dbPage, dbTable,
  NO_DATABASE_AUTHORITY, relatedDatabasePage, type DatabasePageAuthority, type DatabasePageProps,
} from './common.ts'

export function renderV2DatabaseInsightsPage(props: DatabasePageProps, authority: DatabasePageAuthority = NO_DATABASE_AUTHORITY): string {
  const { account, canRead, direction, locale, t } = databaseContext(props, authority)
  const unread = t('Not read')
  const facts = dbFacts([
    { label: t('Databases'), valueHtml: `<bdi dir="ltr" data-insights-fact="databases">${escapeHtml(unread)}</bdi>` },
    { label: t('Total size'), valueHtml: `<bdi dir="ltr" data-insights-fact="size">${escapeHtml(unread)}</bdi>` },
    { label: t('Tables'), valueHtml: `<bdi dir="ltr" data-insights-fact="tables">${escapeHtml(unread)}</bdi>` },
    { label: t('Database users'), valueHtml: `<bdi dir="ltr" data-insights-fact="users">${escapeHtml(unread)}</bdi>` },
    { label: t('Read at (UTC)'), valueHtml: `<bdi dir="ltr" data-insights-fact="at">${escapeHtml(unread)}</bdi>` },
  ])
  const overview = dbCard('insights-overview', t('Overview'), `${facts}<div class="v2-db-actions">${dbButton(t('Read insights'), { 'data-insights-read': true }, { primary: true, disabled: !canRead })}${relatedDatabasePage(t, authority, '/databases/mariadb', t('Manage databases'))}</div>
<p class="v2-db-notes">${escapeHtml(t('Read-only. Sizes and row counts come from the MariaDB information schema; for InnoDB tables they are estimates. Shows up to 50 databases with the 20 largest tables of each, and up to 200 database users. Create, change or delete them on the MariaDB databases page.'))}</p>`)
  const databases = dbCard('insights-databases', t('Databases'), dbTable('v2-db-insights-databases', t('Databases'),
    [t('Database'), t('On server'), t('Tables'), t('Data'), t('Indexes'), t('Free space'), t('Collation')], dbEmptyRow(7, t('These records have not been read.')), { 'data-insights-databases': true }), { flush: true })
  const tables = dbCard('insights-tables', t('Largest tables'), `${dbField('v2-db-insights-database', t('Database'), '<select id="v2-db-insights-database" data-insights-database dir="ltr" disabled></select>')}${dbTable('v2-db-insights-tables', t('Largest tables'),
    [t('Table'), t('Engine'), t('Rows (estimate)'), t('Data'), t('Indexes'), t('Free space')], dbEmptyRow(6, t('These records have not been read.')), { 'data-insights-tables': true })}`)
  const users = dbCard('insights-users', t('Database users'), dbTable('v2-db-insights-users', t('Database users'),
    [t('User'), t('On server'), t('Host entries')], dbEmptyRow(3, t('These records have not been read.')), { 'data-insights-users': true }), { flush: true })
  const status = `<p data-insights-status data-state="unread" role="status">${escapeHtml(canRead ? t('Reading database insights is ready.') : t('Database insights are unavailable here. Nothing was read.'))}</p>`
  return dbPage(t, '/databases/insights', t('Database insights'), t(msgctxt('theme:v2', 'Read actual database sizes and largest tables without changing stored configuration.')),
    `<div class="v2-db-workspace" data-account-database-insights data-account="${escapeHtml(account?.id ?? '')}" data-insights-manage="${canRead}"${canRead ? '' : ' data-capability-unavailable="true"'} lang="${locale}" dir="${direction}">${overview}${databases}${tables}${users}${status}${databaseInsightsTemplates()}</div>`)
}
