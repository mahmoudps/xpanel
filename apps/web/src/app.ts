import { routeOpenTo, visibleNavigation, type CatalogTool, type VisibilityContext } from '@xpanel/catalog'
import { canSeeAccount, type Account, type Plan } from '@xpanel/core'
import { panelLabel, renderSecurityNavLink, renderSupportNotice, renderUserMenu, roleLabel, type PanelLink } from './chrome.ts'
import { formatDisplayName } from './display-name.ts'
import { dirForLocale, type Locale, SUPPORTED_LOCALES, t } from './i18n.ts'
import { isStatusCode, renderStatusBody, statusPageCopy, type StatusPageModel } from './status-page.ts'
import { designHeading, renderDesignMain, renderDesignNav, renderDisabledScreen } from './design-board.ts'
import { ACCOUNT_SECURITY_ROUTES, renderAccountSecurityCard } from './surfaces/account-security.ts'
import { type LoginSurfaceProps, renderLoginSurface } from './surfaces/login.ts'
import { type MailSurfaceProps, renderMailSurface } from './surfaces/xmail.ts'
import { type PanelSurfaceProps, renderPanelSurface } from './surfaces/xpanel.ts'
import { renderWhmSurface, type WhmSurfaceProps } from './surfaces/xwhm.ts'
import { LOGIN_CLIENT_SCRIPT } from './login-client.ts'
import { contextualizeDocumentLinks, resolveWebDocumentRoute } from './document-routes.ts'
import { getSurfaceNavigationLabel, getSurfacePageTitle, renderSurfaceShell, resolveSurfaceSection } from './shell.ts'
import {
  type AsyncActionBannerProps,
  DESIGN_TOKENS_CSS,
  ensureAccessibleSurfaceHtml,
  escapeHtml,
  renderAsyncActionState,
  renderStatusBadge,
} from './tokens.ts'
import {
  BROWSER_REALTIME_SCRIPT,
  createInitialLiveEventState,
  type LiveEventState,
  renderReconcileBanner,
} from './ws-client.ts'

export type WebSurfaceKind = 'login' | 'xwhm' | 'xpanel' | 'xmail'
export type ThemeMode = 'dark' | 'light'
export type TableDensity = 'comfortable' | 'compact'

/** Minimal read-only data used only while a route has no qualified tools. */
export interface WorkspaceSummary {
  account?: Pick<Account, 'id' | 'ownerId' | 'username' | 'primaryDomain' | 'status' | 'planId'>
  plan?: Pick<Plan, 'id' | 'name'>
}

export interface WebAppRenderState {
  surface: WebSurfaceKind
  visibility?: VisibilityContext
  workspaceSummary?: WorkspaceSummary
  catalog?: readonly CatalogTool[]
  locale?: Locale
  theme?: ThemeMode
  density?: TableDensity
  title?: string
  activeRoute?: string
  accountId?: string
  realtimeEnabled?: boolean
  generationId?: number
  liveState?: Partial<LiveEventState>
  actionState?: AsyncActionBannerProps
  login?: LoginSurfaceProps
  /** Present for an authenticated document. Enrollment stays optional when this is false. */
  security?: { totpEnabled: boolean }
  whm?: WhmSurfaceProps
  panel?: PanelSurfaceProps
  mail?: MailSurfaceProps
  /** Present only for an HTTP status screen. It does not invent a workspace. */
  error?: Omit<StatusPageModel, 'locale' | 'theme' | 'density' | 'surface' | 'path' | 'visibility'> & { surface?: StatusPageModel['surface'] }
  supportEmail?: string
  panels?: readonly PanelLink[]
}

