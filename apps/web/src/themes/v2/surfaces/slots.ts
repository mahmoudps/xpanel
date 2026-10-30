import { auditActionLabel, auditActorLabel, auditOutcomeLabel, auditTargetLabel } from '../../../audit-labels.ts'
import { renderBrandingFooter } from '../../../branding.ts'
import { formatAsciiNumber, formatDisplayDateTime } from '../../../display-format.ts'
import type { Translate } from '../../../i18n.ts'
import type { ActivityDrawerProps, CommandPaletteProps, DocumentBodyProps, ReconcileBannerProps, UiTheme } from '../../contract.ts'
import { statusPill } from '../components/status-pill.ts'
import { escapeHtml } from '../html.ts'
import { v2Messages } from '../messages.ts'
import { activityDrawer, commandPalette, reconcileBanner } from '../shell/overlays.ts'

export const V2_SECURITY_SLOT = '<div data-v2-account-security-slot></div>'
type SecurityProps = Parameters<UiTheme['slots']['accountSecurity']>[0]['security']

function rootRecoveryHint(t: Translate): string {
  const [before, after] = t('An administrator with root SSH access can turn it off with {command}. Password sign-in works again afterwards.').split('{command}')
  return `${escapeHtml(before ?? '')}<bdi class="v2-mono" dir="ltr">xpanel disable-2fa root --confirm</bdi>${escapeHtml(after ?? '')}`
}

export function renderV2AccountSecurityCard(props: SecurityProps): string {
  const t = v2Messages.translator(props.locale)
  const root = props.principalKind === 'root' && props.surface === 'xwhm'
  const heading = `<h2 id="account-security-heading">${escapeHtml(t('Two-factor authentication'))}</h2>`
  if (props.mfaMode === 'disabled') return `<section class="v2-card v2-security" data-account-security="two-factor" data-auth-state="development-disabled" data-mfa-disabled data-mfa-configured="${props.totpEnabled}" aria-labelledby="account-security-heading">${heading}<p role="status">${escapeHtml(t('Two-factor verification is disabled in development. Saved factors and recovery codes stay unchanged. Factor management is unavailable in this mode.'))}</p></section>`
  if (props.readOnly) return `<section class="v2-card v2-security" data-account-security="two-factor" data-auth-state="read-only" data-auth-readonly="true" data-mfa-configured="${props.totpEnabled}" aria-labelledby="account-security-heading">${heading}<p role="status">${escapeHtml(t(msgctxt('account-security', 'Two-factor settings cannot be changed from a handed-off session.')))}</p><p>${escapeHtml(props.totpEnabled ? t('Sign-in asks for an authenticator code because two-factor authentication is enabled.') : t(msgctxt('account-security', 'Password sign-in is active.')))}</p></section>`
  if (props.totpEnabled) return `<section class="v2-card v2-security" data-account-security="two-factor" data-mfa-enabled="true" aria-labelledby="account-security-heading">${heading}<p role="status">${escapeHtml(t('Sign-in asks for an authenticator code because two-factor authentication is enabled.'))}</p>${root ? `<p>${rootRecoveryHint(t)}</p>` : ''}</section>`
  return `<section class="v2-card v2-security" data-account-security="two-factor" data-auth-state="optional" aria-labelledby="account-security-heading">${heading}<div role="alert" data-auth-error hidden></div><p role="status" aria-live="polite" data-auth-status></p><div class="v2-security__stack" data-auth-enrollment><p role="status"${root ? ' data-mfa-recommendation' : ''}>${escapeHtml(root ? t('Two-factor authentication is off for root. Enabling an authenticator is recommended and does not block this workspace.') : t('Password sign-in is active. You can add an authenticator whenever you choose.'))}</p><form class="v2-security__form" data-auth-setup-form><div class="v2-security__field"><label for="enrollment-password">${escapeHtml(t('Confirm current password'))}</label><input id="enrollment-password" name="password" type="password" dir="ltr" autocomplete="current-password" required></div><button type="submit" class="v2-btn v2-btn--primary" data-action="setup-2fa">${escapeHtml(t('Start enrollment'))}</button></form><div class="v2-security__stack" data-auth-enrollment-details hidden><div class="v2-security__field" data-auth-totp-qr-field hidden><span>${escapeHtml(t('Scan this QR code with your authenticator app'))}</span><div data-auth-totp-qr dir="ltr"></div></div><div class="v2-security__field"><span>${escapeHtml(t('Authenticator setup key'))}</span><div><bdi class="v2-mono" dir="ltr" data-auth-totp-secret></bdi></div></div><p>${escapeHtml(t('Scan the QR code or enter this key in your authenticator app, then submit its code.'))}</p><form class="v2-security__form" data-auth-enroll-form><div class="v2-security__field"><label for="enrollment-code">${escapeHtml(t('Authenticator code'))}</label><input id="enrollment-code" name="code" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" dir="ltr" autocomplete="one-time-code" required></div><button type="submit" class="v2-btn v2-btn--primary">${escapeHtml(t('Verify and enable'))}</button></form><button type="button" class="v2-btn" data-action="restart-enrollment">${escapeHtml(t('Restart enrollment'))}</button></div></div><section class="v2-security__stack" data-auth-recovery hidden aria-labelledby="recovery-heading"><h2 id="recovery-heading">${escapeHtml(t('Save your recovery codes'))}</h2><p>${escapeHtml(t('Store these codes safely. Each code can be used once. They disappear when you continue.'))}</p><ul data-auth-recovery-codes></ul><button type="button" class="v2-btn v2-btn--primary" data-action="acknowledge-recovery">${escapeHtml(t('I saved the codes — continue'))}</button></section></section>`
}

