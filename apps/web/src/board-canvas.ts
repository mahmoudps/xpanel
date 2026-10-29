import type { Limit } from '@xpanel/core'
import { type Locale, translator } from './i18n.ts'
import { escapeHtml } from './tokens.ts'

type Copy = string

const tx = (locale: Locale, copy: Copy): string => translator(locale)(copy)
const h = (value: string): string => escapeHtml(value)

const unavailable: Copy = msgid('Unavailable')
const notRead: Copy = msgid('Not read')

const soonBtn = (locale: Locale, label: Copy, quiet = false): string =>
  `<button type="button" class="xp-btn${quiet ? '' : ' xp-btn--primary'}" disabled data-wiring="soon" aria-describedby="xp-board-unavailable-reason">${h(tx(locale, label))}</button>`

const empty = (locale: Locale, title: Copy, body?: Copy): string =>
  `<div class="xp-design-empty" role="status"><h3>${h(tx(locale, title))}</h3>${body ? `<p>${h(tx(locale, body))}</p>` : ''}</div>`

const card = (id: string, locale: Locale, title: Copy, body: string, lede?: Copy): string =>
  `<section class="xp-board-section" id="${id}" aria-labelledby="${id}-title"><header class="xp-board-section__head"><h2 id="${id}-title">${h(tx(locale, title))}</h2>${lede ? `<p>${h(tx(locale, lede))}</p>` : ''}</header><div class="xp-board-section__body">${body}</div></section>`

const table = (locale: Locale, headers: readonly Copy[], message: Copy): string =>
  `<div class="xp-table-wrap"><table class="xp-table"><thead><tr>${headers.map(column => `<th>${h(tx(locale, column))}</th>`).join('')}</tr></thead><tbody><tr><td colspan="${headers.length}">${h(tx(locale, message))}</td></tr></tbody></table></div>`

const field = (id: string, locale: Locale, label: Copy, type = 'text'): string =>
  `<div class="xp-field"><label for="${id}">${h(tx(locale, label))}</label><input id="${id}" class="xp-input" type="${type}" value="" disabled data-wiring="soon"></div>`

const select = (id: string, locale: Locale, label: Copy, options: readonly Copy[]): string =>
  `<div class="xp-field"><label for="${id}">${h(tx(locale, label))}</label><select id="${id}" class="xp-select" disabled data-wiring="soon">${options.map(option => `<option>${h(tx(locale, option))}</option>`).join('')}</select></div>`

const textarea = (id: string, locale: Locale, label: Copy, rows = 6): string =>
  `<div class="xp-field"><label for="${id}">${h(tx(locale, label))}</label><textarea id="${id}" class="xp-input xp-board-editor" rows="${rows}" readonly disabled data-wiring="soon" aria-describedby="xp-board-unavailable-reason"></textarea></div>`

const steps = (locale: Locale, items: readonly Copy[]): string =>
  `<ol class="xp-board-steps" aria-label="${h(tx(locale, msgid('Workflow')))}">${items.map((item,index) => `<li${index === 0 ? ' aria-current="step"' : ''}><span class="xp-board-step-number" aria-hidden="true">${index + 1}</span><span>${h(tx(locale,item))}</span></li>`).join('')}</ol>`

const fields = (locale: Locale, prefix: string, labels: readonly Copy[]): string =>
  `<div class="xp-board-fields">${labels.map((label,index)=>field(`${prefix}-${index}`,locale,label)).join('')}</div>`

const actions = (locale: Locale, primary: Copy, secondary?: Copy): string =>
  `<div class="xp-board-actions">${secondary ? soonBtn(locale,secondary,true) : ''}${soonBtn(locale,primary)}</div>`

const tabs = (locale: Locale, name: Copy, items: readonly Copy[]): string =>
  `<div class="xp-board-options" role="group" aria-label="${h(tx(locale,name))}">${items.map(item=>`<button type="button" class="xp-btn xp-btn--quiet" disabled data-wiring="soon" aria-describedby="xp-board-unavailable-reason">${h(tx(locale,item))}</button>`).join('')}</div>`

const note = (locale: Locale, title: Copy, body: Copy): string =>
  `<aside class="xp-board-note" role="note"><h2>${h(tx(locale, title))}</h2><p>${h(tx(locale, body))}</p></aside>`

const legend = (locale: Locale, title: Copy, body: string): string =>
  `<fieldset class="xp-board-legend" disabled><legend>${h(tx(locale, title))}</legend>${body}</fieldset>`

const code = (text: string): string => `<pre class="xp-board-code"><code><bdi dir="ltr">${h(text)}</bdi></code></pre>`

const stats = (locale: Locale, items: readonly (readonly [Copy, Copy])[]): string =>
  `<dl class="xp-board-stats">${items.map(([label, value]) => `<div><dt>${h(tx(locale, label))}</dt><dd>${h(tx(locale, value))}</dd></div>`).join('')}</dl>`

const checks = (locale: Locale, items: readonly Copy[]): string =>
  `<ul class="xp-board-checks">${items.map(item => `<li><label><input type="checkbox" disabled data-wiring="soon"> ${h(tx(locale, item))}</label></li>`).join('')}</ul>`

const radios = (name: string, locale: Locale, items: readonly Copy[]): string =>
  `<div class="xp-board-radios">${items.map(item => `<label class="xp-radio-card"><input type="radio" name="${name}" disabled data-wiring="soon"> ${h(tx(locale, item))}</label>`).join('')}</div>`

