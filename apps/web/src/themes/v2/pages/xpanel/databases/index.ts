import type { DatabasePageAuthority, DatabasePageProps, DatabaseRoute } from './common.ts'
import { NO_DATABASE_AUTHORITY } from './common.ts'
import { renderV2MariaDbPage } from './mariadb.ts'
import { renderV2DatabaseInsightsPage } from './insights.ts'
import { renderV2DatabaseRemotePage } from './remote.ts'
import { renderV2PhpMyAdminPage, renderV2PostgreSqlPage, renderV2PhpPgAdminPage } from './engines.ts'

export { renderV2MariaDbPage } from './mariadb.ts'
export { renderV2DatabaseInsightsPage } from './insights.ts'
export { renderV2DatabaseRemotePage } from './remote.ts'
export { renderV2PhpMyAdminPage, renderV2PostgreSqlPage, renderV2PhpPgAdminPage } from './engines.ts'
export { PANEL_DATABASES_CSS } from './styles.ts'
export type { DatabasePageAuthority, DatabasePageProps, DatabaseRoute } from './common.ts'

export const V2_DATABASE_ROUTES: readonly DatabaseRoute[] = Object.freeze([
  '/databases/mariadb', '/databases/insights', '/databases/remote-access',
  '/databases/phpmyadmin', '/databases/postgresql', '/databases/phppgadmin',
])

/** Unrelated routes stay with their own renderer; they are never treated as database outages. */
export function renderV2PanelDatabasePage(props: DatabasePageProps, authority: DatabasePageAuthority = NO_DATABASE_AUTHORITY): string | undefined {
  switch (props.activeRoute) {
    case '/databases/mariadb': return renderV2MariaDbPage(props, authority)
    case '/databases/insights': return renderV2DatabaseInsightsPage(props, authority)
    case '/databases/remote-access': return renderV2DatabaseRemotePage(props, authority)
    case '/databases/phpmyadmin': return renderV2PhpMyAdminPage(props, authority)
    case '/databases/postgresql': return renderV2PostgreSqlPage(props, authority)
    case '/databases/phppgadmin': return renderV2PhpPgAdminPage(props, authority)
    default: return undefined
  }
}
