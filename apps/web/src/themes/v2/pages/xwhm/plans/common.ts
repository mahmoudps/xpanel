import { canOpenRegisteredRoute } from '@xpanel/catalog'
import type { Plan } from '@xpanel/core'
import { canManagePlan } from '@xpanel/core'
import type { Translate } from '../../../../../i18n.ts'
import type { WhmSurfaceProps } from '../../../../contract.ts'
import { card } from '../../../components/card.ts'
import { pageHeader } from '../../../components/page-header.ts'
import { dataTable, type DataTableRow } from '../../../components/data-table.ts'
import { escapeHtml, hookAttrs, type HookAttributes } from '../../../html.ts'

/** Capability decisions are projected by core, separately from the page's stored facts. */
export interface WhmPlanAuthority {
  readonly presentation?: 'live' | 'read-only'
  readonly canReadFacts?: boolean
  readonly authorizedTools?: ReadonlySet<string>
  readonly canRead: boolean
  readonly canManage: boolean
  readonly allowUnlimited: boolean
  readonly ownerId: string | null
  readonly canReadAccounts?: boolean
}
export const DENIED_PLAN_AUTHORITY: WhmPlanAuthority = Object.freeze({ canRead: false, canManage: false, allowUnlimited: false, ownerId: null })
export const planPrincipal = (props: WhmSurfaceProps) => props.visibility?.principal ?? props.principal
export const planHref = (props: WhmSurfaceProps, id?: string): string => {
  const query = new URLSearchParams({ lang: props.locale ?? 'en', theme: props.theme ?? 'dark', density: props.density ?? 'comfortable' })
  if (id) query.set('planId', id)
  return '/whm/plans?' + query.toString()
}
export function planReadable(props: WhmSurfaceProps, authority: WhmPlanAuthority, route: string): boolean {
  const principal = planPrincipal(props)
  return authority.presentation !== 'read-only' && authority.canRead && props.capabilityUnavailable !== true && !!principal
    && canOpenRegisteredRoute(route, { ...props.visibility, principal, reseller: props.visibility?.reseller ?? props.activeReseller ?? undefined })
}
/** Saved configuration is distinct from permission to refresh or apply host state. */
export function planFactsReadable(props: WhmSurfaceProps, authority: WhmPlanAuthority, route: '/whm/plans' | '/whm/plans/features'): boolean {
  if (authority.presentation !== 'read-only') return planReadable(props, authority, route)
  const principal = planPrincipal(props)
  const tools = route === '/whm/plans' ? ['add-package', 'edit-package', 'delete-package'] : ['feature-manager', 'tweak-packages', 'feature-list-crud']
  return authority.presentation === 'read-only' && authority.canReadFacts === true && !!principal
    && tools.some(id => authority.authorizedTools?.has(id))
    && canOpenRegisteredRoute(route, { ...props.visibility, principal, reseller: props.visibility?.reseller ?? props.activeReseller ?? undefined })
}
export const planAccountFactsReadable = (authority: WhmPlanAuthority): boolean => authority.presentation === 'read-only'
  ? authority.canReadFacts === true && authority.authorizedTools?.has('list-accounts') === true : authority.canReadAccounts === true
export const planEditable = (props: WhmSurfaceProps, authority: WhmPlanAuthority, plan?: Plan): boolean =>
  authority.presentation !== 'read-only' && authority.canManage && !!planPrincipal(props) && (!plan || canManagePlan(planPrincipal(props)!, plan))
export const technical = (value: string | number): string => `<bdi class="v2-mono v2-num" dir="ltr">${escapeHtml(value)}</bdi>`
export const button = (label: string, hooks?: HookAttributes, options: { disabled?: boolean; primary?: boolean; type?: 'button' | 'submit' | 'reset' } = {}) =>
  `<button type="${options.type ?? 'button'}" class="v2-btn${options.primary ? ' v2-btn--primary' : ''}"${hookAttrs(hooks)}${options.disabled ? ' disabled' : ''}>${escapeHtml(label)}</button>`
