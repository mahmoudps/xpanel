import { visibleNavigation, type CatalogTool, type VisibilityContext } from '@xpanel/catalog'
import type {
  Account,
  AuditEntry,
  Certificate,
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
import { formatDisplayName } from '../display-name.ts'
import { type Locale, t } from '../i18n.ts'
import {
  type AsyncActionBannerProps,
  ensureAccessibleSurfaceHtml,
  escapeHtml,
  formatAsciiDate,
  formatBytes,
  renderAsyncActionState,
  renderLtrValue,
  renderStatusBadge,
  renderThresholdMeter,
} from '../tokens.ts'
import { auditActionHtml, auditActorLabel, auditOutcomeLabel, auditTargetLabel } from '../audit-labels.ts'
import { renderWhmDashboard, whmDashboardFromProps, type DashboardHostSample } from '../board-port/xwhm-dashboard.ts'
import { renderDesignMain, renderDesignNav } from '../design-board.ts'
import { renderSurfaceShell, renderSurfaceUnavailable, resolveSurfaceSection, renderUnavailableSurfaceShell, getSurfacePageTitle, normalizeSurfaceRoute, renderLiveUpdatesIndicator, renderPageSearchButton } from '../shell.ts'


export interface WhmServiceHealthRow {
  name: string
  unit: string
  version: string
  active: boolean
  enabled: boolean
  rssMb: number
  role: string
  installed?: boolean
  /** False when the unit was not probed. Omitted means the row carries a probe result. */
  checked?: boolean
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
  panelHostname?: string
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
  /** Filters and keyset page for `/whm/audit`. Omitted on the overview. */
  auditList?: {
    actor: string
    action: string
    target: string
    before: string
    hasMore: boolean
    oldestId: string
  }
  hostSample?: DashboardHostSample | null
  driftCount?: number | null
  /** Previous superseded generation. Empty when the host has nothing to roll back to. */
  rollbackGenerationId?: number
  generationActivatedAt?: string
  nearLimits?: Array<{ name: string; note: string }>
  certificates?: readonly Pick<Certificate, 'names' | 'notAfter'>[]
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
  const auditList = props.auditList
  const auditActor = auditList?.actor ?? ''
  const auditAction = auditList?.action ?? ''
  const auditTarget = auditList?.target ?? ''
  const auditBefore = auditList?.before ?? ''
  const auditHref = (before?: string): string => {
    const params = new URLSearchParams()
    if (auditActor) params.set('actor', auditActor)
    if (auditAction) params.set('action', auditAction)
    if (auditTarget) params.set('target', auditTarget)
    if (before) params.set('before', before)
    const query = params.toString()
    return query ? `/whm/audit?${query}` : '/whm/audit'
  }

  const whmNav = visibleNavigation(props.visibility, props.catalog).find((n) => n.surface === 'xwhm')
  const qualifiedRoutes = new Set((whmNav?.sections ?? []).flatMap(section => section.pages.map(page => page.route)))
  const heldAcls = new Set<ResellerAcl>(props.visibility?.reseller?.acl ?? props.activeReseller?.acl ?? [])

  const switchLangCode = isAr ? 'en' : 'ar'
  const switchLangLabel = isAr ? 'English' : 'العربية'
  const nextTheme = theme === 'dark' ? 'light' : 'dark'
  const actionBannerHtml = props.actionState
    ? renderAsyncActionState({ ...props.actionState, locale })
    : ''

  if (section === 'overview') return ensureAccessibleSurfaceHtml(renderWhmDashboard(whmDashboardFromProps({
    locale, principal, hostname: props.hostname, panelHostname: props.panelHostname, version: props.version, availableVersion: props.availableVersion,
    generationId: props.generationId, accounts: props.accounts, resellers: props.resellers, ipPool: props.ipPool,
    plans: props.plans, services, auditEntries, hostSample: props.hostSample, driftCount: props.driftCount,
    certificates: props.certificates, rollbackGenerationId: props.rollbackGenerationId,
    ...(props.generationActivatedAt ? { generationActivatedAt: props.generationActivatedAt } : {}),
    ...(props.nearLimits ? { nearLimits: props.nearLimits } : {}),
  })), locale)

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

    ${renderDesignNav('xwhm', locale, activeRoute, qualifiedRoutes)}`,
    topbar: `      <div class="xp-topbar__start">
        ${renderPageSearchButton(locale)}
      </div>

      <div class="xp-topbar__end">
        ${renderLiveUpdatesIndicator(locale, props.realtimeEnabled === true)}
        ${generationId !== undefined ? `<span data-generation-chip="${generationId}">
          ${renderStatusBadge('ok', `Gen #${generationId}`)}
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
        <div class="xp-account-actions">
          <span class="xp-account-pill"><span class="xp-account-pill__avatar" aria-hidden="true">${escapeHtml(principal.username.slice(0, 1).toLowerCase())}</span><span class="xp-mono xp-account-actions__name" aria-label="${isAr ? 'المستخدم الحالي' : 'Current user'}">${escapeHtml(principal.username)}</span></span>
          <button type="button" class="xp-btn xp-btn--ghost" data-action="logout">${escapeHtml(isAr ? 'تسجيل الخروج' : 'Sign out')}</button>
        </div>
      </div>`,
    content: `      ${actionBannerHtml}
${section === 'overview' ? `      <section class="xp-card" data-section="overview-attention">
        <div class="xp-card__header"><div><h1 class="xp-page-title">${escapeHtml(pageTitle)}</h1><p class="xp-prose"><bdi dir="ltr">${escapeHtml(hostname)}</bdi></p></div></div>
        <div class="xp-kpi-grid" data-section="whm-kpi-cards">
          <div class="xp-field"><span class="xp-label">${isAr ? 'الحسابات' : 'Accounts'}</span><strong>${props.accounts ? accounts.length : (isAr ? 'غير متاحة' : 'Unavailable')}</strong></div>
          <div class="xp-field"><span class="xp-label">${isAr ? 'الخطط' : 'Plans'}</span><strong>${props.plans ? plans.length : (isAr ? 'غير متاحة' : 'Unavailable')}</strong></div>
          <div class="xp-field"><span class="xp-label">${isAr ? 'الإصدار' : 'Version'}</span><strong><bdi dir="ltr">${escapeHtml(version)}</bdi></strong></div>
          <div class="xp-field"><span class="xp-label">${isAr ? 'المشغل' : 'Operator'}</span><strong><bdi dir="ltr">${escapeHtml(principal.username)}</bdi></strong></div>
        </div>
        <p class="xp-prose" role="status" data-host-observation="unavailable">${isAr ? 'قياسات موارد الخادم غير متاحة.' : 'Host resource measurements unavailable.'}</p>
        <section class="xp-board-section" aria-labelledby="whm-reconcile">
          <header class="xp-board-section__head"><h2 id="whm-reconcile">${isAr ? 'الموفّق' : 'Reconciler'}</h2></header>
          <div class="xp-board-section__body"><p role="status">${generationId !== undefined ? `<bdi dir="ltr">#${generationId}</bdi>` : (isAr ? 'لا جيل مطبَّق بعد.' : 'No generation is applied yet.')}</p></div>
        </section>
        <section class="xp-board-section" aria-labelledby="whm-dash-accounts">
          <header class="xp-board-section__head"><h2 id="whm-dash-accounts">${isAr ? 'الحسابات' : 'Accounts'}</h2></header>
          <dl class="xp-board-dl">
            <div class="xp-fact"><dt>${isAr ? 'النشطة' : 'Active'}</dt><dd>${props.accounts ? accounts.filter(account => account.status === 'active').length : (isAr ? 'غير متاحة' : 'Unavailable')}</dd></div>
            <div class="xp-fact"><dt>${isAr ? 'الموقوفة' : 'Suspended'}</dt><dd>${props.accounts ? accounts.filter(account => account.status === 'suspended').length : (isAr ? 'غير متاحة' : 'Unavailable')}</dd></div>
            <div class="xp-fact"><dt>${isAr ? 'الموزعون' : 'Resellers'}</dt><dd>${props.resellers ? resellers.length : (isAr ? 'غير متاحة' : 'Unavailable')}</dd></div>
          </dl>
        </section>
        <section class="xp-board-section" aria-labelledby="whm-dash-audit">
          <header class="xp-board-section__head"><h2 id="whm-dash-audit">${isAr ? 'آخر التدقيق' : 'Recent audit entries'}</h2><a href="/whm/audit">${isAr ? 'افتح السجل' : 'Open the audit log'}</a></header>
          <div class="xp-table-wrap"><table class="xp-table"><thead><tr><th>${isAr ? 'الوقت' : 'Time'}</th><th>${isAr ? 'الفاعل' : 'Actor'}</th><th>${isAr ? 'الإجراء' : 'Action'}</th><th>${isAr ? 'النتيجة' : 'Result'}</th></tr></thead><tbody>${auditEntries.length ? auditEntries.slice(0, 8).map(entry => `<tr><td><bdi dir="ltr">${escapeHtml(formatAsciiDate(entry.at, { includeTime: true }))}</bdi></td><td><bdi dir="ltr">${escapeHtml(auditActorLabel(entry.actor))}</bdi></td><td>${auditActionHtml(entry.action, locale, entry)}</td><td>${escapeHtml(auditOutcomeLabel(entry.action, entry.outcome, locale))}</td></tr>`).join('') : `<tr><td colspan="4">${isAr ? 'لا مدخلات تدقيق بعد' : 'No audit entries yet'}</td></tr>`}</tbody></table></div>
        </section>
      </section>
` : ''}
      ${section === 'io' && ioSnapshot ? `      <!-- Real-Time Server IO & Per-Account cgroup v2 Slice Monitor -->
      <section class="xp-card" id="whm-io-monitor" data-section="server-io-monitor" aria-labelledby="whm-io-heading">
        <div class="xp-card__header">
          <div>
            <h1 id="whm-io-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
          </div>
        </div>

        ${renderServerIoMonitorChart(ioSnapshot, locale)}
      </section>

` : ''}
      ${section === 'services' ? `      <!-- Service Health Table (nginx, apache/ols, php-fpm, mariadb, dovecot, postfix, pdns, nftables) -->
      <section class="xp-card" id="whm-services" data-section="service-health" aria-labelledby="whm-services-heading">
        <div class="xp-card__header">
          <div>
            <h1 id="whm-services-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
            <p class="xp-prose">${isAr ? 'إصدارات الخدمات واستهلاك الذاكرة وحالة التشغيل.' : 'Service versions, memory use and running status.'}</p>
          </div>
          ${services.length > 0 ? renderStatusBadge('ok', `${services.filter((s) => s.active).length}/${services.length} Healthy`) : ''}
        </div>
        ${services.length > 0 ? `<div class="xp-table-wrap">
          <table class="xp-table">
            <thead>
              <tr>
                <th>${isAr ? 'الخدمة' : 'Service'}</th>
                <th>${isAr ? 'وحدة systemd' : 'systemd Unit'}</th>
                <th>${isAr ? 'الإصدار' : 'Version'}</th>
                <th>${isAr ? 'الدور' : 'Role'}</th>
                <th>${isAr ? 'الذاكرة (RSS)' : 'Memory (RSS)'}</th>
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
        </div>` : ''}
        <div class="xp-table-wrap" data-host-services="true">
          <table class="xp-table">
            <thead><tr><th>${isAr ? 'الخدمة' : 'Service'}</th><th>${isAr ? 'الوحدة' : 'Unit'}</th><th>${isAr ? 'الحالة' : 'Status'}</th><th>${isAr ? 'إجراء' : 'Action'}</th></tr></thead>
            <tbody data-host-service-rows="true"><tr><td colspan="4">${isAr ? 'جار قراءة حالة الخدمات.' : 'Reading service status.'}</td></tr></tbody>
          </table>
          <p class="xp-help" data-host-service-status role="status"></p>
        </div>
      </section>

` : ''}
      ${section === 'dns' ? `<section class="xp-card" data-dns-editor="true" aria-labelledby="whm-dns-heading">
        <div class="xp-card__header"><h1 id="whm-dns-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1></div>
        <p class="xp-prose">${isAr ? 'حفظ المنطقة يطبّقها على خادم PowerDNS المحلي.' : 'Saving a zone applies it to the local PowerDNS server.'}</p>
        <div class="xp-kpi-grid">
          <div class="xp-field"><label class="xp-label" for="dns-zone">${isAr ? 'المنطقة' : 'Zone'}</label><select id="dns-zone" class="xp-select" data-dns-zone="true"></select></div>
          <div class="xp-field"><label class="xp-label" for="dns-account">${isAr ? 'الحساب' : 'Account'}</label><select id="dns-account" class="xp-select" data-dns-account="true">${accounts.map(account => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.username)}</option>`).join('')}</select></div>
          <div class="xp-field"><label class="xp-label" for="dns-new-name">${isAr ? 'اسم منطقة جديدة' : 'New zone name'}</label><input id="dns-new-name" class="xp-input xp-mono" dir="ltr" data-dns-new-name="true" /></div>
        </div>
        <div class="xp-table-wrap"><table class="xp-table"><thead><tr><th>${isAr ? 'الاسم' : 'Name'}</th><th>${isAr ? 'النوع' : 'Type'}</th><th>TTL</th><th>${isAr ? 'المحتوى' : 'Content'}</th><th>${isAr ? 'الأولوية' : 'Priority'}</th></tr></thead><tbody data-dns-records="true"></tbody></table></div>
        <p class="xp-help" data-dns-status role="status"></p>
        <div class="xp-plan-editor-actions">
          <button type="button" class="xp-btn" data-dns-add-record="true">${isAr ? 'سجل جديد' : 'Add record'}</button>
          <button type="button" class="xp-btn" data-dns-add-zone="true">${isAr ? 'إضافة المنطقة' : 'Add zone'}</button>
          <button type="button" class="xp-btn xp-btn--primary" data-dns-save="true">${isAr ? 'حفظ المنطقة' : 'Save zone'}</button>
          <button type="button" class="xp-btn" data-dns-delete="true">${isAr ? 'حذف المنطقة' : 'Delete zone'}</button>
        </div>
      </section>` : ''}
      ${section === 'backups' ? `<section class="xp-card" data-account-backups="true" aria-labelledby="whm-backup-heading">
        <div class="xp-card__header"><h1 id="whm-backup-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1></div>
        <p class="xp-prose">${isAr ? 'الأرشيف يُحفظ في مجلد النسخ المحلي، بحد 2 GiB، ويُستعاد إلى مجلد الحساب فقط.' : 'The archive is stored in the local backup directory, limited to 2 GiB, and restored only into that account home.'}</p>
        <div class="xp-field"><label class="xp-label" for="backup-account">${isAr ? 'الحساب' : 'Account'}</label><select id="backup-account" class="xp-select" data-backup-account="true">${accounts.map(account => `<option value="${escapeHtml(account.username)}">${escapeHtml(account.username)}</option>`).join('')}</select></div>
        <div class="xp-table-wrap"><table class="xp-table"><thead><tr><th>${isAr ? 'الملف' : 'File'}</th><th>${isAr ? 'الحجم' : 'Size'}</th><th></th></tr></thead><tbody data-backup-files="true"></tbody></table></div>
        <p class="xp-help" data-backup-status role="status"></p>
        <button type="button" class="xp-btn xp-btn--primary" data-backup-create="true">${isAr ? 'إنشاء نسخة' : 'Create backup'}</button>
      </section>` : ''}
      ${section === 'server-info' ? `<section class="xp-card" data-host-info="true" aria-labelledby="whm-server-info-heading">
        <div class="xp-card__header"><h1 id="whm-server-info-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1></div>
        <div class="xp-kpi-grid" data-host-info-grid="true">
          <div class="xp-field"><span class="xp-label">${isAr ? 'الحمل' : 'Load'}</span><strong data-host-load="true" class="xp-mono" dir="ltr">${isAr ? 'جار القراءة' : 'Reading'}</strong></div>
          <div class="xp-field"><span class="xp-label">${isAr ? 'الذاكرة' : 'Memory'}</span><strong data-host-memory="true" class="xp-mono" dir="ltr">${isAr ? 'جار القراءة' : 'Reading'}</strong></div>
          <div class="xp-field"><span class="xp-label">${isAr ? 'القرص' : 'Disk'}</span><strong data-host-disk="true" class="xp-mono" dir="ltr">${isAr ? 'جار القراءة' : 'Reading'}</strong></div>
        </div>
        <p class="xp-help" data-host-info-status role="status"></p>
      </section>` : ''}
      ${section === 'accounts' || section === 'create-account' ? `
      <section class="xp-card xp-accounts${section === 'create-account' ? ' xp-accounts--create' : ''}" id="whm-accounts" data-section="accounts-isolation" data-accounts-workspace aria-labelledby="whm-accounts-heading">
        <div class="xp-card__header xp-accounts__header">
          <h1 id="whm-accounts-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
          ${section === 'accounts' ? `<span class="xp-help xp-tabular">${isAr ? 'الحسابات: ' + accounts.length : accounts.length + (accounts.length === 1 ? ' account' : ' accounts')}</span>` : ''}
          </div>
        ${section === 'accounts' ? `
        <div class="xp-table-wrap xp-accounts__table-wrap">
          <table class="xp-table xp-accounts__table">
          <thead>
          <tr>
          <th scope="col">${isAr ? 'الحساب' : 'Account'}</th>
          <th scope="col">${isAr ? 'النطاق الأساسي' : 'Primary domain'}</th>
          <th scope="col">${isAr ? 'الخطة' : 'Plan'}</th>
          <th scope="col">${isAr ? 'الحالة' : 'Status'}</th>
          <th scope="col">${isAr ? 'الإجراءات' : 'Actions'}</th>
        </tr>
          </thead>
          <tbody>${accounts.map(acc => {
          const canSuspend = isRoot || heldAcls.has('suspend-account')
          const canTerminate = isRoot || heldAcls.has('terminate-account')
          const statusLabel = acc.status === 'active' ? t(locale, 'common.status.active') : acc.status === 'suspended' ? t(locale, 'common.status.suspended') : isAr ? 'قيد الإنهاء' : 'Terminating'
          const attributes = `data-account-id="${escapeHtml(acc.id)}" data-username="${escapeHtml(acc.username)}" data-domain="${escapeHtml(acc.primaryDomain)}"`
          return `<tr data-account-row="${escapeHtml(acc.username)}">
          <td>
          <div class="xp-accounts__identity">
          <strong>
          <bdi dir="ltr">${escapeHtml(acc.username)}</bdi>
          </strong>
          <details class="xp-accounts__details" data-account-details>
          <summary>${isAr ? 'التفاصيل' : 'Details'}</summary>
          <dl class="xp-accounts__technical">
            <div>
          <dt>UID</dt>
          <dd>
          <bdi dir="ltr">${acc.uid}</bdi>
          </dd>
          </div>
          <div>
          <dt>${isAr ? 'وحدة الموارد' : 'Resource unit'}</dt>
          <dd>
          <bdi dir="ltr">xpanel-${acc.uid}.slice</bdi>
          </dd>
          </div>
          <div>
          <dt>IPv4</dt>
          <dd>
          <bdi dir="ltr">${escapeHtml(acc.ipv4)}</bdi>
          </dd>
          </div>${acc.ipv6 ? `<div>
          <dt>IPv6</dt>
          <dd>
          <bdi dir="ltr">${escapeHtml(acc.ipv6)}</bdi>
          </dd>
          </div>` : ''}${acc.extraIps?.length ? `<div>
          <dt>${isAr ? 'عناوين إضافية' : 'Additional IPs'}</dt>
          <dd>
          <bdi dir="ltr">${escapeHtml(acc.extraIps.join(', '))}</bdi>
          </dd>
          </div>` : ''}          <div>
          <dt>${isAr ? 'الطرفية' : 'Shell'}</dt>
          <dd>
          <bdi dir="ltr">${escapeHtml(acc.shell)}</bdi>
          </dd>
          </div>
          <div>
          <dt>${isAr ? 'البريد' : 'Contact'}</dt>
          <dd><bdi dir="ltr">${escapeHtml(acc.contactEmail)}</bdi></dd>
          </div>
          <div>
          <dt>${isAr ? 'حصة القرص' : 'Disk quota'}</dt>
          <dd><bdi dir="ltr">${escapeHtml((() => { const disk = plans.find(plan => plan.id === acc.planId)?.resources.diskMb; return disk === undefined ? (isAr ? 'غير متاحة' : 'Unavailable') : disk === 'unlimited' ? (isAr ? 'غير محدود' : 'Unlimited') : disk + ' MB' })())}</bdi></dd>
          </div>
          </dl>
          ${(isRoot || heldAcls.has('edit-account')) ? `<form class="xp-form-group" data-account-contact-form="true" data-account-id="${escapeHtml(acc.id)}">
            <label class="xp-label" for="contact-${escapeHtml(acc.id)}">${isAr ? 'بريد التواصل' : 'Contact email'}</label>
            <input id="contact-${escapeHtml(acc.id)}" name="contactEmail" type="email" class="xp-input" dir="ltr" required value="${escapeHtml(acc.contactEmail)}" />
            <p class="xp-help" data-account-contact-status role="status" hidden></p>
            <button type="submit" class="xp-btn">${isAr ? 'حفظ البريد' : 'Save email'}</button>
          </form>` : ''}
          ${(isRoot || heldAcls.has('change-password')) ? `<form class="xp-form-group" data-account-password-form="true" data-account-id="${escapeHtml(acc.id)}">
            <label class="xp-label" for="password-${escapeHtml(acc.id)}">${isAr ? 'كلمة مرور جديدة' : 'New password'}</label>
            <input id="password-${escapeHtml(acc.id)}" name="password" type="password" class="xp-input" minlength="8" required autocomplete="new-password" />
            <p class="xp-help" data-account-password-status role="status" hidden></p>
            <button type="submit" class="xp-btn">${isAr ? 'تغيير كلمة المرور' : 'Change password'}</button>
          </form>` : ''}
          </details>
          </div>
          </td>
          <td>
          <span class="xp-accounts__mobile-label" aria-hidden="true">${isAr ? 'النطاق الأساسي' : 'Primary domain'}</span>
          <bdi dir="ltr" class="xp-accounts__domain">${escapeHtml(acc.primaryDomain)}</bdi>
          </td>
          <td>
          <span class="xp-accounts__mobile-label" aria-hidden="true">${isAr ? 'الخطة' : 'Plan'}</span>
          <span>${escapeHtml(plans.find(plan => plan.id === acc.planId)?.name ?? (isAr ? 'غير متاحة' : 'Unavailable'))}</span>
          </td>
          <td>
          <span class="xp-accounts__mobile-label" aria-hidden="true">${isAr ? 'الحالة' : 'Status'}</span>
          <span data-account-status>${renderStatusBadge(acc.status === 'active' ? 'ok' : acc.status === 'suspended' ? 'suspended' : 'critical', statusLabel)}</span>
          </td>
          <td>
          <div class="xp-accounts__actions">${canSuspend && acc.status !== 'terminating' ? `<button type="button" class="xp-btn xp-btn--ghost" data-action="${acc.status === 'suspended' ? 'unsuspend-account' : 'suspend-account'}" ${attributes}>${acc.status === 'suspended' ? (isAr ? 'إلغاء التعليق' : 'Unsuspend') : (isAr ? 'تعليق' : 'Suspend')}</button>` : ''}${canTerminate && acc.status !== 'terminating' ? `<button type="button" class="xp-btn xp-btn--ghost xp-accounts__delete" data-action="terminate-account" ${attributes}>${isAr ? 'حذف' : 'Delete'}</button>` : ''}${!canSuspend && !canTerminate ? `<span class="xp-help">${isAr ? 'للعرض فقط' : 'Read only'}</span>` : ''}</div>
          </td>
          </tr>`
        }).join('') || `<tr>
          <td colspan="5">
          <p class="xp-accounts__empty">${isAr ? 'لا توجد حسابات.' : 'No accounts.'}</p>
          </td>
          </tr>`}</tbody>
          </table>
          </div>
        <dialog class="xp-account-dialog" data-account-dialog aria-labelledby="xp-account-dialog-title" aria-describedby="xp-account-dialog-description">
          <form method="dialog" data-account-action-form novalidate>
            <div class="xp-account-dialog__header">
          <h2 id="xp-account-dialog-title" data-account-dialog-title>${isAr ? 'إجراء الحساب' : 'Account action'}</h2>
          <p id="xp-account-dialog-description" data-account-dialog-description>
          </p>
          </div>
            <dl class="xp-account-dialog__identity">
          <div class="xp-accounts__field">
          <dt>${isAr ? 'الحساب' : 'Account'}</dt>
          <dd>
          <bdi dir="ltr" data-account-dialog-username>
          </bdi>
          </dd>
          </div>
          <div class="xp-accounts__field">
          <dt>${isAr ? 'النطاق الأساسي' : 'Primary domain'}</dt>
          <dd>
          <bdi dir="ltr" data-account-dialog-domain>
          </bdi>
          </dd>
          </div>
          </dl>
            <div class="xp-accounts__field" data-account-confirm-field hidden>
          <label class="xp-label" for="terminate-confirm-user">${isAr ? 'اكتب اسم المستخدم للتأكيد' : 'Type the username to confirm'}</label>
          <input id="terminate-confirm-user" name="confirmUsername" type="text" class="xp-input xp-mono" dir="ltr" autocomplete="off" spellcheck="false" data-type-to-confirm="true" aria-describedby="xp-account-confirm-help" />
          <span class="xp-help" id="xp-account-confirm-help">${isAr ? 'يجب أن يطابق اسم الحساب أعلاه تمامًا.' : 'Must exactly match the account above.'}</span>
          </div>
            <div class="xp-accounts__field" data-account-reason-field hidden>
          <label class="xp-label" for="account-suspend-reason">${isAr ? 'سبب التعليق' : 'Suspension reason'}</label>
          <textarea id="account-suspend-reason" name="reason" class="xp-textarea" rows="2" maxlength="500"></textarea>
          </div>
            <p class="xp-account-dialog__status" data-account-action-status role="status" aria-live="polite" tabindex="-1" hidden>
          </p>
            <div class="xp-account-dialog__footer">
          <button type="button" class="xp-btn" data-account-action-cancel>${isAr ? 'إلغاء' : 'Cancel'}</button>
          <button type="submit" class="xp-btn xp-btn--primary" data-account-action-submit disabled>${isAr ? 'تأكيد' : 'Confirm'}</button>
          </div>
          </form>
        </dialog>` : ''}
        ${section === 'create-account' ? `<form class="xp-form-group" id="whm-create-account-drawer" action="/api/accounts" method="post" data-create-account-form="true">
          <div class="xp-accounts__field">
          <label class="xp-label" for="new-acc-username">${isAr ? 'اسم المستخدم' : 'Username'}</label>
          <input id="new-acc-username" name="username" type="text" class="xp-input xp-mono" dir="ltr" required pattern="[a-z][a-z0-9]{2,15}" placeholder="salma" />
          </div>
          <div class="xp-accounts__field">
          <label class="xp-label" for="new-acc-domain">${isAr ? 'النطاق الأساسي' : 'Primary domain'}</label>
          <input id="new-acc-domain" name="primaryDomain" type="text" class="xp-input xp-mono" dir="ltr" required placeholder="salma.studio" />
          </div>
          <div class="xp-accounts__field">
          <label class="xp-label" for="new-acc-contact">${isAr ? 'بريد التواصل' : 'Contact email'}</label>
          <input id="new-acc-contact" name="contactEmail" type="email" class="xp-input" dir="ltr" autocomplete="email" inputmode="email" spellcheck="false" />
          </div>
          <div class="xp-accounts__field">
          <label class="xp-label" for="new-acc-plan">${isAr ? 'خطة الاستضافة' : 'Hosting plan'}</label>
          <select id="new-acc-plan" name="planId" class="xp-select" required>${plans.map(plan => `<option value="${escapeHtml(plan.id)}">${escapeHtml(formatDisplayName(plan.name))}</option>`).join('')}</select>
          </div>
          <div class="xp-accounts__field">
            <label class="xp-label" for="new-acc-password">${isAr ? 'كلمة المرور' : 'Password'}</label>
            <input id="new-acc-password" name="password" type="password" class="xp-input" autocomplete="new-password" minlength="8" required aria-describedby="new-acc-password-help" />
            <span class="xp-help" id="new-acc-password-help">${isAr ? '8 أحرف على الأقل.' : 'At least 8 characters.'}</span>
          </div>
          <div class="xp-accounts__field">
          <label class="xp-label" for="new-acc-ipv4">${isAr ? 'تعيين IPv4' : 'IPv4 assignment'}</label>
          <select id="new-acc-ipv4" name="ipAssignment" class="xp-select" required aria-describedby="new-acc-ipv4-address new-acc-ipv4-status">
            <option value="shared">${isAr ? 'المشترك الافتراضي' : 'Default shared'}</option>
            <option value="dedicated:auto" disabled>${isAr ? 'مخصص تلقائي' : 'Dedicated · Automatic'}</option>
          </select>
          <div class="xp-help">
            <output class="xp-field-value xp-mono" data-account-ip-preview hidden><bdi id="new-acc-ipv4-address" dir="ltr" style="display:inline" data-account-ip-address></bdi></output>
            <span id="new-acc-ipv4-status" data-account-ip-status role="status" aria-live="polite">${isAr ? 'جارٍ تحميل العناوين…' : 'Loading IP availability…'}</span>
          </div>
          <button type="button" class="xp-btn xp-btn--ghost" style="justify-self:start" data-account-ip-refresh>${isAr ? 'تحديث العناوين' : 'Refresh IP availability'}</button>
          </div>
          <div class="xp-accounts__field">
          <label class="xp-label" for="new-acc-ipv6">${isAr ? 'عنوان IPv6 (اختياري)' : 'IPv6 address (optional)'}</label>
          <input id="new-acc-ipv6" name="ipv6" type="text" class="xp-input xp-mono" dir="ltr" value="" />
          </div>
          <p class="xp-help" data-account-create-status role="status" aria-live="polite" tabindex="-1" hidden></p>
          <button type="submit" class="xp-btn xp-btn--primary" ${plans.length && (isRoot || heldAcls.has('create-account')) ? '' : 'disabled'}>${escapeHtml(t(locale, 'accounts.create'))}</button>
        </form>` : ''}
      </section>

` : ''}
      ${section === 'plans' ? `      <!-- Plans & Feature Lists + cgroup v2 Resource Limits Drawer -->
      <section class="xp-card" id="whm-plans" data-section="plans-feature-lists" aria-labelledby="whm-plans-heading">
        <div class="xp-card__header">
          <div>
            <h1 id="whm-plans-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
            <p class="xp-prose">${isAr ? 'تحدد الخطة حدود موارد كل حساب. اختر «غير محدود» لإزالة حد معين.' : 'A plan sets each account’s resource limits. Choose Unlimited to remove a limit.'}</p>
          </div>
          ${renderStatusBadge('ok', `${plans.length} ${isAr ? 'خطة' : 'plans'}`)}
        </div>

        <div class="xp-table-wrap">
          <table class="xp-table">
            <thead>
              <tr>
                <th>${isAr ? 'الخطة' : 'Plan'}</th>
                <th>${isAr ? 'القرص / نقل البيانات' : 'Disk / Bandwidth'}</th>
                <th>${isAr ? 'المعالج / الذاكرة' : 'CPU / Memory'}</th>
                <th>${isAr ? 'قراءة / كتابة القرص' : 'Disk read / write'}</th>
                <th>${isAr ? 'العمليات' : 'Processes'}</th>
                <th>${isAr ? 'النطاقات الإضافية' : 'Addon Domains'}</th>
                <th>${isAr ? 'الصدفة المعزولة' : 'Jailed Shell'}</th>
              </tr>
            </thead>
            <tbody>
              ${plans
                .map(
                  (plan) => `
                <tr data-plan-row="${escapeHtml(plan.name)}">
                  <td><strong>${escapeHtml(formatDisplayName(plan.name))}</strong></td>
                  <td class="xp-mono xp-tabular">${renderLtrValue(`${plan.resources.diskMb === 'unlimited' ? 'unlimited' : `${plan.resources.diskMb / 1024} GB`} / ${plan.resources.bandwidthMbMonth === 'unlimited' ? 'unlimited' : `${plan.resources.bandwidthMbMonth / 1024} GB`}`, 'xp-plan-resource-value')}</td>
                  <td class="xp-mono xp-tabular">${renderLtrValue(`${plan.resources.cpuPercent}% / ${plan.resources.memoryMb} MB`, 'xp-plan-resource-value')}</td>
                  <td class="xp-mono xp-tabular">${renderLtrValue(`${plan.resources.ioReadBps === 'unlimited' ? 'unlimited' : formatBytes(plan.resources.ioReadBps)}/s · ${plan.resources.ioWriteBps === 'unlimited' ? 'unlimited' : formatBytes(plan.resources.ioWriteBps)}/s`, 'xp-plan-resource-value')}</td>
                  <td class="xp-mono xp-tabular">${plan.resources.maxProcesses}</td>
                  <td class="xp-mono xp-tabular">${String(plan.caps.addonDomains)}</td>
                  <td>${renderStatusBadge(plan.shell === 'jailed' ? 'ok' : 'suspended', plan.shell === 'jailed' ? (isAr ? 'معزولة' : 'jailed') : (isAr ? 'بدون' : 'none'))}</td>
                  <td><button type="button" class="xp-btn" data-plan-delete="${escapeHtml(plan.id)}">${isAr ? 'حذف' : 'Delete'}</button></td>
                </tr>
              `,
                )
                .join('')}
            </tbody>
          </table>
        </div>

        <dialog class="xp-account-dialog" data-plan-delete-dialog aria-labelledby="plan-delete-title">
          <form method="dialog">
            <div class="xp-account-dialog__header">
              <h2 id="plan-delete-title">${isAr ? 'حذف الخطة' : 'Delete plan'}</h2>
              <p>${isAr ? 'لا يمكن التراجع عن حذف الخطة.' : 'Deleting a plan cannot be undone.'}</p>
            </div>
            <p class="xp-account-dialog__status" data-dialog-status role="status" hidden></p>
            <div class="xp-account-dialog__footer">
              <button type="button" class="xp-btn" data-dialog-cancel>${isAr ? 'إلغاء' : 'Cancel'}</button>
              <button type="submit" class="xp-btn xp-btn--primary">${isAr ? 'حذف' : 'Delete'}</button>
            </div>
          </form>
        </dialog>
        <!-- Create / Edit Plan Drawer Form with Explicit Unlimited Checkboxes -->
        <form class="xp-card xp-form-group" style="margin-block-start: var(--xp-space-card);" action="/api/plans" method="post" data-plan-editor-form="true">
          <div class="xp-card__header">
            <h3>${isAr ? 'إنشاء / تعديل خطة' : 'Create / edit plan'}</h3>
          </div>
          <div class="xp-kpi-grid">
            <div class="xp-field">
              <label class="xp-label" for="plan-name">${isAr ? 'اسم الخطة' : 'Plan Name'}</label>
              <input id="plan-name" name="name" type="text" class="xp-input" required maxlength="64" />
            </div>
            <div class="xp-field">
              <label class="xp-label" for="plan-cpu-quota">${isAr ? 'المعالج (%)' : 'CPU (%)'}</label>
              <input id="plan-cpu-quota" name="cpuPercent" type="number" class="xp-input xp-mono" value="200" />
            </div>
            <div class="xp-field">
              <label class="xp-label" for="plan-memory-max">${isAr ? 'الذاكرة (MB)' : 'Memory (MB)'}</label>
              <input id="plan-memory-max" name="memoryMb" type="number" class="xp-input xp-mono" value="2048" />
            </div>
            <div class="xp-field">
              <label class="xp-label" for="plan-io-max">${isAr ? 'قراءة / كتابة القرص (MB/s)' : 'Disk read / write (MB/s)'}</label>
              <input id="plan-io-max" name="ioMaxMbps" type="text" class="xp-input xp-mono" dir="ltr" value="100 / 50" />
            </div>
            <div class="xp-field">
              <label class="xp-label" for="plan-tasks-max">${isAr ? 'العمليات' : 'Processes'}</label>
              <input id="plan-tasks-max" name="maxProcesses" type="number" class="xp-input xp-mono" value="128" />
            </div>
            <div class="xp-field">
              <label class="xp-label" for="plan-shell-toggle">${isAr ? 'وصول الطرفية المعزولة' : 'Jailed shell access'}</label>
              <select id="plan-shell-toggle" name="shell" class="xp-select">
                <option value="jailed">${isAr ? 'طرفية معزولة' : 'Jailed shell'}</option>
                <option value="none">${isAr ? 'معطل' : 'Disabled'}</option>
              </select>
            </div>
          </div>
          <div class="xp-plan-editor-actions">
            <label class="xp-plan-cap-option">
              <input type="checkbox" name="unlimitedAddonDomains" value="unlimited" />
              <span>${isAr ? 'نطاقات إضافية غير محدودة' : 'Unlimited addon domains'}</span>
            </label>
            <p class="xp-help" data-plan-status role="status" hidden></p>
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
            <p class="xp-prose">${isAr ? 'عند تعطيل البيع الزائد، يُرفض إنشاء حساب إذا تجاوز مجموع حدود الخطط حصة الموزع من القرص أو نقل البيانات.' : 'With overselling off, account creation is refused if total plan limits exceed the reseller’s disk or bandwidth cap.'}</p>
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
                  (res) => `
                <tr data-reseller-row="${escapeHtml(res.username)}">
                  <td><strong class="xp-mono"><bdi dir="ltr">${escapeHtml(res.username)}</bdi></strong></td>
                  <td>${renderThresholdMeter(undefined, res.maxAccounts, { locale, unit: isAr ? 'حسابات' : 'accounts', label: isAr ? 'عدد حسابات الموزع' : 'Reseller accounts', configuredLimit: true })}</td>
                  <td>${renderThresholdMeter(undefined, res.totalDiskMb === 'unlimited' ? res.totalDiskMb : Number.isSafeInteger(res.totalDiskMb) ? res.totalDiskMb / 1024 : undefined, { locale, unit: 'GiB', label: isAr ? 'تخصيص القرص' : 'Disk allocation', configuredLimit: true })}</td>
                  <td>${renderStatusBadge(res.oversell ? 'warn' : 'ok', res.oversell ? (isAr ? 'البيع الزائد مفعّل' : 'Oversell on') : (isAr ? 'البيع الزائد متوقف' : 'Oversell off'))}</td>
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
          <div class="xp-label" style="margin-block-end: 8px;">${isAr ? 'صلاحيات الموزع' : 'Reseller permissions'}</div>
          <div style="display: flex; flex-wrap: wrap; gap: 8px;">
            ${ALL_RESELLER_ACLS.map((acl) =>
              renderStatusBadge(
                heldAcls.has(acl) ? 'ok' : 'suspended',
                `${acl}: ${heldAcls.has(acl) ? 'granted' : 'revoked'}`,
              ),
            ).join('')}
          </div>
        </div>
        ${isRoot ? `<form class="xp-card xp-form-group" style="margin-block-start: var(--xp-space-card);" data-reseller-create-form="true">
          <div class="xp-card__header"><h2>${isAr ? 'موزع جديد' : 'New reseller'}</h2></div>
          <div class="xp-kpi-grid">
            <div class="xp-field"><label class="xp-label" for="reseller-username">${isAr ? 'اسم المستخدم' : 'Username'}</label><input id="reseller-username" name="username" class="xp-input xp-mono" dir="ltr" required maxlength="16" autocomplete="off" /></div>
            <div class="xp-field"><label class="xp-label" for="reseller-password">${isAr ? 'كلمة المرور' : 'Password'}</label><input id="reseller-password" name="password" type="password" class="xp-input" required autocomplete="new-password" /></div>
            <div class="xp-field"><label class="xp-label" for="reseller-accounts">${isAr ? 'حد الحسابات' : 'Account limit'}</label><input id="reseller-accounts" name="maxAccounts" type="number" class="xp-input xp-mono" min="0" value="10" required /></div>
            <div class="xp-field"><label class="xp-label" for="reseller-disk">${isAr ? 'حد القرص (MB)' : 'Disk limit (MB)'}</label><input id="reseller-disk" name="totalDiskMb" type="number" class="xp-input xp-mono" min="1" value="10240" required /></div>
            <div class="xp-field"><label class="xp-label" for="reseller-bandwidth">${isAr ? 'حد النقل (MB)' : 'Bandwidth limit (MB)'}</label><input id="reseller-bandwidth" name="totalBandwidthMb" type="number" class="xp-input xp-mono" min="1" value="102400" required /></div>
          </div>
          <label class="xp-plan-cap-option"><input type="checkbox" name="oversell" /><span>${isAr ? 'السماح بالبيع الزائد' : 'Allow overselling'}</span></label>
          <fieldset class="xp-field" data-reseller-acl-choices="true"><legend class="xp-label">${isAr ? 'الصلاحيات' : 'Permissions'}</legend>
            <div style="display: flex; flex-wrap: wrap; gap: 8px;">
              ${ALL_RESELLER_ACLS.map(acl => `<label class="xp-plan-cap-option"><input type="checkbox" name="acl" value="${escapeHtml(acl)}" /><span class="xp-mono" dir="ltr">${escapeHtml(acl)}</span></label>`).join('')}
            </div>
          </fieldset>
          <p class="xp-help" data-reseller-status role="status" hidden></p>
          <button type="submit" class="xp-btn xp-btn--primary">${isAr ? 'إنشاء الموزع' : 'Create reseller'}</button>
        </form>` : ''}
      </section>

      <!-- Multi-IPv4 / Multi-IPv6 Pool & Postfix Mail Outbound IP Configuration -->
` : ''}
      ${section === 'ips' || (section === 'mail-ips' && mailIpConfig) ? `      <section class="xp-card" id="whm-ip-pool" data-section="multi-ip-mail-pool" aria-labelledby="whm-ip-pool-heading">
        <div class="xp-card__header">
          <div>
            <h1 id="whm-ip-pool-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
            <p class="xp-prose">${isAr ? 'إدارة عناوين IP وتفويضها للحسابات والموزعين وضبط توجيه البريد الصادر.' : 'Manage IP addresses, account and reseller assignments, and outbound mail routing.'}</p>
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
            </div>

            <div class="xp-field">
              <label class="xp-label" for="mail-outbound-mode">${isAr ? 'توجيه البريد الصادر' : 'Outbound mail routing'}</label>
              <select id="mail-outbound-mode" name="mode" class="xp-select">
                <option value="server-default" ${mailIpConfig.mode === 'server-default' ? 'selected' : ''}>server-default (${escapeHtml(t(locale, 'mailIp.mode.server-default'))})</option>
                <option value="account-ip" ${mailIpConfig.mode === 'account-ip' ? 'selected' : ''}>account-ip (${escapeHtml(t(locale, 'mailIp.mode.account-ip'))})</option>
                <option value="domain-ip" ${mailIpConfig.mode === 'domain-ip' ? 'selected' : ''}>domain-ip (${escapeHtml(t(locale, 'mailIp.mode.domain-ip'))})</option>
                <option value="custom-map" ${mailIpConfig.mode === 'custom-map' ? 'selected' : ''}>custom-map (${escapeHtml(t(locale, 'mailIp.mode.custom-map'))})</option>
              </select>
            </div>

            <div class="xp-kpi-grid">
              <div class="xp-field">
                <label class="xp-label" for="mail-default-ipv4">${isAr ? 'عنوان IPv4 الصادر الافتراضي' : 'Default outbound IPv4'}</label>
                <input id="mail-default-ipv4" name="defaultIpv4" type="text" class="xp-input xp-mono" dir="ltr" value="${escapeHtml(mailIpConfig.defaultIpv4 ?? '')}" />
              </div>
              <div class="xp-field">
                <label class="xp-label" for="mail-default-ipv6">${isAr ? 'عنوان IPv6 الصادر الافتراضي' : 'Default outbound IPv6'}</label>
                <input id="mail-default-ipv6" name="defaultIpv6" type="text" class="xp-input xp-mono" dir="ltr" value="${escapeHtml(mailIpConfig.defaultIpv6 ?? '')}" />
              </div>
              <div class="xp-field">
                <label class="xp-label" for="mail-default-helo">${escapeHtml(t(locale, 'mailIp.defaultHelo'))}</label>
                <input id="mail-default-helo" name="defaultHelo" type="text" class="xp-input xp-mono" dir="ltr" value="${escapeHtml(mailIpConfig.defaultHelo ?? '')}" />
              </div>
            </div>

            <div>
              <div class="xp-label">${escapeHtml(t(locale, 'mailIp.overrides'))}</div>
              <pre class="xp-terminal" dir="ltr"><bdi dir="ltr">${escapeHtml(mailIpConfig.domainOverrides.map(override => [override.domainName, override.ipv4, override.ipv6, override.heloHostname].filter(Boolean).join(' · ')).join('\n') || (isAr ? 'لا توجد إعدادات خاصة بالنطاقات.' : 'No domain overrides are configured.'))}</bdi></pre>
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
              <label class="xp-label" for="add-ip-prefix">${isAr ? 'طول بادئة الشبكة (CIDR)' : 'Subnet prefix length (CIDR)'}</label>
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
              <strong>${isAr ? 'تراجع تلقائي خلال 60 ثانية' : 'Automatic rollback after 60 seconds'}</strong>
              <p style="margin: 4px 0 0; font-size: 0.85rem; color: var(--xp-text-secondary);">
                ${isAr ? `تُرفض القواعد التي تحظر جلستك الحالية (${adminSessionIp}) أو منافذ الإدارة أو SSH. أكد الاتصال خلال 60 ثانية وإلا ستُستعاد القواعد السابقة.` : `Changes that block your current session (${adminSessionIp}), management ports or SSH are refused. Confirm connectivity within 60 seconds or the previous rules are restored.`}
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
              <p class="xp-prose">${isAr ? 'تُفحص الإعدادات قبل التفعيل، وتُحفظ الإصدارات السابقة للتراجع.' : 'Configuration is checked before applying. Previous generations are kept for rollback.'}</p>
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
            </div>
            <form method="get" action="/whm/audit" data-audit-filters="true" class="xp-form-group">
              <label class="xp-label" for="audit-actor">${isAr ? 'الفاعل' : 'Actor'}</label>
              <input id="audit-actor" name="actor" maxlength="128" value="${escapeHtml(auditActor)}">
              <label class="xp-label" for="audit-action">${isAr ? 'الإجراء' : 'Action'}</label>
              <input id="audit-action" name="action" maxlength="128" value="${escapeHtml(auditAction)}">
              <label class="xp-label" for="audit-target">${isAr ? 'الهدف' : 'Target'}</label>
              <input id="audit-target" name="target" maxlength="480" value="${escapeHtml(auditTarget)}">
              <button type="submit" class="xp-btn">${isAr ? 'تصفية' : 'Filter'}</button>
            </form>
            <div class="xp-table-wrap">
              <table class="xp-table">
                <thead>
                  <tr>
                    <th>UTC</th>
                    <th>${isAr ? 'المستخدم' : 'User'}</th>
                    <th>${isAr ? 'الإجراء' : 'Action'}</th>
                    <th>${isAr ? 'الهدف' : 'Target'}</th>
                    <th>${isAr ? 'النتيجة' : 'Outcome'}</th>
                  </tr>
                </thead>
                <tbody>
                  ${auditEntries.length ? auditEntries
                    .map(
                      (entry) => `
                    <tr data-audit-id="${escapeHtml(entry.id)}">
                      <td class="xp-mono xp-tabular"><time datetime="${escapeHtml(entry.at)}">${escapeHtml(formatAsciiDate(entry.at, { includeTime: true }))}</time></td>
                      <td class="xp-mono"><bdi dir="ltr">${escapeHtml(auditActorLabel(entry.actor))}</bdi></td>
                      <td>${auditActionHtml(entry.action, locale, entry)}</td>
                      <td><bdi dir="ltr">${escapeHtml(auditTargetLabel(entry.target, locale))}</bdi></td>
                      <td>${renderStatusBadge(entry.outcome === 'ok' ? 'ok' : entry.outcome === 'denied' ? 'warn' : 'critical', auditOutcomeLabel(entry.action, entry.outcome, locale))}</td>
                    </tr>
                  `,
                    )
                    .join('') : `<tr><td colspan="5">${isAr ? 'لا مدخلات تدقيق بعد' : 'No audit entries yet'}</td></tr>`}
                </tbody>
              </table>
            </div>
            <nav data-audit-pager="true">
              ${auditBefore ? `<a href="${escapeHtml(auditHref())}">${isAr ? 'الأحدث' : 'Newest'}</a>` : ''}
              ${auditList?.hasMore && auditList.oldestId ? `<a data-audit-older="true" href="${escapeHtml(auditHref(auditList.oldestId))}">${isAr ? 'الأقدم' : 'Older'}</a>` : ''}
            </nav>
          </section>` : ''}
${section === 'upgrade' ? `<section class="xp-card" data-section="root-lifecycle"><h1 class="xp-page-title">${escapeHtml(pageTitle)}</h1><p class="xp-prose"><bdi dir="ltr">${escapeHtml(version)} → ${escapeHtml(availableVersion)}</bdi></p><p class="xp-prose">${isAr ? 'راجع فحص الترقية قبل تأكيد أي تغيير.' : 'Review the upgrade preflight before confirming any change.'}</p><button type="button" class="xp-btn xp-btn--primary" data-action="start-upgrade" ${isRoot && props.availableVersion ? '' : 'disabled'}>${isAr ? 'فحص الترقية' : 'Check upgrade'}</button></section>` : ''}
${section === 'transfer' ? `<section class="xp-card" data-section="root-lifecycle"><h1 class="xp-page-title">${escapeHtml(pageTitle)}</h1><p class="xp-prose">${isAr ? 'اختر مصدر النقل وراجع الحسابات قبل الاستيراد.' : 'Choose the transfer source and review its accounts before importing.'}</p><button type="button" class="xp-btn xp-btn--primary" data-action="start-transfer" ${isRoot ? '' : 'disabled'}>${isAr ? 'بدء النقل' : 'Start transfer'}</button></section>` : ''}
${section === 'security' ? `<section class="xp-card" data-section="account-security"><h1 class="xp-page-title">${escapeHtml(pageTitle)}</h1></section>` : ''}
${section === 'design' ? renderDesignMain(activeRoute, locale) : ''}
${section === undefined || (section === 'io' && !ioSnapshot) || (section === 'mail-ips' && !mailIpConfig) ? renderSurfaceUnavailable(locale, '/whm') : ''}`,
  })
  return ensureAccessibleSurfaceHtml(rawHtml.trim(), locale)
}
