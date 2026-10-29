import { panelLabel, type PanelId } from '../chrome.ts'
import { escapeHtml, formatDisplayDateTime } from '../tokens.ts'
import { translator, type MessageValues, type Locale } from '../i18n.ts'
export interface LoginLayoutContext {
  audience?: PanelId
  targetSurface: PanelId
  locale: Locale
  theme: 'light' | 'dark'
  publicOrigin?: string
  username?: string
  lockedUntil?: string
  mfaDisabled?: boolean
}

/** Host of this listener's own exact HTTPS origin, or nothing when the origin is not an exact HTTPS origin. */
export function publicHost(origin: string | undefined): string | undefined {
  if (!origin) return undefined
  try {
    const url = new URL(origin)
    return url.protocol === 'https:' && url.origin === origin ? url.host : undefined
  } catch { return undefined }
}

export function renderLoginContext(context: LoginLayoutContext): string {
  const text = (message: string, values?: MessageValues): string => escapeHtml(translator(context.locale)(message, values))
  const audience = context.audience ?? 'xpanel'
  const description = audience === 'xwhm'
    ? text('Use a server administrator or reseller account for this page.')
    : audience === 'xmail'
      ? text('Use your full mailbox address and its mailbox password.')
      : text('Use the hosting account username and password supplied by your provider.')
  return `<aside class="xp-login-aside" aria-label="${text('Sign-in information and status')}">
  <section class="xp-login-context-card" aria-labelledby="login-context-heading">
    <div class="xp-login-context-heading">
    <span class="xp-login-context-brand" dir="ltr">${panelLabel(audience)}</span>
    <h2 id="login-context-heading">${text('Use the right account')}</h2>
    <p>${description}</p>
    </div>
    <p class="xp-help">${context.mfaDisabled ? text('Two-factor verification is disabled in this development environment.') : text('A verification code is requested only when the account requires it. Enabling two-factor authentication is optional.')}</p>
  </section>
  <section class="xp-login-context-card xp-login-lockout-details" aria-labelledby="login-paused-heading" data-login-lockout-details>
    <div class="xp-login-context-heading">
    <h2 id="login-paused-heading">${text('Sign-in paused')}</h2>
    <p>${text('This sign-in attempt is temporarily locked. Wait for the pause to end before trying again.')}</p>
    </div>
    <div class="xp-alert xp-alert--warning" role="note">${text('The server decides when another attempt is allowed. The current retry time is shown with the sign-in message.')}</div>
    ${context.lockedUntil ? `<p class="xp-help" data-observed-lockout-until>${text('Recorded retry time')}: <bdi dir="ltr"><time datetime="${escapeHtml(context.lockedUntil)}">${escapeHtml(formatDisplayDateTime(context.lockedUntil))}</time></bdi></p>` : ''}
    <div class="xp-login-credential-fields">
    <div class="xp-field"><label class="xp-label" for="locked-username">${audience === 'xmail' ? text('Mailbox address') : text('Username')}</label><input id="locked-username" class="xp-input" dir="ltr" value="${escapeHtml(context.username ?? '')}" disabled /></div>
    <div class="xp-field"><label class="xp-label" for="locked-password">${text('Password')}</label><input id="locked-password" class="xp-input" type="password" dir="ltr" disabled autocomplete="off" /></div>
    </div>
    <button class="xp-btn" type="button" disabled>${text('Sign-in paused')}</button>
    <p class="xp-help">${text('If this was not you, the pause will still expire automatically. Contact your provider if you need help.')}</p>
  </section>
</aside>`
}

export function renderLoginFooter(context: LoginLayoutContext): string {
  const hostname = publicHost(context.publicOrigin)
  return `<footer class="xp-login-footer" role="contentinfo"><span dir="ltr">${panelLabel(context.audience ?? 'xpanel')}</span>${hostname ? `<span class="xp-mono"><bdi dir="ltr">${escapeHtml(hostname)}</bdi></span>` : ''}<span>${escapeHtml(translator(context.locale)('English & Arabic · Secure sign in'))}</span></footer>`
}

