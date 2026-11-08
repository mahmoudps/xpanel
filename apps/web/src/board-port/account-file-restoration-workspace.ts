import { backupFilesClientTemplates } from './whm-backup-files-client-templates.ts'
import { localeDirection, translator, type Locale, type MessageValues } from '../i18n.ts'
import { escapeHtml } from '../tokens.ts'
import { ACCOUNT_TOOL_STYLE } from './account-ssh-workspace.ts'

/**
 * cPanel File and Directory Restoration for the signed-in owner, on /files/backup. The shared backup-files
 * controller runs in owner mode: the session account is fixed and the hidden picker never offers another one.
 */
export function renderAccountFileRestorationWorkspace(input: { lang: Locale; username: string; canRead: boolean; canRestore: boolean }): string {
  const t = (message: string, values?: MessageValues): string => translator(input.lang)(message, values)
  const off = ' disabled', unread = t('Not read')
  const card = (key: string, title: string, body: string): string => `<section class="xp-acct-tool__card" aria-labelledby="file-restoration-${key}"><h2 id="file-restoration-${key}">${title}</h2>${body}</section>`
  const table = (label: string, marker: string, headers: readonly string[], empty: string): string => `<div class="xp-acct-tool__table" role="region" tabindex="0" aria-label="${label}"><table class="xp-table"><caption class="xp-sr-only">${label}</caption><thead><tr>${headers.map(header => `<th scope="col">${header}</th>`).join('')}</tr></thead><tbody data-backup-files-${marker}><tr><td colspan="${headers.length}">${empty}</td></tr></tbody></table></div>`
  const facts = (rows: readonly (readonly [string, string])[]): string => `<dl class="xp-acct-tool__facts">${rows.map(([key, label]) => `<div><dt>${label}</dt><dd data-backup-files-${key}>${unread}</dd></div>`).join('')}</dl>`
  const steps = [['backup', t('Backup')], ['files', t('Files')], ['review', t('Review')], ['result', t('Result')]] as const
  return `<div class="xp-acct-tool xp-file-restoration" data-whm-backup-files-workspace data-backup-files-owner="true" data-backup-files-username="${escapeHtml(input.username)}" data-backup-files-can-read="${input.canRead}" data-backup-files-can-restore="${input.canRead && input.canRestore}" lang="${input.lang}" dir="${localeDirection(input.lang)}">${ACCOUNT_TOOL_STYLE}
    <style>.xp-file-restoration fieldset{display:grid;gap:16px;border:0;padding:0;margin:0;min-inline-size:0}.xp-file-restoration legend{padding:0;margin-block-end:8px;font-weight:600}.xp-file-restoration ol{display:flex;flex-wrap:wrap;gap:16px;margin:0;padding:0;list-style:none}.xp-file-restoration ol li{display:inline-flex;gap:8px}.xp-file-restoration ol li[aria-current=step]{font-weight:600}.xp-file-restoration__choice{display:flex;gap:8px;align-items:flex-start}.xp-file-restoration__choice input{inline-size:20px;block-size:20px;min-block-size:0;margin:0}.xp-file-restoration td input[type=checkbox]{inline-size:20px;block-size:20px;min-block-size:0;margin:0}.xp-file-restoration .xp-whm-backup-files__open{padding:0;border:0;background:none;color:var(--xp-accent);font:inherit;text-align:start;cursor:pointer;min-block-size:44px;text-decoration:underline}</style>
    <section class="xp-acct-tool__card" aria-labelledby="file-restoration-heading"><h2 id="file-restoration-heading">${t('File and Directory Restoration')}</h2>
      <p class="xp-help">${t('Restore single files or folders of your home folder from the server backups. Mail, panel settings and the trash need a full account restore.')}</p>
      <ol data-backup-files-steps aria-label="${t('Restore steps')}">${steps.map(([key, label], index) => `<li data-step="${key}"${index === 0 ? ' aria-current="step"' : ''}><strong>${index + 1}</strong>${label}</li>`).join('')}</ol>
      <select data-backup-files-account hidden${off}><option value="${escapeHtml(input.username)}">${escapeHtml(input.username)}</option></select>
      <p data-backup-files-status data-state="${input.canRead ? 'unread' : 'unavailable'}" role="status">${input.canRead ? t('Backups have not been read.') : t('File restoration is not available for this account. Nothing was read or changed.')}</p>
      ${table(t('Backups of your account'), 'archives', [t('Created (UTC)'), t('Archive'), t('Size'), t('Integrity'), t('Action')], t('Backups have not been read.'))}</section>
    ${card('files', t('Files in the backup'), `${facts([['archive', t('Archive')], ['integrity', t('Integrity')], ['sha256', t('Archive SHA-256')]])}
      <div class="xp-acct-tool__actions"><button type="button" class="xp-btn" data-backup-files-up${off}>${t(msgctxt('whm-backup-files-workspace', 'Parent folder'))}</button><span>${t('Folder')} <bdi dir="ltr" data-backup-files-path>/</bdi></span></div>
      ${table(t('Files and folders in the archive'), 'entries', [t('Select'), t('Name'), t('Type'), t('Size')], t('No backup has been opened.'))}
      <p class="xp-help" data-backup-files-selection role="status">${t('Nothing is selected. Up to 500 files or folders can be selected.')}</p>
      <fieldset data-backup-files-destination${off}><legend>${t('Restore to')}</legend>
        <label class="xp-file-restoration__choice"><input type="radio" name="file-restoration-destination" value="replace" checked${off}><span>${t('The original location, replacing the current file')}</span></label>
        <label class="xp-file-restoration__choice"><input type="radio" name="file-restoration-destination" value="new-folder"${off}><span>${t('A new folder in your home folder:')} <bdi dir="ltr" data-backup-files-folder>restored-…</bdi></span></label>
      </fieldset>
      <div class="xp-acct-tool__actions"><button type="button" class="xp-btn" data-backup-files-clear${off}>${t(msgctxt('whm-backup-files-workspace', 'Clear selection'))}</button><button type="button" class="xp-btn xp-btn--primary" data-backup-files-preview${off}>${t('Review restore')}</button></div>`)}
    ${card('review', t('Review'), `${facts([['count-restore', t('Files to restore')], ['count-present', t('Present now')], ['count-refused', t('Cannot be restored here')], ['planned', t('Planned size')], ['quota', t('Plan disk quota')], ['writer', t('Account file writer')]])}
      ${table(t('Planned file restore'), 'review', [t('Path in backup'), t('Destination'), t('Size'), t('Planned action')], t('No restore has been reviewed.'))}
      <label class="xp-file-restoration__choice"><input type="checkbox" data-backup-files-ack${off}><span>${t('I reviewed this list. Restoring to the original location replaces the current files.')}</span></label>
      <div class="xp-acct-tool__actions"><button type="button" class="xp-btn xp-btn--primary" data-backup-files-restore${off}>${t('Restore files')}</button></div>`)}
    ${card('result', t('Result'), `${facts([['count-restored', t('Restored')], ['count-skipped', t('Skipped, already present')], ['count-failed', t(msgctxt('whm-backup-files-workspace', 'Failed'))], ['count-pending', t('Not attempted yet')]])}
      ${table(t('File restore results'), 'results', [t('Path in backup'), t('Destination'), t('Result'), t('Reason')], t('No restore has run.'))}
      <div class="xp-acct-tool__actions"><button type="button" class="xp-btn" data-backup-files-continue hidden${off}>${t('Continue restore')}</button></div>`)}
    ${backupFilesClientTemplates()}
  </div>`
}