const anchors = (locale: Locale, items: readonly (readonly [string, Copy])[]): string =>
  `<nav class="xp-board-anchors" aria-label="${h(tx(locale, msgid('On this page')))}">${items.map(([href, label]) => `<a href="#${href}">${h(tx(locale, label))}</a>`).join('')}</nav>`

const region = (route: string, locale: Locale, body: string): string =>
  `<div class="xp-board-canvas" data-board-layout="${h(route)}" data-read-state="unread"><style>.xp-board-steps{display:flex;flex-wrap:wrap;gap:16px;list-style:none;margin:0;padding:0}.xp-board-steps li{display:flex;align-items:center;gap:8px;min-block-size:44px}.xp-board-step-number{display:inline-flex;align-items:center;justify-content:center;inline-size:32px;block-size:32px;border:1px solid var(--xp-border);border-radius:50%;font-variant-numeric:tabular-nums}.xp-board-steps [aria-current="step"]{font-weight:600}.xp-board-options{display:flex;flex-wrap:wrap;gap:16px}.xp-board-editor{box-sizing:border-box;inline-size:100%;min-inline-size:0;min-block-size:160px;resize:vertical;text-align:start}.xp-board-canvas .xp-board-unavailable{display:flex;flex-direction:column;gap:8px}.xp-board-canvas .xp-board-unavailable p{margin:0}.xp-board-canvas .xp-board-section__body>.xp-board-fields{inline-size:100%}.xp-board-canvas .xp-board-checks{gap:16px}</style><aside class="xp-board-note xp-board-unavailable" role="note"><h2>${h(tx(locale,msgid('Coming soon: this operation is not connected')))}</h2><p id="xp-board-unavailable-reason">${h(tx(locale,msgid('The page structure is available, but its saved configuration and service readings have not been loaded. Controls stay disabled and no change is submitted.')))}</p></aside>${body}</div>`

const backup = (locale: Locale): string => region('/files/backup', locale, [
  tabs(locale,msgid('Backup mode'),[msgid('Back up'),msgid('Restore')]),
  steps(locale,[msgid('What to include'),msgid('Destination'),msgid('Review'),msgid('Result')]),
  card('backup-include',locale,msgid('What do you want to back up?'),`${checks(locale,[msgid('Home directory files'),msgid('Databases'),msgid('Mailboxes'),msgid('Mail config')])}${field('backup-folder',locale,msgid('Folder'))}${legend(locale,msgid('Databases'),table(locale,[msgid('Database'),msgid('Size')],msgid('The database selection has not been read.')))}`),
  card('backup-dest',locale,msgid('Where should the archive go?'),`${radios('backup-destination',locale,[msgid('Download to this device'),msgid('Local storage'),msgctxt('board-canvas', 'Remote storage')])}${select('backup-remote',locale,msgid('Remote storage'),[msgid('Destinations not read')])}${checks(locale,[msgid('Email me when it is done')])}${actions(locale,msgid('Review backup'),msgid('Back'))}`),
  card('backup-restore',locale,msgid('Choose an archive'),`${select('backup-archive',locale,msgid('Archive'),[msgid('Archives not read')])}${legend(locale,msgid('What to restore from it'),checks(locale,[msgid('Home directory files'),msgid('Databases'),msgid('Mailboxes'),msgid('Mail config')]))}`),
  card('backup-review',locale,msgid('Review the difference'),`${tabs(locale,msgid('Difference filter'),[msgid('All'),msgid('New'),msgctxt('board-canvas', 'Changed'),msgid('Unchanged')])}${table(locale,[msgid('Path'),msgid('Current'),msgid('Archive'),msgid('Planned action')],msgid('No archive has been selected or compared.'))}${checks(locale,[msgid('I reviewed the proposed restore changes')])}${actions(locale,msgid('Restore selected parts'),msgid('Back'))}`),
  note(locale,msgid('What a restore never does'),msgid('A restore shows the difference first and never deletes a file that is missing from the archive.')),
  card('backup-location',locale,msgid('Where archives live'),empty(locale,msgid('Archive locations have not been read.'))),
  card('backup-archives',locale,msgid('Archives'),`${table(locale,[msgid('Archive'),msgid('Created'),msgid('Size'),msgid('Status')],msgid('The archive list has not been read.'))}${actions(locale,msgid('Create backup'),msgid('Download selected archive'))}`),
].join(''))

const privacy = (locale: Locale): string => region('/files/directory-privacy', locale, [
  card('privacy-list', locale, msgid('Directory privacy'), `${table(locale, [msgid('Folder'), msgctxt('board-canvas', 'Prompt shown'), msgid('Users'), msgid('Status')], msgid('No protected directories'))}<p>${h(tx(locale, msgid('Protected folders are served over HTTPS only. Password files stay outside the public site.')))}</p>`),
  card('privacy-add', locale, msgid('Protect a folder'), `<div class="xp-board-fields">${field('priv-path', locale, msgid('Folder'))}${field('priv-realm', locale, msgctxt('board-canvas', 'Prompt shown'))}${field('priv-user', locale, msgctxt('board-canvas', 'First user'))}${field('priv-pass', locale, msgid('Password for this user'), 'password')}</div>${soonBtn(locale, msgctxt('board-canvas', 'Protect folder'))}`),
].join(''))

