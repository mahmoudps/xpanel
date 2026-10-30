import { v2WhmClientTemplates } from '../../../whm-client-templates.ts'
import { actions, button, context, field, fields, help, inputControl, markerFacts, page, section, select, status, table, esc, type WhmObservationInput } from './common.ts'

export function renderV2WhmProcesses(input: WhmObservationInput): string {
  const { t, canRead, canManage } = context(input)
  const controls = fields(field(t, 'v2-process-search', msgid('Search PID, user or command'), inputControl('v2-process-search', { 'data-whm-monitoring-search': true }, false, ' dir="ltr" autocomplete="off"', 'search'))
    + field(t, 'v2-process-account', msgid('Account'), select(t, 'v2-process-account', { 'data-whm-monitoring-account': true }, [['', msgid('All processes')], ['-', msgid('Not an account')]]))
    + field(t, 'v2-process-sort', msgid('Sort'), select(t, 'v2-process-sort', { 'data-whm-monitoring-sort': true }, [['cpu', msgid('CPU, highest first')], ['memory', msgid('Memory, highest first')], ['elapsed', msgid('Running time, longest first')], ['pid', msgid('PID, ascending')]])))
  const body = section(t, 'process-list', msgid('Running processes'), help(t, msgid('Command arguments are not read, so secrets passed as arguments are never shown. Root, kernel, panel and core service processes cannot be signalled here.'))
    + actions(button(t, msgid('Read processes'), { 'data-whm-monitoring-refresh': true }, canRead, true))
    + status(t, msgid('Processes have not been read.'), { 'data-whm-monitoring-status': true })
    + markerFacts(t, [['observed-at', msgid('Observed at (UTC)')], ['total', msgid('Processes on the host')], ['shown', msgid('Rows shown')]], 'whm-monitoring') + controls
    + table(t, msgid('Running processes'), ['PID', msgid('User'), msgid('Account'), msgid('CPU %'), msgid('Memory %'), msgid('Resident memory'), msgid('Running time'), msgid('State'), msgid('Command'), msgid('Action')], { 'data-whm-monitoring-rows': true }, msgid('No processes have been read.'), [0, 3, 4, 5, 6]))
    + section(t, 'process-accounts', msgid('By account'), help(t, msgid('Processes are grouped by the numeric user id of each saved account.'))
      + table(t, msgid('Processes by account'), [msgid('Account'), msgid('Processes'), msgid('CPU %'), msgid('Resident memory')], { 'data-whm-monitoring-account-rows': true }, msgid('No account processes have been read.'), [1, 2, 3]))
  return page(input, '/whm/monitoring/processes', msgid('Processes'), msgctxt('theme:v2', 'Read a bounded process snapshot; each signal requires a fresh process identity check.'), v2WhmClientTemplates('processes') + body, { 'data-whm-monitoring': 'processes', 'data-monitoring-can-read': String(canRead), 'data-monitoring-can-signal': String(canManage) })
}

export function renderV2WhmDisk(input: WhmObservationInput): string {
  const { t, canRead } = context(input)
  const body = section(t, 'filesystems', msgid('Filesystems'), actions(button(t, msgid('Read disk usage'), { 'data-whm-monitoring-refresh': true }, canRead, true))
    + status(t, msgctxt('whm-monitoring-workspace', 'Disk usage has not been read.'), { 'data-whm-monitoring-status': true })
    + markerFacts(t, [['observed-at', msgid('Observed at (UTC)')], ['inodes', msgid('Inode counts')]], 'whm-monitoring')
    + table(t, msgid('Filesystems'), [msgid('Mount point'), msgid('Filesystem'), msgid('Type'), msgid('Size'), msgid('Used'), msgctxt('whm-monitoring-workspace', 'Available'), msgid('Use'), msgid('Inodes used'), msgid('Inode use')], { 'data-whm-monitoring-rows': true }, msgid('No filesystems have been read.'), [3, 4, 5, 6, 7, 8]))
    + section(t, 'account-homes', msgid('Account home usage'), help(t, msgid('Read from the user quota report of the filesystem that holds /home. Without enabled quotas, per-account usage stays unavailable; no directory scan is run.'))
      + status(t, msgid('Quota usage has not been read.'), { 'data-whm-monitoring-quota-status': true }) + markerFacts(t, [['quota-mount', msgctxt('whm-monitoring-workspace', 'Quota filesystem')]], 'whm-monitoring')
      + table(t, msgid('Account home usage'), [msgid('Account'), msgid('Used'), msgid('Quota limit'), msgid('Use')], { 'data-whm-monitoring-quota-rows': true }, msgid('No account usage has been read.'), [1, 2, 3]))
  return page(input, '/whm/monitoring/disk', msgid('Disk usage'), msgctxt('theme:v2', 'Filesystem space, inodes and account quotas are separate measured observations.'), body, { 'data-whm-monitoring': 'disk', 'data-monitoring-can-read': String(canRead) })
}

