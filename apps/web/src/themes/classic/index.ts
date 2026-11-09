import { createHash } from 'node:crypto'
import { canonicalNavigationRoute } from '@xpanel/catalog'
import { panelLabel, renderSecurityNavLink, renderSupportNotice, renderUserMenu } from '../../chrome.ts'
import { HANDOFF_CONTROLS_CSS, renderImpersonationBanner, renderQualificationBanner, renderThemePreviewBanner } from '../../panel-handoff-controls.ts'
import { brandingHeadStyle, brandingRootAttributes, renderBrandingFooter } from '../../branding.ts'
import { translator, type Locale } from '../../i18n.ts'
import { renderStatusBody } from '../../status-page.ts'
import { renderDesignMain, renderDesignNav, renderDisabledScreen } from '../../design-board.ts'
import { renderAccountSecurityCard } from '../../surfaces/account-security.ts'
import { renderClassicIdentityCards } from '../../board-port/identity-workspaces.ts'
import { renderLoginSurface } from '../../surfaces/login.ts'
import { renderMailSurface, renderUnavailableMailBody } from '../../surfaces/xmail.ts'
import { renderPanelSurface } from '../../surfaces/xpanel.ts'
import { renderWhmSurface } from '../../surfaces/xwhm.ts'
import { renderUnavailableComposedRoute } from '../../board-port/composed/render.ts'
import { approvedXpanelWorkspaceRoutes, CLASSIC_ACCOUNT_SECURITY_FACTOR_HOST, renderClassicAccountSecurityWorkspace, renderApprovedXpanelWorkspace } from '../../board-port/approved-xpanel-workspaces.ts'
import { isHtmlElement, parseMarkup } from '../markup.ts'
import { renderWhmDetailPage } from '../../board-port/approved-xwhm.ts'
import { openFrameReads } from '../../read-only-frame.ts'
import { renderStoreExtension } from '../../board-port/extensions/store.ts'
import { renderCommandPaletteEntries } from '../../command-palette.ts'
import { renderSurfaceShell } from '../../shell.ts'
import { DESIGN_TOKENS_CSS, renderAsyncActionState, renderStatusBadge } from '../../tokens.ts'
import { escapeHtml } from '../../html.ts'
import { PLEX_FONTS_STYLESHEET_HREF } from '../../vendor/plex.ts'
import { renderReconcileBanner, type LiveEventState } from '../../ws-client.ts'
import { loadThemeMessages } from '../../theme-messages.ts'
import { projectReadOnlyMailSurface, projectReadOnlyPanelSurface, projectReadOnlyWhmSurface } from '../../models/theme-surface.ts'
import { URL as FileURL } from 'node:url'
import type { DocumentProps, ThemePackageTokens, UiTheme, UnavailableProps, WorkspaceSummaryView, ThemeSurface } from '../contract.ts'
import { CLASSIC_PROMPT_CSS, CLASSIC_PROMPT_TEMPLATE } from './prompt.ts'

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

const storedFacts = <T extends object, K extends keyof T>(source: T | undefined, keys: readonly K[]): Partial<Pick<T, K>> =>
  Object.fromEntries(source ? keys.flatMap(key => source[key] === undefined ? [] : [[key, source[key]]]) : []) as Partial<Pick<T, K>>

