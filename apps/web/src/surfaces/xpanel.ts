import { visibleNavigation, type CatalogTool, type VisibilityContext } from '@xpanel/catalog'
import { renderAccountAnnouncementsBanner } from '../board-port/account-announcements-banner.ts'
import type {
  Account,
  Database,
  DatabaseUser,
  DnsRecord,
  Domain,
  DomainCustomConfig,
  Plan,
  ServiceUser,
  WebsiteAnalyticsSnapshot,
  Certificate,
} from '@xpanel/core'
import { parseWebsiteAnalyticsSnapshot, renderWebsiteAnalyticsChart, type WebsiteAnalyticsWindow } from '../charts.ts'
import { auditActionLabel, auditTargetLabel } from '../audit-labels.ts'
import { formatDisplayName } from '../display-name.ts'
import { localeDirection, translator, type Locale } from '../i18n.ts'
import {
  type AsyncActionBannerProps,
  ensureAccessibleSurfaceHtml,
  escapeHtml,
  formatAsciiDate,
  formatDisplayDateTime,
  formatBytes,
  renderAsyncActionState,
  renderStatusBadge,
} from '../tokens.ts'
import { renderAccountResources, resourceRowsFromPlan } from '../board-canvas.ts'
import { renderXpanelHome, xpanelHomeFromProps } from '../board-port/xpanel-home.ts'
import { renderDesignMain, renderDesignNav } from '../design-board.ts'
import { renderApprovedXpanelWorkspace } from '../board-port/approved-xpanel-workspaces.ts'
import { renderComposedXpanel } from '../board-port/composed/render.ts'
import { composedRouteSpecs } from '../board-port/composed/all.ts'
import { copyOf } from '../board-port/composed/types.ts'
import { renderEmailAccountsExtension, emailAccountsRouteSpec } from '../board-port/extensions/email-accounts.ts'
import { renderAccountPagesExtension, accountPageRouteSpecs } from '../board-port/extensions/account-pages.ts'
import { renderStoreExtension, storeRouteSpecs } from '../board-port/extensions/store.ts'
import { renderResourcesBoard } from '../board-port/extensions/resources-board.ts'
import { renderAccountDomains } from '../board-port/extensions/account-domains.ts'
import { renderAccountDatabases } from '../board-port/extensions/account-databases.ts'
import { renderSurfaceShell, renderSurfaceUnavailable, resolveSurfaceSection, renderUnavailableSurfaceShell, getSurfacePageTitle, normalizeSurfaceRoute, renderPageSearchButton, renderSurfaceToolbarEnd } from '../shell.ts'


export interface JailedFileEntry {
  name: string
  path: string
  kind: 'file' | 'folder'
  sizeBytes: number
  modeOctal: string
  modifiedAt: string
  trashed?: boolean
}

export interface PanelSurfaceProps {
  visibility?: VisibilityContext
  catalog?: readonly CatalogTool[]
  locale?: Locale
  theme?: 'dark' | 'light'
  density?: 'comfortable' | 'compact'
  realtimeEnabled?: boolean
  account?: Account
  plan?: Plan
  activeRoute?: string
  activeDomain?: string
  generationId?: number
  domains?: Domain[]
  customConfig?: DomainCustomConfig
  websiteAnalytics?: WebsiteAnalyticsSnapshot
  /** The traffic window the supplied analytics observation was read for. */
  websiteAnalyticsWindow?: WebsiteAnalyticsWindow
  /** The account-scoped traffic read failed or was unavailable; no empty result is assumed. */
  websiteAnalyticsUnavailable?: boolean
  /** Account certificates read from stored state; served TLS is never inferred from them. */
  certificates?: Certificate[]
  files?: JailedFileEntry[]
  databases?: Database[]
  databaseUsers?: Pick<DatabaseUser, 'id' | 'name' | 'grants'>[]
  serviceUsers?: ServiceUser[]
  dnsRecords?: DnsRecord[]
  lastSignInAt?: string
  recentAudit?: Array<{ action: string; target: string; actor?: string; detail?: Record<string, unknown> }>
  usage?: {
    phpVersion: string | null
    diskBytes: number | null
    memoryBytes: number | null
    processCount: number | null
    bandwidth: 'unmeasured'
    ioEnforced?: boolean | null
  }
  terminalSessionId?: string
  actionState?: AsyncActionBannerProps
}

const ALLOWLISTED_SHELL_BINARIES = [
  'php',
  'composer',
  'wp',
  'git',
  'node',
  'npm',
  'python3',
  'tar',
  'gzip',
  'mysql',
  'mysqldump',
] as const

/**
 * Account resources. Measured agent observations are rendered by the reading board,
 * which keeps stored plan limits distinct from observations. The stored-plan board is
 * retained only while no observation exists, where it states that measurement is
 * unavailable instead of leaving a stale "not available yet" notice beside readings.
 */
const renderResourcesSection = (
  props: PanelSurfaceProps,
  args: { locale: Locale; account: Account; plan?: Plan; route: string },
): string => {
  const { locale, account, plan, route } = args
  const context = {
    locale,
    route,
    ...(props.visibility?.principal ? { principal: props.visibility.principal } : {}),
    account,
    ...(plan ? { plan } : {}),
  }
  const reading = props.usage
    ? { accountId: account.id, available: true as const, snapshot: props.usage, observedAt: null }
    : undefined
  const board = renderResourcesBoard({ context, ...(reading ? { reading } : {}) })
  if (!reading) return `${renderAccountResources(locale, account.uid, resourceRowsFromPlan(plan?.resources ?? null))}${board}`
  return `<header class="xp-board-head"><div><h1 id="xpanel-resources-heading" class="xp-page-title">${translator(locale)('Resources &amp; quotas')}</h1><p class="xp-prose xp-design-page__lede">${translator(locale)('What this plan allows, what this host applies to the slice, and what is in use right now.')}</p></div></header>${board}`
}

