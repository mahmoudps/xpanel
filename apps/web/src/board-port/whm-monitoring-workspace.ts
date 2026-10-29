import { localeDirection, translator, type Locale } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'
import { MONITORING_LOG_DEFAULT_LINES, MONITORING_LOG_MAX_LINES, MONITORING_LOG_UNITS } from '../../../../packages/os/src/monitoring-command.ts'

export interface WhmMonitoringPageInput { locale: Locale; canRead: boolean }
type Copy = string

const STYLE = `<style>.xp-whm-monitoring{display:flex;flex-direction:column;gap:32px;min-inline-size:0}.xp-whm-monitoring :is(h2,h3,p,dl,dd,figure){margin:0}.xp-whm-monitoring td[data-numeric],.xp-whm-monitoring th[data-numeric]{text-align:end;font-variant-numeric:tabular-nums;white-space:nowrap}.xp-whm-monitoring [data-whm-monitoring-message]{white-space:pre-wrap;overflow-wrap:anywhere}.xp-whm-monitoring[dir="ltr"] [data-whm-monitoring-unit]{text-align:left}.xp-whm-monitoring[dir="rtl"] [data-whm-monitoring-unit]{text-align:right}.xp-whm-monitoring__charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:16px}.xp-whm-monitoring__chart{display:flex;flex-direction:column;gap:8px;min-inline-size:0;padding:16px;border:1px solid var(--xp-border,#e2e6ec);border-radius:8px}.xp-whm-monitoring__chart svg{display:block;inline-size:100%;block-size:120px;color:var(--xp-accent,#1d4ed8)}</style>`

const page = (kind: string, input: WhmMonitoringPageInput, body: string, extra = ''): string => {

  return `<div class="xp-whm-monitoring" data-whm-monitoring="${kind}" data-monitoring-can-read="${input.canRead}"${extra} lang="${input.locale}" dir="${localeDirection(input.locale)}">${STYLE}${body}</div>`
}
const helpers = (locale: Locale) => {
  const rtl = localeDirection(locale) === 'rtl'
  const t = (copy: Copy): string => escapeHtml(translator(locale)(copy))
  const card = (key: string, title: Copy, body: string): string => `<section class="xp-whm-detail-card" data-whm-monitoring-section="${key}" aria-labelledby="whm-monitoring-${key}"><h2 id="whm-monitoring-${key}">${t(title)}</h2>${body}</section>`
  const status = (copy: Copy, marker = 'status'): string => `<p class="xp-whm-detail-status" data-whm-monitoring-${marker} data-state="unread" role="status">${t(copy)}</p>`
  const refresh = (copy: Copy, enabled: boolean): string => `<div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-whm-monitoring-refresh${enabled ? '' : ' disabled'}>${t(copy)}</button></div>`
  const facts = (rows: readonly (readonly [string, Copy, boolean?])[]): string => `<dl class="xp-whm-detail-fields">${rows.map(([key, label, technical]) => `<div class="xp-whm-detail-field"><dt>${t(label)}</dt><dd>${technical ? `<bdi dir="ltr" data-whm-monitoring-${key}${key === 'observed-range' ? ' style="overflow-wrap: anywhere"' : ''}>` : `<span data-whm-monitoring-${key}>`}${t(msgid('Not read'))}${technical ? '</bdi>' : '</span>'}</dd></div>`).join('')}</dl>`
  const field = (id: string, label: Copy, control: string): string => `<div class="xp-whm-detail-field"><label for="${id}">${t(label)}</label>${control}</div>`
  const select = (id: string, marker: string, options: readonly (readonly [string, Copy])[], enabled: boolean, ltr = false): string => `<select id="${id}" data-whm-monitoring-${marker}${ltr ? ' dir="ltr"' : ''}${enabled ? '' : ' disabled'}>${options.map(([value, label]) => `<option value="${escapeHtml(value)}">${t(label)}</option>`).join('')}</select>`
  const table = (label: Copy, marker: string, headers: readonly (readonly [Copy, boolean?])[], empty: Copy): string => `<div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t(label)}"><table class="xp-whm-detail-table xp-table"><caption class="xp-sr-only">${t(label)}</caption><thead><tr>${headers.map(([header, numeric]) => `<th scope="col"${numeric ? ' data-numeric' : ''}>${t(header)}</th>`).join('')}</tr></thead><tbody data-whm-monitoring-${marker}><tr><td colspan="${headers.length}">${t(empty)}</td></tr></tbody></table></div>`
  const help = (copy: Copy): string => `<p class="xp-help">${t(copy)}</p>`
  return { card, status, refresh, facts, field, select, table, help }
}

