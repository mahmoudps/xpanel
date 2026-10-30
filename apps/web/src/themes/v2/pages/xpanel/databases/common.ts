import type { PanelSurfaceProps, ThemeViewProps } from '../../../../contract.ts'
import type { Translate } from '../../../../../i18n.ts'
import { localeDirection } from '../../../../../i18n.ts'
import { normalizeAsciiDigits } from '../../../../../display-format.ts'
import { card, pageHeader } from '../../../components/index.ts'
import { escapeHtml, hookAttrs, type HookAttributes } from '../../../html.ts'
import { v2Messages } from '../../../messages.ts'

export type DatabasePageProps = PanelSurfaceProps & ThemeViewProps
export type DatabaseRoute = '/databases/mariadb' | '/databases/insights' | '/databases/remote-access'
  | '/databases/phpmyadmin' | '/databases/postgresql' | '/databases/phppgadmin'

/** Decisions supplied by core after account, catalog, listener and session admission. */
export interface DatabasePageAuthority {
  readonly presentation?: 'live' | 'read-only'
  readonly canRead: boolean
  readonly canManage: boolean
  /** Supplied saved metadata, never permission to contact a database provider. */
  readonly canReadFacts?: boolean
  /** Core's current feature/team-filtered permissions; required for fact-only reads. */
  readonly authorizedTools?: ReadonlySet<string>
  /** Related pages core has admitted for this caller, independent of the current page. */
  readonly relatedRoutes?: ReadonlySet<DatabaseRoute>
}

export const NO_DATABASE_AUTHORITY: DatabasePageAuthority = Object.freeze({ canRead: false, canManage: false })

export function databaseContext(props: DatabasePageProps, authority: DatabasePageAuthority) {
  const locale = props.locale ?? 'en'
  const principal = props.visibility?.principal
  const account = principal && (principal.kind !== 'user' || principal.accountId !== props.account?.id)
    ? undefined : props.account
  const canRead = account !== undefined && authority.canRead === true
  const matchingUser = principal?.kind === 'user' && principal.accountId === account?.id
  const factsAllowed = (tool: string): boolean => account !== undefined
    && (authority.authorizedTools === undefined
      ? canRead
      : (canRead || authority.canReadFacts === true && matchingUser) && authority.authorizedTools.has(tool))
  return {
    locale, account, canRead,
    canReadDatabaseFacts: factsAllowed('mysql-databases'),
    canReadUserFacts: factsAllowed('mysql-users'),
    canReadPostgreSqlFacts: factsAllowed('postgresql-databases'),
    canManage: canRead && authority.canManage === true && account?.status === 'active',
    t: v2Messages.translator(locale),
    direction: localeDirection(locale),
  }
}

export const technical = (value: string | number): string =>
  `<bdi dir="ltr" class="v2-mono">${escapeHtml(normalizeAsciiDigits(value))}</bdi>`

export const dbButton = (label: string, hooks?: HookAttributes, options: { disabled?: boolean; primary?: boolean; submit?: boolean } = {}): string =>
  `<button type="${options.submit ? 'submit' : 'button'}" class="v2-btn${options.primary ? ' v2-btn--primary' : ''}"${hookAttrs(hooks)}${options.disabled ? ' disabled' : ''}>${escapeHtml(label)}</button>`

export const dbField = (id: string, label: string, controlHtml: string, help?: string): string =>
  `<div class="v2-field"><label for="${escapeHtml(id)}">${escapeHtml(label)}</label>${controlHtml}${help ? `<p class="v2-field__help">${escapeHtml(help)}</p>` : ''}</div>`

export const dbFacts = (rows: readonly { label: string; valueHtml: string; hooks?: HookAttributes }[], hooks?: HookAttributes): string =>
  `<dl class="v2-db-facts"${hookAttrs(hooks)}>${rows.map(row => `<div><dt>${escapeHtml(row.label)}</dt><dd${hookAttrs(row.hooks)}>${row.valueHtml}</dd></div>`).join('')}</dl>`

export const dbCard = (key: string, title: string, bodyHtml: string, options: { flush?: boolean; description?: string; actionsHtml?: string } = {}): string =>
  card({ titleId: `v2-db-${key}-title`, title, bodyHtml, ...options })

export const dbEmptyRow = (columns: number, text: string): string =>
  `<tr><td colspan="${columns}" class="v2-db-unread">${escapeHtml(text)}</td></tr>`

export const dbTable = (id: string, title: string, headings: readonly string[], bodyHtml: string, bodyHooks: HookAttributes, tableHooks?: HookAttributes): string =>
  `<div class="v2-db-table-region" role="region" tabindex="0" aria-label="${escapeHtml(title)}"><table id="${escapeHtml(id)}" class="v2-table"${hookAttrs(tableHooks)}><caption class="v2-sr">${escapeHtml(title)}</caption><thead><tr>${headings.map(heading => `<th scope="col">${escapeHtml(heading)}</th>`).join('')}</tr></thead><tbody${hookAttrs(bodyHooks)}>${bodyHtml}</tbody></table></div>`

export function dbPage(t: Translate, route: DatabaseRoute, title: string, description: string, bodyHtml: string): string {
  return `<div class="v2-db-page">${pageHeader(t, {
    route, title, description, breadcrumb: [{ label: t('Home'), href: '/home' }, { label: t('Databases') }, { label: title }],
  })}${bodyHtml}</div>`
}

export function relatedDatabasePage(t: Translate, authority: DatabasePageAuthority, route: DatabaseRoute, label: string): string {
  return authority.relatedRoutes?.has(route)
    ? `<a class="v2-btn" href="${route}">${escapeHtml(label)}</a>`
    : dbButton(label, undefined, { disabled: true })
}
