import type { PanelSurfaceProps } from '../../../../contract.ts'
import type { Translate } from '../../../../../i18n.ts'
import { escapeHtml, hookAttrs, type HookAttributes } from '../../../html.ts'
import { errorState, pageHeader, type PageHeaderProps } from '../../../components/index.ts'
import { phoneLabelCss } from '../settings/common.ts'

export { phoneLabels } from '../settings/common.ts'

/** Core supplies the result of the current route, principal and capability checks. */
export interface PanelServiceAuthority {
  readonly canManage: boolean
  readonly canRead?: boolean
  readonly presentation?: 'live' | 'read-only'
  readonly canReadFacts?: boolean
  readonly authorizedTools?: ReadonlySet<string>
  /** Verified tools the principal may use; a section connects only when its tool is here. */
  readonly qualifiedTools?: ReadonlySet<string>
}

export const latinDigits = (value: string): string => value.replace(/[\u0660-\u0669\u06f0-\u06f9]/gu,
  digit => String(digit.charCodeAt(0) - (digit.charCodeAt(0) >= 0x6f0 ? 0x6f0 : 0x660)))

export const technical = (value: string | number): string => `<bdi dir="ltr" class="v2-mono">${escapeHtml(latinDigits(String(value)))}</bdi>`

export const serviceButton = (label: string, hooks?: HookAttributes, disabled = false, primary = false): string =>
  `<button type="button" class="v2-btn${primary ? ' v2-btn--primary' : ''}"${hookAttrs(hooks)}${disabled ? ' disabled' : ''}>${escapeHtml(label)}</button>`

export function serviceField(id: string, label: string, control: string, help?: string): string {
  const helpId = `${id}-help`
  const described = help ? control.replace(/^<(input|select|textarea)\b/, `<$1 aria-describedby="${escapeHtml(helpId)}"`) : control
  return `<div class="v2-field"><label for="${escapeHtml(id)}">${escapeHtml(label)}</label>${described}${help ? `<p class="v2-field__help" id="${escapeHtml(helpId)}">${escapeHtml(help)}</p>` : ''}</div>`
}

export const serviceFacts = (facts: readonly { label: string; valueHtml: string }[], hooks?: HookAttributes): string =>
  `<dl class="v2-panel-service-facts"${hookAttrs(hooks)}>${facts.map(fact => `<div><dt>${escapeHtml(fact.label)}</dt><dd>${fact.valueHtml}</dd></div>`).join('')}</dl>`

/** Board filter row. The shared list filter applies it to the data-list-row rows of the nearest data-list-filter
 * ancestor; the first option is the empty value (every row). Closed while the list cannot be read. */
export const listFilter = (t: Translate, input: { id: string; label: string; group: string; key: string; options: readonly (readonly [string, string])[]; open: boolean }): string => {
  const off = input.open ? '' : ' disabled'
  return `<div class="v2-panel-service__filter"><div class="v2-field"><label for="${escapeHtml(input.id)}">${escapeHtml(input.label)}</label><input id="${escapeHtml(input.id)}" type="search" autocomplete="off" spellcheck="false" aria-describedby="${escapeHtml(input.id)}-count" data-list-filter-search${off}></div><div class="v2-panel-service__segments" role="group" aria-label="${escapeHtml(input.group)}" data-list-filter-key="${escapeHtml(input.key)}">${input.options.map(([value, label], index) => `<button type="button" data-list-filter-value="${escapeHtml(value)}" aria-pressed="${index === 0}"${off}>${escapeHtml(label)}</button>`).join('')}</div><p class="v2-panel-service__filter-note" id="${escapeHtml(input.id)}-count" role="status">${escapeHtml(t('Rows shown'))} <bdi dir="ltr" class="v2-num" data-list-filter-count>0</bdi></p></div>`
}

/** Shown by the list filter when rows were read but none matches. */
export const listFilterEmpty = (message: string): string => `<p class="v2-panel-service__filter-empty" data-list-filter-empty hidden>${escapeHtml(message)}</p>`

export const serviceHeader = (t: Translate, route: string, title: string, description: string, head?: Pick<PageHeaderProps, 'actionsHtml' | 'status' | 'stamp'>): string => pageHeader(t, {
  route, title, description, breadcrumb: [{ label: t('Home'), href: '/home' }, { label: title }], ...head,
})

export function missingServiceAccount(t: Translate, props: PanelSurfaceProps): string | undefined {
  return props.account ? undefined : errorState(t, { lead: t(msgctxt('theme:v2', 'An authorized account has not been read.')) })
}

