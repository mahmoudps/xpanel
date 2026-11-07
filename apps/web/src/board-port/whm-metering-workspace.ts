import { localeDirection, translator, type Locale } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

export interface WhmMeteringPageInput { locale: Locale; canRead: boolean; canReset?: boolean; canRelieve?: boolean }
type Copy = string

const STYLE = `<style>.xp-whm-metering{display:flex;flex-direction:column;gap:32px;min-inline-size:0}.xp-whm-metering :is(h2,p,dl,dd){margin:0}.xp-whm-metering td[data-numeric],.xp-whm-metering th[data-numeric]{text-align:end;font-variant-numeric:tabular-nums;white-space:nowrap}.xp-whm-metering td{overflow-wrap:anywhere}.xp-whm-metering [data-level="warn"]{color:var(--xp-warning-text,#b54708)}.xp-whm-metering [data-level="critical"]{color:var(--xp-danger-text,#b42318)}.xp-whm-metering__table--io{min-inline-size:56rem}.xp-whm-metering__table--devices{min-inline-size:32rem}.xp-whm-metering__table--bandwidth{min-inline-size:64rem}</style>`

const helpers = (locale: Locale) => {
  const t = (copy: Copy): string => escapeHtml(translator(locale)(copy))
  const card = (key: string, title: Copy, body: string): string => `<section class="xp-whm-detail-card" aria-labelledby="whm-metering-${key}"><h2 id="whm-metering-${key}">${t(title)}</h2>${body}</section>`
  const facts = (rows: readonly (readonly [string, Copy])[]): string => `<dl class="xp-whm-detail-fields">${rows.map(([key, label]) => `<div class="xp-whm-detail-field"><dt>${t(label)}</dt><dd><bdi dir="ltr" data-whm-metering-fact="${key}">${t(msgid('Not read'))}</bdi></dd></div>`).join('')}</dl>`
  const table = (kind: string, label: Copy, headers: readonly (readonly [Copy, boolean?])[], empty: Copy): string => `<div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t(label)}"><table class="xp-whm-detail-table xp-table xp-whm-metering__table--${kind}"><caption class="xp-sr-only">${t(label)}</caption><thead><tr>${headers.map(([header, numeric]) => `<th scope="col"${numeric ? ' data-numeric' : ''}>${t(header)}</th>`).join('')}</tr></thead><tbody data-whm-metering-rows="${kind}"><tr><td colspan="${headers.length}">${t(empty)}</td></tr></tbody></table></div>`
  const controls = (button: Copy, unread: Copy, enabled: boolean): string => `<div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-whm-metering-refresh${enabled ? '' : ' disabled'}>${t(button)}</button></div><p class="xp-whm-detail-status" data-whm-metering-status data-state="${enabled ? 'unread' : 'unavailable'}" role="status">${t(enabled ? unread : msgid('Metering requires an authorized root administrator on a qualified host.'))}</p>`
  return { t, card, facts, table, controls }
}
const page = (kind: 'io' | 'bandwidth' | 'log-retention', input: WhmMeteringPageInput, body: string): string =>
  `<div class="xp-whm-metering" data-whm-metering="${kind}" data-metering-can-read="${input.canRead}"${kind === 'bandwidth' ? ` data-bandwidth-can-reset="${input.canReset === true}" data-bandwidth-can-relieve="${input.canRelieve === true}"` : ''} lang="${input.locale}" dir="${localeDirection(input.locale)}">${STYLE}${body}</div>`

