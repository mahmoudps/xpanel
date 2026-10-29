import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
export interface WhmMailboxMaintenanceWorkspaceInput { locale: Locale; canRead: boolean; canManage: boolean }

/** Body for /whm/email/maintenance. Values are painted by WHM_MAILBOX_MAINTENANCE_CLIENT_BINDING from authorized reads only. */
export function renderWhmMailboxMaintenanceWorkspace({ locale, canRead, canManage }: WhmMailboxMaintenanceWorkspaceInput): string {
  const t = (message: string, values?: MessageValues): string => translator(locale)(message, values)
  const off = canRead ? '' : ' disabled'
  const notRead = t('Not read')
  const facts = (items: [string, string][]): string => `<dl class="xp-whm-mailbox-maintenance__facts">${items.map(([key, label]) => `<div><dt>${label}</dt><dd><bdi dir="ltr" data-whm-mailbox-maintenance-fact="${key}">${notRead}</bdi></dd></div>`).join('')}</dl>`
  const table = (caption: string, headers: string[], rows: string, empty: string): string => `<div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${caption}"><table class="xp-whm-detail-table xp-table"><caption class="xp-sr-only">${caption}</caption><thead><tr>${headers.map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody data-whm-mailbox-maintenance-rows="${rows}"><tr><td colspan="${headers.length}">${empty}</td></tr></tbody></table></div>`
  const card = (key: string, title: string, body: string, extra = ''): string => `<section class="xp-whm-mailbox-maintenance__card" aria-labelledby="whm-mailbox-maintenance-${key}-heading"><div class="xp-whm-mailbox-maintenance__heading"><h2 id="whm-mailbox-maintenance-${key}-heading">${title}</h2>${extra}</div>${body}</section>`
  const action = (operation: string, label: string, primary = false): string => `<button type="button" class="xp-btn${primary ? ' xp-btn--primary' : ''}" data-whm-mailbox-maintenance-run="${operation}" disabled>${label}</button>`
  const status = `<p class="xp-whm-detail-status" data-whm-mailbox-maintenance-status data-state="${canRead ? 'unread' : 'unavailable'}" role="status">${canRead ? t('Nothing has been read yet.') : t('Mailbox maintenance requires an authorized root administrator. Nothing was read or changed.')}</p>`
  const rootOnly = canRead && canManage ? '' : `<p class="xp-help">${t('Changes require root authorization.')}</p>`

  return `<section class="xp-whm-mailbox-maintenance" data-whm-mailbox-maintenance-workspace data-mailbox-maintenance-can-read="${canRead}" data-mailbox-maintenance-can-manage="${canRead && canManage}" lang="${locale}" dir="${localeDirection(locale)}">
    <style>.xp-whm-mailbox-maintenance h2{font-size:var(--xp-type-card);line-height:var(--xp-leading-card);font-weight:var(--xp-weight-semibold)}
    .xp-whm-mailbox-maintenance{display:flex;flex-direction:column;gap:32px;min-inline-size:0}.xp-whm-mailbox-maintenance :is(h2,p,dl,dd,ul){margin:0}.xp-whm-mailbox-maintenance__card{display:flex;flex-direction:column;gap:24px;padding:16px;min-inline-size:0;border:1px solid var(--xp-border);border-radius:8px;background:var(--xp-bg-surface)}
    .xp-whm-mailbox-maintenance__heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px}.xp-whm-mailbox-maintenance__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,160px),1fr));gap:16px}.xp-whm-mailbox-maintenance__facts>div,.xp-whm-mailbox-maintenance__field{display:flex;flex-direction:column;gap:8px;min-inline-size:0}.xp-whm-mailbox-maintenance dt{font-weight:600}.xp-whm-mailbox-maintenance dd{overflow-wrap:anywhere}
    .xp-whm-mailbox-maintenance__field{max-inline-size:480px}.xp-whm-mailbox-maintenance input:not([type=checkbox]){box-sizing:border-box;inline-size:100%;min-inline-size:0;min-block-size:44px;margin:0}.xp-whm-mailbox-maintenance[dir=rtl] input[dir=ltr]{text-align:right}.xp-whm-mailbox-maintenance input[type=checkbox]{inline-size:20px;block-size:20px;margin:0}
    .xp-whm-mailbox-maintenance__actions{display:flex;flex-wrap:wrap;align-items:center;gap:16px}.xp-whm-mailbox-maintenance :is(button,.xp-btn){min-block-size:44px}.xp-whm-mailbox-maintenance [hidden]{display:none}.xp-whm-mailbox-maintenance :focus-visible{outline:2px solid var(--xp-accent);outline-offset:2px}.xp-whm-mailbox-maintenance td bdi{unicode-bidi:isolate;overflow-wrap:anywhere}.xp-whm-mailbox-maintenance__help{display:grid;gap:var(--xp-space-field);padding-inline-start:var(--xp-space-group)}
    @media(min-width:601px){.xp-whm-mailbox-maintenance__card{padding:24px}}@media(max-width:639px){.xp-whm-mailbox-maintenance__actions>:is(button,a){flex:1 1 auto}}
    </style>
    ${card('mailboxes', t('Mailboxes'), `${status}
      ${facts([['count', t('Saved mailboxes')], ['fts', t('Full text search')], ['jobs', t('Host jobs')], ['observed-at', t('Observed at (UTC)')]])}
      <div class="xp-whm-mailbox-maintenance__field"><label for="whm-mailbox-maintenance-search">${t('Search mailboxes')}</label><input id="whm-mailbox-maintenance-search" class="xp-input xp-mono" type="search" dir="ltr" maxlength="254" autocomplete="off" data-whm-mailbox-maintenance-search${off}></div>
      <p class="xp-help">${t('Only saved email accounts are listed. Select up to 32 mailboxes for one maintenance job, or inspect one to read its usage.')}</p>
      <p class="xp-help" data-whm-mailbox-maintenance-limited hidden>${t('Only the first 200 matching mailboxes are shown. Refine the search to see others.')}</p>
      <p class="xp-help" data-whm-mailbox-maintenance-truncated hidden>${t('Only the first 2000 saved mailboxes were read.')}</p>
      ${table(t('Saved mailboxes'), [t('Select'), t(msgctxt('whm-mailbox-maintenance-workspace', 'Mailbox')), t('Account'), t('Saved quota'), t('Usage')], 'mailboxes', t('No mailboxes have been read.'))}`,
      `<button type="button" class="xp-btn" data-whm-mailbox-maintenance-refresh${off}>${t('Refresh')}</button>`)}
    ${card('usage', t('Mailbox usage'), `<p class="xp-help" data-whm-mailbox-maintenance-usage-status role="status">${t('Inspect a mailbox to read its quota and folder usage.')}</p>
      ${facts([['mailbox', t(msgctxt('whm-mailbox-maintenance-workspace', 'Mailbox'))], ['account', t('Account')], ['saved-quota', t('Saved quota')], ['storage', t('Storage used')], ['messages', t('Messages')], ['size', t('Folder size total')]])}
      <p class="xp-help">${t('Quota comes from doveadm quota get; folder counts and virtual sizes come from doveadm mailbox status. Message content is never read.')}</p>
      ${table(t('Quota'), [t('Quota root'), t('Resource'), t('Used'), t('Limit'), t('Percent')], 'quota', t('No quota has been read.'))}
      <p class="xp-help" data-whm-mailbox-maintenance-folders-truncated hidden>${t('Only the first 200 folders are listed. Totals include every folder.')}</p>
      ${table(t('Folders'), [t('Folder'), t('Messages'), t('Size')], 'folders', t('No folders have been read.'))}`)}
    ${card('actions', t(msgctxt('whm-mailbox-maintenance-workspace', 'Maintenance')), `<p data-whm-mailbox-maintenance-selected role="status">${t('Selected mailboxes: 0')}</p>
      <div class="xp-whm-mailbox-maintenance__actions">${action('quota-recalc', t('Recalculate quota'), true)}${action('resync', t('Rebuild indexes'))}${action('index', t('Update search index'))}<a class="xp-btn" href="/whm/jobs?lang=${locale}" data-whm-mailbox-maintenance-job-link hidden>${t('Open job')}</a></div>
      <ul class="xp-help xp-whm-mailbox-maintenance__help">
        <li>${t('Recalculate quota counts the stored messages again with doveadm quota recalc and replaces the recorded usage.')}</li>
        <li>${t('Rebuild indexes runs doveadm force-resync on every folder to fix broken mailbox indexes. Mail clients may resynchronize afterwards.')}</li>
        <li>${t('Update search index runs doveadm index on INBOX and is available only when Dovecot full text search is configured.')}</li>
      </ul>
      <p class="xp-help" data-whm-mailbox-maintenance-fts-note hidden>${t('Full text search is not configured in Dovecot, so the search index cannot be updated.')}</p>
      <p class="xp-help">${t('Each job runs one step per mailbox on the host and then reads every mailbox again to confirm the result. Repairing maildir ownership or permissions is not available here.')}</p>
      ${rootOnly}<p class="xp-whm-detail-status" data-whm-mailbox-maintenance-result role="status" hidden></p>`)}
  </section>`
}