/** The selected V2 page supplies one explicit host; absence cannot silently drop security controls. */
export const renderV2AccountSecuritySlot: UiTheme['slots']['accountSecurity'] = ({ bodyHtml, security }) => {
  if (bodyHtml.split(V2_SECURITY_SLOT).length !== 2) throw new Error('v2_account_security_slot_missing_or_duplicated')
  return bodyHtml.replace(V2_SECURITY_SLOT, renderV2AccountSecurityCard(security))
}

export function renderV2CommandPalette(props: CommandPaletteProps): string {
  return props.surface === 'login' ? '' : commandPalette(v2Messages.translator(props.locale), { surface: props.surface, entries: props.entries })
}

export function renderV2ActivityDrawer(props: ActivityDrawerProps): string {
  const t = v2Messages.translator(props.locale)
  const status = { queued: msgid('Queued'), running: msgid('Running'), succeeded: msgid('Succeeded'), failed: msgid('Failed'), cancelled: msgid('Cancelled') }
  const jobs = props.live.recentJobs.map(job => `<li class="v2-activity-row" data-job-state="${job.status}"><div><strong>${escapeHtml(t(msgctxt('theme:v2', 'Host job')))}</strong>${statusPill({ tone: job.status === 'failed' ? 'bad' : job.status === 'succeeded' ? 'ok' : 'info', label: t(status[job.status]) })}</div><dl><div><dt>${escapeHtml(t('Job Ref'))}</dt><dd>${escapeHtml(t('Unnumbered'))}</dd></div><div><dt>${escapeHtml(t('Kind'))}</dt><dd><bdi class="v2-mono" dir="ltr">${escapeHtml(job.kind)}</bdi></dd></div><div><dt>${escapeHtml(t('Progress'))}</dt><dd><bdi class="v2-num" dir="ltr">${Number.isFinite(job.progress) && job.progress >= 0 && job.progress <= 100 ? formatAsciiNumber(job.progress) + '%' : '—'}</bdi></dd></div><div><dt>${escapeHtml(t('Updated'))}</dt><dd><bdi dir="ltr"><time datetime="${escapeHtml(job.updatedAt)}">${escapeHtml(formatDisplayDateTime(job.updatedAt))}</time></bdi></dd></div></dl>${job.error ? `<p role="status">${escapeHtml(job.error)}</p>` : ''}</li>`).join('')
  const audit = props.live.recentAuditEntries.map(entry => `<li class="v2-activity-row"><div><strong>${escapeHtml(auditActionLabel(entry.action, props.locale))}</strong>${statusPill({ tone: entry.outcome === 'ok' ? 'ok' : entry.outcome === 'denied' ? 'warn' : 'bad', label: auditOutcomeLabel(entry.action, entry.outcome, props.locale) })}</div><dl><div><dt>${escapeHtml(t('Actor'))}</dt><dd><bdi dir="ltr">${escapeHtml(auditActorLabel(entry.actor) || '—')}</bdi></dd></div><div><dt>${escapeHtml(t('Target'))}</dt><dd><bdi dir="ltr">${escapeHtml(auditTargetLabel(entry.target, props.locale) || '—')}</bdi></dd></div><div><dt>${escapeHtml(t('Date'))}</dt><dd><bdi dir="ltr"><time datetime="${escapeHtml(entry.at)}">${escapeHtml(formatDisplayDateTime(entry.at))}</time></bdi></dd></div></dl></li>`).join('')
  const bodyHtml = `<section class="v2-security__stack" aria-labelledby="v2-activity-jobs"><h3 id="v2-activity-jobs">${escapeHtml(t(msgctxt('theme:v2', 'Recent jobs')))}</h3>${jobs ? `<ul class="v2-activity-list">${jobs}</ul>` : `<p class="v2-muted">${escapeHtml(t(msgctxt('theme:v2', 'No recent jobs were supplied.')))}</p>`}</section><section class="v2-security__stack" aria-labelledby="v2-activity-audit"><h3 id="v2-activity-audit">${escapeHtml(t(msgctxt('theme:v2', 'Recent activity')))}</h3>${audit ? `<ul class="v2-activity-list">${audit}</ul>` : `<p class="v2-muted">${escapeHtml(t(msgctxt('theme:v2', 'No recent audit observations were supplied.')))}</p>`}</section>`
  const reconcile = props.live.reconcile
  return activityDrawer(t, { bodyHtml, ...(reconcile.generationId > 0 && reconcile.updatedAt !== null ? { generation: { id: reconcile.generationId, applied: reconcile.status === 'applied' } } : {}) })
}