const renderUnavailable = (props: UnavailableProps): string => {
  const { surface: panelSurface, locale, theme, density, route: path, heading: pageHeading, securityPage, qualifiedRoutes } = props
  const principal = props.visibility?.principal
  const disabledRouteAttribute = panelSurface === 'xpanel' && path === '/domains/reverse-proxy'
    ? ' data-unqualified-route="/domains/reverse-proxy"' : ''
  // Core-scoped stored facts, projected exactly as V2 does: closed forms still show saved and default values.
  const context = { locale, theme, density, activeRoute: path, visibility: props.visibility, catalog: props.catalog }
  const facts = props.admitted && !securityPage ? props.readOnlyFacts : undefined
  // Only saved records travel; observations, audit and usage stay out of a read-only page.
  const panelFacts = facts?.surface === 'xpanel' && approvedXpanelWorkspaceRoutes.has(path)
    ? storedFacts(projectReadOnlyPanelSurface({ ...facts.panel, ...context })?.props, ['visibility', 'catalog', 'account', 'plan', 'domains', 'activeDomain', 'databases', 'databaseUsers', 'serviceUsers', 'certificates', 'dnsRecords']) : {}
  const whmFacts = facts?.surface === 'xwhm'
    ? storedFacts(projectReadOnlyWhmSurface({ ...facts.whm, ...context })?.props, ['principal', 'visibility', 'catalog', 'activeReseller', 'accounts', 'plans', 'domains', 'dnsZones', 'featureLists', 'planEditorState', 'resellers', 'ipPool', 'ipv6Ranges', 'aclLists', 'firewallRules', 'mailIpConfig', 'serverSettings', 'hostname']) : {}
  // The mailbox identity v2 shows, from the same projection: its frame readers read that mailbox only.
  const mailbox = facts?.surface === 'xmail' ? projectReadOnlyMailSurface({ ...facts.mail, ...context })?.props.mailbox ?? '' : ''
  const store = props.admitted && !securityPage && principal
    ? renderStoreExtension({ locale, route: path, principal, readOnly: true, ...(props.storeAccount ? { account: props.storeAccount } : {}) }) : undefined
  const detailed = !securityPage && props.admitted
    ? (store && (panelSurface === 'xpanel' || principal?.kind === 'root') ? openFrameReads(store) : store) || (panelSurface === 'xpanel'
      ? (html => html && openFrameReads(html))(renderApprovedXpanelWorkspace({ ...panelFacts, route: path, locale, readOnly: true }))
      : panelSurface === 'xwhm'
        ? renderWhmDetailPage({ ...whmFacts, activeRoute: path, locale, capabilityUnavailable: true })
        : (html => html && mailbox ? openFrameReads(html) : html)(renderUnavailableMailBody({ route: path, locale, theme, mailbox })))
    : undefined
  const canonicalPath = canonicalNavigationRoute(path)
  const composed = props.admitted && !securityPage && panelSurface === 'xpanel'
    ? renderUnavailableComposedRoute(path, locale) : undefined
  const design = securityPage ? '' : (detailed || composed || renderDesignMain(path, locale)
    || (canonicalPath !== path ? renderDesignMain(canonicalPath, locale) : '')
    || renderDisabledScreen(pageHeading, locale))
  const personalSecurity = props.admitted && panelSurface === 'xpanel' && path === '/security/account'
    ? renderClassicAccountSecurityWorkspace({ route: path, locale, readOnly: true, authPersonal: props.authPersonal }) : undefined
  return renderSurfaceShell({
    surface: panelSurface,
    locale,
    sidebar: `<div class="xp-sidebar__brand"><span class="xp-brand__mark" aria-hidden="true">x</span><strong>${panelLabel(panelSurface)}</strong></div>${renderDesignNav(panelSurface, locale, path, qualifiedRoutes, props.visibility)}${panelSurface === 'xmail' ? renderSecurityNavLink('xmail', locale, path) : ''}`,
    topbar: renderUserMenu({
      locale, theme, density, surface: panelSurface, path,
      ...(props.accountId ? { accountId: props.accountId } : {}),
      ...(props.session ? { username: props.session.username, role: props.session.role } : {}),
      signedIn: props.signedIn,
    }),
    content: personalSecurity === undefined ? `<section class="xp-workspace-summary" data-surface="${panelSurface}" data-tool-availability="unverified"${disabledRouteAttribute}${securityPage ? ' data-security-page="true"' : ''}>
  ${securityPage ? `<h1 class="xp-page-title">${escapeHtml(pageHeading)}</h1>` : design || `<h1 class="xp-page-title">${escapeHtml(pageHeading)}</h1>`}
  ${props.actionState ? renderAsyncActionState({ ...props.actionState, locale }) : ''}
  ${securityPage ? '' : renderWorkspaceSummary(props.summary, panelSurface)}
  ${securityPage ? '' : renderSupportNotice(locale, props.supportEmail)}
  <div role="alert" data-auth-error hidden></div>
  <p role="status" data-auth-status></p>
</section>` : `${personalSecurity}${props.actionState ? renderAsyncActionState({ ...props.actionState, locale }) : ''}`,
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
  <link href="${PLEX_FONTS_STYLESHEET_HREF}" rel="stylesheet" />
  <style id="xpanel-design-tokens">${DESIGN_TOKENS_CSS}</style><style id="xpanel-prompt-styles">${CLASSIC_PROMPT_CSS}</style>${brandingHeadStyle(props.branding)}
  ${props.headHtml}
</head>
<body>${props.bodyHtml}</body>
</html>`

export const classicTheme: UiTheme = Object.freeze<UiTheme>({
  id: 'classic',
  // Colors and radii an uploaded package may change; spacing, type and focus stay fixed by the standards.
  packageTokens: Object.freeze<ThemePackageTokens>({
    required: ['--xp-accent', '--xp-bg-canvas', '--xp-bg-surface', '--xp-text-primary'],
    optional: ['--xp-accent-hover', '--xp-accent-soft', '--xp-bg-elevated', '--xp-bg-subtle', '--xp-border', '--xp-border-strong', '--xp-text-secondary', '--xp-text-muted', '--xp-radius-sm', '--xp-radius-md'],
    radii: ['--xp-radius-sm', '--xp-radius-md'],
    contrast: [['--xp-text-primary', '--xp-bg-surface'], ['--xp-text-primary', '--xp-bg-canvas']],
    defaults: {
      light: { '--xp-accent': '#1d5bd6', '--xp-bg-canvas': '#f5f6f8', '--xp-bg-surface': '#ffffff', '--xp-text-primary': '#101828' },
      dark: { '--xp-accent': '#6ea0ff', '--xp-bg-canvas': '#0e1726', '--xp-bg-surface': '#152033', '--xp-text-primary': '#e6edf7' },
    },
  }),
  messages: loadThemeMessages('classic', new FileURL('./locales/', import.meta.url)),
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
      const card = renderAccountSecurityCard(security) + renderClassicIdentityCards(security)
      const nodes = parseMarkup(bodyHtml)
      const roots = nodes.flatMap((node, index) => node.attrs.has('data-auth-personal-security') ? [index] : [])
      const hosts = nodes.flatMap((node, index) => node.attrs.has('data-classic-account-security-factor-host') ? [index] : [])
      if (roots.length || hosts.length) {
        const root = roots[0], host = hosts[0]
        const owner = root === undefined ? undefined : nodes[root]
        const target = host === undefined ? undefined : nodes[host]
        let parent = host, inside = false, denied = false
        while (parent !== undefined && parent >= 0) {
          const node = nodes[parent]!
          if (parent === root) inside = true
          if (node.template >= 0 || node.attrs.has('hidden') || node.attrs.has('inert')
            || node.attrs.get('aria-hidden') === 'true' || node.attrs.get('aria-disabled') === 'true'
            || node.attrs.get('data-tool-availability') === 'unverified' || node.attrs.get('data-workspace-mode') === 'read-only'
            || isHtmlElement(node, 'fieldset') && node.attrs.has('disabled')) denied = true
          parent = node.parent
        }
        if (roots.length !== 1 || hosts.length !== 1 || !owner || !target
          || !isHtmlElement(owner, 'section') || owner.template >= 0
          || owner.attrs.get('data-approved-xpanel-workspace') !== '/security/account' || owner.attrs.get('data-surface') !== 'xpanel'
          || !isHtmlElement(target, 'div') || target.template >= 0 || !inside || denied
          || nodes.some(node => node.parent === host) || bodyHtml.split(CLASSIC_ACCOUNT_SECURITY_FACTOR_HOST).length !== 2
          || nodes.some(node => node.attrs.get('data-account-security') === 'two-factor')) throw new Error('classic_security_factor_host')
        const filled = bodyHtml.replace(CLASSIC_ACCOUNT_SECURITY_FACTOR_HOST, card)
        if (parseMarkup(filled).some(node => node.attrs.has('data-classic-account-security-factor-host'))) throw new Error('classic_security_factor_host')
        return filled
      }
      const afterTitle = bodyHtml.replace(/(<h1\b[^>]*\bclass="[^"]*\bxp-page-title\b[^"]*"[^>]*>[\s\S]*?<\/h1>)/, `$1\n${card}`)
      return afterTitle === bodyHtml ? bodyHtml.replace(/(<main\b[^>]*\bid="main-content"[^>]*>)/, `$1${card}`) : afterTitle
    },
    documentBody: props => {
      const impersonationHtml = props.impersonation ? renderImpersonationBanner(props.locale, props.impersonation) : ''
      const qualificationHtml = (props.qualificationMode ? renderQualificationBanner(props.locale) : '') + (props.themePreviewName ? renderThemePreviewBanner(props.locale, props.themePreviewName) : '')
      return `
  ${impersonationHtml || qualificationHtml || props.handoffControls ? `<style id="xpanel-handoff-controls">${HANDOFF_CONTROLS_CSS}</style>` : ''}
  ${qualificationHtml}
  ${impersonationHtml}
  ${props.reconcileHtml}
  ${props.surfaceHtml}${renderBrandingFooter(props.branding, props.locale)}
  ${props.paletteHtml}
  ${props.activityHtml}
  ${CLASSIC_PROMPT_TEMPLATE}
${props.clientScriptsHtml}`
    },
  }),
})
