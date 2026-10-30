import { classicWhmClientTemplates } from './whm-client-templates.ts'
import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
export interface WhmMailQueueWorkspaceInput { locale: Locale; canRead: boolean; canManage: boolean }

/** Postfix queue workspace for /whm/email/queue. Rows are painted only from an authorized fresh read. */
export function renderWhmMailQueueWorkspace({ locale, canRead, canManage }: WhmMailQueueWorkspaceInput): string {
  const t = (message: string, values?: MessageValues): string => translator(locale)(message, values)
  const queues: [string, string][] = [['incoming', t('Incoming')], ['active', t(msgctxt('whm-mail-queue-workspace', 'Active'))], ['deferred', t(msgctxt('whm-mail-queue-workspace', 'Deferred'))], ['hold', t('Hold')], ['maildrop', t('Maildrop')]]
  const fact = (label: string, attribute: string): string => `<div><dt>${label}</dt><dd><bdi dir="ltr" ${attribute}>${t('Not read')}</bdi></dd></div>`
  const field = (id: string, label: string, control: string): string => `<div class="xp-whm-mail-queue__field"><label for="${id}">${label}</label>${control}</div>`
  const actions: [string, string][] = [['deliver', t('Retry now')], ['hold', t(msgctxt('whm-mail-queue-workspace', 'Hold'))], ['release', t('Release')], ['delete', t('Delete')]]
  const headers = [t('Queue ID'), t('Queue'), t('Arrived (UTC)'), t('Age'), t('Size'), t('Sender'), t('Recipients'), t('Delay reason'), t('Actions')]
  return `<section class="xp-whm-mail-queue" data-whm-mail-queue-workspace data-mail-queue-can-read="${canRead}" data-mail-queue-can-manage="${canRead && canManage}" lang="${locale}" dir="${localeDirection(locale)}" aria-labelledby="whm-mail-queue-summary-heading">${classicWhmClientTemplates('mail-queue')}
    <style>.xp-whm-mail-queue h2{font-size:var(--xp-type-card);line-height:var(--xp-leading-card);font-weight:var(--xp-weight-semibold)}
    .xp-whm-mail-queue{display:flex;flex-direction:column;gap:32px;min-inline-size:0}.xp-whm-mail-queue :is(h2,p,dl,dd,ol){margin:0}.xp-whm-mail-queue__card{display:flex;flex-direction:column;gap:24px;padding:16px;min-inline-size:0;border:1px solid var(--xp-border);border-radius:8px;background:var(--xp-bg-surface)}
    .xp-whm-mail-queue__heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px}.xp-whm-mail-queue__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,160px),1fr));gap:16px}.xp-whm-mail-queue__facts>div,.xp-whm-mail-queue__field{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-whm-mail-queue dt{font-weight:600}.xp-whm-mail-queue dd{overflow-wrap:anywhere}
    .xp-whm-mail-queue__fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.xp-whm-mail-queue :is(input:not([type=checkbox]),select){box-sizing:border-box;inline-size:100%;min-inline-size:0;min-block-size:44px;margin:0}.xp-whm-mail-queue[dir=rtl] input[dir=ltr]{text-align:right}
    .xp-whm-mail-queue__actions{display:flex;flex-wrap:wrap;align-items:center;gap:16px}.xp-whm-mail-queue__row-actions{display:flex;flex-wrap:wrap;gap:var(--xp-space-field)}.xp-whm-mail-queue button{min-block-size:44px}.xp-whm-mail-queue__results{display:flex;flex-direction:column;gap:8px;padding-inline-start:24px}.xp-whm-mail-queue [hidden]{display:none}.xp-whm-mail-queue :focus-visible{outline:2px solid var(--xp-accent);outline-offset:2px}
    .xp-whm-mail-queue td bdi{unicode-bidi:isolate}
    @media(min-width:601px){.xp-whm-mail-queue__card{padding:24px}}@media(max-width:639px){.xp-whm-mail-queue__fields{grid-template-columns:minmax(0,1fr)}.xp-whm-mail-queue__actions>button{flex:1 1 auto}}
    </style>
    <section class="xp-whm-mail-queue__card" aria-labelledby="whm-mail-queue-summary-heading">
      <div class="xp-whm-mail-queue__heading"><h2 id="whm-mail-queue-summary-heading">${t('Queue summary')}</h2><button type="button" class="xp-btn" data-whm-mail-queue-refresh${canRead ? '' : ' disabled'}>${t('Refresh queue')}</button></div>
      <p class="xp-whm-detail-status" data-whm-mail-queue-status data-state="unread" role="status">${t('The mail queue has not been read.')}</p>
      <dl class="xp-whm-mail-queue__facts">${queues.map(([key, label]) => fact(label, `data-whm-mail-queue-count="${key}"`)).join('')}${fact(t('Total size'), 'data-whm-mail-queue-total-size')}${fact(t('Observed at (UTC)'), 'data-whm-mail-queue-observed-at')}</dl>
      <p class="xp-help" data-whm-mail-queue-truncated hidden>${t('Only the first messages of a larger queue were read. Counts and totals cover the shown messages only.')}</p>
      <p class="xp-help">${t('Only envelope details are shown. Message content and headers are never read here.')}</p>
    </section>
    <section class="xp-whm-mail-queue__card" aria-labelledby="whm-mail-queue-messages-heading">
      <h2 id="whm-mail-queue-messages-heading">${t('Messages')}</h2>
      <div class="xp-whm-mail-queue__fields">
        ${field('whm-mail-queue-filter-queue', t('Queue'), `<select id="whm-mail-queue-filter-queue" class="xp-select" data-whm-mail-queue-filter="queue"${canRead ? '' : ' disabled'}><option value="">${t('All queues')}</option>${queues.map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}</select>`)}
        ${field('whm-mail-queue-filter-text', t('Sender or recipient'), `<input id="whm-mail-queue-filter-text" class="xp-input xp-mono" type="search" dir="ltr" maxlength="254" autocomplete="off" data-whm-mail-queue-filter="text"${canRead ? '' : ' disabled'}>`)}
        ${field('whm-mail-queue-filter-age', t('Age'), `<select id="whm-mail-queue-filter-age" class="xp-select" data-whm-mail-queue-filter="age"${canRead ? '' : ' disabled'}><option value="0">${t('Any age')}</option><option value="3600">${t('Older than 1 hour')}</option><option value="86400">${t('Older than 24 hours')}</option><option value="604800">${t('Older than 7 days')}</option></select>`)}
      </div>
      <div class="xp-whm-mail-queue__actions" data-whm-mail-queue-bulk-bar><span data-whm-mail-queue-selected>${t('Selected: 0')}</span>${actions.map(([key, label]) => `<button type="button" class="xp-btn${key === 'delete' ? ' xp-btn--danger' : ''}" data-whm-mail-queue-bulk="${key}" disabled>${label}</button>`).join('')}</div>
      <p class="xp-help">${t('Bulk actions run one message at a time, up to 50 messages, and report each result.')}${canRead && canManage ? '' : ' ' + t('Queue management requires root authorization.')}</p>
      <p class="xp-whm-detail-status" data-whm-mail-queue-result role="status" hidden></p>
      <ol class="xp-whm-mail-queue__results" data-whm-mail-queue-results hidden></ol>
      <div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${t('Queued messages')}"><table class="xp-whm-detail-table xp-table"><caption class="xp-sr-only">${t('Queued messages')}</caption><thead><tr><th scope="col"><input type="checkbox" data-whm-mail-queue-select-all aria-label="${t('Select all shown messages')}" disabled></th>${headers.map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-whm-mail-queue-rows><tr><td colspan="10">${t('No messages have been read.')}</td></tr></tbody></table></div>
    </section>
  </section>`
}
