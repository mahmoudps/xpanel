import { visibleNavigation, type CatalogTool, type VisibilityContext } from '@xpanel/catalog'
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
} from '@xpanel/core'
import { renderWebsiteAnalyticsChart } from '../charts.ts'
import { auditActionLabel, auditTargetLabel } from '../audit-labels.ts'
import { formatDisplayName } from '../display-name.ts'
import { type Locale, t } from '../i18n.ts'
import {
  type AsyncActionBannerProps,
  ensureAccessibleSurfaceHtml,
  escapeHtml,
  formatAsciiDate,
  formatBytes,
  renderAsyncActionState,
  renderStatusBadge,
} from '../tokens.ts'
import { renderAccountResources, resourceRowsFromPlan } from '../board-canvas.ts'
import { renderXpanelHome, xpanelHomeFromProps } from '../board-port/xpanel-home.ts'
import { renderDesignMain, renderDesignNav } from '../design-board.ts'
import { renderSurfaceShell, renderSurfaceUnavailable, resolveSurfaceSection, renderUnavailableSurfaceShell, getSurfacePageTitle, normalizeSurfaceRoute, renderLiveUpdatesIndicator, renderPageSearchButton } from '../shell.ts'


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
  /** Public xMail origin from XPANEL_MAIL_PUBLIC_ORIGIN. */
  mailOrigin?: string
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

  if (section === 'overview') {
    const homePlan = plan && plan.id === account.planId ? plan : undefined
    return ensureAccessibleSurfaceHtml(renderXpanelHome(xpanelHomeFromProps({
      locale,
      account,
      ...(homePlan ? { plan: homePlan } : {}),
      domains,
      databases,
      databaseUsers,
      serviceUsers: props.serviceUsers ?? [],
      files: props.files ?? [],
      dnsRecords,
      ...(generationId !== undefined ? { generationId } : {}),
      actionHtml: actionBannerHtml,
      ...(accountRoutes ? { qualifiedRoutes: accountRoutes } : {}),
      ...(props.usage ? { usage: props.usage } : {}),
      ...(props.lastSignInAt ? { lastSignInAt: props.lastSignInAt } : {}),
      ...(props.recentAudit ? { recentChanges: props.recentAudit.map(entry => ({
        pill: isAr ? 'تدقيق' : 'Audit',
        pillBg: '#EEF0F3',
        pillFg: '#344054',
        titleHtml: escapeHtml(auditActionLabel(entry.action, locale, entry)),
        detailHtml: escapeHtml(auditTargetLabel(entry.target, locale)),
      })) } : {}),
      signOutLabel: isAr ? 'تسجيل الخروج' : 'Sign out',
      ...(props.mailOrigin ? { mailOrigin: props.mailOrigin } : {}),
    })), locale)
  }

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

    ${renderDesignNav('xpanel', locale, activeRoute, qualifiedRoutes, props.mailOrigin)}`,
    topbar: `      <div class="xp-topbar__start">
        ${renderPageSearchButton(locale)}

        <label class="xp-sr-only" for="xpanel-domain-switcher">${isAr ? 'اختر النطاق' : 'Active domain'}</label>
        <select id="xpanel-domain-switcher" class="xp-select xp-mono" style="width: auto;" data-domain-switcher="true">
          ${domains
            .map(
              (d) => `<option value="${escapeHtml(d.name)}" ${d.name === activeDomain ? 'selected' : ''}>${escapeHtml(d.name)} (${escapeHtml(isAr ? (d.kind === 'addon' ? 'إضافي' : d.kind === 'subdomain' ? 'فرعي' : d.kind === 'alias' ? 'اسم بديل' : 'أساسي') : d.kind)})</option>`,
            )
            .join('')}
        </select>
      </div>

      <div class="xp-topbar__end">
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
        <div class="xp-account-actions">
          <span class="xp-account-pill"><span class="xp-account-pill__avatar" aria-hidden="true">${escapeHtml(account.username.slice(0, 1).toLowerCase())}</span><span class="xp-mono xp-account-actions__name">${escapeHtml(account.username)}</span></span>
          <button type="button" class="xp-btn xp-btn--ghost" data-action="logout">${escapeHtml(isAr ? 'تسجيل الخروج' : 'Sign out')}</button>
        </div>
      </div>`,
    content: `      ${actionBannerHtml}
