import { WEB_DISK_CLIENT_GUIDES } from '../../../../../models/dav-client-guide.ts'
import type { PanelSurfaceProps } from '../../../../contract.ts'
import { actions, button, check, esc, facts, field, fields, input, link, note, page, section, select, settingsContext, split, status, table, unreadRow, NO_SETTINGS_AUTHORITY, type PanelSettingsAuthority } from '../settings/common.ts'
import { V2_WEB_DISK_TEMPLATES, v2DavGuide } from './dav-connection.ts'

/** Logins and connection facts are read by the shared controller, which checks each change by reading it back. */
export function renderV2WebDiskPage(props: PanelSurfaceProps, authority: PanelSettingsAuthority = NO_SETTINGS_AUTHORITY): string {
  const c = settingsContext(props, authority), { t } = c, title = t(msgid('Web Disk')), description = t(msgid('Reach your files from a computer or phone as a network drive over HTTPS.'))
  const notRead = t(msgctxt('theme:v2', 'Web Disk logins have not been read.')), heading = t(msgctxt('theme:v2', 'Web Disk accounts'))
  const logins = section('v2-webdisk-users', heading, table('v2-webdisk-table', heading, [t(msgid('Login')), t(msgid('Access'))], unreadRow(2, notRead), { 'data-web-disk-rows': true })
    + status(notRead, { 'data-web-disk-status': true }), actions(button(t(msgid('Read logins')), { 'data-web-disk-refresh': true }, !c.editable)))
  const create = section('v2-webdisk-create', t(msgctxt('theme:v2', 'Create Web Disk account')), `<h3 data-web-disk-form-title>${esc(t(msgid('Add a Web Disk login')))}</h3>`
    + fields(field('v2-webdisk-login', t(msgid('Username')), input('v2-webdisk-login', '', 'text', ' dir="ltr" autocomplete="off" spellcheck="false" maxlength="64" data-web-disk-local'))
      + field('v2-webdisk-domain', t(msgid('Domain')), select('v2-webdisk-domain', '', [], ' dir="ltr" data-web-disk-domain'))
      + field('v2-webdisk-password', t(msgid('Password')), input('v2-webdisk-password', '', 'password', ' dir="ltr" autocomplete="new-password" data-web-disk-password'), t(msgid('At least 8 characters. Leave it empty while changing a login to keep the current password.')))
      + field('v2-webdisk-directory', t(msgid('Directory')), input('v2-webdisk-directory', '', 'text', ' dir="ltr" autocomplete="off" spellcheck="false" maxlength="240" value="public_html" data-web-disk-directory'), t(msgid('Relative to {home}. It is created if it does not exist and may not contain blanks. FTP uses the same directory for this login.'), { home: c.account?.home ?? '' })))
    + check('v2-webdisk-readonly', t(msgid('Read only')), { 'data-web-disk-read-only': true }),
    actions(button(t(msgid('Add login')), { 'data-web-disk-save': true }, true, true) + `<button type="button" class="v2-btn" data-web-disk-cancel hidden disabled>${esc(t(msgid('Cancel')))}</button>`))
  const connection = section('v2-webdisk-connect', t(msgctxt('theme:v2', 'Connect a client')), facts([
    { label: t(msgid('Web Disk address')), valueHtml: `<ul data-web-disk-addresses></ul><span class="v2-panel-settings__blank">${esc(t(msgid('Not read')))}</span>` },
    { label: t(msgid('Sign-in')), valueHtml: esc(t(msgid('The login and its password. The main login uses the account password.'))) },
    { label: t(msgid('Encryption')), valueHtml: esc(t(msgid('HTTPS only. Plain HTTP is not offered.'))) },
    { label: t(msgid('Storage')), valueHtml: esc(t(msgid('Files count toward the account disk quota.'))) },
  ]) + '<p class="v2-muted" data-web-disk-unsecured hidden></p>', actions(button(t(msgid('Download connection settings')), { 'data-web-disk-download': true })))
  const clients = section('v2-webdisk-clients', t(msgid('Set up a client')), v2DavGuide(t, WEB_DISK_CLIENT_GUIDES, 'v2-panel-settings__facts'))
  const users = section('v2-webdisk-service-users', t(msgid('How service users work')), `<p>${esc(t(msgid('Email, FTP and Web Disk credentials are separate from account control-panel access.')))}</p>`, actions(link(t(msgid('Open email and users')), '/email/accounts')))
  return page(props, authority, '/files/web-disk', title, description,
    `<div class="v2-panel-settings__groups" data-account-web-disk data-account="${esc(c.account?.id ?? '')}" data-web-disk-manage="${c.editable}" data-web-disk-home="${esc(c.account?.home ?? '')}">${V2_WEB_DISK_TEMPLATES}${split(logins + create, connection + users)}${clients}</div>`)
}
