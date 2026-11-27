// Live 300ms-debounced account creation preflight controller for /whm/accounts/new.
// Queries GET /api/accounts/preflight without mutating server state and updates availability,
// owner capacity projections, and candidate artifact previews live.

export const ACCOUNT_PREFLIGHT_CLIENT_BINDING = /* js */ String.raw`(function () {
  function t(message, values) {
    if (typeof window.xpT === 'function') return window.xpT(message, values);
    if (!values) return message;
    return String(message).replace(/\{(\w+)\}/g, function (_, key) {
      return values[key] == null ? '' : String(values[key]);
    });
  }

  function formatMib(value) {
    if (value === 'unlimited') return t('Unlimited');
    if (typeof value !== 'number' || !Number.isFinite(value)) return t('Candidate not read');
    if (value >= 1024) return (value / 1024).toFixed(2) + '\u00a0GiB';
    return String(value) + '\u00a0MiB';
  }

  function bindAccountPreflight() {
    document.querySelectorAll('[data-account-preflight-url]').forEach(function (workspace) {
      if (workspace.getAttribute('data-account-preflight-bound') === 'true') return;
      workspace.setAttribute('data-account-preflight-bound', 'true');
      var url = workspace.getAttribute('data-account-preflight-url') || '';
      var form = workspace.querySelector('form[data-create-account-form]');
      if (!url || !form || workspace.getAttribute('data-capability-state') !== 'authorized') return;

      var usernameInput = form.querySelector('input[name="username"]');
      var domainInput = form.querySelector('input[name="primaryDomain"]');
      var planInputs = Array.prototype.slice.call(form.querySelectorAll('[name="planId"]'));
      var ownerInputs = Array.prototype.slice.call(form.querySelectorAll('[name="ownerId"]'));
      var seq = 0;
      var timer = null;

      function checkedValue(list) {
        for (var i = 0; i < list.length; i++) {
          var el = list[i];
          if (el.disabled) continue;
          if (el.type !== 'radio' || el.checked) return el.value || '';
        }
        return '';
      }

      function setCheck(key, text, state) {
        var el = null;
        workspace.querySelectorAll('[data-account-preflight-check]').forEach(function (node) {
          if (node.getAttribute('data-account-preflight-check') === key) el = node;
        });
        if (!el) return;
        el.textContent = text;
        if (state) {
          el.className = 'v2-field-check';
          el.setAttribute('data-check', state);
        } else {
          el.className = 'v2-muted';
          el.removeAttribute('data-check');
        }
      }

      function setOwnerFact(key, value) {
        workspace.querySelectorAll('[data-create-owner-fact]').forEach(function (node) {
          if (node.getAttribute('data-create-owner-fact') === key) node.textContent = value;
        });
      }

      function setArtifact(key, value) {
        workspace.querySelectorAll('[data-create-artifact]').forEach(function (node) {
          if (node.getAttribute('data-create-artifact') === key) node.textContent = value;
        });
      }

      function resetArtifacts() {
        var fallback = t('Not observed');
        setArtifact('linuxUser', fallback);
        setArtifact('home', fallback);
        setArtifact('apacheVhost', fallback);
        setArtifact('nginxServer', fallback);
        setArtifact('phpPool', fallback);
        setArtifact('dnsZone', fallback);
        setArtifact('mailDomain', fallback);
      }

      function runPreflight() {
        if ((usernameInput && usernameInput.disabled) || (domainInput && domainInput.disabled)) return;
        var params = new URLSearchParams();
        var user = usernameInput ? usernameInput.value.trim() : '';
        var domain = domainInput ? domainInput.value.trim() : '';
        var planId = checkedValue(planInputs);
        var ownerId = checkedValue(ownerInputs);
        if (user) params.set('username', user);
        if (domain) params.set('primaryDomain', domain);
        if (planId) params.set('planId', planId);
        if (ownerId) params.set('ownerId', ownerId);
        if (!user && !domain && !planId && !ownerId) {
          seq++;
          setCheck('username', t('Checked when submitted'), '');
          setCheck('primaryDomain', t('Checked when submitted'), '');
          setCheck('capacity', t('Checked when submitted'), '');
          setOwnerFact('accountsAfter', t('Candidate not read'));
          setOwnerFact('assignedDiskAfter', t('Candidate not read'));
          resetArtifacts();
          return;
        }

        var ticket = ++seq;
        if (user) setCheck('username', t('Checking...'), 'checking');
        else setCheck('username', t('Checked when submitted'), '');
        if (domain) setCheck('primaryDomain', t('Checking...'), 'checking');
        else setCheck('primaryDomain', t('Checked when submitted'), '');
        if (planId) setCheck('capacity', t('Checking...'), 'checking');
        else setCheck('capacity', t('Checked when submitted'), '');

        fetch(url + '?' + params.toString(), { credentials: 'same-origin', headers: { accept: 'application/json' } })
          .then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.json();
          })
          .then(function (data) {
            if (ticket !== seq || !data || typeof data !== 'object') return;
            if (data.username) {
              if (data.username.status === 'available') setCheck('username', t('Available'), 'ok');
              else if (data.username.status === 'taken') setCheck('username', t('Username already taken'), 'bad');
              else if (data.username.status === 'invalid') setCheck('username', t('Invalid username format'), 'bad');
              else setCheck('username', t('Checked when submitted'), '');
            }
            if (data.primaryDomain) {
              if (data.primaryDomain.status === 'available') setCheck('primaryDomain', t('Available'), 'ok');
              else if (data.primaryDomain.status === 'taken') setCheck('primaryDomain', t('Domain already exists'), 'bad');
              else if (data.primaryDomain.status === 'invalid') setCheck('primaryDomain', t('Invalid domain name'), 'bad');
              else setCheck('primaryDomain', t('Checked when submitted'), '');
            }
            if (data.capacity) {
              if (data.capacity.status === 'fits') setCheck('capacity', t('Fits owner capacity'), 'ok');
              else if (data.capacity.status === 'exceeds') setCheck('capacity', t('Exceeds owner capacity'), 'bad');
              else setCheck('capacity', t('Checked when submitted'), '');
              setOwnerFact('accountsAfter', data.capacity.accountsAfter !== null && data.capacity.accountsAfter !== undefined ? String(data.capacity.accountsAfter) : t('Candidate not read'));
              setOwnerFact('assignedDiskAfter', data.capacity.assignedDiskMbAfter !== null && data.capacity.assignedDiskMbAfter !== undefined ? formatMib(data.capacity.assignedDiskMbAfter) : t('Candidate not read'));
              if (typeof data.capacity.limitsSummary === 'string' && data.capacity.limitsSummary) {
                setOwnerFact('limitsSummary', data.capacity.limitsSummary);
              }
            }
            if (data.preview && typeof data.preview === 'object') {
              var fallback = t('Not observed');
              setArtifact('linuxUser', data.preview.linuxUser || fallback);
              setArtifact('home', data.preview.home || fallback);
              setArtifact('apacheVhost', data.preview.apacheVhost || fallback);
              setArtifact('nginxServer', data.preview.nginxServer || fallback);
              setArtifact('phpPool', data.preview.phpPool || fallback);
              setArtifact('dnsZone', data.preview.dnsZone || fallback);
              setArtifact('mailDomain', data.preview.mailDomain || fallback);
            }
          })
          .catch(function () {
            if (ticket !== seq) return;
            setCheck('username', t('Checked when submitted'), '');
            setCheck('primaryDomain', t('Checked when submitted'), '');
            setCheck('capacity', t('Checked when submitted'), '');
          });
      }

      function schedule() {
        clearTimeout(timer);
        timer = setTimeout(runPreflight, 300);
      }

      if (usernameInput) usernameInput.addEventListener('input', schedule);
      if (domainInput) domainInput.addEventListener('input', schedule);
      planInputs.forEach(function (el) { el.addEventListener('change', schedule); });
      ownerInputs.forEach(function (el) { el.addEventListener('change', schedule); });
      form.addEventListener('submit', function () {
        clearTimeout(timer);
        seq++;
      });
      form.addEventListener('reset', function () {
        clearTimeout(timer);
        seq++;
        setCheck('username', t('Validating on input...'), '');
        setCheck('primaryDomain', t('Validating on input...'), '');
        setCheck('capacity', t('Validating on input...'), '');
        setOwnerFact('accountsAfter', t('Candidate not read'));
        setOwnerFact('assignedDiskAfter', t('Candidate not read'));
        resetArtifacts();
      });
      if ((usernameInput && usernameInput.value.trim()) || (domainInput && domainInput.value.trim()) || checkedValue(planInputs)) {
        runPreflight();
      }
    });
  }

  bindAccountPreflight();
})`;
