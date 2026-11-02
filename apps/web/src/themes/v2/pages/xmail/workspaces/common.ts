import { localeDirection, type Locale, type Translate } from '../../../../../i18n.ts'
import type { MailSurfaceProps } from '../../../../contract.ts'
import { normalizeAsciiDigits } from '../../../../../display-format.ts'
import { card, pageHeader } from '../../../components/index.ts'
import { escapeHtml, hookAttrs, type HookAttributes } from '../../../html.ts'
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
  readonly quotaAvailable?: boolean
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
  `<span class="v2-select"><select id="${esc(id)}"${name ? ` name="${esc(name)}"` : ''}${extra}${disabled ? ' disabled' : ''}>${options.map(([value, label]) => `<option value="${esc(value)}"${value === selectedValue ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select></span>`
export const actions = (body: string): string => `<div class="v2-mail-workspace__actions">${body}</div>`
export const fields = (body: string): string => `<div class="v2-mail-workspace__fields">${body}</div>`
export const facts = (rows: readonly { label: string; valueHtml: string }[], hooks?: HookAttributes): string =>
  `<dl class="v2-mail-workspace__facts"${hookAttrs(hooks)}>${rows.map(row => `<div><dt>${esc(row.label)}</dt><dd>${row.valueHtml}</dd></div>`).join('')}</dl>`
export const section = (id: string, title: string, bodyHtml: string, actionsHtml?: string, hooks?: HookAttributes): string =>
  card({ id, title, titleId: `${id}-heading`, bodyHtml: v2MailClientTemplatesForHooks(hooks) + bodyHtml, actionsHtml, hooks })
export const table = (id: string, title: string, columns: readonly string[], bodyHtml: string, hooks?: HookAttributes): string =>
  `<div class="v2-mail-workspace__table" role="region" tabindex="0" aria-label="${esc(title)}"><table id="${esc(id)}"><caption class="v2-sr">${esc(title)}</caption><thead><tr>${columns.map(label => `<th scope="col">${esc(label)}</th>`).join('')}</tr></thead><tbody${hookAttrs(hooks)}>${bodyHtml}</tbody></table></div>`
export const unreadRow = (text: string, columns: number): string => `<tr><td colspan="${columns}">${esc(text)}</td></tr>`
export function page(input: MailWorkspaceInput, title: string, description: string, bodyHtml: string, hooks?: HookAttributes): string {
  const { t, readable } = ctx(input)
  const blockNative = input.readOnly === true && !(input.route === '/mail/settings/security' && input.securityHtml)
  return `<div class="v2-mail-workspace" lang="${esc(input.locale ?? 'en')}" dir="${localeDirection(input.locale ?? 'en')}" data-mail-workspace-route="${esc(input.route)}"${blockNative ? ' data-readonly="true"' : ''}${hookAttrs(hooks)}>${v2MailClientTemplatesForHooks(hooks)}${pageHeader(t, { route: input.route, title, description, breadcrumb: [{ label: t(msgid('Inbox')), href: '/mail/inbox' }, { label: title }] })}${!readable ? `<p class="v2-mail-workspace__access" role="status">${esc(t(msgctxt('theme:v2', 'This mailbox workspace is unavailable for the current session. No mailbox data has been read.')))}</p>` : ''}${bodyHtml}</div>`
}

export const MAIL_WORKSPACES_CSS = `.v2-mail-workspace{display:flex;flex-direction:column;gap:var(--space-4);min-inline-size:0}
.v2-mail-workspace :is(h2,h3,p,dl,dd,ul,ol,pre){margin:0}
.v2-mail-workspace .v2-card,.v2-mail-workspace .v2-card__body{gap:var(--space-3)}
.v2-mail-workspace__groups,.v2-mail-workspace form,.v2-mail-workspace__panel{display:grid;gap:var(--space-3);min-inline-size:0}
.v2-mail-workspace__fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:var(--space-2);min-inline-size:0}
.v2-mail-workspace__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:var(--space-2);min-inline-size:0}
.v2-mail-workspace__facts>div{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0;text-align:start}
.v2-mail-workspace__facts :is(dt,dd){margin:0;overflow-wrap:anywhere;text-align:start}
.v2-mail-workspace__facts dt{font-size:12px;color:var(--muted)}
.v2-mail-workspace__actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.v2-mail-workspace__check{display:flex;align-items:flex-start;gap:var(--space-1);min-block-size:var(--target)}
.v2-mail-workspace__check>input{flex:none;margin-block:4px 0}
.v2-mail-workspace__table{max-inline-size:100%;overflow:auto;min-inline-size:0}
.v2-mail-workspace__table :is(th,td){text-align:start;vertical-align:top;padding:12px 16px}
.v2-mail-workspace__list{display:grid;gap:var(--space-2);padding:0;list-style:none;min-inline-size:0}
.v2-mail-workspace__list:empty{display:none}
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
@media(max-width:900px){.v2-mail-workspace__split{grid-template-columns:minmax(0,1fr)}}
@media(max-width:600px){.v2-mail-workspace__fields{grid-template-columns:minmax(0,1fr)}}
`
