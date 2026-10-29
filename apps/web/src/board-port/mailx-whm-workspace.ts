import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
export type MailxWhmPage = 'spam' | 'relay' | 'bcc' | 'marketing'
export interface MailxWhmWorkspaceInput { locale: Locale; page: MailxWhmPage; canRead: boolean; canManage: boolean }
type Field = { key: string; label: string; kind: 'check' | 'number' | 'text' | 'email' | 'password' | 'lines'; help?: string; step?: string; min?: number; max?: number; disabled?: boolean }

/** Saved server mail policy for /whm/email/spam, /relay, /bcc and /marketing. Values are painted only from an authorized fresh read. */
/** Page-scoped mail policy styles, shared by the mailx workspaces only. */
export const MAILX_STYLE = `<style>.xp-mailx{display:flex;flex-direction:column;gap:32px;min-inline-size:0}.xp-mailx :is(h2,p,dl,dd){margin:0}.xp-mailx h2{font-size:var(--xp-type-card);line-height:var(--xp-leading-card);font-weight:var(--xp-weight-semibold)}.xp-mailx__card{display:flex;flex-direction:column;gap:24px;padding:16px;min-inline-size:0;border:1px solid var(--xp-border);border-radius:8px;background:var(--xp-bg-surface)}.xp-mailx__heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px}.xp-mailx__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:16px}.xp-mailx__facts>div,.xp-mailx__field{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-mailx__fields{display:flex;flex-direction:column;gap:16px}.xp-mailx__check{display:grid;grid-template-columns:auto 1fr;align-items:center;column-gap:8px;row-gap:8px}.xp-mailx__check .xp-help{grid-column:2}.xp-mailx dt,.xp-mailx label{font-weight:600}.xp-mailx__facts dt,.xp-mailx__field>label{font-size:var(--xp-type-label);line-height:var(--xp-leading-label)}.xp-mailx__check>label{display:flex;align-items:center;min-block-size:var(--xp-hit-target)}.xp-mailx dd{overflow-wrap:anywhere}.xp-mailx :is(button,.xp-input){min-block-size:44px}.xp-mailx input[type=checkbox]{inline-size:20px;block-size:20px}.xp-mailx__actions{display:flex;flex-wrap:wrap;gap:16px}.xp-mailx [hidden]{display:none}.xp-mailx :focus-visible{outline:2px solid var(--xp-accent);outline-offset:2px}@media(min-width:601px){.xp-mailx__card{padding:24px}}.xp-mailx table input{min-inline-size:8em}</style>`

