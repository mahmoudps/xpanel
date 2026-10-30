import { mailxCollectionsClientTemplates } from './mailx-collection-client-templates.ts'
import { accountCollaborationClientTemplates } from './routing-client-templates.ts'
import type { PanelSurfaceProps } from '../../../../contract.ts'
import { actions, button, emailContext, esc, facts, field, fields, header, input, missingAccount, page, section, select, state, table, unread, type PanelEmailAuthority } from './common.ts'

export function renderV2PanelCalendarsContacts(props: PanelSurfaceProps, authority?: PanelEmailAuthority): string {
  const { locale, t, account, canManage } = emailContext(props, authority)
  const route = '/email/calendars-contacts', title = t(msgid('Calendars and contacts'))
  const empty = t(msgid('Saved mailbox collections have not been read.'))
  const owned = section('v2-collaboration-collections', t(msgid('Mailbox collections')),
    actions(button(t(msgid('Read saved collections')), { 'data-collaboration-refresh': true }, !canManage))
    + state(empty, { 'data-collaboration-status': true })
    + table('v2-collaboration-records', t(msgid('Saved mailbox collections')), [t(msgid('Mailbox')), t(msgid('Name')), t(msgid('Type')), t(msgid('Saved items')), t(msgid('Settings'))], unread(t, 5), { 'data-collaboration-collections': true })
    + `<p>${esc(t(msgid('This account overview includes only current owned mailbox metadata. Event bodies and contact details are managed in an independently authenticated xMail session. Unverified legacy ownership is withheld without exposing its records or counts.')))}</p>`)
  const creation = section('v2-collaboration-create', t(msgid('Create a calendar')),
    fields(field('collaboration-mailbox', t(msgid('Owner mailbox')), select('collaboration-mailbox', [['', t(msgid('Read mailboxes first'))]], { 'data-collaboration-mailbox': true }, true, ' dir="ltr"'))
      + field('collaboration-type', t(msgid('Collection type')), select('collaboration-type', [['calendar', t(msgctxt('account-collaboration-workspace', 'Calendar'))]]))
      + field('collaboration-name', t(msgid('Calendar name')), input('collaboration-name', { 'data-collaboration-name': true }, ' type="text" maxlength="200" autocomplete="off"'))
      + field('collaboration-color', t(msgid('Color (HEX)')), input('collaboration-color', { 'data-collaboration-color': true }, ' type="text" dir="ltr" maxlength="7" value="#4f6bed" autocomplete="off" spellcheck="false"'))
      + field('collaboration-timezone', t(msgid('Time zone')), input('collaboration-timezone', { 'data-collaboration-timezone': true }, ' type="text" dir="ltr" maxlength="100" value="UTC" autocomplete="off" spellcheck="false"')))
    + `<p>${esc(t(msgid('Creates a real saved calendar for the selected mailbox using its existing writer and current ownership. Calendar edit and delete, defaults, descriptions, address books and task lists are in Collection settings below.')))}</p>`
    + actions(button(t(msgid('Create calendar')), { 'data-collaboration-create': true }, true, true)))
  const sharing = section('v2-collaboration-sharing', t(msgid('Current calendar sharing')),
    table('v2-collaboration-shares', t(msgid('Current same-account sharing')), [t(msgid('Owner')), t(msgid('Calendar')), t(msgid('Recipient')), t(msgctxt('account-collaboration-workspace', 'Permission'))], unread(t, 4), { 'data-collaboration-shares': true })
    + actions(button(t(msgid('Share collection'))) + button(t(msgid('Change permission'))) + button(t(msgid('Revoke share'))))
    + `<p>${esc(t(msgid('Only currently bound grants between mailboxes in this account appear here. Sharing changes require the existing xMail owner workflow; this portal does not change its permissions.')))}</p>`)
  const handoff = (landing: 'calendar' | 'contacts', label: string): string => `<span class="v2-panel-extra__handoff" data-handoff-control>${button(label, { 'data-handoff': 'xmail', 'data-handoff-mailbox-select': 'collaboration-mailbox', 'data-handoff-landing': landing, 'data-handoff-state': 'idle' }, !canManage)}<span data-handoff-status role="status" aria-live="polite" hidden></span></span>`
  const clients = section('v2-collaboration-clients', t(msgid('xMail and device setup')),
    actions(handoff('calendar', t(msgid('Open xMail calendars'))) + handoff('contacts', t(msgid('Open xMail contacts'))))
    + `<p>${esc(t(msgid('Opens the selected mailbox in xMail in a new tab with a sign-in link that works once. The account session and password are not transferred; reading messages there still requires the mailbox password.')))}</p>`
    + `<p>${esc(t(msgid('CalDAV/CardDAV service URLs, principal paths, direct DAV collection URLs, synchronization and device discovery have not been qualified. No DAV port or credential endpoint is assumed. iOS, macOS, Thunderbird and third-party Android/Outlook sync setup remain unavailable until a verified DAV provider supplies those settings.')))}</p>`)
  const tag = canManage ? 'form' : 'div'
  const calendarEditor = section('v2-mailx-calendar', t(msgid('Edit or delete a calendar')),
    `<${tag} class="v2-panel-extra__editor" data-mailx-calendar-editor${canManage ? ' novalidate' : ''}>`
    + fields(field('mailx-calendar-mailbox', t(msgid('Owner mailbox')), select('mailx-calendar-mailbox', [], { 'data-mailx-calendar-mailbox': true }, true, ' dir="ltr"'))
      + field('mailx-calendar-target', t(msgid('Calendar')), select('mailx-calendar-target', [], { 'data-mailx-calendar-target': true }, true, ' dir="ltr"'))
      + field('mailx-calendar-name', t(msgid('Calendar name')), input('mailx-calendar-name', { 'data-mailx-calendar-name': true }, ' type="text" maxlength="200" autocomplete="off"'))
      + field('mailx-calendar-color', t(msgid('Color (HEX)')), input('mailx-calendar-color', { 'data-mailx-calendar-color': true }, ' type="text" dir="ltr" maxlength="7" autocomplete="off" spellcheck="false"'))
      + field('mailx-calendar-timezone', t(msgid('Time zone')), input('mailx-calendar-timezone', { 'data-mailx-calendar-timezone': true }, ' type="text" dir="ltr" maxlength="100" autocomplete="off" spellcheck="false"')))
    + state(t(msgid('Saved calendars have not been read.')), { 'data-mailx-calendar-status': true })
    + actions(button(t(msgid('Edit collection')), { 'data-mailx-calendar-save': true }, true, true) + button(t(msgid('Delete collection')), { 'data-mailx-calendar-delete': true })) + `</${tag}>`)
  const collectionList = (kind: 'address-books' | 'task-lists', label: string, add: string): string =>
    `<section class="v2-panel-extra__groups"${!authority?.canRead || authority.presentation === 'read-only' || !account ? ' data-readonly="true"' : ''}><h3>${esc(label)}</h3>${table(`v2-${kind}`, label, [t(msgid('Name')), t(msgid('Description')), t(msgid('Default')), t(msgid('Actions'))], unread(t, 4), { [`data-mailx-${kind}`]: true })}${actions(button(add, { 'data-mailx-add': kind }))}</section>`
  const settings = section('v2-mailx-settings', t(msgid('Collection settings')),
    `<${tag} class="v2-panel-extra__editor" data-mailx-collections-form${canManage ? ' novalidate' : ''}><p>${esc(t(msgid('Defaults, descriptions, address books and task lists are saved for each mailbox. They are offered to calendar and contact apps only after a DAV server is connected.')))}</p>`
    + fields(field('mailx-collections-mailbox', t(msgid('Mailbox')), select('mailx-collections-mailbox', [], { 'data-mailx-collections-mailbox': true }, true, ' dir="ltr"'))
      + field('mailx-collections-default', t(msgid('Default calendar')), select('mailx-collections-default', [], { 'data-mailx-collections-default': true }, true, ' dir="ltr"')))
    + `<div class="v2-panel-extra__fields" data-mailx-descriptions><p>${esc(t(msgid('Nothing has been read.')))}</p></div>`
    + collectionList('address-books', t(msgid('Address books')), t(msgid('Add address book'))) + collectionList('task-lists', t(msgid('Task lists')), t(msgid('Add task list')))
    + state(t(msgid('Collection settings have not been read.')), { 'data-mailx-collections-status': true })
    + actions(`<button type="${canManage ? 'submit' : 'button'}" class="v2-btn v2-btn--primary" data-mailx-collections-save disabled>${esc(t(msgid('Save collection settings')))}</button>` + button(t(msgid('Refresh')), { 'data-mailx-collections-refresh': true }, !canManage)) + `</${tag}>`)
  const dav = section('v2-mailx-dav', t(msgid('Calendar and contact sync (CalDAV and CardDAV)')),
    `<p data-state="unavailable" role="status">${esc(t(msgid('Sync is unavailable: no CalDAV or CardDAV server is installed and connected to these mailboxes.')))}</p>`
    + facts([{ label: t(msgid('CalDAV server address')), valueHtml: esc(t(msgid('Not available'))) }, { label: t(msgid('CardDAV server address')), valueHtml: esc(t(msgid('Not available'))) }, { label: t(msgid('Sign-in')), valueHtml: esc(t(msgid('Full mailbox address and its password, once a DAV server is connected'))) }, { label: t(msgid('Sync state')), valueHtml: esc(t(msgid('Unavailable'))) }])
    + `<p>${esc(t(msgid('Missing native step: install a CalDAV/CardDAV server (for example Radicale), make it authenticate mailboxes through Dovecot and serve these saved calendars, contacts, address books and task lists, then qualify it on this server.')))}</p>`)
  return page(locale, route, header(t, route, title, t(msgctxt('theme:v2', 'Manage saved mailbox collections and open their independent xMail workflows.')))
    + `<div class="v2-panel-extra__groups"${!authority?.canRead || authority.presentation === 'read-only' || !account ? ' data-readonly="true"' : ''} data-account-collaboration data-collaboration-enabled="${canManage}">${owned}${creation}${sharing}${clients}${accountCollaborationClientTemplates()}</div>`
    + `<div class="v2-panel-extra__groups"${!authority?.canRead || authority.presentation === 'read-only' || !account ? ' data-readonly="true"' : ''} data-mailx-collections data-mailx-can-manage="${canManage}">${calendarEditor}${settings}${dav}${mailxCollectionsClientTemplates()}</div>`)
}
