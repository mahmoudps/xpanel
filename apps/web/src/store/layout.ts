import type { Locale } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'
import { STORE_CSS } from './styles.ts'

export const tx = (locale: Locale, en: string, ar: string): string => escapeHtml(locale === 'ar' ? ar : en)

export const storeStyle = (): string => `<style id="xp-store-styles">${STORE_CSS}</style>`

export const soonHint = (locale: Locale): string =>
  `<p class="xp-help" data-wiring-hint="soon">${tx(locale, 'Coming soon', 'قيد التفعيل')}</p>`

export const disabledButton = (
  locale: Locale,
  label: readonly [string, string],
  variant: '' | 'primary' | 'danger' = '',
): string =>
  `<button type="button" class="xp-btn${variant ? ` xp-btn--${variant}` : ''}" disabled data-wiring="soon">${tx(locale, label[0], label[1])}</button>`

export const emptyState = (locale: Locale, title: readonly [string, string], body: readonly [string, string]): string =>
  `<div class="xp-design-empty" role="status"><h3>${tx(locale, title[0], title[1])}</h3><p>${tx(locale, body[0], body[1])}</p></div>`

export const progressTrack = (locale: Locale, label: readonly [string, string]): string => `
<div class="xp-store-progress" data-progress="idle">
  <div class="xp-store-progress__fill"></div>
</div>
<p class="xp-store-progress__label">${tx(locale, label[0], label[1])}</p>`

export interface StoreNavItem {
  href: string
  label: readonly [string, string]
}

export const storeNav = (locale: Locale, label: readonly [string, string], current: string, items: readonly StoreNavItem[]): string => `
<nav class="xp-store-nav" aria-label="${tx(locale, label[0], label[1])}">
  ${items.map(item => `<a href="${escapeHtml(item.href)}"${item.href === current ? ' aria-current="page"' : ''}>${tx(locale, item.label[0], item.label[1])}</a>`).join('')}
</nav>`

export const storeNote = (locale: Locale, text: readonly [string, string]): string =>
  `<div class="xp-board-note"><p>${tx(locale, text[0], text[1])}</p></div>`

export const crumb = (locale: Locale, items: readonly { label: readonly [string, string]; href?: string; current?: boolean }[]): string => `
<nav class="xp-board-crumb" aria-label="${tx(locale, 'Breadcrumb', 'مسار الصفحة')}">
  <ol>
    ${items.map(item => `<li${item.current ? ' aria-current="page"' : ''}>${item.href && !item.current ? `<a href="${escapeHtml(item.href)}">${tx(locale, item.label[0], item.label[1])}</a>` : tx(locale, item.label[0], item.label[1])}</li>`).join('')}
  </ol>
</nav>`

export const section = (title: readonly [string, string], locale: Locale, body: string, id: string): string => `
<section class="xp-board-section" aria-labelledby="${escapeHtml(id)}">
  <header class="xp-board-section__head"><h2 id="${escapeHtml(id)}">${tx(locale, title[0], title[1])}</h2></header>
  <div class="xp-board-section__body">${body}</div>
</section>`

export const fact = (locale: Locale, label: readonly [string, string], value: readonly [string, string]): string =>
  `<div><dt>${tx(locale, label[0], label[1])}</dt><dd>${tx(locale, value[0], value[1])}</dd></div>`

export const unread = ['Not read', 'لم يُقرأ'] as const
