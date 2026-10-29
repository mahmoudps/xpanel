import { visibleNavigation, type CatalogTool, type VisibilityContext } from '@xpanel/catalog'
import type {
  Account,
  AuditEntry,
  Certificate,
  Domain,
  ServerSettings,
  FeatureList,
  FirewallRule,
  IoAnalyticsSnapshot,
  MailIpConfig,
  Plan,
  Principal,
  Reseller,
  ResellerAcl,
  ServerIpEntry,
} from '@xpanel/core'
import { canManagePlan } from '@xpanel/core'
import { renderPlanEditor } from '../plan-editor.ts'
import { accountListModel, accountListRowAttributes, accountPlanPreviewModel, renderAccountListControls, renderAccountPlanPreview } from '../account-list.ts'
import { renderServerIoMonitorChart } from '../charts.ts'
import { formatDisplayName } from '../display-name.ts'
import { roleLabel } from '../chrome.ts'
import { renderHandoffButton } from '../panel-handoff-controls.ts'
import { renderWhmDetailPage, renderWhmAuditExports, renderWhmAuditSupplement, renderWhmDnsSupplement, renderWhmMailOutboundSupplement } from '../board-port/approved-xwhm.ts'
import { renderApprovedWhmBackups } from '../board-port/approved-whm-backups.ts'
import { renderWhmDnsWorkspace } from '../board-port/whm-dns-workspace.ts'
import { renderApprovedWhmResellers, resellerDetailAnchor } from '../board-port/approved-whm-resellers.ts'
import { renderApprovedWhmOperationsSupplement } from '../board-port/approved-whm-operations-components.ts'
import { renderApprovedWhmPlanSupplement } from '../board-port/approved-whm-plan-components.ts'
import { renderApprovedWhmAccountCreateFields, renderApprovedWhmAccountCreateStatus, renderApprovedWhmAccountBulkControls, renderApprovedWhmAccountSelection, renderApprovedWhmAccountActions, renderApprovedWhmAccountTableCells } from '../board-port/approved-whm-account-components.ts'
import { localeDirection, translator, type Locale } from '../i18n.ts'
import {
  type AsyncActionBannerProps,
  ensureAccessibleSurfaceHtml,
  escapeHtml,
  formatAsciiDate,
  formatDisplayDateTime,
  formatBytes,
  renderAsyncActionState,
  renderLtrValue,
  renderStatusBadge,
  renderThresholdMeter,
} from '../tokens.ts'
import { auditActionHtml, auditActorLabel, auditOutcomeLabel, auditTargetLabel } from '../audit-labels.ts'
import { isArabicSentence } from '../arabic-type.ts'
import { renderWhmDashboard, whmDashboardFromProps, type DashboardHostSample } from '../board-port/xwhm-dashboard.ts'
import { renderDesignMain, renderDesignNav } from '../design-board.ts'
import { renderComposedXwhm } from '../board-port/composed/render.ts'
import { composedRouteSpecs } from '../board-port/composed/all.ts'
import { copyOf } from '../board-port/composed/types.ts'
import { renderStoreExtension, storeRouteSpecs } from '../board-port/extensions/store.ts'
import { renderSurfaceShell, renderSurfaceUnavailable, resolveSurfaceSection, renderUnavailableSurfaceShell, getSurfacePageTitle, normalizeSurfaceRoute, renderLiveUpdatesIndicator, renderPageSearchButton, renderSurfaceToolbar } from '../shell.ts'


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
  density?: 'comfortable' | 'compact'
  capabilityUnavailable?: boolean
  serverSettings?: ServerSettings | null
  domains?: readonly Domain[]
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
  featureLists?: readonly (Pick<FeatureList, 'id' | 'name'> & Partial<Pick<FeatureList, 'disabled' | 'ownerId'>>)[]
  planEditorState?: { kind: 'create' } | { kind: 'edit'; plan: Plan } | { kind: 'unavailable' }
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
    outcome?: string
    from?: string
    to?: string
  }
  hostSample?: DashboardHostSample | null
  driftCount?: number | null
  driftCheckedAt?: string | null
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
  if (props.capabilityUnavailable) return ensureAccessibleSurfaceHtml(renderWhmDetailPage({ activeRoute: props.activeRoute, locale, capabilityUnavailable: true }) ?? renderUnavailableSurfaceShell('xwhm', locale), locale)
  const rtl = localeDirection(locale) === 'rtl'
  const theme = props.theme ?? 'dark'
  const density = props.density ?? 'comfortable'
  const principal = props.visibility?.principal ?? props.principal
  if (!principal) return ensureAccessibleSurfaceHtml(renderUnavailableSurfaceShell('xwhm', locale), locale)
  const isRoot = principal.kind === 'root'
  const activeRoute = normalizeSurfaceRoute('xwhm', props.activeRoute ?? '/whm')
  const section = resolveSurfaceSection('xwhm', activeRoute)
  const storeSpec = storeRouteSpecs.find(row => row.route === activeRoute) ?? (activeRoute === '/whm/software/site-software' ? storeRouteSpecs.find(row => row.route === '/whm/software/store') : undefined)
  const extensionHtml = storeSpec ? renderStoreExtension({ locale, route: activeRoute, principal, ...(props.plans !== undefined ? { plans: { state: 'read', items: props.plans } } : {}) }) : undefined
  const composedResellerAcl = props.visibility?.reseller?.acl
    ?? (principal.kind === 'reseller' && props.activeReseller?.id === principal.id ? props.activeReseller.acl : undefined)
  const composedHtml = renderComposedXwhm({
    locale, route: activeRoute, principal,
    ...(principal.kind === 'reseller' && composedResellerAcl ? { reseller: { id: principal.id, acl: composedResellerAcl } } : {}),
    ...(props.accounts !== undefined ? { accounts: props.accounts } : {}),
    ...(props.resellers !== undefined ? { resellers: props.resellers } : {}),
  })
  const composedSpec = composedHtml !== undefined ? composedRouteSpecs.find(row => row.surface === 'xwhm' && row.route === activeRoute) : undefined
  const pageTitle = storeSpec ? copyOf(storeSpec.title, locale) : composedSpec ? copyOf(composedSpec.title, locale) : getSurfacePageTitle('xwhm', section, locale, activeRoute)
  const hostname = props.hostname ?? (translator(locale)('Server'))
  const version = props.version ?? (translator(locale)('Unavailable'))
  const availableVersion = props.availableVersion ?? (translator(locale)('Unavailable'))
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
  const auditOutcome = auditList?.outcome ?? ''
  const auditFrom = auditList?.from ?? ''
  const auditTo = auditList?.to ?? ''
  const auditHeaders = ['UTC', translator(locale)('User'), translator(locale)('Action'), translator(locale)('Target'), translator(locale)('Outcome')] as const
  const auditMobileLabel = (label: string): string => `<span class="xp-audit-mobile-label" aria-hidden="true">${escapeHtml(label)}</span>`
  const auditHref = (before?: string): string => {
    const params = new URLSearchParams({ lang: locale, theme, density })
    if (auditActor) params.set('actor', auditActor)
    if (auditAction) params.set('action', auditAction)
    if (auditTarget) params.set('target', auditTarget)
    if (auditOutcome) params.set('outcome', auditOutcome)
    if (auditFrom) params.set('from', auditFrom)
    if (auditTo) params.set('to', auditTo)
    if (before) params.set('before', before)
    const query = params.toString()
    return query ? `/whm/audit?${query}` : '/whm/audit'
  }

  const whmNav = visibleNavigation(props.visibility, props.catalog).find((n) => n.surface === 'xwhm')
  const qualifiedRoutes = new Set((whmNav?.sections ?? []).flatMap(section => section.pages.map(page => page.route)))
  const heldAcls = new Set<ResellerAcl>(props.visibility?.reseller?.acl ?? props.activeReseller?.acl ?? [])
  const list = accountListModel({ principal, activeReseller: props.activeReseller, accounts: props.accounts, plans: props.plans, resellers: props.resellers })
  const canManageVisiblePlan = (plan: Plan): boolean => (isRoot || heldAcls.has('manage-plans')) && canManagePlan(principal, plan)
  const requestedPlan = props.planEditorState?.kind === 'edit' ? props.planEditorState.plan : undefined
  const selectedPlan = requestedPlan ? plans.find(plan => plan.id === requestedPlan.id) : undefined
  const planEditorUnavailable = props.planEditorState?.kind === 'unavailable' || (props.planEditorState?.kind === 'edit' && !selectedPlan)
  const planHref = (id?: string): string => {
    const query = new URLSearchParams({ lang: locale, theme })
    if (id) query.set('planId', id)
    return `/whm/plans?${query.toString()}`
  }
  const navigationVisibility: VisibilityContext = props.visibility ?? {
    principal,
    ...(principal.kind === 'reseller' ? { reseller: { acl: [...heldAcls] } } : {}),
    disabledFeatures: new Set(),
  }

  const nextTheme = theme === 'dark' ? 'light' : 'dark'
  const actionBannerHtml = props.actionState
    ? renderAsyncActionState({ ...props.actionState, locale })
    : ''

  if (section === 'overview') return ensureAccessibleSurfaceHtml(renderWhmDashboard(whmDashboardFromProps({
    locale, theme, realtimeEnabled: props.realtimeEnabled === true, principal, visibility: navigationVisibility, hostname: props.hostname, panelHostname: props.panelHostname, version: props.version, availableVersion: props.availableVersion,
    generationId: props.generationId, accounts: props.accounts, resellers: props.resellers, ipPool: props.ipPool,
    plans: props.plans, services, auditEntries, hostSample: props.hostSample, driftCount: props.driftCount,
    ...(props.driftCheckedAt ? { driftCheckedAt: props.driftCheckedAt } : {}),
    certificates: props.certificates, rollbackGenerationId: props.rollbackGenerationId,
    ...(props.generationActivatedAt ? { generationActivatedAt: props.generationActivatedAt } : {}),
    ...(props.nearLimits ? { nearLimits: props.nearLimits } : {}),
  })), locale)

  const detailHtml = renderWhmDetailPage({ ...props, activeRoute, locale })
  const nativeContent = detailHtml !== undefined ? actionBannerHtml + detailHtml : extensionHtml !== undefined ? actionBannerHtml + extensionHtml : composedHtml !== undefined ? actionBannerHtml + composedHtml : `      ${actionBannerHtml}
${section === 'overview' ? `      <section class="xp-card" data-section="overview-attention">
        <div class="xp-card__header"><div><h1 class="xp-page-title">${escapeHtml(pageTitle)}</h1><p class="xp-prose"><bdi dir="ltr">${escapeHtml(hostname)}</bdi></p></div></div>
        <div class="xp-kpi-grid" data-section="whm-kpi-cards">
          <div class="xp-field"><span class="xp-label">${translator(locale)('Accounts')}</span><strong>${props.accounts ? accounts.length : (translator(locale)(msgctxt('xwhm', 'Unavailable')))}</strong></div>
          <div class="xp-field"><span class="xp-label">${translator(locale)('Plans')}</span><strong>${props.plans ? plans.length : (translator(locale)(msgctxt('xwhm', 'Unavailable')))}</strong></div>
          <div class="xp-field"><span class="xp-label">${translator(locale)('Version')}</span><strong><bdi dir="ltr">${escapeHtml(version)}</bdi></strong></div>
          <div class="xp-field"><span class="xp-label">${translator(locale)(msgctxt('xwhm', 'Operator'))}</span><strong><bdi dir="ltr">${escapeHtml(principal.username)}</bdi></strong></div>
        </div>
        <p class="xp-prose" role="status" data-host-observation="unavailable">${translator(locale)('Host resource measurements unavailable.')}</p>
        <section class="xp-board-section" aria-labelledby="whm-reconcile">
          <header class="xp-board-section__head"><h2 id="whm-reconcile">${translator(locale)('Reconciler')}</h2></header>
          <div class="xp-board-section__body"><p role="status">${generationId !== undefined ? `<bdi dir="ltr">#${generationId}</bdi>` : (translator(locale)('No generation is applied yet.'))}</p></div>
        </section>
        <section class="xp-board-section" aria-labelledby="whm-dash-accounts">
          <header class="xp-board-section__head"><h2 id="whm-dash-accounts">${translator(locale)('Accounts')}</h2></header>
          <dl class="xp-board-dl">
            <div class="xp-fact"><dt>${translator(locale)(msgctxt('xwhm', 'Active'))}</dt><dd>${props.accounts ? accounts.filter(account => account.status === 'active').length : (translator(locale)(msgctxt('xwhm', 'Unavailable')))}</dd></div>
            <div class="xp-fact"><dt>${translator(locale)(msgctxt('xwhm', 'Suspended'))}</dt><dd>${props.accounts ? accounts.filter(account => account.status === 'suspended').length : (translator(locale)(msgctxt('xwhm', 'Unavailable')))}</dd></div>
            <div class="xp-fact"><dt>${translator(locale)('Resellers')}</dt><dd>${props.resellers ? resellers.length : (translator(locale)(msgctxt('xwhm', 'Unavailable')))}</dd></div>
          </dl>
        </section>
        <section class="xp-board-section" aria-labelledby="whm-dash-audit">
          <header class="xp-board-section__head"><h2 id="whm-dash-audit">${translator(locale)('Recent audit entries')}</h2><a href="/whm/audit">${translator(locale)('Open the audit log')}</a></header>
          <div class="xp-table-wrap"><table class="xp-table"><thead><tr><th>${translator(locale)('Time')}</th><th>${translator(locale)('Actor')}</th><th>${translator(locale)('Action')}</th><th>${translator(locale)('Result')}</th></tr></thead><tbody>${auditEntries.length ? auditEntries.slice(0, 8).map(entry => `<tr><td><bdi dir="ltr">${escapeHtml(formatAsciiDate(entry.at, { includeTime: true }))}</bdi></td><td><bdi dir="ltr">${escapeHtml(auditActorLabel(entry.actor))}</bdi></td><td>${auditActionHtml(entry.action, locale, entry)}</td><td>${escapeHtml(auditOutcomeLabel(entry.action, entry.outcome, locale))}</td></tr>`).join('') : `<tr><td colspan="4">${translator(locale)('No audit entries yet')}</td></tr>`}</tbody></table></div>
        </section>
      </section>
