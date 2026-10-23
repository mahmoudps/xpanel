import { navigation, type NavSurface } from '@xpanel/catalog'
import arCatalog from '../../../packages/catalog/src/locales/ar.json' with { type: 'json' }
import { publicContactEmail } from './display-name.ts'
import { t, type Locale } from './i18n.ts'
import { escapeHtml } from './tokens.ts'

export type PanelId = 'xpanel' | 'xwhm' | 'xmail'
export type ThemeChoice = 'light' | 'dark'
export type DensityChoice = 'comfortable' | 'compact'

export interface PanelLink {
  surface: PanelId
  origin: string
}

const PANEL_LABEL: Record<PanelId, string> = { xpanel: 'xPanel', xwhm: 'xWHM', xmail: 'xMail' }
const catalogLabels = arCatalog as Readonly<Record<string, string>>

export const panelLabel = (surface: PanelId): string => PANEL_LABEL[surface]

export const navigationLabel = (surface: PanelId, kind: 'section' | 'page', item: { id: string; name: string }, locale: Locale): string =>
  locale === 'ar' ? catalogLabels[`nav.${kind}.${surface}.${item.id}.name`] ?? item.name : item.name

/** Keeps only exact HTTPS origins. Paths, credentials and duplicates are dropped. */
export function safePanelLinks(links: readonly PanelLink[] | undefined): PanelLink[] {
  if (!links) return []
  const seen = new Set<PanelId>()
  const safe: PanelLink[] = []
  for (const link of links) {
    if (link.surface !== 'xpanel' && link.surface !== 'xwhm' && link.surface !== 'xmail') continue
    if (seen.has(link.surface)) continue
    let url: URL
    try { url = new URL(link.origin) } catch { continue }
    if (url.protocol !== 'https:' || url.origin !== link.origin || url.username || url.password || url.hash) continue
    seen.add(link.surface)
    safe.push({ surface: link.surface, origin: url.origin })
  }
  return safe
}

const surfaceDesign = (surface: PanelId): NavSurface | undefined => navigation.find(item => item.surface === surface)

/** Catalog groups shown as unavailable. They are not links and do not claim a tool is qualified. */
export function renderPlannedNavigation(surface: PanelId, locale: Locale): string {
  const design = surfaceDesign(surface)
  const isAr = locale === 'ar'
  const items = (design?.sections ?? []).map(section => {
    const name = navigationLabel(surface, 'section', section, locale)
    return `<li class="xp-nav-planned__item" data-planned-group="${escapeHtml(section.id)}"><span class="xp-nav-planned__name">${escapeHtml(name)}</span><span class="xp-nav-planned__state">${escapeHtml(isAr ? 'غير متاحة بعد' : 'Not yet available')}</span></li>`
  }).join('')
  const note = isAr
    ? 'هذه مجموعات الأدوات المخططة لهذه اللوحة. ليست متاحة على هذا الخادم بعد.'
    : 'These are the tool groups planned for this panel. They are not available on this server yet.'
  return `<nav class="xp-nav-planned-wrap" aria-label="${escapeHtml(isAr ? 'أدوات مخططة' : 'Planned tools')}"><p class="xp-nav-note" data-navigation-empty="true">${escapeHtml(note)}</p><ul class="xp-nav-planned">${items}</ul></nav>`
}

export interface UserMenuModel {
  locale: Locale
  theme: ThemeChoice
  density: DensityChoice
  path: string
  accountId?: string
  username?: string
  role?: string
  signedIn: boolean
}

const menuHref = (model: UserMenuModel, patch: Partial<Pick<UserMenuModel, 'locale' | 'theme' | 'density'>>): string => {
  const params = new URLSearchParams()
  params.set('lang', patch.locale ?? model.locale)
  params.set('theme', patch.theme ?? model.theme)
  params.set('density', patch.density ?? model.density)
  if (model.accountId) params.set('accountId', model.accountId)
  const path = model.path.startsWith('/') ? model.path : `/${model.path}`
  return `${path}?${params.toString()}`
}

