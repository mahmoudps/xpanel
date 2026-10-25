import { navigation, type NavSurface } from '@xpanel/catalog'
import arCatalog from '../../../packages/catalog/src/locales/ar.json' with { type: 'json' }
import { publicContactEmail } from './display-name.ts'
import { t, type Locale } from './i18n.ts'
import { escapeHtml, normalizeAsciiDigits } from './tokens.ts'

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

/** Account security is a real session page. It is not a qualified hosting tool. */
export const accountSecurityRoute = (surface: PanelId): string =>
  surface === 'xwhm' ? '/whm/security/sign-in' : surface === 'xmail' ? '/mail/settings/security' : '/security/account'

export const securityLabel = (locale: Locale): string => locale === 'ar' ? 'الأمان' : 'Security'

export function renderSecurityNavLink(surface: PanelId, locale: Locale, activeRoute: string, alreadyListed = false): string {
  if (alreadyListed) return ''
  const href = accountSecurityRoute(surface)
  const current = activeRoute === href
  return `<a class="xp-nav-item${current ? ' xp-nav-item--active' : ''}" href="${escapeHtml(href)}" data-security-link="true"${current ? ' aria-current="page"' : ''}>${escapeHtml(securityLabel(locale))}</a>`
}

/** Catalog groups. A group becomes links only when this server qualified every tool on its page. */
export function renderPlannedNavigation(surface: PanelId, locale: Locale, activeRoute = '', qualified: readonly NavSurface[] = []): string {
  const design = surfaceDesign(surface)
  const live = qualified.find(item => item.surface === surface)
  const isAr = locale === 'ar'
  const items = (design?.sections ?? []).map(section => {
    const ready = live?.sections.find(item => item.id === section.id)
    const name = navigationLabel(surface, 'section', section, locale)
    if (ready && ready.pages.length > 0) {
      const links = ready.pages.map(page => {
        const current = activeRoute === page.route
        const label = navigationLabel(surface, 'page', page, locale)
        return `<a class="xp-nav-item${current ? ' xp-nav-item--active' : ''}" data-nav-route="${escapeHtml(page.route)}" href="${escapeHtml(page.route)}"${current ? ' aria-current="page"' : ''}>${escapeHtml(label)}</a>`
      }).join('')
      return `<li class="xp-nav-ready" data-nav-section="${escapeHtml(section.id)}"><span class="xp-nav-ready__name">${escapeHtml(name)}</span><div class="xp-nav-ready__pages">${links}</div></li>`
    }
    return `<li class="xp-nav-planned__item" data-planned-group="${escapeHtml(section.id)}"><span class="xp-nav-planned__name">${escapeHtml(name)}</span><span class="xp-nav-planned__state">${escapeHtml(isAr ? 'غير متاحة بعد' : 'Not yet available')}</span></li>`
  }).join('')
  const waiting = (design?.sections ?? []).some(section => {
    const ready = live?.sections.find(item => item.id === section.id)
    return !ready || ready.pages.length === 0
  })
  const note = waiting
    ? `<p class="xp-nav-note" data-navigation-empty="true">${escapeHtml(isAr ? 'هذه الأدوات غير متاحة على هذا الخادم بعد.' : 'These tools are not available on this server yet.')}</p>`
    : ''
  return `<nav class="xp-nav-planned-wrap" aria-label="${escapeHtml(isAr ? 'أدوات الاستضافة' : 'Hosting tools')}">${note}${renderSecurityNavLink(surface, locale, activeRoute)}<ul class="xp-nav-planned">${items}</ul></nav>`
}

export interface UserMenuModel {
  locale: Locale
  theme: ThemeChoice
  density: DensityChoice
  path: string
  surface?: PanelId
  accountId?: string
  username?: string
  role?: string
  signedIn: boolean
  links?: readonly PanelLink[]
  activityHref?: string
  menuLinks?: readonly { label: string; href: string }[]
}

export const surfaceContextHref = (model: UserMenuModel, patch: Partial<Pick<UserMenuModel, 'locale' | 'theme' | 'density'>> = {}): string => {
  const path = model.path.startsWith('/') && !model.path.startsWith('//') ? model.path : '/'
  const url = new URL(path, 'https://xpanel.invalid')
  url.searchParams.set('lang', patch.locale ?? model.locale)
  url.searchParams.set('theme', patch.theme ?? model.theme)
  url.searchParams.set('density', patch.density ?? model.density)
  if (model.accountId) url.searchParams.set('accountId', model.accountId)
  return `${url.pathname}${url.search}${url.hash}`
}

const localMenuHref = (href: string): string | undefined => {
  if (!href.startsWith('/') || href.startsWith('//') || /[\u0000-\u001f\u007f]/.test(href)) return undefined
  try {
    const url = new URL(href, 'https://xpanel.invalid')
    return url.origin === 'https://xpanel.invalid' ? `${url.pathname}${url.search}${url.hash}` : undefined
  } catch { return undefined }
}

