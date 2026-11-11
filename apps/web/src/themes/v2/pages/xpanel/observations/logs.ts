import { logsClientTemplates } from '../../../client-templates/team-logs.ts'
import type { PanelSurfaceProps } from '../../../../contract.ts'
import { actions, button, check, emailContext, esc, field, fields, header, input, missingAccount, page, panelMailCards, section, select, state, table } from '../email-tools/common.ts'
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
  const rawAccess = !!account && authority?.canRead === true && authority.presentation !== 'read-only' && authority.qualifiedTools?.has('raw-access') === true
  const archives = section('v2-site-log-archives', t(msgid('Raw access archives')),
    `<p>${esc(t(msgid('Each site access log is rotated once per UTC day after its traffic is counted. With archiving on it is kept in ~/logs as a gzip file named after the site and day; otherwise it is deleted.')))}</p>`
    + `<div class="v2-panel-extra__groups" data-raw-access-form>${fields(check('account-raw-access-archive', t(msgid('Archive logs in ~/logs after their traffic is counted')), { 'data-raw-access': 'archive' }, !rawAccess)
      + check('account-raw-access-previous', t(msgid("Remove the previous month's archives when a new UTC month starts")), { 'data-raw-access': 'removePreviousMonthArchive' }, !rawAccess))}`
    + fields(field('account-raw-access-days', t(msgid('Keep archives (days)')), input('account-raw-access-days', { 'data-raw-access': 'retentionDays' }, ` type="text" inputmode="numeric" dir="ltr" autocomplete="off" placeholder="${esc(t(msgid('Until removed')))}"`, !rawAccess)))
    + `<p data-raw-access-source>${esc(t(msgid('Settings have not been read.')))}</p>`
    + actions(button(t(msgid('Save settings')), { 'data-raw-access-save': true }, !rawAccess, true) + button(t(msgid('Use server defaults')), { 'data-raw-access-defaults': true }, !rawAccess))
    + state(rawAccess ? t(msgid('Settings have not been read.')) : t(msgid('Raw access archives are unavailable here. Nothing was read.')), { 'data-raw-access-status': true }) + '</div>'
    + table('v2-raw-access-current', t(msgid('Current access logs')), [t(msgid('Domain')), t(msgid('Current access log'))], (domains ?? []).map(domain => `<tr><td><bdi dir="ltr">${esc(domain.name)}</bdi></td><td>${rawAccess ? `<a class="v2-btn" href="/api/account/logs/${esc(domain.id)}/access/download" download>${esc(t(msgid('Download as gzip')))}</a>` : esc(t(msgid('Unavailable')))}</td></tr>`).join('') || `<tr><td colspan="2">${esc(t(msgid('This account has no domains to read logs for.')))}</td></tr>`, { 'data-raw-access-current': true })
    + `<p>${esc(t(msgid("The current log is the part not yet rotated today. It is compressed while it downloads; an alias shares its main site's log.")))}</p>`
    + table('v2-raw-access-archives', t(msgid('Archives in ~/logs')), [t(msgid('Archive')), t(msgid('Day (UTC)')), t(msgid('Size')), t(msgid('Download'))], `<tr><td colspan="4">${esc(t(msgid('Archives have not been read.')))}</td></tr>`, { 'data-raw-access-rows': true })
    + `<p data-raw-access-list-status role="status" hidden></p><p data-raw-access-pending role="status" hidden></p>`)
  return page(locale, route, header(t, route, title, t(msgctxt('theme:v2', 'Read bounded access and error tails for domains owned by this account.')))
    + `<div class="v2-panel-extra__groups"${!authority?.canRead || authority.presentation === 'read-only' || !account ? ' data-readonly="true"' : ''} data-account-logs data-account="${esc((account?.id ?? ''))}" data-logs-kinds="${kinds.join(' ')}" data-logs-manage="${!!account && authority?.canRead === true && authority.presentation !== 'read-only' && kinds.length > 0}">${choose}${entries}${logsClientTemplates(t)}</div>`
    + `<div class="v2-panel-extra__groups" data-account-raw-access data-account="${esc(account?.id ?? '')}" data-raw-access-manage="${rawAccess}">${archives}</div>` + panelMailCards(route, locale, t, authority?.canRead === true && authority.presentation !== 'read-only' && !!account, false))
}