const panelPhp = (locale: Locale): string => region('/software/php', locale, [
  card('php-domain', locale, msgid('Domain and version'), `${empty(locale, msgid('No PHP selection yet'))}<div class="xp-board-fields">${field('php-domain-name', locale, msgid('Domain'))}${select('php-version', locale, msgid('PHP version'), [msgid('Version not read')])}</div>${legend(locale, msgid('Handler'), radios('php-handler',locale,['PHP-FPM',msgid('CGI with suexec'),'suPHP','lsphp']))}<p class="xp-help">${h(tx(locale,msgid('Handler availability depends on the installed engine and host checks; no handler is selected here.')))}</p>`),
  card('php-pool', locale, msgctxt('board-canvas', 'PHP-FPM pool'), `${legend(locale,msgid('Process manager pm'),radios('php-pm',locale,['ondemand','dynamic','static']))}${fields(locale,'php-pool',['pm.max_children','pm.start_servers','pm.min_spare_servers','pm.max_spare_servers','pm.max_requests','pm.process_idle_timeout'])}`),
  card('php-ini', locale, msgid('INI values'), `${legend(locale,msgid('Save to'),radios('php-save-target',locale,['.user.ini',msgctxt('board-canvas:3', 'PHP-FPM pool')]))}${fields(locale,'php-ini',['memory_limit','upload_max_filesize','post_max_size','max_execution_time','max_input_vars','date.timezone'])}${select('php-display-errors',locale,'display_errors',[msgid('Not read')])}${actions(locale,msgid('Save PHP settings'),msgid('Reset draft'))}`),
  card('php-running', locale, msgid('Running now'), `${table(locale,[msgid('Property'),msgctxt('board-canvas', 'Reading')],msgid('Runtime readings have not been loaded.'))}${code('')}`),
  card('php-disabled', locale, msgid('Disabled functions'), table(locale, [msgid('Function'),msgid('Source')], msgid('The function policy has not been read.'))),
].join(''))

const htaccess = (locale: Locale): string => region('/software/htaccess', locale, [
  card('ht-file', locale, '.htaccess', `${field('ht-file-path',locale,msgid('File'))}${select('ht-snippet',locale,msgid('Insert'),[msgid('Choose a snippet'),msgid('Redirect'),msgid('Cache headers'),msgid('Security headers')])}${soonBtn(locale,msgid('Insert at cursor'),true)}${textarea('ht-file-editor',locale,msgid('File contents'),14)}${actions(locale,msgid('Save and check site'),msgid('Discard draft'))}`),
  card('ht-php', locale, msgid('PHP settings in .htaccess'), `${table(locale,[msgid('Directive'),msgid('Value'),msgid('Compatibility')],msgid('The file and its handler compatibility have not been read.'))}${soonBtn(locale,msgid('Move PHP settings to .user.ini'),true)}`),
  card('ht-versions', locale, msgid('Versions'), `${table(locale, [msgid('Version'), msgid('Saved'),msgid('Author'),msgid('Result')], msgid('Saved versions have not been read.'))}${soonBtn(locale,msgid('Restore selected version'),true)}`),
  note(locale, msgid('What a save does'), msgid('A save must validate the selected file and report the site check result. No file is changed from this unavailable editor.')),
].join(''))

const cron = (locale: Locale): string => region('/advanced/cron', locale, [
  card('cron-jobs', locale, msgid('Scheduled jobs'), `${table(locale, [msgid('Job'), msgid('Schedule'), msgid('Command'), msgid('Last run'), msgid('Duration'), msgid('Next run')], msgid('The scheduled job list has not been read.'))}${actions(locale,msgid('Run selected job now'),msgid('View unit'))}`),
  card('cron-add', locale, msgid('Add a cron job'), `${legend(locale, msgid('Schedule'), `${select('cron-preset', locale, msgid('Common schedules'), [msgid('Every 5 minutes'),msgid('Every hour, on the hour'),msgid('Twice a day'),msgid('Every day'),msgid('Every Sunday'),msgid('On the 1st of the month'),msgid('Custom schedule')])}${fields(locale,'cron-schedule',[msgid('Minute'),msgid('Hour'),msgid('Day'),msgid('Month'),msgid('Weekday')])}`)}${legend(locale,msgid('Command'),`${field('cron-command',locale,msgid('Command to run'))}${field('cron-timeout',locale,msgid('Stop the job after'))}${checks(locale,[msgid('Unlimited')])}`)}${legend(locale,msgid('Email the output'),radios('cron-email-mode',locale,[msgid('Only when it fails'),msgid('After every run'),msgid('Never')]))}${actions(locale,msgid('Add cron job'),msgid('Reset draft'))}`),
  note(locale, msgid('How a job runs'), msgid('Each job runs as this account, inside its slice, through its own timer. Jobs share the plan limits.')),
  card('cron-unit',locale,msgid('Unit preview'),`${empty(locale,msgid('No job is selected.'))}${code('')}`),
  card('cron-mail', locale, msgid('Output email'), `${field('cron-output-email',locale,msgid('Send job output to'),'email')}${soonBtn(locale,msgid('Save address'),true)}`),
].join(''))