export function renderMailxWhmWorkspace({ locale, page, canRead, canManage }: MailxWhmWorkspaceInput): string {
  const t = (message: string, values?: MessageValues): string => translator(locale)(message, values), id = (name: string): string => `mailx-${page}-${name}`
  const notRead = t('Not read')
  const fact = (label: string, key: string): string => `<div><dt>${label}</dt><dd data-mailx-fact="${key}">${notRead}</dd></div>`
  const fields: Record<MailxWhmPage, Field[]> = {
    spam: [
      { key: 'enabled', label: t('Filter incoming mail'), kind: 'check' },
      { key: 'rejectScore', label: t('Reject at score'), kind: 'number', step: '0.5', min: 0.5, max: 100, help: t('Messages at or above this score are refused during delivery. SpamAssassin has no reject action.') },
      { key: 'headerScore', label: t('Mark as spam at score'), kind: 'number', step: '0.5', min: 0.5, max: 100, help: t('Messages at or above this score get a spam header so mailbox filters can move them.') },
      { key: 'greylisting', label: t('Greylisting'), kind: 'check', help: t('Ask unknown senders to retry later. Needs rspamd.') },
      { key: 'greylistScore', label: t('Greylist at score'), kind: 'number', step: '0.5', min: 0.5, max: 100 },
      { key: 'blockedDomains', label: t('Blocked sender domains'), kind: 'lines', help: t('One domain per line, at most 500. Mail from these domains is refused.') },
      { key: 'countries', label: t('Filter incoming mail by country'), kind: 'text', disabled: true, help: t('Country filtering needs a GeoIP country database, which this server does not provide.') },
    ],
    relay: [
      { key: 'enabled', label: t('Send outgoing mail through a relay'), kind: 'check' },
      { key: 'host', label: t('Relay host'), kind: 'text', help: t('A host name such as smtp.example.com. Mail goes to it on the port below with required STARTTLS.') },
      { key: 'port', label: t('Port'), kind: 'number', step: '1', min: 1, max: 65535, help: t('Use 587, 25 or 2525. Port 465 (implicit TLS) is not supported for a relay.') },
      { key: 'username', label: t('Username'), kind: 'text', help: t('Leave empty when the relay accepts this server without signing in.') },
      { key: 'password', label: t('Password'), kind: 'password', help: t('Leave empty to keep the saved password. It is stored only on this server and is never shown again.') },
    ],
    bcc: [
      { key: 'alwaysBcc', label: t('Copy every message to'), kind: 'email', help: t('Leave empty for no server-wide copy.') },
      { key: 'recipient', label: t('Copy mail sent to these addresses'), kind: 'lines', help: t('One rule per line: the address or @domain, a space, then the copy address.') },
      { key: 'sender', label: t('Copy mail sent from these addresses'), kind: 'lines', help: t('One rule per line: the address or @domain, a space, then the copy address.') },
    ],
    marketing: [
      { key: 'messageRateLimit', label: t('Messages per client in each window'), kind: 'number', step: '1', min: 0, max: 1000000, help: t('0 means no limit.') },
      { key: 'recipientRateLimit', label: t('Recipients per client in each window'), kind: 'number', step: '1', min: 0, max: 1000000, help: t('0 means no limit.') },
      { key: 'rateWindow', label: t('Window length in seconds'), kind: 'number', step: '1', min: 60, max: 86400 },
      { key: 'recipientsPerMessage', label: t('Recipients per message'), kind: 'number', step: '1', min: 1, max: 100000 },
      { key: 'destinationConcurrency', label: t('Parallel deliveries per destination'), kind: 'number', step: '1', min: 1, max: 1000 },
      { key: 'destinationRateDelay', label: t('Pause between deliveries to one destination, in seconds'), kind: 'number', step: '1', min: 0, max: 3600 },
    ],
  }
  const control = (field: Field): string => {
    const name = id(field.key), help = field.help ? `<p class="xp-help" id="${name}-help">${field.help}</p>` : ''
    const described = field.help ? ` aria-describedby="${name}-help"` : '', off = field.disabled || !canManage ? ' disabled' : ''
    if (field.kind === 'check') return `<div class="xp-mailx__check"><input type="checkbox" id="${name}" data-mailx-field="${field.key}"${described}${off}><label for="${name}">${field.label}</label>${help}</div>`
    const input = field.kind === 'lines' ? `<textarea class="xp-textarea" id="${name}" rows="4" dir="ltr" spellcheck="false" data-mailx-field="${field.key}"${described}${off}></textarea>`
      : `<input class="xp-input" id="${name}" dir="ltr" data-mailx-field="${field.key}" type="${field.kind === 'email' ? 'email' : field.kind === 'password' ? 'password' : field.kind === 'number' ? 'number' : 'text'}"${field.kind === 'number' ? ` inputmode="decimal" step="${field.step}" min="${field.min}" max="${field.max}"` : ''}${field.kind === 'password' ? ' autocomplete="new-password"' : ' autocomplete="off"'}${described}${off}>`
    return `<div class="xp-mailx__field"><label for="${name}">${field.label}</label>${input}${help}</div>`
  }
  const titles: Record<MailxWhmPage, string> = { spam: t('Inbound spam filter'), relay: t('Outgoing relay'), bcc: t('Copies of messages'), marketing: t('Bulk sending limits') }
  const notes: Record<MailxWhmPage, string> = {
    spam: t('xPanel writes the thresholds to the detected filter (rspamd local.d files or a SpamAssassin site file), checks them and reloads the filter. While filtering is on, the configuration generation adds the filter to Postfix after OpenDKIM (rspamd directly, SpamAssassin through spamass-milter).'),
    relay: t('xPanel sets relayhost, a TLS policy for the relay and, when a username is saved, a SASL password table readable only by root.'),
    bcc: t('xPanel sets always_bcc and the recipient and sender BCC tables. Account archive copies use the same tables; a rule here wins over an archive for the same domain.'),
    marketing: t('These Postfix limits apply to every SMTP client, including other mail servers. xPanel does not send campaigns.'),
  }
  // Read-only and unavailable documents carry no <form>; the same controls stay visible and disabled.
  const formTag = canManage ? 'form' : 'div'
  const card = (key: string, title: string, body: string): string => `<section class="xp-mailx__card" aria-labelledby="${id(key)}"><h2 id="${id(key)}">${title}</h2>${body}</section>`
  const engineFacts = page === 'spam' ? fact(t('Detected filter'), 'engine') + fact(t('Postfix passes mail to the filter'), 'wiring') : ''
  return `<section class="xp-mailx" data-mailx-whm data-mailx-page="${page}" data-mailx-can-read="${canRead}" data-mailx-can-manage="${canManage}" lang="${locale}" dir="${localeDirection(locale)}" aria-labelledby="${id('summary')}">
    ${MAILX_STYLE}
    ${card('summary', t('Policy and host state'), `<div class="xp-mailx__heading"><p>${notes[page]}</p><button type="button" class="xp-btn" data-mailx-refresh${canRead ? '' : ' disabled'}>${t('Refresh')}</button></div>
      <p class="xp-whm-detail-status" data-mailx-status data-state="unread" role="status">${t('The saved mail policy has not been read.')}</p>
      <dl class="xp-mailx__facts">${fact(t('Saved policy'), 'saved')}${fact(t('Host agent'), 'host')}${fact(t('Applied on this server'), 'state')}${engineFacts}${fact(t('Observed at (UTC)'), 'observed-at')}${fact(t('Last saved'), 'updated')}</dl>`)}
    ${card('form', titles[page], `<${formTag} class="xp-mailx__fields" data-mailx-form${canManage ? ' novalidate' : ''}>${fields[page].map(control).join('')}
      <p class="xp-help" data-mailx-form-status role="status"></p>
      <div class="xp-mailx__actions"><button type="${canManage ? 'submit' : 'button'}" class="xp-btn xp-btn--primary" data-mailx-save disabled>${t('Save and apply')}</button><button type="button" class="xp-btn" data-mailx-apply disabled>${t('Apply saved policy again')}</button></div></${formTag}>`)}
  </section>`
}
