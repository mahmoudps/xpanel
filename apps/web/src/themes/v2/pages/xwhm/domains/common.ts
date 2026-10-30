import { whmStoredFacts, type WhmStoredFactAuthority } from '../stored-facts.ts'
import type { WhmSurfaceProps } from '../../../../contract.ts'
import type { Translate } from '../../../../../i18n.ts'
import { v2Messages } from '../../../messages.ts'
import { escapeHtml, hookAttrs, type HookAttributes } from '../../../html.ts'
import { card } from '../../../components/card.ts'
import { dataTable, type DataTableRow } from '../../../components/data-table.ts'
import { formField, type FieldControl } from '../../../components/form-field.ts'
import { pageHeader } from '../../../components/page-header.ts'

/** Core supplies route admission and already-filtered collections. These facts never grant API authority. */
export interface WhmNetworkAuthority extends WhmStoredFactAuthority {
  readonly canRead: boolean
  readonly canManage: boolean
  readonly canManageDefaultSite?: boolean
  readonly canCreateServerZone?: boolean
  readonly accountIds?: ReadonlySet<string>
}
export type WhmNetworkProps = WhmSurfaceProps
export const CLOSED_NETWORK_AUTHORITY: WhmNetworkAuthority = { canRead: false, canManage: false }

export function networkContext(props: WhmNetworkProps, authority: WhmNetworkAuthority) {
  const locale = props.locale ?? 'en'
  const canRead = authority.presentation !== 'read-only' && authority.canRead && props.capabilityUnavailable !== true
  const canManage = canRead && authority.canManage
  const principal = props.visibility?.principal ?? props.principal
  const canReadFacts = (ids: readonly string[]): boolean => canRead || whmStoredFacts(props, authority, ids)
  const accounts = canReadFacts(['list-accounts']) ? (props.accounts ?? []).filter(account => (!authority.accountIds || authority.accountIds.has(account.id)) && (principal?.kind !== 'reseller' || account.ownerId === principal.id)) : []
  return { locale, t: v2Messages.translator(locale), canRead, canReadFacts, canManage, accounts }
}

export const netTechnical = (value: string | number | undefined | null, fallback = '—'): string =>
  `<bdi class="v2-mono" dir="ltr">${escapeHtml(value === null || value === undefined ? fallback : value)}</bdi>`

export function netButton(label: string, hooks?: HookAttributes, options: { enabled?: boolean; primary?: boolean; danger?: boolean; submit?: boolean } = {}): string {
  return `<button type="${options.submit ? 'submit' : 'button'}" class="v2-btn${options.primary ? ' v2-btn--primary' : ''}${options.danger ? ' v2-btn--danger' : ''}"${hookAttrs(hooks)}${options.enabled ? '' : ' disabled'}>${escapeHtml(label)}</button>`
}

export const netField = (id: string, label: string, control: FieldControl, help?: string): string =>
  formField({ id: `v2-whm-network-${id}`, label, control: { ...control, disabled: control.disabled ?? true }, ...(help ? { help } : {}) })

export const netCard = (key: string, title: string, bodyHtml: string, hooks?: HookAttributes, actionsHtml?: string): string =>
  card({ title, titleId: `v2-whm-network-${key}-heading`, bodyHtml, hooks, actionsHtml })

export function netTable(t: Translate, key: string, caption: string, columns: readonly string[], rows: readonly DataTableRow[], emptyText: string, hooks?: HookAttributes): string {
  return dataTable(t, { id: `v2-whm-network-${key}-table`, caption, columns: columns.map(label => ({ label })), rows, emptyText, bodyHooks: hooks })
}

export const netFacts = (rows: readonly { label: string; valueHtml: string; hooks?: HookAttributes }[]): string =>
  `<dl class="v2-whm-network__facts">${rows.map(row => `<div><dt>${escapeHtml(row.label)}</dt><dd${hookAttrs(row.hooks)}>${row.valueHtml}</dd></div>`).join('')}</dl>`

export function networkPage(t: Translate, route: string, title: string, description: string, bodyHtml: string, canRead: boolean, hooks?: HookAttributes): string {
  return `<section class="v2-whm-network" data-whm-detail-route="${escapeHtml(route)}"${canRead ? '' : ' data-readonly="true"'}${hookAttrs(hooks)}>${pageHeader(t, { route, title, description, breadcrumb: [{ label: t(msgid('Home')), href: '/whm' }, { label: title }] })}${!canRead ? `<p role="status">${escapeHtml(t(msgctxt('theme:v2', 'Authorized data has not been read. Controls remain unavailable.')))}</p>` : ''}${bodyHtml}</section>`
}

export const WHM_NETWORK_CSS = `.v2-whm-network,.v2-whm-network__stack{display:flex;flex-direction:column;gap:var(--space-4);min-inline-size:0}
.v2-whm-network__groups{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0}
.v2-whm-network__fields,.v2-whm-network__facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2)}
.v2-whm-network__facts{margin:0}
.v2-whm-network__facts>div{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0;text-align:start}
.v2-whm-network__facts :is(dt,dd){margin:0;overflow-wrap:anywhere}
.v2-whm-network__facts dt{font-size:13px;font-weight:600;color:var(--text-2)}
.v2-whm-network__facts bdi{unicode-bidi:isolate}
.v2-whm-network__actions,.v2-whm-network__chips{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.v2-whm-network__split{display:grid;grid-template-columns:minmax(0,2fr) minmax(280px,1fr);gap:var(--space-3);align-items:start}
.v2-whm-network__fieldsets{display:flex;flex-direction:column;gap:var(--space-3)}
.v2-whm-network fieldset{min-inline-size:0;display:flex;flex-direction:column;gap:var(--space-2);border:0;margin:0;padding:0}
.v2-whm-network legend{font-weight:600;margin-block-end:var(--space-1);padding:0}
.v2-whm-network :is(.v2-field,.v2-whm-network__facts) [dir=ltr]{text-align:var(--v2-control-align,start)}
.v2-whm-network__checks,.v2-whm-network__steps{display:flex;flex-direction:column;gap:var(--space-1);margin:0;padding-inline-start:var(--space-2)}
.v2-whm-network__steps{list-style:none;flex-direction:row;flex-wrap:wrap;padding:0;gap:var(--space-2)}
.v2-whm-network__steps>li{display:flex;align-items:center;gap:var(--space-1);min-block-size:var(--target);color:var(--muted)}
.v2-whm-network__steps>li[aria-current=step]{font-weight:600;color:var(--accent)}
.v2-whm-network__steps>li>span:first-child{inline-size:32px;block-size:32px;border:1px solid var(--line);border-radius:50%;display:grid;place-items:center}
.v2-whm-network__names label{display:flex;align-items:center;gap:var(--space-1);min-block-size:var(--target)}
.v2-whm-network__names{display:flex;flex-direction:column;gap:var(--space-1)}
.v2-whm-network .v2-table :is(th,td){text-align:start}
.v2-whm-network .v2-table-scroll{max-inline-size:100%;min-inline-size:0}
@media(max-width:1000px){.v2-whm-network__split{grid-template-columns:minmax(0,1fr)}}
@media(max-width:640px){.v2-whm-network__fields,.v2-whm-network__facts{grid-template-columns:minmax(0,1fr)}}
`
