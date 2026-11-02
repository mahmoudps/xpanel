import { networkDiagnosticClientTemplates } from '../diagnostic-client-templates.ts'
import { v2WhmClientTemplates } from '../../../whm-client-templates.ts'
import type { PanelSurfaceProps } from '../../../../contract.ts'
import { actions, button, deniedPage, esc, facts, field, fields, input, note, page, section, select, settingsContext, split, status, table, unreadRow, NO_SETTINGS_AUTHORITY, type PanelSettingsAuthority } from '../settings/common.ts'

export function renderV2NetworkToolsPage(props: PanelSurfaceProps, authority: PanelSettingsAuthority = NO_SETTINGS_AUTHORITY): string {
  const c = settingsContext(props, authority), { t } = c, title = t(msgid('Network tools')), description = t(msgid('Look up DNS records, ping a host, trace the route or check a port from this server.'))
  const run = section('v2-network-run', t(msgid('Run a diagnostic')), fields(
    field('v2-network-tool', t(msgid('Tool')), select('v2-network-tool', '', [['dns', t(msgid('DNS lookup'))], ['ping', t(msgid('Ping'))], ['traceroute', t(msgid('Traceroute'))], ['port', t(msgid('Port check'))]], ' data-nettools-tool', !c.editable))
    + field('v2-network-host', t(msgid('Host name or IP address')), input('v2-network-host', '', 'text', ' inputmode="url" maxlength="253" autocomplete="off" spellcheck="false" dir="ltr" data-nettools-host', !c.editable))
    + `<div data-nettools-field="type">${field('v2-network-type', t(msgid('Record type')), select('v2-network-type', '', ['A', 'AAAA', 'MX', 'TXT', 'CNAME', 'NS', 'SOA', 'CAA'].map(type => [type, type]), ' data-nettools-type dir="ltr"', !c.editable))}</div>`
    + `<div data-nettools-field="port" hidden>${field('v2-network-port', t(msgid('Port')), input('v2-network-port', '', 'number', ' inputmode="numeric" dir="ltr" min="1" max="65535" step="1" data-nettools-port', !c.editable))}</div>`)
    + note(t(msgid('Runs from this server, not from your computer. Only public internet addresses are tested: private, loopback, link-local and reserved addresses, and names that resolve to them, are refused. DNS lookup takes a domain name. At most 10 runs per minute, one at a time.'))), actions(button(t(msgid('Run')), { 'data-nettools-run': true }, !c.editable, true)))
  const result = section('v2-network-result', t(msgid('Result')), facts([['target', msgid('Target')], ['address', msgid('Address used')], ['at', msgid('Ran at (UTC)')]].map(([key, copy]) => ({ label: t(copy!), valueHtml: `<bdi dir="ltr" data-nettools-${key}>${esc(t(msgid('Not run')))}</bdi>` })))
    + `<p class="v2-muted" data-nettools-summary>${esc(t(msgid('No diagnostic has run.')))}</p>`
    + `<div class="v2-panel-settings__table" role="region" tabindex="0" aria-labelledby="v2-network-result-heading"><table><thead data-nettools-head><tr><th scope="col">${esc(t(msgid('Details')))}</th></tr></thead><tbody data-nettools-rows>${unreadRow(1, t(msgid('No diagnostic has run.')))}</tbody></table></div>`
    + status(c.editable ? t(msgid('Choose a tool, enter a target and run it.')) : t(msgid('Network tools are unavailable here. Nothing was run.')), { 'data-nettools-status': true }))
  return page(props, authority, '/advanced/network-tools', title, description, run + result + networkDiagnosticClientTemplates(), { 'data-account-network-tools': true, 'data-nettools-manage': String(c.editable) })
}

export function renderV2AccountApiExplorerPage(props: PanelSurfaceProps, authority: PanelSettingsAuthority = NO_SETTINGS_AUTHORITY): string {
  const c = settingsContext(props, authority), { t } = c, title = t(msgid('API explorer')), description = t(msgid('Run supported API reads with your current account session.'))
  const fact = (key: string, label: string) => ({ label, valueHtml: `<span data-dev-fact="${key}">${esc(t(msgid('Not read')))}</span>` })
  const request = section('v2-api-request', t(msgid('API request explorer')), note(t(msgid('Read live data using your current signed-in session. Choose a supported operation; its method and route are fixed. No server setting is changed.')))
    + `<form data-dev-form>${field('v2-api-operation', t(msgid('Operation')), select('v2-api-operation', '', [['', t(msgid('Read supported operations first'))]], ' data-dev-operation'))}${facts([fact('method', t(msgid('Method'))), fact('path', t(msgid('API route')))])}${actions(`<button type="submit" class="v2-btn v2-btn--primary" data-dev-run disabled>${esc(t(msgid('Run read request')))}</button>` + button(t(msgid('Read supported operations')), { 'data-dev-refresh': true }, !c.readable))}</form>`
    + status(t(msgid('Supported operations have not been read.')), { 'data-dev-status': true }))
  const response = section('v2-api-response', t(msgid('Response')), note(t(msgid('Only reviewed response fields are shown. Credential values, session information and internal identifiers are omitted.')))
    + facts([fact('status', t(msgid('HTTP status'))), fact('observed', t(msgid('Read at (UTC)')))])
    + `<dl class="v2-panel-settings__facts" data-dev-result-fields><div><dt>${esc(t(msgid('Result')))}</dt><dd>${esc(t(msgid('No read request has run.')))}</dd></div></dl>`
    + `<div data-dev-token-table hidden>${table('v2-api-tokens', t(msgid('Your API token metadata')), [t(msgid('Name')), t(msgid('Scopes')), t(msgid('Expires (UTC)')), t(msgid('State'))], '', { 'data-dev-token-rows': true })}</div>`
    + actions(button(t(msgid('Copy reviewed response')), { 'data-dev-copy': true })) + '<p data-dev-copy-status role="status" hidden></p>')
  const authorityCard = section('v2-api-authority', t(msgid('Current authority')), note(t(msgid('The account and principal come from this session. Every selected read repeats its normal API authentication and permissions. API tokens cannot operate this console.'))))
  const additional = section('v2-api-additional', t(msgid('Additional capabilities')), note(t(msgid('These providers are not connected. No remote service or callback has been contacted or verified.')))
    + [msgid('Hooks and callbacks'), msgid('Registered applications'), msgid('Plugin generator'), msgid('Metrics export and debug tools')].map(label => `<div class="v2-panel-settings__groups"><h3>${esc(t(label))}</h3><p>${esc(t(msgid('Unavailable')))}</p>${actions(button(t(msgid('Configure'))))}</div>`).join(''))
  return page(props, authority, '/advanced/api-shell', title, description, v2WhmClientTemplates('developer') + split(request + response, authorityCard + additional), { 'data-developer-workspace': true, 'data-developer-surface': 'account', 'data-developer-enabled': String(c.readable) })
}
