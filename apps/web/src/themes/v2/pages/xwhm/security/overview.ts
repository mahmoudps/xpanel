import { V2_SECURITY_SLOT } from '../../../surfaces/slots.ts'
import { kpiCard } from '../../../components/kpi-card.ts'
import { actions, area, button, check, context, esc, field, fields, help, inputControl, link, page, section, select, status, table, type WhmObservationInput } from '../monitoring/common.ts'

export function renderV2WhmSecurityOverview(input: WhmObservationInput): string {
  const { t, canRead } = context(input)
  const summaries = `<section class="v2-kpi-row" aria-label="${esc(t(msgctxt('theme:v2', 'Security advisor')))}">${[msgid('Checks'), msgid('Warnings'), msgid('Problems'), msgid('Not verified')].map(label => kpiCard({ label: t(label), value: '—', note: t(msgid('Not read')), headingLevel: 2 })).join('')}</section>`
  const evidence = `<div class="v2-observation__groups" data-whm-security-evidence>${help(t, msgid('Checks show individual host observations. No overall security score or capability qualification is inferred. Configuration values are labeled separately.'))}<dl class="v2-observation__facts" data-whm-security-configuration></dl>${table(t, msgid('Security observations have not been read'), [msgid('Check'), msgid('State'), msgid('Observed value')], { 'data-whm-security-check-rows': true })}${actions(button(t, msgid('Read security observations'), { 'data-whm-security-refresh': true }))}${status(t, msgid('Security observations have not been read.'), { 'data-whm-security-status': true })}</div>`
  const notConnected = help(t, msgid('This setting has no connected host operation. No changes have been applied.'))
  const body = summaries + section(t, 'security-evidence', msgctxt('theme:v2', 'Advisor findings'), evidence)
    + section(t, 'security-access', msgid('Access'), fields(field(t, 'v2-security-panel-port', msgid('Panel port'), inputControl('v2-security-panel-port', {}, false, ` dir="ltr"${canRead && input.serverSettings ? ` value="${esc(input.serverSettings.panelPort)}"` : ''}`, 'number'))
      + field(t, 'v2-security-entrance', msgctxt('approved-xwhm', 'Secret entrance path'), inputControl('v2-security-entrance', {}, false, ' autocomplete="off" dir="ltr"')))
      + check(t, msgid('Enable secret entrance path'), {}) + actions(button(t, msgid('Regenerate entrance path')))
      + fields(field(t, 'v2-security-allowlist', msgctxt('approved-xwhm', 'Addresses and ranges, one per line'), area('v2-security-allowlist', {}, ' rows="5" dir="ltr"')))
      + actions(link(t, msgid('IP allowlists'), '/whm/security/panel-access')) + notConnected)
    + section(t, 'security-mfa', msgid('Two-factor for root'), help(t, msgid('Enrollment is optional. Existing authentication factors are preserved; development does not force enrollment.'))
      + actions(link(t, msgid('Password and authenticator'), '/whm/security/sign-in')))
    + section(t, 'security-lockout', msgid('Sign-in lockout'), fields(field(t, 'v2-lockout-attempts', msgid('Failed attempts'), inputControl('v2-lockout-attempts', {}, false, ' min="1" dir="ltr"', 'number'))
      + field(t, 'v2-lockout-window', msgid('Within, minutes'), inputControl('v2-lockout-window', {}, false, ' min="1" dir="ltr"', 'number')) + field(t, 'v2-lockout-duration', msgid('Lock the username for'), inputControl('v2-lockout-duration', {})))
      + table(t, msgctxt('approved-xwhm', 'Locked right now'), [msgid('Username or address'), msgid('Until'), msgid('Action')], { 'data-v2-security-lockouts': true })
      + actions(button(t, msgid('Unlock username')) + button(t, msgid('Unblock address'))) + notConnected)
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
      + table(t, msgid('PHP function exceptions'), [msgid('Account'), msgid('Functions'), msgid('Reason')], { 'data-v2-security-php-exceptions': true }) + actions(button(t, msgid('Add exception'))) + notConnected)
    + section(t, 'security-compiler', msgctxt('approved-xwhm', 'Compiler lock'), check(t, msgid('Restrict compiler access'), {})
      + table(t, msgid('Compiler exceptions'), [msgid('Account'), msgid('Reason')], { 'data-v2-security-compiler-exceptions': true })
      + field(t, 'v2-security-compiler-account', msgid('Account'), select(t, 'v2-security-compiler-account', {}, (canRead ? input.accounts ?? [] : []).map(account => [account.username, account.username] as const)))
      + actions(button(t, msgid('Add account')) + button(t, msgid('Remove exception'))) + notConnected)
    + section(t, 'security-review', msgid('Review policy changes'), actions(button(t, msgid('Discard')) + button(t, msgid('Save and apply'), {}, false, true))
      + help(t, msgid('No global host-policy write or reviewed draft is connected here. Existing password and optional-factor settings use their own authenticated workflow.')))
  return page(input, '/whm/security', msgctxt('theme:v2', 'Security advisor'), msgid('Access policy, optional multi-factor authentication and host protections.'), body)
}

export function renderV2WhmSignIn(input: WhmObservationInput): string {
  const { t } = context(input)
  return page(input, '/whm/security/sign-in', msgid('Password and authenticator'), msgid('Enrollment is optional. Existing authentication factors are preserved; development does not force enrollment.'), section(t, 'sign-in-account', msgid('Account security'), V2_SECURITY_SLOT))
}