/** Account menu in the top bar: identity, language, theme, row spacing and sign-out. */
export function renderUserMenu(model: UserMenuModel): string {
  const isAr = model.locale === 'ar'
  const nextLocale: Locale = isAr ? 'en' : 'ar'
  const nextTheme: ThemeChoice = model.theme === 'dark' ? 'light' : 'dark'
  const languageLabel = isAr ? 'English' : 'العربية'
  const themeLabel = nextTheme === 'dark' ? (isAr ? 'الوضع الداكن' : 'Dark theme') : (isAr ? 'الوضع الفاتح' : 'Light theme')
  const summaryName = model.signedIn && model.username ? model.username : (isAr ? 'الحساب' : 'Account')
  const role = model.signedIn && model.role ? model.role : ''
  const densityLink = (density: DensityChoice, label: string) => {
    const current = model.density === density
    return `<a class="xp-menu-choice" href="${escapeHtml(menuHref(model, { density }))}" data-density-option="${density}"${current ? ' aria-current="true"' : ''}>${escapeHtml(label)}</a>`
  }
  const sessionAction = model.signedIn
    ? `<button type="button" class="xp-btn xp-menu-signout" data-action="logout">${escapeHtml(isAr ? 'تسجيل الخروج' : 'Sign out')}</button>`
    : `<a class="xp-btn xp-btn--primary" href="${escapeHtml(menuHref({ ...model, path: '/login' }, {}))}">${escapeHtml(isAr ? 'تسجيل الدخول' : 'Sign in')}</a>`
  return `<details class="xp-user-menu" data-user-menu>
    <summary class="xp-user-menu__summary">
      <span class="xp-user-menu__identity">
        <span class="xp-user-menu__name"${model.username ? ' dir="ltr"' : ''}>${model.username ? `<bdi dir="ltr">${escapeHtml(summaryName)}</bdi>` : escapeHtml(summaryName)}</span>
        ${role ? `<span class="xp-user-menu__role">${escapeHtml(role)}</span>` : ''}
      </span>
    </summary>
    <div class="xp-user-menu__panel">
      <a class="xp-menu-choice" href="${escapeHtml(menuHref(model, { locale: nextLocale }))}" lang="${nextLocale}" data-lang-switch="${nextLocale}">${escapeHtml(languageLabel)}</a>
      <a class="xp-menu-choice" href="${escapeHtml(menuHref(model, { theme: nextTheme }))}" data-theme-toggle="${nextTheme}" title="${escapeHtml(themeLabel)}">${escapeHtml(themeLabel)}</a>
      <div class="xp-menu-density" role="group" aria-label="${escapeHtml(isAr ? 'تباعد الصفوف' : 'Row spacing')}">
        ${densityLink('comfortable', t(model.locale, 'common.density.comfortable'))}
        ${densityLink('compact', t(model.locale, 'common.density.compact'))}
      </div>
      ${sessionAction}
    </div>
  </details>`
}

export function renderSupportNotice(locale: Locale, email: string | null | undefined): string {
  const contact = publicContactEmail(email)
  const isAr = locale === 'ar'
  if (contact) {
    const lead = isAr ? 'إذا كنت تحتاج أداة الآن، راسل مزوّد الاستضافة على' : 'If you need a tool now, write to your hosting provider at'
    return `<p class="xp-prose" data-support-contact="email">${escapeHtml(lead)} <a href="mailto:${escapeHtml(contact)}"><bdi dir="ltr">${escapeHtml(contact)}</bdi></a>.</p>`
  }
  const fallback = isAr
    ? 'إذا كنت تحتاج أداة الآن، تواصل مع مزوّد الاستضافة.'
    : 'If you need a tool now, contact your hosting provider.'
  return `<p class="xp-prose" data-support-contact="provider">${escapeHtml(fallback)}</p>`
}

export function roleLabel(kind: string, locale: Locale): string {
  const isAr = locale === 'ar'
  if (kind === 'root') return isAr ? 'مدير النظام' : 'System administrator'
  if (kind === 'reseller') return isAr ? 'موزع' : 'Reseller'
  return isAr ? 'مالك الحساب' : 'Account owner'
}
