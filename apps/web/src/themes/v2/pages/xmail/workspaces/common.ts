import { localeDirection, type Locale, type Translate } from '../../../../../i18n.ts'
import type { MailSurfaceProps } from '../../../../contract.ts'
import { normalizeAsciiDigits } from '../../../../../display-format.ts'
import { card, pageHeader } from '../../../components/index.ts'
import { escapeHtml, hookAttrs, type HookAttributes } from '../../../html.ts'
import { icon } from '../../../icons.ts'
import { v2Messages } from '../../../messages.ts'
import { v2MailClientTemplatesForHooks } from '../client-templates.ts'

/** Core supplies the current sealed mailbox and its independent route/capability decisions. */
export interface MailWorkspaceInput extends Pick<MailSurfaceProps, 'quotaUsedMb' | 'quotaUsedBytes' | 'quotaLimitMb'> {
  readonly locale?: Locale
  readonly mailbox: string
  readonly route: string
  readonly canRead?: boolean
  /** Permission to display supplied mailbox facts, independent of native service reads. */
  readonly canReadFacts?: boolean
  /** Trusted core presentation mode; never inferred from mailbox text or a request parameter. */
  readonly readOnly?: boolean
  readonly canManage?: boolean
  readonly activeFolder?: string
  readonly attachmentsAvailable?: boolean
  readonly searchAvailable?: boolean
  readonly searchIndexAvailable?: boolean
  readonly quotaAvailable?: boolean
  readonly boxTrapperAvailable?: boolean
  readonly authorizedRoutes?: ReadonlySet<string>
  /** Trusted output from UiTheme.slots.accountSecurity; never request or stored-message HTML. */
  readonly securityHtml?: string
}

export const esc = escapeHtml
export const technical = (value: string | number): string => `<bdi dir="ltr" class="v2-mono">${esc(normalizeAsciiDigits(value))}</bdi>`
export function ctx(input: MailWorkspaceInput): { t: Translate; readable: boolean; factsReadable: boolean; editable: boolean } {
  const identityKnown = input.mailbox.length > 0
  const readable = input.readOnly !== true && input.canRead === true && identityKnown
  const factsReadable = (input.canReadFacts ?? input.canRead === true) && identityKnown
  return { t: v2Messages.translator(input.locale ?? 'en'), readable, factsReadable, editable: readable && input.canManage === true }
}

export const button = (label: string, hooks?: HookAttributes, disabled = true, primary = false): string =>
  `<button type="button" class="v2-btn${primary ? ' v2-btn--primary' : ''}"${hookAttrs(hooks)}${disabled ? ' disabled' : ''}>${esc(label)}</button>`
export function field(id: string, label: string, controlHtml: string, help?: string): string {
  const described = help && !controlHtml.includes('aria-describedby=')
    ? controlHtml.replace(/<(input|select|textarea)\b/, `<$1 aria-describedby="${esc(id)}-help"`) : controlHtml
  return `<div class="v2-field"><label for="${esc(id)}">${esc(label)}</label>${described}${help ? `<p id="${esc(id)}-help" class="v2-field__help">${esc(help)}</p>` : ''}</div>`
}
export const check = (name: string, label: string, checked = false, disabled = true, hooks?: HookAttributes): string =>
  `<label class="v2-mail-workspace__check"><input type="checkbox"${name ? ` name="${esc(name)}"` : ''}${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}${hookAttrs(hooks)}><span>${esc(label)}</span></label>`
export const input = (id: string, name: string, type = 'text', extra = '', disabled = true): string =>
  `<input id="${esc(id)}"${name ? ` name="${esc(name)}"` : ''} type="${esc(type)}"${extra}${disabled ? ' disabled' : ''}>`
export const area = (id: string, name: string, extra = '', disabled = true): string =>
  `<textarea id="${esc(id)}"${name ? ` name="${esc(name)}"` : ''}${extra}${disabled ? ' disabled' : ''}></textarea>`