` : ''}
      ${section === 'io' && ioSnapshot ? `      <!-- Real-Time Server IO & Per-Account cgroup v2 Slice Monitor -->
      <section class="xp-card" id="whm-io-monitor" data-section="server-io-monitor" aria-labelledby="whm-io-heading">
        <div class="xp-card__header" style="margin-block-end:var(--xp-space-group,24px)">
          <div>
            <h1 id="whm-io-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
          </div>
        </div>

        ${renderServerIoMonitorChart(ioSnapshot, locale)}
      </section>

` : ''}
      ${section === 'services' ? `      <!-- Service Health Table (nginx, apache/ols, php-fpm, mariadb, dovecot, postfix, pdns, nftables) -->
      <section class="xp-card" id="whm-services" data-section="service-health" aria-labelledby="whm-services-heading" style="display:flex;flex-direction:column;gap:var(--xp-space-group,24px)">
        <div class="xp-card__header" style="margin-block-end:0">
          <div>
            <h1 id="whm-services-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
            <p class="xp-prose">${translator(locale)('Service versions, memory use and running status.')}</p>
          </div>
          ${services.length > 0 ? renderStatusBadge('ok', `${services.filter((s) => s.active).length}/${services.length} Healthy`) : ''}
        </div>
        ${services.length > 0 ? `<div class="xp-table-wrap">
          <table class="xp-table">
            <thead>
              <tr>
                <th>${translator(locale)('Service')}</th>
                <th>${translator(locale)('systemd Unit')}</th>
                <th>${translator(locale)('Version')}</th>
                <th>${translator(locale)('Role')}</th>
                <th>${translator(locale)('Memory (RSS)')}</th>
                <th>${translator(locale)('Status')}</th>
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
                  <td>${renderStatusBadge(svc.active ? 'ok' : 'critical', svc.active ? translator(locale)('Active') : 'Stopped')}</td>
                </tr>
              `,
                )
                .join('')}
            </tbody>
          </table>
        </div>` : ''}
        <div class="xp-table-wrap" data-host-services="true">
          <table class="xp-table">
            <thead><tr><th>${translator(locale)('Service')}</th><th>${translator(locale)('Unit')}</th><th>${translator(locale)('Status')}</th><th>${translator(locale)(msgctxt('xwhm', 'Action'))}</th></tr></thead>
            <tbody data-host-service-rows="true"><tr><td colspan="4">${translator(locale)('Reading service status.')}</td></tr></tbody>
          </table>
          <p class="xp-help" data-host-service-status role="status"></p>
        </div>
      </section>

` : ''}
      ${section === 'dns' ? renderWhmDnsWorkspace({ locale, accounts, principal, title: pageTitle }) : ''}
      ${section === 'backups' ? `<section class="xp-card" data-account-backups="true" aria-labelledby="whm-backup-heading">
        <div class="xp-card__header"><h1 id="whm-backup-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1></div>
        <p class="xp-prose">${translator(locale)('The archive is stored in the local backup directory, limited to 2 GiB, and restored only into that account home.')}</p>
        <div class="xp-field"><label class="xp-label" for="backup-account">${translator(locale)('Account')}</label><select id="backup-account" class="xp-select" data-backup-account="true">${accounts.map(account => `<option value="${escapeHtml(account.username)}">${escapeHtml(account.username)}</option>`).join('')}</select></div>
        <div class="xp-table-wrap"><table class="xp-table"><thead><tr><th>${translator(locale)('File')}</th><th>${translator(locale)('Size')}</th><th></th></tr></thead><tbody data-backup-files="true"></tbody></table></div>
        <p class="xp-help" data-backup-status role="status"></p>
        <button type="button" class="xp-btn xp-btn--primary" data-backup-create="true">${translator(locale)('Create backup')}</button>
      </section>` : ''}
      ${section === 'server-info' ? `<section class="xp-card" data-host-info="true" aria-labelledby="whm-server-info-heading" style="display:flex;flex-direction:column;gap:var(--xp-space-group,24px)">
        <div class="xp-card__header" style="margin-block-end:0"><h1 id="whm-server-info-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1></div>
        <div class="xp-kpi-grid" data-host-info-grid="true">
          <div class="xp-field"><span class="xp-label">${translator(locale)('Load')}</span><strong data-host-load="true" class="${rtl ? 'xp-ar-sentence' : 'xp-mono'}"${rtl ? '' : ' dir="ltr"'}>${translator(locale)('Reading')}</strong></div>
          <div class="xp-field"><span class="xp-label">${translator(locale)('Memory')}</span><strong data-host-memory="true" class="${rtl ? 'xp-ar-sentence' : 'xp-mono'}"${rtl ? '' : ' dir="ltr"'}>${translator(locale)('Reading')}</strong></div>
          <div class="xp-field"><span class="xp-label">${translator(locale)('Disk')}</span><strong data-host-disk="true" class="${rtl ? 'xp-ar-sentence' : 'xp-mono'}"${rtl ? '' : ' dir="ltr"'}>${translator(locale)('Reading')}</strong></div>
        </div>
        <p class="xp-help" data-host-info-status role="status"></p>
      </section>` : ''}
      ${section === 'accounts' || section === 'create-account' ? `
      <section class="xp-card xp-accounts${section === 'create-account' ? ' xp-accounts--create' : ''}" id="whm-accounts" data-section="accounts-isolation" data-accounts-workspace aria-labelledby="whm-accounts-heading">
        <style>#whm-accounts.xp-accounts--create{display:flex;flex-direction:column;gap:var(--xp-space-group,24px)}#whm-accounts.xp-accounts--create>.xp-card__header{margin-block-end:0}</style>
        <div class="xp-card__header xp-accounts__header">
          <h1 id="whm-accounts-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
          ${section === 'accounts' && (list.state === 'ready' || list.state === 'empty') ? `<span class="xp-help xp-tabular">${translator(locale)('{count, plural, one {{count} account} other {{count} accounts}}', { count: list.accounts.length })}</span>` : ''}
          </div>
        ${section === 'accounts' ? `
        <div class="xp-form-group" style="gap:var(--xp-space-card)" data-account-list-layout>
        ${renderAccountListControls(list, locale)}
        ${renderApprovedWhmAccountBulkControls({ ...props, locale })}
        <div class="xp-table-wrap xp-accounts__table-wrap">
          <table class="xp-table xp-accounts__table">
          <thead>
          <tr>
          <th scope="col">${translator(locale)(msgctxt('xwhm', 'Select'))}</th>
          <th scope="col">${translator(locale)('Account')}</th>
          <th scope="col">${translator(locale)('Primary domain')}</th>
          <th scope="col">${translator(locale)('Plan')}</th>
          <th scope="col">${translator(locale)('Owner')}</th>
          <th scope="col">IP</th>
          <th scope="col">${translator(locale)('Disk')}</th>
          <th scope="col">${translator(locale)(msgctxt('xwhm', 'Bandwidth'))}</th>
          <th scope="col">${translator(locale)('Status')}</th>
          <th scope="col">${translator(locale)('Actions')}</th>
        </tr>
          </thead>
          <tbody>${list.accounts.map(acc => {
          const canSuspend = isRoot || heldAcls.has('suspend-account')
          const canTerminate = isRoot || heldAcls.has('terminate-account')
          // The handoff endpoint re-checks root or the owning reseller's edit-account ACL and an active account.
          const canLogIn = (isRoot || heldAcls.has('edit-account')) && acc.status === 'active'
          const statusLabel = acc.status === 'active' ? translator(locale)('Active') : acc.status === 'suspended' ? translator(locale)(msgctxt('common', 'Suspended')) : translator(locale)('Terminating')
          const attributes = `data-account-id="${escapeHtml(acc.id)}" data-username="${escapeHtml(acc.username)}" data-domain="${escapeHtml(acc.primaryDomain)}"`
          return `<tr data-account-row="${escapeHtml(acc.username)}" ${accountListRowAttributes(acc)}>
          <td>${renderApprovedWhmAccountSelection({ ...props, locale }, acc.username)}</td>
          <td>
          <div class="xp-accounts__identity">
          <strong>
          <bdi dir="ltr">${escapeHtml(acc.username)}</bdi>
          </strong>
          <details class="xp-accounts__details" data-account-details>
          <summary>${translator(locale)('Details')}</summary>
          <dl class="xp-accounts__technical">
            <div>
          <dt>UID</dt>
          <dd>
          <bdi dir="ltr">${acc.uid}</bdi>
          </dd>
          </div>
          <div>
          <dt>${translator(locale)('Resource unit')}</dt>
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
          <dt>${translator(locale)('Additional IPs')}</dt>
          <dd>
          <bdi dir="ltr">${escapeHtml(acc.extraIps.join(', '))}</bdi>
          </dd>
          </div>` : ''}          <div>
          <dt>${translator(locale)('Shell')}</dt>
          <dd>
          <bdi dir="ltr">${escapeHtml(acc.shell)}</bdi>
          </dd>
          </div>
          <div>
          <dt>${translator(locale)(msgctxt('xwhm', 'Contact'))}</dt>
          <dd><bdi dir="ltr">${escapeHtml(acc.contactEmail)}</bdi></dd>
          </div>
          <div>
          <dt>${translator(locale)('Disk quota')}</dt>
          <dd><bdi dir="ltr">${escapeHtml((() => { const disk = plans.find(plan => plan.id === acc.planId)?.resources.diskMb; return disk === undefined ? (translator(locale)(msgctxt('xwhm', 'Unavailable'))) : disk === 'unlimited' ? (translator(locale)('Unlimited')) : disk + ' MB' })())}</bdi></dd>
          </div>
          </dl>
          ${(isRoot || heldAcls.has('edit-account')) ? `<form class="xp-form-group" data-account-contact-form="true" data-account-id="${escapeHtml(acc.id)}">
            <div class="xp-field">
            <label class="xp-label" for="contact-${escapeHtml(acc.id)}">${translator(locale)('Contact email')}</label>
            <input id="contact-${escapeHtml(acc.id)}" name="contactEmail" type="email" class="xp-input" dir="ltr" required value="${escapeHtml(acc.contactEmail)}" />
            </div>
            <p class="xp-help" data-account-contact-status role="status" hidden></p>
            <button type="submit" class="xp-btn">${translator(locale)('Save email')}</button>
          </form>` : ''}
          ${(isRoot || heldAcls.has('change-password')) ? `<form class="xp-form-group" data-account-password-form="true" data-account-id="${escapeHtml(acc.id)}">
            <div class="xp-field">
            <label class="xp-label" for="password-${escapeHtml(acc.id)}">${translator(locale)(msgctxt('xwhm', 'New password'))}</label>
            <input id="password-${escapeHtml(acc.id)}" name="password" type="password" class="xp-input" minlength="8" required autocomplete="new-password" />
            </div>
            <p class="xp-help" data-account-password-status role="status" hidden></p>
            <button type="submit" class="xp-btn">${translator(locale)('Change password')}</button>
          </form>` : ''}
          ${renderApprovedWhmAccountActions({ ...props, locale }, acc.username)}
          </details>
          </div>
          </td>
          <td>
          <span class="xp-accounts__mobile-label" aria-hidden="true">${translator(locale)('Primary domain')}</span>
          <bdi dir="ltr" class="xp-accounts__domain">${escapeHtml(acc.primaryDomain)}</bdi>
          </td>
          <td>
          <span class="xp-accounts__mobile-label" aria-hidden="true">${translator(locale)('Plan')}</span>
          <span>${escapeHtml(plans.find(plan => plan.id === acc.planId)?.name ?? (translator(locale)(msgctxt('xwhm', 'Unavailable'))))}</span>
          </td>
          ${renderApprovedWhmAccountTableCells({ ...props, locale }, acc.username)}
          <td>
          <span class="xp-accounts__mobile-label" aria-hidden="true">${translator(locale)('Status')}</span>
          <span data-account-status>${renderStatusBadge(acc.status === 'active' ? 'ok' : acc.status === 'suspended' ? 'suspended' : 'critical', statusLabel)}</span>
          </td>
          <td>
          <div class="xp-accounts__actions">${canLogIn ? renderHandoffButton(locale, { audience: 'xpanel', accountId: acc.id, label: msgid('Log in to xPanel') }) : ''}${canSuspend && acc.status !== 'terminating' ? `<button type="button" class="xp-btn xp-btn--ghost" data-action="${acc.status === 'suspended' ? 'unsuspend-account' : 'suspend-account'}" ${attributes}>${acc.status === 'suspended' ? (translator(locale)('Unsuspend')) : (translator(locale)('Suspend'))}</button>` : ''}${canTerminate && acc.status !== 'terminating' ? `<button type="button" class="xp-btn xp-btn--ghost xp-accounts__delete" data-action="terminate-account" ${attributes}>${translator(locale)('Delete')}</button>` : ''}${!canSuspend && !canTerminate && !canLogIn ? `<span class="xp-help">${translator(locale)(msgctxt('xwhm', 'Read only'))}</span>` : ''}</div>
          </td>
          </tr>`
        }).join('') || `<tr>
          <td colspan="10">
          <p class="xp-accounts__empty">${list.state === 'forbidden' ? (translator(locale)('Account listing is not permitted.')) : list.state === 'unavailable' ? (translator(locale)('The account list is unavailable.')) : (translator(locale)('No accounts.'))}</p>
          </td>
          </tr>`}</tbody>
          </table>
          </div>
        </div>
        <dialog class="xp-account-dialog" data-account-dialog aria-labelledby="xp-account-dialog-title" aria-describedby="xp-account-dialog-description">
          <form method="dialog" data-account-action-form novalidate>
            <div class="xp-account-dialog__header">
          <h2 id="xp-account-dialog-title" data-account-dialog-title>${translator(locale)('Account action')}</h2>
          <p id="xp-account-dialog-description" data-account-dialog-description>
          </p>
          </div>
            <dl class="xp-account-dialog__identity">
          <div class="xp-accounts__field">
          <dt>${translator(locale)('Account')}</dt>
          <dd>
          <bdi dir="ltr" data-account-dialog-username>
          </bdi>
          </dd>
          </div>
          <div class="xp-accounts__field">
          <dt>${translator(locale)('Primary domain')}</dt>
          <dd>
          <bdi dir="ltr" data-account-dialog-domain>
          </bdi>
          </dd>
          </div>
          </dl>
            <div class="xp-accounts__field" data-account-confirm-field hidden>
          <label class="xp-label" for="terminate-confirm-user">${translator(locale)('Type the username to confirm')}</label>
          <input id="terminate-confirm-user" name="confirmUsername" type="text" class="xp-input xp-mono" dir="ltr" autocomplete="off" spellcheck="false" data-type-to-confirm="true" aria-describedby="xp-account-confirm-help" />
          <span class="xp-help" id="xp-account-confirm-help">${translator(locale)('Must exactly match the account above.')}</span>
          </div>
            <div class="xp-accounts__field" data-account-reason-field hidden>
          <label class="xp-label" for="account-suspend-reason">${translator(locale)('Suspension reason')}</label>
          <textarea id="account-suspend-reason" name="reason" class="xp-textarea" rows="2" maxlength="500"></textarea>
          </div>
            <p class="xp-account-dialog__status" data-account-action-status role="status" aria-live="polite" tabindex="-1" hidden>
          </p>
            <div class="xp-account-dialog__footer">
          <button type="button" class="xp-btn" data-account-action-cancel>${translator(locale)('Cancel')}</button>
          <button type="submit" class="xp-btn xp-btn--primary" data-account-action-submit disabled>${translator(locale)('Confirm')}</button>
          </div>
          </form>
        </dialog>` : ''}
        ${section === 'create-account' ? `<form class="xp-form-group" id="whm-create-account-drawer" action="/api/accounts" method="post" data-create-account-form="true">
          <div class="xp-accounts__field">
          <label class="xp-label" for="new-acc-username">${translator(locale)('Username')}</label>
          <input id="new-acc-username" name="username" type="text" class="xp-input xp-mono" dir="ltr" required pattern="[a-z][a-z0-9]{0,15}" placeholder="salma" />
          </div>
          <div class="xp-accounts__field">
          <label class="xp-label" for="new-acc-domain">${translator(locale)('Primary domain')}</label>
          <input id="new-acc-domain" name="primaryDomain" type="text" class="xp-input xp-mono" dir="ltr" required placeholder="salma.studio" />
          </div>
          <div class="xp-accounts__field">
          <label class="xp-label" for="new-acc-contact">${translator(locale)('Contact email')}</label>
          <input id="new-acc-contact" name="contactEmail" type="email" class="xp-input" dir="ltr" autocomplete="email" inputmode="email" spellcheck="false" />
          </div>
          <div class="xp-accounts__field">
          <label class="xp-label" for="new-acc-plan">${translator(locale)('Hosting plan')}</label>
          <select id="new-acc-plan" name="planId" class="xp-select" required>${plans.map(plan => `<option value="${escapeHtml(plan.id)}">${escapeHtml(formatDisplayName(plan.name))}</option>`).join('')}</select>
          </div>
          <div class="xp-accounts__field">
            <label class="xp-label" for="new-acc-password">${translator(locale)('Password')}</label>
            <input id="new-acc-password" name="password" type="password" class="xp-input" autocomplete="new-password" minlength="8" required aria-describedby="new-acc-password-help" />
            <span class="xp-help" id="new-acc-password-help">${translator(locale)('At least 8 characters.')}</span>
          </div>
          <div class="xp-accounts__field">
          <label class="xp-label" for="new-acc-ipv4">${translator(locale)('IPv4 assignment')}</label>
          <select id="new-acc-ipv4" name="ipAssignment" class="xp-select" required aria-describedby="new-acc-ipv4-address new-acc-ipv4-status">
            <option value="shared">${translator(locale)('Default shared')}</option>
            <option value="dedicated:auto" disabled>${translator(locale)('Dedicated · Automatic')}</option>
          </select>
          <div class="xp-help">
            <output class="xp-field-value xp-mono" data-account-ip-preview hidden><bdi id="new-acc-ipv4-address" dir="ltr" style="display:inline" data-account-ip-address></bdi></output>
            <span id="new-acc-ipv4-status" data-account-ip-status role="status" aria-live="polite">${translator(locale)('Loading IP availability…')}</span>
          </div>
          <button type="button" class="xp-btn xp-btn--ghost" style="justify-self:start" data-account-ip-refresh>${translator(locale)('Refresh IP availability')}</button>
          </div>
          <div class="xp-accounts__field">
          <label class="xp-label" for="new-acc-ipv6">${translator(locale)('IPv6 address (optional)')}</label>
          <input id="new-acc-ipv6" name="ipv6" type="text" class="xp-input xp-mono" dir="ltr" value="" />
          </div>
          ${renderApprovedWhmAccountCreateFields({ ...props, locale })}
          ${renderAccountPlanPreview(accountPlanPreviewModel({ principal, activeReseller: props.activeReseller, accounts: props.accounts, plans: props.plans, resellers: props.resellers }), locale)}
          <p class="xp-help" data-account-create-status role="status" aria-live="polite" tabindex="-1" hidden></p>
          <button type="submit" class="xp-btn xp-btn--primary" ${plans.length && (isRoot || heldAcls.has('create-account')) ? '' : 'disabled'}>${escapeHtml(translator(locale)('Create Account'))}</button>
        </form>${renderApprovedWhmAccountCreateStatus({ ...props, locale })}` : ''}
      </section>

` : ''}
      ${section === 'plans' ? `      <!-- Plans & Feature Lists + cgroup v2 Resource Limits Drawer -->
      <section class="xp-card" id="whm-plans" data-section="plans-feature-lists" aria-labelledby="whm-plans-heading" style="display:flex;flex-direction:column;gap:var(--xp-space-group,24px)">
        <div class="xp-card__header" style="margin-block-end:0">
          <div>
            <h1 id="whm-plans-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
            <p class="xp-prose">${translator(locale)('A plan sets each account’s resource limits. Choose Unlimited to remove a limit.')}</p>
          </div>
          ${renderStatusBadge('ok', `${plans.length} ${translator(locale)('plans')}`)}
        </div>
        <div class="xp-form-group" style="gap:var(--xp-space-card);min-inline-size:0" data-plan-list-group>
        ${isRoot || heldAcls.has('manage-plans') ? `<div class="xp-plan-editor-actions" data-plan-list-toolbar><a class="xp-btn" href="${escapeHtml(planHref())}">${translator(locale)('Create plan')}</a></div>` : ''}

        <div class="xp-table-wrap" data-plan-table-region role="region" tabindex="0" aria-labelledby="whm-plans-heading">
          <table class="xp-table">
            <thead>
              <tr>
                <th>${translator(locale)('Plan')}</th>
                <th>${translator(locale)('Disk / Bandwidth')}</th>
                <th>${translator(locale)('CPU / Memory')}</th>
                <th>${translator(locale)('Disk read / write')}</th>
                <th>${translator(locale)('Processes')}</th>
                <th>${translator(locale)('Addon Domains')}</th>
                <th>${translator(locale)('Jailed Shell')}</th>
                <th scope="col">${translator(locale)('Actions')}</th>
              </tr>
            </thead>
            <tbody>
              ${plans
                .map(
                  (plan) => `
                <tr data-plan-row="${escapeHtml(plan.name)}">
                  <td><strong data-plan-name>${escapeHtml(formatDisplayName(plan.name))}</strong></td>
                  <td class="xp-mono xp-tabular">${renderLtrValue(`${plan.resources.diskMb === 'unlimited' ? 'unlimited' : `${plan.resources.diskMb / 1024} GB`} / ${plan.resources.bandwidthMbMonth === 'unlimited' ? 'unlimited' : `${plan.resources.bandwidthMbMonth / 1024} GB`}`, 'xp-plan-resource-value')}</td>
                  <td class="xp-mono xp-tabular">${renderLtrValue(`${plan.resources.cpuPercent}% / ${plan.resources.memoryMb} MB`, 'xp-plan-resource-value')}</td>
                  <td class="xp-mono xp-tabular">${renderLtrValue(`${plan.resources.ioReadBps === 'unlimited' ? 'unlimited' : formatBytes(plan.resources.ioReadBps)}/s · ${plan.resources.ioWriteBps === 'unlimited' ? 'unlimited' : formatBytes(plan.resources.ioWriteBps)}/s`, 'xp-plan-resource-value')}</td>
                  <td class="xp-mono xp-tabular">${plan.resources.maxProcesses}</td>
                  <td class="xp-mono xp-tabular">${String(plan.caps.addonDomains)}</td>
                  <td>${renderStatusBadge(plan.shell === 'jailed' ? 'ok' : 'suspended', plan.shell === 'jailed' ? (translator(locale)('jailed')) : (translator(locale)('none')))}</td>
                  <td>${canManageVisiblePlan(plan) ? `<div class="xp-accounts__actions"><a class="xp-btn" href="${escapeHtml(planHref(plan.id))}">${translator(locale)('Edit')}</a><button type="button" class="xp-btn" data-plan-delete="${escapeHtml(plan.id)}">${translator(locale)('Delete')}</button></div>` : `<span class="xp-help">${translator(locale)(msgctxt('xwhm:2', 'Read only'))}</span>`}</td>
                </tr>
              `,
                )
                .join('')}
            </tbody>
          </table>
        </div>
        </div>

        <dialog class="xp-account-dialog" data-plan-delete-dialog aria-labelledby="plan-delete-title">
          <form method="dialog">
            <div class="xp-account-dialog__header">
              <h2 id="plan-delete-title">${translator(locale)('Delete plan')}</h2>
              <p>${translator(locale)('Deleting a plan cannot be undone.')}</p>
            </div>
            <p class="xp-account-dialog__status" data-dialog-status role="status" hidden></p>
            <div class="xp-account-dialog__footer">
              <button type="button" class="xp-btn" data-dialog-cancel>${translator(locale)('Cancel')}</button>
              <button type="submit" class="xp-btn xp-btn--primary">${translator(locale)('Delete')}</button>
            </div>
          </form>
        </dialog>
        <div class="xp-form-group" style="min-inline-size:0">
          ${planEditorUnavailable ? `<p class="xp-help" role="alert">${translator(locale)('The requested plan is unavailable.')}</p>` : renderPlanEditor({
            locale,
            ...(selectedPlan ? { plan: selectedPlan } : {}),
            featureLists: props.featureLists ?? [],
            ownerId: selectedPlan?.ownerId ?? (principal.kind === 'reseller' ? principal.id : null),
            canManage: (isRoot || heldAcls.has('manage-plans')) && (!selectedPlan || canManagePlan(principal, selectedPlan)),
            allowUnlimited: isRoot || heldAcls.has('allow-unlimited-plans'),
          })}
        </div>
      </section>

      <!-- Resellers Capacity Caps, Overselling Switch & 14-ACL Matrix -->
` : ''}
      ${section === 'resellers' ? `      <section class="xp-card" id="whm-resellers" data-section="resellers-acl" aria-labelledby="whm-resellers-heading">
        <div class="xp-card__header">
          <div>
            <h1 id="whm-resellers-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
            <p class="xp-prose">${translator(locale)('With overselling off, account creation is refused if total plan limits exceed the reseller’s disk or bandwidth cap.')}</p>
          </div>
          ${renderStatusBadge('ok', `${resellers.length} Resellers`)}
        </div>

        <div class="xp-table-wrap">
          <table class="xp-table">
            <thead>
              <tr>
                <th>${translator(locale)('Reseller')}</th>
                <th>${translator(locale)('Accounts Cap')}</th>
                <th>${translator(locale)('Disk Allocation')}</th>
                <th>${translator(locale)(msgctxt('xwhm', 'Overselling'))}</th>
                <th>${translator(locale)('Delegated IPs')}</th>
                <th>${translator(locale)('Nameservers')}</th>
                <th>${translator(locale)(msgctxt('xwhm', 'Action'))}</th>
              </tr>
            </thead>
            <tbody>
              ${resellers
                .map(
                  (res) => `
                <tr data-reseller-row="${escapeHtml(res.username)}">
                  <td><strong class="xp-mono"><bdi dir="ltr">${escapeHtml(res.username)}</bdi></strong></td>
                  <td>${renderThresholdMeter(undefined, res.maxAccounts, { locale, unit: translator(locale)('accounts'), label: translator(locale)('Reseller accounts'), configuredLimit: true })}</td>
                  <td>${renderThresholdMeter(undefined, res.totalDiskMb === 'unlimited' ? res.totalDiskMb : Number.isSafeInteger(res.totalDiskMb) ? res.totalDiskMb / 1024 : undefined, { locale, unit: 'GiB', label: translator(locale)(msgctxt('xwhm', 'Disk allocation')), configuredLimit: true })}</td>
                  <td>${renderStatusBadge(res.oversell ? 'warn' : 'ok', res.oversell ? (translator(locale)('Oversell on')) : (translator(locale)('Oversell off')))}</td>
                  <td class="xp-mono"><bdi dir="ltr">${escapeHtml(res.delegatedIps.join(', '))}</bdi></td>
                  <td class="xp-mono"><bdi dir="ltr">${escapeHtml(res.nameservers.join(', '))}</bdi></td>
                  <td><a class="xp-btn" href="#${resellerDetailAnchor(res.id)}" data-reseller-open="${resellerDetailAnchor(res.id)}" aria-label="${escapeHtml(translator(locale)('Open {name}', { name: res.username }))}">${translator(locale)(msgctxt('xwhm', 'Open'))}</a><span data-reseller-viewing="${resellerDetailAnchor(res.id)}">${renderStatusBadge('ok', translator(locale)('Open below'))}</span></td>
                </tr>
              `,
                )
                .join('')}
            </tbody>
          </table>
        </div>

        <div style="margin-block-start: var(--xp-space-field);" data-reseller-acl-matrix="true">
          <div class="xp-label" style="margin-block-end: 8px;">${translator(locale)('Reseller permissions')}</div>
          <div style="display: flex; flex-wrap: wrap; gap: 8px;">
            ${ALL_RESELLER_ACLS.map((acl) =>
              renderStatusBadge(
                heldAcls.has(acl) ? 'ok' : 'suspended',
                `${acl}: ${heldAcls.has(acl) ? 'granted' : 'revoked'}`,
              ),
            ).join('')}
          </div>
        </div>
        ${isRoot ? `<form class="xp-card xp-form-group" data-reseller-create-form="true">
          <div class="xp-card__header"><h2>${translator(locale)('New reseller')}</h2></div>
          <div class="xp-kpi-grid">
            <div class="xp-field"><label class="xp-label" for="reseller-username">${translator(locale)('Username')}</label><input id="reseller-username" name="username" class="xp-input xp-mono" dir="ltr" required maxlength="16" autocomplete="off" /></div>
            <div class="xp-field"><label class="xp-label" for="reseller-password">${translator(locale)('Password')}</label><input id="reseller-password" name="password" type="password" class="xp-input" required autocomplete="new-password" /></div>
            <div class="xp-field"><label class="xp-label" for="reseller-accounts">${translator(locale)('Account limit')}</label><input id="reseller-accounts" name="maxAccounts" type="number" class="xp-input xp-mono" min="0" value="10" required /></div>
            <div class="xp-field"><label class="xp-label" for="reseller-disk">${translator(locale)('Disk limit (MiB)')}</label><input id="reseller-disk" name="totalDiskMb" type="number" class="xp-input xp-mono" min="1" value="10240" required /></div>
            <div class="xp-field"><label class="xp-label" for="reseller-bandwidth">${translator(locale)('Bandwidth limit (MiB)')}</label><input id="reseller-bandwidth" name="totalBandwidthMb" type="number" class="xp-input xp-mono" min="1" value="102400" required /></div>
          </div>
          <div style="display:grid;gap:var(--xp-space-field,16px);min-inline-size:0">
          <label class="xp-plan-cap-option"><input type="checkbox" name="oversell" /><span>${translator(locale)('Allow overselling')}</span></label>
          <fieldset class="xp-field" data-reseller-acl-choices="true"><legend class="xp-label">${translator(locale)('Permissions')}</legend>
            <div style="display: flex; flex-wrap: wrap; gap: 8px;">
              ${ALL_RESELLER_ACLS.map(acl => `<label class="xp-plan-cap-option"><input type="checkbox" name="acl" value="${escapeHtml(acl)}" /><span class="xp-mono" dir="ltr">${escapeHtml(acl)}</span></label>`).join('')}
            </div>
          </fieldset>
          </div>
          <p class="xp-help" data-reseller-status role="status" hidden></p>
          <button type="submit" class="xp-btn xp-btn--primary">${translator(locale)(msgctxt('xwhm', 'Create reseller'))}</button>
        </form>` : ''}
      </section>

      <!-- Multi-IPv4 / Multi-IPv6 Pool & Postfix Mail Outbound IP Configuration -->
` : ''}
      ${section === 'ips' || (section === 'mail-ips' && mailIpConfig) ? `      <section class="xp-card" id="whm-ip-pool" data-section="multi-ip-mail-pool"${section === 'ips' ? ` data-whm-ip-pool data-ip-editable="${isRoot ? 'true' : 'false'}"` : ''} aria-labelledby="whm-ip-pool-heading" style="display:flex;flex-direction:column;gap:var(--xp-space-group,24px)">
        <div class="xp-card__header" style="margin-block-end:0">
          <div>
            <h1 id="whm-ip-pool-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
            <p class="xp-prose">${translator(locale)('Manage IP addresses, account and reseller assignments, and outbound mail routing.')}</p>
          </div>
          ${section === 'ips' ? `<span data-ip-pool-count style="display:contents">${renderStatusBadge('ok', translator(locale)('{count, plural, one {{count} address} other {{count} addresses}}', { count: ipPool.length }))}</span>` : renderStatusBadge('ok', mailIpConfig!.mode)}
        </div>

${section === 'ips' ? `        <!-- Server IP Pool Table -->
        <div class="xp-table-wrap">
          <table class="xp-table" data-ip-pool-table="true">
            <thead>
              <tr>
                <th>${escapeHtml(translator(locale)('IP Address / Prefix'))}</th>
                <th>IPv4 / IPv6</th>
                <th>${escapeHtml(translator(locale)(msgctxt('ip', 'Interface')))}</th>
                <th>${escapeHtml(translator(locale)('Role (shared / dedicated / mail)'))}</th>
                <th>${escapeHtml(translator(locale)('Delegated Owner'))}</th>
                <th>${escapeHtml(translator(locale)('Reverse DNS (PTR / HELO)'))}</th>
                <th>${escapeHtml(translator(locale)('Primary'))}</th>
                <th>${escapeHtml(translator(locale)('Actions'))}</th>
              </tr>
            </thead>
            <tbody>
              ${ipPool
                .map(
                  (ip) => `
                <tr data-ip-row="${escapeHtml(ip.address)}" data-ip-id="${escapeHtml(ip.id)}">
                  <td><code class="xp-mono xp-tabular"><bdi dir="ltr">${escapeHtml(ip.address)}/${ip.prefixLength}</bdi></code></td>
                  <td class="xp-mono">IPv${ip.version}</td>
                  <td><code class="xp-mono"><bdi dir="ltr">${escapeHtml(ip.interfaceName)}</bdi></code></td>
                  <td>${renderStatusBadge(ip.role === 'mail' ? 'warn' : 'ok', ip.role)}</td>
                  <td class="xp-mono"><bdi dir="ltr">${escapeHtml(ip.ownerKind)}${ip.ownerId ? ` (${(() => { const named = ip.ownerKind === 'account' ? accounts.find(account => account.id === ip.ownerId)?.username : resellers.find(reseller => reseller.id === ip.ownerId)?.username; return named ? escapeHtml(named) : translator(locale)(msgctxt('xwhm', 'Owner unavailable')) })()})` : ''}</bdi></td>
                  <td class="xp-mono"><bdi dir="ltr">${escapeHtml(ip.ptrHostname ?? '—')}</bdi></td>
                  <td>${renderStatusBadge(ip.isPrimary ? 'ok' : 'suspended', ip.isPrimary ? translator(locale)('Primary') : translator(locale)('Secondary'))}</td>
                  <td>${ip.isPrimary ? '' : `<button type="button" class="xp-btn xp-btn--danger" data-ip-remove="${escapeHtml(ip.id)}" data-ip-address="${escapeHtml(ip.address)}" aria-label="${escapeHtml(translator(locale)('Remove {name}', { name: ip.address }))}" disabled>${escapeHtml(translator(locale)('Remove'))}</button>`}</td>
                </tr>
              `,
                )
                .join('') || `<tr><td colspan="8">${escapeHtml(translator(locale)('No IP addresses are in the pool.'))}</td></tr>`}
            </tbody>
          </table>
        </div>
        <p class="xp-help" data-ip-pool-status role="status" hidden></p>

` : ''}        <!-- Add IPv4/IPv6 + Postfix Outbound Mail IP Configuration -->
        <div class="xp-golden-grid">
          <!-- Mail Outbound IP Configuration (MailIpConfig) -->
${section === 'mail-ips' && mailIpConfig ? `          <form class="xp-card xp-form-group" action="/api/mail/ips" method="post" data-mail-ip-config-form="true" data-mail-ip-editable="${isRoot ? 'true' : 'false'}">
            <div class="xp-card__header" style="margin-block-end:var(--xp-space-label,8px)">
              <h3>${escapeHtml(translator(locale)('Postfix Outbound Mail IP & HELO Transport Map'))}</h3>
            </div>

            <div class="xp-field">
              <label class="xp-label" for="mail-outbound-mode">${translator(locale)('Outbound mail routing')}</label>
              <select id="mail-outbound-mode" name="mode" class="xp-select">
                <option value="server-default" ${mailIpConfig.mode === 'server-default' ? 'selected' : ''}>server-default (${escapeHtml(translator(locale)('Server Default IP'))})</option>
                <option value="account-ip" ${mailIpConfig.mode === 'account-ip' ? 'selected' : ''}>account-ip (${escapeHtml(translator(locale)('Per-Account Dedicated IP'))})</option>
                <option value="domain-ip" ${mailIpConfig.mode === 'domain-ip' ? 'selected' : ''}>domain-ip (${escapeHtml(translator(locale)('Per-Domain Dedicated IP'))})</option>
                <option value="custom-map" ${mailIpConfig.mode === 'custom-map' ? 'selected' : ''}>custom-map (${escapeHtml(translator(locale)('Explicit Per-Domain Custom Map'))})</option>
              </select>
            </div>

            <div class="xp-kpi-grid" style="margin-block:calc(var(--xp-space-group,24px) - var(--xp-space-field,16px))">
              <div class="xp-field">
                <label class="xp-label" for="mail-default-ipv4">${translator(locale)('Default outbound IPv4')}</label>
                <input id="mail-default-ipv4" name="defaultIpv4" type="text" class="xp-input xp-mono" dir="ltr" value="${escapeHtml(mailIpConfig.defaultIpv4 ?? '')}" />
              </div>
              <div class="xp-field">
                <label class="xp-label" for="mail-default-ipv6">${translator(locale)('Default outbound IPv6')}</label>
                <input id="mail-default-ipv6" name="defaultIpv6" type="text" class="xp-input xp-mono" dir="ltr" value="${escapeHtml(mailIpConfig.defaultIpv6 ?? '')}" />
              </div>
              <div class="xp-field">
                <label class="xp-label" for="mail-default-helo">${escapeHtml(translator(locale)('Default EHLO / HELO Hostname'))}</label>
                <input id="mail-default-helo" name="defaultHelo" type="text" class="xp-input xp-mono" dir="ltr" value="${escapeHtml(mailIpConfig.defaultHelo ?? '')}" />
              </div>
            </div>

            <div class="xp-field">
              <div class="xp-label" id="mail-ip-overrides-label">${escapeHtml(translator(locale)('Per-Domain Outbound IPv4/IPv6 & HELO Overrides'))}</div>
              <pre class="xp-field-value xp-mono" dir="ltr" role="region" aria-labelledby="mail-ip-overrides-label" style="margin:0;white-space:pre-wrap"><bdi dir="ltr" data-mail-ip-overrides>${escapeHtml(mailIpConfig.domainOverrides.map(override => [override.domainName, override.ipv4, override.ipv6, override.heloHostname].filter(Boolean).join(' · ')).join('\n') || (translator(locale)('No domain overrides are configured.')))}</bdi></pre>
            </div>

            <p class="xp-help" data-mail-ip-status role="status" aria-live="polite" tabindex="-1" style="margin-block-start:calc(var(--xp-space-group,24px) - var(--xp-space-field,16px))" hidden></p>
            <noscript><p class="xp-help">${translator(locale)('Saving mail settings requires JavaScript.')}</p></noscript>
            <button type="submit" class="xp-btn xp-btn--primary" style="margin-block-start:calc(var(--xp-space-group,24px) - var(--xp-space-field,16px))" disabled>${escapeHtml(translator(locale)(msgctxt('common', 'Review changes')))}</button>
          </form>

` : ''}
          ${section === 'ips' ? `<!-- Add / Assign Server IP Form -->
          <form class="xp-card xp-form-group" action="/api/ips" method="post" data-add-ip-form="true">
            <div class="xp-card__header" style="margin-block-end:var(--xp-space-label,8px)">
              <h3>${escapeHtml(translator(locale)('Add IPv4 / IPv6 Address'))}</h3>
              ${renderStatusBadge('ok', 'IPv4 + IPv6 Dual-Stack')}
            </div>
            <div class="xp-field">
              <label class="xp-label" for="add-ip-address">${escapeHtml(translator(locale)('IP Address / Prefix'))}</label>
              <input id="add-ip-address" name="address" type="text" class="xp-input xp-mono" dir="ltr" placeholder="IPv4 / IPv6" />
            </div>
            <div class="xp-field">
              <label class="xp-label" for="add-ip-prefix">${translator(locale)('Subnet prefix length (CIDR)')}</label>
              <input id="add-ip-prefix" name="prefixLength" type="number" class="xp-input xp-mono" required min="0" max="128" />
            </div>
            <div class="xp-field">
              <label class="xp-label" for="add-ip-role">${escapeHtml(translator(locale)('Role (shared / dedicated / mail)'))}</label>
              <select id="add-ip-role" name="role" class="xp-select">
                <option value="shared">shared</option>
                <option value="dedicated">dedicated</option>
                <option value="mail">mail</option>
              </select>
            </div>
            <div class="xp-field">
              <label class="xp-label" for="add-ip-owner">${escapeHtml(translator(locale)('Delegated Owner'))}</label>
              <select id="add-ip-owner" name="ownerKind" class="xp-select">
                <option value="root">root (server-wide)</option>
                <option value="reseller">reseller (delegated pool)</option>
                <option value="account">account (dedicated vhost/mail IP)</option>
              </select>
            </div>
            <div class="xp-field">
              <label class="xp-label" for="add-ip-ptr">${escapeHtml(translator(locale)('Reverse DNS (PTR / HELO)'))}</label>
              <input id="add-ip-ptr" name="ptrHostname" type="text" class="xp-input xp-mono" dir="ltr" placeholder="mail.example.com" />
            </div>
            <p class="xp-help" data-add-ip-status role="status" hidden></p>
            <noscript><p class="xp-help">${escapeHtml(translator(locale)('Adding an address requires JavaScript.'))}</p></noscript>
            <button type="submit" class="xp-btn xp-btn--primary" style="margin-block-start:calc(var(--xp-space-group,24px) - var(--xp-space-field,16px))" disabled>${escapeHtml(translator(locale)('Add IPv4 / IPv6 Address'))}</button>
          </form>` : ''}
        </div>
      </section>

      <!-- Firewall (nftables) + Self-Lockout Protection + 60s Dead-Man's Switch -->
` : ''}
      ${section === 'firewall' ? `      <section class="xp-card" id="whm-firewall" data-section="nftables-firewall" aria-labelledby="whm-firewall-heading" style="display:flex;flex-direction:column;gap:var(--xp-space-group,24px)">
        <div class="xp-card__header" style="margin:0">
          <div>
            <h1 id="whm-firewall-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
            <p class="xp-prose">${escapeHtml(translator(locale)('Dead-Man’s Switch Active: any rule change that drops your active session IP or panel/SSH port is automatically refused or rolled back.'))}</p>
          </div>
          ${renderStatusBadge('ok', `Session IP ${adminSessionIp} Protected`)}
        </div>

        <!-- 60-Second Dead-Man's Switch Banner -->
        <div class="xp-reconcile-banner" role="region" aria-label="Firewall dead-man switch" data-firewall-deadman="60s">
          <div style="display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px;">
            <div>
              <strong>${translator(locale)('Automatic rollback after 60 seconds')}</strong>
              <p style="margin: 4px 0 0; font-size: 0.85rem; color: var(--xp-text-secondary);">
                ${translator(locale)('Changes that block your current session ({adminSessionIp}), management ports or SSH are refused. Confirm connectivity within 60 seconds or the previous rules are restored.', { adminSessionIp })}
              </p>
            </div>
            ${renderStatusBadge('warn', '60s Rollback Timer Guard')}
          </div>
        </div>

        <div class="xp-table-wrap">
          <table class="xp-table">
            <thead>
              <tr>
                <th>${translator(locale)('Kind')}</th>
                <th>${translator(locale)('Action')}</th>
                <th>${translator(locale)('Protocol / Port')}</th>
                <th>${translator(locale)('Source CIDR')}</th>
                <th>${translator(locale)(msgctxt('xwhm', 'Comment'))}</th>
                <th>${translator(locale)('State')}</th>
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
      ${section === 'generations' ? `        <section class="xp-card" data-section="config-generations" data-whm-generations data-generations-editable="${isRoot ? 'true' : 'false'}" aria-labelledby="whm-generations-heading" style="display:flex;flex-direction:column;gap:var(--xp-space-group,24px)">
          <style>[data-section="config-generations"] .xp-table th{white-space:nowrap;overflow-wrap:normal;word-break:normal}[data-section="config-generations"] .xp-table td{overflow-wrap:normal;word-break:normal}</style>
          <div class="xp-card__header" style="margin-block-end:0">
            <div>
              <h1 id="whm-generations-heading" class="xp-page-title">${escapeHtml(pageTitle)}</h1>
              <p class="xp-prose">${translator(locale)('Configuration is checked before applying. Previous generations are kept for rollback.')}</p>
            </div>
            ${generationId !== undefined ? `<span data-generations-current style="display:contents">${renderStatusBadge('ok', translator(locale)('Generation {generationId}', { generationId }))}</span>` : ''}
          </div>

          <div class="xp-table-wrap">
            <table class="xp-table">
              <thead>
                <tr>
                  <th>${translator(locale)('Generation')}</th>
                  <th>${translator(locale)(msgctxt('xwhm', 'Summary'))}</th>
                  <th>${translator(locale)('Checksum & Files')}</th>
                  <th>${translator(locale)('Status')}</th>
                  <th>${translator(locale)('Rollback')}</th>
                </tr>
              </thead>
              <tbody data-generation-rows>
                ${generations
                  .map(
                    (gen) => `
                  <tr data-generation-row="${gen.generationId}">
                    <td class="xp-mono xp-tabular"><strong>#${gen.generationId}</strong></td>
                    <td>${escapeHtml(gen.summary)}</td>
                    <td><bdi dir="ltr" class="xp-mono xp-tabular">sha256:${escapeHtml(gen.stateChecksum)}</bdi> · ${escapeHtml(translator(locale)('{count, plural, one {{count} file} other {{count} files}}', { count: gen.filesCount }))} · <bdi dir="ltr" class="xp-mono xp-tabular">${gen.durationMs} ms</bdi></td>
                    <td>${renderStatusBadge(gen.status === 'active' ? 'ok' : 'suspended', gen.status)}</td>
                    <td>
                      <button type="button" class="xp-btn" data-action="rollback-generation" data-generation-id="${gen.generationId}" disabled>
                        ${translator(locale)('Rollback to #{generationId}', { generationId: gen.generationId })}
                      </button>
                    </td>
                  </tr>
                `,
                  )
                  .join('') || `<tr><td colspan="5">${escapeHtml(translator(locale)('Generation history has not been read.'))}</td></tr>`}
              </tbody>
            </table>
          </div>
          <p class="xp-help" data-generations-status role="status">${escapeHtml(translator(locale)('Rollback stays disabled until the server confirms that a generation can be restored.'))}</p>
          <div class="xp-field">
            <div><button type="button" class="xp-btn" data-action="rebuild-index" aria-describedby="whm-rebuild-index-help" disabled>${translator(locale)('Rebuild index')}</button></div>
            <p class="xp-help" id="whm-rebuild-index-help">${escapeHtml(translator(locale)('The panel cannot rebuild the index. An administrator can run the reindex command on the server; nothing runs from this page.'))}</p>
          </div></section>` : ''}
${section === 'audit' ? `<section class="xp-card" data-section="audit-log">
            <div class="xp-card__header">
              <h1 class="xp-page-title">${escapeHtml(pageTitle)}</h1>
              ${renderWhmAuditExports({ ...props, locale })}
            </div>
            <form method="get" action="/whm/audit" data-audit-filters="true" class="xp-form-group">
              <input type="hidden" name="lang" value="${locale}">
              <input type="hidden" name="theme" value="${theme}">
              <input type="hidden" name="density" value="${density}">
              <div class="xp-field">
                <label class="xp-label" for="audit-actor">${translator(locale)('Actor')}</label>
                <input id="audit-actor" class="xp-input" name="actor" maxlength="128" value="${escapeHtml(auditActor)}">
              </div>
              <div class="xp-field">
                <label class="xp-label" for="audit-action">${translator(locale)('Action')}</label>
                <input id="audit-action" class="xp-input" name="action" maxlength="128" value="${escapeHtml(auditAction)}">
              </div>
              <div class="xp-field">
                <label class="xp-label" for="audit-target">${translator(locale)('Target')}</label>
                <input id="audit-target" class="xp-input" name="target" maxlength="480" value="${escapeHtml(auditTarget)}">
              </div>
              <div class="xp-whm-detail-fields">
                <div class="xp-field"><label class="xp-label" for="audit-outcome">${translator(locale)('Outcome')}</label><select id="audit-outcome" name="outcome" class="xp-select${rtl ? ' xp-ar-sentence' : ''}"><option value=""${rtl ? ' class="xp-ar-sentence"' : ''}>${translator(locale)('All outcomes')}</option>${[['ok', translator(locale)('Success')], ['denied', translator(locale)('Denied')], ['failed', translator(locale)('Failed')]].map(([key, label]) => `<option value="${key}"${rtl ? ' class="xp-ar-sentence"' : ''}${auditOutcome === key ? ' selected' : ''}>${label}</option>`).join('')}</select></div>
                <div class="xp-field"><label class="xp-label" for="audit-from">${translator(locale)('From (UTC)')}</label><input id="audit-from" class="xp-input" dir="ltr" style="text-align:${rtl ? 'right' : 'left'}" name="from" type="datetime-local" step="0.001" value="${escapeHtml(auditFrom.replace(/Z$/, ''))}"></div>
                <div class="xp-field"><label class="xp-label" for="audit-to">${translator(locale)('To (UTC)')}</label><input id="audit-to" class="xp-input" dir="ltr" style="text-align:${rtl ? 'right' : 'left'}" name="to" type="datetime-local" step="0.001" value="${escapeHtml(auditTo.replace(/Z$/, ''))}"></div>
              </div>
              <div class="xp-plan-editor-actions"><a class="xp-btn" data-audit-clear href="/whm/audit?lang=${locale}&amp;theme=${theme}&amp;density=${density}">${translator(locale)(msgctxt('xwhm', 'Clear filters'))}</a><button type="submit" class="xp-btn xp-btn--primary">${translator(locale)('Apply filters')}</button></div>
            </form>
            <div class="xp-table-wrap">
              <table class="xp-table">
                <thead>
                  <tr>
                    ${auditHeaders.map(label => `<th scope="col">${escapeHtml(label)}</th>`).join('')}
                  </tr>
                </thead>
                <tbody>
                  ${auditEntries.length ? auditEntries
                    .map(
                      (entry) => `
                    <tr data-audit-id="${escapeHtml(entry.id)}">
                      <td class="xp-tabular">${auditMobileLabel(auditHeaders[0])}<div class="xp-audit-value"><time datetime="${escapeHtml(entry.at)}"><bdi dir="ltr" class="xp-mono">${escapeHtml(formatDisplayDateTime(entry.at))}</bdi></time></div></td>
                      <td>${auditMobileLabel(auditHeaders[1])}<div class="xp-audit-value"><bdi dir="ltr" class="xp-mono">${escapeHtml(auditActorLabel(entry.actor))}</bdi></div></td>
                      <td>${auditMobileLabel(auditHeaders[2])}<div class="xp-audit-value">${auditActionHtml(entry.action, locale, entry)}</div></td>
                      <td>${auditMobileLabel(auditHeaders[3])}<div class="xp-audit-value"><bdi dir="ltr">${escapeHtml(auditTargetLabel(entry.target, locale))}</bdi></div></td>
                      <td>${auditMobileLabel(auditHeaders[4])}<div class="xp-audit-value">${renderStatusBadge(entry.outcome === 'ok' ? 'ok' : entry.outcome === 'denied' ? 'warn' : 'critical', auditOutcomeLabel(entry.action, entry.outcome, locale))}</div></td>
                    </tr>
                  `,
                    )
                    .join('') : `<tr><td colspan="5">${translator(locale)('No audit entries yet')}</td></tr>`}
                </tbody>
              </table>
            </div>
            ${renderWhmAuditSupplement({ ...props, locale })}
            ${auditBefore || (auditList?.hasMore && auditList.oldestId) ? `<nav data-audit-pager="true">
              ${auditBefore ? `<a href="${escapeHtml(auditHref())}">${translator(locale)('Newest')}</a>` : ''}
              ${auditList?.hasMore && auditList.oldestId ? `<a data-audit-older="true" href="${escapeHtml(auditHref(auditList.oldestId))}">${translator(locale)('Older')}</a>` : ''}
            </nav>` : ''}
          </section>` : ''}
${section === 'upgrade' ? `<section class="xp-card" data-section="root-lifecycle"><h1 class="xp-page-title">${escapeHtml(pageTitle)}</h1><p class="xp-prose"><bdi dir="ltr">${escapeHtml(version)} → ${escapeHtml(availableVersion)}</bdi></p><p class="xp-prose">${translator(locale)('Review the upgrade preflight before confirming any change.')}</p><button type="button" class="xp-btn xp-btn--primary" data-action="start-upgrade" ${isRoot && props.availableVersion ? '' : 'disabled'}>${translator(locale)('Check upgrade')}</button></section>` : ''}
${section === 'transfer' ? `<section class="xp-card" data-section="root-lifecycle"><h1 class="xp-page-title">${escapeHtml(pageTitle)}</h1><p class="xp-prose">${translator(locale)('Choose the transfer source and review its accounts before importing.')}</p><button type="button" class="xp-btn xp-btn--primary" data-action="start-transfer" ${isRoot ? '' : 'disabled'}>${translator(locale)('Start transfer')}</button></section>` : ''}
${section === 'security' ? `<section class="xp-card" data-section="account-security" style="display:flex;flex-direction:column;gap:var(--xp-space-group,24px)"><h1 class="xp-page-title" style="margin:0">${escapeHtml(pageTitle)}</h1></section>` : ''}
${section === 'design' ? renderDesignMain(activeRoute, locale) : ''}
${section === undefined || (section === 'io' && !ioSnapshot) || (section === 'mail-ips' && !mailIpConfig) ? renderSurfaceUnavailable(locale, '/whm') : ''}`
  const rawHtml = renderSurfaceShell({
    surface: 'xwhm', locale,
    attributes: `data-principal-kind="${escapeHtml(principal.kind)}"`,
    sidebar: `    <div class="xp-sidebar__brand">
      <span class="xp-brand__mark" aria-hidden="true">x</span>
      <div>
        <strong>xWHM</strong>
        <div>${isArabicSentence(hostname) ? `<span class="xp-ar-sentence">${escapeHtml(hostname)}</span>` : `<bdi dir="ltr" class="xp-mono">${escapeHtml(hostname)}</bdi>`}</div>
      </div>
    </div>

    ${renderDesignNav('xwhm', locale, activeRoute, qualifiedRoutes, navigationVisibility)}`,
    topbar: renderSurfaceToolbar({ surface: 'xwhm', locale, theme, density, path: section === 'audit' ? auditHref(auditBefore || undefined) : activeRoute, username: principal.username, role: roleLabel(principal.kind, locale), signedIn: true, realtimeEnabled: props.realtimeEnabled, generationId, version: props.version, activityHref: '/whm/jobs' }),
    content: section === 'backups' ? renderApprovedWhmBackups({ ...props, locale }, nativeContent) : section === 'resellers' ? renderApprovedWhmResellers({ ...props, locale }, nativeContent) : section === 'dns' ? `<div class="xp-form-group" data-whm-dns-workspace style="gap:var(--xp-space-section,32px)">${nativeContent}${renderWhmDnsSupplement({ ...props, locale })}</div>` : section === 'plans' ? nativeContent + renderApprovedWhmPlanSupplement({ ...props, locale }) : section === 'services' || section === 'firewall' ? nativeContent + renderApprovedWhmOperationsSupplement({ ...props, locale }) : section === 'mail-ips' ? nativeContent + renderWhmMailOutboundSupplement({ ...props, locale }) : nativeContent,
  })
  return ensureAccessibleSurfaceHtml(rawHtml.trim(), locale)
}
