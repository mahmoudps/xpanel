import { v2WhmClientTemplates } from '../../../whm-client-templates.ts'
import { formField } from '../../../components/form-field.ts'
import { escapeHtml } from '../../../html.ts'
import { button, facts, group, mailContext, page, status, table, type WhmMailPageInput } from './common.ts'

export type MailServerPage = 'server' | 'routing' | 'outbound'
interface Setting { key: string; source?: 'postfix' | 'dovecot'; list?: boolean; options?: readonly string[]; floor?: boolean }
const TLS = ['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'] as const
const FLOORS = ['!SSLv2, !SSLv3', '!SSLv2, !SSLv3, !TLSv1', '!SSLv2, !SSLv3, !TLSv1, !TLSv1.1', '!SSLv2, !SSLv3, !TLSv1, !TLSv1.1, !TLSv1.2'] as const satisfies readonly [string, string, string, string]

/** Presentation groups; server validation remains authoritative for every setting. */
const SETTINGS: readonly { id: string; label: string; fields: readonly Setting[] }[] = [
  { id: 'identity', label: msgid('Identity and networks'), fields: [
    { key: 'myhostname' }, { key: 'mydomain' }, { key: 'myorigin' }, { key: 'smtpd_banner' }, { key: 'inet_interfaces', list: true },
    { key: 'inet_protocols', options: ['all', 'ipv4', 'ipv6', 'ipv4, ipv6'] }, { key: 'mynetworks', list: true }, { key: 'smtpd_helo_required', options: ['yes', 'no'] },
  ] },
  { id: 'smtpd-tls', label: msgid('Incoming SMTP TLS'), fields: [
    { key: 'smtpd_tls_protocols', floor: true }, { key: 'smtpd_tls_mandatory_protocols', floor: true },
    { key: 'smtpd_tls_ciphers', options: ['medium', 'high'] }, { key: 'smtpd_tls_mandatory_ciphers', options: ['medium', 'high'] },
    { key: 'smtpd_tls_exclude_ciphers', list: true }, { key: 'tls_preempt_cipherlist', options: ['yes', 'no'] },
  ] },
  { id: 'smtp-tls', label: msgid('Outgoing SMTP TLS'), fields: [
    { key: 'smtp_tls_security_level', options: ['none', 'may', 'encrypt'] }, { key: 'smtp_tls_protocols', floor: true },
    { key: 'smtp_tls_mandatory_protocols', floor: true }, { key: 'smtp_tls_ciphers', options: ['medium', 'high'] },
  ] },
  { id: 'dovecot', label: msgid('Dovecot (IMAP and POP3)'), fields: [
    { key: 'protocols', source: 'dovecot' }, { key: 'ssl_min_protocol', source: 'dovecot', options: TLS },
    { key: 'ssl_cipher_list', source: 'dovecot' }, { key: 'ssl_prefer_server_ciphers', source: 'dovecot', options: ['yes', 'no'] },
  ] },
]
const LIMITS: readonly Setting[] = ['message_size_limit', 'smtpd_client_connection_rate_limit', 'smtpd_client_connection_count_limit',
  'default_destination_recipient_limit', 'smtp_destination_concurrency_limit', 'default_process_limit']
  .map(key => ({ key })).concat({ key: 'smtpd_client_event_limit_exceptions', list: true } as Setting)

