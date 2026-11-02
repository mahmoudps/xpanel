import { siteHealthClientTemplates } from '../diagnostic-client-templates.ts'
import type { PanelSurfaceProps } from '../../../../contract.ts'
import { actions, button, emailContext, esc, facts, header, missingAccount, page, section, state, table, technical, type PanelEmailAuthority } from '../email-tools/common.ts'

export function renderV2PanelSiteHealth(props: PanelSurfaceProps, authority?: PanelEmailAuthority): string {
  const { locale, t, account } = emailContext(props, authority)
  const route = '/health', title = t(msgid('Site health'))
  const notChecked = esc(t(msgid('Not checked')))
  const summary = section('v2-site-health-summary', t(msgid('Health checks')),
    `<p>${esc(t(msgid('Checks every site you own and explains each problem with a link to the page that fixes it. Nothing is changed by a check.')))}</p>`
    + facts([{ label: t(msgid('Checked at (UTC)')), valueHtml: `<bdi dir="ltr" data-health-at>${notChecked}</bdi>` }, { label: t(msgid('Domains checked')), valueHtml: `<bdi dir="ltr" data-health-count>${notChecked}</bdi>` }, { label: t(msgid('Problems found')), valueHtml: `<bdi dir="ltr" data-health-problems>${notChecked}</bdi>` }])
    + state(t(msgid('Checks have not run.')), { 'data-health-status': true })
    + actions(button(t(msgid('Run checks')), { 'data-health-run': true }, false, true)))
  const findings = section('v2-site-health-findings', t(msgid('Findings')),
    table('v2-site-health-records', t(msgid('Findings')), [t(msgid('Domain')), t(msgid('Check')), t(msgid('Result')), t(msgid('Details')), t(msgctxt('site-health-workspace', 'Fix'))], `<tr><td colspan="5">${esc(t(msgid('Checks have not run.')))}</td></tr>`, { 'data-health-rows': true }))
  const scope = section('v2-site-health-scope', t(msgid('What is checked')),
    `<ul class="v2-panel-extra__scope"><li>${esc(t(msgid("DNS: the A and AAAA records the server's resolver sees, compared with the addresses saved for the site.")))}</li><li>${esc(t(msgid('Website: the home page through the local web server, not from the internet. Only the status code is read.')))}</li><li>${esc(t(msgid('Certificate: the expiry of the saved certificate that covers the name. The certificate the server presents is not fetched.')))}</li><li>${esc(t(msgid('PHP: the saved PHP version against the versions this server supports. At most 20 domains are checked at a time.')))}</li></ul>`)
  return page(locale, route, header(t, route, title, t(msgctxt('theme:v2', 'Read bounded checks for your sites without changing DNS, services or saved configuration.')))
    + `<div class="v2-panel-extra__groups"${!authority?.canRead || authority.presentation === 'read-only' || !account ? ' data-readonly="true"' : ''} data-site-health data-account="${esc((account?.id ?? ''))}" data-health-manage="${!!account && authority?.canRead === true && authority.presentation !== 'read-only'}">${summary}${findings}${scope}${siteHealthClientTemplates()}</div>`)
}

export function renderV2PanelServerInformation(props: PanelSurfaceProps, authority?: PanelEmailAuthority): string {
  const { locale, t, account, plan } = emailContext(props, authority)
  const route = '/server-information', title = t(msgid('Server information'))
  const notRead = esc(t(msgid('Not read')))
  const value = (number: number | null | undefined, unit = ''): string => number !== null && number !== undefined && Number.isFinite(number) && number >= 0 ? technical(`${number}${unit}`) : notRead
  const usage = account && (authority?.presentation !== 'read-only' || authority.authorizedTools?.has('server-information')) ? props.usage : undefined
  const identity = section('v2-account-server-information', t(msgctxt('theme:v2', 'Account information')),
    facts([{ label: t(msgid('Account')), valueHtml: technical((account?.username ?? '')) }, { label: t(msgid('Domain')), valueHtml: technical((account?.primaryDomain ?? '')) }, { label: t(msgid('Plan')), valueHtml: plan?.name != null ? esc(plan.name) : notRead }, { label: t(msgid('PHP version')), valueHtml: usage?.phpVersion ? technical(usage.phpVersion) : notRead }, { label: t(msgid('Disk usage')), valueHtml: value(usage?.diskBytes, ' B') }, { label: t(msgid('Memory')), valueHtml: value(usage?.memoryBytes, ' B') }, { label: t(msgid('Processes')), valueHtml: value(usage?.processCount) }, { label: t(msgid('Bandwidth')), valueHtml: esc(t(msgid('Not measured'))) }]))
  const limits = section('v2-server-information-scope', t(msgctxt('theme:v2', 'Observation scope')),
    `<p>${esc(t(msgid('Only explicitly read account information is shown. Missing measurements remain unavailable.')))}</p><p>${esc(t(msgctxt('theme:v2', 'The account view does not establish the operating system, global service health or host-wide resource use.')))}</p>`)
  return page(locale, route, header(t, route, title, t(msgid('Only explicitly read account information is shown. Missing measurements remain unavailable.'))) + identity + limits)
}
