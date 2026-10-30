import { backupFilesClientTemplates } from './backup-files-client-templates.ts'
import type { WhmSurfaceProps } from '../../../../contract.ts'
import { actions, button, context, esc, facts, field, page, status, table, toolCard, type WhmAccountToolAuthority } from '../account-tools/common.ts'
import { recoverySteps, restoreMoreTemplates } from './common.ts'

/** Backups, reviewed digests and run results remain unread until the authorized core controller reads them. */
export function renderV2WhmRestoreComponentsPage(props: WhmSurfaceProps, authority: WhmAccountToolAuthority): string {
  const { t, readable, editable } = context(props, authority)
  const title = t(msgid('More restore tools'))
  const unread = t(msgid('Not read'))
  const fact = (rows: readonly (readonly [string, string])[]) => facts(rows.map(([key, label]) => ({ label: t(label), hooks: { [`data-restore-more-${key}`]: true } })), unread)
  const rows = (caption: string, headers: readonly string[], marker: string, empty: string): string => table(t(caption), headers.map(label => t(label)), { [`data-restore-more-${marker}`]: true }, t(empty))
  const steps = recoverySteps(t, 'restore-more', [['account', msgid('Account')], ['backup', msgid('Backup')], ['components', msgid('Components')], ['review', msgid('Review')], ['result', msgid('Result')]])
  const source = toolCard('restore-more-source', t(msgid('Account and backup')), field('v2-restore-more-account', t(msgid('Account')), `<select id="v2-restore-more-account" data-restore-more-account disabled><option value="">${esc(t(msgid('Accounts have not been read')))}</option></select>`)
    + `<p>${esc(t(msgid('Backups are listed from the server backup store. Opening one inspects every member and lists what it contains for each component.')))}</p>`
    + rows(msgid('Backups of the selected account'), [msgid('Created (UTC)'), msgid('Archive'), msgid('Size'), msgid('Integrity'), msgid('Action')], 'archives', msgid('No account is selected.')))
  const components = toolCard('restore-more-components', t(msgid('Components in the backup')), fact([['archive', msgid('Archive')], ['sha256', msgid('Archive SHA-256')]])
    + rows(msgid('Backup components'), [msgid('Component'), msgid('In this backup'), msgid('Restore here')], 'components', msgid('No backup has been opened.'))
    + `<h3>${esc(t(msgid('Mailboxes in the backup')))}</h3>`
    + rows(msgid('Mailboxes in the backup'), [msgid('Select'), msgid('Mailbox'), msgid('Messages'), msgid('Size'), msgid('Mailbox now')], 'mailboxes', msgid('No backup has been opened.'))
    + status(t(msgid('No mailbox is selected. Up to 50 mailboxes can be selected.')), { 'data-restore-more-selection': true })
    + actions(button(t(msgid('Review mail restore')), { 'data-restore-more-preview': true }, false, true)))
  const review = toolCard('restore-more-review', t(msgid('Review')), fact([
    ['count-messages', msgid('Messages in the backup')], ['count-present', msgid('Already present, will be skipped')], ['count-batch', msgid('Messages in this run')], ['count-remaining', msgid('Left for a later run')], ['count-refused', msgid('Cannot be restored here')], ['planned', msgid('Planned size')], ['quota', msgid('Plan disk quota')], ['writer', msgid('Account file writer')],
  ]) + rows(msgid('Planned mail restore'), [msgid('Message file'), msgid('Size')], 'review', msgid('No restore has been reviewed.'))
    + `<label class="v2-account-tool__choice"><input type="checkbox" data-restore-more-ack disabled><span>${esc(t(msgid('I reviewed this list. Existing messages are never overwritten.')))}</span></label>`
    + actions(button(t(msgid('Restore mail')), { 'data-restore-more-restore': true }, false, true)))
  const result = toolCard('restore-more-result', t(msgid('Result')), fact([['count-restored', msgid('Restored')], ['count-skipped', msgid('Skipped, already present')], ['count-failed', msgid('Failed')], ['count-pending', msgid('Not attempted yet')]])
    + rows(msgid('Mail restore results'), [msgid('Message file'), msgid('Result'), msgid('Reason')], 'results', msgid('No restore has run.'))
    + `<div class="v2-account-tool__actions"><button type="button" class="v2-btn" data-restore-more-continue hidden disabled>${esc(t(msgid('Review the next messages')))}</button></div>`)
  const rules = [msgid('The selected account and parts must be checked before applying a restore.'), msgid('Mail restores only message files into mailboxes that exist now. A message that is already present is never replaced.'), msgid('Each restored message is written as the account by the confined file writer, read back and compared with the archive.'), msgid('One run restores at most 500 messages within a 20 second budget; review again to restore the next messages.'), msgid('Account mail settings are rendered from saved configuration and are not restored from a backup.')]
  const aside = toolCard('restore-more-rules', t(msgid('What these restores do')), `<ul class="v2-recovery__rules">${rules.map(rule => `<li>${esc(t(rule))}</li>`).join('')}</ul>`)
  const initial = readable ? msgid('Accounts have not been read.') : msgid('Restoring backup components requires an authorized root administrator or a reseller with the list-accounts privilege for its own accounts. Nothing was read or changed.')
  return page(props, '/whm/backups/restore-more', title, t(msgid('Restore mail from an account server backup into mailboxes that exist now, and see what each backup can and cannot restore.')),
    `<div class="v2-recovery-tools v2-recovery__column" data-whm-restore-more-workspace data-restore-more-can-read="${readable}" data-restore-more-can-restore="${editable}">${restoreMoreTemplates()}${steps}${status(t(initial), { 'data-restore-more-status': true }, readable ? 'unread' : 'unavailable')}<div class="v2-recovery__grid"><div class="v2-recovery__column">${source}${components}${review}${result}</div><aside class="v2-recovery__column">${aside}</aside></div></div>`)
}

