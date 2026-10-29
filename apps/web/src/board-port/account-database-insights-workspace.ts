import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'
import { ACCOUNT_TOOL_STYLE } from './account-ssh-workspace.ts'

/** Read-only sizes, largest tables and server existence for the owner's own MariaDB databases and users. */
export function renderAccountDatabaseInsightsWorkspace(input: { lang: Locale; accountId: string; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => translator(input.lang)(message, values), off = input.canManage ? '' : ' disabled', unread = t(msgctxt('account-database-insights-workspace', 'Not read'))
  const fact = (key: string, label: string): string => `<div><dt>${label}</dt><dd><bdi dir="ltr" data-insights-fact="${key}">${unread}</bdi></dd></div>`
  const table = (key: string, label: string, columns: readonly string[]): string => `<div class="xp-acct-tool__table" tabindex="0" role="region" aria-label="${label}"><table class="xp-table"><thead><tr>${columns.map(column => `<th scope="col">${column}</th>`).join('')}</tr></thead><tbody data-insights-${key}><tr><td colspan="${columns.length}">${t('These records have not been read.')}</td></tr></tbody></table></div>`
  const sizes = [t('Data'), t('Indexes'), t('Free space')]
  return `<div class="xp-acct-tool" data-account-database-insights data-account="${escapeHtml(input.accountId)}" data-insights-manage="${input.canManage}" lang="${input.lang}" dir="${localeDirection(input.lang)}">${ACCOUNT_TOOL_STYLE}
    <style>[data-account-database-insights] .xp-acct-tool__card{padding:24px}[data-account-database-insights] .xp-acct-tool__card h2{font-size:var(--xp-type-card);line-height:var(--xp-leading-card)}[data-account-database-insights] [aria-labelledby="account-insights-tables"] .xp-acct-tool__table{min-inline-size:0}[data-account-database-insights] [aria-labelledby="account-insights-tables"] table.xp-table:has(>tbody[data-insights-tables]>tr>td:not([colspan])){width:max-content!important;min-inline-size:100%;table-layout:auto}[data-account-database-insights] [aria-labelledby="account-insights-tables"] table.xp-table>tbody[data-insights-tables]>tr>td:nth-child(2)>bdi[dir="ltr"]{white-space:nowrap!important;overflow-wrap:normal!important;word-break:normal!important}[data-account-database-insights] [aria-labelledby="account-insights-tables"] .xp-acct-tool__table:focus-visible{outline:2px solid var(--xp-accent,#1d5bd6);outline-offset:2px}@media(max-width:600px){[data-account-database-insights] .xp-acct-tool__card{padding:16px}}</style>
    <section class="xp-acct-tool__card" aria-labelledby="account-insights-overview"><h2 id="account-insights-overview">${t('Overview')}</h2>
      <dl class="xp-acct-tool__facts">${fact('databases', t('Databases'))}${fact('size', t('Total size'))}${fact('tables', t('Tables'))}${fact('users', t('Database users'))}${fact('at', t('Read at (UTC)'))}</dl>
      <div class="xp-acct-tool__actions"><button type="button" class="xp-btn xp-btn--primary" data-insights-read${off}>${t('Read insights')}</button><a class="xp-btn" href="/databases/mariadb">${t('Manage databases')}</a></div>
      <p class="xp-help">${t('Read-only. Sizes and row counts come from the MariaDB information schema; for InnoDB tables they are estimates. Shows up to 50 databases with the 20 largest tables of each, and up to 200 database users. Create, change or delete them on the MariaDB databases page.')}</p></section>
    <section class="xp-acct-tool__card" aria-labelledby="account-insights-databases"><h2 id="account-insights-databases">${t('Databases')}</h2>
      ${table('databases', t('Databases'), [t('Database'), t('On server'), t('Tables'), ...sizes, t('Collation')])}</section>
    <section class="xp-acct-tool__card" aria-labelledby="account-insights-tables"><h2 id="account-insights-tables">${t('Largest tables')}</h2>
      <div class="xp-acct-tool__fields"><div class="xp-field"><label for="account-insights-database">${t('Database')}</label><select id="account-insights-database" class="xp-select" dir="ltr" data-insights-database disabled></select></div></div>
      ${table('tables', t('Largest tables'), [t('Table'), t('Engine'), t('Rows (estimate)'), ...sizes])}</section>
    <section class="xp-acct-tool__card" aria-labelledby="account-insights-users"><h2 id="account-insights-users">${t('Database users')}</h2>
      ${table('users', t('Database users'), [t('User'), t('On server'), t('Host entries')])}</section>
    <p data-insights-status role="status" data-state="unread">${input.canManage ? t('Reading database insights is ready.') : t('Database insights are unavailable here. Nothing was read.')}</p>
  </div>`
}