/** Scoped presentation of the approved sign-in composition; authentication behavior stays in the real client. */
export const LOGIN_LAYOUT_CSS = `
.xp-login-shell[data-login-design="approved"] { display:flex; flex-direction:column; align-items:stretch; justify-content:flex-start; inline-size:100%; max-inline-size:none; min-block-size:100dvh; padding:0; gap:0; }
.xp-login-shell[data-login-design="approved"] .xp-login-topbar { max-inline-size:1080px; padding:var(--xp-space-field) var(--xp-space-card); margin-inline:auto; }
.xp-login-shell[data-login-design="approved"] .xp-login-main { display:flex; inline-size:100%; max-inline-size:1000px; margin-inline:auto; padding:var(--xp-space-section) var(--xp-space-card); gap:var(--xp-space-section); justify-content:center; align-items:flex-start; flex-wrap:wrap; }
.xp-login-shell[data-login-design="approved"] .xp-login-entry { flex:1 1 400px; max-inline-size:440px; min-inline-size:0; display:flex; flex-direction:column; gap:var(--xp-space-label); }
.xp-login-shell[data-login-design="approved"] .xp-login-card { flex:initial; min-inline-size:0; inline-size:100%; padding:var(--xp-space-card); gap:var(--xp-space-group); border:1px solid var(--xp-border); border-radius:12px; box-shadow:none; }
.xp-login-shell[data-login-design="approved"] .xp-login-aside { display:flex; flex:1 1 400px; max-inline-size:440px; min-inline-size:0; flex-direction:column; gap:var(--xp-space-group); }
.xp-login-shell[data-login-design="approved"] .xp-login-context-card { display:flex; flex-direction:column; gap:var(--xp-space-group); padding:var(--xp-space-card); border:1px solid var(--xp-border); border-radius:12px; background:var(--xp-bg-surface); }
.xp-login-shell[data-login-design="approved"] .xp-login-context-card h2 { margin:0; font-size:var(--xp-type-card); line-height:var(--xp-leading-card); }
.xp-login-shell[data-login-design="approved"] .xp-login-context-card p { margin:0; }
.xp-login-shell[data-login-design="approved"] :is(.xp-login-context-heading,.xp-login-challenge-heading) { display:flex; flex-direction:column; gap:var(--xp-space-label); min-inline-size:0; }
.xp-login-shell[data-login-design="approved"] .xp-login-credential-fields { display:grid; gap:var(--xp-space-field); min-inline-size:0; }
.xp-login-shell[data-login-design="approved"] .xp-login-challenge-content { display:grid; gap:var(--xp-space-group); min-inline-size:0; }
.xp-login-shell[data-login-design="approved"] .xp-login-context-brand { font-family:var(--xp-font-mono); font-weight:600; color:var(--xp-accent); }
.xp-login-shell[data-login-design="approved"] .xp-login-heading-block { display:flex; flex-direction:column; gap:var(--xp-space-label); }
.xp-login-shell[data-login-design="approved"] .xp-login-heading-block .xp-login-identity__product { margin:0; }
.xp-login-shell[data-login-design="approved"] .xp-login-step { margin:0; padding-inline:4px; color:var(--xp-text-muted); }
.xp-login-shell[data-login-design="approved"] .xp-form { gap:var(--xp-space-field); }
.xp-login-shell[data-login-design="approved"] [data-login-form] { gap:var(--xp-space-group); }
html[dir="rtl"] .xp-login-shell[data-login-design="approved"] :is(.xp-login-context-brand,.xp-login-identity__product,.xp-brand__name,.xp-brand__sub) { text-align:right; }
.xp-login-shell[data-login-design="approved"] .xp-field { gap:var(--xp-space-label); }
.xp-login-shell[data-login-design="approved"] .xp-field > label.xp-label { padding-inline-start:var(--xp-control-content-inset); }
.xp-login-shell[data-login-design="approved"] .xp-btn--primary { color:var(--xp-text-on-accent); background:var(--xp-accent); border-color:var(--xp-accent); }
.xp-login-shell[data-login-design="approved"] .xp-btn--primary:hover { background:var(--xp-accent-hover); border-color:var(--xp-accent-hover); }
.xp-login-shell[data-login-design="approved"] .xp-login-otp { text-align:center; font-family:var(--xp-font-mono); font-size:22px; letter-spacing:.35em; }
.xp-login-shell[data-login-design="approved"] .xp-login-challenge-summary { display:flex; flex-wrap:wrap; gap:var(--xp-space-label); align-items:center; padding:var(--xp-space-field); border-radius:10px; border:1px solid var(--xp-border); background:var(--xp-bg-subtle); }
.xp-login-shell[data-login-design="approved"] .xp-login-challenge-summary > button { margin-inline-start:auto; }
.xp-login-shell[data-login-design="approved"] .xp-login-factor-toggle { align-self:center; text-decoration:underline; text-underline-offset:3px; }
.xp-login-shell[data-login-design="approved"] .xp-login-success { display:none; flex-direction:column; gap:var(--xp-space-field); }
.xp-login-shell[data-login-design="approved"] .xp-login-success h2, .xp-login-shell[data-login-design="approved"] .xp-login-success p { margin:0; }
.xp-login-shell[data-login-design="approved"]:not([data-auth-state="locked"]) .xp-login-lockout-details { display:none; }
.xp-login-shell[data-login-design="approved"][data-auth-state="authenticated"] .xp-login-success { display:flex; }
.xp-login-shell[data-login-design="approved"][data-auth-state="authenticated"] [data-login-form] { display:none; }
.xp-login-shell[data-login-design="approved"] .xp-login-footer { inline-size:100%; max-inline-size:1080px; margin-inline:auto; padding:var(--xp-space-field) var(--xp-space-card); gap:var(--xp-space-label) var(--xp-space-group); justify-content:center; }
@media (max-width:600px) { .xp-login-shell[data-login-design="approved"] .xp-login-topbar, .xp-login-shell[data-login-design="approved"] .xp-login-main, .xp-login-shell[data-login-design="approved"] .xp-login-footer { padding-inline:var(--xp-space-field); } .xp-login-shell[data-login-design="approved"] .xp-login-card, .xp-login-shell[data-login-design="approved"] .xp-login-context-card { padding:var(--xp-space-field); } }
`