/** /whm/monitoring/io: the latest cached per-account cgroup sample with plan limits, and disk latency from the host collector. No history is recorded. */
export function renderWhmIoWorkspace(input: WhmMeteringPageInput): string {
  const h = helpers(input.locale)
  return page('io', input, h.card('usage', msgid('Resource usage'), `<p class="xp-help">${h.t(msgid('Account resources and configured limits.'))}</p>`
    + h.controls(msgid('Read resources'), msgid('Resource usage has not been read.'), input.canRead)
    + h.facts([['observed', msgid('Sampled at (UTC)')], ['read', msgid('Account read total')], ['write', msgid('Account write total')], ['iops', msgid('Account IOPS total')], ['latency', msgid('Disk latency')], ['pressure', msgid('IO pressure')], ['host', msgid('Host CPU and memory')]]))
    + h.card('history', msgid('Read and write history'), `<p class="xp-help">${h.t(msgid('Account IO history is not recorded. Each read shows the latest sample; host history is in Performance history.'))}</p><a class="xp-btn" href="/whm/monitoring/performance">${h.t(msgid('Open performance history'))}</a>`)
    + h.card('devices', msgid('Disk devices'), `<p class="xp-help">${h.t(msgid('Average wait per completed operation and busy time over the last host sample interval, from /proc/diskstats.'))}</p>`
      + h.table('devices', msgid('Disk devices'), [[msgid('Device')], [msgid('Read wait'), true], [msgid('Write wait'), true], [msgid('Busy'), true]], msgid('No disk devices have been read.')))
    + h.card('accounts', msgid('Account resources'), `<p class="xp-help" data-whm-metering-count>${h.t(msgid('Not read'))}</p>`
      + h.table('io', msgid('Account resources'), [[msgid('Account')], [msgid('Read / write'), true], ['IOPS', true], [msgid('Memory'), true], [msgid('CPU (% of 1 core)'), true], [msgid('Processes'), true]], msgid('No account resources have been read.'))))
}

/** /whm/accounts/bandwidth: this UTC month's web, mail and FTP traffic per account against the plan's monthly limit. */
export function renderWhmBandwidthWorkspace(input: WhmMeteringPageInput): string {
  const h = helpers(input.locale)
  return page('bandwidth', input, h.card('bandwidth', msgid('Bandwidth per account'), `<p class="xp-help">${h.t(msgid('Traffic this month (UTC), counted from the saved site access logs, the Postfix delivery journal and the FTP transfer journal. Each source is sent plus received bytes.'))}</p>`
    + `<p class="xp-help">${h.t(msgid('A plan with bandwidth enforcement on serves a bandwidth-exceeded page on its websites once the monthly limit is used, until the next month (UTC) or until the limit is raised. Mail, FTP and the panels keep working. Other plans are only compared.'))}</p>`
    + h.controls(msgid('Read bandwidth'), msgid('Bandwidth has not been read.'), input.canRead)
    + h.facts([['month', msgid('Month (UTC)')], ['since', msgid('Counted since (UTC)')], ['updated', msgid('Last counted (UTC)')], ['pending', msgid('Log data not yet counted')], ['web', msgid('Web logs')], ['mail', msgid('Mail journal')], ['ftp', msgid('FTP journal')]])
    + h.table('bandwidth', msgid('Bandwidth per account'), [[msgid('Account')], [msgid('Domain')], [msgid('Status')], [msgid('Web'), true], [msgid('Mail'), true], ['FTP', true], [msgid('Total'), true], [msgid('Plan limit'), true]], msgid('No bandwidth has been read.')))
    + h.card('relief', msgid('Unsuspend bandwidth exceeders'), `<p class="xp-help">${h.t(msgid('Lifts the bandwidth-exceeded page of every account limited this month until 00:00 UTC. From the next UTC day each one is evaluated again and limited if it is still over its limit.'))}</p>`
      + `<div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-whm-bandwidth-relief disabled>${h.t(msgid('Unsuspend bandwidth exceeders'))}</button></div>`
      + `<p class="xp-whm-detail-status" data-whm-bandwidth-relief-status data-state="${input.canRelieve ? 'unread' : 'unavailable'}" role="status"${input.canRelieve ? ' hidden' : ''}>${input.canRelieve ? '' : h.t(msgid('Lifting limit pages requires root on a host that qualifies this tool.'))}</p>`)
    + h.card('custom', msgid('Custom bandwidth limits'), `<p class="xp-help">${h.t(msgid('Accounts whose monthly bandwidth limit differs from their package. Reset returns an account to its package limit; a custom limit is set in the account details.'))}</p>`
      + h.table('custom', msgid('Custom bandwidth limits'), [[msgid('Account')], [msgid('Domain')], [msgid('Plan')], [msgid('Custom limit'), true], [msgid('Package limit'), true], [msgid('Actions')]], input.canReset ? msgid('Custom limits have not been read.') : msgid('Resetting custom limits requires root on a host that qualifies this tool.'))
      + `<p class="xp-whm-detail-status" data-whm-bandwidth-custom-status data-state="unread" role="status" hidden></p>`))
}

