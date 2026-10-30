import { mailxArchiveClientTemplates } from './mailx-collection-client-templates.ts'
import type { PanelSurfaceProps } from '../../../../contract.ts'
import { actions, button, emailContext, esc, facts, header, missingAccount, page, section, state, table, technical, unread, type PanelEmailAuthority } from './common.ts'

export function renderV2PanelEmailArchive(props: PanelSurfaceProps, authority?: PanelEmailAuthority): string {
  const { locale, t, account, canManage } = emailContext(props, authority)
  const route = '/email/archive', title = t(msgid('Email archive'))
  const summary = section('v2-email-archive-state', t(msgid('Archive state')),
    `<p>${esc(t(msgid('A copy of each archived message is delivered to the mailbox you choose and counts toward its quota.')))}</p>`
    + actions(button(t(msgid('Refresh')), { 'data-mailx-archive-refresh': true }, !canManage))
    + state(t(msgid('The email archive has not been read.')), { 'data-mailx-archive-status': true })
    + facts([
      { label: t(msgid('Saved policy')), key: 'saved' }, { label: t(msgid('Host agent')), key: 'host' }, { label: t(msgid('Applied on this server')), key: 'state' },
      { label: t(msgid('Observed at (UTC)')), key: 'observed-at' }, { label: t(msgid('Last saved')), key: 'updated' },
    ].map(row => ({ label: row.label, valueHtml: esc(t(msgid('Not read'))), hooks: { 'data-mailx-archive-fact': row.key } })))
    + `<p>${esc(t(msgid('Retention removes archived messages older than the number of days you set; 0 keeps them until you delete them. Retention runs only when you start it.')))}</p>`)
  const tag = canManage ? 'form' : 'div'
  const domains = section('v2-email-archive-domains', t(msgid('Archived domains')),
    `<${tag} class="v2-panel-extra__groups"${!authority?.canRead || authority.presentation === 'read-only' || !account ? ' data-readonly="true"' : ''} data-mailx-archive-form${canManage ? ' novalidate' : ''}>`
    + table('v2-email-archive-records', t(msgid('Archived domains')), [t(msgid('Domain')), t(msgid('Archive mailbox')), t(msgid('Incoming')), t(msgid('Outgoing')), t(msgid('Keep for days')), t(msgid('State')), t(msgid('Retention'))], unread(t, 7), { 'data-mailx-archive-rows': true })
    + `<p data-mailx-archive-form-status role="status"></p>`
    + actions(`<button type="${canManage ? 'submit' : 'button'}" class="v2-btn v2-btn--primary" data-mailx-archive-save disabled>${esc(t(msgid('Save and apply')))}</button>`) + `</${tag}>`)
  return page(locale, route, header(t, route, title, t(msgctxt('theme:v2', 'Choose owned archive destinations and keep saved retention separate from its observed execution.')))
    + `<div class="v2-panel-extra__groups"${!authority?.canRead || authority.presentation === 'read-only' || !account ? ' data-readonly="true"' : ''} data-mailx-archive data-mailx-can-manage="${canManage}">${summary}${domains}${mailxArchiveClientTemplates()}</div>`)
}

/** Saved names and records do not establish service, DNS or delivery health. */
export function renderV2PanelDeliverability(props: PanelSurfaceProps, authority?: PanelEmailAuthority): string {
  const { locale, t, account, domains } = emailContext(props, authority)
  const route = '/email/deliverability', title = t(msgid('Deliverability'))
  const notRead = esc(t(msgid('Not read')))
  const rows = domains === undefined ? unread(t, 5) : domains.length === 0
    ? `<tr><td colspan="5">${esc(t(msgid('The read returned no domains.')))}</td></tr>`
    : domains.map(domain => `<tr><td>${technical(domain.name)}</td><td>${notRead}</td><td>${notRead}</td><td>${notRead}</td><td>${notRead}</td></tr>`).join('')
  const checks = section('v2-email-deliverability', t(msgctxt('theme:v2', 'Domain delivery checks')),
    `<p data-check-state="unread" role="status">${esc(t(msgid('Service check results have not been read. Domain records do not establish DNS, TLS, SMTP or delivery health.')))}</p>`
    + table('v2-deliverability-domains', title, [t(msgid('Domain')), 'SPF', 'DKIM', 'DMARC', t(msgid('Service health'))], rows)
    + actions(button(t(msgid('Run checks')), { 'data-wiring': 'unavailable' })))
  const routing = section('v2-email-delivery-routing', t(msgctxt('theme:v2', 'Routing and sender identity')),
    facts([{ label: t(msgctxt('theme:v2', 'Mail routing')), valueHtml: notRead }, { label: t(msgctxt('theme:v2', 'Outbound address')), valueHtml: notRead }, { label: 'PTR / rDNS', valueHtml: notRead }, { label: t(msgctxt('theme:v2', 'Last delivery check')), valueHtml: notRead }])
    + `<p>${esc(t(msgctxt('theme:v2', 'These values require an authorized service observation. Stored domain names are shown for selection only.')))}</p>`)
  const inert = !authority?.canRead || authority.presentation === 'read-only' || !account
  return page(locale, route, header(t, route, title, t(msgctxt('theme:v2', 'Review each domain without inferring SPF, DKIM, DMARC or SMTP success from saved configuration.'))) + checks + routing, inert ? { 'data-readonly': 'true' } : undefined)
}
