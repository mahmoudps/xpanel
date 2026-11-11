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

export function networkPage(t: Translate, route: string, title: string, description: string, bodyHtml: string, canRead: boolean, hooks?: HookAttributes, actionsHtml?: string): string {
  return `<section class="v2-whm-network" data-whm-detail-route="${escapeHtml(route)}" data-capability-state="${canRead ? 'authorized' : 'unavailable'}"${canRead ? '' : ' data-readonly="true"'}${hookAttrs(hooks)}>${pageHeader(t, { route, title, description, breadcrumb: [{ label: t(msgid('Home')), href: '/whm' }, { label: title }], ...(actionsHtml ? { actionsHtml } : {}) })}${!canRead ? `<p role="status">${escapeHtml(t(msgctxt('theme:v2', 'Authorized data has not been read. Controls remain unavailable.')))}</p>` : ''}${bodyHtml}</section>`
}

// A repainted domain row has no tone class: its status pill follows the row's recorded state, as the server row does.
export const WHM_NETWORK_CSS = `.v2-whm-network,.v2-whm-network__stack{display:flex;flex-direction:column;gap:var(--space-4);min-inline-size:0}
.v2-whm-network__groups{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0}
.v2-whm-network__records{display:contents}
.v2-whm-network tr:has([data-whm-filter-row][data-status=suspended]) .v2-pill--state{background:var(--warn-soft);color:var(--warn)}
.v2-whm-network .v2-filter--fields{padding:0}
.v2-whm-network :is([data-whm-table-workspace],[data-dns-file]){display:flex;flex-direction:column;gap:var(--space-2);min-inline-size:0}
.v2-whm-network .v2-card__body p:not([role=alert],[data-state=failed],[data-state=error]){font-size:13px;line-height:1.6;color:var(--text-2)}
.v2-whm-network .v2-card__body p[role=status]:not([data-state=failed]){color:var(--muted)}
.v2-whm-network__fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:start;gap:var(--space-2)}
.v2-whm-network__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(150px,100%),1fr));gap:var(--space-2);margin:0}
.v2-whm-network__facts>div{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0;text-align:start}
.v2-whm-network__facts :is(dt,dd){margin:0;overflow-wrap:anywhere}
.v2-whm-network__facts dt{font-size:12px;color:var(--muted)}
.v2-whm-network__facts dd{font-size:14px}
.v2-whm-network__facts bdi{unicode-bidi:isolate}
.v2-whm-network__actions,.v2-whm-network__chips{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.v2-whm-network__split{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:var(--space-3);align-items:start}
.v2-whm-network__split>aside{gap:var(--space-3)}
.v2-whm-network__split>aside .v2-whm-network__fields{grid-template-columns:minmax(0,1fr)}
.v2-whm-network tbody th{background:none;color:var(--text);font-size:14px;font-weight:500;white-space:normal}
@media(min-width:1101px){.v2-whm-network>.v2-card .v2-whm-network__fields:has(>:nth-child(3):last-child):not(:has(textarea)){grid-template-columns:repeat(3,minmax(0,1fr))}.v2-whm-network>.v2-card .v2-whm-network__facts:has(>:nth-child(6):last-child){grid-template-columns:repeat(3,minmax(0,1fr))}}
.v2-whm-network__split>aside .v2-whm-network__facts{grid-template-columns:repeat(2,minmax(0,1fr))}
.v2-whm-network__split>aside .v2-table,.v2-whm-network__pair .v2-table{min-inline-size:0}
.v2-whm-network__pair .v2-table :is(th,td){padding-inline:8px;white-space:normal;overflow-wrap:break-word}
.v2-whm-network__split>aside .v2-table :is(th,td){padding-inline:12px;white-space:normal;overflow-wrap:break-word}
.v2-whm-network__split>aside .v2-table td bdi{overflow-wrap:anywhere}
.v2-whm-network__pair{display:flex;flex-wrap:wrap;align-items:flex-start;gap:var(--space-3);min-inline-size:0}
.v2-whm-network__pair>*{flex:1 1 340px;min-inline-size:0}
.v2-whm-network__pair>:first-child{flex:1.618 1 520px}
.v2-whm-network__pair--even>:first-child{flex:1 1 380px}
.v2-whm-network__pair--even>:last-child{flex:1 1 380px;padding-inline-start:var(--space-3);border-inline-start:1px solid var(--line)}
.v2-whm-network__toolbar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--space-2)}
.v2-whm-network__filters{display:grid;grid-template-columns:minmax(0,2fr) repeat(3,minmax(0,1fr)) auto;align-items:end;gap:var(--space-2)}
.v2-whm-network__pager{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--space-2)}
.v2-whm-network__pager>.v2-field{flex-direction:row;align-items:center;gap:var(--space-1)}
.v2-whm-network__pager [data-whm-page-status]{flex:1 1 200px;font-size:13px;color:var(--muted)}
.v2-whm-network__rowactions{display:inline-flex;align-items:center;gap:var(--space-1)}
.v2-whm-network .v2-kpi[data-state=unread] .v2-kpi__value>:first-child{font-size:18px;line-height:30px;color:var(--muted)}
.v2-whm-network tr[data-whm-filter-empty]>td{padding:var(--space-3);text-align:center;color:var(--muted)}
.v2-whm-network .v2-kpi-row{grid-template-columns:repeat(4,minmax(0,1fr))}
.v2-whm-network [data-domain-bulk]{flex-direction:row;flex-wrap:wrap;align-items:flex-end;gap:var(--space-2);padding:12px var(--space-2);border:1px solid var(--line);border-radius:var(--radius-notice);background:var(--subtle)}
.v2-whm-network [data-domain-bulk]>label{display:flex;align-items:center;gap:var(--space-1);min-block-size:var(--target);font-size:13px;font-weight:600}
.v2-whm-network [data-domain-bulk]>output{min-block-size:var(--target);display:flex;align-items:center;font-size:13px;color:var(--muted);font-variant-numeric:tabular-nums}
.v2-whm-network [data-domain-bulk]>.v2-whm-network__fields{flex:1 1 360px}
.v2-whm-network [data-domain-bulk]>:is(p,ul){flex:1 1 100%;margin:0}
.v2-whm-network [data-domain-bulk]>:is(p,ul):empty{display:none}
.v2-whm-network [data-whm-filter-table]{min-inline-size:0}
.v2-whm-network [data-whm-filter-table] :is(th,td){padding-inline:8px;white-space:normal}
.v2-whm-network [data-whm-filter-table] .v2-cell-lead .v2-cell-lead__text{min-inline-size:180px;max-inline-size:260px;overflow-wrap:anywhere}
.v2-whm-network__rowactions>a.v2-btn{padding-inline:12px}
@media(max-width:1400px){.v2-whm-network [data-whm-filter-table] .v2-cell-lead__mark{display:none}}
.v2-whm-network [data-whm-filter-table] td:first-child{overflow-wrap:break-word}
.v2-whm-network [data-whm-filter-table] .v2-cell-lead>input{flex:none}
.v2-whm-network__newzone{display:flex;flex-direction:column;gap:var(--space-2);padding-block-start:var(--space-2);border-block-start:1px solid var(--line)}
.v2-whm-network__newzone>.v2-whm-network__filters{grid-template-columns:minmax(0,2fr) minmax(0,1fr) auto}
.v2-whm-network .v2-card__actions .v2-count{padding:2px 10px;background:var(--sunken);font-weight:600}
.v2-whm-network p[data-state]:is([data-state=uncertain],[data-state=stale]){padding:12px var(--space-2);border:1px solid var(--bad-line);border-radius:var(--radius-notice);background:var(--bad-soft);color:var(--text)}
.v2-whm-network table:has(>[data-dns-records]){min-inline-size:0;table-layout:fixed}
.v2-whm-network table:has(>[data-dns-records]) :is(th,td){padding-inline:8px}
.v2-whm-network table:has(>[data-dns-records]) th:nth-child(1){inline-size:20%}
.v2-whm-network table:has(>[data-dns-records]) th:is(:nth-child(2),:nth-child(3),:nth-child(5)){inline-size:112px}
.v2-whm-network table:has(>[data-dns-records]) th:nth-child(6){inline-size:156px}
.v2-whm-network [data-dns-records] :is(input,select){inline-size:100%;min-inline-size:0}
.v2-whm-network [data-dns-records] label{position:absolute;inline-size:1px;block-size:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.v2-whm-network__pair>aside .v2-whm-network__facts,.v2-whm-network__pair>.v2-card .v2-whm-network__facts{grid-template-columns:repeat(auto-fit,minmax(min(130px,100%),1fr))}
.v2-whm-network input[type=file]{inline-size:100%;min-block-size:var(--target);padding:6px;border:1px dashed var(--line-strong);border-radius:var(--radius-control);background:var(--subtle);color:var(--text-2);font-size:13px}
.v2-whm-network input[type=file]::file-selector-button{min-block-size:30px;margin-inline-end:12px;padding:0 12px;border:1px solid var(--line-strong);border-radius:var(--radius-chip);background:var(--surface);color:var(--text);font:inherit;font-weight:600;cursor:pointer}
.v2-whm-network input[type=file]:disabled{opacity:.6}
.v2-whm-network :is(.v2-card__body,.v2-whm-network__fields)>label:has(>input[type=checkbox]){display:flex;align-items:center;gap:var(--space-1);min-block-size:var(--target);font-size:14px}
.v2-whm-network__fields>label:has(>input[type=checkbox]){align-self:end}
.v2-whm-network__fieldsets{display:flex;flex-direction:column;gap:var(--space-3)}
.v2-whm-network fieldset{min-inline-size:0;display:flex;flex-direction:column;gap:var(--space-2);border:0;margin:0;padding:0}
.v2-whm-network legend{float:inline-start;inline-size:100%;padding:0;font-size:14px;font-weight:600}
.v2-whm-network :is(.v2-field,.v2-whm-network__facts) [dir=ltr]{text-align:var(--v2-control-align,start)}
.v2-whm-network__checks,.v2-whm-network__steps{display:flex;flex-direction:column;gap:var(--space-1);margin:0;padding-inline-start:var(--space-2)}
.v2-whm-network__steps{list-style:none;flex-direction:row;flex-wrap:wrap;padding:0;gap:var(--space-2)}
.v2-whm-network__steps>li{display:flex;align-items:center;gap:var(--space-1);min-block-size:var(--target);color:var(--muted)}
.v2-whm-network__steps>li[aria-current=step]{font-weight:600;color:var(--accent)}
.v2-whm-network__steps>li>span:first-child{inline-size:32px;block-size:32px;border:1px solid var(--line);border-radius:50%;display:grid;place-items:center}
.v2-whm-network__names label{display:flex;align-items:center;gap:var(--space-1);min-block-size:var(--target)}
.v2-whm-network__names{display:flex;flex-direction:column;gap:var(--space-1)}
.v2-whm-network .v2-table :is(th,td){text-align:start}
.v2-whm-network .v2-table th{white-space:normal;vertical-align:bottom}
.v2-whm-network__split .v2-table :is(th,td){padding-inline:12px}
.v2-whm-network__split .v2-table td{white-space:normal;overflow-wrap:break-word}
.v2-whm-network .v2-table-scroll{max-inline-size:100%;min-inline-size:0}
.v2-whm-network [data-ssl-rows] :is(th,td),.v2-whm-network table:has([data-ssl-rows]) th{padding-inline:10px}
.v2-whm-network [data-ssl-rows] td:last-child .v2-btn{min-block-size:36px;padding-inline:12px;font-size:13px}
.v2-whm-network [data-ssl-rows] td:last-child .v2-whm-network__actions{gap:8px}
.v2-whm-network select.v2-mono:has(>option[value=""]:checked){font-family:inherit}
.v2-whm-network [data-ssl-install-choices] .v2-whm-network__facts{grid-template-columns:repeat(2,minmax(0,1fr))}
.v2-whm-network [data-ssl-store-actions]{display:flex;flex-wrap:wrap;gap:8px}
@media(min-width:1101px){.v2-whm-network [data-ssl-store-actions]{flex-wrap:nowrap}}
@media(min-width:1101px){.v2-whm-network tbody[data-sec-rows] td:last-child>.v2-whm-network__actions{flex-wrap:nowrap;gap:8px}.v2-whm-network tbody[data-sec-rows="links"] td:nth-child(2){overflow-wrap:anywhere}}
@media(max-width:1439px){.v2-whm-network table:has(>[data-ssl-rows]){display:block;min-inline-size:0}
.v2-whm-network table:has(>[data-ssl-rows])>thead{position:absolute;inline-size:1px;block-size:1px;overflow:hidden;clip-path:inset(50%)}
.v2-whm-network tbody[data-ssl-rows]{display:block}
.v2-whm-network tbody[data-ssl-rows]>tr{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px var(--space-2);padding:var(--space-2);border-block-end:1px solid var(--line)}
.v2-whm-network tbody[data-ssl-rows]>tr:last-child{border-block-end:0}
.v2-whm-network tbody[data-ssl-rows]>tr>td{grid-column:auto;grid-row:auto;justify-self:stretch;padding:0;border:0;min-inline-size:0;text-align:start;overflow-wrap:anywhere}
.v2-whm-network tbody[data-ssl-rows]>tr>td:is(:first-child,:last-child,[colspan]){grid-column:1/-1}
.v2-whm-network tbody[data-ssl-rows]>tr>td:first-child{font-weight:600}
.v2-whm-network tbody[data-ssl-rows]>tr>td:not(:first-child,:last-child,[colspan]){display:flex;flex-direction:column;gap:2px}
.v2-whm-network tbody[data-ssl-rows]>tr>td:not(:first-child,:last-child,[colspan])::before{font-size:12px;color:var(--muted)}
.v2-whm-network tbody[data-ssl-rows]>tr>td:nth-child(2):not([colspan])::before{content:var(--v2-col-2)}
.v2-whm-network tbody[data-ssl-rows]>tr>td:nth-child(3):not([colspan])::before{content:var(--v2-col-3)}
.v2-whm-network tbody[data-ssl-rows]>tr>td:nth-child(4):not([colspan])::before{content:var(--v2-col-4)}
.v2-whm-network tbody[data-ssl-rows]>tr>td:nth-child(5):not([colspan])::before{content:var(--v2-col-5)}
.v2-whm-network tbody[data-ssl-rows]>tr>td:nth-child(6):not([colspan])::before{content:var(--v2-col-6)}
.v2-whm-network tbody[data-ssl-rows]>tr>td:nth-child(7):not([colspan])::before{content:var(--v2-col-7)}}
@media(max-width:1100px){.v2-whm-network__split{grid-template-columns:minmax(0,1fr)}.v2-whm-network__split>aside{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr));align-items:start}}
@media(max-width:1100px){.v2-whm-network__pair--even>:last-child{padding-inline-start:0;border-inline-start:0;padding-block-start:var(--space-3);border-block-start:1px solid var(--line)}.v2-whm-network__filters,.v2-whm-network .v2-kpi-row{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:600px){.v2-whm-network table:has(>[data-dns-records]){display:block}.v2-whm-network tbody[data-dns-records]{display:block}.v2-whm-network tbody[data-dns-records] tr{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding-block:16px}.v2-whm-network tbody[data-dns-records] tr>td:not([colspan]){grid-column:auto;grid-row:auto;justify-self:stretch;text-align:start;display:flex;flex-direction:column;gap:var(--space-1)}.v2-whm-network tbody[data-dns-records] tr>td:is(:nth-child(1),:nth-child(4)):not([colspan]){grid-column:1/-1}.v2-whm-network tbody[data-dns-records] tr>td:nth-child(6):not([colspan]){justify-content:flex-end;align-items:flex-end}.v2-whm-network tbody[data-dns-records] label{position:static;inline-size:auto;block-size:auto;clip-path:none;font-size:12px;font-weight:600;color:var(--muted)}.v2-whm-network tbody[data-whm-dns-zone-rows] tr>td:first-child:not([colspan]){grid-column:1/-1;font-weight:600}.v2-whm-network tbody[data-whm-dns-zone-rows] tr>td:nth-child(n+2):not([colspan]){grid-column:auto;grid-row:auto;justify-self:start;text-align:start}.v2-whm-network tbody[data-whm-dns-zone-rows] tr>td:is(:nth-child(3),:nth-child(5)):not([colspan]){justify-self:end;text-align:end}.v2-whm-network__newzone>.v2-whm-network__filters{grid-template-columns:minmax(0,1fr)}.v2-whm-network tbody[data-ssl-rows]>tr{grid-template-columns:repeat(2,minmax(0,1fr))}.v2-whm-network tbody[data-ssl-rows] td:last-child .v2-btn{min-block-size:var(--target)}.v2-whm-network table[data-whm-filter-table] tr{padding-inline-start:16px}.v2-whm-network table[data-whm-filter-table] tr>:first-child{position:static}.v2-whm-network table[data-whm-filter-table] tr>:nth-child(n+2):not([colspan]){grid-column:auto;grid-row:auto;justify-self:start;text-align:start}.v2-whm-network table[data-whm-filter-table] tr>:first-child:not([colspan]){grid-column:1/-1}.v2-whm-network table[data-whm-filter-table] tr>:is(:nth-child(3),:nth-child(5),:nth-child(7)):not([colspan]){justify-self:end;text-align:end}.v2-whm-network table[data-whm-filter-table] tr>:nth-child(8):not([colspan]){grid-column:1/-1;justify-self:end}.v2-whm-network [data-whm-filter-table] .v2-cell-lead .v2-cell-lead__text{max-inline-size:none;min-inline-size:0}}
@media(max-width:640px){.v2-whm-network__filters{grid-template-columns:minmax(0,1fr)}.v2-whm-network .v2-segmented>button{min-block-size:var(--target)}.v2-whm-network__fields{grid-template-columns:minmax(0,1fr)}.v2-whm-network__facts{grid-template-columns:repeat(2,minmax(0,1fr))}}
`
