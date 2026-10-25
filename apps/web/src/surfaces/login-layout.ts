import { panelLabel, safePanelLinks, type PanelId, type PanelLink } from '../chrome.ts'
import { escapeHtml } from '../tokens.ts'

export interface LoginLayoutContext {
  audience?: PanelId
  targetSurface: PanelId
  locale: 'en' | 'ar'
  theme: 'light' | 'dark'
  panels?: readonly PanelLink[]
  username?: string
  lockedUntil?: string
  mfaDisabled?: boolean
}

/** The profile selector navigates to configured listeners; it never selects an authentication role. */
export function renderLoginProfileTabs(context: LoginLayoutContext): string {
  const available = safePanelLinks(context.panels)
  const active = context.audience ?? 'xpanel'
  const isAr = context.locale === 'ar'
  const items = (['xpanel', 'xwhm', 'xmail'] as const).map(surface => {
    const current = surface === active
    const label = panelLabel(surface)
    const mark = `<span class="xp-login-profile-mark" aria-hidden="true">x</span><span dir="ltr">${label}</span>`
    if (current) return `<span class="xp-login-profile-tab" data-login-profile="${surface}" aria-current="page">${mark}</span>`
    const destination = available.find(panel => panel.surface === surface)
    return destination
      ? `<a class="xp-login-profile-tab" data-login-profile="${surface}" data-panel-link="${surface}" href="${escapeHtml(destination.origin)}/login?lang=${context.locale}&amp;theme=${context.theme}">${mark}</a>`
      : `<span class="xp-login-profile-tab" data-login-profile="${surface}" aria-disabled="true" title="${escapeHtml(isAr ? 'عنوان هذه اللوحة غير متاح على هذا الخادم.' : 'This panel address is not configured on this server.')}">${mark}</span>`
  })
  return `<nav class="xp-login-profile-tabs" aria-label="${escapeHtml(isAr ? 'صفحات الدخول على هذا الخادم' : 'Sign-in pages on this server')}">${items.join('')}</nav>`
}

export function renderLoginContext(context: LoginLayoutContext): string {
  const isAr = context.locale === 'ar'
  const text = (en: string, ar: string): string => escapeHtml(isAr ? ar : en)
  const audience = context.audience ?? 'xpanel'
  const description = audience === 'xwhm'
    ? text('Use a server administrator or reseller account for this page. Hosting accounts and mailboxes have their own sign-in pages.', 'استخدم حساب مدير الخادم أو الموزّع لهذه الصفحة. لحسابات الاستضافة وصناديق البريد صفحات دخول منفصلة.')
    : audience === 'xmail'
      ? text('Use your mailbox address and mailbox password. Your hosting account password may be different.', 'استخدم عنوان صندوق البريد وكلمة مروره. قد تختلف كلمة مرور حساب الاستضافة عنها.')
      : text('Use the hosting account username and password supplied by your provider. Server administration and mailboxes have their own sign-in pages.', 'استخدم اسم حساب الاستضافة وكلمة المرور اللذين يزوّدك بهما مزوّد الاستضافة. لإدارة الخادم وصناديق البريد صفحات دخول منفصلة.')
  return `<aside class="xp-login-aside" aria-label="${text('Sign-in information and status', 'معلومات الدخول وحالته')}">
  <section class="xp-login-context-card" aria-labelledby="login-context-heading">
    <span class="xp-login-context-brand" dir="ltr">${panelLabel(audience)}</span>
    <h2 id="login-context-heading">${text('Use the right account', 'استخدم الحساب المناسب')}</h2>
    <p>${description}</p>
    <p class="xp-help">${context.mfaDisabled ? text('Two-factor verification is disabled in this development environment.', 'التحقق الثنائي معطّل في بيئة التطوير هذه.') : text('A verification code is requested only when the account requires it. Enabling two-factor authentication is optional.', 'يُطلب رمز التحقق فقط عندما يتطلبه الحساب. تفعيل التحقق الثنائي اختياري.')}</p>
  </section>
  <section class="xp-login-context-card xp-login-lockout-details" aria-labelledby="login-paused-heading" data-login-lockout-details>
    <h2 id="login-paused-heading">${text('Sign-in paused', 'تسجيل الدخول متوقف مؤقتًا')}</h2>
    <p>${text('This sign-in attempt is temporarily locked. Wait for the pause to end before trying again.', 'محاولة تسجيل الدخول هذه مقفلة مؤقتًا. انتظر انتهاء التوقف قبل المحاولة مجددًا.')}</p>
    <div class="xp-alert xp-alert--warning" role="note">${text('The server decides when another attempt is allowed. The current retry time is shown with the sign-in message.', 'يحدد الخادم موعد السماح بمحاولة أخرى. يظهر موعد إعادة المحاولة الحالي مع رسالة الدخول.')}</div>
    ${context.lockedUntil ? `<p class="xp-help" data-observed-lockout-until>${text('Recorded retry time', 'موعد إعادة المحاولة المسجّل')}: <bdi dir="ltr">${escapeHtml(context.lockedUntil)}</bdi></p>` : ''}
    <div class="xp-field"><label class="xp-label" for="locked-username">${audience === 'xmail' ? text('Mailbox address', 'عنوان صندوق البريد') : text('Username', 'اسم المستخدم')}</label><input id="locked-username" class="xp-input" dir="ltr" value="${escapeHtml(context.username ?? '')}" disabled /></div>
    <div class="xp-field"><label class="xp-label" for="locked-password">${text('Password', 'كلمة المرور')}</label><input id="locked-password" class="xp-input" type="password" dir="ltr" disabled autocomplete="off" /></div>
    <button class="xp-btn" type="button" disabled>${text('Sign-in paused', 'تسجيل الدخول متوقف مؤقتًا')}</button>
    <p class="xp-help">${text('If this was not you, the pause will still expire automatically. Contact your provider if you need help.', 'إن لم تكن هذه محاولتك، فسينتهي التوقف تلقائيًا أيضًا. تواصل مع مزوّدك إن احتجت مساعدة.')}</p>
  </section>
</aside>`
}

