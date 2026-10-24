import { panelLabel, safePanelLinks, type PanelId, type PanelLink } from '../chrome.ts'
import { publicContactEmail } from '../display-name.ts'
import { escapeHtml } from '../tokens.ts'

type Audience = 'xpanel' | 'xwhm' | 'xmail'
type Locale = 'en' | 'ar'

export interface LoginHostFacts {
  hostname?: string
  clientIp?: string
  serverIp?: string
  version?: string
}

export interface LoginLockoutFacts {
  locked: boolean
  lockedUntil?: string
  retryAfterSec?: number
  /** Observed failure count. Omitted when the lockout row did not carry one. */
  failures?: number
  /** Configured lockout window, in minutes. Omitted when it was not read. */
  windowMinutes?: number
  lastAttemptAt?: string
  clientIp?: string
  /** Clock freeze for the artboard fixture. Production leaves this unset and the page counts down. */
  minutesRemaining?: number
}

export interface LoginSurfaceProps {
  locale?: Locale
  theme?: 'dark' | 'light'
  targetSurface?: Audience
  /** Presentation selected by the server listener; never an authorization claim. */
  audience?: Audience
  username?: string
  /** Artboard sample only. Production sign-in leaves the password empty. */
  passwordPreview?: string
  lockout?: LoginLockoutFacts
  errorMessage?: string | null
  /** Exact public origins of the three panels. Omitted origins are not linked. */
  panels?: readonly PanelLink[]
  /** Configured administrator contact. Shown only when it is a plain email address. */
  supportEmail?: string
  host?: LoginHostFacts
  /**
   * Artboard composition: the password step and the paused step side by side.
   * Production omits this. It does not change the authentication state machine.
   */
  companionLockout?: boolean
  /** Which step is visible. Production starts at password; the client moves to totp or locked. */
  step?: 'password' | 'totp' | 'recovery' | 'done'
}

const MONO = "'IBM Plex Mono', monospace"
const SANS = "'IBM Plex Sans', 'IBM Plex Sans Arabic', system-ui, sans-serif"
const PORT_CSS = `[data-board-port="login"]{line-height:normal;font-size:16px;font-kerning:auto;font-feature-settings:normal;font-synthesis:weight style small-caps;-webkit-font-smoothing:auto;text-rendering:auto;font-family:${SANS}}
html[lang="ar"] [data-board-port="login"]{font-family:'IBM Plex Sans Arabic','IBM Plex Sans',system-ui,sans-serif}
[data-board-port="login"] p{max-inline-size:none;line-height:normal}
[data-board-port="login"] form{margin:0}
[data-board-port="login"] time{font-family:inherit;font-weight:inherit;font-variant-numeric:inherit}
@media (prefers-reduced-motion:reduce){[data-board-port="login"] *{animation:none!important;transition:none!important}}`

const isAudience = (value: unknown): value is Audience => value === 'xpanel' || value === 'xwhm' || value === 'xmail'

const observedRetry = (retry: number | undefined): string =>
  typeof retry === 'number' && Number.isFinite(retry) && retry > 0 ? String(Math.ceil(retry)) : ''

const utcStamp = (iso: string | undefined): { attr: string; text: string; clock: string } | null => {
  if (!iso) return null
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return null
  const date = new Date(parsed)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const y = date.getUTCFullYear()
  const m = pad(date.getUTCMonth() + 1)
  const d = pad(date.getUTCDate())
  const hh = pad(date.getUTCHours())
  const mm = pad(date.getUTCMinutes())
  return { attr: `${y}-${m}-${d}T${hh}:${mm}Z`, text: `${y}-${m}-${d} ${hh}:${mm} UTC`, clock: `${hh}:${mm}` }
}

const mono = (value: string, locale: Locale): string =>
  `<bdi${locale === 'ar' ? ' dir="ltr"' : ''} style="font-family: ${MONO}">${escapeHtml(value)}</bdi>`

const eyeOpen = `<svg data-password-show aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"></path><circle cx="12" cy="12" r="3"></circle></svg>`
const eyeShut = `<svg data-password-hide hidden aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"></path><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7c1.8 0 3.4-.5 4.8-1.3"></path><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"></path></svg>`
const clockIcon = `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#B54708" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex: 0 0 auto; margin-top: 2px"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>`
const okIcon = `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0E7A4E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex: 0 0 auto; margin-top: 2px"><circle cx="12" cy="12" r="9"></circle><path d="M8 12.5l2.5 2.5L16 9.5"></path></svg>`

