import { type Locale, type MessageValues, translator, localeDirection } from '../../i18n.ts'
import { escapeHtml } from '../../tokens.ts'

/** Account spam-filter settings workspace (presentation only; controller uses the real route). */
export function renderAccountSpamSettings(input: { lang: Locale; expectedAccountId: string; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => translator(input.lang)(message, values)
  const disabled = input.canManage ? '' : ' disabled'
  const score = (id: string, label: string) => `<div class="xp-field"><label for="${id}">${label}</label><input id="${id}" class="xp-input xp-mono" dir="ltr" type="number" min="0" max="100" step="0.5" data-spam-score="${id}"${disabled}></div>`
  return `<div class="xp-extension xp-spam-settings" data-spam-settings data-account="${escapeHtml(input.expectedAccountId)}" data-spam-can-manage="${input.canManage}" lang="${input.lang}" dir="${localeDirection(input.lang)}">
    <style>.xp-spam-settings{display:grid;gap:var(--xp-space-section);min-inline-size:0}.xp-spam-settings__group{display:grid;gap:var(--xp-space-group);min-inline-size:0;padding:var(--xp-space-field);border:1px solid var(--xp-border);border-radius:var(--xp-radius-sm);background:var(--xp-bg-surface)}.xp-spam-settings__group h3{margin:0;font-size:var(--xp-type-card);line-height:var(--xp-leading-card)}.xp-spam-settings__fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:var(--xp-space-field);min-inline-size:0}.xp-spam-settings textarea{inline-size:100%;min-inline-size:0;box-sizing:border-box;min-block-size:96px;resize:vertical}.xp-spam-settings__actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--xp-space-field)}.xp-spam-settings [data-spam-status]:not([hidden]){padding:var(--xp-space-field);border:1px solid var(--xp-border);border-radius:var(--xp-radius-sm);background:var(--xp-bg-elevated);overflow-wrap:anywhere}.xp-spam-settings [data-spam-status][data-state=failed]{color:var(--xp-status-critical-fg);border-color:var(--xp-status-critical-border);background:var(--xp-status-critical-bg)}.xp-spam-settings [data-spam-status][data-state=uncertain]{color:var(--xp-status-warn-fg);border-color:var(--xp-status-warn-border);background:var(--xp-status-warn-bg)}@media(min-width:601px){.xp-spam-settings__group{padding:var(--xp-space-card)}}@media(max-width:600px){.xp-spam-settings__actions>button{flex:1 1 auto}}</style>
    <p class="xp-help">${t('Spam scoring, mailbox routing and the allow/block lists are stored configuration. The mail server effect remains unverified until host reconciliation reports it.')}</p>
    <div class="xp-spam-settings__group">
      <h3>${t('Filtering')}</h3>
      <div class="xp-spam-settings__fields">
        <div class="xp-field"><label for="spam-enabled">${t('Spam filtering enabled')}</label><label class="xp-check" for="spam-enabled"><input id="spam-enabled" type="checkbox" data-spam-enabled${disabled}> ${t('Enable filtering')}</label></div>
        <div class="xp-field"><label for="spam-box-enabled">${t('Keep a spam mailbox')}</label><label class="xp-check" for="spam-box-enabled"><input id="spam-box-enabled" type="checkbox" data-spam-box${disabled}> ${t('Move spam to the spam folder')}</label></div>
        <div class="xp-field"><label for="spam-autodelete">${t('Automatically delete spam')}</label><label class="xp-check" for="spam-autodelete"><input id="spam-autodelete" type="checkbox" data-spam-autodelete${disabled}> ${t('Delete very high scores')}</label></div>
      </div>
      <h3>${t('Score thresholds (0 through 100)')}</h3>
      <div class="xp-spam-settings__fields">
        ${score('spam-rewrite', t('Rewrite subject score'))}
        ${score('spam-header', t('Add header score'))}
        ${score('spam-greylist', t('Greylist score'))}
        ${score('spam-reject', t('Reject score'))}
        ${score('spam-autodelete-score', t('Auto-delete score'))}
      </div>
    </div>
    <div class="xp-spam-settings__group">
      <h3>${t('Allow and block lists')}</h3>
      <div class="xp-spam-settings__fields">
        <div class="xp-field"><label for="spam-allowlist">${t('Allowlist (addresses, CIDRs or hostnames, one per line)')}</label><textarea id="spam-allowlist" class="xp-textarea xp-mono" dir="ltr" data-spam-allowlist${disabled}></textarea></div>
        <div class="xp-field"><label for="spam-blocklist">${t('Blocklist (addresses, CIDRs or hostnames, one per line)')}</label><textarea id="spam-blocklist" class="xp-textarea xp-mono" dir="ltr" data-spam-blocklist${disabled}></textarea></div>
      </div>
    </div>
    <div class="xp-spam-settings__actions"><button type="button" class="xp-btn xp-btn--primary" data-spam-save${disabled}>${t('Save spam settings')}</button></div>
    <p class="xp-help" data-spam-status role="status" hidden></p>
  </div>`
}
