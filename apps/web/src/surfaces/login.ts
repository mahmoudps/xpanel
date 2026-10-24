import { panelLabel, safePanelLinks, type PanelId, type PanelLink } from '../chrome.ts'
import { publicContactEmail } from '../display-name.ts'
import { escapeHtml } from '../tokens.ts'

export interface LoginSurfaceProps {
  mfaMode?: MfaRuntimeMode
  locale?: 'en' | 'ar'
  theme?: 'dark' | 'light'
  targetSurface?: 'xpanel' | 'xwhm' | 'xmail'
  /** Presentation selected by the server listener; never an authorization claim. */
  audience?: 'xpanel' | 'xwhm' | 'xmail'
  username?: string
  lockout?: { locked: boolean; lockedUntil?: string; retryAfterSec?: number }
  errorMessage?: string | null
  /** Exact public origins of the three panels. Omitted origins are not linked. */
  panels?: readonly PanelLink[]
  /** Configured administrator contact. Shown only when it is a plain email address. */
  supportEmail?: string
}

export const renderLoginSurface = (props: LoginSurfaceProps = {}): string => {
  const isAr = props.locale === 'ar'
  const locale = isAr ? 'ar' : 'en'
  const theme = props.theme === 'light' ? 'light' : 'dark'
  const isAudience = (value: unknown): value is NonNullable<LoginSurfaceProps['audience']> => value === 'xpanel' || value === 'xwhm' || value === 'xmail'
  const audience = isAudience(props.audience) ? props.audience : undefined
  const targetSurface = audience ?? (isAudience(props.targetSurface) ? props.targetSurface : 'xpanel')
  const brand = audience === 'xwhm' ? 'xWHM' : audience === 'xmail' ? 'xMail' : 'xPanel'
  const text = (en: string, ar: string): string => escapeHtml(isAr ? ar : en)
  const markPaths = {
    xpanel: '<circle cx="12" cy="8" r="3"/><path d="M5 20v-2a7 7 0 0 1 14 0v2"/>',
    xwhm: '<rect x="4" y="3" width="16" height="7" rx="2"/><rect x="4" y="14" width="16" height="7" rx="2"/><path d="M8 6.5h.01M8 17.5h.01M12 6.5h5M12 17.5h5"/>',
    xmail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/>',
  }
  const profileHeading = audience === 'xwhm' ? text('Server sign in', 'دخول إدارة الخادم') : audience === 'xmail' ? text('Mail sign in', 'دخول البريد') : text('Account sign in', 'دخول الحساب')
  const profileMark = audience ? '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + markPaths[audience] + '</svg>' : 'x'
  const themeMark = theme === 'dark'
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M20.7 14.7A9 9 0 0 1 9.3 3.3 9 9 0 1 0 20.7 14.7Z"/></svg>'
  const themeLabel = theme === 'dark' ? text('Light theme', 'الوضع الفاتح') : text('Dark theme', 'الوضع الداكن')
  const contact = publicContactEmail(props.supportEmail)
  const siblingPanels = safePanelLinks(props.panels).filter(panel => panel.surface !== (audience ?? targetSurface))
  const locked = props.lockout?.locked === true
  const mfaDisabled = props.mfaMode === 'disabled'
  const retry = props.lockout?.retryAfterSec
  const observedRetry = typeof retry === 'number' && Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : ''
  return `
<div class="xp-login-shell" data-surface="login" ${audience ? `data-login-audience="${audience}"` : ''} data-auth-state="${locked ? 'locked' : 'credentials'}" data-locked-until="${escapeHtml(props.lockout?.lockedUntil ?? '')}" data-retry-after="${observedRetry}">
  <header class="xp-login-topbar" role="banner">
    <div class="xp-brand">
      <span class="xp-brand__mark" aria-hidden="true">${profileMark}</span>
      <div class="xp-brand__text">
        <span class="xp-brand__name" dir="ltr">${brand}</span>
        ${audience ? '' : '<span class="xp-brand__sub">xWHM · xPanel · xMail</span>'}
      </div>
    </div>
    <div class="xp-topbar-actions">
      <a href="/login?lang=${isAr ? 'en' : 'ar'}&amp;theme=${theme}&amp;target=${targetSurface}" class="xp-btn xp-btn--ghost" lang="${isAr ? 'en' : 'ar'}">${text('العربية', 'English')}</a>
      <a href="/login?lang=${locale}&amp;theme=${theme === 'dark' ? 'light' : 'dark'}&amp;target=${targetSurface}" class="xp-btn xp-btn--ghost xp-login-theme" aria-label="${themeLabel}" title="${themeLabel}">${themeMark}<span class="xp-login-theme__label">${themeLabel}</span></a>
    </div>
  </header>
  <main class="xp-login-main" aria-labelledby="login-heading">
    <section class="xp-card xp-login-card">
      ${audience ? '' : `<div class="xp-login-step">${mfaDisabled ? text('Credentials', 'بيانات الدخول') : text('Step 1 of 2 — Credentials', 'الخطوة 1 من 2 — بيانات الدخول')}</div>`}
      <p class="xp-login-identity__product" dir="ltr" data-login-product="${audience ?? 'xpanel'}">${brand}</p>
      <h1 id="login-heading" class="xp-page-title">${audience ? profileHeading : text(`Sign in to ${brand}`, `تسجيل الدخول إلى ${brand}`)}</h1>
      ${mfaDisabled ? `<p class="xp-help" role="status" data-mfa-disabled>${text('Two-factor verification is disabled in development. Saved factors stay unchanged.', 'التحقق الثنائي معطّل في بيئة التطوير. تبقى عوامل التحقق المحفوظة دون تغيير.')}</p>` : ''}
      ${audience ? '' : `<p class="xp-subtitle" id="login-description">${mfaDisabled ? text('Enter your account username and password.', 'أدخل اسم المستخدم وكلمة المرور لحسابك.') : text('Enter your account credentials. Additional verification appears when required.', 'أدخل بيانات حسابك. تظهر خطوات التحقق الإضافية عند طلبها.')}</p>`}
      <div class="xp-alert xp-alert--critical" role="alert" data-auth-error data-lockout-state="${locked ? 'locked' : 'unknown'}" ${props.errorMessage || locked ? '' : 'hidden'}>${escapeHtml(props.errorMessage ?? (locked ? (isAr ? 'تسجيل الدخول مقفل مؤقتًا.' : 'Sign-in is temporarily locked.') : ''))}</div>
      <p class="xp-help" role="status" aria-live="polite" data-auth-status></p>
      <noscript><p>${text('JavaScript is required to submit this sign-in form.', 'يلزم تشغيل البرمجة في المتصفح لإرسال نموذج تسجيل الدخول.')}</p></noscript>
      <form class="xp-form" method="post" action="/api/auth/login" ${audience ? 'aria-labelledby="login-heading"' : 'aria-describedby="login-description"'} data-login-form>
        <div class="xp-field">
          <label class="xp-label" for="login-username">${audience === 'xmail' ? text('Mailbox address', 'عنوان صندوق البريد') : text('Username', 'اسم المستخدم')}</label>
          <input id="login-username" name="username" type="text" class="xp-input" dir="ltr" autocomplete="username" autocapitalize="none" spellcheck="false" required value="${escapeHtml(props.username ?? '')}" />
        </div>
        <div class="xp-field">
          <label class="xp-label" for="login-password">${text('Password', 'كلمة المرور')}</label>
          <div class="xp-login-password">
            <input id="login-password" name="password" type="password" class="xp-input" dir="ltr" autocomplete="current-password" required />
            <button type="button" class="xp-password-toggle" data-action="toggle-password" data-target="login-password" aria-controls="login-password" aria-pressed="false" aria-label="${text('Show password', 'إظهار كلمة المرور')}">
              <svg data-password-show width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="12" cy="12" r="2.5" stroke="currentColor" stroke-width="1.6"/></svg>
              <svg data-password-hide width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true" hidden><path d="m4 4 16 16M9.8 6.3A11 11 0 0 1 12 6c6.1 0 9.5 6 9.5 6a17 17 0 0 1-3.2 3.8M6.1 7.6A18 18 0 0 0 2.5 12s3.4 6 9.5 6a11 11 0 0 0 4-0.8M10.2 10.2a2.5 2.5 0 0 0 3.6 3.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
              <span data-password-label>${text('Show', 'إظهار')}</span>
            </button>
          </div>
        </div>
        ${mfaDisabled ? '' : `<fieldset class="xp-fieldset" data-auth-mfa-fields data-2fa-step="unknown" hidden>
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
        </fieldset>`}
        <button type="submit" class="xp-btn xp-btn--primary" data-auth-submit disabled>${text('Sign in', 'تسجيل الدخول')}</button>
      </form>
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
      ${audience && audience !== 'xwhm' ? `<details class="xp-cli-recovery" data-account-recovery><summary>${text('Sign-in help', 'مساعدة الدخول')}</summary><p class="xp-help">${text('This page cannot reset a password. If you forgot yours, ask your hosting provider to set a new one, then sign in here. When the account uses two-factor authentication, a recovery code can be entered after the password is accepted.', 'هذه الصفحة لا تعيد تعيين كلمة المرور. إذا نسيتها، اطلب من مزوّد الاستضافة تعيين كلمة جديدة ثم سجّل الدخول هنا. إذا كان الحساب يستخدم التحقق الثنائي، يمكن إدخال رمز استرداد بعد قبول كلمة المرور.')}</p>${contact ? `<p class="xp-help" data-support-contact="email">${text('Write to', 'راسل')} <a href="mailto:${escapeHtml(contact)}"><bdi dir="ltr">${escapeHtml(contact)}</bdi></a>.</p>` : `<p class="xp-help">${text('Your hosting provider is the person who can set that password.', 'مزوّد الاستضافة هو من يستطيع تعيين كلمة المرور.')}</p>`}</details>` : `<details class="xp-cli-recovery" data-admin-note>
        <summary>${text('Server administrator', 'مدير الخادم')}</summary>
        <p class="xp-help">${text('Password and two-factor recovery are done on the server by someone with root access. The steps are in the operations runbook, not on this page.', 'استعادة كلمة المرور والتحقق الثنائي تتم على الخادم بيد من يملك صلاحية الجذر. الخطوات في دليل التشغيل، وليست في هذه الصفحة.')}</p>
      </details>`}
      ${siblingPanels.length ? `<nav class="xp-login-siblings" aria-label="${text('Other panels', 'اللوحات الأخرى')}"><span class="xp-help">${text('Other panels on this server', 'لوحات أخرى على هذا الخادم')}</span>${siblingPanels.map(panel => `<a class="xp-login-sibling" data-panel-link="${panel.surface}" href="${escapeHtml(panel.origin)}/login?lang=${locale}&amp;theme=${theme}">${panelLabel(panel.surface as PanelId)}</a>`).join('')}</nav>` : ''}
    </section>

    ${audience ? '' : `<aside class="xp-login-aside" aria-label="${text('Sign-in information and surfaces', 'معلومات الدخول والواجهات')}">
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
    </aside>`}
  </main>
  ${audience ? '' : `  <footer class="xp-login-footer" role="contentinfo">
    <span>${text('xPanel Hosting Control Plane', 'منصة استضافة xPanel')}</span>
    <span>${text('Keyboard accessible · English (LTR) & Arabic (RTL)', 'دعم كامل للوحة المفاتيح · العربية والإنجليزية')}</span>
  </footer>`}
</div>`.trim()
}
import type { MfaRuntimeMode } from '@xpanel/core'
