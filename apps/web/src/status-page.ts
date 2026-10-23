import { visibleNavigation, type CatalogTool, type VisibilityContext } from '@xpanel/catalog'
import { panelLabel, renderPlannedNavigation, renderSupportNotice, renderUserMenu, safePanelLinks, type DensityChoice, type PanelId, type PanelLink, type ThemeChoice } from './chrome.ts'
import type { Locale } from './i18n.ts'
import { renderSurfaceShell } from './shell.ts'
import { escapeHtml } from './tokens.ts'

export type StatusCode = 403 | 404 | 421 | 500 | 503

export interface StatusPageModel {
  status: StatusCode
  locale: Locale
  theme: ThemeChoice
  density: DensityChoice
  surface: PanelId
  path: string
  signedIn?: boolean
  username?: string
  role?: string
  accountId?: string
  /** Same-listener page that will actually open. Omitted when it would fail again. */
  workspaceHref?: string
  retryHref?: string
  panels?: readonly PanelLink[]
  /** Another panel that matches this request better than the current listener. */
  suggested?: PanelId
  supportEmail?: string
  visibility?: VisibilityContext
  /** Qualified catalog for this host. The sidebar keeps these sections as links. */
  catalog?: readonly CatalogTool[]
}

interface Copy {
  title: string
  explanation: string
}

export const statusPageCopy = (status: StatusCode, locale: Locale): Copy => {
  const ar = locale === 'ar'
  switch (status) {
    case 404:
      return ar
        ? { title: 'هذه الصفحة غير موجودة', explanation: 'العنوان لا يطابق صفحة في هذه اللوحة.' }
        : { title: 'This page is not here', explanation: 'That address does not match a page on this panel.' }
    case 403:
      return ar
        ? { title: 'لا يمكنك فتح هذه الصفحة', explanation: 'هذه اللوحة لدور مختلف، أو هذا الحساب لا يملك صلاحية عرضها.' }
        : { title: 'You cannot open this page', explanation: 'This panel is for a different role, or this account cannot view the page.' }
    case 421:
      return ar
        ? { title: 'افتح عنوان اللوحة', explanation: 'هذا العنوان ليس إحدى لوحات الخادم. اختر اللوحة التي تريدها.' }
        : { title: 'Open a panel address', explanation: 'This address is not one of the panels. Choose the panel you need.' }
    case 500:
      return ar
        ? { title: 'حدث خطأ', explanation: 'تعذر على اللوحة إكمال تحميل هذه الصفحة. أعد المحاولة بعد قليل.' }
        : { title: 'Something went wrong', explanation: 'The panel could not finish loading this page. Try again in a moment.' }
    case 503:
      return ar
        ? { title: 'اللوحة غير متاحة مؤقتًا', explanation: 'أعد المحاولة بعد قليل. لم يُغيّر شيء.' }
        : { title: 'The panel is briefly unavailable', explanation: 'Try again in a moment. Nothing was changed.' }
  }
}

const backIcon = `<span class="xp-icon-back"><svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M15 6 9 12l6 6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`

const withContext = (href: string, model: StatusPageModel): string => {
  if (!href.startsWith('/')) return href
  const url = new URL(href, 'http://xpanel.invalid')
  if (!url.searchParams.has('lang')) url.searchParams.set('lang', model.locale)
  if (!url.searchParams.has('theme')) url.searchParams.set('theme', model.theme)
  if (!url.searchParams.has('density')) url.searchParams.set('density', model.density)
  if (model.accountId && url.pathname !== '/login' && !url.searchParams.has('accountId')) url.searchParams.set('accountId', model.accountId)
  return `${url.pathname}?${url.searchParams.toString()}`
}

const panelHref = (origin: string, model: StatusPageModel): string => {
  const url = new URL('/login', origin)
  url.searchParams.set('lang', model.locale)
  url.searchParams.set('theme', model.theme)
  return url.toString()
}

