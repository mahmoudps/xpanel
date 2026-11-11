import type { WhmSurfaceProps } from '../../../../contract.ts'
import { localeDirection, type Translate } from '../../../../../i18n.ts'
import { card } from '../../../components/card.ts'
import { formField, type FieldControl } from '../../../components/form-field.ts'
import { pageHeader } from '../../../components/page-header.ts'
import { escapeHtml, hookAttrs, type HookAttributes } from '../../../html.ts'
import { v2Messages } from '../../../messages.ts'
import { v2SoftwareClientTemplates } from './client-templates.ts'
import type { WhmStoredFactAuthority } from '../stored-facts.ts'
import { whmPolish } from '../monitoring/common.ts'

/** Core resolves the route, listener, principal and capability before creating this presentation input. */
export interface WhmDataAuthority extends WhmStoredFactAuthority { readonly canRead: boolean; readonly canManage: boolean; readonly canKill?: boolean; readonly canRepair?: boolean; readonly canRootPassword?: boolean; readonly canDbProfiles?: boolean; readonly canFtpSettings?: boolean; readonly canDbMap?: boolean; readonly canDbHosts?: boolean; readonly canDbSettings?: boolean; readonly canPostgresql?: boolean; readonly canDbService?: boolean; readonly canDbQuota?: boolean; readonly canPmaAccess?: boolean }
export interface WhmDataPageInput extends WhmSurfaceProps { readonly dataAuthority?: WhmDataAuthority }
export const DENIED_DATA_AUTHORITY: WhmDataAuthority = Object.freeze({ canRead: false, canManage: false })
export function context(input: WhmDataPageInput, authority = input.dataAuthority ?? DENIED_DATA_AUTHORITY) {
  const canRead = authority.canRead === true && input.capabilityUnavailable !== true
  return { t: v2Messages.translator(input.locale ?? 'en'), canRead, canManage: canRead && authority.canManage === true,
    canKill: canRead && authority.canManage === true && authority.canKill === true }
}
export const esc = escapeHtml
export const technical = (value: string | number): string => `<bdi class="v2-mono" dir="ltr">${esc(value)}</bdi>`
export const actions = (html: string): string => `<div class="v2-whm-data__actions">${html}</div>`
export const fields = (html: string): string => `<div class="v2-whm-data__fields">${html}</div>`
export const stack = (html: string): string => `<div class="v2-whm-data__stack">${html}</div>`
/** A wide column beside a rail; `railFirst` puts the rail on the start edge and first in the document. */
export const split = (main: string, aside: string, railFirst = false): string => railFirst
  ? `<div class="v2-whm-data__split v2-whm-data__split--rail-first"><aside class="v2-whm-data__stack">${aside}</aside><div class="v2-whm-data__stack">${main}</div></div>`
  : `<div class="v2-whm-data__split"><div class="v2-whm-data__stack">${main}</div><aside class="v2-whm-data__stack">${aside}</aside></div>`
export const button = (label: string, hooks?: HookAttributes, disabled = true, primary = false): string =>
  `<button type="button" class="v2-btn${primary ? ' v2-btn--primary' : ''}"${hookAttrs(hooks)}${disabled ? ' disabled' : ''}>${esc(label)}</button>`