const renderCommandPaletteModal = (
  surface: WebSurfaceKind,
  locale: Locale,
  visibility?: VisibilityContext,
  catalog?: readonly CatalogTool[],
): string => {
  const isAr = locale === 'ar'
  const navSurfaceId = surface === 'login' ? 'xpanel' : surface
  const navSurface = visibleNavigation(surface === 'login' ? undefined : visibility, catalog).find((n) => n.surface === navSurfaceId)
  const quickPages = (navSurface?.sections ?? []).flatMap((sec) =>
    sec.pages.map((page) => ({
      section: getSurfaceNavigationLabel(navSurfaceId, 'section', sec, locale),
      name: getSurfaceNavigationLabel(navSurfaceId, 'page', page, locale),
      route: page.route,
    })),
  )

  return `
<div id="xp-cmdk-modal" class="xp-modal-backdrop" data-xp-cmdk="true" hidden role="dialog" aria-modal="true" aria-labelledby="xp-cmdk-title">
  <div class="xp-cmdk-dialog">
    <div class="xp-card__header" style="padding: var(--xp-space-field) var(--xp-space-card); border-block-end: 1px solid var(--xp-border); margin-block-end: 0;">
      <strong id="xp-cmdk-title">${isAr ? 'الانتقال إلى صفحة' : 'Go to a page'}</strong>
      <button type="button" class="xp-btn" data-action="close-cmdk">${escapeHtml(t(locale, 'common.close'))}</button>
    </div>
    <div style="padding: var(--xp-space-field) var(--xp-space-card);">
      <label class="xp-sr-only" for="xp-cmdk-input">${isAr ? 'ابحث عن صفحة' : 'Find a page'}</label>
      <input
        id="xp-cmdk-input"
        type="search"
        class="xp-input"
        data-xp-filter-input="true"
        data-cmdk-search="true"
        role="combobox"
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-expanded="false"
        aria-controls="xp-cmdk-results"
        autocomplete="off"
        maxlength="160"
        placeholder="${isAr ? 'ابحث عن صفحة' : 'Find a page'}"
      />
      <ul id="xp-cmdk-results" class="xp-cmdk-results" data-cmdk-results role="listbox" aria-label="${isAr ? 'الصفحات' : 'Pages'}" style="list-style: none; margin: 12px 0 0; padding: 0; max-block-size: min(280px, 45dvh); overflow-y: auto; overscroll-behavior: contain; display: flex; flex-direction: column; gap: 6px;">
        ${quickPages
          .map(
            (item, index) => `
          <li data-cmdk-row role="presentation">
            <a id="xp-cmdk-option-${index}" href="${escapeHtml(item.route)}" class="xp-nav-item xp-cmdk-result" data-cmdk-item="${escapeHtml(item.route)}" data-cmdk-search-text="${escapeHtml(`${item.name} ${item.section} ${item.route}`)}" role="option" aria-selected="false" tabindex="-1">
              <strong>${escapeHtml(item.name)}</strong>
              <span class="xp-cmdk-result__section">— ${escapeHtml(item.section)}</span>
              <code class="xp-mono xp-cmdk-result__route"><bdi dir="ltr">${escapeHtml(item.route)}</bdi></code>
            </a>
          </li>
        `,
          )
          .join('')}
      </ul>
      <p data-cmdk-empty role="status"${quickPages.length ? ' hidden' : ''}>${isAr ? 'لا توجد صفحات مطابقة.' : 'No matching pages.'}</p>
      <p class="xp-sr-only" data-cmdk-status aria-live="polite" aria-atomic="true" data-count-label="${isAr ? 'النتائج' : 'Results'}"></p>
    </div>
  </div>
</div>
`.trim()
}

