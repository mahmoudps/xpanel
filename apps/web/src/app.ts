import { createHash } from 'node:crypto'
import { canOpenRegisteredRoute, canonicalNavigationRoute, visibleNavigation, type CatalogTool, type VisibilityContext } from '@xpanel/catalog'
import { canSeeAccount, type Account, type MfaRuntimeMode, type Plan } from '@xpanel/core'
import { panelLabel, renderSecurityNavLink, renderSupportNotice, renderUserMenu, roleLabel } from './chrome.ts'
import { HANDOFF_CLIENT_BINDING } from './panel-handoff-client.ts'
import { HANDOFF_CONTROLS_CSS, renderImpersonationBanner } from './panel-handoff-controls.ts'
import { formatDisplayName } from './display-name.ts'
import { brandingFaviconHref, brandingHeadStyle, brandingProductName, brandingRootAttributes, renderBrandingFooter, type WebBranding } from './branding.ts'
import { LOCALES, SOURCE_LOCALE, clientI18nAsset, inlineScriptMessageKeys, isLocale, localeDirection, renderClientI18nScript, requestLocale, requestedLocale, translator, type Locale } from './i18n.ts'
import { isStatusCode, renderStatusBody, statusPageCopy, type StatusPageModel } from './status-page.ts'
import { designHeading, renderDesignMain, renderDesignNav, renderDisabledScreen } from './design-board.ts'
import { ACCOUNT_SECURITY_ROUTES, renderAccountSecurityCard } from './surfaces/account-security.ts'
import { type LoginSurfaceProps, renderLoginSurface } from './surfaces/login.ts'
import { type MailSurfaceProps, renderMailSurface, renderUnavailableMailBody } from './surfaces/xmail.ts'
import { type PanelSurfaceProps, renderPanelSurface } from './surfaces/xpanel.ts'
import { renderWhmSurface, type WhmSurfaceProps } from './surfaces/xwhm.ts'
import { LOGIN_CLIENT_SCRIPT } from './login-client.ts'
import { TEAM_PASSWORD_CLIENT_BINDING } from './team-password.ts'
import { contextualizeDocumentLinks, resolveWebDocumentRoute } from './document-routes.ts'
import { composedRouteSpecs, nativeComposedRoutePaths } from './board-port/composed/all.ts'
import { renderUnavailableComposedRoute } from './board-port/composed/render.ts'
import { copyOf } from './board-port/composed/types.ts'
import { accountPageRouteSpecs } from './board-port/extensions/account-pages.ts'
import { renderApprovedXpanelWorkspace } from './board-port/approved-xpanel-workspaces.ts'
import { renderCommandPaletteModal } from './command-palette.ts'
import { renderWhmDetailPage } from './board-port/approved-xwhm.ts'
import { renderStoreExtension, storeRouteSpecs } from './board-port/extensions/store.ts'
import { getSurfacePageTitle, renderSurfaceShell, resolveSurfaceSection } from './shell.ts'
import { TERMINAL_EMULATOR_ASSETS } from './vendor/xterm.ts'
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
  mfaRuntimeMode?: MfaRuntimeMode
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
  /** A session opened through a one-time handoff: who acts, and who opened it. */
  impersonation?: { target: string; issuer: string }
  /** Saved server branding; absent when none is saved, which keeps the built-in identity. */
  branding?: WebBranding
}