export function renderV2WhmLogs(input: WhmObservationInput): string {
  const { t, canRead } = context(input)
  const units = input.monitoringLogUnits ?? []
  const max = input.monitoringLogMaxLines
  const limitKnown = Number.isSafeInteger(max) && max! >= 1 && max! <= 500
  const defaultLines = input.monitoringLogDefaultLines
  const defaultsKnown = limitKnown && Number.isSafeInteger(defaultLines) && defaultLines! >= 1 && defaultLines! <= max!
  const enabled = canRead && units.length > 0 && defaultsKnown
  const priorities = [['', msgid('Any priority')], ['0', msgid('Emergency')], ['1', msgctxt('whm-monitoring-workspace', 'Alert')], ['2', msgid('Critical')], ['3', msgid('Error')], ['4', msgid('Warning')], ['5', msgid('Notice')], ['6', msgid('Info')], ['7', msgid('Debug')]] as const
  const controls = fields(field(t, 'v2-log-unit', msgid('Service unit'), select(t, 'v2-log-unit', { 'data-whm-monitoring-unit': true }, units.map(unit => [unit, unit] as const), enabled))
    + field(t, 'v2-log-lines', msgid('Entries, 1 to 500'), inputControl('v2-log-lines', { 'data-whm-monitoring-lines': true }, enabled, ` dir="ltr" inputmode="numeric" min="1"${limitKnown ? ` max="${max}"` : ''} step="1"${defaultsKnown ? ` value="${defaultLines}"` : ''}`, 'number'))
    + field(t, 'v2-log-since', msgid('Since, UTC (optional)'), inputControl('v2-log-since', { 'data-whm-monitoring-since': true }, enabled, ' dir="ltr"', 'datetime-local'))
    + field(t, 'v2-log-priority', msgid('Priority'), select(t, 'v2-log-priority', { 'data-whm-monitoring-priority': true }, priorities, enabled)))
  const body = section(t, 'journal', msgctxt('theme:v2', 'Read the journal'), help(t, msgid('Reads the latest journal entries of one reviewed service unit. Messages are shown as recorded; each is limited to 4 KiB and the whole read to 1 MiB, with truncation marked.')) + controls
    + actions(button(t, msgid('Read logs'), { 'data-whm-monitoring-refresh': true }, enabled, true))
    + status(t, msgid('Choose a unit and read its logs. Nothing has been read.'), { 'data-whm-monitoring-status': true })
    + markerFacts(t, [['observed-at', msgid('Observed at (UTC)')], ['shown', msgid('Entries returned')]], 'whm-monitoring')
    + table(t, msgid('Journal entries, newest first'), [msgid('Time (UTC)'), msgid('Priority'), msgid('Unit'), 'PID', msgid('Message')], { 'data-whm-monitoring-rows': true }, msgid('No log entries have been read.'), [1, 3]))
  return page(input, '/whm/monitoring/logs', msgid('Logs'), msgctxt('theme:v2', 'Read a reviewed service journal with an explicit time and priority bound.'), body, { 'data-whm-monitoring': 'logs', 'data-monitoring-can-read': String(enabled) })
}

export function renderV2WhmPerformance(input: WhmObservationInput): string {
  const { t, canRead } = context(input)
  const metrics = [['cpuPercent', msgid('CPU %')], ['memoryMb', msgid('Memory, MB')], ['load1', msgid('Load average, 1 minute')], ['processes', msgid('Processes')], ['diskMb', msgid('Disk used, MB')]] as const
  const charts = `<div class="v2-observation__charts" data-whm-monitoring-charts>${metrics.map(([key, label]) => `<figure class="v2-observation__chart" data-whm-monitoring-chart="${key}"><figcaption>${esc(t(label))}</figcaption><p data-whm-monitoring-chart-state>${esc(t(msgid('Not read')))}</p></figure>`).join('')}</div>`
  const body = section(t, 'performance', msgid('Host performance history'), help(t, msgid('Recorded host samples from the metrics history, averaged into fixed intervals. Intervals without a sample are gaps, not zero.'))
    + fields(field(t, 'v2-monitoring-window', msgid('Time window'), select(t, 'v2-monitoring-window', { 'data-whm-monitoring-window': true }, [['1h', msgid('Last hour')], ['24h', msgid('Last 24 hours')], ['7d', msgid('Last 7 days')]], canRead)))
    + actions(button(t, msgid('Read history'), { 'data-whm-monitoring-refresh': true }, canRead, true))
    + status(t, msgid('Performance history has not been read.'), { 'data-whm-monitoring-status': true })
    + markerFacts(t, [['observed-range', msgid('Range (UTC)')], ['samples', msgid('Recorded samples')], ['bucket', msgid('Interval, seconds')]], 'whm-monitoring') + charts
    + table(t, msgid('Performance summary'), [msgid('Metric'), msgid('Latest interval'), msgid('Window average'), msgid('Peak')], { 'data-whm-monitoring-summary-rows': true }, msgid('No performance history has been read.'), [1, 2, 3]))
  return page(input, '/whm/monitoring/performance', msgid('Performance history'), msgctxt('theme:v2', 'Recorded observations retain gaps and their actual time range.'), body, { 'data-whm-monitoring': 'performance', 'data-monitoring-can-read': String(canRead) })
}
