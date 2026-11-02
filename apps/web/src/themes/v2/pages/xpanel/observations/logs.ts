import { logsClientTemplates } from '../../../client-templates/team-logs.ts'
import type { PanelSurfaceProps } from '../../../../contract.ts'
import { actions, button, emailContext, esc, field, fields, header, input, missingAccount, page, section, select, state, table } from '../email-tools/common.ts'
import type { PanelObservationAuthority } from './common.ts'

export function renderV2PanelLogs(props: PanelSurfaceProps, authority?: PanelObservationAuthority): string {
  const { locale, t, account, domains } = emailContext(props, authority)
  const route = '/metrics/logs', title = t(msgctxt('theme:v2', 'Site logs'))
  const kinds = (['access', 'error'] as const).filter(kind => authority?.logKinds?.includes(kind))
  const enabled = kinds.length > 0 && !!domains?.length
  const selectedDomain = domains?.find(row => row.name === props.activeDomain)?.id ?? domains?.find(row => row.name === (account?.primaryDomain ?? ''))?.id
  const choose = section('v2-site-logs-choose', t(msgid('Choose a log')),
    fields(field('account-logs-domain', t(msgid('Domain')), select('account-logs-domain', (domains ?? []).map(domain => [domain.id, domain.name] as const), { 'data-logs-domain': true }, !enabled, ' dir="ltr"', selectedDomain))
      + `<div data-logs-field="kind">${field('account-logs-kind', t(msgid('Log')), select('account-logs-kind', kinds.map(kind => [kind, kind === 'access' ? t(msgid('Access log')) : t(msgid('Error log'))] as const), { 'data-logs-kind': true }, !enabled))}</div>`)
    + actions(button(t(msgid('Read log')), { 'data-logs-read': true }, !enabled, true))
    + `<p>${esc(t(msgid("Shows the last 256 KiB, at most 2000 lines, of the log the web server writes for the site. An alias shares its main site's log. Rotated older logs are not shown.")))}</p>`)
  const entries = section('v2-site-log-entries', t(msgid('Log entries')),
    fields(`<div data-logs-field="class">${field('account-logs-class', t(msgid('Status')), select('account-logs-class', [['all', t(msgid('All responses'))], ['2', '2xx'], ['3', '3xx'], ['4', '4xx'], ['5', '5xx']], { 'data-logs-class': true }))}</div>`
      + `<div data-logs-field="level" hidden>${field('account-logs-level', t(msgid('Level')), select('account-logs-level', [['all', t(msgid('All levels'))], ['error', t(msgid('Errors and worse'))], ['warn', t(msgid('Warnings and worse'))]], { 'data-logs-level': true }))}</div>`
      + field('account-logs-text', t(msgid('Contains text')), input('account-logs-text', { 'data-logs-text': true }, ' type="search" dir="auto" maxlength="200" autocomplete="off"')))
    + `<p data-logs-summary>${esc(t(msgid('No log has been read.')))}</p>`
    + table('v2-account-logs-records', t(msgid('Log entries')), [t(msgid('Entries'))], `<tr><td>${esc(t(msgid('No log has been read.')))}</td></tr>`, { 'data-logs-rows': true }, { 'data-logs-head': true })
    + state(kinds.length ? domains?.length ? t(msgid('Choose a domain and read its log.')) : domains === undefined ? t(msgctxt('theme:v2', 'Account domains have not been read. No log was read.')) : t(msgid('This account has no domains to read logs for.')) : t(msgid('Site logs are unavailable here. Nothing was read.')), { 'data-logs-status': true }))
  return page(locale, route, header(t, route, title, t(msgctxt('theme:v2', 'Read bounded access and error tails for domains owned by this account.')))
    + `<div class="v2-panel-extra__groups"${!authority?.canRead || authority.presentation === 'read-only' || !account ? ' data-readonly="true"' : ''} data-account-logs data-account="${esc((account?.id ?? ''))}" data-logs-kinds="${kinds.join(' ')}" data-logs-manage="${!!account && authority?.canRead === true && authority.presentation !== 'read-only' && kinds.length > 0}">${choose}${entries}${logsClientTemplates(t)}</div>`)
}