export function renderLoginFooter(context: LoginLayoutContext): string {
  const active = safePanelLinks(context.panels).find(panel => panel.surface === (context.audience ?? 'xpanel'))
  const hostname = active ? new URL(active.origin).host : undefined
  return `<footer class="xp-login-footer" role="contentinfo"><span dir="ltr">xPanel · xWHM · xMail</span>${hostname ? `<span class="xp-mono"><bdi dir="ltr">${escapeHtml(hostname)}</bdi></span>` : ''}<span>${escapeHtml(context.locale === 'ar' ? 'العربية والإنجليزية · دخول آمن' : 'English & Arabic · Secure sign in')}</span></footer>`
}

/** Scoped presentation of the approved sign-in composition; authentication behavior stays in the real client. */
export const LOGIN_LAYOUT_CSS = `
.xp-login-shell[data-login-design="approved"] { display:flex; flex-direction:column; align-items:stretch; justify-content:flex-start; inline-size:100%; max-inline-size:none; min-block-size:100dvh; padding:0; gap:0; }
.xp-login-shell[data-login-design="approved"] .xp-login-topbar { max-inline-size:1080px; padding:var(--xp-space-field) var(--xp-space-card); margin-inline:auto; }
.xp-login-shell[data-login-design="approved"] .xp-login-main { display:flex; inline-size:100%; max-inline-size:1000px; margin-inline:auto; padding:var(--xp-space-section) var(--xp-space-card); gap:var(--xp-space-section); justify-content:center; align-items:flex-start; flex-wrap:wrap; }
.xp-login-shell[data-login-design="approved"] .xp-login-entry { flex:1 1 400px; max-inline-size:440px; min-inline-size:0; display:flex; flex-direction:column; gap:var(--xp-space-label); }
.xp-login-shell[data-login-design="approved"] .xp-login-card { flex:initial; min-inline-size:0; inline-size:100%; padding:var(--xp-space-card); gap:var(--xp-space-group); border:1px solid var(--xp-border); border-radius:12px; box-shadow:none; }
.xp-login-shell[data-login-design="approved"] .xp-login-aside { display:flex; flex:1 1 400px; max-inline-size:440px; min-inline-size:0; flex-direction:column; gap:var(--xp-space-group); }
.xp-login-shell[data-login-design="approved"] .xp-login-context-card { display:flex; flex-direction:column; gap:var(--xp-space-field); padding:var(--xp-space-card); border:1px solid var(--xp-border); border-radius:12px; background:var(--xp-bg-surface); }
.xp-login-shell[data-login-design="approved"] .xp-login-context-card h2 { margin:0; font-size:var(--xp-type-card); line-height:var(--xp-leading-card); }
.xp-login-shell[data-login-design="approved"] .xp-login-context-card p { margin:0; }
.xp-login-shell[data-login-design="approved"] .xp-login-context-brand { font-family:var(--xp-font-mono); font-weight:600; color:var(--xp-accent); }
.xp-login-shell[data-login-design="approved"] .xp-login-profile-tabs { display:flex; gap:4px; padding:4px; border-radius:10px; background:var(--xp-bg-subtle); }
.xp-login-shell[data-login-design="approved"] .xp-login-profile-tab { display:inline-flex; flex:1 1 0; min-inline-size:0; min-block-size:44px; align-items:center; justify-content:center; gap:var(--xp-space-label); padding:var(--xp-space-label); border:1px solid transparent; border-radius:8px; color:var(--xp-text-secondary); font-family:var(--xp-font-mono); font-size:var(--xp-type-label); text-decoration:none; }
.xp-login-shell[data-login-design="approved"] .xp-login-profile-tab[aria-current="page"] { background:var(--xp-bg-surface); border-color:var(--xp-border); color:var(--xp-text-primary); font-weight:600; box-shadow:var(--xp-shadow-sm); }
.xp-login-shell[data-login-design="approved"] .xp-login-profile-tab[aria-disabled="true"] { color:var(--xp-text-muted); opacity:.75; }
.xp-login-shell[data-login-design="approved"] .xp-login-profile-mark { display:inline-flex; flex:none; align-items:center; justify-content:center; inline-size:18px; block-size:18px; border-radius:5px; background:var(--xp-accent); color:#fff; font-size:11px; font-weight:600; }
.xp-login-shell[data-login-design="approved"] .xp-login-profile-tab[data-login-profile="xwhm"] .xp-login-profile-mark { background:var(--xp-text-primary); color:var(--xp-bg-surface); }
.xp-login-shell[data-login-design="approved"] .xp-login-profile-tab[data-login-profile="xmail"] .xp-login-profile-mark { background:var(--xp-status-ok-fg); }
.xp-login-shell[data-login-design="approved"] .xp-login-heading-block { display:flex; flex-direction:column; gap:var(--xp-space-label); }
.xp-login-shell[data-login-design="approved"] .xp-login-heading-block .xp-login-identity__product { margin:0; }
.xp-login-shell[data-login-design="approved"] .xp-login-step { margin:0; padding-inline:4px; color:var(--xp-text-muted); }
.xp-login-shell[data-login-design="approved"] .xp-form { gap:var(--xp-space-field); }
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