const renderMenuLinks = (model: UserMenuModel): string => {
  const params = new URLSearchParams({ lang: model.locale, theme: model.theme, density: model.density })
  const panelPaths: Record<PanelId, string> = { xpanel: '/home', xwhm: '/whm', xmail: '/mail/inbox' }
  const panels = safePanelLinks(model.links).filter(link => link.surface !== model.surface).map(link =>
    `<a class="xp-menu-choice" data-panel-switch="${link.surface}" href="${escapeHtml(`${link.origin}${panelPaths[link.surface]}?${params.toString()}`)}">${panelLabel(link.surface)}</a>`)
  const other = [...(model.menuLinks ?? [])]
  if (model.activityHref) other.unshift({ label: model.locale === 'ar' ? 'سجل النشاط والمهام' : 'Activity & Jobs', href: model.activityHref })
  const seen = new Set<string>()
  const local = other.flatMap(link => {
    const href = localMenuHref(link.href)
    if (!href || seen.has(href)) return []
    seen.add(href)
    return [`<a class="xp-menu-choice" href="${escapeHtml(href)}">${escapeHtml(normalizeAsciiDigits(link.label))}</a>`]
  })
  const links = [...panels, ...local]
  return links.length ? `<div class="xp-menu-navigation" role="group" aria-label="${model.locale === 'ar' ? 'التنقل' : 'Navigation'}">${links.join('')}</div>` : ''
}

/** Account menu in the top bar: identity, language, theme, row spacing and sign-out. */
export function renderUserMenu(model: UserMenuModel): string {
  const isAr = model.locale === 'ar'
  const nextLocale: Locale = isAr ? 'en' : 'ar'
  const nextTheme: ThemeChoice = model.theme === 'dark' ? 'light' : 'dark'
  const languageLabel = isAr ? 'English' : 'العربية'
  const themeLabel = nextTheme === 'dark' ? (isAr ? 'الوضع الداكن' : 'Dark theme') : (isAr ? 'الوضع الفاتح' : 'Light theme')
  const summaryName = normalizeAsciiDigits(model.signedIn && model.username ? model.username : (isAr ? 'الحساب' : 'Account'))
  const role = model.signedIn && model.role ? model.role : ''
  const initial = normalizeAsciiDigits(model.username?.trim().charAt(0) || (isAr ? 'ح' : 'a')).toLocaleLowerCase('en')
  const densityLink = (density: DensityChoice, label: string) => {
    const current = model.density === density
    return `<a class="xp-menu-choice" href="${escapeHtml(surfaceContextHref(model, { density }))}" data-density-option="${density}"${current ? ' aria-current="true"' : ''}>${escapeHtml(label)}</a>`
  }
  const sessionAction = model.signedIn
    ? `<button type="button" class="xp-btn xp-menu-signout" data-action="logout">${escapeHtml(isAr ? 'تسجيل الخروج' : 'Sign out')}</button>`
    : `<a class="xp-btn xp-btn--primary" href="${escapeHtml(surfaceContextHref({ ...model, path: '/login' }, {}))}">${escapeHtml(isAr ? 'تسجيل الدخول' : 'Sign in')}</a>`
  return `<details class="xp-user-menu" data-user-menu>
    <summary class="xp-user-menu__summary" aria-label="${escapeHtml(isAr ? `قائمة المستخدم ${summaryName}` : `User menu for ${summaryName}`)}">
      <span class="xp-user-menu__avatar" aria-hidden="true">${escapeHtml(initial)}</span>
      <span class="xp-user-menu__identity">
        <span class="xp-user-menu__name"${model.username ? ' dir="ltr"' : ''}>${model.username ? `<bdi dir="ltr">${escapeHtml(summaryName)}</bdi>` : escapeHtml(summaryName)}</span>
        ${role ? `<span class="xp-user-menu__role">${escapeHtml(role)}</span>` : ''}
      </span>
    </summary>
    <div class="xp-user-menu__panel">
      <a class="xp-menu-choice" href="${escapeHtml(surfaceContextHref(model, { locale: nextLocale }))}" lang="${nextLocale}" data-lang-switch="${nextLocale}">${escapeHtml(languageLabel)}</a>
      <a class="xp-menu-choice" href="${escapeHtml(surfaceContextHref(model, { theme: nextTheme }))}" data-theme-toggle="${nextTheme}" title="${escapeHtml(themeLabel)}">${escapeHtml(themeLabel)}</a>
      <div class="xp-menu-density" role="group" aria-label="${escapeHtml(isAr ? 'تباعد الصفوف' : 'Row spacing')}">
        ${densityLink('comfortable', t(model.locale, 'common.density.comfortable'))}
        ${densityLink('compact', t(model.locale, 'common.density.compact'))}
      </div>
      <a class="xp-menu-choice" href="${escapeHtml(surfaceContextHref({ ...model, path: accountSecurityRoute(model.surface ?? (model.path.startsWith('/whm') ? 'xwhm' : model.path.startsWith('/mail') ? 'xmail' : 'xpanel')) }))}" data-security-link="true">${escapeHtml(securityLabel(model.locale))}</a>
      ${renderMenuLinks(model)}
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