export const select = (id: string, name: string, options: readonly (readonly [string, string])[], extra = '', disabled = true, selectedValue?: string): string =>
  `<span class="v2-select"><select id="${esc(id)}"${name ? ` name="${esc(name)}"` : ''}${extra}${disabled ? ' disabled' : ''}>${options.map(([value, label]) => `<option value="${esc(value)}"${value === selectedValue ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>${icon('chevDown', 16)}</span>`
export const actions = (body: string): string => `<div class="v2-mail-workspace__actions">${body}</div>`
export const fields = (body: string): string => `<div class="v2-mail-workspace__fields">${body}</div>`
export const facts = (rows: readonly { label: string; valueHtml: string }[], hooks?: HookAttributes): string =>
  `<dl class="v2-mail-workspace__facts"${hookAttrs(hooks)}>${rows.map(row => `<div><dt>${esc(row.label)}</dt><dd>${row.valueHtml}</dd></div>`).join('')}</dl>`
export const section = (id: string, title: string, bodyHtml: string, actionsHtml?: string, hooks?: HookAttributes): string =>
  card({ id, title, titleId: `${id}-heading`, bodyHtml: v2MailClientTemplatesForHooks(hooks) + bodyHtml, actionsHtml, hooks })
// phone rows print each value's column name from these custom properties; the header cells stay in the document
const columnNames = (columns: readonly string[]): string => columns.map((label, index) => `--h${index + 1}:'${label.replace(/[\\']/g, '\\$&')}'`).join(';')
export const table = (id: string, title: string, columns: readonly string[], bodyHtml: string, hooks?: HookAttributes): string =>
  `<div class="v2-mail-workspace__table" role="region" tabindex="0" aria-label="${esc(title)}" style="${esc(columnNames(columns))}"><table id="${esc(id)}"><caption class="v2-sr">${esc(title)}</caption><thead><tr>${columns.map(label => `<th scope="col">${esc(label)}</th>`).join('')}</tr></thead><tbody${hookAttrs(hooks)}>${bodyHtml}</tbody></table></div>`
export const unreadRow = (text: string, columns: number): string => `<tr><td colspan="${columns}">${esc(text)}</td></tr>`
export function page(input: MailWorkspaceInput, title: string, description: string, bodyHtml: string, hooks?: HookAttributes): string {
  const { t, readable } = ctx(input)
  const blockNative = input.readOnly === true && !(input.route === '/mail/settings/security' && input.securityHtml)
  return `<div class="v2-mail-workspace" lang="${esc(input.locale ?? 'en')}" dir="${localeDirection(input.locale ?? 'en')}" data-mail-workspace-route="${esc(input.route)}"${blockNative ? ' data-readonly="true"' : ''}${hookAttrs(hooks)}>${v2MailClientTemplatesForHooks(hooks)}${pageHeader(t, { route: input.route, title, description, breadcrumb: [{ label: t(msgid('Inbox')), href: '/mail/inbox' }, { label: title }] })}${!readable ? `<p class="v2-mail-workspace__access" role="status">${esc(t(msgctxt('theme:v2', 'This mailbox workspace is unavailable for the current session. No mailbox data has been read.')))}</p>` : ''}${bodyHtml}</div>`
}