const renderWorkspaceSummary = (state: WebAppRenderState, locale: Locale): string => {
  const principal = state.visibility?.principal
  if (!principal) return ''
  const field = (key: string, label: string, value: string, ltr = false) =>
    `<div class="xp-field" data-workspace-field="${key}"><span class="xp-label">${escapeHtml(label)}</span><strong class="xp-field-value">${ltr ? `<bdi dir="ltr">${escapeHtml(value)}</bdi>` : escapeHtml(value)}</strong></div>`
  const role = roleLabel(principal.kind, locale)
  const identityFields = field('username', translator(locale)('Username'), principal.username, true)
    + field('role', translator(locale)('Role'), role)
  const account = state.surface === 'xpanel' ? (state.workspaceSummary ? state.workspaceSummary.account : state.panel?.account) : undefined
  const plan = state.workspaceSummary ? state.workspaceSummary.plan : state.panel?.plan
  const authorized = account && canSeeAccount(principal, account)
  const accountFields = authorized
    ? (account.username === principal.username ? '' : field('account', translator(locale)('Selected account'), account.username, true))
      + field('primary-domain', translator(locale)('Primary domain'), account.primaryDomain, true)
      + field('plan', translator(locale)('Plan'), plan?.id === account.planId ? formatDisplayName(plan.name) : (translator(locale)(msgctxt('app', 'Unavailable'))))
      + field('status', translator(locale)('Status'), account.status === 'active' ? (translator(locale)('Active'))
        : account.status === 'suspended' ? (translator(locale)('Suspended')) : (translator(locale)('Terminating')))
    : ''
  const title = state.surface === 'xpanel' ? (translator(locale)('Account overview')) : (translator(locale)('Current session'))
  const emptyAccount = state.surface === 'xpanel' && !authorized
    ? `<p class="xp-prose" data-workspace-account-empty="true">${translator(locale)('No authorized account is available to display.')}</p>`
    : ''
  const mfaLink = state.mfaRuntimeMode !== 'disabled' && state.surface === 'xwhm' && principal.kind === 'root' && state.security?.totpEnabled === false && state.activeRoute !== '/whm/security/sign-in'
    ? `<p class="xp-prose" data-mfa-optional-link><a href="/whm/security/sign-in">${escapeHtml(translator(locale)('Two-factor authentication is off. You can enable it on the security page.'))}</a></p>`
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
  const titles: Record<string, string> = {
    '/whm/security/sign-in': msgid('Sign-in security'),
    '/security/account': msgid('Account security'),
    '/mail/settings/security': msgid('Mail security'),
  }
  const title = titles[route]
  return title ? translator(locale)(title) : undefined
}

export const workspacePageHeading = (surface: WebSurfaceKind, locale: Locale, activeRoute: string): string => {
  const security = securityPageHeading(activeRoute, locale)
  if (security) return security
  const design = designHeading(activeRoute, locale)
  if (design) return design
  const extension = [...accountPageRouteSpecs, ...storeRouteSpecs].find(row => row.surface === surface && row.route === activeRoute)
  if (extension) return copyOf(extension.title, locale)
  const composed = !nativeComposedRoutePaths.has(activeRoute) ? composedRouteSpecs.find(row => row.surface === surface && row.route === activeRoute) : undefined
  if (composed) return copyOf(composed.title, locale)
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
  const disabledRouteAttribute = panelSurface === 'xpanel' && path === '/domains/reverse-proxy'
    ? ' data-unqualified-route="/domains/reverse-proxy"' : ''
  const qualifiedRoutes = new Set((state?.visibility ? visibleNavigation(state.visibility, state.catalog) : []).filter(item => item.surface === panelSurface).flatMap(item => item.sections.flatMap(section => section.pages.map(page => page.route))))
  // A registered, role-admitted document keeps its detailed read-only layout.
  // Unqualified provider data is deliberately not forwarded to these renderers.
  const admitted = canOpenRegisteredRoute(path, state?.visibility)
  const storeAccount = state?.workspaceSummary ? state.workspaceSummary.account : state?.panel?.account
  const store = admitted && !securityPage && principal
    ? renderStoreExtension({ locale, route: path, principal,
      ...(storeAccount ? { account: { id: storeAccount.id, status: storeAccount.status } } : {}),
    }) : undefined
  const detailed = !securityPage && admitted
    ? store || (panelSurface === 'xpanel'
      ? renderApprovedXpanelWorkspace({ route: path, locale, readOnly: true })
      : panelSurface === 'xwhm'
        ? renderWhmDetailPage({ activeRoute: path, locale, capabilityUnavailable: true })
        : renderUnavailableMailBody({ route: path, locale, theme }))
    : undefined
  const canonicalPath = canonicalNavigationRoute(path)
  const composed = admitted && !securityPage && panelSurface !== 'xmail'
    ? renderUnavailableComposedRoute(panelSurface, path, locale) : undefined
  const design = securityPage ? '' : (detailed || composed || renderDesignMain(path, locale)
    || (canonicalPath !== path ? renderDesignMain(canonicalPath, locale) : '')
    || renderDisabledScreen(pageHeading, locale))
  return renderSurfaceShell({
    surface: panelSurface,
    locale,
    sidebar: `<div class="xp-sidebar__brand"><span class="xp-brand__mark" aria-hidden="true">x</span><strong>${panelLabel(panelSurface)}</strong></div>${renderDesignNav(panelSurface, locale, path, qualifiedRoutes, state?.visibility)}${panelSurface === 'xmail' ? renderSecurityNavLink('xmail', locale, path) : ''}`,
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
    content: `<section class="xp-workspace-summary" data-surface="${surface}" data-tool-availability="unverified"${disabledRouteAttribute}${securityPage ? ' data-security-page="true"' : ''}>
  ${securityPage ? `<h1 class="xp-page-title">${escapeHtml(pageHeading)}</h1>` : design || `<h1 class="xp-page-title">${escapeHtml(pageHeading)}</h1>`}
  ${actionState ? renderAsyncActionState({ ...actionState, locale }) : ''}
  ${state && !securityPage ? renderWorkspaceSummary(state, locale) : ''}
  ${securityPage ? '' : renderSupportNotice(locale, state?.supportEmail)}
  <div role="alert" data-auth-error hidden></div>
  <p role="status" data-auth-status></p>
</section>`,
  })
}