const setup = (locale: Locale): string => region('/whm/server/setup', locale, [
  steps(locale,[msgid('Host and nameservers'),msgid('Engine and workers'),msgid('Review'),msgid('Apply')]),
  card('setup-host',locale,msgid('Host and nameservers'),fields(locale,'setup-host',[msgid('Server hostname'),msgid('Nameserver 1'),msgid('Nameserver 1 address'),msgid('Nameserver 2'),msgid('Nameserver 2 address'),msgid('Admin email')])),
  card('setup-notices',locale,msgid('Send notices about'),checks(locale,[msgid('Failed configuration tests and rollbacks'),msgid('Certificates that fail to renew'),msgid('Upgrade results'),msgid('Paused sign-ins to xWHM')])),
  card('setup-engine',locale,msgid('Web engine for the whole server'),`${radios('setup-engine',locale,[msgid('Apache with mpm-itk'),'OpenLiteSpeed'])}<p class="xp-help">${h(tx(locale,msgid('Engine availability and isolation checks have not been read. Selecting a different engine affects every site.')))}</p>`),
  card('setup-workers',locale,msgid('Workers and account defaults'),`${legend(locale,msgid('Nginx at the edge'),fields(locale,'setup-nginx',['worker_processes','worker_connections','worker_rlimit_nofile','keepalive_timeout']))}${legend(locale,'Apache mpm-itk',fields(locale,'setup-apache',['StartServers','MinSpareServers','MaxSpareServers','MaxRequestWorkers','ServerLimit','MaxConnectionsPerChild']))}${legend(locale,msgid('Default PHP-FPM pool for new accounts'),fields(locale,'setup-fpm',['pm','pm.max_children','pm.process_idle_timeout','pm.max_requests']))}${legend(locale,msgid('OpenLiteSpeed and lsphp'),fields(locale,'setup-lsphp',[msgid('Server max connections'),msgid('lsphp children per account'),msgid('lsphp connections per account')]))}`),
  card('setup-review',locale,msgid('Tests on the candidate generation'),`${table(locale,[msgid('Check'),msgid('Result')],msgid('No candidate has been prepared or tested.'))}${actions(locale,msgid('Apply first generation'),msgid('Back'))}`),
  card('setup-detected', locale, msgid('Detected on this host'), `${table(locale, [msgid('Check'), msgid('Result')], msgid('Host detection has not been read.'))}${soonBtn(locale,msgid('Detect again'),true)}`),
  card('setup-php', locale, msgid('PHP handlers by engine'), table(locale, [msgid('Engine'), msgid('Handler'),msgid('Availability')], msgid('Handler availability has not been read.'))),
].join(''))

const features = (locale: Locale): string => region('/whm/plans/features', locale, [
  card('feat-lists', locale, msgid('Lists and the plans that use them'), `${table(locale, [msgid('List'), msgid('Plans'), msgid('Accounts')], msgid('Feature lists and plan assignments have not been read.'))}${actions(locale,msgid('Create feature list'),msgid('Duplicate a list'))}`),
  card('feat-tools', locale, msgid('Tools by list'), `${field('feature-search',locale,msgid('Filter tools'))}${table(locale,[msgid('Tool'),msgid('List assignment'),msgid('Availability')],msgid('Tool assignments have not been read. No enabled state is assumed.'))}`),
  card('feat-dirty', locale, msgid('Unsaved changes'), `${table(locale,[msgid('Tool'),msgid('Before'),msgid('After')],msgid('No draft is available until the saved lists have been read.'))}${actions(locale,msgid('Save feature lists'),msgid('Discard'))}`),
  note(locale, msgid('How lists apply'), msgid('Turning a tool off hides it. It does not delete files, mail, or databases. List availability never replaces server authorization.')),
].join(''))

const whmDomains = (locale: Locale): string => region('/whm/domains', locale, [
  card('whm-domains',locale,msgid('Domains'),`${tabs(locale,msgid('Domain kind'),[msgid('All'),msgid('Primary'),msgid('Addon'),msgid('Alias'),msgid('Subdomain')])}<div class="xp-board-fields">${select('whm-domain-account',locale,msgid('Account'),[msgid('Accounts not read')])}${select('whm-domain-ssl',locale,msgid('SSL state'),[msgid('Any state'),msgid('Valid'),msgctxt('board-canvas', 'Missing')])}${select('whm-domain-php',locale,msgid('PHP version'),[msgid('Versions not read')])}</div>${table(locale,[msgid('Domain'),msgid('Kind'),msgid('Account'),msgid('Docroot'),'PHP','SSL',msgid('Status')],msgid('Server domains have not been read.'))}${actions(locale,msgid('Add domain to an account'),msgctxt('board-canvas', 'Clear filters'))}`),
  card('whm-default-site',locale,msgid('Default site for unbound names'),`${legend(locale,msgid('Answer with'),radios('unbound-answer',locale,[msgid('Default page'),msgid('Redirect'),msgid('Reject the request')]))}${field('unbound-redirect',locale,msgid('Redirect to'),'url')}${checks(locale,[msgid('Refuse HTTPS for unknown names')])}${table(locale,[msgid('Unbound request'),msgid('Last seen')],msgid('Unbound request observations have not been read.'))}${actions(locale,msgid('Save default site'),msgid('Discard'))}`),
  note(locale,msgid('How a name finds its site'),msgid('The requested hostname is resolved to its stored site and account before serving content. A name without an authorized binding must use the reviewed default-site policy.')),
].join(''))