interface SurfaceCopy {
  name: string
  mark: string
  title: string
  lede: string
  userLabel: string
  forgot: string
  home: string
  homeLabel: string
}

const surfaceCopy = (audience: Audience, locale: Locale, hostname: string): SurfaceCopy => {
  const ar = locale === 'ar'
  const host = hostname ? escapeHtml(hostname) : ''
  if (audience === 'xwhm') {
    return {
      name: 'xWHM', mark: '#1D5BD6',
      title: ar ? 'تسجيل الدخول إلى <bdi dir="ltr">xWHM</bdi>' : 'Sign in to xWHM',
      lede: ar
        ? `إدارة الخادم لمن يملك صلاحية الجذر والموزعين${host ? ` على ${mono(hostname, 'ar')}` : ''}.`
        : `Server administration for root and resellers${host ? ` on ${host}` : ''}.`,
      userLabel: ar ? 'اسم المستخدم' : 'Username',
      forgot: ar
        ? 'نسيت كلمة مرور الجذر؟ تُستعاد من سطر الخادم. الموزعون يطلبون ذلك من الجذر.'
        : 'Forgot the root password? Reset it from the server shell. Resellers ask root.',
      home: '/whm',
      homeLabel: ar ? 'افتح لوحة الخادم' : 'Open the server dashboard',
    }
  }
  if (audience === 'xmail') {
    return {
      name: 'xMail', mark: '#0E7A4E',
      title: ar ? 'تسجيل الدخول إلى <bdi dir="ltr">xMail</bdi>' : 'Sign in to xMail',
      lede: ar ? 'اقرأ البريد وأرسله. سجّل الدخول بعنوان البريد كاملًا.' : 'Read and send email. Sign in with your full email address.',
      userLabel: ar ? 'عنوان البريد' : 'Email address',
      forgot: ar
        ? 'نسيت كلمة المرور؟ يستطيع صاحب حساب الاستضافة إعادة تعيينها من <bdi dir="ltr">xPanel</bdi>.'
        : 'Forgot your password? The owner of the hosting account can reset it in xPanel.',
      home: '/mail/inbox',
      homeLabel: ar ? 'افتح الوارد' : 'Open the inbox',
    }
  }
  return {
    name: 'xPanel', mark: '#101828',
    title: ar ? 'تسجيل الدخول إلى <bdi dir="ltr">xPanel</bdi>' : 'Sign in to xPanel',
    lede: ar
      ? 'إدارة حساب الاستضافة: الملفات والنطاقات وقواعد البيانات والبريد.'
      : 'Manage your hosting account: files, domains, databases and email.',
    userLabel: ar ? 'اسم المستخدم' : 'Username',
    forgot: ar
      ? 'نسيت كلمة المرور؟ يستطيع مزوّد الاستضافة إعادة تعيينها من <bdi dir="ltr">xWHM</bdi>.'
      : 'Forgot your password? Your hosting provider can reset it from xWHM.',
    home: '/home',
    homeLabel: ar ? 'افتح <bdi dir="ltr">xPanel</bdi>' : 'Open xPanel',
  }
}

const text = (locale: Locale, en: string, ar: string): string => locale === 'ar' ? ar : en

