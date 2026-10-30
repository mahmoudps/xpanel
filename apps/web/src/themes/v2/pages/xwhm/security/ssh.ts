import { actions, area, button, check, context, esc, field, fields, help, inputControl, markerFacts, page, section, select, status, table, type WhmObservationInput } from '../monitoring/common.ts'

export function renderV2WhmSsh(input: WhmObservationInput): string {
  const { t, canRead, canManage } = context(input)
  const portKnown = canRead && Number.isInteger(input.serverSettings?.sshPort)
  const portControl = field(t, 'v2-ssh-port', msgid('Port'), inputControl('v2-ssh-port', {}, canManage && portKnown, ` name="sshPort" dir="ltr" min="1" max="65535" step="1"${portKnown ? ` value="${input.serverSettings!.sshPort}"` : ''}`, 'number'))
  const portBody = portControl + actions(button(t, msgid('Test and apply port'), {}, canManage && portKnown, true, 'submit')) + status(t, '', { 'data-whm-operation-status': true, 'data-server-settings-status': true }, 'unread', true)
  const portForm = canManage && portKnown ? `<form class="v2-observation__groups" data-server-settings-form>${portBody}</form>` : `<div class="v2-observation__groups" data-whm-readonly-fields>${portBody}</div>`
  const body = section(t, 'ssh-settings', msgid('Sign-in settings'), portForm + fields(field(t, 'v2-ssh-auth', msgid('Authentication'), select(t, 'v2-ssh-auth', {}, [['keys', msgctxt('approved-xwhm', 'Keys only')], ['password', msgctxt('approved-xwhm', 'Keys and password')]]))
    + field(t, 'v2-ssh-root', msgid('Root sign-in'), select(t, 'v2-ssh-root', {}, [['prohibit-password', msgctxt('approved-xwhm', 'Keys only')], ['no', msgid('Not allowed')], ['yes', msgctxt('approved-xwhm', 'Keys and password')]])))
    + help(t, msgid('Only the SSH port has a connected settings operation. Password policy and root-login changes have not been connected.')))
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
  return page(input, '/whm/security/ssh', 'SSH', msgid('SSH access, effective policy and account recovery remain separate decisions.'), body)
}
