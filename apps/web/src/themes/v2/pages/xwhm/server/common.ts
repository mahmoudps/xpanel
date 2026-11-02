import { whmStoredFacts, type WhmStoredFactAuthority } from '../stored-facts.ts'
import { canOpenRegisteredRoute } from '@xpanel/catalog'
import { localeDirection, type Translate } from '../../../../../i18n.ts'
import { normalizeAsciiDigits } from '../../../../../display-format.ts'
import type { WhmSurfaceProps } from '../../../../contract.ts'
import { card } from '../../../components/card.ts'
import { pageHeader } from '../../../components/page-header.ts'
import { escapeHtml, hookAttrs, type HookAttributes } from '../../../html.ts'

/** Core supplies admission and optional observations; renderers never infer host qualification. */
export interface WhmAdminAuthority extends WhmStoredFactAuthority {
  readonly canRead: boolean
  readonly canManage: boolean
  readonly canUseTerminal?: boolean
  readonly themePackages?: readonly { readonly label: string; readonly surfaces: readonly string[]; readonly available: boolean }[]
}
export const DENIED_ADMIN_AUTHORITY: WhmAdminAuthority = Object.freeze({ canRead: false, canManage: false })
export interface AdminControl {
  readonly name?: string
  readonly type?: string
  readonly value?: string | number
  readonly dir?: 'ltr' | 'auto'
  readonly disabled?: boolean
  readonly required?: boolean
  readonly readOnly?: boolean
  readonly min?: number
  readonly max?: number
  readonly step?: number
  readonly maxLength?: number
  readonly rows?: number
  readonly autocomplete?: string
  readonly placeholder?: string
  readonly describedBy?: string
  readonly hooks?: HookAttributes
}

