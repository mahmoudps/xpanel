import type { WhmSurfaceProps } from '../../../../contract.ts'
import { localeDirection, type Translate } from '../../../../../i18n.ts'
import { v2Messages } from '../../../messages.ts'
import { escapeHtml, hookAttrs, type HookAttributes } from '../../../html.ts'
import { card } from '../../../components/card.ts'
import { pageHeader } from '../../../components/page-header.ts'
import { mailCardsFor } from '../../../../../mail-cards.ts'
import { renderV2MailCards } from '../../mail-cards.ts'
import type { WhmStoredFactAuthority } from '../stored-facts.ts'

/** Core has already authorized the listener, principal and specific mail capability. */
export interface WhmMailAuthority extends WhmStoredFactAuthority { readonly canRead: boolean; readonly canManage: boolean; readonly qualifiedTools?: ReadonlySet<string> }
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

/** Phone rows name each stacked value: the translated headers travel to CSS as custom properties on the table. */
export const columnLabels = (headers: readonly string[], offset = 0): string =>
  ` style="${escapeHtml(headers.map((label, index) => `--v2-col-${index + 1 + offset}:'${label.replace(/[\\']/g, '\\$&')}'`).join(';'))}"`

export function table(t: Translate, title: string, headers: readonly string[], hooks: HookAttributes, empty = t(msgid('Nothing has been read.'))): string {
  return `<div class="v2-whm-mail__scroll" role="region" tabindex="0" aria-label="${escapeHtml(title)}"><table class="v2-whm-mail__table"${columnLabels(headers)}><caption class="v2-sr">${escapeHtml(title)}</caption><thead><tr>${headers.map(label => `<th scope="col">${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody${hookAttrs(hooks)}><tr><td colspan="${headers.length}">${escapeHtml(empty)}</td></tr></tbody></table></div>`
}

export function page(input: WhmMailPageInput, route: string, title: string, description: string, body: string): string {
  const { t, canRead, canManage, locale } = mailContext(input)
  const cards = renderV2MailCards(mailCardsFor(route, t, { canRead, canAct: tool => canManage && input.mailAuthority?.qualifiedTools?.has(tool) === true }), locale)
  const head = pageHeader(t, { route, title, description, breadcrumb: [
    { label: t(msgid('Home')), href: '/whm' }, { label: t(msgid('Email')) }, { label: title },
  ] })
  return `<section class="v2-whm-mail" data-whm-detail-route="${escapeHtml(route)}" data-capability-state="${canRead ? 'authorized' : 'unavailable'}">${head}${body}${cards}</section>`
}

export const WHM_MAIL_CSS = `.v2-whm-mail,.v2-whm-mail__stack{display:flex;flex-direction:column;gap:var(--space-4);min-inline-size:0}
.v2-whm-mail__fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:start;gap:var(--space-2);min-inline-size:0}
.v2-whm-mail__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(150px,100%),1fr));gap:var(--space-2);margin:0;min-inline-size:0}
.v2-whm-mail .v2-card__body p:not([role=alert],[data-state=failed],[data-state=error]){font-size:13px;line-height:1.6;color:var(--text-2)}
.v2-whm-mail .v2-card__body p[role=status]{color:var(--muted)}
.v2-card .v2-whm-mail__stack{gap:var(--space-2)}
.v2-whm-mail__facts>div,.v2-whm-mail__field{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0;text-align:start}
.v2-whm-mail__field>label{padding-inline:13px;font-size:13px;line-height:1.25;font-weight:600}
.v2-whm-mail__facts dt{font-size:12px;color:var(--muted)}
.v2-whm-mail__facts dd{margin:0;font-size:14px;overflow-wrap:break-word}
.v2-whm-mail__field>label,.v2-whm-mail__field>span[id],.v2-whm-mail .v2-field>label,.v2-whm-mail__facts dt{text-box-trim:trim-end;text-box-edge:text}
.v2-whm-mail__facts dd{text-box-trim:trim-start;text-box-edge:text}
.v2-whm-mail__field :is(input:not([type=checkbox],[type=radio]),select,textarea){inline-size:100%;min-inline-size:0}
.v2-whm-mail [dir=ltr]:is(input,select,textarea,pre){text-align:var(--v2-control-align,start)}
.v2-whm-mail :is(fieldset,form){margin:0;min-inline-size:0;display:flex;flex-direction:column;gap:var(--space-3)}
.v2-whm-mail fieldset{border:0;padding:0}
.v2-whm-mail legend{float:inline-start;inline-size:100%;padding:0;font-size:14px;font-weight:600}
.v2-whm-mail__actions,.v2-whm-mail__check{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.v2-whm-mail__check{gap:var(--space-1);min-block-size:var(--target)}
.v2-whm-mail__scroll{min-inline-size:0;overflow-x:auto;border:1px solid var(--line);border-radius:var(--radius-notice)}
.v2-whm-mail__table{inline-size:100%}
.v2-whm-mail__table td[colspan]{color:var(--muted)}
.v2-whm-mail__table{min-inline-size:720px}
.v2-whm-mail__table :is(th,td){text-align:start;vertical-align:top}
.v2-whm-mail__split{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:var(--space-3);align-items:start}
.v2-whm-mail__split>.v2-whm-mail__stack{gap:var(--space-3)}
.v2-whm-mail__split>:last-child :is(.v2-whm-mail__fields,.v2-whm-mail__facts){grid-template-columns:repeat(2,minmax(0,1fr))}
.v2-whm-mail__split>:last-child .v2-whm-mail__fields{grid-template-columns:minmax(0,1fr)}
.v2-whm-mail__timeline{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:var(--space-2)}
.v2-whm-mail__timeline>li{display:flex;flex-direction:column;gap:var(--space-1);padding-inline-start:var(--space-2);border-inline-start:2px solid var(--line)}
.v2-whm-mail__status{overflow-wrap:anywhere}
.v2-whm-mail pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.v2-whm-mail__field>pre{padding:10px 12px;border:1px solid var(--line);border-radius:var(--radius-control);background:var(--subtle)}
.v2-whm-mail [hidden]{display:none!important}
.v2-whm-mail form>.v2-btn{align-self:flex-start}
.v2-whm-mail__split .v2-whm-mail__table{min-inline-size:0}
.v2-whm-mail__split .v2-whm-mail__table :is(th,td){white-space:normal;padding-inline:12px}
.v2-whm-mail__table :is(th,td){padding-inline:12px}
.v2-whm-mail__table td{overflow-wrap:break-word}
.v2-whm-mail [data-whm-mail-quality-rows] td[data-check] strong[data-state=unchecked]{font-weight:400;color:var(--muted)}
.v2-whm-mail__table tr:has(button)>:is(th,td){vertical-align:middle}
.v2-whm-mail [data-list-reset] .v2-card__title{display:flex;flex-direction:column;gap:8px}
.v2-whm-mail [data-list-reset] .v2-actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.v2-whm-mail td[data-xp-slot=actions]>.v2-btn+.v2-btn{margin-inline-start:8px}
.v2-whm-mail :is(input.v2-mono:placeholder-shown,select.v2-mono:has(>option[value=""]:checked)){font-family:inherit}
.v2-whm-mail__table tr:has(>td:nth-child(10))>td:is(:nth-child(7),:nth-child(8)){overflow-wrap:anywhere}
.v2-whm-mail__table td>select{inline-size:100%;min-inline-size:200px;max-inline-size:260px}
@media(min-width:601px){.v2-whm-mail__table tr:has(>td:nth-child(10))>td:is(:nth-child(2),:nth-child(3),:nth-child(5),:nth-child(6)){overflow-wrap:normal;white-space:nowrap}.v2-whm-mail__table:has(>[data-whm-mail-queue-rows]){min-inline-size:1080px}.v2-whm-mail__table:has(>[data-whm-mail-queue-rows]) tr>:last-child:not([colspan]){position:sticky;inset-inline-end:0;background:var(--surface);border-inline-start:1px solid var(--line)}.v2-whm-mail__table:has(>[data-whm-mail-queue-rows]) thead tr>:last-child{background:var(--subtle)}}
@media(min-width:901px){.v2-whm-mail__fields:has(>:nth-child(3):last-child){grid-template-columns:repeat(3,minmax(0,1fr))}}
.v2-whm-mail__table td>.v2-whm-mail__actions{display:grid;grid-template-columns:repeat(2,max-content);gap:6px}
.v2-whm-mail__table td>.v2-whm-mail__actions>.v2-btn{padding-inline:10px;font-size:13px}
.v2-whm-mail .v2-card__body p.v2-whm-mail__status:is([data-state=uncertain],[data-state=stale]){padding:12px var(--space-2);border:1px solid var(--bad-line);border-radius:var(--radius-notice);background:var(--bad-soft);color:var(--text)}
.v2-whm-mail input[type=file]{inline-size:100%;max-inline-size:480px;min-block-size:var(--target);padding:6px;border:1px dashed var(--line-strong);border-radius:var(--radius-control);background:var(--subtle);color:var(--text-2);font-size:13px}
.v2-whm-mail input[type=file]::file-selector-button{min-block-size:var(--target);margin-inline-end:12px;padding:0 12px;border:1px solid var(--line-strong);border-radius:var(--radius-chip);background:var(--surface);color:var(--text);font:inherit;font-weight:600;cursor:pointer}
.v2-whm-mail dd:empty::before{content:"—";color:var(--muted)}
.v2-whm-mail__field>span[id]{padding-inline:13px;font-size:13px;line-height:1.25;font-weight:600}
.v2-whm-mail form>fieldset+fieldset{padding-block-start:var(--space-3);border-block-start:1px solid var(--line)}
.v2-whm-mail form>fieldset{gap:var(--space-2)}
.v2-whm-mail [data-whm-mail-log=monitor] [data-mail-log-form]{flex-direction:row;flex-wrap:wrap;align-items:flex-end}
.v2-whm-mail [data-whm-mail-log=monitor] [data-mail-log-form]>.v2-whm-mail__fields{flex:0 1 360px;grid-template-columns:minmax(0,1fr)}
.v2-whm-mail [data-whm-mail-queue-bulk=delete]{margin-inline-start:auto}
.v2-whm-mail tbody th{background:none;color:var(--text);font-size:14px;font-weight:500;white-space:normal}
.v2-whm-mail [data-mailx-form]>.v2-whm-mail__status:empty{margin-block-start:calc(-1 * var(--space-3))}
.v2-whm-mail__facts:has(>div>[data-mail-monitor-count]){grid-template-columns:repeat(3,minmax(0,1fr))}
@media(min-width:901px){.v2-whm-mail__facts:has(>:nth-child(6):last-child){grid-template-columns:repeat(3,minmax(0,1fr))}.v2-whm-mail__facts:has(>:nth-child(7)){grid-template-columns:repeat(4,minmax(0,1fr))}
.v2-whm-mail [data-mailx-form]>.v2-whm-mail__fields{grid-template-columns:repeat(6,minmax(0,1fr))}.v2-whm-mail [data-mailx-form]>.v2-whm-mail__fields>*{grid-column:span 3}
.v2-whm-mail [data-mailx-page=spam] [data-mailx-form]>.v2-whm-mail__fields>.v2-field:has(>[type=number]),.v2-whm-mail [data-mailx-page=marketing] .v2-whm-mail [data-mailx-form]>.v2-whm-mail__fields>*{grid-column:span 2}
.v2-whm-mail [data-mailx-form]>.v2-whm-mail__fields>:is([data-mailx-page=spam] .v2-field:has(>textarea),[data-mailx-page=relay] .v2-whm-mail__field,[data-mailx-page=bcc] .v2-field:has(>[type=email])){grid-column:1/-1}}
@media(min-width:1101px){.v2-whm-mail__facts:has(>div>[data-mail-monitor-count]){grid-template-columns:repeat(6,minmax(0,1fr))}}
@media(min-width:901px){.v2-whm-mail__facts:has([data-mail-log-fact=window]){grid-template-columns:minmax(0,1fr) minmax(0,2fr) minmax(0,1fr) minmax(0,1fr)}}
@media(max-width:1100px){.v2-whm-mail__split{grid-template-columns:minmax(0,1fr)}}
@media(max-width:600px){.v2-whm-mail :is(.v2-whm-mail__scroll tr:not(:has(>td>[type=checkbox]))>td:nth-child(n+3):not([colspan],:empty),.v2-whm-mail__scroll tr:has(>td>[type=checkbox])>td:nth-child(n+4):not(:empty)){grid-column:1/-1;display:flex;justify-content:space-between;align-items:baseline;gap:16px;text-align:end}
.v2-whm-mail :is(.v2-whm-mail__scroll tr:not(:has(>td>[type=checkbox]))>td:nth-child(n+3):not([colspan],:empty),.v2-whm-mail__scroll tr:has(>td>[type=checkbox])>td:nth-child(n+4):not(:empty))::before{flex:none;font-size:13px;color:var(--muted);text-align:start}
.v2-whm-mail__scroll td:nth-child(3):not([colspan])::before{content:var(--v2-col-3)}.v2-whm-mail__scroll tr:has(>td>[type=checkbox])>td:nth-child(3)::before{content:none}.v2-whm-mail__scroll td:nth-child(4):not([colspan])::before{content:var(--v2-col-4)}.v2-whm-mail__scroll td:nth-child(5):not([colspan])::before{content:var(--v2-col-5)}.v2-whm-mail__scroll td:nth-child(6):not([colspan])::before{content:var(--v2-col-6)}.v2-whm-mail__scroll td:nth-child(7):not([colspan])::before{content:var(--v2-col-7)}.v2-whm-mail__scroll td:nth-child(8):not([colspan])::before{content:var(--v2-col-8)}.v2-whm-mail__scroll td:nth-child(9):not([colspan])::before{content:var(--v2-col-9)}.v2-whm-mail__scroll td:nth-child(10):not([colspan])::before{content:var(--v2-col-10)}}
@media(max-width:600px){.v2-whm-mail__table td>.v2-whm-mail__actions>.v2-btn{min-block-size:var(--target)}.v2-whm-mail table.v2-whm-mail__table tr>td:first-child:has(>[type=checkbox]){grid-column:auto;grid-row:auto;line-height:0}.v2-whm-mail__fields{grid-template-columns:minmax(0,1fr)}.v2-whm-mail__facts{grid-template-columns:repeat(2,minmax(0,1fr))}.v2-whm-mail__table{min-inline-size:560px}}
`
