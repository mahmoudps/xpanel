import type { WhmSurfaceProps } from '../../../../contract.ts'
import { localeDirection, type Translate } from '../../../../../i18n.ts'
import { v2Messages } from '../../../messages.ts'
import { escapeHtml, hookAttrs, type HookAttributes } from '../../../html.ts'
import { card } from '../../../components/card.ts'
import { pageHeader } from '../../../components/page-header.ts'

/** Core has already authorized the listener, principal and specific mail capability. */
export interface WhmMailAuthority { readonly canRead: boolean; readonly canManage: boolean }
export interface WhmMailPageInput extends WhmSurfaceProps { readonly mailAuthority?: WhmMailAuthority }

export function mailContext(input: WhmMailPageInput) {
  const locale = input.locale ?? 'en'
  const canRead = input.mailAuthority?.canRead === true && input.capabilityUnavailable !== true
  return { t: v2Messages.translator(locale), locale, dir: localeDirection(locale), canRead,
    canManage: canRead && input.mailAuthority?.canManage === true }
}

export const technical = (value: string | number): string => `<bdi class="v2-mono" dir="ltr">${escapeHtml(value)}</bdi>`
export const button = (label: string, hooks: HookAttributes, disabled = true, tone: 'default' | 'primary' | 'danger' = 'default'): string =>
  `<button type="button" class="v2-btn${tone === 'default' ? '' : ` v2-btn--${tone}`}"${hookAttrs(hooks)}${disabled ? ' disabled' : ''}>${escapeHtml(label)}</button>`
export const status = (message: string, hooks: HookAttributes, hidden = false): string =>
  `<p class="v2-whm-mail__status" role="status" data-state="unread"${hookAttrs(hooks)}${hidden ? ' hidden' : ''}>${escapeHtml(message)}</p>`
export const group = (key: string, title: string, bodyHtml: string, actionsHtml?: string): string =>
  card({ title, titleId: `v2-whm-mail-${key}`, bodyHtml, ...(actionsHtml ? { actionsHtml } : {}) })

export function facts(t: Translate, rows: readonly (readonly [string, string])[], attribute: string): string {
  return `<dl class="v2-whm-mail__facts">${rows.map(([key, label]) => `<div><dt>${escapeHtml(t(label))}</dt><dd><bdi dir="ltr" ${attribute}="${escapeHtml(key)}">${escapeHtml(t(msgid('Not read')))}</bdi></dd></div>`).join('')}</dl>`
}

export function table(t: Translate, title: string, headers: readonly string[], hooks: HookAttributes, empty = t(msgid('Nothing has been read.'))): string {
  return `<div class="v2-whm-mail__scroll" role="region" tabindex="0" aria-label="${escapeHtml(title)}"><table class="v2-whm-mail__table"><caption class="v2-sr">${escapeHtml(title)}</caption><thead><tr>${headers.map(label => `<th scope="col">${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody${hookAttrs(hooks)}><tr><td colspan="${headers.length}">${escapeHtml(empty)}</td></tr></tbody></table></div>`
}

export function page(input: WhmMailPageInput, route: string, title: string, description: string, body: string): string {
  const { t, canRead } = mailContext(input)
  const head = pageHeader(t, { route, title, description, breadcrumb: [
    { label: t(msgid('Home')), href: '/whm' }, { label: t(msgid('Email')) }, { label: title },
  ] })
  return `<section class="v2-whm-mail" data-whm-detail-route="${escapeHtml(route)}" data-capability-state="${canRead ? 'authorized' : 'unavailable'}">${head}${body}</section>`
}

export const WHM_MAIL_CSS = `.v2-whm-mail,.v2-whm-mail__stack{display:flex;flex-direction:column;gap:var(--space-4);min-inline-size:0}
.v2-whm-mail__fields,.v2-whm-mail__facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2);min-inline-size:0}
.v2-whm-mail__facts>div,.v2-whm-mail__field{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0;text-align:start}
.v2-whm-mail__facts dt,.v2-whm-mail__field>label{font-size:13px;font-weight:600;color:var(--text-2)}
.v2-whm-mail__facts dd{margin:0;overflow-wrap:anywhere}
.v2-whm-mail__field :is(input,select,textarea){inline-size:100%;min-inline-size:0}
.v2-whm-mail [dir=ltr]:is(input,select,textarea,pre){text-align:var(--v2-control-align,start)}
.v2-whm-mail :is(fieldset,form){margin:0;min-inline-size:0;display:flex;flex-direction:column;gap:var(--space-3)}
.v2-whm-mail fieldset{border:0;padding:0}
.v2-whm-mail legend{font-weight:600;margin-block-end:var(--space-2);padding:0}
.v2-whm-mail__actions,.v2-whm-mail__check{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.v2-whm-mail__check{gap:var(--space-1);min-block-size:var(--target)}
.v2-whm-mail__scroll{min-inline-size:0;overflow-x:auto}
.v2-whm-mail__table{min-inline-size:720px}
.v2-whm-mail__table :is(th,td){text-align:start;vertical-align:top}
.v2-whm-mail__split{display:grid;grid-template-columns:minmax(0,2fr) minmax(280px,1fr);gap:var(--space-3);align-items:start}
.v2-whm-mail__timeline{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:var(--space-2)}
.v2-whm-mail__timeline>li{display:flex;flex-direction:column;gap:var(--space-1);padding-inline-start:var(--space-2);border-inline-start:2px solid var(--line)}
.v2-whm-mail__status{overflow-wrap:anywhere}
.v2-whm-mail pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.v2-whm-mail [hidden]{display:none!important}
@media(max-width:1000px){.v2-whm-mail__split{grid-template-columns:minmax(0,1fr)}}
@media(max-width:600px){.v2-whm-mail__fields,.v2-whm-mail__facts{grid-template-columns:minmax(0,1fr)}}
`
