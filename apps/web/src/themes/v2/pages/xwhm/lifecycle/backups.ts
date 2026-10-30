import { v2WhmBackupClientTemplates } from './backup-client-templates.ts'
import { localeDirection } from '../../../../../i18n.ts'
import { v2Messages } from '../../../messages.ts'
import { escapeHtml } from '../../../html.ts'
import { lifecycleButton, lifecycleCard, lifecycleField, lifecycleHeader, lifecycleStatus, lifecycleTable, text, type LifecycleAccess } from './shared.ts'

export interface V2BackupsPageProps extends LifecycleAccess {
  readonly activeRoute?: '/whm/backups' | '/whm/backups/restore'
  /** Core supplies only accounts this caller may access. */
  readonly accounts?: readonly { readonly username: string; readonly primaryDomain: string }[]
}

/** Backup configuration and recovery keep separate observation hooks and retain unread states until a real read. */
export function renderV2BackupsPage(props: V2BackupsPageProps): string {
  const t = v2Messages.translator(props.locale)
  const route = props.activeRoute ?? '/whm/backups'
  const authorizedAccounts = props.canRead ? props.accounts : undefined
  const input = (key: string, label: string, type = 'text', limits = '', enabled = false): string => lifecycleField(t, `backup-layout-${key}`, label,
    `<input id="backup-layout-${key}" type="${type}" dir="ltr"${limits}${enabled ? '' : ' disabled'}>`)
  const select = (key: string, label: string, choices: readonly string[]): string => lifecycleField(t, `backup-layout-${key}`, label,
    `<select id="backup-layout-${key}" disabled><option value="">${text(t, msgid('Not read'))}</option>${choices.map((choice, index) => `<option value="${index + 1}">${text(t, choice)}</option>`).join('')}</select>`)
  const choice = (key: string, label: string, help?: string): string => `<label class="v2-lifecycle__choice" for="backup-layout-${key}"><input id="backup-layout-${key}" type="checkbox" disabled><span><strong>${text(t, label)}</strong>${help ? `<span class="v2-muted">${text(t, help)}</span>` : ''}</span></label>`
  const actions = (body: string): string => `<div class="v2-lifecycle__actions">${body}</div>`
  const fields = (body: string): string => `<div class="v2-lifecycle__fields">${body}</div>`
  const button = (key: string, label: string, primary = false): string => lifecycleButton(t, label, { 'data-backup-action': key }, primary)
  const status = (hook: string, label: string): string => lifecycleStatus(t, label, { [`data-backup-${hook}`]: true })
  const table = (title: string, columns: readonly string[], hook: string, label: string): string => lifecycleTable(t, title, columns, { [`data-backup-${hook}`]: true }, label)
  const group = (label: string, body: string): string => `<fieldset disabled><legend>${text(t, label)}</legend><div class="v2-lifecycle__group">${body}</div></fieldset>`
  const summary = `<dl class="v2-lifecycle__summary">${[['last', msgid('Last run')], ['next', msgid('Next run')], ['local', msgid('Local storage')], ['remote', msgid('Remote SFTP')]].map(([key, label]) => `<div class="v2-lifecycle__field"><dt>${text(t, label!)}</dt><dd data-backup-summary="${key}">${text(t, msgid('Not read'))}</dd></div>`).join('')}</dl>`
  const accountChoices = authorizedAccounts === undefined
    ? `<p role="status">${text(t, msgid('The account list has not been read.'))}</p>`
    : authorizedAccounts.length ? '' : `<p role="status">${text(t, msgid('No accounts were returned by the authorized read.'))}</p>`
  const accounts = `${actions(button('all-accounts', msgid('All accounts')) + button('selected-accounts', msgid('Selected accounts')))}${accountChoices}<div class="v2-lifecycle__choices" data-backup-account-choices>${(authorizedAccounts ?? []).map((account, index) => `<label class="v2-lifecycle__choice" for="v2-backup-account-${index}"><input id="v2-backup-account-${index}" type="checkbox" disabled><span><strong><bdi dir="ltr">${escapeHtml(account.username)}</bdi></strong><span><bdi dir="ltr">${escapeHtml(account.primaryDomain)}</bdi></span></span></label>`).join('')}</div>`

  const schedule = lifecycleCard(t, 'backup-schedule', msgctxt('theme:v2', 'Schedule and retention'), `
<p>${text(t, msgctxt('theme:v2', 'Saved schedule and retention have not been read. No scheduling or native archive verification is assumed.'))}</p>
${group(msgid('Schedule'), fields(choice('policy-enabled', msgid('Request scheduled backups'))
    + select('frequency', msgid('Frequency'), [msgid('Daily'), msgid('Every 12 hours'), msgid('Weekly only'), msgid('Monthly')])
    + input('start-time', msgid('Start time (UTC)'), 'time')
    + input('policy-cron', msgid('Schedule expression (UTC)'))
    + select('policy-compress', msgid('Compression'), [msgctxt('theme:v2', 'Zstandard'), msgctxt('theme:v2', 'Gzip')])))}
${group(msgid('Retention'), fields(input('daily-copies', msgid('Daily copies'), 'number', ' min="1" max="3650" step="1"')
    + input('weekly-copies', msgid('Weekly copies'), 'number', ' min="0" max="520" step="1"')
    + input('monthly-copies', msgid('Monthly copies'), 'number', ' min="0" max="240" step="1"'))
    + `<p class="v2-muted">${text(t, msgid('The oldest copy may be removed only after a subsequent run succeeds under the saved policy. No retention is applied here.'))}</p>`)}
${group(msgid('What to include'), `<div class="v2-lifecycle__choices">${choice('include-home', msgid('Home directories'), msgid('Account files with ownership and permissions preserved'))}${choice('include-databases', msgid('Databases'), msgid('A consistent backup for each selected database'))}${choice('include-mail', msgid('Mail'), msgid('Maildirs, forwarders and filters'))}${choice('include-dns', msgid('DNS zones'), msgid('Exported zone records'))}${choice('include-control', msgid('Control database snapshot'), msgid('Desired state and audit recovery data'))}</div>`)}
${group(msgid('Accounts'), accounts)}
${status('configuration-status', msgid('No configuration has been saved from this view. Selecting individual accounts must not silently include newly created accounts.'))}
${actions(button('discard-schedule', msgid('Discard changes')) + button('save-schedule', msgid('Save configuration'), true))}
`, { 'data-backup-section': 'configuration', 'data-backup-saved-policy': true })

  const destinations = lifecycleCard(t, 'backup-destinations', msgid('Destinations'), `
<p>${text(t, msgctxt('theme:v2', 'New and changed destinations stay inactive. Verify the transport before activation; a saved destination does not prove a remote copy.'))}</p>
<div class="v2-lifecycle__choices" data-backup-destination-choices></div>
${table(msgid('Saved destinations'), [msgid('Name'), msgid('Kind'), msgid('Endpoint'), msgid('State'), msgid('Actions')], 'destination-rows', msgid('Not read'))}
<fieldset data-backup-destination-editor disabled><legend>${text(t, msgid('Destination configuration'))}</legend>
${fields(input('destination-name', msgid('Name'))
    + select('destination-kind', msgid('Kind'), [msgid('Local directory'), msgctxt('theme:v2', 'SFTP'), msgctxt('theme:v2', 'S3'), msgctxt('theme:v2', 'Backblaze'), msgctxt('theme:v2', 'Rsync'), msgctxt('theme:v2', 'FTP')])
    + input('destination-endpoint', msgid('Service URL or local directory'))
    + input('destination-prefix', msgid('Directory or object prefix'))
    + input('destination-bucket', msgid('Bucket (object storage)'))
    + input('destination-region', msgid('Region (object storage)'))
    + input('destination-user', msgid('Remote username'))
    + input('destination-retention', msgid('Retention days'), 'number', ' min="1" max="3650" step="1"'))}
${choice('destination-enabled', msgid('Destination enabled in saved policy'))}
</fieldset>
${actions(button('new-destination', msgid('New destination')) + button('save-destination', msgid('Save destination configuration'), true))}
${status('sftp-status', msgid('No remote connection or host-key trust has been verified. Store only the server-side key path; the key must never leave the server.'))}
<a class="v2-btn" href="/whm/backups/destinations?lang=${props.locale}">${text(t, msgctxt('theme:v2', 'Verify and activate destinations'))}</a>
${status('workspace-status', msgid('Saved configuration has not been read.'))}
${actions(button('refresh', msgid('Read saved configuration')))}
`)

  const runs = lifecycleCard(t, 'backup-runs', msgid('Runs'), `
<p>${text(t, msgid('Run history and the saved retention policy have not been read.'))}</p>
${table(msgid('Backup runs, newest first'), [msgid('Started'), msgid('Type'), msgid('Accounts'), msgid('Size'), msgid('Duration'), msgid('Copies'), msgid('Status'), msgid('Actions')], 'snapshot-rows', msgid('No server-wide run history has been loaded. An account archive is not a completed server-wide run.'))}
<div class="v2-lifecycle__actions" data-backup-snapshot-pager></div>
${actions(button('run-now', msgid('Run backup now'), true) + button('restore-run', msgid('Restore from selected run')) + button('run-log', msgid('View run log')))}
<section class="v2-lifecycle__group" data-backup-run-failure aria-labelledby="v2-backup-incomplete"><h3 id="v2-backup-incomplete">${text(t, msgid('Incomplete parts and retry'))}</h3><p>${text(t, msgid('Failed parts, diagnostic output and the account to retry have not been read. A partial run must keep the completed parts and report its actual failure before retry.'))}</p><ul data-backup-run-log hidden></ul>${actions(button('rerun-account', msgid('Back up selected account again')))}</section>
`, { 'data-backup-section': 'runs' })

  const restore = lifecycleCard(t, 'backup-restore', msgid('Restore accounts'), `
<p>${text(t, msgid('Pick a run, an account, then the parts to bring back.'))}</p>
<ol class="v2-lifecycle__steps" aria-label="${text(t, msgid('Restore steps'))}">${[msgid('Run'), msgid('Account'), msgid('Parts and difference')].map((label, index) => `<li data-backup-restore-step="${index + 1}"${index === 0 ? ' aria-current="step"' : ''}><span aria-hidden="true">${index + 1}</span><span>${text(t, label)}</span></li>`).join('')}</ol>
<section class="v2-lifecycle__group" aria-labelledby="v2-backup-run-choice"><h3 id="v2-backup-run-choice">${text(t, msgid('Run'))}</h3><div role="radiogroup" aria-labelledby="v2-backup-run-choice" data-backup-restore-runs>${status('restore-runs-observation', msgid('Run dates, types, sizes and partial-copy state have not been read.'))}</div></section>
${input('restore-search', msgid('Find an account in this run'), 'search', '', props.canRead && props.canManage)}
<section class="v2-lifecycle__group" aria-labelledby="v2-backup-account-choice"><h3 id="v2-backup-account-choice">${text(t, msgid('Account in the selected run'))}</h3><div role="radiogroup" aria-labelledby="v2-backup-account-choice" data-backup-restore-accounts>${status('restore-accounts-observation', msgid('The account list and archive sizes for the selected run have not been read.'))}</div></section>
${group(msgid('Parts to restore for the selected account'), `<div class="v2-lifecycle__choices">${choice('restore-home', msgid('Home files'))}${choice('restore-databases', msgid('Databases'))}${choice('restore-mail', msgid('Mail'))}${choice('restore-dns', msgid('DNS zone'))}</div>`)}
${status('part-availability', msgid('Part availability has not been read. A missing database or other part must be identified before restore; another complete run may be required.'))}
<section class="v2-lifecycle__group" data-backup-restore-difference aria-label="${text(t, msgid('Restore difference'))}"><h3>${text(t, msgid('Difference for the selected account against the selected run'))}</h3>
<dl class="v2-lifecycle__fields">${[['differ', msgid('Files that differ')], ['add', msgid('Only in the archive')], ['keep', msgid('Only on disk')], ['databases', msgid('Databases')]].map(([key, label]) => `<div class="v2-lifecycle__field"><dt>${text(t, label!)}</dt><dd data-backup-difference="${key}">${text(t, msgid('Not read'))}</dd></div>`).join('')}</dl>
${table(msgid('Restore difference'), [msgid('Part'), msgid('Path or record'), msgid('Current'), msgid('Backup'), msgid('Planned action')], 'difference-rows', msgid('No run, account or parts have been compared. No difference or restore result is assumed.'))}
${choice('restore-acknowledge', msgid('I reviewed the proposed restore changes.'))}</section>
${status('restore-status', msgid('No restore has been started. Restore progress and its account audit record have not been read.'))}
${actions(button('restore-back', msgid('Back')) + button('restore-continue', msgid('Continue')) + button('restore-review', msgid('Review differences')) + button('restore-apply', msgid('Restore selected account'), true))}
`, { 'data-backup-section': 'restore' })

  const rules = lifecycleCard(t, 'backup-boundary', msgid('What a restore does'), `<ul class="v2-lifecycle__rules">${[
    msgid('The selected account and parts must be checked before applying a restore.'),
    msgid('A restore shows the difference first and must not delete files missing from the archive.'),
    msgid('Preserve newer data and review ownership and permissions before replacement.'),
    msgid('Databases must be restored through the account’s own database user, without changing its home directory or other accounts.'),
    msgid('The control-database snapshot is for disaster recovery and upgrade rollback; it must never be restored per account.'),
  ].map(label => `<li>${text(t, label)}</li>`).join('')}</ul>`)

  const archive = lifecycleCard(t, 'backup-local', msgctxt('theme:v2', 'Local account archives'), `
<section class="v2-lifecycle__group" data-local-archives-unavailable>
<p>${text(t, msgid('The archive is stored in the local backup directory, limited to 2 GiB, and restored only into that account home.'))}</p>
${lifecycleField(t, 'v2-backup-account', msgid('Account'), `<select id="v2-backup-account" data-backup-account disabled>${(authorizedAccounts ?? []).map(account => `<option value="${escapeHtml(account.username)}">${escapeHtml(account.username)}</option>`).join('')}</select>`)}
${table(msgctxt('theme:v2', 'Local account archives'), [msgid('File'), msgid('Size'), msgid('Actions')], 'files', msgctxt('theme:v2', 'No account archive has been read.'))}
${status('status', msgctxt('theme:v2', 'No account archive has been read.'))}
<p class="v2-muted" role="status">${text(t, msgctxt('theme:v2', 'Local archive actions require the guarded preview and confirmation workflow before they can be used here.'))}</p>
<button type="button" class="v2-btn v2-btn--primary" data-backup-create disabled>${text(t, msgid('Create backup'))}</button>
</section>`)

  return `<div class="v2-lifecycle" data-whm-detail-route="${route}" lang="${props.locale}" dir="${localeDirection(props.locale)}">
${lifecycleHeader(t, msgid('Server backups'), route, msgctxt('theme:v2', 'Configure copies, review actual run evidence and restore only the selected account and parts.'))}
<section class="v2-lifecycle__column" data-approved-whm-backups data-backup-manage="${props.canRead && props.canManage}" data-backup-read-state="${props.canRead ? 'unread' : 'denied'}" data-backup-native="unavailable" aria-label="${text(t, msgid('Server backups'))}">
<p id="whm-backup-layout-unavailable" class="v2-lifecycle__status" role="status">${text(t, props.canRead ? msgid('Server-wide run history, restore differences, scheduling and remote destinations have not been loaded. Their controls stay unavailable; no result or saved configuration is assumed.') : msgid('This workspace requires an authorized root account.'))}</p>
${v2WhmBackupClientTemplates()}${summary}<nav class="v2-lifecycle__tabs" aria-label="${text(t, msgctxt('theme:v2', 'Backup pages'))}"><a href="/whm/backups?lang=${props.locale}"${route === '/whm/backups' ? ' aria-current="page"' : ''}>${text(t, msgid('Settings'))}</a><a href="/whm/backups/restore?lang=${props.locale}"${route === '/whm/backups/restore' ? ' aria-current="page"' : ''}>${text(t, msgid('Restore'))}</a><a href="#v2-lifecycle-backup-runs">${text(t, msgid('Runs'))}</a></nav>
${route === '/whm/backups/restore' ? `<div class="v2-lifecycle__grid"><div class="v2-lifecycle__column">${restore}</div><aside class="v2-lifecycle__column" aria-label="${text(t, msgid('What a restore does'))}">${rules}</aside></div>` : ''}
<div class="v2-lifecycle__grid"><div class="v2-lifecycle__column">${schedule}${runs}${route === '/whm/backups/restore' ? '' : restore}</div><aside class="v2-lifecycle__column" aria-label="${text(t, msgctxt('theme:v2', 'Backup destinations and recovery'))}">${destinations}${route === '/whm/backups/restore' ? '' : rules}${archive}</aside></div>
</section></div>`
}