${section === 'resources' ? renderAccountResources(locale, account.uid, resourceRowsFromPlan(plan?.resources ?? null)) : ''}
      ${section === 'domains' ? `      <!-- 2. Domains & Multi-IP Binding Table -->
      <section class="xp-card" id="xpanel-domains" data-section="domains-multi-ip" aria-labelledby="xpanel-domains-heading">
        <div class="xp-card__header">
          <div>
            <h1 id="xpanel-domains-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
            <p class="xp-prose">${isAr ? 'إدارة النطاقات والمجلدات وعناوين IP وإعدادات PHP والشهادات.' : 'Manage domains, document roots, IP addresses, PHP settings and certificates.'}</p>
          </div>
          ${renderStatusBadge('ok', `${domains.length} ${isAr ? 'نطاقات' : 'domains'}`)}
        </div>

        <div class="xp-table-wrap">
          <table class="xp-table" data-domains-table="true">
            <thead>
              <tr>
                <th>${isAr ? 'النطاق والنوع' : 'Domain / Type'}</th>
                <th>${isAr ? 'مجلد الموقع' : 'Document root'}</th>
                <th>${isAr ? 'عناوين IP' : 'IP addresses'}</th>
                <th>${isAr ? 'PHP / بيئة التشغيل' : 'PHP / Runtime'}</th>
                <th>${isAr ? 'شهادة TLS' : 'TLS certificate'}</th>
                <th>${isAr ? 'الإجراء' : 'Action'}</th>
              </tr>
            </thead>
            <tbody>
              ${domains
                .map(
                  (dom) => `
                <tr data-domain-row="${escapeHtml(dom.name)}">
                  <td>
                    <strong class="xp-mono"><bdi dir="ltr">${escapeHtml(dom.name)}</bdi></strong>
                    <div>${renderStatusBadge('ok', isAr ? (dom.kind === 'addon' ? 'إضافي' : dom.kind === 'subdomain' ? 'فرعي' : dom.kind === 'alias' ? 'اسم بديل' : 'أساسي') : dom.kind)} ${dom.wildcard ? renderStatusBadge('ok', isAr ? 'بدل شامل' : 'Wildcard') : ''}</div>
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
                  <td>${dom.kind === 'primary' ? '' : `<button type="button" class="xp-btn" data-remove-domain="${escapeHtml(dom.id)}">${isAr ? 'إزالة' : 'Remove'}</button>`}</td>
                </tr>
              `,
                )
                .join('')}
            </tbody>
          </table>
        </div>
        <form class="xp-form-group" data-domain-form="true" data-account-username="${escapeHtml(account.username)}" data-primary-id="${escapeHtml(domains.find(domain => domain.kind === 'primary')?.id ?? '')}">
          <div class="xp-field">
            <label class="xp-label" for="domain-name">${isAr ? 'اسم النطاق' : 'Domain name'}</label>
            <input id="domain-name" name="name" type="text" class="xp-input xp-mono" dir="ltr" required placeholder="shop.example.test" />
          </div>
          <div class="xp-field">
            <label class="xp-label" for="domain-kind">${isAr ? 'النوع' : 'Type'}</label>
            <select id="domain-kind" name="kind" class="xp-select">
              <option value="addon">${isAr ? 'نطاق إضافي' : 'Addon domain'}</option>
              <option value="subdomain">${isAr ? 'نطاق فرعي' : 'Subdomain'}</option>
            </select>
          </div>
          <p class="xp-help">${isAr ? 'النطاق الفرعي يجب أن ينتهي باسم النطاق الأساسي.' : 'A subdomain must end with the primary domain.'}</p>
          <p class="xp-help" data-domain-status role="status" hidden></p>
          <button type="submit" class="xp-btn xp-btn--primary">${isAr ? 'إضافة النطاق' : 'Add domain'}</button>
        </form>
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
              <strong>${isAr ? 'فحص الإعدادات قبل التطبيق' : 'Configuration checks before applying'}</strong>
              <p style="margin: 4px 0 0; font-size: 0.85rem; color: var(--xp-text-secondary);">
                ${isAr ? 'توجيهات الصلاحيات والعزل محظورة: user, pid, root, alias, include, SuexecUserGroup, AssignUserId, LoadModule, Listen. عند فشل الفحص تبقى الإعدادات السابقة نشطة.' : 'Privilege and isolation directives are blocked: user, pid, root, alias, include, SuexecUserGroup, AssignUserId, LoadModule, Listen. Failed checks keep the previous configuration active.'}
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
          ${renderStatusBadge('ok', t(locale, 'analytics.cacheHitBadge', { percent: websiteAnalytics.totals.cacheHitRatioPercent.toFixed(1) }))}
        </div>
        ${renderWebsiteAnalyticsChart(websiteAnalytics, locale)}
      </section>

` : ''}
      ${section === 'files' ? `      <!-- 5. Jailed File Manager (/home/<user>, 0640/0750 Permission Guard, .trash) -->
      <section class="xp-card" id="xpanel-file-manager" data-section="jailed-file-manager" data-file-manager="${activeRoute === '/files/manager' ? 'browse' : 'trash'}" data-account-username="${escapeHtml(account.username)}" aria-labelledby="xpanel-files-heading">
        <div class="xp-card__header">
          <div>
            <h1 id="xpanel-files-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
            <p class="xp-prose">${escapeHtml(t(locale, 'files.jailNotice'))}</p>
            <p class="xp-help">${escapeHtml(t(locale, 'files.uploadLimit'))}</p>
          </div>
          <div style="display: flex; flex-wrap: wrap; gap: 8px;">
          </div>
        </div>

        <!-- File Manager Toolbar & Breadcrumb -->
        <div style="display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; margin-block-end: var(--xp-space-field);">
          <nav aria-label="File manager breadcrumb" class="xp-breadcrumb xp-mono">
            <bdi dir="ltr">${escapeHtml(account.home)}</bdi>
          </nav>
          <div style="display: flex; flex-wrap: wrap; gap: 8px;">
            <button type="button" class="xp-btn xp-btn--primary" data-action="upload-file">${escapeHtml(t(locale, 'files.upload'))}</button>
            <input id="jailed-file-upload" type="file" data-file-upload hidden />
            <button type="button" class="xp-btn" data-action="new-file">${escapeHtml(t(locale, 'files.newFile'))}</button>
            <button type="button" class="xp-btn" data-action="new-folder">${escapeHtml(t(locale, 'files.newFolder'))}</button>
            <button type="button" class="xp-btn" data-action="empty-trash">${isAr ? 'إفراغ المهملات' : 'Empty trash'}</button>
          </div>
        </div>

        <div class="xp-table-wrap">
          <table class="xp-table" data-file-manager-table="true">
            <thead>
              <tr>
                <th>${isAr ? 'الاسم والمسار' : 'Name / Path'}</th>
                <th>${isAr ? 'النوع' : 'Type'}</th>
                <th>${isAr ? 'الحجم' : 'Size'}</th>
                <th>${isAr ? 'الصلاحيات' : 'Permissions'}</th>
                <th>${isAr ? 'آخر تعديل (UTC)' : 'Modified (UTC)'}</th>
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
                  <td>${renderStatusBadge(f.trashed ? 'warn' : 'ok', f.trashed ? '.trash' : t(locale, f.kind === 'folder' ? 'files.kind.folder' : 'files.kind.file'))}</td>
                  <td class="xp-mono xp-tabular" data-numeric="true">${escapeHtml(formatBytes(f.sizeBytes))}</td>
                  <td class="xp-mono xp-tabular"><code>${escapeHtml(f.modeOctal)}</code></td>
                  <td class="xp-mono xp-tabular"><time datetime="${escapeHtml(f.modifiedAt)}">${escapeHtml(formatAsciiDate(f.modifiedAt, { includeTime: true }))}</time></td>
                  <td>
                    ${
                      f.trashed
                        ? `<button type="button" class="xp-btn" data-action="restore-file" data-path="${escapeHtml(f.path)}">${isAr ? 'استعادة' : 'Restore'}</button>`
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
              <h2>${escapeHtml(t(locale, 'files.editor'))} — <code class="xp-mono"><bdi dir="ltr">${escapeHtml(account.home)}</bdi></code></h2>
            </div>
            <label class="xp-sr-only" for="jailed-code-editor">${isAr ? 'محتوى الملف' : 'File contents'}</label>
            <textarea id="jailed-code-editor" rows="5" class="xp-textarea xp-mono" dir="ltr" data-editor-path=""></textarea>
            <button type="button" class="xp-btn xp-btn--primary" data-action="save-file">${isAr ? 'حفظ النص' : 'Save text'}</button>
            <p class="xp-help" data-file-status role="status" hidden></p>
          </div>

          <div class="xp-card xp-form-group" data-chmod-policy-modal="true">
            <div class="xp-card__header">
              <h2>${escapeHtml(t(locale, 'files.chmod'))} (0640 / 0750)</h2>
            </div>
            <p class="xp-prose">
              ${isAr ? 'الحد الأقصى للصلاحيات: 0640 للملفات و0750 للمجلدات. الصلاحيات 0777 و0666 محظورة لحماية الحسابات.' : 'Maximum permissions: 0640 for files and 0750 for folders. Modes 0777 and 0666 are blocked to protect accounts.'}
            </p>
            <div class="xp-field">
              <label class="xp-label" for="chmod-octal-input">${isAr ? 'الصلاحيات (0600, 0640, 0700, 0750)' : 'Permissions (0600, 0640, 0700, 0750)'}</label>
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
          ${renderStatusBadge(shellEnabled ? 'ok' : 'suspended', shellEnabled ? `Jailed (${sliceUnit})` : (isAr ? 'وصول الطرفية معطل' : 'Shell access disabled'))}
        </div>

        ${
          shellEnabled
            ? `
          <div style="margin-block-end: 12px;">
            <span class="xp-label">${isAr ? 'الأوامر المسموحة' : 'Allowed commands'}</span>
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
            ${renderStatusBadge('suspended', isAr ? 'وصول الطرفية معطل' : 'Shell access disabled')}
            <p class="xp-prose">${isAr ? 'وصول الطرفية غير مفعل في خطتك الحالية.' : 'Terminal access is disabled on your current plan.'}</p>
          </div>
        `
        }
      </section>

` : ''}
            <!-- 7. Databases (MariaDB + .trash), Email & FTP Users, and DNS Zone Editor -->

