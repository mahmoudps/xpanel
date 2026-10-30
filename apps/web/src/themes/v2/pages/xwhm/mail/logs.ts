import { v2WhmClientTemplates } from '../../../whm-client-templates.ts'
import { formField } from '../../../components/form-field.ts'
import { escapeHtml } from '../../../html.ts'
import { button, facts, group, mailContext, page, status, table, type WhmMailPageInput } from './common.ts'

export function renderV2WhmMailLog(input: WhmMailPageInput, mode: 'delivery' | 'monitor'): string {
  const { t, locale, dir, canRead } = mailContext(input)
  const delivery = mode === 'delivery', prefix = `whm-mail-${mode}`
  const range = formField({ id: `${prefix}-range`, label: t(msgid('Time range')), control: { kind: 'select', name: `${prefix}-range`, disabled: true,
    hooks: { 'data-mail-log-range': true }, options: [
      { value: '1', label: t(msgid('Last hour')) }, { value: '6', label: t(msgid('Last 6 hours')) },
      { value: '24', label: t(msgid('Last 24 hours')), selected: true }, { value: '72', label: t(msgid('Last 3 days')) },
      { value: '168', label: t(msgid('Last 7 days')) }, ...(delivery ? [{ value: 'custom', label: t(msgid('Custom UTC range')) }] : []),
    ],
  } })
  const text = (name: string, label: string, help?: string, custom = false): string => formField({ id: `${prefix}-${name}`, label,
    ...(help ? { help } : {}), control: { kind: 'input', type: 'text', name, dir: 'ltr', mono: true, autocomplete: 'off', spellcheck: false,
      maxlength: name === 'dsn' ? 9 : 254, disabled: true, ...(custom ? { hooks: { 'data-mail-log-custom': true }, placeholder: 'YYYY-MM-DD HH:MM' } : {}) },
  })
  const filters = delivery ? `${formField({ id: `${prefix}-status`, label: t(msgid('Status')), control: { kind: 'select', name: 'status', disabled: true,
    options: [['', msgid('Any status')], ['sent', msgid('Delivered')], ['deferred', msgid('Deferred')], ['bounced', msgid('Bounced')],
      ['expired', msgid('Expired')], ['rejected', msgid('Rejected')], ['queued', msgid('Queued')]].map(([value, label]) => ({ value: value!, label: t(label!) })),
  } })}${text('since', t(msgid('From (UTC)')), t(msgid('Format YYYY-MM-DD HH:MM, for the custom range only.')), true)}
${text('until', t(msgid('To (UTC)')), t(msgid('At most 7 days after the start.')), true)}${text('sender', t(msgid('Sender contains')))}${text('recipient', t(msgid('Recipient contains')))}
${text('domain', t(msgid('Domain')), t(msgid('Exact sender or recipient domain.')))}${text('dsn', t(msgid('DSN code')), t(msgid('A class such as 5 or 4.4 matches every code inside it.')))}` : ''
  const formTag = canRead ? 'form' : 'div'
  const search = group(`${mode}-search`, delivery ? t(msgid('Search deliveries')) : t(msgid('Mail flow')),
    `<${formTag} data-mail-log-form${delivery ? ' role="search"' : ''}><div class="v2-whm-mail__fields">${range}${filters}</div>
<div class="v2-whm-mail__actions"><button type="submit" class="v2-btn v2-btn--primary" data-mail-log-submit disabled>${escapeHtml(delivery ? t(msgctxt('whm-mail-log-workspace', 'Apply filters')) : t(msgid('Read mail flow')))}</button>${delivery ? button(t(msgctxt('whm-mail-log-workspace', 'Clear filters')), { 'data-mail-log-clear': true }) : ''}</div></${formTag}>`)
  const integrity = `<p data-mail-log-integrity hidden></p><p data-mail-log-limit role="note" hidden>${escapeHtml(t(msgid('The bounded read reached its line or size limit, so this view may be incomplete. Narrow the time range.')))}</p>`
  const observed = `${status(delivery ? t(msgid('Delivery events have not been read.')) : t(msgid('Mail flow has not been read.')), { 'data-mail-log-status': true })}
${facts(t, [['observed', msgid('Observed at (UTC)')], ['window', msgid('Window (UTC)')], [delivery ? 'matched' : 'messages', delivery ? msgid('Matching messages') : msgid('Messages')],
    ...(delivery ? [] : [['records', msgid('Journal records')]] as const)], 'data-mail-log-fact')}${integrity}`
  if (!delivery) {
    const counts = [['sent', msgid('Delivered')], ['deferred', msgid('Deferred')], ['bounced', msgid('Bounced')], ['rejected', msgid('Rejected')], ['expired', msgid('Expired')], ['queued', msgid('Still queued')]] as const
    const summary = group('monitor-summary', t(msgid('Messages by final status')), `${observed}<dl class="v2-whm-mail__facts">${counts.map(([key, label]) => `<div><dt>${escapeHtml(t(label))}</dt><dd data-mail-monitor-count="${key}">${escapeHtml(t(msgid('Not read')))}</dd></div>`).join('')}</dl><p>${escapeHtml(t(msgid('Counts are messages by their latest observed state inside the window; a deferred message may still be delivered later.')))}</p>`)
    const ranking = [['senders', msgid('Top senders'), [msgid('Sender'), msgid('Messages')]], ['domains', msgid('Top recipient domains'), [msgid('Domain'), msgid('Recipients')]],
      ['deferrals', msgid('Deferral reasons'), [msgid('DSN'), msgid('Reason'), msgid('Attempts')]]] as const
    return page(input, '/whm/email/monitor', t(msgid('Mail monitor')), t(msgid('Mail flow counts computed from the same parsed journal window. Read-only.')),
      `<div class="v2-whm-mail__stack" data-whm-mail-log="monitor" data-mail-log-can-read="${canRead}" lang="${locale}" dir="${dir}">${search}${summary}${ranking.map(([key, label, headings]) => group(`monitor-${key}`, t(label), table(t, t(label), headings.map(value => t(value)), { 'data-mail-monitor-table': key }, t(msgid('Not read'))))).join('')}</div>`)
  }
  const results = group('delivery-results', t(msgid('Messages')), `${observed}<p data-mail-log-omitted hidden></p>
${table(t, t(msgid('Delivery messages, newest first')), [t(msgid('Last event (UTC)')), t(msgid('Queue ID')), t(msgid('Sender')), t(msgid('Recipients')), t(msgid('Status')), t(msgid('DSN')), t(msgid('Timeline'))], { 'data-mail-log-rows': true }, t(msgid('No delivery events have been read.')))}
<div class="v2-whm-mail__actions">${button(t(msgid('Newer')), { 'data-mail-log-page': 'newer' })}<span data-mail-log-page-label></span>${button(t(msgid('Older')), { 'data-mail-log-page': 'older' })}</div>`)
  const detail = group('delivery-selected', t(msgid('Selected message')), `<div data-mail-log-detail tabindex="-1"><p data-mail-log-detail-empty>${escapeHtml(t(msgid('Choose a message to see its recipients and timeline.')))}</p>
<div class="v2-whm-mail__stack" data-mail-log-detail-body hidden><dl class="v2-whm-mail__facts" data-mail-log-detail-facts></dl><h3>${escapeHtml(t(msgid('Recipients')))}</h3>
${table(t, t(msgid('Recipients of the selected message')), [t(msgid('Recipient')), t(msgid('Status')), t(msgid('DSN')), t(msgid('Relay')), t(msgid('Attempts')), t(msgid('Response'))], { 'data-mail-log-detail-recipients': true }, t(msgid('Not read')))}
<h3>${escapeHtml(t(msgid('Timeline')))}</h3><ol class="v2-whm-mail__timeline" data-mail-log-detail-events></ol></div></div>`)
  return page(input, '/whm/email/delivery', t(msgid('Delivery reports')), t(msgid('Postfix delivery events from the system journal, grouped by queue ID. Read-only.')),
    `<div class="v2-whm-mail__split" data-whm-mail-log="delivery" data-mail-log-can-read="${canRead}" lang="${locale}" dir="${dir}">${v2WhmClientTemplates('mail-log')}<div class="v2-whm-mail__stack">${search}${results}</div><aside>${detail}</aside></div>`)
}
