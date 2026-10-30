import type { MfaRuntimeMode, Principal } from '@xpanel/core'
import { translator, type Locale } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

/** Account and operator pages where two-factor enrollment stays available without blocking sign-in. */
export const ACCOUNT_SECURITY_ROUTES = new Set([
  '/whm/security/sign-in',
  '/security/account',
  '/mail/settings/security',
])

export interface AccountSecurityCardProps {
  locale: Locale
  totpEnabled: boolean
  mfaMode?: MfaRuntimeMode
  principalKind: Principal['kind']
  surface: 'xwhm' | 'xpanel' | 'xmail'
  /** Server-derived handed-off sessions can observe factor state but cannot manage it. */
  readOnly?: boolean
}

const line = (locale: Locale, message: string): string => escapeHtml(translator(locale)(message))

const cliHint = (locale: Locale): string => {
  const [before, after] = translator(locale)('An administrator with root SSH access can turn it off with {command}. Password sign-in works again afterwards.').split('{command}')
  const command = ['xpanel', 'disable-2fa', 'root', '--confirm'].map(token => `<span style="white-space: nowrap">${escapeHtml(token)}</span>`).join(' ')
  return `${escapeHtml(before ?? '')}<bdi dir="ltr" class="xp-mono" style="overflow-wrap: anywhere">${command}</bdi>${escapeHtml(after ?? '')}`
}

/** Optional authenticator enrollment. It never replaces the password session or closes the workspace. */
export const renderAccountSecurityCard = (props: AccountSecurityCardProps): string => {
  const { locale, totpEnabled, principalKind, surface } = props
  const rootOperator = principalKind === 'root' && surface === 'xwhm'
  if (props.mfaMode === 'disabled') {
    const notice = translator(locale)('Two-factor verification is disabled in development. Saved factors and recovery codes stay unchanged. Factor management is unavailable in this mode.')
    return `<section class="xp-card xp-account-security" style="display:flex;flex-direction:column;gap:var(--xp-space-card)" data-account-security="two-factor" data-auth-state="development-disabled" data-mfa-disabled data-mfa-configured="${totpEnabled}" aria-labelledby="account-security-heading">
      <h2 id="account-security-heading">${line(locale, 'Two-factor authentication')}</h2>
      <p class="xp-prose" role="status">${escapeHtml(notice)}</p>
    </section>`
  }
  if (props.readOnly) {
    return `<section class="xp-card xp-account-security" style="display:flex;flex-direction:column;gap:var(--xp-space-card)" data-account-security="two-factor" data-auth-state="read-only" data-auth-readonly="true" data-mfa-configured="${totpEnabled}" aria-labelledby="account-security-heading">
      <h2 id="account-security-heading">${line(locale, 'Two-factor authentication')}</h2>
      <p class="xp-prose" role="status">${line(locale, msgctxt('account-security', 'Two-factor settings cannot be changed from a handed-off session.'))}</p>
      <p class="xp-prose">${totpEnabled ? line(locale, 'Sign-in asks for an authenticator code because two-factor authentication is enabled.') : line(locale, msgctxt('account-security', 'Password sign-in is active.'))}</p>
    </section>`
  }
  if (totpEnabled) {
    return `<section class="xp-card xp-account-security" style="display:flex;flex-direction:column;gap:var(--xp-space-card)" data-account-security="two-factor" data-mfa-enabled="true" aria-labelledby="account-security-heading">
      <h2 id="account-security-heading">${line(locale, 'Two-factor authentication')}</h2>
      <p class="xp-prose" role="status">${line(locale, 'Sign-in asks for an authenticator code because two-factor authentication is enabled.')}</p>
      ${rootOperator ? `<p class="xp-help">${cliHint(locale)}</p>` : ''}
    </section>`
  }
  return `<section class="xp-card xp-account-security" style="display:flex;flex-direction:column;gap:var(--xp-space-card)" data-account-security="two-factor" data-auth-state="optional" aria-labelledby="account-security-heading">
    <h2 id="account-security-heading">${line(locale, 'Two-factor authentication')}</h2>
    <div role="alert" data-auth-error hidden></div>
    <p class="xp-help" role="status" aria-live="polite" data-auth-status></p>
    <div data-auth-enrollment>
      ${rootOperator
        ? `<p class="xp-prose" role="status" data-mfa-recommendation>${line(locale, 'Two-factor authentication is off for root. Enabling an authenticator is recommended and does not block this workspace.')}</p>`
        : `<p class="xp-prose" role="status">${line(locale, 'Password sign-in is active. You can add an authenticator whenever you choose.')}</p>`}
      <form class="xp-form" data-auth-setup-form>
        <div class="xp-field">
          <label class="xp-label" for="enrollment-password">${line(locale, 'Confirm current password')}</label>
          <input id="enrollment-password" name="password" type="password" class="xp-input" dir="ltr" autocomplete="current-password" required />
        </div>
        <button type="submit" class="xp-btn xp-btn--primary" data-action="setup-2fa">${line(locale, 'Start enrollment')}</button>
      </form>
      <div data-auth-enrollment-details hidden>
        <div class="xp-field" data-auth-totp-qr-field hidden><span class="xp-label">${line(locale, 'Scan this QR code with your authenticator app')}</span><div class="xp-totp-qr" data-auth-totp-qr dir="ltr"></div></div>
        <div class="xp-field"><span class="xp-label">${line(locale, 'Authenticator setup key')}</span><div><bdi dir="ltr" class="xp-mono" data-auth-totp-secret></bdi></div></div>
        <p class="xp-help">${line(locale, 'Scan the QR code or enter this key in your authenticator app, then submit its code.')}</p>
        <form class="xp-form" data-auth-enroll-form>
          <div class="xp-field"><label class="xp-label" for="enrollment-code">${line(locale, 'Authenticator code')}</label><input id="enrollment-code" name="code" class="xp-input xp-mono" dir="ltr" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required /></div>
          <button type="submit" class="xp-btn xp-btn--primary">${line(locale, 'Verify and enable')}</button>
        </form>
        <button type="button" class="xp-btn" data-action="restart-enrollment">${line(locale, 'Restart enrollment')}</button>
      </div>
    </div>
    <section data-auth-recovery hidden aria-labelledby="recovery-heading">
      <h2 id="recovery-heading">${line(locale, 'Save your recovery codes')}</h2>
      <p>${line(locale, 'Store these codes safely. Each code can be used once. They disappear when you continue.')}</p>
      <ul data-auth-recovery-codes></ul>
      <button type="button" class="xp-btn xp-btn--primary" data-action="acknowledge-recovery">${line(locale, 'I saved the codes — continue')}</button>
    </section>
  </section>`
}
