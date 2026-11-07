import { classicSecClientTemplates } from './sec-client-templates.ts'
import { type Locale, translator } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

/** Classic Manage MySQL Profiles; whm-db-profiles-client.ts reads, validates and saves every value. */
export function renderClassicDbProfilesCard(locale: Locale, canRead: boolean, canManage: boolean): string {
  const t = (message: string): string => escapeHtml(translator(locale)(message))
  const input = (key: string, label: string, max: number, type = 'text', extra = ''): string => `<div class="xp-whm-detail-field"><label for="db-${key}">${label}</label><input id="db-${key}" class="xp-input xp-mono" type="${type}" dir="ltr" maxlength="${max}" autocomplete="${type === 'password' ? 'new-password' : 'off'}" spellcheck="false" data-sec-input="${key}" disabled${extra}></div>`
  const headers = [t('Name'), t('Server'), t('User'), t('State'), t('Validation'), t('Actions')]
  return `<section class="xp-whm-detail-card" aria-labelledby="whm-db-profiles-heading" data-db-profiles-workspace data-sec-can-read="${canRead}" data-sec-can-manage="${canRead && canManage}">${classicSecClientTemplates()}
    <h2 id="whm-db-profiles-heading">${t('Database server profiles')}</h2>
    <p class="xp-whm-detail-status" data-sec-status data-state="unread" role="status">${t('Nothing has been read yet.')}</p><p class="xp-whm-detail-status" data-sec-result role="status" hidden></p>
    <dl class="xp-whm-detail-fields"><div class="xp-whm-detail-field"><dt>${t('Active server')}</dt><dd dir="ltr" data-sec-field="profile-active">${t('Not read')}</dd></div></dl>
    <div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t('Database server profiles')}"><table class="xp-whm-detail-table"><caption class="sr-only">${t('Database server profiles')}</caption><thead><tr>${headers.map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-sec-rows="profiles"><tr><td colspan="${headers.length}">${t('No profiles have been read.')}</td></tr></tbody></table></div>
    <div class="xp-whm-detail-fields">${input('profile-name', t('Profile name'), 32)}${input('profile-host', t('Server host'), 253)}${input('profile-port', t('Port'), 5, 'number', ' value="3306" min="1" max="65535"')}${input('profile-user', t('Administrator user'), 80)}${input('profile-password', t('Password'), 128, 'password')}${input('profile-description', t('Description'), 200)}</div>
    <div class="xp-whm-detail-field"><label for="db-profile-ca">${t('Server CA certificate')}</label><textarea id="db-profile-ca" class="xp-input xp-mono" rows="6" dir="ltr" maxlength="8192" spellcheck="false" autocomplete="off" data-sec-input="profile-ca" disabled></textarea><p class="xp-help">${t('TLS is required. The client checks the server certificate and host name against this PEM certificate before it sends the user or password. Leave it empty to keep the saved one.')}</p></div>
    <p class="xp-help">${t('The password is stored only in a root-only file on this server and is never shown again. Activating a profile never moves data, and it is refused while databases are saved on the active server.')}</p>
    <div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-sec-action="profiles-refresh"${canRead ? '' : ' disabled'}>${t('Refresh')}</button><button type="button" class="xp-btn xp-btn--primary" data-sec-action="profile-save" disabled>${t('Save profile')}</button></div>
  </section>`
}
