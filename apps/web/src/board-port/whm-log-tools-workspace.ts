import { localeDirection, translator, type Locale } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'

const STYLE = '<style>.xp-whm-log-tools{display:flex;flex-direction:column;gap:32px;min-inline-size:0}.xp-whm-log-tools :is(h2,h3,p,dl,dd){margin:0}.xp-whm-log-tools td{overflow-wrap:anywhere}.xp-whm-log-tools :is(td,th)[data-numeric]{text-align:end;font-variant-numeric:tabular-nums}</style>'

/** /whm/monitoring/logs: access log security analysis, MariaDB slow and error logs, and the raw FTP log of one domain. */
export function renderWhmLogToolsWorkspace(input: { locale: Locale; canRead: boolean }): string {
  const translate = translator(input.locale), t = (copy: string): string => escapeHtml(translate(copy)), off = input.canRead ? '' : ' disabled'
  const card = (key: string, title: string, body: string): string => `<section class="xp-whm-detail-card" aria-labelledby="whm-log-tools-${key}"><h2 id="whm-log-tools-${key}">${t(title)}</h2>${body}</section>`
  const select = (id: string, label: string, hook: string, options: string): string => `<div class="xp-whm-detail-field"><label for="${id}">${t(label)}</label><select id="${id}" ${hook}${off}>${options}</select></div>`
  const status = (hook: string, unread: string): string => `<p class="xp-whm-detail-status" ${hook} data-state="${input.canRead ? 'unread' : 'unavailable'}" role="status">${t(input.canRead ? unread : msgid('Log tools require an authorized root administrator.'))}</p>`
  const button = (hook: string, label: string): string => `<div class="xp-whm-detail-actions"><button type="button" class="xp-btn" ${hook}${off}>${t(label)}</button></div>`
  const facts = (rows: readonly (readonly [string, string])[]): string => `<dl class="xp-whm-detail-fields">${rows.map(([key, label]) => `<div class="xp-whm-detail-field"><dt>${t(label)}</dt><dd><bdi dir="ltr" data-log-tools-fact="${key}">${t(msgid('Not read'))}</bdi></dd></div>`).join('')}</dl>`
  const table = (label: string, headers: readonly (readonly [string, boolean?])[], hook: string, empty: string): string => `<div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t(label)}"><table class="xp-whm-detail-table xp-table"><caption class="xp-sr-only">${t(label)}</caption><thead><tr>${headers.map(([head, numeric]) => `<th scope="col"${numeric ? ' data-numeric' : ''}>${t(head)}</th>`).join('')}</tr></thead><tbody ${hook}><tr><td colspan="${headers.length}">${t(empty)}</td></tr></tbody></table></div>`
  const hours = [['1', msgid('Last hour')], ['6', msgid('Last 6 hours')], ['24', msgid('Last 24 hours')], ['72', msgid('Last 3 days')], ['168', msgid('Last 7 days')]].map(([value, label]) => `<option value="${value}"${value === '24' ? ' selected' : ''}>${t(label!)}</option>`).join('')
  return `<div class="xp-whm-log-tools" data-whm-log-tools data-log-tools-can-read="${input.canRead}" lang="${input.locale}" dir="${localeDirection(input.locale)}">${STYLE}`
    + card('analysis', msgid('Access log security analysis'), `<p class="xp-help">${t(msgid('Scans the latest part of one site access log for injection, traversal, webshell and scanner patterns. Nothing is blocked, and a match is a request that was attempted, not proof of a break-in.'))}</p>`
      + `<div class="xp-whm-detail-fields">${select('whm-log-analysis-site', msgid('Site'), 'data-log-analysis-site', '')}</div>${button('data-log-analysis-run', msgid('Run analysis'))}${status('data-log-analysis-status', msgid('No site has been analysed.'))}`
      + facts([['requests', msgid('Requests scanned')], ['flagged', msgid('Requests flagged')], ['scanned', msgid('Log scanned')], ['observed', msgid('Observed at (UTC)')]])
      + table(msgid('Findings by type'), [[msgid('Type')], [msgid('Requests'), true], [msgid('Clients'), true]], 'data-log-analysis-rows', msgid('No analysis has run.'))
      + table(msgid('Sample requests'), [[msgid('Type')], [msgid('Time')], [msgid('Client')], [msgid('Request')], [msgid('Status'), true]], 'data-log-analysis-samples', msgid('No analysis has run.')))
    + card('database', msgid('Database logs'), `<p class="xp-help">${t(msgid('The MariaDB slow query log and error log at the paths the running server reports. Statements appear as MariaDB recorded them.'))}</p>`
      + `<div class="xp-whm-detail-fields">${select('whm-database-log-kind', msgid('Log'), 'data-database-log-kind', `<option value="slow">${t(msgid('Slow query log'))}</option><option value="error">${t(msgid('Error log'))}</option>`)}</div>${button('data-database-log-read', msgid('Read log'))}${status('data-database-log-status', msgid('The database log has not been read.'))}`
      + facts([['recording', msgid('Slow query recording')], ['threshold', msgid('Slow query threshold')], ['source', msgid('Source')]])
      + `<div data-database-log-panel="slow">${table(msgid('Slow queries, newest first'), [[msgid('Time (UTC)')], [msgid('Seconds'), true], [msgid('User')], [msgid('Database')], [msgid('Rows examined'), true], [msgid('Statement')]], 'data-database-log-rows="slow"', msgid('The database log has not been read.'))}</div>`
      + `<div data-database-log-panel="error" hidden>${table(msgid('Error log, newest first'), [[msgid('Time')], [msgid('Level')], [msgid('Message')]], 'data-database-log-rows="error"', msgid('The database log has not been read.'))}</div>`)
    + card('raw-ftp', msgid('Raw FTP log'), `<p class="xp-help">${t(msgid('A gzip of plain text with the FTP sign-ins and transfers of one domain, cut from the service journal. Connections made before a sign-in name no domain, so they are left out.'))}</p>`
      + `<div class="xp-whm-detail-fields">${select('whm-raw-ftp-domain', msgid('Domain'), 'data-raw-ftp-domain', '')}${select('whm-raw-ftp-hours', msgid('Time range'), 'data-raw-ftp-hours', hours)}</div>${button('data-raw-ftp-download', msgid('Download log'))}${status('data-raw-ftp-status', msgid('Nothing has been downloaded.'))}`)
    + `</div>`
}
