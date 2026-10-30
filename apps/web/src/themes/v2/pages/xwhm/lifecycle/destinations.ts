import { localeDirection } from '../../../../../i18n.ts'
import { v2Messages } from '../../../messages.ts'
import { lifecycleButton, lifecycleCard, lifecycleFacts, lifecycleField, lifecycleHeader, lifecycleStatus, lifecycleTable, text, type LifecycleAccess } from './shared.ts'
import { v2BackupDestinationTemplates } from './destination-client-templates.ts'

export type V2BackupDestinationsPageProps = LifecycleAccess

/** Destination tests, activation, copies and retention remain controlled by their core lifecycle controllers. */
export function renderV2BackupDestinationsPage(props: V2BackupDestinationsPageProps): string {
  const t = v2Messages.translator(props.locale)
  const manage = props.canRead && props.canManage
  const button = (key: string, label: string, primary = false): string => lifecycleButton(t, label, { [`data-destination-${key}`]: true }, primary)
  const input = (key: string, label: string, type = 'text'): string => lifecycleField(t, `v2-backup-destination-${key}`, label,
    `<input id="v2-backup-destination-${key}" data-destination-field="${key}" type="${type}" dir="${key === 'name' ? 'auto' : 'ltr'}" autocomplete="off"${key === 'retentionDays' ? ' min="1" max="3650" step="1"' : ''} disabled>`)
  const actions = (body: string): string => `<div class="v2-lifecycle__actions">${body}</div>`
  const list = lifecycleCard(t, 'destination-list', msgid('Saved destinations'), `
<p>${text(t, msgid('New and changed destinations stay inactive. A trusted remote provider must write, read and delete a small test object before activation. Scheduled backup execution is not verified here.'))}</p>
${lifecycleTable(t, msgid('Saved backup destinations'), [msgid('Name'), msgid('Kind'), msgid('Endpoint and prefix'), msgid('Verification'), msgid('Actions')], { 'data-destination-rows': true }, msgid('Not read'))}
`)
  const container = manage ? 'form' : 'div'
  const editor = lifecycleCard(t, 'destination-editor', msgid('Destination configuration'), `
<p>${text(t, msgid('Credentials are selected by a trusted server reference. Passwords, private keys and credential file paths are never accepted in this editor. A local directory must be on a separate disk and uses the built-in local-disk reference; unsupported transports can be saved for review but cannot be activated.'))}</p>
<${container} data-destination-form class="v2-lifecycle__group"><div class="v2-lifecycle__fields">
${input('name', msgid('Name'))}
${lifecycleField(t, 'v2-backup-destination-kind', msgid('Kind'), `<select id="v2-backup-destination-kind" data-destination-field="kind" disabled>${[
    ['sftp', msgctxt('theme:v2', 'SFTP')], ['s3', msgctxt('theme:v2', 'S3')], ['backblaze', msgctxt('theme:v2', 'Backblaze')], ['rsync', msgctxt('theme:v2', 'Rsync')], ['ftp', msgctxt('theme:v2', 'FTP')], ['local', msgid('Local directory')],
  ].map(([value, label]) => `<option value="${value}">${text(t, label!)}</option>`).join('')}</select>`)}
${input('endpoint', msgid('Service URL or local directory'))}${input('pathPrefix', msgid('Directory or object prefix'))}${input('bucket', msgid('Bucket'))}${input('region', msgid('Region'))}${input('username', msgid('Remote username'))}${input('retentionDays', msgid('Retention days'), 'number')}
${lifecycleField(t, 'v2-backup-destination-credential', msgid('Credential reference'), `<select id="v2-backup-destination-credential" data-destination-field="credentialRef" disabled><option value="">${text(t, msgid('No trusted credential available'))}</option></select>`)}
</div>
${actions(button('create-key', msgid('Create SFTP key pair')))}
<p class="v2-muted" data-destination-key-help hidden>${text(t, msgid('Add this public key to ~/.ssh/authorized_keys of the remote user. The private key stays on this server and is never shown.'))}</p>
<pre class="v2-lifecycle__key" dir="ltr" data-destination-public-key hidden></pre>
<div class="v2-lifecycle__actions"><button type="submit" class="v2-btn v2-btn--primary" data-destination-save disabled>${text(t, msgid('Save inactive destination'))}</button></div>
</${container}>
`)
  const runsTable = (key: string, title: string, labels: readonly string[], empty: string): string => `${lifecycleTable(t, title, labels, { 'data-backup-runs-rows': key }, msgid('Not read'))}<p class="v2-muted" data-backup-runs-empty="${key}" hidden>${text(t, empty)}</p>`
  const runsButton = (key: string, label: string, primary = false): string => lifecycleButton(t, label, { [`data-backup-${key}`]: true }, primary)
  const history = lifecycleCard(t, 'destination-runs', msgid('Scheduled runs'), `
<p>${text(t, msgctxt('theme:v2', 'A run counts copies only after their bytes and SHA-256 have been verified. Read the returned parts and failure details before treating a run as complete.'))}</p>
${lifecycleStatus(t, msgid('Backup runs have not been read.'), { 'data-backup-runs-status': true, 'data-state': 'unread' })}
<div class="v2-lifecycle__group" data-backup-runs-loading aria-busy="true" aria-label="${text(t, msgid('Loading backup runs'))}" hidden><p>${text(t, msgid('Loading backup runs'))}</p></div>
${lifecycleFacts(t, [
    { key: 'schedule', label: msgid('Schedule') }, { key: 'next', label: msgid('Next scheduled start (UTC)') }, { key: 'last', label: msgid('Last scheduled start (UTC)') },
  ], 'data-backup-runs-fact')}
${actions(runsButton('runs-read', msgid('Read again')) + runsButton('runs-start', msgid('Run backup now'), true))}
${runsTable('runs', msgid('Backup run history'), [msgid('Started (UTC)'), msgid('Trigger'), msgid('State'), msgid('Verified copies'), msgid('Mail'), msgid('Retention')], msgid('No backup run has been recorded.'))}
`)
  const recovery = lifecycleCard(t, 'destination-copies', msgid('Verified remote copies'), `
<p>${text(t, msgid('Recovery downloads one verified copy into the local archive folder of its account and checks its SHA-256 before it appears there. It never replaces an existing local archive. Restore it afterwards from Restore accounts.'))}</p>
${runsTable('copies', msgid('Verified remote copies'), [msgid('Account'), msgid('Destination'), msgid('Archive'), msgid('Size'), msgid('Run started (UTC)'), msgid('Actions')], msgid('No verified remote copy is recorded.'))}
${runsTable('recoveries', msgid('Recoveries'), [msgid('Started (UTC)'), msgid('Account'), msgid('Archive'), msgid('State')], msgid('No recovery has been requested.'))}
`)
  const retention = lifecycleCard(t, 'destination-retention', msgid('Remote retention'), `
<p>${text(t, msgid('Per account, the newest archive, the newest verified copy and the newest archives up to the schedule retention count are always kept. Only older archives past the destination retention days are deleted. Scheduled runs apply this after every copy is verified.'))}</p>
${lifecycleField(t, 'v2-backup-retention-destination', msgid('Destination'), `<select id="v2-backup-retention-destination" data-backup-retention-destination disabled><option value="">${text(t, msgid('Not read'))}</option></select>`)}
${actions(runsButton('retention-preview', msgid('Review retention')) + runsButton('retention-apply', msgid('Delete expired archives')))}
${lifecycleStatus(t, '', { 'data-backup-retention-status': true }, true)}
${runsTable('retention', msgid('Retention plan'), [msgid('Archive'), msgid('Account'), msgid('Created (UTC)'), msgid('Size'), msgctxt('acct-backup-runs-workspace', 'Plan')], msgid('No xPanel archive was found at this destination.'))}
`)
  return `<div class="v2-lifecycle" data-whm-detail-route="/whm/backups/destinations" lang="${props.locale}" dir="${localeDirection(props.locale)}">
${lifecycleHeader(t, msgid('Backup destinations'), '/whm/backups/destinations', msgctxt('theme:v2', 'Save inactive destinations, verify their transport and review actual remote copies before recovery or retention.'))}
<section class="v2-lifecycle__column" data-whm-backup-destinations data-can-manage="${manage}" aria-label="${text(t, msgid('Backup destinations'))}">
${actions(button('read', msgid('Read again')) + button('new', msgid('New destination')))}
${lifecycleStatus(t, msgid('Backup destinations have not been read.'), { 'data-destination-status': true })}
<div class="v2-lifecycle__grid"><div class="v2-lifecycle__column">${list}</div><aside class="v2-lifecycle__column" aria-label="${text(t, msgid('Destination configuration'))}">${editor}</aside></div>
<section class="v2-lifecycle__column" data-whm-backup-runs data-can-manage="${manage}" aria-label="${text(t, msgid('Backup run history'))}">${history}${recovery}${retention}</section>
${v2BackupDestinationTemplates()}
</section></div>`
}