export const renderPanelSurface = (props: PanelSurfaceProps = {}): string => {
  const locale: Locale = props.locale ?? 'en'
  const rtl = localeDirection(locale) === 'rtl'
  const theme = props.theme ?? 'dark'
  const account = props.account
  if (!account) return ensureAccessibleSurfaceHtml(renderUnavailableSurfaceShell('xpanel', locale), locale)
  const plan = props.plan
  const activeRoute = normalizeSurfaceRoute('xpanel', props.activeRoute ?? '/home')
  const section = resolveSurfaceSection('xpanel', activeRoute)
  const composedPrincipal = props.visibility?.principal
  const accountExtensionSpec = accountPageRouteSpecs.find(row => row.route === activeRoute)
  const storeExtensionSpec = storeRouteSpecs.find(row => row.route === activeRoute)
    ?? (activeRoute === '/software/installer' ? storeRouteSpecs.find(row => row.route === '/software/store') : undefined)
  const scopedCollections = {
    ...(props.domains !== undefined ? { domains: { state: 'read' as const, items: props.domains } } : {}),
    ...(props.serviceUsers !== undefined ? { users: { state: 'read' as const, items: props.serviceUsers } } : {}),
  }
  const extensionHtml = composedPrincipal?.kind === 'user' && composedPrincipal.accountId === account.id
    ? activeRoute === '/email/accounts' ? renderEmailAccountsExtension({ locale, principal: composedPrincipal, account,
      ...(plan ? { plan } : {}), ...scopedCollections,
      mutationsQualified: visibleNavigation(props.visibility, props.catalog).some(surface => surface.sections.some(group => group.pages.some(page => page.route === '/email/accounts'))),
    }) : accountExtensionSpec ? renderAccountPagesExtension({ locale, route: activeRoute, principal: composedPrincipal, account,
      ...(plan ? { plan } : {}), theme, ...scopedCollections,
      mutationsQualified: visibleNavigation(props.visibility, props.catalog).some(surface => surface.sections.some(group => group.pages.some(page => page.route === activeRoute))),
    }) : storeExtensionSpec ? renderStoreExtension({ locale, route: activeRoute, principal: composedPrincipal, account,
      ...(scopedCollections.domains ? { domains: scopedCollections.domains } : {}),
    }) : undefined : undefined
  const extensionSpec = activeRoute === '/email/accounts' ? emailAccountsRouteSpec : accountExtensionSpec ?? storeExtensionSpec
  const composedHtml = renderComposedXpanel({
    locale, route: activeRoute, account,
    ...(composedPrincipal ? { principal: composedPrincipal } : {}),
    ...(composedPrincipal?.kind === 'reseller' && props.visibility?.reseller
      ? { reseller: { id: composedPrincipal.id, acl: props.visibility.reseller.acl } } : {}),
    ...(props.plan !== undefined ? { plan: props.plan } : {}),
    ...(props.domains !== undefined ? { domains: props.domains } : {}),
    ...(props.serviceUsers !== undefined ? { serviceUsers: props.serviceUsers } : {}),
    ...(props.usage !== undefined ? { usage: props.usage } : {}),
  })
  const composedSpec = composedHtml !== undefined ? composedRouteSpecs.find(row => row.surface === 'xpanel' && row.route === activeRoute) : undefined
  const pageTitle = extensionSpec ? copyOf(extensionSpec.title, locale) : composedSpec ? copyOf(composedSpec.title, locale) : getSurfacePageTitle('xpanel', section, locale, activeRoute)
  const activeDomain = props.activeDomain ?? account.primaryDomain
  const generationId = props.generationId !== undefined && Number.isSafeInteger(props.generationId) && props.generationId > 0 ? props.generationId : undefined
  const domains = props.domains ?? []
  const customConfig = props.customConfig
  const websiteAnalytics = props.websiteAnalytics
  // A supplied analytics observation is accepted only when it is complete and internally
  // consistent; a malformed or foreign observation stays unavailable instead of charted.
  const analyticsReading = websiteAnalytics ? parseWebsiteAnalyticsSnapshot(websiteAnalytics) : null
  const analyticsUnavailable = props.websiteAnalyticsUnavailable === true || (websiteAnalytics !== undefined && analyticsReading === null)
  const analyticsWindow = props.websiteAnalyticsWindow
  const files = (props.files ?? []).filter(file => activeRoute !== '/files/trash' || file.trashed)
  const databases = props.databases ?? []
  const databaseUsers = props.databaseUsers ?? []
  const serviceUsers = (props.serviceUsers ?? []).filter(user => activeRoute === '/files/ftp' ? user.services.ftp : user.services.email)
  const dnsRecords = props.dnsRecords ?? []
  const terminalSessionId = props.terminalSessionId

  const sliceUnit = `xpanel-${account.uid}.slice`
  const shellEnabled = plan?.shell === 'jailed' && account.shell === 'jailed' && account.status === 'active'
  const visibility = props.visibility?.principal.kind === 'user' && props.visibility.principal.accountId === account.id ? props.visibility : undefined
  const xpanelNav = visibleNavigation(visibility, props.catalog).find((n) => n.surface === 'xpanel')

  const qualifiedRoutes = new Set((xpanelNav?.sections ?? []).flatMap(section => section.pages.map(page => page.route)))
  const accountRoutes = props.visibility
    ? new Set(visibleNavigation(props.visibility, props.catalog).flatMap(item => item.sections.flatMap(section => section.pages.map(page => page.route))))
    : undefined


  const userIniLines = Object.entries(customConfig?.userIni ?? {})
    .map(([k, v]) => `${k} = ${v}`)
    .join('\n')
  const customHeaderLines = Object.entries(customConfig?.customHeaders ?? {})
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
  const actionBannerHtml = props.actionState
    ? renderAsyncActionState({ ...props.actionState, locale })
    : ''

  if (section === 'overview') {
    const homePlan = plan && plan.id === account.planId ? plan : undefined
    return ensureAccessibleSurfaceHtml(renderXpanelHome(xpanelHomeFromProps({
      locale,
      theme,
      realtimeEnabled: props.realtimeEnabled === true,
      account,
      ...(homePlan ? { plan: homePlan } : {}),
      domains,
      databases,
      databaseUsers,
      serviceUsers: props.serviceUsers ?? [],
      files: props.files ?? [],
      dnsRecords,
      ...(generationId !== undefined ? { generationId } : {}),
      actionHtml: actionBannerHtml + renderAccountAnnouncementsBanner({ locale, announcements: [] }),
      ...(accountRoutes ? { qualifiedRoutes: accountRoutes } : {}),
      ...(props.usage ? { usage: props.usage } : {}),
      ...(props.lastSignInAt ? { lastSignInAt: props.lastSignInAt } : {}),
      ...(props.recentAudit ? { recentChanges: props.recentAudit.map(entry => ({
        pill: translator(locale)('Audit'),
        pillBg: '#EEF0F3',
        pillFg: '#344054',
        titleHtml: escapeHtml(auditActionLabel(entry.action, locale, entry)),
        detailHtml: escapeHtml(auditTargetLabel(entry.target, locale)),
      })) } : {}),
      signOutLabel: translator(locale)('Sign out'),
    })), locale)
  }

  const nativeContent = activeRoute === '/domains' && composedPrincipal?.kind === 'user' && composedPrincipal.accountId === account.id
    ? actionBannerHtml + renderAccountDomains({ lang: locale, expectedAccountId: account.id, home: account.home,
      canManage: account.status === 'active' && visibleNavigation(props.visibility, props.catalog).some(surface => surface.sections.some(group => group.pages.some(page => page.route === '/domains'))) })
    : activeRoute === '/databases/mariadb' && composedPrincipal?.kind === 'user' && composedPrincipal.accountId === account.id
      ? actionBannerHtml + renderAccountDatabases({ lang: locale, expectedAccountId: account.id, username: account.username, home: account.home,
        canManage: account.status === 'active' && visibleNavigation(props.visibility, props.catalog).some(surface => surface.sections.some(group => group.pages.some(page => page.route === '/databases/mariadb'))) })
    : extensionHtml !== undefined ? actionBannerHtml + extensionHtml : composedHtml !== undefined ? actionBannerHtml + composedHtml : `      ${actionBannerHtml}
${section === 'resources' ? `<div style="display:grid;gap:32px;min-inline-size:0">${renderResourcesSection(props, { locale, account, plan, route: activeRoute })}</div>` : ''}
      ${section === 'domains' ? `      <!-- 2. Domains & Multi-IP Binding Table -->
      <section class="xp-card" id="xpanel-domains" data-section="domains-multi-ip" aria-labelledby="xpanel-domains-heading">
        <div class="xp-card__header">
          <div>
            <h1 id="xpanel-domains-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
            <p class="xp-prose">${translator(locale)('Manage domains, document roots, IP addresses, PHP settings and certificates.')}</p>
          </div>
          ${renderStatusBadge('ok', `${domains.length} ${translator(locale)('domains')}`)}
        </div>

        <div class="xp-table-wrap">
          <table class="xp-table" data-domains-table="true">
            <thead>
              <tr>
                <th>${translator(locale)('Domain / Type')}</th>
                <th>${translator(locale)('Document root')}</th>
                <th>${translator(locale)('IP addresses')}</th>
                <th>${translator(locale)('PHP / Runtime')}</th>
                <th>${translator(locale)('TLS certificate')}</th>
                <th>${translator(locale)('Action')}</th>
              </tr>
            </thead>
            <tbody>
              ${domains
                .map(
                  (dom) => `
                <tr data-domain-row="${escapeHtml(dom.name)}">
                  <td>
                    <strong class="xp-mono"><bdi dir="ltr">${escapeHtml(dom.name)}</bdi></strong>
                    <div>${renderStatusBadge('ok', translator(locale)(msgctxt('domain-kind', dom.kind)))} ${dom.wildcard ? renderStatusBadge('ok', translator(locale)(msgctxt('xpanel', 'Wildcard'))) : ''}</div>
                  </td>
                  <td><code class="xp-mono"><bdi dir="ltr">${escapeHtml(dom.docRoot)}</bdi></code></td>
                  <td class="xp-mono xp-tabular">
                    <bdi dir="ltr">IPv4: ${escapeHtml(dom.ipv4 ?? account.ipv4)}<br/>IPv6: ${escapeHtml(dom.ipv6 ?? account.ipv6 ?? '—')}</bdi>
                  </td>
                  <td class="xp-mono">
                    <bdi dir="ltr">${dom.siteType === 'node' ? `Node.js → ${escapeHtml(dom.upstream ?? '')}` : `PHP ${escapeHtml(dom.php.version)} (${escapeHtml(dom.php.handler)} · ${escapeHtml(dom.php.fpm.mode)})`}</bdi>
                  </td>
                  <td>
                    ${renderStatusBadge(dom.certificateId ? 'ok' : 'suspended', dom.certificateId ? (translator(locale)('Certificate configured')) : (translator(locale)('No certificate')))}
                  </td>
                  <td>${dom.kind === 'primary' ? '' : `<button type="button" class="xp-btn" data-remove-domain="${escapeHtml(dom.id)}">${translator(locale)('Remove')}</button>`}</td>
                </tr>
              `,
                )
                .join('')}
            </tbody>
          </table>
        </div>
        <form class="xp-form-group" data-domain-form="true" data-account-username="${escapeHtml(account.username)}" data-primary-id="${escapeHtml(domains.find(domain => domain.kind === 'primary')?.id ?? '')}">
          <div class="xp-field">
            <label class="xp-label" for="domain-name">${translator(locale)('Domain name')}</label>
            <input id="domain-name" name="name" type="text" class="xp-input xp-mono" dir="ltr" required placeholder="shop.example.test" />
          </div>
          <div class="xp-field">
            <label class="xp-label" for="domain-kind">${translator(locale)('Type')}</label>
            <select id="domain-kind" name="kind" class="xp-select">
              <option value="addon">${translator(locale)('Addon domain')}</option>
              <option value="subdomain">${translator(locale)('Subdomain')}</option>
            </select>
          </div>
          <p class="xp-help">${translator(locale)('A subdomain must end with the primary domain.')}</p>
          <p class="xp-help" data-domain-status role="status" hidden></p>
          <button type="submit" class="xp-btn xp-btn--primary">${translator(locale)(msgctxt('xpanel', 'Add domain'))}</button>
        </form>
      </section>

` : ''}
      ${section === 'config' && customConfig ? `      <!-- 3. Smart & Dynamic Custom Configurations (userdata model) -->
      <section class="xp-card" id="xpanel-userdata" data-section="userdata-custom-config" aria-labelledby="xpanel-userdata-heading">
        <div class="xp-card__header">
          <div>
            <h1 id="xpanel-userdata-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
            <p class="xp-prose">${escapeHtml(translator(locale)('Stored in /var/lib/xpanel/state/ and rendered into /etc/xpanel/userdata/<user>/<domain>/ + .user.ini. Verified by nginx -t and apachectl configtest before reload.'))}</p>
          </div>
          ${generationId !== undefined ? renderStatusBadge('ok', translator(locale)('Generation {generationId}', { generationId })) : ''}
        </div>

        <!-- Isolation & Forbidden Directive Guard Notice -->
        <div class="xp-reconcile-banner" style="margin-block-end: var(--xp-space-field);" data-userdata-guard-notice="true">
          <div style="display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px;">
            <div>
              <strong>${translator(locale)('Configuration checks before applying')}</strong>
              <p style="margin: 4px 0 0; font-size: 0.85rem; color: var(--xp-text-secondary);">
                ${translator(locale)('Privilege and isolation directives are blocked: user, pid, root, alias, include, SuexecUserGroup, AssignUserId, LoadModule, Listen. Failed checks keep the previous configuration active.')}
              </p>
            </div>
            ${renderStatusBadge('ok', 'nginx -t & apachectl configtest')}
          </div>
        </div>

        <div class="xp-form-group" role="group" aria-labelledby="xpanel-userdata-heading" data-userdata-form="true" data-domain-custom-config="${escapeHtml(customConfig.domainId)}" data-userdata-baseline="${escapeHtml(JSON.stringify({nginxInclude:customConfig.nginxInclude,apacheInclude:customConfig.apacheInclude,userIni:customConfig.userIni,customHeaders:customConfig.customHeaders,cacheBypassPaths:customConfig.cacheBypassPaths}))}">
          <div class="xp-kpi-grid">
            <!-- Editor 1: Nginx Drop-in -->
            <div class="xp-card">
              <label class="xp-label" for="userdata-nginx-include">
                1. ${escapeHtml(translator(locale)("Custom Nginx server '{}' directives"))}
              </label>
              <div class="xp-mono" style="font-size: 0.78rem; color: var(--xp-text-muted); margin-block: 4px;">
                <bdi dir="ltr">/etc/xpanel/userdata/${escapeHtml(account.username)}/${escapeHtml(customConfig.domainName)}/nginx.conf</bdi>
              </div>
              <textarea id="userdata-nginx-include" name="nginxInclude" rows="6" class="xp-textarea xp-mono" dir="ltr">${escapeHtml(customConfig.nginxInclude)}</textarea>
            </div>

            <!-- Editor 2: Apache Drop-in -->
            <div class="xp-card">
              <label class="xp-label" for="userdata-apache-include">
                2. ${escapeHtml(translator(locale)('Custom Apache <VirtualHost> directives'))}
              </label>
              <div class="xp-mono" style="font-size: 0.78rem; color: var(--xp-text-muted); margin-block: 4px;">
                <bdi dir="ltr">/etc/xpanel/userdata/${escapeHtml(account.username)}/${escapeHtml(customConfig.domainName)}/apache.conf</bdi>
              </div>
              <textarea id="userdata-apache-include" name="apacheInclude" rows="6" class="xp-textarea xp-mono" dir="ltr">${escapeHtml(customConfig.apacheInclude)}</textarea>
            </div>

            <!-- Editor 3: PHP .user.ini + Custom Headers + Cache Bypass -->
            <div class="xp-card">
              <label class="xp-label" for="userdata-user-ini">
                3. ${escapeHtml(translator(locale)('Per-directory PHP .user.ini overrides'))} (<bdi dir="ltr">/home/${escapeHtml(account.username)}/public_html/.user.ini</bdi>)
              </label>
              <textarea id="userdata-user-ini" name="userIni" rows="4" class="xp-textarea xp-mono" dir="ltr">${escapeHtml(userIniLines)}</textarea>

              <label class="xp-label" for="userdata-custom-headers" style="display: block; margin-block-start: 10px;">
                ${escapeHtml(translator(locale)('Structured HTTP response headers'))} &amp; ${escapeHtml(translator(locale)('Nginx proxy cache bypass URI prefixes'))}
              </label>
              <textarea id="userdata-custom-headers" name="customHeaders" rows="3" class="xp-textarea xp-mono" dir="ltr">${escapeHtml(customHeaderLines)}\nBypass: ${escapeHtml(customConfig.cacheBypassPaths.join(', '))}</textarea>
            </div>
          </div>

          <!-- Save Bar: Review changes -> Reconciling -> Applied in generation #N -->
          <div style="display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; padding-block-start: 8px;" data-userdata-save-bar="true">
            <div style="display: flex; align-items: center; gap: 10px;">
              ${renderStatusBadge('suspended', translator(locale)('Review changes before applying'))}
            </div>
            <button type="button" class="xp-btn xp-btn--primary" data-action="apply-userdata">
              ${escapeHtml(translator(locale)('Test & Apply Userdata Generation'))}
            </button>
          </div>
          <p class="xp-help" data-userdata-status role="status" aria-live="polite" hidden></p>
          <p class="xp-help data-userdata-application">${translator(locale)('This action stores the requested configuration only; applying it to the web service requires the matching server verification.')}</p>
        </div>
      </section>

` : ''}
      ${section === 'analytics' && analyticsReading ? `      <!-- 4. Real-Time Website Analytics -->
      <section class="xp-card" id="xpanel-analytics" data-section="website-analytics" aria-labelledby="xpanel-analytics-heading">
        <div class="xp-card__header" style="margin-block-end:var(--xp-space-group)">
          <div>
            <h1 id="xpanel-analytics-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
          </div>
          ${analyticsReading.series.length > 0 ? renderStatusBadge('ok', translator(locale)('{percent}% cache hit', { percent: analyticsReading.totals.cacheHitRatioPercent.toFixed(1) })) : renderStatusBadge('suspended', translator(locale)('No traffic rows in range'))}
        </div>
        ${renderWebsiteAnalyticsChart(analyticsReading, locale, analyticsWindow)}
      </section>

` : section === 'analytics' && analyticsUnavailable ? `      <!-- 4. Real-Time Website Analytics: account-scoped read unavailable -->
      <section class="xp-card xp-screen-state" id="xpanel-analytics" data-section="website-analytics" data-screen="unavailable" role="status" aria-labelledby="xpanel-analytics-heading">
        <h1 id="xpanel-analytics-heading" class="xp-page-title">${translator(locale)('Website traffic data is unavailable')}</h1>
        <p class="xp-prose">${translator(locale)('The account traffic records could not be read. An empty result is not assumed and no totals or time series are shown.')}</p>
        <p class="xp-help">${translator(locale)('This state covers the account-scoped analytics read only; server-wide IO observations are never presented as account traffic.')}</p>
      </section>

` : ''}
      ${section === 'files' ? `      <!-- 5. Jailed File Manager (/home/<user>, 0640/0750 Permission Guard, .trash) -->
      <section class="xp-card" id="xpanel-file-manager" data-section="jailed-file-manager" data-file-manager="${activeRoute === '/files/manager' ? 'browse' : 'trash'}" data-account-username="${escapeHtml(account.username)}" data-account-home="${escapeHtml(account.home)}" aria-labelledby="xpanel-files-heading">
        <div class="xp-card__header">
          <div>
            <h1 id="xpanel-files-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
            <p class="xp-prose">${escapeHtml(translator(locale)('Chroot enforced inside account home directory (0750 home, 0640 files, symlink traversal blocked).'))}</p>
            <p class="xp-help">${escapeHtml(translator(locale)('Files up to 2 MB. The upload stays inside this account.'))}</p>
          </div>
          <div style="display: flex; flex-wrap: wrap; gap: 8px;">
          </div>
        </div>

        <!-- File Manager Toolbar & Breadcrumb -->
        <div style="display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: var(--xp-space-group); margin-block-end: var(--xp-space-group);">
          ${activeRoute === '/files/manager' ? `<nav aria-label="File manager breadcrumb" class="xp-breadcrumb xp-mono">
            <button type="button" class="xp-btn" data-action="parent-directory" disabled>${translator(locale)('Parent folder')}</button>
            <span class="xp-file-location" dir="ltr" tabindex="0" aria-label="${translator(locale)('Current directory')}"><bdi dir="ltr" data-file-home-path>${escapeHtml(account.home)}</bdi><span aria-hidden="true">/</span><bdi dir="ltr" data-file-current-path></bdi></span>
          </nav>` : ''}
          <div style="display: flex; flex-wrap: wrap; gap: var(--xp-space-field);">
            <button type="button" class="xp-btn" data-action="refresh-files">${translator(locale)('Refresh files')}</button>
            ${activeRoute === '/files/manager' ? `<button type="button" class="xp-btn xp-btn--primary" data-action="upload-file">${escapeHtml(translator(locale)('Upload File'))}</button>
            <input id="jailed-file-upload" type="file" data-file-upload hidden />
            <button type="button" class="xp-btn" data-action="new-file">${escapeHtml(translator(locale)('New File'))}</button>
            <button type="button" class="xp-btn" data-action="new-folder">${escapeHtml(translator(locale)('New Folder'))}</button>` : ''}
            <button type="button" class="xp-btn" data-action="empty-trash">${translator(locale)('Empty trash')}</button>
          </div>
        </div>
        ${activeRoute === '/files/trash' ? `<p class="xp-help" data-file-status role="status" aria-live="polite" hidden style="margin-block: 0 var(--xp-space-group);"></p>` : ''}

        <div class="xp-table-wrap" role="region" tabindex="0" aria-label="${translator(locale)('Account files')}">
          <table class="xp-table" data-file-manager-table="true">
            <thead>
              <tr>
                <th>${translator(locale)('Name / Path')}</th>
                <th>${translator(locale)('Type')}</th>
                <th>${translator(locale)('Size')}</th>
                <th>${translator(locale)('Permissions')}</th>
                <th>${activeRoute === '/files/trash' ? (translator(locale)(msgctxt('xpanel', 'Deleted (UTC)'))) : (translator(locale)(msgctxt('xpanel', 'Modified (UTC)')))}</th>
                <th>${translator(locale)('Action')}</th>
              </tr>
            </thead>
            <tbody>
              ${files
                .map(
                  (f) => `
                <tr data-file-path="${escapeHtml(f.path)}">
                  <td>
                    <strong class="xp-mono"><bdi dir="ltr">${escapeHtml(f.name)}</bdi></strong>
                    <div class="xp-mono" style="font-size: 0.78rem; color: var(--xp-text-muted);"><bdi dir="ltr">${escapeHtml(f.path)}</bdi></div>
                  </td>
                  <td>${renderStatusBadge(f.trashed ? 'warn' : 'ok', f.trashed ? '.trash' : translator(locale)(f.kind === 'folder' ? msgctxt('files', 'Folder') : msgctxt('files', 'File')))}</td>
                  <td class="xp-mono xp-tabular" data-numeric="true">${escapeHtml(formatBytes(f.sizeBytes))}</td>
                  <td class="xp-mono xp-tabular"><code>${escapeHtml(f.modeOctal)}</code></td>
                  <td class="xp-mono xp-tabular"><time datetime="${escapeHtml(f.modifiedAt)}">${escapeHtml(formatDisplayDateTime(f.modifiedAt))}</time></td>
                  <td>
                    ${
                      f.trashed
                        ? `<button type="button" class="xp-btn" data-action="restore-file" data-path="${escapeHtml(f.path)}">${translator(locale)('Restore')}</button>`
                        : `<button type="button" class="xp-btn" data-action="chmod-file" data-path="${escapeHtml(f.path)}">${escapeHtml(translator(locale)('Permissions (chmod)'))}</button>`
                    }
                  </td>
                </tr>
              `,
                )
                .join('')}
            </tbody>
          </table>
        </div>
        ${activeRoute === '/files/trash' ? `<style>#xpanel-file-manager [data-file-workspace-action="purge"]{margin-inline-start:8px}#xpanel-file-manager [data-file-workspace-action="purge"]:not(:disabled){color:var(--xp-status-critical-fg)}#xpanel-file-manager .xp-trash-empty{align-items:center;gap:8px;padding:var(--xp-space-section) var(--xp-space-card);border-color:var(--xp-border-strong);text-align:center;color:var(--xp-text-muted)}#xpanel-file-manager .xp-trash-empty>h2{color:var(--xp-text-primary)}</style>
        <div class="xp-design-empty xp-trash-empty" data-trash-empty hidden>
          <svg aria-hidden="true" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6"></path><path d="M6 7l1 13h10l1-13M9 7V4h6v3"></path></svg>
          <h2>${translator(locale)('The trash is empty')}</h2>
          <p class="xp-help">${translator(locale)('Files you move to the trash stay here until you restore them or delete them for good.')}</p>
        </div>` : ''}

        <!-- In-Browser Code Editor (<= 1 MiB) + Chmod Isolation Policy Card (browse page only) -->
        ${activeRoute === '/files/manager' ? `<div class="xp-golden-grid" style="margin-block-start: var(--xp-space-card);">
          <div class="xp-card" data-in-browser-editor="true">
            <div class="xp-card__header">
              <h2>${escapeHtml(translator(locale)('Code & Config Editor'))} — <code class="xp-mono"><bdi dir="ltr">${escapeHtml(account.home)}</bdi></code></h2>
            </div>
            <div class="xp-file-editor-body" style="display:grid;gap:24px;min-inline-size:0">
              <p class="xp-help">${translator(locale)('Selected file')}: <bdi dir="ltr" class="xp-mono" data-file-selected-path></bdi></p>
              <div class="xp-field">
                <label class="xp-label" for="jailed-code-editor">${translator(locale)('File contents')}</label>
                <textarea id="jailed-code-editor" rows="8" class="xp-textarea xp-mono" dir="ltr" wrap="off" spellcheck="false" data-editor-path=""></textarea>
              </div>
              <div style="display:flex;flex-wrap:wrap;gap:var(--xp-space-field)">
                <button type="button" class="xp-btn xp-btn--primary" data-action="save-file" disabled>${translator(locale)('Save text')}</button>
                <button type="button" class="xp-btn" data-action="reload-file" disabled>${translator(locale)('Reload file')}</button>
              </div>
              <p class="xp-help" data-file-status role="status" aria-live="polite" hidden></p>
            </div>
          </div>

          <div class="xp-card xp-form-group" data-chmod-policy-modal="true">
            <div class="xp-card__header">
              <h2>${escapeHtml(translator(locale)('Permissions (chmod)'))} (0640 / 0750)</h2>
            </div>
            <p class="xp-prose">
              ${translator(locale)('Maximum permissions: 0640 for files and 0750 for folders. Modes 0777 and 0666 are blocked to protect accounts.')}
            </p>
            <div class="xp-field">
              <label class="xp-label" for="chmod-octal-input">${translator(locale)('Permissions (0600, 0640, 0700, 0750)')}</label>
              <input id="chmod-octal-input" type="text" class="xp-input xp-mono" dir="ltr" value="0640" pattern="0[67][045]0" />
            </div>
          </div>
        </div>` : ''}
      </section>

` : ''}
      ${section === 'terminal' ? `      <!-- 6. Jailed Shell Terminal (systemd-run --slice=xpanel-<uid>.slice --uid=<uid>) -->
      <section class="xp-card" id="xpanel-terminal" data-section="jailed-shell-terminal" aria-labelledby="xpanel-terminal-heading" style="display:flex;flex-direction:column;gap:var(--xp-space-group,24px)">
        <div class="xp-card__header" style="margin:0">
          <div>
            <h1 id="xpanel-terminal-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
            <p class="xp-prose">${escapeHtml(translator(locale)('Running as UID {uid} inside systemd cgroup v2 unit xpanel-{uid}.slice with private /tmp and open_basedir isolation.', { uid: account.uid }))}</p>
          </div>
          ${renderStatusBadge(shellEnabled ? 'ok' : 'suspended', shellEnabled ? `Jailed (${sliceUnit})` : (translator(locale)('Shell access disabled')))}
        </div>

        ${
          shellEnabled
            ? `
          <div>
            <span class="xp-label">${translator(locale)('Allowed commands')}</span>
            <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-block-start: 6px;">
              ${ALLOWLISTED_SHELL_BINARIES.map((bin) => `<code class="xp-mono">${escapeHtml(bin)}</code>`).join(' · ')}
            </div>
          </div>

          <pre class="xp-terminal" dir="ltr" style="margin:0" data-terminal-output="${escapeHtml(terminalSessionId ?? '')}">${escapeHtml(translator(locale)('No terminal session has started.'))}</pre>

          <div class="xp-reconcile-banner" role="status" data-terminal-execution="unavailable">
            ${renderStatusBadge('suspended', translator(locale)('Command execution unavailable'))}
            <p class="xp-prose">${translator(locale)('No qualified command-execution path exists on this server; no command can be run from this page and no output is fabricated.')}</p>
          </div>
        `
            : `
          <div class="xp-reconcile-banner" role="status" data-terminal-disabled="true">
            ${renderStatusBadge('suspended', translator(locale)('Shell access disabled'))}
            <p class="xp-prose">${translator(locale)('Terminal access is disabled on your current plan.')}</p>
          </div>
        `
        }
      </section>

` : ''}
            <!-- 7. Databases (MariaDB + .trash), Email & FTP Users, and DNS Zone Editor -->

${section === 'databases' ? `        <section class="xp-card" data-section="mariadb-databases" aria-labelledby="xpanel-db-heading">
          <div class="xp-card__header">
            <h1 id="xpanel-db-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
            ${renderStatusBadge('ok', translator(locale)('{active} active · {trashed} in trash', { active: databases.filter((d) => !d.trashedAt).length, trashed: databases.filter((d) => d.trashedAt).length }))}
          </div>
          <div class="xp-table-wrap">
            <table class="xp-table">
              <thead>
                <tr>
                  <th>${translator(locale)('Database')}</th>
                  <th>${translator(locale)('Engine')}</th>
                  <th>${translator(locale)('Status / Recovery')}</th>
                </tr>
              </thead>
              <tbody>
                ${databases
                  .map(
                    (db) => `
                  <tr data-database-row="${escapeHtml(db.name)}">
                    <td><strong class="xp-mono"><bdi dir="ltr">${escapeHtml(db.name)}</bdi></strong></td>
                    <td class="xp-mono">${escapeHtml(db.engine)}</td>
                    <td>
                      ${
                        db.trashedAt
                          ? `${renderStatusBadge('warn', `${translator(locale)('Trashed')} (${formatAsciiDate(db.trashedAt, { includeTime: true })})`)} <button type="button" class="xp-btn" data-action="restore-db" data-db="${escapeHtml(db.name)}">${translator(locale)('Restore')}</button>`
                          : `${renderStatusBadge('ok', translator(locale)('Active'))} <button type="button" class="xp-btn" data-remove-database="${escapeHtml(db.id)}" data-database-name="${escapeHtml(db.name)}">${translator(locale)('Delete')}</button>`
                      }
                    </td>
                  </tr>
                `,
                  )
                  .join('')}
              </tbody>
          </table>
        </div>
        <form class="xp-form-group" data-database-form="true" data-account-username="${escapeHtml(account.username)}">
          <div class="xp-field">
            <label class="xp-label" for="database-name">${translator(locale)('Database name')}</label>
            <input id="database-name" name="name" type="text" class="xp-input xp-mono" dir="ltr" required pattern="[a-z0-9][a-z0-9_]{0,40}" placeholder="shop" />
          </div>
          <p class="xp-help" data-database-status role="status" hidden></p>
          <button type="submit" class="xp-btn xp-btn--primary">${translator(locale)(msgctxt('xpanel', 'Create database'))}</button>
        </form>
        <dialog class="xp-account-dialog" data-database-delete-dialog aria-labelledby="database-delete-title">
          <form method="dialog">
            <div class="xp-account-dialog__header">
              <h2 id="database-delete-title">${translator(locale)('Delete database')}</h2>
              <p data-database-delete-copy>${translator(locale)('Permanently deletes this database.')}</p>
            </div>
            <p class="xp-mono"><bdi dir="ltr" data-database-delete-name></bdi></p>
            <p class="xp-account-dialog__status" data-dialog-status role="status" hidden></p>
            <div class="xp-account-dialog__footer">
              <button type="button" class="xp-btn" data-dialog-cancel>${translator(locale)('Cancel')}</button>
              <button type="submit" class="xp-btn xp-btn--primary">${translator(locale)('Delete')}</button>
            </div>
          </form>
        </dialog>
        <div class="xp-table-wrap">
          <table class="xp-table">
            <thead><tr><th>${translator(locale)('Database user')}</th><th>${translator(locale)('Grants')}</th><th></th></tr></thead>
            <tbody>
              ${databaseUsers.map(user => `<tr data-database-user="${escapeHtml(user.name)}"><td class="xp-mono"><bdi dir="ltr">${escapeHtml(user.name)}</bdi></td><td class="xp-mono">${escapeHtml(String(user.grants.length))}</td><td><button type="button" class="xp-btn" data-remove-database-user="${escapeHtml(user.id)}">${translator(locale)('Delete')}</button></td></tr>`).join('')}
            </tbody>
          </table>
        </div>
        <form class="xp-form-group" data-database-user-form="true" data-account-username="${escapeHtml(account.username)}">
          <div class="xp-field">
            <label class="xp-label" for="database-user-name">${translator(locale)('User name')}</label>
            <input id="database-user-name" name="name" type="text" class="xp-input xp-mono" dir="ltr" required pattern="[a-z0-9][a-z0-9_]{0,24}" />
          </div>
          <div class="xp-field">
            <label class="xp-label" for="database-user-password">${translator(locale)('Password')}</label>
            <input id="database-user-password" name="password" type="password" class="xp-input" minlength="8" required autocomplete="new-password" />
          </div>
          <div class="xp-field">
            <label class="xp-label" for="database-user-grant">${translator(locale)('Grant on')}</label>
            <select id="database-user-grant" name="databaseId" class="xp-select">${databases.filter(db => !db.trashedAt).map(db => `<option value="${escapeHtml(db.id)}">${escapeHtml(db.name)}</option>`).join('')}</select>
          </div>
          <p class="xp-help" data-database-user-status role="status" hidden></p>
          <button type="submit" class="xp-btn xp-btn--primary">${translator(locale)(msgctxt('xpanel', 'Create user'))}</button>
        </form>

</section>` : ''}
      ${section === 'users' ? `          <section class="xp-card" data-section="service-users">
            <div class="xp-card__header" style="margin-block-end:var(--xp-space-group,24px)">
              <h1 class="xp-page-title">${escapeHtml(pageTitle)}</h1>
              ${renderStatusBadge('ok', translator(locale)('{count} service logins', { count: serviceUsers.length }))}
            </div>
            <div class="xp-table-wrap">
              <table class="xp-table">
                <thead>
                  <tr>
                    <th>${escapeHtml(translator(locale)(msgctxt('email', 'Login')))}</th>
                    <th>${escapeHtml(translator(locale)('Services'))}</th>
                    <th>${escapeHtml(translator(locale)('Mailbox quota'))}</th>
                    <th>${translator(locale)('Action')}</th>
                  </tr>
                </thead>
                <tbody>
                  ${serviceUsers
                    .map(
                      (u) => `
                    <tr data-service-user="${escapeHtml(u.login)}">
                      <td class="xp-mono"><bdi dir="ltr">${escapeHtml(u.login)}</bdi></td>
                      <td>
                        ${u.services.email ? renderStatusBadge('ok', translator(locale)(msgctxt('email', 'Email'))) : ''}
                        ${u.services.ftp ? renderStatusBadge('ok', `FTP (${u.ftpDir})`) : ''}
                      </td>
                      <td class="xp-mono xp-tabular">${String(u.mailboxQuotaMb)} MB</td>
                      <td>
                        <button type="button" class="xp-btn" data-mailbox-password="${escapeHtml(u.id)}">${translator(locale)('Password')}</button>
                        <button type="button" class="xp-btn" data-mailbox-quota="${escapeHtml(u.id)}" data-mailbox-quota-value="${escapeHtml(String(u.mailboxQuotaMb))}">${translator(locale)('Quota')}</button>
                        <button type="button" class="xp-btn" data-remove-mailbox="${escapeHtml(u.id)}">${translator(locale)('Delete')}</button>
                      </td>
                    </tr>
                  `,
                    )
                    .join('')}
                </tbody>
              </table>
            </div>
            ${activeRoute === '/email/accounts' ? `<form class="xp-form-group" data-mailbox-form="true">
              <div class="xp-field">
                <label class="xp-label" for="mailbox-local">${translator(locale)('Name')}</label>
                <input id="mailbox-local" name="localPart" type="text" class="xp-input xp-mono" dir="ltr" required pattern="[a-z0-9][a-z0-9._-]{0,31}" />
              </div>
              <div class="xp-field">
                <label class="xp-label" for="mailbox-domain">${translator(locale)('Domain')}</label>
                <select id="mailbox-domain" name="domainId" class="xp-select">${domains.map(domain => `<option value="${escapeHtml(domain.id)}">${escapeHtml(domain.name)}</option>`).join('')}</select>
              </div>
              <div class="xp-field">
                <label class="xp-label" for="mailbox-password">${translator(locale)('Password')}</label>
                <input id="mailbox-password" name="password" type="password" class="xp-input" minlength="8" required autocomplete="new-password" />
              </div>
              <div class="xp-field">
                <label class="xp-label" for="mailbox-quota">${translator(locale)('Quota (MB)')}</label>
                <input id="mailbox-quota" name="mailboxQuotaMb" type="number" class="xp-input xp-mono" min="1" value="1024" required />
              </div>
              <p class="xp-help" data-mailbox-status role="status" hidden></p>
              <button type="submit" class="xp-btn xp-btn--primary">${translator(locale)(msgctxt('xpanel', 'Create mailbox'))}</button>
            </form>` : ''}
            <dialog class="xp-account-dialog" data-mailbox-password-dialog aria-labelledby="mailbox-password-title">
              <form method="dialog">
                <div class="xp-account-dialog__header">
                  <h2 id="mailbox-password-title">${translator(locale)('Mailbox password')}</h2>
                  <p>${translator(locale)('The new password is saved after you confirm.')}</p>
                </div>
                <div class="xp-field">
                  <label class="xp-label" for="mailbox-password-next">${translator(locale)('New password')}</label>
                  <input id="mailbox-password-next" name="password" type="password" class="xp-input" minlength="8" required autocomplete="new-password" />
                </div>
                <p class="xp-account-dialog__status" data-dialog-status role="status" hidden></p>
                <div class="xp-account-dialog__footer">
                  <button type="button" class="xp-btn" data-dialog-cancel>${translator(locale)('Cancel')}</button>
                  <button type="submit" class="xp-btn xp-btn--primary">${translator(locale)('Save')}</button>
                </div>
              </form>
            </dialog>
            <dialog class="xp-account-dialog" data-mailbox-quota-dialog aria-labelledby="mailbox-quota-title">
              <form method="dialog">
                <div class="xp-account-dialog__header">
                  <h2 id="mailbox-quota-title">${translator(locale)('Mailbox quota')}</h2>
                </div>
                <div class="xp-field">
                  <label class="xp-label" for="mailbox-quota-next">${translator(locale)('Quota (MB)')}</label>
                  <input id="mailbox-quota-next" name="mailboxQuotaMb" type="number" class="xp-input xp-mono" min="1" required />
                </div>
                <p class="xp-account-dialog__status" data-dialog-status role="status" hidden></p>
                <div class="xp-account-dialog__footer">
                  <button type="button" class="xp-btn" data-dialog-cancel>${translator(locale)('Cancel')}</button>
                  <button type="submit" class="xp-btn xp-btn--primary">${translator(locale)('Save')}</button>
                </div>
              </form>
            </dialog>
          </section>

` : ''}
      ${section === 'dns' ? `        <!-- PowerDNS Zone Record Editor -->
        <aside class="xp-card" data-section="dns-zone-editor" aria-labelledby="xpanel-dns-heading">
          <div class="xp-card__header">
            <h1 id="xpanel-dns-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
            ${renderStatusBadge('ok', translator(locale)('PowerDNS BIND zone'))}
          </div>
          <div class="xp-table-wrap">
            <table class="xp-table xp-table--compact">
              <thead>
                <tr>
                  <th>${escapeHtml(translator(locale)('Name'))}</th>
                  <th>${escapeHtml(translator(locale)('Type'))}</th>
                  <th>TTL</th>
                  <th>${escapeHtml(translator(locale)('Content'))}</th>
                </tr>
              </thead>
              <tbody>
                ${dnsRecords
                  .map(
                    (rec) => `
                  <tr data-dns-record="${escapeHtml(rec.id)}">
                    <td class="xp-mono"><bdi dir="ltr">${escapeHtml(rec.name)}</bdi></td>
                    <td>${renderStatusBadge('ok', rec.type)}</td>
                    <td class="xp-mono xp-tabular">${rec.ttl}</td>
                    <td class="xp-mono"><bdi dir="ltr">${escapeHtml(rec.content)}</bdi></td>
                  </tr>
                `,
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        </aside>

` : ''}
      ${section === 'ssl' ? `<section class="xp-card" data-section="ssl-status" style="display:flex;flex-direction:column;gap:var(--xp-space-group)" aria-labelledby="xpanel-ssl-heading">
        <div class="xp-card__header" style="margin:0">
          <div>
            <h1 id="xpanel-ssl-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
            <p class="xp-prose">${translator(locale)('Issue or renew a certificate for a domain on this account. The server answers the HTTP-01 check on port 80.')}</p>
          </div>
        </div>
        <div class="xp-table-wrap">
          <table class="xp-table">
            <thead><tr><th>${translator(locale)('Domain')}</th><th>${translator(locale)('Certificate')}</th></tr></thead>
            <tbody>${domains.map(domain => `<tr><td class="xp-mono"><bdi dir="ltr">${escapeHtml(domain.name)}</bdi></td><td>${renderStatusBadge(domain.certificateId ? 'ok' : 'suspended', domain.certificateId ? (translator(locale)('Stored')) : (translator(locale)('No certificate')))}</td></tr>`).join('')}</tbody>
          </table>
        </div>
        ${domains.length > 0 ? `<form class="xp-form-group" data-certificate-form="true" data-account-username="${escapeHtml(account.username)}">
          <div class="xp-field">
            <label class="xp-label" for="certificate-domain">${translator(locale)('Domain')}</label>
            <select id="certificate-domain" name="domain" class="xp-select" required>
              ${domains.map(domain => `<option value="${escapeHtml(domain.name)}">${escapeHtml(domain.name)}</option>`).join('')}
            </select>
          </div>
          <p class="xp-help" data-certificate-status role="status" hidden></p>
          <button type="submit" class="xp-btn xp-btn--primary">${translator(locale)('Issue or renew')}</button>
        </form>
        <p class="xp-help">${translator(locale)('A failed check stays on this page with the certificate authority message.')}</p>` : `<p class="xp-help">${translator(locale)('Add a domain before issuing a certificate.')}</p>`}
      </section>` : ''}
            ${section === 'security' ? `<section class="xp-card" data-section="account-security" style="display:flex;flex-direction:column;gap:var(--xp-space-group)"><h1 id="xpanel-security-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1></section>` : ''}
            ${section === 'design' ? renderDesignMain(activeRoute, locale) : ''}
            ${section === undefined || (section === 'config' && !customConfig) || (section === 'analytics' && !analyticsReading && !analyticsUnavailable) ? renderSurfaceUnavailable(locale, '/home') : ''}`

  const rawHtml = renderSurfaceShell({
    surface: 'xpanel', locale,
    attributes: `data-account="${escapeHtml(account.username)}" data-uid="${account.uid}"`,
    sidebar: `    <div class="xp-sidebar__brand">
      <span class="xp-brand__mark" aria-hidden="true">x</span>
      <div>
        <strong>xPanel</strong>
        <div><bdi dir="ltr" class="xp-mono">${escapeHtml(account.primaryDomain)}</bdi></div>
      </div>
    </div>

    <!-- Account summary -->
    <div class="xp-card" style="padding: 12px; margin-block-end: 12px;" data-account-summary-card="true">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <strong class="xp-mono"><bdi dir="ltr">${escapeHtml(account.username)}</bdi></strong>
        ${plan ? renderStatusBadge('ok', formatDisplayName(plan.name)) : ''}
      </div>
    </div>

    ${renderDesignNav('xpanel', locale, activeRoute, qualifiedRoutes, visibility)}`,
    topbar: `      <div class="xp-topbar__start">
        ${renderPageSearchButton(locale)}

        <label class="xp-sr-only" for="xpanel-domain-switcher">${translator(locale)('Active domain')}</label>
        <select id="xpanel-domain-switcher" class="xp-select xp-mono" style="width: auto;" data-domain-switcher="true">
          ${domains
            .map(
              (d) => `<option value="${escapeHtml(d.name)}" ${d.name === activeDomain ? 'selected' : ''}>${escapeHtml(d.name)} (${escapeHtml(translator(locale)(msgctxt('domain-kind', d.kind)))})</option>`,
            )
            .join('')}
        </select>
      </div>

      ${renderSurfaceToolbarEnd({
        surface: 'xpanel', locale, theme, density: props.density ?? 'comfortable',
        path: activeRoute, username: account.username, role: translator(locale)('Account owner'),
        signedIn: true, realtimeEnabled: props.realtimeEnabled === true,
        ...(generationId !== undefined ? { generationId } : {}),
      })}`,
    content: renderApprovedXpanelWorkspace({ ...props, route: activeRoute, locale, readOnly: false, nativeHtml: nativeContent }) ?? nativeContent,
  })
  return ensureAccessibleSurfaceHtml(rawHtml.trim(), locale)
}
