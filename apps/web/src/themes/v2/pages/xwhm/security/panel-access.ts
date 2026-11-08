import { actions, button, check, esc, facts, field, fields, help, inputControl, section, select, status, table } from '../monitoring/common.ts'
import type { Translate } from '../../../../../i18n.ts'

const ENTRY = [['xpanel', msgid('xPanel')], ['xwhm', msgid('xWHM')], ['xmail', msgid('xMail')]] as const

/** Everything past the allowlists on Panel access. The sec kit's panel access binding fills these from GET /api/server/panel-access. */
export function v2PanelAccessSections(t: Translate, canRead: boolean, canManage: boolean): string {
  const input = (key: string, label: string, extra = ' dir="ltr" autocomplete="off" spellcheck="false"', type = 'text', note?: string): string => field(t, `sec-${key}`, label, inputControl(`sec-${key}`, { 'data-sec-input': key }, false, extra, type), note)
  const checks = (prefix: string, rows: readonly (readonly [string, string])[]): string => fields(rows.map(([name, label]) => check(t, label, { 'data-sec-input': `${prefix}-${name}` })).join(''))
  const act = (key: string, label: string, primary = false): string => button(t, label, { 'data-sec-action': key }, false, primary)
  const body = status(t, canRead ? msgid('Nothing has been read yet.') : msgid('This page requires an authorized administrator. Nothing was read or changed.'), { 'data-sec-status': true }, canRead ? 'unread' : 'unavailable')
    + status(t, '', { 'data-sec-result': true }, 'unread', true)
    + section(t, 'access-address', msgid('Panel address'), help(t, msgid('Each entry point has its own port and host name. The new port opens in the firewall before the switch; the old port stays open until you keep the new address.'))
      + facts(t, [['pa-origin-xpanel', msgid('xPanel address')], ['pa-origin-xwhm', msgid('xWHM address')], ['pa-origin-xmail', msgid('xMail address')], ['pa-trial', msgid('Waiting change')], ['pa-lifecycle', msgid('Last change')]], 'data-sec-field')
      + fields(ENTRY.map(([name, label]) => input(`pa-port-${name}`, t(msgid('{name} port'), { name: t(label) }), ' dir="ltr" inputmode="numeric" min="1" max="65535" step="1"', 'number')).join(''))
      + fields(ENTRY.map(([name, label]) => input(`pa-host-${name}`, t(msgid('{name} host name'), { name: t(label) }), undefined, 'text', msgid('Empty uses the server host name.'))).join(''))
      + help(t, msgid('Open a new port at your cloud provider first. A new host name needs a DNS record for this server; the certificate is reissued for it. Requests by address or by another name then get 403.'))
      + actions(act('pa-binding-save', msgid('Move the panel'), true) + act('pa-confirm', msgid('Keep this address')) + act('pa-revert', msgid('Go back now'))))
    + section(t, 'access-entrance', msgid('Secret entrance path'), help(t, msgid('Sign-in opens only after this path. People with an open session keep working.'))
      + facts(t, [['pa-entrance-url', msgid('Entrance address')]], 'data-sec-field') + check(t, msgid('Enable secret entrance path'), { 'data-sec-input': 'pa-entrance-on' })
      + fields(input('pa-entrance-path', msgid('Secret entrance path'), ' dir="ltr" minlength="8" maxlength="64" autocomplete="off" spellcheck="false"', 'text', msgid('At least 8 letters, digits, hyphens or underscores, with a digit.')))
      + checks('pa-entrance', ENTRY) + actions(act('pa-entrance-generate', msgid('Regenerate entrance path'))))
    + section(t, 'access-response', msgid('Unauthenticated response'), help(t, msgid('What a visitor without the entrance or a session gets. The answer carries no panel branding.'))
      + fields(field(t, 'sec-pa-response', msgid('Response'), select(t, 'sec-pa-response', { 'data-sec-input': 'pa-response' }, [['not-found', msgid('404 Not Found')], ['forbidden', msgid('403 Forbidden')], ['blank', msgid('Blank page')], ['redirect', msgid('Redirect')]])) + input('pa-response-url', msgid('Redirect address'), ' dir="ltr" maxlength="512" autocomplete="off" spellcheck="false"', 'url')))
    + section(t, 'access-basic', msgid('Basic authentication'), help(t, msgid('A second username and password in front of the sign-in page, separate from every panel account.'))
      + check(t, msgid('Require basic authentication'), { 'data-sec-input': 'pa-basic-on' })
      + fields(input('pa-basic-username', msgid('Username'), ' dir="ltr" maxlength="64" autocomplete="off" spellcheck="false"') + input('pa-basic-password', msgid('Password'), ' dir="ltr" autocomplete="new-password"', 'password', msgid('Leave empty to keep the saved password.')))
      + checks('pa-basic', ENTRY))
    + section(t, 'access-subpanel', msgid('Sub-panel service'), help(t, msgid('A stopped entry point answers 503 until you start it. xWHM cannot be stopped.'))
      + checks('pa-stop', ENTRY.filter(([name]) => name !== 'xwhm').map(([name, label]) => [name, t(msgid('Stop {name}'), { name: t(label) })] as const))
      + facts(t, [['pa-cert-names', msgid('Certificate names')], ['pa-cert-issuer', msgid('Issuer')], ['pa-cert-until', msgid('Valid until (UTC)')], ['pa-cert-fingerprint', msgid('Fingerprint')]], 'data-sec-field')
      + `<details><summary>${esc(t(msgid('Certificate content')))}</summary><pre dir="ltr" class="v2-mono v2-panel-access__code"><bdi dir="ltr" data-sec-field="pa-cert-pem"></bdi></pre></details>`
      + actions(act('pa-reload', msgid('Reload the web server')) + act('pa-restart', msgid('Restart the panel'))))
    + `<div class="v2-observation__actions">${button(t, msgid('Save access rules'), { 'data-sec-action': 'pa-gate-save' }, false, true)}${button(t, msgid('Refresh'), { 'data-sec-action': 'pa-refresh' }, canRead)}</div>`
    + section(t, 'access-temporary', msgid('Temporary sign-in links'), help(t, msgid('A link opens one read-only xWHM session for a helper. It cannot change anything or reach these settings, and each link has its own activity log.'))
      + facts(t, [['pa-updated', msgid('Last saved (UTC)')], ['pa-temp-url', msgid('New link')]], 'data-sec-field')
      + fields(input('pa-temp-lifetime', msgid('Lifetime, minutes'), ' dir="ltr" inputmode="numeric" min="5" max="1440" step="1" value="60"', 'number') + input('pa-temp-note', msgid('Note'), ' maxlength="128" autocomplete="off"'))
      + actions(act('pa-temp-create', msgid('Create link')))
      + table(t, msgid('Temporary links'), [msgid('Note'), msgid('State'), msgctxt('approved-xwhm', 'Expires'), msgid('Used (UTC)')], { 'data-sec-rows': 'pa-temporary' })
      + field(t, 'sec-pa-temp-pick', msgid('Link'), select(t, 'sec-pa-temp-pick', { 'data-sec-input': 'pa-temp-pick' }, []))
      + actions(act('pa-temp-revoke', msgid('Revoke link')) + act('pa-temp-activity', msgid('Show activity')))
      + table(t, msgid('Link activity'), [msgid('When (UTC)'), msgid('Request'), msgid('Outcome')], { 'data-sec-rows': 'pa-activity' }, msgid('Select a link.')))
    + section(t, 'access-recovery', msgid('Recovery from the server shell'), help(t, msgid('Locked out? As root on this server, these commands always work:'))
      + `<pre dir="ltr" class="v2-mono v2-panel-access__code">xpanel panel-access show\nxpanel panel-access reset all\nnode /opt/xpanel/current/scripts/management-tls.mjs reset-access</pre>`
      + help(t, msgid('The first shows the entrance. The second clears allowlists, the entrance, basic authentication and temporary links. The third returns the default ports and host names.')))
  return `<div data-panel-access data-sec-can-read="${canRead}" data-sec-can-manage="${canManage}">${body}</div>`
}
