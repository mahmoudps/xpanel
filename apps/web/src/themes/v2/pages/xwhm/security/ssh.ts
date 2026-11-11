import { renderV2RootIdentityCards } from '../../identity.ts'
import { kpiCard } from '../../../components/kpi-card.ts'
import { notice } from '../../../components/notice.ts'
import { actions, area, button, check, context, esc, facts, field, fields, help, inputControl, page, section, select, status, table, type WhmObservationInput } from '../monitoring/common.ts'
import { whmStoredFacts } from '../stored-facts.ts'

const SSH_TEMPLATES = '<template data-xp-template="whm-ssh-remove"><button type="button" class="v2-btn" data-whm-ssh-remove data-protected="true" disabled><span data-xp-slot="label"></span></button></template><template data-xp-template="whm-ssh-fact-technical"><div><dt data-xp-slot="label"></dt><dd><bdi dir="ltr" class="v2-mono v2-num" data-xp-slot="value"></bdi></dd></div></template><template data-xp-template="whm-ssh-fact-text"><div><dt data-xp-slot="label"></dt><dd><span data-xp-slot="value"></span></dd></div></template>'

export function renderV2WhmSsh(input: WhmObservationInput): string {
  const { t, canRead, canManage } = context(input)
  // A read-only page still shows the saved port, disabled.
  const portKnown = (canRead || whmStoredFacts(input, input.observationAuthority ?? {}, ['server-settings-edit'])) && Number.isInteger(input.serverSettings?.sshPort)
  const unread = t(msgid('Not read'))
  // The policy client writes sign-in counts into the two today tiles, so they keep the numeric value size; service state stays text.
  const tiles = `<section class="v2-kpi-row" aria-label="${esc(t(msgid('SSH service')))}">${([['active', msgid('Service')], ['enabled', msgid('Starts at boot')], ['today-accepted', msgid('Successful sign-ins today')], ['today-failed', msgid('Failed sign-ins today')]] as const).map(([key, label]) => { const tile = kpiCard({ label: t(label), value: unread, headingLevel: 2, valueHooks: { 'data-whm-ssh-fact': key } }); return key.startsWith('today-') ? tile.replace(' v2-kpi__value--text', '') : tile }).join('')}</section>`
  const openSessionsText = canRead && input.sshOpenSessions
    ? (input.sshOpenSessions.state === 'read' ? String(input.sshOpenSessions.count) : t(msgid('Unavailable')))
    : unread
  const sessionValue = canRead && input.adminSessionIp
    ? `<bdi class="v2-mono" dir="ltr">${esc(input.adminSessionIp)}</bdi>`
    : `<bdi dir="auto">${esc(unread)}</bdi>`
  const protection = notice(t, { tone: 'ok', lead: t(msgctxt('theme:v2', 'Current session protection.')), text: t(msgid('A change is tested with sshd before it loads, and open sessions stay connected. The new port opens in the firewall first; the old one closes only after sshd answers on the new port. A policy that would leave no way to sign in is refused.')) })
    .replace('</p>', `</p><p class="v2-muted">${esc(t(msgctxt('theme:v2', 'Your session')))} ${sessionValue}</p>`)
  const serviceFacts = facts(t, [['open-sessions', msgid('Open sessions')], ['total-accepted', msgid('Successful sign-ins in the journal')], ['total-failed', msgid('Failed sign-ins in the journal')]], 'data-whm-ssh-fact')
    .replace(`data-whm-ssh-fact="open-sessions">${esc(unread)}`, `class="v2-num" data-whm-ssh-fact="open-sessions">${esc(openSessionsText)}`)
  const body = tiles + protection + '<div class="v2-observation__columns">' + section(t, 'ssh-settings', msgid('Sign-in settings'), `<div class="v2-observation__groups" data-whm-ssh-policy data-whm-ssh-can-manage="${canManage && portKnown}">${fields(field(t, 'v2-ssh-port', msgid('Port'), inputControl('v2-ssh-port', { 'data-whm-ssh-port': true }, false, ` dir="ltr" min="1" max="65535" step="1"${portKnown ? ` value="${input.serverSettings!.sshPort}"` : ''}`, 'number'))
    + field(t, 'v2-ssh-auth', msgid('Authentication'), select(t, 'v2-ssh-auth', { 'data-whm-ssh-auth': true }, [['keys', msgctxt('approved-xwhm', 'Keys only')], ['both', msgctxt('approved-xwhm', 'Keys and password')], ['password', msgid('Password only')]]))
    + field(t, 'v2-ssh-root', msgid('Root sign-in'), select(t, 'v2-ssh-root', { 'data-whm-ssh-root': true }, [['prohibit-password', msgctxt('approved-xwhm', 'Keys only')], ['no', msgid('Not allowed')], ['yes', msgctxt('approved-xwhm', 'Keys and password')], ['forced-commands-only', msgid('Forced commands only')]])))}
    ${actions(button(t, msgid('Test and reload sshd'), { 'data-whm-ssh-apply': true }, false, true))}${status(t, msgid('Sign-in settings have not been read.'), { 'data-whm-ssh-policy-status': true })}</div>`)
    + section(t, 'ssh-service', msgid('SSH service'), serviceFacts
      + actions(button(t, msgid('Start service'), { 'data-whm-ssh-start': true }) + button(t, msgid('Stop service'), { 'data-whm-ssh-stop': true }))
      + help(t, msgid('Stopping refuses new connections. Open sessions and this panel stay up, and the service starts again at the next boot. Counts come from the journal; a plus sign means the read reached its limit.'))
      + status(t, '', { 'data-whm-ssh-service-status': true }, 'unread'))
    + '</div>' + section(t, 'ssh-alarm', msgid('SSH login alarm'), check(t, msgid('Send an alert for every SSH sign-in'), { 'data-whm-ssh-alarm': true })
      + help(t, msgid('Each alert names the user, the source address and the time, and goes to the notification channels within a minute.'))
      + status(t, '', { 'data-whm-ssh-alarm-status': true }, 'unread'))
    + section(t, 'ssh-effective', msgctxt('approved-xwhm', 'Effective config'), help(t, msgid('These are observed global defaults from sshd -T. Connection-specific Match rules and authentication with a key are not verified here. Saved port configuration is a separate source.'))
      + `<dl class="v2-observation__facts" data-whm-ssh-effective><div><dt>${esc(t(msgid('Observed global policy')))}</dt><dd>${esc(t(msgid('Not read')))}</dd></div></dl>`)
    + section(t, 'ssh-keys', msgctxt('approved-xwhm', 'Authorized keys for root'), `<div class="v2-observation__groups" data-whm-ssh-keys data-whm-ssh-manage="${canManage}">${help(t, msgid('Existing and fleet keys are protected. Only keys added and tracked by this panel can be removed. Last-use timestamps are unavailable unless separately observed.'))}
      ${table(t, msgid('Authorized root keys have not been read'), [msgid('Fingerprint'), msgid('Type'), msgid('Comment'), msgctxt('whm-security-components', 'Added (UTC)'), msgid('Last used (UTC)'), msgid('Action')], { 'data-whm-ssh-key-rows': true })}
      <p data-whm-ssh-opaque hidden></p>${field(t, 'v2-ssh-key', msgid('Add a public key'), area('v2-ssh-key', { 'data-whm-ssh-public-key': true }, ' dir="ltr" maxlength="8192" spellcheck="false" autocomplete="off"'))}
      ${actions(button(t, msgid('Read SSH observations'), { 'data-whm-ssh-refresh': true }) + button(t, msgid('Add public key'), { 'data-whm-ssh-add': true }, false, true))}${status(t, msgid('SSH observations have not been read.'), { 'data-whm-ssh-status': true })}</div>`)
    + section(t, 'ssh-failures', msgid('Failed sign-ins'), field(t, 'v2-ssh-window', msgid('Show'), select(t, 'v2-ssh-window', { 'data-whm-ssh-window': true }, [['24h', msgid('Last 24 hours')], ['7d', msgid('Last 7 days')]]))
      + help(t, msgid('Latest 500 trusted sshd journal entries within 24 hours. An observed failure does not establish a ban.'), { 'data-whm-ssh-failures-note': true })
      + table(t, msgid('Failed SSH sign-ins have not been read'), [msgid('Time (UTC)'), msgid('Address'), msgid('Username'), msgid('Method'), msgid('Count'), msgid('Result')], { 'data-whm-ssh-failure-rows': true }))
    + section(t, 'ssh-autoban', msgid('Auto-ban rule'), check(t, msgid('Enable auto-ban'), {}) + fields(field(t, 'v2-ssh-failures', msgid('Failures'), inputControl('v2-ssh-failures', {}, false, ' min="1" step="1" dir="ltr"', 'number'))
      + field(t, 'v2-ssh-minutes', msgid('Within, minutes'), inputControl('v2-ssh-minutes', {}, false, ' min="1" step="1" dir="ltr"', 'number')))
      + table(t, msgid('Banned by SSH'), [msgid('Address'), msgid('Since (UTC)'), msgid('Until (UTC)'), msgid('Reason'), msgid('Action')], { 'data-v2-ssh-banned': true })
      + help(t, msgctxt('theme:v2', 'Automatic ban settings and manual unban are not connected on this page. No ban state has been read.')))
  return page(input, '/whm/security/ssh', 'SSH', msgid('SSH access, effective policy and account recovery remain separate decisions.'), body + renderV2RootIdentityCards(t, canRead, canManage) + SSH_TEMPLATES)
}
