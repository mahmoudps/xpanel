import type { MfaRuntimeMode, Principal } from '@xpanel/core'
import type { Locale } from '../i18n.ts'
import { t } from '../i18n.ts'
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
}

const line = (locale: Locale, key: string): string => escapeHtml(t(locale, key))

const cliHint = (locale: Locale): string => {
  const [before, after] = t(locale, 'security.2fa.cliHint').split('{command}')
  const command = ['xpanel', 'disable-2fa', 'root', '--confirm'].map(token => `<span style="white-space: nowrap">${escapeHtml(token)}</span>`).join(' ')
  return `${escapeHtml(before ?? '')}<bdi dir="ltr" class="xp-mono" style="overflow-wrap: anywhere">${command}</bdi>${escapeHtml(after ?? '')}`
}

/** Optional authenticator enrollment. It never replaces the password session or closes the workspace. */
export const renderAccountSecurityCard = (props: AccountSecurityCardProps): string => {
  const { locale, totpEnabled, principalKind, surface } = props
  const rootOperator = principalKind === 'root' && surface === 'xwhm'
  if (props.mfaMode === 'disabled') {
    const notice = locale === 'ar'
      ? 'التحقق الثنائي معطّل في بيئة التطوير. تبقى العوامل ورموز الاسترداد المحفوظة دون تغيير. لا تتوفر إدارة العوامل في هذا الوضع.'
      : 'Two-factor verification is disabled in development. Saved factors and recovery codes stay unchanged. Factor management is unavailable in this mode.'
    return `<section class="xp-card xp-account-security" data-account-security="two-factor" data-auth-state="development-disabled" data-mfa-disabled data-mfa-configured="${totpEnabled}" aria-labelledby="account-security-heading">
      <h2 id="account-security-heading">${line(locale, 'security.2fa.heading')}</h2>
      <p class="xp-prose" role="status">${escapeHtml(notice)}</p>
    </section>`
  }
  if (totpEnabled) {
    return `<section class="xp-card xp-account-security" data-account-security="two-factor" data-mfa-enabled="true" aria-labelledby="account-security-heading">
      <h2 id="account-security-heading">${line(locale, 'security.2fa.heading')}</h2>
      <p class="xp-prose" role="status">${line(locale, 'security.2fa.enabled')}</p>
      ${rootOperator ? `<p class="xp-help">${cliHint(locale)}</p>` : ''}
    </section>`
  }
  return `<section class="xp-card xp-account-security" data-account-security="two-factor" data-auth-state="optional" aria-labelledby="account-security-heading">
    <h2 id="account-security-heading">${line(locale, 'security.2fa.heading')}</h2>
    <div role="alert" data-auth-error hidden></div>
    <p class="xp-help" role="status" aria-live="polite" data-auth-status></p>
    <div data-auth-enrollment>
      ${rootOperator
        ? `<p class="xp-prose" role="status" data-mfa-recommendation>${line(locale, 'security.2fa.rootRecommendation')}</p>`
        : `<p class="xp-prose" role="status">${line(locale, 'security.2fa.optional')}</p>`}
      <form class="xp-form" data-auth-setup-form>
        <div class="xp-field">
          <label class="xp-label" for="enrollment-password">${line(locale, 'security.2fa.confirmPassword')}</label>
          <input id="enrollment-password" name="password" type="password" class="xp-input" dir="ltr" autocomplete="current-password" required />
        </div>
        <button type="submit" class="xp-btn xp-btn--primary" data-action="setup-2fa">${line(locale, 'security.2fa.start')}</button>
      </form>
      <div data-auth-enrollment-details hidden>
        <div class="xp-field" data-auth-totp-qr-field hidden><span class="xp-label">${line(locale, 'security.2fa.qr')}</span><div class="xp-totp-qr" data-auth-totp-qr dir="ltr"></div></div>
        <div class="xp-field"><span class="xp-label">${line(locale, 'security.2fa.setupKey')}</span><div><bdi dir="ltr" class="xp-mono" data-auth-totp-secret></bdi></div></div>
        <p class="xp-help">${line(locale, 'security.2fa.setupHelp')}</p>
        <form class="xp-form" data-auth-enroll-form>
          <div class="xp-field"><label class="xp-label" for="enrollment-code">${line(locale, 'security.2fa.code')}</label><input id="enrollment-code" name="code" class="xp-input xp-mono" dir="ltr" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required /></div>
          <button type="submit" class="xp-btn xp-btn--primary">${line(locale, 'security.2fa.verify')}</button>
        </form>
        <button type="button" class="xp-btn" data-action="restart-enrollment">${line(locale, 'security.2fa.restart')}</button>
      </div>
    </div>
    <section data-auth-recovery hidden aria-labelledby="recovery-heading">
      <h2 id="recovery-heading">${line(locale, 'security.2fa.recoveryHeading')}</h2>
      <p>${line(locale, 'security.2fa.recoveryHelp')}</p>
      <ul data-auth-recovery-codes></ul>
      <button type="button" class="xp-btn xp-btn--primary" data-action="acknowledge-recovery">${line(locale, 'security.2fa.continue')}</button>
    </section>
  </section>`
}
