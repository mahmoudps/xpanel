import { localeDirection } from '../../../../../i18n.ts'
import { v2Messages } from '../../../messages.ts'
import { escapeHtml } from '../../../html.ts'
import { lifecycleButton, lifecycleCard, lifecycleField, lifecycleHeader, lifecycleStatus, lifecycleTable, text, type LifecycleAccess } from './shared.ts'
import { renderV2TransferCredentials, v2TransferClientTemplates } from './client-templates.ts'

export interface V2TransferPageProps extends LifecycleAccess {
  readonly scope?: 'accounts' | 'server'
  /** Already authorized credential labels, never raw credentials. IDs are only option values. */
  readonly credentials?: readonly { readonly id: string; readonly label: string; readonly kind: 'ssh-key' | 'api-token' }[]
}

/** The persisted transfer controller fills every observation and enables actions after its own admission checks. */
export function renderV2TransferPage(props: V2TransferPageProps): string {
  const t = v2Messages.translator(props.locale)
  const scope = props.scope ?? 'accounts'
  const route = scope === 'server' ? '/whm/transfers/server' : '/whm/transfers'
  const button = (action: string, label: string, primary = false): string => lifecycleButton(t, label, { [`data-transfer-${action}`]: true }, primary)
  const input = (key: string, label: string, type = 'text', extra = ''): string => lifecycleField(t, key, label,
    `<input id="${key}" type="${type}" data-transfer-field="${key}" dir="ltr"${extra} disabled>`)
  const select = (id: string, label: string, hook: string, options = ''): string => lifecycleField(t, id, label,
    `<select id="${id}" data-transfer-${hook} disabled>${options}</select>`)
  const status = (label: string, hook: string): string => lifecycleStatus(t, label, { [`data-transfer-${hook}`]: true })
  const fields = (body: string): string => `<div class="v2-lifecycle__fields">${body}</div>`
  const actions = (body: string): string => `<div class="v2-lifecycle__actions">${body}</div>`
  const source = lifecycleCard(t, 'transfer-source', msgctxt('theme:v2', 'Connect source'), `
${status(msgid('No authenticated source inventory has been read.'), 'source-observation')}
${fields(select('transfer-session', msgid('Saved session'), 'session'))}
<dl class="v2-lifecycle__fields"><div class="v2-lifecycle__field"><dt>${text(t, msgid('Source'))}</dt><dd data-transfer-source>${text(t, msgid('Not read'))}</dd></div><div class="v2-lifecycle__field"><dt>${text(t, msgid('State'))}</dt><dd data-transfer-state>${text(t, msgid('Not read'))}</dd></div></dl>
${actions(button('refresh', msgid('Read saved sessions')) + button('discover', msgid('Connect and discover')) + button('cancel', msgid('Cancel pending session')))}
<h3>${text(t, msgid('Create a source review'))}</h3>
${fields(input('transfer-host', msgid('Source host or HTTPS API URL'), 'text', ' maxlength="1024"')
    + select('transfer-credential', msgid('Stored credential'), 'credential', (props.canRead ? props.credentials ?? [] : []).map(credential => `<option value="${escapeHtml(credential.id)}" data-kind="${credential.kind}">${escapeHtml(credential.label)}</option>`).join(''))
    + input('transfer-port', msgid('SSH port'), 'number', ' min="1" max="65535" value="22"')
    + input('transfer-user', msgid('SSH user'), 'text', ' maxlength="16" value="root"')
    + input('transfer-fingerprint', msgid('Pinned host key or TLS fingerprint'), 'text', ' maxlength="128"'))}
<p class="v2-muted">${text(t, msgid('Choose a named credential already stored on this server. Source passwords, private keys and raw API tokens are never entered or stored here.'))}</p>
${actions(button('create', msgid('Save source review'), true))}
`, { 'data-whm-detail-section': 'transfer-source' })

  const selection = lifecycleCard(t, 'transfer-selection', msgctxt('theme:v2', 'Select accounts'), `
${scope === 'server' ? `<p>${text(t, msgid('Whole-server migration selects every source account and plan. An account with a conflict can be skipped when you resolve it.'))}</p>` : ''}
<div class="v2-lifecycle__choices" data-transfer-accounts></div>
<div class="v2-lifecycle__choices" data-transfer-plans></div>
${status(msgid('No authenticated source inventory has been read.'), 'inventory-note')}
${status(msgctxt('theme:v2', 'Authenticated source inventory has not been read.'), 'identities-observation')}
${lifecycleTable(t, msgctxt('theme:v2', 'Source accounts'), [msgid('Account'), msgid('Primary domain'), msgctxt('theme:v2', 'Source UID'), msgid('Conflict')], { 'data-transfer-inventory-rows': true }, msgid('No observed records are available for this saved session.'))}
${actions(button('select', msgid('Save selection'), true))}
`, { 'data-whm-detail-section': 'transfer-identities' })

  const mapping = lifecycleCard(t, 'transfer-plans', msgctxt('theme:v2', 'Plans and conflicts'), `
${status(msgctxt('theme:v2', 'The source plans and their destination mappings have not been read.'), 'plan-observation')}
${lifecycleTable(t, msgid('Plan mapping'), [msgid('Source plan'), msgid('Plan here'), msgid('Owner'), msgid('Review')], { 'data-transfer-plan-rows': true }, msgid('No observed records are available for this saved session.'))}
${fields(select('transfer-conflict', msgid('Conflict'), 'conflict')
    + select('transfer-resolution', msgid('Resolution'), 'resolution')
    + input('transfer-resolution-target', msgid('Destination name'), 'text', ' maxlength="128"'))}
${actions(button('resolve', msgid('Save resolution')) + button('review', msgid('Build current review'), true))}
<div data-transfer-review-results></div>
`, { 'data-whm-detail-section': 'transfer-plans' })

  const execution = lifecycleCard(t, 'transfer-run', msgctxt('theme:v2', 'Run transfer'), `
<p>${text(t, msgid('Accounts are copied one at a time. The source is only read; a failed account is removed again.'))}</p>
${status(msgctxt('theme:v2', 'No transfer has been started.'), 'execution-note')}
${status(msgctxt('theme:v2', 'No transfer progress has been read.'), 'progress-state')}
${lifecycleTable(t, msgctxt('theme:v2', 'Account transfer progress'), [msgid('Account'), msgid('Home'), msgid('Databases'), msgid('Mail'), msgid('DNS'), msgid('Apply')], { 'data-transfer-progress-rows': true }, msgctxt('theme:v2', 'No transfer progress has been read.'))}
${actions(button('run', msgid('Run reviewed transfer'), true) + button('stop', msgid('Stop after the current account')))}
`)

  const importDetails = (key: string, title: string): string => `<details data-transfer-import-part="${key}"><summary>${text(t, title)}</summary>${lifecycleTable(t, title, [msgid('Source'), msgid('Proposed'), msgid('Detail'), msgid('State')], { [`data-transfer-import-${key}`]: true }, msgid('No parsed archive review was returned.'))}</details>`
  const archive = lifecycleCard(t, 'transfer-import', msgid('Import a cPanel backup'), `
${status(msgid('No parsed archive review was returned.'), 'import-observation')}
${fields(input('transfer-archive', msgid('Backup file'), 'file', ' accept=".tar.gz,.tgz"')
    + input('transfer-archive-target', msgid('Destination username (optional)'), 'text', ' maxlength="16"'))}
${status(msgid('The import limit has not been read.'), 'archive-limit')}
${actions(button('inspect', msgid('Upload and read')))}
<h3>${text(t, msgid('Or fetch it from the cPanel server over SSH'))}</h3>
${fields(input('transfer-cpanel-host', 'cPanel host', 'text', ' maxlength="253"')
    + input('transfer-cpanel-port', msgid('SSH port'), 'number', ' min="1" max="65535" value="22"')
    + input('transfer-cpanel-user', 'cPanel username', 'text', ' maxlength="16"')
    + input('transfer-cpanel-fingerprint', msgid('Pinned host key'), 'text', ' maxlength="128"'))}
<p class="v2-muted">${text(t, msgid('The cPanel server runs pkgacct as root with this server\'s transfer key; add its public key there first.'))} <bdi dir="ltr" data-transfer-ssh-key-value></bdi></p>
${actions(button('ssh-key', msgid('Show transfer key')) + button('fetch', msgid('Fetch over SSH')))}
${fields(select('transfer-import', msgid('Archive'), 'import') + select('transfer-import-plan', msgid('Plan here'), 'import-plan'))}
<div data-transfer-archive-review></div>
${importDetails('domains', msgid('Domains'))}${importDetails('home', msgid('Home files'))}${importDetails('databases', msgid('Databases and users'))}${importDetails('mail', msgid('Mailboxes'))}${importDetails('dns', msgid('DNS zones'))}
${lifecycleTable(t, msgid('Not imported or changed'), [msgid('State'), msgid('Detail'), msgid('Path')], { 'data-transfer-import-warnings': true }, msgid('No parsed archive review was returned.'))}
<p>${text(t, msgid('The import builds a new UID, slice and vhost, then restores files, SQL, zones and mail into them. Zones get this server\'s name servers. It runs as its own job.'))}</p>
${actions(button('import-discard', msgid('Discard archive')) + button('import-run', msgid('Import account'), true))}
`, { 'data-whm-detail-section': 'transfer-import' })

  const note = lifecycleCard(t, 'transfer-boundary', msgctxt('theme:v2', 'Transfer review'), `<p>${text(t, msgid('Resume a saved review, inspect actual source inventory and resolve conflicts. Connection and execution results are accepted only from the trusted server adapter.'))}</p><p>${text(t, msgctxt('theme:v2', 'No destination account is created until the current review is confirmed. Source identity, resource limits and proposed changes must be checked before running.'))}</p>`)
  return `<div class="v2-lifecycle" data-whm-detail-route="${route}" lang="${props.locale}" dir="${localeDirection(props.locale)}">
${lifecycleHeader(t, scope === 'server' ? msgid('Server migration') : msgid('Transfer tool'), route, msgctxt('theme:v2', 'Move accounts from a verified source or inspect a cPanel archive before importing.'))}
${scope === 'server' ? renderV2TransferCredentials(t, props.canRead && props.canManage) : ''}
<section class="v2-lifecycle__column" data-transfer-workspace data-transfer-manage="${props.canRead && props.canManage}" data-transfer-scope="${scope}"${scope === 'server' ? ' data-transfer-credentials="read"' : ''} aria-label="${text(t, msgid('Saved transfer sessions and archive review'))}">
<div class="v2-lifecycle__grid"><div class="v2-lifecycle__column">${source}${selection}${mapping}${execution}</div><aside class="v2-lifecycle__column" aria-label="${text(t, msgctxt('theme:v2', 'Transfer review'))}">${note}</aside></div>
${scope === 'server' ? `<div hidden>${archive}</div>` : archive}
<p class="v2-lifecycle__status" role="status" data-transfer-status data-state="unread">${text(t, props.canRead ? msgid('Saved transfer state has not been read.') : msgid('Transfer review is unavailable here. Nothing was read or changed.'))}</p>
${v2TransferClientTemplates(t)}
</section></div>`
}
