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
  card({ title, titleId: `v2-plan-${key}`, bodyHtml, ...(actionsHtml ? { actionsHtml } : {}) })
export const facts = (rows: readonly { label: string; valueHtml: string }[]): string =>
  `<dl class="v2-plan-facts">${rows.map(row => `<div><dt>${escapeHtml(row.label)}</dt><dd>${row.valueHtml}</dd></div>`).join('')}</dl>`
export const table = (t: Translate, key: string, title: string, labels: readonly string[], rows: readonly DataTableRow[], emptyText: string): string =>
  dataTable(t, { id: `v2-plan-${key}`, caption: title, columns: labels.map(label => ({ label })), rows, emptyText })
export function page(t: Translate, route: string, title: string, description: string, bodyHtml: string, readable: boolean, hooks?: HookAttributes): string {
  return `<section class="v2-plan-page" data-whm-detail-route="${escapeHtml(route)}" data-capability-state="${readable ? 'authorized' : 'unavailable'}"${hookAttrs(hooks)}>${pageHeader(t, { route, title, description, breadcrumb: [{ label: t('Home'), href: '/whm' }, { label: title }] })}${!readable ? `<p role="status">${escapeHtml(t('This host has not qualified the operation. The workspace is retained; changes remain unavailable.'))}</p>` : ''}${bodyHtml}</section>`
}
export const WHM_PLANS_CSS = `.v2-plan-page,.v2-plan-stack{display:flex;flex-direction:column;gap:var(--space-4);min-inline-size:0}
.v2-plan-columns{display:grid;grid-template-columns:280px minmax(0,1fr);gap:var(--space-3);align-items:start}
.v2-plan-main,.v2-plan-aside{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0}
.v2-plan-fields,.v2-plan-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2)}
.v2-plan-field,.v2-plan-facts>div{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0;text-align:start}
.v2-plan-facts dt,.v2-plan-field>label{font-size:13px;color:var(--text-2);font-weight:600}
.v2-plan-facts dd{margin:0;overflow-wrap:anywhere}.v2-plan-facts bdi{unicode-bidi:isolate}
.v2-plan-actions{display:flex;flex-wrap:wrap;gap:var(--space-2);align-items:center}
.v2-plan-editor,.v2-plan-section{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0}
.v2-plan-editor fieldset{margin:0;padding:0;border:0;min-inline-size:0;display:flex;flex-direction:column;gap:var(--space-2)}
.v2-plan-editor legend{font-size:16px;font-weight:600;padding:0;margin-block-end:var(--space-2)}
.v2-plan-field input,.v2-plan-field select{inline-size:100%;min-inline-size:0}.v2-plan-field [dir=ltr]{text-align:var(--v2-control-align,start)}
.v2-plan-choice{display:flex;align-items:center;gap:var(--space-1);min-block-size:var(--target)}
.v2-plan-picker{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:var(--space-1)}
.v2-plan-picker a{display:flex;justify-content:space-between;gap:var(--space-1);padding:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-control);text-decoration:none}
.v2-plan-picker a[aria-current=page]{background:var(--accent-soft);border-color:var(--accent-line)}
.v2-plan-summary{display:flex;flex-wrap:wrap;gap:var(--space-2);align-items:center}
.v2-plan-tabs{display:flex;flex-wrap:wrap;gap:var(--space-1)}
.v2-plan-dialog{inline-size:min(520px,calc(100% - 32px));padding:var(--space-3);border:1px solid var(--line);border-radius:var(--radius-card);color:var(--text);background:var(--surface)}
.v2-plan-dialog form{display:flex;flex-direction:column;gap:var(--space-3)}.v2-plan-dialog::backdrop{background:var(--scrim)}
.v2-feature-matrix{overflow:auto;min-inline-size:0}.v2-feature-matrix table{min-inline-size:700px}
.v2-feature-matrix th,.v2-feature-matrix td{text-align:start;vertical-align:top}.v2-feature-matrix th:first-child{min-inline-size:240px}
.v2-feature-column{display:flex;flex-direction:column;gap:var(--space-2);min-inline-size:180px}.v2-feature-toggle{display:flex;align-items:center;gap:var(--space-1);min-block-size:var(--target)}
.v2-feature-groups{display:flex;flex-direction:column;gap:var(--space-1)}.v2-feature-group{font-weight:600;background:var(--subtle)}
@media(max-width:1000px){.v2-plan-columns{grid-template-columns:minmax(0,1fr)}}
@media(max-width:600px){.v2-plan-fields,.v2-plan-facts{grid-template-columns:minmax(0,1fr)}.v2-plan-dialog{padding:var(--space-2)}}
`
