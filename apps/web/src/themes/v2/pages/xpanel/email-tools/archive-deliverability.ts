import { mailxArchiveClientTemplates } from './mailx-collection-client-templates.ts'
import type { PanelSurfaceProps } from '../../../../contract.ts'
import { actions, button, emailContext, esc, facts, header, page, panelMailCards, section, state, table, unread, type PanelEmailAuthority } from './common.ts'

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

/** Live DNS checks and routing for the account's own domains; saved names alone establish nothing. */
export function renderV2PanelDeliverability(props: PanelSurfaceProps, authority?: PanelEmailAuthority): string {
  const { locale, t, account, canManage } = emailContext(props, authority)
  const route = '/email/deliverability', title = t(msgid('Deliverability'))
  const inert = !authority?.canRead || authority.presentation === 'read-only' || !account
  return page(locale, route, header(t, route, title, t(msgctxt('theme:v2', 'Review each domain without inferring SPF, DKIM, DMARC or SMTP success from saved configuration.'))) + panelMailCards(route, locale, t, !inert, canManage), inert ? { 'data-readonly': 'true' } : undefined)
}