export const MAIL_WORKSPACES_CSS = `.v2-mail-workspace{display:flex;flex-direction:column;gap:var(--space-4);min-inline-size:0;max-inline-size:1200px}
.v2-mail-workspace :is(h2,h3,p,dl,dd,ul,ol,pre){margin:0}
.v2-mail-workspace .v2-card,.v2-mail-workspace .v2-card__body{gap:var(--space-3)}
.v2-mail-workspace__groups,.v2-mail-workspace form,.v2-mail-workspace__panel{display:grid;gap:var(--space-3);min-inline-size:0}
.v2-mail-workspace>[data-mail-contacts]{gap:var(--space-4)}
.v2-mail-workspace__fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:var(--space-2);min-inline-size:0}
.v2-mail-workspace__fields>.v2-field:only-child{max-inline-size:560px}
.v2-mail-workspace__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,160px),1fr));gap:var(--space-2);min-inline-size:0}
.v2-mail-workspace__facts>div{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0;text-align:start}
.v2-mail-workspace__facts :is(dt,dd){margin:0;overflow-wrap:anywhere;text-align:start}
.v2-mail-workspace__facts dt{font-size:12px;color:var(--muted)}
.v2-mail-workspace__actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.v2-mail-workspace__actions:not(:has(>:not([hidden]))){display:none}
.v2-mail-workspace .v2-card p:empty{display:none}
.v2-mail-workspace input[type=file]{block-size:auto;padding:var(--space-1);font-size:13px;color:var(--text-2)}
.v2-mail-workspace input[type=file]::file-selector-button{min-block-size:var(--target);margin-inline-end:12px;padding:0 14px;border:1px solid var(--line-strong);border-radius:var(--radius-chip);background:var(--surface);color:var(--text);font:600 13px/1.2 inherit;cursor:pointer}
.v2-mail-workspace :is(form[role=search],[data-mail-track-form]){display:flex;flex-wrap:wrap;align-items:flex-end;gap:var(--space-2)}
.v2-mail-workspace :is(form[role=search],[data-mail-track-form])>.v2-mail-workspace__fields{flex:1 1 420px}
.v2-mail-workspace .v2-actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-1)}
.v2-mail-workspace .v2-mail-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:var(--space-2);max-inline-size:720px;min-inline-size:0}
.v2-mail-workspace #v2-mail-lists-admin .v2-card__body>div{display:grid;gap:var(--space-2);min-inline-size:0}
.v2-mail-workspace .v2-security__form{max-inline-size:560px}
.v2-mail-workspace .v2-table-wrap{border:1px solid var(--line);border-radius:var(--radius-control);overflow-x:auto}
.v2-mail-workspace__check{display:flex;align-items:center;gap:var(--space-1);min-block-size:var(--target)}
@media(max-width:600px){.v2-mail-workspace__check{min-block-size:var(--target)}}
.v2-mail-workspace__check>input{flex:none;margin-block:0}
.v2-mail-workspace__table{max-inline-size:100%;overflow:auto;min-inline-size:0}
.v2-mail-workspace__table :is(th,td){text-align:start;vertical-align:middle;padding:12px 16px}
.v2-mail-workspace__table>table{inline-size:100%}
.v2-mail-workspace :is(.v2-mail-workspace__actions,td)>.v2-btn{max-inline-size:100%;block-size:auto;padding-block:8px;white-space:normal;text-align:start}
.v2-mail-workspace[data-mail-mailing-lists] .v2-mail-workspace__table td:nth-child(-n+2){overflow-wrap:anywhere}
.v2-mail-workspace [data-filter-list] .v2-card__body{gap:var(--space-1)}
.v2-mail-workspace [data-filter-list] .v2-card__body>.v2-mail-workspace__actions{margin-block-start:var(--space-1)}
@media(min-width:601px){.v2-mail-workspace__table .v2-mail-folders__row-actions{flex-wrap:nowrap;gap:var(--space-1)}.v2-mail-workspace [data-contact-table] bdi{white-space:nowrap}}
.v2-mail-workspace__list{display:grid;gap:var(--space-2);padding:0;list-style:none;min-inline-size:0}
.v2-mail-workspace__list:empty{display:none}
.v2-mail-workspace__list>li:has(>.v2-btn){display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--space-1) var(--space-2);min-inline-size:0}
.v2-mail-workspace__list>li>span{min-inline-size:0;overflow-wrap:anywhere}
.v2-mail-workspace__preview{padding:var(--v2-panel-padding);border:1px solid var(--line);border-radius:var(--radius-control);display:grid;gap:var(--space-3);min-inline-size:0}
.v2-mail-workspace__split{display:grid;grid-template-columns:minmax(0,1fr) minmax(240px,320px);gap:var(--space-3);align-items:start;min-inline-size:0}
.v2-mail-workspace :is(input,select,textarea){min-inline-size:0;max-inline-size:100%}
.v2-mail-workspace :is(input,select,textarea)[dir=ltr]{text-align:var(--v2-control-align,start)}
.v2-mail-workspace textarea{inline-size:100%;min-block-size:100px}
.v2-mail-workspace pre{white-space:pre-wrap;overflow-wrap:anywhere;max-inline-size:100%;min-inline-size:0}
.v2-mail-workspace__message{display:grid;gap:var(--space-3);min-inline-size:0}
.v2-mail-workspace__message [data-mail-search-body]{white-space:pre-wrap;overflow-wrap:anywhere}
.v2-mail-workspace__access{padding:var(--space-2);border:1px solid var(--warn-line);border-radius:var(--radius-control);background:var(--warn-soft);color:var(--text)}
.v2-mail-workspace [hidden]{display:none}
.v2-mail-workspace .v2-card h2{font-size:16px;font-weight:600}
.v2-mail-workspace .v2-card h3{font-size:14px;font-weight:600}
.v2-mail-workspace .v2-card :is(p,ol,[data-forwarders-count]){font-size:13px;line-height:1.6;color:var(--muted);overflow-wrap:anywhere}
.v2-mail-workspace .v2-card p{max-inline-size:88ch}
.v2-mail-workspace .v2-card :is([role=status],[role=alert]):not(:empty,[data-state=failed],[data-state=error]){position:relative;padding-inline-start:var(--space-2);color:var(--text-2)}
.v2-mail-workspace .v2-card :is([role=status],[role=alert]):not(:empty,[data-state=failed],[data-state=error])::before{content:"";position:absolute;inset-inline-start:0;inset-block-start:.5em;inline-size:8px;block-size:8px;border-radius:50%;background:var(--line-strong)}
.v2-mail-workspace .v2-card :is([role=status],[role=alert]):is([data-state=read],[data-state=saved],[data-state=ready],[data-state=sent])::before{background:var(--ok)}
.v2-mail-workspace .v2-card :is([role=status],[role=alert]):is([data-state=reading],[data-state=saving],[data-state=busy])::before{background:var(--accent)}
.v2-mail-workspace .v2-card :is([role=status],[role=alert]):is([data-state=uncertain],[data-state=stale],[data-state=conflict])::before{background:var(--warn)}
.v2-mail-workspace .v2-card :is([role=status],[role=alert]):empty{display:none}
.v2-mail-workspace .v2-card [role=note]{max-inline-size:none;padding:12px var(--space-2);border:1px solid var(--accent-line);border-radius:var(--radius-notice);background:var(--accent-soft);color:var(--text)}
.v2-mail-workspace .v2-card__body>:is(form,article,section,[role=group],.v2-mail-workspace__groups):not(:first-child,[hidden],.v2-mail-workspace__preview,.v2-mail-workspace__actions){padding-block-start:var(--space-3);border-block-start:1px solid var(--line)}
.v2-mail-workspace :is(.v2-card__body,form,[role=group],[data-filter-group])>.v2-field{max-inline-size:560px}
.v2-mail-workspace :is(.v2-card__body,form,[role=group],[data-filter-group])>.v2-field:has(textarea){max-inline-size:720px}
.v2-mail-workspace__table td[colspan]{padding:var(--space-3);text-align:center;font-size:13px;color:var(--muted)}
.v2-mail-workspace__table tbody tr:has(>td[colspan]):hover>td{background:transparent}
.v2-mail-workspace__table tbody tr:first-child>td{border-block-start:0}
.v2-mail-workspace .v2-card ol:not(.v2-mail-workspace__list){display:grid;gap:var(--space-1);padding-inline-start:20px;color:var(--text-2)}
.v2-mail-workspace .v2-card__body>:is(.v2-btn,button){align-self:flex-start}
.v2-mail-workspace .v2-card__body>:is(div[role=group],[data-preferences-form],[data-identities-form],[data-filter-test-section],[data-account-password]):not(.v2-mail-workspace__actions,.v2-mail-workspace__groups),.v2-mail-workspace :is([data-filter-group],[data-filter-test]):not(.v2-mail-workspace__actions){display:grid;gap:var(--space-2);min-inline-size:0}
.v2-mail-workspace__fields>label:not(.v2-mail-workspace__check){display:flex;align-items:flex-start;gap:var(--space-1);min-block-size:var(--target);font-size:14px}
.v2-mail-workspace__fields>label:not(.v2-mail-workspace__check)>input{flex:none;margin-block:2px 0}
.v2-mail-workspace__fields>:is(p,[role=note]){grid-column:1/-1}
.v2-mail-workspace__fields .v2-field>:is(input,select,textarea,.v2-select){inline-size:100%}
.v2-mail-workspace__facts dd{font-size:14px;font-variant-numeric:tabular-nums}
.v2-mail-workspace__table{border:1px solid var(--line);border-radius:var(--radius-control)}
.v2-mail-workspace meter{appearance:none;-webkit-appearance:none;display:block;inline-size:100%;max-inline-size:480px;block-size:6px;border:0;border-radius:3px;background:var(--sunken);overflow:hidden}
.v2-mail-workspace meter::-webkit-meter-inner-element{display:block;block-size:6px}
.v2-mail-workspace meter::-webkit-meter-bar{block-size:6px;border:0;border-radius:3px;background:var(--sunken)}
.v2-mail-workspace meter::-webkit-meter-optimum-value{border-radius:3px;background:var(--accent-fill)}
.v2-mail-workspace meter::-webkit-meter-suboptimum-value{border-radius:3px;background:var(--warn)}
.v2-mail-workspace meter::-webkit-meter-even-less-good-value{border-radius:3px;background:var(--bad)}
.v2-mail-workspace meter::-moz-meter-bar{border-radius:3px;background:var(--accent-fill)}
.v2-mail-workspace__home{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,150px),1fr));gap:var(--space-3);padding-block-start:var(--space-3);border-block-start:1px solid var(--line);min-inline-size:0}
.v2-mail-workspace__home>div{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0}
.v2-mail-workspace__home h3{font-size:12px;color:var(--muted)}
.v2-mail-workspace__home ul{display:flex;flex-direction:column;gap:2px;list-style:none;padding:0}
.v2-mail-workspace__home a{display:flex;align-items:center;min-block-size:var(--target);margin-inline:-12px;padding-inline:12px;border-radius:var(--radius-control);font-size:14px;font-weight:500;color:var(--text);text-decoration:none}
.v2-mail-workspace__home a:hover{background:var(--subtle);color:var(--accent)}
.v2-mail-workspace #v2-mail-tools .v2-mail-workspace__list{grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:var(--space-2)}
.v2-mail-workspace #v2-mail-tools .v2-mail-workspace__list>li{display:flex;flex-direction:column;align-items:flex-start;gap:var(--space-1);min-inline-size:0}
.v2-mail-workspace #v2-mail-tools .v2-mail-workspace__list .v2-btn{max-inline-size:100%;white-space:normal;text-align:start}
.v2-mail-workspace #vacation.v2-card{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:var(--space-2)}
.v2-mail-workspace #vacation.v2-card>:not(h2,[data-vacation-requested]){grid-column:1/-1}
.v2-mail-workspace #vacation.v2-card>.v2-btn{justify-self:start}
.v2-mail-workspace [data-vacation-requested]{display:inline-flex;align-items:center;padding:3px 10px;border-radius:var(--radius-pill);background:var(--sunken);color:var(--text-2);font-size:12px;font-weight:600}
.v2-mail-workspace pre{padding:var(--space-2);border-radius:var(--radius-control);background:var(--code);color:var(--code-text);font:12px/1.7 var(--font-mono);direction:ltr;text-align:start}
.v2-mail-workspace pre:empty{display:none}
@media(min-width:601px){.v2-mail-workspace__facts>div:has(.v2-mono):not(:only-child){grid-column:span 2}}
@media(max-width:900px){.v2-mail-workspace__split{grid-template-columns:minmax(0,1fr)}}
@media(max-width:600px){.v2-mail-workspace table.v2-table:not(:has(td))>thead>tr{display:flex;flex-wrap:wrap;gap:4px var(--space-2);padding:8px var(--space-2)}
.v2-mail-workspace table.v2-table:not(:has(td))>thead>tr>th{padding:0;inline-size:auto}
.v2-mail-workspace__table{overflow:visible}
.v2-mail-workspace__table thead{position:absolute;inline-size:1px;block-size:1px;margin:-1px;overflow:hidden;clip-path:inset(50%)}
.v2-mail-workspace__table :is(table,tbody){display:block}
.v2-mail-workspace__table tr{display:grid;grid-template-columns:minmax(0,1fr) fit-content(50%);column-gap:var(--space-2);padding:12px var(--space-2);border-block-start:1px solid var(--line)}
.v2-mail-workspace__table tbody tr:first-child{border-block-start:0}
.v2-mail-workspace__table td,.v2-mail-workspace__table :is(th,td):is(:first-child,:last-child){display:block;grid-column:1;min-inline-size:0;padding:0;border:0;font-size:13px;color:var(--text-2);overflow-wrap:anywhere}
.v2-mail-workspace__table td:not(:first-child){padding-block-start:2px}
.v2-mail-workspace__table td:first-child{font-size:14px;font-weight:600;color:var(--text)}
.v2-mail-workspace__table td:last-child:not(:first-child):has(button,a,input){grid-column:2;grid-row:1/span 8;align-self:center;padding:0;text-align:end}
.v2-mail-workspace__table td:not(:first-child,[colspan]):not(:last-child:has(button,a,input))::before{color:var(--muted)}
.v2-mail-workspace__table td:nth-child(2)::before{content:var(--h2) ": "}.v2-mail-workspace__table td:nth-child(3)::before{content:var(--h3) ": "}.v2-mail-workspace__table td:nth-child(4)::before{content:var(--h4) ": "}.v2-mail-workspace__table td:nth-child(5)::before{content:var(--h5) ": "}.v2-mail-workspace__table td:nth-child(6)::before{content:var(--h6) ": "}.v2-mail-workspace__table td:nth-child(7)::before{content:var(--h7) ": "}
.v2-mail-workspace__table td:last-child:not(:first-child):has(button,a,input)::before{content:none}
.v2-mail-workspace__table td:last-child .v2-btn{padding-inline:12px;font-size:13px}
.v2-mail-workspace:is([data-mail-mailing-lists],[data-mail-connect-devices]) .v2-mail-workspace__table td:nth-child(2),.v2-mail-workspace__table [data-contact-table] td:nth-child(2){grid-column:1;grid-row:auto;justify-self:stretch;text-align:start}
.v2-mail-workspace__table td[colspan]{grid-column:1/-1;padding:var(--space-2) 0;font-weight:400;color:var(--muted);text-align:center}
.v2-mail-workspace__fields{grid-template-columns:minmax(0,1fr)}.v2-mail-workspace__facts{display:flex;flex-wrap:wrap}.v2-mail-workspace__facts>div{flex:1 1 calc(50% - var(--space-2));min-inline-size:min-content;max-inline-size:100%}.v2-mail-workspace__facts>div:has(.v2-mono){flex-basis:100%}.v2-mail-workspace__facts :is(dt,dd){overflow-wrap:break-word}
.v2-mail-workspace__table [data-mail-folders-rows] td:last-child:has(button){grid-column:1/-1;grid-row:auto;display:flex;flex-wrap:wrap;gap:var(--space-1);padding-block-start:var(--space-1)}}
`
