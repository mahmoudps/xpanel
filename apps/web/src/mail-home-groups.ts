import './i18n.ts'

/** Webmail Home tiles, grouped as cPanel does; a tile shows only when its route is open for this mailbox. */
export const MAIL_HOME_GROUPS: readonly { title: string; tiles: readonly { route: string; label: string }[] }[] = [
  { title: msgid('Manage inbox'), tiles: [{ route: '/mail/settings/autoresponder', label: msgid('Autoresponders') }, { route: '/mail/settings/filters', label: msgid('Filters') }, { route: '/mail/settings/forwarders', label: msgid('Forwarders') }] },
  { title: msgid('Calendars and contacts'), tiles: [{ route: '/mail/calendar', label: msgid('Calendar') }, { route: '/mail/contacts', label: msgid('Contacts') }] },
  { title: msgid('Edit settings'), tiles: [{ route: '/mail/settings/preferences', label: msgid('Preferences') }, { route: '/mail/settings/identities', label: msgid('Identities') }, { route: '/mail/settings/security', label: msgid('Security') }] },
  { title: msgid('Fight spam'), tiles: [{ route: '/mail/settings/spam', label: msgid('Spam preferences') }] },
  { title: msgid('Other features'), tiles: [{ route: '/mail/tools/disk-usage', label: msgid('Manage disk usage') }, { route: '/mail/tools/connect-devices', label: msgid('Connect devices') }, { route: '/mail/tools/track-delivery', label: msgid('Track delivery') }, { route: '/mail/tools/mailing-lists', label: msgid('Mailing lists') }] },
]

export const mailHomeGroups = (allowed: ReadonlySet<string>): { title: string; tiles: { route: string; label: string }[] }[] =>
  MAIL_HOME_GROUPS.map(group => ({ title: group.title, tiles: group.tiles.filter(tile => allowed.has(tile.route)) })).filter(group => group.tiles.length > 0)