${section === 'databases' ? `        <section class="xp-card" data-section="mariadb-databases" aria-labelledby="xpanel-db-heading">
          <div class="xp-card__header">
            <h1 id="xpanel-db-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
            ${renderStatusBadge('ok', t(locale, 'databases.summary', { active: databases.filter((d) => !d.trashedAt).length, trashed: databases.filter((d) => d.trashedAt).length }))}
          </div>
          <div class="xp-table-wrap">
            <table class="xp-table">
              <thead>
                <tr>
                  <th>${isAr ? 'قاعدة البيانات' : 'Database'}</th>
                  <th>${isAr ? 'المحرك' : 'Engine'}</th>
                  <th>${isAr ? 'الحالة / الاستعادة' : 'Status / Recovery'}</th>
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
                          ? `${renderStatusBadge('warn', `${isAr ? 'في المهملات' : 'Trashed'} (${formatAsciiDate(db.trashedAt, { includeTime: true })})`)} <button type="button" class="xp-btn" data-action="restore-db" data-db="${escapeHtml(db.name)}">${isAr ? 'استعادة' : 'Restore'}</button>`
                          : `${renderStatusBadge('ok', t(locale, 'common.status.active'))} <button type="button" class="xp-btn" data-remove-database="${escapeHtml(db.id)}" data-database-name="${escapeHtml(db.name)}">${isAr ? 'حذف' : 'Delete'}</button>`
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
            <label class="xp-label" for="database-name">${isAr ? 'اسم قاعدة البيانات' : 'Database name'}</label>
            <input id="database-name" name="name" type="text" class="xp-input xp-mono" dir="ltr" required pattern="[a-z0-9][a-z0-9_]{0,40}" placeholder="shop" />
          </div>
          <p class="xp-help" data-database-status role="status" hidden></p>
          <button type="submit" class="xp-btn xp-btn--primary">${isAr ? 'إنشاء قاعدة البيانات' : 'Create database'}</button>
        </form>
        <dialog class="xp-account-dialog" data-database-delete-dialog aria-labelledby="database-delete-title">
          <form method="dialog">
            <div class="xp-account-dialog__header">
              <h2 id="database-delete-title">${isAr ? 'حذف قاعدة البيانات' : 'Delete database'}</h2>
              <p data-database-delete-copy>${isAr ? 'يحذف قاعدة البيانات نهائيا.' : 'Permanently deletes this database.'}</p>
            </div>
            <p class="xp-mono"><bdi dir="ltr" data-database-delete-name></bdi></p>
            <p class="xp-account-dialog__status" data-dialog-status role="status" hidden></p>
            <div class="xp-account-dialog__footer">
              <button type="button" class="xp-btn" data-dialog-cancel>${isAr ? 'إلغاء' : 'Cancel'}</button>
              <button type="submit" class="xp-btn xp-btn--primary">${isAr ? 'حذف' : 'Delete'}</button>
            </div>
          </form>
        </dialog>
        <div class="xp-table-wrap">
          <table class="xp-table">
            <thead><tr><th>${isAr ? 'مستخدم قاعدة البيانات' : 'Database user'}</th><th>${isAr ? 'الصلاحيات' : 'Grants'}</th><th></th></tr></thead>
            <tbody>
              ${databaseUsers.map(user => `<tr data-database-user="${escapeHtml(user.name)}"><td class="xp-mono"><bdi dir="ltr">${escapeHtml(user.name)}</bdi></td><td class="xp-mono">${escapeHtml(String(user.grants.length))}</td><td><button type="button" class="xp-btn" data-remove-database-user="${escapeHtml(user.id)}">${isAr ? 'حذف' : 'Delete'}</button></td></tr>`).join('')}
            </tbody>
          </table>
        </div>
        <form class="xp-form-group" data-database-user-form="true" data-account-username="${escapeHtml(account.username)}">
          <div class="xp-field">
            <label class="xp-label" for="database-user-name">${isAr ? 'اسم المستخدم' : 'User name'}</label>
            <input id="database-user-name" name="name" type="text" class="xp-input xp-mono" dir="ltr" required pattern="[a-z0-9][a-z0-9_]{0,24}" />
          </div>
          <div class="xp-field">
            <label class="xp-label" for="database-user-password">${isAr ? 'كلمة المرور' : 'Password'}</label>
            <input id="database-user-password" name="password" type="password" class="xp-input" minlength="8" required autocomplete="new-password" />
          </div>
          <div class="xp-field">
            <label class="xp-label" for="database-user-grant">${isAr ? 'منح على' : 'Grant on'}</label>
            <select id="database-user-grant" name="databaseId" class="xp-select">${databases.filter(db => !db.trashedAt).map(db => `<option value="${escapeHtml(db.id)}">${escapeHtml(db.name)}</option>`).join('')}</select>
          </div>
          <p class="xp-help" data-database-user-status role="status" hidden></p>
          <button type="submit" class="xp-btn xp-btn--primary">${isAr ? 'إنشاء المستخدم' : 'Create user'}</button>
        </form>

</section>` : ''}
      ${section === 'users' ? `          <section class="xp-card" data-section="service-users">
            <div class="xp-card__header">
              <h1 class="xp-page-title">${escapeHtml(pageTitle)}</h1>
              ${renderStatusBadge('ok', t(locale, 'email.serviceLogins', { count: serviceUsers.length }))}
            </div>
            <div class="xp-table-wrap">
              <table class="xp-table">
                <thead>
                  <tr>
                    <th>${escapeHtml(t(locale, 'email.col.login'))}</th>
                    <th>${escapeHtml(t(locale, 'email.col.services'))}</th>
                    <th>${escapeHtml(t(locale, 'email.col.quota'))}</th>
                    <th>${isAr ? 'الإجراء' : 'Action'}</th>
                  </tr>
                </thead>
                <tbody>
                  ${serviceUsers
                    .map(
                      (u) => `
                    <tr data-service-user="${escapeHtml(u.login)}">
                      <td class="xp-mono"><bdi dir="ltr">${escapeHtml(u.login)}</bdi></td>
                      <td>
                        ${u.services.email ? renderStatusBadge('ok', t(locale, 'email.service.email')) : ''}
                        ${u.services.ftp ? renderStatusBadge('ok', `FTP (${u.ftpDir})`) : ''}
                      </td>
                      <td class="xp-mono xp-tabular">${String(u.mailboxQuotaMb)} MB</td>
                      <td>
                        <button type="button" class="xp-btn" data-mailbox-password="${escapeHtml(u.id)}">${isAr ? 'كلمة المرور' : 'Password'}</button>
                        <button type="button" class="xp-btn" data-mailbox-quota="${escapeHtml(u.id)}" data-mailbox-quota-value="${escapeHtml(String(u.mailboxQuotaMb))}">${isAr ? 'الحصة' : 'Quota'}</button>
                        <button type="button" class="xp-btn" data-remove-mailbox="${escapeHtml(u.id)}">${isAr ? 'حذف' : 'Delete'}</button>
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
                <label class="xp-label" for="mailbox-local">${isAr ? 'الاسم' : 'Name'}</label>
                <input id="mailbox-local" name="localPart" type="text" class="xp-input xp-mono" dir="ltr" required pattern="[a-z0-9][a-z0-9._-]{0,31}" />
              </div>
              <div class="xp-field">
                <label class="xp-label" for="mailbox-domain">${isAr ? 'النطاق' : 'Domain'}</label>
                <select id="mailbox-domain" name="domainId" class="xp-select">${domains.map(domain => `<option value="${escapeHtml(domain.id)}">${escapeHtml(domain.name)}</option>`).join('')}</select>
              </div>
              <div class="xp-field">
                <label class="xp-label" for="mailbox-password">${isAr ? 'كلمة المرور' : 'Password'}</label>
                <input id="mailbox-password" name="password" type="password" class="xp-input" minlength="8" required autocomplete="new-password" />
              </div>
              <div class="xp-field">
                <label class="xp-label" for="mailbox-quota">${isAr ? 'الحصة (MB)' : 'Quota (MB)'}</label>
                <input id="mailbox-quota" name="mailboxQuotaMb" type="number" class="xp-input xp-mono" min="1" value="1024" required />
              </div>
              <p class="xp-help" data-mailbox-status role="status" hidden></p>
              <button type="submit" class="xp-btn xp-btn--primary">${isAr ? 'إنشاء صندوق البريد' : 'Create mailbox'}</button>
            </form>` : ''}
            <dialog class="xp-account-dialog" data-mailbox-password-dialog aria-labelledby="mailbox-password-title">
              <form method="dialog">
                <div class="xp-account-dialog__header">
                  <h2 id="mailbox-password-title">${isAr ? 'كلمة مرور صندوق البريد' : 'Mailbox password'}</h2>
                  <p>${isAr ? 'تُحفظ كلمة المرور الجديدة بعد التأكيد.' : 'The new password is saved after you confirm.'}</p>
                </div>
                <div class="xp-field">
                  <label class="xp-label" for="mailbox-password-next">${isAr ? 'كلمة المرور الجديدة' : 'New password'}</label>
                  <input id="mailbox-password-next" name="password" type="password" class="xp-input" minlength="8" required autocomplete="new-password" />
                </div>
                <p class="xp-account-dialog__status" data-dialog-status role="status" hidden></p>
                <div class="xp-account-dialog__footer">
                  <button type="button" class="xp-btn" data-dialog-cancel>${isAr ? 'إلغاء' : 'Cancel'}</button>
                  <button type="submit" class="xp-btn xp-btn--primary">${isAr ? 'حفظ' : 'Save'}</button>
                </div>
              </form>
            </dialog>
            <dialog class="xp-account-dialog" data-mailbox-quota-dialog aria-labelledby="mailbox-quota-title">
              <form method="dialog">
                <div class="xp-account-dialog__header">
                  <h2 id="mailbox-quota-title">${isAr ? 'حصة صندوق البريد' : 'Mailbox quota'}</h2>
                </div>
                <div class="xp-field">
                  <label class="xp-label" for="mailbox-quota-next">${isAr ? 'الحصة (MB)' : 'Quota (MB)'}</label>
                  <input id="mailbox-quota-next" name="mailboxQuotaMb" type="number" class="xp-input xp-mono" min="1" required />
                </div>
                <p class="xp-account-dialog__status" data-dialog-status role="status" hidden></p>
                <div class="xp-account-dialog__footer">
                  <button type="button" class="xp-btn" data-dialog-cancel>${isAr ? 'إلغاء' : 'Cancel'}</button>
                  <button type="submit" class="xp-btn xp-btn--primary">${isAr ? 'حفظ' : 'Save'}</button>
                </div>
              </form>
            </dialog>
          </section>

` : ''}
      ${section === 'dns' ? `        <!-- PowerDNS Zone Record Editor -->
        <aside class="xp-card" data-section="dns-zone-editor" aria-labelledby="xpanel-dns-heading">
          <div class="xp-card__header">
            <h1 id="xpanel-dns-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
            ${renderStatusBadge('ok', t(locale, 'dns.zoneBadge'))}
          </div>
          <div class="xp-table-wrap">
            <table class="xp-table xp-table--compact">
              <thead>
                <tr>
                  <th>${escapeHtml(t(locale, 'dns.col.name'))}</th>
                  <th>${escapeHtml(t(locale, 'dns.col.type'))}</th>
                  <th>TTL</th>
                  <th>${escapeHtml(t(locale, 'dns.col.content'))}</th>
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
      ${section === 'ssl' ? `<section class="xp-card" data-section="ssl-status" aria-labelledby="xpanel-ssl-heading">
        <div class="xp-card__header">
          <div>
            <h1 id="xpanel-ssl-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
            <p class="xp-prose">${isAr ? 'أصدر شهادة أو جدّدها لنطاق على هذا الحساب. يجيب الخادم على فحص <bdi dir="ltr">HTTP-01</bdi> عبر المنفذ 80.' : 'Issue or renew a certificate for a domain on this account. The server answers the HTTP-01 check on port 80.'}</p>
          </div>
        </div>
        <div class="xp-table-wrap">
          <table class="xp-table">
            <thead><tr><th>${isAr ? 'النطاق' : 'Domain'}</th><th>${isAr ? 'الشهادة' : 'Certificate'}</th></tr></thead>
            <tbody>${domains.map(domain => `<tr><td class="xp-mono"><bdi dir="ltr">${escapeHtml(domain.name)}</bdi></td><td>${renderStatusBadge(domain.certificateId ? 'ok' : 'suspended', domain.certificateId ? (isAr ? 'محفوظة' : 'Stored') : (isAr ? 'لا توجد شهادة' : 'No certificate'))}</td></tr>`).join('')}</tbody>
          </table>
        </div>
        ${domains.length > 0 ? `<form class="xp-form-group" data-certificate-form="true" data-account-username="${escapeHtml(account.username)}">
          <div class="xp-field">
            <label class="xp-label" for="certificate-domain">${isAr ? 'النطاق' : 'Domain'}</label>
            <select id="certificate-domain" name="domain" class="xp-input" required>
              ${domains.map(domain => `<option value="${escapeHtml(domain.name)}">${escapeHtml(domain.name)}</option>`).join('')}
            </select>
          </div>
          <p class="xp-help" data-certificate-status role="status" hidden></p>
          <button type="submit" class="xp-btn xp-btn--primary">${isAr ? 'إصدار أو تجديد' : 'Issue or renew'}</button>
        </form>
        <p class="xp-help">${isAr ? 'يبقى الفحص الفاشل في هذه الصفحة مع رسالة جهة الشهادات.' : 'A failed check stays on this page with the certificate authority message.'}</p>` : `<p class="xp-help">${isAr ? 'أضف نطاقًا قبل إصدار شهادة.' : 'Add a domain before issuing a certificate.'}</p>`}
      </section>` : ''}
            ${section === 'security' ? `<section class="xp-card" data-section="account-security"><h1 id="xpanel-security-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1></section>` : ''}
            ${section === 'design' ? renderDesignMain(activeRoute, locale) : ''}
            ${section === undefined || (section === 'config' && !customConfig) || (section === 'analytics' && !websiteAnalytics) ? renderSurfaceUnavailable(locale, '/home') : ''}`,
  })
  return ensureAccessibleSurfaceHtml(rawHtml.trim(), locale)
}
