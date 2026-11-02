import { actions, button, check, context, esc, facts, field, fields, help, inputControl, link, markerFacts, page, section, status, table, type WhmObservationInput } from './common.ts'
import { v2WhmDiagnosticTemplates } from '../whm-diagnostic-client-templates.ts'

const ALERT_RULES = [
  ['load', msgid('Load per processor'), msgid('per processor')], ['memory', msgid('Available memory'), msgid('% available')], ['swap', msgid('Swap use'), msgid('% used')],
  ['disk-space', msgid('Disk space per filesystem'), msgid('% used')], ['disk-inodes', msgid('Inodes per filesystem'), msgid('% used')], ['services', msgid('Failed services'), null],
  ['drift', msgid('Configuration drift'), null], ['certificates', msgid('Certificates expiring'), msgid('days left')], ['reboot', msgid('Reboot required'), null], ['bandwidth', msgid('Monthly bandwidth per account'), msgid('% of plan limit')],
] as const

export function renderV2WhmAlerts(input: WhmObservationInput): string {
  const { t, canRead, canManage } = context(input)
  const ruleRows = ALERT_RULES.map(([key, label, unit]) => `<tr data-whm-alerts-rule="${key}"><th scope="row" data-whm-alerts-title>${esc(t(label))}</th><td>${check(t, msgctxt('whm-monitoring-alerts-workspace', 'Enabled'), { 'data-whm-alerts-enabled': true }, false, `${t(label)}: ${t(msgctxt('whm-monitoring-alerts-workspace', 'enabled'))}`)}</td><td>${unit ? `<span class="v2-observation__actions"><input type="number" dir="ltr" inputmode="decimal" data-whm-alerts-threshold aria-label="${esc(t(label))}: ${esc(t(msgid('threshold')))}" disabled><span data-whm-alerts-unit>${esc(t(unit))}</span></span>` : esc(t(msgid('No threshold. Fires when the health check reports a warning or a problem.')))}</td><td data-whm-alerts-range>${esc(unit ? t(msgid('Not read')) : '-')}</td></tr>`).join('')
  const rules = `<div class="v2-observation__scroll" role="region" tabindex="0" aria-label="${esc(t(msgid('Alert rules')))}"><table><caption class="v2-sr">${esc(t(msgid('Alert rules')))}</caption><thead><tr>${[msgid('Check'), msgid('Alert'), msgid('Threshold'), msgid('Condition and allowed range')].map(label => `<th scope="col">${esc(t(label))}</th>`).join('')}</tr></thead><tbody>${ruleRows}</tbody></table></div>`
  const formTag = canManage ? 'form' : 'div'
  const body = section(t, 'alerts-delivery', msgid('Delivery'), help(t, msgid('A firing alert is sent once when it starts and once when it clears, by email and to the webhook chosen on the notifications page. Failed messages are retried for about an hour.'))
    + facts(t, [['notifications', msgid('Notifications')], ['scheduler', msgid('Background checks')], ['pending', msgid('Waiting to retry')]], 'data-whm-alerts-fact')
    + actions(link(t, msgid('Notification settings'), '/whm/panel/notifications') + link(t, msgid('Server health'), '/whm/monitoring/health'))
    + table(t, msgid('Delivery log'), [msgid('Time (UTC)'), msgid('Alert'), msgid('Message'), msgid('Channel'), msgid('Result')], { 'data-whm-alerts-log': true }, msgid('No delivery has been read.')))
    + section(t, 'alerts-evaluation', msgid('Evaluation'), help(t, msgid('The rules below are evaluated on a schedule. Evaluate now reads the server health checks at once and delivers like a scheduled check. Each result is recorded, so this page shows how long an alert has been firing.'))
      + actions(button(t, msgid('Evaluate now'), { 'data-whm-alerts-evaluate': true }, canManage, true))
      + status(t, msgid('No evaluation has been read.'), { 'data-whm-alerts-eval-status': true })
      + facts(t, [['evaluated-at', msgid('Last evaluated (UTC)')], ['observed-at', msgid('Health observed (UTC)')], ['firing', msgid('Firing')], ['unavailable', msgctxt('whm-monitoring-alerts-workspace', 'Not verified')], ['quiet', msgid('Quiet window')]], 'data-whm-alerts-fact')
      + `<ul class="v2-observation__list" data-whm-alerts-results aria-live="polite"><li>${esc(t(msgid('No results have been read.')))}</li></ul>`)
    + section(t, 'alerts-rules', msgid('Rules'), status(t, msgid('Alert rules have not been read.'), { 'data-whm-alerts-status': true })
      + facts(t, [['updated', msgid('Last saved (UTC)')], ['updated-by', msgid('Saved by')]], 'data-whm-alerts-fact')
      + `<${formTag} class="v2-observation__groups" data-whm-alerts-form aria-labelledby="v2-observation-alerts-rules"${canManage ? ' novalidate' : ''}>${help(t, msgid('Each rule reads one server health check. A threshold applies to this alert only; the server health page keeps its fixed levels.'))}${rules}<fieldset${canManage ? '' : ' disabled'}><legend>${esc(t(msgid('Quiet window (UTC)')))}</legend>${check(t, msgid('Use a daily quiet window'), { 'data-whm-alerts-quiet': true })}${fields(field(t, 'v2-alert-quiet-start', msgid('Starts at'), inputControl('v2-alert-quiet-start', { 'data-whm-alerts-quiet-start': true }, false, ' dir="ltr"', 'time')) + field(t, 'v2-alert-quiet-end', msgid('Ends at'), inputControl('v2-alert-quiet-end', { 'data-whm-alerts-quiet-end': true }, false, ' dir="ltr"', 'time')))}${help(t, msgid('A firing alert evaluated inside the window is marked quiet and nothing is sent. A change that still holds when the window ends is sent then.'))}</fieldset>${actions(button(t, msgid('Save rules'), { 'data-whm-alerts-save': true }, false, true, canManage ? 'submit' : 'button') + button(t, msgid('Reload'), { 'data-whm-alerts-reload': true }, canRead))}${status(t, '', { 'data-whm-alerts-save-status': true }, 'unread', true)}</${formTag}>`)
  return page(input, '/whm/monitoring/alerts', msgid('Alerts'), msgctxt('theme:v2', 'Review delivery, evaluations and saved rules independently.'), v2WhmDiagnosticTemplates() + body, { 'data-whm-monitoring-alerts-workspace': true, 'data-alerts-can-manage': String(canManage) })
}

