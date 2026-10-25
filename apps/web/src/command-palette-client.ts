/** Functions share the existing shell overlay lifecycle; no independent focus trap is installed. */
export const COMMAND_PALETTE_CLIENT_FUNCTIONS = String.raw`
  function normalizeCommandSearch(value) {
    return value.normalize('NFKD').replace(/[\u0300-\u036f\u064b-\u065f\u0670\u0640]/g, '').toLowerCase();
  }

  function commandPagePath(item) {
    var route = item.link.getAttribute('data-cmdk-item') || '';
    return item.link.getAttribute('data-cmdk-persistable') !== 'false' && /^\/[a-z0-9/_-]*$/i.test(route) ? route : null;
  }

  function loadCommandHistory(palette) {
    var allowed = new Set(palette.items.map(commandPagePath).filter(Boolean));
    var stored;
    try { stored = JSON.parse(window.localStorage.getItem(palette.storageKey) || '{}'); } catch (_) { stored = {}; }
    if (!stored || typeof stored !== 'object') stored = {};
    function keep(values, maximum) {
      return Array.isArray(values) ? values.filter(function (path, index) { return typeof path === 'string' && allowed.has(path) && values.indexOf(path) === index; }).slice(0, maximum) : [];
    }
    palette.history = { favorites: keep(stored.favorites, 12), recent: keep(stored.recent, 8) };
  }

  function saveCommandHistory(palette) {
    // Only static routes from this document's current permission/capability allowlist are stored.
    try { window.localStorage.setItem(palette.storageKey, JSON.stringify(palette.history)); } catch (_) {}
  }

  function renderCommandHistory(palette) {
    var pages = new Map();
    palette.items.forEach(function (item) { var path = commandPagePath(item); if (path) pages.set(path, item); });
    function fill(selector, sectionSelector, paths) {
      var target = palette.modal.querySelector(selector);
      var section = palette.modal.querySelector(sectionSelector);
      if (!target || !section) return;
      target.replaceChildren();
      paths.forEach(function (path) {
        var item = pages.get(path);
        if (!item) return;
        var link = document.createElement('a');
        link.href = item.link.getAttribute('href');
        link.setAttribute('data-cmdk-history-page', path);
        var label = item.link.querySelector('strong');
        link.textContent = label ? label.textContent : item.link.textContent;
        target.appendChild(link);
      });
      section.hidden = target.childElementCount === 0;
    }
    fill('[data-cmdk-favorites]', '[data-cmdk-favorites-section]', palette.history.favorites);
    fill('[data-cmdk-recents]', '[data-cmdk-recents-section]', palette.history.recent);
    var region = palette.modal.querySelector('[data-cmdk-history]');
    if (region) region.hidden = !palette.history.favorites.length && !palette.history.recent.length;
    palette.modal.querySelectorAll('[data-cmdk-favorite]').forEach(function (button) {
      button.setAttribute('aria-pressed', String(palette.history.favorites.indexOf(button.getAttribute('data-cmdk-favorite')) >= 0));
    });
  }

  function rememberCommandPage(palette, path) {
    if (!palette.items.some(function (item) { return commandPagePath(item) === path; })) return;
    palette.history.recent = [path].concat(palette.history.recent.filter(function (value) { return value !== path; })).slice(0, 8);
    saveCommandHistory(palette);
    renderCommandHistory(palette);
  }

  function selectCommandResult(index, scroll) {
    var palette = commandPalette;
    if (!palette) return;
    var items = palette.matches;
    palette.activeIndex = items.length ? (index + items.length) % items.length : -1;
    for (var i = 0; i < palette.items.length; i++) palette.items[i].link.setAttribute('aria-selected', 'false');
    var selected = items[palette.activeIndex];
    if (!selected) { palette.input.removeAttribute('aria-activedescendant'); return; }
    selected.link.setAttribute('aria-selected', 'true');
    palette.input.setAttribute('aria-activedescendant', selected.link.id);
    if (scroll) revealCommandResult(palette, selected);
  }

  function revealCommandResult(palette, selected) {
    var list = palette.results;
    var row = selected.row;
    var last = palette.activeIndex === palette.matches.length - 1;
    var maximum = list.scrollHeight - list.clientHeight;
    if (last && maximum > 0) { list.scrollTop = maximum; if (list.scrollTop > 0) return; }
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
    var query = palette.input.value.trim();
    var prefixes = { '>': 'action', '@': 'account', '#': 'domain' };
    var scope = prefixes[query.charAt(0)] || palette.scope || 'all';
    if (prefixes[query.charAt(0)]) query = query.slice(1).trim();
    var terms = normalizeCommandSearch(query).split(/\s+/).filter(Boolean);
    palette.matches = [];
    for (var i = 0; i < palette.items.length; i++) {
      var item = palette.items[i];
      item.row.hidden = (scope !== 'all' && item.kind !== scope) || !terms.every(function (term) { return item.search.indexOf(term) !== -1; });
      if (!item.row.hidden) palette.matches.push(item);
    }
    palette.modal.querySelectorAll('[data-cmdk-scope]').forEach(function (button) { button.setAttribute('aria-pressed', String(button.getAttribute('data-cmdk-scope') === scope)); });
    palette.modal.querySelectorAll('[data-cmdk-group]').forEach(function (group) { group.hidden = !Array.prototype.some.call(group.querySelectorAll('[data-cmdk-row]'), function (row) { return !row.hidden; }); });
    var history = palette.modal.querySelector('[data-cmdk-history]');
    if (history) history.hidden = Boolean(query) || scope !== 'all' || (!palette.history.favorites.length && !palette.history.recent.length);
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
      return { link: link, row: link.closest('[data-cmdk-row]'), kind: link.getAttribute('data-cmdk-kind') || 'page', search: normalizeCommandSearch(link.getAttribute('data-cmdk-search-text') || link.textContent) };
    }).filter(function (item) { return item.row; });
    var surface = modal.getAttribute('data-cmdk-surface') || 'workspace';
    commandPalette = { modal: modal, input: input, results: results, empty: empty, status: status, items: items, matches: [], activeIndex: -1, scope: 'all', storageKey: 'xpanel.command-pages.v1.' + surface, history: { favorites: [], recent: [] } };
    loadCommandHistory(commandPalette);
    renderCommandHistory(commandPalette);
    input.addEventListener('input', filterCommandPalette);
    results.addEventListener('pointermove', function (event) {
      var link = event.target.closest ? event.target.closest('a[data-cmdk-item]') : null;
      var index = commandPalette.matches.findIndex(function (item) { return item.link === link; });
      if (index >= 0 && index !== commandPalette.activeIndex) selectCommandResult(index, false);
    });
    modal.addEventListener('click', function (event) {
      var scope = event.target.closest ? event.target.closest('[data-cmdk-scope]') : null;
      if (scope) {
        commandPalette.scope = scope.getAttribute('data-cmdk-scope') || 'all';
        input.value = input.value.replace(/^[>@#]\s*/, '');
        filterCommandPalette(); input.focus({ preventScroll: true }); return;
      }
      var favorite = event.target.closest ? event.target.closest('[data-cmdk-favorite]') : null;
      if (favorite) {
        event.preventDefault();
        var path = favorite.getAttribute('data-cmdk-favorite');
        if (!items.some(function (item) { return commandPagePath(item) === path; })) return;
        var found = commandPalette.history.favorites.indexOf(path);
        if (found >= 0) commandPalette.history.favorites.splice(found, 1);
        else commandPalette.history.favorites = commandPalette.history.favorites.concat(path).slice(-12);
        saveCommandHistory(commandPalette); renderCommandHistory(commandPalette); return;
      }
      var link = event.target.closest ? event.target.closest('a[data-cmdk-item], a[data-cmdk-history-page]') : null;
      if (!link || !modal.contains(link)) return;
      var current = items.find(function (item) { return item.link === link; });
      var page = current ? commandPagePath(current) : link.getAttribute('data-cmdk-history-page');
      if (page) rememberCommandPage(commandPalette, page);
      if (activeOverlay && activeOverlay.element === modal) closeActiveOverlay(true, false, true);
    });
    filterCommandPalette();
  }

  function handleCommandPaletteKey(event) {
    var palette = commandPalette;
    if (!palette || !activeOverlay || activeOverlay.element !== palette.modal || event.target !== palette.input || event.isComposing || event.altKey) return false;
    if ((event.ctrlKey || event.metaKey) && event.key !== 'Enter') return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); selectCommandResult(palette.activeIndex + (event.key === 'ArrowDown' ? 1 : -1), true); return true;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      var selected = palette.matches[palette.activeIndex];
      if (selected) {
        var page = commandPagePath(selected);
        if (page) rememberCommandPage(palette, page);
        if (event.ctrlKey || event.metaKey) {
          var href = selected.link.getAttribute('href');
          if (href && href.charAt(0) === '/' && href.charAt(1) !== '/') window.open(href, '_blank', 'noopener');
          closeActiveOverlay(true, false, true);
        } else selected.link.click();
      }
      return true;
    }
    return false;
  }
`;
