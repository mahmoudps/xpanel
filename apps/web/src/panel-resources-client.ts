// Live on-demand reader controller for /resources.
// Calls GET /api/account/resources/live on click and updates KPIs, limit rows, and Observed At live.

export const PANEL_RESOURCES_CLIENT_BINDING = /* js */ String.raw`(function () {
  function t(message, values) {
    if (typeof window.xpT === 'function') return window.xpT(message, values);
    if (!values) return message;
    return String(message).replace(/\{(\w+)\}/g, function (_, key) {
      return values[key] == null ? '' : String(values[key]);
    });
  }

  function formatBytes(bytes) {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null;
    if (bytes === 0) return '0\u00a0B';
    var units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    var idx = 0;
    var val = bytes;
    while (val >= 1024 && idx < units.length - 1) {
      val /= 1024;
      idx++;
    }
    var num = idx === 0 ? String(Math.round(val)) : val >= 100 ? String(Math.round(val)) : val.toFixed(2);
    return num + '\u00a0' + units[idx];
  }

  function formatUtc(iso) {
    var d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    var p = function (n) { return n < 10 ? '0' + n : String(n); };
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ' UTC';
  }

  function bindPanelResourcesLive() {
    document.querySelectorAll('[data-panel-resources-live="true"]').forEach(function (root) {
      if (root.getAttribute('data-panel-resources-bound') === 'true') return;
      root.setAttribute('data-panel-resources-bound', 'true');
      var refreshBtn = root.querySelector('[data-resource-refresh]');
      var statusEl = root.querySelector('[data-resource-live-status]');
      if (!refreshBtn) return;

      var busy = false;
      function setStatus(message, state) {
        if (!statusEl) return;
        statusEl.hidden = !message;
        statusEl.textContent = message;
        statusEl.setAttribute('data-state', state || 'idle');
      }

      function updateRow(key, valueText, state) {
        root.querySelectorAll('[data-resource-row]').forEach(function (row) {
          if (row.getAttribute('data-resource-row') !== key) return;
          row.setAttribute('data-resource-state', state);
          var val = row.querySelector('[data-resource-value]');
          if (val) val.textContent = valueText;
        });
      }

      function updateKpi(key, valueText) {
        root.querySelectorAll('[data-resource-kpi]').forEach(function (node) {
          if (node.getAttribute('data-resource-kpi') === key) node.textContent = valueText;
        });
      }

      function applyPayload(data) {
        if (!data || typeof data !== 'object') return;
        var observedEl = root.querySelector('[data-resource-observed-at]');
        if (observedEl && typeof data.observedAt === 'string') {
          var timeEl = observedEl.querySelector('time');
          if (!timeEl) {
            timeEl = document.createElement('time');
            observedEl.textContent = '';
            observedEl.appendChild(timeEl);
          }
          timeEl.setAttribute('datetime', data.observedAt);
          timeEl.removeAttribute('data-utc-text');
          timeEl.textContent = formatUtc(data.observedAt);
          if (typeof window.__xpanelMountWorkspace === 'function') window.__xpanelMountWorkspace(observedEl);
        }

        var readingStateEl = root.querySelector('[data-resource-reading-state]');
        if (readingStateEl) {
          readingStateEl.textContent = data.state === 'read' ? t('Account usage sample') : t('Unavailable');
        }

        var usage = data.usage && typeof data.usage === 'object' ? data.usage : null;
        var unavailableText = t('Unavailable');
        var diskText = usage ? formatBytes(usage.diskBytes) : null;
        var memText = usage ? formatBytes(usage.memoryBytes) : null;
        var procText = usage && typeof usage.processCount === 'number' && Number.isFinite(usage.processCount) && usage.processCount >= 0 ? String(usage.processCount) : null;
        var bwBytes = usage && usage.bandwidthMonth && typeof usage.bandwidthMonth.totalBytes === 'number' ? formatBytes(usage.bandwidthMonth.totalBytes) : null;

        updateKpi('disk', diskText || '\u2014');
        updateKpi('memory', memText || '\u2014');
        updateKpi('processes', procText || '\u2014');
        updateRow('disk', diskText || unavailableText, diskText ? 'measured' : 'unavailable');
        updateRow('memory', memText || unavailableText, memText ? 'measured' : 'unavailable');
        updateRow('processes', procText || unavailableText, procText ? 'measured' : 'unavailable');
        updateRow('bandwidth', bwBytes || t('Not measured'), bwBytes ? 'measured' : 'unmeasured');

        if (data.counts && typeof data.counts === 'object') {
          if (typeof data.counts.addonDomains === 'number') updateRow('addonDomains', String(data.counts.addonDomains), 'measured');
          if (typeof data.counts.mailboxes === 'number') updateRow('mailboxes', String(data.counts.mailboxes), 'measured');
          if (typeof data.counts.mariadbDatabases === 'number') updateRow('mariadbDatabases', String(data.counts.mariadbDatabases), 'measured');
        }

        var ioEl = root.querySelector('[data-resource-io-verification]');
        if (ioEl) {
          ioEl.textContent = usage && usage.ioEnforced === true
            ? t('Verified for this sample')
            : usage && usage.ioEnforced === false
              ? t('Observed mismatch')
              : t('Unavailable');
        }
        root.setAttribute('data-resource-reading', data.state === 'read' ? 'read' : 'unread');
        setStatus(
          data.state === 'read'
            ? t('Account usage updated from host observation.')
            : t('Host usage metrics are currently unavailable; stored plan limits remain shown.'),
          data.state === 'read' ? 'ok' : 'unavailable',
        );
      }

      refreshBtn.addEventListener('click', function () {
        if (busy || refreshBtn.disabled) return;
        busy = true;
        refreshBtn.disabled = true;
        refreshBtn.setAttribute('aria-busy', 'true');
        setStatus(t('Reading live resource usage...'), 'loading');
        fetch('/api/account/resources/live', { credentials: 'same-origin', headers: { accept: 'application/json' } })
          .then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
          })
          .then(function (data) { applyPayload(data); })
          .catch(function () {
            setStatus(t('Could not refresh resource usage. Try again.'), 'failed');
          })
          .finally(function () {
            busy = false;
            refreshBtn.disabled = false;
            refreshBtn.removeAttribute('aria-busy');
          });
      });
    });
  }

  bindPanelResourcesLive();
})`;