const renderWorkspaceSummary = (state: WebAppRenderState, locale: Locale): string => {
  const principal = state.visibility?.principal
  if (!principal) return ''
  const isAr = locale === 'ar'
  const field = (key: string, label: string, value: string, ltr = false) =>
    `<div class="xp-field" data-workspace-field="${key}"><span class="xp-label">${escapeHtml(label)}</span><strong class="xp-field-value">${ltr ? `<bdi dir="ltr">${escapeHtml(value)}</bdi>` : escapeHtml(value)}</strong></div>`
  const role = roleLabel(principal.kind, locale)
  const identityFields = field('username', isAr ? 'اسم المستخدم' : 'Username', principal.username, true)
    + field('role', isAr ? 'الدور' : 'Role', role)
  const account = state.surface === 'xpanel' ? (state.workspaceSummary ? state.workspaceSummary.account : state.panel?.account) : undefined
  const plan = state.workspaceSummary ? state.workspaceSummary.plan : state.panel?.plan
  const authorized = account && canSeeAccount(principal, account)
  const accountFields = authorized
    ? (account.username === principal.username ? '' : field('account', isAr ? 'الحساب المحدد' : 'Selected account', account.username, true))
      + field('primary-domain', isAr ? 'النطاق الأساسي' : 'Primary domain', account.primaryDomain, true)
      + field('plan', isAr ? 'الخطة' : 'Plan', plan?.id === account.planId ? formatDisplayName(plan.name) : (isAr ? 'غير متاحة' : 'Unavailable'))
      + field('status', isAr ? 'الحالة' : 'Status', account.status === 'active' ? (isAr ? 'نشط' : 'Active')
        : account.status === 'suspended' ? (isAr ? 'معلق' : 'Suspended') : (isAr ? 'قيد الإنهاء' : 'Terminating'))
    : ''
  const title = state.surface === 'xpanel' ? (isAr ? 'ملخص الحساب' : 'Account overview') : (isAr ? 'الجلسة الحالية' : 'Current session')
  const emptyAccount = state.surface === 'xpanel' && !authorized
    ? `<p class="xp-prose" data-workspace-account-empty="true">${isAr ? 'لا يتوفر حساب مصرح به لعرضه.' : 'No authorized account is available to display.'}</p>`
    : ''
  const mfaLink = state.surface === 'xwhm' && principal.kind === 'root' && state.security?.totpEnabled === false && state.activeRoute !== '/whm/security/sign-in'
    ? `<p class="xp-prose" data-mfa-optional-link><a href="/whm/security/sign-in">${escapeHtml(t(locale, 'security.2fa.workspaceLink'))}</a></p>`
    : ''
  return `<section class="xp-card" data-workspace-identity="true"${state.surface === 'xpanel' ? ' data-workspace-account-overview="true"' : ''} aria-labelledby="xp-workspace-summary-title">
    <h2 id="xp-workspace-summary-title">${title}</h2>
    <div class="xp-kpi-grid">${identityFields}${accountFields}</div>
    ${emptyAccount}
    ${mfaLink}
  </section>`
}

const workspacePath = (surface: WebSurfaceKind, activeRoute?: string): string =>
  activeRoute ?? (surface === 'xwhm' ? '/whm' : surface === 'xmail' ? '/mail/inbox' : '/home')

const securityPageHeading = (route: string, locale: Locale): string | undefined => {
  const titles: Record<string, readonly [string, string]> = {
    '/whm/security/sign-in': ['Sign-in security', 'أمان تسجيل الدخول'],
    '/security/account': ['Account security', 'أمان الحساب'],
    '/mail/settings/security': ['Mail security', 'أمان البريد'],
  }
  const pair = titles[route]
  return pair ? pair[locale === 'ar' ? 1 : 0] : undefined
}

export const workspacePageHeading = (surface: WebSurfaceKind, locale: Locale, activeRoute: string): string => {
  const security = securityPageHeading(activeRoute, locale)
  if (security) return security
  const design = designHeading(activeRoute, locale)
  if (design) return design
  const panel = surface === 'xwhm' || surface === 'xmail' ? surface : 'xpanel'
  return getSurfacePageTitle(panel, resolveSurfaceSection(panel, activeRoute), locale, activeRoute)
}