export function adminContext(t: Translate, props: WhmSurfaceProps, authority: WhmAdminAuthority, route: string, family: 'server' | 'panel') {
  const locale = props.locale ?? 'en', principal = props.visibility?.principal ?? props.principal
  const personal = route === '/whm/preferences'
  const canRead = authority.presentation !== 'read-only' && authority.canRead && props.capabilityUnavailable !== true && !!principal
    && (principal.kind === 'root' || personal && principal.kind === 'reseller')
    && canOpenRegisteredRoute(route, { ...props.visibility, principal, reseller: props.visibility?.reseller ?? props.activeReseller ?? undefined })
  const canManage = canRead && authority.canManage
  const canReadFacts = (ids: readonly string[]): boolean => canRead || principal?.kind === 'root' && whmStoredFacts(props, authority, ids, route)
  const e = (value: string | number): string => escapeHtml(normalizeAsciiDigits(value))
  const text = (message: string): string => e(t(message))
  const attrs = (options: AdminControl): string => {
    const values = { name: options.name, dir: options.dir, min: options.min, max: options.max, step: options.step, maxlength: options.maxLength, autocomplete: options.autocomplete ?? 'off', placeholder: options.placeholder, 'aria-describedby': options.describedBy }
    return Object.entries(values).filter(([, value]) => value !== undefined).map(([name, value]) => ` ${name}="${e(value!)}"`).join('')
      + (options.disabled !== false ? ' disabled' : '') + (options.required ? ' required' : '') + (options.readOnly ? ' readonly' : '') + hookAttrs(options.hooks)
  }
  const input = (id: string, options: AdminControl = {}): string => `<input id="${e(id)}" type="${e(options.type ?? 'text')}"${attrs(options)}${options.value !== undefined ? ` value="${e(options.value)}"` : ''}${options.dir === 'ltr' ? ' spellcheck="false"' : ''}>`
  const area = (id: string, options: AdminControl = {}): string => `<textarea id="${e(id)}" rows="${options.rows ?? 4}"${attrs(options)}${options.dir === 'ltr' ? ' spellcheck="false"' : ''}>${options.value === undefined ? '' : e(options.value)}</textarea>`
  const select = (id: string, choices: readonly (readonly [string, string])[], options: AdminControl = {}): string => `<select id="${e(id)}"${attrs(options)}>${choices.map(([value, label]) => `<option value="${e(value)}"${options.value === value ? ' selected' : ''}>${text(label)}</option>`).join('')}</select>`
  const field = (id: string, label: string, control: string, help?: string): string => `<div class="v2-admin-field"><label for="${e(id)}">${text(label)}</label>${control}${help ? `<p class="v2-muted" id="${e(id)}-help">${text(help)}</p>` : ''}</div>`
  const button = (label: string, hooks?: HookAttributes, options: { disabled?: boolean; primary?: boolean; danger?: boolean; type?: 'button' | 'submit' | 'reset'; hidden?: boolean; ariaLabel?: string } = {}): string => `<button type="${options.type ?? 'button'}" class="v2-btn${options.primary ? ' v2-btn--primary' : ''}${options.danger ? ' v2-btn--danger' : ''}"${hookAttrs(hooks)}${options.ariaLabel ? ` aria-label="${e(options.ariaLabel)}"` : ''}${options.disabled !== false ? ' disabled' : ''}${options.hidden ? ' hidden' : ''}>${text(label)}</button>`
  const check = (label: string, options: { name?: string; value?: string; checked?: boolean; hooks?: HookAttributes; disabled?: boolean } = {}): string => `<label class="v2-admin-choice"><input type="checkbox"${options.name ? ` name="${e(options.name)}"` : ''}${options.value !== undefined ? ` value="${e(options.value)}"` : ''}${options.checked ? ' checked' : ''}${options.disabled !== false ? ' disabled' : ''}${hookAttrs(options.hooks)}><span>${text(label)}</span></label>`
  const technical = (value: string | number): string => `<bdi class="v2-mono v2-num" dir="ltr">${e(value)}</bdi>`
  const status = (message: string, hooks?: HookAttributes, hidden = false): string => `<p role="status" data-state="unread"${hookAttrs(hooks)}${hidden ? ' hidden' : ''}>${text(message)}</p>`
  const facts = (rows: readonly { label: string; value?: string | number | null; technical?: boolean; hooks?: HookAttributes }[]): string => `<dl class="v2-admin-fields">${rows.map(row => `<div class="v2-admin-field"><dt>${text(row.label)}</dt><dd>${row.technical ? `<bdi dir="ltr"${hookAttrs(row.hooks)}>` : `<span${hookAttrs(row.hooks)}>`}${row.value === undefined || row.value === null ? text('Not read') : e(row.value)}${row.technical ? '</bdi>' : '</span>'}</dd></div>`).join('')}</dl>`
  const table = (id: string, title: string, columns: readonly string[], hooks?: HookAttributes, body?: string, empty = 'Not read'): string => `<div class="v2-admin-table" role="region" tabindex="0" aria-labelledby="${e(id)}-caption"><table id="${e(id)}"><caption id="${e(id)}-caption" class="v2-sr">${text(title)}</caption><thead><tr>${columns.map(label => `<th scope="col">${text(label)}</th>`).join('')}</tr></thead><tbody${hookAttrs(hooks)}>${body ?? `<tr><td colspan="${columns.length}">${text(empty)}</td></tr>`}</tbody></table></div>`
  const section = (id: string, title: string, bodyHtml: string, hooks?: HookAttributes): string => card({ id, title: t(title), titleId: `${id}-heading`, bodyHtml, hooks })
  const actions = (html: string): string => `<div class="v2-admin-actions">${html}</div>`
  const fields = (html: string): string => `<div class="v2-admin-fields">${html}</div>`
  const form = (hooks: HookAttributes, html: string, enabled = canManage): string => `<${enabled ? 'form' : 'div'} class="v2-admin-form"${hookAttrs(hooks)}${enabled ? ' novalidate' : ''}>${html}</${enabled ? 'form' : 'div'}>`
  const page = (title: string, description: string, bodyHtml: string, hooks?: HookAttributes): string => `<section class="v2-${family}-page" data-v2-${family}-route="${e(route)}" data-whm-detail-route="${e(route)}" data-capability-state="${canRead ? 'authorized' : 'unavailable'}" lang="${locale}" dir="${localeDirection(locale)}"${hookAttrs(hooks)}>${pageHeader(t, { route, title: t(title), description: t(description), breadcrumb: [{ label: t('Home'), href: '/whm' }, { label: t(title) }] })}${!canRead ? status(msgctxt('theme:v2', 'This session has no admitted read for this workspace. No private state or host outcome is assumed.')) : ''}${bodyHtml}</section>`
  return { t, e, text, input, area, select, field, button, check, technical, status, facts, table, section, actions, fields, form, page, locale, canRead, canReadFacts, canManage }
}
export type AdminView = ReturnType<typeof adminContext>