const dns = (locale: Locale): string => region('/whm/dns', locale, [
  card('dns-zones',locale,msgid('Zones'),`${table(locale,[msgid('Zone'),msgid('Account'),msgid('Records'),msgid('Serial'),msgid('Status')],msgid('The zone list has not been read.'))}${actions(locale,msgid('Add zone'),msgid('Edit records'))}`),
  card('dns-import',locale,msgid('Zone file'),`${textarea('dns-bind-zone',locale,msgid('BIND zone file'),8)}${actions(locale,msgid('Preview changes'),msgid('Export zone file'))}`),
  card('dns-records',locale,msgid('Records in the selected zone'),table(locale,[msgid('Name'),msgid('Type'),'TTL',msgid('Content'),msgid('Priority')],msgid('No zone has been selected or read.'))),
  card('dns-record',locale,msgid('Add a record'),`${tabs(locale,msgid('Record type'),['A','AAAA','CNAME','MX','TXT','SRV','CAA'])}${fields(locale,'dns-record',[msgid('Name'),'TTL',msgid('Content'),msgid('Priority'),msgid('Weight'),msgid('Port')])}${actions(locale,msgid('Add record'),msgid('Clear'))}`),
  card('dns-soa',locale,msgid('SOA serial'),empty(locale,msgid('The selected zone serial has not been read.'))),
  card('dns-api',locale,msgid('PowerDNS API'),`${empty(locale,msgid('Service availability has not been read.'))}${soonBtn(locale,msgid('Check again'),true)}`),
].join(''))

const whmSsl = (locale: Locale): string => region('/whm/ssl', locale, [
  stats(locale,[[msgid('Certificates'),notRead],[msgid('In the renewal window'),notRead],[msgid('Failed renewals'),notRead],[msgid('Next AutoSSL run'),notRead]]),
  card('ssl-auto',locale,'AutoSSL',`${checks(locale,[msgid('Issue and renew certificates automatically')])}${legend(locale,msgid('Certificate authority'),`${select('ssl-ca',locale,msgid('ACME provider'),["Let's Encrypt",msgid('Custom ACME directory')])}${field('ssl-contact',locale,msgid('Account contact'),'email')}`)}${legend(locale,msgid('Renewal and validation'),`${field('ssl-renew-before',locale,msgid('Renew before expiry'))}${checks(locale,[msgid('Use the CA renewal window (ARI)')])}${radios('ssl-challenge',locale,[msgid('HTTP validation'),msgid('DNS validation')])}`)}${actions(locale,msgid('Save settings'),msgid('Discard'))}`),
  card('ssl-host',locale,msgid('Panel hostname certificate'),`${table(locale,[msgid('Hostname'),msgid('Issuer'),msgid('Expires'),msgid('Status')],msgid('The panel certificate has not been read.'))}${actions(locale,msgid('Renew now'),msgid('Upload a certificate'))}`),
  card('ssl-list',locale,msgid('Certificates'),`${tabs(locale,msgid('Certificate filter'),[msgid('All'),msgid('Valid'),msgid('Renewal due'),msgctxt('board-canvas', 'Failed')])}${table(locale,[msgid('Certificate'),msgid('Account'),msgid('Issuer'),msgid('Expires'),msgid('Status')],msgid('Certificates have not been read.'))}`),
  card('ssl-queue',locale,msgid('Renewal queue'),`${table(locale,[msgid('Certificate'),msgid('When'),msgid('State')],msgid('The renewal queue has not been read.'))}${soonBtn(locale,msgid('Queue renewal'),true)}`),
  card('ssl-log',locale,msgid('Renewal log'),table(locale,[msgid('When'),msgid('Certificate'),msgid('Result')],msgid('The renewal log has not been read.'))),
].join(''))

const web = (locale: Locale): string => region('/whm/services/web', locale, [
  card('web-engine',locale,msgid('Engine'),`${radios('web-engine',locale,[msgid('Apache with mpm-itk'),'OpenLiteSpeed'])}<p class="xp-help">${h(tx(locale,msgid('The engine and its installed package state have not been read. An engine change applies to every site.')))}</p>`),
  card('web-mpm',locale,'Apache MPM',`${radios('web-mpm',locale,['itk','prefork'])}${empty(locale,msgid('The active MPM has not been read.'))}`),
  card('web-backend',locale,msgid('Backend connection'),`${fields(locale,'web-backend',[msgid('Backend address'),msgid('Backend port')])}${code('')}`),
  card('web-edge',locale,msgid('Nginx edge'),`${soonBtn(locale,msgid('Use suggested values'),true)}${legend(locale,msgid('Workers'),fields(locale,'web-nginx',['worker_processes','worker_connections','worker_rlimit_nofile']))}${legend(locale,msgid('Requests and cache'),fields(locale,'web-request',['keepalive_timeout','client_max_body_size']))}`),
  card('web-workers',locale,msgid('Apache workers'),`${legend(locale,msgid('Spare children'),fields(locale,'web-apache-spare',['StartServers','MinSpareServers','MaxSpareServers']))}${legend(locale,msgid('Limits'),fields(locale,'web-apache-limit',['MaxRequestWorkers','ServerLimit','MaxConnectionsPerChild']))}`),
  card('web-pending',locale,msgid('Pending change'),`${table(locale,[msgid('Setting'),msgid('Current'),msgid('Candidate')],msgid('No candidate configuration has been read or tested.'))}${actions(locale,msgid('Test and apply'),msgid('Discard changes'))}`),
  card('web-generations',locale,msgid('Generations'),`${table(locale,[msgid('Generation'),msgid('When'),msgid('Result')],msgid('Generation history has not been read.'))}${soonBtn(locale,msgid('Restore selected generation'),true)}`),
].join(''))

