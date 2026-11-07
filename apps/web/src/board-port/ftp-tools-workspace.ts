import { type Locale, translator } from '../i18n.ts'

/** Classic FTP tools; ftp-tools-client.ts fills and saves every value. */
const check = (id: string, label: string, hook: string): string => `<label class="xp-check" for="${id}"><input id="${id}" type="checkbox" ${hook} disabled> <span>${label}</span></label>`
const field = (id: string, label: string, control: string): string => `<div class="xp-whm-detail-field"><label for="${id}">${label}</label>${control}</div>`
const number = (id: string, key: string, min: number, max: number): string => `<input id="${id}" class="xp-input xp-mono" type="number" dir="ltr" min="${min}" max="${max}" data-ftp-setting="${key}" disabled>`
const table = (label: string, heads: readonly string[], hook: string): string => `<div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${label}"><table class="xp-table xp-whm-detail-table"><caption class="xp-sr-only">${label}</caption><thead><tr>${heads.map(head => `<th scope="col">${head}</th>`).join('')}</tr></thead><tbody ${hook}></tbody></table></div>`

export function renderFtpServerSettingsCard(locale: Locale, canManage: boolean): string {
  const t = translator(locale)
  return `<section class="xp-whm-service-detail__card" aria-labelledby="whm-ftp-settings-heading" data-ftp-server-settings data-can-manage="${canManage}">
    <h2 id="whm-ftp-settings-heading">${t('FTP server settings')}</h2>
    <div class="xp-whm-service-detail__fields">
      ${check('ftp-setting-enabled', t('Run the FTP server'), 'data-ftp-setting="enabled"')}
      ${field('ftp-setting-tls', t('TLS encryption'), `<select id="ftp-setting-tls" class="xp-select" data-ftp-setting="tls" disabled><option value="required">${t('Required')}</option><option value="optional">${t('Optional')}</option></select>`)}
      ${field('ftp-setting-ciphers', t('TLS cipher suite'), '<input id="ftp-setting-ciphers" class="xp-input xp-mono" type="text" dir="ltr" maxlength="256" data-ftp-setting="tlsCipherSuite" disabled>')}
      ${field('ftp-setting-idle', t('Idle timeout (minutes)'), number('ftp-setting-idle', 'maxIdleMinutes', 1, 1440))}
      ${field('ftp-setting-max', t('Maximum connections'), number('ftp-setting-max', 'maxConnections', 1, 10000))}
      ${field('ftp-setting-per-ip', t('Maximum connections per IP'), number('ftp-setting-per-ip', 'maxConnectionsPerIp', 1, 1000))}
      ${field('ftp-setting-passive-min', t('Passive ports from'), number('ftp-setting-passive-min', 'passiveMin', 1024, 65534))}
      ${field('ftp-setting-passive-max', t('Passive ports to'), number('ftp-setting-passive-max', 'passiveMax', 1025, 65535))}
      ${field('ftp-setting-listing', t('Directory listing limit (entries)'), number('ftp-setting-listing', 'listingLimit', 100, 100000))}
      ${check('ftp-setting-anonymous', t('Allow anonymous logins'), 'data-ftp-setting="anonymous"')}
      ${check('ftp-setting-uploads', t('Allow anonymous uploads'), 'data-ftp-setting="anonymousUploads"')}
      ${check('ftp-setting-broken', t('Broken client compatibility'), 'data-ftp-setting="brokenClients"')}
    </div>
    <div class="xp-whm-detail-actions"><button type="button" class="xp-btn xp-btn--primary" data-ftp-settings-save disabled>${t('Save FTP settings')}</button></div>
    <p class="xp-whm-detail-status" data-ftp-settings-status data-state="unread" role="status">${t('FTP settings have not been read.')}</p>
    <p class="xp-help">${t('Cleartext-only FTP is not offered. Passive ports open in the firewall while FTP runs. Turning FTP off is the FTP Server Selection choice: there is no second daemon to select.')}</p>
  </section>`
}

