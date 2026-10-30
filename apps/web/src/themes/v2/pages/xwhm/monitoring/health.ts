import { actions, button, context, field, fields, help, inputControl, link, markerFacts, page, section, select, status, table, esc, type WhmObservationInput } from './common.ts'
import { v2WhmDiagnosticTemplates } from '../whm-diagnostic-client-templates.ts'

export function renderV2WhmHealth(input: WhmObservationInput): string {
  const { t, canRead } = context(input)
  const body = section(t, 'health-summary', msgid('Health summary'), help(t, msgid('Each check reads one host observation and grades it against a fixed threshold. There is no combined score. A check that could not be read is shown as not verified, never as healthy.'))
    + actions(button(t, msgid('Check again'), { 'data-whm-server-health-refresh': true }, canRead, true))
    + status(t, msgid('Server health has not been read.'), { 'data-whm-server-health-status': true }, canRead ? 'unread' : 'unavailable')
    + markerFacts(t, [['observed-at', msgid('Observed at (UTC)')], ['count-problem', msgid('Problems')], ['count-warning', msgid('Warnings')], ['count-unavailable', msgctxt('whm-server-health-workspace', 'Not verified')], ['count-ok', msgctxt('whm-server-health-workspace', 'No problem found')]], 'whm-server-health'))
    + section(t, 'health-checks', msgctxt('theme:v2', 'Measured against thresholds'), `<ul class="v2-observation__list" data-whm-server-health-checks aria-live="polite"><li data-whm-server-health-empty>${esc(t(msgid('No checks have been read.')))}</li></ul>`)
    + section(t, 'health-thresholds', msgid('Thresholds'), help(t, msgid('The thresholds are fixed values in the host agent. They are listed exactly as the last read applied them.'))
      + table(t, msgid('Thresholds'), [msgid('Check'), msgid('Warning at'), msgid('Problem at')], { 'data-whm-server-health-thresholds': true }, msgid('Thresholds appear after a read.'), [1, 2]))
    + section(t, 'health-related', msgid('Related diagnostics'), help(t, msgid('Pending package updates and package repair diagnostics are read on their own pages, because those reads are slower and can contact package mirrors.'))
      + actions(link(t, msgid('Review pending updates'), '/whm/software/updates') + link(t, msgid('Open the repair center'), '/whm/monitoring/repair') + link(t, msgid('Server information'), '/whm/monitoring/server-info')))
  return page(input, '/whm/monitoring/health', msgid('Server health'), msgctxt('theme:v2', 'Individual host checks retain their thresholds, evidence and actual read state.'), v2WhmDiagnosticTemplates() + body, { 'data-whm-server-health': 'health', 'data-server-health-can-read': String(canRead) })
}

export function renderV2WhmLimits(input: WhmObservationInput): string {
  const { t, canRead } = context(input)
  const body = section(t, 'limits-summary', msgid('Resource limits'), help(t, msgid('Each account plan limit is compared with the cap the kernel enforces for the account (cgroup and disk quota) and with its observed usage. Usage at or above 90 percent of a limit is flagged. A cap that differs from the plan is drift. Nothing is changed here; limits are edited on the plan pages.'))
    + actions(button(t, msgid('Read limits'), { 'data-whm-server-health-refresh': true }, canRead, true) + link(t, msgid('Edit plan limits'), '/whm/plans'))
    + status(t, msgid('Resource limits have not been read.'), { 'data-whm-server-health-status': true }, canRead ? 'unread' : 'unavailable')
    + markerFacts(t, [['observed-at', msgid('Observed at (UTC)')], ['sample-at', msgid('CPU and IO sample (UTC)')], ['count-accounts', msgid('Accounts read')], ['count-high', msgid('Accounts at or above 90%')], ['count-drift', msgid('Accounts with drift')]], 'whm-server-health')
    + help(t, msgid('CPU and IO rates come from the resource sampler that runs every 5 seconds. Memory and processes are read from the account cgroup, and disk from the user quota report.')))
    + section(t, 'limits-accounts', msgid('Accounts'), fields(field(t, 'v2-limits-filter', msgctxt('whm-server-health-workspace', 'Show'), select(t, 'v2-limits-filter', { 'data-whm-server-health-filter': true }, [['all', msgctxt('whm-server-health-workspace', 'All accounts')], ['high', msgid('At or above 90%')], ['drift', msgid('Limits differ from the plan')], ['unavailable', msgid('Not fully verified')], ['ok', msgid('No finding')]], canRead))
      + field(t, 'v2-limits-search', msgid('Account'), inputControl('v2-limits-search', { 'data-whm-server-health-search': true }, canRead, ' dir="ltr" maxlength="16" autocomplete="off" spellcheck="false"', 'search')))
      + `<ul class="v2-observation__list" data-whm-server-health-accounts aria-live="polite"><li data-whm-server-health-empty>${esc(t(msgid('No accounts have been read.')))}</li></ul>`)
  return page(input, '/whm/monitoring/limits', msgid('Resource limits'), msgctxt('theme:v2', 'Compare the saved plan with kernel enforcement and measured account usage.'), v2WhmDiagnosticTemplates() + body, { 'data-whm-server-health': 'limits', 'data-server-health-can-read': String(canRead) })
}