export const renderLoginSurface = (props: LoginSurfaceProps = {}): string => {
  const locale: Locale = props.locale === 'ar' ? 'ar' : 'en'
  const theme = props.theme === 'light' ? 'light' : 'dark'
  const audience = isAudience(props.audience) ? props.audience : undefined
  const selected = audience ?? 'xpanel'
  const targetSurface = audience ?? (isAudience(props.targetSurface) ? props.targetSurface : selected)
  const host = props.host ?? {}
  const hostname = typeof host.hostname === 'string' && host.hostname.trim() ? host.hostname.trim() : ''
  const clientIp = typeof host.clientIp === 'string' && host.clientIp.trim() ? host.clientIp.trim() : ''
  const serverIp = typeof host.serverIp === 'string' && host.serverIp.trim() ? host.serverIp.trim() : ''
  const version = typeof host.version === 'string' && host.version.trim() ? host.version.trim() : ''
  const copy = surfaceCopy(selected, locale, hostname)
  const locked = props.lockout?.locked === true
  const companion = props.companionLockout === true
  const step = props.step === 'totp' || props.step === 'recovery' || props.step === 'done' ? props.step : 'password'
  const showFlow = companion || !locked
  const showLockout = companion || locked
  const retry = observedRetry(props.lockout?.retryAfterSec)
  const contact = publicContactEmail(props.supportEmail)
  const panels = safePanelLinks(props.panels)
  const originFor = (id: Audience): string => panels.find(panel => panel.surface === id && panel.surface !== selected)?.origin ?? ''
  const username = props.username ?? ''
  const lockUser = username
  const lockIp = props.lockout?.clientIp?.trim() || clientIp
  const paused = utcStamp(props.lockout?.lockedUntil)
  const last = utcStamp(props.lockout?.lastAttemptAt)
  const minutes = typeof props.lockout?.minutesRemaining === 'number' && Number.isFinite(props.lockout.minutesRemaining)
    ? Math.max(0, Math.trunc(props.lockout.minutesRemaining))
    : paused
      ? Math.max(0, Math.ceil((Date.parse(props.lockout?.lockedUntil ?? '') - Date.now()) / 60_000))
      : null
  const failures = typeof props.lockout?.failures === 'number' && Number.isFinite(props.lockout.failures) ? Math.trunc(props.lockout.failures) : null
  const windowMinutes = typeof props.lockout?.windowMinutes === 'number' && Number.isFinite(props.lockout.windowMinutes) ? Math.trunc(props.lockout.windowMinutes) : null
  const attemptText = failures === null ? '—' : windowMinutes === null ? String(failures) : `${failures} within ${windowMinutes} minutes`
  const dash = '—'
  const langHref = `/login?lang=${locale === 'ar' ? 'en' : 'ar'}&amp;theme=${theme}&amp;target=${targetSurface}`
  const segment = (id: Audience, name: string, mark: string): string => {
    const on = id === selected
    const style = `flex: 1 1 0; min-width: 0; min-height: 44px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 0 8px; border-radius: 8px; border: 1px solid ${on ? '#D0D5DD' : 'transparent'}; background: ${on ? '#FFFFFF' : 'transparent'}; color: ${on ? '#101828' : '#475467'}; font-family: ${MONO}; font-size: 14px; font-weight: ${on ? '600' : '500'}; cursor: pointer; text-decoration: none`
    const body = `<span aria-hidden="true" style="flex: 0 0 auto; width: 18px; height: 18px; border-radius: 5px; background: ${mark}; color: #FFFFFF; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600">x</span><span>${name}</span>`
    if (on || !originFor(id)) {
      const hint = on ? '' : ` title="${escapeHtml(text(locale, 'This panel is not linked on this server', 'هذه اللوحة غير مربوطة على هذا الخادم'))}" aria-disabled="true"`
      return `<button type="button" aria-pressed="${on ? 'true' : 'false'}"${hint} style="${style}">${body}</button>`
    }
    return `<a data-panel-link="${id}" href="${escapeHtml(originFor(id))}/login?lang=${locale}&amp;theme=${theme}" style="${style}">${body}</a>`
  }
  const errorText = props.errorMessage ? escapeHtml(props.errorMessage) : ''
  const pauseSentence = minutes !== null && failures !== null && lockIp && paused
    ? text(
      locale,
      `<strong style="font-weight: 600">Sign-in is paused for ${minutes} minutes after ${failures} failed attempts from ${mono(lockIp, locale)}.</strong> You can try again at ${escapeHtml(paused.clock)} UTC.`,
      `<strong style="font-weight: 600">توقف تسجيل الدخول لمدة ${minutes} دقيقة بعد ${failures} محاولات فاشلة من ${mono(lockIp, locale)}.</strong> يمكنك المحاولة عند ${escapeHtml(paused.clock)} UTC.`,
    )
    : errorText || text(locale, 'Sign-in is paused.', 'توقف تسجيل الدخول.')
  const again = minutes === null
    ? text(locale, 'Try again when the pause ends', 'حاول مجددًا عند انتهاء المهلة')
    : text(locale, `Try again in ${minutes} minutes`, `حاول مجددًا بعد ${minutes} دقيقة`)
  const passwordStepHidden = step !== 'password'
  const totpHidden = step !== 'totp' && step !== 'recovery'
  const recovery = step === 'recovery'
  const doneHidden = step !== 'done'
  const totpLede = text(
    locale,
    `Enter the 6-digit code from the authenticator app linked to ${escapeHtml(username || dash)}.`,
    `أدخل الرمز المكوّن من 6 أرقام من تطبيق المصادقة المرتبط بـ ${username ? mono(username, locale) : dash}.`,
  )

  return `
<div data-board-port="login" data-auth-state="${locked && !companion ? 'locked' : 'credentials'}" data-auth-step="${locked && !companion ? 'locked' : step}" ${audience ? `data-login-audience="${audience}"` : ''} data-login-product="${selected}" ${companion ? 'data-login-companion="true"' : ''} data-locked-until="${escapeHtml(props.lockout?.lockedUntil ?? '')}" data-retry-after="${retry}" style="min-height: 100vh; display: flex; flex-direction: column; background: #F5F6F8; color: #101828">
  <style>${PORT_CSS}</style>
  <header role="banner" style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 16px clamp(16px, 4vw, 32px)">
    <div style="display: flex; align-items: center; gap: 10px">
      <span aria-hidden="true" style="flex: 0 0 auto; width: 36px; height: 36px; border-radius: 8px; background: #101828; color: #FFFFFF; display: flex; align-items: center; justify-content: center; font-family: ${MONO}; font-size: 18px; font-weight: 500">x</span>
      <div style="display: flex; flex-direction: column">
        <span style="font-family: ${MONO}; font-size: 17px; font-weight: 500; color: #1D5BD6; line-height: 1.3">xPanel</span>
        <span style="font-family: ${MONO}; font-size: 12px; color: #5D6B7E; line-height: 1.3">${hostname ? escapeHtml(hostname) : dash}</span>
      </div>
    </div>
    <a href="${langHref}" lang="${locale === 'ar' ? 'en' : 'ar'}" hreflang="${locale === 'ar' ? 'en' : 'ar'}" style="display: inline-flex; align-items: center; justify-content: center; min-height: 44px; min-width: 44px; padding: 0 12px; border-radius: 8px; font-family: ${locale === 'ar' ? "'IBM Plex Sans', sans-serif" : "'IBM Plex Sans Arabic', 'IBM Plex Sans', sans-serif"}; font-size: 14px; font-weight: 500; color: #1D5BD6; text-decoration: none">${locale === 'ar' ? 'English' : 'العربية'}</a>
  </header>
  <main id="main-content" aria-labelledby="login-heading" style="flex: 1 1 auto; display: flex; flex-wrap: wrap; justify-content: center; align-items: flex-start; gap: 42px; padding: 26px 16px 42px">
    <div data-login-flow ${showFlow ? '' : 'hidden'} style="flex: 0 1 440px; min-width: 0; display: flex; flex-direction: column; gap: 10px">
      <p style="margin: 0; padding-inline-start: 4px; font-size: 12px; font-weight: 600; color: #5D6B7E">${text(locale, 'Password, then two-factor code', 'كلمة المرور، ثم رمز التحقق')}</p>
      <section aria-labelledby="login-heading" style="display: flex; flex-direction: column; gap: 26px; padding: 32px 28px; border-radius: 12px; background: #FFFFFF; border: 1px solid #E2E6EC">
        <div data-auth-error role="alert" data-lockout-state="${locked ? 'locked' : 'unknown'}" ${errorText && !locked ? '' : 'hidden'} style="display: flex; gap: 10px; padding: 12px 14px; border-radius: 10px; border: 1px solid #F4B8B2; background: #FDECEA; font-size: 13px; line-height: 1.6; color: #B42318">${errorText}</div>
        <p data-auth-status role="status" aria-live="polite" hidden style="margin: 0; font-size: 13px; line-height: 1.6; color: #475467"></p>
        <noscript><p style="margin: 0; font-size: 13px; line-height: 1.6; color: #475467">${text(locale, 'JavaScript is required to submit this sign-in form.', 'يلزم تشغيل البرمجة في المتصفح لإرسال نموذج تسجيل الدخول.')}</p></noscript>
        <form method="post" action="/api/auth/login" aria-labelledby="login-heading" data-login-form style="display: contents">
          <div data-login-step="password" ${passwordStepHidden ? 'hidden' : ''} style="display: flex; flex-direction: column; gap: 26px">
            <div role="group" aria-label="${text(locale, 'Choose where to sign in', 'اختر لوحة الدخول')}" style="display: flex; gap: 4px; padding: 4px; border-radius: 10px; background: #EEF0F3">
              ${segment('xpanel', 'xPanel', '#101828')}
              ${segment('xwhm', 'xWHM', '#1D5BD6')}
              ${segment('xmail', 'xMail', '#0E7A4E')}
            </div>
            <div style="display: flex; flex-direction: column; gap: 6px">
              <h1 id="login-heading" style="margin: 0; font-size: 22px; font-weight: 600; line-height: 1.3">${copy.title}</h1>
              <p style="margin: 0; font-size: 14px; color: #475467; line-height: 1.6">${copy.lede}</p>
            </div>
            <div style="display: flex; flex-direction: column; gap: 16px">
              <div style="display: flex; flex-direction: column; gap: 6px">
                <label for="login-username" style="font-size: 13px; font-weight: 600">${copy.userLabel}</label>
                <input id="login-username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" value="${escapeHtml(username)}" style="min-height: 44px; padding: 0 12px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; font-family: ${MONO}; font-size: 14px; color: #101828">
              </div>
              <div style="display: flex; flex-direction: column; gap: 6px">
                <label for="login-password" style="font-size: 13px; font-weight: 600">${text(locale, 'Password', 'كلمة المرور')}</label>
                <div style="display: flex; gap: 8px; align-items: center">
                  <input id="login-password" name="password" type="password" autocomplete="current-password" spellcheck="false" ${props.passwordPreview ? `value="${escapeHtml(props.passwordPreview)}"` : ''} style="flex: 1 1 auto; min-width: 0; min-height: 44px; padding: 0 12px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; font-family: ${MONO}; font-size: 14px; color: #101828">
                  <button type="button" data-action="toggle-password" data-target="login-password" aria-controls="login-password" aria-pressed="false" aria-label="${text(locale, 'Show password', 'إظهار كلمة المرور')}" style="flex: 0 0 auto; width: 44px; height: 44px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; color: #344054; display: flex; align-items: center; justify-content: center; cursor: pointer">${eyeOpen}${eyeShut}<span data-password-label hidden>${text(locale, 'Show', 'إظهار')}</span></button>
                </div>
              </div>
            </div>
            <div style="display: flex; flex-direction: column; gap: 12px">
              <button type="submit" data-auth-submit disabled style="width: 100%; min-height: 44px; padding: 0 18px; border-radius: 8px; border: 1px solid #1D5BD6; background: #1D5BD6; color: #FFFFFF; font-family: inherit; font-size: 14px; font-weight: 600; cursor: pointer">${text(locale, 'Continue', 'متابعة')}</button>
              <p style="margin: 0; font-size: 12px; color: #5D6B7E; line-height: 1.6">${copy.forgot}</p>
              ${contact ? `<p style="margin: 0; font-size: 12px; color: #5D6B7E; line-height: 1.6">${text(locale, 'Write to', 'راسل')} <a href="mailto:${escapeHtml(contact)}">${mono(contact, locale)}</a>.</p>` : ''}
              <p style="margin: 0; font-size: 12px; color: #5D6B7E; line-height: 1.6">${text(locale, 'After 5 failed attempts from one address, sign-in pauses for 15 minutes.', 'بعد 5 محاولات فاشلة من عنوان واحد، يتوقف تسجيل الدخول لمدة 15 دقيقة.')}</p>
            </div>
          </div>
          <div data-login-step="totp" data-auth-mfa-fields data-2fa-step="${totpHidden ? 'unknown' : 'required'}" ${totpHidden ? 'hidden' : ''} style="display: flex; flex-direction: column; gap: 26px">
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-block: 4px; padding-inline: 14px 4px; border-radius: 10px; background: #F8F9FB; border: 1px solid #E2E6EC">
              <span style="display: inline-flex; align-items: center; gap: 8px; min-width: 0; font-size: 13px; color: #344054"><span aria-hidden="true" style="flex: 0 0 auto; width: 18px; height: 18px; border-radius: 5px; background: ${copy.mark}; color: #FFFFFF; display: flex; align-items: center; justify-content: center; font-family: ${MONO}; font-size: 11px; font-weight: 600">x</span><bdi dir="ltr" style="font-family: ${MONO}">${copy.name}</bdi><span aria-hidden="true">·</span><bdi dir="ltr" style="font-family: ${MONO}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap">${escapeHtml(username || dash)}</bdi></span>
              <button type="button" data-action="login-back" style="flex: 0 0 auto; min-height: 44px; padding: 0 12px; border-radius: 8px; border: 1px solid transparent; background: transparent; color: #1D5BD6; font-family: inherit; font-size: 14px; font-weight: 600; cursor: pointer">${text(locale, 'Change', 'تغيير')}</button>
            </div>
            <div style="display: flex; flex-direction: column; gap: 6px">
              <h2 id="login-totp-heading" style="margin: 0; font-size: 22px; font-weight: 600; line-height: 1.3">${text(locale, 'Two-factor authentication', 'التحقق الثنائي')}</h2>
              <p style="margin: 0; font-size: 14px; color: #475467; line-height: 1.6">${totpLede}</p>
            </div>
            <div data-login-code ${recovery ? 'hidden' : ''} style="display: flex; flex-direction: column; gap: 6px">
              <label for="login-otp" style="font-size: 13px; font-weight: 600">${text(locale, 'Authentication code', 'رمز التحقق')}</label>
              <input id="login-otp" name="totpCode" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="000000" aria-describedby="login-otp-help" style="min-height: 52px; padding: 0 12px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; font-family: ${MONO}; font-size: 22px; letter-spacing: 0.35em; text-align: center; color: #101828">
              <span id="login-otp-help" style="font-size: 12px; font-weight: 500; color: #5D6B7E; line-height: 1.6">${text(locale, '6 digits from your authenticator app. A new code appears every 30 seconds.', '6 أرقام من تطبيق المصادقة. يظهر رمز جديد كل 30 ثانية.')}</span>
            </div>
            <div data-login-recovery ${recovery ? '' : 'hidden'} style="display: flex; flex-direction: column; gap: 6px">
              <label for="login-recovery-code" style="font-size: 13px; font-weight: 600">${text(locale, 'Recovery code', 'رمز الاسترداد')}</label>
              <input id="login-recovery-code" name="recoveryCode" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="xxxx-xxxx-xxxx" aria-describedby="login-recovery-help" style="min-height: 44px; padding: 0 12px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; font-family: ${MONO}; font-size: 15px; letter-spacing: 0.08em; color: #101828">
              <span id="login-recovery-help" style="font-size: 12px; font-weight: 500; color: #5D6B7E; line-height: 1.6">${text(locale, 'Each recovery code works once. After you sign in, create a new set under Security.', 'كل رمز استرداد يعمل مرة واحدة. بعد الدخول، أنشئ مجموعة جديدة من الأمان.')}</span>
            </div>
            <div style="display: flex; flex-direction: column; gap: 8px">
              <button type="submit" style="width: 100%; min-height: 44px; padding: 0 18px; border-radius: 8px; border: 1px solid #1D5BD6; background: #1D5BD6; color: #FFFFFF; font-family: inherit; font-size: 14px; font-weight: 600; cursor: pointer">${text(locale, 'Verify and sign in', 'تحقق وسجّل الدخول')}</button>
              <button type="button" data-action="toggle-recovery" style="align-self: center; min-height: 44px; padding: 0 12px; border-radius: 8px; border: none; background: transparent; color: #1D5BD6; font-family: inherit; font-size: 14px; font-weight: 500; text-decoration: underline; text-underline-offset: 3px; cursor: pointer">${recovery ? text(locale, 'Use an authenticator code', 'استخدم رمز التحقق') : text(locale, 'Use a recovery code', 'استخدم رمز استرداد')}</button>
            </div>
          </div>
        </form>
        <div data-login-step="done" ${doneHidden ? 'hidden' : ''} style="display: flex; flex-direction: column; gap: 26px">
          <div style="display: flex; flex-direction: column; gap: 6px">
            <h2 style="margin: 0; font-size: 22px; font-weight: 600; line-height: 1.3">${text(locale, 'You are signed in', 'تم تسجيل الدخول')}</h2>
            <p style="margin: 0; font-size: 14px; color: #475467; line-height: 1.6">${text(locale, 'Session for', 'جلسة')} ${username ? mono(username, locale) : dash}${clientIp ? ` ${text(locale, 'from', 'من')} ${mono(clientIp, locale)}` : ''}. ${text(locale, 'Recorded in the audit log.', 'سُجّلت في سجل التدقيق.')}</p>
          </div>
          <div role="status" style="display: flex; gap: 10px; padding: 12px 14px; border-radius: 10px; border: 1px solid #A6D9C0; background: #F1FAF5; font-size: 13px; line-height: 1.6">${okIcon}<span>${text(locale, 'Two-factor check passed.', 'نجح التحقق الثنائي.')}</span></div>
          <div style="display: flex; flex-direction: column; gap: 8px">
            <a href="${copy.home}" style="display: flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 18px; border-radius: 8px; border: 1px solid #1D5BD6; background: #1D5BD6; color: #FFFFFF; font-size: 14px; font-weight: 600; text-decoration: none">${copy.homeLabel}</a>
            <button type="button" data-action="logout" style="align-self: center; min-height: 44px; padding: 0 12px; border-radius: 8px; border: none; background: transparent; color: #1D5BD6; font-family: inherit; font-size: 14px; font-weight: 500; cursor: pointer">${text(locale, 'Sign in as someone else', 'الدخول بحساب آخر')}</button>
          </div>
        </div>
        <section data-auth-password-change hidden aria-labelledby="password-change-heading" style="display: flex; flex-direction: column; gap: 16px">
          <h2 id="password-change-heading" style="margin: 0; font-size: 22px; font-weight: 600; line-height: 1.3">${text(locale, 'Change your password', 'تغيير كلمة المرور')}</h2>
          <p style="margin: 0; font-size: 14px; color: #475467; line-height: 1.6">${text(locale, 'Your account requires a new password. You will sign in again after changing it.', 'يتطلب الحساب كلمة مرور جديدة. ستسجل الدخول مجددًا بعد تغييرها.')}</p>
          <form data-auth-password-form style="display: flex; flex-direction: column; gap: 16px; margin: 0">
            <div style="display: flex; flex-direction: column; gap: 6px"><label for="change-current-password" style="font-size: 13px; font-weight: 600">${text(locale, 'Current password', 'كلمة المرور الحالية')}</label><input id="change-current-password" name="currentPassword" type="password" autocomplete="current-password" required style="min-height: 44px; padding: 0 12px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; font-family: ${MONO}; font-size: 14px; color: #101828"></div>
            <div style="display: flex; flex-direction: column; gap: 6px"><label for="change-new-password" style="font-size: 13px; font-weight: 600">${text(locale, 'New password', 'كلمة المرور الجديدة')}</label><input id="change-new-password" name="newPassword" type="password" autocomplete="new-password" required style="min-height: 44px; padding: 0 12px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; font-family: ${MONO}; font-size: 14px; color: #101828"></div>
            <div style="display: flex; flex-direction: column; gap: 6px"><label for="change-confirm-password" style="font-size: 13px; font-weight: 600">${text(locale, 'Confirm new password', 'تأكيد كلمة المرور الجديدة')}</label><input id="change-confirm-password" name="confirmPassword" type="password" autocomplete="new-password" required style="min-height: 44px; padding: 0 12px; border-radius: 8px; border: 1px solid #D0D5DD; background: #FFFFFF; font-family: ${MONO}; font-size: 14px; color: #101828"></div>
            <button type="submit" style="width: 100%; min-height: 44px; padding: 0 18px; border-radius: 8px; border: 1px solid #1D5BD6; background: #1D5BD6; color: #FFFFFF; font-family: inherit; font-size: 14px; font-weight: 600; cursor: pointer">${text(locale, 'Change password', 'تغيير كلمة المرور')}</button>
          </form>
        </section>
        <button type="button" data-action="logout" data-auth-cancel hidden style="align-self: center; min-height: 44px; padding: 0 12px; border: none; background: transparent; color: #1D5BD6; font-family: inherit; font-size: 14px; font-weight: 600; cursor: pointer">${text(locale, 'Cancel and sign out', 'إلغاء وتسجيل الخروج')}</button>
      </section>
    </div>
    <div data-login-lockout ${showLockout ? '' : 'hidden'} style="flex: 0 1 440px; min-width: 0; display: flex; flex-direction: column; gap: 10px">
      <p style="margin: 0; padding-inline-start: 4px; font-size: 12px; font-weight: 600; color: #5D6B7E">${text(locale, 'After 5 failed attempts from one address', 'بعد 5 محاولات فاشلة من عنوان واحد')}</p>
      <section aria-labelledby="locked-title" style="display: flex; flex-direction: column; gap: 26px; padding: 32px 28px; border-radius: 12px; background: #FFFFFF; border: 1px solid #E2E6EC">
        <div style="display: flex; flex-direction: column; gap: 6px">
          <h2 id="locked-title" style="margin: 0; font-size: 22px; font-weight: 600; line-height: 1.3">${text(locale, 'Sign-in paused', 'توقف تسجيل الدخول')}</h2>
          <p style="margin: 0; font-size: 14px; color: #475467; line-height: 1.6">${text(locale, 'This address cannot sign in to xPanel, xWHM or xMail until the pause ends.', 'لا يمكن لهذا العنوان الدخول إلى <bdi dir="ltr">xPanel</bdi> أو <bdi dir="ltr">xWHM</bdi> أو <bdi dir="ltr">xMail</bdi> حتى تنتهي المهلة.')}</p>
        </div>
        <div data-lockout-alert role="alert" style="display: flex; gap: 10px; padding: 12px 14px; border-radius: 10px; border: 1px solid #F9C9A0; background: #FFF6EE; font-size: 13px; line-height: 1.6">${clockIcon}<span data-lockout-sentence>${pauseSentence}</span></div>
        <dl style="margin: 0; display: grid; grid-template-columns: minmax(0, auto) minmax(0, 1fr); gap: 8px 20px; font-size: 13px; line-height: 1.4">
          <dt style="color: #5D6B7E">${text(locale, 'Address', 'العنوان')}</dt>
          <dd style="margin: 0; font-family: ${MONO}">${lockIp ? escapeHtml(lockIp) : dash}</dd>
          <dt style="color: #5D6B7E">${text(locale, 'Username tried', 'اسم المستخدم')}</dt>
          <dd data-lockout-user style="margin: 0; font-family: ${MONO}">${lockUser ? escapeHtml(lockUser) : dash}</dd>
          <dt style="color: #5D6B7E">${text(locale, 'Failed attempts', 'المحاولات الفاشلة')}</dt>
          <dd style="margin: 0; font-variant-numeric: tabular-nums">${locale === 'ar' && failures !== null && windowMinutes !== null ? `${failures} خلال ${windowMinutes} دقيقة` : escapeHtml(attemptText)}</dd>
          <dt style="color: #5D6B7E">${text(locale, 'Last attempt', 'آخر محاولة')}</dt>
          <dd style="margin: 0; font-variant-numeric: tabular-nums">${last ? `<time datetime="${last.attr}">${escapeHtml(last.text)}</time>` : dash}</dd>
          <dt style="color: #5D6B7E">${text(locale, 'Paused until', 'متوقف حتى')}</dt>
          <dd style="margin: 0; font-variant-numeric: tabular-nums">${paused ? `<time data-lockout-until datetime="${paused.attr}">${escapeHtml(paused.text)}</time>` : `<time data-lockout-until>${dash}</time>`}</dd>
        </dl>
        <div style="display: flex; flex-direction: column; gap: 6px">
          <label for="locked-user" style="font-size: 13px; font-weight: 600">${text(locale, 'Username', 'اسم المستخدم')}</label>
          <input id="locked-user" type="text" value="${escapeHtml(lockUser)}" disabled aria-describedby="locked-user-help" style="min-height: 44px; padding: 0 12px; border-radius: 8px; border: 1px solid #E2E6EC; background: #F0F2F5; font-family: ${MONO}; font-size: 14px; color: #5D6B7E">
          <span id="locked-user-help" style="font-size: 12px; font-weight: 500; color: #5D6B7E; line-height: 1.6">${text(locale, 'Kept for when the pause ends.', 'يُحفظ إلى أن تنتهي المهلة.')}</span>
        </div>
        <div style="display: flex; flex-direction: column; gap: 12px">
          <button type="button" data-lockout-again disabled style="width: 100%; min-height: 44px; padding: 0 18px; border-radius: 8px; border: 1px solid #E2E6EC; background: #F0F2F5; color: #5D6B7E; font-family: inherit; font-size: 14px; font-weight: 600">${again}</button>
          <p style="margin: 0; font-size: 12px; color: #5D6B7E; line-height: 1.6">${text(locale, 'Not you? Nothing is needed: the pause ends on its own. An administrator can lift it, or add a trusted address to the allow list, in xWHM under Panel security.', 'لست أنت؟ لا يلزم شيء، فالمهلة تنتهي وحدها. يستطيع المدير رفعها، أو إضافة عنوان موثوق، من أمان اللوحة.')}</p>
        </div>
      </section>
    </div>
  </main>
  <footer role="contentinfo" style="display: flex; flex-wrap: wrap; justify-content: center; gap: 8px 24px; padding: 16px clamp(16px, 4vw, 32px) 26px; font-size: 12px; color: #5D6B7E">
    <span>${text(locale, 'Your address', 'عنوانك')} ${clientIp ? mono(clientIp, locale) : dash}</span>
    <span style="font-family: ${MONO}">${hostname || serverIp ? `${escapeHtml(hostname || dash)} · ${escapeHtml(serverIp || dash)}` : dash}</span>
    <span style="font-family: ${MONO}">xPanel v${version ? escapeHtml(version) : dash}</span>
  </footer>
</div>`.trim()
}

export const loginDocumentTitle = (audience: Audience | undefined, locale: Locale): string => {
  const brand = audience === 'xwhm' ? 'xWHM' : audience === 'xmail' ? 'xMail' : panelLabel('xpanel')
  return locale === 'ar' ? `تسجيل الدخول — ${brand}` : `Sign in — ${brand}`
}