const whmPhp = (locale: Locale): string => region('/whm/software/php', locale, [
  card('whm-php-versions',locale,msgid('Installed versions'),`${table(locale,[msgid('Version'),msgid('Domains'),msgid('Support'),msgid('State')],msgid('Installed PHP versions have not been read.'))}${actions(locale,msgid('Install another version'),msgid('Set selected version as default'))}`),
  card('whm-php-handlers',locale,msgid('Handlers'),table(locale,[msgid('Handler'),msgid('Version'),msgid('Engine'),msgid('Availability')],msgid('Installed handlers have not been read.'))),
  card('whm-php-config',locale,msgid('Configure a version'),`${select('whm-php-version',locale,msgid('PHP version'),[msgid('Versions not read')])}${legend(locale,msgctxt('board-canvas', 'Extensions'),table(locale,[msgid('Extension'),msgid('State')],msgid('Extensions have not been read for a selected version.')))}${tabs(locale,msgid('Global php.ini editor'),[msgid('Common settings'),msgid('Edit file')])}${fields(locale,'whm-php-ini',['memory_limit','upload_max_filesize','post_max_size','max_execution_time','max_input_vars'])}${textarea('whm-php-file',locale,msgid('File contents'),10)}${actions(locale,msgid('Test and apply'),msgid('Discard'))}`),
  card('whm-php-danger',locale,msgid('Dangerous functions'),`${table(locale,[msgid('Function'),msgid('Default policy')],msgid('The function policy has not been read.'))}${legend(locale,msgid('New exception'),`${field('php-exception-account',locale,msgid('Account'))}${field('php-exception-reason',locale,msgid('Reason'))}${checks(locale,['exec','shell_exec','system','passthru','proc_open','popen'])}`)}${soonBtn(locale,msgid('Grant exception'),true)}`),
].join(''))

const advisor = (locale: Locale): string => region('/whm/security', locale, [
  anchors(locale,[['sec-access',msgid('Access')],['sec-tfa',msgid('Two-factor')],['sec-lock',msgid('Sign-in lockout')],['sec-tokens',msgid('API tokens')],['sec-php',msgid('PHP functions')],['sec-compiler',msgid('Compiler lock')]]),
  card('sec-access',locale,msgid('Access'),`${fields(locale,'sec-access',[msgid('Panel port'),msgid('Secret entrance path')])}${soonBtn(locale,msgid('Regenerate entrance path'),true)}${legend(locale,msgid('IP allowlist for xWHM sign-in'),textarea('sec-ip-allowlist',locale,msgid('Addresses and ranges, one per line')))}`),
  card('sec-tfa',locale,msgid('Two-factor for root'),`${empty(locale,msgid('The stored factor state has not been read. Enrollment is optional.'))}${actions(locale,msgid('Generate new recovery codes'),msgid('Reset authenticator'))}`),
  card('sec-lock',locale,msgid('Sign-in lockout'),fields(locale,'sec-lockout',[msgid('Failures'),msgctxt('board-canvas', 'Within, minutes'),msgid('Lock for, minutes')])),
  card('sec-locked',locale,msgid('Locked right now'),table(locale,[msgid('Account'),msgid('Address'),msgid('Until')],msgid('The active lockout list has not been read.'))),
  card('sec-tokens',locale,msgid('API tokens'),`${table(locale,[msgid('Token name'),msgid('Scope'),msgid('Last used'),msgid('State')],msgid('Token metadata has not been read.'))}${fields(locale,'sec-token',[msgid('Token name'),msgid('Allowed address ranges')])}${soonBtn(locale,msgid('Create API token'),true)}`),
  card('sec-deny',locale,msgid('Request limits and deny lists'),`${fields(locale,'sec-request',[msgid('Largest request body'),msgid('Answer for denied requests')])}${textarea('sec-addresses',locale,msgid('Addresses and ranges'))}${textarea('sec-paths',locale,msgid('Path patterns'))}${textarea('sec-agents',locale,msgid('User-agent patterns'))}`),
  card('sec-php',locale,msgid('Dangerous PHP functions'),`${table(locale,[msgid('Function'),msgid('Policy')],msgid('The function policy has not been read.'))}${soonBtn(locale,msgid('Add exception'),true)}`),
  card('sec-compiler',locale,msgid('Compiler lock'),`${table(locale,[msgid('Account'),msgid('Exception')],msgid('Compiler access and exceptions have not been read.'))}${soonBtn(locale,msgid('Add account'),true)}`),
  actions(locale,msgid('Save and apply'),msgid('Discard changes')),
].join(''))

