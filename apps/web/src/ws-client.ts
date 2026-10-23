// Real-time RFC 6455 WebSocket state store, 5-stage reconcile pipeline banner renderer,
// and embedded browser script for live updates and keyboard navigation shortcuts.

import type {
  AuditEntry,
  IoAnalyticsSnapshot,
  LiveEvent,
  ReconcileStage,
  WebsiteAnalyticsSnapshot,
} from '@xpanel/core'
import { dirForLocale, t, type Locale } from './i18n.ts'
import { escapeHtml, renderLtrValue, renderStatusBadge } from './tokens.ts'
import { SHELL_MOTION_CLIENT_SCRIPT } from './shell-motion.ts'

export type WsConnectionState = 'connected' | 'reconnecting' | 'offline'
export type ReconcileStageStatus = 'pending' | 'running' | 'passed' | 'failed'

export const RECONCILE_STAGES: readonly ReconcileStage[] = [
  'render',
  'test',
  'switch',
  'reload',
  'verify',
] as const

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

export interface TerminalOutputLine {
  at: string
  sessionId: string
  username: string
  stream: 'stdout' | 'stderr' | 'exit'
  chunk: string
  exitCode?: number
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
  terminalLinesBySession: Record<string, TerminalOutputLine[]>
  recentAuditEntries: AuditEntry[]
  recentJobs: LiveJobStatus[]
  servicesHealth: { name: string; active: boolean; enabled: boolean }[]
}

export interface LiveEventStore {
  getState: () => LiveEventState
  setConnectionState: (connectionState: WsConnectionState) => LiveEventState
  applyEvent: (event: LiveEvent) => LiveEventState
  dispatch: (event: LiveEvent) => LiveEventState
  clearTerminal: (sessionId: string) => LiveEventState
  subscribe: (listener: (state: LiveEventState, event?: LiveEvent) => void) => () => void
}