const renderUnavailableWorkspace = (
  surface: WebSurfaceKind,
  locale: Locale,
  authenticated: boolean,
  actionState?: AsyncActionBannerProps,
  activeRoute?: string,
  theme: ThemeMode = 'light',
  density: TableDensity = 'comfortable',
  state?: WebAppRenderState,
): string => {
  const panelSurface = surface === 'xwhm' || surface === 'xmail' ? surface : 'xpanel'
  const path = workspacePath(surface, activeRoute)
  const principal = state?.visibility?.principal
  const pageHeading = workspacePageHeading(surface, locale, path)
  const securityPage = ACCOUNT_SECURITY_ROUTES.has(path)
  const qualifiedRoutes = new Set((state?.visibility ? visibleNavigation(state.visibility, state.catalog) : []).filter(item => item.surface === panelSurface).flatMap(item => item.sections.flatMap(section => section.pages.map(page => page.route))))
  const visibility = state?.visibility
  const openRoute = panelSurface === 'xwhm' && visibility ? (route: string) => routeOpenTo(route, visibility) : undefined
  const design = securityPage ? '' : (renderDesignMain(path, locale) || renderDisabledScreen(pageHeading, locale))
  return renderSurfaceShell({
    surface: panelSurface,
    locale,
    sidebar: `<div class="xp-sidebar__brand"><span class="xp-brand__mark" aria-hidden="true">x</span><strong>${panelLabel(panelSurface)}</strong></div>${renderDesignNav(panelSurface, locale, path, qualifiedRoutes, openRoute)}${panelSurface === 'xmail' ? renderSecurityNavLink('xmail', locale, path) : ''}`,
    topbar: renderUserMenu({
      locale,
      theme,
      density,
      surface: panelSurface,
      path,
      ...(state?.accountId ? { accountId: state.accountId } : {}),
      ...(principal ? { username: principal.username, role: roleLabel(principal.kind, locale) } : {}),
      signedIn: authenticated && principal !== undefined,
    }),
    content: `<section class="xp-workspace-summary" data-surface="${surface}" data-tool-availability="unverified"${securityPage ? ' data-security-page="true"' : ''}>
  ${securityPage ? `<h1 class="xp-page-title">${escapeHtml(pageHeading)}</h1>` : design}
  ${actionState ? renderAsyncActionState({ ...actionState, locale }) : ''}
  ${state && !securityPage ? renderWorkspaceSummary(state, locale) : ''}
  ${securityPage ? '' : renderSupportNotice(locale, state?.supportEmail)}
  <div role="alert" data-auth-error hidden></div>
  <p role="status" data-auth-status></p>
</section>`,
  })
}