/** /whm/monitoring/processes: bounded ps snapshot, client-side filter/sort, identity-bound TERM/KILL. */
export function renderWhmMonitoringProcesses(input: WhmMonitoringPageInput & { canSignal: boolean }): string {
  const h = helpers(input.locale), on = input.canRead
  const sorts = [['cpu', msgid('CPU, highest first')], ['memory', msgid('Memory, highest first')], ['elapsed', msgid('Running time, longest first')], ['pid', msgid('PID, ascending')]] as const
  return page('processes', input, h.card('process-list', msgid('Running processes'),
    h.help(msgid('Command arguments are not read, so secrets passed as arguments are never shown. Root, kernel, panel and core service processes cannot be signalled here.'))
    + h.refresh(msgid('Read processes'), on)
    + h.status(msgid('Processes have not been read.'))
    + h.facts([['observed-at', msgid('Observed at (UTC)'), true], ['total', msgid('Processes on the host'), true], ['shown', msgid('Rows shown'), true]])
    + `<div class="xp-whm-detail-fields">${h.field('whm-monitoring-process-search', msgid('Search PID, user or command'), `<input id="whm-monitoring-process-search" type="search" dir="ltr" data-whm-monitoring-search disabled>`)}${h.field('whm-monitoring-process-account', msgid('Account'), h.select('whm-monitoring-process-account', 'account', [['', msgid('All processes')], ['-', msgid('Not an account')]], false))}${h.field('whm-monitoring-process-sort', msgid('Sort'), h.select('whm-monitoring-process-sort', 'sort', sorts, false))}</div>`
    + h.table(msgid('Running processes'), 'rows', [['PID', true], [msgid('User')], [msgid('Account')], [msgid('CPU %'), true], [msgid('Memory %'), true], [msgid('Resident memory'), true], [msgid('Running time'), true], [msgid('State')], [msgid('Command')], [msgid('Action')]], msgid('No processes have been read.')))
    + h.card('process-accounts', msgid('By account'), h.help(msgid('Processes are grouped by the numeric user id of each saved account.'))
      + h.table(msgid('Processes by account'), 'account-rows', [[msgid('Account')], [msgid('Processes'), true], [msgid('CPU %'), true], [msgid('Resident memory'), true]], msgid('No account processes have been read.'))),
  ` data-monitoring-can-signal="${input.canRead && input.canSignal}"`)
}

/** /whm/monitoring/disk: df filesystems and inode tables plus quota-report home usage. Read-only. */
export function renderWhmMonitoringDisk(input: WhmMonitoringPageInput): string {
  const h = helpers(input.locale)
  return page('disk', input, h.card('filesystems', msgid('Filesystems'),
    h.refresh(msgid('Read disk usage'), input.canRead)
    + h.status(msgctxt('whm-monitoring-workspace', 'Disk usage has not been read.'))
    + h.facts([['observed-at', msgid('Observed at (UTC)'), true], ['inodes', msgid('Inode counts'), false]])
    + h.table(msgid('Filesystems'), 'rows', [[msgid('Mount point')], [msgid('Filesystem')], [msgid('Type')], [msgid('Size'), true], [msgid('Used'), true], [msgctxt('whm-monitoring-workspace', 'Available'), true], [msgid('Use'), true], [msgid('Inodes used'), true], [msgid('Inode use'), true]], msgid('No filesystems have been read.')))
    + h.card('account-homes', msgid('Account home usage'),
      h.help(msgid('Read from the user quota report of the filesystem that holds /home. Without enabled quotas, per-account usage stays unavailable; no directory scan is run.'))
      + h.status(msgid('Quota usage has not been read.'), 'quota-status')
      + h.facts([['quota-mount', msgctxt('whm-monitoring-workspace', 'Quota filesystem'), true]])
      + h.table(msgid('Account home usage'), 'quota-rows', [[msgid('Account')], [msgid('Used'), true], [msgid('Quota limit'), true], [msgid('Use'), true]], msgid('No account usage has been read.'))))
}