export function renderV2WhmRepair(input: WhmObservationInput): string {
  const { t, canRead, canManage } = context(input)
  const packageList = (key: string, title: string): string => `<details data-whm-repair-${key}-group hidden><summary>${esc(t(title))}</summary><ul class="v2-observation__list" dir="ltr" data-whm-repair-${key}-list></ul></details>`
  const body = section(t, 'repair-summary', msgid('Diagnostics'), help(t, msgid('Diagnostics run read-only package database, service configuration and drift checks on this server. Nothing changes until you preview and start a reviewed repair.'))
    + actions(button(t, msgid('Run diagnostics'), { 'data-whm-repair-diagnose': true }, canRead, true))
    + status(t, msgid('Diagnostics have not been run.'), { 'data-whm-repair-status': true }, canRead ? 'unread' : 'unavailable')
    + markerFacts(t, [['count-problem', msgid('Problems')], ['count-ok', msgctxt('whm-repair-workspace', 'No problem found')], ['count-unavailable', msgctxt('whm-repair-workspace', 'Not verified')], ['observed-at', msgid('Observed at (UTC)')]], 'whm-repair'))
    + section(t, 'repair-findings', msgid('Findings'), `<div class="v2-observation__groups" data-whm-repair-list aria-live="polite"><p data-whm-repair-empty>${esc(t(msgid('No diagnostics have been read.')))}</p></div>`)
    + section(t, 'repair-preview', msgid('Repair preview'), `<p data-whm-repair-preview-summary></p>`
      + markerFacts(t, [['preview-install', msgid('Install or upgrade')], ['preview-remove', msgctxt('whm-repair-workspace', 'Remove')], ['preview-configure', msgctxt('whm-repair-workspace', 'Configure')]], 'whm-repair')
      + `<div class="v2-observation__groups" data-whm-repair-removals role="alert" hidden><strong>${esc(t(msgid('Packages will be removed')))}</strong><p data-whm-repair-removals-text></p><ul class="v2-observation__list" dir="ltr" data-whm-repair-remove-list></ul></div>`
      + packageList('install', msgid('Packages to install or upgrade')) + packageList('configure', msgid('Packages to configure'))
      + `<details><summary>${esc(t(msgid('Preview output')))}</summary><pre class="v2-observation__log" dir="ltr" tabindex="0" data-whm-repair-preview-evidence></pre></details>`
      + actions(button(t, msgid('Run repair'), { 'data-whm-repair-start': true }, false, true) + button(t, msgid('Cancel'), { 'data-whm-repair-cancel': true }, canRead)), { 'data-whm-repair-preview': true }, true)
    + section(t, 'repair-job', msgid('Repair job'), status(t, '', { 'data-whm-repair-job-status': true })
      + actions(link(t, msgid('Open job'), '/whm/jobs', { 'data-whm-repair-job-link': true }) + button(t, msgid('Re-run diagnostics'), { 'data-whm-repair-rerun': true }, canRead)), { 'data-whm-repair-job': true }, true)
  return page(input, '/whm/monitoring/repair', msgid('Repair center'), msgctxt('theme:v2', 'Diagnostics, package preview, explicit repair and host verification remain separate steps.'), v2WhmDiagnosticTemplates() + body, { 'data-whm-repair-workspace': true, 'data-repair-can-read': String(canRead), 'data-repair-can-repair': String(canManage) })
}

