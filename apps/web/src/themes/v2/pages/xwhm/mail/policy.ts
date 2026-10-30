import { formField } from '../../../components/form-field.ts'
import { escapeHtml } from '../../../html.ts'
import { button, facts, group, mailContext, page, status, type WhmMailPageInput } from './common.ts'

export type MailPolicyPage = 'spam' | 'relay' | 'bcc' | 'marketing'
interface Field { key: string; label: string; kind: 'check' | 'text' | 'email' | 'password' | 'number' | 'lines'; help?: string; step?: number; min?: number; max?: number }
const FIELDS: Readonly<Record<MailPolicyPage, readonly Field[]>> = {
  spam: [
    { key: 'enabled', label: msgid('Filter incoming mail'), kind: 'check' },
    { key: 'rejectScore', label: msgid('Reject at score'), kind: 'number', step: 0.5, min: 0.5, max: 100, help: msgid('Messages at or above this score are refused during delivery. SpamAssassin has no reject action.') },
    { key: 'headerScore', label: msgid('Mark as spam at score'), kind: 'number', step: 0.5, min: 0.5, max: 100, help: msgid('Messages at or above this score get a spam header so mailbox filters can move them.') },
    { key: 'greylisting', label: msgid('Greylisting'), kind: 'check', help: msgid('Ask unknown senders to retry later. Needs rspamd.') },
    { key: 'greylistScore', label: msgid('Greylist at score'), kind: 'number', step: 0.5, min: 0.5, max: 100 },
    { key: 'blockedDomains', label: msgid('Blocked sender domains'), kind: 'lines', help: msgid('One domain per line, at most 500. Mail from these domains is refused.') },
    { key: 'countries', label: msgid('Filter incoming mail by country'), kind: 'text', help: msgid('Country filtering needs a GeoIP country database, which this server does not provide.') },
  ],
  relay: [
    { key: 'enabled', label: msgid('Send outgoing mail through a relay'), kind: 'check' },
    { key: 'host', label: msgid('Relay host'), kind: 'text', help: msgid('A host name such as smtp.example.com. Mail goes to it on the port below with required STARTTLS.') },
    { key: 'port', label: msgid('Port'), kind: 'number', step: 1, min: 1, max: 65535, help: msgid('Use 587, 25 or 2525. Port 465 (implicit TLS) is not supported for a relay.') },
    { key: 'username', label: msgid('Username'), kind: 'text', help: msgid('Leave empty when the relay accepts this server without signing in.') },
    { key: 'password', label: msgid('Password'), kind: 'password', help: msgid('Leave empty to keep the saved password. It is stored only on this server and is never shown again.') },
  ],
  bcc: [
    { key: 'alwaysBcc', label: msgid('Copy every message to'), kind: 'email', help: msgid('Leave empty for no server-wide copy.') },
    { key: 'recipient', label: msgid('Copy mail sent to these addresses'), kind: 'lines', help: msgid('One rule per line: the address or @domain, a space, then the copy address.') },
    { key: 'sender', label: msgid('Copy mail sent from these addresses'), kind: 'lines', help: msgid('One rule per line: the address or @domain, a space, then the copy address.') },
  ],
  marketing: [
    { key: 'messageRateLimit', label: msgid('Messages per client in each window'), kind: 'number', step: 1, min: 0, max: 1000000, help: msgid('0 means no limit.') },
    { key: 'recipientRateLimit', label: msgid('Recipients per client in each window'), kind: 'number', step: 1, min: 0, max: 1000000, help: msgid('0 means no limit.') },
    { key: 'rateWindow', label: msgid('Window length in seconds'), kind: 'number', step: 1, min: 60, max: 86400 },
    { key: 'recipientsPerMessage', label: msgid('Recipients per message'), kind: 'number', step: 1, min: 1, max: 100000 },
    { key: 'destinationConcurrency', label: msgid('Parallel deliveries per destination'), kind: 'number', step: 1, min: 1, max: 1000 },
    { key: 'destinationRateDelay', label: msgid('Pause between deliveries to one destination, in seconds'), kind: 'number', step: 1, min: 0, max: 3600 },
  ],
}
const TITLES: Record<MailPolicyPage, string> = {
  spam: msgid('Inbound spam protection'), relay: msgid('SMTP relay'), bcc: msgid('Mail BCC copies'), marketing: msgid('Mail campaigns & automation'),
}
const NOTES: Record<MailPolicyPage, string> = {
  spam: msgid('xPanel writes the thresholds to the detected filter (rspamd local.d files or a SpamAssassin site file), checks them and reloads the filter. While filtering is on, the configuration generation adds the filter to Postfix after OpenDKIM (rspamd directly, SpamAssassin through spamass-milter).'),
  relay: msgid('xPanel sets relayhost, a TLS policy for the relay and, when a username is saved, a SASL password table readable only by root.'),
  bcc: msgid('xPanel sets always_bcc and the recipient and sender BCC tables. Account archive copies use the same tables; a rule here wins over an archive for the same domain.'),
  marketing: msgid('These Postfix limits apply to every SMTP client, including other mail servers. xPanel does not send campaigns.'),
}

