import { v2WhmClientTemplates } from '../../../whm-client-templates.ts'
import { formField } from '../../../components/form-field.ts'
import { escapeHtml } from '../../../html.ts'
import { button, facts, group, mailContext, page, status, table, type WhmMailPageInput } from './common.ts'

export function renderV2WhmMailQueue(input: WhmMailPageInput): string {
  const { t, locale, dir, canRead, canManage } = mailContext(input)
  const queues = [['incoming', msgid('Incoming')], ['active', msgctxt('whm-mail-queue-workspace', 'Active')],
    ['deferred', msgctxt('whm-mail-queue-workspace', 'Deferred')], ['hold', msgid('Hold')], ['maildrop', msgid('Maildrop')]] as const
  const summary = group('queue-summary', t(msgctxt('theme:v2', 'Queue summary')),
    `${status(t(msgid('The mail queue has not been read.')), { 'data-whm-mail-queue-status': true })}
<dl class="v2-whm-mail__facts">${queues.map(([key, label]) => `<div><dt>${escapeHtml(t(label))}</dt><dd><bdi dir="ltr" data-whm-mail-queue-count="${key}">${escapeHtml(t(msgid('Not read')))}</bdi></dd></div>`).join('')}
<div><dt>${escapeHtml(t(msgid('Total size')))}</dt><dd><bdi dir="ltr" data-whm-mail-queue-total-size>${escapeHtml(t(msgid('Not read')))}</bdi></dd></div><div><dt>${escapeHtml(t(msgid('Observed at (UTC)')))}</dt><dd><bdi dir="ltr" data-whm-mail-queue-observed-at>${escapeHtml(t(msgid('Not read')))}</bdi></dd></div></dl>
<p data-whm-mail-queue-truncated hidden>${escapeHtml(t(msgid('Only the first messages of a larger queue were read. Counts and totals cover the shown messages only.')))}</p><p>${escapeHtml(t(msgid('Only envelope details are shown. Message content and headers are never read here.')))}</p>`,
    button(t(msgid('Refresh')), { 'data-whm-mail-queue-refresh': true }, !canRead))
  const filters = `<div class="v2-whm-mail__fields">${formField({ id: 'v2-mail-queue-filter-queue', label: t(msgid('Queue')), control: {
    kind: 'select', disabled: !canRead, hooks: { 'data-whm-mail-queue-filter': 'queue' }, options: [{ value: '', label: t(msgid('All queues')) }, ...queues.map(([value, label]) => ({ value, label: t(label) }))],
  } })}${formField({ id: 'v2-mail-queue-filter-text', label: t(msgid('Sender or recipient')), control: { kind: 'input', type: 'search', dir: 'ltr', mono: true, maxlength: 254,
    autocomplete: 'off', disabled: !canRead, hooks: { 'data-whm-mail-queue-filter': 'text' } } })}${formField({ id: 'v2-mail-queue-filter-age', label: t(msgid('Age')), control: {
    kind: 'select', disabled: !canRead, hooks: { 'data-whm-mail-queue-filter': 'age' }, options: [
      { value: '0', label: t(msgid('Any age')) }, { value: '3600', label: t(msgid('Older than 1 hour')) },
      { value: '86400', label: t(msgid('Older than 24 hours')) }, { value: '604800', label: t(msgid('Older than 7 days')) },
    ],
  } })}</div>`
  const actions = [['deliver', msgid('Retry now')], ['hold', msgctxt('whm-mail-queue-workspace', 'Hold')], ['release', msgid('Release')], ['delete', msgid('Delete')]] as const
  const headings = [t(msgid('Queue ID')), t(msgid('Queue')), t(msgid('Arrived (UTC)')), t(msgid('Age')), t(msgid('Size')), t(msgid('Sender')), t(msgid('Recipients')), t(msgid('Delay reason')), t(msgid('Actions'))]
  const messages = group('queue-messages', t(msgid('Messages')), `${filters}
<div class="v2-whm-mail__actions" data-whm-mail-queue-bulk-bar><span data-whm-mail-queue-selected>${escapeHtml(t(msgid('Selected: 0')))}</span>${actions.map(([key, label]) => button(t(label), { 'data-whm-mail-queue-bulk': key }, true, key === 'delete' ? 'danger' : 'default')).join('')}</div>
<p>${escapeHtml(t(msgid('Bulk actions run one message at a time, up to 50 messages, and report each result.')))}</p>
${status('', { 'data-whm-mail-queue-result': true }, true)}<ol class="v2-whm-mail__timeline" data-whm-mail-queue-results hidden></ol>
<div class="v2-whm-mail__scroll" role="region" tabindex="0" aria-label="${escapeHtml(t(msgid('Queued messages')))}"><table class="v2-whm-mail__table"><caption class="v2-sr">${escapeHtml(t(msgid('Queued messages')))}</caption><thead><tr><th scope="col"><input type="checkbox" data-whm-mail-queue-select-all aria-label="${escapeHtml(t(msgid('Select all shown messages')))}" disabled></th>${headings.map(label => `<th scope="col">${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody data-whm-mail-queue-rows><tr><td colspan="10">${escapeHtml(t(msgid('No messages have been read.')))}</td></tr></tbody></table></div>`)
  return page(input, '/whm/email/queue', t(msgid('Mail queue')), t(msgid('Postfix queue envelopes, delay reasons and per-message actions. Message content is never shown.')),
    `<div class="v2-whm-mail__stack" data-whm-mail-queue-workspace data-mail-queue-can-read="${canRead}" data-mail-queue-can-manage="${canManage}" lang="${locale}" dir="${dir}">${v2WhmClientTemplates('mail-queue')}${summary}${messages}</div>`)
}

export function renderV2WhmMailQuality(input: WhmMailPageInput): string {
  const { t, locale, dir, canRead } = mailContext(input)
  const summary = group('quality-summary', t(msgid('Sending identity')),
    `${status(t(msgid('Hosted mail domains have not been read.')), { 'data-whm-mail-quality-status': true })}${facts(t, [
      ['hostname', msgid('Server hostname')], ['helo', msgid('HELO name')], ['addresses', msgid('Sending addresses')], ['checked', msgid('Domains checked')],
      ['problems', msgid('Domains with problems')], ['unavailable', msgid('Domains with unavailable checks')], ['checked-at', msgid('Last check (UTC)')],
    ], 'data-whm-mail-quality-fact')}
<ul><li>${escapeHtml(t(msgid("Checks query live DNS through this server's resolver and change nothing. Fix problems in")))} <a href="/whm/dns">${escapeHtml(t(msgid('DNS zones')))}</a> ${escapeHtml(t(msgid('or review')))} <a href="/whm/email/server">${escapeHtml(t(msgid('Mail server')))}</a>.</li>
<li>${escapeHtml(t(msgid('SPF is evaluated for the sending addresses. include: and redirect= are followed one level; ptr, exists and macros are reported as not decidable.')))}</li>
<li>${escapeHtml(t(msgid('DKIM is compared with the signing key on this server, or with the saved zone record when the key cannot be read. Reverse DNS is set by the provider of each IP address.')))}</li></ul>`,
    button(t(msgid('Reload domains')), { 'data-whm-mail-quality-refresh': true }, !canRead))
  const domains = group('quality-domains', t(msgid('Hosted mail domains')), `<div class="v2-whm-mail__actions"><span data-whm-mail-quality-selected>${escapeHtml(t(msgid('Selected: 0')))}</span>${button(t(msgid('Check selected')), { 'data-whm-mail-quality-check': true }, true, 'primary')}</div>
<p>${escapeHtml(t(msgid('Up to 50 domains per check, 5 at a time, within a bounded time limit.')))}</p>${status('', { 'data-whm-mail-quality-result': true }, true)}<p data-whm-mail-quality-truncated hidden>${escapeHtml(t(msgid('Only the first 2000 domains are listed.')))}</p>
<div class="v2-whm-mail__scroll" role="region" tabindex="0" aria-label="${escapeHtml(t(msgid('Hosted mail domains')))}"><table class="v2-whm-mail__table"><caption class="v2-sr">${escapeHtml(t(msgid('Hosted mail domains')))}</caption><thead><tr><th scope="col"><input type="checkbox" data-whm-mail-quality-select-all aria-label="${escapeHtml(t(msgid('Select the first 50 domains')))}" disabled></th>${[t(msgid('Domain')), t(msgid('Account')), 'MX', 'SPF', 'DKIM', 'DMARC', t(msgid('Reverse DNS')), t(msgid('Checked (UTC)'))].map(label => `<th scope="col">${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody data-whm-mail-quality-rows><tr><td colspan="9">${escapeHtml(t(msgid('No domains have been read.')))}</td></tr></tbody></table></div>`)
  return page(input, '/whm/email/quality', t(msgid('Mail quality')), t(msgid('Live DNS checks of MX, SPF, DKIM, DMARC and reverse DNS for each hosted mail domain. Read-only.')),
    `<div class="v2-whm-mail__stack" data-whm-mail-quality-workspace data-mail-quality-can-read="${canRead}" lang="${locale}" dir="${dir}">${v2WhmClientTemplates('mail-quality')}${summary}${domains}</div>`)
}

export function renderV2WhmMailboxMaintenance(input: WhmMailPageInput): string {
  const { t, locale, dir, canRead, canManage } = mailContext(input)
  const mailboxes = group('maintenance-mailboxes', t(msgid('Mailboxes')),
    `${status(canRead ? t(msgid('Nothing has been read yet.')) : t(msgid('Mailbox maintenance requires an authorized root administrator. Nothing was read or changed.')), { 'data-whm-mailbox-maintenance-status': true })}
${facts(t, [['count', msgid('Saved mailboxes')], ['fts', msgid('Full text search')], ['jobs', msgid('Host jobs')], ['observed-at', msgid('Observed at (UTC)')]], 'data-whm-mailbox-maintenance-fact')}
${formField({ id: 'v2-mail-maintenance-search', label: t(msgid('Search mailboxes')), control: { kind: 'input', type: 'search', dir: 'ltr', mono: true,
      maxlength: 254, autocomplete: 'off', disabled: !canRead, hooks: { 'data-whm-mailbox-maintenance-search': true } } })}
<p>${escapeHtml(t(msgid('Only saved email accounts are listed. Select up to 32 mailboxes for one maintenance job, or inspect one to read its usage.')))}</p>
<p data-whm-mailbox-maintenance-limited hidden>${escapeHtml(t(msgid('Only the first 200 matching mailboxes are shown. Refine the search to see others.')))}</p>
<p data-whm-mailbox-maintenance-truncated hidden>${escapeHtml(t(msgid('Only the first 2000 saved mailboxes were read.')))}</p>
${table(t, t(msgid('Saved mailboxes')), [t(msgid('Select')), t(msgctxt('whm-mailbox-maintenance-workspace', 'Mailbox')), t(msgid('Account')), t(msgid('Saved quota')), t(msgid('Usage'))], { 'data-whm-mailbox-maintenance-rows': 'mailboxes' }, t(msgid('No mailboxes have been read.')))}`,
    button(t(msgid('Refresh')), { 'data-whm-mailbox-maintenance-refresh': true }, !canRead))
  const usage = group('maintenance-usage', t(msgid('Mailbox usage')),
    `${status(t(msgid('Inspect a mailbox to read its quota and folder usage.')), { 'data-whm-mailbox-maintenance-usage-status': true })}
${facts(t, [['mailbox', msgctxt('whm-mailbox-maintenance-workspace', 'Mailbox')], ['account', msgid('Account')], ['saved-quota', msgid('Saved quota')],
      ['storage', msgid('Storage used')], ['messages', msgid('Messages')], ['size', msgid('Folder size total')]], 'data-whm-mailbox-maintenance-fact')}
<p>${escapeHtml(t(msgid('Quota comes from doveadm quota get; folder counts and virtual sizes come from doveadm mailbox status. Message content is never read.')))}</p>
${table(t, t(msgid('Quota')), [t(msgid('Quota root')), t(msgid('Resource')), t(msgid('Used')), t(msgid('Limit')), t(msgid('Percent'))], { 'data-whm-mailbox-maintenance-rows': 'quota' }, t(msgid('No quota has been read.')))}
<p data-whm-mailbox-maintenance-folders-truncated hidden>${escapeHtml(t(msgid('Only the first 200 folders are listed. Totals include every folder.')))}</p>
${table(t, t(msgid('Folders')), [t(msgid('Folder')), t(msgid('Messages')), t(msgid('Size'))], { 'data-whm-mailbox-maintenance-rows': 'folders' }, t(msgid('No folders have been read.')))}`)
  const actions = group('maintenance-actions', t(msgctxt('whm-mailbox-maintenance-workspace', 'Maintenance')),
    `<p data-whm-mailbox-maintenance-selected role="status">${escapeHtml(t(msgid('Selected mailboxes: 0')))}</p><div class="v2-whm-mail__actions">
${button(t(msgid('Recalculate quota')), { 'data-whm-mailbox-maintenance-run': 'quota-recalc' }, true, 'primary')}${button(t(msgid('Rebuild indexes')), { 'data-whm-mailbox-maintenance-run': 'resync' })}${button(t(msgid('Update search index')), { 'data-whm-mailbox-maintenance-run': 'index' })}<a class="v2-btn" href="/whm/jobs?lang=${locale}" data-whm-mailbox-maintenance-job-link hidden>${escapeHtml(t(msgid('Open job')))}</a></div>
<ul><li>${escapeHtml(t(msgid('Recalculate quota counts the stored messages again with doveadm quota recalc and replaces the recorded usage.')))}</li>
<li>${escapeHtml(t(msgid('Rebuild indexes runs doveadm force-resync on every folder to fix broken mailbox indexes. Mail clients may resynchronize afterwards.')))}</li>
<li>${escapeHtml(t(msgid('Update search index runs doveadm index on INBOX and is available only when Dovecot full text search is configured.')))}</li></ul>
<p data-whm-mailbox-maintenance-fts-note hidden>${escapeHtml(t(msgid('Full text search is not configured in Dovecot, so the search index cannot be updated.')))}</p>
<p>${escapeHtml(t(msgid('Each job runs one step per mailbox on the host and then reads every mailbox again to confirm the result. Repairing maildir ownership or permissions is not available here.')))}</p>
${status('', { 'data-whm-mailbox-maintenance-result': true }, true)}`)
  return page(input, '/whm/email/maintenance', t(msgid('Mailbox maintenance')), t(msgid('Per-mailbox quota and folder usage from Dovecot, with quota recalculation, index rebuilds and search indexing that run as verified host jobs.')),
    `<div class="v2-whm-mail__stack" data-whm-mailbox-maintenance-workspace data-mailbox-maintenance-can-read="${canRead}" data-mailbox-maintenance-can-manage="${canManage}" lang="${locale}" dir="${dir}">${v2WhmClientTemplates('mailbox-maintenance')}${mailboxes}${usage}${actions}</div>`)
}
