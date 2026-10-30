import { navigation, canonicalNavigationRoute, canOpenRegisteredRoute, isToolAuthorized } from '@xpanel/catalog'
import type { PanelSurfaceProps } from '../../../../contract.ts'
import { localeDirection } from '../../../../../i18n.ts'
import { normalizeAsciiDigits } from '../../../../../display-format.ts'
import { card, notice, pageHeader } from '../../../components/index.ts'
import { escapeHtml, hookAttrs, type HookAttributes } from '../../../html.ts'
import { v2Messages } from '../../../messages.ts'

/** Current core decisions, separate from theme choice and saved presentation preferences. */
export interface PanelSettingsAuthority {
  readonly presentation?: 'live' | 'read-only'
  readonly canReadFacts?: boolean
  readonly authorizedTools?: ReadonlySet<string>
  readonly canRead: boolean
  readonly canManage: boolean
  readonly relatedRoutes?: ReadonlySet<string>
}

export const NO_SETTINGS_AUTHORITY: PanelSettingsAuthority = Object.freeze({ canRead: false, canManage: false })

export function settingsContext(props: PanelSurfaceProps, authority: PanelSettingsAuthority) {
  const locale = props.locale ?? 'en'
  const readOnly = authority.presentation === 'read-only'
  const route = canonicalNavigationRoute(props.activeRoute ?? '/preferences')
  const pageTools = navigation.find(surface => surface.surface === 'xpanel')?.sections.flatMap(section => section.pages).find(page => page.route === route)?.tools ?? []
  const matched = props.visibility?.principal.kind === 'user' && props.visibility.principal.accountId === props.account?.id
  const factPermission = readOnly && authority.canReadFacts === true && matched && !!props.visibility && canOpenRegisteredRoute(route, props.visibility) && pageTools.some(id => authority.authorizedTools?.has(id) && props.catalog?.some(tool => tool.id === id && isToolAuthorized(tool, props.visibility!)))
  const readable = !readOnly && authority.canRead === true && !!props.account
  const factsReadable = readable || factPermission
  const account = factsReadable ? props.account : undefined
  const domains = account ? props.domains?.filter(domain => domain.accountId === account.id) : undefined
  const selected = domains?.find(domain => domain.name === props.activeDomain)
    ?? domains?.find(domain => domain.name === account?.primaryDomain) ?? domains?.[0]
  return { locale, t: v2Messages.translator(locale), readable, factsReadable, readOnly, account, domains, selected,
    editable: readable && account?.status === 'active' && authority.canManage === true }
}

export const esc = escapeHtml
export const technical = (value: string | number): string => `<bdi dir="ltr" class="v2-mono">${esc(normalizeAsciiDigits(value))}</bdi>`
export const actions = (body: string): string => `<div class="v2-panel-settings__actions">${body}</div>`
export const fields = (body: string): string => `<div class="v2-panel-settings__fields">${body}</div>`
export const groups = (body: string): string => `<div class="v2-panel-settings__groups">${body}</div>`
export const split = (main: string, aside: string): string => `<div class="v2-panel-settings__split"><div class="v2-panel-settings__groups">${main}</div><aside class="v2-panel-settings__groups">${aside}</aside></div>`

export const button = (label: string, hooks?: HookAttributes, disabled = true, primary = false): string =>
  `<button type="button" class="v2-btn${primary ? ' v2-btn--primary' : ''}"${hookAttrs(hooks)}${disabled ? ' disabled' : ''}>${esc(label)}</button>`
export const link = (label: string, href: string, hooks?: HookAttributes): string =>
  `<a class="v2-btn" href="${esc(href)}"${hookAttrs(hooks)}>${esc(label)}</a>`
export const input = (id: string, name: string, type = 'text', extra = '', disabled = true): string =>
  `<input id="${esc(id)}"${name ? ` name="${esc(name)}"` : ''} type="${esc(type)}"${extra}${disabled ? ' disabled' : ''}>`
export const area = (id: string, name: string, extra = '', disabled = true, value = ''): string =>
  `<textarea id="${esc(id)}"${name ? ` name="${esc(name)}"` : ''}${extra}${disabled ? ' disabled' : ''}>${esc(value)}</textarea>`