const QUOTA_STYLE = `<style>.xp-whm-quotas__filters{display:grid;grid-template-columns:2fr repeat(2,minmax(0,1fr));gap:16px}.xp-whm-quotas__pager{display:flex;flex-wrap:wrap;gap:16px;align-items:center}.xp-whm-quotas td small{display:block;color:var(--xp-text-secondary,#344054)}.xp-whm-quotas th button{all:unset;cursor:pointer;font-weight:600;min-block-size:44px}.xp-whm-quotas th button:focus-visible{outline:2px solid var(--xp-accent,#1d5bd6);outline-offset:2px}.xp-whm-quotas td[data-quota-cell=change]{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.xp-whm-quotas td[data-quota-cell=change] input[type=text]{inline-size:8rem;min-block-size:44px}.xp-whm-quotas__table{min-inline-size:48rem}
@media(max-width:600px){.xp-whm-quotas__filters{grid-template-columns:minmax(0,1fr)}.xp-whm-quotas__table{min-inline-size:0}.xp-whm-quotas__table thead{display:none}.xp-whm-quotas__table tr{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px 16px;padding:16px 0}.xp-whm-quotas__table td{padding:0}.xp-whm-quotas__table td[data-quota-cell=account]{grid-row:span 2}.xp-whm-quotas__table td[data-quota-cell=owner]{display:none}.xp-whm-quotas__table td[data-quota-cell=change]{grid-column:1/-1}}</style>`

/** /whm/accounts/health (WHM Quota Modification): every visible account's disk limit in force with its source, paged by the server. */
export function renderWhmDiskQuotaWorkspace(input: { locale: Locale; canRead: boolean; canEdit: boolean; owners?: readonly { id: string; username: string }[] }): string {
  const h = helpers(input.locale), off = input.canRead ? '' : ' disabled'
  const sort = (key: string, label: Copy, numeric = false): string => `<th scope="col" aria-sort="none"${numeric ? ' data-numeric' : ''}><button type="button" data-quotas-sort="${key}"${off}>${h.t(label)}</button></th>`
  const owners = input.owners ? [`<option value="root">root</option>`, ...input.owners.map(owner => `<option value="${escapeHtml(owner.id)}">${escapeHtml(owner.username)}</option>`)].join('') : ''
  return `<div class="xp-whm-metering xp-whm-quotas" data-whm-quotas data-quotas-can-read="${input.canRead}" data-quotas-can-edit="${input.canRead && input.canEdit}" lang="${input.locale}" dir="${localeDirection(input.locale)}">${STYLE}${QUOTA_STYLE}`
    + h.card('quotas', msgid('Quota modification'), `<p class="xp-help">${h.t(msgid('The disk limit in force for each account: its package value or its own limit. A change is saved for that account only and applied to its filesystem quota by the host reconcile; changing the package replaces it.'))}</p>`
      + `<div class="xp-whm-quotas__filters"><div class="xp-whm-detail-field"><label for="whm-quotas-search">${h.t(msgid('Account or domain'))}</label><input id="whm-quotas-search" type="search" dir="ltr" maxlength="64" autocomplete="off" data-quotas-search${off}></div>`
      + `<div class="xp-whm-detail-field"><label for="whm-quotas-owner">${h.t(msgid('Owner'))}</label><select id="whm-quotas-owner" data-quotas-owner${off}><option value="">${h.t(msgid('All owners'))}</option>${owners}</select></div>`
      + `<div class="xp-whm-detail-field"><label for="whm-quotas-size">${h.t(msgid('Rows per page'))}</label><select id="whm-quotas-size" data-quotas-page-size${off}>${[10, 25, 50, 100].map(n => `<option value="${n}"${n === 25 ? ' selected' : ''}>${n}</option>`).join('')}</select></div></div>`
      + `<div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-quotas-refresh${off}>${h.t(msgid('Read disk quotas'))}</button></div>`
      + `<p class="xp-whm-detail-status" data-quotas-status data-state="${input.canRead ? 'unread' : 'unavailable'}" role="status">${h.t(input.canRead ? msgid('Disk quotas have not been read.') : msgid('Disk quotas require root or a reseller with the list-accounts privilege.'))}</p>`
      + `<p class="xp-help" data-quotas-usage></p>`
      + `<div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${h.t(msgid('Disk quotas'))}"><table class="xp-whm-detail-table xp-table xp-whm-quotas__table"><caption class="xp-sr-only">${h.t(msgid('Disk quotas'))}</caption><thead><tr>${sort('username', msgid('Account'))}${sort('owner', msgid('Owner'))}${sort('used', msgid('Disk used'), true)}${sort('limit', msgid('Disk limit in force'), true)}<th scope="col">${h.t(msgid('Change'))}</th></tr></thead><tbody data-quotas-rows><tr><td colspan="5">${h.t(msgid('Disk quotas have not been read.'))}</td></tr></tbody></table></div>`
      + `<nav class="xp-whm-quotas__pager" aria-label="${h.t(msgid('Disk quota pages'))}"><button type="button" class="xp-btn" data-quotas-previous disabled>${h.t(msgid('Previous'))}</button><span data-quotas-page></span><button type="button" class="xp-btn" data-quotas-next disabled>${h.t(msgid('Next'))}</button></nav>`)
    + `</div>`
}

