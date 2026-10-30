import { visibleNavigation, type CatalogTool, type VisibilityContext } from '@xpanel/catalog'
import { panelLabel, renderSupportNotice, renderUserMenu, type DensityChoice, type PanelId, type ThemeChoice } from './chrome.ts'
import { renderDesignNav } from './design-board.ts'
import { translator, type Locale } from './i18n.ts'
import { renderSurfaceShell } from './shell.ts'
import { escapeHtml } from './tokens.ts'
import { statusPageCopy, type StatusCode } from './models/status-page.ts'
export { statusPageCopy, type StatusCode } from './models/status-page.ts'

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
  /** Administrator text shown under the explanation, such as the offline-mode message. */
  notice?: string
  supportEmail?: string
  /** Host or primary domain shown under the brand, the same subtitle as the live shell. */
  hostname?: string
  visibility?: VisibilityContext
  /** Qualified catalog for this host. The sidebar keeps these sections as links. */
  catalog?: readonly CatalogTool[]
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

/** One status screen in the page language. It brands and links only the current panel. */
export function renderStatusBody(model: StatusPageModel): string {
  const copy = statusPageCopy(model.status, model.locale)
  const t = translator(model.locale)
  const actions: string[] = []
  if (model.workspaceHref) {
    const label = t('Back to workspace')
    actions.push(`<a class="xp-btn xp-btn--primary xp-back-link" href="${escapeHtml(withContext(model.workspaceHref, model))}">${backIcon}<span>${escapeHtml(label)}</span></a>`)
  }
  if (model.retryHref && (model.status === 500 || model.status === 503)) {
    const label = t('Try again')
    actions.push(`<a class="xp-btn" href="${escapeHtml(model.retryHref)}">${escapeHtml(label)}</a>`)
  }
  if (!model.signedIn && model.status !== 421 && !model.workspaceHref) {
    const label = t('Sign in')
    actions.push(`<a class="xp-btn xp-btn--primary" href="${escapeHtml(withContext('/login', model))}">${escapeHtml(label)}</a>`)
  }
  const support = model.status === 404 || model.status === 403 ? renderSupportNotice(model.locale, model.supportEmail) : ''
  const card = `<section class="xp-card xp-status-card" data-status-page="${model.status}" role="alert">
    <p class="xp-status-code" dir="ltr">${model.status}</p>
    <h1 class="xp-page-title">${escapeHtml(copy.title)}</h1>
    <p class="xp-prose">${escapeHtml(copy.explanation)}</p>${model.notice ? `
    <p class="xp-prose" data-status-notice>${escapeHtml(model.notice)}</p>` : ''}
    ${support}
    <div class="xp-status-actions">${actions.join('')}</div>
  </section>`
  if (!model.visibility) {
    return `<div class="xp-status-standalone" data-surface="${model.surface}">
      <header class="xp-login-topbar" role="banner"><div class="xp-brand"><span class="xp-brand__mark" aria-hidden="true">x</span><span class="xp-brand__name" dir="ltr">${panelLabel(model.surface)}</span></div></header>
      <main id="main-content" class="xp-status-main" tabindex="-1">${card}</main>
    </div>`
  }
  const role = model.role ?? ''
  const nav = visibleNavigation(model.visibility, model.catalog).find(item => item.surface === model.surface)
  const qualified = new Set((nav?.sections ?? []).flatMap(section => section.pages.map(page => page.route)))
  const subtitle = model.hostname
    ? `<div><bdi dir="ltr" class="xp-mono">${escapeHtml(model.hostname)}</bdi></div>`
    : ''
  return renderSurfaceShell({
    surface: model.surface,
    locale: model.locale,
    sidebar: `<div class="xp-sidebar__brand"><span class="xp-brand__mark" aria-hidden="true">x</span><div><strong>${panelLabel(model.surface)}</strong>${subtitle}</div></div>${renderDesignNav(model.surface, model.locale, model.path, qualified, model.visibility)}`,
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
  return value === 400 || value === 403 || value === 404 || value === 421 || value === 500 || value === 503
}
