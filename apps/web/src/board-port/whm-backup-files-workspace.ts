import { type Locale, type MessageValues, translator, localeDirection } from '../i18n.ts'
/**
 * /whm/backups/files wizard body. Accounts, archives, file trees, reviews and results are filled by
 * WHM_BACKUP_FILES_CLIENT_BINDING from authorized reads only; nothing here is assumed or pre-filled.
 */
export function renderWhmBackupFilesWorkspace(input: { locale: Locale; canRead: boolean; canRestore: boolean }): { main: string; aside: string } {
  const t = (message: string, values?: MessageValues): string => translator(input.locale)(message, values)
  const off = ' disabled'
  const card = (key: string, title: string, body: string): string => `<section class="xp-whm-detail-card" data-whm-detail-section="backup-files-${key}" aria-labelledby="whm-detail-backup-files-${key}"><h2 id="whm-detail-backup-files-${key}">${title}</h2>${body}</section>`
  const table = (label: string, marker: string, headers: readonly string[], empty: string): string => `<div class="xp-whm-detail-scroll" role="region" tabindex="0" aria-label="${label}"><table class="xp-table xp-whm-detail-table"><caption class="xp-sr-only">${label}</caption><thead><tr>${headers.map(header => `<th scope="col">${header}</th>`).join('')}</tr></thead><tbody data-backup-files-${marker}><tr><td colspan="${headers.length}">${empty}</td></tr></tbody></table></div>`
  const fact = (key: string, label: string): string => `<div class="xp-whm-detail-field"><dt>${label}</dt><dd data-backup-files-${key}>${t('Not read')}</dd></div>`
  const steps = [['account', t('Account')], ['backup', t('Backup')], ['files', t('Files')], ['review', t('Review')], ['result', t('Result')]] as const
  const main = `<div class="xp-whm-backup-files" data-whm-backup-files-workspace data-backup-files-can-read="${input.canRead}" data-backup-files-can-restore="${input.canRead && input.canRestore}" lang="${input.locale}" dir="${localeDirection(input.locale)}">
    <style>.xp-whm-backup-files{display:flex;flex-direction:column;gap:32px;min-inline-size:0}.xp-whm-backup-files :is(h2,p,dl,dd,ol,ul,fieldset){margin:0}.xp-whm-backup-files fieldset{display:flex;flex-direction:column;gap:16px;border:0;padding:0;min-inline-size:0}.xp-whm-backup-files legend{padding:0;margin-block-end:8px;font-weight:600}.xp-whm-backup-files__path{display:inline-flex;flex-wrap:wrap;gap:8px;align-items:center;min-inline-size:0;overflow-wrap:anywhere}.xp-whm-backup-files__open{padding:0;border:0;background:none;color:var(--xp-accent,#1d5bd6);font:inherit;text-align:start;cursor:pointer;min-block-size:44px;text-decoration:underline}.xp-whm-backup-files td input[type=checkbox]{inline-size:20px;block-size:20px;margin:0}.xp-whm-backup-files [data-backup-files-steps] li[aria-current=step]{font-weight:600}.xp-whm-backup-files :is(button,input,select):focus-visible{outline:2px solid var(--xp-accent,#1d5bd6);outline-offset:2px}.xp-whm-backup-files :disabled{cursor:not-allowed;opacity:.75}.xp-whm-backup-files [data-whm-detail-section="backup-files-result"]>.xp-whm-detail-actions:has(>[data-backup-files-continue][hidden]){display:none}</style>
    <ol class="xp-whm-detail-steps" data-backup-files-steps aria-label="${t('Restore steps')}">${steps.map(([key, label], index) => `<li data-step="${key}"${index === 0 ? ' aria-current="step"' : ''}><strong>${index + 1}</strong>${label}</li>`).join('')}</ol>
    <p class="xp-whm-detail-status" data-backup-files-status data-state="${input.canRead ? 'unread' : 'unavailable'}" role="status">${input.canRead ? t('Accounts have not been read.') : t('Restoring files requires an authorized root administrator or a reseller with the list-accounts privilege for its own accounts. Nothing was read or changed.')}</p>
    ${card('source', t('Account and backup'), `<div class="xp-whm-detail-fields"><div class="xp-whm-detail-field"><label for="whm-backup-files-account">${t('Account')}</label><select class="xp-select" id="whm-backup-files-account" data-backup-files-account${off}><option value="">${t('Accounts have not been read')}</option></select></div></div>
      <p class="xp-help">${t('Backups are listed from the server backup store. Each archive is fully inspected when you open it: every member must be a regular file or folder inside the account home.')}</p>
      ${table(t('Backups of the selected account'), 'archives', [t('Created (UTC)'), t('Archive'), t('Size'), t('Integrity'), t('Action')], t('No account is selected.'))}`)}
    ${card('files', t('Files in the backup'), `<dl class="xp-whm-detail-fields">${fact('archive', t('Archive'))}${fact('integrity', t('Integrity'))}${fact('sha256', t('Archive SHA-256'))}</dl>
      <div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-backup-files-up${off}>${t(msgctxt('whm-backup-files-workspace', 'Parent folder'))}</button><span class="xp-whm-backup-files__path">${t('Folder')} <bdi dir="ltr" data-backup-files-path>/</bdi></span></div>
      ${table(t('Files and folders in the archive'), 'entries', [t('Select'), t('Name'), t('Type'), t('Size')], t('No backup has been opened.'))}
      <p class="xp-help" data-backup-files-selection role="status">${t('Nothing is selected. Up to 500 files or folders can be selected.')}</p>
      <fieldset data-backup-files-destination${off}><legend>${t('Restore to')}</legend>
        <label class="xp-whm-detail-choice"><input type="radio" name="whm-backup-files-destination" value="new-folder" checked${off}><span>${t('A new folder in the account home:')} <bdi dir="ltr" data-backup-files-folder>restored-…</bdi></span></label>
        <label class="xp-whm-detail-choice"><input type="radio" name="whm-backup-files-destination" value="in-place"${off}><span>${t('The original location, only for files that do not exist now. Mail data and settings are never restored in place.')}</span></label>
      </fieldset>
      <div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-backup-files-clear${off}>${t(msgctxt('whm-backup-files-workspace', 'Clear selection'))}</button><button type="button" class="xp-btn xp-btn--primary" data-backup-files-preview${off}>${t('Review restore')}</button></div>`)}
    ${card('review', t('Review'), `<dl class="xp-whm-detail-fields">${fact('count-restore', t('Files to restore'))}${fact('count-present', t('Already present, will be skipped'))}${fact('count-refused', t('Cannot be restored here'))}${fact('planned', t('Planned size'))}${fact('quota', t('Plan disk quota'))}${fact('writer', t('Account file writer'))}</dl>
      ${table(t('Planned file restore'), 'review', [t('Path in backup'), t('Destination'), t('Size'), t('Planned action')], t('No restore has been reviewed.'))}
      <label class="xp-whm-detail-choice"><input type="checkbox" data-backup-files-ack${off}><span>${t('I reviewed this list. Existing files are never overwritten.')}</span></label>
      <div class="xp-whm-detail-actions"><button type="button" class="xp-btn xp-btn--primary" data-backup-files-restore${off}>${t('Restore files')}</button></div>`)}
    ${card('result', t('Result'), `<dl class="xp-whm-detail-fields">${fact('count-restored', t('Restored'))}${fact('count-skipped', t('Skipped, already present'))}${fact('count-failed', t(msgctxt('whm-backup-files-workspace', 'Failed')))}${fact('count-pending', t('Not attempted yet'))}</dl>
      ${table(t('File restore results'), 'results', [t('Path in backup'), t('Destination'), t('Result'), t('Reason')], t('No restore has run.'))}
      <div class="xp-whm-detail-actions"><button type="button" class="xp-btn" data-backup-files-continue hidden${off}>${t('Continue restore')}</button></div>`)}
  </div>`
  const rule = (message: string): string => `<li>${t(message)}</li>`
  const aside = card('rules', t('What a file restore does'), `<style>.xp-whm-backup-files__rules{display:flex;flex-direction:column;gap:16px;margin:0;padding-inline-start:16px;line-height:1.7}</style><ul class="xp-whm-backup-files__rules">${[
    rule('The archive is inspected again and its reviewed SHA-256 must still match before anything is written.'),
    rule('Files are written as the account by the confined file writer, which refuses links and honours the disk quota.'),
    rule('An existing file is never replaced; it is reported as skipped.'),
    rule('Each restored file is read back and compared with the archive. Files larger than 2 MiB are not restored here; use the account restore.'),
    rule('One request restores at most 500 files within a 20 second budget; continue to restore the rest.'),
  ].join('')}</ul>`)
  return { main, aside }
}
