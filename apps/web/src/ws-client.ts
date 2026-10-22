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

  var reconnectAttempt = 0;
  var ws = null;
  var lastKeyPrefix = null;
  var lastKeyPrefixTimer = null;
  var activeOverlay = null;
  var toolbarMobileMode = null;
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
    if (!element || element.closest('[hidden], [inert]') || !element.getClientRects().length) return false;
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
      var focused = document.activeElement;
      var summary = toolbar.querySelector(':scope > summary');
      toolbar.open = !mobile;
      toolbar.dataset.mobileReady = 'true';
      if (mobile && summary && focused !== summary && toolbar.contains(focused)) summary.focus({ preventScroll: true });
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

  function closeActiveOverlay(restoreFocus) {
    if (!activeOverlay) return;
    var overlay = activeOverlay;
    activeOverlay = null;
    if (overlay.kind === 'mobile-nav') {
      setMobileNavigationState(false);
      if (overlay.role === null) overlay.element.removeAttribute('role');
      else overlay.element.setAttribute('role', overlay.role);
      if (overlay.ariaModal === null) overlay.element.removeAttribute('aria-modal');
      else overlay.element.setAttribute('aria-modal', overlay.ariaModal);
    } else {
      overlay.element.hidden = true;
    }
    if (overlay.tabIndex === null) overlay.element.removeAttribute('tabindex');
    for (var i = 0; i < overlay.inertElements.length; i++) {
      var previous = overlay.inertElements[i];
      if (previous.value === null) previous.element.removeAttribute('inert');
      else previous.element.setAttribute('inert', previous.value);
    }
    document.body.style.overflow = overlay.bodyOverflow;
    document.documentElement.style.overflow = overlay.documentOverflow;
    if (restoreFocus && overlay.returnFocus && overlay.returnFocus.isConnected && isVisibleElement(overlay.returnFocus)) {
      overlay.returnFocus.focus({ preventScroll: true });
    }
  }

  function openOverlay(element, kind, trigger) {
    if (!element) return;
    if (activeOverlay && activeOverlay.element === element) return;
    var returnFocus = trigger || document.activeElement;
    if (activeOverlay) {
      if (activeOverlay.element.contains(returnFocus)) returnFocus = activeOverlay.returnFocus;
      closeActiveOverlay(false);
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
    focusOverlay(overlay);
  }

  function toggleCommandPalette(forceOpen, trigger) {
    var modal = document.getElementById('xp-cmdk-modal') || document.querySelector('[data-xp-cmdk]');
    if (!modal) return;
    var shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : modal.hidden;
    if (shouldOpen) openOverlay(modal, 'cmdk', trigger);
    else if (activeOverlay && activeOverlay.element === modal) closeActiveOverlay(true);
  }

  function toggleMobileNavigation(trigger) {
    if (window.innerWidth >= 960) return;
    if (activeOverlay && activeOverlay.kind === 'mobile-nav') {
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
      if (activeOverlay && !activeOverlay.element.contains(event.target)) focusOverlay(activeOverlay);
    });
    window.addEventListener('resize', function () {
      syncResponsiveToolbar();
      if (window.innerWidth >= 960) {
        if (activeOverlay && activeOverlay.kind === 'mobile-nav') closeActiveOverlay(false);
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
        if (e.key === 'Tab') trapOverlayFocus(e);
        return;
      }

      if (e.key === 'Escape' && closeFocusedToolbar(e.target)) {
        e.preventDefault();
        return;
      }

      if (isEditableTarget(e.target)) return;

      // '/' -> Focus filter or search input
      if (e.key === '/') {
        var filterInput =
          document.querySelector('[data-xp-filter-input]') ||
          document.querySelector('input[type="search"]');
        if (filterInput) {
          e.preventDefault();
          filterInput.focus();
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
        var navTarget = null;
        if (key === 'd') {
          navTarget = document.querySelector('[data-xp-nav="dashboard"], a[href*="dashboard"], a[href="/home"]');
        } else if (key === 'a') {
          navTarget = document.querySelector('[data-xp-nav="accounts"], a[href*="accounts"]');
        } else if (key === 'f') {
          navTarget = document.querySelector('[data-xp-nav="files"], a[href*="files"]');
        }
        if (navTarget && typeof navTarget.click === 'function') {
          e.preventDefault();
          navTarget.click();
        }
      }
    });
  }

  if (typeof window !== 'undefined') {
    window.xpanelApiCall = xpanelApiCall;
    window.xpanelShowToast = showToast;
    window.xpanelSwitchView = switchTabOrView;
    bindOverlayFocus();
    bindKeyboardShortcuts();
    bindInteractiveClientActions();
    if (document.documentElement.dataset.realtimeEnabled !== 'false') connectWebSocket();
  }
})();
`
