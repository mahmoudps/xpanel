import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

/** /mail/tools/connect-devices: settings from trusted server configuration for the sealed mailbox; never a password. */
export function renderMailConnectDevices(input: { locale: Locale; mailbox: string; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => translator(input.locale)(message, values)
  const notRead = t('Not read')
  const columns = [t('Service'), t('Server'), t('Port'), t('Security'), t('Username')]
  const download = (kind: string, label: string): string => `<a class="xp-btn" data-mail-devices-download="${kind}" hidden aria-disabled="true" download>${label}</a>`
  return `<section class="xp-card xp-mail-devices" data-mail-connect-devices data-devices-mailbox="${escapeHtml(input.mailbox)}" data-devices-can-read="${input.canManage}" lang="${input.locale}" dir="${localeDirection(input.locale)}" aria-labelledby="mail-devices-heading">
    <style>.xp-mail-devices{display:flex;flex-direction:column;gap:24px;padding:16px;min-inline-size:0}.xp-mail-devices :is(h2,h3,p,dl,dd,ol){margin:0}.xp-mail-devices__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:16px}.xp-mail-devices__facts>div{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-mail-devices dd,.xp-mail-devices td{overflow-wrap:anywhere}.xp-mail-devices__group{display:flex;flex-direction:column;gap:16px;min-inline-size:0}.xp-mail-devices__actions{display:flex;flex-wrap:wrap;gap:16px;align-items:center}.xp-mail-devices .xp-btn{min-block-size:44px}.xp-mail-devices ol{display:flex;flex-direction:column;gap:8px;padding-inline-start:24px}.xp-mail-devices [hidden]{display:none}@media(min-width:601px){.xp-mail-devices{padding:24px}}</style>
    <h2 id="mail-devices-heading">${t('Connect mail apps and devices')}</h2>
    <p class="xp-help">${t('Use these settings in desktop and mobile mail apps. Your password is the mailbox password; it is never shown here or included in setup files.')}</p>
    <p class="xp-help" data-mail-devices-status data-state="unread" role="status">${input.canManage ? t('Settings have not been read.') : t('Mail client setup is unavailable for this mailbox session. Nothing was read.')}</p>
    <dl class="xp-mail-devices__facts"><div><dt>${t('Username')}</dt><dd><bdi dir="ltr">${escapeHtml(input.mailbox)}</bdi></dd></div><div><dt>${t('Password')}</dt><dd>${t('Your mailbox password')}</dd></div><div><dt>${t('Server')}</dt><dd><bdi dir="ltr" data-mail-devices-fact="hostname">${notRead}</bdi></dd></div><div><dt>${t('Certificate')}</dt><dd data-mail-devices-fact="certificate">${t('Not verified by this page')}</dd></div></dl>
    <div class="xp-mail-devices__group"><h3>${t('Manual settings')}</h3>
      <div class="xp-table-wrap" role="region" tabindex="0" aria-label="${t('Manual settings')}"><table class="xp-table"><caption class="sr-only">${t('Incoming and outgoing mail servers')}</caption><thead><tr>${columns.map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-mail-devices-rows><tr><td colspan="${columns.length}">${t('Settings have not been read.')}</td></tr></tbody></table></div>
      <p class="xp-help">${t('Prefer IMAP on port 993. Authentication uses your normal password over an encrypted connection. POP3 is not offered by this server.')}</p>
    </div>
    <div class="xp-mail-devices__group"><h3>${t('Automatic setup files')}</h3>
      <p class="xp-help" data-mail-devices-download-note>${t('Setup files are available after the settings are read.')}</p>
      <div class="xp-mail-devices__actions">${download('autoconfig', t('Download Thunderbird setup (XML)'))}${download('apple', t('Download Apple profile (iPhone, iPad, Mac)'))}</div>
      <ol><li>${t('Thunderbird: open the downloaded XML from the account setup when asked, or enter the manual settings above.')}</li><li>${t('Apple devices: open the profile, review it in Settings, install it, then enter your mailbox password when asked. The profile is not signed.')}</li></ol>
    </div>
  </section>`
}
