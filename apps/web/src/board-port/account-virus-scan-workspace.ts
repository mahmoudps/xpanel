import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'
import { ACCOUNT_TOOL_STYLE } from './account-ssh-workspace.ts'

/** ClamAV scan of the owner's own home as a host job; results come from the job log, nothing is quarantined. */
export function renderAccountVirusScanWorkspace(input: { lang: Locale; accountId: string; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => translator(input.lang)(message, values), off = input.canManage ? '' : ' disabled'
  const unread = t(msgctxt('account-virus-scan-workspace', 'Not read'))
  const fact = (key: string, label: string, technical = false) => `<div><dt>${label}</dt><dd>${technical ? `<bdi dir="ltr" data-vscan-${key}>${unread}</bdi>` : `<span data-vscan-${key}>${unread}</span>`}</dd></div>`
  const manager = input.canManage ? `<a class="xp-btn" href="/files/manager" data-vscan-files>${t('Open File manager')}</a>` : `<span>${t('File manager')}</span>`
  return `<div class="xp-acct-tool" data-account-virus-scan data-account="${escapeHtml(input.accountId)}" data-vscan-manage="${input.canManage}" lang="${input.lang}" dir="${localeDirection(input.lang)}">${ACCOUNT_TOOL_STYLE}
    <style>@media(min-width:601px){[data-account-virus-scan] .xp-acct-tool__card{padding:var(--xp-space-card)}}</style>
    <section class="xp-acct-tool__card" aria-labelledby="account-vscan-engine"><h2 id="account-vscan-engine">${t('Scanner')}</h2>
      <dl class="xp-acct-tool__facts">${fact('engine', t('ClamAV'))}${fact('version', t('Engine version'), true)}${fact('signatures', t('Signature database'), true)}${fact('signature-date', t('Signatures dated'), true)}</dl>
      <p class="xp-help">${t('The server administrator installs ClamAV and updates its signatures. Your scan uses the signatures shown here.')}</p></section>
    <section class="xp-acct-tool__card" aria-labelledby="account-vscan-start"><h2 id="account-vscan-start">${t('Scan your home directory')}</h2>
      <p>${t('The scan checks every file in your home directory, including your websites. It runs in the background on the server; refresh to follow it.')}</p>
      <dl class="xp-acct-tool__facts">${fact('next', t('Next scan'))}</dl>
      <p class="xp-help">${t('One scan at a time and one start every 15 minutes. Symbolic links are not followed, files larger than 100 MB are skipped and at most 400 MB is scanned from each archive.')}</p>
      <p data-vscan-status role="status" data-state="unread">${t('The scanner has not been read.')}</p>
      <div class="xp-acct-tool__actions"><button type="button" class="xp-btn xp-btn--primary" data-vscan-start${off}>${t('Start scan')}</button><button type="button" class="xp-btn" data-vscan-refresh${off}>${t('Refresh')}</button></div></section>
    <section class="xp-acct-tool__card" aria-labelledby="account-vscan-history"><h2 id="account-vscan-history">${t('Scan history')}</h2>
      <div class="xp-acct-tool__table" tabindex="0" role="region" aria-label="${t('Scan history')}"><table class="xp-table"><thead><tr>${[t('Started (UTC)'), t('Status'), t('Result'), t('Scanned files'), t('Infected files')].map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-vscan-rows><tr><td colspan="5">${t('The scan history has not been read.')}</td></tr></tbody></table></div>
      <p class="xp-help">${t('The last 10 scans of this account. Infected file paths are relative to your home directory, and at most 50 are listed per scan.')}</p></section>
    <section class="xp-acct-tool__card" aria-labelledby="account-vscan-remove"><h2 id="account-vscan-remove">${t('Removing infected files')}</h2>
      <p>${t('Quarantine and automatic deletion are not available here; the scan only reports infected files. To remove one, open the File manager, go to the path shown in the scan history and delete the file or replace it with a clean copy. Then start a new scan to confirm.')}</p>
      <div class="xp-acct-tool__actions">${manager}</div></section>
  </div>`
}
