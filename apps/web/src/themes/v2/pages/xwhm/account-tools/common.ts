import { localeDirection, type Locale, type Translate } from '../../../../../i18n.ts'
import type { WhmSurfaceProps } from '../../../../contract.ts'
import { card, pageHeader } from '../../../components/index.ts'
import { escapeHtml, hookAttrs, type HookAttributes } from '../../../html.ts'
import { v2Messages } from '../../../messages.ts'

/** Core supplies independent read and mutation decisions for this exact route. */
export interface WhmAccountToolAuthority {
  readonly canRead: boolean
  readonly canManage: boolean
  /** Used only to describe the account-health scope; it never grants an operation. */
  readonly root?: boolean
}
export const NO_ACCOUNT_TOOL_AUTHORITY: WhmAccountToolAuthority = Object.freeze({ canRead: false, canManage: false })
export function context(props: WhmSurfaceProps, authority: WhmAccountToolAuthority) {
  const locale: Locale = props.locale ?? 'en'
  const readable = authority.canRead === true && props.capabilityUnavailable !== true
  return { locale, t: v2Messages.translator(locale), readable, editable: readable && authority.canManage === true }
}
export const esc = escapeHtml
export const text = (t: Translate, value: string): string => escapeHtml(t(value))
export const technical = (value: string): string => `<bdi dir="ltr">${escapeHtml(value)}</bdi>`
export const button = (label: string, hooks?: HookAttributes, enabled = false, primary = false): string => `<button type="button" class="v2-btn${primary ? ' v2-btn--primary' : ''}"${hookAttrs(hooks)}${enabled ? '' : ' disabled'}>${escapeHtml(label)}</button>`
export const field = (id: string, label: string, control: string, help?: string, hooks?: HookAttributes, hidden = false): string => `<div class="v2-account-tool__field"${hookAttrs(hooks)}${hidden ? ' hidden' : ''}><label for="${escapeHtml(id)}">${escapeHtml(label)}</label>${control}${help ? `<p class="v2-muted" id="${escapeHtml(id)}-help">${escapeHtml(help)}</p>` : ''}</div>`
export const fields = (html: string): string => `<div class="v2-account-tool__fields">${html}</div>`
export const actions = (html: string): string => `<div class="v2-account-tool__actions">${html}</div>`
export const toolCard = (key: string, title: string, bodyHtml: string, hooks?: HookAttributes): string => card({ title, titleId: `v2-account-tool-${key}`, bodyHtml, ...(hooks ? { hooks } : {}) })
export function table(title: string, headers: readonly string[], hooks: HookAttributes, unread: string): string {
  return `<div class="v2-account-tool__scroll" role="region" tabindex="0" aria-label="${escapeHtml(title)}"><table><caption class="v2-sr">${escapeHtml(title)}</caption><thead><tr>${headers.map(label => `<th scope="col">${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody${hookAttrs(hooks)} data-xp-columns="${headers.length}"><tr><td colspan="${headers.length}">${escapeHtml(unread)}</td></tr></tbody></table></div>`
}
export const facts = (rows: readonly { label: string; hooks: HookAttributes; value?: string }[], unread: string): string => `<dl class="v2-account-tool__facts">${rows.map(row => `<div><dt>${escapeHtml(row.label)}</dt><dd><bdi dir="ltr"${hookAttrs(row.hooks)}>${escapeHtml(row.value ?? unread)}</bdi></dd></div>`).join('')}</dl>`
export const status = (label: string, hooks: HookAttributes, state = 'unread', hidden = false): string => `<p role="status"${hookAttrs(hooks)} data-state="${escapeHtml(state)}"${hidden ? ' hidden' : ''}>${escapeHtml(label)}</p>`
export function page(props: WhmSurfaceProps, route: string, title: string, description: string, bodyHtml: string, hooks?: HookAttributes): string {
  const locale = props.locale ?? 'en'
  const t = v2Messages.translator(locale)
  return `<section class="v2-account-tools" data-whm-detail-route="${escapeHtml(route)}" lang="${locale}" dir="${localeDirection(locale)}"${hookAttrs(hooks)}>${pageHeader(t, { title, route, description, breadcrumb: [{ label: 'xWHM', href: '/whm' }, { label: title }] })}${bodyHtml}</section>`
}

export const WHM_ACCOUNT_TOOLS_CSS = `.v2-account-tools{display:flex;flex-direction:column;gap:var(--space-4);min-inline-size:0;text-align:start}
.v2-account-tools :is(h2,h3,p,dl,dd,fieldset,ol,ul){margin:0}
.v2-account-tools .v2-card__body,.v2-account-tool__groups{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0}
.v2-account-tool__fields,.v2-account-tool__facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2);min-inline-size:0}
.v2-account-tool__field,.v2-account-tool__facts>div{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0;text-align:start}
.v2-account-tool__field>label{padding-inline:13px}
.v2-account-tool__field :is(input,textarea,select){inline-size:100%;min-inline-size:0}
.v2-account-tool__field :is(input,textarea,select)[dir=ltr]{text-align:var(--v2-control-align,start)}
.v2-account-tool__field :is(input,textarea)[dir=auto]{text-align:start}
.v2-account-tool__field textarea{min-block-size:128px}
.v2-account-tool__facts dt{color:var(--muted);font-size:13px}
.v2-account-tool__facts dd{overflow-wrap:anywhere}
.v2-account-tool__actions,.v2-account-tool__choice-list{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.v2-account-tool__choice{display:flex;align-items:start;gap:var(--space-1);min-block-size:var(--target)}
.v2-account-tool__choice>input{flex:none;margin-block-start:4px}
.v2-account-tool__scroll{max-inline-size:100%;overflow:auto;min-inline-size:0}
.v2-account-tool__scroll :is(th,td){text-align:start;vertical-align:top;padding:12px 16px;overflow-wrap:anywhere}
.v2-account-tools fieldset{display:flex;flex-direction:column;gap:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-control);padding:var(--space-2);min-inline-size:0}
.v2-account-tools legend{padding-inline:var(--space-1);font-weight:600}
.v2-account-tool__previews{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2);min-inline-size:0}
.v2-account-tool__preview{padding:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-control);min-inline-size:0}
.v2-account-tools [hidden]{display:none}
@media(max-width:800px){.v2-account-tool__previews{grid-template-columns:minmax(0,1fr)}}
@media(max-width:600px){.v2-account-tool__fields,.v2-account-tool__facts{grid-template-columns:minmax(0,1fr)}}`
