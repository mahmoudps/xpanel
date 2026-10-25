/** Shared JSON session transport and the interactive sign-in flow. Secrets stay in this page only. */
export const LOGIN_CLIENT_SCRIPT = /* js */ String.raw`
(function () {
  'use strict';
  var ar = document.documentElement.lang === 'ar';
  var copy = ar ? {
    failed: 'تعذر إكمال الطلب. حاول مجددًا.', invalid: 'اسم المستخدم أو كلمة المرور غير صحيحة.',
    code: 'رمز التحقق غير صحيح أو لم يعد صالحًا.', recovery: 'رمز الاسترداد غير صالح.',
    pending: 'جارٍ التحقق…', mfa: 'أدخل رمز التحقق أو رمز استرداد واحدًا.',
    both: 'أدخل رمز تحقق أو رمز استرداد واحدًا فقط.', locked: 'تسجيل الدخول مقفل مؤقتًا. موعد إعادة المحاولة: ',
    enrollment: 'التحقق الثنائي اختياري. أكّد كلمة المرور للبدء.', confirm: 'أدخل الرمز الذي يولده تطبيق المصادقة.',
    codes: 'تم تفعيل التحقق الثنائي. احفظ رموز الاسترداد قبل المتابعة.',
    mismatch: 'كلمتا المرور الجديدتان غير متطابقتين.', changed: 'تم تغيير كلمة المرور. سجل الدخول مجددًا.',
    session: 'تعذر التحقق من الجلسة. سجل الدخول مجددًا.', unexpected: 'استجابة غير متوقعة من الخادم.',
    show: 'إظهار كلمة المرور', hide: 'إخفاء كلمة المرور', required: 'يلزم تغيير كلمة المرور.',
    timeout: 'انتهت مهلة الطلب. حاول مجددًا.', recoverySwitch: 'استخدم رمز استرداد', authenticatorSwitch: 'استخدم رمز تطبيق المصادقة'
  } : {
    failed: 'The request could not be completed. Try again.', invalid: 'Invalid username or password.',
    code: 'The verification code is invalid or no longer usable.', recovery: 'The recovery code is invalid.',
    pending: 'Verifying…', mfa: 'Enter an authenticator code or one recovery code.',
    both: 'Enter either an authenticator code or one recovery code.', locked: 'Sign-in is temporarily locked. Retry after: ',
    enrollment: 'Two-factor authentication is optional. Confirm your password to begin.', confirm: 'Enter the code from your authenticator app.',
    codes: 'Two-factor authentication is enabled. Save your recovery codes before continuing.',
    mismatch: 'The new passwords do not match.', changed: 'Password changed. Sign in again.',
    session: 'The session could not be verified. Sign in again.', unexpected: 'Unexpected server response.',
    show: 'Show password', hide: 'Hide password', required: 'A password change is required.',
    timeout: 'The request timed out. Try again.', recoverySwitch: 'Use a recovery code', authenticatorSwitch: 'Use an authenticator code'
  };
  var csrfToken = null;
  var principal = null;
  var recoveryCodes = [];
  var shell = document.querySelector('[data-auth-state]');
  var login = document.querySelector('[data-login-form]');
  var mfaDisabled = document.documentElement.getAttribute('data-mfa-mode') === 'disabled';
  var errorBox = document.querySelector('[data-auth-error]');
  var statusBox = document.querySelector('[data-auth-status]');
  var lockedUntil = 0;
  var lockTimer = null;

  function field(form, name) { return form.querySelector('[name="' + name + '"]'); }
  function value(form, name) { var input = field(form, name); return input ? input.value : ''; }
  function show(selector, visible) { var node = document.querySelector(selector); if (node) node.hidden = !visible; }
  function message(text, error) {
    if (errorBox) { errorBox.textContent = error ? text : ''; errorBox.hidden = !error; }
    if (statusBox) statusBox.textContent = error ? '' : text;
  }
  function setState(state) { if (shell) shell.setAttribute('data-auth-state', state); }
  function busy(form, active) {
    form.setAttribute('aria-busy', String(active));
    form.querySelectorAll('button[type="submit"]').forEach(function (button) { button.disabled = active || lockedUntil > Date.now(); });
  }
  function clearCredentials() {
    document.querySelectorAll('[name="password"], [name="currentPassword"], [name="newPassword"], [name="confirmPassword"], [name="totpCode"], [name="recoveryCode"], [name="code"]').forEach(function (input) { input.value = ''; });
  }
  function clearEnrollment() {
    recoveryCodes = [];
    var secret = document.querySelector('[data-auth-totp-secret]');
    var codes = document.querySelector('[data-auth-recovery-codes]');
    var qr = document.querySelector('[data-auth-totp-qr]');
    if (secret) secret.textContent = '';
    if (codes) codes.replaceChildren();
    if (qr) qr.replaceChildren();
    show('[data-auth-totp-qr-field]', false);
  }
  function renderQr(svgText) {
    var target = document.querySelector('[data-auth-totp-qr]');
    if (!target || typeof svgText !== 'string' || !svgText) return false;
    var parsed = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    var svg = parsed.documentElement;
    if (!svg || svg.nodeName.toLowerCase() !== 'svg' || parsed.querySelector('parsererror, script, foreignObject')) return false;
    target.replaceChildren(document.importNode(svg, true));
    show('[data-auth-totp-qr-field]', true);
    return true;
  }
  function step(name) {
    if (login) login.hidden = name !== 'credentials' && name !== 'mfa-required' && name !== 'locked';
    show('[data-auth-enrollment]', name === 'enrollment');
    show('[data-auth-recovery]', name === 'recovery-codes');
    show('[data-auth-password-change]', name === 'password-change-required');
    show('[data-auth-cancel]', name === 'enrollment' || name === 'recovery-codes' || name === 'password-change-required');
    setState(name);
  }

  async function requestJson(method, path, body, csrf) {
    var endpoint = new URL(path, window.location.href);
    if (endpoint.origin !== window.location.origin || endpoint.pathname.indexOf('/api/') !== 0) throw new Error(copy.unexpected);
    var headers = { accept: 'application/json' };
    var init = { method: method, credentials: 'same-origin', cache: 'no-store', headers: headers };
    if (body !== undefined) { headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
    if (csrf) headers['x-csrf-token'] = csrf;
    var controller = new AbortController();
    init.signal = controller.signal;
    var timer = setTimeout(function () { controller.abort(); }, /\/certificates$|\/api\/backups\/accounts\/|\/restart$/.test(path) ? 180000 : 20000);
    try {
      var response = await fetch(endpoint.href, init);
      var data = await response.json().catch(function () { return null; });
      if (!data || typeof data !== 'object') throw new Error(copy.unexpected);
      if (!response.ok) {
        var problem = data.error || data;
        var error = new Error(problem.message || problem.detail || copy.failed);
        error.status = response.status;
        error.code = problem.code;
        error.details = problem.details || {};
        throw error;
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error(copy.timeout);
      throw error;
    } finally { clearTimeout(timer); }
  }

  async function sessionRequest(method, path, body) {
    if (!csrfToken) {
      var me = await requestJson('GET', '/api/auth/me');
      if (typeof me.csrfToken !== 'string' || !me.csrfToken) throw new Error(copy.session);
      csrfToken = me.csrfToken;
    }
    return requestJson(method, path, body, csrfToken);
  }
  window.xpanelSessionRequest = sessionRequest;

  function localizedError(error) {
    if (error.message === 'invalid username or password') return copy.invalid;
    if (/invalid (two-factor|TOTP)/i.test(error.message)) return copy.code;
    if (error.message === 'invalid recovery code') return copy.recovery;
    return ar && error.status ? copy.failed + ' (' + error.status + ')' : error.message || copy.failed;
  }
  function lock(deadline) {
    lockedUntil = deadline;
    step('locked');
    if (errorBox) errorBox.setAttribute('data-lockout-state', 'locked');
    message(copy.locked + new Date(deadline).toISOString() + ' UTC', true);
    if (login) busy(login, false);
    clearTimeout(lockTimer);
    lockTimer = setTimeout(function () {
      lockedUntil = 0;
      if (errorBox) errorBox.setAttribute('data-lockout-state', 'unknown');
      step('credentials'); message('', false); if (login) busy(login, false);
    }, Math.max(1, Math.min(2147483647, deadline - Date.now())));
  }
  // Presentation only: these selectors never authenticate, alter a listener audience or bypass a factor.
  function selectLoginFactor(mode, focus) {
    if (mfaDisabled || !login || (mode !== 'totp' && mode !== 'recovery')) return false;
    var fields = document.querySelector('[data-auth-mfa-fields]');
    if (!fields) return false;
    var recovery = mode === 'recovery';
    var otp = field(login, 'totpCode'), recoveryCode = field(login, 'recoveryCode');
    if (recovery && otp) otp.value = '';
    if (!recovery && recoveryCode) recoveryCode.value = '';
    show('[data-login-factor="totp"]', !recovery);
    show('[data-login-factor="recovery"]', recovery);
    fields.setAttribute('data-factor-mode', mode);
    var toggle = document.querySelector('[data-login-factor-toggle]');
    if (toggle) { toggle.textContent = recovery ? copy.authenticatorSwitch : copy.recoverySwitch; toggle.setAttribute('aria-pressed', String(recovery)); }
    var selected = recovery ? recoveryCode : otp;
    if (focus && selected) selected.focus();
    return true;
  }
  function changeLoginCredentials() {
    if (!shell || !login || shell.getAttribute('data-auth-state') !== 'mfa-required' || lockedUntil > Date.now() || login.getAttribute('aria-busy') === 'true') return false;
    clearCredentials();
    selectLoginFactor('totp', false);
    show('[data-auth-mfa-fields]', false);
    var fields = document.querySelector('[data-auth-mfa-fields]');
    if (fields) fields.setAttribute('data-2fa-step', 'unknown');
    step('credentials'); message('', false); busy(login, false);
    var username = field(login, 'username'); if (username) username.focus();
    return true;
  }
  function authError(error) {
    var details = error.details || {};
    if (details.lockedOut && typeof details.lockedUntil === 'string' && Date.parse(details.lockedUntil) > Date.now()) {
      lock(Date.parse(details.lockedUntil)); return;
    }
    if (details.mfaRequired === true && !mfaDisabled) {
      step('mfa-required'); show('[data-auth-mfa-fields]', true);
      var fields = document.querySelector('[data-auth-mfa-fields]'); if (fields) fields.setAttribute('data-2fa-step', 'required');
      message(copy.mfa, false); selectLoginFactor('totp', true); return;
    }
    message(localizedError(error), true);
  }
  function redirectToWorkspace() {
    clearCredentials(); clearEnrollment();
    if (!principal || ['root', 'reseller', 'user'].indexOf(principal.kind) === -1) { message(copy.unexpected, true); return; }
    var audience = shell && shell.getAttribute('data-login-audience');
    var destinations = { xpanel: { path: '/panel', roles: ['user'] }, xwhm: { path: '/whm', roles: ['root', 'reseller'] }, xmail: { path: '/mail/inbox', roles: ['user'] } };
    var destination = audience && Object.prototype.hasOwnProperty.call(destinations, audience) ? destinations[audience] : null;
    if (audience && (!destination || destination.roles.indexOf(principal.kind) === -1)) { message(copy.unexpected, true); return; }
    var path = destination ? destination.path : (principal.kind === 'user' ? '/panel' : '/whm');
    window.location.assign(path + '?lang=' + (ar ? 'ar' : 'en'));
  }

  if (login) {
    busy(login, false);
    var deadline = Date.parse(shell.getAttribute('data-locked-until') || '');
    var retry = Number(shell.getAttribute('data-retry-after'));
    if (shell.getAttribute('data-auth-state') === 'locked') {
      if (Number.isFinite(deadline) && deadline > Date.now()) lock(deadline);
      else if (retry > 0) lock(Date.now() + retry * 1000);
      else { lockedUntil = Infinity; busy(login, false); }
    }
    login.addEventListener('submit', async function (event) {
      event.preventDefault();
      if (login.getAttribute('aria-busy') === 'true' || !login.reportValidity() || lockedUntil > Date.now()) return;
      var totpCode = mfaDisabled ? '' : value(login, 'totpCode').trim();
      var recoveryCode = mfaDisabled ? '' : value(login, 'recoveryCode').trim();
      if (totpCode && recoveryCode) { message(copy.both, true); return; }
      var body = { username: value(login, 'username').trim(), password: value(login, 'password') };
      if (totpCode) body.totpCode = totpCode;
      if (recoveryCode) body.recoveryCode = recoveryCode;
      busy(login, true); message(copy.pending, false);
      try {
        var data = await requestJson('POST', '/api/auth/login', body);
        if (!data.principal || typeof data.csrfToken !== 'string' || !data.csrfToken || typeof data.mfaEnrollmentRequired !== 'boolean' || typeof data.passwordChangeRequired !== 'boolean') throw new Error(copy.unexpected);
        csrfToken = data.csrfToken; principal = data.principal; clearCredentials();
        if (data.passwordChangeRequired) { step('password-change-required'); message(copy.required, false); document.getElementById('change-current-password').focus(); }
        else { setState('authenticated'); redirectToWorkspace(); }
      } catch (error) { authError(error); }
      finally { busy(login, false); }
    });
  }

  var setup = document.querySelector('[data-auth-setup-form]');
  if (setup) setup.addEventListener('submit', async function (event) {
    event.preventDefault(); if (setup.getAttribute('aria-busy') === 'true' || !setup.reportValidity()) return;
    busy(setup, true); message(copy.pending, false);
    try {
      var data = await sessionRequest('POST', '/api/auth/2fa/setup', { password: value(setup, 'password') });
      if (typeof data.secret !== 'string' || !data.secret || !Array.isArray(data.recoveryCodes) || !data.recoveryCodes.length || data.recoveryCodes.some(function (code) { return typeof code !== 'string'; })) throw new Error(copy.unexpected);
      clearEnrollment(); recoveryCodes = data.recoveryCodes.slice();
      document.querySelector('[data-auth-totp-secret]').textContent = data.secret;
      renderQr(data.qrCodeSvg);
      step('enrollment'); setup.hidden = true; show('[data-auth-enrollment-details]', true);
      message(copy.confirm, false); document.getElementById('enrollment-code').focus();
    } catch (error) { authError(error); }
    finally { field(setup, 'password').value = ''; busy(setup, false); }
  });

  var enroll = document.querySelector('[data-auth-enroll-form]');
  if (enroll) enroll.addEventListener('submit', async function (event) {
    event.preventDefault(); if (enroll.getAttribute('aria-busy') === 'true' || !enroll.reportValidity()) return;
    busy(enroll, true); message(copy.pending, false);
    try {
      var result = await sessionRequest('POST', '/api/auth/2fa/enable', { code: value(enroll, 'code').trim() });
      if (result.ok !== true || result.totpEnabled !== true) throw new Error(copy.unexpected);
      var list = document.querySelector('[data-auth-recovery-codes]'); list.replaceChildren();
      recoveryCodes.forEach(function (code) { var item = document.createElement('li'); var value = document.createElement('bdi'); value.dir = 'ltr'; value.textContent = code; item.appendChild(value); list.appendChild(item); });
      step('recovery-codes'); message(copy.codes, false);
    } catch (error) { authError(error); }
    finally { field(enroll, 'code').value = ''; busy(enroll, false); }
  });

  var password = document.querySelector('[data-auth-password-form]');
  if (password) password.addEventListener('submit', async function (event) {
    event.preventDefault(); if (password.getAttribute('aria-busy') === 'true' || !password.reportValidity()) return;
    if (value(password, 'newPassword') !== value(password, 'confirmPassword')) { message(copy.mismatch, true); return; }
    busy(password, true); message(copy.pending, false);
    try {
      var result = await sessionRequest('POST', '/api/auth/change-password', { currentPassword: value(password, 'currentPassword'), newPassword: value(password, 'newPassword') });
      if (result.reauthenticationRequired !== true) throw new Error(copy.unexpected);
      csrfToken = null; principal = null; clearCredentials(); clearEnrollment();
      show('[data-auth-mfa-fields]', false); step('credentials'); message(copy.changed, false);
      document.getElementById('login-password').focus();
    } catch (error) { authError(error); }
    finally { busy(password, false); }
  });

  document.addEventListener('click', async function (event) {
    var button = event.target.closest ? event.target.closest('[data-action]') : null;
    if (!button) return;
    var action = button.getAttribute('data-action');
    if (action === 'toggle-password') {
      var input = document.getElementById(button.getAttribute('data-target'));
      if (!input) return;
      event.preventDefault();
      var start = input.selectionStart, end = input.selectionEnd, direction = input.selectionDirection;
      var visible = input.type === 'password'; input.type = visible ? 'text' : 'password';
      button.setAttribute('aria-label', visible ? copy.hide : copy.show);
      button.setAttribute('aria-pressed', String(visible));
      var showIcon = button.querySelector('[data-password-show]'), hideIcon = button.querySelector('[data-password-hide]');
      var label = button.querySelector('[data-password-label]');
      if (showIcon) showIcon.toggleAttribute('hidden', visible);
      if (hideIcon) hideIcon.toggleAttribute('hidden', !visible);
      if (label) label.textContent = visible ? (ar ? 'إخفاء' : 'Hide') : (ar ? 'إظهار' : 'Show');
      if (typeof start === 'number' && typeof end === 'number') input.setSelectionRange(start, end, direction || 'none');
      // Revealing a longer LTR value must keep its caret-end view on the RTL field edge.
      if (visible && document.documentElement.dir === 'rtl' && getComputedStyle(input).textAlign === 'right' && start === end && end === input.value.length) input.scrollLeft = input.scrollWidth;
    } else if (action === 'change-login-credentials') {
      event.preventDefault(); changeLoginCredentials();
    } else if (action === 'toggle-login-factor') {
      event.preventDefault();
      if (!shell || !login || shell.getAttribute('data-auth-state') !== 'mfa-required' || lockedUntil > Date.now() || login.getAttribute('aria-busy') === 'true') return;
      var fields = document.querySelector('[data-auth-mfa-fields]');
      if (fields) selectLoginFactor(fields.getAttribute('data-factor-mode') === 'recovery' ? 'totp' : 'recovery', true);
    } else if (action === 'restart-enrollment') {
      clearEnrollment(); show('[data-auth-enrollment-details]', false); if (setup) setup.hidden = false; step('enrollment'); message(copy.enrollment, false);
    } else if (action === 'acknowledge-recovery') {
      clearEnrollment();
      if (principal) { setState('authenticated'); redirectToWorkspace(); }
      else window.location.reload();
    } else if (action === 'logout') {
      event.preventDefault(); button.disabled = true;
      try {
        if (!csrfToken) {
          try {
            var me = await requestJson('GET', '/api/auth/me');
            if (typeof me.csrfToken === 'string' && me.csrfToken) csrfToken = me.csrfToken;
          } catch (ignored) { /* A missing token still attempts sign-out. */ }
        }
        await requestJson('POST', '/api/auth/logout', {}, csrfToken || undefined);
        csrfToken = null; principal = null; clearCredentials(); clearEnrollment(); window.location.assign('/login?lang=' + (ar ? 'ar' : 'en'));
      } catch (error) {
        if (error.status === 401) window.location.assign('/login?lang=' + (ar ? 'ar' : 'en'));
        else { message(localizedError(error), true); button.disabled = false; }
      }
    }
  });
})();
`