const MAX_TERMINAL_LINES = 250
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
    terminalLinesBySession: {},
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

    case 'terminal.output': {
      const existing = state.terminalLinesBySession[event.data.sessionId] ?? []
      const nextLine: TerminalOutputLine = {
        at: event.at,
        sessionId: event.data.sessionId,
        username: event.data.username,
        stream: event.data.stream,
        chunk: event.data.chunk,
        exitCode: event.data.exitCode,
      }
      const updatedLines = [...existing, nextLine].slice(-MAX_TERMINAL_LINES)
      return {
        ...state,
        terminalLinesBySession: {
          ...state.terminalLinesBySession,
          [event.data.sessionId]: updatedLines,
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
    clearTerminal: (sessionId: string): LiveEventState => {
      state = {
        ...state,
        terminalLinesBySession: {
          ...state.terminalLinesBySession,
          [sessionId]: [],
        },
      }
      notify()
      return state
    },
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
  const dir = dirForLocale(locale)
  const arrow = dir === 'rtl' ? '←' : '→'

  const wsBadge =
    connectionState === 'connected'
      ? renderStatusBadge('ok', t(locale, 'common.ws.connected'))
      : connectionState === 'reconnecting'
        ? renderStatusBadge('reconciling', t(locale, 'common.ws.reconnecting'))
        : renderStatusBadge('warn', t(locale, 'common.ws.offline'))

  const generationBadge =
    reconcile.generationId <= 0 || reconcile.updatedAt === null
      ? renderStatusBadge('warn', locale === 'ar' ? 'لم تُرصد عملية مطابقة بعد' : 'Reconciliation has not been observed')
      : reconcile.status === 'running'
      ? renderStatusBadge(
          'reconciling',
          t(locale, 'reconcile.status.running', {
            generationId: reconcile.generationId,
          }),
        )
      : reconcile.status === 'failed'
        ? renderStatusBadge(
            'critical',
            t(locale, 'reconcile.status.rolledBack', {
              generationId: reconcile.generationId,
            }),
          )
        : renderStatusBadge(
            'ok',
            t(locale, 'reconcile.status.applied', {
              generationId: reconcile.generationId,
            }),
          )

  const stepsHtml = RECONCILE_STAGES.map((stage, idx) => {
    const stepStatus = reconcile.stages[stage] ?? 'pending'
    const stageLabel = t(locale, `reconcile.stage.${stage}`)
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
      ? `<span class="xp-reconcile-meta xp-tabular xp-mono">${escapeHtml(
          t(locale, 'reconcile.meta.summary', {
            filesCount: reconcile.filesCount,
            durationMs: reconcile.durationMs,
            checksum: '{checksum}',
          }),
        ).replace('{checksum}', renderLtrValue(reconcile.stateChecksum.slice(0, 12)))}</span>`
      : ''

  const errorBlock =
    reconcile.status === 'failed' && (reconcile.error || reconcile.failedTest)
      ? `<details class="xp-reconcile-error" open>` +
        `<summary class="xp-reconcile-error__summary">` +
        `${escapeHtml(
          t(locale, 'reconcile.error.failedTest', {
            failedTest: reconcile.failedTest ?? 'configtest',
          }),
        )} — ${escapeHtml(t(locale, 'reconcile.error.rawDetails'))}` +
        `</summary>` +
        `<pre class="xp-terminal xp-mono">${escapeHtml(reconcile.error ?? 'Configuration test failed; previous generation remains active.')}</pre>` +
        `</details>`
      : ''

  return (
    `<section id="xp-reconcile-banner" class="xp-reconcile-banner" data-reconcile-banner="true" data-generation-id="${reconcile.generationId}" data-reconcile-status="${reconcile.status}" dir="${dir}" aria-label="${escapeHtml(t(locale, 'reconcile.banner.title'))}">` +
    `<div class="xp-card__header">` +
    `<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">` +
    `<strong class="xp-reconcile-title">${escapeHtml(t(locale, 'reconcile.banner.title'))}</strong>` +
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
 * website analytics, reconcile stepper banner, and jailed terminal output in real time
 * without page reload, and binds keyboard shortcuts (`Cmd/Ctrl+K`, `/`, `g d`, `g a`, `g f`, `Escape`).
 */
export const BROWSER_REALTIME_SCRIPT = /* js */ `
(function () {
  'use strict';
${SHELL_MOTION_CLIENT_SCRIPT}

  var reconnectAttempt = 0;
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
    if (!el) return;
    el.setAttribute('data-ws-state', state);
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

  function appendTerminalOutputDom(data) {
    var out = document.querySelector('[data-terminal-output="' + data.sessionId + '"]') ||
              document.querySelector('[data-terminal-output]');
    if (!out) return;
    var line = document.createElement('div');
    line.className = 'xp-terminal__line xp-mono';
    line.setAttribute('data-stream', data.stream || 'stdout');
    line.textContent = data.chunk || '';
    out.appendChild(line);
    out.scrollTop = out.scrollHeight;
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
    } else if (event.kind === 'terminal.output') {
      appendTerminalOutputDom(event.data);
    }
  }

  function connectWebSocket() {
    if (typeof window === 'undefined' || !('WebSocket' in window)) return;
    var proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    var url = proto + '//' + window.location.host + '/api/ws';
    try {
      ws = new WebSocket(url);
    } catch (_err) {
      scheduleReconnect();
      return;
    }

    ws.onopen = function () {
      reconnectAttempt = 0;
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
      setWsBadgeState('reconnecting');
      scheduleReconnect();
    };

    ws.onerror = function () {
      setWsBadgeState('offline');
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
    if (restoreFocus) restoreVisibleFocus(overlay.returnFocus);
  }

  function closeActiveOverlay(restoreFocus, immediate) {
    if (!activeOverlay) return;
    var overlay = activeOverlay;
    if (overlay.closing) {
      overlay.restoreFocusAfterClose = overlay.restoreFocusAfterClose || restoreFocus;
      if (immediate) finishOverlayClose(overlay, overlay.restoreFocusAfterClose);
      return;
    }
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
        activeOverlay.motion.open();
        focusOverlay(activeOverlay);
      }
      return;
    }
    lastKeyPrefix = null;
    clearTimeout(lastKeyPrefixTimer);
    var returnFocus = trigger || document.activeElement;
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
      documentOverflow: document.documentElement.style.overflow
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
        commandPalette.input.setAttribute('aria-expanded', 'true');
        filterCommandPalette();
        commandPalette.results.scrollTop = 0;
      }
    }
    else if (activeOverlay && activeOverlay.element === modal) closeActiveOverlay(true);
  }

  function normalizeCommandSearch(value) {
    return value.normalize('NFKD').replace(/[\u0300-\u036f\u064b-\u065f\u0670\u0640]/g, '').toLowerCase();
  }

  function selectCommandResult(index, scroll) {
    var palette = commandPalette;
    if (!palette) return;
    var items = palette.matches;
    palette.activeIndex = items.length ? (index + items.length) % items.length : -1;
    for (var i = 0; i < palette.items.length; i++) palette.items[i].link.setAttribute('aria-selected', 'false');
    var selected = items[palette.activeIndex];
    if (!selected) {
      palette.input.removeAttribute('aria-activedescendant');
      return;
    }
    selected.link.setAttribute('aria-selected', 'true');
    palette.input.setAttribute('aria-activedescendant', selected.link.id);
    if (scroll) revealCommandResult(palette, selected);
  }

  function revealCommandResult(palette, selected) {
    var list = palette.results;
    var row = selected.row;
    var last = palette.activeIndex === palette.matches.length - 1;
    var maximum = list.scrollHeight - list.clientHeight;
    if (last && maximum > 0) {
      list.scrollTop = maximum;
      if (list.scrollTop > 0) return;
    }
    var rowRect = row.getBoundingClientRect();
    var listRect = list.getBoundingClientRect();
    if (rowRect.height > 0 && listRect.height > 0) {
      if (rowRect.top < listRect.top) list.scrollTop += rowRect.top - listRect.top;
      else if (rowRect.bottom > listRect.bottom) list.scrollTop += rowRect.bottom - listRect.bottom;
      return;
    }
    if (row.offsetParent === list && row.offsetHeight > 0) {
      var top = row.offsetTop;
      var bottom = top + row.offsetHeight;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = Math.max(0, bottom - list.clientHeight);
    }
  }

  function filterCommandPalette() {
    var palette = commandPalette;
    if (!palette) return;
    var terms = normalizeCommandSearch(palette.input.value.trim()).split(/\\s+/).filter(Boolean);
    palette.matches = [];
    for (var i = 0; i < palette.items.length; i++) {
      var item = palette.items[i];
      item.row.hidden = !terms.every(function (term) { return item.search.indexOf(term) !== -1; });
      if (!item.row.hidden) palette.matches.push(item);
    }
    palette.empty.hidden = palette.matches.length !== 0;
    palette.status.textContent = palette.matches.length ? palette.status.getAttribute('data-count-label') + ': ' + String(palette.matches.length) : '';
    for (var j = 0; j < palette.matches.length; j++) {
      palette.matches[j].link.setAttribute('aria-posinset', String(j + 1));
      palette.matches[j].link.setAttribute('aria-setsize', String(palette.matches.length));
    }
    selectCommandResult(0, false);
    palette.results.scrollTop = 0;
  }

  function bindCommandPalette() {
    var modal = document.getElementById('xp-cmdk-modal') || document.querySelector('[data-xp-cmdk]');
    if (!modal) return;
    var input = modal.querySelector('[data-cmdk-search]');
    var results = modal.querySelector('[data-cmdk-results]');
    var empty = modal.querySelector('[data-cmdk-empty]');
    var status = modal.querySelector('[data-cmdk-status]');
    if (!input || !results || !empty || !status) return;
    var items = Array.prototype.map.call(results.querySelectorAll('a[data-cmdk-item]'), function (link) {
      return { link: link, row: link.closest('[data-cmdk-row]'), search: normalizeCommandSearch(link.getAttribute('data-cmdk-search-text') || link.textContent) };
    }).filter(function (item) { return item.row; });
    commandPalette = { modal: modal, input: input, results: results, empty: empty, status: status, items: items, matches: [], activeIndex: -1 };
    input.addEventListener('input', filterCommandPalette);
    results.addEventListener('pointermove', function (event) {
      var link = event.target.closest ? event.target.closest('a[data-cmdk-item]') : null;
      var index = commandPalette.matches.findIndex(function (item) { return item.link === link; });
      if (index >= 0 && index !== commandPalette.activeIndex) selectCommandResult(index, false);
    });
    results.addEventListener('click', function (event) {
      var link = event.target.closest ? event.target.closest('a[data-cmdk-item]') : null;
      if (link && results.contains(link) && activeOverlay && activeOverlay.element === modal) closeActiveOverlay(true);
    });
    filterCommandPalette();
  }

  function handleCommandPaletteKey(event) {
    var palette = commandPalette;
    if (!palette || activeOverlay.element !== palette.modal || event.target !== palette.input || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      selectCommandResult(palette.activeIndex + (event.key === 'ArrowDown' ? 1 : -1), true);
      return true;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      var selected = palette.matches[palette.activeIndex];
      if (selected) selected.link.click();
      return true;
    }
    return false;
  }

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
    toast.style.cssText = 'padding:12px 16px;border-inline-start:4px solid var(--xp-accent);box-shadow:var(--xp-shadow-md);';
    toast.textContent = message;
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
    if (!button || !feedback || !password || !plan || !assignment || !ipFeedback || !ipAddress || !ipRefresh) return;
    var busy = false, accepted = false, dirty = false, reviewRequired = false;
    var canCreate = !button.disabled, wantedAssignment = 'shared', availability = null;
    var previewController = null, previewTimer = null, previewSequence = 0, previewPlan = null;
    var controls = Array.prototype.map.call(form.querySelectorAll('input,select'), function (control) {
      return { element: control, disabled: control.disabled, readOnly: Boolean(control.readOnly) };
    });
    var ar = document.documentElement.lang === 'ar';
    function copy(en, arabic) { return ar ? arabic : en; }
    function status(message, state) {
      feedback.textContent = message; feedback.hidden = false;
      feedback.setAttribute('data-state', state);
      feedback.setAttribute('role', state === 'failed' ? 'alert' : 'status');
    }
    function ipStatus(message, state) {
      ipFeedback.textContent = message;
      ipFeedback.setAttribute('data-state', state);
      ipFeedback.setAttribute('role', state === 'failed' ? 'alert' : 'status');
    }
    function uuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value); }
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
      var current = availability && previewPlan === plan.value ? availability : null;
      var shared = wantedAssignment === 'shared';
      var selected = current && current.available.find(function (entry) { return wantedAssignment === 'dedicated:' + entry.poolId; });
      var available = shared ? !current || Boolean(current.shared) : Boolean(current && current.entitled && (wantedAssignment === 'dedicated:auto' ? current.available.length : selected));
      assignment.setCustomValidity(available ? '' : shared ? copy('No default shared IPv4 is configured.', 'لم يُضبط عنوان IPv4 مشترك افتراضي.') : copy('This dedicated IPv4 selection is unavailable. Choose another assignment.', 'العنوان المخصص المحدد غير متاح. اختر تعيينًا آخر.'));
      ipAddress.textContent = current && (shared ? current.shared && current.shared.address : selected && selected.address) || '';
      ipAddress.parentElement.hidden = !ipAddress.textContent;
      if (current) ipStatus(available ? copy('Checked on the server after creation.', 'يُفحص على الخادم بعد الإنشاء.') : assignment.validationMessage, available ? 'ready' : 'unavailable');
      return available;
    }
    function renderIpOptions() {
      var current = availability && previewPlan === plan.value ? availability : null;
      var nodes = [option('shared', copy('Default shared', 'المشترك الافتراضي'), Boolean(current && !current.shared)), option('dedicated:auto', copy('Dedicated · Automatic', 'مخصص تلقائي'), !current || !current.entitled || !current.available.length)];
      if (current) current.available.forEach(function (entry) { nodes.push(option('dedicated:' + entry.poolId, String.fromCharCode(0x2066) + entry.address + String.fromCharCode(0x2069), false)); });
      if (!nodes.some(function (entry) { return entry.value === wantedAssignment; })) nodes.push(option(wantedAssignment, copy('Dedicated selection unavailable', 'التعيين المخصص غير متاح'), true));
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
      availability = null; previewPlan = plan.value;
      renderIpOptions();
      if (!canCreate || !plan.value || !form.isConnected || busy || accepted || reviewRequired) {
        ipStatus(copy('IP availability unavailable.', 'توفر عناوين IP غير متاح.'), 'unavailable'); return;
      }
      ipStatus(copy('Loading IP availability…', 'جارٍ تحميل العناوين…'), 'loading');
      if (typeof window.fetch !== 'function' || typeof AbortController !== 'function') {
        ipStatus(copy('Could not load IP availability.', 'تعذر تحميل توفر العناوين.'), 'failed'); return;
      }
      var sequence = previewSequence, context = plan.value, controller = new AbortController();
      previewController = controller;
      previewTimer = setTimeout(function () { controller.abort(); }, 20000);
      function current() { return sequence === previewSequence && context === plan.value && form.isConnected && !busy && !accepted && !reviewRequired; }
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
      window.fetch('/api/ips?view=allocation&planId=' + encodeURIComponent(context), { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { accept: 'application/json' }, signal: controller.signal }).then(function (response) {
        if (!current()) { controller.abort(); return null; }
        if (!response.ok) { var error = new Error('IP availability unavailable'); error.status = response.status; controller.abort(); throw error; }
        return readPreviewJson(response);
      }).then(function (data) {
        if (!current()) return;
        availability = parseAvailability(data); renderIpOptions();
      }).catch(function (error) {
        if (!current()) return;
        availability = null; renderIpOptions();
        ipStatus(error && error.status === 401 ? copy('Your session expired. Sign in again.', 'انتهت الجلسة. سجّل الدخول مجددًا.') : error && error.status === 403 ? copy('IP availability is not permitted for this plan.', 'لا تملك صلاحية عرض العناوين لهذه الخطة.') : copy('Could not load IP availability.', 'تعذر تحميل توفر العناوين.'), 'failed');
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
    ipRefresh.addEventListener('click', function () { if (!busy && !accepted && !reviewRequired) refreshIpAvailability(); });
    window.addEventListener('pagehide', cancelPreview);
    form.addEventListener('input', function () { dirty = true; });
    window.addEventListener('beforeunload', function (event) {
      if (!dirty || accepted) return;
      event.preventDefault(); event.returnValue = '';
    });
    refreshIpAvailability();
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (busy || accepted || button.disabled || !updateIpSelection() || !form.reportValidity()) return;
      if (typeof window.xpanelSessionRequest !== 'function') {
        status(copy('Account creation is unavailable. No changes were made.', 'إنشاء الحساب غير متاح. لم تُجرَ تغييرات.'), 'failed'); return;
      }
      var value = function (name) { return form.querySelector('[name="' + name + '"]').value.trim(); };
      var ipAssignment = wantedAssignment === 'shared' ? { mode: 'shared' } : { mode: 'dedicated' };
      if (wantedAssignment !== 'shared' && wantedAssignment !== 'dedicated:auto') ipAssignment.poolId = wantedAssignment.slice('dedicated:'.length);
      var body = { username: value('username'), primaryDomain: value('primaryDomain'), planId: value('planId'), password: password.value, ipAssignment: ipAssignment };
      var ipv6 = value('ipv6');
      if (ipv6) body.ipv6 = ipv6;
      var submittedValues = controls.map(function (state) {
        return state.element.name === 'password' ? '' : state.element.value;
      });
      cancelPreview();
      busy = true; button.disabled = true; form.setAttribute('aria-busy', 'true');
      ipRefresh.disabled = true;
      controls.forEach(function (state) { state.element.disabled = true; });
      password.value = '';
      status(copy('Submitting…', 'جارٍ الإرسال…'), 'loading');
      var refreshAfterRefusal = false;
      Promise.resolve().then(function () { return window.xpanelSessionRequest('POST', '/api/accounts', body); }).then(function (result) {
        var execution = result && result.execution;
        var pendingHost = execution && execution.targetVerified === false && execution.verificationRequired === true;
        var observedHost = execution && execution.targetVerified === true && execution.verificationRequired === false && execution.hostBinding === 'observed' && execution.observedAddress === result.account.ipv4;
        if (!result || !result.account || result.account.username !== body.username || !ipv4(result.account.ipv4) || !result.reconcile || result.reconcile.status !== 'applied' || !execution || execution.status !== 'configuration_applied' || execution.scope !== 'global_configuration' || (!pendingHost && !observedHost)) {
          reviewRequired = true;
          status(copy('The result could not be verified. Review accounts before retrying.', 'تعذر التحقق من النتيجة. راجع الحسابات قبل إعادة المحاولة.'), 'failed'); return;
        }
        accepted = true; dirty = false;
        ipAddress.textContent = result.account.ipv4; ipAddress.parentElement.hidden = false;
        if (observedHost) {
          ipStatus(copy('This address is on the server.', 'هذا العنوان موجود على الخادم.'), 'ready');
          status(copy('Account created.', 'تم إنشاء الحساب.'), 'pending');
        } else {
          ipStatus(copy('Host binding unverified.', 'لم يُتحقق من ربط العنوان بالخادم.'), 'ready');
          status(copy('Account configuration created. Hosting verification is still required.', 'أُنشئ إعداد الحساب. ما زال يلزم التحقق من الاستضافة.'), 'pending');
        }
      }).catch(function (error) {
        var details = error && error.details || {};
        var serverFailed = error && (error.status === 500 || error.code === 'INTERNAL_ERROR');
        reviewRequired = serverFailed ? details.stateChanged === true : details.stateChanged !== false;
        var message = serverFailed
          ? copy('The server could not complete this request.', 'تعذر على الخادم إكمال هذا الطلب.')
          : reviewRequired
          ? copy('The request could not be verified. Review accounts before retrying.', 'تعذر التحقق من الطلب. راجع الحسابات قبل إعادة المحاولة.')
          : copy('Account creation is unavailable. No changes were made.', 'إنشاء الحساب غير متاح. لم تُجرَ تغييرات.');
        if (!reviewRequired) {
          if (error && error.status === 401) message = copy('Your session expired. Sign in again.', 'انتهت الجلسة. سجّل الدخول مجددًا.');
          else if (error && error.status === 403) message = copy('You do not have permission to create accounts.', 'لا تملك صلاحية إنشاء الحسابات.');
          else if (details.reason === 'shared_ipv4_unavailable' || details.reason === 'account_ipv4_unavailable') {
            message = copy('No default shared IPv4 is available. Review the IP pool.', 'لا يتوفر عنوان IPv4 مشترك افتراضي. راجع مخزون العناوين.'); refreshAfterRefusal = true;
          } else if (details.reason === 'dedicated_ipv4_unavailable') {
            message = copy('No dedicated IPv4 is available. Choose another assignment.', 'لا يتوفر عنوان IPv4 مخصص. اختر تعيينًا آخر.'); refreshAfterRefusal = true;
          }
        }
        status(message, 'failed');
      }).finally(function () {
        delete body.password;
        controls.forEach(function (state, index) {
          var control = state.element;
          control.value = submittedValues[index];
          control.disabled = reviewRequired || (accepted && control.tagName === 'SELECT') || state.disabled;
          if (control.tagName === 'INPUT') control.readOnly = accepted || state.readOnly;
        });
        busy = false; form.setAttribute('aria-busy', 'false'); button.disabled = accepted || reviewRequired || !canCreate;
        ipRefresh.disabled = accepted || reviewRequired || !canCreate;
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
    var ar = document.documentElement.lang === 'ar';
    function copy(en, arabic) { return ar ? arabic : en; }
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
      dialog.querySelector('[data-account-dialog-title]').textContent = deleting ? copy('Delete account', 'حذف الحساب') : suspending ? copy('Suspend account', 'تعليق الحساب') : copy('Unsuspend account', 'إلغاء تعليق الحساب');
      dialog.querySelector('[data-account-dialog-description]').textContent = deleting ? copy('Permanently removes this account and its data. This cannot be undone.', 'يحذف هذا الحساب وبياناته نهائيًا. لا يمكن التراجع.') : suspending ? copy('Hosting access will be suspended for this account.', 'سيُعلق وصول الاستضافة لهذا الحساب.') : copy('Restore hosting access for this account.', 'استعادة وصول الاستضافة لهذا الحساب.');
      dialog.querySelector('[data-account-dialog-username]').textContent = username;
      dialog.querySelector('[data-account-dialog-domain]').textContent = domain;
      dialog.querySelector('[data-account-confirm-field]').hidden = !deleting;
      dialog.querySelector('[data-account-reason-field]').hidden = !suspending;
      confirmation.required = deleting;
      submission.textContent = deleting ? copy('Delete account', 'حذف الحساب') : suspending ? copy('Suspend', 'تعليق') : copy('Unsuspend', 'إلغاء التعليق');
      submission.classList.toggle('xp-accounts__delete', deleting);
      validate(); dialog.showModal();
      (deleting ? confirmation : suspending ? reason : cancel).focus();
    });
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (busy || accepted || !target || (target.action === 'terminate-account' && confirmation.value !== target.username)) { validate(); return; }
      if (typeof window.xpanelSessionRequest !== 'function') { status(copy('Action unavailable. No changes were made.', 'الإجراء غير متاح. لم تُجرَ تغييرات.'), 'failed'); return; }
      var selected = target;
      var deleting = selected.action === 'terminate-account';
      var verb = selected.action === 'suspend-account' ? 'suspend' : 'unsuspend';
      var endpoint = '/api/accounts/' + encodeURIComponent(selected.id) + (deleting ? '' : '/' + verb);
      var body = deleting ? { confirmUsername: confirmation.value } : verb === 'suspend' ? { reason: reason.value.trim() } : {};
      busy = true; cancel.disabled = true; confirmation.readOnly = true; reason.readOnly = true; form.setAttribute('aria-busy', 'true'); validate();
      status(copy('Submitting…', 'جارٍ الإرسال…'), 'loading');
      Promise.resolve().then(function () { return window.xpanelSessionRequest(deleting ? 'DELETE' : 'POST', endpoint, body); }).then(function (result) {
        if (deleting) {
          if (!result || result.ok !== true || result.purged !== true) {
            status(copy('The result could not be verified. Review the account before retrying.', 'تعذر التحقق من النتيجة. راجع الحساب قبل إعادة المحاولة.'), 'failed'); return;
          }
          accepted = true;
          var removed = origin && origin.closest('[data-account-row]');
          if (removed) removed.hidden = true;
          status(copy('Account removed.', 'تم حذف الحساب.'), 'pending');
          return;
        }
        var expected = verb === 'suspend' ? 'suspended' : 'active';
        var execution = result && result.execution;
        if (!result || !result.account || result.account.id !== selected.id || result.account.status !== expected || !result.reconcile || result.reconcile.status !== 'applied' || !execution || execution.status !== 'configuration_applied' || execution.scope !== 'global_configuration' || execution.targetVerified !== false || execution.verificationRequired !== true) {
          status(copy('The result could not be verified. Review the account before retrying.', 'تعذر التحقق من النتيجة. راجع الحساب قبل إعادة المحاولة.'), 'failed'); return;
        }
        accepted = true;
        var row = origin && origin.closest('[data-account-row]');
        var label = row && row.querySelector('[data-account-status] .xp-badge__label');
        if (label) label.textContent = copy('Verification required', 'يلزم التحقق');
        var badge = row && row.querySelector('[data-account-status] .xp-badge');
        if (badge) {
          badge.className = 'xp-badge xp-badge--warn';
          badge.setAttribute('data-status', 'warn');
          var icon = badge.querySelector('svg');
          if (icon) icon.innerHTML = '<path d="M8 2.2L14.4 13.5H1.6L8 2.2Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 6.5V9.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="11.6" r="0.85" fill="currentColor"/>';
        }
        if (origin) origin.disabled = true;
        status(copy(verb === 'suspend' ? 'Account suspended. Hosting verification is still required.' : 'Account restored. Hosting verification is still required.', verb === 'suspend' ? 'تم تعليق الحساب. ما زال يلزم التحقق من الاستضافة.' : 'أُعيد الحساب. ما زال يلزم التحقق من الاستضافة.'), 'pending');
      }).catch(function (error) {
        var details = error && error.details || {};
        var serverFailed = error && (error.status === 500 || error.code === 'INTERNAL_ERROR');
        var message = serverFailed
          ? copy('The server could not complete this request.', 'تعذر على الخادم إكمال هذا الطلب.')
          : details.stateChanged === false ? copy('Action unavailable. No changes were made.', 'الإجراء غير متاح. لم تُجرَ تغييرات.') : copy('The request could not be verified. Review the account before retrying.', 'تعذر التحقق من الطلب. راجع الحساب قبل إعادة المحاولة.');
        if (error && error.status === 401) message = copy('Your session expired. Sign in again.', 'انتهت الجلسة. سجّل الدخول مجددًا.');
        else if (error && error.status === 403) message = copy('You do not have permission for this action.', 'لا تملك صلاحية هذا الإجراء.');
        else if (error && error.status === 404) message = copy('This account is no longer available.', 'لم يعد هذا الحساب متاحًا.');
        else if (error && error.status === 409) message = copy('This account changed. Reload before retrying.', 'تغيّر الحساب. أعد تحميل الصفحة قبل المحاولة.');
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

    // Interactive Terminal Command Submit
    var termForm = document.querySelector('[data-terminal-form]');
    if (termForm) {
      termForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var cmdInput = termForm.querySelector('input[name="command"]');
        var cmd = cmdInput ? cmdInput.value.trim() : '';
        if (!cmd) return;
        appendTerminalOutputDom({ sessionId: '', stream: 'stdout', chunk: '$ ' + cmd });
        if (cmdInput) cmdInput.value = '';
        xpanelApiCall('POST', termForm.getAttribute('action') || '/api/xpanel/terminal/exec', { command: cmd })
          .then(function (res) {
            if (res && res.output) {
              appendTerminalOutputDom({ sessionId: '', stream: 'stdout', chunk: res.output });
            }
          })
          .catch(function () {});
      });
    }

    // Custom Config (userdata) Save
    var userdataForm = document.querySelector('[data-userdata-form]');
    if (userdataForm) {
      userdataForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var nginxInclude = (userdataForm.querySelector('[name="nginxInclude"]') || {}).value || '';
        var apacheInclude = (userdataForm.querySelector('[name="apacheInclude"]') || {}).value || '';
        var userIni = (userdataForm.querySelector('[name="userIni"]') || {}).value || '';
        var customHeaders = (userdataForm.querySelector('[name="customHeaders"]') || {}).value || '';
        xpanelApiCall('POST', userdataForm.getAttribute('action') || '/api/xpanel/domains/custom-config', {
          nginxInclude: nginxInclude,
          apacheInclude: apacheInclude,
          userIni: userIni,
          customHeaders: customHeaders
        }).catch(function () {});
      });
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
        closeActiveOverlay(true, true); return;
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
      if (action === 'new-file' || action === 'new-folder') {
        e.preventDefault();
        var kind = action === 'new-folder' ? 'folder' : 'file';
        var defaultPath = target.getAttribute('data-path');
        if (!defaultPath) { showToast('Choose a destination before creating an item', 'warn'); return; }
        var defaultMode = kind === 'folder' ? '0750' : '0640';
        xpanelApiCall('POST', '/api/xpanel/files/create', { kind: kind, path: defaultPath, modeOctal: defaultMode }).catch(function () {});
        return;
      }
      if (action === 'chmod-file') {
        e.preventDefault();
        var filePath = target.getAttribute('data-path');
        if (!filePath) { showToast('Choose a file before changing permissions', 'warn'); return; }
        var octalInput = document.getElementById('chmod-octal-input');
        var modeOctal = (octalInput && octalInput.value) ? octalInput.value : '0640';
        if (modeOctal === '0777' || modeOctal === '0666') {
          showToast('World-writable mode ' + modeOctal + ' is forbidden (max 0640 file / 0750 dir)', 'critical');
          return;
        }
        xpanelApiCall('POST', '/api/xpanel/files/chmod', { path: filePath, modeOctal: modeOctal }).catch(function () {});
        return;
      }
      if (action === 'restore-file') {
        e.preventDefault();
        var restorePath = target.getAttribute('data-path') || '';
        xpanelApiCall('POST', '/api/xpanel/files/restore', { path: restorePath }).catch(function () {});
        return;
      }
      if (action === 'empty-trash') {
        e.preventDefault();
        xpanelApiCall('POST', '/api/xpanel/files/empty-trash', {}).catch(function () {});
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

  function bindPhaseOneTools() {
    if (typeof window.xpanelSessionRequest !== 'function') return;
    var ar = document.documentElement.lang === 'ar';
    function note(el, message) { if (!el) return; el.hidden = false; el.textContent = message; }
    function dialogInput(selector, name) {
      var dialog = document.querySelector(selector);
      return dialog ? dialog.querySelector('[name="' + name + '"]') : null;
    }
    function failText(error) { return (error && error.message) || (ar ? 'تعذر إكمال الطلب.' : 'The request could not be completed.'); }
    function reload() { window.location.reload(); }
    document.querySelectorAll('[data-domain-form]').forEach(function (form) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var status = form.querySelector('[data-domain-status]');
        var name = form.querySelector('[name="name"]').value.trim().toLowerCase();
        var kind = form.querySelector('[name="kind"]').value;
        var body = { name: name, kind: kind };
        if (kind === 'subdomain') body.parentId = form.getAttribute('data-primary-id');
        window.xpanelSessionRequest('POST', '/api/domains', body).then(reload).catch(function (error) { note(status, failText(error)); });
      });
    });
    document.querySelectorAll('[data-remove-domain]').forEach(function (button) {
      button.addEventListener('click', function () {
        window.xpanelSessionRequest('DELETE', '/api/domains/' + button.getAttribute('data-remove-domain')).then(reload).catch(function (error) { note(button.parentElement, failText(error)); });
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
        show(ar ? 'جارٍ الإرسال…' : 'Submitting…', 'loading');
        Promise.resolve().then(run).then(function () {
          show(ar ? 'تم الحفظ.' : 'Saved.', 'pending');
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
        window.xpanelSessionRequest('DELETE', '/api/service-users/' + button.getAttribute('data-remove-mailbox')).then(reload).catch(function (error) { note(button.parentElement, failText(error)); });
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
    document.querySelectorAll('[data-plan-editor-form]').forEach(function (form) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var status = form.querySelector('[data-plan-status]');
        var openAddon = form.querySelector('[name="' + 'un' + 'limitedAddonDomains"]');
        var body = {
          name: form.querySelector('[name="name"]').value.trim(),
          shell: form.querySelector('[name="shell"]').value,
          resources: {
            cpuPercent: Number(form.querySelector('[name="cpuPercent"]').value),
            memoryMb: Number(form.querySelector('[name="memoryMb"]').value),
            maxProcesses: Number(form.querySelector('[name="maxProcesses"]').value),
            diskMb: 10240,
            bandwidthMbMonth: 'un' + 'limited',
            ioReadBps: 50000000,
            ioWriteBps: 25000000,
            ioReadIops: 2000,
            ioWriteIops: 2000,
          },
          caps: {
            addonDomains: openAddon && openAddon.checked ? 'un' + 'limited' : 10,
            aliasDomains: 10, subdomains: 20, mailboxes: 20, forwarders: 20, mailingLists: 5, ftpAccounts: 10, databases: 10, phpWorkers: 8,
          },
        };
        window.xpanelSessionRequest('POST', '/api/plans', body).then(reload).catch(function (error) { note(status, failText(error)); });
      });
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
    var filesRoot = document.querySelector('[data-file-manager="browse"]');
    if (filesRoot) {
      var username = filesRoot.getAttribute('data-account-username');
      var tbody = filesRoot.querySelector('[data-file-manager-table] tbody');
      var editor = document.getElementById('jailed-code-editor');
      var fileStatus = filesRoot.querySelector('[data-file-status]');
      var currentPath = '';
      function files(body) { return window.xpanelSessionRequest('POST', '/api/accounts/' + username + '/files', body); }
      function paint(entries) {
        while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
        (entries || []).forEach(function (entry) {
          var row = document.createElement('tr');
          function cell(value) { var td = document.createElement('td'); td.textContent = value; row.appendChild(td); }
          cell(entry.name || '');
          cell(entry.kind || '');
          cell(String(entry.sizeBytes || 0));
          cell((entry.mode >>> 0).toString(8));
          cell(entry.mtime || '');
          var action = document.createElement('td');
          var open = document.createElement('button');
          open.type = 'button'; open.className = 'xp-btn';
          open.textContent = entry.kind === 'directory' ? (ar ? 'فتح' : 'Open') : (ar ? 'تحرير' : 'Edit');
          open.addEventListener('click', function () {
            if (entry.kind === 'directory') { currentPath = entry.path; return refresh(); }
            files({ op: 'read', path: entry.path }).then(function (file) {
              editor.value = file.content || '';
              editor.setAttribute('data-editor-path', entry.path);
            }).catch(function (error) { note(fileStatus, failText(error)); });
          });
          var remove = document.createElement('button');
          remove.type = 'button'; remove.className = 'xp-btn';
          remove.textContent = ar ? 'حذف' : 'Delete';
          remove.addEventListener('click', function () {
            files({ op: 'trash', path: entry.path }).then(refresh).catch(function (error) { note(fileStatus, failText(error)); });
          });
          action.appendChild(open); action.appendChild(remove); row.appendChild(action); tbody.appendChild(row);
        });
      }
      function refresh() { return files({ op: 'list', path: currentPath }).then(function (data) { paint(data.entries || []); }).catch(function (error) { note(fileStatus, failText(error)); }); }
      var upload = filesRoot.querySelector('[data-action="upload-file"]');
      var picker = filesRoot.querySelector('[data-file-upload]');
      if (upload && picker) upload.addEventListener('click', function () { picker.click(); });
      if (picker) picker.addEventListener('change', function () {
        var file = picker.files && picker.files[0];
        if (!file) return;
        file.text().then(function (content) {
          var path = (currentPath ? currentPath.replace(/[/]$/, '') + '/' : '') + file.name;
          return files({ op: 'write', path: path, content: content });
        }).then(refresh).catch(function (error) { note(fileStatus, failText(error)); });
      });
      var newFile = filesRoot.querySelector('[data-action="new-file"]');
      if (newFile) newFile.addEventListener('click', function () {
        var name = window.prompt(ar ? 'اسم الملف' : 'File name');
        if (!name) return;
        var path = (currentPath ? currentPath.replace(/[/]$/, '') + '/' : '') + name;
        files({ op: 'write', path: path, content: '' }).then(function () { editor.value = ''; editor.setAttribute('data-editor-path', path); return refresh(); }).catch(function (error) { note(fileStatus, failText(error)); });
      });
      var newFolder = filesRoot.querySelector('[data-action="new-folder"]');
      if (newFolder) newFolder.addEventListener('click', function () {
        var name = window.prompt(ar ? 'اسم المجلد' : 'Folder name');
        if (!name) return;
        var path = (currentPath ? currentPath.replace(/[/]$/, '') + '/' : '') + name;
        files({ op: 'mkdir', path: path }).then(refresh).catch(function (error) { note(fileStatus, failText(error)); });
      });
      var emptyTrash = filesRoot.querySelector('[data-action="empty-trash"]');
      if (emptyTrash) emptyTrash.addEventListener('click', function () { files({ op: 'empty-trash' }).then(refresh).catch(function (error) { note(fileStatus, failText(error)); }); });
      var save = filesRoot.querySelector('[data-action="save-file"]');
      if (save) save.addEventListener('click', function () {
        var path = editor.getAttribute('data-editor-path');
        if (!path) { note(fileStatus, ar ? 'افتح ملفًا أولًا.' : 'Open a file first.'); return; }
        files({ op: 'write', path: path, content: editor.value }).then(function () { note(fileStatus, ar ? 'تم الحفظ.' : 'Saved.'); return refresh(); }).catch(function (error) { note(fileStatus, failText(error)); });
      });
      refresh();
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
`