const renderActivityDrawer = (liveState: LiveEventState, locale: Locale): string => {
  return `
<div id="xp-activity-drawer" class="xp-drawer-backdrop" data-xp-drawer="activity" hidden role="dialog" aria-modal="true" aria-labelledby="xp-activity-drawer-title">
  <aside class="xp-drawer" tabindex="-1">
    <div class="xp-card__header">
      <h2 id="xp-activity-drawer-title">${escapeHtml(translator(locale)('Live Jobs & Reconcile Stream'))}</h2>
      <button type="button" class="xp-btn" data-action="close-activity-drawer">${escapeHtml(translator(locale)('Close (Esc)'))}</button>
      ${liveState.reconcile.generationId > 0 && liveState.reconcile.updatedAt !== null ? renderStatusBadge(liveState.reconcile.status === 'applied' ? 'ok' : 'warn', translator(locale)('Generation {generationId}', { generationId: liveState.reconcile.generationId })) : ''}
    </div>
    <p class="xp-prose">
      ${escapeHtml(
        translator(locale)('Streams RBAC-scoped events over RFC 6455 WebSocket (/api/ws): reconcile.stage, reconcile.applied, reconcile.failed, job.updated, and audit.entry.'),
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
  const locale: Locale = isLocale(state.locale) ? state.locale : SOURCE_LOCALE
  const dir = localeDirection(locale)
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
    xpanel: { brand: 'xPanel', title: msgid('Account sign in') },
    xwhm: { brand: 'xWHM', title: msgid('Server sign in') },
    xmail: { brand: 'xMail', title: msgid('Mail sign in') },
  }[loginAudience] : undefined
  const faviconHref = brandingFaviconHref(state.branding, loginAudience ? `/assets/favicon-${loginAudience}.svg` : '/assets/favicon.svg')

  let surfaceBodyHtml = ''
  const activeRoute = state.activeRoute ?? (state.surface === 'xwhm' ? '/whm' : state.surface === 'xmail' ? '/mail/inbox' : state.surface === 'login' ? '/login' : '/home')
  const securityPrincipal = state.visibility?.principal.kind
  const routeMatches = (pages: ReturnType<typeof visibleNavigation>): boolean =>
    pages.some(item => item.surface === state.surface && item.sections.some(section => section.pages.some(page => page.route === canonicalNavigationRoute(activeRoute))))
  let routeReady = routeMatches(visibleNavigation(state.visibility, state.catalog))
  // These persisted personal settings do not depend on host-native capability qualification.
  if (state.surface === 'xwhm' && activeRoute === '/whm/preferences' && (securityPrincipal === 'root' || securityPrincipal === 'reseller')) routeReady = true
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
    ? `${statusPageCopy(state.error.status, locale).title} — ${brandingProductName(state.branding, panelLabel(statusSurface))}`
    : loginIdentity
      ? `${brandingProductName(state.branding, loginIdentity.brand)} — ${translator(locale)(loginIdentity.title)}`
      : state.surface === 'login'
        ? `${translator(locale)('xPanel Sign In')} — ${translator(locale)('xPanel Control Plane')}`
        : `${pageHeading} — ${brandingProductName(state.branding, panelLabel(state.surface === 'xwhm' || state.surface === 'xmail' ? state.surface : 'xpanel'))}`)
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
    })
  } else if (state.surface !== 'login' && !hasVerifiedSurface)
    surfaceBodyHtml = renderUnavailableWorkspace(state.surface, locale, state.visibility !== undefined, state.actionState, activeRoute, theme, density, state)
  else switch (state.surface) {
    case 'login':
      surfaceBodyHtml = renderLoginSurface({
        locale,
        theme,
        ...(state.supportEmail ? { supportEmail: state.supportEmail } : {}),
        ...state.login,
        mfaMode: state.mfaRuntimeMode ?? 'optional',
      })
      break
    case 'xwhm':
      surfaceBodyHtml = renderWhmSurface({
        locale,
        theme,
        generationId,
        ...(state.actionState !== undefined && { actionState: state.actionState }),
        ...state.whm,
        density,
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
        density,
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
      mfaMode: state.mfaRuntimeMode ?? 'optional',
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

  const realtime = state.surface !== 'login' && !state.error
  const impersonationHtml = state.surface !== 'login' && state.impersonation ? renderImpersonationBanner(locale, state.impersonation) : ''
  const handoffControls = hasVerifiedSurface && (state.surface === 'xwhm' || state.surface === 'xpanel') && surfaceBodyHtml.includes('data-handoff=')
  const bodyHtml = `
  ${impersonationHtml || handoffControls ? `<style id="xpanel-handoff-controls">${HANDOFF_CONTROLS_CSS}</style>` : ''}
  ${impersonationHtml}
  ${reconcileBannerHtml}
  ${surfaceBodyHtml}${renderBrandingFooter(state.branding, locale)}
  ${hasVerifiedSurface ? contextualizeDocumentLinks(renderCommandPaletteModal(state.surface, locale, state.visibility, state.catalog,
    state.surface === 'xwhm' ? { accounts: state.whm?.accounts ?? [], domains: state.whm?.domains ?? [] }
      : state.surface === 'xpanel' ? { accounts: state.panel?.account ? [state.panel.account] : [], domains: state.panel?.domains ?? [] }
        : undefined), context) : ''}
  ${hasVerifiedSurface && state.liveState?.reconcile !== undefined ? renderActivityDrawer(fullLiveState, locale) : ''}
  <script id="xpanel-login-client">${LOGIN_CLIENT_SCRIPT}</script>
  ${state.surface === 'login' ? `<script id="xpanel-team-password-client">${TEAM_PASSWORD_CLIENT_BINDING}</script>` : ''}
  ${handoffControls ? `<script id="xpanel-handoff-client">(${HANDOFF_CLIENT_BINDING})()</script>` : ''}
  ${realtime ? `<script id="xpanel-i18n-realtime" src="/assets/i18n-${locale}.js?v=${I18N_ASSETS().version}"></script>
  <script id="xpanel-realtime-client" src="/assets/ws-client.js?v=${REALTIME_SCRIPT_VERSION}"></script>` : ''}
`

  return `<!doctype html>
<html lang="${locale}" dir="${dir}" data-theme="${theme}" data-density="${density}" data-surface="${state.error ? statusSurface : state.surface}" data-mfa-mode="${state.mfaRuntimeMode === 'disabled' ? 'disabled' : 'optional'}" data-realtime-enabled="${hasVerifiedSurface && state.realtimeEnabled !== false}"${brandingRootAttributes(state.branding)}${state.error && isStatusCode(state.error.status) ? ` data-status="${state.error.status}"` : ''}>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(pageTitle)}</title>
  <link rel="icon"${state.branding?.faviconUrl ? '' : ' type="image/svg+xml"'} href="${faviconHref}" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style id="xpanel-design-tokens">${DESIGN_TOKENS_CSS}</style>${brandingHeadStyle(state.branding)}
  ${renderClientI18nScript(locale, inlineScriptMessageKeys(bodyHtml))}