/** /whm/monitoring/logs: bounded journal read for a fixed unit allowlist. */
export function renderWhmMonitoringLogs(input: WhmMonitoringPageInput): string {
  const h = helpers(input.locale), on = input.canRead
  const tr = translator(input.locale)
  const priorities: readonly (readonly [string, Copy])[] = [['', msgid('Any priority')], ...[msgid('Emergency'), msgctxt('whm-monitoring-workspace', 'Alert'), msgid('Critical'), msgid('Error'), msgid('Warning'), msgid('Notice'), msgid('Info'), msgid('Debug')].map((priority, level) => [String(level), tr('{level} · {priority} and more severe', { level, priority: tr(priority) })] as const)]
  return page('logs', input, h.card('journal', msgid('System logs'),
    h.help(msgid('Reads the latest journal entries of one reviewed service unit. Messages are shown as recorded; each is limited to 4 KiB and the whole read to 1 MiB, with truncation marked.'))
    + `<div class="xp-whm-detail-fields">${h.field('whm-monitoring-log-unit', msgid('Service unit'), h.select('whm-monitoring-log-unit', 'unit', MONITORING_LOG_UNITS.map(unit => [unit, unit] as const), on, true))}${h.field('whm-monitoring-log-lines', msgid('Entries, 1 to 500'), `<input id="whm-monitoring-log-lines" type="number" inputmode="numeric" dir="ltr" min="1" max="${MONITORING_LOG_MAX_LINES}" step="1" value="${MONITORING_LOG_DEFAULT_LINES}" data-whm-monitoring-lines${on ? '' : ' disabled'}>`)}${h.field('whm-monitoring-log-since', msgid('Since, UTC (optional)'), `<input id="whm-monitoring-log-since" type="datetime-local" dir="ltr" data-whm-monitoring-since${on ? '' : ' disabled'}>`)}${h.field('whm-monitoring-log-priority', msgid('Priority'), h.select('whm-monitoring-log-priority', 'priority', priorities, on))}</div>`
    + h.refresh(msgid('Read logs'), on)
    + h.status(msgid('Choose a unit and read its logs. Nothing has been read.'))
    + h.facts([['observed-at', msgid('Observed at (UTC)'), true], ['shown', msgid('Entries returned'), true]])
    + h.table(msgid('Journal entries, newest first'), 'rows', [[msgid('Time (UTC)')], [msgid('Priority'), true], [msgid('Unit')], ['PID', true], [msgid('Message')]], msgid('No log entries have been read.'))))
}

/** /whm/monitoring/performance: downsampled host-scope metrics history. */
export function renderWhmMonitoringPerformance(input: WhmMonitoringPageInput): string {
  const h = helpers(input.locale)
  const metrics = [['cpuPercent', msgid('CPU %')], ['memoryMb', msgid('Memory, MB')], ['load1', msgid('Load average, 1 minute')], ['processes', msgid('Processes')], ['diskMb', msgid('Disk used, MB')]] as const
  const charts = `<div class="xp-whm-monitoring__charts" data-whm-monitoring-charts>${metrics.map(([key, label]) => `<figure class="xp-whm-monitoring__chart" data-whm-monitoring-chart="${key}"><figcaption>${escapeHtml(translator(input.locale)(label))}</figcaption><p class="xp-help" data-whm-monitoring-chart-state>${escapeHtml(translator(input.locale)('Not read'))}</p></figure>`).join('')}</div>`
  return page('performance', input, h.card('performance', msgid('Host performance history'),
    h.help(msgid('Recorded host samples from the metrics history, averaged into fixed intervals. Intervals without a sample are gaps, not zero.'))
    + `<div class="xp-whm-detail-fields">${h.field('whm-monitoring-window', msgid('Time window'), h.select('whm-monitoring-window', 'window', [['1h', msgid('Last hour')], ['24h', msgid('Last 24 hours')], ['7d', msgid('Last 7 days')]], input.canRead))}</div>`
    + h.refresh(msgid('Read history'), input.canRead)
    + h.status(msgid('Performance history has not been read.'))
    + h.facts([['observed-range', msgid('Range (UTC)'), true], ['samples', msgid('Recorded samples'), true], ['bucket', msgid('Interval, seconds'), true]])
    + charts
    + h.table(msgid('Performance summary'), 'summary-rows', [[msgid('Metric')], [msgid('Latest interval'), true], [msgid('Window average'), true], [msgid('Peak'), true]], msgid('No performance history has been read.'))))
}