const ssh = (locale: Locale): string => region('/whm/security/ssh', locale, [
  stats(locale,[[msgid('Service'),notRead],[msgid('Version'),notRead],[msgid('Open sessions'),notRead]]),
  card('ssh-settings',locale,msgid('Sign-in settings'),`${field('ssh-port',locale,msgid('Port'))}${legend(locale,msgid('User authentication'),radios('ssh-auth',locale,[msgid('Keys only'),msgid('Keys and password')]))}${legend(locale,msgid('Root sign-in'),radios('ssh-root',locale,[msgid('Keys only'),msgid('Not allowed'),msgid('Keys and password')]))}${actions(locale,msgid('Test and reload sshd'),msgid('Discard changes'))}`),
  card('ssh-effective',locale,msgid('Effective config'),`${empty(locale,msgid('The effective configuration has not been read.'))}${code('')}`),
  card('ssh-keys',locale,msgid('Authorized keys for root'),`${table(locale,[msgid('Fingerprint'),msgid('Type'),msgid('Comment')],msgid('Authorized key metadata has not been read.'))}${textarea('ssh-new-key',locale,msgid('Add a public key'),4)}${soonBtn(locale,msgid('Add key'),true)}`),
  card('ssh-failed',locale,msgid('Failed sign-ins'),`${select('ssh-failed-range',locale,msgid('Show'),[msgid('Last 24 hours'),msgid('Last 7 days')])}${table(locale,[msgid('Address'),msgid('User'),msgid('When')],msgid('Failed sign-in observations have not been read.'))}`),
  card('ssh-autoban',locale,msgid('Auto-ban rule'),`${checks(locale,[msgid('Enable the SSH auto-ban rule')])}${fields(locale,'ssh-autoban',[msgid('Failures'),msgctxt('board-canvas', 'Within, minutes'),msgid('Ban for')])}`),
  card('ssh-banned',locale,msgid('Banned by SSH'),`${table(locale,[msgid('Address'),msgid('Since'),msgid('Until')],msgid('The SSH ban list has not been read.'))}${soonBtn(locale,msgid('Unban selected address'),true)}`),
].join(''))

const backups = (locale: Locale): string => region('/whm/backups', locale, [
  stats(locale,[[msgctxt('board-canvas', 'Last run'),notRead],[msgctxt('board-canvas', 'Next run'),notRead],[msgid('Local copy'),notRead],[msgid('Remote copy'),notRead]]),
  card('bak-runs',locale,msgid('Runs'),`${table(locale,[msgid('Started'),msgid('Type'),msgid('Accounts'),msgid('Size'),msgid('Status')],msgid('Backup runs have not been read.'))}${soonBtn(locale,msgid('Run backup now'))}`),
  card('bak-restore',locale,msgctxt('board-canvas', 'Restore'),`${steps(locale,[msgid('Run'),msgid('Account'),msgid('Difference'),msgctxt('board-canvas', 'Restore')])}${select('bak-restore-run',locale,msgid('Backup run'),[msgid('Runs not read')])}${select('bak-restore-account',locale,msgid('Account'),[msgid('Accounts not read')])}${legend(locale,msgid('Parts to restore'),checks(locale,[msgid('Home files'),msgid('Databases'),msgid('Mail'),msgid('DNS zone')]))}${table(locale,[msgid('Path or record'),msgid('Current'),msgid('Backup'),msgid('Action')],msgid('No backup and account have been compared.'))}${actions(locale,msgid('Restore selected account'),msgid('Back'))}`),
  note(locale,msgid('What a restore does'),msgid('A restore must show the exact account-bound difference before applying changes. Newer data must be preserved before a rollback.')),
  card('bak-config',locale,msgid('Configuration'),`${legend(locale,msgid('Schedule'),fields(locale,'bak-schedule',[msgid('Frequency'),msgid('Start time')]))}${legend(locale,msgid('Retention'),fields(locale,'bak-retention',[msgid('Daily copies'),msgid('Weekly copies')]))}${legend(locale,msgctxt('board-canvas', 'What to include'),checks(locale,[msgid('Home directories'),msgid('Databases'),msgid('Mail'),msgid('DNS zones'),msgid('Control database snapshot')]))}${legend(locale,msgid('Local destination'),field('bak-local-path',locale,msgid('Path')))}${legend(locale,msgid('Remote SFTP'),`${fields(locale,'bak-sftp',[msgid('Host'),msgid('Port'),msgid('User'),msgid('Remote path'),msgid('Private key file on this server')])}${soonBtn(locale,msgid('Test connection'),true)}`)}${legend(locale,msgid('Accounts'),`${radios('bak-account-selection',locale,[msgid('All accounts'),msgid('Selected accounts')])}${table(locale,[msgid('Account'),msgid('Primary domain')],msgid('Account selections have not been read.'))}`)}${actions(locale,msgid('Save configuration'),msgid('Discard changes'))}`),
].join(''))

const canvases: Readonly<Record<string, (locale: Locale) => string>> = {
  '/files/backup': backup,
  '/files/directory-privacy': privacy,
  '/software/php': panelPhp,
  '/software/htaccess': htaccess,
  '/advanced/cron': cron,
  '/whm/server/setup': setup,
  '/whm/plans/features': features,
  '/whm/domains': whmDomains,
  '/whm/dns': dns,
  '/whm/ssl': whmSsl,
  '/whm/services/web': web,
  '/whm/software/php': whmPhp,
  '/whm/security': advisor,
  '/whm/security/ssh': ssh,
  '/whm/backups': backups,
}

/** Board body for an unwired route. Foundations keep their own specimen renderer. */
export const renderBoardCanvas = (route: string, locale: Locale): string => canvases[route]?.(locale) ?? ''

