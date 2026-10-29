import { WHM_DNS_CLIENT_BINDING } from './whm-dns-client.ts'
// Real-time RFC 6455 WebSocket state store, 5-stage reconcile pipeline banner renderer,
// and embedded browser script for live updates and keyboard navigation shortcuts.

import type {
  AuditEntry,
  IoAnalyticsSnapshot,
  LiveEvent,
  ReconcileStage,
  WebsiteAnalyticsSnapshot,
} from '@xpanel/core'
import { localeDirection, translator, type Locale } from './i18n.ts'
import { escapeHtml, renderLtrValue, renderStatusBadge } from './tokens.ts'
import { SHELL_MOTION_CLIENT_SCRIPT } from './shell-motion.ts'
import { PLAN_EDITOR_CLIENT_SCRIPT } from './plan-editor.ts'
import { ACCOUNT_LIST_CLIENT_SCRIPT } from './account-list.ts'
import { APPROVED_WORKSPACE_FORMS_CLIENT } from './approved-workspace-forms.ts'
import { ACCOUNT_FORWARDERS_CLIENT_BINDING } from './account-forwarders-client.ts'
import { ACCOUNT_FILTERS_CLIENT_BINDING } from './account-filters-client.ts'
import { ACCOUNT_MAILING_LISTS_CLIENT_BINDING } from './account-mailing-lists-client.ts'
import { ACCOUNT_SPAM_CLIENT_BINDING } from './account-spam-client.ts'
import { ACCOUNT_SESSIONS_CLIENT_BINDING } from './account-sessions-client.ts'
import { ACCOUNT_SSL_CLIENT_BINDING } from './account-ssl-client.ts'
import { ACCOUNT_CONTACT_CLIENT_BINDING } from './account-contact-client.ts'
import { DOMAIN_WORKSPACE_CLIENT_BINDING } from './domain-workspace-client.ts'
import { DATABASE_WORKSPACE_CLIENT_BINDING } from './database-workspace-client.ts'
import { MAIL_FOLDER_WORKSPACE_CLIENT_BINDING } from './mail-folder-workspace-client.ts'
import { MAIL_CONTACTS_WORKSPACE_CLIENT_BINDING } from './mail-contacts-workspace-client.ts'
import { MAIL_CONTACTS_TOOLS_CLIENT_BINDING } from './mail-contacts-tools-client.ts'
import { MAIL_IDENTITIES_CLIENT_BINDING } from './mail-identities-client.ts'
import { MAIL_VACATION_WORKSPACE_CLIENT_BINDING } from './mail-vacation-workspace-client.ts'
import { FILE_WORKSPACE_CLIENT_BINDING } from './file-workspace-client.ts'
import { MAIL_SEND_CLIENT_BINDING } from './mail-send-client.ts'
import { ACCOUNT_BACKUP_CLIENT_BINDING } from './account-backup-client.ts'
import { ACCOUNT_CRON_CLIENT_BINDING } from './account-cron-client.ts'
import { ACCOUNT_HTACCESS_CLIENT_BINDING } from './account-htaccess-client.ts'
import { ACCOUNT_QUARANTINE_CLIENT_BINDING } from './account-quarantine-client.ts'
import { MAIL_CONTACT_GROUPS_CLIENT_BINDING } from './mail-contact-groups-client.ts'
import { MAIL_SEARCH_CLIENT_BINDING } from './mail-search-client.ts'
import { MAIL_ATTACHMENTS_CLIENT_BINDING } from './mail-attachments-client.ts'
import { MAIL_CALENDAR_CLIENT_BINDING } from './mail-calendar-client.ts'
import { MAIL_CALENDAR_VIEW_CLIENT_BINDING } from './mail-calendar-view-client.ts'
import { MAIL_COMPOSE_IDENTITIES_CLIENT_BINDING } from './mail-compose-identities-client.ts'
import { MAIL_COMPOSE_ATTACHMENTS_CLIENT_BINDING } from './mail-compose-attachments-client.ts'
import { MAIL_DRAFT_CLIENT_BINDING } from './mail-draft-client.ts'
import { WHM_BACKUPS_CLIENT_BINDING } from './whm-backups-client.ts'
import { WHM_DOMAINS_CLIENT_BINDING } from './whm-domains-client.ts'
import { WHM_DEFAULT_SITE_CLIENT_BINDING } from './whm-default-site-client.ts'
import { WHM_SSL_CLIENT_BINDING } from './whm-ssl-client.ts'
import { WHM_SSL_INSTALL_CLIENT_BINDING } from './whm-ssl-install-client.ts'
import { WHM_SECURITY_CLIENT_BINDING } from './whm-security-client.ts'
import { WHM_SSH_CLIENT_BINDING } from './whm-ssh-client.ts'
import { WHM_PHP_CLIENT_BINDING } from './whm-php-client.ts'
import { WHM_FIREWALL_CLIENT_BINDING } from './whm-firewall-client.ts'
import { WHM_MAIL_QUEUE_CLIENT_BINDING } from './whm-mail-queue-client.ts'
import { WHM_UPDATES_CLIENT_BINDING } from './whm-updates-client.ts'
import { WHM_REPAIR_CLIENT_BINDING } from './whm-repair-client.ts'
import { WHM_ACCOUNT_HEALTH_CLIENT_BINDING } from './whm-account-health-client.ts'
import { WHM_BACKUP_FILES_CLIENT_BINDING } from './whm-backup-files-client.ts'
import { WHM_JOBS_CLIENT_BINDING } from './whm-jobs-client.ts'
import { WHM_PANEL_TOKENS_CLIENT_BINDING } from './whm-panel-tokens-client.ts'
import { WHM_PANEL_NOTIFICATIONS_CLIENT_BINDING } from './whm-panel-notifications-client.ts'
import { WHM_ANNOUNCEMENTS_CLIENT_BINDING } from './whm-announcements-client.ts'
import { WHM_BACKUP_RUNS_CLIENT_BINDING } from './acct-backup-runs-client.ts'
import { ACCT_TRANSFER_CREDENTIALS_CLIENT_BINDING } from './acct-transfer-credentials-client.ts'
import { ACCT_CONVERT_ADDON_CLIENT_BINDING } from './acct-convert-addon-client.ts'
import { ACCT_RESTORE_CLIENT_BINDING } from './acct-restore-client.ts'
import { ACCT_STAGING_CLIENT_BINDING } from './acct-staging-client.ts'
import { ACCOUNT_TEAM_CLIENT_BINDING } from './acct-team-client.ts'
import { WHM_ACCOUNT_TEMPLATES_CLIENT_BINDING } from './acct-templates-client.ts'
import { WHM_ENHANCEMENTS_CLIENT_BINDING } from './acct-enhancements-client.ts'
import { ACCOUNT_ANNOUNCEMENTS_CLIENT_BINDING } from './board-port/account-announcements-banner-client.ts'
import { WHM_SOFTWARE_CENTER_CLIENT_BINDING } from './whm-software-center-client.ts'
import { WHM_DATABASES_CLIENT_BINDING } from './whm-databases-client.ts'
import { WHM_DATABASE_TUNING_CLIENT_BINDING } from './whm-database-tuning-client.ts'
import { WHM_PREFERENCES_CLIENT_BINDING } from './whm-preferences-client.ts'
import { WHM_PANEL_SETTINGS_CLIENT_BINDING } from './whm-panel-settings-client.ts'
import { WHM_PANEL_BRANDING_CLIENT_BINDING } from './whm-panel-branding-client.ts'
import { WHM_LANGUAGES_CLIENT_BINDING } from './whm-languages-client.ts'
import { WHM_WHMCS_CLIENT_BINDING } from './whm-whmcs-client.ts'
import { WHM_SERVICE_MANAGER_CLIENT_BINDING } from './whm-service-manager-client.ts'
import { WHM_CONFIGURATION_HEALTH_CLIENT_BINDING } from './whm-configuration-health-client.ts'
import { ACCOUNT_PACKAGES_CLIENT_BINDING } from './account-packages-client.ts'
import { ACCOUNT_DATABASE_REMOTE_CLIENT_BINDING } from './account-database-remote-client.ts'
import { DB_ENGINES_CLIENT_BINDING } from './db-engines-client.ts'
import { ACCOUNT_COLLABORATION_CLIENT_BINDING } from './account-collaboration-client.ts'
import { WHM_DEVELOPER_CLIENT_BINDING } from './whm-developer-client.ts'
import { WHM_TRUSTED_PROXIES_CLIENT_BINDING } from './whm-trusted-proxies-client.ts'
import { WHM_BACKUP_DESTINATIONS_CLIENT_BINDING } from './whm-backup-destinations-client.ts'
import { MAIL_TOOLS_CLIENT_BINDING } from './mail-tools-client.ts'
import { MAIL_SPAM_CLIENT_BINDING } from './mail-spam-client.ts'
import { MAIL_MAILING_LISTS_CLIENT_BINDING } from './mail-mailing-lists-client.ts'
import { WHM_BENCHMARK_CLIENT_BINDING } from './whm-benchmark-client.ts'
import { WHM_TRAFFIC_CLIENT_BINDING } from './whm-traffic-client.ts'
import { WHM_METERING_CLIENT_BINDING } from './whm-metering-client.ts'
import { WHM_DEFAULT_INDEX_CLIENT_BINDING } from './whm-default-index-client.ts'
import { WHM_COMPOSER_CLIENT_BINDING } from './whm-composer-client.ts'
import { SW_CONTAINERS_CLIENT_BINDING } from './sw-containers-client.ts'
import { SW_ADDON_SERVICES_CLIENT_BINDING } from './sw-addon-services-client.ts'
import { SW_DEPLOYMENTS_CLIENT_BINDING } from './sw-deployments-client.ts'
import { SW_APP_PROJECTS_CLIENT_BINDING } from './sw-app-projects-client.ts'
import { SW_OPTIMIZE_CLIENT_BINDING } from './sw-optimize-client.ts'
import { SW_APPLICATIONS_CLIENT_BINDING } from './sw-applications-client.ts'
import { ACCOUNT_RUNTIME_CLIENT_BINDING } from './account-runtime-client.ts'
import { ACCOUNT_DYNAMIC_DNS_CLIENT_BINDING } from './account-dynamic-dns-client.ts'
import { ACCOUNT_SITE_PUBLISHER_CLIENT_BINDING } from './account-site-publisher-client.ts'
import { ACCOUNT_GIT_CLIENT_BINDING } from './account-git-client.ts'
import { ACCOUNT_PGP_CLIENT_BINDING } from './account-pgp-client.ts'
import { ACCOUNT_WEB_DIRECTIVES_CLIENT_BINDING } from './account-web-directives-client.ts'
import { ACCOUNT_SSH_CLIENT_BINDING } from './account-ssh-client.ts'
import { ACCOUNT_LOGS_CLIENT_BINDING } from './account-logs-client.ts'
import { SITE_HEALTH_CLIENT_BINDING } from './site-health-client.ts'
import { ACCOUNT_VIRUS_SCAN_CLIENT_BINDING } from './account-virus-scan-client.ts'
import { ACCOUNT_NETWORK_TOOLS_CLIENT_BINDING } from './account-network-tools-client.ts'
import { ACCOUNT_DATABASE_INSIGHTS_CLIENT_BINDING } from './account-database-insights-client.ts'
import { WHM_MAIL_LOG_CLIENT_BINDING } from './whm-mail-log-client.ts'
import { WHM_FTP_LOG_CLIENT_BINDING } from './whm-ftp-log-client.ts'
import { WHM_MAIL_SERVER_CLIENT_BINDING } from './whm-mail-server-client.ts'
import { MAILX_WHM_CLIENT_BINDING } from './mailx-whm-client.ts'
import { MAILX_ARCHIVE_CLIENT_BINDING } from './mailx-archive-client.ts'
import { MAILX_COLLECTIONS_CLIENT_BINDING } from './mailx-collections-client.ts'
import { MAILX_MAIL_TOOLS_CLIENT_BINDING } from './mailx-mail-tools-client.ts'
import { WHM_MAIL_QUALITY_CLIENT_BINDING } from './whm-mail-quality-client.ts'
import { WHM_MAILBOX_MAINTENANCE_CLIENT_BINDING } from './whm-mailbox-maintenance-client.ts'
import { MAIL_TRACK_DELIVERY_CLIENT_BINDING } from './mail-track-delivery-client.ts'
import { MAIL_FOLDERS_CLIENT_BINDING } from './mail-folders-client.ts'
import { MAIL_DISK_USAGE_CLIENT_BINDING } from './mail-disk-usage-client.ts'
import { MAIL_CONNECT_DEVICES_CLIENT_BINDING } from './mail-connect-devices-client.ts'
import { MAIL_MAILBOX_FORWARDERS_CLIENT_BINDING } from './mail-mailbox-forwarders-client.ts'
import { MAIL_MAILBOX_PREFERENCES_CLIENT_BINDING } from './mail-mailbox-preferences-client.ts'
import { WHM_UPGRADE_CLIENT_BINDING } from './whm-upgrade-client.ts'
import { WHM_MONITORING_CLIENT_BINDING } from './whm-monitoring-client.ts'
import { WHM_SERVER_OBSERVATION_CLIENT_BINDING } from './whm-server-observation-client.ts'
import { OPS_FILE_SHARING_CLIENT_BINDING } from './ops-file-sharing-client.ts'
import { OPS_TERMINAL_CLIENT_BINDING } from './ops-terminal-client.ts'
import { OPS_NODES_CLIENT_BINDING } from './ops-nodes-client.ts'
import { OPS_INTEGRATIONS_CLIENT_BINDING } from './ops-integrations-client.ts'
import { WHM_SERVER_HEALTH_CLIENT_BINDING } from './whm-server-health-client.ts'
import { WHM_SUPPORT_CLIENT_BINDING } from './whm-support-client.ts'
import { WHM_MONITORING_ALERTS_CLIENT_BINDING } from './whm-monitoring-alerts-client.ts'
import { WHM_SERVICE_DETAIL_CLIENT_BINDING } from './whm-service-detail-client.ts'
import { WHM_DNS_TOOLS_CLIENT_BINDING } from './whm-dns-tools-client.ts'
import { WHM_SECURITY_TOOLS_CLIENT_BINDING } from './whm-security-tools-client.ts'
import { SEC_SECURITY_CLIENT_BINDING } from './sec-security-client.ts'
import { SEC_DNS_CLIENT_BINDING } from './sec-dns-client.ts'
import { WHM_WEB_SERVER_CLIENT_BINDING } from './whm-web-server-client.ts'
import { WHM_SERVER_INFO_CLIENT_BINDING } from './whm-server-info-client.ts'
import { WHM_IPS_CLIENT_BINDING } from './whm-ips-client.ts'
import { WHM_PANEL_DATA_CLIENT_BINDING } from './whm-panel-data-client.ts'
import { WHM_TRANSFER_CLIENT_BINDING } from './whm-transfer-client.ts'
import { ZONE_EDITOR_CLIENT_BINDING } from './zone-editor-client.ts'
import { DIRECTORY_PRIVACY_CLIENT_BINDING } from './directory-privacy-client.ts'
import { PASSWORD_GENERATOR_CLIENT_BINDING } from './password-generate-client.ts'
import { APPROVED_HOST_SERVICES_CLIENT } from './approved-host-services-client.ts'
import { APPROVED_WHM_OPERATIONS_TABS_CLIENT } from './board-port/approved-whm-operations-components.ts'
import { APPROVED_WHM_TABLE_FILTERS_CLIENT } from './board-port/approved-xwhm-table-filters.ts'
import { COMMAND_PALETTE_CLIENT_FUNCTIONS } from './command-palette-client.ts'
import { xwhmPageAdapters } from './pages/xwhm-adapters.ts'