export function adminStyles(scope: '.v2-server-page' | '.v2-panel-page'): string {
  return `${scope},${scope} .v2-admin-stack{display:flex;flex-direction:column;gap:var(--space-4);min-inline-size:0}
${scope} .v2-admin-form{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0}
${scope} .v2-card__body{gap:var(--space-3)}
${scope} :is(p,dl,dd,fieldset,ul,ol,pre){margin:0}
${scope} .v2-admin-columns{display:grid;grid-template-columns:minmax(0,1.75fr) minmax(240px,1fr);gap:var(--space-3);align-items:start}
${scope} .v2-admin-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2)}
${scope} .v2-admin-field{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0;text-align:start}
${scope} .v2-admin-field :is(label,dt){font-size:13px;font-weight:600;color:var(--text-2)}
${scope} .v2-admin-field>label,${scope} .v2-admin-field>.v2-muted{padding-inline:13px}
${scope} .v2-admin-field dd{margin:0;overflow-wrap:anywhere}
${scope} .v2-admin-field :is(input,select,textarea){inline-size:100%;min-inline-size:0;max-inline-size:100%;box-sizing:border-box}
${scope} :is(input,textarea)[dir=ltr]{text-align:var(--v2-control-align,start);unicode-bidi:isolate}
${scope} :is(bdi,time,code){unicode-bidi:isolate;overflow-wrap:anywhere}
${scope} .v2-admin-actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2)}
${scope} .v2-admin-choice{display:flex;align-items:center;gap:var(--space-1);min-block-size:var(--target)}
${scope} fieldset{display:flex;flex-direction:column;gap:var(--space-2);border:1px solid var(--line);border-radius:var(--radius-control);padding:var(--space-2);min-inline-size:0}
${scope} legend{padding-inline:var(--space-1);font-weight:600}
${scope} .v2-admin-table{overflow:auto;min-inline-size:0;max-inline-size:100%}
${scope} .v2-admin-table table{inline-size:100%;min-inline-size:600px;border-collapse:collapse}
${scope} .v2-admin-table :is(th,td){padding:12px 16px;text-align:start;vertical-align:top;overflow-wrap:anywhere;border-block-end:1px solid var(--line)}
${scope} .v2-admin-table :is(th,td):first-child{padding-inline-start:var(--v2-panel-padding)}
${scope} .v2-admin-table :is(th,td):last-child{padding-inline-end:var(--v2-panel-padding)}
${scope} .v2-admin-table :is(bdi,time,code){font-family:var(--font-mono);font-variant-numeric:tabular-nums}
${scope} .v2-admin-list{display:flex;flex-direction:column;gap:var(--space-2);padding-inline-start:var(--space-3)}
${scope} .v2-admin-subgroup{display:flex;flex-direction:column;gap:var(--space-3)}
${scope} .v2-admin-secret{display:block;min-block-size:var(--target);padding:var(--space-2);border:1px solid var(--line-strong);border-radius:var(--radius-control);background:var(--sunken);font-family:var(--font-mono);overflow-wrap:anywhere;user-select:all}
${scope} pre{padding:var(--space-2);border-radius:var(--radius-control);background:var(--code);color:var(--code-text);white-space:pre-wrap;overflow-wrap:anywhere;max-block-size:360px;overflow:auto}
${scope} [hidden]{display:none!important}
@media(max-width:900px){${scope} .v2-admin-columns{grid-template-columns:minmax(0,1fr)}}
@media(max-width:600px){${scope} .v2-admin-fields{grid-template-columns:minmax(0,1fr)}}
`
}
