import { canOpenRegisteredRoute } from '@xpanel/catalog'
import type { WhmSurfaceProps } from '../../../../contract.ts'
import type { Translate } from '../../../../../i18n.ts'
import { v2Messages } from '../../../messages.ts'
import { escapeHtml, hookAttrs, type HookAttributes } from '../../../html.ts'
import { card } from '../../../components/card.ts'
import { pageHeader } from '../../../components/page-header.ts'
import { whmPolish } from '../monitoring/common.ts'
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

export function hostTable(t: Translate, id: string, caption: string, headings: readonly string[], rows: readonly DataTableRow[], emptyText: string, hooks?: HookAttributes, phoneValueColumn?: 3): string {
  return dataTable(t, { id: `v2-host-${id}`, caption, columns: headings.map(label => ({ label })), rows, emptyText,
    ...(hooks ? { bodyHooks: hooks } : {}), ...(phoneValueColumn ? { phoneValueColumn } : {}) })
}

export function hostFacts(rows: readonly { label: string; valueHtml: string; hooks?: HookAttributes }[]): string {
  return `<dl class="v2-host__facts">${rows.map(row => `<div><dt>${escapeHtml(row.label)}</dt><dd${hookAttrs(row.hooks)}>${row.valueHtml}</dd></div>`).join('')}</dl>`
}

export function hostPage(props: HostPageProps, route: string, title: string, description: string, body: string, hooks?: HookAttributes, actionsHtml?: string): string {
  const { t, authorized, readable } = hostContext(props, route)
  const head = pageHeader(t, { breadcrumb: [{ label: t(msgid('Home')), href: '/whm' }, { label: title }], route, title, description, ...(actionsHtml ? { actionsHtml } : {}) })
  if (!authorized && props.capabilityUnavailable !== true)
    return `<section class="v2-host" data-whm-detail-denied>${head}<p role="status">${escapeHtml(t(msgid('Root authorization is required for server operations.')))}</p></section>`
  return `<section class="v2-host" data-whm-detail-route="${escapeHtml(route)}" data-capability-state="${readable ? 'authorized' : 'unavailable'}"${hookAttrs(hooks)}>${head}${!readable ? `<p role="status">${escapeHtml(t(msgid('This host has not qualified the operation. The workspace is retained; changes remain unavailable.')))}</p>` : ''}${body}</section>`
}