export type WsConnectionState = 'connected' | 'reconnecting' | 'offline'
export type ReconcileStageStatus = 'pending' | 'running' | 'passed' | 'failed'

export const RECONCILE_STAGES: readonly ReconcileStage[] = [
  'render',
  'test',
  'switch',
  'reload',
  'verify',
] as const

const RECONCILE_STAGE_LABELS: Readonly<Record<ReconcileStage, string>> = {
  render: msgid('1. Render config'),
  test: msgid('2. Config test'),
  switch: msgid('3. Atomic switch'),
  reload: msgid('4. Service reload'),
  verify: msgid('5. Health verify'),
}

export interface ReconcilePipelineState {
  generationId: number
  status: 'idle' | 'running' | 'applied' | 'failed'
  stages: Record<ReconcileStage, ReconcileStageStatus>
  stateChecksum: string | null
  filesCount: number
  durationMs: number | null
  failedTest: string | null
  error: string | null
  updatedAt: string | null
}

export interface LiveJobStatus {
  jobId: string
  kind: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  progress: number
  logChunk?: string
  error?: string | null
  updatedAt: string
}

export interface LiveEventState {
  connectionState: WsConnectionState
  reconcile: ReconcilePipelineState
  ioAnalytics: IoAnalyticsSnapshot | null
  websiteAnalyticsByDomain: Record<string, WebsiteAnalyticsSnapshot>
  recentAuditEntries: AuditEntry[]
  recentJobs: LiveJobStatus[]
  servicesHealth: { name: string; active: boolean; enabled: boolean }[]
}

export interface LiveEventStore {
  getState: () => LiveEventState
  setConnectionState: (connectionState: WsConnectionState) => LiveEventState
  applyEvent: (event: LiveEvent) => LiveEventState
  dispatch: (event: LiveEvent) => LiveEventState
  subscribe: (listener: (state: LiveEventState, event?: LiveEvent) => void) => () => void
}

const MAX_RECENT_NOTIFICATIONS = 50

export function createInitialLiveEventState(
  overrides?: Partial<LiveEventState>,
): LiveEventState {
  return {
    connectionState: 'offline',
    reconcile: {
      generationId: 0,
      status: 'idle',
      stages: {
        render: 'pending',
        test: 'pending',
        switch: 'pending',
        reload: 'pending',
        verify: 'pending',
      },
      stateChecksum: null,
      filesCount: 0,
      durationMs: null,
      failedTest: null,
      error: null,
      updatedAt: null,
    },
    ioAnalytics: null,
    websiteAnalyticsByDomain: {},
    recentAuditEntries: [],
    recentJobs: [],
    servicesHealth: [],
    ...overrides,
  }
}

/**
 * Pure reducer that applies a single `LiveEvent` to `LiveEventState`.
 */
export function reduceLiveEvent(
  state: LiveEventState,
  event: LiveEvent,
): LiveEventState {
  switch (event.kind) {
    case 'reconcile.stage': {
      const isNewGeneration = event.data.generationId !== state.reconcile.generationId
      const baseStages: Record<ReconcileStage, ReconcileStageStatus> = isNewGeneration
        ? {
            render: 'pending',
            test: 'pending',
            switch: 'pending',
            reload: 'pending',
            verify: 'pending',
          }
        : { ...state.reconcile.stages }

      baseStages[event.data.stage] = event.data.status
      return {
        ...state,
        reconcile: {
          ...state.reconcile,
          generationId: event.data.generationId,
          status: event.data.status === 'failed' ? 'failed' : 'running',
          stages: baseStages,
          error:
            event.data.status === 'failed'
              ? (event.data.detail ?? state.reconcile.error)
              : isNewGeneration
                ? null
                : state.reconcile.error,
          failedTest:
            event.data.status === 'failed'
              ? event.data.stage
              : isNewGeneration
                ? null
                : state.reconcile.failedTest,
          updatedAt: event.at,
        },
      }
    }

    case 'reconcile.applied': {
      return {
        ...state,
        reconcile: {
          generationId: event.data.generationId,
          status: 'applied',
          stages: {
            render: 'passed',
            test: 'passed',
            switch: 'passed',
            reload: 'passed',
            verify: 'passed',
          },
          stateChecksum: event.data.stateChecksum,
          filesCount: event.data.filesCount,
          durationMs: event.data.durationMs,
          failedTest: null,
          error: null,
          updatedAt: event.at,
        },
      }
    }

    case 'reconcile.failed': {
      return {
        ...state,
        reconcile: {
          ...state.reconcile,
          generationId: event.data.generationId,
          status: 'failed',
          stages: {
            ...state.reconcile.stages,
            test: 'failed',
          },
          failedTest: event.data.failedTest,
          error: event.data.error,
          updatedAt: event.at,
        },
      }
    }

    case 'io.analytics': {
      return {
        ...state,
        ioAnalytics: event.data,
      }
    }

    case 'website.analytics': {
      return {
        ...state,
        websiteAnalyticsByDomain: {
          ...state.websiteAnalyticsByDomain,
          [event.data.domain]: event.data,
        },
      }
    }

    case 'audit.entry': {
      const recentAuditEntries = [event.data, ...state.recentAuditEntries].slice(
        0,
        MAX_RECENT_NOTIFICATIONS,
      )
      return {
        ...state,
        recentAuditEntries,
      }
    }

    case 'job.updated': {
      const filtered = state.recentJobs.filter((j) => j.jobId !== event.data.jobId)
      const nextJob: LiveJobStatus = {
        jobId: event.data.jobId,
        kind: event.data.kind,
        status: event.data.status,
        progress: event.data.progress,
        logChunk: event.data.logChunk,
        error: event.data.error,
        updatedAt: event.at,
      }
      return {
        ...state,
        recentJobs: [nextJob, ...filtered].slice(0, MAX_RECENT_NOTIFICATIONS),
      }
    }

    case 'service.health': {
      return {
        ...state,
        servicesHealth: event.data.services,
      }
    }

    case 'metrics.tick':
    case 'mail.received':
    case 'mail.changed':
    case 'mail.flags':
    case 'security.ban':
      return state
  }
}

/**
 * Creates a reactive client-side store for WebSocket `LiveEvent` streams.
 */
