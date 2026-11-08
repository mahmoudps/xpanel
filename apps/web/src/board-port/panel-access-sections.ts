import { escapeHtml } from '../tokens.ts'
import type { MessageValues } from '../i18n.ts'

interface Kit {
  t: (message: string, values?: MessageValues) => string
  card: (key: string, title: string, body: string, tools?: string) => string
  facts: (items: [string, string][]) => string
  field: (id: string, label: string, control: string, help?: string) => string
  text: (id: string, max: number, type?: string) => string
  number: (id: string, min: number, max: number) => string
  check: (id: string, label: string) => string
  select: (id: string, options: [string, string][]) => string
  button: (action: string, label: string, primary?: boolean) => string
  table: (key: string, caption: string, headers: string[], empty: string) => string
  actions: (...items: string[]) => string
}

/** Everything past the allowlists on Panel access, in the classic cards. The sec kit's panel access binding fills these. */
export function classicPanelAccessSections(k: Kit, canRead: boolean, canManage: boolean): string {
  const { t, card, facts, field, text, number, check, select, button, table, actions } = k
  const entry: [string, string][] = [['xpanel', t('xPanel')], ['xwhm', t('xWHM')], ['xmail', t('xMail')]]
  const help = (message: string): string => `<p class="xp-help">${t(message)}</p>`
  const grid = (body: string): string => `<div class="xp-sec__fields">${body}</div>`
  const status = `<p class="xp-whm-detail-status" data-sec-status data-state="${canRead ? 'unread' : 'unavailable'}" role="status">${canRead ? t('Nothing has been read yet.') : t('This page requires an authorized administrator. Nothing was read or changed.')}</p><p class="xp-whm-detail-status" data-sec-result role="status" hidden></p>`
  const body = status
    + card('address', t('Panel address'), `<p class="xp-help">${t('Each entry point has its own port and host name. The new port opens in the firewall before the switch; the old port stays open until you keep the new address.')}</p>
      ${facts([['pa-origin-xpanel', t('xPanel address')], ['pa-origin-xwhm', t('xWHM address')], ['pa-origin-xmail', t('xMail address')], ['pa-trial', t('Waiting change')], ['pa-lifecycle', t('Last change')]])}
      ${grid(entry.map(([name, label]) => field(`pa-port-${name}`, t('{name} port', { name: label }), number(`pa-port-${name}`, 1, 65535))).join(''))}
      ${grid(entry.map(([name, label]) => field(`pa-host-${name}`, t('{name} host name', { name: label }), text(`pa-host-${name}`, 248), t('Empty uses the server host name.'))).join(''))}
      ${help('Open a new port at your cloud provider first. A new host name needs a DNS record for this server; the certificate is reissued for it. Requests by address or by another name then get 403.')}
      ${actions(button('pa-binding-save', t('Move the panel'), true), button('pa-confirm', t('Keep this address')), button('pa-revert', t('Go back now')))}`)
    + card('entrance', t('Secret entrance path'), `${help('Sign-in opens only after this path. People with an open session keep working.')}${facts([['pa-entrance-url', t('Entrance address')]])}${check('pa-entrance-on', t('Enable secret entrance path'))}
      ${grid(field('pa-entrance-path', t('Secret entrance path'), text('pa-entrance-path', 64), t('At least 8 letters, digits, hyphens or underscores, with a digit.')))}${grid(entry.map(([name, label]) => check(`pa-entrance-${name}`, label)).join(''))}${actions(button('pa-entrance-generate', t('Regenerate entrance path')))}`)
    + card('response', t('Unauthenticated response'), `${help('What a visitor without the entrance or a session gets. The answer carries no panel branding.')}
      ${grid(field('pa-response', t('Response'), select('pa-response', [['not-found', t('404 Not Found')], ['forbidden', t('403 Forbidden')], ['blank', t('Blank page')], ['redirect', t('Redirect')]])) + field('pa-response-url', t('Redirect address'), text('pa-response-url', 512, 'url')))}`)
    + card('basic', t('Basic authentication'), `${help('A second username and password in front of the sign-in page, separate from every panel account.')}${check('pa-basic-on', t('Require basic authentication'))}
      ${grid(field('pa-basic-username', t('Username'), text('pa-basic-username', 64)) + field('pa-basic-password', t('Password'), text('pa-basic-password', 1024, 'password'), t('Leave empty to keep the saved password.')))}${grid(entry.map(([name, label]) => check(`pa-basic-${name}`, label)).join(''))}`)
    + card('subpanel', t('Sub-panel service'), `${help('A stopped entry point answers 503 until you start it. xWHM cannot be stopped.')}${grid(entry.filter(([name]) => name !== 'xwhm').map(([name, label]) => check(`pa-stop-${name}`, t('Stop {name}', { name: label }))).join(''))}
      ${facts([['pa-cert-names', t('Certificate names')], ['pa-cert-issuer', t('Issuer')], ['pa-cert-until', t('Valid until (UTC)')], ['pa-cert-fingerprint', t('Fingerprint')]])}
      <details><summary>${t('Certificate content')}</summary><pre dir="ltr" class="xp-mono xp-sec__code"><bdi dir="ltr" data-sec-field="pa-cert-pem"></bdi></pre></details>${actions(button('pa-reload', t('Reload the web server')), button('pa-restart', t('Restart the panel')))}`)
    + actions(button('pa-gate-save', t('Save access rules'), true), `<button type="button" class="xp-btn" data-sec-action="pa-refresh"${canRead ? '' : ' disabled'}>${t('Refresh')}</button>`)
    + card('temporary', t('Temporary sign-in links'), `${help('A link opens one read-only xWHM session for a helper. It cannot change anything or reach these settings, and each link has its own activity log.')}${facts([['pa-updated', t('Last saved (UTC)')], ['pa-temp-url', t('New link')]])}
      ${grid(field('pa-temp-lifetime', t('Lifetime, minutes'), number('pa-temp-lifetime', 5, 1440)) + field('pa-temp-note', t('Note'), text('pa-temp-note', 128)))}${actions(button('pa-temp-create', t('Create link')))}
      ${table('pa-temporary', t('Temporary links'), [t('Note'), t('State'), t(msgctxt('approved-xwhm', 'Expires')), t('Used (UTC)')], t('Not read'))}
      ${field('pa-temp-pick', t('Link'), select('pa-temp-pick', []))}${actions(button('pa-temp-revoke', t('Revoke link')), button('pa-temp-activity', t('Show activity')))}
      ${table('pa-activity', t('Link activity'), [t('When (UTC)'), t('Request'), t('Outcome')], t('Select a link.'))}`)
    + card('recovery', t('Recovery from the server shell'), `${help('Locked out? As root on this server, these commands always work:')}<pre dir="ltr" class="xp-mono xp-sec__code">${escapeHtml('xpanel panel-access show\nxpanel panel-access reset all\nnode /opt/xpanel/current/scripts/management-tls.mjs reset-access')}</pre>${help('The first shows the entrance. The second clears allowlists, the entrance, basic authentication and temporary links. The third returns the default ports and host names.')}`)
  return `<div class="xp-sec" data-panel-access data-sec-can-read="${canRead}" data-sec-can-manage="${canManage}">${body}</div>`
}