export function renderFtpAccountTools(locale: Locale, input: { canConnections: boolean; canAnonymous: boolean }): string {
  const t = translator(locale)
  return `<section class="xp-card" data-section="ftp-sessions" data-ftp-sessions-tool data-can-manage="${input.canConnections}" data-button-class="xp-btn">
    <div class="xp-card__header"><h2 class="xp-card__title">${t('FTP connections')}</h2><div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-ftp-sessions-refresh>${t('Read again')}</button><button type="button" class="xp-btn xp-btn--danger" data-ftp-sessions-all disabled>${t('Disconnect all')}</button></div></div>
    <p class="xp-help" data-ftp-sessions-status data-state="unread" role="status">${t('FTP sessions have not been read.')}</p>
    ${table(t('FTP connections'), [t('Login'), t('Client'), t('State'), t('Seconds'), t('Process'), t('Action')], 'data-ftp-sessions')}
  </section>
  <section class="xp-card" data-section="ftp-anonymous" data-ftp-anonymous-tool data-can-manage="${input.canAnonymous}">
    <div class="xp-card__header"><h2 class="xp-card__title">${t('Anonymous FTP')}</h2></div>
    <div class="xp-form-group">
      ${check('ftp-anonymous-enabled', t('Allow anonymous downloads from public_ftp'), 'data-ftp-anonymous-enabled')}
      ${check('ftp-anonymous-uploads', t('Allow anonymous uploads to public_ftp/incoming'), 'data-ftp-anonymous-uploads')}
      <div class="xp-field"><label class="xp-label" for="ftp-anonymous-welcome">${t('Welcome message')}</label><textarea id="ftp-anonymous-welcome" class="xp-input" rows="3" maxlength="2048" data-ftp-anonymous-welcome disabled></textarea></div>
      <p class="xp-help">${t('Sign in as:')} <bdi dir="ltr" class="xp-mono" data-ftp-anonymous-logins></bdi></p>
      <div><button type="button" class="xp-btn xp-btn--primary" data-ftp-anonymous-save disabled>${t('Save Anonymous FTP')}</button></div>
      <p class="xp-help" data-ftp-anonymous-status data-state="unread" role="status">${t('Anonymous FTP has not been read.')}</p>
    </div>
  </section>`
}

export function renderFtpReportCard(locale: Locale): string {
  const t = translator(locale), fact = (key: string, label: string): string => `<div><dt>${label}</dt><dd><bdi dir="ltr" data-ftp-report-fact="${key}">${t('Not read')}</bdi></dd></div>`
  return `<section class="xp-card" data-section="ftp-report" data-ftp-report>
    <div class="xp-card__header"><h2 class="xp-card__title">${t('FTP statistics')}</h2></div>
    <div class="xp-form-group"><div class="xp-field"><label class="xp-label" for="ftp-report-month">${t('Month')}</label><input id="ftp-report-month" class="xp-input xp-mono" type="month" dir="ltr" data-ftp-report-month></div><div><button type="button" class="xp-btn" data-ftp-report-read>${t('Read FTP report')}</button></div></div>
    <p class="xp-help" data-ftp-report-status data-state="unread" role="status">${t('The FTP report has not been read.')}</p>
    <dl class="xp-whm-detail-fields">${fact('transfers', t('Transfers'))}${fact('downloads', t('Downloads'))}${fact('uploads', t('Uploads'))}${fact('bytes', t('Data transferred'))}</dl>
    ${table(t('Transfers by day'), [t('Day'), t('Transfers'), t('Data transferred')], 'data-ftp-report-days')}
    ${table(t('Transfers by hour (UTC)'), [t('Hour'), t('Transfers'), t('Data transferred')], 'data-ftp-report-hours')}
    ${table(t('Transfers by FTP login'), [t('Login'), t('Downloads'), t('Uploads'), t('Data transferred')], 'data-ftp-report-users')}
  </section>`
}
