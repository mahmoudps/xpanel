import { visibleNavigation, type CatalogTool, type VisibilityContext } from '@xpanel/catalog'
import type {
  Account,
  AuditEntry,
  FirewallRule,
  IoAnalyticsSnapshot,
  MailIpConfig,
  Plan,
  Principal,
  Reseller,
  ResellerAcl,
  ServerIpEntry,
} from '@xpanel/core'
import { renderServerIoMonitorChart } from '../charts.ts'
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

export { renderWhmExtendedSections } from './extended-views.ts'

export interface WhmServiceHealthRow {
  name: string
  unit: string
  version: string
  active: boolean
  enabled: boolean
  rssMb: number
  role: string
}

export interface WhmConfigGenerationRow {
  generationId: number
  at: string
  actor: string
  summary: string
  stateChecksum: string
  filesCount: number
  durationMs: number
  status: 'active' | 'superseded' | 'rolled-back'
}

export interface WhmSurfaceProps {
  visibility?: VisibilityContext
  catalog?: readonly CatalogTool[]
  locale?: Locale
  theme?: 'dark' | 'light'
  realtimeEnabled?: boolean
  principal?: Principal
  activeReseller?: Reseller | null
  activeRoute?: string
  hostname?: string
  version?: string
  availableVersion?: string
  generationId?: number
  adminSessionIp?: string
  ioSnapshot?: IoAnalyticsSnapshot
  services?: WhmServiceHealthRow[]
  plans?: Plan[]
  accounts?: Account[]
  resellers?: Reseller[]
  ipPool?: ServerIpEntry[]
  mailIpConfig?: MailIpConfig
  firewallRules?: FirewallRule[]
  generations?: WhmConfigGenerationRow[]
  auditEntries?: AuditEntry[]
  actionState?: AsyncActionBannerProps
}

const ALL_RESELLER_ACLS: readonly ResellerAcl[] = [
  'create-account',
  'edit-account',
  'suspend-account',
  'terminate-account',
  'change-plan',
  'manage-plans',
  'manage-feature-lists',
  'manage-dns',
  'manage-ssl',
  'change-password',
  'list-accounts',
  'allow-unlimited-plans',
  'allow-oversell',
  'transfer',
]

export const DEFAULT_WHM_IO_SNAPSHOT: IoAnalyticsSnapshot = {
  at: '2026-10-22T14:05:00Z',
  current: {
    at: '2026-10-22T14:05:00Z',
    readBytesPerSec: 28 * 1024 * 1024,
    writeBytesPerSec: 16 * 1024 * 1024,
    readIops: 640,
    writeIops: 410,
    awaitMs: 1.8,
    psiSomeAvg10: 2.4,
    psiFullAvg10: 0.3,
    cpuPercent: 34,
    memoryUsedBytes: 2.4 * 1024 * 1024 * 1024,
    memoryTotalBytes: 8 * 1024 * 1024 * 1024,
    loadAvg1m: 0.42,
  },
  history: [
    {
      at: '2026-10-22T14:01:00Z',
      readBytesPerSec: 18 * 1024 * 1024,
      writeBytesPerSec: 11 * 1024 * 1024,
      readIops: 420,
      writeIops: 290,
      awaitMs: 1.2,
      psiSomeAvg10: 1.4,
      psiFullAvg10: 0.1,
      cpuPercent: 26,
      memoryUsedBytes: 2.2 * 1024 * 1024 * 1024,
      memoryTotalBytes: 8 * 1024 * 1024 * 1024,
      loadAvg1m: 0.34,
    },
    {
      at: '2026-10-22T14:02:00Z',
      readBytesPerSec: 24 * 1024 * 1024,
      writeBytesPerSec: 14 * 1024 * 1024,
      readIops: 510,
      writeIops: 340,
      awaitMs: 1.5,
      psiSomeAvg10: 1.9,
      psiFullAvg10: 0.2,
      cpuPercent: 31,
      memoryUsedBytes: 2.3 * 1024 * 1024 * 1024,
      memoryTotalBytes: 8 * 1024 * 1024 * 1024,
      loadAvg1m: 0.38,
    },
    {
      at: '2026-10-22T14:03:00Z',
      readBytesPerSec: 36 * 1024 * 1024,
      writeBytesPerSec: 21 * 1024 * 1024,
      readIops: 790,
      writeIops: 520,
      awaitMs: 2.3,
      psiSomeAvg10: 3.1,
      psiFullAvg10: 0.5,
      cpuPercent: 42,
      memoryUsedBytes: 2.5 * 1024 * 1024 * 1024,
      memoryTotalBytes: 8 * 1024 * 1024 * 1024,
      loadAvg1m: 0.51,
    },
    {
      at: '2026-10-22T14:04:00Z',
      readBytesPerSec: 31 * 1024 * 1024,
      writeBytesPerSec: 18 * 1024 * 1024,
      readIops: 690,
      writeIops: 440,
      awaitMs: 1.9,
      psiSomeAvg10: 2.6,
      psiFullAvg10: 0.3,
      cpuPercent: 37,
      memoryUsedBytes: 2.4 * 1024 * 1024 * 1024,
      memoryTotalBytes: 8 * 1024 * 1024 * 1024,
      loadAvg1m: 0.45,
    },
    {
      at: '2026-10-22T14:05:00Z',
      readBytesPerSec: 28 * 1024 * 1024,
      writeBytesPerSec: 16 * 1024 * 1024,
      readIops: 640,
      writeIops: 410,
      awaitMs: 1.8,
      psiSomeAvg10: 2.4,
      psiFullAvg10: 0.3,
      cpuPercent: 34,
      memoryUsedBytes: 2.4 * 1024 * 1024 * 1024,
      memoryTotalBytes: 8 * 1024 * 1024 * 1024,
      loadAvg1m: 0.42,
    },
  ],
  accounts: [
    {
      accountId: 'acc-alice',
      username: 'alice',
      uid: 20014,
      readBytesPerSec: 14.2 * 1024 * 1024,
      writeBytesPerSec: 8.4 * 1024 * 1024,
      readIops: 310,
      writeIops: 195,
      memoryCurrentBytes: 620 * 1024 * 1024,
      memoryLimitMb: 1024,
      pidsCurrent: 38,
      pidsLimit: 128,
      cpuPercent: 28,
      statusLevel: 'ok',
    },
    {
      accountId: 'acc-omar',
      username: 'omar',
      uid: 20016,
      readBytesPerSec: 9.8 * 1024 * 1024,
      writeBytesPerSec: 5.2 * 1024 * 1024,
      readIops: 220,
      writeIops: 140,
      memoryCurrentBytes: 860 * 1024 * 1024,
      memoryLimitMb: 1024,
      pidsCurrent: 108,
      pidsLimit: 128,
      cpuPercent: 84,
      statusLevel: 'warn',
    },
    {
      accountId: 'acc-rania',
      username: 'rania',
      uid: 20010,
      readBytesPerSec: 4.0 * 1024 * 1024,
      writeBytesPerSec: 2.4 * 1024 * 1024,
      readIops: 110,
      writeIops: 75,
      memoryCurrentBytes: 1240 * 1024 * 1024,
      memoryLimitMb: 4096,
      pidsCurrent: 42,
      pidsLimit: 256,
      cpuPercent: 18,
      statusLevel: 'ok',
    },
  ],
}