const renderActivityDrawer = (liveState: LiveEventState, locale: Locale): string => {
  const isAr = locale === 'ar'
  return `
<div id="xp-activity-drawer" class="xp-drawer-backdrop" data-xp-drawer="activity" hidden role="dialog" aria-modal="true" aria-labelledby="xp-activity-drawer-title">
  <aside class="xp-drawer" tabindex="-1">
    <div class="xp-card__header">
      <h2 id="xp-activity-drawer-title">${escapeHtml(isAr ? 'البث المباشر للمهام وسجل التدقيق' : 'Live Jobs & Reconcile Stream')}</h2>
      <button type="button" class="xp-btn" data-action="close-activity-drawer">${escapeHtml(t(locale, 'common.close'))}</button>
      ${liveState.reconcile.generationId > 0 && liveState.reconcile.updatedAt !== null ? renderStatusBadge(liveState.reconcile.status === 'applied' ? 'ok' : 'warn', `Gen #${liveState.reconcile.generationId}`) : ''}
    </div>
    <p class="xp-prose">
      ${escapeHtml(
        isAr
          ? 'يستقبل هذا الدرج تحديثات فورية عبر WebSocket (/api/ws) لجميع عمليات المطابقة والمهام الخلفية.'
          : 'Streams RBAC-scoped events over RFC 6455 WebSocket (/api/ws): reconcile.stage, reconcile.applied, reconcile.failed, job.updated, and audit.entry.',
      )}
    </p>
  </aside>
</div>
`.trim()
}

/**
 * Renders the complete, self-contained HTML5 document for any xPanel surface (`login`, `xwhm`, `xpanel`, `xmail`)
 * with bilingual LTR/RTL support (`en` / `ar`), light and navy-ink dark themes, live reconcile pipeline banner,
 * Command Palette (`Cmd/Ctrl+K`), and the embedded WebSocket client script.
 */
export function renderWebApp(state: WebAppRenderState): string {
  const locale: Locale = state.locale && SUPPORTED_LOCALES.includes(state.locale) ? state.locale : 'en'
  const dir = dirForLocale(locale)
  const theme: ThemeMode = state.theme === 'dark' ? 'dark' : 'light'
  const density: TableDensity = state.density === 'compact' ? 'compact' : 'comfortable'
  const generationId = state.generationId ?? state.liveState?.reconcile?.generationId ?? 0

  const defaultLive = createInitialLiveEventState()
  const fullLiveState: LiveEventState = {
    ...defaultLive,
    ...state.liveState,
    reconcile: {
      ...defaultLive.reconcile,
      generationId,
      ...(state.liveState?.reconcile ?? {}),
    },
  }

  const loginAudience = state.surface === 'login' && (state.login?.audience === 'xpanel' || state.login?.audience === 'xwhm' || state.login?.audience === 'xmail') ? state.login.audience : undefined
  const loginIdentity = loginAudience ? {
    xpanel: { brand: 'xPanel', en: 'Account sign in', ar: 'دخول الحساب' },
    xwhm: { brand: 'xWHM', en: 'Server sign in', ar: 'دخول إدارة الخادم' },
    xmail: { brand: 'xMail', en: 'Mail sign in', ar: 'دخول البريد' },
  }[loginAudience] : undefined
  const faviconHref = loginAudience ? `/assets/favicon-${loginAudience}.svg` : '/assets/favicon.svg'

  let surfaceBodyHtml = ''
  const activeRoute = state.activeRoute ?? (state.surface === 'xwhm' ? '/whm' : state.surface === 'xmail' ? '/mail/inbox' : state.surface === 'login' ? '/login' : '/home')
  const securityPrincipal = state.visibility?.principal.kind
  const routeMatches = (pages: ReturnType<typeof visibleNavigation>): boolean =>
    pages.some(item => item.surface === state.surface && item.sections.some(section => section.pages.some(page => page.route === activeRoute)))
  let routeReady = routeMatches(visibleNavigation(state.visibility, state.catalog))
  const sessionPrincipal = state.visibility?.principal
  const accountRecordReady = sessionPrincipal?.kind === 'user'
    && state.panel?.account?.status === 'active'
    && state.panel.account.id === sessionPrincipal.accountId
  // Home can open from an account id alone. That shortcut stays on the unavailable
  // summary until the account record is loaded, unless the catalog itself qualifies Home.
  if (routeReady && state.surface === 'xpanel' && activeRoute === '/home' && !accountRecordReady && sessionPrincipal?.kind === 'user' && state.visibility) {
    routeReady = routeMatches(visibleNavigation(
      { ...state.visibility, principal: { ...sessionPrincipal, accountId: '' } },
      state.catalog,
    ))
  }
  const hasVerifiedSurface = !state.error && routeReady
  const statusSurface = state.error?.surface ?? (state.surface === 'xwhm' || state.surface === 'xmail' ? state.surface : 'xpanel')
  const pageHeading = workspacePageHeading(state.surface, locale, activeRoute)
  const pageTitle = state.title ?? (state.error && isStatusCode(state.error.status)
    ? `${statusPageCopy(state.error.status, locale).title} — ${panelLabel(statusSurface)}`
    : loginIdentity
      ? `${loginIdentity.brand} — ${loginIdentity[locale]}`
      : state.surface === 'login'
        ? `${t(locale, 'surface.login')} — ${t(locale, 'app.title')}`
        : `${pageHeading} — ${panelLabel(state.surface === 'xwhm' || state.surface === 'xmail' ? state.surface : 'xpanel')}`)
  if (state.error && isStatusCode(state.error.status)) {
    const principal = state.visibility?.principal
    surfaceBodyHtml = renderStatusBody({
      ...state.error,
      status: state.error.status,
      locale,
      theme,
      density,
      surface: statusSurface,
      path: activeRoute,
      ...(state.visibility ? { visibility: state.visibility } : {}),
      ...(state.catalog ? { catalog: state.catalog } : {}),
      ...(principal ? { username: principal.username, role: roleLabel(principal.kind, locale), signedIn: true } : {}),
      ...(state.accountId ? { accountId: state.accountId } : {}),
      ...(state.supportEmail ? { supportEmail: state.supportEmail } : {}),
      ...(state.panels ? { panels: state.panels } : {}),
    })
  } else if (state.surface !== 'login' && !hasVerifiedSurface)
    surfaceBodyHtml = renderUnavailableWorkspace(state.surface, locale, state.visibility !== undefined, state.actionState, activeRoute, theme, density, state)
  else switch (state.surface) {
    case 'login':
      surfaceBodyHtml = renderLoginSurface({
        locale,
        theme,
        ...(state.panels ? { panels: state.panels } : {}),
        ...(state.supportEmail ? { supportEmail: state.supportEmail } : {}),
        ...state.login,
      })
      break
    case 'xwhm':
      surfaceBodyHtml = renderWhmSurface({
        locale,
        theme,
        generationId,
        ...(state.actionState !== undefined && { actionState: state.actionState }),
        ...state.whm,
        realtimeEnabled: hasVerifiedSurface && state.realtimeEnabled !== false,
        activeRoute,
        ...(state.catalog ? { catalog: state.catalog } : {}),
        visibility: state.visibility,
      })
      break
    case 'xpanel':
      surfaceBodyHtml = renderPanelSurface({
        locale,
        theme,
        generationId,
        ...(state.actionState !== undefined && { actionState: state.actionState }),
        ...state.panel,
        realtimeEnabled: hasVerifiedSurface && state.realtimeEnabled !== false,
        activeRoute,
        ...(state.catalog ? { catalog: state.catalog } : {}),
        visibility: state.visibility,
      })
      break
    case 'xmail':
      surfaceBodyHtml = renderMailSurface({
        locale,
        theme,
        generationId,
        ...(state.actionState !== undefined && { actionState: state.actionState }),
        ...state.mail,
        realtimeEnabled: hasVerifiedSurface && state.realtimeEnabled !== false,
        activeRoute,
        ...(state.catalog ? { catalog: state.catalog } : {}),
        visibility: state.visibility,
      })
      break
  }

  if (state.surface !== 'login' && state.security && securityPrincipal && ACCOUNT_SECURITY_ROUTES.has(activeRoute)) {
    const card = renderAccountSecurityCard({
      locale,
      totpEnabled: state.security.totpEnabled,
      principalKind: securityPrincipal,
      surface: state.surface,
    })
    const afterTitle = surfaceBodyHtml.replace(/(<h1\b[^>]*\bclass="[^"]*\bxp-page-title\b[^"]*"[^>]*>[\s\S]*?<\/h1>)/, `$1\n${card}`)
    surfaceBodyHtml = afterTitle === surfaceBodyHtml
      ? surfaceBodyHtml.replace(/(<main\b[^>]*\bid="main-content"[^>]*>)/, `$1${card}`)
      : afterTitle
  }

  surfaceBodyHtml = ensureAccessibleSurfaceHtml(surfaceBodyHtml, locale)
  const context = { locale, theme, density, activeRoute, ...(state.accountId ? { accountId: state.accountId } : {}) }
  surfaceBodyHtml = contextualizeDocumentLinks(surfaceBodyHtml, context)

  const reconcileBannerHtml =
    state.surface !== 'login' && hasVerifiedSurface && state.liveState?.reconcile !== undefined
      ? `<div class="xp-global-reconcile-wrap" style="padding: 12px var(--xp-space-card) 0;">${renderReconcileBanner(fullLiveState, locale)}</div>`
      : ''

  return `<!doctype html>
<html lang="${locale}" dir="${dir}" data-theme="${theme}" data-density="${density}" data-surface="${state.error ? statusSurface : state.surface}" data-realtime-enabled="${hasVerifiedSurface && state.realtimeEnabled !== false}"${state.error && isStatusCode(state.error.status) ? ` data-status="${state.error.status}"` : ''}>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(pageTitle)}</title>
  <link rel="icon" type="image/svg+xml" href="${faviconHref}" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style id="xpanel-design-tokens">${DESIGN_TOKENS_CSS}</style>
