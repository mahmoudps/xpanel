import { translator, type Locale } from './i18n.ts'
import { escapeHtml } from './tokens.ts'

export type HandoffButtonInput =
  | { audience: 'xpanel'; accountId: string; label: string }
  | { audience: 'xmail'; label: string; mailbox: string; landing?: 'home' | 'calendar' | 'contacts' }
  | { audience: 'xmail'; label: string; mailboxSelect: string; landing?: 'home' | 'calendar' | 'contacts'; disabled?: boolean }

/**
 * One handoff control. Markup carries only data hooks naming the target; handoff-client.ts asks this listener
 * for a one-time link and posts it to the configured panel. No origin, token or session is rendered here.
 * `label` is a message id; the caller marks it with msgid().
 */
export function renderHandoffButton(locale: Locale, input: HandoffButtonInput): string {
  const target = input.audience === 'xpanel' ? `data-handoff-account="${escapeHtml(input.accountId)}"`
    : 'mailbox' in input ? `data-handoff-mailbox="${escapeHtml(input.mailbox)}"` : `data-handoff-mailbox-select="${escapeHtml(input.mailboxSelect)}"`
  const landing = input.audience === 'xmail' && input.landing && input.landing !== 'home' ? ` data-handoff-landing="${input.landing}"` : ''
  const disabled = 'disabled' in input && input.disabled ? ' disabled' : ''
  return `<span class="xp-handoff" data-handoff-control><button type="button" class="xp-btn" data-handoff="${input.audience}" ${target}${landing} data-handoff-state="idle"${disabled}>${escapeHtml(translator(locale)(input.label))}</button><span class="xp-help" data-handoff-status role="status" aria-live="polite" hidden></span></span>`
}

/** Shown on every page of a handed-off session; "End session" uses the shared sign-out action. */
export function renderImpersonationBanner(locale: Locale, input: { target: string; issuer: string }): string {
  const t = translator(locale)
  // Private-use markers keep both identities isolated LTR values inside one translated sentence.
  const sentence = escapeHtml(t('Signed in as {target} by {issuer}', { target: '', issuer: '' }))
    .replace('', `<bdi dir="ltr">${escapeHtml(input.target)}</bdi>`)
    .replace('', `<bdi dir="ltr">${escapeHtml(input.issuer)}</bdi>`)
  return `<div class="xp-impersonation" role="region" aria-label="${escapeHtml(t('Handed-off session'))}" data-impersonation><p class="xp-impersonation__text">${sentence}</p><button type="button" class="xp-btn" data-action="logout" data-impersonation-end>${escapeHtml(t('End session'))}</button></div>`
}

/** Page-scoped styles, emitted once only on a page that renders a handoff control or the banner. */
export const HANDOFF_CONTROLS_CSS = `.xp-handoff{display:inline-flex;flex-direction:column;align-items:flex-start;gap:var(--xp-space-label);min-inline-size:0}.xp-handoff [data-handoff-status]{margin:0;overflow-wrap:anywhere}.xp-handoff [data-handoff-status][data-state=refused],.xp-handoff [data-handoff-status][data-state=expired],.xp-handoff [data-handoff-status][data-state=failed]{color:var(--xp-status-critical-fg)}.xp-impersonation{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--xp-space-field);padding:var(--xp-space-field) var(--xp-space-card);border-block-end:1px solid var(--xp-status-warn-border);background:var(--xp-status-warn-bg);color:var(--xp-status-warn-fg)}.xp-impersonation__text{margin:0;min-inline-size:0;overflow-wrap:anywhere}.xp-impersonation .xp-btn{min-block-size:44px}@media(max-width:600px){.xp-impersonation{padding:var(--xp-space-field)}}`