export const renderWhmSurface = (props: WhmSurfaceProps = {}): string => {
  const locale: Locale = props.locale ?? 'en'
  const isAr = locale === 'ar'
  const theme = props.theme ?? 'dark'
  const principal = props.visibility?.principal ?? props.principal
  if (!principal) return ensureAccessibleSurfaceHtml(renderUnavailableSurfaceShell('xwhm', locale), locale)
  const isRoot = principal.kind === 'root'
  const activeRoute = normalizeSurfaceRoute('xwhm', props.activeRoute ?? '/whm')
  const section = resolveSurfaceSection('xwhm', activeRoute)
  const pageTitle = getSurfacePageTitle('xwhm', section, locale, activeRoute)
  const hostname = props.hostname ?? (isAr ? 'الخادم' : 'Server')
  const version = props.version ?? (isAr ? 'غير متاح' : 'Unavailable')
  const availableVersion = props.availableVersion ?? (isAr ? 'غير متاح' : 'Unavailable')
  const generationId = props.generationId !== undefined && Number.isSafeInteger(props.generationId) && props.generationId > 0 ? props.generationId : undefined
  const adminSessionIp = props.adminSessionIp ?? ''
  const ioSnapshot = props.ioSnapshot
  const services = props.services ?? []
  const plans = props.plans ?? []
  const accounts = props.accounts ?? []
  const resellers = props.resellers ?? []
  const ipPool = props.ipPool ?? []
  const mailIpConfig = props.mailIpConfig
  const firewallRules = props.firewallRules ?? []
  const generations = props.generations ?? []
  const auditEntries = props.auditEntries ?? []

  const whmNav = visibleNavigation(props.visibility, props.catalog).find((n) => n.surface === 'xwhm')
  const heldAcls = new Set<ResellerAcl>(props.visibility?.reseller?.acl ?? props.activeReseller?.acl ?? [])
  const sidebarSectionsHtml = (whmNav?.sections ?? [])
    .map((section) => {
      const visiblePages = section.pages
      if (visiblePages.length === 0) return ''
      const isExpanded = visiblePages.some((p) => p.route === activeRoute)
      return `
      <details class="xp-nav-section" ${isExpanded ? 'open' : ''} data-nav-section="${escapeHtml(section.id)}">
        <summary class="xp-nav-section__title">
          <span>${escapeHtml(getSurfaceNavigationLabel('xwhm', 'section', section, locale))}</span>
          <span class="xp-tabular">(${visiblePages.length})</span>
        </summary>
        <div class="xp-nav-section__items">
          ${visiblePages
            .map(
              (page) => `
            <a href="${escapeHtml(page.route)}" class="xp-nav-item ${page.route === activeRoute ? 'xp-nav-item--active' : ''}" ${page.route === activeRoute ? 'aria-current="page"' : ''} data-nav-route="${escapeHtml(page.route)}">
              <span>${escapeHtml(getSurfaceNavigationLabel('xwhm', 'page', page, locale))}</span>
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
  const memUsedGb = Number(((ioSnapshot?.current.memoryUsedBytes ?? 0) / (1024 * 1024 * 1024)).toFixed(1))
  const memTotalGb = Number(((ioSnapshot?.current.memoryTotalBytes ?? 0) / (1024 * 1024 * 1024)).toFixed(1))
  const actionBannerHtml = props.actionState
    ? renderAsyncActionState({ ...props.actionState, locale })
    : ''

  const rawHtml = renderSurfaceShell({
    surface: 'xwhm', locale,
    attributes: `data-principal-kind="${escapeHtml(principal.kind)}"`,
    sidebar: `    <div class="xp-sidebar__brand">
      <span class="xp-brand__mark" aria-hidden="true">x</span>
      <div>
        <strong>xWHM</strong>
        <div><bdi dir="ltr" class="xp-mono">${escapeHtml(hostname)}</bdi></div>
      </div>
    </div>

    <div class="xp-sidebar__favorites" aria-label="${isAr ? 'وصول سريع' : 'Quick access'}">
      <div class="xp-label">${isAr ? 'وصول سريع' : 'Quick access'}</div>
      ${(whmNav?.sections ?? []).flatMap(section => section.pages).slice(0, 3).map(page => `<a href="${escapeHtml(page.route)}" class="xp-nav-item">${escapeHtml(getSurfaceNavigationLabel('xwhm', 'page', page, locale))}</a>`).join('')}
    </div>

    <nav aria-label="xWHM sections">
      ${sidebarSectionsHtml || `<p role="status" data-navigation-empty="true">${escapeHtml(isAr ? 'لا توجد أدوات مثبتة الجاهزية ومتاحة لحسابك.' : 'No verified tools are available for your account.')}</p>`}
    </nav>`,
    topbar: `      <div class="xp-topbar__start" style="display: flex; align-items: center; gap: 12px;">
        <button type="button" class="xp-btn" data-action="open-cmdk" aria-keyshortcuts="Control+K Meta+K" aria-label="${isAr ? 'البحث في الأدوات والحسابات' : 'Search tools and accounts'}">
          <span>${isAr ? 'بحث' : 'Search'}</span>
          <kbd class="xp-mono">Ctrl K</kbd>
        </button>
      </div>

      <div class="xp-topbar__end" style="display: flex; flex-wrap: wrap; align-items: center; gap: 10px;">
        ${renderLiveUpdatesIndicator(locale, props.realtimeEnabled === true)}
        ${generationId !== undefined ? `<span data-generation-chip="${generationId}">
          ${renderStatusBadge('ok', `Gen #${generationId}`)}
        </span>` : ''}
        ${ioSnapshot ? `<span class="xp-mono xp-tabular" data-load-chip="true">
          ${renderStatusBadge('ok', `Load ${ioSnapshot.current.loadAvg1m.toFixed(2)} · RAM ${memUsedGb}/${memTotalGb} GB`)}
        </span>` : ''}
        <a class="xp-btn" href="/whm/jobs">
          <span>${isAr ? 'سجل النشاط والمهام' : 'Activity & Jobs'}</span>
        </a>
        <a href="?surface=xwhm&amp;lang=${switchLangCode}&amp;theme=${theme}" class="xp-btn" lang="${switchLangCode}" data-lang-switch="${switchLangCode}">
          ${escapeHtml(switchLangLabel)}
        </a>
        <a href="?surface=xwhm&amp;lang=${locale}&amp;theme=${nextTheme}" class="xp-btn" data-theme-toggle="${nextTheme}">
          ${escapeHtml(theme === 'dark' ? t(locale, 'common.theme.light') : t(locale, 'common.theme.dark'))}
        </a>
        <a href="/panel?lang=${locale}&amp;theme=${theme}" class="xp-btn xp-btn--ghost">xPanel</a>
        <a href="/mail?lang=${locale}&amp;theme=${theme}" class="xp-btn xp-btn--ghost">xMail</a>
        <span class="xp-mono" aria-label="Active operator">${escapeHtml(principal.username)}</span>
        <button type="button" class="xp-btn xp-btn--ghost" data-action="logout">${escapeHtml(isAr ? 'تسجيل الخروج' : 'Sign out')}</button>
      </div>`,
    content: `      ${actionBannerHtml}
${section === 'overview' ? `      <section class="xp-card" data-section="overview-attention">
        <div class="xp-card__header"><div><h1 class="xp-page-title">${escapeHtml(pageTitle)}</h1><p class="xp-prose"><bdi dir="ltr">${escapeHtml(hostname)}</bdi></p></div></div>
        <div class="xp-kpi-grid" data-section="whm-kpi-cards">
          <div class="xp-form-group"><span class="xp-label">${isAr ? 'الحسابات' : 'Accounts'}</span><strong>${props.accounts ? accounts.length : (isAr ? 'غير متاحة' : 'Unavailable')}</strong></div>
          <div class="xp-form-group"><span class="xp-label">${isAr ? 'الخطط' : 'Plans'}</span><strong>${props.plans ? plans.length : (isAr ? 'غير متاحة' : 'Unavailable')}</strong></div>
          <div class="xp-form-group"><span class="xp-label">${isAr ? 'الإصدار' : 'Version'}</span><strong><bdi dir="ltr">${escapeHtml(version)}</bdi></strong></div>
          <div class="xp-form-group"><span class="xp-label">${isAr ? 'المشغل' : 'Operator'}</span><strong><bdi dir="ltr">${escapeHtml(principal.username)}</bdi></strong></div>
        </div>
        ${!ioSnapshot ? `<p class="xp-prose" role="status">${isAr ? 'لم تتوفر قياسات موارد الخادم بعد.' : 'Server resource measurements are not available yet.'}</p>` : `<div class="xp-kpi-grid"><div class="xp-form-group"><span class="xp-label">CPU</span>${renderThresholdMeter(ioSnapshot.current.cpuPercent, 100, '%')}</div><div class="xp-form-group"><span class="xp-label">${isAr ? 'الذاكرة' : 'Memory'}</span>${renderThresholdMeter(memUsedGb, memTotalGb, 'GB')}</div></div>`}
      </section>
` : ''}
      ${section === 'io' && ioSnapshot ? `      <!-- Real-Time Server IO & Per-Account cgroup v2 Slice Monitor -->
      <section class="xp-card" id="whm-io-monitor" data-section="server-io-monitor" aria-labelledby="whm-io-heading">
        <div class="xp-card__header">
          <div>
            <h1 id="whm-io-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
            <p class="xp-prose">${escapeHtml(t(locale, 'io.subtitle'))}</p>
          </div>
          ${renderStatusBadge('ok', `PSI some=${ioSnapshot.current.psiSomeAvg10.toFixed(1)}% · full=${ioSnapshot.current.psiFullAvg10.toFixed(1)}%`)}
        </div>

        ${renderServerIoMonitorChart(ioSnapshot, locale)}
      </section>

` : ''}
      ${section === 'services' ? `      <!-- Service Health Table (nginx, apache/ols, php-fpm, mariadb, dovecot, postfix, pdns, nftables) -->
      <section class="xp-card" id="whm-services" data-section="service-health" aria-labelledby="whm-services-heading">
        <div class="xp-card__header">
          <div>
            <h1 id="whm-services-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
            <p class="xp-prose">${isAr ? 'تعمل فقط الخدمات المفعلة مع استهلاك ذاكرة منخفض ومراقبة فورية.' : 'Only enabled services run; PHP-FPM defaults to pm = ondemand and PowerDNS reads rendered BIND zone files with zero database overhead.'}</p>
          </div>
          ${renderStatusBadge('ok', `${services.filter((s) => s.active).length}/${services.length} Healthy`)}
        </div>
        <div class="xp-table-wrap">
          <table class="xp-table">
            <thead>
              <tr>
                <th>${isAr ? 'الخدمة' : 'Service'}</th>
                <th>${isAr ? 'وحدة systemd' : 'systemd Unit'}</th>
                <th>${isAr ? 'الإصدار' : 'Version'}</th>
                <th>${isAr ? 'الدور المعماري' : 'Role'}</th>
                <th>${isAr ? 'الذاكرة RSS' : 'RSS Memory'}</th>
                <th>${isAr ? 'الحالة' : 'Status'}</th>
              </tr>
            </thead>
            <tbody>
              ${services
                .map(
                  (svc) => `
                <tr data-service-row="${escapeHtml(svc.name)}">
                  <td><strong class="xp-mono"><bdi dir="ltr">${escapeHtml(svc.name)}</bdi></strong></td>
                  <td><code class="xp-mono"><bdi dir="ltr">${escapeHtml(svc.unit)}</bdi></code></td>
                  <td class="xp-mono"><bdi dir="ltr">${escapeHtml(svc.version)}</bdi></td>
                  <td>${escapeHtml(svc.role)}</td>
                  <td class="xp-tabular xp-mono" data-numeric="true">${svc.rssMb} MB</td>
                  <td>${renderStatusBadge(svc.active ? 'ok' : 'critical', svc.active ? t(locale, 'common.status.active') : 'Stopped')}</td>
                </tr>
              `,
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </section>

` : ''}
      ${section === 'accounts' || section === 'create-account' ? `      <!-- Accounts & Isolation Slice Table + Create Account Drawer + Terminate Confirmation -->
      <section class="xp-card" id="whm-accounts" data-section="accounts-isolation" aria-labelledby="whm-accounts-heading">
        <div class="xp-card__header">
          <div>
            <h1 id="whm-accounts-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
            <p class="xp-prose">${isAr ? 'كل حساب يعمل بمعرّف UID مستقل (20000+) داخل شريحة xpanel-<uid>.slice مع Apache mpm-itk (AssignUserId) وصلاحيات 0750 للمجلد الرئيسي.' : 'Every account owns a dedicated UID (20000+), a 0750 home directory, and an isolated systemd cgroup v2 slice (xpanel-<uid>.slice) with Apache mpm-itk AssignUserId.'}</p>
          </div>
          ${renderStatusBadge('ok', `${accounts.length} ${isAr ? 'حسابات' : 'accounts'}`)}
        </div>

${section === 'accounts' ? `        <div class="xp-table-wrap">
          <table class="xp-table">
            <thead>
              <tr>
                <th>${isAr ? 'المستخدم / UID' : 'Username / UID'}</th>
                <th>${isAr ? 'شريحة cgroup v2' : 'cgroup v2 Slice Unit'}</th>
                <th>${isAr ? 'النطاق الأساسي' : 'Primary Domain'}</th>
                <th>${isAr ? 'عناوين IPv4 / IPv6' : 'Bound IPv4 / IPv6'}</th>
                <th>${isAr ? 'الخطة / الصدفة' : 'Plan & Shell'}</th>
                <th>${isAr ? 'الحالة' : 'Status'}</th>
                <th>${isAr ? 'الإجراءات' : 'Actions'}</th>
              </tr>
            </thead>
            <tbody>
              ${accounts
                .map(
                  (acc) => `
                <tr data-account-row="${escapeHtml(acc.username)}">
                  <td>
                    <strong class="xp-mono"><bdi dir="ltr">${escapeHtml(acc.username)}</bdi></strong>
                    <span class="xp-mono xp-tabular"> (uid ${acc.uid})</span>
                  </td>
                  <td><code class="xp-mono"><bdi dir="ltr">xpanel-${acc.uid}.slice</bdi></code></td>
                  <td><code class="xp-mono"><bdi dir="ltr">${escapeHtml(acc.primaryDomain)}</bdi></code></td>
                  <td class="xp-mono">
                    <bdi dir="ltr">${escapeHtml(acc.ipv4)}${acc.ipv6 ? ` · ${escapeHtml(acc.ipv6)}` : ''}${acc.extraIps && acc.extraIps.length > 0 ? ` (+${acc.extraIps.join(', ')})` : ''}</bdi>
                  </td>
                  <td>
                    <span class="xp-mono">${escapeHtml(plans.find(plan => plan.id === acc.planId)?.name ?? (isAr ? 'غير متاحة' : 'Unavailable'))}</span> ·
                    <code class="xp-mono">shell:${escapeHtml(acc.shell)}</code>
                  </td>
                  <td>
                    ${renderStatusBadge(
                      acc.status === 'active' ? 'ok' : acc.status === 'suspended' ? 'suspended' : 'critical',
                      acc.status === 'active' ? t(locale, 'common.status.active') : t(locale, 'common.status.suspended'),
                    )}
                  </td>
                  <td>
                    <button type="button" class="xp-btn" data-action="suspend-account" data-username="${escapeHtml(acc.username)}">
                      ${acc.status === 'suspended' ? (isAr ? 'إلغاء التعليق' : 'Unsuspend') : escapeHtml(t(locale, 'accounts.suspend'))}
                    </button>
                  </td>
                </tr>
              `,
                )
                .join('')}
            </tbody>
          </table>
        </div>

` : ''}        <!-- Create Account + Type-to-Confirm Terminate Forms -->
        <div class="xp-golden-grid" style="margin-block-start: var(--xp-space-card);">
          ${section === 'create-account' ? `<form class="xp-card xp-form-group" id="whm-create-account-drawer" action="/api/whm/accounts" method="post" data-create-account-form="true">
            <div class="xp-card__header">
              <h3>${escapeHtml(t(locale, 'accounts.create'))}</h3>
              ${renderStatusBadge('ok', 'UID >= 20000')}
            </div>
            <div>
              <label class="xp-label" for="new-acc-username">${isAr ? 'اسم مستخدم النظام (Linux Username)' : 'System Username (UID 20000+)'}</label>
              <input id="new-acc-username" name="username" type="text" class="xp-input xp-mono" dir="ltr" required placeholder="salma" />
            </div>
            <div>
              <label class="xp-label" for="new-acc-domain">${isAr ? 'النطاق الأساسي' : 'Primary Domain'}</label>
              <input id="new-acc-domain" name="primaryDomain" type="text" class="xp-input xp-mono" dir="ltr" required placeholder="salma.studio" />
            </div>
            <div>
              <label class="xp-label" for="new-acc-plan">${isAr ? 'خطة الاستضافة' : 'Hosting Plan'}</label>
              <select id="new-acc-plan" name="planId" class="xp-select">
                ${plans.map(plan => `<option value="${escapeHtml(plan.id)}">${escapeHtml(plan.name)}</option>`).join('')}
              </select>
            </div>
            <div>
              <label class="xp-label" for="new-acc-ipv4">${isAr ? 'عنوان IPv4' : 'IPv4 Address'}</label>
              <input id="new-acc-ipv4" name="ipv4" type="text" class="xp-input xp-mono" dir="ltr" value="" />
            </div>
            <div>
              <label class="xp-label" for="new-acc-ipv6">${isAr ? 'عنوان IPv6' : 'IPv6 Address'}</label>
              <input id="new-acc-ipv6" name="ipv6" type="text" class="xp-input xp-mono" dir="ltr" value="" />
            </div>
            <button type="submit" class="xp-btn xp-btn--primary">${escapeHtml(t(locale, 'accounts.create'))}</button>
          </form>

          ` : ''}
          ${section === 'accounts' ? `<!-- Type-to-confirm Account Termination Guard -->
          <form class="xp-card xp-form-group" action="/api/whm/accounts/terminate" method="post" data-terminate-account-form="true">
            <div class="xp-card__header">
              <h3>${escapeHtml(t(locale, 'accounts.terminate'))}</h3>
              ${renderStatusBadge('critical', isAr ? 'يتطلب كتابة اسم الحساب للتأكيد' : 'Type-to-confirm required')}
            </div>
            <p class="xp-prose">
              ${isAr ? 'سيؤدي الحذف النهائي إلى إزالة المجلد الرئيسي /home/<user> وشريحة xpanel-<uid>.slice وقواعد بيانات MariaDB وصناديق البريد.' : 'Permanent termination removes /home/<user>, stops xpanel-<uid>.slice, deletes Nginx/Apache vhosts, mailboxes, and MariaDB databases.'}
            </p>
            <div>
              <label class="xp-label" for="terminate-confirm-user">${isAr ? 'اكتب اسم المستخدم للتأكيد النهائي' : 'Type the exact username to confirm termination'}</label>
              <input id="terminate-confirm-user" name="confirmUsername" type="text" class="xp-input xp-mono" dir="ltr" required placeholder="nour" data-type-to-confirm="true" />
            </div>
            <button type="submit" class="xp-btn">${escapeHtml(t(locale, 'accounts.terminate'))}</button>
          </form>` : ''}
        </div>
      </section>

` : ''}
      ${section === 'plans' ? `      <!-- Plans & Feature Lists + cgroup v2 Resource Limits Drawer -->
      <section class="xp-card" id="whm-plans" data-section="plans-feature-lists" aria-labelledby="whm-plans-heading">
        <div class="xp-card__header">
          <div>
            <h1 id="whm-plans-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
            <p class="xp-prose">${isAr ? 'تُطبَّق حدود الموارد مباشرة على شرائح cgroup v2 (CPUQuota, MemoryMax, io.max, TasksMax). القيمة غير المحدودة صريحة دائماً (Unlimited).' : 'Plan limits map directly to systemd cgroup v2 parameters (CPUQuota, MemoryMax, IOReadBandwidthMax, IOWriteBandwidthMax, IOReadIOPSMax, IOWriteIOPSMax, TasksMax). "Unlimited" is always explicit.'}</p>
          </div>
          ${renderStatusBadge('ok', `${plans.length} Plans · 3 Feature Lists`)}
        </div>

        <div class="xp-table-wrap">
          <table class="xp-table">
            <thead>
              <tr>
                <th>${isAr ? 'الخطة' : 'Plan'}</th>
                <th>${isAr ? 'القرص / الترافيك' : 'Disk / Bandwidth'}</th>
                <th>${isAr ? 'CPUQuota / MemoryMax' : 'CPUQuota / MemoryMax'}</th>
                <th>${isAr ? 'حدود io.max (قراءة/كتابة)' : 'io.max Read / Write'}</th>
                <th>${isAr ? 'العمليات (TasksMax)' : 'TasksMax (PIDs)'}</th>
                <th>${isAr ? 'النطاقات الإضافية' : 'Addon Domains'}</th>
                <th>${isAr ? 'الصدفة المعزولة' : 'Jailed Shell'}</th>
              </tr>
            </thead>
            <tbody>
              ${plans
                .map(
                  (plan) => `
                <tr data-plan-row="${escapeHtml(plan.name)}">
                  <td><strong>${escapeHtml(plan.name)}</strong></td>
                  <td class="xp-mono xp-tabular">${plan.resources.diskMb === 'unlimited' ? 'unlimited' : `${plan.resources.diskMb / 1024} GB`} / ${plan.resources.bandwidthMbMonth === 'unlimited' ? 'unlimited' : `${plan.resources.bandwidthMbMonth / 1024} GB`}</td>
                  <td class="xp-mono xp-tabular">${plan.resources.cpuPercent}% / ${plan.resources.memoryMb} MB</td>
                  <td class="xp-mono xp-tabular">${plan.resources.ioReadBps === 'unlimited' ? 'unlimited' : formatBytes(plan.resources.ioReadBps)}/s · ${plan.resources.ioWriteBps === 'unlimited' ? 'unlimited' : formatBytes(plan.resources.ioWriteBps)}/s</td>
                  <td class="xp-mono xp-tabular">${plan.resources.maxProcesses}</td>
                  <td class="xp-mono xp-tabular">${String(plan.caps.addonDomains)}</td>
                  <td>${renderStatusBadge(plan.shell === 'jailed' ? 'ok' : 'suspended', plan.shell === 'jailed' ? 'jailed' : 'none')}</td>
                </tr>
              `,
                )
                .join('')}
            </tbody>
          </table>
        </div>

        <!-- Create / Edit Plan Drawer Form with Explicit Unlimited Checkboxes -->
        <form class="xp-card xp-form-group" style="margin-block-start: var(--xp-space-card);" action="/api/whm/plans" method="post" data-plan-editor-form="true">
          <div class="xp-card__header">
            <h3>${isAr ? 'محرر خطة الاستضافة وحدود cgroup v2' : 'Create / Edit Plan & cgroup v2 Slice Limits'}</h3>
            ${renderStatusBadge('ok', 'Explicit Unlimited supported')}
          </div>
          <div class="xp-kpi-grid">
            <div>
              <label class="xp-label" for="plan-name">${isAr ? 'اسم الخطة' : 'Plan Name'}</label>
              <input id="plan-name" name="name" type="text" class="xp-input" value="Enterprise" />
            </div>
            <div>
              <label class="xp-label" for="plan-cpu-quota">CPUQuota (%)</label>
              <input id="plan-cpu-quota" name="cpuPercent" type="number" class="xp-input xp-mono" value="200" />
            </div>
            <div>
              <label class="xp-label" for="plan-memory-max">MemoryMax (MB)</label>
              <input id="plan-memory-max" name="memoryMb" type="number" class="xp-input xp-mono" value="2048" />
            </div>
            <div>
              <label class="xp-label" for="plan-io-max">io.max Read / Write (MB/s)</label>
              <input id="plan-io-max" name="ioMaxMbps" type="text" class="xp-input xp-mono" value="100 / 50" />
            </div>
            <div>
              <label class="xp-label" for="plan-tasks-max">TasksMax (pids.max)</label>
              <input id="plan-tasks-max" name="maxProcesses" type="number" class="xp-input xp-mono" value="128" />
            </div>
            <div>
              <label class="xp-label" for="plan-shell-toggle">${isAr ? 'وصول الصدفة المعزولة' : 'Jailed Shell Access'}</label>
              <select id="plan-shell-toggle" name="shell" class="xp-select">
                <option value="jailed">jailed (systemd-run isolated slice)</option>
                <option value="none">none (disabled)</option>
              </select>
            </div>
          </div>
          <div style="display: flex; align-items: center; gap: 16px;">
            <label style="display: inline-flex; align-items: center; gap: 8px;">
              <input type="checkbox" name="unlimitedAddonDomains" value="unlimited" />
              <span>${isAr ? 'نطاقات إضافية غير محدودة (Explicit Unlimited)' : 'Explicit Unlimited Addon Domains'}</span>
            </label>
            <button type="submit" class="xp-btn xp-btn--primary">${escapeHtml(t(locale, 'common.reviewAndApply'))}</button>
          </div>
        </form>
      </section>

      <!-- Resellers Capacity Caps, Overselling Switch & 14-ACL Matrix -->
` : ''}
      ${section === 'resellers' ? `      <section class="xp-card" id="whm-resellers" data-section="resellers-acl" aria-labelledby="whm-resellers-heading">
        <div class="xp-card__header">
          <div>
            <h1 id="whm-resellers-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
            <p class="xp-prose">${isAr ? 'عند إيقاف البيع الزائد (Overselling Off)، يُرفض إنشاء أي حساب يتجاوز مجموع خططه السقف الكلي للموزع.' : 'When overselling is off, account creation is refused whenever the sum of assigned plan limits would exceed the reseller’s total disk or bandwidth cap.'}</p>
          </div>
          ${renderStatusBadge('ok', `${resellers.length} Resellers`)}
        </div>

        <div class="xp-table-wrap">
          <table class="xp-table">
            <thead>
              <tr>
                <th>${isAr ? 'الموزع' : 'Reseller'}</th>
                <th>${isAr ? 'عدد الحسابات' : 'Accounts Cap'}</th>
                <th>${isAr ? 'حصة القرص' : 'Disk Allocation'}</th>
                <th>${isAr ? 'البيع الزائد (Oversell)' : 'Overselling'}</th>
                <th>${isAr ? 'عناوين IP المفوضة' : 'Delegated IPs'}</th>
                <th>${isAr ? 'خوادم الأسماء' : 'Nameservers'}</th>
              </tr>
            </thead>
            <tbody>
              ${resellers
                .map(
                  (res, idx) => `
                <tr data-reseller-row="${escapeHtml(res.username)}">
                  <td><strong class="xp-mono"><bdi dir="ltr">${escapeHtml(res.username)}</bdi></strong></td>
                  <td>${renderThresholdMeter(idx === 0 ? 18 : 6, res.maxAccounts, 'accounts')}</td>
                  <td>${renderThresholdMeter(idx === 0 ? 180 : 48, res.totalDiskMb === 'unlimited' ? 'unlimited' : res.totalDiskMb / 1024, 'GB')}</td>
                  <td>
                    <button type="button" role="switch" aria-checked="${res.oversell ? 'true' : 'false'}" class="xp-btn" data-switch="reseller-oversell-${escapeHtml(res.username)}">
                      ${renderStatusBadge(res.oversell ? 'warn' : 'ok', res.oversell ? 'Oversell: ON' : 'Oversell: OFF')}
                    </button>
                  </td>
                  <td class="xp-mono"><bdi dir="ltr">${escapeHtml(res.delegatedIps.join(', '))}</bdi></td>
                  <td class="xp-mono"><bdi dir="ltr">${escapeHtml(res.nameservers.join(', '))}</bdi></td>
                </tr>
              `,
                )
                .join('')}
            </tbody>
          </table>
        </div>

        <div style="margin-block-start: var(--xp-space-field);" data-reseller-acl-matrix="true">
          <div class="xp-label" style="margin-block-end: 8px;">${isAr ? 'مصفوفة صلاحيات الموزع (Reseller ACL Matrix)' : 'Reseller ACL Privilege Matrix'}</div>
          <div style="display: flex; flex-wrap: wrap; gap: 8px;">
            ${ALL_RESELLER_ACLS.map((acl) =>
              renderStatusBadge(
                heldAcls.has(acl) ? 'ok' : 'suspended',
                `${acl}: ${heldAcls.has(acl) ? 'granted' : 'revoked'}`,
              ),
            ).join('')}
          </div>
        </div>
      </section>

      <!-- Multi-IPv4 / Multi-IPv6 Pool & Postfix Mail Outbound IP Configuration -->
` : ''}
      ${section === 'ips' || (section === 'mail-ips' && mailIpConfig) ? `      <section class="xp-card" id="whm-ip-pool" data-section="multi-ip-mail-pool" aria-labelledby="whm-ip-pool-heading">
        <div class="xp-card__header">
          <div>
            <h1 id="whm-ip-pool-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
            <p class="xp-prose">${isAr ? 'إدارة عناوين IPv4 وIPv6 المشتركة والمخصصة وتفويضها للموزعين والحسابات، مع ضبط توجيه البريد الصادر Postfix (sender_dependent_default_transport_maps).' : 'Manage root, reseller-delegated, account-dedicated, and mail-role IPv4/IPv6 addresses, and configure Postfix sender_dependent_default_transport_maps + smtp_bind_address/smtp_helo_name.'}</p>
          </div>
          ${renderStatusBadge('ok', section === 'ips' ? `${ipPool.length} IPs` : mailIpConfig!.mode)}
        </div>

${section === 'ips' ? `        <!-- Server IP Pool Table -->
        <div class="xp-table-wrap">
          <table class="xp-table" data-ip-pool-table="true">
            <thead>
              <tr>
                <th>${escapeHtml(t(locale, 'ip.col.address'))}</th>
                <th>IPv4 / IPv6</th>
                <th>${escapeHtml(t(locale, 'ip.col.interface'))}</th>
                <th>${escapeHtml(t(locale, 'ip.col.role'))}</th>
                <th>${escapeHtml(t(locale, 'ip.col.owner'))}</th>
                <th>${escapeHtml(t(locale, 'ip.col.ptr'))}</th>
                <th>${escapeHtml(t(locale, 'ip.col.primary'))}</th>
              </tr>
            </thead>
            <tbody>
              ${ipPool
                .map(
                  (ip) => `
                <tr data-ip-row="${escapeHtml(ip.address)}">
                  <td><code class="xp-mono xp-tabular"><bdi dir="ltr">${escapeHtml(ip.address)}/${ip.prefixLength}</bdi></code></td>
                  <td class="xp-mono">IPv${ip.version}</td>
                  <td><code class="xp-mono"><bdi dir="ltr">${escapeHtml(ip.interfaceName)}</bdi></code></td>
                  <td>${renderStatusBadge(ip.role === 'mail' ? 'warn' : 'ok', ip.role)}</td>
                  <td class="xp-mono"><bdi dir="ltr">${escapeHtml(ip.ownerKind)}${ip.ownerId ? ` (${escapeHtml((ip.ownerKind === 'account' ? accounts.find(account => account.id === ip.ownerId)?.username : resellers.find(reseller => reseller.id === ip.ownerId)?.username) ?? (isAr ? 'المالك غير متاح' : 'Owner unavailable'))})` : ''}</bdi></td>
                  <td class="xp-mono"><bdi dir="ltr">${escapeHtml(ip.ptrHostname ?? '—')}</bdi></td>
                  <td>${renderStatusBadge(ip.isPrimary ? 'ok' : 'suspended', ip.isPrimary ? 'Primary' : 'Secondary')}</td>
                </tr>
              `,
                )
                .join('')}
            </tbody>
          </table>
        </div>

` : ''}        <!-- Add IPv4/IPv6 + Postfix Outbound Mail IP Configuration -->
        <div class="xp-golden-grid" style="margin-block-start: var(--xp-space-card);">
          <!-- Mail Outbound IP Configuration (MailIpConfig) -->
${section === 'mail-ips' && mailIpConfig ? `          <form class="xp-card xp-form-group" action="/api/whm/mail-ips" method="post" data-mail-ip-config-form="true">
            <div class="xp-card__header">
              <h3>${escapeHtml(t(locale, 'mailIp.title'))}</h3>
              ${renderStatusBadge('ok', 'Postfix sender_dependent_default_transport_maps')}
            </div>

            <div>
              <label class="xp-label" for="mail-outbound-mode">${isAr ? 'نمط توجيه البريد الصادر (MailOutboundMode)' : 'Outbound Mail Routing Mode'}</label>
              <select id="mail-outbound-mode" name="mode" class="xp-select">
                <option value="server-default" ${mailIpConfig.mode === 'server-default' ? 'selected' : ''}>server-default (${escapeHtml(t(locale, 'mailIp.mode.server-default'))})</option>
                <option value="account-ip" ${mailIpConfig.mode === 'account-ip' ? 'selected' : ''}>account-ip (${escapeHtml(t(locale, 'mailIp.mode.account-ip'))})</option>
                <option value="domain-ip" ${mailIpConfig.mode === 'domain-ip' ? 'selected' : ''}>domain-ip (${escapeHtml(t(locale, 'mailIp.mode.domain-ip'))})</option>
                <option value="custom-map" ${mailIpConfig.mode === 'custom-map' ? 'selected' : ''}>custom-map (${escapeHtml(t(locale, 'mailIp.mode.custom-map'))})</option>
              </select>
            </div>

            <div class="xp-kpi-grid">
              <div>
                <label class="xp-label" for="mail-default-ipv4">Default Outbound IPv4 (smtp_bind_address)</label>
                <input id="mail-default-ipv4" name="defaultIpv4" type="text" class="xp-input xp-mono" dir="ltr" value="${escapeHtml(mailIpConfig.defaultIpv4 ?? '')}" />
              </div>
              <div>
                <label class="xp-label" for="mail-default-ipv6">Default Outbound IPv6 (smtp_bind_address6)</label>
                <input id="mail-default-ipv6" name="defaultIpv6" type="text" class="xp-input xp-mono" dir="ltr" value="${escapeHtml(mailIpConfig.defaultIpv6 ?? '')}" />
              </div>
              <div>
                <label class="xp-label" for="mail-default-helo">${escapeHtml(t(locale, 'mailIp.defaultHelo'))} (smtp_helo_name)</label>
                <input id="mail-default-helo" name="defaultHelo" type="text" class="xp-input xp-mono" dir="ltr" value="${escapeHtml(mailIpConfig.defaultHelo ?? '')}" />
              </div>
            </div>

            <div>
              <div class="xp-label">${escapeHtml(t(locale, 'mailIp.overrides'))}</div>
              <pre class="xp-terminal" dir="ltr"><bdi dir="ltr">${escapeHtml(mailIpConfig.domainOverrides.map(override => [override.domainName, override.ipv4, override.ipv6, override.heloHostname].filter(Boolean).join(' · ')).join('\n') || (isAr ? 'لا توجد تجاوزات للنطاقات.' : 'No domain overrides are configured.'))}</bdi></pre>
            </div>

            <button type="submit" class="xp-btn xp-btn--primary">${escapeHtml(t(locale, 'common.reviewAndApply'))}</button>
          </form>

` : ''}
          ${section === 'ips' ? `<!-- Add / Assign Server IP Form -->
          <form class="xp-card xp-form-group" action="/api/whm/ips" method="post" data-add-ip-form="true">
            <div class="xp-card__header">
              <h3>${escapeHtml(t(locale, 'ip.addAddress'))}</h3>
              ${renderStatusBadge('ok', 'IPv4 + IPv6 Dual-Stack')}
            </div>
            <div>
              <label class="xp-label" for="add-ip-address">${escapeHtml(t(locale, 'ip.col.address'))}</label>
              <input id="add-ip-address" name="address" type="text" class="xp-input xp-mono" dir="ltr" placeholder="IPv4 / IPv6" />
            </div>
            <div>
              <label class="xp-label" for="add-ip-prefix">Subnet Prefix Length (CIDR)</label>
              <input id="add-ip-prefix" name="prefixLength" type="number" class="xp-input xp-mono" required min="0" max="128" />
            </div>
            <div>
              <label class="xp-label" for="add-ip-role">${escapeHtml(t(locale, 'ip.col.role'))}</label>
              <select id="add-ip-role" name="role" class="xp-select">
                <option value="shared">shared</option>
                <option value="dedicated">dedicated</option>
                <option value="mail">mail</option>
              </select>
            </div>
            <div>
              <label class="xp-label" for="add-ip-owner">${escapeHtml(t(locale, 'ip.col.owner'))}</label>
              <select id="add-ip-owner" name="ownerKind" class="xp-select">
                <option value="root">root (server-wide)</option>
                <option value="reseller">reseller (delegated pool)</option>
                <option value="account">account (dedicated vhost/mail IP)</option>
              </select>
            </div>
            <div>
              <label class="xp-label" for="add-ip-ptr">${escapeHtml(t(locale, 'ip.col.ptr'))}</label>
              <input id="add-ip-ptr" name="ptrHostname" type="text" class="xp-input xp-mono" dir="ltr" placeholder="mail.example.com" />
            </div>
            <button type="submit" class="xp-btn xp-btn--primary">${escapeHtml(t(locale, 'ip.addAddress'))}</button>
          </form>` : ''}
        </div>
      </section>

      <!-- Firewall (nftables) + Self-Lockout Protection + 60s Dead-Man's Switch -->
` : ''}
      ${section === 'firewall' ? `      <section class="xp-card" id="whm-firewall" data-section="nftables-firewall" aria-labelledby="whm-firewall-heading">
        <div class="xp-card__header">
          <div>
            <h1 id="whm-firewall-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
            <p class="xp-prose">${escapeHtml(t(locale, 'firewall.deadManSwitch'))}</p>
          </div>
          ${renderStatusBadge('ok', `Session IP ${adminSessionIp} Protected`)}
        </div>

        <!-- 60-Second Dead-Man's Switch Banner -->
        <div class="xp-reconcile-banner" role="region" aria-label="Firewall dead-man switch" data-firewall-deadman="60s" style="margin-block-end: var(--xp-space-field);">
          <div style="display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px;">
            <div>
              <strong>${isAr ? 'مفتاح الأمان التلقائي (60 ثانية) وحماية الجلسة' : '60-Second Dead-Man’s Switch & Self-Lockout Guard'}</strong>
              <p style="margin: 4px 0 0; font-size: 0.85rem; color: var(--xp-text-secondary);">
                ${isAr ? `يرفض النظام أي قاعدة تحظر عنوان جلستك الحالي (${adminSessionIp}) أو منافذ اللوحة/SSH، ويتراجع تلقائياً إلى الإعدادات السابقة إذا لم يتم تأكيد الاتصال خلال 60 ثانية.` : `Rules that would drop active admin session IP (${adminSessionIp}) or panel/SSH ports (:2087, :22) are refused upfront, and applied rules auto-rollback to the previous settings if unconfirmed within 60s.`}
              </p>
            </div>
            ${renderStatusBadge('warn', '60s Rollback Timer Guard')}
          </div>
        </div>

        <div class="xp-table-wrap">
          <table class="xp-table">
            <thead>
              <tr>
                <th>${isAr ? 'النوع' : 'Kind'}</th>
                <th>${isAr ? 'الإجراء' : 'Action'}</th>
                <th>${isAr ? 'البروتوكول / المنفذ' : 'Protocol / Port'}</th>
                <th>${isAr ? 'المصدر (CIDR)' : 'Source CIDR'}</th>
                <th>${isAr ? 'الوصف' : 'Comment'}</th>
                <th>${isAr ? 'الحالة' : 'State'}</th>
              </tr>
            </thead>
            <tbody>
              ${firewallRules
                .map(
                  (rule) => `
                <tr data-firewall-rule="${escapeHtml(rule.id)}">
                  <td class="xp-mono">${escapeHtml(rule.kind)}</td>
                  <td>${renderStatusBadge(rule.action === 'accept' ? 'ok' : 'critical', rule.action)}</td>
                  <td class="xp-mono"><bdi dir="ltr">${escapeHtml(rule.protocol ?? 'any')} : ${escapeHtml(rule.port ?? '*')}</bdi></td>
                  <td class="xp-mono"><bdi dir="ltr">${escapeHtml(rule.source ?? '0.0.0.0/0')}</bdi></td>
                  <td>${escapeHtml(rule.comment)}</td>
                  <td>${renderStatusBadge(rule.enabled ? 'ok' : 'suspended', rule.enabled ? 'Enabled' : 'Disabled')}</td>
                </tr>
              `,
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </section>

` : ''}
      ${section === 'generations' ? `        <section class="xp-card" data-section="config-generations" aria-labelledby="whm-generations-heading">
          <div class="xp-card__header">
            <div>
              <h1 id="whm-generations-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
              <p class="xp-prose">${isAr ? 'يتم اختبار كل جيل قبل تفعيله، مع الاحتفاظ بالأجيال السابقة للتراجع الفوري.' : 'Every change renders a numbered host generation, verifies nginx -t / apachectl configtest / nft -c, and keeps prior generations for instant rollback.'}</p>
            </div>
            ${generationId !== undefined ? renderStatusBadge('ok', `Gen #${generationId}`) : ''}
          </div>

          <div class="xp-table-wrap">
            <table class="xp-table">
              <thead>
                <tr>
                  <th>${isAr ? 'الجيل' : 'Generation'}</th>
                  <th>${isAr ? 'التغيير' : 'Summary'}</th>
                  <th>${isAr ? 'البصمة والملفات' : 'Checksum & Files'}</th>
                  <th>${isAr ? 'الحالة' : 'Status'}</th>
                  <th>${isAr ? 'التراجع' : 'Rollback'}</th>
                </tr>
              </thead>
              <tbody>
                ${generations
                  .map(
                    (gen) => `
                  <tr data-generation-row="${gen.generationId}">
                    <td class="xp-mono xp-tabular"><strong>#${gen.generationId}</strong></td>
                    <td>${escapeHtml(gen.summary)}</td>
                    <td class="xp-mono xp-tabular"><bdi dir="ltr">sha256:${escapeHtml(gen.stateChecksum)} · ${gen.filesCount} files (${gen.durationMs}ms)</bdi></td>
                    <td>${renderStatusBadge(gen.status === 'active' ? 'ok' : 'suspended', gen.status)}</td>
                    <td>
                      <button type="button" class="xp-btn" data-action="rollback-generation" data-generation-id="${gen.generationId}" ${gen.status === 'active' ? 'disabled' : ''}>
                        ${isAr ? `التراجع إلى #${gen.generationId}` : `Rollback to #${gen.generationId}`}
                      </button>
                    </td>
                  </tr>
                `,
                  )
                  .join('')}
              </tbody>
            </table>
          </div>

<button type="button" class="xp-btn" data-action="rebuild-index">${isAr ? 'إعادة بناء الفهرس' : 'Rebuild index'}</button></section>` : ''}
${section === 'audit' ? `<section class="xp-card" data-section="audit-log">
            <div class="xp-card__header">
              <h1 class="xp-page-title">${escapeHtml(pageTitle)}</h1>
              ${renderStatusBadge('ok', 'JSONL + SQLite Index')}
            </div>
            <div class="xp-table-wrap">
              <table class="xp-table">
                <thead>
                  <tr>
                    <th>UTC</th>
                    <th>Actor</th>
                    <th>Action</th>
                    <th>Target</th>
                    <th>Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  ${auditEntries
                    .map(
                      (entry) => `
                    <tr data-audit-id="${escapeHtml(entry.id)}">
                      <td class="xp-mono xp-tabular"><time datetime="${escapeHtml(entry.at)}">${escapeHtml(entry.at)}</time></td>
                      <td class="xp-mono"><bdi dir="ltr">${escapeHtml(entry.actor)}</bdi></td>
                      <td class="xp-mono"><bdi dir="ltr">${escapeHtml(entry.action)}</bdi></td>
                      <td class="xp-mono"><bdi dir="ltr">${escapeHtml(entry.target)}</bdi></td>
                      <td>${renderStatusBadge(entry.outcome === 'ok' ? 'ok' : entry.outcome === 'denied' ? 'warn' : 'critical', entry.outcome)}</td>
                    </tr>
                  `,
                    )
                    .join('')}
                </tbody>
              </table>
            </div>
          </section>` : ''}
${section === 'upgrade' ? `<section class="xp-card" data-section="root-lifecycle"><h1 class="xp-page-title">${escapeHtml(pageTitle)}</h1><p class="xp-prose"><bdi dir="ltr">${escapeHtml(version)} → ${escapeHtml(availableVersion)}</bdi></p><p class="xp-prose">${isAr ? 'راجع فحص الترقية قبل تأكيد أي تغيير.' : 'Review the upgrade preflight before confirming any change.'}</p><button type="button" class="xp-btn xp-btn--primary" data-action="start-upgrade" ${isRoot && props.availableVersion ? '' : 'disabled'}>${isAr ? 'فحص الترقية' : 'Check upgrade'}</button></section>` : ''}
${section === 'transfer' ? `<section class="xp-card" data-section="root-lifecycle"><h1 class="xp-page-title">${escapeHtml(pageTitle)}</h1><p class="xp-prose">${isAr ? 'اختر مصدر النقل وراجع الحسابات قبل الاستيراد.' : 'Choose the transfer source and review its accounts before importing.'}</p><button type="button" class="xp-btn xp-btn--primary" data-action="start-transfer" ${isRoot ? '' : 'disabled'}>${isAr ? 'بدء النقل' : 'Start transfer'}</button></section>` : ''}
${section === undefined || (section === 'io' && !ioSnapshot) || (section === 'mail-ips' && !mailIpConfig) ? renderSurfaceUnavailable(locale, '/whm') : ''}`,
  })
  return ensureAccessibleSurfaceHtml(rawHtml.trim(), locale)
}
