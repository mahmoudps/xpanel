// Workspace interaction runtime:
// - Coalesces concurrent idempotent GET requests and caches short-TTL session metadata
// - Tracks long-running operations across navigations in #xp-ops-dock
// - Provides hover prefetch, navigation progress indication, and in-place soft refresh
// - Drives progressive multi-step wizards, form dirty-state tracking, password strength meters,
//   human-readable cron schedule previews, local-time tooltips, and large-table pagination
// - Drives file dropzones and keyboard-accessible sortable lists
// Served as a same-origin external script under strict CSP (script-src 'self').

export const WORKSPACE_RUNTIME_SCRIPT = /* js */ String.raw`(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__xpanelWorkspaceRuntime) return;
  window.__xpanelWorkspaceRuntime = true;

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
  var CACHEABLE = /^\/api\/(?:auth\/me|ui-preferences|admin\/favorites|admin\/notifications|server\/info|account\/summary)(?:\?.*)?$/;
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
      var valueOf = function (el) {
        return (el.type === 'checkbox' || el.type === 'radio') ? (el.checked ? '1' : '0') : String(el.value);
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
          if (el.type === 'checkbox' || el.type === 'radio') el.checked = original === '1';
          else el.value = original;
          restored.push(el);
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
      if (boundCron.has(input) || input.type === 'hidden' || input.type === 'checkbox') return;
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
    var shell = document.querySelector('.v2-shell');
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
    var shell = document.querySelector('.v2-shell');
    if (!shell) return;
    setSidebarCollapsed(shell.getAttribute('data-sidebar-collapsed') !== 'true', true);
  }
  window.__xpanelToggleSidebar = toggleSidebarCollapse;
  function bindSidebarCollapse(root) {
    var shell = document.querySelector('.v2-shell');
    if (!shell) return;
    try {
      if (window.localStorage && localStorage.getItem(SIDEBAR_STORAGE_KEY) === '1') {
        setSidebarCollapsed(true, false);
      }
    } catch (_error) {}
    root.querySelectorAll('.v2-side .v2-nav summary, .v2-side .v2-nav a').forEach(function (el) {
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

      function handleFiles(fileList) {
        if (!fileList || !fileList.length || (fileInput && fileInput.disabled)) return;
        var files = Array.prototype.slice.call(fileList);
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
          row.innerHTML = '<div class="v2-dropzone__file-row"><bdi class="v2-mono" dir="ltr">' + esc(file.name) + '</bdi><span class="v2-num v2-muted">' + esc(formatSize(file.size)) + '</span></div>'
            + '<div class="v2-ops-item__bar"><span class="v2-ops-item__fill" style="inline-size:100%"></span></div>';
          queue.appendChild(row);
        });
        zone.dispatchEvent(new CustomEvent('xpanel:files-dropped', { bubbles: true, detail: { files: files } }));
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
        if (fileInput && !fileInput.disabled) fileInput.click();
      });
      zone.addEventListener('keydown', function (ev) {
        if ((ev.key === 'Enter' || ev.key === ' ') && fileInput && !fileInput.disabled) {
          ev.preventDefault();
          fileInput.click();
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
