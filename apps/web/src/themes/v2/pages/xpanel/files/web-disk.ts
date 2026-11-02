import type { PanelSurfaceProps } from '../../../../contract.ts'
import { actions, button, check, deniedPage, esc, facts, field, fields, input, note, page, section, settingsContext, split, table, technical, unreadRow, NO_SETTINGS_AUTHORITY, type PanelSettingsAuthority } from '../settings/common.ts'

export function renderV2WebDiskPage(props: PanelSurfaceProps, authority: PanelSettingsAuthority = NO_SETTINGS_AUTHORITY): string {
  const c = settingsContext(props, authority), { t } = c, title = t(msgid('Web Disk')), description = t(msgctxt('theme:v2', 'Review stored Web Disk logins and directories without assuming that remote access is active.'))
  const users = c.account && c.factsReadable ? props.serviceUsers?.filter(user => user.accountId === c.account!.id && user.services.webdisk) : undefined
  const rows = users?.map(user => `<tr><td>${technical(user.login)}</td><td>${technical(user.ftpDir)}</td><td>${esc(t(msgid('Not read')))}</td><td>${actions(button(t(msgid('Edit'))) + button(t(msgid('Delete'))))}</td></tr>`).join('')
    || unreadRow(4, users ? t(msgctxt('theme:v2', 'No Web Disk logins were returned.')) : t(msgctxt('theme:v2', 'Web Disk logins have not been read.')))
  const logins = section('v2-webdisk-users', t(msgctxt('theme:v2', 'Web Disk accounts')), table('v2-webdisk-table', t(msgctxt('theme:v2', 'Web Disk accounts')), [t(msgid('Login')), t(msgid('Directory')), t(msgctxt('theme:v2', 'Access mode')), t(msgid('Actions'))], rows)
    + note(t(msgid('Stored WebDisk logins and directories are shown only after an authorized read. Access changes are unavailable.'))))
  const create = section('v2-webdisk-create', t(msgctxt('theme:v2', 'Create Web Disk account')), fields(field('v2-webdisk-login', t(msgid('Username')), input('v2-webdisk-login', '', 'text', ' dir="ltr" autocomplete="off"')) + field('v2-webdisk-password', t(msgid('Password')), input('v2-webdisk-password', '', 'password', ' dir="ltr" autocomplete="new-password"')) + field('v2-webdisk-directory', t(msgid('Directory')), input('v2-webdisk-directory', '', 'text', ' dir="ltr"')))
    + check('v2-webdisk-readonly', t(msgid('Read only'))), actions(button(t(msgid('Create user')), undefined, true, true)))
  const connection = section('v2-webdisk-connect', t(msgctxt('theme:v2', 'Connect a client')), facts([{ label: t(msgctxt('theme:v2', 'Connection address')), valueHtml: esc(t(msgid('Not read'))) }, { label: t(msgctxt('theme:v2', 'Access mode')), valueHtml: esc(t(msgid('Not read'))) }, { label: t(msgid('Status')), valueHtml: esc(t(msgid('Not checked'))) }])
    + note(t(msgctxt('theme:v2', 'An enabled service flag is a saved setting. It does not establish that a WebDAV listener, TLS or a client connection was verified.'))), actions(button(t(msgctxt('theme:v2', 'Download connection settings')))))
  return page(props, authority, '/files/web-disk', title, description, split(logins + create, connection), { 'data-wiring': 'unavailable' })
}