export function renderV2ReconcileBanner(props: ReconcileBannerProps): string {
  const t = v2Messages.translator(props.locale)
  const live = props.live, value = live.reconcile
  const stages = [
    ['render', msgid('1. Render config')], ['test', msgid('2. Config test')], ['switch', msgid('3. Atomic switch')],
    ['reload', msgid('4. Service reload')], ['verify', msgid('5. Health verify')],
  ] as const
  const banner = reconcileBanner(t, { generationId: value.generationId, status: value.status, observed: value.updatedAt !== null,
    stages: stages.map(([stage, label]) => ({ stage, label: t(label), status: value.stages[stage] })),
    ...(value.failedTest ? { failedTest: value.failedTest } : {}), ...(value.error ? { error: value.error } : {}) })
  const ws = live.connectionState === 'connected' ? t('Live stream connected') : live.connectionState === 'reconnecting' ? t('Reconnecting live stream...') : t('Live stream offline')
  const metadata = value.stateChecksum && value.durationMs !== null
    ? `<p class="v2-reconcile-facts v2-mono v2-num" data-v2-reconcile-meta><bdi dir="ltr">${escapeHtml(t('{filesCount} files · {durationMs} ms · sha256 {checksum}', { filesCount: value.filesCount, durationMs: value.durationMs, checksum: value.stateChecksum }))}</bdi></p>` : ''
  return `<div class="v2-global-reconcile"><div class="v2-reconcile-connection" data-ws-state="${live.connectionState}" data-v2-reconcile-connection>${escapeHtml(ws)}</div>${banner}${metadata}</div>`
}

