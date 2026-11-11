import type { Locale, Translate } from '../../../../../i18n.ts'
import { escapeHtml, hookAttrs, type HookAttributes } from '../../../html.ts'
import { card, pageHeader } from '../../../components/index.ts'
import { icon } from '../../../icons.ts'
import { whmPolish } from '../monitoring/common.ts'

/** Admission is supplied by core; a theme never derives permissions from a role name. */
export interface LifecycleAccess {
  readonly locale: Locale
  readonly canRead: boolean
  readonly canManage: boolean
}

export const text = (t: Translate, value: string): string => escapeHtml(t(value))

export function lifecycleHeader(t: Translate, title: string, route: string, description: string, actionsHtml?: string): string {
  return pageHeader(t, {
    breadcrumb: [{ label: t(msgid('Home')), href: '/whm' }, { label: t(msgid('Server administration')) }, { label: t(title) }],
    title: t(title), route, description: t(description), ...(actionsHtml ? { actionsHtml } : {}),
  })
}

/** A header or card link to a neighbouring page or to a card on this page. */
export const lifecycleLink = (t: Translate, label: string, href: string): string => `<a class="v2-btn" href="${escapeHtml(href)}">${text(t, label)}</a>`

/** Standing rules of a workflow: each line carries a check mark, never a state. */
export const lifecycleRules = (t: Translate, labels: readonly string[]): string =>
  `<ul class="v2-lifecycle__rules">${labels.map(label => `<li>${icon('check', 16)}<span>${text(t, label)}</span></li>`).join('')}</ul>`

export function lifecycleCard(t: Translate, key: string, title: string, bodyHtml: string, hooks?: HookAttributes): string {
  return card({ title: t(title), titleId: `v2-lifecycle-${key}`, bodyHtml, ...(hooks ? { hooks } : {}) })
}

export function lifecycleButton(t: Translate, label: string, hooks: HookAttributes, primary = false): string {
  return `<button type="button" class="v2-btn${primary ? ' v2-btn--primary' : ''}"${hookAttrs(hooks)} disabled>${text(t, label)}</button>`
}

export function lifecycleStatus(t: Translate, label: string, hooks: HookAttributes, hidden = false): string {
  return `<p class="v2-lifecycle__status" role="status"${hookAttrs(hooks)}${hidden ? ' hidden' : ''}>${text(t, label)}</p>`
}

export function lifecycleField(t: Translate, id: string, label: string, controlHtml: string, help?: string): string {
  const helpId = `${id}-help`
  const control = help ? controlHtml.replace(/^<(input|select|textarea)\b/, `<$1 aria-describedby="${escapeHtml(helpId)}"`) : controlHtml
  return `<div class="v2-lifecycle__field"><label for="${escapeHtml(id)}">${text(t, label)}</label>${control}${help ? `<p class="v2-muted" id="${escapeHtml(helpId)}">${text(t, help)}</p>` : ''}</div>`
}

/** Which cell is the row name (default the first) and which value sits opposite it on a phone. */
export interface PhoneRow { readonly name?: number; readonly value?: number }

/** Phone rows name each stacked value: the translated column headers travel to CSS as custom properties on the table. */
export const phoneColumns = (labels: readonly string[], phone: PhoneRow = {}): string =>
  ` style="${escapeHtml(labels.map((label, index) => `--c${index + 1}:'${label.replace(/[\\']/g, '\\$&').replace(/\s+/g, ' ')}'`).join(';'))}"${phone.value ? ` data-phone-value="${phone.value}"` : ''}${phone.name ? ` data-phone-name="${phone.name}"` : ''}`

export function lifecycleTable(t: Translate, title: string, columns: readonly string[], hooks: HookAttributes, empty: string, phone: PhoneRow = {}): string {
  return `<div class="v2-lifecycle__scroll" role="region" tabindex="0" aria-label="${text(t, title)}"><table class="v2-lifecycle__table"${phoneColumns(columns.map(column => t(column)), phone)}><caption class="v2-sr">${text(t, title)}</caption><thead><tr>${columns.map(column => `<th scope="col">${text(t, column)}</th>`).join('')}</tr></thead><tbody${hookAttrs(hooks)}><tr><td colspan="${columns.length}">${text(t, empty)}</td></tr></tbody></table></div>`
}