</head>
<body>
  ${reconcileBannerHtml}
  ${surfaceBodyHtml}
  ${hasVerifiedSurface ? contextualizeDocumentLinks(renderCommandPaletteModal(state.surface, locale, state.visibility, state.catalog), context) : ''}
  ${hasVerifiedSurface && state.liveState?.reconcile !== undefined ? renderActivityDrawer(fullLiveState, locale) : ''}
  <script id="xpanel-login-client">${LOGIN_CLIENT_SCRIPT}</script>
  ${state.surface !== 'login' && !state.error ? `<script id="xpanel-realtime-client">${BROWSER_REALTIME_SCRIPT}</script>` : ''}
</body>
</html>`
}

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="10" fill="#1D5BD6"/><text x="20" y="27" text-anchor="middle" fill="#FFFFFF" font-family="monospace" font-weight="700" font-size="22">x</text></svg>`

const LOGIN_FAVICONS = {
  xpanel: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="10" fill="#1D5BD6"/><g transform="translate(8 8)" fill="none" stroke="#FFFFFF" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3"/><path d="M5 20v-2a7 7 0 0 1 14 0v2"/></g></svg>',
  xwhm: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="10" fill="#101828"/><g transform="translate(8 8)" fill="none" stroke="#FFFFFF" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="7" rx="2"/><rect x="4" y="14" width="16" height="7" rx="2"/><path d="M8 6.5h.01M8 17.5h.01M12 6.5h5M12 17.5h5"/></g></svg>',
  xmail: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="10" fill="#087F5B"/><g transform="translate(8 8)" fill="none" stroke="#FFFFFF" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/></g></svg>',
}