export function renderV2WhmBenchmark(input: WhmObservationInput): string {
  const { t, canManage } = context(input)
  const tag = canManage ? 'form' : 'div'
  const body = section(t, 'benchmark-run', msgid('Run a bounded benchmark'), help(t, msgid('This test puts load on a small server. It runs at low CPU and IO priority, writes one temporary file, and verifies its removal. Start only when brief extra load is acceptable.'))
    + `<dl class="v2-observation__facts">${[[msgid('CPU'), msgid('SHA-256, 5 seconds, one worker')], [msgid('Disk'), msgid('64 MiB direct write and read')], [msgid('Time limit'), msgid('Up to 60 seconds')], [msgid('Network'), msgid('Not measured; no endpoint configured')]].map(([label, value]) => `<div><dt>${esc(t(label!))}</dt><dd>${esc(t(value!))}</dd></div>`).join('')}</dl>`
    + `<${tag} class="v2-observation__groups" data-benchmark-form>${field(t, 'v2-benchmark-confirm', msgid('Type RUN to confirm the temporary load'), inputControl('v2-benchmark-confirm', { 'data-benchmark-confirm': true }, false, ' autocomplete="off" spellcheck="false" dir="ltr" maxlength="3" pattern="RUN" required'))}${actions(button(t, msgid('Start benchmark'), { 'data-benchmark-start': true }, false, true, canManage ? 'submit' : 'button') + button(t, msgid('Refresh results'), { 'data-benchmark-refresh': true }) + link(t, msgid('View host jobs'), '/whm/jobs'))}</${tag}>`
    + status(t, canManage ? msgid('Results have not been read. No benchmark starts automatically.') : msgid('Benchmarks require an authorized root administrator on a qualified host.'), { 'data-benchmark-status': true }))
    + section(t, 'benchmark-history', msgid('Result history'), help(t, msgid('The last 20 attempts are stored on this host. Missing measurements stay unavailable. Throughput reflects this host and filesystem; no score or external comparison is inferred.'))
      + table(t, msgid('Benchmark history'), [msgctxt('whm-benchmark-workspace', 'Started (UTC)'), msgid('CPU bytes/s'), msgid('Disk write bytes/s'), msgid('Disk read bytes/s'), msgid('Result'), msgid('Cleanup')], { 'data-benchmark-history': true }))
    + section(t, 'benchmark-reading', msgid('Reading results'), help(t, msgid('Unsupported direct IO, missing tools, interrupted commands, malformed output or unverified cleanup cannot produce a complete result. A retained temporary file blocks the next run until an administrator reviews it.'))
      + help(t, msgid('Use host jobs to follow progress or request cancellation between steps. A sudden agent or machine stop can leave a temporary file requiring review.')))
  return page(input, '/whm/monitoring/benchmark', msgid('Benchmark'), msgctxt('theme:v2', 'Explicit temporary load with bounded resources and verified cleanup.'), body, { 'data-whm-benchmark': true, 'data-can-manage': String(canManage) })
}