export function lifecycleFacts(t: Translate, facts: readonly { key: string; label: string; value?: string }[], hook: `data-${string}`): string {
  return `<dl class="v2-lifecycle__fields">${facts.map(fact => `<div class="v2-lifecycle__field"><dt>${text(t, fact.label)}</dt><dd><bdi dir="ltr"${hookAttrs({ [hook]: fact.key })}>${fact.value === undefined ? text(t, msgid('Not read')) : escapeHtml(fact.value)}</bdi></dd></div>`).join('')}</dl>`
}

/** The same placement for a table whose markup this page cannot mark: the name and value cells are fixed in the rule. */
const fixedRow = (row: string, { name = 1, value }: PhoneRow): string => `${name === 1 ? '' : `
${row}>:first-child{grid-area:auto;font-weight:400}${row}>:first-child::before{content:var(--c1,none);display:block;margin-block-end:2px;color:var(--muted);font-size:11px;font-weight:500;line-height:1.4}
${row}>:nth-child(${name}){grid-area:1/1;font-weight:600;color:var(--text)}${row}>:nth-child(${name})::before{content:none}`}${value ? `
${name === 1 ? `${row}>:first-child{grid-area:1/1}` : ''}${row}>:nth-child(${value}){grid-area:1/2;justify-self:end;text-align:end;font-weight:400}${row}>:nth-child(${value})::before{content:none}` : ''}`

/** Two-column rows for a narrow table: the row name with the chosen value opposite it, the other values
 *  under them in pairs with their column header, actions and messages on a full line. Shared with the recovery tools. */
export const phoneRows = (table: string, fixed?: PhoneRow): string => {
  // The repeated :nth-child(n) lifts these rules over the theme-wide phone rows, which place the second cell and a leading checkbox.
  const row = `${table}>tbody>tr:nth-child(n)`, cells = [2, 3, 4, 5, 6, 7, 8, 9]
  // A leading checkbox sits beside the row name, which then takes the full line, as in the theme-wide phone rows.
  const checked = `${row}:has(>:first-child [type=checkbox])`
  return `${table}>thead{position:absolute;inline-size:1px;block-size:1px;overflow:hidden;clip-path:inset(50%)}
${table},${table}>tbody{display:block}
${row}{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px 16px;padding:12px 16px;border-block-end:1px solid var(--line)}
${row}:last-child{border-block-end:0}
${row}>:nth-child(n){position:static;grid-area:auto;background:none;justify-self:stretch;padding:0;border:0;min-inline-size:0;text-align:start;overflow-wrap:anywhere}
${row}>:first-child{grid-column:1/-1;font-weight:600;color:var(--text)}
${row}>:not(:first-child)::before{display:block;margin-block-end:2px;color:var(--muted);font-size:11px;font-weight:500;line-height:1.4}
${cells.map(n => `${row}>:nth-child(${n})::before{content:var(--c${n},none)}`).join('')}
${row}>:is(td:has(.v2-btn,button,details),td[colspan]){grid-column:1/-1}
${row}>:is(td:has(.v2-btn,button,details),td[colspan])::before{content:none}
${table}[data-phone-value]:not([data-phone-name])>tbody>tr>:first-child{grid-area:1/1}
${table}[data-phone-name]>tbody>tr>:first-child:not([colspan]){grid-column:auto;font-weight:400}${table}[data-phone-name]>tbody>tr>:first-child:not([colspan])::before{content:var(--c1,none);display:block;margin-block-end:2px;color:var(--muted);font-size:11px;font-weight:500;line-height:1.4}
${[1, ...cells].map(n => `${table}[data-phone-value="${n}"]>tbody>tr>:nth-child(${n}){grid-area:1/2;justify-self:end;text-align:end;font-weight:400}${table}[data-phone-value="${n}"]>tbody>tr>:nth-child(${n})::before{content:none}`).join('')}
${[2, 3].map(n => `${table}[data-phone-name="${n}"]>tbody>tr>:nth-child(${n}){grid-area:1/1;font-weight:600;color:var(--text)}${table}[data-phone-name="${n}"]>tbody>tr>:nth-child(${n})::before{content:none}`).join('')}
${fixed ? fixedRow(row, fixed) : ''}
${checked}{position:relative;padding-inline-start:48px}
${checked}>:first-child{position:absolute;inset-block-start:12px;inset-inline-start:16px;grid-area:auto}
${checked}>:first-child::before{content:none}
${checked}>:nth-child(2){grid-area:1/1/auto/-1}
${row}>td[colspan]{grid-area:auto/1/auto/-1;justify-self:stretch;padding:12px 0;font-weight:400;text-align:center;color:var(--muted)}${row}>td[colspan]::before{content:none}`
}