const PUBLIC_STATIC_ASSETS: Readonly<Record<string, { body: string; contentType: string }>> = {
  '/assets/favicon-xpanel.svg': { body: LOGIN_FAVICONS.xpanel, contentType: 'image/svg+xml; charset=utf-8' },
  '/assets/favicon-xwhm.svg': { body: LOGIN_FAVICONS.xwhm, contentType: 'image/svg+xml; charset=utf-8' },
  '/assets/favicon-xmail.svg': { body: LOGIN_FAVICONS.xmail, contentType: 'image/svg+xml; charset=utf-8' },
  '/favicon.ico': {
    body: FAVICON_SVG,
    contentType: 'image/svg+xml; charset=utf-8',
  },
  '/assets/favicon.svg': {
    body: FAVICON_SVG,
    contentType: 'image/svg+xml; charset=utf-8',
  },
  '/assets/login.js': {
    body: LOGIN_CLIENT_SCRIPT,
    contentType: 'application/javascript; charset=utf-8',
  },
  '/assets/login-client.js': {
    body: LOGIN_CLIENT_SCRIPT,
    contentType: 'application/javascript; charset=utf-8',
  },
  '/assets/ws.js': {
    body: BROWSER_REALTIME_SCRIPT,
    contentType: 'application/javascript; charset=utf-8',
  },
  '/assets/ws-client.js': {
    body: BROWSER_REALTIME_SCRIPT,
    contentType: 'application/javascript; charset=utf-8',
  },
  '/assets/tokens.css': {
    body: DESIGN_TOKENS_CSS,
    contentType: 'text/css; charset=utf-8',
  },
}

