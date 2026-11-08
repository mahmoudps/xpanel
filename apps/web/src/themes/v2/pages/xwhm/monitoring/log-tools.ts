import type { Translate } from '../../../../../i18n.ts'
import { actions, button, esc, field, fields, help, section, select, status, table } from './common.ts'

const fact = (t: Translate, key: string, label: string): string => `<div><dt>${esc(t(label))}</dt><dd><bdi dir="ltr" data-log-tools-fact="${key}">${esc(t(msgid('Not read')))}</bdi></dd></div>`

/** Access log security analysis, MariaDB logs and the raw FTP log; whm-log-tools-client.ts owns the behaviour. */
export function renderV2WhmLogTools(t: Translate, canRead: boolean): string {
  const denied = msgid('Log tools require an authorized root administrator.')
  const line = (hooks: Record<string, boolean>, unread: string): string => status(t, canRead ? unread : denied, hooks, canRead ? 'unread' : 'unavailable')
  const analysis = section(t, 'log-analysis', msgid('Access log security analysis'), help(t, msgid('Scans the latest part of one site access log for injection, traversal, webshell and scanner patterns. Nothing is blocked, and a match is a request that was attempted, not proof of a break-in.'))
    + fields(field(t, 'v2-log-analysis-site', msgid('Site'), select(t, 'v2-log-analysis-site', { 'data-log-analysis-site': true }, [], canRead)))
    + actions(button(t, msgid('Run analysis'), { 'data-log-analysis-run': true }, canRead)) + line({ 'data-log-analysis-status': true }, msgid('No site has been analysed.'))
    + `<dl class="v2-observation__facts">${fact(t, 'requests', msgid('Requests scanned'))}${fact(t, 'flagged', msgid('Requests flagged'))}${fact(t, 'scanned', msgid('Log scanned'))}${fact(t, 'observed', msgid('Observed at (UTC)'))}</dl>`
    + table(t, msgid('Findings by type'), [msgid('Type'), msgid('Requests'), msgid('Clients')], { 'data-log-analysis-rows': true }, msgid('No analysis has run.'), [1, 2])
    + table(t, msgid('Sample requests'), [msgid('Type'), msgid('Time'), msgid('Client'), msgid('Request'), msgid('Status')], { 'data-log-analysis-samples': true }, msgid('No analysis has run.'), [4]))
  const database = section(t, 'database-logs', msgid('Database logs'), help(t, msgid('The MariaDB slow query log and error log at the paths the running server reports. Statements appear as MariaDB recorded them.'))
    + fields(field(t, 'v2-database-log-kind', msgid('Log'), select(t, 'v2-database-log-kind', { 'data-database-log-kind': true }, [['slow', msgid('Slow query log')], ['error', msgid('Error log')]], canRead)))
    + actions(button(t, msgid('Read log'), { 'data-database-log-read': true }, canRead)) + line({ 'data-database-log-status': true }, msgid('The database log has not been read.'))
    + `<dl class="v2-observation__facts">${fact(t, 'recording', msgid('Slow query recording'))}${fact(t, 'threshold', msgid('Slow query threshold'))}${fact(t, 'source', msgid('Source'))}</dl>`
    + `<div data-database-log-panel="slow">${table(t, msgid('Slow queries, newest first'), [msgid('Time (UTC)'), msgid('Seconds'), msgid('User'), msgid('Database'), msgid('Rows examined'), msgid('Statement')], { 'data-database-log-rows': 'slow' }, msgid('The database log has not been read.'), [1, 4])}</div>`
    + `<div data-database-log-panel="error" hidden>${table(t, msgid('Error log, newest first'), [msgid('Time'), msgid('Level'), msgid('Message')], { 'data-database-log-rows': 'error' }, msgid('The database log has not been read.'))}</div>`)
  const ranges = [['1', msgid('Last hour')], ['6', msgid('Last 6 hours')], ['24', msgid('Last 24 hours')], ['72', msgid('Last 3 days')], ['168', msgid('Last 7 days')]] as const
  const raw = section(t, 'raw-ftp-log', msgid('Raw FTP log'), help(t, msgid('A gzip of plain text with the FTP sign-ins and transfers of one domain, cut from the service journal. Connections made before a sign-in name no domain, so they are left out.'))
    + fields(field(t, 'v2-raw-ftp-domain', msgid('Domain'), select(t, 'v2-raw-ftp-domain', { 'data-raw-ftp-domain': true }, [], canRead)) + field(t, 'v2-raw-ftp-hours', msgid('Time range'), select(t, 'v2-raw-ftp-hours', { 'data-raw-ftp-hours': true }, ranges, canRead).replace('value="24"', 'value="24" selected')))
    + actions(button(t, msgid('Download log'), { 'data-raw-ftp-download': true }, canRead)) + line({ 'data-raw-ftp-status': true }, msgid('Nothing has been downloaded.')))
  return `<div class="v2-observation__groups" data-whm-log-tools data-log-tools-can-read="${canRead}">${analysis}${database}${raw}</div>`
}
