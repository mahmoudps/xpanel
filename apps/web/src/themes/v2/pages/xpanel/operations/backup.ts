import type { PanelSurfaceProps } from '../../../../contract.ts'
import { kpiCard, stepper } from '../../../components/index.ts'
import { escapeHtml, xpTemplate } from '../../../html.ts'
import { deniedOperationAuthority, operationButton, operationCard, operationContext, operationFacts, operationField, operationPage, operationTable, technical, unreadRow, type PanelOperationAuthority } from './common.ts'

/** The archive table owns all six approved columns; core fills its semantic row template. */
function archiveTemplates(t: ReturnType<typeof operationContext>['t']): string {
  return xpTemplate('account-backup-archive-row', `<tr><td><div class="v2-panel-operation-stack"><bdi dir="ltr" class="v2-mono" data-xp-slot="file"></bdi><time dir="ltr" data-xp-slot="created"></time></div></td><td><span data-xp-slot="contents">${escapeHtml(t(msgid('Home files')))}</span></td><td><bdi dir="ltr" data-xp-slot="bytes"></bdi></td><td><span data-xp-slot="location">${escapeHtml(t(msgctxt('theme:v2', 'Account archive storage')))}</span></td><td><span data-xp-slot="integrity">${escapeHtml(t(msgid('Stored; not yet inspected')))}</span></td><td>${operationButton(t(msgid('Review restore differences')), { 'data-xp-action': 'review' })}</td></tr>`)
    + xpTemplate('account-backup-difference-row', '<tr><td><bdi dir="ltr" data-xp-slot="path"></bdi></td><td><span data-xp-slot="result"></span></td><td><bdi dir="ltr" data-xp-slot="archive-bytes"></bdi></td><td><bdi dir="ltr" data-xp-slot="current-bytes"></bdi></td></tr>')
    + xpTemplate('account-backup-empty-row', '<tr><td data-xp-slot="message"></td></tr>')
}

