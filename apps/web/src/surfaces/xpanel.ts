import { visibleNavigation, type CatalogTool, type VisibilityContext } from '@xpanel/catalog'
import type {
  Account,
  Database,
  DnsRecord,
  Domain,
  DomainCustomConfig,
  Plan,
  ServiceUser,
  WebsiteAnalyticsSnapshot,
} from '@xpanel/core'
import { renderWebsiteAnalyticsChart } from '../charts.ts'
import { type Locale, t } from '../i18n.ts'
import {
  type AsyncActionBannerProps,
  ensureAccessibleSurfaceHtml,
  escapeHtml,
  formatBytes,
  renderAsyncActionState,
  renderStatusBadge,
  renderThresholdMeter,
} from '../tokens.ts'
import { renderSurfaceShell, renderSurfaceUnavailable, resolveSurfaceSection, renderUnavailableSurfaceShell, getSurfacePageTitle, getSurfaceNavigationLabel, normalizeSurfaceRoute, renderLiveUpdatesIndicator } from '../shell.ts'

export { renderPanelExtendedSections } from './extended-views.ts'

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
  realtimeEnabled?: boolean
  account?: Account
  plan?: Plan
  activeRoute?: string
  activeDomain?: string
  generationId?: number
  domains?: Domain[]
  customConfig?: DomainCustomConfig
  websiteAnalytics?: WebsiteAnalyticsSnapshot
  files?: JailedFileEntry[]
  databases?: Database[]
  serviceUsers?: ServiceUser[]
  dnsRecords?: DnsRecord[]
  terminalSessionId?: string
  actionState?: AsyncActionBannerProps
}