/** Page-scoped layout; technical isolation does not move values away from their labels. */
export const PANEL_SERVICES_CSS = `.v2-panel-service{display:grid;gap:var(--space-4);min-inline-size:0}
.v2-panel-service__columns{display:grid;grid-template-columns:minmax(0,1fr) minmax(240px,320px);align-items:start;gap:var(--space-3);min-inline-size:0}
.v2-panel-service__main,.v2-panel-service__aside{display:grid;gap:var(--space-3);min-inline-size:0}
.v2-panel-service__fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:var(--space-2);min-inline-size:0}
.v2-panel-service__actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.v2-panel-service-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:var(--space-2);margin:0}
.v2-panel-service-facts>div{display:grid;gap:var(--space-1);min-inline-size:0}
.v2-panel-service-facts :is(dt,dd){margin:0;text-align:start;overflow-wrap:anywhere}
.v2-panel-service-facts dt{color:var(--muted);font-size:12px}
.v2-panel-service :is(input,select,textarea)[dir=ltr]{text-align:start}
.v2-panel-service :is(input,select,textarea)[dir=ltr]{text-align:var(--v2-control-align,start)}
.v2-panel-service .v2-field{align-items:stretch}
.v2-panel-service .v2-field>label{margin:0;text-align:start}
.v2-panel-service__table{max-inline-size:100%;overflow:auto;min-inline-size:0}
.v2-panel-service__table :is(th,td){text-align:start;vertical-align:top;padding:12px 16px}
.v2-panel-service__table bdi{unicode-bidi:isolate}
.v2-panel-service__table .v2-panel-service__actions{gap:var(--space-1)}
.v2-panel-service__note{display:grid;gap:var(--space-1);min-inline-size:0}
.v2-panel-service__note p{margin:0;color:var(--muted);line-height:1.6}
.v2-panel-service__technical{display:block;white-space:pre-wrap;overflow-wrap:anywhere;min-inline-size:0;max-inline-size:100%;text-align:start}
.v2-panel-service fieldset{border:0;margin:0;padding:0;display:grid;gap:var(--space-2);min-inline-size:0}
.v2-panel-service legend{padding:0;margin-block-end:var(--space-2);font-weight:600}
.v2-panel-service .v2-check{display:flex;align-items:center;gap:var(--space-1);min-block-size:var(--target)}
.v2-panel-service .v2-check>input{flex:none;margin:0}
.v2-panel-service [hidden],.v2-panel-service tr[data-list-row][hidden]{display:none}
.v2-panel-service__pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,400px),1fr));align-items:start;gap:var(--space-3);min-inline-size:0}
.v2-panel-service__pair>*{min-inline-size:0}
.v2-panel-service__pair--three{grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));align-items:stretch}
.v2-panel-service__scroll{overflow-x:auto;white-space:pre;max-inline-size:100%;margin:0}
.v2-panel-service__fields--wide{grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr))}
.v2-panel-service textarea{inline-size:100%;resize:vertical;min-inline-size:0}
.v2-panel-service .v2-card__body>[role=status]:not([hidden]){font-size:13px;color:var(--text-2);padding:10px 12px;border-radius:var(--radius-control);background:var(--sunken);margin:0}
.v2-panel-service__note>.v2-pill{justify-self:start}
.v2-panel-service__choices{display:flex;flex-wrap:wrap;gap:0 var(--space-3)}
.v2-panel-service .v2-kpi[data-unread] .v2-kpi__value>:first-child{font-size:20px;line-height:30px;letter-spacing:0;color:var(--text-2)}
.v2-panel-service__table table{font-size:13px}
.v2-panel-service__columns--drawer{grid-template-columns:minmax(0,1fr) minmax(340px,440px)}
.v2-panel-service__five{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:var(--space-1);min-inline-size:0}
.v2-panel-service__five label{font-size:12px}.v2-panel-service__five input{padding-inline:8px;min-inline-size:0;inline-size:100%}
.v2-panel-service__filter{display:flex;flex-wrap:wrap;align-items:flex-end;gap:var(--space-2);min-inline-size:0}
.v2-panel-service__filter>.v2-field{flex:0 1 320px;min-inline-size:200px}.v2-panel-service__filter input{inline-size:100%}
.v2-panel-service__segments{display:inline-flex;flex-wrap:wrap;gap:4px;padding:4px;border-radius:var(--radius-control);background:var(--sunken)}
.v2-panel-service__segments>button{min-block-size:var(--target);min-inline-size:var(--target);padding:0 12px;border:0;border-radius:var(--radius-chip);background:transparent;color:var(--muted);font-size:13px;font-weight:600}
.v2-panel-service__segments>button[aria-pressed=true]{background:var(--surface);color:var(--text-2);box-shadow:var(--shadow)}
.v2-panel-service__filter-note{display:flex;align-items:center;gap:var(--space-1);min-block-size:var(--target);margin:0;margin-inline-start:auto;font-size:12px;color:var(--muted)}
.v2-panel-service__filter-empty{margin:0;padding:var(--space-3);text-align:center;font-size:13px;color:var(--muted)}
.v2-panel-service__head-field{display:flex;flex-direction:column;gap:var(--space-1);inline-size:240px;max-inline-size:100%}
.v2-panel-service__head-field label{padding-inline:13px;font-size:13px;line-height:1.25;font-weight:600}.v2-panel-service__head-field select{inline-size:100%}
.v2-panel-service__editor{display:contents}
.v2-panel-service .v2-page-head__actions{align-items:flex-end}
.v2-panel-service__rows{display:flex;flex-direction:column;margin:0}
.v2-panel-service__rows>div{display:flex;flex-direction:column;gap:4px;padding:10px 0;min-inline-size:0}.v2-panel-service__rows>div+div{border-block-start:1px solid var(--line)}
.v2-panel-service__rows :is(dt,dd){margin:0;text-align:start;overflow-wrap:anywhere}.v2-panel-service__rows dt{font-size:12px;color:var(--muted)}.v2-panel-service__rows dd{font-size:13px}
@media(min-width:601px){.v2-panel-service__table td :is([data-xp-slot=actions],.v2-panel-service__actions),.v2-panel-service__table td[data-xp-slot=actions]{flex-wrap:nowrap;white-space:nowrap}.v2-panel-service__table td :is([data-xp-slot=actions],.v2-panel-service__actions):has(>:nth-child(3)){flex-wrap:wrap;min-inline-size:190px}}
.v2-panel-service__table [data-xp-slot=command]{overflow-wrap:anywhere}.v2-panel-service__table [data-account-ssl-rows] td:nth-child(3){white-space:nowrap}.v2-panel-service__table [data-xp-slot=schedule]{white-space:nowrap}
@media(min-width:601px){.v2-panel-service__table [data-xp-slot=command]{display:inline-block;min-inline-size:180px}.v2-panel-service__table :is(th,td){padding-inline:12px}.v2-panel-service__table td>:is(input,select){inline-size:100%;min-inline-size:4.5em}}
@media(min-width:1280px){.v2-panel-service__table [data-xp-slot=command]{min-inline-size:260px}.v2-panel-service__table td :is([data-xp-slot=actions],.v2-panel-service__actions):has(>:nth-child(3)){min-inline-size:164px}}
.v2-panel-service .v2-steps--inline>.v2-step{flex-basis:150px}
@media(min-width:901px){.v2-panel-service__editor .v2-table{table-layout:fixed}.v2-panel-service__editor .v2-table th:first-child{inline-size:18%}.v2-panel-service__editor .v2-table th:nth-child(2){inline-size:132px}.v2-panel-service__editor .v2-table th:nth-child(3){inline-size:104px}.v2-panel-service__editor .v2-table th:nth-child(5){inline-size:100px}.v2-panel-service__editor .v2-table th:nth-child(6){inline-size:172px}}
@media(max-width:600px){.v2-panel-service__table table:not(:has(td)) thead tr{display:flex;flex-wrap:wrap;gap:4px var(--space-2);padding:var(--space-1) 0}.v2-panel-service__table table:not(:has(td)) th{background:none}.v2-panel-service__editor .v2-table tr{align-items:end}.v2-panel-service__editor .v2-table td:has(>:is(input,select)){display:flex;flex-direction:column;gap:4px}.v2-panel-service__editor .v2-table td>:is(input,select){inline-size:100%}.v2-panel-service__segments>button{min-block-size:var(--target)}}
@media(max-width:600px){.v2-panel-service .v2-kpi-row{grid-template-columns:repeat(2,minmax(0,1fr))}.v2-panel-service .v2-kpi-row>.v2-kpi:last-child:nth-child(odd){grid-column:1/-1}}
${phoneLabelCss('.v2-panel-service')}
@media(max-width:1100px){.v2-panel-service__columns,.v2-panel-service__columns--drawer{grid-template-columns:minmax(0,1fr)}}
@media(max-width:600px){.v2-panel-service__fields{grid-template-columns:minmax(0,1fr)}.v2-panel-service .v2-card{padding:var(--space-2)}.v2-panel-service .v2-card--flush{padding:0}}
@media(min-width:601px){.v2-panel-service__table table:has(>[data-account-ssl-rows]){table-layout:fixed;inline-size:100%}.v2-panel-service__table table:has(>[data-account-ssl-rows]) th:nth-child(1){inline-size:18%}.v2-panel-service__table table:has(>[data-account-ssl-rows]) th:nth-child(2){inline-size:14%}.v2-panel-service__table table:has(>[data-account-ssl-rows]) th:nth-child(3){inline-size:15%}.v2-panel-service__table table:has(>[data-account-ssl-rows]) th:nth-child(4){inline-size:15%}.v2-panel-service__table table:has(>[data-account-ssl-rows]) th:nth-child(5){inline-size:14%}.v2-panel-service__table table:has(>[data-account-ssl-rows]) th:nth-child(6){inline-size:24%}}
@media(min-width:601px){.v2-panel-service__table [data-account-ssl-rows] td :is([data-xp-slot=actions],.v2-panel-service__actions){flex-wrap:wrap;min-inline-size:0;white-space:normal}}
@media(min-width:601px){.v2-panel-service__table [data-account-ssl-rows] td{white-space:normal;overflow-wrap:anywhere}.v2-panel-service__table [data-account-ssl-rows] td:nth-child(3){white-space:normal}}
`