export const group = (key: string, title: string, bodyHtml: string, actionsHtml?: string): string =>
  card({ id: `v2-plan-${key}`, title, titleId: `v2-plan-${key}-heading`, bodyHtml, ...(actionsHtml ? { actionsHtml } : {}) })
/** A phone row has no column header, so the cell carries its own label there. */
export const phoneCell = (label: string, html: string): string => `<span class="v2-plan-cell" data-phone-label="${escapeHtml(label)}"><span>${html}</span></span>`
export const facts = (rows: readonly { label: string; valueHtml: string }[]): string =>
  `<dl class="v2-plan-facts">${rows.map(row => `<div><dt>${escapeHtml(row.label)}</dt><dd>${row.valueHtml}</dd></div>`).join('')}</dl>`
export const table = (t: Translate, key: string, title: string, labels: readonly string[], rows: readonly DataTableRow[], emptyText: string): string =>
  dataTable(t, { id: `v2-plan-${key}-table`, caption: title, columns: labels.map(label => ({ label })), rows, emptyText })
export function page(t: Translate, route: string, title: string, description: string, bodyHtml: string, readable: boolean, hooks?: HookAttributes): string {
  return `<section class="v2-plan-page" data-whm-detail-route="${escapeHtml(route)}" data-capability-state="${readable ? 'authorized' : 'unavailable'}"${hookAttrs(hooks)}>${pageHeader(t, { route, title, description, breadcrumb: [{ label: t('Home'), href: '/whm' }, { label: title }] })}${!readable ? `<p role="status">${escapeHtml(t('This host has not qualified the operation. The workspace is retained; changes remain unavailable.'))}</p>` : ''}${bodyHtml}</section>`
}
export const WHM_PLANS_CSS = `.v2-plan-filter{display:flex;flex-direction:column;gap:var(--space-2);min-inline-size:0}
.v2-plan-filter>.v2-filter--fields{padding:0}
.v2-plan-page,.v2-plan-stack{display:flex;flex-direction:column;gap:var(--space-4);min-inline-size:0}
.v2-plan-columns{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0}
.v2-plan-columns--editor{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(320px,1fr);align-items:stretch}
@media(max-width:960px){.v2-plan-columns--editor{grid-template-columns:minmax(0,1fr)}}
.v2-plan-main,.v2-plan-aside{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0}
.v2-plan-columns--editor>:is(.v2-plan-main,.v2-plan-aside)>.v2-card:last-child{flex:1 1 auto}
.v2-plan-columns--editor>.v2-plan-main>.v2-card:last-child>.v2-card__body{display:flex;flex-direction:column;flex:1 1 auto}
.v2-plan-columns--top>.v2-plan-aside{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr));align-items:stretch}
.v2-plan-page .v2-card__body>.v2-btn,.v2-plan-section>.v2-btn{align-self:flex-start}
.v2-plan-page p[role=status][data-state]{font-size:13px;color:var(--muted)}
.v2-plan-page td{font-variant-numeric:tabular-nums}
.v2-plan-page td .v2-plan-stack{gap:2px}
.v2-plan-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:start;gap:var(--space-2)}
.v2-plan-fields>.v2-plan-field:last-child:nth-child(odd){grid-column:1/-1}
.v2-plan-page [data-acct-enh-form] .v2-plan-fields{grid-template-columns:repeat(auto-fit,minmax(min(160px,100%),1fr))}
.v2-plan-page [data-acct-enh-form] .v2-plan-fields>.v2-plan-field:last-child:nth-child(odd){grid-column:auto}
.v2-plan-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(130px,100%),1fr));gap:var(--space-2)}
.v2-plan-field{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:var(--space-1) 12px;min-inline-size:0;text-align:start}
.v2-plan-field>:not(.v2-plan-choice,input,select),.v2-plan-field>:is(input,select):not(:has(+.v2-plan-choice)){grid-column:1/-1}
.v2-plan-field>p{font-size:12px}
.v2-plan-facts>div{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0;text-align:start}
.v2-plan-field>label:not(.v2-plan-choice){padding-inline:13px;font-size:13px;line-height:1.25;font-weight:600}
.v2-plan-field>label.v2-plan-choice{font-weight:400;white-space:nowrap}
.v2-plan-facts dt{font-size:12px;color:var(--muted)}
.v2-plan-facts dd{margin:0;font-size:14px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.v2-plan-facts bdi{unicode-bidi:isolate}
.v2-plan-field>label:not(.v2-plan-choice),.v2-plan-page .v2-field>label,.v2-plan-filter .v2-filter__label,.v2-plan-facts dt{text-box-trim:trim-end;text-box-edge:text}
.v2-plan-facts dd{text-box-trim:trim-start;text-box-edge:text}
.v2-plan-actions{display:flex;flex-wrap:wrap;gap:var(--space-2);align-items:center}
.v2-plan-editor,.v2-plan-section{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0}
.v2-plan-editor{flex:1 1 auto}
.v2-plan-editor [hidden]{display:none!important}
.v2-plan-editor>h2{display:none}
.v2-plan-editor>p[role=status]{font-size:13px;color:var(--muted)}
.v2-plan-editor>.v2-plan-actions{margin-block-start:auto;padding-block-start:var(--space-2);border-block-start:1px solid var(--line)}
.v2-plan-editor [role=tabpanel]{padding-block-start:var(--space-2)}
.v2-plan-editor .v2-plan-review-rows{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:var(--space-2)}
.v2-plan-editor .v2-plan-review-rows>li{display:flex;flex-direction:column;gap:var(--space-1)}
.v2-plan-editor .v2-plan-review-label{font-weight:600}
.v2-plan-editor .v2-plan-review-values{margin:0}
.v2-plan-editor .v2-plan-review-values>div{display:flex;flex-direction:column;gap:var(--space-1);padding:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-notice);background:var(--subtle);min-inline-size:0}
.v2-plan-editor .v2-plan-review-values>div+div{background:var(--accent-soft);border-color:var(--accent-line)}
.v2-plan-editor .v2-plan-review-values :is(dt,dd){margin:0;overflow-wrap:anywhere}
.v2-plan-editor .v2-plan-review-values dt{color:var(--muted);font-size:12px}
.v2-plan-editor .v2-plan-review-steps{display:flex;flex-wrap:wrap;gap:var(--space-2);list-style:none;margin:0;padding:12px var(--space-2);border:1px solid var(--line);border-radius:var(--radius-notice);background:var(--subtle);font-size:13px}
.v2-plan-editor .v2-plan-review-steps li{display:flex;align-items:center;gap:var(--space-1);color:var(--muted);font-variant-numeric:tabular-nums}
.v2-plan-editor .v2-plan-review-steps li[aria-current=step]{color:var(--text);font-weight:600}
.v2-plan-aside .v2-table{min-inline-size:0}
.v2-plan-aside .v2-table :is(th,td){padding-inline:12px;white-space:normal;overflow-wrap:break-word}
.v2-plan-aside :is(#v2-plan-impact-table,#v2-plan-assigned-table){table-layout:fixed}
.v2-plan-aside #v2-plan-impact-table :is(th,td):first-child{inline-size:34%}
.v2-plan-aside #v2-plan-impact-table :is(th,td):nth-child(2){inline-size:30%;text-align:end}
.v2-plan-aside #v2-plan-impact-table :is(th,td):nth-child(3){inline-size:36%}
.v2-plan-aside #v2-plan-assigned-table :is(th,td):first-child{inline-size:40%}
.v2-plan-aside #v2-plan-assigned-table :is(th,td):nth-child(2){inline-size:60%}
.v2-plan-aside .v2-table td:last-child bdi{overflow-wrap:anywhere}
.v2-plan-page #v2-plan-all td bdi{white-space:nowrap}
.v2-plan-page td .v2-plan-stack>small{font-size:12px}
.v2-plan-page #v2-plan-all :is(th,td){padding-inline:8px;white-space:normal}
.v2-plan-page #v2-plan-all thead th{vertical-align:bottom}
.v2-plan-page td .v2-plan-actions{flex-wrap:nowrap;gap:var(--space-1)}
.v2-plan-editor fieldset,.v2-plan-section fieldset{margin:0;padding:0;border:0;min-inline-size:0;display:flex;flex-direction:column;gap:var(--space-2)}
.v2-plan-editor legend,.v2-plan-section legend{float:inline-start;inline-size:100%;padding:0;font-size:14px;font-weight:600}
.v2-plan-editor :is(#v2-plan-resources,#v2-plan-resources+fieldset)>legend{position:absolute;inline-size:1px;block-size:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.v2-plan-editor #v2-plan-resources+fieldset{gap:0;padding-block-start:var(--space-1);border-block-start:1px solid var(--line)}
.v2-plan-field :is(input:not([type=checkbox]),select){inline-size:100%;min-inline-size:0}.v2-plan-field [dir=ltr]{text-align:var(--v2-control-align,start)}
.v2-plan-choice{display:flex;align-items:center;gap:var(--space-1);min-inline-size:var(--target);min-block-size:var(--target);font-size:13px}
.v2-plan-choice>input{flex:none}
.v2-plan-picker{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(min(236px,100%),1fr));gap:12px}
.v2-plan-picker a{display:flex;align-items:center;justify-content:space-between;gap:var(--space-1);min-inline-size:var(--target);min-block-size:var(--target);padding:12px var(--space-2);border:1px solid var(--line);border-radius:var(--radius-control);color:var(--text);text-decoration:none;transition:background-color 140ms ease-out,border-color 140ms ease-out,color 140ms ease-out}
.v2-plan-picker a:hover{background:var(--subtle);border-color:var(--line-strong)}
.v2-plan-picker a[aria-current=page]{background:var(--accent-soft);border-color:var(--accent-fill);box-shadow:inset 0 0 0 1px var(--accent-fill)}
.v2-plan-picker strong{font-size:14px;font-weight:600;overflow-wrap:anywhere}
.v2-plan-picker a>span{flex:none;padding:2px var(--space-1);border-radius:var(--radius-chip);background:var(--sunken);font-size:12px;color:var(--text-2);font-variant-numeric:tabular-nums}
.v2-plan-editing{display:inline-flex;align-items:center;min-block-size:var(--target);padding-inline:var(--space-2);border-radius:var(--radius-chip);background:var(--accent-soft);font-size:13px;font-weight:600;white-space:nowrap}
.v2-plan-owner{margin:0;font-size:13px}
.v2-feature-groups>li>span.v2-feature-shown{flex-basis:100%}
.v2-plan-cell{display:contents}
@media(max-width:600px){.v2-plan-page td:has(>.v2-plan-cell){grid-column:1/-1}.v2-plan-cell{display:flex;align-items:baseline;justify-content:flex-end;gap:var(--space-2)}.v2-plan-cell::before{content:attr(data-phone-label);margin-inline-end:auto;font-size:13px;color:var(--muted)}.v2-plan-cell>span{text-align:end;min-inline-size:0}}
.v2-plan-summary{display:flex;flex-wrap:wrap;gap:var(--space-2);align-items:center}
.v2-plan-tabs{display:flex;flex-wrap:wrap;gap:var(--space-1)}
.v2-plan-dialog{inline-size:min(520px,calc(100% - 32px));padding:var(--space-3);border:1px solid var(--line);border-radius:var(--radius-card);color:var(--text);background:var(--surface)}
.v2-plan-dialog form{display:flex;flex-direction:column;gap:var(--space-3)}.v2-plan-dialog::backdrop{background:var(--scrim)}
.v2-feature-matrix{overflow:auto;min-inline-size:0;border:1px solid var(--line);border-radius:var(--radius-notice)}
.v2-feature-matrix table{inline-size:100%;min-inline-size:560px;border-collapse:collapse;font-size:13px}
.v2-feature-matrix caption:not(.v2-sr){caption-side:top;padding:12px var(--space-2);text-align:start;white-space:normal;font-size:13px;font-weight:400;color:var(--muted)}
.v2-feature-matrix :is(th,td){padding:var(--space-1) var(--space-2);text-align:start;vertical-align:middle;white-space:normal;overflow-wrap:anywhere}
.v2-feature-matrix thead th{vertical-align:bottom}
.v2-feature-matrix tbody :is(th,td){border-block-start:1px solid var(--line)}
.v2-feature-matrix td[colspan]{padding-block:var(--space-2);color:var(--muted)}
.v2-feature-matrix th[scope=row]>strong{display:block;font-weight:600}
.v2-feature-matrix th[scope=row]>.v2-muted{font-size:12px;font-weight:400}
.v2-feature-matrix :is(th:has(>.v2-feature-column),td:has(>.v2-feature-toggle)){inline-size:240px}
.v2-feature-column{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:180px;font-weight:400}
.v2-feature-column>label{font-size:12px;font-weight:600;color:var(--muted)}
.v2-feature-column>input{inline-size:100%;min-inline-size:0}
.v2-feature-toggle{display:flex;align-items:center;gap:var(--space-1);min-inline-size:var(--target);min-block-size:var(--target)}
.v2-feature-groups{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.v2-feature-groups>li{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;padding-block:10px;border-block-start:1px solid var(--line);font-size:13px;font-variant-numeric:tabular-nums}
.v2-feature-groups>li:first-child{padding-block-start:0;border-block-start:0}
.v2-feature-groups>li>strong{flex:1 1 auto;font-weight:600;overflow-wrap:anywhere}
.v2-feature-groups>li>span{color:var(--muted)}
.v2-feature-group>th{padding-block:0;background:var(--subtle);font-size:13px;font-weight:600;color:var(--text-2)}
.v2-feature-matrix{max-block-size:75vh;container-type:inline-size}
.v2-feature-matrix caption>span{display:block;position:sticky;inset-inline-start:var(--space-2);max-inline-size:calc(100cqi - 2*var(--space-2))}
.v2-feature-matrix th[scope=row]{min-inline-size:132px}
.v2-feature-matrix thead th{position:sticky;inset-block-start:0;z-index:1;background:var(--surface);box-shadow:inset 0 -1px 0 var(--line-strong)}
.v2-feature-matrix tbody:has(.v2-feature-fold>input:not(:checked))>tr:not(.v2-feature-group){display:none}
.v2-feature-fold{display:flex;align-items:center;gap:12px;min-block-size:var(--target);cursor:pointer}
.v2-feature-fold>span:last-child{margin-inline-start:auto;font-weight:400}
.v2-feature-fold>input{appearance:none;flex:none;inline-size:8px;block-size:8px;margin:0 4px;border:solid var(--muted);border-width:0 2px 2px 0;transform:rotate(-45deg);cursor:pointer}
.v2-feature-fold>input:dir(rtl){transform:rotate(135deg)}
.v2-feature-fold>input:checked{transform:rotate(45deg)}
.v2-feature-fold>input:focus-visible{outline:2px solid var(--accent);outline-offset:6px}
.v2-plan-page details{padding-inline:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-notice);background:var(--subtle)}
.v2-plan-page details+details{margin-block-start:var(--space-1)}
.v2-plan-page details[open]{padding-block-end:var(--space-2)}
.v2-plan-page details>summary{min-block-size:var(--target);padding-block:10px;align-content:center;font-size:14px;font-weight:600;cursor:pointer}
.v2-plan-page details[open]>summary{margin-block-end:var(--space-2)}
@media(prefers-reduced-motion:reduce){.v2-plan-picker a{transition:none}}
@media(max-width:1100px){.v2-plan-columns--editor{grid-template-columns:minmax(0,1fr)}.v2-plan-columns--editor>.v2-plan-aside{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr));align-items:stretch}}
@media(max-width:600px){.v2-plan-fields{grid-template-columns:minmax(0,1fr)}.v2-plan-facts{grid-template-columns:repeat(2,minmax(0,1fr))}.v2-plan-dialog{padding:var(--space-2)}.v2-feature-matrix table{min-inline-size:0}.v2-feature-matrix :is(th:has(>.v2-feature-column),td:has(>.v2-feature-toggle)){inline-size:150px}.v2-feature-matrix :is(th,td){padding-inline:12px}.v2-feature-column .v2-btn{inline-size:100%}.v2-feature-column{min-inline-size:0}}
`