/** Scoped to lifecycle bodies: compact table cells do not inherit panel padding. */
export const LIFECYCLE_PAGES_CSS = `.v2-lifecycle{display:flex;flex-direction:column;gap:32px;min-inline-size:0;text-align:start}
.v2-lifecycle .v2-card__body{gap:24px}
.v2-lifecycle .v2-lifecycle__address{display:flex;flex-wrap:wrap;gap:16px;grid-column:1/-1}
.v2-lifecycle .v2-lifecycle__address>div{flex:3 1 180px;min-inline-size:0}
.v2-lifecycle .v2-lifecycle__address>div:last-child{flex:1 1 72px}
.v2-lifecycle :is(p,dl,dd,h2,h3,ol,ul){margin:0}
.v2-lifecycle__grid{display:grid;grid-template-columns:minmax(0,2fr) minmax(260px,1fr);gap:24px;align-items:start}
.v2-lifecycle__column,.v2-lifecycle__group{display:flex;flex-direction:column;gap:24px;min-inline-size:0}
.v2-lifecycle__fields{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,220px),1fr));gap:16px;min-inline-size:0}
.v2-lifecycle dl.v2-lifecycle__fields{grid-template-columns:repeat(auto-fill,minmax(min(200px,calc(50% - 8px)),1fr))}
.v2-lifecycle aside dl.v2-lifecycle__fields{grid-template-columns:minmax(0,1fr)}
.v2-lifecycle__field{display:flex;flex-direction:column;gap:8px;min-inline-size:0;text-align:start}
.v2-lifecycle__field>label{padding-inline:13px;font-size:13px;line-height:1.25;font-weight:600}
.v2-lifecycle__field :is(input,select,textarea){inline-size:100%;min-inline-size:0;box-sizing:border-box}
.v2-lifecycle__field :is(input,select){min-block-size:44px}
.v2-lifecycle__field :is(dd,bdi){overflow-wrap:anywhere}
.v2-lifecycle [dir=ltr]{text-align:var(--v2-control-align,start);unicode-bidi:isolate}
.v2-lifecycle__actions,.v2-lifecycle__choices{display:flex;flex-wrap:wrap;gap:16px;align-items:center}
.v2-lifecycle__choice{display:flex;align-items:start;gap:8px;min-block-size:44px;overflow-wrap:anywhere}
.v2-lifecycle__choice>span{display:flex;flex-direction:column;gap:8px}
.v2-lifecycle__choice>input{flex:none;inline-size:20px;block-size:20px;margin:0}
.v2-lifecycle [data-approved-whm-backups] [role=radiogroup]{display:flex;flex-direction:column;gap:16px;min-inline-size:0}
.v2-lifecycle [data-approved-whm-backups] .v2-lifecycle__choice[role=radio]{inline-size:100%;align-items:center;min-block-size:52px;padding:8px 16px;border:1px solid var(--line-strong);border-radius:var(--radius-control);background:var(--surface);color:var(--text);font:inherit;text-align:start;cursor:pointer}
.v2-lifecycle [data-approved-whm-backups] .v2-lifecycle__choice[role=radio]>span:last-child{flex:1;min-inline-size:0;text-align:start}
.v2-lifecycle [data-approved-whm-backups] .v2-lifecycle__radio-ring{display:inline-flex;align-items:center;justify-content:center;flex:none;inline-size:18px;block-size:18px;border:2px solid var(--line-strong);border-radius:50%}
.v2-lifecycle [data-approved-whm-backups] [role=radio][aria-checked=true]{border-color:var(--accent-fill);background:var(--accent-soft)}
.v2-lifecycle [data-approved-whm-backups] [role=radio][aria-checked=true] .v2-lifecycle__radio-ring{border-color:var(--accent-fill)}
.v2-lifecycle [data-approved-whm-backups] [role=radio][aria-checked=true] .v2-lifecycle__radio-ring::after{content:"";inline-size:8px;block-size:8px;border-radius:50%;background:var(--accent-fill)}
.v2-lifecycle [data-approved-whm-backups] [role=radio]:disabled{color:var(--muted);background:var(--sunken);cursor:not-allowed}
.v2-lifecycle__scroll{max-inline-size:100%;overflow:auto}
.v2-lifecycle [data-transfer-revert-loss]:empty{display:none}
.v2-lifecycle [data-transfer-revert-loss] th{white-space:normal}
.v2-lifecycle__table{inline-size:100%;border-collapse:collapse;text-align:start}
.v2-lifecycle__table :is(th,td){padding:12px 16px;text-align:start;vertical-align:top;overflow-wrap:break-word;border-block-end:1px solid var(--line)}
.v2-lifecycle__table th{color:var(--muted);font-size:12px;font-weight:600;overflow-wrap:normal}
.v2-lifecycle__table td{font-size:13px}
.v2-lifecycle__table bdi{overflow-wrap:anywhere}
@media(min-width:1280px){.v2-lifecycle__table bdi{overflow-wrap:break-word}}
.v2-lifecycle :is(ul,ol):not([class],.v2-crumbs *){display:flex;flex-direction:column;gap:4px;padding-inline-start:20px;font-size:13px;line-height:1.6;color:var(--text-2)}
.v2-lifecycle__status{overflow-wrap:anywhere}.v2-lifecycle__status:not([role=alert],[data-state=failed],[data-state=error]){color:var(--muted)}
.v2-lifecycle__key{padding:16px;border-radius:var(--radius-control);background:var(--code);color:var(--code-text);font:12px/1.7 var(--font-mono);white-space:pre-wrap;overflow-wrap:anywhere}
.v2-lifecycle__steps{display:flex;flex-wrap:wrap;list-style:none;padding:0;gap:16px}
.v2-lifecycle__steps>li{display:flex;flex:1 1 180px;align-items:center;gap:8px;color:var(--muted)}
.v2-lifecycle__steps>li>span:first-child{display:flex;align-items:center;justify-content:center;inline-size:28px;block-size:28px;flex:none;border:1px solid var(--line-strong);border-radius:50%;font-variant-numeric:tabular-nums}
.v2-lifecycle__steps>li[aria-current=step]{color:var(--text);font-weight:600}
.v2-lifecycle__steps>li[aria-current=step]>span:first-child{border-color:var(--accent-fill);background:var(--accent-fill);color:var(--on-accent)}
.v2-lifecycle details{display:flex;flex-direction:column;gap:16px;min-inline-size:0}
.v2-lifecycle details>summary{cursor:pointer;min-block-size:44px;align-content:center;font-weight:600}
.v2-lifecycle fieldset{border:0;padding:0;margin:0;min-inline-size:0}
.v2-lifecycle fieldset>legend{margin-block-end:16px;font-weight:600}
.v2-lifecycle [hidden]{display:none!important}
${whmPolish('.v2-lifecycle')}.v2-lifecycle__tabs{display:flex;flex-wrap:wrap;gap:16px;border-block-end:1px solid var(--line)}
.v2-lifecycle__tabs>a{display:inline-flex;align-items:center;min-block-size:44px;padding-inline:8px;color:var(--muted);text-decoration:none;border-block-end:2px solid transparent}
.v2-lifecycle__tabs>a[aria-current=page]{color:var(--text);border-color:var(--accent-fill);font-weight:600}
.v2-lifecycle__summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}
.v2-lifecycle__summary>div{padding:24px;border:1px solid var(--line);border-radius:var(--radius-card);background:var(--surface)}
.v2-lifecycle__summary dt{color:var(--muted);font-size:13px}
.v2-lifecycle__summary dd{font-size:20px;font-weight:600}
.v2-lifecycle__summary dd{unicode-bidi:plaintext;inline-size:fit-content;max-inline-size:100%;margin-inline-end:auto}
.v2-lifecycle__summary>div{gap:12px;box-shadow:var(--shadow)}
.v2-lifecycle__summary dt{display:flex;align-items:center;justify-content:space-between;gap:8px;font-weight:600}
.v2-lifecycle__summary dd{line-height:1.3;letter-spacing:-.01em;overflow-wrap:anywhere}
.v2-lifecycle__column>.v2-lifecycle__status:not([role=alert],[data-state=failed],[data-state=error]){padding:12px 16px;border:1px solid var(--line);border-radius:var(--radius-notice);background:var(--sunken);color:var(--text-2);font-size:13px;line-height:1.6}
.v2-lifecycle .v2-card__body>fieldset+fieldset{padding-block-start:24px;border-block-start:1px solid var(--line)}
.v2-lifecycle fieldset .v2-lifecycle__choices{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,220px),1fr));gap:12px;align-items:stretch}
.v2-lifecycle fieldset .v2-lifecycle__choices>.v2-lifecycle__choice{padding:12px 16px;border:1px solid var(--line);border-radius:var(--radius-control);background:var(--surface)}
.v2-lifecycle fieldset .v2-lifecycle__choices>.v2-lifecycle__choice:has(input:checked){border-color:var(--accent-line);background:var(--accent-soft)}
.v2-lifecycle fieldset .v2-lifecycle__choices>.v2-lifecycle__choice:has(input:focus-visible){outline:2px solid var(--accent-fill);outline-offset:2px}
.v2-lifecycle__choice>span{gap:2px;min-inline-size:0}
.v2-lifecycle__choice strong{font-size:14px;font-weight:600}
.v2-lifecycle__choice .v2-muted,.v2-lifecycle__choice>span>span{font-size:13px;line-height:1.5;color:var(--muted)}
.v2-lifecycle__rules{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:12px 24px;list-style:none;padding:0;font-size:13px;line-height:1.6;color:var(--text-2)}
.v2-lifecycle__rules>li{display:flex;align-items:flex-start;gap:8px}
.v2-lifecycle__rules>li>.v2-icon{flex:none;margin-block-start:2px;color:var(--ok)}
.v2-lifecycle__steps{gap:8px 16px;padding:12px 16px;border:1px solid var(--line);border-radius:var(--radius-control);background:var(--sunken);font-size:13px}
.v2-lifecycle__steps>li:not(:last-child)::after{content:"";flex:1 1 16px;min-inline-size:16px;block-size:1px;background:var(--line-strong)}
.v2-lifecycle__steps>li{flex-basis:120px}
.v2-lifecycle__steps>li>span:first-child{background:var(--surface)}
.v2-lifecycle__steps a{display:inline-flex;align-items:center;min-block-size:44px;color:inherit;text-decoration:none}
.v2-lifecycle__steps a:hover{color:var(--text);text-decoration:underline}
.v2-lifecycle__scroll{border:1px solid var(--line);border-radius:var(--radius-control)}
.v2-lifecycle__table thead th{background:var(--sunken)}
.v2-lifecycle__table tbody tr:last-child>*{border-block-end:0}
.v2-lifecycle__table td[colspan]{padding:24px 16px;text-align:center;color:var(--muted)}
.v2-lifecycle__table td{font-variant-numeric:tabular-nums}
.v2-lifecycle__release>section{padding:16px;border:1px solid var(--line);border-radius:var(--radius-control);background:var(--sunken);gap:16px}
.v2-lifecycle__release>section:last-child{border-color:var(--accent-line);background:var(--accent-soft)}
.v2-lifecycle .v2-card__body>details{padding-inline:16px;border:1px solid var(--line);border-radius:var(--radius-control)}
.v2-lifecycle .v2-card__body>details[open]{padding-block-end:16px}
.v2-lifecycle .v2-card__body>details+details{margin-block-start:-12px}
.v2-lifecycle__grid--editor{grid-template-columns:minmax(0,2fr) minmax(0,3fr)}
${phoneRows('.v2-lifecycle__grid--editor .v2-lifecycle__table:has(>[data-destination-rows])')}
.v2-lifecycle__grid--editor .v2-lifecycle__scroll:has(>table>[data-destination-rows]:empty){display:none}
.v2-lifecycle__release{grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr))}
.v2-lifecycle__nowrap{white-space:nowrap}
.v2-lifecycle__table .v2-lifecycle__actions{gap:8px}
.v2-lifecycle__archive-bar{display:flex;flex-wrap:wrap;align-items:flex-end;gap:16px;min-inline-size:0}
.v2-lifecycle__archive-bar>.v2-lifecycle__field{flex:1 1 220px}
.v2-lifecycle [data-account-backups] .v2-lifecycle__table bdi.v2-num{white-space:nowrap}
.v2-lifecycle [data-account-backups] .v2-lifecycle__table a.v2-btn{block-size:auto;min-block-size:var(--target);white-space:normal;overflow-wrap:anywhere;text-align:start}
@media(min-width:1001px){.v2-lifecycle__table .v2-lifecycle__actions>.v2-btn{padding-inline:12px;font-size:13px}}
@media(max-width:600px){${phoneRows('.v2-lifecycle .v2-lifecycle__table')}
.v2-lifecycle__steps>li:not(:last-child)::after{display:none}.v2-lifecycle__actions>:is(.v2-btn,button){flex:1 1 auto}}
@media(max-width:1000px){.v2-lifecycle__grid{grid-template-columns:minmax(0,1fr)}.v2-lifecycle__summary{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:600px){.v2-lifecycle div.v2-lifecycle__fields{grid-template-columns:minmax(0,1fr)}.v2-lifecycle__summary>div{padding:16px}.v2-lifecycle__summary .v2-tile{display:none}.v2-lifecycle__summary dd{font-size:16px}}
`