export function renderV2WhmMailPolicy(input: WhmMailPageInput, kind: MailPolicyPage): string {
  const { t, locale, dir, canRead, canManage } = mailContext(input)
  const id = (key: string) => `v2-whm-mail-${kind}-${key}`
  const controls = FIELDS[kind].map(field => {
    if (field.kind === 'check') return `<div class="v2-whm-mail__field"><label class="v2-whm-mail__check" for="${id(field.key)}"><input id="${id(field.key)}" type="checkbox" data-mailx-field="${field.key}"${field.help ? ` aria-describedby="${id(field.key)}-help"` : ''} disabled><span>${escapeHtml(t(field.label))}</span></label>${field.help ? `<p id="${id(field.key)}-help">${escapeHtml(t(field.help))}</p>` : ''}</div>`
    return formField({ id: id(field.key), label: t(field.label), ...(field.help ? { help: t(field.help) } : {}),
      control: field.kind === 'lines' ? { kind: 'textarea', rows: 4, dir: 'ltr', mono: true, spellcheck: false,
        disabled: true, hooks: { 'data-mailx-field': field.key } } : { kind: 'input', type: field.kind, dir: 'ltr', mono: true,
        disabled: true, autocomplete: field.kind === 'password' ? 'new-password' : 'off', spellcheck: false,
        ...(field.kind === 'number' ? { inputmode: 'decimal', step: field.step, min: field.min, max: field.max } : {}), hooks: { 'data-mailx-field': field.key } },
    })
  }).join('')
  const summary = group(`${kind}-summary`, t(msgid('Policy and host state')),
    `<p>${escapeHtml(t(NOTES[kind]))}</p>${status(t(msgid('The saved mail policy has not been read.')), { 'data-mailx-status': true })}
${facts(t, [['saved', msgid('Saved policy')], ['host', msgid('Host agent')], ['state', msgid('Applied on this server')],
      ...(kind === 'spam' ? [['engine', msgid('Detected filter')], ['wiring', msgid('Postfix passes mail to the filter')]] as const : []),
      ['observed-at', msgid('Observed at (UTC)')], ['updated', msgid('Last saved')]], 'data-mailx-fact')}`,
    button(t(msgid('Refresh')), { 'data-mailx-refresh': true }, !canRead))
  const tag = canManage ? 'form' : 'div'
  const editor = group(`${kind}-policy`, t(TITLES[kind]), `<${tag} data-mailx-form${canManage ? ' novalidate' : ''}><div class="v2-whm-mail__fields">${controls}</div>
${status('', { 'data-mailx-form-status': true })}<div class="v2-whm-mail__actions"><button type="${canManage ? 'submit' : 'button'}" class="v2-btn v2-btn--primary" data-mailx-save disabled>${escapeHtml(t(msgid('Save and apply')))}</button>${button(t(msgid('Apply saved policy again')), { 'data-mailx-apply': true })}</div></${tag}>`)
  return page(input, `/whm/email/${kind}`, t(TITLES[kind]), t(NOTES[kind]),
    `<div class="v2-whm-mail__stack" data-mailx-whm data-mailx-page="${kind}" data-mailx-can-read="${canRead}" data-mailx-can-manage="${canManage}" lang="${locale}" dir="${dir}">${summary}${editor}</div>`)
}
