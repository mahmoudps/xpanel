import { localeDirection, translator, type Locale } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

/** /whm/accounts/health, root only: previewed ownership repair and a re-render from saved settings. */
export function renderWhmAccountRepair(input: { locale: Locale; canManage: boolean }): string {
  const translate = translator(input.locale), t = (copy: string): string => escapeHtml(translate(copy)), off = input.canManage ? '' : ' disabled'
  const check = (hook: string, label: string): string => `<label><input type="checkbox" ${hook} checked${off}> ${t(label)}</label>`
  return `<section class="xp-whm-detail-card" aria-labelledby="whm-account-repair" data-whm-account-repair data-account-repair-can-manage="${input.canManage}" lang="${input.locale}" dir="${localeDirection(input.locale)}"><h2 id="whm-account-repair">${t(msgid('Account repair'))}</h2>
<p class="xp-help">${t(msgid('Fixes what the checks above report. Preview first: it reads each home and changes nothing. Plan, status and quota problems are fixed on the pages the checks link to.'))}</p>
<div class="xp-whm-detail-fields"><div class="xp-whm-detail-field"><label for="whm-account-repair-accounts">${t(msgid('Accounts, separated by spaces'))}</label><input id="whm-account-repair-accounts" class="xp-input" dir="ltr" maxlength="600" autocomplete="off" spellcheck="false" data-account-repair-accounts${off}></div></div>
<div class="xp-whm-detail-fields">${check('data-account-repair-ownership', msgid('Restore file ownership in the home'))}${check('data-account-repair-rerender', msgid('Rebuild web, PHP, quota and DNS configuration from saved settings'))}</div>
<div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-account-repair-preview${off}>${t(msgid('Preview'))}</button><button type="button" class="xp-btn" data-account-repair-run disabled>${t(msgid('Run repair'))}</button></div>
<p class="xp-whm-detail-status" data-account-repair-status data-state="${input.canManage ? 'unread' : 'unavailable'}" role="status">${t(input.canManage ? msgid('No preview has been read.') : msgid('Account repair requires root. Nothing was read or changed.'))}</p>
<div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t(msgid('Repair preview'))}"><table class="xp-whm-detail-table xp-table"><caption class="xp-sr-only">${t(msgid('Repair preview'))}</caption><thead><tr><th scope="col">${t(msgid('Account'))}</th><th scope="col">${t(msgid('Ownership'))}</th><th scope="col">${t(msgid('First path found'))}</th></tr></thead><tbody data-account-repair-rows><tr><td colspan="3">${t(msgid('No preview has been read.'))}</td></tr></tbody></table></div></section>`
}
