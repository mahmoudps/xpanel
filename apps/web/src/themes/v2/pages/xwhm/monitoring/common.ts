import { localeDirection, type Translate } from '../../../../../i18n.ts'
import type { WhmSurfaceProps } from '../../../../contract.ts'
import { card } from '../../../components/card.ts'
import { pageHeader } from '../../../components/page-header.ts'
import { escapeHtml, hookAttrs, type HookAttributes } from '../../../html.ts'
import { v2Messages } from '../../../messages.ts'

/** Core supplies independent read and mutation decisions after catalog and principal admission. */
export interface ObservationAuthority { readonly canRead: boolean; readonly canManage: boolean }
export interface WhmObservationInput extends WhmSurfaceProps {
  readonly observationAuthority?: ObservationAuthority
  /** The reviewed unit list and bounds are supplied by the host contract, never inferred from user input. */
  readonly monitoringLogUnits?: readonly string[]
  readonly monitoringLogDefaultLines?: number
  readonly monitoringLogMaxLines?: number
}

export const esc = escapeHtml
export function context(input: WhmObservationInput) {
  const locale = input.locale ?? 'en'
  const canRead = input.observationAuthority?.canRead === true && input.capabilityUnavailable !== true
  return { locale, t: v2Messages.translator(locale), canRead, canManage: canRead && input.observationAuthority?.canManage === true }
}
export const technical = (value: string | number): string => `<bdi dir="ltr" class="v2-mono">${esc(value)}</bdi>`
export const actions = (body: string): string => `<div class="v2-observation__actions">${body}</div>`
export const fields = (body: string): string => `<div class="v2-observation__fields">${body}</div>`
export const help = (t: Translate, text: string, hooks?: HookAttributes): string => `<p class="v2-muted"${hookAttrs(hooks)}>${esc(t(text))}</p>`
export const button = (t: Translate, text: string, hooks?: HookAttributes, enabled = false, primary = false, type: 'button' | 'submit' = 'button'): string => `<button type="${type}" class="v2-btn${primary ? ' v2-btn--primary' : ''}"${hookAttrs(hooks)}${enabled ? '' : ' disabled'}>${esc(t(text))}</button>`
export const link = (t: Translate, text: string, href: string, hooks?: HookAttributes): string => `<a class="v2-btn" href="${esc(href)}"${hookAttrs(hooks)}>${esc(t(text))}</a>`
export const field = (t: Translate, id: string, label: string, control: string, helpText?: string): string => `<div class="v2-field"><label for="${esc(id)}">${esc(t(label))}</label>${control}${helpText ? help(t, helpText) : ''}</div>`
export const inputControl = (id: string, hooks: HookAttributes, enabled = false, extra = '', type = 'text'): string => `<input id="${esc(id)}" type="${esc(type)}"${hookAttrs(hooks)}${extra}${enabled ? '' : ' disabled'}>`
export const area = (id: string, hooks: HookAttributes, extra = ''): string => `<textarea id="${esc(id)}"${hookAttrs(hooks)}${extra} disabled></textarea>`
export const select = (t: Translate, id: string, hooks: HookAttributes, choices: readonly (readonly [string, string])[], enabled = false): string => `<span class="v2-select"><select id="${esc(id)}"${hookAttrs(hooks)}${enabled ? '' : ' disabled'}>${choices.map(([value, label]) => `<option value="${esc(value)}">${esc(t(label))}</option>`).join('')}</select></span>`
export const check = (t: Translate, label: string, hooks: HookAttributes, enabled = false, ariaLabel?: string): string => `<label class="v2-observation__check"><input type="checkbox"${hookAttrs(hooks)}${ariaLabel ? ` aria-label="${esc(ariaLabel)}"` : ''}${enabled ? '' : ' disabled'}><span>${esc(t(label))}</span></label>`
export const status = (t: Translate, text: string, hooks: HookAttributes, state = 'unread', hidden = false): string => `<p class="v2-observation__status" role="status" data-state="${esc(state)}"${hookAttrs(hooks)}${hidden ? ' hidden' : ''}>${esc(t(text))}</p>`
export function facts(t: Translate, items: readonly (readonly [string, string])[], attribute: `data-${string}`, value = t(msgid('Not read'))): string {
  return `<dl class="v2-observation__facts">${items.map(([key, label]) => `<div><dt>${esc(t(label))}</dt><dd><bdi dir="ltr"${hookAttrs({ [attribute]: key })}>${esc(value)}</bdi></dd></div>`).join('')}</dl>`
}
export function markerFacts(t: Translate, items: readonly (readonly [string, string])[], prefix: string): string {
  return `<dl class="v2-observation__facts">${items.map(([key, label]) => `<div><dt>${esc(t(label))}</dt><dd><bdi dir="ltr"${hookAttrs({ [`data-${prefix}-${key}`]: true })}>${esc(t(msgid('Not read')))}</bdi></dd></div>`).join('')}</dl>`
}
export const section = (t: Translate, id: string, title: string, bodyHtml: string, hooks?: HookAttributes, hidden = false, elementId?: string): string => hidden
  ? `<div${elementId ? ` id="${esc(elementId)}"` : ''}${hookAttrs(hooks)} hidden>${card({ title: t(title), titleId: `v2-observation-${id}`, bodyHtml })}</div>`
  : card({ title: t(title), titleId: `v2-observation-${id}`, bodyHtml, hooks, ...(elementId ? { id: elementId } : {}) })