export const HOST_PAGES_CSS = `.v2-host,.v2-host__stack{display:flex;flex-direction:column;gap:var(--space-4);min-inline-size:0}
.v2-host :is(h2,h3,p,dl,dd,fieldset){margin:0}
.v2-host .v2-filter--fields{padding:0}
@media(max-width:600px){.v2-host .v2-segmented>button{min-block-size:var(--target)}}
.v2-host__groups{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0}
.v2-host__fields,.v2-host__facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2)}
.v2-host__facts>div,.v2-host__field{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0;text-align:start}
.v2-host__facts{grid-template-columns:repeat(auto-fill,minmax(min(200px,calc(50% - 8px)),1fr))}
.v2-host__field>label{padding-inline:13px;font-size:13px;line-height:1.25;font-weight:600;color:var(--text-2)}
.v2-host__facts dd{font-variant-numeric:tabular-nums;overflow-wrap:anywhere;unicode-bidi:plaintext;text-align:match-parent}
@media(min-width:1101px){.v2-host[data-whm-detail-route="/whm/security/firewall"] [data-whm-firewall-panel=port] table{min-inline-size:0}.v2-host[data-whm-detail-route="/whm/security/firewall"] [data-whm-firewall-panel=port] :is(th,td){padding-inline:6px}.v2-host[data-whm-detail-route="/whm/security/firewall"] [data-whm-firewall-panel=port] :is(th,td):first-child{padding-inline-start:12px}.v2-host[data-whm-detail-route="/whm/security/firewall"] [data-whm-firewall-panel=port] :is(th,td):last-child{padding-inline-end:12px}.v2-host[data-whm-detail-route="/whm/security/firewall"] td>.v2-host__actions{gap:6px}.v2-host[data-whm-detail-route="/whm/security/firewall"] td>.v2-host__actions>.v2-btn{padding-inline:8px;min-inline-size:var(--target);min-block-size:var(--target);font-size:12px}}
.v2-host__facts bdi{unicode-bidi:isolate}
.v2-host__actions,.v2-host__choices{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.v2-host__choice{display:flex;align-items:center;gap:var(--space-1);min-inline-size:var(--target);min-block-size:var(--target)}
.v2-host fieldset{border:0;padding:0;min-inline-size:0;display:flex;flex-direction:column;gap:var(--space-2)}
.v2-host legend{padding:0;margin-block-end:var(--space-1);font-weight:600}
.v2-host__field :is(input,select,textarea){inline-size:100%;min-inline-size:0}
.v2-host :is(.v2-host__field,.v2-field) [dir=ltr]{text-align:var(--v2-control-align,start)}
.v2-host__split{display:grid;grid-template-columns:minmax(0,2fr) minmax(280px,1fr);gap:var(--space-3);align-items:stretch}
.v2-host__split>:is(.v2-host__stack,.v2-card),.v2-host__split>.v2-host__stack>.v2-card:last-child{flex:1 1 auto}
.v2-host[data-whm-detail-route="/whm/security/firewall"] .v2-host__split{grid-template-columns:minmax(0,1.25fr) minmax(320px,1fr)}
.v2-host__pair{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);gap:var(--space-3);align-items:stretch}
.v2-host .v2-tabs{flex-wrap:nowrap;overflow:auto hidden}
.v2-host .v2-tabs>[role=tab]{flex:none;white-space:nowrap;margin-block-end:0}
.v2-host .v2-tabs>[role=tab]:disabled{opacity:.6;cursor:not-allowed}
.v2-host :is(h2,h3)[id]{scroll-margin-block-start:96px}
.v2-host .v2-kpi-row{grid-template-columns:repeat(4,minmax(0,1fr))}
.v2-host__table-wrap{min-inline-size:0;overflow-x:auto}
.v2-host__summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr));gap:var(--space-2)}
.v2-host__unavailable{display:flex;flex-direction:column;gap:var(--space-2);list-style:none;padding:0}
.v2-host__unavailable li{display:flex;flex-wrap:wrap;justify-content:space-between;gap:var(--space-1)}
.v2-host__power{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);gap:var(--space-3);align-items:center}
.v2-host__tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--space-2)}
.v2-host__tile{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0;padding:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-notice);background:var(--subtle)}
.v2-host__tile>dt{font-weight:600}
.v2-host__tile>dd{font-size:18px;font-weight:600;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.v2-host__tile>dd.v2-host__tile-note{font-size:12px;font-weight:400;color:var(--muted)}
.v2-host td,.v2-host .v2-mono{font-variant-numeric:tabular-nums}
.v2-host [data-firewall-apply-steps]{padding:12px var(--space-2);border:1px solid var(--line);border-radius:var(--radius-notice);background:var(--subtle)}
.v2-host__ports{display:flex;flex-wrap:wrap;gap:var(--space-1);font-size:12px;font-weight:400;color:var(--muted)}
.v2-host__ports>span{padding:2px 8px;border:1px solid var(--line-strong);border-radius:var(--radius-chip);background:var(--surface)}
.v2-host__ports bdi{font-weight:600;color:var(--text)}
.v2-host[data-whm-detail-route="/whm/services"] .v2-host__groups>.v2-pill{align-self:flex-start}
.v2-host__rowcount{font-size:13px;color:var(--muted)}
.v2-host [data-whm-firewall-tabs]:has(tbody [data-xp-slot]) [data-whm-firewall-tab] .v2-count{display:none}
.v2-host [data-whm-firewall-panel] td:is([data-xp-slot=purpose],[data-xp-slot=origin]){color:var(--muted)}
.v2-host [data-whm-firewall-panel] :is(th,td){padding-inline:10px}
.v2-host [data-whm-firewall-panel] td>.v2-host__actions{display:grid;grid-template-columns:repeat(2,max-content);gap:var(--space-1)}
.v2-host [data-whm-firewall-panel] td>.v2-host__actions>.v2-btn{padding-inline:12px;font-size:13px}
.v2-host [data-whm-firewall-panel] td[data-xp-action=cell]{background:var(--subtle)}
.v2-host [hidden]{display:none}
@media(min-width:601px){.v2-host table:has(>thead>tr>:nth-child(9)) td:is(:nth-child(6),:nth-child(7)){white-space:nowrap}}
.v2-host tbody th{background:none;color:var(--text);font-size:14px;font-weight:500;white-space:normal}
${whmPolish('.v2-host')}@media(max-width:1100px){.v2-host .v2-kpi-row{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:1000px){.v2-host__tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.v2-host__split,.v2-host[data-whm-detail-route="/whm/security/firewall"] .v2-host__split,.v2-host__pair,.v2-host__power{grid-template-columns:minmax(0,1fr)}}
@media(max-width:640px){.v2-host__fields{grid-template-columns:minmax(0,1fr)}}
@media(max-width:600px){.v2-host :is([data-whm-firewall-panel],#v2-host-php-effective) :is(td[data-phone-label]:nth-child(n+3),td:nth-child(n+3):has(>[data-phone-label])){grid-column:1/-1}
.v2-host :is([data-whm-firewall-panel],#v2-host-php-effective) :is(td[data-phone-label]:nth-child(n+3),td:nth-child(n+3)>[data-phone-label]){display:flex;align-items:baseline;justify-content:space-between;gap:var(--space-2);text-align:end;overflow-wrap:anywhere}
.v2-host :is([data-whm-firewall-panel],#v2-host-php-effective) :is(td[data-phone-label],td>[data-phone-label])::before{content:attr(data-phone-label);flex:none;margin-inline-end:var(--space-1);font-size:13px;font-weight:400;color:var(--muted);text-align:start}
.v2-host [data-whm-firewall-panel] td:first-child{font-weight:600}
.v2-host [data-whm-firewall-panel] td>.v2-host__actions{grid-template-columns:repeat(auto-fit,minmax(120px,1fr))}
.v2-host [data-whm-firewall-panel] td>.v2-host__actions>.v2-btn{min-block-size:var(--target)}
.v2-host [data-whm-firewall-panel] td>.v2-host__actions:empty{display:none}}
`