/** One bilingual status screen. Signed-in viewers get the shell; everyone else gets a standalone page. */
export function renderStatusBody(model: StatusPageModel): string {
  const copy = statusPageCopy(model.status, model.locale)
  const isAr = model.locale === 'ar'
  const panels = safePanelLinks(model.panels)
  const actions: string[] = []
  if (model.workspaceHref) {
    const label = isAr ? 'العودة إلى مساحة العمل' : 'Back to workspace'
    actions.push(`<a class="xp-btn xp-btn--primary xp-back-link" href="${escapeHtml(withContext(model.workspaceHref, model))}">${backIcon}<span>${escapeHtml(label)}</span></a>`)
  }
  if (model.retryHref && (model.status === 500 || model.status === 503)) {
    const label = isAr ? 'إعادة المحاولة' : 'Try again'
    actions.push(`<a class="xp-btn" href="${escapeHtml(model.retryHref)}">${escapeHtml(label)}</a>`)
  }
  const suggested = model.suggested && panels.find(panel => panel.surface === model.suggested)
  const listed = model.status === 421 ? panels : suggested ? [suggested] : []
  const panelActions = listed.map(panel => {
    const name = panelLabel(panel.surface)
    const label = isAr ? `افتح ${name}` : `Open ${name}`
    return `<a class="xp-btn${panel === suggested ? ' xp-btn--primary' : ''}" data-panel-link="${panel.surface}" href="${escapeHtml(panelHref(panel.origin, model))}">${escapeHtml(label)}</a>`
  }).join('')
  if (!model.signedIn && model.status !== 421 && !model.workspaceHref) {
    const label = isAr ? 'تسجيل الدخول' : 'Sign in'
    actions.push(`<a class="xp-btn xp-btn--primary" href="${escapeHtml(withContext('/login', model))}">${escapeHtml(label)}</a>`)
  }
  const support = model.status === 404 || model.status === 403 ? renderSupportNotice(model.locale, model.supportEmail) : ''
  const card = `<section class="xp-card xp-status-card" data-status-page="${model.status}" role="alert">
    <p class="xp-status-code" dir="ltr">${model.status}</p>
    <h1 class="xp-page-title">${escapeHtml(copy.title)}</h1>
    <p class="xp-prose">${escapeHtml(copy.explanation)}</p>
    ${support}
    <div class="xp-status-actions">${actions.join('')}${panelActions}</div>
  </section>`
  if (!model.visibility) {
    return `<div class="xp-status-standalone" data-surface="${model.surface}">
      <header class="xp-login-topbar" role="banner"><div class="xp-brand"><span class="xp-brand__mark" aria-hidden="true">x</span><span class="xp-brand__name" dir="ltr">${panelLabel(model.surface)}</span></div></header>
      <main id="main-content" class="xp-status-main" tabindex="-1">${card}</main>
    </div>`
  }
  const role = model.role ?? ''
  return renderSurfaceShell({
    surface: model.surface,
    locale: model.locale,
    sidebar: `<div class="xp-sidebar__brand"><span class="xp-brand__mark" aria-hidden="true">x</span><strong>${panelLabel(model.surface)}</strong></div>${renderPlannedNavigation(model.surface, model.locale, model.path, visibleNavigation(model.visibility, model.catalog))}`,
    topbar: renderUserMenu({
      locale: model.locale,
      theme: model.theme,
      density: model.density,
      surface: model.surface,
      path: model.path.startsWith('/') ? model.path : '/',
      ...(model.accountId ? { accountId: model.accountId } : {}),
      ...(model.username ? { username: model.username } : {}),
      ...(role ? { role } : {}),
      signedIn: model.signedIn === true,
    }),
    content: card,
  })
}

export function requestPrefersHtml(req: Request): boolean {
  return (req.headers.get('accept') ?? '').includes('text/html')
}

export function isStatusCode(value: number): value is StatusCode {
  return value === 403 || value === 404 || value === 421 || value === 500 || value === 503
}