export function table(t: Translate, title: string, columns: readonly string[], hooks: HookAttributes, empty = msgid('Not read'), numeric: readonly number[] = []): string {
  return `<div class="v2-observation__scroll" role="region" tabindex="0" aria-label="${esc(t(title))}"><table><caption class="v2-sr">${esc(t(title))}</caption><thead><tr>${columns.map((label, index) => `<th scope="col"${numeric.includes(index) ? ' data-numeric' : ''}>${esc(t(label))}</th>`).join('')}</tr></thead><tbody${hookAttrs(hooks)}><tr><td colspan="${columns.length}">${esc(t(empty))}</td></tr></tbody></table></div>`
}
export function page(input: WhmObservationInput, route: string, title: string, description: string, body: string, hooks?: HookAttributes): string {
  const { t, locale, canRead } = context(input)
  return `<section class="v2-observation" data-whm-detail-route="${esc(route)}" data-capability-state="${canRead ? 'authorized' : 'unavailable'}" lang="${esc(locale)}" dir="${localeDirection(locale)}"${hookAttrs(hooks)}>${pageHeader(t, { route, title: t(title), description: t(description), breadcrumb: [{ label: t(msgid('Home')), href: '/whm' }, { label: t(title) }] })}${body}</section>`
}

/** Shared only by these diagnostic, security and activity bodies; no global component overrides. */
export const WHM_OBSERVATION_CSS = `.v2-observation{display:flex;flex-direction:column;gap:32px;min-inline-size:0}
.v2-observation :is(h2,h3,p,dl,dd,pre,fieldset,ul,ol){margin:0}
.v2-observation .v2-card__body{gap:24px}
.v2-observation__groups{display:flex;flex-direction:column;gap:24px;min-inline-size:0}
.v2-observation__fields,.v2-observation__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:16px;min-inline-size:0}
.v2-observation__facts>div,.v2-observation .v2-field{display:flex;flex-direction:column;gap:8px;min-inline-size:0;text-align:start}
.v2-observation__facts dt{font-size:13px;color:var(--muted)}
.v2-observation__facts dd{overflow-wrap:anywhere;text-align:start}
.v2-observation__actions{display:flex;flex-wrap:wrap;align-items:center;gap:16px}
.v2-observation__check{display:flex;align-items:flex-start;gap:8px;min-block-size:var(--target)}
.v2-observation__check>input{flex:none;margin:0}
.v2-observation .v2-field :is(input,select,textarea){inline-size:100%;min-inline-size:0}
.v2-observation .v2-field [dir=ltr]{text-align:var(--v2-control-align,start)}
.v2-observation__scroll{max-inline-size:100%;overflow:auto;min-inline-size:0}
.v2-observation :is(th,td){text-align:start;vertical-align:top;padding:12px 16px;overflow-wrap:anywhere}
.v2-observation__log{max-block-size:480px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;border:1px solid var(--line);border-radius:var(--radius-control);background:var(--code);color:var(--code-text);font:13px/1.6 var(--font-mono)}
.v2-observation__list{display:flex;flex-direction:column;gap:16px;list-style:none;padding:0;min-inline-size:0}
.v2-observation__charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:16px}
.v2-observation__job-progress{display:flex;gap:8px;align-items:center;min-inline-size:128px}
.v2-observation__job-progress>.v2-bar{flex:1 1 auto;min-inline-size:64px}
.v2-observation__chart{display:flex;flex-direction:column;gap:8px;min-inline-size:0;padding:16px;border:1px solid var(--line);border-radius:var(--radius-control)}
.v2-observation details>summary{min-block-size:var(--target);align-content:center;cursor:pointer;font-weight:600}
.v2-observation details[open]>:not(summary){margin-block-start:16px}
.v2-observation fieldset{padding:16px;border:1px solid var(--line);border-radius:var(--radius-control);min-inline-size:0}
.v2-observation fieldset>legend{padding-inline:8px;font-weight:600}
.v2-observation [hidden]{display:none}
@media(max-width:640px){.v2-observation__fields,.v2-observation__facts{grid-template-columns:minmax(0,1fr)}}
`