export function renderV2WhmMailServer(input: WhmMailPageInput, mode: MailServerPage = 'server'): string {
  const { t, locale, dir, canRead, canManage } = mailContext(input)
  const route = `/whm/email/${mode}`
  const title = mode === 'server' ? t(msgid('Mail server')) : mode === 'routing' ? t(msgid('Mail routing')) : t(msgid('Outbound mail routing'))
  const id = (key: string) => `v2-mail-server-${mode}-${key}`
  const compared = [t(msgid('Observed')), t(msgid('Rendered by xPanel')), t(msgid('State'))]
  const field = (setting: Setting) => {
    const options = setting.floor ? FLOORS : setting.options
    const hooks = { 'data-mail-setting': setting.key, 'data-mail-setting-source': setting.source ?? 'postfix', ...(setting.list ? { 'data-mail-setting-list': 'true' } : {}) }
    return formField({ id: id(setting.key), label: setting.key, control: options ? {
      kind: 'select', mono: true, dir: 'ltr', disabled: true, hooks,
      options: [{ value: '', label: t(msgid('Not managed (keep the host value)')) }, ...options.map((value, index) => ({ value,
        label: setting.floor ? t(msgid('{version} or later'), { version: TLS[index]! }) : value }))],
    } : { kind: 'input', type: 'text', mono: true, dir: 'ltr', autocomplete: 'off', spellcheck: false, disabled: true, hooks,
      placeholder: t(msgid('Not managed (keep the host value)')) } })
  }
  const settingsGroups = mode === 'routing' ? [] : mode === 'outbound'
    ? [{ id: 'limits', label: msgid('Rate and size limits'), fields: LIMITS }] : SETTINGS
  const fields = settingsGroups.map(section => `<fieldset><legend>${escapeHtml(t(section.label))}</legend><div class="v2-whm-mail__fields">${section.fields.map(field).join('')}</div></fieldset>`).join('')
  const certificates = ['smtp', 'submission', 'imap'].map((key, index) => formField({ id: id(`certificate-${key}`),
    label: t([msgid('Incoming SMTP (port 25)'), msgid('Mail clients sending (ports 587 and 465)'), msgid('Mail clients reading (IMAP and POP3)')][index]!),
    control: { kind: 'select', disabled: true, hooks: { 'data-mail-certificate': key }, options: [{ value: '', label: t(msgid('Default certificate')) }] },
  })).join('')
  const extras = mode !== 'server' ? '' : `<fieldset><legend>${escapeHtml(t(msgid('DNS blocklists (RBL)')))}</legend>
<label class="v2-whm-mail__check" for="${id('rbl-managed')}"><input id="${id('rbl-managed')}" type="checkbox" data-mail-rbl-managed disabled><span>${escapeHtml(t(msgid('Manage smtpd_client_restrictions with these blocklists')))}</span></label>
${formField({ id: id('rbl'), label: t(msgid('Blocklist zones')), help: t(msgid('One DNS zone per line, checked in order after trusted networks and signed-in senders.')),
    control: { kind: 'textarea', mono: true, dir: 'ltr', rows: 4, spellcheck: false, disabled: true, hooks: { 'data-mail-rbl': true } } })}</fieldset>
<fieldset><legend>${escapeHtml(t(msgid('Certificates')))}</legend><div class="v2-whm-mail__fields">${certificates}</div></fieldset>`
  const editor = !canManage ? '' : group(`${mode}-editor`, mode === 'routing' ? t(msgid('Change routing')) : t(msgid('Change settings')),
    `<form data-whm-mail-settings novalidate><p>${escapeHtml(mode === 'routing'
      ? t(msgid('Choose a route for each domain in the table above. Local delivers here; backup MX accepts mail and relays it to the primary exchanger; remote sends mail to the MX of the domain.'))
      : t(msgid('An empty value is not managed and keeps the host value. Each change is previewed, checked with postfix check and doveconf -n, and restored automatically when a check fails.')))}</p>
${mode === 'routing' ? '' : `<p>${escapeHtml(t(msgid('Separate list entries with a comma and a space.')))}</p>`}${fields}${extras}
${status(t(msgid('The saved policy has not been read.')), { 'data-whm-mail-settings-status': true })}
<div class="v2-whm-mail__stack" data-whm-mail-settings-preview hidden><h3>${escapeHtml(t(msgid('Changes to apply')))}</h3>${table(t, t(msgid('Changes to apply')), [t(msgid('Where')), t(msgid('Setting')), t(msgid('Now')), t(msgid('After'))], { 'data-whm-mail-server-changes': true })}</div>
<div class="v2-whm-mail__actions">${button(t(msgid('Preview changes')), { 'data-whm-mail-settings-preview-button': true })}<button type="submit" class="v2-btn v2-btn--primary" data-whm-mail-settings-save disabled>${escapeHtml(t(msgid('Save and apply')))}</button></div></form>`)
  const sourceFacts = facts(t, [[ 'postfix', msgid('Postfix main.cf') ], ...(mode !== 'routing' ? [[ 'master', msgid('Postfix master.cf') ]] as const : []),
    ...(mode === 'server' ? [[ 'dovecot', msgid('Dovecot') ]] as const : []), ['desired', msgid('Rendered by xPanel')], ['observed-at', msgid('Observed at (UTC)')]], 'data-whm-mail-server-fact')
  const summary = group(`${mode}-sources`, t(msgid('Configuration sources')),
    `${status(t(msgid('The mail server configuration has not been read.')), { 'data-whm-mail-server-status': true })}${sourceFacts}
<p>${escapeHtml(t(msgid('Passwords, keys and lookup table contents are never read.')))}</p><p><a href="/whm/monitoring/repair">${escapeHtml(t(msgid('Repair center')))}</a> · <a href="/whm/panel/data">${escapeHtml(t(msgid('Configuration history')))}</a></p>`,
    button(t(msgid('Refresh')), { 'data-whm-mail-server-refresh': true }, !canRead))
  const observed = group(`${mode}-observed`, mode === 'outbound' ? t(msgid('Rate and size limits')) : t(msgid('Postfix and Dovecot settings')),
    table(t, t(msgid('Settings')), [t(msgid('Source')), t(msgid('Setting')), ...compared], { 'data-whm-mail-server-settings': true }))
  const services = mode === 'routing' ? '' : group(`${mode}-services`, mode === 'server' ? t(msgid('Listening services (master.cf)')) : t(msgid('Submission services')),
    `<p>${escapeHtml(t(msgid('Only reviewed -o overrides are shown; other overrides are counted.')))}</p>${table(t, t(msgid('Services')), [t(msgid('Service')), t(msgid('Setting')), ...compared], { 'data-whm-mail-server-services': true })}`)
  const domains = mode !== 'routing' ? '' : group('routing-domains', t(msgid('Hosted mail domains')),
    `<p>${escapeHtml(t(msgid('MX records come from the saved DNS zones on this server, not from live DNS lookups.')))}</p><p data-whm-mail-server-truncated hidden>${escapeHtml(t(msgid('Only the first 2000 domains are listed.')))}</p>${table(t, t(msgid('Hosted mail domains')), [t(msgid('Domain')), t(msgid('Account')), t(msgid('Mailboxes')), t(msgid('Saved zone')), t(msgid('Saved MX')), t(msgid('Expectation')), ...(canManage ? [t(msgid('Routing'))] : [])], { 'data-whm-mail-server-domains': true })}`)
  const workspace = `<div class="v2-whm-mail__stack" data-whm-mail-server-workspace data-mail-server-page="${mode}" data-mail-server-can-read="${canRead}" data-mail-server-can-manage="${canManage}" lang="${locale}" dir="${dir}">${v2WhmClientTemplates('mail-server')}${summary}${observed}${services}${domains}${editor}</div>`
  return page(input, route, title, t(msgctxt('theme:v2', 'Compare observed mail settings, review the saved policy, and apply only a verified change.')),
    `${mode === 'outbound' ? outboundPolicy(input) : ''}${workspace}`)
}