export function createLiveEventStore(
  initial?: Partial<LiveEventState>,
): LiveEventStore {
  let state = createInitialLiveEventState(initial)
  const listeners = new Set<(state: LiveEventState, event?: LiveEvent) => void>()

  const notify = (event?: LiveEvent) => {
    for (const listener of listeners) {
      listener(state, event)
    }
  }

  const applyEvent = (event: LiveEvent): LiveEventState => {
    state = reduceLiveEvent(state, event)
    notify(event)
    return state
  }

  return {
    getState: () => state,
    setConnectionState: (connectionState: WsConnectionState): LiveEventState => {
      state = { ...state, connectionState }
      notify()
      return state
    },
    applyEvent,
    dispatch: applyEvent,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/**
 * Renders the live 5-stage reconcile pipeline (`render -> test -> switch -> reload -> verify`),
 * WebSocket connection indicator, and generation status badge (`Applied in generation #N` or
 * `Rolled back` with expandable raw error details).
 */
export function renderReconcileBanner(
  state: LiveEventState,
  locale: Locale = 'en',
): string {
  const { reconcile, connectionState } = state
  const dir = localeDirection(locale)
  const arrow = dir === 'rtl' ? '←' : '→'

  const wsBadge =
    connectionState === 'connected'
      ? renderStatusBadge('ok', translator(locale)('Live stream connected'))
      : connectionState === 'reconnecting'
        ? renderStatusBadge('reconciling', translator(locale)('Reconnecting live stream...'))
        : renderStatusBadge('warn', translator(locale)('Live stream offline'))

  const generationBadge =
    reconcile.generationId <= 0 || reconcile.updatedAt === null
      ? renderStatusBadge('warn', translator(locale)('Reconciliation has not been observed'))
      : reconcile.status === 'running'
      ? renderStatusBadge(
          'reconciling',
          translator(locale)('Reconciling generation #{generationId}...', {
            generationId: reconcile.generationId,
          }),
        )
      : reconcile.status === 'failed'
        ? renderStatusBadge(
            'critical',
            translator(locale)('Rolled back from generation #{generationId}', {
              generationId: reconcile.generationId,
            }),
          )
        : renderStatusBadge(
            'ok',
            translator(locale)('Applied in generation #{generationId}', {
              generationId: reconcile.generationId,
            }),
          )

  const stepsHtml = RECONCILE_STAGES.map((stage, idx) => {
    const stepStatus = reconcile.stages[stage] ?? 'pending'
    const stageLabel = translator(locale)(RECONCILE_STAGE_LABELS[stage])
    const stepBadgeKind =
      stepStatus === 'passed'
        ? 'ok'
        : stepStatus === 'running'
          ? 'reconciling'
          : stepStatus === 'failed'
            ? 'critical'
            : 'suspended'

    const separator =
      idx < RECONCILE_STAGES.length - 1
        ? `<li class="xp-reconcile-arrow" aria-hidden="true">${arrow}</li>`
        : ''

    return (
      `<li class="xp-reconcile-step" data-stage="${stage}" data-step-status="${stepStatus}">` +
      renderStatusBadge(stepBadgeKind, stageLabel) +
      `</li>` +
      separator
    )
  }).join('')

  const metaSummary =
    reconcile.stateChecksum && reconcile.durationMs !== null
      ? `<span class="xp-reconcile-meta xp-tabular xp-mono" style="min-inline-size:0;overflow-wrap:anywhere;white-space:normal">${escapeHtml(
          translator(locale)('{filesCount} files · {durationMs} ms · sha256 {checksum}', {
            filesCount: reconcile.filesCount,
            durationMs: reconcile.durationMs,
            checksum: '{checksum}',
          }),
        ).replace('{checksum}', renderLtrValue(reconcile.stateChecksum))}</span>`
      : ''

  const errorBlock =
    reconcile.status === 'failed' && (reconcile.error || reconcile.failedTest)
      ? `<details class="xp-reconcile-error" open>` +
        `<summary class="xp-reconcile-error__summary">` +
        `${escapeHtml(
          translator(locale)('Failed validation test: {failedTest}', {
            failedTest: reconcile.failedTest ?? 'configtest',
          }),
        )} — ${escapeHtml(translator(locale)('Expand raw verifier & configtest stderr output'))}` +
        `</summary>` +
        `<pre class="xp-terminal xp-mono">${escapeHtml(reconcile.error ?? 'Configuration test failed; previous generation remains active.')}</pre>` +
        `</details>`
      : ''

  return (
    `<section id="xp-reconcile-banner" class="xp-reconcile-banner" data-reconcile-banner="true" data-generation-id="${reconcile.generationId}" data-reconcile-status="${reconcile.status}" dir="${dir}" aria-label="${escapeHtml(translator(locale)('Declarative State Reconciler Pipeline'))}">` +
    `<div class="xp-card__header">` +
    `<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">` +
    `<strong class="xp-reconcile-title">${escapeHtml(translator(locale)('Declarative State Reconciler Pipeline'))}</strong>` +
    generationBadge +
    metaSummary +
    `</div>` +
    `<div class="xp-ws-indicator" data-ws-state="${connectionState}">${wsBadge}</div>` +
    `</div>` +
    `<ol class="xp-reconcile-stepper" role="list">${stepsHtml}</ol>` +
    errorBlock +
    `</section>`
  )
}

/**
 * Embedded client-side JavaScript that connects to `ws(s)://<host>/api/ws`,
 * automatically reconnects with exponential backoff, updates live KPIs, IO charts,
 * website analytics, and the reconcile stepper banner in real time
 * without page reload, and binds keyboard shortcuts (`Cmd/Ctrl+K`, `/`, `g d`, `g a`, `g f`, `Escape`).
 */
export const BROWSER_REALTIME_SCRIPT = /* js */ `
(function () {
  'use strict';
${SHELL_MOTION_CLIENT_SCRIPT}

  var reconnectAttempt = 0;
  var wsOpened = false;
  var liveUpdatesGaveUp = false;
  var connectTimer = null;
  var ws = null;
  var lastKeyPrefix = null;
  var lastKeyPrefixTimer = null;
  var activeOverlay = null;
  var toolbarMobileMode = null;
  var lastFocusedElement = null;
  var commandPalette = null;
  var focusableSelector = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), details > summary:first-of-type, [tabindex], [contenteditable="true"]';

  function setWsBadgeState(state) {
    var el = document.querySelector('[data-ws-state]');
    if (el) el.setAttribute('data-ws-state', state);
    var indicators = document.querySelectorAll('[data-ws-indicator]');
    var connected = state === 'connected';
    var label = connected
      ? (xpT(msgctxt('ws-client', 'Live')))
      : state === 'offline' ? (xpT('Offline'))
      : state === 'reconnecting' ? (xpT('Reconnecting'))
      : (xpT('Connecting'));
    for (var i = 0; i < indicators.length; i++) {
      var indicator = indicators[i];
      if (indicator.getAttribute('data-ws-indicator') === 'unavailable') continue;
      indicator.setAttribute('data-ws-indicator', connected ? 'connected' : 'disconnected');
      var badge = indicator.querySelector('.xp-badge');
      if (!badge) continue;
      var tone = connected ? 'ok' : 'suspended';
      badge.className = 'xp-badge xp-badge--' + tone;
      badge.setAttribute('data-status', tone);
      var text = badge.querySelector('.xp-badge__label');
      if (text) text.textContent = label;
    }
  }

  function markLiveUpdatesOff() {
    if (liveUpdatesGaveUp) return;
    liveUpdatesGaveUp = true;
    if (connectTimer) clearTimeout(connectTimer);
    if (ws) {
      try { ws.close(); } catch (_err) { /* The socket is already gone. */ }
    }
    var indicators = document.querySelectorAll('[data-ws-indicator]');
    var label = xpT('Live updates off');
    for (var i = 0; i < indicators.length; i++) {
      var indicator = indicators[i];
      if (indicator.getAttribute('data-ws-indicator') === 'unavailable') continue;
      indicator.setAttribute('data-ws-indicator', 'unavailable');
      indicator.setAttribute('aria-label', label);
      indicator.setAttribute('title', label);
      var badge = indicator.querySelector('.xp-badge');
      if (!badge) continue;
      badge.className = 'xp-badge xp-badge--suspended';
      badge.setAttribute('data-status', 'suspended');
      var text = badge.querySelector('.xp-badge__label');
      if (text) text.textContent = label;
    }
  }

  function updateReconcileDom(event) {
    var banner = document.getElementById('xp-reconcile-banner');
    if (!banner) return;

    if (event.kind === 'reconcile.stage') {
      banner.setAttribute('data-generation-id', String(event.data.generationId));
      banner.setAttribute('data-reconcile-status', event.data.status === 'failed' ? 'failed' : 'running');
      var stepEl = banner.querySelector('[data-stage="' + event.data.stage + '"]');
      if (stepEl) {
        stepEl.setAttribute('data-step-status', event.data.status);
      }
    } else if (event.kind === 'reconcile.applied') {
      banner.setAttribute('data-generation-id', String(event.data.generationId));
      banner.setAttribute('data-reconcile-status', 'applied');
      var steps = banner.querySelectorAll('[data-stage]');
      for (var i = 0; i < steps.length; i++) {
        steps[i].setAttribute('data-step-status', 'passed');
      }
    } else if (event.kind === 'reconcile.failed') {
      banner.setAttribute('data-generation-id', String(event.data.generationId));
      banner.setAttribute('data-reconcile-status', 'failed');
    }
  }

  function updateIoMetricsDom(snapshot) {
    if (!snapshot || !snapshot.current) return;
    var cur = snapshot.current;
    var readMb = (cur.readBytesPerSec / (1024 * 1024)).toFixed(2) + ' MB/s';
    var writeMb = (cur.writeBytesPerSec / (1024 * 1024)).toFixed(2) + ' MB/s';
    var totalIops = String(Math.round(cur.readIops + cur.writeIops)) + ' IOPS';
    var awaitStr = cur.awaitMs.toFixed(2) + ' ms';

    var readEl = document.querySelector('[data-live-kpi="io-read"]');
    if (readEl) readEl.textContent = readMb;
    var writeEl = document.querySelector('[data-live-kpi="io-write"]');
    if (writeEl) writeEl.textContent = writeMb;
    var iopsEl = document.querySelector('[data-live-kpi="io-iops"]');
    if (iopsEl) iopsEl.textContent = totalIops;
    var awaitEl = document.querySelector('[data-live-kpi="io-await"]');
    if (awaitEl) awaitEl.textContent = awaitStr;
  }

  function updateWebsiteAnalyticsDom(snapshot) {
    if (!snapshot || !snapshot.totals) return;
    var reqEl = document.querySelector('[data-live-kpi="web-requests"]');
    if (reqEl) reqEl.textContent = String(snapshot.totals.requests);
    var cacheEl = document.querySelector('[data-live-kpi="web-cache-hit"]');
    if (cacheEl) cacheEl.textContent = snapshot.totals.cacheHitRatioPercent.toFixed(1) + '%';
    var p95El = document.querySelector('[data-live-kpi="web-p95"]');
    if (p95El) p95El.textContent = snapshot.totals.p95RequestTimeMs.toFixed(1) + ' ms';
  }

  function handleLiveEvent(event) {
    if (!event || !event.kind) return;
    if (
      event.kind === 'reconcile.stage' ||
      event.kind === 'reconcile.applied' ||
      event.kind === 'reconcile.failed'
    ) {
      updateReconcileDom(event);
    } else if (event.kind === 'io.analytics') {
      updateIoMetricsDom(event.data);
    } else if (event.kind === 'website.analytics') {
      updateWebsiteAnalyticsDom(event.data);
    } else if (event.kind === 'mail.changed' || event.kind === 'mail.flags' || event.kind === 'mail.received') {
      if (event.scope && typeof event.scope.mailboxLogin === 'string') {
        document.dispatchEvent(new CustomEvent('xpanel:mail-invalidated', { detail: { mailbox: event.scope.mailboxLogin } }));
      }
    }
  }

  function connectWebSocket() {
    if (liveUpdatesGaveUp) return;
    if (typeof window === 'undefined' || !('WebSocket' in window)) {
      markLiveUpdatesOff();
      return;
    }
    var proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    var url = proto + '//' + window.location.host + '/api/ws';
    try {
      ws = new WebSocket(url);
    } catch (_err) {
      markLiveUpdatesOff();
      return;
    }
    if (connectTimer) clearTimeout(connectTimer);
    connectTimer = setTimeout(function () {
      if (wsOpened || liveUpdatesGaveUp) return;
      markLiveUpdatesOff();
    }, 4000);

    ws.onopen = function () {
      wsOpened = true;
      reconnectAttempt = 0;
      if (connectTimer) clearTimeout(connectTimer);
      setWsBadgeState('connected');
    };

    ws.onmessage = function (msg) {
      try {
        var payload = JSON.parse(msg.data);
        if (payload && payload.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', at: new Date().toISOString() }));
          return;
        }
        handleLiveEvent(payload);
      } catch (_err) {
        // Ignore malformed frame
      }
    };

    ws.onclose = function () {
      if (connectTimer) clearTimeout(connectTimer);
      if (liveUpdatesGaveUp) return;
      if (!wsOpened) {
        markLiveUpdatesOff();
        return;
      }
      setWsBadgeState('reconnecting');
      scheduleReconnect();
    };

    ws.onerror = function () {
      if (!wsOpened) markLiveUpdatesOff();
    };
  }

  function scheduleReconnect() {
    reconnectAttempt += 1;
    var baseDelay = Math.min(15000, 500 * Math.pow(1.8, reconnectAttempt));
    var jitter = Math.floor(Math.random() * 250);
    setTimeout(connectWebSocket, baseDelay + jitter);
  }

  function isVisibleElement(element) {
    if (!element || !element.isConnected || element.closest('[hidden], [inert]') || !element.getClientRects().length) return false;
    if (typeof element.checkVisibility === 'function') {
      if (!element.checkVisibility()) return false;
    } else {
      var parent = element.parentElement;
      while (parent) {
        var closedDetails = parent.closest('details:not([open])');
        if (!closedDetails) break;
        var summary = closedDetails.querySelector(':scope > summary');
        if (!summary || !summary.contains(element)) return false;
        parent = closedDetails.parentElement;
      }
    }
    var visibility = window.getComputedStyle(element).visibility;
    return visibility !== 'hidden' && visibility !== 'collapse';
  }

  function focusableElements(element) {
    return Array.prototype.filter.call(element.querySelectorAll(focusableSelector), function (target) {
      return target.tabIndex >= 0 && isVisibleElement(target);
    });
  }

  function focusOverlay(overlay) {
    var targets = focusableElements(overlay.element);
    var preferred = null;
    if (overlay.kind === 'mobile-nav') {
      preferred = targets.find(function (target) { return target.tagName.toLowerCase() === 'a'; });
    } else if (overlay.kind === 'cmdk') {
      preferred = targets.find(function (target) { return target.tagName.toLowerCase() === 'input'; });
    }
    (preferred || targets[0] || overlay.element).focus({ preventScroll: true });
  }

  function toolbarFocusReturn(target) {
    if (window.innerWidth >= 960 || !target || !target.closest) return target;
    var details = target.closest('details[data-xp-toolbar-options]');
    if (!details) return target;
    return details.querySelector(':scope > summary') || target;
  }

  function responsiveFocusTarget() {
    var focused = document.activeElement;
    // CSS can blur a newly hidden control before the resize listener runs.
    if (focused === document.body && lastFocusedElement && !isVisibleElement(lastFocusedElement)) return lastFocusedElement;
    return focused;
  }

  function focusVisibleTarget(target) {
    if (!target || !target.matches(focusableSelector) || !isVisibleElement(target)) return false;
    target.focus({ preventScroll: true });
    return document.activeElement === target;
  }

  function restoreVisibleFocus(target) {
    if (focusVisibleTarget(toolbarFocusReturn(target))) return;
    var toolbar = target && target.closest ? target.closest('details[data-xp-toolbar-options]') : null;
    if (toolbar) {
      var toolbarTargets = focusableElements(toolbar);
      if (focusVisibleTarget(toolbarTargets[0])) return;
    }
    var sidebar = document.querySelector('[data-xp-sidebar]');
    if (window.innerWidth < 960) {
      if (focusVisibleTarget(document.querySelector('[data-action="toggle-mobile-nav"]'))) return;
    } else if (sidebar) {
      if (focusVisibleTarget(sidebar.querySelector('[aria-current="page"]'))) return;
    }
    focusVisibleTarget(document.getElementById('main-content'));
  }

  function closeToolbarOptions() {
    if (window.innerWidth >= 960) return;
    var toolbars = document.querySelectorAll('details[data-xp-toolbar-options]');
    for (var i = 0; i < toolbars.length; i++) toolbars[i].open = false;
  }

  function syncResponsiveToolbar() {
    var mobile = window.innerWidth < 960;
    if (toolbarMobileMode === mobile) return;
    toolbarMobileMode = mobile;
    var toolbars = document.querySelectorAll('details[data-xp-toolbar-options]');
    for (var i = 0; i < toolbars.length; i++) {
      var toolbar = toolbars[i];
      var focused = responsiveFocusTarget();
      var summary = toolbar.querySelector(':scope > summary');
      toolbar.open = !mobile;
      toolbar.dataset.mobileReady = 'true';
      if (mobile && summary && focused !== summary && toolbar.contains(focused)) focusVisibleTarget(summary);
      else if (!mobile && focused === summary) restoreVisibleFocus(summary);
    }
  }

  function closeFocusedToolbar(target) {
    if (window.innerWidth >= 960 || !target || !target.closest) return false;
    var toolbar = target.closest('details[data-xp-toolbar-options]');
    if (!toolbar || !toolbar.open) return false;
    toolbar.open = false;
    var summary = toolbar.querySelector(':scope > summary');
    if (summary) summary.focus({ preventScroll: true });
    return true;
  }

  function setMobileNavigationState(open) {
    var shell = document.querySelector('.xp-shell');
    var backdrop = document.querySelector('[data-xp-nav-backdrop]');
    var toggles = document.querySelectorAll('[data-action="toggle-mobile-nav"]');
    if (shell) {
      if (open) shell.dataset.mobileNav = 'open';
      else delete shell.dataset.mobileNav;
    }
    if (backdrop) backdrop.hidden = !open;
    for (var i = 0; i < toggles.length; i++) {
      toggles[i].setAttribute('aria-expanded', open ? 'true' : 'false');
    }
  }

  function finishOverlayClose(overlay, restoreFocus) {
    if (activeOverlay !== overlay) return;
    activeOverlay = null;
    if (overlay.motion) { overlay.motion.destroy(); overlay.motion = null; }
    if (overlay.kind === 'mobile-nav') {
      setMobileNavigationState(false);
      if (overlay.role === null) overlay.element.removeAttribute('role');
      else overlay.element.setAttribute('role', overlay.role);
      if (overlay.ariaModal === null) overlay.element.removeAttribute('aria-modal');
      else overlay.element.setAttribute('aria-modal', overlay.ariaModal);
    } else {
      overlay.element.hidden = true;
      if (overlay.kind === 'cmdk' && commandPalette) commandPalette.input.setAttribute('aria-expanded', 'false');
    }
    if (overlay.tabIndex === null) overlay.element.removeAttribute('tabindex');
    for (var i = 0; i < overlay.inertElements.length; i++) {
      var previous = overlay.inertElements[i];
      if (previous.value === null) previous.element.removeAttribute('inert');
      else previous.element.setAttribute('inert', previous.value);
    }
    document.body.style.overflow = overlay.bodyOverflow;
    document.documentElement.style.overflow = overlay.documentOverflow;
    if (restoreFocus) {
      restoreVisibleFocus(overlay.returnFocus);
      // Preserve the document after the lock and focus restoration have settled.
      // Do not override navigation or a deliberate history/hash change.
      if (!overlay.skipDocumentRestore && window.location.href === overlay.documentHref &&
          (window.scrollX !== overlay.documentX || window.scrollY !== overlay.documentY)) {
        window.scrollTo({ left: overlay.documentX, top: overlay.documentY, behavior: 'instant' });
      }
    }
  }

  function closeActiveOverlay(restoreFocus, immediate, skipDocumentRestore) {
    if (!activeOverlay) return;
    var overlay = activeOverlay;
    if (overlay.closing) {
      overlay.skipDocumentRestore = overlay.skipDocumentRestore || Boolean(skipDocumentRestore);
      overlay.restoreFocusAfterClose = overlay.restoreFocusAfterClose || restoreFocus;
      if (immediate) finishOverlayClose(overlay, overlay.restoreFocusAfterClose);
      return;
    }
    overlay.skipDocumentRestore = Boolean(skipDocumentRestore);
    if (overlay.motion && !immediate) {
      overlay.closing = true;
      overlay.restoreFocusAfterClose = restoreFocus;
      overlay.motion.close(function () { finishOverlayClose(overlay, overlay.restoreFocusAfterClose); });
    } else finishOverlayClose(overlay, restoreFocus);
  }

  function openOverlay(element, kind, trigger) {
    if (!element) return;
    if (activeOverlay && activeOverlay.element === element) {
      if (activeOverlay.closing && activeOverlay.motion) {
        activeOverlay.closing = false;
        activeOverlay.restoreFocusAfterClose = false;
        activeOverlay.skipDocumentRestore = false;
        activeOverlay.motion.open();
        focusOverlay(activeOverlay);
      }
      return;
    }
    lastKeyPrefix = null;
    clearTimeout(lastKeyPrefixTimer);
    var returnFocus = trigger || document.activeElement;
    var documentOrigin = activeOverlay && activeOverlay.documentHref === window.location.href ? activeOverlay : null;
    if (activeOverlay) {
      if (activeOverlay.element.contains(returnFocus)) returnFocus = activeOverlay.returnFocus;
      closeActiveOverlay(false, true);
    }
    returnFocus = toolbarFocusReturn(returnFocus);
    closeToolbarOptions();
    var overlay = {
      element: element,
      kind: kind,
      returnFocus: returnFocus,
      role: element.getAttribute('role'),
      ariaModal: element.getAttribute('aria-modal'),
      tabIndex: element.getAttribute('tabindex'),
      inertElements: [],
      bodyOverflow: document.body.style.overflow,
      documentOverflow: document.documentElement.style.overflow,
      documentHref: documentOrigin ? documentOrigin.documentHref : window.location.href,
      documentX: documentOrigin ? documentOrigin.documentX : window.scrollX,
      documentY: documentOrigin ? documentOrigin.documentY : window.scrollY,
      skipDocumentRestore: false
    };
    if (kind === 'mobile-nav') {
      setMobileNavigationState(true);
      element.setAttribute('role', 'dialog');
      element.setAttribute('aria-modal', 'true');
    } else {
      element.hidden = false;
    }
    if (overlay.tabIndex === null) element.setAttribute('tabindex', '-1');
    // Inert siblings at each level keep the active sheet usable even inside the shell.
    var current = element;
    while (current.parentElement) {
      var siblings = current.parentElement.children;
      for (var i = 0; i < siblings.length; i++) {
        var sibling = siblings[i];
        if (sibling === current || (kind === 'mobile-nav' && sibling.hasAttribute('data-xp-nav-backdrop'))) continue;
        overlay.inertElements.push({ element: sibling, value: sibling.getAttribute('inert') });
        sibling.setAttribute('inert', '');
      }
      current = current.parentElement;
      if (current === document.body) break;
    }
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    activeOverlay = overlay;
    overlay.closing = false;
    overlay.motion = createShellMotionController(element, kind);
    if (overlay.motion) overlay.motion.open();
    focusOverlay(overlay);
  }

  function toggleCommandPalette(forceOpen, trigger) {
    var modal = document.getElementById('xp-cmdk-modal') || document.querySelector('[data-xp-cmdk]');
    if (!modal) return;
    var shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : modal.hidden || Boolean(activeOverlay && activeOverlay.element === modal && activeOverlay.closing);
    if (shouldOpen) {
      var alreadyOpen = activeOverlay && activeOverlay.element === modal;
      openOverlay(modal, 'cmdk', trigger);
      if (!alreadyOpen && commandPalette && commandPalette.modal === modal) {
        commandPalette.input.value = '';
        commandPalette.scope = 'all';
        loadCommandHistory(commandPalette);
        renderCommandHistory(commandPalette);
        commandPalette.input.setAttribute('aria-expanded', 'true');
        filterCommandPalette();
        commandPalette.results.scrollTop = 0;
      }
    }
    else if (activeOverlay && activeOverlay.element === modal) closeActiveOverlay(true);
  }

  ${COMMAND_PALETTE_CLIENT_FUNCTIONS}

  function toggleMobileNavigation(trigger) {
    if (window.innerWidth >= 960) return;
    if (activeOverlay && activeOverlay.kind === 'mobile-nav' && !activeOverlay.closing) {
      closeActiveOverlay(true);
      return;
    }
    openOverlay(document.querySelector('[data-xp-sidebar]'), 'mobile-nav', trigger);
  }

  function trapOverlayFocus(event) {
    var overlay = activeOverlay;
    var targets = focusableElements(overlay.element);
    var first = targets[0];
    var last = targets[targets.length - 1];
    var focused = document.activeElement;
    if (!first) {
      event.preventDefault();
      overlay.element.focus({ preventScroll: true });
    } else if (event.shiftKey && (focused === first || focused === overlay.element || !overlay.element.contains(focused))) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && (focused === last || !overlay.element.contains(focused))) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  }

  function bindOverlayFocus() {
    syncResponsiveToolbar();
    document.addEventListener('focusin', function (event) {
      lastFocusedElement = event.target;
      if (activeOverlay && !activeOverlay.element.contains(event.target)) focusOverlay(activeOverlay);
    });
    document.addEventListener('focusout', function (event) {
      if (!event.relatedTarget && isVisibleElement(event.target)) lastFocusedElement = null;
    });
    window.addEventListener('resize', function () {
      syncResponsiveToolbar();
      if (window.innerWidth >= 960) {
        if (activeOverlay && activeOverlay.kind === 'mobile-nav') {
          var focused = responsiveFocusTarget();
          closeActiveOverlay(false, true);
          if (!isVisibleElement(focused)) restoreVisibleFocus(focused);
        }
        setMobileNavigationState(false);
      }
    });
  }

  function showToast(message, level) {
    if (typeof document === 'undefined') return;
    var region = document.getElementById('xp-toast-region');
    if (!region) {
      region = document.createElement('div');
      region.id = 'xp-toast-region';
      region.setAttribute('role', 'status');
      region.setAttribute('aria-live', 'polite');
      region.style.cssText = 'position:fixed;inset-block-end:20px;inset-inline-end:20px;z-index:95;display:flex;flex-direction:column;gap:10px;max-inline-size:420px;';
      document.body.appendChild(region);
    }
    var toast = document.createElement('div');
    toast.className = 'xp-card xp-toast';
    toast.setAttribute('data-toast-level', level || 'ok');
    var body = document.createElement('div');
    body.className = 'xp-toast__body';
    body.textContent = message;
    var drain = document.createElement('div');
    drain.className = 'xp-toast__drain';
    drain.setAttribute('aria-hidden', 'true');
    toast.appendChild(body);
    toast.appendChild(drain);
    region.appendChild(toast);
    setTimeout(function () {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 4000);
  }

  function xpanelApiCall(method, url, body) {
    if (typeof window.xpanelSessionRequest !== 'function') return Promise.reject(new Error('Session transport is unavailable'));
    return window.xpanelSessionRequest((method || 'POST').toUpperCase(), url, body).then(function (data) {
      showToast((data && data.message) || 'Request completed', 'ok');
      return data;
    }).catch(function (error) {
      showToast(error.message || 'Request failed', 'critical');
      throw error;
    });
  }

  function switchTabOrView(routeOrId) {
    if (typeof routeOrId !== 'string' || !routeOrId) return;
    if (routeOrId.charAt(0) === '#') {
      var targetSection = document.getElementById(routeOrId.slice(1));
      if (targetSection && typeof targetSection.scrollIntoView === 'function') {
        var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        targetSection.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
      }
      return;
    }
    var navItems = document.querySelectorAll('a[data-nav-route]');
    for (var i = 0; i < navItems.length; i++) {
      if (navItems[i].getAttribute('data-nav-route') === routeOrId) {
        navItems[i].click();
        return;
      }
    }
    var destination = new URL(routeOrId, window.location.href);
    if (destination.origin === window.location.origin) window.location.assign(destination.href);
  }

  function bindAccountCreation() {
    var form = document.querySelector('[data-create-account-form]');
    if (!form) return;
    var button = form.querySelector('button[type="submit"]');
    var feedback = form.querySelector('[data-account-create-status]');
    var password = form.querySelector('[name="password"]');
    var plan = form.querySelector('[name="planId"]');
    var assignment = form.querySelector('[name="ipAssignment"]');
    var ipFeedback = form.querySelector('[data-account-ip-status]');
    var ipAddress = form.querySelector('[data-account-ip-address]');
    var ipRefresh = form.querySelector('[data-account-ip-refresh]');
    var creationWorkspace = form.closest('[data-accounts-workspace]');
    var createAnother = creationWorkspace && creationWorkspace.querySelector('[data-approved-account-create-status] [data-account-create-another]') || form.querySelector('[data-account-create-another]');
    if (!button || !feedback || !password || !plan || !assignment || !ipFeedback || !ipAddress || !ipRefresh) return;
    var busy = false, accepted = false, dirty = false, reviewRequired = false;
    var canCreate = !button.disabled, wantedAssignment = 'shared', availability = null;
    var previewController = null, previewTimer = null, previewSequence = 0, previewPlan = null, previewOwner;
    var localActions = Array.prototype.map.call(form.querySelectorAll('[data-account-generate-password],[data-account-toggle-password],button[type="reset"]'), function (element) { return { element: element, disabled: element.disabled }; });
    var controls = Array.prototype.map.call(form.querySelectorAll('input,select'), function (control) {
      return { element: control, disabled: control.disabled, readOnly: Boolean(control.readOnly) };
    });
    function copy(message, values) { return xpT(message, values); }
    function status(message, state) {
      feedback.textContent = message; feedback.hidden = false;
      feedback.setAttribute('data-state', state);
      feedback.setAttribute('role', state === 'failed' ? 'alert' : 'status');
      var observation = creationWorkspace && creationWorkspace.querySelector('[data-account-creation-observation]');
      if (observation) observation.textContent = message + ' ' + copy('Individual host task completion has not been observed.');
    }
    function ipStatus(message, state) {
      ipFeedback.textContent = message;
      ipFeedback.setAttribute('data-state', state);
      ipFeedback.setAttribute('role', state === 'failed' ? 'alert' : 'status');
    }
    function uuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value); }
    function creationSelection(name) {
      var fields = Array.prototype.slice.call(form.querySelectorAll('[name="' + name + '"]'));
      if (!fields.length || fields.every(function (entry) { return entry.disabled || entry.closest('fieldset:disabled'); })) return undefined;
      var field = fields.find(function (entry) { return entry.type !== 'radio' || entry.checked; });
      if (!field || field.disabled || field.closest('fieldset:disabled,[aria-disabled="true"]')) throw new Error(name);
      var selected = field.value;
      if (name === 'ownerId') { if (selected !== '' && !uuid(selected)) throw new Error('ownerId'); return selected || null; }
      if (name === 'shell' && selected !== 'none' && selected !== 'jailed') throw new Error('shell');
      return selected;
    }
    function ownerContext() { try { return creationSelection('ownerId'); } catch (_error) { return 'invalid'; } }
    function ipv4(value) {
      if (typeof value !== 'string') return false;
      var parts = value.split('.');
      return parts.length === 4 && parts.every(function (part) { return /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255; });
    }
    function parseAvailability(data) {
      if (!data || data.scope !== 'desired-state' || data.hostBinding !== 'unverified' || !data.dedicated || typeof data.dedicated.entitled !== 'boolean' || !Array.isArray(data.dedicated.unallocated) || data.dedicated.unallocated.length > 4096 || data.dedicated.count !== data.dedicated.unallocated.length) throw new Error('Invalid IP availability');
      var shared = data.defaultSharedIpv4;
      if (shared !== null && (!shared || !uuid(shared.poolId) || !ipv4(shared.address))) throw new Error('Invalid shared IP availability');
      var ids = {}, addresses = {}, available = [];
      data.dedicated.unallocated.forEach(function (entry) {
        if (!entry || !uuid(entry.poolId) || ![4, 6].includes(entry.version) || typeof entry.address !== 'string' || entry.address.length > 64 || ids[entry.poolId] || addresses[entry.address] || entry.version === 4 && !ipv4(entry.address)) throw new Error('Invalid dedicated IP availability');
        ids[entry.poolId] = true; addresses[entry.address] = true;
        if (entry.version === 4) available.push({ poolId: entry.poolId, address: entry.address });
      });
      if (!data.dedicated.entitled && available.length) throw new Error('Invalid dedicated IP entitlement');
      return { shared: shared, entitled: data.dedicated.entitled, available: available };
    }
    function option(value, label, disabled) {
      var element = document.createElement('option');
      element.value = value; element.textContent = label; element.disabled = Boolean(disabled);
      return element;
    }
    function updateIpSelection() {
      var current = availability && previewPlan === plan.value && previewOwner === ownerContext() ? availability : null;
      var shared = wantedAssignment === 'shared';
      var selected = current && current.available.find(function (entry) { return wantedAssignment === 'dedicated:' + entry.poolId; });
      var available = shared ? !current || Boolean(current.shared) : Boolean(current && current.entitled && (wantedAssignment === 'dedicated:auto' ? current.available.length : selected));
      assignment.setCustomValidity(available ? '' : shared ? copy('No default shared IPv4 is configured.') : copy('This dedicated IPv4 selection is unavailable. Choose another assignment.'));
      ipAddress.textContent = current && (shared ? current.shared && current.shared.address : selected && selected.address) || '';
      ipAddress.parentElement.hidden = !ipAddress.textContent;
      if (current) ipStatus(available ? copy('Checked on the server after creation.') : assignment.validationMessage, available ? 'ready' : 'unavailable');
      return available;
    }
    function renderIpOptions() {
      var current = availability && previewPlan === plan.value && previewOwner === ownerContext() ? availability : null;
      var nodes = [option('shared', copy('Default shared'), Boolean(current && !current.shared)), option('dedicated:auto', copy('Dedicated · Automatic'), !current || !current.entitled || !current.available.length)];
      if (current) current.available.forEach(function (entry) { nodes.push(option('dedicated:' + entry.poolId, String.fromCharCode(0x2066) + entry.address + String.fromCharCode(0x2069), false)); });
      if (!nodes.some(function (entry) { return entry.value === wantedAssignment; })) nodes.push(option(wantedAssignment, copy('Dedicated selection unavailable'), true));
      assignment.replaceChildren.apply(assignment, nodes);
      assignment.value = wantedAssignment;
      assignment.disabled = !canCreate || busy || accepted || reviewRequired;
      ipRefresh.disabled = !canCreate || busy || accepted || reviewRequired;
      updateIpSelection();
    }
    function cancelPreview() {
      previewSequence++;
      if (previewController) previewController.abort();
      if (previewTimer !== null) clearTimeout(previewTimer);
      previewController = null; previewTimer = null;
    }
    function refreshIpAvailability() {
      cancelPreview();
      availability = null; previewPlan = plan.value; previewOwner = ownerContext();
      renderIpOptions();
      if (!canCreate || !plan.value || previewOwner === 'invalid' || !form.isConnected || busy || accepted || reviewRequired) {
        ipStatus(copy('IP availability unavailable.'), 'unavailable'); return;
      }
      ipStatus(copy('Loading IP availability…'), 'loading');
      if (typeof window.fetch !== 'function' || typeof AbortController !== 'function') {
        ipStatus(copy('Could not load IP availability.'), 'failed'); return;
      }
      var sequence = previewSequence, context = plan.value, owner = previewOwner, controller = new AbortController();
      previewController = controller;
      previewTimer = setTimeout(function () { controller.abort(); }, 20000);
      function current() { return sequence === previewSequence && context === plan.value && owner === ownerContext() && form.isConnected && !busy && !accepted && !reviewRequired; }
      async function readPreviewJson(response) {
        if (!response.body || typeof response.body.getReader !== 'function') { controller.abort(); throw new Error('IP availability stream unavailable'); }
        var reader = response.body.getReader(), bytes = new Uint8Array(1048576), length = 0;
        try {
          while (true) {
            var part = await reader.read();
            if (!current()) { controller.abort(); await reader.cancel(); return null; }
            if (part.done) break;
            if (!(part.value instanceof Uint8Array) || part.value.byteLength > bytes.byteLength - length) {
              controller.abort(); await reader.cancel(); throw new Error('IP availability response too large');
            }
            bytes.set(part.value, length); length += part.value.byteLength;
          }
          return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
        } catch (error) {
          controller.abort();
          await reader.cancel().catch(function () {});
          throw error;
        } finally { reader.releaseLock(); }
      }
      window.fetch('/api/ips?view=allocation&planId=' + encodeURIComponent(context) + (owner ? '&ownerId=' + encodeURIComponent(owner) : ''), { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { accept: 'application/json' }, signal: controller.signal }).then(function (response) {
        if (!current()) { controller.abort(); return null; }
        if (!response.ok) { var error = new Error('IP availability unavailable'); error.status = response.status; controller.abort(); throw error; }
        return readPreviewJson(response);
      }).then(function (data) {
        if (!current()) return;
        availability = parseAvailability(data); renderIpOptions();
      }).catch(function (error) {
        if (!current()) return;
        availability = null; renderIpOptions();
        ipStatus(error && error.status === 401 ? copy('Your session expired. Sign in again.') : error && error.status === 403 ? copy('IP availability is not permitted for this plan.') : copy('Could not load IP availability.'), 'failed');
      }).finally(function () {
        if (sequence !== previewSequence) return;
        if (previewTimer !== null) clearTimeout(previewTimer);
        previewController = null; previewTimer = null;
      });
    }
    assignment.addEventListener('change', function () {
      wantedAssignment = assignment.value; dirty = true; updateIpSelection();
    });
    plan.addEventListener('change', function () {
      dirty = true; refreshIpAvailability();
    });
    form.querySelectorAll('[name="ownerId"]').forEach(function (field) {
      field.addEventListener('change', function () { if (!busy && !accepted && !reviewRequired) { dirty = true; refreshIpAvailability(); } });
    });
    form.addEventListener('reset', function (event) {
      if (busy || accepted || reviewRequired) { event.preventDefault(); return; }
      cancelPreview();
      setTimeout(function () { if (!form.isConnected || busy || accepted || reviewRequired) return; dirty = false; wantedAssignment = 'shared'; refreshIpAvailability(); }, 0);
    });
    ipRefresh.addEventListener('click', function () { if (!busy && !accepted && !reviewRequired) refreshIpAvailability(); });
    if (createAnother) createAnother.addEventListener('click', function () {
      if (!accepted || busy || reviewRequired || createAnother.disabled) return;
      try {
        var destination = new URL(createAnother.getAttribute('data-create-route') || '', window.location.origin);
        var choices = { lang: ['en', 'ar'], theme: ['light', 'dark'], density: ['compact', 'comfortable'] };
        if (destination.origin !== window.location.origin || destination.pathname !== '/whm/accounts/new' || destination.hash || Array.from(destination.searchParams.keys()).some(function (key) { return !choices[key] || destination.searchParams.getAll(key).length !== 1 || !choices[key].includes(destination.searchParams.get(key)); })) return;
        window.location.assign(destination.pathname + destination.search);
      } catch (_error) { return; }
    });
    window.addEventListener('pagehide', cancelPreview);
    form.addEventListener('input', function () { dirty = true; });
    window.addEventListener('beforeunload', function (event) {
      if (!dirty || accepted) return;
      event.preventDefault(); event.returnValue = '';
    });
    refreshIpAvailability();
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (busy || accepted || reviewRequired || button.disabled || form.closest('[data-wiring="unavailable"],[data-wiring="soon"],[data-readonly="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled') || !updateIpSelection() || !form.reportValidity()) return;
      if (typeof window.xpanelSessionRequest !== 'function') {
        status(copy('Account creation is unavailable. No changes were made.'), 'failed'); return;
      }
      var value = function (name) { return form.querySelector('[name="' + name + '"]').value.trim(); };
      var ipAssignment = wantedAssignment === 'shared' ? { mode: 'shared' } : { mode: 'dedicated' };
      if (wantedAssignment !== 'shared' && wantedAssignment !== 'dedicated:auto') ipAssignment.poolId = wantedAssignment.slice('dedicated:'.length);
      var body = { username: value('username'), primaryDomain: value('primaryDomain'), planId: value('planId'), password: password.value, ipAssignment: ipAssignment };
      try {
        var selectedOwner = creationSelection('ownerId'), selectedShell = creationSelection('shell');
        if (selectedOwner !== undefined) body.ownerId = selectedOwner;
        if (selectedShell !== undefined) body.shell = selectedShell;
      } catch (_error) { status(copy('Choose an available owner and shell option. No changes were sent.'), 'failed'); return; }
      var contactField = form.querySelector('[name="contactEmail"]');
      var contactEmail = contactField && contactField.value ? contactField.value.trim() : '';
      if (contactEmail) body.contactEmail = contactEmail;
      var ipv6 = value('ipv6');
      if (ipv6) body.ipv6 = ipv6;
      var submittedValues = controls.map(function (state) {
        return state.element.name === 'password' ? '' : state.element.value;
      });
      var submittedChecks = controls.map(function (state) { return Boolean(state.element.checked); });
      cancelPreview();
      busy = true; button.disabled = true; form.setAttribute('aria-busy', 'true');
      ipRefresh.disabled = true;
      localActions.forEach(function (state) { state.element.disabled = true; });
      controls.forEach(function (state) { state.element.disabled = true; });
      password.value = '';
      status(copy('Submitting…'), 'loading');
      var refreshAfterRefusal = false;
      Promise.resolve().then(function () { return window.xpanelSessionRequest('POST', '/api/accounts', body); }).then(function (result) {
        var execution = result && result.execution;
        var pendingHost = execution && execution.targetVerified === false && execution.verificationRequired === true;
        var observedHost = execution && execution.targetVerified === true && execution.verificationRequired === false && execution.hostBinding === 'observed' && execution.observedAddress === result.account.ipv4;
        if (!result || !result.account || result.account.username !== body.username || (Object.hasOwn(body, 'ownerId') && result.account.ownerId !== body.ownerId) || (Object.hasOwn(body, 'shell') && result.account.shell !== body.shell) || !ipv4(result.account.ipv4) || !result.reconcile || result.reconcile.status !== 'applied' || !execution || execution.status !== 'configuration_applied' || execution.scope !== 'global_configuration' || (!pendingHost && !observedHost)) {
          reviewRequired = true;
          status(copy('The result could not be verified. Review accounts before retrying.'), 'failed'); return;
        }
        accepted = true; dirty = false;
        ipAddress.textContent = result.account.ipv4; ipAddress.parentElement.hidden = false;
        if (observedHost) {
          ipStatus(copy('This address is on the server.'), 'ready');
          status(copy('Account created.'), 'pending');
        } else {
          ipStatus(copy('This address is reserved in configuration. The server has not confirmed it is listening on the host.'), 'ready');
          status(copy('Account configuration created. Hosting verification is still required.'), 'pending');
        }
      }).catch(function (error) {
        var details = error && error.details || {};
        var serverFailed = error && (error.status === 500 || error.code === 'INTERNAL_ERROR');
        reviewRequired = Boolean(error && (error.stateChanged === true || error.verificationRequired === true || error.unknownOutcome === true || error.needsAttention === true)) || details.verificationRequired === true || details.unknownOutcome === true || details.needsAttention === true || (serverFailed || details.stateChanged !== false);
        var message = serverFailed
          ? copy('The server returned an error. The creation outcome is unverified. Review accounts before retrying.')
          : reviewRequired
          ? copy('The request could not be verified. Review accounts before retrying.')
          : copy('Account creation is unavailable. No changes were made.');
        if (!reviewRequired) {
          if (error && error.status === 401) message = copy('Your session expired. Sign in again.');
          else if (error && error.status === 403) message = copy('You do not have permission to create accounts.');
          else if (details.reason === 'shared_ipv4_unavailable' || details.reason === 'account_ipv4_unavailable') {
            message = copy('No default shared IPv4 is available. Review the IP pool.'); refreshAfterRefusal = true;
          } else if (details.reason === 'dedicated_ipv4_unavailable') {
            message = copy('No dedicated IPv4 is available. Choose another assignment.'); refreshAfterRefusal = true;
          }
        }
        status(message, 'failed');
      }).finally(function () {
        delete body.password;
        controls.forEach(function (state, index) {
          var control = state.element;
          control.value = submittedValues[index];
          if (control.type === 'radio' || control.type === 'checkbox') control.checked = submittedChecks[index];
          control.disabled = reviewRequired || (accepted && (control.tagName === 'SELECT' || control.type === 'radio' || control.type === 'checkbox')) || state.disabled;
          if (control.tagName === 'INPUT') control.readOnly = accepted || state.readOnly;
        });
        busy = false; form.setAttribute('aria-busy', 'false'); button.disabled = accepted || reviewRequired || !canCreate;
        ipRefresh.disabled = accepted || reviewRequired || !canCreate;
        if (createAnother) createAnother.disabled = !accepted || busy || reviewRequired;
        localActions.forEach(function (state) { state.element.disabled = state.disabled || accepted || reviewRequired; });
        if (refreshAfterRefusal) refreshIpAvailability();
        feedback.focus();
      });
    });
  }

  function bindAccountActions() {
    var workspace = document.querySelector('[data-accounts-workspace]');
    var dialog = workspace && workspace.querySelector('[data-account-dialog]');
    if (!dialog) return;
    var form = dialog.querySelector('[data-account-action-form]');
    var confirmation = dialog.querySelector('[data-type-to-confirm]');
    var reason = dialog.querySelector('[name="reason"]');
    var submission = dialog.querySelector('[data-account-action-submit]');
    var cancel = dialog.querySelector('[data-account-action-cancel]');
    var feedback = dialog.querySelector('[data-account-action-status]');
    var target = null, origin = null, busy = false, accepted = false;
    function copy(message, values) { return xpT(message, values); }
    function status(message, state) {
      feedback.textContent = message;
      feedback.hidden = !message;
      feedback.setAttribute('data-state', state);
      feedback.setAttribute('role', state === 'failed' ? 'alert' : 'status');
    }
    function validate() {
      submission.disabled = busy || accepted || !target || (target.action === 'terminate-account' && confirmation.value !== target.username);
    }
    function close() { if (!busy) dialog.close(); }
    function clear() {
      target = null; accepted = false; confirmation.value = ''; reason.value = ''; status('', 'idle');
      if (origin && origin.isConnected) {
        var returnTarget = origin.disabled ? origin.closest('[data-account-row]').querySelector('summary,button:not([disabled])') : origin;
        if (returnTarget) returnTarget.focus();
      }
      origin = null; validate();
    }
    confirmation.addEventListener('input', validate);
    cancel.addEventListener('click', close);
    dialog.addEventListener('cancel', function (event) { if (busy) event.preventDefault(); });
    dialog.addEventListener('close', clear);
    // A native modal keeps background content inert. Capture shortcuts while it is open.
    document.addEventListener('keydown', function (event) {
      if (!dialog.open) return;
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key === 'Tab') {
        var fields = Array.prototype.filter.call(dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),[tabindex="0"]'), function (element) { return !element.closest('[hidden]'); });
        var first = fields[0], last = fields[fields.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
      if (event.key === 'Enter' && target && target.action === 'terminate-account' && (busy || confirmation.value !== target.username)) event.preventDefault();
    }, true);
    workspace.addEventListener('click', function (event) {
      var button = event.target.closest && event.target.closest('[data-account-id][data-action]');
      if (!button || !workspace.contains(button) || busy || dialog.open) return;
      var action = button.getAttribute('data-action');
      if (['suspend-account', 'unsuspend-account', 'terminate-account'].indexOf(action) === -1) return;
      event.preventDefault();
      var id = button.getAttribute('data-account-id'), username = button.getAttribute('data-username'), domain = button.getAttribute('data-domain');
      if (!id || !username || !domain || typeof dialog.showModal !== 'function') return;
      // This target is captured from the originating row, never from the confirmation field or URL.
      target = Object.freeze({ id: id, username: username, domain: domain, action: action });
      origin = button; accepted = false; confirmation.value = ''; reason.value = ''; status('', 'idle');
      var deleting = action === 'terminate-account', suspending = action === 'suspend-account';
      dialog.querySelector('[data-account-dialog-title]').textContent = deleting ? copy('Delete account') : suspending ? copy('Suspend account') : copy('Unsuspend account');
      dialog.querySelector('[data-account-dialog-description]').textContent = deleting ? copy('Permanently removes this account and its data. This cannot be undone.') : suspending ? copy('Hosting access will be suspended for this account.') : copy('Restore hosting access for this account.');
      dialog.querySelector('[data-account-dialog-username]').textContent = username;
      dialog.querySelector('[data-account-dialog-domain]').textContent = domain;
      dialog.querySelector('[data-account-confirm-field]').hidden = !deleting;
      dialog.querySelector('[data-account-reason-field]').hidden = !suspending;
      confirmation.required = deleting;
      submission.textContent = deleting ? copy('Delete account') : suspending ? copy('Suspend') : copy('Unsuspend');
      submission.classList.toggle('xp-accounts__delete', deleting);
      validate(); dialog.showModal();
      (deleting ? confirmation : suspending ? reason : cancel).focus();
    });
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (busy || accepted || !target || (target.action === 'terminate-account' && confirmation.value !== target.username)) { validate(); return; }
      if (typeof window.xpanelSessionRequest !== 'function') { status(copy('Action unavailable. No changes were made.'), 'failed'); return; }
      var selected = target;
      var deleting = selected.action === 'terminate-account';
      var verb = selected.action === 'suspend-account' ? 'suspend' : 'unsuspend';
      var endpoint = '/api/accounts/' + encodeURIComponent(selected.id) + (deleting ? '' : '/' + verb);
      var body = deleting ? { confirmUsername: confirmation.value } : verb === 'suspend' ? { reason: reason.value.trim() } : {};
      busy = true; cancel.disabled = true; confirmation.readOnly = true; reason.readOnly = true; form.setAttribute('aria-busy', 'true'); validate();
      status(copy('Submitting…'), 'loading');
      Promise.resolve().then(function () { return window.xpanelSessionRequest(deleting ? 'DELETE' : 'POST', endpoint, body); }).then(function (result) {
        if (deleting) {
          if (!result || result.ok !== true || result.purged !== true) {
            status(copy('The result could not be verified. Review the account before retrying.'), 'failed'); return;
          }
          accepted = true;
          var removed = origin && origin.closest('[data-account-row]');
          if (removed) removed.hidden = true;
          status(copy('Account removed.'), 'pending');
          return;
        }
        var expected = verb === 'suspend' ? 'suspended' : 'active';
        var execution = result && result.execution;
        if (!result || !result.account || result.account.id !== selected.id || result.account.status !== expected || !result.reconcile || result.reconcile.status !== 'applied' || !execution || execution.status !== 'configuration_applied' || execution.scope !== 'global_configuration' || execution.targetVerified !== false || execution.verificationRequired !== true) {
          status(copy('The result could not be verified. Review the account before retrying.'), 'failed'); return;
        }
        accepted = true;
        var row = origin && origin.closest('[data-account-row]');
        var label = row && row.querySelector('[data-account-status] .xp-badge__label');
        if (label) label.textContent = copy('Verification required');
        var badge = row && row.querySelector('[data-account-status] .xp-badge');
        if (badge) {
          badge.className = 'xp-badge xp-badge--warn';
          badge.setAttribute('data-status', 'warn');
          var icon = badge.querySelector('svg');
          if (icon) icon.innerHTML = '<path d="M8 2.2L14.4 13.5H1.6L8 2.2Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 6.5V9.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="11.6" r="0.85" fill="currentColor"/>';
        }
        if (origin) origin.disabled = true;
        status(verb === 'suspend' ? copy('Account suspended. Hosting verification is still required.') : copy('Account restored. Hosting verification is still required.'), 'pending');
      }).catch(function (error) {
        var details = error && error.details || {};
        var serverFailed = error && (error.status === 500 || error.code === 'INTERNAL_ERROR');
        var message = serverFailed
          ? copy('The server could not complete this request.')
          : details.stateChanged === false ? copy('Action unavailable. No changes were made.') : copy('The request could not be verified. Review the account before retrying.');
        if (error && error.status === 401) message = copy('Your session expired. Sign in again.');
        else if (error && error.status === 403) message = copy('You do not have permission for this action.');
        else if (error && error.status === 404) message = copy('This account is no longer available.');
        else if (error && error.status === 409) message = copy('This account changed. Reload before retrying.');
        status(message, 'failed');
      }).finally(function () {
        busy = false; cancel.disabled = false; confirmation.readOnly = false; reason.readOnly = false; form.setAttribute('aria-busy', 'false');
        validate();
        feedback.focus();
      });
    });
  }

  function bindInteractiveClientActions() {
    if (typeof document === 'undefined') return;

    // Domain custom configuration (site settings): validated current-value guard + readback.
    var userdataForm = document.querySelector('[data-userdata-form]');
    if (userdataForm) {
      var udDomain = userdataForm.getAttribute('data-domain-custom-config') || '';
      var udStatus = userdataForm.querySelector('[data-userdata-status]');
      var udButton = userdataForm.querySelector('[data-action="apply-userdata"]');
      var udFields = userdataForm.querySelectorAll('textarea, button');
      var udBaseline = null;
      try { udBaseline = JSON.parse(userdataForm.getAttribute('data-userdata-baseline') || 'null'); } catch (_udError) { udBaseline = null; }
      var udBusy = false, udUncertain = false;
      var udNote = function (text, kind) { if (!udStatus) return; udStatus.hidden = !text; udStatus.dataset.state = kind; udStatus.setAttribute('role', kind === 'failed' || kind === 'uncertain' ? 'alert' : 'status'); udStatus.textContent = text; };
      var udLock = function () { var blocked = udBusy || udUncertain || !/^[0-9a-f-]{36}$/i.test(udDomain); udFields.forEach(function (node) { node.disabled = blocked; }); };
      var udValue = function (name) { var node = userdataForm.querySelector('[name="' + name + '"]'); return node ? String(node.value) : ''; };
      var udLines = function (text, separator) {
        var rows = [];
        String(text).split('\\n').forEach(function (line) {
          var trimmed = line.trim();
          if (!trimmed || trimmed.charAt(0) === '#') return;
          var at = trimmed.indexOf(separator);
          if (at <= 0) throw new Error('invalid_line');
          var key = trimmed.slice(0, at).trim(), value = trimmed.slice(at + 1).trim();
          if (!key || !value || !/^[A-Za-z0-9_.-]{1,128}$/.test(key)) throw new Error('invalid_line');
          rows.push([key, value]);
        });
        return rows;
      };
      var udBody = function () {
        var userIni = {}, headers = {}, bypass = [];
        udLines(udValue('userIni'), '=').forEach(function (pair) { if (Object.prototype.hasOwnProperty.call(userIni, pair[0])) throw new Error('duplicate_line'); userIni[pair[0]] = pair[1]; });
        udLines(udValue('customHeaders'), ':').forEach(function (pair) {
          if (pair[0].toLowerCase() === 'bypass') { bypass = pair[1].split(',').map(function (item) { return item.trim(); }).filter(Boolean); return; }
          if (!/^[A-Za-z0-9-]{1,128}$/.test(pair[0])) throw new Error('invalid_line');
          headers[pair[0]] = pair[1];
        });
        return { nginxInclude: udValue('nginxInclude'), apacheInclude: udValue('apacheInclude'), userIni: userIni, customHeaders: headers, cacheBypassPaths: bypass };
      };
      var udStable = function (value) {
        if (Array.isArray(value)) return '[' + value.map(udStable).join(',') + ']';
        if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(function (key) { return JSON.stringify(key) + ':' + udStable(value[key]); }).join(',') + '}';
        return JSON.stringify(value);
      };
      var udComparable = function (raw) {
        var config = raw && typeof raw === 'object' ? raw.config : null;
        if (!config || typeof config !== 'object') return null;
        return { nginxInclude: typeof config.nginxInclude === 'string' ? config.nginxInclude : '', apacheInclude: typeof config.apacheInclude === 'string' ? config.apacheInclude : '', userIni: config.userIni && typeof config.userIni === 'object' && !Array.isArray(config.userIni) ? config.userIni : {}, customHeaders: config.customHeaders && typeof config.customHeaders === 'object' && !Array.isArray(config.customHeaders) ? config.customHeaders : {}, cacheBypassPaths: Array.isArray(config.cacheBypassPaths) ? config.cacheBypassPaths : [] };
      };
      var udCertainRefusal = function (error) { var detail = error && error.details; return !!(error && (error.stateChanged === false || (detail && detail.stateChanged === false))) && !(detail && (detail.unknownOutcome === true || detail.verificationRequired === true)); };
      var udRequest = function (method, path, body) { return window.xpanelSessionRequest(method, path, body); };
      var udRun = function () {
        if (udBusy || udUncertain || !/^[0-9a-f-]{36}$/i.test(udDomain)) return;
        var body;
        try { body = udBody(); } catch (_udBodyError) { udNote(xpT('Each line must be "Name = value" for PHP settings or "Name: value" for headers, and the Bypass line lists comma-separated paths. Nothing was sent.'), 'failed'); return; }
        if (!udBaseline) { udNote(xpT('Current values for this domain were not read. Reload the page before saving.'), 'failed'); return; }
        udBusy = true; udLock();
        var path = '/api/domains/' + encodeURIComponent(udDomain) + '/custom-config';
        var dispatched = false;
        udNote(xpT('Reading the saved configuration before saving…'), 'reading');
        udRequest('GET', path).then(function (current) {
          var observed = udComparable(current);
          if (!observed) throw Object.assign(new Error('unread'), { stateChanged: false });
          if (udStable(observed) !== udStable(udBaseline)) return { stale: true };
          dispatched = true;
          return udRequest('PUT', path, body).then(function (saved) {
            if (!saved || typeof saved !== 'object' || !saved.config || typeof saved.config !== 'object') throw new Error('unverified');
            return udRequest('GET', path).then(function (readback) {
              var after = udComparable(readback);
              if (!after || udStable(after) !== udStable(body)) throw new Error('unverified');
              return { saved: true, baseline: after };
            });
          });
        }).then(function (outcome) {
          if (outcome && outcome.stale) { udNote(xpT('The saved custom configuration changed elsewhere. Your edits are kept; reload the page before saving again.'), 'stale'); return; }
          if (outcome && outcome.saved) {
            udBaseline = outcome.baseline;
            try { userdataForm.setAttribute('data-userdata-baseline', JSON.stringify(outcome.baseline)); } catch (_udSaveError) {}
            udNote(xpT('The requested custom configuration was saved and read back. Server-side application remains unverified.'), 'saved');
          }
        }).catch(function (error) {
          if (dispatched && !udCertainRefusal(error)) {
            udUncertain = true;
            udNote(xpT('The write outcome is uncertain. Inspect the saved configuration before retrying; no automatic retry was sent.'), 'uncertain');
            return;
          }
          var detail = error && error.details;
          if (detail && detail.rolledBack === true) {
            udNote(xpT('The configuration failed the web-service test and was rolled back. The previous configuration remains active.'), 'failed');
            return;
          }
          udNote(xpT('The request was refused or its fields could not be verified. Nothing was retried.'), 'failed');
        }).then(function () { udBusy = false; udLock(); });
      };
      if (!userdataForm.closest('[data-wiring="soon"],[data-wiring="unavailable"],[data-readonly="true"],[data-read-only="true"],[data-capability-unavailable="true"],[aria-disabled="true"],fieldset:disabled') && typeof window.xpanelSessionRequest === 'function') {
        udLock();
        if (udButton) udButton.addEventListener('click', function (event) { event.preventDefault(); if (!udButton.disabled) udRun(); });
      } else {
        udFields.forEach(function (node) { node.disabled = true; });
        udNote(xpT('Custom configuration editing is unavailable here. No changes were sent.'), 'unavailable');
      }
    }

    // Delegated click handlers for File Manager (create/chmod/restore) and action buttons
    document.addEventListener('click', function (e) {
      if (activeOverlay && activeOverlay.kind === 'cmdk' && e.target === activeOverlay.element) {
        e.preventDefault(); closeActiveOverlay(true); return;
      }
      var navigation = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (activeOverlay && navigation && activeOverlay.element.contains(navigation) &&
          ((activeOverlay.kind === 'cmdk' && navigation.hasAttribute('data-cmdk-item')) ||
           (activeOverlay.kind === 'mobile-nav' && navigation.hasAttribute('data-nav-route')))) {
        // Navigation is never held behind a presentation animation.
        closeActiveOverlay(true, true, true); return;
      }
      var target = e.target && e.target.closest ? e.target.closest('[data-action], [data-filter-chip]') : null;
      if (!target) return;

      var filterChip = target.getAttribute('data-filter-chip');
      if (filterChip) {
        var chipVal = target.getAttribute('data-filter-value') || '';
        var searchInput = document.getElementById('xmail-fts-query');
        if (searchInput && chipVal) {
          searchInput.value = (searchInput.value + ' ' + filterChip + ':' + chipVal).trim();
          showToast('Filter applied: ' + filterChip + ':' + chipVal, 'ok');
        }
        return;
      }

      var action = target.getAttribute('data-action');
      if (action === 'open-cmdk') {
        e.preventDefault();
        toggleCommandPalette(true, target);
        return;
      }
      if (action === 'close-cmdk') {
        e.preventDefault();
        toggleCommandPalette(false);
        return;
      }
      if (action === 'open-activity-drawer') {
        e.preventDefault();
        openOverlay(document.getElementById('xp-activity-drawer'), 'activity', target);
        return;
      }
      if (action === 'close-activity-drawer') {
        e.preventDefault();
        if (activeOverlay && activeOverlay.kind === 'activity') closeActiveOverlay(true);
        return;
      }
      if (action === 'toggle-mobile-nav') {
        e.preventDefault();
        toggleMobileNavigation(target);
        return;
      }
      if (action === 'close-mobile-nav') {
        e.preventDefault();
        if (activeOverlay && activeOverlay.kind === 'mobile-nav') closeActiveOverlay(true);
        return;
      }
      var apiUrl = target.getAttribute('data-api-url');
      if (action && apiUrl) {
        e.preventDefault();
        xpanelApiCall('POST', apiUrl, { action: action }).catch(function () {});
        return;
      }
    });
  }

  function isEditableTarget(target) {
    if (!target || !target.tagName) return false;
    var tag = target.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable;
  }

  function bindKeyboardShortcuts() {
    if (typeof document === 'undefined') return;
    document.addEventListener('keydown', function (e) {
      if (e.isComposing) return;
      // Cmd/Ctrl+K -> Quick-bar Command Palette
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        toggleCommandPalette();
        return;
      }

      if (activeOverlay && e.key === 'Escape') {
        e.preventDefault();
        closeActiveOverlay(true);
        return;
      }

      if (activeOverlay) {
        if (activeOverlay.kind === 'cmdk' && handleCommandPaletteKey(e)) return;
        if (e.key === 'Tab') trapOverlayFocus(e);
        return;
      }

      if (e.key === 'Escape' && closeFocusedToolbar(e.target)) {
        e.preventDefault();
        return;
      }

      if (isEditableTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey || e.repeat) {
        lastKeyPrefix = null;
        clearTimeout(lastKeyPrefixTimer);
        return;
      }

      // '/' -> Focus filter or search input
      if (e.key === '/') {
        var filterInput = Array.prototype.find.call(
          document.querySelectorAll('[data-xp-filter-input], input[type="search"]'),
          function (target) { return !target.disabled && target.tabIndex >= 0 && isVisibleElement(target); }
        );
        if (filterInput) {
          e.preventDefault();
          filterInput.focus({ preventScroll: true });
        } else if (document.getElementById('xp-cmdk-modal') || document.querySelector('[data-xp-cmdk]')) {
          e.preventDefault();
          toggleCommandPalette(true);
        }
        return;
      }

      // Chord shortcuts: 'g d' (dashboard), 'g a' (accounts), 'g f' (files)
      var key = e.key.toLowerCase();
      if (key === 'g') {
        lastKeyPrefix = 'g';
        clearTimeout(lastKeyPrefixTimer);
        lastKeyPrefixTimer = setTimeout(function () {
          lastKeyPrefix = null;
        }, 900);
        return;
      }

      if (lastKeyPrefix === 'g') {
        lastKeyPrefix = null;
        clearTimeout(lastKeyPrefixTimer);
        var routes = key === 'd' ? ['/home', '/whm', '/mail/inbox'] : key === 'a' ? ['/whm/accounts'] : key === 'f' ? ['/files/manager'] : [];
        var navLinks = document.querySelectorAll('[data-xp-sidebar] a[data-nav-route]');
        var navTarget = Array.prototype.find.call(navLinks, function (link) { return routes.indexOf(link.getAttribute('data-nav-route')) !== -1 && !link.closest('[hidden], [inert]'); });
        if (navTarget && typeof navTarget.click === 'function') {
          e.preventDefault();
          navTarget.click();
        }
      }
    });
  }

  function ensurePromptDialog() {
    var dialog = document.querySelector('[data-xp-prompt]');
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.className = 'xp-dialog';
    dialog.setAttribute('data-xp-prompt', '');
    var form = document.createElement('form');
    form.method = 'dialog';
    form.className = 'xp-form-group';
    form.innerHTML = '<div class="xp-dialog__header"><h2 data-xp-prompt-title></h2><p data-xp-prompt-body></p></div>' +
      '<div class="xp-field" data-xp-prompt-field><label class="xp-label" for="xp-prompt-input" data-xp-prompt-label style="padding-inline-start: var(--xp-control-content-inset)"></label>' +
      '<input id="xp-prompt-input" class="xp-input" data-xp-prompt-input autocomplete="off"></div>' +
      '<div class="xp-dialog__footer">' +
      '<button type="button" class="xp-btn" value="cancel" data-xp-prompt-cancel></button>' +
      '<button type="submit" class="xp-btn xp-btn--primary" value="confirm" data-xp-prompt-confirm></button>' +
      '</div>';
    dialog.appendChild(form);
    document.body.appendChild(dialog);
    dialog.addEventListener('click', function (event) {
      if (event.target === dialog) dialog.close('cancel');
    });
    dialog.querySelector('[data-xp-prompt-cancel]').addEventListener('click', function () {
      dialog.close('cancel');
    });
    dialog.querySelector('form').addEventListener('submit', function (event) {
      event.preventDefault();
      var field = dialog.querySelector('[data-xp-prompt-field]');
      var input = dialog.querySelector('[data-xp-prompt-input]');
      var entered = input && typeof input.value === 'string' ? input.value : '';
      if (!dialog._xpPreserveWhitespace) entered = entered.trim();
      if (field && !field.hidden && !entered) {
        input.focus();
        return;
      }
      dialog._xpValue = !field || field.hidden ? true : entered;
      dialog.close('confirm');
    });
    dialog.addEventListener('close', function () {
      var pending = dialog._xpResolve;
      dialog._xpResolve = null;
      if (pending) pending(dialog.returnValue === 'confirm' ? dialog._xpValue : null);
    });
    return dialog;
  }

  function askDialog(options) {
    var dialog = ensurePromptDialog();
    dialog.querySelector('[data-xp-prompt-title]').textContent = options.title || '';
    dialog.querySelector('[data-xp-prompt-body]').textContent = options.body || '';
    var field = dialog.querySelector('[data-xp-prompt-field]');
    var input = dialog.querySelector('[data-xp-prompt-input]');
    var label = dialog.querySelector('[data-xp-prompt-label]');
    field.hidden = !options.input;
    label.textContent = options.label || '';
    input.value = options.value || '';
    dialog._xpPreserveWhitespace = options.preserveWhitespace === true;
    input.type = options.secret ? 'password' : 'text';
    input.required = false;
    dialog.querySelector('[data-xp-prompt-cancel]').textContent = options.cancel || (xpT('Cancel'));
    var confirm = dialog.querySelector('[data-xp-prompt-confirm]');
    confirm.textContent = options.confirm || (xpT('Confirm'));
    confirm.className = options.danger ? 'xp-btn xp-btn--danger' : 'xp-btn xp-btn--primary';
    dialog._xpValue = null;
    return new Promise(function (resolve) {
      dialog._xpResolve = function (value) {
        resolve(options.input ? (typeof value === 'string' && value ? value : null) : Boolean(value));
      };
      try { dialog.showModal(); }
      catch (_err) { dialog.setAttribute('open', ''); }
      var focusTarget = options.input ? input : confirm;
      if (focusTarget && typeof focusTarget.focus === 'function') focusTarget.focus();
    });
  }

  function bindPhaseOneTools() {
    ${PASSWORD_GENERATOR_CLIENT_BINDING}
    (${APPROVED_WHM_OPERATIONS_TABS_CLIENT})();
    (${APPROVED_WHM_TABLE_FILTERS_CLIENT})();
    if (typeof window.xpanelSessionRequest !== 'function') return;
    var rtl = document.documentElement.dir === 'rtl';
    (${APPROVED_WORKSPACE_FORMS_CLIENT})(askDialog);
    (${ACCOUNT_FORWARDERS_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_FILTERS_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_MAILING_LISTS_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_SPAM_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_SESSIONS_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_SSL_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_CONTACT_CLIENT_BINDING})(askDialog, rtl);
    (${ACCOUNT_BACKUP_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_CRON_CLIENT_BINDING})(askDialog);
    (${ACCT_STAGING_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_WEB_DIRECTIVES_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_SSH_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_TEAM_CLIENT_BINDING})(askDialog, rtl);
    (${ACCOUNT_LOGS_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_VIRUS_SCAN_CLIENT_BINDING})(askDialog);
    (${SEC_SECURITY_CLIENT_BINDING})(askDialog);
    (${SEC_DNS_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_NETWORK_TOOLS_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_DATABASE_INSIGHTS_CLIENT_BINDING})(askDialog);
    (${SITE_HEALTH_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_ANNOUNCEMENTS_CLIENT_BINDING})();
    (${ACCOUNT_HTACCESS_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_QUARANTINE_CLIENT_BINDING})(askDialog);
    (${DOMAIN_WORKSPACE_CLIENT_BINDING})(askDialog);
    (${DATABASE_WORKSPACE_CLIENT_BINDING})(askDialog);
    (${MAIL_FOLDER_WORKSPACE_CLIENT_BINDING})(askDialog, rtl);
    (${MAIL_CONTACTS_WORKSPACE_CLIENT_BINDING})(askDialog);
    (${MAIL_CONTACT_GROUPS_CLIENT_BINDING})(askDialog);
    (${MAIL_CONTACTS_TOOLS_CLIENT_BINDING})(askDialog);
    (${MAIL_IDENTITIES_CLIENT_BINDING})(askDialog);
    (${MAIL_VACATION_WORKSPACE_CLIENT_BINDING})(askDialog);
    (${MAIL_CALENDAR_CLIENT_BINDING})(askDialog);
    (${MAIL_CALENDAR_VIEW_CLIENT_BINDING})(askDialog);
    // Selection is UI context only; the attachment API independently authenticates every read.
    var bindMailAttachments = (${MAIL_ATTACHMENTS_CLIENT_BINDING});
    bindMailAttachments(askDialog);
    if (document.documentElement.dataset.mailSearchAttachmentsBound !== 'true') {
      document.documentElement.dataset.mailSearchAttachmentsBound = 'true';
      function applyMailAttachmentSelection(article, selection) {
        if (typeof selection.mailbox !== 'string' || !selection.mailbox
          || typeof selection.folder !== 'string' || selection.folder !== selection.folder.trim() || !/^[A-Za-z][A-Za-z0-9._-]{0,40}$/.test(selection.folder)
          || !Number.isInteger(selection.uid) || selection.uid < 1 || selection.uid > 4294967295
          || !Number.isInteger(selection.uidValidity) || selection.uidValidity < 1 || selection.uidValidity > 4294967295) return;
        var matched = false;
        article.querySelectorAll('[data-mail-attachments]').forEach(function (root) {
          if (root.closest('[data-mail-search-message],[data-mail-article="true"]') !== article || root.getAttribute('data-mailbox') !== selection.mailbox) return;
          matched = true;
          [['data-folder', selection.folder], ['data-uid', String(selection.uid)], ['data-uid-validity', String(selection.uidValidity)]].forEach(function (attribute) {
            if (root.getAttribute(attribute[0]) !== attribute[1]) root.setAttribute(attribute[0], attribute[1]);
          });
        });
        if (matched) bindMailAttachments(askDialog);
      }
      document.addEventListener('xpanel:mail-search-selection', function (event) {
        var selection = event.detail, article = event.target;
        if (!(article instanceof Element) || !article.matches('[data-mail-search-message]') || !article.isConnected || !selection || typeof selection !== 'object') return;
        var workspace = article.closest('[data-mail-search-workspace]');
        if (!workspace || workspace.getAttribute('data-search-mailbox') !== selection.mailbox || workspace.getAttribute('data-search-enabled') !== 'true') return;
        applyMailAttachmentSelection(article, selection);
      });
      document.addEventListener('xpanel:mail-message-read', function (event) {
        var selection = event.detail, article = event.target;
        if (!(article instanceof Element) || !article.matches('[data-mail-pane="reading-pane"][data-mail-article="true"]') || !article.isConnected || !selection || typeof selection !== 'object' || selection.uidValidityObserved !== true) return;
        var workspace = article.closest('[data-board-port="xmail-inbox"][data-product="true"]');
        if (!workspace || workspace.getAttribute('data-mailbox') !== selection.mailbox || workspace.getAttribute('data-mail-folder') !== selection.folder
          || workspace.querySelector('[data-mail-pane="reading-pane"][data-mail-article="true"]') !== article) return;
        applyMailAttachmentSelection(article, selection);
      });
    }
    (${MAIL_SEARCH_CLIENT_BINDING})(askDialog);
    (${MAIL_TRACK_DELIVERY_CLIENT_BINDING})();
    (${MAIL_FOLDERS_CLIENT_BINDING})();
    (${MAIL_DISK_USAGE_CLIENT_BINDING})();
    (${MAIL_CONNECT_DEVICES_CLIENT_BINDING})();
    (${MAIL_MAILBOX_FORWARDERS_CLIENT_BINDING})(askDialog);
    (${MAIL_MAILBOX_PREFERENCES_CLIENT_BINDING})(askDialog);
    (${MAIL_COMPOSE_IDENTITIES_CLIENT_BINDING})(askDialog);
    (${MAIL_COMPOSE_ATTACHMENTS_CLIENT_BINDING})(askDialog);
    (${MAIL_DRAFT_CLIENT_BINDING})();
    (${ZONE_EDITOR_CLIENT_BINDING})(askDialog);
    (${DIRECTORY_PRIVACY_CLIENT_BINDING})(askDialog);
    function note(el, message) { if (!el) return; el.hidden = false; el.textContent = message; }
    function dialogInput(selector, name) {
      var dialog = document.querySelector(selector);
      return dialog ? dialog.querySelector('[name="' + name + '"]') : null;
    }
    function failText(error) {
      var details = error && error.details;
      return error && error.message ? xpT(error.message) : xpT('The request could not be completed.');
    }
    function reload() { window.location.reload(); }
    document.querySelectorAll('[data-certificate-form]').forEach(function (form) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var status = form.querySelector('[data-certificate-status]');
        var username = form.getAttribute('data-account-username');
        var domain = form.querySelector('[name="domain"]').value;
        var button = form.querySelector('button[type="submit"]');
        if (button) button.disabled = true;
        note(status, xpT('Issuing the certificate. This can take about a minute.'));
        window.xpanelSessionRequest('POST', '/api/accounts/' + username + '/certificates', { domain: domain }).then(function () {
          note(status, xpT('The certificate authority issued the certificate. Reloading stored state.'));
          reload();
        }).catch(function (error) {
          if (button) button.disabled = false;
          note(status, failText(error));
        });
      });
    });
    document.querySelectorAll('[data-mailbox-form]').forEach(function (form) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var status = form.querySelector('[data-mailbox-status]');
        var body = {
          localPart: form.querySelector('[name="localPart"]').value.trim().toLowerCase(),
          domainId: form.querySelector('[name="domainId"]').value,
          password: form.querySelector('[name="password"]').value,
          mailboxQuotaMb: Number(form.querySelector('[name="mailboxQuotaMb"]').value),
          services: { email: true, ftp: false, webdisk: false },
        };
        window.xpanelSessionRequest('POST', '/api/service-users', body).then(reload).catch(function (error) { note(status, failText(error)); });
      });
    });
    function bindToolDialog(selector, onOpen) {
      var dialog = document.querySelector(selector);
      if (!dialog || typeof dialog.showModal !== 'function') return;
      var form = dialog.querySelector('form');
      var status = dialog.querySelector('[data-dialog-status]');
      var cancel = dialog.querySelector('[data-dialog-cancel]');
      var busy = false;
      var run = function () { return Promise.resolve(); };
      function show(message, state) {
        if (!status) return;
        status.hidden = !message;
        status.textContent = message || '';
        status.setAttribute('data-state', state || 'idle');
      }
      if (cancel) cancel.addEventListener('click', function () { if (!busy) dialog.close(); });
      dialog.addEventListener('close', function () { busy = false; show('', 'idle'); });
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        if (busy || (typeof form.reportValidity === 'function' && !form.reportValidity())) return;
        busy = true;
        show(xpT('Submitting…'), 'loading');
        Promise.resolve().then(run).then(function () {
          show(xpT('Saved.'), 'pending');
          reload();
        }).catch(function (error) {
          busy = false;
          show(failText(error), 'failed');
        });
      });
      onOpen(function (next) {
        run = next;
        show('', 'idle');
        dialog.showModal();
      });
    }
    bindToolDialog('[data-mailbox-password-dialog]', function (open) {
      document.querySelectorAll('[data-mailbox-password]').forEach(function (button) {
        button.addEventListener('click', function () {
          var input = dialogInput('[data-mailbox-password-dialog]', 'password');
          if (input) input.value = '';
          open(function () {
            var password = input ? input.value : '';
            return window.xpanelSessionRequest('PATCH', '/api/service-users/' + button.getAttribute('data-mailbox-password'), { password: password });
          });
        });
      });
    });
    bindToolDialog('[data-mailbox-quota-dialog]', function (open) {
      document.querySelectorAll('[data-mailbox-quota]').forEach(function (button) {
        button.addEventListener('click', function () {
          var input = dialogInput('[data-mailbox-quota-dialog]', 'mailboxQuotaMb');
          if (input) input.value = button.getAttribute('data-mailbox-quota-value') || '';
          open(function () {
            return window.xpanelSessionRequest('PATCH', '/api/service-users/' + button.getAttribute('data-mailbox-quota'), { mailboxQuotaMb: Number(input.value) });
          });
        });
      });
    });
    document.querySelectorAll('[data-remove-mailbox]').forEach(function (button) {
      button.addEventListener('click', function () {
        askDialog({
          title: xpT('Delete mailbox'),
          body: xpT('This mailbox will be deleted. This cannot be undone.'),
          confirm: xpT('Delete'),
          danger: true,
        }).then(function (ok) {
          if (!ok) return;
          window.xpanelSessionRequest('DELETE', '/api/service-users/' + button.getAttribute('data-remove-mailbox')).then(reload).catch(function (error) { note(button.parentElement, failText(error)); });
        });
      });
    });
    document.querySelectorAll('[data-database-form]').forEach(function (form) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var status = form.querySelector('[data-database-status]');
        var username = form.getAttribute('data-account-username');
        window.xpanelSessionRequest('POST', '/api/databases', { name: username + '_' + form.querySelector('[name="name"]').value.trim().toLowerCase() }).then(reload).catch(function (error) { note(status, failText(error)); });
      });
    });
    document.querySelectorAll('[data-database-user-form]').forEach(function (form) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var status = form.querySelector('[data-database-user-status]');
        var database = form.querySelector('[name="databaseId"]');
        window.xpanelSessionRequest('POST', '/api/databases/users', {
          name: form.querySelector('[name="name"]').value.trim().toLowerCase(),
          password: form.querySelector('[name="password"]').value,
          databaseId: database ? database.value : undefined,
          privileges: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
        }).then(reload).catch(function (error) { note(status, failText(error)); });
      });
    });
    document.querySelectorAll('[data-remove-database-user]').forEach(function (button) {
      button.addEventListener('click', function () {
        window.xpanelSessionRequest('DELETE', '/api/databases/users/' + button.getAttribute('data-remove-database-user')).then(reload).catch(function (error) { note(button.parentElement, failText(error)); });
      });
    });
    document.querySelectorAll('[data-account-contact-form]').forEach(function (form) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var status = form.querySelector('[data-account-contact-status]');
        window.xpanelSessionRequest('PATCH', '/api/accounts/' + form.getAttribute('data-account-id'), { contactEmail: form.querySelector('[name="contactEmail"]').value.trim() }).then(reload).catch(function (error) { note(status, failText(error)); });
      });
    });
    document.querySelectorAll('[data-account-password-form]').forEach(function (form) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var status = form.querySelector('[data-account-password-status]');
        var password = form.querySelector('[name="password"]').value;
        form.querySelector('[name="password"]').value = '';
        window.xpanelSessionRequest('POST', '/api/accounts/' + form.getAttribute('data-account-id') + '/password', { password: password }).then(reload).catch(function (error) { note(status, failText(error)); });
      });
    });
    document.querySelectorAll('[data-mail-ip-config-form]').forEach(function (form) {
      var save = form.querySelector('button[type="submit"]');
      var status = form.querySelector('[data-mail-ip-status]');
      var keys = ['mode', 'defaultIpv4', 'defaultIpv6', 'defaultHelo'];
      var modes = ['server-default', 'account-ip', 'domain-ip', 'custom-map'];
      var editable = form.getAttribute('data-mail-ip-editable') === 'true';
      if (!save || !status || !keys.every(function (key) { return form.querySelector('[name="' + key + '"]'); })) return;
      var busy = false, reviewRequired = false;
      function read() {
        var values = {};
        keys.forEach(function (key) { values[key] = form.querySelector('[name="' + key + '"]').value.trim(); });
        return values;
      }
      function normalize(value) { return value == null ? '' : String(value); }
      function comparable(key, value) {
        var text = normalize(value);
        if (!text) return '';
        try {
          if (key === 'defaultIpv6') return new URL('http://[' + text + ']/').hostname;
          if (key === 'defaultHelo') { var hostname = new URL('http://' + text + '/').hostname; return hostname.endsWith('.') ? hostname.slice(0, -1) : hostname; }
        } catch (_) { return text; }
        return text;
      }
      function validConfig(config) {
        return config && modes.indexOf(config.mode) >= 0 && keys.slice(1).every(function (key) { return config[key] === null || typeof config[key] === 'string'; })
          && Array.isArray(config.domainOverrides) && config.domainOverrides.length <= 2048
          && config.domainOverrides.every(function (item) { return item && typeof item.domainName === 'string' && item.domainName.length > 0 && ['ipv4', 'ipv6', 'heloHostname'].every(function (key) { return item[key] === null || typeof item[key] === 'string'; }); });
      }
      var baseline = read();
      function changed(values) { return keys.filter(function (key) { return values[key] !== baseline[key]; }); }
      function refresh() { save.disabled = !editable || busy || reviewRequired || changed(read()).length === 0; }
      function mailNote(message, state) { note(status, message); status.setAttribute('data-state', state); status.setAttribute('role', state === 'failed' ? 'alert' : 'status'); }
      form.addEventListener('input', refresh);
      form.addEventListener('change', refresh);
      window.addEventListener('beforeunload', function (event) {
        if (changed(read()).length === 0 && !reviewRequired) return;
        event.preventDefault(); event.returnValue = '';
      });
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var desired = read(), edits = changed(desired);
        if (!editable || busy || reviewRequired || edits.length === 0 || !form.reportValidity() || modes.indexOf(desired.mode) < 0) return;
        var controls = Array.prototype.map.call(form.querySelectorAll('input,select,button'), function (control) { return { control: control, disabled: control.disabled }; });
        var wrote = false, submitted;
        busy = true; form.setAttribute('aria-busy', 'true'); controls.forEach(function (item) { item.control.disabled = true; });
        mailNote(xpT('Checking current settings…'), 'loading');
        Promise.resolve().then(function () { return window.xpanelSessionRequest('GET', '/api/mail/ips'); }).then(function (current) {
          var config = current && current.config;
          if (!validConfig(config)) throw { mailIpState: 'unread' };
          if (edits.some(function (key) { return comparable(key, config[key]) !== comparable(key, baseline[key]) && comparable(key, config[key]) !== comparable(key, desired[key]); })) throw { mailIpState: 'conflict' };
          submitted = { mode: config.mode, defaultIpv4: config.defaultIpv4, defaultIpv6: config.defaultIpv6, defaultHelo: config.defaultHelo, domainOverrides: config.domainOverrides };
          edits.forEach(function (key) { submitted[key] = key === 'mode' ? desired[key] : desired[key] || null; });
          wrote = true;
          mailNote(xpT('Saving…'), 'loading');
          return window.xpanelSessionRequest('PUT', '/api/mail/ips', submitted);
        }).then(function (result) {
          var saved = result && result.config;
          var overrides = validConfig(saved) ? new Map(saved.domainOverrides.map(function (item) { return [item.domainName, item]; })) : null;
          var matches = overrides && keys.every(function (key) { return comparable(key, saved[key]) === comparable(key, submitted[key]); }) && saved.domainOverrides.length === submitted.domainOverrides.length
            && overrides.size === submitted.domainOverrides.length && submitted.domainOverrides.every(function (item) { var found = overrides.get(item.domainName); return found && ['ipv4', 'ipv6', 'heloHostname'].every(function (key) { return found[key] === item[key]; }); });
          if (!matches) {
            reviewRequired = true;
            mailNote(xpT('The result could not be verified. Review mail settings before retrying.'), 'failed');
            return;
          }
          keys.forEach(function (key) { form.querySelector('[name="' + key + '"]').value = normalize(saved[key]); });
          var mapText = form.querySelector('[data-mail-ip-overrides]');
          if (mapText) mapText.textContent = saved.domainOverrides.map(function (item) { return [item.domainName, item.ipv4, item.ipv6, item.heloHostname].filter(Boolean).join(' · '); }).join(String.fromCharCode(10)) || (xpT('No domain overrides are configured.'));
          baseline = read();
          mailNote(xpT('Mail settings saved. Delivery verification is not confirmed.'), 'pending');
        }).catch(function (error) {
          reviewRequired = wrote && (error && error.details && (error.details.stateChanged === true || error.details.verificationRequired === true) || [400, 401, 403, 404, 409, 412, 422].indexOf(error && error.status) < 0);
          var message = error && error.mailIpState === 'conflict' ? (xpT('Mail settings changed since this form loaded. Reload and review them.'))
            : !wrote ? (xpT('Current mail settings could not be read. No changes were sent.'))
            : reviewRequired ? (xpT('The result is uncertain. Review mail settings before retrying.'))
            : (xpT('Mail settings were refused. Review the values and permissions.'));
          mailNote(message, 'failed');
        }).finally(function () {
          busy = false; form.removeAttribute('aria-busy'); controls.forEach(function (item) { item.control.disabled = item.disabled; }); refresh();
        });
      });
      refresh();
    });
    bindToolDialog('[data-database-delete-dialog]', function (open) {
      document.querySelectorAll('[data-remove-database]').forEach(function (button) {
        button.addEventListener('click', function () {
          var name = document.querySelector('[data-database-delete-name]');
          if (name) name.textContent = button.getAttribute('data-database-name') || '';
          open(function () {
            return window.xpanelSessionRequest('DELETE', '/api/databases/' + button.getAttribute('data-remove-database'));
          });
        });
      });
    });
    bindToolDialog('[data-plan-delete-dialog]', function (open) {
      document.querySelectorAll('[data-plan-delete]').forEach(function (button) {
        button.addEventListener('click', function () {
          open(function () {
            return window.xpanelSessionRequest('DELETE', '/api/plans/' + button.getAttribute('data-plan-delete'));
          });
        });
      });
    });
    (${FILE_WORKSPACE_CLIENT_BINDING})(askDialog);
    ${MAIL_SEND_CLIENT_BINDING}
    document.querySelectorAll('[data-reseller-create-form]').forEach(function (form) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var status = form.querySelector('[data-reseller-status]');
        var acl = [];
        form.querySelectorAll('[name="acl"]:checked').forEach(function (box) { acl.push(box.value); });
        var body = {
          username: form.querySelector('[name="username"]').value.trim().toLowerCase(),
          password: form.querySelector('[name="password"]').value,
          maxAccounts: Number(form.querySelector('[name="maxAccounts"]').value),
          totalDiskMb: Number(form.querySelector('[name="totalDiskMb"]').value),
          totalBandwidthMb: Number(form.querySelector('[name="totalBandwidthMb"]').value),
          oversell: !!form.querySelector('[name="oversell"]').checked,
          nameservers: [],
          delegatedIps: [],
          acl: acl,
        };
        form.querySelector('[name="password"]').value = '';
        window.xpanelSessionRequest('${xwhmPageAdapters.resellers.create.method}', '${xwhmPageAdapters.resellers.create.path}', body).then(reload).catch(function (error) { note(status, failText(error)); });
      });
    });
    (${WHM_DNS_CLIENT_BINDING})(askDialog);
    (${WHM_DOMAINS_CLIENT_BINDING})(askDialog);
    (${WHM_DEFAULT_SITE_CLIENT_BINDING})(askDialog);
    (${WHM_BACKUPS_CLIENT_BINDING})(askDialog);
    (${WHM_SSL_CLIENT_BINDING})(askDialog);
    (${WHM_SSL_INSTALL_CLIENT_BINDING})(askDialog);
    (${WHM_SECURITY_CLIENT_BINDING})();
    (${WHM_SSH_CLIENT_BINDING})(askDialog);
    (${WHM_PHP_CLIENT_BINDING})(askDialog);
    (${WHM_FIREWALL_CLIENT_BINDING})(askDialog);
    (${WHM_MAIL_QUEUE_CLIENT_BINDING})(askDialog);
    (${WHM_SERVICE_DETAIL_CLIENT_BINDING})(askDialog);
    (${WHM_DNS_TOOLS_CLIENT_BINDING})(askDialog);
    (${WHM_SECURITY_TOOLS_CLIENT_BINDING})(askDialog);
    (${SEC_SECURITY_CLIENT_BINDING})(askDialog);
    (${SEC_DNS_CLIENT_BINDING})(askDialog);
    (${WHM_UPDATES_CLIENT_BINDING})(askDialog);
    (${WHM_REPAIR_CLIENT_BINDING})(askDialog);
    (${WHM_ACCOUNT_HEALTH_CLIENT_BINDING})();
    (${WHM_BACKUP_FILES_CLIENT_BINDING})();
    (${ACCT_RESTORE_CLIENT_BINDING})();
    (${WHM_JOBS_CLIENT_BINDING})(askDialog);
    (${WHM_PANEL_TOKENS_CLIENT_BINDING})(askDialog);
    (${WHM_PANEL_NOTIFICATIONS_CLIENT_BINDING})();
    (${WHM_ANNOUNCEMENTS_CLIENT_BINDING})(askDialog);
    (${WHM_BACKUP_RUNS_CLIENT_BINDING})(askDialog);
    (${ACCT_TRANSFER_CREDENTIALS_CLIENT_BINDING})(askDialog);
    (${ACCT_CONVERT_ADDON_CLIENT_BINDING})(askDialog);
    (${WHM_ACCOUNT_TEMPLATES_CLIENT_BINDING})(askDialog, rtl);
    (${WHM_ENHANCEMENTS_CLIENT_BINDING})(askDialog);
    (${WHM_SOFTWARE_CENTER_CLIENT_BINDING})(askDialog);
    (${WHM_DATABASES_CLIENT_BINDING})(askDialog);
    (${WHM_DATABASE_TUNING_CLIENT_BINDING})();
    (${WHM_PREFERENCES_CLIENT_BINDING})();
    (${WHM_PANEL_SETTINGS_CLIENT_BINDING})(askDialog);
    (${WHM_PANEL_BRANDING_CLIENT_BINDING})(askDialog);
    (${WHM_LANGUAGES_CLIENT_BINDING})(askDialog);
    (${WHM_WHMCS_CLIENT_BINDING})(askDialog);
    (${WHM_SERVICE_MANAGER_CLIENT_BINDING})(askDialog);
    (${WHM_CONFIGURATION_HEALTH_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_PACKAGES_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_DATABASE_REMOTE_CLIENT_BINDING})(askDialog);
    (${DB_ENGINES_CLIENT_BINDING})(askDialog, rtl);
    (${ACCOUNT_COLLABORATION_CLIENT_BINDING})(askDialog);
    (${WHM_DEVELOPER_CLIENT_BINDING})();
    (${WHM_TRUSTED_PROXIES_CLIENT_BINDING})();
    (${WHM_BACKUP_DESTINATIONS_CLIENT_BINDING})(askDialog);
    (${MAIL_TOOLS_CLIENT_BINDING})(askDialog);
    (${MAIL_SPAM_CLIENT_BINDING})(askDialog);
    (${MAIL_MAILING_LISTS_CLIENT_BINDING})(askDialog);
    (${WHM_BENCHMARK_CLIENT_BINDING})();
    (${WHM_TRAFFIC_CLIENT_BINDING})();
    (${WHM_METERING_CLIENT_BINDING})();
    (${WHM_DEFAULT_INDEX_CLIENT_BINDING})(askDialog);
    (${WHM_COMPOSER_CLIENT_BINDING})(askDialog);
    (${SW_CONTAINERS_CLIENT_BINDING})(askDialog);
    (${SW_ADDON_SERVICES_CLIENT_BINDING})(askDialog);
    (${SW_DEPLOYMENTS_CLIENT_BINDING})(askDialog);
    (${SW_APP_PROJECTS_CLIENT_BINDING})();
    (${SW_OPTIMIZE_CLIENT_BINDING})();
    (${SW_APPLICATIONS_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_RUNTIME_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_DYNAMIC_DNS_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_SITE_PUBLISHER_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_GIT_CLIENT_BINDING})(askDialog);
    (${ACCOUNT_PGP_CLIENT_BINDING})(askDialog);
    (${WHM_MAIL_LOG_CLIENT_BINDING})();
    (${WHM_FTP_LOG_CLIENT_BINDING})();
    (${WHM_MAIL_SERVER_CLIENT_BINDING})();
    (${MAILX_WHM_CLIENT_BINDING})();
    (${MAILX_ARCHIVE_CLIENT_BINDING})(askDialog);
    (${MAILX_COLLECTIONS_CLIENT_BINDING})(askDialog);
    (${MAILX_MAIL_TOOLS_CLIENT_BINDING})(askDialog);
    (${WHM_MAIL_QUALITY_CLIENT_BINDING})();
    (${WHM_MAILBOX_MAINTENANCE_CLIENT_BINDING})(askDialog);
    (${WHM_UPGRADE_CLIENT_BINDING})();
    (${WHM_MONITORING_CLIENT_BINDING})(askDialog);
    (${WHM_SERVER_OBSERVATION_CLIENT_BINDING})();
    (${OPS_FILE_SHARING_CLIENT_BINDING})(askDialog);
    (${OPS_TERMINAL_CLIENT_BINDING})();
    (${OPS_NODES_CLIENT_BINDING})();
    (${OPS_INTEGRATIONS_CLIENT_BINDING})();
    (${WHM_SERVER_HEALTH_CLIENT_BINDING})();
    (${WHM_SUPPORT_CLIENT_BINDING})();
    (${WHM_MONITORING_ALERTS_CLIENT_BINDING})();
    (${WHM_WEB_SERVER_CLIENT_BINDING})(askDialog);
    (${WHM_TRANSFER_CLIENT_BINDING})(askDialog);
    (${APPROVED_HOST_SERVICES_CLIENT})(askDialog);
    (${WHM_SERVER_INFO_CLIENT_BINDING})();
    (${WHM_IPS_CLIENT_BINDING})(askDialog);
    (${WHM_PANEL_DATA_CLIENT_BINDING})(askDialog);
    var backupRoot = document.querySelector('[data-account-backups]');
    if (backupRoot) {
      var backupAccount = backupRoot.querySelector('[data-backup-account]');
      var backupFiles = backupRoot.querySelector('[data-backup-files]');
      var backupStatus = backupRoot.querySelector('[data-backup-status]');
      function loadBackups() {
        if (!backupAccount.value) { backupFiles.textContent = ''; return Promise.resolve(); }
        return window.xpanelSessionRequest('GET', '${xwhmPageAdapters.backups.listPrefix}' + backupAccount.value).then(function (data) {
          backupFiles.textContent = '';
          (data.backups || []).forEach(function (item) {
            var row = document.createElement('tr');
            var name = document.createElement('td');
            name.textContent = item.file;
            var size = document.createElement('td');
            size.textContent = String(item.bytes);
            var action = document.createElement('td');
            var button = document.createElement('button');
            button.type = 'button';
            button.className = 'xp-btn';
            button.textContent = xpT('Restore');
            button.addEventListener('click', function () {
              button.disabled = true;
              note(backupStatus, xpT('Restoring.'));
              window.xpanelSessionRequest('${xwhmPageAdapters.backups.create.method}', '${xwhmPageAdapters.backups.create.path}' + backupAccount.value, { op: 'restore', file: item.file }).then(function () { button.disabled = false; note(backupStatus, xpT('The backup was restored.')); }).catch(function (error) { button.disabled = false; note(backupStatus, failText(error)); });
            });
            action.appendChild(button);
            row.appendChild(name);
            row.appendChild(size);
            row.appendChild(action);
            backupFiles.appendChild(row);
          });
        }).catch(function (error) { note(backupStatus, failText(error)); });
      }
      backupAccount.addEventListener('change', loadBackups);
      backupRoot.querySelector('[data-backup-create]').addEventListener('click', function () {
        note(backupStatus, xpT('Creating the backup. This can take a while.'));
        window.xpanelSessionRequest('${xwhmPageAdapters.backups.create.method}', '${xwhmPageAdapters.backups.create.path}' + backupAccount.value, { op: 'create' }).then(function () { note(backupStatus, xpT('The backup job started at low priority. Read the list again when it finishes.')); return loadBackups(); }).catch(function (error) { note(backupStatus, failText(error)); });
      });
      loadBackups();
    }
  }

  if (typeof window !== 'undefined') {
    window.xpanelApiCall = xpanelApiCall;
    window.xpanelShowToast = showToast;
    window.xpanelSwitchView = switchTabOrView;
    bindOverlayFocus();
    bindCommandPalette();
    bindKeyboardShortcuts();
    bindInteractiveClientActions();
    bindAccountActions();
    bindAccountCreation();
    bindPhaseOneTools();
    if (document.documentElement.dataset.realtimeEnabled !== 'false') connectWebSocket();
  }
})();
${PLAN_EDITOR_CLIENT_SCRIPT}
${ACCOUNT_LIST_CLIENT_SCRIPT}
`
