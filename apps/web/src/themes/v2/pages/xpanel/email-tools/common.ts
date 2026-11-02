import type { PanelSurfaceProps } from '../../../../contract.ts'
import { localeDirection, type Locale, type Translate } from '../../../../../i18n.ts'
import { normalizeAsciiDigits } from '../../../../../display-format.ts'
import { card, notice, pageHeader } from '../../../components/index.ts'
import { escapeHtml, hookAttrs, type HookAttributes } from '../../../html.ts'
import { icon } from '../../../icons.ts'
import { v2Messages } from '../../../messages.ts'

/** Core resolves route admission and the current account before calling these renderers. */
export interface PanelEmailAuthority {
  readonly canRead: boolean
  readonly presentation?: 'live' | 'read-only'
  readonly canReadFacts?: boolean
  readonly authorizedTools?: ReadonlySet<string>
  readonly canManage: boolean
}

export const NO_EMAIL_AUTHORITY: PanelEmailAuthority = Object.freeze({ canRead: false, canManage: false })
export const esc = escapeHtml
export const technical = (value: string | number): string => `<bdi dir="ltr" class="v2-mono">${esc(normalizeAsciiDigits(value))}</bdi>`
export function emailContext(props: PanelSurfaceProps, authority: PanelEmailAuthority = NO_EMAIL_AUTHORITY) {
  const locale = props.locale ?? 'en'
  const t = v2Messages.translator(locale)
  const readOnly = authority.presentation === 'read-only'
  const principal = props.visibility?.principal
  const identityMatches = principal?.kind === 'user' && props.account?.id === principal.accountId
  const factsReadable = readOnly && authority.canReadFacts === true && identityMatches
  const account = authority.canRead || factsReadable ? props.account : undefined
  const canManage = !!account && account.status === 'active' && authority.canManage && !readOnly
  const domains = account && (!readOnly || authority.authorizedTools?.has('domains')) ? props.domains?.filter(row => row.accountId === account.id) : undefined
  const mailboxes = account && (!readOnly || authority.authorizedTools?.has('email-accounts')) ? props.serviceUsers?.filter(row => row.accountId === account.id && row.services.email) : undefined
  const plan = account && (!readOnly || authority.authorizedTools?.has('server-information')) && props.plan?.id === account.planId ? props.plan : undefined
  return { locale, t, account, canManage, domains, mailboxes, plan, factsReadable }
}

export const button = (label: string, hooks?: HookAttributes, disabled = true, primary = false): string =>
  `<button type="button" class="v2-btn${primary ? ' v2-btn--primary' : ''}"${hookAttrs(hooks)}${disabled ? ' disabled' : ''}>${esc(label)}</button>`
export const actions = (body: string): string => `<div class="v2-panel-extra__actions">${body}</div>`
export const fields = (body: string): string => `<div class="v2-panel-extra__fields">${body}</div>`
export function field(id: string, label: string, control: string, help?: string): string {
  const described = help && !control.includes('aria-describedby=')
    ? control.replace(/<(input|select|textarea)\b/, `<$1 aria-describedby="${esc(id)}-help"`) : control
  return `<div class="v2-field"><label for="${esc(id)}">${esc(label)}</label>${described}${help ? `<p id="${esc(id)}-help" class="v2-field__help">${esc(help)}</p>` : ''}</div>`
}
export const input = (id: string, hooks?: HookAttributes, extra = '', disabled = true): string =>
  `<input id="${esc(id)}"${hookAttrs(hooks)}${extra}${disabled ? ' disabled' : ''}>`
export const area = (id: string, hooks?: HookAttributes, extra = '', disabled = true): string =>
  `<textarea id="${esc(id)}"${hookAttrs(hooks)}${extra}${disabled ? ' disabled' : ''}></textarea>`
