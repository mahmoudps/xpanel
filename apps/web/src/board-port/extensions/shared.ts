import { localeDirection, translator, type Locale, type MessageValues } from '../../i18n.ts'
import { escapeHtml } from '../../tokens.ts'

export type ExtensionCopy = string
export interface ExtensionRouteSpec {
  route: string
  surface: 'xpanel' | 'xwhm'
  roles: readonly ('owner' | 'root')[]
  tools: readonly string[]
  title: ExtensionCopy
}

/** An unread collection is distinct from an observed empty collection. */
export type ReadCollection<T> = { state: 'unread' } | { state: 'read'; items: readonly T[] }

export const extensionText = (locale: Locale, copy: ExtensionCopy, values?: MessageValues): string => escapeHtml(translator(locale)(copy, values))
export const extensionTechnical = (value: string | number): string => `<bdi dir="ltr" class="xp-mono">${escapeHtml(String(value))}</bdi>`
export const extensionUnread: ExtensionCopy = msgctxt('shared', 'Not read')
export const extensionNotChecked: ExtensionCopy = msgid('Not checked')

export const EXTENSION_CSS = `
.xp-extension{display:grid;gap:32px;min-inline-size:0;color:var(--xp-text-primary);font-family:var(--xp-font-sans-ltr);font-size:var(--xp-type-body);line-height:var(--xp-leading-body);text-align:start}
.xp-extension[lang="ar"]{font-family:var(--xp-font-sans-rtl)}
.xp-extension :is(h1,h2,h3,p,dl,dd){margin:0}
.xp-extension :is(h1,h2,h3){overflow-wrap:anywhere}
.xp-extension h1{font-size:var(--xp-type-page);line-height:var(--xp-leading-page)}
.xp-extension h2{font-size:var(--xp-type-card);line-height:var(--xp-leading-card)}
.xp-extension :is(p,dd){font-size:var(--xp-type-body);line-height:var(--xp-leading-body)}
.xp-extension__card{display:grid;gap:24px;padding:24px;min-inline-size:0;border:1px solid var(--xp-border);border-radius:var(--xp-radius-md);background:var(--xp-bg-surface)}
.xp-extension__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:16px;min-inline-size:0}
.xp-extension__fact{display:grid;grid-template-columns:minmax(0,1fr);gap:8px;min-inline-size:0;text-align:start}
.xp-extension__fact dt{color:var(--xp-text-secondary);font-weight:500;font-size:var(--xp-type-label);line-height:var(--xp-leading-label)}
.xp-extension__fact dd{min-inline-size:0;overflow-wrap:anywhere;text-align:start}
.xp-extension__fact bdi{overflow-wrap:anywhere;white-space:normal}
.xp-extension__list{display:grid;gap:24px;list-style:none;margin:0;padding:0;min-inline-size:0}
.xp-extension__list>li{display:grid;gap:24px;min-inline-size:0}
.xp-extension__actions{display:flex;flex-wrap:wrap;gap:16px;align-items:center}
.xp-extension :is(input:not([type="checkbox"]),select,button,a.xp-btn){min-block-size:44px;min-inline-size:44px;font-size:var(--xp-type-body);line-height:var(--xp-leading-body);max-inline-size:100%}
.xp-extension select.xp-select:not([multiple]):not([size]){line-height:var(--xp-leading-body)}
.xp-extension .xp-field{display:grid;grid-template-columns:minmax(0,1fr);gap:8px;min-inline-size:0}
.xp-extension .xp-field>label{padding-inline:13px;font-size:var(--xp-type-label);line-height:var(--xp-leading-label);text-align:start}
.xp-extension .xp-field>:is(input,select){inline-size:100%;min-inline-size:0}
.xp-extension .xp-form-group{display:grid;gap:16px;min-inline-size:0}
.xp-extension :focus-visible{outline:var(--xp-focus-width) solid var(--xp-border-focus);outline-offset:var(--xp-focus-offset)}
@media(max-width:600px){.xp-extension__card{padding:16px}}
@media(max-width:959px){.xp-extension :is(input:not([type="checkbox"]),select){font-size:var(--xp-type-input-mobile);line-height:var(--xp-leading-input-mobile)}.xp-extension select.xp-select:not([multiple]):not([size]){line-height:var(--xp-leading-input-mobile)}}
`

export const extensionFact = (locale: Locale, label: ExtensionCopy, value: string | undefined, technical = false): string =>
  `<div class="xp-extension__fact" data-extension-fact><dt>${extensionText(locale, label)}</dt><dd data-extension-value>${value === undefined ? extensionText(locale, extensionUnread) : technical ? extensionTechnical(value) : escapeHtml(value)}</dd></div>`

export const extensionCard = (locale: Locale, title: ExtensionCopy, body: string): string =>
  `<section class="xp-extension__card"><h2>${extensionText(locale, title)}</h2>${body}</section>`

export const extensionFrame = (locale: Locale, title: ExtensionCopy, body: string): string =>
  `<div class="xp-extension" data-extension-view lang="${locale}" dir="${localeDirection(locale)}"><style>${EXTENSION_CSS}</style><h1>${extensionText(locale, title)}</h1>${body}</div>`

export const extensionCollection = <T>(
  locale: Locale,
  value: ReadCollection<T> | undefined,
  empty: ExtensionCopy,
  row: (value: T) => string,
): string => value?.state !== 'read'
  ? `<p data-collection-state="unread">${extensionText(locale, extensionUnread)}</p>`
  : value.items.length === 0
    ? `<p data-collection-state="empty">${extensionText(locale, empty)}</p>`
    : `<ul class="xp-extension__list" data-collection-state="read">${value.items.map(item => `<li>${row(item)}</li>`).join('')}</ul>`

export const extensionDisabled = (locale: Locale, label: ExtensionCopy): string =>
  `<button type="button" class="xp-btn" disabled data-wiring="unavailable">${extensionText(locale, label)}</button>`