const fact = (locale: Locale, label: Copy, value: string): string =>
  `<div class="xp-fact"><dt style="color:var(--xp-text-secondary)">${h(tx(locale, label))}</dt><dd><bdi dir="ltr">${h(value)}</bdi></dd></div>`

export interface ResourceLimitRow {
  readonly label: Copy
  readonly plan: string
}

const limitText = (value: Limit, suffix: string): string => (value === 'unlimited' ? 'unlimited' : `${value} ${suffix}`)

export const resourceRowsFromPlan = (resources: {
  diskMb: Limit
  bandwidthMbMonth: Limit
  cpuPercent: Limit
  memoryMb: Limit
  maxProcesses: Limit
  ioReadBps: Limit
  ioWriteBps: Limit
} | null): ResourceLimitRow[] => {
  if (!resources) {
    const blank = '—'
    return [
      { label: msgid('Disk'), plan: blank },
      { label: msgid('Bandwidth / month'), plan: blank },
      { label: msgid('CPU'), plan: blank },
      { label: msgid('Memory'), plan: blank },
      { label: msgid('Processes'), plan: blank },
      { label: msgid('Disk read'), plan: blank },
      { label: msgid('Disk write'), plan: blank },
    ]
  }
  return [
    { label: msgid('Disk'), plan: limitText(resources.diskMb, 'MB') },
    { label: msgid('Bandwidth / month'), plan: limitText(resources.bandwidthMbMonth, 'MB') },
    { label: msgid('CPU'), plan: limitText(resources.cpuPercent, '%') },
    { label: msgid('Memory'), plan: limitText(resources.memoryMb, 'MB') },
    { label: msgid('Processes'), plan: limitText(resources.maxProcesses, '') },
    { label: msgid('Disk read'), plan: limitText(resources.ioReadBps, 'B/s') },
    { label: msgid('Disk write'), plan: limitText(resources.ioWriteBps, 'B/s') },
  ]
}

/** Resources board. Plan values are the stored plan. Live usage stays empty until the host reports it. */
export const renderAccountResources = (locale: Locale, uid: number, rows: readonly ResourceLimitRow[]): string => {
  const applied = tx(locale, unavailable)
  const live = tx(locale, msgid('No reading yet'))
  return `<section class="xp-board-canvas" data-section="slice-resources" data-board-layout="/resources" aria-labelledby="xpanel-resources-heading">
    <style>[data-section="slice-resources"] #xpanel-resources-heading{font-size:var(--xp-type-page)!important;line-height:var(--xp-leading-page)!important}</style>
    <header class="xp-board-head">
      <div>
        <h1 id="xpanel-resources-heading" class="xp-page-title">${h(tx(locale, msgid('Resources & quotas')))}</h1>
        <p class="xp-prose xp-design-page__lede">${h(tx(locale, msgid('What this plan allows, what this host applies to the slice, and what is in use right now.')))}</p>
      </div>
      ${soonBtn(locale, msgid('Refresh live values'), true)}
    </header>
    <p class="xp-prose" id="xp-board-unavailable-reason" role="status" data-resource-metrics="unavailable">${h(tx(locale, msgid('Resource measurements are not available yet. The plan limits below are still the stored values.')))}</p>
    <section class="xp-board-section" aria-labelledby="slice-title">
      <header class="xp-board-section__head"><h2 id="slice-title"><bdi dir="ltr">xpanel-${uid}.slice</bdi></h2></header>
      <dl class="xp-board-dl">
        ${fact(locale, msgid('Identity'), `uid ${uid}`)}
        ${fact(locale, msgid('cgroup path'), `/sys/fs/cgroup/xpanel.slice/xpanel-${uid}.slice`)}
      </dl>
    </section>
    <section class="xp-board-section" aria-labelledby="limits-title">
      <header class="xp-board-section__head"><h2 id="limits-title">${h(tx(locale, msgid('Limits on your slice')))}</h2></header>
      <div class="xp-table-wrap"><table class="xp-table"><thead><tr>
        <th>${h(tx(locale, msgid('Limit')))}</th>
        <th>${h(tx(locale, msgid('Plan value')))}</th>
        <th>${h(tx(locale, msgid('Applied on host')))}</th>
        <th>${h(tx(locale, msgid('Live usage')))}</th>
      </tr></thead><tbody>
        ${rows.map(row => `<tr><th scope="row">${h(tx(locale, row.label))}</th><td><bdi dir="ltr">${h(row.plan)}</bdi></td><td>${h(applied)}</td><td>${h(live)}</td></tr>`).join('')}
      </tbody></table></div>
    </section>
    <section class="xp-board-section" aria-labelledby="io-title">
      <header class="xp-board-section__head"><h2 id="io-title">${h(tx(locale, msgid('Disk IO, last hour')))}</h2></header>
      <div class="xp-board-section__body">${empty(locale, msgid('No IO sample yet'))}</div>
    </section>
    <section class="xp-board-section" aria-labelledby="procs-title">
      <header class="xp-board-section__head"><h2 id="procs-title">${h(tx(locale, msgid('Processes in your slice')))}</h2></header>
      <div class="xp-board-section__body">${table(locale, ['PID', msgid('Command')], msgid('No processes reported.'))}</div>
    </section>
  </section>`
}
