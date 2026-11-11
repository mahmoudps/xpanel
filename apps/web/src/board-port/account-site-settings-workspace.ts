import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'
import { ACCOUNT_TOOL_STYLE } from './account-ssh-workspace.ts'

/** Connected site settings of the classic theme; the same hooks drive account-site-settings-client.ts as in the V2 page. */
export function renderAccountSiteSettingsWorkspace(input: { lang: Locale; accountId: string; home: string; domainId: string; domains: readonly { id: string; name: string }[]; canManage: boolean }): string {
  const t = (message: string, values?: MessageValues): string => escapeHtml(translator(input.lang)(message, values))
  const text = (id: string, label: string, hook: string, type = 'text', help = ''): string => `<div class="xp-field"><label for="site-${id}">${label}</label><input id="site-${id}" class="xp-input" dir="ltr" type="${type}" ${hook} disabled>${help ? `<p class="xp-help">${help}</p>` : ''}</div>`
  const box = (id: string, label: string, hook: string): string => `<div class="xp-field"><label for="site-${id}"><input id="site-${id}" type="checkbox" ${hook} disabled> ${label}</label></div>`
  const head = (labels: readonly string[]): string => `<thead><tr>${labels.map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead>`
  return `<div class="xp-acct-tool" data-site-settings data-site-account="${escapeHtml(input.accountId)}" data-site-home="${escapeHtml(input.home)}" data-site-domain="${escapeHtml(input.domainId)}" data-site-can-read="${input.canManage}" data-site-manage="${input.canManage}" lang="${input.lang}" dir="${localeDirection(input.lang)}">${ACCOUNT_TOOL_STYLE}
    <section class="xp-acct-tool__card" aria-labelledby="site-choice"><h2 id="site-choice">${t('Site')}</h2>
      <div class="xp-field"><label for="site-selected">${t('Site')}</label><select id="site-selected" class="xp-select" data-site-selector>${input.domains.map(domain => `<option value="${escapeHtml(domain.id)}"${domain.id === input.domainId ? ' selected' : ''}>${escapeHtml(domain.name)}</option>`).join('')}</select></div></section>
    <section class="xp-acct-tool__card" aria-labelledby="site-lifecycle"><h2 id="site-lifecycle">${t('Stop, expiry and path quota')}</h2>
      <dl class="xp-acct-tool__facts"><div><dt>${t('Status')}</dt><dd data-site-state>${t('Not read')}</dd></div></dl>
      <div class="xp-field"><label for="site-stopped-message">${t('Message on the stopped page')}</label><textarea id="site-stopped-message" class="xp-textarea" rows="3" dir="auto" maxlength="1000" data-site-stopped-message disabled></textarea></div>
      <div class="xp-acct-tool__fields">${text('expiry', t('Stop the site on'), 'data-site-expiry', 'date')}${text('quota', t('Path quota (MiB)'), 'data-site-quota min="1"', 'number')}${text('reminder-address', t('Expiry reminder address'), 'data-site-reminder-address', 'email')}${text('reminder-days', t('Reminder days before expiry'), 'data-site-reminder-days min="1" max="90"', 'number')}</div>
      ${box('quota-unlimited', t('Unlimited path quota'), 'data-site-quota-unlimited')}${box('no-expiry', t('No expiry'), 'data-site-no-expiry')}
      <p class="xp-help" data-site-quota-state>${t('Path quota support has not been read.')}</p>
      <div class="xp-acct-tool__actions"><button type="button" class="xp-btn" data-site-stop disabled>${t('Stop site')}</button><button type="button" class="xp-btn" data-site-start disabled>${t('Start site')}</button></div></section>
    <section class="xp-acct-tool__card" aria-labelledby="site-directory"><h2 id="site-directory">${t('Runtime and document root')}</h2>
      <div class="xp-acct-tool__fields">${text('docroot', t('Document root'), 'data-site-docroot')}${text('run-directory', t('Run directory'), 'data-site-run-directory maxlength="128" spellcheck="false" autocomplete="off"', 'text', t('A subfolder that already exists, such as public. Empty serves the document root.'))}</div>
      ${box('isolated', t('Isolate this site: PHP reaches only this document root and the account tmp folder'), 'data-site-isolated')}${box('visitor-log', t('Record visitor details in the access log'), 'data-site-visitor-log')}
      <p class="xp-help">${t('Isolation writes .user.ini in the served folder and can take up to 5 minutes to reach running PHP. With visitor details off, requests still count toward bandwidth, without addresses or URLs.')}</p>
      <p><a href="/files/directory-privacy">${t('Password-protect this site')}</a></p></section>
    <section class="xp-acct-tool__card" aria-labelledby="site-traffic"><h2 id="site-traffic">${t('Traffic control')}</h2>
      ${box('traffic-enabled', t('Limit traffic to this site'), 'data-site-traffic-enabled')}
      <div class="xp-acct-tool__fields"><div class="xp-field"><label for="site-traffic-preset">${t('Preset')}</label><select id="site-traffic-preset" class="xp-select" data-site-traffic-preset disabled><option value="custom">${t('Custom')}</option><option value="blog">${t('Forum or blog')}</option><option value="images">${t('Image site')}</option><option value="downloads">${t('Download site')}</option></select></div>
      ${text('traffic-site', t('Connections to this site'), 'data-site-traffic-site min="1"', 'number')}${text('traffic-ip', t('Connections per visitor address'), 'data-site-traffic-ip min="1"', 'number')}${text('traffic-rate', t('Speed per connection (KB/s)'), 'data-site-traffic-rate min="1"', 'number')}</div>
      <p class="xp-help">${t('A visitor over a connection limit gets a 503 response.')}</p></section>
    <section class="xp-acct-tool__card" aria-labelledby="site-deny"><h2 id="site-deny">${t('Deny access')}</h2>
      <div class="xp-acct-tool__table" tabindex="0" role="region" aria-label="${t('Deny rules')}"><table class="xp-table">${head([t('Name'), t('Directory'), t('File extensions'), t('Action')])}<tbody data-site-deny-rows></tbody></table></div>
      <div class="xp-acct-tool__fields">${text('deny-name', t('Name'), 'data-site-deny-name maxlength="32" autocomplete="off"')}${text('deny-directory', t('Directory'), 'data-site-deny-directory maxlength="256" placeholder="/uploads" spellcheck="false" autocomplete="off"')}${text('deny-extensions', t('File extensions'), 'data-site-deny-extensions placeholder="php, phtml" spellcheck="false" autocomplete="off"')}</div>
      <p class="xp-help">${t('Matching requests get a 403 response at or below the directory.')}</p>
      <div class="xp-acct-tool__actions"><button type="button" class="xp-btn" data-site-deny-add disabled>${t('Add rule')}</button></div></section>
    <section class="xp-acct-tool__card" aria-labelledby="site-review"><h2 id="site-review">${t('Review changes')}</h2>
      <p data-site-status role="status" data-state="unread">${input.canManage ? t('Saved domain configuration has not been read.') : t('This session cannot change this site.')}</p>
      <div class="xp-acct-tool__table" tabindex="0" role="region" aria-label="${t('Review changes')}"><table class="xp-table">${head([t('Setting'), t('Current'), t('Proposed')])}<tbody data-site-review-rows></tbody></table></div>
      <p class="xp-help">${t('The web server configuration test runs before any reload. A failed test keeps the running site and rolls the save back.')}</p>
      ${box('review-ack', t('I reviewed the proposed site changes.'), 'data-site-review-ack')}
      <div class="xp-acct-tool__actions"><button type="button" class="xp-btn" data-site-reset disabled>${t('Reset')}</button><button type="button" class="xp-btn xp-btn--primary" data-site-save disabled>${t('Save site settings')}</button></div></section>
  </div>`
}