export function renderV2DocumentBody(props: DocumentBodyProps): string {
  const t = v2Messages.translator(props.locale)
  const impersonation = props.impersonation ? (() => {
    const sentence = escapeHtml(t('Signed in as {target} by {issuer}', { target: '\uE000', issuer: '\uE001' }))
      .replace('\uE000', `<bdi dir="ltr">${escapeHtml(props.impersonation!.target)}</bdi>`)
      .replace('\uE001', `<bdi dir="ltr">${escapeHtml(props.impersonation!.issuer)}</bdi>`)
    return `<div class="v2-impersonation" role="region" aria-label="${escapeHtml(t('Handed-off session'))}" data-impersonation><p>${sentence}</p><button type="button" class="v2-btn" data-action="logout" data-impersonation-end>${escapeHtml(t('End session'))}</button></div>`
  })() : ''
  return `${impersonation}${props.reconcileHtml}${props.surfaceHtml}${renderBrandingFooter(props.branding, props.locale)}${props.paletteHtml}${props.activityHtml}${props.clientScriptsHtml}`
}

export const v2SharedSlots: UiTheme['slots'] = Object.freeze({
  documentBody: renderV2DocumentBody, accountSecurity: renderV2AccountSecuritySlot,
  activityDrawer: renderV2ActivityDrawer, commandPalette: renderV2CommandPalette, reconcileBanner: renderV2ReconcileBanner,
})

export const V2_SLOTS_CSS = `.v2-security,.v2-security__stack,.v2-security__form{display:flex;flex-direction:column;gap:var(--space-3);min-inline-size:0}.v2-security{padding:var(--space-3)}.v2-security__field{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0}.v2-security__field>label{padding-inline-start:12px}.v2-security__field>input{inline-size:100%;text-align:var(--v2-control-align,start)}.v2-security [data-auth-totp-qr]>svg{display:block;max-inline-size:100%;block-size:auto}
.v2-impersonation{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--space-2);padding:var(--space-2) var(--space-3);background:var(--warn-soft);border-block-end:1px solid var(--warn-line);color:var(--text)}.v2-impersonation>p{min-inline-size:0;overflow-wrap:anywhere}
.v2-activity-list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:var(--space-3)}.v2-activity-row{display:flex;flex-direction:column;gap:var(--space-2);padding-block-end:var(--space-3);border-block-end:1px solid var(--line)}.v2-activity-row>div:first-child{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--space-1)}.v2-activity-row dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-2)}.v2-activity-row dl>div{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0}.v2-activity-row dt{font-size:12px;color:var(--muted)}.v2-activity-row dd{overflow-wrap:anywhere}
.v2-global-reconcile{padding:var(--space-2) var(--space-3) 0}.v2-reconcile-connection{font-size:12px;color:var(--muted);padding-block-end:var(--space-1)}.v2-reconcile-facts{padding:var(--space-2);font-size:12px;overflow-wrap:anywhere}
[data-ui-theme="v2"] [data-handoff-control]{display:inline-flex;flex-direction:column;align-items:flex-start;gap:var(--space-1);min-inline-size:0}[data-ui-theme="v2"] [data-handoff-status]{overflow-wrap:anywhere}[data-ui-theme="v2"] [data-brand-footer]{display:flex;flex-wrap:wrap;justify-content:center;gap:var(--space-2) var(--space-3);padding:var(--space-3);font-size:12px;color:var(--muted)}
@media(max-width:600px){.v2-security,.v2-impersonation{padding:var(--space-2)}.v2-global-reconcile{padding-inline:var(--space-2)}.v2-activity-row dl{grid-template-columns:1fr}[data-ui-theme="v2"] [data-brand-footer]{padding:var(--space-2)}}`
