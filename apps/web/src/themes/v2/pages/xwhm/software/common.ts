import type { WhmSurfaceProps } from '../../../../contract.ts'
import { localeDirection, type Translate } from '../../../../../i18n.ts'
import { card } from '../../../components/card.ts'
import { formField, type FieldControl } from '../../../components/form-field.ts'
import { pageHeader } from '../../../components/page-header.ts'
import { escapeHtml, hookAttrs, type HookAttributes } from '../../../html.ts'
import { v2Messages } from '../../../messages.ts'
import { v2SoftwareClientTemplates } from './client-templates.ts'

/** Core resolves the route, listener, principal and capability before creating this presentation input. */
export interface WhmDataAuthority { readonly canRead: boolean; readonly canManage: boolean; readonly canKill?: boolean }
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
export const split = (main: string, aside: string): string => `<div class="v2-whm-data__split"><div class="v2-whm-data__stack">${main}</div><aside class="v2-whm-data__stack">${aside}</aside></div>`
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
  return `<div class="v2-whm-data__scroll" role="region" tabindex="0" aria-label="${esc(title)}"><table><caption class="v2-sr">${esc(title)}</caption><thead><tr>${headers.map(label => `<th scope="col">${esc(t(label))}</th>`).join('')}</tr></thead><tbody${hookAttrs(hooks)} data-columns="${headers.length}"><tr><td colspan="${headers.length}">${esc(unread)}</td></tr></tbody></table></div>`
}
export function page(input: WhmDataPageInput, route: string, title: string, description: string, body: string, hooks?: HookAttributes): string {
  const { t, canRead } = context(input)
  return `<section class="v2-whm-data" lang="${esc(input.locale ?? 'en')}" dir="${localeDirection(input.locale ?? 'en')}" data-whm-detail-route="${esc(route)}" data-capability-state="${canRead ? 'authorized' : 'unavailable'}"${hookAttrs(hooks)}>${pageHeader(t, { route, title, description, breadcrumb: [{ label: t(msgid('Home')), href: '/whm' }, { label: title }] })}${body}${v2SoftwareClientTemplates(route)}</section>`
}

export const WHM_DATA_COMMON_CSS = `.v2-whm-data{display:flex;flex-direction:column;gap:var(--space-4);min-inline-size:0}
.v2-whm-data :is(p,dl,dd,ul,ol,pre,fieldset){margin:0}
.v2-whm-data__stack,.v2-whm-data form{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0}
.v2-whm-data__fields,.v2-whm-data__facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2);min-inline-size:0}
.v2-whm-data__facts>div{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0;text-align:start}
.v2-whm-data__facts dt{font-size:13px;color:var(--muted);font-weight:600}
.v2-whm-data__facts dd{overflow-wrap:anywhere;text-align:start}
.v2-whm-data__actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.v2-whm-data[data-whm-software-center] .v2-software-center__identity{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0}
.v2-whm-data__check{display:flex;align-items:flex-start;gap:var(--space-1);min-block-size:var(--target)}
.v2-whm-data__check>input{flex:none;margin-block:4px 0}
.v2-whm-data__split{display:grid;grid-template-columns:minmax(0,2fr) minmax(260px,1fr);gap:var(--space-3);align-items:start}
.v2-whm-data__scroll{min-inline-size:0;max-inline-size:100%;overflow-x:auto}
.v2-whm-data__scroll table{min-inline-size:640px}
.v2-whm-data__scroll :is(th,td){text-align:start;vertical-align:top}
.v2-whm-data__changes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--space-3)}
.v2-whm-data__changes>div{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0}
.v2-whm-data__list{padding-inline-start:var(--space-3);display:flex;flex-direction:column;gap:var(--space-2)}
.v2-whm-data__preview{display:flex;flex-direction:column;gap:var(--space-3);padding:var(--v2-panel-padding);border:1px solid var(--line);border-radius:var(--radius-control)}
.v2-whm-data pre{white-space:pre-wrap;overflow-wrap:anywhere}
.v2-whm-data :is(input,textarea,select)[dir=ltr]{text-align:var(--v2-control-align,start)}
.v2-whm-data [hidden]{display:none!important}
@media(max-width:1000px){.v2-whm-data__split{grid-template-columns:minmax(0,1fr)}}
@media(max-width:600px){.v2-whm-data__fields,.v2-whm-data__facts,.v2-whm-data__changes{grid-template-columns:minmax(0,1fr)}}
`