</head>
<body>${bodyHtml}</body>
</html>`
}

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="10" fill="#1D5BD6"/><text x="20" y="27" text-anchor="middle" fill="#FFFFFF" font-family="monospace" font-weight="700" font-size="22">x</text></svg>`

const LOGIN_FAVICONS = {
  xpanel: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="10" fill="#1D5BD6"/><g transform="translate(8 8)" fill="none" stroke="#FFFFFF" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3"/><path d="M5 20v-2a7 7 0 0 1 14 0v2"/></g></svg>',
  xwhm: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="10" fill="#101828"/><g transform="translate(8 8)" fill="none" stroke="#FFFFFF" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="7" rx="2"/><rect x="4" y="14" width="16" height="7" rx="2"/><path d="M8 6.5h.01M8 17.5h.01M12 6.5h5M12 17.5h5"/></g></svg>',
  xmail: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="10" fill="#087F5B"/><g transform="translate(8 8)" fill="none" stroke="#FFFFFF" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/></g></svg>',
}

// The shared realtime client is ~1.5 MB: serve it once as an immutable cached asset instead of inlining it in every page.
// A synchronous external script keeps the execution order of the former inline script.
const REALTIME_SCRIPT_VERSION = createHash('sha256').update(BROWSER_REALTIME_SCRIPT).digest('hex').slice(0, 16)