export const select = (id: string, options: readonly (readonly [string, string])[], hooks?: HookAttributes, disabled = true, extra = '', selectedValue?: string): string =>
  `<span class="v2-select"><select id="${esc(id)}"${hookAttrs(hooks)}${extra}${disabled ? ' disabled' : ''}>${options.map(([value, label]) => `<option value="${esc(value)}"${value === selectedValue ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>${icon('chevDown', 16)}</span>`
export const check = (id: string, label: string, hooks?: HookAttributes, disabled = true, checked = false, extra = ''): string =>
  `<label class="v2-panel-extra__check" for="${esc(id)}"><input id="${esc(id)}" type="checkbox"${hookAttrs(hooks)}${extra}${disabled ? ' disabled' : ''}${checked ? ' checked' : ''}><span>${esc(label)}</span></label>`
export const facts = (rows: readonly { label: string; valueHtml: string; hooks?: HookAttributes }[]): string =>
  `<dl class="v2-panel-extra__facts">${rows.map(row => `<div><dt>${esc(row.label)}</dt><dd${hookAttrs(row.hooks)}>${row.valueHtml}</dd></div>`).join('')}</dl>`
export const section = (id: string, title: string, bodyHtml: string, hooks?: HookAttributes, actionsHtml?: string): string =>
  card({ title, titleId: `${id}-heading`, bodyHtml, ...(hooks ? { hooks } : {}), ...(actionsHtml ? { actionsHtml } : {}) })
export const table = (id: string, label: string, columns: readonly string[], bodyHtml: string, hooks?: HookAttributes, headHooks?: HookAttributes): string =>
  `<div class="v2-panel-extra__table" role="region" tabindex="0" aria-label="${esc(label)}"><table id="${esc(id)}" class="v2-table"><caption class="v2-sr">${esc(label)}</caption><thead${hookAttrs(headHooks)}><tr>${columns.map(column => `<th scope="col">${esc(column)}</th>`).join('')}</tr></thead><tbody${hookAttrs(hooks)}>${bodyHtml}</tbody></table></div>`
export const unread = (t: Translate, columns: number): string => `<tr><td colspan="${columns}">${esc(t(msgid('Nothing has been read.')))}</td></tr>`
export const state = (message: string, hooks?: HookAttributes): string => `<p data-state="unread" role="status"${hookAttrs(hooks)}>${esc(message)}</p>`
export const header = (t: Translate, route: string, title: string, description: string): string =>
  pageHeader(t, { route, title, description, breadcrumb: [{ label: 'xPanel', href: '/home' }, { label: title }] })
export function missingAccount(t: Translate, route: string, title: string): string {
  return `<section class="v2-panel-extra">${header(t, route, title, t(msgid('Manage your hosting account and domains.')))}${notice(t, { tone: 'warn', lead: t(msgid('Unavailable')), text: t(msgctxt('theme:v2', 'An authorized account has not been read.')), urgent: true })}</section>`
}
export function page(locale: Locale, route: string, bodyHtml: string, hooks?: HookAttributes): string {
  return `<section class="v2-panel-extra" lang="${esc(locale)}" dir="${localeDirection(locale)}" data-v2-panel-page="${esc(route)}"${hookAttrs(hooks)}>${bodyHtml}</section>`
}

/** Shared by these account email and observation pages; no global layout or token changes. */
export const PANEL_ADDITIONAL_CSS = `.v2-panel-extra{display:flex;flex-direction:column;gap:var(--space-4);min-inline-size:0}
.v2-panel-extra :is(h2,h3,h4,p,dl,dd,ul,ol,pre){margin:0}
.v2-panel-extra .v2-card,.v2-panel-extra .v2-card__body{gap:var(--space-3)}
.v2-panel-extra__groups,.v2-panel-extra__editor,.v2-panel-extra fieldset{display:grid;gap:var(--space-3);min-inline-size:0}
.v2-panel-extra__handoff{display:flex;flex-direction:column;align-items:flex-start;gap:var(--space-1);min-inline-size:0}
.v2-panel-extra fieldset{padding:0;border:0}
.v2-panel-extra legend{padding:0;margin-block-end:var(--space-2);font-weight:600}
.v2-panel-extra__fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:var(--space-2);min-inline-size:0}
.v2-panel-extra__actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.v2-panel-extra__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:var(--space-2);min-inline-size:0}
.v2-panel-extra__facts>div{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0;text-align:start}
.v2-panel-extra__facts :is(dt,dd){text-align:start;overflow-wrap:anywhere}
.v2-panel-extra__facts dt{font-size:12px;color:var(--muted)}
.v2-panel-extra__check{display:flex;align-items:flex-start;gap:var(--space-1);min-block-size:var(--target)}
.v2-panel-extra__check>input{margin-block:4px 0;flex:none}
.v2-panel-extra__table{overflow:auto;min-inline-size:0;max-inline-size:100%}
.v2-panel-extra__table :is(th,td){padding:12px 16px;text-align:start;vertical-align:top}
.v2-panel-extra [data-site-health] [data-state-chip]{display:inline-flex;align-items:center;gap:var(--space-1);padding:4px 10px;border:1px solid var(--line);border-radius:var(--radius-pill);background:var(--sunken);color:var(--muted);font-size:12px;font-weight:600;white-space:nowrap}
.v2-panel-extra [data-site-health] [data-state-chip]::before{content:"";inline-size:6px;block-size:6px;border-radius:50%;background:currentColor;flex:none}
.v2-panel-extra [data-site-health] [data-state-chip=ok]{color:var(--ok);background:var(--ok-soft);border-color:var(--ok-line)}
.v2-panel-extra [data-site-health] [data-state-chip=problem]{color:var(--bad);background:var(--bad-soft);border-color:var(--bad-line)}
.v2-panel-extra [data-site-health] [data-state-chip=unavailable]{color:var(--warn);background:var(--warn-soft);border-color:var(--warn-line)}
.v2-panel-extra__list{list-style:none;padding:0;display:grid;gap:var(--space-3);min-inline-size:0}
.v2-panel-extra__list>li,.v2-panel-extra__preview{padding:var(--v2-panel-padding);border:1px solid var(--line);border-radius:var(--radius-control);display:grid;gap:var(--space-2);min-inline-size:0}
.v2-panel-extra__split{display:grid;grid-template-columns:minmax(0,1fr) minmax(240px,320px);gap:var(--space-3);align-items:start;min-inline-size:0}
.v2-panel-extra__scope{display:grid;gap:var(--space-1);padding-inline-start:20px}
.v2-panel-extra :is(p,dd){overflow-wrap:anywhere}
.v2-panel-extra :is(input,select,textarea){min-inline-size:0;max-inline-size:100%}
.v2-panel-extra :is(input,select,textarea)[dir=ltr]{text-align:var(--v2-control-align,start)}
.v2-panel-extra textarea{inline-size:100%;resize:vertical;min-block-size:96px}
.v2-panel-extra pre{white-space:pre-wrap;overflow-wrap:anywhere;max-inline-size:100%;min-inline-size:0;text-align:start}
.v2-panel-extra pre.v2-panel-extra__raw{direction:ltr;white-space:pre;overflow:auto;padding:var(--space-2);background:var(--code);color:var(--code-text);border-radius:var(--radius-control)}
.v2-panel-extra [role=status][data-state]:is([data-state=failed],[data-state=uncertain]){padding:var(--space-2);border:1px solid var(--warn-line);background:var(--warn-soft);border-radius:var(--radius-control)}
.v2-panel-extra [hidden]{display:none}
@media(max-width:900px){.v2-panel-extra__split{grid-template-columns:minmax(0,1fr)}}
@media(max-width:600px){.v2-panel-extra__fields{grid-template-columns:minmax(0,1fr)}.v2-panel-extra__actions>button{flex:1 1 auto}}
`