/** Actual account-home archive actions; database/mail providers remain separate. */
export function renderV2AccountBackupPage(props: PanelSurfaceProps, authority: PanelOperationAuthority = deniedOperationAuthority): string {
  const { t, canManage, account } = operationContext(props, authority, '/files/backup')
  props = { ...props, account }
  const unknown = t(msgid('Not read'))
  const summary = `<div class="v2-kpi-row">${[
    { label: t(msgctxt('theme:v2', 'Archive workflow')), value: t(msgid('Home files')), note: t(msgid('Mailbox data and mail settings — preserved separately')) },
    { label: t(msgctxt('theme:v2', 'Maximum home archive')), value: '2 GiB', note: t(msgctxt('theme:v2', 'The account archive provider enforces this limit.')) },
    { label: t(msgctxt('theme:v2', 'Restore approval')), value: t(msgid('Review changes')), note: t(msgid('Confirm restore')) },
    { label: t(msgctxt('theme:v2', 'Recovery copy')), value: unknown, note: t(msgctxt('theme:v2', 'Read the restore result before treating a recovery copy as retained.')) },
  ].map(item => kpiCard(item)).join('')}</div>`
  const archiveList = operationCard('v2-backup-archives', t(msgid('Archives')),
    `${operationField('v2-account-backup-selected', t(msgid('Selected archive')), '<select id="v2-account-backup-selected" dir="ltr" data-account-backup-select disabled></select>')}
${operationTable('v2-account-backup-table', t(msgid('Account archives')), [t(msgid('Archive')), t(msgid('Contents')), t(msgid('Size (bytes)')), t(msgid('Location')), t(msgctxt('theme:v2', 'Checksum')), t(msgid('Actions'))], { 'data-account-backup-archives': true, 'data-xp-columns': 6 }, unreadRow(6, t(msgid('Archives have not been read.'))))}
<div class="v2-panel-operation-actions"><a class="v2-btn" data-account-backup-download aria-disabled="true">${escapeHtml(t(msgid('Download selected archive')))}</a>${operationButton(t(msgid('Review restore differences')), { 'data-account-backup-preview': true })}${operationButton(t(msgid('Read archives')), { 'data-account-backup-refresh': true })}</div>${archiveTemplates(t)}`,
    t(msgctxt('theme:v2', 'A host archive is not an off-server disaster recovery copy.')))
  const create = operationCard('v2-backup-create', t(msgid('Back up account files')),
    `${stepper({ label: t(msgid('Steps')), inline: true, steps: [{ label: t(msgid('Select parts')), state: 'current' }, { label: t(msgid('Create archive')), state: 'upcoming' }, { label: t(msgid('Download')), state: 'upcoming' }] })}
<fieldset class="v2-panel-operation-options"><legend>${escapeHtml(t(msgid('Archive contents')))}</legend><label><input type="checkbox" checked disabled><span>${escapeHtml(t(msgid('Home files')))}</span></label><label><input type="checkbox" disabled><span>${escapeHtml(t(msgid('Databases — separate database archive service required')))}</span></label><label><input type="checkbox" disabled><span>${escapeHtml(t(msgid('Mailbox data and mail settings — preserved separately')))}</span></label></fieldset>
<p>${escapeHtml(t(msgid('Create a real archive of home files, up to 2 GiB. Mailbox data and account mail settings are excluded from this home-file workflow. A host archive is not an off-server disaster recovery copy.')))}</p>
<div class="v2-panel-operation-actions">${operationButton(t(msgid('Create home archive')), { 'data-account-backup-create': true }, true, true)}</div>`)
  const differences = operationCard('v2-backup-differences', t(msgid('Review the difference')),
    `${stepper({ label: t(msgid('Steps')), inline: true, steps: [{ label: t(msgid('Select archive')), state: 'current' }, { label: t(msgid('Review changes')), state: 'upcoming' }, { label: t(msgid('Confirm restore')), state: 'upcoming' }] })}
${operationFacts([['add', t(msgid('Added'))], ['replace', t(msgid('Changed'))], ['unchanged', t(msgid('Unchanged'))], ['keep', t(msgid('Missing from archive (kept)'))], ['preserve-mail', t(msgctxt('theme:v2', 'Mailbox files kept'))]].map(([key, label]) => ({ label: label!, valueHtml: `<span data-account-backup-count="${key}">${escapeHtml(unknown)}</span>` })))}
${operationTable('v2-account-backup-diff', t(msgid('Restore differences')), [t(msgid('Path')), t(msgid('Result')), t(msgid('In archive (bytes)')), t(msgid('Current (bytes)'))], { 'data-account-backup-differences': true, 'data-xp-columns': 4 }, unreadRow(4, t(msgid('No archive has been compared.'))))}
<p data-account-backup-diff-limit hidden></p><a class="v2-btn" data-account-backup-csv aria-disabled="true">${escapeHtml(t(msgid('Download full difference list (CSV)')))}</a>`)
  const restore = operationCard('v2-backup-review', t(msgid('Before a restore')),
    `<p>${escapeHtml(t(msgid('Only reviewed home-file changes are applied. Files absent from the archive and mailbox data/settings are kept. A separate recovery archive is created before replacement. Home restore does not restore the control database or databases.')))}</p>
<div class="v2-field"><label for="v2-account-backup-confirmation">${escapeHtml(t(msgid('Type the account username to confirm')))}: ${technical(account?.username ?? t(msgid('Not read')))}</label><input id="v2-account-backup-confirmation" type="text" dir="ltr" autocomplete="off" spellcheck="false" data-account-backup-confirmation disabled></div>
<label class="v2-panel-operation-check"><input type="checkbox" data-account-backup-ack disabled><span>${escapeHtml(t(msgid('I reviewed the actual archive and the proposed changes.')))}</span></label>
<div class="v2-panel-operation-actions">${operationButton(t(msgid('Restore reviewed home files')), { 'data-account-backup-restore': true }, true, true)}</div>`)
  const aside = operationCard('v2-backup-scope', t(msgctxt('theme:v2', 'Backup scope and safeguards')),
    `${operationFacts([{ label: t(msgid('Account')), valueHtml: technical(account?.username ?? t(msgid('Not read'))) }, { label: t(msgid('Home')), valueHtml: technical(account?.home ?? t(msgid('Not read'))) }])}<p>${escapeHtml(t(msgctxt('theme:v2', 'Database, mailbox and server restore points require their own qualified providers. They are not included in the home-file archive.')))}</p><div class="v2-panel-operation-actions">${operationButton(t(msgctxt('theme:v2', 'Server restore points')))}${operationButton(t(msgctxt('theme:v2', 'Upload archive')))}</div>`)
  return operationPage(props, '/files/backup', t(msgid('Backup wizard')), t(msgctxt('theme:v2', 'Create account archives, compare real home-file differences and restore only the reviewed changes.')),
    `<div data-account-backup data-account-backup-account="${escapeHtml(account?.id ?? '')}" data-account-backup-username="${escapeHtml(account?.username ?? '')}" data-account-backup-manage="${canManage}">${summary}<div class="v2-panel-operation-columns"><div class="v2-panel-operation-stack">${archiveList}${create}${differences}${restore}</div><aside class="v2-panel-operation-stack" aria-label="${escapeHtml(t(msgctxt('theme:v2', 'Backup information')))}">${aside}</aside></div><p role="status" data-account-backup-status data-state="unread">${escapeHtml(t(msgid('Account archives have not been read.')))}</p></div>`, undefined, authority)
}