export function renderV2WhmRestoreFilesPage(props: WhmSurfaceProps, authority: WhmAccountToolAuthority): string {
  const { t, readable, editable } = context(props, authority)
  const title = t(msgid('Restore files'))
  const unread = t(msgid('Not read'))
  const fact = (rows: readonly (readonly [string, string])[]) => facts(rows.map(([key, label]) => ({ label: t(label), hooks: { [`data-backup-files-${key}`]: true } })), unread)
  const rows = (caption: string, headers: readonly string[], marker: string, empty: string): string => table(t(caption), headers.map(label => t(label)), { [`data-backup-files-${marker}`]: true }, t(empty))
  const steps = recoverySteps(t, 'backup-files', [['account', msgid('Account')], ['backup', msgid('Backup')], ['files', msgid('Files')], ['review', msgid('Review')], ['result', msgid('Result')]])
  const source = toolCard('backup-files-source', t(msgid('Account and backup')), field('v2-backup-files-account', t(msgid('Account')), `<select id="v2-backup-files-account" data-backup-files-account disabled><option value="">${esc(t(msgid('Accounts have not been read')))}</option></select>`)
    + `<p>${esc(t(msgid('Backups are listed from the server backup store. Each archive is fully inspected when you open it: every member must be a regular file or folder inside the account home.')))}</p>`
    + rows(msgid('Backups of the selected account'), [msgid('Created (UTC)'), msgid('Archive'), msgid('Size'), msgid('Integrity'), msgid('Action')], 'archives', msgid('No account is selected.')))
  const files = toolCard('backup-files-files', t(msgid('Files in the backup')), fact([['archive', msgid('Archive')], ['integrity', msgid('Integrity')], ['sha256', msgid('Archive SHA-256')]])
    + actions(button(t(msgctxt('whm-backup-files-workspace', 'Parent folder')), { 'data-backup-files-up': true }) + `<span>${esc(t(msgid('Folder')))} <bdi dir="ltr" data-backup-files-path>/</bdi></span>`)
    + rows(msgid('Files and folders in the archive'), [msgid('Select'), msgid('Name'), msgid('Type'), msgid('Size')], 'entries', msgid('No backup has been opened.'))
    + status(t(msgid('Nothing is selected. Up to 500 files or folders can be selected.')), { 'data-backup-files-selection': true })
    + `<fieldset data-backup-files-destination disabled><legend>${esc(t(msgid('Restore to')))}</legend><label class="v2-account-tool__choice"><input type="radio" name="whm-backup-files-destination" value="new-folder" checked disabled><span>${esc(t(msgid('A new folder in the account home:')))} <bdi dir="ltr" data-backup-files-folder>restored-…</bdi></span></label><label class="v2-account-tool__choice"><input type="radio" name="whm-backup-files-destination" value="in-place" disabled><span>${esc(t(msgid('The original location, only for files that do not exist now. Mail data and settings are never restored in place.')))}</span></label></fieldset>`
    + actions(button(t(msgctxt('whm-backup-files-workspace', 'Clear selection')), { 'data-backup-files-clear': true }) + button(t(msgid('Review restore')), { 'data-backup-files-preview': true }, false, true)))
  const review = toolCard('backup-files-review', t(msgid('Review')), fact([['count-restore', msgid('Files to restore')], ['count-present', msgid('Already present, will be skipped')], ['count-refused', msgid('Cannot be restored here')], ['planned', msgid('Planned size')], ['quota', msgid('Plan disk quota')], ['writer', msgid('Account file writer')]])
    + rows(msgid('Planned file restore'), [msgid('Path in backup'), msgid('Destination'), msgid('Size'), msgid('Planned action')], 'review', msgid('No restore has been reviewed.'))
    + `<label class="v2-account-tool__choice"><input type="checkbox" data-backup-files-ack disabled><span>${esc(t(msgid('I reviewed this list. Existing files are never overwritten.')))}</span></label>`
    + actions(button(t(msgid('Restore files')), { 'data-backup-files-restore': true }, false, true)))
  const result = toolCard('backup-files-result', t(msgid('Result')), fact([['count-restored', msgid('Restored')], ['count-skipped', msgid('Skipped, already present')], ['count-failed', msgctxt('whm-backup-files-workspace', 'Failed')], ['count-pending', msgid('Not attempted yet')]])
    + rows(msgid('File restore results'), [msgid('Path in backup'), msgid('Destination'), msgid('Result'), msgid('Reason')], 'results', msgid('No restore has run.'))
    + `<div class="v2-account-tool__actions"><button type="button" class="v2-btn" data-backup-files-continue hidden disabled>${esc(t(msgid('Continue restore')))}</button></div>`)
  const rules = [msgid('The archive is inspected again and its reviewed SHA-256 must still match before anything is written.'), msgid('Files are written as the account by the confined file writer, which refuses links and honours the disk quota.'), msgid('An existing file is never replaced; it is reported as skipped.'), msgid('Each restored file is read back and compared with the archive. Files larger than 2 MiB are not restored here; use the account restore.'), msgid('One request restores at most 500 files within a 20 second budget; continue to restore the rest.')]
  const aside = toolCard('backup-files-rules', t(msgid('What a file restore does')), `<ul class="v2-recovery__rules">${rules.map(rule => `<li>${esc(t(rule))}</li>`).join('')}</ul>`)
  const initial = readable ? msgid('Accounts have not been read.') : msgid('Restoring files requires an authorized root administrator or a reseller with the list-accounts privilege for its own accounts. Nothing was read or changed.')
  return page(props, '/whm/backups/files', title, t(msgctxt('theme:v2', 'Inspect an account archive, select files, and review the exact destination before restoring anything.')),
    `<div class="v2-recovery-tools v2-recovery__column" data-whm-backup-files-workspace data-backup-files-can-read="${readable}" data-backup-files-can-restore="${editable}">${steps}${status(t(initial), { 'data-backup-files-status': true }, readable ? 'unread' : 'unavailable')}<div class="v2-recovery__grid"><div class="v2-recovery__column">${source}${files}${review}${result}</div><aside class="v2-recovery__column">${aside}</aside></div>${backupFilesClientTemplates()}</div>`)
}
