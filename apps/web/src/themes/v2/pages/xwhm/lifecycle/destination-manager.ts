import { v2Messages } from '../../../messages.ts'
import { lifecycleButton, lifecycleCard, lifecycleField, lifecycleStatus, lifecycleTable, text, type LifecycleAccess } from './shared.ts'
import { v2BackupDestinationTemplates } from './destination-client-templates.ts'

/** One destination editor and mutation owner, composed inline or on the dedicated page. */
export function renderV2BackupDestinationManager(props: LifecycleAccess, options: { stacked?: boolean; inline?: boolean; after?: string } = {}): string {
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
<div class="v2-lifecycle__fields" data-destination-sftp-address style="display:flex;flex-wrap:wrap;gap:16px;grid-column:1/-1">
<div style="flex:3 1 180px;min-inline-size:0">${lifecycleField(t, 'v2-backup-destination-host', msgid('Host'), '<input id="v2-backup-destination-host" data-destination-sftp-host type="text" dir="ltr" inputmode="url" autocomplete="off" maxlength="1024" required disabled>')}</div>
<div style="flex:1 1 72px;min-inline-size:0">${lifecycleField(t, 'v2-backup-destination-port', msgid('Port'), '<input id="v2-backup-destination-port" data-destination-sftp-port type="number" dir="ltr" inputmode="numeric" autocomplete="off" min="1" max="65535" step="1" placeholder="22" required disabled>')}</div>
</div>
${input('endpoint', msgid('Service URL or local directory'))}${input('pathPrefix', msgid('Directory or object prefix'))}${input('bucket', msgid('Bucket'))}${input('region', msgid('Region'))}${input('username', msgid('Remote username'))}${input('retentionDays', msgid('Retention days'), 'number')}
${lifecycleField(t, 'v2-backup-destination-credential', msgid('Credential reference'), `<select id="v2-backup-destination-credential" data-destination-field="credentialRef" disabled><option value="">${text(t, msgid('No trusted credential available'))}</option></select>`)}
</div>
${actions(button('create-key', msgid('Create SFTP key pair')))}
<p class="v2-muted" data-destination-key-help hidden>${text(t, msgid('Add this public key to ~/.ssh/authorized_keys of the remote user. The private key stays on this server and is never shown.'))}</p>
<pre class="v2-lifecycle__key" dir="ltr" data-destination-public-key hidden></pre>
<div class="v2-lifecycle__actions"><button type="submit" class="v2-btn v2-btn--primary" data-destination-save disabled>${text(t, msgid('Save inactive destination'))}</button></div>
</${container}>
`)
  return `<section class="v2-lifecycle__column" data-whm-backup-destinations data-destination-sftp-projection data-backup-destinations-can-read="${manage}" data-can-manage="${manage}"${options.inline ? ' data-backup-inline-manager' : ''} aria-label="${text(t, msgid('Backup destinations'))}">
${actions(button('read', msgid('Read again')) + button('new', msgid('New destination')))}
${lifecycleStatus(t, msgid('Backup destinations have not been read.'), { 'data-destination-status': true })}
<div class="${options.stacked ? 'v2-lifecycle__column' : 'v2-lifecycle__grid'}"><div class="v2-lifecycle__column">${list}</div><aside class="v2-lifecycle__column" aria-label="${text(t, msgid('Destination configuration'))}">${editor}</aside></div>
${options.after ?? ''}
${v2BackupDestinationTemplates()}
</section>`
}
