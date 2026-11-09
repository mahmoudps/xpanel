import { V2_SECURITY_SLOT } from '../../../surfaces/slots.ts'
import { kpiCard } from '../../../components/kpi-card.ts'
import { xpTemplate } from '../../../html.ts'
import { actions, area, button, check, context, esc, frameRead, field, fields, help, inputControl, link, page, section, select, status, table, type WhmObservationInput } from '../monitoring/common.ts'

export function renderV2WhmSecurityOverview(input: WhmObservationInput): string {
  const { t, canRead, canManage } = context(input)
  const summaries = `<section class="v2-kpi-row" aria-label="${esc(t(msgctxt('theme:v2', 'Security advisor')))}">${[msgid('Checks'), msgid('Warnings'), msgid('Problems'), msgid('Not verified')].map(label => kpiCard({ label: t(label), value: '—', note: t(msgid('Not read')), headingLevel: 2 })).join('')}</section>`
  const factTemplates = xpTemplate('whm-security-fact-technical', '<div><dt data-xp-slot="label"></dt><dd><bdi class="v2-mono" dir="ltr" data-xp-slot="value"></bdi></dd></div>') + xpTemplate('whm-security-fact-text', '<div><dt data-xp-slot="label"></dt><dd><span data-xp-slot="value"></span></dd></div>')
  const evidence = `<div class="v2-observation__groups" data-whm-security-evidence>${help(t, msgid('Checks show individual host observations. No overall security score or capability qualification is inferred. Configuration values are labeled separately.'))}<dl class="v2-observation__facts" data-whm-security-configuration></dl>${table(t, msgid('Security observations have not been read'), [msgid('Check'), msgid('State'), msgid('Observed value')], { 'data-whm-security-check-rows': true })}${actions(button(t, msgid('Read security observations'), { 'data-whm-security-refresh': true }))}${status(t, msgid('Security observations have not been read.'), { 'data-whm-security-status': true })}${factTemplates}</div>`
  const compilerFacts = ([['restriction', msgid('Compilers')], ['host-state', msgid('Host state')], ['commands', msgid('Restricted commands')], ['group', msgid('Compiler group')], ['hook', msgid('Re-apply after package updates')], ['updated', msgid('Last saved (UTC)')], ['reconcile', msgid('Last apply request')], ['observed-at', msgid('Observed at (UTC)')]] as const)
    .map(([key, label]) => `<div><dt>${esc(t(label))}</dt><dd><bdi data-sec-field="${key}">${esc(t(msgid('Not read')))}</bdi></dd></div>`).join('')
  const notConnected = help(t, msgid('This setting has no connected host operation. No changes have been applied.'))
  const policyField = (key: string, label: string, extra = ' min="1" dir="ltr"'): string => {
    const id = `v2-sign-in-${key.replaceAll('.', '-')}`
    return field(t, id, label, inputControl(id, { 'data-sign-in-field': key }, false, extra, 'number'))
  }
  const body = summaries + section(t, 'security-evidence', msgctxt('theme:v2', 'Advisor findings'), evidence)
    + section(t, 'security-access', msgid('Access'), fields(field(t, 'v2-security-entrance', msgctxt('approved-xwhm', 'Secret entrance path'), inputControl('v2-security-entrance', {}, false, ' autocomplete="off" dir="ltr"')))
      + check(t, msgid('Enable secret entrance path'), {}) + actions(link(t, msgid('Regenerate entrance path'), '/whm/security/panel-access'))
      + fields(field(t, 'v2-security-allowlist', msgctxt('approved-xwhm', 'Addresses and ranges, one per line'), area('v2-security-allowlist', {}, ' rows="5" dir="ltr"')))
      + actions(link(t, msgid('IP allowlists'), '/whm/security/panel-access')) + help(t, msgid('Panel access changes these settings. The fields here are read-only.')))
    + section(t, 'security-mfa', msgid('Two-factor for root'), help(t, msgid('Enrollment is optional. Existing authentication factors are preserved; development does not force enrollment.'))
      + actions(link(t, msgid('Password and authenticator'), '/whm/security/sign-in')))
    // WHM cPHulk, Password Strength Configuration and session lifetimes, painted by the sign-in policy client from GET /api/server/sec/sign-in.
    + `<div class="v2-observation" data-sign-in-policy data-sign-in-can-read="${canRead}" data-sign-in-can-manage="${canManage}">`
    + section(t, 'security-lockout', msgid('Sign-in lockout'), help(t, msgid('Counts reset after a successful sign-in. A lock never ends a session that is already open.'))
      + `<h3>${esc(t(msgid('By username')))}</h3>` + fields(policyField('lockout.username.attempts', msgid('Failed attempts')) + policyField('lockout.username.windowMin', msgid('Within, minutes')) + policyField('lockout.username.durationMin', msgid('Lock the username for, minutes')))
      + `<h3>${esc(t(msgid('By IP address')))}</h3>` + fields(policyField('lockout.ip.attempts', msgid('Failed attempts')) + policyField('lockout.ip.windowMin', msgid('Within, minutes')) + policyField('lockout.ip.durationMin', msgid('Block the address for, minutes')))
      + fields(field(t, 'v2-sign-in-ip-allow', msgid('Addresses never locked, one per line'), area('v2-sign-in-ip-allow', { 'data-sign-in-field': 'lockout.ipAllow' }, ' rows="4" dir="ltr"'))
        + field(t, 'v2-sign-in-ip-deny', msgid('Addresses always refused, one per line'), area('v2-sign-in-ip-deny', { 'data-sign-in-field': 'lockout.ipDeny' }, ' rows="4" dir="ltr"')))
      + help(t, msgid('Addresses on the never-locked list are not counted or locked. A locked or refused address is turned away by the panel sign-in; it is not added to the firewall.'))
      + table(t, msgctxt('approved-xwhm', 'Locked right now'), [msgid('Username or address'), msgid('Failed attempts'), msgid('Until (UTC)')], { 'data-sign-in-lockouts': true })
      + field(t, 'v2-sign-in-unlock-target', msgid('Lock to lift'), select(t, 'v2-sign-in-unlock-target', { 'data-sign-in-unlock-target': true }, []))
      + actions(button(t, msgid('Unlock username'), { 'data-sign-in-unlock': 'username' }) + button(t, msgid('Unblock address'), { 'data-sign-in-unlock': 'ip' }))
      + help(t, msgid('Every lock and unlock is written to the audit log.')))
    + section(t, 'security-passwords', msgid('Password strength and sessions'), help(t, msgid('A new password must reach the required strength, from 0 to 100; values round up to a multiple of 5. Leave a service empty to use the default. Existing passwords are not checked.'))
      + fields(policyField('passwordStrength.default', msgid('Default required strength'), ' min="0" max="100" dir="ltr"')
        + ([['panel', msgid('Panel sign-in')], ['mail', msgid('Email accounts')], ['ftp', msgid('FTP accounts')], ['database', msgid('Database users')], ['webdisk', msgid('Web Disk')], ['directory', msgid('Protected directories')]] as const)
          .map(([service, label]) => policyField(`passwordStrength.perService.${service}`, label, ' min="0" max="100" dir="ltr"')).join(''))
      + `<h3>${esc(t(msgid('Sessions')))}</h3>` + fields(policyField('session.idleMin', msgid('Idle timeout, minutes'), ' min="1" max="30" dir="ltr"') + policyField('session.absoluteHours', msgid('Session lifetime, hours'), ' min="1" max="24" dir="ltr"'))
      + help(t, msgid('Sessions end after at most 30 idle minutes and 24 hours in any case; shorter values apply to every panel sign-in.'))
      + actions(button(t, msgid('Save sign-in policy'), { 'data-sign-in-save': true }, false, true) + button(t, msgid('Refresh'), { 'data-sign-in-refresh': true }, canRead))
      + status(t, canRead ? msgid('Nothing has been read yet.') : msgid('This page requires an authorized administrator. Nothing was read or changed.'), { 'data-sign-in-status': true }, canRead ? 'unread' : 'unavailable'))
    + '</div>'
    + section(t, 'security-tokens', msgctxt('approved-xwhm', 'API tokens'), fields(field(t, 'v2-security-token-name', msgid('Name'), inputControl('v2-security-token-name', {}))
      + field(t, 'v2-security-token-addresses', msgid('Allowed addresses'), area('v2-security-token-addresses', {}, ' dir="ltr"'))
      + field(t, 'v2-security-token-expiry', msgctxt('approved-xwhm', 'Expires'), inputControl('v2-security-token-expiry', {}, false, ' dir="ltr"', 'date')))
      + check(t, msgctxt('approved-xwhm', 'No expiry'), {})
      + fields(['accounts:read', 'accounts:write', 'plans:read', 'dns:write', 'backups:read', 'transfer:read', 'metrics:read'].map(scope => check(t, scope, {})).join(''))
      + table(t, msgid('Current API tokens'), [msgid('Name'), msgid('Scopes'), msgid('Allowed addresses'), msgctxt('approved-xwhm', 'Expires'), msgid('Last used (UTC)'), msgid('Manage')], { 'data-v2-security-tokens': true })
      + actions(link(t, msgctxt('approved-xwhm', 'API tokens'), '/whm/panel/api-tokens')) + help(t, msgctxt('theme:v2', 'Create and revoke tokens in their dedicated authenticated workspace. Token values are not read here.')))
    + section(t, 'security-waf', msgid('Nginx web application firewall'), fields(field(t, 'v2-security-rate', msgid('Requests per address'), inputControl('v2-security-rate', {}, false, ' dir="ltr"', 'number'))
      + field(t, 'v2-security-burst', msgid('Burst'), inputControl('v2-security-burst', {}, false, ' dir="ltr"', 'number')) + field(t, 'v2-security-body', msgctxt('approved-xwhm', 'Largest request body'), inputControl('v2-security-body', {}, false, ' dir="ltr"')))
      + check(t, msgid('Unlimited request rate'), {}) + check(t, msgid('Unlimited request body'), {})
      + fields(field(t, 'v2-security-denied-addresses', msgid('Denied addresses and ranges'), area('v2-security-denied-addresses', {}, ' dir="ltr"'))
        + field(t, 'v2-security-denied-paths', msgid('Path patterns'), area('v2-security-denied-paths', {}, ' dir="ltr"')) + field(t, 'v2-security-denied-agents', msgctxt('approved-xwhm', 'User-agent patterns'), area('v2-security-denied-agents', {}, ' dir="ltr"')))
      + actions(link(t, msgid('Web application firewall'), '/whm/security/waf')))
    + section(t, 'security-php-functions', msgid('Dangerous PHP functions'), help(t, msgid('Global function policy and per-account exceptions have not been read. A listed function is not a verified prohibition.'))
      + fields(['exec', 'shell_exec', 'system', 'passthru', 'proc_open', 'popen'].map(name => check(t, name, {})).join(''))
      + table(t, msgid('PHP function exceptions'), [msgid('Account'), msgid('Functions'), msgid('Reason')], { 'data-v2-security-php-exceptions': true }) + actions(link(t, msgid('Add exception'), '/whm/software/php')) + notConnected)
    // cPanel WHM Compiler Access, painted by the sec client from GET /api/server/sec/compiler-access.
    + section(t, 'security-compiler', msgctxt('approved-xwhm', 'Compiler lock'), check(t, msgid('Restrict compiler access'), { 'data-sec-input': 'restricted' })
      + `<dl class="v2-observation__facts">${compilerFacts}</dl>`
      + table(t, msgid('Compiler exceptions'), [msgid('Account'), msgid('Reason')], { 'data-sec-rows': 'exceptions' })
      + field(t, 'v2-security-compiler-account', msgid('Account'), select(t, 'v2-security-compiler-account', { 'data-sec-input': 'account' }, [['', msgid('Select an account')]]), msgid('Accounts on a jailed shell stay restricted and cannot be added. Change the shell of the account or its plan first.'))
      + actions(button(t, msgid('Add account'), { 'data-sec-action': 'grant' }) + button(t, msgid('Remove exception'), { 'data-sec-action': 'revoke' }) + button(t, msgid('Refresh'), { 'data-sec-action': 'refresh' }, canRead))
      + status(t, canRead ? msgid('Nothing has been read yet.') : msgid('This page requires an authorized administrator. Nothing was read or changed.'), { 'data-sec-status': true }, canRead ? 'unread' : 'unavailable')
      + status(t, '', { 'data-sec-result': true }, 'unread', true),
      { 'data-sec-workspace': true, 'data-sec-page': 'compiler-access', 'data-sec-can-read': String(canRead || frameRead(input)), 'data-sec-can-manage': String(canManage) })
  return page(input, '/whm/security', msgctxt('theme:v2', 'Security advisor'), msgid('Access policy, optional multi-factor authentication and host protections.'), body)
}

export function renderV2WhmSignIn(input: WhmObservationInput): string {
  const { t } = context(input)
  return page(input, '/whm/security/sign-in', msgid('Password and authenticator'), msgid('Enrollment is optional. Existing authentication factors are preserved; development does not force enrollment.'), section(t, 'sign-in-account', msgid('Account security'), V2_SECURITY_SLOT))
}
