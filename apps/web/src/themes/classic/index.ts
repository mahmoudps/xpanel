import { createHash } from 'node:crypto'
import { canonicalNavigationRoute } from '@xpanel/catalog'
import { panelLabel, renderSecurityNavLink, renderSupportNotice, renderUserMenu } from '../../chrome.ts'
import { HANDOFF_CONTROLS_CSS, renderImpersonationBanner } from '../../panel-handoff-controls.ts'
import { brandingHeadStyle, brandingRootAttributes, renderBrandingFooter } from '../../branding.ts'
import { translator, type Locale } from '../../i18n.ts'
import { renderStatusBody } from '../../status-page.ts'
import { renderDesignMain, renderDesignNav, renderDisabledScreen } from '../../design-board.ts'
import { renderAccountSecurityCard } from '../../surfaces/account-security.ts'
import { renderLoginSurface } from '../../surfaces/login.ts'
import { renderMailSurface, renderUnavailableMailBody } from '../../surfaces/xmail.ts'
import { renderPanelSurface } from '../../surfaces/xpanel.ts'
import { renderWhmSurface } from '../../surfaces/xwhm.ts'
import { renderUnavailableComposedRoute } from '../../board-port/composed/render.ts'
import { renderApprovedXpanelWorkspace } from '../../board-port/approved-xpanel-workspaces.ts'
import { renderWhmDetailPage } from '../../board-port/approved-xwhm.ts'
import { renderStoreExtension } from '../../board-port/extensions/store.ts'
import { renderCommandPaletteEntries } from '../../command-palette.ts'
import { renderSurfaceShell } from '../../shell.ts'
import { DESIGN_TOKENS_CSS, renderAsyncActionState, renderStatusBadge } from '../../tokens.ts'
import { escapeHtml } from '../../html.ts'
import { renderReconcileBanner, type LiveEventState } from '../../ws-client.ts'
import { loadThemeMessages } from '../../theme-messages.ts'
import type { DocumentProps, UiTheme, UnavailableProps, WorkspaceSummaryView, ThemeSurface } from '../contract.ts'

const renderWorkspaceSummary = (view: WorkspaceSummaryView | undefined, surface: ThemeSurface): string => {
  if (!view) return ''
  const field = (key: string, label: string, value: string, ltr = false) =>
    `<div class="xp-field" data-workspace-field="${key}"><span class="xp-label">${escapeHtml(label)}</span><strong class="xp-field-value">${ltr ? `<bdi dir="ltr">${escapeHtml(value)}</bdi>` : escapeHtml(value)}</strong></div>`
  const fields = view.fields.map(item => field(item.key, item.label, item.value, item.ltr)).join('')
  const emptyAccount = view.accountEmpty ? `<p class="xp-prose" data-workspace-account-empty="true">${view.accountEmptyText ?? ''}</p>` : ''
  const mfaLink = view.mfaHref ? `<p class="xp-prose" data-mfa-optional-link><a href="${escapeHtml(view.mfaHref)}">${escapeHtml(view.mfaText ?? '')}</a></p>` : ''
  return `<section class="xp-card" data-workspace-identity="true"${surface === 'xpanel' ? ' data-workspace-account-overview="true"' : ''} aria-labelledby="xp-workspace-summary-title">
    <h2 id="xp-workspace-summary-title">${view.title}</h2>
    <div class="xp-kpi-grid">${fields}</div>
    ${emptyAccount}
    ${mfaLink}
  </section>`
}

