import { canOpenRegisteredRoute } from '@xpanel/catalog'
import type { WhmSurfaceProps } from '../../../../contract.ts'
import type { Translate } from '../../../../../i18n.ts'
import { v2Messages } from '../../../messages.ts'
import { escapeHtml, hookAttrs, type HookAttributes } from '../../../html.ts'
import { card } from '../../../components/card.ts'
import { pageHeader } from '../../../components/page-header.ts'
import { dataTable, type DataTableRow } from '../../../components/data-table.ts'

export type HostPageProps = WhmSurfaceProps

export function hostContext(props: HostPageProps, route: string) {
  const locale = props.locale ?? 'en'
  const principal = props.visibility?.principal ?? props.principal
  const authorized = principal?.kind === 'root'
    && canOpenRegisteredRoute(route, { ...props.visibility, principal })
  return { t: v2Messages.translator(locale), locale, authorized, readable: authorized && props.capabilityUnavailable !== true }
}

export const technical = (value: string | number | null | undefined, fallback = ''): string =>
  value === null || value === undefined ? escapeHtml(fallback) : `<bdi class="v2-mono" dir="ltr">${escapeHtml(value)}</bdi>`

export function hostButton(label: string, hooks?: HookAttributes, options: { disabled?: boolean; primary?: boolean; danger?: boolean; type?: 'button' | 'submit' | 'reset' } = {}): string {
  return `<button type="${options.type ?? 'button'}" class="v2-btn${options.primary ? ' v2-btn--primary' : ''}${options.danger ? ' v2-btn--danger' : ''}"${hookAttrs(hooks)}${options.disabled ? ' disabled' : ''}>${escapeHtml(label)}</button>`
}

export function hostCard(key: string, title: string, bodyHtml: string, hooks?: HookAttributes, actionsHtml?: string): string {
  return card({ title, titleId: `v2-host-${key}-heading`, bodyHtml, hooks, ...(actionsHtml ? { actionsHtml } : {}) })
}

export function hostTable(t: Translate, id: string, caption: string, headings: readonly string[], rows: readonly DataTableRow[], emptyText: string, hooks?: HookAttributes): string {
  return dataTable(t, { id: `v2-host-${id}`, caption, columns: headings.map(label => ({ label })), rows, emptyText,
    ...(hooks ? { bodyHooks: hooks } : {}) })
}

export function hostFacts(rows: readonly { label: string; valueHtml: string; hooks?: HookAttributes }[]): string {
  return `<dl class="v2-host__facts">${rows.map(row => `<div><dt>${escapeHtml(row.label)}</dt><dd${hookAttrs(row.hooks)}>${row.valueHtml}</dd></div>`).join('')}</dl>`
}

export function hostPage(props: HostPageProps, route: string, title: string, description: string, body: string, hooks?: HookAttributes): string {
  const { t, authorized, readable } = hostContext(props, route)
  const head = pageHeader(t, { breadcrumb: [{ label: t(msgid('Home')), href: '/whm' }, { label: title }], route, title, description })
  if (!authorized && props.capabilityUnavailable !== true)
    return `<section class="v2-host" data-whm-detail-denied>${head}<p role="status">${escapeHtml(t(msgid('Root authorization is required for server operations.')))}</p></section>`
  return `<section class="v2-host" data-whm-detail-route="${escapeHtml(route)}" data-capability-state="${readable ? 'authorized' : 'unavailable'}"${hookAttrs(hooks)}>${head}${!readable ? `<p role="status">${escapeHtml(t(msgid('This host has not qualified the operation. The workspace is retained; changes remain unavailable.')))}</p>` : ''}${body}</section>`
}

export const HOST_PAGES_CSS = `.v2-host,.v2-host__stack{display:flex;flex-direction:column;gap:var(--space-4);min-inline-size:0}
.v2-host :is(h2,h3,p,dl,dd,fieldset){margin:0}
.v2-host__groups{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0}
.v2-host__fields,.v2-host__facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2)}
.v2-host__facts>div,.v2-host__field{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0;text-align:start}
.v2-host__facts dt,.v2-host__field>label{font-size:13px;font-weight:600;color:var(--text-2)}
.v2-host__facts dd{overflow-wrap:anywhere}
.v2-host__facts bdi{unicode-bidi:isolate}
.v2-host__actions,.v2-host__choices{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.v2-host__choice{display:flex;align-items:center;gap:var(--space-1);min-block-size:var(--target)}
.v2-host fieldset{border:0;padding:0;min-inline-size:0;display:flex;flex-direction:column;gap:var(--space-2)}
.v2-host legend{padding:0;margin-block-end:var(--space-1);font-weight:600}
.v2-host__field :is(input,select,textarea){inline-size:100%;min-inline-size:0}
.v2-host :is(.v2-host__field,.v2-field) [dir=ltr]{text-align:var(--v2-control-align,start)}
.v2-host__split{display:grid;grid-template-columns:minmax(0,2fr) minmax(280px,1fr);gap:var(--space-3);align-items:start}
.v2-host__table-wrap{min-inline-size:0;overflow-x:auto}
.v2-host__summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr));gap:var(--space-2)}
.v2-host__unavailable{display:flex;flex-direction:column;gap:var(--space-2);list-style:none;padding:0}
.v2-host__unavailable li{display:flex;flex-wrap:wrap;justify-content:space-between;gap:var(--space-1)}
.v2-host [hidden]{display:none}
@media(max-width:1000px){.v2-host__split{grid-template-columns:minmax(0,1fr)}}
@media(max-width:640px){.v2-host__fields,.v2-host__facts{grid-template-columns:minmax(0,1fr)}}
`