export const select = (id: string, name: string, options: readonly (readonly [string, string])[], extra = '', disabled = true, selected?: string): string =>
  `<span class="v2-select"><select id="${esc(id)}"${name ? ` name="${esc(name)}"` : ''}${extra}${disabled ? ' disabled' : ''}>${options.map(([value, label]) => `<option value="${esc(value)}"${selected === value ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select></span>`
export const check = (id: string, label: string, hooks?: HookAttributes, disabled = true, checked = false, name?: string): string =>
  `<label class="v2-panel-settings__check" for="${esc(id)}"><input id="${esc(id)}" type="checkbox"${name ? ` name="${esc(name)}"` : ''}${hookAttrs(hooks)}${disabled ? ' disabled' : ''}${checked ? ' checked' : ''}><span>${esc(label)}</span></label>`

export function field(id: string, label: string, controlHtml: string, help?: string): string {
  const control = help && !controlHtml.includes('aria-describedby=')
    ? controlHtml.replace(/<(input|select|textarea)\b/, `<$1 aria-describedby="${esc(id)}-help"`) : controlHtml
  return `<div class="v2-field"><label for="${esc(id)}">${esc(label)}</label>${control}${help ? `<p class="v2-field__help" id="${esc(id)}-help">${esc(help)}</p>` : ''}</div>`
}

export const facts = (items: readonly { label: string; valueHtml: string; hooks?: HookAttributes }[], hooks?: HookAttributes): string =>
  `<dl class="v2-panel-settings__facts"${hookAttrs(hooks)}>${items.map(item => `<div><dt>${esc(item.label)}</dt><dd${hookAttrs(item.hooks)}>${item.valueHtml}</dd></div>`).join('')}</dl>`
export const section = (id: string, title: string, bodyHtml: string, actionsHtml?: string, hooks?: HookAttributes): string =>
  card({ id, title, titleId: `${id}-heading`, bodyHtml, ...(actionsHtml ? { actionsHtml } : {}), ...(hooks ? { hooks } : {}) })
export const unreadRow = (columns: number, text: string): string => `<tr><td colspan="${columns}"><p role="status">${esc(text)}</p></td></tr>`
export const table = (id: string, title: string, heads: readonly string[], bodyHtml: string, bodyHooks?: HookAttributes, tableHooks?: HookAttributes): string =>
  `<div class="v2-panel-settings__table" role="region" tabindex="0" aria-labelledby="${esc(id)}-caption"><table id="${esc(id)}"${hookAttrs(tableHooks)}><caption id="${esc(id)}-caption" class="v2-sr">${esc(title)}</caption><thead><tr>${heads.map(head => `<th scope="col">${esc(head)}</th>`).join('')}</tr></thead><tbody${hookAttrs(bodyHooks)}>${bodyHtml}</tbody></table></div>`
export const status = (text: string, hooks?: HookAttributes): string => `<p role="status" data-state="unread"${hookAttrs(hooks)}>${esc(text)}</p>`
export const note = (text: string): string => `<p class="v2-muted">${esc(text)}</p>`

export function page(props: PanelSurfaceProps, authority: PanelSettingsAuthority, route: string, title: string, description: string, bodyHtml: string, hooks?: HookAttributes): string {
  const { locale, t, account, readable, readOnly } = settingsContext(props, authority)
  const keepSecurityHostOpen = route === '/security/account' && readOnly
  return `<section class="v2-panel-settings" data-v2-settings-route="${esc(route)}"${!readable && !keepSecurityHostOpen ? ' data-readonly="true"' : ''}${account ? ` data-account="${esc(account.id)}" data-uid="${account.uid}"` : ''} lang="${locale}" dir="${localeDirection(locale)}"${hookAttrs(hooks)}>${pageHeader(t, { route, title, description, breadcrumb: [{ label: t(msgid('Home')), href: '/home' }, { label: title }] })}${bodyHtml}</section>`
}

export function deniedPage(props: PanelSurfaceProps, authority: PanelSettingsAuthority, route: string, title: string, description: string): string {
  const { t } = settingsContext(props, authority)
  return page(props, authority, route, title, description, section('v2-settings-unavailable', title, notice(t, { tone: 'warn', lead: t(msgid('Unavailable')), text: t(msgctxt('theme:v2', 'An authorized account has not been read. Nothing was read or changed.')) })))
}

export const PANEL_SETTINGS_CSS = `.v2-panel-settings{display:flex;flex-direction:column;gap:var(--space-4);min-inline-size:0;text-align:start}
.v2-panel-settings :is(h2,h3,h4,p,dl,dd,ul,ol,pre,fieldset){margin:0}
.v2-panel-settings .v2-card{gap:var(--space-3)}
.v2-panel-settings .v2-card__body,.v2-panel-settings__groups,.v2-panel-settings form{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0}
.v2-panel-settings__fields,.v2-panel-settings__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:var(--space-2);min-inline-size:0}
.v2-panel-settings__facts>div{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0;text-align:start}
.v2-panel-settings__facts dt{font-size:12px;color:var(--muted)}.v2-panel-settings__facts dd{overflow-wrap:anywhere;text-align:start}
.v2-panel-settings__actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
.v2-panel-settings__check{display:flex;align-items:flex-start;gap:var(--space-1);min-block-size:var(--target)}
.v2-panel-settings__check>input{flex:none;margin-block:4px 0}
.v2-panel-settings__split{display:grid;grid-template-columns:minmax(0,1fr) minmax(240px,320px);align-items:start;gap:var(--space-3);min-inline-size:0}
.v2-panel-settings__split>.v2-panel-settings__groups,.v2-panel-settings__split>.v2-panel-settings__groups>form{gap:var(--space-4)}
.v2-panel-settings__table{overflow:auto;max-inline-size:100%;min-inline-size:0}.v2-panel-settings__table table{inline-size:100%;border-collapse:collapse}
.v2-panel-settings__table :is(th,td){text-align:start;vertical-align:top;padding:12px 16px;overflow-wrap:anywhere}.v2-panel-settings__table tbody td{border-block-start:1px solid var(--line)}
.v2-panel-settings :is(input,select,textarea){max-inline-size:100%;min-inline-size:0}.v2-panel-settings :is(input,textarea)[dir=ltr]{text-align:var(--v2-control-align,start)}
.v2-panel-settings textarea{inline-size:100%;resize:vertical;min-block-size:112px}.v2-panel-settings pre{max-inline-size:100%;min-inline-size:0;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}
.v2-panel-settings :is(ul,ol){padding-inline-start:var(--space-3);display:grid;gap:var(--space-2)}
.v2-panel-settings .v2-panel-settings__list{list-style:none;padding:0;display:grid;gap:var(--space-2)}
.v2-panel-settings fieldset{border:1px solid var(--line);border-radius:var(--radius-control);padding:var(--space-2);display:grid;gap:var(--space-2);min-inline-size:0}
.v2-panel-settings legend{padding-inline:var(--space-1);font-weight:600}.v2-panel-settings [hidden]{display:none}
.v2-panel-settings__preview{border:1px solid var(--line);border-radius:var(--radius-control);padding:var(--space-2);background:var(--sunken)}
.v2-panel-settings__steps{list-style:none;padding:0;display:flex;flex-wrap:wrap;gap:var(--space-2)}
.v2-panel-settings__steps>li{display:flex;gap:var(--space-1);align-items:center}.v2-panel-settings__steps b{display:inline-flex;align-items:center;justify-content:center;inline-size:32px;block-size:32px;border:1px solid var(--line);border-radius:50%;flex:none}
.v2-panel-settings__tabs{display:flex;flex-wrap:wrap;gap:var(--space-1);border-block-end:1px solid var(--line);padding-block-end:var(--space-2)}
.v2-panel-settings__kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--space-2)}
.v2-panel-settings__role{display:grid;grid-template-columns:auto minmax(0,1fr);gap:var(--space-1);align-items:start}.v2-panel-settings__role input{inline-size:24px;block-size:24px}.v2-panel-settings__role p{grid-column:2}
.v2-panel-settings__loading{display:grid;gap:var(--space-1)}
.v2-panel-settings .v2-settings-security-checks{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--space-2)}
.v2-panel-settings .v2-settings-security-check{display:flex;align-items:center;gap:var(--space-2);padding:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-control);text-decoration:none;color:var(--text);min-inline-size:0}
.v2-panel-settings .v2-settings-security-check>.v2-field{flex:1;min-inline-size:0}.v2-panel-settings .v2-settings-security-check>.v2-icon:last-child{flex:none}
@media(max-width:1000px){.v2-panel-settings__split{grid-template-columns:minmax(0,1fr)}}
@media(max-width:700px){.v2-panel-settings__kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:900px){.v2-panel-settings .v2-settings-security-checks{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:600px){.v2-panel-settings__fields,.v2-panel-settings__facts,.v2-panel-settings .v2-settings-security-checks{grid-template-columns:minmax(0,1fr)}}`