export const link = (label: string, href: string, hooks?: HookAttributes): string => `<a class="v2-btn" href="${esc(href)}"${hookAttrs(hooks)}>${esc(label)}</a>`
export const field = (id: string, label: string, control: FieldControl, help?: string): string => formField({ id, label, control, ...(help ? { help } : {}) })
export const check = (label: string, hooks?: HookAttributes, disabled = true, describedBy?: string): string => `<label class="v2-whm-data__check"><input type="checkbox"${hookAttrs(hooks)}${disabled ? ' disabled' : ''}${describedBy ? ` aria-describedby="${esc(describedBy)}"` : ''}><span>${esc(label)}</span></label>`
export const note = (text: string, hooks?: HookAttributes, hidden = false): string => `<p class="v2-muted"${hookAttrs(hooks)}${hidden ? ' hidden' : ''}>${esc(text)}</p>`
export const status = (text: string, hooks: HookAttributes, hidden = false): string => `<p role="status" data-state="unread"${hookAttrs(hooks)}${hidden ? ' hidden' : ''}>${esc(text)}</p>`
export const section = (key: string, title: string, html: string, hooks?: HookAttributes, focusable = false): string => {
  const body = card({ title, titleId: `v2-whm-data-${key}`, bodyHtml: html, ...(!focusable && hooks ? { hooks } : {}) })
  return focusable ? `<div tabindex="-1"${hookAttrs(hooks)}>${body}</div>` : body
}
export function facts(t: Translate, rows: readonly (readonly [string, string])[], attribute: string): string {
  return `<dl class="v2-whm-data__facts">${rows.map(([key, label]) => `<div><dt>${esc(t(label))}</dt><dd ${attribute}="${esc(key)}">${esc(t(msgid('Not read')))}</dd></div>`).join('')}</dl>`
}
export function table(t: Translate, title: string, headers: readonly string[], hooks: HookAttributes, unread = t(msgid('Not read'))): string {
  return `<div class="v2-whm-data__scroll" role="region" tabindex="0" aria-label="${esc(title)}"><table style="${esc(headers.map((label, index) => `--v2-col-${index + 1}:'${t(label).replace(/[\\']/g, '\\$&')}'`).join(';'))}"><caption class="v2-sr">${esc(title)}</caption><thead><tr>${headers.map(label => `<th scope="col">${esc(t(label))}</th>`).join('')}</tr></thead><tbody${hookAttrs(hooks)} data-columns="${headers.length}"><tr><td colspan="${headers.length}">${esc(unread)}</td></tr></tbody></table></div>`
}
export function page(input: WhmDataPageInput, route: string, title: string, description: string, body: string, hooks?: HookAttributes, actionsHtml?: string): string {
  const { t, canRead } = context(input)
  return `<section class="v2-whm-data" lang="${esc(input.locale ?? 'en')}" dir="${localeDirection(input.locale ?? 'en')}" data-whm-detail-route="${esc(route)}" data-capability-state="${canRead ? 'authorized' : 'unavailable'}"${hookAttrs(hooks)}>${pageHeader(t, { route, title, description, breadcrumb: [{ label: t(msgid('Home')), href: '/whm' }, { label: title }], ...(actionsHtml ? { actionsHtml } : {}) })}${body}${v2SoftwareClientTemplates(route)}</section>`
}