/** /whm/monitoring/logs (WHM Raw NGINX / Raw Apache Log Download): the web servers' own logs, current and rotated, read-only. */
export function renderWhmRawServerLogsWorkspace(input: WhmMeteringPageInput): string {
  const h = helpers(input.locale), off = input.canRead ? '' : ' disabled'
  return `<div class="xp-whm-metering" data-whm-raw-logs data-raw-logs-can-read="${input.canRead}" lang="${input.locale}" dir="${localeDirection(input.locale)}">${STYLE}`
    + h.card('raw-logs', msgid('Raw web server logs'), `<p class="xp-help">${h.t(msgid("The web servers' own access and error logs, current and rotated, downloaded exactly as stored. Only the fixed log directories are read; files above the size bound are listed but not downloaded."))}</p>`
      + `<div class="xp-whm-detail-fields"><div class="xp-whm-detail-field"><label for="whm-raw-logs-server">${h.t(msgid('Web server'))}</label><select id="whm-raw-logs-server" data-raw-logs-server${off}><option value="nginx">nginx</option><option value="apache">Apache</option></select></div></div>`
      + `<div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-raw-logs-refresh${off}>${h.t(msgid('Read log list'))}</button></div>`
      + `<p class="xp-whm-detail-status" data-raw-logs-status data-state="${input.canRead ? 'unread' : 'unavailable'}" role="status">${h.t(input.canRead ? msgid('The log list has not been read.') : msgid('Raw web server logs require an authorized root administrator.'))}</p>`
      + `<div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${h.t(msgid('Raw web server logs'))}"><table class="xp-whm-detail-table xp-table"><caption class="xp-sr-only">${h.t(msgid('Raw web server logs'))}</caption><thead><tr><th scope="col">${h.t(msgid('File'))}</th><th scope="col" data-numeric>${h.t(msgid('Size'))}</th><th scope="col">${h.t(msgid('Modified (UTC)'))}</th><th scope="col">${h.t(msgid('Download'))}</th></tr></thead><tbody data-raw-logs-rows><tr><td colspan="4">${h.t(msgid('The log list has not been read.'))}</td></tr></tbody></table></div>`)
    + `</div>`
}

/** /whm/monitoring/logs (WHM Web Log Retention): each account's archive retention, the server defaults and the last rotation run. */
export function renderWhmLogRetentionWorkspace(input: WhmMeteringPageInput): string {
  const h = helpers(input.locale)
  return page('log-retention', input, h.card('log-retention', msgid('Web log retention'), `<p class="xp-help">${h.t(msgid('Each site access log is rotated once per UTC day after its traffic is counted, then kept as a gzip archive in the account ~/logs or deleted, as each account chooses on its Raw Access page or by the server default. Server error and backend logs rotate through logrotate.'))}</p>`
    + h.controls(msgid('Read log retention'), msgid('Log retention has not been read.'), input.canRead)
    + h.facts([['defaults', msgid('Server default')], ['panel', msgid('Server logs kept')], ['last-run', msgid('Last rotation (UTC)')], ['last-result', msgid('Last rotation result')], ['held', msgid('Undelivered archives')]])
    + h.table('pending', msgid('Archives waiting to be copied into ~/logs'), [[msgid('Account')], [msgid('Archives'), true], [msgid('Size'), true], [msgid('Oldest (UTC)')], [msgid('Reason')]], msgid('Log retention has not been read.'))
    + h.table('retention', msgid('Archive retention per account'), [[msgid('Account')], [msgid('Domain')], [msgid('Archive retention')], [msgid('Source')]], msgid('Log retention has not been read.'))
    + h.table('rotation-failures', msgid('Rotation failures'), [[msgid('Time (UTC)')], [msgid('Account')], [msgid('Site')], [msgid('Reason')]], msgid('Log retention has not been read.'))))
}