const renderUnavailable = (props: UnavailableProps): string => {
  const { surface: panelSurface, locale, theme, density, route: path, heading: pageHeading, securityPage, qualifiedRoutes } = props
  const principal = props.visibility?.principal
  const disabledRouteAttribute = panelSurface === 'xpanel' && path === '/domains/reverse-proxy'
    ? ' data-unqualified-route="/domains/reverse-proxy"' : ''
  const store = props.admitted && !securityPage && principal
    ? renderStoreExtension({ locale, route: path, principal, ...(props.storeAccount ? { account: props.storeAccount } : {}) }) : undefined
  const detailed = !securityPage && props.admitted
    ? store || (panelSurface === 'xpanel'
      ? renderApprovedXpanelWorkspace({ route: path, locale, readOnly: true })
      : panelSurface === 'xwhm'
        ? renderWhmDetailPage({ activeRoute: path, locale, capabilityUnavailable: true })
        : renderUnavailableMailBody({ route: path, locale, theme }))
    : undefined
  const canonicalPath = canonicalNavigationRoute(path)
  const composed = props.admitted && !securityPage && panelSurface !== 'xmail'
    ? renderUnavailableComposedRoute(panelSurface, path, locale) : undefined
  const design = securityPage ? '' : (detailed || composed || renderDesignMain(path, locale)
    || (canonicalPath !== path ? renderDesignMain(canonicalPath, locale) : '')
    || renderDisabledScreen(pageHeading, locale))
  return renderSurfaceShell({
    surface: panelSurface,
    locale,
    sidebar: `<div class="xp-sidebar__brand"><span class="xp-brand__mark" aria-hidden="true">x</span><strong>${panelLabel(panelSurface)}</strong></div>${renderDesignNav(panelSurface, locale, path, qualifiedRoutes, props.visibility)}${panelSurface === 'xmail' ? renderSecurityNavLink('xmail', locale, path) : ''}`,
    topbar: renderUserMenu({
      locale, theme, density, surface: panelSurface, path,
      ...(props.accountId ? { accountId: props.accountId } : {}),
      ...(props.session ? { username: props.session.username, role: props.session.role } : {}),
      signedIn: props.signedIn,
      themeChooserWritable: false,
    }),
    content: `<section class="xp-workspace-summary" data-surface="${panelSurface}" data-tool-availability="unverified"${disabledRouteAttribute}${securityPage ? ' data-security-page="true"' : ''}>
  ${securityPage ? `<h1 class="xp-page-title">${escapeHtml(pageHeading)}</h1>` : design || `<h1 class="xp-page-title">${escapeHtml(pageHeading)}</h1>`}
  ${props.actionState ? renderAsyncActionState({ ...props.actionState, locale }) : ''}
  ${securityPage ? '' : renderWorkspaceSummary(props.summary, panelSurface)}
  ${securityPage ? '' : renderSupportNotice(locale, props.supportEmail)}
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

const renderDocument = (props: DocumentProps): string => `<!doctype html>
<html ${props.htmlAttributes}${brandingRootAttributes(props.branding)}${props.htmlAttributeSuffix}>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(props.title)}</title>
  <link rel="icon"${props.faviconContentType ? ` type="${escapeHtml(props.faviconContentType)}"` : ''} href="${props.faviconHref}" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style id="xpanel-design-tokens">${DESIGN_TOKENS_CSS}</style>${brandingHeadStyle(props.branding)}
  ${props.headHtml}
</head>
<body>${props.bodyHtml}</body>
</html>`

export const classicTheme: UiTheme = Object.freeze<UiTheme>({
  id: 'classic',
  messages: loadThemeMessages('classic', new URL('./locales/', import.meta.url)),
  assets: Object.freeze([Object.freeze({
    path: '/assets/tokens.css' as const,
    href: `/assets/tokens.css?v=${createHash('sha256').update(DESIGN_TOKENS_CSS).digest('hex').slice(0, 16)}`,
    contentType: 'text/css; charset=utf-8',
    body: DESIGN_TOKENS_CSS,
  })]),
  renderDocument,
  renderLogin: renderLoginSurface,
  renderPanel: renderPanelSurface,
  renderWhm: renderWhmSurface,
  renderMail: renderMailSurface,
  renderStatus: renderStatusBody,
  renderUnavailable,
  slots: Object.freeze<UiTheme['slots']>({
    activityDrawer: ({ live, locale }) => renderActivityDrawer(live, locale),
    commandPalette: ({ surface, locale, entries }) => renderCommandPaletteEntries(surface, locale, entries),
    reconcileBanner: ({ live, locale }) => `<div class="xp-global-reconcile-wrap" style="padding: 12px var(--xp-space-card) 0;">${renderReconcileBanner(live, locale)}</div>`,
    accountSecurity: ({ bodyHtml, security }) => {
      const card = renderAccountSecurityCard(security)
      const afterTitle = bodyHtml.replace(/(<h1\b[^>]*\bclass="[^"]*\bxp-page-title\b[^"]*"[^>]*>[\s\S]*?<\/h1>)/, `$1\n${card}`)
      return afterTitle === bodyHtml ? bodyHtml.replace(/(<main\b[^>]*\bid="main-content"[^>]*>)/, `$1${card}`) : afterTitle
    },
    documentBody: props => {
      const impersonationHtml = props.impersonation ? renderImpersonationBanner(props.locale, props.impersonation) : ''
      return `
  ${impersonationHtml || props.handoffControls ? `<style id="xpanel-handoff-controls">${HANDOFF_CONTROLS_CSS}</style>` : ''}
  ${impersonationHtml}
  ${props.reconcileHtml}
  ${props.surfaceHtml}${renderBrandingFooter(props.branding, props.locale)}
  ${props.paletteHtml}
  ${props.activityHtml}
${props.clientScriptsHtml}`
    },
  }),
})
