/** Client runtime bindings for shared live-read regions, confirmation dialogs, drawers, and undo toasts. */
export const LIVE_DATA_STORE_SCRIPT = /* js */ String.raw`
  var LIVE_CACHEABLE = /^\/api\/(?:auth\/me|ui-preferences|admin\/favorites|admin\/notifications|server\/info|server\/services|server\/drift|server\/configuration-health|account\/summary|accounts\/preflight|dns\/zones)(?:\?.*)?$/;

  function escLive(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function txt(message, values) {
    if (typeof window.xpT === 'function') return window.xpT(message, values);
    if (!values) return message;
    return String(message).replace(/\{(\w+)\}/g, function (_, k) {
      return values[k] == null ? '' : String(values[k]);
    });
  }

  function showActionToast(options) {
    if (typeof document === 'undefined') return null;
    var region = document.getElementById('xp-toast-region');
    if (!region) {
      region = document.createElement('div');
      region.id = 'xp-toast-region';
      region.className = 'ds-toast-region';
      region.setAttribute('aria-live', 'polite');
      region.setAttribute('aria-atomic', 'true');
      document.body.appendChild(region);
    }
    var id = 'ds-toast-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    var tone = options && options.tone ? options.tone : 'info';
    var toast = document.createElement('div');
    toast.className = 'ds-toast' + (tone !== 'info' ? ' ds-toast--' + tone : '');
    toast.setAttribute('role', 'status');
    toast.setAttribute('data-ds-toast', id);

    var copy = document.createElement('div');
    var titleEl = document.createElement('strong');
    titleEl.textContent = (options && options.title) || txt('Completed');
    copy.appendChild(titleEl);
    if (options && options.message) {
      var msgEl = document.createElement('p');
      msgEl.className = 'ds-caption';
      msgEl.textContent = options.message;
      copy.appendChild(msgEl);
    }

    var ttl = options && typeof options.durationMs === 'number' ? options.durationMs : 6000;
    var dismissTimer = null;
    var actions = document.createElement('div');
    actions.className = 'ds-page-head__actions';
    if (options && typeof options.onUndo === 'function') {
      var undoBtn = document.createElement('button');
      undoBtn.type = 'button';
      undoBtn.className = 'ds-btn ds-btn--ghost';
      undoBtn.setAttribute('data-ds-toast-undo', id);
      undoBtn.textContent = options.undoLabel || txt('Undo');
      undoBtn.addEventListener('click', function () {
        undoBtn.disabled = true;
        if (dismissTimer) { clearTimeout(dismissTimer); dismissTimer = null; }
        Promise.resolve(options.onUndo()).then(function () {
          if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, function () {
          undoBtn.disabled = false;
          if (ttl > 0) {
            dismissTimer = setTimeout(function () {
              if (toast.parentNode) toast.parentNode.removeChild(toast);
              if (options && typeof options.onDismiss === 'function') options.onDismiss();
            }, ttl);
          }
        });
      });
      actions.appendChild(undoBtn);
    }
    var dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'ds-btn ds-btn--ghost';
    dismissBtn.setAttribute('data-ds-toast-dismiss', id);
    dismissBtn.setAttribute('aria-label', txt('Close'));
    dismissBtn.textContent = '×';
    dismissBtn.addEventListener('click', function () {
      if (dismissTimer) { clearTimeout(dismissTimer); dismissTimer = null; }
      if (toast.parentNode) toast.parentNode.removeChild(toast);
      if (options && typeof options.onDismiss === 'function') options.onDismiss();
    });
    actions.appendChild(dismissBtn);

    toast.appendChild(copy);
    toast.appendChild(actions);
    region.appendChild(toast);
    if (ttl > 0) {
      dismissTimer = setTimeout(function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
        if (options && typeof options.onDismiss === 'function') options.onDismiss();
      }, ttl);
    }
    return toast;
  }

  function openConfirmDialog(options) {
    return new Promise(function (resolve) {
      var dlg = document.createElement('dialog');
      dlg.className = 'ds-dialog';
      dlg.setAttribute('aria-modal', 'true');
      var titleId = 'ds-confirm-' + Date.now();
      dlg.setAttribute('aria-labelledby', titleId);
      var destructive = Boolean(options && options.destructive);
      dlg.innerHTML =
        '<header class="ds-dialog__head">' +
          '<h2 class="ds-card__title" id="' + escLive(titleId) + '">' + escLive((options && options.title) || txt('Confirm action')) + '</h2>' +
          '<button type="button" class="ds-btn ds-btn--ghost" data-ds-dialog-close aria-label="' + escLive(txt('Close')) + '">&times;</button>' +
        '</header>' +
        '<div class="ds-dialog__body">' +
          '<p class="ds-prose">' + escLive((options && options.message) || '') + '</p>' +
          (options && options.detailsHtml ? options.detailsHtml : '') +
        '</div>' +
        '<footer class="ds-dialog__foot">' +
          '<button type="button" class="ds-btn" data-ds-dialog-cancel>' + escLive((options && options.cancelLabel) || txt('Cancel')) + '</button>' +
          '<button type="button" class="ds-btn ' + (destructive ? 'ds-btn--danger' : 'ds-btn--primary') + '" data-ds-dialog-confirm>' + escLive((options && options.confirmLabel) || txt('Confirm')) + '</button>' +
        '</footer>';
      document.body.appendChild(dlg);
      var finish = function (confirmed) {
        if (typeof dlg.close === 'function' && dlg.open) dlg.close();
        if (dlg.parentNode) dlg.parentNode.removeChild(dlg);
        resolve(confirmed);
      };
      dlg.querySelector('[data-ds-dialog-confirm]').addEventListener('click', function () { finish(true); });
      dlg.querySelector('[data-ds-dialog-cancel]').addEventListener('click', function () { finish(false); });
      dlg.querySelector('[data-ds-dialog-close]').addEventListener('click', function () { finish(false); });
      dlg.addEventListener('cancel', function (ev) { ev.preventDefault(); finish(false); });
      if (typeof dlg.showModal === 'function') dlg.showModal();
      else dlg.setAttribute('open', 'open');
    });
  }

  function openActionDrawer(options) {
    var existing = document.getElementById('xp-dynamic-action-drawer');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    var drawer = document.createElement('dialog');
    drawer.id = 'xp-dynamic-action-drawer';
    drawer.className = 'ds-drawer';
    drawer.setAttribute('aria-modal', 'true');
    drawer.setAttribute('aria-labelledby', 'xp-dynamic-action-drawer-title');
    var fieldsHtml = ((options && options.fields) || []).map(function (field, idx) {
      var fid = 'ds-drawer-field-' + idx;
      var ctrl = field.type === 'select'
        ? '<select class="ds-input" id="' + fid + '" name="' + escLive(field.name) + '"' + (field.required ? ' required' : '') + '>' +
            (field.options || []).map(function (o) {
              return '<option value="' + escLive(o.value) + '">' + escLive(o.label) + '</option>';
            }).join('') +
          '</select>'
        : '<input class="ds-input" id="' + fid + '" name="' + escLive(field.name) + '" type="' + escLive(field.type || 'text') + '"' +
            (field.dir ? ' dir="' + escLive(field.dir) + '"' : '') +
            (field.placeholder ? ' placeholder="' + escLive(field.placeholder) + '"' : '') +
            (field.value !== undefined ? ' value="' + escLive(field.value) + '"' : '') +
            (field.required ? ' required' : '') + '>';
      return '<div class="ds-field"><label class="ds-field__label" for="' + fid + '">' + escLive(field.label) + '</label>' + ctrl +
        (field.help ? '<span class="ds-caption">' + escLive(field.help) + '</span>' : '') + '</div>';
    }).join('');
    drawer.innerHTML =
      '<div class="ds-drawer__panel">' +
        '<header class="ds-drawer__head">' +
          '<div>' +
            '<h2 class="ds-card__title" id="xp-dynamic-action-drawer-title">' + escLive((options && options.title) || txt('Run action')) + '</h2>' +
            (options && options.description ? '<p class="ds-caption">' + escLive(options.description) + '</p>' : '') +
          '</div>' +
          '<button type="button" class="ds-btn ds-btn--ghost" data-ds-drawer-close aria-label="' + escLive(txt('Close')) + '">&times;</button>' +
        '</header>' +
        '<form class="ds-drawer__body" data-ds-action-drawer-form>' +
          fieldsHtml +
          '<div class="ds-card ds-card--compact" data-ds-action-drawer-status role="status" hidden></div>' +
          '<footer class="ds-drawer__foot">' +
            '<button type="button" class="ds-btn" data-ds-drawer-close>' + escLive(txt('Cancel')) + '</button>' +
            '<button type="submit" class="ds-btn ds-btn--primary">' + escLive((options && options.submitLabel) || txt('Submit')) + '</button>' +
          '</footer>' +
        '</form>' +
      '</div>';
    document.body.appendChild(drawer);
    var close = function () {
      if (typeof drawer.close === 'function' && drawer.open) drawer.close();
      if (drawer.parentNode) drawer.parentNode.removeChild(drawer);
    };
    drawer.querySelectorAll('[data-ds-drawer-close]').forEach(function (btn) {
      btn.addEventListener('click', close);
    });
    drawer.addEventListener('cancel', function (ev) { ev.preventDefault(); close(); });
    var form = drawer.querySelector('[data-ds-action-drawer-form]');
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var values = {};
      Array.prototype.slice.call(form.elements).forEach(function (el) {
        if (el.name) values[el.name] = el.type === 'checkbox' ? Boolean(el.checked) : String(el.value || '').trim();
      });
      var statusEl = drawer.querySelector('[data-ds-action-drawer-status]');
      var submitBtn = form.querySelector('[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;
      if (statusEl) { statusEl.hidden = false; statusEl.textContent = txt('Running...'); }
      Promise.resolve(options.onSubmit(values))
        .then(function () { close(); })
        .catch(function (err) {
          if (submitBtn) submitBtn.disabled = false;
          if (statusEl) { statusEl.hidden = false; statusEl.textContent = (err && err.message) || txt('Request failed'); }
        });
    });
    if (typeof drawer.showModal === 'function') drawer.showModal();
    else drawer.setAttribute('open', 'open');
    return drawer;
  }

  function resolveEndpoint(template, values) {
    return String(template || '').replace(/\{(\w+)\}/g, function (_, k) {
      return encodeURIComponent(String((values && values[k]) || ''));
    });
  }

  function runCoreActionRequest(spec, values) {
    if (typeof window.xpanelSessionRequest !== 'function') {
      return Promise.reject(new Error(txt('Session request transport is unavailable.')));
    }
    var method = (spec.method || 'POST').toUpperCase();
    var endpoint = resolveEndpoint(spec.endpoint, values);
    var body;
    if (method !== 'GET') {
      var pathKeys = {};
      String(spec.endpoint || '').replace(/\{(\w+)\}/g, function (_, k) {
        pathKeys[k] = true;
        return '';
      });
      body = {};
      if (values && typeof values === 'object') {
        Object.keys(values).forEach(function (k) {
          if (!Object.prototype.hasOwnProperty.call(pathKeys, k)) body[k] = values[k];
        });
      }
    }
    if (spec.id === 'unblock-firewall-ip' && values && values.address) {
      body = { addresses: [values.address] };
    }
    if (spec.id === 'create-database' && spec.namePrefix && body && typeof body.name === 'string') {
      var trimmedDb = body.name.trim();
      body.name = trimmedDb && trimmedDb.indexOf(spec.namePrefix) !== 0 ? spec.namePrefix + trimmedDb : trimmedDb;
    }
    return window.xpanelSessionRequest(method, endpoint, body).then(function (result) {
      var msg = (result && (result.message || result.outcome)) || txt('Operation submitted');
      var mainEl = document.getElementById('main-content');
      var softRefreshSafe = Boolean(mainEl && mainEl.getAttribute('data-soft-refresh-safe') === 'true');
      var refreshTimer = null;
      var runRefresh = function () {
        if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
        if (typeof window.__xpanelSoftRefresh === 'function') window.__xpanelSoftRefresh();
      };
      var undoFn = spec.undoEndpoint
        ? function () {
            if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
            return window.xpanelSessionRequest('POST', resolveEndpoint(spec.undoEndpoint, values), {})
              .then(function () {
                showActionToast({ title: txt('Action undone'), tone: 'info' });
                if (softRefreshSafe) {
                  runRefresh();
                } else {
                  refreshTimer = setTimeout(runRefresh, 1500);
                }
              })
              .catch(function (err) {
                showActionToast({
                  title: txt('Action failed'),
                  message: (err && err.message) || txt('Request failed'),
                  tone: 'bad',
                });
                throw err;
              });
          }
        : undefined;
      showActionToast({
        title: txt('Completed'),
        message: String(msg),
        tone: 'ok',
        onUndo: undoFn,
        onDismiss: undoFn && !softRefreshSafe ? runRefresh : undefined,
      });
      if (!undoFn || softRefreshSafe) {
        runRefresh();
      } else {
        refreshTimer = setTimeout(runRefresh, 6200);
      }
      return result;
    }).catch(function (err) {
      showActionToast({
        title: txt('Action failed'),
        message: (err && err.message) || txt('Request failed'),
        tone: 'bad',
      });
      throw err;
    });
  }

  function executeCommandAction(btn) {
    var rawSpec = btn.getAttribute('data-cmdk-spec');
    if (!rawSpec) {
      var route = btn.getAttribute('data-cmdk-item');
      if (route && route.charAt(0) === '/') window.location.assign(route);
      return;
    }
    var spec;
    try { spec = JSON.parse(rawSpec); } catch (_) { return; }
    if (spec.mode === 'navigate' && btn.getAttribute('data-cmdk-item')) {
      window.location.assign(btn.getAttribute('data-cmdk-item'));
      return;
    }
    var labelEl = btn.querySelector('strong');
    var label = (labelEl && labelEl.textContent) || txt('Run action');
    if (spec.mode === 'drawer' && Array.isArray(spec.fields) && spec.fields.length) {
      openActionDrawer({
        title: label,
        fields: spec.fields,
        submitLabel: label,
        onSubmit: function (values) {
          if (spec.confirm) {
            return openConfirmDialog({
              title: label,
              message: txt('Confirm running this operation on the server?'),
              destructive: Boolean(spec.destructive),
            }).then(function (ok) {
              if (ok) return runCoreActionRequest(spec, values);
            });
          }
          return runCoreActionRequest(spec, values);
        },
      });
      return;
    }
    if (spec.confirm) {
      openConfirmDialog({
        title: label,
        message: txt('Confirm running this operation on the server?'),
        destructive: Boolean(spec.destructive),
      }).then(function (ok) {
        if (ok) return runCoreActionRequest(spec, {});
      }).catch(function () {});
      return;
    }
    runCoreActionRequest(spec, {}).catch(function () {});
  }

  window.__xpanelToast = showActionToast;
  window.__xpanelConfirmAction = openConfirmDialog;
  window.__xpanelOpenActionDrawer = openActionDrawer;
  window.__xpanelExecuteCommandAction = executeCommandAction;
`;
