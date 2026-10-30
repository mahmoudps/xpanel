import type { PanelSurfaceProps } from '../../../../contract.ts'
import { icon, type IconName } from '../../../icons.ts'
import { V2_SECURITY_SLOT } from '../../../surfaces/slots.ts'
import { accountSessionClientTemplates } from '../settings/utility-client-templates.ts'
import { actions, area, button, check, deniedPage, esc, facts, field, fields, input, link, note, page, section, settingsContext, split, status, table, technical, unreadRow, NO_SETTINGS_AUTHORITY, type PanelSettingsAuthority } from '../settings/common.ts'

/** Core inserts the selected theme's factor controls into exactly one explicit slot. */
export function renderV2AccountSecurityPage(props: PanelSurfaceProps, authority: PanelSettingsAuthority = NO_SETTINGS_AUTHORITY): string {
  const c = settingsContext(props, authority), { t } = c
  const title = t(msgid('Account security')), description = t(msgid('Sign-in, API credentials, SSH access and site protection.'))
  const nav = `<nav class="v2-panel-settings__tabs" aria-label="${esc(t(msgctxt('theme:v2', 'Security sections')))}">${[
    ['v2-account-security-summary', msgid('Overview')], ['account-security-heading', msgctxt('theme:v2', 'Two-factor sign-in')], ['v2-account-password', msgid('Password')], ['v2-account-sessions', msgid('Active sessions')], ['v2-account-tokens', msgid('API tokens')], ['v2-account-ssh', msgid('SSH keys')], ['v2-account-ip', msgid('IP blocker')], ['v2-account-hotlink', msgid('Hotlink protection')], ['v2-account-privacy', msgid('Directory privacy')],
  ].map(([id, label]) => link(t(label!), `#${id}`)).join('')}</nav>`
  const checks: readonly { title: string; icon: IconName; anchor: string }[] = [
    { title: t(msgid('Password')), icon: 'shield', anchor: 'v2-account-password' },
    { title: t(msgctxt('theme:v2', 'Two-factor sign-in')), icon: 'check', anchor: 'account-security-heading' },
    { title: t(msgid('Active sessions')), icon: 'user', anchor: 'v2-account-sessions' },
    { title: t(msgid('API tokens')), icon: 'code', anchor: 'v2-account-tokens' },
    { title: t(msgid('SSH access')), icon: 'tools', anchor: 'v2-account-ssh' },
    { title: t(msgctxt('theme:v2', 'Site protection')), icon: 'globe', anchor: 'v2-account-privacy' },
  ]
  const summary = section('v2-account-security-summary', t(msgctxt('theme:v2', 'Security status')), `<div class="v2-settings-security-checks">${checks.map(item => `<a class="v2-settings-security-check" href="#${item.anchor}" data-v2-security-check><span class="v2-tile v2-tile--neutral" aria-hidden="true">${icon(item.icon)}</span><span class="v2-field"><strong>${esc(item.title)}</strong><span class="v2-muted">${esc(t(msgid('Not read')))}</span></span>${icon('chevRight', 16)}</a>`).join('')}</div>`
    + note(t(msgctxt('theme:v2', 'Stored settings and open sessions do not establish live website protection. Each workspace reads its own current state.'))))
  const password = section('v2-account-password', t(msgid('Password')), fields(
    field('v2-security-current-password', t(msgid('Current password')), input('v2-security-current-password', '', 'password', ' dir="ltr" autocomplete="current-password"'))
    + field('v2-security-new-password', t(msgid('New password')), input('v2-security-new-password', '', 'password', ' dir="ltr" autocomplete="new-password" minlength="12"'))
    + field('v2-security-repeat-password', t(msgctxt('theme:v2', 'Repeat new password')), input('v2-security-repeat-password', '', 'password', ' dir="ltr" autocomplete="new-password" minlength="12"')))
    + check('v2-security-show-password', t(msgctxt('theme:v2', 'Show passwords')))
    + note(t(msgctxt('theme:v2', 'Password changes are not connected to this workspace. These fields remain disabled.'))), actions(button(t(msgid('Change password')), undefined, true, true)))
  const sessions = section('v2-account-sessions', t(msgid('Active sessions')), accountSessionClientTemplates() + note(t(msgid('Sessions signed in to this account. Ending a session makes its next request require signing in again; the current session can also be ended.')))
    + '<div class="v2-panel-settings__groups" data-sessions-rows></div>'
    + status(t(msgctxt('theme:v2', 'Active sessions have not been read.')), { 'data-sessions-status': true }), actions(button(t(msgid('Sign out other sessions')), { 'data-sessions-revoke-others': true }, !c.editable)), { 'data-account-sessions': true, 'data-readonly': c.editable ? undefined : 'true' })
  const scopes = ['files:read', 'files:write', 'databases:read', 'dns:write', 'email:write', 'backups:create', 'cron:write']
  const tokens = section('v2-account-tokens', t(msgid('API tokens')), table('v2-account-token-list', t(msgid('API token list')), [t(msgid('Name')), t(msgid('Scopes')), t(msgid('Allowed from')), t(msgid('Created')), t(msgid('Expires')), t(msgid('Last used')), t(msgid('Actions'))], unreadRow(7, t(msgctxt('theme:v2', 'Token metadata has not been read.'))))
    + fields(field('v2-token-name', t(msgid('Name')), input('v2-token-name', '', 'text', ' dir="ltr" maxlength="40" autocomplete="off"'))
      + field('v2-token-expiry', t(msgctxt('theme:v2', 'Expires after')), `<span class="v2-select"><select id="v2-token-expiry" disabled><option>${esc(t(msgctxt('theme:v2', 'Choose an expiry')))}</option></select></span>`)
      + field('v2-token-addresses', t(msgctxt('theme:v2', 'Allowed addresses (optional)')), area('v2-token-addresses', '', ' dir="ltr" rows="3" autocomplete="off" spellcheck="false"')))
    + `<fieldset disabled><legend>${esc(t(msgid('Scopes')))}</legend>${scopes.map((scope, i) => check(`v2-token-scope-${i}`, scope)).join('')}</fieldset>`
    + note(t(msgid('No token was issued by this workspace. A newly issued secret must be shown only once and must not be reconstructed from the token list.'))), actions(button(t(msgid('Create token')), undefined, true, true) + button(t(msgid('Revoke')))))
  const ssh = section('v2-account-ssh', t(msgid('SSH keys')), table('v2-account-ssh-summary', t(msgid('SSH keys')), [t(msgid('Name')), t(msgid('Fingerprint')), t(msgid('Added')), t(msgid('Actions'))], unreadRow(4, t(msgctxt('theme:v2', 'The key list has not been read in this overview.'))))
    + fields(field('v2-security-key-name', t(msgid('Name')), input('v2-security-key-name', '', 'text', ' dir="auto"')) + field('v2-security-key', t(msgid('Public key')), area('v2-security-key', '', ' dir="ltr" rows="4" autocomplete="off" spellcheck="false"')))
    + facts([{ label: t(msgid('Shell access')), valueHtml: esc(t(msgid('Not read'))) }]), actions(button(t(msgid('Add key'))) + (authority.relatedRoutes?.has('/security/ssh') ? link(t(msgid('SSH access')), '/security/ssh') : '')))
  const blocked = section('v2-account-ip', t(msgid('IP blocker')), fields(field('v2-security-blocked-address', t(msgid('Address or range')), input('v2-security-blocked-address', '', 'text', ' dir="ltr" maxlength="64"')))
    + table('v2-account-blocked-addresses', t(msgid('Blocked addresses')), [t(msgid('Address or range')), t(msgid('Covers'))], unreadRow(2, t(msgid('Not read')))), actions(button(t(msgid('Block address'))) + (authority.relatedRoutes?.has('/security/ip-blocker') ? link(t(msgid('IP blocker')), '/security/ip-blocker') : '')))
  const hotlink = section('v2-account-hotlink', t(msgid('Hotlink protection')), fields(field('v2-security-hotlink-hosts', t(msgid('Sites allowed to embed')), area('v2-security-hotlink-hosts', '', ' dir="ltr" rows="4"')) + field('v2-security-hotlink-extensions', t(msgid('File types')), input('v2-security-hotlink-extensions', '', 'text', ' dir="ltr"')))
    + check('v2-security-hotlink-referrer', t(msgid('Allow requests with no referrer'))), actions(button(t(msgid('Save hotlink rules'))) + (authority.relatedRoutes?.has('/security/hotlink') ? link(t(msgid('Hotlink protection')), '/security/hotlink') : '')))
  const privacy = section('v2-account-privacy', t(msgid('Directory privacy')), table('v2-account-protected-folders', t(msgid('Protected folders')), [t(msgid('Folder')), t(msgid('Prompt')), t(msgid('Users'))], unreadRow(3, t(msgid('Not read'))))
    + fields(field('v2-security-private-folder', t(msgid('Folder')), input('v2-security-private-folder', '', 'text', ' dir="ltr"')) + field('v2-security-private-prompt', t(msgid('Prompt shown')), input('v2-security-private-prompt', '', 'text', ' dir="auto"')) + field('v2-security-private-user', t(msgctxt('theme:v2', 'First user')), input('v2-security-private-user', '', 'text', ' dir="ltr" autocomplete="off"')) + field('v2-security-private-password', t(msgctxt('theme:v2', 'Password for this user')), input('v2-security-private-password', '', 'password', ' dir="ltr" autocomplete="new-password"'))), actions(button(t(msgid('Protect folder'))) + (authority.relatedRoutes?.has('/files/directory-privacy') ? link(t(msgid('Directory privacy')), '/files/directory-privacy') : '')))
  const native = (html: string): string => c.readable ? html : `<div class="v2-panel-settings" data-readonly="true" data-qualified="false">${html}</div>`
  return page(props, authority, '/security/account', title, description, native(nav + summary) + V2_SECURITY_SLOT + native(password + sessions + tokens + ssh + blocked + hotlink + privacy))
}
