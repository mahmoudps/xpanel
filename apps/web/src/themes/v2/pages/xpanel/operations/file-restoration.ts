import { backupFilesClientTemplates } from '../../xwhm/recovery-tools/backup-files-client-templates.ts'
import { escapeHtml } from '../../../html.ts'
import { operationButton, operationCard, operationFacts, operationTable, unreadRow, type operationContext } from './common.ts'

type Translate = ReturnType<typeof operationContext>['t']

/** File and Directory Restoration on /files/backup; the shared backup-files controller runs in owner mode. */
export function renderV2FileRestorationSection(t: Translate, input: { username: string; canRead: boolean; canRestore: boolean }): string {
  const unread = t(msgid('Not read'))
  const facts = (rows: readonly (readonly [string, string])[]): string => operationFacts(rows.map(([key, label]) => ({ label, valueHtml: `<span data-backup-files-${key}>${escapeHtml(unread)}</span>` })))
  const choice = (value: string, label: string, checked = false): string => `<label class="v2-panel-operation-check"><input type="radio" name="v2-file-restoration-destination" value="${value}"${checked ? ' checked' : ''} disabled><span>${label}</span></label>`
  const steps = [['backup', t(msgid('Backup'))], ['files', t(msgid('Files'))], ['review', t(msgid('Review'))], ['result', t(msgid('Result'))]] as const
  const source = operationCard('v2-file-restoration', t(msgid('File and Directory Restoration')),
    `<ol class="v2-panel-operation-actions" data-backup-files-steps aria-label="${escapeHtml(t(msgid('Restore steps')))}">${steps.map(([key, label], index) => `<li data-step="${key}"${index === 0 ? ' aria-current="step"' : ''}><strong>${index + 1}</strong> ${escapeHtml(label)}</li>`).join('')}</ol>
<select data-backup-files-account hidden disabled><option value="${escapeHtml(input.username)}">${escapeHtml(input.username)}</option></select>
<p data-backup-files-status data-state="${input.canRead ? 'unread' : 'unavailable'}" role="status">${escapeHtml(input.canRead ? t(msgid('Backups have not been read.')) : t(msgid('File restoration is not available for this account. Nothing was read or changed.')))}</p>
${operationTable('v2-file-restoration-archives', t(msgid('Backups of your account')), [t(msgid('Created (UTC)')), t(msgid('Archive')), t(msgid('Size')), t(msgid('Integrity')), t(msgid('Action'))], { 'data-backup-files-archives': true }, unreadRow(5, t(msgid('Backups have not been read.'))))}`,
    t(msgid('Restore single files or folders of your home folder from the server backups. Mail, panel settings and the trash need a full account restore.')))
  const files = operationCard('v2-file-restoration-files', t(msgid('Files in the backup')),
    `${facts([['archive', t(msgid('Archive'))], ['integrity', t(msgid('Integrity'))], ['sha256', t(msgid('Archive SHA-256'))]])}
<div class="v2-panel-operation-actions">${operationButton(t(msgctxt('whm-backup-files-workspace', 'Parent folder')), { 'data-backup-files-up': true })}<span>${escapeHtml(t(msgid('Folder')))} <bdi dir="ltr" data-backup-files-path>/</bdi></span></div>
${operationTable('v2-file-restoration-entries', t(msgid('Files and folders in the archive')), [t(msgid('Select')), t(msgid('Name')), t(msgid('Type')), t(msgid('Size'))], { 'data-backup-files-entries': true }, unreadRow(4, t(msgid('No backup has been opened.'))))}
<p data-backup-files-selection role="status">${escapeHtml(t(msgid('Nothing is selected. Up to 500 files or folders can be selected.')))}</p>
<fieldset class="v2-panel-operation-options" data-backup-files-destination disabled><legend>${escapeHtml(t(msgid('Restore to')))}</legend>${choice('replace', escapeHtml(t(msgid('The original location, replacing the current file'))), true)}${choice('new-folder', `${escapeHtml(t(msgid('A new folder in your home folder:')))} <bdi dir="ltr" data-backup-files-folder>restored-…</bdi>`)}</fieldset>
<div class="v2-panel-operation-actions">${operationButton(t(msgctxt('whm-backup-files-workspace', 'Clear selection')), { 'data-backup-files-clear': true })}${operationButton(t(msgid('Review restore')), { 'data-backup-files-preview': true }, true, true)}</div>`)
  const review = operationCard('v2-file-restoration-review', t(msgid('Review')),
    `${facts([['count-restore', t(msgid('Files to restore'))], ['count-present', t(msgid('Present now'))], ['count-refused', t(msgid('Cannot be restored here'))], ['planned', t(msgid('Planned size'))], ['quota', t(msgid('Plan disk quota'))], ['writer', t(msgid('Account file writer'))]])}
${operationTable('v2-file-restoration-review-table', t(msgid('Planned file restore')), [t(msgid('Path in backup')), t(msgid('Destination')), t(msgid('Size')), t(msgid('Planned action'))], { 'data-backup-files-review': true }, unreadRow(4, t(msgid('No restore has been reviewed.'))))}
<label class="v2-panel-operation-check"><input type="checkbox" data-backup-files-ack disabled><span>${escapeHtml(t(msgid('I reviewed this list. Restoring to the original location replaces the current files.')))}</span></label>
<div class="v2-panel-operation-actions">${operationButton(t(msgid('Restore files')), { 'data-backup-files-restore': true }, true, true)}</div>`)
  const result = operationCard('v2-file-restoration-result', t(msgid('Result')),
    `${facts([['count-restored', t(msgid('Restored'))], ['count-skipped', t(msgid('Skipped, already present'))], ['count-failed', t(msgctxt('whm-backup-files-workspace', 'Failed'))], ['count-pending', t(msgid('Not attempted yet'))]])}
${operationTable('v2-file-restoration-results', t(msgid('File restore results')), [t(msgid('Path in backup')), t(msgid('Destination')), t(msgid('Result')), t(msgid('Reason'))], { 'data-backup-files-results': true }, unreadRow(4, t(msgid('No restore has run.'))))}
<div class="v2-panel-operation-actions"><button type="button" class="v2-btn" data-backup-files-continue hidden disabled>${escapeHtml(t(msgid('Continue restore')))}</button></div>`)
  return `<div class="v2-panel-operation-stack" data-whm-backup-files-workspace data-backup-files-owner="true" data-backup-files-username="${escapeHtml(input.username)}" data-backup-files-can-read="${input.canRead}" data-backup-files-can-restore="${input.canRead && input.canRestore}">${source}${files}${review}${result}${backupFilesClientTemplates()}</div>`
}
