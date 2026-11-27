// Workspace interaction runtime:
// - Coalesces concurrent idempotent GET requests and caches short-TTL session metadata
// - Tracks long-running operations across navigations in #xp-ops-dock
// - Provides hover prefetch, navigation progress indication, and in-place soft refresh
// - Drives progressive multi-step wizards, form dirty-state tracking, password strength meters,
//   human-readable cron schedule previews, local-time tooltips, and large-table pagination
// - Drives file dropzones and keyboard-accessible sortable lists
// Served as a same-origin external script under strict CSP (script-src 'self').

import { LIVE_DATA_STORE_SCRIPT } from './data/live-store.ts'

export const WORKSPACE_RUNTIME_SCRIPT = /* js */ String.raw`(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__xpanelWorkspaceRuntime) return;
  window.__xpanelWorkspaceRuntime = true;

  ${LIVE_DATA_STORE_SCRIPT}

  function t(message, values) {
    if (typeof window.xpT === 'function') return window.xpT(message, values);
    if (!values) return message;
    return String(message).replace(/\{(\w+)\}/g, function (_, key) {
      return values[key] == null ? '' : String(values[key]);
    });
  }
  var reducedMotion = function () {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  };
  var esc = function (value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  };

  /* 1. Shared GET request coalescing and short-TTL cache for session/chrome endpoints */
  var CACHEABLE = LIVE_CACHEABLE;
  var inflight = new Map();
  var cache = new Map();
  var CACHE_TTL_MS = 6000;

  function clearFetchCache() {
    cache.clear();
  }
  window.__xpanelClearCache = clearFetchCache;

  if (typeof window.fetch === 'function' && !window.fetch.__xpanelCoalesced) {
    var nativeFetch = window.fetch.bind(window);
    var coalescedFetch = function (input, init) {
      var method = ((init && init.method) || (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();
      var rawUrl = typeof input === 'string' ? input : (input && input.url ? input.url : '');
      var path = '';
      try {
        var parsed = new URL(rawUrl, window.location.origin);
        if (parsed.origin === window.location.origin) path = parsed.pathname + parsed.search;
      } catch (_error) {}

      if (method !== 'GET' && method !== 'HEAD') {
        clearFetchCache();
        if (path.indexOf('/api/auth/logout') === 0) clearAllOperationsStorage();
        return nativeFetch(input, init).then(function (response) {
          if (path.indexOf('/api/auth/logout') === 0) clearAllOperationsStorage();
          if (response && response.status === 202 && path.indexOf('/api/') === 0) {
            try {
              response.clone().json().then(function (data) {
                var jobId = data && (data.jobId || data.operationId || (data.job && data.job.id));
                if (jobId) {
                  operationsDock.upsert({
                    id: String(jobId),
                    title: (data && (data.title || data.kind || data.message)) || path.split('/').pop() || t('Background job'),
                    state: 'running',
                    progress: typeof (data && data.progress) === 'number' ? data.progress : 15,
                    stage: (data && data.stage) || t('Queued on server'),
                  });
                }
              }).catch(function () {});
            } catch (_parseError) {}
          }
          return response;
        });
      }

      if (!CACHEABLE.test(path) || (init && init.signal)) return nativeFetch(input, init);
      var now = Date.now();
      var hit = cache.get(path);
      if (hit && now - hit.at < CACHE_TTL_MS) {
        return Promise.resolve(hit.response.clone());
      }
      var pending = inflight.get(path);
      if (pending) {
        return pending.then(function (response) { return response.clone(); });
      }
      var request = nativeFetch(input, init).then(function (response) {
        inflight.delete(path);
        if (response && response.ok) cache.set(path, { at: Date.now(), response: response.clone() });
        else if (path.indexOf('/api/auth/me') === 0 && response && (response.status === 401 || response.status === 403)) clearAllOperationsStorage();
        return response;
      }, function (error) {
        inflight.delete(path);
        throw error;
      });
      inflight.set(path, request);
      return request.then(function (response) { return response.clone(); });
    };
    coalescedFetch.__xpanelCoalesced = true;
    window.fetch = coalescedFetch;
  }

  /* 2. Persistent Live Operations Dock (#xp-ops-dock), scoped per authenticated principal */
  var OPS_STORAGE_PREFIX = 'xpanel_operations_dock:';
  var operations = [];
  function resolveOpsActor() {
    var shell = document.querySelector('[data-session-actor]');
    var actor = shell ? (shell.getAttribute('data-session-actor') || '').trim() : '';
    return actor || null;
  }
  function opsStorageKey(actor) {
    return actor ? OPS_STORAGE_PREFIX + actor : null;
  }
  function scrubForeignOperationsStorage(activeKey) {
    try {
      if (!window.sessionStorage) return;
      var remove = [];
      for (var i = 0; i < sessionStorage.length; i++) {
        var k = sessionStorage.key(i);
        if (!k) continue;
        if (k === 'xpanel_operations_dock' || (k.indexOf(OPS_STORAGE_PREFIX) === 0 && k !== activeKey)) {
          remove.push(k);
        }
      }
      for (var j = 0; j < remove.length; j++) sessionStorage.removeItem(remove[j]);
    } catch (_error) {}
  }
  function clearAllOperationsStorage() {
    operations = [];
    scrubForeignOperationsStorage(null);
    renderOperationsDock();
  }
  function loadOperations() {
    var actor = resolveOpsActor();
    var key = opsStorageKey(actor);
    scrubForeignOperationsStorage(key);
    if (!key) return [];
    try {
      var raw = window.sessionStorage ? sessionStorage.getItem(key) : null;
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || parsed.actor !== actor || !Array.isArray(parsed.items)) {
        sessionStorage.removeItem(key);
        return [];
      }
      var cutoff = Date.now() - 10 * 60 * 1000;
      return parsed.items.filter(function (item) { return item && item.id && (item.updatedAt || 0) > cutoff; }).slice(0, 6);
    } catch (_error) { return []; }
  }
  function saveOperations() {
    var actor = resolveOpsActor();
    var key = opsStorageKey(actor);
    if (!key) return;
    try {
      if (window.sessionStorage) {
        if (!operations.length) sessionStorage.removeItem(key);
        else sessionStorage.setItem(key, JSON.stringify({ actor: actor, items: operations.slice(0, 6) }));
      }
    } catch (_error) {}
  }
  function renderOperationsDock() {
    var dock = document.getElementById('xp-ops-dock');
    if (!dock) return;
    if (!operations.length) {
      dock.hidden = true;
      dock.innerHTML = '';
      return;
    }
    dock.hidden = false;
    dock.innerHTML = operations.map(function (op) {
      var pct = Math.max(0, Math.min(100, Number(op.progress) || 0));
      var badge = op.state === 'succeeded' ? t('Done')
        : op.state === 'failed' ? t('Failed')
        : pct + '%';
      return '<div class="v2-ops-item" data-ops-id="' + esc(op.id) + '" data-ops-state="' + esc(op.state || 'running') + '">'
        + '<div class="v2-ops-item__head"><span class="v2-ops-item__title">' + esc(op.title) + '</span>'
        + '<button type="button" class="v2-btn v2-btn--ghost" data-ops-dismiss="' + esc(op.id) + '" aria-label="' + esc(t('Dismiss')) + '">&times;</button></div>'
        + '<div class="v2-ops-item__bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><span class="v2-ops-item__fill" style="inline-size:' + pct + '%"></span></div>'
        + '<div class="v2-ops-item__meta"><span>' + esc(op.stage || '') + '</span><span class="v2-num">' + esc(badge) + '</span></div>'
        + (op.log ? '<pre class="v2-ops-item__log" dir="ltr">' + esc(op.log) + '</pre>' : '')
        + '</div>';
    }).join('');
  }
  var operationsDock = {
    upsert: function (entry) {
      if (!entry || !entry.id) return;
      var idx = operations.findIndex(function (item) { return item.id === entry.id; });
      var prev = idx >= 0 ? operations[idx] : {};
      var next = {
        id: String(entry.id),
        title: entry.title || prev.title || t('Operation'),
        state: entry.state || prev.state || 'running',
        progress: entry.progress !== undefined ? entry.progress : (prev.progress || 0),
        stage: entry.stage !== undefined ? entry.stage : (prev.stage || ''),
        log: entry.logAppend ? ((prev.log || '') + entry.logAppend).slice(-2000) : (entry.log !== undefined ? entry.log : prev.log),
        updatedAt: Date.now(),
      };
      if (idx >= 0) operations[idx] = next; else operations.unshift(next);
      operations = operations.slice(0, 6);
      saveOperations();
      renderOperationsDock();
      if (next.state === 'succeeded') {
        setTimeout(function () { operationsDock.dismiss(next.id); }, 7000);
      }
    },
    dismiss: function (id) {
      operations = operations.filter(function (item) { return item.id !== id; });
      saveOperations();
      renderOperationsDock();
    },
  };
  window.__xpanelOpsDock = operationsDock;
  document.addEventListener('click', function (ev) {
    var logout = ev.target && ev.target.closest ? ev.target.closest('[data-action="logout"]') : null;
    if (logout) {
      clearAllOperationsStorage();
      return;
    }
    var button = ev.target && ev.target.closest ? ev.target.closest('[data-ops-dismiss]') : null;
    if (!button) return;
    operationsDock.dismiss(button.getAttribute('data-ops-dismiss'));
  });
  document.addEventListener('xpanel:ws-event', function (ev) {
    var detail = ev && ev.detail;
    if (!detail || typeof detail !== 'object') return;
    clearFetchCache();
    var payload = detail.data && typeof detail.data === 'object' ? detail.data : null;
    if (detail.kind === 'job.updated' && payload && payload.jobId) {
      operationsDock.upsert({
        id: payload.jobId,
        title: payload.kind || t('Host job'),
        state: payload.status === 'succeeded' ? 'succeeded' : payload.status === 'failed' || payload.status === 'cancelled' ? 'failed' : 'running',
        progress: typeof payload.progress === 'number' ? payload.progress : (payload.status === 'succeeded' ? 100 : 35),
        stage: payload.error || payload.status || '',
        logAppend: payload.logChunk ? payload.logChunk + '\n' : undefined,
      });
    }
    var generationId = payload && payload.generationId !== undefined ? payload.generationId : detail.generationId;
    if (generationId && Number(generationId) > 0) {
      document.querySelectorAll('[data-generation-chip]').forEach(function (chip) {
        chip.setAttribute('data-generation-chip', String(generationId));
        var muted = chip.querySelector('.v2-muted');
        if (muted) muted.textContent = t('gen {id}', { id: generationId });
      });
    }
  });

  /* 3. Navigation progress indicator, hover prefetch, and in-place soft refresh */
  function ensureProgressBar() {
    var bar = document.querySelector('[data-navigation-progress]');
    if (!bar && document.body) {
      bar = document.createElement('div');
      bar.className = 'v2-nav-progress';
      bar.setAttribute('data-navigation-progress', 'true');
      bar.setAttribute('aria-hidden', 'true');
      document.body.appendChild(bar);
    }
    return bar;
  }
  function setNavProgress(loading) {
    var bar = ensureProgressBar();
    if (bar) bar.setAttribute('data-loading', loading ? 'true' : 'false');
  }

  var prefetched = new Set();
  var hoverTimer = null;
  document.addEventListener('pointerenter', function (ev) {
    var link = ev.target && ev.target.closest ? ev.target.closest('.v2-nav a[href]') : null;
    if (!link || prefetched.size >= 12) return;
    var href = link.getAttribute('href') || '';
    if (!href || href.charAt(0) !== '/' || prefetched.has(href)) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(function () {
      if (prefetched.has(href)) return;
      prefetched.add(href);
      var el = document.createElement('link');
      el.rel = 'prefetch';
      el.as = 'document';
      el.href = href;
      document.head.appendChild(el);
    }, 90);
  }, true);

  window.__xpanelSoftRefresh = function () {
    clearFetchCache();
    var currentMain = document.getElementById('main-content');
    if (!currentMain || currentMain.getAttribute('data-soft-refresh-safe') !== 'true' || document.documentElement.getAttribute('data-ui-theme') !== 'v2' || typeof DOMParser !== 'function') {
      window.location.reload();
      return Promise.resolve();
    }
    setNavProgress(true);
    return fetch(window.location.href, { credentials: 'same-origin', headers: { 'X-Requested-With': 'xpanel-soft-refresh' } })
      .then(function (response) {
        if (!response.ok || response.redirected) { window.location.reload(); return null; }
        return response.text();
      })
      .then(function (html) {
        if (!html) return;
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var nextMain = doc.getElementById('main-content');
        if (!nextMain) { window.location.reload(); return; }
        var scrollY = window.scrollY;
        var applySwap = function () {
          currentMain.innerHTML = nextMain.innerHTML;
          if (doc.title) document.title = doc.title;
          window.scrollTo(0, scrollY);
          mountWorkspace(currentMain);
        };
        if (typeof document.startViewTransition === 'function' && !reducedMotion()) {
          var transition = document.startViewTransition(applySwap);
          if (transition && transition.ready && transition.ready.catch) transition.ready.catch(function () {});
          if (transition && transition.finished && transition.finished.catch) transition.finished.catch(function () {});
        } else {
          applySwap();
        }
      })
      .catch(function () { window.location.reload(); })
      .finally(function () { setNavProgress(false); });
  };

  /* 4. Progressive Multi-Step Wizard Controller ([data-wizard]) */
  var boundWizards = new WeakSet();
  function bindWizards(root) {
    root.querySelectorAll('[data-wizard]').forEach(function (wizard) {
      if (boundWizards.has(wizard)) return;
      boundWizards.add(wizard);
      var mode = wizard.getAttribute('data-wizard') || 'stepped';
      var panels = Array.prototype.slice.call(wizard.querySelectorAll('[data-wizard-step]'));
      var navBtns = Array.prototype.slice.call(wizard.querySelectorAll('[data-wizard-go]'));
      if (panels.length < 2) return;
      var activeIndex = 0;
      var steppedActive = mode === 'stepped';

      function syncStep(index, focusPanel) {
        activeIndex = Math.max(0, Math.min(panels.length - 1, index));
        wizard.setAttribute('data-wizard-active', String(activeIndex + 1));
        panels.forEach(function (panel, i) {
          var hide = steppedActive && i !== activeIndex;
          panel.setAttribute('data-wizard-hidden', hide ? 'true' : 'false');
          panel.setAttribute('data-wizard-current', i === activeIndex ? 'true' : 'false');
        });
        navBtns.forEach(function (btn, i) {
          var current = i === activeIndex;
          if (current) btn.setAttribute('aria-current', 'step'); else btn.removeAttribute('aria-current');
          btn.setAttribute('data-step-state', i < activeIndex ? 'done' : current ? 'current' : 'upcoming');
        });
        wizard.querySelectorAll('[data-wizard-prev]').forEach(function (btn) { btn.hidden = !steppedActive || activeIndex === 0; });
        wizard.querySelectorAll('[data-wizard-next]').forEach(function (btn) { btn.hidden = !steppedActive || activeIndex === panels.length - 1; });
        if (focusPanel && panels[activeIndex]) {
          var firstField = panels[activeIndex].querySelector('input:not([type=hidden]):not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled)');
          if (steppedActive && firstField && typeof firstField.focus === 'function') firstField.focus({ preventScroll: false });
          else if (!steppedActive && typeof panels[activeIndex].scrollIntoView === 'function') panels[activeIndex].scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
        }
      }

      function validateCurrentStep() {
        var panel = panels[activeIndex];
        if (!panel) return true;
        var controls = Array.prototype.slice.call(panel.querySelectorAll('input, select, textarea'));
        for (var i = 0; i < controls.length; i++) {
          var control = controls[i];
          if (control.disabled || control.type === 'hidden') continue;
          if (typeof control.checkValidity === 'function' && !control.checkValidity()) {
            if (typeof control.reportValidity === 'function') control.reportValidity();
            control.setAttribute('aria-invalid', 'true');
            return false;
          }
          control.removeAttribute('aria-invalid');
        }
        return true;
      }

      navBtns.forEach(function (btn) {
        btn.addEventListener('click', function (ev) {
          var target = Number(btn.getAttribute('data-wizard-go')) - 1;
          if (Number.isNaN(target)) return;
          if (steppedActive) ev.preventDefault();
          if (steppedActive && target > activeIndex && !validateCurrentStep()) return;
          syncStep(target, true);
        });
      });
      wizard.querySelectorAll('[data-wizard-next]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          if (!validateCurrentStep()) return;
          syncStep(activeIndex + 1, true);
        });
      });
      wizard.querySelectorAll('[data-wizard-prev]').forEach(function (btn) {
        btn.addEventListener('click', function () { syncStep(activeIndex - 1, true); });
      });
      wizard.querySelectorAll('[data-wizard-toggle]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          steppedActive = !steppedActive;
          btn.setAttribute('aria-pressed', steppedActive ? 'true' : 'false');
          btn.textContent = steppedActive ? t('Show all steps') : t('Step-by-step mode');
          syncStep(activeIndex, false);
        });
      });
      syncStep(0, false);
    });
  }

  /* 5. Form UX: Dirty-state save bar, password strength, cron human preview, local time tooltips, table pagination */
  var boundDirty = new WeakSet();
  var dirtyTrackers = [];
  function workspaceFormKind(form) {
    if (form.hasAttribute('data-domain-php-form')) return 'domain-php';
    if (form.hasAttribute('data-server-settings-form')) return 'server-settings';
    if (form.hasAttribute('data-setup-wizard-form')) return 'setup';
    if (form.hasAttribute('data-reseller-update-form')) return 'reseller';
    if (form.hasAttribute('data-reseller-owner-form')) return 'account-owner';
    if (form.hasAttribute('data-account-plan-form')) return 'account-plan';
    if (form.hasAttribute('data-firewall-port-rule-form')) return 'firewall-port-rule';
    if (form.hasAttribute('data-feature-list-create-form') || form.hasAttribute('data-feature-list-update-form')) return 'feature-list';
    return form.getAttribute('data-dirty-track') || '';
  }
  function pruneDirtyTrackers() {
    dirtyTrackers = dirtyTrackers.filter(function (entry) { return document.body && document.body.contains(entry.form); });
  }
  window.addEventListener('xpanel:workspace-stored', function (ev) {
    pruneDirtyTrackers();
    var kind = ev && ev.detail && typeof ev.detail.form === 'string' ? ev.detail.form : '';
    if (!kind) return;
    dirtyTrackers.forEach(function (entry) {
      if (entry.kind === kind) entry.commitBaseline();
    });
  });
  document.addEventListener('keydown', function (ev) {
    if (!(ev.ctrlKey || ev.metaKey) || !ev.key || ev.key.toLowerCase() !== 's') return;
    pruneDirtyTrackers();
    for (var i = 0; i < dirtyTrackers.length; i++) {
      var entry = dirtyTrackers[i];
      if (!entry.bar.hidden) {
        ev.preventDefault();
        entry.triggerSave();
        return;
      }
    }
  });
  function bindDirtyForms(root) {
    pruneDirtyTrackers();
    root.querySelectorAll('form[data-dirty-track], form[data-server-settings-form]').forEach(function (form) {
      if (boundDirty.has(form)) return;
      boundDirty.add(form);
      var controls = function () {
        return Array.prototype.slice.call(form.querySelectorAll('input:not([type=hidden]):not([type=file]), select, textarea'));
      };
      var comboboxHiddenFor = function (el) {
        if (!el || el.getAttribute('role') !== 'combobox') return null;
        var box = el.closest('[data-ds-combobox]');
        return box ? box.querySelector('[data-ds-combobox-hidden]') : null;
      };
      var valueOf = function (el) {
        if (el.type === 'checkbox' || el.type === 'radio') return el.checked ? '1' : '0';
        var comboHidden = comboboxHiddenFor(el);
        if (comboHidden) return JSON.stringify([String(el.value), String(comboHidden.value)]);
        return String(el.value);
      };
      var snapshot = new Map();
      function takeSnapshot() {
        snapshot.clear();
        controls().forEach(function (el) { snapshot.set(el, valueOf(el)); });
      }
      takeSnapshot();

      var bar = document.createElement('div');
      bar.className = 'v2-save-bar';
      bar.setAttribute('role', 'status');
      bar.hidden = true;
      bar.innerHTML = '<span class="v2-save-bar__info"><span class="v2-save-bar__dot" aria-hidden="true"></span><span data-dirty-count></span></span>'
        + '<span class="v2-save-bar__actions"><button type="button" class="v2-btn" data-dirty-discard>' + esc(t('Discard')) + '</button>'
        + '<button type="button" class="v2-btn v2-btn--primary" data-dirty-save>' + esc(t('Save changes')) + ' <kbd>Ctrl S</kbd></button></span>';
      form.appendChild(bar);
      var countEl = bar.querySelector('[data-dirty-count]');

      function countChanged() {
        var changed = 0;
        var changedRadioGroups = new Set();
        controls().forEach(function (el) {
          if (!snapshot.has(el) || snapshot.get(el) === valueOf(el)) return;
          if (el.type === 'radio' && el.name) {
            if (!changedRadioGroups.has(el.name)) {
              changedRadioGroups.add(el.name);
              changed++;
            }
          } else {
            changed++;
          }
        });
        return changed;
      }
      function updateBar() {
        var changed = countChanged();
        bar.hidden = changed === 0;
        if (countEl) {
          countEl.textContent = changed === 1
            ? t('1 unsaved change')
            : t('{count} unsaved changes', { count: changed });
        }
      }
      function commitBaseline() {
        takeSnapshot();
        updateBar();
      }
      function triggerSave() {
        var submit = form.querySelector('button[type="submit"]:not(:disabled)');
        if (submit) submit.click();
        else if (typeof form.requestSubmit === 'function') form.requestSubmit();
      }
      form.addEventListener('input', updateBar);
      form.addEventListener('change', updateBar);
      form.addEventListener('reset', function () { setTimeout(updateBar, 0); });
      form.addEventListener('xpanel:form-saved', commitBaseline);
      bar.querySelector('[data-dirty-discard]').addEventListener('click', function () {
        var restored = [];
        controls().forEach(function (el) {
          if (!snapshot.has(el)) return;
          var original = snapshot.get(el);
          if (valueOf(el) === original) return;
          var comboHidden = comboboxHiddenFor(el);
          if (el.type === 'checkbox' || el.type === 'radio') {
            el.checked = original === '1';
            restored.push(el);
          } else if (comboHidden) {
            var pair = JSON.parse(original);
            var hiddenChanged = comboHidden.value !== pair[1];
            el.value = pair[0];
            comboHidden.value = pair[1];
            restored.push(el);
            if (hiddenChanged) restored.push(comboHidden);
          } else {
            el.value = original;
            restored.push(el);
          }
        });
        restored.forEach(function (el) {
          if (el.type !== 'radio' || el.checked) el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        updateBar();
      });
      bar.querySelector('[data-dirty-save]').addEventListener('click', triggerSave);
      dirtyTrackers.push({ form: form, kind: workspaceFormKind(form), bar: bar, commitBaseline: commitBaseline, triggerSave: triggerSave });
    });
  }

  var boundPasswords = new WeakSet();
  function bindPasswordMeters(root) {
    root.querySelectorAll('input[type="password"][autocomplete="new-password"], input[data-password-strength]').forEach(function (input) {
      if (boundPasswords.has(input)) return;
      boundPasswords.add(input);
      var host = input.closest('.v2-field') || input.parentElement;
      if (!host || host.querySelector('.v2-password-meter')) return;
      var meter = document.createElement('div');
      meter.className = 'v2-password-meter';
      meter.hidden = true;
      meter.innerHTML = '<div class="v2-password-meter__track" aria-hidden="true"><span class="v2-password-meter__seg"></span><span class="v2-password-meter__seg"></span><span class="v2-password-meter__seg"></span><span class="v2-password-meter__seg"></span></div><span class="v2-password-meter__label" aria-live="polite"></span>';
      host.appendChild(meter);
      var label = meter.querySelector('.v2-password-meter__label');
      function evaluate() {
        var value = input.value || '';
        if (!value) { meter.hidden = true; return; }
        meter.hidden = false;
        var score = 1;
        if (value.length >= 8) score++;
        if (/[A-Z]/.test(value) && /[a-z]/.test(value) && /\d/.test(value)) score++;
        if (value.length >= 14 || (/[^A-Za-z0-9]/.test(value) && value.length >= 10)) score++;
        if (score > 4) score = 4;
        meter.setAttribute('data-strength', String(score));
        var names = ['', t('Weak'), t('Fair'), t('Good'), t('Strong')];
        if (label) label.textContent = t('Password strength: {level}', { level: names[score] });
      }
      input.addEventListener('input', evaluate);
      input.addEventListener('change', evaluate);
    });
  }

  function describeCron(expr) {
    var raw = String(expr || '').trim();
    if (!raw) return '';
    var map = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *' };
    var parts = (map[raw.toLowerCase()] || raw).split(/\s+/);
    if (parts.length !== 5) return '';
    var pad = function (value) { return value.length === 1 ? '0' + value : value; };
    var min = parts[0], hr = parts[1], dom = parts[2], mon = parts[3], dow = parts[4];
    if (/^\*\/(\d+)$/.test(min) && hr === '*' && dom === '*' && mon === '*' && dow === '*') {
      return t('Every {step} minutes', { step: min.slice(2) });
    }
    if (min === '*' && hr === '*' && dom === '*' && mon === '*' && dow === '*') return t('Every minute');
    if (/^\d{1,2}$/.test(min) && hr === '*' && dom === '*' && mon === '*' && dow === '*') {
      return t('Every hour at :{minute}', { minute: pad(min) });
    }
    if (/^\d{1,2}$/.test(min) && /^\d{1,2}$/.test(hr) && dom === '*' && mon === '*') {
      var clock = pad(hr) + ':' + pad(min) + ' UTC';
      if (dow === '*') return t('Daily at {clock}', { clock: clock });
      var days = [t('Sunday'), t('Monday'), t('Tuesday'), t('Wednesday'), t('Thursday'), t('Friday'), t('Saturday'), t('Sunday')];
      if (/^[0-7]$/.test(dow)) return t('Weekly on {day} at {clock}', { day: days[Number(dow)], clock: clock });
    }
    if (/^\d{1,2}$/.test(min) && /^\d{1,2}$/.test(hr) && /^\d{1,2}$/.test(dom) && mon === '*' && dow === '*') {
      var monthlyClock = pad(hr) + ':' + pad(min) + ' UTC';
      return t('Monthly on day {day} at {clock}', { day: dom, clock: monthlyClock });
    }
    return '';
  }

  var boundCron = new WeakSet();
  function bindCronPreviews(root) {
    root.querySelectorAll('input[data-cron-schedule], input[name*="cron" i], input[name*="scheduleExpression" i], input[id*="cron" i]').forEach(function (input) {
      if (boundCron.has(input) || input.type === 'hidden' || input.type === 'checkbox' || (input.closest && input.closest('[data-ds-cron-builder]'))) return;
      boundCron.add(input);
      var host = input.closest('.v2-field') || input.parentElement;
      if (!host || host.querySelector('.v2-cron-preview')) return;
      var out = document.createElement('span');
      out.className = 'v2-cron-preview';
      out.hidden = true;
      host.appendChild(out);
      function refresh() {
        var text = describeCron(input.value);
        out.hidden = !text;
        out.textContent = text;
      }
      input.addEventListener('input', refresh);
      input.addEventListener('change', refresh);
      refresh();
    });
  }

  var TIMEZONE_STORAGE_KEY = 'xpanel.timezone';
  function activeTimeZone() {
    var attr = document.documentElement.getAttribute('data-user-timezone');
    if (attr) return attr;
    try {
      var stored = window.localStorage ? localStorage.getItem(TIMEZONE_STORAGE_KEY) : null;
      if (stored) return stored;
    } catch (_error) {}
    return '';
  }
  function formatDateInTimeZone(date, tz) {
    try {
      var opts = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false };
      if (tz && tz !== 'local') opts.timeZone = tz;
      var parts = new Intl.DateTimeFormat('en-GB', opts).formatToParts(date);
      var map = {};
      parts.forEach(function (part) { map[part.type] = part.value; });
      if (map.year && map.month && map.day && map.hour && map.minute) {
        return map.year + '-' + map.month + '-' + map.day + ' ' + map.hour + ':' + map.minute;
      }
    } catch (_error) {}
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  }
  function enhanceLocalTimes(root) {
    var pref = activeTimeZone();
    var browserTz = '';
    try { browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_error) {}
    root.querySelectorAll('time[datetime]').forEach(function (el) {
      var iso = el.getAttribute('datetime');
      if (!iso) return;
      var date = new Date(iso);
      if (Number.isNaN(date.getTime())) return;
      if (el.getAttribute('data-utc-text') === null) {
        el.setAttribute('data-utc-text', el.textContent || '');
      }
      var targetTz = pref === 'local' ? (browserTz || 'UTC') : (pref || '');
      var localFormatted = formatDateInTimeZone(date, targetTz || 'local');
      var tzLabel = targetTz || browserTz;
      if (targetTz && targetTz !== 'UTC') {
        el.textContent = localFormatted + ' ' + targetTz;
        el.title = 'UTC: ' + date.toISOString();
      } else {
        if (el.getAttribute('data-utc-text') !== null && pref === 'UTC') {
          el.textContent = el.getAttribute('data-utc-text');
        }
        el.title = t('Local time: {time}', { time: localFormatted + (tzLabel ? ' (' + tzLabel + ')' : '') });
      }
    });
    root.querySelectorAll('select[data-user-timezone-select]').forEach(function (sel) {
      if (sel.getAttribute('data-tz-bound') === '1') return;
      sel.setAttribute('data-tz-bound', '1');
      if (pref) sel.value = pref;
      sel.addEventListener('change', function () {
        applyTimeZone(sel.value);
      });
    });
  }
  function applyTimeZone(tz) {
    var clean = typeof tz === 'string' ? tz.trim() : '';
    try {
      if (window.localStorage) {
        if (clean) localStorage.setItem(TIMEZONE_STORAGE_KEY, clean);
        else localStorage.removeItem(TIMEZONE_STORAGE_KEY);
      }
    } catch (_error) {}
    if (clean) document.documentElement.setAttribute('data-user-timezone', clean);
    else document.documentElement.removeAttribute('data-user-timezone');
    enhanceLocalTimes(document);
  }
  window.__xpanelApplyTimeZone = applyTimeZone;

  var SIDEBAR_STORAGE_KEY = 'xpanel.sidebar.collapsed';
  function setSidebarCollapsed(collapsed, persist) {
    var shell = document.querySelector('.v2-shell, .ds-shell');
    if (!shell) return;
    if (collapsed) shell.setAttribute('data-sidebar-collapsed', 'true');
    else shell.removeAttribute('data-sidebar-collapsed');
    document.querySelectorAll('[data-action="toggle-sidebar-collapse"]').forEach(function (btn) {
      btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    });
    if (persist) {
      try { if (window.localStorage) localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? '1' : '0'); } catch (_error) {}
    }
  }
  function toggleSidebarCollapse() {
    var shell = document.querySelector('.v2-shell, .ds-shell');
    if (!shell) return;
    setSidebarCollapsed(shell.getAttribute('data-sidebar-collapsed') !== 'true', true);
  }
  window.__xpanelToggleSidebar = toggleSidebarCollapse;
  function bindSidebarCollapse(root) {
    var shell = document.querySelector('.v2-shell, .ds-shell');
    if (!shell) return;
    try {
      var savedSidebar = window.localStorage ? localStorage.getItem(SIDEBAR_STORAGE_KEY) : null;
      if (savedSidebar === '1') {
        setSidebarCollapsed(true, false);
      } else if (savedSidebar === '0') {
        setSidebarCollapsed(false, false);
      } else {
        var collapsedNow = shell.getAttribute('data-sidebar-collapsed') === 'true';
        document.querySelectorAll('[data-action="toggle-sidebar-collapse"]').forEach(function (btn) {
          btn.setAttribute('aria-expanded', collapsedNow ? 'false' : 'true');
        });
      }
    } catch (_error) {}
    root.querySelectorAll('.v2-side .v2-nav summary, .v2-side .v2-nav a, .ds-sidebar .ds-nav-link').forEach(function (el) {
      if (!el.getAttribute('title')) {
        var label = (el.textContent || '').trim();
        if (label) el.setAttribute('title', label);
      }
    });
    root.querySelectorAll('.v2-side .v2-nav summary').forEach(function (summary) {
      if (summary.getAttribute('data-sidebar-expand-bound') === '1') return;
      summary.setAttribute('data-sidebar-expand-bound', '1');
      summary.addEventListener('click', function () {
        if (shell.getAttribute('data-sidebar-collapsed') === 'true') {
          setSidebarCollapsed(false, true);
        }
      });
    });
    root.querySelectorAll('[data-action="toggle-sidebar-collapse"]').forEach(function (btn) {
      if (btn.getAttribute('data-sidebar-bound') === '1') return;
      btn.setAttribute('data-sidebar-bound', '1');
      btn.addEventListener('click', function () { toggleSidebarCollapse(); });
    });
  }
  document.addEventListener('keydown', function (ev) {
    if (!(ev.ctrlKey || ev.metaKey) || ev.altKey || ev.shiftKey || !ev.key || ev.key.toLowerCase() !== 'b') return;
    var tag = ev.target && ev.target.tagName ? ev.target.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || (ev.target && ev.target.isContentEditable)) return;
    if (!document.querySelector('[data-action="toggle-sidebar-collapse"]')) return;
    ev.preventDefault();
    toggleSidebarCollapse();
  });

  var boundPagers = new WeakSet();
  function isExternallyManagedTable(table, tbody) {
    if (table.hasAttribute('data-no-paginate')) return true;
    if (table.closest('[data-list-filter], [data-whm-table-workspace], [data-whm-filter-table]')) return true;
    var accountsWorkspace = table.closest('[data-accounts-workspace]');
    if (accountsWorkspace && accountsWorkspace.querySelector('[data-account-list-controls]')) return true;
    if (tbody.querySelector('tr[data-list-row], tr[data-account-row]')) return true;
    return false;
  }
  function bindTablePagination(root) {
    root.querySelectorAll('table[data-table-paginate]').forEach(function (table) {
      if (boundPagers.has(table)) return;
      var tbody = table.tBodies && table.tBodies[0];
      if (!tbody || isExternallyManagedTable(table, tbody)) return;
      var pageSize = Number(table.getAttribute('data-page-size')) || 25;
      var page = 1;
      var pagerEl = null;

      function eligibleRows() {
        return Array.prototype.slice.call(tbody.rows).filter(function (row) {
          return !row.hasAttribute('data-table-state') && !row.classList.contains('v2-table__state') && !row.hasAttribute('data-filter-hidden');
        });
      }

      function apply() {
        if (isExternallyManagedTable(table, tbody)) {
          if (pagerEl) pagerEl.hidden = true;
          return;
        }
        var rows = eligibleRows();
        var total = rows.length;
        if (total <= Math.max(pageSize, 30) && !table.hasAttribute('data-table-paginate')) {
          rows.forEach(function (row) { if (row.getAttribute('data-page-hidden') === '1') { row.hidden = false; row.removeAttribute('data-page-hidden'); } });
          if (pagerEl) pagerEl.hidden = true;
          return;
        }
        var pages = Math.max(1, Math.ceil(total / pageSize));
        if (page > pages) page = pages;
        var start = (page - 1) * pageSize;
        var end = Math.min(total, start + pageSize);
        rows.forEach(function (row, idx) {
          var hide = idx < start || idx >= end;
          if (hide) { row.hidden = true; row.setAttribute('data-page-hidden', '1'); }
          else if (row.getAttribute('data-page-hidden') === '1') { row.hidden = false; row.removeAttribute('data-page-hidden'); }
        });
        if (!pagerEl) {
          pagerEl = document.createElement('div');
          pagerEl.className = 'v2-pagination-bar';
          pagerEl.setAttribute('role', 'navigation');
          pagerEl.setAttribute('aria-label', t('Table pagination'));
          var anchor = table.closest('.v2-table-scroll') || table;
          anchor.insertAdjacentElement('afterend', pagerEl);
        }
        pagerEl.hidden = total <= pageSize;
        pagerEl.innerHTML = '<span class="v2-num">' + esc(t('Showing {start}–{end} of {total}', { start: start + 1, end: end, total: total })) + '</span>'
          + '<span class="v2-pagination-bar__controls">'
          + '<button type="button" class="v2-btn" data-pg-prev' + (page <= 1 ? ' disabled' : '') + '>' + esc(t('Previous')) + '</button>'
          + '<span class="v2-num">' + page + ' / ' + pages + '</span>'
          + '<button type="button" class="v2-btn" data-pg-next' + (page >= pages ? ' disabled' : '') + '>' + esc(t('Next')) + '</button>'
          + '</span>';
        var prevBtn = pagerEl.querySelector('[data-pg-prev]');
        var nextBtn = pagerEl.querySelector('[data-pg-next]');
        if (prevBtn) prevBtn.addEventListener('click', function () { if (page > 1) { page--; apply(); } });
        if (nextBtn) nextBtn.addEventListener('click', function () { if (page < pages) { page++; apply(); } });
      }

      boundPagers.add(table);
      apply();
      if (typeof MutationObserver === 'function') {
        var observer = new MutationObserver(function () { page = 1; apply(); });
        observer.observe(tbody, { childList: true });
      }
    });
  }

  /* 6. Drag-and-drop file upload zones and keyboard-accessible sortable lists */
  var boundDropzones = new WeakSet();
  function bindDropzones(root) {
    root.querySelectorAll('[data-file-dropzone]').forEach(function (zone) {
      if (boundDropzones.has(zone)) return;
      boundDropzones.add(zone);
      var scope = zone.closest('form') || zone.closest('[data-file-manager]') || zone.closest('section') || zone.parentElement;
      var fileInput = zone.querySelector('input[type="file"]') || (scope ? scope.querySelector('input[type="file"]') : null);
      var uploadTrigger = scope ? scope.querySelector('[data-action="upload-file"]') : null;
      var queue = zone.querySelector('[data-dropzone-queue]');
      if (!queue) {
        queue = document.createElement('div');
        queue.className = 'v2-dropzone__queue';
        queue.setAttribute('data-dropzone-queue', 'true');
        zone.appendChild(queue);
      }

      function formatSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KiB';
        return (bytes / 1048576).toFixed(2) + ' MiB';
      }

      function triggerPicker() {
        if (uploadTrigger && !uploadTrigger.disabled) {
          uploadTrigger.click();
          return;
        }
        if (fileInput && !fileInput.disabled) fileInput.click();
      }

      function handleFiles(fileList) {
        if (!fileList || !fileList.length || (fileInput && fileInput.disabled) || (uploadTrigger && uploadTrigger.disabled)) return;
        var files = Array.prototype.slice.call(fileList);
        var dropEvent = new CustomEvent('xpanel:files-dropped', { bubbles: true, cancelable: true, detail: { files: files } });
        zone.dispatchEvent(dropEvent);
        if (dropEvent.defaultPrevented || (scope && scope.hasAttribute('data-file-manager'))) {
          queue.innerHTML = '';
          return;
        }
        if (fileInput && typeof DataTransfer === 'function') {
          try {
            var dt = new DataTransfer();
            files.forEach(function (file) { dt.items.add(file); });
            fileInput.files = dt.files;
            fileInput.dispatchEvent(new Event('change', { bubbles: true }));
          } catch (_error) {}
        }
        queue.innerHTML = '';
        files.forEach(function (file) {
          var row = document.createElement('div');
          row.className = 'v2-dropzone__file';
          row.innerHTML = '<div class="v2-dropzone__file-row"><bdi class="v2-mono" dir="ltr">' + esc(file.name) + '</bdi><span class="v2-num v2-muted">' + esc(formatSize(file.size)) + '</span></div>';
          queue.appendChild(row);
        });
      }

      ['dragenter', 'dragover'].forEach(function (name) {
        zone.addEventListener(name, function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          zone.setAttribute('data-drag-over', 'true');
        });
      });
      ['dragleave', 'dragend'].forEach(function (name) {
        zone.addEventListener(name, function () { zone.removeAttribute('data-drag-over'); });
      });
      zone.addEventListener('drop', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        zone.removeAttribute('data-drag-over');
        if (ev.dataTransfer && ev.dataTransfer.files) handleFiles(ev.dataTransfer.files);
      });
      zone.addEventListener('click', function (ev) {
        if (ev.target && ev.target.closest && ev.target.closest('button, input, a')) return;
        triggerPicker();
      });
      zone.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          triggerPicker();
        }
      });
    });
  }

  var boundSortables = new WeakSet();
  function bindSortables(root) {
    root.querySelectorAll('[data-sortable-list]').forEach(function (list) {
      if (boundSortables.has(list)) return;
      boundSortables.add(list);
      var dragged = null;

      function emitOrder() {
        var ids = Array.prototype.map.call(list.querySelectorAll(':scope > [data-sort-id]'), function (el) {
          return el.getAttribute('data-sort-id');
        });
        list.dispatchEvent(new CustomEvent('xpanel:reorder', { bubbles: true, detail: { order: ids } }));
      }

      function sortLocked() {
        return list.getAttribute('data-sort-locked') === 'true';
      }

      list.addEventListener('dragstart', function (ev) {
        if (sortLocked()) { ev.preventDefault(); return; }
        var item = ev.target && ev.target.closest ? ev.target.closest('[data-sort-id]') : null;
        if (!item || item.parentElement !== list) return;
        dragged = item;
        item.setAttribute('data-dragging', 'true');
        if (ev.dataTransfer) { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', item.getAttribute('data-sort-id') || ''); }
      });
      list.addEventListener('dragover', function (ev) {
        if (!dragged || sortLocked()) return;
        ev.preventDefault();
        var over = ev.target && ev.target.closest ? ev.target.closest('[data-sort-id]') : null;
        list.querySelectorAll('[data-drag-target]').forEach(function (el) { el.removeAttribute('data-drag-target'); });
        if (over && over !== dragged && over.parentElement === list) over.setAttribute('data-drag-target', 'true');
      });
      list.addEventListener('drop', function (ev) {
        if (!dragged) return;
        ev.preventDefault();
        if (sortLocked()) {
          dragged.removeAttribute('data-dragging');
          list.querySelectorAll('[data-drag-target]').forEach(function (el) { el.removeAttribute('data-drag-target'); });
          dragged = null;
          return;
        }
        var over = ev.target && ev.target.closest ? ev.target.closest('[data-sort-id]') : null;
        list.querySelectorAll('[data-drag-target]').forEach(function (el) { el.removeAttribute('data-drag-target'); });
        if (over && over !== dragged && over.parentElement === list) {
          list.insertBefore(dragged, over);
          emitOrder();
        }
        dragged.removeAttribute('data-dragging');
        dragged = null;
      });
      list.addEventListener('dragend', function () {
        if (dragged) dragged.removeAttribute('data-dragging');
        list.querySelectorAll('[data-drag-target]').forEach(function (el) { el.removeAttribute('data-drag-target'); });
        dragged = null;
      });
      list.addEventListener('keydown', function (ev) {
        if (sortLocked()) return;
        var item = ev.target && ev.target.closest ? ev.target.closest('[data-sort-id]') : null;
        if (!item || item.parentElement !== list) return;
        if (ev.altKey && ev.key === 'ArrowUp' && item.previousElementSibling) {
          ev.preventDefault();
          list.insertBefore(item, item.previousElementSibling);
          ev.target.focus();
          emitOrder();
        } else if (ev.altKey && ev.key === 'ArrowDown' && item.nextElementSibling) {
          ev.preventDefault();
          list.insertBefore(item.nextElementSibling, item);
          ev.target.focus();
          emitOrder();
        }
      });
    });
  }

  var boundDsWidgets = new WeakSet();
  var dsGlobalBound = false;
  var dialogReturnFocus = new WeakMap();
  var dialogInertNodes = new WeakMap();
  var activeModals = [];
  function ownMenuTrigger(menu) {
    var found = null;
    menu.querySelectorAll('[aria-haspopup="menu"]').forEach(function (el) {
      if (!found && el.closest('[data-ds-menu]') === menu) found = el;
    });
    return found;
  }
  function ownMenuPanel(menu) {
    var found = null;
    menu.querySelectorAll('[role="menu"]').forEach(function (el) {
      if (!found && el.closest('[data-ds-menu]') === menu) found = el;
    });
    return found;
  }
  function ownMenuItems(menu, panel) {
    if (!panel) return [];
    return Array.prototype.slice.call(panel.querySelectorAll('[role="menuitem"]')).filter(function (el) {
      if (el.closest('[data-ds-menu]') !== menu) return false;
      if (el.hidden || el.closest('[hidden]') || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
      try {
        if (typeof el.matches === 'function' && el.matches(':disabled')) return false;
      } catch (_e) {}
      return true;
    });
  }
  function openMenuAndFocus(menu, trigger, panel, target) {
    openMenuPanel(menu, trigger, panel);
    var items = ownMenuItems(menu, panel);
    if (!items.length) return;
    var next = target === 'last' ? items[items.length - 1] : items[0];
    if (next && typeof next.focus === 'function') next.focus();
  }
  function asciiDigits(value) {
    return String(value == null ? '' : value).replace(/[\u0660-\u0669\u06F0-\u06F9]/g, function (ch) {
      return String(ch.charCodeAt(0) & 0xf);
    });
  }
  function isNativeModal(dlg) {
    try {
      return Boolean(dlg && dlg.matches(':modal'));
    } catch (_e) {
      return false;
    }
  }
  function isVisibleModalElement(el) {
    if (
      !el ||
      el.hidden ||
      el.closest('[hidden]') ||
      el.closest('[inert]') ||
      el.hasAttribute('inert') ||
      el.disabled ||
      el.getAttribute('aria-disabled') === 'true'
    ) {
      return false;
    }
    try {
      if (typeof el.matches === 'function' && el.matches(':disabled')) return false;
    } catch (_e) {}
    var d = el.closest('details');
    while (d) {
      if (!d.open && !(el.tagName === 'SUMMARY' && el.parentElement === d)) return false;
      d = d.parentElement ? d.parentElement.closest('details') : null;
    }
    return true;
  }
  function isTabbableModalElement(el) {
    if (!isVisibleModalElement(el)) return false;
    var ti = el.getAttribute('tabindex');
    if (ti !== null && Number(ti) < 0) return false;
    return true;
  }
  function getModalFocusables(dlg) {
    if (!dlg) return [];
    var raw = dlg.querySelectorAll('a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), details > summary:first-of-type, iframe, audio[controls], video[controls], [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex="-1"])');
    return Array.prototype.slice.call(raw).filter(isTabbableModalElement);
  }
  function applyBackgroundInert(dlg) {
    if (!dlg || isNativeModal(dlg) || dialogInertNodes.has(dlg)) return;
    var marked = [];
    var cur = dlg;
    while (cur && cur !== document.body && cur.parentElement) {
      var parent = cur.parentElement;
      var kids = Array.prototype.slice.call(parent.children);
      for (var i = 0; i < kids.length; i++) {
        var sib = kids[i];
        if (sib !== cur && !sib.hasAttribute('inert') && !(sib.tagName === 'DIALOG' && !sib.hasAttribute('open'))) {
          sib.setAttribute('inert', '');
          sib.inert = true;
          marked.push(sib);
        }
      }
      cur = parent;
    }
    dialogInertNodes.set(dlg, marked);
  }
  function releaseBackgroundInert(dlg) {
    if (!dlg) return;
    var marked = dialogInertNodes.get(dlg);
    if (!marked) return;
    for (var i = 0; i < marked.length; i++) {
      marked[i].removeAttribute('inert');
      marked[i].inert = false;
    }
    dialogInertNodes.delete(dlg);
  }
  function removeModalFromStack(dlg) {
    activeModals = activeModals.filter(function (item) {
      return item !== dlg && document.contains(item);
    });
  }
  function cleanupModalDialog(dlg) {
    if (!dlg) return;
    removeModalFromStack(dlg);
    releaseBackgroundInert(dlg);
    var prev = dialogReturnFocus.get(dlg);
    dialogReturnFocus.delete(dlg);
    if (prev && document.contains(prev) && typeof prev.focus === 'function') {
      try { prev.focus(); } catch (_e) {}
    }
  }
  function openModalDialog(dlg) {
    if (!dlg) return;
    var prev = document.activeElement;
    if (prev && !dlg.contains(prev) && !dialogReturnFocus.has(dlg)) {
      dialogReturnFocus.set(dlg, prev);
    }
    dlg.removeAttribute('data-ds-dialog-open');
    dlg.removeAttribute('data-ds-drawer-open');
    dlg.removeAttribute('inert');
    dlg.inert = false;
    if (typeof dlg.showModal === 'function') {
      if (dlg.hasAttribute('open')) dlg.removeAttribute('open');
      try {
        dlg.showModal();
      } catch (_e) {
        dlg.setAttribute('open', '');
      }
    } else {
      dlg.setAttribute('open', '');
    }
    applyBackgroundInert(dlg);
    removeModalFromStack(dlg);
    activeModals.push(dlg);
    if (!dlg.contains(document.activeElement)) {
      var autoFocus = dlg.querySelector('[autofocus]');
      var firstFocusable = autoFocus && isVisibleModalElement(autoFocus) ? autoFocus : getModalFocusables(dlg)[0];
      if (firstFocusable && typeof firstFocusable.focus === 'function') {
        firstFocusable.focus();
      } else {
        if (!dlg.hasAttribute('tabindex')) dlg.setAttribute('tabindex', '-1');
        if (typeof dlg.focus === 'function') dlg.focus();
      }
    }
  }
  function closeModalDialog(dlg) {
    if (!dlg) return;
    dlg.removeAttribute('data-ds-dialog-open');
    dlg.removeAttribute('data-ds-drawer-open');
    if (typeof dlg.close === 'function') {
      try { dlg.close(); } catch (_e) {}
    }
    dlg.removeAttribute('open');
    cleanupModalDialog(dlg);
  }
  function getTopModalDialog() {
    for (var i = activeModals.length - 1; i >= 0; i--) {
      var item = activeModals[i];
      if (item && document.contains(item) && item.hasAttribute('open')) return item;
    }
    var fallback = document.querySelectorAll('dialog.ds-drawer[open], dialog.ds-dialog[open]');
    return fallback.length ? fallback[fallback.length - 1] : null;
  }
  function positionMenuPanel(trigger, panel) {
    if (!trigger || !panel || panel.hidden) return;
    var r = trigger.getBoundingClientRect();
    var pr = panel.getBoundingClientRect();
    var vw = window.innerWidth || document.documentElement.clientWidth || 1024;
    var vh = window.innerHeight || document.documentElement.clientHeight || 768;
    var gap = 4;
    var pad = 8;
    var panelW = pr.width || 220;
    var panelH = pr.height || 0;
    var y = r.bottom + gap;
    if (panelH > 0 && y + panelH > vh - pad && r.top - gap - panelH >= pad) {
      y = r.top - gap - panelH;
    }
    y = Math.max(pad, Math.min(y, Math.max(pad, vh - pad - panelH)));
    var inlineStart;
    if (document.documentElement.dir === 'rtl') {
      var rtlLeft = Math.max(pad, Math.min(r.left, Math.max(pad, vw - pad - panelW)));
      inlineStart = Math.max(pad, Math.min(vw - (rtlLeft + panelW), Math.max(pad, vw - pad - panelW)));
    } else {
      inlineStart = Math.max(pad, Math.min(r.right - panelW, Math.max(pad, vw - pad - panelW)));
    }
    panel.style.setProperty('--ds-menu-x', Math.round(inlineStart) + 'px');
    panel.style.setProperty('--ds-menu-y', Math.round(y) + 'px');
  }
  function closeMenuPanel(trigger, panel, restoreFocus) {
    var hadFocus = Boolean(restoreFocus && document.activeElement && panel && panel.contains(document.activeElement));
    if (panel) {
      if (typeof panel.hidePopover === 'function') {
        try { panel.hidePopover(); } catch (_e) {}
      }
      panel.hidden = true;
      panel.removeAttribute('data-ds-menu-floating');
      panel.style.removeProperty('--ds-menu-x');
      panel.style.removeProperty('--ds-menu-y');
    }
    if (trigger) {
      trigger.setAttribute('aria-expanded', 'false');
      if (hadFocus && typeof trigger.focus === 'function') trigger.focus();
    }
  }
  function openMenuPanel(menu, trigger, panel) {
    document.querySelectorAll('[data-ds-menu]').forEach(function (other) {
      if (other === menu) return;
      closeMenuPanel(ownMenuTrigger(other), ownMenuPanel(other), false);
    });
    panel.hidden = false;
    panel.setAttribute('data-ds-menu-floating', 'true');
    if (typeof panel.showPopover === 'function') {
      if (!panel.hasAttribute('popover')) panel.setAttribute('popover', 'manual');
      try { panel.showPopover(); } catch (_e) {}
    } else {
      panel.removeAttribute('popover');
    }
    trigger.setAttribute('aria-expanded', 'true');
    positionMenuPanel(trigger, panel);
  }
  function repositionOpenMenus(scrollTarget) {
    var vw = window.innerWidth || document.documentElement.clientWidth || 1024;
    var vh = window.innerHeight || document.documentElement.clientHeight || 768;
    document.querySelectorAll('[data-ds-menu]').forEach(function (menu) {
      var trigger = ownMenuTrigger(menu);
      var panel = ownMenuPanel(menu);
      if (!trigger || !panel || panel.hidden) return;
      if (scrollTarget && (scrollTarget === panel || (scrollTarget.nodeType === 1 && panel.contains(scrollTarget)))) return;
      var r = trigger.getBoundingClientRect();
      if ((r.width > 0 || r.height > 0) && (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw)) {
        closeMenuPanel(trigger, panel, false);
        return;
      }
      positionMenuPanel(trigger, panel);
    });
  }
  function closeOpenPopupsIn(scope) {
    var closed = false;
    var rootEl = scope || document;
    var active = document.activeElement;
    rootEl.querySelectorAll('[data-ds-menu]').forEach(function (menu) {
      var trigger = ownMenuTrigger(menu);
      var panel = ownMenuPanel(menu);
      if (panel && !panel.hidden) {
        closed = true;
        closeMenuPanel(trigger, panel, true);
      }
    });
    rootEl.querySelectorAll('[data-ds-combobox]').forEach(function (box) {
      var input = box.querySelector('[role="combobox"]');
      var list = box.querySelector('[role="listbox"]');
      if (list && !list.hidden) {
        closed = true;
        var hadListFocus = Boolean(active && list.contains(active));
        list.hidden = true;
        if (input) {
          input.setAttribute('aria-expanded', 'false');
          input.removeAttribute('aria-activedescendant');
          if (hadListFocus && typeof input.focus === 'function') input.focus();
        }
        box.querySelectorAll('[data-ds-active]').forEach(function (opt) { opt.removeAttribute('data-ds-active'); });
      }
    });
    return closed;
  }
  function bindDesignSystemWidgets(root) {
    if (!dsGlobalBound) {
      dsGlobalBound = true;
      document.addEventListener('click', function (ev) {
        var target = ev.target && ev.target.closest ? ev.target : null;
        if (target) {
          var closeDrawerBtn = target.closest('[data-ds-drawer-close]');
          if (closeDrawerBtn) {
            var ownDrawer = closeDrawerBtn.closest('dialog.ds-drawer');
            if (ownDrawer) {
              closeModalDialog(ownDrawer);
            } else {
              var did = closeDrawerBtn.getAttribute('data-ds-drawer-close');
              if (did) {
                document.querySelectorAll('dialog.ds-drawer').forEach(function (drw) {
                  if (drw.id === did) closeModalDialog(drw);
                });
              }
            }
            return;
          }
          if (target.tagName === 'DIALOG' && target.classList.contains('ds-drawer') && target.hasAttribute('open')) {
            closeModalDialog(target);
            return;
          }
          var closeDialogBtn = target.closest('[data-ds-dialog-close], [data-ds-dialog-cancel]');
          if (closeDialogBtn) {
            var dlg = closeDialogBtn.closest('dialog');
            if (dlg) closeModalDialog(dlg);
            return;
          }
          var dismissToastBtn = target.closest('[data-ds-toast-dismiss]');
          if (dismissToastBtn) {
            var toast = dismissToastBtn.closest('[data-ds-toast]');
            if (toast && toast.parentNode) toast.parentNode.removeChild(toast);
            return;
          }
        }
        if (!target || !target.closest('[data-ds-combobox]')) {
          document.querySelectorAll('[data-ds-combobox]').forEach(function (box) {
            var input = box.querySelector('[role="combobox"]');
            var list = box.querySelector('[role="listbox"]');
            if (input) {
              input.setAttribute('aria-expanded', 'false');
              input.removeAttribute('aria-activedescendant');
            }
            if (list) list.hidden = true;
            box.querySelectorAll('[data-ds-active]').forEach(function (opt) { opt.removeAttribute('data-ds-active'); });
          });
        }
        var clickedMenu = target ? target.closest('[data-ds-menu]') : null;
        var clickedMenuItem = target ? target.closest('[role="menuitem"]') : null;
        if (clickedMenu) {
          if (!clickedMenuItem) return;
          if (clickedMenuItem.disabled || clickedMenuItem.getAttribute('aria-disabled') === 'true') return;
        }
        var restoreMenuFocus = Boolean(clickedMenuItem);
        document.querySelectorAll('[data-ds-menu]').forEach(function (menu) {
          closeMenuPanel(ownMenuTrigger(menu), ownMenuPanel(menu), restoreMenuFocus);
        });
      });
      window.addEventListener('resize', function () {
        repositionOpenMenus(null);
      });
      document.addEventListener('scroll', function (ev) {
        repositionOpenMenus(ev.target);
      }, { capture: true, passive: true });
      document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Tab') {
          var topModal = getTopModalDialog();
          if (topModal) {
            var focusables = getModalFocusables(topModal);
            if (!focusables.length) {
              ev.preventDefault();
              if (!topModal.hasAttribute('tabindex')) topModal.setAttribute('tabindex', '-1');
              if (typeof topModal.focus === 'function') topModal.focus();
              return;
            }
            var firstEl = focusables[0];
            var lastEl = focusables[focusables.length - 1];
            var curFocus = document.activeElement;
            if (!topModal.contains(curFocus)) {
              ev.preventDefault();
              (ev.shiftKey ? lastEl : firstEl).focus();
            } else if (ev.shiftKey && curFocus === firstEl) {
              ev.preventDefault();
              lastEl.focus();
            } else if (!ev.shiftKey && curFocus === lastEl) {
              ev.preventDefault();
              firstEl.focus();
            }
          }
          return;
        }
        if (ev.key !== 'Escape' || ev.defaultPrevented) return;
        var topModalForEsc = getTopModalDialog();
        if (topModalForEsc) {
          if (closeOpenPopupsIn(topModalForEsc)) {
            ev.preventDefault();
            return;
          }
          ev.preventDefault();
          closeModalDialog(topModalForEsc);
          return;
        }
        if (closeOpenPopupsIn(document)) {
          ev.preventDefault();
        }
      });
    }

    root.querySelectorAll('dialog.ds-dialog, dialog.ds-drawer').forEach(function (dlg) {
      if (!boundDsWidgets.has(dlg)) {
        boundDsWidgets.add(dlg);
        dlg.addEventListener('cancel', function (ev) {
          if (closeOpenPopupsIn(dlg)) {
            ev.preventDefault();
            return;
          }
          var currentTop = getTopModalDialog();
          if (currentTop && currentTop !== dlg) {
            ev.preventDefault();
          }
        });
        dlg.addEventListener('close', function () {
          cleanupModalDialog(dlg);
        });
      }
    });
    root.querySelectorAll('dialog.ds-dialog[data-ds-dialog-open="true"], dialog.ds-dialog[open], dialog.ds-drawer[data-ds-drawer-open="true"], dialog.ds-drawer[open]').forEach(function (dlg) {
      if (activeModals.indexOf(dlg) === -1) openModalDialog(dlg);
    });

    root.querySelectorAll('[data-ds-cron-builder]').forEach(function (builder) {
      if (boundDsWidgets.has(builder)) return;
      boundDsWidgets.add(builder);
      var templates = {};
      try { templates = JSON.parse(builder.getAttribute('data-ds-cron-templates') || '{}'); } catch (_e) { templates = {}; }
      var freqEl = builder.querySelector('[name$="[frequency]"]');
      var hourEl = builder.querySelector('[name$="[hour]"]');
      var minuteEl = builder.querySelector('[name$="[minute]"]');
      var dowEl = builder.querySelector('[name$="[dayOfWeek]"]');
      var domEl = builder.querySelector('[name$="[dayOfMonth]"]');
      var customEl = builder.querySelector('[name$="[customExpression]"]');
      var hiddenExprEl = builder.querySelector('[data-ds-cron-expression]');
      var summaryEl = builder.querySelector('[data-ds-cron-summary-text]');
      var codeEl = builder.querySelector('[data-ds-cron-code]');
      var cronSyncing = false;

      var CRON_MACROS = /^(?:@hourly|@daily|@midnight|@weekly|@monthly|@yearly|@annually)$/i;
      var CRON_FIVE_FIELDS = /^[0-9*,/-]+(?:\s+[0-9*,/-]+){2}\s+[0-9A-Za-z*,/-]+\s+[0-9A-Za-z*,/-]+$/;
      function isValidCustomCron(value) {
        return CRON_MACROS.test(value) || CRON_FIVE_FIELDS.test(value);
      }
      function toggleField(name, visible) {
        var wrap = null;
        builder.querySelectorAll('[data-cron-field]').forEach(function (el) {
          if (!wrap && el.getAttribute('data-cron-field') === name) wrap = el;
        });
        if (!wrap) return;
        wrap.hidden = !visible;
        var locked = builder.getAttribute('data-cron-locked') === 'true';
        wrap.querySelectorAll('input, select, textarea').forEach(function (ctrl) {
          ctrl.disabled = !visible || locked;
        });
      }
      function fmt(tpl, vars) {
        return String(tpl || '').replace(/\{(\w+)\}/g, function (_, k) {
          return vars[k] == null ? '' : String(vars[k]);
        });
      }
      function syncCron(emitEvent) {
        var freq = freqEl ? freqEl.value : 'daily';
        var rawM = Number(asciiDigits(minuteEl ? minuteEl.value : 0));
        var rawH = Number(asciiDigits(hourEl ? hourEl.value : 0));
        var rawDow = Number(asciiDigits(dowEl ? dowEl.value : 0));
        var rawDom = Number(asciiDigits(domEl ? domEl.value : 1));
        var m = Number.isFinite(rawM) ? Math.min(59, Math.max(0, Math.floor(rawM))) : 0;
        var h = Number.isFinite(rawH) ? Math.min(23, Math.max(0, Math.floor(rawH))) : 0;
        var dow = Number.isFinite(rawDow) ? Math.min(6, Math.max(0, Math.floor(rawDow))) : 0;
        var dom = Number.isFinite(rawDom) ? Math.min(28, Math.max(1, Math.floor(rawDom))) : 1;

        toggleField('hour', freq !== 'hourly' && freq !== 'custom');
        toggleField('minute', freq !== 'custom');
        toggleField('dow', freq === 'weekly');
        toggleField('dom', freq === 'monthly');
        toggleField('custom', freq === 'custom');

        var expr = m + ' ' + h + ' * * *';
        if (freq === 'hourly') expr = m + ' * * * *';
        else if (freq === 'weekly') expr = m + ' ' + h + ' * * ' + dow;
        else if (freq === 'monthly') expr = m + ' ' + h + ' ' + dom + ' * *';
        else if (freq === 'custom') {
          expr = asciiDigits(customEl ? customEl.value : '').trim();
        }

        if (customEl) {
          customEl.required = freq === 'custom';
          if (typeof customEl.setCustomValidity === 'function') {
            if (freq === 'custom') {
              var rawVal = asciiDigits(customEl.value || '').trim();
              if (rawVal === '' && (customEl.value || '') !== '') {
                customEl.setCustomValidity(templates.customInvalid || 'Enter a valid cron expression');
              } else if (rawVal !== '' && !isValidCustomCron(rawVal)) {
                customEl.setCustomValidity(templates.customInvalid || 'Enter a valid cron expression');
              } else {
                customEl.setCustomValidity('');
              }
            } else {
              customEl.setCustomValidity('');
            }
          }
        }

        var pad = function (n) { return n < 10 ? '0' + n : String(n); };
        var timeText = pad(h) + ':' + pad(m);
        var summaryText = '';
        if (freq === 'hourly') summaryText = fmt(templates.hourly, { m: pad(m) });
        else if (freq === 'daily') summaryText = fmt(templates.daily, { time: timeText });
        else if (freq === 'weekly') {
          var dayName = Array.isArray(templates.days) && templates.days[dow] ? templates.days[dow] : String(dow);
          summaryText = fmt(templates.weekly, { day: dayName, time: timeText });
        } else if (freq === 'monthly') summaryText = fmt(templates.monthly, { dom: String(dom), time: timeText });
        else summaryText = fmt(templates.custom, { expr: expr || '—' });

        if (hiddenExprEl) hiddenExprEl.value = expr;
        if (summaryEl && summaryText) summaryEl.textContent = summaryText;
        if (codeEl) {
          var bdi = codeEl.querySelector('bdi') || document.createElement('bdi');
          bdi.dir = 'ltr';
          bdi.textContent = expr;
          if (!bdi.parentNode) codeEl.replaceChildren(bdi);
        }
        if (emitEvent && !cronSyncing) {
          builder.dispatchEvent(new CustomEvent('xpanel:cron-change', {
            bubbles: true,
            detail: { expression: expr, frequency: freq, hour: h, minute: m, dayOfWeek: dow, dayOfMonth: dom },
          }));
        }
      }

      builder.addEventListener('xpanel:cron-sync', function (ev) {
        var detail = ev && ev.detail ? ev.detail : null;
        var raw = detail && typeof detail.expression === 'string' ? asciiDigits(detail.expression).trim().replace(/\s+/g, ' ') : '';
        if (!raw) return;
        var parts = raw.split(/\s+/);
        cronSyncing = true;
        try {
          if (parts.length === 5 && /^\d+$/.test(parts[0]) && parts[1] === '*' && parts[2] === '*' && parts[3] === '*' && parts[4] === '*') {
            if (freqEl) freqEl.value = 'hourly';
            if (minuteEl) minuteEl.value = String(Math.min(59, Math.max(0, Number(parts[0]))));
          } else if (parts.length === 5 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1]) && parts[2] === '*' && parts[3] === '*' && parts[4] === '*') {
            if (freqEl) freqEl.value = 'daily';
            if (minuteEl) minuteEl.value = String(Math.min(59, Math.max(0, Number(parts[0]))));
            if (hourEl) hourEl.value = String(Math.min(23, Math.max(0, Number(parts[1]))));
          } else if (parts.length === 5 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1]) && parts[2] === '*' && parts[3] === '*' && /^[0-6]$/.test(parts[4])) {
            if (freqEl) freqEl.value = 'weekly';
            if (minuteEl) minuteEl.value = String(Math.min(59, Math.max(0, Number(parts[0]))));
            if (hourEl) hourEl.value = String(Math.min(23, Math.max(0, Number(parts[1]))));
            if (dowEl) dowEl.value = parts[4];
          } else if (parts.length === 5 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1]) && /^(?:[1-9]|1\d|2[0-8])$/.test(parts[2]) && parts[3] === '*' && parts[4] === '*') {
            if (freqEl) freqEl.value = 'monthly';
            if (minuteEl) minuteEl.value = String(Math.min(59, Math.max(0, Number(parts[0]))));
            if (hourEl) hourEl.value = String(Math.min(23, Math.max(0, Number(parts[1]))));
            if (domEl) domEl.value = parts[2];
          } else {
            if (freqEl) freqEl.value = 'custom';
            if (customEl) customEl.value = raw;
          }
          syncCron(false);
        } finally {
          cronSyncing = false;
        }
      });

      [freqEl, hourEl, minuteEl, dowEl, domEl, customEl].forEach(function (ctrl) {
        if (!ctrl) return;
        var emit = function () { syncCron(true); };
        ctrl.addEventListener('input', emit);
        ctrl.addEventListener('change', emit);
      });
      var cronForm = (freqEl && freqEl.form) || builder.closest('form');
      if (cronForm) {
        cronForm.addEventListener('reset', function () {
          setTimeout(function () { syncCron(false); }, 0);
        });
      }
      syncCron(false);
    });

    root.querySelectorAll('[data-ds-menu]').forEach(function (menu) {
      if (boundDsWidgets.has(menu)) return;
      boundDsWidgets.add(menu);
      var trigger = ownMenuTrigger(menu);
      var panel = ownMenuPanel(menu);
      if (!trigger || !panel) return;
      var pointerActivating = false;
      var suppressSpaceClick = false;
      trigger.addEventListener('pointerdown', function () {
        pointerActivating = true;
        suppressSpaceClick = false;
      });
      trigger.addEventListener('mousedown', function () {
        pointerActivating = true;
        suppressSpaceClick = false;
      });
      trigger.addEventListener('keyup', function (ev) {
        if (ev.key === ' ') {
          suppressSpaceClick = true;
          setTimeout(function () { suppressSpaceClick = false; }, 0);
        }
      });
      trigger.addEventListener('click', function (ev) {
        var fromPointer = pointerActivating;
        pointerActivating = false;
        if (suppressSpaceClick) {
          suppressSpaceClick = false;
          return;
        }
        if (trigger.disabled || trigger.getAttribute('aria-disabled') === 'true') return;
        if (panel.hidden) {
          if (!fromPointer && ev.detail === 0) openMenuAndFocus(menu, trigger, panel, 'first');
          else openMenuPanel(menu, trigger, panel);
        } else {
          closeMenuPanel(trigger, panel, false);
        }
      });
      trigger.addEventListener('keydown', function (ev) {
        if (trigger.disabled || trigger.getAttribute('aria-disabled') === 'true') return;
        if (ev.key === 'ArrowDown') {
          ev.preventDefault();
          openMenuAndFocus(menu, trigger, panel, 'first');
        } else if (ev.key === 'ArrowUp') {
          ev.preventDefault();
          openMenuAndFocus(menu, trigger, panel, 'last');
        } else if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          if (panel.hidden) openMenuAndFocus(menu, trigger, panel, 'first');
          else closeMenuPanel(trigger, panel, false);
        } else if (ev.key === 'Escape' && !panel.hidden) {
          ev.preventDefault();
          ev.stopPropagation();
          closeMenuPanel(trigger, panel, false);
        }
      });
      panel.addEventListener('keydown', function (ev) {
        if (panel.hidden) return;
        var items = ownMenuItems(menu, panel);
        var idx = items.indexOf(document.activeElement);
        if (ev.key === 'ArrowDown') {
          ev.preventDefault();
          if (items.length) items[idx === -1 ? 0 : (idx + 1) % items.length].focus();
        } else if (ev.key === 'ArrowUp') {
          ev.preventDefault();
          if (items.length) items[idx === -1 ? items.length - 1 : (idx - 1 + items.length) % items.length].focus();
        } else if (ev.key === 'Home' || ev.key === 'PageUp') {
          ev.preventDefault();
          if (items.length) items[0].focus();
        } else if (ev.key === 'End' || ev.key === 'PageDown') {
          ev.preventDefault();
          if (items.length) items[items.length - 1].focus();
        } else if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopPropagation();
          closeMenuPanel(trigger, panel, true);
        } else if (ev.key === 'Tab') {
          closeMenuPanel(trigger, panel, true);
        } else if (ev.key === ' ' && document.activeElement && document.activeElement.tagName === 'A' && idx !== -1) {
          ev.preventDefault();
          document.activeElement.click();
        }
      });
    });

    root.querySelectorAll('[data-ds-tabs]').forEach(function (tabs) {
      if (boundDsWidgets.has(tabs)) return;
      boundDsWidgets.add(tabs);
      var buttons = Array.prototype.slice.call(tabs.querySelectorAll('[data-ds-tab]')).filter(function (btn) {
        return btn.closest('[data-ds-tabs]') === tabs;
      });
      var panels = Array.prototype.slice.call(tabs.querySelectorAll('[data-ds-tabpanel]')).filter(function (panel) {
        return panel.closest('[data-ds-tabs]') === tabs;
      });
      function activate(btn) {
        var targetId = btn.getAttribute('data-ds-tab');
        buttons.forEach(function (b) {
          var match = b === btn;
          b.setAttribute('aria-selected', match ? 'true' : 'false');
          b.setAttribute('tabindex', match ? '0' : '-1');
        });
        panels.forEach(function (p) {
          p.hidden = p.getAttribute('data-ds-tabpanel') !== targetId;
        });
      }
      buttons.forEach(function (btn, idx) {
        btn.addEventListener('click', function () { activate(btn); });
        btn.addEventListener('keydown', function (ev) {
          var isRtl = document.documentElement.dir === 'rtl';
          var next = null;
          if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
            var forward = isRtl ? ev.key === 'ArrowLeft' : ev.key === 'ArrowRight';
            var step = forward ? 1 : -1;
            next = buttons[(idx + step + buttons.length) % buttons.length];
          } else if (ev.key === 'Home') {
            next = buttons[0];
          } else if (ev.key === 'End') {
            next = buttons[buttons.length - 1];
          }
          if (next) {
            ev.preventDefault();
            activate(next);
            next.focus();
          }
        });
      });
    });

    root.querySelectorAll('[data-ds-combobox]').forEach(function (box) {
      if (boundDsWidgets.has(box)) return;
      boundDsWidgets.add(box);
      var input = box.querySelector('[role="combobox"]');
      var hidden = box.querySelector('[data-ds-combobox-hidden]');
      var list = box.querySelector('[role="listbox"]');
      if (!input || !list) return;
      var options = Array.prototype.slice.call(list.querySelectorAll('[role="option"]'));
      var activeOption = null;
      var initialValue = hidden ? hidden.value : '';
      var initialLabel = input.value || '';
      var baselineValue = initialValue;
      var baselineLabel = initialLabel;
      var selectedLabel = (hidden && hidden.value) ? (input.value || '') : '';

      function optionValue(opt) {
        return opt.getAttribute('data-ds-combobox-value') || '';
      }
      function optionLabel(opt) {
        var lbl = opt.querySelector('span');
        return lbl ? (lbl.textContent || optionValue(opt)) : optionValue(opt);
      }
      function visibleOptions() {
        return options.filter(function (opt) { return !opt.hidden; });
      }
      function setActiveOption(opt) {
        activeOption = opt || null;
        options.forEach(function (o) {
          if (o === activeOption) o.setAttribute('data-ds-active', 'true');
          else o.removeAttribute('data-ds-active');
        });
        if (activeOption && activeOption.id) input.setAttribute('aria-activedescendant', activeOption.id);
        else input.removeAttribute('aria-activedescendant');
      }
      function openList() {
        list.hidden = false;
        input.setAttribute('aria-expanded', 'true');
      }
      function closeList() {
        list.hidden = true;
        input.setAttribute('aria-expanded', 'false');
        setActiveOption(null);
      }
      function filterOptions(showAll) {
        var q = showAll ? '' : (input.value || '').trim().toLowerCase();
        options.forEach(function (opt) {
          opt.hidden = q.length > 0 && (opt.textContent || '').toLowerCase().indexOf(q) === -1;
        });
        var vis = visibleOptions();
        if (!vis.length) {
          setActiveOption(null);
        } else {
          var selectedOpt = null;
          if (showAll) {
            for (var si = 0; si < vis.length; si++) {
              if (vis[si].getAttribute('aria-selected') === 'true') {
                selectedOpt = vis[si];
                break;
              }
            }
          }
          if (selectedOpt) setActiveOption(selectedOpt);
          else if (!activeOption || vis.indexOf(activeOption) === -1) setActiveOption(vis[0]);
        }
      }
      function syncFromInputValue(preferredValue) {
        var currentVal = input.value || '';
        var matches = options.filter(function (opt) {
          return optionLabel(opt) === currentVal;
        });
        var matched = null;
        if (matches.length === 1) {
          matched = matches[0];
        } else if (matches.length > 1) {
          var candidates = [];
          if (preferredValue) candidates.push(preferredValue);
          if (hidden && hidden.value) candidates.push(hidden.value);
          if (baselineValue) candidates.push(baselineValue);
          if (initialValue) candidates.push(initialValue);
          for (var ci = 0; ci < candidates.length && !matched; ci++) {
            for (var mi = 0; mi < matches.length; mi++) {
              if (optionValue(matches[mi]) === candidates[ci]) {
                matched = matches[mi];
                break;
              }
            }
          }
          if (!matched) matched = matches[0];
        }

        var nextVal = '';
        var nextSelectedLabel = '';
        if (matched) {
          nextVal = optionValue(matched);
          nextSelectedLabel = currentVal;
        } else if (currentVal === baselineLabel && baselineValue !== '') {
          nextVal = baselineValue;
          nextSelectedLabel = baselineLabel;
        } else if (currentVal === initialLabel && initialValue !== '') {
          nextVal = initialValue;
          nextSelectedLabel = initialLabel;
        }

        selectedLabel = nextSelectedLabel;
        options.forEach(function (opt) {
          var isSelected = matched ? opt === matched : (nextVal !== '' && optionValue(opt) === nextVal);
          opt.setAttribute('aria-selected', isSelected ? 'true' : 'false');
        });
        if (hidden && hidden.value !== nextVal) {
          hidden.value = nextVal;
          hidden.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      function selectOption(opt) {
        if (!opt) return;
        var val = optionValue(opt);
        input.value = optionLabel(opt);
        selectedLabel = input.value;
        if (hidden) {
          hidden.value = val;
          hidden.dispatchEvent(new Event('change', { bubbles: true }));
        }
        options.forEach(function (o) { o.setAttribute('aria-selected', o === opt ? 'true' : 'false'); });
        closeList();
      }

      input.addEventListener('focus', function () {
        if (input.disabled) return;
        openList();
        filterOptions(Boolean(selectedLabel && input.value === selectedLabel));
      });
      input.addEventListener('click', function () {
        if (input.disabled || !list.hidden) return;
        openList();
        filterOptions(Boolean(selectedLabel && input.value === selectedLabel));
      });
      input.addEventListener('input', function () {
        if (input.disabled) return;
        if (hidden && hidden.value !== '' && input.value !== selectedLabel) {
          hidden.value = '';
          selectedLabel = '';
          options.forEach(function (o) { o.setAttribute('aria-selected', 'false'); });
          hidden.dispatchEvent(new Event('change', { bubbles: true }));
        }
        openList();
        filterOptions();
      });
      input.addEventListener('change', function () {
        syncFromInputValue('');
      });
      var comboForm = input.form || box.closest('form');
      if (comboForm) {
        comboForm.addEventListener('xpanel:form-saved', function () {
          baselineValue = hidden ? hidden.value : '';
          baselineLabel = input.value || '';
        });
        comboForm.addEventListener('reset', function () {
          setTimeout(function () {
            syncFromInputValue(initialValue);
            closeList();
          }, 0);
        });
      }
      input.addEventListener('keydown', function (ev) {
        if (input.disabled) return;
        var vis = visibleOptions();
        if (ev.key === 'ArrowDown') {
          ev.preventDefault();
          if (list.hidden) openList();
          if (vis.length) {
            var curDown = activeOption ? vis.indexOf(activeOption) : -1;
            setActiveOption(vis[(curDown + 1) % vis.length]);
          }
        } else if (ev.key === 'ArrowUp') {
          ev.preventDefault();
          if (list.hidden) openList();
          if (vis.length) {
            var curUp = activeOption ? vis.indexOf(activeOption) : 0;
            setActiveOption(vis[(curUp - 1 + vis.length) % vis.length]);
          }
        } else if (ev.key === 'Home' && !list.hidden) {
          if (vis.length) {
            ev.preventDefault();
            setActiveOption(vis[0]);
          }
        } else if (ev.key === 'End' && !list.hidden) {
          if (vis.length) {
            ev.preventDefault();
            setActiveOption(vis[vis.length - 1]);
          }
        } else if (ev.key === 'Enter' && !list.hidden) {
          var chosen = activeOption && !activeOption.hidden ? activeOption : vis[0];
          if (chosen) {
            ev.preventDefault();
            selectOption(chosen);
          }
        } else if (ev.key === 'Escape' && !list.hidden) {
          ev.preventDefault();
          ev.stopPropagation();
          closeList();
        } else if (ev.key === 'Tab' && !list.hidden) {
          closeList();
        }
      });
      options.forEach(function (opt) {
        opt.addEventListener('click', function () {
          if (input.disabled) return;
          selectOption(opt);
        });
      });
    });

    root.querySelectorAll('[data-ds-wizard]').forEach(function (wiz) {
      if (boundDsWidgets.has(wiz)) return;
      boundDsWidgets.add(wiz);
      var panels = Array.prototype.slice.call(wiz.querySelectorAll('[data-ds-wizard-step]')).filter(function (el) {
        return el.closest('[data-ds-wizard]') === wiz;
      });
      if (!panels.length) return;
      var stepper = Array.prototype.slice.call(wiz.querySelectorAll('[data-ds-wizard-stepper]')).filter(function (el) {
        return el.closest('[data-ds-wizard]') === wiz;
      })[0] || null;
      var navItems = stepper
        ? Array.prototype.slice.call(stepper.querySelectorAll('.ds-stepper__item')).filter(function (el) {
          return el.closest('[data-ds-wizard-stepper]') === stepper;
        })
        : [];
      var prevBtn = Array.prototype.slice.call(wiz.querySelectorAll('[data-ds-wizard-prev]')).filter(function (el) {
        return el.closest('[data-ds-wizard]') === wiz;
      })[0] || null;
      var nextBtn = Array.prototype.slice.call(wiz.querySelectorAll('[data-ds-wizard-next]')).filter(function (el) {
        return el.closest('[data-ds-wizard]') === wiz;
      })[0] || null;
      var submitBtn = Array.prototype.slice.call(wiz.querySelectorAll('[data-ds-wizard-submit]')).filter(function (el) {
        return el.closest('[data-ds-wizard]') === wiz;
      })[0] || null;
      var submitTargetSel = submitBtn ? submitBtn.getAttribute('data-ds-wizard-submit-target') : null;
      var matchesTargetSpec = function (el, spec) {
        var parts = String(spec || '').trim().split(/\s+/);
        var cur = el;
        for (var p = parts.length - 1; p >= 0; p--) {
          var m = /^\[([a-zA-Z0-9_-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]$/.exec(parts[p]);
          if (!m) return false;
          var attrName = m[1];
          var wantVal = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
          while (cur && cur !== wiz.parentNode) {
            var has = cur.hasAttribute && cur.hasAttribute(attrName);
            var ok = has && (wantVal === undefined || cur.getAttribute(attrName) === wantVal);
            if (ok) break;
            if (p === parts.length - 1) return false;
            cur = cur.parentElement;
          }
          if (!cur || cur === wiz.parentNode) return false;
          cur = cur.parentElement;
        }
        return true;
      };
      var resolveSubmitTarget = function () {
        if (!submitTargetSel) return null;
        var buttons = wiz.querySelectorAll('button');
        for (var i = 0; i < buttons.length; i++) {
          if (matchesTargetSpec(buttons[i], submitTargetSel)) return buttons[i];
        }
        return null;
      };
      var syncSubmitTargetDisabled = function () {
        if (!submitBtn || !submitTargetSel) return;
        var wantDisabled = activeIndex < panels.length - 1;
        if (!wantDisabled) {
          var tgt = resolveSubmitTarget();
          wantDisabled = tgt ? Boolean(tgt.disabled) : true;
        }
        if (submitBtn.disabled !== wantDisabled) submitBtn.disabled = wantDisabled;
      };
      var activeIndex = Math.max(0, Math.min(panels.length - 1, Number(wiz.getAttribute('data-active-step') || 0) || 0));

      function firstInvalidControl(panel) {
        if (!panel) return null;
        var ctrls = Array.prototype.slice.call(panel.querySelectorAll('input, select, textarea'));
        for (var i = 0; i < ctrls.length; i++) {
          if (!ctrls[i].disabled && typeof ctrls[i].checkValidity === 'function' && !ctrls[i].checkValidity()) {
            return ctrls[i];
          }
        }
        return null;
      }
      function showStep(nextIdx) {
        activeIndex = Math.max(0, Math.min(panels.length - 1, nextIdx));
        wiz.setAttribute('data-active-step', String(activeIndex));
        panels.forEach(function (p, i) { p.hidden = i !== activeIndex; });
        navItems.forEach(function (item, i) {
          item.setAttribute('data-step-state', i < activeIndex ? 'done' : i === activeIndex ? 'current' : 'upcoming');
          if (i === activeIndex) item.setAttribute('aria-current', 'step');
          else item.removeAttribute('aria-current');
        });
        if (prevBtn) prevBtn.disabled = activeIndex === 0;
        if (nextBtn) {
          nextBtn.hidden = activeIndex >= panels.length - 1;
          nextBtn.disabled = activeIndex >= panels.length - 1;
        }
        if (submitBtn) {
          submitBtn.hidden = activeIndex < panels.length - 1;
          submitBtn.disabled = activeIndex < panels.length - 1;
          syncSubmitTargetDisabled();
        }
      }
      function advanceStep() {
        var invalid = firstInvalidControl(panels[activeIndex]);
        if (invalid) {
          if (typeof invalid.reportValidity === 'function') invalid.reportValidity();
          return false;
        }
        if (activeIndex < panels.length - 1) {
          showStep(activeIndex + 1);
          return true;
        }
        return false;
      }
      function validateWizardForSubmit(ev) {
        if (activeIndex < panels.length - 1) {
          ev.preventDefault();
          advanceStep();
          return;
        }
        for (var pIdx = 0; pIdx < panels.length; pIdx++) {
          var bad = firstInvalidControl(panels[pIdx]);
          if (bad) {
            ev.preventDefault();
            if (pIdx !== activeIndex) showStep(pIdx);
            if (typeof bad.reportValidity === 'function') bad.reportValidity();
            return;
          }
        }
        if (submitTargetSel) {
          ev.preventDefault();
          var targetAction = resolveSubmitTarget();
          if (!targetAction || targetAction.disabled) return;
          targetAction.click();
        }
      }

      if (prevBtn) {
        prevBtn.addEventListener('click', function () {
          showStep(activeIndex - 1);
        });
      }
      navItems.forEach(function (item, idx) {
        item.addEventListener('click', function () {
          if (idx < activeIndex) showStep(idx);
        });
      });
      if (nextBtn) {
        nextBtn.addEventListener('click', function () {
          advanceStep();
        });
      }
      var syncDiffPreview = function () {
        var diffSection = Array.prototype.slice.call(wiz.querySelectorAll('[data-ds-wizard-diff]')).filter(function (el) {
          return el.closest('[data-ds-wizard]') === wiz;
        })[0] || null;
        if (!diffSection) return;
        diffSection.querySelectorAll('[data-ds-diff-source]').forEach(function (cell) {
          var fieldName = cell.getAttribute('data-ds-diff-source');
          if (!fieldName) return;
          var ctrl = Array.prototype.find.call(wiz.querySelectorAll('[name]'), function (el) {
            return el.getAttribute('name') === fieldName;
          });
          if (!ctrl) return;
          var val = ctrl.type === 'checkbox' ? (ctrl.checked ? 'on' : 'off') : String(ctrl.value || '').trim();
          if (val) cell.textContent = val;
        });
      };
      wiz.addEventListener('input', syncDiffPreview);
      wiz.addEventListener('change', syncDiffPreview);
      document.addEventListener('xpanel:ws-event', function (ev) {
        var detail = ev && ev.detail;
        var payload = detail && detail.data && typeof detail.data === 'object' ? detail.data : null;
        if (!detail || detail.kind !== 'job.updated' || !payload) return;
        var prog = Array.prototype.slice.call(wiz.querySelectorAll('[data-ds-wizard-progress]')).filter(function (el) {
          return el.closest('[data-ds-wizard]') === wiz;
        })[0] || null;
        if (!prog) return;
        var targetStep = payload.stepId
          ? Array.prototype.find.call(prog.querySelectorAll('[data-ds-progress-step]'), function (el) {
              return el.getAttribute('data-ds-progress-step') === String(payload.stepId);
            })
          : prog.querySelector('.ds-stepper__item[data-step-state="running"], .ds-stepper__item[data-step-state="upcoming"]');
        if (targetStep) {
          var mapped = payload.status === 'succeeded' ? 'done' : payload.status === 'failed' || payload.status === 'cancelled' ? 'failed' : 'running';
          targetStep.setAttribute('data-step-state', mapped);
        }
      });
      if (submitBtn) {
        submitBtn.addEventListener('click', validateWizardForSubmit);
      }
      var owningForm = (submitBtn && submitBtn.form) || wiz.closest('form');
      if (owningForm) {
        owningForm.addEventListener('submit', function (ev) {
          if (ev.submitter && ev.submitter !== submitBtn && !wiz.contains(ev.submitter)) return;
          validateWizardForSubmit(ev);
        });
      }
      wiz.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter' || ev.defaultPrevented || activeIndex >= panels.length - 1) return;
        var target = ev.target;
        if (!target || target.tagName !== 'INPUT') return;
        var inputType = String(target.type || 'text').toLowerCase();
        if (inputType === 'button' || inputType === 'submit' || inputType === 'reset' || inputType === 'checkbox' || inputType === 'radio') return;
        if (target.closest('[data-ds-wizard]') !== wiz || target.closest('[data-ds-combobox]')) return;
        ev.preventDefault();
        advanceStep();
      });
      function syncWizardToHash(hash) {
        var raw = typeof hash === 'string' && hash.charAt(0) === '#' ? hash.slice(1) : '';
        if (!raw) return;
        var el = null;
        wiz.querySelectorAll('[id]').forEach(function (node) {
          if (!el && node.id === raw) el = node;
        });
        if (!el) return;
        for (var i = 0; i < panels.length; i++) {
          if (panels[i] === el || panels[i].contains(el)) {
            showStep(i);
            return;
          }
        }
      }
      var hashScope = wiz.closest('[data-setup-stepper]') || wiz;
      hashScope.addEventListener('click', function (ev) {
        var target = ev.target && ev.target.closest ? ev.target.closest('a[href^="#"]') : null;
        if (!target) return;
        syncWizardToHash(target.getAttribute('href'));
      });
      window.addEventListener('hashchange', function () {
        syncWizardToHash(window.location.hash);
      });
      if (submitTargetSel && typeof MutationObserver === 'function') {
        var targetObserver = new MutationObserver(syncSubmitTargetDisabled);
        targetObserver.observe(wiz, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled'] });
      }
      wiz.addEventListener('xpanel:wizard-step', function (ev) {
        var detail = ev && ev.detail ? ev.detail : null;
        var idx = detail && typeof detail.step === 'number' ? detail.step : Number(detail && detail.step);
        if (Number.isInteger(idx)) showStep(idx);
      });
      showStep(activeIndex);
      syncWizardToHash(window.location.hash);
    });

    root.querySelectorAll('.ds-table-card').forEach(function (card) {
      if (boundDsWidgets.has(card)) return;
      boundDsWidgets.add(card);
      var pageSize = Math.min(25, Math.max(1, Number(card.getAttribute('data-ds-page-size')) || 25));
      var currentPage = Math.max(1, Number(card.getAttribute('data-ds-current-page')) || 1);
      var tbody = Array.prototype.slice.call(card.querySelectorAll('tbody')).filter(function (el) {
        return el.closest('.ds-table-card') === card;
      })[0] || null;
      var selectAll = Array.prototype.slice.call(card.querySelectorAll('[data-ds-select-all]')).filter(function (el) {
        return el.closest('.ds-table-card') === card;
      })[0] || null;
      var bulkBar = Array.prototype.slice.call(card.querySelectorAll('[data-ds-bulk-bar]')).filter(function (el) {
        return el.closest('.ds-table-card') === card;
      })[0] || null;
      var countEl = Array.prototype.slice.call(card.querySelectorAll('[data-ds-selected-count]')).filter(function (el) {
        return el.closest('.ds-table-card') === card;
      })[0] || null;

      function allRows() {
        return Array.prototype.slice.call(card.querySelectorAll('tbody tr[data-ds-row]')).filter(function (row) {
          return row.closest('.ds-table-card') === card;
        });
      }
      function visibleRows() {
        return allRows().filter(function (row) { return !row.hidden; });
      }
      function ownRowChecks() {
        return Array.prototype.slice.call(card.querySelectorAll('[data-ds-row-select]')).filter(function (cb) {
          return cb.closest('.ds-table-card') === card;
        });
      }
      function syncSelection() {
        var allCheckboxes = ownRowChecks();
        var checkedTotal = allCheckboxes.filter(function (cb) { return cb.checked; }).length;
        if (countEl) countEl.textContent = String(checkedTotal);
        if (bulkBar) bulkBar.hidden = checkedTotal === 0;
        var visCheckboxes = [];
        visibleRows().forEach(function (row) {
          row.querySelectorAll('[data-ds-row-select]').forEach(function (cb) {
            if (cb.closest('.ds-table-card') === card) visCheckboxes.push(cb);
          });
        });
        var visChecked = visCheckboxes.filter(function (cb) { return cb.checked; }).length;
        if (selectAll) {
          selectAll.checked = visCheckboxes.length > 0 && visChecked === visCheckboxes.length;
          selectAll.indeterminate = visChecked > 0 && visChecked < visCheckboxes.length;
        }
      }
      function applyPage(nextPage) {
        var rows = allRows();
        if (rows.length <= pageSize) return;
        var totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
        currentPage = Math.max(1, Math.min(totalPages, nextPage));
        var start = (currentPage - 1) * pageSize;
        var end = start + pageSize;
        rows.forEach(function (row, idx) {
          var hide = idx < start || idx >= end;
          row.hidden = hide;
          if (hide) row.setAttribute('data-ds-page-hidden', 'true');
          else row.removeAttribute('data-ds-page-hidden');
        });
        card.setAttribute('data-ds-current-page', String(currentPage));
        var curEl = Array.prototype.slice.call(card.querySelectorAll('[data-ds-page-current]')).filter(function (el) {
          return el.closest('.ds-table-card') === card;
        })[0] || null;
        var totEl = Array.prototype.slice.call(card.querySelectorAll('[data-ds-page-total]')).filter(function (el) {
          return el.closest('.ds-table-card') === card;
        })[0] || null;
        var prevBtn = Array.prototype.slice.call(card.querySelectorAll('[data-ds-page-prev]')).filter(function (el) {
          return el.closest('.ds-table-card') === card;
        })[0] || null;
        var nextBtn = Array.prototype.slice.call(card.querySelectorAll('[data-ds-page-next]')).filter(function (el) {
          return el.closest('.ds-table-card') === card;
        })[0] || null;
        if (curEl) curEl.textContent = String(currentPage);
        if (totEl) totEl.textContent = String(totalPages);
        if (prevBtn) {
          prevBtn.setAttribute('data-ds-page', String(Math.max(1, currentPage - 1)));
          if ('disabled' in prevBtn) prevBtn.disabled = currentPage <= 1;
        }
        if (nextBtn) {
          nextBtn.setAttribute('data-ds-page', String(Math.min(totalPages, currentPage + 1)));
          if ('disabled' in nextBtn) nextBtn.disabled = currentPage >= totalPages;
        }
        syncSelection();
      }
      function parseSortableNumber(raw) {
        var norm = asciiDigits(raw).replace(/[\u00A0\u202F]/g, ' ').trim();
        if (!norm) return NaN;
        var numMatch = /^([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*%?$/.exec(norm);
        if (numMatch) return Number(numMatch[1].replace(/,/g, ''));
        var byteMatch = /^([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(B|KiB|MiB|GiB|TiB|PiB)(?:\/s)?$/i.exec(norm);
        if (byteMatch) {
          var units = ['b', 'kib', 'mib', 'gib', 'tib', 'pib'];
          var exp = units.indexOf(byteMatch[2].toLowerCase());
          return Number(byteMatch[1].replace(/,/g, '')) * Math.pow(1024, exp);
        }
        return NaN;
      }
      function cellSortValue(row, key) {
        var found = '';
        row.querySelectorAll('[data-ds-col]').forEach(function (td) {
          if (td.closest('tr') === row && td.getAttribute('data-ds-col') === key) {
            var explicit = td.getAttribute('data-ds-sort-value');
            found = (explicit !== null ? explicit : (td.textContent || '')).trim();
          }
        });
        return found;
      }

      if (selectAll) {
        selectAll.addEventListener('change', function () {
          var nextState = Boolean(selectAll.checked);
          visibleRows().forEach(function (row) {
            row.querySelectorAll('[data-ds-row-select]').forEach(function (cb) {
              if (cb.closest('.ds-table-card') === card && !cb.disabled) cb.checked = nextState;
            });
          });
          syncSelection();
        });
      }
      ownRowChecks().forEach(function (cb) {
        cb.addEventListener('change', syncSelection);
      });
      Array.prototype.slice.call(card.querySelectorAll('[data-ds-page]')).filter(function (el) {
        return el.closest('.ds-table-card') === card;
      }).forEach(function (btn) {
        btn.addEventListener('click', function () {
          if (btn.disabled || btn.getAttribute('aria-disabled') === 'true' || (btn.tagName === 'A' && btn.hasAttribute('href'))) return;
          var targetPage = Number(btn.getAttribute('data-ds-page'));
          if (!Number.isFinite(targetPage) || targetPage < 1) return;
          if (allRows().length > pageSize) {
            applyPage(targetPage);
          } else {
            card.dispatchEvent(new CustomEvent('xpanel:table-page', {
              bubbles: true,
              detail: { tableId: card.id, page: targetPage },
            }));
          }
        });
      });
      var sortHeaders = Array.prototype.slice.call(card.querySelectorAll('th[aria-sort]')).filter(function (el) {
        return el.closest('.ds-table-card') === card;
      });
      Array.prototype.slice.call(card.querySelectorAll('[data-ds-sort]')).filter(function (el) {
        return el.closest('.ds-table-card') === card;
      }).forEach(function (sortBtn) {
        sortBtn.addEventListener('click', function () {
          var key = sortBtn.getAttribute('data-ds-sort');
          var th = sortBtn.closest('th');
          if (!key || !th || !tbody) return;
          var currentDir = th.getAttribute('aria-sort') || 'none';
          var nextDir = currentDir === 'ascending' ? 'descending' : 'ascending';
          sortHeaders.forEach(function (h) {
            h.setAttribute('aria-sort', h === th ? nextDir : 'none');
          });
          var indexed = allRows().map(function (row, idx) {
            var val = cellSortValue(row, key);
            var num = parseSortableNumber(val);
            var missing = val === '' || val === '—' || val === '-';
            return { row: row, idx: idx, val: val, num: num, hasNum: Number.isFinite(num), missing: missing };
          });
          var allNumericOrMissing = indexed.some(function (e) { return e.hasNum; })
            && indexed.every(function (e) { return e.hasNum || e.missing; });
          indexed.sort(function (a, b) {
            if (allNumericOrMissing) {
              if (a.missing && b.missing) return a.idx - b.idx;
              if (a.missing) return 1;
              if (b.missing) return -1;
              var diff = a.num - b.num;
              if (nextDir === 'descending') diff = -diff;
              return diff !== 0 ? diff : (a.idx - b.idx);
            }
            var cmp = a.val.localeCompare(b.val, undefined, { numeric: true, sensitivity: 'base' });
            if (nextDir === 'descending') cmp = -cmp;
            return cmp !== 0 ? cmp : (a.idx - b.idx);
          });
          indexed.forEach(function (entry) { tbody.appendChild(entry.row); });
          if (allRows().length > pageSize) applyPage(1);
          card.dispatchEvent(new CustomEvent('xpanel:table-sort', {
            bubbles: true,
            detail: { tableId: card.id, key: key, direction: nextDir },
          }));
        });
      });
    });
  }

  function mountWorkspace(root) {
    var scope = root || document;
    if (scope === document) {
      operations = loadOperations();
      renderOperationsDock();
    }
    bindWizards(scope);
    bindDirtyForms(scope);
    bindPasswordMeters(scope);
    bindCronPreviews(scope);
    bindDesignSystemWidgets(scope);
    enhanceLocalTimes(scope);
    bindSidebarCollapse(scope);
    bindTablePagination(scope);
    bindDropzones(scope);
    bindSortables(scope);
  }
  window.__xpanelMountWorkspace = mountWorkspace;

  function boot() {
    mountWorkspace(document);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
`
