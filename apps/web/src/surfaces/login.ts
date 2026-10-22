import { escapeHtml } from '../tokens.ts'

export interface LoginSurfaceProps {
  locale?: 'en' | 'ar'
  theme?: 'dark' | 'light'
  targetSurface?: 'xpanel' | 'xwhm' | 'xmail'
  username?: string
  lockout?: { locked: boolean; lockedUntil?: string; retryAfterSec?: number }
  errorMessage?: string | null
}

export const renderLoginSurface = (props: LoginSurfaceProps = {}): string => {
  const isAr = props.locale === 'ar'
  const locale = isAr ? 'ar' : 'en'
  const theme = props.theme === 'light' ? 'light' : 'dark'
  const targetSurface = props.targetSurface ?? 'xpanel'
  const text = (en: string, ar: string): string => escapeHtml(isAr ? ar : en)
  const locked = props.lockout?.locked === true
  const retry = props.lockout?.retryAfterSec
  const observedRetry = typeof retry === 'number' && Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : ''
  return `
<div class="xp-login-shell" data-surface="login" data-auth-state="${locked ? 'locked' : 'credentials'}" data-locked-until="${escapeHtml(props.lockout?.lockedUntil ?? '')}" data-retry-after="${observedRetry}">
  <header class="xp-login-topbar" role="banner">
    <div class="xp-brand">
      <span class="xp-brand__mark" aria-hidden="true">x</span>
      <div class="xp-brand__text">
        <span class="xp-brand__name">xPanel</span>
        <span class="xp-brand__sub">${text('xWHM · xPanel · xMail', 'xWHM · xPanel · xMail')}</span>
      </div>
    </div>
    <div class="xp-topbar-actions">
      <a href="/login?lang=${isAr ? 'en' : 'ar'}&amp;theme=${theme}&amp;target=${targetSurface}" class="xp-btn xp-btn--ghost" lang="${isAr ? 'en' : 'ar'}">${text('العربية', 'English')}</a>
      <a href="/login?lang=${locale}&amp;theme=${theme === 'dark' ? 'light' : 'dark'}&amp;target=${targetSurface}" class="xp-btn xp-btn--ghost">${theme === 'dark' ? text('Light theme', 'الوضع الفاتح') : text('Dark theme', 'الوضع الداكن')}</a>
    </div>
  </header>
  <main class="xp-login-main" aria-labelledby="login-heading">
    <section class="xp-card xp-login-card">
      <div class="xp-login-step">${text('Step 1 of 2 — Credentials', 'الخطوة 1 من 2 — بيانات الدخول')}</div>
      <h1 id="login-heading" class="xp-page-title">${text('Sign in to xPanel', 'تسجيل الدخول إلى xPanel')}</h1>
      <p class="xp-subtitle">${text('Enter your account credentials. Additional verification appears when required.', 'أدخل بيانات حسابك. تظهر خطوات التحقق الإضافية عند طلبها.')}</p>
      <div class="xp-alert xp-alert--critical" role="alert" data-auth-error data-lockout-state="${locked ? 'locked' : 'unknown'}" ${props.errorMessage || locked ? '' : 'hidden'}>${escapeHtml(props.errorMessage ?? (locked ? (isAr ? 'تسجيل الدخول مقفل مؤقتًا.' : 'Sign-in is temporarily locked.') : ''))}</div>
      <p class="xp-help" role="status" aria-live="polite" data-auth-status></p>
      <noscript><p>${text('JavaScript is required to submit this sign-in form.', 'يلزم تشغيل JavaScript لإرسال نموذج تسجيل الدخول.')}</p></noscript>
      <form class="xp-form" method="post" action="/api/auth/login" data-login-form>
        <div class="xp-field">
          <label class="xp-label" for="login-username">${text('Username', 'اسم المستخدم')}</label>
          <input id="login-username" name="username" type="text" class="xp-input" dir="ltr" autocomplete="username" required value="${escapeHtml(props.username ?? '')}" />
        </div>
        <div class="xp-field">
          <label class="xp-label" for="login-password">${text('Password', 'كلمة المرور')}</label>
          <input id="login-password" name="password" type="password" class="xp-input" dir="ltr" autocomplete="current-password" required />
          <button type="button" class="xp-btn xp-btn--inline" data-action="toggle-password" data-target="login-password" aria-controls="login-password" aria-pressed="false">${text('Show password', 'إظهار كلمة المرور')}</button>
        </div>
        <fieldset class="xp-fieldset" data-auth-mfa-fields data-2fa-step="unknown" hidden>
          <legend class="xp-label">${text('Two-factor verification', 'التحقق الثنائي')}</legend>
          <p class="xp-help">${text('Enter a fresh authenticator code or one recovery code, not both.', 'أدخل رمزًا جديدًا من تطبيق المصادقة أو رمز استرداد واحدًا.')}</p>
          <div class="xp-field">
            <label class="xp-label" for="login-otp">${text('Authenticator code', 'رمز تطبيق المصادقة')}</label>
            <input id="login-otp" name="totpCode" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" class="xp-input xp-mono" dir="ltr" autocomplete="one-time-code" />
          </div>
          <div class="xp-field">
            <label class="xp-label" for="login-recovery-code">${text('Recovery code', 'رمز الاسترداد')}</label>
            <input id="login-recovery-code" name="recoveryCode" type="text" class="xp-input xp-mono" dir="ltr" autocomplete="off" />
          </div>
        </fieldset>
        <button type="submit" class="xp-btn xp-btn--primary" data-auth-submit disabled>${text('Sign in', 'تسجيل الدخول')}</button>
      </form>
      <section data-auth-enrollment hidden aria-labelledby="enrollment-heading">
        <h2 id="enrollment-heading">${text('Set up two-factor authentication', 'إعداد التحقق الثنائي')}</h2>
        <p>${text('This account must complete enrollment before opening its workspace.', 'يجب إكمال إعداد التحقق الثنائي قبل فتح مساحة العمل.')}</p>
        <form class="xp-form" data-auth-setup-form>
          <div class="xp-field">
            <label class="xp-label" for="enrollment-password">${text('Confirm current password', 'تأكيد كلمة المرور الحالية')}</label>
            <input id="enrollment-password" name="password" type="password" class="xp-input" dir="ltr" autocomplete="current-password" required />
          </div>
          <button type="submit" class="xp-btn xp-btn--primary" data-action="setup-2fa">${text('Start enrollment', 'بدء الإعداد')}</button>
        </form>
        <div data-auth-enrollment-details hidden>
          <div class="xp-field"><span class="xp-label">${text('Authenticator setup key', 'مفتاح إعداد تطبيق المصادقة')}</span><div><bdi dir="ltr" class="xp-mono" data-auth-totp-secret></bdi></div></div>
          <p class="xp-help">${text('Enter this key in your authenticator app, then submit its code.', 'أدخل المفتاح في تطبيق المصادقة ثم أرسل الرمز الذي يولده.')}</p>
          <form class="xp-form" data-auth-enroll-form>
            <div class="xp-field"><label class="xp-label" for="enrollment-code">${text('Authenticator code', 'رمز تطبيق المصادقة')}</label><input id="enrollment-code" name="code" class="xp-input xp-mono" dir="ltr" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required /></div>
            <button type="submit" class="xp-btn xp-btn--primary">${text('Verify and enable', 'التحقق والتفعيل')}</button>
          </form>
          <button type="button" class="xp-btn" data-action="restart-enrollment">${text('Restart enrollment', 'إعادة الإعداد')}</button>
        </div>
      </section>
      <section data-auth-recovery hidden aria-labelledby="recovery-heading">
        <h2 id="recovery-heading">${text('Save your recovery codes', 'احفظ رموز الاسترداد')}</h2>
        <p>${text('Store these codes safely. Each code can be used once. They disappear when you continue.', 'احفظ الرموز في مكان آمن. يستخدم كل رمز مرة واحدة وتختفي الرموز عند المتابعة.')}</p>
        <ul data-auth-recovery-codes></ul>
        <button type="button" class="xp-btn xp-btn--primary" data-action="acknowledge-recovery">${text('I saved the codes — continue', 'حفظت الرموز، متابعة')}</button>
      </section>
      <section data-auth-password-change hidden aria-labelledby="password-change-heading">
        <h2 id="password-change-heading">${text('Change your password', 'تغيير كلمة المرور')}</h2>
        <p>${text('Your account requires a new password. You will sign in again after changing it.', 'يتطلب الحساب كلمة مرور جديدة. ستسجل الدخول مجددًا بعد تغييرها.')}</p>
        <form class="xp-form" data-auth-password-form>
          <div class="xp-field"><label class="xp-label" for="change-current-password">${text('Current password', 'كلمة المرور الحالية')}</label><input id="change-current-password" name="currentPassword" type="password" dir="ltr" class="xp-input" autocomplete="current-password" required /></div>
          <div class="xp-field"><label class="xp-label" for="change-new-password">${text('New password', 'كلمة المرور الجديدة')}</label><input id="change-new-password" name="newPassword" type="password" dir="ltr" class="xp-input" autocomplete="new-password" required /></div>
          <div class="xp-field"><label class="xp-label" for="change-confirm-password">${text('Confirm new password', 'تأكيد كلمة المرور الجديدة')}</label><input id="change-confirm-password" name="confirmPassword" type="password" dir="ltr" class="xp-input" autocomplete="new-password" required /></div>
          <button type="submit" class="xp-btn xp-btn--primary">${text('Change password', 'تغيير كلمة المرور')}</button>
        </form>
      </section>
      <button type="button" class="xp-btn" data-action="logout" data-auth-cancel hidden>${text('Cancel and sign out', 'إلغاء وتسجيل الخروج')}</button>
      <details class="xp-cli-recovery" data-cli-recovery>
        <summary>${text('Recover access with server administrator help', 'استعادة الوصول بمساعدة مدير الخادم')}</summary>
        <p class="xp-help">${text('An administrator with root SSH access can use:', 'يمكن لمدير يملك وصول root عبر SSH استخدام:')}</p>
        <pre class="xp-code-block" dir="ltr"><bdi dir="ltr">xpanel reset-password &lt;user&gt; --password-stdin
xpanel disable-2fa &lt;user&gt;</bdi></pre>
      </details>
    </section>

    <aside class="xp-login-aside" aria-label="${text('Sign-in information and surfaces', 'معلومات الدخول والواجهات')}">
      <div class="xp-login-aside-card">
        <h2 class="xp-login-aside-title">${text('Before you sign in', 'قبل تسجيل الدخول')}</h2>
        <dl class="xp-login-dl">
          <dt>${text('Session cookie', 'جلسة المتصفح')}</dt>
          <dd class="xp-mono"><bdi dir="ltr">HttpOnly · SameSite=Strict</bdi></dd>
          <dt>${text('Password & 2FA', 'كلمة المرور والتحقق')}</dt>
          <dd class="xp-mono"><bdi dir="ltr">Argon2id + TOTP</bdi></dd>
          <dt>${text('Brute-force guard', 'الحماية من التخمين')}</dt>
          <dd>${text('Automatic lockout after 5 failures', 'قفل تلقائي بعد 5 محاولات فاشلة')}</dd>
        </dl>
      </div>
      <div class="xp-login-aside-card">
        <h2 class="xp-login-aside-title">${text('Sign-in pages on this server', 'صفحات الدخول على هذا الخادم')}</h2>
        <div class="xp-login-surface-list">
          <a href="/login?target=xpanel&amp;lang=${locale}&amp;theme=${theme}" class="xp-login-surface-link" ${targetSurface === 'xpanel' ? 'aria-current="page"' : ''}>
            <span><strong>xPanel</strong> · ${text('Account & domains', 'الحساب والنطاقات')}</span>
            <code class="xp-mono"><bdi dir="ltr">/panel</bdi></code>
          </a>
          <a href="/login?target=xwhm&amp;lang=${locale}&amp;theme=${theme}" class="xp-login-surface-link" ${targetSurface === 'xwhm' ? 'aria-current="page"' : ''}>
            <span><strong>xWHM</strong> · ${text('Server & resellers', 'الخادم والموزعون')}</span>
            <code class="xp-mono"><bdi dir="ltr">/whm</bdi></code>
          </a>
          <a href="/login?target=xmail&amp;lang=${locale}&amp;theme=${theme}" class="xp-login-surface-link" ${targetSurface === 'xmail' ? 'aria-current="page"' : ''}>
            <span><strong>xMail</strong> · ${text('Webmail & Sieve', 'البريد وقواعد الفرز')}</span>
            <code class="xp-mono"><bdi dir="ltr">/mail</bdi></code>
          </a>
        </div>
      </div>
    </aside>
  </main>
  <footer class="xp-login-footer" role="contentinfo">
    <span>${text('xPanel Hosting Control Plane', 'منصة استضافة xPanel')}</span>
    <span>${text('Keyboard accessible · English (LTR) & Arabic (RTL)', 'دعم كامل للوحة المفاتيح · العربية والإنجليزية')}</span>
  </footer>
</div>`.trim()
}