export const WHM_DATA_COMMON_CSS = `.v2-whm-data{display:flex;flex-direction:column;gap:var(--space-4);min-inline-size:0}
.v2-whm-data :is(p,dl,dd,ul,ol,pre,fieldset){margin:0}
.v2-whm-data__stack,.v2-whm-data form{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0}
.v2-whm-data__fields,.v2-whm-data__facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2);min-inline-size:0}
.v2-whm-data__facts>div{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0;text-align:start}
.v2-whm-data__facts{grid-template-columns:repeat(auto-fill,minmax(min(200px,calc(50% - 8px)),1fr))}
.v2-whm-data .v2-field>label,.v2-whm-data__facts dt{text-box-trim:trim-end;text-box-edge:text}
.v2-whm-data__facts dd{font-weight:500;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;unicode-bidi:plaintext;text-align:var(--v2-control-align,match-parent);text-box-trim:trim-start;text-box-edge:text}
.v2-whm-data__facts dd>span{unicode-bidi:plaintext}
@media(min-width:1101px){.v2-whm-data__facts:has(>:nth-child(5):last-child):not(.v2-whm-data__split>aside *,.v2-whm-data__split--rail-first>:first-child *){grid-template-columns:repeat(5,minmax(0,1fr))}}
.v2-whm-data__actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.v2-whm-data .v2-btn{min-inline-size:var(--target);min-block-size:var(--target)}
@media(min-width:1101px){.v2-whm-data td>.v2-whm-data__actions{flex-wrap:nowrap;gap:8px}}
.v2-whm-data[data-whm-software-center] .v2-software-center__identity{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0}
.v2-whm-data ul:has(>[data-sc-source]){list-style:none;padding:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2)}
.v2-whm-data [data-sc-source]{display:flex;flex-direction:column;gap:var(--space-1);padding:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-notice);background:var(--subtle);min-inline-size:0}
.v2-whm-data__check{display:flex;align-items:center;gap:10px;min-block-size:var(--target);cursor:pointer}
.v2-whm-data__check>input{flex:none;margin:0}
.v2-whm-data__split{display:grid;grid-template-columns:minmax(0,2fr) minmax(260px,1fr);gap:var(--space-3);align-items:stretch}
.v2-whm-data__split>.v2-whm-data__stack>.v2-card:last-child{flex:1 1 auto}
.v2-whm-data fieldset{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0;margin:0;padding:0;border:0}
.v2-whm-data legend{padding:0;margin-block-end:var(--space-1);font-size:14px;font-weight:600}
.v2-whm-data__split--rail-first{grid-template-columns:minmax(260px,1fr) minmax(0,2fr)}
.v2-whm-data__scroll{min-inline-size:0;max-inline-size:100%;overflow-x:auto}
.v2-whm-data__scroll table{inline-size:100%;min-inline-size:480px;border-collapse:collapse}
.v2-whm-data__scroll :is(th,td){text-align:start;vertical-align:top}
.v2-whm-data__scroll td{font-variant-numeric:tabular-nums}
.v2-whm-data__scroll tbody tr:has(button)>:is(th,td){vertical-align:middle}
@media(min-width:601px){.v2-whm-data__scroll{border:1px solid var(--line);border-radius:var(--radius-notice);background:var(--surface)}.v2-whm-data__scroll thead th{background:var(--subtle)}.v2-whm-data__scroll tbody tr:last-child>:is(th,td){border-block-end:0}}
.v2-whm-data dd[data-sw-observed]{unicode-bidi:plaintext;text-align:var(--v2-control-align,match-parent)}
.v2-whm-data__scroll thead th{white-space:normal;overflow-wrap:normal;word-break:normal}
.v2-whm-data__split>aside .v2-whm-data__scroll table{min-inline-size:0}
.v2-whm-data__split>aside .v2-whm-data__scroll :is(th,td){padding-inline:12px}
.v2-whm-data__changes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--space-3)}
.v2-whm-data__changes>div{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0}
.v2-whm-data__list{padding-inline-start:var(--space-3);display:flex;flex-direction:column;gap:var(--space-2)}
.v2-whm-data__preview{display:flex;flex-direction:column;gap:var(--space-3);padding:var(--v2-panel-padding);border:1px solid var(--line);border-radius:var(--radius-notice);background:var(--subtle)}
.v2-whm-data pre{padding:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-notice);background:var(--code);color:var(--code-text);font:13px/1.6 var(--font-mono);font-variant-numeric:tabular-nums;white-space:pre-wrap;overflow-wrap:anywhere}
.v2-whm-data pre:empty{display:none}
.v2-whm-data [data-ctr-workspace] pre{max-block-size:24rem;overflow:auto}
.v2-whm-data input[type=file]{inline-size:100%;max-inline-size:480px;min-block-size:var(--target);padding:6px;border:1px dashed var(--line-strong);border-radius:var(--radius-control);background:var(--subtle);color:var(--text-2);font-size:13px}
.v2-whm-data input[type=file]::file-selector-button{min-block-size:var(--target);margin-inline-end:12px;padding:0 12px;border:1px solid var(--line-strong);border-radius:var(--radius-chip);background:var(--surface);color:var(--text);font:inherit;font-weight:600;cursor:pointer}
.v2-whm-data :is(input,textarea,select)[dir=ltr]{text-align:var(--v2-control-align,start)}
.v2-whm-data [hidden]{display:none!important}
.v2-whm-data[data-whm-detail-route="/whm/services/ftp-log-analysis"] .v2-whm-data__scroll :is(th,td){padding-inline:8px}
.v2-whm-data nav.v2-whm-data__actions a[aria-current=page]{background:var(--accent-soft);border-color:var(--accent-line);color:var(--accent);font-weight:600}
.v2-whm-data .v2-tool-card__fields:has(>.v2-field:only-child:not(:has(textarea))){max-inline-size:480px}
.v2-whm-data tbody th{background:none;color:var(--text);font-size:14px;font-weight:500;white-space:normal}
@media(prefers-reduced-motion:no-preference){.v2-whm-data .v2-btn{transition:background-color 140ms ease-out,border-color 140ms ease-out,color 140ms ease-out,box-shadow 140ms ease-out,opacity 140ms ease-out,transform 140ms ease-out}}
${whmPolish('.v2-whm-data')}@media(max-width:1000px){.v2-whm-data__split{grid-template-columns:minmax(0,1fr)}}
@media(max-width:640px){.v2-whm-data__fields,.v2-whm-data__changes,.v2-whm-data ul:has(>[data-sc-source]){grid-template-columns:minmax(0,1fr)}}
@media(max-width:600px){.v2-whm-data__fields,.v2-whm-data__changes{grid-template-columns:minmax(0,1fr)}.v2-whm-data .v2-tool-card__table tbody>tr{padding-block:8px;border-block-end:1px solid var(--line)}.v2-whm-data .v2-tool-card__table tbody>tr>td{border-block-end:0}.v2-whm-data [data-sc-groups] td:is([data-xp-slot=candidate],[data-xp-slot=estimate],[data-xp-slot=relations]):not(:empty){display:block}.v2-whm-data [data-sc-groups] td:is([data-xp-slot=candidate],[data-xp-slot=estimate],[data-xp-slot=relations])::before{display:block;margin-block-end:4px}
.v2-whm-data__scroll td:nth-child(n+3):not([colspan]){grid-column:1/-1;display:flex;justify-content:space-between;align-items:baseline;gap:16px;text-align:end;overflow-wrap:anywhere}
.v2-whm-data__scroll td:nth-child(n+3):not([colspan])::before{flex:none;font-size:13px;color:var(--muted);text-align:start}
.v2-whm-data__scroll td:nth-child(3):not([colspan])::before{content:var(--v2-col-3)}
.v2-whm-data__scroll td:nth-child(4):not([colspan])::before{content:var(--v2-col-4)}
.v2-whm-data__scroll td:nth-child(5):not([colspan])::before{content:var(--v2-col-5)}
.v2-whm-data__scroll td:nth-child(6):not([colspan])::before{content:var(--v2-col-6)}
.v2-whm-data__scroll td:nth-child(7):not([colspan])::before{content:var(--v2-col-7)}
.v2-whm-data__scroll td:nth-child(8):not([colspan])::before{content:var(--v2-col-8)}
.v2-whm-data__scroll td:nth-child(9):not([colspan])::before{content:var(--v2-col-9)}
.v2-whm-data__scroll td:nth-child(10):not([colspan])::before{content:var(--v2-col-10)}}
@media(min-width:601px) and (max-width:1439px){.v2-whm-data[data-whm-detail-route="/whm/services/certificates"] table:has(>[data-whm-service-detail-rows]){display:block;min-inline-size:0}
.v2-whm-data[data-whm-detail-route="/whm/services/certificates"] table:has(>[data-whm-service-detail-rows])>thead{position:absolute;inline-size:1px;block-size:1px;overflow:hidden;clip-path:inset(50%)}
.v2-whm-data[data-whm-detail-route="/whm/services/certificates"] table:has(>[data-whm-service-detail-rows])>tbody{display:block}
.v2-whm-data[data-whm-detail-route="/whm/services/certificates"] table:has(>[data-whm-service-detail-rows])>tbody>tr{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px 16px;padding:16px;border-block-end:1px solid var(--line)}
.v2-whm-data[data-whm-detail-route="/whm/services/certificates"] table:has(>[data-whm-service-detail-rows])>tbody>tr:last-child{border-block-end:0}
.v2-whm-data[data-whm-detail-route="/whm/services/certificates"] table:has(>[data-whm-service-detail-rows])>tbody>tr>td{display:flex;flex-direction:column;gap:2px;padding:0;border:0;min-inline-size:0;overflow-wrap:anywhere}
.v2-whm-data[data-whm-detail-route="/whm/services/certificates"] table:has(>[data-whm-service-detail-rows])>tbody>tr>td:is(:first-child,[colspan]){grid-column:1/-1}
.v2-whm-data[data-whm-detail-route="/whm/services/certificates"] table:has(>[data-whm-service-detail-rows])>tbody>tr>td:first-child{font-weight:600}
.v2-whm-data[data-whm-detail-route="/whm/services/certificates"] table:has(>[data-whm-service-detail-rows])>tbody>tr>td:not(:first-child,[colspan])::before{font-size:12px;color:var(--muted)}
.v2-whm-data[data-whm-detail-route="/whm/services/certificates"] table:has(>[data-whm-service-detail-rows])>tbody>tr>td:nth-child(2):not([colspan])::before{content:var(--v2-col-2)}
.v2-whm-data[data-whm-detail-route="/whm/services/certificates"] table:has(>[data-whm-service-detail-rows])>tbody>tr>td:nth-child(3):not([colspan])::before{content:var(--v2-col-3)}
.v2-whm-data[data-whm-detail-route="/whm/services/certificates"] table:has(>[data-whm-service-detail-rows])>tbody>tr>td:nth-child(4):not([colspan])::before{content:var(--v2-col-4)}
.v2-whm-data[data-whm-detail-route="/whm/services/certificates"] table:has(>[data-whm-service-detail-rows])>tbody>tr>td:nth-child(5):not([colspan])::before{content:var(--v2-col-5)}
.v2-whm-data[data-whm-detail-route="/whm/services/certificates"] table:has(>[data-whm-service-detail-rows])>tbody>tr>td:nth-child(6):not([colspan])::before{content:var(--v2-col-6)}
.v2-whm-data[data-whm-detail-route="/whm/services/certificates"] table:has(>[data-whm-service-detail-rows])>tbody>tr>td:nth-child(7):not([colspan])::before{content:var(--v2-col-7)}
.v2-whm-data[data-whm-detail-route="/whm/services/certificates"] table:has(>[data-whm-service-detail-rows])>tbody>tr>td:nth-child(8):not([colspan])::before{content:var(--v2-col-8)}
.v2-whm-data[data-whm-detail-route="/whm/services/certificates"] table:has(>[data-whm-service-detail-rows])>tbody>tr>td:nth-child(9):not([colspan])::before{content:var(--v2-col-9)}
.v2-whm-data[data-whm-detail-route="/whm/services/certificates"] table:has(>[data-whm-service-detail-rows])>tbody>tr>td:nth-child(10):not([colspan])::before{content:var(--v2-col-10)}}
`
