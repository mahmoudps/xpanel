import { publicContactEmail } from '../display-name.ts'
import { escapeHtml } from '../tokens.ts'
import { LOGIN_LAYOUT_CSS, publicHost, renderLoginContext, renderLoginFooter } from './login-layout.ts'
import { SOURCE_LOCALE, alternateLocales, isLocale, translator, type Locale, type MessageValues } from '../i18n.ts'
import { renderTeamPasswordSection } from '../team-password.ts'
export interface LoginSurfaceProps {
  mfaMode?: MfaRuntimeMode
  locale?: Locale
  theme?: 'dark' | 'light'
  targetSurface?: 'xpanel' | 'xwhm' | 'xmail'
  /** Presentation selected by the server listener; never an authorization claim. */
  audience?: 'xpanel' | 'xwhm' | 'xmail'
  username?: string
  lockout?: { locked: boolean; lockedUntil?: string; retryAfterSec?: number }
  errorMessage?: string | null
  /** This listener's own exact public origin. A sign-in page names no other panel. */
  publicOrigin?: string
  /** A one-time handoff to this panel failed; the page shows one generic message. */
  handoffFailed?: boolean
  /** Configured administrator contact. Shown only when it is a plain email address. */
  supportEmail?: string
}

export const renderLoginSurface = (props: LoginSurfaceProps = {}): string => {
  const locale: Locale = isLocale(props.locale) ? props.locale : SOURCE_LOCALE
  const theme = props.theme === 'light' ? 'light' : 'dark'
  const isAudience = (value: unknown): value is NonNullable<LoginSurfaceProps['audience']> => value === 'xpanel' || value === 'xwhm' || value === 'xmail'
  const audience = isAudience(props.audience) ? props.audience : undefined
  const targetSurface = audience ?? (isAudience(props.targetSurface) ? props.targetSurface : 'xpanel')
  const brand = audience === 'xwhm' ? 'xWHM' : audience === 'xmail' ? 'xMail' : 'xPanel'
  const text = (message: string, values?: MessageValues): string => escapeHtml(translator(props.locale)(message, values))
  const markPaths = {
    xpanel: '<circle cx="12" cy="8" r="3"/><path d="M5 20v-2a7 7 0 0 1 14 0v2"/>',
    xwhm: '<rect x="4" y="3" width="16" height="7" rx="2"/><rect x="4" y="14" width="16" height="7" rx="2"/><path d="M8 6.5h.01M8 17.5h.01M12 6.5h5M12 17.5h5"/>',
    xmail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/>',
  }
  const profileHeading = audience === 'xwhm' ? text('Server sign in') : audience === 'xmail' ? text('Mail sign in') : text('Account sign in')
  const profileMark = audience ? '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + markPaths[audience] + '</svg>' : 'x'
  const themeMark = theme === 'dark'
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M20.7 14.7A9 9 0 0 1 9.3 3.3 9 9 0 1 0 20.7 14.7Z"/></svg>'
  const themeLabel = theme === 'dark' ? text('Light theme') : text('Dark theme')
  const contact = publicContactEmail(props.supportEmail)
  const host = publicHost(props.publicOrigin)
  const layout = { audience, targetSurface, locale: locale as Locale, theme: theme as 'light' | 'dark', publicOrigin: props.publicOrigin, username: props.username, lockedUntil: props.lockout?.lockedUntil, mfaDisabled: props.mfaMode === 'disabled' }
  const errorMessage = props.errorMessage ?? (props.handoffFailed ? translator(props.locale)('This sign-in link is invalid or has expired. Sign in here or open the panel again from where you started.') : null)
  const locked = props.lockout?.locked === true
  const mfaDisabled = props.mfaMode === 'disabled'
  const retry = props.lockout?.retryAfterSec
  const observedRetry = typeof retry === 'number' && Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : ''
  return `
<style>${LOGIN_LAYOUT_CSS}</style>
<div class="xp-login-shell" data-login-design="approved" data-surface="login" ${audience ? `data-login-audience="${audience}"` : ''} data-auth-state="${locked ? 'locked' : 'credentials'}" data-locked-until="${escapeHtml(props.lockout?.lockedUntil ?? '')}" data-retry-after="${observedRetry}">
  <header class="xp-login-topbar" role="banner">
    <div class="xp-brand">
      <span class="xp-brand__mark" aria-hidden="true">${profileMark}</span>
      <div class="xp-brand__text">
        <span class="xp-brand__name" dir="ltr">${brand}</span>
        ${host ? `<span class="xp-brand__sub" dir="ltr">${escapeHtml(host)}</span>` : ''}
      </div>
    </div>
    <div class="xp-topbar-actions">
      ${alternateLocales(locale).map(info => `<a href="/login?lang=${info.tag}&amp;theme=${theme}&amp;target=${targetSurface}" class="xp-btn xp-btn--ghost" lang="${info.tag}">${escapeHtml(info.nativeName)}</a>`).join('')}
      <a href="/login?lang=${locale}&amp;theme=${theme === 'dark' ? 'light' : 'dark'}&amp;target=${targetSurface}" class="xp-btn xp-btn--ghost xp-login-theme" aria-label="${themeLabel}" title="${themeLabel}">${themeMark}<span class="xp-login-theme__label">${themeLabel}</span></a>
    </div>
  </header>
  <main class="xp-login-main" aria-labelledby="login-heading">
    <div class="xp-login-entry">
      <p class="xp-login-step">${mfaDisabled ? text('Credentials') : text('Credentials, then verification when required')}</p>
    <section class="xp-card xp-login-card">
      <div class="xp-login-heading-block">
      <p class="xp-login-identity__product" dir="ltr" data-login-product="${audience ?? 'xpanel'}">${brand}</p>
      <h1 id="login-heading" class="xp-page-title">${audience ? profileHeading : text('Sign in to {brand}', { brand })}</h1>
      <p class="xp-subtitle" id="login-description">${audience === 'xwhm' ? text('Manage the server and reseller accounts.') : audience === 'xmail' ? text('Read and manage your mailbox.') : text('Manage your hosting account and domains.')}</p>
      </div>
      ${mfaDisabled ? `<p class="xp-help" role="status" data-mfa-disabled>${text('Two-factor verification is disabled in development. Saved factors stay unchanged.')}</p>` : ''}
      <div class="xp-alert xp-alert--critical" role="alert" data-auth-error data-lockout-state="${locked ? 'locked' : 'unknown'}"${props.handoffFailed && !props.errorMessage ? ' data-handoff-failed' : ''} ${errorMessage || locked ? '' : 'hidden'}>${escapeHtml(errorMessage ?? (locked ? (translator(props.locale)('Sign-in is temporarily locked.')) : ''))}</div>
      <p class="xp-help" role="status" aria-live="polite" data-auth-status></p>
      <noscript><p>${text('JavaScript is required to submit this sign-in form.')}</p></noscript>
      <form class="xp-form" method="post" action="/api/auth/login" aria-labelledby="login-heading" aria-describedby="login-description" data-login-form>
        <div class="xp-login-credential-fields">
        <div class="xp-field">
          <label class="xp-label" for="login-username">${audience === 'xmail' ? text('Mailbox address') : text('Username')}</label>
          <input id="login-username" name="username" type="text" class="xp-input" dir="ltr" autocomplete="username" autocapitalize="none" spellcheck="false" required value="${escapeHtml(props.username ?? '')}" />
        </div>
        <div class="xp-field">
          <label class="xp-label" for="login-password">${text('Password')}</label>
          <div class="xp-login-password">
            <input id="login-password" name="password" type="password" class="xp-input" dir="ltr" autocomplete="current-password" required />
            <button type="button" class="xp-password-toggle" data-action="toggle-password" data-target="login-password" aria-controls="login-password" aria-pressed="false" aria-label="${text('Show password')}">
              <svg data-password-show width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="12" cy="12" r="2.5" stroke="currentColor" stroke-width="1.6"/></svg>
              <svg data-password-hide width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true" hidden><path d="m4 4 16 16M9.8 6.3A11 11 0 0 1 12 6c6.1 0 9.5 6 9.5 6a17 17 0 0 1-3.2 3.8M6.1 7.6A18 18 0 0 0 2.5 12s3.4 6 9.5 6a11 11 0 0 0 4-0.8M10.2 10.2a2.5 2.5 0 0 0 3.6 3.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
              <span data-password-label>${text(msgctxt('login', 'Show'))}</span>
            </button>
          </div>
        </div>
        </div>
        ${mfaDisabled ? '' : `<fieldset class="xp-fieldset" data-auth-mfa-fields data-2fa-step="unknown" hidden>
          <legend class="xp-label">${text('Two-factor verification')}</legend>
          <div class="xp-login-challenge-content">
          <div class="xp-login-challenge-heading">
          <div class="xp-login-challenge-summary"><span dir="ltr">${brand}</span>${props.username ? `<bdi dir="ltr">${escapeHtml(props.username)}</bdi>` : ''}<button type="button" class="xp-btn xp-btn--ghost" data-action="change-login-credentials">${text(msgctxt('login', 'Change'))}</button></div>
          <p class="xp-help">${text('Enter a fresh authenticator code or one recovery code, not both.')}</p>
          </div>
          <div class="xp-field" id="login-factor-totp" data-login-factor="totp">
            <label class="xp-label" for="login-otp">${text('Authenticator code')}</label>
            <input id="login-otp" name="totpCode" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" class="xp-input xp-mono xp-login-otp" dir="ltr" autocomplete="one-time-code" aria-describedby="login-otp-help" />
            <p id="login-otp-help" class="xp-help">${text('Use the 6-digit code from the authenticator linked to this account.')}</p>
          </div>
          <div class="xp-field" id="login-factor-recovery" data-login-factor="recovery" hidden>
            <label class="xp-label" for="login-recovery-code">${text('Recovery code')}</label>
            <input id="login-recovery-code" name="recoveryCode" type="text" class="xp-input xp-mono" dir="ltr" autocomplete="off" aria-describedby="login-recovery-help" />
            <p id="login-recovery-help" class="xp-help">${text('Each recovery code works once. Enter a recovery code instead of an authenticator code.')}</p>
          </div>
          <button type="button" class="xp-btn xp-btn--ghost xp-login-factor-toggle" data-action="toggle-login-factor" data-login-factor-toggle aria-controls="login-factor-totp login-factor-recovery" aria-pressed="false">${text(msgctxt('login', 'Use a recovery code'))}</button>
          </div>
        </fieldset>`}
        <button type="submit" class="xp-btn xp-btn--primary" data-auth-submit disabled>${text('Sign in')}</button>
      </form>
      ${audience === 'xwhm' || audience === 'xmail' ? '' : renderTeamPasswordSection(props.locale)}
      <section class="xp-login-success" data-login-success data-required-auth-state="authenticated" aria-labelledby="login-success-heading" role="status">
        <h2 id="login-success-heading">${text('You are signed in')}</h2>
        <p>${text('Your sign-in was accepted. Opening your workspace…')}</p>
      </section>
      <section data-auth-password-change hidden aria-labelledby="password-change-heading">
        <h2 id="password-change-heading">${text('Change your password')}</h2>
        <p>${text('Your account requires a new password. You will sign in again after changing it.')}</p>
        <form class="xp-form" data-auth-password-form>
          <div class="xp-field"><label class="xp-label" for="change-current-password">${text('Current password')}</label><input id="change-current-password" name="currentPassword" type="password" dir="ltr" class="xp-input" autocomplete="current-password" required /></div>
          <div class="xp-field"><label class="xp-label" for="change-new-password">${text('New password')}</label><input id="change-new-password" name="newPassword" type="password" dir="ltr" class="xp-input" autocomplete="new-password" required /></div>
          <div class="xp-field"><label class="xp-label" for="change-confirm-password">${text('Confirm new password')}</label><input id="change-confirm-password" name="confirmPassword" type="password" dir="ltr" class="xp-input" autocomplete="new-password" required /></div>
          <button type="submit" class="xp-btn xp-btn--primary">${text('Change password')}</button>
        </form>
      </section>
      <button type="button" class="xp-btn" data-action="logout" data-auth-cancel hidden>${text('Cancel and sign out')}</button>
      ${audience && audience !== 'xwhm' ? `<details class="xp-cli-recovery" data-account-recovery><summary>${text('Sign-in help')}</summary><p class="xp-help">${text('This page cannot reset a password. If you forgot yours, ask your hosting provider to set a new one, then sign in here. When the account uses two-factor authentication, a recovery code can be entered after the password is accepted.')}</p>${contact ? `<p class="xp-help" data-support-contact="email">${text('Write to')} <a href="mailto:${escapeHtml(contact)}"><bdi dir="ltr">${escapeHtml(contact)}</bdi></a>.</p>` : `<p class="xp-help">${text('Your hosting provider is the person who can set that password.')}</p>`}</details>` : `<details class="xp-cli-recovery" data-admin-note>
        <summary>${text('Server administrator')}</summary>
        <p class="xp-help">${text('Password and two-factor recovery are done on the server by someone with root access. The steps are in the operations runbook, not on this page.')}</p>
      </details>`}
    </section>
    </div>
    ${renderLoginContext(layout)}
  </main>
  ${renderLoginFooter(layout)}
</div>`.trim()
}
import type { MfaRuntimeMode } from '@xpanel/core'