export const DEFAULT_WEBSITE_ANALYTICS: WebsiteAnalyticsSnapshot = {
  domain: 'alice-shop.com',
  accountId: 'acc-alice',
  at: '2026-10-22T14:05:00Z',
  totals: {
    requests: 48920,
    bytes: 1.84 * 1024 * 1024 * 1024,
    uniqueVisitors: 6410,
    cacheHitRatioPercent: 84.6,
    errorRatePercent: 0.12,
    avgRequestTimeMs: 18.4,
    p95RequestTimeMs: 62.0,
    avgUpstreamTimeMs: 14.2,
    status2xx: 45120,
    status3xx: 3180,
    status4xx: 562,
    status5xx: 58,
  },
  series: [
    {
      at: '2026-10-22T14:01:00Z',
      requests: 9200,
      bytes: 340 * 1024 * 1024,
      status2xx: 8510,
      status3xx: 580,
      status4xx: 98,
      status5xx: 12,
      cacheHit: 7780,
      cacheMiss: 1120,
      cacheBypass: 300,
      avgRequestTimeMs: 17.2,
      p95RequestTimeMs: 58.0,
      avgUpstreamTimeMs: 13.5,
    },
    {
      at: '2026-10-22T14:02:00Z',
      requests: 9840,
      bytes: 375 * 1024 * 1024,
      status2xx: 9090,
      status3xx: 620,
      status4xx: 118,
      status5xx: 12,
      cacheHit: 8320,
      cacheMiss: 1200,
      cacheBypass: 320,
      avgRequestTimeMs: 18.0,
      p95RequestTimeMs: 61.0,
      avgUpstreamTimeMs: 14.0,
    },
    {
      at: '2026-10-22T14:03:00Z',
      requests: 10450,
      bytes: 410 * 1024 * 1024,
      status2xx: 9640,
      status3xx: 670,
      status4xx: 124,
      status5xx: 16,
      cacheHit: 8850,
      cacheMiss: 1240,
      cacheBypass: 360,
      avgRequestTimeMs: 19.4,
      p95RequestTimeMs: 66.0,
      avgUpstreamTimeMs: 15.1,
    },
    {
      at: '2026-10-22T14:04:00Z',
      requests: 9610,
      bytes: 360 * 1024 * 1024,
      status2xx: 8860,
      status3xx: 630,
      status4xx: 110,
      status5xx: 10,
      cacheHit: 8140,
      cacheMiss: 1160,
      cacheBypass: 310,
      avgRequestTimeMs: 18.6,
      p95RequestTimeMs: 63.0,
      avgUpstreamTimeMs: 14.4,
    },
    {
      at: '2026-10-22T14:05:00Z',
      requests: 9820,
      bytes: 370 * 1024 * 1024,
      status2xx: 9020,
      status3xx: 680,
      status4xx: 112,
      status5xx: 8,
      cacheHit: 8300,
      cacheMiss: 1210,
      cacheBypass: 310,
      avgRequestTimeMs: 18.1,
      p95RequestTimeMs: 62.0,
      avgUpstreamTimeMs: 14.0,
    },
  ],
  topPaths: [
    { key: '/products/ergonomic-desk', requests: 12480, bytes: 420 * 1024 * 1024, errors5xx: 0 },
    { key: '/api/v1/cart/summary', requests: 8920, bytes: 64 * 1024 * 1024, errors5xx: 2 },
    { key: '/static-assets/bundle.js', requests: 7640, bytes: 512 * 1024 * 1024, errors5xx: 0 },
  ],
  topReferrers: [
    { key: 'https://www.google.com/', requests: 18400, bytes: 610 * 1024 * 1024, errors5xx: 0 },
    { key: 'direct', requests: 14200, bytes: 490 * 1024 * 1024, errors5xx: 0 },
    { key: 'https://alice-blog.net/', requests: 5120, bytes: 195 * 1024 * 1024, errors5xx: 0 },
  ],
  topClientIps: [
    { key: '198.51.100.42', requests: 640, bytes: 24 * 1024 * 1024, errors5xx: 0 },
    { key: '203.0.113.88', requests: 510, bytes: 19 * 1024 * 1024, errors5xx: 1 },
    { key: '2001:db8:85a3::8a2e:370:7334', requests: 430, bytes: 16 * 1024 * 1024, errors5xx: 0 },
  ],
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

export const renderPanelSurface = (props: PanelSurfaceProps = {}): string => {
  const locale: Locale = props.locale ?? 'en'
  const isAr = locale === 'ar'
  const theme = props.theme ?? 'dark'
  const account = props.account
  if (!account) return ensureAccessibleSurfaceHtml(renderUnavailableSurfaceShell('xpanel', locale), locale)
  const plan = props.plan
  const activeRoute = normalizeSurfaceRoute('xpanel', props.activeRoute ?? '/home')
  const section = resolveSurfaceSection('xpanel', activeRoute)
  const pageTitle = getSurfacePageTitle('xpanel', section, locale, activeRoute)
  const activeDomain = props.activeDomain ?? account.primaryDomain
  const generationId = props.generationId !== undefined && Number.isSafeInteger(props.generationId) && props.generationId > 0 ? props.generationId : undefined
  const domains = props.domains ?? []
  const customConfig = props.customConfig
  const websiteAnalytics = props.websiteAnalytics
  const files = (props.files ?? []).filter(file => activeRoute !== '/files/trash' || file.trashed)
  const databases = props.databases ?? []
  const serviceUsers = (props.serviceUsers ?? []).filter(user => activeRoute === '/files/ftp' ? user.services.ftp : user.services.email)
  const dnsRecords = props.dnsRecords ?? []
  const terminalSessionId = props.terminalSessionId

  const sliceUnit = `xpanel-${account.uid}.slice`
  const shellEnabled = plan?.shell === 'jailed' && account.shell === 'jailed' && account.status === 'active'
  const visibility = props.visibility?.principal.kind === 'user' && props.visibility.principal.accountId === account.id ? props.visibility : undefined
  const xpanelNav = visibleNavigation(visibility, props.catalog).find((n) => n.surface === 'xpanel')

  const sidebarSectionsHtml = (xpanelNav?.sections ?? [])
    .map((section) => {
      const isExpanded = section.pages.some((p) => p.route === activeRoute)
      return `
      <details class="xp-nav-section" ${isExpanded ? 'open' : ''} data-nav-section="${escapeHtml(section.id)}">
        <summary class="xp-nav-section__title">
          <span>${escapeHtml(getSurfaceNavigationLabel('xpanel', 'section', section, locale))}</span>
          <span class="xp-tabular">(${section.pages.length})</span>
        </summary>
        <div class="xp-nav-section__items">
          ${section.pages
            .map(
              (page) => `
            <a href="${escapeHtml(page.route)}" class="xp-nav-item ${page.route === activeRoute ? 'xp-nav-item--active' : ''}" ${page.route === activeRoute ? 'aria-current="page"' : ''} data-nav-route="${escapeHtml(page.route)}">
              <span>${escapeHtml(getSurfaceNavigationLabel('xpanel', 'page', page, locale))}</span>
            </a>
          `,
            )
            .join('')}
        </div>
      </details>
    `
    })
    .join('')

  const switchLangCode = isAr ? 'en' : 'ar'
  const switchLangLabel = isAr ? 'English' : 'العربية'
  const nextTheme = theme === 'dark' ? 'light' : 'dark'

  const userIniLines = Object.entries(customConfig?.userIni ?? {})
    .map(([k, v]) => `${k} = ${v}`)
    .join('\n')
  const customHeaderLines = Object.entries(customConfig?.customHeaders ?? {})
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
  const actionBannerHtml = props.actionState
    ? renderAsyncActionState({ ...props.actionState, locale })
    : ''

  const rawHtml = renderSurfaceShell({
    surface: 'xpanel', locale,
    attributes: `data-account="${escapeHtml(account.username)}" data-uid="${account.uid}"`,
    sidebar: `    <div class="xp-sidebar__brand">
      <span class="xp-brand__mark" aria-hidden="true">xP</span>
      <div>
        <strong>xPanel</strong>
        <div><bdi dir="ltr" class="xp-mono">${escapeHtml(account.primaryDomain)}</bdi></div>
      </div>
    </div>

    <!-- Account summary -->
    <div class="xp-card" style="padding: 12px; margin-block-end: 12px;" data-account-summary-card="true">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <strong class="xp-mono"><bdi dir="ltr">${escapeHtml(account.username)}</bdi></strong>
        ${plan ? renderStatusBadge('ok', plan.name) : ''}
      </div>
    </div>

    <div class="xp-sidebar__favorites" aria-label="${isAr ? 'وصول سريع' : 'Quick access'}">
      <div class="xp-label">${isAr ? 'وصول سريع' : 'Quick access'}</div>
      ${(xpanelNav?.sections ?? []).flatMap(section => section.pages).slice(0, 3).map(page => `<a href="${escapeHtml(page.route)}" class="xp-nav-item">${escapeHtml(getSurfaceNavigationLabel('xpanel', 'page', page, locale))}</a>`).join('')}
    </div>

    <nav aria-label="xPanel sections">
      ${sidebarSectionsHtml || `<p role="status" data-navigation-empty="true">${escapeHtml(isAr ? 'لا توجد أدوات مثبتة الجاهزية ومتاحة لحسابك.' : 'No verified tools are available for your account.')}</p>`}
    </nav>`,
    topbar: `      <div class="xp-topbar__start" style="display: flex; align-items: center; gap: 12px;">
        <button type="button" class="xp-btn" data-action="open-cmdk" aria-keyshortcuts="Control+K Meta+K">
          <span>${isAr ? 'بحث' : 'Search'}</span>
          <kbd class="xp-mono">Ctrl K</kbd>
        </button>

        <label class="xp-sr-only" for="xpanel-domain-switcher">${isAr ? 'اختر النطاق' : 'Active domain'}</label>
        <select id="xpanel-domain-switcher" class="xp-select xp-mono" style="width: auto;" data-domain-switcher="true">
          ${domains
            .map(
              (d) => `<option value="${escapeHtml(d.name)}" ${d.name === activeDomain ? 'selected' : ''}>${escapeHtml(d.name)} (${escapeHtml(d.kind)})</option>`,
            )
            .join('')}
        </select>
      </div>

      <div class="xp-topbar__end" style="display: flex; flex-wrap: wrap; align-items: center; gap: 10px;">
        ${renderLiveUpdatesIndicator(locale, props.realtimeEnabled === true)}
        ${generationId !== undefined ? `<span data-generation-chip="${generationId}">
          ${renderStatusBadge('ok', `Gen #${generationId}`)}
        </span>` : ''}
        <a href="?surface=xpanel&amp;lang=${switchLangCode}&amp;theme=${theme}" class="xp-btn" lang="${switchLangCode}" data-lang-switch="${switchLangCode}">
          ${escapeHtml(switchLangLabel)}
        </a>
        <a href="?surface=xpanel&amp;lang=${locale}&amp;theme=${nextTheme}" class="xp-btn" data-theme-toggle="${nextTheme}">
          ${escapeHtml(theme === 'dark' ? t(locale, 'common.theme.light') : t(locale, 'common.theme.dark'))}
        </a>
        <a href="/mail?lang=${locale}&amp;theme=${theme}" class="xp-btn xp-btn--ghost">xMail</a>
        <span class="xp-mono">${escapeHtml(account.username)}</span>
        <button type="button" class="xp-btn xp-btn--ghost" data-action="logout">${escapeHtml(isAr ? 'تسجيل الخروج' : 'Sign out')}</button>
      </div>`,
    content: `      ${actionBannerHtml}
${section === 'overview' || section === 'resources' ? `      <section class="xp-card" data-section="slice-resources" aria-labelledby="xpanel-resources-heading">
        <div class="xp-card__header"><h1 id="xpanel-resources-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1></div>
        <div class="xp-kpi-grid">
          <div class="xp-form-group"><span class="xp-label">${isAr ? 'الحساب' : 'Account'}</span><strong><bdi dir="ltr">${escapeHtml(account.username)}</bdi></strong></div>
          <div class="xp-form-group"><span class="xp-label">${isAr ? 'النطاق الأساسي' : 'Primary domain'}</span><strong><bdi dir="ltr">${escapeHtml(account.primaryDomain)}</bdi></strong></div>
          <div class="xp-form-group"><span class="xp-label">${isAr ? 'الخطة' : 'Plan'}</span><strong>${escapeHtml(plan?.name ?? (isAr ? 'غير متاحة' : 'Unavailable'))}</strong></div>
          <div class="xp-form-group"><span class="xp-label">${isAr ? 'الحالة' : 'Status'}</span>${renderStatusBadge(account.status === 'active' ? 'ok' : 'suspended', account.status)}</div>
        </div>
        <p class="xp-prose" role="status" data-resource-metrics="unavailable">${isAr ? 'لم تتوفر قياسات استخدام الموارد بعد.' : 'Resource usage measurements are not available yet.'}</p>
      </section>
` : ''}
      ${section === 'domains' ? `      <!-- 2. Domains & Multi-IP Binding Table -->
      <section class="xp-card" id="xpanel-domains" data-section="domains-multi-ip" aria-labelledby="xpanel-domains-heading">
        <div class="xp-card__header">
          <div>
            <h1 id="xpanel-domains-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
            <p class="xp-prose">${isAr ? 'ربط كل نطاق بعنوان IPv4 وIPv6 مخصص أو مشترك، واختيار إصدار PHP (8.1..8.4) والمعالج (fpm / cgi / lsphp) وشهادة ACME SSL.' : 'Bind each primary, addon, subdomain, or alias to dedicated/shared IPv4 & IPv6 addresses, select PHP 8.1..8.4 handler (fpm, cgi, lsphp), and manage ACME HTTP-01/DNS-01 wildcard TLS.'}</p>
          </div>
          ${renderStatusBadge('ok', `${domains.length} ${isAr ? 'نطاقات' : 'domains'}`)}
        </div>

        <div class="xp-table-wrap">
          <table class="xp-table" data-domains-table="true">
            <thead>
              <tr>
                <th>${isAr ? 'النطاق والنوع' : 'Domain & Kind'}</th>
                <th>${isAr ? 'مسار الجذر (Document Root)' : 'Document Root'}</th>
                <th>${isAr ? 'عناوين IPv4 / IPv6 المربوطة' : 'Bound IPv4 & IPv6'}</th>
                <th>${isAr ? 'إصدار ومعالج PHP / Upstream' : 'PHP Version & Handler / Runtime'}</th>
                <th>${isAr ? 'شهادة TLS / Wildcard' : 'TLS Certificate'}</th>
              </tr>
            </thead>
            <tbody>
              ${domains
                .map(
                  (dom) => `
                <tr data-domain-row="${escapeHtml(dom.name)}">
                  <td>
                    <strong class="xp-mono"><bdi dir="ltr">${escapeHtml(dom.name)}</bdi></strong>
                    <div>${renderStatusBadge('ok', dom.kind)} ${dom.wildcard ? renderStatusBadge('ok', '*.wildcard') : ''}</div>
                  </td>
                  <td><code class="xp-mono"><bdi dir="ltr">${escapeHtml(dom.docRoot)}</bdi></code></td>
                  <td class="xp-mono xp-tabular">
                    <bdi dir="ltr">IPv4: ${escapeHtml(dom.ipv4 ?? account.ipv4)}<br/>IPv6: ${escapeHtml(dom.ipv6 ?? account.ipv6 ?? '—')}</bdi>
                  </td>
                  <td class="xp-mono">
                    <bdi dir="ltr">${dom.siteType === 'node' ? `Node.js → ${escapeHtml(dom.upstream ?? '')}` : `PHP ${escapeHtml(dom.php.version)} (${escapeHtml(dom.php.handler)} · ${escapeHtml(dom.php.fpm.mode)})`}</bdi>
                  </td>
                  <td>
                    ${renderStatusBadge(dom.certificateId ? 'ok' : 'suspended', dom.certificateId ? (isAr ? 'شهادة مضبوطة' : 'Certificate configured') : (isAr ? 'لا توجد شهادة' : 'No certificate'))}
                  </td>
                </tr>
              `,
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </section>

` : ''}
      ${section === 'config' && customConfig ? `      <!-- 3. Smart & Dynamic Custom Configurations (userdata model) -->
      <section class="xp-card" id="xpanel-userdata" data-section="userdata-custom-config" aria-labelledby="xpanel-userdata-heading">
        <div class="xp-card__header">
          <div>
            <h1 id="xpanel-userdata-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
            <p class="xp-prose">${escapeHtml(t(locale, 'userdata.subtitle'))}</p>
          </div>
          ${generationId !== undefined ? renderStatusBadge('ok', `userdata · Gen #${generationId}`) : ''}
        </div>

        <!-- Isolation & Forbidden Directive Guard Notice -->
        <div class="xp-reconcile-banner" style="margin-block-end: var(--xp-space-field);" data-userdata-guard-notice="true">
          <div style="display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px;">
            <div>
              <strong>${isAr ? 'فحص الأمان والعزل التلقائي قبل إعادة تحميل Nginx وApache' : 'Live Isolation Validator & Atomic Pre-Reload Test (nginx -t & apachectl configtest)'}</strong>
              <p style="margin: 4px 0 0; font-size: 0.85rem; color: var(--xp-text-secondary);">
                ${isAr ? 'يُمنع مستخدمو الحسابات من تمرير توجيهات الجذر الخطرة مثل user, pid, root, alias, SuexecUserGroup, AssignUserId, LoadModule, Listen. أي خطأ في الصياغة يُبقي الجيل السابق نشطاً.' : 'Tenant drop-ins automatically block privilege/isolation-escaping directives (user, pid, root, alias, include, SuexecUserGroup, AssignUserId, LoadModule, Listen). Syntax failures keep the previous applied generation active.'}
              </p>
            </div>
            ${renderStatusBadge('ok', 'nginx -t & apachectl configtest')}
          </div>
        </div>

        <form class="xp-form-group" action="/api/xpanel/domains/custom-config" method="post" data-userdata-form="true">
          <div class="xp-kpi-grid">
            <!-- Editor 1: Nginx Drop-in -->
            <div class="xp-card">
              <label class="xp-label" for="userdata-nginx-include">
                1. ${escapeHtml(t(locale, 'userdata.nginxInclude'))}
              </label>
              <div class="xp-mono" style="font-size: 0.78rem; color: var(--xp-text-muted); margin-block: 4px;">
                <bdi dir="ltr">/etc/xpanel/userdata/${escapeHtml(account.username)}/${escapeHtml(customConfig.domainName)}/nginx.conf</bdi>
              </div>
              <textarea id="userdata-nginx-include" name="nginxInclude" rows="6" class="xp-textarea xp-mono" dir="ltr">${escapeHtml(customConfig.nginxInclude)}</textarea>
            </div>

            <!-- Editor 2: Apache Drop-in -->
            <div class="xp-card">
              <label class="xp-label" for="userdata-apache-include">
                2. ${escapeHtml(t(locale, 'userdata.apacheInclude'))}
              </label>
              <div class="xp-mono" style="font-size: 0.78rem; color: var(--xp-text-muted); margin-block: 4px;">
                <bdi dir="ltr">/etc/xpanel/userdata/${escapeHtml(account.username)}/${escapeHtml(customConfig.domainName)}/apache.conf</bdi>
              </div>
              <textarea id="userdata-apache-include" name="apacheInclude" rows="6" class="xp-textarea xp-mono" dir="ltr">${escapeHtml(customConfig.apacheInclude)}</textarea>
            </div>

            <!-- Editor 3: PHP .user.ini + Custom Headers + Cache Bypass -->
            <div class="xp-card">
              <label class="xp-label" for="userdata-user-ini">
                3. ${escapeHtml(t(locale, 'userdata.userIni'))} (<bdi dir="ltr">/home/${escapeHtml(account.username)}/public_html/.user.ini</bdi>)
              </label>
              <textarea id="userdata-user-ini" name="userIni" rows="4" class="xp-textarea xp-mono" dir="ltr">${escapeHtml(userIniLines)}</textarea>

              <label class="xp-label" for="userdata-custom-headers" style="display: block; margin-block-start: 10px;">
                ${escapeHtml(t(locale, 'userdata.customHeaders'))} &amp; ${escapeHtml(t(locale, 'userdata.cacheBypassPaths'))}
              </label>
              <textarea id="userdata-custom-headers" name="customHeaders" rows="3" class="xp-textarea xp-mono" dir="ltr">${escapeHtml(customHeaderLines)}\nBypass: ${escapeHtml(customConfig.cacheBypassPaths.join(', '))}</textarea>
            </div>
          </div>

          <!-- Save Bar: Review changes -> Reconciling -> Applied in generation #N -->
          <div style="display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; padding-block-start: 8px;" data-userdata-save-bar="true">
            <div style="display: flex; align-items: center; gap: 10px;">
              ${renderStatusBadge('suspended', isAr ? 'راجع التغييرات قبل تطبيقها' : 'Review changes before applying')}
            </div>
            <button type="submit" class="xp-btn xp-btn--primary" data-action="apply-userdata">
              ${escapeHtml(t(locale, 'userdata.testAndApply'))}
            </button>
          </div>
        </form>
      </section>

` : ''}
      ${section === 'analytics' && websiteAnalytics ? `      <!-- 4. Real-Time Website Analytics -->
      <section class="xp-card" id="xpanel-analytics" data-section="website-analytics" aria-labelledby="xpanel-analytics-heading">
        <div class="xp-card__header">
          <div>
            <h1 id="xpanel-analytics-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
          </div>
          ${renderStatusBadge('ok', `${websiteAnalytics.totals.cacheHitRatioPercent.toFixed(1)}% Cache Hit`)}
        </div>
        ${renderWebsiteAnalyticsChart(websiteAnalytics, locale)}
      </section>

` : ''}
      ${section === 'files' ? `      <!-- 5. Jailed File Manager (/home/<user>, 0640/0750 Permission Guard, .trash) -->
      <section class="xp-card" id="xpanel-file-manager" data-section="jailed-file-manager" aria-labelledby="xpanel-files-heading">
        <div class="xp-card__header">
          <div>
            <h1 id="xpanel-files-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
            <p class="xp-prose">${escapeHtml(t(locale, 'files.jailNotice'))}</p>
          </div>
          <div style="display: flex; flex-wrap: wrap; gap: 8px;">
            ${renderStatusBadge('ok', 'O_NOFOLLOW Symlink-Safe')}
            ${renderStatusBadge('ok', 'Max File 0640 · Dir 0750 (0777 Blocked)')}
          </div>
        </div>

        <!-- File Manager Toolbar & Breadcrumb -->
        <div style="display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; margin-block-end: var(--xp-space-field);">
          <nav aria-label="File manager breadcrumb" class="xp-mono">
            <bdi dir="ltr">${escapeHtml(account.home)}</bdi>
          </nav>
          <div style="display: flex; flex-wrap: wrap; gap: 8px;">
            <button type="button" class="xp-btn xp-btn--primary" data-action="upload-file">${escapeHtml(t(locale, 'files.upload'))}</button>
            <button type="button" class="xp-btn" data-action="new-file">${escapeHtml(t(locale, 'files.newFile'))}</button>
            <button type="button" class="xp-btn" data-action="new-folder">${escapeHtml(t(locale, 'files.newFolder'))}</button>
            <button type="button" class="xp-btn" data-action="empty-trash">${isAr ? 'إفراغ المهملات (.trash)' : 'Empty .trash'}</button>
          </div>
        </div>

        <div class="xp-table-wrap">
          <table class="xp-table" data-file-manager-table="true">
            <thead>
              <tr>
                <th>${isAr ? 'الاسم والمسار' : 'Name & Jail Path'}</th>
                <th>${isAr ? 'النوع' : 'Kind'}</th>
                <th>${isAr ? 'الحجم' : 'Size'}</th>
                <th>${isAr ? 'الصلاحيات (Octal)' : 'Permissions (chmod)'}</th>
                <th>${isAr ? 'آخر تعديل' : 'Modified (UTC)'}</th>
                <th>${isAr ? 'الإجراء' : 'Action'}</th>
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
                  <td>${renderStatusBadge(f.trashed ? 'warn' : 'ok', f.trashed ? '.trash' : f.kind)}</td>
                  <td class="xp-mono xp-tabular" data-numeric="true">${escapeHtml(formatBytes(f.sizeBytes))}</td>
                  <td class="xp-mono xp-tabular"><code>${escapeHtml(f.modeOctal)}</code></td>
                  <td class="xp-mono xp-tabular"><time datetime="${escapeHtml(f.modifiedAt)}">${escapeHtml(f.modifiedAt)}</time></td>
                  <td>
                    ${
                      f.trashed
                        ? `<button type="button" class="xp-btn" data-action="restore-file" data-path="${escapeHtml(f.path)}">${isAr ? 'استعادة من .trash' : 'Restore from .trash'}</button>`
                        : `<button type="button" class="xp-btn" data-action="chmod-file" data-path="${escapeHtml(f.path)}">${escapeHtml(t(locale, 'files.chmod'))}</button>`
                    }
                  </td>
                </tr>
              `,
                )
                .join('')}
            </tbody>
          </table>
        </div>

        <!-- In-Browser Code Editor (<= 1 MiB) + Chmod Isolation Policy Card -->
        <div class="xp-golden-grid" style="margin-block-start: var(--xp-space-card);">
          <div class="xp-card" data-in-browser-editor="true">
            <div class="xp-card__header">
              <strong>${escapeHtml(t(locale, 'files.editor'))} — <code class="xp-mono"><bdi dir="ltr">${escapeHtml(account.home)}</bdi></code></strong>
              ${renderStatusBadge('ok', '<= 1 MiB Safe Edit')}
            </div>
            <label class="xp-sr-only" for="jailed-code-editor">File contents</label>
            <textarea id="jailed-code-editor" rows="5" class="xp-textarea xp-mono" dir="ltr"></textarea>
          </div>

          <div class="xp-card" data-chmod-policy-modal="true">
            <div class="xp-card__header">
              <strong>${escapeHtml(t(locale, 'files.chmod'))} Guard (0640 / 0750)</strong>
              ${renderStatusBadge('ok', '0777 Forbidden')}
            </div>
            <p class="xp-prose">
              ${isAr ? 'تُفرض صلاحيات ≤ 0640 للملفات و≤ 0750 للمجلدات لمنع قراءة الملفات بين الحسابات المختلفة؛ الصلاحية 0777 محظورة تماماً.' : 'Files are capped at mode <= 0640 and directories at <= 0750. World-writable permissions (0777 / 0666) are blocked to guarantee multi-tenant UID isolation.'}
            </p>
            <div>
              <label class="xp-label" for="chmod-octal-input">Octal Mode (0600, 0640, 0700, 0750)</label>
              <input id="chmod-octal-input" type="text" class="xp-input xp-mono" dir="ltr" value="0640" pattern="0[67][045]0" />
            </div>
          </div>
        </div>
      </section>

` : ''}
      ${section === 'terminal' ? `      <!-- 6. Jailed Shell Terminal (systemd-run --slice=xpanel-<uid>.slice --uid=<uid>) -->
      <section class="xp-card" id="xpanel-terminal" data-section="jailed-shell-terminal" aria-labelledby="xpanel-terminal-heading">
        <div class="xp-card__header">
          <div>
            <h1 id="xpanel-terminal-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
            <p class="xp-prose">${escapeHtml(t(locale, 'terminal.sliceNotice', { uid: account.uid }))}</p>
          </div>
          ${renderStatusBadge(shellEnabled ? 'ok' : 'suspended', shellEnabled ? `Jailed (${sliceUnit})` : 'Shell Disabled (plan.shell=none)')}
        </div>

        ${
          shellEnabled
            ? `
          <div style="margin-block-end: 12px;">
            <span class="xp-label">${isAr ? 'الأوامر المسموحة (Allowlisted Binaries):' : 'Allowlisted Jailed Binaries:'}</span>
            <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-block-start: 6px;">
              ${ALLOWLISTED_SHELL_BINARIES.map((bin) => `<code class="xp-mono">${escapeHtml(bin)}</code>`).join(' · ')}
            </div>
          </div>

          <pre class="xp-terminal" dir="ltr" data-terminal-output="${escapeHtml(terminalSessionId ?? '')}">${escapeHtml(isAr ? 'لم تبدأ جلسة طرفية بعد.' : 'No terminal session has started.')}</pre>

          <form style="display: flex; gap: 10px; margin-block-start: 12px;" action="/api/xpanel/terminal/exec" method="post" data-terminal-form="true">
            <label class="xp-sr-only" for="terminal-command-input">${escapeHtml(t(locale, 'terminal.promptPlaceholder'))}</label>
            <input id="terminal-command-input" name="command" type="text" class="xp-input xp-mono" dir="ltr" placeholder="composer status --no-interaction" />
            <button type="submit" class="xp-btn xp-btn--primary">${escapeHtml(t(locale, 'terminal.run'))}</button>
          </form>
        `
            : `
          <div class="xp-reconcile-banner" role="status" data-terminal-disabled="true">
            ${renderStatusBadge('suspended', 'Shell Access Disabled (shell: none)')}
            <p class="xp-prose">${isAr ? 'وصول الطرفية غير مفعل في خطتك الحالية.' : 'Interactive jailed shell access is disabled on your current hosting plan (plan.shell === "none").'}</p>
          </div>
        `
        }
      </section>

` : ''}
            <!-- 7. Databases (MariaDB + .trash), Email & FTP Users, and DNS Zone Editor -->

${section === 'databases' ? `        <section class="xp-card" data-section="mariadb-databases" aria-labelledby="xpanel-db-heading">
          <div class="xp-card__header">
            <h1 id="xpanel-db-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
            ${renderStatusBadge('ok', `${databases.filter((d) => !d.trashedAt).length} active · ${databases.filter((d) => d.trashedAt).length} in .trash`)}
          </div>
          <div class="xp-table-wrap">
            <table class="xp-table">
              <thead>
                <tr>
                  <th>${isAr ? 'قاعدة البيانات' : 'Database'}</th>
                  <th>${isAr ? 'المحرك' : 'Engine'}</th>
                  <th>${isAr ? 'الحالة / الاستعادة' : 'State / Trash Recovery'}</th>
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
                          ? `${renderStatusBadge('warn', `Trashed (${db.trashedAt})`)} <button type="button" class="xp-btn" data-action="restore-db" data-db="${escapeHtml(db.name)}">${isAr ? 'استعادة' : 'Restore'}</button>`
                          : renderStatusBadge('ok', t(locale, 'common.status.active'))
                      }
                    </td>
                  </tr>
                `,
                  )
                  .join('')}
              </tbody>
            </table>
          </div>

</section>` : ''}
      ${section === 'users' ? `          <section class="xp-card" data-section="service-users">
            <div class="xp-card__header">
              <h1 class="xp-page-title">${escapeHtml(pageTitle)}</h1>
              ${renderStatusBadge('ok', `${serviceUsers.length} Service Logins`)}
            </div>
            <div class="xp-table-wrap">
              <table class="xp-table">
                <thead>
                  <tr>
                    <th>Login</th>
                    <th>Services</th>
                    <th>Mailbox Quota</th>
                  </tr>
                </thead>
                <tbody>
                  ${serviceUsers
                    .map(
                      (u) => `
                    <tr data-service-user="${escapeHtml(u.login)}">
                      <td class="xp-mono"><bdi dir="ltr">${escapeHtml(u.login)}</bdi></td>
                      <td>
                        ${u.services.email ? renderStatusBadge('ok', 'Email') : ''}
                        ${u.services.ftp ? renderStatusBadge('ok', `FTP (${u.ftpDir})`) : ''}
                      </td>
                      <td class="xp-mono xp-tabular">${String(u.mailboxQuotaMb)} MB</td>
                    </tr>
                  `,
                    )
                    .join('')}
                </tbody>
              </table>
            </div>
          </section>

` : ''}
      ${section === 'dns' ? `        <!-- PowerDNS Zone Record Editor -->
        <aside class="xp-card" data-section="dns-zone-editor" aria-labelledby="xpanel-dns-heading">
          <div class="xp-card__header">
            <h1 id="xpanel-dns-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
            ${renderStatusBadge('ok', 'PowerDNS BIND Zone')}
          </div>
          <div class="xp-table-wrap">
            <table class="xp-table xp-table--compact">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>TTL</th>
                  <th>Content</th>
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
            ${section === undefined || (section === 'config' && !customConfig) || (section === 'analytics' && !websiteAnalytics) ? renderSurfaceUnavailable(locale, '/home') : ''}`,
  })
  return ensureAccessibleSurfaceHtml(rawHtml.trim(), locale)
}
