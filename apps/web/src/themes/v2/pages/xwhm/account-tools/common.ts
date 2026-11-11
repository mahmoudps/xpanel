import { localeDirection, type Locale, type Translate } from '../../../../../i18n.ts'
import type { WhmSurfaceProps } from '../../../../contract.ts'
import { card, pageHeader } from '../../../components/index.ts'
import { escapeHtml, hookAttrs, type HookAttributes } from '../../../html.ts'
import { v2Messages } from '../../../messages.ts'
import { whmPolish } from '../monitoring/common.ts'
import { V2_ACCOUNT_ANNOUNCEMENT_CSS } from '../../../components/account-announcement-notice-templates.ts'

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
  return `<div class="v2-account-tool__scroll" role="region" tabindex="0" aria-label="${escapeHtml(title)}"><table data-phone-labels><caption class="v2-sr">${escapeHtml(title)}</caption><thead><tr>${headers.map(label => `<th scope="col">${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody${hookAttrs(hooks)} data-xp-columns="${headers.length}"><tr><td colspan="${headers.length}">${escapeHtml(unread)}</td></tr></tbody></table></div>`
}
export const facts = (rows: readonly { label: string; hooks: HookAttributes; value?: string }[], unread: string): string => `<dl class="v2-account-tool__facts">${rows.map(row => `<div><dt>${escapeHtml(row.label)}</dt><dd><bdi dir="ltr"${hookAttrs(row.hooks)}>${escapeHtml(row.value ?? unread)}</bdi></dd></div>`).join('')}</dl>`
export const status = (label: string, hooks: HookAttributes, state = 'unread', hidden = false): string => `<p role="status"${hookAttrs(hooks)} data-state="${escapeHtml(state)}"${hidden ? ' hidden' : ''}>${escapeHtml(label)}</p>`
export function page(props: WhmSurfaceProps, route: string, title: string, description: string, bodyHtml: string, hooks?: HookAttributes): string {
  const locale = props.locale ?? 'en'
  const t = v2Messages.translator(locale)
  return `<section class="v2-account-tools" data-whm-detail-route="${escapeHtml(route)}" lang="${locale}" dir="${localeDirection(locale)}"${hookAttrs(hooks)}>${pageHeader(t, { title, route, description, breadcrumb: [{ label: t(msgid('Home')), href: '/whm' }, { label: title }] })}${bodyHtml}</section>`
}

export const WHM_ACCOUNT_TOOLS_CSS = V2_ACCOUNT_ANNOUNCEMENT_CSS + `.v2-account-tools{display:flex;flex-direction:column;gap:var(--space-4);min-inline-size:0;text-align:start}
.v2-account-tools :is(h2,h3,p,dl,dd,fieldset,ol,ul){margin:0}
.v2-account-tools .v2-card__body{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0}
.v2-account-tool__groups{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-3);min-inline-size:0}
.v2-account-tool__groups>:not(fieldset),.v2-account-tool__groups>fieldset:not(fieldset+fieldset):not(:has(+fieldset)){grid-column:1/-1}
.v2-account-tool__groups>h3{font-size:14px;font-weight:600;color:var(--text-2)}
.v2-account-tool__groups>:is([data-whm-announcements-editor-heading],[data-acct-templates-editor-heading]){font-size:12px;font-weight:600;color:var(--muted)}
.v2-account-tool__fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2);min-inline-size:0}
.v2-account-tool__fields:has(>:nth-child(3):last-child){grid-template-columns:repeat(3,minmax(0,1fr))}
.v2-account-tool__fields[data-web-template-form]{grid-template-columns:minmax(0,1fr)}
.v2-account-tools form:not([class]){display:flex;flex-direction:column;gap:var(--space-2);min-inline-size:0}
.v2-account-tool__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(150px,100%),1fr));gap:var(--space-2);min-inline-size:0}
.v2-account-tool__field,.v2-account-tool__facts>div{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0;text-align:start}
.v2-account-tool__field>label{padding-inline:13px;font-size:13px;line-height:1.25;font-weight:600}
.v2-account-tool__field>p{font-size:13px;line-height:1.45}
.v2-account-tools .v2-card__body p[role=status]{font-size:13px}
.v2-account-tools .v2-card__body p[role=status][data-state=unread]{color:var(--muted)}
.v2-account-tool__field :is(input,textarea,select){inline-size:100%;min-inline-size:0}
.v2-account-tool__field :is(input,textarea,select)[dir=ltr]{text-align:var(--v2-control-align,start)}
.v2-account-tool__field :is(input,textarea)[dir=auto]{text-align:start}
.v2-account-tool__field textarea{min-block-size:128px}
.v2-account-tool__facts dt{color:var(--muted);font-size:12px}
.v2-account-tool__facts dd{font-size:14px;font-weight:500;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.v2-account-tool__actions,.v2-account-tool__choice-list{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.v2-account-tools .v2-btn{min-inline-size:var(--target);min-block-size:var(--target)}
.v2-account-tools :is([data-whm-health-selection],[data-quotas-page],[data-quotas-usage]){font-size:13px;color:var(--muted);font-variant-numeric:tabular-nums}
.v2-account-tool__choice{display:inline-flex;align-items:center;gap:10px;min-block-size:var(--target);cursor:pointer}
.v2-account-tool__choice>input{flex:none;margin:0}
.v2-account-tool__scroll{max-inline-size:100%;overflow:auto;min-inline-size:0;border:1px solid var(--line);border-radius:var(--radius-notice);background:var(--surface)}
.v2-account-tool__scroll:has(>table>tbody:empty){display:none}
.v2-account-tool__scroll table{inline-size:100%;border-collapse:collapse}
.v2-account-tool__scroll th{font-size:12px;font-weight:600;color:var(--muted);background:var(--subtle);border-block-end:1px solid var(--line)}
.v2-account-tool__scroll td{border-block-end:1px solid var(--line);font-variant-numeric:tabular-nums}
.v2-account-tool__scroll tbody tr:last-child>:is(th,td){border-block-end:0}
.v2-account-tool__scroll td[colspan]{color:var(--muted)}
.v2-account-tool__scroll :is(th,td){text-align:start;vertical-align:middle;padding:12px 16px;overflow-wrap:anywhere}
.v2-account-tools :is([data-whm-announcements-empty],[data-acct-templates-empty]):not([hidden]){display:flex;flex-direction:column;gap:var(--space-1);padding:var(--space-3);border:1px dashed var(--line);border-radius:var(--radius-notice);background:var(--subtle)}
.v2-account-tools :is([data-whm-announcements-empty],[data-acct-templates-empty])>h3{font-size:14px;font-weight:600;color:var(--text)}
.v2-account-tools :is([data-whm-announcements-empty],[data-acct-templates-empty])>p{font-size:13px;color:var(--muted)}
@media(min-width:1280px){.v2-account-tool__scroll :is(th,td){overflow-wrap:break-word}}
.v2-account-tools fieldset{display:flex;flex-direction:column;gap:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-notice);padding:var(--space-2);background:var(--surface);min-inline-size:0}
.v2-account-tools legend{padding-inline:var(--space-1);font-size:13px;font-weight:600}
.v2-account-tool__previews{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2);min-inline-size:0}
.v2-account-tools [data-web-template-preview]{inline-size:100%;block-size:320px;border:1px solid var(--line);border-radius:var(--radius-notice);background:var(--subtle)}
.v2-account-tool__preview{padding:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-notice);background:var(--subtle);min-inline-size:0}
.v2-account-tools [hidden]{display:none}
.v2-whm-quotas__table{min-inline-size:720px}
.v2-whm-quotas__table thead th{vertical-align:middle;padding-block:4px}
.v2-whm-quotas__table td small{display:block;color:var(--muted)}
.v2-whm-quotas__sort{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;min-inline-size:var(--target);min-block-size:var(--target);cursor:pointer;font:inherit;font-weight:600;color:inherit;border-radius:var(--radius-chip)}
.v2-whm-quotas__sort:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.v2-whm-quotas__table td[data-quota-cell=change]{display:flex;flex-wrap:wrap;gap:var(--space-1);align-items:center}
.v2-whm-quotas__table td[data-quota-cell=change] input[type=text]{inline-size:8rem;min-block-size:var(--target)}
@media(max-width:800px){.v2-account-tool__previews,.v2-account-tool__groups{grid-template-columns:minmax(0,1fr)}.v2-account-tool__fields:has(>:nth-child(3):last-child){grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:640px){.v2-account-tool__fields,.v2-account-tool__fields:has(>:nth-child(3):last-child){grid-template-columns:minmax(0,1fr)}.v2-account-tool__facts{grid-template-columns:repeat(2,minmax(0,1fr))}
.v2-account-tool__scroll:has(>table[data-phone-labels]){border:0;border-radius:0;background:transparent}
.v2-account-tool__scroll:has(>table[data-phone-labels] td[colspan])::before{content:attr(aria-label);display:block;margin-block-end:var(--space-1);font-size:12px;font-weight:600;color:var(--muted)}
.v2-account-tool__scroll>table[data-phone-labels],.v2-account-tool__scroll>table[data-phone-labels]>tbody{display:block}
.v2-account-tool__scroll>table[data-phone-labels]>thead{display:none}
.v2-account-tool__scroll>table[data-phone-labels]>tbody>tr{display:grid;gap:var(--space-1);padding:12px var(--space-2);border:1px solid var(--line);border-radius:var(--radius-notice);background:var(--surface)}
.v2-account-tool__scroll>table[data-phone-labels]>tbody>tr+tr{margin-block-start:var(--space-2)}
.v2-account-tool__scroll>table[data-phone-labels]>tbody>tr>td{display:grid;grid-template-columns:minmax(7rem,40%) minmax(0,1fr);gap:var(--space-2);padding:0;border:0}
.v2-account-tool__scroll>table[data-phone-labels]>tbody>tr>td[data-phone-label]::before{content:attr(data-phone-label);font-size:12px;font-weight:600;color:var(--muted)}
.v2-account-tool__scroll>table[data-phone-labels]>tbody>tr>td:not([data-phone-label]),.v2-account-tool__scroll>table[data-phone-labels]>tbody>tr>td[colspan]{display:block}
.v2-whm-quotas__table{min-inline-size:0}.v2-whm-quotas__table thead{display:none}.v2-whm-quotas__table tr{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:var(--space-1) var(--space-2);padding:12px var(--space-2)}.v2-whm-quotas__table td{padding:0;border:0}.v2-whm-quotas__table tr+tr{border-block-start:1px solid var(--line)}.v2-whm-quotas__table td[data-quota-cell=account]{grid-row:span 2}.v2-whm-quotas__table td[data-quota-cell=owner]{display:none}.v2-whm-quotas__table td[data-quota-cell=change]{grid-column:1/-1}}${whmPolish('.v2-account-tools')}`