/**
 * Serves immutable public client assets under `/assets/*` with zero tenant state,
 * or returns `404` for unknown/traversal `/assets/*` paths. Returns `null` for non-asset routes.
 */
export function serveStaticAsset(pathname: string): Response | null {
  if (pathname !== '/favicon.ico' && pathname !== '/assets' && !pathname.startsWith('/assets/')) return null
  const asset = Object.prototype.hasOwnProperty.call(PUBLIC_STATIC_ASSETS, pathname)
    ? PUBLIC_STATIC_ASSETS[pathname]
    : undefined
  if (!asset) {
    return new Response('Not Found', {
      status: 404,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    })
  }
  return new Response(asset.body, {
    status: 200,
    headers: {
      'content-type': asset.contentType,
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'SAMEORIGIN',
    },
  })
}

/**
 * Resolves the requested surface, locale, and theme from an incoming HTTP `Request` URL
 * and returns a standard `Response` containing the rendered HTML5 application.
 */
export async function serveWebUi(
  req: Request,
  stateProvider?: (url: URL, req: Request) => Promise<WebAppRenderState> | WebAppRenderState,
): Promise<Response> {
  const url = new URL(req.url, 'http://localhost')
  const assetResponse = serveStaticAsset(url.pathname)
  if (assetResponse) return assetResponse
  const rawSurface = url.searchParams.get('surface')
  const path = url.pathname
  const documentRoute = resolveWebDocumentRoute(path)

  let inferredSurface: WebSurfaceKind = 'xpanel'
  if (rawSurface === 'login' || rawSurface === 'xwhm' || rawSurface === 'xpanel' || rawSurface === 'xmail') {
    inferredSurface = rawSurface
  } else if (path.startsWith('/login')) {
    inferredSurface = 'login'
  } else if (path.startsWith('/whm')) {
    inferredSurface = 'xwhm'
  } else if (path.startsWith('/mail')) {
    inferredSurface = 'xmail'
  }

  const rawLang = url.searchParams.get('lang')
  const locale: Locale = rawLang === 'ar' ? 'ar' : 'en'
  const rawTheme = url.searchParams.get('theme')
  const theme: ThemeMode = rawTheme === 'dark' ? 'dark' : 'light'
  const rawDensity = url.searchParams.get('density')
  const density: TableDensity = rawDensity === 'compact' ? 'compact' : 'comfortable'
  const rawTarget = url.searchParams.get('target')
  const targetSurface = rawTarget === 'xwhm' || rawTarget === 'xmail' || rawTarget === 'xpanel' ? rawTarget : 'xpanel'

  const htmlHeaders = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'SAMEORIGIN',
  }
  if (!stateProvider && !documentRoute) {
    const fallbackSurface = inferredSurface === 'xwhm' || inferredSurface === 'xmail' ? inferredSurface : 'xpanel'
    const html = renderWebApp({
      surface: fallbackSurface,
      locale,
      theme,
      density,
      activeRoute: path,
      error: { status: 404, surface: fallbackSurface },
    })
    return new Response(html, { status: 404, headers: htmlHeaders })
  }

  const baseState: WebAppRenderState = stateProvider
    ? await stateProvider(url, req)
    : {
        surface: inferredSurface,
        locale,
        theme,
        density,
      }

  const html = renderWebApp({
    locale,
    theme,
    density,
    login: { targetSurface, ...baseState.login },
    ...baseState,
    activeRoute: baseState.activeRoute ?? documentRoute?.activeRoute,
    accountId: baseState.accountId ?? (baseState.error ? undefined : url.searchParams.get('accountId') ?? undefined),
  })
  const status = baseState.error && isStatusCode(baseState.error.status) ? baseState.error.status : 200

  return new Response(html, { status, headers: htmlHeaders })
}