// The whole UI catalog per locale as an immutable cached asset; inline page scripts get their own subset in <head>.
// Built on first use, after panel start installed any uploaded catalogs; the version changes with their content.
let i18nAssets: { bodies: ReadonlyMap<Locale, string>; version: string } | undefined
const I18N_ASSETS = (): { bodies: ReadonlyMap<Locale, string>; version: string } => i18nAssets ??= (() => {
  const bodies = new Map(LOCALES.map(info => [info.tag, clientI18nAsset(info.tag)]))
  return { bodies, version: createHash('sha256').update([...bodies.values()].join('\n')).digest('hex').slice(0, 16) }
})()

const PUBLIC_STATIC_ASSETS: Readonly<Record<string, { body: string; contentType: string }>> = {
  ...TERMINAL_EMULATOR_ASSETS,
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
  const i18nTag = /^\/assets\/i18n-([A-Za-z0-9-]+)\.js$/.exec(pathname)?.[1]
  const i18nBody = i18nTag ? I18N_ASSETS().bodies.get(i18nTag as Locale) : undefined
  const asset = i18nBody !== undefined ? { body: i18nBody, contentType: 'application/javascript; charset=utf-8' }
    : Object.prototype.hasOwnProperty.call(PUBLIC_STATIC_ASSETS, pathname) ? PUBLIC_STATIC_ASSETS[pathname] : undefined
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

  // An explicit ?lang= wins, then a saved preference from the state provider, then Accept-Language.
  const explicitLocale = requestedLocale(url)
  const locale = requestLocale(url, req)
  const rawTheme = url.searchParams.get('theme')
  const theme: ThemeMode = rawTheme === 'dark' ? 'dark' : 'light'
  const rawDensity = url.searchParams.get('density')
  const density: TableDensity = rawDensity === 'compact' ? 'compact' : 'comfortable'
  const rawTarget = url.searchParams.get('target')
  const targetSurface = rawTarget === 'xwhm' || rawTarget === 'xmail' || rawTarget === 'xpanel' ? rawTarget : 'xpanel'

  const htmlHeaders = (language: Locale) => ({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-language': language,
    vary: 'Accept-Language',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'SAMEORIGIN',
  })
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
    return new Response(html, { status: 404, headers: htmlHeaders(locale) })
  }

  const baseState: WebAppRenderState = stateProvider
    ? await stateProvider(url, req)
    : {
        surface: inferredSurface,
        locale,
        theme,
        density,
      }

  const pageLocale = explicitLocale ?? baseState.locale ?? locale
  const html = renderWebApp({
    login: { targetSurface, ...baseState.login },
    ...baseState,
    locale: pageLocale,
    theme: rawTheme === null ? baseState.theme ?? theme : theme,
    density: rawDensity === null ? baseState.density ?? density : density,
    activeRoute: baseState.activeRoute ?? documentRoute?.activeRoute,
    accountId: baseState.accountId ?? (baseState.error ? undefined : url.searchParams.get('accountId') ?? undefined),
  })
  const status = baseState.error && isStatusCode(baseState.error.status) ? baseState.error.status : 200

  return new Response(html, { status, headers: htmlHeaders(pageLocale) })
}