function outboundPolicy(input: WhmMailPageInput): string {
  const { t, canRead, canManage } = mailContext(input), saved = canRead ? input.mailIpConfig : undefined
  const editable = canManage && saved !== undefined
  const controls = [['defaultIpv4', msgid('Default outbound IPv4')], ['defaultIpv6', msgid('Default outbound IPv6')], ['defaultHelo', msgid('Default EHLO / HELO Hostname')]] as const
  return group('outbound-policy', t(msgid('Postfix Outbound Mail IP & HELO Transport Map')),
    `<form action="/api/mail/ips" method="post" data-mail-ip-config-form="true" data-mail-ip-editable="${editable}"><div class="v2-whm-mail__fields">${formField({ id: 'mail-outbound-mode', label: t(msgid('Outbound mail routing')), control: {
      kind: 'select', name: 'mode', disabled: !editable, options: [...(!saved ? [{ value: '', label: t(msgid('Not read')), selected: true }] : []), ...[
        { value: 'server-default', label: t(msgid('Server Default IP')) }, { value: 'account-ip', label: t(msgid('Per-Account Dedicated IP')) },
        { value: 'domain-ip', label: t(msgid('Per-Domain Dedicated IP')) }, { value: 'custom-map', label: t(msgid('Explicit Per-Domain Custom Map')) },
      ].map(option => ({ ...option, selected: saved?.mode === option.value }))],
    } })}${controls.map(([key, label]) => formField({ id: `mail-${key}`, label: t(label), control: { kind: 'input', type: 'text', name: key,
      dir: 'ltr', mono: true, disabled: !editable, value: saved?.[key] ?? '', autocomplete: 'off', spellcheck: false } })).join('')}</div>
<div class="v2-whm-mail__field"><span id="v2-mail-overrides-label">${escapeHtml(t(msgid('Per-Domain Outbound IPv4/IPv6 & HELO Overrides')))}</span><pre role="region" aria-labelledby="v2-mail-overrides-label"><bdi dir="ltr" data-mail-ip-overrides>${saved ? escapeHtml(saved.domainOverrides.map(row => [row.domainName, row.ipv4, row.ipv6, row.heloHostname].filter(Boolean).join(' · ')).join('\n') || t(msgid('No domain overrides are configured.'))) : escapeHtml(t(msgid('Not read')))}</bdi></pre></div>
<p data-mail-ip-status role="status" aria-live="polite" tabindex="-1" hidden></p><noscript><p>${escapeHtml(t(msgid('Saving mail settings requires JavaScript.')))}</p></noscript>
<button type="submit" class="v2-btn v2-btn--primary" disabled>${escapeHtml(t(msgctxt('common', 'Review changes')))}</button></form>`)
}
